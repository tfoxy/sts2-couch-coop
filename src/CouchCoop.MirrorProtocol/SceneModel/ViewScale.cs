using System;

namespace CouchCoop.MirrorProtocol.SceneModel;

// General per-node VIEW-SCALE table (#19, extended by WS-G2 R2/R4/R7/R9/R19/R20). Some interactive items are too
// small to read/tap on a phone at Half render scale — the post-combat reward list, the card-reward selection screen,
// the merchant carpet, the event option lists. This table enlarges them by a per-item factor about a per-entry ANCHOR
// (centre / top / bottom), optionally translating the result, and optionally treating the entry as a whole-screen
// GROUP (a container whose interior children scale as one rigid unit). It is modeled 1:1 on TextScale — an Entry table
// keyed by SceneIdentity (data-scene-file `File` + data-scene-node-path `Path`), first-match-wins, env-free/pure — but
// it emits a uniform VIEW scale (through the existing HoverTip _hoverScale / FoldCosmetic pivot+clamp channel native;
// applyViewScalePass transform-compose web) rather than a font-size multiplier.
//
// Consumers:
//   * native ViewScaler.cs / web applyViewScalePass → <see cref="ResolveFor(string, MirrorState)"/> for the factor +
//     anchor + translate + group flag, then <see cref="HoverTipScaleMath.ComputeAnchoredStamp"/> for the stamp.
//   * the input side → <see cref="InverseMapPoint"/> (via ViewScaleInput.Remap) to un-map a design-space pointer that
//     lands on an enlarged item back to the item's TRUE (un-scaled) coordinate so the game hit-test still lands.
//
// Kill switch is the CONSUMER's (COUCHCOOP_MIRROR_VIEWSCALE native / ?viewScale=off web); this table stays pure.
public static class ViewScale
{
    private enum Op
    {
        Exact,
        Suffix,
        Contains,
        Prefix,
    }

    private readonly record struct Cond(Op Op, string Value)
    {
        public bool Matches(string s) => Op switch
        {
            Op.Exact => s == Value,
            Op.Suffix => s.EndsWith(Value, StringComparison.Ordinal),
            Op.Contains => s.Contains(Value, StringComparison.Ordinal),
            Op.Prefix => s.StartsWith(Value, StringComparison.Ordinal),
            _ => false,
        };
    }

    // File is null when the rule has no scene-file condition. An Entry AND-combines its File condition (optional) with
    // every Path condition; the first Entry whose conditions all hold wins. `IsGroup` marks a container whose interior
    // children are the tap surfaces (R2 input gate + R4 measure rule); `Pivot`/`TranslateX`/`TranslateY` shape the
    // anchored stamp (R7/R9).
    private sealed record Entry(
        Cond? File,
        Cond[] Path,
        double Scale,
        bool IsGroup = false,
        HoverTipScaleMath.AnchorPivot Pivot = HoverTipScaleMath.AnchorPivot.Center,
        double TranslateX = 0,
        double TranslateY = 0,
        bool NoClamp = false);

    private static Cond Exact(string v) => new(Op.Exact, v);
    private static Cond Suffix(string v) => new(Op.Suffix, v);

    // ---- res:// scene-ROOT-file constants (each carries a table rule; the cheap presence gate keys on these) --------
    // WS6: the post-combat REWARDS screen. Its rewards PANEL is a plain child Control (relPath "Rewards", 526×640 at
    // (696,236) — measured from .sts2/bench/audit-rewards.ndjson) holding Background / Banner / HeaderLabel /
    // RewardContainerMask+RewardsContainer / Scrollbar. The entry is scoped to this SCREEN (like MapScreen::MapLegend)
    // and replaces the old per-ROW reward_button.tscn entry, so panel chrome and rows enlarge as ONE unit.
    private const string RewardsScreen = "res://scenes/screens/rewards_screen.tscn";
    private const string RewardsPanelPath = "Rewards";
    private const string CardRewardSelectionScreen = "res://scenes/screens/card_selection/card_reward_selection_screen.tscn";
    private const string MerchantInventory = "res://scenes/merchant/merchant_inventory.tscn";
    private const string DefaultEventLayout = "res://scenes/events/default_event_layout.tscn";
    private const string CombatEventLayout = "res://scenes/events/combat_event_layout.tscn";
    private const string AncientEventLayout = "res://scenes/events/ancient_event_layout.tscn";

    // ---- R8 (WS-1) additions: map nodes / map legend / combat corner piles. -----------------------------------------
    // NORMAL map points only (user decision: ancient + boss points keep the game's size). Verified from
    // .sts2/bench/probe-map-visible.ndjson: normal_map_point.tscn's ROOT node (NNormalMapPoint) carries the
    // SceneFilePath and a 56×56 LocalRect, so a ROOT ("") entry keyed on the file matches exactly one node per point.
    private const string NormalMapPoint = "res://scenes/ui/normal_map_point.tscn";
    // The map SCREEN owns the legend as a plain child (relPath "MapLegend"), so the legend entry is scoped to it and
    // the screen root is what makes the presence gate fire on the map (see IsRootFile).
    private const string MapScreen = "res://scenes/screens/map/map_screen.tscn";
    private const string DrawPile = "res://scenes/combat/draw_pile.tscn";
    private const string DiscardPile = "res://scenes/combat/discard_pile.tscn";

