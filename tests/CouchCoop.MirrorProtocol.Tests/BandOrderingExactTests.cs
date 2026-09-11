using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-BGBAKE round 3 — the ORDERING-EXACTNESS enforcing suite for PlanBandFlatten (the user's second requirement:
// "the optimized bg looks exactly the same as the unoptimized one"). Round 2's one-quad collapse re-leveled ~40
// mid-band interlopers ABOVE the whole baked background (trees floated over the dock, the ally HP bar was covered by
// a stale orange bar). Round 3 makes the induced draw order of a band plan order-ISOMORPHIC to the raw band paint
// order. This suite proves that property structurally on synthetic scenes with a single reusable checker,
// `BandOrderingExact.AssertOrderingExact`, plus the segmentation / no-hoist / tiny-run / keyframe-signature / guard
// cases the design calls out. It is pure C# (no Godot), always-on in the Exe runner.
//
// The checker (shared with BandResidencyReplayProbe): expand a plan's slots — each REGION quad to its baked painters
// (paint order), each LIVE-Z override to its painter, each EXCLUDED-ROOT slot to its subtree's painters (paint
// order) — sort the slots by their absolute z, concatenate, and SequenceEqual the raw band's painting-node sequence
// in paint order. Any hoist, drop, duplication, or re-level that disturbs the visible order fails.
internal static class BandOrderingExactTests
{
    public static void Run()
    {
        SegmentedSplitIsOrderingExact();
        NoHoistAcrossInterloper();
        TinyRunStaysLiveOrderingExact();
        ExcludedRootSubtreeOrderingExact();
        NoInterloperSingleRegionOrderingExact();
        SubMulDemotionOrderingExact();
        KeyframeSeamSignatureEquality();
        KeyframeChangedBandBreaksSignature();
        GuardToleratesExcludedSubtreeChurn();
    }

    private const double Width = 1920;
    private const int BandZ = -10;

    // ---- segmentation: one region per contiguous static run, order-isomorphic to the paint order ------------------

    private static void SegmentedSplitIsOrderingExact()
    {
        // s8 | P0 | m6 | P1 | t4 → 3 regions. The design's canonical no-hoist scene: round 2 baked s∪m∪t into ONE quad
        // BELOW P0/P1 (occlusion destroyed); round 3 keeps each run its own quad at its own slot z, particles between.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("m", 6);
        h.AddBandParticle("P1");
        h.AddBandStatics("t", 4);
        h.AddFullRect("gp", "root"); // z=0 gameplay — must never enter the band plan
        h.StabilizeAll();

        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "segmented band flattens");
        Check.Equal(plan.Regions.Count, 3, "s8 | m6 | t4 → three regions");
        BandOrderingExact.AssertOrderingExact(plan, h.State, "s8|P0|m6|P1|t4 ordering exact");
    }

    private static void NoHoistAcrossInterloper()
    {
        // The explicit anti-round-2 assertion: a mid-band run's members must land in their OWN region (drawn ABOVE the
        // interloper below them), never hoisted into region 0 under the whole particle stack.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("m", 6);
        h.AddBandParticle("P1");
        h.AddBandStatics("t", 4);
        h.StabilizeAll();

        var plan = h.PlanBand();
        Check.That(plan.IsBakeable && plan.Regions.Count == 3, "three regions form");
        var r0 = plan.Regions[0];
        var r1 = plan.Regions[1];
        var r2 = plan.Regions[2];

        for (int i = 0; i < 6; i++)
        {
            Check.That(!Has(r0.BakedIds, $"m{i}"), $"m{i} NOT hoisted into region 0 (below P0)");
            Check.That(Has(r1.BakedIds, $"m{i}"), $"m{i} in its own region 1 (above P0)");
        }

        for (int i = 0; i < 4; i++)
        {
            Check.That(!Has(r0.BakedIds, $"t{i}") && !Has(r1.BakedIds, $"t{i}"), $"t{i} not hoisted below P1");
            Check.That(Has(r2.BakedIds, $"t{i}"), $"t{i} in region 2 (above P1)");
        }

        int zP0 = LiveZOf(plan, "P0")!.Value;
        int zP1 = LiveZOf(plan, "P1")!.Value;
        Check.That(r0.QuadZ < zP0 && zP0 < r1.QuadZ && r1.QuadZ < zP1 && zP1 < r2.QuadZ,
            "R0 < P0 < R1 < P1 < R2 — the exact band order (no occlusion inversion)");
        BandOrderingExact.AssertOrderingExact(plan, h.State, "no-hoist ordering exact");
    }

    private static void TinyRunStaysLiveOrderingExact()
    {
        // A trailing run below MinPaintersPerRegion is not worth a viewport → it re-levels LIVE above the interloper,
        // still in exact order (K degrades to 1 region + N live slots).
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("t", StaticBakePlanner.MinPaintersPerRegion - 1); // 2 statics — sub-threshold
        h.StabilizeAll();

        var plan = h.PlanBand();
        Check.That(plan.IsBakeable, "quad A still bakes");
        Check.Equal(plan.Regions.Count, 1, "sub-threshold trailing run forms no second region");
        Check.Equal(plan.LiveZ.Count, 1 + (StaticBakePlanner.MinPaintersPerRegion - 1),
            "particle + the two trailing statics all re-level live");
        int zP = LiveZOf(plan, "P0")!.Value;
        int zt0 = LiveZOf(plan, "t0")!.Value;
        Check.That(plan.Regions[0].QuadZ < zP && zP < zt0, "trailing statics stay ABOVE the particle");
        BandOrderingExact.AssertOrderingExact(plan, h.State, "tiny-run-stays-live ordering exact");
    }

    private static void ExcludedRootSubtreeOrderingExact()
    {
        // An excluded creature root collapses to ONE live slot; its subtree painters ride the root override at the
        // root's band position. The checker expands that slot to the subtree painters (paint order) and proves the
        // whole band — statics + the creature's HP/visuals block sandwiched at its slot — is order-isomorphic.
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

        var plan = h.PlanBand();
        Check.That(plan.IsBakeable && plan.ExcludedLiveRoots is { Count: 1 }, "creature scene plans with 1 excluded root");
        BandOrderingExact.AssertOrderingExact(plan, h.State, "excluded-root subtree ordering exact");
    }

    private static void NoInterloperSingleRegionOrderingExact()
    {
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 12);
        h.StabilizeAll();

        var plan = h.PlanBand();
        Check.That(plan.IsBakeable && plan.Regions.Count == 1 && plan.LiveZ.Count == 0, "pure static band → one region");
        BandOrderingExact.AssertOrderingExact(plan, h.State, "single-region ordering exact");
    }

    private static void SubMulDemotionOrderingExact()
    {
        // A Sub member that would OPEN a post-particle segment (no painting member of its own segment before it)
        // demotes to a live slot; the statics above it form their own region. The demotion is itself a cut, and the
        // whole band stays order-isomorphic.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 6);
        h.AddBandParticle("P0");
        var subX = h.AddBandStatic("subX");
        subX.CanvasBlendMode = 3; // Mul, bottom-only
        h.AddBandStatics("u", 4);
        h.StabilizeAll();

        var bottomOnly = new HashSet<string>(StringComparer.Ordinal) { "subX" };
        var plan = h.PlanBand(bottomOnly: bottomOnly);
        Check.That(plan.IsBakeable && plan.Regions.Count == 2, "s-run + u-run around the demoted Sub");
        Check.That(LiveZOf(plan, "subX") is int, "the segment-opening Sub re-levels live");
        BandOrderingExact.AssertOrderingExact(plan, h.State, "sub/mul demotion ordering exact");
    }

    // ---- keyframe-seam plan-signature equality (the loop-restart no-visible-change contract) ---------------------

    private static void KeyframeSeamSignatureEquality()
    {
        // A loop restart / resync re-sends the SAME scene: the planner keeps stability for value-identical ids, so the
        // IMMEDIATE re-plan is byte-identical (same regions, members, quad z, live slots). Plan signatures MUST match.
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("t", 6);
        h.StabilizeAll();
        var before = h.PlanBand();
        var sigBefore = BandOrderingExact.Signature(before);

        // Re-send everything as a keyframe (identical instances value-compare unchanged).
        h.Planner.ObserveDrain(h.State, new HashSet<string>(h.State.Nodes.Keys), Array.Empty<string>(), keyframe: true);
        var after = h.PlanBand();
        var sigAfter = BandOrderingExact.Signature(after);

        Check.Equal(sigAfter, sigBefore, "identical keyframe → plan signature unchanged (zero visible change at the seam)");
        BandOrderingExact.AssertOrderingExact(after, h.State, "post-keyframe ordering exact");
    }

    private static void KeyframeChangedBandBreaksSignature()
    {
        // The negative: a keyframe that actually CHANGES a band member re-stamps exactly that id → it re-levels live
        // while it re-settles, so the signature MUST differ (a real content change is not silently baked stale).
        var h = new Harness();
        h.AddGroup("root", null);
        h.AddBandStatics("s", 8);
        h.AddBandParticle("P0");
        h.AddBandStatics("t", 6);
        h.StabilizeAll();
        var before = h.PlanBand();
        var sigBefore = BandOrderingExact.Signature(before);

        // A changed re-send of s0 (new instance, different fill) — ClassifyKeyframe != None → stamped unstable.
        h.State.Nodes["s0"] = new MirrorNode
        {
            Id = "s0",
            ParentId = "root",
            ZIndex = BandZ,
            Transform = new double[] { 1, 0, 0, 1, 0, 0 },
            LocalRect = new MirrorRect(0, 0, 1920, 1080),
            FillColor = new MirrorColor(0, 0, 0, 1, "#000000ff"),
        };
        h.Planner.ObserveDrain(h.State, new HashSet<string>(h.State.Nodes.Keys), Array.Empty<string>(), keyframe: true);
        var after = h.PlanBand();

        Check.That(BandOrderingExact.Signature(after) != sigBefore, "a changed keyframe band member breaks the signature");
        foreach (var r in after.Regions)
        {
            Check.That(!Has(r.BakedIds, "s0"), "the changed member is not baked while it re-settles");
        }

        Check.That(LiveZOf(after, "s0") is int, "the changed member re-levels live");
        BandOrderingExact.AssertOrderingExact(after, h.State, "changed-keyframe ordering still exact");
    }

    // ---- guard tolerance under excluded-subtree churn (the projected order guard) --------------------------------

    private static void GuardToleratesExcludedSubtreeChurn()
    {
        // The projected order guard skips ids under an excluded root. Spawns / removals / reorders INSIDE an excluded
        // creature subtree (intent waves, VFX) are guard-invisible; a change to the band prefix ITSELF is fatal.
        var baseline = BuildCreatureScene(out var plan);
        Check.That(baseline.Planner.IsBandOrderUnchanged(baseline.State, plan.BandIds!, plan.ExcludedLiveRoots),
            "untouched creature scene ⇒ band order unchanged");

        var hSpawn = BuildCreatureScene(out var planSpawn);
        hSpawn.AddFullRect("spawn", "creature"); // effZ −10 via the creature's band z — a band node inside the subtree
        Check.That(hSpawn.Planner.IsBandOrderUnchanged(hSpawn.State, planSpawn.BandIds!, planSpawn.ExcludedLiveRoots),
            "spawn inside an excluded subtree is guard-invisible");

        var hRemove = BuildCreatureScene(out var planRemove);
        hRemove.State.Nodes.Remove("visuals");
        hRemove.State.OrderedIds.Remove("visuals");
        Check.That(hRemove.Planner.IsBandOrderUnchanged(hRemove.State, planRemove.BandIds!, planRemove.ExcludedLiveRoots),
            "removal inside an excluded subtree is guard-invisible");

        var hGap = BuildCreatureScene(out var planGap);
        var gap = hGap.AddFullRect("gapper", "root");
        gap.ZIndex = BandZ; // a NEW band painter OUTSIDE every excluded subtree — a real band change
        Check.That(!hGap.Planner.IsBandOrderUnchanged(hGap.State, planGap.BandIds!, planGap.ExcludedLiveRoots),
            "a new gap painter IS visible to the guard (tear down)");

        var hRoot = BuildCreatureScene(out var planRoot);
        hRoot.State.Nodes.Remove("creature");
        hRoot.State.OrderedIds.Remove("creature");
        hRoot.State.Nodes.Remove("visuals");
        hRoot.State.OrderedIds.Remove("visuals");
        hRoot.State.Nodes.Remove("hp");
        hRoot.State.OrderedIds.Remove("hp");
        Check.That(!hRoot.Planner.IsBandOrderUnchanged(hRoot.State, planRoot.BandIds!, planRoot.ExcludedLiveRoots),
            "the excluded ROOT itself vanishing IS visible to the guard");
    }

    private static Harness BuildCreatureScene(out StaticBakePlan plan)
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

    // ---- helpers -------------------------------------------------------------------------------------------------

    private static bool Has(IReadOnlyList<string> ids, string id)
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

    // Same builder shape as BandFlattenPlannerTests.Harness (kept independent so the two suites never couple).
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

        public MirrorNode AddBandStatic(string id, string parent = "root")
        {
            var n = AddFullRect(id, parent);
            n.ZIndex = parent == "root" ? BandZ : null;
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

        public void StabilizeAll()
        {
            Transforms.Update(State);
            Planner.ObserveDrain(State, new HashSet<string>(State.Nodes.Keys), Array.Empty<string>(), keyframe: false);
            for (int i = 0; i < StaticBakePlanner.MinStableFrames + 2; i++)
            {
                Planner.ObserveFrame();
            }

            for (int i = 0; i < StaticBakePlanner.MinStableDrains + 1; i++)
            {
                Planner.ObserveDrain(State, new HashSet<string>(), Array.Empty<string>(), keyframe: false);
            }
        }

        public StaticBakePlan PlanBand(IReadOnlySet<string>? bottomOnly = null)
        {
            Transforms.Update(State);
            return Planner.PlanBandFlatten(State, Transforms, Width, EmptySet, EmptySet, bottomOnly);
        }

        private static readonly HashSet<string> EmptySet = new();

        private static double[] Identity() => new double[] { 1, 0, 0, 1, 0, 0 };
    }
}

