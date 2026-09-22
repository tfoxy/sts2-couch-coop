// MirrorView supports source-linked gsw revisions, so a capability that landed after a consumer release must be
// absent-safe. This fixture intentionally has ONLY the mandatory runtime contract: no static ratio setters,
// warmPrograms, invalidation, or stats. It proves the view still mounts, changes modes, survives a resize, emits a
// null-safe probe, and disposes both handles rather than quietly relying on the newest ambient declaration.

import { mount } from "@vue/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

const { shaderRt, particleRt, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost } = vi.hoisted(() => {
  const shaderRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticShaders: vi.fn(),
    setStaticShaderImages: vi.fn(),
    dispose: vi.fn()
  };
  const particleRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticParticles: vi.fn(),
    setStaticParticleImages: vi.fn(),
    dispose: vi.fn()
  };
  type HostOptions = { shaderOptions?: { enableWebglShaders?: boolean }; particleOptions?: { enableParticles?: boolean } };
  const createHtmlEffectsHost = vi.fn((root: HTMLElement) => {
    let shaders: typeof shaderRt | null = null;
    let particles: typeof particleRt | null = null;
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
import { createMirrorState } from "@/mirror/sceneTree";

let resize: (() => void) | null = null;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCaf: typeof globalThis.cancelAnimationFrame;
let originalRect: typeof Element.prototype.getBoundingClientRect;
let frameBox = { width: 1280, height: 720 };

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe(): void {}
    disconnect(): void {}
  };
  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { ...frameBox, x: 0, y: 0, top: 0, left: 0, right: frameBox.width, bottom: frameBox.height, toJSON: () => ({}) } as DOMRect;
  };
});

afterAll(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  Element.prototype.getBoundingClientRect = originalRect;
});

beforeEach(() => {
  vi.clearAllMocks();
  resize = null;
  frameBox = { width: 1280, height: 720 };
  mirrorSettings.shaderMode = "static";
  mirrorSettings.particleMode = "static";
  mirrorSettings.effectModePinned = false;
  window.history.replaceState({}, "", "/");
});

describe("MirrorView with minimal runtime capabilities", () => {
  it("mounts and retains all mandatory behavior when every probed capability is absent", async () => {
    const wrapper = mount(MirrorView, { props: { state: createMirrorState(), revision: 1 } });

    expect(createWebglShaderRuntime).toHaveBeenCalledTimes(1);
    expect(createParticleRuntime).toHaveBeenCalledTimes(1);
    expect(shaderRt.reconcile).toHaveBeenCalled();
    expect(particleRt.reconcile).toHaveBeenCalled();
    expect(shaderRt.setStaticShaders).toHaveBeenLastCalledWith(true);
    expect(particleRt.setStaticParticles).toHaveBeenLastCalledWith(true);
    expect(shaderRt.setRenderScale).toHaveBeenCalled();
    expect(particleRt.setRenderScale).toHaveBeenCalled();
    expect(shaderRt.setFps).toHaveBeenCalled();
    expect(particleRt.setFps).toHaveBeenCalled();
    // These are mandatory static-surface controls, even though their policy is passed at construction rather than
    // flipped by this view. Keeping them on the smallest valid fixture prevents an ambient declaration from
    // accidentally relaxing the actual runtime contract while it makes newer probes optional.
    expect(typeof shaderRt.setStaticShaderImages).toBe("function");
    expect(typeof particleRt.setStaticParticleImages).toBe("function");
    expect((createWebglShaderRuntime.mock.calls as unknown[][])[0]?.[1]).toHaveProperty("staticShaderImages");
    expect((createParticleRuntime.mock.calls as unknown[][])[0]?.[1]).toHaveProperty("staticParticleImages");

    // Mode changes invoke the normal mandatory setters and the change reconcile; missing warm/invalidate must be
    // a no-op, not a throw. The ResizeObserver repeats the static-pin fallback path with neither ratio setter.
    mirrorSettings.shaderMode = "dynamic";
    mirrorSettings.particleMode = "dynamic-quarter";
    await nextTick();
    frameBox = { width: 1920, height: 900 };
    expect(() => resize?.()).not.toThrow();
    expect(shaderRt.setStaticShaders).toHaveBeenLastCalledWith(false);
    expect(particleRt.setStaticParticles).toHaveBeenLastCalledWith(false);
    expect(particleRt.setRenderScale).toHaveBeenLastCalledWith(0.25);
    expect(shaderRt.reconcile.mock.calls.length).toBeGreaterThan(1);
    expect(particleRt.reconcile.mock.calls.length).toBeGreaterThan(1);
    // Mount reached `warmShaderPrograms` and both effect-mode changes reached invalidation. Their methods are
    // deliberately absent on this fixture; the assertions pin the absence-safe path, not a mock
    // that accidentally supplied a newer capability.
    expect("warmPrograms" in shaderRt).toBe(false);
    expect("invalidateStaticSurfaces" in shaderRt).toBe(false);
    expect("invalidateStaticSurfaces" in particleRt).toBe(false);

    // A stats-less runtime is valid; public harness probes answer null rather than dereferencing it.
    const readStats = (window as unknown as { __mirrorShaderStats?: () => unknown }).__mirrorShaderStats;
    expect(readStats?.()).toEqual({ shader: null, particle: null });

    wrapper.unmount();
    expect(shaderRt.dispose).toHaveBeenCalledTimes(1);
    expect(particleRt.dispose).toHaveBeenCalledTimes(1);
  });

  it("stamps the game's Text Effects preference on the stage, live", async () => {
    // One attribute on `.mirror-stage` gates @spirectl/presentation's animated rich-text rules for every label
    // under it — the DOM renderer's nodes and the canvas backend's overlay elements alike. It must TRACK the
    // store rather than being read once at mount: a session envelope re-seeds it whenever the game changes screen.
    mirrorSettings.textEffects = true;
    const wrapper = mount(MirrorView, { props: { state: createMirrorState(), revision: 1 } });
    const stage = wrapper.find(".mirror-stage");
    expect(stage.attributes("data-spirectl-text-effects")).toBe("on");

    mirrorSettings.textEffects = false;
    await nextTick();
    expect(stage.attributes("data-spirectl-text-effects")).toBe("off");

    mirrorSettings.textEffects = true;
    wrapper.unmount();
  });
});
