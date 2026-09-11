import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMirrorOverlay, msToNextGeoclipFrame, type MirrorOverlay } from "@/mirror/canvas/overlay";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import type { OverlayRecord } from "@/mirror/canvas/paintSpec";
import {
  __clearGeoclipProbesForTest,
  type GeoclipClip,
  type GeoclipNode,
  type GeoclipPlacement,
  type GpuClip
} from "@/mirror/geoclipPlayer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorNode } from "@/mirror/sceneTree";
import { __setRenderQualityForTest, resolveRenderQuality } from "@/render/quality";
import { __setStillDecoderForTest } from "@/mirror/stillDecode";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// Geoclip playback on the canvas stage.
//
// The canvas backend owns a parallel geoclip integration, so these tests pin its mount behavior.
//
// TWO OF THESE CASES ARE CORRECTNESS TERMS RATHER THAN COVERAGE, and both are silent failures if dropped:
//
//   * THE ANTI-FREEZE TERM. `clipAnimates` and `nextSpineDeadline` fold MULTI-FRAME clips only, and the product
//     default is a single-frame still — so a geoclip, which animates regardless, would leave the stage parked and
//     the creature frozen on frame 0. The DOM backend answers this by joining its playing set unconditionally.
//   * THE ANTI-DOUBLE-DRAW TERM. `spineQuads()` must EXCLUDE a geoclip-live node, or the stage paints the baked
//     still at the node's own paint index while the geoclip canvas paints above it. Two nearly-identical
//     creatures in the same place look like ONE creature in a screenshot — a prior round shipped exactly this
//     failure through a CSS child-combinator (fix-forward 247bd7d), which is why it is pinned here rather than
//     left to a visual check.
//
// WHAT IS MOCKED AND WHY. `loadSpineClip` fetches + decodes over the network (`spineMount.spec`'s pattern). The
// geoclip module's THREE side-effecting entry points are stood in for because every one of them needs a real
// WebGL2 context, which jsdom does not have at all — `geoclipPlayer.spec` says so explicitly and covers the pure
// half (both encodings' decode, the clock, the fit) there. What stays REAL is everything this file is actually
// about: `geoclipFrameIndexAt`'s playback math and `noteGeoclipFailure`'s
// once-per-session console latch.

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

const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

// --- fixtures --------------------------------------------------------------------------------------------------

/** The mount instant, PINNED: the overlay seeds a clip's playback clock from `performance.now()`. */
const T0 = 10_000;

/** 20 fps ⇒ a 50ms frame grid, which keeps every deadline assertion an integer. */
const GEO_FPS = 20;
const GEO_PERIOD = 1000 / GEO_FPS;

let overlay: MirrorOverlay | null = null;

function wireNode(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId: null,
    name: id,
    nodeType: "Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 100, y: 50 } },
    visible: true,
    ...over
  };
}

const CREATURE = wireNode("sp", {
  nodeType: "SpineSprite",
  spine: { sceneResPath: "res://creature.tscn", nodePath: "Sprite" },
  spineCurrentAnim: "idle"
});

function nodesOf(specs: Array<Record<string, unknown>>): Map<string, MirrorNode> {
  const state = createMirrorState();
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      orderedIds: specs.map((s) => s.id),
      upserts: specs
    })!
  );
  return state.nodes;
}

function spineRecord(over: Partial<OverlayRecord> = {}): OverlayRecord {
  return {
    id: "sp",
    kind: "spine",
    transform: [1, 0, 0, 1, 0, 0],
    w: 0,
    h: 0,
    order: 0,
    opacity: 1,
    tintR: 1,
    tintG: 1,
    tintB: 1,
    coveredAbove: false,
    clip: null,
    ...over
  };
}

/**
 * The BAKED clip, which is what supplies the geoclip's placement. A single frame with a `stillUrl` is the PRODUCT
 * DEFAULT (`spineMode: static`) and therefore the case both correctness terms live or die on: it never animates
 * and it is the one the still-quad path publishes.
 */
function bakedStill(over: Partial<LoadedSpineClip> = {}): LoadedSpineClip {
  const bitmap = { close() {} } as unknown as ImageBitmap;
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 100,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      { index: 0, offsetX: 3, offsetY: 4, width: 40, height: 60, durationMs: 100, startMs: 0, png: new Uint8Array(), bitmap }
    ],
    stillUrl: "blob:still-a",
    degraded: false,
    retain() {},
    release() {},
    dispose() {},
    ...over
  };
}

