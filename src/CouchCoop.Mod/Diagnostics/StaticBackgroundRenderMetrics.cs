using System.Globalization;
using System.Text.Json.Nodes;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Diagnostics;

/// <summary>
/// S10 — how long a <c>/bg/</c> static-background render actually takes, and how many bytes it produces, PER
/// REQUESTED RENDER SIZE. INSTRUMENT ONLY: the shipped render policy is untouched (still the fixed
/// 2520x1080 of <see cref="Server.CouchCoopStaticBackgroundProvider.RenderWidthPx"/>); this only times the
/// renders that happen and records the size they were asked for.
/// </summary>
/// <remarks>
/// Unlike the scene-delta wire recorder this is ALWAYS on: a background render is a seconds-scale main-thread
/// op that happens a handful of times per session, so one Stopwatch and one struct per render is free, and the
/// numbers are only useful if they are there when someone finally plays.
///
/// spirectl's render-size fields are embeddable-runtime-only (never plumbed into its proto/CLI), so the sizes
/// are only visible on this side of the seam — which is why the size-keyed measurement lives here.
/// </remarks>
public static class StaticBackgroundRenderMetrics
{
    /// <summary>
    /// Opt-IN kill-switch for the measurement ROUTE that renders at non-policy sizes (the 1920-vs-2520
    /// comparison). Default OFF, so a shipped host never renders anything the policy did not ask for.
    /// </summary>
    public const string BenchEnvVar = "COUCHCOOP_BG_BENCH";

    public static bool BenchEnabled => Environment.GetEnvironmentVariable(BenchEnvVar) == "1";

    // A session renders a handful of variants; 128 samples covers any session plus a bench sweep.
    public const int Capacity = 128;

    private static readonly object Gate = new();
    private static readonly Sample[] Ring = new Sample[Capacity];
    private static int _count;
    private static int _next;

