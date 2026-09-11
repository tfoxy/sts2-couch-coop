// R4 — THE IDLE LOOPS, WIRED: the energy orb spins and the enemy intents bob on the canvas stage.
//
// Three contracts, tested where each one lives.
//   * THE WALK owns the composition law. `pre` is a parent-space translate ahead of the node's own wire matrix
//     (so the intent HOLDER's subtree rides it, as the game's does); `post` is a node-local conjugation after it
//     (so a spin cannot orbit the design origin); and NEITHER reaches `gGame`, because the producer pinned these
//     loops at rest and a tap must send the pose the game believes in.
//   * THE SCHEDULER owns who publishes the cadence. A visible pinned loop has no endpoint, so `tweenLoop`'s own
//     honest deadline is "next frame" — which `armAnimation` books UNCONDITIONALLY. Under `loopDeadline:
//     "caller"` the loop stays silent and the renderer publishes the capped deadline instead, which is the only
//     reason an fps cap on this family is expressible at all.
//   * THE RENDERER owns resolution and sampling: which nodes have a loop, once per node identity, and what they
//     are at this frame's phase.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDrawList } from "@godot-scene-web/canvas";

import { buildDrawList, type LocalAnim } from "@/mirror/canvas/buildDrawList";
import { createTweenLoop } from "@/mirror/canvas/tweenLoop";
import { createMirrorRendererFor, __setStageBackendForTest, requestedStageBackend } from "@/mirror/rendererFactory";
import type { MirrorRenderer } from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorNode,
  type MirrorState
} from "@/mirror/sceneTree";

// --- the walk's composition law -------------------------------------------------------------------------------

function mkNode(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.TextureRect",
    showBehindParent: false,
    clipChildren: 0,
    clipContents: false,
    ninePatchMargins: null,
    font: null,
    richBoldFont: null,
    richItalicFont: null,
    richBoldItalicFont: null,
    richBoldFontSizePx: null,
    richItalicFontSizePx: null,
    richBoldItalicFontSizePx: null,
    richBoldFontSpacingPx: null,
    richItalicFontSpacingPx: null,
    richBoldItalicFontSpacingPx: null,
    textWrap: null,
    shadow: null,
    richText: false,
    shaderId: null,
    materialRef: null,
    shaderParams: null,
    textureStretchMode: null,
    textureFlipH: false,
    textureFlipV: false,
    particleSpec: null,
    particleEmitting: false,
    particleRestartEpoch: 0,
    spineSceneResPath: null,
    spineNodePath: null,
    spineAnimations: null,
    spineSkelResPath: null,
    sceneFilePath: null,
    mouseFilter: null,
    anchorLeft: null,
    anchorRight: null,
    anchorOwnerId: null,
    containerLayout: null,
    contentKey: null,
    spineCurrentAnim: null,
    spineSkin: null,
    spineMat: null,
    spinePaused: false,
    spineTrackTime: 0,
    spineLooping: true,
    pinnedLoopAnim: null,
    outline: null,
    transform: [1, 0, 0, 1, 0, 0],
    localRect: { x: 0, y: 0, width: 100, height: 40 },
    visible: true,
    focused: false,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    pivotX: 0,
    pivotY: 0,
    zIndex: null,
    textureUrl: null,
    textureRegion: null,
    textureMargin: null,
    ninePatch: false,
    modulate: null,
    selfModulate: null,
    fillColor: { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" } as never,
    range: null,
    text: null,
    intentFrames: null,
    linePoints: null,
    lineWidth: null,
    lineColor: null,
    ...over
  };
}

