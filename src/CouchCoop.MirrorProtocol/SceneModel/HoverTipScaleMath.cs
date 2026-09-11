// Pure geometry for the HoverTip 1.2× scale-up (Feature A / WS-VIEW). Given the per-direct-child paint-bearing
// design-space AABBs of an NHoverTipSet root, produce a scale STAMP — a uniform factor `k` about a design-space
// pivot P plus a clamp translation C that keeps the SCALED union inside the design viewport. The Godot-side
// HoverTipScaler feeds the AABBs (each already spread-Dx-folded), converts the returned P/C into the root's parent
// frame, and folds T(P)·S(k)·T(-P) then +C into the root view's transform. Kept Godot-free so it is Exe-testable —
// the caller owns the (Godot Transform2D) parent-frame conversion.
//
// ANCHOR policy (intent: grow the tip toward the side the user expects it to sit on, NEVER newly covering the
// card/creature/HP-bar the un-scaled tip left clear, and never off-screen). Issues #17/#18: the growth SIDE is now
// keyed by the tip's OWNER KIND (the semantic thing the tip points at) rather than a raw owner-centroid comparison —
// the reported defect was a HoverTip growing the wrong way (the map legend near the right edge pivoted at MaxX and
// grew LEFT off-screen; creature tips grew right into their HP bar):
//   (a) two horizontally-disjoint child columns (the hand-card straddle — a card tip + a keyword tip flanking the
//       held card) → pivot at the MIDPOINT of the inner gap, top-aligned (P.y = union top): the two columns splay
//       symmetrically outward from the gap. UNCHANGED by #17/#18 (kind does not override the straddle).
//   (b) a single block (one tip, or overlapping/stacked columns) → pivot-X by OWNER KIND:
//         HandCard / CardReward  → P.x = union.MinX  (grow RIGHT — the tip sits to the right of a hand card / card reward)
//         Creature / RewardItem  → P.x = union.MaxX  (grow LEFT  — the tip sits to the left of a creature / reward item)
//         None                   → grow-RIGHT default (P.x = union.MinX); but if the scaled RIGHT edge would overflow
//                                  the viewport (`MinX + k·(MaxX−MinX) > designWidth`) flip to P.x = union.MaxX so the
//                                  growth pushes LEFT instead (this replaces the old EdgePad right-hug and fixes the
//                                  map-legend symptom: an owner-less tip near the right edge now grows in-bounds).
//       P.y grows UP (P.y = union.MaxY) by default — STS2 anchored content (HP bars at a creature's feet, the hand,
//       action buttons) sits AT or BELOW a tooltip's level, so the only safe vertical growth is upward — REVERSING to
//       grow down (P.y = union.MinY) only when a KNOWN owner sits clearly ABOVE the tip (its centre is above the union
//       top; e.g. a top-bar / relic tooltip hanging below its owner). With no owner the vertical falls back to the
//       screen-edge rule (bottom-hug → grow up, else grow down).
//   (c) no paint-bearing children → no stamp (null).
//
// CLAMP: scale the union about P, then translate by C so the scaled box fits [0,designW]×[0,designH]. A box TALLER
// than the viewport pins its TOP (scaled top → 0); a box WIDER than the viewport pins its LEFT.
namespace CouchCoop.MirrorProtocol.SceneModel;

public static class HoverTipScaleMath
{
    // The semantic thing a HoverTip points at (its anchor owner), driving which side the 1.2× enlargement grows
    // toward (#17/#18). `None` (the default, so existing owner-less callers are unchanged) grows RIGHT unless that
    // would overflow the right viewport edge, then flips to grow LEFT.
    public enum TipOwnerKind
    {
        None,
        HandCard,
        Creature,
        RewardItem,
        CardReward,
    }

    // Design-px band (recording-derived): a union edge within this of the BOTTOM viewport edge counts as "hugging" it
    // and anchors the vertical scale there (owner-less tips only), so the growth pushes up rather than off-screen.
    public const double EdgePad = 48;

    // R5 non-overlap invariant (item 5): the design-px gap enforced between the SCALED tip box and its owner box. When
    // the two overlap, the tip is translated (via the clamp channel) to the kind-preferred side (+SideGap), flipping /
    // vertical-falling-back on viewport overflow, so a focused hand card's keyword tip never covers the card.
    public const double SideGap = 12;

