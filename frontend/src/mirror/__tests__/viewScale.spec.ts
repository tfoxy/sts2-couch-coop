import { describe, expect, it } from "vitest";

import {
  computeAnchoredScaleStamp,
  computeCenterScaleStamp,
  resolveTipOwnerKind,
  type TipAabb
} from "@/mirror/hoverTipScaleMath";
import {
  CARD_REWARD_CARD_RESOLVED,
  CARD_REWARD_GROUP_RESOLVED,
  resolveViewScale,
  VIEW_SCALE_ANCIENT_DIALOGUE_TRANSLATE_Y,
  VIEW_SCALE_CARD_REWARD_CARD,
  VIEW_SCALE_CARD_REWARD_GROUP,
  VIEW_SCALE_EVENT_OPTIONS,
  VIEW_SCALE_MERCHANT_GROUP,
  VIEW_SCALE_REWARD_LIST,
  VIEW_SCALE_CANDIDATE_NAMES,
  VIEW_SCALE_DRAWING_TOOLS,
  VIEW_SCALE_MAP_LEGEND,
  VIEW_SCALE_MAP_POINT,
  VIEW_SCALE_PILE,
  VIEW_SCALE_ROOT_FILES,
  VIEW_SCALE_TREASURE_RELIC,
  VIEW_SCALE_VIEW_UPGRADES_DECK,
  VIEW_SCALE_VIEW_UPGRADES_DETAIL,
  TREASURE_RELIC_LEAF,
  TREASURE_RELIC_RESOLVED,
  viewScaleActive,
  viewScaleFor
} from "@/mirror/viewScale";

// Twin of the native ViewScaleTests / OwnerKindResolution: the same scene-file table + factors + anchors + owner-kind
// mapping + clamp math, so both clients enlarge the same items the same way and grow tips the same way.

