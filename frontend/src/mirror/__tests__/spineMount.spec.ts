import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorRenderer, type MirrorRenderer, } from "@/mirror/mirrorRenderer";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode, type MirrorState } from "@/mirror/sceneTree";
import type { LoadedSpineClip } from "@/mirror/spineClip";
import { spineClipUrl } from "@/mirror/spineAttributes";
import { mirrorSettings } from "@/mirror/mirrorSettings";

// The clip client fetches + decodes over the network; jsdom has no server, so mock loadSpineClip to resolve a
// canned decoded clip. frameIndexAt stays REAL (the reconciler's playback math is exercised, not stubbed).
const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

// Decoded-frame sentinels: the renderer blits these via ctx.drawImage; the mocked ctx records the source so we
// can assert the right frame painted (jsdom has no real canvas, so we never inspect pixels).
const FRAME0_BMP = { id: "frame0" } as unknown as ImageBitmap;
const FRAME1_BMP = { id: "frame1" } as unknown as ImageBitmap;

// A decoded clip whose canvas (100 wide) maps to a node-local rect of width 100 → scale 1; origin at (-50,-75).
function fakeClip(over: Partial<LoadedSpineClip> = {}): LoadedSpineClip {
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 300,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      { index: 0, offsetX: 1, offsetY: 2, width: 10, height: 20, durationMs: 150, startMs: 0, png: new Uint8Array(), bitmap: FRAME0_BMP },
      { index: 1, offsetX: 3, offsetY: 4, width: 11, height: 21, durationMs: 150, startMs: 150, png: new Uint8Array(), bitmap: FRAME1_BMP }
    ],
    stillUrl: null,
    degraded: false,
    retain() {},
    release() {},
    dispose() {},
    ...over
  };
}

// jsdom has no 2D canvas context — return a spy ctx so the reconciler's drawImage/clearRect can be asserted.
const drawImage = vi.fn();
const clearRect = vi.fn();
const fakeCtx = { drawImage, clearRect } as unknown as CanvasRenderingContext2D;

function spineNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "spine",
    parentId: null,
    name: "SpineSprite",
    nodeType: "SpineSprite",
    // A SpineSprite streams a global transform but NO localRect (it's neither Control nor Sprite2D).
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 960, y: 540 } },
    visible: true,
    spine: {
      sceneResPath: "res://scenes/merchant/characters/ironclad_merchant.tscn",
      nodePath: "Visuals/SpineSprite",
      animations: ["idle_loop", "attack"]
    },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0,
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}

function volatile(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

// Let the mocked loadSpineClip's resolve + the reconciler's .then attach run.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// SPINE LANE. The product default is now a server-baked STILL on every device (mirrorSettings' `spineMode`
// default; the panel no longer offers a choice), so the ANIMATED clip lane these cases exercise — anim switches,
// skin/mat/skel folding, the retry=1 escalation, still-first chaining — is reachable only through the dev override
// `?spineMode=dynamic`. Each case that pins the animated lane says so through this helper; the tier-driven cases
// leave the mode at its default so they keep asserting what a real viewer gets.
function useAnimatedSpineLane(): void {
  __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high&spineClips=on", gpu: UNKNOWN_GPU }));
  mirrorSettings.spineMode = "dynamic";
}

// SPINE SOURCE. These cases are about the RASTER lane — the `/spines/` request, its still/canvas paint
// mechanism and its clock. These cases pin the raster lane so their synchronous-fetch assertions stay isolated;
// the explicit delta experiment's fallback ordering is covered by domGeoclip.spec.ts / canvasGeoclip.spec.ts.
beforeEach(() => {
  document.body.innerHTML = "";
  loadSpineClipMock.mockReset();
  loadSpineClipMock.mockReturnValue(Promise.resolve(fakeClip()));
  drawImage.mockReset();
  clearRect.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as unknown as null);
});

afterEach(() => {
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static"; // back to the product defaults (the store is an app-wide singleton)
  vi.restoreAllMocks();
});