    // Resolve a HoverTip's owner KIND from the anchor-owner node's TYPE LEAF (+ owning scene file as a fallback). The
    // KIND exists only to pick which SIDE the enlarged tip grows toward, and the leaf set below is the list of anchor
    // owners that have ever been observed carrying a tip on screen: hand cards and card rewards (both a card-holder),
    // creatures, post-combat reward rows, and a long tail (map legend, HUD, merchant, piles, relics, potions, orbs,
    // events) that shares one default. Anything unrecognised falls into that default, so a new owner degrades to
    // "grow right, flip on overflow" rather than mis-anchoring.
    // Sides (#17/#18):
    //   * any CardHolder (leaf ends "CardHolder": NCardHolder / NHandCardHolder / NGridCardHolder / NCardHolderHitbox)
    //     → HandCard: the tip sits to the RIGHT of a hand card / card reward → grow RIGHT.
    //   * NCreature → Creature: the tip sits to the LEFT of a creature → grow LEFT.
    //   * NRewardButton → RewardItem: the tip sits to the LEFT of a reward-list row → grow LEFT.
    //   * everything else (map legend, HUD, merchant, piles, relics, potions, orbs, events) → None: grow RIGHT by
    //     default and flip LEFT only when growing right would overflow (the map-legend fix), with the owner box
    //     driving the vertical reversal for a tip that hangs below its owner (top-bar relic / gold).
    public static TipOwnerKind ResolveOwnerKind(string? ownerTypeLeaf, string? ownerSceneFile)
    {
        if (ownerTypeLeaf is not null)
        {
            if (ownerTypeLeaf.EndsWith("CardHolder", System.StringComparison.Ordinal))
            {
                return TipOwnerKind.HandCard;
            }

            if (ownerTypeLeaf == "NCreature")
            {
                return TipOwnerKind.Creature;
            }

            if (ownerTypeLeaf == "NRewardButton")
            {
                return TipOwnerKind.RewardItem;
            }
        }

        // Scene-file fallback (an owner whose leaf didn't match but whose owning scene is unambiguous).
        if (ownerSceneFile is not null)
        {
            if (ownerSceneFile.EndsWith("reward_button.tscn", System.StringComparison.Ordinal))
            {
                return TipOwnerKind.RewardItem;
            }
        }

        return TipOwnerKind.None;
    }

    // The computed scale channel: a uniform factor about design-space pivot (PivotX,PivotY) plus a design-space
    // clamp translation (ClampX,ClampY). The scaler converts pivot + clamp into the root view's parent frame.
    public readonly record struct Stamp(double Scale, double PivotX, double PivotY, double ClampX, double ClampY);

    public static Stamp? ComputeStamp(
        System.Collections.Generic.IReadOnlyList<DesignAabb> childAabbs,
        double designWidth,
        double designHeight,
        double scale,
        DesignAabb? ownerAabb = null,
        TipOwnerKind ownerKind = TipOwnerKind.None,
        double ownerFollowX = 0,
        double ownerFollowY = 0)
    {
        if (childAabbs is null || childAabbs.Count == 0)
        {
            return null; // (c) nothing paints → no stamp (leave the root at scale 1)
        }

        // Union of every child box (the whole tip-set footprint).
        DesignAabb union = childAabbs[0];
        for (int i = 1; i < childAabbs.Count; i++)
        {
            union = union.Union(childAabbs[i]);
        }

        double px, py;
        bool straddle = TryTwoColumnGap(childAabbs, out double gapMid);
        if (straddle)
        {
            // (a) straddle: splay outward from the inner gap midpoint, top-aligned. Kind does not override this.
            px = gapMid;
            py = union.MinY;
        }
        else
        {
            // (b) single block: pivot-X keyed by the owner KIND (#17/#18), independent of the owner box (which is
            // used only for the vertical reversal below).
            px = PivotX(ownerKind, union, scale, designWidth);
            // Vertical: grow UP (pivot MaxY) unless a KNOWN owner sits clearly above the tip's top (→ grow down); with
            // no owner fall back to the screen-edge rule (bottom-hug → grow up, else grow down).
            if (ownerAabb is { } owner)
            {
                double ownerCy = (owner.MinY + owner.MaxY) / 2.0;
                py = ownerCy < union.MinY ? union.MinY : union.MaxY;
            }
            else
            {
                py = union.MaxY >= designHeight - EdgePad ? union.MaxY : union.MinY;
            }
        }

        var (cx, cy) = ClampOffset(union, px, py, scale, designWidth, designHeight);

        // R5 owner-follow (item 6): a view-scaled owner (a reward/merchant item enlarged by the ViewScaler) moved from
        // its streamed rect; translate the whole tip by the owner's mapped-minus-raw centre so it stays glued.
        cx += ownerFollowX;
        cy += ownerFollowY;

        // R5 non-overlap invariant (item 5): a SINGLE-BLOCK tip (straddle untouched) must not touch its owner box.
        if (!straddle && ownerAabb is { } ob)
        {
            (cx, cy) = ApplySideClamp(union, px, py, scale, cx, cy, ob, ownerKind, designWidth, designHeight);
        }

        return new Stamp(scale, px, py, cx, cy);
    }

