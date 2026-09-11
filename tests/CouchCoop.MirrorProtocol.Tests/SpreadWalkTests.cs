using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// OWNER: WS-P (SpreadWalk). Pre-registered here by WS-O so WS-P never touches Program.cs. This ports the web
// "wide-screen anchor re-layout (setStretch)" suite (frontend/src/mirror/__tests__/mirrorRenderer.spec.ts L546-1189,
// ~30 assertions at F=1.3125, DELTA=600) re-expressed against SpreadIndex records:
//   * web composed-matrix `tx`  ⇔  gNode.tx + rec.Dx   (ComposedTx below; the on-screen origin x)
//   * web centerX helper        ⇔  ComposedTx + a·(localWidth/2)   (CenterX below)
//   * web `style.width`         ⇔  rec.RenderedWidth   (0 = no override)
//   * web `data-spread-mode="prop"` ⇔ rec.Prop
//   * web `data-paints`         ⇔  rec.Paints
//   * plus F=1 ⇒ zero records (strict no-op) + an F-change determinism test.
// The scene fixtures mirror the web ones verbatim in screen coordinates, then convert to the local parent-relative
// contract before the pure index composes their globals.
// WS-P touches ONLY SpreadIndex.cs + this file.
internal static class SpreadWalkTests
{
    // The widest stretch (web MIRROR_MAX_DESIGN_WIDTH / 1920 = 2520/1920) — the squeeze-field factor.
    private const double F = 2520.0 / 1920.0; // 1.3125
    private const double DesignW = 2520; // the stage width at F
    private const double Delta = (F - 1.0) * 1920.0; // 600 — the root's parent-width budget the anchors face

    public static void Run()
    {
        NoOpAtFactor1();
        FullAnchoredWidensWithoutShifting();
        RightAnchoredHugsRightEdge();
        LeftAnchoredStaysPinned();
        FullCanvasBoxRecentersSmallBoxPinned();
        PartialAnchoredBarWidensInPlace();
        CenterAnchoredHandSpreadsCards();
        AnchoredBoxesUnderZeroGroupTakePositionalClaims();
        CornerControlRidesEntityNode2DKeepsOwnClaim();
        PropStampOnDeepRidersInClaimedSubtree();
        NonControlContentPlacedAtOwnCenter();
        OversizedCenterBackgroundStaysCentered();
        OwnerFloaterShiftsByOwnerAndRidesSubtree();
        OwnerFloaterUnshiftedWhenOwnerAbsent();
        OwnerFloaterIgnoresOwnParentChainShift();       // R5 H1 repro: floater must ride ONLY the owner's Δ
        OwnerFloaterFollowsZeroSizeOwnersVisualChild();  // R5 H2 repro: 0×0 holder → follow the painting card child
        GrabbedCardPlacedOnFieldMatchingHand();
        NormalInHandCardPlacedOnField();
        RenderedWidthOnWidenedBoxesOnly();
        AncientBannerLabelsCarryWidenedRenderedWidth();
        FactorResetClearsRecords();
        PaintsOnlyOnVisibleOwnPaint();
        PaintsWithheldFromCardAuras();
        TwoCreaturesSpreadPerPositionSubtreeRigid();
        HandCardsSpreadNoInternalSkew();
        TargetingArrowSegmentsPlacedPerPosition();
        PropStampOnClaimersNotAnchorNodes();
        InteractiveRectsCarryGameRectAndSpreadDx();
        RemoteCursorAnchorsToControlUnderPoint();
        RemoteCursorPositionalClaimInDeadSpace();
        FChangeIsDeterministic();

        // WS container re-layout: a boxed child of a widened BoxContainer rides the container's own re-layout
        // (Godot BoxContainer ignores child anchors) instead of the anchor algebra — the card-reward "Skip" fix.
        ContainerCenterHBoxRecentersBoxedChild();
        ContainerBeginEndHBoxRedistributeBoxedChild();
        ContainerVBoxChildRidesParentNoHorizontalSpread();
        ContainerVBoxFullWidthChildRecentersAsBackgroundArt();
        WalkBailsOnIrrelevantDrainsOnly();
        WalkBailsOnRegionOnlyDrains();
        ContainerWithoutLayoutUsesAnchorAlgebra();

        // Event-background centering keeps a matched root and its children aligned.
        EventBgSceneRootRecentersWholeSubtree();
        UnmatchedBackgroundSceneUsesPassThroughClaims();

        // The event-bg matcher includes the `events/background_scenes/` directory, so neow + its siblings
        // (real streamed paths) all re-center like tezcatara, while combat/map/room backdrops (a different directory) do
        // not; and the neow point-anchor SPINE inherits the root's rigid ½Δ instead of stranding on its own origin claim.
        EventBgWhitelistMatchesEventBackdropDirectory();
        EventBgPointAnchorSpineInheritsRigidRecenter();

        // A full-frame linked-card preview container and its contents ride one rigid center shift.
        PreviewContainerRecentersWholeSubtree();
        PreviewNarrowContainerRidesParentNotRecenter();

        // The 0/0-anchored draw/erase/clear palette follows the centered map content.
        DrawingToolsClaimsCenterAndRidesSubtreeRigidly();
        DrawingToolsMatchIsSceneIdentityScoped();

        // Main-menu focus ribbons.
        MenuReticlesRideTheOptionColumn();
        MenuReticleMatchIsSceneIdentityScoped();

        // WS-P2 incremental ApplySpread: the pre-resolved per-view stamp reproduces the reconciler's ApplySpread
        // math, and the per-drain dirty set narrows to exactly the changed/pruned nodes.
        ViewStampMatchesApplySpreadMath();
        DirtySetTracksChangesAcrossUpdates();
    }

    // ---- fixture + assertion helpers ----

    // A screen-coordinate fixture node: transform = [1,0,0,1,tx,ty]; localRect = box(w,h) at origin (null when w
    // is omitted — a boxless positioner like NTargetManager). Anchors/mouseFilter/paint fields are opt-in.
    private static MirrorNode N(
        string id,
        string? parent,
        double tx,
        double ty,
        double? w = null,
        double? h = null,
        double? anchorLeft = null,
        double? anchorRight = null,
        int? mouseFilter = null,
        string nodeType = "Control",
        string name = "",
        string? anchorOwnerId = null,
        string? containerLayout = null,
        bool visible = true,
        MirrorColor? fillColor = null,
        string? textureUrl = null,
        string? sceneFile = null,
        string? spineScene = null,
        string? spineAnim = null) =>
        new()
        {
            Id = id,
            ParentId = parent,
            NodeType = nodeType,
            Name = name,
            Visible = visible,
            MouseFilter = mouseFilter,
            AnchorLeft = anchorLeft,
            AnchorRight = anchorRight,
            AnchorOwnerId = anchorOwnerId,
            ContainerLayout = containerLayout,
            FillColor = fillColor,
            TextureUrl = textureUrl,
            SceneFilePath = sceneFile,
            SpineSceneResPath = spineScene,
            SpineCurrentAnim = spineAnim,
            Transform = [1, 0, 0, 1, tx, ty],
            LocalRect = w is { } ww ? new MirrorRect(0, 0, ww, h ?? 0) : null,
        };

    // Fixtures describe screen-space positions for readability. Convert them to the local parent-relative scene
    // contract before updating the transform index.
    private static (MirrorState State, GlobalTransformIndex Transforms, SpreadIndex Spread) Scene(double factor, params MirrorNode[] nodes)
    {
        var state = MirrorState.Create();
        foreach (var n in Localize(nodes))
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
            state.ChangedIds.Add(n.Id);
        }

