using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for HoverTipScaleMath.ComputeStamp — the recording-derived HoverTip 1.2× anchor + clamp geometry
// (Feature A / WS-VIEW). Vectors are stated as (x, y, w, h) design-space child boxes (→ DesignAabb).
internal static class HoverTipScaleMathTests
{
    private const double W = 1920, H = 1080, K = 1.2;

    public static void Run()
    {
        SingleColumnMinAnchored();
        CreatureTipRightEdgeHug();
        BottomHugAnchorsBottom();
        StraddleColumnsPivotAtGapMidpoint();
        BottomClampPushesUp();
        OversizedTipPinsTop();
        EmptyNoStamp();
        WidenedDesignWidthRightHug();
        SwitchOffFactorPassThrough();
        // #17/#18 — pivot-X keyed by owner KIND (grow toward the side the tip sits on).
        CreatureTipGrowsLeftUpAwayFromOwner();
        CardTipOwnerLeftGrowsRightUp();
        OwnerClearlyAboveGrowsDown();
        OwnerDrivenGrowUpTopClamp();
        KindHandCardGrowsRight();
        KindCardRewardGrowsRight();
        KindCreatureGrowsLeft();
        KindRewardItemGrowsLeft();
        NoneOverflowFlipsToMaxX();
        OwnerKindResolution();
        // R5 (item 5) non-overlap invariant — the enforceable side-clamp matrix.
        SideClampPushesHandCardTipRight();
        SideClampPushesCreatureTipLeft();
        SideClampFlipsOnViewportOverflow();
        SideClampSkipsStraddle();
        OwnerFollowTranslatesTip();
        // R8 (WS-1) — the two CORNER anchor pivots on ComputeAnchoredStamp. R9 (WS-B) extends each leg with the new
        // MiddleRight EDGE pivot (right edge pinned, vertical growth symmetric about the box centre).
        AnchoredStampCornerPivots();
        AnchoredStampCornerPivotsAreCornerFixedPoints();
        AnchoredStampCornerPivotClamps();
        AnchoredStampCornerPivotNoClampKeepsEdge();
        AnchoredStampCenteredAxesUnchangedByCornerAndEdgePivots();
    }

    // R8: BottomLeft pins the box's bottom-LEFT corner (pivot = MinX/MaxY) and BottomRight the bottom-RIGHT corner
    // (MaxX/MaxY) — the first pivots whose X is NOT the box centre. Vectors are the two real combat piles.
    private static void AnchoredStampCornerPivots()
    {
        var draw = new DesignAabb(15, 985, 95, 1065);   // draw_pile.tscn root, 80×80 bottom-left
        var bl = HoverTipScaleMath.ComputeAnchoredStamp(
            draw, 1.25, W, H, HoverTipScaleMath.AnchorPivot.BottomLeft)!.Value;
        Check.Close(bl.PivotX, 15, "bottom-left: pivot X == box LEFT edge (grows right)");
        Check.Close(bl.PivotY, 1065, "bottom-left: pivot Y == box BOTTOM edge (grows up)");
        Check.Close(bl.ClampX, 0, "draw pile scaled 1.25 from its corner stays on-screen (no X clamp)");
        Check.Close(bl.ClampY, 0, "draw pile scaled 1.25 from its corner stays on-screen (no Y clamp)");

        var discard = new DesignAabb(1826, 985, 1906, 1065); // discard_pile.tscn root, 80×80 bottom-right
        var br = HoverTipScaleMath.ComputeAnchoredStamp(
            discard, 1.25, W, H, HoverTipScaleMath.AnchorPivot.BottomRight)!.Value;
        Check.Close(br.PivotX, 1906, "bottom-right: pivot X == box RIGHT edge (grows left)");
        Check.Close(br.PivotY, 1065, "bottom-right: pivot Y == box BOTTOM edge (grows up)");
        Check.Close(br.ClampX, 0, "discard pile grows inward from the right corner (no X clamp)");
        Check.Close(br.ClampY, 0, "discard pile grows inward from the right corner (no Y clamp)");

        // R9 MiddleRight: the exhaust pile's real box — right-anchored like the discard pile, but mid-height. Pivot X
        // is the RIGHT edge (same as BottomRight); pivot Y is the box CENTRE (NOT the bottom — that is the whole
        // difference between the edge pivot and the corner pivot).
        var exhaust = new DesignAabb(1830, 800, 1910, 880); // exhaust_pile.tscn root, 80×80 mid-right
        var mr = HoverTipScaleMath.ComputeAnchoredStamp(
            exhaust, 1.25, W, H, HoverTipScaleMath.AnchorPivot.MiddleRight)!.Value;
        Check.Close(mr.PivotX, 1910, "middle-right: pivot X == box RIGHT edge (grows left)");
        Check.Close(mr.PivotY, 840, "middle-right: pivot Y == box CENTRE (splays up AND down, unlike BottomRight)");
        Check.Close(mr.ClampX, 0, "exhaust pile scaled 1.25 from its right edge stays on-screen (no X clamp)");
        Check.Close(mr.ClampY, 0, "exhaust pile splayed about its centre stays on-screen (no Y clamp)");

        // Same box under BottomRight would pin the BOTTOM instead — the behaviour the new pivot deliberately avoids.
        var asCorner = HoverTipScaleMath.ComputeAnchoredStamp(
            exhaust, 1.25, W, H, HoverTipScaleMath.AnchorPivot.BottomRight)!.Value;
        Check.Close(asCorner.PivotY, 880, "BottomRight on the same box pins the BOTTOM (880), not the centre (840)");
    }

