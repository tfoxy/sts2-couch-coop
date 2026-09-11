import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,


  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import type { LoadedSpineClip } from "@/mirror/spineClip";

// Aug-25 SPINE SUBTREE PAINT CULL (see applySpinePromotionPass in mirrorRenderer.ts).
//
// On a high-DPR phone Blink culls the paint recording of a spine node's SUBTREE, so a large still `<img>` stops
// painting partway across and the stage background shows through the rest of it. The verified fix is a composited
// layer on the spine NODE (`will-change: transform`, carried by `.mirror-spine-promoted`), and the thing worth
// pinning here is not the CSS — it is the SCOPE, because the promotion costs a compositor layer:
//
//   (a) the node paints a spine STILL (a dynamic clip already owns a `<canvas>` layer, so it never needs this), AND
//   (b) its subtree contains a composited effect surface (the bone-attached VFX that trigger the cull).
//
// Condition (b) is about DESCENDANTS that come and go asynchronously, so these specs also pin the RE-EVALUATION:
// the verdict must follow the DOM rather than being decided once when the still mounts.
//
// jsdom has no canvas 2D context and no network, so the clip client is mocked (the layer-diet specs' idiom) and
// the mechanism swap is driven by resolving a canned 1-frame (still) or 3-frame (dynamic) clip.

const { loadSpineClipMock } = vi.hoisted(() => ({ loadSpineClipMock: vi.fn() }));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return { ...actual, loadSpineClip: (url: string) => loadSpineClipMock(url) };
});

type Raw = Record<string, unknown>;

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };
const xf = (tx: number, ty: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } });

const ROOT: Raw = { id: "Game", parentId: null, name: "Game", nodeType: "Godot.Control", visible: true };

// The shop's shape: a background SpineSprite whose skeleton carries bone-attached VFX as scene CHILDREN.
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

// A bone-attached emitter: the renderer mounts a `.mirror-particle-self` for gsw inside this node's element, and
// that element is a DOM descendant of the spine node's (the mirror nests elements the way the scene nests nodes).
function emitter(parentId: string): Raw {
  return {
    id: "Fire",
    parentId,
    name: "fire4",
    nodeType: "GPUParticles2D",
    visible: true,
    transform: xf(960, 540),
    particleSpec: {
      kind: "GPUParticles2D",
      amount: 8,
      lifetime: 2,
      oneShot: false,
      scaleMin: 1,
      scaleMax: 1,
      emissionShape: 0,
      texture: { resourcePath: "res://images/vfx/common/common_glow.png", resourceType: "Texture2D", resourceName: "" },
      blendMode: 1
    },
    particleEmitting: true,
    particleRestartEpoch: 1
  };
}

