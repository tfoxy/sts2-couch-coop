import { EFFECTS_SUSPENDED_ATTR } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,



  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// WS-C OCCLUSION GATING. When a subtree fully covers the design stage, everything painted strictly BELOW it stops
// costing anything it doesn't have to:
//
//   • TIER 1 (opaque cover, `mouse_filter = Stop`)  → covered subtree roots go `display:none`, their wall-clock
//     animators (spine clips, intent glyphs) leave the animation loop, and gsw's shader/particle runtimes are
//     parked via `data-godot-effects-suspended`.
//   • TIER 2 (translucent scrim — what STS2's dialog backstops actually are, `#000000d9` = 0.851)  → everything
//     stays PAINTED (the scrim shows it through); only the time-driven work stops.
//   • Neither, unless the cover is PROVABLY a cover: a shader-painted fill, a texture, a partial box, a rotated
//     box, a faded ancestor chain or a low alpha all mean "not a cover" → nothing is gated.
//
// The `nodes` map is game truth and is never touched, so the input side (interactiveRects) is byte-identical with
// the gate on or off — asserted below on a covered scene.

const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

// --- fixtures -------------------------------------------------------------------------------------------------

const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const xf = (tx: number, ty: number, sx = 1, sy = 1) => ({ xAxis: { x: sx, y: 0 }, yAxis: { x: 0, y: sy }, origin: { x: tx, y: ty } });
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a, html: "" });

type Raw = Record<string, unknown>;

function node(id: string, parentId: string | null, extra: Raw = {}): Raw {
  return { id, parentId, name: id, nodeType: "Godot.Control", visible: true, ...extra };
}

// A full-stage flat-fill backdrop (the shape of every STS2 backstop: 1920×1080 ColorRect at the origin).
function backdrop(id: string, parentId: string | null, alpha: number, extra: Raw = {}): Raw {
  return node(id, parentId, {
    nodeType: "Godot.ColorRect",
    transform: xf(0, 0),
    localRect: rect(0, 0, 1920, 1080),
    fillColor: rgba(0, 0, 0, alpha),
    mouseFilter: 2,
    ...extra
  });
}

