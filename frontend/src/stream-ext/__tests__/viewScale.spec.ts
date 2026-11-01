import { describe, expect, it } from "vitest";

import type { ExtensionFrame, ItemMeta, ItemMetaBatch, ItemQuery, OverrideTable, Rect } from "@godot-scene-web/render-stream-client";

import { buildStreamExtensions } from "@/stream-ext/extensions";
import { RS_GROUP_CARD_REWARD_ROOT, RS_GROUP_TREASURE_RELIC } from "@/stream-ext/groups";
import { createViewScaleExtension, resolveStreamViewScale, scaleStampAffine } from "@/stream-ext/viewScale";
import { VIEW_SCALE_PILE } from "@/mirror/viewScale";
import { createMirrorSettings } from "@/mirror/mirrorSettings";

function meta(id: number, groups: string[], scene: string | null = null, path: string | null = null): ItemMeta {
  return { id, node: true, class: null, script: null, scene, path, groups, meta: {} };
}

function batch(items: ItemMeta[]): ItemMetaBatch {
  return { form: "full", items };
}

describe("viewScale — resolution", () => {
  it("resolves the old uiScaling table over scene+path", () => {
    const m = meta(1, [], "res://scenes/screens/rewards_screen.tscn", "Rewards");
    expect(resolveStreamViewScale(m)).toMatchObject({ scale: 1.2, isGroup: true, pivot: "center" });
  });

  it("resolves the leaf-detected groups the mod tags", () => {
    expect(resolveStreamViewScale(meta(1, [RS_GROUP_CARD_REWARD_ROOT]))).toMatchObject({ scale: 1.1, isGroup: true });
    expect(resolveStreamViewScale(meta(1, [RS_GROUP_TREASURE_RELIC]))).toMatchObject({ scale: 1.25, pivot: "bottomCenter" });
  });

  it("resolves neutral for an untagged item with no table entry", () => {
    expect(resolveStreamViewScale(meta(1, [], "res://scenes/elsewhere.tscn", "Nothing"))).toBeNull();
  });

  it("matches a scene-root entry: the capture's root path '.' is the mirror's ''", () => {
    // The capture spells an instance root's path "." (get_path_to on itself); the mirror's relPath
    // spells the same node "" (its scene walk collects no name for the root). The table's scene-ROOT
    // entries (combat piles, map points, deck view) are written against the "" spelling.
    const pile = resolveStreamViewScale(meta(1, [], "res://scenes/combat/draw_pile.tscn", "."));
    expect(pile).toMatchObject({ scale: VIEW_SCALE_PILE, pivot: "bottomLeft", isGroup: false });
  });

  it("builds the scale-about-anchor affine (scale then translate)", () => {
    // Scale 1.25 about (160, 1006) with no offset: origin = pivot·(1-s).
    expect(scaleStampAffine(1.25, 160, 1006, 0, 0)).toEqual([1.25, 0, 0, 1.25, 160 * (1 - 1.25), 1006 * (1 - 1.25)]);
  });
});

class FakeOverrides implements OverrideTable {
  writes = 0;
  readonly written = new Map<number, number[]>();
  set(id: number, o: { transform?: readonly number[] }): void {
    this.writes++;
    if (o.transform) this.written.set(id, [...o.transform]);
  }
  translate(): void { this.writes++; }
  scaleAbout(): void { this.writes++; }
  setGlobal(): void { this.writes++; }
  freeze(): void { this.writes++; }
  clear(id: number): void { this.writes++; this.written.delete(id); }
  clearAll(): void { this.writes++; }
  get(): null { return null; }
  effective(): [number, number, number, number, number, number] { return [1, 0, 0, 1, 0, 0]; }
  size = 0;
}

function fakeQuery(rects: Record<number, Rect | null>): ItemQuery {
  return {
    parent: () => null,
    children: () => new Uint32Array(0),
    transform: () => [1, 0, 0, 1, 0, 0],
    rect: (id) => rects[id] ?? null,
    subtreeRect: (id) => rects[id] ?? null,
    visible: () => true,
    meta: () => null,
    hitTest: () => null
  };
}

