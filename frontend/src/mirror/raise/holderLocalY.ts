// WHERE A HAND CARD IS HEADED, IN ITS CONTAINER — one function, both backends.
//
// This is the ONE number the whole focus ramp is a function of (`handRaisePlan.handRaiseRamp`): 0 across the
// resting fan, 1 at the game's focused-holder pose. Get it wrong by a few px and the lift is wrong by a few px on
// every card in the hand; get it wrong about WHICH pose to read and a card rides the full lift while its
// neighbours ride the ramp, then snaps into place at the settle.
//
// IT USED TO BE WRITTEN TWICE — `mirrorRenderer.handHolderLocalY` and `canvas/handRaise.holderLocalY` — with the
// same five legs in the same order and a comment on each saying "leg-for-leg with the other one". That is the
// duplication the hand-landing report is about: two copies of a pose read, in the two backends that are supposed
// to draw the same hand. The legs live here now.
//
// ONE THING REMAINS A BACKEND PORT: WHICH endpoint counts as live. The DOM keeps it while its CSS channel awaits
// collection, through a pending catch-up, and for its one settle-time hand pass; canvas owns the corresponding
// lifetime inside its tween loop. H10 was fixed in DOM CSS-channel/settle ordering, not by collapsing the ports.
//
// TWO QUESTIONS, SAME LEGS. `holderLocalY` answers where a holder is HEADED — the ramp's input, and the value the
// lift channel eases TO. `holderPaintedLocalY` answers where it IS, which is the value that channel has to ease
// FROM; the whole difference between them is the resting-fan guess, and why a guess is admissible in one and not
// the other is written on the second. Keeping both here is what stops the "current pose" read from re-growing as a
// private leg in the backend that needs it (2026-09-19: the DOM did, and drew cards past their own resting pose).

import { HAND_RAISE_RAMP_START_Y } from "@/mirror/raise/constants";
import { holderInFan } from "@/mirror/raise/handRaisePlan";
import type { MirrorNode } from "@/mirror/sceneTree";

/** The per-backend facts {@link holderLocalY} cannot read off the scene map. */
export interface HolderPoseEnv {
  nodes: ReadonlyMap<string, MirrorNode>;
  /**
   * The composed GLOBAL y of the holder's PARENT, blind to client-side overrides — the DOM walk's
   * `cParentGlobal`, the canvas's `streamedGlobal`. Blind because it is the frame the endpoint itself was lifted
   * into: an ancestor's own running tween is a separate channel, and measuring against it would double-count that
   * ancestor's motion. Null when the walk has not composed one.
   */
  parentGlobalY(parentId: string, holderId: string): number | null;
  /** The GLOBAL y this holder's transform channel is headed for, while that channel is live — see the H10 note. */
  liveEndpointY(holderId: string): number | null;
}

/**
 * The y a holder is currently HEADED FOR IN ITS CONTAINER, or null when it is not a raisable fan card at all.
 *
 * THE ENDPOINT IS CHECKED FIRST, before the streamed transform is even required. A tween-owned holder ships NO
 * transform at all — the producer suppresses it for the tween's whole window — and the case that makes that
 * matter is a play the player cancels: the game reparents the card home and tweens it back into the fan, so for
 * the length of that tween the only thing that says where the card is headed is the endpoint. Reading the absent
 * transform instead leaves that one card riding the full lift while the rest of the hand rides the ramp, and then
 * snaps it into place at the settle — the DOM backend measured ~260ms of exactly that before it read endpoints.
 *
 * Only the Y is read, so the wide-screen spread shift an endpoint carries in its X cannot reach this number.
 */
export function holderLocalY(env: HolderPoseEnv, id: string): number | null {
  const measured = holderPaintedLocalY(env, id);
  if (measured != null) {
    return measured;
  }
  if (!raisableFanHolder(env, id)) {
    // A dragged or selected holder is reparented onto the hand ROOT and keeps the game's pose exactly — that is
    // the point of the reparent — so it is neither raisable nor ramped.
    return null;
  }
  // In the container, tween-owned, and no endpoint has landed yet (a few frames at the start of a return). The
  // resting fan is the honest guess: the pose the ramp exists for — the focus — is a TELEPORT, always streamed.
  return HAND_RAISE_RAMP_START_Y;
}

/**
 * The y a holder is actually BEING DRAWN AT in its container right now — the same legs as {@link holderLocalY},
 * minus the resting-fan guess: null means "nothing on this frame says where this card is", never "it is at rest".
 *
 * WHY THE GUESS IS THE WHOLE DIFFERENCE. The ramp answer is asked two ways. `holderLocalY` asks where a holder is
 * HEADED, and a destination has to be produced for every raisable card, so a suppressed transform falls back to
 * the fan. This asks where the holder IS, and that answer is only ever used to put the lift channel in phase with
 * the pose channel before both of them ease (the DOM's `noteTransformArmPose`). A guess there would step a card's
 * cosmetic lift to a pose it is not at — a snap, drawn, of up to the full lift — so the caller must be told the
 * pose is unknown and leave the channel alone instead.
 */
export function holderPaintedLocalY(env: HolderPoseEnv, id: string): number | null {
  if (!raisableFanHolder(env, id)) {
    return null;
  }
  const node = env.nodes.get(id)!;
  // The frame the endpoint is measured in. The composed global when the backend has one; otherwise the parent's
  // own streamed matrix when the composed value is unavailable.
  const parentGlobalY = env.parentGlobalY(node.parentId!, id);
  const endpointY = env.liveEndpointY(id);
  if (endpointY != null && parentGlobalY != null) {
    return endpointY - parentGlobalY;
  }
  return node.transform == null ? null : node.transform[5];
}

/** Is this id a fan card the mode may ramp at all — in the hand CONTAINER, under a parent the map still has? */
function raisableFanHolder(env: HolderPoseEnv, id: string): boolean {
  const node = env.nodes.get(id);
  if (!node || !holderInFan(env.nodes, id)) {
    return false;
  }
  const parentId = node.parentId;
  return parentId != null && env.nodes.has(parentId);
}
