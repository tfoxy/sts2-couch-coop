using System.Buffers;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using CouchCoop.Mod.Protocol;

namespace CouchCoop.Mod.Diagnostics;

/// <summary>
/// S9 — per-frame scene-delta WIRE cost, measured at the serializer (the last place the bytes are still ours).
/// INSTRUMENT ONLY: nothing here changes what is sent; the recorder is a single boolean branch on the send path
/// and every measurement is taken from the bytes that were already produced.
/// </summary>
/// <remarks>
/// Off by default (<c>COUCHCOOP_WIRE_METRICS=1</c> arms it, or a caller sets <see cref="Enabled"/>) because the
/// send path runs once per connection per delta at up to ~30Hz. When armed it appends one fixed-size struct per
/// frame to a ring buffer — no allocation per frame except the ordered-id measuring buffer, which is pooled.
///
/// The producer of these deltas lives in spirectl; the SERIALIZER lives here, which is why the wire number is a
/// couch-coop measurement. What it prices is exactly the thing the wire diet has been tuning for a year: bytes
/// on the socket per frame, and the upsert/removal counts that generate them.
/// </remarks>
public static class SceneDeltaWireMetrics
{
    public const string EnvVar = "COUCHCOOP_WIRE_METRICS";

    // ~8k frames ≈ 4.5 minutes of a 30Hz single connection — long enough for any bench window, small enough
    // (8192 * 40B ≈ 320KB) to leave armed for a whole session.
    public const int Capacity = 8192;

    private static readonly object Gate = new();
    private static Sample[] _ring = new Sample[Capacity];
    private static int _count;
    private static int _next;
    private static long _dropped;

    // CPU accounting for the capture. The window opens at the FIRST LIVE frame after a reset (not at arm time:
    // an armed-but-idle host would dilute the ratio with a stretch that produced no wire bytes) and closes when
    // the report is built. `_offlineFrames` is what keeps it honest — a report whose samples came from a
    // RECORDING must not carry a cpu block, because the CPU that produced those bytes belonged to a game process
    // that is long gone, and the replaying process's CPU is a different number entirely.
    private static ProcessCpuMetrics.Mark? _cpuMark;
    private static int _liveFrames;
    private static int _offlineFrames;
    private static double _lastFrameTimestampMs;

    private static bool _enabled = Environment.GetEnvironmentVariable(EnvVar) == "1";

    /// <summary>Armed state. Settable so a test / the perf route can arm it without an env restart.</summary>
    public static bool Enabled
    {
        get => Volatile.Read(ref _enabled);
        set => Volatile.Write(ref _enabled, value);
    }

    /// <summary>One serialized frame.</summary>
    /// <param name="TimestampMs">Monotonic ms (Stopwatch-derived for live frames; recorded `t` offline).</param>
    /// <param name="WireBytes">Exact UTF-8 byte length of the message put on the socket.</param>
    /// <param name="OrderedIdsBytes">Bytes the full `orderedIds` array contributes (0 when not sent).</param>
    /// <param name="OrderPatchBytes">Bytes the compact `orderPatch` contributes (0 when not sent).</param>
    public readonly record struct Sample(
        double TimestampMs,
        int WireBytes,
        int UpsertCount,
        int RemovedCount,
        int OrderedIdsBytes,
        int OrderPatchBytes,
        bool Full);

    /// <summary>Live send-path hook. Cheap when disarmed (one volatile read).</summary>
    public static void RecordFrame(int wireBytes, WireSceneDelta wire)
    {
        if (!Enabled)
        {
            return;
        }

        var orderedIdsBytes = wire.OrderedIds is { Count: > 0 } ordered ? MeasureStringArrayBytes(ordered) : 0;
        var orderPatchBytes = wire.OrderPatch is { } patch ? MeasureOrderPatchBytes(patch) : 0;
        Append(
            new Sample(
                TimestampMs: Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency,
                WireBytes: wireBytes,
                UpsertCount: wire.Upserts.Count,
                RemovedCount: wire.RemovedIds.Count,
                OrderedIdsBytes: orderedIdsBytes,
                OrderPatchBytes: orderPatchBytes,
                Full: wire.Full),
            live: true);
    }

