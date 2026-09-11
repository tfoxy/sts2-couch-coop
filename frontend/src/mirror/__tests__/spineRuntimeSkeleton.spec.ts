import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorRenderer, type MirrorRenderer, } from "@/mirror/mirrorRenderer";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { __clearSpineSkelRequiredForTest, spineClipUrl } from "@/mirror/spineAttributes";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// Round-8 items 8/9/13 — the RUNTIME-INJECTED spine skeletons (the treasure chest and the boss map point: their
// .tscn carries no `skeleton_data_res`, so the host's scene-addressed render has no skeleton to drive and only the
// `&skel=` fallback lane can bake them).
//
// Two independent client defects lived here:
//   * the clip identity ignored `spineSkelResPath`, so the node's FIRST (always-404ing) request was its LAST — the
//     producer learns the ANIMATION first (from the game's own SetAnimation/AddAnimation call) and the skeleton
//     path only once its late-static re-probe lands, and by then nothing re-requested. The map boss never appeared
//     and the chest stayed blank until OPENING it changed the animation;
//   * the decoded-clip LRU closed ImageBitmaps out from under the record still painting them.
const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };
const CHEST_SCENE = "res://scenes/rooms/treasure_room.tscn";
const CHEST_SKEL = "res://animations/props/act1_chest/act1_chest.spine_skel_data.tres";
const FRAME_BMP = { id: "frame0" } as unknown as ImageBitmap;

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function fakeClip(): LoadedSpineClip {
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 300,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      { index: 0, offsetX: 1, offsetY: 2, width: 10, height: 20, durationMs: 150, startMs: 0, png: new Uint8Array(), bitmap: FRAME_BMP },
      { index: 1, offsetX: 3, offsetY: 4, width: 11, height: 21, durationMs: 150, startMs: 150, png: new Uint8Array(), bitmap: FRAME_BMP }
    ],
    stillUrl: null,
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
}

const drawImage = vi.fn();
const clearRect = vi.fn();
const fakeCtx = { drawImage, clearRect } as unknown as CanvasRenderingContext2D;

// The chest as the producer streams it: a SpineSprite whose STATIC spine block starts with an empty animation
// list and NO skeleton path (the game assigns the skeleton from `_Ready`), while the VOLATILE current anim is
// already known because the anim hooks saw the game's `SetAnimation("animation")` call.
function chestNode(over: Record<string, unknown> = {}, spineOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chest",
    parentId: null,
    name: "ChestVisual",
    nodeType: "SpineSprite",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 960, y: 540 } },
    visible: true,
    spine: { sceneResPath: CHEST_SCENE, nodePath: "ChestVisual", animations: [], ...spineOver },
    spineCurrentAnim: "animation",
    spineTrackTime: 0,
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}

function volatileDelta(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

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

beforeEach(() => {
  document.body.innerHTML = "";
  loadSpineClipMock.mockReset();
  drawImage.mockReset();
  clearRect.mockReset();
  __clearSpineSkelRequiredForTest();
  // The host only ever serves this node from the `&skel=` fallback lane; every scene-addressed url 404s.
  loadSpineClipMock.mockImplementation((url: string) =>
    url.includes("skel=") ? Promise.resolve(fakeClip()) : Promise.reject(new Error("spine clip fetch failed: 404"))
  ); // still-first chaining has its own spec; keep one identity = one fetch here
  useAnimatedSpineLane();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as unknown as null);
});

afterEach(() => {
  __setRenderQualityForTest(undefined);
  __clearSpineSkelRequiredForTest();
  mirrorSettings.spineMode = "static"; // back to the product default (the store is an app-wide singleton)
  vi.restoreAllMocks();
});