    // ---- R9 (WS-B) scale pack 2 -------------------------------------------------------------------------------------
    // The third combat pile. Its ROOT (NExhaustPileButton) carries the SceneFilePath and an 80×80 LocalRect at
    // (1830,800)-(1910,880) — measured from the 16:40-09 combat recording. Unlike draw/discard it is NOT in a screen
    // corner: it is pinned to the RIGHT EDGE half-way up the screen, which is why it needs the new MiddleRight pivot.
    // It is `visible:false` in EVERY recording on this machine (the game only shows it once the exhaust pile is
    // non-empty), so the entry is validated live rather than by a replay probe.
    private const string ExhaustPile = "res://scenes/combat/exhaust_pile.tscn";
    // The deck dialog owns its "View Upgrades" toggle as a plain child (relPath "ViewUpgrades"), so the entry is
    // scoped to the SCREEN and the screen root is what makes the native presence gate fire (see IsRootFile).
    private const string DeckViewScreen = "res://scenes/screens/deck_view_screen.tscn";

    // ---- WS-3 (map DRAWING TOOLS) -----------------------------------------------------------------------------------
    // The map screen's draw/erase/clear palette — a NinePatchRect the map screen owns as a plain child
    // (relPath "DrawingTools", verified against the recovered map_screen.tscn), so like MapLegend the entry is scoped
    // to MapScreen and the screen root is what makes the presence gate fire. Its three interior buttons
    // (HBoxContainer/DrawButton|EraseButton|ClearButton, mouseFilter STOP) are the tap surfaces, hence IsGroup.
    private const string DrawingToolsPath = "DrawingTools";
    // The CARD-DETAIL popup (root NInspectCardScreen) has the same "View Upgrades" control under a DIFFERENT name and
    // shape: relPath "Upgrade", and it is the NUpgradePreviewTickbox ITSELF (mouseFilter STOP) rather than the deck's
    // wrapping MarginContainer. Box (816.5,990)-(1103.5,1054) — horizontally CENTRED on the screen (centre x == 960)
    // and sitting under the card, hence BottomCenter rather than the deck's BottomLeft. No recording captured this
    // screen open before R9; measured live from .sts2/bench/r9-carddetail.ndjson.
    private const string InspectCardScreen = "res://scenes/screens/inspect_card_screen.tscn";

    // The treasure-room relic HOLDER node-type leaf. The rule is LEAF-based (see IsTreasureRoomRelic / ResolveFor),
    // NOT keyed on a scene file: `multiplayer_vote_container.tscn` — the only other file in the holder's subtree —
    // is REUSED by the MAP POINTS (MapPointVoteContainer) and the treasure room's own ProceedButton
    // (SkipMultiplayerVoteContainer) — live-verified — and treasure_room.tscn renames every holder instance
    // (SingleplayerRelicHolder / MultiplayerRelicHolder1..4), so the leaf is the one stable discriminator. It is the
    // same leaf the touch classifier already keys on (Input/TouchTargetScan.cs, web mirrorRenderer TOUCH_TARGET_TYPES).
    private const string TreasureRelicLeaf = "NTreasureRoomRelicHolder";

    // The holder's own scene file. It carries NO table entry — it exists only to make the native presence gate
    // (ViewScaler.AnyViewScaleScenePresent, a SceneFilePath check) fire on a treasure room so the leaf rule above can
    // run at all. On the wire the holder streams as the relic art and its vote container side by side under one
    // parent, so stamping the holder scales both together — which is what the enlargement has to do to stay legible.
    private const string TreasureRelicHolder = "res://scenes/ui/treasure_relic_holder.tscn";

    // The card-reward SELECTION screen node-type leaf — used by the <see cref="IsCardRewardCard"/> helper (R4-round4:
    // the per-card 1.15 ANCESTRY rule, restored — see ResolveFor's fallback).
    private const string CardRewardScreenLeaf = "NCardRewardSelectionScreen";

    // ---- per-entry factors (QA-tuned so enlarged neighbours don't overlap — see the WS-G2 report). ------------------
    // WS6: the post-combat rewards PANEL (rewards_screen.tscn :: Rewards) as one GROUP. Same 1.2 the reward ROWS used
    // to carry per-item — the rows are inside the panel, so their rendered size is unchanged — but the banner/header/
    // scroll mask now grow with them, and a row parked below the scroll mask can no longer be clamped into view on its
    // own. Scaled box (643.4,172)-(1274.6,940): wholly on-stage, so the clamp stays a no-op.
    public const double RewardListScale = 1.2;
    // R4-round4 (user decision): the card-reward screen is NESTED — a gentle 1.10 whole-screen GROUP (container) about
    // its CENTRE, UNCLAMPED (a full-viewport box scaled >1 always corner-pins under AxisClamp; unclamped centre scale
    // crops a symmetric ~49px top/bottom · ~87px left/right border of edge content, so the skip row lands ≈y999 —
    // on-screen — instead of being pushed off), PLUS a per-card 1.15 about each card's own centre (unclamped). The net
    // reward card is ≈1.10·1.15 = 1.27× bigger than combat, visibly larger than the container bump alone.
    public const double CardRewardGroupScale = 1.10;  // whole card-reward selection screen container (cards + skip row)
    public const double CardRewardScale = 1.15;       // per reward card (NCard under the screen), about its own centre
    // R19/R20/R3-Q3: the SlotsContainer (shop rug + all items) as one unit. WS6 lowered it 1.20 → 1.10: at 1.20 the
    // 1747×978 container measures 2096×1174 — wider AND taller than the 1920×1080 stage — so the carpet covered the
    // whole screen and the shop ROOM background disappeared (it survived only as a sliver on the LEFT, because
    // AxisClamp pinned the over-wide box's left edge to 0 and threw the entire overflow off the right; user-reported).
    // At 1.10 the container is 1922×1076 — it fits the stage height — and the rug ART (design x ≈ 229…1757, inset
    // ~111px inside the container box) scales to ≈153…1833, leaving the room visible on BOTH sides like the game.
    public const double MerchantGroupScale = 1.10;
    public const double EventOptionsScale = 1.2;      // R7/R9: the event OptionsContainer

