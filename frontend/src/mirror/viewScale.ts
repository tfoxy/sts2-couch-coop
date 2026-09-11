// Web twin of native ViewScale.cs (#19 general view-scale table, extended by WS-G2 R4/R7/R9/R19/R20). Some interactive
// items read/tap too small on a phone at Half render scale — the post-combat reward list, the card-reward selection
// screen, the merchant carpet, the event option lists. This table enlarges them by a per-item factor about a per-entry
// ANCHOR (center / topCenter / bottomCenter), optionally translating the result, and optionally treating the entry as a
// whole-screen GROUP. Same Entry shape + first-match-wins as the native table, matched over
// (data-scene-file, data-scene-node-path) — the tuple mirrorRenderer's computeSceneInfo resolves.
//
// applyViewScalePass consumes resolveViewScale + computeAnchoredScaleStamp exactly as the native ViewScaler consumes
// ViewScale.ResolveFor + HoverTipScaleMath.ComputeAnchoredStamp — the SAME factors/anchors, so both clients enlarge the
// same items the same way. Enablement comes from the caller's readability setting; this stays pure. The INPUT side of view scale
// (the coordinate inverse that un-maps a pointer off an enlarged item's halo onto its true hit box, plus the
// wide-stage rendered-box guard) lives in `@/mirror/viewScaleInverse.ts` — fed by mirrorRenderer's
// buildViewScaleInputStamps and applied by inputCapture.applyViewScaleInverse. This module stays visual-only: it
// changes no DOM hit bounds, and nothing here reads the pointer.

import type { ScalePivot } from "@/mirror/hoverTipScaleMath";

// WS6: this is now the whole `Rewards` PANEL group factor (it used to be stamped per reward ROW). Same number, same
// name, so the native constant stays in lockstep.
export const VIEW_SCALE_REWARD_LIST = 1.2; // must match native ViewScale.RewardListScale
// R4-round4 card-reward NESTING (must match native): a gentle 1.10 whole-screen container GROUP about its centre,
// UNCLAMPED (noClamp), PLUS a per-card 1.15 about each card's own centre. Detected by NODE-TYPE leaf in the walk
// (the screen root + its NCard descendants), NOT the ENTRIES table — see mirrorRenderer's viewScale pre-filter.
export const VIEW_SCALE_CARD_REWARD_GROUP = 1.1; // must match native ViewScale.CardRewardGroupScale
export const VIEW_SCALE_CARD_REWARD_CARD = 1.15; // must match native ViewScale.CardRewardScale
// WS6: 1.2 → 1.1 (must match native ViewScale.MerchantGroupScale). At 1.2 the 1747×978 SlotsContainer measures
// 2096×1174 — wider AND taller than the 1920×1080 stage — so the carpet covered the whole screen and the shop ROOM
// background disappeared (it survived only as a sliver on the left, because the clamp pinned the over-wide box's left
// edge to 0 and threw the entire overflow off the right). At 1.1 the container is 1922×1076: it fits the stage height,
// and the rug ART (design x ≈ 229…1757, inset ~111px inside the container box) scales to ≈153…1833, leaving room
// visible on BOTH sides like the game.
export const VIEW_SCALE_MERCHANT_GROUP = 1.1;
export const VIEW_SCALE_EVENT_OPTIONS = 1.2; // must match native ViewScale.EventOptionsScale
// R8 (WS-1) — all four must match the native ViewScale constants of the same name.
export const VIEW_SCALE_MAP_POINT = 1.5; // NORMAL map points only (56 → 84 design px); ancient/boss unchanged
export const VIEW_SCALE_MAP_LEGEND = 1.2; // map_screen.tscn :: MapLegend, one rigid GROUP
export const VIEW_SCALE_PILE = 1.25; // combat draw / discard / (R9) exhaust pile buttons
export const VIEW_SCALE_TREASURE_RELIC = 1.25; // treasure-room relic HOLDER (co-op vote icons ride it)
// R9 (WS-B) — the "View Upgrades" toggle in the deck / card-detail dialogs: a ~196×48 checkbox row with a small
// tickbox, the hardest control to hit on those screens at phone size.
// R10 WS-F: the two dialogs carry DIFFERENT factors now (they shared one 1.25 constant) — the card-detail one grows UP
// from a bottom-CENTRED box into the empty band under the card and can take more than the deck's bottom-LEFT corner
// row. Both scaled boxes stay wholly inside the 1920×1080 stage, so the clamp remains a no-op for each.
// Must match native ViewScale.ViewUpgradesDeckScale / ViewUpgradesDetailScale.
export const VIEW_SCALE_VIEW_UPGRADES_DECK = 1.35;
export const VIEW_SCALE_VIEW_UPGRADES_DETAIL = 1.4;
// WS-3 — must match native ViewScale.DrawingToolsScale. The map screen's draw/erase/clear palette: a 208×68
// NinePatchRect at (56,972)-(264,1040) holding three ~60px buttons, the smallest tap row on the map. Scaled about its
// own CENTRE (160,1006) → (19.6,960.1)-(300.4,1051.9), still wholly on-stage.
export const VIEW_SCALE_DRAWING_TOOLS = 1.35;

