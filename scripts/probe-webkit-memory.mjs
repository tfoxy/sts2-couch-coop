#!/usr/bin/env node
// Linux WebKit attribution oracle. Its categories/layers are useful to compare local mechanisms;
// they do not establish iPhone WebContent memory or jetsam behaviour.
import { mkdirSync, writeFileSync, createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import playwright from "../frontend/node_modules/playwright/index.js";
import { WEBKIT_MEMORY_SCHEMA, WebKitInspector, isMeasuredMemoryCapture, maxMemoryCategories, sampleWebKitTreeRss, summarizeMemoryWindow } from "./lib/webkit-memory-probe.mjs";
import { LINUX_PROCESS_MEMORY_SCHEMA, LinuxProcessMemorySampler, legacyRssSummary } from "./lib/linux-process-memory.mjs";
import { WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, WebKitHeapDiagnostics } from "./lib/webkit-heap-diagnostics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { webkit } = playwright;
const SELFTEST_PAGE = pathToFileURL(resolve(HERE, "fixtures/webkit-memory-selftest.html")).href;
const HELP = `Usage: node scripts/probe-webkit-memory.mjs [--self-test | --url URL | --journey] [options]

  --self-test              Allocate bounded canvas + JavaScript memory and require Memory updates.
  --url URL                Capture URL for --duration-ms (default 6000).
  --journey                Read JSON lines: {"command":"begin","label":"..."},
                           {"command":"snapshot","label":"..."}, {"command":"stop"}.
  --out DIR                Artifact directory (default .sts2/research/webkit-memory-<UTC>).
  --width N --height N --dpr N   Viewport defaults: 844x390 DPR 3.
  --timeout-ms N           Protocol and first-Memory-update timeout (default 10000).
  --process-memory MODE    Linux process evidence: off, rollup, or smaps (default off).
  --gc-settle-ms N         Fixed post-GC settle for journey gc commands (default 10000).
  --heap-timeout-ms N      Heap snapshot timeout (default 120000).

Journey mode additionally accepts {"command":"gc","label":"..."} and
{"command":"heap-snapshot","label":"..."}. Outputs raw.ndjson, summary.json, stderr.log,
per-mark PNGs, and requested local diagnostic artifacts. A missing lifecycle, zero-only Memory
update, target loss, or requested process evidence failure is UNMEASURED (non-zero exit).
`;

function args(argv) {
  const value = (name, fallback = null) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const journey = argv.includes("--journey");
  const modes = [argv.includes("--self-test"), journey || Boolean(value("--url"))].filter(Boolean).length;
  if (modes !== 1) throw new Error("choose exactly one of --self-test, --url URL, or --journey");
  const number = (name, fallback) => { const n = Number(value(name, fallback)); if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be positive`); return n; };
  const processMemory = value("--process-memory", "off");
  if (!["off", "rollup", "smaps"].includes(processMemory)) {
    throw new Error("--process-memory must be off, rollup, or smaps");
  }
  return {
    selfTest: argv.includes("--self-test"), url: value("--url"), journey,
    out: value("--out"), width: number("--width", 844), height: number("--height", 390),
    dpr: number("--dpr", 3), timeoutMs: number("--timeout-ms", 10_000), durationMs: number("--duration-ms", 6_000),
    processMemory, gcSettleMs: number("--gc-settle-ms", 10_000),
    heapTimeoutMs: number("--heap-timeout-ms", 120_000)
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const dataUrlToBuffer = value => Buffer.from(String(value).replace(/^data:image\/png;base64,/, ""), "base64");
const safeLabel = value => String(value).replace(/[^a-z0-9_-]+/gi, "-");

class Capture {
  constructor(inspector, browser, options, outDir) {
    this.inspector = inspector; this.browser = browser; this.options = options; this.outDir = outDir;
    this.samples = []; this.marks = []; this.protocolErrors = []; this.stderr = ""; this.active = null;
    this.lifecycle = { started: false, completed: false }; this.stopped = false; this.expectedTeardown = false;
    this.diagnosticRecords = [];
    this.processMemorySampler = options.processMemory === "off" ? null : new LinuxProcessMemorySampler({
      rootPid: browser.pid, mode: options.processMemory, outDir
    });
    // Construction is intentionally lazy: ordinary journeys never send Heap.enable, Heap.gc, or Heap.snapshot.
    this.heapDiagnostics = new WebKitHeapDiagnostics({ inspector, outDir, timeoutMs: options.heapTimeoutMs });
    this.raw = createWriteStream(resolve(outDir, "raw.ndjson"));
    this.record("meta", {
      schema: WEBKIT_MEMORY_SCHEMA,
      diagnostics: {
        processMemorySchema: LINUX_PROCESS_MEMORY_SCHEMA, processMemoryMode: options.processMemory,
        heapSchema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA
      },
      viewport: { width: options.width, height: options.height, dpr: options.dpr }
    });
    inspector.on("stderr", text => { this.stderr += text; });
    inspector.on("fatal", error => { if (!this.expectedTeardown) this.protocolErrors.push(error.message); });
    inspector.on("target-event", event => this.onTargetEvent(event));
  }
  record(type, value) { this.raw.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...value })}\n`); }
  onTargetEvent(event) {
    if (event.method === "Memory.trackingStart") {
      this.lifecycle.started = true; this.record("lifecycle", { event: "trackingStart", params: event.params }); return;
    }
    if (event.method === "Memory.trackingComplete") {
      this.lifecycle.completed = true; this.record("lifecycle", { event: "trackingComplete", params: event.params }); return;
    }
    if (event.method !== "Memory.trackingUpdate") return;
    const entries = event.params?.event?.categories ?? event.params?.categories ?? [];
    const categories = Array.isArray(entries)
      ? Object.fromEntries(entries.map(entry => [entry.type, entry.size]))
      : entries;
    const sample = { at: new Date().toISOString(), categories };
    this.samples.push(sample); this.record("memory", sample);
  }
  async start() {
    await this.inspector.bindActiveTarget(this.options.timeoutMs);
    await this.inspector.targetCommand("Memory.enable");
    await this.inspector.targetCommand("Memory.startTracking");
    this.record("lifecycle", { event: "startTracking" });
    if (!this.samples.length) {
      await new Promise((resolve, reject) => {
        const onEvent = event => {
          if (event.method !== "Memory.trackingUpdate") return;
          clearTimeout(timer); this.inspector.off("target-event", onEvent); resolve();
        };
        const timer = setTimeout(() => {
          this.inspector.off("target-event", onEvent);
          reject(new Error(`first Memory update timed out after ${this.options.timeoutMs}ms`));
        }, this.options.timeoutMs);
        this.inspector.on("target-event", onEvent);
      });
    }
  }
  async mark(label) {
    if (this.inspector.closed) throw new Error("target was lost before snapshot");
    if (!this.active) throw new Error("snapshot requires a preceding begin command");
    const window = this.active;
    let processMemory = null;
    let rss;
    if (this.processMemorySampler) {
      try {
        processMemory = this.processMemorySampler.capture({
          label: `${String(this.marks.length).padStart(2, "0")}-${safeLabel(label)}`
        });
      } catch (error) {
        this.record("linux-process-memory-error", {
          schema: LINUX_PROCESS_MEMORY_SCHEMA, label, message: error.message
        });
        throw error;
      }
      this.record("linux-process-memory", { label, evidence: processMemory });
      rss = legacyRssSummary(processMemory);
    } else {
      rss = sampleWebKitTreeRss(this.browser.pid);
      if (!rss) throw new Error("WebKit process-tree identity unavailable");
    }
    let layers = null;
    try {
      await this.inspector.targetCommand("LayerTree.enable");
      const document = await this.inspector.targetCommand("DOM.getDocument");
      layers = await this.inspector.targetCommand("LayerTree.layersForNode", { nodeId: document.root?.nodeId });
    } catch (error) { this.protocolErrors.push(`LayerTree: ${error.message}`); }
    let page = null;
    try {
      const result = await this.inspector.targetCommand("Runtime.evaluate", {
        expression: `(() => {
          const state = globalThis.__couchCoopBrowserState;
          let stateKeys = null;
          try { const value = typeof state === "function" ? state() : null; stateKeys = value && typeof value === "object" ? Object.keys(value).sort() : null; } catch (_) {}
          const stage = document.querySelector("[data-stage], #stage, .mirror-stage") || document.documentElement;
          const style = getComputedStyle(stage);
          return JSON.stringify({ url: location.href, title: document.title, dpr: window.devicePixelRatio,
            stageFitRequested: new URL(location.href).searchParams.get("stageFit"), stageTransform: style.transform,
            mirrorLayoutScale: style.getPropertyValue("--mirror-layout-scale").trim() || null,
            readyState: document.readyState, appSeams: { couchCoopBrowserState: typeof state === "function", browserStateKeys: stateKeys,
              mirrorRoot: Boolean(document.querySelector("[data-couchcoop-mirror], #mirror-root")) } });
        })()`,
        returnByValue: true
      });
      page = JSON.parse(result.result?.value ?? "null");
    } catch (error) { this.protocolErrors.push(`page diagnostics: ${error.message}`); }
    let screenshot = null;
    try {
      let image;
      try {
        image = await this.inspector.outer("Playwright.takePageScreenshot", {
          pageProxyId: this.inspector.pageProxyId, x: 0, y: 0, width: this.options.width, height: this.options.height,
          coordinateSystem: "Viewport", omitDeviceScaleFactor: false
        });
      } catch (error) {
        // Current headless WPE returns a generic failure from the page-proxy screenshot endpoint.
        // Retain that attempt in raw evidence, then use the target-local equivalent so each mark still
        // has pixels rather than claiming the failed endpoint produced a screenshot.
        this.record("screenshot-fallback", { reason: error.message });
        image = await this.inspector.targetCommand("Page.snapshotRect", {
          x: 0, y: 0, width: this.options.width, height: this.options.height,
          coordinateSystem: "Viewport", omitDeviceScaleFactor: false
        });
      }
      screenshot = resolve(this.outDir, `${String(this.marks.length).padStart(2, "0")}-${safeLabel(label)}.png`);
      writeFileSync(screenshot, dataUrlToBuffer(image.dataURL ?? image.data));
    } catch (error) { this.protocolErrors.push(`screenshot: ${error.message}`); }
    const layerList = Array.isArray(layers?.layers) ? layers.layers : null;
    const layerSummary = layerList ? {
      count: layerList.length,
      memoryBytes: layerList.reduce((total, layer) => total + (Number.isFinite(layer.memory) ? layer.memory : 0), 0)
    } : null;
    const mark = { label, at: new Date().toISOString(), memory: {
      ...summarizeMemoryWindow(this.samples, window.sampleStart)
    }, rss, processMemory, layerSummary, layers, page, screenshot };
    this.active = null;
    this.marks.push(mark); this.record("mark", mark); return mark;
  }
  async gc(label) {
    if (!this.active) throw new Error("gc requires a preceding begin command for its pre-GC window");
    const preIndex = this.marks.length;
    const pre = await this.mark(`${label}-pre-gc`);
    this.active = { label: `${label}-post-gc`, sampleStart: this.samples.length };
    const result = await this.heapDiagnostics.requestGc({ timeoutMs: this.options.timeoutMs });
    if (!result.supported) {
      this.active = null;
      const record = {
        schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, operation: "gc", label, supported: false,
        capability: result.capability, preMark: { index: preIndex, label: pre.label }
      };
      this.diagnosticRecords.push(record); this.record("webkit-heap-diagnostics", record);
      return record;
    }
    await wait(this.options.gcSettleMs);
    const postIndex = this.marks.length;
    const post = await this.mark(`${label}-post-gc`);
    const record = {
      schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, operation: "gc", label, supported: true,
      settleMs: this.options.gcSettleMs, gc: result,
      preMark: { index: preIndex, label: pre.label }, postMark: { index: postIndex, label: post.label }
    };
    this.diagnosticRecords.push(record); this.record("webkit-heap-diagnostics", record);
    return record;
  }
  async heapSnapshot(label) {
    const result = await this.heapDiagnostics.takeSnapshot({
      label, index: this.diagnosticRecords.filter(record => record.operation === "heap-snapshot").length,
      timeoutMs: this.options.heapTimeoutMs
    });
    const record = {
      schema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, operation: "heap-snapshot", label,
      supported: result.supported, ...(result.supported ? { snapshot: result } : { capability: result.capability })
    };
    this.diagnosticRecords.push(record); this.record("webkit-heap-diagnostics", record);
    return record;
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { await this.inspector.targetCommand("Memory.stopTracking"); this.record("lifecycle", { event: "stopTracking" }); }
    catch (error) { this.protocolErrors.push(`stopTracking: ${error.message}`); }
    this.raw.end();
    await finished(this.raw);
  }
  summary() {
    return {
      schema: WEBKIT_MEMORY_SCHEMA,
      measured: isMeasuredMemoryCapture({ inspectorClosed: this.inspector.closed && !this.expectedTeardown, lifecycle: this.lifecycle, samples: this.samples }),
      browserPid: this.browser.pid, viewport: { width: this.options.width, height: this.options.height, dpr: this.options.dpr },
      diagnostics: {
        processMemorySchema: LINUX_PROCESS_MEMORY_SCHEMA, processMemoryMode: this.options.processMemory,
        heapSchema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, heap: this.diagnosticRecords
      },
      samples: this.samples, categoryPeakBytes: maxMemoryCategories(this.samples), marks: this.marks,
      lifecycle: this.lifecycle, protocolErrors: this.protocolErrors, inspectorErrors: this.inspector.errors
    };
  }
}

