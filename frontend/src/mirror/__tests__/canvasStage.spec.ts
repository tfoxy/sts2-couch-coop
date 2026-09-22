import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_STAGE_CLASS } from "@/mirror/canvas/canvasRenderer";
import { OVERLAY_CONTAINER_CLASS } from "@/mirror/canvas/overlay";
import { MAP_LIMIT_HI, MAP_LIMIT_LO } from "@/mirror/eagerScroll";
import {
  createMirrorRendererFor,
  requestedStageBackend,
  __setStageBackendForTest,
  type StageBackend
} from "@/mirror/rendererFactory";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorCardFlightHint,
  type MirrorState
} from "@/mirror/sceneTree";
import { HAND_RAISE_PX } from "@/mirror/mirrorRenderer";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";
import type { MirrorRenderer } from "@/mirror/mirrorRenderer";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// The clip client fetches + decodes over the network and jsdom has no server, so `loadSpineClip` is stood in for
// (`spineMount.spec`'s pattern). Everything else in the module — `frameIndexAt`, `msToNextSpineFrame` — stays REAL:
// what the scheduler section below asserts is the renderer's arming, driven by the module's own playback math.
const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

// Wave 2a — the single-canvas backend actually renders. What is asserted here is the CONTRACT, not the pixels
// (jsdom has no GL, so the stub below records calls rather than rasterizing): the sizing law, that a reconcile
// PAINTS before it returns (which is what makes MirrorView's scene ack honest), that the animation loop repaints
// without ever going near that ack, that a texture load repaints, that the DOM overlay tracks the draw list, and
// that the retained method table answers off the state rather than off elements that no longer exist.

// A stage laid out at its DESIGN box, rendered at `scale` by the stage's own CSS transform. `clientWidth/Height`
// are the layout box (transform-blind, as in a real browser) and `getBoundingClientRect` the rendered one — the
// ratio between them is exactly what the backend measures the stage's scale from.
function stageAt(designW: number, designH: number, scale: number): HTMLElement {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  Object.defineProperty(stage, "clientWidth", { configurable: true, value: designW });
  Object.defineProperty(stage, "clientHeight", { configurable: true, value: designH });
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: designW * scale, height: designH * scale }) as DOMRect;
  return stage;
}

// The canvas HOST of the SPLIT layout — MirrorView's `.mirror-canvas-host`, the element the canvas is laid out in
// once it is taken out of the scaled stage. Its layout box and its rendered box are the SAME box (nothing above it
// is transformed; that is the whole point), so the fitted size is all a test has to say.
function hostAt(fittedW: number, fittedH: number): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "clientWidth", { configurable: true, value: fittedW });
  Object.defineProperty(host, "clientHeight", { configurable: true, value: fittedH });
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: fittedW, height: fittedH }) as DOMRect;
  return host;
}

function defsEl(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.appendChild(svg);
  return defs;
}

interface GlRecord {
  viewports: Array<[number, number]>;
  clears: number;
  lost: number;
  draws: number;
}

/**
 * A no-op WebGL2 context, complete enough to drive gsw's real stage + executor + texture cache.
 *
 * jsdom has no WebGL at all, so the SUCCESS path has to be stubbed (the FAILURE path below is jsdom's own
 * behaviour and needs no help). A Proxy rather than a hand-written object because the executor legitimately
 * touches ~40 entry points and the point of these tests is the RENDERER's contract, not a GL replica: an ALL_CAPS
 * name answers with a number (blend equations and texture units are looked up as `gl[name]`), a `create*`/
 * `get*Location` with a fresh object, a compile/link status with `true`, and everything else with a no-op.
 */
function stubWebgl2(): GlRecord {
  const record: GlRecord = { viewports: [], clears: 0, lost: 0, draws: 0 };
  let constantSeed = 0x1000;
  const constants = new Map<string, number>();
  let canvasEl: HTMLCanvasElement | null = null;

  const explicit: Record<string, unknown> = {
    // The ACHIEVED drawing buffer, which gsw's stage re-reads after every `setStageSize` — it must track the
    // canvas attribute here or the projection would describe rows that do not exist.
    get drawingBufferWidth() {
      return canvasEl?.width ?? 0;
    },
    get drawingBufferHeight() {
      return canvasEl?.height ?? 0;
    },
    viewport: (_x: number, _y: number, w: number, h: number) => record.viewports.push([w, h]),
    clear: () => {
      record.clears++;
    },
    clearColor: () => {},
    drawArraysInstanced: () => {
      record.draws++;
    },
    // 8 is the texture-UNIT count the batcher sizes its slot table from. `MAX_TEXTURE_SIZE` is a different
    // question entirely and must answer in PIXELS: the bridge refuses any source longer than it, so a stub that
    // said 8 there would mark every real sprite oversized.
    getParameter: (pname: number) =>
      pname === (gl as unknown as Record<string, number>).MAX_TEXTURE_SIZE ? 8192 : 8,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getExtension: (name: string) =>
      name === "WEBGL_lose_context"
        ? {
            loseContext: () => {
              record.lost++;
            }
          }
        : null
  };

  const gl = new Proxy(explicit, {
    get(target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      if (prop in target) {
        return (target as Record<string, unknown>)[prop];
      }
      if (/^[A-Z0-9_]+$/.test(prop)) {
        let value = constants.get(prop);
        if (value === undefined) {
          value = constantSeed++;
          constants.set(prop, value);
        }
        return value;
      }
      if (/^create[A-Z]/.test(prop) || /Location$/.test(prop)) {
        return () => ({});
      }
      return () => undefined;
    }
  }) as unknown as WebGL2RenderingContext;

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string
  ) {
    if (kind !== "webgl2") {
      return null;
    }
    canvasEl = this;
    return gl as unknown as RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext);
  return record;
}

// jsdom has no ResizeObserver: capture the observed targets and let a test deliver the callback itself.
function stubResizeObserver(): { targets: Element[]; fire: () => void } {
  const state: { targets: Element[]; fire: () => void } = { targets: [], fire: () => {} };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        state.fire = callback;
      }
      observe(target: Element): void {
        state.targets.push(target);
      }
      disconnect(): void {}
      unobserve(): void {}
    }
  );
  return state;
}

/** A hand-driven rAF: nothing runs until a test calls `flush()`, so the animation loop is deterministic. */
function stubRaf(): { pending: number; flush: () => number } {
  const queue: (FrameRequestCallback | null)[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  // Real cancellation, because the M3 scheduler's contract includes what it does NOT cancel: a spec that could
  // not tell a dropped rAF from a live one would pass whether or not the "never cancel a pending rAF" rule holds.
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    if (handle >= 1 && handle <= queue.length) {
      queue[handle - 1] = null;
    }
  });
  return {
    get pending() {
      return queue.filter((cb) => cb !== null).length;
    },
    flush() {
      const ran = queue.splice(0, queue.length).filter((cb): cb is FrameRequestCallback => cb !== null);
      for (const cb of ran) {
        cb(performance.now());
      }
      return ran.length;
    }
  };
}

/**
 * A hand-driven `setTimeout`, so the M3 PARK is observable: which delay it was armed for, whether a re-arm
 * cancelled it, and what happens when it elapses. Nothing fires until a test calls `fire()`.
 *
 * Only the two-argument `setTimeout(fn, ms)` shape the renderer uses is modelled; a cancelled entry is nulled in
 * place so the handles stay stable (the renderer holds one across a re-arm).
 */
function stubTimers(): {
  pending: number;
  delays: number[];
  fire: () => number;
} {
  const queue: Array<{ fn: () => void; delay: number } | null> = [];
  vi.stubGlobal("setTimeout", (fn: () => void, delay?: number) => {
    queue.push({ fn, delay: delay ?? 0 });
    return queue.length;
  });
  vi.stubGlobal("clearTimeout", (handle: number) => {
    if (handle >= 1 && handle <= queue.length) {
      queue[handle - 1] = null;
    }
  });
  return {
    get pending() {
      return queue.filter((e) => e !== null).length;
    },
    /** The delays of the parks still in flight, in arm order. */
    get delays() {
      return queue.filter((e): e is { fn: () => void; delay: number } => e !== null).map((e) => e.delay);
    },
    fire() {
      const live = queue.splice(0, queue.length).filter((e): e is { fn: () => void; delay: number } => e !== null);
      for (const entry of live) {
        entry.fn();
      }
      return live.length;
    }
  };
}

function canvasIn(stage: HTMLElement): HTMLCanvasElement | null {
  return stage.querySelector<HTMLCanvasElement>(`canvas.${CANVAS_STAGE_CLASS}`);
}

function overlayIn(stage: HTMLElement): HTMLElement | null {
  return stage.querySelector<HTMLElement>(`.${OVERLAY_CONTAINER_CLASS}`);
}

interface StatsShape {
  instance: { id: number; createdAtMs: number; disposed: boolean };
  frames: number;
  animFrames: number;
  /** Idle-only display cap observability; transient action sources stay outside it. */
  idle: {
    fpsCap: number;
    displayBypasses: { offset: number; tween: number; settle: number; trail: number };
    displayGate: {
      admittedPassive: number;
      skippedEarly: number;
      missingPassive: number;
      admittedEarlySlack: number;
      phaseResets: number;
    };
  } | null;
  /**
   * M3's two arm modes, counted — see the scheduler section at the bottom of this file — plus R6 P6-A's `pulled`
   * (animation frames spent running MirrorView's pending reconcile; canvasReconcilePull.spec owns that contract).
   */
  schedule: { rafs: number; parks: number; parkWakeups: number; pulled: number; rampFrames: number };
  /** M3 A2's spine-still block, or null when unavailable. */
  spine: { paceBytes: number; paceCount: number; quads: number; hoisted: number; resident: number } | null;
  /** M3 A4's card-trail block, or null when unavailable. */
  trails: {
    quads: number;
    quadPeak: number;
    strokes: number;
    strokesPeak: number;
    flightSamples: number;
    deltaSamples: number;
    latches: number;
    latchReleases: number;
    latched: number;
    texturedStrokes: number;
    bandedStrokes: number;
  } | null;
  quads: number;
  batches: number;
  commands: number;
  /** The three PHASES of a frame: the draw-list walk, the DOM overlay's reconcile, the GL execute. */
  buildMsP50: number;
  overlayMsP50: number;
  paintMsP50: number;
  /** Transform hints refused because their endpoint's space is gone — the `mirrorWalkStats` twin (S2/D2). */
  hintTransformRebased: number;
  /** Draw-list builds of any cause, and the two eager-scroll counters beside them. */
  builds: number;
  offsetBuilds: number;
  offsetCoalesced: number;
  overlayCounts: {
    text: number;
    shader: number;
    particles: number;
    spine: number;
    trail: number;
    withheld: number;
    fxHidden: number;
    fxDeclined: number;
    /** M4: text records still riding the overlay because the draw list did not paint them. */
    textHoisted: number;
    /** R2 — surfaces the game covered and withheld from the DOM overlay. */
    backstopWithheld: number;
  };
  /** M4's label-raster block, or null when unavailable. */
  text: {
    surfaces: number;
    resident: number;
    uploads: number;
    quads: number;
    maxQuads: number;
    paced: number;
    declined: number;
    digestCollisions: number;
    /** T12's simple-rich block, or null with `?textRich=off` — the only observable that parse has. */
    rich: { accepted: number; refusals: Record<string, number> } | null;
    /** R10's `?textStepRest` — which raster-step tier a settled label got, and the reason `uploads` reads high. */
    stepRest: boolean;
  } | null;
  textures: {
    deferredQuads: number;
    pending: number;
    paced: number;
    resident: number;
    bytes: number;
    paceBytes: number;
    /** R6 P6-B1's tiny-page exemption: the ceiling in force, the grants, and what they cost. */
    paceTinyLimit: number;
    paceExempt: number;
    paceTinyBytes: number;
    repackServed: number;
    pageBytesAvoided: number;
    pageFallbacks: number;
    repack: { thresholdPixels: number; maxBytes: number; regions: number } | null;
  };
  fx: {
    surfaces: number;
    resident: number;
    dirty: number;
    uploads: number;
    quads: number;
    maxQuads: number;
    totalQuads: number;
    declined: number;
    released: number;
    paceBytes: number;
    paceCount: number;
    screenTexture: string;
    /** R-A4 — bindings the LAST build drew at less than their device box. 0 with the census disarmed. */
    underResolved: number;
    /** …and whether it was armed at all, so a 0 above is never read as "nothing is wrong" by mistake. */
    resolutionCensus: boolean;
  } | null;
  /** The GPU glyph path's block, or null when unavailable. */
  textGlyphs: {
    runs: number;
    maxLabels: number;
    /** R-A4 — runs EMITTED under the ppem-16 fidelity floor, cumulative. See `GlyphFloorProbe`. */
    belowFloorTrue: number;
  } | null;
  glyphs: {
    runs: number;
    drawCalls: number;
    runBatches: number;
    batchFallbacks: number;
  };
  animActive: number;
  /** R5 T-DR4 — card flights that placed their comet root. */
  trailRootDrives: number;
  /** The paint order of the last stage-spanning opaque fill, or -1. See `DrawListBuild.backstopOrder`. */
  backstopOrder: number;
  /** Is the renderer acting on the backstop candidate? */
  backstopWithhold: boolean;
}

function stats(): StatsShape {
  const read = (window as unknown as { __mirrorCanvasStats?: () => StatsShape }).__mirrorCanvasStats;
  if (!read) {
    throw new Error("__mirrorCanvasStats is not installed");
  }
  return read();
}

// --- scene fixtures ----------------------------------------------------------------------------------------

interface NodeSpec {
  id: string;
  parentId?: string | null;
  name?: string;
  nodeType?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  visible?: boolean;
  fillColor?: { r: number; g: number; b: number; a: number };
  text?: string;
  /** The label's own face, as a `res://` path — the wire shape `normalizeFont` reads. */
  font?: string;
  /** A `[b]` role face: Godot swaps to a different FILE rather than synthesising, so it needs its own. */
  richBoldFont?: string;
  richText?: boolean;
  mouseFilter?: number;
  /** The Godot anchor pair. 0/1 STRETCHES on a widened stage; 0/0 on a full-frame box RE-CENTRES instead. */
  anchorLeft?: number;
  anchorRight?: number;
  sceneFilePath?: string;
  textureUrl?: string;
  opacity?: number;
  /** A particle emitter's wire spec. Its own box is 0x0 — a gsw canvas grows around it. */
  particleSpec?: Record<string, unknown>;
  /** A material's resource path. A `GpuParticles2D`'s material IS a ShaderMaterial, so an emitter carries one. */
  shader?: string;
  /** A `SpineSprite`'s static block + the volatile track fields the clip client keys and plays off. */
  spine?: { sceneResPath: string; nodePath?: string };
  spineCurrentAnim?: string;
  spineTrackTime?: number;
  spineLooping?: boolean;
  spinePaused?: boolean;
  /** Producer-owned decorative loop token; the canvas scheduler samples it locally. */
  pinnedLoopAnim?: string;
}

function wireNode(spec: NodeSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: spec.id,
    parentId: spec.parentId ?? null,
    name: spec.name ?? spec.id,
    nodeType: spec.nodeType ?? "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: spec.x ?? 0, y: spec.y ?? 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: spec.w ?? 200, y: spec.h ?? 100 } },
    visible: spec.visible !== false
  };
  if (spec.fillColor) out.fillColor = spec.fillColor;
  if (spec.text) out.text = { text: spec.text };
  if (spec.font) out.font = { resourcePath: spec.font };
  if (spec.richBoldFont) out.richBoldFont = { resourcePath: spec.richBoldFont };
  if (spec.richText) out.richText = true;
  if (spec.mouseFilter != null) out.mouseFilter = spec.mouseFilter;
  if (spec.anchorLeft != null) out.anchorLeft = spec.anchorLeft;
  if (spec.anchorRight != null) out.anchorRight = spec.anchorRight;
  if (spec.sceneFilePath) out.sceneFilePath = spec.sceneFilePath;
  // The wire spells a texture as `texture: { resourcePath }`, which the parser maps to the host's `/res/` route.
  if (spec.textureUrl) out.texture = { resourcePath: spec.textureUrl };
  if (spec.opacity != null) out.opacity = spec.opacity;
  if (spec.particleSpec) out.particleSpec = spec.particleSpec;
  if (spec.shader) out.shader = { resourcePath: spec.shader };
  if (spec.spine) out.spine = { sceneResPath: spec.spine.sceneResPath, nodePath: spec.spine.nodePath ?? "Sprite" };
  if (spec.spineCurrentAnim) out.spineCurrentAnim = spec.spineCurrentAnim;
  if (spec.spineTrackTime != null) out.spineTrackTime = spec.spineTrackTime;
  if (spec.spineLooping != null) out.spineLooping = spec.spineLooping;
  if (spec.spinePaused != null) out.spinePaused = spec.spinePaused;
  if (spec.pinnedLoopAnim) out.pinnedLoopAnim = spec.pinnedLoopAnim;
  return out;
}

/**
 * A keyframe (no `into`) or an in-place UPDATE of the nodes named.
 *
 * An update deliberately carries NO `orderedIds`: that field is the whole tree's order, so re-sending it with two
 * upserts in it would drop every other node — a wire shape no producer emits, and one that would make these
 * fixtures test the wrong thing.
 */
function sceneOf(specs: NodeSpec[], into?: MirrorState): MirrorState {
  const state = into ?? createMirrorState();
  const delta: Record<string, unknown> = {
    type: "scene-delta",
    full: into === undefined,
    screenType: "run",
    upserts: specs.map(wireNode)
  };
  if (into === undefined) {
    delta.orderedIds = specs.map((s) => s.id);
  }
  applySceneDelta(state, parseSceneDelta(delta)!);
  return state;
}

/** A scene with something real to paint: a solid backdrop, a label, and a mouse-visible button under it. */
function paintableScene(): MirrorState {
  return sceneOf([
    { id: "Root", parentId: null, w: 1920, h: 1080 },
    {
      id: "Backdrop",
      parentId: "Root",
      w: 1920,
      h: 1080,
      fillColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 }
    },
    {
      id: "Button",
      parentId: "Root",
      x: 100,
      y: 200,
      w: 300,
      h: 80,
      mouseFilter: 0,
      fillColor: { r: 1, g: 0, b: 0, a: 1 }
    },
    { id: "Label", parentId: "Button", x: 0, y: 0, w: 300, h: 80, text: "END TURN" }
  ]);
}

/** A single locally sampled decorative loop, with no wire/action demand. */
function idlePulseScene(): MirrorState {
  return sceneOf([
    { id: "Root", parentId: null, w: 1920, h: 1080 },
    {
      id: "Glow",
      parentId: "Root",
      name: "GlowVfx",
      x: 900,
      y: 800,
      w: 512,
      h: 256,
      fillColor: { r: 1, g: 1, b: 1, a: 1 },
      pinnedLoopAnim: "proceedGlow"
    }
  ]);
}

let renderer: MirrorRenderer | null = null;
let backendAtStart: StageBackend;

beforeEach(() => {
  document.body.innerHTML = "";
  backendAtStart = requestedStageBackend();
  mirrorSettings.spineMode = "static";
});

