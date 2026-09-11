using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for the Track-C card-layer planner (pure eligibility + paint-order occlusion math). Covers: single-card
// promotion (members / live-effect split / union AABB over a 0×0 root), fanned-group ordered promotion, occlusion
// (later non-card painter / later in-stage card / later text demote; the leftward cascade; z-agnostic block;
// unknown-bounds suffix bail), the eligibility rejects (ancestor clip/effect, member z-index, invisible chain, echo
// promotion, additive member allowed), the root-exempt-vs-non-root dynamism split, the per-drain CollectDemotions
// guard (member rebuild / member-hint demote / root-hint keep / new-overlap / swept-tween / conservatism superset),
// nested-card skipping, and the cross-planner "a promoted card's members reject as Dynamic in the text overlay".
internal static class CardLayerPlannerTests
{
    public static void Run()
    {
        SingleCardPromotes();
        FannedGroupPromotesOrdered();
        LaterNonCardPainterDemotes();
        DemotedClusterCascadesLeft();
        LaterTextPaintDemotes();
        EchoPreviewCardPromotes();
        MemberZIndexRejects();
        AncestorClipRejects();
        AncestorEffectRejects();
        InvisibleChainSkips();
        RootDynamismDoesNotDemote();
        AgnosticPainterBlocks();
        UnknownBoundsSuffixBail();

        // WS-crisp2 (hole-aware textured occluders — the deck-dialog BorderGradient scrim)
        BlockerHoleClearsContainedCard();
        BlockerOpaqueBandOccludesCard();
        BlockerArtExtentTightensBox();
        NoArtInfoLeavesFullBoxOccluding();
        AdditiveMemberStaysCloneable();
        NestedCardSkipsInner();
        InterleavedEffectSubtreeDoesNotSkipMembers();
        ShaderMemberIsClonedNotLiveEffect();

        // CollectDemotions
        ChangedMemberYieldsRebuild();
        RootHintKeeps();
        NewOverlapDemotes();
        SweptHintDemotes();
        DemotionsSupersetOfReplan();
        RepromoteDebounceArmsAfterThreshold();
        RepromoteDebounceWindowExpires();
        RepromoteDebounceCooldownExpires();
        RepromoteDebounceClearDropsCooldown();

        // Current tracked-member behavior
        CurrentMemberTweenPromotes();
        CurrentMemberUnsettledStillRejects();
        CurrentMemberHintDoesNotDemote();
        CurrentNewOverlapStillDemotes();
        CurrentDemotionsSupersetOfReplan();

        // Current z-band paint order
        ZBandCardPromotes();
        ZBandCardUnderHigherBandArtOccluded();
        ZBandMemberIndexStillRejects();

        // Current clipping policy
        ContainedClipCardPromotes();
        PartiallyClippedCardStillRejects();
        WidenedClipWidthHonored();
        NonClipEffectAncestorStillRejects();
        ClipAncestorScrollDemotes();

        LastCandidateRootsListDeclinedAndPromoted();
    }

