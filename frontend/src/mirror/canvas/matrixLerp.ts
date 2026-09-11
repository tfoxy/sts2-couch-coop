// CSS-SEMANTICS MATRIX INTERPOLATION, as numbers.
//
// The DOM mirror never interpolates a transform itself: it writes two `matrix(...)` endpoints and lets the browser
// run the CSS transition between them. That interpolation is NOT a lerp of the six numbers — CSS DECOMPOSES both
// endpoints into a translation, a rotation, a pair of scales and a residual 2×2 (the shear), interpolates those
// COMPONENTS, and recomposes (css-transforms-1 §decomposing-a-2d-matrix / §recomposing-to-a-2d-matrix, which is
// the normative algorithm every engine implements). The difference is visible from the first rotating tween:
// naively lerping `matrix(1,0,0,1,…)` → `matrix(0,2,-2,0,…)` passes through a matrix whose basis is 1.118 long
// instead of 1.5, i.e. a card that SHRINKS on its way round, where the decomposed path holds the scale ramp and
// sweeps the angle.
//
// A canvas renderer computes every frame itself, so it has to own that math. This module is the whole of it:
// decompose ONCE per endpoint at arm time (the components are constants for the tween's life), lerp the
// components per sample, recompose into a caller-owned 6-tuple. No allocation per sample.
//
// SINGULAR ENDPOINTS. A matrix whose 2×2 has a zero determinant cannot be decomposed (there is no scale/rotation
// that produces a collapsed basis), and CSS falls back to DISCRETE interpolation for such a pair — the `from`
// matrix until the halfway point, the `to` matrix after it. That is exactly why `cardFlight.ts` pins its
// keyframed scale at `FLIGHT_MIN_KEYFRAME_SCALE` (1e-4) rather than letting a pop reach zero: a scale-0 keyframe
// would make the whole pair discrete and the card would jump instead of shrinking. We carry the same guard, so a
// caller that DOES hand us a degenerate endpoint gets the browser's answer rather than NaNs.

/** A CSS `matrix()` 6-tuple `[a, b, c, d, e, f]`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
export type Matrix6 = readonly number[];

/**
 * One endpoint's decomposed components, in the CSS spec's own terms.
 *
 * The recomposition is `translate · rotate · [m11 m12; m21 m22] · scale`, so `rotate` (RADIANS here, where the
 * spec uses degrees — every angle in the mirror's transform math is radian-space) and `scaleX`/`scaleY` carry the
 * parts that must be interpolated ANGULARLY and MULTIPLICATIVELY, while the residual 2×2 carries the shear and is
 * interpolated component-wise. `scaleX` or `scaleY` is negative exactly when the source basis was flipped.
 *
 * `singular` is set when the source 2×2 had a (near-)zero determinant — the pair must then interpolate
 * DISCRETELY, and every other field is meaningless.
 */
export interface DecomposedMatrix {
  translateX: number;
  translateY: number;
  rotate: number;
  scaleX: number;
  scaleY: number;
  /** The residual 2×2 left after the rotation and scale are divided out: the shear, plus rounding. */
  m11: number;
  m12: number;
  m21: number;
  m22: number;
  singular: boolean;
  /** The source matrix, retained verbatim so the discrete fallback can hand it straight back. */
  source: [number, number, number, number, number, number];
}

// Below this |determinant| the 2×2 is treated as non-invertible. Matches `affineInverse`'s own threshold, which is
// what the rest of the mirror already calls "singular" — a matrix that cannot be inverted for placement cannot be
// decomposed for interpolation either. One definition, two consumers.
const SINGULAR_DET_EPS = 1e-9;

/** An identity, non-singular decomposition — for callers that preallocate and reuse. */
export function createDecomposedMatrix(): DecomposedMatrix {
  return {
    translateX: 0,
    translateY: 0,
    rotate: 0,
    scaleX: 1,
    scaleY: 1,
    m11: 1,
    m12: 0,
    m21: 0,
    m22: 1,
    singular: false,
    source: [1, 0, 0, 1, 0, 0]
  };
}

