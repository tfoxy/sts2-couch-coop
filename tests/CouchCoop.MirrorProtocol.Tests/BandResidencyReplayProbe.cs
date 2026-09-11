using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-BGBAKE round 3 — the RECORDING-DRIVEN residency probe. It replays the canonical combat recording delta-by-delta
// through the SAME pure classes the Godot controller drives — StaticBakePlanner.ObserveDrain/ObserveFrame +
// BandResidencyMachine.EvaluateStructure/EvaluateCulprits — modelling a minimal StaticBake.OnDrained controller
// (arm → per-drain structure verdict → per-region watch scan → culprit verdict), and asserts the residency property
// that Layer 2 (`verify-bgbake-residency.sh`) measures on-device:
//
//   (a) TEARDOWN-CLASS decisions (structural Teardown / KeyframeDrop, culprit BenchAndTeardown / Teardown) occur
//       ONLY inside a bounded learning window after the first arm — the room bench / subtree bench exile the ~9s
//       wave banner + the fading Intents row, after which the band bake HOLDS (order changes absorbed by the
//       projected guard as ProceedOrderSkipped; screen shake absorbed as a carrier Follow). Zero teardowns after.
//   (b) AssertOrderingExact (BandOrderingExact) on EVERY produced band plan — the induced draw order is always
//       order-isomorphic to the raw band paint order (the "looks identical" guarantee, frame by frame).
//   (c) A loop-seam keyframe re-sending the SAME scene SURVIVES: EvaluateStructure returns KeyframeSurvive (never a
//       KeyframeDrop / structural Teardown), the re-plan signature is unchanged, and no new bench strikes are learned
//       (zero re-learning).
//
// Path-presence-gated: default `.sts2/bench/combat-2026-07-15T16-40-09-999Z.ndjson` (rel. to the repo root),
// overridable via COUCHCOOP_BGBAKE_RESIDENCY_NDJSON. If the file is absent the probe prints ONE skip line and passes
// (nothing is committed under .sts2/). Follows StaticBakePlanProbe's recording-read pattern.
internal static class BandResidencyReplayProbe
{
    private const double DesignW = 1920.0;

    // CALIBRATED + PINNED on the canonical recording (combat-2026-07-15T16-40-09-999Z.ndjson, 1190 parsed deltas,
    // ALL_SHADERS sweep). MEASURED: the pure residency model arms a band bake once at drain 10 and holds it teardown-
    // free for all 1179 subsequent drains — ZERO teardown-class decisions (the 181 OrderChanged drains are absorbed by
    // the projected order guard as ProceedOrderSkipped; 135 screen-shake drains as carrier Follows; the rest Survive),
    // 945 ordering-exact plans checked. So the empirical learning window is 0. Pinned at 8 (small headroom that still
    // fails a regression which starts churning the band); override for A/B via COUCHCOOP_BGBAKE_RESIDENCY_MAXLEARN.
    private const int PinnedLearningWindowDrains = 8;

