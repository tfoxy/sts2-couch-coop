// Samples must come from the attributed SurfaceFlinger join in perfetto-frame-timeline.mjs.
export function presentationStats(samples, windowMs) {
  if (!Array.isArray(samples) || samples.length < 3 || !(windowMs > 0)) return null;
  const ordered = [...new Map(samples.map((sample) => [sample.ts, sample])).values()].sort((a, b) => a.ts - b.ts);
  if (ordered.length < 3) return null;
  const gaps = ordered.slice(1).map((sample, index) => (sample.ts - ordered[index].ts) / 1000).sort((a, b) => a - b);
  const percentile = (p) => gaps[Math.min(gaps.length - 1, Math.ceil(p * gaps.length) - 1)];
  return {
    count: ordered.length,
    fps: +(ordered.length / (windowMs / 1000)).toFixed(1),
    gapP50Ms: +percentile(0.5).toFixed(2),
    gapP95Ms: +percentile(0.95).toFixed(2),
    gapMaxMs: +gaps.at(-1).toFixed(2),
    // Retain an explicitly audited trace defect in the report; absence means no
    // health waiver was used for these samples.
    anomalyProvenance: samples.anomalyProvenance ?? null,
    provenance: {
      source: ordered[0].source,
      surface: ordered[0].surface,
      attributionKey: ordered[0].attributionKey,
      eventNames: [...new Set(ordered.map((sample) => sample.eventName))]
    }
  };
}
