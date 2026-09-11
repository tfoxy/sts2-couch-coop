import { describe, expect, it } from "vitest";

import {
  boxFullyOutsideDesign,
  computeHoverTipScale,
  HOVER_TIP_DESIGN_HEIGHT,
  HOVER_TIP_EDGE_THRESHOLD,
  HOVER_TIP_SCALE,
  type TipAabb
} from "@/mirror/hoverTipScaleMath";

// These are the SAME vectors the native HoverTipScaleMath is tested against — the two clients must anchor the
// 1.2× enlargement pixel-identically. Coordinates are design space (1920×1080 unless the stage is widened).

const DESIGN_W = 1920;

function aabb(x: number, y: number, w: number, h: number): TipAabb {
  return { x, y, w, h };
}

describe("computeHoverTipScale — anchor pivot", () => {
  it("shares the native constants (k=1.2, edge=48, height=1080)", () => {
    expect(HOVER_TIP_SCALE).toBe(1.2);
    expect(HOVER_TIP_EDGE_THRESHOLD).toBe(48);
    expect(HOVER_TIP_DESIGN_HEIGHT).toBe(1080);
  });

  it("single column: pivot at the union's top-left (no edge hug)", () => {
    const res = computeHoverTipScale([aabb(1040, 660, 360, 122)], DESIGN_W)!;
    expect(res.pivotX).toBe(1040);
    expect(res.pivotY).toBe(660);
    // Well inside the viewport → no clamp.
    expect(res.offsetX).toBe(0);
    expect(res.offsetY).toBe(0);
  });

  it("owner-less tip at the right edge: grow-right overflows → #18 flip to MaxX", () => {
    // Grow right from 1528 would reach 1528 + 1.2·360 = 1960 > 1920 → flip pivot to union.MaxX 1888 (grow left).
    const res = computeHoverTipScale([aabb(1528, 544, 360, 256)], DESIGN_W)!;
    expect(res.pivotX).toBe(1888);
    expect(res.pivotY).toBe(544); // top edge (MaxY 800 < 1032)
  });

  it("hand-card straddle: two disjoint columns → pivot X at the inner-gap midpoint", () => {
    // text panel x-range [980,1340], card x-range [1540,1900] → gap [1340,1540], midpoint 1440.
    const text = aabb(980, 300, 360, 200); // maxX 1340
    const card = aabb(1540, 260, 360, 480); // maxX 1900
    const res = computeHoverTipScale([text, card], DESIGN_W)!;
    expect(res.pivotX).toBe(1440);
    expect(res.pivotY).toBe(260); // union top (min of the two y's)
  });

  it("vertically-stacked blocks with overlapping x stay a SINGLE block (not a straddle)", () => {
    // Same x-range, stacked → one x-cluster → single-block rule, pivot X at union left.
    const res = computeHoverTipScale([aabb(500, 200, 300, 100), aabb(500, 320, 300, 100)], DESIGN_W)!;
    expect(res.pivotX).toBe(500);
    expect(res.pivotY).toBe(200);
  });

  it("empty (no paint-bearing children) → null (no stamp)", () => {
    expect(computeHoverTipScale([], DESIGN_W)).toBeNull();
  });
});

