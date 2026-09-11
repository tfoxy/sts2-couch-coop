import { describe, expect, it } from "vitest";

import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  type MirrorState
} from "@/mirror/sceneTree";

// R13 CONTENT KEY (`RuntimeSceneNodeDelta.ContentKey` → wire `contentKey` → `MirrorNode.contentKey`). STS2 POOLS
// its `NCard` visuals: ~30 instances are re-assigned as cards move between hand / draw / discard / reward / shop, so
// a streamed node's INSTANCE id says nothing about which card is on screen (the same id is a Strike this tick and a
// Bash the next). The producer therefore ships `nc:{entry}#{serial}` — a stable identity for the CONTENT — with the
// STATIC block only. This spec pins the two halves the renderer depends on: the parse, and the static-merge rule
// (a volatile-only upsert keeps the retained key; a static payload replaces it, which is exactly the pool-recycling
// edge a client must notice).

function cardWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "card",
    parentId: null,
    name: "Card",
    nodeType: "Control",
    sceneFilePath: "res://scenes/cards/card.tscn",
    contentKey: "nc:Strike#1",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 100, y: 200 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 200, y: 280 } },
    ...over
  };
}

function apply(state: MirrorState, upserts: Record<string, unknown>[], full = false): void {
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full,
      screenType: "run",
      upserts,
      orderedIds: full ? ["card"] : null
    })!
  );
}

function keyed(over: Record<string, unknown> = {}): MirrorState {
  const state = createMirrorState();
  apply(state, [cardWire(over)], true);
  return state;
}

describe("parseSceneDelta contentKey", () => {
  it("parses the pooled-card content key off a static payload", () => {
    expect(keyed().nodes.get("card")!.contentKey).toBe("nc:Strike#1");
  });

  it("is null for a node the producer never keyed (every non-card node)", () => {
    expect(keyed({ contentKey: undefined }).nodes.get("card")!.contentKey).toBeNull();
  });

  it("is null for a non-string wire value rather than coerced", () => {
    expect(keyed({ contentKey: 7 }).nodes.get("card")!.contentKey).toBeNull();
  });
});

describe("mergeNode contentKey (static retention)", () => {
  it("keeps the retained key across a volatile-only upsert", () => {
    const state = keyed();
    // A per-tick upsert: no name (→ the volatile-merge branch), and the server's volatile projection drops every
    // static field, so no contentKey rides it. The retained key must survive.
    apply(state, [
      {
        id: "card",
        transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 140, y: 200 } },
        opacity: 0.5
      }
    ]);

    const node = state.nodes.get("card")!;
    expect(node.contentKey).toBe("nc:Strike#1");
    // Sanity: the volatile fields did come from the upsert (this is not a stale node).
    expect(node.transform?.[4]).toBe(140);
    expect(node.opacity).toBe(0.5);
  });

  it("takes the fresh key when the pooled node is re-assigned (static payload)", () => {
    const state = keyed();
    // The game recycled the pooled shell onto another card: the producer re-ships the static block, so the upsert
    // carries a name AND the new key. This is the edge a client's DOM adoption has to see.
    apply(state, [cardWire({ contentKey: "nc:Bash#2" })]);
    expect(state.nodes.get("card")!.contentKey).toBe("nc:Bash#2");

    // And the NEW key is what the next volatile-only upsert carries forward.
    apply(state, [{ id: "card", opacity: 0.25 }]);
    expect(state.nodes.get("card")!.contentKey).toBe("nc:Bash#2");
  });

  it("clears the key when a static payload arrives without one (an un-assigned pool shell)", () => {
    const state = keyed();
    apply(state, [cardWire({ contentKey: undefined })]);
    expect(state.nodes.get("card")!.contentKey).toBeNull();
  });
});
