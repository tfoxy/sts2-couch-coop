import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorRenderer, type MirrorRenderer, } from "@/mirror/mirrorRenderer";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import type { LoadedSpineClip } from "@/mirror/spineClip";
import { mirrorSettings } from "@/mirror/mirrorSettings";

// A full-clip tier fetches a cheap 1-frame still first (paints
// frame 0 in ~0.5-1s), then CHAINS the full animated clip and hot-swaps it in. These specs drive the reconciler
// against a mocked loadSpineClip that returns DIFFERENT clips for the still URL (&still=1) vs the animated URL, so
// we can assert: the still fires before the clip; the deliberate 1-frame still skips retry=1 escalation; the
// animated clip swaps in; a late still can't clobber the swapped-in animation; and a low/very-low tier is
// byte-identical (its own still-only path is unchanged).
const { loadSpineClipMock, dropCacheEntryMock } = vi.hoisted(() => ({
  loadSpineClipMock: vi.fn(),
  dropCacheEntryMock: vi.fn()
}));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return {
    ...actual,
    loadSpineClip: (url: string) => loadSpineClipMock(url),
    dropSpineClipCacheEntry: (url: string) => dropCacheEntryMock(url)
  };
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

// Distinct frame bitmaps so the mocked ctx.drawImage tells the STILL apart from the ANIMATED clip on the canvas.
const STILL_BMP = { id: "still" } as unknown as ImageBitmap;
const ANIM0_BMP = { id: "anim0" } as unknown as ImageBitmap;
const ANIM1_BMP = { id: "anim1" } as unknown as ImageBitmap;

// A 1-frame STILL clip (what &still=1 returns): canvas 100 wide → node-local 100 wide ⇒ scale 1; origin (-50,-75).
function stillClip(): LoadedSpineClip {
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 0,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      { index: 0, offsetX: 1, offsetY: 2, width: 10, height: 20, durationMs: 0, startMs: 0, png: new Uint8Array(), bitmap: STILL_BMP }
    ],
    stillUrl: null,
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
}

// The full ANIMATED clip (2 frames — the same cell-invariant placement so the swap is seamless).
function animClip(): LoadedSpineClip {
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 300,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      { index: 0, offsetX: 1, offsetY: 2, width: 10, height: 20, durationMs: 150, startMs: 0, png: new Uint8Array(), bitmap: ANIM0_BMP },
      { index: 1, offsetX: 3, offsetY: 4, width: 11, height: 21, durationMs: 150, startMs: 150, png: new Uint8Array(), bitmap: ANIM1_BMP }
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

function spineNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "spine",
    parentId: null,
    name: "SpineSprite",
    nodeType: "SpineSprite",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 960, y: 540 } },
    visible: true,
    spine: {
      sceneResPath: "res://scenes/events/background_scenes/neow.tscn",
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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const isStillUrl = (url: string): boolean => url.includes("still=1");

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
  dropCacheEntryMock.mockReset();
  drawImage.mockReset();
  clearRect.mockReset(); // default; individual tests flip it
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx as unknown as null);
});

afterEach(() => {
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static"; // back to the product defaults (the store is an app-wide singleton)
  vi.restoreAllMocks();
});

