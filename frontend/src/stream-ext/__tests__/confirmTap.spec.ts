import { describe, expect, it } from "vitest";

import type { Affine2D, ExtensionFrame, ItemMeta, ItemMetaBatch, ItemQuery, OverrideTable, Rect } from "@godot-scene-web/render-stream-client";

import { confirmKindFor, createConfirmTapExtension } from "@/stream-ext/confirmTap";
import {
  CONFIRM_TAP_GROUPS,
  RS_GROUP_CARD_REWARD_CARD,
  RS_GROUP_EVENT_OPTION,
  RS_GROUP_REST_SITE,
  RS_GROUP_SHOP_ITEM,
  RS_GROUP_TREASURE_RELIC
} from "@/stream-ext/groups";

// The stream's CONFIRM-TAP module: the group-based classification (with the singleplayer relic refused by name) and
// the button state anchored to the widget's presentation rect.

function meta(id: number, groups: string[], path: string | null = null): ItemMeta {
  return { id, node: true, class: null, script: null, scene: null, path, groups, meta: {} };
}

function batch(items: ItemMeta[]): ItemMetaBatch {
  return { form: "full", items };
}

function fakeQuery(parents: Record<number, number | null>, rects: Record<number, Rect> = {}): ItemQuery {
  return {
    parent: (id) => parents[id] ?? null,
    children: () => new Uint32Array(0),
    transform: () => [1, 0, 0, 1, 0, 0],
    rect: (id) => rects[id] ?? null,
    subtreeRect: (id) => rects[id] ?? null,
    visible: () => true,
    meta: () => null,
    hitTest: () => null
  };
}

function frame(query: ItemQuery, effective: (id: number) => Affine2D = () => [1, 0, 0, 1, 0, 0]): ExtensionFrame {
  return { seq: 1, now: 0, overrides: { effective } as OverrideTable, query, requestRedraw: () => {} };
}

describe("confirmTap — classification", () => {
  it("maps each confirm-eligible group to its kind", () => {
    expect(confirmKindFor(meta(1, [RS_GROUP_CARD_REWARD_CARD]))).toBe("reward");
    expect(confirmKindFor(meta(2, [RS_GROUP_TREASURE_RELIC], "MultiplayerRelicHolder1"))).toBe("relic");
    expect(confirmKindFor(meta(3, [RS_GROUP_EVENT_OPTION]))).toBe("event");
    expect(confirmKindFor(meta(4, [RS_GROUP_SHOP_ITEM]))).toBe("shop");
    expect(confirmKindFor(meta(5, [RS_GROUP_REST_SITE]))).toBe("rest");
  });

  it("refuses the singleplayer treasure chest by name (its Skip button owns that corner)", () => {
    expect(confirmKindFor(meta(2, [RS_GROUP_TREASURE_RELIC], "SingleplayerRelicHolder"))).toBeNull();
  });

  it("is null for an untagged item", () => {
    expect(confirmKindFor(meta(1, []))).toBeNull();
  });
});

describe("confirmTap — identity + button state", () => {
  it("asks for the confirm groups and the path (the singleplayer exclusion needs the name)", () => {
    const { extension } = createConfirmTapExtension();
    expect(extension.wants?.fields).toEqual(["path", "class", "script", "scene", "mouse_filter"]);
    expect([...(extension.wants?.groups ?? [])].sort()).toEqual([...CONFIRM_TAP_GROUPS].slice().sort());
    extension.dispose!();
  });

  it("classifies a tap on a widget's child as that widget", () => {
    const { extension, controller } = createConfirmTapExtension();
    const query = fakeQuery({
      20: 10, // a reward card's leaf child
      10: null // the reward card
    });
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_CARD_REWARD_CARD])]));
    extension.beforeDraw!(frame(query));

    expect(controller.classify(20)).toEqual({ id: 10, kind: "reward" });
    expect(controller.classify(99)).toBeNull();
    extension.dispose!();
  });

  it("classifies a card holder's Hitbox (Godot's tree pick) as the one reward card beside it", () => {
    // grid holder 30: its undrawn Hitbox 31 and the reward card 32 are siblings. Row 40: a Control 41 beside two cards.
    const { extension, controller } = createConfirmTapExtension();
    const parents: Record<number, number | null> = { 31: 30, 32: 30, 30: null, 41: 40, 42: 40, 43: 40, 40: null };
    const children: Record<number, number[]> = { 30: [31, 32], 40: [41, 42, 43] };
    const query: ItemQuery = { ...fakeQuery(parents), children: (id) => Uint32Array.from(children[id] ?? []) };
    extension.onItemMeta!(batch([32, 42, 43].map((id) => meta(id, [RS_GROUP_CARD_REWARD_CARD]))));
    extension.beforeDraw!(frame(query));

    expect(controller.classify(31)).toEqual({ id: 32, kind: "reward" });
    // A hit beside two cards is no holder's Hitbox: never a guess.
    expect(controller.classify(41)).toBeNull();
    extension.dispose!();
  });

  it("show raises the button anchored to the widget's rect, and hide clears it", () => {
    const { extension, controller } = createConfirmTapExtension();
    const query = fakeQuery({ 20: 10, 10: null }, { 10: { x: 100, y: 200, w: 300, h: 80 } });
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_SHOP_ITEM])]));
    extension.beforeDraw!(frame(query));

    controller.show(10, "shop");
    expect(controller.state.targetId).toBe(10);
    expect(controller.state.kind).toBe("shop");
    expect(controller.state.rect).toEqual({ x: 100, y: 200, w: 300, h: 80 });

    controller.hide();
    expect(controller.state.targetId).toBeNull();
    expect(controller.state.kind).toBeNull();
    expect(controller.state.rect).toBeNull();
    extension.dispose!();
  });

  it("follows the widget's rect while the button is up, writing state only when it moved", () => {
    const { extension, controller } = createConfirmTapExtension();
    const rects: Record<number, Rect> = { 10: { x: 100, y: 200, w: 300, h: 80 } };
    const query = fakeQuery({ 20: 10, 10: null }, rects);
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_REST_SITE])]));
    extension.beforeDraw!(frame(query));
    controller.show(10, "rest");
    const first = controller.state.rect;

    extension.beforeDraw!(frame(query)); // unchanged: the same object stays (no reactive write)
    expect(controller.state.rect).toBe(first);

    rects[10] = { x: 100, y: 180, w: 330, h: 88 }; // the focused option grew
    extension.beforeDraw!(frame(query));
    expect(controller.state.rect).toEqual({ x: 100, y: 180, w: 330, h: 88 });

    controller.hide();
    rects[10] = { x: 0, y: 0, w: 1, h: 1 };
    extension.beforeDraw!(frame(query)); // no button: nothing is tracked
    expect(controller.state.rect).toBeNull();
    extension.dispose!();
  });
});

