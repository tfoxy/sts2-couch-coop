// jsdom. Proves MirrorView's effect-mode wiring: it MOCKS the two gsw runtime factories with spy runtimes and
// asserts the mode → (setStaticShaders/setStaticParticles + setRenderScale) mapping on mount and on a live panel
// flip, plus off ⇒ dispose, re-enable ⇒ re-create, and that a panel selection pins the adaptive controller.
//
// jsdom resolves to the `high` tier (no WebGL2 → not weak/mobile), so enableWebglShaders/enableParticles are true
// and the effective mode IS the panel's mode; renderQuality().renderScale is 1 (⇒ Static maps to scale 1 here).
import { mount } from "@vue/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// Spy runtimes + factory mocks, hoisted so the vi.mock factory below can close over them.
const { shaderRt, particleRt, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost } = vi.hoisted(() => {
  const shaderRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticShaders: vi.fn(),
    // The frozen-mode backing pin (staticPin.ts): MirrorView pushes it after creating the runtime.
    setStaticShaderPixelRatio: vi.fn(),
    // Distinctive values so the __mirrorShaderStats pass-through test below proves it reads THIS runtime.
    stats: vi.fn(() => ({ draws: 7, cacheHits: 3, dirtySkips: 0, capDeferrals: 0, canvasReallocs: 2, syncRenders: 1, pinnedCanvasSyncs: 4 })),
    dispose: vi.fn()
  };
  const particleRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticParticles: vi.fn(),
    setStaticParticlePixelRatio: vi.fn(),
    stats: vi.fn(() => ({ draws: 5, pinnedCanvasSyncs: 0 })),
    dispose: vi.fn()
  };
  type HostOptions = { shaderOptions?: { enableWebglShaders?: boolean }; particleOptions?: { enableParticles?: boolean } };
  const createHtmlEffectsHost = vi.fn((root: HTMLElement) => {
    let shaders: typeof shaderRt | null = null;
    let particles: typeof particleRt | null = null;
    return {
      get shaders() { return shaders; }, get particles() { return particles; },
      updateOptions(options: HostOptions) {
        if (options.shaderOptions?.enableWebglShaders) shaders ??= createWebglShaderRuntime(root, options.shaderOptions);
        else { shaders?.dispose(); shaders = null; }
        if (options.particleOptions?.enableParticles) particles ??= createParticleRuntime(root, options.particleOptions);
        else { particles?.dispose(); particles = null; }
      },
      reconcile() { shaders?.reconcile(); particles?.reconcile(); },
      dispose() { shaders?.dispose(); particles?.dispose(); shaders = null; particles = null; },
    };
  });
  return {
    shaderRt,
    particleRt,
    createWebglShaderRuntime: vi.fn((_root?: HTMLElement, _options?: unknown) => shaderRt),
    createParticleRuntime: vi.fn((_root?: HTMLElement, _options?: unknown) => particleRt),
    createHtmlEffectsHost,
  };
});

vi.mock("@godot-scene-web/html/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@godot-scene-web/html/runtime")>();
  return { ...actual, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost };
});

import MirrorView from "@/mirror/MirrorView.vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { createMirrorState, type MirrorState } from "@/mirror/sceneTree";
import { __setRenderQualityForTest, resolveRenderQuality } from "@/render/quality";

function emptyState(): MirrorState {
  return createMirrorState();
}

let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  // A no-op rAF (returns a handle, never calls back) so the adaptive controller's loop and MirrorView's render
  // scheduling never actually run — the mode-driven setter calls under test are all synchronous.
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});

afterAll(() => {
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the shared settings singleton. Both modes are pinned to Dynamic here so the mode→setter mapping is the
  // only variable; the SEEDED default (particles static) is asserted separately below and in mirrorSettings.spec.
  mirrorSettings.shaderMode = "dynamic";
  mirrorSettings.particleMode = "dynamic";
  mirrorSettings.effectModePinned = false;
});

