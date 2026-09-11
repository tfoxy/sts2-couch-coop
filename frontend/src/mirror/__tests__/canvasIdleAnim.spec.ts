// THE IDLE-ANIMATION EVALUATOR (R3) — the CSS vocabulary as closed forms.
//
// Every assertion here is against the CSS the DOM arm runs, not against this module's own arithmetic: presentation
// expresses each of these loops as two keyframes plus a timing function, and the forms in `idleAnim.ts` are what
// that composition collapses to. So the tests check the four quarter-phases of each kind (where the extrema and
// the crossings are), the ANTI-ORBIT property the DOM needed a whole extra self-layer to get, the map-point
// pulse's endpoints against the producer's own binding, and `cssEaseOut` against the cubic-bezier curve CSS
// defines `ease-out` to be.

import { describe, expect, it } from "vitest";

import { pinnedLoopBinding, pinnedLoopNodePivot } from "@/mirror/animAttributes";
import {
  createIdleAnimSample,
  cssEaseOut,
  idleAnimPlanFor,
  sampleIdleAnim,
  type IdleAnimBox,
  type IdleAnimPlan,
  type IdleAnimSample
} from "@/mirror/canvas/idleAnim";

const BOX: IdleAnimBox = { x: 0, y: 0, width: 100, height: 40 };

function planOf(binding: Record<string, unknown>, box: IdleAnimBox = BOX, pivot?: { x: number; y: number }): IdleAnimPlan {
  const plan = idleAnimPlanFor({ path: "", ...binding } as never, box, pivot);
  expect(plan).not.toBeNull();
  return plan!;
}

function sampleAt(plan: IdleAnimPlan, phase: number): IdleAnimSample {
  const out = createIdleAnimSample();
  sampleIdleAnim(plan, phase, out);
  return out;
}

