import { describe, expect, it } from "vitest";

import type { ExtensionFrame, ItemMeta, ItemMetaBatch, ItemQuery, Rect } from "@godot-scene-web/render-stream-client";

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

function frame(query: ItemQuery): ExtensionFrame {
  return { seq: 1, now: 0, overrides: null as never, query, requestRedraw: () => {} };
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
    expect(extension.wants?.fields).toEqual(["path"]);
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
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_EVENT_OPTION])]));
    extension.beforeDraw!(frame(query));
    controller.show(10, "event");
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
