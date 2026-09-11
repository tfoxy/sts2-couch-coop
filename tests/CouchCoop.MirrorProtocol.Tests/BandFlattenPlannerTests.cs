using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for WS-BGBAKE PlanBandFlatten (the K≤2 combat background band flatten). Covers: the two-quad split
// (quad A = statics below the LAST live interloper, quad B = the trailing static run), interloper bridging (a spine /
// particle / dynamic painter does NOT end the band, unlike the exact planner), the bottom-only Sub/Mul rules (bottom
// prefix bakes, above the first interloper stays live), position-stable slot z ordering (strictly increasing with
// paint position, interlopers sandwiched between the quads, all below bucketZ), the budget / bucketZ≥0 / deep-band
// refusals, the sub-threshold trailing run, the no-interloper single-region shape, purity (a flatten call never
// perturbs a following exact Plan), and that the gameplay bucket is never touched. Plus the OrderChanged order guard:
// BandIds = the exact band prefix (null on the exact path) and IsBandOrderUnchanged's keep/tear-down verdicts.
internal static class BandFlattenPlannerTests
{
    public static void Run()
    {
        TwoQuadSplitWithTrailingStatics();
        SpineInterloperBridged();
        DynamicallyExcludedPainterStaysLive();
        UnstableBandPainterStaysLive();
        BottomOnlyBakesInBottomPrefixOnly();
        SubMulOpeningASegmentStaysLive();
        SlotZOrderingPreservesPaintOrder();
        NoInterlopersEmitsOneNaturalZRegion();
        SubThresholdTrailingRunStaysLive();
        BudgetRejectsTooFewPainters();
        BudgetRejectsLowCoverage();
        ZeroBucketRefusesAndExactPathStillBakes();
        DeepBandRefusesRatherThanClamp();
        OpenClipMemberDemotesToLive();
        FlattenIsPureBeforeExactPlan();
        GameplayBucketUntouched();

        // WS-BGBAKE order guard: BandIds identity + IsBandOrderUnchanged (the OrderChanged keep-alive).
        BandIdsMatchTheBandPrefix();
        ExactPathPlanHasNullBandIds();
        OrderGuardTrueWhenGameplayReordered();
        OrderGuardFalseWhenBandMembersSwap();
        OrderGuardFalseWhenInterloperRemoved();
        OrderGuardFalseOnZMigration();

        // WS-BGBAKE room bench (band repeat offenders exiled for the room) + the drain-decision policy truth table.
        RoomBenchSecondStrikeExilesForTheRoom();
        RoomBenchSurvivesKeyframeResetsOnScreenChange();
        RoomBenchedAncestorNeverRejectsTheBand();
        PolicyTruthTable();

        // WS-BGBAKE subtree bench (the fading Intents-row carrier exiled with its whole subtree).
        SubtreeBenchExilesCarrierSubtree();
        SubtreeBenchSurvivesKeyframeResetsOnScreenChange();

        // WS-BGBAKE round 3: the static exclusion policy (creature/HUD/VFX live-subtree roots).
        ExclusionPolicyCollapsesCreatureSubtree();
        CrossBucketDescendantFallsBackPerPainter();

        // WS-BGBAKE round 3: guard tolerance under excluded-subtree churn + keyframe stability preservation.
        GuardToleratesExcludedSubtreeChurn();
        KeyframePreservesBandStability();
    }

    private const double Width = 1920;
    private const int BandZ = -10;

    // ---- the segmented split (ordering-exact: one region per contiguous static run) ------------------------------

    private static void TwoQuadSplitWithTrailingStatics()
    {
        // Round 3: each contiguous static run between recorded interlopers is its OWN region — the induced order
        // (quads at anchors + live ids at positions) is order-isomorphic to the band paint order, so mid-band
        // occlusion is exact (no member is ever hoisted across an interloper).
        var h = new Harness();
        h.AddGroup("root", null); // effZ 0 — becomes a CARRIER for the band members
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("m", 6);
        h.AddBandParticle("P1");
        h.AddBandStatics("t", 4);
        h.AddFullRect("gp", "root"); // effZ 0 gameplay painter — must stay untouched

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "interleaved band flattens");
        Check.Equal(plan.Regions.Count, 3, "one region per static run: s8 | m6 | t4");

        var r0 = plan.Regions[0];
        var r1 = plan.Regions[1];
        var r2 = plan.Regions[2];
        for (int i = 0; i < 8; i++)
        {
            Check.That(Contains(r0.BakedIds, $"s{i}"), $"s{i} in region 0");
        }

        for (int i = 0; i < 6; i++)
        {
            Check.That(Contains(r1.BakedIds, $"m{i}"), $"m{i} in its OWN region (never hoisted under P0)");
        }

        for (int i = 0; i < 4; i++)
        {
            Check.That(Contains(r2.BakedIds, $"t{i}"), $"trailing t{i} in region 2");
        }

        Check.Equal(r0.BakedIds.Count, 8, "region 0 = the 8 bottom statics");
        Check.Equal(r1.BakedIds.Count, 6, "region 1 = the 6 mid statics");
        Check.Equal(r2.BakedIds.Count, 4, "region 2 = the 4 trailing statics");
        Check.That(Contains(r0.CarrierIds, "root") && Contains(r2.CarrierIds, "root"),
            "the z=0 parent carries every region");

