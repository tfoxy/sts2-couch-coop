import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionFrame, ItemMeta, ItemQuery, OverrideTable, OverrideValues } from "@godot-scene-web/render-stream-client";

import * as clipAxis from "@/mirror/clipAxis";
import { createMirrorSettings } from "@/mirror/mirrorSettings";
import { createClipAxisExtension } from "@/stream-ext/clipAxis";
import { buildStreamExtensions } from "@/stream-ext/extensions";

const scene = "res://scenes/events/ancient_event_layout.tscn";
const meta = (id = 1, path = "ContentContainer", file = scene): ItemMeta =>
  ({ id, node: true, groups: [], meta: {}, scene: file, path });
const disposals: (() => void)[] = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

function fixture() {
  const extension = createClipAxisExtension();
  disposals.push(() => extension.dispose!());
  const values = new Map<number, OverrideValues>();
  const overrides: OverrideTable = {
    set: vi.fn((id, value) => { values.set(id, value); }),
    clear: vi.fn((id) => { values.delete(id); }),
    clearAll: vi.fn(), translate: vi.fn(), scaleAbout: vi.fn(), setGlobal: vi.fn(), freeze: vi.fn(),
    get: () => null, effective: () => [1, 0, 0, 1, 0, 0],
    get size() { return values.size; }
  };
  const query: ItemQuery = {
    parent: vi.fn(() => null), children: vi.fn(() => new Uint32Array()),
    transform: vi.fn(() => null), rect: vi.fn(() => null), controlRect: vi.fn(() => null),
    subtreeRect: vi.fn(() => null), visible: vi.fn(() => true), meta: vi.fn(() => null), hitTest: vi.fn(() => null)
  };
  const frame: ExtensionFrame = { seq: 1, now: 0, query, overrides, requestRedraw: vi.fn() };
  return { extension, frame, values, overrides, query };
}

describe("stream one-axis clip", () => {
  it("opens only the ancient content's horizontal clip using the shared table", () => {
    const f = fixture();
    expect(f.extension.id).toBe("couchcoop.clipAxis");
    expect(f.extension.wants).toEqual({ fields: ["scene", "path"] });
    f.extension.onItemMeta!({ form: "full", items: [meta()] });
    f.extension.beforeDraw!(f.frame);
    expect(f.values.get(1)).toEqual({ clipOutset: [380, 0, 380, 0] });
    for (const fn of Object.values(f.query)) expect(fn).not.toHaveBeenCalled();
  });

  it("normalises the stream's instance-root path before resolving the shared table", () => {
    const resolve = vi.spyOn(clipAxis, "resolveClipAxisOutset");
    const f = fixture();
    f.extension.onItemMeta!({ form: "full", items: [meta(1, ".")] });
    expect(resolve).toHaveBeenCalledWith(scene, "");
    f.extension.beforeDraw!(f.frame);
    expect(f.values.size).toBe(0);
  });

  it("leaves unrelated scenes, paths and missing identities neutral", () => {
    const f = fixture();
    f.extension.onItemMeta!({ form: "full", items: [
      meta(1, "Other"), meta(2, "ContentContainer", "res://scenes/events/default_event_layout.tscn"),
      meta(3, "ContentContainer", "res://scenes/events/combat_event_layout.tscn"),
      { ...meta(4), scene: null }, { ...meta(5), path: null }
    ] });
    f.extension.beforeDraw!(f.frame);
    expect(f.overrides.set).not.toHaveBeenCalled();
    expect(f.overrides.clear).not.toHaveBeenCalled();
  });

  it.each(["changed identity", "removal", "full meta"])("clears the outset after %s", (change) => {
    const f = fixture();
    f.extension.onItemMeta!({ form: "full", items: [meta()] });
    f.extension.beforeDraw!(f.frame);
    f.values.set(999, { visible: false });
    if (change === "removal") f.extension.onItemsRemoved!(Uint32Array.of(1));
    else if (change === "full meta") f.extension.onItemMeta!({ form: "full", items: [meta(2, "Other")] });
    else f.extension.onItemMeta!({ form: "delta", items: [meta(1, "Other")] });
    f.extension.beforeDraw!(f.frame);
    expect(f.overrides.clear).toHaveBeenCalledExactlyOnceWith(1);
    expect([...f.values.keys()]).toEqual([999]);
    f.extension.beforeDraw!(f.frame);
    expect(f.overrides.clear).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite retained values on redraws or unrelated transactions", () => {
    const f = fixture();
    f.extension.onItemMeta!({ form: "full", items: [meta()] });
    f.extension.beforeDraw!(f.frame);
    f.extension.beforeDraw!(f.frame);
    f.extension.beforeDraw!({ ...f.frame, seq: null });
    f.extension.beforeDraw!({ ...f.frame, seq: 2 });
    expect(f.overrides.set).toHaveBeenCalledTimes(1);
  });

  it("clears while uiScaling is off and reapplies when enabled without a transaction", () => {
    const f = fixture();
    const settings = createMirrorSettings(undefined, "", { storage: null });
    settings.uiScaling = true;
    const built = buildStreamExtensions({ settings, presentationWidth: 1920, interactive: true });
    disposals.push(() => built.extensions.forEach((extension) => extension.dispose?.()));
    const extension = built.extensions.find((e) => e.id === "couchcoop.clipAxis")!;
    extension.onItemMeta!({ form: "full", items: [meta()] });
    extension.beforeDraw!(f.frame);
    expect(f.values.get(1)?.clipOutset).toEqual([380, 0, 380, 0]);
    f.values.set(999, { visible: false });
    settings.uiScaling = false;
    extension.beforeDraw!(f.frame);
    expect([...f.values.keys()]).toEqual([999]);
    settings.uiScaling = true;
    extension.beforeDraw!(f.frame);
    expect(f.values.get(1)?.clipOutset).toEqual([380, 0, 380, 0]);
  });
});