// The reusable ordering-exactness checker + plan signature, shared by BandOrderingExactTests and
// BandResidencyReplayProbe. Kept Godot-free (pure MirrorState math).
internal static class BandOrderingExact
{
    // The planner's own Paints predicate (visible + emits pixels of its own).
    public static bool Paints(MirrorNode n) =>
        n.Visible
        && (n.TextureUrl is not null
            || n.FillColor is not null
            || n.Range is not null
            || n.Text is { Text.Length: > 0 });

    // The effective-Z paint order over the LIVE nodes (a stable sort of the live pre-order by effZ) — byte-identical
    // to StaticBakePlanner.BuildPaintOrder, recomputed here so the checker never depends on planner internals.
    public static (List<string> Order, Dictionary<string, int> EffZ) PaintOrder(MirrorState state)
    {
        var pre = new Dictionary<string, int>(StringComparer.Ordinal);
        var effZ = new Dictionary<string, int>(StringComparer.Ordinal);
        var live = new List<string>();
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.ContainsKey(id))
            {
                continue; // stale ordered id
            }

            pre[id] = live.Count;
            live.Add(id);
        }

        foreach (var id in live)
        {
            var n = state.Nodes[id];
            int baseZ = n.ParentId is { } pid && effZ.TryGetValue(pid, out var pz) ? pz : 0;
            effZ[id] = baseZ + (n.ZIndex ?? 0);
        }

        var order = new List<string>(live);
        order.Sort((a, b) => effZ[a] != effZ[b] ? effZ[a].CompareTo(effZ[b]) : pre[a].CompareTo(pre[b]));
        return (order, effZ);
    }

    // Expand a band plan's slots (quads → baked painters; live overrides → their painter; excluded roots → subtree
    // painters), sort by absolute z, concatenate, and require SequenceEqual to the raw band's painting-node sequence
    // in paint order. Proves the plan's induced draw order is order-isomorphic to the un-baked band (no hoist / drop /
    // duplicate / occlusion inversion). Only meaningful for a bakeable band plan (Regions>0 && BandIds != null).
    public static void AssertOrderingExact(StaticBakePlan plan, MirrorState state, string label)
    {
        Check.That(plan.IsBakeable && plan.BandIds is not null, $"{label}: a bakeable band plan");
        var (order, effZ) = PaintOrder(state);
        Check.That(order.Count > 0, $"{label}: non-empty paint order");
        int bucketZ = effZ[order[0]];

        // The ground truth: every PAINTING node in the bottom bucket, in paint order.
        var expected = new List<string>();
        var expectedSet = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in order)
        {
            if (effZ[id] != bucketZ)
            {
                break; // the bottom bucket is a paint-order prefix
            }

            if (Paints(state.Nodes[id]))
            {
                expected.Add(id);
                expectedSet.Add(id);
            }
        }

        var paintPos = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < order.Count; i++)
        {
            paintPos[order[i]] = i;
        }

        var excludedRoots = new HashSet<string>(plan.ExcludedLiveRoots ?? Array.Empty<string>(), StringComparer.Ordinal);

        // Build (z, painters) slots. Each expansion is filtered to expectedSet (so a non-painting live particle slot
        // contributes nothing) and kept in paint order, so every painting band node appears exactly once.
        var slots = new List<(int Z, List<string> Painters)>();
        foreach (var region in plan.Regions)
        {
            var painters = new List<string>();
            foreach (var id in region.BakedIds)
            {
                if (expectedSet.Contains(id))
                {
                    painters.Add(id);
                }
            }

            slots.Add((region.QuadZ, painters));
        }

        foreach (var lz in plan.LiveZ)
        {
            if (excludedRoots.Contains(lz.Id))
            {
                // The subtree painters (root + strict descendants) at the root's slot, in paint order.
                var sub = new List<string>();
                foreach (var id in order)
                {
                    if (expectedSet.Contains(id) && (id == lz.Id || IsDescendant(id, lz.Id, state)))
                    {
                        sub.Add(id);
                    }
                }

                slots.Add((lz.Z, sub));
            }
            else
            {
                var one = new List<string>();
                if (expectedSet.Contains(lz.Id))
                {
                    one.Add(lz.Id);
                }

                slots.Add((lz.Z, one));
            }
        }

        // Distinct z per slot is itself an invariant (the planner assigns position-stable, strictly-increasing z).
        slots.Sort((a, b) => a.Z.CompareTo(b.Z));
        for (int i = 1; i < slots.Count; i++)
        {
            Check.That(slots[i - 1].Z < slots[i].Z, $"{label}: slot z strictly increasing ({slots[i - 1].Z} < {slots[i].Z})");
        }

        var actual = new List<string>();
        foreach (var s in slots)
        {
            actual.AddRange(s.Painters);
        }

        Check.SequenceEqual(actual, expected, $"{label}: induced draw order == raw band paint order");
    }

    // A canonical string identity of a plan: regions (order, quad z, baked ids) + live overrides (id, z) + excluded
    // roots. Two plans with the same signature composite byte-identically.
    public static string Signature(StaticBakePlan plan)
    {
        var sb = new StringBuilder();
        sb.Append("R:");
        foreach (var r in plan.Regions)
        {
            sb.Append('[').Append(r.QuadZ).Append('|');
            foreach (var id in r.BakedIds)
            {
                sb.Append(id).Append(',');
            }

            sb.Append("||");
            foreach (var id in r.CarrierIds)
            {
                sb.Append(id).Append(',');
            }

            sb.Append(']');
        }

        sb.Append(";L:");
        foreach (var lz in plan.LiveZ)
        {
            sb.Append(lz.Id).Append('=').Append(lz.Z).Append(',');
        }

        sb.Append(";X:");
        if (plan.ExcludedLiveRoots is { } roots)
        {
            foreach (var id in roots)
            {
                sb.Append(id).Append(',');
            }
        }

        return sb.ToString();
    }

    private static bool IsDescendant(string id, string root, MirrorState state)
    {
        var cur = state.Nodes.TryGetValue(id, out var n) ? n.ParentId : null;
        int guard = 0;
        while (cur is not null && guard++ < 4096)
        {
            if (string.Equals(cur, root, StringComparison.Ordinal))
            {
                return true;
            }

            cur = state.Nodes.TryGetValue(cur, out var pn) ? pn.ParentId : null;
        }

        return false;
    }
}
