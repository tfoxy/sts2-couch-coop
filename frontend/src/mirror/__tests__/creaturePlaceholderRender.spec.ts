import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CREATURE_PLACEHOLDER_CLASS } from "@/mirror/creaturePlaceholder";
import { createMirrorOverlay, type MirrorOverlay } from "@/mirror/canvas/overlay";
import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { overlayRecordFor, type OverlayRecord } from "@/mirror/canvas/paintSpec";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import { __setStillDecoderForTest } from "@/mirror/stillDecode";
import type { LoadedSpineClip } from "@/mirror/spineClip";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";

// THE CREATURE STAND-IN, END TO END, ON BOTH BACKENDS.
//
// `creaturePlaceholder.spec.ts` pins the policy — which nodes are claimed, and the box algebra that puts a 200x200
// image exactly inside a 242x278 creature. This file pins the three things only a renderer can answer:
//
//   WHEN   nothing for the first second, the stand-in after it, and nothing at all once real pixels commit;
//   NEVER  a creature whose art arrived in time never shows one, and a rig outside the policy never shows one;
//   ALWAYS permanent when the fetch was refused, and permanent on `?quality=minimum` — where it is not a deadline at
//          all, because no clip was ever requested and none is coming.
//
// The clock is faked throughout: the deadline is a real `setTimeout` and the decision re-reads `performance.now()`,
// and vitest's fake timers move both together.

const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };
const PLACEHOLDER_SELECTOR = `img.${CREATURE_PLACEHOLDER_CLASS}`;

function xf(x: number, y: number, scale = 1): Record<string, unknown> {
  return { xAxis: { x: scale, y: 0 }, yAxis: { x: 0, y: scale }, origin: { x, y } };
}

function rect(x: number, y: number, w: number, h: number): Record<string, unknown> {
  return { position: { x, y }, size: { x: w, y: h } };
}

/**
 * The Ironclad in combat, in the shape the wire actually sends (see creaturePlaceholder.spec.ts): the box on the
 * creature root's `Hitbox`, the rig one level down, the spine node scaled 0.28 beside its `Bounds`.
 */
const CREATURE_TREE: Record<string, unknown>[] = [
  {
    id: "creature",
    parentId: null,
    name: "Creature",
    nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NCreature",
    sceneFilePath: "res://scenes/combat/creature.tscn",
    transform: xf(-324, 200),
    localRect: rect(0, 0, 0, 0),
    visible: true
  },
  {
    id: "hitbox",
    parentId: "creature",
    name: "Hitbox",
    nodeType: "Godot.Control",
    transform: xf(-121, -278),
    localRect: rect(0, 0, 242, 278),
    visible: true
  },
  {
    id: "rig",
    parentId: "creature",
    name: "Ironclad",
    nodeType: "MegaCrit.Sts2.Core.Nodes.Combat.NCreatureVisuals",
    sceneFilePath: "res://scenes/creature_visuals/ironclad.tscn",
    transform: xf(0, 0),
    visible: true
  },
  {
    id: "spine",
    parentId: "rig",
    name: "Visuals",
    nodeType: "Godot.Node2D",
    transform: xf(5, -19, 0.28),
    visible: true,
    spine: {
      sceneResPath: "res://scenes/creature_visuals/ironclad.tscn",
      nodePath: "Visuals",
      animations: ["idle_loop", "attack"]
    },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0
  }
];

/**
 * The shop's merchant — box on the button, spine node parked far outside it.
 *
 * Addressed the way game v0.111.0 actually sends it — `res://scenes/rooms/merchant_button.tscn` plus a
 * scene-LOCAL `MerchantVisual`, both read off a live scene dump —
 * which is not how the older recording in `creaturePlaceholder.spec.ts` sends it. Both are claimed; this file
 * drives the live one end to end so a renderer case cannot pass against an address the game no longer uses.
 */
const MERCHANT_TREE: Record<string, unknown>[] = [
  {
    id: "button",
    parentId: null,
    name: "MerchantButton",
    nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantButton",
    transform: xf(1206, 468),
    localRect: rect(0, 0, 270, 330),
    visible: true
  },
  {
    id: "spine",
    parentId: "button",
    name: "MerchantVisual",
    nodeType: "Godot.Node2D",
    transform: xf(-1122.7, -396.68, 0.470095),
    visible: true,
    spine: {
      sceneResPath: "res://scenes/rooms/merchant_button.tscn",
      nodePath: "MerchantVisual",
      animations: ["idle_loop"]
    },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0
  }
];