describe("MirrorView effect-mode wiring", () => {
  it("creates + configures both runtimes from the seeded Dynamic mode on mount", () => {
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

    expect(createWebglShaderRuntime).toHaveBeenCalledTimes(1);
    expect(createParticleRuntime).toHaveBeenCalledTimes(1);
    // Dynamic ⇒ not frozen, full backing-store scale.
    expect(shaderRt.setStaticShaders).toHaveBeenLastCalledWith(false);
    expect(shaderRt.setRenderScale).toHaveBeenLastCalledWith(1);
    expect(particleRt.setStaticParticles).toHaveBeenLastCalledWith(false);
    expect(particleRt.setRenderScale).toHaveBeenLastCalledWith(1);

    wrapper.unmount();
  });

  it("Static ⇒ freezes BOTH runtimes and pins the effect quality", async () => {
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

    mirrorSettings.shaderMode = "static";
    mirrorSettings.particleMode = "static";
    await nextTick();

    expect(shaderRt.setStaticShaders).toHaveBeenLastCalledWith(true);
    expect(particleRt.setStaticParticles).toHaveBeenLastCalledWith(true);
    // A deliberate panel selection pins so the adaptive controller steps aside.
    expect(mirrorSettings.effectModePinned).toBe(true);

    wrapper.unmount();
  });

  it("½ / ¼ variants set the backing-store scale (0.5 / 0.25), still animated", async () => {
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

    mirrorSettings.shaderMode = "dynamic-half";
    await nextTick();
    expect(shaderRt.setStaticShaders).toHaveBeenLastCalledWith(false);
    expect(shaderRt.setRenderScale).toHaveBeenLastCalledWith(0.5);

    mirrorSettings.particleMode = "dynamic-quarter";
    await nextTick();
    expect(particleRt.setStaticParticles).toHaveBeenLastCalledWith(false);
    expect(particleRt.setRenderScale).toHaveBeenLastCalledWith(0.25);

    wrapper.unmount();
  });

  it("the SEEDED particle default (static) freezes the particle runtime on mount", async () => {
    // The store is an app-wide singleton the beforeEach pins to Dynamic; re-seed the two fields the way
    // createMirrorSettings does on a fresh page load (particles static, shaders dynamic) and mount into that.
    mirrorSettings.particleMode = "static";
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

    expect(particleRt.setStaticParticles).toHaveBeenLastCalledWith(true);
    // …and it did NOT drag the shader runtime down with it.
    expect(shaderRt.setStaticShaders).toHaveBeenLastCalledWith(false);

    wrapper.unmount();
  });

  // R10 WS-A + Aug-11: the fps caps of a mode are the same on every device (they used to be whatever the runtime
  // happened to be constructed with), and so are the ½/¼ DYNAMIC scales. STATIC's backing store is the one
  // deliberate device difference — a phone renders the frozen frame at ½ (shaders) / ¼ (particles) because a
  // frozen shader still re-renders per scene-delta, and a full-res one took a Mali-G57 map screen to 126ms
  // StartDrawToSwapStart p50.
  it("maps Static to the DEVICE's static scale (½/¼ on a phone) and re-applies the tier's fps caps", async () => {
    // The `static` tier a weak-GPU phone auto-resolves to: renderScale 0.25, both caps 30.
    const phone = resolveRenderQuality({
      search: "",
      gpu: { renderer: "Mali-G57 MC2", software: false, unavailable: false },
      mobile: true,
      hardwareConcurrency: 8,
      deviceMemory: 8
    });
    expect(phone.tier).toBe("static");
    expect(phone.renderScale).toBe(0.25);
    __setRenderQualityForTest(phone);
    try {
      mirrorSettings.shaderMode = "static";
      mirrorSettings.particleMode = "static";
      const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

      expect(shaderRt.setRenderScale).toHaveBeenLastCalledWith(0.5);
      expect(particleRt.setRenderScale).toHaveBeenLastCalledWith(0.25);
      expect(shaderRt.setFps).toHaveBeenLastCalledWith(30);
      expect(particleRt.setFps).toHaveBeenLastCalledWith(30);

      // …and the reduced-resolution modes still mean exactly what they say, tier or no tier.
      mirrorSettings.particleMode = "dynamic-quarter";
      await nextTick();
      expect(particleRt.setRenderScale).toHaveBeenLastCalledWith(0.25);
      mirrorSettings.shaderMode = "dynamic";
      await nextTick();
      expect(shaderRt.setRenderScale).toHaveBeenLastCalledWith(1);

      wrapper.unmount();
    } finally {
      __setRenderQualityForTest(undefined);
    }
  });

  it("Static on a DESKTOP stays full resolution (it was never fill-bound there)", async () => {
    const desktop = resolveRenderQuality({
      search: "",
      gpu: { renderer: "NVIDIA GeForce RTX 4080", software: false, unavailable: false },
      hardwareConcurrency: 16,
      deviceMemory: 16
    });
    __setRenderQualityForTest(desktop);
    try {
      mirrorSettings.shaderMode = "static";
      mirrorSettings.particleMode = "static";
      const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

      expect(shaderRt.setRenderScale).toHaveBeenLastCalledWith(1);
      expect(particleRt.setRenderScale).toHaveBeenLastCalledWith(1);

      wrapper.unmount();
    } finally {
      __setRenderQualityForTest(undefined);
    }
  });

  it("Off disposes the runtime; re-enabling re-creates it (live, no reload)", async () => {
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });
    expect(createWebglShaderRuntime).toHaveBeenCalledTimes(1);

    mirrorSettings.shaderMode = "off";
    await nextTick();
    expect(shaderRt.dispose).toHaveBeenCalledTimes(1);

    mirrorSettings.shaderMode = "dynamic";
    await nextTick();
    expect(createWebglShaderRuntime).toHaveBeenCalledTimes(2); // re-created on re-enable
    expect(shaderRt.setStaticShaders).toHaveBeenLastCalledWith(false);
    expect(shaderRt.setRenderScale).toHaveBeenLastCalledWith(1);

    wrapper.unmount();
  });
});

