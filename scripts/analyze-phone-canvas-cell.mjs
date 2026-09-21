#!/usr/bin/env node
// Convert one phone canvas matrix cell into a small, reviewable metric record. The raw Chrome trace remains the
// evidence; this file only finds the bench's renderer-main markers and asks analyze-gpu-trace for that exact
// interval. Keeping the marker lookup here prevents a caller from accidentally analysing navigation or settle.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { perfettoActualFrames } from "./lib/perfetto-frame-timeline.mjs";
import { presentationStats } from "./lib/perfetto-presentation.mjs";
import { markerThreadCpu } from "./lib/marker-thread-cpu.mjs";
import { perfettoSchedCpu } from "./lib/perfetto-sched-cpu.mjs";

function usage() {
  console.log(`analyze-phone-canvas-cell.mjs

  node scripts/analyze-phone-canvas-cell.mjs --trace <trace.json[.gz]> --result <BENCH_RESULT.json>
    --meta <cell.meta.json> --phase <active|idle> --out <cell.metrics.json>
    [--perfetto-trace <capture.pftrace> --trace-processor <trace_processor_shell> --present-surface <layer_name>]

The active phase uses cc-report-start/end; idle uses cc-idle-start/end. Missing markers are a hard
measurement failure, never silently widened to the whole trace. Actual display metrics require a surface-attributed
Chrome feedback marker or the optional Perfetto FrameTimeline input; DrawFrame remains submission-only.`);
}

function parseArgs(argv) {
  const args = { trace: null, result: null, meta: null, phase: null, out: null, perfettoTrace: null, traceProcessor: null, presentSurface: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--help" || key === "-h") args.help = true;
    else if (["--trace", "--result", "--meta", "--phase", "--out", "--perfetto-trace", "--trace-processor", "--present-surface"].includes(key)) {
      args[{ "--perfetto-trace": "perfettoTrace", "--trace-processor": "traceProcessor", "--present-surface": "presentSurface" }[key] ?? key.slice(2)] = argv[++i];
    }
    else throw new Error(`unknown argument: ${key}`);
  }
  return args;
}

function loadJson(path) {
  const bytes = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.traceEvents;
}

function markerLabel(event) {
  return event?.args?.data?.message ?? event?.args?.message ?? event?.args?.data?.name ?? event?.args?.name ?? null;
}

function markerWindow(events, phase) {
  const [startName, endName] = phase === "idle" ? ["cc-idle-start", "cc-idle-end"] : ["cc-report-start", "cc-report-end"];
  let traceStart = Infinity;
  let start = null;
  let end = null;
  let starts = 0;
  let ends = 0;
  for (const event of events) {
    if (typeof event?.ts === "number" && event.ts > 0 && event.ts < traceStart) traceStart = event.ts;
    if (markerLabel(event) === startName) { start = event; starts++; }
    if (markerLabel(event) === endName) { end = event; ends++; }
  }
  if (!Number.isFinite(traceStart)) throw new Error("trace has no timestamps");
  if (!start || !end) throw new Error(`missing ${start ? endName : startName} marker`);
  if (starts !== 1 || ends !== 1) throw new Error(`ambiguous ${phase} markers: ${starts} starts, ${ends} ends`);
  if (start.pid !== end.pid || start.tid !== end.tid) throw new Error("marker thread changed");
  if (!(end.ts > start.ts)) throw new Error(`invalid ${phase} marker interval`);
  return {
    phase,
    startName,
    endName,
    startUs: start.ts,
    endUs: end.ts,
    startMs: (start.ts - traceStart) / 1000,
    endMs: (end.ts - traceStart) / 1000,
    windowMs: (end.ts - start.ts) / 1000,
    traceStartUs: traceStart
  };
}

