// THE STATIC BACKING PIN — the device-target density the mirror hands gsw for its FROZEN (static) shader and
// particle surfaces (`staticShaderPixelRatio` / `staticParticlePixelRatio`, gsw @9628685).
//
// WHAT GSW'S PIN DOES: while a runtime is FROZEN, a binding's backing store is sized `contentBox × window × PIN`
// instead of `contentBox × window × devicePixelRatio × renderScale`, clamped to MAX_PINNED_BACKING_DIM on its
// longest edge (aspect preserved). The pin REPLACES the density term — it is not multiplied by dpr, so dpr is
// baked into the number computed here. `setRenderScale` then re-sizes only LIVE bindings; the frozen set stops
// moving with any fit-derived or adaptive-quality step. A live (animated) binding is NEVER pinned.
//
// WHY THE MIRROR WANTS IT — and the box-space fact that decides the algebra:
//
//   The mirror lays every node out in design px (`nodeStyles` writes local-box widths and the stage
//   is `design.w × design.h` px) and fits the whole stage to the viewport with a CSS TRANSFORM
//   (`MirrorView`'s `transform: scale(fitScale)`). gsw measures a binding's box with `clientWidth` /
//   `ResizeObserver.contentRect` — BOTH of which are layout reads that ignore ancestor transforms. So in this
//   host `contentBox === designBox`, and today's frozen backing store is
//
//       designBox × devicePixelRatio × renderScale
//
//   MEASURED, not inferred (Chrome 151, a 1920×1080 layout box under a `transform: scale()` ancestor):
//   `clientWidth` and the `ResizeObserver` contentRect both read 1920 at scale 0.38 AND at scale 0.9, while
//   `getBoundingClientRect()` moved 729.6 → 1728; an ALREADY-ATTACHED observer did not fire at all on the
//   transform change, but did fire on a real layout width change (1920 → 2520).
//
//   So the frozen backing store here is ALREADY independent of the fit scale, and the pinned ratio below is
//   deliberately NOT divided by the live fit scale: dividing would make the backing store move with the fit,
//   i.e. manufacture exactly the churn the pin exists to remove. (A host that RE-LAYOUTS its boxes on a fit
//   change — CSS boxes in real px —
//   would need `K / fitScale`; the mirror is not that host. The one place the mirror does move boxes is the
//   widescreen stretch, which re-runs the anchor algebra for full-bleed anchored nodes — those genuinely change
//   width, and a frozen canvas still follows them. The pin holds the DENSITY axis only.)
//
//   What the pin buys, then, is that the density term stops being wrong. `devicePixelRatio` converts CSS px to
//   device px — but the design box is NOT displayed at 1 design px per CSS px: it is displayed at `fitScale` of
//   that. On a phone (fitScale ≈ 0.38) today's frozen canvases are ~1/fitScale ≈ 2.6× oversized per axis versus
//   the pixels they actually occupy, so the tier's `renderScale = 0.5` ("render at half device resolution")
//   really renders at ~1.3× device resolution. The pin below sizes a frozen surface at the density it will be
//   SHOWN at when the game is played the way it is going to be played — fullscreen, landscape — times the
//   family's static-mode render scale.
//
// THE TARGET (K): `fitScaleAtFullscreenLandscape × devicePixelRatio × staticScale(family)`.
//
//   `fitScaleAtFullscreenLandscape` is what `MirrorView`'s own fit computation would produce for a landscape
//   viewport the size of this device's screen — see `targetFitScale`. Deliberately NOT the live fit: a phone
//   held in portrait, a browser that is not fullscreen yet, and a widescreen-stretch toggle must not each
//   re-size (and therefore re-render, and re-key the static-frame cache of) the whole frozen fleet. The user's
//   framing: "most likely the game is going to be played in landscape mode at fullscreen with widescreen
//   stretch in any device (phone or desktop)", and "I value a smooth animation more than presenting elements at
//   quality when using static shaders" — a frozen surface shown at a size it was not rendered at (browser-scaled,
//   softer or sharper) is the accepted trade.
//
// HONEST SCOPE — what this is measured to remove. An instrumented 60s session on the target phone (Moto G86,
// recorded combat, own tab) measured `canvasReallocs: 18` across 26 shader nodes, ALL inside the first ~15s and
// flat thereafter, with 0 adaptive-quality events; replaying 12 recorded sessions through the real parser showed
// `localRect` never changing on any of 1,258 shader nodes. So the churn this removes is the STARTUP TRANSIENT,
// rotation and fullscreen entry — NOT a steady-state speedup. The steady-state effect is the density correction
// above (fewer frozen pixels per re-render on a phone, more on a hi-dpi desktop that picks Static by hand), and
// making a future "swap a settled frozen surface to a plain <img>" safe by giving it a size that stops moving.

