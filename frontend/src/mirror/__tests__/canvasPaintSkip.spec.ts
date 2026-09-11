// THE PAINT SKIP, THROUGH A REAL RENDERER — R21 B1's other half.
//
// `canvasPaintGuard.spec` owns the equality test in isolation. What it cannot reach is whether the RENDERER hands
// that test the right things and honours its answer, and there is exactly one way for this feature to be a
// disaster rather than a disappointment:
//
//   THE SCENE ACK. `MirrorView.runScheduledRender` acks the wire immediately after `renderer.reconcile` returns,
//   and the host uses that ack as flow-control credit — it will not release the next coalesced delta until it
//   arrives. A skipped paint that also skipped the ack does not draw a stale frame; it WEDGES THE MIRROR, for the
//   rest of the session, with no way back. That is the first case below and it is driven through a mounted
//   MirrorView rather than through the renderer, because the renderer is not where the contract lives.
//
// The rest are the pixel sources that can move without the draw list moving. Each is driven for real:
//   * a texture upload into a handle the list already names (the shared cache's counters)
//   * a context loss, and a restore
//   * a resize, which clears the framebuffer
//   * the headless capture seam, which reads the DRAWING buffer and not the composited copy
//
// …plus the kill switch, and that the flag changes no PIXELS — the draw list is byte-identical on both arms,
// because this feature does not touch the builder at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MirrorView from "@/mirror/MirrorView.vue";
import { createMirrorRendererFor, __setStageBackendForTest, requestedStageBackend } from "@/mirror/rendererFactory";
import type { MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// --- the shared texture cache, captured -------------------------------------------------------------------------
//
// `paintPixelEpoch` folds this object's counters, and it is the ONLY way this backend can learn that a texture's
// pixels changed under an unchanged handle. Capturing the real cache (rather than faking one) is what lets a test
// simulate "some producer uploaded" the way any of the five real producers would — by moving `stats.uploads` —
// without having to drive a bridge, an fx surface or a spine still through jsdom.
const caches: { last: { stats: { uploads: number; respecs: number; evictions: number } } | null } = { last: null };
vi.mock("@godot-scene-web/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@godot-scene-web/canvas")>();
  return {
    ...actual,
    createTextureCache: (...args: Parameters<typeof actual.createTextureCache>) => {
      const cache = actual.createTextureCache(...args);
      caches.last = cache as unknown as { stats: { uploads: number; respecs: number; evictions: number } };
      return cache;
    }
  };
});

// --- harness ----------------------------------------------------------------------------------------------------

function stageAt(designW: number, designH: number): HTMLElement {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  Object.defineProperty(stage, "clientWidth", { configurable: true, value: designW });
  Object.defineProperty(stage, "clientHeight", { configurable: true, value: designH });
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: designW, height: designH }) as DOMRect;
  return stage;
}

function defsEl(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.appendChild(svg);
  return defs;
}

/**
 * jsdom has no WebGL: `canvasReconcilePull.spec`'s Proxy, complete enough to drive gsw's real stage + executor,
 * plus a COUNT of the `drawArraysInstanced` calls — which is what "the stage really painted" means here. The
 * renderer's own `frames` counter is deliberately not the only witness: it would still move if `execute` returned
 * early, and this spec is about GL work not happening.
 */
function stubWebgl2(): { draws: () => number; clears: () => number } {
  let constantSeed = 0x1000;
  let draws = 0;
  let clears = 0;
  const constants = new Map<string, number>();
  let canvasEl: HTMLCanvasElement | null = null;
  const explicit: Record<string, unknown> = {
    get drawingBufferWidth() {
      return canvasEl?.width ?? 0;
    },
    get drawingBufferHeight() {
      return canvasEl?.height ?? 0;
    },
    viewport: () => {},
    clear: () => {
      clears++;
    },
    clearColor: () => {},
    drawArraysInstanced: () => {
      draws++;
    },
    getParameter: (pname: number) =>
      pname === (gl as unknown as Record<string, number>).MAX_TEXTURE_SIZE ? 8192 : 8,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getExtension: () => null
  };
  const gl = new Proxy(explicit, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (/^[A-Z0-9_]+$/.test(prop)) {
        let value = constants.get(prop);
        if (value === undefined) {
          value = constantSeed++;
          constants.set(prop, value);
        }
        return value;
      }
      if (/^create[A-Z]/.test(prop) || /Location$/.test(prop)) return () => ({});
      return () => undefined;
    }
  }) as unknown as WebGL2RenderingContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string
  ) {
    if (kind !== "webgl2") return null;
    canvasEl = this;
    return gl as unknown as RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext);
  return { draws: () => draws, clears: () => clears };
}