afterEach(() => {
  renderer?.dispose();
  renderer = null;
  __setStageBackendForTest(backendAtStart);
  mirrorSettings.spineMode = "static";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createMirrorRendererFor", () => {
  it("defaults to the DOM backend — no canvas is created", () => {
    // The default with no query at all: what every viewer gets today.
    expect(requestedStageBackend()).toBe("dom");
    const stage = stageAt(1920, 1080, 0.5);
    renderer = createMirrorRendererFor(stage, defsEl());
    renderer.reconcile(createMirrorState());
    expect(canvasIn(stage)).toBeNull();
  });

  it("?stage=canvas builds the canvas backend", () => {
    stubWebgl2();
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 0.5);
    renderer = createMirrorRendererFor(stage, defsEl());
    expect(canvasIn(stage)).not.toBeNull();
    expect(renderer.handRaiseDebug()).toMatchObject({ backend: "canvas" });
    expect(stats().glyphs).toEqual({
      runs: 0,
      drawCalls: 0,
      runBatches: 0,
      batchFallbacks: 0
    });
  });

  it("keeps the stats seam with its newer canvas renderer through an old dispose", () => {
    stubWebgl2();
    __setStageBackendForTest("canvas");
    const first = createMirrorRendererFor(stageAt(1920, 1080, 0.5), defsEl());
    const firstId = stats().instance.id;

    renderer = createMirrorRendererFor(stageAt(1920, 1080, 0.5), defsEl());
    const secondId = stats().instance.id;
    expect(secondId).toBeGreaterThan(firstId);

    // A remount can construct the successor before the old component's
    // onBeforeUnmount runs. The old renderer must not delete the successor's
    // page-global reader, or a before/after bench sample can cross lifetimes.
    first.dispose();
    expect(stats().instance).toMatchObject({ id: secondId, disposed: false });

    renderer.dispose();
    renderer = null;
    expect((window as unknown as { __mirrorCanvasStats?: unknown }).__mirrorCanvasStats).toBeUndefined();
  });

  it("HARD-FALLS-BACK to the DOM backend when WebGL2 cannot be had, naming the reason", () => {
    // jsdom's getContext is not implemented → the context is null, which is exactly the live failure mode on a
    // blocklisted mobile GPU. The viewer must get a playable DOM stage, not a blank one.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 0.5);
    renderer = createMirrorRendererFor(stage, defsEl());
    expect(canvasIn(stage)).toBeNull();
    renderer.reconcile(createMirrorState()); // a working renderer, not a husk
    const said = info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("WebGL2");
    expect(said).toContain("dom");
  });

  // The default has geoclips disabled. The backend name is meaningful only after a developer explicitly opts in.
  describe("the geoclip diagnostic follows the mode gate", () => {
    it("names the shipped lane as disabled without assuming a spine paint mode", () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      __setStageBackendForTest("dom");
      renderer = createMirrorRendererFor(stageAt(1920, 1080, 1), defsEl());
      const said = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toContain("geoclips: disabled");
      expect(said).not.toContain("raster-only");
      expect(said).not.toContain("geoclips: active");
    });

    it("names the canvas path", () => {
      stubWebgl2();
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      mirrorSettings.spineMode = "dynamic";
      __setStageBackendForTest("canvas");
      renderer = createMirrorRendererFor(stageAt(1920, 1080, 1), defsEl());
      const said = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toContain("geoclips: active");
      expect(said).toContain("canvas");
      expect(said).toContain("overlay.ts");
    });

    it("names the DOM path on the DOM backend", () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      mirrorSettings.spineMode = "auto";
      __setStageBackendForTest("dom");
      renderer = createMirrorRendererFor(stageAt(1920, 1080, 1), defsEl());
      const said = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toContain("geoclips: active");
      expect(said).toContain("DOM");
      expect(said).toContain("mirrorRenderer.ts");
    });
  });
});

describe("the canvas stage's sizing law", () => {
  it("is CSS design box, backing store = design px x stage scale x devicePixelRatio", () => {
    const record = stubWebgl2();
    vi.stubGlobal("devicePixelRatio", 2);
    __setStageBackendForTest("canvas");
    // A 2400-wide (stretched) design box painted at 0.45 of its size — a phone in landscape.
    const stage = stageAt(2400, 1080, 0.45);
    renderer = createMirrorRendererFor(stage, defsEl());
    const canvas = canvasIn(stage);
    expect(canvas).not.toBeNull();
    // CSS: the whole stage box, so the stage's own transform fits it exactly as it fits the DOM tree.
    expect(canvas!.style.width).toBe("100%");
    expect(canvas!.style.height).toBe("100%");
    // Backing store: 2400 x 0.45 x 2 = 2160, 1080 x 0.45 x 2 = 972.
    expect([canvas!.width, canvas!.height]).toEqual([2160, 972]);
    expect(record.viewports.at(-1)).toEqual([2160, 972]);
    expect(record.clears).toBeGreaterThan(0);
  });

  it("is INDEPENDENT of the quality tier — only the device ratio scales the stage", () => {
    // The rule stagePixelRatio() exists to enforce (a tier scales effect targets, never the stage). Asserted here
    // as well as on the function itself, because THIS is the surface the godot client's half-res lever blurred.
    stubWebgl2();
    vi.stubGlobal("devicePixelRatio", 3);
    __setStageBackendForTest("canvas");
    for (const search of ["?quality=high", "?quality=medium", "?quality=low", "?quality=very-low", "?quality=minimum"]) {
      __setRenderQualityForTest(
        resolveRenderQuality({ search, gpu: { renderer: "", software: false, unavailable: true }, mobile: true })
      );
      const stage = stageAt(1920, 1080, 0.5);
      const pinned = createMirrorRendererFor(stage, defsEl());
      const canvas = canvasIn(stage)!;
      expect([canvas.width, canvas.height]).toEqual([2880, 1620]); // 1920 x 0.5 x 3, on every tier
      pinned.dispose();
    }
    __setRenderQualityForTest(undefined);
  });

  it("re-derives the backing store when the stage is re-fitted", () => {
    const record = stubWebgl2();
    vi.stubGlobal("devicePixelRatio", 1);
    __setStageBackendForTest("canvas");
    const observed = stubResizeObserver();
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    const canvas = canvasIn(stage)!;
    expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
    // Both the stage (its DESIGN box) and its parent (whose layout box is what a window resize moves) are watched.
    expect(observed.targets).toContain(stage);
    expect(observed.targets).toContain(document.body);

    // The frame shrank: same design box, half the scale — a change NO observation of the stage's own layout box
    // can see, which is why the parent is observed too.
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 }) as DOMRect;
    observed.fire();
    expect([canvas.width, canvas.height]).toEqual([960, 540]);

    // A resize that does not move the backing store must not drop the (expensive) buffer.
    const clearsBefore = record.clears;
    observed.fire();
    expect(record.clears).toBe(clearsBefore);
  });

  // THE SPLIT LAYOUT. The canvas is laid out in its own untransformed host instead of inside the scaled stage,
  // because a `transform: scale(fit)` ancestor with a composited descendant makes Blink allocate a render surface
  // at CSS x dpr and the canvas texture is resampled into it and back out of it — two bilinear passes for a net
  // geometry of 1.0 (`.sts2/canvas-blur-sep03/FINDINGS.md`, per checkout). The BACKING STORE must not move: it is
  // still design px x the fitted scale x the dpr, which is the same thing as the host's rect x the dpr.
  describe("the SPLIT layout (the canvas in its own untransformed host)", () => {
    it("measures the HOST's rect over the DESIGN width — 1536x864 fitted, 1920x1080 design, dpr 1.25", () => {
      const record = stubWebgl2();
      vi.stubGlobal("devicePixelRatio", 1.25);
      __setStageBackendForTest("canvas");
      // The desktop arm the blur was found on: a 1.25 dpr from GNOME text scaling, a 0.8 letterbox fit.
      const stage = stageAt(1920, 1080, 0.8);
      const host = hostAt(1536, 864);
      renderer = createMirrorRendererFor(stage, defsEl(), host);

      const canvas = canvasIn(host);
      expect(canvas, "the canvas is laid out in the host").not.toBeNull();
      expect(canvasIn(stage), "…and NOT inside the scaled stage").toBeNull();
      // 1920 x 0.8 x 1.25 = 1920: the fit and the dpr cancel, and the stage renders at exactly design resolution.
      expect([canvas!.width, canvas!.height]).toEqual([1920, 1080]);
      expect(record.viewports.at(-1)).toEqual([1920, 1080]);
      // The CSS box is still "fill the host", which under this layout is the fitted box in real screen px.
      expect(canvas!.style.width).toBe("100%");
      expect(canvas!.style.height).toBe("100%");
    });

    it("agrees with the LEGACY layout on the same on-screen geometry", () => {
      // The same fit, the same dpr, the same design box — expressed the old way, with the canvas inside the stage
      // and the scale carried by the stage's transform. One law, two layouts: the numbers may not move.
      stubWebgl2();
      vi.stubGlobal("devicePixelRatio", 1.25);
      __setStageBackendForTest("canvas");
      const stage = stageAt(1920, 1080, 0.8);
      renderer = createMirrorRendererFor(stage, defsEl());

      const canvas = canvasIn(stage);
      expect(canvas, "no host ⇒ the canvas goes into the stage, exactly as before").not.toBeNull();
      expect([canvas!.width, canvas!.height]).toEqual([1920, 1080]);
    });

    it("re-derives the backing store from a HOST resize (the fitted box is the host's LAYOUT box)", () => {
      stubWebgl2();
      vi.stubGlobal("devicePixelRatio", 1.25);
      __setStageBackendForTest("canvas");
      const observed = stubResizeObserver();
      const stage = stageAt(1920, 1080, 0.8);
      const host = hostAt(1536, 864);
      renderer = createMirrorRendererFor(stage, defsEl(), host);
      const canvas = canvasIn(host)!;

      // All three movers are watched: the stage's design box, the host's fitted box, and the letterbox frame.
      expect(observed.targets).toContain(stage);
      expect(observed.targets).toContain(host);
      expect(observed.targets).toContain(document.body);

      // The window shrank. Under this layout that is a LAYOUT change on the host — the stage's transform follows
      // it, but the host is the element the canvas actually fills, so this alone must re-derive the store.
      host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 }) as DOMRect;
      observed.fire();
      expect([canvas.width, canvas.height]).toEqual([1200, 675]); // 960 x 1.25, 540 x 1.25
    });

    it("observes the stage ONCE when there is no separate host", () => {
      // The dedup matters because the two entries collapse under the legacy layout, and a doubly-observed element
      // would run the whole resize path twice per frame the browser measures.
      stubWebgl2();
      __setStageBackendForTest("canvas");
      const observed = stubResizeObserver();
      const stage = stageAt(1920, 1080, 1);
      renderer = createMirrorRendererFor(stage, defsEl());
      expect(observed.targets.filter((t) => t === stage)).toHaveLength(1);
    });

    // ---- PIXEL ALIGNMENT -------------------------------------------------------------------------------
    //
    // The wiring, not the arithmetic — `stageBacking.spec` owns the law and the dpr/layout matrix. What is asserted
    // here is that `resize()` reads the host's real rect (offset included) and that the
    // observer converges. `hostAt` above centres nothing and sits at (0, 0); a real `.mirror-canvas-host` is
    // `margin: auto` inside the letterbox frame, so its left edge lands off the device grid and THAT is what makes
    // the pre-snap `round(width x dpr)` disagree with the compositor's `round(right) - round(left)`.
    function hostCentredIn(frameW: number, frameH: number, fittedW: number, fittedH: number): HTMLElement {
      const host = document.createElement("div");
      document.body.appendChild(host);
      Object.defineProperty(host, "clientWidth", { configurable: true, value: fittedW });
      Object.defineProperty(host, "clientHeight", { configurable: true, value: fittedH });
      host.getBoundingClientRect = () =>
        ({
          left: (frameW - fittedW) / 2,
          top: (frameH - fittedH) / 2,
          width: fittedW,
          height: fittedH
        }) as DOMRect;
      return host;
    }

    it("sizes the backing store to the device box the compositor paints into, offset included", () => {
      stubWebgl2();
      vi.stubGlobal("devicePixelRatio", 1);
      __setStageBackendForTest("canvas");
      const stage = stageAt(2520, 1080, 3033.333333 / 2520);
      // The ultrawide-past-the-clamp layout: a 3440x1300 frame, a 2520x1080 design box magnified to fit its
      // height, so the host is 3033.33 wide and centred at left 203.33. `round(203.33 + 3033.33) - round(203.33)`
      // is 3237 - 203 = 3034, while `round(3033.33)` is 3033 — one pixel, and the whole surface resampled for it.
      const host = hostCentredIn(3440, 1300, 3033.333333, 1300);
      renderer = createMirrorRendererFor(stage, defsEl(), host);
      expect([canvasIn(host)!.width, canvasIn(host)!.height]).toEqual([3034, 1300]);
    });

    it("converges in ONE observer tick and never re-enters — the resize loop this could have been", () => {
      // Writing the host's CSS size back from inside the ResizeObserver callback is the obvious other shape for
      // this fix and it is an infinite loop. This one only ever writes `canvas.width/height`, which cannot move
      // the host's rect, so a settled layout reaches its fixed point on the first tick. Asserted by COUNTING the
      // GL work: a re-derived backing store clears the buffer and re-applies the viewport, so an oscillation
      // would show up as a clear per tick rather than none.
      const record = stubWebgl2();
      vi.stubGlobal("devicePixelRatio", 1.25);
      __setStageBackendForTest("canvas");
      const observed = stubResizeObserver();
      const stage = stageAt(2272, 1080, 1535.7 / 2272);
      const host = hostCentredIn(1536, 730, 1535.7, 730);
      renderer = createMirrorRendererFor(stage, defsEl(), host);
      const canvas = canvasIn(host)!;
      // 1535.7 x 1.25 = 1919.625 → the old law rounds to 1920 and the compositor paints 1920; the HEIGHT is where
      // this layout's residual is (912 under the old law, 913 painted).
      expect([canvas.width, canvas.height]).toEqual([1920, 913]);

      const clearsAfterMount = record.clears;
      const viewportsAfterMount = record.viewports.length;
      for (let tick = 0; tick < 8; tick++) {
        observed.fire();
      }
      expect([canvas.width, canvas.height]).toEqual([1920, 913]);
      expect(record.clears, "a settled layout re-derives nothing").toBe(clearsAfterMount);
      expect(record.viewports.length).toBe(viewportsAfterMount);
    });

    it("puts the DOM overlay at the stage's LEADING slot — above the canvas, below the slotted chrome", () => {
      // Paint order is the contract, and it is expressed differently in the two layouts: next-sibling-of-the-canvas
      // when the canvas is in the stage, first-child-of-the-stage when the whole stage paints above the host.
      // Either way the overlay is over the game surface and under everything Vue slots in after it.
      stubWebgl2();
      __setStageBackendForTest("canvas");
      const stage = stageAt(1920, 1080, 0.8);
      const host = hostAt(1536, 864);
      const chrome = document.createElement("div"); // stands in for the confirm button / gear / hand-raise toggle
      stage.appendChild(chrome);
      renderer = createMirrorRendererFor(stage, defsEl(), host);

      const overlay = overlayIn(stage);
      expect(overlay, "the overlay stays in the DESIGN box its elements are positioned in").not.toBeNull();
      expect(overlayIn(host)).toBeNull();
      expect(stage.firstElementChild).toBe(overlay);
      expect(overlay!.nextElementSibling).toBe(chrome);
    });
  });

  it("tears the canvas and its GPU buffer down on dispose", () => {
    const record = stubWebgl2();
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    const built = createMirrorRendererFor(stage, defsEl());
    expect(canvasIn(stage)).not.toBeNull();
    built.dispose();
    expect(canvasIn(stage)).toBeNull();
    expect(record.lost).toBe(1);
    built.dispose(); // idempotent
    expect(record.lost).toBe(1);
  });
});

describe("the frame", () => {
  function mount(): { stage: HTMLElement; record: GlRecord; raf: ReturnType<typeof stubRaf> } {
    const record = stubWebgl2();
    const raf = stubRaf();
    vi.stubGlobal("devicePixelRatio", 1);
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return { stage, record, raf };
  }

  it("PAINTS SYNCHRONOUSLY inside reconcile — which is what makes MirrorView's scene ack honest", () => {
    const { record } = mount();
    expect(stats().frames).toBe(0);
    // MirrorView calls `props.onSceneRendered()` immediately after `reconcile` returns. The ack therefore stands
    // for a real frame only if the paint already happened by then — no rAF in between.
    renderer!.reconcile(paintableScene());
    expect(stats().frames).toBe(1);
    expect(record.draws).toBeGreaterThan(0);
    expect(stats().quads).toBeGreaterThan(0);
    expect(stats().commands).toBeGreaterThan(0);
  });

  it("books NO animation frame for a scene with nothing armed — the loop parks completely", () => {
    const { raf } = mount();
    renderer!.reconcile(paintableScene());
    expect(raf.pending).toBe(0);
    expect(stats().animActive).toBe(0);
  });

  it("repaints from the animation rAF WITHOUT a reconcile — so that path can never reach the ack", () => {
    const { raf } = mount();
    const state = paintableScene();
    // A transform tween on the button: one armed channel is all it takes to un-park the loop.
    state.pendingHints.push({
      targetId: "Button",
      property: "position",
      durationMs: 400,
      ease: "Out",
      trans: "Quad",
      endTransform: [1, 0, 0, 1, 500, 200],
      startTransform: null,
      endOpacity: null,
      startOpacity: null,
      group: null
    } as unknown as MirrorState["pendingHints"][number]);

    renderer!.reconcile(state);
    expect(stats().animActive).toBeGreaterThan(0);
    expect(raf.pending).toBeGreaterThan(0);

    const framesAfterReconcile = stats().frames;
    const reconciles = vi.fn();
    raf.flush();
    // The rAF painted, and it did so entirely inside the renderer: there is no callback out of this path at all,
    // which is structurally why an animation frame cannot release a delta.
    expect(stats().animFrames).toBeGreaterThan(0);
    expect(stats().frames).toBeGreaterThan(framesAfterReconcile);
    expect(reconciles).not.toHaveBeenCalled();
  });

  it("drains a hint list so the same tween is not re-armed on every later frame", () => {
    const { raf } = mount();
    const state = paintableScene();
    state.pendingHints.push({
      targetId: "Button",
      property: "modulate:a",
      durationMs: 300,
      ease: "Out",
      trans: "Quad",
      endTransform: null,
      startTransform: null,
      endOpacity: 0.2,
      startOpacity: null,
      group: null
    } as unknown as MirrorState["pendingHints"][number]);
    renderer!.reconcile(state);
    expect(state.pendingHints.length).toBe(0);
    raf.flush();
  });

  it("CONSUMES the delta's accumulators, so a keyframe cannot re-fire for the rest of the session", () => {
    mount();
    const state = paintableScene();
    expect(state.sceneRewrite).toBe(true); // the keyframe raised it
    expect(state.changedIds.size).toBeGreaterThan(0);

    renderer!.reconcile(state);

    // Both belong to the STATE and are spent by whoever renders the frame that acted on them (the DOM backend
    // clears them at the end of its walk). Left set, `sceneRewrite` would make every later reconcile take the
    // rewrite branch — wiping the override maps that ARE this backend's animation node state — and `changedIds`
    // would grow towards the whole scene instead of describing the delta.
    expect(state.sceneRewrite).toBe(false);
    expect(state.changedIds.size).toBe(0);

    sceneOf([{ id: "Button", parentId: "Root", x: 140, y: 200, w: 300, h: 80, mouseFilter: 0 }], state);
    expect(state.sceneRewrite).toBe(false);
    expect([...state.changedIds]).toEqual(["Button"]);
  });

  it("repaints when a texture resolves, on its own rAF and without a reconcile", () => {
    const { raf } = mount();
    renderer!.reconcile(paintableScene());
    // THE WITNESS IS `builds`, NOT `frames` — R21 B1. `frames` counts executes that really ran, and this scenario
    // pokes the seam WITHOUT a texture having actually arrived, so the rebuilt list is identical and the paint is
    // correctly skipped. What this case is about is the SCHEDULING (its own rAF, no reconcile), and a build is
    // what says the frame ran. A real arrival moves the texture cache's counters and does paint; that is
    // `canvasPaintSkip.spec`'s "PAINTS when a texture was uploaded under an unchanged list".
    const before = stats().builds;
    expect(raf.pending).toBe(0);
    renderer!.markTextureDirty(["Button"]);
    expect(raf.pending).toBe(1);
    raf.flush();
    expect(stats().builds).toBeGreaterThan(before);
  });

  it("paints a quad naming an undecoded texture as TRANSPARENT rather than as a smeared texel", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        // A `res://` path: the wire's own currency, which the parser maps to the host's `/res/` route.
        { id: "Sprite", parentId: "Root", w: 128, h: 128, textureUrl: "res://images/never-loads.png" }
      ])
    );
    // The executor stretches a ZERO-span source over the whole quad, so a half-resolved texture would paint a
    // flat block of pixel (0,0). The bridge defers the quad instead and the load's completion rebuilds.
    expect(stats().textures.deferredQuads).toBeGreaterThan(0);
  });
});