// #17/#18 — pivot-X keyed by owner KIND (same vectors as the native HoverTipScaleMathTests:
// CreatureTipGrowsLeftUpAwayFromOwner / CardTipOwnerLeftGrowsRightUp / Kind* / NoneOverflowFlipsToMaxX).
describe("computeHoverTipScale — grow toward the side the tip sits on (owner kind)", () => {
  it("#17 creature: Creature kind (owner right & level) → grow LEFT + UP (HP bar stays clear)", () => {
    const owner = aabb(1370, 528, 200, 212); // centre (1470,634) — right of the tip with a SideGap clearance
    const res = computeHoverTipScale([aabb(981, 528, 367, 246)], DESIGN_W, owner, "creature")!;
    expect(res.pivotX).toBe(1348); // Creature kind → union.MaxX → grow left
    expect(res.pivotY).toBe(774); // union.MaxY → grow up
    expect(res.offsetX).toBe(0);
    expect(res.offsetY).toBe(0);
  });

  it("#17 hand card: HandCard kind (owner left & below) → grow RIGHT + UP", () => {
    const owner = aabb(1233, 871, 0, 0); // holder anchor point, left of & below the tip
    const res = computeHoverTipScale([aabb(1393, 660, 367, 125)], DESIGN_W, owner, "handCard")!;
    expect(res.pivotX).toBe(1393); // HandCard kind → union.MinX → grow right
    expect(res.pivotY).toBe(785); // union.MaxY → grow up
    expect(res.offsetX).toBe(0);
    expect(res.offsetY).toBe(0);
  });

  it("None-kind tip whose KNOWN owner is CLEARLY above → grow RIGHT + reverse vertical to grow DOWN", () => {
    const owner = aabb(1100, 120, 200, 120); // centre (1200,180), entirely above the tip top (300)
    const res = computeHoverTipScale([aabb(900, 300, 300, 150)], DESIGN_W, owner)!;
    expect(res.pivotX).toBe(900); // None kind → grow right (no overflow: 900 + 1.2·300 = 1260 ≤ 1920)
    expect(res.pivotY).toBe(300); // owner above → grow down
  });

  it("owner-driven grow-UP whose scaled top overflows → clamped back down", () => {
    const owner = aabb(950, 400, 200, 100); // below the tip → grow up
    // pivotY = MaxY 240; scaled top = 240 − 1.2·220 = −24 → offsetY +24.
    const res = computeHoverTipScale([aabb(900, 20, 300, 220)], DESIGN_W, owner)!;
    expect(res.pivotY).toBe(240);
    expect(res.offsetY).toBe(24);
  });

  it("#17 CardReward kind grows RIGHT; RewardItem kind grows LEFT (mid-screen, no overflow)", () => {
    expect(computeHoverTipScale([aabb(700, 300, 320, 200)], DESIGN_W, null, "cardReward")!.pivotX).toBe(700);
    expect(computeHoverTipScale([aabb(1400, 300, 320, 200)], DESIGN_W, null, "rewardItem")!.pivotX).toBe(1720);
    expect(computeHoverTipScale([aabb(700, 300, 320, 200)], DESIGN_W, null, "creature")!.pivotX).toBe(1020);
  });

  it("#18 None kind: grows right when it fits, flips to MaxX when the scaled right edge overflows", () => {
    expect(computeHoverTipScale([aabb(1200, 400, 300, 120)], DESIGN_W)!.pivotX).toBe(1200);
    // 1600 + 1.2·300 = 1960 > 1920 → flip to union.MaxX 1900.
    expect(computeHoverTipScale([aabb(1600, 400, 300, 120)], DESIGN_W)!.pivotX).toBe(1900);
  });
});

// R5 (item 5) non-overlap invariant — the SAME vectors as native HoverTipScaleMathTests.SideClamp* + OwnerFollow*.
describe("computeHoverTipScale — non-overlap side-clamp", () => {
  it("HandCard tip overlapping its owner is pushed RIGHT (left edge → owner.MaxX + SideGap)", () => {
    const owner = aabb(900, 430, 100, 60);
    const res = computeHoverTipScale([aabb(800, 400, 300, 120)], DESIGN_W, owner, "handCard")!;
    expect(res.pivotX).toBe(800);
    expect(res.offsetX).toBeCloseTo(212, 3);
    expect(res.pivotX + HOVER_TIP_SCALE * (800 - res.pivotX) + res.offsetX).toBeCloseTo(1012, 3);
  });

  it("Creature tip overlapping its owner is pushed LEFT (right edge → owner.MinX − SideGap)", () => {
    const owner = aabb(1050, 430, 100, 60);
    const res = computeHoverTipScale([aabb(1000, 400, 300, 120)], DESIGN_W, owner, "creature")!;
    expect(res.pivotX).toBe(1300);
    expect(res.offsetX).toBeCloseTo(-262, 3);
    expect(res.pivotX + HOVER_TIP_SCALE * (1300 - res.pivotX) + res.offsetX).toBeCloseTo(1038, 3);
  });

  it("preferred-right overflow near the right edge flips the tip LEFT (stays on-screen)", () => {
    const owner = aabb(1650, 430, 100, 60);
    const res = computeHoverTipScale([aabb(1600, 400, 250, 120)], DESIGN_W, owner, "handCard")!;
    expect(res.offsetX).toBeCloseTo(-262, 3);
    expect(res.pivotX + HOVER_TIP_SCALE * (1850 - res.pivotX) + res.offsetX).toBeLessThanOrEqual(DESIGN_W + 1e-6);
  });

  it("skips a STRADDLE tip even with an overlapping owner", () => {
    const owner = aabb(1400, 460, 120, 300);
    const cols = [aabb(980, 500, 360, 300), aabb(1540, 460, 360, 340)];
    const withOwner = computeHoverTipScale(cols, DESIGN_W, owner, "handCard")!;
    const without = computeHoverTipScale(cols, DESIGN_W)!;
    expect(withOwner.pivotX).toBe(1440);
    expect(withOwner.offsetX).toBeCloseTo(without.offsetX, 3);
  });

  it("ownerFollow folds into the clamp channel (item 6)", () => {
    const res = computeHoverTipScale([aabb(700, 400, 300, 120)], DESIGN_W, null, "handCard", 40, -15)!;
    expect(res.offsetX).toBeCloseTo(40, 3);
    expect(res.offsetY).toBeCloseTo(-15, 3);
  });
});

