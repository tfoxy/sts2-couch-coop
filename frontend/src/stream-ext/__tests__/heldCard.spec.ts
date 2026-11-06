import { describe, expect, it } from "vitest";

import type { Affine2D, ExtensionFrame, ItemMeta, ItemMetaBatch, ItemQuery, OverrideTable, OverrideValues } from "@godot-scene-web/render-stream-client";

import { HELD_CARD_DRAG_LIFT_PX, HELD_CARD_PEEK_LIFT_PX } from "@/mirror/raise/constants";
import { createHeldCardExtension } from "@/stream-ext/heldCard";
import { HELD_CARD_GROUPS, RS_GROUP_HAND_HOLDER, RS_GROUP_TARGETING_ARROW } from "@/stream-ext/groups";

// The stream's HELD-CARD LIFT module: the identity climb (a card's child → the hand holder's card) and the per-hold
// translate override. The gesture itself is the input channel's; here the controller drives it and the extension's
// beforeDraw applies the pure `raise/heldLift.ts` decision.

function meta(id: number, groups: string[]): ItemMeta {
  return { id, node: true, class: null, script: null, scene: null, path: null, groups, meta: {} };
}

function batch(items: ItemMeta[]): ItemMetaBatch {
  return { form: "full", items };
}

class FakeOverrides implements OverrideTable {
  writes = 0;
  readonly written = new Map<number, number[]>();
  cleared: number[] = [];
  translate(id: number, dx: number, dy: number): void {
    this.writes++;
    this.written.set(id, [dx, dy]);
  }
  set(id: number, o: OverrideValues): void { this.writes++; void id; void o; }
  scaleAbout(): void { this.writes++; }
  setGlobal(): void { this.writes++; }
  freeze(): void { this.writes++; }
  get(): null { return null; }
  effective(): Affine2D { return [1, 0, 0, 1, 0, 0]; }
  clear(id: number): void { this.writes++; this.cleared.push(id); this.written.delete(id); }
  clearAll(): void { this.writes++; }
  size = 0;
}

/** parent map: id → parent (or null). Visibility defaults true; `visible` overrides it. */
function fakeQuery(parents: Record<number, number | null>, visible: Record<number, boolean> = {}): ItemQuery {
  return {
    parent: (id) => parents[id] ?? null,
    children: () => new Uint32Array(0),
    transform: () => [1, 0, 0, 1, 0, 0],
    rect: () => null,
    subtreeRect: () => null,
    visible: (id) => visible[id] ?? true,
    meta: () => null,
    hitTest: () => null
  };
}

function frame(seq: number, overrides: OverrideTable, query: ItemQuery): ExtensionFrame {
  return { seq, now: 0, overrides, query, requestRedraw: () => {} };
}