    // Push the scaled tip box off its owner box (item 5). Preferred side by kind (HandCard/CardReward/None → RIGHT;
    // Creature/RewardItem → LEFT); if the scaled union intersects inflate(owner, SideGap) it is translated (via the
    // clamp channel) to the preferred side (+SideGap), flipping to the other side on viewport overflow, falling back
    // to a vertical move when neither side fits, then re-clamped on-screen — with one deterministic retry on re-overlap.
    private static (double Cx, double Cy) ApplySideClamp(
        DesignAabb union, double px, double py, double k, double cx, double cy,
        DesignAabb owner, TipOwnerKind kind, double w, double h)
    {
        DesignAabb Scaled(double addX, double addY) => new(
            px + (k * (union.MinX - px)) + addX,
            py + (k * (union.MinY - py)) + addY,
            px + (k * (union.MaxX - px)) + addX,
            py + (k * (union.MaxY - py)) + addY);

        DesignAabb oInf = owner.Inflate(SideGap);
        bool preferRight = kind is TipOwnerKind.HandCard or TipOwnerKind.CardReward or TipOwnerKind.None;

        for (int attempt = 0; attempt < 2; attempt++)
        {
            var s = Scaled(cx, cy);
            if (!s.Overlaps(oInf))
            {
                break; // clear of the owner → done
            }

            // Horizontal push to place the tip a SideGap clear on each side, relative to the current position.
            double toRight = (owner.MaxX + SideGap) - s.MinX; // tip's LEFT edge → SideGap right of owner
            double toLeft = (owner.MinX - SideGap) - s.MaxX;  // tip's RIGHT edge → SideGap left of owner
            double first = preferRight ? toRight : toLeft;
            double second = preferRight ? toLeft : toRight;

            var sFirst = Scaled(cx + first, cy);
            var sSecond = Scaled(cx + second, cy);
            if (sFirst.MinX >= 0 && sFirst.MaxX <= w)
            {
                cx += first; // preferred side fits
            }
            else if (sSecond.MinX >= 0 && sSecond.MaxX <= w)
            {
                cx += second; // preferred side overflows → flip
            }
            else
            {
                // Neither side fits → vertical fallback: move the tip above (preferred), else below, the owner.
                double up = (owner.MinY - SideGap) - s.MaxY;   // tip's BOTTOM edge → SideGap above owner
                double down = (owner.MaxY + SideGap) - s.MinY; // tip's TOP edge → SideGap below owner
                var sUp = Scaled(cx, cy + up);
                var sDown = Scaled(cx, cy + down);
                if (sUp.MinY >= 0 && sUp.MaxY <= h)
                {
                    cy += up;
                }
                else if (sDown.MinY >= 0 && sDown.MaxY <= h)
                {
                    cy += down;
                }
                // else: cannot avoid within the viewport — leave as-is (the on-screen clamp below still applies).
            }

            // Re-clamp on-screen after the push (a nudge may have crossed an edge; a fitting side leaves this a no-op).
            var after = Scaled(cx, cy);
            cx += AxisClamp(after.MinX, after.MaxX, w);
            cy += AxisClamp(after.MinY, after.MaxY, h);
        }

        return (cx, cy);
    }

    // R7/R9 (WS-G2): the anchor a view-scale GROUP stamp grows FROM. Center keeps the box fixed at its centre;
    // TopCenter pins the box TOP and grows DOWN (regular-event options); BottomCenter pins the box BOTTOM and grows UP
    // (ancient-event options, so the grow does not collide with the play area below). ComputeCenterStamp == Center.
    //
    // R8 (WS-1) CORNER pivots — the first entries whose pivot X is NOT the box centre. A screen-CORNER widget must
    // grow INWARD from the corner it is anchored to, or the enlargement either walks off-screen or (with the clamp on)
    // gets shoved back in and visibly detaches from the edge the game aligned it to:
    //   BottomLeft  — pins the box's bottom-LEFT corner (draw pile at (15,985)).
    //   BottomRight — pins the box's bottom-RIGHT corner (discard pile at (1826,985); the map legend, whose right edge
    //                 already sits at 1996 > 1920 by design, so a centre pivot + AxisClamp would drag the whole panel
    //                 ~110px left off the right edge it is anchored to).
    //
    // R9 (WS-B) EDGE pivot — an item anchored to a screen SIDE rather than a corner:
    //   MiddleRight — pins the box's RIGHT edge (pivot X = MaxX) but keeps pivot Y at the box CENTRE, so the widget
    //                 grows LEFT and splays symmetrically up/down. The combat EXHAUST pile lives mid-right at
    //                 (1830,800)-(1910,880): it is right-anchored like the discard pile but is NOT in a corner, so
    //                 pinning its bottom (BottomRight) would push the whole enlargement upward off its own row.
    public enum AnchorPivot
    {
        Center,
        TopCenter,
        BottomCenter,
        BottomLeft,
        BottomRight,
        MiddleRight,
    }

