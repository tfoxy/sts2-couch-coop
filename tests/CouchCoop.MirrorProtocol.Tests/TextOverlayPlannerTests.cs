using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for the Track-B text-overlay planner (pure eligibility + paint-order occlusion math). Covers: the
// per-reason eligibility rejects, the paint-key model (a label is never blocked by its own descendants; a later
// sibling blocks; the ancestor/descendant text tiebreak + key-ordered output), the occlusion gate (overlap /
// non-overlap, unknown-bounds suffix bail, z-order-agnostic block, the reverse-pass "a demoted later label blocks an
// earlier one" dependency), the wide-screen Dx shift, the per-drain CollectDemotions guard (changed-overlap,
// revalidation, swept-AABB tween, opacity-hint, and the conservatism ⊇ full-re-Plan invariant), and the effective-
// modulate chain product.
internal static class TextOverlayPlannerTests
{
    public static void Run()
    {
        // eligibility
        RejectsBlendChain();
        RejectsClipAncestor();
        AllowsSelfClip();
        RejectsUnknownBounds();
        RejectsOffscreen();
        RejectsInvisibleChain();
        PromotesPlainStaticLabel();

        // paint-key model
        DescendantNeverBlocksOwnLabel();
        LaterSiblingBlocks();
        NonOverlappingSiblingPromotes();
        AncestorDescendantTiebreakAndOrder();

        // occlusion
        UnknownBoundsSuffixBail();
        ZOrderAgnosticBlocks();
        DemotedLaterTextBlocksEarlier();
        PromotedLaterTextDoesNotBlockEarlier();
        EffectPainterDoesNotOcclude();
        TransparentFillDoesNotOcclude();
        InvisibleAncestorPainterDoesNotOcclude();

        // blocker geometry (occluder side)
        TextureBlockerUsesTightArtNoTextSlack();
        TextureRegionLetterboxTightensBlocker();
        DemotedTextBlockerKeepsTextSlack();

        // spread
        SpreadDxShiftsBoxIntoOccluder();

        // demotions
        DemotionChangedOverlap();
        DemotionRevalidationRebuildVsDemote();
        DemotionSweptTweenAabb();
        DemotionConservativeSupersetOfReplan();
        DemotionConservativeSupersetWithTightBlocker();

        // measured text extents (Track E)
        MeasuredBoxOverridesSlack();
        MissingMeasurementFallsBack();
        MeasuredBlockerSymmetric();
        MeasuredAlignmentAwarePosition();
        MeasuredDemotionUsesMeasuredEligibilityBox();
        MeasuredDemotionConservativeSupersetOfReplan();

        // tracked candidates and card-subtree exclusion
        TrackedDynamicChainPromotes();
        TrackedDynamicStillOccludedByPanel();
        TrackedChainHintDoesNotDemote();
        TrackedNewOccluderStillDemotes();
        TrackedOccluderSweptStillDemotes();
        TrackedOwnChainSweptDoesNotDemote();
        TrackedDemotionConservativeSupersetOfReplan();
        CardOwnedLabelRejected();
        CardOwnedNotExcludedWhenFlagOff();

        // z-band paint order
        ZBandPromotesNegativeBandLabel();
        ZBandPositiveBandLabelOverZeroArt();
        ZBandNegativeBandLabelUnderZeroArtOccluded();
        ZBandSameBandPreOrderTiebreak();
        ZBandShowBehindParentChainStillRejected();
        ZBandShowBehindParentPainterStillBlocksAgnostically();
        ZBandHigherBandPainterEarlierInPreOrderOccludes();
        ZBandDemotionRevalidationAcceptsZChain();

        // modulate
        EffectiveModulateChainProduct();

        // WS-CRISP R17 fade-in text (tween-owned reveal promotes at the start of its fade, not after settle)
        FadeInNoOverridePinnedInvisible();
        FadeInEndpointOnePromotes();
        FadeInEndpointZeroStillInvisible();
        FadeInOwnNodePinNotPromoted();
        FadeInDemotionRevalidationKeepsRebuild();
        FadeInEffectiveModulateOverrideProduct();

        // Current card, clipping, shader, geometry, and demotion behavior
        CurrentCardOwnedDeclinedRootFallsThrough();
        CurrentCardOwnedPromotedRootStillRejected();
        CurrentCardOwnedUnknownRootStillRejected();
        CurrentClipContainsPromotes();
        CurrentClipPartialContainmentStillRejects();
        CurrentClipWidenedAncestorContainsLastColumn();
        CurrentAncestorShaderPromotes();
        CurrentAncestorSpineStillRejects();
        CurrentSelfShaderStillRejects();
        CurrentMeasuredGrazeToleratesShallowOverlap();
        CurrentMeasuredDeepOverlapStillOccludes();
        CurrentUnmeasuredCandidateKeepsFullConservatism();
        CurrentBlockerArtExtentsTightenOccluder();
        CurrentBlockerArtHoleClearsContainedLabel();
        CurrentBlockerArtHoleIgnoredForDynamicBlocker();
        CurrentClipAncestorChangeDemotes();
        CurrentDemotionRevalidationUsesEligibility();

        // WS-EVENTTEXT #14 Leg B (ancient-event option occlusion by the full-screen name banner) — geometry captured
        // from a LIVE Half-scale replay of the initial Neow ancient event (audit-mprun.ndjson).
        CurrentTextBlockerExtentTightensNeowBanner();
        CurrentTextBlockerExtentAbsentKeepsFullWidth();
        CurrentTextBlockerExtentByteIdenticalForFullWidthEntry();
        CurrentTextBlockerExtentNeowUnderProductionOcclusion();
    }

    // ---- eligibility --------------------------------------------------------------------------------------------