        state.Revision++;

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);

        var spread = new SpreadIndex();
        spread.Update(state, transforms, factor);
        return (state, transforms, spread);
    }

    private static IEnumerable<MirrorNode> Localize(IEnumerable<MirrorNode> nodes)
    {
        var materialized = nodes.ToArray();
        var screenTransforms = materialized.ToDictionary(node => node.Id, node => node.Transform, StringComparer.Ordinal);
        foreach (var node in materialized)
        {
            if (node.Transform is { } global && node.ParentId is { } parentId && screenTransforms.TryGetValue(parentId, out var parentGlobal) && parentGlobal is not null && Affine.Inverse(parentGlobal) is { } inverse)
            {
                node.Transform = Affine.Multiply(inverse, global);
            }
        }

        return materialized;
    }

    private static SpreadRecord Rec(SpreadIndex s, string id) => s.TryGet(id, out var r) ? r : default;

    private static double GlobalTx(GlobalTransformIndex t, string id) => t.TryGetGlobal(id, out var g) ? g[4] : 0;

    private static double GlobalA(GlobalTransformIndex t, string id) => t.TryGetGlobal(id, out var g) ? g[0] : 1;

    // The node's ON-SCREEN origin x (web composedMatrix(el)[4]): its unshifted global tx plus the walk's absolute dx.
    private static double ComposedTx(SpreadIndex s, GlobalTransformIndex t, string id) => GlobalTx(t, id) + Rec(s, id).Dx;

    // The node's ON-SCREEN center x (web centerX helper): composed origin + the composed-scaled half local width.
    private static double CenterX(SpreadIndex s, GlobalTransformIndex t, string id, double localWidth) =>
        ComposedTx(s, t, id) + (GlobalA(t, id) * (localWidth / 2));

    // The combat-like tree the web `combatTree` builds: a FULL-anchored (0..1) frame + fill + bg image, a
    // CENTER-anchored (0.5/0.5) zero-size hand holding two non-anchored cards, a LEFT-anchored (0/0) pile, a
    // RIGHT-anchored (1/1) end-turn, a partial-anchored (0..1) relic bar.
    private static MirrorNode[] CombatTree() =>
    [
        N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
        N("backstop", "frame", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, nodeType: "ColorRect"),
        N("bgImage", "frame", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, nodeType: "TextureRect"),
        N("hand", "frame", 960, 900, 0, 0, anchorLeft: 0.5, anchorRight: 0.5),
        N("cardL", "hand", 540, 800, 160, 220, nodeType: "NCard"),
        N("cardR", "hand", 1220, 800, 160, 220, nodeType: "NCard"),
        N("pile", "frame", 15, 980, 80, 80, anchorLeft: 0, anchorRight: 0),
        N("endTurn", "frame", 1604, 980, 220, 80, anchorLeft: 1, anchorRight: 1),
        N("relics", "frame", 12, 20, 1808, 84, anchorLeft: 0, anchorRight: 1),
    ];

    // ---- tests ----

    // At F=1 (16:9) the walk is a STRICT no-op: no records exist at all, so every TryGet misses (default all-zero).
    private static void NoOpAtFactor1()
    {
        var (_, t, s) = Scene(1, CombatTree());
        foreach (var id in new[] { "frame", "cardL", "cardR", "endTurn", "relics", "pile", "hand" })
        {
            Check.That(!s.TryGet(id, out _), $"{id}: no record at F=1 (strict no-op)");
        }

        Check.Close(s.Factor, 1, "Factor recorded as 1");
        // With no records the on-screen origins equal the untouched globals.
        Check.Close(CenterX(s, t, "cardL", 160), 620, "cardL center unshifted at F=1");
        Check.Close(CenterX(s, t, "endTurn", 220), 1714, "endTurn center unshifted at F=1");
    }

    // Full-anchored (0..1) frames/fills/images widen to the stage width; the origin stays put (anchorLeft 0 → dx 0).
    private static void FullAnchoredWidensWithoutShifting()
    {
        var (_, t, s) = Scene(F, CombatTree());
        foreach (var id in new[] { "frame", "backstop", "bgImage" })
        {
            Check.Close(Rec(s, id).RenderedWidth, DesignW, $"{id}: widened to the stage width (1920+Δ)");
            Check.Close(ComposedTx(s, t, id), 0, $"{id}: origin unshifted (anchorLeft 0)");
            Check.Close(GlobalA(t, id), 1, $"{id}: grown via width, NOT a transform scale");
        }
    }

    // Right-anchored (1/1) HUD hugs the right edge: shift by Δparent, no widen.
    private static void RightAnchoredHugsRightEdge()
    {
        var (_, t, s) = Scene(F, CombatTree());
        Check.Close(ComposedTx(s, t, "endTurn"), 1604 + Delta, "endTurn shifted +Δ to the right edge");
        Check.Close(Rec(s, "endTurn").RenderedWidth, 0, "endTurn does not widen ((1−1)·Δ)");
    }

    // Left-anchored (0/0) HUD stays pinned: no shift, no widen.
    private static void LeftAnchoredStaysPinned()
    {
        var (_, t, s) = Scene(F, CombatTree());
        Check.Close(ComposedTx(s, t, "pile"), 15, "pile stays pinned left");
        Check.Close(Rec(s, "pile").RenderedWidth, 0, "pile does not widen");
    }

    // A 0/0-anchored FULL-CANVAS box (a 1920-wide map parchment tile) re-CENTERS (½Δ) — background art authored for
    // the whole canvas, NOT a left-pinned widget; a small 0/0 box keeps its authored corner.
    private static void FullCanvasBoxRecentersSmallBoxPinned()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("tile", "frame", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect"),
            N("pile", "frame", 15, 980, 80, 80, anchorLeft: 0, anchorRight: 0));

        Check.Close(ComposedTx(s, t, "tile"), Delta / 2, "full-canvas tile re-centers (½Δ)");
        Check.Close(Rec(s, "tile").Dx, Delta / 2, "tile Dx == ½Δ");
        Check.Close(Rec(s, "tile").RenderedWidth, 0, "tile translated, never stretched (art not distorted)");
        Check.That(!Rec(s, "tile").Prop, "tile is an anchored translation (not the field), so not Prop");
        Check.Close(ComposedTx(s, t, "pile"), 15, "small 0/0 box keeps its corner");
    }

    // A partial-anchored (0..1) bar (RelicInventory) widens in place: no shift, grows by (1−0)·Δ.
    private static void PartialAnchoredBarWidensInPlace()
    {
        var (_, t, s) = Scene(F, CombatTree());
        Check.Close(ComposedTx(s, t, "relics"), 12, "relics origin unshifted (anchorLeft 0)");
        Check.Close(Rec(s, "relics").RenderedWidth, 1808 + Delta, "relics widened 1808 → 1808+Δ");
    }

    // A center-anchored (0.5/0.5) zero-size hand is a PASS-THROUGH group: each card takes its OWN positional claim
    // at its center (renderedCenter = gameCenter·F), so the cards spread WIDER than 16:9.
    private static void CenterAnchoredHandSpreadsCards()
    {
        var (_, t, s) = Scene(F, CombatTree());
        Check.Close(CenterX(s, t, "cardL", 160), 620 * F, "cardL center = 620·F (813.75)");
        Check.Close(CenterX(s, t, "cardR", 160), 1300 * F, "cardR center = 1300·F (1706.25)");

        double gap = CenterX(s, t, "cardR", 160) - CenterX(s, t, "cardL", 160);
        Check.Close(gap, (1300 - 620) * F, "the gap GREW (680 → 892.5): the cards spread out");
        Check.Close(Rec(s, "cardL").RenderedWidth, 0, "cardL keeps its native width (translated, not stretched)");
    }

    // Anchored boxed parts under a zero-size (pass-through) group take POSITIONAL field claims — a creature's
    // hitbox/healthbar RIDE the creature's one shift, not the anchor algebra (which would strand them at dx 0).
    private static void AnchoredBoxesUnderZeroGroupTakePositionalClaims()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("enemies", "frame", 1128, 300, 0, 0, anchorLeft: 0.5, anchorRight: 0.5),
            N("creature", "enemies", 1400, 500, 0, 0),
            N("visual", "creature", 1300, 380, 200, 300, nodeType: "Sprite2D"),
            N("hitbox", "creature", 1280, 380, 240, 300, anchorLeft: 0, anchorRight: 0),
            N("healthbar", "creature", 1290, 700, 220, 30, anchorLeft: 0.5, anchorRight: 0.5));

        double dx = 1400 * (F - 1); // 437.5 — the pass-through creature's own field claim; every Control part rides it
        Check.Close(ComposedTx(s, t, "visual"), 1300 + dx, "visual rides the creature shift");
        Check.Close(ComposedTx(s, t, "hitbox"), 1280 + dx, "hitbox rides the creature shift (not stranded)");
        Check.Close(ComposedTx(s, t, "healthbar"), 1290 + dx, "healthbar rides the creature shift");
        Check.Close(Rec(s, "hitbox").RenderedWidth, 0, "a positional claim never widens");
        Check.That(Rec(s, "hitbox").Prop, "hitbox stamped Prop (field mode) for the input side");

        // An anchored box under a REAL resizing frame keeps the anchor algebra → NOT Prop.
        var (_, _, s2) = Scene(F, CombatTree());
        Check.That(!Rec(s2, "pile").Prop, "an anchor-algebra pile is not Prop");
    }

    // An OFF-CENTER anchored boxed Control (an energy-cost badge at the card corner) rides the holder's ONE dx; a
    // Node2D sibling (a world sprite) is world-placed and keeps its OWN field claim.
    private static void CornerControlRidesEntityNode2DKeepsOwnClaim()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("holder", "frame", 1400, 900, 0, 0, nodeType: "NHandCardHolder"),
            N("badge", "holder", 1275, 850, 50, 50, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect"),
            N("segment", "holder", 1275, 400, 50, 50, nodeType: "Sprite2D"));

        double holderDx = 1400 * (F - 1); // 437.5 — the pass-through group's own claim
        double ownDx = 1300 * (F - 1); // 406.25 — what a per-part own-center claim would give
        Check.Close(ComposedTx(s, t, "badge"), 1275 + holderDx, "badge rides the entity (holder) shift");
        Check.Close(Rec(s, "badge").Dx, holderDx, "badge Dx == holder claim");
        Check.Close(ComposedTx(s, t, "segment"), 1275 + ownDx, "Node2D segment keeps its own field claim");
        Check.Close(Rec(s, "segment").Dx, ownDx, "segment Dx == own-center claim");
    }

    // A press lands on the PAINTED descendant (card art), not the claiming holder — a rider inside a positional
    // subtree inherits the Prop flavor + the exact Dx (a DeltaParentWidth-0 rider takes ctx.ParentDx/ParentDxProp).
    private static void PropStampOnDeepRidersInClaimedSubtree()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("hand", "frame", 960, 900, 0, 0, anchorLeft: 0.5, anchorRight: 0.5),
            N("card", "hand", 540, 800, 160, 220, nodeType: "NCard"),
            N("art", "card", 550, 820, 140, 100, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect"));

        double dx = 620 * (F - 1); // the card claims at its center (620); the art rides that exact shift
        Check.That(Rec(s, "art").Prop, "deep card art carries its holder's Prop flavor");
        Check.Close(Rec(s, "art").Dx, dx, "art Dx == the holder's claim");
        Check.Close(ComposedTx(s, t, "art"), 550 + dx, "art rides the holder rigidly");
    }

    // A non-Control VFX / world sprite is placed on the field at its own CENTER (renderedCenter = gameCenter·F).
    private static void NonControlContentPlacedAtOwnCenter()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("vfxLayer", "frame", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("vfx", "vfxLayer", 900, 500, 80, 80, nodeType: "GpuParticles2D"));

        Check.Close(ComposedTx(s, t, "vfx"), 900 + (940 * (F - 1)), "vfx origin shifted by center·(F−1)");
        Check.Close(CenterX(s, t, "vfx", 80), 940 * F, "vfx box center lands at gameCenter·F");
    }

    // An oversized (>1920) center-covering background claims at its CENTER (960 → ½Δ), so it stays centered and
    // keeps fully covering the widened stage (never widened — a positional claimer translates).
    private static void OversizedCenterBackgroundStaysCentered()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("bgContainer", "frame", 0, 0, 0, 0),
            N("bg", "bgContainer", -422.4, 0, 2764.8, 1080, nodeType: "TextureRect"));

        Check.Close(CenterX(s, t, "bg", 2764.8), 960 * F, "oversized bg stays centered (= stage center 1260)");
        Check.Close(Rec(s, "bg").RenderedWidth, 0, "the bg is not stretched (still 2764.8 wide, translated)");
        double left = ComposedTx(s, t, "bg");
        Check.That(left <= 0 + 1e-6, "rendered left edge at/left of 0");
        Check.That(left + 2764.8 >= DesignW - 1e-6, "rendered right edge at/right of the stage width");
    }

    // An owner-anchored floater (a HoverTip in a separate un-shifted container) shifts by its OWNER's cumulative
    // shift (not the center-fallback) and its nested label rides it.
    private static void OwnerFloaterShiftsByOwnerAndRidesSubtree()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("owner", "frame", 1700, 20, 120, 60, anchorLeft: 1, anchorRight: 1),
            N("tips", "frame", 0, 0, 0, 0, anchorLeft: 0, anchorRight: 0),
            N("tooltip", "tips", 1700, 110, 360, 80, nodeType: "NHoverTipSet", anchorOwnerId: "owner"),
            N("tipLabel", "tooltip", 1710, 120, 340, 40, nodeType: "Label"));

        Check.Close(ComposedTx(s, t, "owner"), 1700 + Delta, "owner hugs the right edge (+Δ)");
        Check.Close(ComposedTx(s, t, "tooltip"), 1700 + Delta, "tooltip rides the OWNER's shift (not +½Δ)");
        Check.Close(ComposedTx(s, t, "tipLabel"), 1710 + Delta, "nested label rides the tooltip");
        Check.Close(Rec(s, "tooltip").RenderedWidth, 0, "a tooltip doesn't widen");
    }

    // An owner-anchored floater whose owner is ABSENT is unshifted (and opts OUT of the center-fallback → not +½Δ).
    private static void OwnerFloaterUnshiftedWhenOwnerAbsent()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("tips", "frame", 0, 0, 0, 0, anchorLeft: 0, anchorRight: 0),
            N("tooltip", "tips", 1700, 110, 360, 80, nodeType: "NHoverTipSet", anchorOwnerId: "ghost"));

        Check.Close(ComposedTx(s, t, "tooltip"), 1700, "unknown owner → no shift (and not center-fallback)");
    }

    // R5 H1 repro: the HoverTips container sits under a SHIFT-CLAIMING ancestor (a positional-claimer world layer), so
    // the tip's OWN parent chain contributes a non-zero ParentDx. A floater glued to its owner must ride ONLY the
    // owner's ABSOLUTE shift (Fact A: rec.Dx == ownerDx). The old `ctx.ParentDx + ownerDx` DOUBLE-COUNTS the parent
    // chain and strands the tip far right — the R5-evidence symptom. RED against the pre-fix double-count.
    private static void OwnerFloaterIgnoresOwnParentChainShift()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("owner", "frame", 1700, 20, 120, 60, anchorLeft: 1, anchorRight: 1),
            // A positional-claimer world sprite hosting the tips → it claims its own center shift, which becomes the
            // tooltip's non-zero ParentDx (the shift-claiming ancestor the H1 double-count trips over).
            N("tipHost", "frame", 800, 500, 100, 100, nodeType: "Sprite2D"),
            N("tooltip", "tipHost", 1700, 110, 360, 80, nodeType: "NHoverTipSet", anchorOwnerId: "owner"),
            N("tipLabel", "tooltip", 1710, 120, 340, 40, nodeType: "Label"));

        double hostDx = 850 * (F - 1); // tipHost center 850 → its positional claim (the tooltip's ParentDx)
        Check.That(hostDx > 1, "the tip host claims a real shift (tooltip ParentDx != 0)");
        Check.Close(Rec(s, "owner").Dx, Delta, "owner hugs the right edge (+Δ)");
        Check.Close(Rec(s, "tooltip").Dx, Delta, "tooltip rides ONLY the owner's Δ (not ParentDx+Δ)");
        Check.Close(ComposedTx(s, t, "tooltip"), 1700 + Delta, "tooltip origin at the owner shift, no double-count");
        Check.Close(ComposedTx(s, t, "tipLabel"), 1710 + Delta, "nested label rides the corrected tooltip");
    }

    // R5 H2 repro: the owner is a 0×0 NHandCardHolder — a zero-size anchor node whose OWN pass-through claim rides its
    // ORIGIN, not the focused card's center. The tip must follow the holder's painting card CHILD (draw-order), so its
    // shift matches the card the user sees, not the holder origin. Plus a REPARENTED variant (card grabbed out of the
    // holder subtree → hit-test the holder origin over the interactive rects). RED against the pre-fix owner-origin ride.
    private static void OwnerFloaterFollowsZeroSizeOwnersVisualChild()
    {
        var (_, _, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("hand", "frame", 960, 900, 0, 0, anchorLeft: 0.5, anchorRight: 0.5),
            N("holder", "hand", 1000, 850, 0, 0, nodeType: "NHandCardHolder"),
            N("card", "holder", 820, 800, 160, 220, nodeType: "TextureRect", textureUrl: "res://images/cards/frame.png"),
            N("tips", "frame", 0, 0, 0, 0, anchorLeft: 0, anchorRight: 0),
            N("tooltip", "tips", 1000, 500, 360, 80, nodeType: "NHoverTipSet", anchorOwnerId: "holder"));

        double holderDx = 1000 * (F - 1); // the 0×0 holder's OWN pass-through claim (its origin)
        double cardDx = 900 * (F - 1);    // the card's positional claim (center 820+80=900)
        Check.That(Math.Abs(holderDx - cardDx) > 1, "the holder origin and card center claim DIFFERENT shifts");
        Check.Close(Rec(s, "card").Dx, cardDx, "the visual card takes its own center claim");
        Check.Close(Rec(s, "tooltip").Dx, Rec(s, "card").Dx, "tooltip Dx == card Dx (follows the holder's visual child)");

        // Reparented variant: the card is grabbed OUT of the holder subtree (no painting descendant) — the tip
        // hit-tests the holder's ORIGIN point against the interactive rects and rides the mouse-visible card there.
        var (_, _, s2) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("hand", "frame", 960, 900, 0, 0, anchorLeft: 0.5, anchorRight: 0.5),
            N("holder", "hand", 1000, 850, 0, 0, nodeType: "NHandCardHolder"),
            N("grabbed", "hand", 900, 800, 200, 200, mouseFilter: 0, nodeType: "NCard", textureUrl: "res://images/cards/frame.png"),
            N("tips", "frame", 0, 0, 0, 0, anchorLeft: 0, anchorRight: 0),
            N("tooltip", "tips", 1000, 500, 360, 80, nodeType: "NHoverTipSet", anchorOwnerId: "holder"));

        // holder origin (1000,850) sits inside the grabbed card's game rect [900..1100]×[800..1000].
        Check.That(Rec(s2, "grabbed").Dx > 1, "the grabbed card actually shifted");
        Check.Close(Rec(s2, "tooltip").Dx, Rec(s2, "grabbed").Dx, "tip hit-tests the holder origin onto the reparented card");
    }

    // A grabbed card reparented straight under `Hand` (outside the center-anchored container) still claims at its
    // center (960 → ½Δ) on the field, matching the re-centered hand; its nested art rides it rigidly.
    private static void GrabbedCardPlacedOnFieldMatchingHand()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "frame"),
            N("hand", "frame", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "Hand"),
            N("container", "hand", 960, 900, 0, 0, anchorLeft: 0.5, anchorRight: 0.5, name: "CardHolderContainer"),
            N("inHand", "container", 880, 800, 160, 220, nodeType: "NCard", name: "NHandCardHolder-CARD_SPITE"),
            N("grabbed", "hand", 880, 600, 160, 220, nodeType: "NCard", name: "NHandCardHolder-CARD_STRIKE"),
            N("grabbedArt", "grabbed", 880, 600, 160, 220, nodeType: "TextureRect", name: "Frame"));

        double shift = 0.5 * Delta; // a box centered on 960: 960·(F−1) = ½Δ
        Check.Close(ComposedTx(s, t, "container"), 960 + shift, "pass-through container origin field-shifts ½Δ");
        Check.Close(ComposedTx(s, t, "grabbed"), 880 + shift, "grabbed card claims ½Δ, matching the hand");
        Check.Close(ComposedTx(s, t, "grabbedArt"), 880 + shift, "nested art rides the grabbed card rigidly");
        Check.Close(Rec(s, "grabbed").RenderedWidth, 0, "the grabbed card keeps its native width");
    }

    // The normal in-hand card (parent = the zero-size container) takes its own positional claim (center 960 → ½Δ).
    private static void NormalInHandCardPlacedOnField()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("hand", "frame", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "Hand"),
            N("container", "hand", 960, 900, 0, 0, anchorLeft: 0.5, anchorRight: 0.5, name: "CardHolderContainer"),
            N("inHand", "container", 880, 800, 160, 220, nodeType: "NCard", name: "NHandCardHolder-CARD_SPITE"));

        Check.Close(ComposedTx(s, t, "inHand"), 880 + (0.5 * Delta), "in-hand card claims ½Δ via the pass-through container");
    }

    // RenderedWidth (web data-spread-w's rendered value) is set only on widened anchor boxes; a shift-only or
    // pinned box carries none.
    private static void RenderedWidthOnWidenedBoxesOnly()
    {
        var (_, _, s) = Scene(F, CombatTree());
        Check.Close(Rec(s, "backstop").RenderedWidth, 1920 + Delta, "full-anchored fill widened to 1920+Δ");
        Check.Close(Rec(s, "relics").RenderedWidth, 1808 + Delta, "partial-anchored relic bar widened to 1808+Δ");
        Check.Close(Rec(s, "pile").RenderedWidth, 0, "left-pinned pile carries no width override");
        Check.Close(Rec(s, "endTurn").RenderedWidth, 0, "shift-only end-turn carries no width override");
    }

    // The REAL ancient-event name banner chain (audit-mprun.ndjson): a deep 0/1-anchored stack —
    // AncientEventLayout → AncientNameBanner → Epithet (MegaLabel) → Title (MegaRichTextLabel) — every level a
    // full-canvas Control offset to game-x 48. The whole stack widens to the stage width (1920+Δ) with NO shift
    // (anchorLeft 0). This pins the walk INPUT the native text sub-layer depends on for the wide-screen text-centering
    // fix (MirrorNodeView.SpreadWidth → SyncText): a CENTER/RIGHT-aligned label at this width must re-place its child
    // Label to the WIDENED box so its text re-centers on the stage — otherwise it strands at the un-widened box's
    // center (the game-vs-web off-center title bug). Deep nesting + the 48px origin offset guard the width
    // propagating unchanged through several anchor-algebra levels to the leaf label.
    private static void AncientBannerLabelsCarryWidenedRenderedWidth()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, nodeType: "NGame", name: "Game"),
            N("layout", "frame", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, nodeType: "NAncientEventLayout", name: "AncientEventLayout"),
            N("banner", "layout", 48, -80, 1920, 1080, anchorLeft: 0, anchorRight: 1, nodeType: "NAncientNameBanner", name: "AncientNameBanner"),
            N("epithet", "banner", 48, -38, 1920, 1080, anchorLeft: 0, anchorRight: 1, nodeType: "MegaLabel", name: "Epithet"),
            N("title", "epithet", 48, -38, 1920, 1080, anchorLeft: 0, anchorRight: 1, nodeType: "MegaRichTextLabel", name: "Title"));

        foreach (var id in new[] { "banner", "epithet", "title" })
        {
            Check.Close(Rec(s, id).RenderedWidth, 1920 + Delta, $"{id}: widened to the stage width (1920+Δ) through the deep 0/1 stack");
            Check.Close(Rec(s, id).Dx, 0, $"{id}: unshifted (anchorLeft 0) — only the box grows, so centered text re-centers on the stage");
            Check.That(!Rec(s, id).Prop, $"{id}: anchor-algebra widen (not a positional field claim)");
        }

        // Deep nesting must not smear the width: the leaf Title carries the SAME full-stage width as the banner root.
        Check.Close(Rec(s, "title").RenderedWidth, Rec(s, "banner").RenderedWidth, "leaf Title width == banner width (no per-level drift)");
    }

    // Re-running the walk at F=1 clears every record (the reset path MirrorView drives via setStretch(1)).
    private static void FactorResetClearsRecords()
    {
        var state = MirrorState.Create();
        foreach (var n in Localize(CombatTree()))
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
            state.ChangedIds.Add(n.Id);
        }

        state.Revision++;
        var transforms = new GlobalTransformIndex();
        transforms.Update(state);

        var spread = new SpreadIndex();
        spread.Update(state, transforms, F);
        Check.That(spread.TryGet("cardL", out var cardAtF) && cardAtF.Prop, "cardL carries a Prop record at F");
        Check.That(spread.TryGet("backstop", out var backAtF) && backAtF.RenderedWidth > 0, "backstop widened at F");

        spread.Update(state, transforms, 1);
        Check.That(!spread.TryGet("cardL", out _), "cardL record cleared at F=1");
        Check.That(!spread.TryGet("backstop", out _), "backstop record cleared at F=1");
        Check.Close(spread.Factor, 1, "Factor reset to 1");
    }

    // Paints (web data-paints) is set only on nodes with visible OWN paint — a filled ColorRect paints, a boxless-ish
    // Control and a pure container do not. (Asserted at F where records exist; Paints is spread-independent.)
    private static void PaintsOnlyOnVisibleOwnPaint()
    {
        var (_, _, s) = Scene(
            F,
            N("group", null, 0, 0, 200, 200),
            N("fill", "group", 0, 0, 80, 80, nodeType: "ColorRect", fillColor: new MirrorColor(1, 0, 0, 1, "#ff0000")),
            N("empty", "group", 0, 0, 10, 10));

        Check.That(Rec(s, "fill").Paints, "a filled ColorRect paints");
        Check.That(!Rec(s, "empty").Paints, "a boxless-ish Control paints nothing");
        Check.That(!Rec(s, "group").Paints, "a pure container paints nothing");
    }

    // Paints is withheld from card AURA layers (glow NCardHighlight / draw-play Flash) so they never anchor the
    // pointer map, while the card's real art (Frame) still anchors.
    private static void PaintsWithheldFromCardAuras()
    {
        var (_, _, s) = Scene(
            F,
            N("holder", null, 960, 900, 0, 0, nodeType: "NHandCardHolder"),
            N("frame", "holder", 880, 750, 160, 220, nodeType: "TextureRect", textureUrl: "res://images/cards/frame.png"),
            N("glow", "holder", 660, 600, 600, 760, nodeType: "NCardHighlight", textureUrl: "res://images/cards/glow.png"),
            N("flash", "holder", 810, 650, 300, 560, nodeType: "TextureRect", name: "Flash", textureUrl: "res://images/cards/flash.png"));

        Check.That(Rec(s, "frame").Paints, "real card art (Frame) anchors");
        Check.That(!Rec(s, "glow").Paints, "the cyan glow (NCardHighlight) renders but never anchors");
        Check.That(!Rec(s, "flash").Paints, "the draw/play Flash renders but never anchors");
    }

    // Two creatures under a zero-size EnemyContainer take per-position claims (they spread apart as the screen
    // widens), and each creature's subtree rides its ONE shift rigidly.
    private static void TwoCreaturesSpreadPerPositionSubtreeRigid()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("enemyContainer", "frame", 960, 400, 0, 0, anchorLeft: 0.5, anchorRight: 0.5),
            N("creatureL", "enemyContainer", 600, 400, 200, 300, nodeType: "NCreature"),
            N("spineL", "creatureL", 650, 500, 100, 200, nodeType: "Sprite2D"),
            N("creatureR", "enemyContainer", 1200, 400, 200, 300, nodeType: "NCreature"));

        double shiftL = 700 * (F - 1); // 218.75 (creatureL center 700)
        double shiftR = 1300 * (F - 1); // 406.25 (creatureR center 1300)
        Check.Close(ComposedTx(s, t, "creatureL"), 600 + shiftL, "creatureL takes its own center claim");
        Check.Close(ComposedTx(s, t, "creatureR"), 1200 + shiftR, "creatureR takes its own center claim");
        Check.That(shiftL < shiftR, "the pair spreads apart as the screen widens");
        Check.Close(ComposedTx(s, t, "spineL"), 650 + shiftL, "creatureL's subtree rides rigidly (no per-child re-spread)");
        Check.That(Rec(s, "creatureL").Prop, "a positional creature is stamped Prop");
    }

    // Hand cards under a zero-size CardHolderContainer spread per-position; a card's internal art rides with NO
    // relative skew (same shift as its holder).
    private static void HandCardsSpreadNoInternalSkew()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("cardHolders", "frame", 960, 900, 0, 0, anchorLeft: 0.5, anchorRight: 0.5),
            N("holderL", "cardHolders", 700, 800, 160, 220, nodeType: "NCard"),
            N("holderLart", "holderL", 700, 800, 160, 220, nodeType: "TextureRect"),
            N("holderR", "cardHolders", 1100, 800, 160, 220, nodeType: "NCard"));

        double shiftL = (700 + 80) * (F - 1); // holderL center 780 → 243.75
        double shiftR = (1100 + 80) * (F - 1); // holderR center 1180 → 368.75
        Check.Close(ComposedTx(s, t, "holderL"), 700 + shiftL, "holderL claims at its center");
        Check.Close(ComposedTx(s, t, "holderR"), 1100 + shiftR, "holderR claims at its center");
        Check.That(shiftL < shiftR, "the cards spread apart");
        Check.Close(ComposedTx(s, t, "holderLart"), ComposedTx(s, t, "holderL"), "internal art rides with no relative skew");
    }

    // Each targeting-arrow segment (boxed Sprite2D under boxless NTargetManager → NTargetingArrow pass-throughs) is
    // placed on the field per-position (base near the card, head near the target).
    private static void TargetingArrowSegmentsPlacedPerPosition()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("targetManager", "frame", 0, 0, nodeType: "NTargetManager"),
            N("targetingArrow", "targetManager", 0, 0, nodeType: "NTargetingArrow"),
            N("segBase", "targetingArrow", 600, 700, 24, 24, nodeType: "Sprite2D"),
            N("segHead", "targetingArrow", 1400, 300, 24, 24, nodeType: "Sprite2D"));

        double shiftBase = (600 + 12) * (F - 1); // 191.25
        double shiftHead = (1400 + 12) * (F - 1); // 441.25
        Check.Close(ComposedTx(s, t, "segBase"), 600 + shiftBase, "arrow base placed near the card");
        Check.Close(ComposedTx(s, t, "segHead"), 1400 + shiftHead, "arrow head placed near the target");
        Check.That(shiftBase < shiftHead, "segments land under the field, not on one rigid arrow-wide shift");
    }

    // Prop is stamped on positional content + pass-through groups, NOT on anchor-algebra HUD.
    private static void PropStampOnClaimersNotAnchorNodes()
    {
        var (_, _, s) = Scene(F, CombatTree());
        Check.That(Rec(s, "cardL").Prop, "a positional card is Prop");
        Check.That(Rec(s, "hand").Prop, "a pass-through hand is Prop");
        Check.That(!Rec(s, "backstop").Prop, "a full-span fill (anchor algebra) is not Prop");
        Check.That(!Rec(s, "endTurn").Prop, "a right-hug button is not Prop");
        Check.That(!Rec(s, "pile").Prop, "a left pile is not Prop");
        Check.That(!Rec(s, "relics").Prop, "a partial relic bar is not Prop");
    }

    // The SpreadIndex feeds InteractiveRectScan: a right-anchored Stop panel yields its TRUE (unshifted) game rect +
    // its cumulative SpreadDx (+Δ). Non-Control / Ignore / hidden are excluded (frozen WS-O scan behavior).
    private static void InteractiveRectsCarryGameRectAndSpreadDx()
    {
        var (state, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("panel", "frame", 1500, 100, 300, 200, anchorLeft: 1, anchorRight: 1, mouseFilter: 0),
            N("passThru", "frame", 10, 10, 50, 50, anchorLeft: 0, anchorRight: 0, mouseFilter: 1),
            N("ignored", "frame", 30, 30, 50, 50, anchorLeft: 0, anchorRight: 0, mouseFilter: 2),
            N("hiddenStop", "frame", 20, 20, 50, 50, mouseFilter: 0, visible: false));

        var rects = InteractiveRectScan.Collect(state, t, s);
        var ids = rects.ConvertAll(r => r.Id);
        Check.That(ids.Contains("panel"), "Stop panel included");
        Check.That(ids.Contains("passThru"), "Pass control included (tooltip-only, still offends the map)");
        Check.That(!ids.Contains("frame"), "mouseFilter null (non-Control) excluded");
        Check.That(!ids.Contains("ignored"), "mouse-Ignore excluded");
        Check.That(!ids.Contains("hiddenStop"), "hidden control excluded");

        var panel = rects.Find(r => r.Id == "panel");
        Check.Close(panel.Global[4], 1500, "panel yields its TRUE (unshifted) game-space origin");
        Check.Close(panel.LocalRect.Width, 300, "panel local width carried");
        Check.Close(panel.SpreadDx, Delta, "panel rendered rect = game rect shifted +Δ (right-anchored)");
    }

    // A remote cursor is placed at the shift of the Stop control under its true game point (never itself — the
    // self/echo/floater exclusion), via hitTestShift over the interactive rects.
    private static void RemoteCursorAnchorsToControlUnderPoint()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("panel", "frame", 1500, 100, 300, 200, anchorLeft: 1, anchorRight: 1, mouseFilter: 0),
            N("cursor", "frame", 1600, 150, 24, 24, mouseFilter: 0, nodeType: "NRemoteMouseCursor"));

        // The cursor's point (1600,150) sits inside the panel's game rect [1500..1800]x[100..300]; it lands on the
        // panel's shift (+Δ), NOT its own — proving the exclusion.
        Check.Close(ComposedTx(s, t, "cursor"), 1600 + Delta, "remote cursor rides the Stop control under its point");
    }

    // In empty board space (no Stop control under the cursor) the remote cursor takes a POSITIONAL claim at its own
    // game point: dx = (F−1)·gameX.
    private static void RemoteCursorPositionalClaimInDeadSpace()
    {
        var (_, t, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("panel", "frame", 1500, 100, 300, 200, anchorLeft: 1, anchorRight: 1, mouseFilter: 0),
            N("cursor", "frame", 400, 800, 24, 24, mouseFilter: 0, nodeType: "NRemoteMouseCursor"));

        Check.Close(ComposedTx(s, t, "cursor"), 400 + (400 * (F - 1)), "dead-space cursor takes a positional claim at its own X");
    }

    // The walk is deterministic: two Updates over identical inputs produce byte-identical records.
    private static void FChangeIsDeterministic()
    {
        var state = MirrorState.Create();
        foreach (var n in Localize(CombatTree()))
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
            state.ChangedIds.Add(n.Id);
        }

        state.Revision++;
        var transforms = new GlobalTransformIndex();
        transforms.Update(state);

        var spread = new SpreadIndex();
        spread.Update(state, transforms, F);
        var first = new Dictionary<string, SpreadRecord>();
        foreach (var id in state.OrderedIds)
        {
            first[id] = Rec(spread, id);
        }

        spread.Update(state, transforms, F); // re-run, same inputs
        foreach (var id in state.OrderedIds)
        {
            Check.Equal(Rec(spread, id), first[id], $"{id}: record identical across re-runs (deterministic)");
        }
    }

    // ---- WS container re-layout (card-reward "Skip" fix) ----

    // The REAL card-reward-picker chain (cardpick-live.ndjson): a full-anchored UI frame → a full-width (0/1)
    // HBoxContainer `RewardAlternatives` (containerLayout) → a 0/0-anchored boxed `CardRewardAlternativeButton`
    // (Skip) whose native box (276 wide at global x 822) is CENTERED in the 1920 frame (822 = (1920−276)/2). The
    // chain uses parent-relative local transforms, like every other fixture here.
    private static (MirrorState State, GlobalTransformIndex Transforms, SpreadIndex Spread) RewardScene(double factor, string? containerLayout) => Scene(
        factor,
        N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "UI"),
        N("rewards", "frame", 0, 884, 1920, 73, anchorLeft: 0, anchorRight: 1, nodeType: "Godot.HBoxContainer", name: "RewardAlternatives", mouseFilter: 2, containerLayout: containerLayout),
        N("skip", "rewards", 822, 884, 276, 73, anchorLeft: 0, anchorRight: 0, nodeType: "NCardRewardAlternativeButton", name: "CardRewardAlternativeButton"));

    // A CENTER-aligned HBoxContainer re-centers its packed row on the widened frame: the boxed 0/0 Skip child rides
    // ½·Δ (NOT the anchor algebra, which pins it left at dx 0). At F=1.25 (the task's number) Δ=480 → dx 240 → the
    // Skip center moves 960 → 1200. The container itself widens to the stage width (anchor algebra), never shifts.
    private static void ContainerCenterHBoxRecentersBoxedChild()
    {
        const double F125 = 1.25;
        const double Delta125 = (F125 - 1.0) * 1920.0; // 480
        var (_, t, s) = RewardScene(F125, "hbox-center");

        Check.Close(Rec(s, "rewards").Dx, 0, "the HBox itself doesn't shift (0/1 anchor algebra)");
        Check.Close(Rec(s, "rewards").RenderedWidth, 1920 + Delta125, "the HBox widens to the stage width");
        Check.Close(Rec(s, "skip").Dx, 0.5 * Delta125, "Skip rides ½·Δ (center re-layout, not the 0/0 anchor pin)");
        Check.Close(ComposedTx(s, t, "skip"), 822 + 0.5 * Delta125, "Skip origin shifts by ½·Δ");
        Check.Close(CenterX(s, t, "skip", 276), 1200, "Skip center re-centers 960 → 1200 at F=1.25");
        Check.Close(Rec(s, "skip").RenderedWidth, 0, "the boxed child rides, never widens");
        Check.That(!Rec(s, "skip").Prop, "a box-child rides a fixed translation (anchor flavor), not the squeeze field");
    }

    // Begin- and end-aligned HBoxes pack the row to the left / right: a begin child stays put (factor 0), an end
    // child rides the FULL Δ (factor 1). Same chain, only the alignment token differs.
    private static void ContainerBeginEndHBoxRedistributeBoxedChild()
    {
        const double F125 = 1.25;
        const double Delta125 = (F125 - 1.0) * 1920.0; // 480

        var (_, tb, sb) = RewardScene(F125, "hbox-begin");
        Check.Close(Rec(sb, "skip").Dx, 0, "begin-aligned: Skip doesn't shift (row packs from the left)");
        Check.Close(CenterX(sb, tb, "skip", 276), 960, "begin-aligned Skip center stays at 960");

        var (_, te, se) = RewardScene(F125, "hbox-end");
        Check.Close(Rec(se, "skip").Dx, Delta125, "end-aligned: Skip rides the FULL Δ (row packs to the right)");
        Check.Close(CenterX(se, te, "skip", 276), 960 + Delta125, "end-aligned Skip center rides +Δ");
    }

    // A VERTICAL box redistributes NOTHING horizontally (alignment is its vertical packing): its child just rides
    // the box's OWN horizontal shift (factor 0). Here the box doesn't shift (0/1), so the child stays at 960 — but
    // the intercept still fires, so the child does NOT run its own (Godot-ignored) 0/0 anchor algebra.
    private static void ContainerVBoxChildRidesParentNoHorizontalSpread()
    {
        const double F125 = 1.25;
        var (_, t, s) = RewardScene(F125, "vbox-center");
        Check.Close(Rec(s, "skip").Dx, 0, "vbox child rides the box's own shift (0), no horizontal redistribution");
        Check.Close(CenterX(s, t, "skip", 276), 960, "vbox child center unchanged (box didn't shift)");
    }

    // CROSS-AXIS EXCEPTION (map parchment fix): the REAL map chain (probe-current.ndjson) — a full-anchored
    // `TheMap` → a 0/1-anchored VBoxContainer `MapBg` (1920×3240 strip, containerLayout "vbox-begin") → 0/0
    // TextureRect tiles (`MapTop`…) that each span the container's FULL pre-widen width. Godot lays a vbox child
    // out across the box's whole width (cross-axis fill), so a full-width tile is background ART: it re-CENTERS
    // (½·Δ, the fullCanvas convention) instead of stranding left, matching Drawings/MapLegend (+½·Δ). A NARROW
    // vbox child still just rides the box (the existing vbox test above pins that).
    private static void ContainerVBoxFullWidthChildRecentersAsBackgroundArt()
    {
        const double F125 = 1.25;
        const double Delta125 = (F125 - 1.0) * 1920.0; // 480
        var (_, t, s) = Scene(
            F125,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "TheMap"),
            N("mapbg", "frame", 0, -1415, 1920, 3240, anchorLeft: 0, anchorRight: 1, nodeType: "MegaCrit.Sts2.Core.Nodes.Screens.Map.NMapBg", name: "MapBg", mouseFilter: 2, containerLayout: "vbox-begin"),
            N("maptop", "mapbg", 0, -1415, 1920, 1080, anchorLeft: 0, anchorRight: 0, nodeType: "Godot.TextureRect", name: "MapTop", mouseFilter: 2));

        Check.Close(Rec(s, "mapbg").Dx, 0, "the vbox strip itself doesn't shift (0/1 anchor algebra)");
        Check.Close(Rec(s, "mapbg").RenderedWidth, 1920 + Delta125, "the strip widens to the stage width");
        Check.Close(Rec(s, "maptop").Dx, 0.5 * Delta125, "a FULL-WIDTH vbox tile re-centers (½·Δ), not strand-left");
        Check.Close(ComposedTx(s, t, "maptop"), 0.5 * Delta125, "tile origin shifts by ½·Δ (left margin = right margin)");
        Check.Close(Rec(s, "maptop").RenderedWidth, 0, "the tile rides, never widens (art re-centers, not stretches)");
        Check.That(!Rec(s, "maptop").Prop, "a box-child rides a fixed translation (anchor flavor), not the squeeze field");
    }

    // Without the containerLayout hint, the 0/0 Skip child follows anchor algebra and is pinned left (dx 0, center
    // stranded at 960). This preserves the explicit no-layout input shape.
    private static void ContainerWithoutLayoutUsesAnchorAlgebra()
    {
        const double F125 = 1.25;
        var (_, t, s) = RewardScene(F125, null);
        Check.Close(Rec(s, "skip").Dx, 0, "no container hint → 0/0 anchor algebra pins Skip left (the bug)");
        Check.Close(CenterX(s, t, "skip", 276), 960, "unfixed Skip center stays at 960 (off-center on the widened stage)");
    }

    // WS-FPS walk bail: a drain whose every changed node carries only walk-IRRELEVANT flags (a spine track echo →
    // None; text/effects volatile) skips the walk entirely — records/stamps stay last walk's, no views dirty, and
    // Bails increments. Any walk-relevant bit (Transform/Tint/Draw/Static/New/Removed), a ChangedIds/ChangeFlags
    // count mismatch (an unclassified change), or a factor change forces the full walk (fail-closed).
    private static void WalkBailsOnIrrelevantDrainsOnly()
    {
        var (state, transforms, spread) = RewardScene(1.25, "hbox-center");
        var before = Rec(spread, "skip");
        Check.That(spread.Bails == 0, "no bail on the first (record-building) walk");

        // Simulate FinishDrain's consume-then-clear, then a track-echo drain: one changed id flagged None.
        state.ChangedIds.Clear();
        state.ChangeFlags.Clear();
        state.ChangedIds.Add("skip");
        state.ChangeFlags["skip"] = NodeChangeFlags.None;
        spread.Update(state, transforms, 1.25);
        Check.That(spread.Bails == 1, "a None-flagged (track-echo-style) drain bails the walk");
        Check.Close(Rec(spread, "skip").Dx, before.Dx, "a bailed walk keeps last walk's records");
        Check.That(spread.DirtyIds.Count == 0, "a bailed walk dirties no views");

        // A Transform-flagged drain must walk (no new bail).
        state.ChangeFlags["skip"] = NodeChangeFlags.Transform;
        spread.Update(state, transforms, 1.25);
        Check.That(spread.Bails == 1, "a Transform-flagged drain runs the full walk");

        // A changed id with NO flag entry (an unclassified change) → fail closed, walk.
        state.ChangeFlags.Clear();
        spread.Update(state, transforms, 1.25);
        Check.That(spread.Bails == 1, "a ChangedIds/ChangeFlags mismatch forces the walk");

        // A factor change never bails (DirtyAll rescale path).
        spread.Update(state, transforms, 1.30);
        Check.That(spread.Bails == 1 && spread.DirtyAll, "an F change walks with DirtyAll");
    }

    // R11: a Region-only drain (a same-size atlas-FRAME swap — the Tezcatara flames) BAILS the wide-screen walk —
    // Region is deliberately absent from WalkRelevant, so the ~14ms/p50 spread walk no longer runs on every flame
    // frame (the 9-14fps driver). A SIZE-changing swap classifies Region|Draw (LocalRect derives from region size) and
    // Draw IS walk-relevant, so it still walks — the fail-closed guarantee.
    private static void WalkBailsOnRegionOnlyDrains()
    {
        var (state, transforms, spread) = RewardScene(1.25, "hbox-center");
        Check.That(spread.Bails == 0, "no bail on the first (record-building) walk");

        state.ChangedIds.Clear();
        state.ChangeFlags.Clear();
        state.ChangedIds.Add("skip");
        state.ChangeFlags["skip"] = NodeChangeFlags.Region;
        spread.Update(state, transforms, 1.25);
        Check.That(spread.Bails == 1, "a Region-only (flame frame swap) drain bails the wide-screen walk");

        state.ChangeFlags["skip"] = NodeChangeFlags.Region | NodeChangeFlags.Draw;
        spread.Update(state, transforms, 1.25);
        Check.That(spread.Bails == 1, "a Region|Draw (size-changing) swap runs the walk (Draw is walk-relevant)");
    }

    // The boxless bg SCENE ROOT (matched by SceneFilePath) re-centers on ½Δ and CONSUMES the budget, so the full-
    // canvas art AND its two differently-placed candle flames all ride that SAME ½Δ rigidly — the flames stay matched
    // to the bg (the user's constraint). Without the branch the boxless root would pass the budget through and each
    // flame/sprite would take its OWN center claim (see UnmatchedBackgroundSceneUsesPassThroughClaims).
    private static void EventBgSceneRootRecentersWholeSubtree()
    {
        var (_, _, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("bgRoot", "frame", 0, 0, nodeType: "Node2D", sceneFile: "res://scenes/backgrounds/tezcatara/tezcatara_background.tscn"),
            N("bgArt", "bgRoot", 0, 0, 1920, 1080, nodeType: "Sprite2D"),
            N("flameL", "bgRoot", 400, 600, 64, 128, nodeType: "Sprite2D"),
            N("flameR", "bgRoot", 1500, 600, 64, 128, nodeType: "Sprite2D"));

        Check.Close(Rec(s, "bgRoot").Dx, Delta / 2, "event bg scene root re-centers on ½Δ");
        Check.Close(Rec(s, "bgArt").Dx, Delta / 2, "bg art rides the root's ½Δ rigidly (consume)");
        Check.Close(Rec(s, "flameL").Dx, Delta / 2, "left flame rides the SAME ½Δ (matched to bg)");
        Check.Close(Rec(s, "flameR").Dx, Delta / 2, "right flame rides the SAME ½Δ (matched to bg)");
        Check.That(!Rec(s, "bgRoot").Prop && !Rec(s, "flameL").Prop, "bg subtree rides rigidly (not the positional field)");
    }

    // A non-event background scene (the underdocks combat backdrop)
    // does NOT match the event-specific matcher) uses PASS-THROUGH placement: the boxless root strands at
    // origin (Dx 0) and passes the budget through, so its sprite (center 960 → ½Δ) and flames take DIFFERENT own-center
    // claims. Proves the matcher is narrow — it re-centers ONLY the Tezcatara event, never combat/map/room backdrops.
    private static void UnmatchedBackgroundSceneUsesPassThroughClaims()
    {
        var (_, _, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("grp", "frame", 0, 0, nodeType: "Node2D", sceneFile: "res://scenes/backgrounds/underdocks/underdocks_background.tscn"),
            N("bgArt", "grp", 0, 0, 1920, 1080, nodeType: "Sprite2D"),
            N("flameL", "grp", 400, 600, 64, 128, nodeType: "Sprite2D"),
            N("flameR", "grp", 1500, 600, 64, 128, nodeType: "Sprite2D"));

        Check.Close(Rec(s, "grp").Dx, 0, "non-bg boxless group strands at origin (pass-through)");
        Check.Close(Rec(s, "bgArt").Dx, 300, "its bg sprite takes its own center claim (960·rate = ½Δ)");
        Check.Close(Rec(s, "flameL").Dx, 432 * (F - 1), "left flame at its own center (432·rate) — desynced");
        Check.That(Rec(s, "flameL").Dx < Rec(s, "flameR").Dx - 1, "the two flames get DIFFERENT shifts without the fix");
    }

    // R7 FIX 1 truth table for IsBackgroundSceneRoot (exercised through the walk's re-center behavior, the observable
    // proxy for the private predicate): every EVENT backdrop under `res://scenes/events/background_scenes/` — neow +
    // two siblings + the legacy tezcatara — is a matched root that re-centers on ½Δ (a boxless bg positioner would
    // otherwise strand at origin 0). A COMBAT bg (`scenes/backgrounds/<name>/<name>_background.tscn`) and a ROOM/MAP
    // scene are NOT matched → pass-through (Dx 0). Proves the directory match is EVENT-EXCLUSIVE (no combat/map/room
    // under `events/background_scenes/`), the over-match guard the whitelist comment warns about.
    private static void EventBgWhitelistMatchesEventBackdropDirectory()
    {
        // A minimal scene: a full-anchored frame → a boxless Node2D bg root carrying `sceneFile`. The root re-centers
        // on ½Δ iff it is a matched event-bg root, else it strands at its origin (0) as a pass-through group.
        static double RootDx(string sceneFile)
        {
            var (_, _, s) = Scene(
                F,
                N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
                N("bgRoot", "frame", 0, 0, nodeType: "Node2D", sceneFile: sceneFile));
            return Rec(s, "bgRoot").Dx;
        }

        // TRUE — every event backdrop under the matched directory re-centers on ½Δ (real streamed paths).
        foreach (var evt in new[] { "neow", "darv", "orobas", "pael", "tanx", "vakuu", "nonupeipe" })
        {
            Check.Close(RootDx($"res://scenes/events/background_scenes/{evt}.tscn"), Delta / 2, $"{evt}: event backdrop matched → re-centers ½Δ");
        }

        Check.Close(RootDx("res://scenes/events/background_scenes/tezcatara.tscn"), Delta / 2, "tezcatara (real event dir path): matched → re-centers ½Δ");

        // FALSE — combat/map/room scenes are a DIFFERENT directory and must NEVER be rigidly re-centered (pass-through).
        Check.Close(RootDx("res://scenes/backgrounds/ceremonial_beast_boss/ceremonial_beast_boss_background.tscn"), 0, "combat boss backdrop: NOT matched (stays pass-through)");
        Check.Close(RootDx("res://scenes/backgrounds/underdocks/underdocks_background.tscn"), 0, "combat backdrop: NOT matched (stays pass-through)");
        Check.Close(RootDx("res://scenes/map/map_room.tscn"), 0, "map/room scene: NOT matched (stays pass-through)");
        Check.Close(RootDx("res://scenes/rooms/combat_room.tscn"), 0, "combat room scene: NOT matched (stays pass-through)");
    }

    // R7 FIX 1 core: a POINT-ANCHOR spine (a SpineSprite with a current anim + NO localRect, like neow's figure) under a
    // MATCHED event-bg root inherits the root's rigid ½Δ re-center instead of taking its OWN origin-based positional
    // claim (clampGx(centerGx)·rate). The root CONSUMES the budget (childDeltaParentWidth=0 + childParentDx=½Δ), so the
    // spine — a DeltaParentWidth==0 rider — skips the whole spread body and rides ½Δ, landing over the re-centered
    // backdrop. Without the match the root passes the budget through and the spine strands on its own
    // origin claim (the neow-decentered-spine bug) — the A/B contrast at the same spreadFactor.
    private static void EventBgPointAnchorSpineInheritsRigidRecenter()
    {
        // The spine's global origin (600) gives an OWN positional claim of 600·rate that DIFFERS from ½Δ, so the two
        // regimes are distinguishable. spreadFactor = F = 1.3125 > 1 (the wide stage where the bug manifests).
        MirrorNode[] scene =
        [
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("bgRoot", "frame", 0, 0, nodeType: "Node2D", sceneFile: "res://scenes/events/background_scenes/neow.tscn"),
            N("bgArt", "bgRoot", 0, 0, 1920, 1080, nodeType: "Sprite2D"),
            N("spine", "bgRoot", 600, 500, nodeType: "SpineSprite", spineScene: "res://spine/neow.tscn", spineAnim: "idle"),
        ];

        var (_, _, s) = Scene(F, scene);
        double ownClaim = 600 * (F - 1); // what the origin-based positional claimer WOULD give (150 at F=1.3125)
        Check.That(Math.Abs(ownClaim - Delta / 2) > 1, "the spine's own origin claim differs from ½Δ (so the regimes are distinguishable)");
        Check.Close(Rec(s, "bgRoot").Dx, Delta / 2, "matched event-bg root re-centers on ½Δ");
        Check.Close(Rec(s, "bgArt").Dx, Delta / 2, "backdrop art rides the root's ½Δ rigidly");
        Check.Close(Rec(s, "spine").Dx, Delta / 2, "point-anchor spine INHERITS the root's rigid ½Δ (rides with the backdrop)");
        Check.That(!Rec(s, "spine").Prop, "the spine rides rigidly (not the positional squeeze field)");

    }

    // The full-frame card-PREVIEW container (matched by leaf type NCardPreviewContainer, a sibling of the
    // event-bg re-center) re-centers on ½Δ and CONSUMES the budget, so its backdrop AND its off-center preview card
    // both ride that SAME ½Δ rigidly — the card stays glued to its backdrop (the fix). Without the branch the inner
    // card would take its OWN center claim (1400·rate) and drift off the backdrop.
    private static void PreviewContainerRecentersWholeSubtree()
    {
        var (_, _, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("preview", "frame", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, nodeType: "NCardPreviewContainer"),
            N("backdrop", "preview", 0, 0, 1920, 1080, nodeType: "TextureRect"),
            N("card", "preview", 1320, 400, 160, 220, nodeType: "NCard"));

        Check.Close(Rec(s, "preview").Dx, Delta / 2, "preview container re-centers on ½Δ");
        Check.Close(Rec(s, "backdrop").Dx, Delta / 2, "backdrop rides the container's ½Δ rigidly (consume)");
        Check.Close(Rec(s, "card").Dx, Delta / 2, "preview card rides the SAME ½Δ (matched to backdrop), not its own center claim");
        Check.That(!Rec(s, "preview").Prop && !Rec(s, "card").Prop, "preview subtree rides rigidly (not the positional field)");
    }

    // A non-full-frame preview container (NMessyCardPreviewContainer streams
    // 1355×762, confirmed from real recordings) must NOT over-center on ½Δ — it rides its parent's shift (the spec's
    // non-full-1920 fallback) while STILL consuming, so its inner card rides it rigidly (no drift) rather than taking
    // its own center claim. Contrast the full-frame leg above (which does re-center on ½Δ).
    private static void PreviewNarrowContainerRidesParentNotRecenter()
    {
        var (_, _, s) = Scene(
            F,
            N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
            N("messy", "frame", 0, 0, 1355, 762, anchorLeft: 0, anchorRight: 1, nodeType: "NMessyCardPreviewContainer"),
            N("card", "messy", 1320, 400, 160, 220, nodeType: "NCard"));

        Check.Close(Rec(s, "messy").Dx, 0, "narrow preview container rides its parent's shift (0), NOT ½Δ");
        Check.That(Math.Abs(Rec(s, "messy").Dx - (Delta / 2)) > 1, "narrow container did NOT over-center on ½Δ");
        Check.Close(Rec(s, "card").Dx, 0, "narrow preview's card rides the container rigidly (consume), not its 1400·rate own claim");
        Check.That(!Rec(s, "card").Prop, "narrow preview card rides rigidly (not the positional field)");
    }

    // ---- Map drawing tools ----

    // The map screen tree: the map_screen.tscn ROOT (full-anchored 0/1, so it hands its children a
    // 600px anchor budget) → the full-canvas parchment TILE (re-centers on ½Δ, the content the palette must stay
    // matched to), the 0/0-anchored DrawingTools palette + its HBox/button interior, and a genuine bottom-left corner
    // widget (`Back`) that must KEEP its corner. Node NAMES matter here: the match is scene identity, not geometry.
    private static MirrorNode[] MapScreenTree() =>
    [
        N("mapScreen", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "MapScreen",
            sceneFile: "res://scenes/screens/map/map_screen.tscn"),
        N("mapTile", "mapScreen", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect", name: "MapTop"),
        N("tools", "mapScreen", 56, 972, 208, 68, anchorLeft: 0, anchorRight: 0, nodeType: "NinePatchRect", name: "DrawingTools"),
        N("toolsBox", "tools", 66, 976, 188, 60, mouseFilter: 2, nodeType: "HBoxContainer", name: "HBoxContainer"),
        N("drawButton", "toolsBox", 66, 976, 60, 60, mouseFilter: 0, name: "DrawButton"),
        N("back", "mapScreen", 15, 980, 80, 80, anchorLeft: 0, anchorRight: 0, name: "Back"),
    ];

    // The DrawingTools palette is a SMALL 0/0-anchored box, so the anchor algebra would hand it leftClaim 0
    // (dx 0 — a fixed distance from the stage's LEFT edge) while the map's own content re-centers on ½Δ. The scene-
    // identity match forces the 0.5 claim so the palette keeps its position relative to the centered map; its span is
    // 0, so deltaW stays 0 (no widen) and the whole interior rides that ONE shift RIGIDLY.
    private static void DrawingToolsClaimsCenterAndRidesSubtreeRigidly()
    {
        var (_, t, s) = Scene(F, MapScreenTree());

        Check.Close(Rec(s, "mapTile").Dx, Delta / 2, "the full-canvas map tile re-centers on ½Δ (the content to match)");
        Check.Close(Rec(s, "tools").Dx, Delta / 2, "DrawingTools claims 0.5 → ½Δ, matched to the centered map content");
        Check.Close(ComposedTx(s, t, "tools"), 56 + (Delta / 2), "DrawingTools renders at its design x + ½Δ");
        Check.Close(Rec(s, "tools").RenderedWidth, 0, "span 0 ⇒ deltaW 0: the palette is TRANSLATED, never widened");
        Check.That(!Rec(s, "tools").Prop, "the palette rides an anchored translation, not the positional field");

        // The interior rides the SAME absolute shift (the parent consumed the budget → childDeltaParentWidth 0).
        Check.Close(Rec(s, "toolsBox").Dx, Delta / 2, "the palette's HBox rides the SAME ½Δ rigidly");
        Check.Close(Rec(s, "drawButton").Dx, Delta / 2, "each palette BUTTON rides the SAME ½Δ rigidly");
        Check.That(!Rec(s, "toolsBox").Prop && !Rec(s, "drawButton").Prop,
            "the palette's subtree rides rigidly (not the positional squeeze field)");

        // NEGATIVE: an ordinary bottom-left CORNER widget on the same screen keeps its corner — the rule is identity-
        // scoped, not "every small 0/0 box on the map screen".
        Check.Close(Rec(s, "back").Dx, 0, "an ordinary 0/0 corner widget on the map screen keeps its corner (dx 0)");
    }

    // The predicate keys on the full (scene FILE, scene-relative PATH) tuple. A node NAMED
    // DrawingTools under a DIFFERENT scene file, and a DIFFERENTLY-named 0/0 box under map_screen.tscn, both keep the
    // plain anchor result (dx 0). The name alone is only the cheap pre-filter.
    private static void DrawingToolsMatchIsSceneIdentityScoped()
    {
        var (_, _, s) = Scene(
            F,
            N("deck", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "DeckViewScreen",
                sceneFile: "res://scenes/screens/deck_view_screen.tscn"),
            // same NAME, different scene file → no match.
            N("otherTools", "deck", 56, 972, 208, 68, anchorLeft: 0, anchorRight: 0, nodeType: "NinePatchRect", name: "DrawingTools"),
            N("map", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "MapScreen",
                sceneFile: "res://scenes/screens/map/map_screen.tscn"),
            // right scene file, different NAME → no match.
            N("legend", "map", 1656, 289, 340, 454, anchorLeft: 0, anchorRight: 0, nodeType: "NinePatchRect", name: "MapLegend"),
            // right scene file + right name, but NESTED (relPath "Wrapper/DrawingTools") → no match: the entry pins the
            // panel the map screen owns directly, exactly like the view-scale table row. The wrapper is 0/1-anchored so
            // it hands the nested node a REAL anchor budget — the nested node genuinely reaches the anchor algebra
            // (and would claim ½Δ if the predicate matched on the name alone).
            N("wrapper", "map", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "Wrapper"),
            N("nested", "wrapper", 56, 972, 208, 68, anchorLeft: 0, anchorRight: 0, nodeType: "NinePatchRect", name: "DrawingTools"));

        Check.Close(Rec(s, "otherTools").Dx, 0, "a same-NAMED panel under another scene file keeps the plain 0/0 claim");
        Check.Close(Rec(s, "legend").Dx, 0, "a differently-named 0/0 box under map_screen.tscn keeps the plain claim");
        Check.Close(Rec(s, "nested").Dx, 0, "a NESTED DrawingTools (relPath 'Wrapper/DrawingTools') does not match");
    }

    // ---- Main-menu focus ribbons ----

    // The main-menu tree the 6b legs share (shape taken from a live lobby recording, .sts2/bench/
    // ws7-charselect-hostready.ndjson): the main_menu.tscn ROOT (0/1, so it hands its children the full anchor
    // budget) → the 0.5/0.5 option COLUMN, the two 0/0-anchored 40x40 ribbon TextureRects the game re-positions each
    // frame to flank the focused option, and a genuine top-left corner widget (`ChangeProfileButton`, 0/0) that must
    // KEEP its corner. Node NAMES matter: the match is scene identity, not geometry.
    private static MirrorNode[] MainMenuTree() =>
    [
        N("menu", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "MainMenu",
            sceneFile: "res://scenes/screens/main_menu.tscn"),
        N("column", "menu", 826, 315, 269, 450, anchorLeft: 0.5, anchorRight: 0.5, nodeType: "VBoxContainer",
            name: "MainMenuTextButtons"),
        N("reticleL", "menu", 636, 633, 40, 40, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect",
            name: "ButtonReticleLeft"),
        N("reticleR", "menu", 859, 618, 40, 40, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect",
            name: "ButtonReticleRight"),
        N("profile", "menu", 40, 40, 172, 64, anchorLeft: 0, anchorRight: 0, name: "ChangeProfileButton"),
    ];

    // 6b core: the ribbons are 40x40 0/0-anchored boxes, too small for the fullCanvas seam, so the anchor algebra
    // hands them leftClaim 0 (dx 0 — a fixed distance from the stage's LEFT edge) while the 0.5/0.5 option column
    // they mark re-centers on ½Δ. The scene-identity match forces the same 0.5 claim, so a ribbon lands beside its
    // option again; span 0 ⇒ deltaW 0, so a 40x40 ribbon is TRANSLATED, never widened.
    private static void MenuReticlesRideTheOptionColumn()
    {
        var (_, t, s) = Scene(F, MainMenuTree());

        Check.Close(Rec(s, "column").Dx, Delta / 2, "the 0.5-anchored option column re-centers on ½Δ (the content to match)");
        Check.Close(Rec(s, "reticleL").Dx, Delta / 2, "ButtonReticleLeft claims 0.5 → ½Δ, matched to the column");
        Check.Close(Rec(s, "reticleR").Dx, Delta / 2, "ButtonReticleRight claims 0.5 → ½Δ, matched to the column");
        Check.Close(ComposedTx(s, t, "reticleL"), 636 + (Delta / 2), "the ribbon renders at its design x + ½Δ");
        Check.Close(Rec(s, "reticleL").RenderedWidth, 0, "span 0 ⇒ deltaW 0: a ribbon is TRANSLATED, never widened");
        Check.That(!Rec(s, "reticleL").Prop, "the ribbon rides an anchored translation, not the positional field");

        // NEGATIVE: an ordinary top-left CORNER widget on the same screen keeps its corner — the rule is identity-
        // scoped, not "every small 0/0 box on the main menu".
        Check.Close(Rec(s, "profile").Dx, 0, "an ordinary 0/0 corner widget on the menu keeps its corner (dx 0)");
    }

    // 6b match narrowness: the predicate keys on the full (scene FILE, scene-relative PATH) tuple, exactly like
    // DrawingTools. A same-NAMED ribbon under a different scene file, a differently-named 0/0 box under
    // main_menu.tscn, and a NESTED ButtonReticleLeft all keep the plain anchor result (dx 0).
    private static void MenuReticleMatchIsSceneIdentityScoped()
    {
        var (_, _, s) = Scene(
            F,
            N("other", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "CharSelect",
                sceneFile: "res://scenes/screens/character_select.tscn"),
            N("otherReticle", "other", 636, 633, 40, 40, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect",
                name: "ButtonReticleLeft"),
            N("menu", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "MainMenu",
                sceneFile: "res://scenes/screens/main_menu.tscn"),
            N("plain", "menu", 40, 40, 40, 40, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect", name: "Corner"),
            // right scene file + right name, but NESTED (relPath "Wrapper/ButtonReticleLeft") → no match. The wrapper
            // is 0/1-anchored so the nested node genuinely reaches the anchor algebra.
            N("wrapper", "menu", 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1, name: "Wrapper"),
            N("nested", "wrapper", 636, 633, 40, 40, anchorLeft: 0, anchorRight: 0, nodeType: "TextureRect",
                name: "ButtonReticleLeft"));

        Check.Close(Rec(s, "otherReticle").Dx, 0, "a same-NAMED ribbon under another scene file keeps the plain 0/0 claim");
        Check.Close(Rec(s, "plain").Dx, 0, "a differently-named 0/0 box under main_menu.tscn keeps the plain claim");
        Check.Close(Rec(s, "nested").Dx, 0, "a NESTED ButtonReticleLeft (relPath 'Wrapper/…') does not match");
    }

    // ---- WS-P2 incremental ApplySpread ----

    // The SpreadViewStamp SceneReconciler.ApplySpread would derive for `id`, computed INDEPENDENTLY here from the
    // records (parent record Dx + parent global) — the ground truth the in-walk stamp must reproduce bit-for-bit.
    private static SpreadViewStamp ExpectedStamp(MirrorState state, GlobalTransformIndex t, SpreadIndex s, string id)
    {
        if (!s.TryGet(id, out var rec))
        {
            return default;
        }

        double parentDx = 0;
        IReadOnlyList<double> parentGlobal = Affine.Identity;
        if (state.Nodes.TryGetValue(id, out var node) && node.ParentId is { } pid)
        {
            if (s.TryGet(pid, out var prec))
            {
                parentDx = prec.Dx;
            }

            if (t.TryGetGlobal(pid, out var pg))
            {
                parentGlobal = pg;
            }
        }

        var (ox, oy) = SpreadMath.ParentFrameOffset(parentGlobal, rec.Dx - parentDx);
        return new SpreadViewStamp(ox, oy, rec.RenderedWidth);
    }

    private static void AssertStampParity((MirrorState State, GlobalTransformIndex Transforms, SpreadIndex Spread) scene, string label)
    {
        var (state, t, s) = scene;
        foreach (var id in state.OrderedIds)
        {
            Check.That(s.TryGetStamp(id, out var stamp), $"{label}/{id}: every walked node carries a view stamp");
            Check.Equal(stamp, ExpectedStamp(state, t, s, id), $"{label}/{id}: view stamp == independent ApplySpread math");
        }
    }

    // Every node's in-walk view stamp equals the reconciler's ApplySpread per-view math computed independently — the
    // equivalence the incremental fast path relies on, across the anchor-algebra HUD, positional claimers, an
    // owner-anchored floater, and a pass-through creature subtree (each resolves dx via a different branch).
    private static void ViewStampMatchesApplySpreadMath()
    {
        AssertStampParity(Scene(F, CombatTree()), "combat");

        AssertStampParity(
            Scene(
                F,
                N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
                N("owner", "frame", 1700, 20, 120, 60, anchorLeft: 1, anchorRight: 1),
                N("tips", "frame", 0, 0, 0, 0, anchorLeft: 0, anchorRight: 0),
                N("tooltip", "tips", 1700, 110, 360, 80, nodeType: "NHoverTipSet", anchorOwnerId: "owner"),
                N("tipLabel", "tooltip", 1710, 120, 340, 40, nodeType: "Label")),
            "floater");

        AssertStampParity(
            Scene(
                F,
                N("frame", null, 0, 0, 1920, 1080, anchorLeft: 0, anchorRight: 1),
                N("enemies", "frame", 1128, 300, 0, 0, anchorLeft: 0.5, anchorRight: 0.5),
                N("creature", "enemies", 1400, 500, 0, 0),
                N("visual", "creature", 1300, 380, 200, 300, nodeType: "Sprite2D"),
                N("hitbox", "creature", 1280, 380, 240, 300, anchorLeft: 0, anchorRight: 0),
                N("healthbar", "creature", 1290, 700, 220, 30, anchorLeft: 0.5, anchorRight: 0.5)),
            "creature");

        // The container box-child resolves dx via the BOX CHILD branch; its stamp must still equal ApplySpread's math.
        AssertStampParity(RewardScene(F, "hbox-center"), "container");
    }

    // The per-drain dirty set narrows to exactly what changed: (a) an unchanged steady-factor re-run → empty dirty,
    // no DirtyAll; (b) moving a pass-through group re-places it AND its two riding cards (their stamps fold against
    // the moved parent) → exactly that subtree; (c) pruning a node → exactly that node (its view needs zeroing).
    private static void DirtySetTracksChangesAcrossUpdates()
    {
        var state = MirrorState.Create();
        foreach (var n in Localize(CombatTree()))
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
            state.ChangedIds.Add(n.Id);
        }

        state.Revision++;
        var t = new GlobalTransformIndex();
        t.Update(state);
        var s = new SpreadIndex();

        // Warm: the first widen is a 1→F transition (DirtyAll) that stamps every node.
        s.Update(state, t, F);
        Check.That(s.DirtyAll, "first widen sets DirtyAll (1→F transition)");

        // Steady: identical inputs at the same F → no view needs re-stamping.
        state.ChangedIds.Clear();
        s.Update(state, t, F);
        Check.That(!s.DirtyAll, "a steady-factor re-run clears DirtyAll");
        Check.Equal(s.DirtyIds.Count, 0, "steady-factor re-run over an unchanged scene → empty dirty set");

        // Move the hand group. Descendant globals are recomputed by the transform index; only the hand's own spread
        // record changes because the cards keep their local layout offsets.
        state.Nodes["hand"].Transform = [1, 0, 0, 1, 1100, 900]; // hand tx 960 → 1100
        state.ChangedIds.Clear();
        state.ChangedIds.Add("hand");
        state.Revision++;
        t.Update(state);
        s.Update(state, t, F);
        Check.That(!s.DirtyAll, "a steady-factor move keeps DirtyAll false");
        var moved = new HashSet<string>(s.DirtyIds);
        Check.That(
            moved.SetEquals(new[] { "hand" }),
            $"moving hand dirties exactly its spread record (got [{string.Join(",", moved)}])");

        // Prune cardR entirely: exactly cardR is dirty (its view must be zeroed) and its stamp is dropped.
        state.Nodes.Remove("cardR");
        state.OrderedIds.Remove("cardR");
        state.ChangedIds.Clear();
        state.ChangedIds.Add("cardR");
        state.Revision++;
        t.Update(state);
        s.Update(state, t, F);
        var pruned = new HashSet<string>(s.DirtyIds);
        Check.That(pruned.SetEquals(new[] { "cardR" }), $"pruning cardR dirties exactly cardR (got [{string.Join(",", pruned)}])");
        Check.That(!s.TryGetStamp("cardR", out _), "pruned cardR carries no stamp");
    }
}