function walk(nodes: MirrorNode[], localAnims: Map<string, LocalAnim> | null) {
  const state = createMirrorState();
  for (const node of nodes) {
    state.nodes.set(node.id, node);
  }
  state.orderedIds = nodes.map((n) => n.id);
  state.revision = 1;
  const list = createDrawList<string>();
  const build = buildDrawList(state, list, { localAnims });
  const originOf = (id: string) => {
    const range = build.ranges.get(id)!;
    const view = list.readQuad(range.start, {
      m: new Float32Array(6),
      w: 0,
      h: 0,
      srcX: 0,
      srcY: 0,
      srcW: 0,
      srcH: 0,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
      blend: 0,
      flipH: false,
      flipV: false,
      hasColorMatrix: false,
      colorMatrix: new Float32Array(9)
    } as never);
    return [view.m[4], view.m[5]] as [number, number];
  };
  return { build, originOf };
}

const HOLDER = () => mkNode("Holder", null, { transform: [1, 0, 0, 1, 500, 300] });
const CHILD = () => mkNode("Child", "Holder", { transform: [1, 0, 0, 1, 10, 20] });

describe("the walk's idle-loop composition", () => {
  it("applies a PRE translate in the parent's space, and the subtree rides it", () => {
    const anims = new Map<string, LocalAnim>([["Holder", { pre: [1, 0, 0, 1, 0, -18], post: null }]]);
    const { originOf } = walk([HOLDER(), CHILD()], anims);
    expect(originOf("Holder")).toEqual([500, 282]);
    // The child's own matrix is untouched; it moves because it composes against a moved parent — which is
    // exactly how the game's holder carries its icon, its damage number and its emitter.
    expect(originOf("Child")).toEqual([510, 302]);
  });

  it("applies a POST matrix in the node's OWN space, so a rotation cannot orbit", () => {
    // A quarter turn about the node's box centre (50, 20): the origin swings to the far corner, and stays 100 px
    // from the centre rather than being flung by its 500,300 placement.
    const c = Math.cos(Math.PI / 2);
    const s = Math.sin(Math.PI / 2);
    const post = [c, s, -s, c, 50 - c * 50 + s * 20, 20 - s * 50 - c * 20];
    const { originOf } = walk([HOLDER()], new Map([["Holder", { pre: null, post }]]));
    const [x, y] = originOf("Holder");
    expect(Math.hypot(x - 550, y - 320)).toBeCloseTo(Math.hypot(50, 20), 6);
  });

  it("leaves gGame — the pose a tap sends — completely blind to both channels", () => {
    const anims = new Map<string, LocalAnim>([
      ["Holder", { pre: [1, 0, 0, 1, 0, -18], post: [2, 0, 0, 2, 0, 0] }]
    ]);
    const withAnim = walk([HOLDER(), CHILD()], anims).build;
    const without = walk([HOLDER(), CHILD()], null).build;
    for (const id of ["Holder", "Child"]) {
      const a = withAnim.hitEntries.find((e) => e.nodeId === id)!;
      const b = without.hitEntries.find((e) => e.nodeId === id)!;
      expect([...a.mGame]).toEqual([...b.mGame]);
    }
  });

  it("decorates a TWEEN sample rather than replacing it", () => {
    // A tween override is an absolute rendered global; a loop is what the DOM's CSS animation is over a baked
    // matrix — a decoration on whatever pose the node is drawn at.
    const anims = new Map<string, LocalAnim>([["Holder", { pre: null, post: [1, 0, 0, 1, 7, 9] }]]);
    const state = createMirrorState();
    state.nodes.set("Holder", HOLDER());
    state.orderedIds = ["Holder"];
    state.revision = 1;
    const list = createDrawList<string>();
    const build = buildDrawList(state, list, {
      localAnims: anims,
      transformOverrides: new Map([["Holder", [1, 0, 0, 1, 800, 100]]])
    });
    const entry = build.hitEntries.find((e) => e.nodeId === "Holder")!;
    expect([entry.mFinal[4], entry.mFinal[5]]).toEqual([807, 109]);
  });

  it("is absent by default — the offline gate and every pre-R4 spec build the same floats", () => {
    expect(walk([HOLDER(), CHILD()], null).originOf("Holder")).toEqual([500, 300]);
  });
});

