import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorRenderer, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { __setRenderQualityForTest, resolveRenderQuality } from "@/render/quality";
import {
  __clearGeoclipProbesForTest,
  type GeoclipClip,
  type GeoclipNode,
  type GeoclipPlacement,
  type GpuClip
} from "@/mirror/geoclipPlayer";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// GEOCLIP PLAYBACK ON THE **DOM** BACKEND — the twin of `canvasGeoclip.spec`, and the arm where two of this
// round's three deliverables are actually OBSERVABLE.
//
// WHY A SEPARATE FILE, AND WHY THE rAF SPY. "A static pose must not wake the rAF" has a different symptom on each
// backend, and only this one is visible from outside:
//
//   * canvas — `clipAnimates` folds the geoclip into a COUNTER that short-circuits a scan. A one-frame geoclip
//     that wrongly counted as playing would still park, because `msToNextGeoclipFrame` is Infinity for one frame.
//     `spinePlayingCount()` is what pins it there.
//   * DOM — `activeSpine` membership is the animation demand ITSELF: `refreshAnimDeadlines` sets `spineDueAt` from
//     `activeSpine.size` alone, with no per-clip question asked, so ONE member books a frame callback forever.
//     A one-frame geoclip joining that set therefore pins the whole renderer's animation loop for the rest of the
//     session — which is the defect, and it is measured here by counting frame callbacks across an isolated mount.
//
// THE ISOLATION that makes the count meaningful: the geoclip's UPLOAD is held pending, the reconcile is allowed to
// settle, the pending frame callbacks are drained until the renderer parks, the counter is zeroed, and only THEN
// is the upload released. Every callback counted after that point was booked by the mount.

const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

const { probeGeoclipMock, uploadGeoclipMock, createGeoclipNodeMock } = vi.hoisted(() => ({
  probeGeoclipMock: vi.fn(),
  uploadGeoclipMock: vi.fn(),
  createGeoclipNodeMock: vi.fn()
}));
vi.mock("@/mirror/geoclipPlayer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/geoclipPlayer")>();
  return {
    ...actual,
    probeGeoclip: (url: string, resolve: (file: string) => string) => probeGeoclipMock(url, resolve),
    uploadGeoclip: (clip: GeoclipClip) => uploadGeoclipMock(clip),
    createGeoclipNode: (clip: GeoclipClip, gpu: GpuClip, placement: GeoclipPlacement) =>
      createGeoclipNodeMock(clip, gpu, placement)
  };
});

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };

// --- fixtures ---------------------------------------------------------------------------------------------------

/** The product default: a 1-frame baked still, which is what makes the geoclip the only thing that can animate. */
function bakedStill(): LoadedSpineClip {
  const bitmap = { close() {} } as unknown as ImageBitmap;
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 0,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      { index: 0, offsetX: 1, offsetY: 2, width: 10, height: 20, durationMs: 0, startMs: 0, png: new Uint8Array(), bitmap }
    ],
    stillUrl: null,
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
}

const MANIFEST_PLACEMENT = {
  canvasWidth: 300,
  canvasHeight: 400,
  localX: -111,
  localY: -222,
  localWidth: 150,
  localHeight: 200,
  fitScale: 2
};

function geoclip(frames: number, placement: GeoclipClip["placement"] = null): GeoclipClip {
  return {
    schema: "geoclip/1",
    anim: "idle_loop",
    fps: 20,
    frameCount: frames,
    durationMs: (frames / 20) * 1000,
    pages: [],
    parts: new Map(),
    frames: Array.from({ length: frames }, () => ({ drawOrder: null, slots: new Map() })),
    vertsBin: null,
    placement,
    fileUrl: (file: string) => file
  };
}

/** `drawOk` refuses a frame the way a lost GL context does — see the mid-animation fallback case. */
function fakeGeoclipNode(
  { drawOk }: { drawOk?: (index: number) => boolean } = {}
): GeoclipNode & { drawn: number[]; disposed: number } {
  const el = document.createElement("canvas");
  el.className = "mirror-geoclip-canvas";
  const drawn: number[] = [];
  const node = {
    el,
    drawn,
    disposed: 0,
    place: vi.fn(),
    draw(index: number) {
      drawn.push(index);
      return drawOk ? drawOk(index) : true;
    },
    dispose() {
      node.disposed++;
      el.remove();
    }
  };
  return node;
}

function spineNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "spine",
    parentId: null,
    name: "SpineSprite",
    nodeType: "SpineSprite",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 960, y: 540 } },
    visible: true,
    spine: { sceneResPath: "res://scenes/creature.tscn", nodePath: "Vis/Spine", animations: ["idle_loop", "attack"] },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0,
    ...over
  };
}

// --- harness ----------------------------------------------------------------------------------------------------

let renderer: MirrorRenderer | null = null;
let state: MirrorState;
/** Every frame callback the renderer has booked and not yet had run. */
let pendingRaf: FrameRequestCallback[] = [];
let rafBooked = 0;

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Run every pending frame callback until the renderer stops booking new ones (or the bound is hit). Draining is
 * what lets `tickRaf` fall back to 0 — without it `scheduleTick` returns at its "a wake is already in flight"
 * guard and NOTHING later could book anything, which would make every count below trivially zero.
 */
function drainRaf(rounds = 8): void {
  for (let i = 0; i < rounds && pendingRaf.length > 0; i++) {
    const batch = pendingRaf;
    pendingRaf = [];
    for (const cb of batch) {
      cb(performance.now());
    }
  }
}

function reconcile(nodes: Record<string, unknown>[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: nodes,
      orderedIds: nodes.map((n) => String(n.id))
    })!
  );
  renderer!.reconcile(state);
}

function host(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-node-id="spine"]');
}

beforeEach(() => {
  document.body.innerHTML = "";
  pendingRaf = [];
  rafBooked = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafBooked++;
    pendingRaf.push(cb);
    return rafBooked;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // `spineClipFps: 0` = uncapped, so an armed spine set is due IMMEDIATELY and takes `scheduleTick`'s frame-callback
  // branch rather than its `setTimeout` one. That is what makes "did the mount wake the loop?" a single counter.
  __setRenderQualityForTest({
    ...resolveRenderQuality({ search: "?quality=high&spineClips=on", gpu: UNKNOWN_GPU }),
    spineClipFps: 0
  });
  // The geoclip-specific cases below exercise the explicit developer lane. The ordinary static viewer has a
  // separate regression case immediately below and must never even probe a manifest.
  mirrorSettings.spineMode = "dynamic";
  loadSpineClipMock.mockReset();
  loadSpineClipMock.mockResolvedValue(bakedStill());
  probeGeoclipMock.mockReset();
  uploadGeoclipMock.mockReset();
  createGeoclipNodeMock.mockReset();
  __clearGeoclipProbesForTest();
  state = createMirrorState();
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  renderer = createMirrorRenderer(stage, defs);
});

