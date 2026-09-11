// Small, dependency-free trace-window contract shared by the replay harness and its unit test. Keeping this
// separate from the executable harness lets the test exercise marker selection without launching Chromium.

export const ACTIVE_TRACE_WINDOW = Object.freeze({
  phase: "active",
  startMarker: "cc-report-start",
  endMarker: "cc-report-end"
});

export const IDLE_TRACE_WINDOW = Object.freeze({
  phase: "idle",
  startMarker: "cc-idle-start",
  endMarker: "cc-idle-end"
});

export function traceWindowForOptions(opts) {
  if (!(opts?.trace || opts?.report)) return null;
  // An idle leg's only trace artifact is the quiet interval. Capturing its preceding replay would both make the
  // artifact lie about its scope and reintroduce the phone trace-buffer tail-loss this contract prevents.
  return opts.idle ? IDLE_TRACE_WINDOW : ACTIVE_TRACE_WINDOW;
}

export function traceMarkerLabel(event) {
  return event?.args?.data?.message ?? event?.args?.message ?? event?.args?.data?.name ?? event?.args?.name ?? null;
}

export function markerWindowOrError(events, scope) {
  const start = events.find((event) => traceMarkerLabel(event) === scope.startMarker);
  const end = events.find((event) => traceMarkerLabel(event) === scope.endMarker);
  if (!start || !end) {
    return {
      error: `trace ${scope.phase} markers missing (${start ? scope.endMarker : scope.startMarker} not in the trace)`
    };
  }
  if (typeof start.ts !== "number" || typeof end.ts !== "number" || end.ts <= start.ts) {
    return { error: `invalid trace ${scope.phase} marker interval` };
  }
  return { start, end, windowMs: (end.ts - start.ts) / 1000 };
}
