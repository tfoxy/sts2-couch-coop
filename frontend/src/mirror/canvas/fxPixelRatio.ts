import { MAX_SURFACE_PIXEL_RATIO } from "@godot-scene-web/html";

// THE MAGNIFICATION AN FX SURFACE IS DRAWN AT, and the number the mirror hands gsw so it can size a
// backing store for it. Pure arithmetic — no DOM, no layout read (see `particleVisibleRect.ts`, the
// same rule for the same reason).
//
// WHY THE HOST HAS TO SAY IT. Both gsw fx runtimes size a surface's store from
// `selfLayer.clientWidth × (devicePixelRatio × renderScale)`, and `clientWidth` is blind to ancestor
// CSS transforms: a node under a `transform: scale(1.4)` ancestor lays out at its untransformed
// width and gets a store sized for 1/1.4 of the device pixels it is magnified onto. Nothing gsw can
// read off its own element says otherwise — the transform belongs to an ancestor it does not own,
// and finding it would be a `getBoundingClientRect()` walk per surface per frame. The mirror already
// composed that transform to place the quad, so it states it in
// `data-godot-shader-pixel-ratio` (gsw's `SURFACE_PIXEL_RATIO_ATTR`) and gsw multiplies it in.
//
// FOUR RULES, and each one is a decision:
//
//   AXIS, NOT AABB. The magnification is the mean of the matrix's two COLUMN NORMS — the same
//   `(hypot(m0,m1) + hypot(m2,m3)) / 2` the text raster uses (`paintSpec.ts`), and for the reason
//   stated there: a surface under a non-uniform scale is drawn at neither axis alone. It is
//   emphatically NOT `getBoundingClientRect().width / cssWidth`, which is the AXIS-ALIGNED BOUNDING
//   BOX of the transformed quad and therefore `|cos θ| + |sin θ|` too wide for a ROTATED surface —
//   up to √2 at 45°, with not one extra device pixel underneath it. Rotation is rigid: it changes
//   where a surface's texels land, never how many of them the screen has room for. Measured on the
//   live combat page: three sibling 220x220 particle surfaces, all at scale 1, rotated 15°, 45° and
//   0°, whose AABB ratios are 1.2247, 1.4142 and 1.0000 — three different "magnifications" for three
//   identically-sized surfaces. Sizing to those would have cost the 45° one twice its area for
//   nothing.
//
//   FIT SCALE EXCLUDED. The stage's own fit-to-screen factor reaches gsw already, as the
//   `renderScale` the mirror passes it (`perDesignPx`, i.e. `stageScale × stagePixelRatio`), so
//   folding it in here would apply it twice. What is left is exactly the node's own accumulated
//   design-space scale, which is what `OverlayRecord.transform` carries.
//
//   MAGNIFICATION ONLY. Clamped to >= 1: a MINIFIED surface is over-resolved, which costs memory and
//   fill but loses no picture, and shrinking a live store to reclaim that is a different change with
//   a different risk (it re-allocates, and under the frozen-surface swap it retires a stand-in).
//   This round fixes soft, not fat.
//
//   QUANTISED UP, to 1/8 steps. Every distinct value gsw sees is a backing-store reallocation, a
//   cleared canvas and — under the image swap — a retired stand-in `<img>`. A node easing through a
//   scale would otherwise hand it a new number every frame. 1/8 is gsw's own step and the census's
//   slack (`FX_UNDER_RESOLVED_SLACK`), so a surface sized at the quantised value can never read as
//   under-resolved. Rounding UP, never to nearest: rounding √2 down to 1.375 would leave the surface
//   short of the pixels it covers, which is the bug.

/** A 2x3 column-major affine, as `affine.ts` defines it. Duplicated as a structural type so this
 *  module stays importable by a test that has no renderer. */
type Mat = readonly number[];