describe("heldCard — identity + override", () => {
  it("asks for the held-card groups and nothing else", () => {
    const { extension } = createHeldCardExtension();
    expect([...(extension.wants?.groups ?? [])].sort()).toEqual([...HELD_CARD_GROUPS].slice().sort());
    expect(extension.wants?.fields).toBeUndefined();
    expect(extension.wants?.metaKeys).toBeUndefined();
  });

  it("climbs from a card's child to the hand holder's card", () => {
    const { extension, controller } = createHeldCardExtension();
    const query = fakeQuery({
      12: 11, // a card's leaf child
      11: 10, // the card (holder's direct child)
      10: 9,  // the hand holder
      9: null // the hand container
    });
    const overrides = new FakeOverrides();
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_HAND_HOLDER])]));
    extension.beforeDraw!(frame(1, overrides, query)); // captures the query

    expect(controller.handCardFor(12)).toBe(11);
    expect(controller.handCardFor(11)).toBe(11);
    expect(controller.handCardFor(99)).toBeNull(); // not under any hand holder
    extension.dispose!();
  });

  it("writes the peek lift on the card above the fingertip", () => {
    const { extension, controller } = createHeldCardExtension();
    const query = fakeQuery({ 12: 11, 11: 10, 10: 9, 9: null });
    const overrides = new FakeOverrides();
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_HAND_HOLDER])]));
    extension.beforeDraw!(frame(1, overrides, query));

    controller.setHeld(12, 1000, "peek");
    extension.beforeDraw!(frame(2, overrides, query));
    expect(overrides.written.get(11)).toEqual([0, -HELD_CARD_PEEK_LIFT_PX]);
    extension.dispose!();
  });

  it("writes the bigger drag lift on a touch drag, then drops it while a targeting arrow is visible", () => {
    const { extension, controller } = createHeldCardExtension();
    // The arrow (30) is not visible at first (the game is not aiming), so the drag lift applies.
    let query = fakeQuery({ 12: 11, 11: 10, 10: 9, 9: null, 30: null }, { 30: false });
    const overrides = new FakeOverrides();
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_HAND_HOLDER]), meta(30, [RS_GROUP_TARGETING_ARROW])]));
    extension.beforeDraw!(frame(1, overrides, query));

    controller.setHeld(12, 1000, "drag"); // picked up at the bottom: lifted straight off the pickup
    extension.beforeDraw!(frame(2, overrides, query));
    expect(overrides.written.get(11)).toEqual([0, -HELD_CARD_DRAG_LIFT_PX]);

    // The game starts aiming: the arrow's visible flips on, and the drag lift drops so the arrow tip reads at the finger.
    query = fakeQuery({ 12: 11, 11: 10, 10: 9, 9: null, 30: null }, { 30: true });
    extension.beforeDraw!(frame(3, overrides, query));
    expect(overrides.written.has(11)).toBe(false);
    extension.dispose!();
  });

  it("clears the lift when the hold ends (setHeld null)", () => {
    const { extension, controller } = createHeldCardExtension();
    const query = fakeQuery({ 12: 11, 11: 10, 10: 9, 9: null });
    const overrides = new FakeOverrides();
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_HAND_HOLDER])]));
    extension.beforeDraw!(frame(1, overrides, query));

    controller.setHeld(12, 1000, "peek");
    extension.beforeDraw!(frame(2, overrides, query));
    expect(overrides.written.has(11)).toBe(true);

    controller.setHeld(null, 0, "drag");
    extension.beforeDraw!(frame(3, overrides, query));
    expect(overrides.written.has(11)).toBe(false);
    extension.dispose!();
  });

  it("does not lift a drawn item that is not under a hand card", () => {
    const { extension, controller } = createHeldCardExtension();
    const query = fakeQuery({ 12: 11, 11: 99, 99: null }); // 99 is not a hand holder
    const overrides = new FakeOverrides();
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_HAND_HOLDER])]));
    extension.beforeDraw!(frame(1, overrides, query));

    controller.setHeld(12, 1000, "peek");
    extension.beforeDraw!(frame(2, overrides, query));
    expect(overrides.written.size).toBe(0);
    extension.dispose!();
  });

  it("asks the session for a redraw on every hold change, so the lift shows without waiting for a transaction", () => {
    const { extension, controller } = createHeldCardExtension();
    const query = fakeQuery({ 12: 11, 11: 10, 10: 9, 9: null });
    const overrides = new FakeOverrides();
    let redraws = 0;
    extension.onSession!({ sessionId: "s", streamId: "t", itemMeta: null, requestRedraw: () => { redraws++; }, mouseFilter: () => {}, pickOrder: () => {} });
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_HAND_HOLDER])]));
    extension.beforeDraw!(frame(1, overrides, query));

    controller.setHeld(12, 1000, "peek");
    expect(redraws).toBe(1);
    // The redraw is a seq-null frame: it applies the lift though no transaction arrived.
    extension.beforeDraw!({ seq: null, now: 0, overrides, query, requestRedraw: () => {} });
    expect(overrides.written.get(11)).toEqual([0, -HELD_CARD_PEEK_LIFT_PX]);

    controller.setHeld(12, 900, "drag"); // the finger moved
    expect(redraws).toBe(2);
    controller.setHeld(null, 0, "drag");
    expect(redraws).toBe(3);
    controller.setHeld(null, 0, "drag"); // already clear: nothing to redraw
    expect(redraws).toBe(3);
    extension.dispose!();
  });
});