        // The particles re-level live, sandwiched between CONSECUTIVE quads (ordering-exact).
        Check.Equal(plan.LiveZ.Count, 2, "both particles re-leveled live");
        int zP0 = LiveZOf(plan, "P0")!.Value;
        int zP1 = LiveZOf(plan, "P1")!.Value;
        Check.That(r0.QuadZ < zP0 && zP0 < r1.QuadZ && r1.QuadZ < zP1 && zP1 < r2.QuadZ,
            "R0 < P0 < R1 < P1 < R2 — the exact band order");
        Check.That(r2.QuadZ < BandZ, "everything re-leveled strictly below the bucket z");
        Check.That(plan.ExcludedLiveRoots is { Count: 0 }, "band plan carries an (empty) excluded-roots list");
    }

    private static void SpineInterloperBridged()
    {
        // The exact planner ends its band at a spine; the flatten BRIDGES it — statics below land in quad A, the
        // trailing statics above it in quad B, the spine re-levels live between them.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        var sp = h.AddBandStatic("spine");
        sp.SpineSceneResPath = "res://creature.tscn";
        h.AddBandStatics("t", 8);

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "spine-interrupted band flattens");
        Check.Equal(plan.Regions.Count, 2, "statics below AND above the spine bake");
        Check.That(Contains(plan.Regions[0].BakedIds, "s7"), "static below the spine in quad A");
        Check.That(Contains(plan.Regions[1].BakedIds, "t0"), "static above the spine in quad B");
        Check.Equal(plan.LiveZ.Count, 1, "the spine is the only live slot");
        int zs = LiveZOf(plan, "spine")!.Value;
        Check.That(plan.Regions[0].QuadZ < zs && zs < plan.Regions[1].QuadZ, "spine sandwiched between the quads");
    }

    private static void DynamicallyExcludedPainterStaysLive()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandStatic("tweened"); // tween/anim/lift-owned per the controller's excluded set
        h.AddBandStatics("t", 8);

        h.StabilizeAll();
        var plan = h.PlanBand(excluded: "tweened");
        Check.That(plan.IsBakeable, "band flattens around the dynamically-excluded painter");
        Check.Equal(plan.Regions.Count, 2, "excluded painter splits A from the trailing B");
        Check.That(!Contains(plan.Regions[0].BakedIds, "tweened") && !Contains(plan.Regions[1].BakedIds, "tweened"),
            "excluded painter is not baked");
        Check.Equal(LiveZOf(plan, "tweened") is int ? 1 : 0, 1, "excluded painter re-leveled live");
    }

    private static void UnstableBandPainterStaysLive()
    {
        // A late-settling band painter no longer zeroes the plan (the exact planner's failure mode) — it just joins
        // the live re-level list.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandStatic("late");
        h.AddBandStatics("t", 8);

        h.StabilizeAll();
        h.Drain("late"); // just changed → unstable under both windows
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "band still flattens with an unstable painter live");
        Check.That(!Contains(plan.Regions[0].BakedIds, "late"), "unstable painter not baked");
        Check.Equal(plan.LiveZ.Count, 1, "unstable painter re-leveled live");
    }

    // ---- bottom-only (Sub/Mul) rules: the SEGMENT-LOCAL premise --------------------------------------------------

    private static void BottomOnlyBakesInBottomPrefixOnly()
    {
        // Round 3: a Sub/Mul member may bake wherever a PAINTING member of its OWN segment precedes it (its blend
        // then composites onto in-quad pixels) — the round-2 bottom-prefix-only rule is gone, so sub1 now BAKES.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 3);
        var sub0 = h.AddBandStatic("sub0"); // 3 painting members of its segment precede it → bakes
        sub0.CanvasBlendMode = 2;
        h.AddBandStatics("m", 4);
        h.AddBandParticle("P0");
        h.AddBandStatics("n", 3);
        var sub1 = h.AddBandStatic("sub1"); // 3 painting members of ITS OWN segment precede it → bakes too now
        sub1.CanvasBlendMode = 2;
        h.AddBandStatics("t", 4);

        h.StabilizeAll();
        var bottomOnly = new HashSet<string>(System.StringComparer.Ordinal) { "sub0", "sub1" };
        var plan = h.PlanBand(bottomOnly: bottomOnly);
        Check.That(plan.IsBakeable, "band with Sub painters flattens");
        Check.Equal(plan.Regions.Count, 2, "two runs around the particle");
        Check.That(Contains(plan.Regions[0].BakedIds, "sub0"), "seg-0 Sub bakes (painting members precede it)");
        Check.That(Contains(plan.Regions[1].BakedIds, "sub1"),
            "an upper-segment Sub with in-segment painters below it now BAKES (segment-local premise)");
        Check.That(LiveZOf(plan, "P0") is int, "the particle re-levels live");
        Check.That(Contains(plan.Regions[^1].BakedIds, "t0"), "trailing statics bake in the same region");
    }

    private static void SubMulOpeningASegmentStaysLive()
    {
        // The premise's other half: a Sub/Mul member with NO painting member of its own segment before it (here it
        // would OPEN the post-particle segment) demotes to live — its demotion is a new cut, and the statics above
        // it form their own region.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 6);
        h.AddBandParticle("P0");
        var subX = h.AddBandStatic("subX"); // would open the second segment → premise violated → live
        subX.CanvasBlendMode = 3;
        h.AddBandStatics("u", 4);

        h.StabilizeAll();
        var bottomOnly = new HashSet<string>(System.StringComparer.Ordinal) { "subX" };
        var plan = h.PlanBand(bottomOnly: bottomOnly);
        Check.That(plan.IsBakeable, "band flattens around the demoted Sub");
        Check.Equal(plan.Regions.Count, 2, "s-run + u-run (the demoted Sub cuts between them)");
        foreach (var r in plan.Regions)
        {
            Check.That(!Contains(r.BakedIds, "subX"), "the segment-opening Sub is not baked");
        }

        Check.That(LiveZOf(plan, "subX") is int, "it re-levels live at its own slot");
        int zP = LiveZOf(plan, "P0")!.Value;
        int zS = LiveZOf(plan, "subX")!.Value;
        Check.That(plan.Regions[0].QuadZ < zP && zP < zS && zS < plan.Regions[1].QuadZ,
            "R0 < P0 < subX < R1 — ordering exact around the demotion");
    }

    // ---- ordering invariants -------------------------------------------------------------------------------------

    private static void SlotZOrderingPreservesPaintOrder()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 7);
        h.AddBandParticle("P0");
        h.AddBandStatics("m", 5);
        h.AddBandParticle("P1");
        h.AddBandStatics("n", 4);
        h.AddBandParticle("P2");
        h.AddBandStatics("t", 5);

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable && plan.Regions.Count == 4, "one region per static run (K=4)");

        // Every slot (region anchored at its FIRST member's paint position + every live painter) must be strictly
        // increasing in z with paint position and strictly below the bucket z.
        var slots = new List<(int Pos, int Z)>();
        foreach (var r in plan.Regions)
        {
            int minPos = int.MaxValue;
            foreach (var id in r.BakedIds)
            {
                minPos = System.Math.Min(minPos, h.PaintPos(id));
            }

            slots.Add((minPos, r.QuadZ));
        }

        foreach (var lz in plan.LiveZ)
        {
            slots.Add((h.PaintPos(lz.Id), lz.Z));
        }

        slots.Sort((a, b) => a.Pos.CompareTo(b.Pos));
        for (int i = 0; i < slots.Count; i++)
        {
            Check.That(slots[i].Z < BandZ, $"slot z {slots[i].Z} below bucket z {BandZ}");
            if (i > 0)
            {
                Check.That(slots[i - 1].Z < slots[i].Z, "slot z strictly increases with paint position");
            }
        }

        // Member paint positions are monotone per region and BuildOrder is pre-order (parents first).
        foreach (var r in plan.Regions)
        {
            int last = -1;
            foreach (var id in r.BakedIds)
            {
                int pos = h.PaintPos(id);
                Check.That(pos > last, "region members stay in paint order");
                last = pos;
            }

            var seen = new HashSet<string>(System.StringComparer.Ordinal);
            foreach (var id in r.BuildOrder)
            {
                var pid = h.State.Nodes[id].ParentId;
                if (pid is not null && (Contains(r.BakedIds, pid) || Contains(r.CarrierIds, pid)))
                {
                    Check.That(seen.Contains(pid), $"parent {pid} built before {id}");
                }

                seen.Add(id);
            }
        }
    }

    private static void NoInterlopersEmitsOneNaturalZRegion()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 12);

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "pure static band flattens");
        Check.Equal(plan.Regions.Count, 1, "no interlopers → a single region");
        Check.Equal(plan.LiveZ.Count, 0, "nothing re-leveled");
        Check.Equal(plan.QuadZ, BandZ, "the single quad takes the band's natural boundary z");
        Check.Equal(plan.Regions[0].BakedIds.Count, 12, "all 12 band statics baked");
    }

    private static void SubThresholdTrailingRunStaysLive()
    {
        // A trailing run under MinPaintersPerRegion is not worth its own viewport — it re-levels live ABOVE the last
        // interloper instead (K degrades to 1).
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("t", StaticBakePlanner.MinPaintersPerRegion - 1);

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "quad A still bakes");
        Check.Equal(plan.Regions.Count, 1, "sub-threshold trailing run forms no quad B");
        Check.Equal(plan.LiveZ.Count, 1 + (StaticBakePlanner.MinPaintersPerRegion - 1),
            "particle + the trailing statics all re-level live");
        int zP = LiveZOf(plan, "P0")!.Value;
        int zT = LiveZOf(plan, "t0")!.Value;
        Check.That(plan.Regions[0].QuadZ < zP && zP < zT, "trailing statics stay ABOVE the particle (paint order)");
    }

    // ---- refusals ------------------------------------------------------------------------------------------------

    private static void BudgetRejectsTooFewPainters()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", StaticBakePlanner.BandMinPainters - 1); // 5 painters — one short
        h.AddBandParticle("P0");

        h.StabilizeAll();
        Check.That(!h.PlanBand().IsBakeable, "fewer than BandMinPainters → no flatten");
        Check.Equal(h.Planner.LastDiagnostic.BoundaryReason, BakeReject.BudgetGate, "reason is budget");
    }

    private static void BudgetRejectsLowCoverage()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            var n = h.AddRect($"tiny{i}", "root", 0, 0, 10, 10); // 12 painters, trivial fill
            n.ZIndex = BandZ;
        }

        h.AddBandParticle("P0");
        h.StabilizeAll();
        Check.That(!h.PlanBand().IsBakeable, "coverage under the budget → no flatten");
        Check.Equal(h.Planner.LastDiagnostic.BoundaryReason, BakeReject.BudgetGate, "reason is budget");
    }

    private static void ZeroBucketRefusesAndExactPathStillBakes()
    {
        // A flat z=0 scene (the spine-background combat family shape): flatten refuses with NoBand, while the exact
        // Plan() on the same state IS bakeable — the controller's fall-through keeps today's behavior byte-identical.
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            h.AddFullRect($"bg{i}", "root");
        }

        h.StabilizeAll();
        var flat = h.PlanBand();
        Check.That(!flat.IsBakeable, "bucketZ ≥ 0 → flatten refuses");
        Check.Equal(h.Planner.LastDiagnostic.BoundaryReason, BakeReject.NoBand, "reason is NoBand");
        Check.That(h.PlanExact().IsBakeable, "the exact path still bakes the same scene (fall-through target)");
    }

    private static void DeepBandRefusesRatherThanClamp()
    {
        // A band whose position-stable floor would cross −MaxZIndex refuses outright (clamping would collide slots).
        var h = new Harness();
        h.AddGroup("root", null);
        for (int i = 0; i < 10; i++)
        {
            var n = h.AddFullRect($"s{i}", "root");
            n.ZIndex = -StaticBakePlanner.MaxZIndex + 6; // bucket −4090; bandCount 16 → floor −4106 < −4096
        }

        var p = h.AddParticle("P0", "root");
        p.ZIndex = -StaticBakePlanner.MaxZIndex + 6;
        for (int i = 0; i < 5; i++)
        {
            var n = h.AddFullRect($"t{i}", "root");
            n.ZIndex = -StaticBakePlanner.MaxZIndex + 6;
        }

        h.StabilizeAll();
        Check.That(!h.PlanBand().IsBakeable, "pathologically deep band refused, never clamped");
    }

    // ---- containment ---------------------------------------------------------------------------------------------

    private static void OpenClipMemberDemotesToLive()
    {
        // A member that clips a LIVE (ineligible) child is that child's stencil — in flatten mode it DEMOTES to a
        // live interloper (the exact planner would cut the whole prefix there instead).
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        var clip = h.AddBandStatic("clip");
        clip.ClipChildren = 1;
        var inner = h.AddBandStatic("inner", parent: "clip"); // effZ −10 via the chain? no — give it z 0 under clip
        inner.ZIndex = 0;                                     // effZ stays −10 (inherits the clip's band z)
        inner.ShaderId = "res://x.gdshader";                  // ineligible → live child under the clip
        h.AddBandStatics("t", 8);

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "band still flattens around the demoted clip member");
        foreach (var r in plan.Regions)
        {
            Check.That(!Contains(r.BakedIds, "clip"), "the open clip member is not baked");
        }

        Check.That(LiveZOf(plan, "clip") is int, "the open clip member re-levels live (stencil stays)");
    }

    // ---- purity / scoping ----------------------------------------------------------------------------------------

    private static void FlattenIsPureBeforeExactPlan()
    {
        // PlanBandFlatten leaves no residue: an exact Plan right after it matches an exact Plan on a fresh walk.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("t", 8);

        h.StabilizeAll();
        var exactAlone = h.PlanExact();
        h.PlanBand(); // interleave a flatten call
        var exactAfter = h.PlanExact();
        Check.Equal(exactAfter.Regions.Count, exactAlone.Regions.Count, "region count unchanged after a flatten call");
        Check.Equal(exactAfter.BakedIds.Count, exactAlone.BakedIds.Count, "baked set unchanged after a flatten call");
        Check.Equal(exactAfter.QuadZ, exactAlone.QuadZ, "quad z unchanged after a flatten call");
    }

    private static void GameplayBucketUntouched()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("t", 8);
        h.AddFullRect("hero", "root"); // effZ 0
        var fx = h.AddFullRect("vfx", "root");
        fx.ZIndex = 5;

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "band flattens under live gameplay");
        foreach (var r in plan.Regions)
        {
            Check.That(!Contains(r.BakedIds, "hero") && !Contains(r.BakedIds, "vfx"),
                "gameplay-bucket painters never baked");
        }

        Check.That(LiveZOf(plan, "hero") is null && LiveZOf(plan, "vfx") is null,
            "gameplay-bucket painters never re-leveled");
    }

    // ---- WS-BGBAKE order guard (BandIds + IsBandOrderUnchanged) --------------------------------------------------

    // The shared guard scene: an 8+P0+8 band under a z=0 root, plus two z=0 gameplay painters whose reorder must NOT
    // count as a band change.
    private static Harness GuardScene(out StaticBakePlan plan)
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("t", 8);
        h.AddFullRect("gpA", "root");
        h.AddFullRect("gpB", "root");
        h.StabilizeAll();
        plan = h.PlanBand();
        Check.That(plan.IsBakeable, "guard scene flattens");
        return h;
    }

    private static void BandIdsMatchTheBandPrefix()
    {
        var h = GuardScene(out var plan);
        var expected = new List<string>();
        for (int i = 0; i < 8; i++)
        {
            expected.Add($"s{i}");
        }

        expected.Add("P0");
        for (int i = 0; i < 8; i++)
        {
            expected.Add($"t{i}");
        }

        Check.That(plan.BandIds is not null, "flatten plan carries BandIds");
        Check.Equal(plan.BandIds!.Count, expected.Count, "BandIds spans the WHOLE band prefix (members + interlopers)");
        for (int i = 0; i < expected.Count; i++)
        {
            Check.Equal(plan.BandIds[i], expected[i], $"BandIds[{i}] is the band's paint-order id");
        }

        Check.That(h.Planner.IsBandOrderUnchanged(h.State, plan.BandIds), "untouched state ⇒ band order unchanged");
    }

    private static void ExactPathPlanHasNullBandIds()
    {
        // The exact planner's plans never carry BandIds (its controller handling must stay byte-identical) — neither
        // does a flatten REFUSAL (None).
        var h = GuardScene(out _);
        Check.That(h.PlanExact().BandIds is null, "exact-path plan has null BandIds");
        Check.That(h.PlanExact().ExcludedLiveRoots is null, "exact-path plan has null ExcludedLiveRoots");

        var flat = new Harness();
        flat.AddGroup("root", null);
        for (int i = 0; i < 12; i++)
        {
            flat.AddFullRect($"bg{i}", "root");
        }

        flat.StabilizeAll();
        Check.That(flat.PlanBand().BandIds is null, "a flatten refusal (None) has null BandIds");
    }

    private static void OrderGuardTrueWhenGameplayReordered()
    {
        // A z≥0-only reorder (the ~7/s combat case: hand cards, damage numbers) leaves the band prefix untouched.
        var h = GuardScene(out var plan);
        Swap(h.State.OrderedIds, "gpA", "gpB");
        Check.That(h.Planner.IsBandOrderUnchanged(h.State, plan.BandIds!),
            "gameplay-only reorder ⇒ band order unchanged (bake may stand)");
    }

    private static void OrderGuardFalseWhenBandMembersSwap()
    {
        var h = GuardScene(out var plan);
        Swap(h.State.OrderedIds, "s2", "s5");
        Check.That(!h.Planner.IsBandOrderUnchanged(h.State, plan.BandIds!),
            "two band members swapped ⇒ band order changed (tear down)");
    }

    private static void OrderGuardFalseWhenInterloperRemoved()
    {
        var h = GuardScene(out var plan);
        h.State.Nodes.Remove("P0");
        h.State.OrderedIds.Remove("P0");
        Check.That(!h.Planner.IsBandOrderUnchanged(h.State, plan.BandIds!),
            "interloper removed from the band ⇒ band order changed (tear down)");
    }

    private static void OrderGuardFalseOnZMigration()
    {
        // A node migrating INTO the band extends/reshapes the prefix; one migrating OUT shortens it — both fatal.
        var h = GuardScene(out var plan);
        h.State.Nodes["gpA"].ZIndex = BandZ; // gameplay painter drops into the band (appends to the prefix)
        Check.That(!h.Planner.IsBandOrderUnchanged(h.State, plan.BandIds!),
            "z-migration INTO the band ⇒ band order changed");

        var h2 = GuardScene(out var plan2);
        h2.State.Nodes["t7"].ZIndex = 0; // band member climbs out to the gameplay bucket
        Check.That(!h2.Planner.IsBandOrderUnchanged(h2.State, plan2.BandIds!),
            "z-migration OUT of the band ⇒ band order changed");
    }

    private static void Swap(List<string> ordered, string a, string b)
    {
        int ia = ordered.IndexOf(a);
        int ib = ordered.IndexOf(b);
        Check.That(ia >= 0 && ib >= 0, $"both {a} and {b} present in OrderedIds");
        (ordered[ia], ordered[ib]) = (ordered[ib], ordered[ia]);
    }

    // ---- WS-BGBAKE room bench + drain-decision policy ------------------------------------------------------------

    // A band repeat offender (the ~9s wave banner) is exiled on its SECOND strike within the room: the next
    // PlanBandFlatten rejects it (Eligibility) and re-levels it as a LIVE interloper instead of re-baking it.
    private static void RoomBenchSecondStrikeExilesForTheRoom()
    {
        var h = GuardScene(out var plan);
        Check.That(Contains(plan.Regions[0].BakedIds, "s3"), "offender baked before any strike");

        h.Planner.RegisterBandInvalidation(new[] { "s3" });
        Check.That(!h.Planner.IsRoomBenched("s3"), "one strike does not bench");
        Check.That(Contains(h.PlanBand().Regions[0].BakedIds, "s3"), "still baked after the first strike");

        h.Planner.RegisterBandInvalidation(new[] { "s3" });
        Check.That(h.Planner.IsRoomBenched("s3"), "second strike benches for the room");
        var exiled = h.PlanBand();
        Check.That(exiled.IsBakeable, "band still flattens around the exiled offender");
        foreach (var r in exiled.Regions)
        {
            Check.That(!Contains(r.BakedIds, "s3"), "room-benched member is not baked");
        }

        Check.That(LiveZOf(exiled, "s3") is int, "room-benched member re-levels as a live interloper");
    }

    // The room boundary is a SCREEN-TYPE change, not a keyframe: a mid-room resync/looping-replay keyframe re-sends
    // the same room and must NOT un-exile learned offenders (that reset re-taught the wave banner's 2 strikes every
    // 25s replay loop). A screen-type flip (combat → rewards) empties the bench.
    private static void RoomBenchSurvivesKeyframeResetsOnScreenChange()
    {
        var h = GuardScene(out _);
        long epochBefore = h.Planner.RoomEpoch;
        h.Planner.RegisterBandInvalidation(new[] { "s3" });
        h.Planner.RegisterBandInvalidation(new[] { "s3" });
        Check.That(h.Planner.IsRoomBenched("s3"), "benched in this room");

        h.Planner.ObserveDrain(h.State, new HashSet<string>(h.State.Nodes.Keys),
            System.Array.Empty<string>(), keyframe: true);
        Check.Equal((int)(h.Planner.RoomEpoch - epochBefore), 0, "a same-screen keyframe is NOT a room change");
        Check.That(h.Planner.IsRoomBenched("s3"), "the exile survives a mid-room resync keyframe");

        // A 1-delta screen-type blip (looping replay's leading "run" delta / transition flicker) is debounced away.
        h.State.ScreenType = "run";
        h.Planner.ObserveDrain(h.State, new HashSet<string>(), System.Array.Empty<string>(), keyframe: false);
        h.State.ScreenType = "combat";
        h.Planner.ObserveDrain(h.State, new HashSet<string>(), System.Array.Empty<string>(), keyframe: false);
        Check.Equal((int)(h.Planner.RoomEpoch - epochBefore), 0, "a transition blip is NOT a room change");
        Check.That(h.Planner.IsRoomBenched("s3"), "the exile survives the blip");

        // A PERSISTENT screen-type change (a real rewards screen) crosses the debounce and empties the bench.
        h.State.ScreenType = "rewards";
        for (int i = 0; i < StaticBakePlanner.RoomChangeDebounceDrains; i++)
        {
            h.Planner.ObserveDrain(h.State, new HashSet<string>(), System.Array.Empty<string>(), keyframe: false);
        }

        h.State.ScreenType = "combat";
        Check.Equal((int)(h.Planner.RoomEpoch - epochBefore), 1, "a persistent screen change bumps the epoch");
        Check.That(!h.Planner.IsRoomBenched("s3"), "the bench empties with the room (screen change)");

        h.StabilizeAll();
        Check.That(Contains(h.PlanBand().Regions[0].BakedIds, "s3"), "exile lifted in the new room");
    }

    // Defense-in-depth: even a (contract-violating) room bench of an ANCESTOR only suppresses that node's own
    // self-paint candidacy — it can never reject the band beneath it (the bench is deliberately NOT part of the
    // ancestor gate). The band keeps baking with the benched root as its carrier.
    private static void RoomBenchedAncestorNeverRejectsTheBand()
    {
        var h = GuardScene(out _);
        h.Planner.RegisterBandInvalidation(new[] { "root" });
        h.Planner.RegisterBandInvalidation(new[] { "root" });
        Check.That(h.Planner.IsRoomBenched("root"), "the carrier is (wrongly) benched");

        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "the band still bakes under a benched ancestor");
        Check.That(Contains(plan.Regions[0].BakedIds, "s0"), "members still baked");
        Check.That(Contains(plan.Regions[0].CarrierIds, "root"), "the benched ancestor still carries");
    }

    // The pure drain-decision classifier, row by row. Legend: m* = baked member, c* = carrier; spine = ancestor of
    // ALL baked members in every region; T = NodeChangeFlags.Transform.
    private static void PolicyTruthTable()
    {
        var members = new HashSet<string>(System.StringComparer.Ordinal) { "m1", "m2" };
        var spine = new HashSet<string>(System.StringComparer.Ordinal) { "cRoot", "cMid" };
        var flags = new Dictionary<string, NodeChangeFlags>(System.StringComparer.Ordinal);
        var bench = new HashSet<string>(System.StringComparer.Ordinal);
        var subtree = new HashSet<string>(System.StringComparer.Ordinal);

        BandDrainDecision Run(string[] changed, string[] hints)
        {
            bench.Clear();
            subtree.Clear();
            return BandInvalidationPolicy.Classify(
                changed, hints,
                id => flags.TryGetValue(id, out var f) ? f : NodeChangeFlags.None,
                members.Contains,
                spine.Contains,
                bench,
                subtree);
        }

        // No culprits at all -> None.
        Check.Equal((int)Run(new string[0], new string[0]), (int)BandDrainDecision.None, "no culprits -> None");

        // A baked member (any flags, even Transform-only) -> BenchAndTeardown, and it joins the bench set.
        flags["m1"] = NodeChangeFlags.Draw;
        Check.Equal((int)Run(new[] { "m1" }, new string[0]), (int)BandDrainDecision.BenchAndTeardown,
            "member Draw -> BenchAndTeardown");
        Check.That(bench.Contains("m1") && bench.Count == 1, "the member is registered for the room bench");

        flags["m1"] = NodeChangeFlags.Transform;
        Check.Equal((int)Run(new[] { "m1" }, new string[0]), (int)BandDrainDecision.BenchAndTeardown,
            "member Transform-only -> still BenchAndTeardown (members are never followed)");

        // A Transform-only change on a spine carrier -> Follow (screen shake / scene slide).
        flags["cRoot"] = NodeChangeFlags.Transform;
        Check.Equal((int)Run(new[] { "cRoot" }, new string[0]), (int)BandDrainDecision.Follow,
            "spine carrier Transform-only -> Follow");
        Check.Equal(bench.Count, 0, "a follow benches nothing");

        // Two spine carriers moving together (container + sub-container) -> still Follow.
        flags["cMid"] = NodeChangeFlags.Transform;
        Check.Equal((int)Run(new[] { "cRoot", "cMid" }, new string[0]), (int)BandDrainDecision.Follow,
            "both spine carriers Transform-only -> Follow");

        // Any non-Transform bit on a carrier -> Teardown (carriers are never benched).
        flags["cRoot"] = NodeChangeFlags.Transform | NodeChangeFlags.Tint;
        Check.Equal((int)Run(new[] { "cRoot" }, new string[0]), (int)BandDrainDecision.Teardown,
            "carrier Transform|Tint -> Teardown");
        flags["cRoot"] = NodeChangeFlags.Draw;
        Check.Equal((int)Run(new[] { "cRoot" }, new string[0]), (int)BandDrainDecision.Teardown,
            "carrier Draw -> Teardown");
        Check.Equal(bench.Count, 0, "a carrier culprit never joins the bench set");

        // A Transform-only NON-spine carrier (scoped to one region) -> Teardown.
        flags["cLocal"] = NodeChangeFlags.Transform;
        Check.Equal((int)Run(new[] { "cLocal" }, new string[0]), (int)BandDrainDecision.Teardown,
            "non-spine carrier Transform-only -> Teardown");

        // Member + follow-eligible carrier in the same drain -> BenchAndTeardown, benching ONLY the member.
        flags["cRoot"] = NodeChangeFlags.Transform;
        flags["m2"] = NodeChangeFlags.Text;
        Check.Equal((int)Run(new[] { "cRoot", "m2" }, new string[0]), (int)BandDrainDecision.BenchAndTeardown,
            "member + followable carrier -> BenchAndTeardown");
        Check.That(bench.Contains("m2") && !bench.Contains("cRoot") && bench.Count == 1,
            "only the member is benched");

        // Hints: a hint on a member registers + tears down; a hint on a carrier (even a Transform-only spine
        // carrier) tears down — a mid-tween quad would lag the live views.
        Check.Equal((int)Run(new string[0], new[] { "m1" }), (int)BandDrainDecision.BenchAndTeardown,
            "hint on member -> BenchAndTeardown");
        Check.That(bench.Contains("m1"), "the hinted member is benched");
        Check.Equal((int)Run(new string[0], new[] { "cRoot" }), (int)BandDrainDecision.Teardown,
            "hint on a spine carrier -> Teardown (never follow a tween blind)");
        Check.Equal((int)Run(new[] { "cRoot" }, new[] { "cMid" }), (int)BandDrainDecision.Teardown,
            "followable change + carrier hint -> Teardown");
        Check.Equal(subtree.Count, 0, "spine carriers are NEVER subtree-benched, changed or hint");

        // Subtree bench rows (the Intents case): a NON-spine carrier culprit -> Teardown AND it joins the subtree
        // bench set, whether it arrived as a changed id or as a hint target. A spine carrier never does.
        flags["cLocal"] = NodeChangeFlags.Transform;
        Check.Equal((int)Run(new[] { "cLocal" }, new string[0]), (int)BandDrainDecision.Teardown,
            "non-spine carrier (changed) -> Teardown");
        Check.That(subtree.Contains("cLocal") && subtree.Count == 1, "non-spine carrier joins the subtree bench");

        flags["cLocal"] = NodeChangeFlags.Tint;
        Check.Equal((int)Run(new string[0], new[] { "cLocal" }), (int)BandDrainDecision.Teardown,
            "non-spine carrier (hint, the Intents fade) -> Teardown");
        Check.That(subtree.Contains("cLocal") && subtree.Count == 1, "the hinted non-spine carrier joins too");

        Check.Equal((int)Run(new string[0], new[] { "cRoot" }), (int)BandDrainDecision.Teardown,
            "spine-carrier hint -> Teardown");
        Check.Equal(subtree.Count, 0, "but a spine carrier never joins the subtree bench");

        flags["m2"] = NodeChangeFlags.Text;
        Check.Equal((int)Run(new[] { "m2", "cLocal" }, new string[0]), (int)BandDrainDecision.BenchAndTeardown,
            "member + non-spine carrier -> BenchAndTeardown (member dominates)");
        Check.That(bench.Contains("m2") && subtree.Contains("cLocal"),
            "both registrations still emitted (member bench + carrier subtree bench)");
    }

    // ---- WS-BGBAKE subtree bench (non-spine carrier exiled WITH its subtree) -------------------------------------

    // The Intents shape: a non-painting band group ("intents") with two painting children, member-benched into a
    // CARRIER role (exactly how the real Intents row ended up), sitting mid-band so it is NOT a spine carrier.
    private static Harness IntentScene(out StaticBakePlan plan)
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        var intents = h.AddGroup("intents", "root"); // non-painting group in the band
        intents.ZIndex = BandZ;
        h.AddBandStatic("i0", parent: "intents");
        h.AddBandStatic("i1", parent: "intents");
        h.AddBandStatics("t", 8);
        h.StabilizeAll();

        // Two MEMBER strikes exile "intents" itself (it stops being a member) — but its bakeable children keep it
        // alive as a CARRIER, which is precisely the residual-teardown shape this feature fixes.
        h.Planner.RegisterBandInvalidation(new[] { "intents" });
        h.Planner.RegisterBandInvalidation(new[] { "intents" });
        plan = h.PlanBand();
        Check.That(plan.IsBakeable, "intent scene flattens");
        return h;
    }

    // Two SUBTREE strikes exile the carrier's whole subtree: its baked descendants leave the quads (re-leveled
    // live) and the carrier itself stops scaffolding (gone from CarrierIds) — while the rest of the band still bakes.
    private static void SubtreeBenchExilesCarrierSubtree()
    {
        var h = IntentScene(out var before);
        bool carried = false;
        foreach (var r in before.Regions)
        {
            Check.That(!Contains(r.BakedIds, "intents"), "member-benched group is not baked");
            if (Contains(r.CarrierIds, "intents"))
            {
                carried = true;
            }
        }

        Check.That(carried, "the exiled group still scaffolds its children as a CARRIER before the subtree bench");
        bool i0Baked = false;
        foreach (var r in before.Regions)
        {
            i0Baked |= Contains(r.BakedIds, "i0");
        }

        Check.That(i0Baked, "its children still bake before the subtree bench");

        h.Planner.RegisterBandSubtreeInvalidation(new[] { "intents" });
        Check.That(!h.Planner.IsRoomBenchedSubtree("intents"), "one subtree strike does not bench");
        h.Planner.RegisterBandSubtreeInvalidation(new[] { "intents" });
        Check.That(h.Planner.IsRoomBenchedSubtree("intents"), "second subtree strike benches the subtree");

        var after = h.PlanBand();
        Check.That(after.IsBakeable, "the band still flattens around the exiled subtree");
        foreach (var r in after.Regions)
        {
            Check.That(!Contains(r.BakedIds, "i0") && !Contains(r.BakedIds, "i1"),
                "the benched carrier's descendants are no longer baked");
            Check.That(!Contains(r.CarrierIds, "intents"), "the benched carrier no longer scaffolds anything");
        }

        // Round 3: the benched subtree is a LIVE-SUBTREE ROOT — ONE LiveZ slot on the root re-levels the whole
        // group coherently (children stay relative); descendants are projected out of the guard identity.
        Check.That(LiveZOf(after, "intents") is int, "the benched root gets the single re-level slot");
        Check.That(LiveZOf(after, "i0") is null && LiveZOf(after, "i1") is null,
            "its descendants ride the root override (no per-child slots)");
        Check.That(after.ExcludedLiveRoots is not null && Contains(after.ExcludedLiveRoots!, "intents"),
            "the benched root is an excluded live root");
        Check.That(after.BandIds is not null && Contains(after.BandIds!, "intents")
            && !Contains(after.BandIds!, "i0") && !Contains(after.BandIds!, "i1"),
            "BandIds projects the subtree out (root kept) — churn inside it is guard-invisible");
        Check.That(Contains(after.Regions[0].BakedIds, "s0") && Contains(after.Regions[^1].BakedIds, "t0"),
            "members elsewhere in the band still bake");
    }

    // Same room boundary as the member bench: a mid-room resync keyframe does NOT lift the subtree exile; a
    // PERSISTENT screen-type change (debounced real room change) does.
    private static void SubtreeBenchSurvivesKeyframeResetsOnScreenChange()
    {
        var h = IntentScene(out _);
        h.Planner.RegisterBandSubtreeInvalidation(new[] { "intents" });
        h.Planner.RegisterBandSubtreeInvalidation(new[] { "intents" });
        Check.That(h.Planner.IsRoomBenchedSubtree("intents"), "subtree benched in this room");

        h.Planner.ObserveDrain(h.State, new HashSet<string>(h.State.Nodes.Keys),
            System.Array.Empty<string>(), keyframe: true);
        Check.That(h.Planner.IsRoomBenchedSubtree("intents"), "the subtree exile survives a mid-room resync keyframe");

        h.State.ScreenType = "rewards";
        for (int i = 0; i < StaticBakePlanner.RoomChangeDebounceDrains; i++)
        {
            h.Planner.ObserveDrain(h.State, new HashSet<string>(), System.Array.Empty<string>(), keyframe: false);
        }

        h.State.ScreenType = "combat";
        Check.That(!h.Planner.IsRoomBenchedSubtree("intents"), "the subtree bench empties with the room");

        h.StabilizeAll();
        var plan = h.PlanBand();
        bool i0Baked = false;
        foreach (var r in plan.Regions)
        {
            i0Baked |= Contains(r.BakedIds, "i0");
        }

        Check.That(i0Baked, "the subtree bakes again in the new room (member bench cleared with it)");
    }

    // ---- WS-BGBAKE round 3: static exclusion policy (creature/HUD/VFX live-subtree roots) ------------------------

    // A policy-matched creature root (NodeType suffix Combat.NCreature) collapses to ONE live slot at its band
    // position; its whole subtree is skipped (never member/carrier) and projected out of BandIds; the surrounding
    // static runs segment around it, ordering exact.
    private static void ExclusionPolicyCollapsesCreatureSubtree()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 6);
        h.AddBandParticle("P0");
        var creature = h.AddGroup("creature", "root"); // non-painting subtree root
        creature.ZIndex = BandZ;
        creature.NodeType = "Godot.Combat.NCreature";  // policy: type suffix match
        h.AddBandStatic("visuals", parent: "creature");
        h.AddBandStatic("hp", parent: "creature");
        h.AddBandStatics("t", 6);

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "band flattens around the excluded creature");
        Check.Equal(plan.Regions.Count, 2, "s-run + t-run around the creature");
        foreach (var r in plan.Regions)
        {
            Check.That(!Contains(r.BakedIds, "creature") && !Contains(r.BakedIds, "visuals") && !Contains(r.BakedIds, "hp"),
                "nothing of the creature subtree is baked");
            Check.That(!Contains(r.CarrierIds, "creature"), "the creature never scaffolds as a carrier");
        }

        Check.That(LiveZOf(plan, "creature") is int, "the creature root gets ONE re-level slot");
        Check.That(LiveZOf(plan, "visuals") is null && LiveZOf(plan, "hp") is null,
            "its subtree rides the root override (no per-child slots — the HealthBar can never be SPLIT again)");
        int zP = LiveZOf(plan, "P0")!.Value;
        int zC = LiveZOf(plan, "creature")!.Value;
        Check.That(plan.Regions[0].QuadZ < zP && zP < zC && zC < plan.Regions[1].QuadZ,
            "R0 < P0 < creature < R1 — the creature sits at its exact band position");
        Check.That(plan.ExcludedLiveRoots is not null && Contains(plan.ExcludedLiveRoots!, "creature"),
            "the creature is an excluded live root");
        Check.That(plan.BandIds is not null && Contains(plan.BandIds!, "creature")
            && !Contains(plan.BandIds!, "visuals") && !Contains(plan.BandIds!, "hp"),
            "BandIds keeps the root, projects the descendants out (HP/intent churn is guard-invisible)");
    }

    // The safety valve: an excluded subtree with a CROSS-BUCKET descendant must not slot-collapse (the root override
    // would drag that descendant to the deep slot) — it falls back to per-painter recording (round-2 shape).
    private static void CrossBucketDescendantFallsBackPerPainter()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 6);
        h.AddBandParticle("P0");
        var creature = h.AddGroup("creature", "root");
        creature.ZIndex = BandZ;
        creature.NodeType = "Godot.Combat.NCreature";
        creature.LocalRect = new MirrorRect(0, 0, 1920, 1080);
        creature.FillColor = new MirrorColor(1, 1, 1, 1, "#ffffffff"); // paints → gets a per-painter slot
        h.AddBandStatic("visuals", parent: "creature");
        var fx = h.AddBandStatic("fx", parent: "creature");
        fx.ZIndex = 10; // effZ 0 — a cross-bucket descendant
        h.AddBandStatics("t", 6);

        h.StabilizeAll();
        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "band still flattens (per-painter fallback)");
        Check.That(plan.ExcludedLiveRoots is { Count: 0 }, "no slot-collapse for a cross-bucket subtree");
        Check.That(LiveZOf(plan, "creature") is int && LiveZOf(plan, "visuals") is int,
            "root and in-band descendants re-level per-painter (round-2 shape)");
        Check.That(LiveZOf(plan, "fx") is null, "the cross-bucket descendant is untouched (not a band node)");
        foreach (var r in plan.Regions)
        {
            Check.That(!Contains(r.BakedIds, "creature") && !Contains(r.BakedIds, "visuals"),
                "the subtree is still never baked");
        }

        Check.That(plan.BandIds is not null && Contains(plan.BandIds!, "visuals"),
            "no projection either — the guard still watches the per-painter subtree");
    }

    // ---- WS-BGBAKE round 3: tolerant order guard + keyframe stability ---------------------------------------------

    // The creature-scene builder shared by the guard/keyframe tests (6 statics | P0 | excluded creature{visuals,hp} |
    // 6 statics — the ExclusionPolicyCollapsesCreatureSubtree shape).
    private static Harness CreatureScene(out StaticBakePlan plan)
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 6);
        h.AddBandParticle("P0");
        var creature = h.AddGroup("creature", "root");
        creature.ZIndex = BandZ;
        creature.NodeType = "Godot.Combat.NCreature";
        h.AddBandStatic("visuals", parent: "creature");
        h.AddBandStatic("hp", parent: "creature");
        h.AddBandStatics("t", 6);
        h.StabilizeAll();
        plan = h.PlanBand();
        Check.That(plan.IsBakeable && plan.ExcludedLiveRoots is { Count: 1 }, "creature scene plans with 1 excluded root");
        return h;
    }

    private static void GuardToleratesExcludedSubtreeChurn()
    {
        // Spawn INSIDE the excluded subtree (an intent-wave / VFX spawn) → invisible to the projected guard.
        var h = CreatureScene(out var plan);
        var spawn = h.AddFullRect("spawn", "creature"); // effZ −10 via the creature's band z — a band node
        spawn.ZIndex = null;
        Check.That(h.Planner.IsBandOrderUnchanged(h.State, plan.BandIds!, plan.ExcludedLiveRoots),
            "a spawn inside an excluded subtree is guard-invisible");

        // Removal + reorder inside the subtree → still invisible.
        var h2 = CreatureScene(out var plan2);
        h2.State.Nodes.Remove("visuals");
        h2.State.OrderedIds.Remove("visuals");
        Check.That(h2.Planner.IsBandOrderUnchanged(h2.State, plan2.BandIds!, plan2.ExcludedLiveRoots),
            "a removal inside an excluded subtree is guard-invisible");

        var h3 = CreatureScene(out var plan3);
        int iv = h3.State.OrderedIds.IndexOf("visuals");
        int ih = h3.State.OrderedIds.IndexOf("hp");
        (h3.State.OrderedIds[iv], h3.State.OrderedIds[ih]) = (h3.State.OrderedIds[ih], h3.State.OrderedIds[iv]);
        Check.That(h3.Planner.IsBandOrderUnchanged(h3.State, plan3.BandIds!, plan3.ExcludedLiveRoots),
            "a reorder inside an excluded subtree is guard-invisible");

        // A new painter in a GAP (outside every excluded subtree) is still a band change.
        var h4 = CreatureScene(out var plan4);
        var gap = h4.AddFullRect("gapper", "root");
        gap.ZIndex = BandZ;
        Check.That(!h4.Planner.IsBandOrderUnchanged(h4.State, plan4.BandIds!, plan4.ExcludedLiveRoots),
            "a new gap painter is still visible to the guard");

        // The excluded ROOT itself vanishing is a band change (roots stay in the projection).
        var h5 = CreatureScene(out var plan5);
        h5.State.Nodes.Remove("creature");
        h5.State.OrderedIds.Remove("creature");
        h5.State.Nodes.Remove("visuals");
        h5.State.OrderedIds.Remove("visuals");
        h5.State.Nodes.Remove("hp");
        h5.State.OrderedIds.Remove("hp");
        Check.That(!h5.Planner.IsBandOrderUnchanged(h5.State, plan5.BandIds!, plan5.ExcludedLiveRoots),
            "an excluded root vanishing is still visible to the guard");
    }

    private static void KeyframePreservesBandStability()
    {
        // An identical keyframe (loop restart / resync: same instances value-compare unchanged) keeps the band
        // stable — the IMMEDIATE re-plan is bakeable and shape-identical, so the controller can survive the seam.
        var h = CreatureScene(out var before);
        h.Planner.ObserveDrain(h.State, new HashSet<string>(h.State.Nodes.Keys),
            System.Array.Empty<string>(), keyframe: true);
        var after = h.PlanBand();
        Check.That(after.IsBakeable, "identical keyframe → immediately bakeable (no re-settle window)");
        Check.Equal(after.Regions.Count, before.Regions.Count, "same region count across the seam");
        for (int i = 0; i < after.Regions.Count; i++)
        {
            Check.Equal(after.Regions[i].BakedIds.Count, before.Regions[i].BakedIds.Count,
                $"region {i} member count identical across the seam");
            Check.Equal(after.Regions[i].QuadZ, before.Regions[i].QuadZ, $"region {i} quad z identical");
        }

        Check.Equal(after.LiveZ.Count, before.LiveZ.Count, "live slots identical across the seam");

        // A keyframe that actually CHANGED a band member re-stamps exactly that node → it re-levels live while it
        // re-settles; the rest of the band stays baked.
        var h2 = CreatureScene(out _);
        h2.State.Nodes["s0"] = new MirrorNode
        {
            Id = "s0",
            ParentId = "root",
            ZIndex = BandZ,
            Transform = new double[] { 1, 0, 0, 1, 0, 0 },
            LocalRect = new MirrorRect(0, 0, 1920, 1080),
            FillColor = new MirrorColor(0, 0, 0, 1, "#000000ff"), // a changed re-send
        };
        h2.Planner.ObserveDrain(h2.State, new HashSet<string>(h2.State.Nodes.Keys),
            System.Array.Empty<string>(), keyframe: true);
        var plan2 = h2.PlanBand();
        Check.That(plan2.IsBakeable, "band still bakes around the one changed node");
        foreach (var r in plan2.Regions)
        {
            Check.That(!Contains(r.BakedIds, "s0"), "the changed node is not baked while it re-settles");
        }

        Check.That(LiveZOf(plan2, "s0") is int, "the changed node re-levels live");
    }

    // ---- helpers -------------------------------------------------------------------------------------------------

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

    private static int? LiveZOf(StaticBakePlan plan, string id)
    {
        foreach (var lz in plan.LiveZ)
        {
            if (lz.Id == id)
            {
                return lz.Z;
            }
        }

        return null;
    }

    // Same shape as the StaticBakePlannerTests harness, plus band-building helpers (full-screen painters at the
    // combat band z under a z=0 root carrier) and the flatten entry point.
    private sealed class Harness
    {
        public readonly MirrorState State = MirrorState.Create();
        public readonly GlobalTransformIndex Transforms = new();
        public readonly StaticBakePlanner Planner = new();


        public MirrorNode AddGroup(string id, string? parent)
        {
            var n = new MirrorNode { Id = id, ParentId = parent, Transform = Identity() };
            State.Nodes[id] = n;
            State.OrderedIds.Add(id);
            return n;
        }

        public MirrorNode AddFullRect(string id, string? parent) => AddRect(id, parent, 0, 0, 1920, 1080);

        public MirrorNode AddRect(string id, string? parent, double x, double y, double w, double h)
        {
            var n = AddGroup(id, parent);
            n.LocalRect = new MirrorRect(x, y, w, h);
            n.FillColor = new MirrorColor(1, 1, 1, 1, "#ffffffff");
            return n;
        }

        public MirrorNode AddParticle(string id, string? parent)
        {
            var n = AddRect(id, parent, 0, 0, 1920, 1080);
            n.ParticleSpec = (MirrorParticleSpec)System.Runtime.CompilerServices.RuntimeHelpers
                .GetUninitializedObject(typeof(MirrorParticleSpec));
            return n;
        }

        // A full-screen static painter in the band (effZ −10) under "root".
        public MirrorNode AddBandStatic(string id, string parent = "root")
        {
            var n = AddFullRect(id, parent);
            n.ZIndex = parent == "root" ? BandZ : null; // a nested child inherits the band z through its parent
            return n;
        }

        public void AddBandStatics(string prefix, int count)
        {
            for (int i = 0; i < count; i++)
            {
                AddBandStatic($"{prefix}{i}");
            }
        }

        public MirrorNode AddBandParticle(string id)
        {
            var n = AddParticle(id, "root");
            n.ZIndex = BandZ;
            return n;
        }

        // Paint position of an id (effZ stable sort of the live pre-order — mirrors the planner).
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

        public void Drain(params string[] changed) =>
            Planner.ObserveDrain(State, new HashSet<string>(changed), System.Array.Empty<string>(), keyframe: false);

        public void DrainNoTouch() =>
            Planner.ObserveDrain(State, new HashSet<string>(), System.Array.Empty<string>(), keyframe: false);

        public void StabilizeAll()
        {
            Transforms.Update(State);
            Planner.ObserveDrain(State, new HashSet<string>(State.Nodes.Keys), System.Array.Empty<string>(), keyframe: false);
            for (int i = 0; i < StaticBakePlanner.MinStableFrames + 2; i++)
            {
                Planner.ObserveFrame();
            }

            for (int i = 0; i < StaticBakePlanner.MinStableDrains + 1; i++)
            {
                DrainNoTouch();
            }
        }

        public StaticBakePlan PlanBand(string? excluded = null, string? effectStaticOk = null,
            IReadOnlySet<string>? bottomOnly = null)
        {
            Transforms.Update(State);
            var ex = excluded is null ? EmptySet : new HashSet<string> { excluded };
            var ok = effectStaticOk is null ? EmptySet : new HashSet<string> { effectStaticOk };
            return Planner.PlanBandFlatten(State, Transforms, Width, ex, ok, bottomOnly);
        }

        public StaticBakePlan PlanExact()
        {
            Transforms.Update(State);
            return Planner.Plan(State, Transforms, Width, EmptySet, EmptySet, null);
        }

        private static readonly HashSet<string> EmptySet = new();

        private static double[] Identity() => new double[] { 1, 0, 0, 1, 0, 0 };
    }
}
