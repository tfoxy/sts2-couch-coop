import { describe, expect, it } from "vitest";

import {
  claimRaiseStamp,
  deferRaisePoint,
  pointInPlacedRect,
  pointWithinPlacedRectMargin,
  remapRaiseInverse,
  settleDeferredRaisePoint,
  type RaiseInputStamp
} from "@/mirror/raiseInverse";
import type { Affine } from "@/mirror/affine";
import { pushOutOfNearMiss, resetNearMissMemory } from "@/mirror/pointerMap";

// A hand card's hit box is 300x422 centred on its (zero-size) holder, drawn at the holder's own scale/rotation.
const CARD_W = 300;
const CARD_H = 422;

// The placement of a fan card: the holder sits at (cx, cy) in game space, rotated `deg`, scaled `k`; the hit box's
// local origin is the holder's top-left corner, i.e. (-150, -211) before the rotation.
function cardStamp(cx: number, cy: number, deg: number, k: number, dy: number, spreadDx = 0): RaiseInputStamp {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r) * k;
  const sin = Math.sin(r) * k;
  const transform: Affine = [cos, sin, -sin, cos, cx, cy];
  return {
    transform,
    localRect: { x: -CARD_W / 2, y: -CARD_H / 2, width: CARD_W, height: CARD_H },
    spreadDx,
    dy
  };
}

describe("raiseInverse — the vertical input inverse for cosmetically moved surfaces", () => {
  it("is identity with no stamps (the state whenever the mode is off / the hand is down)", () => {
    expect(remapRaiseInverse(700, 900, [])).toEqual({ x: 700, y: 900 });
  });

  it("maps a point on a RAISED card back down onto the card the game actually has there", () => {
    // The centre card of a resting fan: game centre (960, 1030), drawn 119px higher.
    const stamp = cardStamp(960, 1030, 0, 0.8, -119);
    // A finger on the drawn card's centre.
    expect(remapRaiseInverse(960, 1030 - 119, [stamp])).toEqual({ x: 960, y: 1030 });
    // …and a little above it, still well inside the viewport once un-mapped.
    expect(remapRaiseInverse(960, 800, [stamp]).y).toBeCloseTo(919, 6);
  });

  it("leaves a point that is on NO moved surface exactly where it was", () => {
    const stamp = cardStamp(960, 1030, 0, 0.8, -119);
    // Well above the raised card (mid-board, where the creatures are).
    expect(remapRaiseInverse(960, 500, [stamp])).toEqual({ x: 960, y: 500 });
    // …and beside it, at the same height (the draw pile's corner of the HUD).
    expect(remapRaiseInverse(120, 1020, [stamp])).toEqual({ x: 120, y: 1020 });
  });

  it("uses ORIENTED boxes: a tilted fan card claims only its real face, not its bounding box", () => {
    // The outermost card of a 7-card hand: game centre (1494, 1098), 9 degrees, scale 0.8, raised 119. Its
    // axis-aligned bounding box spans x 1349..1639, y 793..1164 — but the card is rotated, so a point near a
    // CORNER of that box is not on the card at all. An AABB test would claim it and send the tap 119px down into
    // whatever the game has there, which in this corner of the board is the End Turn cluster.
    const stamp = cardStamp(1494, 1098, 9, 0.8, -119);
    const aabbCorner = { x: 1360, y: 800 };
    expect(claimRaiseStamp(aabbCorner.x, aabbCorner.y, [stamp])).toBeNull();
    expect(remapRaiseInverse(aabbCorner.x, aabbCorner.y, [stamp])).toEqual(aabbCorner);
    // Sanity: the same card DOES claim a point genuinely on its drawn face.
    expect(claimRaiseStamp(1494, 1098 - 119, [stamp])).not.toBeNull();
  });

  it("picks the TOPMOST stamp when raised cards overlap (paint order, topmost last)", () => {
    const under = cardStamp(900, 1030, 0, 0.8, -119);
    const over = cardStamp(1000, 1030, 0, 0.8, -60); // a different lift, so the answers are distinguishable
    // A point inside both drawn faces.
    const claimed = claimRaiseStamp(950, 950, [under, over]);
    expect(claimed).toBe(over);
    expect(remapRaiseInverse(950, 950, [under, over]).y).toBe(950 + 60);
  });

  it("refuses a stamp the RAW pointer was not over on a widened stage (the false-halo guard)", () => {
    // A card shifted +200px right by the wide-screen re-layout. The game point resolved through a uniform squeeze
    // can land on its GAME box while the pointer was 200px away on screen.
    const stamp = cardStamp(960, 1030, 0, 0.8, -119, 200);
    const gameY = 1030 - 119;
    // Raw pointer over the card as DRAWN (game x + spreadDx) → claimed.
    expect(claimRaiseStamp(960, gameY, [stamp], { x: 1160, y: gameY })).toBe(stamp);
    // Raw pointer where nothing is drawn → refused, and the coordinate is left alone.
    expect(claimRaiseStamp(960, gameY, [stamp], { x: 700, y: gameY })).toBeNull();
    expect(remapRaiseInverse(960, gameY, [stamp], { x: 700, y: gameY })).toEqual({ x: 960, y: gameY });
  });

  it("never moves X — the raise is vertical only", () => {
    const stamp = cardStamp(960, 1030, 12, 0.8, -119);
    expect(remapRaiseInverse(1000, 1030 - 119, [stamp]).x).toBe(1000);
  });
});

