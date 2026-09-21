#!/usr/bin/env node
// Linux WebKit attribution oracle. Its categories/layers are useful to compare local mechanisms;
// they do not establish iPhone WebContent memory or jetsam behaviour.
import { mkdirSync, writeFileSync, createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import playwright from "../frontend/node_modules/playwright/index.js";
import { WEBKIT_MEMORY_SCHEMA, WebKitInspector, classifyTargetTransition, isMeasuredMemoryCapture, maxMemoryCategories, sampleWebKitTreeRss, summarizeMemoryWindow } from "./lib/webkit-memory-probe.mjs";
import { LINUX_PROCESS_MEMORY_SCHEMA, LinuxProcessMemorySampler, legacyRssSummary, processIdentityRoster, sameProcessIdentityRoster } from "./lib/linux-process-memory.mjs";
import { WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, WebKitHeapDiagnostics } from "./lib/webkit-heap-diagnostics.mjs";
import {
  LINUX_CGROUP_MEMORY_SCHEMA, launchWebKitScope, stopOwnedScope, summarizeCgroupSamples
} from "./lib/linux-cgroup-memory.mjs";
import {
  WEBKIT_DOM_ATTRIBUTION_SCHEMA, SerializedDomLayerCapture, bootstrapScript, loadInitAssignments, pageDiagnostics
} from "./lib/webkit-dom-attribution.mjs";
import { WEBKIT_NETWORK_EVIDENCE_SCHEMA, WebKitNetworkEvidence } from "./lib/webkit-network-evidence.mjs";

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
  --sample-interval-ms N   Continuous PSS/cgroup/DOM/LayerTree interval (default 2000).
  --settled-window-ms N    Tail window summarized separately (default 10000).
  --cgroup                 Launch WebKit alone in a fresh transient systemd user scope.
  --cgroup-memory-max-bytes N  Optional survival-leg memory.max; graded legs omit it (max).
  --cgroup-swap-max-bytes N    Scope memory.swap.max (default 0).
  --init-json JSON         Pre-navigation object of global assignments.
  --init-json-file PATH    File containing the same JSON object; exact bytes are hashed.
  --gc-settle-ms N         Fixed post-GC settle for journey gc commands (default 10000).
  --heap-timeout-ms N      Heap snapshot timeout (default 120000).

Journey mode additionally accepts {"command":"gc","label":"..."} and
{"command":"heap-snapshot","label":"..."}, {"command":"evaluate","expression":"..."},
{"command":"mouse",...Input.dispatchMouseEvent params}, and {"command":"tap","x":N,"y":N}.
After startup it emits a {"ok":true,"command":"ready"} row. Outputs raw.ndjson, summary.json, stderr.log,
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
  const optionalNonnegative = name => {
    const raw = value(name);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a nonnegative safe integer`);
    return parsed;
  };
  const cgroup = argv.includes("--cgroup");
  const cgroupMemoryMaxBytes = optionalNonnegative("--cgroup-memory-max-bytes");
  const cgroupSwapMaxBytes = optionalNonnegative("--cgroup-swap-max-bytes") ?? 0;
  if (cgroupMemoryMaxBytes === 0) throw new Error("--cgroup-memory-max-bytes must be positive when supplied");
  if (!cgroup && (cgroupMemoryMaxBytes !== null || argv.includes("--cgroup-swap-max-bytes"))) throw new Error("cgroup limits require --cgroup");
  return {
    selfTest: argv.includes("--self-test"), url: value("--url"), journey,
    out: value("--out"), width: number("--width", 844), height: number("--height", 390),
    dpr: number("--dpr", 3), timeoutMs: number("--timeout-ms", 10_000), durationMs: number("--duration-ms", 6_000),
    processMemory, gcSettleMs: number("--gc-settle-ms", 10_000),
    heapTimeoutMs: number("--heap-timeout-ms", 120_000),
    sampleIntervalMs: number("--sample-interval-ms", 2_000),
    settledWindowMs: number("--settled-window-ms", 10_000),
    cgroup, cgroupMemoryMaxBytes, cgroupSwapMaxBytes,
    init: loadInitAssignments({ inline: value("--init-json"), file: value("--init-json-file") })
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const dataUrlToBuffer = value => Buffer.from(String(value).replace(/^data:image\/png;base64,/, ""), "base64");
const safeLabel = value => String(value).replace(/[^a-z0-9_-]+/gi, "-");
const hashFile = path => createHash("sha256").update(readFileSync(path)).digest("hex");

const measuredValue = (sample, name) => sample.metrics?.[name]?.status === "measured" ? sample.metrics[name].value : null;
function summarizeContinuousWindow(samples, start = 0) {
  const window = samples.slice(start);
  const values = name => window.map(sample => measuredValue(sample, name)).filter(Boolean);
  const cgroups = values("cgroup");
  const processes = values("processMemory");
  const doms = values("dom");
  const pages = values("page");
  return {
    sampleRange: [start, samples.length], sampleCount: window.length,
    cgroupPeakBytes: cgroups.length ? cgroups.reduce((max, value) => Math.max(max, value.peakBytes ?? 0, value.currentBytes ?? 0), 0) : null,
    cgroupCurrentPeakBytes: cgroups.length ? cgroups.reduce((max, value) => Math.max(max, value.currentBytes ?? 0), 0) : null,
    swapPeakBytes: cgroups.length ? cgroups.reduce((max, value) => Math.max(max, value.swapCurrentBytes ?? 0), 0) : null,
    pssPeakBytes: processes.length ? processes.reduce((max, value) => Math.max(max, value.totals?.pssBytes ?? 0), 0) : null,
    layerPeakBytes: doms.length ? doms.reduce((max, value) => Math.max(max, (value.layers?.layers ?? []).reduce((total, layer) => total + (Number(layer.memory) || 0), 0)), 0) : null,
    canvasPeak: pages.reduce((max, value) => Math.max(max, value.canvases?.length ?? 0), 0),
    canvasBackingPixelPeak: pages.reduce((max, value) => Math.max(max,
      (value.canvases ?? []).reduce((total, canvas) => total + (canvas.backing?.width ?? 0) * (canvas.backing?.height ?? 0), 0)), 0),
    particleMarkerPeak: pages.reduce((max, value) => Math.max(max, value.markerCounts?.particle ?? 0), 0),
    shaderMarkerPeak: pages.reduce((max, value) => Math.max(max, value.markerCounts?.shader ?? 0), 0),
    failureCount: window.reduce((total, sample) => total + sample.failures.length, 0),
    gapCount: window.filter(sample => sample.gap?.missedIntervals > 0).length
  };
}

class Capture {
  constructor(inspector, browser, options, outDir) {
    this.inspector = inspector; this.browser = browser; this.options = options; this.outDir = outDir;
    this.samples = []; this.marks = []; this.protocolErrors = []; this.stderr = ""; this.active = null;
    this.lifecycle = { started: false, completed: false }; this.stopped = false; this.expectedTeardown = false;
    this.diagnosticRecords = []; this.continuousSamples = []; this.continuousFailures = []; this.receipts = [];
    this.finalCgroupSample = null; this.finalCgroupError = null;
    this.networkCutoff = { status: "pending", error: null };
    this.continuousStop = false; this.continuousPromise = null; this.navigationStartedAt = null;
    this.bootstrapTargetId = inspector.targetId; this.activeTargetId = inspector.targetId;
    this.targetHistory = [{ at: new Date().toISOString(), targetId: inspector.targetId, event: "bootstrap" }];
    this.targetReplaced = false; this.initialNavigationTransition = null; this.navigationPending = false;
    this.pinnedProcessRoster = null; this.processIdentityFailures = [];
    this.targetRebind = Promise.resolve();
    this.domLayerCapture = new SerializedDomLayerCapture(inspector, options.timeoutMs);
    this.processMemorySampler = options.processMemory === "off" ? null : new LinuxProcessMemorySampler({
      rootPid: browser.rootPid ?? browser.pid, mode: options.processMemory, outDir, pinIdentities: false
    });
    this.cgroupSampler = browser.cgroupSampler ?? null;
    // Construction is intentionally lazy: ordinary journeys never send Heap.enable, Heap.gc, or Heap.snapshot.
    this.heapDiagnostics = new WebKitHeapDiagnostics({ inspector, outDir, timeoutMs: options.heapTimeoutMs });
    this.raw = createWriteStream(resolve(outDir, "raw.ndjson"));
    this.rawFinished = false;
    this.network = new WebKitNetworkEvidence({ record: (type, value) => this.record(type, value) });
    this.record("meta", {
      schema: WEBKIT_MEMORY_SCHEMA,
      diagnostics: {
        processMemorySchema: LINUX_PROCESS_MEMORY_SCHEMA, processMemoryMode: options.processMemory,
        heapSchema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA,
        cgroupMemorySchema: LINUX_CGROUP_MEMORY_SCHEMA, cgroupRequested: options.cgroup,
        domAttributionSchema: WEBKIT_DOM_ATTRIBUTION_SCHEMA,
        networkEvidenceSchema: WEBKIT_NETWORK_EVIDENCE_SCHEMA
      },
      viewport: { width: options.width, height: options.height, dpr: options.dpr },
      init: { sourceKind: options.init.sourceKind, sourcePath: options.init.sourcePath, sha256: options.init.sha256, bytes: options.init.bytes }
    });
    const sessionReceipt = {
      kind: "browser-session", processPid: browser.browserPid ?? browser.pid, launcherPid: browser.rootPid ?? browser.pid,
      contextId: inspector.contextId, pageProxyId: inspector.pageProxyId, bootstrapTargetId: inspector.targetId,
      profile: "fresh-playwright-context"
    };
    this.receipts.push(sessionReceipt); this.record("receipt", sessionReceipt);
    inspector.on("stderr", text => { this.stderr += text; });
    inspector.on("fatal", error => { if (!this.expectedTeardown) this.protocolErrors.push(error.message); });
    inspector.on("target-event", event => this.onTargetEvent(event));
    inspector.on("target", info => this.onTargetIdentity(info));
  }
  record(type, value) { this.raw.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...value })}\n`); }
  onTargetEvent(event) {
    if (this.network.accept(event)) return;
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
    const sample = { at: new Date().toISOString(), targetId: event.targetId ?? this.inspector.targetId, categories };
    this.samples.push(sample); this.record("memory", sample);
  }
  onTargetIdentity(info) {
    const targetId = info?.targetId;
    if (!targetId || targetId === this.activeTargetId) return;
    const row = { at: new Date().toISOString(), targetId, previousTargetId: this.activeTargetId, event: "target-change", navigationPending: this.navigationPending };
    row.classification = classifyTargetTransition({ navigationPending: this.navigationPending, hasInitialNavigationTransition: this.initialNavigationTransition !== null });
    if (row.classification === "initial-navigation") {
      this.initialNavigationTransition = row;
    } else {
      this.targetReplaced = true;
      this.protocolErrors.push(`unexpected target replacement ${this.activeTargetId} -> ${targetId}`);
    }
    this.activeTargetId = targetId; this.targetHistory.push(row); this.record("target-identity", row);
    if (this.lifecycle.started) this.targetRebind = this.targetRebind.then(async () => {
      if (this.inspector.targetId !== targetId) return;
      await this.inspector.bindActiveTarget(this.options.timeoutMs);
      await this.network.enable(this.inspector, this.options.timeoutMs);
      await this.inspector.targetCommand("Memory.enable", {}, this.options.timeoutMs);
      await this.inspector.targetCommand("Memory.startTracking", {}, this.options.timeoutMs);
      this.record("lifecycle", { event: "rebindTracking", targetId });
    }).catch(error => {
      this.protocolErrors.push(`target rebind: ${error.message}`);
      this.record("target-rebind-error", { targetId, message: error.message });
    });
  }
  async start() {
    await this.inspector.bindActiveTarget(this.options.timeoutMs);
    await this.network.enable(this.inspector, this.options.timeoutMs);
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
  async installBootstrap() {
    const source = bootstrapScript(this.options.init.assignments);
    await this.inspector.targetCommand("Page.setBootstrapScript", { source }, this.options.timeoutMs);
    const receipt = {
      kind: "pre-navigation-init", sourceKind: this.options.init.sourceKind, sourcePath: this.options.init.sourcePath,
      sourceSha256: this.options.init.sha256, sourceBytes: this.options.init.bytes,
      scriptSha256: createHash("sha256").update(source).digest("hex"), names: Object.keys(this.options.init.assignments).sort()
    };
    this.receipts.push(receipt); this.record("receipt", receipt);
  }
  async navigate(url) {
    this.navigationPending = true;
    this.navigationStartedAt = performance.now();
    this.record("navigation", { event: "started", url, targetId: this.inspector.targetId });
    const pending = this.inspector.navigate(url, this.options.timeoutMs);
    this.startContinuous();
    await pending;
    await this.targetRebind;
    await waitForDocumentReady(this.inspector, this.options.timeoutMs, url);
    this.navigationPending = false;
    const page = await pageDiagnostics(this.inspector, this.options.timeoutMs);
    const expected = this.options.init.assignments;
    const initMatches = JSON.stringify(page?.initReceipt?.values ?? null) === JSON.stringify(expected);
    const receipt = { kind: "navigation-ready", url: page?.url ?? url, targetId: this.inspector.targetId, initMatches, initReceipt: page?.initReceipt ?? null };
    this.receipts.push(receipt); this.record("receipt", receipt);
    if (!initMatches) throw new Error("pre-navigation init receipt did not match requested assignments");
    return page;
  }
  startContinuous() {
    if (this.continuousPromise) return;
    const base = this.navigationStartedAt ?? performance.now();
    this.continuousPromise = (async () => {
      for (let index = 0; !this.continuousStop; index++) {
        const due = base + index * this.options.sampleIntervalMs;
        if (performance.now() < due) await wait(Math.min(due - performance.now(), this.options.sampleIntervalMs));
        if (this.continuousStop) break;
        const started = performance.now();
        const sample = {
          index, at: new Date().toISOString(), scheduledElapsedMs: index * this.options.sampleIntervalMs,
          captureStartedElapsedMs: started - base,
          gap: { lateMs: Math.max(0, started - due), missedIntervals: Math.max(0, Math.floor((started - due) / this.options.sampleIntervalMs)) },
          metrics: {}, failures: []
        };
        const measure = async (name, operation) => {
          try { sample.metrics[name] = { status: "measured", value: await operation() }; }
          catch (error) {
            const failure = { index, metric: name, message: error.message };
            sample.metrics[name] = { status: "missing", error: error.message };
            sample.failures.push(failure); this.continuousFailures.push(failure);
          }
        };
        if (this.cgroupSampler) await measure("cgroup", () => this.cgroupSampler.capture());
        else sample.metrics.cgroup = { status: "not-requested", value: null };
        if (this.processMemorySampler) await measure("processMemory", () => this.processMemorySampler.capture({ label: `continuous-${String(index).padStart(4, "0")}` }));
        else sample.metrics.processMemory = { status: "not-requested", value: null };
        if (sample.metrics.cgroup.status === "measured" && sample.metrics.processMemory.status === "measured") {
          const cgroupPids = sample.metrics.cgroup.value.memberPids;
          const identityRoster = processIdentityRoster(sample.metrics.processMemory.value);
          const processPids = identityRoster.map(process => process.pid);
          if (JSON.stringify(cgroupPids) !== JSON.stringify(processPids)) {
            const failure = { index, metric: "cgroupIdentity", message: `cgroup/process roster mismatch: cgroup=${cgroupPids.join(",")} process=${processPids.join(",")}` };
            sample.failures.push(failure); this.continuousFailures.push(failure);
            if (!this.navigationPending && this.pinnedProcessRoster) this.processIdentityFailures.push(failure);
          } else if (!this.navigationPending && !this.pinnedProcessRoster) {
            this.pinnedProcessRoster = identityRoster;
            this.record("process-identity", { event: "pinned", identities: identityRoster });
          } else if (!this.navigationPending && !sameProcessIdentityRoster(identityRoster, this.pinnedProcessRoster)) {
            const failure = { index, metric: "processIdentity", message: `post-ready process identity changed: pinned=${JSON.stringify(this.pinnedProcessRoster)} current=${JSON.stringify(identityRoster)}` };
            sample.failures.push(failure); this.continuousFailures.push(failure); this.processIdentityFailures.push(failure);
          }
        }
        await measure("dom", () => this.domLayerCapture.capture());
        await measure("page", () => pageDiagnostics(this.inspector, this.options.timeoutMs));
        sample.captureCompletedElapsedMs = performance.now() - base;
        this.continuousSamples.push(sample); this.record("continuous-sample", sample);
      }
    })();
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
    let dom = null;
    try {
      dom = await this.domLayerCapture.capture();
    } catch (error) { this.protocolErrors.push(`LayerTree: ${error.message}`); }
    let page = null;
    try {
      page = await pageDiagnostics(this.inspector, this.options.timeoutMs);
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
    const layerList = Array.isArray(dom?.layers?.layers) ? dom.layers.layers : null;
    const layerSummary = layerList ? {
      count: layerList.length,
      memoryBytes: layerList.reduce((total, layer) => total + (Number.isFinite(layer.memory) ? layer.memory : 0), 0)
    } : null;
    const continuousStart = window.continuousStart ?? 0;
    const mark = { label, at: new Date().toISOString(), memory: {
      ...summarizeMemoryWindow(this.samples, window.sampleStart)
    }, rss, processMemory, cgroup: this.cgroupSampler?.capture() ?? null, layerSummary, layers: dom?.layers ?? null, dom, page, screenshot,
      continuousWindow: summarizeContinuousWindow(this.continuousSamples, continuousStart) };
    this.active = null;
    this.marks.push(mark); this.record("mark", mark); return mark;
  }
  async gc(label) {
    if (!this.active) throw new Error("gc requires a preceding begin command for its pre-GC window");
    const preIndex = this.marks.length;
    const pre = await this.mark(`${label}-pre-gc`);
    this.active = { label: `${label}-post-gc`, sampleStart: this.samples.length, continuousStart: this.continuousSamples.length };
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
    this.continuousStop = true;
    if (this.continuousPromise) await this.continuousPromise.catch(error => this.protocolErrors.push(`continuous sampler: ${error.message}`));
    if (this.cgroupSampler) {
      try { this.finalCgroupSample = this.cgroupSampler.capture(); this.record("cgroup-final", { sample: this.finalCgroupSample }); }
      catch (error) {
        this.finalCgroupError = error.message; this.continuousFailures.push({ index: null, metric: "cgroup-final", message: error.message });
        this.record("cgroup-final-error", { message: error.message });
      }
    }
    let networkCutoffError = null;
    try {
      await this.inspector.targetCommand("Network.disable", {}, this.options.timeoutMs);
      this.networkCutoff = { status: "disabled", error: null, targetId: this.inspector.targetId };
      this.record("network-cutoff", this.networkCutoff);
    } catch (error) {
      networkCutoffError = error;
      this.networkCutoff = { status: "failed", error: error.message, targetId: this.inspector.targetId };
      this.record("network-cutoff", this.networkCutoff);
    }
    try { await this.inspector.targetCommand("Memory.stopTracking"); this.record("lifecycle", { event: "stopTracking" }); }
    catch (error) { this.protocolErrors.push(`stopTracking: ${error.message}`); }
    if (networkCutoffError) throw new Error(`Network.disable cutoff failed: ${networkCutoffError.message}`);
  }
  async finishRaw() {
    if (this.rawFinished) return;
    this.rawFinished = true;
    this.raw.end();
    await finished(this.raw);
  }
  summary() {
    const continuous = summarizeContinuousWindow(this.continuousSamples, 0);
    const settledStartMs = Math.max(0, (this.continuousSamples.at(-1)?.captureCompletedElapsedMs ?? 0) - this.options.settledWindowMs);
    const settledStart = this.continuousSamples.findIndex(sample => sample.captureStartedElapsedMs >= settledStartMs);
    const settled = summarizeContinuousWindow(this.continuousSamples, settledStart < 0 ? this.continuousSamples.length : settledStart);
    const cgroupSamples = [this.cgroupSampler?.initial, ...this.continuousSamples.map(sample => measuredValue(sample, "cgroup")), this.finalCgroupSample].filter(Boolean);
    const cgroupSummary = summarizeCgroupSamples(cgroupSamples, this.cgroupSampler?.initial.events);
    const identityValid = this.options.processMemory === "off"
      ? true
      : Boolean(this.pinnedProcessRoster) && this.processIdentityFailures.length === 0;
    const cgroupReasons = [
      ...this.processIdentityFailures.map(failure => failure.message),
      ...(cgroupSummary.measured ? [] : ["no cgroup samples"]),
      ...(this.finalCgroupError ? [`final cgroup sample failed: ${this.finalCgroupError}`] : []),
      ...(identityValid ? [] : ["post-navigation process roster was not pinned in the dedicated cgroup"])
    ];
    const cgroup = this.cgroupSampler ? {
      schema: LINUX_CGROUP_MEMORY_SCHEMA, requested: true, unit: this.browser.scope?.unit ?? null,
      cgroupPath: this.browser.scope?.cgroupPath ?? null, config: this.cgroupSampler.config,
      identity: this.cgroupSampler.identity,
      ...cgroupSummary,
      valid: cgroupSummary.measured && identityValid && !this.finalCgroupError,
      reasons: cgroupReasons
    } : { schema: LINUX_CGROUP_MEMORY_SCHEMA, requested: false, valid: null, reasons: ["not requested"] };
    return {
      schema: WEBKIT_MEMORY_SCHEMA,
      measured: isMeasuredMemoryCapture({ inspectorClosed: this.inspector.closed && !this.expectedTeardown, lifecycle: this.lifecycle, samples: this.samples }),
      browserPid: this.browser.browserPid ?? this.browser.pid, launcherPid: this.browser.rootPid ?? this.browser.pid,
      viewport: { width: this.options.width, height: this.options.height, dpr: this.options.dpr },
      diagnostics: {
        processMemorySchema: LINUX_PROCESS_MEMORY_SCHEMA, processMemoryMode: this.options.processMemory,
        heapSchema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, heap: this.diagnosticRecords,
        cgroupMemorySchema: LINUX_CGROUP_MEMORY_SCHEMA, domAttributionSchema: WEBKIT_DOM_ATTRIBUTION_SCHEMA,
        networkEvidenceSchema: WEBKIT_NETWORK_EVIDENCE_SCHEMA
      },
      samples: this.samples, categoryPeakBytes: maxMemoryCategories(this.samples), marks: this.marks,
      lifecycle: this.lifecycle, protocolErrors: this.protocolErrors, inspectorErrors: this.inspector.errors,
      continuous: { schema: "couchcoop-webkit-continuous/1", intervalMs: this.options.sampleIntervalMs, samples: this.continuousSamples,
        failures: this.continuousFailures, peaks: continuous, settled: { windowMs: this.options.settledWindowMs, ...settled } },
      cgroup,
      metrics: { cgroupPeakBytes: cgroup.peakBytes ?? continuous.cgroupPeakBytes, pssPeakBytes: continuous.pssPeakBytes,
        layerPeakBytes: continuous.layerPeakBytes, swapPeakBytes: cgroup.swapPeakBytes ?? continuous.swapPeakBytes },
      processIdentity: { valid: Boolean(this.pinnedProcessRoster) && this.processIdentityFailures.length === 0,
        pinnedPids: this.pinnedProcessRoster?.map(process => process.pid) ?? null,
        pinnedIdentities: this.pinnedProcessRoster, failures: this.processIdentityFailures },
      oomEvents: cgroup.eventsDelta?.oom ?? null, oomKillEvents: cgroup.eventsDelta?.oom_kill ?? null,
      targetReplaced: this.targetReplaced, targetHistory: this.targetHistory,
      network: { ...this.network.summary(), cutoff: this.networkCutoff },
      receipts: this.receipts,
      configReceipt: { sourceKind: this.options.init.sourceKind, sourcePath: this.options.init.sourcePath,
        sha256: this.options.init.sha256, bytes: this.options.init.bytes, assignments: this.options.init.assignments }
    };
  }
}

async function launch(options) {
  const executable = webkit.executablePath();
  let child; let startupStderr = ""; let scope = null;
  try {
    if (options.cgroup) {
      scope = await launchWebKitScope({
        executable, args: ["--inspector-pipe", "--headless", "--no-startup-window"],
        memoryMaxBytes: options.cgroupMemoryMaxBytes, memorySwapMaxBytes: options.cgroupSwapMaxBytes,
        timeoutMs: options.timeoutMs
      });
      child = scope.child;
    } else {
      child = spawn(executable, ["--inspector-pipe", "--headless", "--no-startup-window"], {
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], detached: process.platform !== "win32"
      });
    }
    child.stderr.on("data", chunk => { startupStderr += chunk.toString("utf8"); });
    const inspector = new WebKitInspector({ stdin: child.stdio[3], stdout: child.stdio[4], stderr: child.stderr, onClose: listener => child.once("exit", listener) });
    await inspector.bootstrap({ width: options.width, height: options.height, deviceScaleFactor: options.dpr, timeoutMs: options.timeoutMs });
    return {
      child, inspector, pid: scope?.launcherPid ?? child.pid, rootPid: scope?.launcherPid ?? child.pid,
      browserPid: scope?.browserPid ?? child.pid, cgroupSampler: scope?.sampler ?? null,
      scope: scope ? { unit: scope.unit, token: scope.token, cgroupPath: scope.cgroupPath, command: scope.command } : null
    };
  } catch (error) {
    if (scope) await stopOwnedScope({ unit: scope.unit, token: scope.token }).catch(() => {});
    else if (child) await terminateProcessGroup(child).catch(() => {});
    error.webkitStderr = startupStderr;
    throw error;
  }
}

