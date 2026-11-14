import { describe, expect, it, vi } from "vitest";

import type { Affine2D, ExtensionFrame, ItemMeta, ItemQuery, OverrideTable, OverrideValues, Rect } from "@godot-scene-web/render-stream-client";

import { computeHoverTipScale, HOVER_TIP_SCALE } from "@/mirror/hoverTipScaleMath";
import { scaleStampAffine } from "@/stream-ext/viewScale";
import { createMirrorSettings } from "@/mirror/mirrorSettings";
import { buildStreamExtensions } from "@/stream-ext/extensions";
import { RS_GROUP_HOVER_TIP } from "@/stream-ext/groups";
import { createHoverTipsModule, TIP_OWNER_META_KEY, TIP_OWNER_SIZE_META_KEY } from "@/stream-ext/hoverTips";

function item(id: number, instanceId: string, script: string, extra: Partial<ItemMeta> = {}): ItemMeta {
  return { id, node: true, instanceId, script, groups: [], meta: {}, ...extra };
}

function tip(id = 10, owner = "9007199254740993"): ItemMeta {
  return item(id, "10000000000000000", "NHoverTipSet.cs", {
    groups: [RS_GROUP_HOVER_TIP], meta: { [TIP_OWNER_META_KEY]: owner }
  });
}

describe("stream hover-tip owner identity", () => {
  it.each(["NCreature", "NHandCardHolder", "NCardRewardCardHolder"])("resolves a %s owner by exact instance identity", (type) => {
    const module = createHoverTipsModule();
    const owner = item(2, "9007199254740993", `${type}.cs`);
    const neighbour = item(3, "9007199254740992", `${type}.cs`);
    module.extension.onItemMeta!({ form: "full", items: [tip(), neighbour, owner] });
    expect(module.ownerOf(10)).toBe(owner);
    expect(module.extension.wants?.metaKeys).toEqual([TIP_OWNER_META_KEY, TIP_OWNER_SIZE_META_KEY]);
  });

  it("resolves an owner arriving after its tip and retires removed identities", () => {
    const module = createHoverTipsModule();
    module.extension.onItemMeta!({ form: "full", items: [tip()] });
    expect(module.ownerOf(10)).toBeNull();
    const owner = item(2, "9007199254740993", "NCreature.cs");
    module.extension.onItemMeta!({ form: "delta", items: [owner] });
    expect(module.ownerOf(10)).toBe(owner);
    module.extension.onItemsRemoved!(Uint32Array.of(2));
    expect(module.ownerOf(10)).toBeNull();
  });

  it("never guesses an owner when metadata is missing or a node is not a tagged tip", () => {
    const module = createHoverTipsModule();
    const owner = item(2, "9007199254740993", "NCreature.cs");
    module.extension.onItemMeta!({ form: "full", items: [owner, { ...tip(), meta: {} }] });
    expect(module.ownerOf(10)).toBeNull();
    module.extension.onItemMeta!({ form: "delta", items: [{ ...tip(), groups: [] }] });
    expect(module.ownerOf(10)).toBeNull();
  });

  it("drops stale mappings on replacement, full snapshots and disposal", () => {
    const module = createHoverTipsModule();
    const owner = item(2, "9007199254740993", "NCreature.cs");
    module.extension.onItemMeta!({ form: "full", items: [tip(), owner] });
    module.extension.onItemMeta!({ form: "delta", items: [{ ...owner, instanceId: "4" }] });
    expect(module.ownerOf(10)).toBeNull();
    module.extension.onItemMeta!({ form: "full", items: [tip(), owner] });
    module.extension.dispose!();
    expect(module.ownerOf(10)).toBeNull();
    module.extension.onItemMeta!({ form: "full", items: [tip(), owner] });
    module.extension.onItemMeta!({ form: "full", items: [tip()] });
    expect(module.ownerOf(10)).toBeNull();
  });
});

