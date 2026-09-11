import { describe, expect, it } from "vitest";

import {
  createFxPixelRatioGate,
  FX_PIXEL_RATIO_ATTR,
  FX_PIXEL_RATIO_MAX,
  FX_PIXEL_RATIO_STEP,
  fxAxisScale,
  fxPixelRatioAttrValue,
  fxPixelRatioWrite
} from "@/mirror/canvas/fxPixelRatio";

// The number the mirror hands gsw so an fx surface's backing store can be sized for the device pixels it
// really covers (`data-godot-shader-pixel-ratio`). Pure arithmetic — the DOM half is in overlay.ts and the
// stage-level effect is in canvasStage.spec.ts.
//
// Every test here is one of the four rules in the module header: AXIS not AABB, fit excluded, magnification
// only, quantised up to 1/8 and written only at rest.

const rotation = (deg: number): number[] => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};

describe("fxAxisScale — AXIS, never the bounding box", () => {
  it("is 1 for the identity", () => {
    expect(fxAxisScale([1, 0, 0, 1, 0, 0])).toBe(1);
  });

  it("is the scale factor for a uniform scale, and translation-blind", () => {
    expect(fxAxisScale([2, 0, 0, 2, 0, 0])).toBe(2);
    expect(fxAxisScale([2, 0, 0, 2, 987, -654])).toBe(2);
  });

  it("is the MEAN of the two axes under a non-uniform scale", () => {
    // A surface under scale(1, 1.5) is drawn at neither axis alone — the same rule, and the same arithmetic,
    // the text raster uses for a run under a non-uniform scale.
    expect(fxAxisScale([1, 0, 0, 1.5, 0, 0])).toBe(1.25);
  });

  it("IS EXACTLY 1 UNDER ANY ROTATION — the whole reason this is not a rect ratio", () => {
    // THE BUG THIS PREVENTS. `getBoundingClientRect()` on a rotated square returns its axis-aligned bounding
    // box, which is `|cos|+|sin|` wider than the square — sqrt(1.5) at 15 degrees, sqrt(2) at 45 — with not
    // one extra device pixel underneath it. Measured on the live combat page: three sibling 220x220 particle
    // surfaces, all at scale 1, rotated 15, 45 and 0 degrees, all three correctly backed at 147x147, and a
    // rect-ratio measurement called two of them under-resolved and the identical third fine.
    for (const deg of [0, 15, 30, 45, 90, 137, -45, 180]) {
      expect(fxAxisScale(rotation(deg))).toBeCloseTo(1, 12);
    }
    // …and the AABB factors those same rotations really have, so the gap is on the record.
    expect(Math.cos(Math.PI / 12) + Math.sin(Math.PI / 12)).toBeCloseTo(Math.sqrt(1.5), 6);
    expect(Math.cos(Math.PI / 4) + Math.sin(Math.PI / 4)).toBeCloseTo(Math.SQRT2, 12);
  });

  it("composes rotation WITH scale — a turned, magnified surface still reports its magnification", () => {
    const r = Math.PI / 4;
    const k = 1.5;
    expect(
      fxAxisScale([k * Math.cos(r), k * Math.sin(r), -k * Math.sin(r), k * Math.cos(r), 0, 0])
    ).toBeCloseTo(k, 12);
  });

  it("refuses a degenerate matrix rather than propagating NaN into an attribute", () => {
    expect(fxAxisScale([Number.NaN, 0, 0, 1, 0, 0])).toBe(1);
    expect(fxAxisScale([Number.POSITIVE_INFINITY, 0, 0, 1, 0, 0])).toBe(1);
  });
});