describe("confirmTap — choice parity", () => {
  function setup(items: ItemMeta[], parents: Record<number, number> = {}, hidden = new Set<number>()) {
    const { extension, controller } = createConfirmTapExtension();
    const table = new Map(items.map((m) => [m.id, m]));
    const query: ItemQuery = {
      ...fakeQuery(parents, Object.fromEntries(items.map((m) => [m.id, { x: 0, y: 0, w: 100, h: 100 }]))),
      meta: (id) => table.get(id) ?? null,
      children: (id) => Uint32Array.from(Object.entries(parents).filter(([, p]) => p === id).map(([c]) => Number(c))),
      visible: (id) => {
        let cur: number | undefined = id;
        while (cur !== undefined) {
          if (hidden.has(cur)) return false;
          cur = parents[cur];
        }
        return true;
      }
    };
    extension.onItemMeta!(batch(items));
    const draw = () => extension.beforeDraw!(frame(query));
    draw();
    return { extension, controller, hidden, draw, table, query };
  }

  const option = (id: number) => ({ ...meta(id, [RS_GROUP_EVENT_OPTION]), class: "NEventOptionButton" });
  const shop = (type: string) => ({ ...meta(1, [RS_GROUP_SHOP_ITEM]), script: `res://ui/${type}.cs` });

  it("excludes Proceed even when its runtime type is an event option", () => {
    const proceed = { ...option(1), scene: "res://scenes/ui/proceed_button.tscn" };
    const { controller } = setup([proceed, option(2)], { 3: 1 });
    expect(controller.classify(3)).toBeNull();
  });

  it("confirms multiple event choices, but immediately releases a lone remaining option", () => {
    const { controller, hidden, draw } = setup([option(1), option(2)], { 3: 2 });
    expect(controller.classify(1)).toEqual({ id: 1, kind: "event" });
    controller.show(1, "event");
    hidden.add(2);
    draw();
    expect(controller.classify(1)).toBeNull();
    expect(controller.state.targetId).toBeNull();
  });

  it("requires a visible direct Cost child for removal and marks its re-tap", () => {
    const { controller, hidden, draw } = setup([shop("NMerchantCardRemoval"), meta(2, [], "Item/Cost")], { 2: 1, 3: 1 });
    expect(controller.classify(3)).toEqual({ id: 1, kind: "shop", retapActivates: true });
    controller.show(1, "shop");
    hidden.add(2);
    draw();
    expect(controller.classify(3)).toBeNull();
    expect(controller.state.targetId).toBeNull();
    expect(controller.commit()).toBe(false);
  });

  it("does not accept an absent or nested removal Cost", () => {
    const { controller } = setup([shop("NMerchantCardRemoval"), meta(2, [], "Item/Child/Cost")], { 2: 3, 3: 1 });
    expect(controller.classify(1)).toBeNull();
  });

  it("confirms an available Blitz offer", () => {
    const { controller } = setup([shop("NBlitzMerchantSlot"), { ...meta(2, [], "Slot/Hitbox"), mouseFilter: "stop" }, meta(3, [], "Slot/Icon")], { 2: 1, 3: 1 });
    expect(controller.classify(2)).toEqual({ id: 1, kind: "shop" });
  });

  it("excludes a Blitz offer whose Hitbox ignores input", () => {
    const { controller } = setup([shop("NBlitzMerchantSlot"), { ...meta(2, [], "Slot/Hitbox"), mouseFilter: "ignore" }], { 2: 1 });
    expect(controller.classify(2)).toBeNull();
  });

  it("excludes a used Blitz offer with a hidden Icon descendant", () => {
    const { controller } = setup([shop("NBlitzMerchantSlot"), meta(2, [], "Slot/Image/Icon")], { 2: 3, 3: 1 }, new Set([2]));
    expect(controller.classify(1)).toBeNull();
  });

  it.each(["NCardGridSelectionScreen", "NDeckCardSelectScreen"])("defers to the game's confirm while %s is effectively visible", (type) => {
    const { controller, hidden, draw } = setup([shop("NMerchantCard"), { ...meta(2, []), class: type }, meta(3, [])], { 2: 3 });
    expect(controller.classify(1)).toBeNull();
    hidden.add(3);
    draw();
    expect(controller.classify(1)).toEqual({ id: 1, kind: "shop" });
  });

  it.each(["NCardPreviewContainer", "NHoverTipCardContainer", "NInspectCardScreen"])("excludes copied cards under %s", (type) => {
    const { controller } = setup([meta(1, [RS_GROUP_CARD_REWARD_CARD]), { ...meta(2, []), script: `res://ui/${type}.cs` }], { 1: 2, 3: 1 });
    expect(controller.classify(3)).toBeNull();
  });

  it("locks the selected relic, allows another vote and forgets a removed relic", () => {
    const { controller, extension } = setup([meta(1, [RS_GROUP_TREASURE_RELIC], "MultiplayerRelicHolder1"), meta(2, [RS_GROUP_TREASURE_RELIC], "MultiplayerRelicHolder2")]);
    controller.show(1, "relic");
    expect(controller.commit()).toBe(true);
    expect(controller.classify(1)).toEqual({ id: 1, kind: "relic" }); // still hover-only
    controller.show(1, "relic");
    expect(controller.state.targetId).toBeNull();
    controller.show(2, "relic");
    expect(controller.commit()).toBe(true);
    controller.show(1, "relic");
    expect(controller.state.targetId).toBe(1);
    controller.commit();
    extension.onItemsRemoved!(Uint32Array.of(1));
    controller.show(1, "relic");
    expect(controller.state.targetId).toBe(1); // the query can reuse an id after removal
  });

  it("checks coverage at the drawn centre of a choice scaled by its parent", () => {
    const { controller, extension, query } = setup([1, 2, 3, 4].map(option), { 1: 10, 2: 10, 3: 10, 4: 10 });
    query.rect = (id) => ({ x: 100, y: 400 + (id - 1) * 100, w: 100, h: 100 });
    query.hitTest = (x, y) => x >= 100 && x < 220 && y >= 400 && y < 880
      ? 1 + Math.floor((y - 400) / 120)
      : null;
    // The parent scales all four rows by 1.2 about (100, 400).
    const effective = (id: number): Affine2D => query.parent(id) === 10
      ? [1.2, 0, 0, 1.2, -20, -80]
      : [1, 0, 0, 1, 0, 0];
    expect(query.hitTest(150, 750)).toBe(3); // raw centre lands on the previous row
    expect(query.hitTest(160, 820)).toBe(4); // drawn centre lands on the intended row
    controller.show(4, "event");
    extension.beforeDraw!(frame(query, effective));
    expect(controller.state.belowOverlay).toBe(false);
    expect(controller.commit()).toBe(true);
  });

  it("sinks the button while another input surface covers the choice and restores it afterward", () => {
    const { controller, query, draw } = setup([shop("NMerchantCard")]);
    controller.show(1, "shop");
    query.hitTest = () => 99;
    draw();
    expect(controller.state.belowOverlay).toBe(true);
    query.hitTest = () => 1;
    draw();
    expect(controller.state.belowOverlay).toBe(false);
    expect(controller.state.targetId).toBe(1);
    query.hitTest = () => 99;
    draw();
    expect(controller.commit()).toBe(false);
  });

  it("keeps a failed shop purchase confirmable", () => {
    const { controller } = setup([shop("NMerchantRelic")]);
    controller.show(1, "shop");
    expect(controller.commit()).toBe(true);
    controller.show(1, "shop");
    expect(controller.state.targetId).toBe(1);
  });

  it("never confirms the post-combat Proceed or an ordinary card browser", () => {
    const { controller } = setup([{ ...meta(1, []), scene: "res://scenes/ui/proceed_button.tscn" }, { ...meta(2, []), class: "NCard" }]);
    expect(controller.classify(1)).toBeNull();
    expect(controller.classify(2)).toBeNull();
  });
});
