// THE COSMETIC-OFFSET RAMP, as a pure function of a clock.
//
// `offsetRamp.ts` is the time dimension the canvas raise did not have: the DOM glides a raised hand card up on
// `transition: translate 160ms ease-out` and the canvas teleported it. These pin the module's own contract — the
// three decisions in its header (a null timing is a teleport, a re-target continues from the current sample, the
// same target twice does not restart) plus the deadline the frame loop reads.

import { describe, expect, it } from "vitest";

import { godotEaseSample } from "@godot-scene-web/effects/easing";

import { createOffsetRamps, RAISE_LIFT_RAMP, type OffsetRampSample } from "@/mirror/canvas/offsetRamp";

function out(): OffsetRampSample {
  return { dx: 0, dy: 0 };
}

/** The raise's own shape: one holder gliding from rest to a 119 px lift on the raise-all timing. */
const LIFT = -119;

describe("offsetRamp — a null timing is the teleport it always was", () => {
  it("answers the target verbatim and arms nothing", () => {
    const ramps = createOffsetRamps();
    const o = out();
    expect(ramps.declare("holder", 0, 0, 0, LIFT, null, 1000, o)).toBe(false);
    expect(o).toEqual({ dx: 0, dy: LIFT });
    expect(ramps.active()).toBe(0);
    expect(ramps.nextDeadline()).toBe(Infinity);
  });

  it("…and a zero (or negative) duration is the same thing, so a degenerate tween timing needs no special case", () => {
    const ramps = createOffsetRamps();
    const o = out();
    expect(ramps.declare("holder", 0, 0, 0, LIFT, { durationMs: 0 }, 1000, o)).toBe(false);
    expect(o.dy).toBe(LIFT);
    expect(ramps.declare("holder", 0, 0, 0, LIFT, { durationMs: -5 }, 1000, o)).toBe(false);
    expect(o.dy).toBe(LIFT);
    expect(ramps.active()).toBe(0);
  });

  it("ABANDONS a ramp in flight at the target rather than easing to it", () => {
    const ramps = createOffsetRamps();
    const o = out();
    ramps.declare("holder", 0, 0, 0, LIFT, RAISE_LIFT_RAMP, 1000, o);
    ramps.declare("holder", 0, o.dy, 0, 0, null, 1080, o);
    expect(o).toEqual({ dx: 0, dy: 0 });
    expect(ramps.active()).toBe(0);
  });
});

describe("offsetRamp — the curve", () => {
  it("starts AT the from value, arrives exactly at the target, and eases in between", () => {
    const ramps = createOffsetRamps();
    const o = out();
    expect(ramps.declare("holder", 0, 0, 0, LIFT, RAISE_LIFT_RAMP, 1000, o)).toBe(true);
    // The declaring frame paints where the node already is — nothing jumps on the arm.
    expect(o).toEqual({ dx: 0, dy: 0 });

    ramps.sampleInto("holder", 1080, o);
    const half = godotEaseSample("Out", "Sine", 0.5);
    expect(o.dy).toBeCloseTo(LIFT * half, 9);
    // Ease-OUT: most of the distance is covered in the first half.
    expect(Math.abs(o.dy)).toBeGreaterThan(Math.abs(LIFT) / 2);

    ramps.sampleInto("holder", 1160, o);
    expect(o.dy).toBe(LIFT); // `godotEaseSample` returns exactly 1 at t >= 1
    ramps.sampleInto("holder", 9999, o);
    expect(o.dy).toBe(LIFT); // …and stays there; a late frame never overshoots
  });

  it("ramps both axes together", () => {
    const ramps = createOffsetRamps();
    const o = out();
    ramps.declare("n", 10, 20, 110, -80, { durationMs: 100, ease: "InOut", trans: "Linear" }, 0, o);
    ramps.sampleInto("n", 50, o);
    const t = godotEaseSample("InOut", "Linear", 0.5);
    expect(o.dx).toBeCloseTo(10 + 100 * t, 9);
    expect(o.dy).toBeCloseTo(20 - 100 * t, 9);
  });

  it("takes the caller's timing verbatim — the module holds no default duration", () => {
    const ramps = createOffsetRamps();
    const o = out();
    ramps.declare("n", 0, 0, 0, 100, { durationMs: 400, ease: "In", trans: "Cubic" }, 0, o);
    expect(ramps.nextDeadline()).toBe(400);
    ramps.sampleInto("n", 200, o);
    expect(o.dy).toBeCloseTo(100 * godotEaseSample("In", "Cubic", 0.5), 9);
  });
});

