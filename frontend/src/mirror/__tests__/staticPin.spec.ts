// The FROZEN-SURFACE BACKING PIN algebra (staticPin.ts) — the device target the mirror hands gsw's
// `staticShaderPixelRatio` / `staticParticlePixelRatio`.
//
// The properties under test are exactly the ones that make the pin worth having:
//   • the pinned ratio (and therefore the backing store, which in this host is `designBox × ratio` — see the
//     module header: the mirror fits with a CSS TRANSFORM, so gsw's `clientWidth`/`contentRect` box reads are
//     in DESIGN px and do not move with the fit scale) is INVARIANT across fit-scale changes: rotation,
//     leaving fullscreen, a widescreen-stretch toggle, a smaller window;
//   • K is STICKY once a real fullscreen-landscape measurement has corrected the `screen.*` seed;
//   • a phone that is in PORTRAIT and not fullscreen still targets landscape-fullscreen.
import { describe, expect, it } from "vitest";

import {
  createStaticPinTracker,
  targetFitScale,
  type StaticPinTracker
} from "@/mirror/staticPin";
import {
  MIRROR_DESIGN_HEIGHT,
  MIRROR_DESIGN_WIDTH,
  MIRROR_MAX_DESIGN_WIDTH
} from "@/mirror/sceneTree";

// MirrorView's OWN fit computation (MirrorView.vue `design` + `recomputeScale`), replicated so the tests can
// check `targetFitScale` against the thing it is meant to predict, in both widescreen-stretch states.
function mirrorFit(frameW: number, frameH: number, stretch: boolean): number {
  const design = stretch
    ? Math.min(
        MIRROR_MAX_DESIGN_WIDTH,
        Math.max(MIRROR_DESIGN_WIDTH, Math.round((frameW / frameH) * MIRROR_DESIGN_HEIGHT))
      )
    : MIRROR_DESIGN_WIDTH;
  return Math.min(frameW / design, frameH / MIRROR_DESIGN_HEIGHT);
}

function tracker(
  screen: { width: number; height: number } | null,
  dpr = 1
): StaticPinTracker {
  return createStaticPinTracker({
    screen,
    devicePixelRatio: () => dpr
  });
}

describe("targetFitScale", () => {
  it("matches MirrorView's own fit for a landscape viewport, in BOTH stretch states", () => {
    // A 16:9 desktop, a 2.22:1 phone (Moto G86 class), a 2.4:1 phone and a 4:3 tablet.
    for (const [w, h] of [
      [1920, 1080],
      [960, 432],
      [1200, 500],
      [1024, 768]
    ]) {
      const fit = targetFitScale(w, h);
      // At/above 16:9 the stretched stage is short-edge bound and the un-stretched one is too (the min picks
      // the same term), so ONE formula covers both — which is why toggling the stretch never moves the pin.
      expect(fit).toBeCloseTo(mirrorFit(w, h, true), 6);
      expect(fit).toBeCloseTo(mirrorFit(w, h, false), 6);
    }
  });

  it("is orientation-agnostic (it describes the DEVICE, not the current rotation)", () => {
    expect(targetFitScale(960, 432)).toBeCloseTo(targetFitScale(432, 960), 12);
  });

  it("is 0 for a degenerate viewport (⇒ no pin is pushed)", () => {
    expect(targetFitScale(0, 0)).toBe(0);
    expect(targetFitScale(1920, 0)).toBe(0);
    expect(targetFitScale(Number.NaN, 1080)).toBe(0);
  });
});

describe("the pinned ratio", () => {
  it("bakes in devicePixelRatio and the family's static backing scale", () => {
    // Phone-class screen (CSS px) at dpr 2.625; the mirror's mobile static scales are 0.5 / 0.25.
    const pin = tracker({ width: 412, height: 915 }, 2.625);
    const fit = targetFitScale(915, 412); // ≈ 0.3815 (short-edge bound)
    expect(pin.targetFit()).toBeCloseTo(fit, 6);
    expect(pin.ratioFor(0.5)).toBeCloseTo(fit * 2.625 * 0.5, 6);
    expect(pin.ratioFor(0.25)).toBeCloseTo(fit * 2.625 * 0.25, 6);
    // Desktop-style full static scale.
    expect(pin.ratioFor(1)).toBeCloseTo(fit * 2.625, 6);
  });

  it("is INVARIANT across every fit-scale change — the whole point of the pin", () => {
    // Seeded from a landscape-capable phone screen and then dragged through the fit changes that used to
    // re-size (and therefore re-render + re-key) the whole frozen fleet.
    const pin = tracker({ width: 412, height: 915 }, 2.625);
    const before = pin.ratioFor(0.5);
    const backing = (ratio: number | undefined): number =>
      // The mirror's boxes are DESIGN px (CSS transform fit), so this IS gsw's backing store for a
      // full-stage node. Constant ratio ⇒ constant backing store ⇒ no realloc, no re-render, no cache re-key.
      Math.round(MIRROR_DESIGN_WIDTH * (ratio ?? 0));

    const fits: number[] = [];
    for (const [w, h, fullscreen] of [
      [412, 915, false], // portrait, browser chrome visible
      [412, 820, false], // portrait, keyboard/gesture bar moved
      [915, 412, false], // rotated to landscape, still not fullscreen
      [915, 380, false], // landscape with a toolbar
      [412, 915, false] // back to portrait
    ] as [number, number, boolean][]) {
      pin.observeViewport(w, h, fullscreen);
      fits.push(mirrorFit(w, h, true));
      expect(pin.ratioFor(0.5)).toBe(before);
      expect(backing(pin.ratioFor(0.5))).toBe(backing(before));
    }
    // Sanity: the LIVE fit really did move over that sequence (otherwise the invariance above is vacuous).
    expect(Math.max(...fits) - Math.min(...fits)).toBeGreaterThan(0.1);
  });
});