/**
 * A decoded geoclip. Only `frames.length`, `fps` and `placement` are read here — the renderer half is mocked.
 *
 * `placement` defaults to NULL, i.e. a pre-Phase-4 bake that can only mount behind a baked raster clip. The cases
 * that exercise the manifest placement pass one in explicitly.
 */
function geoclip(frames = 4, fps = GEO_FPS, placement: GeoclipClip["placement"] = null): GeoclipClip {
  return {
    schema: "geoclip/1",
    anim: "idle",
    fps,
    frameCount: frames,
    durationMs: (frames / fps) * 1000,
    pages: [],
    parts: new Map(),
    frames: Array.from({ length: frames }, () => ({ drawOrder: null, slots: new Map() })),
    vertsBin: null,
    placement,
    fileUrl: (file: string) => file
  };
}

/** A stated `meta.placement`, deliberately DIFFERENT from `bakedStill()`'s so the two sources are told apart. */
const MANIFEST_PLACEMENT = {
  canvasWidth: 300,
  canvasHeight: 400,
  localX: -111,
  localY: -222,
  localWidth: 150,
  localHeight: 200,
  fitScale: 2
};

interface FakeNode extends GeoclipNode {
  drawn: number[];
  disposed: number;
}

/** A geoclip paint element a test drives: it records the frames asked for and can refuse one. */
function fakeGeoclipNode(options: { drawOk?: (index: number) => boolean } = {}): FakeNode {
  const el = document.createElement("canvas");
  el.className = "mirror-geoclip-canvas";
  const drawn: number[] = [];
  const node: FakeNode = {
    el,
    drawn,
    disposed: 0,
    place: vi.fn(),
    draw(index: number) {
      drawn.push(index);
      return options.drawOk ? options.drawOk(index) : true;
    },
    dispose() {
      node.disposed++;
      el.remove();
    }
  };
  return node;
}

function mountOverlay(): { stage: HTMLElement; container: HTMLElement } {
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  stage.appendChild(canvas);
  document.body.appendChild(stage);
  overlay = createMirrorOverlay(stage, canvas);
  return { stage, container: overlay.container };
}

function hostOf(container: HTMLElement, id = "sp"): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
}

/** Reconcile once and let BOTH async chains land — the clip load and the probe → upload → mount. */
async function reconcileSpine(node: Record<string, unknown> = CREATURE): Promise<void> {
  overlay!.reconcile([spineRecord()], nodesOf([node]));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(performance, "now").mockReturnValue(T0);
  loadSpineClipMock.mockReset();
  loadSpineClipMock.mockResolvedValue(bakedStill());
  probeGeoclipMock.mockReset();
  probeGeoclipMock.mockResolvedValue(null);
  uploadGeoclipMock.mockReset();
  createGeoclipNodeMock.mockReset();
  // The still commits SYNCHRONOUSLY, so `spineQuads()` has something real to publish (or to withhold).
  __setStillDecoderForTest((_url, ready) => ready(true));
  // …and the session-long latches inside geoclipPlayer (the probe cache and the one-line failure log), which
  // outlive a test file's individual cases because the module is loaded once.
  __clearGeoclipProbesForTest();
  // This suite is the explicit developer/benchmark geoclip lane. The default-static regression below overrides
  // it for one mount so ordinary viewers remain covered too.
  mirrorSettings.spineMode = "dynamic";
});

