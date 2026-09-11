// A Chrome trace marker carries `tts`, the emitting thread's cumulative
// ThreadTicks timestamp. Unlike a selection of RunTask slices, two markers on
// the same thread bound every CPU interval on that thread between them.

const markerLabel = (event) => event?.args?.data?.message ?? event?.args?.message
  ?? event?.args?.data?.name ?? event?.args?.name ?? null;

export function markerThreadCpu(events, phase) {
  if (!["active", "idle", "report"].includes(phase)) throw Error(`invalid CPU marker phase: ${phase}`);
  const [startLabel, endLabel] = phase === "idle"
    ? ["cc-idle-start", "cc-idle-end"] : ["cc-report-start", "cc-report-end"];
  const start = events.filter((event) => markerLabel(event) === startLabel);
  const end = events.filter((event) => markerLabel(event) === endLabel);
  if (start.length !== 1 || end.length !== 1) throw Error(`ambiguous ${phase} CPU markers`);
  const [from] = start;
  const [to] = end;
  if (!Number.isSafeInteger(from.pid) || !Number.isSafeInteger(from.tid) || from.pid <= 0 || from.tid <= 0
    || from.pid !== to.pid || from.tid !== to.tid) {
    throw Error("CPU marker thread identity changed");
  }
  const names = events.filter((event) => event?.ph === "M" && event?.name === "thread_name"
    && event.pid === from.pid && event.tid === from.tid).map((event) => event?.args?.name);
  if (names.length !== 1 || names[0] !== "CrRendererMain") {
    throw Error("CPU marker is not on the CrRendererMain thread");
  }
  if (![from.ts, to.ts, from.tts, to.tts].every(Number.isFinite) || from.ts < 0 || from.tts < 0
    || to.ts <= from.ts || to.tts <= from.tts) throw Error("CPU marker timestamps are missing or non-monotonic");
  const wallUs = to.ts - from.ts;
  const cpuUs = to.tts - from.tts;
  // Both timestamps are microseconds. A tiny rounding tolerance avoids rejecting
  // an otherwise valid trace solely for its clock's quantization.
  if (cpuUs > wallUs + 1) throw Error("CPU marker thread time exceeds wall time");
  return {
    source: "chrome-trace-marker-thread-ticks",
    thread: { pid: from.pid, tid: from.tid, name: names[0] },
    start: { tsUs: from.ts, ttsUs: from.tts },
    end: { tsUs: to.ts, ttsUs: to.tts },
    wallMs: +(wallUs / 1000).toFixed(3),
    cpuMs: +(cpuUs / 1000).toFixed(3),
    cpuPct: +((cpuUs / wallUs) * 100).toFixed(3)
  };
}
