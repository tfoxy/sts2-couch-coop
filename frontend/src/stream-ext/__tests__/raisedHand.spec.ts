import { describe, expect, it, vi } from "vitest";

import type { Affine2D, ExtensionFrame, ItemMeta, ItemMetaBatch, ItemQuery, OverrideTable, Rect } from "@godot-scene-web/render-stream-client";

import { creatureHudMeasure } from "@/mirror/raise/creatureHud";
import { parseSceneDelta } from "@/mirror/sceneTree";
import { createMirrorSettings } from "@/mirror/mirrorSettings";
import { buildStreamExtensions } from "@/stream-ext/extensions";

import {
  computeRaisePlan,
  creatureShiftFor,
  creatureShifts,
  createRaisedHandExtension,
  createHandPresenceExtension,
  raiseLiftPx,
  type CreatureGroupFacts,
  type RaiseFrameInput
} from "@/stream-ext/raisedHand";
import {
  RAISE_GROUPS,
  RS_GROUP_CREATURE_HUD,
  RS_GROUP_CREATURE_POWER,
  RS_GROUP_CREATURE_RETICLE,
  RS_GROUP_HAND_CONTAINER,
  RS_GROUP_HAND_COVER,
  RS_GROUP_HAND_HOLDER,
  RS_GROUP_HAND_ROOT,
  RS_GROUP_TARGETING_ARROW
} from "@/stream-ext/groups";

// -------------------------------------------------------------------------------------------------------------
// The pure plan (the policy, unchanged from the old mirror).
// -------------------------------------------------------------------------------------------------------------

function holder(id: number, localY: number | null) {
  return { id, localY };
}

function hud(id: number, kind: "HealthBar" | "Intents", top: number, height: number, reticleTop: number | null, powerTop: number | null): CreatureGroupFacts {
  return { id, kind, rootId: 1, top, height, reticleTop, powerTop };
}

describe("raisedHand — plan", () => {
  it("stands down for a targeting arrow, a hand choice or a dragged card", () => {
    const base: RaiseFrameInput = { holders: [holder(10, -59)], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [] };
    expect(raiseLiftPx(base)).toBe(119);
    expect(raiseLiftPx({ ...base, targeting: true })).toBe(0);
    expect(raiseLiftPx({ ...base, choicePrompt: true })).toBe(0);
    expect(raiseLiftPx({ ...base, dragging: true })).toBe(0);
  });

  it("lifts a resting holder by the full raise and leaves a focused holder alone", () => {
    const resting = computeRaisePlan({ holders: [holder(10, -59)], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [] });
    expect(resting.offsets).toEqual([{ id: 10, dy: -119 }]);
    // A focused holder sits at the game's own pose (t = 1), so the ramp applies no lift.
    const focused = computeRaisePlan({ holders: [holder(10, -209)], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [] });
    expect(focused.offsets).toEqual([]);
  });

  it("does not lift a holder that left the fan (localY null)", () => {
    const plan = computeRaisePlan({ holders: [holder(10, null)], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [] });
    expect(plan.offsets).toEqual([]);
  });

  it("shifts a creature HUD group above the reticle", () => {
    const group = hud(20, "HealthBar", 0, 64, -179, 25);
    const shifts = creatureShifts(group);
    expect(shifts.healthBar).toBe(-179 - (25 + 40));
    expect(creatureShiftFor("HealthBar", shifts)).toBe(shifts.healthBar);
    expect(creatureShiftFor("Intents", shifts)).toBe(shifts.intents);
    const plan = computeRaisePlan({ holders: [], targeting: false, choicePrompt: false, dragging: false, creatureGroups: [group] });
    expect(plan.offsets).toEqual([{ id: 20, dy: Math.round(shifts.healthBar) }]);
  });
});

// -------------------------------------------------------------------------------------------------------------
// The extension glue: identity indexing and the "dirty only" write discipline.
// -------------------------------------------------------------------------------------------------------------

function meta(id: number, groups: string[], path: string | null = null): ItemMeta {
  return { id, node: true, scene: null, script: null, path, groups, meta: {} };
}

function batch(items: ItemMeta[], form: "full" | "delta" = "full"): ItemMetaBatch {
  return { form, items };
}

