// A final-frame witness is valid only when the requested replay clock has
// completed on the final delivered scene. It is collected after timed markers.
export function validatePinnedReplayShot(proof, requestedClockMs) {
  const failure = (reason) => ({ valid: false, reason });
  if (!Number.isFinite(requestedClockMs) || requestedClockMs < 0) return failure('invalid requested clock');
  if (!proof?.replay?.done || !Number.isInteger(proof.replay.index) ||
      proof.replay.index !== proof.replay.count) return failure('recording was not fully delivered');
  if (proof.renderer?.ready !== true || proof.renderer?.resources?.pending !== 0 ||
      proof.renderer?.resources?.failed !== 0) return failure('renderer resources are not ready');
  const frame = proof.after;
  if (!frame || frame.clock !== requestedClockMs ||
      !Number.isSafeInteger(frame.revision) || frame.revision < 0 ||
      !Number.isSafeInteger(frame.presentEpoch) || frame.presentEpoch < 1)
    return failure('requested clock has no completed frame identity');
  if (proof.before?.presentEpoch != null && frame.presentEpoch <= proof.before.presentEpoch)
    return failure('requested clock did not complete a new frame');
  if (proof.returned?.revision !== frame.revision ||
      proof.returned?.presentEpoch !== frame.presentEpoch ||
      proof.returned?.clock !== frame.clock)
    return failure('clock result differs from published frame');
  if (proof.renderer?.frameIdentity?.revision !== frame.revision ||
      proof.renderer?.frameIdentity?.presentEpoch !== frame.presentEpoch)
    return failure('renderer diagnostics differ from published frame');
  return { valid: true, reason: null };
}