describe("raiseInverse — the out-of-bounds clamp", () => {
  // The two right-hand cards of a resting 5-card fan (container origin (960, 1080); the game's own fan table), both
  // raised. Card 4 is the outermost and paints on top of card 3.
  const CARD_3 = cardStamp(1130, 1050, 4, 0.8, -119);
  const CARD_4 = cardStamp(1300, 1090, 8, 0.8, -119);
  const MAX_Y = 1078; // MIRROR_DESIGN_HEIGHT - 2

  it("slides a tap on the REVEALED band back inside the viewport, still on the same card", () => {
    // The whole point of the mode: the band this tap is in is drawn 119px up from a game position BELOW the
    // viewport floor, so the raw inverse would send the game a coordinate it hit-tests as nothing — the tap
    // reaches the UI (a second one plays the card) but the card never focuses.
    const drawn = { x: 1170, y: 1075 };
    expect(pointInPlacedRect(CARD_4.transform, CARD_4.localRect, drawn.x, drawn.y, 0, CARD_4.dy)).toBe(true);
    expect(drawn.y - CARD_4.dy).toBeGreaterThan(MAX_Y); // …and un-mapping it alone lands out of bounds

    const out = remapRaiseInverse(drawn.x, drawn.y, [CARD_3, CARD_4]);
    expect(out.y).toBe(MAX_Y);
    expect(pointInPlacedRect(CARD_4.transform, CARD_4.localRect, out.x, out.y)).toBe(true);
  });

  it("slides along the CARD'S OWN AXIS — a straight-Y clamp would focus the neighbour", () => {
    const drawn = { x: 1170, y: 1075 };
    const out = remapRaiseInverse(drawn.x, drawn.y, [CARD_3, CARD_4]);
    // The card is fanned 8 degrees, so reaching the floor means moving sideways too.
    expect(out.x).toBeCloseTo(1186.3, 1);
    // What the naive clamp would have done: off card 4 entirely, and onto card 3 — the wrong card focuses.
    expect(pointInPlacedRect(CARD_4.transform, CARD_4.localRect, drawn.x, MAX_Y)).toBe(false);
    expect(pointInPlacedRect(CARD_3.transform, CARD_3.localRect, drawn.x, MAX_Y)).toBe(true);
  });

  it("leaves an in-bounds tap exactly where the plain inverse put it", () => {
    // Same card, a finger higher up its face: nothing about the clamp may touch this.
    const drawn = { x: 1290, y: 940 };
    const out = remapRaiseInverse(drawn.x, drawn.y, [CARD_3, CARD_4]);
    expect(out).toEqual({ x: drawn.x, y: 940 + 119 });
    expect(out.y).toBeLessThan(MAX_Y);
  });

  it("falls back to a plain vertical clamp on a degenerate placement instead of running off the screen", () => {
    // A surface turned on its side has a local +Y that is very nearly horizontal: sliding along it to reach the
    // floor would run away across the screen (and off it) instead of moving a card-length.
    const sideways = cardStamp(960, 1150, 89, 1, -119);
    const out = remapRaiseInverse(960, 1150 - 119, [sideways]);
    expect(out).toEqual({ x: 960, y: MAX_Y });
  });
});

