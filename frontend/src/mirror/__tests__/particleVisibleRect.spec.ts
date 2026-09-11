import { describe, expect, it } from "vitest";

import type { Affine } from "@/mirror/affine";
import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH, MIRROR_MAX_DESIGN_WIDTH } from "@/mirror/sceneTree";
import { particleVisibleRect, particleVisibleRectAttr } from "@/mirror/particleVisibleRect";

// The stage viewport pulled back into ONE particle node's own local space — the budget gsw clamps its
// travel-derived canvas margin to (see particleVisibleRect.ts). Pure math on the walk's rendered global,
// so this suite is the whole contract: no DOM, no layout, no renderer.

const STAGE = { width: MIRROR_DESIGN_WIDTH, height: MIRROR_DESIGN_HEIGHT };
/** A widened stage at the cap: 2520 x 1080. The height never widens. */
const WIDE_STAGE = { width: MIRROR_MAX_DESIGN_WIDTH, height: MIRROR_DESIGN_HEIGHT };
const SPREAD_F = MIRROR_MAX_DESIGN_WIDTH / MIRROR_DESIGN_WIDTH; // 1.3125

const ORIGIN = { x: 0, y: 0 };

/** A rendered global with an identity basis at (tx, ty) — a mirrored particle node's usual shape. */
function at(tx: number, ty: number): Affine {
  return [1, 0, 0, 1, tx, ty];
}

// The chest's coin burst sits here in design space (`TreasureRoom/GoldExplosion`).
const GOLD_X = 937;
const GOLD_Y = 512;