class FakeOverrides implements OverrideTable {
  writes = 0;
  cleared: number[] = [];
  readonly values = new Map<number, { transform: Affine2D }>();
  set(id: number, o: { transform?: Affine2D }): void {
    this.writes++;
    if (o.transform) this.values.set(id, { transform: o.transform });
  }
  translate(id: number, dx: number, dy: number): void {
    this.writes++;
    this.values.set(id, { transform: [1, 0, 0, 1, dx, dy] });
  }
  scaleAbout(id: number, sx: number, sy: number, px: number, py: number): void {
    this.writes++;
    this.values.set(id, { transform: [sx, 0, 0, sy, px - sx * px, py - sy * py] });
  }
  setGlobal(): void { this.writes++; }
  freeze(): void { this.writes++; }
  clear(id: number): void { this.cleared.push(id); this.values.delete(id); }
  clearAll(): void { this.writes++; }
  get(): null { return null; }
  effective(): Affine2D { return [1, 0, 0, 1, 0, 0]; }
  size = 0;
}

function fakeQuery(overrides: Record<number, { parent?: number | null; x?: number; y?: number; visible?: boolean; rect?: Rect | null }>): ItemQuery {
  const children = (id: number) => Uint32Array.from(Object.keys(overrides).map(Number).filter((child) => overrides[child].parent === id));
  const rect = (id: number): Rect | null => {
    const o = overrides[id];
    if (o?.rect !== undefined) return o.rect;
    return o?.y === undefined ? null : { x: 0, y: o.y, w: 0, h: 0 };
  };
  const subtreeRect = (id: number): Rect | null => {
    const rects = [rect(id), ...Array.from(children(id), subtreeRect)].filter((r): r is Rect => r !== null);
    if (rects.length === 0) return null;
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  };
  return {
    parent: (id) => overrides[id]?.parent ?? null,
    children,
    transform: (id) => {
      const o = overrides[id];
      if (o === undefined || o.y === undefined) return null;
      return [1, 0, 0, 1, o.x ?? 0, o.y];
    },
    rect,
    subtreeRect,
    visible: (id) => overrides[id]?.visible ?? true,
    meta: (id) => {
      const m = metas.get(id);
      return m ?? null;
    },
    hitTest: () => null
  };
}

const metas = new Map<number, ItemMeta>();
let query: ItemQuery;
let overrides: FakeOverrides;

function frame(seq: number | null): ExtensionFrame {
  return { seq, now: 0, overrides, query, requestRedraw: () => {} };
}