    /// <param name="Rung">Which rung of the fallback chain produced it: selector | discovery | literal.</param>
    /// <param name="Bench">True = a measurement-route render (non-policy size, cache bypassed).</param>
    /// <param name="CpuMs">
    /// Process CPU (user+system, all threads) burned across this render, from <see cref="ProcessCpuMetrics"/>.
    /// Null when the counter was not readable — never 0 as a stand-in for "not measured".
    /// </param>
    /// <param name="CpuWallMs">
    /// The wall span the <paramref name="CpuMs"/> delta was taken over. Separate from
    /// <paramref name="RenderMs"/> even though they bracket the same call, so a ratio is only ever formed from
    /// two numbers that were measured over the SAME interval.
    /// </param>
    /// <param name="Codec">
    /// The encode candidate's <see cref="BenchCodec.Label"/> — "png" for every shipped render, and the full
    /// <c>codec[@quality][:opaque]</c> label for a bench candidate, so two settings of one codec never fold
    /// together.
    /// </param>
    /// <param name="Phases">
    /// WHERE inside the render the time went (<see cref="Sts2RenderPhaseProfile"/>), with this side's queueing and
    /// disk phases merged in. EMPTY means not measured — never "measured as nothing".
    /// </param>
    public readonly record struct Sample(
        double TimestampMs,
        string Id,
        int WidthPx,
        int HeightPx,
        double RenderMs,
        int OutputBytes,
        string Rung,
        bool Success,
        bool Bench,
        double? CpuMs = null,
        double? CpuWallMs = null,
        string Codec = "png",
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

    public static string SizeKey(int width, int height) => $"{width}x{height}";

    /// <summary>
    /// The metric-block key for a sample: its size, plus a <c>:codec</c> tail for anything other than the SHIPPED
    /// render policy. So a report of ordinary renders keys exactly as it always did, while a codec A/B gets its own
    /// blocks instead of averaging two encoders into one "2520x1080" distribution.
    /// </summary>
    public static string MetricKey(Sample sample)
        => string.Equals(sample.Codec, Server.CouchCoopStaticBackgroundProvider.ShippedCodec.Label, StringComparison.Ordinal)
            ? SizeKey(sample.WidthPx, sample.HeightPx)
            : $"{SizeKey(sample.WidthPx, sample.HeightPx)}:{sample.Codec}";

    /// <summary>
    /// The CPU window a sample carries, or null when it carries none. BOTH halves must be present: a CPU delta
    /// without the wall span it was taken over cannot be turned into a ratio, and pairing it with
    /// <c>RenderMs</c> instead would silently compare two different intervals.
    /// </summary>
    public static ProcessCpuMetrics.Window? CpuWindowOf(Sample sample)
        => sample is { CpuMs: { } cpuMs, CpuWallMs: { } wallMs } ? new ProcessCpuMetrics.Window(cpuMs, wallMs) : null;

    /// <summary>
    /// The subset of <see cref="CpuWindowOf"/> that is worth aggregating: a window at or above the process CPU
    /// clock's resolution floor. A shorter one carried a reading, but that reading is quantization — so it is
    /// excluded from the size distributions, the fold and the measured-render count alike, and its wall time
    /// counts against <c>cpu.cpuCoverage</c>. The raw accessor above stays, so a `runs` entry can still explain
    /// which of the two reasons applies to it.
    /// </summary>
    public static ProcessCpuMetrics.Window? UsableCpuWindowOf(Sample sample)
        => CpuWindowOf(sample) is { } window && window.WallMs >= ProcessCpuMetrics.MinWindowMs ? window : null;

    /// <summary>
    /// Build the shared envelope from a set of render samples. Each SIZE gets its own metric block (that is the
    /// comparison the report exists for), and `runs` carries one object per sample — a render is a whole repeat,
    /// not a frame, so the raw list IS the per-repeat list.
    /// <para>
    /// CPU: each render carries its own measured process-CPU delta (see <see cref="ProcessCpuMetrics"/>), so a
    /// `runs` entry gets its own <c>cpu</c> block and the size blocks get <c>cpuMs</c>/<c>coreRatio</c>
    /// distributions. <c>metrics.cpu</c> folds the renders that were measurable: the summed CPU over the summed
    /// wall of those same renders — disjoint intervals, so the sum is the window the ratio is over. Renders whose
    /// window fell under the CPU clock's resolution are counted in <c>params.cpuUnmeasuredRenders</c> and left
    /// out of both, never rounded into a zero.
    /// </para>
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
                ["size"] = SizeKey(sample.WidthPx, sample.HeightPx),
                ["widthPx"] = sample.WidthPx,
                ["heightPx"] = sample.HeightPx,
                ["id"] = sample.Id,
                ["renderMs"] = PerfStats.JsonValueOrNull(PerfStats.Round(sample.RenderMs, 2)),
                ["outputBytes"] = sample.OutputBytes,
                ["rung"] = sample.Rung,
                ["success"] = sample.Success,
                ["bench"] = sample.Bench,
                ["codec"] = sample.Codec,
                ["phases"] = RenderPhaseReport.PhasesJson(sample.PhaseCosts),
                ["counters"] = RenderPhaseReport.CountersJson(sample.Counters),
            };

            // One render, one contiguous CPU delta: its own window is fully covered.
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
        foreach (var group in samples.Where(s => s.Success).GroupBy(MetricKey).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var renderMs = group.Select(s => s.RenderMs).ToList();
            var bytes = group.Select(s => (double)s.OutputBytes).ToList();
            var measured = group.Select(UsableCpuWindowOf).OfType<ProcessCpuMetrics.Window>().ToList();
            var phases = group.Select(s => s.PhaseCosts).ToList();
            metrics[group.Key] = new JsonObject
            {
                ["renders"] = group.Count(),
                ["renderMs"] = PerfStats.Distribution(renderMs, 2),
                ["outputBytes"] = PerfStats.Distribution(bytes, 0),
                // The whole point of the breakdown: which phases cost what, and how much of it was a game stall.
                ["split"] = RenderPhaseReport.BlockingSplit(phases),
                ["phases"] = RenderPhaseReport.PhaseDistributions(phases),
                // Only over the renders whose CPU window was actually read: `cpuMeasuredRenders` says how many
                // that was, so a size with no reading is visibly unmeasured rather than silently cheap.
                ["cpuMeasuredRenders"] = measured.Count,
                ["cpuMs"] = PerfStats.Distribution([.. measured.Select(w => w.CpuMs)], 2),
                ["coreRatio"] = PerfStats.Distribution([.. measured.Select(w => w.CoreRatio)], 4),
                ["rungs"] = new JsonArray([.. group.Select(s => s.Rung).Distinct().Order(StringComparer.Ordinal).Select(r => (JsonNode)JsonValue.Create(r))]),
            };
        }

