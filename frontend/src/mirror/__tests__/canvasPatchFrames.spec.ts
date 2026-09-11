// THE FRAME-LEVEL HALF OF TIER-3 PATCHING — `canvasRenderer.framePatchBail`, driven through a real renderer.
//
// `canvasListPatch.spec` owns the arithmetic, because `listPatch.ts` is pure and a fake list proves it. What that
// spec cannot reach is the QUESTION ASKED BEFORE IT: is this frame one where the list the last build left is still
// true about everything the patcher does not look at? That answer lives in the renderer, it is spelt as a
// histogram of named refusals, and the histogram IS the deliverable — a bucket that says `transform` when a glyph
// swapped a source rect is not a smaller bug than a wrong colour, it is a measurement that lies about how much a
// pose tier could claim.
//
// So this file drives the canvas backend with a controllable clock and a controllable rAF, animates ONE thing at a
// time, and reads `stats().patch.bailouts` by name.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorRendererFor, __setStageBackendForTest, requestedStageBackend } from "@/mirror/rendererFactory";
import type { MirrorRenderer } from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// --- the harness ------------------------------------------------------------------------------------------------

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

/** jsdom has no WebGL: `canvasIdleLoops.spec`'s Proxy, complete enough to drive gsw's real stage + executor. */
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
    getParameter: (pname: number) => (pname === (gl as unknown as Record<string, number>).MAX_TEXTURE_SIZE ? 8192 : 8),
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind !== "webgl2") return null;
    canvasEl = this;
    return gl as unknown as RenderingContext;
  } as never);
}

/** A rAF queue this test drains by hand, so "one animated frame" is a call rather than a wait. */
interface Raf {
  flush(): number;
  pending(): number;
}
function stubRaf(): Raf {
  const queue: (FrameRequestCallback | null)[] = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => queue.push(fn));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    if (handle > 0 && handle <= queue.length) queue[handle - 1] = null;
  });
  return {
    pending: () => queue.filter((fn) => fn !== null).length,
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

/**
 * The PARK timer, likewise. The idle family's cadence is a CAP, so its wakeup is a real timestamp the renderer
 * sleeps on with `setTimeout` rather than booking an rAF for — which means a test that drains only the rAF queue
 * sees exactly one animated frame and then silence.
 */
interface Timers {
  fire(): number;
  pending(): number;
}
function stubTimers(): Timers {
  const queue: Array<{ fn: () => void } | null> = [];
  vi.stubGlobal("setTimeout", (fn: () => void) => queue.push({ fn }));
  vi.stubGlobal("clearTimeout", (handle: number) => {
    if (handle >= 1 && handle <= queue.length) queue[handle - 1] = null;
  });
  return {
    pending: () => queue.filter((e) => e !== null).length,
    fire() {
      const live = queue.splice(0, queue.length).filter((e): e is { fn: () => void } => e !== null);
      for (const entry of live) entry.fn();
      return live.length;
    }
  };
}

/** The renderer's own clock, under this test's control — every animation decision is a function of it. */
interface Clock {
  advance(ms: number): void;
  now(): number;
}
function stubClock(): Clock {
  let t = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => t);
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    }
  };
}

interface PatchStats {
  frames: number;
  quads: number;
  nodes: number;
  chainMax: number;
  chainLimit: number;
  bailouts: Record<string, number>;
  source: {
    frames: number;
    quads: number;
    nodes: number;
    bailouts: { source: number; shape: number; texture: number };
  };
  transform: {
    frames: number;
    roots: number;
    commands: number;
    records: number;
    hits: number;
    chainMax: number;
    chainLimit: number;
  };
}

function patchStats(): PatchStats {
  const read = (window as unknown as { __mirrorCanvasStats?: () => { patch: PatchStats | null } }).__mirrorCanvasStats;
  if (!read) {
    throw new Error("__mirrorCanvasStats is not installed");
  }
  const patch = read().patch;
  if (!patch) {
    throw new Error("patch census is unavailable");
  }
  return patch;
}