describe("raiseInverse — the FOCUSED card, published unmoved", () => {
  // The game pulls a focused holder up to its own focus pose (local y −209, scale 1, angle 0), which is exactly
  // where the client already draws it — so the renderer publishes it with `dy: 0` (mirrorRenderer.raiseInputStamps).
  // Its neighbours stay in the raised fan and OVERLAP it, and they are the only claimants if it is absent.
  const focused = cardStamp(960, 871, 0, 1, 0); // box y 660..1082 — the focus pose, touching the viewport floor
  const neighbour = cardStamp(1130, 1050, 4, 0.8, -119);

  it("claims its own face and hands the point straight back", () => {
    // Paint order: the focused card is topmost (published last), so it wins over the neighbour that overlaps it.
    const point = { x: 1035, y: 1000 };
    expect(pointInPlacedRect(neighbour.transform, neighbour.localRect, point.x, point.y, 0, neighbour.dy)).toBe(true);
    expect(claimRaiseStamp(point.x, point.y, [neighbour, focused])).toBe(focused);
    expect(remapRaiseInverse(point.x, point.y, [neighbour, focused])).toEqual(point);
  });

  it("is what stops the neighbour sending a point on the focused card 119px down onto another one", () => {
    // Without the focused card in the list this is what happened: the neighbour claims and the point leaves its face.
    const point = { x: 1035, y: 1000 };
    const out = remapRaiseInverse(point.x, point.y, [neighbour]);
    expect(out.y).toBe(1078); // …clamped, because 1000 + 119 is past the viewport floor
    expect(pointInPlacedRect(focused.transform, focused.localRect, out.x, out.y)).toBe(true);
    expect(out).not.toEqual(point);
  });
});

