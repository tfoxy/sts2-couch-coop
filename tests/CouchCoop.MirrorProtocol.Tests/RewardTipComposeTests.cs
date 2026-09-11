using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R6 (WS-TIP) pure truth table for the COMPOSED owner-follow forward-map (ViewScaleInputRegistry.MapThroughContainingStamps).
// The bug it fixes: on the card-reward screen a tip's owner-follow mapped the owner box through ONE stamp — the exact-id
// per-card 1.15 (Center + NoClamp ⇒ centre-fixed ⇒ follow delta 0) — and never composed the outer 1.10 GROUP that
// actually displaces an off-centre card by 0.10·(c−S). The fix composes EVERY containing stamp (group ∘ card), so the
// tip follows the group displacement. These cases pin the composed centre displacement, the composed 1.10·1.15 size,
// the middle-card fixed point, the deeper-owner ancestry walk, the non-owner no-op, and the non-descendant fallback.
internal static class RewardTipComposeTests
{
    private const double W = 1920, H = 1080;

    public static void Run()
    {
        SideCardFollowsGroupDisplacement();
        ComposedSizeIsGroupTimesCard();
        MiddleCardIsAFixedPoint();
        DeeperOwnerWalksAncestry();
        NoStampsIsNoOp();
        NonDescendantInsideGroupBoxDoesNotFollow();
    }

    // The core case: a SIDE card (centre c off the screen centre S) glued tip. group(card(box)) displaces the box
    // centre by exactly 0.10·(c−S) — the group-alone displacement (the per-card centre-scale contributes nothing) —
    // where a SINGLE per-card map (the pre-R6 behaviour) gives displacement 0.
    private static void SideCardFollowsGroupDisplacement()
    {
        var (state, applied, cardBox, groupStamp, cardStamp) = CardRewardScene();

        double cCx = (cardBox.MinX + cardBox.MaxX) / 2.0, cCy = (cardBox.MinY + cardBox.MaxY) / 2.0;
        double sX = groupStamp.PivotX, sY = groupStamp.PivotY;

        bool ok = ViewScaleInputRegistry.MapThroughContainingStamps(state, applied, "card", cardBox, out var mapped);
        Check.That(ok, "[tip-compose] a reward side card is covered by a containing stamp");

        double mCx = (mapped.MinX + mapped.MaxX) / 2.0, mCy = (mapped.MinY + mapped.MaxY) / 2.0;
        Check.Close(mCx - cCx, 0.10 * (cCx - sX), "[tip-compose] composed X displacement = 0.10·(c−S)");
        Check.Close(mCy - cCy, 0.10 * (cCy - sY), "[tip-compose] composed Y displacement = 0.10·(c−S)");
        Check.That(Math.Abs(mCx - cCx) > 10, "[tip-compose] a side card's tip anchor genuinely MOVES (non-trivial follow)");

        // The pre-R6 single per-card map (Center + NoClamp) leaves the centre fixed → delta 0: the bug the fix cures.
        var cardOnly = ViewScaleInputRegistry.ScaledBox(cardBox, cardStamp);
        Check.Close((cardOnly.MinX + cardOnly.MaxX) / 2.0, cCx, "[tip-compose] per-card-only map is centre-fixed (the old bug)");
    }

    // The composed box carries BOTH scales: its size is the raw card box × (1.10 group) × (1.15 card). A group-only
    // map would be ×1.10 only — so the size discriminates that the per-card stamp is genuinely composed too.
    private static void ComposedSizeIsGroupTimesCard()
    {
        var (state, applied, cardBox, groupStamp, _) = CardRewardScene();
        double rawW = cardBox.MaxX - cardBox.MinX, rawH = cardBox.MaxY - cardBox.MinY;

        ViewScaleInputRegistry.MapThroughContainingStamps(state, applied, "card", cardBox, out var mapped);
        Check.Close(mapped.MaxX - mapped.MinX, rawW * 1.10 * 1.15, "[tip-compose] composed width = raw · 1.10 · 1.15");
        Check.Close(mapped.MaxY - mapped.MinY, rawH * 1.10 * 1.15, "[tip-compose] composed height = raw · 1.10 · 1.15");

        // Group-alone reference: same centre, but only ×1.10 → proves the extra ×1.15 came from composing the per-card.
        var groupOnly = ViewScaleInputRegistry.ScaledBox(cardBox, groupStamp);
        Check.Close(groupOnly.MaxX - groupOnly.MinX, rawW * 1.10, "[tip-compose] group-only reference is ×1.10 only");
        Check.That(mapped.MaxX - mapped.MinX > groupOnly.MaxX - groupOnly.MinX + 1,
            "[tip-compose] composed box is LARGER than group-only (per-card 1.15 folded in)");
    }