// --- the scheduler's half -------------------------------------------------------------------------------------

describe("who owns a visible loop's cadence", () => {
  const spec = { periodMs: 2000, phaseMs: 0, anchor: "document" as const, visible: true };

  it("publishes next-frame by default, which is what every pre-R4 caller gets", () => {
    const loop = createTweenLoop({ clockOriginMs: 0 });
    loop.applyPinnedLoop("n", spec, 1000);
    expect(loop.nextDeadline(1000)).toBe(1000);
  });

  it("stays SILENT under loopDeadline: caller, so the renderer's cap can be slept on", () => {
    const loop = createTweenLoop({ clockOriginMs: 0, loopDeadline: "caller" });
    loop.applyPinnedLoop("n", spec, 1000);
    expect(loop.nextDeadline(1000)).toBe(Infinity);
  });

  it("still runs the loop under either setting — only the deadline moves", () => {
    const loop = createTweenLoop({ clockOriginMs: 0, loopDeadline: "caller" });
    loop.applyPinnedLoop("n", spec, 0);
    expect(loop.loopPhase("n", 500)).toBeCloseTo(0.25, 9);
    expect(loop.loopPhase("n", 1000)).toBeCloseTo(0.5, 9);
  });
});

// --- the renderer's half --------------------------------------------------------------------------------------

interface CanvasStats {
  builds: number;
  animFrames: number;
  schedule: { rafs: number; parks: number; parkWakeups: number; pulled: number };
  idle: {
    plans: number;
    transformLoops: number;
    alphaLoops: number;
    frames: number;
    rebuilds: number;
    fpsCap: number;
    invisible: number;
  } | null;
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

/** jsdom has no WebGL: `canvasStage.spec`'s Proxy, complete enough to drive gsw's real stage + executor. */
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

/** A combat-shaped intent: the holder under an `NIntent` scene root, with the leaves the game bobs. */
function intentScene(): MirrorState {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: ["Root", "Intent", "IntentHolder", "Icon"],
      upserts: [
        {
          id: "Root",
          parentId: null,
          name: "Root",
          nodeType: "Control",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
          visible: true
        },
        {
          id: "Intent",
          parentId: "Root",
          name: "Intent",
          nodeType: "NIntent",
          sceneFilePath: "res://scenes/combat/intent.tscn",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 600, y: 300 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 120 } },
          visible: true
        },
        {
          id: "IntentHolder",
          parentId: "Intent",
          name: "IntentHolder",
          nodeType: "Control",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 120, y: 120 } },
          visible: true
        },
        {
          id: "Icon",
          parentId: "IntentHolder",
          name: "Intent",
          nodeType: "TextureRect",
          transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
          localRect: { position: { x: 0, y: 0 }, size: { x: 64, y: 64 } },
          visible: true,
          fillColor: { r: 1, g: 1, b: 1, a: 1 }
        }
      ]
    })!
  );
  return state;
}