// Node-type leaf of the card-reward selection screen root (drives the walk's inCardRewardScreen flag + the group/card
// leaf detection). Distinct from the scene FILE (which no longer keys a table entry / root-file pre-filter).
export const CARD_REWARD_SCREEN_LEAF = "NCardRewardSelectionScreen";

// R8: the treasure-room relic HOLDER node-type leaf (twin of native ViewScale.IsTreasureRoomRelic). Leaf-detected in
// the walk, NOT a table entry: the relic art + the co-op vote widget are instanced sub-scenes under the holder (which
// truncates scene-relative paths), and `multiplayer_vote_container.tscn` is REUSED by the MAP POINTS and the treasure
// room's own ProceedButton (live-verified against .sts2/bench/r8-treasure.ndjson),
// so a file-keyed rule would scale three unrelated screens. The vote icons are the holder's own children, so stamping
// the holder enlarges them for free. Same leaf the touch classifier keys on (TOUCH_TARGET_TYPES in mirrorRenderer).
export const TREASURE_RELIC_LEAF = "NTreasureRoomRelicHolder";

// R9 ancient-event dialogue lift (must match native): translateY = −(0.2·optionsHeight + margin), optionsHeight 292.
export const VIEW_SCALE_ANCIENT_OPTIONS_HEIGHT = 292;
export const VIEW_SCALE_ANCIENT_DIALOGUE_MARGIN = 12;
export const VIEW_SCALE_ANCIENT_DIALOGUE_TRANSLATE_Y = -(0.2 * VIEW_SCALE_ANCIENT_OPTIONS_HEIGHT + VIEW_SCALE_ANCIENT_DIALOGUE_MARGIN);

type Op = "exact" | "suffix" | "contains" | "prefix";

interface Cond {
  op: Op;
  value: string;
}

interface Entry {
  file?: Cond;
  path: Cond[];
  scale: number;
  isGroup?: boolean;
  pivot?: ScalePivot;
  translateX?: number;
  translateY?: number;
  noClamp?: boolean;
}

function matches(cond: Cond, s: string): boolean {
  switch (cond.op) {
    case "exact":
      return s === cond.value;
    case "suffix":
      return s.endsWith(cond.value);
    case "contains":
      return s.includes(cond.value);
    case "prefix":
      return s.startsWith(cond.value);
  }
}

const exact = (v: string): Cond => ({ op: "exact", value: v });
const suffix = (v: string): Cond => ({ op: "suffix", value: v });