    // A card centred exactly on the group pivot (the middle card) is a fixed point of the group scale, so the composed
    // tip anchor does not move (both group and card are centre-scales about that point).
    private static void MiddleCardIsAFixedPoint()
    {
        var (state, applied, _, groupStamp, _) = CardRewardScene();
        // A middle card whose centre sits on the group pivot.
        double sX = groupStamp.PivotX, sY = groupStamp.PivotY;
        var midBox = new DesignAabb(sX - 150, sY - 200, sX + 150, sY + 200);
        state.Nodes["mid"] = Node("mid", "screen");
        state.OrderedIds.Add("mid");
        var midStamp = HoverTipScaleMath.ComputeAnchoredStamp(midBox, 1.15, W, H, HoverTipScaleMath.AnchorPivot.Center, noClamp: true)!.Value;
        var applied2 = new List<ViewScaleInputRegistry.Applied>(applied)
        {
            new("mid", midStamp, midBox, ViewScaleInputRegistry.ScaledBox(midBox, midStamp), IsGroup: false),
        };

        ViewScaleInputRegistry.MapThroughContainingStamps(state, applied2, "mid", midBox, out var mapped);
        Check.Close((mapped.MinX + mapped.MaxX) / 2.0, sX, "[tip-compose] middle card tip anchor X unchanged (fixed point)");
        Check.Close((mapped.MinY + mapped.MaxY) / 2.0, sY, "[tip-compose] middle card tip anchor Y unchanged (fixed point)");
    }

    // A non-stamped owner DEEP under the card (its art) still composes both ancestor stamps (card then group) via the
    // ancestry walk — the deepest node has no stamp, but the walk finds the card and the screen above it.
    private static void DeeperOwnerWalksAncestry()
    {
        var (state, applied, cardBox, groupStamp, _) = CardRewardScene();
        // An art node under "card": its own box, slightly offset within the card, carries NO stamp of its own.
        var artBox = new DesignAabb(cardBox.MinX + 20, cardBox.MinY + 20, cardBox.MaxX - 20, cardBox.MinY + 120);
        state.Nodes["art"] = Node("art", "card");
        state.OrderedIds.Add("art");

        bool ok = ViewScaleInputRegistry.MapThroughContainingStamps(state, applied, "art", artBox, out var mapped);
        Check.That(ok, "[tip-compose] a deep art owner is covered via ancestry (card + screen)");

        // Independently fold card then group over the art box → must equal the composed result (round-trip).
        var expect = ViewScaleInputRegistry.ScaledBox(
            ViewScaleInputRegistry.ScaledBox(artBox, CardStampOf(applied)), groupStamp);
        Check.Close(mapped.MinX, expect.MinX, "[tip-compose] deep owner composed == card∘group fold (MinX)");
        Check.Close(mapped.MaxY, expect.MaxY, "[tip-compose] deep owner composed == card∘group fold (MaxY)");
    }

