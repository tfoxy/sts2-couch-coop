// CDP profiles are useful for JS call identity even when chunk timing is invalid.
// Do not convert samples to function milliseconds unless every delta is sane.
export function profileTimingHealth(profile) {
  const samples = profile?.samples;
  const deltas = profile?.timeDeltas;
  const negativeDeltas = Array.isArray(deltas) ? deltas.filter(x => !Number.isFinite(x) || x < 0).length : null;
  const matched = Array.isArray(samples) && Array.isArray(deltas) && samples.length === deltas.length;
  return {
    sampleCount: Array.isArray(samples) ? samples.length : null,
    deltaCount: Array.isArray(deltas) ? deltas.length : null,
    negativeDeltas,
    timingShapeValid: matched && negativeDeltas === 0 && Number.isFinite(profile.startTime)
      && Number.isFinite(profile.endTime) && profile.endTime > profile.startTime,
    attribution: "unweighted samples only; duration requires independent clock validation",
  };
}

export function alignProfileSamples(profile, markers) {
  const timing = profileTimingHealth(profile);
  const start = markers?.start, end = markers?.end;
  if (Array.isArray(profile?.samples) && Number.isFinite(profile.startTime)
    && Number.isFinite(profile.endTime) && Number.isFinite(start) && Number.isFinite(end)
    && start <= profile.startTime && profile.endTime <= end && end > start) {
    return { valid: true, sampleCount: profile.samples.length, unit: "unweighted JS samples",
      basis: "whole profile contained inside markers", timingValidated: false,
      profileStartUs: profile.startTime, profileEndUs: profile.endTime,
      markerStartUs: start, markerEndUs: end };
  }
  if (!timing.timingShapeValid || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < profile.startTime || end > profile.endTime || end <= start) {
    return { valid: false, reason: "profile sample clock or trace marker containment unverified", sampleCount: null };
  }
  let at = profile.startTime, sampleCount = 0;
  for (const delta of profile.timeDeltas) {
    at += delta;
    if (at >= start && at <= end) sampleCount++;
  }
  return { valid: true, sampleCount, unit: "unweighted JS samples", markerStartUs: start, markerEndUs: end };
}