function clip(frameCount: number, stillUrl: string | null): LoadedSpineClip {
  const frames = Array.from({ length: frameCount }, (_, i) => ({
    index: i,
    offsetX: 0,
    offsetY: 0,
    width: 2080,
    height: 1005,
    durationMs: 100,
    startMs: i * 100,
    png: new Uint8Array(),
    bitmap: { id: `f${i}` } as unknown as ImageBitmap
  }));
  return {
    canvasWidth: 2080,
    canvasHeight: 1005,
    totalDurationMs: frameCount * 100,
    localX: 0,
    localY: 0,
    localWidth: 2080,
    localHeight: 1005,
    frames,
    stillUrl,
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
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

function el(stage: HTMLElement, id: string): HTMLElement {
  const found = stage.querySelector(`[data-node-id="${id}"]`);
  expect(found, `element ${id}`).not.toBeNull();
  return found as HTMLElement;
}

const PROMOTED = "mirror-spine-promoted";

// Let the mocked loadSpineClip resolve and the reconciler's .then (plus the still decode gate) run.
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

// Mount a scene, resolve its clip, and hand back the spine node's element.
async function build(nodes: Raw[]): Promise<{ stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState }> {
  const { stage, renderer } = harness();
  const state = createMirrorState();
  full(state, nodes);
  renderer.reconcile(state);
  await settle();
  return { stage, renderer, state };
}

let disposers: Array<() => void> = [];

beforeEach(() => {
  loadSpineClipMock.mockReset();
  // Pin a tier that mounts particles, so condition (b)'s effect surface never depends on jsdom's GPU probe.
  __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high", gpu: UNKNOWN_GPU }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    clearRect: vi.fn()
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  for (const dispose of disposers) {
    dispose();
  }
  disposers = [];
  document.body.innerHTML = "";
  __setRenderQualityForTest(undefined);
  vi.restoreAllMocks();
});

describe("mirror spine subtree paint-cull promotion", () => {
  it("promotes a spine node that paints a STILL and has an effect surface in its subtree", async () => {
    loadSpineClipMock.mockResolvedValue(clip(1, "blob:still"));
    const { stage, renderer, state } = await build([ROOT, spineNode(), emitter("Spine")]);
    disposers.push(() => renderer.dispose());

    const node = el(stage, "Spine");
    // The shape the promotion is scoped to: the still <img> mechanism, plus an effect mount point below it.
    expect(node.querySelector("img.mirror-spine-img"), "still mechanism").not.toBeNull();
    expect(node.querySelector(".mirror-particle-self"), "effect surface in the subtree").not.toBeNull();
    expect(node.classList.contains(PROMOTED)).toBe(true);

    // The gauge is what says how much compositor memory the fix costs; it is published per walk.
    renderer.reconcile(state);
    expect(mirrorWalkStats.spinePromotedNodes).toBe(1);
  });

  it("leaves a still with NO effect descendants unpromoted", async () => {
    loadSpineClipMock.mockResolvedValue(clip(1, "blob:still"));
    const { stage, renderer, state } = await build([ROOT, spineNode(), emitter("Game")]);
    disposers.push(() => renderer.dispose());

    const node = el(stage, "Spine");
    expect(node.querySelector("img.mirror-spine-img")).not.toBeNull();
    // The emitter is a SIBLING of the spine node, not a descendant — the containment split is the whole predicate
    // (in the shop, `BgContainer/fire` is harmless while `SpineSprite/SpineBoneNode/fire4` is not).
    expect(node.querySelector(".mirror-particle-self")).toBeNull();
    expect(stage.querySelector(".mirror-particle-self"), "the effect exists, just not under the spine").not.toBeNull();
    expect(node.classList.contains(PROMOTED)).toBe(false);

    renderer.reconcile(state);
    expect(mirrorWalkStats.spinePromotedNodes).toBe(0);
  });

  it("leaves the CANVAS mechanism unpromoted even with effect descendants", async () => {
    // A multi-frame (dynamic) clip keeps its <canvas>, which is already its own composited layer.
    loadSpineClipMock.mockResolvedValue(clip(3, null));
    const { stage, renderer } = await build([ROOT, spineNode(), emitter("Spine")]);
    disposers.push(() => renderer.dispose());

    const node = el(stage, "Spine");
    expect(node.querySelector("canvas.mirror-spine-canvas")).not.toBeNull();
    expect(node.querySelector("img.mirror-spine-img")).toBeNull();
    expect(node.querySelector(".mirror-particle-self")).not.toBeNull();
    expect(node.classList.contains(PROMOTED)).toBe(false);
  });

  it("drops the promotion when the still swaps back to the animated canvas", async () => {
    loadSpineClipMock.mockResolvedValue(clip(1, "blob:still"));
    const { stage, renderer, state } = await build([ROOT, spineNode(), emitter("Spine")]);
    disposers.push(() => renderer.dispose());
    expect(el(stage, "Spine").classList.contains(PROMOTED)).toBe(true);

    // A new anim identity resolves to a multi-frame clip: mechanism <img> → <canvas>, so condition (a) is gone.
    loadSpineClipMock.mockResolvedValue(clip(3, null));
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [{ ...spineNode(), spineCurrentAnim: "attack" }]
      })!
    );
    renderer.reconcile(state);
    await settle();

    const node = el(stage, "Spine");
    expect(node.querySelector("canvas.mirror-spine-canvas")).not.toBeNull();
    expect(node.classList.contains(PROMOTED)).toBe(false);
  });

  it("drops the promotion when the subtree LOSES its effect surfaces", async () => {
    loadSpineClipMock.mockResolvedValue(clip(1, "blob:still"));
    const { stage, renderer, state } = await build([ROOT, spineNode(), emitter("Spine")]);
    disposers.push(() => renderer.dispose());
    expect(el(stage, "Spine").classList.contains(PROMOTED)).toBe(true);

    // The VFX leaves the scene (a structural delta) — the node keeps its still but no longer has the failing shape,
    // and a `will-change` nobody re-derives is a composited layer paid for forever.
    full(state, [ROOT, spineNode()]);
    renderer.reconcile(state);
    await settle();

    const node = el(stage, "Spine");
    expect(node.querySelector("img.mirror-spine-img"), "still still painting").not.toBeNull();
    expect(node.querySelector(".mirror-particle-self")).toBeNull();
    expect(node.classList.contains(PROMOTED)).toBe(false);
    expect(mirrorWalkStats.spinePromotedNodes).toBe(0);
  });

  it("promotes a still whose effect surface only arrives on a LATER walk", async () => {
    loadSpineClipMock.mockResolvedValue(clip(1, "blob:still"));
    const { stage, renderer, state } = await build([ROOT, spineNode()]);
    disposers.push(() => renderer.dispose());
    expect(el(stage, "Spine").classList.contains(PROMOTED)).toBe(false);

    // Condition (b) is a statement about descendants, so the verdict cannot be decided once at mount.
    full(state, [ROOT, spineNode(), emitter("Spine")]);
    renderer.reconcile(state);
    await settle();

    expect(el(stage, "Spine").classList.contains(PROMOTED)).toBe(true);
  });

});