// A boxed, mouse-visible (Stop) leaf — one interactive rect, and something with real paint to hide.
function boxed(id: string, parentId: string | null, x: number, y: number, extra: Raw = {}): Raw {
  return node(id, parentId, {
    nodeType: "Godot.ColorRect",
    transform: xf(x, y),
    localRect: rect(0, 0, 100, 80),
    fillColor: rgba(1, 0, 0, 1),
    mouseFilter: 0,
    ...extra
  });
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function full(state: MirrorState, nodes: Raw[]): void {
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
}

function update(state: MirrorState, nodes: Raw[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

function el(stage: HTMLElement, id: string): HTMLElement {
  const found = stage.querySelector(`[data-node-id="${id}"]`);
  expect(found, `element ${id}`).not.toBeNull();
  return found as HTMLElement;
}

function displayOf(stage: HTMLElement, id: string): string {
  return el(stage, id).style.display;
}

function suspended(stage: HTMLElement, id: string): boolean {
  return el(stage, id).hasAttribute(EFFECTS_SUSPENDED_ATTR);
}

// Drive N reconciles from the SAME state so the engage hysteresis (OCCLUSION_ENGAGE_WALKS consecutive walks) is
// satisfied. Each pass re-upserts a node so the walk isn't a no-op.
function settle(renderer: MirrorRenderer, state: MirrorState, times = 3): void {
  for (let i = 0; i < times; i++) {
    renderer.reconcile(state);
  }
}

// --- the covered scene ----------------------------------------------------------------------------------------
//
// Game
//  ├─ World            (the "combat room": two boxed controls — what gets covered)
//  │   ├─ Enemy
//  │   └─ Card
//  ├─ Dialog           (the cover's owner)
//  │   ├─ Scrim        (the full-stage backdrop)
//  │   └─ DialogCard   (dialog content — painted ABOVE the scrim, never gated)
//  └─ Hud              (paints AFTER the dialog — above the cover, never gated)
function scene(scrimAlpha: number, scrimExtra: Raw = {}): Raw[] {
  return [
    node("Game", null, { transform: xf(0, 0), localRect: rect(0, 0, 1920, 1080) }),
    node("World", "Game"),
    boxed("Enemy", "World", 300, 300),
    boxed("Card", "World", 500, 800),
    node("Dialog", "Game"),
    backdrop("Scrim", "Dialog", scrimAlpha, scrimExtra),
    boxed("DialogCard", "Dialog", 900, 400),
    node("Hud", "Game"),
    boxed("HudButton", "Hud", 1700, 60)
  ];
}

let harnessRef: { stage: HTMLElement; renderer: MirrorRenderer } | null = null;

// This spec owns a small browser-clock model for the scheduler membership case below.  Do not use a wall-clock
// sleep there: a busy test worker can make the old timer fire before the assertion, which tests timing luck rather
// than whether the occlusion pass actually re-arms the deadline scheduler.
let schedulerClock = 0;
let schedulerTimers: { id: number; at: number; cb: () => void }[] = [];
let schedulerRafs: FrameRequestCallback[] = [];
let nextSchedulerTimerId = 1;

function runSchedulerTimers(ms: number): void {
  const end = schedulerClock + ms;
  for (;;) {
    let next = Infinity;
    for (const timer of schedulerTimers) next = Math.min(next, timer.at);
    if (next > end) break;
    schedulerClock = next;
    const due = schedulerTimers.filter((timer) => timer.at <= schedulerClock);
    schedulerTimers = schedulerTimers.filter((timer) => timer.at > schedulerClock);
    for (const timer of due) timer.cb();
  }
  schedulerClock = end;
}

function runSchedulerRaf(): void {
  const callbacks = schedulerRafs;
  schedulerRafs = [];
  for (const callback of callbacks) callback(schedulerClock);
}

beforeEach(() => {
  // The WS-B exception suite freezes DISPLAYED atlas canvases; Stage C's default placeholder is a page-crop div,
  // so pin the canvas placeholder configuration to keep that machinery's vehicle.
  loadSpineClipMock.mockReset();
  mirrorWalkStats.reset();
});

afterEach(() => {
  harnessRef?.renderer.dispose();
  harnessRef?.stage.remove();
  harnessRef = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(nodes: Raw[]): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  const h = harness();
  harnessRef = h;
  const state = createMirrorState();
  full(state, nodes);
  settle(h.renderer, state);
  return { ...h, state };
}

// --- cover detection ------------------------------------------------------------------------------------------

describe("cover detection", () => {
  it("hides everything below an OPAQUE full-stage Stop cover (tier 1) and nothing above it", () => {
    const { stage } = mount(scene(1, { mouseFilter: 0 }));

    expect(displayOf(stage, "World")).toBe("none");
    expect(suspended(stage, "World")).toBe(true);
    // The cover's own chain and everything painted above it are untouched.
    expect(displayOf(stage, "Dialog")).toBe("");
    expect(displayOf(stage, "Scrim")).toBe("");
    expect(displayOf(stage, "DialogCard")).toBe("");
    expect(displayOf(stage, "Hud")).toBe("");
    expect(suspended(stage, "Hud")).toBe(false);
    expect(mirrorWalkStats.occlusionTier).toBe(1);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(mirrorWalkStats.occlusionHiddenRoots).toBe(1);
  });

  it("keeps a TRANSLUCENT scrim's covered content PAINTED but suspended (tier 2)", () => {
    const { stage } = mount(scene(0.851)); // STS2's #000000d9 dialog backstop

    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(true);
    expect(mirrorWalkStats.occlusionTier).toBe(2);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(mirrorWalkStats.occlusionHiddenRoots).toBe(0);
  });

  it("treats an OPAQUE but non-Stop cover as tier 2 (Godot would still route input past it)", () => {
    const { stage } = mount(scene(1, { mouseFilter: 2 })); // STS2's treasure-room background

    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(true);
    expect(mirrorWalkStats.occlusionTier).toBe(2);
  });

  it("does not gate behind a low-alpha flash", () => {
    const { stage } = mount(scene(0.5));

    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(false);
    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(mirrorWalkStats.occlusionTier).toBe(0);
  });

  it("does not gate behind a PARTIAL cover", () => {
    const { stage } = mount(scene(1, { mouseFilter: 0, localRect: rect(0, 0, 1920, 900) }));

    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(false);
    expect(mirrorWalkStats.occludedRoots).toBe(0);
  });

  it("does not gate behind a SHADER-painted full-stage fill (the GameTransitionRect trap)", () => {
    // STS2 ships a 1920×1080 `#000000ff` ColorRect whose fade_transition shader renders it fully TRANSPARENT at
    // threshold 0. Trusting the fill would black out every single screen.
    const { stage } = mount(
      scene(1, { mouseFilter: 0, shader: { resourcePath: "res://shaders/fade_transition.gdshader" } })
    );

    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(false);
    expect(mirrorWalkStats.occludedRoots).toBe(0);
  });

  it("does not gate behind a TEXTURE-painted backdrop (a PNG's alpha is unknowable client-side)", () => {
    const nodes = scene(1, { mouseFilter: 0 });
    const scrim = nodes.find((n) => n.id === "Scrim")!;
    delete scrim.fillColor;
    scrim.texture = { resourcePath: "res://images/bg.png" };
    const { stage } = mount(nodes);

    expect(displayOf(stage, "World")).toBe("");
    expect(mirrorWalkStats.occludedRoots).toBe(0);
  });

  it("does not gate behind a ROTATED cover (its AABB would over-claim coverage)", () => {
    const nodes = scene(1, { mouseFilter: 0 });
    const scrim = nodes.find((n) => n.id === "Scrim")!;
    scrim.transform = { xAxis: { x: 0.7, y: 0.7 }, yAxis: { x: -0.7, y: 0.7 }, origin: { x: 0, y: 0 } };
    const { stage } = mount(nodes);

    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(displayOf(stage, "World")).toBe("");
  });

  it("does not gate behind a cover whose ANCESTOR is invisible (a closed dialog)", () => {
    const nodes = scene(1, { mouseFilter: 0 });
    nodes.find((n) => n.id === "Dialog")!.visible = false;
    const { stage } = mount(nodes);

    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(displayOf(stage, "World")).toBe("");
  });

  it("composes the ANCESTOR alpha chain — a half-faded dialog is not a cover", () => {
    const nodes = scene(1, { mouseFilter: 0 });
    nodes.find((n) => n.id === "Dialog")!.modulate = rgba(1, 1, 1, 0.5);
    const { stage } = mount(nodes);

    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(displayOf(stage, "World")).toBe("");
  });

  it("re-evaluates the ancestor alpha even when only the ANCESTOR is re-upserted", () => {
    // The walk's skip-clean gate is context-based and the context carries NO opacity, so a faded ancestor never
    // re-visits its backdrop descendant. The pass therefore re-derives the composed alpha from live node data.
    const nodes = scene(1, { mouseFilter: 0 });
    const { stage, renderer, state } = mount(nodes);
    expect(displayOf(stage, "World")).toBe("none");

    update(state, [node("Dialog", "Game", { modulate: rgba(1, 1, 1, 0.4) })]);
    renderer.reconcile(state);
    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(false);
  });
});

// --- paint order ----------------------------------------------------------------------------------------------

describe("paint-order gating", () => {
  it("gates only the SIBLINGS that paint before the cover's chain", () => {
    const { stage } = mount(scene(1, { mouseFilter: 0 }));
    // World is before Dialog; Hud is after it. DialogCard is a later sibling of the Scrim itself.
    expect(displayOf(stage, "World")).toBe("none");
    expect(displayOf(stage, "Hud")).toBe("");
    expect(displayOf(stage, "DialogCard")).toBe("");
  });

  it("gates a later sibling that draws BEHIND the parent (show_behind_parent)", () => {
    const nodes = scene(1, { mouseFilter: 0 });
    // A "Behind" root listed AFTER the Dialog but drawn behind Game's own paint → it paints below the cover.
    nodes.push(node("Behind", "Game", { showBehindParent: true }), boxed("BehindArt", "Behind", 10, 10));
    const { stage } = mount(nodes);

    expect(displayOf(stage, "Behind")).toBe("none");
    expect(displayOf(stage, "Hud")).toBe("");
  });

  it("does not gate a behind-parent sibling when the cover's own chain node is itself behind-parent", () => {
    const nodes = scene(1, { mouseFilter: 0 });
    nodes.find((n) => n.id === "Dialog")!.showBehindParent = true;
    nodes.push(node("Behind", "Game", { showBehindParent: true }), boxed("BehindArt", "Behind", 10, 10));
    const { stage } = mount(nodes);

    // "Behind" is listed after "Dialog" and both are behind-parent → it paints ABOVE the cover.
    expect(displayOf(stage, "Behind")).toBe("");
    // "World" is a NORMAL child listed before it, but normal children paint after every behind-parent one, so a
    // behind-parent cover cannot cover it either.
    expect(displayOf(stage, "World")).toBe("");
  });

  it("drops a gated root nested inside an equally-gated one (deck scrim under the card-detail cover)", () => {
    // Game ▸ [World, Inner ▸ [InnerScrim(0.851), InnerContent], Dialog ▸ [Scrim(0.9), DialogCard], Hud]
    const nodes: Raw[] = [
      node("Game", null, { transform: xf(0, 0), localRect: rect(0, 0, 1920, 1080) }),
      node("World", "Game"),
      boxed("Enemy", "World", 300, 300),
      node("Inner", "Game"),
      backdrop("InnerScrim", "Inner", 0.851),
      boxed("InnerContent", "Inner", 200, 200),
      node("Dialog", "Game"),
      backdrop("Scrim", "Dialog", 0.902),
      boxed("DialogCard", "Dialog", 900, 400),
      node("Hud", "Game"),
      boxed("HudButton", "Hud", 1700, 60)
    ];
    const { stage } = mount(nodes);

    // The outer (card-detail) cover gates World + Inner; the inner scrim's own claim on World is redundant.
    expect(suspended(stage, "World")).toBe(true);
    expect(suspended(stage, "Inner")).toBe(true);
    expect(suspended(stage, "Hud")).toBe(false);
    expect(mirrorWalkStats.occludedRoots).toBe(2);
  });
});

// --- tier transitions -----------------------------------------------------------------------------------------

describe("tier transitions", () => {
  it("none → tier 2 → tier 1 → reveal", () => {
    const nodes = scene(0);
    const { stage, renderer, state } = mount(nodes);
    expect(mirrorWalkStats.occlusionTier).toBe(0);

    // Fade the scrim in to a translucent cover.
    update(state, [backdrop("Scrim", "Dialog", 0.851)]);
    settle(renderer, state);
    expect(mirrorWalkStats.occlusionTier).toBe(2);
    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(true);

    // Turn it opaque + Stop → tier 1.
    update(state, [backdrop("Scrim", "Dialog", 1, { mouseFilter: 0 })]);
    settle(renderer, state);
    expect(mirrorWalkStats.occlusionTier).toBe(1);
    expect(displayOf(stage, "World")).toBe("none");

    // Close the dialog → immediate, full reveal.
    update(state, [node("Dialog", "Game", { visible: false })]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(false);
  });

  it("downgrades tier 1 → tier 2 IMMEDIATELY (weakening a gate only restores paint)", () => {
    const { stage, renderer, state } = mount(scene(1, { mouseFilter: 0 }));
    expect(displayOf(stage, "World")).toBe("none");

    update(state, [backdrop("Scrim", "Dialog", 0.851)]);
    renderer.reconcile(state); // ONE walk, no hysteresis wait
    expect(displayOf(stage, "World")).toBe("");
    expect(suspended(stage, "World")).toBe(true);
  });

  it("keeps the gate correct when one cover REPLACES another in the same walk", () => {
    // The deck dialog's scrim is replaced by the card-detail screen's own (deeper, later-painting) cover.
    const nodes = scene(0.851);
    const { stage, renderer, state } = mount(nodes);
    expect(suspended(stage, "World")).toBe(true);
    expect(suspended(stage, "Hud")).toBe(false);

    // The first cover goes away and a NEW one appears under Hud, in one delta.
    update(state, [
      backdrop("Scrim", "Dialog", 0),
      backdrop("HudScrim", "Hud", 0.902),
      boxed("HudButton", "Hud", 1700, 60)
    ]);
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        orderedIds: ["Game", "World", "Enemy", "Card", "Dialog", "Scrim", "DialogCard", "Hud", "HudScrim", "HudButton"]
      })!
    );
    settle(renderer, state);

    // The new cover is deeper in paint order, so it gates the Dialog too.
    expect(suspended(stage, "World")).toBe(true);
    expect(suspended(stage, "Dialog")).toBe(true);
    expect(suspended(stage, "HudButton")).toBe(false);
  });
});

// --- hysteresis -----------------------------------------------------------------------------------------------

describe("hysteresis", () => {
  it("engages only after the cover has been stable for several walks", () => {
    const h = harness();
    harnessRef = h;
    const state = createMirrorState();
    full(state, scene(1, { mouseFilter: 0 }));

    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(0); // walk 1 — pending
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(0); // walk 2 — pending
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(1); // walk 3 — engaged
  });

  it("never engages for a cover that only flickers", () => {
    const h = harness();
    harnessRef = h;
    const state = createMirrorState();
    full(state, scene(1, { mouseFilter: 0 }));

    for (let i = 0; i < 8; i++) {
      update(state, [backdrop("Scrim", "Dialog", i % 2 === 0 ? 1 : 0.2, { mouseFilter: 0 })]);
      h.renderer.reconcile(state);
      expect(mirrorWalkStats.occludedRoots).toBe(0);
    }
  });

  it("does not engage while the cover's own opacity tween is still running", () => {
    const h = harness();
    harnessRef = h;
    const state = createMirrorState();
    full(state, scene(1, { mouseFilter: 0 }));
    // Arm a fade-in on the cover: while it is pinned, its settled alpha isn't known yet.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        hints: [{ targetId: "Scrim", property: "modulate:a", durationMs: 5000, endOpacity: 1, group: "open" }]
      })!
    );
    settle(h.renderer, state, 5);
    expect(mirrorWalkStats.occludedRoots).toBe(0);
  });
});