        metrics["failedRenders"] = samples.Count(s => !s.Success);

        var parameters = extraParams is null ? [] : (JsonObject)extraParams.DeepClone();
        parameters["policyWidthPx"] = Server.CouchCoopStaticBackgroundProvider.RenderWidthPx;
        parameters["policyHeightPx"] = Server.CouchCoopStaticBackgroundProvider.RenderHeightPx;

        // The fold: summed CPU over the summed wall of the renders that carried a reading. The renders are
        // sequential and their windows disjoint, so summing both sides keeps `totalCoreRatio` a real core count.
        var windows = samples.Select(UsableCpuWindowOf).OfType<ProcessCpuMetrics.Window>().ToList();
        var folded = windows.Count == 0
            ? (ProcessCpuMetrics.Window?)null
            : new ProcessCpuMetrics.Window(windows.Sum(w => w.CpuMs), windows.Sum(w => w.WallMs));

        // `cpuCoverage` earns its keep here: the fold's window is only the renders that carried a reading, so
        // this is the share of ALL render wall time whose CPU is actually attributed. A run where half the
        // renders fell under the CPU clock's resolution reports 0.5, not a silently narrower window. The
        // denominator uses each sample's own CPU window when it has one and its render Stopwatch otherwise —
        // the two bracket the same call and differ by microseconds.
        var totalWallMs = samples.Sum(s => CpuWindowOf(s)?.WallMs ?? s.RenderMs);
        var coverage = totalWallMs > 0 ? windows.Sum(w => w.WallMs) / totalWallMs : 0.0;
        var measuredCpu = ProcessCpuMetrics.TryBuildCpuBlock(folded, coverage, out var cpu, out var cpuReason);
        if (measuredCpu)
        {
            metrics["cpu"] = cpu;
        }

        parameters["cpuMeasuredRenders"] = windows.Count;
        parameters["cpuUnmeasuredRenders"] = samples.Count - windows.Count;
        // Says whether the phase tables above describe every render or only some — an absent breakdown means the
        // render lane was not recording (SPIRECTL_RENDER_PHASE_PROFILE=0, or an older embedded spirectl).
        parameters["phasedRenders"] = samples.Count(sample => sample.PhaseCosts.Count > 0);
        parameters["unphasedRenders"] = samples.Count(sample => sample.PhaseCosts.Count == 0);
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

    /// <summary>
    /// The encoders a bench may ask for. Deliberately a closed set: these are the three Godot exposes a BUFFER
    /// encoder for (<c>SavePngToBuffer</c> / <c>SaveWebpToBuffer</c> / <c>SaveJpgToBuffer</c>) and that a browser
    /// can decode in an <c>&lt;img&gt;</c>. An unknown name would silently fall through the extractor's format
    /// switch to PNG and report a "webp" render that was really a PNG one.
    /// </summary>
    public static readonly IReadOnlyList<string> BenchFormats = ["png", "webp", "jpg"];