describe("raiseInverse — surviving the game's own arbitration on a SPREAD fan", () => {
  // Two neighbours of a widened-stage fan. Their GAME boxes overlap as the game laid them out; on screen the
  // wide-screen re-layout pulls them apart by DIFFERENT amounts (spreadDx 82 vs 105), so the drawn overlap is
  // narrower than the game's. In the seam between the two the pointer is plainly on the left card while the
  // un-mapped point lands where the RIGHT card is on top in the game.
  const LEFT = cardStamp(595, 1030, -4, 0.8, -119, 82);
  const RIGHT = cardStamp(771, 1000, -2, 0.8, -119, 105); // painted after ⇒ topmost

  it("slides along the claimed card until the point hit-tests back to it", () => {
    // A point in the seam: the right card's own rendered box does not contain the pointer (it was pulled 23px
    // further right than the left one), so the false-halo guard refuses it and the LEFT card claims — but the game
    // still has the right card on top of the plain un-mapped coordinate.
    const drawn = { x: 665, y: 940 };
    const raw = { x: drawn.x + LEFT.spreadDx, y: drawn.y };
    expect(claimRaiseStamp(drawn.x, drawn.y, [LEFT, RIGHT], raw)).toBe(LEFT);
    expect(pointInPlacedRect(RIGHT.transform, RIGHT.localRect, drawn.x, drawn.y + 119)).toBe(true);

    const out = remapRaiseInverse(drawn.x, drawn.y, [LEFT, RIGHT], raw);
    // The lift is still un-mapped exactly; the move is along the CARD's local X, which on a card fanned 4 degrees
    // carries a fraction of a pixel of Y with it (the point keeps its height ON THE CARD, which is the invariant).
    expect(Math.abs(out.y - (drawn.y + 119))).toBeLessThan(2);
    expect(out.x).toBeLessThan(drawn.x); // …and it moved away from the neighbour
    // The sent point is on the left card and NOT under the right one — so the game focuses the card the player sees.
    expect(pointInPlacedRect(LEFT.transform, LEFT.localRect, out.x, out.y)).toBe(true);
    expect(pointInPlacedRect(RIGHT.transform, RIGHT.localRect, out.x, out.y)).toBe(false);
  });

  it("leaves a point the game already arbitrates correctly exactly where the plain inverse put it", () => {
    // Well inside the left card, clear of the seam: the search must not run at all.
    const drawn = { x: 560, y: 900 };
    const raw = { x: drawn.x + LEFT.spreadDx, y: drawn.y };
    expect(remapRaiseInverse(drawn.x, drawn.y, [LEFT, RIGHT], raw)).toEqual({ x: 560, y: 1019 });
  });

  it("reaches the DOWNHILL side of a tilted card by riding its local Y back inside the viewport", () => {
    // The leftmost card of the fan is tilted the other way and is BOTTOM-most in paint order, so the only side that
    // ever clears its neighbour is the one that also runs off the bottom of the screen. A search that simply
    // discarded out-of-bounds candidates could never move that way, and every tap in the clamped band at that seam
    // focused the neighbour.
    const outer = cardStamp(426, 1090, -8, 0.8, -119, 58);
    const inner = cardStamp(595, 1030, -4, 0.8, -119, 82); // painted after ⇒ topmost
    const drawn = { x: 495, y: 990 };
    const raw = { x: drawn.x + outer.spreadDx, y: drawn.y };
    expect(claimRaiseStamp(drawn.x, drawn.y, [outer, inner], raw)).toBe(outer);

    const out = remapRaiseInverse(drawn.x, drawn.y, [outer, inner], raw);
    expect(out.y).toBeLessThanOrEqual(1078); // still on screen…
    expect(pointInPlacedRect(outer.transform, outer.localRect, out.x, out.y)).toBe(true);
    expect(pointInPlacedRect(inner.transform, inner.localRect, out.x, out.y)).toBe(false); // …and the outer card wins
  });

  it("never runs at 16:9, where the drawn order IS the game order", () => {
    // Same two cards with no spread: the drawn boxes are the game boxes translated by one shared lift, so whatever
    // the claim picks is what the game picks, and every answer is the plain un-map.
    const l = cardStamp(595, 1030, -4, 0.8, -119);
    const r = cardStamp(771, 1000, -2, 0.8, -119);
    for (const x of [560, 620, 660, 690, 720]) {
      const claimed = claimRaiseStamp(x, 900, [l, r]);
      const out = remapRaiseInverse(x, 900, [l, r]);
      expect(claimed).not.toBeNull();
      expect(out).toEqual({ x, y: 1019 });
    }
  });
});