/** The shop room's BACKGROUND spine — a rig the policy deliberately refuses. */
const SHOP_BACKGROUND_TREE: Record<string, unknown>[] = [
  {
    id: "bg",
    parentId: null,
    name: "BgContainer",
    nodeType: "Godot.Control",
    transform: xf(0, 0),
    localRect: rect(0, 0, 1920, 1080),
    visible: true
  },
  {
    id: "spine",
    parentId: "bg",
    name: "SpineSprite",
    nodeType: "Godot.Node2D",
    transform: xf(0, 0, 0.5),
    visible: true,
    spine: {
      sceneResPath: "res://scenes/rooms/merchant_room.tscn",
      nodePath: "SceneContainer/BgContainer/SpineSprite",
      animations: ["idle_loop"]
    },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0
  }
];

function build(nodes: Record<string, unknown>[]): MirrorState {
  const state = createMirrorState();
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

/** A decoded 1-frame still, the shape the product (`spineMode: static`) lane always gets. */
function still(): LoadedSpineClip {
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 0,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      { index: 0, offsetX: 0, offsetY: 0, width: 40, height: 60, durationMs: 0, startMs: 0, png: new Uint8Array(), bitmap: null }
    ],
    stillUrl: "blob:creature-still",
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
}

/**
 * The stand-in's placed box, read back off the element.
 *
 * Read as NUMBERS rather than compared as a style string: the two backends reach the same box by slightly
 * different float paths (`pxCss` vs a direct template), so `-450` comes out as `-450px` on one and
 * `-449.99999999999994px` on the other. Pinning the string would be pinning the rounding, not the placement.
 */
function boxOf(img: HTMLImageElement): { x: number; y: number; width: number; height: number } {
  const m = /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)/.exec(img.style.transform)!;
  return {
    x: Number(m[1]),
    y: Number(m[2]),
    width: Number.parseFloat(img.style.width),
    height: Number.parseFloat(img.style.height)
  };
}

/** Let the mocked fetch's `.then`/`.catch` attach and run without moving the fake clock. */
const flush = (): Promise<void> => Promise.resolve().then(() => undefined).then(() => undefined);

// --- DOM backend ------------------------------------------------------------------------------------------------

let renderer: MirrorRenderer | null = null;
let overlay: MirrorOverlay | null = null;

function domHarness(): HTMLElement {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  renderer = createMirrorRenderer(stage, defs);
  return stage;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  loadSpineClipMock.mockReset();
  // The default: a request that never answers, which is exactly the case the deadline exists for.
  loadSpineClipMock.mockReturnValue(new Promise<LoadedSpineClip>(() => {}));
  __setStillDecoderForTest((_url, ready) => ready(true)); // commit inline; the decode gate is specced elsewhere
  __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high", gpu: UNKNOWN_GPU }));
});

