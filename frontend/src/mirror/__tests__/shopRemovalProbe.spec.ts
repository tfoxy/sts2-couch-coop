import { describe, expect, it } from "vitest";

import type { InteractiveRect } from "@/mirror/renderer/contracts";
import { mirrorShopRemovalProbe } from "@/mirror/shopRemovalProbe";
import { applySceneDelta, createMirrorState, parseSceneDelta } from "@/mirror/sceneTree";

function node(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Control",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y: 0 } },
    localRect: { position: { x: 0, y: 0 }, size: { x: 10, y: 10 } },
    visible: true,
    ...over,
  };
}

/** The producer omits `visible` when it is true; keep that wire-default in the regression shape. */
function recordedNode(id: string, parentId: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  const result = node(id, parentId, over);
  delete result.visible;
  return result;
}

function stateOf(nodes: Record<string, unknown>[]) {
  const state = createMirrorState();
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: nodes.map((n) => n.id) })!);
  return state;
}

function rect(id: string, x: number, y: number, width: number, height: number): InteractiveRect {
  return { id, transform: [1, 0, 0, 1, x, y], localRect: { x: 0, y: 0, width, height }, spreadDx: 0, renderedWidth: 0, raiseDy: 0 };
}

describe("mirrorShopRemovalProbe", () => {
  it("uses the direct service Hitbox and the largest visible descendant of a zero-sized card anchor", () => {
    const state = stateOf([
      node("Root", null),
      node("Removal", "Root", { nodeType: "Game.NMerchantCardRemoval" }),
      node("Cost", "Removal"),
      node("RemovalHitbox", "Removal", { name: "Hitbox" }),
      node("Picker", "Root", { nodeType: "Game.NDeckCardSelectScreen" }),
      node("Grid", "Picker", { nodeType: "Game.NCardGrid" }),
      node("Holder", "Grid", { nodeType: "Game.NGridCardHolder" }),
      node("Card", "Holder", { nodeType: "Game.NCard", localRect: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } } }),
      node("Small", "Card"),
      node("CardHitbox", "Card", { name: "Hitbox" }),
    ]);
    const probe = mirrorShopRemovalProbe(state.nodes, [
      rect("RemovalHitbox", 100, 200, 30, 20),
      rect("Card", 500, 300, 0, 0),
      rect("Small", 510, 310, 10, 10),
      rect("CardHitbox", 500, 300, 100, 80),
    ]);

    expect(probe).toEqual({
      service: { id: "Removal", hitboxId: "RemovalHitbox", gameCenter: { x: 115, y: 210 } },
      picker: { screenId: "Picker", cards: [{ id: "Card", hitboxId: "CardHitbox", gameCenter: { x: 550, y: 340 } }] },
    });
  });

  it("drops a spent or hidden service and a hidden picker", () => {
    const state = stateOf([
      node("Root", null),
      node("Removal", "Root", { nodeType: "Game.NMerchantCardRemoval", visible: false }),
      node("Cost", "Removal"),
      node("RemovalHitbox", "Removal", { name: "Hitbox" }),
      node("Picker", "Root", { nodeType: "Game.NDeckCardSelectScreen", visible: false }),
      node("Card", "Picker", { nodeType: "Game.NCard" }),
    ]);
    expect(mirrorShopRemovalProbe(state.nodes, [rect("RemovalHitbox", 0, 0, 10, 10), rect("Card", 0, 0, 100, 100)])).toEqual({ service: null, picker: null });

    const spent = stateOf([
      node("Removal", null, { nodeType: "Game.NMerchantCardRemoval" }),
      node("Cost", "Removal", { visible: false }),
      node("RemovalHitbox", "Removal", { name: "Hitbox" }),
    ]);
    expect(mirrorShopRemovalProbe(spent.nodes, [rect("RemovalHitbox", 0, 0, 10, 10)])).toEqual({ service: null, picker: null });
  });

  it("resolves a synthetic exact NDeckCardSelectScreen card through its sibling holder hitbox", () => {
    // This is deliberately a compact, hand-authored shape: production recordings are captured game payloads and
    // must not enter the repository. The producer omits `visible:true`; explicit false is the only hidden case.
    const state = stateOf([
      recordedNode("Root", null),
      recordedNode("Removal", "Root", { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantCardRemoval" }),
      recordedNode("Cost", "Removal"),
      recordedNode("RemovalHitbox", "Removal", { name: "Hitbox" }),
      recordedNode("DeckPicker", "Root", { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.CardSelect.NDeckCardSelectScreen" }),
      recordedNode("Grid", "DeckPicker", { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.CardSelect.NCardGrid" }),
      recordedNode("Holder", "Grid", { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.CardSelect.NGridCardHolder" }),
      recordedNode("HolderHitbox", "Holder", { nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCardHolderHitbox", mouseFilter: 0 }),
      recordedNode("Card", "Holder", { nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard", mouseFilter: 2, localRect: { position: { x: 0, y: 0 }, size: { x: 0, y: 0 } } }),
      // An explicit hidden holder must not leak its sibling surface into the picker.
      node("HiddenHolder", "Grid", { nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.CardSelect.NGridCardHolder", visible: false }),
      node("HiddenHolderHitbox", "HiddenHolder", { nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCardHolderHitbox", mouseFilter: 0 }),
      node("HiddenCard", "HiddenHolder", { nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard", mouseFilter: 2 }),
      // A same-shaped card outside the exact picker must not be offered as a removable card.
      recordedNode("Elsewhere", "Root", { nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard" }),
      recordedNode("ElsewhereHitbox", "Elsewhere", { name: "Hitbox" }),
    ]);

    expect(mirrorShopRemovalProbe(state.nodes, [
      rect("RemovalHitbox", 100, 200, 30, 20),
      rect("HolderHitbox", 500, 300, 300, 422),
      rect("HiddenHolderHitbox", 100, 100, 300, 422),
      rect("ElsewhereHitbox", 900, 300, 100, 80),
    ])).toEqual({
      service: { id: "Removal", hitboxId: "RemovalHitbox", gameCenter: { x: 115, y: 210 } },
      picker: { screenId: "DeckPicker", cards: [{ id: "Card", hitboxId: "HolderHitbox", gameCenter: { x: 650, y: 511 } }] },
    });
  });
});