    // The pinned CORNER is the stamp's fixed point: forward-mapping that corner returns it unchanged, so the enlarged
    // widget stays glued to the screen corner the game anchored it to (the whole point of the new pivots).
    private static void AnchoredStampCornerPivotsAreCornerFixedPoints()
    {
        var draw = new DesignAabb(15, 985, 95, 1065);
        var bl = HoverTipScaleMath.ComputeAnchoredStamp(
            draw, 1.25, W, H, HoverTipScaleMath.AnchorPivot.BottomLeft)!.Value;
        Check.Close(Fwd(bl, 15, 1065).X, 15, "bottom-left corner is fixed in X");
        Check.Close(Fwd(bl, 15, 1065).Y, 1065, "bottom-left corner is fixed in Y");
        // The opposite corner is where the growth lands: 15 + 1.25·80 = 115, 1065 − 1.25·80 = 965.
        Check.Close(Fwd(bl, 95, 985).X, 115, "bottom-left grows RIGHT to 115");
        Check.Close(Fwd(bl, 95, 985).Y, 965, "bottom-left grows UP to 965");

        var discard = new DesignAabb(1826, 985, 1906, 1065);
        var br = HoverTipScaleMath.ComputeAnchoredStamp(
            discard, 1.25, W, H, HoverTipScaleMath.AnchorPivot.BottomRight)!.Value;
        Check.Close(Fwd(br, 1906, 1065).X, 1906, "bottom-right corner is fixed in X");
        Check.Close(Fwd(br, 1906, 1065).Y, 1065, "bottom-right corner is fixed in Y");
        Check.Close(Fwd(br, 1826, 985).X, 1806, "bottom-right grows LEFT to 1806");
        Check.Close(Fwd(br, 1826, 985).Y, 965, "bottom-right grows UP to 965");

        // ViewScale.InverseMapPoint is pivot-AGNOSTIC (it reads the stamp's own pivot), so the input side needs no
        // change for a new pivot — a tap anywhere in the enlarged halo still un-maps to the true game coordinate.
        var (ix, iy) = ViewScale.InverseMapPoint(br, Fwd(br, 1850, 1000).X, Fwd(br, 1850, 1000).Y);
        Check.Close(ix, 1850, "inverse round-trips X through a BottomRight stamp");
        Check.Close(iy, 1000, "inverse round-trips Y through a BottomRight stamp");

        // R9 MiddleRight: the pinned RIGHT edge is fixed in X at every height, while the box splays symmetrically
        // about its vertical centre — the exhaust pile's exact measured geometry (1830,800)-(1910,880) → (1810,790)-(1910,890).
        var exhaust = new DesignAabb(1830, 800, 1910, 880);
        var mr = HoverTipScaleMath.ComputeAnchoredStamp(
            exhaust, 1.25, W, H, HoverTipScaleMath.AnchorPivot.MiddleRight)!.Value;
        Check.Close(Fwd(mr, 1910, 800).X, 1910, "middle-right: the right edge is fixed in X at the box TOP");
        Check.Close(Fwd(mr, 1910, 880).X, 1910, "middle-right: the right edge is fixed in X at the box BOTTOM");
        Check.Close(Fwd(mr, 1910, 840).Y, 840, "middle-right: the vertical centre is the fixed point in Y");
        Check.Close(Fwd(mr, 1830, 800).X, 1810, "middle-right grows LEFT: 1910 − 1.25·80 = 1810");
        Check.Close(Fwd(mr, 1830, 800).Y, 790, "middle-right splays UP: 840 − 1.25·40 = 790");
        Check.Close(Fwd(mr, 1910, 880).Y, 890, "middle-right splays DOWN: 840 + 1.25·40 = 890");

        // The inverse stays exact for the new pivot too (a tap in the enlarged halo un-maps to the true coordinate).
        var (mx, my) = ViewScale.InverseMapPoint(mr, Fwd(mr, 1845, 815).X, Fwd(mr, 1845, 815).Y);
        Check.Close(mx, 1845, "inverse round-trips X through a MiddleRight stamp");
        Check.Close(my, 815, "inverse round-trips Y through a MiddleRight stamp");
    }