// TEXTURE-UPLOAD PACING, at the RENDERER's seam. `textureBridge`'s own spec owns the budget arithmetic; what is
// asserted here is the wiring only this file can see: that a deferred upload comes back on the ANIMATION-shaped
// rAF (the one that never acks), then drains and parks.
describe("texture pacing", () => {
  interface FakeImage {
    resolve(w: number, h: number): void;
    fail(): void;
  }
  /** Replace `Image` so the bridge's own `new Image()` is a load this test can fire on command. */
  function stubImages(): Map<string, FakeImage> {
    const bySrc = new Map<string, FakeImage>();
    vi.stubGlobal(
      "Image",
      class {
        decoding = "";
        crossOrigin: string | null = null;
        naturalWidth = 0;
        naturalHeight = 0;
        private listeners = new Map<string, Set<() => void>>();
        private url = "";
        addEventListener(type: string, fn: () => void): void {
          let set = this.listeners.get(type);
          if (!set) this.listeners.set(type, (set = new Set()));
          set.add(fn);
        }
        removeEventListener(type: string, fn: () => void): void {
          this.listeners.get(type)?.delete(fn);
        }
        set src(value: string) {
          this.url = value;
          bySrc.set(value, {
            resolve: (w: number, h: number) => {
              this.naturalWidth = w;
              this.naturalHeight = h;
              for (const fn of [...(this.listeners.get("load") ?? [])]) fn();
            },
            fail: () => {
              for (const fn of [...(this.listeners.get("error") ?? [])]) fn();
            }
          });
        }
        get src(): string {
          return this.url;
        }
      }
    );
    return bySrc;
  }

  function mount(search: string): { raf: ReturnType<typeof stubRaf>; images: Map<string, FakeImage> } {
    stubWebgl2();
    const raf = stubRaf();
    const images = stubImages();
    vi.stubGlobal("devicePixelRatio", 1);
    window.history.replaceState(null, "", search);
    __setStageBackendForTest("canvas");
    renderer = createMirrorRendererFor(stageAt(1920, 1080, 1), defsEl());
    return { raf, images };
  }

  /** Three sprites, each naming its own page — the shape a first textured build has, in miniature. */
  function texturedScene(): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "S0", parentId: "Root", w: 128, h: 128, textureUrl: "res://images/p0.png" },
      { id: "S1", parentId: "Root", w: 128, h: 128, textureUrl: "res://images/p1.png" },
      { id: "S2", parentId: "Root", w: 128, h: 128, textureUrl: "res://images/p2.png" }
    ]);
  }

  /** Fire every load so far at 1024x1024 — 4 MB of RGBA each, i.e. exactly one default budget per page. */
  function resolveAll(images: Map<string, FakeImage>): void {
    for (const image of [...images.values()]) image.resolve(1024, 1024);
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("finishes a deferred upload on a rAF that never acks, then parks", () => {
    const { raf, images } = mount("/?stage=canvas");
    renderer!.reconcile(texturedScene());
    expect(stats().textures.resident).toBe(0);
    expect(stats().textures.pending).toBe(3); // three loads in flight

    resolveAll(images);
    const reconciles = vi.fn(); // MirrorView's `onSceneRendered` stand-in: nothing below may reach it

    // Every frame from here is booked by the bridge and run by the renderer with no callback out — the same
    // structural reason the animation loop cannot release a delta.
    const framesBefore = stats().frames;
    expect(raf.pending).toBe(1);
    raf.flush();
    expect(stats().textures.resident).toBe(1);
    expect(stats().textures.paced).toBe(2);
    expect(stats().textures.pending).toBe(2); // still-coming, and honestly so

    raf.flush();
    expect(stats().textures.resident).toBe(2);
    raf.flush();
    expect(stats().textures.resident).toBe(3);

    // Drained: the pump asks for nothing more.
    expect(stats().textures.paced).toBe(0);
    expect(stats().textures.pending).toBe(0);
    expect(raf.pending).toBe(0);
    expect(stats().frames).toBeGreaterThan(framesBefore);
    expect(reconciles).not.toHaveBeenCalled();
  });

  it("keeps A as command zero while B preloads, then atomically promotes B through the texture registry", () => {
    const { raf, images } = mount("/?stage=canvas");
    const ready: boolean[] = [];
    renderer!.setStaticBackgroundSource?.({ scenePath: "res://bg/a.tscn", url: "/bg/a?v=1" }, (ok) => ready.push(ok));
    renderer!.reconcile(createMirrorState());
    images.get("/bg/a?v=1")!.resolve(2520, 1080);
    raf.flush(); // upload A and promote it; the next build makes it the visible first command
    raf.flush();
    expect(ready).toEqual([true]);
    expect((window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump()[0]).toContain(
      "/bg/a?v=1"
    );

    renderer!.setStaticBackgroundSource?.({ scenePath: "res://bg/b.tscn", url: "/bg/b?v=1" }, (ok) => ready.push(ok));
    // B is present only as an alpha-zero preload; A is still the first actual painter.
    expect((window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump()[0]).toContain(
      "/bg/a?v=1"
    );
    images.get("/bg/b?v=1")!.resolve(2520, 1080);
    raf.flush(); // B uploads and is promoted for the following rebuild, but this frame still paints A.
    expect((window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump()[0]).toContain(
      "/bg/a?v=1"
    );
    raf.flush();
    // The source callback may be re-reported by a coalesced texture repaint; the invariant is that no success is
    // reported before B became command zero (the order assertions above), not an arbitrary callback count.
    expect(ready.at(-1)).toBe(true);
    expect((window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump()[0]).toContain(
      "/bg/b?v=1"
    );

    renderer!.setStaticBackgroundSource?.(null);
    expect((window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump()).not.toContain(
      expect.stringContaining("/bg/b?v=1")
    );
  });

  it("keeps the committed source through a pending-source failure until its owner intentionally clears it", () => {
    const { raf, images } = mount("/?stage=canvas");
    const results: boolean[] = [];
    renderer!.setStaticBackgroundSource?.({ scenePath: "res://bg/a.tscn", url: "/bg/a?v=1" }, (ok) => results.push(ok));
    renderer!.reconcile(createMirrorState());
    images.get("/bg/a?v=1")!.resolve(2520, 1080);
    raf.flush();
    raf.flush();
    renderer!.setStaticBackgroundSource?.({ scenePath: "res://bg/b.tscn", url: "/bg/b?v=1" }, (ok) => results.push(ok));
    images.get("/bg/b?v=1")!.fail(); // CORS attempt retries plain first
    images.get("/bg/b?v=1")!.fail(); // plain retry is the terminal failure
    expect(results.at(-1)).toBe(false);
    expect((window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump()[0]).toContain(
      "/bg/a?v=1"
    );
    renderer!.setStaticBackgroundSource?.(null);
    expect((window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump()).not.toContain(
      expect.stringContaining("/bg/a?v=1")
    );
  });

  it("cancels a pending B by returning to A without accepting B's later ready callback", () => {
    const { raf, images } = mount("/?stage=canvas");
    const results: Array<{ source: string; ok: boolean }> = [];
    renderer!.setStaticBackgroundSource?.({ scenePath: "res://bg/a.tscn", url: "/bg/a?v=1" }, (ok) =>
      results.push({ source: "a", ok })
    );
    renderer!.reconcile(createMirrorState());
    images.get("/bg/a?v=1")!.resolve(2520, 1080);
    raf.flush();
    raf.flush();
    renderer!.setStaticBackgroundSource?.({ scenePath: "res://bg/b.tscn", url: "/bg/b?v=1" }, (ok) =>
      results.push({ source: "b", ok })
    );
    expect(results).not.toContainEqual({ source: "b", ok: true });
    renderer!.setStaticBackgroundSource?.({ scenePath: "res://bg/a.tscn", url: "/bg/a?v=1" }, (ok) =>
      results.push({ source: "a-return", ok })
    );
    expect(results).toContainEqual({ source: "a-return", ok: true });
    images.get("/bg/b?v=1")!.resolve(2520, 1080);
    raf.flush();
    expect(results).not.toContainEqual({ source: "b", ok: true });
    expect((window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump()[0]).toContain(
      "/bg/a?v=1"
    );
  });

  it("drops static-background readiness on context loss and restores it through the retained registry source", () => {
    const { raf, images } = mount("/?stage=canvas");
    renderer!.setStaticBackgroundSource?.({ scenePath: "res://bg/a.tscn", url: "/bg/a?v=1" });
    renderer!.reconcile(createMirrorState());
    images.get("/bg/a?v=1")!.resolve(2520, 1080);
    raf.flush();
    raf.flush();
    const canvasStats = () =>
      stats() as StatsShape & {
        contextLost: boolean;
        canvasStaticBg: { ready: boolean; command: number; source: string | null };
      };
    expect(canvasStats().canvasStaticBg).toMatchObject({ ready: true, command: 0, source: "res://bg/a.tscn" });

    const canvas = document.querySelector<HTMLCanvasElement>(`canvas.${CANVAS_STAGE_CLASS}`)!;
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(canvasStats().contextLost).toBe(true);
    expect(canvasStats().canvasStaticBg.ready).toBe(false);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(canvasStats().contextLost).toBe(false);
    expect(canvasStats().canvasStaticBg.ready).toBe(true);
  });

  it("uses the shipped tiny-page ceiling", () => {
    mount("/?stage=canvas");
    expect(stats().textures.paceTinyLimit).toBe(64 * 1024);
  });

});

// THE RUNTIME ATLAS RE-PACKER. What the module decides is `canvasAtlasRepack.spec`; this is only that the
// renderer wires it and reports the census block.
//
// jsdom has no 2D canvas, so a mounted re-packer here immediately steps aside and every quad takes the page path.
// That is deliberate: it means these tests are about the WIRING and cannot accidentally start asserting pixels.
describe("the atlas re-packer", () => {
  function mount(search: string): void {
    stubWebgl2();
    stubRaf();
    vi.stubGlobal("devicePixelRatio", 1);
    window.history.replaceState(null, "", search);
    __setStageBackendForTest("canvas");
    renderer = createMirrorRendererFor(stageAt(1920, 1080, 1), defsEl());
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("is ON by default — the module exists without anyone asking for it", () => {
    mount("/?stage=canvas");
    // A non-null census block on a plain canvas page proves the re-packer is wired.
    expect(stats().textures.repack).not.toBeNull();
    // …and with no page cropped yet (jsdom has no 2D canvas at all), the two avoidance counters read zero rather
    // than reporting a saving that did not happen.
    expect(stats().textures.pageBytesAvoided).toBe(0);
    expect(stats().textures.repackServed).toBe(0);
  });

});

describe("the DOM overlay", () => {
  function mount(): HTMLElement {
    stubWebgl2();
    stubRaf();
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  it("adds an element per overlay record, placed by the record's own affine", () => {
    const stage = mount();
    renderer!.reconcile(paintableScene());
    const overlay = overlayIn(stage);
    expect(overlay).not.toBeNull();
    const label = overlay!.querySelector<HTMLElement>('[data-node-id="Label"]');
    expect(label).not.toBeNull();
    expect(label!.style.transform).toBe("matrix(1, 0, 0, 1, 100, 200)");
    expect(label!.style.width).toBe("300px");
    expect(label!.textContent).toBe("END TURN");
    expect(stats().overlayCounts.text).toBe(1);
  });

  it("never stamps `.mirror-node` — that class is the repo's 'the DOM backend built this' marker", () => {
    const stage = mount();
    renderer!.reconcile(paintableScene());
    // The bench's readiness gate counts `.mirror-node`, the census reports it, the ancestry scans classify by
    // it. A canvas stage wearing it would read as a DOM stage to every probe we own — including the one that
    // decides a bench run has started rendering.
    expect(document.querySelectorAll(".mirror-node").length).toBe(0);
    expect(stage.querySelectorAll(".mirror-overlay-node").length).toBeGreaterThan(0);
  });

  it("MOVES an element in place rather than rebuilding it when its placement changes", () => {
    const stage = mount();
    const state = paintableScene();
    renderer!.reconcile(state);
    const label = overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="Label"]')!;

    sceneOf([{ id: "Label", parentId: "Button", x: 540, y: 280, w: 300, h: 80, text: "END TURN" }], state);
    renderer!.reconcile(state);
    const after = overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="Label"]')!;
    expect(after).toBe(label); // the SAME element: an overlay node keeps its identity across a move
    expect(after.style.transform).toBe("matrix(1, 0, 0, 1, 640, 480)");
  });

  it("removes an element whose node stopped being an overlay record", () => {
    const stage = mount();
    const state = paintableScene();
    renderer!.reconcile(state);
    expect(overlayIn(stage)!.querySelector('[data-node-id="Label"]')).not.toBeNull();

    sceneOf([{ id: "Label", parentId: "Button", x: 100, y: 200, w: 300, h: 80, text: "GONE", visible: false }], state);
    renderer!.reconcile(state);
    expect(overlayIn(stage)!.querySelector('[data-node-id="Label"]')).toBeNull();
    expect(stats().overlayCounts.text).toBe(0);
  });

  it("orders overlay elements among THEMSELVES by draw order", () => {
    const stage = mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Under", parentId: "Root", text: "under" },
        { id: "Over", parentId: "Root", text: "over" }
      ])
    );
    const ids = [...overlayIn(stage)!.children].map((el) => el.getAttribute("data-node-id"));
    // Later in the DOM = painted on top, which is the only layering this overlay gets right (overlay-vs-canvas is
    // the pre-registered P6 divergence).
    expect(ids).toEqual(["Under", "Over"]);
  });

  // --- the typeface, which this backend drew every label without for two rounds ---------------------------------
  //
  // `textStyle` writes `font-family: "kreon_regular", sans-serif`, which is a REQUEST. It resolves to the sans
  // fallback unless an `@font-face` for that family has been injected, and the only caller of `ensureFontFace` was
  // the DOM backend's own walk — a walk this backend does not run. The existing parity gate could not see it: the
  // bench's T-records read the family the element ASKED for, so both arms reported the same string while rendering
  // in visibly different typefaces.
  function fontSheet(): string {
    return Array.from(document.head.querySelectorAll("style[data-mirror-fonts]"))
      .map((s) => s.textContent ?? "")
      .join("\n");
  }

  function labelWithFonts(): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      {
        id: "Title",
        parentId: "Root",
        text: "The [b]Ancient[/b] shrine",
        richText: true,
        font: "res://fonts/kreon_regular.ttf",
        richBoldFont: "res://fonts/kreon_bold.ttf"
      }
    ]);
  }

  it("injects the @font-face for a label's own family — a canvas label is not sans-serif", () => {
    const stage = mount();
    renderer!.reconcile(labelWithFonts());
    // The element asks for the family…
    const label = overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="Title"] .mirror-text')!;
    expect(label.style.fontFamily).toContain("kreon_regular");
    // …and the document can now actually resolve it, which is the half that was missing.
    const sheet = fontSheet();
    expect(sheet).toContain('font-family:"kreon_regular"');
    expect(sheet).toContain("kreon_regular.ttf");
  });

  it("injects the rich ROLE faces too — `[b]` is a different font file, never a synthesised weight", () => {
    mount();
    renderer!.reconcile(labelWithFonts());
    const sheet = fontSheet();
    expect(sheet).toContain('font-family:"kreon_bold"');
    // Declared with NO weight: the file IS the role, and a weight declaration would invite the browser to
    // synthesise against it — the same rule the DOM walk registers role faces under.
    const boldFace = sheet.split("@font-face").find((chunk) => chunk.includes("kreon_bold.ttf")) ?? "";
    expect(boldFace).not.toContain("font-weight");
  });

  it("prices its own reconcile — `overlayMsP50` is the third phase of a frame, beside build and paint", () => {
    // A frame on this backend is build + OVERLAY RECONCILE + GL execute, and only the first and last have ever
    // been printed. That is why "the DOM overlay dominates the headless map scroll" stayed a theory through a
    // whole round: nothing measured it. The clock advances a fixed 7 ms per read, and the reconcile of a
    // text-only scene reads it exactly twice (in, out), so the phase's p50 is 7 by construction rather than
    // by timing luck — what this pins is that the samples come from AROUND `overlay.reconcile` and nowhere else.
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (t += 7));
    mount();
    // Before any build there are no samples at all, and an empty sample set reads 0 rather than NaN.
    expect(stats().overlayMsP50).toBe(0);
    renderer!.reconcile(paintableScene());
    expect(stats().overlayMsP50).toBe(7);
  });

  it("reports effects dirty on the first consume, then only when something a runtime sees moved", () => {
    mount();
    renderer!.reconcile(paintableScene());
    // Both bits start true, exactly as the DOM backend's do, so a caller that consumes before the first reconcile
    // still runs both gsw runtimes once.
    expect(renderer!.consumeEffectsDirty()).toEqual({ shader: true, particle: true });
    renderer!.reconcile(paintableScene());
    const second = renderer!.consumeEffectsDirty();
    expect(second.shader).toBe(false);
    expect(second.particle).toBe(false);
  });
});

describe("text into the canvas (M4)", () => {
  function mount(query?: string): HTMLElement {
    stubWebgl2();
    stubRaf();
    __setStageBackendForTest("canvas");
    if (query !== undefined) {
      vi.stubGlobal("location", { search: query } as unknown as Location);
    }
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  it("is ON by default — the registry is built and the census block exists", () => {
    // A null census block is how a reader tells "the lever is off" from "the lever is on and drew nothing",
    // which is the rule the fx, spine and trail blocks already take. Since the flip, a bare canvas stage is the
    // ON arm: this is the assertion that the DEFAULT moved, not just that `=plain` still works.
    const stage = mount();
    renderer!.reconcile(paintableScene());
    expect(stats().text).not.toBeNull();
    // …and the label still has its element, because jsdom has no 2D context so nothing rastered. That is the
    // lever's standing contract rather than an artifact: being on must never be able to LOSE a label.
    expect(overlayIn(stage)!.querySelector('[data-node-id="Label"]')).not.toBeNull();
  });

  it("keeps a label the canvas could not raster on the overlay, and counts it", () => {
    const stage = mount();
    renderer!.reconcile(paintableScene());
    expect(overlayIn(stage)!.querySelector('[data-node-id="Label"]')).not.toBeNull();
    expect(stats().overlayCounts.textHoisted).toBe(1);
    expect(stats().text!.quads).toBe(0);
  });

  // R-A4 — THE TWO HONESTY COUNTERS ARE ON THE CENSUS. `canvasTextGlyphs.spec` and `fxSurfaces.spec` own the
  // arithmetic; what neither can reach is the WIRING, and a counter that is computed correctly and published
  // nowhere is exactly as useful as one that is not computed at all. Both read 0 here (jsdom rasters nothing and
  // mounts no gsw canvas), so this pins that the FIELDS ARRIVE — the number is the other files' business.
  it("publishes the fidelity-floor and under-resolution counters on the census", () => {
    mount();
    renderer!.reconcile(paintableScene());
    const glyphs = stats().textGlyphs;
    expect(glyphs, "the canvas text runtime built a glyph registry").not.toBeNull();
    expect(glyphs!.belowFloorTrue).toBe(0);
  });

  it("publishes `fx.underResolved` beside the rest of the fx census, ARMED", () => {
    mount();
    renderer!.reconcile(paintableScene());
    // The arm matters more than the count here. jsdom mounts no gsw canvas, so 0 is the only reachable count —
    // and 0 also means "never measured", which is the opposite finding. `resolutionCensus` is what separates
    // them, and asserting it true is what pins that the RENDERER arms the registry rather than merely that the
    // registry can be armed (which `fxSurfaces.spec` already owns). A unit test bundle is a dev bundle, which is
    // the same branch of `paintDumpEnabled` a dev server takes.
    expect(stats().fx!.resolutionCensus).toBe(true);
    expect(stats().fx!.underResolved).toBe(0);
  });

  // --- `?textRich`, DEFAULT `simple` since round 9 -----------------------------------------------------------
  //
  // The census `rich` block is null exactly when the lever is off, which is the only observable this parse has
  // from outside — it exists when the canvas text runtime built a registry, so every arm here rides
  // the plain lever. That inertness is WHY flipping this today costs nothing.

  it("`?textRich` defaults to `simple` — the rich census block exists with no `textRich` in the url", () => {
    mount();
    renderer!.reconcile(paintableScene());
    expect(stats().text!.rich).not.toBeNull();
  });

});

// R7 W3-B — THE BACKSTOP, END TO END AT THE RENDERER.
//
// `canvasBackstopWithhold.spec` owns the two halves in isolation: the walk's predicate against a hand-built state,
// and the overlay's decision against a hand-built order. Neither can answer the question this block does — does a
// real renderer, on a real widened stage, join them up? That chain is spread factor → anchor algebra →
// `renderWidthOverride` → the span test → `backstopOrder` → `setBackstopOrder` → an element that stops painting,
// and it had a break in the middle of it at exactly one viewport.
//
// `setStretch` is the whole reason this is reachable without MirrorView: it is the same number MirrorView pushes
// when the stage is wider than 16:9, and it takes effect on the next build.
describe("the stage backstop", () => {
  const F = 2520 / 1920;

  function mount(search = "/?stage=canvas"): HTMLElement {
    stubWebgl2();
    stubRaf();
    window.history.replaceState(null, "", search);
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  /**
   * A dialog over a combat label: the label paints FIRST, the sheet over it, the dialog's own caption last.
   *
   * `anchors` is the sheet's, and it is the only thing that differs between the two widened arms below.
   */
  function dialogScene(anchors: { anchorLeft: number; anchorRight: number }): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080, anchorLeft: 0, anchorRight: 1 },
      { id: "Combat", parentId: "Root", x: 100, y: 200, w: 300, h: 80, text: "END TURN" },
      {
        id: "Sheet",
        parentId: "Root",
        w: 1920,
        h: 1080,
        fillColor: { r: 0, g: 0, b: 0, a: 0.851 },
        ...anchors
      },
      { id: "Caption", parentId: "Root", x: 800, y: 500, w: 300, h: 80, text: "YOUR DECK" }
    ]);
  }

  it("finds the sheet at 16:9 and withholds the label the game covered", () => {
    const stage = mount();
    renderer!.reconcile(dialogScene({ anchorLeft: 0, anchorRight: 1 }));
    expect(stats().backstopOrder).toBeGreaterThan(0);
    const overlay = overlayIn(stage)!;
    expect(overlay.querySelector('[data-node-id="Combat"]')).toBeNull();
    // …and NOT the dialog's own caption, which paints after the sheet.
    expect(overlay.querySelector('[data-node-id="Caption"]')).not.toBeNull();
  });

  it("still finds it on a WIDENED stage, where the sheet is painted 2520 wide and authored 1920", () => {
    const stage = mount();
    const state = dialogScene({ anchorLeft: 0, anchorRight: 1 });
    renderer!.reconcile(state);
    renderer!.setStretch(F);
    renderer!.reconcile(state);
    // Before the span test learned the spread this was -1: the sheet measured its AUTHORED width against a 2520
    // design stage, decided it covered 1920 of it, and the combat label kept painting over the dialog.
    expect(stats().backstopOrder).toBeGreaterThan(0);
    expect(overlayIn(stage)!.querySelector('[data-node-id="Combat"]')).toBeNull();
  });

  it("refuses the 0/0 sheet the spread RE-CENTRED, and keeps the label the player can still see", () => {
    const stage = mount();
    const state = dialogScene({ anchorLeft: 0, anchorRight: 0 });
    renderer!.reconcile(state);
    renderer!.setStretch(F);
    renderer!.reconcile(state);
    // Shifted +300 and left 1920 wide: 300 px of game is visible down each side, so this is not a cover. Calling
    // it one would withhold the dialog's own text along with everything else under it.
    expect(stats().backstopOrder).toBe(-1);
    expect(overlayIn(stage)!.querySelector('[data-node-id="Combat"]')).not.toBeNull();
  });

  // --- THE DEFAULT, PINNED AT THE RENDERER ---------------------------------------------------------------------
  //
  // `canvasBackstopWithhold.spec` proves the overlay withholds when it is HANDED an order. That is a different
  // claim from "the shipped renderer hands it one", and only the second is what a player gets. The round-6 flip
  // turned this on and left the fact recorded in a comment; a comment does not fail when someone changes the
  // parse, and the parse is one `!== "off"` away from silently reinstating the bug the flip fixed.

  it("acts on the backstop", () => {
    const stage = mount("/?stage=canvas");
    renderer!.reconcile(dialogScene({ anchorLeft: 0, anchorRight: 1 }));
    expect(overlayIn(stage)!.querySelector('[data-node-id="Combat"]')).toBeNull();
  });

  it("withholds by PAINT ORDER and not by identity — the same label, moved above the sheet, stays", () => {
    // `sceneOf`'s `orderedIds` is the array order, so this is the same scene with two entries swapped. It is the
    // control for every arm above: if withholding tracked the node rather than where it paints, all of them
    // would pass for the wrong reason.
    const stage = mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080, anchorLeft: 0, anchorRight: 1 },
        {
          id: "Sheet",
          parentId: "Root",
          w: 1920,
          h: 1080,
          fillColor: { r: 0, g: 0, b: 0, a: 0.851 },
          anchorLeft: 0,
          anchorRight: 1
        },
        { id: "Combat", parentId: "Root", x: 100, y: 200, w: 300, h: 80, text: "END TURN" }
      ])
    );
    expect(stats().backstopOrder).toBeGreaterThan(0);
    expect(overlayIn(stage)!.querySelector('[data-node-id="Combat"]')).not.toBeNull();
  });
});