function layout(boxes: Rect[], owner: Rect | null = null, script = "NHandCardHolder.cs", width = 1920) {
  const module = createHoverTipsModule({ designWidth: width });
  const rows = [tip(), item(2, "9007199254740993", script)];
  module.extension.onItemMeta!({ form: "full", items: rows });
  const rects = new Map<number, Rect>(boxes.map((box, i) => [20 + i, box]));
  if (owner) rects.set(2, owner);
  const children = new Map<number, number[]>([[10, boxes.map((_, i) => 20 + i)]]);
  const hidden = new Set<number>();
  const query: ItemQuery = {
    parent: vi.fn(() => null),
    children: vi.fn((id) => Uint32Array.from(children.get(id) ?? [])),
    transform: vi.fn(() => [1, 0, 0, 1, 0, 0] as Affine2D),
    rect: vi.fn((id) => rects.get(id) ?? null),
    subtreeRect: vi.fn((id) => rects.get(id) ?? null),
    visible: vi.fn((id) => !hidden.has(id)),
    meta: vi.fn((id) => rows.find((row) => row.id === id) ?? null),
    hitTest: vi.fn(() => null)
  };
  const values = new Map<number, OverrideValues>();
  const effective = new Map<number, Affine2D>();
  const overrides: OverrideTable = {
    set: vi.fn((id, value) => { values.set(id, value); }),
    translate: vi.fn(), scaleAbout: vi.fn(), setGlobal: vi.fn(), freeze: vi.fn(),
    clear: vi.fn((id) => { values.delete(id); }), clearAll: vi.fn(),
    get: vi.fn(() => null), effective: vi.fn((id): Affine2D => effective.get(id) ?? [1, 0, 0, 1, 0, 0]),
    get size() { return values.size; }
  };
  const frame: ExtensionFrame = { seq: 1, now: 0, query, overrides, requestRedraw: vi.fn() };
  const draw = (seq: number | null = 1) => module.extension.beforeDraw!({ ...frame, seq });
  const matrix = () => values.get(10)?.transform;
  return { module, rows, rects, children, hidden, query, values, effective, overrides, frame, draw, matrix };
}

function expectMatrix(actual: Affine2D | undefined, expected: readonly number[]) {
  expect(actual).toHaveLength(6);
  expected.forEach((value, i) => expect(actual![i]).toBeCloseTo(value));
}

