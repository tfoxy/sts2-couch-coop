using System.Text.Json.Nodes;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Live;

// The /spines/ bake instrument and the phase-table mapping both host renders share. The bake itself needs a
// live game (a Godot main-thread render), so what is checkable without one is everything around it: the
// still-vs-clip grouping (two different operations that share one lane), the blocking/parked split that is the
// whole point of the breakdown, the "not measured" vs "measured zero" distinction, and the shared envelope.
// Pure; assert-or-throw harness style.
internal static class SpineBakeMetricsTests
{
    public static void Run()
    {
        KindComesFromTheKeyNotTheCaller();
        RingRecordsAndResets();
        ReportGroupsByBakeKind();
        PhasesRideEachRunAndFoldPerKind();
        BlockingAndParkedAreReportedApart();
        AnUnphasedBakeIsReportedAsUnmeasuredNotAsZero();
        HostPhasesAreNeverCountedAsGameStall();
        BenchIsOptIn();
        StillModeIsStillTheDefault();
        SpineBakeMetrics.Reset();
    }

    private static void KindComesFromTheKeyNotTheCaller()
    {
        var stillKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/creature_visuals/x.tscn", null, "idle_loop", still: true);
        var clipKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/creature_visuals/x.tscn", null, "idle_loop");

        Assert(SpineBakeMetrics.KindOf(stillKey) == SpineBakeMetrics.StillKind, "a &still= key is a still bake");
        Assert(SpineBakeMetrics.KindOf(clipKey) == SpineBakeMetrics.ClipKind, "an animated key is a clip bake");
    }

    private static void RingRecordsAndResets()
    {
        SpineBakeMetrics.Reset();
        Assert(SpineBakeMetrics.Snapshot().Count == 0, "reset empties the ring");

        SpineBakeMetrics.Record(Sample("still", 120, 4_000));
        SpineBakeMetrics.Record(Sample("still", 140, 4_200));
        Assert(SpineBakeMetrics.Snapshot().Count == 2, "bakes accumulate in order");
        Assert(SpineBakeMetrics.Snapshot()[^1].BakeMs == 140, "the newest bake is last — the prerender log reads it");
    }

    private static void ReportGroupsByBakeKind()
    {
        SpineBakeMetrics.Reset();
        SpineBakeMetrics.Record(Sample("still", 100, 4_000));
        SpineBakeMetrics.Record(Sample("still", 140, 4_400));
        SpineBakeMetrics.Record(Sample("clip", 3_000, 900_000, frames: 46));
        SpineBakeMetrics.Record(Sample("still", 0, 0, success: false));

        var json = JsonNode.Parse(PerfReport.ToJson(SpineBakeMetrics.BuildReport(
            "spine-bake", SpineBakeMetrics.Snapshot(), envKind: PerfReport.HostKind, envLabel: "unit", warmups: 1)))!.AsObject();

        Assert((string?)json["schema"] == "perf-report/1" && (string?)json["repo"] == "sts2-couch-coop", "shared envelope header");
        Assert((string?)json["profile"] == "asset-render", "same profile as the background render report, so the two compare");
        Assert(json["runs"]!.AsArray().Count == 4, "every bake (incl. the failed one) is a raw run entry");

        var metrics = json["metrics"]!.AsObject();
        Assert(metrics.ContainsKey("still") && metrics.ContainsKey("clip"), "one metric block per bake kind");
        Assert((int?)metrics["still"]!["bakes"] == 2, "a failed bake is not counted as a bake");
        Assert((int?)metrics["failedBakes"] == 1, "failures are reported rather than dropped");
        Assert((double?)metrics["still"]!["bakeMs"]!["p50"] == 100, "p50 over the still bakes only");
        Assert((double?)metrics["clip"]!["frames"]!["max"] == 46, "a clip's frame count is not averaged into the stills");
    }

    private static void PhasesRideEachRunAndFoldPerKind()
    {
        SpineBakeMetrics.Reset();
        SpineBakeMetrics.Record(Sample("still", 200, 4_000, phases:
        [
            new(Sts2RenderPhaseProfile.Phase.LaneBuild, 60, 1, true),
            new(Sts2RenderPhaseProfile.Phase.WarmupWait, 90, 3, false),
            new(Sts2RenderPhaseProfile.Phase.EncodeFrame, 20, 1, false),
        ]));
        SpineBakeMetrics.Record(Sample("still", 240, 4_100, phases:
        [
            new(Sts2RenderPhaseProfile.Phase.LaneBuild, 100, 1, true),
            new(Sts2RenderPhaseProfile.Phase.WarmupWait, 110, 3, false),
        ]));

        var json = JsonNode.Parse(PerfReport.ToJson(SpineBakeMetrics.BuildReport(
            "spine-phases", SpineBakeMetrics.Snapshot())))!.AsObject();

        var runPhases = json["runs"]!.AsArray()[0]!["phases"]!.AsObject();
        Assert((double?)runPhases[Sts2RenderPhaseProfile.Phase.LaneBuild]!["ms"] == 60, "a run carries its own phase costs");
        Assert((int?)runPhases[Sts2RenderPhaseProfile.Phase.WarmupWait]!["calls"] == 3, "and how many times each ran");

        var phases = json["metrics"]!["still"]!["phases"]!.AsObject();
        Assert((double?)phases[Sts2RenderPhaseProfile.Phase.LaneBuild]!["totalMs"] == 160, "phase totals fold across bakes");
        Assert((double?)phases[Sts2RenderPhaseProfile.Phase.LaneBuild]!["ms"]!["p50"] == 60, "and keep a distribution");
        // encodeFrame ran in ONE of the two bakes; averaging it against a zero would understate it by half.
        Assert((int?)phases[Sts2RenderPhaseProfile.Phase.EncodeFrame]!["renders"] == 1,
            "a phase only some bakes reach reports the count that actually ran it");
        Assert((double?)phases[Sts2RenderPhaseProfile.Phase.EncodeFrame]!["ms"]!["p50"] == 20, "and is not diluted by the bakes that skipped it");

        // Render order, not alphabetical: the table is read as the sequence the bake performed.
        var order = phases.Select(pair => pair.Key).ToList();
        Assert(order.IndexOf(Sts2RenderPhaseProfile.Phase.LaneBuild) < order.IndexOf(Sts2RenderPhaseProfile.Phase.WarmupWait)
            && order.IndexOf(Sts2RenderPhaseProfile.Phase.WarmupWait) < order.IndexOf(Sts2RenderPhaseProfile.Phase.EncodeFrame),
            "phases are reported in render order");
    }