    // A CENTER-pivot scale stamp (WS-VIEW #19 general view-scale): scale `box` by `scale` about its own AABB centre,
    // then clamp the scaled box back inside [0,designWidth]×[0,designHeight]. Reuses the SAME ClampOffset channel as
    // the HoverTip pivot stamp so both features share one on-screen-clamp implementation (and the same Stamp shape,
    // so ViewScale.InverseMapPoint can invert either). Null for a degenerate (non-positive-extent) box.
    public static Stamp? ComputeCenterStamp(DesignAabb box, double scale, double designWidth, double designHeight) =>
        ComputeAnchoredStamp(box, scale, designWidth, designHeight, AnchorPivot.Center);

    // R7/R9 (WS-G2) generalization of ComputeCenterStamp: scale `box` by `scale` about a per-PIVOT anchor (Center /
    // TopCenter / BottomCenter / BottomLeft / BottomRight / MiddleRight), then add a design-space TRANSLATE
    // (translateX,translateY) into the clamp channel BEFORE the on-screen AxisClamp, and finally clamp the
    // translated+scaled box inside the viewport. The three *Center variants keep pivot X at the box centre (they grow
    // symmetrically horizontally); the R8 CORNER variants move pivot X to the box's left/right edge so a
    // corner-anchored widget grows inward; the R9 EDGE variant MiddleRight moves pivot X to the right edge while
    // leaving pivot Y at the box centre (a side-anchored widget grows left and splays up/down).
    // A pure translate (scale==1) carries via the clamp channel — the ancient-event dialogue lift — and MirrorNodeView
    // FoldCosmetic (SCALE_SPREAD_ORDER) applies that clamp even at scale==1. Same Stamp shape → ViewScale.InverseMapPoint
    // inverts it (pivot-agnostic — the input inverse needs NO change for a new pivot). Null for a degenerate box.
    //
    // R4-round4 NoClamp: when true the on-screen AxisClamp is SKIPPED (the clamp channel carries ONLY the requested
    // translate). The card-reward container (a full-viewport box scaled >1) always corner-pins under AxisClamp — the
    // round-3 regression; an UNCLAMPED centre scale instead crops a symmetric border of edge content and keeps the
    // interior (cards + skip row) on-screen and centred. A per-card 1.15 uses NoClamp too so the composed inverse is
    // an exact centre scale (no clamp translation to compose).
    public static Stamp? ComputeAnchoredStamp(
        DesignAabb box, double scale, double designWidth, double designHeight,
        AnchorPivot pivot, double translateX = 0, double translateY = 0, bool noClamp = false)
    {
        if (box.MaxX <= box.MinX || box.MaxY <= box.MinY)
        {
            return null;
        }

        double px = pivot switch
        {
            AnchorPivot.BottomLeft => box.MinX,   // pin left, grow right
            AnchorPivot.BottomRight or AnchorPivot.MiddleRight => box.MaxX, // pin right, grow left
            _ => (box.MinX + box.MaxX) / 2.0,     // Center / TopCenter / BottomCenter
        };
        double py = pivot switch
        {
            AnchorPivot.TopCenter => box.MinY,    // pin top, grow down
            AnchorPivot.BottomCenter or AnchorPivot.BottomLeft or AnchorPivot.BottomRight => box.MaxY, // pin bottom, grow up
            // Center AND MiddleRight: MiddleRight pins only the RIGHT edge — its vertical growth is symmetric about the
            // box centre (a side-anchored widget has no pinned bottom, unlike the two corner pivots above).
            _ => (box.MinY + box.MaxY) / 2.0,
        };

        // Scale about (px,py), shift by the design translate, then (unless NoClamp) bring the result back on-screen. The
        // clamp channel C is the TOTAL post-scale translation (translate + on-screen correction), so InverseMapPoint
        // stays exact. NoClamp forces C == the requested translate (0 for the reward container/card) → a pure centre
        // scale, so the scaled box may crop a symmetric border but never corner-pins.
        double sMinX = px + (scale * (box.MinX - px));
        double sMaxX = px + (scale * (box.MaxX - px));
        double sMinY = py + (scale * (box.MinY - py));
        double sMaxY = py + (scale * (box.MaxY - py));
        double cx = noClamp ? translateX : translateX + AxisClamp(sMinX + translateX, sMaxX + translateX, designWidth);
        double cy = noClamp ? translateY : translateY + AxisClamp(sMinY + translateY, sMaxY + translateY, designHeight);
        return new Stamp(scale, px, py, cx, cy);
    }

