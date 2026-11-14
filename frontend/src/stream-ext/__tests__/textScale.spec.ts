import { afterEach, describe, expect, it, vi } from "vitest";

import type { Affine2D, ExtensionFrame, ExtensionSession, ItemMeta, ItemQuery, OverrideTable, OverrideValues } from "@godot-scene-web/render-stream-client";
import { ExtensionHost } from "../../../../../godot-scene-web/packages/render-stream-client/src/extensions";

import { createMirrorSettings } from "@/mirror/mirrorSettings";
import {
  EMPTY_TEXT_SCALE_DECLS, OLD_TEXT_BASE, resolveTextScaleClasses, resolveTextScaleDecls,
  STREAM_TEXT_FACTOR_OVERRIDES, streamTextScaleOf, TEXT_SCALE_CLASS_PREFIX, TEXT_SCALE_RULES
} from "@/mirror/textScaleClasses";
import { buildStreamExtensions } from "@/stream-ext/extensions";
import { RS_GROUP_CARD_REWARD_CARD, RS_GROUP_HOVER_TIP } from "@/stream-ext/groups";
import { createTextScaleExtension, resolveStreamTextScale, streamTextPivot, type ScaledTextLabel } from "@/stream-ext/textScale";
import { resolveStreamViewScale } from "@/stream-ext/viewScale";

