#!/usr/bin/env node
// Validate the raw --trace artifact before attributing GPU work to WebGL calls.
// The replay harness writes an event array. Stream it: a busy GPU trace can exceed JS heap.
import { createReadStream, readFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { ACTIVE_TRACE_WINDOW, IDLE_TRACE_WINDOW, traceMarkerLabel } from "./bench-trace-lifecycle.mjs";

export function inspectTraceEvents(events, phase = "active") {
  const scope = phase === "idle" ? IDLE_TRACE_WINDOW : ACTIVE_TRACE_WINDOW;
  const processes = new Map();
  const starts = [], ends = [];
  const loss = [], glNames = new Set();
  let count = 0, timestamped = 0, inWindow = 0, gpuEvents = 0;
  // Streaming input is consumed in trace order; the final coverage pass uses min/max timestamps.
  let minTs = Infinity, maxTs = -Infinity;
  const seen = [];
  for (const e of events) {
    count++;
    if (e.ph === "M" && e.name === "process_name") processes.set(e.pid, String(e.args?.name ?? ""));
    const label = traceMarkerLabel(e);
    if (label === scope.startMarker) starts.push(e);
    if (label === scope.endMarker) ends.push(e);
    if (/data.?loss|trace.?overflow|buffer.?overflow|trace_has_overflows/i.test(String(e.name))) loss.push(e.name);
    if (Number.isFinite(e.ts)) {
      timestamped++;
      minTs = Math.min(minTs, e.ts);
      maxTs = Math.max(maxTs, e.ts);
      seen.push({ ts: e.ts, pid: e.pid, name: String(e.name ?? "") });
    }
  }
  const start = starts[0]?.ts, end = ends[0]?.ts;
  const gpuPids = [...processes].filter(([, name]) => /gpu process/i.test(name)).map(([pid]) => pid);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    for (const e of seen) {
      if (e.ts < start || e.ts > end) continue;
      inWindow++;
      if (gpuPids.includes(e.pid)) gpuEvents++;
      if (gpuPids.includes(e.pid) && /^(?:TraceGLAPI::)?gl[A-Z][A-Za-z0-9_]*$/.test(e.name)) glNames.add(e.name);
    }
  }
  const failures = [];
  if (starts.length !== 1 || ends.length !== 1 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) failures.push("markers missing, duplicate, or unordered");
  if (!processes.size || !gpuPids.length) failures.push("process_name metadata or GPU Process identity missing");
  if (loss.length) failures.push("trace contains data-loss/overflow events");
  if (!timestamped || minTs > start || maxTs < end || inWindow < 3) failures.push("event coverage does not span the marker window");
  if (!gpuEvents) failures.push("no GPU-process events within marker window");
  return { schema: "gpu-attribution-trace-validation/1", phase, valid: failures.length === 0,
    failures, markers: { start, end, startCount: starts.length, endCount: ends.length },
    events: { total: count, timestamped, inWindow, gpuInWindow: gpuEvents, minTs, maxTs },
    processNames: Object.fromEntries(processes), gpuPids, lossEvents: loss,
    glCallNames: [...glNames].sort(), perGlCallTracing: glNames.size ? "exposed" : "unavailable" };
}

export async function* readRawEvents(path) {
  const source = createReadStream(path);
  const input = path.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  let depth = 0, quoted = false, escaped = false, item = "", outer = false, closed = false;
  const decoder = new TextDecoder();
  scan: for await (const chunk of input) {
    for (const ch of decoder.decode(chunk, { stream: true })) {
      if (!outer) { if (ch === "[") outer = true; continue; }
      if (depth === 0) {
        if (ch === "]") { closed = true; break scan; }
        if (ch === "{") { depth = 1; item = "{"; }
        continue;
      }
      item += ch;
      if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { yield JSON.parse(item); item = ""; }
    }
  }
  if (!outer || !closed || depth !== 0) throw new Error("incomplete raw trace array");
}