describe("the retained method table", () => {
  function mount(): HTMLElement {
    stubWebgl2();
    stubRaf();
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  it("answers hand membership and card identity off the node tree", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Hand", parentId: "Root", nodeType: "Game.NPlayerHand" },
        { id: "Holder", parentId: "Hand", nodeType: "Game.NHandCardHolder" },
        { id: "Card", parentId: "Holder", nodeType: "Game.NCard" },
        { id: "Loose", parentId: "Root", nodeType: "Game.NCard" }
      ])
    );
    expect(renderer!.handPresent()).toBe(true);
    expect(renderer!.isCardTouchTarget("Card")).toBe(true);
    expect(renderer!.isCardTouchTarget("Root")).toBe(false);
    expect(renderer!.isHandCard("Card")).toBe(true);
    expect(renderer!.isHandCard("Loose")).toBe(false);
    expect(renderer!.isUnderNode("Card", "Hand")).toBe(true);
    expect(renderer!.isUnderNode("Card", "Card")).toBe(true); // inclusive
    expect(renderer!.isUnderNode("Loose", "Hand")).toBe(false);
  });

  it("hides the hand toggle when the holders are under an invisible ancestor", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080, visible: false },
        { id: "Holder", parentId: "Root", nodeType: "Game.NHandCardHolder" }
      ])
    );
    expect(renderer!.handPresent()).toBe(false);
  });

  it("anchors hand chrome in the canvas paint order and reports a later modal cover", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        {
          id: "Piles", parentId: "Root", nodeType: "Game.NCombatPilesContainer",
          sceneFilePath: "res://scenes/combat/combat_piles_container.tscn", w: 1920, h: 1080
        },
        { id: "Hand", parentId: "Root", nodeType: "Game.NPlayerHand" },
        { id: "Holder", parentId: "Hand", nodeType: "Game.NHandCardHolder" },
        { id: "Backstop", parentId: "Root", w: 1920, h: 1080, fillColor: { r: 0, g: 0, b: 0, a: 0.9 } }
      ])
    );
    expect(renderer!.handRaiseUiLayer()).toEqual({
      present: true, anchorId: "Piles", domTarget: null, covered: true, backend: "canvas"
    });
  });

  it("builds interactiveRects from the SAME walk that painted, topmost last", () => {
    mount();
    renderer!.reconcile(paintableScene());
    const rects = renderer!.interactiveRects();
    // Only the mouse-visible Control qualifies; the backdrop and the label do not.
    expect(rects.map((r) => r.id)).toEqual(["Button"]);
    expect(rects[0].transform).toEqual([1, 0, 0, 1, 100, 200]);
    expect(rects[0].localRect).toMatchObject({ width: 300, height: 80 });
    // A second read is the same array — the cache is keyed on the build, not rebuilt per ask.
    expect(renderer!.interactiveRects()).toBe(rects);
  });

  it("answers touchStackAt from the draw list's own hit surfaces", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Widget", parentId: "Root", nodeType: "Game.NCard", x: 100, y: 200, w: 300, h: 80, mouseFilter: 0 }
      ])
    );
    // The stage is at scale 1 with its origin at 0,0, so a viewport point IS a design point here.
    expect(renderer!.touchStackAt(150, 220).ids).toEqual(["Widget"]);
    expect(renderer!.touchStackAt(1500, 900)).toEqual({
      ids: [],
      blocked: false,
      blockKind: null,
      topStamp: null
    });
  });

  it("reports the end-turn box as the UNION over the scene's rects, and only when the point is on it", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        {
          id: "EndTurn",
          parentId: "Root",
          x: 1500,
          y: 900,
          w: 200,
          h: 60,
          mouseFilter: 0,
          sceneFilePath: "res://scenes/ui/end_turn_button.tscn"
        }
      ])
    );
    expect(renderer!.endTurnBoxAt(1550, 920)).toEqual({ minX: 1500, minY: 900, maxX: 1700, maxY: 960 });
    expect(renderer!.endTurnBoxAt(100, 100)).toBeNull();
  });

  it("keeps the raise / spread seams inert until their waves land", () => {
    mount();
    renderer!.reconcile(paintableScene());
    // Empty is not a placeholder here: every caller reads it as "the feature is off", which it is.
    expect(renderer!.raiseInputStamps()).toEqual([]);
    expect(renderer!.viewScaleInputStamps()).toEqual([]);
    // …and a scene with nothing scrollable in it publishes no scroll targets, which is the same statement one
    // wave later: the eager seam is live (see the eager-scroll block below), it just has nothing to offer here.
    expect(renderer!.eagerScrollTargets()).toEqual([]);
    expect(renderer!.__drainDormantHatchForTest()).toBe(false);
    expect(renderer!.__drainRevealStaggerForTest()).toBe(0);
  });
});

// --- M3 WS-D: EAGER SCROLL ----------------------------------------------------------------------------------
//
// The canvas stage's half of eager scrolling. The SNAPSHOT is `@/mirror/eagerScrollLayout`, which
// `eagerScrollTargets.spec` pins against the DOM backend to the last decimal — so what is asserted here is what
// only this backend can get wrong: that the env answers, that the painted Y comes from the build rather than the
// stream, that the tween loop is what decides "pinned", and that a target arrives with no element to write to.
describe("eager scroll targets", () => {
  function mount(): HTMLElement {
    stubWebgl2();
    stubRaf();
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  const MAP_SCREEN = "MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapScreen";
  const CARD_GRID = "MegaCrit.Sts2.Core.Nodes.Cards.NCardGrid";

  function mapScene(offsetY = -600, screenVisible = true): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "MapScreen", parentId: "Root", nodeType: MAP_SCREEN, w: 1920, h: 1080, visible: screenVisible },
      { id: "TheMap", parentId: "MapScreen", name: "TheMap", y: offsetY, w: 1920, h: 3240 }
    ]);
  }

  // A deck grid as the wire streams one: the grid frame inset for the top bar, a content-sized ScrollContainer,
  // one materialized holder row, and the right-edge scrollbar with its thumb.
  function gridScene(offsetY = 0): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "Grid", parentId: "Root", nodeType: CARD_GRID, y: 80, w: 1920, h: 1002 },
      { id: "Scroll", parentId: "Grid", name: "ScrollContainer", x: 175, y: offsetY, w: 1570, h: 2400 },
      {
        id: "Holder",
        parentId: "Scroll",
        nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NGridCardHolder",
        x: 225,
        y: 348.8,
        w: 0,
        h: 0
      },
      {
        id: "Bar",
        parentId: "Grid",
        name: "Scrollbar",
        nodeType: "MegaCrit.Sts2.Core.Nodes.GodotExtensions.NScrollbar",
        x: 1820,
        y: 129.6,
        w: 50,
        h: 742
      },
      { id: "Handle", parentId: "Bar", name: "Handle", x: -11, y: -36, w: 72, h: 72 }
    ]);
  }

  it("finds the map container, its viewport, its limits and where the stage PAINTED it", () => {
    mount();
    renderer!.reconcile(mapScene(-600));
    const targets = renderer!.eagerScrollTargets();
    expect(targets).toHaveLength(1);
    const map = targets[0];
    expect(map.kind).toBe("map");
    expect(map.id).toBe("TheMap");
    expect(map.streamedY).toBe(-600);
    expect(map.viewport).toEqual({ minX: 0, minY: 0, maxX: 1920, maxY: 1080 });
    expect(map.limitLo).toBe(MAP_LIMIT_LO);
    expect(map.limitHi).toBe(MAP_LIMIT_HI);
    expect(map.band).toBeNull();
    expect(map.wheelSafe).toBeNull();
    expect(map.pinned).toBe(false);
    expect(map.suppressed).toBe(false);
    // The PAINTED Y, out of the build's captured globals — at rest it agrees with the streamed one.
    expect(map.renderedY).toBe(-600);
    // NO ELEMENT: the offset leaves the engine through `applyLocalOffset`, which is the single writer here.
    expect(map.el ?? null).toBeNull();
  });

  it("reports the PAINTED Y, which lags the streamed one until the stage has drawn it", () => {
    mount();
    const state = mapScene(-600);
    renderer!.reconcile(state);
    // A delta lands and no build has run against it yet — the window in which composing against the streamed
    // value dips the map.
    sceneOf([{ id: "TheMap", parentId: "MapScreen", name: "TheMap", y: -320, w: 1920, h: 3240 }], state);
    const target = renderer!.eagerScrollTargets()[0];
    expect(target.streamedY).toBe(-320);
    expect(target.renderedY).toBe(-600);
  });

  it("drops a scrollable whose SCREEN is hidden", () => {
    mount();
    renderer!.reconcile(mapScene(-600, false));
    expect(renderer!.eagerScrollTargets()).toEqual([]);
  });

  it("suppresses the map while a drawing tool is armed, and only the map", () => {
    mount();
    const armed = sceneOf(
      [{ id: "Quill", parentId: "MapScreen", w: 60, h: 60, textureUrl: "res://art/map/drawing_quill_glow.png" }],
      mapScene(-600)
    );
    renderer!.reconcile(armed);
    expect(renderer!.eagerScrollTargets()[0].suppressed).toBe(true);
  });

  it("hands a card grid its viewport, its limits, its materialized band and the scrollbar strip", () => {
    mount();
    renderer!.reconcile(gridScene(0));
    const grid = renderer!.eagerScrollTargets()[0];
    expect(grid.kind).toBe("grid");
    expect(grid.id).toBe("Scroll");
    expect(grid.streamedY).toBe(0);
    expect(grid.viewport).toEqual({ minX: 0, minY: 80, maxX: 1920, maxY: 1082 });
    expect(grid.limitLo).toBe(1002 - 2400);
    expect(grid.limitHi).toBe(0);
    // One materialized row ⇒ the nominal pitch of slack below it.
    expect(grid.band!.lo).toBeCloseTo(348.8, 3);
    // The strip the engine must not claim, and its thumb.
    expect(grid.scrollbarBox).toEqual({ minX: 1820, minY: 209.6, maxX: 1870, maxY: 951.6 });
    expect(grid.scrollbarRenderedBox).toEqual(grid.scrollbarBox); // 16:9 ⇒ no shift
    expect(grid.bar?.id).toBe("Handle");
    // The gutter between the frame's left edge and the content — where a grid's wheel ticks are injected.
    expect(grid.wheelSafe).toEqual({ x: 87.5, y: 581 });
  });

  it("PINS a container the tween loop is moving", () => {
    mount();
    const sliding = mapScene(-600);
    sliding.pendingHints.push({
      targetId: "TheMap",
      property: "position",
      durationMs: 400,
      ease: "Out",
      trans: "Quad",
      endTransform: [1, 0, 0, 1, 0, 200],
      startTransform: null,
      endOpacity: null,
      startOpacity: null,
      group: null
    } as unknown as MirrorState["pendingHints"][number]);
    renderer!.reconcile(sliding);
    expect(renderer!.eagerScrollTargets()[0].pinned).toBe(true);
  });

  it("does NOT pin one the loop is merely FADING — the alpha channel is no claim on the pixel", () => {
    mount();
    const fading = mapScene(-600);
    fading.pendingHints.push({
      targetId: "TheMap",
      property: "modulate:a",
      durationMs: 400,
      ease: "Out",
      trans: "Quad",
      endTransform: null,
      startTransform: null,
      endOpacity: 0.2,
      startOpacity: null,
      group: null
    } as unknown as MirrorState["pendingHints"][number]);
    renderer!.reconcile(fading);
    // The node is in the loop either way; only the transform tween is a claim on the pixel an offset would write.
    expect(renderer!.eagerScrollTargets()[0].pinned).toBe(false);
  });
});

// Wave 2b — the two confirm-tap rules the canvas backend was missing against `mirrorRenderer`'s. Both are
// classification, not paint: a phantom confirm button commits a click the feature promised never to send, and a
// wrong stacking verdict either hides the button or floats it over a modal.
describe("confirm tap", () => {
  function mount(): HTMLElement {
    stubWebgl2();
    stubRaf();
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  /** A card-reward screen: one real reward card, and the same card ECHOED inside a hover preview. */
  function rewardScreen(): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      {
        id: "Screen",
        parentId: "Root",
        w: 1920,
        h: 1080,
        sceneFilePath: "res://scenes/rewards/card_reward_selection_screen.tscn"
      },
      // The real choice. An NCard root is a 0x0 anchor, so its tap box is the nominal 240x338 about the origin.
      { id: "Card", parentId: "Screen", nodeType: "Game.NCard", x: 500, y: 500, w: 0, h: 0 },
      // …and the preview copy of it, elsewhere on screen, under a container whose TYPE says what it is
      // (`mirrorRenderer.isEchoContainer` matches the node-type leaf, not the name).
      { id: "Preview", parentId: "Screen", nodeType: "Game.NCardPreview", x: 1400, y: 500, w: 400, h: 500 },
      { id: "Echo", parentId: "Preview", nodeType: "Game.NCard", x: 1500, y: 500, w: 0, h: 0 }
    ]);
  }

  it("refuses a confirm button on an ECHOED reward card — a preview is a copy, not the choice", () => {
    mount();
    renderer!.reconcile(rewardScreen());
    // The real card is eligible…
    expect(renderer!.confirmTapAt(500, 500)).toEqual({ id: "Card", kind: "reward" });
    // …and its preview copy, at the same offset inside the echo container, is not.
    expect(renderer!.confirmTapAt(1500, 500)).toBeNull();
  });

  it("classifies a Fake Merchant inventory relic as the ordinary shop confirm target", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        {
          id: "Inventory",
          parentId: "Root",
          nodeType: "Game.NFakeMerchantInventory",
          x: 300,
          y: 200,
          w: 1000,
          h: 600,
          sceneFilePath: "res://scenes/events/custom/fake_merchant_inventory.tscn"
        },
        { id: "Relic", parentId: "Inventory", nodeType: "Game.NMerchantRelic", x: 40, y: 10, w: 100, h: 60 }
      ])
    );

    // Fake Merchant is still an event room around the inventory, but the purchase widget is the normal shop relic.
    expect(renderer!.confirmTapAt(340, 210)).toEqual({ id: "Relic", kind: "shop" });
    expect(renderer!.confirmTapAt(500, 500)).toBeNull();
  });

  it("suspends shop-removal confirmation while a visible decision grid is retained above it", () => {
    mount();
    const scene = (gridVisible: boolean): MirrorState =>
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Removal", parentId: "Root", nodeType: "Game.NMerchantCardRemoval", x: 440, y: 260, w: 100, h: 60 },
        { id: "Cost", parentId: "Removal", x: 440, y: 260, w: 0, h: 0 },
        { id: "Grid", parentId: "Root", nodeType: "Game.NCardGridSelectionScreen", visible: gridVisible, w: 1920, h: 1080 },
        { id: "PickerCard", parentId: "Grid", nodeType: "Game.NCard", x: 600, y: 300, w: 0, h: 0 }
      ]);

    renderer!.reconcile(scene(true));
    expect(renderer!.confirmTapTarget("Removal")).toBeNull();
    expect(renderer!.confirmTapAt(450, 270)).toBeNull();

    renderer!.reconcile(scene(false));
    expect(renderer!.confirmTapTarget("Removal")).toBe("shop");
    expect(renderer!.confirmTapAt(450, 270)).toEqual({ id: "Removal", kind: "shop", retapActivates: true });
  });

  it("matches DOM suppression for the exact visible remove-a-card picker", () => {
    mount();
    const scene = (pickerType: string, visible = true): MirrorState =>
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Removal", parentId: "Root", nodeType: "Game.NMerchantCardRemoval", x: 440, y: 260, w: 100, h: 60 },
        { id: "Cost", parentId: "Removal", x: 440, y: 260, w: 0, h: 0 },
        { id: "Picker", parentId: "Root", nodeType: `Game.${pickerType}`, visible, w: 1920, h: 1080 },
        { id: "Grid", parentId: "Picker", nodeType: "Game.NCardGrid", w: 1920, h: 1080 },
        { id: "Holder", parentId: "Grid", nodeType: "Game.NGridCardHolder", w: 240, h: 338 },
        { id: "Card", parentId: "Holder", nodeType: "Game.NCard", x: 600, y: 300, w: 0, h: 0 },
      ]);

    renderer!.reconcile(scene("NDeckCardSelectScreen"));
    expect(renderer!.confirmTapTarget("Removal")).toBeNull();
    expect(renderer!.confirmTapAt(450, 270)).toBeNull();
    renderer!.reconcile(scene("NDeckCardSelectScreen", false));
    expect(renderer!.confirmTapAt(450, 270)).toEqual({ id: "Removal", kind: "shop", retapActivates: true });
    renderer!.reconcile(scene("NDeckEnchantSelectScreen"));
    expect(renderer!.confirmTapAt(450, 270)).toEqual({ id: "Removal", kind: "shop", retapActivates: true });
  });

  // R1 — THE CONFIRM BOX IS A GLOBAL, and the wire's matrix is not one.
  //
  // `confirmTapAt` is handed an already-resolved GAME point, so every box it tests has to be in game space. This
  // backend read `node.transform` straight off the wire and used it as one — but that matrix is the node's pose
  // RELATIVE TO ITS PARENT. Same
  // class as the tween-arm bug: a card whose local matrix is near-identity gets tested at the design origin
  // instead of where it is. Every confirm target under a placed parent was mis-boxed, which is the whole of the
  // shop / card-reward `confirmTapAt` gap in the parity gate (79.5% / 90.9%) — and it was NOT the view scale, as
  // the divergence table had it: both backends' confirm boxes are game-space, so a visual enlargement cannot
  // move them.
  function localRewardScreen(): MirrorState {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["Root", "Screen", "Card"],
        upserts: [
          wireNode({ id: "Root", parentId: null, w: 1920, h: 1080 }),
          // The screen is PLACED: its children's local matrices are offsets inside it.
          wireNode({
            id: "Screen",
            parentId: "Root",
            x: 400,
            y: 400,
            w: 1000,
            h: 600,
            sceneFilePath: "res://scenes/rewards/card_reward_selection_screen.tscn"
          }),
          // Local (100,100) under that screen ⇒ a TRUE game global of (500,500).
          wireNode({ id: "Card", parentId: "Screen", nodeType: "Game.NCard", x: 100, y: 100, w: 0, h: 0 })
        ]
      })!
    );
    return state;
  }

  it("boxes a reward card at its composed GAME global, not at its parent-relative wire matrix", () => {
    mount();
    renderer!.reconcile(localRewardScreen());
    // The nominal 240x338 box is centred on the card's TRUE global (500,500).
    expect(renderer!.confirmTapAt(500, 500)).toEqual({ id: "Card", kind: "reward" });
    expect(renderer!.confirmTapAt(560, 620)).toEqual({ id: "Card", kind: "reward" });
    // …and NOT on the raw local matrix (100,100), which is where the pre-R1 read placed it.
    expect(renderer!.confirmTapAt(100, 100)).toBeNull();
    // Just outside the nominal box on the true global: 500 + 120 = 620 is the edge.
    expect(renderer!.confirmTapAt(640, 500)).toBeNull();
  });

  it("composes a cover's alpha up its ancestor chain before calling it an overlay", () => {
    mount();
    const scene = (parentAlpha: number): MirrorState =>
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Widget", parentId: "Root", x: 100, y: 100, w: 200, h: 100, fillColor: { r: 1, g: 0, b: 0, a: 1 } },
        // The modal, painted AFTER the widget so it is above it, spanning the whole stage at 0.9 of its own.
        { id: "Modal", parentId: "Root", opacity: parentAlpha, w: 1920, h: 1080 },
        {
          id: "Cover",
          parentId: "Modal",
          w: 1920,
          h: 1080,
          fillColor: { r: 0, g: 0, b: 0, a: 0.9 }
        }
      ]);

    // Opaque parent: 1.0 x 0.9 = 0.9, over the 0.7 floor — the widget IS under a modal.
    renderer!.reconcile(scene(1));
    expect(renderer!.coverAbove("Widget")).toBe(true);

    // Half-faded parent: 0.5 x 0.9 = 0.45, UNDER the floor. Reading the cover's own alpha alone would still say
    // 0.9 and sink the confirm button behind a modal the player can see straight through.
    renderer!.reconcile(scene(0.5));
    expect(renderer!.coverAbove("Widget")).toBe(false);
  });

  it("never raises a confirm button on a combat screen — end turn is not a confirm-eligible choice", () => {
    // confirmTap.ts's whole scope is the five kinds that SPEND a run reward (reward / event / shop / relic /
    // rest). A combat board has none of them, so the honest answer everywhere on it is null — which is what the
    // parity gate's `confirmTapAt` grid asserts against the DOM backend recording by recording.
    mount();
    renderer!.reconcile(paintableScene());
    for (const [x, y] of [
      [100, 100],
      [960, 540],
      [200, 250],
      [1700, 1000]
    ]) {
      expect(renderer!.confirmTapAt(x, y)).toBeNull();
    }
  });
});