    /// <summary>
    /// One encode candidate: a codec, an optional lossy quality, and whether the alpha channel is dropped first.
    /// The three knobs that make a codec comparison a comparison rather than a single number.
    /// </summary>
    /// <param name="Quality">
    /// 0&lt;q&le;1, or null for the codec's lossless/default call (webp without a quality is LOSSLESS; PNG never
    /// takes one). Kept as the parsed float so <see cref="Label"/> and the request agree by construction.
    /// </param>
    public readonly record struct BenchCodec(string Codec, float? Quality = null, bool Opaque = false)
    {
        /// <summary>
        /// True when this candidate IS the shipped render policy
        /// (<see cref="Server.CouchCoopStaticBackgroundProvider.ShippedCodec"/>), so a report can key it with the
        /// bare size key exactly as it always did. Compared by LABEL rather than by a hardcoded codec name: the
        /// shipped encoder has already moved once (png -> jpg@0.9) and a literal here would silently re-label
        /// every served render's metric block the next time it moves.
        /// </summary>
        public bool IsShippedPolicy => Label == Server.CouchCoopStaticBackgroundProvider.ShippedCodec.Label;

        /// <summary>
        /// The canonical round-trip label — exactly the <c>formats=</c> grammar that produced it. Used as the
        /// metric-block key tail and echoed in <c>params.formats</c>, so a block in the report can be pasted
        /// straight back into a query to re-run it.
        /// </summary>
        public string Label => Codec
            + (Quality is { } quality ? $"@{quality.ToString("0.##", CultureInfo.InvariantCulture)}" : string.Empty)
            + (Opaque ? ":opaque" : string.Empty);

        /// <summary>Filename-safe form of <see cref="Label"/> for a <c>dump=1</c> artifact.</summary>
        public string FileLabel => Codec
            + (Quality is { } quality ? $"-q{(int)Math.Round(quality * 100)}" : string.Empty)
            + (Opaque ? "-opaque" : string.Empty);

        public string FileExtension => Codec switch { "webp" => "webp", "jpg" => "jpg", _ => "png" };

        /// <summary>The MIME type these bytes are served as — the authoritative answer for an extensionless URL.</summary>
        public string ContentType => Codec switch { "webp" => "image/webp", "jpg" => "image/jpeg", _ => "image/png" };
    }

    /// <summary>
    /// Parse a <c>formats=png,webp@0.85,jpg@0.9,png:opaque</c> query value into encode candidates. The grammar is
    /// <c>codec[@quality][:opaque]</c>. Null on ANY malformed or unknown entry (the route answers 400), for the
    /// same reason <see cref="TryParseSizes"/> refuses a malformed size: a silently-dropped or silently-swapped
    /// codec would make the report claim a comparison it never ran.
    /// </summary>
    /// <remarks>
    /// A quality outside (0,1] is REJECTED here rather than ignored, unlike the extractor's own normalization: a
    /// bench that asked for <c>webp@85</c> and quietly measured LOSSLESS webp would put a mislabelled row in a
    /// comparison table, which is worse than an error. The shipped render path has no such caller to protect.
    /// </remarks>
    public static IReadOnlyList<BenchCodec>? TryParseFormats(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var formats = new List<BenchCodec>();
        foreach (var part in value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var entry = part.ToLowerInvariant();

            var opaque = false;
            var colon = entry.IndexOf(':');
            if (colon >= 0)
            {
                if (entry[(colon + 1)..] != "opaque")
                {
                    return null;
                }

                opaque = true;
                entry = entry[..colon];
            }

            float? quality = null;
            var at = entry.IndexOf('@');
            if (at >= 0)
            {
                if (!float.TryParse(
                        entry[(at + 1)..],
                        NumberStyles.Float,
                        CultureInfo.InvariantCulture,
                        out var parsed)
                    || float.IsNaN(parsed)
                    || parsed <= 0f
                    || parsed > 1f)
                {
                    return null;
                }

                quality = parsed;
                entry = entry[..at];
            }

            if (!BenchFormats.Contains(entry, StringComparer.Ordinal))
            {
                return null;
            }

            // PNG has no quality dial; accepting one would mint a metric block labelled `png@0.8` whose bytes are
            // identical to `png`, i.e. a comparison row that is not a comparison.
            if (entry == "png" && quality is not null)
            {
                return null;
            }

            var codec = new BenchCodec(entry, quality, opaque);
            if (!formats.Contains(codec))
            {
                formats.Add(codec);
            }
        }

        return formats.Count == 0 ? null : formats;
    }

    /// <summary>
    /// Parse a <c>sizes=1920x1080,2520x1080</c> query value. Returns null on any malformed entry (the route
    /// answers 400) — a silently-dropped size would make the report claim a comparison it never ran.
    /// </summary>
    public static IReadOnlyList<(int Width, int Height)>? TryParseSizes(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var sizes = new List<(int, int)>();
        foreach (var part in value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var x = part.IndexOf('x', StringComparison.OrdinalIgnoreCase);
            if (x <= 0
                || !int.TryParse(part[..x], out var width)
                || !int.TryParse(part[(x + 1)..], out var height)
                || width is < 16 or > 8192
                || height is < 16 or > 8192)
            {
                return null;
            }

            sizes.Add((width, height));
        }

        return sizes.Count == 0 ? null : sizes;
    }
}
