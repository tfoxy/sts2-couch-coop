import { describe, expect, it } from "vitest";

import { type Affine, affineMul } from "@/mirror/affine";
import {
  applySceneDelta,
  createMirrorState,
  type MirrorState,
  parseSceneDelta
} from "@/mirror/sceneTree";

// P2 (WS-select) discard-select flash — WEB twin proof. The producer fix ships the reparent upsert WITHOUT a
// transform when a tween-suppression window covers the node. This proves the web client is already pass-through-
// correct for that case (the design's claim — proven, not assumed):
//   1. mergeNode wholesale-adopts a Name-bearing upsert (`if (upsert.name) return upsert`), so an omitted transform
//      truly leaves node.transform === null.
//   2. the renderer's gNode rule (mirrorRenderer.ts: `node.transform == null ? ctx.parentGlobal : ...`) then
//      composes the card at its PARENT's global — the new centre holder — instead of a corner. No flash.
// The before variant (round-3, transform present) is included to show the diff: the card lands bottom-centre.

// Wire transform helper (matches the producer's {xAxis,yAxis,origin} shape). 6-tuple order is [a,b,c,d,tx,ty].
function xform(tx: number, ty: number, a = 1, b = 0, c = 0, d = 1): Record<string, unknown> {
  return { xAxis: { x: a, y: b }, yAxis: { x: c, y: d }, origin: { x: tx, y: ty } };
}

function keyframe(state: MirrorState): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "run",
      upserts: [
        { id: "root", parentId: null, name: "Root", nodeType: "Control", transform: xform(0, 0) },
        { id: "cont", parentId: "root", name: "SelectedHandCardContainer", nodeType: "Control", transform: xform(960, 488) },
        { id: "hand", parentId: "cont", name: "HandHolder", nodeType: "Control", transform: xform(0, 400) },
        { id: "card", parentId: "hand", name: "Card", nodeType: "NCard", transform: xform(0, 0) }
      ],
      orderedIds: ["root", "cont", "hand", "card"]
    })!
  );
}

// The reparent drain: the fresh Sel holder (scale 0.8) appears under Cont and the card re-attaches under it. `card`
// is a Name-bearing upsert (a reparent ships the static block). When `omitTransform`, the transform field is ABSENT
// from the wire (the producer fix) — parseSceneDelta yields transform:null.
function reparent(state: MirrorState, omitTransform: boolean): void {
  const cardUpsert: Record<string, unknown> = { id: "card", parentId: "sel", name: "Card", nodeType: "NCard" };
  if (!omitTransform) {
    cardUpsert.transform = xform(0, 677.5); // round-3: the transition-start local
  }
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: false,
      upserts: [
        { id: "sel", parentId: "cont", name: "SelectedHandCardHolder", nodeType: "Control", transform: xform(0, 0, 0.8, 0, 0, 0.8) },
        cardUpsert
      ]
    })!
  );
}

// Compose a node's game-space global from the merged state using the EXACT gNode rule the renderer bakes
// (mirrorRenderer.ts): transform-less node → parent's global (pass-through); "local" space → affineMul down the
// chain. Streamed matrices are parent-relative here.
function composeGlobal(state: MirrorState, id: string): Affine {
  const node = state.nodes.get(id);
  if (!node) {
    throw new Error(`no node ${id}`);
  }
  const parentGlobal: Affine = node.parentId && state.nodes.has(node.parentId)
    ? composeGlobal(state, node.parentId)
    : [1, 0, 0, 1, 0, 0];
  return node.transform == null ? parentGlobal : affineMul(parentGlobal, node.transform as Affine);
}

describe("discard-select flash — transform-less reparent pass-through (web twin)", () => {
  it("round-3 (transform present) pins the card at bottom-centre — the flash", () => {
    const state = createMirrorState();
    keyframe(state);
    expect(composeGlobal(state, "card")).toEqual([1, 0, 0, 1, 960, 888]); // in the hand

    reparent(state, /* omitTransform */ false);
    const card = state.nodes.get("card")!;
    expect(card.parentId).toBe("sel");
    expect(card.transform).not.toBeNull(); // round-3 shipped the transition-start local
    // Composed global: holder(960,488, scale 0.8) · card-local(0,677.5) → (960, 488 + 0.8*677.5) = (960,1030).
    const g = composeGlobal(state, "card");
    expect(g[4]).toBeCloseTo(960, 3);
    expect(g[5]).toBeCloseTo(1030, 3);
    expect(g[5] - 540).toBeGreaterThan(400); // far below centre — the visible flash
  });

  it("the fix (transform-less reparent) merges to null and passes through to the holder/centre", () => {
    const state = createMirrorState();
    keyframe(state);

    reparent(state, /* omitTransform */ true);
    const card = state.nodes.get("card")!;
    // mergeNode wholesale-adopts the Name-bearing upsert → the omitted transform truly nulls the node.
    expect(card.parentId).toBe("sel");
    expect(card.transform).toBeNull();
    // gNode pass-through: a transform-less node's global IS its parent's (the holder at centre 960,488). No flash.
    const g = composeGlobal(state, "card");
    expect(g[4]).toBeCloseTo(960, 3);
    expect(g[5]).toBeCloseTo(488, 3);
    expect(Math.abs(g[5] - 488)).toBeLessThan(1); // at centre, NOT bottom-centre
  });

  it("settle resync lands the held card at centre (both variants end identical)", () => {
    const state = createMirrorState();
    keyframe(state);
    reparent(state, /* omitTransform */ true);

    // The container lifts to 540 and the card re-emits at the holder origin (0,0) on the settle frame.
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        upserts: [
          { id: "cont", parentId: "root", name: "SelectedHandCardContainer", nodeType: "Control", transform: xform(960, 540) },
          { id: "card", parentId: "sel", name: "Card", nodeType: "NCard", transform: xform(0, 0) }
        ]
      })!
    );

    const g = composeGlobal(state, "card");
    expect(g[4]).toBeCloseTo(960, 3);
    expect(g[5]).toBeCloseTo(540, 3);
  });
});
