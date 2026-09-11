import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,
  __resetAtlasDecodeGateForTest,






  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  atlasRegionBlobUrl,
  atlasRegionKey,
  onAtlasRegionsReady,
  preloadAtlas,
  __publishRegionBlobForTest,
  __regionBlobCountForTest,
  __regionWaitersForTest,
  __resetAtlasCacheForTest,
  __setAtlasPageSizeForTest
} from "@/mirror/atlasBaker";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import type { LoadedSpineClip } from "@/mirror/spineClip";
import { __setStillDecoderForTest, type StillDecoder } from "@/mirror/stillDecode";
import { onTextureSizesResolved, __recordTextureSizeForTest, __resetTextureCacheForTest, __textureWaitersForTest } from "@/mirror/textureCache";

// R10-PERF4 WS-4 — COMPOSITED-LAYER REDUCTION.
//
// Every <canvas> is an unconditionally promoted composited layer, and each promotion forces `Overlap` promotions on
// whatever paints above it (a settled combat measured 115 layers: Canvas×38 + Overlap×44). These specs pin the two
// mechanisms that replace a canvas with an ordinary painted element, and — the part that is easy to get subtly
// wrong — the ASYNC EDGES around them:
//
//   1. atlas sprites paint a `background-image` DIV over the region's baked blob, falling back to the canvas
//      whenever that blob isn't ready (first paint, and a region CHANGE that outruns its bake), swapping in through
//      the targeted-restyle seam when it lands.
//   2. a STILL (single-frame) spine clip paints an <img>; a DYNAMIC clip keeps the canvas, and a mode transition
//      swaps the element cleanly (never leaving both attached).
//
// jsdom has no canvas 2D context, no OffscreenCanvas and no blob encoder, so a REAL bake can never complete here —
// which is exactly why `atlasRegionBlobUrl` answers null by default in these specs and the div path has to be
// driven through `__publishRegionBlobForTest` (the seam that stands in for a completed encode, mirroring
// textureCache's `__recordTextureSizeForTest`).
//
// STAGE C (img-first sprites) updated the PLACEHOLDER half of item 1: while a region is unbaked/undecoded (or the
// baker is suspended / the node went sticky) the sprite paints a PAGE-CROP DIV (`.mirror-atlas-page`,
// regionBackgroundStyle over the atlas page) instead of the synchronous `<canvas>` — no composited layer at any
// point of the sprite's life. Item 2 adds the blob decode gate at the swap commit point.
const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

// The page WARM is observed rather than inferred: the size gate's second half is that a page nobody page-crops is
// never handed to the browser's image cache either. The spy forwards to the real cache, so every existing
// assertion about natural sizes / texture waiters still runs against the genuine module.
const { warmImageSpy } = vi.hoisted(() => ({ warmImageSpy: vi.fn() }));
vi.mock("@/mirror/textureCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/textureCache")>();
  return {
    ...actual,
    warmImage: (url: string) => {
      warmImageSpy(url);
      actual.warmImage(url);
    }
  };
});

type Raw = Record<string, unknown>;

const rect = (x: number, y: number, w: number, h: number) => ({ position: { x, y }, size: { x: w, y: h } });
const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });

const ATLAS = "/res/images/atlas.png";
const REGION_A = { x: 4, y: 8, width: 48, height: 48 };
const REGION_B = { x: 60, y: 8, width: 48, height: 48 };

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

function sprite(id: string, region: { x: number; y: number; width: number; height: number }, visible = true): Raw {
  return {
    id,
    parentId: "Game",
    name: id,
    nodeType: "Sprite2D",
    visible,
    transform: xf(100, 100),
    localRect: rect(0, 0, 48, 48),
    texture: { resourcePath: "res://images/atlas.png", resourceType: "Texture2D" },
    textureRegion: { position: { x: region.x, y: region.y }, size: { x: region.width, y: region.height } }
  };
}

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

// The renderer's targeted-restyle seam, wired exactly as MirrorView wires it: a resolved region hands the renderer
// the ids that styled provisionally against it and a NORMAL (non-forced) reconcile follows.
function wireRegionSeam(renderer: MirrorRenderer, state: MirrorState): () => void {
  return onAtlasRegionsReady((ids) => {
    renderer.markTextureDirty(ids);
    renderer.reconcile(state);
  });
}

let unwire: (() => void) | null = null;
let unwireSizes: (() => void) | null = null;

