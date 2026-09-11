import { EFFECTS_SUSPENDED_ATTR } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backstopCoverPath,
  createMirrorRenderer,
  mirrorWalkStats,

  __setCanvasSnapshotSourceForTest,


  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { __resetAtlasCacheForTest, __setAtlasPageSizeForTest } from "@/mirror/atlasBaker";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";

// R10-PERF6 WS-B — THE OVERLAY-BACKSTOP EXCEPTION. Two halves of one feature, both driven by the occlusion pass:
//
//   1. THRESHOLD. STS2's overlay scrims are `#000000d9` (0.851) ColorRects, but LIVE three of them also carry a
//      `d9` MODULATE while their screen is open — composed 0.724, just under the generic COVER_MIN_ALPHA of 0.75,
//      so opening the map over a live combat gated nothing at all. Those three nodes (and ONLY those three,
//      matched on name + parent name) qualify at 0.70 instead. They stay TRANSLUCENT: tier 2, content still
//      painted, only the time-driven work stopped.
//   2. DE-PROMOTION. A tier-2 cover suspends the animators, which makes every <canvas> under it static — but a
//      canvas is an unconditionally promoted composited layer whether it changes or not, and that layer tree is
//      the entire measured cost. So each such canvas is swapped for a still <img> of its own pixels and
//      `display:none`d, and handed back the moment anything invalidates the still.
//
// jsdom can neither encode a canvas nor decode a blob, so the snapshot step is driven through
// `__setCanvasSnapshotSourceForTest` — the seam that stands in for a completed encode+decode, mirroring
// atlasBaker's `__publishRegionBlobForTest`.

const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

type Raw = Record<string, unknown>;

const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a, html: "" });

function node(id: string, parentId: string | null, name: string, extra: Raw = {}): Raw {
  return { id, parentId, name, nodeType: "Godot.Control", visible: true, ...extra };
}

// One of the game's full-stage backstops: a 1920×1080 flat-fill ColorRect. `fill` is the ColorRect colour's alpha
// and `mod` the node's own modulate alpha — LIVE they multiply to 0.851 × 0.851 = 0.724.
function backstop(id: string, parentId: string, name: string, fill: number, mod = 1): Raw {
  return node(id, parentId, name, {
    nodeType: "Godot.ColorRect",
    transform: xf(0, 0),
    localRect: rect(0, 0, 1920, 1080),
    fillColor: rgba(0, 0, 0, fill),
    modulate: rgba(1, 1, 1, mod),
    mouseFilter: 2
  });
}

// An atlas SPRITE: paints through `canvas.mirror-atlas-canvas` here, because jsdom can never bake a region blob.
function sprite(id: string, parentId: string, x: number, extra: Raw = {}): Raw {
  return node(id, parentId, id, {
    nodeType: "Godot.TextureRect",
    transform: xf(x, 100),
    localRect: rect(0, 0, 48, 48),
    texture: { resourcePath: "res://images/atlas.png", resourceType: "Texture2D" },
    textureRegion: { position: { x: 4, y: 8 }, size: { x: 48, y: 48 } },
    ...extra
  });
}

// The live shape: Game ▸ [RoomContainer(the covered room), GlobalUi ▸ [OverlayScreensContainer, MapScreen ▸
// [Backstop, TheMap], TopBar]]. TopBar is listed AFTER MapScreen, so it paints above the cover and is never gated.
function liveScene(coverName: string, coverParent: string, fill: number, mod: number): Raw[] {
  return [
    node("Game", null, "Game", { transform: xf(0, 0), localRect: rect(0, 0, 1920, 1080) }),
    node("Room", "Game", "RoomContainer"),
    sprite("Icon", "Room", 300),
    node("GlobalUi", "Game", "GlobalUi"),
    node("Screen", "GlobalUi", coverParent),
    backstop("Cover", "Screen", coverName, fill, mod),
    node("ScreenContent", "Screen", "TheMap"),
    node("TopBar", "GlobalUi", "TopBar"),
    sprite("TopIcon", "TopBar", 1700)
  ];
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

function settle(renderer: MirrorRenderer, state: MirrorState, times = 3): void {
  for (let i = 0; i < times; i++) {
    renderer.reconcile(state);
  }
}

// The freeze drain is debounced off the reveal frame (FREEZE_IDLE_MS = 120ms) and the idle hatchery is not
// (HATCH_IDLE_MS = 200ms), so this window drains snapshots without letting the hatchery mutate the DOM mid-test.
const drainFreeze = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

let harnessRef: { stage: HTMLElement; renderer: MirrorRenderer } | null = null;

function mount(nodes: Raw[]): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  const h = harness();
  harnessRef = h;
  const state = createMirrorState();
  full(state, nodes);
  settle(h.renderer, state);
  return { ...h, state };
}