    // With the clamp ON, a corner pivot still respects the viewport: a box hugging the RIGHT edge pinned at BottomLeft
    // grows right past 1920 and is pushed back in; the same box pinned at BottomRight needs no correction.
    private static void AnchoredStampCornerPivotClamps()
    {
        var box = new DesignAabb(1800, 900, 1900, 1000);
        var bl = HoverTipScaleMath.ComputeAnchoredStamp(
            box, 1.5, W, H, HoverTipScaleMath.AnchorPivot.BottomLeft)!.Value;
        // scaled right = 1800 + 1.5·100 = 1950 > 1920 → clamp −30.
        Check.Close(bl.ClampX, -30, "bottom-left near the right edge clamps back in-bounds");
        var br = HoverTipScaleMath.ComputeAnchoredStamp(
            box, 1.5, W, H, HoverTipScaleMath.AnchorPivot.BottomRight)!.Value;
        Check.Close(br.ClampX, 0, "bottom-right grows inward → no clamp needed");

        // R9 MiddleRight shares the horizontal behaviour (pinned right edge → grows inward, no X clamp) but its
        // VERTICAL clamp is live: splaying about the centre near the bottom edge overflows and is pushed back up.
        // Box y∈[900,1000] centre 950; scaled bottom = 950 + 1.5·50 = 1025 ≤ 1080 → still fits.
        var mr = HoverTipScaleMath.ComputeAnchoredStamp(
            box, 1.5, W, H, HoverTipScaleMath.AnchorPivot.MiddleRight)!.Value;
        Check.Close(mr.ClampX, 0, "middle-right grows inward from the right edge → no X clamp");
        Check.Close(mr.ClampY, 0, "middle-right splay that still fits needs no Y clamp");

        // Push it out: box y∈[1000,1060] centre 1030; scaled bottom = 1030 + 1.5·30 = 1075 ≤ 1080 fits, so use a
        // taller splay — y∈[990,1070] centre 1030, scaled bottom = 1030 + 1.5·40 = 1090 > 1080 → clampY = −10.
        var low = new DesignAabb(1800, 990, 1900, 1070);
        var mrLow = HoverTipScaleMath.ComputeAnchoredStamp(
            low, 1.5, W, H, HoverTipScaleMath.AnchorPivot.MiddleRight)!.Value;
        Check.Close(mrLow.ClampY, -10, "middle-right near the bottom edge clamps the splay back in-bounds");
    }

    // The map legend's real box: right edge 1996 ALREADY past 1920. Clamped, a centre pivot drags the panel left
    // (detaching it from the edge the game anchored it to); BottomRight + NoClamp leaves both pinned edges exactly put.
    private static void AnchoredStampCornerPivotNoClampKeepsEdge()
    {
        var legend = new DesignAabb(1656, 289, 1996, 743);
        var centreClamped = HoverTipScaleMath.ComputeAnchoredStamp(
            legend, 1.2, W, H, HoverTipScaleMath.AnchorPivot.Center)!.Value;
        Check.That(centreClamped.ClampX < -100,
            "centre pivot + clamp shoves the legend >100px left (the behaviour the BottomRight entry avoids)");

        var pinned = HoverTipScaleMath.ComputeAnchoredStamp(
            legend, 1.2, W, H, HoverTipScaleMath.AnchorPivot.BottomRight, 0, 0, noClamp: true)!.Value;
        Check.Close(pinned.ClampX, 0, "legend NoClamp → no horizontal correction");
        Check.Close(pinned.ClampY, 0, "legend NoClamp → no vertical correction");
        Check.Close(Fwd(pinned, 1996, 743).X, 1996, "legend right edge stays exactly where the game put it");
        Check.Close(Fwd(pinned, 1996, 743).Y, 743, "legend bottom edge stays exactly where the game put it");
        Check.Close(Fwd(pinned, 1656, 289).X, 1588, "legend grows LEFT: 1996 − 1.2·340 = 1588");
        Check.Close(Fwd(pinned, 1656, 289).Y, 198.2, "legend grows UP: 743 − 1.2·454 = 198.2");

        // R9 contrast — the exhaust entry deliberately does NOT copy the legend's NoClamp. Its real box sits wholly
        // inside the viewport, so the clamp is already a no-op and the clamped/unclamped stamps are IDENTICAL; keeping
        // the clamp on leaves the on-screen backstop in place if the game ever re-anchors the pile.
        var exhaust = new DesignAabb(1830, 800, 1910, 880);
        var clamped = HoverTipScaleMath.ComputeAnchoredStamp(
            exhaust, 1.25, W, H, HoverTipScaleMath.AnchorPivot.MiddleRight)!.Value;
        var unclamped = HoverTipScaleMath.ComputeAnchoredStamp(
            exhaust, 1.25, W, H, HoverTipScaleMath.AnchorPivot.MiddleRight, 0, 0, noClamp: true)!.Value;
        Check.That(clamped == unclamped,
            "exhaust pile: the on-screen clamp is a no-op on its real box → no NoClamp needed (unlike the legend)");
    }

