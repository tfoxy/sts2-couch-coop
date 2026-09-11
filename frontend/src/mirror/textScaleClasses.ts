// R10-PERF4 WS-3 (item 4) — resolved-class text scaling.
//
// PROBLEM: the prior stylesheet targeted each label by (`data-scene-file`, `data-scene-node-path`) — ~54 rules, most
// of them SUFFIX (`$=`) or SUBSTRING (`*=`) attribute selectors. Those are the most expensive selector kind there
// is: the browser cannot bucket them by id/class/tag, so every rule is a candidate for every element, and each
// candidate costs a string suffix/substring scan of a long `res://scenes/...` path. A phone trace of a card play
// measured 94 style recalcs (UpdateLayoutTree 185ms) — and the scene has thousands of `.mirror-node` elements, so
// this sheet is re-evaluated against all of them on every one of those recalcs.
//
// FIX: the inputs are IMMUTABLE per element (scene file + scene-relative node path are stamped once at createEl and
// only ever re-stamped on adoption), so the match can be resolved ONCE in TS instead of on every recalc. Each node
// gets the `mirror-ts-*` class of every rule it matches, and the shipped sheet is keyed on those classes — which
// the browser DOES bucket, so a recalc considers a rule only for the handful of elements that carry its class.
//
// SINGLE SOURCE OF TRUTH: `TEXT_SCALE_RULES` below. The runtime stamping (`resolveTextScaleClasses`) and the
// generated stylesheet (`buildTextScaleClassCss`) are both derived from it, so they cannot drift from each other.
//
// CASCADE FIDELITY: an element can match more than one rule (the generic `HpBarContainer/HpLabel` suffix and the
// 3-attribute multiplayer-HUD override both hit the MP health bar). Multi-class stamping reproduces that exactly,
// PROVIDED the generated rules are emitted in the browser's own resolution order — so `buildTextScaleClassCss`
// sorts by (attribute-selector specificity ASC, table order ASC). A single class is (0,1,0), so a rule emitted
// later wins the tie, which is precisely what a higher-specificity attribute selector did before.

import { uiScalingEnabled } from "@/mirror/uiScaling";

export type TextScaleOp = "=" | "$=" | "*=" | "^=";

export interface TextScaleMatcher {
  op: TextScaleOp;
  value: string;
}

export interface TextScaleRule {
  /** Class suffix — the element carries `mirror-ts-<key>`. Unique across the table. */
  key: string;
  /** `data-scene-file` matcher (absent = any scene file). */
  sceneFile?: TextScaleMatcher;
  /** `data-scene-node-path` matchers — ALL must hold (absent = any path). */
  nodePath?: TextScaleMatcher[];
  /** Declarations applied to the node element itself. */
  self?: Record<string, string>;
  /** Declarations applied to the node's `> .mirror-text` child. */
  text?: Record<string, string>;
}

const S = "--godot-text-scale";