describe("the renderer's idle loops", () => {
  let renderer: MirrorRenderer | null = null;
  let backendAtStart: ReturnType<typeof requestedStageBackend>;

  beforeEach(() => {
    document.body.innerHTML = "";
    backendAtStart = requestedStageBackend();
    stubWebgl2();
    vi.stubGlobal("devicePixelRatio", 1);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
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

  function mount(): MirrorRenderer {
    renderer = createMirrorRendererFor(stageAt(1920, 1080), defsEl());
    return renderer;
  }

  it("resolves the intent bob off the scene path and samples it", () => {
    const r = mount();
    r.reconcile(intentScene());
    const idle = stats().idle!;
    expect(idle.plans).toBe(1);
    expect(idle.transformLoops).toBe(1);
    expect(idle.alphaLoops).toBe(0);
    expect(idle.frames).toBeGreaterThan(0);
    expect(idle.fpsCap).toBe(30);
  });

  it("finds no loop on a screen that has none", () => {
    const r = mount();
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["Root"],
        upserts: [
          {
            id: "Root",
            parentId: null,
            name: "Root",
            nodeType: "Control",
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
            visible: true,
            fillColor: { r: 0, g: 0, b: 0, a: 1 }
          }
        ]
      })!
    );
    r.reconcile(state);
    expect(stats().idle!.plans).toBe(0);
    expect(stats().idle!.frames).toBe(0);
  });

  /** A one-node screen whose only node carries a producer-pinned loop token. */
  function pinnedScene(token: string): MirrorState {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        orderedIds: ["Root", "Glow"],
        upserts: [
          {
            id: "Root",
            parentId: null,
            name: "Root",
            nodeType: "Control",
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
            visible: true
          },
          {
            id: "Glow",
            parentId: "Root",
            name: "GlowVfx",
            nodeType: "Godot.TextureRect",
            transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 900, y: 800 } },
            localRect: { position: { x: 0, y: 0 }, size: { x: 512, y: 256 } },
            visible: true,
            fillColor: { r: 1, g: 1, b: 1, a: 1 },
            pinnedLoopAnim: token
          }
        ]
      })!
    );
    return state;
  }

  it("registers a WIRE-PINNED alpha loop without a scene-path lookup", () => {
    const r = mount();
    r.reconcile(pinnedScene("proceedGlow"));
    const idle = stats().idle!;
    expect(idle.plans).toBe(1);
    expect(idle.alphaLoops).toBe(1);
    expect(idle.transformLoops).toBe(0);
  });

  it("counts the end-turn pulse in BOTH channels, because it drives both", () => {
    const r = mount();
    r.reconcile(pinnedScene("endTurnGlow"));
    const idle = stats().idle!;
    expect(idle.alphaLoops).toBe(1);
    expect(idle.transformLoops).toBe(1);
  });

  it("ignores a token from a newer producer rather than guessing at it", () => {
    const r = mount();
    r.reconcile(pinnedScene("someLoopWeHaveNeverHeardOf"));
    expect(stats().idle!.plans).toBe(0);
  });

  it("registers a glyph cycle for an animating intent", () => {
    const glyphScene = () => {
      const state = createMirrorState();
      const region = (x: number) => ({ position: { x, y: 0 }, size: { x: 48, y: 48 } });
      applySceneDelta(
        state,
        parseSceneDelta({
          type: "scene-delta",
          full: true,
          screenType: "run",
          orderedIds: ["Root", "Glyph"],
          upserts: [
            {
              id: "Root",
              parentId: null,
              name: "Root",
              nodeType: "Control",
              transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
              localRect: { position: { x: 0, y: 0 }, size: { x: 1920, y: 1080 } },
              visible: true
            },
            {
              id: "Glyph",
              parentId: "Root",
              name: "Intent",
              nodeType: "Sprite2D",
              transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 300, y: 300 } },
              localRect: { position: { x: 0, y: 0 }, size: { x: 64, y: 64 } },
              visible: true,
              intentFrames: {
                animationName: "attack",
                fps: 15,
                frames: [
                  { atlasPath: "res://atlases/intent_atlas.png", region: region(0), margin: null },
                  { atlasPath: "res://atlases/intent_atlas.png", region: region(48), margin: null }
                ]
              }
            }
          ]
        })!
      );
      return state;
    };
    const r = mount();
    r.reconcile(glyphScene());
    expect((stats() as unknown as { intents: { cycles: number } }).intents.cycles).toBe(1);
    r.dispose();
  });

  it("drops a loop whose node the delta removed", () => {
    const r = mount();
    const state = intentScene();
    r.reconcile(state);
    expect(stats().idle!.plans).toBe(1);
    applySceneDelta(
      state,
      parseSceneDelta({ type: "scene-delta", screenType: "run", removedIds: ["IntentHolder"] })!
    );
    r.reconcile(state);
    expect(stats().idle!.plans).toBe(0);
  });
});