// ---- res:// scene-file constants (shared with the native table's set) --------------------------------------------
// WS6: the post-combat REWARDS screen. The rewards panel is a plain child Control of the screen root
// (relPath "Rewards", 526×640 at (696,236) — measured from .sts2/bench/audit-rewards.ndjson), holding the
// Background / Banner / HeaderLabel / RewardContainerMask+RewardsContainer / Scrollbar. It replaces the old
// per-ROW reward_button.tscn entry, so the panel chrome and its rows enlarge as ONE unit (and a row parked
// below the scroll mask can no longer be clamped into view on its own).
const REWARDS_SCREEN = "res://scenes/screens/rewards_screen.tscn";
const MERCHANT_INVENTORY = "res://scenes/merchant/merchant_inventory.tscn";
const DEFAULT_EVENT_LAYOUT = "res://scenes/events/default_event_layout.tscn";
const COMBAT_EVENT_LAYOUT = "res://scenes/events/combat_event_layout.tscn";
const ANCIENT_EVENT_LAYOUT = "res://scenes/events/ancient_event_layout.tscn";
// R8: NORMAL map points are their own scene ROOT (56×56 NNormalMapPoint, verified from probe-map-visible.ndjson); the
// map legend is a plain child of the map SCREEN; the two combat piles are their own scene roots.
const NORMAL_MAP_POINT = "res://scenes/ui/normal_map_point.tscn";
const MAP_SCREEN = "res://scenes/screens/map/map_screen.tscn";
const DRAW_PILE = "res://scenes/combat/draw_pile.tscn";
const DISCARD_PILE = "res://scenes/combat/discard_pile.tscn";
// R9: the third combat pile — its own scene ROOT (NExhaustPileButton, 80×80 at (1830,800)-(1910,880), measured from
// the 16:40-09 combat recording). RIGHT-anchored but mid-height, so it takes the new "middleRight" EDGE pivot.
const EXHAUST_PILE = "res://scenes/combat/exhaust_pile.tscn";
// R9: the deck dialog — its "View Upgrades" toggle is a plain CHILD of the screen root (no sceneFilePath of its own),
// so the entry is scoped to this file and the child is pre-filtered by NAME (VIEW_SCALE_CANDIDATE_NAMES).
const DECK_VIEW_SCREEN = "res://scenes/screens/deck_view_screen.tscn";
// R9: the CARD-DETAIL popup. Same control, different name/shape: relPath "Upgrade", the NUpgradePreviewTickbox itself
// (mouseFilter STOP) rather than the deck's wrapping MarginContainer, centred at (816.5,990)-(1103.5,1054).
const INSPECT_CARD_SCREEN = "res://scenes/screens/inspect_card_screen.tscn";

// The scene-ROOT files that carry a view-scale rule at a ROOT node (own sceneFilePath) — a cheap pre-filter so the
// walk only resolves the full scene identity for candidate ROOT nodes (mirrors the native ViewScaler's SceneFilePath
// gate). Entries scoped to a NON-root child (SlotsContainer, OptionsContainer, DialogueContainer) lack a sceneFilePath,
// so they are pre-filtered by NODE NAME instead — see VIEW_SCALE_CANDIDATE_NAMES. R4-round4: the card-reward screen is
// NO LONGER a root-file entry — its group + per-card scaling is detected by NODE-TYPE leaf in the walk (asymmetric to
// native by design: native has a cheap SceneFilePath root gate + a full walk; the web resolves it via the leaf).
// R8 adds the three files whose ROOT node carries an entry (normal map point, draw pile, discard pile). Two files the
// NATIVE IsRootFile lists are deliberately ABSENT here, exactly like card_reward_selection_screen.tscn: native needs
// them only as a cheap scene-PRESENCE gate, while the web resolves those rules some other way, and a node matched by
// this set takes the table branch of the walk's if/else — which would SHADOW the branch that actually stamps it:
//   * map_screen.tscn        — its MapLegend and (WS-3) DrawingTools children are pre-filtered by NAME
//                              (VIEW_SCALE_CANDIDATE_NAMES) instead.
//   * treasure_relic_holder.tscn — the holder is detected by NODE-TYPE LEAF (TREASURE_RELIC_LEAF) instead.
//   * deck_view_screen.tscn / inspect_card_screen.tscn
//                            — R9: same shape as map_screen.tscn. Each screen ROOT carries no entry (native lists it
//                              only so its cheap presence gate fires while that dialog is open, which the web does
//                              not have); the View-Upgrades child is pre-filtered by NAME instead.
// R9 adds exhaust_pile.tscn, whose ROOT does carry an entry.
// WS6 REMOVES reward_button.tscn: the reward rows are no longer scaled per-row — the whole `Rewards` panel is one
// GROUP, and (map_screen precedent) rewards_screen.tscn is deliberately ABSENT here too, because its ROOT carries no
// entry and listing it would make the root take the table branch of the walk's if/else. The `Rewards` CHILD is
// pre-filtered by NAME instead (VIEW_SCALE_CANDIDATE_NAMES).
export const VIEW_SCALE_ROOT_FILES: ReadonlySet<string> = new Set([
  NORMAL_MAP_POINT,
  DRAW_PILE,
  DISCARD_PILE,
  EXHAUST_PILE
]);