// Source order is load-bearing — see the cascade note above.
export const TEXT_SCALE_RULES: readonly TextScaleRule[] = [
  // ui/hover_tip.tscn
  {
    key: "hovertip-title",
    sceneFile: { op: "=", value: "res://scenes/ui/hover_tip.tscn" },
    nodePath: [{ op: "=", value: "TextContainer/VBoxContainer/HBoxContainer/Title" }],
    self: { [S]: "1.08" },
    text: { "white-space": "pre" }
  },
  {
    key: "hovertip-description",
    sceneFile: { op: "=", value: "res://scenes/ui/hover_tip.tscn" },
    nodePath: [{ op: "=", value: "TextContainer/VBoxContainer/Description" }],
    self: { [S]: "1.08" }
  },
  // card.tscn (a reusable component — matched by its stable INTERNAL path suffix, in every owning scene)
  {
    key: "card-description",
    nodePath: [{ op: "$=", value: "CardContainer/DescriptionLabel" }],
    self: { "--godot-rich-line-height": "calc(0.88em + 1px)", "--godot-rich-paragraph-spacing": "0.14em" },
    text: { transform: "scale(1.24)", "transform-origin": "50% 50%" }
  },
  {
    key: "card-title",
    nodePath: [{ op: "$=", value: "CardContainer/TitleLabel" }],
    self: { [S]: "1.14" },
    text: { "white-space": "pre" }
  },
  {
    key: "card-type",
    nodePath: [{ op: "$=", value: "CardContainer/TypePlaque/TypeLabel" }],
    text: { transform: "scale(1.24)", "transform-origin": "50% 50%" }
  },
  { key: "card-energy", nodePath: [{ op: "$=", value: "CardContainer/EnergyIcon/EnergyLabel" }], self: { [S]: "1.24" } },
  { key: "card-star", nodePath: [{ op: "$=", value: "CardContainer/StarIcon/StarLabel" }], self: { [S]: "1.24" } },
  { key: "card-enchantment", nodePath: [{ op: "$=", value: "CardContainer/Enchantment/Label" }], self: { [S]: "1.24" } },
  // ui/top_bar.tscn
  {
    key: "topbar-hp",
    sceneFile: { op: "=", value: "res://scenes/ui/top_bar.tscn" },
    nodePath: [{ op: "=", value: "LeftAlignedStuff/TopBarHp/HpLabel" }],
    self: { [S]: "1.20" }
  },
  {
    key: "topbar-gold",
    sceneFile: { op: "=", value: "res://scenes/ui/top_bar.tscn" },
    nodePath: [{ op: "=", value: "LeftAlignedStuff/TopBarGold/GoldLabel" }],
    self: { [S]: "1.20" }
  },
  {
    key: "topbar-floor",
    sceneFile: { op: "=", value: "res://scenes/ui/top_bar.tscn" },
    nodePath: [{ op: "=", value: "LeftAlignedStuff/RoomIcons/FloorIcon/FloorNumLabel" }],
    self: { [S]: "1.12" }
  },
  {
    key: "topbar-timer",
    sceneFile: { op: "=", value: "res://scenes/ui/top_bar.tscn" },
    nodePath: [{ op: "=", value: "RightAlignedStuff/TimerContainer/TimerLabel" }],
    self: { [S]: "1.08" }
  },
  {
    key: "topbar-deck-count",
    sceneFile: { op: "=", value: "res://scenes/ui/top_bar/top_bar_deck_button.tscn" },
    nodePath: [{ op: "=", value: "DeckCardCount" }],
    self: { [S]: "1.24" }
  },
  // Combat HUD
  {
    key: "energy-counter",
    sceneFile: { op: "$=", value: "_energy_counter.tscn" },
    nodePath: [{ op: "=", value: "Label" }],
    self: { [S]: "1.24" }
  },
  {
    key: "end-turn",
    sceneFile: { op: "=", value: "res://scenes/combat/end_turn_button.tscn" },
    nodePath: [{ op: "=", value: "Visuals/Label" }],
    self: { [S]: "1.54", "text-align": "center" },
    text: {
      "font-size": "min(calc(var(--godot-font-px, 0px) * var(--godot-text-scale, 1)), 34px) !important",
      "white-space": "normal",
      "line-height": "calc(0.79em + 1px)"
    }
  },
  {
    key: "star-counter",
    sceneFile: { op: "=", value: "res://scenes/combat/energy_counters/star_counter.tscn" },
    nodePath: [{ op: "=", value: "MarginContainer/CountLabel" }],
    self: { [S]: "1.24" }
  },
  {
    key: "draw-pile",
    sceneFile: { op: "=", value: "res://scenes/combat/draw_pile.tscn" },
    nodePath: [{ op: "=", value: "CountContainer/Count" }],
    self: { [S]: "1.16" }
  },
  {
    key: "discard-pile",
    sceneFile: { op: "=", value: "res://scenes/combat/discard_pile.tscn" },
    nodePath: [{ op: "=", value: "CountContainer/Count" }],
    self: { [S]: "1.16" }
  },
  {
    key: "exhaust-pile",
    sceneFile: { op: "=", value: "res://scenes/combat/exhaust_pile.tscn" },
    nodePath: [{ op: "=", value: "CountContainer/Count" }],
    self: { [S]: "1.16" }
  },
  {
    key: "intent-value",
    sceneFile: { op: "=", value: "res://scenes/combat/intent.tscn" },
    nodePath: [{ op: "=", value: "IntentHolder/Value" }],
    self: { [S]: "1.32" }
  },
  // Health-bar HP/Block labels (reusable component — suffix-matched so it covers every host scene)
  { key: "healthbar-hp", nodePath: [{ op: "$=", value: "HpBarContainer/HpLabel" }], self: { [S]: "1.42" } },
  { key: "healthbar-block", nodePath: [{ op: "$=", value: "BlockContainer/BlockLabel" }], self: { [S]: "1.42" } },
  {
    key: "power-amount",
    sceneFile: { op: "=", value: "res://scenes/combat/power.tscn" },
    nodePath: [{ op: "=", value: "AmountLabel" }],
    self: { [S]: "1.48" }
  },
  {
    key: "relic-amount",
    sceneFile: { op: "=", value: "res://scenes/relics/relic.tscn" },
    nodePath: [{ op: "=", value: "AmountLabel" }],
    self: { [S]: "1.48" }
  },
  {
    key: "orb-passive-amount",
    sceneFile: { op: "=", value: "res://scenes/orbs/orb.tscn" },
    nodePath: [{ op: "=", value: "LabelContainer/PassiveAmount" }],
    self: { [S]: "1.48" }
  },
  {
    key: "orb-evoke-amount",
    sceneFile: { op: "=", value: "res://scenes/orbs/orb.tscn" },
    nodePath: [{ op: "=", value: "LabelContainer/EvokeAmount" }],
    self: { [S]: "1.48" }
  },
  // Multiplayer player-state widgets (run.tscn-scoped originals — 3 attribute selectors, so they OVERRIDE the
  // generic health-bar suffix rules above; the emitted order below reproduces that).
  {
    key: "mp-run-nameplate",
    sceneFile: { op: "=", value: "res://scenes/run.tscn" },
    nodePath: [
      { op: "*=", value: "MultiplayerPlayerContainer/" },
      { op: "$=", value: "TopInfoContainer/NameplateLabel" }
    ],
    self: { [S]: "1.08" }
  },
  {
    key: "mp-run-energy",
    sceneFile: { op: "=", value: "res://scenes/run.tscn" },
    nodePath: [
      { op: "*=", value: "MultiplayerPlayerContainer/" },
      { op: "$=", value: "TopInfoContainer/EnergyCountContainer/EnergyCount" }
    ],
    self: { [S]: "1.40" }
  },
  {
    key: "mp-run-star",
    sceneFile: { op: "=", value: "res://scenes/run.tscn" },
    nodePath: [
      { op: "*=", value: "MultiplayerPlayerContainer/" },
      { op: "$=", value: "TopInfoContainer/StarCountContainer/StarCount" }
    ],
    self: { [S]: "1.40" }
  },
  {
    key: "mp-run-card",
    sceneFile: { op: "=", value: "res://scenes/run.tscn" },
    nodePath: [
      { op: "*=", value: "MultiplayerPlayerContainer/" },
      { op: "$=", value: "TopInfoContainer/CardCountContainer/CardCount" }
    ],
    self: { [S]: "1.40" }
  },
  {
    key: "mp-run-hp",
    sceneFile: { op: "=", value: "res://scenes/run.tscn" },
    nodePath: [
      { op: "*=", value: "MultiplayerPlayerContainer/" },
      { op: "$=", value: "HealthBar/HpBarContainer/HpLabel" }
    ],
    self: { [S]: "1.32" }
  },
  {
    key: "mp-run-block",
    sceneFile: { op: "=", value: "res://scenes/run.tscn" },
    nodePath: [
      { op: "*=", value: "MultiplayerPlayerContainer/" },
      { op: "$=", value: "HealthBar/BlockContainer/BlockLabel" }
    ],
    self: { [S]: "1.40" }
  },
  // LIVE-VERIFY candidates (v0.107.1 scene promotion)
  {
    key: "mp-state-nameplate",
    sceneFile: { op: "=", value: "res://scenes/ui/multiplayer_player_state.tscn" },
    nodePath: [{ op: "=", value: "TopInfoContainer/NameplateLabel" }],
    self: { [S]: "1.08" }
  },
  {
    key: "mp-state-energy",
    sceneFile: { op: "=", value: "res://scenes/ui/multiplayer_player_state.tscn" },
    nodePath: [{ op: "=", value: "TopInfoContainer/EnergyCountContainer/EnergyCount" }],
    self: { [S]: "1.40" }
  },
  {
    key: "mp-state-star",
    sceneFile: { op: "=", value: "res://scenes/ui/multiplayer_player_state.tscn" },
    nodePath: [{ op: "=", value: "TopInfoContainer/StarCountContainer/StarCount" }],
    self: { [S]: "1.40" }
  },
  {
    key: "mp-state-card",
    sceneFile: { op: "=", value: "res://scenes/ui/multiplayer_player_state.tscn" },
    nodePath: [{ op: "=", value: "TopInfoContainer/CardCountContainer/CardCount" }],
    self: { [S]: "1.40" }
  },
  // Event option buttons
  {
    key: "event-ancient-option",
    sceneFile: { op: "=", value: "res://scenes/events/ancient_event_layout.tscn" },
    nodePath: [
      { op: "*=", value: "OptionsContainer/" },
      { op: "$=", value: "/Text" }
    ],
    self: { [S]: "1.12" }
  },
  {
    key: "event-default-option",
    sceneFile: { op: "=", value: "res://scenes/events/default_event_layout.tscn" },
    nodePath: [
      { op: "*=", value: "OptionsContainer/" },
      { op: "$=", value: "/Text" }
    ],
    self: { [S]: "1.12" }
  },
  {
    key: "event-ancient-option-scene",
    sceneFile: { op: "=", value: "res://scenes/events/ancient_event_option_button.tscn" },
    nodePath: [{ op: "=", value: "HBoxContainer/Text" }],
    self: { [S]: "1.12" }
  },
  {
    key: "event-option-scene",
    sceneFile: { op: "=", value: "res://scenes/events/event_option_button.tscn" },
    nodePath: [{ op: "=", value: "Text" }],
    self: { [S]: "1.12" }
  },
  // Rest-site choice buttons
  {
    key: "rest-choice",
    sceneFile: { op: "=", value: "res://scenes/rooms/rest_site_room.tscn" },
    nodePath: [
      { op: "^=", value: "ChoicesScreen/ChoicesContainer/" },
      { op: "$=", value: "/Label" }
    ],
    self: { [S]: "1.16" }
  },
  {
    key: "rest-choice-scene",
    sceneFile: { op: "=", value: "res://scenes/rest_site/rest_site_button.tscn" },
    nodePath: [{ op: "=", value: "Label" }],
    self: { [S]: "1.16" }
  },
  {
    key: "rest-description",
    sceneFile: { op: "=", value: "res://scenes/rooms/rest_site_room.tscn" },
    nodePath: [{ op: "=", value: "ChoicesScreen/Description" }],
    self: { [S]: "1.20" }
  },
  {
    key: "proceed-label",
    sceneFile: { op: "=", value: "res://scenes/ui/proceed_button.tscn" },
    nodePath: [{ op: "=", value: "Image/Label" }],
    self: { [S]: "1.08" }
  },
  // Merchant item costs
  {
    key: "merchant-inventory-cost",
    sceneFile: { op: "=", value: "res://scenes/merchant/merchant_inventory.tscn" },
    nodePath: [{ op: "$=", value: "Cost/CostLabel" }],
    self: { [S]: "1.20" }
  },
  {
    key: "merchant-card-cost",
    sceneFile: { op: "=", value: "res://scenes/merchant/merchant_card.tscn" },
    nodePath: [{ op: "=", value: "Cost/CostLabel" }],
    self: { [S]: "1.20" }
  },
  {
    key: "merchant-potion-cost",
    sceneFile: { op: "=", value: "res://scenes/merchant/merchant_potion.tscn" },
    nodePath: [{ op: "=", value: "Cost/CostLabel" }],
    self: { [S]: "1.20" }
  },
  {
    key: "merchant-relic-cost",
    sceneFile: { op: "=", value: "res://scenes/merchant/merchant_relic.tscn" },
    nodePath: [{ op: "=", value: "Cost/CostLabel" }],
    self: { [S]: "1.20" }
  },
  {
    key: "merchant-removal-cost",
    sceneFile: { op: "=", value: "res://scenes/merchant/merchant_card_removal.tscn" },
    nodePath: [{ op: "=", value: "Cost/CostLabel" }],
    self: { [S]: "1.20" }
  },
  // Reward rows
  {
    key: "rewards-screen-label",
    sceneFile: { op: "=", value: "res://scenes/screens/rewards_screen.tscn" },
    nodePath: [{ op: "$=", value: "LabelContainer/Label" }],
    self: { [S]: "1.32", "text-align": "center", "text-wrap": "balance", "padding-right": "10%" }
  },
  {
    key: "reward-button-label",
    sceneFile: { op: "=", value: "res://scenes/rewards/reward_button.tscn" },
    nodePath: [{ op: "=", value: "LabelContainer/Label" }],
    self: { [S]: "1.32", "text-align": "center", "text-wrap": "balance", "padding-right": "10%" }
  }
];