// --- animators ------------------------------------------------------------------------------------------------

function fakeClip(): LoadedSpineClip {
  const frames = [0, 1, 2, 3].map((i) => ({
    index: i,
    offsetX: 0,
    offsetY: 0,
    width: 10,
    height: 10,
    durationMs: 33,
    startMs: i * 33,
    png: new Uint8Array(),
    bitmap: { id: `f${i}` } as unknown as ImageBitmap
  }));
  return {
    canvasWidth: 100,
    canvasHeight: 100,
    totalDurationMs: 132,
    localX: 0,
    localY: 0,
    localWidth: 100,
    localHeight: 100,
    frames,
    stillUrl: null,
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
}

const ATLAS = "res://atlases/intent_atlas.png";

function intentNode(id: string, parentId: string): Raw {
  return node(id, parentId, {
    nodeType: "Sprite2D",
    transform: xf(100, 100),
    localRect: rect(0, 0, 64, 64),
    intentFrames: {
      animationName: "attack",
      fps: 15,
      frames: [
        { atlasPath: ATLAS, region: rect(0, 0, 48, 48) },
        { atlasPath: ATLAS, region: rect(48, 0, 48, 48) },
        { atlasPath: ATLAS, region: rect(96, 0, 48, 48) }
      ]
    }
  });
}

function spineNode(id: string, parentId: string): Raw {
  return node(id, parentId, {
    nodeType: "SpineSprite",
    transform: xf(960, 540),
    spine: { sceneResPath: `res://scenes/enemies/${id}.tscn`, nodePath: "Visuals/SpineSprite", animations: ["idle"] },
    spineCurrentAnim: "idle",
    spineTrackTime: 0
  });
}

describe("wall-clock animators under a cover", () => {
  it("parks the covered spine + intent glyphs and re-arms them on reveal", async () => {
    loadSpineClipMock.mockResolvedValue(fakeClip());
    const h = harness();
    harnessRef = h;
    const state = createMirrorState();
    const nodes = scene(0.851);
    nodes.splice(4, 0, spineNode("Boss", "World"), intentNode("Intent", "World"));
    full(state, nodes);
    h.renderer.reconcile(state);
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    // Both animators armed (the intent glyph always, the spine once its clip resolved).
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(0);

    settle(h.renderer, state);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(2);

    // Reveal → both come back.
    update(state, [backdrop("Scrim", "Dialog", 0)]);
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(0);
  });

  it("re-arms the scheduler when the gate changes membership", async () => {
    schedulerClock = 0;
    schedulerTimers = [];
    schedulerRafs = [];
    nextSchedulerTimerId = 1;
    vi.spyOn(performance, "now").mockImplementation(() => schedulerClock);
    vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
      const id = nextSchedulerTimerId++;
      schedulerTimers.push({ id, at: schedulerClock + (ms ?? 0), cb });
      return id;
    });
    vi.stubGlobal("clearTimeout", (id: number) => {
      schedulerTimers = schedulerTimers.filter((timer) => timer.id !== id);
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      schedulerRafs.push(cb);
      return schedulerRafs.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      schedulerRafs = [];
    });
    loadSpineClipMock.mockResolvedValue(fakeClip());
    const h = harness();
    harnessRef = h;
    const state = createMirrorState();
    const nodes = scene(0.851);
    nodes.splice(4, 0, spineNode("Boss", "World"));
    full(state, nodes);
    h.renderer.reconcile(state);
    // The mocked fetch has one promise continuation; yielding it is deterministic and never polls or sleeps.
    await Promise.resolve();
    settle(h.renderer, state);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(1);

    // A parked clip must not wake the animation loop. (The occlusion runtime may still own its independent
    // 120ms canvas-freeze drain timer, hence we observe rAF/wakeups rather than asserting no timers at all.)
    const before = mirrorWalkStats.tickWakeups;
    runSchedulerTimers(1000);
    expect(schedulerRafs).toHaveLength(0);
    expect(mirrorWalkStats.tickWakeups).toBe(before);

    // Keep the cover alive but move Boss above it. This changes only occlusion membership, so it proves the
    // occlusion animator synchronization re-arms the scheduler rather than a new clip mount doing it incidentally.
    const moved = scene(0.851);
    moved.push(spineNode("Boss", "Hud"));
    full(state, moved);
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(0);
    expect(schedulerTimers).toHaveLength(1);

    runSchedulerTimers(1000);
    expect(schedulerRafs).toHaveLength(1);
    runSchedulerRaf();
    expect(mirrorWalkStats.tickWakeups).toBe(before + 1);
  });

  it("rechecks animator ancestry when a still-live gate loses its descendant", async () => {
    loadSpineClipMock.mockResolvedValue(fakeClip());
    const h = harness();
    harnessRef = h;
    const state = createMirrorState();
    const nodes = scene(0.851);
    nodes.push(spineNode("Boss", "World"));
    full(state, nodes);
    h.renderer.reconcile(state);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    settle(h.renderer, state);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(1);

    // The scrim keeps World gated, but Boss now paints under Hud, which is above that scrim. A cached `true`
    // ancestry answer from the previous pass must not strand its clip in the parked set.
    const moved = scene(0.851);
    moved.push(spineNode("Boss", "Hud"));
    full(state, moved);
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(0);
  });

  it("does not resurrect a parked clip whose node lost its spine layer", async () => {
    loadSpineClipMock.mockResolvedValue(fakeClip());
    const h = harness();
    harnessRef = h;
    const state = createMirrorState();
    const nodes = scene(0.851);
    nodes.splice(4, 0, spineNode("Boss", "World"));
    full(state, nodes);
    h.renderer.reconcile(state);
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    settle(h.renderer, state);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(1);

    // The node stops being a spine node while parked, THEN the cover goes away.
    update(state, [node("Boss", "World", { nodeType: "Godot.Control", transform: xf(960, 540) })]);
    h.renderer.reconcile(state);
    update(state, [backdrop("Scrim", "Dialog", 0)]);
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occlusionSuspendedAnimators).toBe(0);
  });
});

