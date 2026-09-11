import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,
  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  mirrorResourceUrl,
  parseSceneDelta,
  type MirrorState
} from "@/mirror/sceneTree";
import {
  __recordTextureSizeForTest,
  __resetTextureCacheForTest,
  __textureWaitersForTest,
  naturalSize,
  onTextureSizesResolved,
  setTextureStyleNode
} from "@/mirror/textureCache";

// R10-PERF3 WS-4 — TARGETED texture-size re-styles. A texture's natural size arrives asynchronously, and two style
// paths (nodeStyles: the nine-patch-over-atlas slicer and the plain NinePatchRect degenerate-margin fallback) style
// PROVISIONALLY until it does. Forcing a scene-wide `forceTextures` walk per resolved load was the remaining source
// of full walks on a card play — a texture storm of several urls, each landing on its own frame, each ~105-156ms on
// a phone. Now the cache remembers WHICH nodes styled against a not-yet-measured url and the renderer re-styles
// exactly those through the same dirty-id propagation a wire change uses.
//
// The oracle for every parity assertion here is the OLD path: style the same scene with the size already known so
// the first (full) walk produces the final style, then compare against the targeted re-visit's DOM.

const ATLAS_PAGE = "res://images/packed/ui.png";
const ATLAS_URL = mirrorResourceUrl(ATLAS_PAGE);
const BUTTON_TEX = "res://images/packed/common_ui/event_button.png";
const BUTTON_URL = mirrorResourceUrl(BUTTON_TEX);

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function rect(x: number, y: number, width: number, height: number): Record<string, unknown> {
  return { position: { x, y }, size: { x: width, y: height } };
}

function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: rect(0, 0, 100, 16),
    visible: true,
    ...over
  };
}

// A NinePatchRect drawing an ATLAS region: 9-sliced as child spans, which need the atlas PAGE's natural size.
function ninePatchAtlasNode(id: string, parentId: string | null): Record<string, unknown> {
  return rawNode(id, parentId, {
    nodeType: "NinePatchRect",
    texture: { resourcePath: ATLAS_PAGE },
    textureRegion: rect(64, 128, 60, 40),
    ninePatch: true,
    ninePatchMargins: { left: 12, top: 10, right: 12, bottom: 10 },
    localRect: rect(0, 0, 300, 90)
  });
}

// A plain NinePatchRect whose margins OVERLAP the source texture (284 wide, 192+192 margins) — degenerate, so once
// the size is known nodeStyle paints a stretched full-texture background under the border-image. Until then the
// check can't fire and the node styles caps-only.
function degenerateNinePatchNode(id: string, parentId: string | null): Record<string, unknown> {
  return rawNode(id, parentId, {
    nodeType: "NinePatchRect",
    texture: { resourcePath: BUTTON_TEX },
    ninePatch: true,
    ninePatchMargins: { left: 192, top: 50, right: 192, bottom: 50 },
    localRect: rect(0, 0, 800, 300)
  });
}

const SCENE_ORDER = ["root", "np-atlas", "np-degenerate", "plain"];

function scene(): Record<string, unknown>[] {
  return [
    rawNode("root", null, { localRect: rect(0, 0, 1920, 1080) }),
    ninePatchAtlasNode("np-atlas", "root"),
    degenerateNinePatchNode("np-degenerate", "root"),
    rawNode("plain", "root", { nodeType: "TextureRect", transform: xform(10, 20) })
  ];
}

function keyframe(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!
  );
}

let created: MirrorRenderer[] = [];

function harness(): { stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  const renderer = createMirrorRenderer(stage, defs);
  created.push(renderer);
  const state = createMirrorState();
  keyframe(state, scene(), SCENE_ORDER);
  return { stage, renderer, state };
}

// DOM style parity: every element in paint order, keyed by its node id / class, with its inline style declaration
// serialized as SORTED key:value pairs (so a property that arrives on a later update walk — and is therefore
// appended at the end of the style attribute — still compares equal to the same property written up front).
function serializeStyles(stage: HTMLElement): string {
  const lines: string[] = [];
  for (const el of stage.querySelectorAll<HTMLElement>("*")) {
    const key = el.getAttribute("data-node-id") ?? `${el.tagName.toLowerCase()}.${el.className}`;
    const decl = el.style;
    const props: string[] = [];
    for (let i = 0; i < decl.length; i++) {
      const name = decl.item(i);
      props.push(`${name}:${decl.getPropertyValue(name)}`);
    }
    props.sort();
    lines.push(`${key}|${props.join(";")}`);
  }
  return lines.join("\n");
}