    // Every top-level NCard root the plan EVALUATED lands in LastCandidateRoots — including DECLINED ones (a clip-
    // rejected deck-dialog grid card), so the text overlay can tell "known + declined" (labels fall through) apart
    // from "never seen" (stays conservatively owned). Nested cards are claimed by their outer root and NOT listed.
    private static void LastCandidateRootsListDeclinedAndPromoted()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("ok", "stage", 100, 100, 280, 380, out _, out _); // plain card → promotes
        var clip = h.AddGroup("clip", "stage", 700, 80, 300, 900);
        clip.ClipChildren = 1;
        h.Card("declined", "clip", 720, 100, 400, 380, out _, out _); // partially outside the clipping region
        var plan = h.PlanNow();
        Check.Equal(plan.Clusters.Count, 1, "only the plain card promotes");
        Check.Equal(plan.Clusters[0].RootId, "ok", "the plain card");
        var roots = new HashSet<string>(h.Planner.LastCandidateRoots, System.StringComparer.Ordinal);
        Check.That(roots.Contains("ok") && roots.Contains("declined"), "BOTH evaluated roots are listed");
        Check.Equal(roots.Count, 2, "exactly the two top-level roots");
    }

    // ---- z-band paint order -------------------------------------------------------------------------------------

    private static void ZBandCardPromotes()
    {
        // A card under a z=-10 ancestor band is ordered by its effective paint key and promotes when unobscured.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        var band = h.AddGroup("band", "stage", 0, 0, 1920, 1080);
        band.ZIndex = -10;
        h.Card("card", "band", 100, 100, 200, 300, out _, out _);
        Check.That(Promoted(h.PlanNow(), "card"), "the z-band card promotes when nothing overlaps");
    }

    private static void ZBandCardUnderHigherBandArtOccluded()
    {
        // The anti-floater: a card in a z=-1 band fully under overlapping z=0 opaque art (EARLIER in pre-order — the
        // pre-order model would paint it before the card). The z-aware order paints the art's band after the card's →
        // the card is Occluded, never floated crisp over the covering art.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddRect("panel", "stage", 100, 100, 200, 300); // z=0, earlier pre-order, fully covering the card's box
        var band = h.AddGroup("band", "stage", 0, 0, 1920, 1080);
        band.ZIndex = -1;
        h.Card("card", "band", 100, 100, 200, 300, out _, out _);
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "a z=-1 card under overlapping z=0 art must NOT promote");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.Occluded), 1,
            "the reject is Occluded");
    }

    private static void ZBandMemberIndexStillRejects()
    {
        // A cloneable MEMBER's own ZIndex≠0 still rejects — the clone AddChild-orders members by tree
        // order and cannot reproduce an intra-card z flip (distinct from the ancestor-band case, which only shifts the
        // whole card's band).
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out var members, out _);
        h.Node(members[2]).ZIndex = 3;
        Check.That(!Promoted(h.PlanNow(), "card"), "a member z-index still rejects");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.ZOrder), 1,
            "one ZOrder reject (member)");
    }

    // ---- clipping containment -----------------------------------------------------------------------------------

    // A card under a clipping ScrollContainer promotes when that clip fully contains the cluster union.
    private static void ContainedClipCardPromotes()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddGroup("clip", "stage", 200, 200, 1200, 800).ClipChildren = 1; // the dialog ScrollContainer
        h.Card("card", "clip", 300, 300, 280, 380, out _, out _);          // a grid cell fully inside the clip
        Check.That(Promoted(h.PlanNow(), "card"),
            "a clip-contained grid card promotes");
        var c = Cluster(h.PlanNow(), "card");
        Check.That(c.ClipAncestorIds.Contains("clip"), "the proven clip ancestor is carried on the cluster");
    }

    private static void PartiallyClippedCardStillRejects()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddGroup("clip", "stage", 200, 200, 300, 800).ClipChildren = 1; // clip maxX = 500
        h.Card("card", "clip", 300, 300, 400, 380, out _, out _);         // union reaches x ~700, past the clip
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "a partially-clipped card still rejects");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.AncestorClip), 1,
            "one AncestorClip reject (partial containment)");
    }

    // WS-COLUMN: at F≠1 a horizontally-stretched ScrollContainer renders WIDER than its streamed rect. A card near the
    // widened right edge is contained only when the clip-contains test uses the anchor-WIDENED width (spreadWidthOf).
    // With the un-widened width the same card falsely fails Contains → AncestorClip (the deck-dialog last-column bug).
    private static void WidenedClipWidthHonored()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 2400, 1080);
        h.AddGroup("clip", "stage", 0, 0, 1000, 1000).ClipChildren = 1; // streamed width 1000
        h.SpreadWidth["clip"] = 1300;                                    // anchor-widened rendered width at F=1.25
        // a card cell near the widened right edge: union ~[900..1080] (past the un-widened 1000, within widened 1300).
        h.AddCardRoot("card", "clip", 900, 100);
        h.AddPortrait("card_art", "card", 900, 100, 180, 300); // non-text member → union ≈ [884,84 1096,416] with wide slack
        Check.That(!Promoted(h.PlanNow(factor: 1.25, useSpreadWidth: false), "card"),
            "un-widened clip width falsely rejects the rightmost widened grid column");
        Check.That(Promoted(h.PlanNow(factor: 1.25, useSpreadWidth: true), "card"),
            "the anchor-widened width contains the card → promotes (WS-COLUMN)");
    }

    // A non-clip effect ancestor still rejects even when a clip ancestor contains the card.
    private static void NonClipEffectAncestorStillRejects()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        var fx = h.AddGroup("fx", "stage", 0, 0, 1900, 1060);
        fx.ShaderId = "res://x.gdshader"; // an effect ancestor ABOVE the clip
        h.AddGroup("clip", "fx", 200, 200, 1200, 800).ClipChildren = 1;
        h.Card("card", "clip", 300, 300, 280, 380, out _, out _);
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "an effect ancestor still rejects the card");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.AncestorEffect), 1,
            "the reject is AncestorEffect (not AncestorClip)");
    }

    // Rule 5: a promoted clip-contained cluster whose PROVEN clip ancestor changes this drain (a scroll) demotes — the
    // clone tree can't reproduce a mid-scroll crop. It re-promotes at the next eval if still fully inside.
    private static void ClipAncestorScrollDemotes()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddGroup("clip", "stage", 200, 200, 1200, 800).ClipChildren = 1;
        h.Card("card", "clip", 300, 300, 280, 380, out _, out _);
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "promoted (clip-contained) at rest");
        var (demote, _, _) = h.Demotions(plan, changed: "clip");
        Check.That(demote.Contains("card"), "the clip ancestor changing (a scroll) demotes the cluster");
    }

    // ---- tracked members ----------------------------------------------------------------------------------------

    private static void CurrentMemberTweenPromotes()
    {
        // The controller's per-frame member-clone sync tracks non-root member motion.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out var members, out _);
        Check.That(Promoted(h.PlanNow(dynamic: members[2]), "card"),
            "a member tween or animation remains cloneable");
    }

    private static void CurrentMemberUnsettledStillRejects()
    {
        // An unsettled-texture member still rejects because cloning undecoded art would freeze a blank.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out var members, out _);
        Check.That(!Promoted(h.PlanNow(unsettled: members[2]), "card"),
            "a non-root member with an unsettled texture still rejects the card");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.MemberDynamic), 1,
            "one MemberDynamic reject (the unsettled member)");
    }

    private static void CurrentMemberHintDoesNotDemote()
    {
        // The per-frame member sync tracks a tween hint on a non-root member.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out var members, out _);
        var plan = h.PlanNow();
        var hint = new MirrorTweenHint(members[2], "transform", null, 300, null, null,
            EndTransform: new double[] { 1, 0, 0, 1, 20, 0 }, EndOpacity: null, Group: null, StartTransform: null, StartOpacity: null);
        var (demote, _, _) = h.Demotions(plan, hints: new[] { hint });
        Check.That(!demote.Contains("card"), "a member hint does not demote the tracked clone");
    }

    private static void CurrentNewOverlapStillDemotes()
    {
        // A changed non-member painter that overlaps the card still demotes it.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        h.AddRect("panel", "stage", 800, 0, 200, 300);
        var plan = h.PlanNow();
        h.Node("panel").LocalRect = new MirrorRect(100, 100, 200, 300);
        var (demote, _, _) = h.Demotions(plan, changed: "panel");
        Check.That(demote.Contains("card"), "a new occluder still demotes");
    }

    private static void CurrentDemotionsSupersetOfReplan()
    {
        // A fresh plan after an occluder moves over the card rejects it, and CollectDemotions is a superset.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        h.AddRect("panel", "stage", 800, 0, 200, 300);
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "promoted at rest");
        h.Node("panel").LocalRect = new MirrorRect(100, 100, 200, 300);
        var replan = h.PlanNow();
        var (demote, _, _) = h.Demotions(plan, changed: "panel");
        Check.That(!Promoted(replan, "card"), "the re-plan now rejects the card");
        Check.That(demote.Contains("card"), "CollectDemotions demotes a superset of the re-plan");
    }

    // ---- card re-promotion debounce -----------------------------------------------------------------------------

    private static void RepromoteDebounceArmsAfterThreshold()
    {
        var debounce = new RepromoteDebounce(threshold: 2, windowEvals: 4, cooldownEvals: 4);
        debounce.BeginEval(new[] { "card" });
        Check.That(!debounce.Suppressed("card"), "one transient card demotion does not arm cooldown");
        debounce.BeginEval(new[] { "card" });
        Check.That(debounce.Suppressed("card"), "threshold transient card demotions arm cooldown");
    }

    private static void RepromoteDebounceWindowExpires()
    {
        var debounce = new RepromoteDebounce(threshold: 2, windowEvals: 4, cooldownEvals: 4);
        debounce.BeginEval(new[] { "card" });
        for (int i = 0; i < 4; i++)
        {
            debounce.BeginEval(System.Array.Empty<string>());
        }

        debounce.BeginEval(new[] { "card" });
        Check.That(!debounce.Suppressed("card"), "demotions outside the sliding window do not arm cooldown");
    }

    private static void RepromoteDebounceCooldownExpires()
    {
        var debounce = new RepromoteDebounce(threshold: 2, windowEvals: 4, cooldownEvals: 2);
        debounce.BeginEval(new[] { "card" });
        debounce.BeginEval(new[] { "card" });
        Check.That(debounce.Suppressed("card"), "card cooldown arms");
        debounce.BeginEval(System.Array.Empty<string>());
        debounce.BeginEval(System.Array.Empty<string>());
        Check.That(!debounce.Suppressed("card"), "card cooldown expires");
    }

    private static void RepromoteDebounceClearDropsCooldown()
    {
        var debounce = new RepromoteDebounce(threshold: 2, windowEvals: 4, cooldownEvals: 4);
        debounce.BeginEval(new[] { "card" });
        debounce.BeginEval(new[] { "card" });
        Check.That(debounce.Suppressed("card"), "card cooldown arms before clear");
        Check.That(debounce.Clear("card"), "clear removes an armed card cooldown");
        Check.That(!debounce.Suppressed("card"), "cleared card cooldown no longer suppresses promotion");
    }

    // ---- promotion ----------------------------------------------------------------------------------------------

    private static void SingleCardPromotes()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out var members, out var effects);
        var plan = h.PlanNow();

        Check.That(plan.HasAny, "a plain on-screen card promotes");
        Check.Equal(plan.Clusters.Count, 1, "one cluster");
        var c = plan.Clusters[0];
        Check.Equal(c.RootId, "card", "cluster root id");
        Check.Equal(c.MemberIds[0], "card", "the root is the first (pre-order) member");
        foreach (var m in members)
        {
            Check.That(c.MemberIds.Contains(m), $"cloneable member {m} present");
        }

        foreach (var e in effects)
        {
            Check.That(!c.MemberIds.Contains(e), $"effect member {e} is NOT cloned");
            Check.That(c.LiveEffectIds.Contains(e), $"effect member {e} is a live effect");
        }

        // The AABB is the MEMBER union (the 0×0 root did not collapse it), covering the card interior.
        Check.That(c.Aabb.Overlaps(new DesignAabb(200, 250, 201, 251)), "AABB covers the card interior");
        Check.That(c.Aabb.MaxX - c.Aabb.MinX > 150 && c.Aabb.MaxY - c.Aabb.MinY > 150, "AABB is the member union, not the 0×0 root point");
    }

    private static void FannedGroupPromotesOrdered()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        // three overlapping fanned cards, left→right (paint order = DFS order = A,B,C).
        h.Card("A", "stage", 100, 200, 200, 300, out _, out _);
        h.Card("B", "stage", 220, 200, 200, 300, out _, out _);
        h.Card("C", "stage", 340, 200, 200, 300, out _, out _);
        var plan = h.PlanNow();

        Check.Equal(plan.Clusters.Count, 3, "all three fanned cards promote (promoted cards do not block each other)");
        Check.Equal(plan.Clusters[0].RootId, "A", "emitted ascending by paint key: A first (under)");
        Check.Equal(plan.Clusters[1].RootId, "B", "B middle");
        Check.Equal(plan.Clusters[2].RootId, "C", "C last (on top)");
        Check.That(plan.Clusters[0].PaintKey < plan.Clusters[1].PaintKey && plan.Clusters[1].PaintKey < plan.Clusters[2].PaintKey,
            "paint keys ascending");
    }

    private static void LaterNonCardPainterDemotes()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        h.AddRect("panel", "stage", 100, 100, 200, 300); // later opaque sibling fully covering the card
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "a later opaque non-card painter demotes the card");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.Occluded), 1, "one Occluded reject");
    }

    private static void DemotedClusterCascadesLeft()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("A", "stage", 100, 200, 200, 300, out _, out _);
        h.Card("B", "stage", 220, 200, 200, 300, out _, out _);
        h.Card("C", "stage", 340, 200, 200, 300, out _, out _);
        // A later panel covers ONLY the rightmost card C. C demotes → its AABB blocks B → B blocks A (leftward cascade).
        h.AddRect("panel", "stage", 360, 200, 180, 300);
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "A") && !Promoted(plan, "B") && !Promoted(plan, "C"),
            "demoting the rightmost card cascades left across the overlapping fan");
    }


    private static void LaterTextPaintDemotes()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        h.AddText("tooltip", "stage", 120, 120, 160, 60); // a later floating label overlapping the card
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "a later text label painting over the card demotes it");
    }

    private static void EchoPreviewCardPromotes()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        // an echo/preview container ancestor (touch-targeting excludes these, but the CARD LAYER promotes them — the
        // preview card's text is just as mushy and just as worth promoting). The planner never special-cases echoes.
        h.AddGroup("preview", "stage", 0, 0, 1920, 1080).NodeType = "Godot.NCardPreviewContainer";
        h.Card("card", "preview", 100, 100, 200, 300, out _, out _);
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "a card under an echo/preview container still promotes");
    }

    private static void MemberZIndexRejects()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out var members, out _);
        h.Node(members[2]).ZIndex = 3; // a cloneable member paints out of DFS order → the whole card is ineligible
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "a member with a non-zero z-index rejects the card");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.ZOrder), 1, "one ZOrder reject");
    }

    private static void AncestorClipRejects()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddGroup("clip", "stage", 0, 0, 400, 400).ClipChildren = 1;
        h.Card("card", "clip", 100, 100, 200, 300, out _, out _);
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "a clip ancestor rejects the card (the un-nested clone cannot reproduce the clip)");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.AncestorClip), 1, "one AncestorClip reject");
    }

    private static void AncestorEffectRejects()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddGroup("fx", "stage", 0, 0, 400, 400).ShaderId = "res://x.gdshader";
        h.Card("card", "fx", 100, 100, 200, 300, out _, out _);
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "an effect ancestor rejects the card");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.AncestorEffect), 1, "one AncestorEffect reject");
    }

    private static void InvisibleChainSkips()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddGroup("hidden", "stage", 0, 0, 400, 400).Visible = false;
        h.Card("card", "hidden", 100, 100, 200, 300, out _, out _);
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "a card under an invisible ancestor is not promoted");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.Invisible), 1, "one Invisible reject");
    }

    private static void RootDynamismDoesNotDemote()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        // the ROOT itself is dynamically owned (a hover-lift / spread / draw tween moves the whole card) — EXEMPT,
        // because the controller re-syncs the holder to the live global every frame. The card still promotes crisp.
        var plan = h.PlanNow(dynamic: "card");
        Check.That(Promoted(plan, "card"), "a dynamic ROOT does not demote the card (the crux of crisp-during-hover/drag)");
    }


    private static void AgnosticPainterBlocks()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        // a z-index painter placed EARLIER in DFS than the card — its paint key would sort under the card, but z-order
        // is order-agnostic, so it blocks regardless.
        var z = h.AddRect("z", "stage", 100, 100, 200, 300);
        z.ZIndex = 5;
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "an order-agnostic (z-index) painter blocks the card even though it paints earlier in DFS");
    }

    // ---- WS-crisp2: hole-aware textured occluders ---------------------------------------------------------------

    // The deck-dialog `BorderGradient` shape: a later textured scrim covering the WHOLE grid, but painting only its
    // extreme rows (a transparent HOLE across the middle). A card whose cluster box sits ENTIRELY inside the hole is
    // NOT occluded — the scrim paints nothing over it — so it promotes. Without the hole the full box demotes it.
    private static void BlockerHoleClearsContainedCard()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 400, 200, 300, out _, out _); // cluster AABB ≈ [86,400 314,714]
        h.AddPortrait("scrim", "stage", 0, 0, 1920, 1080); // later full-grid textured occluder

        // control: no maps → the scrim's full layout box covers the card → occluded (pre-crisp2 behaviour).
        Check.That(!Promoted(h.PlanArt(null, null), "card"), "control: no hole ⇒ the full scrim box occludes the card");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.Occluded), 1, "control: one Occluded");

        // with a hole that CONTAINS the card cluster box → the scrim covers nothing over it → promotes.
        var holes = new Dictionary<string, DesignAabb>(System.StringComparer.Ordinal)
        {
            ["scrim"] = new DesignAabb(50, 380, 1900, 740),
        };
        Check.That(Promoted(h.PlanArt(null, holes), "card"), "a card fully inside the scrim's transparent hole promotes");
    }

    // The edge card: its box straddles the OPAQUE fade band (reaches OUTSIDE the hole), so the scrim really does paint
    // over part of it → it stays legitimately occluded (the scroll-fade look is preserved for edge-most cards).
    private static void BlockerOpaqueBandOccludesCard()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 400, 200, 300, out _, out _); // cluster AABB ≈ [86,400 314,714]
        h.AddPortrait("scrim", "stage", 0, 0, 1920, 1080);

        var holes = new Dictionary<string, DesignAabb>(System.StringComparer.Ordinal)
        {
            ["scrim"] = new DesignAabb(0, 720, 1920, 1000), // hole BELOW the card → card overlaps the opaque band above
        };
        Check.That(!Promoted(h.PlanArt(null, holes), "card"), "a card overlapping the opaque fade band stays occluded");
    }

    // The tightened drawn-art box (used-rect) shrinks the occluder to the pixels it actually paints, so a card outside
    // that art — but inside the full layout rect — promotes (mirrors the TextOverlay occluder-tightening).
    private static void BlockerArtExtentTightensBox()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 400, 200, 300, out _, out _); // cluster AABB ≈ [86,400 314,714]
        h.AddPortrait("scrim", "stage", 0, 0, 1920, 1080);

        // control: full box occludes.
        Check.That(!Promoted(h.PlanArt(null, null), "card"), "control: full box occludes");

        // art extent = only the top band is painted → no overlap with the card below it → promotes.
        var art = new Dictionary<string, DesignAabb>(System.StringComparer.Ordinal)
        {
            ["scrim"] = new DesignAabb(0, 0, 1920, 300),
        };
        Check.That(Promoted(h.PlanArt(art, null), "card"), "a card outside the tightened drawn-art box promotes");
    }

    // Fail-closed: an occluder with NO art-info entry keeps its full layout-rect box AND no hole exemption, exactly the
    // pre-crisp2 behaviour (a missing measurement is never LESS safe).
    private static void NoArtInfoLeavesFullBoxOccluding()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 400, 200, 300, out _, out _);
        h.AddPortrait("scrim", "stage", 0, 0, 1920, 1080);

        // maps present but for a DIFFERENT id (the scrim has no entry) → the scrim keeps its full box + no hole.
        var art = new Dictionary<string, DesignAabb>(System.StringComparer.Ordinal) { ["other"] = new DesignAabb(0, 0, 1, 1) };
        var holes = new Dictionary<string, DesignAabb>(System.StringComparer.Ordinal) { ["other"] = new DesignAabb(0, 0, 1920, 1080) };
        Check.That(!Promoted(h.PlanArt(art, holes), "card"), "no art-info for the occluder ⇒ full box occludes (fail-closed)");
    }

    private static void UnknownBoundsSuffixBail()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        // a LATER painter with no box (unknown bounds) → suffix-bails ALL earlier cards.
        var blob = h.AddRect("blob", "stage", 0, 0, 10, 10);
        blob.LocalRect = null;
        blob.TextureUrl = "res://x.png";
        var plan = h.PlanNow();
        Check.That(!Promoted(plan, "card"), "an unknown-bounds later painter suffix-bails the card");
    }

    private static void AdditiveMemberStaysCloneable()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out var members, out _);
        h.Node(members[2]).CanvasBlendMode = 1; // an additive member (AncientBorder) — allowed: the nesting reproduces it
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "an additive member does not reject the card (the clone nesting reproduces the blend)");
        Check.That(Cluster(plan, "card").MemberIds.Contains(members[2]), "the additive member is still cloned");
    }

    private static void NestedCardSkipsInner()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        // an outer card whose subtree contains an inner NCard (a card-in-card preview). The inner is Nested → skipped;
        // the outer owns/clones the whole subtree.
        h.AddCardRoot("outer", "stage", 100, 100);
        h.AddGroup("outer_body", "outer", 100, 100, 300, 400);
        h.AddPortrait("outer_portrait", "outer_body", 110, 110, 180, 180);
        h.AddCardRoot("inner", "outer_body", 120, 300); // nested NCard
        h.AddPortrait("inner_portrait", "inner", 130, 310, 100, 120);
        var plan = h.PlanNow();
        Check.Equal(plan.Clusters.Count, 1, "only the outer card is a cluster");
        Check.Equal(plan.Clusters[0].RootId, "outer", "the outer card owns the range");
        Check.That(plan.Clusters[0].MemberIds.Contains("inner") && plan.Clusters[0].MemberIds.Contains("inner_portrait"),
            "the nested inner card's members are cloned by the outer cluster");
        Check.That(h.Planner.LastRejectHistogram.GetValueOrDefault(CardLayerPlanner.CardReject.Nested) >= 1, "the inner card is a Nested skip");
    }

    private static void InterleavedEffectSubtreeDoesNotSkipMembers()
    {
        // REGRESSION (device bug): the producer's paint order interleaves foreign / effect-subtree nodes within a
        // card's OrderedIds span, so the subtree is NOT contiguous. An effect member 'fx' has a child 'fx_child'
        // whose OrderedIds index sits AFTER a real cloneable member 'real'. A naive index-range effect-skip
        // ([fx .. subtreeEnd(fx)]) would skip 'real'. The parent-structure enumeration must still clone 'real'.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddCardRoot("card", "stage", 100, 100);
        h.AddGroup("cont", "card", 100, 100, 200, 300);           // CardContainer
        h.AddGroup("fx", "cont", 100, 100, 200, 300).SpineSceneResPath = "res://fx.tscn"; // a particle/spine (live-only) effect member
        h.AddPortrait("real", "cont", 110, 110, 180, 180);        // a real cloneable member (OrderedIds AFTER fx)
        h.AddGroup("fx_child", "fx", 100, 100, 200, 300);         // fx's child — OrderedIds index HIGHER than 'real'
        // OrderedIds: [stage, card, cont, fx, real, fx_child]; subtreeEnd(fx) == index(fx_child) SPANS 'real'.
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "the card promotes despite the non-contiguous subtree");
        var c = Cluster(plan, "card");
        Check.That(c.MemberIds.Contains("real"), "a member interleaved inside an effect's OrderedIds span is still cloned (parent-structure enumeration)");
        Check.That(!c.MemberIds.Contains("fx") && !c.MemberIds.Contains("fx_child"), "the effect subtree is not cloned");
        Check.That(c.LiveEffectIds.Contains("fx") && c.LiveEffectIds.Contains("fx_child"), "the whole effect subtree is a live effect");
    }

    private static void ShaderMemberIsClonedNotLiveEffect()
    {
        // A shader/material member (the card FRAME uses an HSV-recolor shader) is CLONED — a full MirrorNodeView clone
        // renders the shader crisp at design res, and hoist-suppression skips the LIVE member's _Draw so it doesn't
        // double-draw. Leaving it in-stage would strand the shader-framed chrome BEHIND the cloned portrait on the
        // layer above. Only particle/spine members stay live.
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.AddCardRoot("card", "stage", 100, 100);
        h.AddGroup("cont", "card", 100, 100, 200, 300);
        var frame = h.AddPortrait("frame", "cont", 100, 100, 200, 300); // the framed chrome
        frame.ShaderId = "res://shaders/hsv.gdshader";
        frame.MaterialRef = "res://materials/card_frame.tres";
        h.AddPortrait("portrait", "cont", 110, 110, 180, 180);
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "the card promotes");
        var c = Cluster(plan, "card");
        Check.That(c.MemberIds.Contains("frame"), "a shader/material FRAME member is cloned (renders crisp)");
        Check.That(!c.LiveEffectIds.Contains("frame"), "the shader frame is NOT left as a live effect");
    }

    // ---- CollectDemotions ---------------------------------------------------------------------------------------

    private static void ChangedMemberYieldsRebuild()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out var members, out _);
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "promoted at rest");

        var (demote, rebuild, _) = h.Demotions(plan, changed: members[3]); // a text member (HP/desc) changed, still eligible
        Check.That(rebuild.Contains(members[3]) && !demote.Contains("card"), "a changed-but-eligible member rebuilds in place (no demote)");
    }


    private static void RootHintKeeps()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        var plan = h.PlanNow();

        // a transform tween on the ROOT (a draw/hover animation moving the whole card) — the holder tracks it → NO demote.
        var rootHint = new MirrorTweenHint("card", "transform", null, 300, null, null,
            EndTransform: new double[] { 1, 0, 0, 1, 300, 0 }, EndOpacity: null, Group: null, StartTransform: null, StartOpacity: null);
        var (demoteRoot, _, _) = h.Demotions(plan, hints: new[] { rootHint });
        Check.That(!demoteRoot.Contains("card"), "a hint on the ROOT does not demote (deliberate inversion of the text-overlay rule)");

        // an ancestor transform tween (the hand re-fanning) also tracked by the holder → NO demote.
        var ancestorHint = new MirrorTweenHint("stage", "transform", null, 300, null, null,
            EndTransform: new double[] { 1, 0, 0, 1, 300, 0 }, EndOpacity: null, Group: null, StartTransform: null, StartOpacity: null);
        var (demoteAnc, _, _) = h.Demotions(plan, hints: new[] { ancestorHint });
        Check.That(!demoteAnc.Contains("card"), "a hint on an ANCESTOR does not demote (the holder tracks ancestor motion)");
    }

    private static void NewOverlapDemotes()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        h.AddRect("panel", "stage", 800, 0, 200, 300); // far away initially
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "promoted while the panel is clear");

        h.Node("panel").LocalRect = new MirrorRect(100, 100, 200, 300); // slide the panel over the card
        var (demote, _, _) = h.Demotions(plan, changed: "panel");
        Check.That(demote.Contains("card"), "a changed non-member painter now overlapping the card demotes it");
    }

    private static void SweptHintDemotes()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        var mover = h.AddRect("mover", "stage", 800, 100, 200, 300); // far right, no overlap now
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "promoted while the mover is far");

        // a transform tween sweeps 'mover' left by 800 so its swept box (current ∪ endpoint) crosses the card.
        var hint = new MirrorTweenHint("mover", "transform", null, 300, null, null,
            EndTransform: new double[] { 1, 0, 0, 1, -800, 0 }, EndOpacity: null, Group: null, StartTransform: null, StartOpacity: null);
        var (demote, _, _) = h.Demotions(plan, hints: new[] { hint });
        Check.That(demote.Contains("card"), "a transform tween whose swept AABB crosses the card demotes it");
    }

    private static void DemotionsSupersetOfReplan()
    {
        var h = new Harness();
        h.AddGroup("stage", null, 0, 0, 1920, 1080);
        h.Card("card", "stage", 100, 100, 200, 300, out _, out _);
        h.AddRect("panel", "stage", 800, 0, 200, 300);
        var plan = h.PlanNow();
        Check.That(Promoted(plan, "card"), "promoted at rest");

        h.Node("panel").LocalRect = new MirrorRect(100, 100, 200, 300); // panel slides over the card
        var replan = h.PlanNow();
        var (demote, _, _) = h.Demotions(plan, changed: "panel");
        Check.That(!Promoted(replan, "card"), "the fresh re-Plan now rejects the card");
        Check.That(demote.Contains("card"), "CollectDemotions demotes a superset of what a fresh re-Plan rejects");
    }

    // ---- cross-planner ------------------------------------------------------------------------------------------


    // ---- helpers ------------------------------------------------------------------------------------------------

    private static bool Promoted(CardLayerPlan plan, string root)
    {
        foreach (var c in plan.Clusters)
        {
            if (c.RootId == root)
            {
                return true;
            }
        }

        return false;
    }

    private static CardClusterItem Cluster(CardLayerPlan plan, string root)
    {
        foreach (var c in plan.Clusters)
        {
            if (c.RootId == root)
            {
                return c;
            }
        }

        throw new System.Exception($"cluster {root} not promoted");
    }

    private sealed class Harness
    {
        public readonly MirrorState State = MirrorState.Create();
        public readonly GlobalTransformIndex Transforms = new();
        public readonly CardLayerPlanner Planner = new();
        public readonly Dictionary<string, double> SpreadDx = new(System.StringComparer.Ordinal);
        public readonly Dictionary<string, double> SpreadWidth = new(System.StringComparer.Ordinal); // #14 Leg A widened width


        public MirrorNode Node(string id) => State.Nodes[id];

        public MirrorNode AddNode(string id, string? parent, double x, double y, double w, double h, string nodeType)
        {
            var n = new MirrorNode
            {
                Id = id,
                ParentId = parent,
                NodeType = nodeType,
                Transform = new double[] { 1, 0, 0, 1, 0, 0 },
                LocalRect = new MirrorRect(x, y, w, h),
            };
            State.Nodes[id] = n;
            State.OrderedIds.Add(id);
            return n;
        }

        public MirrorNode AddGroup(string id, string? parent, double x, double y, double w, double h) =>
            AddNode(id, parent, x, y, w, h, "Godot.Control");

        public MirrorNode AddRect(string id, string? parent, double x, double y, double w, double h)
        {
            var n = AddGroup(id, parent, x, y, w, h);
            n.FillColor = new MirrorColor(1, 1, 1, 1, "#ffffffff");
            return n;
        }

        public MirrorNode AddText(string id, string? parent, double x, double y, double w, double h)
        {
            var n = AddGroup(id, parent, x, y, w, h);
            n.Text = new MirrorText("hi", "#ffffff", 24, "center", "center", null, 0);
            return n;
        }

        public MirrorNode AddPortrait(string id, string? parent, double x, double y, double w, double h)
        {
            var n = AddGroup(id, parent, x, y, w, h);
            n.TextureUrl = "res://portrait.png";
            return n;
        }

        public MirrorNode AddCardRoot(string id, string? parent, double x, double y) =>
            AddNode(id, parent, x, y, 0, 0, "Godot.NCard"); // NCard root with a 0×0 rect (matches the real card)

        // Build a realistic card subtree at (x,y,w,h): NCard root (0×0) → CardContainer(box) → [Shadow, UncommonGlow
        // (effect), Portrait, AncientBorder, DescriptionLabel, CardSparkles(effect)]. Returns the cloneable member ids
        // (root first) + the effect ids. members[0]=root, members[1]=container, members[2]=border (a plain member),
        // members[3]=a text label.
        public void Card(string id, string? parent, double x, double y, double w, double h,
            out List<string> members, out List<string> effects)
        {
            members = new List<string>();
            effects = new List<string>();

            AddCardRoot(id, parent, x, y);
            members.Add(id);

            string container = id + "_c";
            AddGroup(container, id, x, y, w, h);
            members.Add(container);

            string glow = id + "_glow";
            AddGroup(glow, container, x, y, w, h).SpineSceneResPath = "res://glow_spine.tscn"; // a particle/spine (live-only) effect
            effects.Add(glow);

            string border = id + "_border";
            AddPortrait(border, container, x + 5, y + 5, w - 10, h - 60); // AncientBorder/Portrait — a plain textured member
            members.Add(border);

            string label = id + "_desc";
            AddText(label, container, x + 10, y + h - 50, w - 20, 40); // DescriptionLabel
            members.Add(label);

            string sparkles = id + "_spk";
            AddGroup(sparkles, container, x, y, w, h).SpineSceneResPath = "res://sparkles.tscn"; // CardSparkles → live effect
            effects.Add(sparkles);
        }

        public CardLayerPlan PlanNow(string? dynamic = null, double factor = 1.0, string? boundedCosmetic = null,
            string? unsettled = null, bool useSpreadWidth = false)
        {
            Transforms.Update(State);
            Planner.RebuildIndex(State);
            var dyn = new HashSet<string>(System.StringComparer.Ordinal);
            if (dynamic is not null)
            {
                dyn.Add(dynamic);
            }

            if (boundedCosmetic is not null)
            {
                dyn.Add(boundedCosmetic);
            }

            var owned = new HashSet<string>(System.StringComparer.Ordinal);
            var bounded = boundedCosmetic is null
                ? Empty
                : new HashSet<string>(System.StringComparer.Ordinal) { boundedCosmetic };
            var uns = unsettled is null ? Empty : new HashSet<string>(System.StringComparer.Ordinal) { unsettled };
            return Planner.Plan(State, Transforms, factor, DxOf, dyn, owned, bounded, uns,
                useSpreadWidth ? WidthOf : null);
        }

        // WS-crisp2: plan with the textured-occluder drawn-art extents + transparent HOLES the controller feeds the
        // planner (null ⇒ the pre-crisp2 full-layout-rect blocker boxes with no hole exemption).
        public CardLayerPlan PlanArt(Dictionary<string, DesignAabb>? art, Dictionary<string, DesignAabb>? holes)
        {
            Transforms.Update(State);
            Planner.RebuildIndex(State);
            return Planner.Plan(State, Transforms, 1.0, DxOf, Empty, Empty, Empty, Empty, null, art, holes);
        }

        public (HashSet<string> Demote, HashSet<string> Rebuild, HashSet<string> Churn) Demotions(
            CardLayerPlan plan, string? changed = null, MirrorTweenHint[]? hints = null, string? dynamic = null,
            string? unsettled = null)
        {
            Transforms.Update(State);
            var changedSet = changed is null ? Empty : new HashSet<string>(System.StringComparer.Ordinal) { changed };
            var dyn = dynamic is null ? Empty : new HashSet<string>(System.StringComparer.Ordinal) { dynamic };
            var uns = unsettled is null ? Empty : new HashSet<string>(System.StringComparer.Ordinal) { unsettled };
            var demote = new HashSet<string>(System.StringComparer.Ordinal);
            var rebuild = new HashSet<string>(System.StringComparer.Ordinal);
            var churn = new HashSet<string>(System.StringComparer.Ordinal);
            Planner.CollectDemotions(
                State, Transforms, 1.0, DxOf, plan.Clusters, changedSet,
                hints ?? System.Array.Empty<MirrorTweenHint>(), dyn, Empty, demote, rebuild, churn, uns);
            return (demote, rebuild, churn);
        }

        private double DxOf(string id) => SpreadDx.TryGetValue(id, out var d) ? d : 0;

        private double WidthOf(string id) => SpreadWidth.TryGetValue(id, out var w) ? w : 0;

        private static readonly HashSet<string> Empty = new(System.StringComparer.Ordinal);
    }
}
