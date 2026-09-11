// jsdom. MirrorView-level wiring of the FROZEN-SURFACE IMAGE SWAP, after it moved out of this repo and into
// gsw's generic `surface-image-swap` module.
//
// gsw owns the mechanism and tests it (encode, stand-in, revert, refcount, pacing, watchdog). Three things stay
// couch-coop's, and this spec pins all three at the seam where they live — MirrorView:
//   • the POLICY objects reach the runtimes at construction (a clone that dropped `staticShaderImages` /
//     `staticParticleImages` would silently disable the whole feature, and nothing else would notice);
//   • the MODE-CHANGE THAW: the policy's veto only refuses NEW freezes, so leaving Static has to hand standing
//     surfaces back explicitly (`invalidateStaticSurfaces`) — the direct replacement for the deleted
//     `thawStaticStills(family)`. Conversely a plain rendered frame or the 1s safety pass must NOT invalidate:
//     "a reconcile that redraws nothing un-freezes nothing" is the property the old thaw gate existed to get,
//     and it is now had by doing nothing at all;
//   • the GAUGE `mirrorWalkStats.staticStillCanvases` — "how many effect surfaces are frozen right now", the
//     acceptance metric a device harness reads. It is now a LIVE sum of both gsw runtimes' `staticImagesLive`,
//     sampled on read, because gsw's own quiet-window timer changes it with nothing on our side running.
//
// NOT pinned here, on purpose: that a particle CACHE-HIT blit counts as a repaint and thaws the surface. That
// was a couch-coop mechanism (`effectDrawCount` summed `draws + cacheHits` for exactly this reason) and it is
// now gsw's: its render path reports every paint — cache-hit blits included — through `noteStaticFrame`, and the
// quiet-window gate reverts a live swap on any reported paint ("draw" is one of its revert causes). There is no
// couch-coop seam left to observe it at; the dependency is recorded on `ParticleRuntimeStats.cacheHits` in
// src/types/spirectl-presentation.d.ts, and belongs in gsw's own suite.
import { mount } from "@vue/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// Spy runtimes + factory mocks, hoisted so the vi.mock factory below can close over them. The stats objects
// carry the swap counters gsw's runtimes carry; `staticImagesLive` is the gauge under test.
const { shaderRt, particleRt, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost } = vi.hoisted(() => {
  const shaderRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticShaders: vi.fn(),
    // The frozen-mode backing pin (staticPin.ts): MirrorView pushes it after creating the runtime.
    setStaticShaderPixelRatio: vi.fn(),
    setStaticShaderImages: vi.fn(),
    invalidateStaticSurfaces: vi.fn(),
    // Typed as an open bag of numbers on purpose: the counter set GROWS (R17 added nine), and a return type
    // inferred from this first literal would force every later `mockReturnValue` to restate the whole shape —
    // which is exactly the drift a "gsw predating a counter reads 0" test needs to be able to express.
    stats: vi.fn((): Record<string, number> => ({
      draws: 7,
      cacheHits: 3,
      dirtySkips: 0,
      capDeferrals: 0,
      canvasReallocs: 0,
      syncRenders: 0,
      pinnedCanvasSyncs: 0,
      staticImagesLive: 0
    })),
    dispose: vi.fn()
  };
  const particleRt = {
    reconcile: vi.fn(),
    setRenderScale: vi.fn(),
    setFps: vi.fn(),
    setStaticParticles: vi.fn(),
    setStaticParticlePixelRatio: vi.fn(),
    setStaticParticleImages: vi.fn(),
    invalidateStaticSurfaces: vi.fn(),
    stats: vi.fn((): Record<string, number> => ({
      draws: 5,
      cacheHits: 0,
      pinnedCanvasSyncs: 0,
      staticImagesLive: 0
    })),
    dispose: vi.fn()
  };
  // The options argument is declared so `mock.calls[0][1]` is typed — the construction-time policy hand-off is
  // one of the things under test.
  type Options = Record<string, unknown>;
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
    createWebglShaderRuntime: vi.fn((_root: HTMLElement, _options: Options) => shaderRt),
    createParticleRuntime: vi.fn((_root: HTMLElement, _options: Options) => particleRt), createHtmlEffectsHost
  };
});

vi.mock("@godot-scene-web/html/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@godot-scene-web/html/runtime")>();
  return { ...actual, createWebglShaderRuntime, createParticleRuntime, createHtmlEffectsHost };
});