// Scene/path examples are independent of the matcher table: changing a matcher must break its case.
const cases: readonly [key: string, scene: string, path: string, oldFactor: number][] = [
  ["hovertip-title", "ui/hover_tip", "TextContainer/VBoxContainer/HBoxContainer/Title", 1.08],
  ["hovertip-description", "ui/hover_tip", "TextContainer/VBoxContainer/Description", 1.08],
  ["card-description", "cards/card", "CardContainer/DescriptionLabel", 1.24],
  ["card-title", "cards/card", "CardContainer/TitleLabel", 1.14],
  ["card-type", "cards/card", "CardContainer/TypePlaque/TypeLabel", 1.24],
  ["card-energy", "cards/card", "CardContainer/EnergyIcon/EnergyLabel", 1.24],
  ["card-star", "cards/card", "CardContainer/StarIcon/StarLabel", 1.24],
  ["card-enchantment", "cards/card", "CardContainer/Enchantment/Label", 1.24],
  ["topbar-hp", "ui/top_bar", "LeftAlignedStuff/TopBarHp/HpLabel", 1.20],
  ["topbar-gold", "ui/top_bar", "LeftAlignedStuff/TopBarGold/GoldLabel", 1.20],
  ["topbar-floor", "ui/top_bar", "LeftAlignedStuff/RoomIcons/FloorIcon/FloorNumLabel", 1.12],
  ["topbar-timer", "ui/top_bar", "RightAlignedStuff/TimerContainer/TimerLabel", 1.08],
  ["topbar-deck-count", "ui/top_bar/top_bar_deck_button", "DeckCardCount", 1.24],
  ["energy-counter", "combat/energy_counters/ironclad_energy_counter", "Label", 1.24],
  ["end-turn", "combat/end_turn_button", "Visuals/Label", 1.54],
  ["star-counter", "combat/energy_counters/star_counter", "MarginContainer/CountLabel", 1.24],
  ["draw-pile", "combat/draw_pile", "CountContainer/Count", 1.16],
  ["discard-pile", "combat/discard_pile", "CountContainer/Count", 1.16],
  ["exhaust-pile", "combat/exhaust_pile", "CountContainer/Count", 1.16],
  ["intent-value", "combat/intent", "IntentHolder/Value", 1.32],
  ["healthbar-hp", "combat/health_bar", "HpBarContainer/HpLabel", 1.42],
  ["healthbar-block", "combat/health_bar", "BlockContainer/BlockLabel", 1.42],
  ["power-amount", "combat/power", "AmountLabel", 1.48],
  ["relic-amount", "relics/relic", "AmountLabel", 1.48],
  ["orb-passive-amount", "orbs/orb", "LabelContainer/PassiveAmount", 1.48],
  ["orb-evoke-amount", "orbs/orb", "LabelContainer/EvokeAmount", 1.48],
  ["mp-run-nameplate", "run", "Hud/MultiplayerPlayerContainer/P2/TopInfoContainer/NameplateLabel", 1.08],
  ["mp-run-energy", "run", "Hud/MultiplayerPlayerContainer/P2/TopInfoContainer/EnergyCountContainer/EnergyCount", 1.40],
  ["mp-run-star", "run", "Hud/MultiplayerPlayerContainer/P2/TopInfoContainer/StarCountContainer/StarCount", 1.40],
  ["mp-run-card", "run", "Hud/MultiplayerPlayerContainer/P2/TopInfoContainer/CardCountContainer/CardCount", 1.40],
  ["mp-run-hp", "run", "Hud/MultiplayerPlayerContainer/P2/HealthBar/HpBarContainer/HpLabel", 1.32],
  ["mp-run-block", "run", "Hud/MultiplayerPlayerContainer/P2/HealthBar/BlockContainer/BlockLabel", 1.40],
  ["mp-state-nameplate", "ui/multiplayer_player_state", "TopInfoContainer/NameplateLabel", 1.08],
  ["mp-state-energy", "ui/multiplayer_player_state", "TopInfoContainer/EnergyCountContainer/EnergyCount", 1.40],
  ["mp-state-star", "ui/multiplayer_player_state", "TopInfoContainer/StarCountContainer/StarCount", 1.40],
  ["mp-state-card", "ui/multiplayer_player_state", "TopInfoContainer/CardCountContainer/CardCount", 1.40],
  ["event-ancient-option", "events/ancient_event_layout", "OptionsContainer/Option/Text", 1.12],
  ["event-default-option", "events/default_event_layout", "OptionsContainer/Option/Text", 1.12],
  ["event-ancient-option-scene", "events/ancient_event_option_button", "HBoxContainer/Text", 1.12],
  ["event-option-scene", "events/event_option_button", "Text", 1.12],
  ["rest-choice", "rooms/rest_site_room", "ChoicesScreen/ChoicesContainer/Choice/Label", 1.16],
  ["rest-choice-scene", "rest_site/rest_site_button", "Label", 1.16],
  ["rest-description", "rooms/rest_site_room", "ChoicesScreen/Description", 1.20],
  ["proceed-label", "ui/proceed_button", "Image/Label", 1.08],
  ["merchant-inventory-cost", "merchant/merchant_inventory", "SlotsContainer/Slot/Cost/CostLabel", 1.20],
  ["merchant-card-cost", "merchant/merchant_card", "Cost/CostLabel", 1.20],
  ["merchant-potion-cost", "merchant/merchant_potion", "Cost/CostLabel", 1.20],
  ["merchant-relic-cost", "merchant/merchant_relic", "Cost/CostLabel", 1.20],
  ["merchant-removal-cost", "merchant/merchant_card_removal", "Cost/CostLabel", 1.20],
  ["rewards-screen-label", "screens/rewards_screen", "Rewards/Row/LabelContainer/Label", 1.32],
  ["reward-button-label", "rewards/reward_button", "LabelContainer/Label", 1.32]
];

const calibrated: Record<string, number> = {
  "healthbar-hp": 1.40, "power-amount": 1.46, "intent-value": 1.30,
  "topbar-deck-count": 1.171, "topbar-hp": 1.157, "topbar-gold": 1.157,
  "merchant-inventory-cost": 1.15, "merchant-card-cost": 1.15, "merchant-potion-cost": 1.15,
  "merchant-relic-cost": 1.15, "merchant-removal-cost": 1.15,
  "draw-pile": 1.10, "discard-pile": 1.10, "exhaust-pile": 1.10, "end-turn": 1.06,
  "relic-amount": 1.28, "orb-passive-amount": 1.46, "orb-evoke-amount": 1.46,
  "star-counter": 1.24 / 1.08
};

