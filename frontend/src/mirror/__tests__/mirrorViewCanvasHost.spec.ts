// jsdom. THE CANVAS STAGE'S IDENTITY LAYOUT — the template half of the `?stage=canvas` blur fix.
//
// Blink allocates a render surface for a `transform: scale(fit)` element that has a composited descendant, sized at
// LAYER space (CSS x devicePixelRatio); the stage canvas's texture is then bilinearly magnified into that surface
// and minified back out when it is drawn — net geometry 1.0, two resamples, and a visibly soft stage on any desktop
// whose dpr is not 1. So on the canvas arm the canvas gets its OWN host, laid out at the fitted box with no
// transform, and the design box stays on `.mirror-stage` for the DOM overlays (whose supersampling is benign).
// Mechanism, compositor trace and byte-crisp identity arm: `.sts2/canvas-blur-sep03/FINDINGS.md`, per checkout;
// the backing-store arithmetic is canvasRenderer's, and is pinned in canvasStage.spec.
//
// What only THIS component can get wrong is the layout, which is what this spec is about: the host is the fitted
// box (following the widened design width, not a hardcoded 1920), it carries no transform, the stage keeps its
// design box + scale, and the one piece of stage content that has to paint UNDER the canvas — the static
// background, through the `underlay` slot — lands in the design-space layer below it rather than in the stage.
import { mount } from "@vue/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import MirrorView from "@/mirror/MirrorView.vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { __setStageBackendForTest, requestedStageBackend, type StageBackend } from "@/mirror/rendererFactory";
import { createMirrorState, type MirrorState } from "@/mirror/sceneTree";

// The frame box the next recomputeScale measures (jsdom has no layout, so the rect is stubbed like every other
// MirrorView spec does it). Every box below is chosen so the fit is exact in binary — a 0.75 scale, not
// 0.8333333333333334 — because these assertions are on the STRINGS the component writes into `style`.
let frameBox = { width: 0, height: 0 };

let origRect: typeof Element.prototype.getBoundingClientRect;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let backendAtStart: StageBackend;

function emptyState(): MirrorState {
  return createMirrorState();
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      ...frameBox,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: frameBox.width,
      bottom: frameBox.height,
      toJSON: () => ({})
    } as DOMRect;
  };
});

afterAll(() => {
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  Element.prototype.getBoundingClientRect = origRect;
});

beforeEach(() => {
  backendAtStart = requestedStageBackend();
  frameBox = { width: 0, height: 0 };
  mirrorSettings.stretchEnabled = true;
  // The canvas backend cannot be built in jsdom (no WebGL2) and hard-falls-back to the DOM one, naming the reason.
  // That is the fallback the layout has to survive, not a failure — but its console line is noise here.
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  __setStageBackendForTest(backendAtStart);
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Mount with a marker in the `underlay` slot, so a test can ask WHERE that slot rendered. */
function mountView() {
  return mount(MirrorView, {
    props: { state: emptyState(), revision: 1 },
    slots: { underlay: '<i data-testid="underlay-marker"></i>' },
    attachTo: document.body
  });
}

const hostEl = () => document.querySelector<HTMLElement>(".mirror-canvas-host");
const stageEl = () => document.querySelector<HTMLElement>(".mirror-stage");
const underlayEl = () => document.querySelector<HTMLElement>(".mirror-stage-underlay");

describe("MirrorView's canvas host (`?stage=canvas`)", () => {
  beforeEach(() => {
    __setStageBackendForTest("canvas");
  });

  it("lays the canvas host out at the FITTED box, with no transform on it", async () => {
    frameBox = { width: 1440, height: 810 }; // 16:9 → design 1920x1080, fit exactly 0.75
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    const host = hostEl();
    expect(host, "the canvas arm renders a host for the canvas").not.toBeNull();
    expect(host!.style.width).toBe("1440px");
    expect(host!.style.height).toBe("810px");
    // THE WHOLE POINT. Anything here — even a translate, which would tempt a centring refactor — puts the canvas
    // back under a transformed ancestor, which is where the double resample lives.
    expect(host!.style.transform).toBe("");

    // …while the stage keeps the DESIGN box and the fit transform, because the DOM overlays are laid out in it.
    expect(stageEl()!.style.width).toBe("1920px");
    expect(stageEl()!.style.transform).toBe("scale(0.75)");
    wrapper.unmount();
  });

  it("follows the WIDENED design width, not a hardcoded 1920", async () => {
    // An ultra-wide frame: the design box widens to MIRROR_MAX_DESIGN_WIDTH (2520) and the fit is set by the
    // SHORT edge (810/1080 = 0.75), so a host sized off a fixed 1920 would be 630 CSS px too narrow and the canvas
    // would be drawn into a box that is not the one the stage occupies.
    frameBox = { width: 2520, height: 810 };
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    expect(stageEl()!.style.width).toBe("2520px");
    expect(hostEl()!.style.width).toBe("1890px"); // 2520 x 0.75
    expect(hostEl()!.style.height).toBe("810px");
    wrapper.unmount();
  });

  it("uses the fallback underlay only when jsdom rejects the requested canvas backend", async () => {
    frameBox = { width: 1440, height: 810 };
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    // jsdom has no WebGL2, so this test deliberately exercises the hard fallback. The product canvas arm's exact
    // no-image mount contract is covered by StaticBackground's renderer-null lifecycle test; a fallback must put
    // its legacy image in this fitted underlay, never in the bare frame slot.
    const kids = Array.from(document.querySelector<HTMLElement>(".mirror-frame")!.children);
    expect(kids.indexOf(hostEl()!)).toBeLessThan(kids.indexOf(stageEl()!));
    expect(underlayEl()).not.toBeNull();

    // …which is also why the stage cannot keep painting the opaque "this room hasn't painted yet" fill: above the
    // canvas it would hide the game. The class is what turns it off; the underlay carries it instead.
    expect(stageEl()!.classList.contains("mirror-stage-over-canvas")).toBe(true);
    wrapper.unmount();
  });

});

describe("MirrorView on the DOM arm", () => {
  beforeEach(() => {
    __setStageBackendForTest("dom");
  });

  it("adds NOTHING: no host, no underlay layer, and the slot renders in the stage as it always has", async () => {
    frameBox = { width: 1440, height: 810 };
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    expect(hostEl()).toBeNull();
    expect(underlayEl()).toBeNull();
    expect(stageEl()!.querySelector('[data-testid="underlay-marker"]')).not.toBeNull();
    expect(stageEl()!.classList.contains("mirror-stage-over-canvas")).toBe(false);
    expect(stageEl()!.style.width).toBe("1920px");
    expect(stageEl()!.style.transform).toBe("scale(0.75)");
    wrapper.unmount();
  });
});