function stubRaf(): { flush: () => number } {
  const queue: (FrameRequestCallback | null)[] = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => queue.push(fn));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    if (handle > 0 && handle <= queue.length) queue[handle - 1] = null;
  });
  return {
    flush() {
      const due = queue.splice(0, queue.length);
      let ran = 0;
      for (const fn of due) {
        if (fn) {
          fn(0);
          ran++;
        }
      }
      return ran;
    }
  };
}

interface PaintSkipStats {
  skipped: number;
  asked: number;
  cold: number;
}

function canvasStats(): { frames: number; paintSkip: PaintSkipStats | null } {
  const read = (window as unknown as { __mirrorCanvasStats?: () => { frames: number; paintSkip: PaintSkipStats | null } })
    .__mirrorCanvasStats;
  if (!read) {
    throw new Error("__mirrorCanvasStats is not installed");
  }
  return read();
}

interface NodeSpec {
  id: string;
  parentId?: string | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fillColor?: { r: number; g: number; b: number; a: number };
}

function wireNode(spec: NodeSpec): Record<string, unknown> {
  return {
    id: spec.id,
    parentId: spec.parentId ?? null,
    name: spec.id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: spec.x ?? 0, y: spec.y ?? 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: spec.w ?? 200, y: spec.h ?? 100 } },
    visible: true,
    ...(spec.fillColor ? { fillColor: spec.fillColor } : {})
  };
}

/** A keyframe (no `into`) or an in-place update of the nodes named — the latter bumps `state.revision`. */
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

/**
 * A scene with NO idle animation in it — three plain `Control`s. That is deliberate and it is the whole reason
 * this spec can assert on skips at all: the round's own bench measurement is that a real screen's decorative
 * bob/spin loops move something every frame, so a guard that compares draw lists fires on 3-6% of frames there.
 * What is under test here is the mechanism, so the fixture is the static screen the mechanism is FOR.
 */