    // R9 ancient-event dialogue lift: the OptionsContainer grows UP by 0.2·height (BottomCenter pivot); the dialogue
    // above it must translate up to stay clear. Height captured from audit-mprun.ndjson (OptionsContainer 1000×292 →
    // 3 fixed-height options). translateY = −(0.2·optionsHeight + margin) preserves the original dialogue↔options gap.
    public const double AncientOptionsHeight = 292;
    public const double AncientDialogueMargin = 12;
    public const double AncientDialogueTranslateY = -((0.2 * AncientOptionsHeight) + AncientDialogueMargin); // ≈ −70.4

    // ---- R8 (WS-1) factors -----------------------------------------------------------------------------------------
    // Map NODE +50% (user decision, normal points only): 56 → 84 design px, the single biggest touch-target win on the
    // map. Scaled about the point's OWN centre and UNCLAMPED — the map SCROLLS, so a point straddling the top/bottom
    // viewport edge must keep sitting on its path; the on-screen AxisClamp would slide it off the path instead.
    public const double MapPointScale = 1.5;
    // Map LEGEND +20% as one rigid GROUP (its NMapLegendItem rows are the readable/tappable content). Pinned at its
    // BOTTOM-RIGHT corner and UNCLAMPED: the legend's design box is (1656,289)-(1996,743) — its right edge is already
    // 76px past 1920 by design, so a centre pivot would either push more of it off-screen (NoClamp) or, with the clamp
    // on, shove the whole panel ~110px left and visibly detach it from the edge the game anchored it to.
    public const double MapLegendScale = 1.2;
    // Draw / discard piles +25% (80×80 buttons in the two bottom corners of combat). Each grows INWARD from its own
    // bottom corner (BottomLeft / BottomRight) so the enlarged art + its enlarged tap halo stay glued to the corner
    // the game placed them in and never overlap the hand.
    public const double PileScale = 1.25;
    // Treasure-room relics +25%, stamped on the HOLDER so the co-op vote icons (multiplayer_vote_container.tscn nodes
    // parented under the holder) ride the same stamp for free. BottomCenter keeps the relic's feet pinned to the
    // pedestal it stands on while it grows upward.
    public const double TreasureRelicScale = 1.25;

    // ---- R9 (WS-B) factors -----------------------------------------------------------------------------------------
    // The "View Upgrades" toggle in the deck / card-detail dialogs — a ~196×48 checkbox row with a small tickbox, the
    // hardest-to-hit control on those screens at phone size. Each dialog pins it to the screen edge the game anchored
    // it to (deck: bottom-LEFT; card detail: bottom-CENTRE), so it grows inward from that edge and the tap halo never
    // leaves the dialog.
    //
    // R10 WS-F: the two dialogs now carry DIFFERENT factors (they were one 1.25 constant). Both were still reported as
    // too small to hit comfortably; the card-detail one can take more because it grows UP from a bottom-centred box
    // into the empty band under the card, while the deck one grows out of a bottom-left corner across the deck grid.
    //   deck view   1.35 about BottomLeft   → (16,1012)-(212.5,1060) becomes (16,995.2)-(281.3,1060)
    //   card detail 1.40 about BottomCenter → (816.5,990)-(1103.5,1054) becomes (759.1,964.4)-(1160.9,1054)
    // Both scaled boxes are wholly inside the 1920×1080 stage, so the on-screen clamp stays a no-op for each.
    public const double ViewUpgradesDeckScale = 1.35;
    public const double ViewUpgradesDetailScale = 1.40;

    // ---- WS-3 factor -------------------------------------------------------------------------------------------------
    // The map DRAWING-TOOLS palette +35% about its own CENTRE. Its design box is (56,972)-(264,1040) — a 208×68 strip
    // holding THREE ~60px buttons, the smallest tap row on the map. Centre pivot (not a corner) because the panel sits
    // in free space above the bottom edge, so it can splay symmetrically: 1.35 about (160,1006) →
    // (19.6,960.1)-(300.4,1051.9), still wholly inside the 1920×1080 stage. UNCLAMPED because the scaled box is already
    // on-stage (the clamp is a no-op on a 16:9 stage) and on a WIDENED stage the panel is rendered ½Δ to the right of
    // its design x — an axis clamp measured against the widened design width must never drag the panel off the map
    // content it is centred with (see SpreadIndex's DrawingTools centre claim).
    public const double DrawingToolsScale = 1.35;