function meta(key = "card-title", id = 1): ItemMeta {
  const [, scene, path] = cases.find((c) => c[0] === key)!;
  return { id, node: true, scene: `res://scenes/${scene}.tscn`, path, groups: [], meta: {} };
}

type DebugWindow = { __renderStreamTextScale?: () => readonly ScaledTextLabel[] };
const debugWindow = window as unknown as DebugWindow;
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach((dispose) => dispose()); });

function composedOverrides() {
  const host = new ExtensionHost([]);
  host.bind({
    queryItem: (id) => id === 1 ? [2] : id === 2 ? [3] : [-1],
    itemMetaJson: () => "", setLogRemoved: vi.fn(), takeRemoved: () => new Uint32Array(),
    setOverrides: vi.fn(), refreshOverrides: () => 0, querySubtreeRect: () => [],
    queryChildren: () => new Uint32Array(), hitTest: () => null,
    setHitFilters: vi.fn(), setPickOrder: vi.fn()
  });
  disposals.push(() => host.dispose());
  return host.overrides;
}

function fixture() {
  const values = new Map<number, Required<OverrideValues>>();
  const overrides: OverrideTable = {
    set: vi.fn(), translate: vi.fn(), setGlobal: vi.fn(), freeze: vi.fn(), clearAll: vi.fn(),
    scaleAbout: vi.fn((id, sx, sy, x, y) => {
      values.set(id, { transform: [sx, 0, 0, sy, x - sx * x, y - sy * y], modulate: [1, 1, 1, 1], visible: true, frozen: false });
    }),
    clear: vi.fn((id) => { values.delete(id); }),
    get: vi.fn((id) => values.get(id) ?? null),
    effective: vi.fn((): Affine2D => [1, 0, 0, 1, 0, 0]),
    get size() { return values.size; }
  };
  const query: ItemQuery = {
    parent: vi.fn(() => null), children: vi.fn(() => new Uint32Array()),
    rect: vi.fn(() => ({ x: 100, y: 200, w: 80, h: 20 })),
    subtreeRect: vi.fn(() => null), transform: vi.fn((): Affine2D => [1, 0, 0, 1, 0, 0]),
    visible: vi.fn(() => true), meta: vi.fn(() => null), hitTest: vi.fn(() => null)
  };
  const frame: ExtensionFrame = { seq: 1, now: 0, query, overrides, requestRedraw: vi.fn() };
  const session: ExtensionSession = {
    sessionId: "s", streamId: "s", itemMeta: null, requestRedraw: frame.requestRedraw,
    mouseFilter: vi.fn(), pickOrder: vi.fn()
  };
  const extension = createTextScaleExtension();
  extension.onSession!(session);
  disposals.push(() => extension.dispose!());
  extension.onItemMeta!({ form: "full", items: [meta()] });
  return { frame, session, extension, query, overrides, values };
}

