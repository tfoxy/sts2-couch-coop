import { traceMarkerLabel, ACTIVE_TRACE_WINDOW, IDLE_TRACE_WINDOW } from "../bench-trace-lifecycle.mjs";

const API_CALL = /^(?:Trace(GL|EGL)API::)?(gl[A-Z][A-Za-z0-9_]*|egl[A-Z][A-Za-z0-9_]*)$/;
const LOSS = /data.?loss|trace.?overflow|buffer.?overflow|trace_has_overflows/i;

// Analyze named GL/EGL API complete events from Chrome's tracing wrappers. `dur` is elapsed span; `tdur` is
// the trace-provided CPU duration. These quantities are deliberately reported independently.
export function analyzeGlOperationAttribution(events, metadata, { gpuPid, phase = "active", startUs, endUs } = {}) {
  const scope = phase === "idle" ? IDLE_TRACE_WINDOW : ACTIVE_TRACE_WINDOW;
  const failures = [];
  const processes = new Map();
  const threadNames = new Map();
  const starts = [], ends = [];
  const lossEvents = [];
  let minTs = Infinity, maxEnd = -Infinity;
  for (const e of events) {
    if (e.ph === "M" && e.name === "process_name") processes.set(Number(e.pid), String(e.args?.name ?? ""));
    if (e.ph === "M" && e.name === "thread_name") threadNames.set(`${Number(e.pid)}:${Number(e.tid)}`, String(e.args?.name ?? ""));
    const label = traceMarkerLabel(e);
    if (label === scope.startMarker) starts.push(e.ts);
    if (label === scope.endMarker) ends.push(e.ts);
    if (LOSS.test(String(e.name ?? ""))) lossEvents.push(e.name);
    if (Number.isFinite(e.ts)) {
      minTs = Math.min(minTs, e.ts);
      maxEnd = Math.max(maxEnd, e.ts + (Number.isFinite(e.dur) ? e.dur : 0));
    }
  }
  if (startUs === undefined) startUs = starts[0];
  if (endUs === undefined) endUs = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || startUs !== starts[0] || endUs !== ends[0] || !(endUs > startUs)) {
    failures.push("marker window missing, duplicate, overridden, or unordered");
  }
  if (!Number.isInteger(gpuPid) || !/gpu process/i.test(processes.get(gpuPid) ?? "")) failures.push("supplied GPU PID does not match GPU Process metadata");
  if (metadata?.schema !== "raw-cdp-trace/1" || metadata.fullRawEvents !== true || metadata.tracingComplete !== true) failures.push("complete raw CDP metadata missing");
  if (metadata?.dataLossOccurred !== false || lossEvents.length) failures.push("trace data loss status missing or loss event present");
  const total = events.length;
  if (!Number.isFinite(minTs) || minTs > startUs || maxEnd < endUs) failures.push("trace event coverage does not span marker window");
  if (metadata?.rawEventCount !== total) failures.push("metadata raw event count does not match trace");

  const calls = [];
  if (Number.isFinite(startUs) && Number.isFinite(endUs)) for (const e of events) {
    const match = API_CALL.exec(String(e.name));
    if (e.pid !== gpuPid || e.ph !== "X" || !match || !Number.isFinite(e.ts) || !Number.isFinite(e.dur) || e.dur <= 0) continue;
    const from = Math.max(startUs, e.ts), to = Math.min(endUs, e.ts + e.dur);
    if (to > from) {
      const family = match[1] ?? (match[2].startsWith("gl") ? "GL" : "EGL");
      const fullyContained = e.ts >= startUs && e.ts + e.dur <= endUs;
      calls.push({ family, name: match[2], pid: e.pid, tid: Number.isInteger(e.tid) ? e.tid : null,
        threadName: Number.isInteger(e.tid) ? threadNames.get(`${e.pid}:${e.tid}`) ?? null : null,
        ts: from, end: to, wallUs: to - from,
        tdurUs: fullyContained && Number.isFinite(e.tdur) && e.tdur >= 0 ? e.tdur : null,
        tdurUnavailableReason: !fullyContained ? "event-crosses-marker-boundary" : !Number.isFinite(e.tdur) || e.tdur < 0 ? "tdur-missing" : null });
    }
  }
  if (!calls.length) failures.push("no named GL API complete events in marker window");
  calls.sort((a, b) => a.ts - b.ts || a.end - b.end);
  const groups = new Map();
  for (const c of calls) {
    const key = `${c.family}::${c.name}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { family: c.family, call: c.name, eventCount: 0, spanUs: 0, tdurKnown: 0, tdurMissing: 0, tdurKnownSumUs: 0 });
    g.eventCount++; g.spanUs += c.wallUs;
    if (c.tdurUs === null) g.tdurMissing++; else { g.tdurKnown++; g.tdurKnownSumUs += c.tdurUs; }
  }
  const operations = [...groups.values()].sort((a,b) => a.call.localeCompare(b.call)).map(g => ({
    ...g, tdurCompleteSumUs: g.tdurMissing === 0 ? g.tdurKnownSumUs : null,
    tdurStatus: g.tdurMissing === 0 ? "tdur-complete" : g.tdurKnown ? "tdur-partial-unavailable" : "tdur-unavailable"
  }));
  const families = ["GL", "EGL"].map(family => {
    const rows = operations.filter(row => row.family === family);
    const eventCount = rows.reduce((n, row) => n + row.eventCount, 0);
    const tdurKnown = rows.reduce((n, row) => n + row.tdurKnown, 0);
    const tdurMissing = rows.reduce((n, row) => n + row.tdurMissing, 0);
    const tdurKnownSumUs = rows.reduce((n, row) => n + row.tdurKnownSumUs, 0);
    return { family, eventCount, tdurKnown, tdurMissing,
      tdurKnownSumUs, tdurCompleteSumUs: eventCount > 0 && tdurMissing === 0 ? tdurKnownSumUs : null,
      tdurStatus: !eventCount ? "no-events" : tdurMissing === 0 ? "tdur-complete" : tdurKnown ? "tdur-partial-unavailable" : "tdur-unavailable" };
  });
  const threadGroups = new Map();
  for (const c of calls) {
    const key = `${c.pid}:${c.tid ?? "unknown"}`;
    let row = threadGroups.get(key);
    if (!row) threadGroups.set(key, row = { pid: c.pid, tid: c.tid, threadName: c.threadName,
      eventCount: 0, tdurKnown: 0, tdurMissing: 0, tdurKnownSumUs: 0, byFamily: new Map() });
    row.eventCount++;
    let family = row.byFamily.get(c.family);
    if (!family) row.byFamily.set(c.family, family = { family: c.family, eventCount: 0, tdurKnown: 0, tdurMissing: 0, tdurKnownSumUs: 0 });
    family.eventCount++;
    if (c.tdurUs === null) { row.tdurMissing++; family.tdurMissing++; }
    else { row.tdurKnown++; row.tdurKnownSumUs += c.tdurUs; family.tdurKnown++; family.tdurKnownSumUs += c.tdurUs; }
  }
  const threads = [...threadGroups.values()].sort((a,b) => (a.threadName ?? "").localeCompare(b.threadName ?? "") || (a.tid ?? 0) - (b.tid ?? 0)).map(row => ({
    ...row, byFamily: [...row.byFamily.values()].map(family => ({
      ...family, tdurCompleteSumUs: family.tdurMissing === 0 ? family.tdurKnownSumUs : null,
      tdurStatus: family.tdurMissing === 0 ? "tdur-complete" : family.tdurKnown ? "tdur-partial-unavailable" : "tdur-unavailable"
    })).sort((a,b) => a.family.localeCompare(b.family)),
    tdurCompleteSumUs: row.tdurMissing === 0 ? row.tdurKnownSumUs : null,
    tdurStatus: row.tdurMissing === 0 ? "tdur-complete" : row.tdurKnown ? "tdur-partial-unavailable" : "tdur-unavailable"
  }));
  return { schema: "gl-operation-attribution/1", valid: failures.length === 0, failures, phase,
    verifiedGpuPid: gpuPid, processName: processes.get(gpuPid) ?? null,
    window: { startUs, endUs, durationUs: endUs - startUs },
    coverage: { eventCount: total, minTs, maxEnd, dataLossOccurred: metadata?.dataLossOccurred ?? null,
      traceStatus: failures.some(x => /metadata|data loss|coverage/.test(x)) ? "rejected" : "covered" },
    calls: { eventCount: calls.length }, families, operations, threads,
    interpretation: "Thread names partition trace events, not rendering ownership. CrGpuMain may contain application-issued GL/EGL calls, while CompositorGpuThread reflects compositor work; neither is an exact Pixi/canvas join. Exact Pixi-to-call identifiers are unavailable.",
    note: "Event counts are structural. tdur fields report trace-provided CPU durations only for complete events wholly inside the marker window; no overlap inference is made." };
}