describe("resolveViewScale — view-scale table (WS-G2)", () => {
  it("WS6: the rewards PANEL (rewards_screen.tscn :: Rewards) is the reward-list GROUP; the per-ROW entry is gone", () => {
    const r = resolveViewScale("res://scenes/screens/rewards_screen.tscn", "Rewards");
    expect(r.scale).toBe(VIEW_SCALE_REWARD_LIST);
    expect(r.isGroup).toBe(true);
    expect(r.pivot).toBe("center");
    // Design box (696,236)-(1222,876) → scaled (643.4,172)-(1274.6,940): wholly on-stage, so the clamp is a no-op
    // and the entry keeps it (unlike the shop group, whose scaled box cannot fit the stage).
    expect(r.noClamp).toBe(false);
    expect(959 + 1.2 * (696 - 959)).toBeCloseTo(643.4, 6);
    expect(556 + 1.2 * (876 - 556)).toBeCloseTo(940, 6);

    // The screen ROOT itself resolves neutral (the child carries the entry) and is NOT a web root file — listing it
    // would make the root take the table branch of the walk and shadow the name-pre-filtered child.
    expect(viewScaleFor("res://scenes/screens/rewards_screen.tscn", "")).toBe(1.0);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/screens/rewards_screen.tscn")).toBe(false);
    expect(VIEW_SCALE_CANDIDATE_NAMES.has("Rewards")).toBe(true);

    // The old per-ROW reward_button.tscn entry is gone — a row now rides the panel's group stamp.
    expect(viewScaleFor("res://scenes/rewards/reward_button.tscn", "")).toBe(1.0);
    expect(viewScaleFor("res://scenes/rewards/reward_button.tscn", "LabelContainer/Label")).toBe(1.0);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/rewards/reward_button.tscn")).toBe(false);
  });

  it("R4-round4: the card-reward screen is NO LONGER a table entry / root file (leaf-detected in the walk)", () => {
    // The screen root no longer resolves a table scale (its group + per-card are detected by node-type leaf).
    const r = resolveViewScale("res://scenes/screens/card_selection/card_reward_selection_screen.tscn", "");
    expect(r.scale).toBe(1.0);
    expect(viewScaleActive(r)).toBe(false);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/screens/card_selection/card_reward_selection_screen.tscn")).toBe(false);
  });

  it("R4-round4: leaf-detected resolves — group 1.10 Center NoClamp, per-card 1.15 Center NoClamp", () => {
    expect(CARD_REWARD_GROUP_RESOLVED.scale).toBe(VIEW_SCALE_CARD_REWARD_GROUP);
    expect(VIEW_SCALE_CARD_REWARD_GROUP).toBeCloseTo(1.1, 6);
    expect(CARD_REWARD_GROUP_RESOLVED.isGroup).toBe(true);
    expect(CARD_REWARD_GROUP_RESOLVED.pivot).toBe("center");
    expect(CARD_REWARD_GROUP_RESOLVED.noClamp).toBe(true);

    expect(CARD_REWARD_CARD_RESOLVED.scale).toBe(VIEW_SCALE_CARD_REWARD_CARD);
    expect(VIEW_SCALE_CARD_REWARD_CARD).toBeCloseTo(1.15, 6);
    expect(CARD_REWARD_CARD_RESOLVED.isGroup).toBe(false);
    expect(CARD_REWARD_CARD_RESOLVED.pivot).toBe("center");
    expect(CARD_REWARD_CARD_RESOLVED.noClamp).toBe(true);
  });

  it("scales the shop SlotsContainer (rug + items) as one 1.20 group; merchant item roots are neutral", () => {
    const r = resolveViewScale("res://scenes/merchant/merchant_inventory.tscn", "SlotsContainer");
    expect(r.scale).toBe(VIEW_SCALE_MERCHANT_GROUP);
    expect(r.isGroup).toBe(true);
    // WS6: 1747×978 at 1.2 is 2096×1174 — larger than the 1920×1080 stage on BOTH axes, so clampAxis' "bigger than
    // the viewport ⇒ pin the min edge to 0" branch always fires. It could only crop the whole overflow off one side,
    // and it was the lever that dragged a CLOSING panel back on-stage off a stale measure. UNCLAMPED instead.
    expect(r.noClamp).toBe(true);
    expect(viewScaleFor("res://scenes/merchant/merchant_inventory.tscn", "")).toBe(1.0);
    for (const file of [
      "res://scenes/merchant/merchant_card.tscn",
      "res://scenes/merchant/merchant_potion.tscn",
      "res://scenes/merchant/merchant_relic.tscn",
      "res://scenes/merchant/merchant_card_removal.tscn"
    ]) {
      expect(viewScaleFor(file, "")).toBe(1.0);
    }
  });

  it("scales regular-event options DOWN from top and ancient options UP from bottom; ancient dialogue lifts up", () => {
    const reg = resolveViewScale("res://scenes/events/default_event_layout.tscn", "VBoxContainer/OptionsContainer");
    expect(reg.scale).toBe(VIEW_SCALE_EVENT_OPTIONS);
    expect(reg.isGroup).toBe(true);
    expect(reg.pivot).toBe("topCenter");

    const anc = resolveViewScale("res://scenes/events/ancient_event_layout.tscn", "ContentContainer/Content/OptionsContainer");
    expect(anc.scale).toBe(VIEW_SCALE_EVENT_OPTIONS);
    expect(anc.pivot).toBe("bottomCenter");

    const dlg = resolveViewScale("res://scenes/events/ancient_event_layout.tscn", "ContentContainer/Content/DialogueContainer");
    expect(dlg.scale).toBe(1.0);
    expect(dlg.translateY).toBeCloseTo(VIEW_SCALE_ANCIENT_DIALOGUE_TRANSLATE_Y, 6);
    expect(dlg.translateY).toBeLessThan(0);
    expect(viewScaleActive(dlg)).toBe(true); // translate-only is active even at scale 1
  });

  it("R6: scales combat-event options DOWN from top, same shape as the regular layout", () => {
    // combat_event_layout.tscn root → "VBoxContainer/OptionsContainer" (verified from audit-event.ndjson) — suffix-matched.
    const cmb = resolveViewScale("res://scenes/events/combat_event_layout.tscn", "VBoxContainer/OptionsContainer");
    expect(cmb.scale).toBe(VIEW_SCALE_EVENT_OPTIONS);
    expect(cmb.isGroup).toBe(true);
    expect(cmb.pivot).toBe("topCenter");
  });

  it("is neutral for a hand card, end-turn, and non-scene nodes", () => {
    expect(viewScaleFor("res://scenes/cards/card.tscn", "CardContainer/DescriptionLabel")).toBe(1.0);
    expect(viewScaleFor("res://scenes/combat/end_turn_button.tscn", "Visuals/Label")).toBe(1.0);
    expect(viewScaleFor(null, null)).toBe(1.0);
  });

  // ---- R8 (WS-1) scale pack — must stay in lockstep with the native ViewScaleTests of the same names -------------

  it("R8: enlarges NORMAL map points 1.5× about their own centre, unclamped; ancient/boss untouched", () => {
    const r = resolveViewScale("res://scenes/ui/normal_map_point.tscn", "");
    expect(r.scale).toBe(VIEW_SCALE_MAP_POINT);
    expect(r.scale).toBe(1.5); // 56 → 84 design px
    expect(r.isGroup).toBe(false);
    expect(r.pivot).toBe("center");
    expect(r.noClamp).toBe(true); // the map SCROLLS — a clamp would slide an edge point off its path
    // Only the ROOT scales: a nested child would double-scale the point.
    expect(viewScaleFor("res://scenes/ui/normal_map_point.tscn", "IconContainer/Icon")).toBe(1.0);
    expect(viewScaleFor("res://scenes/ui/ancient_map_point.tscn", "")).toBe(1.0);
    expect(viewScaleFor("res://scenes/ui/boss_map_point.tscn", "")).toBe(1.0);
  });

  it("R8: scales the map legend 1.2× as a GROUP pinned at its bottom-right corner, unclamped", () => {
    const r = resolveViewScale("res://scenes/screens/map/map_screen.tscn", "MapLegend");
    expect(r.scale).toBe(VIEW_SCALE_MAP_LEGEND);
    expect(r.isGroup).toBe(true);
    expect(r.pivot).toBe("bottomRight");
    expect(r.noClamp).toBe(true);
    // The legend is a plain CHILD of the map screen (no sceneFilePath of its own) → it is pre-filtered by NAME.
    expect(VIEW_SCALE_CANDIDATE_NAMES.has("MapLegend")).toBe(true);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/screens/map/map_screen.tscn")).toBe(false);
    expect(viewScaleFor("res://scenes/screens/map/map_screen.tscn", "")).toBe(1.0);
    expect(viewScaleFor("res://scenes/screens/map/map_screen.tscn", "TheMap/Points")).toBe(1.0);
  });

  // WS-3 twin of native ViewScaleTests.DrawingToolsMatchesCenterGroup. The map's draw/erase/clear palette is a plain
  // child of the map screen root (relPath "DrawingTools", a NinePatchRect) → 1.35 GROUP about its own CENTRE, unclamped.
  it("WS-3: scales the map DrawingTools palette 1.35× as a GROUP about its own centre, unclamped", () => {
    const r = resolveViewScale("res://scenes/screens/map/map_screen.tscn", "DrawingTools");
    expect(r.scale).toBe(VIEW_SCALE_DRAWING_TOOLS);
    expect(r.scale).toBe(1.35);
    expect(r.isGroup).toBe(true); // the three interior buttons are the tap surfaces; they ride the one stamp
    expect(r.pivot).toBe("center");
    expect(r.noClamp).toBe(true);
    expect(r.translateX).toBe(0);
    expect(r.translateY).toBe(0);
    expect(viewScaleActive(r)).toBe(true);

    // A plain CHILD of the map screen root (no sceneFilePath of its own) → pre-filtered by NAME, exactly like
    // MapLegend. The screen file must NOT join the web root-file set (a root-file match takes the TABLE branch of the
    // walk's if/else and would shadow the name-prefiltered resolve).
    expect(VIEW_SCALE_CANDIDATE_NAMES.has("DrawingTools")).toBe(true);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/screens/map/map_screen.tscn")).toBe(false);

    // Nothing else scales: not the screen root, not the palette's interior (which would double-scale the buttons),
    // and the name alone never scales a same-named node under a different scene file.
    expect(viewScaleFor("res://scenes/screens/map/map_screen.tscn", "")).toBe(1.0);
    for (const rel of [
      "DrawingTools/HBoxContainer",
      "DrawingTools/HBoxContainer/DrawButton",
      "DrawingTools/HBoxContainer/EraseButton",
      "DrawingTools/HBoxContainer/ClearButton"
    ]) {
      expect(viewScaleFor("res://scenes/screens/map/map_screen.tscn", rel)).toBe(1.0);
    }
    expect(viewScaleFor("res://scenes/screens/deck_view_screen.tscn", "DrawingTools")).toBe(1.0);
  });

  it("WS-3: the DrawingTools box scaled 1.35 about its centre lands wholly on-stage (so noClamp is safe)", () => {
    // Design box (56,972)-(264,1040) — recovered map_screen.tscn (anchors_preset 2, offsets 56/-108/264/-40 against
    // the 1080-tall canvas): 208×68, centre (160,1006).
    const s = computeAnchoredScaleStamp({ x: 56, y: 972, w: 208, h: 68 }, 1.35, 1920, 1080, "center", 0, 0, true)!;
    expect(s.pivotX).toBe(160);
    expect(s.pivotY).toBe(1006);
    expect(s.offsetX).toBe(0); // unclamped, and the clamp would be a no-op anyway (see the on-stage bounds below)
    expect(s.offsetY).toBe(0);
    // (56,972)-(264,1040) → (19.6,960.1)-(300.4,1051.9): fully inside 1920×1080, so the enlarged panel never rides
    // off the stage and never needs the clamp to drag it back (which would break its ½Δ match with the map content).
    expect(160 + 1.35 * (56 - 160)).toBeCloseTo(19.6, 6);
    expect(160 + 1.35 * (264 - 160)).toBeCloseTo(300.4, 6);
    expect(1006 + 1.35 * (972 - 1006)).toBeCloseTo(960.1, 6);
    expect(1006 + 1.35 * (1040 - 1006)).toBeCloseTo(1051.9, 6);
    // The clamped stamp is byte-identical here — proof the noClamp flag changes nothing on this box.
    expect(computeAnchoredScaleStamp({ x: 56, y: 972, w: 208, h: 68 }, 1.35, 1920, 1080, "center")).toEqual(s);
  });

  it("R8: scales the two combat corner piles 1.25× inward from their own bottom corner", () => {
    const draw = resolveViewScale("res://scenes/combat/draw_pile.tscn", "");
    expect(draw.scale).toBe(VIEW_SCALE_PILE);
    expect(draw.pivot).toBe("bottomLeft");
    expect(draw.isGroup).toBe(false);

    const discard = resolveViewScale("res://scenes/combat/discard_pile.tscn", "");
    expect(discard.scale).toBe(VIEW_SCALE_PILE);
    expect(discard.pivot).toBe("bottomRight");
    expect(discard.isGroup).toBe(false);

    // The count label rides the root stamp (it is never separately scaled).
    expect(viewScaleFor("res://scenes/combat/draw_pile.tscn", "CountContainer/Count")).toBe(1.0);
  });

  // R9 (WS-B) twin of native ViewScaleTests.ExhaustPileMatchesMiddleRightEdgePivot. The third combat pile is the only
  // one that is NOT in a screen corner: its root box (1830,800)-(1910,880) is pinned to the RIGHT edge at mid height,
  // so it takes the new "middleRight" EDGE pivot (right edge pinned, vertical growth symmetric about the box centre).
  it("R9: scales the exhaust pile 1.25× from its RIGHT EDGE (middleRight), not from a corner", () => {
    const r = resolveViewScale("res://scenes/combat/exhaust_pile.tscn", "");
    expect(r.scale).toBe(VIEW_SCALE_PILE);
    expect(r.pivot).toBe("middleRight");
    expect(r.isGroup).toBe(false);
    // Deliberately NOT noClamp (unlike the map legend): the scaled box stays inside the viewport, so the on-screen
    // clamp is a no-op that stays available as a backstop.
    expect(r.noClamp).toBe(false);
    expect(viewScaleFor("res://scenes/combat/exhaust_pile.tscn", "CountContainer/Count")).toBe(1.0);
    // Its ROOT carries the entry → it IS a web root file (unlike the map screen / deck screen presence-gate files).
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/combat/exhaust_pile.tscn")).toBe(true);
  });

  // R9 (WS-B) twin of native ViewScaleTests.DeckViewUpgradesMatchesBottomLeft. The deck dialog's "View Upgrades"
  // toggle is a MarginContainer (mouseFilter PASS) at (16,1012)-(212.5,1060), a direct child of the screen root
  // (measured from .sts2/bench/wscrisp-deckdialog.ndjson) → R10 WS-F 1.35 (was 1.25) pinned at its BOTTOM-LEFT corner.
  it("R9/R10: scales the deck dialog's View Upgrades toggle 1.35× from its bottom-left corner", () => {
    const r = resolveViewScale("res://scenes/screens/deck_view_screen.tscn", "ViewUpgrades");
    expect(r.scale).toBe(VIEW_SCALE_VIEW_UPGRADES_DECK);
    // R10 WS-F: the deck dialog and the card-detail popup no longer share one factor — pin BOTH numbers here (and in
    // the native twin, ViewScaleTests) so an edit to either constant has to come past this test.
    expect(r.scale).toBe(1.35);
    expect(VIEW_SCALE_VIEW_UPGRADES_DETAIL).toBe(1.4);
    expect(r.pivot).toBe("bottomLeft");
    expect(r.isGroup).toBe(false);
    expect(r.noClamp).toBe(false);

    // It is a plain CHILD of the screen root (no sceneFilePath of its own) → pre-filtered by NAME, exactly like
    // MapLegend. The screen file must NOT join the web root-file set: native lists it only as a cheap presence gate,
    // which the web does not have, and a root-file match takes the TABLE branch of the walk's if/else.
    expect(VIEW_SCALE_CANDIDATE_NAMES.has("ViewUpgrades")).toBe(true);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/screens/deck_view_screen.tscn")).toBe(false);

    // Nothing else on the dialog scales: not the screen root, not the toggle's interior (which would double-scale the
    // row), not the sort buttons — and the name alone never scales a same-named node under a different scene file.
    expect(viewScaleFor("res://scenes/screens/deck_view_screen.tscn", "")).toBe(1.0);
    expect(viewScaleFor("res://scenes/screens/deck_view_screen.tscn", "ViewUpgrades/MarginContainer/Upgrades")).toBe(1.0);
    expect(viewScaleFor("res://scenes/screens/deck_view_screen/deck_view_sort_button.tscn", "")).toBe(1.0);
    expect(viewScaleFor("res://scenes/screens/map/map_screen.tscn", "ViewUpgrades")).toBe(1.0);

    // The measured box, stamped at the R10 1.35 factor: bottom-left pinned at (16,1060), growth right/up to
    // (281.3,995.2) — offsetX/offsetY 0 IS the "still wholly inside the 1920x1080 stage" assertion (a scaled box that
    // left the viewport would come back with a non-zero clamp offset). Twin of the native geometry checks.
    const s = computeAnchoredScaleStamp({ x: 16, y: 1012, w: 196.5, h: 48 }, r.scale, 1920, 1080, "bottomLeft")!;
    expect(s.pivotX).toBe(16);
    expect(s.pivotY).toBe(1060);
    expect(s.offsetX).toBe(0);
    expect(s.offsetY).toBe(0);
    expect(16 + 1.35 * 196.5).toBeCloseTo(281.275, 6);
    expect(1060 - 1.35 * 48).toBeCloseTo(995.2, 6);
  });

  // R9 (WS-B) twin of native ViewScaleTests.CardDetailViewUpgradesMatchesBottomCenter. Same control as the deck
  // dialog's but a different name/shape (relPath "Upgrade", the NUpgradePreviewTickbox itself) and a different anchor:
  // its box (816.5,990)-(1103.5,1054) is horizontally CENTRED on the screen, so it takes bottomCenter.
  it("R9/R10: scales the card-detail popup's View Upgrades toggle 1.40× from its bottom CENTRE", () => {
    const r = resolveViewScale("res://scenes/screens/inspect_card_screen.tscn", "Upgrade");
    expect(r.scale).toBe(VIEW_SCALE_VIEW_UPGRADES_DETAIL);
    expect(r.scale).toBe(1.4);
    expect(r.pivot).toBe("bottomCenter");
    expect(r.isGroup).toBe(false);
    expect(r.noClamp).toBe(false);

    // Pre-filtered by NAME like the deck's; the screen file stays out of the web root-file set (native-only gate).
    expect(VIEW_SCALE_CANDIDATE_NAMES.has("Upgrade")).toBe(true);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/screens/inspect_card_screen.tscn")).toBe(false);

    // Nothing else on the popup scales, and the two dialogs' entries never cross-match.
    for (const rel of ["", "Backstop", "HoverTipRect", "LeftArrow", "RightArrow", "Upgrade/ShowUpgradeLabel"]) {
      expect(viewScaleFor("res://scenes/screens/inspect_card_screen.tscn", rel)).toBe(1.0);
    }
    expect(viewScaleFor("res://scenes/screens/inspect_card_screen.tscn", "ViewUpgrades")).toBe(1.0);
    expect(viewScaleFor("res://scenes/screens/deck_view_screen.tscn", "Upgrade")).toBe(1.0);

    // The measured box, stamped: centre X 960 held, bottom pinned at 1054, grown up to 964.4 at the R10 1.40 factor.
    // offsetX/offsetY 0 IS the "still wholly on-stage" assertion — a scaled box that left the 1920x1080 viewport would
    // come back with a non-zero clamp offset.
    const s = computeAnchoredScaleStamp({ x: 816.5, y: 990, w: 287, h: 64 }, r.scale, 1920, 1080, "bottomCenter")!;
    expect(s.pivotX).toBe(960);
    expect(s.pivotY).toBe(1054);
    expect(s.offsetX).toBe(0);
    expect(s.offsetY).toBe(0);
    expect(960 + 1.4 * (816.5 - 960)).toBeCloseTo(759.1, 6);
    expect(1054 + 1.4 * (990 - 1054)).toBeCloseTo(964.4, 6);
  });

  it("R8/R9: registers the new ROOT files for the cheap walk pre-filter", () => {
    for (const f of [
      "res://scenes/ui/normal_map_point.tscn",
      "res://scenes/combat/draw_pile.tscn",
      "res://scenes/combat/discard_pile.tscn",
      // R9: the exhaust pile's ROOT carries its own entry.
      "res://scenes/combat/exhaust_pile.tscn"
    ]) {
      expect(VIEW_SCALE_ROOT_FILES.has(f)).toBe(true);
    }
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/ui/ancient_map_point.tscn")).toBe(false);
    // R9: the two dialog screens are native-only presence gates — the web resolves their child by NAME instead.
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/screens/deck_view_screen.tscn")).toBe(false);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/screens/inspect_card_screen.tscn")).toBe(false);
  });

  it("R8: the treasure relic is a LEAF-detected 1.25× bottom-centre stamp, never a table/file match", () => {
    expect(TREASURE_RELIC_LEAF).toBe("NTreasureRoomRelicHolder");
    expect(TREASURE_RELIC_RESOLVED.scale).toBe(VIEW_SCALE_TREASURE_RELIC);
    expect(TREASURE_RELIC_RESOLVED.pivot).toBe("bottomCenter"); // the relic's feet stay on its pedestal
    expect(TREASURE_RELIC_RESOLVED.isGroup).toBe(false); // the vote icons are children → they ride this stamp
    expect(TREASURE_RELIC_RESOLVED.noClamp).toBe(true);
    expect(viewScaleActive(TREASURE_RELIC_RESOLVED)).toBe(true);
    // The vote container's own scene is REUSED by the map points + the ProceedButton, so it must never key a table entry.
    expect(viewScaleFor("res://scenes/ui/multiplayer_vote_container.tscn", "")).toBe(1.0);
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/ui/multiplayer_vote_container.tscn")).toBe(false);
    // The holder's OWN scene file must NOT be in the web root-file set even though native's IsRootFile lists it (as a
    // presence gate): a root-file match takes the TABLE branch of the walk's if/else and would shadow the leaf branch
    // that actually stamps the holder. Same asymmetry as card_reward_selection_screen.tscn.
    expect(VIEW_SCALE_ROOT_FILES.has("res://scenes/ui/treasure_relic_holder.tscn")).toBe(false);
    expect(viewScaleFor("res://scenes/ui/treasure_relic_holder.tscn", "")).toBe(1.0);
  });
});