function analysisResult(trace, window, presentSurface = null) {
  const command = [
    resolve(new URL(".", import.meta.url).pathname, "analyze-gpu-trace.mjs"), trace,
    "--from-us", String(window.startUs), "--to-us", String(window.endUs),
    "--stalls", "0", "--gaps", "0", "--json"
  ];
  if (typeof presentSurface === "string" && presentSurface) command.push("--present-surface", presentSurface);
  const stdout = execFileSync(
    process.execPath,
    command,
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const line = stdout.split("\n").find((row) => row.startsWith("ANALYSIS_RESULT "));
  if (!line) throw new Error("analyze-gpu-trace produced no ANALYSIS_RESULT");
  return JSON.parse(line.slice("ANALYSIS_RESULT ".length));
}

function percent(cpuMs, windowMs) {
  return typeof cpuMs === "number" && windowMs > 0 ? +(cpuMs / windowMs * 100).toFixed(2) : null;
}

function mib(kib) {
  return +(kib / 1024).toFixed(3);
}

/**
 * Parse Android's `ps -A -o PID,RSS,NAME` ledger captured after a cell. RSS is KiB. This is deliberately a
 * settled lower bound, not Chromium's browser-launch peak sampler: Android owns the real renderer/GPU pids.
 */
function parseAndroidChromeRssLedger(text, ledgerPath = null) {
  if (typeof text !== "string" || !text.trim()) return null;
  let gpuKiB = 0;
  let rendererKiB = 0;
  let totalKiB = 0;
  let chromeRows = 0;
  let gpuRows = 0;
  let rendererRows = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^PID\s+RSS\s+NAME$/i.test(line)) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)$/.exec(line);
    if (!match) return null;
    const rssKiB = Number(match[2]);
    const name = match[3];
    if (!Number.isSafeInteger(rssKiB) || rssKiB < 0 || !name.startsWith("com.android.chrome")) return null;
    chromeRows++;
    totalKiB += rssKiB;
    if (/^com\.android\.chrome:privileged_process/.test(name)) {
      gpuRows++;
      gpuKiB += rssKiB;
    }
    if (/^com\.android\.chrome:sandboxed_process/.test(name)) {
      rendererRows++;
      rendererKiB += rssKiB;
    }
  }
  if (!chromeRows || !gpuRows) return null;
  return {
    gpu: mib(gpuKiB),
    renderers: mib(rendererKiB),
    total: mib(totalKiB),
    source: "android-ps-rss-settled",
    provenance: "post-cell Android ps RSS lower bound; not browser-launch peak sampling",
    ledgerPath,
    chromeRows,
    gpuRows,
    rendererRows,
    unit: "MiB"
  };
}

function readAndroidChromeRssLedger(path) {
  if (typeof path !== "string" || !path) return null;
  try {
    return parseAndroidChromeRssLedger(readFileSync(path, "utf8"), path);
  } catch {
    return null;
  }
}

function parseAndroidChromeGpuPidsLedger(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const pids = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^PID\s+RSS\s+NAME$/i.test(line)) continue;
    const match = /^(\d+)\s+\d+\s+(\S+)$/.exec(line);
    if (!match) return null;
    if (/^com\.android\.chrome:privileged_process/.test(match[2])) {
      const pid = Number(match[1]);
      if (pids.has(pid)) return null;
      pids.add(pid);
    }
  }
  return pids.size ? [...pids].sort((a, b) => a - b) : null;
}

function stableGpuPids(meta) {
  const before = readAndroidChromeRssLedger(meta.artifacts?.procsBefore);
  const after = readAndroidChromeRssLedger(meta.artifacts?.procsAfter);
  const beforePids = before && parseAndroidChromeGpuPidsLedger(readFileSync(meta.artifacts.procsBefore, "utf8"));
  const afterPids = after && parseAndroidChromeGpuPidsLedger(readFileSync(meta.artifacts.procsAfter, "utf8"));
  if (!beforePids || !afterPids || beforePids.join(",") !== afterPids.join(",")) throw Error("GPU PID ledger is missing or changed during cell");
  return beforePids;
}