    public static void Run()
    {
        var path = ResolvePath();
        if (path is null)
        {
            return; // silent skip — no recording committed
        }

        if (!File.Exists(path))
        {
            Console.Error.WriteLine($"[bgbake-residency] SKIP — recording not found: {path}");
            return;
        }

        int maxLearn = PinnedLearningWindowDrains;
        var envMax = Environment.GetEnvironmentVariable("COUCHCOOP_BGBAKE_RESIDENCY_MAXLEARN");
        if (int.TryParse(envMax, out var m) && m > 0)
        {
            maxLearn = m;
        }

        var frames = ReadFrames(path);
        if (frames.Count == 0)
        {
            Console.Error.WriteLine($"[bgbake-residency] SKIP — no scene-delta frames parsed from {path}");
            return;
        }

        var run = Replay(frames);

        Console.Error.WriteLine(
            $"[bgbake-residency] file={Path.GetFileName(path)} deltas={run.DrainCount} " +
            $"firstArm={run.FirstArmDrain} armedDrains={run.ArmedDrains} builds={run.Builds} " +
            $"orderSkips={run.OrderSkips} follows={run.Follows} survives={run.Survives} " +
            $"structTeardowns={run.StructuralTeardowns} keyframeRetains={run.KeyframeRetains} " +
            $"culpritBench={run.CulpritBenchTeardowns} culpritTeardowns={run.CulpritTeardowns} " +
            $"keyframeDrops={run.KeyframeDrops} plansChecked={run.PlansChecked}");
        if (run.TeardownDrains.Count > 0)
        {
            Console.Error.WriteLine(
                $"[bgbake-residency] teardown-class drain offsets (from firstArm): " +
                $"[{string.Join(",", run.TeardownDrains.Select(d => d - run.FirstArmDrain))}] " +
                $"lastTeardownOffset={run.LastTeardownDrain - run.FirstArmDrain}");
        }

        // Positive: the recording must actually arm a band bake (otherwise the residency claim is vacuous).
        Check.That(run.FirstArmDrain >= 0, "[bgbake-residency] the recording armed a band bake at least once");
        Check.That(run.PlansChecked > 0, "[bgbake-residency] at least one band plan was ordering-exact checked");

        // (a) All teardown-class decisions inside the calibrated learning window; zero after.
        if (run.TeardownDrains.Count > 0)
        {
            int lastOffset = run.LastTeardownDrain - run.FirstArmDrain;
            Check.That(lastOffset <= maxLearn,
                $"[bgbake-residency] last teardown at offset {lastOffset} ≤ learning window {maxLearn} " +
                $"(all teardown offsets: [{string.Join(",", run.TeardownDrains.Select(d => d - run.FirstArmDrain))}])");
        }

        // Residency actually held: the tail after the learning window is teardown-free for a meaningful run of drains.
        Check.That(run.TeardownFreeTailDrains >= 100,
            $"[bgbake-residency] the bake held teardown-free for {run.TeardownFreeTailDrains} tail drains (≥100 required)");

        // (c) Loop-seam keyframe survival — re-send the final state as an identical keyframe.
        Check.That(run.SeamVerdict == BandResidencyMachine.StructureVerdict.KeyframeSurvive,
            $"[bgbake-residency] identical loop-seam keyframe SURVIVES (got {run.SeamVerdict}, never a KeyframeDrop/Teardown)");
        Check.Equal(run.SeamSignatureUnchanged, true,
            "[bgbake-residency] the re-plan signature is unchanged across the identical seam (zero visible change)");
        Check.Equal(run.SeamReLearned, false, "[bgbake-residency] zero re-learning across the identical seam (no new strikes)");

        Console.Error.WriteLine("[bgbake-residency] ALL PASS");
    }

    private static string? ResolvePath()
    {
        var env = Environment.GetEnvironmentVariable("COUCHCOOP_BGBAKE_RESIDENCY_NDJSON");
        if (!string.IsNullOrWhiteSpace(env))
        {
            return env;
        }

        // Default under the repo root — absent in a clean checkout (nothing committed under .sts2/), so this is a
        // silent skip unless the operator has the recording locally.
        try
        {
            var def = Path.Combine(TestFixtures.RepoRoot(), ".sts2", "bench", "combat-2026-07-15T16-40-09-999Z.ndjson");
            return File.Exists(def) ? def : null;
        }
        catch
        {
            return null;
        }
    }

    // One replayed drain's inputs, reconstructed from a recording envelope + its inner MirrorDelta.
    private readonly record struct Frame(double T, MirrorDelta Delta);

    private static List<Frame> ReadFrames(string path)
    {
        var frames = new List<Frame>();
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            double t;
            string deltaJson;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (!root.TryGetProperty("data", out var dataEl) || dataEl.ValueKind != JsonValueKind.String)
                {
                    continue; // meta / handshake / non-delta envelope
                }

                t = root.TryGetProperty("t", out var tEl) && tEl.ValueKind == JsonValueKind.Number ? tEl.GetDouble() : 0;
                deltaJson = dataEl.GetString()!;
            }
            catch
            {
                continue;
            }