describe("computeHoverTipScale — viewport clamp", () => {
  it("bottom overflow: the scaled union is pushed UP by the overflow", () => {
    // Tall block from the top → not bottom-hug (MaxY 1000 < 1032) → pivot Y = top (200).
    // Scaled Y: [200, 200 + 1.2·(1000−200)] = [200, 1160]; height 960 < 1080; MaxY 1160 > 1080 → offset −80.
    const res = computeHoverTipScale([aabb(800, 200, 300, 800)], DESIGN_W)!;
    expect(res.pivotY).toBe(200);
    expect(res.offsetY).toBe(-80);
    expect(res.offsetX).toBe(0);
  });

  it("bottom-hugging block anchors its bottom edge (MaxY ≥ 1080−48)", () => {
    // MaxY = 950 + 100 = 1050 ≥ 1032 → bottom-hug → pivot Y = MaxY. Scaling about the bottom keeps it on-screen.
    const res = computeHoverTipScale([aabb(700, 950, 300, 100)], DESIGN_W)!;
    expect(res.pivotY).toBe(1050);
    // Scaled Y: [1050 + 1.2·(950−1050), 1050] = [930, 1050] → inside → no clamp.
    expect(res.offsetY).toBe(0);
  });

  it("oversized (scaled taller than the viewport) pins the TOP edge to 0", () => {
    // Scaled Y: [50, 50 + 1.2·(1000−50)] = [50, 1190]; height 1140 > 1080 → pin top → offset −50.
    const res = computeHoverTipScale([aabb(800, 50, 300, 950)], DESIGN_W)!;
    expect(res.offsetY).toBe(-50);
  });

  it("left overflow: an overflow-flipped (MaxX-pivot) scaled union is pushed RIGHT", () => {
    // designW 400, block (60,100,330,100): grow right from 60 reaches 60 + 1.2·330 = 456 > 400 → #18 flip to
    // union.MaxX 390 (grow left). Scaled X min = 390 + 1.2·(60−390) = 390 − 396 = −6 → push right by 6.
    const res = computeHoverTipScale([aabb(60, 100, 330, 100)], 400)!;
    expect(res.pivotX).toBe(390);
    expect(res.offsetX).toBe(6);
  });
});

describe("computeHoverTipScale — widened stage", () => {
  it("the #18 overflow predicate + horizontal clamp scale with designW", () => {
    const wide = 2520;
    // Grow right from 2450 reaches 2450 + 1.2·60 = 2522 > 2520 → flip to union.MaxX 2510 (grow left).
    const res = computeHoverTipScale([aabb(2450, 400, 60, 200)], wide)!;
    expect(res.pivotX).toBe(2510);
  });

  it("the SAME AABB anchors differently under a narrow vs a widened designW", () => {
    const box = aabb(1800, 400, 200, 200); // MaxX = 2000
    // Narrow 1920: grow right 1800 + 1.2·200 = 2040 > 1920 → flip to MaxX 2000.
    expect(computeHoverTipScale([box], 1920)!.pivotX).toBe(2000);
    // Widened 2520: 2040 < 2520 → fits → grow-right pivot X = MinX 1800.
    expect(computeHoverTipScale([box], 2520)!.pivotX).toBe(1800);
  });
});

describe("boxFullyOutsideDesign — WS-shopfix P4 shop-phantom off-screen reject", () => {
  // Twin of native DesignAabb.FullyOutside(width, height, margin=0), pinned to the exact shop-phantom scenario: the
  // closed shop's SlotsContainer is Visible==true but parked at local y≈−1000 — entirely above the viewport.
  it("rejects a box parked entirely above the viewport (y≈-1000)", () => {
    expect(boxFullyOutsideDesign(aabb(0, -1000, 1920, 800), 1920)).toBe(true); // bottom edge at -200
  });

  it("does not reject a box only PARTIALLY off-screen (still overlapping the top edge)", () => {
    // Scrolled up 100px, still overlapping y=0 down to y=600 — applyViewScalePass's normal clamp must still apply.
    expect(boxFullyOutsideDesign(aabb(0, -100, 1920, 700), 1920)).toBe(false);
  });

  it("rejects boxes fully outside on every other side (left/right/below)", () => {
    expect(boxFullyOutsideDesign(aabb(-500, 400, 200, 100), 1920)).toBe(true); // fully left of x=0
    expect(boxFullyOutsideDesign(aabb(2000, 400, 200, 100), 1920)).toBe(true); // fully right of designW
    expect(boxFullyOutsideDesign(aabb(0, 1200, 1920, 100), 1920)).toBe(true); // fully below designH (1080)
  });

  it("does not reject a box fully inside the viewport", () => {
    expect(boxFullyOutsideDesign(aabb(500, 400, 200, 100), 1920)).toBe(false);
  });
});