beforeEach(() => {
  document.body.innerHTML = "";
  created = [];
  mirrorWalkStats.reset();
  __resetTextureCacheForTest();
});

afterEach(() => {
  for (const r of created) {
    r.dispose();
  }
  created = [];
  document.body.innerHTML = "";
  __resetTextureCacheForTest();
  setTextureStyleNode(null);
});

// --- the url → node-id registry ------------------------------------------------------------------------------

describe("textureCache waiter registry", () => {
  it("registers the styling node on a MISS and notifies it when the size lands", () => {
    const seen: string[][] = [];
    const off = onTextureSizesResolved((ids) => seen.push([...ids]));
    setTextureStyleNode("n1");
    expect(naturalSize(ATLAS_URL)).toBeNull();
    setTextureStyleNode(null);
    expect(__textureWaitersForTest(ATLAS_URL)).toEqual(["n1"]);
    __recordTextureSizeForTest(ATLAS_URL, 512, 512);
    expect(seen).toEqual([["n1"]]);
    // Resolved: the entry is gone, and a later style pass finds the size instead of re-registering.
    expect(__textureWaitersForTest(ATLAS_URL)).toEqual([]);
    setTextureStyleNode("n2");
    expect(naturalSize(ATLAS_URL)).toEqual({ width: 512, height: 512 });
    setTextureStyleNode(null);
    expect(__textureWaitersForTest(ATLAS_URL)).toEqual([]);
    off();
  });

  it("carries MANY nodes awaiting one url, and one node awaiting MANY urls", () => {
    const seen: string[][] = [];
    const off = onTextureSizesResolved((ids) => seen.push([...ids].sort()));
    for (const id of ["a", "b", "c"]) {
      setTextureStyleNode(id);
      naturalSize(ATLAS_URL);
      setTextureStyleNode(null);
    }
    setTextureStyleNode("a");
    naturalSize(BUTTON_URL);
    naturalSize(ATLAS_URL); // a re-style re-registers the same pair — deduped by the Set
    setTextureStyleNode(null);

    __recordTextureSizeForTest(ATLAS_URL, 512, 512);
    expect(seen).toEqual([["a", "b", "c"]]);
    __recordTextureSizeForTest(BUTTON_URL, 284, 110);
    expect(seen).toEqual([["a", "b", "c"], ["a"]]);
    off();
  });

  it("registers nothing outside a style scope, or for a size that is already known", () => {
    __recordTextureSizeForTest(BUTTON_URL, 284, 110);
    setTextureStyleNode("n1");
    expect(naturalSize(BUTTON_URL)).toEqual({ width: 284, height: 110 }); // already measured
    setTextureStyleNode(null);
    naturalSize(ATLAS_URL); // no styling node → a tween-endpoint probe / a unit test
    expect(__textureWaitersForTest(BUTTON_URL)).toEqual([]);
    expect(__textureWaitersForTest(ATLAS_URL)).toEqual([]);
  });

});

// --- the renderer: the walk re-styles exactly the awaiting nodes ----------------------------------------------