export async function inspectRawTrace(path, phase = "active") {
  let capture = null;
  try { capture = JSON.parse(readFileSync(`${path}.meta.json`, "utf8")); } catch { /* reported below */ }
  const scope = phase === "idle" ? IDLE_TRACE_WINDOW : ACTIVE_TRACE_WINDOW;
  const processes = new Map(), starts = [], ends = [], loss = [];
  let total = 0, timestamped = 0, minTs = Infinity, maxTs = -Infinity;
  for await (const e of readRawEvents(path)) {
    total++;
    if (e.ph === "M" && e.name === "process_name") processes.set(e.pid, String(e.args?.name ?? ""));
    const label = traceMarkerLabel(e);
    if (label === scope.startMarker) starts.push(e.ts);
    if (label === scope.endMarker) ends.push(e.ts);
    if (/data.?loss|trace.?overflow|buffer.?overflow|trace_has_overflows/i.test(String(e.name))) loss.push(e.name);
    if (Number.isFinite(e.ts)) { timestamped++; minTs = Math.min(minTs, e.ts); maxTs = Math.max(maxTs, e.ts); }
  }
  const start = starts[0], end = ends[0];
  const gpuPids = [...processes].filter(([, name]) => /gpu process/i.test(name)).map(([pid]) => pid);
  let inWindow = 0, gpuInWindow = 0;
  const glNames = new Set();
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    for await (const e of readRawEvents(path)) {
      if (!Number.isFinite(e.ts) || e.ts < start || e.ts > end) continue;
      inWindow++;
      if (gpuPids.includes(e.pid)) gpuInWindow++;
      if (gpuPids.includes(e.pid) && /^(?:TraceGLAPI::)?gl[A-Z][A-Za-z0-9_]*$/.test(String(e.name))) glNames.add(e.name);
    }
  }
  const failures = [];
  if (starts.length !== 1 || ends.length !== 1 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) failures.push("markers missing, duplicate, or unordered");
  if (!processes.size || !gpuPids.length) failures.push("process_name metadata or GPU Process identity missing");
  if (loss.length) failures.push("trace contains data-loss/overflow events");
  if (!timestamped || minTs > start || maxTs < end || inWindow < 3) failures.push("event coverage does not span the marker window");
  if (!gpuInWindow) failures.push("no GPU-process events within marker window");
  if (capture?.schema !== "raw-cdp-trace/1" || capture.fullRawEvents !== true || capture.tracingComplete !== true) {
    failures.push("full-raw CDP capture metadata missing or invalid");
  }
  if (capture?.dataLossOccurred !== false) failures.push("CDP data-loss status missing or true");
  if (capture?.rawEventCount !== total) failures.push("CDP raw event count differs from artifact");
  if (capture?.maxBufferPercent >= 1) failures.push("CDP trace buffer reached capacity");
  for (const category of ["gpu", "viz", "disabled-by-default-gpu.service", "disabled-by-default-skia.gpu"]) {
    if (!capture?.categories?.includes(category)) failures.push(`GPU trace category missing: ${category}`);
  }
  return { schema: "gpu-attribution-trace-validation/1", phase, valid: failures.length === 0,
    failures, markers: { start, end, startCount: starts.length, endCount: ends.length },
    events: { total, timestamped, inWindow, gpuInWindow, minTs, maxTs },
    processNames: Object.fromEntries(processes), gpuPids, lossEvents: loss, capture,
    glCallNames: [...glNames].sort(), perGlCallTracing: glNames.size ? "exposed" : "unavailable" };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const path = process.argv[2];
  const phase = process.argv[3] ?? "active";
  if (!path || !["active", "idle"].includes(phase)) {
    console.error("Usage: node scripts/validate-gpu-attribution-trace.mjs <raw-trace.json[.gz]> [active|idle]");
    process.exit(2);
  }
  const result = await inspectRawTrace(path, phase);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 2;
}