    private static void RejectsBlendChain()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var lbl = h.AddLabel("lbl", "root", 10, 10, 100, 40);
        lbl.CanvasBlendMode = 1; // additive
        Check.That(!h.PlanNow().HasAny, "label with a non-Mix blend is not promoted");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Blend), 1, "one Blend reject");
    }

    private static void RejectsClipAncestor()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var clip = h.AddGroup("clip", "root", 0, 0, 400, 400);
        clip.ClipChildren = 1;
        h.AddLabel("lbl", "clip", 10, 10, 100, 40);
        Check.That(!h.PlanNow().HasAny, "label extending beyond a clip ancestor is not promoted");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Clip), 1, "one Clip reject");
    }

    private static void AllowsSelfClip()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var lbl = h.AddLabel("lbl", "root", 10, 10, 100, 40);
        lbl.ClipChildren = 1; // the label clipping its OWN (non-existent view) children is fine — text isn't a child view
        Check.That(h.PlanNow().HasAny, "a label that self-clips is still promotable");
    }


    private static void RejectsUnknownBounds()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var lbl = h.AddLabel("lbl", "root", 0, 0, 0, 0);
        lbl.LocalRect = null; // no box
        Check.That(!h.PlanNow().HasAny, "label with no box is not promoted");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.UnknownBounds), 1, "one UnknownBounds reject");
    }

    private static void RejectsOffscreen()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 5000, 5000, 100, 40);
        Check.That(!h.PlanNow().HasAny, "off-screen label is not promoted");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Offscreen), 1, "one Offscreen reject");
    }

    private static void RejectsInvisibleChain()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var mid = h.AddGroup("mid", "root", 0, 0, 400, 400);
        mid.Visible = false;
        h.AddLabel("lbl", "mid", 10, 10, 100, 40);
        Check.That(!h.PlanNow().HasAny, "label under an invisible ancestor is not promoted");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Invisible), 1, "one Invisible reject");
    }

    private static void PromotesPlainStaticLabel()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 10, 10, 100, 40);
        var plan = h.PlanNow();
        Check.That(plan.HasAny, "a plain static on-screen label is promoted");
        Check.Equal(plan.Items.Count, 1, "one promoted label");
        Check.Equal(plan.Items[0].Id, "lbl", "the label id");
    }

    // ---- paint-key model ----------------------------------------------------------------------------------------

    private static void DescendantNeverBlocksOwnLabel()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var lbl = h.AddLabel("lbl", "root", 0, 0, 200, 200);
        // a painting CHILD inside the label's subtree, fully overlapping — it paints BEFORE the label's text.
        h.AddRect("child", "lbl", 0, 0, 200, 200);
        Check.That(h.PlanNow().HasAny, "a label is not blocked by its own descendant painters");
    }

    private static void LaterSiblingBlocks()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("cover", "root", 0, 0, 100, 100); // later sibling, overlapping → blocks
        Check.That(!h.PlanNow().HasAny, "a later overlapping sibling blocks the label");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Occluded), 1, "one Occluded reject");
    }

    private static void NonOverlappingSiblingPromotes()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("far", "root", 800, 800, 100, 100); // later sibling, NO overlap
        Check.That(h.PlanNow().HasAny, "a non-overlapping later sibling does not block");
    }

    private static void AncestorDescendantTiebreakAndOrder()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("anc", "root", 0, 0, 200, 200);   // ancestor label
        h.AddLabel("desc", "anc", 0, 0, 100, 100);   // descendant label, overlapping
        var plan = h.PlanNow();
        Check.Equal(plan.Items.Count, 2, "both nested labels promote");
        // Ascending paint key: descendant text paints first (under), ancestor text last (on top).
        Check.Equal(plan.Items[0].Id, "desc", "descendant emitted first (lower paint key)");
        Check.Equal(plan.Items[1].Id, "anc", "ancestor emitted last (higher paint key = on top)");
        Check.That(plan.Items[0].PaintKey < plan.Items[1].PaintKey, "key-ordered output ascending");
    }

    // ---- occlusion ----------------------------------------------------------------------------------------------

    private static void UnknownBoundsSuffixBail()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        // a LATER painter with no box (unknown bounds) → blocks ALL earlier labels (suffix bail).
        var blob = h.AddGroup("blob", "root", 0, 0, 0, 0);
        blob.LocalRect = null;
        blob.TextureUrl = "res://x.png";
        Check.That(!h.PlanNow().HasAny, "an unknown-bounds later painter suffix-bails all earlier labels");
    }

    private static void ZOrderAgnosticBlocks()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        // a z-index painter placed EARLIER in DFS order than the label — normally its paint key would be lower, but
        // z-order is order-agnostic, so it blocks regardless.
        var z = h.AddRect("z", "root", 0, 0, 100, 100);
        z.ZIndex = 5;
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        Check.That(!h.PlanNow().HasAny, "an order-agnostic (z-index) painter blocks even an ANCHOR that paints later");
    }

    private static void DemotedLaterTextBlocksEarlier()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("early", "root", 0, 0, 100, 100);
        var late = h.AddLabel("late", "root", 0, 0, 100, 100); // later, overlapping, but in-stage raster covers
        late.ShaderId = "res://text.gdshader";
        var plan = h.PlanNow();
        Check.That(!Contains(plan, "early"), "an earlier label is blocked by a later NON-promoted (in-stage) text label");
        Check.That(!Contains(plan, "late"), "the effect-bearing later label is itself not promoted");
    }

    private static void PromotedLaterTextDoesNotBlockEarlier()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("early", "root", 0, 0, 100, 100);
        h.AddLabel("late", "root", 0, 0, 100, 100); // later, overlapping, but PROMOTED → both compose in the overlay
        var plan = h.PlanNow();
        Check.Equal(plan.Items.Count, 2, "two overlapping promoted labels both survive");
        Check.That(Contains(plan, "early") && Contains(plan, "late"), "a promoted later label does not block the earlier one");
    }

    private static void EffectPainterDoesNotOcclude()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        var fx = h.AddRect("fx", "root", 0, 0, 100, 100); // later, fully overlapping
        fx.ShaderId = "res://x.gdshader"; // a shader's rendered alpha is unknowable (a fade may be transparent) → not a blocker
        Check.That(Contains(h.PlanNow(), "lbl"), "a later shader-painted rect does not occlude the label");
    }

    private static void TransparentFillDoesNotOcclude()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        var t = h.AddGroup("t", "root", 0, 0, 100, 100);
        t.FillColor = new MirrorColor(0, 0, 0, 0.0, "#00000000"); // alpha-0 layout rect → covers nothing
        Check.That(Contains(h.PlanNow(), "lbl"), "an alpha-0 fill does not occlude");
    }

    private static void InvisibleAncestorPainterDoesNotOcclude()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        var overlay = h.AddGroup("overlay", "root", 0, 0, 1920, 1080);
        overlay.Visible = false; // an inactive full-screen overlay
        h.AddRect("dimmer", "overlay", 0, 0, 1920, 1080); // an opaque dimmer, but its ancestor is hidden → paints nothing
        Check.That(Contains(h.PlanNow(), "lbl"), "a dimmer under an invisible ancestor does not occlude");
    }

    // ---- blocker geometry (occluder side) ----------------------------------------------------------------------

    private static void TextureBlockerUsesTightArtNoTextSlack()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        // A textured occluder painted later sits to the right of the label with a 40px real gap. Its tight drawn-art
        // box has no text slack, so the gap survives and the label promotes.
        h.AddTextureRect("gem", "root", 140, 0, 50, 50);
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "a textured occluder no longer phantom-occludes a label across a real gap");
    }

    private static void TextureRegionLetterboxTightensBlocker()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 110, 100, 15); // a label BELOW where the letterboxed art ends
        // A 100×100 textured rect drawn KeepAspectCentered (stretch 5) from a WIDE 100×40 region: the art is scaled to
        // fit keeping aspect and centered → drawn only across y∈[30,70]. The label at y110 clears the drawn art, but
        // the FULL layout rect (y 0..100) would have covered it. Letterbox tightening promotes the label.
        h.AddTextureRect("banner", "root", 0, 0, 100, 100, new MirrorRect(0, 0, 100, 40), stretch: 5);
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "a KeepAspectCentered blocker is letterbox-tightened to its drawn art");

        // Sanity: a label INSIDE the letterboxed art band (y40) is still occluded.
        var h2 = new Harness();
        h2.AddGroup("root", null, 0, 0, 1920, 1080);
        h2.AddLabel("lbl", "root", 0, 40, 100, 15);
        h2.AddTextureRect("banner", "root", 0, 0, 100, 100, new MirrorRect(0, 0, 100, 40), stretch: 5);
        Check.That(!Contains(h2.PlanNow(), "lbl"), "a label under the letterboxed art band is still occluded");
    }

    private static void DemotedTextBlockerKeepsTextSlack()
    {
        // A demoted (in-stage) TEXT label still blocks earlier labels with its FULL padded box (a font can overflow its
        // rect), unlike a texture occluder — so the paint-order dependency is unchanged for text-vs-text.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("early", "root", 0, 0, 100, 40);
        var late = h.AddLabel("late", "root", 110, 0, 40, 40); // later, in-stage, 10px real gap
        late.ShaderId = "res://text.gdshader";
        var plan = h.PlanNow();
        Check.That(!Contains(plan, "early"), "a demoted text blocker keeps its text-slack halo and blocks the earlier label");
    }


    // ---- spread -------------------------------------------------------------------------------------------------

    private static void SpreadDxShiftsBoxIntoOccluder()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("cover", "root", 400, 0, 100, 100); // later painter far to the right — no overlap at rest

        Check.That(h.PlanNow().HasAny, "at F=1 the label is clear of the right-side painter");

        // At F≠1 slide ONLY the label right by 400 (its cumulative Dx) so its rendered box lands under 'cover'.
        h.SpreadDx["lbl"] = 400;
        var plan = h.PlanNow(factor: 1.5);
        Check.That(!plan.HasAny, "the wide-screen Dx shift slides the label under the occluder → demoted");
    }

    // ---- CollectDemotions ---------------------------------------------------------------------------------------

    private static void DemotionChangedOverlap()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("panel", "root", 800, 0, 100, 100); // far away initially
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "label promoted while the panel is clear");

        // The panel moves over the label (a changed painter overlapping a promoted label).
        h.Node("panel").LocalRect = new MirrorRect(0, 0, 100, 100);
        var (demote, rebuild) = h.Demotions(plan, changed: "panel");
        Check.That(demote.Contains("lbl"), "a changed painter now overlapping a promoted label demotes it");
        Check.That(!rebuild.Contains("lbl"), "not a rebuild — a demote");
    }

    private static void DemotionRevalidationRebuildVsDemote()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        var plan = h.PlanNow();

        // The promoted label's own content changed but it stays eligible → REBUILD in place (crisp HP counter).
        var (demote1, rebuild1) = h.Demotions(plan, changed: "lbl");
        Check.That(rebuild1.Contains("lbl") && !demote1.Contains("lbl"), "a changed-but-still-eligible promoted label rebuilds");

        // Now the label gains a shader → ineligible → the revalidation demotes it.
        h.Node("lbl").ShaderId = "res://x.gdshader";
        var (demote2, _) = h.Demotions(plan, changed: "lbl");
        Check.That(demote2.Contains("lbl"), "a changed promoted label that became ineligible is demoted");
    }

    private static void DemotionSweptTweenAabb()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        var mover = h.AddRect("mover", "root", 800, 0, 100, 100); // far right, currently no overlap
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "label promoted while the mover is far");

        // A transform tween sweeps 'mover' left by 800 px (its endpoint translation) so its swept box (current rect at
        // x=800 ∪ the endpoint box at x=0) crosses the label even though the CURRENT rect does not overlap.
        var hint = new MirrorTweenHint("mover", "transform", null, 300, null, null,
            EndTransform: new double[] { 1, 0, 0, 1, -800, 0 }, EndOpacity: null, Group: null,
            StartTransform: null, StartOpacity: null);
        var (demote, _) = h.Demotions(plan, hints: new[] { hint });
        Check.That(demote.Contains("lbl"), "a transform tween whose swept AABB crosses the label demotes it");
    }


    private static void DemotionConservativeSupersetWithTightBlocker()
    {
        // The conservatism invariant must hold with the tight-blocker plan too: a textured panel slid fully over a
        // promoted label makes a fresh (tight-blocker) Plan reject it, and CollectDemotions (rule 3, padded) must still
        // be a superset — it demotes.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddTextureRect("panel", "root", 800, 0, 100, 100);
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "promoted while the textured panel is far");

        h.Node("panel").LocalRect = new MirrorRect(0, 0, 100, 100); // slide fully over the label
        var replan = h.PlanNow();
        var (demote, _) = h.Demotions(plan, changed: "panel");
        Check.That(!Contains(replan, "lbl"), "the tight-blocker re-Plan rejects the label");
        Check.That(demote.Contains("lbl"), "CollectDemotions still demotes it (superset of the tight-blocker re-Plan)");
    }

    private static void DemotionConservativeSupersetOfReplan()
    {
        // A fresh Plan after a change rejects the label (a new occluder) → CollectDemotions MUST also demote it.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("panel", "root", 800, 0, 100, 100);
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "promoted at rest");

        // Move the panel over the label, then compute BOTH a full re-Plan and CollectDemotions.
        h.Node("panel").LocalRect = new MirrorRect(0, 0, 100, 100);
        var replan = h.PlanNow();
        var (demote, _) = h.Demotions(plan, changed: "panel");
        // The full re-plan now rejects 'lbl'; the demotion guard must be a superset.
        bool replanRejects = !Contains(replan, "lbl");
        Check.That(replanRejects, "the full re-Plan now rejects the label");
        Check.That(demote.Contains("lbl"), "CollectDemotions demotes a superset of what a full re-Plan rejects");
    }

    // ---- measured text extents (Track E) ------------------------------------------------------------------------

    private static void MeasuredBoxOverridesSlack()
    {
        // The headline case. A left-aligned counter whose glyphs occupy only the LEFT of its rect; an icon sits just
        // past the rect's right edge. The blanket rect+24 halo (label rect [0..100] → padded maxX 124) phantom-reaches
        // the icon at x=110 and demotes the label though nothing covers a glyph. The MEASURED glyph box [0..20] + 4
        // clears the icon → the label promotes. (MissingMeasurementFallsBack below is the same scene with NO measurement.)
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        h.AddTextureRect("icon", "root", 110, 0, 40, 40); // later opaque painter, 10px past the label's real rect
        h.SetMeasured("lbl", 0, 0, 20, 30);               // glyphs on the left only
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "a measured glyph box clears an adjacent icon the phantom slack would have hit");
        Check.Equal(h.Planner.LastMeasured, 1, "the measured-box telemetry counts this label");
    }

    private static void MissingMeasurementFallsBack()
    {
        // Same geometry as MeasuredBoxOverridesSlack, but NO measurement supplied → the planner uses the rect+24 guess,
        // whose right pad reaches the icon → the label is (phantom-)occluded. Proves the fallback is the old behavior
        // (a conservative superset), so a missing/stale measurement is never LESS safe than before.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        h.AddTextureRect("icon", "root", 110, 0, 40, 40);
        var plan = h.PlanNow(); // Measured is empty → MeasuredArg is null
        Check.That(!Contains(plan, "lbl"), "with no measurement the rect+24 halo still phantom-occludes (old behavior)");
        Check.Equal(h.Planner.LastMeasured, 0, "no label used a measurement");
    }

    private static void MeasuredBlockerSymmetric()
    {
        // The measured box must apply to a label's BLOCKER role too. 'late' is a demoted (in-stage) text label 10px past
        // 'early'; with rect+24 both pad boxes overlap and 'late' blocks 'early' (see DemotedTextBlockerKeepsTextSlack).
        // With MEASURED boxes (glyphs on the left of each rect) the tight boxes clear the gap → 'early' promotes.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("early", "root", 0, 0, 100, 40);
        var late = h.AddLabel("late", "root", 110, 0, 100, 40);
        late.ShaderId = "res://text.gdshader";
        h.SetMeasured("early", 0, 0, 20, 30);
        h.SetMeasured("late", 110, 0, 130, 30);
        var plan = h.PlanNow(); // 'late' is an in-stage blocker using its measured label box
        Check.That(Contains(plan, "early"), "a demoted text blocker's MEASURED box no longer bridges the gap to 'early'");
        Check.That(!Contains(plan, "late"), "the effect-bearing later label is itself not promoted");

        // Control: drop the measurements → the rect+24 blocker halo bridges the 10px gap and blocks 'early' again.
        var h2 = new Harness();
        h2.AddGroup("root", null, 0, 0, 1920, 1080);
        h2.AddLabel("early", "root", 0, 0, 100, 40);
        var late2 = h2.AddLabel("late", "root", 110, 0, 100, 40);
        late2.ShaderId = "res://text.gdshader";
        Check.That(!Contains(h2.PlanNow(), "early"), "without measurement the demoted-text slack still blocks");
    }

    private static void MeasuredAlignmentAwarePosition()
    {
        // A RIGHT-aligned label's glyphs sit at the right of its 200px rect. The measured box must reflect that POSITION,
        // not merely a symmetric shrink: an occluder over the LEFT of the rect (where left/centre glyphs would be) must
        // NOT block it, while an occluder over the RIGHT (the real glyphs) MUST. Proves position, not just size.
        MirrorNode Build(Harness hh, double iconX)
        {
            hh.AddGroup("root", null, 0, 0, 1920, 1080);
            hh.AddLabel("lbl", "root", 0, 0, 200, 40);
            hh.SetMeasured("lbl", 180, 0, 200, 30); // glyphs right-aligned
            return hh.AddTextureRect("icon", "root", iconX, 0, 40, 40);
        }

        var left = new Harness();
        Build(left, iconX: 0); // icon over the LEFT of the rect — clear of the right-aligned glyphs
        Check.That(Contains(left.PlanNow(), "lbl"), "a left-side icon clears a right-aligned label's measured glyph box");

        var right = new Harness();
        Build(right, iconX: 180); // icon over the RIGHT — on top of the real glyphs
        Check.That(!Contains(right.PlanNow(), "lbl"), "a right-side icon over the real glyphs still occludes");
    }

    private static void MeasuredDemotionUsesMeasuredEligibilityBox()
    {
        // CollectDemotions rule 1 must revalidate with the SAME box source as Plan. A promoted label whose MEASURED box
        // is then offscreen (a fresh Plan would reject it Offscreen) must be DEMOTED, not rebuilt — proving the demotion
        // guard reads the measured box, not the (still on-screen) streamed rect. The contrast case (measured on-screen)
        // rebuilds.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        h.SetMeasured("lbl", 0, 0, 60, 30);
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "promoted with an on-screen measured box");

        // The label's content changed and its measured box is now fully off-screen.
        // rejects Offscreen → demote.
        h.SetMeasured("lbl", 5000, 5000, 5100, 5100);
        var (demoteOff, rebuildOff) = h.Demotions(plan, changed: "lbl");
        Check.That(demoteOff.Contains("lbl") && !rebuildOff.Contains("lbl"),
            "an off-screen measured box demotes the promoted label using measured eligibility");

        // Contrast: an on-screen measured box on the same change → still eligible → rebuild in place.
        h.SetMeasured("lbl", 0, 0, 60, 30);
        var (demoteOn, rebuildOn) = h.Demotions(plan, changed: "lbl");
        Check.That(rebuildOn.Contains("lbl") && !demoteOn.Contains("lbl"),
            "an on-screen measured box rebuilds (still eligible)");
    }

    private static void MeasuredDemotionConservativeSupersetOfReplan()
    {
        // The locked conservatism invariant, extended to the measured path: measured boxes feed BOTH Plan and
        // CollectDemotions. A textured panel slid over the label's measured glyph box makes a fresh (measured) Plan
        // reject it; CollectDemotions must be a superset → it demotes.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        h.AddTextureRect("panel", "root", 800, 0, 100, 100);
        h.SetMeasured("lbl", 0, 0, 60, 30);
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "promoted (measured) while the panel is far");

        h.Node("panel").LocalRect = new MirrorRect(0, 0, 100, 100); // slide fully over the measured glyph box
        var replan = h.PlanNow();
        var (demote, _) = h.Demotions(plan, changed: "panel");
        Check.That(!Contains(replan, "lbl"), "the measured-path re-Plan rejects the label");
        Check.That(demote.Contains("lbl"), "CollectDemotions demotes a superset of what the measured re-Plan rejects");
    }

    // ---- tracked candidates and card ownership -----------------------------------------------------------------

    private static void TrackedDynamicChainPromotes()
    {
        // The controller's per-frame proxy sync tracks the candidate chain.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddGroup("mid", "root", 0, 0, 400, 400);
        h.AddLabel("lbl", "mid", 10, 10, 100, 40);
        Check.That(h.PlanNow(dynamic: "mid").HasAny,
            "a dynamic ancestor remains promotable");
    }

    private static void TrackedDynamicStillOccludedByPanel()
    {
        // A dynamic label covered by a later opaque panel remains occluded.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("cover", "root", 0, 0, 100, 100); // later opaque painter fully over the (dynamic) label
        var plan = h.PlanNow(dynamic: "lbl");
        Check.That(!Contains(plan, "lbl"), "a dynamic label covered by a later panel remains occluded");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Occluded), 1,
            "the reject is Occluded (the panel), not Dynamic");
    }

    private static void TrackedChainHintDoesNotDemote()
    {
        // The per-frame sync tracks opacity changes on the label's own chain.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddGroup("mid", "root", 0, 0, 400, 400);
        h.AddLabel("lbl", "mid", 0, 0, 100, 100);
        var plan = h.PlanNow();
        var hint = new MirrorTweenHint("mid", "modulate:a", null, 300, null, null,
            EndTransform: null, EndOpacity: 0.0, Group: null, StartTransform: null, StartOpacity: null);
        var (demote, _) = h.Demotions(plan, hints: new[] { hint });
        Check.That(!demote.Contains("lbl"), "an own-chain fade does not demote the tracked proxy");
    }

    private static void TrackedNewOccluderStillDemotes()
    {
        // A changed non-chain painter that overlaps a promoted label still demotes it.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("panel", "root", 800, 0, 100, 100);
        var plan = h.PlanNow();
        h.Node("panel").LocalRect = new MirrorRect(0, 0, 100, 100);
        var (demote, _) = h.Demotions(plan, changed: "panel");
        Check.That(demote.Contains("lbl"), "a new occluder still demotes");
    }

    private static void TrackedOccluderSweptStillDemotes()
    {
        // A moving occluder's swept box still demotes.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("mover", "root", 800, 0, 100, 100);
        var plan = h.PlanNow();
        var hint = new MirrorTweenHint("mover", "transform", null, 300, null, null,
            EndTransform: new double[] { 1, 0, 0, 1, -800, 0 }, EndOpacity: null, Group: null,
            StartTransform: null, StartOpacity: null);
        var (demote, _) = h.Demotions(plan, hints: new[] { hint });
        Check.That(demote.Contains("lbl"), "a moving occluder's swept box still demotes");
    }

    private static void TrackedOwnChainSweptDoesNotDemote()
    {
        // A transform hint on the label's own ancestor is tracked by the per-frame sync.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddGroup("mid", "root", 0, 0, 200, 200);
        h.AddLabel("lbl", "mid", 0, 0, 100, 100);
        var plan = h.PlanNow();
        // A big self-move of the label's ancestor 'mid' whose swept box obviously crosses the label's current box.
        var hint = new MirrorTweenHint("mid", "transform", null, 300, null, null,
            EndTransform: new double[] { 1, 0, 0, 1, 50, 50 }, EndOpacity: null, Group: null,
            StartTransform: null, StartOpacity: null);
        var (demote, _) = h.Demotions(plan, hints: new[] { hint });
        Check.That(!demote.Contains("lbl"), "an own-chain swept box does not demote the tracked proxy");
    }

    private static void TrackedDemotionConservativeSupersetOfReplan()
    {
        // A fresh plan after a panel moves over the label rejects it, and CollectDemotions is a superset.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        h.AddRect("panel", "root", 800, 0, 100, 100);
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "promoted at rest");
        h.Node("panel").LocalRect = new MirrorRect(0, 0, 100, 100);
        var replan = h.PlanNow();
        var (demote, _) = h.Demotions(plan, changed: "panel");
        Check.That(!Contains(replan, "lbl"), "the re-plan now rejects the label");
        Check.That(demote.Contains("lbl"), "CollectDemotions demotes a superset of the re-plan");
    }

    private static void CardOwnedLabelRejected()
    {
        // When the CardLayer is active, its NCard-subtree labels are excluded from the text overlay (CardOwned) so a
        // freshly dealt card's own label is never double-promoted before the card layer claims it.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var card = h.AddGroup("card", "root", 100, 100, 200, 300);
        card.NodeType = "Godot.NCard";
        h.AddLabel("title", "card", 110, 110, 180, 40);
        Check.That(h.PlanNow().HasAny, "with excludeCards false the card label promotes normally");
        Check.That(!h.PlanNow(excludeCards: true).HasAny, "an NCard-subtree label is excluded as CardOwned");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.CardOwned), 1,
            "one CardOwned reject");
    }

    private static void CardOwnedNotExcludedWhenFlagOff()
    {
        // A non-card label is untouched by the excludeCards flag (it only rejects NCard-subtree labels).
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("hp", "root", 10, 10, 100, 40);
        Check.That(h.PlanNow(excludeCards: true).HasAny, "a non-card label is unaffected by excludeCards");
    }

    // ---- z-band paint order ------------------------------------------------------------------------------------

    private static void ZBandPromotesNegativeBandLabel()
    {
        // A label under a z=-10 group with no overlapping z=0 art is ordered by its effective paint key.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var band = h.AddGroup("band", "root", 0, 0, 1920, 1080); // the CombatSceneContainer analogue
        band.ZIndex = -10;
        h.AddLabel("hp", "band", 300, 700, 240, 31);
        h.AddRect("ui", "root", 1700, 0, 200, 80); // z=0 UI far away — paints after the band but no overlap
        var plan = h.PlanNow();
        Check.That(Contains(plan, "hp"), "the z=-10 band label promotes when nothing overlaps it");
    }

    private static void ZBandPositiveBandLabelOverZeroArt()
    {
        // A label on a z=+1 chain overlapping z=0 art that comes LATER in pre-order. The pre-order model would have
        // the art paint after (over) the label; the z-aware order puts the +1 band after ALL z=0 → the label paints
        // on top and promotes.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var band = h.AddGroup("band", "root", 0, 0, 400, 400);
        band.ZIndex = 1;
        h.AddLabel("lbl", "band", 0, 0, 100, 40);
        h.AddRect("art", "root", 0, 0, 200, 200); // later pre-order, z=0, fully overlapping
        var plan = h.PlanNow();
        Check.That(Contains(plan, "lbl"), "a z=+1 label paints OVER later z=0 art → promotes");
    }

    private static void ZBandNegativeBandLabelUnderZeroArtOccluded()
    {
        // The anti-floater: a z=-1 label whose box lies UNDER overlapping z=0 opaque art painted EARLIER in pre-order.
        // The z-aware order puts the art's band after the label's → the art covers it → Occluded (NOT promoted; a
        // promotion would float crisp text over the covering art).
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddRect("art", "root", 0, 0, 200, 200); // EARLIER pre-order, z=0
        var band = h.AddGroup("band", "root", 0, 0, 400, 400);
        band.ZIndex = -1;
        h.AddLabel("lbl", "band", 0, 0, 100, 40); // later pre-order but LOWER band → paints under the art
        var plan = h.PlanNow();
        Check.That(!Contains(plan, "lbl"), "a z=-1 label under overlapping z=0 art must NOT promote");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Occluded), 1,
            "the reject is Occluded (the z-aware order placed the art above)");
    }

    private static void ZBandSameBandPreOrderTiebreak()
    {
        // Within one z band the paint order is pre-order (Godot's stable tiebreak): a LATER same-band sibling still
        // blocks an earlier label; a non-overlapping one does not.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var band = h.AddGroup("band", "root", 0, 0, 1920, 1080);
        band.ZIndex = -5;
        h.AddLabel("lbl", "band", 0, 0, 100, 100);
        h.AddRect("cover", "band", 0, 0, 100, 100); // later sibling, same band, overlapping
        var plan = h.PlanNow();
        Check.That(!Contains(plan, "lbl"), "a later same-band sibling still blocks (pre-order tiebreak intra-band)");

        var h2 = new Harness();
        h2.AddGroup("root", null, 0, 0, 1920, 1080);
        var band2 = h2.AddGroup("band", "root", 0, 0, 1920, 1080);
        band2.ZIndex = -5;
        h2.AddLabel("lbl", "band", 0, 0, 100, 100);
        h2.AddRect("far", "band", 800, 800, 100, 100); // later sibling, same band, NO overlap
        Check.That(Contains(h2.PlanNow(), "lbl"), "a non-overlapping same-band sibling does not block");
    }

    private static void ZBandShowBehindParentChainStillRejected()
    {
        // ShowBehindParent stays conservative because the effective-Z model can't reorder an intra-tree
        // behind-parent flip, so a chain with it is still ZOrder-rejected.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var mid = h.AddGroup("mid", "root", 0, 0, 400, 400);
        mid.ShowBehindParent = true;
        h.AddLabel("lbl", "mid", 10, 10, 100, 40);
        Check.That(!h.PlanNow().HasAny, "a ShowBehindParent chain is still rejected");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.ZOrder), 1,
            "one ZOrder reject (ShowBehindParent)");
    }

    private static void ZBandShowBehindParentPainterStillBlocksAgnostically()
    {
        // A ShowBehindParent PAINTER's true paint position is unrepresentable in the effZ model → it must keep
        // blocking order-agnostically (never a float over it).
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var shb = h.AddRect("shb", "root", 0, 0, 100, 100); // EARLIER pre-order — ordered model would paint it first
        shb.ShowBehindParent = true;
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        Check.That(!Contains(h.PlanNow(), "lbl"),
            "a ShowBehindParent painter still blocks agnostically");
    }


    private static void ZBandHigherBandPainterEarlierInPreOrderOccludes()
    {
        // The old order-agnostic case, now ORDERED: a z=+5 opaque painter EARLIER in pre-order than the label sorts
        // into a later band → still occludes the overlapping z=0 label through paint ordering.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var z = h.AddRect("z", "root", 0, 0, 100, 100);
        z.ZIndex = 5;
        h.AddLabel("lbl", "root", 0, 0, 100, 100);
        Check.That(!Contains(h.PlanNow(), "lbl"), "a higher-band earlier painter still occludes (ordered)");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Occluded), 1,
            "the reject is Occluded");
    }

    private static void ZBandDemotionRevalidationAcceptsZChain()
    {
        // CollectDemotions revalidates a changed-but-still-eligible z-band label with the same current policy.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var band = h.AddGroup("band", "root", 0, 0, 1920, 1080);
        band.ZIndex = -10;
        h.AddLabel("hp", "band", 300, 700, 240, 31);
        var plan = h.PlanNow();
        Check.That(Contains(plan, "hp"), "promoted in its z band");

        var (demoteOn, rebuildOn) = h.Demotions(plan, changed: "hp");
        Check.That(rebuildOn.Contains("hp") && !demoteOn.Contains("hp"),
            "a changed-but-eligible z-band label rebuilds in place");
    }

    private static void EffectiveModulateChainProduct()
    {
        var h = new Harness();
        var root = h.AddGroup("root", null, 0, 0, 1920, 1080);
        root.Modulate = new MirrorColor(1.0, 0.5, 0.5, 0.5, "#ff808080");
        var mid = h.AddGroup("mid", "root", 0, 0, 400, 400);
        mid.Modulate = new MirrorColor(0.5, 1.0, 0.5, 0.5, "#80ff8080");
        var leaf = h.AddLabel("leaf", "mid", 0, 0, 100, 100);
        leaf.Modulate = null; // no own modulate → white × opacity(1)

        var mod = TextOverlayPlanner.EffectiveModulate(h.State, "leaf");
        Check.Close(mod.R, 0.5, "R product = 1.0 × 0.5 × 1.0");
        Check.Close(mod.G, 0.5, "G product = 0.5 × 1.0 × 1.0");
        Check.Close(mod.B, 0.25, "B product = 0.5 × 0.5 × 1.0");
        Check.Close(mod.A, 0.25, "A product = 0.5 × 0.5 × 1.0");
    }

    // ---- WS-CRISP R17 fade-in text ------------------------------------------------------------------------------

    // The rest-site fixture: a focused-option DESCRIPTION label under a panel whose alpha the producer has PINNED at 0
    // for the whole tween-owned fade-in. Without the fade-in override the eligibility Invisible check reads that pin.
    private static (Harness H, MirrorNode Panel) FadeFixture(double panelAlpha = 0.0)
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var panel = h.AddGroup("panel", "root", 0, 0, 400, 400);
        panel.Modulate = new MirrorColor(1, 1, 1, panelAlpha, "#ffffff00"); // pinned ≈0 during the fade
        h.AddLabel("desc", "panel", 10, 10, 300, 40);
        return (h, panel);
    }

    private static System.Collections.Generic.Dictionary<string, double> Fade(string id, double endpoint) =>
        new(System.StringComparer.Ordinal) { [id] = endpoint };

    private static void FadeInNoOverridePinnedInvisible()
    {
        var (h, _) = FadeFixture();
        Check.That(!h.PlanNow().HasAny, "a label under a fade-pinned (α0) panel is Invisible-rejected with no override");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Invisible), 1, "one Invisible reject");
    }

    private static void FadeInEndpointOnePromotes()
    {
        var (h, _) = FadeFixture();
        // The tween's endpoint is a full reveal (1.0): the eligibility reads THAT instead of the pinned 0 → promotable.
        var plan = h.PlanNow(fadeIn: Fade("panel", 1.0));
        Check.That(plan.HasAny, "the label promotes at the start of its fade when the ancestor's reveal endpoint is fed");
        Check.Equal(plan.Items[0].Id, "desc", "the promoted label is the focused description");
    }

    private static void FadeInEndpointZeroStillInvisible()
    {
        var (h, _) = FadeFixture();
        // A degenerate/fade-OUT endpoint (0) leaves the effective alpha ≈0 → still Invisible (the override never lies
        // the label visible; CollectFadeInEndpoints only ever feeds endpoints > 0.05, so this is the safety leg).
        Check.That(!h.PlanNow(fadeIn: Fade("panel", 0.0)).HasAny, "a 0 endpoint keeps the label Invisible");
    }

    private static void FadeInOwnNodePinNotPromoted()
    {
        // Scope contract: R17 targets an ANCESTOR fade (the rest-site option container fading in carries the still-
        // opaque description). A label whose OWN modulate is pinned at 0 is filtered by the textBearing gate (OwnAlpha
        // ≈0) BEFORE eligibility, so the override cannot promote it — and it need not (its own in-stage alpha animates
        // live via the tween, so it renders mushy-but-visible, never MISSING). Both with and without an override.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var desc = h.AddLabel("desc", "root", 10, 10, 300, 40);
        desc.Modulate = new MirrorColor(1, 1, 1, 0.0, "#ffffff00"); // own alpha pinned at 0 mid-fade
        Check.That(!h.PlanNow().HasAny, "own-node fade pin: not promoted (filtered pre-eligibility)");
        Check.That(!h.PlanNow(fadeIn: Fade("desc", 1.0)).HasAny, "own-node pin stays unpromoted even with an override (ancestor-scoped fix)");
    }

    private static void FadeInDemotionRevalidationKeepsRebuild()
    {
        // Rule-1 (a changed promoted label re-runs eligibility): it must use the SAME fade-in override as Plan, so a
        // just-changed description under an active fade is REBUILT crisp, not demoted mushy. Mirrors the live controller
        // with the fading ancestor in the dynamically-excluded set.
        var (h, _) = FadeFixture();
        var fade = Fade("panel", 1.0);
        var plan = h.PlanNow(dynamic: "panel", fadeIn: fade);
        Check.That(plan.HasAny, "promoted under the fade override");

        var (demote, rebuild) = h.Demotions(plan, changed: "desc", dynamic: "panel", fadeIn: fade);
        Check.That(!demote.Contains("desc"), "a changed description under an active fade is NOT demoted (override fed)");
        Check.That(rebuild.Contains("desc"), "it is rebuilt in place (still eligible)");

        var (demoteNoOverride, _) = h.Demotions(plan, changed: "desc", dynamic: "panel");
        Check.That(demoteNoOverride.Contains("desc"), "without the override the same revalidation demotes (Invisible)");
    }

    private static void FadeInEffectiveModulateOverrideProduct()
    {
        var h = new Harness();
        var root = h.AddGroup("root", null, 0, 0, 1920, 1080);
        root.Modulate = new MirrorColor(1, 1, 1, 0.5, "#ffffff80");
        var panel = h.AddGroup("panel", "root", 0, 0, 400, 400);
        panel.Modulate = new MirrorColor(1, 1, 1, 0.0, "#ffffff00"); // pinned
        h.AddLabel("desc", "panel", 0, 0, 100, 40);

        Check.Close(TextOverlayPlanner.EffectiveModulate(h.State, "desc").A, 0.0, "plain product is pinned at 0");
        Check.Close(TextOverlayPlanner.EffectiveModulate(h.State, "desc", Fade("panel", 1.0)).A, 0.5,
            "the override substitutes the panel endpoint (0.5 root × 1.0 panel × 1.0 label)");
    }


    // ---- WS-CRISP options --------------------------------------------------------------------------------------------

    // Build a options options object the way the controller does (empty sets when not supplied).
    private static TextOverlayOptions Options(
        string[]? promotedRoots = null, string[]? knownRoots = null,
        (string Id, DesignAabb Box)[]? art = null, (string Id, DesignAabb Box)[]? holes = null,
        (string Id, DesignAabb Box)[]? textBlocker = null)
    {
        return new TextOverlayOptions
        {
            CardPromotedRoots = new HashSet<string>(promotedRoots ?? System.Array.Empty<string>(), System.StringComparer.Ordinal),
            CardKnownRoots = new HashSet<string>(knownRoots ?? System.Array.Empty<string>(), System.StringComparer.Ordinal),
            BlockerArtExtents = ToDict(art),
            BlockerArtHoles = ToDict(holes),
            TextBlockerExtents = ToDict(textBlocker),
        };

        static Dictionary<string, DesignAabb>? ToDict((string Id, DesignAabb Box)[]? entries)
        {
            if (entries is null)
            {
                return null;
            }

            var d = new Dictionary<string, DesignAabb>(System.StringComparer.Ordinal);
            foreach (var (id, box) in entries)
            {
                d[id] = box;
            }

            return d;
        }
    }

    // A label inside an NCard the card layer EVALUATED and DECLINED falls through CardOwned to the ordinary rules —
    // the (b) deck-dialog fix (the card renders in-stage mushy; its text may still promote as a loose proxy).
    private static void CurrentCardOwnedDeclinedRootFallsThrough()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddCard("card", "root", 100, 100, 280, 380);
        h.AddLabel("title", "card", 50, 50, 100, 40);
        var options = Options(promotedRoots: System.Array.Empty<string>(), knownRoots: new[] { "card" });
        var plan = h.PlanNow(excludeCards: true, options: options);
        Check.That(Contains(plan, "title"), "a declined card's label promotes as loose text under options");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.CardOwned), 0, "no CardOwned reject");
    }

    // The double-text hazard direction: a label inside an NCard the card layer ACTUALLY promoted must NEVER also
    // promote as a loose proxy (the clone already carries it crisp).
    private static void CurrentCardOwnedPromotedRootStillRejected()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddCard("card", "root", 100, 100, 280, 380);
        h.AddLabel("title", "card", 50, 50, 100, 40);
        var options = Options(promotedRoots: new[] { "card" }, knownRoots: new[] { "card" });
        var plan = h.PlanNow(excludeCards: true, options: options);
        Check.That(!Contains(plan, "title"), "a promoted card's label never double-promotes");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.CardOwned), 1, "one CardOwned reject");
    }

    // The same-drain window: a card the card layer has NOT yet evaluated stays owned (conservative).
    private static void CurrentCardOwnedUnknownRootStillRejected()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddCard("card", "root", 100, 100, 280, 380);
        h.AddLabel("title", "card", 50, 50, 100, 40);
        var options = Options(); // both sets empty — nothing known yet
        var plan = h.PlanNow(excludeCards: true, options: options);
        Check.That(!Contains(plan, "title"), "an unknown card's label stays owned until the card layer sees it");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.CardOwned), 1, "one CardOwned reject");
    }

    // A clipping ancestor whose clip rect fully CONTAINS the (slack-padded) label box is non-clipping for that label
    // — the (b)/(c) dialog fix. The label sits well inside the clip so even the ±24 pad stays contained.
    private static void CurrentClipContainsPromotes()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var clip = h.AddGroup("clip", "root", 0, 0, 400, 400);
        clip.ClipChildren = 1;
        h.AddLabel("lbl", "clip", 50, 50, 100, 40);
        var plan = h.PlanNow(options: Options());
        Check.That(Contains(plan, "lbl"), "a fully-contained label under a clip ancestor promotes");
    }

    // A label only PARTIALLY inside the clip rect still rejects (the un-nested overlay cannot reproduce the crop).
    private static void CurrentClipPartialContainmentStillRejects()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var clip = h.AddGroup("clip", "root", 0, 0, 400, 400);
        clip.ClipChildren = 1;
        h.AddLabel("lbl", "clip", 380, 50, 100, 40); // extends past the clip's right edge
        var plan = h.PlanNow(options: Options());
        Check.That(!Contains(plan, "lbl"), "a partially-clipped label stays in-stage");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Clip), 1, "one Clip reject");
    }

    // WS-COLUMN: a horizontally-stretched clipping ancestor (a deck-dialog ScrollContainer anchored 0..1) renders
    // WIDER than its streamed rect at F≠1 (SpreadRecord.RenderedWidth override). A label near the WIDENED right edge
    // (the last grid column) is inside the TRUE clip region but OUTSIDE the un-widened rect. Without the width override
    // fed to the planner it is falsely Clip-rejected; with it, it promotes. A label past even the widened edge still
    // rejects (partial containment preserved). Reproduces the exact geometry class the wide-phone deck dialog hit.
    private static void CurrentClipWidenedAncestorContainsLastColumn()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var clip = h.AddGroup("clip", "root", 0, 0, 400, 400); // streamed width 400…
        clip.ClipChildren = 1;
        clip.AnchorLeft = 0;
        clip.AnchorRight = 1; // …anchored to stretch, so it widens at F≠1
        // A "last column" label past the un-widened right edge (400) but inside the widened one (600).
        h.AddLabel("last", "clip", 450, 50, 100, 40);
        h.SetMeasured("last", 450, 50, 550, 90); // tight measured box (maxX 550), post-spread — no slack/shift ambiguity

        // BUG REPRODUCTION: no width override known → the planner uses the un-widened clip rect (right edge 400) → the
        // label pokes past it → false Clip reject (this is the pre-fix behaviour the wide phone showed).
        var buggy = h.PlanNow(factor: 1.5, options: Options());
        Check.That(!Contains(buggy, "last"), "without the anchor-widened width the last-column label is Clip-rejected");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Clip), 1, "one Clip reject");

        // FIX: the clip's true rendered width (600) is fed via spreadWidthOf → the widened clip rect (right edge 600)
        // fully contains the label → it promotes crisp, exactly like every other column.
        h.SpreadWidth["clip"] = 600;
        var fixedPlan = h.PlanNow(factor: 1.5, options: Options());
        Check.That(Contains(fixedPlan, "last"), "the anchor-widened clip rect contains the last-column label → promotes");

        // GUARD: a label past even the WIDENED right edge (650 → maxX 750 > 600) still rejects — partial containment
        // is preserved (the un-nested overlay still cannot reproduce a real crop).
        var h2 = new Harness();
        h2.AddGroup("root", null, 0, 0, 1920, 1080);
        var clip2 = h2.AddGroup("clip", "root", 0, 0, 400, 400);
        clip2.ClipChildren = 1;
        clip2.AnchorLeft = 0;
        clip2.AnchorRight = 1;
        h2.SpreadWidth["clip"] = 600;
        h2.AddLabel("out", "clip", 650, 50, 100, 40);
        h2.SetMeasured("out", 650, 50, 750, 90);
        Check.That(!Contains(h2.PlanNow(factor: 1.5, options: Options()), "out"), "a label past the widened clip edge still rejects Clip");
    }

    // A shader/material ANCESTOR no longer rejects under options (a canvas material never cascades to children) — the
    // (a2) deck-count / TypePlaque fix.
    private static void CurrentAncestorShaderPromotes()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var mid = h.AddGroup("mid", "root", 0, 0, 400, 400);
        mid.ShaderId = "res://x.gdshader";
        h.AddLabel("lbl", "mid", 10, 10, 100, 40);
        var plan = h.PlanNow(options: Options());
        Check.That(Contains(plan, "lbl"), "options: a shader/material ancestor no longer rejects the label");
    }

    // Particle/spine/intent ancestors draw through attached children with unknowable extents — still rejected.
    private static void CurrentAncestorSpineStillRejects()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var mid = h.AddGroup("mid", "root", 0, 0, 400, 400);
        mid.SpineSceneResPath = "res://spine.tscn";
        h.AddLabel("lbl", "mid", 10, 10, 100, 40);
        var plan = h.PlanNow(options: Options());
        Check.That(!Contains(plan, "lbl"), "a spine ancestor still rejects under options");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Effect), 1, "one Effect reject");
    }

    // The label's OWN effect still rejects (its material shades its own text draw).
    private static void CurrentSelfShaderStillRejects()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var lbl = h.AddLabel("lbl", "root", 10, 10, 100, 40);
        lbl.ShaderId = "res://x.gdshader";
        var plan = h.PlanNow(options: Options());
        Check.That(!Contains(plan, "lbl"), "the label's own shader still rejects under options");
    }

    // A MEASURED candidate tolerates an AABB graze no deeper than GrazeTolerancePx (side-bearing/rounding — the
    // (a1)/(e1) floor-number / hover-tip-title-vs-keyword-icon fix)…
    private static void CurrentMeasuredGrazeToleratesShallowOverlap()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        h.SetMeasured("lbl", 0, 0, 100, 40);
        h.AddTextureRect("icon", "root", 97, 0, 50, 40); // intrudes 3px ≤ GrazeTolerancePx=4 into the measured box
        var plan = h.PlanNow(options: Options());
        Check.That(Contains(plan, "lbl"), "a ≤tolerance graze does not occlude a measured label under options");
    }

    // …but a genuinely deep overlap still occludes.
    private static void CurrentMeasuredDeepOverlapStillOccludes()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        h.SetMeasured("lbl", 0, 0, 100, 40);
        h.AddTextureRect("icon", "root", 90, 0, 50, 40); // 10px intrusion > tolerance
        var plan = h.PlanNow(options: Options());
        Check.That(!Contains(plan, "lbl"), "a deep overlap still occludes a measured label");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Occluded), 1, "one Occluded reject");
    }

    // An UNMEASURED candidate keeps the untightened rect+slack test even under options (no measurement ⇒ no ink proof).
    private static void CurrentUnmeasuredCandidateKeepsFullConservatism()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        h.AddTextureRect("icon", "root", 110, 0, 50, 40); // clear of the rect, inside the +24 slack halo
        var plan = h.PlanNow(options: Options());
        Check.That(!Contains(plan, "lbl"), "an unmeasured label keeps the conservative slack halo under options");
    }

    // A client-measured drawn-art box replaces a textured occluder's layout-rect box — the "tighten the OCCLUDER"
    // precedent extended to a measurement (a region-less KeepAspectCentered room icon).
    private static void CurrentBlockerArtExtentsTightenOccluder()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 0, 0, 100, 40);
        h.SetMeasured("lbl", 0, 0, 100, 40);
        h.AddTextureRect("icon", "root", 90, 0, 80, 40); // rect intrudes 10px deep…
        var art = new[] { ("icon", new DesignAabb(110, 0, 170, 40)) }; // …but the measured ART starts at 110
        var plan = h.PlanNow(options: Options(art: art));
        Check.That(Contains(plan, "lbl"), "the measured art box clears a rect-only phantom overlap");
        Check.That(!Contains(h.PlanNow(options: Options()), "lbl"), "without art extents the rect still occludes");
    }

    // A blocker's transparent HOLE (a stretched edge-fade gradient) clears a label fully inside it — the deck-dialog
    // BorderGradient fix.
    private static void CurrentBlockerArtHoleClearsContainedLabel()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 400, 400, 100, 40);   // fully inside the hole
        h.SetMeasured("lbl", 400, 400, 500, 440);
        h.AddLabel("edge", "root", 400, 80, 100, 30);   // overlaps the blocker's painted TOP band
        h.SetMeasured("edge", 400, 80, 500, 110);
        h.AddTextureRect("fade", "root", 0, 75, 1920, 1000); // LATER sibling — paints over the whole dialog area
        var art = new[] { ("fade", new DesignAabb(0, 75, 1920, 1075)) };
        var holes = new[] { ("fade", new DesignAabb(0, 130, 1920, 1020)) }; // transparent middle
        var plan = h.PlanNow(options: Options(art: art, holes: holes));
        Check.That(Contains(plan, "lbl"), "a label fully inside the blocker's transparent hole promotes");
        Check.That(!Contains(plan, "edge"), "a label under the painted edge band stays occluded");
    }

    // A DYNAMIC blocker's hole is untrusted (its pixels jitter) — the hole is ignored.
    private static void CurrentBlockerArtHoleIgnoredForDynamicBlocker()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("lbl", "root", 400, 400, 100, 40);
        h.SetMeasured("lbl", 400, 400, 500, 440);
        h.AddTextureRect("fade", "root", 0, 75, 1920, 1000);
        var art = new[] { ("fade", new DesignAabb(0, 75, 1920, 1075)) };
        var holes = new[] { ("fade", new DesignAabb(0, 130, 1920, 1020)) };
        var plan = h.PlanNow(dynamic: "fade", options: Options(art: art, holes: holes));
        Check.That(!Contains(plan, "lbl"), "a dynamic blocker's hole is ignored (conservative)");
    }

    // Rule 5 (demote-on-scroll): a CHANGED clipping ancestor demotes every promoted label under it — the containment
    // proof may have scrolled out from under the label mid-drain.
    private static void CurrentClipAncestorChangeDemotes()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var clip = h.AddGroup("clip", "root", 0, 0, 400, 400);
        clip.ClipChildren = 1;
        h.AddLabel("lbl", "clip", 50, 50, 100, 40);
        var options = Options();
        var plan = h.PlanNow(options: options);
        Check.That(Contains(plan, "lbl"), "premise: promoted under the contained clip");
        var (demote, _) = h.Demotions(plan, changed: "clip", options: options);
        Check.That(demote.Contains("lbl"), "a changed clipping ancestor demotes the promoted label (scroll)");
        var (demoteOther, _) = h.Demotions(plan, changed: "root", options: options);
        Check.That(!demoteOther.Contains("lbl"), "a changed NON-clipping ancestor does not fire rule 5");
    }

    // The guard revalidation runs the same eligibility as a fresh plan (the conservatism-superset
    // invariant): a label whose box slid partially outside its clip demotes on its own change.
    private static void CurrentDemotionRevalidationUsesEligibility()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        var clip = h.AddGroup("clip", "root", 0, 0, 400, 400);
        clip.ClipChildren = 1;
        var lbl = h.AddLabel("lbl", "clip", 50, 50, 100, 40);
        var options = Options();
        var plan = h.PlanNow(options: options);
        Check.That(Contains(plan, "lbl"), "premise: promoted while contained");

        lbl.LocalRect = new MirrorRect(380, 50, 100, 40); // scrolled: now extends past the clip edge
        var (demote, rebuild) = h.Demotions(plan, changed: "lbl", options: options);
        Check.That(demote.Contains("lbl"), "revalidation rejects Clip with the current eligibility");
        Check.That(!rebuild.Contains("lbl"), "not a rebuild — the label is no longer eligible");
    }

    // ---- WS-EVENTTEXT #14 Leg B: ancient-event option occlusion by the name banner ------------------------------
    //
    // LIVE-captured geometry (design space, Half render, measurements ON) from the initial Neow ancient event:
    //   * last option "Silken Tress"  id=848088286006  measured candidate box [552,957 1382,1027]
    //   * name banner "NEOW"          id=841243181607  a full-SCREEN-box (1920x1080) single-line Left-aligned
    //       MegaRichTextLabel. Its Track-E glyph measurement keeps the FULL box width → design box [40,951 1976,1050],
    //       which spans the whole screen even though the drawn "NEOW" glyphs sit only in the bottom-LEFT corner
    //       (~[40,951 244,1050]). The banner is itself occluded (by an "Outline" decoration) → NOT promoted → it
    //       becomes an in-stage TEXT BLOCKER whose full-width box overlaps the last option and rejects it Occluded.
    // The fix supplies the banner's TIGHT drawn-ink box as a TextBlockerExtents entry (the OCCLUDER-role box only); the
    // option then has no covering painter and promotes. The banner's own candidacy is unchanged (full-box measurement).
    private static readonly DesignAabb NeowOptionBox = new(552, 957, 1382, 1027);
    private static readonly DesignAabb NeowBannerFullBox = new(40, 951, 1976, 1050);
    private static readonly DesignAabb NeowBannerInkBox = new(40, 951, 244, 1050); // tight "NEOW" ink (Left-aligned)

    // Build the two-label Neow slice: the option (earlier) + a later in-stage banner, isolating the
    // labelBlockerBox-selection mechanism under test.
    private static Harness BuildNeowSlice()
    {
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("opt", "root", 552, 957, 830, 70);      // last option (earlier in order)
        h.SetMeasured("opt", 552, 957, 1382, 1027);
        var banner = h.AddLabel("banner", "root", 0, 0, 1920, 1080); // NEOW banner (later ⇒ occludes)
        banner.ShaderId = "res://text.gdshader";
        h.SetMeasured("banner", 40, 951, 1976, 1050);      // full-width glyph measurement (candidate + default blocker)
        return h;
    }

    private static void CurrentTextBlockerExtentTightensNeowBanner()
    {
        var h = BuildNeowSlice();
        var tight = new[] { ("banner", NeowBannerInkBox) };
        // The banner's TIGHT occluder box clears the option (244 < 552) → the last option promotes crisp.
        var plan = h.PlanNow(options: Options(textBlocker: tight));
        Check.That(Contains(plan, "opt"),
            "the last event option promotes once the name banner's occluder box is tightened to its drawn ink");
        Check.That(!Contains(plan, "banner"), "the effect-bearing banner is itself not promoted");
    }

    private static void CurrentTextBlockerExtentAbsentKeepsFullWidth()
    {
        // The SAME scene with NO TextBlockerExtents entry → the banner keeps its full-width measured occluder box, which
        // spans the option → the option is (phantom-)occluded. This is the pre-fix behavior and the byte-identical
        // fallback: a missing entry is never LESS safe.
        var h = BuildNeowSlice();
        var plan = h.PlanNow(options: Options());
        Check.That(!Contains(plan, "opt"), "without a tight occluder box the full-width banner still occludes the option");
        Check.Equal(h.Planner.LastRejectHistogram.GetValueOrDefault(TextOverlayPlanner.TextReject.Occluded), 1,
            "the option's reject is Occluded (the banner)");
    }

    private static void CurrentTextBlockerExtentByteIdenticalForFullWidthEntry()
    {
        // A TextBlockerExtents entry that EQUALS the full measured box (an untightened RichTextLabel / a plain Label,
        // where the tight sweep returns the same box) must behave EXACTLY like the no-entry measured-blocker path:
        // still occludes. Proves the new path only ever changes the outcome when the supplied box is genuinely tighter.
        var h = BuildNeowSlice();
        var same = new[] { ("banner", NeowBannerFullBox) };
        var plan = h.PlanNow(options: Options(textBlocker: same));
        Check.That(!Contains(plan, "opt"),
            "a full-width TextBlockerExtents entry occludes identically to the measured-blocker fallback");
    }

    private static void CurrentTextBlockerExtentNeowUnderProductionOcclusion()
    {
        // The production path keeps the banner as a blocker because it is
        // OCCLUDED by an "Outline" decoration (as live), not because it is dynamic. The Outline overlaps the banner's
        // full-width CANDIDATE box (never tightened) so the banner stays non-promoted; its TIGHT occluder box clears the
        // option so the option promotes. Also asserts the Outline itself does not touch the option.
        var h = new Harness();
        h.AddGroup("root", null, 0, 0, 1920, 1080);
        h.AddLabel("opt", "root", 552, 957, 830, 70);
        h.SetMeasured("opt", 552, 957, 1382, 1027);
        h.AddLabel("banner", "root", 0, 0, 1920, 1080);
        h.SetMeasured("banner", 40, 951, 1976, 1050);
        // An "Outline" texture LATER than the banner, over the banner's full-width candidate box but clear of the option
        // (right edge 542 < option left 552). Live culprit box was [482,955 542,1029].
        h.AddTextureRect("outline", "root", 482, 955, 60, 74);

        var tight = new[] { ("banner", NeowBannerInkBox) };
        var plan = h.PlanNow(options: Options(textBlocker: tight));
        Check.That(Contains(plan, "opt"), "under production policy the option promotes with the banner's tight occluder box");
        Check.That(!Contains(plan, "banner"), "the banner stays non-promoted (its full-width candidate box is occluded by the Outline)");

        // Control: drop the tight box → the full-width banner blocker re-occludes the option.
        var plan2 = h.PlanNow(options: Options());
        Check.That(!Contains(plan2, "opt"), "control: without the tight occluder box the option is occluded again");
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private static bool Contains(TextOverlayPlan plan, string id)
    {
        foreach (var it in plan.Items)
        {
            if (it.Id == id)
            {
                return true;
            }
        }

        return false;
    }

    private sealed class Harness
    {
        public readonly MirrorState State = MirrorState.Create();
        public readonly GlobalTransformIndex Transforms = new();
        public readonly TextOverlayPlanner Planner = new();
        public readonly Dictionary<string, double> SpreadDx = new(System.StringComparer.Ordinal);

        // WS-COLUMN: per-id anchor-WIDENED rendered width override (SpreadRecord.RenderedWidth; 0/absent = none). Fed
        // to Plan/CollectDemotions as spreadWidthOf so the options clip-contains test can widen a stretched clip ancestor.
        public readonly Dictionary<string, double> SpreadWidth = new(System.StringComparer.Ordinal);

        // Track E: client-supplied measured glyph AABBs (design space). Empty → Plan/CollectDemotions get null (the
        // pre-Track-E rect+slack path), so every existing test is byte-identical.
        public readonly Dictionary<string, DesignAabb> Measured = new(System.StringComparer.Ordinal);


        public MirrorNode Node(string id) => State.Nodes[id];

        // Record a measured (tight, alignment-aware) design-space glyph box for `id`, as the client would.
        public void SetMeasured(string id, double minX, double minY, double maxX, double maxY) =>
            Measured[id] = new DesignAabb(minX, minY, maxX, maxY);

        public MirrorNode AddGroup(string id, string? parent, double x, double y, double w, double h)
        {
            var n = new MirrorNode
            {
                Id = id,
                ParentId = parent,
                Transform = new double[] { 1, 0, 0, 1, 0, 0 }, // identity → global identity, rect carries the box
                LocalRect = new MirrorRect(x, y, w, h),
            };
            State.Nodes[id] = n;
            State.OrderedIds.Add(id);
            return n;
        }

        public MirrorNode AddRect(string id, string? parent, double x, double y, double w, double h)
        {
            var n = AddGroup(id, parent, x, y, w, h);
            n.FillColor = new MirrorColor(1, 1, 1, 1, "#ffffffff");
            return n;
        }

        public MirrorNode AddLabel(string id, string? parent, double x, double y, double w, double h)
        {
            var n = AddGroup(id, parent, x, y, w, h);
            n.Text = new MirrorText("hello", "#ffffff", 24, "center", "center", null, 0);
            return n;
        }

        // A textured occluder (TextureRect) with an optional source region + stretch mode (5 = KeepAspectCentered),
        // for the drawn-art blocker-box tests.
        public MirrorNode AddTextureRect(
            string id, string? parent, double x, double y, double w, double h,
            MirrorRect? region = null, int stretch = 0)
        {
            var n = AddGroup(id, parent, x, y, w, h);
            n.TextureUrl = "res://icon.png";
            n.TextureRegion = region;
            n.TextureStretchMode = stretch;
            return n;
        }

        // A minimal NCard subtree root for card-ownership tests.
        public MirrorNode AddCard(string id, string? parent, double x, double y, double w, double h)
        {
            var n = AddGroup(id, parent, x, y, w, h);
            n.NodeType = "MegaCrit.Sts2.Core.Nodes.Cards.NCard";
            return n;
        }

        public TextOverlayPlan PlanNow(string? dynamic = null, double factor = 1.0, string? boundedCosmetic = null,
            bool excludeCards = false, TextOverlayOptions? options = null,
            IReadOnlyDictionary<string, double>? fadeIn = null)
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
                dyn.Add(boundedCosmetic); // boundedCosmetic ⊆ dynamicallyExcluded by contract
            }

            var owned = new HashSet<string>(System.StringComparer.Ordinal);
            var bounded = boundedCosmetic is null
                ? Empty
                : new HashSet<string>(System.StringComparer.Ordinal) { boundedCosmetic };
            return Planner.Plan(State, Transforms, factor, DxOf, dyn, owned, bounded, MeasuredArg,
                excludeCards, options ?? new TextOverlayOptions(), WidthOf, fadeIn);
        }

        public (HashSet<string> Demote, HashSet<string> Rebuild) Demotions(
            TextOverlayPlan plan, string? changed = null, MirrorTweenHint[]? hints = null,
            string? dynamic = null, bool excludeCards = false,
            TextOverlayOptions? options = null, IReadOnlyDictionary<string, double>? fadeIn = null)
        {
            Transforms.Update(State);
            var changedSet = changed is null ? Empty : new HashSet<string>(System.StringComparer.Ordinal) { changed };
            var dyn = dynamic is null ? Empty : new HashSet<string>(System.StringComparer.Ordinal) { dynamic };
            var demote = new HashSet<string>(System.StringComparer.Ordinal);
            var rebuild = new HashSet<string>(System.StringComparer.Ordinal);
            var churn = new HashSet<string>(System.StringComparer.Ordinal);
            Planner.CollectDemotions(
                State, Transforms, 1.0, DxOf, plan.Items, changedSet,
                hints ?? System.Array.Empty<MirrorTweenHint>(),
                dyn, demote, rebuild, churn, MeasuredArg, excludeCards, options ?? new TextOverlayOptions(), WidthOf, fadeIn);
            return (demote, rebuild);
        }

        private double DxOf(string id) => SpreadDx.TryGetValue(id, out var d) ? d : 0;

        // 0 when no override is set (byte-identical to the un-widened LocalRect.Width path).
        private double WidthOf(string id) => SpreadWidth.TryGetValue(id, out var w) ? w : 0;

        // Null when no measurement is set (the pre-Track-E path), so the fallback tests exercise rect+slack exactly.
        private IReadOnlyDictionary<string, DesignAabb>? MeasuredArg => Measured.Count == 0 ? null : Measured;

        private static readonly HashSet<string> Empty = new(System.StringComparer.Ordinal);
    }
}
