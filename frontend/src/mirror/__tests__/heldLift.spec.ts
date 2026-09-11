// THE HELD-CARD LIFT'S DECISION — one policy, now with one test.
//
// It used to be transcribed into both stage backends ("`mirrorRenderer.applyHeldLift`, restated over the
// cosmetic-offset channel", said the canvas copy), and the copies had already drifted: the DOM read `?cardLift=`
// and the canvas hardcoded the default. Both call `decideHeldLift` now, so the rules are asserted here once
// instead of twice through two renderers.

import { describe, expect, it } from "vitest";

import { HELD_CARD_DRAG_LIFT_PX, HELD_CARD_PEEK_LIFT_PX } from "@/mirror/raise/constants";
import { decideHeldLift, heldLiftPx, type HeldLiftInput } from "@/mirror/raise/heldLift";

/** A drag that has just picked the card up at the bottom of the screen, nothing aimed, nothing latched. */
const PICKUP: HeldLiftInput = {
  mode: "drag",
  targeting: false,
  fingerY: 1000,
  dragStartY: 1000,
  lifted: false,
  enteredPlayZone: false
};

/** The play-zone line for a grab at y=1000 — above it the game considers the card being PLAYED. */
function above(y: number): HeldLiftInput {
  return { ...PICKUP, fingerY: y };
}

describe("held-card lift — the decision", () => {
  it("lifts a PEEK unconditionally: the game has focused the card out from under the still finger", () => {
    expect(decideHeldLift({ ...PICKUP, mode: "peek" }).lifted).toBe(true);
    // …even while the game is aiming something, which is the one thing that drops a DRAG.
    expect(decideHeldLift({ ...PICKUP, mode: "peek", targeting: true }).lifted).toBe(true);
  });

  it("drops a DRAG the moment a targeting arrow is up, so the arrow tip reads at the finger", () => {
    const aiming = decideHeldLift({ ...above(300), lifted: true, enteredPlayZone: true, targeting: true });
    expect(aiming.lifted).toBe(false);
    // The play-zone latch is not cleared by aiming — releasing the arrow returns the card to the lifted state.
    expect(aiming.enteredPlayZone).toBe(true);
  });

  it("lifts straight off the pickup, before the finger has entered the play zone", () => {
    const held = decideHeldLift(PICKUP);
    expect(held.lifted).toBe(true);
    expect(held.enteredPlayZone).toBe(false);
  });

  it("latches on entry and then TRACKS the line — a drag back to the hand drops the lift", () => {
    const entered = decideHeldLift(above(200));
    expect(entered).toEqual({ lifted: true, enteredPlayZone: true });
    // …and back down to the pickup height, which is below the line by a mile.
    expect(decideHeldLift({ ...above(1000), lifted: true, enteredPlayZone: true }).lifted).toBe(false);
  });

  it("holds the lift through the dead-band, so a finger resting ON the line cannot strobe it", () => {
    // A y just below the line: lifted it stays lifted (hysteresis), unlifted it stays down (raw threshold).
    // `playZoneThreshold(1080, 1000)` is 900 — the 0.75 base line, tightened to the grab — and the dead-band is 40.
    const lineIsh = 905;
    expect(decideHeldLift({ ...above(lineIsh), lifted: true, enteredPlayZone: true }).lifted).toBe(true);
    expect(decideHeldLift({ ...above(lineIsh), lifted: false, enteredPlayZone: true }).lifted).toBe(false);
  });
});

describe("held-card lift — the height", () => {
  it("is the DRAG height for a drag and the smaller PEEK height for a peek", () => {
    expect(heldLiftPx(true, "drag", true)).toBe(HELD_CARD_DRAG_LIFT_PX);
    expect(heldLiftPx(true, "peek", true)).toBe(HELD_CARD_PEEK_LIFT_PX);
  });

  it("is 0 with nothing held, or held but not lifted", () => {
    expect(heldLiftPx(false, "drag", true)).toBe(0);
    expect(heldLiftPx(true, "drag", false)).toBe(0);
  });
});