describe("offsetRamp — re-declaring", () => {
  it("does NOT restart toward the SAME target — a 60 Hz re-decide must not re-arm the glide", () => {
    const ramps = createOffsetRamps();
    const o = out();
    ramps.declare("holder", 0, 0, 0, LIFT, RAISE_LIFT_RAMP, 1000, o);
    expect(ramps.nextDeadline()).toBe(1160);

    // The caller re-decides the whole raise every reconcile and every finger move. Same answer ⇒ same curve.
    for (let at = 1010; at <= 1100; at += 10) {
      expect(ramps.declare("holder", 0, 0, 0, LIFT, RAISE_LIFT_RAMP, at, o)).toBe(true);
      expect(ramps.nextDeadline()).toBe(1160);
    }
    // …and it really did progress rather than sitting at the start.
    expect(o.dy).toBeCloseTo(LIFT * godotEaseSample("Out", "Sine", 100 / 160), 9);
  });

  it("RE-TARGETS from where the node IS, not from the caller's `from`", () => {
    const ramps = createOffsetRamps();
    const o = out();
    ramps.declare("holder", 0, 0, 0, LIFT, RAISE_LIFT_RAMP, 1000, o);
    ramps.sampleInto("holder", 1040, o);
    const midway = o.dy;
    expect(midway).toBeLessThan(0);
    expect(midway).toBeGreaterThan(LIFT);

    // The hand changes its mind: back to rest. The caller offers a stale `from` of 0 and it must be ignored.
    ramps.declare("holder", 0, 0, 0, 0, RAISE_LIFT_RAMP, 1040, o);
    expect(o.dy).toBeCloseTo(midway, 9); // continues from half-way up — no hitch
    expect(ramps.nextDeadline()).toBe(1200); // a fresh 160 ms from here
    ramps.sampleInto("holder", 1200, o);
    expect(o.dy).toBe(0);
  });

  it("arms nothing for a move of zero length", () => {
    const ramps = createOffsetRamps();
    const o = out();
    expect(ramps.declare("holder", 0, LIFT, 0, LIFT, RAISE_LIFT_RAMP, 1000, o)).toBe(false);
    expect(o.dy).toBe(LIFT);
    expect(ramps.active()).toBe(0);
  });

  it("retires an ARRIVED ramp through `advance`, not through a re-declare of the same target", () => {
    const ramps = createOffsetRamps();
    const o = out();
    ramps.declare("holder", 0, 0, 0, LIFT, RAISE_LIFT_RAMP, 1000, o);
    // Past the end the same-target guard still holds the entry — it answers the arrived value and keeps the
    // caller's loop awake for exactly one more frame, which is the frame `advance` clears it on.
    expect(ramps.declare("holder", 0, 0, 0, LIFT, RAISE_LIFT_RAMP, 1300, o)).toBe(true);
    expect(o.dy).toBe(LIFT);
    ramps.advance(1300, () => {});
    expect(ramps.active()).toBe(0);
  });

  it("re-targeting an ARRIVED ramp to its own value is a zero-length move and arms nothing", () => {
    const ramps = createOffsetRamps();
    const o = out();
    ramps.declare("holder", 0, 0, 0, LIFT, RAISE_LIFT_RAMP, 1000, o);
    // A DIFFERENT timing takes the re-target path, whose from is the arrived sample — which is the target.
    expect(ramps.declare("holder", 0, 0, 0, LIFT, { durationMs: 100 }, 1300, o)).toBe(true);
    ramps.advance(1300, () => {});
    expect(ramps.active()).toBe(0);
  });
});