/**
 * Decompose `m` into `out`, following css-transforms-1's 2D decomposition step for step. Returns `out`.
 *
 * Read it together with `recomposeInto` below — they are one algorithm, and the order the components recompose in
 * (`translate · rotate · residual · scale`) is what makes each of them mean anything.
 */
export function decomposeMatrixInto(out: DecomposedMatrix, m: Matrix6): DecomposedMatrix {
  let row0x = m[0];
  let row0y = m[1];
  let row1x = m[2];
  let row1y = m[3];
  out.source[0] = row0x;
  out.source[1] = row0y;
  out.source[2] = row1x;
  out.source[3] = row1y;
  out.source[4] = m[4];
  out.source[5] = m[5];
  out.translateX = m[4];
  out.translateY = m[5];

  const determinant = row0x * row1y - row0y * row1x;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < SINGULAR_DET_EPS) {
    out.singular = true;
    out.rotate = 0;
    out.scaleX = 1;
    out.scaleY = 1;
    out.m11 = 1;
    out.m12 = 0;
    out.m21 = 0;
    out.m22 = 1;
    return out;
  }
  out.singular = false;

  let scaleX = Math.sqrt(row0x * row0x + row0y * row0y);
  let scaleY = Math.sqrt(row1x * row1x + row1y * row1y);

  // A negative determinant means ONE axis was flipped. The spec flips the axis with the minimum unit-vector dot
  // product, which is this comparison written out — and flipping exactly one (not both) is what makes a mirror
  // round-trip through the recomposition instead of coming back rotated by π.
  if (determinant < 0) {
    if (row0x < row1y) {
      scaleX = -scaleX;
    } else {
      scaleY = -scaleY;
    }
  }

  // Renormalize to remove the scale.
  if (scaleX !== 0) {
    row0x /= scaleX;
    row0y /= scaleX;
  }
  if (scaleY !== 0) {
    row1x /= scaleY;
    row1y /= scaleY;
  }

  const angle = Math.atan2(row0y, row0x);
  if (angle !== 0) {
    // Divide the rotation out FROM THE LEFT: the recomposition is `R · residual · S`, so the residual is
    // `R⁻¹ · L`. Thanks to the normalization above, `cos = row0x` and `sin = row0y` are already in hand, so
    // `R⁻¹ = [cos, −sin, sin, cos]` needs no trig. (Deriving it this way rather than transcribing the spec's
    // pseudocode is deliberate — it is the exact inverse of `recomposeInto` by construction, which is what the
    // round-trip spec asserts across mirrors, shears and compounds.)
    const cs = row0x;
    const sn = row0y;
    const a11 = row0x;
    const a12 = row0y;
    const a21 = row1x;
    const a22 = row1y;
    row0x = cs * a11 + sn * a12;
    row0y = -sn * a11 + cs * a12;
    row1x = cs * a21 + sn * a22;
    row1y = -sn * a21 + cs * a22;
  }

  out.rotate = angle;
  out.scaleX = scaleX;
  out.scaleY = scaleY;
  out.m11 = row0x;
  out.m12 = row0y;
  out.m21 = row1x;
  out.m22 = row1y;
  return out;
}

/** Decompose `m` into a fresh record — the non-hot-path convenience over `decomposeMatrixInto`. */
export function decomposeMatrix(m: Matrix6): DecomposedMatrix {
  return decomposeMatrixInto(createDecomposedMatrix(), m);
}

/** The component set `recomposeInto` consumes — everything a `DecomposedMatrix` carries except the bookkeeping. */
export interface MatrixComponents {
  translateX: number;
  translateY: number;
  rotate: number;
  scaleX: number;
  scaleY: number;
  m11: number;
  m12: number;
  m21: number;
  m22: number;
}