    // Regression guard: adding the corner pivots (R8) and the MiddleRight edge pivot (R9) must not move pivot X for
    // the three *Center variants (which every pre-R8 shipped entry uses), and MiddleRight must keep pivot Y CENTRED —
    // the one axis that distinguishes it from BottomRight, and the twin-drift hazard if a future pivot is folded into
    // the bottom arm of the `py` switch by mistake.
    private static void AnchoredStampCenteredAxesUnchangedByCornerAndEdgePivots()
    {
        var box = new DesignAabb(600, 750, 1400, 1042); // centre (1000, 896)
        foreach (var p in new[]
                 {
                     HoverTipScaleMath.AnchorPivot.Center,
                     HoverTipScaleMath.AnchorPivot.TopCenter,
                     HoverTipScaleMath.AnchorPivot.BottomCenter,
                 })
        {
            var s = HoverTipScaleMath.ComputeAnchoredStamp(box, 1.2, W, H, p)!.Value;
            Check.Close(s.PivotX, 1000, $"{p}: pivot X is still the box centre");
        }

        var mr = HoverTipScaleMath.ComputeAnchoredStamp(
            box, 1.2, W, H, HoverTipScaleMath.AnchorPivot.MiddleRight)!.Value;
        Check.Close(mr.PivotY, 896, "MiddleRight: pivot Y is the box CENTRE (it must NOT join the bottom-pinning arm)");
        Check.Close(mr.PivotX, 1400, "MiddleRight: pivot X is the box RIGHT edge");
        var center = HoverTipScaleMath.ComputeAnchoredStamp(
            box, 1.2, W, H, HoverTipScaleMath.AnchorPivot.Center)!.Value;
        Check.Close(mr.PivotY, center.PivotY, "MiddleRight and Center share the same vertical anchor");
    }

    private static (double X, double Y) Fwd(HoverTipScaleMath.Stamp s, double qx, double qy) =>
        (s.PivotX + (s.Scale * (qx - s.PivotX)) + s.ClampX,
         s.PivotY + (s.Scale * (qy - s.PivotY)) + s.ClampY);

    // Side-clamp (HandCard): a single-block tip whose scaled box overlaps its owner is translated RIGHT so its left
    // edge sits exactly SideGap (12) past the owner's right edge.
    private static void SideClampPushesHandCardTipRight()
    {
        var owner = Box(900, 430, 100, 60); // [900..1000]×[430..490] overlapping the scaled tip
        var s = HoverTipScaleMath.ComputeStamp([Box(800, 400, 300, 120)], W, H, K, owner, HoverTipScaleMath.TipOwnerKind.HandCard);
        Check.That(s is not null, "hand-card side-clamp produces a stamp");
        Check.Close(s!.Value.PivotX, 800, "side-clamp keeps the HandCard grow-right pivot (union.MinX)");
        Check.Close(s.Value.ClampX, 212, "side-clamp translates the tip right by 212 (left edge → owner.MaxX + SideGap)");
        double scaledLeft = s.Value.PivotX + (K * (800 - s.Value.PivotX)) + s.Value.ClampX;
        Check.Close(scaledLeft, 1012, "scaled tip left edge lands SideGap past the owner (1000 + 12)");
    }

    // Side-clamp (Creature): a Creature-kind tip overlapping its owner is translated LEFT so its right edge sits
    // SideGap before the owner's left edge.
    private static void SideClampPushesCreatureTipLeft()
    {
        var owner = Box(1050, 430, 100, 60); // [1050..1150] overlapping the scaled tip
        var s = HoverTipScaleMath.ComputeStamp([Box(1000, 400, 300, 120)], W, H, K, owner, HoverTipScaleMath.TipOwnerKind.Creature);
        Check.That(s is not null, "creature side-clamp produces a stamp");
        Check.Close(s!.Value.PivotX, 1300, "side-clamp keeps the Creature grow-left pivot (union.MaxX)");
        Check.Close(s.Value.ClampX, -262, "side-clamp translates the tip left by 262 (right edge → owner.MinX − SideGap)");
        double scaledRight = s.Value.PivotX + (K * (1300 - s.Value.PivotX)) + s.Value.ClampX;
        Check.Close(scaledRight, 1038, "scaled tip right edge lands SideGap before the owner (1050 − 12)");
    }