describe("targeted texture re-style through the reconcile walk", () => {
  it("registers the real nine-patch nodes while styling them, and nothing else", () => {
    const { renderer, state } = harness();
    renderer.reconcile(state);
    expect(__textureWaitersForTest(ATLAS_URL)).toEqual(["np-atlas"]);
    expect(__textureWaitersForTest(BUTTON_URL)).toEqual(["np-degenerate"]);
  });

  it("re-styles the awaiting nodes on a NORMAL update walk — byte-identical to the full-walk oracle", () => {
    // ORACLE: the size is known before anything is styled, so the very first (full) walk writes the final style.
    __recordTextureSizeForTest(ATLAS_URL, 512, 512);
    __recordTextureSizeForTest(BUTTON_URL, 284, 110);
    const oracle = harness();
    oracle.renderer.reconcile(oracle.state);
    const expected = serializeStyles(oracle.stage);
    expect(expected).toContain("mirror-np-slice");

    // TARGETED: the same scene styled provisionally, then re-styled from the resolved sizes alone.
    __resetTextureCacheForTest();
    const { stage, renderer, state } = harness();
    const off = onTextureSizesResolved((ids) => renderer.markTextureDirty(ids));
    renderer.reconcile(state);
    const provisional = serializeStyles(stage);
    expect(provisional).not.toContain("mirror-np-slice"); // no page size yet ⇒ no slices
    expect(provisional).not.toBe(expected);

    const fullWalksBefore = mirrorWalkStats.fullWalks;
    const updateWalksBefore = mirrorWalkStats.updateWalks;
    __recordTextureSizeForTest(ATLAS_URL, 512, 512);
    __recordTextureSizeForTest(BUTTON_URL, 284, 110);
    renderer.reconcile(state);
    off();

    expect(serializeStyles(stage)).toBe(expected);
    // …and it cost ONE pruned update walk, not a scene-wide re-touch.
    expect(mirrorWalkStats.fullWalks).toBe(fullWalksBefore);
    expect(mirrorWalkStats.updateWalks).toBe(updateWalksBefore + 1);
    expect(mirrorWalkStats.textureRestyles).toBe(2);
  });

  it("styles ONLY the awaiting nodes — an untouched sibling is not re-styled", () => {
    const { renderer, state } = harness();
    const off = onTextureSizesResolved((ids) => renderer.markTextureDirty(ids));
    renderer.reconcile(state);
    __recordTextureSizeForTest(ATLAS_URL, 512, 512);
    const styledBefore = mirrorWalkStats.styledNodes;
    renderer.reconcile(state);
    off();
    // Exactly one node re-styled (np-atlas); `root` is only descended THROUGH (recurse-only fast path).
    expect(mirrorWalkStats.styledNodes).toBe(styledBefore + 1);
    expect(mirrorWalkStats.textureRestyles).toBe(1);
  });

  it("accumulates loads across coalesced deltas and consumes them exactly once", () => {
    const { stage, renderer, state } = harness();
    const off = onTextureSizesResolved((ids) => renderer.markTextureDirty(ids));
    renderer.reconcile(state);
    // Two loads land before the single coalesced render — neither may be lost.
    __recordTextureSizeForTest(ATLAS_URL, 512, 512);
    __recordTextureSizeForTest(BUTTON_URL, 284, 110);
    renderer.reconcile(state);
    off();
    expect(mirrorWalkStats.textureRestyles).toBe(2);
    expect(stage.querySelectorAll(".mirror-np-slice").length).toBe(9);

    // Consumed: a following reconcile re-styles nothing (the pending set was cleared with changedIds).
    const styledBefore = mirrorWalkStats.styledNodes;
    renderer.reconcile(state);
    expect(mirrorWalkStats.styledNodes).toBe(styledBefore);
    expect(mirrorWalkStats.textureRestyles).toBe(2);
  });

  it("drops a STALE id (its node was removed before the load landed) without doing any work", () => {
    const { renderer, state } = harness();
    renderer.reconcile(state);
    const styledBefore = mirrorWalkStats.styledNodes;
    const fullWalksBefore = mirrorWalkStats.fullWalks;
    renderer.markTextureDirty(["ghost-node-that-never-existed"]);
    expect(() => renderer.reconcile(state)).not.toThrow();
    expect(mirrorWalkStats.textureDirtyIds).toBe(1);
    expect(mirrorWalkStats.textureRestyles).toBe(0); // filtered against the walk's own node map
    expect(mirrorWalkStats.styledNodes).toBe(styledBefore);
    expect(mirrorWalkStats.fullWalks).toBe(fullWalksBefore);
  });

  it("a load that lands BEFORE the first build is absorbed by that build and does not linger", () => {
    const stage = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.appendChild(defs);
    document.body.append(stage, svg);
    const renderer = createMirrorRenderer(stage, defs);
    created.push(renderer);
    // Nothing has been styled, so nothing can be registered — but a caller may still hand ids over.
    renderer.markTextureDirty(["np-atlas"]);
    __recordTextureSizeForTest(ATLAS_URL, 512, 512);
    const state = createMirrorState();
    keyframe(state, scene(), SCENE_ORDER);
    renderer.reconcile(state); // the FIRST build is full: it styles everything, ids included
    expect(mirrorWalkStats.textureRestyles).toBe(0);
    expect(stage.querySelectorAll(".mirror-np-slice").length).toBe(9);
    // …and the pending set was consumed by that full walk, so the next reconcile re-styles nothing.
    const styledBefore = mirrorWalkStats.styledNodes;
    renderer.reconcile(state);
    expect(mirrorWalkStats.styledNodes).toBe(styledBefore);
  });

  it("still re-styles a node whose wire data ALSO changed in the same reconcile", () => {
    const { stage, renderer, state } = harness();
    const off = onTextureSizesResolved((ids) => renderer.markTextureDirty(ids));
    renderer.reconcile(state);
    __recordTextureSizeForTest(ATLAS_URL, 512, 512);
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        // The atlas crop is VOLATILE on the wire, so a re-upsert must carry it (else the node stops being a
        // nine-patch-over-atlas at all) — this is the "moved AND awaiting its page size" case.
        upserts: [{ ...ninePatchAtlasNode("np-atlas", "root"), transform: xform(5, 7) }]
      })!
    );
    renderer.reconcile(state);
    off();
    expect(stage.querySelectorAll(".mirror-np-slice").length).toBe(9);
  });
});

