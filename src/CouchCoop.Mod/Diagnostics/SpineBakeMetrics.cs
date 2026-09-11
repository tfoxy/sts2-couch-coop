using System.Text.Json.Nodes;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Diagnostics;

/// <summary>
/// How long a <c>/spines/</c> bake takes and WHERE the time goes, per bake kind. The twin of
/// <see cref="StaticBackgroundRenderMetrics"/> for the other host-side render: the mirror's default
/// <c>spineMode</c> asks for a server-baked STILL per visible spine, and a fresh install bakes the whole catalog
/// (<c>--prerender-spines</c>), so this is the render a session pays for most often.
/// </summary>
/// <remarks>
/// Always on, for the same reason the background instrument is: a bake is a main-thread operation measured in
/// hundreds of milliseconds, so one struct per bake costs nothing next to it, and the numbers are only useful if
/// they are already there when a room feels slow.
/// <para>
/// Metric blocks are keyed by BAKE KIND (<c>still</c> / <c>clip</c>) rather than by subject: a single-frame still
/// and a 60-frame animated clip are different operations that happen to share a lane, and averaging them would
/// describe neither. Per-subject detail lives in <c>runs[]</c>.
/// </para>
/// </remarks>
public static class SpineBakeMetrics
{
    /// <summary>
    /// Opt-IN kill-switch for the measurement ROUTE that re-bakes an already-cached spine key. Default OFF, so a
    /// shipped host never repeats work a cache already answered. Mirrors <c>COUCHCOOP_BG_BENCH</c>.
    /// </summary>
    public const string BenchEnvVar = "COUCHCOOP_SPINE_BENCH";

    public static bool BenchEnabled => Environment.GetEnvironmentVariable(BenchEnvVar) == "1";

    /// <summary>
    /// A prerender sweep bakes the whole catalog, which is hundreds of items — far more than a report should
    /// carry. 256 keeps the most recent bakes (the sweep's tail, or a whole play session's on-demand bakes).
    /// </summary>
    public const int Capacity = 256;

    public const string StillKind = "still";
    public const string ClipKind = "clip";

    /// <summary>
    /// A GEOMETRY bake (<c>/geoclips/</c>): per-part meshes and per-frame tracks instead of encoded pixels.
    /// </summary>
    /// <remarks>
    /// Its own metric block for the same reason a still and a clip have separate ones, only more so: a geoclip and
    /// the raster still it replaces are two different ways to answer one request, so the whole point of measuring
    /// them is to lay the blocks SIDE BY SIDE. Folding a geoclip into <see cref="ClipKind"/> — which is where
    /// <see cref="KindOf"/> would put it, since a geoclip key is the ANIMATED clip identity — would average the
    /// two lanes together and describe neither, and would also corrupt the raster row this repo has been
    /// comparing across rounds. It is therefore passed EXPLICITLY at the recorder rather than derived from the key.
    /// </remarks>
    public const string GeoclipKind = "geoclip";

    /// <summary>
    /// Counters on a GEOCLIP run: how many of that bake's slot→mesh claims carried a positive ownership proof,
    /// and how many did not.
    /// </summary>
    /// <remarks>
    /// <para>THE ADMISSION RULE'S INPUT, on the report a live operator already reads. The third arm of the
    /// completeness rule refuses a bake when the RID bracket holds unclaimed geometry AND some claim is unproven
    /// (<see cref="Server.CouchCoopGeoclipProvider.IncompletenessReason(bool,int,int,int,int,int,bool?)"/>), so
    /// these two numbers are what separates "the artifact shipped" from "the artifact was correct and thrown
    /// away". A refused bake announces them on <see cref="Server.CouchCoopGeoclipProvider.RefusalHeader"/>; an
    /// ADMITTED one has no refusal to announce, and this is where it says what it rested on.</para>
    /// <para>ABSENT MEANS NO PROVENANCE, never zero claims — the counters are omitted entirely when the pair sums
    /// to zero, because a producer that recorded nothing and a bake that proved nothing are opposite findings and
    /// a pair of zeros cannot tell them apart. Same rule as the phase table's "no phases is not a cheap bake".
    /// </para>
    /// </remarks>
    public const string ClaimsProvenCounter = "geoclipClaimsProven";