    // Order = specificity (file-scoped entries first); first-match-wins. relPath "" matches a scene ROOT node.
    private static readonly Entry[] Entries =
    {
        // ---- WS6 reward PANEL: rewards_screen.tscn :: Rewards — one 1.2× GROUP about its own CENTRE. Replaces the old
        // per-ROW `new(Exact(RewardButton), [Exact("")], RewardListScale)` entry: the rows live inside this panel, so
        // they still render 1.2×, but the panel chrome rides the same stamp and the per-row on-screen clamp is gone.
        new(Exact(RewardsScreen), [Exact(RewardsPanelPath)], RewardListScale,
            IsGroup: true, Pivot: HoverTipScaleMath.AnchorPivot.Center),

        // ---- card-reward SELECTION screen (R4-round4): scale the whole screen root (cards + Skip/alternative row) as a
        // gentle 1.10 GROUP about its CENTRE, UNCLAMPED (NoClamp — the corner-pin came from AxisClamp on this full-
        // viewport box). Per-card 1.15 is added by ResolveFor's ancestry fallback (see IsCardRewardCard), NOT a table
        // entry — grid_card_holder.tscn is REUSED by the deck dialog, so a file-keyed card entry would over-match.
        // Root file verified from audit-cardreward-open.ndjson (card_reward_selection_screen.tscn, NCardRewardSelectionScreen).
        new(Exact(CardRewardSelectionScreen), [Exact("")], CardRewardGroupScale, IsGroup: true, NoClamp: true),

        // ---- shop (R19/R20): SlotsContainer holds the shop rug texture AND every merchant item — scale as ONE unit.
        // Verified from audit-shop.ndjson (SlotsContainer.texture == shop_rug.png; items are its descendants).
        // WS6 NoClamp: the container is 1747×978 (audit-shop-open.ndjson); even at the reduced 1.10 the scaled box is
        // 1922×1076, and a PARTIALLY parked panel (the closed shop mid-slide) still trips AxisClamp's "min < 0 ⇒ push
        // in" branch, which drags the whole panel back on-stage — the P4 phantom lever. The scaled box is at most ~2px
        // wider than the stage, so dropping the clamp costs nothing and keeps the growth exactly symmetric about the
        // container's own centre (the same reasoning as the card-reward whole-screen group).
        new(Exact(MerchantInventory), [Exact("SlotsContainer")], MerchantGroupScale, IsGroup: true, NoClamp: true),

        // ---- regular event (R7): OptionsContainer grows DOWN from its top. Suffix-matched (path verified only for the
        // ancient layout; the regular layout's nesting differs by layout — suffix is robust). GROUP.
        new(Exact(DefaultEventLayout), [Suffix("OptionsContainer")], EventOptionsScale,
            IsGroup: true, Pivot: HoverTipScaleMath.AnchorPivot.TopCenter),

        // ---- combat event (R6): the combat_event_layout.tscn also lists selectable options in an OptionsContainer that
        // grows DOWN from its top — same shape as the regular layout, so it mirrors that entry. Path verified from
        // audit-event.ndjson (combat_event_layout.tscn root → "VBoxContainer/OptionsContainer"); suffix-matched.
        new(Exact(CombatEventLayout), [Suffix("OptionsContainer")], EventOptionsScale,
            IsGroup: true, Pivot: HoverTipScaleMath.AnchorPivot.TopCenter),

        // ---- ancient event (R9): OptionsContainer grows UP from its bottom; the dialogue above lifts up to stay clear.
        // Paths verified from audit-mprun.ndjson.
        // R19 WP-4 NoClamp — SCALE ONLY, NEVER REPOSITION (web twin: viewScale.ts, same entry). While the dialogue
        // plays, the game PARKS this container below its `ContentContainer` and relies on that container's
        // `clip_contents` to hide it (no `visible`, no `modulate`), then slides it up on a position tween as the
        // last line resolves. The parked box still overlaps the design rect, so the fully-outside guard does not
        // reject it, and the on-screen clamp's "max > viewport ⇒ push in" branch then LIFTED the whole block back
        // on-stage (a worked case: 264 design px, straight on top of the dialogue). Same class as the shop
        // SlotsContainer P4-phantom lever: a clamp that rescues a deliberately-parked group is a reposition the
        // game never made. The BottomCenter pivot already pins the growth where the options rest.
        new(Exact(AncientEventLayout), [Exact("ContentContainer/Content/OptionsContainer")], EventOptionsScale,
            IsGroup: true, Pivot: HoverTipScaleMath.AnchorPivot.BottomCenter, NoClamp: true),
        new(Exact(AncientEventLayout), [Exact("ContentContainer/Content/DialogueContainer")], 1.0,
            IsGroup: true, TranslateY: AncientDialogueTranslateY),

        // ---- R8 map NODE (normal points only): the normal_map_point.tscn ROOT, 1.5× about its own centre, UNCLAMPED
        // (the map scrolls — a clamped point at the viewport edge would slide off its path). Per-item, NOT a group.
        // Ancient / boss points are deliberately absent (user decision: they already read big enough).
        new(Exact(NormalMapPoint), [Exact("")], MapPointScale, NoClamp: true),

        // ---- R8 map LEGEND: map_screen.tscn :: MapLegend, 1.2× GROUP pinned at its BOTTOM-RIGHT corner, UNCLAMPED.
        // Box (1656,289)-(1996,743) verified from probe-map-visible.ndjson (340×454, centre-anchored, no clip
        // ancestors). BottomRight+NoClamp keeps the panel's right/bottom edges exactly where the game put them and
        // grows the readable rows up/left into free screen space.
        new(Exact(MapScreen), [Exact("MapLegend")], MapLegendScale,
            IsGroup: true, Pivot: HoverTipScaleMath.AnchorPivot.BottomRight, NoClamp: true),

        // ---- WS-3 map DRAWING TOOLS: map_screen.tscn :: DrawingTools, 1.35× GROUP about its own CENTRE, UNCLAMPED.
        // Design box (56,972)-(264,1040) (recovered map_screen.tscn: anchors_preset 2, offsets 56/-108/264/-40 against
        // the 1080-tall canvas). Its three interior buttons ride the one stamp, so IsGroup — the group's interior IS
        // the tap surface. The scaled box (19.6,960.1)-(300.4,1051.9) is wholly on-stage, so NoClamp costs nothing
        // here and keeps the growth exactly symmetric about (160,1006) on a widened stage too.
        new(Exact(MapScreen), [Exact(DrawingToolsPath)], DrawingToolsScale,
            IsGroup: true, Pivot: HoverTipScaleMath.AnchorPivot.Center, NoClamp: true),

        // ---- R8 combat corner piles: 80×80 roots at (15,985) and (1826,985) (verified from the 16:37-10 combat
        // recording). Each grows inward from ITS OWN bottom corner so the enlarged button + halo stay corner-glued.
        new(Exact(DrawPile), [Exact("")], PileScale, Pivot: HoverTipScaleMath.AnchorPivot.BottomLeft),
        new(Exact(DiscardPile), [Exact("")], PileScale, Pivot: HoverTipScaleMath.AnchorPivot.BottomRight),

        // ---- R9 (WS-B) EXHAUST pile: the third 80×80 combat pile, at (1830,800)-(1910,880) — RIGHT-anchored but
        // mid-height, not a corner. MiddleRight pins its right edge at 1910 and splays the growth symmetrically
        // up/down: (1810,790)-(1910,890). Deliberately NOT NoClamp (unlike the map legend): the box sits wholly inside
        // the viewport and the scaled box still does, so the clamp is a no-op here and stays available as the
        // on-screen backstop if the game ever re-anchors the pile.
        new(Exact(ExhaustPile), [Exact("")], PileScale, Pivot: HoverTipScaleMath.AnchorPivot.MiddleRight),

        // ---- R9 (WS-B) deck dialog "View Upgrades": deck_view_screen.tscn :: ViewUpgrades — a MarginContainer
        // (mouseFilter PASS) at (16,1012)-(212.5,1060), a DIRECT child of the screen root, measured from
        // .sts2/bench/wscrisp-deckdialog.ndjson. BottomLeft pins the corner the game anchored it to so the enlarged
        // row grows right/up into the empty bottom-left margin instead of off the screen. Per-item, NOT a group: its
        // interior (the NUpgradePreviewTickbox + label) rides the one stamp.
        new(Exact(DeckViewScreen), [Exact("ViewUpgrades")], ViewUpgradesDeckScale,
            Pivot: HoverTipScaleMath.AnchorPivot.BottomLeft),

        // ---- R9 (WS-B) card-detail popup "View Upgrades": inspect_card_screen.tscn :: Upgrade — the tickbox itself
        // (mouseFilter STOP) at (816.5,990)-(1103.5,1054), horizontally centred on the screen. BottomCenter keeps it
        // centred under the card and grows it UPWARD toward the card instead of off the bottom edge:
        // (780.6,974)-(1139.4,1054). Per-item; the label child rides the stamp.
        new(Exact(InspectCardScreen), [Exact("Upgrade")], ViewUpgradesDetailScale,
            Pivot: HoverTipScaleMath.AnchorPivot.BottomCenter),
    };