describe("mirror SpineSprite clip playback", () => {
  it("renders a transformed zero-box node + clip canvas, fetches the clip, blits a frame", async () => {
    useAnimatedSpineLane();
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);

    // The node EL exists and carries the node transform at the skeleton-root origin (zero box).
    const node = stage.querySelector('[data-node-id="spine"]') as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.style.transform).toBe("matrix(1, 0, 0, 1, 960, 540)");

    // The clip canvas (the sole visual) is created synchronously (sizing + placement apply after load).
    const canvas = node.querySelector(".mirror-spine-canvas") as HTMLCanvasElement;
    expect(canvas).not.toBeNull();

    // The animated lane requests its immediate still by canonical /spines/ URL before chaining the full clip.
    expect(loadSpineClipMock).toHaveBeenCalledTimes(1);
    expect(loadSpineClipMock).toHaveBeenCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=idle_loop&still=1"
    );

    await flush();

    // canvas internal res = clip canvas (100x200); canvas 100w → node-local 100w ⇒ scale 1; origin (-50,-75).
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(200);
    expect(canvas.style.transform).toBe("translate(-50px, -75px) scale(1)");
    // Track time 0 → frame 0, blitted at its tight-crop offset (canvas pixels) after a clear.
    expect(clearRect).toHaveBeenCalled();
    expect(drawImage).toHaveBeenLastCalledWith(FRAME0_BMP, 1, 2);

    expect(() => renderer.dispose()).not.toThrow();
  });

  // BELT (WS5): a clip whose host lane returned NO clipPlacement arrives with ClipLocal*=0 (the SPCL default).
  // `localWidth / canvasWidth` was then scale(0) — the clip painted as NOTHING, which is exactly how the
  // char-select background disappeared. A non-positive localWidth must fall back to scale 1 (visible, possibly
  // mis-sized) rather than an invisible element.
  it("falls back to scale 1 when the clip carries no placement (localWidth 0) instead of painting scale(0)", async () => {
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high&spineClips=on", gpu: UNKNOWN_GPU }));
    loadSpineClipMock.mockImplementation(async () => fakeClip({ localX: 0, localY: 0, localWidth: 0, localHeight: 0 }));
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);

    const node = stage.querySelector('[data-node-id="spine"]') as HTMLElement;
    const canvas = node.querySelector(".mirror-spine-canvas") as HTMLCanvasElement;
    await flush();

    expect(canvas.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(canvas.style.transform).not.toContain("scale(0)");
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(200);

    expect(() => renderer.dispose()).not.toThrow();
  });

  it("fetches NOTHING and renders no element when the tier disables clips (fetch-or-flat degrade)", () => {
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=minimum", gpu: UNKNOWN_GPU }));
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);

    // No localRect/rect/text/clip/particle and clips disabled → the node gets no box at all (blank character).
    expect(stage.querySelector('[data-node-id="spine"]')).toBeNull();
    expect(loadSpineClipMock).not.toHaveBeenCalled();
  });

  it("re-fetches a new clip when the game switches the playing anim", async () => {
    useAnimatedSpineLane();
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(2); // still first, then its chained animated clip

    // Volatile-only upsert (no name): the static spine block is retained; the game switched idle_loop → attack.
    volatile(state, [{ id: "spine", parentId: null, spineCurrentAnim: "attack", spineTrackTime: 0.05 }]);
    renderer.reconcile(state);

    expect(loadSpineClipMock).toHaveBeenCalledTimes(3);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=attack&still=1"
    );
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(4);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=attack"
    );
    // The clip canvas is reused across the anim switch (not torn down + recreated).
    const canvas = stage.querySelector('[data-node-id="spine"] .mirror-spine-canvas');
    expect(canvas).not.toBeNull();
    expect(() => renderer.dispose()).not.toThrow();
  });

  // THE REGENT'S DAGGERS. Its two weapon sprites sit on a skeleton whose every clip is an attack, and the game
  // applies none of them until the swing fires — so the producer used to GUESS one, the still lane baked the
  // middle of it, and light daggers hung in the air for the whole fight. The producer now withdraws the animation
  // (`spineCurrentAnim` → null: the host omits the field, which normalizes to null here) for exactly that shape.
  // The client contract this depends on is that a null current anim is not a clip node at all: the spine layer
  // comes down, the node keeps no phantom zero-box element, and nothing further is requested for it. This is the
  // whole client side of that fix — it needed no code change, so this case is what keeps it true.
  it("drops the spine layer and requests nothing more when the producer withdraws the animation", async () => {
    // The PRODUCT lane (server-baked still), which is where the frozen mid-swing frame was painted.
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high&spineClips=on", gpu: UNKNOWN_GPU }));
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode({ spineCurrentAnim: "attack", spineLooping: false })], ["spine"]);
    renderer.reconcile(state);
    await flush();

    expect(stage.querySelector('[data-node-id="spine"] .mirror-spine-canvas')).not.toBeNull();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(1);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=attack&still=1"
    );
    const fetchesBeforeWithdrawal = loadSpineClipMock.mock.calls.length;

    // The withdrawal: a volatile-only upsert carrying no animation. The STATIC spine block (scene/node path) is
    // retained by mergeNode, so this is a node the producer still knows is a SpineSprite — just one the game has
    // played nothing on, which renders as the .tscn's setup pose (i.e. nothing at all here).
    volatile(state, [{ id: "spine", parentId: null, spineCurrentAnim: null, spineTrackTime: 0 }]);
    renderer.reconcile(state);
    await flush();

    expect(stage.querySelector(".mirror-spine-canvas")).toBeNull();
    // A SpineSprite has no localRect/text/particle of its own, so losing the clip must leave NO element behind.
    expect(stage.querySelector('[data-node-id="spine"]')).toBeNull();

    // …and nothing is fetched for it again, on this tick or any later one.
    renderer.reconcile(state);
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(fetchesBeforeWithdrawal);

    expect(() => renderer.dispose()).not.toThrow();
  });

  it("#3 re-fetches with &skin= when the game changes the runtime skin (anim unchanged)", async () => {
    useAnimatedSpineLane();
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(2);

    // Volatile-only upsert: SAME anim, a NEW skin — the skin folds into the clip identity so it re-requests.
    volatile(state, [{ id: "spine", parentId: null, spineCurrentAnim: "idle_loop", spineSkin: "poisoned", spineTrackTime: 0.05 }]);
    renderer.reconcile(state);

    expect(loadSpineClipMock).toHaveBeenCalledTimes(3);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=idle_loop&skin=poisoned&still=1"
    );
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(4);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=idle_loop&skin=poisoned"
    );
    expect(() => renderer.dispose()).not.toThrow();
  });
});