/** Map a point through a sample's post matrix, which is the node-LOCAL conjugation the walk right-multiplies. */
function through(out: IdleAnimSample, x: number, y: number): [number, number] {
  const m = out.post;
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const QUARTERS = [0, 0.25, 0.5, 0.75];

describe("the spin", () => {
  const plan = () => planOf({ kind: "rotate", durationMs: 12566 });

  it("turns exactly once per cycle", () => {
    // A point one unit right of the pivot walks the quarter-turns anticlockwise-in-screen-space (+y is down).
    const p = plan();
    const at = QUARTERS.map((phase) => through(sampleAt(p, phase), 51, 20).map((v) => Math.round(v * 1e6) / 1e6));
    expect(at).toEqual([
      [51, 20],
      [50, 21],
      [49, 20],
      [50, 19]
    ]);
  });

  it("does NOT orbit — the pivot itself never moves", () => {
    // The whole reason the DOM backend needs a self-layer child: an individual CSS `rotate:` sits outside the
    // element's baked matrix and sweeps the node about the design origin. A local conjugation cannot.
    const p = plan();
    for (const phase of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      const [x, y] = through(sampleAt(p, phase), p.pivotX, p.pivotY);
      expect(x).toBeCloseTo(p.pivotX, 9);
      expect(y).toBeCloseTo(p.pivotY, 9);
    }
  });

  it("spins about the node's AUTHORED pivot when it has one", () => {
    // deck 36,34 — not the box centre (50,20), and at a full turn a 1 px pivot error is a visible wobble.
    const p = planOf({ kind: "rotate", durationMs: 6283 }, BOX, pinnedLoopNodePivot("topBarDeckRock")!);
    expect([p.pivotX, p.pivotY]).toEqual([36, 34]);
  });
});

describe("the rock", () => {
  const plan = () => planOf({ kind: "rock", durationMs: 1600, amplitudeRad: 0.12 });

  it("starts at −amplitude, reaches +amplitude at half a cycle, and returns", () => {
    // The keyframes run `rotate: -amp` → `+amp` over a HALF period with easeInOutSine and `alternate`, which is
    // exactly −amp·cos 2πφ. Read the angle back off the matrix.
    const angles = QUARTERS.map((phase) => Math.atan2(sampleAt(plan(), phase).post[1], sampleAt(plan(), phase).post[0]));
    expect(angles[0]).toBeCloseTo(-0.12, 9);
    expect(angles[1]).toBeCloseTo(0, 9);
    expect(angles[2]).toBeCloseTo(0.12, 9);
    expect(angles[3]).toBeCloseTo(0, 9);
  });

  it("is continuous across the alternate seam", () => {
    const a = Math.atan2(sampleAt(plan(), 0.4999).post[1], sampleAt(plan(), 0.4999).post[0]);
    const b = Math.atan2(sampleAt(plan(), 0.5001).post[1], sampleAt(plan(), 0.5001).post[0]);
    expect(Math.abs(a - b)).toBeLessThan(1e-5);
  });

  it("defaults to presentation's own amplitude", () => {
    expect(planOf({ kind: "rock", durationMs: 1600 }).amplitudeRad).toBe(0.12);
  });
});

describe("the intent bob", () => {
  const plan = () => planOf({ kind: "bob", durationMs: 2000, amplitudePx: 10, baselineUpPx: 8 });

  it("rides the PRE channel, so the holder's whole subtree moves with it", () => {
    const out = sampleAt(plan(), 0.25);
    expect(out.hasPre).toBe(true);
    expect(out.hasPost).toBe(false);
  });

  it("sweeps the keyframes' two extrema about the baseline", () => {
    // `translateY(-18px)` ↔ `translateY(2px)` for the defaults — presentation's own literal keyframe pair.
    const p = plan();
    expect(QUARTERS.map((phase) => Math.round(sampleAt(p, phase).preY * 1e6) / 1e6)).toEqual([-18, -8, 2, -8]);
  });
});

describe("the map-point pulse", () => {
  // Through the producer's OWN binding, so a drift in the token's parameters fails here rather than on the map.
  const binding = pinnedLoopBinding("mapPointPulse", "node-1", 0, 0)!;
  const plan = () => planOf(binding as unknown as Record<string, unknown>);

  it("sweeps between the game's scale endpoints", () => {
    const p = plan();
    const k = (phase: number) => sampleAt(p, phase).post[0];
    expect(k(0)).toBeCloseTo(binding.scaleFrom!, 9);
    expect(k(0.5)).toBeCloseTo(binding.scaleTo!, 9);
    expect(k(0.25)).toBeCloseTo((binding.scaleFrom! + binding.scaleTo!) / 2, 9);
    expect(k(0.75)).toBeCloseTo((binding.scaleFrom! + binding.scaleTo!) / 2, 9);
  });

  it("grows about the pivot, which therefore never moves", () => {
    const p = plan();
    for (const phase of [0, 0.3, 0.5, 0.8]) {
      const [x, y] = through(sampleAt(p, phase), p.pivotX, p.pivotY);
      expect(x).toBeCloseTo(p.pivotX, 9);
      expect(y).toBeCloseTo(p.pivotY, 9);
    }
  });

  it("IS the DOM's own spelling, for every matrix and every k", () => {
    // The DOM composes `T(u)·S(k)·T(−u)·M` with `u = M·p`; this arm composes `M·T(p)·S(k)·T(−p)`. A uniform scale
    // commutes with any linear map, so the two are the same affine — including under the non-uniform, rotated
    // matrix below, where nothing else about the two spellings would agree.
    const M = [1.3, 0.4, -0.2, 0.9, 37, -11];
    const p = plan();
    const out = sampleAt(p, 0.31);
    const k = out.post[0];
    const ux = M[0] * p.pivotX + M[2] * p.pivotY + M[4];
    const uy = M[1] * p.pivotX + M[3] * p.pivotY + M[5];
    for (const [x, y] of [
      [0, 0],
      [17, -4],
      [100, 40]
    ]) {
      // ours: M · post · (x,y)
      const [lx, ly] = through(out, x, y);
      const ours = [M[0] * lx + M[2] * ly + M[4], M[1] * lx + M[3] * ly + M[5]];
      // theirs: u + k·(M·(x,y) − u)
      const mx = M[0] * x + M[2] * y + M[4];
      const my = M[1] * x + M[3] * y + M[5];
      const theirs = [ux + k * (mx - ux), uy + k * (my - uy)];
      expect(ours[0]).toBeCloseTo(theirs[0], 9);
      expect(ours[1]).toBeCloseTo(theirs[1], 9);
    }
  });
});

describe("the glow pulse", () => {
  const binding = pinnedLoopBinding("proceedGlow", "node-1", 0, 0)!;
  const plan = () => planOf(binding as unknown as Record<string, unknown>);

  it("is a TRIANGLE, not a sine — two linear legs, as the Tween's default transition is", () => {
    const p = plan();
    const a = (phase: number) => sampleAt(p, phase).alpha;
    expect(a(0)).toBeCloseTo(1, 9);
    expect(a(0.5)).toBeCloseTo(binding.alphaTo!, 9);
    // Halfway along a leg is halfway between the endpoints; an eased leg would not be.
    expect(a(0.25)).toBeCloseTo((1 + binding.alphaTo!) / 2, 9);
    expect(a(0.75)).toBeCloseTo((1 + binding.alphaTo!) / 2, 9);
  });

  it("writes alpha alone — a glow moves nothing", () => {
    const out = sampleAt(plan(), 0.25);
    expect([out.hasPre, out.hasPost]).toEqual([false, false]);
  });
});

describe("the end-turn pulse", () => {
  const binding = pinnedLoopBinding("endTurnGlow", "node-1", 0, 0)!;
  const plan = () => planOf(binding as unknown as Record<string, unknown>);

  it("does NOT alternate: the cycle restarts from its start values", () => {
    const p = plan();
    // Both of the game's parallel legs carry `.From(...)`, so φ→1⁻ is the FAR end and φ=0 is the near one.
    expect(sampleAt(p, 0).post[0]).toBeCloseTo(binding.scaleFrom!, 6);
    expect(sampleAt(p, 0.999).post[0]).toBeCloseTo(binding.scaleTo!, 3);
    expect(sampleAt(p, 0).alpha).toBeCloseTo(binding.alphaFrom!, 6);
    expect(sampleAt(p, 0.999).alpha).toBeCloseTo(binding.alphaTo!, 3);
  });

  it("moves AND fades — the one kind that writes both channels", () => {
    const out = sampleAt(plan(), 0.4);
    expect(out.hasPost).toBe(true);
    expect(out.alpha).toBeLessThan(1);
    expect(plan().channel).toBe("postAlpha");
  });

  it("runs on cssEaseOut, so the growth is front-loaded", () => {
    const p = plan();
    const half = sampleAt(p, 0.5).alpha;
    const linear = binding.alphaFrom! + (binding.alphaTo! - binding.alphaFrom!) * 0.5;
    expect(half).toBeLessThan(linear); // ease-out is past halfway at t = 0.5
  });
});

describe("cssEaseOut", () => {
  it("matches cubic-bezier(0, 0, 0.58, 1) — the curve CSS defines `ease-out` to be", () => {
    // Reference values from the bezier's own definition, solved to 1e-8 by bisection. Five points, because a
    // solver that is right at the ends and wrong in the middle is the failure mode a two-point check misses.
    const reference: Array<[number, number]> = [
      [0.1, 0.16057215],
      [0.25, 0.37813813],
      [0.5, 0.68464319],
      [0.75, 0.90653535],
      [0.9, 0.98297339]
    ];
    for (const [x, y] of reference) {
      expect(cssEaseOut(x)).toBeCloseTo(y, 6);
    }
  });

  it("is pinned at the unit interval's ends and clamps outside it", () => {
    expect(cssEaseOut(0)).toBe(0);
    expect(cssEaseOut(1)).toBe(1);
    expect(cssEaseOut(-0.5)).toBe(0);
    expect(cssEaseOut(1.5)).toBe(1);
  });

  it("is monotone", () => {
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const y = cssEaseOut(i / 100);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
  });
});

describe("what the evaluator refuses", () => {
  it("has no numeric form for flameFlicker, and says so rather than guessing", () => {
    // Two independent self-chaining tween tracks whose paint lives on a per-quad gsw shader canvas: an
    // fx-surface composition problem, not a transform one. Filed, not approximated.
    expect(idleAnimPlanFor({ path: "", kind: "flameFlicker", delayMs: 100 }, BOX)).toBeNull();
  });

  it("refuses a binding with no cycle, exactly as the scheduler does", () => {
    expect(idleAnimPlanFor({ path: "", kind: "rotate" }, BOX)).toBeNull();
    expect(idleAnimPlanFor({ path: "", kind: "rotate", durationMs: 0 }, BOX)).toBeNull();
  });

  it("allocates nothing per sample", () => {
    const p = planOf({ kind: "rotate", durationMs: 1000 });
    const out = createIdleAnimSample();
    const post = out.post;
    sampleIdleAnim(p, 0.2, out);
    sampleIdleAnim(p, 0.7, out);
    expect(out.post).toBe(post);
  });

  it("clears the channels it did not write, so a reused sample cannot carry a stale pose", () => {
    const out = createIdleAnimSample();
    sampleIdleAnim(planOf({ kind: "rotate", durationMs: 1000 }), 0.2, out);
    expect(out.hasPost).toBe(true);
    sampleIdleAnim(planOf({ kind: "bob", durationMs: 2000 }), 0.2, out);
    expect([out.hasPost, out.hasPre]).toEqual([false, true]);
    sampleIdleAnim(planOf({ kind: "glowPulse", durationMs: 1000, alphaTo: 0.5 }), 0.2, out);
    expect([out.hasPost, out.hasPre]).toEqual([false, false]);
  });
});
