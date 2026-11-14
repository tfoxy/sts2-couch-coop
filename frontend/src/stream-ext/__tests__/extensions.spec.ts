import { describe, expect, it, vi } from "vitest";

import type { Affine2D, ExtensionFrame, ExtensionSession, ItemMeta, ItemQuery, OverrideTable, OverrideValues } from "@godot-scene-web/render-stream-client";

import { createMirrorSettings } from "@/mirror/mirrorSettings";
import { buildStreamExtensions } from "@/stream-ext/extensions";
import { RS_GROUP_HAND_CONTAINER, RS_GROUP_HAND_HOLDER, RS_GROUP_HAND_ROOT, RS_GROUP_SHOP_ITEM } from "@/stream-ext/groups";

const rows: ItemMeta[] = [
  { id: 1, groups: [RS_GROUP_HAND_ROOT], path: "Hand" },
  { id: 2, groups: [RS_GROUP_HAND_CONTAINER], path: "Container" },
  { id: 3, groups: [RS_GROUP_HAND_HOLDER], path: "Holder" },
  { id: 4, groups: [], path: "." },
  { id: 5, groups: [RS_GROUP_SHOP_ITEM], path: "Item" },
  { id: 6, groups: [], path: ".", scene: "res://scenes/combat/draw_pile.tscn" }
].map((row) => ({ node: true, meta: {}, ...row }));

function fixture() {
  const settings = createMirrorSettings(undefined, "", { storage: null });
  settings.raiseHandCards = settings.raiseHeldCard = settings.uiScaling = settings.confirmTap = false;
  const built = buildStreamExtensions({ settings, presentationWidth: 1920, interactive: true });
  const parents: Record<number, number> = { 2: 1, 3: 2, 4: 3 };
  const parent = (id: number) => parents[id] ?? null;
  const query: ItemQuery = {
    parent: vi.fn(parent),
    children: vi.fn((id) => Uint32Array.from(rows.filter((row) => parent(row.id) === id).map((row) => row.id))),
    transform: vi.fn((id) => [1, 0, 0, 1, 0, id === 3 ? 941 : 1000] as Affine2D),
    rect: vi.fn(() => ({ x: 80, y: 900, w: 80, h: 80 })),
    subtreeRect: vi.fn(() => ({ x: 80, y: 900, w: 80, h: 80 })),
    visible: vi.fn(() => true),
    meta: vi.fn((id) => rows.find((row) => row.id === id) ?? null),
    hitTest: vi.fn(() => null)
  };
  const values = new Map<number, OverrideValues>();
  const overrides: OverrideTable = {
    set: (id, value) => { values.set(id, value); },
    translate: (id, x, y) => { values.set(id, { transform: [1, 0, 0, 1, x, y] }); },
    scaleAbout: vi.fn(), setGlobal: vi.fn(), freeze: vi.fn(),
    clear: vi.fn((id) => { values.delete(id); }),
    clearAll: vi.fn(() => values.clear()),
    get: vi.fn(() => null),
    effective: () => [1, 0, 0, 1, 0, 0],
    get size() { return values.size; }
  };
  const requestRedraw = vi.fn();
  const session: ExtensionSession = {
    sessionId: "s", streamId: "s", itemMeta: null, requestRedraw,
    mouseFilter: vi.fn(), pickOrder: vi.fn()
  };
  for (const extension of built.extensions) {
    extension.onSession?.(session);
    extension.onItemMeta?.({ form: "full", items: rows });
  }
  const frame: ExtensionFrame = { seq: 1, now: 0, query, overrides, requestRedraw };
  const dispose = () => built.extensions.forEach((extension) => extension.dispose?.());
  return { settings, built, query, overrides, values, requestRedraw, frame, dispose };
}

describe("stream extension live settings", () => {
  it.each([
    ["raiseHandCards", "couchcoop.raisedHand", 3],
    ["uiScaling", "couchcoop.viewScale", 6],
    ["raiseHeldCard", "couchcoop.heldCard", 4],
    ["confirmTap", "couchcoop.confirmTap", null]
  ] as const)("clears %s on disable, skips scene queries while off, and enables without a transaction", (key, id, target) => {
    const f = fixture();
    try {
      const extension = f.built.extensions.find((e) => e.id === id)!;
      extension.beforeDraw!(f.frame);
      for (const fn of Object.values(f.query)) expect(fn).not.toHaveBeenCalled();
      f.settings[key] = true;
      expect(f.requestRedraw).toHaveBeenCalled();
      extension.beforeDraw!(f.frame);
      if (key === "raiseHeldCard") {
        f.built.heldCard!.setHeld(4, 1000, "peek");
        extension.beforeDraw!(f.frame);
      } else if (key === "confirmTap") {
        f.built.confirmTap!.show(5, "shop");
        expect(f.built.confirmTap!.state.targetId).toBe(5);
      }
      if (target !== null) expect(f.values.has(target)).toBe(true);
      if (key === "raiseHandCards") expect(f.values.get(3)?.transform).toEqual([1, 0, 0, 1, 0, -119]);
      // Other modules' entries survive. clearAll() would erase these too.
      f.values.set(999, { visible: false });
      f.settings[key] = false;
      if (key === "confirmTap") expect(f.built.confirmTap!.state.targetId).toBeNull();
      for (const fn of Object.values(f.query)) vi.mocked(fn).mockClear();
      extension.beforeDraw!(f.frame);
      extension.beforeDraw!({ ...f.frame, seq: 2 });
      expect([...f.values.keys()]).toEqual([999]);
      for (const fn of Object.values(f.query)) expect(fn).not.toHaveBeenCalled();
      expect(f.overrides.clearAll).not.toHaveBeenCalled();
      f.settings[key] = true;
      extension.beforeDraw!(f.frame); // same seq as before disable; must invalidate the cached plan
      if (key === "raiseHandCards" || key === "uiScaling") expect(f.values.has(target!)).toBe(true);
      if (key === "raiseHeldCard") expect(f.values.has(4)).toBe(false); // a retired hold never returns
      if (key === "confirmTap") expect(f.built.confirmTap!.state.targetId).toBeNull();
    } finally {
      f.dispose();
    }
    f.requestRedraw.mockClear();
    f.settings[key] = !f.settings[key];
    expect(f.requestRedraw).not.toHaveBeenCalled();
  });
});