    // Side-clamp flip: a HandCard tip near the RIGHT edge whose preferred grow-right push would overflow the viewport
    // flips to the LEFT side instead (negative clamp), still clearing the owner.
    private static void SideClampFlipsOnViewportOverflow()
    {
        var owner = Box(1650, 430, 100, 60);
        var s = HoverTipScaleMath.ComputeStamp([Box(1600, 400, 250, 120)], W, H, K, owner, HoverTipScaleMath.TipOwnerKind.HandCard);
        Check.That(s is not null, "flip case produces a stamp");
        Check.Close(s!.Value.ClampX, -262, "preferred-right overflow → flip left (right edge → owner.MinX − SideGap)");
        double scaledMaxX = s.Value.PivotX + (K * (1850 - s.Value.PivotX)) + s.Value.ClampX;
        Check.That(scaledMaxX <= W + 1e-6, "flipped tip stays inside the viewport");
    }

    // Side-clamp skips a STRADDLE (two-column) tip: the gap-midpoint pivot is untouched even with an overlapping owner.
    private static void SideClampSkipsStraddle()
    {
        var owner = Box(1400, 460, 120, 300); // sits in the inner gap, would overlap
        var cols = new List<DesignAabb> { Box(980, 500, 360, 300), Box(1540, 460, 360, 340) };
        var withOwner = HoverTipScaleMath.ComputeStamp(cols, W, H, K, owner, HoverTipScaleMath.TipOwnerKind.HandCard);
        var without = HoverTipScaleMath.ComputeStamp(cols, W, H, K);
        Check.Close(withOwner!.Value.PivotX, 1440, "straddle pivot stays at the gap midpoint (side-clamp skipped)");
        // The owner adds NO side push — the clamp equals the owner-less straddle clamp (its normal viewport clamp).
        Check.Close(withOwner.Value.ClampX, without!.Value.ClampX, "straddle takes no owner-driven horizontal push");
    }

    // Owner-follow (item 6): a view-scaled owner that moved by ownerFollow translates the whole tip by the same delta
    // (added to the clamp channel) so the tip stays glued to the enlarged owner.
    private static void OwnerFollowTranslatesTip()
    {
        var s = HoverTipScaleMath.ComputeStamp(
            [Box(700, 400, 300, 120)], W, H, K, null, HoverTipScaleMath.TipOwnerKind.HandCard,
            ownerFollowX: 40, ownerFollowY: -15);
        Check.Close(s!.Value.ClampX, 40, "ownerFollowX folds into the clamp channel");
        Check.Close(s.Value.ClampY, -15, "ownerFollowY folds into the clamp channel");
    }

    // The static owner-kind resolver (shared with HoverTipScaler + the web twin): card-holders → HandCard, NCreature
    // → Creature, NRewardButton → RewardItem, everything else (map legend, HUD, merchant) → None.
    private static void OwnerKindResolution()
    {
        var K2 = HoverTipScaleMath.TipOwnerKind.HandCard;
        Check.That(HoverTipScaleMath.ResolveOwnerKind("NHandCardHolder", null) == K2, "NHandCardHolder → HandCard");
        Check.That(HoverTipScaleMath.ResolveOwnerKind("NGridCardHolder", null) == K2, "NGridCardHolder → HandCard");
        Check.That(HoverTipScaleMath.ResolveOwnerKind("NCardHolder", null) == K2, "NCardHolder → HandCard");
        Check.That(HoverTipScaleMath.ResolveOwnerKind("NCreature", null) == HoverTipScaleMath.TipOwnerKind.Creature, "NCreature → Creature");
        Check.That(HoverTipScaleMath.ResolveOwnerKind("NRewardButton", null) == HoverTipScaleMath.TipOwnerKind.RewardItem, "NRewardButton → RewardItem");
        Check.That(HoverTipScaleMath.ResolveOwnerKind("NMapLegendItem", null) == HoverTipScaleMath.TipOwnerKind.None, "NMapLegendItem → None (map legend)");
        Check.That(HoverTipScaleMath.ResolveOwnerKind("NMerchantCard", null) == HoverTipScaleMath.TipOwnerKind.None, "NMerchantCard → None");
        Check.That(HoverTipScaleMath.ResolveOwnerKind(null, "res://scenes/rewards/reward_button.tscn") == HoverTipScaleMath.TipOwnerKind.RewardItem, "reward_button.tscn scene fallback → RewardItem");
        Check.That(HoverTipScaleMath.ResolveOwnerKind(null, null) == HoverTipScaleMath.TipOwnerKind.None, "no owner → None");
    }