describe("resolveTipOwnerKind — owner kind mapping (#17/#18)", () => {
  it("maps card-holders → handCard, NCreature → creature, NRewardButton → rewardItem, else none", () => {
    expect(resolveTipOwnerKind("NHandCardHolder", null)).toBe("handCard");
    expect(resolveTipOwnerKind("NGridCardHolder", null)).toBe("handCard");
    expect(resolveTipOwnerKind("NCardHolder", null)).toBe("handCard");
    expect(resolveTipOwnerKind("NCreature", null)).toBe("creature");
    expect(resolveTipOwnerKind("NRewardButton", null)).toBe("rewardItem");
    expect(resolveTipOwnerKind("NMapLegendItem", null)).toBe("none");
    expect(resolveTipOwnerKind("NMerchantCard", null)).toBe("none");
    expect(resolveTipOwnerKind(null, "res://scenes/rewards/reward_button.tscn")).toBe("rewardItem");
    expect(resolveTipOwnerKind(null, null)).toBe("none");
  });
});

describe("computeCenterScaleStamp — #19 centre-pivot stamp", () => {
  const box = (x: number, y: number, w: number, h: number): TipAabb => ({ x, y, w, h });

  it("pivots at the box centre with no clamp when in bounds", () => {
    const res = computeCenterScaleStamp(box(1000, 400, 200, 100), 1.15, 1920)!;
    expect(res.pivotX).toBe(1100);
    expect(res.pivotY).toBe(450);
    expect(res.offsetX).toBe(0);
    expect(res.offsetY).toBe(0);
  });

  it("clamps a scaled box that overflows the right edge back in-bounds", () => {
    // box x∈[1860,1920] centre 1890; scaled right = 1890 + 1.2·30 = 1926 > 1920 → offsetX = -6.
    const res = computeCenterScaleStamp(box(1860, 400, 60, 100), 1.2, 1920)!;
    expect(res.offsetX).toBeCloseTo(-6, 6);
  });

  it("returns null for a degenerate box", () => {
    expect(computeCenterScaleStamp(box(100, 100, 0, 50), 1.2, 1920)).toBeNull();
    expect(computeCenterScaleStamp(box(100, 100, 50, 0), 1.2, 1920)).toBeNull();
  });
});