describe("particleVisibleRect", () => {
  it("a node at the stage's own origin sees the whole stage, starting at its own corner", () => {
    // 1080 is not a multiple of the 16px snap grid, so the height rounds OUT to 1088 — outward being the
    // only direction the rounding is allowed to go (see the snap-grid block below).
    expect(particleVisibleRect(at(0, 0), ORIGIN, STAGE)).toEqual({ x: 0, y: 0, width: 1920, height: 1088 });
  });

  it("the chest's coin burst reports the stage from where the chest stands", () => {
    // The node is at design (937, 512), so in ITS space the stage's top-left corner is up and to the left
    // by exactly that — which is what tells gsw it has ~937px of room to the left of the burst and ~983 to
    // the right, instead of the 1024-per-side PAD_CAP fallback it would take with no rect at all.
    const rect = particleVisibleRect(at(GOLD_X, GOLD_Y), ORIGIN, STAGE);
    // Snapped OUTWARD to the 16px grid: -937 -> -944 and the far edge 983 -> 992 (see RECT_SNAP). The true
    // rect is strictly inside the reported one, which is the only safe direction to round in.
    expect(rect).toEqual({ x: -944, y: -512, width: 1936, height: 1088 });
    expect(rect!.x).toBeLessThanOrEqual(-GOLD_X);
    expect(rect!.x + rect!.width).toBeGreaterThanOrEqual(MIRROR_DESIGN_WIDTH - GOLD_X);
    expect(rect!.y).toBeLessThanOrEqual(-GOLD_Y);
    expect(rect!.y + rect!.height).toBeGreaterThanOrEqual(MIRROR_DESIGN_HEIGHT - GOLD_Y);
  });

  it("serializes as the four numbers gsw's parseLocalVisibleRect splits on", () => {
    expect(particleVisibleRectAttr(particleVisibleRect(at(GOLD_X, GOLD_Y), ORIGIN, STAGE)!)).toBe(
      "-944,-512,1936,1088"
    );
  });

  it("is measured from the node's DRAW BOX origin, not from its transform origin", () => {
    // `nodeStyles`' placementBox bakes the element's matrix at the local-rect origin, so a node whose box
    // starts at local (40, 30) has its element corner 40,30 further along — and the rect has to agree, or
    // the budget is offset from the canvas it is budgeting for.
    const rect = particleVisibleRect(at(100, 100), { x: 40, y: 30 }, STAGE);
    expect(rect).toEqual({ x: -144, y: -144, width: 1936, height: 1104 });
    // …i.e. exactly the rect of a node placed at (140, 130) with a zero draw box.
    expect(rect).toEqual(particleVisibleRect(at(140, 130), ORIGIN, STAGE));
  });

  describe("scale", () => {
    it("a node scaled UP sees proportionally LESS of the stage in its own px", () => {
      // Its local px are 2 design px each, so the 1920x1080 stage is 960x540 of them — and the canvas gsw
      // sizes in those units is CSS-scaled back up by the same transform.
      const rect = particleVisibleRect([2, 0, 0, 2, 0, 0], ORIGIN, STAGE);
      expect(rect).toEqual({ x: 0, y: 0, width: 960, height: 544 }); // 540 snapped up to 544
    });

    it("a node scaled DOWN sees more", () => {
      const rect = particleVisibleRect([0.5, 0, 0, 0.5, 0, 0], ORIGIN, STAGE);
      expect(rect).toEqual({ x: 0, y: 0, width: 3840, height: 2160 });
    });

    it("a MIRRORED (negative-scale) node still reports a positive-size rect", () => {
      // flipH is a real thing on VFX nodes; the corner mapping puts min/max in the other order, and taking
      // the AABB rather than trusting the corner order is what keeps the width positive.
      const rect = particleVisibleRect([-1, 0, 0, 1, 960, 0], ORIGIN, STAGE)!;
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect).toEqual({ x: -960, y: 0, width: 1920, height: 1088 });
    });
  });

  it("a ROTATED node gets the AABB of the rotated viewport — a superset, never a crop", () => {
    // 45 degrees: the stage becomes a diamond in local space, and its bounding box is bigger than the stage
    // on both axes. Generous is the safe way to be wrong here (gsw only ever GROWS a canvas from this).
    const c = Math.SQRT1_2;
    const rect = particleVisibleRect([c, c, -c, c, 0, 0], ORIGIN, STAGE)!;
    expect(rect.width).toBeGreaterThan(MIRROR_DESIGN_WIDTH);
    expect(rect.height).toBeGreaterThan(MIRROR_DESIGN_WIDTH);
    // Every corner of the real viewport is inside the reported rect.
    for (const [vx, vy] of [
      [0, 0],
      [MIRROR_DESIGN_WIDTH, 0],
      [0, MIRROR_DESIGN_HEIGHT],
      [MIRROR_DESIGN_WIDTH, MIRROR_DESIGN_HEIGHT]
    ]) {
      const lx = c * vx + c * vy; // inverse of the rotation above
      const ly = -c * vx + c * vy;
      expect(lx).toBeGreaterThanOrEqual(rect.x);
      expect(lx).toBeLessThanOrEqual(rect.x + rect.width);
      expect(ly).toBeGreaterThanOrEqual(rect.y);
      expect(ly).toBeLessThanOrEqual(rect.y + rect.height);
    }
  });

  describe("widescreen stretch", () => {
    it("reports the WIDENED stage, not the 16:9 one", () => {
      // The height never widens, so only the x extent grows — and a node that sees only 1920 of a 2520-wide
      // stage would have its burst clipped 600px short of the right edge.
      const rect = particleVisibleRect(at(0, 0), ORIGIN, WIDE_STAGE)!;
      expect(rect.width).toBe(2528); // 2520 snapped up
      expect(rect.height).toBe(1088);
      expect(rect.width).toBeGreaterThanOrEqual(MIRROR_MAX_DESIGN_WIDTH);
    });

    it("and the node's OWN spread shift is already in the global it is given", () => {
      // On a widened stage the coin burst is a positional claimer: it renders at `937·F`, not at 937. The
      // renderer hands this function `gNodeStretched`, so the rect is measured from where the node really
      // is — measuring from the unshifted global would report the stage as ~293px further left than it is
      // and clip the burst's right side by that much.
      const rendered = GOLD_X * SPREAD_F; // 1229.8125
      const shifted = particleVisibleRect(at(rendered, GOLD_Y), ORIGIN, WIDE_STAGE)!;
      const unshifted = particleVisibleRect(at(GOLD_X, GOLD_Y), ORIGIN, WIDE_STAGE)!;
      expect(shifted.x).toBe(-1232);
      expect(shifted.width).toBe(2528);
      expect(shifted.x + shifted.width).toBe(1296); // room to the RIGHT: 2520 − 1229.8, snapped up
      // The unshifted global would have claimed ~293px more room to the right than the node actually has,
      // and that much less to its left — i.e. a budget for a place the burst is not.
      expect(unshifted.x + unshifted.width - (shifted.x + shifted.width)).toBeCloseTo(
        GOLD_X * (SPREAD_F - 1),
        -2
      );
    });
  });

  describe("the snap grid", () => {
    it("always CONTAINS the true rect (it can only ever grant room)", () => {
      // Swept over positions that land on every residue of the grid, at both stage widths.
      for (const viewport of [STAGE, WIDE_STAGE]) {
        for (let tx = 0; tx < 64; tx += 3) {
          for (const ty of [0, 7, 512, 1013]) {
            const rect = particleVisibleRect(at(tx, ty), ORIGIN, viewport)!;
            expect(rect.x).toBeLessThanOrEqual(-tx);
            expect(rect.y).toBeLessThanOrEqual(-ty);
            expect(rect.x + rect.width).toBeGreaterThanOrEqual(viewport.width - tx);
            expect(rect.y + rect.height).toBeGreaterThanOrEqual(viewport.height - ty);
          }
        }
      }
    });

    it("holds the attribute STILL while an emitter drifts inside one grid cell", () => {
      // The whole point of the snap: gsw re-reads this per reconcile and re-keys the moved system's frozen
      // frame, so an unquantized rect would re-render every emitter on a scrolling map on every frame.
      // (Any quantizer moves on the first sub-pixel when it starts exactly on a cell boundary; what it
      // guarantees is O(travel/step) restatements, not zero.)
      const home = particleVisibleRectAttr(particleVisibleRect(at(648, 400), ORIGIN, STAGE)!);
      expect(home).toBe("-656,-400,1936,1088");
      for (const drift of [0.5, 1, 4, 7.9]) {
        expect(particleVisibleRectAttr(particleVisibleRect(at(648 + drift, 400), ORIGIN, STAGE)!)).toBe(home);
      }
      // …and does move once the drift is a real one.
      expect(particleVisibleRectAttr(particleVisibleRect(at(648 + 32, 400), ORIGIN, STAGE)!)).not.toBe(home);
    });
  });

  describe("says nothing rather than something wrong", () => {
    it("for a singular transform (zero scale)", () => {
      expect(particleVisibleRect([0, 0, 0, 0, 100, 100], ORIGIN, STAGE)).toBeNull();
      expect(particleVisibleRect([1, 0, 0, 0, 100, 100], ORIGIN, STAGE)).toBeNull();
    });

    it("for a degenerate viewport", () => {
      expect(particleVisibleRect(at(0, 0), ORIGIN, { width: 0, height: 1080 })).toBeNull();
      expect(particleVisibleRect(at(0, 0), ORIGIN, { width: 1920, height: -1 })).toBeNull();
    });

    it("for a non-finite transform", () => {
      expect(particleVisibleRect(at(Number.NaN, 0), ORIGIN, STAGE)).toBeNull();
      expect(particleVisibleRect(at(0, Number.POSITIVE_INFINITY), ORIGIN, STAGE)).toBeNull();
    });
  });
});