describe("stream hover-tip layout", () => {
  it.each([
    ["NHandCardHolder.cs", 800, 900, 52],
    ["NCardRewardCardHolder.cs", 800, 900, 52],
    ["res://nodes/creature/NCreature.cs", 1000, 1050, -522]
  ] as const)("matches the mirror side-clamp vector for %s", (script, tipX, ownerX, tx) => {
    const f = layout([{ x: tipX, y: 400, w: 300, h: 120 }], { x: ownerX, y: 430, w: 100, h: 60 }, script);
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, tx, -104]);
  });

  it("places a tip right of an undrawn positive-size creature hitbox using its layout box", () => {
    const boxes = [{ x: 1000, y: 500, w: 300, h: 120 }];
    const hitbox = { x: 1300, y: 450, w: 190, h: 250 };
    const f = layout(boxes, null, "", 2340);
    const owner = { ...f.rows[1], script: null, scene: "res://scenes/creature/creature.tscn" };
    const tipWithSize = { ...f.rows[0], meta: { ...f.rows[0].meta, [TIP_OWNER_SIZE_META_KEY]: "[190,250]" } };
    f.module.extension.onItemMeta!({ form: "full", items: [tipWithSize, owner] });
    vi.mocked(f.query.transform).mockImplementation((id) => id === 2 ? [1, 0, 0, 1, hitbox.x, hitbox.y] : null);
    expect(f.query.rect(2)).toBeNull();
    f.draw();
    const expected = computeHoverTipScale(boxes, 2340, hitbox, "none")!;
    expectMatrix(f.matrix(), scaleStampAffine(HOVER_TIP_SCALE, expected.pivotX, expected.pivotY, expected.offsetX, expected.offsetY));
    expect(f.matrix()![0] * boxes[0].x + f.matrix()![4]).toBeCloseTo(hitbox.x + hitbox.w + 12);
  });

  it("uses transformed layout before owner ink or descendants and follows effective overrides", () => {
    const boxes = [{ x: 950, y: 500, w: 300, h: 120 }];
    const f = layout(boxes, { x: 0, y: 0, w: 1920, h: 1080 }, "", 2340);
    f.module.extension.onItemMeta!({ form: "delta", items: [{
      ...f.rows[0], meta: { ...f.rows[0].meta, [TIP_OWNER_SIZE_META_KEY]: "[190,250]" }
    }] });
    f.children.set(2, [3]);
    f.rects.set(3, { x: 1700, y: 0, w: 400, h: 500 });
    // Rotate the local layout: raw box (1250,450,250,190), then apply inherited enlargement.
    vi.mocked(f.query.transform).mockImplementation((id) => id === 2 ? [0, 1, -1, 0, 1500, 450] : null);
    f.effective.set(2, [1.2, 0, 0, 1.2, -225, -90]);
    const mapped = { x: 1275, y: 450, w: 300, h: 228 };
    f.draw();
    const expected = computeHoverTipScale(boxes, 2340, mapped, "none", 50, 19)!;
    expectMatrix(f.matrix(), scaleStampAffine(HOVER_TIP_SCALE, expected.pivotX, expected.pivotY, expected.offsetX, expected.offsetY));
    expect(f.matrix()![0] * boxes[0].x + f.matrix()![4]).toBeCloseTo(mapped.x + mapped.w + 12);
    expect(f.query.children).not.toHaveBeenCalledWith(2);
  });

  it("puts a creature tip to the right when the preferred left side cannot fit", () => {
    const f = layout([{ x: 150, y: 400, w: 300, h: 120 }], { x: 100, y: 430, w: 100, h: 60 }, "NCreature.cs");
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, 32, -104]);
    expect(f.matrix()![0] * 150 + f.matrix()![4]).toBeCloseTo(212); // owner right + 12
  });

  it("matches the mirror's two-column hand-card pivot and stage clamp", () => {
    const f = layout([{ x: 980, y: 300, w: 360, h: 200 }, { x: 1540, y: 260, w: 360, h: 480 }]);
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, -360, -52]);
  });

  it("clamps the enlarged panel inside the design width and 1080 height", () => {
    const f = layout([{ x: 1800, y: 1000, w: 300, h: 200 }]);
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, -600, -360]);
  });

  it("uses the stream presentation width for right-edge placement", () => {
    const f = layout([{ x: 1800, y: 400, w: 300, h: 120 }], null, "", 2340);
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, -360, -80]);
  });

  it("follows the effective enlarged owner, including a parent override, on redraws", () => {
    const f = layout([{ x: 700, y: 400, w: 300, h: 120 }], { x: 500, y: 600, w: 100, h: 100 });
    f.effective.set(2, [1.5, 0, 0, 1.5, -235, -335]); // centre moves +40, -10
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, -100, -114]);
    f.effective.set(2, [1, 0, 0, 1, 60, -20]);
    f.draw(null);
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, -80, -124]);
    f.effective.set(2, [1, 0, 0, 1, 70, -30]);
    f.draw(null); // consecutive redraws may move an owner without any transaction
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, -70, -134]);
  });

  it("keeps the gap from the enlarged owner's edge even when its centre has not moved", () => {
    const f = layout([{ x: 800, y: 400, w: 300, h: 120 }], { x: 900, y: 430, w: 100, h: 60 });
    f.effective.set(2, [1.5, 0, 0, 1.5, -475, -230]);
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, 77, -104]);
    expect(f.matrix()![0] * 800 + f.matrix()![4]).toBeCloseTo(1037); // enlarged right + 12
  });

  it("uses a zero-size holder's first visible painting descendant, keeping the holder kind", () => {
    const f = layout([{ x: 800, y: 400, w: 300, h: 120 }]);
    f.module.extension.onItemMeta!({ form: "delta", items: [{
      ...f.rows[0], meta: { ...f.rows[0].meta, [TIP_OWNER_SIZE_META_KEY]: "[0,0]" }
    }] });
    f.rects.set(2, { x: 0, y: 0, w: 1900, h: 1000 }); // a zero-size holder still cannot win with ink
    f.children.set(2, [3, 4]); // the spacer has no ink
    f.rects.set(4, { x: 900, y: 430, w: 100, h: 60 });
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, 52, -104]);
    expect(f.query.hitTest).not.toHaveBeenCalled();
  });

  it("measures content groups but skips hidden children and empty spacers", () => {
    const f = layout([{ x: 1040, y: 660, w: 360, h: 122 }]);
    f.children.set(10, [20, 21, 22]);
    f.rects.delete(20);
    vi.mocked(f.query.subtreeRect).mockImplementation((id) => id === 20 ? { x: 1040, y: 660, w: 360, h: 122 } : null);
    f.rects.set(21, { x: 0, y: 0, w: 1900, h: 1000 });
    f.hidden.add(21);
    f.draw();
    expectMatrix(f.matrix(), [1.2, 0, 0, 1.2, -208, -132]);
  });

  it.each(["removed", "untagged", "hidden", "empty", "snapshot"])("clears a retained stamp when the tip is %s", (mode) => {
    const f = layout([{ x: 1040, y: 660, w: 360, h: 122 }]);
    f.draw();
    expect(f.matrix()).toBeDefined();
    if (mode === "removed") f.module.extension.onItemsRemoved!(Uint32Array.of(10));
    if (mode === "untagged") f.module.extension.onItemMeta!({ form: "delta", items: [{ ...tip(), groups: [] }] });
    if (mode === "hidden") f.hidden.add(10);
    if (mode === "empty") f.children.set(10, []);
    if (mode === "snapshot") f.module.extension.onItemMeta!({ form: "full", items: [] });
    f.draw(2);
    expect(f.matrix()).toBeUndefined();
    expect(f.overrides.clear).toHaveBeenCalledWith(10);
  });

  it("does no layout work on an unchanged transaction", () => {
    const f = layout([{ x: 1040, y: 660, w: 360, h: 122 }]);
    f.draw();
    for (const fn of Object.values(f.query)) vi.mocked(fn).mockClear();
    vi.mocked(f.overrides.set).mockClear();
    f.draw();
    for (const fn of Object.values(f.query)) expect(fn).not.toHaveBeenCalled();
    expect(f.overrides.set).not.toHaveBeenCalled();
  });

  it("writes and queries nothing while disabled; toggling live clears only its own overrides", () => {
    const f = layout([{ x: 1040, y: 660, w: 360, h: 122 }]);
    const settings = createMirrorSettings(undefined, "", { storage: null });
    settings.uiScaling = false;
    const built = buildStreamExtensions({ settings, presentationWidth: 2340, interactive: true });
    try {
      const ext = built.extensions.find((e) => e.id === "couchcoop.hoverTips")!;
      ext.onItemMeta!({ form: "full", items: f.rows });
      ext.beforeDraw!(f.frame);
      for (const fn of Object.values(f.query)) expect(fn).not.toHaveBeenCalled();
      expect(f.overrides.set).not.toHaveBeenCalled();
      expect(f.overrides.clear).not.toHaveBeenCalled();
      settings.uiScaling = true;
      ext.beforeDraw!(f.frame);
      expect(f.matrix()).toBeDefined();
      f.values.set(999, { visible: false });
      settings.uiScaling = false;
      ext.beforeDraw!(f.frame);
      expect([...f.values.keys()]).toEqual([999]);
      for (const fn of Object.values(f.query)) vi.mocked(fn).mockClear();
      vi.mocked(f.overrides.clear).mockClear();
      ext.beforeDraw!({ ...f.frame, seq: 2 });
      for (const fn of Object.values(f.query)) expect(fn).not.toHaveBeenCalled();
      expect(f.overrides.clear).not.toHaveBeenCalled();
      settings.uiScaling = true;
      ext.beforeDraw!(f.frame);
      expect(f.matrix()).toBeDefined();
    } finally {
      for (const ext of built.extensions) ext.dispose?.();
    }
  });
});
