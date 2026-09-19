// WHICH SPACE THE MIRROR'S DOM BOXES ARE LAID OUT IN — design px under one scaled stage (today), or real display
// px with an untransformed stage (the `?stageFit=display` arm).
//
// THE LEVER. `?stageFit=design` (the DEFAULT, today's behaviour) or `?stageFit=display`. Read ONCE at module load
// like `?stage=` in rendererFactory.ts — the space a frame is laid out in is a page-load decision by construction —
// and `__setStageFitForTest` lets vitest flip it without touching `window.location`. Anything unrecognised
// (absent, misspelled, `?stageFit=zoom`) resolves to "design": an unknown value must never cost a viewer their game
// screen.
//
// WHY THE DISPLAY ARM EXISTS. WebKit sizes a composited layer's backing store from `pageScale x deviceScale` ONLY
// and IGNORES an ancestor CSS transform scale (verified in `GraphicsLayerCA.cpp`: `contentsScale = pageScaleFactor *
// deviceScaleFactor()`, and `m_rootRelativeScaleFactor` is only ever set by the SVG engine). The mirror lays the
// stage out at 1920x1080 CSS and fits it with `transform: scale(~0.21)`, so on a dpr-3 phone every composited layer
// under the stage rasterises at 3x its UNSCALED design size — one full-stage layer is 5760x3240x4 = 74.6 MB. An
// iPhone 13 Pro measured WebContent at 2.93 GB against a 1536 MB jetsam limit and was killed, repeatedly. Sizing the
// BOXES in display px and dropping the stage transform makes each layer's backing store match the screen area it
// actually occupies. (Blink folds the ancestor transform into raster scale, so Android cannot reproduce the bug
// and cannot prove the fix. See `.agents/memory/webkit-scaled-ancestor-layer-blowup.md`.)
//
// THE ALGEBRA, and why it is this small. Every mirror node's element is `left: 0; top: 0; width: W; height: H;
// transform: matrix(a, b, c, d, e, f); transform-origin: 0 0` — position is carried ENTIRELY by the matrix, in px,
// and size entirely by W/H, in px. Display space is therefore design space CONJUGATED by `scale(S)`:
//
//     W' = W·S,  H' = H·S,  matrix' = [a, b, c, d, e·S, f·S]
//
// The LINEAR part (a, b, c, d) is a node's own scale/rotation/skew and is dimensionless — it must NOT be touched.
// Only the TRANSLATION carries px. Conjugation composes: for a child re-based against its parent
// (`parentInv · childGlobal`), `S·P⁻¹·S⁻¹ · S·C·S⁻¹ = S·(P⁻¹·C)·S⁻¹`, i.e. the re-based matrix conjugates by the
// same rule. So one rule — "every px length x S, every matrix translation x S, everything dimensionless untouched"
// — covers the whole tree, and `scaleAffineTranslation` / `px` / `pxCss` below are the only places it is spelled.
//
// WHAT STAYS IN DESIGN SPACE. Everything that is not a CSS px write: the wire, the walk, the interactive rects, the
// spread/anchor algebra, the view-scale stamps and their input inverse, the raise inverse, the hover-tip stamps,
// the eager-scroll offsets, `pointerMap`. Those are all pure design-space arithmetic with no DOM read or write in
// them, so they are space-INVARIANT and this arm does not touch them. `pointerMap` in particular resolves a pointer
// through FRACTIONS of the stage's `getBoundingClientRect()`, which reports the same rendered box in both arms.
// The boundary this module guards is exactly: (1) a px value written into the DOM, and (2) a length MEASURED back
// out of the DOM by a transform-blind API (`clientWidth` / `ResizeObserver`), which reads design px today and
// display px on this arm — see `staticPin.ts`.
//
// THE ROUNDING DECISION, MADE ONCE, HERE: **THERE IS NONE.** Design coordinates times a non-integral fit scale do
// not land on integer CSS px, let alone integer DEVICE px, and the temptation is to snap them. Do not:
//
//   * Today's geometry is ALREADY fractional in device px. The stage transform multiplies every design coordinate
//     by the same non-integral fit scale before rasterisation, so `design·S` is exactly the device position the
//     default arm already rasterises at. Emitting `design·S` unrounded reproduces the default arm's rendered
//     geometry EXACTLY; any snap is a deliberate divergence from the arm we are trying to be visually identical to.
//   * Snapping is what CAUSES seams, not what cures them. Two abutting boxes share an exact design edge, so
//     `x·S` and `(x+w)·S` agree to the last ulp and the boxes still abut. Rounding a POSITION and a SIZE
//     independently (`round(x·S)` and `round(w·S)`) makes the shared edge disagree by up to one device px — a
//     visible hairline between every nine-patch slice and every sibling fill.
//   * There is nowhere honest to snap TO. A box's device position depends on its whole ancestor matrix chain
//     (`scale`, rotation, a tween mid-flight) and on `devicePixelRatio`, none of which are in hand at the one place
//     a length is stringified. Per-site rounding would be exactly the "scattered rounding" that seams sprites.
//
// So `px`/`pxCss` multiply and stop. The existing `affineCss` already emits full precision for the same reason.
// If a future measurement shows a real snapping need, it belongs HERE, applied to the composed device-space
// geometry — not to individual lengths at their emission sites.
//
// PARITY BY CONSTRUCTION. On the design arm `layoutScale()` is exactly 1 and every helper short-circuits to its
// input, so the default arm emits byte-identical strings and matrices. That is the property the whole change rests
// on: the lever is off by default, and off means untouched.

