import { describe, expect, it } from "vitest";

import {
  decomposeMatrix,
  lerpDecomposedInto,
  lerpMatrix6Into,
  matrix6Equal,
  recomposeInto,
  shortestRotationTarget
} from "@/mirror/canvas/matrixLerp";

// CSS-semantics matrix interpolation, from first principles.
//
// The DOM mirror hands two `matrix()` endpoints to a CSS transition and the browser DECOMPOSES both, interpolates
// translate / rotate / scale / shear and recomposes. A canvas renderer computes the frame itself, so it has to
// reproduce that — and the difference from a naive six-number lerp is not subtle: it is the shape of every
// rotating tween. The expected intermediate matrices below are written out by hand (cos/sin of the interpolated
// angle times the interpolated scale) rather than re-derived from the implementation.

const scratch: number[] = [0, 0, 0, 0, 0, 0];

/** `rotate(rad) · scale(sx, sy)` as a CSS 6-tuple — composed independently of the module under test. */
function rotScale(rad: number, sx: number, sy: number, tx = 0, ty = 0): number[] {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c * sx, s * sx, -s * sy, c * sy, tx, ty];
}

function expectClose(actual: readonly number[], expected: readonly number[], digits = 10): void {
  for (let i = 0; i < 6; i++) {
    expect(actual[i], `component ${i}`).toBeCloseTo(expected[i], digits);
  }
}

/** decompose → recompose must be the identity for any invertible matrix. */
function expectRoundTrip(m: readonly number[]): void {
  const d = decomposeMatrix(m);
  expect(d.singular).toBe(false);
  expectClose(recomposeInto(scratch, d), m, 12);
}

describe("canvas matrix decomposition", () => {
  it("round-trips scale, rotation, shear, a mirror, and all of them at once", () => {
    expectRoundTrip([2, 0, 0, 3, 0, 0]); // pure scale
    expectRoundTrip(rotScale(Math.PI / 3, 1, 1, 12, -4)); // pure rotation + translation
    expectRoundTrip([1, 0, 0.5, 1, 0, 0]); // pure skewX
    expectRoundTrip([-1, 0, 0, 1, 0, 0]); // horizontal MIRROR (negative determinant)
    expectRoundTrip([1, 0, 0, -1, 0, 0]); // vertical mirror
    expectRoundTrip([1.4, 0.2, -0.1, 0.9, 12, 34]); // arbitrary compound
    expectRoundTrip(rotScale(-2.1, 0.4, 1.9, 900, -220));
  });

  it("names the components CSS names, on the cases where they are unambiguous", () => {
    const scale = decomposeMatrix([2, 0, 0, 3, 40, 50]);
    expect([scale.scaleX, scale.scaleY, scale.rotate]).toEqual([2, 3, 0]);
    expect([scale.translateX, scale.translateY]).toEqual([40, 50]);

    const rot = decomposeMatrix(rotScale(Math.PI / 3, 1, 1));
    expect(rot.rotate).toBeCloseTo(Math.PI / 3, 12);
    expect(rot.scaleX).toBeCloseTo(1, 12);
    expect(rot.scaleY).toBeCloseTo(1, 12);

    // A mirror flips exactly ONE scale (the spec picks the axis by minimum unit-vector dot product) and leaves the
    // residual alone; flipping both would come back rotated by π instead of mirrored.
    const mirrored = decomposeMatrix([-1, 0, 0, 1, 0, 0]);
    expect(mirrored.scaleX).toBe(-1);
    expect(mirrored.scaleY).toBe(1);
    expect(mirrored.rotate).toBeCloseTo(0, 12);
  });

  it("flags a singular 2x2 rather than emitting NaNs", () => {
    expect(decomposeMatrix([0, 0, 0, 0, 100, 50]).singular).toBe(true);
    expect(decomposeMatrix([2, 0, 0, 0, 0, 0]).singular).toBe(true); // degenerate in ONE axis: a card scaled flat
    expect(decomposeMatrix([1, 0, 0, 1, 0, 0]).singular).toBe(false);
  });
});