import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH } from "@/mirror/sceneTree";
import { renderQuality } from "@/render/quality";

/** A landscape viewport must cover at least this much of the screen's long AND short edge to count as a
 *  "real fullscreen-landscape" measurement allowed to CORRECT the `screen.*` seed downward. Browser chrome in
 *  landscape typically eats ~10-15% of the short edge, so a windowed/chromed viewport stays a ratchet-only
 *  observation (it can still raise K, never lower it). */
const FULLSCREEN_COVER_RATIO = 0.9;

/** Fit-scale changes below this are noise (sub-pixel on a 2520-wide stage) and must not re-push a ratio. */
const FIT_EPSILON = 1e-4;

/**
 * The stage fit scale for a viewport of `width × height`, matching `MirrorView`'s own fit
 * (`min(frameW / design.w, frameH / design.h)`) for BOTH widescreen-stretch states.
 *
 * With the stretch OFF the design box is 1920×1080, so the fit is `min(long/1920, short/1080)`. With it ON the
 * design box widens to the viewport aspect (capped at MIRROR_MAX_DESIGN_WIDTH), which makes the fit exactly
 * `short/1080` on any viewport at least 16:9 — and that IS `min(long/1920, short/1080)` there, because
 * `long/1920 ≥ short/1080 ⟺ long/short ≥ 16/9`. Below 16:9 the stretch clamps back to 1920 and the two agree
 * again. One formula covers both, so toggling the stretch never moves the pin.
 *
 * Returns 0 for a degenerate/unknown viewport (the caller then pushes no pin).
 */
export function targetFitScale(width: number, height: number): number {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (!(long > 0) || !(short > 0) || !Number.isFinite(long) || !Number.isFinite(short)) {
    return 0;
  }
  return Math.min(long / MIRROR_DESIGN_WIDTH, short / MIRROR_DESIGN_HEIGHT);
}

export interface StaticPinTracker {
  /** The current landscape-fullscreen fit target (0 = unknown; no pin is pushed). */
  targetFit(): number;
  /** Whether a real fullscreen-landscape measurement has replaced the `screen.*` seed. */
  isCorrected(): boolean;
  /**
   * Feed a live viewport (the mirror frame's box) measurement. Returns TRUE when the target moved and the
   * caller must re-push the pin. The rules, in order:
   *   • PORTRAIT / degenerate ⇒ ignored entirely. A phone held in portrait says nothing about the landscape
   *     fullscreen target, and letting it lower K is precisely the churn this removes.
   *   • RATCHET UP: any landscape measurement whose fit exceeds the current target raises it. Safe in every
   *     case — the device demonstrably renders that big.
   *   • CORRECT DOWN, ONCE: the first landscape measurement that really is fullscreen (`fullscreen`, or a
   *     viewport covering ≥ FULLSCREEN_COVER_RATIO of the seeded screen on both axes) REPLACES the seed even
   *     if smaller, because `screen.*` is CSS px and unreliable across browsers, notches and gesture bars.
   *     After that the target is STICKY: leaving fullscreen or rotating to portrait never lowers it.
   */
  observeViewport(width: number, height: number, fullscreen?: boolean): boolean;
  /** The ratio to hand gsw for a family whose STATIC-mode render scale is `staticScale`, or undefined when
   *  the target is still unknown (undefined = gsw's un-pinned path). */
  ratioFor(staticScale: number): number | undefined;
}