/** Recompose `translate · rotate · [m11 m12; m21 m22] · scale` into the caller-owned 6-tuple `out`. */
export function recomposeInto(out: number[], c: MatrixComponents): number[] {
  const cos = Math.cos(c.rotate);
  const sin = Math.sin(c.rotate);
  // rotate · residual
  const rm0 = cos * c.m11 - sin * c.m12;
  const rm1 = sin * c.m11 + cos * c.m12;
  const rm2 = cos * c.m21 - sin * c.m22;
  const rm3 = sin * c.m21 + cos * c.m22;
  // · scale
  out[0] = rm0 * c.scaleX;
  out[1] = rm1 * c.scaleX;
  out[2] = rm2 * c.scaleY;
  out[3] = rm3 * c.scaleY;
  out[4] = c.translateX;
  out[5] = c.translateY;
  return out;
}

/**
 * The shorter of the two ways round from `from` to `to`, as an equivalent `to` angle.
 *
 * CSS does this on the DEGREE values before interpolating (`if |from − to| > 180, pull the larger one down by
 * 360`), which is what stops a 170° → −170° transition spinning almost all the way round through zero.
 */
export function shortestRotationTarget(from: number, to: number): number {
  const TAU = Math.PI * 2;
  let delta = (to - from) % TAU;
  if (delta > Math.PI) {
    delta -= TAU;
  } else if (delta < -Math.PI) {
    delta += TAU;
  }
  return from + delta;
}

// The lerp's own scratch: one per module, consumed by `recomposeInto` before anything else can observe it.
const lerpScratch: MatrixComponents = {
  translateX: 0,
  translateY: 0,
  rotate: 0,
  scaleX: 1,
  scaleY: 1,
  m11: 1,
  m12: 0,
  m21: 0,
  m22: 1
};

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolate two DECOMPOSED endpoints at `t` (already EASED — this is a plain lerp of components) into the
 * caller-owned 6-tuple `out`. Returns `out`.
 *
 * DISCRETE FALLBACK: if either endpoint is singular the pair cannot be decomposed, so CSS steps — `from` while
 * `t < 0.5`, `to` from there on. Callers get exactly what the browser would have painted.
 */
export function lerpDecomposedInto(
  out: number[],
  from: DecomposedMatrix,
  to: DecomposedMatrix,
  t: number
): number[] {
  if (from.singular || to.singular) {
    const src = t < 0.5 ? from.source : to.source;
    out[0] = src[0];
    out[1] = src[1];
    out[2] = src[2];
    out[3] = src[3];
    out[4] = src[4];
    out[5] = src[5];
    return out;
  }
  lerpScratch.translateX = mix(from.translateX, to.translateX, t);
  lerpScratch.translateY = mix(from.translateY, to.translateY, t);
  lerpScratch.rotate = mix(from.rotate, shortestRotationTarget(from.rotate, to.rotate), t);
  lerpScratch.scaleX = mix(from.scaleX, to.scaleX, t);
  lerpScratch.scaleY = mix(from.scaleY, to.scaleY, t);
  lerpScratch.m11 = mix(from.m11, to.m11, t);
  lerpScratch.m12 = mix(from.m12, to.m12, t);
  lerpScratch.m21 = mix(from.m21, to.m21, t);
  lerpScratch.m22 = mix(from.m22, to.m22, t);
  return recomposeInto(out, lerpScratch);
}

/**
 * The naive read this module exists NOT to be: a straight lerp of the six numbers. Exported only so the specs can
 * assert the two genuinely disagree mid-tween (they agree exactly at t = 0 and t = 1, and for a translation-only
 * pair everywhere). Never call it to paint.
 */
export function lerpMatrix6Into(out: number[], from: Matrix6, to: Matrix6, t: number): number[] {
  for (let i = 0; i < 6; i++) {
    out[i] = from[i] + (to[i] - from[i]) * t;
  }
  return out;
}

/** True when two 6-tuples are component-wise identical. The mirror's "did the streamed pose CHANGE?" test. */
export function matrix6Equal(a: Matrix6 | null, b: Matrix6 | null): boolean {
  if (a == null || b == null) {
    return a === b;
  }
  return (
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5]
  );
}