describe("fxPixelRatioAttrValue — magnification only, quantised UP to 1/8", () => {
  it("writes NOTHING at or below 1:1 — an absent attribute is gsw's byte-identical off-switch", () => {
    expect(fxPixelRatioAttrValue(1)).toBeNull();
    expect(fxPixelRatioAttrValue(0.5)).toBeNull();
    expect(fxPixelRatioAttrValue(0)).toBeNull();
    expect(fxPixelRatioAttrValue(-2)).toBeNull();
    // A minified surface is OVER-resolved: it costs memory and fill but loses no picture, and shrinking a live
    // store to reclaim that re-allocates (and, under the frozen-surface swap, retires a stand-in). This round
    // fixes soft, not fat.
    expect(fxPixelRatioAttrValue(0.66667)).toBeNull();
  });

  it("quantises UP to the next 1/8 step — sqrt(2) at rest becomes 1.5", () => {
    // Rounding to NEAREST would give 1.375 for sqrt(2) (1.41421), leaving the surface short of the pixels it
    // covers — which is the bug, not a smaller version of the fix.
    expect(fxPixelRatioAttrValue(Math.SQRT2)).toBe("1.5");
    expect(fxPixelRatioAttrValue(Math.sqrt(1.5))).toBe("1.25"); // 1.2247 -> 1.25
    expect(fxPixelRatioAttrValue(1.2)).toBe("1.25");
    expect(fxPixelRatioAttrValue(1.5)).toBe("1.5"); // already on a step: unchanged
    expect(fxPixelRatioAttrValue(1.001)).toBe("1.125");
  });

  it("declares its step, so a reader never reverses it out of a threshold", () => {
    expect(FX_PIXEL_RATIO_STEP).toBe(1 / 8);
    // The same step the census's slack uses, which is what makes a surface sized at a quantised value
    // incapable of reading as under-resolved.
    expect(fxPixelRatioAttrValue(1 + FX_PIXEL_RATIO_STEP)).toBe("1.125");
  });

  it("caps at gsw's own ceiling instead of asking for an unbounded allocation", () => {
    expect(fxPixelRatioAttrValue(40)).toBe(String(FX_PIXEL_RATIO_MAX));
    expect(FX_PIXEL_RATIO_MAX).toBe(4);
  });

  it("refuses a non-finite scale outright", () => {
    expect(fxPixelRatioAttrValue(Number.NaN)).toBeNull();
    expect(fxPixelRatioAttrValue(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("names the attribute gsw reads, verbatim", () => {
    expect(FX_PIXEL_RATIO_ATTR).toBe("data-godot-shader-pixel-ratio");
  });
});

describe("fxPixelRatioWrite — the AT-REST gate", () => {
  it("holds the FIRST sighting back one build, then commits it", () => {
    const gate = createFxPixelRatioGate();
    // Build 1 has nothing to compare against, so it cannot know the scale is settled.
    expect(fxPixelRatioWrite(gate, "1.5")).toBeUndefined();
    // Build 2 agrees ⇒ at rest ⇒ write.
    expect(fxPixelRatioWrite(gate, "1.5")).toBe("1.5");
  });

  it("writes ONCE and then goes quiet, however many builds agree", () => {
    // Every distinct value gsw sees is a reallocation, a cleared canvas and a retired stand-in `<img>`, so a
    // settled node must cost exactly one write for as long as it stays settled.
    const gate = createFxPixelRatioGate();
    fxPixelRatioWrite(gate, "1.5");
    expect(fxPixelRatioWrite(gate, "1.5")).toBe("1.5");
    for (let i = 0; i < 20; i++) {
      expect(fxPixelRatioWrite(gate, "1.5")).toBeUndefined();
    }
  });

  it("KEEPS THE PREVIOUS VALUE through a ramp, and commits only where the ramp lands", () => {
    // The case the gate exists for: a node easing 1.0 -> 1.4142 hands a different quantised value most builds.
    const gate = createFxPixelRatioGate();
    // Settle at 1.25 first, so there is a previous value to hold.
    fxPixelRatioWrite(gate, "1.25");
    expect(fxPixelRatioWrite(gate, "1.25")).toBe("1.25");

    // …now ramp. Every build differs from the last, so NOTHING is written and 1.25 stands on the DOM.
    for (const v of ["1.375", "1.5", "1.75", "2", "2.25"]) {
      expect(fxPixelRatioWrite(gate, v)).toBeUndefined();
    }
    expect(gate.applied).toBe("1.25");

    // …and the moment it settles, one write.
    expect(fxPixelRatioWrite(gate, "2.25")).toBe("2.25");
    expect(gate.applied).toBe("2.25");
  });

  it("drops the attribute when a settled node comes back down to 1:1", () => {
    const gate = createFxPixelRatioGate();
    fxPixelRatioWrite(gate, "1.5");
    fxPixelRatioWrite(gate, "1.5");
    expect(gate.applied).toBe("1.5");
    // Ramping down: the larger store is held (over-resolved, never under) until the scale settles.
    expect(fxPixelRatioWrite(gate, "1.25")).toBeUndefined();
    expect(gate.applied).toBe("1.5");
    expect(fxPixelRatioWrite(gate, null)).toBeUndefined();
    expect(fxPixelRatioWrite(gate, null)).toBeNull(); // ← settled at 1:1: remove the attribute
    expect(gate.applied).toBeNull();
  });

  it("an un-magnified node that never moves writes nothing, ever", () => {
    // The overwhelmingly common case, and it must cost the DOM nothing at all.
    const gate = createFxPixelRatioGate();
    for (let i = 0; i < 30; i++) {
      expect(fxPixelRatioWrite(gate, null)).toBeUndefined();
    }
    expect(gate.applied).toBeNull();
  });
});

describe("end to end — the three cases the live page produces", () => {
  const settle = (m: number[]): string | null | undefined => {
    const gate = createFxPixelRatioGate();
    const v = fxPixelRatioAttrValue(fxAxisScale(m));
    fxPixelRatioWrite(gate, v);
    return fxPixelRatioWrite(gate, v);
  };

  it("a node under ancestor scale sqrt(2), at rest, gets 1.5", () => {
    expect(settle([Math.SQRT2, 0, 0, Math.SQRT2, 0, 0])).toBe("1.5");
  });

  it("a node ROTATED 45 degrees at scale 1 gets nothing — it is not magnified", () => {
    expect(settle(rotation(45))).toBeUndefined();
  });

  it("a node at the stage's own fit scale gets nothing — the fit reaches gsw as renderScale", () => {
    // `OverlayRecord.transform` is design-space: the stage's 0.667 fit is NOT in it, and it reaches gsw
    // separately. A value here would apply it a second time.
    expect(settle([1, 0, 0, 1, 40, 40])).toBeUndefined();
  });
});