// R19/R20 + R7/R9: NON-root container entries have no sceneFilePath, so the web pre-filters them by node NAME (the
// native side has the cheap SceneFilePath root gate + a full walk; the web needs this name set to avoid a full resolve
// on every combat node).
export const VIEW_SCALE_CANDIDATE_NAMES: ReadonlySet<string> = new Set([
  "SlotsContainer",
  "OptionsContainer",
  "DialogueContainer",
  // R8: map_screen.tscn :: MapLegend — a plain child of the map screen root, so it has no sceneFilePath of its own.
  "MapLegend",
  // R9: the deck / card-detail dialogs' "View Upgrades" toggle — likewise a plain child of its screen root, under a
  // different name in each dialog ("ViewUpgrades" in the deck view, "Upgrade" in the card detail). The name alone is
  // only a PRE-FILTER; the entries stay scoped to their own scene file, so a same-named node on any other screen
  // still resolves neutral. (Measured: exactly one node of each name exists in a full card-detail capture.)
  "ViewUpgrades",
  "Upgrade",
  // WS-3: map_screen.tscn :: DrawingTools — same shape as MapLegend (a plain child of the map screen root, so no
  // sceneFilePath of its own). The name is only a PRE-FILTER; the entry stays scoped to map_screen.tscn, so a
  // same-named node under any other scene still resolves neutral.
  "DrawingTools",
  // WS6: rewards_screen.tscn :: Rewards — the post-combat rewards PANEL, again a plain child of its screen root
  // (no sceneFilePath of its own). Same PRE-FILTER-only role: the entry stays scoped to rewards_screen.tscn.
  "Rewards"
]);