describe("mirror spine first-frame-immediate streaming", () => {
  it("requests the STILL url first, paints frame 0, THEN chains the animated clip and hot-swaps it in", async () => {
    useAnimatedSpineLane();
    // Deferreds (not pre-resolved) so the still-painted state is observable BEFORE the animated clip resolves — a
    // pre-resolved chain would drain still→clip in one macrotask flush and hide the intermediate still frame.
    let resolveStill!: (c: LoadedSpineClip) => void;
    let resolveAnim!: (c: LoadedSpineClip) => void;
    loadSpineClipMock.mockImplementation((url: string) =>
      isStillUrl(url)
        ? new Promise<LoadedSpineClip>((res) => (resolveStill = res))
        : new Promise<LoadedSpineClip>((res) => (resolveAnim = res))
    );
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);

    // The FIRST fetch is the cheap still (&still=1) — not the full animated clip.
    expect(loadSpineClipMock).toHaveBeenCalledTimes(1);
    expect(loadSpineClipMock.mock.calls[0][0]).toBe(
      "/spines/scenes/events/background_scenes/neow.tscn?node=Visuals%2FSpineSprite&anim=idle_loop&still=1"
    );

    resolveStill(stillClip());
    await flush(); // still resolves → paint frame 0 + CHAIN the animated clip
    expect(drawImage).toHaveBeenLastCalledWith(STILL_BMP, 1, 2); // still frame 0 painted first
    expect(loadSpineClipMock).toHaveBeenCalledTimes(2);
    expect(loadSpineClipMock.mock.calls[1][0]).toBe(
      "/spines/scenes/events/background_scenes/neow.tscn?node=Visuals%2FSpineSprite&anim=idle_loop"
    ); // the chained animated request carries NO &still=1

    resolveAnim(animClip());
    await flush(); // animated clip resolves → hot-swap
    expect(drawImage).toHaveBeenLastCalledWith(ANIM0_BMP, 1, 2); // animated frame 0 now shown (seamless placement)
    expect(() => renderer.dispose()).not.toThrow();
  });

  it("does not escalate the deliberate 1-frame still down the retry=1 path", async () => {
    useAnimatedSpineLane();
    loadSpineClipMock.mockImplementation((url: string) =>
      Promise.resolve(isStillUrl(url) ? stillClip() : animClip())
    );
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush(); // still (1 frame) painted + animated chained
    await flush(); // animated (2 frames) swapped in

    // Exactly TWO fetches — the still then the animated. The 1-frame still NEVER triggered a &retry=1 escalation refetch.
    expect(loadSpineClipMock).toHaveBeenCalledTimes(2);
    for (const [url] of loadSpineClipMock.mock.calls) {
      expect(url).not.toContain("retry=1");
    }
    expect(() => renderer.dispose()).not.toThrow();
  });

  it("swaps the animated clip into the displayed canvas (it joins the playback set)", async () => {
    useAnimatedSpineLane();
    loadSpineClipMock.mockImplementation((url: string) =>
      Promise.resolve(isStillUrl(url) ? stillClip() : animClip())
    );
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();
    await flush();

    // The 2-frame animated clip is the final painted content (multi-frame ⇒ it joined activeSpine's rAF playback);
    // frame 0 is drawn on the swap even though the still already occupied a same-sized cell (forced repaint).
    expect(drawImage).toHaveBeenLastCalledWith(ANIM0_BMP, 1, 2);
    expect(() => renderer.dispose()).not.toThrow();
  });

  it("a LATE still (from an anim round-trip) does NOT clobber the already-swapped animated clip", async () => {
    useAnimatedSpineLane();
    // Hand out a FRESH deferred per call so an old still and a re-requested still are distinct promises.
    const stillResolvers: Array<(c: LoadedSpineClip) => void> = [];
    const clipResolvers: Array<(c: LoadedSpineClip) => void> = [];
    loadSpineClipMock.mockImplementation((url: string) =>
      isStillUrl(url)
        ? new Promise<LoadedSpineClip>((res) => stillResolvers.push(res))
        : new Promise<LoadedSpineClip>((res) => clipResolvers.push(res))
    );
    const { renderer } = harness();
    const state = createMirrorState();

    // Anim idle_loop: still #0 requested (held pending — the "old" still).
    full(state, [spineNode({ spineCurrentAnim: "idle_loop" })], ["spine"]);
    renderer.reconcile(state);
    // Switch to attack: identity change → still #1 requested (left pending, dropped later).
    volatile(state, [{ id: "spine", parentId: null, spineCurrentAnim: "attack", spineTrackTime: 0.01 }]);
    renderer.reconcile(state);
    // Switch BACK to idle_loop: identity change → still #2 requested (the fresh one we'll resolve).
    volatile(state, [{ id: "spine", parentId: null, spineCurrentAnim: "idle_loop", spineTrackTime: 0.02 }]);
    renderer.reconcile(state);
    expect(stillResolvers.length).toBe(3);

    // Resolve the fresh still #2 → paints, chains the animated clip; then resolve the animated → hot-swap.
    stillResolvers[2](stillClip());
    await flush();
    expect(clipResolvers.length).toBe(1);
    clipResolvers[0](animClip());
    await flush();
    expect(drawImage).toHaveBeenLastCalledWith(ANIM0_BMP, 1, 2); // animated is shown

    // Now the OLD still #0 (same anim idle_loop → identity matches!) resolves LATE. The spineAnimatedShown guard
    // drops it so it can't repaint the stale still over the live animation.
    drawImage.mockClear();
    stillResolvers[0](stillClip());
    await flush();
    expect(drawImage).not.toHaveBeenCalledWith(STILL_BMP, 1, 2); // no clobber — the still was dropped
    expect(() => renderer.dispose()).not.toThrow();
  });

  it("the DEFAULT static spine mode is one still-only fetch, no still-first double request", async () => {
    // No `useAnimatedSpineLane()` here: this is what an ordinary viewer gets. isSpineStillMode() is true (the
    // default mode is `static`), which gates still-first OFF, so there is exactly ONE fetch and no chained clip —
    // and it is the same single-fetch shape the low/very-low TIER produced before the mode default changed.
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=very-low", gpu: UNKNOWN_GPU }));
    loadSpineClipMock.mockImplementation((url: string) =>
      Promise.resolve(isStillUrl(url) ? stillClip() : animClip())
    );
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();
    await flush();

    expect(loadSpineClipMock).toHaveBeenCalledTimes(1); // exactly one — the tier's still, no chained clip
    expect(loadSpineClipMock.mock.calls[0][0]).toBe(
      "/spines/scenes/events/background_scenes/neow.tscn?node=Visuals%2FSpineSprite&anim=idle_loop&still=1"
    );
    expect(drawImage).toHaveBeenLastCalledWith(STILL_BMP, 1, 2);
    expect(() => renderer.dispose()).not.toThrow();
  });

  // Under machine oversubscription the host answers a full-clip request with a single-frame
  // stand-in flagged `degraded`. The renderer must paint it, and must not run the `&retry=1` escalation on it (that would
  // re-ask for the expensive bake, per spine node, exactly when the host declined the work), and must drop its
  // cache entry so a later request for the same identity can get the real clip.
  it("paints a host-DEGRADED single-frame clip without escalating, and drops its cache entry", async () => {
    useAnimatedSpineLane();
    loadSpineClipMock.mockImplementation(() => Promise.resolve({ ...stillClip(), degraded: true }));
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();
    await flush();

    const animatedUrl =
      "/spines/scenes/events/background_scenes/neow.tscn?node=Visuals%2FSpineSprite&anim=idle_loop";
    expect(loadSpineClipMock).toHaveBeenCalledTimes(2); // still-first + ONE animated fetch, no retry storm
    expect(loadSpineClipMock.mock.calls[1][0]).toBe(animatedUrl);
    expect(drawImage).toHaveBeenLastCalledWith(STILL_BMP, 1, 2); // the stand-in frame IS painted
    expect(dropCacheEntryMock).toHaveBeenCalledWith(animatedUrl); // …and never left in the LRU
    expect(() => renderer.dispose()).not.toThrow();
  });

  // Control: the SAME 1-frame clip WITHOUT the degraded flag still escalates once — proving the guard above keys on
  // the host's marker and not on some unrelated change to the single-frame path.
  it("still escalates an unflagged single-frame animated clip", async () => {
    useAnimatedSpineLane();
    loadSpineClipMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes("retry=1") ? animClip() : stillClip())
    );
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();
    await flush();

    expect(loadSpineClipMock).toHaveBeenCalledTimes(3);
    expect(loadSpineClipMock.mock.calls[2][0]).toContain("retry=1");
    expect(() => renderer.dispose()).not.toThrow();
  });
});