describe("raisedHand — extension glue", () => {
  it.each([1920, 2340].flatMap((width) => [
    { kind: "ally", scene: "multiplayer_player_intent.tscn", height: 68, reticleTop: -284.95, intentY: 410, barDy: -350, intentDy: -102 },
    { kind: "enemy", scene: "intent.tscn", height: 64, reticleTop: -149.65, intentY: 540, barDy: -215, intentDy: -93 }
  ].map((fixture) => ({ ...fixture, width }))))(
    "matches the old $kind HUD offsets at $width", ({ width, scene, height, reticleTop, intentY, barDy, intentDy }) => {
    metas.clear();
    overrides = new FakeOverrides();
    const rootY = 740;
    query = fakeQuery({
      1: { x: width * 0.75, y: rootY, rect: null },
      20: { parent: 1, y: 747, rect: null },
      21: { parent: 1, y: intentY, rect: null },
      22: { parent: 1, y: rootY + reticleTop, rect: null },
      23: { parent: 20, y: 747 + 18, rect: null },
      25: { parent: 21, y: intentY, rect: null }
    });
    const items = [
      meta(20, [RS_GROUP_CREATURE_HUD], "HealthBar"),
      meta(21, [RS_GROUP_CREATURE_HUD], "Intents"),
      meta(22, [RS_GROUP_CREATURE_RETICLE], "SelectionReticle"),
      meta(23, [RS_GROUP_CREATURE_POWER], "PowerContainer"),
      { ...meta(25, [], "."), scene: `res://scenes/combat/${scene}` }
    ];
    for (const m of items) metas.set(m.id, m);

    const at = (y: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y } });
    const nodes = parseSceneDelta({ type: "scene-delta", upserts: [
      { id: "1", name: "Creature", transform: at(rootY) },
      { id: "20", parentId: "1", name: "HealthBar", transform: at(7) },
      { id: "21", parentId: "1", name: "Intents", transform: at(intentY - rootY), localRect: { position: { x: 0, y: 0 }, size: { x: 1000, y: height } } },
      { id: "22", parentId: "1", name: "SelectionReticle", transform: at(reticleTop) },
      { id: "23", parentId: "20", name: "PowerContainer", transform: at(18) }
    ] })!.upserts;
    const reference = creatureHudMeasure(new Map(nodes.map((n) => [n.id, n])),
      (id) => nodes.filter((n) => n.parentId === id).map((n) => n.id), "1");
    expect(Math.round(reference.healthBar)).toBe(barDy);
    expect(Math.round(reference.intents)).toBe(intentDy);

    const settings = createMirrorSettings(undefined, "", { storage: null });
    settings.raiseHandCards = true;
    const built = buildStreamExtensions({ settings, presentationWidth: width, interactive: true });
    const ext = built.extensions.find((e) => e.id === "couchcoop.raisedHand")!;
    ext.onItemMeta!(batch(items));
    ext.beforeDraw!(frame(1));
    expect(overrides.values.get(20)?.transform[5]).toBe(barDy);
    expect(overrides.values.get(21)?.transform[5]).toBe(intentDy);
    for (const extension of built.extensions) extension.dispose?.();
  });

  it.each([1920, 2340].flatMap((width) => ["health first", "intents first"].map((order) => ({ width, order }))))(
    "matches the old HUD measurement with draw-less groups at $width ($order)", ({ width, order }) => {
    metas.clear();
    overrides = new FakeOverrides();
    const rootY = 600;
    query = fakeQuery({
      1: { x: width * 0.75, y: rootY, rect: null },
      20: { parent: 1, y: rootY + 7, rect: null },
      21: { parent: 1, y: rootY - 310, rect: null },
      22: { parent: 1, y: rootY - 278, rect: null },
      23: { parent: 20, y: rootY + 39, rect: null },
      // The reticle painting overshoots its control origin; the old rule uses the origin.
      24: { parent: 22, rect: { x: 0, y: rootY - 288, w: 252, h: 178 } },
      25: { parent: 21, y: rootY - 310, rect: null },
      27: { parent: 25, rect: { x: 0, y: rootY - 316, w: 64, h: 26 } },
      // Drawn health labels can overshoot the display's own origin; they must not define displayTop.
      26: { parent: 20, rect: { x: 0, y: rootY - 6, w: 258, h: 26 } }
    });
    const health = { ...meta(20, [RS_GROUP_CREATURE_HUD], "HealthBar"), scene: "res://scenes/combat/creature_state_display.tscn" };
    const intents = meta(21, [RS_GROUP_CREATURE_HUD], "Intents");
    const items = [
      ...(order === "health first" ? [health, intents] : [intents, health]),
      meta(22, [RS_GROUP_CREATURE_RETICLE], "SelectionReticle"),
      meta(23, [RS_GROUP_CREATURE_POWER], "PowerContainer"),
      { ...meta(25, [], "."), scene: "res://scenes/combat/intent.tscn" }
    ];
    for (const m of items) metas.set(m.id, m);

    // The same geometry in the old renderer's parent-relative node shape.
    const at = (y: number) => ({ xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 0, y } });
    const nodes = parseSceneDelta({ type: "scene-delta", upserts: [
      { id: "1", name: "Creature", transform: at(rootY) },
      { id: "20", parentId: "1", name: "HealthBar", transform: at(7) },
      { id: "21", parentId: "1", name: "Intents", transform: at(-310), localRect: { position: { x: 0, y: 0 }, size: { x: 1000, y: 64 } } },
      { id: "22", parentId: "1", name: "SelectionReticle", transform: at(-278) },
      { id: "23", parentId: "20", name: "PowerContainer", transform: at(32) }
    ] })!.upserts;
    const reference = creatureHudMeasure(new Map(nodes.map((n) => [n.id, n])),
      (id) => nodes.filter((n) => n.parentId === id).map((n) => n.id), "1");
    expect(reference.healthBar).toBe(-357);
    expect(reference.intents).toBe(-125);

    const settings = createMirrorSettings(undefined, "", { storage: null });
    settings.raiseHandCards = true;
    const built = buildStreamExtensions({ settings, presentationWidth: width, interactive: true });
    const ext = built.extensions.find((e) => e.id === "couchcoop.raisedHand")!;
    ext.onItemMeta!(batch(items));
    ext.beforeDraw!(frame(1));
    expect(query.rect(22)).toBeNull();
    expect(query.subtreeRect(22)?.y).toBe(rootY - 288);
    const barDy = overrides.values.get(20)!.transform[5];
    const intentDy = overrides.values.get(21)!.transform[5];
    expect(barDy).toBe(reference.healthBar);
    expect(intentDy).toBe(reference.intents);
    // The shifted row bottom keeps the old 21px gap above the shifted display origin.
    expect(rootY + 7 + barDy - (rootY - 310 + 64 + intentDy)).toBe(21);
    settings.raiseHandCards = false;
    const read = vi.spyOn(query, "transform");
    ext.beforeDraw!(frame(null));
    expect(overrides.values.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
    for (const extension of built.extensions) extension.dispose?.();
  });

  it("preserves the intent lift while drawn children bob across transactions", () => {
    metas.clear();
    overrides = new FakeOverrides();
    const geometry = {
      1: { y: 600, rect: null },
      20: { parent: 1, y: 607, rect: null },
      21: { parent: 1, y: 290, rect: null },
      25: { parent: 21, y: 290, rect: null },
      26: { parent: 25, y: 284, rect: { x: 0, y: 284, w: 100, h: 26 } }
    };
    query = fakeQuery(geometry);
    const items = [meta(20, [RS_GROUP_CREATURE_HUD], "HealthBar"), meta(21, [RS_GROUP_CREATURE_HUD], "Intents"),
      { ...meta(25, [], "."), scene: "res://scenes/combat/intent.tscn" }];
    for (const m of items) metas.set(m.id, m);
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch(items));
    ext.beforeDraw!(frame(1));
    const lift = overrides.values.get(21)!.transform[5];
    expect(lift).toBe(-12);
    geometry[26].y += 12;
    geometry[26].rect.y += 12;
    ext.beforeDraw!(frame(2));
    expect(overrides.values.get(21)!.transform[5]).toBe(lift);
    ext.dispose!();
  });

  it("leaves intents unshifted when their own transform is unknown despite drawn descendants", () => {
    metas.clear();
    overrides = new FakeOverrides();
    query = fakeQuery({
      1: { y: 600, rect: null },
      20: { parent: 1, y: 607, rect: null },
      21: { parent: 1, rect: null },
      25: { parent: 21, rect: { x: 0, y: 290, w: 100, h: 26 } }
    });
    const items = [meta(20, [RS_GROUP_CREATURE_HUD], "HealthBar"), meta(21, [RS_GROUP_CREATURE_HUD], "Intents")];
    for (const m of items) metas.set(m.id, m);
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch(items));
    ext.beforeDraw!(frame(1));
    expect(overrides.values.has(21)).toBe(false);
    ext.dispose!();
  });

  it.each([true, false])("uses the reticle origin without drawn bounds, falling back only without a transform (%s)", (known) => {
    metas.clear();
    overrides = new FakeOverrides();
    query = fakeQuery({
      1: { y: 600 },
      20: { parent: 1, y: 607, rect: null },
      22: { parent: 1, y: known ? 322 : undefined, rect: null }
    });
    const items = [meta(20, [RS_GROUP_CREATURE_HUD], "HealthBar"), meta(22, [RS_GROUP_CREATURE_RETICLE])];
    for (const m of items) metas.set(m.id, m);
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch(items));
    ext.beforeDraw!(frame(1));
    expect(overrides.values.get(20)?.transform[5]).toBe(known ? -343 : -244);
    ext.dispose!();
  });

  it("indexes the mod's groups and writes a lift only while dirty", () => {
    metas.clear();
    overrides = new FakeOverrides();
    const container = 100;
    query = fakeQuery({
      [container]: { y: 0 },
      10: { parent: container, y: -59 }
    });
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch([
      meta(10, [RS_GROUP_HAND_HOLDER], "CardHolderContainer/NHandCardHolder-CARD"),
      meta(container, [RS_GROUP_HAND_CONTAINER])
    ]));

    ext.beforeDraw!(frame(5));
    expect(overrides.values.has(10)).toBe(true);
    expect(overrides.values.get(10)!.transform[5]).toBe(-119);
    const writesAfterFirst = overrides.writes;

    // Nothing changed: the same transaction again must not write a single override (the "dirty only" spec).
    ext.beforeDraw!(frame(5));
    expect(overrides.writes).toBe(writesAfterFirst);

    ext.dispose!();
  });

  it("leaves a holder that was reparented onto the hand root alone", () => {
    metas.clear();
    overrides = new FakeOverrides();
    const container = 100;
    const handRoot = 200;
    query = fakeQuery({
      [container]: { y: 0 },
      [handRoot]: { y: 0 },
      11: { parent: handRoot, y: -59 }
    });
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch([
      meta(11, [RS_GROUP_HAND_HOLDER]),
      meta(container, [RS_GROUP_HAND_CONTAINER]),
      meta(handRoot, [RS_GROUP_HAND_ROOT])
    ]));
    ext.beforeDraw!(frame(1));
    expect(overrides.values.has(11)).toBe(false);
    ext.dispose!();
  });

  it("stands the lift down while a targeting arrow is visible", () => {
    metas.clear();
    overrides = new FakeOverrides();
    const container = 100;
    const arrow = 300;
    query = fakeQuery({
      [container]: { y: 0 },
      10: { parent: container, y: -59 },
      [arrow]: { visible: true }
    });
    const ext = createRaisedHandExtension();
    ext.onItemMeta!(batch([
      meta(10, [RS_GROUP_HAND_HOLDER]),
      meta(container, [RS_GROUP_HAND_CONTAINER]),
      meta(arrow, [RS_GROUP_TARGETING_ARROW])
    ]));
    ext.beforeDraw!(frame(1));
    expect(overrides.values.has(10)).toBe(false);
    ext.dispose!();
  });
});