// Order = specificity (file-scoped entries first); first-match-wins. relPath "" matches a scene ROOT node.
const ENTRIES: readonly Entry[] = [
  // WS6 reward PANEL: rewards_screen.tscn :: Rewards — one 1.2× GROUP about its own CENTRE (replaces the old
  // per-ROW reward_button.tscn entry). Design box (696,236)-(1222,876) → scaled (643.4,172)-(1274.6,940), wholly
  // on-stage, so the clamp is a no-op. Scaling the panel (not each row) keeps the banner/header/scroll mask in
  // proportion with the rows and removes the per-row clamp, which used to drag a row parked below the scroll mask
  // back into view.
  { file: exact(REWARDS_SCREEN), path: [exact("Rewards")], scale: VIEW_SCALE_REWARD_LIST, isGroup: true, pivot: "center" },
  // R4-round4: the card-reward SELECTION screen is NOT a table entry any more — the group (screen root) + per-card
  // (NCard descendants) scaling is detected by node-type leaf in the walk (CARD_REWARD_*_RESOLVED below).
  // R19/R20 shop: SlotsContainer holds the rug texture AND every item — scale as one unit.
  // WS6 NoClamp: even at the reduced 1.1 the container is 1922×1076, so a PARTIALLY parked panel (the closed shop
  // sliding out) can still hit clampAxis' "min < 0 ⇒ push in" branch and be dragged wholly back on-stage — the P4
  // phantom lever. The scaled box is at most ~2px wider than the stage, so dropping the clamp costs nothing and keeps
  // the growth exactly symmetric about the container's own centre (same reasoning as the card-reward whole-screen
  // group).
  { file: exact(MERCHANT_INVENTORY), path: [exact("SlotsContainer")], scale: VIEW_SCALE_MERCHANT_GROUP, isGroup: true, noClamp: true },
  // R7 regular event: OptionsContainer grows DOWN from top (suffix-matched — layout nesting varies).
  { file: exact(DEFAULT_EVENT_LAYOUT), path: [suffix("OptionsContainer")], scale: VIEW_SCALE_EVENT_OPTIONS, isGroup: true, pivot: "topCenter" },
  // R6 combat event: combat_event_layout.tscn also grows its OptionsContainer DOWN from top — mirrors the regular
  // layout entry (verified from audit-event.ndjson: root → "VBoxContainer/OptionsContainer"; suffix-matched).
  { file: exact(COMBAT_EVENT_LAYOUT), path: [suffix("OptionsContainer")], scale: VIEW_SCALE_EVENT_OPTIONS, isGroup: true, pivot: "topCenter" },
  // R9 ancient event: OptionsContainer grows UP from bottom; dialogue above lifts up (pure translate, scale 1).
  // R19 WP-4 noClamp — SCALE ONLY, NEVER REPOSITION. While the dialogue plays, the game PARKS this container below
  // its `ContentContainer` and relies on that container's `clip_contents` to hide it (no `visible`, no `modulate`);
  // it then slides up on a position tween as the last line resolves. The parked box still overlaps y <= 1080, so
  // `boxFullyOutsideDesign` does not reject it, and `clampAxis`' "max > viewport ⇒ push in" branch then LIFTED the
  // whole block back on-stage — a worked case by 264 design px, straight on top of the dialogue. Same class as the
  // shop `SlotsContainer` P4-phantom lever above: a clamp that rescues a deliberately-parked group is a
  // reposition the game never made. The bottom-centre pivot already keeps the growth where the options rest, and
  // the clip (`clipContents` on the wire) is what hides them while they are parked.
  { file: exact(ANCIENT_EVENT_LAYOUT), path: [exact("ContentContainer/Content/OptionsContainer")], scale: VIEW_SCALE_EVENT_OPTIONS, isGroup: true, pivot: "bottomCenter", noClamp: true },
  { file: exact(ANCIENT_EVENT_LAYOUT), path: [exact("ContentContainer/Content/DialogueContainer")], scale: 1.0, isGroup: true, translateY: VIEW_SCALE_ANCIENT_DIALOGUE_TRANSLATE_Y },
  // R8 map NODE (normal points only — ancient/boss deliberately unscaled): the scene ROOT, 1.5× about its own centre,
  // UNCLAMPED because the map SCROLLS (a clamped point at the viewport edge would slide off its own path).
  { file: exact(NORMAL_MAP_POINT), path: [exact("")], scale: VIEW_SCALE_MAP_POINT, noClamp: true },
  // R8 map LEGEND: 1.2× GROUP pinned at its BOTTOM-RIGHT corner, UNCLAMPED. Its design box (1656,289)-(1996,743)
  // already runs 76px past the right edge by design, so a centre pivot would push more of it off (noClamp) or the
  // on-screen clamp would drag the whole panel ~110px left, detaching it from the edge the game anchored it to.
  { file: exact(MAP_SCREEN), path: [exact("MapLegend")], scale: VIEW_SCALE_MAP_LEGEND, isGroup: true, pivot: "bottomRight", noClamp: true },
  // WS-3 map DRAWING TOOLS: map_screen.tscn :: DrawingTools — a 1.35× GROUP about its own CENTRE, UNCLAMPED. Design
  // box (56,972)-(264,1040) (recovered map_screen.tscn: anchors_preset 2, offsets 56/-108/264/-40); its three interior
  // buttons ride the one stamp, so the group's interior IS the tap surface. The scaled box
  // (19.6,960.1)-(300.4,1051.9) is wholly on-stage, so noClamp costs nothing and keeps the growth exactly symmetric
  // about (160,1006) — including on a widened stage, where the panel renders ½Δ right of its design x (see the
  // mirrorRenderer DrawingTools centre claim).
  { file: exact(MAP_SCREEN), path: [exact("DrawingTools")], scale: VIEW_SCALE_DRAWING_TOOLS, isGroup: true, pivot: "center", noClamp: true },
  // R8 combat corner piles: 80×80 roots at (15,985) / (1826,985). Each grows INWARD from its own bottom corner so the
  // enlarged button stays glued to the corner the game placed it in.
  { file: exact(DRAW_PILE), path: [exact("")], scale: VIEW_SCALE_PILE, pivot: "bottomLeft" },
  { file: exact(DISCARD_PILE), path: [exact("")], scale: VIEW_SCALE_PILE, pivot: "bottomRight" },
  // R9 EXHAUST pile: right-anchored at (1830,800)-(1910,880) but NOT in a corner, so "middleRight" pins the right edge
  // at 1910 and splays the growth symmetrically up/down → (1810,790)-(1910,890). Deliberately NOT noClamp (unlike the
  // map legend): the scaled box is wholly inside the viewport, so the clamp is a no-op and stays as the backstop.
  { file: exact(EXHAUST_PILE), path: [exact("")], scale: VIEW_SCALE_PILE, pivot: "middleRight" },
  // R9 deck dialog "View Upgrades": a MarginContainer (mouseFilter PASS) at (16,1012)-(212.5,1060), a direct child of
  // the deck screen root (measured from .sts2/bench/wscrisp-deckdialog.ndjson). BottomLeft pins the corner the game
  // anchored it to, so the enlarged row grows right/up into the empty bottom-left margin. Per-item, not a group.
  // R10 WS-F 1.25 → 1.35: (16,1012)-(212.5,1060) becomes (16,995.2)-(281.3,1060) — still wholly on-stage.
  { file: exact(DECK_VIEW_SCREEN), path: [exact("ViewUpgrades")], scale: VIEW_SCALE_VIEW_UPGRADES_DECK, pivot: "bottomLeft" },
  // R9 card-detail popup "View Upgrades": (816.5,990)-(1103.5,1054), horizontally centred on the screen (centre x
  // 960), so BottomCenter keeps it centred under the card and grows it UP toward the card rather than off the bottom
  // edge. Measured live from .sts2/bench/r9-carddetail.ndjson.
  // R10 WS-F 1.25 → 1.40: (816.5,990)-(1103.5,1054) becomes (759.1,964.4)-(1160.9,1054) — still wholly on-stage.
  { file: exact(INSPECT_CARD_SCREEN), path: [exact("Upgrade")], scale: VIEW_SCALE_VIEW_UPGRADES_DETAIL, pivot: "bottomCenter" }
];