describe("stream text scale — table", () => {
  it("covers every old rule with an independent scene/path fixture", () => {
    expect(cases.map((c) => c[0]).sort()).toEqual(TEXT_SCALE_RULES.map((r) => r.key).sort());
    expect(OLD_TEXT_BASE).toBe(1.08);
    expect(STREAM_TEXT_FACTOR_OVERRIDES).toEqual(calibrated);
  });

  it.each(cases)("resolves %s at the old displayed size, without claiming its ancestor's id", (key, _scene, _path, old) => {
    const item = meta(key);
    expect(resolveTextScaleClasses(item.scene!, item.path!)).toContain(TEXT_SCALE_CLASS_PREFIX + key);
    const scale = resolveStreamTextScale(item);
    expect(scale?.key).toBe(key);
    expect(scale?.factor).toBeCloseTo(calibrated[key] ?? Math.max(1, old / 1.08));
    expect(resolveStreamViewScale(item)).toBeNull();
  });

  it.each([
    "rewards-screen-label", "reward-button-label", "hovertip-description", "event-ancient-option",
    "event-default-option", "event-ancient-option-scene", "event-option-scene", "rest-description", "end-turn"
  ])("includes re-wrap class %s", (key) => {
    expect(resolveStreamTextScale(meta(key))?.key).toBe(key);
  });

  it("uses rigid factors, handles neutral declarations and never shrinks by default", () => {
    expect(streamTextScaleOf({ self: {}, text: { transform: "scale(1.24)" } })).toBeCloseTo(1.24 / 1.08);
    expect(streamTextScaleOf({ self: { "--godot-text-scale": "1.32" }, text: { transform: "scale(1.24)" } })).toBeCloseTo(1.32 / 1.08);
    expect(streamTextScaleOf(EMPTY_TEXT_SCALE_DECLS)).toBe(1);
    expect(streamTextScaleOf({ self: { "--godot-text-scale": "0.9" }, text: {} })).toBe(1);
    expect(streamTextScaleOf({ self: { "--godot-text-scale": "invalid" }, text: {} })).toBe(1);
    const endTurn = meta("end-turn");
    expect(resolveTextScaleDecls(endTurn.scene!, endTurn.path!).text["font-size"]).toContain("min(");
    expect(streamTextScaleOf(resolveTextScaleDecls(endTurn.scene!, endTurn.path!))).toBeCloseTo(1.54 / 1.08);
    expect(resolveStreamTextScale(endTurn)?.factor).toBe(1.06);
  });

  it("allows a calibrated per-class override to shrink below game size", () => {
    const overrides = STREAM_TEXT_FACTOR_OVERRIDES as Record<string, number>;
    overrides["card-title"] = 0.95;
    try { expect(resolveStreamTextScale(meta())?.factor).toBe(0.95); }
    finally { delete overrides["card-title"]; }
  });

  it("does not invent missing identities or scale roots owned by other modules", () => {
    expect(resolveStreamTextScale({ ...meta(), scene: null, path: null })).toBeNull();
    expect(resolveStreamTextScale({ ...meta(), node: false })).toBeNull();
    expect(resolveStreamTextScale({ ...meta(), groups: [RS_GROUP_HOVER_TIP] })).toBeNull();
    expect(resolveStreamTextScale({ ...meta(), groups: [RS_GROUP_CARD_REWARD_CARD] })).toBeNull();
    expect(resolveStreamTextScale({ ...meta(), scene: "res://scenes/combat/draw_pile.tscn", path: "." })).toBeNull();
  });
});