    /// <summary>
    /// Append a sample (also the offline/recording-replay entry point — same aggregator, same math). Samples
    /// arriving here are marked NOT live: they may have been produced by another process on another day, so the
    /// report they end up in reports no CPU rather than this process's.
    /// </summary>
    public static void Record(Sample sample) => Append(sample, live: false);

    public static void Reset()
    {
        lock (Gate)
        {
            _count = 0;
            _next = 0;
            _dropped = 0;
            _cpuMark = null;
            _liveFrames = 0;
            _offlineFrames = 0;
            _lastFrameTimestampMs = 0;
        }
    }

    private static void Append(Sample sample, bool live)
    {
        lock (Gate)
        {
            _ring[_next] = sample;
            _next = (_next + 1) % _ring.Length;
            if (_count < _ring.Length)
            {
                _count++;
            }
            else
            {
                _dropped++;
            }

            if (live)
            {
                // Opened on the first live frame of the capture, so the CPU window starts where the wire work
                // does. One procfs read per capture, not per frame: sampling the counter on the send path at
                // 30Hz would perturb the very cost this instrument exists to measure.
                _cpuMark ??= ProcessCpuMetrics.TryMark();
                _liveFrames++;
                _lastFrameTimestampMs = sample.TimestampMs;
            }
            else
            {
                _offlineFrames++;
            }
        }
    }

    /// <summary>Samples in arrival order (oldest first).</summary>
    public static IReadOnlyList<Sample> Snapshot()
    {
        lock (Gate)
        {
            var result = new Sample[_count];
            var start = _count < _ring.Length ? 0 : _next;
            for (var i = 0; i < _count; i++)
            {
                result[i] = _ring[(start + i) % _ring.Length];
            }

            return result;
        }
    }

    public static long DroppedSamples
    {
        get
        {
            lock (Gate)
            {
                return _dropped;
            }
        }
    }

    /// <summary>
    /// Close the capture's CPU window, if this process is entitled to report one.
    /// <para>
    /// Five conditions, all of them checks that the CPU delta really covers the frames in
    /// <paramref name="reportedFrames"/>: at least one frame was recorded by the LIVE send path; NO frame came
    /// from <see cref="Record(Sample)"/> (a replayed recording's bytes were produced by a different process);
    /// the ring dropped nothing; the report is covering exactly the frames that were recorded; and the CPU
    /// counter was readable at both ends. Fail any of them and the answer is "not measured" with the reason —
    /// a CPU number that does not line up with the frames beside it is worse than no CPU number.
    /// </para>
    /// </summary>
    public static ProcessCpuMetrics.Window? TryCloseCpuWindow(int reportedFrames, out string? unavailableReason)
    {
        ProcessCpuMetrics.Mark? mark;
        int live;
        int offline;
        long dropped;
        lock (Gate)
        {
            mark = _cpuMark;
            live = _liveFrames;
            offline = _offlineFrames;
            dropped = _dropped;
        }

        if (offline > 0)
        {
            unavailableReason =
                $"{offline} of the {live + offline} recorded frames were replayed into the aggregator rather than "
                + "serialized by this process's send path; the CPU that produced those bytes belonged to another "
                + "process and cannot be measured here";
            return null;
        }

        if (live == 0)
        {
            unavailableReason = "no frame was recorded by the live send path, so there is no window to price";
            return null;
        }

        if (dropped > 0 || reportedFrames != live)
        {
            unavailableReason =
                $"the CPU window covers {live} live frames but the report covers {reportedFrames} "
                + $"(dropped={dropped}); a ratio over a mismatched frame set would not be comparable";
            return null;
        }

        if (ProcessCpuMetrics.TryClose(mark) is not { } window)
        {
            unavailableReason = "the process CPU counter could not be read at both ends of the window";
            return null;
        }

        unavailableReason = null;
        return window;
    }

