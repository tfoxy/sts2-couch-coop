// R6 P6-A — THE RECONCILE PULL: collapsing the mirror's two rAF loops when they land in the same display frame.
//
// The defect this closes is a DOUBLE BUILD, not a wrong pixel. A delta arrives, `state.revision` moves, and
// MirrorView books its coalesced walk; meanwhile a tween/comet/effect has the canvas backend's own animation
// frame booked ahead of it. The animation frame runs first, builds and paints a whole draw list from the state
// the reconcile is about to replace — and the tier-3 patcher cannot save it either, because `framePatchBail`
// refuses a stale state outright (that bail is the largest bucket on an animated screen). Moments later the
// reconcile builds and paints again. One display frame, two builds, two paints, one of each wasted.
//
// So the two halves are tested separately, because they are two separate contracts:
//   * MirrorView owns the PULL ITSELF — `pending` really tracks the booked frame, `now` runs the identical body
//     ONCE (one ack, not two), it drops the frame it pre-empted, and it refuses re-entry without losing that
//     frame.
//   * the canvas backend owns WHEN TO USE IT — only when the revision has genuinely moved past its last build
//     AND a reconcile is really pending; every other frame is byte-identical to the code before this existed,
//     including the case where nothing wired a pull at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MirrorView from "@/mirror/MirrorView.vue";
import { createMirrorRendererFor, __setStageBackendForTest, requestedStageBackend } from "@/mirror/rendererFactory";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorState
} from "@/mirror/sceneTree";
import type { MirrorRenderer, ReconcilePull } from "@/mirror/mirrorRenderer";

// --- a hand-driven rAF that models CANCELLATION DURING A FLUSH ------------------------------------------------
//
// That is the whole point here and an ordinary "splice everything, then run it" stub cannot express it: the pull
// cancels MirrorView's booked frame from INSIDE the animation frame that ran before it, so the queue has to be
// re-read as it is walked. Handles are 1-based indices into a never-spliced array, and a flush only runs the
// frames that were booked before it started (a frame booked BY a frame belongs to the next flush, as in a
// browser).
function stubRaf(): { pending: number; cancelled: number; flush: () => number } {
  const queue: (FrameRequestCallback | null)[] = [];
  let cursor = 0;
  let cancelled = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    if (handle >= 1 && handle <= queue.length && queue[handle - 1] !== null) {
      queue[handle - 1] = null;
      cancelled++;
    }
  });
  return {
    get cancelled() {
      return cancelled;
    },
    get pending() {
      let n = 0;
      for (let i = cursor; i < queue.length; i++) {
        if (queue[i] !== null) n++;
      }
      return n;
    },
    flush() {
      const end = queue.length;
      let ran = 0;
      while (cursor < end) {
        const cb = queue[cursor++];
        if (cb) {
          cb(performance.now());
          ran++;
        }
      }
      return ran;
    }
  };
}

// --- part 1: MirrorView's half -------------------------------------------------------------------------------

// A renderer that records rather than renders. Only the methods MirrorView touches on the mount + render path are
// spelled out; the rest of the interface is absent on purpose, so this fake cannot silently start covering for a
// method a future MirrorView calls without a spec author noticing the type error.
interface FakePull {
  captured: ReconcilePull | null;
  reconciles: number;
  /** Run INSIDE the walk, so a test can attempt re-entry from exactly where a backend would. */
  onReconcile: (() => void) | null;
}