import type { Affine } from "@/mirror/affine";

export type StageFitMode = "design" | "display";

// `?stageFit=design|display`. Anything else resolves to "design".
function readStageFit(): StageFitMode {
  if (typeof window === "undefined") {
    return "design";
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("stageFit") === "display" ? "display" : "design";
}

// `?stage=canvas` is read HERE, directly, rather than imported from rendererFactory — for two reasons, both hard:
//   * CYCLE. rendererFactory pulls in the canvas backend, which pulls in nodeStyles, which pulls in this module.
//   * ORDERING. The grant has to be settled at MODULE LOAD, not at MirrorView's setup: `shaderResources.ts`
//     evaluates its gsw mount options (and with them `staticShaderPinRatio()`, which reads `displaySpaceLayout()`)
//     at import time, i.e. strictly before any component mounts. A grant that arrived later would seed every
//     shader/particle binding at the wrong backing density and rely on a re-push to correct it.
// MirrorView still calls `activateDisplayLayout` at setup, which can only REVOKE — that is what keeps a spec's
// `__setStageBackendForTest("canvas")` honest, since a test seam cannot move the URL this read saw.
function canvasBackendRequested(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return new URLSearchParams(window.location.search).get("stage") === "canvas";
}

let mode: StageFitMode = readStageFit();

// REQUESTED vs IN FORCE — the same shape `rendererFactory` uses for `?stage=`. `?stageFit=display` is a REQUEST, and
// MirrorView grants it only on the DOM backend: the canvas backend has no scaled DOM subtree (its single <canvas>
// already lays out untransformed in `.mirror-canvas-host`), so it has none of the layer blow-up to fix — and its
// runtime reads the stage's DESIGN box straight off `stage.clientWidth` (`renderer/canvas/stageRuntime.ts`), which
// display-px boxes would silently turn into the identity. Ungranted, this module stays at its shipped defaults and
// the canvas arm is untouched by construction.
let active = mode === "display" && !canvasBackendRequested();

// The live design→display factor. ALWAYS exactly 1 unless the display layout is in force, whatever MirrorView
// measures: that is what makes every `x * layoutScale()` a bit-identical no-op on the default arm (`x * 1 === x` for
// every double, -0 and NaN included).
let layout = 1;

/** The arm this page asked for (before the backend grant) — for diagnostics and the bench harness. */
export function stageFitMode(): StageFitMode {
  return mode;
}

/** True when DOM boxes are actually being written in display px and `.mirror-stage` carries no scale transform. */
export function displaySpaceLayout(): boolean {
  return active;
}

/**
 * MirrorView's grant: may the requested display layout actually take effect here? Called once at setup with
 * `false` on the canvas backend. Revoking always resets the factor to 1, so a revoked arm is the default arm.
 */
export function activateDisplayLayout(granted: boolean): void {
  active = granted && mode === "display";
  if (!active) {
    layout = 1;
  }
}

/**
 * The live design→display factor: 1 on the design arm, the stage's fit scale on the display arm.
 *
 * Read per emission rather than passed down: it changes only on a viewport resize, and every consumer already
 * re-runs on the forced full walk MirrorView schedules for that (`"stageFit"`).
 */
export function layoutScale(): number {
  return layout;
}

/**
 * MirrorView's fit measurement, offered to the layout. IGNORED on the design arm — the factor stays 1 there by
 * construction, so no measurement can perturb the default. Returns TRUE when the factor actually moved and the
 * caller must force a full restyle walk (every node's box and matrix are derived from it).
 *
 * A non-finite or non-positive fit is refused rather than latched: a zero factor would collapse the whole stage to
 * nothing, and MirrorView can legitimately measure one before the frame has a box.
 */
export function setLayoutScale(fit: number): boolean {
  if (!active) {
    return false;
  }
  if (!Number.isFinite(fit) || fit <= 0 || fit === layout) {
    return false;
  }
  layout = fit;
  return true;
}

/** A design-space LENGTH in the space the DOM is laid out in. */
export function px(value: number): number {
  return layout === 1 ? value : value * layout;
}

/** A design-space length as a CSS px string — the one stringifier for every box/font/border/offset emission. */
export function pxCss(value: number): string {
  return layout === 1 ? `${value}px` : `${value * layout}px`;
}

/**
 * The INVERSE of `px`: a length MEASURED in the space the DOM is laid out in, back in design space.
 *
 * For the readers, not the writers — the handful of places that pull a length back out of the DOM (a computed
 * `translate`, the stage's own inline width, a composed element chain) and then compare it against a WIRE
 * coordinate. Those comparisons are design-space by definition (the wire never moves), so a display-px measurement
 * has to come back before it can be used. See `createDomMirrorRenderer`'s `drawnGlobalOfElement` and
 * `handController`'s hitbox test.
 */
export function designPx(value: number): number {
  return layout === 1 ? value : value / layout;
}

/**
 * A design-space affine re-expressed in layout space: the linear part is dimensionless and carries through
 * untouched, the translation is a length and scales. Allocates a fresh tuple only when the factor is not 1, so the
 * design arm hands back the very matrix it was given (no copy, no float traffic).
 */
export function scaleAffineTranslation(m: Affine): Affine {
  return layout === 1 ? m : [m[0], m[1], m[2], m[3], m[4] * layout, m[5] * layout];
}

/**
 * `scaleAffineTranslation` IN PLACE, for the CSS stringifiers that own a transient scratch tuple (nodeStyles'
 * `PLACEMENT_SCRATCH`) and consume it into a string before returning. Same rule, no allocation — which matters:
 * this runs once per node per full restyle, and a full restyle is exactly what a resize forces on this arm.
 * Never hand it a matrix anything RETAINS (see affine.ts's `affineMulInto` warning).
 */
export function scaleAffineTranslationInPlace(m: Affine): Affine {
  if (layout !== 1) {
    m[4] *= layout;
    m[5] *= layout;
  }
  return m;
}

/**
 * TEST ONLY: pick the arm AND grant it (never called in production) — a spec asking for the display arm always
 * means the DOM backend, which is the only one that can be granted. Resets the factor, like a fresh page load.
 */
export function __setStageFitForTest(next: StageFitMode): void {
  mode = next;
  active = next === "display";
  layout = 1;
}

/** TEST ONLY: back to the shipped default. */
export function __resetStageFitForTest(): void {
  mode = "design";
  active = false;
  layout = 1;
}
