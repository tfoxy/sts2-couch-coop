using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// #19 general view-scale table + the centre-pivot stamp + the input inverse. The match tests use the direct
// (file, relPath) overload (the same tuple SceneIdentity resolves); the inverse round-trip proves a design pointer
// on an enlarged item un-maps to its true coordinate, keeping the scaled item tappable.
internal static class ViewScaleTests
{
    private const double W = 1920, H = 1080;

    public static void Run()
    {
        RewardsPanelGroupMatches();
        ShopSlotsContainerMatches();
        CardRewardGroupRootMatches();
        CardRewardScreenStaysRootFile();
        EventOptionEntriesMatch();
        NonMatchingIsNeutral();
        CardRewardCardAncestryResolvesToPerCardScale();
        CenterStampScalesAboutCentre();
        CenterStampClampsOnScreen();
        CenterStampDegenerateBoxNull();
        AnchoredStampNoClampSkipsCorrection();
        CenterStampInvariantUnderCenterGrowth();
        AnchoredStampTopAndBottomPivots();
        AnchoredStampTranslateOnly();
        InverseUndoesCenterStamp();
        InverseUndoesClampedStamp();
        InverseUndoesTranslateOnlyStamp();
        InversePivotIsFixed();
        ParkedOffscreenBoxIsFullyOutsideRejectsStamp();
        // R8 (WS-1) scale pack.
        MapPointMatchesNormalOnly();
        MapLegendMatchesRightPinnedGroup();
        // WS-3 map drawing tools.
        DrawingToolsMatchesCenterGroup();
        DrawingToolsScaledBoxStaysOnStage();
        CombatPilesMatchCornerPivots();
        TreasureRelicLeafResolvesToRelicScale();
        NewRootFilesRegistered();
        // R9 (WS-B) scale pack 2.
        ExhaustPileMatchesMiddleRightEdgePivot();
        DeckViewUpgradesMatchesBottomLeft();
        CardDetailViewUpgradesMatchesBottomCenter();
        EndTurnButtonStaysViewScaleNeutral();
        PrefilteredResolveMatchesTheRawTable();
    }

    // R8 cost gate: ResolveFor(id, state) no longer runs the scene-identity walk for a node that provably cannot match
    // the table (the pass now stays alive through all of combat, where the walk cost ~3.8 ms per whole-tree pass). The
    // filter is DERIVED from the entry table, so this test just proves the two agree on a tree that exercises every
    // shape: a scene root that matches, a scene root that doesn't, a named child that matches, a named child that
    // doesn't, and a NAMELESS node (which inherits its parent's relPath tail and must stay on the slow path).
    private static void PrefilteredResolveMatchesTheRawTable()
    {
        var state = MirrorState.Create();
        void Add(string id, string? parent, string name, string? sceneFile = null, string type = "Control")
        {
            state.Nodes[id] = new MirrorNode
            {
                Id = id, ParentId = parent, Name = name, NodeType = type, Visible = true, SceneFilePath = sceneFile,
            };
            state.OrderedIds.Add(id);
        }

        Add("shop", null, "MerchantInventory", "res://scenes/merchant/merchant_inventory.tscn");
        Add("slots", "shop", "SlotsContainer");                      // named child, matches
        Add("item", "slots", "Item0");                               // named child, no match
        Add("mapScreen", null, "MapScreen", "res://scenes/screens/map/map_screen.tscn");
        Add("legend", "mapScreen", "MapLegend");                     // named child, matches
        Add("legendRow", "legend", "UnknownLegendItem");             // named child, no match
        Add("point", "mapScreen", "NormalMapPoint", "res://scenes/ui/normal_map_point.tscn"); // root, matches
        Add("icon", "point", "IconContainer");                       // named child under a matching root, no match
        Add("ancient", "mapScreen", "AncientMapPoint", "res://scenes/ui/ancient_map_point.tscn"); // root, no match
        Add("evt", null, "AncientEvent", "res://scenes/events/ancient_event_layout.tscn");
        Add("cc", "evt", "ContentContainer");
        Add("content", "cc", "Content");
        Add("opts", "content", "OptionsContainer");                  // exact multi-segment path, matches
        Add("nameless", "content", "");                              // NO name → inherits "…/Content" tail
        Add("namelessUnderOpts", "opts", "");                        // NO name → inherits "…/OptionsContainer" tail
        // R9 (WS-B): the deck dialog — a root that carries NO entry, its matching named child, and that child's own
        // interior (which must NOT double-scale).
        Add("deck", null, "DeckViewScreen", "res://scenes/screens/deck_view_screen.tscn");
        Add("viewUpgrades", "deck", "ViewUpgrades");                 // named child, matches
        Add("tickboxMargin", "viewUpgrades", "MarginContainer");     // interior, no match
        Add("exhaust", null, "ExhaustPile", "res://scenes/combat/exhaust_pile.tscn"); // root, matches
        Add("detail", null, "InspectCardScreen", "res://scenes/screens/inspect_card_screen.tscn");
        Add("upgradeTickbox", "detail", "Upgrade");                  // named child, matches
        Add("upgradeLabel", "upgradeTickbox", "ShowUpgradeLabel");   // interior, no match

        foreach (var id in state.OrderedIds)
        {
            var (file, relPath) = SceneIdentity.Resolve(id, state);
            var raw = ViewScale.ResolveFor(file, relPath); // the un-filtered table lookup
            if (raw.IsActive)
            {
                Check.That(ViewScale.ResolveFor(id, state) == raw,
                    $"pre-filtered resolve == raw table resolve for {id} ({file} :: {relPath})");
            }
        }

        // The interesting positives + the nameless edge case the filter deliberately keeps on the slow path.
        Check.Close(ViewScale.ResolveFor("slots", state).Scale, ViewScale.MerchantGroupScale, "prefilter keeps the shop SlotsContainer");
        Check.Close(ViewScale.ResolveFor("legend", state).Scale, ViewScale.MapLegendScale, "prefilter keeps the MapLegend");
        Check.Close(ViewScale.ResolveFor("point", state).Scale, ViewScale.MapPointScale, "prefilter keeps a map-point ROOT");
        Check.Close(ViewScale.ResolveFor("opts", state).Scale, ViewScale.EventOptionsScale, "prefilter keeps the ancient OptionsContainer");
        Check.Close(ViewScale.ResolveFor("namelessUnderOpts", state).Scale, ViewScale.EventOptionsScale,
            "a NAMELESS node inherits its parent's relPath tail and still resolves (the filter must not drop it)");
        Check.Close(ViewScale.ResolveFor("viewUpgrades", state).Scale, ViewScale.ViewUpgradesDeckScale,
            "prefilter keeps the deck dialog's ViewUpgrades child");
        Check.Close(ViewScale.ResolveFor("exhaust", state).Scale, ViewScale.PileScale,
            "prefilter keeps the exhaust pile ROOT");
        Check.Close(ViewScale.ResolveFor("upgradeTickbox", state).Scale, ViewScale.ViewUpgradesDetailScale,
            "prefilter keeps the card-detail popup's Upgrade tickbox");
        foreach (var id in new[]
                 { "item", "legendRow", "icon", "ancient", "nameless", "deck", "tickboxMargin", "detail", "upgradeLabel" })
        {
            Check.That(!ViewScale.ResolveFor(id, state).IsActive, $"{id} stays neutral under the pre-filter");
        }
    }