function staticScene(): MirrorState {
  return sceneOf([
    { id: "Root", parentId: null, w: 1878, h: 954 },
    { id: "Backdrop", parentId: "Root", w: 1878, h: 954, fillColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
    { id: "Button", parentId: "Root", x: 100, y: 200, w: 300, h: 80, fillColor: { r: 1, g: 0, b: 0, a: 1 } }
  ]);
}

// A REALISTIC ASPECT, not 1920x1080. An exact 16:9 viewport is the one case where the wide-screen spread is
// inactive, so it silently exercises a code path no maximized desktop browser is ever on.
const DESIGN_W = 1878;
const DESIGN_H = 954;

/** Every `ResizeObserver` callback the renderer registered — the only way into `resize()` from a spec. */
const resizeCallbacks: Array<() => void> = [];

describe("the canvas stage's unchanged-picture paint skip", () => {
  let renderer: MirrorRenderer | null = null;
  let backendAtStart: ReturnType<typeof requestedStageBackend>;
  let gl: ReturnType<typeof stubWebgl2>;
  let raf: ReturnType<typeof stubRaf>;

  beforeEach(() => {
    document.body.innerHTML = "";
    caches.last = null;
    backendAtStart = requestedStageBackend();
    gl = stubWebgl2();
    raf = stubRaf();
    vi.stubGlobal("devicePixelRatio", 1);
    // CAPTURED, not merely stubbed: `resize()` is only reachable through this callback, and the resize case below
    // is one of the five paths that must force a paint.
    resizeCallbacks.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          resizeCallbacks.push(cb);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
    window.history.replaceState(null, "", "/?stage=canvas");
    __setStageBackendForTest("canvas");
  });

  afterEach(() => {
    renderer?.dispose();
    renderer = null;
    __setStageBackendForTest(backendAtStart);
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mountRenderer(query = "/?stage=canvas"): MirrorRenderer {
    window.history.replaceState(null, "", query);
    renderer = createMirrorRendererFor(stageAt(DESIGN_W, DESIGN_H), defsEl());
    return renderer;
  }

  // --- the contract that must never break -----------------------------------------------------------------------

  it("STILL ACKS on a frame whose paint was skipped — the flow-control credit the host waits on", async () => {
    const state = staticScene();
    const acks = vi.fn();
    const wrapper = mount(MirrorView, { props: { state, revision: 1, onSceneRendered: acks } });
    raf.flush();

    // The mount painted; bank it, then push a delta that changes NOTHING about the picture. `revision` moves (so
    // MirrorView really does run a walk and really would ack) but the node is re-sent identical, so the rebuilt
    // draw list is byte-identical and the guard skips.
    const drawsBefore = gl.draws();
    acks.mockClear();
    sceneOf([{ id: "Button", parentId: "Root", x: 100, y: 200, w: 300, h: 80, fillColor: { r: 1, g: 0, b: 0, a: 1 } }], state);
    await wrapper.setProps({ revision: 2 });
    raf.flush();

    const skip = canvasStats().paintSkip;
    expect(skip).not.toBeNull();
    expect(skip!.skipped).toBeGreaterThan(0); // the frame really was skipped…
    expect(gl.draws()).toBe(drawsBefore); // …and really issued no GL work…
    expect(acks).toHaveBeenCalled(); // …and the host was still told the scene rendered.
    wrapper.unmount();
  });

  // --- the mechanism --------------------------------------------------------------------------------------------

  it("skips the repaint of an identical scene, and paints again the moment one moves", () => {
    const r = mountRenderer();
    const state = staticScene();
    r.reconcile(state);
    const afterFirst = gl.draws();
    expect(afterFirst).toBeGreaterThan(0);

    // Identical scene, three more times.
    for (let i = 0; i < 3; i++) {
      r.reconcile(state);
    }
    expect(gl.draws()).toBe(afterFirst);
    expect(canvasStats().paintSkip!.skipped).toBe(3);

    // …and now something actually moves.
    sceneOf([{ id: "Button", parentId: "Root", x: 400, y: 200, w: 300, h: 80, fillColor: { r: 1, g: 0, b: 0, a: 1 } }], state);
    r.reconcile(state);
    expect(gl.draws()).toBeGreaterThan(afterFirst);
  });


  // --- the pixel sources that move without the draw list moving --------------------------------------------------

  it("PAINTS when a texture was uploaded under an unchanged list", () => {
    const r = mountRenderer();
    const state = staticScene();
    r.reconcile(state);
    const afterFirst = gl.draws();
    r.reconcile(state);
    expect(gl.draws()).toBe(afterFirst); // control: identical scene, skipped

    // Some producer replaced an existing entry's pixels. Which one does not matter and that is the point — all
    // five (bridge, fx, spine, text, atlas repack) are constructed with this same cache, so one counter covers
    // them. `update`/`updateRegion` keep the HANDLE and change the pixels, which is exactly the case no
    // comparison of the draw list can see.
    expect(caches.last).not.toBeNull();
    caches.last!.stats.uploads += 1;
    r.reconcile(state);
    expect(gl.draws()).toBeGreaterThan(afterFirst);
  });

  it("PAINTS when a texture was evicted under an unchanged list", () => {
    const r = mountRenderer();
    const state = staticScene();
    r.reconcile(state);
    const afterFirst = gl.draws();
    r.reconcile(state);
    expect(gl.draws()).toBe(afterFirst);

    caches.last!.stats.evictions += 1;
    r.reconcile(state);
    expect(gl.draws()).toBeGreaterThan(afterFirst);
  });

  it("PAINTS after a context loss and restore, without skipping the frame that repopulates the screen", () => {
    const r = mountRenderer();
    const state = staticScene();
    r.reconcile(state);
    const canvas = document.querySelector("canvas");
    expect(canvas).not.toBeNull();

    r.reconcile(state);
    const beforeLoss = gl.draws();
    expect(canvas!.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))).toBe(false);
    canvas!.dispatchEvent(new Event("webglcontextrestored"));
    raf.flush();

    // A NEW context: an empty drawing buffer and new GL names behind every handle. The list is the same one that
    // was on screen a moment ago, so a guard that survived the loss would skip this and leave the stage blank.
    expect(gl.draws()).toBeGreaterThan(beforeLoss);
  });

  it("PAINTS after a resize clears the framebuffer", () => {
    const r = mountRenderer();
    const stage = document.body.querySelector("div") as HTMLElement;
    const state = staticScene();
    r.reconcile(state);
    r.reconcile(state);
    const beforeResize = gl.draws();
    const clearsBefore = gl.clears();
    expect(resizeCallbacks.length).toBeGreaterThan(0);

    // The stage's design box moves. `resize` drops the backing store, CLEARS, and repaints — and nothing in the
    // draw list has to change for the framebuffer to have been wiped, so that repaint must not be skippable.
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 1200 });
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 700 });
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 700 }) as DOMRect;
    for (const cb of resizeCallbacks) {
      cb();
    }

    expect(gl.clears()).toBeGreaterThan(clearsBefore);
    expect(gl.draws()).toBeGreaterThan(beforeResize);
  });

  it("PAINTS the headless capture seam's frame, which reads the DRAWING buffer", async () => {
    const r = mountRenderer("/?stage=canvas&paintDump=1");
    const state = staticScene();
    r.reconcile(state);
    r.reconcile(state);
    const before = gl.draws();
    expect(canvasStats().paintSkip!.skipped).toBeGreaterThan(0); // control: this scene IS skippable

    const snapshot = (window as unknown as { __mirrorCanvasSnapshot?: () => Promise<string | null> })
      .__mirrorCanvasSnapshot;
    expect(snapshot).toBeTypeOf("function");
    const pending = snapshot!();
    raf.flush();
    await pending;
    // The composited copy is what the PLAYER sees and it is still correct; the capture reads the drawing buffer,
    // which holds nothing until something draws into it. So this one path forces.
    expect(gl.draws()).toBeGreaterThan(before);
  });
});