afterEach(() => {
  overlay?.dispose();
  overlay = null;
  __setStillDecoderForTest(null);
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static";
  // The settings store is an app-wide singleton, so restore the product default.
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** Stand up the usual happy-path probe/upload/create chain. */
function mountGeoclip(node = fakeGeoclipNode(), clip = geoclip()): FakeNode {
  probeGeoclipMock.mockResolvedValue(clip);
  uploadGeoclipMock.mockResolvedValue({ parts: new Map() } as GpuClip);
  createGeoclipNodeMock.mockReturnValue(node);
  return node;
}

// --- the mount -------------------------------------------------------------------------------------------------

describe("the default static canvas lane", () => {
  it("requests only the baked still and never probes geoclips", async () => {
    mirrorSettings.spineMode = "static";
    const { container } = mountOverlay();
    await reconcileSpine();

    expect(loadSpineClipMock.mock.calls[0][0]).toBe("/spines/creature.tscn?node=Sprite&anim=idle&still=1");
    expect(probeGeoclipMock).not.toHaveBeenCalled();
    expect(createGeoclipNodeMock).not.toHaveBeenCalled();
    expect(hostOf(container).querySelector("img.mirror-spine-img")).not.toBeNull();
  });
});

describe("the canvas overlay's geoclip path", () => {
  it("probes the node's OWN manifest url and mounts the geoclip in its overlay element", async () => {
    const node = mountGeoclip();
    const { container } = mountOverlay();
    await reconcileSpine();

    // The manifest is addressed by (scene, node, anim) — `geoclipUrl`'s selectors, not string surgery on the
    // clip url — and every sibling artifact rides the same builder.
    expect(probeGeoclipMock).toHaveBeenCalledTimes(1);
    expect(probeGeoclipMock.mock.calls[0][0]).toBe("/geoclips/creature.tscn?node=Sprite&anim=idle&file=manifest.json");
    expect(probeGeoclipMock.mock.calls[0][1]("verts.bin")).toBe(
      "/geoclips/creature.tscn?node=Sprite&anim=idle&file=verts.bin"
    );

    const host = hostOf(container);
    expect(host.querySelector("canvas.mirror-geoclip-canvas")).toBe(node.el);
    // The class is what hides the baked layer (`.mirror-geoclip-live > .mirror-spine-img` in MirrorView's
    // unscoped block) — the element is mounted "in place of" it by CSS, never by DOM surgery.
    expect(host.classList.contains("mirror-geoclip-live")).toBe(true);
    // …and the baked `<img>` is still THERE, which is the whole point of that spelling: a revert re-shows it.
    expect(host.querySelector("img.mirror-spine-img")).not.toBeNull();
  });

  it("places the geoclip from the BAKED clip's geometry — the only thing that knows where the skeleton sits", async () => {
    mountGeoclip();
    mountOverlay();
    await reconcileSpine();

    // Nothing in a geoclip manifest says where the skeleton origin lands on screen; the baked clip's canvas size
    // + node-local rect does, and inverting it is the mapping (`deriveGeoclipFit`).
    expect(createGeoclipNodeMock).toHaveBeenCalledTimes(1);
    expect(createGeoclipNodeMock.mock.calls[0][2]).toEqual({
      canvasWidth: 100,
      canvasHeight: 200,
      localX: -50,
      localY: -75,
      localWidth: 100
    });
  });

  it("paints frame 0 at the mount instant rather than waiting for the next tick", async () => {
    const node = mountGeoclip();
    mountOverlay();
    await reconcileSpine();
    expect(node.drawn).toEqual([0]);
  });

  it("re-arms on an ANIM CHANGE, and drops the old animation's geometry", async () => {
    const first = mountGeoclip();
    const { container } = mountOverlay();
    await reconcileSpine();
    expect(first.disposed).toBe(0);

    const second = fakeGeoclipNode();
    createGeoclipNodeMock.mockReturnValue(second);
    await reconcileSpine({ ...CREATURE, spineCurrentAnim: "attack" });

    expect(probeGeoclipMock).toHaveBeenCalledTimes(2);
    expect(probeGeoclipMock.mock.calls[1][0]).toContain("anim=attack");
    // The previous animation's geometry is stale the instant the identity moves.
    expect(first.disposed).toBe(1);
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).toBe(second.el);
  });

  // THE RACE HAS TWO ORDERS AND TWO MOUNT SITES, and each case below kills only its own. A still usually lands
  // long before an upload resolves — but not always, and a mount that only worked one way round would look
  // perfectly healthy in a suite that never ran the other.
  it("mounts when the UPLOAD lands last (the upload arrival's own re-sync)", async () => {
    mountGeoclip();
    let releaseUpload: (gpu: GpuClip) => void = () => {};
    uploadGeoclipMock.mockImplementation(() => new Promise<GpuClip>((r) => (releaseUpload = r)));
    const { container } = mountOverlay();
    await reconcileSpine();

    // The baked still is on screen; the geoclip is not, because its GPU buffers have not arrived.
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
    expect(hostOf(container).querySelector("img.mirror-spine-img")).not.toBeNull();

    releaseUpload({ parts: new Map() } as GpuClip);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).not.toBeNull();
  });

  it("mounts when the BAKED CLIP lands last (`mountSpine`'s tail)", async () => {
    mountGeoclip();
    let releaseClip: (clip: LoadedSpineClip) => void = () => {};
    loadSpineClipMock.mockImplementation(() => new Promise<LoadedSpineClip>((r) => (releaseClip = r)));
    const { container } = mountOverlay();
    await reconcileSpine();

    // The geometry is uploaded and has nowhere to sit: the baked clip is what says where the skeleton is, so
    // there is nothing to derive a placement from yet.
    expect(createGeoclipNodeMock).not.toHaveBeenCalled();

    releaseClip(bakedStill());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).not.toBeNull();
  });

  it("disposes the element on teardown", async () => {
    const node = mountGeoclip();
    mountOverlay();
    await reconcileSpine();
    overlay!.dispose();
    overlay = null;
    expect(node.disposed).toBe(1);
    expect(document.querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
  });
});

