// jsdom. MirrorView's wiring of the FROZEN-SURFACE BACKING PIN (staticPin.ts → gsw's
// setStaticShaderPixelRatio / setStaticParticlePixelRatio). The algebra itself is pinned in staticPin.spec;
// this spec proves the three things only the view can get wrong:
//   • a freshly created runtime is handed the CURRENT target (the construction options carry only the seed);
//   • a real fullscreen-landscape frame measurement re-pushes the corrected target — and a later windowed /
//     portrait measurement does NOT re-push (that stickiness is what stops the churn).
import { mount } from "@vue/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { shaderRt, particleRt, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost } = vi.hoisted(() => {
  const shaderRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticShaders: vi.fn(),
    setStaticShaderPixelRatio: vi.fn(),
    stats: vi.fn(() => ({
      draws: 0,
      cacheHits: 0,
      dirtySkips: 0,
      capDeferrals: 0,
      canvasReallocs: 0,
      syncRenders: 0,
      pinnedCanvasSyncs: 0
    })),
    dispose: vi.fn()
  };
  const particleRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticParticles: vi.fn(),
    setStaticParticlePixelRatio: vi.fn(),
    stats: vi.fn(() => ({ draws: 0, pinnedCanvasSyncs: 0 })),
    dispose: vi.fn()
  };
  type HostOptions = { shaderOptions?: { enableWebglShaders?: boolean }; particleOptions?: { enableParticles?: boolean } };
  const createHtmlEffectsHost = vi.fn((root: HTMLElement) => {
    let shaders: typeof shaderRt | null = null; let particles: typeof particleRt | null = null;
    return { get shaders() { return shaders; }, get particles() { return particles; }, updateOptions(options: HostOptions) {
      if (options.shaderOptions?.enableWebglShaders) shaders ??= createWebglShaderRuntime(root, options.shaderOptions); else { shaders?.dispose(); shaders = null; }
      if (options.particleOptions?.enableParticles) particles ??= createParticleRuntime(root, options.particleOptions); else { particles?.dispose(); particles = null; }
    }, reconcile() { shaders?.reconcile(); particles?.reconcile(); }, dispose() { shaders?.dispose(); particles?.dispose(); shaders = null; particles = null; } };
  });
  return {
    shaderRt,
    particleRt,
    createWebglShaderRuntime: vi.fn((_root?: HTMLElement, _options?: unknown) => shaderRt),
    createParticleRuntime: vi.fn((_root?: HTMLElement, _options?: unknown) => particleRt), createHtmlEffectsHost
  };
});

vi.mock("@godot-scene-web/html/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@godot-scene-web/html/runtime")>();
  return { ...actual, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost };
});

import MirrorView from "@/mirror/MirrorView.vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { createMirrorState, type MirrorState } from "@/mirror/sceneTree";
import { __resetMirrorStaticPinForTest, targetFitScale } from "@/mirror/staticPin";
import { __setRenderQualityForTest, resolveRenderQuality } from "@/render/quality";

// The device this spec pretends to be: a screen whose SHORT edge under-reports, so the seed and the real
// fullscreen-landscape measurement differ and the correction is observable.
const SCREEN = { width: 500, height: 2000 };
const DPR = 2;

// The frame box the next recomputeScale will measure (jsdom has no layout, so MirrorView's
// getBoundingClientRect is stubbed).
let frameBox = { width: 0, height: 0 };
// MirrorView's ResizeObserver callback, captured so a test can re-drive recomputeScale with a new box.
let onResize: (() => void) | null = null;

let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRect: typeof Element.prototype.getBoundingClientRect;

function emptyState(): MirrorState {
  return createMirrorState();
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      onResize = cb;
    }
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
    return { ...frameBox, x: 0, y: 0, top: 0, left: 0, right: frameBox.width, bottom: frameBox.height, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(window, "devicePixelRatio", { value: DPR, configurable: true });
  Object.defineProperty(window.screen, "width", { value: SCREEN.width, configurable: true });
  Object.defineProperty(window.screen, "height", { value: SCREEN.height, configurable: true });
});

afterAll(() => {
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  Element.prototype.getBoundingClientRect = origRect;
});

beforeEach(() => {
  vi.clearAllMocks();
  frameBox = { width: 0, height: 0 };
  onResize = null;
  mirrorSettings.shaderMode = "static";
  mirrorSettings.particleMode = "static";
  mirrorSettings.effectModePinned = false;
  // jsdom resolves to the `high` desktop tier ⇒ staticShaderScale/staticParticleScale are both 1.
  __setRenderQualityForTest(resolveRenderQuality({ search: "", gpu: { renderer: "", software: false, unavailable: false } }));
  window.history.replaceState({}, "", "/");
  __resetMirrorStaticPinForTest();
});

afterEach(() => {
  __setRenderQualityForTest(undefined);
  window.history.replaceState({}, "", "/");
  __resetMirrorStaticPinForTest();
});

// The pinned ratio for a family whose static backing scale is `scale`, at a given landscape-fullscreen target.
function expectedRatio(long: number, short: number, scale = 1): number {
  return targetFitScale(long, short) * DPR * scale;
}

describe("MirrorView static backing pin", () => {
  it("hands each newly created runtime the current target (seeded from screen.*)", () => {
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

    const seed = expectedRatio(SCREEN.height, SCREEN.width);
    expect(shaderRt.setStaticShaderPixelRatio).toHaveBeenCalledWith(seed);
    expect(particleRt.setStaticParticlePixelRatio).toHaveBeenCalledWith(seed);
    // The pin is pushed BEFORE the freeze, so the frozen canvases are sized straight into the pinned store.
    expect(shaderRt.setStaticShaderPixelRatio.mock.invocationCallOrder[0]).toBeLessThan(
      shaderRt.setStaticShaders.mock.invocationCallOrder[0]
    );

    wrapper.unmount();
  });

  it("re-pushes once a real fullscreen-landscape frame corrects the seed, then goes quiet", async () => {
    frameBox = { width: 1700, height: 600 }; // windowed landscape, bigger than the seed said ⇒ ratchet up
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

    const ratcheted = expectedRatio(1700, 600);
    expect(shaderRt.setStaticShaderPixelRatio).toHaveBeenLastCalledWith(ratcheted);
    const pushes = shaderRt.setStaticShaderPixelRatio.mock.calls.length;

    // A REAL fullscreen landscape measurement — smaller, and it corrects the target downward exactly once.
    Object.defineProperty(document, "fullscreenElement", { value: document.body, configurable: true });
    frameBox = { width: 800, height: 380 };
    onResize?.();
    const corrected = expectedRatio(800, 380);
    expect(shaderRt.setStaticShaderPixelRatio).toHaveBeenLastCalledWith(corrected);
    expect(particleRt.setStaticParticlePixelRatio).toHaveBeenLastCalledWith(corrected);
    const afterCorrection = shaderRt.setStaticShaderPixelRatio.mock.calls.length;
    expect(afterCorrection).toBe(pushes + 1);

    // …and now it is STICKY: leaving fullscreen, shrinking and rotating to portrait push nothing.
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    for (const box of [
      { width: 800, height: 300 },
      { width: 600, height: 280 },
      { width: 380, height: 800 }
    ]) {
      frameBox = box;
      onResize?.();
    }
    expect(shaderRt.setStaticShaderPixelRatio.mock.calls.length).toBe(afterCorrection);
    expect(shaderRt.setStaticShaderPixelRatio).toHaveBeenLastCalledWith(corrected);

    wrapper.unmount();
  });

});
