// jsdom. MirrorView's handling of a reconcile that APPLIED its delta without presenting (`rustSkipUndrawnWire`):
// the ack goes back and the post-frame pipeline is skipped — except a forced effect-runtime pass (a stage re-fit or
// spread re-layout) that coalesced into the same render, which moved every effect canvas box regardless.
import { mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

const { shaderRt, particleRt, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost, applied } = vi.hoisted(() => {
  const runtime = () => ({ reconcile: vi.fn(), setRenderScale: vi.fn(), setFps: vi.fn(), setStaticShaders: vi.fn(),
    setStaticParticles: vi.fn(), setStaticShaderPixelRatio: vi.fn(), setStaticParticlePixelRatio: vi.fn(),
    setStaticShaderImages: vi.fn(), setStaticParticleImages: vi.fn(), invalidateStaticSurfaces: vi.fn(),
    stats: vi.fn((): Record<string, number> => ({ draws: 0, cacheHits: 0, staticImagesLive: 0 })), dispose: vi.fn() });
  const shaderRt = runtime(), particleRt = runtime();
  type HostOptions = { shaderOptions?: { enableWebglShaders?: boolean }; particleOptions?: { enableParticles?: boolean } };
  const createWebglShaderRuntime = vi.fn(() => shaderRt), createParticleRuntime = vi.fn(() => particleRt);
  const createHtmlEffectsHost = vi.fn(() => {
    let shaders: typeof shaderRt | null = null; let particles: typeof particleRt | null = null;
    return { get shaders() { return shaders; }, get particles() { return particles; }, updateOptions(options: HostOptions) {
      if (options.shaderOptions?.enableWebglShaders) shaders ??= createWebglShaderRuntime(); else { shaders?.dispose(); shaders = null; }
      if (options.particleOptions?.enableParticles) particles ??= createParticleRuntime(); else { particles?.dispose(); particles = null; }
    }, reconcile() { shaders?.reconcile(); particles?.reconcile(); }, dispose() { shaders?.dispose(); particles?.dispose(); shaders = null; particles = null; } };
  });
  return { shaderRt, particleRt, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost, applied: { on: false } };
});

vi.mock("@godot-scene-web/html/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@godot-scene-web/html/runtime")>();
  return { ...actual, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost };
});
// The real renderer, whose reconcile answers "applied" while the test says so.
vi.mock("@/mirror/rendererFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/rendererFactory")>();
  return { ...actual, createMirrorRendererFor: (...args: Parameters<typeof actual.createMirrorRendererFor>) => {
    const renderer = actual.createMirrorRendererFor(...args);
    if (!renderer) return renderer;
    const reconcile = renderer.reconcile.bind(renderer);
    renderer.reconcile = (state, options) => { const result = reconcile(state, options); return applied.on ? "applied" : result; };
    return renderer;
  } };
});

import MirrorView from "@/mirror/MirrorView.vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

const RAF_TICK = 20;
const xform = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });

function sceneState(): MirrorState {
  const state = createMirrorState();
  const nodes = [
    { id: "world", parentId: null, name: "world", nodeType: "Node2D", transform: xform(0, 0), visible: true },
    { id: "shaderbg", parentId: "world", name: "shaderbg", nodeType: "TextureRect", transform: xform(0, 0), visible: true,
      localRect: { position: { x: 0, y: 0 }, size: { x: 400, y: 300 } },
      texture: { resourcePath: "res://images/rooms/underdocks/underdocks_00.png", resourceType: "Texture2D" },
      shader: { resourcePath: "res://shaders/underdocks_water.gdshader", resourceType: "Shader" },
      shaderParameters: [{ name: "strength", kind: "number", number: 0.5 }] },
  ];
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes,
    orderedIds: nodes.map((n) => n.id) })!);
  return state;
}

let resizeObserverCallbacks: (() => void)[] = [];
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(callback: () => void) { resizeObserverCallbacks.push(callback); }
    observe(): void {} unobserve(): void {} disconnect(): void {}
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  document.body.innerHTML = "";
  resizeObserverCallbacks = [];
  applied.on = false;
  mirrorSettings.shaderMode = "static";
  mirrorSettings.particleMode = "static";
  mirrorSettings.effectModePinned = true;
  mirrorSettings.stretchEnabled = true;
});
afterEach(() => { vi.useRealTimers(); applied.on = false; mirrorSettings.stretchEnabled = true; });

describe("MirrorView × an applied (not presented) reconcile", () => {
  it("acks it, skips the per-frame runtime pass, but runs a coalesced forced pass", async () => {
    const acks = vi.fn();
    const wrapper = mount(MirrorView, { props: { state: sceneState(), revision: 1, onSceneRendered: acks }, attachTo: document.body });
    vi.advanceTimersByTime(RAF_TICK);
    applied.on = true;

    // A plain applied delta: acked, no runtime pass at all.
    vi.clearAllMocks();
    await wrapper.setProps({ revision: 2 });
    vi.advanceTimersByTime(RAF_TICK);
    expect(acks).toHaveBeenCalledTimes(1);
    expect(shaderRt.reconcile).not.toHaveBeenCalled();

    // A widened frame: the spread watcher forces a runtime pass into the next render, which applies.
    const frame = document.querySelector<HTMLElement>('[data-testid="mirror-frame"]')!;
    frame.getBoundingClientRect = () => ({ width: 2400, height: 1080 }) as DOMRect;
    for (const fire of resizeObserverCallbacks) fire();
    await nextTick();
    vi.clearAllMocks();
    await wrapper.setProps({ revision: 3 });
    vi.advanceTimersByTime(RAF_TICK);
    expect(acks).toHaveBeenCalledTimes(1);
    expect(shaderRt.reconcile).toHaveBeenCalledTimes(1);

    // Consumed: the next applied delta runs none again.
    vi.clearAllMocks();
    await wrapper.setProps({ revision: 4 });
    vi.advanceTimersByTime(RAF_TICK);
    expect(acks).toHaveBeenCalledTimes(1);
    expect(shaderRt.reconcile).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