async function runFixed(capture, options) {
  const url = options.selfTest ? SELFTEST_PAGE : options.url;
  await capture.navigate(url);
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
  await wait(options.durationMs);
  capture.active = { label: options.selfTest ? "self-test" : "fixed", sampleStart: 0, continuousStart: 0 };
  await capture.mark(options.selfTest ? "self-test" : "final");
}

async function waitForDocumentReady(inspector, timeoutMs, expectedUrl = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await inspector.targetCommand("Runtime.evaluate", {
      expression: "JSON.stringify({ ready: document.readyState === 'complete', href: location.href })", returnByValue: true
    }, timeoutMs);
    const state = JSON.parse(result.result?.value ?? "null");
    const leftBootstrap = !expectedUrl || expectedUrl === "about:blank" || state?.href !== "about:blank";
    if (state?.ready === true && leftBootstrap) return state;
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
        capture.active = { label: request.label ?? "window", sampleStart: capture.samples.length, continuousStart: capture.continuousSamples.length };
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
      } else if (request.command === "evaluate") {
        if (typeof request.expression !== "string") throw new Error("evaluate requires a string expression");
        const result = await capture.inspector.targetCommand("Runtime.evaluate", {
          expression: request.expression, returnByValue: request.returnByValue !== false,
          awaitPromise: request.awaitPromise === true
        }, capture.options.timeoutMs);
        const receipt = { command: "evaluate", request: { expression: request.expression, returnByValue: request.returnByValue !== false, awaitPromise: request.awaitPromise === true }, result };
        capture.receipts.push(receipt); capture.record("rpc-receipt", receipt);
        process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
      } else if (request.command === "mouse") {
        const params = Object.fromEntries(Object.entries(request).filter(([name]) => !["command", "label"].includes(name)));
        if (!["move", "down", "up", "wheel"].includes(params.type)) throw new Error("mouse requires type move, down, up, or wheel");
        for (const name of ["x", "y"]) if (!Number.isInteger(params[name])) throw new Error(`mouse ${name} must be an integer`);
        const result = await capture.inspector.proxy("Input.dispatchMouseEvent", params, capture.options.timeoutMs);
        const receipt = { command: "mouse", label: request.label ?? null, params, result, targetId: capture.inspector.targetId };
        capture.receipts.push(receipt); capture.record("rpc-receipt", receipt);
        process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
      } else if (request.command === "tap") {
        const params = Object.fromEntries(Object.entries(request).filter(([name]) => !["command", "label"].includes(name)));
        for (const name of ["x", "y"]) if (!Number.isInteger(params[name])) throw new Error(`tap ${name} must be an integer`);
        const result = await capture.inspector.proxy("Input.dispatchTapEvent", params, capture.options.timeoutMs);
        const receipt = { command: "tap", label: request.label ?? null, params, result, targetId: capture.inspector.targetId };
        capture.receipts.push(receipt); capture.record("rpc-receipt", receipt);
        process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
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
    capture = new Capture(launched.inspector, launched, options, outDir);
    await capture.start();
    await capture.installBootstrap();
    if (options.journey) {
      if (options.url) await capture.navigate(options.url);
      else capture.startContinuous();
      process.stdout.write(`${JSON.stringify({ ok: true, command: "ready", url: options.url ?? "about:blank", targetId: capture.inspector.targetId,
        init: { sha256: options.init.sha256, names: Object.keys(options.init.assignments).sort() } })}\n`);
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
    cleanup = launched?.scope
      ? await stopOwnedScope({ unit: launched.scope.unit, token: launched.scope.token }).catch(error => ({ unit: launched.scope.unit, owned: true, stopped: false, error: error.message }))
      : await terminateProcessGroup(launched?.child).catch(error => ({ rootPid: launched?.child?.pid ?? null, orphanedPids: [launched?.child?.pid].filter(Boolean), error: error.message }));
    if (capture) {
      await capture.inspector.waitForTransportDrain(options.timeoutMs).catch(error => {
        capture.protocolErrors.push(`transport drain: ${error.message}`); failure ??= error;
      });
      await capture.finishRaw().catch(error => { capture.protocolErrors.push(`raw finish: ${error.message}`); failure ??= error; });
    }
    if (capture) writeFileSync(resolve(outDir, "stderr.log"), capture.stderr);
    const summary = capture ? capture.summary() : {
      schema: WEBKIT_MEMORY_SCHEMA, measured: false, browserPid: launched?.browserPid ?? launched?.child?.pid ?? null,
      viewport: { width: options.width, height: options.height, dpr: options.dpr },
      diagnostics: {
        processMemorySchema: LINUX_PROCESS_MEMORY_SCHEMA, processMemoryMode: options.processMemory,
        heapSchema: WEBKIT_HEAP_DIAGNOSTICS_SCHEMA, heap: [], cgroupMemorySchema: LINUX_CGROUP_MEMORY_SCHEMA,
        domAttributionSchema: WEBKIT_DOM_ATTRIBUTION_SCHEMA, networkEvidenceSchema: WEBKIT_NETWORK_EVIDENCE_SCHEMA
      },
      samples: [], categoryPeakBytes: {}, marks: [], lifecycle: { started: false, completed: false }, protocolErrors: [], inspectorErrors: [],
      continuous: { schema: "couchcoop-webkit-continuous/1", intervalMs: options.sampleIntervalMs, samples: [], failures: [], peaks: {}, settled: {} },
      cgroup: { schema: LINUX_CGROUP_MEMORY_SCHEMA, requested: options.cgroup, valid: false, reasons: ["launch failed"] },
      metrics: { cgroupPeakBytes: null, pssPeakBytes: null, layerPeakBytes: null, swapPeakBytes: null },
      processIdentity: { valid: false, pinnedPids: null, failures: [] }, targetReplaced: false, targetHistory: [], receipts: [],
      network: { schema: WEBKIT_NETWORK_EVIDENCE_SCHEMA, status: "missing", error: "launch failed", requests: [], assets: [], failedRequests: [], webSockets: [], frames: [] }
    };
    summary.sourceReceipt = {
      files: {
        "scripts/probe-webkit-memory.mjs": hashFile(fileURLToPath(import.meta.url)),
        "scripts/lib/linux-cgroup-memory.mjs": hashFile(resolve(HERE, "lib/linux-cgroup-memory.mjs")),
        "scripts/lib/linux-process-memory.mjs": hashFile(resolve(HERE, "lib/linux-process-memory.mjs")),
        "scripts/lib/webkit-memory-probe.mjs": hashFile(resolve(HERE, "lib/webkit-memory-probe.mjs")),
        "scripts/lib/webkit-dom-attribution.mjs": hashFile(resolve(HERE, "lib/webkit-dom-attribution.mjs")),
        "scripts/lib/webkit-network-evidence.mjs": hashFile(resolve(HERE, "lib/webkit-network-evidence.mjs"))
      },
      initSha256: options.init.sha256, initSourceKind: options.init.sourceKind
    };
    summary.cleanup = cleanup;
    if (failure) { summary.measured = false; summary.failure = failure.message; }
    if (!capture) {
      writeFileSync(resolve(outDir, "raw.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), type: "meta", schema: WEBKIT_MEMORY_SCHEMA, outcome: "launch-failed" })}\n`);
      writeFileSync(resolve(outDir, "stderr.log"), failure?.webkitStderr ?? "");
    }
    if (Array.isArray(cleanup.orphanedPids) && cleanup.orphanedPids.length) failure ??= new Error(`WebKit cleanup left process(es): ${cleanup.orphanedPids.join(", ")}`);
    if (cleanup.stopped === false) failure ??= new Error(`owned WebKit scope cleanup failed: ${cleanup.error ?? cleanup.activeState}`);
    if (summary.targetReplaced) { summary.measured = false; failure ??= new Error("UNMEASURED: WebKit target was replaced after initial navigation"); }
    if (options.cgroup && summary.cgroup?.valid !== true) { summary.measured = false; failure ??= new Error(`UNMEASURED: cgroup identity invalid: ${(summary.cgroup?.reasons ?? []).join("; ")}`); }
    if (!failure && !summary.measured) failure = new Error("UNMEASURED: missing lifecycle, target, or nonzero Memory updates");
    if (failure) { summary.measured = false; summary.failure = failure.message; }
    writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    if (!failure) process.stdout.write(`${JSON.stringify({ measured: true, outDir, samples: summary.samples.length, categoryPeakBytes: summary.categoryPeakBytes, cleanup })}\n`);
  }
  if (failure) throw failure;
}

main().catch(error => { console.error(`[webkit-memory] ${error.stack ?? error.message}`); process.exitCode = 1; });