export interface StaticPinInputs {
  /** The device screen in CSS px — the SEED (a guess: unreliable across browsers/notches/gesture bars). */
  screen?: { width: number; height: number } | null;
  /** Read lazily so a page-zoom / monitor move is picked up by the next push instead of being latched. */
  devicePixelRatio: () => number;
}

export function createStaticPinTracker(inputs: StaticPinInputs): StaticPinTracker {
  const screenLong = Math.max(inputs.screen?.width ?? 0, inputs.screen?.height ?? 0);
  const screenShort = Math.min(inputs.screen?.width ?? 0, inputs.screen?.height ?? 0);
  let fit = targetFitScale(screenLong, screenShort);
  let corrected = false;

  const covers = (width: number, height: number): boolean =>
    screenLong > 0 &&
    screenShort > 0 &&
    Math.max(width, height) >= screenLong * FULLSCREEN_COVER_RATIO &&
    Math.min(width, height) >= screenShort * FULLSCREEN_COVER_RATIO;

  return {
    targetFit: () => fit,
    isCorrected: () => corrected,
    observeViewport(width, height, fullscreen = false) {
      if (!(width > 0) || !(height > 0) || height > width) {
        return false; // portrait or degenerate — never seeds, never corrects (see the contract above)
      }
      const candidate = targetFitScale(width, height);
      if (candidate <= 0) {
        return false;
      }
      const real = fullscreen || covers(width, height);
      if (candidate > fit + FIT_EPSILON) {
        fit = candidate;
        corrected = corrected || real;
        return true;
      }
      if (!corrected && real) {
        corrected = true;
        if (candidate < fit - FIT_EPSILON) {
          fit = candidate; // the seed was a wrong guess — prefer the measurement
          return true;
        }
      }
      return false;
    },
    ratioFor(staticScale) {
      const dpr = inputs.devicePixelRatio();
      const scale = staticScale > 0 ? staticScale : 1;
      const ratio = fit * dpr * scale;
      return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
    }
  };
}

// ---- the mirror's shared tracker -----------------------------------------------------------------------
//
// One per document: the construction options in `shaderResources.ts` seed both runtimes with it at import time
// (so a binding is never created at the un-pinned size and then re-sized), and `MirrorView` feeds it every frame
// measurement + re-pushes the live setters when it moves. A module singleton because those two see the same
// device and must not disagree.

let shared: StaticPinTracker | null = null;

export function mirrorStaticPin(): StaticPinTracker {
  if (!shared) {
    const screen =
      typeof window !== "undefined" && window.screen
        ? { width: window.screen.width, height: window.screen.height }
        : null;
    shared = createStaticPinTracker({
      screen,
      devicePixelRatio: () =>
        typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    });
  }
  return shared;
}

/** The pinned ratio for the SHADER family (its static-mode backing scale is a device decision — quality.ts'
 *  `staticShaderScale`, 0.5 on a phone / 1 on a desktop, `?staticShaderScale=` to A/B). */
export function staticShaderPinRatio(): number | undefined {
  return mirrorStaticPin().ratioFor(renderQuality().staticShaderScale);
}

/** The PARTICLE sibling (`staticParticleScale`, 0.25 on a phone / 1 on a desktop). */
export function staticParticlePinRatio(): number | undefined {
  return mirrorStaticPin().ratioFor(renderQuality().staticParticleScale);
}

/** TEST-ONLY: drop the shared tracker so a spec can re-resolve it against fresh window stubs. */
export function __resetMirrorStaticPinForTest(): void {
  shared = null;
}