describe("viewScale — extension glue", () => {
  it("writes a rigid scale and then stays clean until the transaction moves", () => {
    const overrides = new FakeOverrides();
    const query = fakeQuery({ 1: { x: 696, y: 236, w: 526, h: 640 } });
    const ext = createViewScaleExtension({ designWidth: 1920 });
    ext.onItemMeta!(batch([meta(1, [], "res://scenes/screens/rewards_screen.tscn", "Rewards")]));
    const frame: ExtensionFrame = { seq: 5, now: 0, overrides, query, requestRedraw: () => {} };
    ext.beforeDraw!(frame);
    expect(overrides.written.has(1)).toBe(true);
    const afterFirst = overrides.writes;

    ext.beforeDraw!(frame);
    expect(overrides.writes).toBe(afterFirst); // dirty only

    ext.beforeDraw!({ ...frame, seq: 6 });
    expect(overrides.writes).toBeGreaterThan(afterFirst); // a new transaction re-measures
    ext.dispose!();
  });

  it("clears a parked box the clamp must not drag back on screen", () => {
    const overrides = new FakeOverrides();
    // A parked SlotsContainer (the shop sliding out) sits entirely off-screen.
    const query = fakeQuery({ 1: { x: 0, y: -1000, w: 1747, h: 978 } });
    const ext = createViewScaleExtension({ designWidth: 1920 });
    ext.onItemMeta!(batch([meta(1, [], "res://scenes/merchant/merchant_inventory.tscn", "SlotsContainer")]));
    ext.beforeDraw!({ seq: 1, now: 0, overrides, query, requestRedraw: () => {} });
    expect(overrides.written.has(1)).toBe(false);
    ext.dispose!();
  });

  it("measures a widget whose sprite is drawn in a child (own rect null, subtree rect set)", () => {
    const overrides = new FakeOverrides();
    // A combat pile button: its own commands are empty (the sprite is a child), so `rect` is null;
    // the subtree rect is the button's 80x80 visual. The stream must still scale it (the old
    // mirror's DOM element bounding box included that child).
    const query: ItemQuery = {
      parent: () => null,
      children: () => new Uint32Array(0),
      transform: () => [1, 0, 0, 1, 15, 985],
      rect: () => null,
      subtreeRect: (id) => (id === 1 ? { x: 17, y: 985, w: 94, h: 83 } : null),
      visible: () => true,
      meta: () => null,
      hitTest: () => null
    };
    const ext = createViewScaleExtension({ designWidth: 1920 });
    ext.onItemMeta!(batch([meta(1, [], "res://scenes/combat/draw_pile.tscn", ".")]));
    ext.beforeDraw!({ seq: 1, now: 0, overrides, query, requestRedraw: () => {} });
    expect(overrides.written.has(1)).toBe(true);
    expect(overrides.written.get(1)![0]).toBeCloseTo(1.25);
    ext.dispose!();
  });
});

describe("extensions — off is an empty list", () => {
  it("runs no module for a viewer with every saved setting off", () => {
    const settings = createMirrorSettings(undefined, "", { storage: null });
    settings.raiseHandCards = false;
    settings.uiScaling = false;
    settings.raiseHeldCard = false;
    settings.confirmTap = false;
    const built = buildStreamExtensions({ settings, presentationWidth: 1920 });
    expect(built.extensions).toEqual([]);
    expect(built.heldCard).toBeNull();
    expect(built.confirmTap).toBeNull();
  });

  it("runs one module per saved setting, in product order", () => {
    const settings = createMirrorSettings(undefined, "", { storage: null });
    settings.raiseHandCards = true;
    settings.uiScaling = false;
    settings.raiseHeldCard = false;
    settings.confirmTap = false;
    const list = buildStreamExtensions({ settings, presentationWidth: 2520 }).extensions;
    expect(list.map((e) => e.id)).toEqual(["couchcoop.raisedHand"]);
  });
});
