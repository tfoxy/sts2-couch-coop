using System.Text.Json.Nodes;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Server;

// S10 — the /bg/ render-time instrument. The RENDER itself needs a live game (a Godot main-thread viewport
// render), so what is checkable without one is everything around it: the per-size grouping that makes a
// 1920-vs-2520 comparison readable, the size-list grammar the measurement route parses (a silently dropped
// size would make the report claim a comparison it never ran), the always-on ring, and the shared envelope.
// Pure; assert-or-throw harness style.
internal static class StaticBackgroundRenderMetricsTests
{
    public static void Run()
    {
        SizeGrammarParses();
        SizeGrammarRejectsGarbage();
        FormatGrammarParses();
        FormatGrammarRejectsGarbage();
        CodecLabelsKeepCandidatesApart();
        RingRecordsAndResets();
        ReportGroupsBySize();
        CpuBlockIsMeasuredPerRenderAndFoldedOverTheMeasuredOnes();
        PartlyMeasuredRendersReportTheirRealCoverage();
        AnUnmeasurableCpuWindowIsOmittedWithItsReason();
        NoGpuBlockOnAnAssetRenderReport();
        BenchIsOptIn();
        PolicySizeIsTheDefaultRenderSize();
        StaticBackgroundRenderMetrics.Reset();
    }

    // ---- the shared cross-repo `cpu` block ---------------------------------------------------------------
    // Same shape and same meaning as spirectl's producer-walk block and gsw's browser-render block, so
    // "CPU per unit of work" can be read across the three repos without translating units.