afterEach(() => {
  renderer = null;
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static";
  // Back to the PRODUCT DEFAULT (the settings store is an app-wide singleton).
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- A STATIC POSE MUST NOT WAKE THE rAF --------------------------------------------------------------------------

describe("the default static DOM lane", () => {
  it("requests only the baked still and never probes geoclips", async () => {
    mirrorSettings.spineMode = "static";
    reconcile([spineNode()]);
    await flush();

    expect(loadSpineClipMock).toHaveBeenCalledWith("/spines/scenes/creature.tscn?node=Vis%2FSpine&anim=idle_loop&still=1");
    expect(probeGeoclipMock).not.toHaveBeenCalled();
    expect(createGeoclipNodeMock).not.toHaveBeenCalled();
  });
});

describe("a geoclip only wakes the DOM renderer's animation loop if it has frames to show", () => {
  /**
   * Settle a reconcile with the geoclip UPLOAD held pending, drain the renderer to a park, and hand back the
   * release. Every frame callback counted after `release()` was booked by the mount itself.
   */
  async function mountLater(clip: GeoclipClip): Promise<() => void> {
    probeGeoclipMock.mockResolvedValue(clip);
    createGeoclipNodeMock.mockReturnValue(fakeGeoclipNode());
    let releaseUpload: (gpu: GpuClip) => void = () => {};
    uploadGeoclipMock.mockImplementation(() => new Promise<GpuClip>((r) => (releaseUpload = r)));

    reconcile([spineNode()]);
    await flush();
    drainRaf();
    await flush();
    drainRaf();
    // THE PRECONDITION, asserted rather than assumed: with only a 1-frame baked still on screen the renderer has
    // parked. If it had not, the counts below would be measuring something else entirely.
    expect(pendingRaf).toHaveLength(0);
    rafBooked = 0;
    return () => releaseUpload({ parts: new Map() } as GpuClip);
  }

  it("a ONE-FRAME geoclip mounts, draws once, and books NO frame callback", async () => {
    const release = await mountLater(geoclip(1));
    release();
    await flush();

    // Mounted and painting — the half a blunt "never animate a geoclip" fix would lose.
    expect(host()!.querySelector("canvas.mirror-geoclip-canvas")).not.toBeNull();
    expect(host()!.classList.contains("mirror-geoclip-live")).toBe(true);
    expect(createGeoclipNodeMock.mock.results[0].value.drawn).toEqual([0]);
    // …and the renderer stayed parked. This is the whole deliverable.
    expect(rafBooked).toBe(0);
    expect(pendingRaf).toHaveLength(0);
  });

  it("…and a MULTI-frame one DOES — the control that keeps the assertion above from being vacuous", async () => {
    const release = await mountLater(geoclip(4));
    release();
    await flush();

    expect(host()!.querySelector("canvas.mirror-geoclip-canvas")).not.toBeNull();
    expect(rafBooked).toBeGreaterThan(0);
  });

  it("a MULTI-frame geoclip released by an anim change lets the loop park again", async () => {
    // The release rule has to mirror the mount rule, or the tick set keeps a member with nothing left to paint.
    const release = await mountLater(geoclip(4));
    release();
    await flush();
    expect(rafBooked).toBeGreaterThan(0);

    probeGeoclipMock.mockResolvedValue(null); // the next animation has no bake at all
    reconcile([spineNode({ spineCurrentAnim: "attack" })]);
    await flush();
    drainRaf();
    await flush();
    drainRaf();
    expect(pendingRaf).toHaveLength(0);
  });
});

describe("a live DOM auto → static switch", () => {
  it("releases active geometry even when both modes use the same baked-still URL", async () => {
    __setRenderQualityForTest({
      ...resolveRenderQuality({ search: "?quality=min", gpu: UNKNOWN_GPU }),
      spineClipFps: 0
    });
    mirrorSettings.spineMode = "auto";
    const geoclipNode = fakeGeoclipNode();
    probeGeoclipMock.mockResolvedValue(geoclip(4));
    uploadGeoclipMock.mockResolvedValue({ parts: new Map() } as GpuClip);
    createGeoclipNodeMock.mockReturnValue(geoclipNode);

    reconcile([spineNode()]);
    await flush();
    expect(host()!.classList.contains("mirror-geoclip-live")).toBe(true);
    expect(loadSpineClipMock.mock.calls).toHaveLength(1);
    expect(loadSpineClipMock.mock.calls[0][0]).toBe("/spines/scenes/creature.tscn?node=Vis%2FSpine&anim=idle_loop&still=1");

    mirrorSettings.spineMode = "static";
    renderer!.reconcile(state, { forceTextures: true });
    await flush();

    expect(geoclipNode.disposed).toBe(1);
    expect(host()!.classList.contains("mirror-geoclip-live")).toBe(false);
    expect(host()!.querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
    // No new raster request: `auto` on a still-only tier and `static` have the same identity. The mounted
    // baked layer is simply revealed when the explicit geometry opt-in turns off.
    expect(loadSpineClipMock.mock.calls).toHaveLength(1);

    const rearmed = fakeGeoclipNode();
    createGeoclipNodeMock.mockReturnValue(rearmed);
    mirrorSettings.spineMode = "auto";
    renderer!.reconcile(state, { forceTextures: true });
    await flush();
    expect(probeGeoclipMock).toHaveBeenCalledTimes(2);
    expect(host()!.querySelector("canvas.mirror-geoclip-canvas")).toBe(rearmed.el);

    // The desired-state reconciliation is idempotent while this identity's probe is live.
    renderer!.reconcile(state, { forceTextures: true });
    await flush();
    expect(probeGeoclipMock).toHaveBeenCalledTimes(2);
  });
});

describe("DOM geoclip teardown when a retained node stops being a spine", () => {
  const retainedNode = () =>
    spineNode({ localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 100 } } });

  it("disposes mounted geometry on dynamic → off even though the record remains", async () => {
    const geoclipNode = fakeGeoclipNode();
    probeGeoclipMock.mockResolvedValue(geoclip(4));
    uploadGeoclipMock.mockResolvedValue({ parts: new Map() } as GpuClip);
    createGeoclipNodeMock.mockReturnValue(geoclipNode);
    reconcile([retainedNode()]);
    await flush();
    expect(host()!.classList.contains("mirror-geoclip-live")).toBe(true);

    mirrorSettings.spineMode = "off";
    renderer!.reconcile(state, { forceTextures: true });
    await flush();

    expect(host()).not.toBeNull();
    expect(geoclipNode.disposed).toBe(1);
    expect(document.querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
  });

  it("invalidates a pending upload so it cannot mount after dynamic → off", async () => {
    let releaseUpload: (gpu: GpuClip) => void = () => {};
    probeGeoclipMock.mockResolvedValue(geoclip(4, MANIFEST_PLACEMENT));
    uploadGeoclipMock.mockImplementation(() => new Promise<GpuClip>((resolve) => (releaseUpload = resolve)));
    createGeoclipNodeMock.mockReturnValue(fakeGeoclipNode());
    reconcile([retainedNode()]);
    await flush();
    expect(uploadGeoclipMock).toHaveBeenCalledTimes(1);

    mirrorSettings.spineMode = "off";
    renderer!.reconcile(state, { forceTextures: true });
    releaseUpload({ parts: new Map() } as GpuClip);
    await flush();

    expect(host()).not.toBeNull();
    expect(createGeoclipNodeMock).not.toHaveBeenCalled();
    expect(document.querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
  });
});

// --- PLACEMENT FROM THE MANIFEST ----------------------------------------------------------------------------------

describe("the DOM path mounts a geoclip that states its own placement without any baked clip", () => {
  it("mounts with the raster clip still in flight", async () => {
    probeGeoclipMock.mockResolvedValue(geoclip(4, MANIFEST_PLACEMENT));
    uploadGeoclipMock.mockResolvedValue({ parts: new Map() } as GpuClip);
    createGeoclipNodeMock.mockReturnValue(fakeGeoclipNode());
    loadSpineClipMock.mockImplementation(() => new Promise<LoadedSpineClip>(() => {})); // never resolves

    reconcile([spineNode()]);
    await flush();

    expect(host()!.querySelector("canvas.mirror-geoclip-canvas")).not.toBeNull();
    expect(createGeoclipNodeMock.mock.calls[0][2]).toEqual({
      canvasWidth: 300,
      canvasHeight: 400,
      localX: -111,
      localY: -222,
      localWidth: 150,
      fitScale: 2
    });
  });

  it("still waits for the baked clip when the manifest states nothing (every pre-Phase-4 bake)", async () => {
    probeGeoclipMock.mockResolvedValue(geoclip(4));
    uploadGeoclipMock.mockResolvedValue({ parts: new Map() } as GpuClip);
    createGeoclipNodeMock.mockReturnValue(fakeGeoclipNode());
    loadSpineClipMock.mockImplementation(() => new Promise<LoadedSpineClip>(() => {}));

    reconcile([spineNode()]);
    await flush();
    expect(createGeoclipNodeMock).not.toHaveBeenCalled();
  });
});

// --- raster-first configuration ------------------------------------------------------------------------------------

describe("the raster-first DOM path", () => {
  it("requests /spines/ up front while geoclip playback probes", async () => {
    probeGeoclipMock.mockResolvedValue(geoclip(4, MANIFEST_PLACEMENT));
    uploadGeoclipMock.mockResolvedValue({ parts: new Map() } as GpuClip);
    createGeoclipNodeMock.mockReturnValue(fakeGeoclipNode());

    reconcile([spineNode()]);
    expect(loadSpineClipMock.mock.calls.length).toBeGreaterThan(0);
    await flush();
    // …and the baked layer stays requested-and-hidden under the live geoclip: the fallback rule, intact.
    expect(host()!.classList.contains("mirror-geoclip-live")).toBe(true);
    expect(host()!.querySelector("canvas.mirror-spine-canvas, img.mirror-spine-img")).not.toBeNull();
  });
});