// SPINE SOURCE. These cases are about the RASTER lane — the `/spines/` request, its still/canvas paint
// mechanism and its clock. These cases pin the raster lane so their synchronous-fetch assertions stay isolated;
// the explicit delta experiment's fallback ordering is covered by domGeoclip.spec.ts / canvasGeoclip.spec.ts.
beforeEach(() => {
  __resetAtlasCacheForTest();
  __resetAtlasDecodeGateForTest();
  __resetTextureCacheForTest();
  loadSpineClipMock.mockReset();
  warmImageSpy.mockClear();
});

afterEach(() => {
  unwire?.();
  unwire = null;
  unwireSizes?.();
  unwireSizes = null;
  document.body.innerHTML = "";
  __setStillDecoderForTest(null);
  __resetAtlasCacheForTest();
  __resetAtlasDecodeGateForTest();
  __resetTextureCacheForTest();
});

// ---------------------------------------------------------------------------------------------------------------
// item 1a — the region-blob cache itself
// ---------------------------------------------------------------------------------------------------------------

describe("atlasBaker region blobs", () => {
  it("keys a region by page url + exact source rect", () => {
    expect(atlasRegionKey(ATLAS, REGION_A)).toBe(`${ATLAS}|4,8,48,48`);
    expect(atlasRegionKey(ATLAS, REGION_B)).not.toBe(atlasRegionKey(ATLAS, REGION_A));
    expect(atlasRegionKey("/res/other.png", REGION_A)).not.toBe(atlasRegionKey(ATLAS, REGION_A));
  });

  it("registers the styling node on a miss and DEDUPES waiters per region", () => {
    expect(atlasRegionBlobUrl(ATLAS, REGION_A, "a")).toBeNull();
    expect(atlasRegionBlobUrl(ATLAS, REGION_A, "b")).toBeNull();
    expect(atlasRegionBlobUrl(ATLAS, REGION_A, "a")).toBeNull(); // same node asking twice
    expect(atlasRegionBlobUrl(ATLAS, REGION_B, "c")).toBeNull();
    expect(__regionWaitersForTest(ATLAS, REGION_A).sort()).toEqual(["a", "b"]);
    expect(__regionWaitersForTest(ATLAS, REGION_B)).toEqual(["c"]);
  });

  it("bakes ONCE per distinct region and serves the cached url afterwards", () => {
    atlasRegionBlobUrl(ATLAS, REGION_A, "a");
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    expect(__regionBlobCountForTest()).toBe(1);
    // Every later ask is a cache hit: same url, no new waiters, no second bake.
    expect(atlasRegionBlobUrl(ATLAS, REGION_A, "b")).toBe("blob:region-a");
    expect(atlasRegionBlobUrl(ATLAS, REGION_A, null)).toBe("blob:region-a");
    expect(__regionWaitersForTest(ATLAS, REGION_A)).toEqual([]);
    expect(__regionBlobCountForTest()).toBe(1);
    // A DIFFERENT region of the same page is its own entry.
    atlasRegionBlobUrl(ATLAS, REGION_B, "c");
    __publishRegionBlobForTest(ATLAS, REGION_B, "blob:region-b");
    expect(__regionBlobCountForTest()).toBe(2);
    expect(atlasRegionBlobUrl(ATLAS, REGION_B, null)).toBe("blob:region-b");
  });

  it("hands a resolved region's waiter ids to the listener exactly once, then forgets them", () => {
    const seen: string[][] = [];
    unwire = onAtlasRegionsReady((ids) => seen.push([...ids].sort()));
    atlasRegionBlobUrl(ATLAS, REGION_A, "a");
    atlasRegionBlobUrl(ATLAS, REGION_A, "b");
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    expect(seen).toEqual([["a", "b"]]);
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a"); // a redundant publish notifies nobody
    expect(seen).toEqual([["a", "b"]]);
  });

  it("preloadAtlas does not bake regions (it only warms the page)", () => {
    preloadAtlas(ATLAS);
    expect(__regionBlobCountForTest()).toBe(0);
    expect(__regionWaitersForTest(ATLAS, REGION_A)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// item 1b — the renderer's canvas ⇄ div state machine
// ---------------------------------------------------------------------------------------------------------------

describe("atlas sprite paint mechanism", () => {
  it("paints through the PAGE-CROP DIV while the blob is unbaked, and registers the node for the swap", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);

    const icon = el(stage, "Icon");
    // Stage C item 1: the placeholder is a page-crop div — NO canvas at any point of an unbaked sprite's life.
    const page = icon.querySelector("div.mirror-atlas-page") as HTMLElement | null;
    expect(page, "the placeholder is a div").not.toBeNull();
    expect(icon.querySelector("canvas.mirror-atlas-canvas")).toBeNull();
    expect(icon.querySelector("div.mirror-atlas-region")).toBeNull();
    expect(stage.querySelectorAll("canvas").length).toBe(0);
    // The crop is gsw's regionBackgroundStyle: box == region ⇒ scale 1 ⇒ position −x,−y, native page scale until
    // the page's natural size lands (then the identical explicit size — see the crop-rewrite spec below).
    expect(page!.style.backgroundImage).toBe(`url("${ATLAS}")`);
    expect(page!.style.backgroundPosition).toBe("-4px -8px");
    expect(page!.style.backgroundSize).toBe("auto");
    expect(__regionWaitersForTest(ATLAS, REGION_A)).toEqual(["Icon"]);
    // …and the page url was re-warmed (a3d4ff2's skip re-enabled): the natural-size MISS registered the node for
    // the targeted re-style that rewrites the crop when the measurement lands.
    expect(__textureWaitersForTest(ATLAS)).toEqual(["Icon"]);
  });

  it("swaps page-div → region-div when the blob lands, through the targeted-restyle seam", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-page")).not.toBeNull();

    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");

    const icon = el(stage, "Icon");
    const div = icon.querySelector("div.mirror-atlas-region") as HTMLElement | null;
    expect(div, "the sprite swapped to the blob div").not.toBeNull();
    expect(div!.style.backgroundImage).toBe('url("blob:region-a")');
    // TEARDOWN IS EXACT: the placeholder is gone from the record AND from the DOM — never both attached. The
    // blob div carries NO inline crop (its class stretches the blob 100%/100%).
    expect(icon.querySelector("div.mirror-atlas-page")).toBeNull();
    expect(div!.style.backgroundPosition).toBe("");
    expect(div!.style.backgroundSize).toBe("");
    expect(stage.querySelectorAll("canvas").length).toBe(0);
  });

  it("uses the div directly (no canvas at all) when the blob is already cached", () => {
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);

    const icon = el(stage, "Icon");
    expect(icon.querySelector("div.mirror-atlas-region")).not.toBeNull();
    expect(stage.querySelectorAll("canvas").length).toBe(0);
  });

  it("a region CHANGE to an unbaked region reverts div → page-crop placeholder, then swaps back when it bakes", () => {
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-region")).not.toBeNull();

    // Frame 2 of an animated icon: a region whose blob does not exist yet ⇒ back to the synchronous mechanism —
    // which is now the page-crop div, never a canvas.
    update(state, [sprite("Icon", REGION_B)]);
    renderer.reconcile(state);
    let icon = el(stage, "Icon");
    const page = icon.querySelector("div.mirror-atlas-page") as HTMLElement | null;
    expect(page, "reverted to the page-crop placeholder").not.toBeNull();
    expect(page!.style.backgroundPosition).toBe("-60px -8px");
    expect(icon.querySelector("div.mirror-atlas-region")).toBeNull();
    expect(stage.querySelectorAll("canvas").length).toBe(0);
    expect(__regionWaitersForTest(ATLAS, REGION_B)).toEqual(["Icon"]);

    __publishRegionBlobForTest(ATLAS, REGION_B, "blob:region-b");
    icon = el(stage, "Icon");
    const div = icon.querySelector("div.mirror-atlas-region") as HTMLElement | null;
    expect(div, "swapped back to a div").not.toBeNull();
    expect(div!.style.backgroundImage).toBe('url("blob:region-b")');
    expect(icon.querySelector("div.mirror-atlas-page")).toBeNull();
  });

  it("keeps the mechanism-agnostic placement styles across a swap (INTERIOR node fit)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    // An INTERIOR atlas node: the container keeps the pure localRect placement, so the SPRITE element carries the
    // keep-aspect fit — the case where a swap could plausibly lose geometry.
    const parent: Raw = {
      ...sprite("Icon", REGION_A),
      localRect: rect(0, 0, 96, 24),
      textureStretchMode: 5 // keep-aspect-centered
    };
    full(state, [ROOT, parent, { id: "Kid", parentId: "Icon", name: "Kid", nodeType: "Godot.Control", visible: true }]);
    renderer.reconcile(state);

    // The placeholder (page-crop div under Stage C) carries the fit; the swapped-in blob div must reproduce it.
    const canvas = el(stage, "Icon").querySelector("div.mirror-atlas-page") as HTMLElement;
    const geometry = {
      width: canvas.style.width,
      height: canvas.style.height,
      transform: canvas.style.transform,
      transformOrigin: canvas.style.transformOrigin,
      inset: canvas.style.inset
    };
    expect(geometry.transform).not.toBe("");

    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    const div = el(stage, "Icon").querySelector("div.mirror-atlas-region") as HTMLElement;
    expect({
      width: div.style.width,
      height: div.style.height,
      transform: div.style.transform,
      transformOrigin: div.style.transformOrigin,
      inset: div.style.inset
    }).toEqual(geometry);
  });

  it("goes STICKY after three reverts — settling on the page-crop DIV (never a canvas), and no more blob asks", () => {
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-region")).not.toBeNull();

    // Three cycle steps that each land before their bake: div → placeholder (revert), then back when it resolves.
    for (let i = 0; i < 3; i++) {
      const region = { x: 200 + i * 50, y: 8, width: 48, height: 48 };
      update(state, [sprite("Icon", region)]);
      renderer.reconcile(state);
      expect(el(stage, "Icon").querySelector("div.mirror-atlas-page"), `revert ${i}`).not.toBeNull();
      expect(stage.querySelectorAll("canvas").length, `revert ${i} stays canvas-free`).toBe(0);
      __publishRegionBlobForTest(ATLAS, region, `blob:cycle-${i}`);
    }
    // The third revert tripped the limit: the node is pinned to the page-crop div even though the blob IS cached
    // now — sticky governs the blob-swap CHURN under Stage C, not canvas-vs-div, so the degraded steady state is
    // still a plain painted div (a region change from here is a background-position write on a stable element).
    update(state, [sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    const icon = el(stage, "Icon");
    expect(icon.querySelector("div.mirror-atlas-page")).not.toBeNull();
    expect(stage.querySelectorAll("div.mirror-atlas-region").length).toBe(0);
    expect(stage.querySelectorAll("canvas").length).toBe(0);
    // …and a sticky node never re-enters the bake pipeline: a fresh unbaked region gains no waiter.
    const FRESH = { x: 900, y: 8, width: 48, height: 48 };
    const pageBefore = icon.querySelector("div.mirror-atlas-page");
    update(state, [sprite("Icon", FRESH)]);
    renderer.reconcile(state);
    expect(__regionWaitersForTest(ATLAS, FRESH)).toEqual([]);
    // The SAME element took the new crop — no element swap for a sticky cycler.
    const pageAfter = el(stage, "Icon").querySelector("div.mirror-atlas-page") as HTMLElement;
    expect(pageAfter).toBe(pageBefore);
    expect(pageAfter.style.backgroundPosition).toBe("-900px -8px");
  });

  it("a multi-frame intent glyph on the TICK path keeps its canvas (the blit target)", () => {
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const glyph: Raw = {
      ...sprite("Intent", REGION_A),
      intentFrames: {
        animationName: "attack",
        fps: 15,
        frames: [
          { atlasPath: "res://images/atlas.png", region: { position: { x: 4, y: 8 }, size: { x: 48, y: 48 } } },
          { atlasPath: "res://images/atlas.png", region: { position: { x: 60, y: 8 }, size: { x: 48, y: 48 } } }
        ]
      }
    };
    full(state, [ROOT, glyph]);
    renderer.reconcile(state);
    // Either the compositor strip (default) or the tick canvas — but NEVER a region div, which the per-frame
    // `drawAtlasRegion` blit could not paint into.
    expect(stage.querySelectorAll("div.mirror-atlas-region").length).toBe(0);
  });

  it("drops BOTH mechanisms when the node stops being an atlas sprite", () => {
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-region")).not.toBeNull();

    update(state, [{ ...sprite("Icon", REGION_A), texture: null, textureRegion: null }]);
    renderer.reconcile(state);
    expect(stage.querySelectorAll("div.mirror-atlas-region").length).toBe(0);
    expect(stage.querySelectorAll("canvas.mirror-atlas-canvas").length).toBe(0);
  });

  it("WS-3 interplay: a hidden-ancestor node creates NEITHER element, and styles the default path on reveal", () => {
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const hiddenRoot: Raw = { id: "Dialog", parentId: "Game", name: "Dialog", nodeType: "Godot.Control", visible: false };
    full(state, [ROOT, hiddenRoot, { ...sprite("Icon", REGION_A), parentId: "Dialog" }]);
    renderer.reconcile(state);
    expect(stage.querySelectorAll("canvas.mirror-atlas-canvas").length).toBe(0);
    expect(stage.querySelectorAll("div.mirror-atlas-region").length).toBe(0);

    update(state, [{ ...hiddenRoot, visible: true }]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-region")).not.toBeNull();
    expect(stage.querySelectorAll("canvas.mirror-atlas-canvas").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Aug-19 — the page-crop placeholder's SIZE GATE (`?atlasPageCropMaxMp`)
//
// A page-crop placeholder paints `background-image: url(page)`, which hands the WHOLE page to the compositor's
// decode + upload path; for a card atlas (4032×4072) a card-draw trace measured 76-238ms of stalled frame
// production with nothing on the main thread. So above the gate the placeholder goes back to a canvas — filled by
// `drawImage` from the bitmap this process already holds, which is why "size known" (atlasBaker decoded it) is
// exactly the condition the gate reads. Below the gate nothing moves: the map's atlases keep the Stage-C div.
// ---------------------------------------------------------------------------------------------------------------

describe("page-crop placeholder size gate", () => {
  const BIG = { width: 4032, height: 4072 }; // card_atlas_0 — 16.42 MP
  const SMALL = { width: 2048, height: 2048 }; // ui_atlas_0 — 4.19 MP

  afterEach(() => {
  });

  it("a BIG page never page-crops: the placeholder is a canvas and the page url is not warmed", () => {
    __setAtlasPageSizeForTest(ATLAS, BIG);
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);

    const icon = el(stage, "Icon");
    expect(icon.querySelector("canvas.mirror-atlas-canvas"), "the placeholder is a canvas").not.toBeNull();
    expect(stage.querySelectorAll("div.mirror-atlas-page").length, "NO page-crop div anywhere").toBe(0);
    // …and the node is still queued for its blob, so this is a placeholder, not a regression to canvas-forever.
    expect(__regionWaitersForTest(ATLAS, REGION_A)).toEqual(["Icon"]);
    // The ~37MB double fetch is gone with it: nothing paints this url as CSS, so nothing warms it.
    expect(warmImageSpy.mock.calls.map((call) => call[0])).not.toContain(ATLAS);
    expect(__textureWaitersForTest(ATLAS)).toEqual([]);
  });

  it("a SMALL page keeps the Stage-C page-crop div exactly (the regression pin)", () => {
    __setAtlasPageSizeForTest(ATLAS, SMALL);
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);

    const page = el(stage, "Icon").querySelector("div.mirror-atlas-page") as HTMLElement | null;
    expect(page, "still a page-crop div").not.toBeNull();
    expect(page!.style.backgroundImage).toBe(`url("${ATLAS}")`);
    expect(page!.style.backgroundPosition).toBe("-4px -8px");
    expect(stage.querySelectorAll("canvas").length).toBe(0);
    expect(warmImageSpy.mock.calls.map((call) => call[0])).toContain(ATLAS);
  });

  it("an UNKNOWN size page-crops (today's behaviour), then upgrades to a canvas once the page decodes", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-page"), "unknown ⇒ page").not.toBeNull();

    // The page finishes decoding and turns out to be a card atlas. The next walk swaps the mechanism — a one-way
    // upgrade, because a decoded bitmap's size is session-stable (nothing here can oscillate).
    __setAtlasPageSizeForTest(ATLAS, BIG);
    update(state, [sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    const icon = el(stage, "Icon");
    expect(icon.querySelector("canvas.mirror-atlas-canvas")).not.toBeNull();
    expect(icon.querySelector("div.mirror-atlas-page")).toBeNull();
  });

  // Aug-20 — THE PAGE-SETTLE WAITER. "Unknown ⇒ page, upgraded on the next walk" is only true if a next walk comes,
  // and for a sprite the hatchery pre-built during the cold prefetch window it never does: nothing about the node
  // changes, so it keeps a page-crop div over a 62MB card atlas and hands the whole page to the raster domain at
  // its first reveal. The renderer now books that walk itself — url → the ids that guessed, woken by
  // `whenAtlasSettled`. (`__setAtlasPageSizeForTest` fires those listeners, which is what makes it the seam here.)
  it("upgrades a blind page guess with NO walk of its own, once the page SETTLES", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-page"), "unknown ⇒ page").not.toBeNull();

    // No delta, no re-upsert, no reconcile of the caller's own — the page simply lands.
    __setAtlasPageSizeForTest(ATLAS, BIG);

    const icon = el(stage, "Icon");
    expect(icon.querySelector("canvas.mirror-atlas-canvas"), "the settle drove the swap").not.toBeNull();
    expect(icon.querySelector("div.mirror-atlas-page")).toBeNull();
  });

  it("swaps out of the blind guess WHILE HIDDEN, so a reveal has nothing stale to paint", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    const dialog: Raw = { id: "Dialog", parentId: "Game", name: "Dialog", nodeType: "Godot.Control", visible: true };
    full(state, [ROOT, dialog, { ...sprite("Icon", REGION_A), parentId: "Dialog" }]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-page"), "unknown ⇒ page").not.toBeNull();

    // The dialog closes. An incremental delta keeps the element (only a FULL walk reclaims), so the sprite is now
    // an invisible node carrying a page-crop div that no wire traffic will ever ask about again.
    update(state, [{ ...dialog, visible: false }]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-page"), "still the guess").not.toBeNull();

    // The settle re-styles it IN THE DARK — the cost of the swap is paid while nobody is looking…
    __setAtlasPageSizeForTest(ATLAS, BIG);
    expect(el(stage, "Icon").querySelector("canvas.mirror-atlas-canvas")).not.toBeNull();
    expect(stage.querySelectorAll("div.mirror-atlas-page").length, "swapped while hidden").toBe(0);

    // …so re-opening the dialog cannot paint the page, even on the out-of-walk un-hide paths that write `display`
    // and nothing else.
    update(state, [{ ...dialog, visible: true }]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("canvas.mirror-atlas-canvas")).not.toBeNull();
    expect(stage.querySelectorAll("div.mirror-atlas-page").length).toBe(0);
  });

  it("the blob decode gate still commits the swap out of a big page's CANVAS placeholder", () => {
    const pending: Array<{ url: string; ready: (ok: boolean) => void }> = [];
    __setStillDecoderForTest((url, ready) => {
      pending.push({ url, ready });
    });
    __setAtlasPageSizeForTest(ATLAS, BIG);
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("canvas.mirror-atlas-canvas")).not.toBeNull();

    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    expect(el(stage, "Icon").querySelector("canvas.mirror-atlas-canvas"), "canvas held until paintable").not.toBeNull();
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-region")).toBeNull();

    pending[0].ready(true);
    const icon = el(stage, "Icon");
    expect(icon.querySelector("div.mirror-atlas-region")).not.toBeNull();
    expect(stage.querySelectorAll("canvas").length).toBe(0);
  });

});

// ---------------------------------------------------------------------------------------------------------------
// Stage C item 1 — the page-crop placeholder's late page-size rewrite
// ---------------------------------------------------------------------------------------------------------------

describe("page-crop placeholder crop math", () => {
  // MirrorView's other targeted seam, wired exactly as production wires it: a measured natural size hands the
  // renderer the ids that styled provisionally against that url and a NORMAL reconcile follows.
  function wireSizeSeam(renderer: MirrorRenderer, state: MirrorState): () => void {
    return onTextureSizesResolved((ids) => {
      renderer.markTextureDirty(ids);
      renderer.reconcile(state);
    });
  }

  it("rewrites the crop ONCE when the atlas page's natural size lands (same values, now explicit)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwireSizes = wireSizeSeam(renderer, state);
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    const page = el(stage, "Icon").querySelector("div.mirror-atlas-page") as HTMLElement;
    expect(page.style.backgroundSize).toBe("auto");

    __recordTextureSizeForTest(ATLAS, 2048, 1024);

    // Same element, same crop position; the size is now the explicit page box (box == region ⇒ scale 1, so the
    // explicit value equals the native scale `auto` painted — the rewrite is a no-op by value, by design).
    const after = el(stage, "Icon").querySelector("div.mirror-atlas-page") as HTMLElement;
    expect(after).toBe(page);
    expect(after.style.backgroundPosition).toBe("-4px -8px");
    expect(after.style.backgroundSize).toBe("2048px 1024px");
  });

  it("a region change rewrites only the crop styles on the SAME placeholder element", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    const page = el(stage, "Icon").querySelector("div.mirror-atlas-page") as HTMLElement;
    expect(page.style.backgroundPosition).toBe("-4px -8px");

    update(state, [sprite("Icon", REGION_B)]);
    renderer.reconcile(state);
    const after = el(stage, "Icon").querySelector("div.mirror-atlas-page") as HTMLElement;
    expect(after).toBe(page); // flicker-free cycler: no element swap, no canvas, no blob dependency
    expect(after.style.backgroundPosition).toBe("-60px -8px");
    expect(stage.querySelectorAll("canvas").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Stage C item 2 — the blob decode gate (swap ordering)
// ---------------------------------------------------------------------------------------------------------------

describe("region blob decode gate", () => {
  // A controllable decoder: decodes park here until the test settles them (the spineDecodeGate.spec idiom).
  let pending: Array<{ url: string; ready: (ok: boolean) => void }> = [];
  const parkingDecoder: StillDecoder = (url, ready) => {
    pending.push({ url, ready });
  };

  beforeEach(() => {
    pending = [];
    __setStillDecoderForTest(parkingDecoder);
  });

  it("never commits the swap before the decode resolves — the placeholder keeps painting", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-page")).not.toBeNull();

    // The bake lands → the targeted re-style runs → but the blob is NOT yet decoded, so the mechanism must hold.
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    expect(pending.map((p) => p.url)).toEqual(["blob:region-a"]);
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-page"), "placeholder held through the bake").not.toBeNull();
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-region")).toBeNull();

    // The decode settles → the resolve re-styles exactly this node through the SAME region seam → swap commits.
    pending[0].ready(true);
    const icon = el(stage, "Icon");
    expect(icon.querySelector("div.mirror-atlas-region")).not.toBeNull();
    expect(icon.querySelector("div.mirror-atlas-page")).toBeNull();
  });

  it("fail-open: a decode that REPORTS FAILURE still commits (never a permanently held sprite)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [ROOT, sprite("Icon", REGION_A)]);
    renderer.reconcile(state);

    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-region")).toBeNull();
    pending[0].ready(false); // EncodingError / revoked blob — swap anyway, as the ungated path did
    expect(el(stage, "Icon").querySelector("div.mirror-atlas-region")).not.toBeNull();
  });

  it("dedupes the probe per blob url across nodes, and a later node styles through the gate unhindered", () => {
    __publishRegionBlobForTest(ATLAS, REGION_A, "blob:region-a");
    const { stage, renderer } = harness();
    const state = createMirrorState();
    unwire = wireRegionSeam(renderer, state);
    full(state, [ROOT, sprite("IconA", REGION_A), sprite("IconB", REGION_A)]);
    renderer.reconcile(state);

    // Both nodes hit the same undecoded blob on the same walk: ONE probe, both held on the placeholder.
    expect(pending.length).toBe(1);
    expect(stage.querySelectorAll("div.mirror-atlas-page").length).toBe(2);
    expect(stage.querySelectorAll("div.mirror-atlas-region").length).toBe(0);

    // One resolve commits BOTH (the waiter set rode the shared probe).
    pending[0].ready(true);
    expect(stage.querySelectorAll("div.mirror-atlas-region").length).toBe(2);
    expect(stage.querySelectorAll("div.mirror-atlas-page").length).toBe(0);

    // A node arriving later finds the blob already gate-cleared and mounts the div directly.
    full(state, [ROOT, sprite("IconA", REGION_A), sprite("IconB", REGION_A), sprite("IconC", REGION_A)]);
    renderer.reconcile(state);
    expect(el(stage, "IconC").querySelector("div.mirror-atlas-region")).not.toBeNull();
    expect(pending.length).toBe(1); // no second probe
  });

});

// ---------------------------------------------------------------------------------------------------------------
// item 2 — the blend census (measurement only; the muting pass was NOT built, see the workstream report)
// ---------------------------------------------------------------------------------------------------------------

describe("blend census counters", () => {
  const blended = (id: string, alpha: number): Raw => ({
    id,
    parentId: "Game",
    name: id,
    nodeType: "Sprite2D",
    visible: true,
    transform: xf(10, 10),
    localRect: rect(0, 0, 32, 32),
    canvasBlendMode: 1, // ADD
    modulate: { r: 1, g: 1, b: 1, a: alpha }
  });

  it("counts blend nodes, tracks the invisible ones, and keeps a peak + time-weighted series", () => {
    mirrorWalkStats.reset();
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, blended("Glow", 1), blended("Flash", 0.01), { ...blended("Plain", 1), canvasBlendMode: 0 }]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.blendNodes).toBe(2); // Plain carries no blend
    expect(mirrorWalkStats.blendLowAlpha).toBe(1);
    expect(mirrorWalkStats.blendLowAlphaPeak).toBe(1);

    // Both invisible for one frame ⇒ the peak rises and the running sum accumulates per walk.
    update(state, [blended("Glow", 0)]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.blendLowAlpha).toBe(2);
    expect(mirrorWalkStats.blendLowAlphaPeak).toBe(2);

    // Back to visible: the live count falls, the peak is a high-water mark and does not.
    update(state, [blended("Glow", 1)]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.blendLowAlpha).toBe(1);
    expect(mirrorWalkStats.blendLowAlphaPeak).toBe(2);
    expect(mirrorWalkStats.blendSampleWalks).toBe(3);
    expect(mirrorWalkStats.blendLowAlphaSum).toBe(4); // 1 + 2 + 1
  });

  it("forgets a blend node when it leaves the scene", () => {
    mirrorWalkStats.reset();
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, blended("Flash", 0)]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.blendLowAlpha).toBe(1);

    full(state, [ROOT]);
    renderer.reconcile(state);
    expect(mirrorWalkStats.blendNodes).toBe(0);
    expect(mirrorWalkStats.blendLowAlpha).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// item 3 — spine still → <img>
// ---------------------------------------------------------------------------------------------------------------

function spineNode(): Raw {
  return {
    id: "Spine",
    parentId: "Game",
    name: "SpineSprite",
    nodeType: "SpineSprite",
    visible: true,
    transform: xf(960, 540),
    spine: {
      sceneResPath: "res://scenes/merchant/characters/ironclad_merchant.tscn",
      nodePath: "Visuals/SpineSprite",
      animations: ["idle_loop"]
    },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0
  };
}

function clip(frameCount: number, stillUrl: string | null): LoadedSpineClip {
  const frames = Array.from({ length: frameCount }, (_, i) => ({
    index: i,
    offsetX: 16,
    offsetY: 24,
    width: 64,
    height: 80,
    durationMs: 100,
    startMs: i * 100,
    png: new Uint8Array(),
    bitmap: { id: `f${i}` } as unknown as ImageBitmap
  }));
  return {
    canvasWidth: 200,
    canvasHeight: 300,
    totalDurationMs: frameCount * 100,
    localX: -100,
    localY: -300,
    localWidth: 200,
    localHeight: 300,
    frames,
    stillUrl,
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
}

describe("spine still paint mechanism", () => {
  beforeEach(() => {
    // jsdom has no 2D context; the canvas mechanism only needs the calls to not throw.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      clearRect: vi.fn()
    } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("paints a single-frame clip with an <img> placed where the canvas blit would have landed", async () => {
    loadSpineClipMock.mockResolvedValue(clip(1, "blob:still"));
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, spineNode()]);
    renderer.reconcile(state);
    await Promise.resolve();
    await Promise.resolve();

    const node = el(stage, "Spine");
    const img = node.querySelector("img.mirror-spine-img") as HTMLImageElement | null;
    expect(img, "still painted as an <img>").not.toBeNull();
    expect(node.querySelector("canvas.mirror-spine-canvas")).toBeNull();
    expect(img!.getAttribute("src")).toBe("blob:still");
    // canvas → localX/Y with the frame drawn at (offsetX, offsetY); scale = localWidth/canvasWidth = 1.
    expect(img!.style.width).toBe("64px");
    expect(img!.style.height).toBe("80px");
    expect(img!.style.transform).toBe("translate(-84px, -276px) scale(1)");
  });

  it("keeps the <canvas> for a multi-frame (dynamic) clip", async () => {
    loadSpineClipMock.mockResolvedValue(clip(3, null));
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, spineNode()]);
    renderer.reconcile(state);
    await Promise.resolve();
    await Promise.resolve();

    expect(el(stage, "Spine").querySelector("canvas.mirror-spine-canvas")).not.toBeNull();
    expect(stage.querySelectorAll("img.mirror-spine-img").length).toBe(0);
  });

  it("swaps still → dynamic → still cleanly, never leaving both elements attached", async () => {
    const still = clip(1, "blob:still");
    const animated = clip(3, null);
    loadSpineClipMock.mockResolvedValue(still);
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [ROOT, spineNode()]);
    renderer.reconcile(state);
    await Promise.resolve();
    await Promise.resolve();
    expect(stage.querySelectorAll("img.mirror-spine-img").length).toBe(1);
    expect(stage.querySelectorAll("canvas.mirror-spine-canvas").length).toBe(0);

    // The animated clip arrives for a new anim identity: back to the canvas, and the <img> must be gone.
    loadSpineClipMock.mockResolvedValue(animated);
    update(state, [{ ...spineNode(), spineCurrentAnim: "attack" }]);
    renderer.reconcile(state);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stage.querySelectorAll("canvas.mirror-spine-canvas").length).toBe(1);
    expect(stage.querySelectorAll("img.mirror-spine-img").length).toBe(0);

    // …and back again.
    loadSpineClipMock.mockResolvedValue(still);
    update(state, [{ ...spineNode(), spineCurrentAnim: "idle_loop" }]);
    renderer.reconcile(state);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stage.querySelectorAll("img.mirror-spine-img").length).toBe(1);
    expect(stage.querySelectorAll("canvas.mirror-spine-canvas").length).toBe(0);
  });

});