import MirrorView from "@/mirror/MirrorView.vue";
import { mirrorWalkStats } from "@/mirror/mirrorRenderer";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { mirrorParticleRenderOptions, mirrorShaderRenderOptions } from "@/mirror/shaderResources";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// MirrorView's RUNTIME_SAFETY_MS — the 1s self-heal pass.
const SAFETY = 1000;
// vi.useFakeTimers also fakes requestAnimationFrame (a ~16ms timer), so MirrorView's coalesced render rAF —
// where reconcileRuntimes("frame") and armRuntimeSafety live — is driven by advancing the fake clock.
const RAF_TICK = 20;

// --- a minimal scene with one node of each effect family ------------------------------------------------------

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function sceneNodes(): Record<string, unknown>[] {
  return [
    { id: "world", parentId: null, name: "world", nodeType: "Node2D", transform: xform(0, 0), visible: true },
    {
      id: "shaderbg",
      parentId: "world",
      name: "shaderbg",
      nodeType: "TextureRect",
      transform: xform(-195.5, -115),
      localRect: { position: { x: 0, y: 0 }, size: { x: 2764.8, y: 2890 } },
      visible: true,
      texture: { resourcePath: "res://images/rooms/underdocks/underdocks_00.png", resourceType: "Texture2D" },
      shader: { resourcePath: "res://shaders/underdocks_water.gdshader", resourceType: "Shader" },
      shaderParameters: [{ name: "strength", kind: "number", number: 0.5 }]
    },
    {
      id: "light7",
      parentId: "world",
      name: "light7",
      nodeType: "GPUParticles2D",
      transform: xform(600, 200),
      visible: true,
      particleSpec: { kind: "GPUParticles2D", amount: 8, baseColor: { html: "#8080ffff" } }
    }
  ];
}

function sceneState(): MirrorState {
  const state = createMirrorState();
  const nodes = sceneNodes();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => n.id as string)
    })!
  );
  return state;
}

// The stub keeps the callback MirrorView handed it, so the resize test can fire the observer the way the browser
// would (jsdom has no ResizeObserver, and a plain `window` resize event never reaches `recomputeScale`).
let resizeObserverCallbacks: (() => void)[] = [];

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(callback: () => void) {
      resizeObserverCallbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  document.body.innerHTML = "";
  resizeObserverCallbacks = [];
  // Both families STATIC with the quality pinned (the adaptive controller steps aside) — the swap-eligible state.
  mirrorSettings.shaderMode = "static";
  mirrorSettings.particleMode = "static";
  mirrorSettings.effectModePinned = true;
});

afterEach(() => {
  vi.useRealTimers();
  mirrorSettings.shaderMode = "static";
  mirrorSettings.particleMode = "static";
});

function mountMirror(): ReturnType<typeof mount> {
  return mount(MirrorView, { props: { state: sceneState(), revision: 1 }, attachTo: document.body });
}