describe("raiseInverse — 5→4 raised-hand visual ownership", () => {
  it("keeps a focused fourth survivor's visual ownership at dy 0 and settles X onto its native hitbox", () => {
    // The widened four-card focus pose has no cosmetic vertical lift: the game and renderer agree on Y already.
    // Its painted fourth-holder footprint still reaches this raw pixel before the wide-stage X canonicalizer, while
    // the native oriented hitbox does not. Discarding the provisional claim here used to send the pressed point to
    // the overlapping neighbour instead of the card the player grabbed.
    const fourth: RaiseInputStamp = {
      // Focus itself straightens the fourth holder. Keep this widened-stage stamp deliberately axis-aligned so
      // this regression can say precisely that only X moves during the native-hitbox arbitration.
      transform: [1, 0, 0, 1, 1100, 800],
      localRect: { x: 0, y: 0, width: 300, height: 422 },
      spreadDx: 200,
      dy: 0,
      ownerId: "holder-fourth",
    };
    const raw = { x: 1405, y: 1000 };
    expect(claimRaiseStamp(raw.x, raw.y, [fourth], raw)).toBeNull();

    const deferred = deferRaisePoint(raw.x, raw.y, [fourth], raw, { ownerId: "holder-fourth" });
    expect(deferred.claimed).toBe(fourth);
    expect(deferred.requiresVisualProof).toBe(true);
    expect(deferred.y).toBe(raw.y); // focused pose is vertically native

    const settled = settleDeferredRaisePoint(raw.x, deferred.y, deferred, [fourth], { ownerId: "holder-fourth" });
    expect(settled.x).not.toBe(raw.x);
    expect(settled.y).toBe(raw.y);
    expect(pointInPlacedRect(fourth.transform, fourth.localRect, settled.x, settled.y)).toBe(true);
  });

  it("04-32 settles both recorded Defragment focused/resting misses through their proven owner", () => {
    const recorded = [
      {
        raw: { x: 1438.1473, y: 725.4943 },
        transform: [1, 0, 0, 1, 1050, 660] as [number, number, number, number, number, number],
        localRect: { x: 0, y: 0, width: 300, height: 422 },
        spreadDx: 0,
        dy: 0,
        expected: { x: null, y: 725.4943, tolerance: 0 },
      },
      {
        // The recorded resting pose is a genuinely rotated, negative-dy stamp. Its raw point is before the
        // vertical raise inverse; settling must both restore Y and arbitrate X back inside this native OBB.
        raw: { x: 1334.6665, y: 854 },
        transform: [0.79221445, 0.11133849, -0.11133849, 0.79221445, 1104.6603556, 871.1419434] as [number, number, number, number, number, number],
        localRect: { x: 0, y: 0, width: 300, height: 422 },
        spreadDx: 196.7,
        dy: -119,
        expected: { x: 1321.99, y: 970.22, tolerance: 2 },
      },
    ];
    for (const { raw, transform, localRect, spreadDx, dy, expected } of recorded) {
      const defragment: RaiseInputStamp = {
        transform,
        localRect,
        spreadDx,
        dy,
        ownerId: "holder-defragment",
      };
      expect(claimRaiseStamp(raw.x, raw.y, [defragment], raw)).toBeNull();
      const deferred = deferRaisePoint(raw.x, raw.y, [defragment], raw, { ownerId: "holder-defragment" });
      expect(deferred.requiresVisualProof).toBe(true);
      if (dy < 0) expect(deferred.y).toBeGreaterThan(raw.y); // the resting sample takes the vertical inverse
      const settled = settleDeferredRaisePoint(raw.x, deferred.y, deferred, [defragment], { ownerId: "holder-defragment" });
      if (expected.x === null) {
        expect(settled.y).toBeCloseTo(expected.y, 6);
      } else {
        expect(Math.hypot(settled.x - expected.x, settled.y - expected.y)).toBeLessThan(expected.tolerance);
      }
      expect(pointInPlacedRect(defragment.transform, defragment.localRect, settled.x, settled.y)).toBe(true);
    }
  });

  it("settles a canonicalized point onto the fourth card when its CURRENT painted footprint proves ownership", () => {
    // Exact recorded fourth-card pose after the fifth left the fan.  The pre-canonical game candidate is OUTSIDE
    // this OBB (local x≈305.3 > 300); only the renderer's raw painted-owner proof may nominate it provisionally.
    const fourth: RaiseInputStamp = {
      transform: [0.7922144, 0.1113385, -0.1113385, 0.7922144, 1104.6602, 871.1421],
      localRect: { x: -150, y: -211, width: 300, height: 422 },
      spreadDx: 196.7,
      dy: -119,
      ownerId: "holder-fourth",
    };
    const raw = { x: 1261.218, y: 836.4 };
    expect(claimRaiseStamp(raw.x, raw.y, [fourth], raw)).toBeNull();

    const deferred = deferRaisePoint(raw.x, raw.y, [fourth], raw, { ownerId: "holder-fourth" });
    expect(deferred.claimed).toBe(fourth);
    expect(deferred.requiresVisualProof).toBe(true);
    expect(deferred.y).toBeCloseTo(955.4, 3);
    // The horizontal canonicalizer chooses the actual post-near-miss X before raise arbitration runs.
    resetNearMissMemory();
    expect(pushOutOfNearMiss(1261.218, deferred.y, 1261.218, [{
      id: "canonicalizer", transform: [1, 0, 0, 1, 1245, 800], localRect: { x: 0, y: 0, width: 300, height: 300 },
      spreadDx: 200, renderedWidth: 0, raiseDy: 0,
    }], raw.y)).toBeCloseTo(1244.016, 1);
    const settled = settleDeferredRaisePoint(1244.016, deferred.y, deferred, [fourth], { ownerId: "holder-fourth" });
    expect(pointInPlacedRect(fourth.transform, fourth.localRect, settled.x, settled.y)).toBe(true);
  });

  it("does not borrow visual ownership for a neighbour or dead raw halo", () => {
    const fourth = { ...cardStamp(1244, 955, 8, 0.8, -119, 180), ownerId: "holder-fourth" };
    const neighbour = { ...cardStamp(1320, 955, 8, 0.8, -119, 180), ownerId: "holder-neighbour" };
    const raw = { x: 1244, y: 836 };
    const deferred = deferRaisePoint(raw.x, raw.y, [fourth, neighbour], raw, { ownerId: "holder-fourth" });
    expect(deferred.claimed).toBe(fourth);
    // A claim from another rendered card cannot turn this into a raised correction.
    expect(settleDeferredRaisePoint(1252, deferred.y, deferred, [fourth, neighbour], { ownerId: "holder-neighbour" }))
      .toEqual({ x: 1252, y: deferred.y });
    // Nor can the proofless raw halo bypass the existing guard.
    expect(deferRaisePoint(raw.x, raw.y, [fourth], raw).claimed).toBeNull();
  });

  it("keeps a legacy hitbox/raw claim settleable without renderer proof", () => {
    const fourth = { ...cardStamp(1244, 955, 8, 0.8, -119, 0), ownerId: "holder-fourth" };
    const raw = { x: 1244, y: 836 };
    const deferred = deferRaisePoint(raw.x, raw.y, [fourth], raw);
    expect(deferred.claimed).toBe(fourth);
    expect(deferred.requiresVisualProof).toBe(false);
    const settled = settleDeferredRaisePoint(1244, deferred.y, deferred, [fourth]);
    expect(pointInPlacedRect(fourth.transform, fourth.localRect, settled.x, settled.y)).toBe(true);
  });
});