function hostProcMemory(result) {
  const proc = result.procMem?.peakMb ?? result.procMem?.lastLiveMb ?? null;
  return proc
    ? {
        gpu: proc.gpu ?? null,
        renderers: proc.renderers ?? null,
        total: proc.total ?? null,
        source: result.procMem?.peakMb ? "browser-launch-proc-mem-peak" : "browser-launch-proc-mem-settled",
        provenance: "host-launched browser process sampler",
        ledgerPath: null,
        unit: "MiB"
      }
    : null;
}

// Passing `null` is intentional for a phone cell: it means the required Android ledger was unavailable and
// MUST NOT fall back to a host/browser metric. `undefined` keeps this helper useful for non-phone callers.
function buildMetrics(meta, result, window, trace, deviceMemory = undefined, actualPresented = trace.actualPresents, markerCpu = null, schedCpu = null) {
  const renderer = trace.threads.find((row) => /CrRendererMain/.test(row.label));
  const memory = deviceMemory === undefined ? hostProcMemory(result) : deviceMemory;
  // Do not manufacture direct-path timing from a whole-frame timing. The first set field is preserved so the
  // matrix gate can fail closed until the canvas diagnostic publishes the requested direct p95.
  const canvasStats = result.census?.canvasStats ?? result.census?.canvas ?? result.idle?.stage ?? null;
  return {
    schema: "phone-canvas-cell-metrics/2",
    cell: meta,
    phase: window.phase,
    traceWindow: window,
    // Historical renderer submission cadence. A DrawFrame is not display presentation.
    submitted: trace.submitted
      ? {
          source: trace.presentSource,
          fps: trace.submitted.fps,
          gapP50Ms: trace.submitted.gapP50Ms,
          // The trace analyzer intentionally reports p90 rather than p95. The rAF instrument below is the
          // This is submission-cadence provenance only. The actual-presentation p95 comes from attributed feedback.
          gapP90Ms: trace.submitted.gapP90Ms,
          gapMaxMs: trace.submitted.gapMaxMs,
          count: trace.submitted.count
        }
      : null,
    // This only exists when the capture has an explicit matching surface/layer attribution. Missing feedback
    // remains null so acceptance cannot accidentally treat a submission marker as a displayed frame.
    actualPresented: actualPresented
      ? {
          ...actualPresented,
          surface: actualPresented.provenance?.surface ?? actualPresented.surface ?? null,
          provenance: actualPresented.provenance ?? null
        }
      : null,
    cpu: {
      // Whole renderer-main thread CPU between trace markers. This is primary:
      // it does not lose the small RunTask slices that lack `tdur`.
      rendererMainPct: markerCpu?.cpuPct ?? null,
      rendererMainCpuMs: markerCpu?.cpuMs ?? null,
      rendererMain: markerCpu,
      // Historical traced RunTask aggregate, retained for diagnostics only.
      rendererMainRunTaskPct: percent(renderer?.cpuMs ?? null, trace.windowMs),
      rendererMainRunTaskCpuMs: renderer?.cpuMs ?? null,
      // Exact kernel scheduling CPU across every ledgered GPU PID. Chrome's
      // incomplete RunTask aggregate stays diagnostic and can never pass a gate.
      gpuProcessPct: schedCpu?.cpuPct ?? null,
      gpuProcessCpuMs: schedCpu?.cpuMs ?? null,
      gpuProcess: schedCpu,
      gpuProcessRunTaskPct: percent(trace.gpuProcess?.cpuMs ?? null, trace.windowMs),
      gpuProcessRunTaskCpuMs: trace.gpuProcess?.cpuMs ?? null,
      gpuProcessRunTaskCoverage: trace.gpuProcess?.cpuCoverage ?? null
    },
    frameGaps: window.phase === "idle" ? result.idle?.frameGaps ?? null : result.medians?.frameGaps ?? null,
    sceneAckLatency: result.medians?.sceneAckLatency ?? null,
    display: {
      viewport: result.config?.viewport ?? null,
      devicePixelRatio: result.config?.devicePixelRatio ?? null,
      detectedVsyncMs: result.medians?.frameGaps?.vsyncMs ?? null,
      dumpsysPath: meta.artifacts?.display ?? null
    },
    memoryMb: memory
      ? { gpu: memory.gpu ?? null, renderers: memory.renderers ?? null, total: memory.total ?? null }
      : null,
    memory: memory
      ? { source: memory.source, provenance: memory.provenance, ledgerPath: memory.ledgerPath, chromeRows: memory.chromeRows ?? null,
          gpuRows: memory.gpuRows ?? null, rendererRows: memory.rendererRows ?? null, unit: memory.unit }
      : null,
    canvasStats,
    windowedFallback: result.census?.windowedFallback ?? result.census?.canvasStats?.windowedFallback ?? null,
    health: meta.health ?? null,
    resultPath: meta.artifacts?.result ?? null,
    tracePath: meta.artifacts?.trace ?? null
  };
}