describe("K seeding and correction", () => {
  it("prefers the first REAL fullscreen-landscape measurement over the screen.* seed, even downward", () => {
    // The seed over-reports (a browser that counts the notch/gesture strip as screen).
    const pin = tracker({ width: 500, height: 1000 }, 1);
    expect(pin.targetFit()).toBeCloseTo(Math.min(1000 / 1920, 500 / 1080), 6);
    expect(pin.isCorrected()).toBe(false);

    // A real fullscreen landscape viewport, SMALLER than the seed predicted.
    expect(pin.observeViewport(900, 400, true)).toBe(true);
    expect(pin.isCorrected()).toBe(true);
    expect(pin.targetFit()).toBeCloseTo(targetFitScale(900, 400), 6);
  });

  it("accepts a viewport that COVERS the screen as fullscreen, without the fullscreen flag", () => {
    // Phone in landscape with the browser UI auto-hidden: no fullscreenElement, but it covers the screen.
    const pin = tracker({ width: 412, height: 915 }, 1);
    expect(pin.observeViewport(915, 400, false)).toBe(true); // ≥90% of both screen edges ⇒ a real measurement
    expect(pin.isCorrected()).toBe(true);
  });

  it("is STICKY once corrected: leaving fullscreen, rotating, or shrinking never lowers it", () => {
    const pin = tracker({ width: 500, height: 1000 }, 1);
    pin.observeViewport(900, 400, true);
    const corrected = pin.ratioFor(1);

    expect(pin.observeViewport(900, 320, false)).toBe(false); // left fullscreen (toolbar back)
    expect(pin.observeViewport(400, 900, false)).toBe(false); // rotated to portrait
    expect(pin.observeViewport(600, 300, false)).toBe(false); // window dragged smaller
    expect(pin.observeViewport(300, 200, true)).toBe(false); // even a SMALLER "fullscreen" claim
    expect(pin.ratioFor(1)).toBe(corrected);
  });

  it("ratchets UP on any landscape measurement bigger than the current target", () => {
    // A seed whose SHORT edge under-reports (it binds the fit), and a windowed landscape viewport that is
    // NOT covering (1700 < 90% of the 2000 long edge) yet still fits the stage bigger than the seed said.
    const pin = tracker({ width: 500, height: 2000 }, 1);
    const seeded = pin.targetFit();
    expect(pin.observeViewport(1700, 600, false)).toBe(true);
    expect(pin.targetFit()).toBeCloseTo(targetFitScale(1700, 600), 6);
    expect(pin.targetFit()).toBeGreaterThan(seeded);
    // …and a non-covering ratchet does NOT count as the one correcting measurement, so a later real
    // fullscreen viewport may still correct downward.
    expect(pin.isCorrected()).toBe(false);
    expect(pin.observeViewport(800, 380, true)).toBe(true);
    expect(pin.targetFit()).toBeCloseTo(targetFitScale(800, 380), 6);
    expect(pin.isCorrected()).toBe(true);
  });

  it("PORTRAIT and non-fullscreen still target landscape-fullscreen (the user's framing)", () => {
    // A phone that is never rotated and never fullscreened keeps the screen-derived landscape target: the
    // small live portrait fit must not decide the frozen resolution.
    const pin = tracker({ width: 412, height: 915 }, 3);
    for (const [w, h] of [
      [412, 915],
      [412, 700],
      [412, 915]
    ]) {
      expect(pin.observeViewport(w, h, false)).toBe(false);
    }
    expect(pin.targetFit()).toBeCloseTo(targetFitScale(915, 412), 6);
    expect(pin.ratioFor(0.5)).toBeCloseTo(targetFitScale(915, 412) * 3 * 0.5, 6);
    // The live PORTRAIT fit is far smaller — that is the number we are deliberately NOT using.
    expect(mirrorFit(412, 915, true)).toBeLessThan(pin.targetFit());
  });

  it("pushes no pin at all until something is known", () => {
    const pin = tracker(null, 2);
    expect(pin.targetFit()).toBe(0);
    expect(pin.ratioFor(1)).toBeUndefined();
    expect(pin.observeViewport(900, 400, false)).toBe(true);
    expect(pin.ratioFor(1)).toBeCloseTo(targetFitScale(900, 400) * 2, 6);
  });
});
