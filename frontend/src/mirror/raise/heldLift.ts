// THE HELD-CARD LIFT (and the tooltip that rides it) — one policy, for both stage backends.
//
// A cosmetic touch-only lift of the card this client's finger is holding: a client-side translate composed with
// the node's own pose, never sent to the game, so the targeting-arrow tip and the drop target stay exactly at the
// finger. The decision below was RESTATED in the canvas backend when that stage was built, which is how the two
// ended up with different `?cardLift=` behaviour — the DOM read the query override and the canvas hardcoded the
// default. It is decided here now, and each backend only applies it.

import { playZoneThreshold } from "@spirectl/presentation/render";

import {
  HELD_CARD_DRAG_LIFT_PX,
  HELD_CARD_PEEK_LIFT_PX,
  HELD_LIFT_HYSTERESIS_PX
} from "@/mirror/raise/constants";
import { MIRROR_DESIGN_HEIGHT } from "@/mirror/sceneTree";

/** How the finger is holding the card. A drag follows the finger; a peek is a long-press that focuses the card. */
export type HeldMode = "drag" | "peek";

/** The latched half of the gesture — owned by the caller, threaded through {@link decideHeldLift}. */
export interface HeldLiftState {
  /** Is the card currently drawn lifted? */
  lifted: boolean;
  /** Has the finger crossed UP into the play zone at least once during this drag? */
  enteredPlayZone: boolean;
}

/** Everything the decision reads that is not latched. */
export interface HeldLiftInput extends HeldLiftState {
  mode: HeldMode;
  /** Is a targeting arrow visible — the game aiming something? */
  targeting: boolean;
  /** The finger's CURRENT design-space y (== the game mouse y). */
  fingerY: number;
  /** The design-space y the drag started at, which tightens the play-zone line. Null = never grabbed. */
  dragStartY: number | null;
}

/**
 * The lift height for the current gesture, 0 when nothing is lifted.
 *
 * A peeked card has already been raised by the focus itself, so it uses the smaller peek lift; a drag isn't
 * focused, so it uses the bigger drag lift to clear the fingertip.
 */
export function heldLiftPx(held: boolean, mode: HeldMode, lifted: boolean): number {
  if (!held || !lifted) {
    return 0;
  }
  return mode === "peek" ? HELD_CARD_PEEK_LIFT_PX : HELD_CARD_DRAG_LIFT_PX;
}

/**
 * Decide the held card's lift from the current finger position, the gesture mode, and whether the game is aiming.
 *
 * PEEK lifts UNCONDITIONALLY (a focused card pops up on its own, so the still finger no longer sits over it).
 * TARGETING always drops a drag, so the arrow tip reads at the finger.
 * DRAG lifts only while the card is being PLAYED — the finger is above the play-zone line (see
 * `playZoneThreshold`): lifted straight off the pickup, latched once it crosses up into the zone, then tracking
 * the line so dragging back to the hand DROPS it (the card settles back to rest) and a card that isn't being
 * played is never lifted. The lift compare itself is HYSTERETIC (see `HELD_LIFT_HYSTERESIS_PX`): while
 * lifted, the drop line sits a dead-band lower, so a finger riding the line can't strobe the lift. The entry latch
 * stays on the raw threshold.
 */
export function decideHeldLift(input: HeldLiftInput): HeldLiftState {
  if (input.mode === "peek") {
    return { lifted: true, enteredPlayZone: input.enteredPlayZone };
  }
  if (input.targeting) {
    return { lifted: false, enteredPlayZone: input.enteredPlayZone };
  }
  const threshold = playZoneThreshold(MIRROR_DESIGN_HEIGHT, input.dragStartY);
  const enteredPlayZone = input.enteredPlayZone || input.fingerY < threshold;
  const above = input.fingerY < threshold + (input.lifted ? HELD_LIFT_HYSTERESIS_PX : 0);
  return { lifted: !enteredPlayZone || above, enteredPlayZone };
}
