export function replayDiagnosticClock(args) {
  if (args.parityCapture && (args.activeWindowWitness || args.activeVisualReferenceOut || args.startupObservationOut)) {
    throw new Error("active visual/measured replay cannot use --parity-capture diagnostic clock");
  }
  return !!args.parityCapture;
}

export function startupTimingQueryError(args) {
  if (!args.startupObservationOut) return null;
  // buildPageQuery applies --query, then the URL's own query takes precedence.
  // Only these values are rejected: disabled spellings remain available for a
  // receipt that explicitly proves the debug pause was not requested.
  const effective = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(args.query ?? "")) effective.set(key, value);
  for (const [key, value] of new URL(args.url).searchParams) effective.set(key, value);
  const value = effective.get("rustDebug");
  return ["1", "true", "on", "yes"].includes(value?.trim().toLowerCase())
    ? "--startup-observation-out cannot use rustDebug: it adds a 10-second readiness wait after navigation"
    : null;
}