describe("a live canvas auto → static switch", () => {
  it("releases active geometry even when both modes use the same baked-still URL", async () => {
    __setRenderQualityForTest(
      resolveRenderQuality({ search: "?quality=min", gpu: { renderer: "", software: false, unavailable: true } })
    );
    mirrorSettings.spineMode = "auto";
    const geoclipNode = mountGeoclip();
    const { container } = mountOverlay();
    await reconcileSpine();
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(true);
    expect(loadSpineClipMock.mock.calls).toHaveLength(1);
    expect(loadSpineClipMock.mock.calls[0][0]).toBe("/spines/creature.tscn?node=Sprite&anim=idle&still=1");

    mirrorSettings.spineMode = "static";
    await reconcileSpine();

    expect(geoclipNode.disposed).toBe(1);
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(false);
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
    expect(loadSpineClipMock.mock.calls).toHaveLength(1);
    expect(hostOf(container).querySelector("img.mirror-spine-img")).not.toBeNull();

    const rearmed = fakeGeoclipNode();
    createGeoclipNodeMock.mockReturnValue(rearmed);
    mirrorSettings.spineMode = "auto";
    await reconcileSpine();
    expect(probeGeoclipMock).toHaveBeenCalledTimes(2);
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).toBe(rearmed.el);

    // The unchanged `&still=1` raster identity must not cause a fresh probe on every ordinary reconcile.
    await reconcileSpine();
    expect(probeGeoclipMock).toHaveBeenCalledTimes(2);
  });
});

// --- MANDATORY TERM (a): the stage must not park, and the creature must not freeze on frame 0 ------------------

