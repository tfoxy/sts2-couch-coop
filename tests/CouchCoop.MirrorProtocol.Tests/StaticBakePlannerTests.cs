using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for the Track-D/P static-bake planner (pure z-aware eligibility + prefix + carrier math). Covers: the
// bottom-most eligible prefix of the EFFECTIVE-Z paint order, effZ composition through a chain, stable pre-order
// tie-break, the per-node cut points (hard effect / static-shader gate / material-ref eligibility / dynamically-
// excluded / cross-z show-behind / unknown-bounds / blend), the carrier gate (ancestor instability / dynamic / clip),
// the stability window, the budget gate, the boundary trims, the thrash guard, carrier construction + ancestor
// closure under z, the QuadZ boundary invariant, and keyframe reset.
internal static class StaticBakePlannerTests
{
    public static void Run()
    {
        BakesBottomPrefixOfStaticScene();
        PrefixEndsAtEffectNode();
        MaterialRefEligible();
        StaticShaderEligibleViaSet();
        ParticleSpineIntentAlwaysReject();
        PrefixEndsAtDynamicallyExcluded();
        NonZeroZNodeIsBakedWhenEligible();
        PrefixEndsAtUnknownBoundsPainter();
        AllowsAddSubMulBlend();
        NegativeZBandBakesUnderZeroParents();
        EffectiveZComposesThroughChain();
        StableTieBreakIsPreOrder();
        ShowBehindParentZMismatchRejected();
        CarrierUnstableRejects();
        CarrierDynamicRejects();
        CarrierClipRejects();
        ClosureUnderZ();
        QuadZBoundaryInvariant();
        UnstableNodeTruncatesPrefix();
        StabilityNeedsDrainsInActiveScene();
        ReplaySingleDrainStabilizesOnFrames();
        BudgetGateRejectsTooFewPainters();
        BudgetGateRejectsLowCoverage();
        OpenClipNodeTrimmedOut();
        ClosedClipSubtreeKept();
        LiveShowBehindParentChildTrimsParent();
        ThrashGuardBenchesRepeatOffender();
        ResultIsAncestorClosed();
        KeyframeKeepsStabilityForIdenticalNodes();
        KeyframeResetsStabilityForChangedNodes();

        // Track-P3 multi-region (bake static segments around same-bucket interleaved particles).
        MultiRegionBakesSegmentsAroundParticles();
        MultiRegionPreservesPaintOrder();
        MultiRegionV2EquivalenceWhenNoParticleBoundary();
        AddInUpperSegmentBakes();
        MultiRegionChangeInOneSegmentSparesAnother();
        MultiRegionParticleWithoutStaticSegmentsFallsBackToV2();

        // WS-ADDBAKE: Add joins region membership everywhere (alpha-preserving variant); Sub/Mul stay bottom-only.
        AddInterleavedWithMixOneRegion();
        SubMulInUpperSegmentStaysLive();
        SubMulStayBottomOnlyWhenAddBakes();

        // Track-P3c band-scoped stability relax + per-region scoped invalidation.
        BandBucketUsesRelaxedStabilityWindow();
        RegionsTouchedByScopesToTheTouchedRegion();
        PositionStableZSurvivesUpperSlotRemoval();
    }

    private const double Width = 1920;

    // ---- core prefix --------------------------------------------------------------------------------------------