// --- current occlusion and input behavior --------------------------------------------------------------------

describe("occlusion behavior", () => {
  it("keeps a node's OWN visibility authoritative through a gate + reveal cycle", () => {
    // R10-PERF5 WS-1: Enemy starts VISIBLE and is hidden by a later delta, rather than being hidden at the
    // keyframe. A hidden-at-keyframe node is dormant (never built at all, so there is no `display` to assert),
    // while a node hidden AFTER it was
    // built keeps its element, which is the case this spec is about (own-visibility vs the occlusion gate).
    const { stage, renderer, state } = mount(scene(1, { mouseFilter: 0 }));
    update(state, [boxed("Enemy", "World", 300, 300, { visible: false })]);
    settle(renderer, state);
    expect(displayOf(stage, "World")).toBe("none");
    expect(displayOf(stage, "Enemy")).toBe("none");

    update(state, [backdrop("Scrim", "Dialog", 0)]);
    renderer.reconcile(state);
    expect(displayOf(stage, "World")).toBe("");
    expect(displayOf(stage, "Enemy")).toBe("none"); // still hidden by its own flag
  });
});

describe("input-side invariance", () => {
  it("keeps interactive rects available while the current gate is engaged", () => {
    const nodes = scene(1, { mouseFilter: 0 });
    const current = harness();
    harnessRef = current;
    const state = createMirrorState();
    full(state, nodes);
    settle(current.renderer, state);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(displayOf(current.stage, "World")).toBe("none");
    const rects = current.renderer.interactiveRects().map((r) => ({ ...r, transform: [...r.transform] }));

    // Every covered control still reports its box: interactive rects come from the `nodes` map (game truth), never
    // from what is painted.
    expect(rects.map((r) => r.id)).toContain("Enemy");
  });

  it("leaves the view-scale input registry untouched", () => {
    const { renderer } = mount(scene(1, { mouseFilter: 0 }));
    expect(renderer.viewScaleInputStamps()).toEqual([]);
  });

  it("keeps geometry caches coherent while gated", () => {
    // The gate writes only `el.style.display` + one attribute, both DIRECTLY on the element (never through
    // `record.style`, the one style path that feeds the epoch). So the whole WS-A O(delta) machine — the epoch
    // counter, the view-scale pass run/skip split, and the interactive-rect rebuild count stay coherent over the
    // same delta sequence.
    const nodes = scene(1, { mouseFilter: 0 });
    const drive = (): { epoch: number; runs: number; skips: number; rebuilds: number } => {
      const h = harness();
      const state = createMirrorState();
      full(state, nodes);
      settle(h.renderer, state, 4);
      update(state, [boxed("Enemy", "World", 320, 300)]); // a real geometry move
      h.renderer.reconcile(state);
      update(state, [boxed("Enemy", "World", 320, 300, { fillColor: rgba(0, 1, 0, 1) })]); // cosmetic only
      h.renderer.reconcile(state);
      h.renderer.interactiveRects();
      const out = {
        epoch: mirrorWalkStats.geomEpoch,
        runs: mirrorWalkStats.geomPassRuns,
        skips: mirrorWalkStats.geomPassSkips,
        rebuilds: mirrorWalkStats.interactiveRectRebuilds
      };
      h.renderer.dispose();
      h.stage.remove();
      return out;
    };
    mirrorWalkStats.reset();
    const current = drive();
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(current.epoch).toBeGreaterThan(0);
    expect(current.runs).toBeGreaterThan(0);
    expect(current.rebuilds).toBeGreaterThan(0);
  });
});