    private static void BlockingAndParkedAreReportedApart()
    {
        SpineBakeMetrics.Reset();
        SpineBakeMetrics.Record(Sample("still", 200, 4_000, phases:
        [
            new(Sts2RenderPhaseProfile.Phase.Readback, 30, 1, true),
            new(Sts2RenderPhaseProfile.Phase.WarmupWait, 90, 3, false),
        ]));

        var split = JsonNode.Parse(PerfReport.ToJson(SpineBakeMetrics.BuildReport(
            "spine-split", SpineBakeMetrics.Snapshot())))!["metrics"]!["still"]!["split"]!.AsObject();

        Assert((double?)split["blockingMs"]!["p50"] == 30, "only main-thread phases count as the game stall");
        Assert((double?)split["parkedMs"]!["p50"] == 90, "waiting on frames is latency, not a stall");
        Assert((double?)split["blockingShare"] == 0.25, "blockingShare = blocking / measured");
        Assert((int?)split["phasedRenders"] == 1, "and says how many bakes the split covers");
    }

    private static void AnUnphasedBakeIsReportedAsUnmeasuredNotAsZero()
    {
        SpineBakeMetrics.Reset();
        SpineBakeMetrics.Record(Sample("still", 200, 4_000)); // no phases: the render lane was not recording

        var json = JsonNode.Parse(PerfReport.ToJson(SpineBakeMetrics.BuildReport(
            "spine-unphased", SpineBakeMetrics.Snapshot())))!.AsObject();

        Assert(json["runs"]!.AsArray()[0]!["phases"] is null, "an unmeasured bake reports null phases, not a table of zeros");
        Assert(json["metrics"]!["still"]!["phases"] is null, "and contributes no phase distribution");
        Assert(json["metrics"]!["still"]!["split"] is null, "and no blocking/parked split");
        Assert((int?)json["params"]!["phasedBakes"] == 0 && (int?)json["params"]!["unphasedBakes"] == 1,
            "params say how much of the report is actually phased");
    }

    private static void HostPhasesAreNeverCountedAsGameStall()
    {
        // Queueing and disk happen on a request thread; counting them as blocking would blame the game loop for
        // time it never lost.
        foreach (var name in new[] { HostRenderPhases.GateWait, HostRenderPhases.CacheRead, HostRenderPhases.CacheWrite, HostRenderPhases.Serialize })
        {
            Assert(!HostRenderPhases.Phase(name, 10).Blocking, $"{name} is never reported as main-thread time");
        }
    }

    private static void BenchIsOptIn()
    {
        // The bench re-bakes something a cache already answered, so it must be off unless explicitly asked for.
        Assert(SpineBakeMetrics.BenchEnvVar == "COUCHCOOP_SPINE_BENCH", "documented env var name");
        Assert(Environment.GetEnvironmentVariable(SpineBakeMetrics.BenchEnvVar) is not "1" || SpineBakeMetrics.BenchEnabled,
            "bench flag mirrors its env var");
    }

    private static void StillModeIsStillTheDefault()
    {
        // Guard for "instrument only": this round measured the bake but must not have changed which bake runs.
        Assert(CouchCoopSpineClipProvider.SpineClipSizePolicy == "codec=webp&fps=15&q=85", "the shipped clip size policy is unchanged");
    }

    private static SpineBakeMetrics.Sample Sample(
        string kind,
        double ms,
        int bytes,
        bool success = true,
        int frames = 1,
        IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost>? phases = null)
        => new(
            0,
            $"spine://scenes/x.tscn?anim=idle{(kind == SpineBakeMetrics.StillKind ? CouchCoopSpineClipProvider.StillSelector : string.Empty)}",
            kind,
            ms,
            bytes,
            frames,
            success,
            "unit",
            Phases: phases);

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"SpineBakeMetricsTests failed: {label}.");
        }
    }
}