afterEach(() => {
  renderer?.dispose();
  renderer = null;
  overlay?.dispose();
  overlay = null;
  __setStillDecoderForTest(null);
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static"; // the store is an app-wide singleton
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("creature stand-in — DOM backend", () => {
  it("shows NOTHING for the first second, then stretches the stand-in into the creature's box", () => {
    const stage = domHarness();
    renderer!.reconcile(build(CREATURE_TREE));

    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
    vi.advanceTimersByTime(999);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();

    vi.advanceTimersByTime(1);
    const img = stage.querySelector<HTMLImageElement>(PLACEHOLDER_SELECTOR)!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/res/images/monsters/the_adversary_placeholder.png");
    // The 242x278 hitbox, in the spine node's own 0.28-scaled local space (242/0.28, 278/0.28 at -450,-925).
    expect(boxOf(img)).toMatchObject({ x: expect.closeTo(-450, 3), y: expect.closeTo(-925, 3) });
    expect(boxOf(img).width).toBeCloseTo(864.2857, 3);
    expect(boxOf(img).height).toBeCloseTo(992.8571, 3);
    // It hangs off the spine node, so the node element's own matrix applies the rig scale — hence no scale() above.
    expect(img.closest("[data-node-id]")?.getAttribute("data-node-id")).toBe("spine");
  });

  it("never appears when the still lands inside the grace period", async () => {
    loadSpineClipMock.mockResolvedValue(still());
    const stage = domHarness();
    renderer!.reconcile(build(CREATURE_TREE));
    await flush();

    expect(stage.querySelector("img.mirror-spine-img")).not.toBeNull();
    vi.advanceTimersByTime(5000);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
  });

  it("retires the moment real art commits, even after it has been up", async () => {
    let settle: (clip: LoadedSpineClip) => void = () => {};
    loadSpineClipMock.mockReturnValue(new Promise<LoadedSpineClip>((resolve) => { settle = resolve; }));
    const stage = domHarness();
    renderer!.reconcile(build(CREATURE_TREE));

    vi.advanceTimersByTime(1000);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();

    settle(still());
    await flush();
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
    expect(stage.querySelector("img.mirror-spine-img")).not.toBeNull();
  });

  it("is PERMANENT, and immediate, when the fetch is refused outright", async () => {
    loadSpineClipMock.mockRejectedValue(new Error("spine clip fetch failed: 404"));
    const stage = domHarness();
    renderer!.reconcile(build(CREATURE_TREE));
    await flush();

    // No grace period: there is nothing left in flight to wait for.
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();
  });

  it("does NOT cover a creature whose previous animation is still painting when the next bake fails", async () => {
    loadSpineClipMock.mockResolvedValue(still());
    const stage = domHarness();
    const state = build(CREATURE_TREE);
    renderer!.reconcile(state);
    await flush();
    expect(stage.querySelector("img.mirror-spine-img")).not.toBeNull();

    // The creature swings: a NEW clip identity, whose fetch is refused. The still on screen is the idle pose —
    // the decode gate deliberately keeps it until a replacement decodes — so the creature is plainly visible,
    // and a stand-in over it would be a regression dressed as a fallback.
    loadSpineClipMock.mockRejectedValue(new Error("spine clip fetch failed: 404"));
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [{ id: "spine", spineCurrentAnim: "attack", spineTrackTime: 0 }]
      })!
    );
    renderer!.reconcile(state);
    await flush();

    expect(stage.querySelector("img.mirror-spine-img")).not.toBeNull();
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
  });

  it("is permanent on the hard-off tier, WITHOUT requesting a clip", () => {
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=minimum", gpu: UNKNOWN_GPU }));
    const stage = domHarness();
    renderer!.reconcile(build(CREATURE_TREE));

    // Immediately — the off tier's contract is that no clip is fetched, so there is no deadline to serve.
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();
    expect(loadSpineClipMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();
  });

  it("stays out entirely under the dev `?spineMode=off` override", () => {
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=minimum", gpu: UNKNOWN_GPU }));
    mirrorSettings.spineMode = "off";
    const stage = domHarness();
    renderer!.reconcile(build(CREATURE_TREE));

    vi.advanceTimersByTime(60_000);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
  });

  it("fills the merchant's 270x330 button box — from the BOX, not from the node origin", () => {
    const stage = domHarness();
    renderer!.reconcile(build(MERCHANT_TREE));
    vi.advanceTimersByTime(1000);

    const img = stage.querySelector<HTMLImageElement>(PLACEHOLDER_SELECTOR)!;
    expect(img).not.toBeNull();
    // The spine node sits at (-1122.7,-396.68); a stand-in placed from THAT origin would be off-screen left.
    // Mapped back through the node's own 0.470095 scale, the box is the button's 270x330 rect at its origin.
    const box = boxOf(img);
    expect(box.x * 0.470095 - 1122.7).toBeCloseTo(0, 3);
    expect(box.y * 0.470095 - 396.68).toBeCloseTo(0, 3);
    expect(box.width * 0.470095).toBeCloseTo(270, 3);
    expect(box.height * 0.470095).toBeCloseTo(330, 3);
  });

  it("leaves the shop's ROOM BACKGROUND spine alone, however long it takes to bake", () => {
    const stage = domHarness();
    renderer!.reconcile(build(SHOP_BACKGROUND_TREE));
    vi.advanceTimersByTime(60_000);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
  });

  it("drops the stand-in and its pending deadline when the creature leaves the scene", () => {
    const stage = domHarness();
    const state = build(CREATURE_TREE);
    renderer!.reconcile(state);
    vi.advanceTimersByTime(1000);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();

    const withoutRig = CREATURE_TREE.filter((n) => n.id !== "spine");
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: true,
        screenType: "run",
        upserts: withoutRig,
        orderedIds: withoutRig.map((n) => n.id as string)
      })!
    );
    renderer!.reconcile(state);
    expect(stage.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  });
});