describe("pointInPlacedRect", () => {
  it("keeps visual provenance inside the current hitbox's small art-overhang, never its glow", () => {
    const stamp = cardStamp(960, 900, 0, 1, -119);
    // The 5→4 survivor's provisional point is only about 5 local px beyond the retained box, which is a real
    // card-frame overhang. A glow-like point 76 px out is not a hand footprint and must remain raw.
    expect(pointWithinPlacedRectMargin(stamp.transform, stamp.localRect, 1115.3, 781)).toBe(true);
    expect(pointWithinPlacedRectMargin(stamp.transform, stamp.localRect, 1186, 781)).toBe(false);
  });

  it("handles rotation (a fanned card's corner is outside its own bounding box)", () => {
    const stamp = cardStamp(0, 0, 15, 1, 0);
    // The un-rotated box's top-right corner.
    const cornerX = CARD_W / 2;
    const cornerY = -CARD_H / 2;
    expect(pointInPlacedRect(stamp.transform, stamp.localRect, cornerX, cornerY)).toBe(false);
    expect(pointInPlacedRect(stamp.transform, stamp.localRect, 0, 0)).toBe(true);
  });

  it("shifts the PLACEMENT, not the point, when given an offset", () => {
    const stamp = cardStamp(0, 0, 0, 1, 0);
    const justBelow = CARD_H / 2 + 10;
    expect(pointInPlacedRect(stamp.transform, stamp.localRect, 0, justBelow)).toBe(false);
    // Move the box down by 20 and the same point is inside it.
    expect(pointInPlacedRect(stamp.transform, stamp.localRect, 0, justBelow, 0, 20)).toBe(true);
  });

  it("returns false for a degenerate (zero-scale) placement rather than throwing", () => {
    expect(pointInPlacedRect([0, 0, 0, 0, 0, 0], { x: 0, y: 0, width: 10, height: 10 }, 0, 0)).toBe(false);
  });
});