    /// <summary>
    /// Wall ms between the last recorded frame and now — how much of the CPU window carried NO wire work.
    /// Recorded in `params` because the window closes when the report is REQUESTED: ask for the report an hour
    /// after the capture and `coreRatio` is diluted by an hour of idle, which this number makes visible.
    /// </summary>
    public static double IdleTailMs()
    {
        lock (Gate)
        {
            return _lastFrameTimestampMs <= 0
                ? 0
                : Math.Max(0, (Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency) - _lastFrameTimestampMs);
        }
    }

    /// <summary>
    /// Build the shared envelope over the captured samples. <paramref name="windows"/> splits the capture into
    /// that many contiguous windows — each window is one entry of `runs`, and `metrics` is the median across
    /// them. Windows are not independent repeats of a scenario, so the split is named in `params`; they exist to
    /// expose the spread of a single capture rather than to fake repeats.
    /// <para>
    /// The shared <c>cpu</c> block is attached to <c>metrics</c> only, never to a `runs` entry: ONE process-CPU
    /// delta was taken, across the whole capture, and splitting it per window would attribute CPU to windows it
    /// was never measured over. It is omitted entirely — with <c>params.cpuOmittedReason</c> saying why — for a
    /// replayed recording, which is most of what this report is built from.
    /// </para>
    /// </summary>
    public static JsonObject BuildReport(
        string scenario,
        IReadOnlyList<Sample> samples,
        int windows = 5,
        string? envKind = null,
        string? envLabel = null,
        double? cpuThrottle = null,
        JsonObject? extraParams = null)
    {
        windows = Math.Clamp(windows, 1, Math.Max(1, samples.Count));
        var runs = new List<JsonObject>(windows);
        var perWindow = samples.Count == 0 ? 0 : (int)Math.Ceiling(samples.Count / (double)windows);

        for (var w = 0; w < windows && perWindow > 0; w++)
        {
            var from = w * perWindow;
            if (from >= samples.Count)
            {
                break;
            }

            var to = Math.Min(from + perWindow, samples.Count);
            runs.Add(BuildWindow(samples, from, to));
        }

        if (runs.Count == 0)
        {
            runs.Add(BuildWindow(samples, 0, 0));
        }

        var metrics = new JsonObject
        {
            ["wireBytes"] = PerfStats.MedianDistribution(runs, "wireBytes", 0),
            ["upsertCount"] = PerfStats.MedianDistribution(runs, "upsertCount", 0),
            ["removedCount"] = PerfStats.MedianDistribution(runs, "removedCount", 0),
            ["orderedIdsBytes"] = PerfStats.MedianDistribution(runs, "orderedIdsBytes", 0),
            ["orderPatchBytes"] = PerfStats.MedianDistribution(runs, "orderPatchBytes", 0),
            ["framesPerSec"] = PerfStats.JsonValueOrNull(PerfStats.Round(PerfStats.MedianOfRuns(runs, "framesPerSec"), 2)),
            ["frames"] = samples.Count,
            ["fullKeyframes"] = samples.Count(s => s.Full),
            ["totalWireBytes"] = samples.Sum(s => (long)s.WireBytes),
        };

        var parameters = extraParams is null ? [] : (JsonObject)extraParams.DeepClone();
        parameters["runSplit"] = "contiguous-windows";
        parameters["windows"] = runs.Count;
        parameters["framesPerWindow"] = perWindow;
        parameters["droppedSamples"] = DroppedSamples;

        var cpuWindow = TryCloseCpuWindow(samples.Count, out var cpuUnavailable);
        // One contiguous process-CPU delta covers the whole window, so coverage is 1 by construction.
        var measuredCpu = ProcessCpuMetrics.TryBuildCpuBlock(
            cpuWindow, ProcessCpuMetrics.FullCoverage, out var cpu, out var cpuRejected);
        if (measuredCpu)
        {
            metrics["cpu"] = cpu;
            parameters["cpuIdleTailMs"] = Math.Round(IdleTailMs(), 1);
        }

        ProcessCpuMetrics.StampParams(parameters, measuredCpu, cpuUnavailable ?? cpuRejected);

        return PerfReport.Build(
            PerfReport.ProfileWirePayload,
            scenario,
            metrics,
            runs,
            parameters,
            envKind,
            envLabel,
            cpuThrottle,
            device: null,
            warmups: 0);
    }

