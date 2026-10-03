/**
 * A canvas hand pose can expire a local channel when read while its drawn matrix
 * still belongs to the previous committed frame. Score the next commit if it
 * was observed. If that commit was missed, a later persistent mismatch is still
 * a failing committed picture; a later clean picture cannot prove what was missed.
 */
export const RESTING_TOLERANCE_PX = 1.5;

export function classifyRestCommit(initial, current) {
  if (current.stage !== initial.stage || current.stage !== "canvas")
    return { status: "fail", reason: "renderer changed during rest fence" };
  if (!Number.isInteger(initial.presentEpoch) || !Number.isInteger(current.presentEpoch))
    return { status: "fail", reason: "committed frame identity disappeared" };
  if (initial.rendererInstance == null || current.rendererInstance !== initial.rendererInstance)
    return { status: "fail", reason: "renderer instance changed during rest fence" };
  if (current.live)
    return { status: "fail", reason: "a new hand channel started during rest fence" };
  if (!current.gameStable)
    return { status: "fail", reason: "game hand pose changed during rest fence" };
  if (current.presentEpoch < initial.presentEpoch)
    return { status: "fail", reason: "committed frame identity went backwards" };
  if (current.presentEpoch > initial.presentEpoch + 1)
    return (current.mismatchPx ?? 0) > RESTING_TOLERANCE_PX
      ? { status: "score", first: initial, committed: current }
      : { status: "fail", reason: "the first newer committed frame was missed" };
  return current.presentEpoch === initial.presentEpoch
    ? current.deadlinePassed
      ? { status: "fail", reason: "no newer committed frame arrived before the rest fence deadline" }
      : { status: "wait" }
    : { status: "score", first: initial, committed: current };
}

/** Accept a late producer pose only when it moves under a still-drawn, unchanged hand. */
export function classifyProducerCatchup(initial, current) {
  if (current.stage !== "canvas" || current.rendererInstance !== initial.rendererInstance ||
      current.live || current.presentEpoch < initial.presentEpoch ||
      current.spreadFactor !== initial.spreadFactor || current.rows.length !== initial.rows.length)
    return { status: "stop", reason: "hand or renderer changed" };
  let gameMoved = false;
  for (let i = 0; i < initial.rows.length; i++) {
    const before = initial.rows[i], after = current.rows[i];
    if (before.id !== after.id || before.inFan !== after.inFan || before.zIndex !== after.zIndex ||
        before.fieldMode !== after.fieldMode)
      return { status: "stop", reason: "hand layout changed" };
    if (before.distPx <= RESTING_TOLERANCE_PX) continue;
    if (Math.hypot(before.drawnX - after.drawnX, before.drawnY - after.drawnY) > 0.5 ||
        Math.abs(before.raiseDy - after.raiseDy) > 0.5)
      return { status: "stop", reason: "drawn pose moved before the game caught up" };
    if (Math.hypot(before.gameX - after.gameX, before.gameY - after.gameY) > RESTING_TOLERANCE_PX)
      gameMoved = true;
  }
  if (current.presentEpoch > initial.presentEpoch && gameMoved &&
      current.mismatchPx <= RESTING_TOLERANCE_PX)
    return { status: "adopt" };
  return { status: "wait" };
}