async function launch(options) {
  const executable = webkit.executablePath();
  let child; let startupStderr = "";
  try {
    child = spawn(executable, ["--inspector-pipe", "--headless", "--no-startup-window"], {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], detached: process.platform !== "win32"
    });
    child.stderr.on("data", chunk => { startupStderr += chunk.toString("utf8"); });
    const inspector = new WebKitInspector({ stdin: child.stdio[3], stdout: child.stdio[4], stderr: child.stderr, onClose: listener => child.once("exit", listener) });
    await inspector.bootstrap({ width: options.width, height: options.height, deviceScaleFactor: options.dpr, timeoutMs: options.timeoutMs });
    return { child, inspector };
  } catch (error) {
    await terminateProcessGroup(child).catch(() => {});
    error.webkitStderr = startupStderr;
    throw error;
  }
}

async function runFixed(capture, options) {
  const url = options.selfTest ? SELFTEST_PAGE : options.url;
  await capture.inspector.navigate(url, options.timeoutMs);
  if (options.selfTest) {
    const deadline = Date.now() + options.timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      const result = await capture.inspector.targetCommand("Runtime.evaluate", { expression: "window.__webkitMemoryProbeReady === true", returnByValue: true });
      if (result.result?.value === true) { ready = true; break; }
      await wait(25);
    }
    if (!ready) throw new Error(`self-test ready flag timed out after ${options.timeoutMs}ms`);
  }
  await waitForDocumentReady(capture.inspector, options.timeoutMs);
  await capture.start();
  await wait(options.durationMs);
  capture.active = { label: options.selfTest ? "self-test" : "fixed", sampleStart: 0 };
  await capture.mark(options.selfTest ? "self-test" : "final");
}