describe("offsetRamp — the frame loop's half", () => {
  it("advance visits every live ramp and retires the arrived ones AT their target", () => {
    const ramps = createOffsetRamps();
    const o = out();
    ramps.declare("a", 0, 0, 0, LIFT, { durationMs: 100, ease: "Out", trans: "Sine" }, 0, o);
    ramps.declare("b", 0, 0, 0, LIFT, { durationMs: 300, ease: "Out", trans: "Sine" }, 0, o);
    expect(ramps.active()).toBe(2);

    const seen = new Map<string, number>();
    ramps.advance(100, (id, _dx, dy) => seen.set(id, dy));
    // `a` arrived: it was handed its FINAL value on the same call that retired it, so nothing is left un-painted.
    expect(seen.get("a")).toBe(LIFT);
    expect(ramps.active()).toBe(1);
    expect(seen.get("b")).toBeCloseTo(LIFT * godotEaseSample("Out", "Sine", 100 / 300), 9);

    seen.clear();
    ramps.advance(300, (id, _dx, dy) => seen.set(id, dy));
    expect([...seen.keys()]).toEqual(["b"]);
    expect(seen.get("b")).toBe(LIFT);
    expect(ramps.active()).toBe(0);
    ramps.advance(400, () => expect.unreachable("nothing left to visit"));
  });

  it("nextDeadline is the EARLIEST end, and Infinity with nothing running", () => {
    const ramps = createOffsetRamps();
    const o = out();
    expect(ramps.nextDeadline()).toBe(Infinity);
    ramps.declare("a", 0, 0, 0, 10, { durationMs: 300 }, 1000, o);
    ramps.declare("b", 0, 0, 0, 10, { durationMs: 100 }, 1000, o);
    expect(ramps.nextDeadline()).toBe(1100);
    ramps.forget("b");
    expect(ramps.nextDeadline()).toBe(1300);
    ramps.clear();
    expect(ramps.nextDeadline()).toBe(Infinity);
    expect(ramps.active()).toBe(0);
  });

  it("sampleInto answers false for an unramped node and leaves the caller's pair alone", () => {
    const ramps = createOffsetRamps();
    const o = { dx: 7, dy: 8 };
    expect(ramps.sampleInto("nobody", 1000, o)).toBe(false);
    expect(o).toEqual({ dx: 7, dy: 8 });
  });
});

describe("offsetRamp — the raise-all timing", () => {
  it("is the DOM's 160 ms, on the evaluator the rest of the backend uses", () => {
    expect(RAISE_LIFT_RAMP.durationMs).toBe(160);
    expect(RAISE_LIFT_RAMP.ease).toBe("Out");
    expect(RAISE_LIFT_RAMP.trans).toBe("Sine");
  });

  it("tracks CSS `ease-out` to within 0.024 across the glide — the number the header quotes", () => {
    // cubic-bezier(0, 0, 0.58, 1), solved for y at each x by bisection on the parametric bezier.
    const cssEaseOut = (x: number): number => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) {
        const s = (lo + hi) / 2;
        const bx = 3 * (1 - s) * (1 - s) * s * 0 + 3 * (1 - s) * s * s * 0.58 + s * s * s;
        if (bx < x) {
          lo = s;
        } else {
          hi = s;
        }
      }
      const s = (lo + hi) / 2;
      return 3 * (1 - s) * (1 - s) * s * 0 + 3 * (1 - s) * s * s * 1 + s * s * s;
    };
    let worst = 0;
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      worst = Math.max(worst, Math.abs(godotEaseSample("Out", "Sine", t) - cssEaseOut(t)));
    }
    expect(worst).toBeLessThanOrEqual(0.024);
    // …which on the raise's own 119 px lift is under 3 px, for about two frames of a 160 ms glide.
    expect(worst * 119).toBeLessThan(3);
  });
});
