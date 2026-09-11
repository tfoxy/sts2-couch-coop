import { beforeEach, describe, expect, it } from "vitest";

import { createMirrorRenderer, mirrorWalkStats, type MirrorRenderer } from "@/mirror/mirrorRenderer";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorState
} from "@/mirror/sceneTree";

// R10 LATE-NODE GUARD — "the relics are missing until I reload the browser" / "the targeting arrow never appears
// after a game restart".
//
// Both are ONE seam. The renderer picks a STRUCTURAL walk purely on `state.orderedIds !== lastOrderedIds`; an
// "update" walk never runs rebuildStructure, so a node the map did not previously hold is merged into
// `state.nodes` and then never placed in the tree — it renders as NOTHING. That is reachable exactly when a node's
// id is ALREADY in the order before its first upsert arrives, which is what a producer that ships pruned hidden
// subtrees in OrderedIds does: the treasure relics and the 20 targeting-arrow segments are born hidden (so pruned
// from every incremental capture, never emitted) while their ids ride the order array from the first keyframe.
// Opening the chest / selecting a target then emits them with NO order change, and the client drops them on the
// floor until something else happens to change the order — a browser reload being the reliable "something else".
//
// The producer + host now keep the invariant (`orderedIds ⊆ nodes the client holds`), so in practice this guard
// never fires; these specs pin the CLIENT half so the renderer is correct against any producer version.

function xform(tx: number, ty: number): Record<string, unknown> {
  return { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: tx, y: ty } };
}

function box(w: number, h: number): Record<string, unknown> {
  return { position: { x: 0, y: 0 }, size: { x: w, y: h } };
}

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function rawNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Control",
    transform: xform(0, 0),
    localRect: box(100, 16),
    visible: true,
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(
    state,
    parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!
  );
}

// The exact wire shape of the defect: upserts, NO orderedIds, NO orderPatch.
function volatileDelta(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

function el(stage: HTMLElement, id: string): HTMLElement | null {
  return stage.querySelector(`[data-node-id="${id}"]`);
}

beforeEach(() => {
  document.body.innerHTML = "";
  mirrorWalkStats.reset();
});

describe("late-node structure guard", () => {
  it("places a node whose id was already in the order when its FIRST upsert arrives without an order change", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    // The keyframe's order names "relic" (the producer put the pruned hidden node in the array) but carries no
    // node for it — exactly what a pre-R10 producer/host pair shipped.
    full(state, [rawNode("room", null), rawNode("chest", "room")], ["room", "chest", "relic"]);
    renderer.reconcile(state);
    expect(el(stage, "relic")).toBeNull();

    mirrorWalkStats.reset();
    // The chest opens: the relic finally emits, with no order change (nothing about the tree SHAPE changed).
    volatileDelta(state, [rawNode("relic", "room", { transform: xform(40, 40) })]);
    renderer.reconcile(state);

    expect(el(stage, "relic")).not.toBeNull();
    expect(el(stage, "relic")!.parentElement).toBe(el(stage, "room"));
    // It got there through a structural walk (the guard's whole mechanism), not a lucky restyle.
    expect(mirrorWalkStats.updateWalks).toBe(0);
  });

  it("places a whole formerly-hidden SUBTREE (the targeting arrow's segments) from one order-less delta", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    const segmentIds = Array.from({ length: 20 }, (_, i) => `seg${i}`);
    // Run start: the arrow root is emitted hidden, its segments are pruned — but every id rides the order.
    full(
      state,
      [rawNode("run", null), rawNode("arrow", "run", { visible: false })],
      ["run", "arrow", ...segmentIds]
    );
    renderer.reconcile(state);
    expect(el(stage, "seg0")).toBeNull();

    // First target select: the arrow flips visible and its segments emit for the first time — one delta, no order.
    volatileDelta(state, [
      rawNode("arrow", "run", { visible: true }),
      ...segmentIds.map((id, i) => rawNode(id, "arrow", { transform: xform(i * 10, 0) }))
    ]);
    renderer.reconcile(state);

    for (const id of segmentIds) {
      expect(el(stage, id), `segment ${id} is in the DOM`).not.toBeNull();
    }
  });

  it("does NOT force a structural walk for a plain volatile tick (no new node ids)", () => {
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("room", null), rawNode("card", "room")], ["room", "card"]);
    renderer.reconcile(state);

    const orderBefore = state.orderedIds;
    mirrorWalkStats.reset();
    // The per-tick shape: known ids only. The order array must keep its REFERENCE so the walk stays an "update".
    volatileDelta(state, [{ id: "card", parentId: "room", transform: xform(5, 5), localRect: box(100, 16) }]);
    renderer.reconcile(state);

    expect(state.orderedIds).toBe(orderBefore);
    expect(mirrorWalkStats.updateWalks).toBe(1);
    expect(mirrorWalkStats.incrementalStructuralWalks).toBe(0);
    expect(el(stage, "card")).not.toBeNull();
  });

  it("leaves the order alone when the delta already carries one (the ordinary structural send)", () => {
    const { renderer } = harness();
    const state = createMirrorState();
    full(state, [rawNode("room", null)], ["room"]);
    renderer.reconcile(state);

    // A normal add: upserts + orderedIds together. The guard must not double-copy the array the wire supplied.
    const order = ["room", "new"];
    applySceneDelta(
      state,
      parseSceneDelta({
        type: "scene-delta",
        full: false,
        screenType: "run",
        upserts: [rawNode("new", "room")],
        orderedIds: order
      })!
    );
    expect(state.orderedIds).toEqual(order);
  });

  it("does nothing when there is no order yet (nothing to rebuild against)", () => {
    const state = createMirrorState();
    volatileDelta(state, [rawNode("orphan", null)]);
    expect(state.orderedIds).toEqual([]);
  });
});
