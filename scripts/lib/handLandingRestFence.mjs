/**
 * A canvas hand pose can expire a local channel when read while its drawn matrix
 * still belongs to the previous committed frame. Give that mismatch exactly one
 * later presentation to resolve, then score whatever that frame actually drew.
 */
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
    return { status: "fail", reason: "the first newer committed frame was missed" };
  return current.presentEpoch === initial.presentEpoch
    ? current.deadlinePassed
      ? { status: "fail", reason: "no newer committed frame arrived before the rest fence deadline" }
      : { status: "wait" }
    : { status: "score", first: initial, committed: current };
}