describe("computeAnchoredScaleStamp — R7/R9 anchored + translate stamp", () => {
  const box = (x: number, y: number, w: number, h: number): TipAabb => ({ x, y, w, h });

  it("pins the top for topCenter and the bottom for bottomCenter (pivot X stays centre)", () => {
    const top = computeAnchoredScaleStamp(box(600, 750, 800, 292), 1.2, 1920, 1080, "topCenter")!;
    expect(top.pivotX).toBe(1000);
    expect(top.pivotY).toBe(750);
    const bot = computeAnchoredScaleStamp(box(600, 750, 800, 292), 1.2, 1920, 1080, "bottomCenter")!;
    expect(bot.pivotX).toBe(1000);
    expect(bot.pivotY).toBe(1042);
    expect(bot.offsetY).toBe(0); // grows up in-bounds → no clamp
  });

  it("carries a pure translate (scale 1) via the clamp offset", () => {
    const s = computeAnchoredScaleStamp(box(727, 654, 800, 84), 1.0, 1920, 1080, "center", 0, -70.4)!;
    expect(s.offsetY).toBeCloseTo(-70.4, 6);
    expect(s.offsetX).toBe(0);
  });

  // R8 (WS-1): the two CORNER pivots — the first whose pivot X is NOT the box centre. Same vectors as the native
  // HoverTipScaleMathTests.AnchoredStampCornerPivots* so both clients place a corner widget identically.
  it("R8: bottomLeft/bottomRight pin the box's bottom corner (pivot X moves to the box edge)", () => {
    const draw = computeAnchoredScaleStamp(box(15, 985, 80, 80), 1.25, 1920, 1080, "bottomLeft")!;
    expect(draw.pivotX).toBe(15); // box LEFT edge
    expect(draw.pivotY).toBe(1065); // box BOTTOM edge
    expect(draw.offsetX).toBe(0);
    expect(draw.offsetY).toBe(0);

    const discard = computeAnchoredScaleStamp(box(1826, 985, 80, 80), 1.25, 1920, 1080, "bottomRight")!;
    expect(discard.pivotX).toBe(1906); // box RIGHT edge
    expect(discard.pivotY).toBe(1065);
    expect(discard.offsetX).toBe(0);
    expect(discard.offsetY).toBe(0);
  });

  // R9 (WS-B): the EDGE pivot. Same vectors as native HoverTipScaleMathTests — the exhaust pile's real box.
  it("R9: middleRight pins the box's RIGHT EDGE but keeps pivot Y at the box CENTRE", () => {
    const exhaust = box(1830, 800, 80, 80); // exhaust_pile.tscn root, 80×80 mid-right
    const mr = computeAnchoredScaleStamp(exhaust, 1.25, 1920, 1080, "middleRight")!;
    expect(mr.pivotX).toBe(1910); // box RIGHT edge — same as bottomRight
    expect(mr.pivotY).toBe(840); // box CENTRE — NOT the bottom (that is the whole difference)
    expect(mr.offsetX).toBe(0);
    expect(mr.offsetY).toBe(0);
    // The same box under bottomRight would pin the BOTTOM instead — the behaviour the edge pivot avoids.
    expect(computeAnchoredScaleStamp(exhaust, 1.25, 1920, 1080, "bottomRight")!.pivotY).toBe(880);
  });

  it("R8: the pinned corner is the stamp's fixed point and the growth goes inward", () => {
    const fwd = (s: { pivotX: number; pivotY: number; offsetX: number; offsetY: number }, k: number, x: number, y: number) => [
      s.pivotX + k * (x - s.pivotX) + s.offsetX,
      s.pivotY + k * (y - s.pivotY) + s.offsetY
    ];
    const draw = computeAnchoredScaleStamp(box(15, 985, 80, 80), 1.25, 1920, 1080, "bottomLeft")!;
    expect(fwd(draw, 1.25, 15, 1065)).toEqual([15, 1065]); // corner fixed
    expect(fwd(draw, 1.25, 95, 985)).toEqual([115, 965]); // grows right + up

    const discard = computeAnchoredScaleStamp(box(1826, 985, 80, 80), 1.25, 1920, 1080, "bottomRight")!;
    expect(fwd(discard, 1.25, 1906, 1065)).toEqual([1906, 1065]); // corner fixed
    expect(fwd(discard, 1.25, 1826, 985)).toEqual([1806, 965]); // grows left + up

    // R9 middleRight: the right EDGE is fixed at every height and the box splays symmetrically about y=840 —
    // (1830,800)-(1910,880) → (1810,790)-(1910,890), the exhaust pile's measured geometry.
    const exhaust = computeAnchoredScaleStamp(box(1830, 800, 80, 80), 1.25, 1920, 1080, "middleRight")!;
    expect(fwd(exhaust, 1.25, 1910, 800)).toEqual([1910, 790]); // right edge fixed in X, splays UP
    expect(fwd(exhaust, 1.25, 1910, 880)).toEqual([1910, 890]); // right edge fixed in X, splays DOWN
    expect(fwd(exhaust, 1.25, 1830, 840)).toEqual([1810, 840]); // grows LEFT; the vertical centre is fixed
  });

  it("R8: the map legend's real box keeps both pinned edges with bottomRight + noClamp (a centre pivot drags it left)", () => {
    // MapLegend design box (1656,289)-(1996,743) from probe-map-visible.ndjson — its right edge is already past 1920.
    const legend = box(1656, 289, 340, 454);
    const centred = computeAnchoredScaleStamp(legend, 1.2, 1920, 1080, "center")!;
    expect(centred.offsetX).toBeLessThan(-100); // the clamp shoves the panel >100px left off the edge it hugs

    const pinned = computeAnchoredScaleStamp(legend, 1.2, 1920, 1080, "bottomRight", 0, 0, true)!;
    expect(pinned.pivotX).toBe(1996);
    expect(pinned.pivotY).toBe(743);
    expect(pinned.offsetX).toBe(0);
    expect(pinned.offsetY).toBe(0);
    // Grows LEFT to 1996 − 1.2·340 = 1588 and UP to 743 − 1.2·454 = 198.2.
    expect(1996 + 1.2 * (1656 - 1996)).toBeCloseTo(1588, 6);
    expect(743 + 1.2 * (289 - 743)).toBeCloseTo(198.2, 6);
  });

  it("R9: the exhaust entry needs NO noClamp — the clamp is already a no-op on its real box", () => {
    const exhaust = box(1830, 800, 80, 80);
    const clamped = computeAnchoredScaleStamp(exhaust, 1.25, 1920, 1080, "middleRight")!;
    const unclamped = computeAnchoredScaleStamp(exhaust, 1.25, 1920, 1080, "middleRight", 0, 0, true)!;
    expect(clamped).toEqual(unclamped);
    // But the clamp is genuinely live for this pivot: a box splayed past the bottom edge is pushed back up.
    // y∈[990,1070] centre 1030 → scaled bottom 1030 + 1.5·40 = 1090 > 1080 → offsetY = −10.
    const low = computeAnchoredScaleStamp(box(1800, 990, 100, 80), 1.5, 1920, 1080, "middleRight")!;
    expect(low.offsetY).toBeCloseTo(-10, 6);
    expect(low.offsetX).toBe(0); // pinned right edge grows inward → never an X correction
  });

  it("R8/R9: the three *Center pivots keep pivot X at the box centre; middleRight keeps pivot Y at the centre", () => {
    for (const p of ["center", "topCenter", "bottomCenter"] as const) {
      expect(computeAnchoredScaleStamp(box(600, 750, 800, 292), 1.2, 1920, 1080, p)!.pivotX).toBe(1000);
    }
    // The one axis that distinguishes middleRight from bottomRight — the twin-drift hazard if a future pivot is
    // folded into the bottom-pinning arm by mistake.
    const mr = computeAnchoredScaleStamp(box(600, 750, 800, 292), 1.2, 1920, 1080, "middleRight")!;
    expect(mr.pivotX).toBe(1400); // box RIGHT edge
    expect(mr.pivotY).toBe(896); // box CENTRE
    expect(mr.pivotY).toBe(computeAnchoredScaleStamp(box(600, 750, 800, 292), 1.2, 1920, 1080, "center")!.pivotY);
  });

  it("R4-round4 noClamp: a full-viewport box scaled >1 corner-pins when clamped, but stays centred when noClamp", () => {
    // The whole card-reward screen box (0,0,1920,1080) scaled 1.10 about centre overflows every edge.
    const clamped = computeAnchoredScaleStamp(box(0, 0, 1920, 1080), 1.1, 1920, 1080, "center")!;
    expect(clamped.offsetX !== 0 || clamped.offsetY !== 0).toBe(true); // corner-pin

    const noClamp = computeAnchoredScaleStamp(box(0, 0, 1920, 1080), 1.1, 1920, 1080, "center", 0, 0, true)!;
    expect(noClamp.offsetX).toBe(0);
    expect(noClamp.offsetY).toBe(0);
    expect(noClamp.pivotX).toBe(960);
    expect(noClamp.pivotY).toBe(540);
  });
});