/**
 * gsw's `SURFACE_PIXEL_RATIO_ATTR`, read off the SELF-LAYER by BOTH its fx runtimes (the shader one
 * in `updateBinding`, the particle one per reconcile). Spelled out here rather than imported for the
 * same reason `data-godot-shader-uv-window` and `data-godot-particle-visible-rect` are spelled out
 * in `mirrorRenderer`: these attribute names are the wire between the two repos, and a literal at
 * each end is what lets either side move without the other's build breaking. It is co-owned — see
 * godot-scene-web's `packages/html/src/webgl/shared-gl.ts`.
 */
export const FX_PIXEL_RATIO_ATTR = "data-godot-shader-pixel-ratio";

/** gsw's own ceiling on the attribute. Keeping the local name preserves the mirror's test and URL
 * contract while taking its value from the renderer that consumes the attribute. */
export const FX_PIXEL_RATIO_MAX = MAX_SURFACE_PIXEL_RATIO;

/** The quantisation step the attribute is written in. */
export const FX_PIXEL_RATIO_STEP = 1 / 8;

/**
 * The mean-axis linear scale of an affine's 2x2 — how much bigger, on average over its two axes, a
 * shape drawn through it lands on screen. Rotation-invariant BY CONSTRUCTION, which is the whole
 * point (see the header).
 */
export function fxAxisScale(m: Mat): number {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
    return 1;
  }
  return (sx + sy) / 2;
}

/**
 * The attribute string for a node drawn at `scale`, or NULL for a surface that needs none — i.e.
 * anything at or below 1:1, which is gsw's byte-identical off-switch (an absent attribute parses to
 * exactly 1 there).
 *
 * A non-finite scale is NOT a magnification claim and returns null; letting a NaN through would
 * reach gsw as an unparseable attribute, which it also resolves to 1, but only after a reallocation
 * and a stand-in retirement on the way in.
 */
export function fxPixelRatioAttrValue(scale: number): string | null {
  if (!Number.isFinite(scale) || scale <= 1) {
    return null;
  }
  const stepped = Math.ceil(scale / FX_PIXEL_RATIO_STEP) * FX_PIXEL_RATIO_STEP;
  const clamped = Math.min(stepped, FX_PIXEL_RATIO_MAX);
  if (clamped <= 1) {
    return null;
  }
  // 3 decimals is exact for every 1/8 step and keeps the string a stable compare key.
  return String(Number(clamped.toFixed(3)));
}

/** Per-surface state for the AT-REST gate below. One object per overlay element, mutated in place. */
export interface FxPixelRatioGate {
  /** The value currently ON the DOM (null = the attribute is absent). */
  applied: string | null;
  /** The value the PREVIOUS build computed, whether or not it was written. */
  seen: string | null;
  /** Has any build been observed yet? Distinguishes "first build" from "last build saw null". */
  primed: boolean;
}

export function createFxPixelRatioGate(): FxPixelRatioGate {
  return { applied: null, seen: null, primed: false };
}

/**
 * THE AT-REST GATE. Returns the value to WRITE this build, or `undefined` for "leave the DOM alone".
 *
 * A node whose scale is moving must not stream its magnification to gsw: every distinct value is a
 * reallocation, a cleared canvas and a retired stand-in, so a 300 ms scale-up would cost ~18 of each
 * and land on the value it would have reached anyway. So a value is committed only once TWO
 * consecutive builds agree on it — which is exactly "unchanged since the last build", the cheapest
 * honest test for at rest that needs no tween-loop coupling — and while they disagree the previously
 * applied value stands.
 *
 * Consequences worth naming:
 *   * a node that mounts already magnified pays ONE build of delay before its store grows, during
 *     which it is exactly as resolved as it is today;
 *   * a node easing 1.0 -> 1.4 writes nothing until it settles, then writes once;
 *   * a node easing back DOWN to 1.0 keeps the larger store until it settles, then drops the
 *     attribute — over-resolved for the ramp, never under.
 */
export function fxPixelRatioWrite(
  gate: FxPixelRatioGate,
  next: string | null
): string | null | undefined {
  const atRest = gate.primed && gate.seen === next;
  gate.seen = next;
  gate.primed = true;
  if (!atRest || next === gate.applied) {
    return undefined;
  }
  gate.applied = next;
  return next;
}
