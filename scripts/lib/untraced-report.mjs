// Ancillary capture summary for a speed cell. The raw BENCH_RESULT and its
// hashed witnesses remain the qualification inputs; perf-report/1 requires a
// Chrome trace and cannot honestly represent this untraced mode.
export function buildUntracedReport({result,accepted,failures,recordingSha256,window,browser}) {
  if (!accepted.length) throw new Error('untraced report needs an accepted presence/geometry repeat');
  return {schema:'couchcoop-untraced-report/1',recordingSha256,window,browser,
    trace:null,traceReason:'capture used no CDP tracing',
    acceptedRepeats:accepted.length,failures,
    repeats:accepted.map((row,index) => ({index,geometry:row.geometry,
      outputWitness:row.presented ?? null})),
    processCpu:result.perRepeat?.map(row => ({processIdentity:row.processIdentity ?? null,
      markerClock:row.pageMarkerClock ?? null})) ?? [],
    benchmarkResult:'benchmark.json'};
}