// The full resolution of a node's view-scale entry (twin of native ViewScale.Resolved).
export interface ViewScaleResolved {
  scale: number;
  isGroup: boolean;
  pivot: ScalePivot;
  translateX: number;
  translateY: number;
  // R4-round4: skip the on-screen clamp (a full-viewport container scaled >1 corner-pins under the clamp; a per-card
  // 1.15 wants an exact centre scale). The card-reward group + per-card entries set this, as do the map point / map
  // legend / drawing tools entries and (WS6) the shop SlotsContainer — every entry whose SCALED box either cannot fit
  // the stage or is anchored to an edge the clamp must not move.
  noClamp: boolean;
}

export const VIEW_SCALE_NEUTRAL: ViewScaleResolved = {
  scale: 1.0,
  isGroup: false,
  pivot: "center",
  translateX: 0,
  translateY: 0,
  noClamp: false
};

// R4-round4 leaf-detected card-reward resolves (NOT table entries — set by the walk from the node-type leaf +
// inCardRewardScreen ancestry flag). The GROUP scales the whole screen root 1.10 about centre, unclamped; the CARD
// scales each NCard 1.15 about its own centre, unclamped. Both must match the native ViewScale factors.
export const CARD_REWARD_GROUP_RESOLVED: ViewScaleResolved = {
  scale: VIEW_SCALE_CARD_REWARD_GROUP,
  isGroup: true,
  pivot: "center",
  translateX: 0,
  translateY: 0,
  noClamp: true
};

export const CARD_REWARD_CARD_RESOLVED: ViewScaleResolved = {
  scale: VIEW_SCALE_CARD_REWARD_CARD,
  isGroup: false,
  pivot: "center",
  translateX: 0,
  translateY: 0,
  noClamp: true
};

// R8 leaf-detected treasure relic (twin of the native ResolveFor fallback): 1.25× about the holder's BOTTOM centre, so
// the relic's feet stay on its pedestal while it grows upward; unclamped so the treasure room's edge relics don't slide.
export const TREASURE_RELIC_RESOLVED: ViewScaleResolved = {
  scale: VIEW_SCALE_TREASURE_RELIC,
  isGroup: false,
  pivot: "bottomCenter",
  translateX: 0,
  translateY: 0,
  noClamp: true
};

// A translate-only entry (scale 1) is still active — the ancient dialogue lift.
export function viewScaleActive(r: ViewScaleResolved): boolean {
  return r.scale > 1.0 || r.translateX !== 0 || r.translateY !== 0;
}

// Resolve a node's full view-scale entry (twin of native ViewScale.ResolveFor). Neutral = not view-scaled.
export function resolveViewScale(file: string | null, relPath: string | null): ViewScaleResolved {
  if (relPath == null) {
    return VIEW_SCALE_NEUTRAL;
  }
  for (const e of ENTRIES) {
    if (e.file && (file == null || !matches(e.file, file))) {
      continue;
    }
    if (e.path.every((pc) => matches(pc, relPath))) {
      return {
        scale: e.scale,
        isGroup: e.isGroup ?? false,
        pivot: e.pivot ?? "center",
        translateX: e.translateX ?? 0,
        translateY: e.translateY ?? 0,
        noClamp: e.noClamp ?? false
      };
    }
  }
  return VIEW_SCALE_NEUTRAL;
}

// The view-scale factor for a node's scene identity (scale-only convenience). First-match-wins.
export function viewScaleFor(file: string | null, relPath: string | null): number {
  return resolveViewScale(file, relPath).scale;
}