    /// <summary>The other half of <see cref="ClaimsProvenCounter"/>.</summary>
    public const string ClaimsUnprovenCounter = "geoclipClaimsUnproven";

    private static readonly object Gate = new();
    private static readonly Sample[] Ring = new Sample[Capacity];
    private static int _count;
    private static int _next;

    /// <param name="Key">The <c>spine://</c> key that was baked — the subject, animation and policy in one string.</param>
    /// <param name="Kind"><see cref="StillKind"/> or <see cref="ClipKind"/>.</param>
    /// <param name="Frames">Frames the bake produced (1 for a still), or 0 when it failed.</param>
    /// <param name="Route">Which entry point asked: the clip-wire route, the still-image route, or the prerender sweep.</param>
    /// <param name="Phases">
    /// WHERE the time went (<see cref="Sts2RenderPhaseProfile"/>) plus this side's queue/serialize/disk phases.
    /// EMPTY means not measured — never "measured as nothing".
    /// </param>
    public readonly record struct Sample(
        double TimestampMs,
        string Key,
        string Kind,
        double BakeMs,
        int OutputBytes,
        int Frames,
        bool Success,
        string Route,
        double? CpuMs = null,
        double? CpuWallMs = null,
        IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost>? Phases = null,
        IReadOnlyDictionary<string, long>? Counters = null)
    {
        public IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost> PhaseCosts => Phases ?? [];
    }

    public static void Record(Sample sample)
    {
        lock (Gate)
        {
            Ring[_next] = sample;
            _next = (_next + 1) % Ring.Length;
            if (_count < Ring.Length)
            {
                _count++;
            }
        }
    }

    public static void Reset()
    {
        lock (Gate)
        {
            _count = 0;
            _next = 0;
        }
    }

    public static IReadOnlyList<Sample> Snapshot()
    {
        lock (Gate)
        {
            var result = new Sample[_count];
            var start = _count < Ring.Length ? 0 : _next;
            for (var i = 0; i < _count; i++)
            {
                result[i] = Ring[(start + i) % Ring.Length];
            }

            return result;
        }
    }

    /// <summary>Whether a <c>spine://</c> key addresses a single still frame (its <c>&amp;still=</c> selector).</summary>
    public static string KindOf(string spineKey)
        => spineKey.Contains("&still=", StringComparison.Ordinal) ? StillKind : ClipKind;