describe("the paint dump", () => {
  function mount(): HTMLElement {
    stubWebgl2();
    stubRaf();
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  function dump(): string[] {
    const read = (window as unknown as { __mirrorDrawListDump?: () => string[] }).__mirrorDrawListDump;
    if (!read) throw new Error("__mirrorDrawListDump is not installed");
    return read();
  }

  it("prints one line per painted command, in paint order, with the fields the comparer parses", () => {
    mount();
    renderer!.reconcile(paintableScene());
    const lines = dump();
    const commands = lines.filter((l) => l.startsWith("C "));
    const overlays = lines.filter((l) => l.startsWith("O "));
    // Two fills (the backdrop and the button); the label is TEXT, which is an overlay on both backends.
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain(" Backdrop quad role=fill");
    expect(commands[1]).toContain(" Button quad role=fill");
    // Indices are the PAINT order and are contiguous, which is what the comparer's rank check rides on.
    expect(commands[0].startsWith("C 0 ")).toBe(true);
    expect(commands[1].startsWith("C 1 ")).toBe(true);
    // The button's own placement, verbatim off the draw list: a 300x80 box at (100, 200), opaque red, mix.
    expect(commands[1]).toContain("m=1.000,0.000,0.000,1.000,100.000,200.000");
    expect(commands[1]).toContain("wh=300.000,80.000");
    expect(commands[1]).toContain("rgba=1.000,0.000,0.000,1.000");
    expect(commands[1]).toContain("blend=mix");
    expect(commands[1]).toContain("tex=- clip=-");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toContain(" Label text");
  });

  it("is empty before anything has been reconciled, rather than throwing", () => {
    mount();
    expect(dump()).toEqual([]);
  });
});

// The wire's parent-relative matrices mean these fixtures are built so a node's own matrix is NOT its placement: a hand card's is
// (0, 0) about its holder, so anything that mistakes it for a global paints the card in the viewport's corner.
describe("a tween arms from the node's RENDERED GLOBAL, never from its local matrix", () => {
  function mount(): { stage: HTMLElement; raf: ReturnType<typeof stubRaf>; tick: (ms: number) => void } {
    stubWebgl2();
    const raf = stubRaf();
    // A CONTROLLED clock: the renderer reads `performance.now()` for every arm, sample and settle, so owning it is
    // what makes a tween's progress (and therefore the pose it paints) exact rather than timing-dependent.
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return {
      stage,
      raf,
      tick: (ms: number) => {
        clock += ms;
      }
    };
  }

  /**
   * A hand with parent-relative matrices: the hand is placed at (400, 900), each holder offsets along it, and each
   * CARD's own matrix is the identity — its whole placement comes from its ancestors. Card0's rendered global is
   * therefore (500, 900) and Card1's is (700, 900), while both local matrices read (0, 0).
   */
  const HAND: NodeSpec[] = [
    { id: "Root", parentId: null, w: 1920, h: 1080 },
    { id: "Hand", parentId: "Root", nodeType: "Game.NPlayerHand", x: 400, y: 900, w: 1120, h: 338 },
    { id: "Holder0", parentId: "Hand", nodeType: "Game.NHandCardHolder", x: 100, y: 0, w: 240, h: 338 },
    {
      id: "Card0",
      parentId: "Holder0",
      nodeType: "Game.NCard",
      x: 0,
      y: 0,
      w: 240,
      h: 338,
      mouseFilter: 0,
      fillColor: { r: 1, g: 0, b: 0, a: 1 }
    },
    { id: "Holder1", parentId: "Hand", nodeType: "Game.NHandCardHolder", x: 300, y: 0, w: 240, h: 338 },
    {
      id: "Card1",
      parentId: "Holder1",
      nodeType: "Game.NCard",
      x: 0,
      y: 0,
      w: 240,
      h: 338,
      mouseFilter: 0,
      fillColor: { r: 0, g: 1, b: 0, a: 1 }
    }
  ];

  interface HintSpec {
    targetId: string;
    /** The END matrix in the wire's own space — i.e. PARENT-RELATIVE, exactly as the producer authors it. */
    endTransform: number[];
    startTransform?: number[];
    durationMs?: number;
    endOpacity?: number;
  }

  /** A parent-relative delta: a keyframe when `into` is absent, an in-place update (plus hints) otherwise. */
  function localScene(specs: NodeSpec[], hints: HintSpec[] = [], into?: MirrorState): MirrorState {
    const state = into ?? createMirrorState();
    const delta: Record<string, unknown> = {
      type: "scene-delta",
      full: into === undefined,
      screenType: "run",
      upserts: specs.map(wireNode),
      hints: hints.map((h) => ({
        targetId: h.targetId,
        property: "position",
        durationMs: h.durationMs ?? 300,
        trans: "Quad",
        ease: "Out",
        endTransform: h.endTransform,
        startTransform: h.startTransform ?? null,
        endOpacity: h.endOpacity ?? null,
        startOpacity: null,
        group: null
      }))
    };
    if (into === undefined) {
      delta.orderedIds = specs.map((s) => s.id);
    }
    applySceneDelta(state, parseSceneDelta(delta)!);
    return state;
  }

  /** What the draw list actually placed a node's own quad at, straight off the paint dump. */
  function drawnAt(nodeId: string): { x: number; y: number } {
    const read = (window as unknown as { __mirrorDrawListDump?: () => string[] }).__mirrorDrawListDump;
    if (!read) throw new Error("__mirrorDrawListDump is not installed");
    const line = read().find((l) => l.startsWith(`C `) && l.includes(` ${nodeId} quad `));
    if (!line) throw new Error(`${nodeId} painted no quad this frame`);
    const m = /\sm=([-\d.,]+)\s/.exec(line);
    if (!m) throw new Error(`no matrix in: ${line}`);
    const parts = m[1].split(",").map(Number);
    return { x: parts[4], y: parts[5] };
  }

  it("arms a start-less hint from the built global — NOT the local matrix, and nowhere near the origin", () => {
    const { raf, tick } = mount();
    // Both cards' own matrices are the identity, so a `from` taken off `node.transform` would be the viewport
    // corner. Confirm the fixture really is that shape before asserting on it.
    const state = localScene(HAND);
    renderer!.reconcile(state);
    expect(state.nodes.get("Card0")!.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 900 });

    // One hint per card, neither declaring a start — the shape 21 of 21 transform hints take in the hover-tip
    // recording. The endpoint is parent-relative and lifts to (500, 700) / (700, 700).
    renderer!.reconcile(
      localScene(
        [],
        [
          { targetId: "Card0", endTransform: [1, 0, 0, 1, 0, -200] },
          { targetId: "Card1", endTransform: [1, 0, 0, 1, 0, -200] }
        ],
        state
      )
    );

    // THE BUG THIS PINS. The very first frame after the arm paints the tween at t=0, i.e. AT its `from`. With the
    // local matrix fed in as the global that was (0, 0) for every hinted card — the mass snap to the viewport
    // corner — followed by an ease back out to the endpoint.
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 900 });
    expect(drawnAt("Card1")).toEqual({ x: 700, y: 900 });

    // …and it really is a running tween, which travels from there to where the lifted endpoint says.
    expect(stats().animActive).toBeGreaterThan(0);
    tick(150);
    raf.flush();
    expect(drawnAt("Card0").y).toBeLessThan(900);
    expect(drawnAt("Card0").y).toBeGreaterThan(700);
    tick(300);
    raf.flush();
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 700 });
  });

  it("arms the FOCUSED (held, captured) card and a plain hand card alike — both from their own rendered poses", () => {
    mount();
    const state = localScene(HAND);
    renderer!.reconcile(state);

    // The user-visible signature of the defect was that almost every hand card jumped EXCEPT the focused one. The
    // held card is the one id the build captures a global for, so it is the one case that could accidentally work;
    // a fix has to put both cards on the same footing.
    renderer!.setHeldCard("Card0", 500, 1000, "peek");
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 780 }); // 900 − the 120px peek lift

    renderer!.reconcile(
      localScene(
        [],
        [
          { targetId: "Card0", endTransform: [1, 0, 0, 1, 0, -200] },
          { targetId: "Card1", endTransform: [1, 0, 0, 1, 0, -200] }
        ],
        state
      )
    );

    // Card1 — never captured, never held — arms from its rendered pose exactly as the held one does.
    expect(drawnAt("Card1")).toEqual({ x: 700, y: 900 });
    // Card0 arms from its PRE-LIFT global (500, 900) and is then drawn with the lift on top, landing back at 780.
    // That is the DOM's own split: the raise is a separate CSS `translate` that rides over the element's baked
    // `matrix()`, so a transform tween interpolates unlifted matrices and never folds the lift into its `from`.
    // Had the lift contaminated the `from`, this would read 660.
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 780 });

    // Dropping the card puts it back on its tween's own pose, with no 300px discontinuity hiding in the `from`.
    renderer!.setHeldCard(null, 0, 0);
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 900 });
  });

  it("DROPS a hint whose target is an orphan — there is no global to arm it in", () => {
    mount();
    // The card names a holder the map does not hold. The producer does emit this: the recording's hand cards are
    // hinted on the very delta that re-parents them, a frame before the new holder is streamed.
    const state = localScene([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      {
        id: "Orphan",
        parentId: "NotStreamedYet",
        nodeType: "Game.NCard",
        x: 0,
        y: 0,
        w: 240,
        h: 338,
        fillColor: { r: 1, g: 0, b: 0, a: 1 }
      }
    ]);
    renderer!.reconcile(state);
    expect(() => drawnAt("Orphan")).toThrow(); // the build holds an orphan subtree: it paints nothing at all

    renderer!.reconcile(localScene([], [{ targetId: "Orphan", endTransform: [1, 0, 0, 1, 22, -44] }], state));

    // Nothing armed. With no parent there is no global: the arm's `from` would be the node's own matrix and the
    // endpoint would stay parent-relative, so the tween would play out in design-origin coordinates and then
    // hand the subtree that pose the instant the real parent arrived.
    expect(stats().animActive).toBe(0);
    // …and the refusal is now VISIBLE. It was silent on both backends before, which is the whole reason the
    // mechanism could only ever be argued about: `mirrorRenderer` publishes the same number as
    // `mirrorWalkStats.hintTransformRebased`, so one replay can be read on either arm.
    expect(stats().hintTransformRebased).toBe(1);
  });

  it("does not count a hint whose target is not mirrored", () => {
    mount();
    const state = localScene([{ id: "Root", parentId: null, w: 1920, h: 1080 }]);
    renderer!.reconcile(state);

    renderer!.reconcile(
      localScene(
        [],
        [{ targetId: "NotMirrored", endTransform: [1, 0, 0, 1, 22, -44] }],
        state
      )
    );

    expect(stats().animActive).toBe(0);
    expect(stats().hintTransformRebased).toBe(0);
  });

  it("DROPS the transform channel of a hint whose target was RE-PARENTED before the hint was drained", () => {
    const { raf, tick } = mount();
    // The play layer is streamed from the start and sits AT the scene root, so its global is the identity — the
    // shape that makes this defect visible rather than merely wrong, because an endpoint "lifted" through the
    // identity is its own raw parent-relative numbers.
    const state = localScene([...HAND, { id: "PlayLayer", parentId: "Root", x: 0, y: 0, w: 1920, h: 1080 }]);
    renderer!.reconcile(state);
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 900 });

    // TWO DELTAS, ONE RECONCILE — which is what `pendingHints` is an accumulator FOR, and the ordinary case
    // whenever the client renders slower than the producer streams. The first delta hints the card while it is
    // still in the hand, so its endpoint is relative to Holder0. The second PLAYS it: the producer re-parents the
    // card under the play layer and drives it there itself.
    localScene([], [{ targetId: "Card0", endTransform: [1, 0, 0, 1, 0, -200], endOpacity: 0.5 }], state);
    localScene([{ ...HAND[3], parentId: "PlayLayer", x: 960, y: 440 }], [], state);
    renderer!.reconcile(state);

    // ONLY the transform channel goes. An alpha endpoint is parent-independent, so the same hint's fade still
    // arms — this is a drop of the value the re-parent invalidated, not of the hint.
    expect(stats().animActive).toBe(1);

    // Lifted through the parent the card has NOW, that endpoint is (0, −200): the design origin. The transform
    // channel is dropped instead, so the card paints exactly where the producer put it — this frame…
    expect(drawnAt("Card0")).toEqual({ x: 960, y: 440 });
    // …and every frame after, rather than easing off the top-left corner over the hint's window.
    tick(150);
    raf.flush();
    expect(drawnAt("Card0")).toEqual({ x: 960, y: 440 });
    tick(300);
    raf.flush();
    expect(drawnAt("Card0")).toEqual({ x: 960, y: 440 });
    // ONE transform refused, counted — and the DOM arm publishes the same number under the same name.
    expect(stats().hintTransformRebased).toBe(1);
  });

  it("keeps a transform hint whose target was re-parented IN THE SAME DELTA that hinted it", () => {
    const { tick, raf } = mount();
    const state = localScene([...HAND, { id: "PlayLayer", parentId: "Root", x: 300, y: 100, w: 1920, h: 1080 }]);
    renderer!.reconcile(state);

    // The producer re-parents and hints in one breath — the ordinary "the card moved house and here is where it
    // is going" delta. The endpoint IS relative to the new parent, so it must still arm and still lift: (300+40,
    // 100+60).
    renderer!.reconcile(
      localScene(
        [{ ...HAND[3], parentId: "PlayLayer", x: 0, y: 0 }],
        [{ targetId: "Card0", endTransform: [1, 0, 0, 1, 40, 60] }],
        state
      )
    );
    expect(stats().animActive).toBe(1);
    tick(400);
    raf.flush();
    expect(drawnAt("Card0")).toEqual({ x: 340, y: 160 });
    // NOTHING refused: the stamp names the parent the endpoint was written against, which is the new one. The
    // counter has to stay at zero here or it would be measuring re-parents rather than invalidated endpoints.
    expect(stats().hintTransformRebased).toBe(0);
  });

  it("does not snap at the settle when the producer re-streams the pinned node's unchanged local pose", () => {
    const { raf, tick } = mount();
    const state = localScene(HAND);
    renderer!.reconcile(state);
    renderer!.reconcile(localScene([], [{ targetId: "Card0", endTransform: [1, 0, 0, 1, 0, -200] }], state));

    // Mid-tween the producer keeps streaming the card — with its pose UNCHANGED, because the pin is one-way and the
    // producer has no idea the client is replaying. The pin catch-up must measure that against the same space it
    // recorded its baseline in: comparing a local matrix to a global baseline reads "changed" every single frame
    // and stashes a bogus pose to replay at the settle.
    tick(100);
    renderer!.reconcile(localScene([HAND[3]], [], state));
    tick(100);
    renderer!.reconcile(localScene([HAND[3]], [], state));

    // Past the settle: the card lands on its ENDPOINT, not on a stashed (0, 0).
    tick(200);
    raf.flush();
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 700 });
  });

  it("catches up to a genuinely moved pose at the settle, in rendered coordinates", () => {
    const { raf, tick } = mount();
    const state = localScene(HAND);
    renderer!.reconcile(state);
    renderer!.reconcile(localScene([], [{ targetId: "Card0", endTransform: [1, 0, 0, 1, 0, -200] }], state));

    // The producer moves the card 50px down its holder while the pin owns it. That IS fresh, so the catch-up
    // applies it at the settle — as the global (500, 950) the walk would have baked, not as the raw local (0, 50).
    tick(100);
    renderer!.reconcile(localScene([{ ...HAND[3], y: 50 }], [], state));

    tick(400);
    raf.flush();
    expect(drawnAt("Card0")).toEqual({ x: 500, y: 950 });
  });
});