    private static void CpuBlockIsMeasuredPerRenderAndFoldedOverTheMeasuredOnes()
    {
        StaticBackgroundRenderMetrics.Reset();
        // Two renders at one size: 400ms wall / 380ms CPU and 600ms wall / 540ms CPU.
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 400, 1_500_000, cpuMs: 380, cpuWallMs: 400));
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 600, 1_520_000, cpuMs: 540, cpuWallMs: 600));

        var json = JsonNode.Parse(PerfReport.ToJson(StaticBackgroundRenderMetrics.BuildReport(
            "bg-render-cpu", StaticBackgroundRenderMetrics.Snapshot())))!.AsObject();
        var metrics = json["metrics"]!.AsObject();
        var cpu = metrics["cpu"]!.AsObject();

        Assert((double?)cpu["windowMs"] == 1000, "metrics.cpu.windowMs sums the measured render windows");
        Assert((double?)cpu["totalCpuMs"] == 920, "metrics.cpu.totalCpuMs sums their measured CPU");
        Assert((double?)cpu["totalCoreRatio"] == 0.92, "totalCoreRatio = totalCpuMs / windowMs");

        var entry = cpu["byThread"]!.AsArray()[0]!.AsObject();
        // A process-wide reading gets a process-wide NAME. Calling it `main` would claim an attribution that
        // .NET cannot give us, which is the failure mode this whole envelope exists to make impossible.
        Assert((string?)entry["thread"] == ProcessCpuMetrics.ThreadName && (string?)entry["thread"] == "process-total",
            "byThread carries the one honest process-total entry, not a fabricated thread name");
        Assert((double?)entry["cpuMs"] == 920 && (double?)entry["wallMs"] == 1000, "the entry repeats the same measured pair");
        Assert(((string?)entry["process"])?.Length > 0, "and names the process it was measured in");

        // Every render carried a reading, so the fold covers all of the render wall time.
        Assert((double?)cpu["cpuCoverage"] == 1, "cpuCoverage is 1 when every render was measured");
        // byProcess is a REAL entry: `{}` would read as "no process burned CPU".
        var byProcess = cpu["byProcess"]!.AsObject();
        Assert(byProcess.Count == 1, "one process ran these renders, and it is named");
        Assert((double?)byProcess.First().Value!["cpuMs"] == 920, "the process entry repeats the same measured CPU");
        Assert(!cpu.ContainsKey("gpu") && !metrics.ContainsKey("gpu"), "no gpu block on a CPU-only profile");

        // Per size, and per run: the same numbers, so a reader can check the fold.
        var size = metrics["2520x1080"]!.AsObject();
        Assert((int?)size["cpuMeasuredRenders"] == 2, "the size block says how many renders backed its cpu numbers");
        Assert((double?)size["cpuMs"]!["max"] == 540, "cpuMs distribution per size");
        Assert((double?)size["coreRatio"]!["max"] == 0.95, "coreRatio distribution per size (380/400 = 0.95)");
        Assert((double?)json["runs"]![0]!["cpu"]!["totalCpuMs"] == 380, "each run carries its own measured window");
        Assert((int?)json["params"]!["cpuMeasuredRenders"] == 2 && (int?)json["params"]!["cpuUnmeasuredRenders"] == 0,
            "params account for every render, measured or not");
        Assert((string?)json["params"]!["cpuSource"] == ProcessCpuMetrics.Source, "params name how the CPU number was obtained");
        Assert(((string?)json["params"]!["cpuCaveat"])!.Contains("upper bound", StringComparison.Ordinal),
            "the upper-bound caveat travels with the number");
        StaticBackgroundRenderMetrics.Reset();
    }

    private static void PartlyMeasuredRendersReportTheirRealCoverage()
    {
        StaticBackgroundRenderMetrics.Reset();
        // 600ms measured + 600ms unmeasured (below the CPU clock's resolution, recorded but not priced).
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 600, 1_500_000, cpuMs: 300, cpuWallMs: 600));
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 600, 1_500_000));

        var json = JsonNode.Parse(PerfReport.ToJson(StaticBackgroundRenderMetrics.BuildReport(
            "bg-render-partial", StaticBackgroundRenderMetrics.Snapshot())))!.AsObject();
        var cpu = json["metrics"]!["cpu"]!.AsObject();

        // THE reason cpuCoverage exists: the fold's window is only the measured renders, so without this a
        // reader would take a half-covered run for a complete one. 600 of 1200ms carried a reading.
        Assert((double?)cpu["cpuCoverage"] == 0.5, $"cpuCoverage is the measured share (got {cpu["cpuCoverage"]})");
        Assert((double?)cpu["windowMs"] == 600, "the window is the measured renders only, and says so via coverage");
        Assert((double?)cpu["totalCoreRatio"] == 0.5, "the ratio is over the window it was actually measured on");
        Assert((int?)json["params"]!["cpuMeasuredRenders"] == 1 && (int?)json["params"]!["cpuUnmeasuredRenders"] == 1,
            "params account for both renders");
        StaticBackgroundRenderMetrics.Reset();
    }

    private static void AnUnmeasurableCpuWindowIsOmittedWithItsReason()
    {
        StaticBackgroundRenderMetrics.Reset();
        // A render far below the process CPU clock's ~10ms tick. A reading here would be quantization, and a
        // quantized 0 reads exactly like "this render was free" — so there must be no number at all.
        StaticBackgroundRenderMetrics.Record(Sample(1920, 1080, 3, 900_000, cpuMs: 0, cpuWallMs: 3));
        // And one with no reading whatsoever (the counter was unreadable).
        StaticBackgroundRenderMetrics.Record(Sample(1920, 1080, 700, 900_000));

        var json = JsonNode.Parse(PerfReport.ToJson(StaticBackgroundRenderMetrics.BuildReport(
            "bg-render-nocpu", StaticBackgroundRenderMetrics.Snapshot())))!.AsObject();

        Assert(!json["metrics"]!.AsObject().ContainsKey("cpu"), "no cpu block when nothing could be measured honestly");
        Assert((string?)json["params"]!["cpuSource"] == "unmeasured", "params say so rather than leaving it ambiguous");
        Assert(((string?)json["params"]!["cpuOmittedReason"])!.Length > 0, "and say WHY");
        // BOTH are unmeasured: one carried no reading at all, the other carried a sub-resolution one, which is
        // quantization rather than a measurement and is excluded from every aggregate alike.
        Assert((int?)json["params"]!["cpuUnmeasuredRenders"] == 2, "a sub-resolution reading counts as unmeasured too");
        Assert((int?)json["params"]!["cpuMeasuredRenders"] == 0, "…and none of them backed a cpu number");
        foreach (var run in json["runs"]!.AsArray())
        {
            Assert(!run!.AsObject().ContainsKey("cpu") && ((string?)run["cpuOmittedReason"])!.Length > 0,
                "each unmeasurable run explains itself instead of reporting a plausible zero");
        }

        StaticBackgroundRenderMetrics.Reset();
    }

    private static void NoGpuBlockOnAnAssetRenderReport()
    {
        StaticBackgroundRenderMetrics.Reset();
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 400, 1_500_000, cpuMs: 380, cpuWallMs: 400));
        var json = JsonNode.Parse(PerfReport.ToJson(StaticBackgroundRenderMetrics.BuildReport(
            "bg-render-nogpu", StaticBackgroundRenderMetrics.Snapshot())))!.AsObject();

        // These profiles report CPU only. A zeroed gpu block would be indistinguishable from a real measurement
        // of an idle GPU, and this report has no GPU instrumentation at all — the shared validator rejects one.
        Assert(!json["metrics"]!.AsObject().ContainsKey("gpu"), "no gpu block in metrics");
        foreach (var run in json["runs"]!.AsArray())
        {
            Assert(!run!.AsObject().ContainsKey("gpu"), "and none on a run either");
        }
        StaticBackgroundRenderMetrics.Reset();
    }

    private static void SizeGrammarParses()
    {
        var sizes = StaticBackgroundRenderMetrics.TryParseSizes("1920x1080,2520x1080");
        Assert(sizes is { Count: 2 }, "two sizes parse");
        Assert(sizes![0] == (1920, 1080) && sizes[1] == (2520, 1080), "sizes parse in the order given");
        Assert(StaticBackgroundRenderMetrics.TryParseSizes(" 1280x720 ")?[0] == (1280, 720), "whitespace tolerated");
        Assert(StaticBackgroundRenderMetrics.SizeKey(1920, 1080) == "1920x1080", "size key grammar");
    }

    private static void SizeGrammarRejectsGarbage()
    {
        foreach (var bad in new[] { "", "1920", "1920x", "x1080", "1920x0", "1920x99999", "1920by1080", "1920x1080,oops" })
        {
            Assert(StaticBackgroundRenderMetrics.TryParseSizes(bad) is null, $"'{bad}' is rejected outright, not partially accepted");
        }
    }

    // R21: `formats=codec[@quality][:opaque]`. The grammar is what lets one bench run price the whole encoder
    // field in one table; the LABEL is what keeps two settings of one codec from folding into one row.
    private static void FormatGrammarParses()
    {
        var formats = StaticBackgroundRenderMetrics.TryParseFormats("png,webp,webp@0.85,jpg@0.9,png:opaque,webp@0.75:opaque");
        Assert(formats is { Count: 6 }, $"six candidates parse (got {formats?.Count.ToString() ?? "null"})");

        Assert(formats![0] == new StaticBackgroundRenderMetrics.BenchCodec("png"), "bare png parses to lossless png with alpha");
        // R21: png stopped being the shipped policy (it is jpg@0.9 now), so it is an ordinary bench candidate and
        // gets its own labelled metric block — which is exactly what a png-vs-jpg comparison needs.
        Assert(!formats[0].IsShippedPolicy && formats[0].Label == "png", "…and is no longer the shipped policy");

        // webp WITHOUT a quality is lossless — the shipped clip call. Reading it as "lossy at some default"
        // would mislabel the row that the whole comparison hangs off.
        Assert(formats[1].Codec == "webp" && formats[1].Quality is null && !formats[1].Opaque, "bare webp is lossless with alpha");
        Assert(formats[2].Quality is { } q85 && Math.Abs(q85 - 0.85f) < 1e-6, "webp@0.85 carries its quality");
        Assert(formats[3].Codec == "jpg" && formats[3].Quality is { } q90 && Math.Abs(q90 - 0.9f) < 1e-6, "jpg@0.9 parses");
        Assert(formats[4].Codec == "png" && formats[4].Opaque && formats[4].Quality is null, "png:opaque strips alpha, no quality");
        Assert(formats[5].Codec == "webp" && formats[5].Opaque && formats[5].Quality is not null, "@quality and :opaque compose");

        // Round trip: a block label in the report can be pasted straight back into a query to re-run it.
        Assert(formats[2].Label == "webp@0.85" && formats[5].Label == "webp@0.75:opaque", "labels round-trip the grammar");
        Assert(StaticBackgroundRenderMetrics.TryParseFormats(" PNG , WebP@0.85 ") is { Count: 2 }, "case and whitespace tolerated");
        Assert(StaticBackgroundRenderMetrics.TryParseFormats("png,png") is { Count: 1 }, "duplicates collapse");
        // …but two DIFFERENT settings of one codec are not duplicates.
        Assert(StaticBackgroundRenderMetrics.TryParseFormats("webp,webp@0.85,webp@0.75") is { Count: 3 }, "one codec, three candidates");
    }

    private static void FormatGrammarRejectsGarbage()
    {
        foreach (var bad in new[]
                 {
                     "", "   ", "avif", "qoi", "jxl", "png,oops", "webp@", "webp@abc", "webp@0", "webp@-1",
                     "webp@1.5", "webp@85", "png@0.8", "png:transparent", "png:", "webp@0.85:opaque:opaque",
                 })
        {
            Assert(StaticBackgroundRenderMetrics.TryParseFormats(bad) is null,
                $"'{bad}' is rejected outright, not partially accepted");
        }
    }

    private static void CodecLabelsKeepCandidatesApart()
    {
        StaticBackgroundRenderMetrics.Reset();
        // Same size, four encode candidates. If the metric key ignored the codec these would average into one
        // block and the comparison the bench exists for would silently not exist.
        var shipped = CouchCoopStaticBackgroundProvider.ShippedCodec.Label;
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 300, 280_000, codec: shipped));
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 700, 2_100_000, codec: "png"));
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 500, 1_400_000, codec: "webp"));
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 300, 400_000, codec: "webp@0.85"));

        var json = JsonNode.Parse(PerfReport.ToJson(StaticBackgroundRenderMetrics.BuildReport(
            "bg-render-codecs", StaticBackgroundRenderMetrics.Snapshot())))!.AsObject();
        var metrics = json["metrics"]!.AsObject();

        // The SHIPPED policy keys as the bare size exactly as it always did, so cross-round comparisons line up
        // even though the shipped encoder itself moved (png -> jpg@0.9 in R21).
        Assert(metrics.ContainsKey("2520x1080"), $"the shipped policy ({shipped}) keeps the bare size key");
        Assert((double?)metrics["2520x1080"]!["outputBytes"]!["max"] == 280_000, "…and it is the shipped candidate's bytes there");
        Assert(metrics.ContainsKey("2520x1080:png"), "png is now an ordinary bench candidate with its own block");
        Assert(metrics.ContainsKey("2520x1080:webp") && metrics.ContainsKey("2520x1080:webp@0.85"),
            "each non-policy candidate gets its own block");
        Assert((double?)metrics["2520x1080:webp@0.85"]!["outputBytes"]!["max"] == 400_000,
            "and its own bytes — not an average across encoders");

        var dumpLabels = new StaticBackgroundRenderMetrics.BenchCodec("webp", 0.85f, true);
        Assert(dumpLabels.FileLabel == "webp-q85-opaque" && dumpLabels.FileExtension == "webp",
            $"dump filenames are filename-safe (got {dumpLabels.FileLabel})");
        Assert(new StaticBackgroundRenderMetrics.BenchCodec("jpg", 0.9f).FileExtension == "jpg", "jpg dumps as .jpg");
        StaticBackgroundRenderMetrics.Reset();
    }

    private static void RingRecordsAndResets()
    {
        StaticBackgroundRenderMetrics.Reset();
        for (var i = 0; i < StaticBackgroundRenderMetrics.Capacity + 5; i++)
        {
            StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, i, 1000));
        }

        var samples = StaticBackgroundRenderMetrics.Snapshot();
        Assert(samples.Count == StaticBackgroundRenderMetrics.Capacity, "the ring is capped");
        Assert(samples[^1].RenderMs == StaticBackgroundRenderMetrics.Capacity + 4, "newest render survives");
        StaticBackgroundRenderMetrics.Reset();
        Assert(StaticBackgroundRenderMetrics.Snapshot().Count == 0, "reset empties the ring");
    }

    private static void ReportGroupsBySize()
    {
        StaticBackgroundRenderMetrics.Reset();
        StaticBackgroundRenderMetrics.Record(Sample(1920, 1080, 100, 900_000));
        StaticBackgroundRenderMetrics.Record(Sample(1920, 1080, 120, 910_000));
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 200, 1_500_000));
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 240, 1_520_000));
        StaticBackgroundRenderMetrics.Record(Sample(2520, 1080, 0, 0, success: false));

        var report = StaticBackgroundRenderMetrics.BuildReport(
            "bg-render", StaticBackgroundRenderMetrics.Snapshot(), envKind: PerfReport.HostKind, envLabel: "unit", warmups: 1);
        var json = JsonNode.Parse(PerfReport.ToJson(report))!.AsObject();

        Assert((string?)json["schema"] == "perf-report/1" && (string?)json["repo"] == "sts2-couch-coop", "shared envelope header");
        Assert((string?)json["profile"] == "asset-render", "profile names the metric set (per-size render times, not browser frames)");
        Assert(json["runs"]!.AsArray().Count > 0, "runs is never empty");
        Assert((int?)json["warmups"] == 1, "warmups ride the envelope");
        Assert(json["runs"]!.AsArray().Count == 5, "every render (incl. the failed one) is a raw run entry");

        var metrics = json["metrics"]!.AsObject();
        Assert(metrics.ContainsKey("1920x1080") && metrics.ContainsKey("2520x1080"), "one metric block per requested size");
        Assert((double?)metrics["1920x1080"]!["renderMs"]!["p50"] == 100, "p50 renderMs at 1920 (nearest-rank of {100,120})");
        Assert((double?)metrics["2520x1080"]!["renderMs"]!["max"] == 240, "max renderMs at 2520 skips the failed render");
        Assert((double?)metrics["2520x1080"]!["outputBytes"]!["max"] == 1_520_000, "outputBytes per size");
        Assert((int?)metrics["2520x1080"]!["renders"] == 2, "a failed render is not counted as a render");
        Assert((int?)metrics["failedRenders"] == 1, "failures are reported rather than dropped");
        Assert((int?)json["params"]!["policyWidthPx"] == CouchCoopStaticBackgroundProvider.RenderWidthPx,
            "params record the shipped policy size the comparison is against");
    }

    private static void BenchIsOptIn()
    {
        // The measurement route renders at NON-policy sizes, so it must be off unless explicitly asked for.
        Assert(Environment.GetEnvironmentVariable(StaticBackgroundRenderMetrics.BenchEnvVar) is null or not "1"
            || StaticBackgroundRenderMetrics.BenchEnabled, "bench flag mirrors its env var");
        Assert(StaticBackgroundRenderMetrics.BenchEnvVar == "COUCHCOOP_BG_BENCH", "documented env var name");
    }

    private static void PolicySizeIsTheDefaultRenderSize()
    {
        // Guard for "instrument only": this round parameterized the render size but must not have moved it.
        Assert(CouchCoopStaticBackgroundProvider.RenderWidthPx == 2520 && CouchCoopStaticBackgroundProvider.RenderHeightPx == 1080,
            "the shipped /bg render policy is still 2520x1080");
        Assert(CouchCoopStaticBackgroundProvider.BuildCacheKey("crypt", null).Contains("w=2520&h=1080", StringComparison.Ordinal),
            "the cache key still names the policy size");
    }

    private static StaticBackgroundRenderMetrics.Sample Sample(
        int w,
        int h,
        double ms,
        int bytes,
        bool success = true,
        double? cpuMs = null,
        double? cpuWallMs = null,
        string? codec = null)
        // Default = the SHIPPED policy, so the tests that describe "ordinary renders" keep landing in the bare
        // size block they are written against, whatever the shipped encoder happens to be.
        => new(0, "crypt", w, h, ms, bytes, "discovery", success, Bench: true, CpuMs: cpuMs, CpuWallMs: cpuWallMs,
            Codec: codec ?? CouchCoopStaticBackgroundProvider.ShippedCodec.Label);

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"StaticBackgroundRenderMetricsTests failed: {label}.");
        }
    }
}