describe("MirrorView × gsw surface image swap", () => {
  it("hands BOTH policy objects to the gsw runtimes at construction", () => {
    const wrapper = mountMirror();

    const shaderOptions = createWebglShaderRuntime.mock.calls[0][1];
    const particleOptions = createParticleRuntime.mock.calls[0][1];
    // Identity, not shape: the whole point is that the module's policy (quiet window, retry, encode pacing,
    // the static-mode veto — pinned in shaderResources.spec) is what gsw actually runs under.
    expect(shaderOptions.staticShaderImages).toBe(mirrorShaderRenderOptions.staticShaderImages);
    expect(particleOptions.staticParticleImages).toBe(mirrorParticleRenderOptions.staticParticleImages);

    wrapper.unmount();
  });

  it("a MODE CHANGE hands standing frozen surfaces back (the veto only refuses NEW freezes)", async () => {
    const wrapper = mountMirror();
    vi.clearAllMocks(); // mount is itself a "change" pass; measure from a settled view

    // Leaving Static: gsw's gate would stop offering new swaps by itself (the veto), but an `<img>` already
    // standing over a canvas the runtime has just started animating again is the regression this prevents.
    mirrorSettings.shaderMode = "dynamic";
    await nextTick();
    expect(shaderRt.invalidateStaticSurfaces).toHaveBeenCalled();
    expect(particleRt.invalidateStaticSurfaces).toHaveBeenCalled();

    // …and coming BACK to static invalidates again: `invalidateStaticSurfaces` reverts WITHOUT blocking, so
    // every surface simply re-earns its swap on its next quiet window.
    const before = shaderRt.invalidateStaticSurfaces.mock.calls.length;
    mirrorSettings.shaderMode = "static";
    await nextTick();
    expect(shaderRt.invalidateStaticSurfaces.mock.calls.length).toBeGreaterThan(before);

    wrapper.unmount();
  });

  // The deleted mechanism's thaw-all fired on EVERY structural "change", not just a mode flip — a stage resize
  // and a spread re-layout move every canvas box, and a gsw stand-in copies its box once at freeze time, so a
  // stale `<img>` would sit at the old box until gsw's watchdog window (up to 3s) re-synced it.
  it("a stage RESIZE hands them back too (a stand-in's box is copied once, at freeze time)", async () => {
    const wrapper = mountMirror();
    vi.clearAllMocks();

    // The ResizeObserver path: a real frame measurement changes `scale` and re-fits the stage, which moves every
    // canvas box. jsdom reports 0×0 for everything, so give the frame a size and fire the observer by hand.
    const frame = document.querySelector<HTMLElement>('[data-testid="mirror-frame"]');
    expect(frame, "the letterbox frame the ResizeObserver watches").not.toBeNull();
    frame!.getBoundingClientRect = () => ({ width: 1600, height: 900 }) as DOMRect;
    expect(resizeObserverCallbacks.length, "MirrorView installed a ResizeObserver").toBeGreaterThan(0);
    for (const fire of resizeObserverCallbacks) {
      fire();
    }
    await nextTick();

    expect(shaderRt.invalidateStaticSurfaces).toHaveBeenCalled();
    expect(particleRt.invalidateStaticSurfaces).toHaveBeenCalled();

    wrapper.unmount();
  });

  it("a rendered frame and the 1s safety pass reconcile but NEVER invalidate (rc5: the force-thaw regression)", async () => {
    const wrapper = mountMirror();
    vi.clearAllMocks();

    // A rendered frame with clean dirty bits: the coalesced render rAF runs reconcileRuntimes("frame") and arms
    // the safety pass.
    await wrapper.setProps({ revision: 2 });
    vi.advanceTimersByTime(RAF_TICK);
    // …and the 1s self-heal pass it armed, whose whole point is a missed dirty site — it still reconciles both
    // runtimes, but rc5 measured that thawing here killed every engaged surface within 1.0–1.3s on a streaming
    // scene. gsw's own per-surface report covers the case where such a reconcile really does repaint.
    const shaderReconciles = shaderRt.reconcile.mock.calls.length;
    const particleReconciles = particleRt.reconcile.mock.calls.length;
    vi.advanceTimersByTime(SAFETY + RAF_TICK);
    expect(shaderRt.reconcile.mock.calls.length).toBe(shaderReconciles + 1);
    expect(particleRt.reconcile.mock.calls.length).toBe(particleReconciles + 1);

    expect(shaderRt.invalidateStaticSurfaces).not.toHaveBeenCalled();
    expect(particleRt.invalidateStaticSurfaces).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  // THE ACCEPTANCE METRIC. A device harness reads `mirrorWalkStats.staticStillCanvases`; if it ever stops
  // meaning "effect surfaces frozen right now" the harness silently reads a wrong number, not an error.
  it("mirrorWalkStats.staticStillCanvases is the LIVE sum of both runtimes' staticImagesLive", () => {
    const wrapper = mountMirror();
    expect(mirrorWalkStats.staticStillCanvases).toBe(0);

    // gsw's own quiet-window timer engages the fleet — nothing on our side runs, renders or reconciles.
    shaderRt.stats.mockReturnValue({
      draws: 7,
      cacheHits: 3,
      dirtySkips: 0,
      capDeferrals: 0,
      canvasReallocs: 0,
      syncRenders: 0,
      pinnedCanvasSyncs: 0,
      staticImagesLive: 28
    });
    particleRt.stats.mockReturnValue({ draws: 5, cacheHits: 0, pinnedCanvasSyncs: 0, staticImagesLive: 44 });
    expect(mirrorWalkStats.staticStillCanvases).toBe(72); // the measured UNDERDOCKS fleet

    // It FALLS as gsw hands surfaces back (a repaint, its watchdog, a host invalidate) — the gauge is not a
    // high-water mark, and a harness sampling mid-thaw must see the dip.
    particleRt.stats.mockReturnValue({ draws: 5, cacheHits: 1, pinnedCanvasSyncs: 0, staticImagesLive: 0 });
    expect(mirrorWalkStats.staticStillCanvases).toBe(28);

    // A measurement-window reset must NOT claim the fleet was handed back: this is a gauge over gsw's live
    // state, not a counter this repo accumulates.
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.staticStillCanvases).toBe(28);

    wrapper.unmount();
    // With the runtimes disposed the gauge stands down rather than calling into dead handles.
    expect(mirrorWalkStats.staticStillCanvases).toBe(0);
  });

  // R17 — the RETAINED-STILL block. Same acceptance-metric argument as the gauge above, with one extra hazard
  // that only shows up with more than one number: the counters and the POOL GAUGES fold differently, and getting
  // that wrong is not an error, it is a wrong number in a bench cell.
  it("mirrorWalkStats.staticStill* SUMS the counters and takes the MAX of the pool gauges", () => {
    const wrapper = mountMirror();
    expect(mirrorWalkStats.staticStillCacheHits, "nothing measured yet").toBe(0);

    shaderRt.stats.mockReturnValue({
      draws: 7,
      cacheHits: 3,
      dirtySkips: 0,
      capDeferrals: 0,
      canvasReallocs: 0,
      syncRenders: 0,
      pinnedCanvasSyncs: 0,
      staticImagesLive: 28,
      staticStillCacheHits: 1,
      staticStillCacheMisses: 2,
      staticStillMounts: 1,
      staticStillBakes: 0,
      // gsw's pool gauges are DOCUMENT-wide: every runtime reports a copy of the same number, so a consumer
      // that summed them would report a pool twice its real size and conclude the budget was half what it is.
      staticStillRetainedEntries: 5,
      staticStillRetainedBytes: 4096
    });
    particleRt.stats.mockReturnValue({
      draws: 5,
      cacheHits: 0,
      pinnedCanvasSyncs: 0,
      staticImagesLive: 44,
      staticStillCacheHits: 34,
      staticStillCacheMisses: 2,
      staticStillMounts: 33,
      staticStillBakes: 2,
      staticStillRetainedEntries: 5,
      staticStillRetainedBytes: 4096,
      // The donor block is particle-only by construction — only the particle runtime holds a departing binding
      // alive to bake the frame its successors claim.
      staticStillDonors: 1,
      staticStillDonorBakes: 2,
      staticStillDonorsDropped: 0
    });

    // The measured 30-card volley's shape: 70 emitters, 2 distinct keys ⇒ a couple of misses and the rest hits.
    expect(mirrorWalkStats.staticStillCacheHits).toBe(35);
    expect(mirrorWalkStats.staticStillCacheMisses).toBe(4);
    expect(mirrorWalkStats.staticStillMounts).toBe(34);
    expect(mirrorWalkStats.staticStillBakes).toBe(2);
    expect(mirrorWalkStats.staticStillDonors).toBe(1);
    expect(mirrorWalkStats.staticStillDonorBakes).toBe(2);
    expect(mirrorWalkStats.staticStillDonorsDropped).toBe(0);
    expect(mirrorWalkStats.staticStillRetainedEntries, "MAX, not sum").toBe(5);
    expect(mirrorWalkStats.staticStillRetainedBytes, "MAX, not sum").toBe(4096);

    // A measurement-window reset must not claim the claims un-happened: these are read-time gauges over gsw's
    // own monotonic counters, and a bench window diffs them (the `staticStillCanvases` rule).
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.staticStillCacheHits).toBe(35);

    wrapper.unmount();
    expect(mirrorWalkStats.staticStillCacheHits, "the gauge stands down with the runtimes").toBe(0);
    expect(mirrorWalkStats.staticStillRetainedBytes).toBe(0);
  });

  // A gsw that predates a counter must read 0, not throw: the shim is hand-maintained and the two repos' branches
  // can be run out of order (the `typeof stats === "function"` rule, one level down).
  it("reads 0 for a counter a gsw build does not have", () => {
    const wrapper = mountMirror();
    shaderRt.stats.mockReturnValue({ draws: 0, cacheHits: 0, staticImagesLive: 0 });
    particleRt.stats.mockReturnValue({ draws: 0, cacheHits: 0, staticImagesLive: 0 });
    expect(mirrorWalkStats.staticStillCacheHits).toBe(0);
    expect(mirrorWalkStats.staticStillDonors).toBe(0);
    expect(mirrorWalkStats.staticStillRetainedBytes).toBe(0);
    wrapper.unmount();
  });
});