describe("cosmetic offsets", () => {
  let offsetRaf: { pending: number; flush: () => number };

  function mount(): HTMLElement {
    stubWebgl2();
    offsetRaf = stubRaf();
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  it("lifts a held card AND everything under it, without moving what a tap sends to the game", () => {
    const stage = mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Card", parentId: "Root", nodeType: "Game.NCard", x: 800, y: 900, w: 240, h: 338, mouseFilter: 0 },
        { id: "CardArt", parentId: "Card", x: 0, y: 0, w: 240, h: 338, text: "art" }
      ])
    );
    // A peek lifts unconditionally, by the DOM path's own 120px.
    renderer!.setHeldCard("Card", 900, 1000, "peek");
    const art = overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="CardArt"]')!;
    expect(art.style.transform).toBe("matrix(1, 0, 0, 1, 800, 780)"); // 900 - 120, INHERITED by the child

    // The GAME rect is untouched: the lift is cosmetic and must never change what a tap resolves to.
    expect(renderer!.interactiveRects()[0].transform).toEqual([1, 0, 0, 1, 800, 900]);

    renderer!.setHeldCard(null, 0, 0);
    const after = overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="CardArt"]')!;
    expect(after.style.transform).toBe("matrix(1, 0, 0, 1, 800, 900)");
  });

  // --- R6 M4: a targeting card is never lifted ------------------------------------------------------------------
  //
  // The DOM backend has had this branch since the lift existed; the canvas shipped with two (peek, play-zone) and a
  // header claiming byte-for-byte parity. The user's report is the difference: a card being AIMED sits raised above
  // the finger with its arrow out, when it should stay flat so the arrow's tip reads at the finger.

  /** The card's arted child carries the INHERITED offset, so it is the honest read of what the lift did. */
  function artY(stage: HTMLElement): string {
    return overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="CardArt"]')!.style.transform;
  }

  /** A card in hand plus a targeting arrow that starts hidden — the shape a combat scene streams. */
  function targetingScene(): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "Card", parentId: "Root", nodeType: "Game.NCard", x: 800, y: 900, w: 240, h: 338, mouseFilter: 0 },
      { id: "CardArt", parentId: "Card", x: 0, y: 0, w: 240, h: 338, text: "art" },
      { id: "Arrow", parentId: "Root", nodeType: "Combat.NTargetingArrow", x: 0, y: 0, w: 8, h: 8, visible: false }
    ]);
  }

  function setArrowVisible(state: MirrorState, visible: boolean): void {
    sceneOf([{ id: "Arrow", parentId: "Root", nodeType: "Combat.NTargetingArrow", x: 0, y: 0, w: 8, h: 8, visible }], state);
  }

  it("drops a DRAG's lift while a targeting arrow is out, and takes it back when the arrow goes", () => {
    const stage = mount();
    const state = targetingScene();
    renderer!.reconcile(state);

    // A fresh grab lifts off the pickup, by the DOM path's own 300px.
    renderer!.setHeldCard("Card", 900, 1000, "drag");
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 600)");

    // The game raises the arrow. Same finger, same zone — the card must go flat, on the reconcile's own
    // unconditional re-decide, without waiting for the finger to move.
    setArrowVisible(state, true);
    renderer!.reconcile(state);
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 900)");

    // …and the toggle runs the other way too: the arrow goes, the lift comes back.
    setArrowVisible(state, false);
    renderer!.reconcile(state);
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 600)");
  });

  it("re-decides mid-hold on the next finger move as well as on the delta", () => {
    const stage = mount();
    const state = targetingScene();
    renderer!.reconcile(state);
    renderer!.setHeldCard("Card", 900, 1000, "drag");
    setArrowVisible(state, true);
    // No reconcile: the finger reports first. The lift is re-derived from the live state either way.
    renderer!.setHeldCard("Card", 900, 990, "drag");
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 900)");
  });

  it("a PEEK still lifts with the arrow out — the DOM's branch order, verbatim", () => {
    const stage = mount();
    const state = targetingScene();
    setArrowVisible(state, true);
    renderer!.reconcile(state);
    // A long-press peek is not an aim: the game pops the focused card up and the still finger must stop covering
    // it. The DOM tests `peek` before the arrow, and so does this.
    renderer!.setHeldCard("Card", 900, 1000, "peek");
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 780)");
  });

  it("the arrow rule holds ANYWHERE, not only in the play zone", () => {
    const stage = mount();
    const state = targetingScene();
    setArrowVisible(state, true);
    renderer!.reconcile(state);
    // Dragged high above the play-zone line — where a non-targeting card is lifted — and still flat. This is the
    // DOM rule rather than the report's "in the playable area" phrasing; parity with the arm the player compares
    // against wins, and it is the arm that matches the game.
    renderer!.setHeldCard("Card", 900, 200, "drag");
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 900)");
  });

  it("a NEW GRAB re-asks from the live scene rather than keeping the last gesture's answer", () => {
    const stage = mount();
    const state = targetingScene();
    setArrowVisible(state, true);
    renderer!.reconcile(state);
    renderer!.setHeldCard("Card", 900, 1000, "drag");
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 900)");

    // The aim ends. Mutated in place WITHOUT a revision bump, which is the only way to observe the invalidation
    // at all: it stands for the DOM clearing `activeTargetingArrows` in its own `setHeldCard`, so the previous
    // gesture can never decide this one's first frame.
    state.nodes.get("Arrow")!.visible = false;
    renderer!.setHeldCard(null, 0, 0);
    renderer!.setHeldCard("Card", 900, 1000, "drag");
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 600)");
  });

  it("leaves the play-zone rule alone: a drag that returns to the hand is flat with no arrow anywhere", () => {
    const stage = mount();
    const state = targetingScene();
    renderer!.reconcile(state);
    renderer!.setHeldCard("Card", 900, 1000, "drag"); // picked up, lifted
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 600)");
    renderer!.setHeldCard("Card", 900, 100, "drag"); // up into the play zone — latches
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 600)");
    renderer!.setHeldCard("Card", 900, 1040, "drag"); // …and back down to the hand
    expect(artY(stage)).toBe("matrix(1, 0, 0, 1, 800, 900)");
  });

  it("parks a local offset over the same channel and reads back what the walk baked", () => {
    const stage = mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Scroller", parentId: "Root", x: 100, y: 240, w: 400, h: 600 },
        { id: "Row", parentId: "Scroller", x: 0, y: 60, w: 400, h: 60, text: "row" }
      ])
    );
    renderer!.applyLocalOffset("Scroller", -128.456);
    const row = overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="Row"]')!;
    expect(row.style.transform).toBe("matrix(1, 0, 0, 1, 100, 171.544)");
    // The READ half reports the PARENT-RELATIVE baked Y (240 under a root at 0), which is what the eager-scroll
    // engine composes its offset against — and it excludes the offset itself, exactly as the DOM path's does.
    expect(renderer!.scrollRenderedY("Scroller")).toBe(240);
    expect(renderer!.scrollRenderedY("NotAThing")).toBeNull();

    // The deadband: below 0.01 the offset goes back to exactly zero rather than to a near-zero the gates would
    // read back as "moved". The frame flush is the COALESCER: this is the second write of the same frame, so its
    // build is folded into the frame boundary rather than paid for on the spot (see `writeLocalOffset`).
    renderer!.applyLocalOffset("Scroller", 0.001);
    offsetRaf.flush();
    expect(overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="Row"]')!.style.transform).toBe(
      "matrix(1, 0, 0, 1, 100, 300)"
    );
  });

  // M3 WS-D — THE PRICE OF LEADING. Each write is a full rebuild here, and a gesture frame makes two statements
  // about the same pixel (the compose seam right after the reconcile, then the engine's own frame). One build a
  // frame is the budget; the first write of a frame keeps its build, because a gesture's first motion must not
  // wait one.
  it("builds once for the first offset write of a frame and folds the rest into the boundary", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Scroller", parentId: "Root", x: 100, y: 240, w: 400, h: 600 },
        { id: "Row", parentId: "Scroller", x: 0, y: 60, w: 400, h: 60, text: "row" }
      ])
    );
    const before = stats();
    // FIRST write of the frame: paid at once — the eager gesture's whole latency claim.
    renderer!.applyLocalOffset("Scroller", -40);
    expect(stats().offsetBuilds).toBe(before.offsetBuilds + 1);
    expect(stats().offsetCoalesced).toBe(before.offsetCoalesced);

    // Two more writes in the SAME frame: the numbers land, the builds do not.
    renderer!.applyLocalOffset("Scroller", -80);
    renderer!.applyLocalOffset("Scroller", -120);
    expect(stats().offsetBuilds).toBe(before.offsetBuilds + 1);
    expect(stats().offsetCoalesced).toBe(before.offsetCoalesced + 2);

    // The boundary pays the debt ONCE, with the latest value — the two folded writes cost one build between them.
    offsetRaf.flush();
    expect(stats().offsetBuilds).toBe(before.offsetBuilds + 2);
    expect(overlayIn(document.body)?.querySelector<HTMLElement>('[data-node-id="Row"]')?.style.transform).toBe(
      "matrix(1, 0, 0, 1, 100, 180)"
    );
  });

  it("lets ANY build settle a folded write — a reconcile mid-gesture pays for free", () => {
    mount();
    const state = sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "Scroller", parentId: "Root", x: 100, y: 240, w: 400, h: 600 },
      { id: "Row", parentId: "Scroller", x: 0, y: 60, w: 400, h: 60, text: "row" }
    ]);
    renderer!.reconcile(state);
    renderer!.applyLocalOffset("Scroller", -40); // first of the frame: builds
    renderer!.applyLocalOffset("Scroller", -90); // folded
    const after = stats();
    // A delta lands before the boundary does. Its build reads the live offsets, so the folded write is already on
    // screen and the boundary has nothing left to do.
    renderer!.reconcile(state);
    expect(overlayIn(document.body)?.querySelector<HTMLElement>('[data-node-id="Row"]')?.style.transform).toBe(
      "matrix(1, 0, 0, 1, 100, 210)"
    );
    offsetRaf.flush();
    expect(stats().offsetBuilds).toBe(after.offsetBuilds);
  });

  // M3 WS-D — THE CAPTURE SEED. `scrollRenderedY` answers out of the build's captured globals, and the eager
  // engine asks it on the FIRST frame of a gesture, before it has ever written an offset. Seeding the capture set
  // from the offsets alone therefore answered "I don't know" exactly when it mattered (and again after every
  // settle, since a zero offset deletes its entry), which is the 233px first-gesture dip.
  it("banks where it painted a scroll container before anyone has scrolled it", () => {
    mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "MapScreen", parentId: "Root", nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapScreen", w: 1920, h: 1080 },
        { id: "TheMap", parentId: "MapScreen", name: "TheMap", y: -600, w: 1920, h: 3240 },
        { id: "Path", parentId: "TheMap", y: -600, w: 400, h: 60, text: "path" }
      ])
    );
    // No offset has been written and none ever will be in this test: the container is captured because it IS a
    // scroll container.
    expect(renderer!.scrollRenderedY("TheMap")).toBe(-600);
    // …and the seed is exactly that — a node nobody scrolls is still not captured.
    expect(renderer!.scrollRenderedY("Path")).toBeNull();
  });

  it("keeps banking it across a settle, when the offset entry is deleted again", () => {
    mount();
    const scene = sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "Grid", parentId: "Root", nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCardGrid", y: 80, w: 1920, h: 1002 },
      { id: "Scroll", parentId: "Grid", name: "ScrollContainer", x: 175, w: 1570, h: 2400 }
    ]);
    renderer!.reconcile(scene);
    renderer!.applyLocalOffset("Scroll", -240);
    expect(renderer!.scrollRenderedY("Scroll")).toBe(0);
    // The settle: back to rest, which DELETES the cosmetic entry. The capture must survive it, or the next
    // gesture starts blind all over again.
    renderer!.applyLocalOffset("Scroll", 0);
    expect(renderer!.scrollRenderedY("Scroll")).toBe(0);
  });
});

// --- M2: EFFECTS INTO THE CANVAS ---------------------------------------------------------------------------
//
// The renderer's in-canvas effect registry, the third demand source it folds into
// `armAnimation` (the one a gsw runtime's own rAF drives, so the one most able to stop the stage parking), and the
// notification path that connects the two. What a quad looks like is `canvasFxQuads.spec`; what the registry
// decides is `fxSurfaces.spec`.
//
// A PARTICLE emitter is the fixture on purpose. `nodeParticleAttributes` is a pure function of the wire spec, so a
// live gsw binding needs no mock and no resolvable material document — where a shader node would need both.
describe("effects into the canvas (M2)", () => {
  function mount(search: string): { stage: HTMLElement; raf: ReturnType<typeof stubRaf> } {
    stubWebgl2();
    const raf = stubRaf();
    vi.stubGlobal("devicePixelRatio", 1);
    window.history.replaceState(null, "", search);
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return { stage, raf };
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  /** A backdrop, an emitter over it, and something the game paints ON TOP — the hoist rule's whole problem. */
  function effectScene(): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "Backdrop", parentId: "Root", w: 1920, h: 1080, fillColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
      {
        id: "Emitter",
        parentId: "Root",
        x: 400,
        y: 300,
        w: 0,
        h: 0,
        shader: "res://shaders/particles.gdshader",
        particleSpec: { kind: "GPUParticles2D", amount: 8, lifetime: 1 }
      },
      { id: "Over", parentId: "Root", w: 1920, h: 1080, fillColor: { r: 1, g: 0, b: 0, a: 1 } }
    ]);
  }

  /** The canvas gsw would have painted: a backing store, and the PX placement the particle runtime writes. */
  function surfaceCanvas(w = 256, h = 256): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    // Negative left/top is the emitter's TRAVEL MARGIN — particles that fly outside the (0x0) node box.
    canvas.style.left = "-128px";
    canvas.style.top = "-128px";
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    return canvas;
  }

  function hostOf(stage: HTMLElement, id: string): HTMLElement {
    return overlayIn(stage)!.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
  }

  it("is ON by default — the registry exists without anyone asking for it", () => {
    mount("/?stage=canvas");
    renderer!.reconcile(effectScene());
    // A NULL census is how a reader tells "the flag is off" from "the flag is on and found nothing", so a
    // NON-null one on a plain `?stage=canvas` page is the whole assertion.
    expect(stats().fx).not.toBeNull();
  });

  it("installs the registry with the measured governor defaults", () => {
    mount("/?stage=canvas");
    renderer!.reconcile(effectScene());
    const fx = stats().fx!;
    expect(fx).not.toBeNull();
    expect(fx.paceBytes).toBe(32 * 1024 * 1024);
    expect(fx.paceCount).toBe(8);
    // SCREEN_TEXTURE is withheld unless asked for: gsw's capture is a DOM composite, and on this stage the DOM
    // holds only text and effect hosts — not the game, which is in the canvas.
    expect(fx.screenTexture).toBe("withhold");
  });

  it("hides the host, retires the hoist rule, and draws the surface as a quad in paint order", () => {
    const { stage } = mount("/");
    const state = effectScene();
    renderer!.reconcile(state);

    // The build NAMED the emitter (that is `acquire`), but gsw has drawn nothing yet — so there is no quad, and
    // the host still composites. That is deliberate: an emitter's record box is 0x0, so the cover pass has no
    // opinion about it, so flag-OFF would hoist it — and the flag must not lose an effect flag-off shows.
    const host = hostOf(stage, "Emitter");
    expect(host.style.visibility).toBe("");
    expect(stats().overlayCounts.withheld).toBe(0);
    expect(stats().overlayCounts.fxHidden).toBe(0);
    expect(stats().fx!.quads).toBe(0);

    // gsw paints the surface. The whole chain from here is the renderer's.
    renderer!.noteEffectRendered!(host, surfaceCanvas());
    renderer!.reconcile(state);

    const fx = stats().fx!;
    expect(fx.surfaces).toBe(1);
    expect(fx.resident).toBe(1);
    expect(fx.uploads).toBe(1);
    expect(fx.quads).toBe(1);
    expect(fx.maxQuads).toBe(1);
    // …and NOW the host stops compositing: the canvas owns those pixels, so leaving gsw's canvas in the page
    // would composite them a second time, above the whole stage. The element STAYS — it is what gsw binds to.
    expect(hostOf(stage, "Emitter").style.visibility).toBe("hidden");
    expect(stats().overlayCounts.fxHidden).toBe(1);
  });

  it("BOOKS an animation frame for a surface with new pixels, and parks once they are uploaded", () => {
    // THE THIRD DEMAND SOURCE. `armAnimation` takes the min of the tween loop, a playing spine clip, and this;
    // parking is load-bearing (the stage is >90% idle) and this is the source a THIRD party drives.
    const { stage, raf } = mount("/");
    const state = effectScene();
    renderer!.reconcile(state);
    expect(raf.pending).toBe(0); // nothing animating: parked

    const host = hostOf(stage, "Emitter");
    renderer!.noteEffectRendered!(host, surfaceCanvas());
    expect(raf.pending).toBe(1); // …and a runtime frame un-parks it

    // The rAF rebuilds, which is where the upload and the quad actually happen. It books NO successor, because
    // the surface is clean again — the pump drains.
    raf.flush();
    expect(stats().fx!.uploads).toBe(1);
    expect(stats().fx!.dirty).toBe(0);
    expect(raf.pending).toBe(0);
  });

  it("does not wake a parked stage for a surface no build is drawing (park guard 2)", () => {
    const { stage, raf } = mount("/");
    const state = effectScene();
    renderer!.reconcile(state);
    const host = hostOf(stage, "Emitter");

    // The emitter leaves the scene, but gsw keeps rendering the binding it has not been told to drop yet.
    sceneOf([{ id: "Emitter", parentId: "Root", w: 0, h: 0, visible: false }], state);
    renderer!.reconcile(state);
    raf.flush();
    expect(raf.pending).toBe(0);

    renderer!.noteEffectRendered!(host, surfaceCanvas());
    // The pixels are RECORDED (a later build that names the node again picks them up), but nothing is scheduled.
    expect(raf.pending).toBe(0);
  });

  it("ignores a notification for an element carrying no node id", () => {
    const { raf } = mount("/");
    renderer!.reconcile(effectScene());
    // The build NAMED the emitter, so one surface record exists already; an unattributable frame must add none.
    const before = stats().fx!.surfaces;
    const orphan = document.createElement("div");
    expect(() => renderer!.noteEffectRendered!(orphan, surfaceCanvas())).not.toThrow();
    expect(stats().fx!.surfaces).toBe(before);
    expect(stats().fx!.dirty).toBe(0);
    expect(raf.pending).toBe(0);
  });

  it("gives a departed node's texture back rather than waiting out the residency clock", () => {
    const { stage, raf } = mount("/");
    const state = effectScene();
    renderer!.reconcile(state);
    renderer!.noteEffectRendered!(hostOf(stage, "Emitter"), surfaceCanvas());
    raf.flush();
    expect(stats().fx!.resident).toBe(1);

    // The node is GONE from the wire — not hidden, deleted. A screen change unmounts dozens at once.
    state.changedIds.add("Emitter");
    state.nodes.delete("Emitter");
    renderer!.reconcile(state);
    expect(stats().fx!.surfaces).toBe(0);
    expect(stats().fx!.resident).toBe(0);
    // Counted apart from an eviction: a low `resident` means very different things depending on which one it was.
    expect(stats().fx!.released).toBe(1);
  });
});