function frameStats(): { builds: number; frames: number; paintSkip: { skipped: number } | null } {
  const read = (window as unknown as { __mirrorCanvasStats?: () => { builds: number; frames: number; paintSkip: { skipped: number } | null } }).__mirrorCanvasStats;
  if (!read) throw new Error("__mirrorCanvasStats is not installed");
  return read();
}

/** The comet's own counters — `latches` against `latchReleases` is what says a pinned stroke let go again. */
function trailStats(): { latches: number; latchReleases: number } {
  const read = (window as unknown as { __mirrorCanvasStats?: () => { trails: never } }).__mirrorCanvasStats!;
  return read().trails as unknown as { latches: number; latchReleases: number };
}

/** Everything the census says about the idle family. */
interface IdleStats {
  plans: number;
  frames: number;
  rebuilds: number;
  patched: number;
  fpsCap: number;
  displayGate: {
    admittedPassive: number;
    skippedEarly: number;
    missingPassive: number;
    admittedEarlySlack: number;
    phaseResets: number;
    minAdmittedGapMs: number | null;
    admittedGapP50Ms: number | null;
  };
}

function idleStats(): IdleStats {
  const read = (window as unknown as { __mirrorCanvasStats?: () => { idle: never } }).__mirrorCanvasStats!;
  return read().idle as unknown as IdleStats;
}

// --- scenes -----------------------------------------------------------------------------------------------------

function node(over: Record<string, unknown>): Record<string, unknown> {
  return {
    parentId: null,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } },
    visible: true,
    ...over
  };
}

function sceneOf(upserts: Record<string, unknown>[]): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: upserts.map((u) => u.id as string),
      upserts
    })!
  );
  return state;
}

/**
 * A glow (a wire-pinned ALPHA loop — the frame's patchable half) beside an animating intent GLYPH.
 *
 * Both are needed: the glow is what makes `opacitySampledIds` non-empty so the frame gets past `noSamples` at all,
 * and the glyph is the thing under test. Without the glow the frame refuses for a reason that says nothing.
 */
function glowAndGlyphScene(): MirrorState {
  const region = (x: number) => ({ position: { x, y: 0 }, size: { x: 48, y: 48 } });
  return sceneOf([
    node({ id: "Root", name: "Root", localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }),
    node({
      id: "Glow",
      parentId: "Root",
      name: "GlowVfx",
      nodeType: "Godot.TextureRect",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 900, y: 800 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 512, y: 256 } },
      fillColor: { r: 1, g: 1, b: 1, a: 1 },
      pinnedLoopAnim: "proceedGlow"
    }),
    node({
      id: "Glyph",
      parentId: "Root",
      name: "Intent",
      nodeType: "Sprite2D",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 300, y: 300 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 64, y: 64 } },
      fillColor: { r: 1, g: 1, b: 1, a: 1 },
      intentFrames: {
        animationName: "attack",
        fps: 15,
        frames: [
          { atlasPath: "res://atlases/intent_atlas.png", region: region(0), margin: null },
          { atlasPath: "res://atlases/intent_atlas.png", region: region(48), margin: null }
        ]
      }
    })
  ]);
}

/**
 * The glow beside a producer-placed COMET — an `NCardTrail` whose parent the delta sampler reads a head off.
 *
 * `parentX` moves the head between reconciles, which is what lays points down; the latch is taken on the first
 * sample and released once the history has drained, and the RELEASE is the frame this file cares about.
 */
function glowAndTrailScene(parentX: number, into?: MirrorState): MirrorState {
  const upserts = [
    node({ id: "Root", name: "Root", localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }),
    node({
      id: "Glow",
      parentId: "Root",
      name: "GlowVfx",
      nodeType: "Godot.TextureRect",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 900, y: 800 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 512, y: 256 } },
      fillColor: { r: 1, g: 1, b: 1, a: 1 },
      pinnedLoopAnim: "proceedGlow"
    }),
    node({
      id: "Card",
      parentId: "Root",
      name: "Card",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: parentX, y: 500 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 280 } }
    }),
    node({
      id: "Trail",
      parentId: "Card",
      name: "Trail",
      nodeType: "NCardTrail",
      localRect: { position: { x: 0, y: 0 }, size: { x: 4, y: 4 } }
    })
  ];
  if (into === undefined) {
    return sceneOf(upserts);
  }
  applySceneDelta(
    into,
    parseSceneDelta({ type: "scene-delta", screenType: "run", upserts: [upserts[2]] })!
  );
  return into;
}

