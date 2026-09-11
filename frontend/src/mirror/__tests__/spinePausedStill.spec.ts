import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorRenderer, type MirrorRenderer, } from "@/mirror/mirrorRenderer";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import {
  __clearSpineSkelRequiredForTest,
  spineClipUrl,
  spineStillTime
} from "@/mirror/spineAttributes";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// The treasure chest must stay closed until the player opens it.
//
// The chest's spine has ONE meaningful clip, named "animation" (the lid opening), and the room sets it up as
// SetAnimation("animation") + AddAnimation("shine_fade") + SetTimeScale(0): a CLOSED chest is that clip FROZEN at
// t=0. The host's still bake, though, samples the MIDDLE of a clip (round-8 #14 — for most one-shots t=0 is a
// near-empty wind-up frame), so the mirror rendered a half-open lid. And because the client's clip identity was
// (anim, skin, mat, skel, stillMode), OPENING the chest changed nothing in the url — the producer only flips
// `spinePaused` — so nothing ever re-fetched and the lid never moved either.
//
// The fix is one selector on both halves: a PAUSED node pins `&t=<frozen track time>` into the still url AND into
// the clip identity, so the closed chest renders frame 0 and unpausing is itself the re-fetch trigger.
const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };
const CHEST_SCENE = "res://scenes/rooms/treasure_room.tscn";
const FRAME_BMP = { id: "frame0" } as unknown as ImageBitmap;

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function fakeStill(): LoadedSpineClip {
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 0,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      { index: 0, offsetX: 0, offsetY: 0, width: 10, height: 20, durationMs: 0, startMs: 0, png: new Uint8Array(), bitmap: FRAME_BMP }
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

// The chest exactly as the producer streams it while CLOSED: the sole clip "animation", paused, track time 0.
function chestNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chest",
    parentId: null,
    name: "ChestVisual",
    nodeType: "SpineSprite",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 960, y: 540 } },
    visible: true,
    spine: { sceneResPath: CHEST_SCENE, nodePath: "Chest/ChestVisual", animations: ["animation", "shine_fade"] },
    spineCurrentAnim: "animation",
    spineTrackTime: 0,
    spinePaused: true,
    ...over
  };
}

function mirrorNode(raw: Record<string, unknown>) {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: [raw], orderedIds: ["chest"] })!
  );
  return state.nodes.get("chest")!;
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}

function volatileDelta(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = "";
  loadSpineClipMock.mockReset();
  loadSpineClipMock.mockResolvedValue(fakeStill());
  drawImage.mockReset();
  clearRect.mockReset();
  __clearSpineSkelRequiredForTest();
  // The product default: server-baked STILL on every device.
  __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high", gpu: UNKNOWN_GPU }));
  mirrorSettings.spineMode = "static";
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as unknown as null);
});

afterEach(() => {
  __setRenderQualityForTest(undefined);
  __clearSpineSkelRequiredForTest();
  mirrorSettings.spineMode = "static";
  vi.restoreAllMocks();
});

describe("spineStillTime", () => {
  it("pins the frozen track time for a PAUSED node, quantized to 2 decimals", () => {
    expect(spineStillTime(mirrorNode(chestNode()))).toBe("0.00");
    expect(spineStillTime(mirrorNode(chestNode({ spineTrackTime: 1.23456 })))).toBe("1.23");
  });

  it("pins nothing for a RUNNING node (the host's own mid/terminal heuristic still picks)", () => {
    expect(spineStillTime(mirrorNode(chestNode({ spinePaused: false, spineTrackTime: 1.5 })))).toBeNull();
  });

  it("pins nothing for a nonsense track time", () => {
    expect(spineStillTime(mirrorNode(chestNode({ spineTrackTime: -1 })))).toBeNull();
  });

});

describe("spineClipUrl", () => {
  it("appends &t= LAST, after &still=1", () => {
    expect(spineClipUrl(mirrorNode(chestNode()))).toBe(
      "/spines/scenes/rooms/treasure_room.tscn?node=Chest%2FChestVisual&anim=animation&still=1&t=0.00"
    );
  });

  it("omits &t= once the game unpauses the track (the chest was opened)", () => {
    expect(spineClipUrl(mirrorNode(chestNode({ spinePaused: false })))).toBe(
      "/spines/scenes/rooms/treasure_room.tscn?node=Chest%2FChestVisual&anim=animation&still=1"
    );
  });

  it("never appends &t= to an ANIMATED clip url (only a collapsed still samples one time)", () => {
    mirrorSettings.spineMode = "dynamic";
    expect(spineClipUrl(mirrorNode(chestNode()))).toBe(
      "/spines/scenes/rooms/treasure_room.tscn?node=Chest%2FChestVisual&anim=animation"
    );
  });

});

describe("mirror spine — a paused (frozen) track", () => {
  it("requests the frozen frame for a CLOSED chest", async () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [chestNode()], ["chest"]);
    renderer.reconcile(state);
    await flush();

    expect(loadSpineClipMock).toHaveBeenCalledTimes(1);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/rooms/treasure_room.tscn?node=Chest%2FChestVisual&anim=animation&still=1&t=0.00"
    );
  });

  // Opening the chest changes nothing else about the node — same anim, skin, and material — so the time selector
  // must change the identity and refresh the still.
  it("re-fetches when the game UNPAUSES the track, even though the anim name never changed", async () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [chestNode()], ["chest"]);
    renderer.reconcile(state);
    await flush();
    loadSpineClipMock.mockClear();

    // The player opens the chest: SetTimeScale(1) → the producer flips spinePaused false. Nothing else changes.
    volatileDelta(state, [{ id: "chest", parentId: null, spineCurrentAnim: "animation", spineTrackTime: 0.2, spinePaused: false }]);
    renderer.reconcile(state);
    await flush();

    expect(loadSpineClipMock).toHaveBeenCalledTimes(1);
    expect(loadSpineClipMock).toHaveBeenLastCalledWith(
      "/spines/scenes/rooms/treasure_room.tscn?node=Chest%2FChestVisual&anim=animation&still=1"
    );
  });

  it("does NOT re-fetch while the track stays frozen at the same time (a still is not a per-tick request)", async () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [chestNode()], ["chest"]);
    renderer.reconcile(state);
    await flush();
    loadSpineClipMock.mockClear();

    for (let i = 0; i < 3; i++) {
      volatileDelta(state, [{ id: "chest", parentId: null, spineCurrentAnim: "animation", spineTrackTime: 0, spinePaused: true }]);
      renderer.reconcile(state);
      await flush();
    }

    expect(loadSpineClipMock).not.toHaveBeenCalled();
  });

});