// --- full-walk cause breakdown --------------------------------------------------------------------------------

describe("mirrorWalkStats.fullWalkCauses", () => {
  it("attributes the initial build, a caller-named force, and a keyframe bail", () => {
    const { renderer, state } = harness();
    renderer.reconcile(state);
    expect(mirrorWalkStats.fullWalkCauses.firstBuild).toBe(1);

    renderer.reconcile(state, { forceTextures: true, reason: "spread" });
    expect(mirrorWalkStats.fullWalkCauses.spread).toBe(1);

    renderer.reconcile(state, { forceTextures: true });
    expect(mirrorWalkStats.fullWalkCauses.forceTextures).toBe(1);

    keyframe(state, scene(), SCENE_ORDER); // a wire keyframe pre-bails an orderedIds-changed reconcile to full
    renderer.reconcile(state);
    expect(mirrorWalkStats.fullWalkCauses.keyframe).toBe(1);

    const causes = mirrorWalkStats.fullWalkCauses;
    const sum = Object.values(causes).reduce((a, b) => a + b, 0);
    expect(sum).toBe(mirrorWalkStats.fullWalks);
  });

  it("reset() zeroes the breakdown in place (the bench holds the same object)", () => {
    const causes = mirrorWalkStats.fullWalkCauses;
    causes.bail = 3;
    mirrorWalkStats.reset();
    expect(mirrorWalkStats.fullWalkCauses).toBe(causes);
    expect(causes.bail).toBe(0);
  });
});

// --- MirrorView wiring ------------------------------------------------------------------------------------------

describe("MirrorView texture-size wiring", () => {
  it("schedules a normal targeted render", async () => {
    const rafQueue: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    const origCaf = globalThis.cancelAnimationFrame;
    const origRo = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      rafQueue.push(cb)) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    const flush = (): void => {
      const due = rafQueue.splice(0, rafQueue.length);
      for (const cb of due) {
        cb(0);
      }
    };

    const { mount } = await import("@vue/test-utils");
    const { nextTick } = await import("vue");
    const MirrorView = (await import("@/mirror/MirrorView.vue")).default;

    try {
      const state = createMirrorState();
      keyframe(state, scene(), SCENE_ORDER);
      const wrapper = mount(MirrorView, { props: { state, revision: 1 } });
      await nextTick();
      const fullWalksBefore = mirrorWalkStats.fullWalks;
      __recordTextureSizeForTest(ATLAS_URL, 512, 512);
      await nextTick();
      flush();
      expect(mirrorWalkStats.fullWalks).toBe(fullWalksBefore);
      expect(mirrorWalkStats.textureRestyles).toBe(1);
      expect(wrapper.element.querySelectorAll(".mirror-np-slice").length).toBe(9);
      wrapper.unmount();
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCaf;
      (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = origRo;
      vi.restoreAllMocks();
    }
  });
});