beforeEach(() => {
  // This suite exercises the tier-2 CANVAS de-promotion machinery. The current path chooses a canvas only for an
  // oversized decoded atlas page, so seed that real decision input rather than restoring the retired placeholder valve.
  __resetAtlasCacheForTest();
  __setAtlasPageSizeForTest("/res/images/atlas.png", { width: 3000, height: 3000 });
  mirrorSettings.backstopOcclusion = true;
  loadSpineClipMock.mockReset();
  mirrorWalkStats.reset();
  // jsdom has no 2D context; the canvas paint paths only need the calls to not throw.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn()
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  harnessRef?.renderer.dispose();
  harnessRef?.stage.remove();
  harnessRef = null;
  document.body.innerHTML = "";
  __setCanvasSnapshotSourceForTest(null);
  __resetAtlasCacheForTest();
  mirrorSettings.backstopOcclusion = true;
  vi.restoreAllMocks();
});

// --- the predicate --------------------------------------------------------------------------------------------

describe("backstopCoverPath", () => {
  it("matches exactly the three overlay backstops, on name AND parent name", () => {
    expect(backstopCoverPath("Backstop", "MapScreen")).toBe("MapScreen/Backstop");
    expect(backstopCoverPath("CapstoneBackstop", "CapstoneScreenContainer")).toBe(
      "CapstoneScreenContainer/CapstoneBackstop"
    );
    expect(backstopCoverPath("OverlayBackstop", "OverlayScreensContainer")).toBe(
      "OverlayScreensContainer/OverlayBackstop"
    );
  });

  it("rejects every OTHER backstop-named node in the live tree", () => {
    // All of these exist in the recordings, all are 1920×1080 flat fills, and none of them is an overlay screen's
    // scrim: gating behind them at 0.70 would gate the combat room while the player is aiming a card
    // (SelectModeBackstop, `#000000bf` = 0.749), or behind a pause menu / a treasure-room fight prompt.
    expect(backstopCoverPath("Backstop", "ModalContainer")).toBeNull();
    expect(backstopCoverPath("SelectModeBackstop", "Hand")).toBeNull();
    expect(backstopCoverPath("Backstop", "PauseMenu")).toBeNull();
    expect(backstopCoverPath("FightBackstop", "TreasureRoom")).toBeNull();
    expect(backstopCoverPath("Backstop", "InspectCardScreen")).toBeNull();
    expect(backstopCoverPath("Backstop", "InspectRelicScreen")).toBeNull();
  });

  it("needs the PAIR — a right name under the wrong parent is not a match", () => {
    expect(backstopCoverPath("CapstoneBackstop", "MapScreen")).toBeNull();
    expect(backstopCoverPath("Backstop", "CapstoneScreenContainer")).toBeNull();
    expect(backstopCoverPath("OverlayBackstop", "MapScreen")).toBeNull();
  });

  it("is null-safe (a root node has no parent; a producer node can have an empty name)", () => {
    expect(backstopCoverPath("Backstop", null)).toBeNull();
    expect(backstopCoverPath(null, "MapScreen")).toBeNull();
    expect(backstopCoverPath("", "")).toBeNull();
    expect(backstopCoverPath(undefined, undefined)).toBeNull();
  });
});

// --- piece 1: the threshold -----------------------------------------------------------------------------------