describe("spineClipUrl selectors (WS-spine)", () => {
  const stub = (over: Partial<MirrorNode> = {}): MirrorNode =>
    ({
      spineSceneResPath: "res://scenes/x.tscn",
      spineNodePath: "Vis/Spine",
      spineCurrentAnim: "idle",
      spineSkin: null,
      ...over
    }) as unknown as MirrorNode;

  beforeEach(() => {
    // A full-clip tier (not still-mode) so no `&still=1` is appended — isolates the selector ordering.
    useAnimatedSpineLane();
  });

  it("is byte-identical to the base url when skin/skel/v are absent", () => {
    expect(spineClipUrl(stub())).toBe("/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle");
  });

  it("appends skin (only when present) after anim", () => {
    expect(spineClipUrl(stub({ spineSkin: "poisoned" }))).toBe("/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle&skin=poisoned");
  });

  it("appends skel/retry recovery selectors in node→anim→skin→skel→retry order", () => {
    expect(spineClipUrl(stub({ spineSkin: "poisoned" }), { skel: "res://models/x.tres", retry: true })).toBe(
      "/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle&skin=poisoned&skel=res%3A%2F%2Fmodels%2Fx.tres&retry=1"
    );
  });

  it("omits retry unless recovery requests it", () => {
    expect(spineClipUrl(stub(), { retry: false })).toBe("/spines/scenes/x.tscn?node=Vis%2FSpine&anim=idle");
  });
});

// A LIVE flip of the spine mode (now a dev `?spineMode=` override rather than a panel select). MirrorView answers
// a flip with a forced FULL walk (`scheduleRender(true)` → reconcile with forceTextures), which is what these cases
// drive directly — the store field is read at the gates, so nothing else needs to be re-plumbed.
describe("spine mode — live flips (dev override)", () => {
  beforeEach(() => {
    useAnimatedSpineLane();
  });

  it("Dynamic → Static re-requests the SAME identity as a &still=1 clip (no anim/skin change to trigger it)", async () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(2);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=idle_loop"
    );

    // The panel flip: nothing in the STREAM changes, so only the still-vs-animated identity moves.
    mirrorSettings.spineMode = "static";
    renderer.reconcile(state, { forceTextures: true });
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(3);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=idle_loop&still=1"
    );
    // Still rendering — the canvas survives the flip (it's the same node, a new clip).
    expect(stage.querySelector('[data-node-id="spine"] .mirror-spine-canvas')).not.toBeNull();

    // …and back: Dynamic re-requests the animated url.
    mirrorSettings.spineMode = "dynamic";
    renderer.reconcile(state, { forceTextures: true });
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(5);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/merchant/characters/ironclad_merchant.tscn?node=Visuals%2FSpineSprite&anim=idle_loop"
    );
    expect(() => renderer.dispose()).not.toThrow();
  });

  it("Off tears the canvas down and leaves NO phantom zero-box element; Auto brings it back", async () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();
    expect(stage.querySelector('[data-node-id="spine"] .mirror-spine-canvas')).not.toBeNull();
    const fetchesBeforeOff = loadSpineClipMock.mock.calls.length;

    mirrorSettings.spineMode = "off";
    renderer.reconcile(state, { forceTextures: true });
    await flush();
    // nodeStyles' zero-box placement rides the SAME isSpineClipNode gate, so the whole element goes — a spine node
    // has no localRect/text/particle of its own, so Off must leave nothing behind at all.
    expect(stage.querySelector('[data-node-id="spine"]')).toBeNull();
    expect(stage.querySelector(".mirror-spine-canvas")).toBeNull();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(fetchesBeforeOff); // and no new fetch while off

    mirrorSettings.spineMode = "auto";
    renderer.reconcile(state, { forceTextures: true });
    await flush();
    expect(stage.querySelector('[data-node-id="spine"] .mirror-spine-canvas')).not.toBeNull();
    expect(() => renderer.dispose()).not.toThrow();
  });
});