            var delta = SceneDeltaReader.Parse(deltaJson);
            if (delta is not null)
            {
                frames.Add(new Frame(t, delta));
            }
        }

        return frames;
    }

    private sealed class RunResult
    {
        public int DrainCount;
        public int FirstArmDrain = -1;
        public int ArmedDrains;
        public int Builds;
        public int OrderSkips;
        public int Follows;
        public int Survives;
        public int StructuralTeardowns;
        public int KeyframeRetains;
        public int CulpritBenchTeardowns;
        public int CulpritTeardowns;
        public int KeyframeDrops;
        public int PlansChecked;
        public readonly List<int> TeardownDrains = new();
        public int LastTeardownDrain = -1;
        public int TeardownFreeTailDrains;
        public BandResidencyMachine.StructureVerdict SeamVerdict;
        public bool SeamSignatureUnchanged;
        public bool SeamReLearned;
    }

    private static RunResult Replay(List<Frame> frames)
    {
        var result = new RunResult();
        var state = MirrorState.Create();
        var planner = new StaticBakePlanner();
        var residency = new BandResidencyMachine(planner);
        var transforms = new GlobalTransformIndex();

        // The active (armed) band bake model, mirroring StaticBake's _active* fields.
        bool active = false;
        StaticBakePlan activePlan = StaticBakePlan.None;
        IReadOnlyList<string>? activeBandIds = null;
        IReadOnlyList<string>? activeExcludedRoots = null;
        HashSet<string> activeMembers = new(StringComparer.Ordinal);   // union of all region BakedIds
        HashSet<string> activeWatched = new(StringComparer.Ordinal);   // baked ∪ carriers (all regions)

        double prevT = frames[0].T;
        int drainIndex = -1;

        foreach (var frame in frames)
        {
            drainIndex++;

            // Simulate the prior drain's FinishDrain: isolate THIS delta's changed set + change flags + hints.
            state.ChangedIds.Clear();
            state.ChangeFlags.Clear();
            state.PendingHints.Clear();

            SceneTreeApplier.ApplySceneDelta(state, frame.Delta);

            var changedIds = new HashSet<string>(state.ChangedIds, StringComparer.Ordinal);
            bool keyframe = frame.Delta.Full;
            bool orderChanged = frame.Delta.OrderedIds is not null || frame.Delta.OrderPatch is not null;
            var hintTargets = frame.Delta.Hints.Count > 0
                ? new List<string>(frame.Delta.Hints.Select(h => h.TargetId).Distinct(StringComparer.Ordinal))
                : (IReadOnlyCollection<string>)Array.Empty<string>();

            // Advance the frame clock by the recorded wall time (60 Hz) BEFORE the drain, exactly like _Process/OnDrained.
            int nFrames = Math.Max(1, (int)Math.Round((frame.T - prevT) / (1000.0 / 60.0)));
            prevT = frame.T;
            for (int f = 0; f < nFrames; f++)
            {
                planner.ObserveFrame();
            }

            transforms.Update(state);
            planner.ObserveDrain(state, changedIds, hintTargets, keyframe);

            // Compute the current band plan (ALL_SHADERS sweep) — the offline analogue of the controller's plan.
            var (effectStaticOk, bottomOnly) = DeriveEffectSets(state);
            var plan = planner.PlanBandFlatten(state, transforms, DesignW, Empty, effectStaticOk, bottomOnly);

            // (b) Every produced band plan is ordering-exact.
            if (plan.IsBakeable && plan.BandIds is not null)
            {
                BandOrderingExact.AssertOrderingExact(plan, state, $"drain {drainIndex} band plan");
                result.PlansChecked++;
            }

            result.DrainCount++;

            if (!active)
            {
                if (plan.IsBakeable && plan.BandIds is not null)
                {
                    Arm(plan, ref active, ref activePlan, ref activeBandIds, ref activeExcludedRoots, activeMembers, activeWatched);
                    result.Builds++;
                    if (result.FirstArmDrain < 0)
                    {
                        result.FirstArmDrain = drainIndex;
                    }
                }

                continue;
            }

            result.ArmedDrains++;
            bool teardown = false;

            // ---- structural phase (keyframe / order change) ----
            bool ranCulpritScan = true;
            if (keyframe || orderChanged)
            {
                var sv = residency.EvaluateStructure(
                    state, keyframe, orderChanged, activeBandIds!, activeExcludedRoots,
                    keyframeSurvivalSupported: true, isWatched: id => activeWatched.Contains(id));
                switch (sv)
                {
                    case BandResidencyMachine.StructureVerdict.KeyframeSurvive:
                        continue; // bake stands, no watch scan
                    case BandResidencyMachine.StructureVerdict.KeyframeRetain:
                        result.KeyframeRetains++;
                        teardown = true; // invisible rebake (double-buffered) — a re-plan event, counted as learning
                        ranCulpritScan = false;
                        break;
                    case BandResidencyMachine.StructureVerdict.KeyframeDrop:
                        result.KeyframeDrops++;
                        teardown = true;
                        ranCulpritScan = false;
                        break;
                    case BandResidencyMachine.StructureVerdict.Teardown:
                        result.StructuralTeardowns++;
                        teardown = true;
                        ranCulpritScan = false;
                        break;
                    case BandResidencyMachine.StructureVerdict.ProceedOrderSkipped:
                        result.OrderSkips++;
                        break; // fall through to the culprit scan
                }
            }

            // ---- per-region watch scan + culprit classification ----
            if (!teardown && ranCulpritScan)
            {
                var changedCulprits = new List<string>();
                foreach (var id in changedIds)
                {
                    if (activeWatched.Contains(id))
                    {
                        changedCulprits.Add(id);
                    }
                }

                var hintCulprits = new List<string>();
                foreach (var id in hintTargets)
                {
                    if (activeWatched.Contains(id))
                    {
                        hintCulprits.Add(id);
                    }
                }

                if (changedCulprits.Count > 0 || hintCulprits.Count > 0)
                {
                    var verdict = residency.EvaluateCulprits(
                        changedCulprits, hintCulprits,
                        id => state.ChangeFlags.TryGetValue(id, out var fl) ? fl : NodeChangeFlags.None,
                        activeMembers.Contains,
                        id => IsCommonSpineCarrier(id, state, activePlan));

                    switch (verdict)
                    {
                        case BandResidencyMachine.CulpritVerdict.Survive:
                            result.Survives++;
                            break;
                        case BandResidencyMachine.CulpritVerdict.Follow:
                            result.Follows++;
                            break;
                        case BandResidencyMachine.CulpritVerdict.BenchAndTeardown:
                            result.CulpritBenchTeardowns++;
                            teardown = true;
                            break;
                        case BandResidencyMachine.CulpritVerdict.Teardown:
                            result.CulpritTeardowns++;
                            teardown = true;
                            break;
                    }
                }
                else
                {
                    result.Survives++;
                }
            }

            if (teardown)
            {
                result.TeardownDrains.Add(drainIndex);
                result.LastTeardownDrain = drainIndex;
                active = false; // re-arm next bakeable drain (double-buffer rebake / immediate raw are both a re-plan)
            }
        }

        // Teardown-free tail = drains after the last teardown-class decision.
        result.TeardownFreeTailDrains = result.LastTeardownDrain < 0
            ? result.ArmedDrains
            : result.DrainCount - 1 - result.LastTeardownDrain;

        // ---- (c) loop-seam keyframe: re-send the current (final) state identically ----
        // Ensure a bake is armed on the final state for the seam test.
        transforms.Update(state);
        var (okFinal, boFinal) = DeriveEffectSets(state);
        var finalPlan = planner.PlanBandFlatten(state, transforms, DesignW, Empty, okFinal, boFinal);
        if (finalPlan.IsBakeable && finalPlan.BandIds is not null)
        {
            Arm(finalPlan, ref active, ref activePlan, ref activeBandIds, ref activeExcludedRoots, activeMembers, activeWatched);
            long epochBefore = planner.RoomEpoch;
            var sigBefore = BandOrderingExact.Signature(activePlan);

            // The identical keyframe drain (same instances → ClassifyKeyframe == None for all).
            planner.ObserveFrame();
            planner.ObserveDrain(state, new HashSet<string>(state.Nodes.Keys), Array.Empty<string>(), keyframe: true);
            result.SeamVerdict = residency.EvaluateStructure(
                state, keyframe: true, orderChanged: true, activeBandIds!, activeExcludedRoots,
                keyframeSurvivalSupported: true, isWatched: id => activeWatched.Contains(id));

            transforms.Update(state);
            var afterPlan = planner.PlanBandFlatten(state, transforms, DesignW, Empty, okFinal, boFinal);
            result.SeamSignatureUnchanged = afterPlan.IsBakeable && BandOrderingExact.Signature(afterPlan) == sigBefore;
            result.SeamReLearned = planner.RoomEpoch != epochBefore || planner.LastKeyframeChangedIds.Count > 0;
        }
        else
        {
            // Should not happen on the canonical recording (its final state bakes); surface it clearly.
            result.SeamVerdict = BandResidencyMachine.StructureVerdict.KeyframeDrop;
            result.SeamSignatureUnchanged = false;
            result.SeamReLearned = true;
        }

        return result;
    }

    private static readonly HashSet<string> Empty = new(StringComparer.Ordinal);

    // Offline effectStaticOk / bottomOnly, exactly like StaticBakePlanProbe's ALL_SHADERS sweep: every shader node is
    // cleared for Static baking; Sub/Mul plain painters are bottom-only. (A shader's real blend class is unknowable
    // offline; combat's additive content is atmosphere PARTICLES, hard-rejected regardless — see the probe caveat.)
    private static (IReadOnlySet<string> EffectStaticOk, IReadOnlySet<string> BottomOnly) DeriveEffectSets(MirrorState state)
    {
        var ok = new HashSet<string>(StringComparer.Ordinal);
        var bottomOnly = new HashSet<string>(StringComparer.Ordinal);
        foreach (var n in state.Nodes.Values)
        {
            if (n.ShaderId is not null)
            {
                ok.Add(n.Id);
            }

            if (n.CanvasBlendMode is int b && b is 2 or 3)
            {
                bottomOnly.Add(n.Id);
            }
        }

        return (ok, bottomOnly);
    }

    private static void Arm(
        StaticBakePlan plan, ref bool active, ref StaticBakePlan activePlan,
        ref IReadOnlyList<string>? activeBandIds, ref IReadOnlyList<string>? activeExcludedRoots,
        HashSet<string> activeMembers, HashSet<string> activeWatched)
    {
        active = true;
        activePlan = plan;
        activeBandIds = plan.BandIds;
        activeExcludedRoots = plan.ExcludedLiveRoots;
        activeMembers.Clear();
        activeWatched.Clear();
        foreach (var r in plan.Regions)
        {
            foreach (var id in r.BakedIds)
            {
                activeMembers.Add(id);
            }

            foreach (var id in r.WatchedIds())
            {
                activeWatched.Add(id);
            }
        }
    }

    // The controller's IsCommonSpineCarrier: a carrier that is an ancestor of EVERY baked member in EVERY region (in
    // practice the band's root container — screen shake). Approximated here as: an active carrier that is an ancestor
    // of every active member.
    private static bool IsCommonSpineCarrier(string id, MirrorState state, StaticBakePlan plan)
    {
        bool isCarrier = false;
        foreach (var r in plan.Regions)
        {
            foreach (var c in r.CarrierIds)
            {
                if (string.Equals(c, id, StringComparison.Ordinal))
                {
                    isCarrier = true;
                    break;
                }
            }

            if (isCarrier)
            {
                break;
            }
        }

        if (!isCarrier)
        {
            return false;
        }

        foreach (var r in plan.Regions)
        {
            foreach (var member in r.BakedIds)
            {
                if (!IsAncestor(id, member, state))
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static bool IsAncestor(string ancestor, string node, MirrorState state)
    {
        var cur = state.Nodes.TryGetValue(node, out var n) ? n.ParentId : null;
        int guard = 0;
        while (cur is not null && guard++ < 4096)
        {
            if (string.Equals(cur, ancestor, StringComparison.Ordinal))
            {
                return true;
            }

            cur = state.Nodes.TryGetValue(cur, out var pn) ? pn.ParentId : null;
        }

        return false;
    }
}