describe("canvas matrix interpolation vs CSS", () => {
  it("a rotating+scaling tween sweeps the ANGLE and the SCALE, not the six numbers", () => {
    // identity → rotate(90°)·scale(2). Decomposed, the matrix at `t` is rotate(90°·t)·scale(1+t).
    const from = decomposeMatrix([1, 0, 0, 1, 0, 0]);
    const to = decomposeMatrix(rotScale(Math.PI / 2, 2, 2));
    expect(to.rotate).toBeCloseTo(Math.PI / 2, 12);
    expect(to.scaleX).toBeCloseTo(2, 12);
    expect(to.scaleY).toBeCloseTo(2, 12);

    for (const t of [0.25, 0.5, 0.75]) {
      expectClose(lerpDecomposedInto(scratch, from, to, t), rotScale((Math.PI / 2) * t, 1 + t, 1 + t));
    }

    // ...and the naive read disagrees, by a lot: halfway it produces a basis of length hypot(0.5, 1) ≈ 1.118
    // instead of 1.5 — a card that shrinks on its way round.
    const naive = lerpMatrix6Into([0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 0, 0], rotScale(Math.PI / 2, 2, 2), 0.5);
    const decomposed = lerpDecomposedInto([0, 0, 0, 0, 0, 0], from, to, 0.5);
    expect(matrix6Equal(naive, decomposed)).toBe(false);
    expect(Math.hypot(naive[0], naive[1])).toBeCloseTo(Math.hypot(0.5, 1), 12);
    expect(Math.hypot(decomposed[0], decomposed[1])).toBeCloseTo(1.5, 12);
    expect(Math.abs(naive[0] - decomposed[0])).toBeGreaterThan(0.3);
  });

  it("differs from the naive lerp for a pure 90° rotation too (no scale change to hide behind)", () => {
    const from = decomposeMatrix([1, 0, 0, 1, 0, 0]);
    const to = decomposeMatrix(rotScale(Math.PI / 2, 1, 1));
    const decomposed = lerpDecomposedInto([0, 0, 0, 0, 0, 0], from, to, 0.5);
    expectClose(decomposed, rotScale(Math.PI / 4, 1, 1)); // unit scale held all the way round
    const naive = lerpMatrix6Into([0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 0, 0], rotScale(Math.PI / 2, 1, 1), 0.5);
    expect(Math.hypot(naive[0], naive[1])).toBeCloseTo(Math.SQRT1_2, 12); // 0.707, a 29% shrink
    expect(matrix6Equal(naive, decomposed)).toBe(false);
  });

  it("agrees with the naive lerp exactly at the endpoints and for a translation-only pair", () => {
    const a = [1.4, 0.2, -0.1, 0.9, 12, 34];
    const b = rotScale(0.9, 2.2, 0.6, -80, 5);
    const from = decomposeMatrix(a);
    const to = decomposeMatrix(b);
    expectClose(lerpDecomposedInto(scratch, from, to, 0), a, 12);
    expectClose(lerpDecomposedInto(scratch, from, to, 1), b, 12);

    // A slide is the case the two paths must NOT disagree on: it is most of what the mirror animates, and a
    // divergence there would be a regression against the DOM path on every hand approach.
    const slideFrom = decomposeMatrix([1, 0, 0, 1, 100, 100]);
    const slideTo = decomposeMatrix([1, 0, 0, 1, 400, 260]);
    for (const t of [0.2, 0.5, 0.9]) {
      expectClose(
        lerpDecomposedInto(scratch, slideFrom, slideTo, t),
        lerpMatrix6Into([0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 100, 100], [1, 0, 0, 1, 400, 260], t),
        12
      );
    }
  });

  it("takes the SHORTER way round the circle", () => {
    // 170° → −170° is a 20° step across the ±180° seam, not a 340° spin back through zero.
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    expect(shortestRotationTarget(a, b)).toBeCloseTo((190 * Math.PI) / 180, 12);
    const mid = lerpDecomposedInto(scratch, decomposeMatrix(rotScale(a, 1, 1)), decomposeMatrix(rotScale(b, 1, 1)), 0.5);
    // Halfway is 180°, i.e. matrix(-1, 0, 0, -1) — NOT the identity a naive angle lerp through 0 would give.
    expectClose(mid, [-1, 0, 0, -1, 0, 0]);
  });

  it("falls back to DISCRETE interpolation when either endpoint is singular", () => {
    // Exactly what CSS does for a keyframe pair it cannot decompose — and why cardFlight.ts pins its keyframed
    // scale at 1e-4 instead of letting a pop reach zero.
    const from = decomposeMatrix([1, 0, 0, 1, 0, 0]);
    const gone = decomposeMatrix([0, 0, 0, 0, 500, 600]);
    expectClose(lerpDecomposedInto(scratch, from, gone, 0.49), [1, 0, 0, 1, 0, 0], 12);
    expectClose(lerpDecomposedInto(scratch, from, gone, 0.5), [0, 0, 0, 0, 500, 600], 12);
    expectClose(lerpDecomposedInto(scratch, from, gone, 1), [0, 0, 0, 0, 500, 600], 12);
    // A near-but-not-quite-zero scale stays continuous, which is the whole point of the 1e-4 pin.
    const tiny = decomposeMatrix([1e-4, 0, 0, 1e-4, 500, 600]);
    expect(tiny.singular).toBe(false);
    expect(lerpDecomposedInto(scratch, from, tiny, 0.5)[0]).toBeCloseTo((1 + 1e-4) / 2, 12);
  });
});