    // The full resolution of a node's view-scale entry: factor + group flag + anchor + design-space translate. Neutral
    // (Scale 1, no translate) = not view-scaled. <see cref="IsActive"/> gates the consumer (a translate-only stamp is
    // active at Scale 1).
    public readonly record struct Resolved(
        double Scale, bool IsGroup, HoverTipScaleMath.AnchorPivot Pivot, double TranslateX, double TranslateY,
        bool NoClamp = false)
    {
        public bool IsActive => Scale > 1.0 || TranslateX != 0 || TranslateY != 0;

        public static readonly Resolved Neutral =
            new(1.0, false, HoverTipScaleMath.AnchorPivot.Center, 0, 0);
    }

    // Resolve a node's full view-scale entry from its scene identity (file, relPath) with an ANCESTRY fallback. The
    // caller gates the pass so this runs only when a view-scale screen is present. A table match (screen-root GROUP,
    // shop SlotsContainer, event OptionsContainer, reward-list row) wins; otherwise a card-reward SELECTION card
    // (an NCard whose ancestry passes through NCardRewardSelectionScreen) enlarges 1.15 about its OWN centre, UNCLAMPED
    // (NoClamp). The ancestry test is mandatory — grid_card_holder.tscn / card.tscn are reused by the deck dialog, so a
    // file-keyed card entry would over-match; only cards under the reward screen get the per-card bump.
    public static Resolved ResolveFor(string id, MirrorState state)
    {
        if (!state.Nodes.TryGetValue(id, out var self))
        {
            return Resolved.Neutral;
        }

        // R8 cost gate: the scene-identity walk allocates a List + a string.Join PER NODE, and the pass now runs on
        // every COMBAT drain (the draw/discard pile entries put their scene files in IsRootFile). Two shortcuts, both
        // exactly equivalent to the old `ResolveFor(SceneIdentity.Resolve(id, state))`:
        //   * a node that owns a SceneFilePath IS its scene root, so SceneIdentity.Resolve returns (that file, "") —
        //     no walk, no allocation;
        //   * any other node only needs the walk if it could match at all (MightMatchTable, DERIVED from Entries so it
        //     can never fall behind the table).
        // Measured on the 16:37-10 combat recording (3390 nodes): 3.78 → 0.63 ms per whole-tree pass (Release,
        // ScalePackReplayProbe's piles leg prints the number).
        var byTable = self.SceneFilePath is { } ownFile
            ? ResolveFor(ownFile, "")
            : MightMatchTable(self)
                ? ResolveFor(SceneIdentity.Resolve(id, state))
                : Resolved.Neutral;
        if (byTable.IsActive)
        {
            return byTable;
        }

        // Both leaf rules below share ONE leaf extraction + the node we already looked up (they used to re-resolve the
        // id and re-scan the type string; that was ~1 ms per combat drain on its own).
        int leaf = self.NodeType.LastIndexOf('.') + 1;

        // R8: the treasure-room relic HOLDER, matched by node-type LEAF (see IsTreasureRoomRelic). Not a table entry —
        // the holder's scene identity is truncated by the instanced relic/vote sub-scenes under it, and the vote
        // container's own scene is REUSED by the map points + the ProceedButton, so a file-keyed rule would over-match.
        if (LeafEquals(self.NodeType, leaf, TreasureRelicLeaf))
        {
            return new Resolved(
                TreasureRelicScale, false, HoverTipScaleMath.AnchorPivot.BottomCenter, 0, 0, NoClamp: true);
        }

        if (LeafEquals(self.NodeType, leaf, "NCard") && HasCardRewardScreenAncestor(self, state))
        {
            return new Resolved(CardRewardScale, false, HoverTipScaleMath.AnchorPivot.Center, 0, 0, NoClamp: true);
        }

        return byTable; // neutral
    }