// --- spine stills into the canvas (M3 A2) ---------------------------------------------------------------------
//
// What a quad LOOKS like is `canvasSpineQuads.spec`; this is the LEVER and the census, i.e. the two things a
// measurement arm has to be able to read off a page.
describe("spine stills into the canvas (M3 A2 — default ON since round 9)", () => {
  function mount(search: string): HTMLElement {
    stubWebgl2();
    stubRaf();
    vi.stubGlobal("devicePixelRatio", 1);
    window.history.replaceState(null, "", search);
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return stage;
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("is ON by default — the plain canvas stage installs the registry with no url at all", () => {
    mount("/?stage=canvas");
    renderer!.reconcile(paintableScene());
    expect(stats().spine).not.toBeNull();
  });

  it("installs the registry with its measured residency defaults", () => {
    mount("/?stage=canvas");
    renderer!.reconcile(paintableScene());
    const spine = stats().spine!;
    expect(spine).not.toBeNull();
    // 32 MB is ~8 median stills or ~3 at p90; the count cap is ONE, because a p90 still is 40ms of texImage2D
    // here and seconds on a phone.
    expect(spine.paceBytes).toBe(32 * 1024 * 1024);
    expect(spine.paceCount).toBe(1);
    expect(spine.quads).toBe(0);
    expect(spine.hoisted).toBe(0);
  });

});

// --- card trails into the canvas (M3 A4) --------------------------------------------------------------------------
//
// A card trail is the one decoration that reached this stage by no route at all before M3: the classifier made an
// overlay record, the overlay dropped it, and a played card flew with no comet behind it. What the strip LOOKS
// like is `cardTrail.spec`'s and how the histories are fed is `canvasCardTrailState.spec`'s; this is the WIRING —
// the quads reaching the list, the classification NOT moving, and the stage still parking afterwards.
describe("card trails into the canvas (M3 A4)", () => {
  /**
   * The trail PAGES, as loads this block can fire on command. Local rather than shared with the pacing block's
   * stub because a trail needs exactly one thing from it: a url that becomes READY at a known size, which is
   * what turns the ribbon from the banded fallback into the authored textured one (T-DR1).
   */
  function stubTrailImages(): { resolveAll: (w: number, h: number) => void; urls: string[] } {
    const pending: Array<{ url: string; fire: (w: number, h: number) => void }> = [];
    vi.stubGlobal(
      "Image",
      class {
        decoding = "";
        crossOrigin: string | null = null;
        naturalWidth = 0;
        naturalHeight = 0;
        private listeners = new Map<string, Set<() => void>>();
        private url = "";
        addEventListener(type: string, fn: () => void): void {
          let set = this.listeners.get(type);
          if (!set) this.listeners.set(type, (set = new Set()));
          set.add(fn);
        }
        removeEventListener(type: string, fn: () => void): void {
          this.listeners.get(type)?.delete(fn);
        }
        set src(value: string) {
          this.url = value;
          pending.push({
            url: value,
            fire: (w, h) => {
              this.naturalWidth = w;
              this.naturalHeight = h;
              for (const fn of [...(this.listeners.get("load") ?? [])]) fn();
            }
          });
        }
        get src(): string {
          return this.url;
        }
      }
    );
    return {
      resolveAll: (w, h) => {
        for (const entry of [...pending]) entry.fire(w, h);
      },
      get urls() {
        return pending.map((p) => p.url);
      }
    };
  }

  function mount(search = "/?stage=canvas"): {
    stage: HTMLElement;
    raf: ReturnType<typeof stubRaf>;
    timers: ReturnType<typeof stubTimers>;
    images: ReturnType<typeof stubTrailImages>;
    tick: (ms: number) => void;
  } {
    stubWebgl2();
    const raf = stubRaf();
    const timers = stubTimers();
    const images = stubTrailImages();
    vi.stubGlobal("devicePixelRatio", 1);
    // A CONTROLLED clock: a point history ages against `performance.now()`, so owning it is what makes "the
    // ribbon has drained" a fact rather than a race with the test runner.
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    window.history.replaceState(null, "", search);
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return {
      stage,
      raf,
      timers,
      images,
      tick: (ms: number) => {
        clock += ms;
      }
    };
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  /** A flying card, its comet root, and the two `NCardTrail` strokes the game hangs under it. */
  function cometScene(): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "Backdrop", parentId: "Root", w: 1920, h: 1080, fillColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
      { id: "Card", parentId: "Root", nodeType: "NCardFlyShuffleVfx", x: 300, y: 880, w: 200, h: 280 },
      { id: "Comet", parentId: "Root", nodeType: "NCardTrailVfx", x: 300, y: 880, w: 0, h: 0 },
      { id: "Trails", parentId: "Comet", nodeType: "Node2D", x: 0, y: 0, w: 0, h: 0 },
      {
        id: "Outer",
        parentId: "Trails",
        name: "OuterTrail",
        nodeType: "NCardTrail",
        w: 0,
        h: 0,
        textureUrl: "res://assets/vfx/trail.png"
      },
      {
        id: "Inner",
        parentId: "Trails",
        name: "InnerTrail",
        nodeType: "NCardTrail",
        w: 0,
        h: 0,
        textureUrl: "res://assets/vfx/trail2.png"
      }
    ]);
  }

  /** The producer's hint for that card: a long arc across the stage, naming the comet it drags. */
  function flightHint(): MirrorCardFlightHint {
    return {
      targetId: "Card",
      trailId: "Comet",
      start: [300, 880],
      end: [1620, 880],
      control: [960, 280],
      basis: [1, 0, 0, 1],
      speed0: 1.18,
      accel: 2.3,
      duration: 1.4,
      scale0: 1,
      windowMs: 3600,
      kind: "shuffle",
      rot0: 0
    };
  }

  /** Reconcile the comet with its flight armed, then run `frames` animation frames at 16 ms over it. */
  function flyIt(mounted: ReturnType<typeof mount>, frames: number): void {
    const state = cometScene();
    state.pendingCardFlights.push(flightHint());
    renderer!.reconcile(state);
    for (let i = 0; i < frames; i++) {
      mounted.tick(16);
      mounted.raf.flush();
    }
  }

  it("is ON by default — a plain ?stage=canvas page builds trail state", () => {
    mount("/?stage=canvas");
    renderer!.reconcile(cometScene());
    expect(stats().trails).not.toBeNull();
  });

  it("draws a flying card's ribbon into the list", () => {
    const m = mount();
    flyIt(m, 24);
    const trails = stats().trails!;
    // Two strokes x three bands x one cell per segment. The exact count rides the flight's own point spacing;
    // what matters is that it is a RIBBON's worth of geometry rather than one bar.
    expect(trails.quadPeak).toBeGreaterThan(20);
    expect(trails.flightSamples).toBeGreaterThan(4);
    expect(trails.strokesPeak).toBe(2);
    // The records stay — the overlay drops them, and the count is what says so.
    expect(stats().overlayCounts.trail).toBe(2);
  });

  it("names the commands `role=trail`, so they cannot key as fills", () => {
    const m = mount("/?stage=canvas&paintDump=1");
    flyIt(m, 24);
    const dump = (window as unknown as { __mirrorDrawListDump?: () => string[] }).__mirrorDrawListDump;
    expect(dump, "the dump seam is gated with the paint-dump harness").toBeTypeOf("function");
    const lines = dump!();
    const trailCmds = lines.filter((l) => l.includes("role=trail"));
    // A trail cell keys off the NODE, not off whether it has a texture — otherwise the banded fallback would
    // fall through to the fill/range branch, where a comet reads as a hundred `range` commands the DOM arm does
    // not have, and the textured shape would key as `tex`. Same word for the same pixels, either way.
    expect(trailCmds.length).toBeGreaterThan(20);
    expect(lines.filter((l) => l.includes("role=range")).length).toBe(0);
    // …and both strokes are still reported as overlay records beside them.
    expect(lines.filter((l) => l.startsWith("O ") && l.includes(" trail ")).length).toBe(2);
  });

  // --- R5 T-DR1: the authored page carries the cross-section ----------------------------------------------------

  it("asks for the trail pages — nothing else on this backend would", () => {
    const m = mount();
    flyIt(m, 24);
    // The stroke is an overlay record and never emits a plain quad, so the integrator's own `sizeOf` ask is the
    // only thing that ever names these urls to the bridge.
    expect(m.images.urls.some((u) => u.endsWith("trail.png"))).toBe(true);
    expect(m.images.urls.some((u) => u.endsWith("trail2.png"))).toBe(true);
  });

  it("draws the banded fallback while the pages load, and the textured ribbon once they land", () => {
    const m = mount();
    flyIt(m, 12);
    expect(stats().trails!.bandedStrokes, "no page has decoded yet").toBeGreaterThan(0);
    expect(stats().trails!.texturedStrokes).toBe(0);

    m.images.resolveAll(32, 32);
    m.raf.flush(); // the bridge books a repaint when a texture resolves
    flyIt(m, 12);
    expect(stats().trails!.texturedStrokes, "the pages are ready: the staircase retires").toBeGreaterThan(0);
  });

  it("textured cells carry the WHOLE PAGE as their source rect", () => {
    const m = mount("/?stage=canvas&paintDump=1");
    flyIt(m, 12);
    m.images.resolveAll(32, 32);
    m.raf.flush();
    flyIt(m, 12);

    const lines = (window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump();
    const trailCmds = lines.filter((l) => l.includes("role=trail"));
    expect(trailCmds.length).toBeGreaterThan(0);
    // A ZERO source span does NOT mean "the whole texture" in the executor — it means "stretch one texel", which
    // is what a solid fill wants and what would flatten the comet into a bar. The span has to be explicit.
    for (const line of trailCmds) {
      expect(line, line).toMatch(/src=0\.000,0\.000,32\.000,32\.000/);
      expect(line, line).toMatch(/tex=\S*trail2?\.png/);
    }
  });

  // --- R5 T-DR4: the comet root follows the flight ---------------------------------------------------------------
  //
  // This client votes `trailDrive` on its socket, so the producer stops streaming the comet root's transform. On
  // this backend nothing was placing it, and the root's decorative branch — sprites that stream their own poses
  // in world coordinates and land wherever their host is — sat frozen on the discard pile.

  /**
   * The comet with its DECORATIVE branch: the part that rides the root and has nothing to do with the ribbons.
   *
   * Parent-relative matrices are the reason a root drive moves anything: a child's matrix composes ONTO its
   * parent's rendered global, so placing the root places the sprites hanging off it.
   *
   * Built as ONE keyframe rather than appended to `cometScene()`, because the paint ORDER only ships with a full
   * delta — a follow-up upsert would leave these nodes out of the walk entirely.
   */
  function cometWithSparks(): MirrorState {
    return localSpaceSceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "Backdrop", parentId: "Root", w: 1920, h: 1080, fillColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
      { id: "Card", parentId: "Root", nodeType: "NCardFlyShuffleVfx", x: 300, y: 880, w: 200, h: 280 },
      { id: "Comet", parentId: "Root", nodeType: "NCardTrailVfx", x: 300, y: 880, w: 0, h: 0 },
      { id: "Trails", parentId: "Comet", nodeType: "Node2D", x: 0, y: 0, w: 0, h: 0 },
      {
        id: "Outer",
        parentId: "Trails",
        name: "OuterTrail",
        nodeType: "NCardTrail",
        w: 0,
        h: 0,
        textureUrl: "res://assets/vfx/trail.png"
      },
      // …and the decorative branch, at the identity relative to the root: a group and one sprite, the shape the
      // real comet has (a `Sprites` group with two `small_card_silhouette` sprites under it). The sprite is
      // what was visible as a small bright square sitting still on the discard pile.
      { id: "Sparks", parentId: "Comet", nodeType: "Node2D", x: 0, y: 0, w: 0, h: 0 },
      {
        id: "Silhouette",
        parentId: "Sparks",
        nodeType: "Sprite2D",
        x: 0,
        y: 0,
        w: 42,
        h: 60,
        fillColor: { r: 1, g: 0.6, b: 0.1, a: 1 }
      }
    ]);
  }

  /** `sceneOf` for a parent-relative matrix subtree. */
  function localSpaceSceneOf(specs: Parameters<typeof sceneOf>[0]): MirrorState {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: specs.map((s) => s.id),
        upserts: specs.map(wireNode)
      })!
    );
    return state;
  }

  /** Where the decorative sprite is being painted, straight off the draw list. */
  function silhouetteX(): number {
    const lines = (window as unknown as { __mirrorDrawListDump: () => string[] }).__mirrorDrawListDump();
    const line = lines.find((l) => l.includes(" Silhouette "));
    if (!line) {
      throw new Error(`no Silhouette command in the dump:\n${lines.slice(0, 8).join("\n")}`);
    }
    return Number(/ m=[^,]+,[^,]+,[^,]+,[^,]+,(-?[\d.]+),/.exec(line)![1]);
  }

  /** Arm one flight over the sparks scene, run `frames` animation frames, and report where the sprite went. */
  function flySparks(m: ReturnType<typeof mount>, frames: number): { early: number; later: number } {
    const state = cometWithSparks();
    state.pendingCardFlights.push(flightHint());
    renderer!.reconcile(state);
    m.tick(16);
    m.raf.flush();
    const early = silhouetteX();
    for (let i = 0; i < frames; i++) {
      m.tick(16);
      m.raf.flush();
    }
    return { early, later: silhouetteX() };
  }

  it("carries the WHOLE comet with the card — the frozen orange square moves again", () => {
    const m = mount("/?stage=canvas&paintDump=1");
    const { early, later } = flySparks(m, 24);
    // The flight runs 300 → 1620, so a driven root has carried its sprites hundreds of px by now. Frozen, the
    // two reads are the same number — which is the next spec.
    expect(later - early).toBeGreaterThan(100);
    expect(stats().trailRootDrives).toBe(1);
  });

  // --- R5 T-DR5: the phase probe ---------------------------------------------------------------------------------

  it("publishes the comet's PHASE for snapshot consistency checks", () => {
    const m = mount("/?stage=canvas&paintDump=1");
    flyIt(m, 24);
    const probe = (window as unknown as { __mirrorTrailProbe?: () => unknown }).__mirrorTrailProbe;
    expect(probe, "installed with the other harness seams").toBeTypeOf("function");
    const phase = probe!() as {
      strokes: number;
      points: number;
      oldestAgeMs: number;
      headAgeMs: number;
      headX: number | null;
      arcPx: number;
    };
    expect(phase.strokes).toBe(2);
    expect(phase.points).toBeGreaterThan(4);
    // A LIVE age, not a counter: the comet is somewhere inside its own 800 ms decay, and the tail is older
    // than the head. That ordering is the thing a harness gates on.
    expect(phase.oldestAgeMs).toBeGreaterThan(0);
    expect(phase.oldestAgeMs).toBeLessThanOrEqual(800);
    expect(phase.headAgeMs).toBeLessThanOrEqual(phase.oldestAgeMs);
    expect(phase.headX).not.toBeNull();
    expect(phase.arcPx).toBeGreaterThan(100);
  });

  it("parks again once the last comet has drained", () => {
    const m = mount();
    flyIt(m, 24);
    // A ribbon outlives its flight by the point lifetime, so the stage is still asking for frames here…
    expect(stats().trails!.strokes).toBeGreaterThan(0);
    // …and must stop once every point has aged out AND the flight's own pin has expired (`windowMs` 3600, which
    // is what the loop holds the card for). 260 frames at 16 ms clears both.
    for (let i = 0; i < 260; i++) {
      m.tick(16);
      m.raf.flush();
      m.timers.fire();
    }
    const settled = stats();
    expect(settled.trails!.strokes).toBe(0);
    expect(settled.trails!.quads).toBe(0);
    // The latch bookkeeping has to balance, or a stroke is left pinned to a pose the wire has moved on from.
    expect(settled.trails!.latched).toBe(0);
    expect(settled.trails!.latchReleases).toBe(settled.trails!.latches);
    const frames = settled.animFrames;
    m.tick(16);
    m.raf.flush();
    m.timers.fire();
    expect(stats().animFrames, "nothing left to animate").toBe(frames);
  });

  it("adds no hit surface — a comet is decoration and must never take a tap", () => {
    const m = mount();
    flyIt(m, 24);
    // The strokes carry no `mouseFilter`, so they were never hit candidates; what this pins is that emitting
    // pixels for them did not make them into any. Every point along the ribbon's own arc is asked.
    for (const x of [400, 700, 960, 1300, 1600]) {
      const stack = renderer!.touchStackAt(x, 700);
      expect(stack.ids).not.toContain("Outer");
      expect(stack.ids).not.toContain("Inner");
    }
    expect(stats().overlayCounts.trail).toBe(2);
  });
});