// R10-PERF6 WS-B — the overlay-BACKSTOP exception and the canvas de-promotion that rides it (full coverage lives in
// backstopCover.spec.ts). What belongs HERE is that neither of them may weaken a WS-C invariant: the generic cover
// rules are unchanged for every node that isn't one of the three named backstops, and the input side stays
// byte-identical while a cover is engaged AND canvases are de-promoted under it.
describe("overlay-backstop exception (WS-B) against the WS-C invariants", () => {
  it("leaves the GENERIC cover verdicts alone (the exception is name-keyed, and nothing here is named)", () => {
    // Every other case in this file runs with the setting at its default ON, so the whole suite above is already
    // the regression gate; this states it outright for the one number the exception publishes.
    mount(scene(0.851));
    expect(mirrorWalkStats.occlusionTier).toBe(2);
    expect(mirrorWalkStats.occlusionBackstopCovers).toBe(0);
  });

});

// R10-PERF5 WS-1 — dormancy interaction. A hidden sibling of the covered content builds no element, so it can be
// neither a cover candidate nor a GATED root: the gate's bookkeeping must count only roots it actually applied,
// or a subtree revealed later under the same cover would be skipped forever (`applied === tier`).
describe("dormant subtrees and the gate", () => {
  it("never counts an unbuilt (dormant) subtree as a gated root, and gates it once revealed", () => {
    const nodes = scene(1, { mouseFilter: 0 });
    nodes.splice(4, 0, node("Closed", "Game", { visible: false }), boxed("ClosedItem", "Closed", 10, 10));
    const { stage, renderer, state } = mount(nodes);

    expect(displayOf(stage, "World")).toBe("none"); // the real cover still engages
    expect(stage.querySelector('[data-node-id="Closed"]')).toBeNull();
    expect(stage.querySelector('[data-node-id="ClosedItem"]')).toBeNull();
    // Gauge honesty: exactly the roots with elements — `World` (and nothing for the two unbuilt nodes).
    expect(mirrorWalkStats.occludedRoots).toBe(1);

    update(state, [node("Closed", "Game", { visible: true })]);
    settle(renderer, state, 5); // the gate re-engages through the normal hysteresis now that an element exists
    expect(displayOf(stage, "Closed")).toBe("none");
    expect(mirrorWalkStats.occludedRoots).toBe(2);
  });
});