/**
 * A combat-shaped INTENT BOB — the screen the transform tier was built for.
 *
 * `canvasIdleLoops.spec`'s own fixture: the holder under an `NIntent` scene root, which is what makes
 * `nodeAnimBinding` resolve a `bob` off the scene path. The glow rides along so a frame has an alpha sample too.
 */
function bobScene(extra: Record<string, unknown>[] = []): MirrorState {
  return sceneOf([
    node({ id: "Root", name: "Root", localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }),
    node({
      id: "Glow",
      parentId: "Root",
      name: "GlowVfx",
      nodeType: "Godot.TextureRect",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 900, y: 800 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 512, y: 256 } },
      fillColor: { r: 1, g: 1, b: 1, a: 1 },
      pinnedLoopAnim: "proceedGlow"
    }),
    node({
      id: "Intent",
      parentId: "Root",
      name: "Intent",
      nodeType: "NIntent",
      sceneFilePath: "res://scenes/combat/intent.tscn",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 600, y: 300 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 120 } }
    }),
    node({
      id: "IntentHolder",
      parentId: "Intent",
      name: "IntentHolder",
      localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 120 } }
    }),
    node({
      id: "Icon",
      parentId: "IntentHolder",
      name: "Intent",
      nodeType: "TextureRect",
      localRect: { position: { x: 0, y: 0 }, size: { x: 64, y: 64 } },
      fillColor: { r: 1, g: 1, b: 1, a: 1 }
    }),
    ...extra
  ]);
}

/**
 * A BOB WITH NO GLOW — the shape deck view actually has, and the one an alpha-shaped precondition refuses.
 *
 * Deck view's three idle plans are all transform-channel: a bob writes no alpha at all, so `opacitySampledIds` is
 * empty on every one of its animated frames. The census pair found `noSamples` 663 against `localAnim` 8 on this
 * shape, i.e. the frames the tier exists for were being turned away before either tier was asked.
 */
function bobOnlyScene(): MirrorState {
  return sceneOf([
    node({ id: "Root", name: "Root", localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }),
    node({
      id: "Intent",
      parentId: "Root",
      name: "Intent",
      nodeType: "NIntent",
      sceneFilePath: "res://scenes/combat/intent.tscn",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 600, y: 300 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 120 } }
    }),
    node({
      id: "IntentHolder",
      parentId: "Intent",
      name: "IntentHolder",
      localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 120 } }
    }),
    node({
      id: "Icon",
      parentId: "IntentHolder",
      name: "Intent",
      nodeType: "TextureRect",
      localRect: { position: { x: 0, y: 0 }, size: { x: 64, y: 64 } },
      fillColor: { r: 1, g: 1, b: 1, a: 1 }
    })
  ]);
}

/** The glow alone — a control for patching when nothing else moved. */
function glowOnlyScene(): MirrorState {
  return sceneOf([
    node({ id: "Root", name: "Root", localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } }),
    node({
      id: "Glow",
      parentId: "Root",
      name: "GlowVfx",
      nodeType: "Godot.TextureRect",
      transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 900, y: 800 } },
      localRect: { position: { x: 0, y: 0 }, size: { x: 512, y: 256 } },
      fillColor: { r: 1, g: 1, b: 1, a: 1 },
      pinnedLoopAnim: "proceedGlow"
    })
  ]);
}

// --- frame classes ------------------------------------------------------------------------------------------------