describe("a geoclip keeps the stage awake (the anti-freeze term)", () => {
  it("a baked STILL alone parks the stage — the state this term has to overcome", async () => {
    // The control, and the reason the term is needed at all: `clipAnimates` folds multi-frame clips only, and the
    // product default is a single-frame still. Without a geoclip term nothing here ever asks for a second frame.
    mountOverlay();
    await reconcileSpine();
    expect(overlay!.nextSpineDeadline(T0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("…and the SAME still with a geoclip on it asks for the geoclip's own next frame", async () => {
    mountGeoclip();
    mountOverlay();
    await reconcileSpine();
    // 20 fps ⇒ a 50ms grid, replayed off `geoclipFrameIndexAt`'s own arithmetic so the wakeup and the paint
    // cannot disagree. NOT the baked clip's schedule, which would be Infinity (above).
    expect(overlay!.nextSpineDeadline(T0)).toBe(T0 + GEO_PERIOD);
    expect(overlay!.nextSpineDeadline(T0 + 20)).toBe(T0 + GEO_PERIOD);
    expect(overlay!.nextSpineDeadline(T0 + GEO_PERIOD)).toBe(T0 + 2 * GEO_PERIOD);
  });

  it("advances the geoclip's frame on a tick, off the SAME clock the baked path reads", async () => {
    const node = mountGeoclip();
    mountOverlay();
    await reconcileSpine();
    expect(node.drawn).toEqual([0]);

    overlay!.tickSpine(T0 + GEO_PERIOD);
    overlay!.tickSpine(T0 + 2 * GEO_PERIOD);
    expect(node.drawn).toEqual([0, 1, 2]);

    // A tick that lands on the frame already up costs no draw at all.
    overlay!.tickSpine(T0 + 2 * GEO_PERIOD + 1);
    expect(node.drawn).toEqual([0, 1, 2]);
  });

  it("wraps a LOOPING clip and holds a one-shot's last frame forever", async () => {
    const node = mountGeoclip();
    mountOverlay();
    await reconcileSpine();
    // 4 frames at 50ms: frame 4 wraps to 0.
    overlay!.tickSpine(T0 + 4 * GEO_PERIOD);
    expect(node.drawn.at(-1)).toBe(0);

    const oneShot = fakeGeoclipNode();
    createGeoclipNodeMock.mockReturnValue(oneShot);
    overlay!.dispose();
    mountOverlay();
    await reconcileSpine({ ...CREATURE, spineLooping: false });
    // A landed attack holds its final pose, so the demand source must be able to reach Infinity again — this is
    // the half that keeps a geoclip from pinning the animation rAF for the rest of the screen.
    expect(overlay!.nextSpineDeadline(T0 + 10_000)).toBe(Number.POSITIVE_INFINITY);
    overlay!.tickSpine(T0 + 10_000);
    expect(oneShot.drawn.at(-1)).toBe(3);
  });

  it("HOLDS for a paused track — the game froze it, so no frame is owed", async () => {
    // Stricter than the DOM arm on purpose: a paused track's play time is constant, so a finite deadline would
    // spin the stage forever repainting the frame already on screen.
    mountGeoclip();
    mountOverlay();
    await reconcileSpine({ ...CREATURE, spinePaused: true });
    expect(overlay!.nextSpineDeadline(T0 + 10_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("parks again the moment the geoclip goes away", async () => {
    mountGeoclip();
    mountOverlay();
    await reconcileSpine();
    expect(overlay!.nextSpineDeadline(T0)).toBeLessThan(Number.POSITIVE_INFINITY);

    // The node leaves the wire entirely: the element is swept, and the playing set has to shrink with it.
    overlay!.reconcile([], nodesOf([CREATURE]));
    expect(overlay!.nextSpineDeadline(T0)).toBe(Number.POSITIVE_INFINITY);
  });
});

// --- MANDATORY TERM (b): one creature, drawn once --------------------------------------------------------------

describe("a geoclip is not drawn twice (the anti-double-draw term)", () => {
  it("publishes the baked still as a quad with NO geoclip — the control", async () => {
    mountOverlay();
    await reconcileSpine();
    expect(overlay!.spineQuads().has("sp")).toBe(true);
  });

  it("…and WITHHOLDS it the moment a geoclip is live", async () => {
    // Without this the stage paints `emitSpineQuad`'s baked still at the node's own paint index while the geoclip
    // canvas paints above it. It looks correct in a screenshot, which is exactly why it is asserted here.
    mountGeoclip();
    mountOverlay();
    await reconcileSpine();
    expect(overlay!.spineQuads().has("sp")).toBe(false);
  });

  // THE VERSION BUMPS ARE PART OF THE TERM, and both cases below are written so that the still's OWN bump cannot
  // stand in for the geoclip's. The renderer banks this counter at build time and compares it later to decide
  // whether its frame-level patch may reuse the last draw list; a mount that changed `spineQuads()`'s answer
  // without moving the counter would let the stage keep painting a list built before the geoclip existed — which
  // still contains the baked quad. A test that merely asserted "the number went up across a reconcile" would
  // pass on the still's commit alone and prove nothing.
  it("BUMPS the version at the MOUNT itself, after the still has already committed and bumped", async () => {
    mountGeoclip();
    let releaseUpload: (gpu: GpuClip) => void = () => {};
    uploadGeoclipMock.mockImplementation(() => new Promise<GpuClip>((r) => (releaseUpload = r)));
    mountOverlay();
    await reconcileSpine();

    const afterStill = overlay!.spineQuadVersion();
    expect(overlay!.spineQuads().has("sp")).toBe(true);

    releaseUpload({ parts: new Map() } as GpuClip);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(overlay!.spineQuads().has("sp")).toBe(false);
    expect(overlay!.spineQuadVersion()).toBeGreaterThan(afterStill);
  });

  it("…and again at the RELEASE, with no still commit anywhere near it", async () => {
    // A refused draw reverts the node in place: the `<img>` and its url are untouched, so `setSpineShownStill`
    // never fires and this bump is the only one available.
    const node = mountGeoclip(fakeGeoclipNode({ drawOk: (index) => index < 1 }));
    mountOverlay();
    await reconcileSpine();
    const mounted = overlay!.spineQuadVersion();

    overlay!.tickSpine(T0 + GEO_PERIOD);
    expect(node.disposed).toBe(1);
    expect(overlay!.spineQuads().has("sp")).toBe(true);
    expect(overlay!.spineQuadVersion()).toBeGreaterThan(mounted);
  });

  it("keeps the host VISIBLE even while the last build's `setSpineDrawn` still names it", async () => {
    // `setSpineDrawn` carries the PREVIOUS build's ids, so for one build after a mount it can name a node whose
    // still is no longer offered. Hiding the host on that stale answer would hide the geoclip canvas inside it —
    // the creature would vanish for a frame, which is the one outcome this path exists to make impossible.
    mountGeoclip();
    const { container } = mountOverlay();
    await reconcileSpine();
    overlay!.setSpineDrawn(new Set(["sp"]));
    await reconcileSpine();
    expect(hostOf(container).style.visibility).not.toBe("hidden");

    // …and the rule is not "never hide a spine": an animation with no geoclip artifact still hides when drawn.
    probeGeoclipMock.mockResolvedValue(null);
    overlay!.dispose();
    const plain = mountOverlay();
    await reconcileSpine();
    overlay!.setSpineDrawn(new Set(["sp"]));
    await reconcileSpine();
    expect(hostOf(plain.container).style.visibility).toBe("hidden");
  });
});

// --- failure is always a fallback, never a blank --------------------------------------------------------------

describe("a geoclip that fails reverts that node to the baked path, once and for good", () => {
  it("reverts when the UPLOAD cannot be made, naming it on the console", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    probeGeoclipMock.mockResolvedValue(geoclip());
    uploadGeoclipMock.mockResolvedValue(null); // no WebGL2, or a page that would not load
    const { container } = mountOverlay();
    await reconcileSpine();

    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(false);
    // The baked still is what the viewer sees, and it is quad-able again.
    expect(hostOf(container).querySelector("img.mirror-spine-img")).not.toBeNull();
    expect(overlay!.spineQuads().has("sp")).toBe(true);
    expect(info.mock.calls.map((c) => String(c[0])).join("\n")).toContain("geoclip playback unavailable");
  });

  it("reverts when a DRAW fails mid-animation, and the baked layer takes over from there", async () => {
    // A lost WebGL context is a silent no-op in GL, so the only signal is the draw's own false.
    const node = mountGeoclip(fakeGeoclipNode({ drawOk: (index) => index < 2 }));
    const { container } = mountOverlay();
    await reconcileSpine();
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(true);

    overlay!.tickSpine(T0 + GEO_PERIOD);
    overlay!.tickSpine(T0 + 2 * GEO_PERIOD); // frame 2 — refused
    expect(node.disposed).toBe(1);
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(false);
    expect(overlay!.spineQuads().has("sp")).toBe(true);
    // …and the stage may park again: nothing here animates any more.
    expect(overlay!.nextSpineDeadline(T0 + 5000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("reverts when the paint element cannot be created at all", async () => {
    probeGeoclipMock.mockResolvedValue(geoclip());
    uploadGeoclipMock.mockResolvedValue({ parts: new Map() } as GpuClip);
    createGeoclipNodeMock.mockReturnValue(null); // e.g. no 2D context for the blit target
    const { container } = mountOverlay();
    await reconcileSpine();
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(false);
    expect(hostOf(container).querySelector("img.mirror-spine-img")).not.toBeNull();
  });

  it("is ONE-WAY: a node that fell back never probes again, not even on a new animation", async () => {
    probeGeoclipMock.mockResolvedValue(geoclip());
    uploadGeoclipMock.mockResolvedValue(null);
    mountOverlay();
    await reconcileSpine();
    expect(probeGeoclipMock).toHaveBeenCalledTimes(1);

    // The verdict is "this node proved it cannot play geoclips" and it outlives every element the node will have.
    uploadGeoclipMock.mockResolvedValue({ parts: new Map() } as GpuClip);
    await reconcileSpine({ ...CREATURE, spineCurrentAnim: "attack" });
    expect(probeGeoclipMock).toHaveBeenCalledTimes(1);
    expect(createGeoclipNodeMock).not.toHaveBeenCalled();
  });

  it("leaves the node baked when this animation simply has no geoclip (the common case)", async () => {
    // A 404 on the manifest is the ORDINARY answer, not a failure: most animations have no bake at all.
    probeGeoclipMock.mockResolvedValue(null);
    const { container } = mountOverlay();
    await reconcileSpine();
    expect(uploadGeoclipMock).not.toHaveBeenCalled();
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(false);
    expect(overlay!.spineQuads().has("sp")).toBe(true);
  });
});

// --- A STATIC POSE MUST NOT WAKE THE rAF ------------------------------------------------------------------------

describe("a ONE-FRAME geoclip costs one draw and no frames after it", () => {
  // The point of a single-pose bake. Before Phase 4 a live geoclip claimed to animate UNCONDITIONALLY, so a
  // one-frame pose pinned the stage's animation rAF for the rest of the screen to repaint the pose already up —
  // on exactly the phone GPUs the static default exists to spare.
  it("draws its only frame at the mount and then asks for nothing", async () => {
    const node = mountGeoclip(fakeGeoclipNode(), geoclip(1));
    const { container } = mountOverlay();
    await reconcileSpine();

    // MOUNTED and painting — the pose is on screen, which is the half a naive "don't animate" fix would lose.
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).toBe(node.el);
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(true);
    expect(node.drawn).toEqual([0]);

    // IT IS NOT IN THE PLAYING SET, which is the assertion that actually holds the gate up. The deadline alone
    // would NOT: `msToNextGeoclipFrame` already answers Infinity for a one-frame clip, so a geoclip that claimed
    // to animate would still park — while leaving the counter non-zero and every animated frame scanning every
    // overlay element for a creature that can never move. Asserted first, and mutation-checked against
    // `clipAnimates` restored to its old unconditional `return true`.
    expect(overlay!.spinePlayingCount()).toBe(0);
    expect(overlay!.nextSpineDeadline(T0)).toBe(Number.POSITIVE_INFINITY);
    expect(overlay!.nextSpineDeadline(T0 + 10_000)).toBe(Number.POSITIVE_INFINITY);
    overlay!.tickSpine(T0 + 10 * GEO_PERIOD);
    overlay!.tickSpine(T0 + 100 * GEO_PERIOD);
    expect(node.drawn).toEqual([0]);
  });

  it("…while a MULTI-frame one still does — the control that keeps the gate from being vacuous", async () => {
    mountGeoclip(fakeGeoclipNode(), geoclip(4));
    mountOverlay();
    await reconcileSpine();
    expect(overlay!.spinePlayingCount()).toBe(1);
    expect(overlay!.nextSpineDeadline(T0)).toBe(T0 + GEO_PERIOD);
  });

  it("leaves the playing set balanced when a MULTI-frame geoclip is released by an anim change", async () => {
    // The counter is a SET SIZE, and an increment the release never matched would pin the animation rAF forever
    // with nothing left to paint. The anim-change release is a different path from the teardown one above.
    mountGeoclip(fakeGeoclipNode(), geoclip(4));
    mountOverlay();
    await reconcileSpine();
    expect(overlay!.nextSpineDeadline(T0)).toBeLessThan(Number.POSITIVE_INFINITY);

    probeGeoclipMock.mockResolvedValue(null); // the next animation simply has no bake
    await reconcileSpine({ ...CREATURE, spineCurrentAnim: "attack" });
    expect(overlay!.spinePlayingCount()).toBe(0);
    expect(overlay!.nextSpineDeadline(T0)).toBe(Number.POSITIVE_INFINITY);
  });
});

// --- PLACEMENT FROM THE MANIFEST --------------------------------------------------------------------------------

describe("a geoclip that states its own placement needs no baked clip", () => {
  it("mounts with the raster clip still in flight", async () => {
    // THE COUPLING THIS RETIRES: the mount used to be reachable only from `mountSpine`, i.e. only once a raster
    // clip had landed. A bake that states `meta.placement` knows where its own skeleton sits.
    mountGeoclip(fakeGeoclipNode(), geoclip(4, GEO_FPS, MANIFEST_PLACEMENT));
    loadSpineClipMock.mockImplementation(() => new Promise<LoadedSpineClip>(() => {})); // never resolves
    const { container } = mountOverlay();
    await reconcileSpine();

    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).not.toBeNull();
    expect(hostOf(container).classList.contains("mirror-geoclip-live")).toBe(true);
    expect(createGeoclipNodeMock.mock.calls[0][2]).toEqual({
      canvasWidth: 300,
      canvasHeight: 400,
      localX: -111,
      localY: -222,
      localWidth: 150,
      fitScale: 2
    });
  });

  it("prefers its own placement over the baked clip's when BOTH are available", async () => {
    // A placement is taken from one source WHOLE: the element's pixel size and the rect its fit inverts have to
    // be the same seven numbers, or the creature lands somewhere plausible and wrong.
    mountGeoclip(fakeGeoclipNode(), geoclip(4, GEO_FPS, MANIFEST_PLACEMENT));
    mountOverlay();
    await reconcileSpine();
    expect(createGeoclipNodeMock).toHaveBeenCalledTimes(1);
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
    mountGeoclip(fakeGeoclipNode(), geoclip(4)); // placement null
    loadSpineClipMock.mockImplementation(() => new Promise<LoadedSpineClip>(() => {}));
    const { container } = mountOverlay();
    await reconcileSpine();
    expect(createGeoclipNodeMock).not.toHaveBeenCalled();
    expect(hostOf(container).querySelector("canvas.mirror-geoclip-canvas")).toBeNull();
  });
});

// --- raster-first request order ---------------------------------------------------------------------------------

describe("the raster request begins before geoclip playback resolves", () => {
  it("requests /spines/ immediately", async () => {
    // Asserted before any async flush, which makes this about request ordering.
    mountGeoclip(fakeGeoclipNode(), geoclip(4, GEO_FPS, MANIFEST_PLACEMENT));
    mountOverlay();
    overlay!.reconcile([spineRecord()], nodesOf([CREATURE]));
    expect(loadSpineClipMock).toHaveBeenCalledTimes(1);
    expect(loadSpineClipMock.mock.calls[0][0]).toBe("/spines/creature.tscn?node=Sprite&anim=idle");
  });
});

// --- the deadline arithmetic itself ----------------------------------------------------------------------------

describe("msToNextGeoclipFrame", () => {
  const clip = { frames: new Array(4).fill(null), fps: GEO_FPS };

  it("answers the time to the NEXT grid point, and never zero on a boundary", () => {
    expect(msToNextGeoclipFrame(clip, 0, true)).toBe(GEO_PERIOD);
    expect(msToNextGeoclipFrame(clip, 10, true)).toBe(GEO_PERIOD - 10);
    // A play time landing exactly on a boundary is a WHOLE period from the next one: answering 0 would book an
    // rAF to repaint the frame already up, and the stage would never sleep.
    expect(msToNextGeoclipFrame(clip, GEO_PERIOD, true)).toBe(GEO_PERIOD);
  });

  it("wraps a looping clip past its last frame", () => {
    expect(msToNextGeoclipFrame(clip, 4 * GEO_PERIOD + 10, true)).toBe(GEO_PERIOD - 10);
  });

  it("answers Infinity for a single-frame clip and for a one-shot that has run out", () => {
    expect(msToNextGeoclipFrame({ frames: [null], fps: GEO_FPS }, 0, true)).toBe(Number.POSITIVE_INFINITY);
    expect(msToNextGeoclipFrame(clip, 3 * GEO_PERIOD, false)).toBe(Number.POSITIVE_INFINITY);
    expect(msToNextGeoclipFrame(clip, 3 * GEO_PERIOD - 1, false)).toBe(1);
  });

  it("falls back to 30fps for a clip whose fps is missing or nonsense", () => {
    expect(msToNextGeoclipFrame({ frames: new Array(4).fill(null), fps: 0 }, 0, true)).toBeCloseTo(1000 / 30, 9);
  });
});