    private static JsonObject BuildWindow(IReadOnlyList<Sample> samples, int from, int to)
    {
        var count = Math.Max(0, to - from);
        var wireBytes = new List<double>(count);
        var upserts = new List<double>(count);
        var removed = new List<double>(count);
        var orderedIds = new List<double>(count);
        var orderPatch = new List<double>(count);
        for (var i = from; i < to; i++)
        {
            var sample = samples[i];
            wireBytes.Add(sample.WireBytes);
            upserts.Add(sample.UpsertCount);
            removed.Add(sample.RemovedCount);
            orderedIds.Add(sample.OrderedIdsBytes);
            orderPatch.Add(sample.OrderPatchBytes);
        }

        // Frame RATE from the sample timestamps: (n-1) intervals over the window span. One frame in a window
        // has no interval to measure, so its rate is null rather than a made-up number.
        double? framesPerSec = null;
        if (count >= 2)
        {
            var span = samples[to - 1].TimestampMs - samples[from].TimestampMs;
            framesPerSec = span > 0 ? (count - 1) / span * 1000.0 : null;
        }

        return new JsonObject
        {
            ["frames"] = count,
            ["wireBytes"] = PerfStats.Distribution(wireBytes, 0),
            ["upsertCount"] = PerfStats.Distribution(upserts, 0),
            ["removedCount"] = PerfStats.Distribution(removed, 0),
            ["orderedIdsBytes"] = PerfStats.Distribution(orderedIds, 0),
            ["orderPatchBytes"] = PerfStats.Distribution(orderPatch, 0),
            ["framesPerSec"] = PerfStats.JsonValueOrNull(PerfStats.Round(framesPerSec, 2)),
            ["totalWireBytes"] = (long)wireBytes.Sum(),
            ["spanMs"] = PerfStats.JsonValueOrNull(
                count >= 2 ? PerfStats.Round(samples[to - 1].TimestampMs - samples[from].TimestampMs, 1) : null),
        };
    }

    /// <summary>
    /// EXACT JSON byte cost of a string array (`["a","b",…]`), written through a real Utf8JsonWriter so escaping
    /// and non-ASCII ids are counted the way the serializer counts them — not estimated from id lengths.
    /// </summary>
    internal static int MeasureStringArrayBytes(IReadOnlyList<string> values)
    {
        var buffer = new ArrayBufferWriter<byte>(Math.Max(64, values.Count * 12));
        using var writer = new Utf8JsonWriter(buffer);
        writer.WriteStartArray();
        foreach (var value in values)
        {
            writer.WriteStringValue(value);
        }

        writer.WriteEndArray();
        writer.Flush();
        return buffer.WrittenCount;
    }

    /// <summary>EXACT JSON byte cost of the Stage-4 order patch (`{"roots":[…],"parents":[{"p":…,"c":[…]}]}`).</summary>
    internal static int MeasureOrderPatchBytes(WireOrderPatch patch)
    {
        var buffer = new ArrayBufferWriter<byte>(256);
        using var writer = new Utf8JsonWriter(buffer);
        writer.WriteStartObject();
        if (patch.Roots is { } roots)
        {
            writer.WriteStartArray("roots");
            foreach (var root in roots)
            {
                writer.WriteStringValue(root);
            }

            writer.WriteEndArray();
        }

        writer.WriteStartArray("parents");
        foreach (var parent in patch.Parents)
        {
            writer.WriteStartObject();
            writer.WriteString("p", parent.P);
            writer.WriteStartArray("c");
            foreach (var child in parent.C)
            {
                writer.WriteStringValue(child);
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        writer.WriteEndArray();
        writer.WriteEndObject();
        writer.Flush();
        return buffer.WrittenCount;
    }
}