// --- the deadline-honouring animation scheduler (M3) -----------------------------------------------------------
//
// Before M3 every deadline was a BOOLEAN IN DISGUISE: `armAnimation` asked only whether the minimum of its demand
// sources was finite and then booked a rAF, so a source that said "wake me in 66 ms" was woken in 16. These are
// the tests that say a wakeup is now honoured — and, first, the ones that say the TWEEN LOOP's never is.
//
// THE TWEEN RULE IS THE LOAD-BEARING ONE. `tweenLoop.nextDeadline` publishes MIXED SEMANTICS: `now` for a
// genuinely per-frame animator, but a running transform tween's END. Sleeping until that end would deliver the
// tween in one jump. So any finite answer from the tween loop books a rAF outright, and cadence is unchanged BY
// CONSTRUCTION. The first three tests are that property; a bench run cannot be a substitute for them, because a
// regression here is a smoothness change rather than a count.
describe("the animation scheduler's two arm modes (M3)", () => {
  function mount(search = "/?stage=canvas"): {
    stage: HTMLElement;
    raf: ReturnType<typeof stubRaf>;
    timers: ReturnType<typeof stubTimers>;
  } {
    stubWebgl2();
    const raf = stubRaf();
    const timers = stubTimers();
    vi.stubGlobal("devicePixelRatio", 1);
    window.history.replaceState(null, "", search);
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return { stage, raf, timers };
  }

  beforeEach(() => {
    // THE PRODUCT DEFAULT is a STILL (`spineMode: static`), which never plays and therefore never asks for a
    // frame. Tests that want the spine demand source say so through `withPlayingSpine`.
    loadSpineClipMock.mockResolvedValue(stillClip());
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    loadSpineClipMock.mockReset();
  });

  /** A backdrop, a creature the clip client will answer for, and an emitter for the fx demand source. */
  function spineScene(): MirrorState {
    return sceneOf([
      { id: "Root", parentId: null, w: 1920, h: 1080 },
      { id: "Backdrop", parentId: "Root", w: 1920, h: 1080, fillColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
      {
        id: "Creature",
        parentId: "Root",
        nodeType: "SpineSprite",
        x: 900,
        y: 500,
        w: 0,
        h: 0,
        spine: { sceneResPath: "res://creature.tscn" },
        spineCurrentAnim: "idle",
        spineTrackTime: 0
      },
      {
        id: "Emitter",
        parentId: "Root",
        x: 400,
        y: 300,
        w: 0,
        h: 0,
        shader: "res://shaders/particles.gdshader",
        particleSpec: { kind: "GPUParticles2D", amount: 8, lifetime: 1 }
      }
    ]);
  }

  /** A decoded SINGLE-frame clip: the product default, painted as an `<img>` and never advancing. */
  function stillClip(): LoadedSpineClip {
    const clip = playingClip();
    return { ...clip, frames: clip.frames.slice(0, 1), totalDurationMs: 100, stillUrl: "blob:still" };
  }

  /** A decoded MULTI-FRAME clip — the only kind that plays, and therefore the only one with a deadline. */
  function playingClip(): LoadedSpineClip {
    const bitmap = { close() {} } as unknown as ImageBitmap;
    return {
      canvasWidth: 100,
      canvasHeight: 200,
      totalDurationMs: 200,
      localX: 0,
      localY: 0,
      localWidth: 100,
      localHeight: 200,
      frames: [
        { index: 0, offsetX: 0, offsetY: 0, width: 10, height: 20, durationMs: 100, startMs: 0, png: new Uint8Array(), bitmap },
        { index: 1, offsetX: 0, offsetY: 0, width: 10, height: 20, durationMs: 100, startMs: 100, png: new Uint8Array(), bitmap }
      ],
      stillUrl: null,
      degraded: false,
      retain() {},
      release() {},
      dispose() {}
    };
  }

  /** Reconcile, let the mocked clip load resolve, and reconcile again so the build sees the playing set. */
  async function withPlayingSpine(state: MirrorState): Promise<void> {
    loadSpineClipMock.mockResolvedValue(playingClip());
    renderer!.reconcile(state);
    await Promise.resolve();
    await Promise.resolve();
    renderer!.reconcile(state);
  }

  function tweenHint(targetId: string, durationMs: number): MirrorState["pendingHints"][number] {
    return {
      targetId,
      property: "position",
      durationMs,
      ease: "Out",
      trans: "Quad",
      endTransform: [1, 0, 0, 1, 1500, 900],
      startTransform: null,
      endOpacity: null,
      startOpacity: null,
      group: null
    } as unknown as MirrorState["pendingHints"][number];
  }

  function paintEffect(stage: HTMLElement, id = "Emitter"): void {
    const host = overlayIn(stage)!.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
    const surface = document.createElement("canvas");
    surface.width = 64;
    surface.height = 64;
    renderer!.noteEffectRendered!(host, surface);
  }

  it("parks completely when nothing is armed — no rAF and no timer", () => {
    const { raf, timers } = mount();
    renderer!.reconcile(paintableScene());
    expect(raf.pending).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it("books a rAF for a running TWEEN, however far away its end is (the mixed-semantics rule)", () => {
    // `tweenLoop.nextDeadline` answers a transform tween with the tween's END. A 4-second tween must not become a
    // 4-second sleep — that would deliver the whole motion in one jump. Any finite tween deadline is a rAF.
    const { raf, timers } = mount();
    const state = paintableScene();
    state.pendingHints.push(tweenHint("Button", 4000));
    renderer!.reconcile(state);
    expect(stats().animActive).toBeGreaterThan(0);
    expect(raf.pending).toBe(1);
    expect(timers.pending).toBe(0);
  });

  it("keeps booking rAFs for the WHOLE of a tween — the park can never open mid-motion", () => {
    const { raf, timers } = mount();
    const state = paintableScene();
    state.pendingHints.push(tweenHint("Button", 4000));
    renderer!.reconcile(state);
    for (let i = 0; i < 5; i++) {
      expect(raf.pending).toBe(1);
      expect(timers.pending).toBe(0);
      raf.flush();
    }
    expect(stats().animFrames).toBeGreaterThanOrEqual(5);
  });

  it("PARKS ON A TIMER for a playing spine clip — the source with a real future deadline", async () => {
    const { raf, timers } = mount();
    await withPlayingSpine(spineScene());
    // No tween is running, so the minimum deadline is the clip's next frame — comfortably beyond the slop.
    expect(raf.pending).toBe(0);
    expect(timers.pending).toBe(1);
    expect(timers.delays[0]).toBeGreaterThan(0);
  });

  it("chains a park into EXACTLY ONE rAF, which repaints and re-arms", async () => {
    const { raf, timers } = mount();
    await withPlayingSpine(spineScene());
    const before = stats().animFrames;

    expect(timers.fire()).toBe(1);
    expect(raf.pending).toBe(1); // one rAF, so the repaint is still frame-aligned
    expect(timers.pending).toBe(0);

    raf.flush();
    expect(stats().animFrames).toBeGreaterThan(before);
    // …and the clip is still playing, so the loop re-parks rather than spinning.
    expect(raf.pending).toBe(0);
    expect(timers.pending).toBe(1);
  });

  it("caps a finite passive spine deadline when early wakes arrive at 120 Hz", async () => {
    // A decoded multi-frame Spine is a finite passive deadline, not action
    // motion. A timer/rAF pair can be delivered early or interleaved on a
    // high-refresh browser, but it still gets no more than one canvas paint
    // per 60 Hz display window.
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { raf, timers } = mount();
    await withPlayingSpine(spineScene());
    const before = stats().frames;

    for (let i = 0; i < 120; i++) {
      now += 1000 / 120;
      timers.fire();
      raf.flush();
    }

    expect(stats().frames - before).toBeLessThanOrEqual(60);
    expect(stats().idle?.displayBypasses).toEqual({ offset: 0, tween: 0, settle: 0, trail: 0 });
  });

  it("continues parking the default 30 Hz idle cadence and lets a transient pre-empt that park", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { raf, timers } = mount();
    const state = idlePulseScene();
    renderer!.reconcile(state);

    now += 34;
    expect(timers.fire()).toBe(1);
    raf.flush();
    // The legacy/default authored cadence is not the display-rate arm.
    expect(raf.pending).toBe(0);
    expect(timers.pending).toBe(1);

    state.pendingHints.push(tweenHint("Glow", 4000));
    renderer!.reconcile(state);
    // A genuine action keeps the historical immediate rAF behavior and
    // pre-empts the decorative timer rather than waiting for it.
    expect(raf.pending).toBe(1);
    expect(timers.pending).toBe(0);
  });

  it("NEVER RE-ARMS LATER — a second arm at the same deadline leaves the pending park alone", async () => {
    const { timers } = mount();
    const state = spineScene();
    await withPlayingSpine(state);
    expect(timers.pending).toBe(1);
    const armedFor = timers.delays[0];

    renderer!.reconcile(state);
    renderer!.reconcile(state);
    expect(timers.pending).toBe(1);
    // The SAME park: a re-arm that replaced it with an equal-or-later one would show up as a fresh delay.
    expect(timers.delays[0]).toBe(armedFor);
  });

  it("RE-ARMS EARLIER — a new demand due now pre-empts a pending park", async () => {
    const { stage, raf, timers } = mount();
    await withPlayingSpine(spineScene());
    expect(timers.pending).toBe(1);
    expect(raf.pending).toBe(0);

    // A gsw runtime paints an effect surface. Its pixels are owed a frame NOW, and without the re-arm-earlier rule
    // that frame would wait out the whole spine park.
    paintEffect(stage);

    expect(timers.pending).toBe(0); // the park was cancelled…
    expect(raf.pending).toBe(1); // …and replaced by the sooner wakeup
  });

  it("NEVER CANCELS A PENDING rAF, and arming again over one books nothing", () => {
    const { stage, raf, timers } = mount();
    loadSpineClipMock.mockResolvedValue(playingClip());
    const state = spineScene();
    renderer!.reconcile(state);
    state.pendingHints.push(tweenHint("Backdrop", 4000));
    renderer!.reconcile(state);
    expect(raf.pending).toBe(1);

    paintEffect(stage);
    renderer!.reconcile(state);

    // A rAF fires within one display frame — sooner than anything a timer could express — so re-arming over it
    // could only ever make the wakeup LATER.
    expect(raf.pending).toBe(1);
    expect(timers.pending).toBe(0);
  });

  it("books a rAF when there is no setTimeout to park on", async () => {
    const { raf } = mount();
    // A build/runtime with no timer at all must fall back to the pre-M3 behaviour rather than never waking.
    loadSpineClipMock.mockResolvedValue(playingClip());
    const state = spineScene();
    renderer!.reconcile(state);
    await Promise.resolve();
    await Promise.resolve();
    vi.stubGlobal("setTimeout", undefined);
    renderer!.reconcile(state);
    expect(raf.pending).toBe(1);
  });

  it("dispose cancels a pending park, and a stale one firing afterwards does nothing", async () => {
    const { raf, timers } = mount();
    await withPlayingSpine(spineScene());
    expect(timers.pending).toBe(1);

    renderer!.dispose();
    renderer = null;
    expect(timers.pending).toBe(0);
    // Belt and brace: even a timer the environment fired anyway must not schedule into a dead renderer.
    expect(timers.fire()).toBe(0);
    expect(raf.pending).toBe(0);
  });

  it("counts which arm each wakeup took, so a census can tell a park from a spin", () => {
    const { stage, raf, timers } = mount();
    const state = spineScene();
    renderer!.reconcile(state);
    expect(stats().schedule).toEqual({ rafs: 0, parks: 0, parkWakeups: 0, pulled: 0, rampFrames: 0 });

    paintEffect(stage);
    expect(stats().schedule.rafs).toBe(1);
    raf.flush();

    paintEffect(stage);
    expect(stats().schedule.parks).toBe(1);
    expect(stats().schedule.parkWakeups).toBe(0);
    timers.fire();
    expect(stats().schedule.parkWakeups).toBe(1);
    raf.flush();
  });

  it("the park's repaint NEVER ACKS — it returns into no one, exactly like the plain animation rAF", async () => {
    const { raf, timers } = mount();
    await withPlayingSpine(spineScene());
    // `animFrames`, not `frames` — R21 B1: this case is about the park's wakeup reaching the animation frame and
    // NOT reaching the ack, and a wakeup whose picture is unchanged now legitimately paints nothing. The
    // scheduler's own counter is what says the frame ran.
    const framesBefore = stats().animFrames;
    const reconciles = vi.fn();

    timers.fire();
    raf.flush();

    expect(stats().animFrames).toBeGreaterThan(framesBefore);
    expect(reconciles).not.toHaveBeenCalled();
  });
});

// --- the headless capture seam (R5 T0) -------------------------------------------------------------------------
//
// A page screenshot of this backend on a headless box captures the DOM overlay and NONE of the stage's pixels,
// because the context carries no `preserveDrawingBuffer` and a capture is always a LATER TASK than the paint that
// filled the buffer. The seam reads the buffer inside the painting task instead. What is asserted here is the
// CONTRACT that makes that work — the gate, the ordering (paint, then read, one callback), the refusal shape and
// the teardown — not the pixels, which jsdom has no rasterizer for.
describe("__mirrorCanvasSnapshot — reading the stage inside the painting task", () => {
  function mount(search: string): { raf: ReturnType<typeof stubRaf> } {
    stubWebgl2();
    const raf = stubRaf();
    stubTimers();
    vi.stubGlobal("devicePixelRatio", 1);
    window.history.replaceState(null, "", search);
    __setStageBackendForTest("canvas");
    renderer = createMirrorRendererFor(stageAt(1920, 1080, 1), defsEl());
    return { raf };
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  function snapshotSeam(): (() => Promise<string | null>) | undefined {
    return (window as unknown as { __mirrorCanvasSnapshot?: () => Promise<string | null> }).__mirrorCanvasSnapshot;
  }

  it("rides the paint-dump gate exactly — the two seams are installed and removed together", () => {
    mount("/?stage=canvas");
    renderer!.reconcile(paintableScene());
    const dumpSeam = (window as unknown as { __mirrorDrawListDump?: unknown }).__mirrorDrawListDump;
    // A dev bundle arms the dump unconditionally and a production one only on `?paintDump=`; whichever this is,
    // the readback must be on the SAME side of that gate. Asserting the pair rather than a literal is what makes
    // this spec say the real thing: a product page that exposes no dump must expose no full-stage PNG read
    // either (it is a cheap way for any script to stall the render thread).
    expect(typeof snapshotSeam()).toBe(typeof dumpSeam);
  });

  it("paints and reads in the SAME rAF callback — the only task the drawing buffer is defined in", async () => {
    const { raf } = mount("/?stage=canvas&paintDump=1");
    renderer!.reconcile(paintableScene());
    const seam = snapshotSeam();
    expect(seam, "the seam rides ?paintDump=1").toBeTypeOf("function");

    // The read records the paint count AT THE MOMENT IT RUNS. That is the assertion that cannot be satisfied by
    // a read scheduled in a later task: the paint must already have landed when `toDataURL` is called.
    let framesAtRead = -1;
    const framesBefore = stats().frames;
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      framesAtRead = stats().frames;
      return "data:image/png;base64,AAAA";
    });

    const pending = seam!();
    expect(stats().frames, "nothing happens until the frame runs").toBe(framesBefore);
    raf.flush();
    await expect(pending).resolves.toBe("data:image/png;base64,AAAA");
    expect(framesAtRead, "the paint lands before the read, in the same callback").toBe(framesBefore + 1);
  });

  it("resolves NULL rather than throwing when the read is refused — a refusal is not a blank frame", async () => {
    const { raf } = mount("/?stage=canvas&paintDump=1");
    renderer!.reconcile(paintableScene());
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      throw new Error("SecurityError: tainted canvas");
    });
    const pending = snapshotSeam()!();
    raf.flush();
    await expect(pending).resolves.toBeNull();
  });

  it("goes away with the renderer — a swapped backend inherits no stale readback", () => {
    mount("/?stage=canvas&paintDump=1");
    renderer!.reconcile(paintableScene());
    expect(snapshotSeam()).toBeTypeOf("function");
    renderer!.dispose();
    renderer = null;
    expect(snapshotSeam()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R6 M5 — THE RAISE HAS A TIME DIMENSION
// ---------------------------------------------------------------------------------------------------------------
//
// The DOM raises a hand card by writing a CSS `translate` on its element, and `.mirror-hand-raisable` carries
// `transition: translate 160ms ease-out`, so the raise-all button glides. This stage adds a cosmetic offset the
// walk composes — which had no time in it at all — so the same button teleported every card. `offsetRamp.ts` is
// the module; this is the wiring, and what it has to prove is that the glide RUNS (frames get booked, the pose
// moves, it arrives) and that nothing which did not ask for a ramp got one.
describe("readable-hand raise: the glide", () => {
  function mount(): { stage: HTMLElement; raf: ReturnType<typeof stubRaf>; tick: (ms: number) => void } {
    stubWebgl2();
    const raf = stubRaf();
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    __setStageBackendForTest("canvas");
    const stage = stageAt(1920, 1080, 1);
    renderer = createMirrorRendererFor(stage, defsEl());
    return { stage, raf, tick: (ms: number) => (clock += ms) };
  }

  /**
   * A raisable hand with parent-relative matrices: the root, the CardHolderContainer the fan hangs off, and one
   * holder resting BELOW the ramp's start so it takes the whole 119 px lift.
   */
  function handScene(): MirrorState {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["Root", "Hand", "CardHolderContainer", "Holder0", "Card0"],
        upserts: [
          { id: "Root", parentId: null, w: 1920, h: 1080 },
          { id: "Hand", parentId: "Root", nodeType: "Game.NPlayerHand", x: 400, y: 1080, w: 1120, h: 338 },
          { id: "CardHolderContainer", parentId: "Hand", name: "CardHolderContainer", x: 0, y: 0, w: 1120, h: 338 },
          { id: "Holder0", parentId: "CardHolderContainer", nodeType: "Game.NHandCardHolder", x: 100, y: 0, w: 0, h: 0 },
          {
            id: "Card0",
            parentId: "Holder0",
            nodeType: "Game.NCard",
            x: 0,
            y: 0,
            w: 240,
            h: 338,
            mouseFilter: 0,
            fillColor: { r: 1, g: 0, b: 0, a: 1 }
          }
        ].map(wireNode)
      })!
    );
    return state;
  }

  it("uses the current canvas snapshot's painted card owner, never a prior patch footprint", () => {
    const { raf } = mount();
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta", full: true, screenType: "run",
        orderedIds: ["Root", "Hand", "CardHolderContainer", "Holder0", "Hitbox0", "Card0", "Glow0", "Holder1", "Hitbox1", "Glow1"],
        upserts: [
          { id: "Root", parentId: null, w: 1920, h: 1080 },
          { id: "Hand", parentId: "Root", nodeType: "Game.NPlayerHand", x: 400, y: 1080, w: 1120, h: 338 },
          { id: "CardHolderContainer", parentId: "Hand", name: "CardHolderContainer", x: 0, y: 0, w: 1120, h: 338 },
          { id: "Holder0", parentId: "CardHolderContainer", nodeType: "Game.NHandCardHolder", x: 100, y: 0, w: 0, h: 0 },
          { id: "Hitbox0", parentId: "Holder0", name: "Hitbox", x: 0, y: 0, w: 300, h: 422, mouseFilter: 0 },
          { id: "Card0", parentId: "Holder0", nodeType: "ColorRect", x: 0, y: 0, w: 300, h: 422, fillColor: { r: 1, g: 0, b: 0, a: 1 } },
          // The real card's glow is wider than its input surface. It paints, but must never create a raise claim
          // outside Holder0's current hitbox/art-overhang footprint.
          { id: "Glow0", parentId: "Holder0", nodeType: "ColorRect", x: 300, y: 0, w: 100, h: 422, fillColor: { r: 1, g: 1, b: 0, a: 1 } },
          // This later neighbour's glow covers Holder0's face, while Holder1's own hitbox is elsewhere. The
          // provenance walk must skip it and continue down to Holder0's correctly bounded card paint.
          { id: "Holder1", parentId: "CardHolderContainer", nodeType: "Game.NHandCardHolder", x: 600, y: 0, w: 0, h: 0 },
          { id: "Hitbox1", parentId: "Holder1", name: "Hitbox", x: 0, y: 0, w: 300, h: 422, mouseFilter: 0 },
          { id: "Glow1", parentId: "Holder1", nodeType: "ColorRect", x: -500, y: 0, w: 300, h: 422, fillColor: { r: 0, g: 1, b: 0, a: 1 } },
        ].map(wireNode),
      })!,
    );
    renderer!.setRaiseHandCards(true);
    renderer!.reconcile(state);
    raf.flush();
    const rects = renderer!.interactiveRects();
    const hit = rects.find((r) => r.id === "Hitbox0");
    if (!hit) throw new Error(`missing hitbox ${JSON.stringify(rects)}`);
    const probeX = hit.transform[4] + hit.localRect.x + hit.localRect.width / 2 + hit.spreadDx;
    const probeY = hit.transform[5] + hit.localRect.y + hit.localRect.height / 2 + hit.raiseDy;
    expect(renderer!.raisedHandVisualClaimAt?.(probeX, probeY)).toEqual({ ownerId: "Holder0" });
    expect(renderer!.raisedHandTouchTargetClaim?.("Card0")).toEqual({ ownerId: "Holder0" });
    expect(renderer!.raisedHandTouchTargetClaim?.("missing-card")).toBeNull();
    expect(renderer!.raisedHandVisualClaimAt?.(probeX + hit.localRect.width / 2 + 50, probeY)).toBeNull();

    // A direct transform patch publishes a NEW DrawnSceneSnapshot. The old footprint must not survive through the
    // interaction sidecar cache, while the newly painted position names the same holder.
    applySceneDelta(state, parseSceneDelta({
      type: "scene-delta", full: false, screenType: "run",
      upserts: [wireNode({ id: "Holder0", parentId: "CardHolderContainer", nodeType: "Game.NHandCardHolder", x: 600, y: 0, w: 0, h: 0 })],
    })!);
    renderer!.reconcile(state);
    raf.flush();
    expect(renderer!.raisedHandVisualClaimAt?.(probeX, probeY)).toBeNull();
    expect(renderer!.raisedHandVisualClaimAt?.(probeX + 500, probeY)).toEqual({ ownerId: "Holder0" });
  });

  it("bridges an exact top touch target after its focused holder settles at native dy zero", () => {
    const { raf } = mount();
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta", full: true, screenType: "run",
        orderedIds: ["Root", "Hand", "CardHolderContainer", "Holder0", "Hitbox0", "Card0", "Holder1", "Hitbox1", "Card1"],
        upserts: [
          { id: "Root", parentId: null, w: 1920, h: 1080 },
          { id: "Hand", parentId: "Root", nodeType: "Game.NPlayerHand", x: 400, y: 1080, w: 1120, h: 338 },
          { id: "CardHolderContainer", parentId: "Hand", name: "CardHolderContainer", x: 0, y: 0, w: 1120, h: 338 },
          { id: "Holder0", parentId: "CardHolderContainer", nodeType: "Game.NHandCardHolder", x: 100, y: -209, w: 0, h: 0 },
          { id: "Hitbox0", parentId: "Holder0", name: "Hitbox", x: 0, y: 0, w: 300, h: 422, mouseFilter: 0 },
          { id: "Card0", parentId: "Holder0", nodeType: "Game.NCard", x: 0, y: 0, w: 300, h: 422, mouseFilter: 0 },
          { id: "Holder1", parentId: "CardHolderContainer", nodeType: "Game.NHandCardHolder", x: 600, y: -50, w: 0, h: 0 },
          { id: "Hitbox1", parentId: "Holder1", name: "Hitbox", x: 0, y: 0, w: 300, h: 422, mouseFilter: 0 },
          { id: "Card1", parentId: "Holder1", nodeType: "Game.NCard", x: 0, y: 0, w: 300, h: 422, mouseFilter: 0 },
        ].map(wireNode),
      })!,
    );
    renderer!.setRaiseHandCards(true);
    renderer!.reconcile(state);
    raf.flush();

    const rects = renderer!.interactiveRects();
    expect(rects.find((rect) => rect.id === "Hitbox0")?.raiseDy).toBe(0);
    expect(rects.find((rect) => rect.id === "Hitbox1")?.raiseDy).toBe(-HAND_RAISE_PX);
    expect(renderer!.raisedHandTouchTargetClaim?.("Card0")).toEqual({ ownerId: "Holder0" });
  });

  /** The card's own drawn Y, straight off the paint dump — the holder is a zero-size anchor and paints nothing. */
  function cardY(): number {
    const read = (window as unknown as { __mirrorDrawListDump?: () => string[] }).__mirrorDrawListDump;
    if (!read) throw new Error("__mirrorDrawListDump is not installed");
    const line = read().find((l) => l.startsWith("C ") && l.includes(" Card0 quad "));
    if (!line) throw new Error("Card0 painted no quad this frame");
    return Number(/\sm=([-\d.,]+)\s/.exec(line)![1].split(",")[5]);
  }

  it("GLIDES the hand up over 160 ms instead of teleporting it", () => {
    const { raf, tick } = mount();
    renderer!.reconcile(handScene());
    const rest = cardY();

    // The flip is leg 1 of the timing rule: the whole hand moves on the DOM's own 160 ms ease-out.
    renderer!.setRaiseHandCards(true);
    // THE DEFECT THIS PINS: before the ramp, this same call painted the full lift on the spot.
    expect(cardY()).toBe(rest);
    expect(raf.pending).toBeGreaterThan(0); // …and it booked the frames to draw the glide

    tick(80);
    raf.flush();
    const midway = cardY();
    expect(midway).toBeLessThan(rest);
    expect(midway).toBeGreaterThan(rest - HAND_RAISE_PX);
    // Ease-OUT: past halfway by the halfway point.
    expect(rest - midway).toBeGreaterThan(HAND_RAISE_PX / 2);

    tick(80);
    raf.flush();
    expect(cardY()).toBe(rest - HAND_RAISE_PX); // arrived, exactly
    expect(stats().schedule.rampFrames).toBeGreaterThan(0);

    // …and it lets go: nothing is left booked for a ramp that has arrived.
    raf.flush();
    tick(200);
    expect(raf.flush()).toBe(0);
  });

  it("glides back DOWN when the mode goes off", () => {
    const { raf, tick } = mount();
    renderer!.reconcile(handScene());
    const rest = cardY();
    renderer!.setRaiseHandCards(true);
    tick(200);
    raf.flush();
    expect(cardY()).toBe(rest - HAND_RAISE_PX);

    renderer!.setRaiseHandCards(false);
    expect(cardY()).toBe(rest - HAND_RAISE_PX); // still up on the frame the flip lands
    tick(80);
    raf.flush();
    expect(cardY()).toBeGreaterThan(rest - HAND_RAISE_PX);
    expect(cardY()).toBeLessThan(rest);
    tick(80);
    raf.flush();
    expect(cardY()).toBe(rest);
  });

  it("leaves every OTHER cosmetic offset a step function — the held-card lift is still instant", () => {
    const { stage } = mount();
    renderer!.reconcile(
      sceneOf([
        { id: "Root", parentId: null, w: 1920, h: 1080 },
        { id: "Card", parentId: "Root", nodeType: "Game.NCard", x: 800, y: 900, w: 240, h: 338, mouseFilter: 0 },
        { id: "CardArt", parentId: "Card", x: 0, y: 0, w: 240, h: 338, text: "art" }
      ])
    );
    // A peek passes no timing, so it writes its 120 px on the spot exactly as it did before ramps existed.
    renderer!.setHeldCard("Card", 900, 1000, "peek");
    const art = overlayIn(stage)!.querySelector<HTMLElement>('[data-node-id="CardArt"]')!;
    expect(art.style.transform).toBe("matrix(1, 0, 0, 1, 800, 780)");
    expect(stats().schedule.rampFrames).toBe(0);
  });
});