    // Pivot-X by owner kind (#17/#18). HandCard/CardReward grow RIGHT (pivot the union's LEFT edge); Creature/
    // RewardItem grow LEFT (pivot the RIGHT edge); None grows RIGHT unless the scaled right edge would overflow the
    // viewport, then flips to grow LEFT (the map-legend fix — an owner-less tip near the right edge stays on-screen).
    private static double PivotX(TipOwnerKind kind, DesignAabb union, double k, double designWidth) => kind switch
    {
        TipOwnerKind.HandCard or TipOwnerKind.CardReward => union.MinX,
        TipOwnerKind.Creature or TipOwnerKind.RewardItem => union.MaxX,
        // None: grow right by default; flip to grow left only if growing right overflows the right viewport edge.
        _ => union.MinX + (k * (union.MaxX - union.MinX)) > designWidth ? union.MaxX : union.MinX,
    };

    // The scaled union about (px,py) must fit [0,W]×[0,H]; return the translation that brings it in-bounds. Each axis
    // is independent (a box larger than the viewport pins its leading edge to 0).
    private static (double Cx, double Cy) ClampOffset(
        DesignAabb union, double px, double py, double k, double w, double h)
    {
        double sMinX = px + (k * (union.MinX - px));
        double sMaxX = px + (k * (union.MaxX - px));
        double sMinY = py + (k * (union.MinY - py));
        double sMaxY = py + (k * (union.MaxY - py));
        return (AxisClamp(sMinX, sMaxX, w), AxisClamp(sMinY, sMaxY, h));
    }

    // One axis: when the scaled box is larger than the viewport, pin the leading (top/left) edge to 0; otherwise push
    // whichever edge is out of range back in. The leading-edge violation is tested first, so an over-size box pins the
    // top/left rather than the bottom/right.
    private static double AxisClamp(double lo, double hi, double extent)
    {
        if (hi - lo > extent)
        {
            return -lo; // larger than the viewport → pin the leading edge to 0
        }

        if (lo < 0)
        {
            return -lo;
        }

        if (hi > extent)
        {
            return extent - hi;
        }

        return 0;
    }

    // True when the child boxes split into EXACTLY two horizontally-disjoint clusters (a vertical gap no box spans);
    // `gapMid` is the midpoint of that inner gap. Overlapping/touching boxes collapse into one cluster (→ false, a
    // single block), and three-plus disjoint clusters also return false (treated as a single-block union).
    private static bool TryTwoColumnGap(
        System.Collections.Generic.IReadOnlyList<DesignAabb> boxes, out double gapMid)
    {
        gapMid = 0;
        if (boxes.Count < 2)
        {
            return false;
        }

        // Sort a COPY by MinX (never mutate the caller's list).
        var sorted = new System.Collections.Generic.List<DesignAabb>(boxes);
        sorted.Sort(static (a, b) => a.MinX.CompareTo(b.MinX));

        // Sweep, merging overlapping/touching x-intervals into clusters; record the single disjoint break.
        int clusters = 1;
        double runningMaxX = sorted[0].MaxX;
        double gapLeft = 0, gapRight = 0;
        for (int i = 1; i < sorted.Count; i++)
        {
            if (sorted[i].MinX > runningMaxX)
            {
                clusters++;
                if (clusters > 2)
                {
                    return false; // three+ disjoint columns → single-block union
                }

                gapLeft = runningMaxX;
                gapRight = sorted[i].MinX;
            }

            if (sorted[i].MaxX > runningMaxX)
            {
                runningMaxX = sorted[i].MaxX;
            }
        }

        if (clusters != 2)
        {
            return false;
        }

        gapMid = (gapLeft + gapRight) / 2.0;
        return true;
    }
}