// The probe seam for the gsw effect-runtime counters (Phase-0 of the static-shader regression matrix).
// Idiom of `__mirrorAtlasBakeStats`: a window global; but a FUNCTION here, because the runtimes are
// created/disposed live — each call must read the CURRENT handles, and it must ALWAYS return an object
// (probe scripts JSON.stringify it), with `null` per family while that runtime doesn't exist.
describe("window.__mirrorShaderStats probe seam", () => {
  const readStats = (): { shader: unknown; particle: unknown } =>
    (
      window as unknown as {
        __mirrorShaderStats: () => { shader: unknown; particle: unknown };
      }
    ).__mirrorShaderStats();

  it("returns the LIVE runtimes' counters, per family", () => {
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

    expect(readStats()).toEqual({
      shader: {
        draws: 7,
        cacheHits: 3,
        dirtySkips: 0,
        capDeferrals: 0,
        canvasReallocs: 2,
        syncRenders: 1,
        pinnedCanvasSyncs: 4
      },
      particle: { draws: 5, pinnedCanvasSyncs: 0 }
    });
    expect(shaderRt.stats).toHaveBeenCalled();
    expect(particleRt.stats).toHaveBeenCalled();

    wrapper.unmount();
  });

  it("returns a null sentinel for a disposed family (mode Off) and after unmount — never undefined", async () => {
    const wrapper = mount(MirrorView, { props: { state: emptyState(), revision: 1 } });

    mirrorSettings.shaderMode = "off";
    await nextTick();
    expect(readStats()).toEqual({ shader: null, particle: { draws: 5, pinnedCanvasSyncs: 0 } });

    wrapper.unmount();
    // Both runtimes are disposed + nulled on unmount; the accessor stays installed and degrades to the sentinel.
    expect(readStats()).toEqual({ shader: null, particle: null });
    expect(JSON.parse(JSON.stringify(readStats()))).toEqual({ shader: null, particle: null });
  });
});