    // R8 (user decision): only NORMAL map points enlarge (56 → 84 design px). Ancient / boss points keep the game's
    // size, and the enlargement is UNCLAMPED because the map scrolls (a clamped point at the viewport edge would slide
    // off its own path). Per-item, NOT a group.
    private static void MapPointMatchesNormalOnly()
    {
        var r = ViewScale.ResolveFor("res://scenes/ui/normal_map_point.tscn", "");
        Check.Close(r.Scale, ViewScale.MapPointScale, "normal map point root → 1.5");
        Check.Close(r.Scale, 1.5, "map-point factor is 1.5 (56 → 84 design px)");
        Check.That(!r.IsGroup, "map point is a per-ITEM entry, not a group");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.Center, "map point grows about its own centre");
        Check.That(r.NoClamp, "map point is UNCLAMPED (the map scrolls — a clamp would slide it off its path)");
        // A nested child of the point (its icon) is NOT separately scaled — only the root, so the point scales once.
        Check.Close(ViewScale.ScaleFor("res://scenes/ui/normal_map_point.tscn", "IconContainer/Icon"), 1.0,
            "map-point icon → neutral (root only)");
        foreach (var other in new[] { "res://scenes/ui/ancient_map_point.tscn", "res://scenes/ui/boss_map_point.tscn" })
        {
            Check.Close(ViewScale.ScaleFor(other, ""), 1.0, $"{other} → neutral (normal points only)");
        }
    }

    // R8: map_screen.tscn :: MapLegend — a 1.2 GROUP pinned at its BOTTOM-RIGHT corner and UNCLAMPED. Its real box
    // (1656,289)-(1996,743) already overhangs the right edge, so a clamped centre pivot would drag it left.
    private static void MapLegendMatchesRightPinnedGroup()
    {
        var r = ViewScale.ResolveFor("res://scenes/screens/map/map_screen.tscn", "MapLegend");
        Check.Close(r.Scale, ViewScale.MapLegendScale, "map legend → 1.2");
        Check.That(r.IsGroup, "map legend scales as one rigid GROUP");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.BottomRight, "map legend pins its bottom-RIGHT corner");
        Check.That(r.NoClamp, "map legend is UNCLAMPED (its right edge is past 1920 by design)");
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/map/map_screen.tscn", ""), 1.0,
            "the map screen ROOT itself is never scaled");
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/map/map_screen.tscn", "TheMap/Points"), 1.0,
            "the map's Points container is never scaled (the points scale individually)");
    }

    // WS-3: map_screen.tscn :: DrawingTools — the draw/erase/clear palette, a NinePatchRect the map screen owns as a
    // plain child (recovered map_screen.tscn). 1.35 GROUP about its own CENTRE, UNCLAMPED. GROUP because its three
    // interior buttons (HBoxContainer/DrawButton|EraseButton|ClearButton) are the tap surfaces and must ride the one
    // stamp; CENTRE because the panel sits in free space above the bottom edge, so it can splay symmetrically.
    // Twin of the web viewScale.spec "WS-3: scales the map DrawingTools palette 1.35×…".
    private static void DrawingToolsMatchesCenterGroup()
    {
        var r = ViewScale.ResolveFor("res://scenes/screens/map/map_screen.tscn", "DrawingTools");
        Check.Close(r.Scale, ViewScale.DrawingToolsScale, "map drawing tools → 1.35");
        Check.Close(r.Scale, 1.35, "the drawing-tools factor is 1.35");
        Check.That(r.IsGroup, "drawing tools scale as one rigid GROUP (the three buttons ride the stamp)");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.Center, "drawing tools grow about their OWN centre");
        Check.That(r.NoClamp, "drawing tools are UNCLAMPED (the scaled box is already wholly on-stage)");
        Check.Close(r.TranslateX, 0, "drawing tools carry no X translate");
        Check.Close(r.TranslateY, 0, "drawing tools carry no Y translate");
        Check.That(r.IsActive, "the drawing-tools entry is active");

        // Only that child scales: not the screen root, not the palette's interior (which would double-scale the
        // buttons), and the name alone never scales a same-named node under a DIFFERENT scene file.
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/map/map_screen.tscn", ""), 1.0,
            "the map screen ROOT itself is never scaled");
        foreach (var rel in new[]
                 {
                     "DrawingTools/HBoxContainer",
                     "DrawingTools/HBoxContainer/DrawButton",
                     "DrawingTools/HBoxContainer/EraseButton",
                     "DrawingTools/HBoxContainer/ClearButton",
                 })
        {
            Check.Close(ViewScale.ScaleFor("res://scenes/screens/map/map_screen.tscn", rel), 1.0,
                $"{rel} is not separately scaled (it rides the DrawingTools group stamp)");
        }

        Check.Close(ViewScale.ScaleFor("res://scenes/screens/deck_view_screen.tscn", "DrawingTools"), 1.0,
            "a same-named node under a different scene file stays neutral (the entry is file-scoped)");

        // The NAME pre-filter (auto-derived from the table, never hand-maintained) must keep this entry reachable
        // through the cheap ResolveFor(id, state) path, and map_screen.tscn is already a registered root file.
        Check.That(ViewScale.IsRootFile("res://scenes/screens/map/map_screen.tscn"),
            "map_screen.tscn is the presence gate that lets the DrawingTools child entry resolve");

        var state = MirrorState.Create();
        state.Nodes["mapScreen"] = new MirrorNode
        {
            Id = "mapScreen", Name = "MapScreen", NodeType = "Control", Visible = true,
            SceneFilePath = "res://scenes/screens/map/map_screen.tscn",
        };
        state.Nodes["tools"] = new MirrorNode
        {
            Id = "tools", ParentId = "mapScreen", Name = "DrawingTools", NodeType = "NinePatchRect", Visible = true,
        };
        Check.Close(ViewScale.ResolveFor("tools", state).Scale, ViewScale.DrawingToolsScale,
            "the auto-derived NAME pre-filter keeps the DrawingTools child (candidate-name parity with the web set)");
    }

    // WS-3 sanity math: the real design box (56,972)-(264,1040) — recovered map_screen.tscn, anchors_preset 2 with
    // offsets 56/-108/264/-40 against the 1080-tall canvas — scaled 1.35 about its centre (160,1006) lands at
    // (19.6,960.1)-(300.4,1051.9): wholly inside the 1920×1080 stage, which is what makes NoClamp safe (the clamp is
    // a no-op on this box, so the flag only guarantees the growth stays exactly symmetric).
    private static void DrawingToolsScaledBoxStaysOnStage()
    {
        var r = ViewScale.ResolveFor("res://scenes/screens/map/map_screen.tscn", "DrawingTools");
        var box = new DesignAabb(56, 972, 264, 1040);
        var s = HoverTipScaleMath.ComputeAnchoredStamp(box, r.Scale, W, H, r.Pivot, r.TranslateX, r.TranslateY, r.NoClamp)!.Value;
        Check.Close(s.PivotX, 160, "drawing tools pivot X is the box centre (160)");
        Check.Close(s.PivotY, 1006, "drawing tools pivot Y is the box centre (1006)");
        Check.Close(s.ClampX, 0, "no X clamp correction (unclamped, and the box is in-bounds anyway)");
        Check.Close(s.ClampY, 0, "no Y clamp correction");

        var (minX, minY) = Forward(s, 56, 972);
        var (maxX, maxY) = Forward(s, 264, 1040);
        Check.Close(minX, 19.6, "drawing tools grow LEFT to 19.6");
        Check.Close(minY, 960.1, "drawing tools grow UP to 960.1");
        Check.Close(maxX, 300.4, "drawing tools grow RIGHT to 300.4");
        Check.Close(maxY, 1051.9, "drawing tools grow DOWN to 1051.9");
        Check.That(minX >= 0 && minY >= 0 && maxX <= W && maxY <= H,
            "the 1.35 box is wholly on-stage — so NoClamp can never push the panel off-screen");

        // The CLAMPED stamp is identical on this box: proof the NoClamp flag changes nothing here.
        var clamped = HoverTipScaleMath.ComputeAnchoredStamp(box, r.Scale, W, H, r.Pivot, r.TranslateX, r.TranslateY)!.Value;
        Check.That(clamped == s, "the clamp is a no-op on the drawing-tools box (clamped stamp == unclamped stamp)");
    }

    // R8: the two combat corner piles grow INWARD from their own bottom corner so the enlarged button + tap halo stay
    // glued to the screen corner. R9 (WS-B) adds the third pile — see ExhaustPileMatchesMiddleRightEdgePivot.
    private static void CombatPilesMatchCornerPivots()
    {
        var draw = ViewScale.ResolveFor("res://scenes/combat/draw_pile.tscn", "");
        Check.Close(draw.Scale, ViewScale.PileScale, "draw pile → 1.25");
        Check.That(draw.Pivot == HoverTipScaleMath.AnchorPivot.BottomLeft, "draw pile pins its bottom-LEFT corner");
        Check.That(!draw.IsGroup, "draw pile is a per-ITEM entry");

        var discard = ViewScale.ResolveFor("res://scenes/combat/discard_pile.tscn", "");
        Check.Close(discard.Scale, ViewScale.PileScale, "discard pile → 1.25");
        Check.That(discard.Pivot == HoverTipScaleMath.AnchorPivot.BottomRight, "discard pile pins its bottom-RIGHT corner");
        Check.That(!discard.IsGroup, "discard pile is a per-ITEM entry");

        Check.Close(ViewScale.ScaleFor("res://scenes/combat/draw_pile.tscn", "CountContainer/Count"), 1.0,
            "the pile COUNT label is not separately scaled (it rides the root stamp)");
    }

    // R9 (WS-B): the EXHAUST pile — the third combat pile, but the only one that is NOT in a screen corner. Its root
    // box (1830,800)-(1910,880) is pinned to the RIGHT edge at mid height, so it takes the new MiddleRight EDGE pivot:
    // pivot X at the right edge (like the discard pile) but pivot Y at the box CENTRE, splaying up AND down.
    // Deliberately NOT NoClamp — the scaled box stays inside the viewport, so the clamp is a no-op backstop.
    private static void ExhaustPileMatchesMiddleRightEdgePivot()
    {
        var r = ViewScale.ResolveFor("res://scenes/combat/exhaust_pile.tscn", "");
        Check.Close(r.Scale, ViewScale.PileScale, "exhaust pile → 1.25 (same factor as the two corner piles)");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.MiddleRight, "exhaust pile pins its RIGHT edge, mid-height");
        Check.That(!r.IsGroup, "exhaust pile is a per-ITEM entry (its count label rides the root stamp)");
        Check.That(!r.NoClamp, "exhaust pile keeps the on-screen clamp (unlike the map legend — its box is in-bounds)");
        Check.Close(ViewScale.ScaleFor("res://scenes/combat/exhaust_pile.tscn", "CountContainer/Count"), 1.0,
            "the exhaust COUNT label is not separately scaled (it rides the root stamp)");

        // The measured box, stamped: right edge pinned at 1910, growth left to 1810, splayed 790..890 about y=840.
        var box = new DesignAabb(1830, 800, 1910, 880);
        var s = HoverTipScaleMath.ComputeAnchoredStamp(box, r.Scale, W, H, r.Pivot, r.TranslateX, r.TranslateY, r.NoClamp)!.Value;
        var (rx, ry) = Forward(s, 1910, 880);
        Check.Close(rx, 1910, "exhaust: the right edge stays exactly where the game anchored it");
        Check.Close(ry, 890, "exhaust: the bottom splays DOWN to 890 (a corner pivot would have pinned it at 880)");
        Check.Close(Forward(s, 1830, 800).X, 1810, "exhaust grows LEFT to 1810");
        Check.Close(Forward(s, 1830, 800).Y, 790, "exhaust splays UP to 790");
    }

    // R9 (WS-B): the deck dialog's "View Upgrades" toggle — deck_view_screen.tscn :: ViewUpgrades, a MarginContainer
    // (mouseFilter PASS) at (16,1012)-(212.5,1060) measured from .sts2/bench/wscrisp-deckdialog.ndjson. R10 WS-F:
    // 1.35 (was 1.25) about its BOTTOM-LEFT corner so the enlarged row grows right/up into the empty bottom-left margin. The screen ROOT itself
    // carries no entry — it is registered as a root file purely so the native presence gate fires on the dialog.
    private static void DeckViewUpgradesMatchesBottomLeft()
    {
        var r = ViewScale.ResolveFor("res://scenes/screens/deck_view_screen.tscn", "ViewUpgrades");
        Check.Close(r.Scale, ViewScale.ViewUpgradesDeckScale, "deck View Upgrades → 1.35");
        // R10 WS-F: the deck dialog and the card-detail popup no longer share one factor — pin BOTH numbers here so a
        // future edit to either constant has to come past this test (and its web twin, viewScale.spec.ts).
        Check.Close(r.Scale, 1.35, "deck View-Upgrades factor is 1.35");
        Check.Close(ViewScale.ViewUpgradesDetailScale, 1.40, "card-detail View-Upgrades factor is 1.40");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.BottomLeft, "deck View Upgrades pins its bottom-LEFT corner");
        Check.That(!r.IsGroup, "deck View Upgrades is a per-ITEM entry (its tickbox + label ride the one stamp)");
        Check.That(!r.NoClamp, "deck View Upgrades keeps the on-screen clamp");

        // Only that child scales: neither the screen root nor the interior tickbox/label get their own stamp (which
        // would double-scale the row), and neither do the dialog's sort buttons.
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/deck_view_screen.tscn", ""), 1.0,
            "the deck screen ROOT itself is never scaled (it is only the presence gate)");
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/deck_view_screen.tscn", "ViewUpgrades/MarginContainer/Upgrades"), 1.0,
            "the interior NUpgradePreviewTickbox is not separately scaled (it rides the ViewUpgrades stamp)");
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/deck_view_screen/deck_view_sort_button.tscn", ""), 1.0,
            "the deck dialog's sort buttons stay neutral");
        // The name alone must not scale a same-named node on some OTHER screen — the entry is file-scoped.
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/map/map_screen.tscn", "ViewUpgrades"), 1.0,
            "a same-named node under a different scene file stays neutral (the entry is file-scoped)");

        // The measured box, stamped: bottom-left pinned at (16,1060), growth right/up.
        var box = new DesignAabb(16, 1012, 212.5, 1060);
        var s = HoverTipScaleMath.ComputeAnchoredStamp(box, r.Scale, W, H, r.Pivot, r.TranslateX, r.TranslateY, r.NoClamp)!.Value;
        Check.Close(Forward(s, 16, 1060).X, 16, "deck View Upgrades: left edge stays where the game anchored it");
        Check.Close(Forward(s, 16, 1060).Y, 1060, "deck View Upgrades: bottom edge stays where the game anchored it");
        Check.Close(Forward(s, 212.5, 1012).X, 281.275, "deck View Upgrades grows RIGHT: 16 + 1.35·196.5 = 281.275");
        Check.Close(Forward(s, 212.5, 1012).Y, 995.2, "deck View Upgrades grows UP: 1060 − 1.35·48 = 995.2");
        Check.Close(s.ClampX, 0, "deck View Upgrades: the 1.35 box stays on-screen (no clamp)");
        Check.Close(s.ClampY, 0, "deck View Upgrades: the 1.35 box stays on-screen (no clamp)");
    }

    // R9 (WS-B): the CARD-DETAIL popup's "View Upgrades" toggle — inspect_card_screen.tscn :: Upgrade. Same control as
    // the deck dialog's but a different name and shape (the NUpgradePreviewTickbox ITSELF, mouseFilter STOP, no
    // wrapping MarginContainer) and a different anchor: its box (816.5,990)-(1103.5,1054) is horizontally CENTRED on
    // the screen (centre x == 960), so it takes BottomCenter — pinning the bottom keeps it clear of the screen edge
    // and grows it upward toward the card. Measured live (no capture had this screen open before R9) — see
    // .sts2/bench/r9-carddetail.ndjson.
    private static void CardDetailViewUpgradesMatchesBottomCenter()
    {
        var r = ViewScale.ResolveFor("res://scenes/screens/inspect_card_screen.tscn", "Upgrade");
        Check.Close(r.Scale, ViewScale.ViewUpgradesDetailScale, "card-detail View Upgrades → 1.40");
        Check.Close(r.Scale, 1.40, "card-detail View-Upgrades factor is 1.40 (its own constant since R10 WS-F)");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.BottomCenter,
            "card-detail View Upgrades pins its BOTTOM centre (it is screen-centred, not corner-anchored)");
        Check.That(!r.IsGroup, "card-detail View Upgrades is a per-ITEM entry (its label rides the stamp)");
        Check.That(!r.NoClamp, "card-detail View Upgrades keeps the on-screen clamp");

        // Nothing else on the popup scales — in particular not the inspected CARD, the arrows or the label child.
        foreach (var rel in new[] { "", "Backstop", "HoverTipRect", "LeftArrow", "RightArrow", "Upgrade/ShowUpgradeLabel" })
        {
            Check.Close(ViewScale.ScaleFor("res://scenes/screens/inspect_card_screen.tscn", rel), 1.0,
                $"inspect_card_screen :: '{rel}' stays neutral (only the Upgrade tickbox is stamped)");
        }

        // The two dialogs' entries must not cross-match: each name only resolves under its OWN scene file.
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/inspect_card_screen.tscn", "ViewUpgrades"), 1.0,
            "the deck's node NAME does not resolve under the card-detail screen");
        Check.Close(ViewScale.ScaleFor("res://scenes/screens/deck_view_screen.tscn", "Upgrade"), 1.0,
            "the card detail's node NAME does not resolve under the deck screen");
        Check.That(ViewScale.IsRootFile("res://scenes/screens/inspect_card_screen.tscn"),
            "inspect_card_screen is a ROOT file (the presence gate for its child entry)");

        // The measured box, stamped: bottom pinned at 1054, centre X 960 held, grown up to 974.
        var box = new DesignAabb(816.5, 990, 1103.5, 1054);
        var s = HoverTipScaleMath.ComputeAnchoredStamp(box, r.Scale, W, H, r.Pivot, r.TranslateX, r.TranslateY, r.NoClamp)!.Value;
        Check.Close(s.PivotX, 960, "card-detail: pivot X is the box centre, which IS the screen centre");
        Check.Close(s.PivotY, 1054, "card-detail: pivot Y is the box bottom");
        Check.Close(s.ClampX, 0, "card-detail: the scaled box stays on-screen (no clamp)");
        Check.Close(s.ClampY, 0, "card-detail: the scaled box stays on-screen (no clamp)");
        Check.Close(Forward(s, 816.5, 1054).X, 759.1, "card-detail grows LEFT: 960 − 1.40·143.5 = 759.1");
        Check.Close(Forward(s, 1103.5, 1054).X, 1160.9, "card-detail grows RIGHT: 960 + 1.40·143.5 = 1160.9");
        Check.Close(Forward(s, 816.5, 990).Y, 964.4, "card-detail grows UP: 1054 − 1.40·64 = 964.4");
        Check.Close(Forward(s, 816.5, 1054).Y, 1054, "card-detail: the bottom edge stays where the game anchored it");
    }

    // R8: the treasure-room relic HOLDER is matched by node-type LEAF, not (file, relPath) — the relic art + the co-op
    // vote widget are instanced sub-scenes under it. The vote container's own scene is reused elsewhere, so only the
    // holder leaf resolves; its children (the vote icons) ride the holder's stamp instead of getting their own.
    private static void TreasureRelicLeafResolvesToRelicScale()
    {
        var state = MirrorState.Create();
        void Add(string id, string? parent, string type, string? sceneFile = null)
        {
            state.Nodes[id] = new MirrorNode
            {
                Id = id,
                ParentId = parent,
                NodeType = type,
                Name = id,
                Visible = true,
                SceneFilePath = sceneFile,
            };
            state.OrderedIds.Add(id);
        }

        // The streamed shape a treasure room arrives in: each relic holder is an instance of
        // treasure_relic_holder.tscn carrying its relic art and a vote container as direct children, and the room
        // carries a SECOND vote container elsewhere (the skip/proceed control) that must NOT be stamped.
        Add("room", null, "MegaCrit.Sts2.Core.Nodes.Rooms.NTreasureRoom", "res://scenes/rooms/treasure_room.tscn");
        Add("holder", "room", "MegaCrit.Sts2.Core.Nodes.Screens.TreasureRoomRelic.NTreasureRoomRelicHolder",
            "res://scenes/ui/treasure_relic_holder.tscn");
        Add("art", "holder", "TextureRect");
        Add("vote", "holder", "MegaCrit.Sts2.Core.Nodes.NMultiplayerVoteContainer",
            "res://scenes/ui/multiplayer_vote_container.tscn");
        Add("elsewhereVote", "room", "MegaCrit.Sts2.Core.Nodes.NMultiplayerVoteContainer",
            "res://scenes/ui/multiplayer_vote_container.tscn");

        var r = ViewScale.ResolveFor("holder", state);
        Check.Close(r.Scale, ViewScale.TreasureRelicScale, "treasure relic holder → 1.25");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.BottomCenter, "treasure relic grows UP from its bottom");
        Check.That(!r.IsGroup, "treasure relic holder is a per-ITEM stamp (its children ride it)");
        Check.That(r.NoClamp, "treasure relic is UNCLAMPED (an edge relic must not slide off its pedestal)");
        Check.That(ViewScale.IsTreasureRoomRelic("holder", state), "the leaf predicate identifies the holder");
        // The holder's OWN scene file carries no table entry — it is registered only so the native presence gate fires
        // on a treasure room (the card_reward_selection_screen precedent). Without it the whole pass early-outs there.
        Check.That(ViewScale.IsRootFile("res://scenes/ui/treasure_relic_holder.tscn"),
            "treasure_relic_holder is a ROOT file (the presence gate that lets the leaf rule run)");
        Check.Close(ViewScale.ScaleFor("res://scenes/ui/treasure_relic_holder.tscn", ""), 1.0,
            "treasure_relic_holder carries NO table entry (the leaf rule does the work)");

        // Nothing else on the screen picks up a stamp — in particular NOT the vote container (its scene is reused by
        // the map points + the ProceedButton, which is exactly why the rule keys the holder leaf instead of that file).
        foreach (var id in new[] { "room", "art", "vote", "elsewhereVote" })
        {
            Check.That(!ViewScale.ResolveFor(id, state).IsActive, $"{id} resolves NEUTRAL (only the holder is stamped)");
            Check.That(!ViewScale.IsTreasureRoomRelic(id, state), $"{id} is not a treasure relic holder");
        }
    }

    // R8/R9: every newly-scaled scene must be a ROOT file, or the native presence gate (AnyViewScaleScenePresent)
    // early-outs the whole pass and none of the new entries ever stamp. map_screen.tscn and (R9) deck_view_screen.tscn
    // carry no root entry themselves — they are registered purely as the gate for a CHILD entry (MapLegend /
    // ViewUpgrades).
    private static void NewRootFilesRegistered()
    {
        foreach (var f in new[]
                 {
                     "res://scenes/ui/normal_map_point.tscn",
                     "res://scenes/screens/map/map_screen.tscn",
                     "res://scenes/combat/draw_pile.tscn",
                     "res://scenes/combat/discard_pile.tscn",
                     // R9 (WS-B): the exhaust pile carries its own ROOT entry; the two dialog screens are
                     // child-entry gates.
                     "res://scenes/combat/exhaust_pile.tscn",
                     "res://scenes/screens/deck_view_screen.tscn",
                     "res://scenes/screens/inspect_card_screen.tscn",
                 })
        {
            Check.That(ViewScale.IsRootFile(f), $"{f} is a view-scale ROOT file (presence gate)");
        }

        Check.That(!ViewScale.IsRootFile("res://scenes/ui/ancient_map_point.tscn"),
            "ancient map point is NOT a root file (it carries no rule)");
        Check.That(!ViewScale.IsRootFile("res://scenes/screens/deck_view_screen/deck_view_sort_button.tscn"),
            "the deck dialog's sort button is NOT a root file (it carries no rule)");
    }

    // R8 item 12 is a TEXT-scale change only: the end-turn button must stay VIEW-scale neutral at every level (root,
    // visuals, label) so the button box itself never moves.
    private static void EndTurnButtonStaysViewScaleNeutral()
    {
        foreach (var rel in new[] { "", "Visuals", "Visuals/Label" })
        {
            Check.Close(ViewScale.ScaleFor("res://scenes/combat/end_turn_button.tscn", rel), 1.0,
                $"end_turn_button :: '{rel}' stays view-scale neutral (item 12 is text-scale only)");
        }

        Check.That(!ViewScale.IsRootFile("res://scenes/combat/end_turn_button.tscn"),
            "end_turn_button is not a view-scale root file");
    }

    // WS6: the post-combat rewards PANEL (rewards_screen.tscn :: Rewards) is one centre-pivot GROUP at the reward-list
    // factor. The old per-ROW reward_button.tscn entry is gone — a reward row now rides the panel stamp, so a
    // file-keyed reward_button lookup must resolve NEUTRAL (and the file is no longer a presence-gate root file).
    private static void RewardsPanelGroupMatches()
    {
        var r = ViewScale.ResolveFor("res://scenes/screens/rewards_screen.tscn", "Rewards");
        Check.Close(r.Scale, ViewScale.RewardListScale, "rewards_screen :: Rewards → reward-list scale");
        Check.That(r.IsGroup, "the rewards panel entry is a GROUP (its rows ride the one stamp)");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.Center, "the rewards panel grows about its own centre");
        Check.That(!r.NoClamp, "the rewards panel keeps the on-screen clamp (its scaled box is wholly on-stage)");
        Check.Close(
            ViewScale.ScaleFor("res://scenes/screens/rewards_screen.tscn", ""),
            1.0,
            "rewards_screen ROOT itself → neutral (the panel child carries the entry)");
        Check.That(ViewScale.IsRootFile("res://scenes/screens/rewards_screen.tscn"),
            "rewards_screen is a presence-gate root file (so its Rewards CHILD can resolve)");

        Check.Close(
            ViewScale.ScaleFor("res://scenes/rewards/reward_button.tscn", ""),
            1.0,
            "reward_button root → neutral (the per-ROW entry was replaced by the panel GROUP)");
        Check.Close(
            ViewScale.ScaleFor("res://scenes/rewards/reward_button.tscn", "LabelContainer/Label"),
            1.0,
            "reward_button nested label → neutral");
        Check.That(!ViewScale.IsRootFile("res://scenes/rewards/reward_button.tscn"),
            "reward_button is no longer a view-scale root file");
    }

    // R19/R20: the shop scales the merchant_inventory SlotsContainer (rug + all items) as ONE group; the old per-item
    // scene roots are no longer view-scaled.
    private static void ShopSlotsContainerMatches()
    {
        var r = ViewScale.ResolveFor("res://scenes/merchant/merchant_inventory.tscn", "SlotsContainer");
        Check.Close(r.Scale, ViewScale.MerchantGroupScale, "merchant SlotsContainer → shop group scale");
        Check.That(r.IsGroup, "SlotsContainer entry is a GROUP");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.Center, "SlotsContainer group grows about centre");
        // WS6: 1747×978 at 1.2 is 2096×1174 — bigger than the 1920×1080 stage on BOTH axes, so AxisClamp could only
        // ever pin one edge and crop the whole overflow off the other side (and it was the lever that pulled a
        // CLOSING panel back on-stage off a stale measure).
        Check.That(r.NoClamp, "the shop SlotsContainer group is UNCLAMPED (its scaled box cannot fit the stage)");
        Check.Close(ViewScale.ScaleFor("res://scenes/merchant/merchant_inventory.tscn", ""), 1.0, "merchant root itself → neutral");
        foreach (var file in new[]
                 {
                     "res://scenes/merchant/merchant_card.tscn",
                     "res://scenes/merchant/merchant_potion.tscn",
                     "res://scenes/merchant/merchant_relic.tscn",
                     "res://scenes/merchant/merchant_card_removal.tscn",
                 })
        {
            Check.Close(ViewScale.ScaleFor(file, ""), 1.0, $"{file} root → neutral (per-item entries removed)");
        }
    }

    // R4-round4: the card-reward SELECTION screen ROOT is a gentle 1.10 centre GROUP, UNCLAMPED (NoClamp). A file-keyed
    // card.tscn lookup stays neutral (per-card scaling is ancestry-driven, not file-keyed — see the ancestry test).
    private static void CardRewardGroupRootMatches()
    {
        var r = ViewScale.ResolveFor("res://scenes/screens/card_selection/card_reward_selection_screen.tscn", "");
        Check.Close(r.Scale, ViewScale.CardRewardGroupScale, "card-reward screen root → group scale 1.10");
        Check.Close(r.Scale, 1.10, "card-reward group factor is 1.10 (gentle container)");
        Check.That(r.IsGroup, "card-reward screen root is a GROUP");
        Check.That(r.Pivot == HoverTipScaleMath.AnchorPivot.Center, "card-reward group grows about centre");
        Check.That(r.NoClamp, "card-reward group is UNCLAMPED (NoClamp — the corner-pin came from AxisClamp)");
        // A card.tscn instance resolved by FILE (no state/ancestry) is neutral — grid_card_holder.tscn is reused by the
        // deck dialog, so a file-keyed card entry would over-match; the per-card bump is ancestry-only.
        Check.Close(ViewScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/Frame"), 1.0, "reward card by FILE → neutral (per-card is ancestry-driven)");
        Check.Close(ViewScale.ScaleFor("res://scenes/cards/holders/grid_card_holder.tscn", ""), 1.0, "grid_card_holder by FILE → neutral (reused by deck dialog)");
    }

    // R4-round4: the card-reward selection screen stays a ROOT file (the presence gate that lets the ancestry per-card
    // rule run), even though the group is now a table entry keyed on it.
    private static void CardRewardScreenStaysRootFile()
    {
        Check.That(ViewScale.IsRootFile("res://scenes/screens/card_selection/card_reward_selection_screen.tscn"),
            "card-reward selection screen is a view-scale ROOT file (presence gate for the ancestry rule)");
    }

    // R7/R9: event OptionsContainer entries — regular grows DOWN from top, ancient grows UP from bottom, ancient
    // dialogue is a pure translate-up (scale 1) via the clamp channel.
    private static void EventOptionEntriesMatch()
    {
        // Regular event: suffix-matched OptionsContainer, TopCenter.
        var reg = ViewScale.ResolveFor("res://scenes/events/default_event_layout.tscn", "VBoxContainer/OptionsContainer");
        Check.Close(reg.Scale, ViewScale.EventOptionsScale, "regular-event OptionsContainer → 1.2");
        Check.That(reg.IsGroup && reg.Pivot == HoverTipScaleMath.AnchorPivot.TopCenter, "regular options grow DOWN from top");

        // R6 combat event: same shape as the regular layout — suffix-matched OptionsContainer, TopCenter GROUP.
        // Path taken verbatim from audit-event.ndjson (combat_event_layout.tscn root → "VBoxContainer/OptionsContainer").
        var cmb = ViewScale.ResolveFor("res://scenes/events/combat_event_layout.tscn", "VBoxContainer/OptionsContainer");
        Check.Close(cmb.Scale, ViewScale.EventOptionsScale, "combat-event OptionsContainer → 1.2");
        Check.That(cmb.IsGroup && cmb.Pivot == HoverTipScaleMath.AnchorPivot.TopCenter, "combat options grow DOWN from top");
        Check.That(ViewScale.IsRootFile("res://scenes/events/combat_event_layout.tscn"),
            "combat_event_layout is a view-scale ROOT file (else the whole pass early-outs on a combat-event screen)");

        // Ancient event: exact path, BottomCenter.
        var anc = ViewScale.ResolveFor("res://scenes/events/ancient_event_layout.tscn", "ContentContainer/Content/OptionsContainer");
        Check.Close(anc.Scale, ViewScale.EventOptionsScale, "ancient-event OptionsContainer → 1.2");
        Check.That(anc.IsGroup && anc.Pivot == HoverTipScaleMath.AnchorPivot.BottomCenter, "ancient options grow UP from bottom");

        // Ancient dialogue: scale 1, negative translateY (a translate-only, still IsActive).
        var dlg = ViewScale.ResolveFor("res://scenes/events/ancient_event_layout.tscn", "ContentContainer/Content/DialogueContainer");
        Check.Close(dlg.Scale, 1.0, "ancient dialogue is not scaled");
        Check.Close(dlg.TranslateY, ViewScale.AncientDialogueTranslateY, "ancient dialogue lifts up by the hardcoded amount");
        Check.That(dlg.TranslateY < 0 && dlg.IsActive, "ancient dialogue translate is active (up) even at scale 1");
    }

    // A hand card (reusable card.tscn, no view-scale scope) and an unscoped node are neutral; relPath null (not in a
    // scene) is neutral.
    private static void NonMatchingIsNeutral()
    {
        Check.Close(ViewScale.ScaleFor("res://scenes/cards/card.tscn", "CardContainer/DescriptionLabel"), 1.0, "hand card → neutral");
        Check.Close(ViewScale.ScaleFor("res://scenes/combat/end_turn_button.tscn", "Visuals/Label"), 1.0, "end-turn → neutral");
        Check.Close(ViewScale.ScaleFor(null, (string?)null), 1.0, "no scene identity → neutral");
    }

    // R4-round4: ResolveFor(id, state) restores the per-card 1.15 via ANCESTRY — an NCard under NCardRewardSelectionScreen
    // enlarges 1.15 about its own centre, unclamped, NOT a group; an identically-typed HAND card (same NCard node type,
    // same card.tscn) stays neutral because its ancestry never reaches the reward screen (the deck-dialog-reuse guard).
    private static void CardRewardCardAncestryResolvesToPerCardScale()
    {
        var state = MirrorState.Create();
        void Add(string id, string? parent, string type, string? sceneFile = null)
        {
            state.Nodes[id] = new MirrorNode
            {
                Id = id, ParentId = parent, NodeType = type, Name = id, Visible = true, SceneFilePath = sceneFile,
            };
            state.OrderedIds.Add(id);
        }

        Add("screen", null, "MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NCardRewardSelectionScreen",
            "res://scenes/screens/card_selection/card_reward_selection_screen.tscn");
        Add("grid", "screen", "MegaCrit.Sts2.Core.Nodes.Cards.Holders.NGridCardHolder",
            "res://scenes/cards/holders/grid_card_holder.tscn");
        Add("card", "grid", "MegaCrit.Sts2.Core.Nodes.Cards.NCard", "res://scenes/cards/card.tscn");
        Add("art", "card", "Godot.Sprite2D");
        Add("hand", null, "MegaCrit.Sts2.Core.Nodes.Combat.NPlayerHand");
        Add("handcard", "hand", "MegaCrit.Sts2.Core.Nodes.Cards.NCard", "res://scenes/cards/card.tscn");

        Check.That(ViewScale.IsCardRewardCard("card", state), "NCard under NCardRewardSelectionScreen → card reward");
        Check.That(!ViewScale.IsCardRewardCard("handcard", state), "hand card (no reward-screen ancestor) → not a card reward");
        Check.That(!ViewScale.IsCardRewardCard("art", state), "the Sprite2D art child is not an NCard leaf → not a card reward");

        // The full resolve: the reward card gets 1.15, per-item (not group), Center, unclamped.
        var rc = ViewScale.ResolveFor("card", state);
        Check.Close(rc.Scale, ViewScale.CardRewardScale, "reward card resolves the per-card 1.15 by ancestry");
        Check.Close(rc.Scale, 1.15, "per-card factor is 1.15");
        Check.That(!rc.IsGroup, "per-card stamp is NOT a group (publishes IsGroup:false)");
        Check.That(rc.Pivot == HoverTipScaleMath.AnchorPivot.Center, "per-card grows about the card's own centre");
        Check.That(rc.NoClamp, "per-card stamp is unclamped (exact centre scale)");

        // The reward SCREEN ROOT still resolves the group (table match wins over the ancestry fallback).
        var grp = ViewScale.ResolveFor("screen", state);
        Check.Close(grp.Scale, ViewScale.CardRewardGroupScale, "reward screen root → 1.10 group (table wins)");
        Check.That(grp.IsGroup && grp.NoClamp, "reward screen root group is a NoClamp group");

        // A hand card (same node type + same card.tscn, no reward ancestry) stays neutral.
        Check.Close(ViewScale.ResolveFor("handcard", state).Scale, 1.0, "hand card → neutral (deck-dialog-reuse guard)");
    }

    // ComputeCenterStamp pivots at the box centre; a well-inside box needs no clamp.
    private static void CenterStampScalesAboutCentre()
    {
        var box = new DesignAabb(1000, 400, 1200, 500); // centre (1100, 450)
        var s = HoverTipScaleMath.ComputeCenterStamp(box, 1.15, W, H);
        Check.That(s is not null, "center stamp produced");
        Check.Close(s!.Value.PivotX, 1100, "center stamp: pivot X == box centre X");
        Check.Close(s.Value.PivotY, 450, "center stamp: pivot Y == box centre Y");
        Check.Close(s.Value.ClampX, 0, "center stamp: no horizontal clamp (in bounds)");
        Check.Close(s.Value.ClampY, 0, "center stamp: no vertical clamp (in bounds)");
    }

    // A box hugging the right edge whose scaled box overflows is pushed back in-bounds by the clamp.
    private static void CenterStampClampsOnScreen()
    {
        // Box x∈[1820,1900] centre 1860; scaled right = 1860 + 1.2·40 = 1908 ≤ 1920, scaled left 1812 — fits. Push it
        // out: x∈[1860,1920] centre 1890, scaled right = 1890 + 1.2·30 = 1926 > 1920 → clampX = 1920 − 1926 = −6.
        var box = new DesignAabb(1860, 400, 1920, 500);
        var s = HoverTipScaleMath.ComputeCenterStamp(box, 1.2, W, H);
        Check.That(s is not null, "edge center stamp produced");
        Check.Close(s!.Value.ClampX, -6, "center stamp: scaled right edge pushed back in-bounds by 6px");
    }

    private static void CenterStampDegenerateBoxNull()
    {
        Check.That(HoverTipScaleMath.ComputeCenterStamp(new DesignAabb(100, 100, 100, 200), 1.2, W, H) is null,
            "zero-width box → no center stamp");
        Check.That(HoverTipScaleMath.ComputeCenterStamp(new DesignAabb(100, 100, 200, 100), 1.2, W, H) is null,
            "zero-height box → no center stamp");
    }

    // R4-round4 NoClamp: a full-viewport box scaled >1 corner-pins under the on-screen clamp (the round-3 regression),
    // but NoClamp forces clamp==0 (a pure centre scale, symmetric crop) so the interior stays centred.
    private static void AnchoredStampNoClampSkipsCorrection()
    {
        // The whole card-reward screen box (0,0,1920,1080) scaled 1.10 about its centre overflows every edge.
        var box = new DesignAabb(0, 0, W, H);
        var clamped = HoverTipScaleMath.ComputeAnchoredStamp(box, 1.10, W, H, HoverTipScaleMath.AnchorPivot.Center)!.Value;
        // Clamped: AxisClamp pins the leading edge (hi-lo>extent → return −lo), dragging the box down-right (the corner-pin).
        Check.That(clamped.ClampX != 0 || clamped.ClampY != 0, "clamped full-viewport 1.10 box corner-pins (non-zero clamp)");

        var noClamp = HoverTipScaleMath.ComputeAnchoredStamp(box, 1.10, W, H, HoverTipScaleMath.AnchorPivot.Center, 0, 0, noClamp: true)!.Value;
        Check.Close(noClamp.ClampX, 0, "NoClamp: no horizontal clamp (symmetric crop, no corner-pin)");
        Check.Close(noClamp.ClampY, 0, "NoClamp: no vertical clamp");
        Check.Close(noClamp.PivotX, 960, "NoClamp: pivot stays the box centre X");
        Check.Close(noClamp.PivotY, 540, "NoClamp: pivot stays the box centre Y");
        Check.Close(noClamp.Scale, 1.10, "NoClamp: factor preserved");
    }

    // R4-round4 Center-invariance LEMMA (the Q5 answer): a Center-pivot NoClamp stamp depends ONLY on the box CENTRE.
    // A focus animation that grows the box about its own centre leaves the centre fixed, so the stamp is IDENTICAL
    // across the growth (scale + pivot + clamp all unchanged) — i.e. a constant stamp renders M(t)=S·G(t): the growth
    // anchor is whatever the game's tween does, never re-anchored by the view scale. Holding the stamp constant across
    // the tween (the sticky-stamp guard) is therefore free of pop.
    private static void CenterStampInvariantUnderCenterGrowth()
    {
        // A card centred at (959, 616), growing about its centre from a 240×338 face to a 312×439 (1.3×) focus size.
        const double cx = 959, cy = 616;
        DesignAabb Centred(double hw, double hh) => new(cx - hw, cy - hh, cx + hw, cy + hh);
        var small = HoverTipScaleMath.ComputeAnchoredStamp(Centred(120, 169), 1.15, W, H, HoverTipScaleMath.AnchorPivot.Center, 0, 0, noClamp: true)!.Value;
        var grown = HoverTipScaleMath.ComputeAnchoredStamp(Centred(156, 220), 1.15, W, H, HoverTipScaleMath.AnchorPivot.Center, 0, 0, noClamp: true)!.Value;
        Check.Close(grown.PivotX, small.PivotX, "center-growth: pivot X invariant (== box centre)");
        Check.Close(grown.PivotY, small.PivotY, "center-growth: pivot Y invariant (== box centre)");
        Check.Close(grown.ClampX, small.ClampX, "center-growth: clamp X invariant (0, NoClamp)");
        Check.Close(grown.ClampY, small.ClampY, "center-growth: clamp Y invariant (0, NoClamp)");
        Check.Close(grown.Scale, small.Scale, "center-growth: scale invariant");
        Check.Close(small.PivotX, cx, "the invariant stamp pivot IS the fixed box centre X");
        Check.Close(small.PivotY, cy, "the invariant stamp pivot IS the fixed box centre Y");
    }

    // R7/R9: TopCenter pins the box TOP (grows down), BottomCenter pins the box BOTTOM (grows up); pivot X stays the
    // box centre for both.
    private static void AnchoredStampTopAndBottomPivots()
    {
        var box = new DesignAabb(600, 750, 1400, 1042); // centre X 1000
        var top = HoverTipScaleMath.ComputeAnchoredStamp(box, 1.2, W, H, HoverTipScaleMath.AnchorPivot.TopCenter)!.Value;
        Check.Close(top.PivotX, 1000, "top-center: pivot X == box centre");
        Check.Close(top.PivotY, 750, "top-center: pivot Y == box TOP (grows down)");
        var bot = HoverTipScaleMath.ComputeAnchoredStamp(box, 1.2, W, H, HoverTipScaleMath.AnchorPivot.BottomCenter)!.Value;
        Check.Close(bot.PivotX, 1000, "bottom-center: pivot X == box centre");
        Check.Close(bot.PivotY, 1042, "bottom-center: pivot Y == box BOTTOM (grows up)");
        // The scaled box grows UP from the pinned bottom: top edge = 1042 + 1.2·(750−1042) = 691.6, in-bounds → clampY 0.
        Check.Close(bot.ClampY, 0, "bottom-center in-bounds → no vertical clamp");
    }

    // R9 dialogue: a pure translate (scale 1) rides the clamp channel; the box stays on-screen so the clamp == the
    // requested translate.
    private static void AnchoredStampTranslateOnly()
    {
        var box = new DesignAabb(727, 654, 1527, 738);
        var s = HoverTipScaleMath.ComputeAnchoredStamp(box, 1.0, W, H, HoverTipScaleMath.AnchorPivot.Center, 0, -70.4)!.Value;
        Check.Close(s.Scale, 1.0, "translate-only stamp keeps scale 1");
        Check.Close(s.ClampY, -70.4, "translate-only clamp Y == requested lift (in-bounds)");
        Check.Close(s.ClampX, 0, "translate-only clamp X == 0");
    }

    // InverseMapPoint undoes ComputeCenterStamp's forward map: forward(q) = P + k·(q−P) + C, inverse(forward(q)) = q.
    private static void InverseUndoesCenterStamp()
    {
        var box = new DesignAabb(1000, 400, 1200, 500);
        var s = HoverTipScaleMath.ComputeCenterStamp(box, 1.15, W, H)!.Value;
        // A true point at the box's top-left corner.
        var (fx, fy) = Forward(s, 1000, 400);
        var (ix, iy) = ViewScale.InverseMapPoint(s, fx, fy);
        Check.Close(ix, 1000, "inverse round-trips X");
        Check.Close(iy, 400, "inverse round-trips Y");
    }

    // The inverse composes with a NON-ZERO clamp (a stamp constructed with an explicit clamp channel).
    private static void InverseUndoesClampedStamp()
    {
        var s = new HoverTipScaleMath.Stamp(1.2, 900, 500, 30, -20);
        var (fx, fy) = Forward(s, 640, 720);
        var (ix, iy) = ViewScale.InverseMapPoint(s, fx, fy);
        Check.Close(ix, 640, "inverse round-trips X with clamp");
        Check.Close(iy, 720, "inverse round-trips Y with clamp");
    }

    // R7/R9 (k==1 translate-only): the inverse of a pure-translate stamp subtracts the clamp — a tap on the lifted
    // dialogue maps back to the game's un-lifted target.
    private static void InverseUndoesTranslateOnlyStamp()
    {
        var s = HoverTipScaleMath.ComputeAnchoredStamp(
            new DesignAabb(727, 654, 1527, 738), 1.0, W, H, HoverTipScaleMath.AnchorPivot.Center, 0, -70.4)!.Value;
        var (fx, fy) = Forward(s, 900, 700);
        var (ix, iy) = ViewScale.InverseMapPoint(s, fx, fy);
        Check.Close(ix, 900, "k=1 inverse round-trips X");
        Check.Close(iy, 700, "k=1 inverse round-trips Y");
    }

    // A pointer exactly at the displayed pivot (+clamp) un-maps to the pivot itself (the fixed point of the scale).
    private static void InversePivotIsFixed()
    {
        var s = new HoverTipScaleMath.Stamp(1.15, 1100, 450, 0, 0);
        var (ix, iy) = ViewScale.InverseMapPoint(s, 1100, 450);
        Check.Close(ix, 1100, "inverse fixes the pivot X");
        Check.Close(iy, 450, "inverse fixes the pivot Y");
    }

    private static (double X, double Y) Forward(HoverTipScaleMath.Stamp s, double qx, double qy) =>
        (s.PivotX + (s.Scale * (qx - s.PivotX)) + s.ClampX,
         s.PivotY + (s.Scale * (qy - s.PivotY)) + s.ClampY);

    // WS-shopfix (P4): the ViewScaler off-screen reject predicate is `box.FullyOutside(designWidth, designHeight, 0)`
    // — reused straight from DesignAabb (already Exe-tested generically in CullIndexTests). This test pins the exact
    // shop-phantom scenario: a node Visible==true but parked entirely above the viewport (the closed shop's
    // SlotsContainer at local y≈−1000), and proves the mechanism the guard prevents (AxisClamp dragging it ~1000px
    // on-screen) plus the required non-regression: a box only PARTIALLY off-screen must NOT be rejected.
    private static void ParkedOffscreenBoxIsFullyOutsideRejectsStamp()
    {
        var parked = new DesignAabb(0, -1000, W, -200); // entirely above y=0 (bottom edge at -200)
        Check.That(parked.FullyOutside(W, H, 0),
            "parked SlotsContainer (y≈-1000, Visible==true) is fully outside the design rect → ViewScaler must reject the stamp");

        // Sanity: absent the guard, ComputeAnchoredStamp happily produces a stamp whose ClampY drags the parked box
        // (scaled about its own centre, then clamped) hundreds of px back on-screen — the exact mechanism that
        // rendered the phantom rug + empty card slots.
        var wouldBeStamp = HoverTipScaleMath.ComputeAnchoredStamp(
            parked, ViewScale.MerchantGroupScale, W, H, HoverTipScaleMath.AnchorPivot.Center)!.Value;
        Check.That(wouldBeStamp.ClampY > 900,
            "absent the guard, AxisClamp drags the parked box back on-screen (the phantom mechanism)");

        // A box only PARTIALLY off-screen (e.g. scrolled up 100px, still overlapping the top edge) must NOT be
        // rejected — ViewScaler's normal on-screen clamp still applies to it (edge case: near-edge groups must
        // keep stamping).
        var partial = new DesignAabb(0, -100, W, 700);
        Check.That(!partial.FullyOutside(W, H, 0),
            "a box that still overlaps the design rect is not rejected — partial off-screen still stamps");
    }
}