    private static Resolved ResolveFor((string? File, string? RelPath) identity) =>
        ResolveFor(identity.File, identity.RelPath);

    // Direct (file, relPath) resolver — the same tuple the web stamps as data-scene-file / data-scene-node-path.
    public static Resolved ResolveFor(string? file, string? relPath)
    {
        if (relPath is null)
        {
            return Resolved.Neutral;
        }

        // R8 cost gate: when EVERY entry is scoped to an EXACT scene file (true today, asserted by ByFile's own
        // construction), the linear "does this node's file equal each entry's file" scan collapses to one hash probe.
        // An entry that ever drops its File condition — or uses a non-Exact op — sets ByFile null and restores the
        // linear scan below verbatim, so the index can never silently change the table's semantics.
        if (ByFile is { } index)
        {
            if (file is null || !index.TryGetValue(file, out var scoped))
            {
                return Resolved.Neutral; // every entry is file-scoped ⇒ an unknown/absent file matches nothing
            }

            foreach (var e in scoped)
            {
                if (PathMatches(e, relPath))
                {
                    return new Resolved(e.Scale, e.IsGroup, e.Pivot, e.TranslateX, e.TranslateY, e.NoClamp);
                }
            }

            return Resolved.Neutral;
        }

        foreach (var e in Entries)
        {
            if (e.File is { } fc && (file is null || !fc.Matches(file)))
            {
                continue;
            }

            bool allPath = true;
            foreach (var pc in e.Path)
            {
                if (!pc.Matches(relPath))
                {
                    allPath = false;
                    break;
                }
            }

            if (allPath)
            {
                return new Resolved(e.Scale, e.IsGroup, e.Pivot, e.TranslateX, e.TranslateY, e.NoClamp); // first match wins
            }
        }

        return Resolved.Neutral;
    }

    private static bool PathMatches(Entry e, string relPath)
    {
        foreach (var pc in e.Path)
        {
            if (!pc.Matches(relPath))
            {
                return false;
            }
        }

        return true;
    }

    // Entries grouped by their EXACT scene-file condition (source order preserved WITHIN a file, which is all
    // first-match-wins needs once the file discriminates). Null — and the linear scan stays in charge — as soon as any
    // entry is not exact-file-scoped.
    private static readonly Dictionary<string, Entry[]>? ByFile = BuildByFile();