    private static void BakesBottomPrefixOfStaticScene()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "static full-screen scene bakes");
        Check.Equal(plan.BakedIds.Count, 13, "root + 12 bg all baked");
        Check.Equal(plan.PaintCount, 12, "12 painting nodes");
        Check.Equal(plan.CarrierIds.Count, 0, "flat z=0 scene needs no carriers");
    }

    private static void PrefixEndsAtEffectNode()
    {
        // shader (not static-approved) / spine / intent each stop the prefix at that node. (material is now bakeable —
        // covered by MaterialRefEligible.)
        foreach (var kind in new[] { "shader", "spine", "intent" })
        {
            var h = new Harness();
            h.AddGroup("root", null);
            for (int i = 0; i < 11; i++)
            {
                h.AddFullRect($"bg{i}", "root");
            }

            var fx = h.AddFullRect("fx", "root");
            switch (kind)
            {
                case "shader": fx.ShaderId = "res://x.gdshader"; break;
                case "spine": fx.SpineSceneResPath = "res://x.tscn"; break;
                case "intent": fx.IntentFrames = new MirrorIntentFrames("a", 12, System.Array.Empty<MirrorIntentFrame>()); break;
            }

            h.AddFullRect("above", "root"); // eligible but sits AFTER the effect node → excluded with it

            h.StabilizeAll();
            var plan = h.PlanNow(); // empty effectStaticOk → the shader is NOT cleared
            Check.That(plan.IsBakeable, $"{kind}: bottom 11 still bake");
            Check.Equal(plan.BakedIds.Count, 12, $"{kind}: root + 11 bg (effect node ends the prefix)");
            Check.That(!Contains(plan.BakedIds, "fx"), $"{kind}: effect node not baked");
            Check.That(!Contains(plan.BakedIds, "above"), $"{kind}: node above the effect not baked");
        }
    }

    private static void MaterialRefEligible()
    {
        // A MaterialRef is never consumed by the native renderer → a MaterialRef-only node is plain art, bakeable.
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        var m = h.AddFullRect("mref", "root");
        m.MaterialRef = "res://x.tres";
        h.StabilizeAll();

        var plan = h.PlanNow();
        Check.That(Contains(plan.BakedIds, "mref"), "material-ref-only node is bakeable");
        Check.Equal(plan.BakedIds.Count, 13, "root + 11 bg + the material-ref node");
    }

    private static void StaticShaderEligibleViaSet()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        var sh = h.AddFullRect("sh", "root");
        sh.ShaderId = "res://water.gdshader";
        h.StabilizeAll();

        // Not cleared → the shader ends the prefix.
        var off = h.PlanNow();
        Check.That(!Contains(off.BakedIds, "sh"), "un-cleared shader not baked");
        Check.Equal(off.BakedIds.Count, 12, "root + 11 bg (shader ends the prefix)");

        // Cleared via effectStaticOk → the shader bakes with the rest.
        var on = h.PlanNow(effectStaticOk: "sh");
        Check.That(Contains(on.BakedIds, "sh"), "static-approved shader bakes");
        Check.Equal(on.BakedIds.Count, 13, "root + 11 bg + the static shader");
        Check.Equal(h.Planner.LastDiagnostic.StaticShaderCount, 1, "diagnostic counts one static shader");
    }

    private static void ParticleSpineIntentAlwaysReject()
    {
        // Even listed in effectStaticOk (which only ever clears ShaderId ids), a spine / intent node still rejects:
        // the hard-effect guard runs before the shader gate. ParticleSpec shares the identical OR-clause.
        foreach (var kind in new[] { "spine", "intent" })
        {
            var h = new Harness();
            h.AddGroup("root", null);
            for (int i = 0; i < 11; i++)
            {
                h.AddFullRect($"bg{i}", "root");
            }

            var fx = h.AddFullRect("fx", "root");
            if (kind == "spine")
            {
                fx.SpineSceneResPath = "res://x.tscn";
            }
            else
            {
                fx.IntentFrames = new MirrorIntentFrames("a", 12, System.Array.Empty<MirrorIntentFrame>());
            }

            h.StabilizeAll();
            var plan = h.PlanNow(effectStaticOk: "fx"); // even cleared, still rejected
            Check.That(!Contains(plan.BakedIds, "fx"), $"{kind}: hard-effect node rejected despite effectStaticOk");
            Check.Equal(plan.BakedIds.Count, 12, $"{kind}: prefix ends at the hard-effect node");
        }
    }

    private static void PrefixEndsAtDynamicallyExcluded()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.AddFullRect("live", "root"); // e.g. a tween-owned / animating / unsettled-texture node
        h.AddFullRect("bg11", "root");
        h.StabilizeAll();

        var plan = h.PlanNow(excluded: "live");
        Check.Equal(plan.BakedIds.Count, 12, "prefix ends at the dynamically-excluded node");
        Check.That(!Contains(plan.BakedIds, "live"), "dynamically-excluded node not baked");
    }

    private static void NonZeroZNodeIsBakedWhenEligible()
    {
        // v1 refused any non-zero z-index outright. v2 is z-aware: a stable z=5 rect simply sorts to the TOP of the
        // paint order and, being otherwise eligible, bakes with the rest (it is the highest-z painter → QuadZ = 5).
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        var z = h.AddFullRect("z", "root");
        z.ZIndex = 5;
        h.StabilizeAll();

        var plan = h.PlanNow();
        Check.That(Contains(plan.BakedIds, "z"), "eligible non-zero-z node is baked (z-aware)");
        Check.Equal(plan.BakedIds.Count, 13, "root + 11 bg + the z node all baked");
        Check.Equal(plan.QuadZ, 5, "quad takes the highest baked painter z");
    }

    private static void PrefixEndsAtUnknownBoundsPainter()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        var blob = h.AddGroup("blob", "root");
        blob.TextureUrl = "res://x.png"; // paints, but NO rect → unknown extent
        h.StabilizeAll();

        var plan = h.PlanNow();
        Check.That(!Contains(plan.BakedIds, "blob"), "unknown-bounds painter not baked");
        Check.Equal(plan.BakedIds.Count, 12, "prefix ends at the unknown-bounds painter");
    }

    private static void AllowsAddSubMulBlend()
    {
        foreach (int blend in new[] { 1, 2, 3 })
        {
            var h = new Harness();
            h.AddGroup("root", null);
            for (int i = 0; i < 11; i++)
            {
                h.AddFullRect($"bg{i}", "root");
            }

            var b = h.AddFullRect("blended", "root");
            b.CanvasBlendMode = blend;
            h.StabilizeAll();

            var plan = h.PlanNow();
            Check.That(Contains(plan.BakedIds, "blended"), $"blend {blend} is bakeable");
            Check.Equal(plan.BakedIds.Count, 13, $"blend {blend}: all 13 baked");
        }
    }

    // ---- z-awareness + carriers ---------------------------------------------------------------------------------

    private static void NegativeZBandBakesUnderZeroParents()
    {
        // A z=-10 band sits under a z=0 SHADER parent (a real combat shape: the whole background is under a z=-10
        // container whose own art is a screen-reading shader). With the shader NOT static-approved it self-rejects at
        // its own effZ=0 slot — but its transform is static, so it is a valid CARRIER: the band bakes UNDER it, the
        // quad takes the band's z, and the shader keeps painting live above the quad.
        var h = new Harness();
        var carrier = h.AddGroup("carrier", null); // effZ 0
        carrier.LocalRect = new MirrorRect(0, 0, 1920, 1080);
        carrier.TextureUrl = "res://bg.png";
        carrier.ShaderId = "res://water.gdshader"; // NOT in effectStaticOk → self-rejects (Effect)
        for (int i = 0; i < 12; i++)
        {
            var b = h.AddFullRect($"band{i}", "carrier");
            b.ZIndex = -10; // effZ -10
        }

        h.StabilizeAll();
        var plan = h.PlanNow(); // carrier's shader not cleared
        Check.That(plan.IsBakeable, "z=-10 band under a z=0 carrier bakes");
        for (int i = 0; i < 12; i++)
        {
            Check.That(Contains(plan.BakedIds, $"band{i}"), $"band{i} baked");
        }

        Check.That(!Contains(plan.BakedIds, "carrier"), "the z=0 shader parent is NOT baked");
        Check.That(Contains(plan.CarrierIds, "carrier"), "the z=0 shader parent is a carrier");
        Check.Equal(plan.QuadZ, -10, "quad takes the band's boundary z");
        Check.Equal(plan.BakedIds.Count, 12, "just the 12 band painters baked");
        Check.Equal(plan.BuildOrder.Count, 13, "build order = 12 band + 1 carrier");
        Check.That(plan.BuildOrder[0] == "carrier", "carrier clone built before its baked children");
    }

    private static void EffectiveZComposesThroughChain()
    {
        // effZ is the SUM down the chain, not the node's own z nor its parent's: a z=+3 band under a z=-10 parent lands
        // at effZ -7. Proven via QuadZ (the highest baked painter's effZ): own-z would give +3, parent-z would give -10.
        var h = new Harness();
        var under = h.AddGroup("under", null);
        under.ZIndex = -10;
        for (int i = 0; i < 12; i++)
        {
            var b = h.AddFullRect($"band{i}", "under");
            b.ZIndex = 3; // effZ -10 + 3 = -7
        }

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "chained-z band bakes");
        Check.Equal(plan.QuadZ, -7, "effZ composes: -10 (parent) + 3 (self) = -7");
    }

    private static void StableTieBreakIsPreOrder()
    {
        // At equal effZ the paint order breaks ties by pre-order index, so an ineligible node in the MIDDLE ends the
        // prefix exactly at its pre-order slot: nodes after it (same effZ, higher pre-order) are excluded.
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"a{i}", "root"); // 11 painters, effZ 0
        }

        var blk = h.AddFullRect("blk", "root");
        blk.ShaderId = "res://x.gdshader"; // ineligible mid-order
        for (int i = 11; i < 16; i++)
        {
            h.AddFullRect($"a{i}", "root"); // same effZ, later pre-order → excluded with blk
        }

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "prefix before the mid blocker bakes");
        Check.That(Contains(plan.BakedIds, "a10"), "a10 (before blocker) baked");
        Check.That(!Contains(plan.BakedIds, "blk"), "mid blocker not baked");
        Check.That(!Contains(plan.BakedIds, "a11"), "same-effZ node after the blocker (pre-order) excluded");
        Check.Equal(plan.BakedIds.Count, 12, "root + a0..a10");
    }

    private static void ShowBehindParentZMismatchRejected()
    {
        // ShowBehindParent is honored only intra-z; a cross-z behind-parent node can't be placed by the paint-order
        // model → ZOrderUncertain. Placed at the bottom (lowest effZ) so it stops the whole prefix.
        var h = new Harness();
        var under = h.AddGroup("under", null);
        under.ZIndex = -10; // effZ -10
        var shb = h.AddFullRect("shb", "under");
        shb.ZIndex = -5;                 // effZ -15 ≠ parent's -10 → mismatch
        shb.ShowBehindParent = true;
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"band{i}", "under"); // effZ -10
        }

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(!plan.IsBakeable, "cross-z show-behind node at the bottom stops the bake");
        Check.Equal(h.Planner.LastDiagnostic.BoundaryReason, BakeReject.ZOrderUncertain, "reason is z-order-uncertain");
        Check.Equal(h.Planner.LastDiagnostic.BoundaryId, "shb", "the mismatch node is the boundary");
    }

    private static void CarrierUnstableRejects()
    {
        var h = BandUnderCarrier(out _);
        h.StabilizeAll();
        h.Drain("carrier"); // the carrier just changed → unstable (band stays stable)
        var plan = h.PlanNow();
        Check.That(!plan.IsBakeable, "unstable carrier blocks the band");
        Check.Equal(h.Planner.LastDiagnostic.BoundaryReason, BakeReject.CarrierUnstable, "reason is carrier-unstable");
    }

    private static void CarrierDynamicRejects()
    {
        var h = BandUnderCarrier(out _);
        h.StabilizeAll();
        var plan = h.PlanNow(excluded: "carrier"); // carrier is tween/anim/lift-owned
        Check.That(!plan.IsBakeable, "dynamically-owned carrier blocks the band");
        Check.Equal(h.Planner.LastDiagnostic.BoundaryReason, BakeReject.CarrierDynamic, "reason is carrier-dynamic");
    }

    private static void CarrierClipRejects()
    {
        var h = BandUnderCarrier(out var carrier);
        carrier.ClipChildren = 1; // the carrier clips, but a suppressed carrier clone can't reproduce the stencil
        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(!plan.IsBakeable, "clipping carrier (higher effZ) blocks the band");
        Check.Equal(h.Planner.LastDiagnostic.BoundaryReason, BakeReject.CarrierBlocked, "reason is carrier-blocked");
    }

    private static void ClosureUnderZ()
    {
        // Every baked non-root's parent is baked OR a carrier (the clone tree is complete), and BuildOrder is
        // parents-first.
        var h = new Harness();
        var carrier = h.AddGroup("carrier", null);
        carrier.LocalRect = new MirrorRect(0, 0, 1920, 1080);
        carrier.TextureUrl = "res://bg.png";
        carrier.ShaderId = "res://water.gdshader";
        h.AddGroup("mid", "carrier"); // a pure group inside the band (effZ 0)
        for (int i = 0; i < 12; i++)
        {
            var b = h.AddFullRect($"band{i}", "mid");
            b.ZIndex = -10; // effZ -10
        }

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "nested z band bakes");
        var baked = new HashSet<string>(plan.BakedIds);
        var carriers = new HashSet<string>(plan.CarrierIds);
        foreach (var id in plan.BakedIds)
        {
            var pid = h.State.Nodes[id].ParentId;
            Check.That(pid is null || baked.Contains(pid) || carriers.Contains(pid),
                $"parent of baked {id} is baked or a carrier");
        }

        var seen = new HashSet<string>();
        foreach (var id in plan.BuildOrder)
        {
            var pid = h.State.Nodes[id].ParentId;
            if (pid is not null && (baked.Contains(pid) || carriers.Contains(pid)))
            {
                Check.That(seen.Contains(pid), $"parent {pid} of {id} built before it");
            }

            seen.Add(id);
        }
    }

    private static void QuadZBoundaryInvariant()
    {
        // Every LIVE painter (not baked) must sit at effZ ≥ QuadZ so the quad never occludes it.
        var h = new Harness();
        var carrier = h.AddGroup("carrier", null);
        carrier.LocalRect = new MirrorRect(0, 0, 1920, 1080);
        carrier.TextureUrl = "res://bg.png";
        carrier.ShaderId = "res://water.gdshader"; // a live painter at effZ 0
        for (int i = 0; i < 12; i++)
        {
            var b = h.AddFullRect($"band{i}", "carrier");
            b.ZIndex = -10;
        }

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "band bakes");
        var baked = new HashSet<string>(plan.BakedIds);
        foreach (var (id, node) in h.State.Nodes)
        {
            if (baked.Contains(id))
            {
                continue;
            }

            bool paints = node.Visible && (node.TextureUrl is not null || node.FillColor is not null);
            if (paints)
            {
                Check.That(h.EffZ(id) >= plan.QuadZ, $"live painter {id} sits at/above QuadZ");
            }
        }
    }

    // ---- stability ----------------------------------------------------------------------------------------------

    private static void UnstableNodeTruncatesPrefix()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.AddFullRect("fresh", "root");
        h.StabilizeAll();       // everything stable
        h.Drain("fresh");       // 'fresh' just changed → unstable (and a fresh drain, so no bypass)
        var plan = h.PlanNow();
        Check.That(!Contains(plan.BakedIds, "fresh"), "a just-changed node is not baked");
        Check.Equal(plan.BakedIds.Count, 12, "prefix truncated before the unstable node");
    }

    private static void StabilityNeedsDrainsInActiveScene()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 10; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.AddFullRect("target", "root");
        h.AddFullRect("churn", "root"); // perpetually changed → always ends the prefix at itself
        h.StabilizeAll();               // everything (incl. target) stable

        h.Drain("target");
        for (int f = 0; f < StaticBakePlanner.MinStableFrames + 2; f++)
        {
            h.Planner.ObserveFrame();
        }

        h.Drain("churn"); // active scene → bypass OFF, target drainsSinceChange = 1
        Check.That(!Contains(h.PlanNow().BakedIds, "target"),
            "frame clause cleared but drain clause not (active scene) → still unstable");

        for (int d = 0; d < StaticBakePlanner.MinStableDrains; d++)
        {
            h.Drain("churn");
        }

        Check.That(Contains(h.PlanNow().BakedIds, "target"), "target re-stable after enough non-touching drains");
    }

    private static void ReplaySingleDrainStabilizesOnFrames()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.Drain(AllIds(h)); // the single keyframe-style drain
        Check.That(!h.PlanNow().IsBakeable, "not bakeable immediately after the one drain");

        for (int f = 0; f < StaticBakePlanner.MinStableFrames + 1; f++)
        {
            h.Planner.ObserveFrame();
        }

        Check.That(h.PlanNow().IsBakeable, "bakeable after MinStableFrames of drain quiescence (replay path)");
    }

    // ---- budget -------------------------------------------------------------------------------------------------

    private static void BudgetGateRejectsTooFewPainters()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < StaticBakePlanner.MinPaintingNodes - 1; i++)
        {
            h.AddFullRect($"bg{i}", "root"); // 9 painters — one short
        }

        h.StabilizeAll();
        Check.That(!h.PlanNow().IsBakeable, "fewer than MinPaintingNodes → no bake");
    }

    private static void BudgetGateRejectsLowCoverage()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            h.AddRect($"tiny{i}", "root", 0, 0, 10, 10);
        }

        h.StabilizeAll();
        Check.That(!h.PlanNow().IsBakeable, "low coverage → no bake even with enough painters");
    }

    // ---- boundary trims -----------------------------------------------------------------------------------------

    private static void OpenClipNodeTrimmedOut()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        var clip = h.AddFullRect("clip", "root");
        clip.ClipChildren = 1;
        var inner = h.AddFullRect("inner", "clip");
        inner.ShaderId = "res://x.gdshader"; // makes 'inner' ineligible → it stays live under the open clip node
        h.StabilizeAll();

        var plan = h.PlanNow();
        Check.That(!Contains(plan.BakedIds, "clip"), "open clip node trimmed out");
        Check.That(!Contains(plan.BakedIds, "inner"), "the live inner child is not baked");
        Check.Equal(plan.BakedIds.Count, 12, "prefix ends before the open clip node");
    }

    private static void ClosedClipSubtreeKept()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 10; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        var clip = h.AddFullRect("clip", "root");
        clip.ClipChildren = 1;
        h.AddFullRect("innerA", "clip");
        h.AddFullRect("innerB", "clip");
        h.StabilizeAll();

        var plan = h.PlanNow();
        Check.That(Contains(plan.BakedIds, "clip"), "closed clip node baked");
        Check.That(Contains(plan.BakedIds, "innerA") && Contains(plan.BakedIds, "innerB"), "clip subtree baked");
    }

    private static void LiveShowBehindParentChildTrimsParent()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 11; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        var p = h.AddFullRect("p", "root");
        var shb = h.AddFullRect("shb", "p");
        shb.ShowBehindParent = true;       // same effZ as p (both z=0) → intra-z, honored
        shb.ShaderId = "res://x.gdshader"; // ineligible → stays live under 'p'
        h.StabilizeAll();

        var plan = h.PlanNow();
        Check.That(!Contains(plan.BakedIds, "p"), "parent of a live show-behind child trimmed out");
        Check.Equal(plan.BakedIds.Count, 12, "prefix ends before that parent");
    }

    // ---- thrash guard -------------------------------------------------------------------------------------------

    private static void ThrashGuardBenchesRepeatOffender()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.StabilizeAll();
        Check.That(Contains(h.PlanNow().BakedIds, "bg10"), "bg10 baked before thrashing");

        h.Planner.RegisterInvalidation(new[] { "bg10" });
        h.Drain("bg10");
        h.Planner.RegisterInvalidation(new[] { "bg10" });
        for (int d = 0; d < StaticBakePlanner.MinStableDrains + 1; d++)
        {
            h.DrainNoTouch();
        }

        for (int f = 0; f < StaticBakePlanner.MinStableFrames + 1; f++)
        {
            h.Planner.ObserveFrame();
        }

        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "prefix still bakeable with the offender benched");
        Check.That(!Contains(plan.BakedIds, "bg10"), "repeat offender benched by the thrash guard");
    }

    // ---- structure / lifecycle ----------------------------------------------------------------------------------

    private static void ResultIsAncestorClosed()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddGroup("mid", "root");
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"leaf{i}", "mid");
        }

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "nested static scene bakes");
        var set = new HashSet<string>(plan.BakedIds);
        foreach (var id in plan.BakedIds)
        {
            var pid = h.State.Nodes[id].ParentId;
            Check.That(pid is null || set.Contains(pid), $"ancestor of {id} is baked");
        }
    }

    // WS-BGBAKE round 3 (keyframe stability preservation): an IDENTICAL keyframe (loop restart / resync — every
    // node value-compares unchanged via NodeChangeDiffer.ClassifyKeyframe) KEEPS stability, so the immediate re-plan
    // is still bakeable; a keyframe that actually CHANGED a node re-stamps exactly that node.
    private static void KeyframeKeepsStabilityForIdenticalNodes()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.StabilizeAll();
        Check.That(h.PlanNow().IsBakeable, "stable before keyframe");

        h.Planner.ObserveDrain(h.State, AllIds(h), System.Array.Empty<string>(), keyframe: true);
        Check.That(h.PlanNow().IsBakeable, "an identical keyframe keeps stability — still bakeable immediately");
    }

    private static void KeyframeResetsStabilityForChangedNodes()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.StabilizeAll();
        Check.That(h.PlanNow().IsBakeable, "stable before keyframe");

        // A keyframe replaces node INSTANCES; simulate a changed re-send of bg0 (different fill).
        var replaced = new MirrorNode
        {
            Id = "bg0",
            ParentId = "root",
            Transform = new double[] { 1, 0, 0, 1, 0, 0 },
            LocalRect = new MirrorRect(0, 0, 1920, 1080),
            FillColor = new MirrorColor(0, 0, 0, 1, "#000000ff"),
        };
        h.State.Nodes["bg0"] = replaced;

        h.Planner.ObserveDrain(h.State, AllIds(h), System.Array.Empty<string>(), keyframe: true);
        Check.That(!h.PlanNow().IsBakeable,
            "the changed node re-stamped → the prefix ends at bg0 → not bakeable until re-settled");
    }

    // ---- Track-P3 multi-region ----------------------------------------------------------------------------------

    // A single z-bucket band with static runs separated by PARTICLES bakes each run into its own region, leaving the
    // particles LIVE (in the re-leveling set) so they composite between the region quads.
    private static void MultiRegionBakesSegmentsAroundParticles()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        BuildBand(h, "root", runs: 4, runSize: 6); // root + [6 static][P][6 static][P][6 static][P][6 static]

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "particle-interleaved band is bakeable via multi-region");
        Check.Equal(plan.Regions.Count, 4, "one region per contiguous static run");
        Check.Equal(plan.LiveZ.Count, 3, "the 3 interleaved particles are re-leveled live (not baked)");

        var bakedAll = new HashSet<string>();
        foreach (var r in plan.Regions)
        {
            foreach (var id in r.BakedIds)
            {
                bakedAll.Add(id);
            }
        }

        for (int p = 0; p < 3; p++)
        {
            Check.That(!bakedAll.Contains($"P{p}"), $"particle P{p} is not baked");
            bool inLiveZ = false;
            foreach (var lz in plan.LiveZ)
            {
                if (lz.Id == $"P{p}")
                {
                    inLiveZ = true;
                }
            }

            Check.That(inLiveZ, $"particle P{p} is in the live re-leveling set");
        }
    }

    // Paint-order preservation invariant: sorting the region quads + the re-leveled live painters by their PAINT
    // position yields STRICTLY INCREASING absolute z, and every one is BELOW the band's bucket z (so under the content
    // — creatures/gameplay — that sits at/above the bucket). This is exactly the condition that makes the re-leveled
    // draw order identical to the live paint order.
    private static void MultiRegionPreservesPaintOrder()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        BuildBand(h, "root", runs: 3, runSize: 6);

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.Regions.Count >= 2, "multi-region formed");

        int bucketZ = 0; // the whole band is effZ 0 (default z)

        // Collect (paintPos, z) for every region (its lowest-paint-pos baked painter) and every live-z painter.
        var slots = new List<(int Pos, int Z, string What)>();
        foreach (var r in plan.Regions)
        {
            int minPos = int.MaxValue;
            foreach (var id in r.BakedIds)
            {
                minPos = System.Math.Min(minPos, h.PaintPos(id));
            }

            slots.Add((minPos, r.QuadZ, "region"));
        }

        foreach (var lz in plan.LiveZ)
        {
            slots.Add((h.PaintPos(lz.Id), lz.Z, "live"));
        }

        slots.Sort((a, b) => a.Pos.CompareTo(b.Pos));
        for (int i = 0; i < slots.Count; i++)
        {
            Check.That(slots[i].Z < bucketZ, $"slot z {slots[i].Z} is below the band bucket z {bucketZ}");
            if (i > 0)
            {
                Check.That(slots[i - 1].Z < slots[i].Z,
                    $"z strictly increases with paint order ({slots[i - 1].Z} < {slots[i].Z})");
            }
        }

        // A particle between region i and region i+1 has z strictly between their quad z (the sandwich property).
        Check.That(plan.LiveZ.Count >= 1 && plan.Regions.Count >= 2, "have a particle between two regions");
    }

    // A scene whose v2 prefix ends at a NON-particle boundary (a shader) plans IDENTICALLY to v2 — one region, empty
    // re-leveling set. Multi-region never activates without a same-bucket particle boundary (pins v2 reproducibility).
    private static void MultiRegionV2EquivalenceWhenNoParticleBoundary()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        var sh = h.AddFullRect("sh", "root");
        sh.ShaderId = "res://x.gdshader"; // non-particle boundary → v2, not multi-region
        for (int i = 12; i < 18; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "single-region scene bakes");
        Check.Equal(plan.Regions.Count, 1, "exactly one region (v2 shape)");
        Check.Equal(plan.LiveZ.Count, 0, "no live re-leveling in the v2 single-region path");
        Check.Equal(plan.BakedIds.Count, 13, "root + 12 bg (prefix ends at the shader) — identical to v2");
        Check.That(!Contains(plan.BakedIds, "sh"), "the shader boundary is not baked");
    }

    // WS-ADDBAKE: a plain-Add painter interleaved in an UPPER segment now BAKES into that region (via the alpha-
    // preserving variant), NOT stays live — Add is no longer bottom-only. Region 0's Add bakes too.
    private static void AddInUpperSegmentBakes()
    {
        var h = new Harness();
        h.AddGroup("root", null);

        // region 0 = 6 static incl. an additive painter.
        for (int i = 0; i < 5; i++)
        {
            h.AddFullRect($"a{i}", "root");
        }

        var bottomAdd = h.AddFullRect("bottomAdd", "root");
        bottomAdd.CanvasBlendMode = 1; // Add

        h.AddParticle("P0", "root");

        // upper segment = 6 static incl. an additive painter (now bakes into the region quad).
        for (int i = 0; i < 5; i++)
        {
            h.AddFullRect($"b{i}", "root");
        }

        var upperAdd = h.AddFullRect("upperAdd", "root");
        upperAdd.CanvasBlendMode = 1; // Add — bakes via the alpha-preserving variant

        h.AddParticle("P1", "root");
        for (int i = 0; i < 6; i++)
        {
            h.AddFullRect($"c{i}", "root");
        }

        h.StabilizeAll();
        // Add is NOT bottom-only → the controller passes no Add ids in bottomOnly.
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "band with additive painters bakes (multi-region)");

        var baked = new HashSet<string>();
        foreach (var r in plan.Regions)
        {
            foreach (var id in r.BakedIds)
            {
                baked.Add(id);
            }
        }

        Check.That(baked.Contains("bottomAdd"), "additive painter in the BOTTOM region is baked");
        Check.That(baked.Contains("upperAdd"), "additive painter in an UPPER segment ALSO bakes (variant)");
        foreach (var lz in plan.LiveZ)
        {
            Check.That(lz.Id != "upperAdd", "the upper additive painter is baked, not re-leveled live");
        }
    }

    // Region isolation (stability): a change that touches ONLY an upper segment's node does not destabilize the bottom
    // region — it still bakes. (The upper segment turns unstable and ends the band, but the bottom region is spared.)
    private static void MultiRegionChangeInOneSegmentSparesAnother()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        BuildBand(h, "root", runs: 3, runSize: 12); // big runs so region 0 alone still meets budget

        h.StabilizeAll();
        Check.That(h.PlanNow().Regions.Count >= 2, "multi-region before the change");

        h.Drain("run2_3"); // touch a node in the 3rd static run (upper) → it (and the band above it) destabilizes
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "the bottom region survives an upper-segment change");
        Check.That(Contains(plan.BakedIds, "run0_0"), "region 0's nodes are still baked (spared)");
    }

    // A same-bucket particle boundary but NO further static runs reach the per-region threshold → multi-region can't
    // form ≥2 regions and falls back to the v2 prefix (which here is below budget → nothing bakes). Proves the
    // fall-through path.
    private static void MultiRegionParticleWithoutStaticSegmentsFallsBackToV2()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 4; i++)
        {
            h.AddFullRect($"pre{i}", "root"); // < budget prefix
        }

        h.AddParticle("P0", "root");
        h.AddFullRect("lone", "root"); // 1-painter run < MinPaintersPerRegion → no second region
        h.StabilizeAll();

        var plan = h.PlanNow();
        Check.That(!plan.IsBakeable, "no viable multi-region → v2 fall-through → below budget → no bake");
    }

    // ---- WS-ADDBAKE: Add joins region membership (alpha-preserving variant) ----------------------------------------

    // An upper segment of [mix, Add, Add, mix] bakes as ONE region (no add partition, no mix-after-add split): the Add
    // painters are ordinary members of the region's single quad, and the trailing mix stays in the SAME region.
    private static void AddInterleavedWithMixOneRegion()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 6; i++)
        {
            h.AddFullRect($"a{i}", "root"); // region 0 (bottom prefix)
        }

        h.AddParticle("P0", "root");
        for (int i = 0; i < 4; i++)
        {
            h.AddFullRect($"b{i}", "root"); // upper mix run
        }

        var add0 = h.AddFullRect("add0", "root");
        add0.CanvasBlendMode = 1; // Add
        var add1 = h.AddFullRect("add1", "root");
        add1.CanvasBlendMode = 1; // Add
        for (int i = 0; i < 3; i++)
        {
            h.AddFullRect($"d{i}", "root"); // mix AFTER the adds — stays in the SAME region (no split)
        }

        h.AddParticle("P1", "root");
        for (int i = 0; i < 6; i++)
        {
            h.AddFullRect($"c{i}", "root"); // region 2
        }

        h.StabilizeAll();
        // Add is not bottom-only → no add ids passed.
        var plan = h.PlanNow();
        Check.That(plan.IsBakeable, "band with interleaved Add/Mix bakes (multi-region)");

        StaticBakeRegion? upper = null;
        foreach (var r in plan.Regions)
        {
            if (Contains(r.BakedIds, "b0"))
            {
                upper = r;
            }
        }

        Check.That(upper is not null, "found the upper region holding b0");
        var reg = upper!.Value;
        Check.That(Contains(reg.BakedIds, "add0") && Contains(reg.BakedIds, "add1"),
            "both Add painters bake into the region's single quad");
        Check.That(Contains(reg.BakedIds, "d0") && Contains(reg.BakedIds, "d1") && Contains(reg.BakedIds, "d2"),
            "the mix run AFTER the adds stays in the SAME region (no mix-after-add split)");

        // add0/add1 are never re-leveled live.
        foreach (var lz in plan.LiveZ)
        {
            Check.That(lz.Id != "add0" && lz.Id != "add1", "adds never re-leveled live");
        }
    }

    // A Sub/Mul painter is bottom-only → in an upper segment it ends the segment and stays LIVE (re-leveled), exactly
    // like a particle. (Add is NOT bottom-only — covered by AddInUpperSegmentBakes.)
    private static void SubMulInUpperSegmentStaysLive()
    {
        foreach (int blend in new[] { 2, 3 })
        {
            var h = new Harness();
            h.AddGroup("root", null);
            for (int i = 0; i < 6; i++)
            {
                h.AddFullRect($"a{i}", "root");
            }

            h.AddParticle("P0", "root");
            for (int i = 0; i < 4; i++)
            {
                h.AddFullRect($"b{i}", "root");
            }

            var nonadd = h.AddFullRect("nonadd", "root");
            nonadd.CanvasBlendMode = blend; // Sub / Mul
            for (int i = 0; i < 4; i++)
            {
                h.AddFullRect($"c{i}", "root");
            }

            h.StabilizeAll();
            var bottomOnly = new HashSet<string>(System.StringComparer.Ordinal) { "nonadd" };
            var plan = h.PlanNow(bottomOnly: bottomOnly);
            Check.That(plan.IsBakeable, $"blend {blend}: band bakes around the Sub/Mul painter");
            foreach (var r in plan.Regions)
            {
                Check.That(!Contains(r.BakedIds, "nonadd"), $"blend {blend}: Sub/Mul not baked");
            }

            bool live = false;
            foreach (var lz in plan.LiveZ)
            {
                if (lz.Id == "nonadd")
                {
                    live = true;
                }
            }

            Check.That(live, $"blend {blend}: Sub/Mul re-leveled live");
        }
    }

    // With an Add and a Sub/Mul in the SAME upper segment: the Add BAKES (variant) but the Sub/Mul stays bottom-only
    // (re-leveled live) — Add is bakeable everywhere, Sub/Mul is not.
    private static void SubMulStayBottomOnlyWhenAddBakes()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 6; i++)
        {
            h.AddFullRect($"a{i}", "root"); // region 0
        }

        h.AddParticle("P0", "root");
        for (int i = 0; i < 4; i++)
        {
            h.AddFullRect($"b{i}", "root"); // upper run
        }

        var add0 = h.AddFullRect("add0", "root");
        add0.CanvasBlendMode = 1; // Add — bakes into the region

        // A Sub after the Add ends the segment; the trailing statics form another region above it.
        var sub0 = h.AddFullRect("sub0", "root");
        sub0.CanvasBlendMode = 2; // Sub — bottom-only, stays live
        for (int i = 0; i < 4; i++)
        {
            h.AddFullRect($"c{i}", "root"); // region above the Sub
        }

        h.StabilizeAll();
        var bottomOnly = new HashSet<string>(System.StringComparer.Ordinal) { "sub0" };
        var plan = h.PlanNow(bottomOnly: bottomOnly);
        Check.That(plan.IsBakeable, "band bakes with Add baked and Sub live");

        var baked = new HashSet<string>();
        foreach (var r in plan.Regions)
        {
            foreach (var id in r.BakedIds)
            {
                baked.Add(id);
            }
        }

        Check.That(baked.Contains("add0"), "the Add painter bakes (variant)");
        Check.That(!baked.Contains("sub0"), "the Sub painter does NOT bake");
        bool subLive = false;
        foreach (var lz in plan.LiveZ)
        {
            if (lz.Id == "sub0")
            {
                subLive = true;
            }
        }

        Check.That(subLive, "the Sub painter is re-leveled live");
    }

    // ---- Track-P3c band relax + scoped invalidation -----------------------------------------------------------------

    // A background-bucket node (effZ == the bottom bucket) settles under the RELAXED window (~half); a gameplay-bucket
    // node touched at the same instant is still strict-unstable at the same frame count.
    private static void BandBucketUsesRelaxedStabilityWindow()
    {
        var h = new Harness();
        h.AddGroup("root", null); // effZ 0, non-painting
        for (int i = 0; i < 13; i++)
        {
            var b = h.AddFullRect($"band{i}", "root");
            b.ZIndex = -10; // effZ -10 = the bottom bucket
        }

        var gp = h.AddFullRect("gp", "root"); // effZ 0 = the gameplay bucket, a band SIBLING (not an ancestor)
        h.StabilizeAll();
        Check.That(Contains(h.PlanNow().BakedIds, "band6"), "band baked when fully settled");

        h.Drain("band6", "gp"); // touch a band-bucket node and a gameplay-bucket node together
        h.Frames(MinStableFramesBandLocal - 2);
        Check.That(!Contains(h.PlanNow().BakedIds, "band6"), "band node still unstable below the relaxed frame window");

        h.Frames(4); // now past the relaxed window (10) but below the strict window (20)
        Check.That(Contains(h.PlanNow().BakedIds, "band6"), "band node re-stable within the RELAXED window");
        Check.That(!Contains(h.PlanNow().BakedIds, "gp"), "gameplay-bucket node still strict-unstable at the same frame");
    }

    private static readonly int MinStableFramesBandLocal = StaticBakePlanner.MinStableFramesBand;

    // A change to one region's baked member scopes to exactly that region (per-region watch); an unrelated id touches
    // none.
    private static void RegionsTouchedByScopesToTheTouchedRegion()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        BuildBand(h, "root", runs: 3, runSize: 12);
        h.StabilizeAll();
        var plan = h.PlanNow();
        Check.That(plan.Regions.Count >= 3, "multi-region formed");

        string mem = plan.Regions[2].BakedIds[plan.Regions[2].BakedIds.Count - 1]; // a leaf unique to region 2
        var touched = plan.RegionsTouchedBy(new HashSet<string>(System.StringComparer.Ordinal) { mem });
        Check.Equal(touched.Count, 1, "exactly one region touched");
        Check.Equal(touched[0], 2, "the touched region is region 2");

        var none = plan.RegionsTouchedBy(new HashSet<string>(System.StringComparer.Ordinal) { "nonexistent" });
        Check.Equal(none.Count, 0, "an unrelated change touches no region");
    }

    // Position-stable z: when the TOP region drops out (its member destabilizes and ends the band there), the surviving
    // lower regions keep their EXACT quad z (nothing re-packs) — the invariant that lets the controller spare them.
    private static void PositionStableZSurvivesUpperSlotRemoval()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        BuildBand(h, "root", runs: 3, runSize: 12);
        h.StabilizeAll();
        var before = h.PlanNow();
        Check.Equal(before.Regions.Count, 3, "three regions before the change");
        int r0z = before.Regions[0].QuadZ;
        int r1z = before.Regions[1].QuadZ;

        h.Drain(before.Regions[2].BakedIds[0]); // destabilize the FIRST member of the top region → band ends there
        var after = h.PlanNow();
        Check.Equal(after.Regions.Count, 2, "the top region dropped out");
        Check.Equal(after.Regions[0].QuadZ, r0z, "region 0 quad z unchanged (position-stable)");
        Check.Equal(after.Regions[1].QuadZ, r1z, "region 1 quad z unchanged (position-stable)");
    }

    // Build a same-bucket static band under `parent`: `runs` static runs of `runSize` painters each, separated by a
    // PARTICLE. Node ids: run{r}_{i} for statics, P{r} for the particle after run r.
    private static void BuildBand(Harness h, string parent, int runs, int runSize)
    {
        for (int r = 0; r < runs; r++)
        {
            for (int i = 0; i < runSize; i++)
            {
                h.AddFullRect($"run{r}_{i}", parent);
            }

            if (r < runs - 1)
            {
                h.AddParticle($"P{r}", parent);
            }
        }
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private static IReadOnlySet<string> AllIds(Harness h) => new HashSet<string>(h.State.Nodes.Keys);

    private static bool Contains(IReadOnlyList<string> ids, string id)
    {
        foreach (var x in ids)
        {
            if (x == id)
            {
                return true;
            }
        }

        return false;
    }

    // A 12-painter z=-10 band under a static z=0 shader carrier (the shape all three carrier-reject tests share).
    private static Harness BandUnderCarrier(out MirrorNode carrier)
    {
        var h = new Harness();
        carrier = h.AddGroup("carrier", null);
        carrier.LocalRect = new MirrorRect(0, 0, 1920, 1080);
        carrier.TextureUrl = "res://bg.png";
        carrier.ShaderId = "res://water.gdshader"; // self-rejects (Effect); still a valid static ancestor
        for (int i = 0; i < 12; i++)
        {
            var b = h.AddFullRect($"band{i}", "carrier");
            b.ZIndex = -10;
        }

        return h;
    }

    private sealed class Harness
    {
        public readonly MirrorState State = MirrorState.Create();
        public readonly GlobalTransformIndex Transforms = new();
        public readonly StaticBakePlanner Planner = new();
        public double DesignWidth = Width;


        public MirrorNode AddGroup(string id, string? parent)
        {
            var n = new MirrorNode { Id = id, ParentId = parent, Transform = Identity() };
            State.Nodes[id] = n;
            State.OrderedIds.Add(id);
            return n;
        }

        public MirrorNode AddFullRect(string id, string? parent) => AddRect(id, parent, 0, 0, 1920, 1080);

        // A full-screen particle node (the planner only reads ParticleSpec != null; an uninitialized instance suffices).
        public MirrorNode AddParticle(string id, string? parent)
        {
            var n = AddRect(id, parent, 0, 0, 1920, 1080);
            n.ParticleSpec = (MirrorParticleSpec)System.Runtime.CompilerServices.RuntimeHelpers
                .GetUninitializedObject(typeof(MirrorParticleSpec));
            return n;
        }

        // Paint position of an id under the harness's effZ ordering (all test bands share one effZ bucket, so the paint
        // order is the insertion order over live nodes — mirror the planner's stable sort).
        public int PaintPos(string id)
        {
            var effZ = new Dictionary<string, int>(System.StringComparer.Ordinal);
            var pre = new Dictionary<string, int>(System.StringComparer.Ordinal);
            int idx = 0;
            foreach (var oid in State.OrderedIds)
            {
                if (!State.Nodes.ContainsKey(oid))
                {
                    continue;
                }

                var node = State.Nodes[oid];
                int baseZ = node.ParentId is { } pid && effZ.TryGetValue(pid, out var pz) ? pz : 0;
                effZ[oid] = baseZ + (node.ZIndex ?? 0);
                pre[oid] = idx++;
            }

            var order = new List<string>(pre.Keys);
            order.Sort((a, b) => effZ[a] != effZ[b] ? effZ[a].CompareTo(effZ[b]) : pre[a].CompareTo(pre[b]));
            return order.IndexOf(id);
        }

        public MirrorNode AddRect(string id, string? parent, double x, double y, double w, double h)
        {
            var n = AddGroup(id, parent);
            n.LocalRect = new MirrorRect(x, y, w, h);
            n.FillColor = new MirrorColor(1, 1, 1, 1, "#ffffffff");
            return n;
        }

        // Replicates the planner's effZ forward pass for QuadZBoundaryInvariant (parent-before-child in OrderedIds).
        public int EffZ(string id)
        {
            int z = 0;
            string? cur = id;
            while (cur is not null && State.Nodes.TryGetValue(cur, out var node))
            {
                z += node.ZIndex ?? 0;
                cur = node.ParentId;
            }

            return z;
        }

        public void Drain(params string[] changed) => Drain((IReadOnlySet<string>)new HashSet<string>(changed));

        public void Drain(IReadOnlySet<string> changed) =>
            Planner.ObserveDrain(State, changed, System.Array.Empty<string>(), keyframe: false);

        public void DrainNoTouch() =>
            Planner.ObserveDrain(State, new HashSet<string>(), System.Array.Empty<string>(), keyframe: false);

        public void StabilizeAll()
        {
            Transforms.Update(State);
            Drain((IReadOnlySet<string>)new HashSet<string>(State.Nodes.Keys)); // seed at drain 1, frame 0
            for (int i = 0; i < StaticBakePlanner.MinStableFrames + 2; i++)
            {
                Planner.ObserveFrame();
            }

            for (int i = 0; i < StaticBakePlanner.MinStableDrains + 1; i++)
            {
                DrainNoTouch();
            }
        }

        public StaticBakePlan PlanNow(string? excluded = null, string? effectStaticOk = null,
            IReadOnlySet<string>? bottomOnly = null)
        {
            Transforms.Update(State);
            var ex = excluded is null ? EmptySet : new HashSet<string> { excluded };
            var ok = effectStaticOk is null ? EmptySet : new HashSet<string> { effectStaticOk };
            return Planner.Plan(State, Transforms, DesignWidth, ex, ok, bottomOnly);
        }

        // Advance N wall-clock frames with no drain (frame-stability accrual + drain-quiescence bypass).
        public void Frames(int n)
        {
            for (int i = 0; i < n; i++)
            {
                Planner.ObserveFrame();
            }
        }

        private static readonly HashSet<string> EmptySet = new();

        private static double[] Identity() => new double[] { 1, 0, 0, 1, 0, 0 };
    }
}