    /// <summary>
    /// The same <c>perf-report/1</c> envelope the background report answers in, so a bake and a background render
    /// can be laid side by side. One metric block per bake kind; <c>runs[]</c> carries one object per bake.
    /// </summary>
    public static JsonObject BuildReport(
        string scenario,
        IReadOnlyList<Sample> samples,
        string? envKind = null,
        string? envLabel = null,
        int warmups = 0,
        JsonObject? extraParams = null)
    {
        var runs = new List<JsonObject>(samples.Count);
        foreach (var sample in samples)
        {
            var run = new JsonObject
            {
                ["key"] = sample.Key,
                ["kind"] = sample.Kind,
                ["route"] = sample.Route,
                ["bakeMs"] = PerfStats.JsonValueOrNull(PerfStats.Round(sample.BakeMs, 2)),
                ["outputBytes"] = sample.OutputBytes,
                ["frames"] = sample.Frames,
                ["success"] = sample.Success,
                ["phases"] = RenderPhaseReport.PhasesJson(sample.PhaseCosts),
                ["counters"] = RenderPhaseReport.CountersJson(sample.Counters),
            };

            if (ProcessCpuMetrics.TryBuildCpuBlock(
                CpuWindowOf(sample), ProcessCpuMetrics.FullCoverage, out var runCpu, out var runReason))
            {
                run["cpu"] = runCpu;
            }
            else
            {
                run["cpuOmittedReason"] = runReason;
            }

            runs.Add(run);
        }

        var metrics = new JsonObject();
        foreach (var group in samples.Where(s => s.Success).GroupBy(s => s.Kind).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var measured = group.Select(UsableCpuWindowOf).OfType<ProcessCpuMetrics.Window>().ToList();
            var phases = group.Select(s => s.PhaseCosts).ToList();
            metrics[group.Key] = new JsonObject
            {
                ["bakes"] = group.Count(),
                ["bakeMs"] = PerfStats.Distribution([.. group.Select(s => s.BakeMs)], 2),
                ["outputBytes"] = PerfStats.Distribution([.. group.Select(s => (double)s.OutputBytes)], 0),
                ["frames"] = PerfStats.Distribution([.. group.Select(s => (double)s.Frames)], 0),
                ["split"] = RenderPhaseReport.BlockingSplit(phases),
                ["phases"] = RenderPhaseReport.PhaseDistributions(phases),
                ["cpuMeasuredBakes"] = measured.Count,
                ["cpuMs"] = PerfStats.Distribution([.. measured.Select(w => w.CpuMs)], 2),
                ["coreRatio"] = PerfStats.Distribution([.. measured.Select(w => w.CoreRatio)], 4),
            };
        }

        metrics["failedBakes"] = samples.Count(s => !s.Success);

        var parameters = extraParams is null ? [] : (JsonObject)extraParams.DeepClone();
        parameters["spineClipSizePolicy"] = Server.CouchCoopSpineClipProvider.SpineClipSizePolicy;
        parameters["phasedBakes"] = samples.Count(sample => sample.PhaseCosts.Count > 0);
        parameters["unphasedBakes"] = samples.Count(sample => sample.PhaseCosts.Count == 0);

        // Same fold rule as the background report: summed CPU over the summed wall of the bakes that carried a
        // reading. Bakes are serialized by the extraction gate, so their windows are disjoint and the sum is the
        // window the ratio is over.
        var windows = samples.Select(UsableCpuWindowOf).OfType<ProcessCpuMetrics.Window>().ToList();
        var folded = windows.Count == 0
            ? (ProcessCpuMetrics.Window?)null
            : new ProcessCpuMetrics.Window(windows.Sum(w => w.CpuMs), windows.Sum(w => w.WallMs));
        var totalWallMs = samples.Sum(s => CpuWindowOf(s)?.WallMs ?? s.BakeMs);
        var coverage = totalWallMs > 0 ? windows.Sum(w => w.WallMs) / totalWallMs : 0.0;
        var measuredCpu = ProcessCpuMetrics.TryBuildCpuBlock(folded, coverage, out var cpu, out var cpuReason);
        if (measuredCpu)
        {
            metrics["cpu"] = cpu;
        }

        parameters["cpuMeasuredBakes"] = windows.Count;
        parameters["cpuUnmeasuredBakes"] = samples.Count - windows.Count;
        ProcessCpuMetrics.StampParams(parameters, measuredCpu, cpuReason);

        return PerfReport.Build(
            PerfReport.ProfileAssetRender,
            scenario,
            metrics,
            runs,
            parameters,
            envKind,
            envLabel,
            cpuThrottle: null,
            device: null,
            warmups: warmups);
    }

    /// <summary>The CPU window a sample carries, or null. Both halves must be present — see the background twin.</summary>
    public static ProcessCpuMetrics.Window? CpuWindowOf(Sample sample)
        => sample is { CpuMs: { } cpuMs, CpuWallMs: { } wallMs } ? new ProcessCpuMetrics.Window(cpuMs, wallMs) : null;

    /// <summary>The subset worth aggregating: a window at or above the process CPU clock's resolution floor.</summary>
    public static ProcessCpuMetrics.Window? UsableCpuWindowOf(Sample sample)
        => CpuWindowOf(sample) is { } window && window.WallMs >= ProcessCpuMetrics.MinWindowMs ? window : null;
}