describe("mirror spine — a runtime-injected skeleton arriving after the anim", () => {
  // THE item-9/13 REGRESSION. Pre-fix this test's second phase requested NOTHING: the anim was unchanged, so the
  // identity looked unchanged, and the node stayed blank forever.
  it("re-requests (and reaches the &skel= fallback) when skelResPath arrives late", async () => {
    const { renderer } = harness();
    const state = createMirrorState();

    // Phase 1 — anim known, skeleton path NOT yet: the still-first request falls through to the full clip; both 404.
    full(state, [chestNode()], ["chest"]);
    renderer.reconcile(state);
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(2);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith("/spines/scenes/rooms/treasure_room.tscn?node=ChestVisual&anim=animation");

    // Phase 2 — the producer's late-static re-probe found the skeleton and re-shipped the STATIC spine block.
    // The anim is unchanged, so only the skeleton path makes this a new identity.
    full(state, [chestNode({}, { animations: ["animation", "shine_fade"], skelResPath: CHEST_SKEL })], ["chest"]);
    renderer.reconcile(state);
    await flush();

    // A fresh still-first attempt falls through to the scene-addressed clip (both 404), then the ONE-SHOT &skel=
    // recovery resolves.
    expect(loadSpineClipMock).toHaveBeenCalledTimes(5);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      `/spines/scenes/rooms/treasure_room.tscn?node=ChestVisual&anim=animation&skel=${encodeURIComponent(CHEST_SKEL)}`
    );
    expect(drawImage).toHaveBeenCalled(); // the chest actually painted
    expect(() => renderer.dispose()).not.toThrow();
  });

  // #13 memo: once an address has PROVEN it needs `&skel=`, later identities skip the doomed scene-addressed
  // round-trip (which otherwise occupies the host's single extraction slot for nothing).
  it("remembers the address and sends &skel= on the FIRST request of the next anim", async () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [chestNode({}, { animations: ["animation", "shine_fade"], skelResPath: CHEST_SKEL })], ["chest"]);
    renderer.reconcile(state);
    await flush();
    expect(loadSpineClipMock).toHaveBeenCalledTimes(3); // still-first 404 + full 404 + skel retry

    loadSpineClipMock.mockClear();
    // Opening the chest hands off to the queued "shine_fade" clip.
    volatileDelta(state, [{ id: "chest", parentId: null, spineCurrentAnim: "shine_fade", spineTrackTime: 0 }]);
    renderer.reconcile(state);
    await flush();

    expect(loadSpineClipMock).toHaveBeenCalledTimes(1);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      `/spines/scenes/rooms/treasure_room.tscn?node=ChestVisual&anim=shine_fade&skel=${encodeURIComponent(CHEST_SKEL)}`
    );
    expect(() => renderer.dispose()).not.toThrow();
  });

  // #8: the shader-material signature is part of the clip identity, so the boss map point re-bakes when the game
  // re-tints its channel-remap mask (act change / the node becoming travelable) instead of serving the first tint
  // from cache forever.
  it("re-requests with a new &mat= when the node's shader material is re-parameterised", async () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(
      state,
      [chestNode({ spineMat: "aaaa1111bbbb2222" }, { animations: ["animation"], skelResPath: CHEST_SKEL })],
      ["chest"]
    );
    renderer.reconcile(state);
    await flush();
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      `/spines/scenes/rooms/treasure_room.tscn?node=ChestVisual&anim=animation&mat=aaaa1111bbbb2222&skel=${encodeURIComponent(CHEST_SKEL)}`
    );

    loadSpineClipMock.mockClear();
    volatileDelta(state, [{ id: "chest", parentId: null, spineCurrentAnim: "animation", spineMat: "cccc3333dddd4444", spineTrackTime: 0.1 }]);
    renderer.reconcile(state);
    await flush();

    expect(loadSpineClipMock).toHaveBeenCalledTimes(1);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      `/spines/scenes/rooms/treasure_room.tscn?node=ChestVisual&anim=animation&mat=cccc3333dddd4444&skel=${encodeURIComponent(CHEST_SKEL)}`
    );
    expect(() => renderer.dispose()).not.toThrow();
  });

  // #13: a PAUSED track (the closed chest, MegaAnimationState.SetTimeScale(0)) must track the STREAMED time
  // instead of free-running the clip off the wall clock — free-running walked a chest frozen on frame 0 open, and
  // then on into its queued "shine_fade" glow. While paused every emission re-seeds from the streamed track time,
  // so the painted frame follows the game exactly.
  it("paints the streamed frame while the game has the track paused", async () => {
    const { renderer } = harness();
    const state = createMirrorState();
    // The chest's clip is a ONE-SHOT (spineLooping:false), like the real "animation" open.
    full(
      state,
      [chestNode({ spineLooping: false }, { animations: ["animation"], skelResPath: CHEST_SKEL })],
      ["chest"]
    );
    renderer.reconcile(state);
    await flush();
    // Frame 0 blits at its tight-crop offset (1,2); frame 1 would blit at (3,4).
    expect(drawImage).toHaveBeenLastCalledWith(FRAME_BMP, 1, 2);

    // The game freezes the track at 0.2s into the clip. The pause flip is an Effects change, so it reaches the
    // spine layer, which re-anchors playback to the STREAMED time (frame 1) instead of the free-running clock.
    volatileDelta(state, [{ id: "chest", parentId: null, spineCurrentAnim: "animation", spineLooping: false, spinePaused: true, spineTrackTime: 0.2 }]);
    renderer.reconcile(state);
    await flush();
    expect(drawImage).toHaveBeenLastCalledWith(FRAME_BMP, 3, 4);

    // Opening the chest resumes it: the flip back is an Effects change too, and playback free-runs again.
    volatileDelta(state, [{ id: "chest", parentId: null, spineCurrentAnim: "animation", spineLooping: false, spinePaused: false, spineTrackTime: 0 }]);
    renderer.reconcile(state);
    await flush();
    expect(() => renderer.dispose()).not.toThrow();
  });
});

describe("spineClipUrl — &mat= selector", () => {
  const base = {
    spineSceneResPath: "res://scenes/ui/boss_map_point.tscn",
    spineNodePath: "SpriteContainer/SpineSprite",
    spineCurrentAnim: "animation",
    spineSkin: null,
    spineMat: null
  };

  it("omits mat when the node has no shader material (byte-identical to the pre-#8 url)", () => {
    expect(spineClipUrl(base as never)).toBe(
      "/spines/scenes/ui/boss_map_point.tscn?node=SpriteContainer%2FSpineSprite&anim=animation"
    );
  });

  it("appends mat after skin and before skel (the host's BuildSpineKey selector order)", () => {
    expect(spineClipUrl({ ...base, spineSkin: "normal", spineMat: "0123456789abcdef" } as never, { skel: "res://a.tres" })).toBe(
      "/spines/scenes/ui/boss_map_point.tscn?node=SpriteContainer%2FSpineSprite&anim=animation" +
        "&skin=normal&mat=0123456789abcdef&skel=res%3A%2F%2Fa.tres"
    );
  });
});