describe("live-alpha backstop covers", () => {
  it("engages TIER 2 behind the live map backstop (0.851 fill × 0.851 modulate = 0.724)", () => {
    const { stage } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));

    expect(mirrorWalkStats.occlusionBackstopCovers).toBe(1);
    expect(mirrorWalkStats.occlusionTier).toBe(2);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(mirrorWalkStats.occlusionHiddenRoots).toBe(0);
    // TRANSLUCENT: the room keeps painting through the scrim — this is not tier 1 in disguise.
    expect(el(stage, "Room").style.display).toBe("");
    expect(el(stage, "Room").hasAttribute(EFFECTS_SUSPENDED_ATTR)).toBe(true);
    // Everything painted above the cover is untouched.
    expect(el(stage, "TopBar").hasAttribute(EFFECTS_SUSPENDED_ATTR)).toBe(false);
    expect(el(stage, "Screen").hasAttribute(EFFECTS_SUSPENDED_ATTR)).toBe(false);
  });

  it("gates NOTHING at the same alpha with the setting off — the switch is what moves the floor", () => {
    mirrorSettings.backstopOcclusion = false;
    mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));

    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(mirrorWalkStats.occlusionTier).toBe(0);
    expect(mirrorWalkStats.occlusionBackstopCovers).toBe(0);
  });

  it("does the same for the capstone (deck / card-grid) and overlay (reward) backstops", () => {
    for (const [name, parent] of [
      ["CapstoneBackstop", "CapstoneScreenContainer"],
      ["OverlayBackstop", "OverlayScreensContainer"]
    ] as const) {
      mirrorWalkStats.reset();
      const h = mount(liveScene(name, parent, 0.851, 0.851));
      expect(mirrorWalkStats.occlusionTier, `${parent}/${name}`).toBe(2);
      expect(mirrorWalkStats.occlusionBackstopCovers, `${parent}/${name}`).toBe(1);
      h.renderer.dispose();
      h.stage.remove();
      harnessRef = null;
      document.body.innerHTML = "";
    }
  });

  it("does NOT lower the floor for a full-stage scrim that is not one of the three", () => {
    // The hand's SelectModeBackstop shape: same box, same kind of fill, composed 0.724 — must stay ungated.
    mount(liveScene("SelectModeBackstop", "Hand", 0.851, 0.851));

    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(mirrorWalkStats.occlusionBackstopCovers).toBe(0);
  });

  it("leaves the GENERIC 0.75 behaviour exactly as it was, with the setting on or off", () => {
    for (const on of [true, false]) {
      mirrorSettings.backstopOcclusion = on;
      mirrorWalkStats.reset();
      // 0.851 composed (an UNMODULATED backstop): already a cover before this round, under any name.
      const h = mount(liveScene("SelectModeBackstop", "Hand", 0.851, 1));
      expect(mirrorWalkStats.occlusionTier, `generic cover, setting ${on}`).toBe(2);
      expect(mirrorWalkStats.occlusionBackstopCovers, `generic cover, setting ${on}`).toBe(0);
      h.renderer.dispose();
      h.stage.remove();
      harnessRef = null;
      document.body.innerHTML = "";
    }
  });

  it("stays BELOW the new floor for a genuine flash (0.6) — the exception is 0.70, not 'anything'", () => {
    mount(liveScene("Backstop", "MapScreen", 0.851, 0.7)); // 0.596

    expect(mirrorWalkStats.occludedRoots).toBe(0);
  });

  it("can never reach TIER 1 through the exception (a translucent cover is still translucent)", () => {
    const nodes = liveScene("Backstop", "MapScreen", 0.851, 0.851);
    // Even with Godot's input stop, 0.724 is nowhere near COVER_OPAQUE_ALPHA.
    (nodes.find((n) => n.id === "Cover") as Raw).mouseFilter = 0;
    const { stage } = mount(nodes);

    expect(mirrorWalkStats.occlusionTier).toBe(2);
    expect(el(stage, "Room").style.display).toBe("");
  });

  it("keeps the 3-walk engage hysteresis", () => {
    const h = harness();
    harnessRef = h;
    const state = createMirrorState();
    full(state, liveScene("Backstop", "MapScreen", 0.851, 0.851));

    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(0);
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(0);
    h.renderer.reconcile(state);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
  });

  it("releases the gate on the walk the setting is turned off", () => {
    const { stage, renderer, state } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    expect(el(stage, "Room").hasAttribute(EFFECTS_SUSPENDED_ATTR)).toBe(true);

    // MirrorView forces a FULL walk on the flip (the pre-filter membership is decided inside `visit`).
    mirrorSettings.backstopOcclusion = false;
    renderer.reconcile(state, { forceTextures: true, reason: "occlusion" });
    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(mirrorWalkStats.occlusionBackstopCovers).toBe(0);
    expect(el(stage, "Room").hasAttribute(EFFECTS_SUSPENDED_ATTR)).toBe(false);
  });

  it("works when the backstop only APPEARS later (a dormant screen revealing)", () => {
    // R10-PERF5 WS-1: a hidden MapScreen builds no DOM at all, so its Backstop is not even a cover CANDIDATE
    // until the reveal walk visits it. The gate must then engage through the normal hysteresis.
    const nodes = liveScene("Backstop", "MapScreen", 0.851, 0.851);
    (nodes.find((n) => n.id === "Screen") as Raw).visible = false;
    const { stage, renderer, state } = mount(nodes);
    expect(stage.querySelector('[data-node-id="Cover"]')).toBeNull();
    expect(mirrorWalkStats.occludedRoots).toBe(0);

    update(state, [node("Screen", "GlobalUi", "MapScreen", { visible: true })]);
    settle(renderer, state, 4);
    expect(mirrorWalkStats.occlusionBackstopCovers).toBe(1);
    expect(mirrorWalkStats.occludedRoots).toBe(1);
    expect(el(stage, "Room").hasAttribute(EFFECTS_SUSPENDED_ATTR)).toBe(true);
  });

});