describe("stream text scale — pivots and lifecycle", () => {
  it.each(["rewards-screen-label", "reward-button-label"])("fits %s uniformly without shrinking or overlapping the icon", (key) => {
    for (const [width, factor] of [[100, 1.32 / 1.08], [340, 360 / 340], [400, 1]]) {
      const f = fixture();
      const overrides = composedOverrides();
      const writes = vi.spyOn(overrides, "set");
      const box = { x: 120, y: 220, w: width, h: 20 };
      const area = { x: 120, y: 210, w: 400, h: 50 };
      const icon = { x: 60, y: 220, w: 48, h: 20 };
      vi.mocked(f.query.parent).mockImplementation((id) => id === 1 ? 2 : id === 2 ? 3 : null);
      vi.mocked(f.query.rect).mockImplementation((id) => id === 1 ? box : id === 2 ? area : null);
      f.extension.onItemMeta!({ form: "full", items: [meta(key)] });
      overrides.set(3, { transform: [1.2, 0, 0, 1.2, 30, -50] });
      overrides.translate(2, 10, 2);
      writes.mockClear();
      const frame = { ...f.frame, overrides };
      const expectPlacement = () => {
        const drawn = overrides.effective(1);
        const parent = overrides.effective(2);
        const row = overrides.effective(3);
        const left = drawn[0] * box.x + drawn[4];
        const right = drawn[0] * (box.x + box.w) + drawn[4];
        const transform = overrides.get(1)!.transform;
        expect(transform[0]).toBe(transform[3]);
        expect(transform[0]).toBeCloseTo(factor);
        expect(transform[0]).toBeGreaterThanOrEqual(1);
        expect(transform[0]).toBeLessThanOrEqual(1.32 / 1.08);
        if (width <= 360) {
          expect((left + right) / 2).toBeCloseTo(parent[0] * 300 + parent[4], 6);
          expect(right).toBeLessThanOrEqual(parent[0] * 480 + parent[4] + 1e-6);
        } else {
          expect(left).toBeCloseTo(parent[0] * area.x + parent[4], 6);
        }
        expect(drawn[3] * 230 + drawn[5]).toBeCloseTo(parent[3] * 230 + parent[5], 6);
        expect(left).toBeGreaterThanOrEqual(parent[0] * area.x + parent[4] - 1e-6);
        expect(left).toBeGreaterThan(row[0] * (icon.x + icon.w) + row[4]);
      };
      f.extension.beforeDraw!(frame);
      expectPlacement();
      expect(writes).toHaveBeenCalledTimes(1);
      f.extension.beforeDraw!({ ...frame, seq: null });
      expect(writes).toHaveBeenCalledTimes(1);
      overrides.translate(3, 400, -100);
      f.extension.beforeDraw!({ ...frame, seq: null });
      expectPlacement();
      // At game size the zero-offset identity already follows its ancestors.
      expect(writes).toHaveBeenCalledTimes(factor === 1 ? 1 : 2);
    }
  });

  it("uses the container origin and row bounds when the reward container draws nothing", () => {
    const f = fixture();
    const overrides = composedOverrides();
    vi.mocked(f.query.parent).mockImplementation((id) => id === 1 ? 2 : id === 2 ? 3 : null);
    vi.mocked(f.query.transform).mockImplementation((id) => [1, 0, 0, 1, id === 2 ? 120 : 0, 0]);
    vi.mocked(f.query.rect).mockImplementation((id) => id === 1 ? { x: 120, y: 220, w: 100, h: 20 } : null);
    vi.mocked(f.query.subtreeRect).mockImplementation((id) => id === 3 ? { x: 40, y: 210, w: 480, h: 50 } : null);
    f.extension.onItemMeta!({ form: "full", items: [meta("reward-button-label")] });
    f.extension.beforeDraw!({ ...f.frame, overrides });
    const drawn = overrides.effective(1);
    expect(drawn[0] * 170 + drawn[4]).toBeCloseTo(300, 6);
  });

  it("leaves labels at the calibrated neutral factor without an override", () => {
    const f = fixture();
    f.extension.onItemMeta!({ form: "full", items: [meta("hovertip-description")] });
    f.extension.beforeDraw!(f.frame);
    expect(f.overrides.scaleAbout).not.toHaveBeenCalled();
    expect(debugWindow.__renderStreamTextScale!()).toEqual([]);
  });

  it.each(["left", "center", "right"] as const)("keeps the %s anchor fixed", (pivot) => {
    const box = { x: 100, y: 200, w: 80, h: 20 };
    const expectedX = pivot === "left" ? 100 : pivot === "right" ? 180 : 140;
    expect(streamTextPivot(box, pivot, [1, 0, 0, 1, 0, 0])).toEqual({ x: expectedX, y: 210 });
    const f = fixture();
    const item = meta(pivot === "left" ? "topbar-hp" : pivot === "right" ? "relic-amount" : "card-title");
    f.extension.onItemMeta!({ form: "full", items: [item] });
    f.extension.beforeDraw!(f.frame);
    const s = resolveStreamTextScale(item)!.factor;
    expect(f.overrides.scaleAbout).toHaveBeenCalledWith(1, s, s, expectedX, 210);
    const xf = f.values.get(1)!.transform;
    expect(xf[0] * expectedX + xf[4]).toBeCloseTo(expectedX);
    expect(xf[3] * 210 + xf[5]).toBeCloseTo(210);
  });

  it("falls back to centre for rotated, skewed, mirrored or missing transforms", () => {
    for (const xf of [[0, 1, -1, 0, 0, 0], [1, 0.1, 0, 1, 0, 0], [-1, 0, 0, 1, 0, 0], null] as const) {
      expect(streamTextPivot({ x: 100, y: 200, w: 80, h: 20 }, "right", xf)).toEqual({ x: 140, y: 210 });
    }
  });

  it.each([
    ["card-description", 800],
    ["topbar-hp", 750],
    ["relic-amount", 850]
  ] as const)("keeps the %s anchor fixed under composed ancestor overrides and redraws", (key, x) => {
    const f = fixture();
    const overrides = composedOverrides();
    const writes = vi.spyOn(overrides, "scaleAbout");
    vi.mocked(f.query.parent).mockReturnValue(2);
    vi.mocked(f.query.rect).mockReturnValue({ x: 750, y: 250, w: 100, h: 20 });
    f.extension.onItemMeta!({ form: "full", items: [meta(key)] });
    const frame = { ...f.frame, overrides };
    const anchor = { x, y: 260 };
    const map = (xf: Affine2D) => ({
      x: xf[0] * anchor.x + xf[2] * anchor.y + xf[4],
      y: xf[1] * anchor.x + xf[3] * anchor.y + xf[5]
    });
    const expectFixed = () => {
      const expected = map(overrides.effective(2));
      const actual = map(overrides.effective(1));
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    };
    overrides.set(2, { transform: [1.2, 0, 0, 1.2, -190, -100] });
    f.extension.beforeDraw!(frame);
    expectFixed();
    if (key === "card-description") {
      const centre = map(overrides.effective(1));
      expect(centre.x).toBeCloseTo(770, 6);
      expect(centre.y).toBeCloseTo(212, 6);
    }
    expect(writes).toHaveBeenCalledTimes(1);

    // A held/raised ancestor can move repeatedly without another stream transaction.
    overrides.translate(3, 400, -100);
    f.extension.beforeDraw!({ ...frame, seq: null });
    expectFixed();
    expect(writes).toHaveBeenCalledTimes(2);
    overrides.translate(3, 450, -120);
    f.extension.beforeDraw!({ ...frame, seq: null });
    expectFixed();
    expect(writes).toHaveBeenCalledTimes(3);
    f.extension.beforeDraw!({ ...frame, seq: null });
    expect(writes).toHaveBeenCalledTimes(3);
  });

  it("writes only a changed transform and exposes scaled labels", () => {
    const f = fixture();
    f.extension.beforeDraw!(f.frame);
    const factor = 1.14 / 1.08;
    expect(debugWindow.__renderStreamTextScale!()).toEqual([{ id: 1, key: "card-title", factor, pivot: "center" }]);
    f.extension.beforeDraw!(f.frame);
    f.extension.beforeDraw!({ ...f.frame, seq: null });
    expect(f.query.rect).toHaveBeenCalledTimes(3);
    f.extension.beforeDraw!({ ...f.frame, seq: 2 });
    f.extension.onItemMeta!({ form: "delta", items: [meta()] });
    f.extension.beforeDraw!({ ...f.frame, seq: 2 });
    expect(f.overrides.scaleAbout).toHaveBeenCalledTimes(1);
    vi.mocked(f.query.rect).mockReturnValue({ x: 120, y: 200, w: 80, h: 20 });
    f.extension.beforeDraw!({ ...f.frame, seq: 3 });
    expect(f.overrides.scaleAbout).toHaveBeenCalledTimes(2);
    expect(f.overrides.scaleAbout).toHaveBeenLastCalledWith(1, factor, factor, 160, 210);
  });

  it.each(["full", "delta", "removed"] as const)("clears retired label ids after %s exactly once", (form) => {
    const f = fixture();
    f.extension.beforeDraw!(f.frame);
    if (form === "removed") f.extension.onItemsRemoved!(new Uint32Array([1]));
    else f.extension.onItemMeta!({ form, items: form === "full" ? [] : [{ ...meta(), path: "Unknown" }] });
    f.extension.beforeDraw!(f.frame);
    f.extension.beforeDraw!(f.frame);
    expect(f.overrides.clear).toHaveBeenCalledExactlyOnceWith(1);
    expect(debugWindow.__renderStreamTextScale!()).toEqual([]);
  });

  it("clears hidden/missing bounds and re-applies when visible again", () => {
    const f = fixture();
    f.extension.beforeDraw!(f.frame);
    vi.mocked(f.query.visible).mockReturnValue(false);
    f.extension.beforeDraw!({ ...f.frame, seq: 2 });
    expect(f.overrides.clear).toHaveBeenCalledExactlyOnceWith(1);
    vi.mocked(f.query.visible).mockReturnValue(true);
    vi.mocked(f.query.rect).mockReturnValue(null);
    f.extension.beforeDraw!({ ...f.frame, seq: 3 });
    expect(f.overrides.clear).toHaveBeenCalledTimes(1);
    vi.mocked(f.query.rect).mockReturnValue({ x: 100, y: 200, w: 80, h: 20 });
    f.extension.beforeDraw!({ ...f.frame, seq: 4 });
    expect(f.overrides.scaleAbout).toHaveBeenCalledTimes(2);
  });

  it("does nothing while off, clears only owned ids, and restores on enable without a transaction", () => {
    const f = fixture();
    const settings = createMirrorSettings(undefined, "", { storage: null });
    settings.uiScaling = false;
    const built = buildStreamExtensions({ settings, presentationWidth: 1920, interactive: true });
    disposals.push(() => built.extensions.forEach((e) => e.dispose?.()));
    const extension = built.extensions.find((e) => e.id === "couchcoop.textScale")!;
    extension.onSession!(f.session);
    extension.onItemMeta!({ form: "full", items: [meta()] });
    extension.beforeDraw!(f.frame);
    expect(f.overrides.scaleAbout).not.toHaveBeenCalled();
    for (const fn of Object.values(f.query)) expect(fn).not.toHaveBeenCalled();
    settings.uiScaling = true;
    extension.beforeDraw!(f.frame);
    expect(f.values.has(1)).toBe(true);
    f.values.set(999, { transform: [1, 0, 0, 1, 0, 0], visible: false, modulate: [1, 1, 1, 1], frozen: false });
    settings.uiScaling = false;
    Object.values(f.query).forEach((fn) => vi.mocked(fn).mockClear());
    extension.beforeDraw!(f.frame);
    extension.beforeDraw!({ ...f.frame, seq: 2 });
    expect([...f.values.keys()]).toEqual([999]);
    expect(debugWindow.__renderStreamTextScale!()).toEqual([]);
    for (const fn of Object.values(f.query)) expect(fn).not.toHaveBeenCalled();
    expect(f.overrides.clearAll).not.toHaveBeenCalled();
    settings.uiScaling = true;
    extension.beforeDraw!(f.frame);
    expect(f.overrides.scaleAbout).toHaveBeenCalledTimes(2);
  });

  it("removes only its own debug seam on dispose and resets cached labels on a new session", () => {
    const f = fixture();
    f.extension.beforeDraw!(f.frame);
    f.extension.onSession!(f.session);
    expect(debugWindow.__renderStreamTextScale!()).toEqual([]);
    const other = createTextScaleExtension();
    other.onSession!(f.session);
    const seam = debugWindow.__renderStreamTextScale;
    f.extension.dispose!();
    expect(debugWindow.__renderStreamTextScale).toBe(seam);
    other.dispose!();
    expect(debugWindow.__renderStreamTextScale).toBeUndefined();
  });
});