function fakeRenderer(log: FakePull): MirrorRenderer {
  const noop = () => {};
  return {
    reconcile: () => {
      log.reconciles++;
      log.onReconcile?.();
    },
    setReconcilePull: (pull: ReconcilePull) => {
      log.captured = pull;
    },
    markTextureDirty: noop,
    setStretch: noop,
    setHeldCard: noop,
    setRaiseHandCards: noop,
    setUiScaling: noop,
    raiseInputStamps: () => [],
    handPresent: () => false,
    handRaiseUiLayer: () => ({ present: false, anchorId: null, domTarget: null, covered: false, backend: "canvas" }),
    handPoses: () => ({ stage: "canvas", atMs: 0, spreadFactor: 1, handPresent: false, holders: [] }),
    landingLog: () => ({ stage: "canvas", spreadFactor: 1, openCount: 0, rows: [] }),
    handRaiseDebug: () => ({}),
    isCardTouchTarget: () => false,
    isHandCard: () => false,
    confirmTapTarget: () => null,
    confirmTapAt: () => null,
    coverAbove: () => false,
    rewardFocusSnapshot: () => ({ screenId: null, rows: [] }),
    setConfirmCoverWatch: noop,
    handChoiceActive: () => false,
    mapDrawingToolActive: () => false,
    interactiveRects: () => [],
    viewScaleInputStamps: () => [],
    endTurnBoxAt: () => null,
    eagerScrollTargets: () => [],
    isUnderNode: () => false,
    consumeEffectsDirty: () => ({ shader: false, particle: false }),
    setStaticBackgroundShown: noop,
    __drainDormantHatchForTest: () => false,
    __drainRevealStaggerForTest: () => 0,
    touchStackAt: () => ({ ids: [], blocked: false, blockKind: null, topStamp: null }),
    spreadPainterAt: () => null,
    mapNodeAt: () => null,
    applyLocalOffset: noop,
    scrollRenderedY: () => null,
    dispose: noop
  };
}

const factoryLog: FakePull = { captured: null, reconciles: 0, onReconcile: null };
vi.mock("@/mirror/rendererFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/rendererFactory")>();
  return {
    ...actual,
    createMirrorRendererFor: (...args: unknown[]) =>
      viewUsesRealRenderer
        ? (actual.createMirrorRendererFor as (...a: unknown[]) => MirrorRenderer)(...args)
        : fakeRenderer(factoryLog)
  };
});
// Part 2 constructs the renderer itself, so the mock above must stand aside for the real factory there.
let viewUsesRealRenderer = false;

// --- shared scene fixtures ------------------------------------------------------------------------------------

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
  const out: Record<string, unknown> = {
    id: spec.id,
    parentId: spec.parentId ?? null,
    name: spec.id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: spec.x ?? 0, y: spec.y ?? 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: spec.w ?? 200, y: spec.h ?? 100 } },
    visible: true
  };
  if (spec.fillColor) out.fillColor = spec.fillColor;
  return out;
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