// --- canvas backend ---------------------------------------------------------------------------------------------
//
// The canvas stage paints a spine still as an `<img>` in the node's own overlay element, so the stand-in is the
// same element and the same class there — which is why one CSS rule serves both. These cases assert the SEQUENCE
// agrees; the geometry is the shared module's, already pinned above and in creaturePlaceholder.spec.ts.

function canvasHarness(): HTMLElement {
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  stage.appendChild(canvas);
  document.body.appendChild(stage);
  overlay = createMirrorOverlay(stage, canvas);
  return overlay.container;
}

/** The overlay record the draw-list builder would emit for the spine node, through the real `paintSpec` classifier. */
function spineRecordFor(state: MirrorState): OverlayRecord {
  const node = state.nodes.get("spine")!;
  return overlayRecordFor({
    node,
    nodes: state.nodes,
    global: [1, 0, 0, 1, 0, 0],
    ownOpacity: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    order: 0,
    hidden: false
  })!;
}

describe("creature stand-in — canvas backend", () => {
  it("shows NOTHING for the first second, then the stand-in in the spine node's overlay element", () => {
    const container = canvasHarness();
    const state = build(CREATURE_TREE);
    overlay!.reconcile([spineRecordFor(state)], state.nodes);

    expect(container.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
    vi.advanceTimersByTime(999);
    overlay!.reconcile([spineRecordFor(state)], state.nodes);
    expect(container.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();

    vi.advanceTimersByTime(1);
    const img = container.querySelector<HTMLImageElement>(PLACEHOLDER_SELECTOR)!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("/res/images/monsters/the_adversary_placeholder.png");
    expect(boxOf(img).x).toBeCloseTo(-450, 3);
    expect(boxOf(img).y).toBeCloseTo(-925, 3);
    expect(img.closest("[data-node-id]")?.getAttribute("data-node-id")).toBe("spine");
  });

  it("retires it the moment the still commits", async () => {
    let settle: (clip: LoadedSpineClip) => void = () => {};
    loadSpineClipMock.mockReturnValue(new Promise<LoadedSpineClip>((resolve) => { settle = resolve; }));
    const container = canvasHarness();
    const state = build(CREATURE_TREE);
    overlay!.reconcile([spineRecordFor(state)], state.nodes);
    vi.advanceTimersByTime(1000);
    expect(container.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();

    settle(still());
    await flush();
    expect(container.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
    expect(container.querySelector("img.mirror-spine-img")).not.toBeNull();
  });

  it("is permanent on the hard-off tier, WITHOUT requesting a clip", () => {
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=minimum", gpu: UNKNOWN_GPU }));
    const container = canvasHarness();
    const state = build(CREATURE_TREE);
    overlay!.reconcile([spineRecordFor(state)], state.nodes);

    expect(container.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();
    expect(loadSpineClipMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(container.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();
  });

  it("is PERMANENT when the fetch is refused outright", async () => {
    loadSpineClipMock.mockRejectedValue(new Error("spine clip fetch failed: 404"));
    const container = canvasHarness();
    const state = build(CREATURE_TREE);
    overlay!.reconcile([spineRecordFor(state)], state.nodes);
    await flush();

    expect(container.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(container.querySelector(PLACEHOLDER_SELECTOR)).not.toBeNull();
  });

  it("leaves the shop's ROOM BACKGROUND spine alone", () => {
    const container = canvasHarness();
    const state = build(SHOP_BACKGROUND_TREE);
    overlay!.reconcile([spineRecordFor(state)], state.nodes);
    vi.advanceTimersByTime(60_000);
    expect(container.querySelector(PLACEHOLDER_SELECTOR)).toBeNull();
  });
});