describe("the frame-level patch refusals", () => {
  let renderer: MirrorRenderer | null = null;
  let backendAtStart: ReturnType<typeof requestedStageBackend>;
  let raf: Raf;
  let timers: Timers;
  let clock: Clock;

  beforeEach(() => {
    document.body.innerHTML = "";
    backendAtStart = requestedStageBackend();
    stubWebgl2();
    vi.stubGlobal("devicePixelRatio", 1);
    raf = stubRaf();
    timers = stubTimers();
    clock = stubClock();
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

  function mount(search = "/?stage=canvas"): MirrorRenderer {
    window.history.replaceState(null, "", search);
    renderer = createMirrorRendererFor(stageAt(1920, 1080), defsEl());
    return renderer;
  }

  /**
   * Run `n` animated frames `stepMs` apart, draining BOTH wakeup paths the renderer re-arms on: the unconditional
   * rAF and the capped idle family's park timer (which is the one an idle-only screen actually books).
   */
  function runFrames(n: number, stepMs = 40): number {
    let ran = 0;
    for (let i = 0; i < n; i++) {
      clock.advance(stepMs);
      ran += timers.fire();
      ran += raf.flush();
    }
    return ran;
  }

  it("reports the fixed 30 Hz idle cadence", () => {
    const r = mount();
    r.reconcile(glowAndGlyphScene());
    expect(idleStats().fpsCap).toBe(30);
  });

  it("drops a stale passive rAF when a direct reconcile removes its only idle demand", () => {
    const r = mount();
    r.reconcile(glowOnlyScene());

    // The passive timer has already committed one rAF to the browser. Before
    // it delivers, a direct state update removes the glow; this callback no
    // longer has any animation-owned pixels to paint.
    clock.advance(17);
    timers.fire();
    expect(raf.pending()).toBe(1);
    r.reconcile(sceneOf([node({ id: "Root", name: "Root", localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } } })]));
    const before = frameStats().frames;

    raf.flush();

    expect(frameStats().frames).toBe(before);
    expect(idleStats().displayGate.missingPassive).toBe(1);
  });

  it("names a nonresident glyph source fallback, never misclassifying it as a transform", () => {
    const r = mount();
    r.reconcile(glowAndGlyphScene());
    // This fixture never supplies atlas pixels, so each source boundary must retain the conservative full-build
    // path. The glow gives the opacity arm something to do alongside the source update.
    runFrames(12);
    const patch = patchStats();
    const bails = patch.bailouts;
    expect(patch.source?.frames).toBe(0);
    expect(patch.source?.bailouts.texture).toBeGreaterThan(0);
    expect(bails.sourceTexture).toBeGreaterThan(0);
    // THE POINT OF THE SPLIT. Nothing in this scene moves a pose, so the tier that patches poses must see an empty
    // `transform` bucket — the number that used to be a glyph's and is now nobody's.
    expect(bails.transform).toBe(0);
  });

  it("keeps an empty source bucket patchable", () => {
    const r = mount();
    r.reconcile(glowAndGlyphScene());
    runFrames(12);
    const patch = patchStats();
    expect(patch.bailouts.source).toBe(0);
    expect(patch.frames).toBeGreaterThan(0);
  });

  it("refuses the frame a trail latch is WITHDRAWN on, which no live ribbon is left to shadow", () => {
    const r = mount();
    const state = glowAndTrailScene(400);
    r.reconcile(state);
    // Two more deltas lay a real point history down: the head is the card's origin, so it has to move.
    clock.advance(30);
    r.reconcile(glowAndTrailScene(520, state));
    clock.advance(30);
    r.reconcile(glowAndTrailScene(640, state));
    const latched = trailStats().latches;
    expect(latched).toBeGreaterThan(0);

    // Now let the history drain. The comet's points live 800 ms; past that the ribbon has NOTHING alive, so
    // `trails.nextDeadline` answers Infinity and the `trails` bail — the thing that used to cover this by
    // coincidence — stops firing on the very frame the latch is taken back.
    runFrames(30, 60);
    expect(trailStats().latchReleases).toBeGreaterThan(0);
    expect(patchStats().bailouts.trailLatch).toBeGreaterThan(0);
  });

  it("patches a pure alpha frame — the control every refusal above is measured against", () => {
    const r = mount();
    r.reconcile(glowOnlyScene());
    runFrames(8);
    const patch = patchStats();
    expect(patch.frames).toBeGreaterThan(0);
    expect(patch.quads).toBeGreaterThan(0);
    expect(idleStats().plans).toBe(1);
  });

  // --- the TRANSFORM tier's frame-level gate (R7 W3-T) ---------------------------------------------------------

  it("patches animated transforms", () => {
    const r = mount();
    r.reconcile(bobScene());
    runFrames(12);
    const patch = patchStats();
    expect(patch.transform.frames).toBeGreaterThan(0);
    expect(patch.bailouts.localAnim).toBe(0);
    expect(idleStats().patched).toBeGreaterThan(0);
  });

  it("does not bail `spine` without a changed quad set", () => {
    // `framePatchBail` must not answer `spine` on a bare `spine !== null`: with the registry installed on every
    // session, that would stop the transform tier from patching every animated frame.
    //
    // The gate is now `overlay.spineQuadVersion()` against its value at the build, so it fires when a still
    // actually commits or vanishes. This scene has no spine at all, so the counter never moves and the bail
    // never fires — which is exactly the claim: registry presence alone is not a reason to refuse.
    const r = mount();
    r.reconcile(bobScene());
    runFrames(12);
    const patch = patchStats();
    expect(patch.bailouts.spine).toBe(0);
    expect(patch.transform!.frames).toBeGreaterThan(0);
  });

  it("patches those same frames", () => {
    const r = mount();
    r.reconcile(bobScene());
    runFrames(12);
    const patch = patchStats();
    expect(patch.bailouts.localAnim).toBe(0);
    expect(patch.transform!.frames).toBeGreaterThan(0);
    expect(patch.transform!.roots).toBeGreaterThan(0);
    expect(patch.transform!.commands).toBeGreaterThan(0);
    // The subtraction from the number the fps cap was sized against.
    expect(idleStats().patched).toBeGreaterThan(0);
  });

  it("keeps the 15-link transform refresh for the canvas renderer", () => {
    const r = mount();
    r.reconcile(bobOnlyScene());
    runFrames(80, 40);
    const patch = patchStats();
    expect(idleStats().fpsCap).toBe(30);
    expect(patch.transform?.chainLimit).toBe(15);
    expect(patch.transform?.chainMax).toBe(15);
    expect(patch.bailouts.chain).toBeGreaterThan(0);
  });

  it("patches a bob-only frame", () => {
    const r = mount();
    r.reconcile(bobOnlyScene());
    runFrames(12);
    const patch = patchStats();
    expect(patch.transform!.frames).toBeGreaterThan(0);
    expect(patch.transform!.commands).toBeGreaterThan(0);
    expect(idleStats().patched).toBeGreaterThan(0);
  });

  it("PATCHES a WIDENED stage — the refusal that cost every maximized desktop browser its idle frames", () => {
    // R21 B2. This used to assert the opposite, and the assertion was faithful to a comment that was wrong about
    // the world: "this costs a widened stage its idle frames and nothing else" — except a maximized 1920x1080
    // browser window has a ~1878x954 content viewport (chrome eats the height), aspect 1.97, i.e. WIDENED. On
    // Firefox, same scene, only the window width changing: 295/295 frames rebuilt at 1.97, 94% patched at 1.73.
    // `listPatch.ts`'s `THE SPREAD TERM` is the algebra that closed it.
    const r = mount();
    const state = bobScene();
    r.reconcile(state);
    r.setStretch(2520 / 1920);
    r.reconcile(state);
    runFrames(12);
    const patch = patchStats();
    expect(patch.bailouts.spread).toBe(0);
    expect(patch.transform!.frames).toBeGreaterThan(0);
    expect(patch.transform!.commands).toBeGreaterThan(0);
  });

  it("keeps transform patching enabled", () => {
    // A typo must not silently reinstate a rebuild per animated frame on every widescreen client.
    const r = mount();
    const state = bobScene();
    r.reconcile(state);
    r.setStretch(2520 / 1920);
    r.reconcile(state);
    runFrames(12);
    expect(patchStats().bailouts.spread).toBe(0);
    expect(patchStats().transform!.frames).toBeGreaterThan(0);
  });

  it("keeps patching alpha on a widened stage", () => {
    const r = mount();
    const state = glowOnlyScene();
    r.reconcile(state);
    r.setStretch(2520 / 1920);
    r.reconcile(state);
    runFrames(8);
    const patch = patchStats();
    expect(patch.bailouts.spread).toBe(0);
    expect(patch.frames).toBeGreaterThan(0);
  });
});