/** The BASE RESET: every `.mirror-node` starts neutral so a bumped ancestor's inheriting
 *  custom property can't double-scale a descendant label. MUST stay first in the emitted sheet. */
export const TEXT_SCALE_BASE_RESET = `.mirror-node { ${S}: 1; }`;

export const TEXT_SCALE_CLASS_PREFIX = "mirror-ts-";

function matches(m: TextScaleMatcher, value: string): boolean {
  switch (m.op) {
    case "=":
      return value === m.value;
    case "$=":
      return value.endsWith(m.value);
    case "*=":
      return value.includes(m.value);
    case "^=":
      return value.startsWith(m.value);
  }
}

function ruleMatches(rule: TextScaleRule, sceneFile: string | null, nodePath: string | null): boolean {
  if (rule.sceneFile) {
    if (sceneFile == null || !matches(rule.sceneFile, sceneFile)) {
      return false;
    }
  }
  if (rule.nodePath) {
    if (nodePath == null) {
      return false;
    }
    for (const m of rule.nodePath) {
      if (!matches(m, nodePath)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Every `mirror-ts-*` class a node with this (scene file, scene-relative node path) pair must carry. Resolved ONCE
 * per element (createEl / adoptRecord), never per style recalc. Returns the shared empty array for the ~99% of
 * nodes that match nothing, so the common case allocates nothing.
 */
const NO_CLASSES: readonly string[] = [];
export function resolveTextScaleClasses(sceneFile: string | null, nodePath: string | null): readonly string[] {
  let out: string[] | null = null;
  for (const rule of TEXT_SCALE_RULES) {
    if (ruleMatches(rule, sceneFile, nodePath)) {
      (out ??= []).push(TEXT_SCALE_CLASS_PREFIX + rule.key);
    }
  }
  return out ?? NO_CLASSES;
}

/** CSS specificity of the rule's ATTRIBUTE selector form — one (0,1,0) per attribute selector. This is what decides
 *  which of two matching rules wins today, and therefore the order the generated class rules must be emitted in. */
export function ruleSpecificity(rule: TextScaleRule): number {
  return (rule.sceneFile ? 1 : 0) + (rule.nodePath?.length ?? 0);
}

/** The resolved declarations for one node — `self` on the node element, `text` on its `> .mirror-text` child. */
export interface TextScaleDecls {
  self: Readonly<Record<string, string>>;
  text: Readonly<Record<string, string>>;
}

const NO_DECLS: TextScaleDecls = { self: {}, text: {} };

/** "This node scales nothing" — the shared empty pair, also what a switched-off consumer substitutes. */
export const EMPTY_TEXT_SCALE_DECLS: TextScaleDecls = NO_DECLS;

/**
 * THE CASCADE RESULT for one node, as values instead of as CSS — what the canvas text path reads (M4).
 *
 * The DOM backend gets these declarations applied by the browser: it stamps `mirror-ts-*` classes and the
 * generated sheet does the rest. A canvas rasterizer has no stylesheet and no element, so it has to resolve the
 * same table itself — and the ONE thing it must not do is re-list which rules matter to it. The table stays the
 * single source of truth (`buildTextScaleClassCss` and `resolveTextScaleClasses` are the other two readers) and
 * this returns whatever it holds, merged.
 *
 * MERGED IN THE BROWSER'S OWN ORDER, which is the whole correctness claim: (specificity ASC, table order ASC),
 * later wins — exactly the order `buildTextScaleClassCss` emits its single-class rules in, and therefore exactly
 * what the cascade does with them. A node matching both the generic `HpBarContainer/HpLabel` suffix and the
 * 3-attribute multiplayer override resolves to the override on both backends or on neither.
 *
 * Returns a shared empty pair for the ~99% of nodes that match nothing, so the common case allocates nothing.
 */
export function resolveTextScaleDecls(sceneFile: string | null, nodePath: string | null): TextScaleDecls {
  let matched: TextScaleRule[] | null = null;
  for (const rule of TEXT_SCALE_RULES) {
    if (ruleMatches(rule, sceneFile, nodePath)) {
      (matched ??= []).push(rule);
    }
  }
  if (matched === null) {
    return NO_DECLS;
  }
  if (matched.length > 1) {
    // Only when there IS a contest. `TEXT_SCALE_RULES` order is the tiebreak, so the sort has to be stable on it —
    // which `Array.prototype.sort` is, and the matched array is already in table order.
    matched.sort((a, b) => ruleSpecificity(a) - ruleSpecificity(b));
  }
  const self: Record<string, string> = {};
  const text: Record<string, string> = {};
  for (const rule of matched) {
    if (rule.self) Object.assign(self, rule.self);
    if (rule.text) Object.assign(text, rule.text);
  }
  return { self, text };
}

function declBlock(decls: Record<string, string>): string {
  return Object.entries(decls)
    .map(([prop, value]) => `${prop}: ${value};`)
    .join(" ");
}

/**
 * The class-keyed stylesheet, generated from the table. Rules are emitted in (specificity ASC, table order ASC)
 * order: every generated selector is a single class (0,1,0), so "later wins" reproduces exactly what the attribute
 * sheet's higher-specificity overrides did. The `> .mirror-text` companions are emitted alongside their owner (they
 * only ever compete with each other, so the same ordering holds for them).
 */
export function buildTextScaleClassCss(): string {
  const ordered = TEXT_SCALE_RULES.map((rule, index) => ({ rule, index })).sort(
    (a, b) => ruleSpecificity(a.rule) - ruleSpecificity(b.rule) || a.index - b.index
  );
  const lines: string[] = [TEXT_SCALE_BASE_RESET];
  for (const { rule } of ordered) {
    const sel = `.${TEXT_SCALE_CLASS_PREFIX}${rule.key}`;
    if (rule.self) {
      lines.push(`${sel} { ${declBlock(rule.self)} }`);
    }
    if (rule.text) {
      lines.push(`${sel} > .mirror-text { ${declBlock(rule.text)} }`);
    }
  }
  return lines.join("\n");
}

export const TEXT_SCALE_STYLE_ID = "mirror-text-scale";

// THE TEXT HALF OF THE READABILITY-SCALING MASTER SWITCH (`mirrorSettings.uiScaling` / `?uiScale=off`). Two
// consumers use the same product setting because the two backends deliver this table differently:
//
//   * DOM — the generated sheet is ONE `<style id=mirror-text-scale>`, so the switch simply `disabled`s it. That
//     is why the `mirror-ts-*` classes stay stamped on the elements: with no rules to match they are inert, and
//     re-enabling is instant and total (no re-walk, no re-stamp — an element's classes are resolved once at
//     createEl and could not be revisited cheaply anyway).
//   * CANVAS — a rasterizer has no stylesheet, so its `resolveTextScaleDecls` consumer asks `textScaleEnabled()`
//     and lays the label out at the game's own px. It needs a rebuild to be seen, which MirrorView forces.
//
/** Is the per-label text-scale table in force? */
export function textScaleEnabled(): boolean {
  return uiScalingEnabled();
}

/**
 * Point the installed sheet at the current answer — the DOM half of the switch, called by the renderer's
 * `setUiScaling` right after it moves the master flag. No-op before installation.
 */
export function syncTextScaleSheet(): void {
  if (typeof document === "undefined") {
    return;
  }
  const style = document.getElementById(TEXT_SCALE_STYLE_ID);
  if (style instanceof HTMLStyleElement) {
    style.disabled = !textScaleEnabled();
  }
}

let installed = false;

/**
 * Install the generated class-keyed text-scale sheet. Idempotent.
 */
export function installTextScaleSheet(): void {
  if (installed || typeof document === "undefined") {
    return;
  }
  installed = true;
  const style = document.createElement("style");
  style.id = TEXT_SCALE_STYLE_ID;
  style.textContent = buildTextScaleClassCss();
  // Installed either way, `disabled` when the switch is off: the sheet is what the switch flips, so it has to
  // exist before the first flip (and a page that loads with the switch off must not paint one scaled frame).
  style.disabled = !textScaleEnabled();
  document.head.appendChild(style);
}

export function __resetTextScaleSheetForTest(): void {
  installed = false;
  document.getElementById(TEXT_SCALE_STYLE_ID)?.remove();
}