describe("raisedHand — off is empty", () => {
  it("asks for the mod's groups and scene/path identity", () => {
    const ext = createRaisedHandExtension();
    expect(ext.wants?.fields).toEqual(["scene", "path"]);
    expect([...(ext.wants?.groups ?? [])].sort()).toEqual([...RAISE_GROUPS].slice().sort());
  });
});


describe("hand presence — stream chrome", () => {
  it("tracks visual covers independently of holder hits, only on transactions or identity changes", () => {
    const onPresent = vi.fn();
    const extension = createHandPresenceExtension(onPresent);
    expect(extension.wants?.groups).toContain(RS_GROUP_HAND_COVER);
    const q = fakeQuery({
      10: { rect: { x: 400, y: 900, w: 100, h: 120 } },
      90: { rect: null }
    });
    const hit = vi.spyOn(q, "hitTest").mockReturnValue(10);
    const visible = vi.spyOn(q, "visible");
    const f: ExtensionFrame = { seq: 1, now: 0, query: q, overrides: new FakeOverrides(), requestRedraw: vi.fn() };
    const holder = meta(10, [RS_GROUP_HAND_HOLDER]);
    const cover = meta(90, [RS_GROUP_HAND_COVER]);
    extension.onItemMeta!(batch([holder, cover]));
    extension.beforeDraw!(f);
    expect(onPresent).toHaveBeenLastCalledWith(true, true);
    expect(hit).not.toHaveBeenCalled();
    visible.mockClear();
    onPresent.mockClear();
    extension.beforeDraw!(f);
    extension.beforeDraw!({ ...f, seq: null });
    expect(visible).not.toHaveBeenCalled();
    expect(onPresent).not.toHaveBeenCalled();

    visible.mockImplementation((id) => id !== 90);
    extension.beforeDraw!({ ...f, seq: 2 });
    expect(onPresent).toHaveBeenLastCalledWith(true, false);
    visible.mockReturnValue(true);
    extension.beforeDraw!({ ...f, seq: 3 });
    expect(onPresent).toHaveBeenLastCalledWith(true, true);
    for (const removeCover of [
      () => extension.onItemMeta!(batch([meta(90, [])], "delta")),
      () => extension.onItemsRemoved!(Uint32Array.of(90)),
      () => extension.onItemMeta!(batch([holder]))
    ]) {
      removeCover();
      extension.beforeDraw!({ ...f, seq: null });
      expect(onPresent).toHaveBeenLastCalledWith(true, false);
      extension.onItemMeta!(batch([cover], "delta"));
      extension.beforeDraw!({ ...f, seq: null });
      expect(onPresent).toHaveBeenLastCalledWith(true, true);
    }
    extension.dispose!();
    expect(onPresent).toHaveBeenLastCalledWith(false, false);
  });

  it("reads visible holders only on stream changes, then retires the button on removal or teardown", () => {
    const onPresent = vi.fn();
    const extension = createHandPresenceExtension(onPresent);
    const query = fakeQuery({ 10: { visible: true } });
    const visible = vi.spyOn(query, "visible");
    const f: ExtensionFrame = { seq: 1, now: 0, query, overrides: new FakeOverrides(), requestRedraw: vi.fn() };
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_HAND_HOLDER])]));
    extension.beforeDraw!(f);
    expect(onPresent).toHaveBeenLastCalledWith(true, false);
    visible.mockClear();
    onPresent.mockClear();
    extension.beforeDraw!(f);
    extension.beforeDraw!({ ...f, seq: null });
    expect(visible).not.toHaveBeenCalled();
    expect(onPresent).not.toHaveBeenCalled();
    visible.mockReturnValue(false);
    extension.beforeDraw!({ ...f, seq: 2 });
    expect(onPresent).toHaveBeenLastCalledWith(false, false);
    visible.mockReturnValue(true);
    extension.beforeDraw!({ ...f, seq: 3 });
    expect(onPresent).toHaveBeenLastCalledWith(true, false);
    extension.onItemsRemoved!(Uint32Array.of(10));
    visible.mockClear();
    extension.beforeDraw!({ ...f, seq: null });
    expect(onPresent).toHaveBeenLastCalledWith(false, false);
    expect(visible).not.toHaveBeenCalled();
    extension.dispose!();
    expect(onPresent).toHaveBeenLastCalledWith(false, false);
    expect(f.requestRedraw).not.toHaveBeenCalled();
  });

  it.each([10, 100, 200])("accepts hits within the hand via ancestor %i and checks covers only on stream changes", (ancestor) => {
    const onPresent = vi.fn();
    const extension = createHandPresenceExtension(onPresent);
    const q = fakeQuery({
      200: {}, 100: { parent: 200 },
      10: { parent: 100, rect: null },
      11: { parent: ancestor },
      12: { parent: 10, rect: { x: 100, y: 200, w: 80, h: 120 } }, 99: {}
    });
    const hit = vi.spyOn(q, "hitTest").mockReturnValue(11);
    const o = new FakeOverrides();
    vi.spyOn(o, "effective").mockReturnValue([1, 0, 0, 1, 30, -119]);
    const f: ExtensionFrame = { seq: 1, now: 0, query: q, overrides: o, requestRedraw: vi.fn() };
    extension.onItemMeta!(batch([
      meta(10, [RS_GROUP_HAND_HOLDER]), meta(100, [RS_GROUP_HAND_CONTAINER]), meta(200, [RS_GROUP_HAND_ROOT])
    ]));
    extension.beforeDraw!(f);
    expect(hit).toHaveBeenLastCalledWith(170, 141);
    expect(onPresent).toHaveBeenLastCalledWith(true, false);
    hit.mockReturnValue(99).mockClear();
    extension.beforeDraw!({ ...f, seq: null });
    expect(hit).not.toHaveBeenCalled();
    extension.beforeDraw!({ ...f, seq: 2 });
    expect(onPresent).toHaveBeenLastCalledWith(true, true);
    hit.mockReturnValue(11);
    extension.onItemMeta!(batch([], "delta"));
    extension.beforeDraw!({ ...f, seq: null });
    expect(onPresent).toHaveBeenLastCalledWith(true, false);
    vi.spyOn(q, "visible").mockReturnValue(false);
    hit.mockClear();
    extension.beforeDraw!({ ...f, seq: 3 });
    expect(onPresent).toHaveBeenLastCalledWith(false, false);
    expect(hit).not.toHaveBeenCalled();
    extension.dispose!();
  });

  it("drops holders when a full table replaces combat or a delta removes their role", () => {
    const onPresent = vi.fn();
    const extension = createHandPresenceExtension(onPresent);
    const f: ExtensionFrame = { seq: null, now: 0, query: fakeQuery({}), overrides: new FakeOverrides(), requestRedraw: vi.fn() };
    extension.onItemMeta!(batch([meta(10, [RS_GROUP_HAND_HOLDER])]));
    extension.beforeDraw!(f);
    expect(onPresent).toHaveBeenLastCalledWith(true, false);
    extension.onItemMeta!(batch([meta(10, [])], "delta"));
    extension.beforeDraw!(f);
    expect(onPresent).toHaveBeenLastCalledWith(false, false);
    extension.onItemMeta!(batch([meta(11, [RS_GROUP_HAND_HOLDER])]));
    extension.beforeDraw!(f);
    expect(onPresent).toHaveBeenLastCalledWith(true, false);
    extension.onItemMeta!(batch([]));
    extension.beforeDraw!(f);
    expect(onPresent).toHaveBeenLastCalledWith(false, false);
    extension.dispose!();
  });
});