    private static Dictionary<string, Entry[]>? BuildByFile()
    {
        var grouped = new Dictionary<string, List<Entry>>(StringComparer.Ordinal);
        foreach (var e in Entries)
        {
            if (e.File is not { Op: Op.Exact } fc)
            {
                return null; // an unscoped / non-exact entry → the index cannot be equivalent
            }

            if (!grouped.TryGetValue(fc.Value, out var list))
            {
                grouped[fc.Value] = list = [];
            }

            list.Add(e);
        }

        var index = new Dictionary<string, Entry[]>(grouped.Count, StringComparer.Ordinal);
        foreach (var (k, v) in grouped)
        {
            index[k] = v.ToArray();
        }

        return index;
    }

    // ---- R8 cheap pre-filter for ResolveFor(id, state) -------------------------------------------------------------
    // `SceneIdentity.Resolve` walks the parent chain and builds a List + string.Join for EVERY node it is asked about.
    // Before R8 the view-scale pass only ran on reward / card-reward / merchant / event screens, so that was fine; the
    // draw/discard pile entries now make the native presence gate true throughout COMBAT, where the same walk over
    // ~3400 nodes costs ~3.8 ms/drain (measured, ScalePackReplayProbe). This predicate answers "could ANY table entry
    // possibly match this node?" from the node alone, in O(entries) string compares and zero allocations.
    //
    // Soundness: it is DERIVED from Entries at static init, never hand-maintained.
    //   * an entry whose path is the scene ROOT ("") can only match a node that owns a SceneFilePath;
    //   * any other entry's path condition pins the LAST "/" segment of relPath, which IS the matched node's own Name
    //     (SceneIdentity joins node names) — so the condition reduces to a Name condition;
    //   * a condition that cannot be reduced that way (Prefix / Contains) turns the whole filter OFF (every node takes
    //     the slow path), so adding such an entry later can never silently drop a match;
    //   * a node with an EMPTY name contributes no relPath segment — so it can inherit its parent's tail — and always
    //     takes the slow path.
    private static readonly (HashSet<string> Exact, string[] Suffixes, bool Sound) NameFilter = BuildNameFilter();

    private static (HashSet<string> Exact, string[] Suffixes, bool Sound) BuildNameFilter()
    {
        var conds = new List<Cond>();
        foreach (var e in Entries)
        {
            Cond? reduced = null;
            bool rootOnly = false;
            foreach (var pc in e.Path)
            {
                if (pc.Op == Op.Exact && pc.Value.Length == 0)
                {
                    rootOnly = true; // relPath "" ⇒ the node IS a scene root ⇒ covered by the SceneFilePath test
                    break;
                }

                if (pc.Op is Op.Exact or Op.Suffix)
                {
                    int slash = pc.Value.LastIndexOf('/');
                    // Exact("A/B") and Suffix("A/B") both pin the last segment "B" exactly; Suffix("B") (no "/") only
                    // pins that the name ENDS with "B".
                    reduced = slash >= 0 || pc.Op == Op.Exact
                        ? new Cond(Op.Exact, slash >= 0 ? pc.Value[(slash + 1)..] : pc.Value)
                        : new Cond(Op.Suffix, pc.Value);
                    break;
                }
            }

            if (rootOnly)
            {
                continue;
            }

            if (reduced is not { } c)
            {
                // An un-reducible entry (Prefix/Contains only) → disable the filter entirely.
                return (new HashSet<string>(StringComparer.Ordinal), [], false);
            }

            conds.Add(c);
        }

        // Split into one hash set (the exact-name conditions) + a small suffix array, so the per-node test is one hash
        // probe plus a handful of EndsWith calls rather than a linear scan of every condition.
        var exact = new HashSet<string>(StringComparer.Ordinal);
        var suffixes = new List<string>();
        foreach (var c in conds)
        {
            if (c.Op == Op.Exact)
            {
                exact.Add(c.Value);
            }
            else
            {
                suffixes.Add(c.Value);
            }
        }

        return (exact, suffixes.ToArray(), true);
    }