    private static DesignAabb Box(double x, double y, double w, double h) => new(x, y, x + w, y + h);

    // (b) single tip near screen centre → left+top anchored (P = union min), no clamp needed.
    private static void SingleColumnMinAnchored()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(1040, 660, 360, 122)], W, H, K);
        Check.That(s is not null, "single-column tip produces a stamp");
        Check.Close(s!.Value.Scale, 1.2, "single-column: scale == 1.2");
        Check.Close(s.Value.PivotX, 1040, "single-column: P.x == union.MinX");
        Check.Close(s.Value.PivotY, 660, "single-column: P.y == union.MinY");
        Check.Close(s.Value.ClampX, 0, "single-column: no horizontal clamp");
        Check.Close(s.Value.ClampY, 0, "single-column: no vertical clamp");
    }

    // (b') owner-less tip near the right edge: grow-right would overflow (1528 + 1.2·360 = 1960 > 1920) → the #18
    // overflow predicate flips the pivot to union.MaxX so the growth pushes LEFT and stays on-screen.
    private static void CreatureTipRightEdgeHug()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(1528, 544, 360, 256)], W, H, K);
        Check.That(s is not null, "creature tip produces a stamp");
        Check.Close(s!.Value.PivotX, 1888, "owner-less right-edge tip: overflow flip → P.x == union.MaxX");
        Check.Close(s.Value.PivotY, 544, "creature tip: not bottom-hug → P.y == union.MinY");
        // Scaled about (1888,544): x∈[1456,1888], y∈[544,851.2] — both in-bounds, no clamp.
        Check.Close(s.Value.ClampX, 0, "creature tip: no horizontal clamp (grows left off the anchor)");
        Check.Close(s.Value.ClampY, 0, "creature tip: no vertical clamp");
    }

    // (b) a tip hugging the BOTTOM edge (MaxY 1050 ≥ 1080−48) → bottom-anchored so the growth pushes up.
    private static void BottomHugAnchorsBottom()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(900, 900, 360, 150)], W, H, K);
        Check.That(s is not null, "bottom-hug tip produces a stamp");
        Check.Close(s!.Value.PivotX, 900, "bottom-hug: not right-hug → P.x == union.MinX");
        Check.Close(s.Value.PivotY, 1050, "bottom-hug: → P.y == union.MaxY");
        // Scaled about (900,1050): y∈[870,1050] — anchored at the bottom keeps it in-bounds.
        Check.Close(s.Value.ClampY, 0, "bottom-hug: bottom anchor keeps it in-bounds (no clamp)");
    }

    // (a) straddle: a text column [980,1340] and a card column [1540,1900] (200px inner gap) → pivot at the gap
    // midpoint 1440, top-aligned.
    private static void StraddleColumnsPivotAtGapMidpoint()
    {
        var s = HoverTipScaleMath.ComputeStamp(
            [Box(980, 500, 360, 300), Box(1540, 460, 360, 340)], W, H, K);
        Check.That(s is not null, "straddle produces a stamp");
        Check.Close(s!.Value.PivotX, 1440, "straddle: P.x == midpoint of the inner gap (1340..1540)");
        Check.Close(s.Value.PivotY, 460, "straddle: P.y == union.MinY (top of both columns)");
    }

    // Clamp: a tall top-anchored tip whose scaled bottom overflows 1080 but still FITS the viewport → pushed up.
    // Box y∈[300,1000] (MaxY 1000 < 1032 so not bottom-hug); scaled height 1.2·700 = 840 ≤ 1080; scaled bottom
    // 300 + 840 = 1140 > 1080 → ClampY = 1080 − 1140 = −60.
    private static void BottomClampPushesUp()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(150, 300, 360, 700)], W, H, K);
        Check.That(s is not null, "bottom-clamp tip produces a stamp");
        Check.Close(s!.Value.PivotY, 300, "bottom-clamp: top-anchored (not bottom-hug)");
        Check.Close(s.Value.ClampY, -60, "bottom-clamp: scaled bottom pushed back up by 60px");
        Check.Close(s.Value.ClampX, 0, "bottom-clamp: no horizontal clamp");
    }

    // A tip TALLER than the viewport once scaled cannot fit → pin the TOP (scaled top edge lands at 0). Box
    // y∈[0,1200] (MaxY 1200 ≥ 1032, bottom-hug → P.y 1200); scaled top = 1200 + 1.2·(0−1200) = −240; scaled height
    // 1440 > 1080 → ClampY = 240 so the scaled top lands at exactly 0.
    private static void OversizedTipPinsTop()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(200, 0, 300, 1200)], W, H, K);
        Check.That(s is not null, "oversized tip produces a stamp");
        double scaledTop = s!.Value.PivotY + (K * (0 - s.Value.PivotY)) + s.Value.ClampY;
        Check.Close(scaledTop, 0, "oversized tip: scaled top pinned to 0");
        Check.Close(s.Value.ClampY, 240, "oversized tip: ClampY pins the top (240px down)");
    }

    // (c) no paint-bearing children → no stamp at all.
    private static void EmptyNoStamp()
    {
        var s = HoverTipScaleMath.ComputeStamp(new List<DesignAabb>(), W, H, K);
        Check.That(s is null, "empty child set → no stamp");
    }

    // (b') on a WIDENED stage the #18 overflow predicate tracks the PASSED design width, not a hardcoded 1920. At
    // designW 2712 growing right from 2320 (2320 + 1.2·360 = 2752 > 2712) overflows → flip to P.x == union.MaxX 2680.
    private static void WidenedDesignWidthRightHug()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(2320, 500, 360, 200)], 2712, H, K);
        Check.That(s is not null, "widened-stage tip produces a stamp");
        Check.Close(s!.Value.PivotX, 2680, "widened: overflow predicate uses the passed designW → P.x == union.MaxX");
        Check.Close(s.Value.ClampX, 0, "widened: no horizontal clamp (grows left off the anchor)");
    }

    // The switch-OFF path passes scale straight through: calling with scale 1 yields an identity stamp (scale 1, no
    // clamp) — the scaler treats this as a no-op fold. (The runtime OFF path never calls ComputeStamp at all; this
    // asserts the math is inert at k=1 for defensiveness.)
    private static void SwitchOffFactorPassThrough()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(1040, 660, 360, 122)], W, H, 1.0);
        Check.That(s is not null, "scale 1 still produces a stamp");
        Check.Close(s!.Value.Scale, 1.0, "scale 1: pass-through factor");
        Check.Close(s.Value.ClampX, 0, "scale 1: no horizontal clamp");
        Check.Close(s.Value.ClampY, 0, "scale 1: no vertical clamp");
    }

    // #17/#18 (creature): a creature tip [981,528..1348,774] pointing at a creature to its RIGHT with the HP bar at
    // the owner's feet. Creature KIND pivots at union.MaxX so the 1.2× growth goes LEFT + UP — the tip's right/bottom
    // edges stay put and the HP bar the un-scaled tip left clear is NOT newly covered. (Recording: wscrisp creature.)
    private static void CreatureTipGrowsLeftUpAwayFromOwner()
    {
        var owner = Box(1370, 528, 200, 212); // hitbox, centre (1470,634) — right of the tip with a SideGap clearance
        var s = HoverTipScaleMath.ComputeStamp([Box(981, 528, 367, 246)], W, H, K, owner, HoverTipScaleMath.TipOwnerKind.Creature);
        Check.That(s is not null, "creature tip w/ owner produces a stamp");
        Check.Close(s!.Value.PivotX, 1348, "creature tip: Creature kind → P.x == union.MaxX (grow left)");
        Check.Close(s.Value.PivotY, 774, "creature tip: owner not above → P.y == union.MaxY (grow up)");
        Check.Close(s.Value.ClampX, 0, "creature tip: scaled box on-screen (no clamp)");
        Check.Close(s.Value.ClampY, 0, "creature tip: scaled box on-screen (no clamp)");
    }

    // #17/#18 (hand card): the tip [1393,660..1760,785] sits to the RIGHT of its held card; the anchor owner (the
    // NHandCardHolder, a 0×0 anchor node at (1233,871)) is to the LEFT and below. HandCard KIND pivots at union.MinX
    // → grow RIGHT (away from the card) + UP (into the card's upper area). The card is never newly covered.
    private static void CardTipOwnerLeftGrowsRightUp()
    {
        var owner = Box(1233, 871, 0, 0); // holder anchor point — left of & below the tip
        var s = HoverTipScaleMath.ComputeStamp([Box(1393, 660, 367, 125)], W, H, K, owner, HoverTipScaleMath.TipOwnerKind.HandCard);
        Check.That(s is not null, "card tip w/ owner produces a stamp");
        Check.Close(s!.Value.PivotX, 1393, "card tip: HandCard kind → P.x == union.MinX (grow right)");
        Check.Close(s.Value.PivotY, 785, "card tip: owner not above → P.y == union.MaxY (grow up)");
        Check.Close(s.Value.ClampX, 0, "card tip: grows right, on-screen (no clamp)");
        Check.Close(s.Value.ClampY, 0, "card tip: grows up, on-screen (no clamp)");
    }

    // An UNCLASSIFIED (None-kind) tip whose KNOWN owner sits CLEARLY ABOVE it (a top-bar / relic tooltip hanging below
    // its owner) reverses the vertical default: grow DOWN. Horizontally the None kind grows RIGHT (no overflow here:
    // 900 + 1.2·300 = 1260 ≤ 1920) → P.x == union.MinX. (Was grow-LEFT under the old owner-centroid rule; #17/#18.)
    private static void OwnerClearlyAboveGrowsDown()
    {
        var owner = Box(1100, 120, 200, 120); // centre (1200,180), entirely above the tip's top (300)
        var s = HoverTipScaleMath.ComputeStamp([Box(900, 300, 300, 150)], W, H, K, owner);
        Check.That(s is not null, "owner-above tip produces a stamp");
        Check.Close(s!.Value.PivotX, 900, "owner-above: None kind grows right → P.x == union.MinX");
        Check.Close(s.Value.PivotY, 300, "owner-above: owner above → P.y == union.MinY (grow down)");
    }

    // Owner-driven grow-UP whose scaled top overflows the viewport top → clamped back down (the clamp still runs after
    // the owner picks the pivot). Tip [900,20..1200,240], owner below → P.y = MaxY 240; scaled top = 240 − 1.2·220 =
    // −24 → ClampY = +24 pins it to 0.
    private static void OwnerDrivenGrowUpTopClamp()
    {
        var owner = Box(950, 400, 200, 100); // below the tip → grow up
        var s = HoverTipScaleMath.ComputeStamp([Box(900, 20, 300, 220)], W, H, K, owner);
        Check.That(s is not null, "owner grow-up clamp tip produces a stamp");
        Check.Close(s!.Value.PivotY, 240, "grow-up clamp: P.y == union.MaxY");
        Check.Close(s.Value.ClampY, 24, "grow-up clamp: scaled top pushed back down by 24px");
    }

    // #17 (hand card): a tip near mid-screen with HandCard kind grows RIGHT (pivot union.MinX) regardless of the
    // owner box. No owner passed → vertical falls to the (not-bottom-hug) grow-up default P.y == union.MinY.
    private static void KindHandCardGrowsRight()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(800, 400, 300, 120)], W, H, K, null, HoverTipScaleMath.TipOwnerKind.HandCard);
        Check.That(s is not null, "hand-card kind tip produces a stamp");
        Check.Close(s!.Value.PivotX, 800, "HandCard kind → P.x == union.MinX (grow right)");
    }

    // #17 (card reward): CardReward kind grows RIGHT (the tip sits to the right of a reward card).
    private static void KindCardRewardGrowsRight()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(700, 300, 320, 200)], W, H, K, null, HoverTipScaleMath.TipOwnerKind.CardReward);
        Check.That(s is not null, "card-reward kind tip produces a stamp");
        Check.Close(s!.Value.PivotX, 700, "CardReward kind → P.x == union.MinX (grow right)");
    }

    // #17 (creature): Creature kind grows LEFT (pivot union.MaxX) even mid-screen where no overflow would force it.
    private static void KindCreatureGrowsLeft()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(700, 300, 320, 200)], W, H, K, null, HoverTipScaleMath.TipOwnerKind.Creature);
        Check.That(s is not null, "creature kind tip produces a stamp");
        Check.Close(s!.Value.PivotX, 1020, "Creature kind → P.x == union.MaxX (grow left)");
    }

    // #17 (reward item): RewardItem kind grows LEFT (the tip sits to the left of a reward-list item).
    private static void KindRewardItemGrowsLeft()
    {
        var s = HoverTipScaleMath.ComputeStamp([Box(1400, 300, 320, 200)], W, H, K, null, HoverTipScaleMath.TipOwnerKind.RewardItem);
        Check.That(s is not null, "reward-item kind tip produces a stamp");
        Check.Close(s!.Value.PivotX, 1720, "RewardItem kind → P.x == union.MaxX (grow left)");
    }

    // #18: a None-kind tip whose grow-RIGHT scaled edge fits stays min-anchored; one whose grow-right edge would
    // overflow flips to MaxX. Box [1600..1900]: 1600 + 1.2·300 = 1960 > 1920 → flip to union.MaxX 1900 (grow left).
    private static void NoneOverflowFlipsToMaxX()
    {
        var fits = HoverTipScaleMath.ComputeStamp([Box(1200, 400, 300, 120)], W, H, K);
        Check.Close(fits!.Value.PivotX, 1200, "None fits: grow right → P.x == union.MinX");
        var overflow = HoverTipScaleMath.ComputeStamp([Box(1600, 400, 300, 120)], W, H, K);
        Check.Close(overflow!.Value.PivotX, 1900, "None overflow: scaled right edge > designW → flip to union.MaxX");
    }
}