async function waitForDocumentReady(inspector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await inspector.targetCommand("Runtime.evaluate", { expression: "document.readyState === 'complete'", returnByValue: true }, timeoutMs);
    if (result.result?.value === true) return;
    await wait(25);
  }
  throw new Error(`document readiness timed out after ${timeoutMs}ms`);
}

async function terminateProcessGroup(child) {
  if (!child) return { rootPid: null, orphanedPids: [] };
  const rootPid = child.pid;
  const groupMembers = () => {
    if (process.platform === "win32") return existsSync(`/proc/${rootPid}`) ? [rootPid] : [];
    let groupId = rootPid;
    try {
      const stat = readFileSync(`/proc/${rootPid}/stat`, "utf8");
      groupId = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    } catch { /* the detached descendants retain the root process-group id */ }
    const members = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === groupId) members.push(Number(entry));
      } catch { /* process raced */ }
    }
    return members;
  };
  const alive = () => groupMembers();
  const signal = value => {
    try { process.kill(process.platform === "win32" ? rootPid : -rootPid, value); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  if (alive().length) signal("SIGTERM");
  const deadline = Date.now() + 2_000;
  while (alive().length && Date.now() < deadline) await wait(25);
  if (alive().length) {
    signal("SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (alive().length && Date.now() < killDeadline) await wait(25);
  }
  return { rootPid, orphanedPids: alive() };
}

async function runJourney(capture) {
  let tail = "";
  for await (const chunk of process.stdin) {
    tail += chunk;
    const lines = tail.split(/\r?\n/); tail = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      if (request.command === "begin") {
        capture.active = { label: request.label ?? "window", sampleStart: capture.samples.length };
        capture.record("begin", { label: capture.active.label });
        process.stdout.write(`${JSON.stringify({ ok: true, command: "begin" })}\n`);
      } else if (request.command === "snapshot") {
        const mark = await capture.mark(request.label ?? capture.active?.label ?? "snapshot");
        process.stdout.write(`${JSON.stringify({ ok: true, command: "snapshot", mark })}\n`);
      } else if (request.command === "gc") {
        const diagnostic = await capture.gc(request.label ?? "gc");
        process.stdout.write(`${JSON.stringify({ ok: true, command: "gc", diagnostic })}\n`);
      } else if (request.command === "heap-snapshot") {
        const diagnostic = await capture.heapSnapshot(request.label ?? "heap-snapshot");
        process.stdout.write(`${JSON.stringify({ ok: true, command: "heap-snapshot", diagnostic })}\n`);
      } else if (request.command === "stop") return;
      else throw new Error(`unknown journey command ${JSON.stringify(request.command)}`);
    }
  }
  if (tail.trim()) throw new Error("journey input ended with a partial JSON line");
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  const outDir = resolve(options.out ?? `.sts2/research/webkit-memory-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  let launched; let capture; let failure = null; let cleanup;
  try {
    launched = await launch(options);
    capture = new Capture(launched.inspector, launched.child, options, outDir);
    if (options.journey) {
      if (options.url) {
        await capture.inspector.navigate(options.url, options.timeoutMs);
        await waitForDocumentReady(capture.inspector, options.timeoutMs);
      }
      await capture.start();
      await runJourney(capture);
    } else await runFixed(capture, options);
  } catch (error) {
    failure = error;
  } finally {
    if (capture) {
      await capture.stop().catch(error => { capture.protocolErrors.push(`stop: ${error.message}`); failure ??= error; });
      capture.expectedTeardown = true;
      if (!capture.inspector.closed) await capture.inspector.close().catch(error => capture.protocolErrors.push(`close: ${error.message}`));
    }
    cleanup = await terminateProcessGroup(launched?.child).catch(error => ({ rootPid: launched?.child?.pid ?? null, orphanedPids: [launched?.child?.pid].filter(Boolean), error: error.message }));
    if (capture) writeFileSync(resolve(outDir, "stderr.log"), capture.stderr);
    const summary = capture ? capture.summary() : {
      schema: WEBKIT_MEMORY_SCHEMA, measured: false, browserPid: launched?.child?.pid ?? null,
      viewport: { width: options.width, height: options.height, dpr: options.dpr },
      diagnostics: {
        processMemorySchema: LINUX_PROCESS_MEMORY_SCHEMA, processMemoryMode: options.processMemory,
        heapSchema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, heap: []
      },
      samples: [], categoryPeakBytes: {}, marks: [], lifecycle: { started: false, completed: false }, protocolErrors: [], inspectorErrors: []
    };
    summary.cleanup = cleanup;
    if (failure) { summary.measured = false; summary.failure = failure.message; }
    writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    if (!capture) {
      writeFileSync(resolve(outDir, "raw.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), type: "meta", schema: WEBKIT_MEMORY_SCHEMA, outcome: "launch-failed" })}\n`);
      writeFileSync(resolve(outDir, "stderr.log"), failure?.webkitStderr ?? "");
    }
    if (cleanup.orphanedPids.length) failure ??= new Error(`WebKit cleanup left process(es): ${cleanup.orphanedPids.join(", ")}`);
    if (!failure && !summary.measured) failure = new Error("UNMEASURED: missing lifecycle, target, or nonzero Memory updates");
    if (!failure) process.stdout.write(`${JSON.stringify({ measured: true, outDir, samples: summary.samples.length, categoryPeakBytes: summary.categoryPeakBytes, cleanup })}\n`);
  }
  if (failure) throw failure;
}

main().catch(error => { console.error(`[webkit-memory] ${error.stack ?? error.message}`); process.exitCode = 1; });