    // True when `node` could match a table entry — cheap and conservative (false ⇒ provably no entry matches).
    private static bool MightMatchTable(MirrorNode node)
    {
        if (!NameFilter.Sound || node.SceneFilePath is not null || node.Name.Length == 0)
        {
            return true;
        }

        if (NameFilter.Exact.Contains(node.Name))
        {
            return true;
        }

        foreach (var s in NameFilter.Suffixes)
        {
            if (node.Name.EndsWith(s, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    // Convenience scale-only accessors (kept for the existing table tests + any caller that needs only the factor).
    public static double ScaleFor(string id, MirrorState state) => ResolveFor(id, state).Scale;

    public static double ScaleFor(string? file, string? relPath) => ResolveFor(file, relPath).Scale;

    // The scene-ROOT files carrying a table rule (at any relPath) — a CHEAP whole-pass presence gate (a SceneFilePath
    // string check on the OWNING scene root, no scene-identity walk) so the per-node resolve only runs on a
    // reward / card-reward / merchant / event screen. Each of these files is the scene ROOT whose root node streams
    // the SceneFilePath; the entries scoped to a non-root child (SlotsContainer, OptionsContainer) still live under
    // one of these roots, so the root's presence detects them.
    // R8 adds five map/combat/treasure files. Two of them carry NO root entry of their own and are listed purely as
    // presence gates for a rule that keys on something else: `map_screen.tscn` (its MapLegend child entry, so the
    // legend still scales on a map with no normal points left) and `treasure_relic_holder.tscn` (the LEAF rule —
    // exactly the card_reward_selection_screen precedent). draw_pile/discard_pile make the gate true throughout
    // COMBAT, which is the price of scaling the corner piles — see the ResolveFor(id, state) cost gate.
    // R9 adds the exhaust pile (its ROOT carries the entry; combat already kept the gate true via draw/discard, so it
    // costs nothing new) plus deck_view_screen.tscn and inspect_card_screen.tscn (MapScreen-style gates: each screen
    // root carries NO entry of its own, it exists so the View-Upgrades CHILD entry can resolve while that dialog is
    // open). NOTE inspect_card_screen.tscn's root node is streamed even while the popup is CLOSED, so this gate is
    // true on any screen that can open a card detail — the per-node pre-filter (MightMatchTable) is what keeps that
    // cheap.
    // WS6 swaps reward_button.tscn (whose ROOT used to carry the reward-row entry) for rewards_screen.tscn — a
    // MapScreen-style gate: the screen root carries NO entry of its own, it exists so the `Rewards` CHILD entry can
    // resolve while the rewards screen is open.
    public static bool IsRootFile(string file) =>
        file == RewardsScreen || file == CardRewardSelectionScreen || file == MerchantInventory
        || file == DefaultEventLayout || file == CombatEventLayout || file == AncientEventLayout
        || file == NormalMapPoint || file == MapScreen || file == DrawPile || file == DiscardPile
        || file == TreasureRelicHolder || file == ExhaustPile || file == DeckViewScreen
        || file == InspectCardScreen;

    // A card-reward SELECTION card: an NCard whose ancestry (inclusive) passes through an NCardRewardSelectionScreen.
    // Never a hand / shop / deck card (those screens are not this type). R4-round4: ResolveFor's ancestry fallback uses
    // this to scope the per-card 1.15 enlargement to reward cards only — hand / deck-dialog cards (same card.tscn /
    // grid_card_holder.tscn) are untouched because their ancestry never reaches an NCardRewardSelectionScreen.
    public static bool IsCardRewardCard(string id, MirrorState state)
    {
        if (!state.Nodes.TryGetValue(id, out var node)
            || !LeafEquals(node.NodeType, node.NodeType.LastIndexOf('.') + 1, "NCard"))
        {
            return false;
        }

        return HasCardRewardScreenAncestor(node, state);
    }

    private static bool HasCardRewardScreenAncestor(MirrorNode node, MirrorState state)
    {
        for (var cur = node; cur is not null;
             cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var p) ? p : null)
        {
            if (LeafEquals(cur.NodeType, cur.NodeType.LastIndexOf('.') + 1, CardRewardScreenLeaf))
            {
                return true;
            }
        }

        return false;
    }

    // R8: a treasure-room RELIC HOLDER — matched purely by node-type LEAF (`NTreasureRoomRelicHolder`), the same key
    // the touch classifier already uses (TouchTargetScan.TouchTargetTypes / web TOUCH_TARGET_TYPES). Leaf-based rather
    // than (file, relPath)-based on purpose: the relic art and the co-op vote widget are INSTANCED sub-scenes under the
    // holder, which truncates scene-relative paths, and `multiplayer_vote_container.tscn` is REUSED by the map and the
    // end-turn button, so keying the vote container's file would scale three unrelated screens. Stamping the HOLDER
    // also means the vote icons (its direct children) enlarge with it for free.
    public static bool IsTreasureRoomRelic(string id, MirrorState state) =>
        state.Nodes.TryGetValue(id, out var node)
        && LeafEquals(node.NodeType, node.NodeType.LastIndexOf('.') + 1, TreasureRelicLeaf);

    // Allocation-free "is the LEAF of `nodeType` (everything from `start`, i.e. after the last '.') exactly `leaf`?".
    // Both leaf rules run once per node per drain now that combat keeps the pass alive, so the old
    // substring-per-node form was replaced and the leaf offset is hoisted by the caller.
    private static bool LeafEquals(string nodeType, int start, string leaf) =>
        nodeType.Length - start == leaf.Length
        && string.CompareOrdinal(nodeType, start, leaf, 0, leaf.Length) == 0;

    // The EXACT inverse of a view-scale stamp: given a design-space pointer `p` that landed on the ENLARGED item,
    // return the TRUE (un-scaled) design coordinate the game hit-tests against. The forward stamp maps a true point q
    // to the displayed point `p = P + k·(q − P) + C` (pivot P, clamp C, factor k), so q = P + (p − C − P) / k. Pure +
    // unit-tested (round-trip, incl. k==1 translate-only); the input side applies it via ViewScaleInput.Remap ONCE at
    // the top of the router so every downstream stage sees the corrected point.
    public static (double X, double Y) InverseMapPoint(HoverTipScaleMath.Stamp stamp, double px, double py)
    {
        double k = stamp.Scale;
        if (k == 0)
        {
            return (px, py);
        }

        double x = stamp.PivotX + ((px - stamp.ClampX - stamp.PivotX) / k);
        double y = stamp.PivotY + ((py - stamp.ClampY - stamp.PivotY) / k);
        return (x, y);
    }
}