    // No stamps in scope (outside every view-scale screen — combat / trash tips) → the map is a no-op and the tip
    // never moves. This is the non-regression invariant for wscrisp-hovertip / r4fix-trash-tip.
    private static void NoStampsIsNoOp()
    {
        var state = MirrorState.Create();
        state.Nodes["owner"] = Node("owner", null);
        state.OrderedIds.Add("owner");
        var box = new DesignAabb(700, 400, 900, 700);

        bool ok = ViewScaleInputRegistry.MapThroughContainingStamps(
            state, Array.Empty<ViewScaleInputRegistry.Applied>(), "owner", box, out var mapped);
        Check.That(!ok, "[tip-compose] no stamps → returns false (no follow)");
        Check.Close(mapped.MinX, box.MinX, "[tip-compose] no stamps → box unchanged (MinX)");
        Check.Close(mapped.MaxY, box.MaxY, "[tip-compose] no stamps → box unchanged (MaxY)");
    }

    // ANCESTRY-only invariant: an owner that is NOT a state-descendant of any stamped node (a TopBar relic / overlay
    // that the group does NOT scale) must NOT follow, even though its centre lands inside the full-viewport group box.
    // This is the non-regression the R5 box-containment fallback got wrong (it would have spuriously mapped it).
    private static void NonDescendantInsideGroupBoxDoesNotFollow()
    {
        var (state, applied, _, _, _) = CardRewardScene();
        // A floating overlay owner with NO parent (not under the screen) whose centre sits inside the full-viewport
        // group box but is a non-scaled sibling overlay → ancestry finds NO stamp → no follow.
        state.Nodes["overlay"] = Node("overlay", null);
        state.OrderedIds.Add("overlay");
        var overlayBox = new DesignAabb(1300, 100, 1500, 300); // centre (1400,200): inside the group box, but not a descendant

        bool ok = ViewScaleInputRegistry.MapThroughContainingStamps(state, applied, "overlay", overlayBox, out var mapped);
        Check.That(!ok, "[tip-compose] a non-descendant overlay inside the group box does NOT map (ancestry-only)");
        Check.Close(mapped.MinX, overlayBox.MinX, "[tip-compose] non-descendant overlay box unchanged (MinX)");
        Check.Close(mapped.MaxY, overlayBox.MaxY, "[tip-compose] non-descendant overlay box unchanged (MaxY)");
    }

    // ---- shared scene: a full-viewport 1.10 group + one off-centre per-card 1.15, card nested under the screen ----

    private static (MirrorState State, List<ViewScaleInputRegistry.Applied> Applied, DesignAabb CardBox,
        HoverTipScaleMath.Stamp GroupStamp, HoverTipScaleMath.Stamp CardStamp) CardRewardScene()
    {
        var state = MirrorState.Create();
        state.Nodes["screen"] = Node("screen", null);
        state.Nodes["card"] = Node("card", "screen");
        state.OrderedIds.Add("screen");
        state.OrderedIds.Add("card");

        var groupBox = new DesignAabb(0, 0, W, H);
        var groupStamp = HoverTipScaleMath.ComputeAnchoredStamp(groupBox, 1.10, W, H, HoverTipScaleMath.AnchorPivot.Center, noClamp: true)!.Value;

        // A clearly off-centre (left) card: centre (350,600), size 300×400.
        var cardBox = new DesignAabb(200, 400, 500, 800);
        var cardStamp = HoverTipScaleMath.ComputeAnchoredStamp(cardBox, 1.15, W, H, HoverTipScaleMath.AnchorPivot.Center, noClamp: true)!.Value;

        var applied = new List<ViewScaleInputRegistry.Applied>
        {
            new("screen", groupStamp, groupBox, ViewScaleInputRegistry.ScaledBox(groupBox, groupStamp), IsGroup: true),
            new("card", cardStamp, cardBox, ViewScaleInputRegistry.ScaledBox(cardBox, cardStamp), IsGroup: false),
        };
        return (state, applied, cardBox, groupStamp, cardStamp);
    }

    private static HoverTipScaleMath.Stamp CardStampOf(IReadOnlyList<ViewScaleInputRegistry.Applied> applied)
    {
        foreach (var a in applied)
        {
            if (a.Id == "card")
            {
                return a.Stamp;
            }
        }

        throw new InvalidOperationException("card stamp missing");
    }

    private static MirrorNode Node(string id, string? parent) => new()
    {
        Id = id,
        ParentId = parent,
        NodeType = "Control",
        Name = id,
        Visible = true,
    };
}