export { markerWindow, parseAndroidChromeRssLedger, readAndroidChromeRssLedger, parseAndroidChromeGpuPidsLedger, buildMetrics };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (![args.trace, args.result, args.meta, args.phase, args.out].every(Boolean) || !["active", "idle"].includes(args.phase)) {
    usage();
    process.exit(2);
  }
  const events = loadJson(args.trace);
  if (!Array.isArray(events)) throw new Error("trace is neither an event array nor a traceEvents wrapper");
  const meta = JSON.parse(readFileSync(args.meta, "utf8"));
  const result = JSON.parse(readFileSync(args.result, "utf8"));
  const window = markerWindow(events, args.phase);
  let markerCpu = null;
  let markerCpuError = null;
  try { markerCpu = markerThreadCpu(events, args.phase); }
  catch (error) { markerCpuError = error.message; }
  const presentSurface = args.presentSurface ?? meta.presentation?.surface ?? meta.capture?.presentSurface ?? meta.artifacts?.presentSurface ?? null;
  const trace = analysisResult(args.trace, window, presentSurface);
  const perfettoSamples = args.perfettoTrace || meta.artifacts?.perfettoTrace
    ? perfettoActualFrames({ processor: args.traceProcessor ?? meta.artifacts?.traceProcessor, trace: args.perfettoTrace ?? meta.artifacts?.perfettoTrace,
      surface: presentSurface, upid: meta.presentation?.upid, chromeStartUs: window.startUs, chromeEndUs: window.endUs }) : null;
  const actualPresented = perfettoSamples ? presentationStats(perfettoSamples, window.windowMs) : trace.actualPresents;
  const deviceMemory = readAndroidChromeRssLedger(meta.artifacts?.procsAfter);
  let schedCpu = null;
  let schedCpuError = null;
  if (meta.artifacts?.perfettoSchedCpu === true) try {
    schedCpu = perfettoSchedCpu({ processor: args.traceProcessor ?? meta.artifacts?.traceProcessor,
      trace: args.perfettoTrace ?? meta.artifacts?.perfettoTrace, chromeStartUs: window.startUs,
      chromeEndUs: window.endUs, gpuPids: stableGpuPids(meta) });
    if (!schedCpu) schedCpuError = "GPU sched CPU input is incomplete";
  } catch (error) { schedCpuError = error.message; }
  const metrics = buildMetrics(meta, result, window, trace, deviceMemory, actualPresented, markerCpu, schedCpu);
  if (markerCpuError) metrics.cpu.rendererMain = { source: "chrome-trace-marker-thread-ticks", error: markerCpuError };
  if (schedCpuError) metrics.cpu.gpuProcess = { source: "perfetto-linux-ftrace-sched-switch", error: schedCpuError };
  writeFileSync(args.out, `${JSON.stringify(metrics, null, 2)}\n`);
} catch (error) {
  console.error(`analyze-phone-canvas-cell: ${error?.stack ?? error}`);
  process.exitCode = 1;
}