function paintableScene(): MirrorState {
  return sceneOf([
    { id: "Root", parentId: null, w: 1920, h: 1080 },
    { id: "Backdrop", parentId: "Root", w: 1920, h: 1080, fillColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
    { id: "Button", parentId: "Root", x: 100, y: 200, w: 300, h: 80, fillColor: { r: 1, g: 0, b: 0, a: 1 } }
  ]);
}

describe("MirrorView's reconcile pull", () => {
  let raf: ReturnType<typeof stubRaf>;

  beforeEach(() => {
    document.body.innerHTML = "";
    factoryLog.captured = null;
    factoryLog.reconciles = 0;
    factoryLog.onReconcile = null;
    viewUsesRealRenderer = false;
    raf = stubRaf();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("hands the renderer a pull whose `pending` tracks the booked coalesced frame", async () => {
    const state = paintableScene();
    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    const pull = factoryLog.captured;
    expect(pull).not.toBeNull();

    // Nothing booked yet: the mount's own reconcile ran synchronously.
    raf.flush();
    expect(pull!.pending()).toBe(false);

    sceneOf([{ id: "Button", parentId: "Root", x: 140, y: 200, w: 300, h: 80 }], state);
    await wrapper.setProps({ revision: 2 });
    expect(pull!.pending()).toBe(true);

    raf.flush();
    expect(pull!.pending()).toBe(false);
    wrapper.unmount();
  });

  it("runs the pending walk ONCE — one reconcile, one ack — and drops the frame it pre-empted", async () => {
    const state = paintableScene();
    const acks = vi.fn();
    const wrapper = mount(MirrorView, { props: { state, revision: 1, onSceneRendered: acks } });
    raf.flush();
    const pull = factoryLog.captured!;
    factoryLog.reconciles = 0;
    acks.mockClear();

    sceneOf([{ id: "Button", parentId: "Root", x: 140, y: 200, w: 300, h: 80 }], state);
    await wrapper.setProps({ revision: 2 });
    const cancelsBefore = raf.cancelled;

    pull.now();
    expect(factoryLog.reconciles).toBe(1);
    expect(acks).toHaveBeenCalledTimes(1);
    // THE BOOKED FRAME IS DROPPED, not merely made inert: exactly one cancellation, and when the display frame it
    // was booked for arrives, the walk does NOT happen a second time. (A flush here is not empty — a rendered
    // frame re-arms the adaptive-quality sampler's own loop — so the count is what says it, not the queue.)
    expect(raf.cancelled).toBe(cancelsBefore + 1);
    raf.flush();
    expect(factoryLog.reconciles).toBe(1);
    expect(acks).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("refuses re-entry — a pull from inside the walk neither nests it nor acks twice", async () => {
    const state = paintableScene();
    const acks = vi.fn();
    const wrapper = mount(MirrorView, { props: { state, revision: 1, onSceneRendered: acks } });
    raf.flush();
    const pull = factoryLog.captured!;
    factoryLog.reconciles = 0;
    acks.mockClear();

    // Re-entry from inside the walk, which is exactly where a backend could reach it: a renderer's `reconcile`
    // runs INSIDE `runScheduledRender`, and anything it triggers synchronously (an image callback, a runtime
    // notification) can call back out. Nesting would double the whole frame — the walk, the overlay sync, the
    // ack — so the second entry has to be a no-op.
    let refusedInside = 0;
    factoryLog.onReconcile = () => {
      refusedInside++;
      pull.now();
    };

    sceneOf([{ id: "Button", parentId: "Root", x: 140, y: 200, w: 300, h: 80 }], state);
    await wrapper.setProps({ revision: 2 });
    raf.flush();

    expect(refusedInside).toBe(1); // the hook ran once, so the nested `now()` really was attempted
    expect(factoryLog.reconciles).toBe(1);
    expect(acks).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("clears its guard on the way out — a walk that throws does not wedge the pull forever", async () => {
    const state = paintableScene();
    const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
    raf.flush();
    const pull = factoryLog.captured!;
    factoryLog.reconciles = 0;

    factoryLog.onReconcile = () => {
      factoryLog.onReconcile = null;
      throw new Error("walk blew up");
    };
    sceneOf([{ id: "Button", parentId: "Root", x: 140, y: 200, w: 300, h: 80 }], state);
    await wrapper.setProps({ revision: 2 });
    expect(() => raf.flush()).toThrow("walk blew up");

    // …and the NEXT pull still works. Without the `finally` this would be silently dead for the session, which
    // on the canvas backend means every animated frame from here on rebuilds against a stale state again.
    pull.now();
    expect(factoryLog.reconciles).toBe(2);
    wrapper.unmount();
  });
});

// --- part 2: the canvas backend's half ------------------------------------------------------------------------

interface CanvasStats {
  animFrames: number;
  builds: number;
  schedule: { rafs: number; parks: number; parkWakeups: number; pulled: number };
}

function stats(): CanvasStats {
  const read = (window as unknown as { __mirrorCanvasStats?: () => CanvasStats }).__mirrorCanvasStats;
  if (!read) {
    throw new Error("__mirrorCanvasStats is not installed");
  }
  return read();
}

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

/** jsdom has no WebGL: a Proxy complete enough to drive gsw's real stage + executor (canvasStage.spec's stub). */
function stubWebgl2(): void {
  let constantSeed = 0x1000;
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
    clear: () => {},
    clearColor: () => {},
    drawArraysInstanced: () => {},
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
}

/** A transform tween: the demand source that books an animation rAF unconditionally, for as long as it runs. */
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

describe("the canvas backend's animation frame, against a pending reconcile", () => {
  let renderer: MirrorRenderer | null = null;
  let backendAtStart: ReturnType<typeof requestedStageBackend>;
  let raf: ReturnType<typeof stubRaf>;

  beforeEach(() => {
    document.body.innerHTML = "";
    viewUsesRealRenderer = true;
    backendAtStart = requestedStageBackend();
    stubWebgl2();
    raf = stubRaf();
    vi.stubGlobal("devicePixelRatio", 1);
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

  function mountRenderer(): MirrorRenderer {
    renderer = createMirrorRendererFor(stageAt(1920, 1080), defsEl());
    return renderer;
  }

  /** A renderer mid-tween (so an animation rAF is booked) with a delta already applied behind it. */
  function midTweenWithPendingDelta(): { state: MirrorState; r: MirrorRenderer } {
    const r = mountRenderer();
    const state = paintableScene();
    state.pendingHints.push(tweenHint("Button", 4000));
    r.reconcile(state);
    expect(raf.pending).toBe(1); // the tween's own animation frame
    // …and now the wire moves, exactly as `applySceneDelta` would from a socket message. MirrorView would book
    // its coalesced walk BEHIND the animation frame already sitting in the queue.
    sceneOf([{ id: "Button", parentId: "Root", x: 140, y: 200, w: 300, h: 80 }], state);
    return { state, r };
  }

  it("spends the frame on the pending reconcile — ONE build, where there used to be two", () => {
    const { state, r } = midTweenWithPendingDelta();
    let pending = true;
    let nows = 0;
    r.setReconcilePull!({
      pending: () => pending,
      now: () => {
        nows++;
        pending = false;
        r.reconcile(state);
      }
    });
    const before = stats().builds;

    raf.flush();

    expect(nows).toBe(1);
    expect(stats().schedule.pulled).toBe(1);
    // The reconcile's build and nothing else: the animation frame contributed none of its own.
    expect(stats().builds).toBe(before + 1);
  });

  it("…and the arm it replaced is what the old code paid: two builds for one display frame", () => {
    // The SAME sequence with no pull wired — the pre-P6-A behaviour, and the number the case above improves on.
    const { state, r } = midTweenWithPendingDelta();
    const before = stats().builds;

    raf.flush(); // the animation frame: a full rebuild, because `framePatchBail` refuses the stale state
    r.reconcile(state); // …and MirrorView's coalesced walk, moments later, rebuilding the same tree

    expect(stats().schedule.pulled).toBe(0);
    expect(stats().builds).toBe(before + 2);
  });

  it("does not pull when no reconcile is pending — the frame is the renderer's own, as before", () => {
    const { state, r } = midTweenWithPendingDelta();
    let nows = 0;
    r.setReconcilePull!({
      pending: () => false,
      now: () => {
        nows++;
        r.reconcile(state);
      }
    });
    const before = stats().builds;

    raf.flush();

    expect(nows).toBe(0);
    expect(stats().schedule.pulled).toBe(0);
    // It still had to rebuild (the state moved under it), which is exactly the frame the pull cannot save: nobody
    // is going to re-render this tree, so painting the newest state here is the RIGHT answer, not a wasted one.
    expect(stats().builds).toBe(before + 1);
    expect(stats().animFrames).toBeGreaterThan(0);
  });

  it("does not pull on a frame whose state has NOT moved since the last build", () => {
    const r = mountRenderer();
    const state = paintableScene();
    state.pendingHints.push(tweenHint("Button", 4000));
    r.reconcile(state);
    let nows = 0;
    // `pending` lies YES on purpose: the revision guard alone has to refuse this frame, or a permanently pending
    // walk from some unrelated source would starve every tween frame the loop books.
    r.setReconcilePull!({
      pending: () => true,
      now: () => {
        nows++;
      }
    });

    raf.flush();

    expect(nows).toBe(0);
    expect(stats().schedule.pulled).toBe(0);
    expect(stats().animFrames).toBeGreaterThan(0);
  });

  it("counts pulled frames separately from parks and rAFs, so a census can see the collapse", () => {
    const { state, r } = midTweenWithPendingDelta();
    let pending = true;
    r.setReconcilePull!({
      pending: () => pending,
      now: () => {
        pending = false;
        r.reconcile(state);
      }
    });
    raf.flush();
    const s = stats();
    expect(s.schedule.pulled).toBe(1);
    expect(s.schedule.parks).toBe(0);
    expect(s.schedule.rafs).toBeGreaterThan(0);
  });
});