// --- piece 2: canvas de-promotion -----------------------------------------------------------------------------

// The stand-in for a completed encode+decode: hands back a stable fake object URL per canvas.
function stubSnapshots(): { calls: HTMLCanvasElement[] } {
  const calls: HTMLCanvasElement[] = [];
  let n = 0;
  __setCanvasSnapshotSourceForTest((canvas, ready) => {
    calls.push(canvas);
    ready(`blob:snap-${++n}`);
  });
  return { calls };
}

function frozenImgs(stage: HTMLElement): HTMLImageElement[] {
  return [...stage.querySelectorAll<HTMLImageElement>("img.mirror-frozen-canvas")];
}

function atlasCanvas(stage: HTMLElement, id: string): HTMLCanvasElement {
  const canvas = el(stage, id).querySelector<HTMLCanvasElement>("canvas.mirror-atlas-canvas");
  expect(canvas, `atlas canvas of ${id}`).not.toBeNull();
  return canvas!;
}

describe("canvas de-promotion under a tier-2 cover", () => {
  it("swaps each covered canvas for a still <img> with the same class, box and slot", async () => {
    stubSnapshots();
    const { stage } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    const canvas = atlasCanvas(stage, "Icon");
    const before = canvas.style.cssText;
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0); // debounced off the reveal frame

    await drainFreeze();

    const imgs = frozenImgs(stage);
    expect(imgs.length).toBe(1);
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);
    expect(mirrorWalkStats.occlusionFrozenFallbacks).toBe(0);
    // The canvas keeps its slot and is merely hidden; the still rides immediately behind it.
    expect(canvas.style.display).toBe("none");
    expect(canvas.nextSibling).toBe(imgs[0]);
    expect(imgs[0].className).toBe("mirror-atlas-canvas mirror-frozen-canvas");
    expect(imgs[0].getAttribute("src")).toBe("blob:snap-1");
    expect(imgs[0].style.cssText).toBe(before);
    // Nothing ABOVE the cover is touched.
    expect(atlasCanvas(stage, "TopIcon").style.display).toBe("");
  });

  it("hands everything back the moment the cover lifts", async () => {
    stubSnapshots();
    const { stage, renderer, state } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    const canvas = atlasCanvas(stage, "Icon");
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);

    update(state, [node("Screen", "GlobalUi", "MapScreen", { visible: false })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.occludedRoots).toBe(0);
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0);
    expect(frozenImgs(stage).length).toBe(0);
    expect(canvas.style.display).toBe("");
  });

  it("leaves a canvas LIVE when its snapshot cannot be produced (WebGL readback, taint, no encoder)", async () => {
    __setCanvasSnapshotSourceForTest((_canvas, ready) => ready(null));
    const { stage } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();

    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0);
    expect(mirrorWalkStats.occlusionFrozenFallbacks).toBe(1);
    expect(frozenImgs(stage).length).toBe(0);
    expect(atlasCanvas(stage, "Icon").style.display).toBe("");
    // …and it is not retried on later walks (the surface has already proved it can't be read): the cumulative
    // counter does not move again.
    await drainFreeze();
    expect(mirrorWalkStats.occlusionFrozenFallbacks).toBe(1);
  });

  it("republishes the freeze gauges after a harness stats reset (bench window pattern)", async () => {
    stubSnapshots();
    const { renderer, state } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);

    // A bench/live probe calls reset() at the start of a measurement window; the next walk must republish the
    // LIVE freeze state instead of leaving the zeroed stat behind (nothing froze or thawed on that walk).
    mirrorWalkStats.reset();
    renderer.reconcile(state);
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);
  });

  it("keeps the cumulative fallback counter across a harness stats reset", async () => {
    __setCanvasSnapshotSourceForTest((_canvas, ready) => ready(null));
    const { renderer, state } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    expect(mirrorWalkStats.occlusionFrozenFallbacks).toBe(1);

    mirrorWalkStats.reset();
    renderer.reconcile(state);
    expect(mirrorWalkStats.occlusionFrozenFallbacks).toBe(1);
  });

  it("hands a canvas back when it is REPAINTED while frozen (a late texture / a region change)", async () => {
    stubSnapshots();
    const { stage, renderer, state } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    const canvas = atlasCanvas(stage, "Icon");
    expect(canvas.style.display).toBe("none");

    // Frame 2 of an animated icon: a different region ⇒ the canvas is redrawn ⇒ the still is stale.
    update(state, [
      sprite("Icon", "Room", 300, { textureRegion: { position: { x: 60, y: 8 }, size: { x: 48, y: 48 } } })
    ]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0);
    expect(frozenImgs(stage).length).toBe(0);
    expect(canvas.style.display).toBe("");

    // …and it re-freezes with the NEW pixels once things go quiet again.
    await drainFreeze();
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);
    expect(frozenImgs(stage)[0].getAttribute("src")).toBe("blob:snap-2");
  });

  it("keeps the still in paint order across a later re-style of the same node", async () => {
    stubSnapshots();
    const { stage, renderer, state } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    const canvas = atlasCanvas(stage, "Icon");

    // A cosmetic change re-runs updateSubLayers, which rebuilds the sub-layer list from scratch.
    update(state, [sprite("Icon", "Room", 300, { modulate: rgba(1, 1, 1, 0.5) })]);
    renderer.reconcile(state);

    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);
    expect(canvas.nextSibling).toBe(frozenImgs(stage)[0]);
    expect(canvas.style.display).toBe("none");
  });

  it("moves the still with the canvas when its PLACEMENT changes under the cover", async () => {
    stubSnapshots();
    // An INTERIOR atlas node carries its keep-aspect fit on the SPRITE element, so a box change rewrites the
    // canvas's own inline styles — which the still copied once, at freeze time.
    const interior = (w: number): Raw[] => [
      sprite("Icon", "Room", 300, { localRect: rect(0, 0, w, 24), textureStretchMode: 5 }),
      node("Kid", "Icon", "Kid")
    ];
    const nodes = liveScene("Backstop", "MapScreen", 0.851, 0.851);
    nodes.splice(2, 1, ...interior(96));
    const { stage, renderer, state } = mount(nodes);
    await drainFreeze();
    const canvas = atlasCanvas(stage, "Icon");
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);
    const img = frozenImgs(stage)[0];
    expect(img.style.transform).not.toBe("");

    update(state, interior(192));
    renderer.reconcile(state);

    // Still frozen (the pixels didn't change — only the box), and the still tracked the new placement exactly.
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);
    expect(canvas.style.display).toBe("none");
    expect(img.style.width).toBe(canvas.style.width);
    expect(img.style.height).toBe(canvas.style.height);
    expect(img.style.transform).toBe(canvas.style.transform);
    expect(img.style.display).toBe(""); // …and the sync did not copy our own `display:none` onto it
  });

  it("freezes nothing behind a TIER 1 cover (already display:none — no layer left to drop)", async () => {
    stubSnapshots();
    const nodes = liveScene("Backstop", "MapScreen", 1, 1);
    (nodes.find((n) => n.id === "Cover") as Raw).mouseFilter = 0;
    const { stage } = mount(nodes);
    await drainFreeze();

    expect(mirrorWalkStats.occlusionTier).toBe(1);
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0);
    expect(frozenImgs(stage).length).toBe(0);
  });

  it("thaws when the setting is turned off", async () => {
    stubSnapshots();
    const h = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    const canvas = atlasCanvas(h.stage, "Icon");
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);

    mirrorSettings.backstopOcclusion = false;
    h.renderer.reconcile(h.state, { forceTextures: true, reason: "occlusion" });

    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0);
    expect(frozenImgs(h.stage).length).toBe(0);
    expect(canvas.style.display).toBe("");
  });

  it("leaves no stray still behind when the covered node is REMOVED", async () => {
    stubSnapshots();
    const { stage, renderer, state } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    expect(frozenImgs(stage).length).toBe(1);

    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        removedIds: ["Icon"],
        orderedIds: ["Game", "Room", "GlobalUi", "Screen", "Cover", "ScreenContent", "TopBar", "TopIcon"]
      })!
    );
    renderer.reconcile(state);

    expect(stage.querySelector('[data-node-id="Icon"]')).toBeNull();
    expect(frozenImgs(stage).length).toBe(0);
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0);
  });

  it("gives every canvas back on dispose()", async () => {
    stubSnapshots();
    const h = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    expect(frozenImgs(h.stage).length).toBe(1);

    h.renderer.dispose();
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0);
    expect(frozenImgs(h.stage).length).toBe(0);
    h.stage.remove();
    harnessRef = null;
  });

  it("de-promotes nothing at all with the setting off, gate or no gate", async () => {
    stubSnapshots();
    mirrorSettings.backstopOcclusion = false;
    // A GENERIC (0.851) cover still gates — but the de-promotion rides the same switch.
    const { stage } = mount(liveScene("SelectModeBackstop", "Hand", 0.851, 1));
    await drainFreeze();

    expect(mirrorWalkStats.occlusionTier).toBe(2);
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(0);
    expect(frozenImgs(stage).length).toBe(0);
  });

  it("de-promotes a canvas that only APPEARS under an already-engaged cover", async () => {
    stubSnapshots();
    const { stage, renderer, state } = mount(liveScene("Backstop", "MapScreen", 0.851, 0.851));
    await drainFreeze();
    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(1);

    // A second sprite arrives under the covered room (a reveal, an idle hatch, a card dealt while the map is up).
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [sprite("Icon2", "Room", 500)],
        orderedIds: [
          "Game",
          "Room",
          "Icon",
          "Icon2",
          "GlobalUi",
          "Screen",
          "Cover",
          "ScreenContent",
          "TopBar",
          "TopIcon"
        ]
      })!
    );
    renderer.reconcile(state);
    await drainFreeze();

    expect(mirrorWalkStats.occlusionFrozenCanvases).toBe(2);
    expect(atlasCanvas(stage, "Icon2").style.display).toBe("none");
  });
});
