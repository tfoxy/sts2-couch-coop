using System.Text;
using System.Text.Json.Nodes;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;

// S9 — the per-frame scene-delta WIRE instrument. Three things must hold or the number is a lie:
//   1. it measures the bytes that were actually produced (wireBytes == the serialized message length),
//   2. it is INERT when disarmed (the send path is the mirror's hot path; the instrument may not cost there
//      and may not record ghost frames from another test/session),
//   3. the ordered-id / order-patch byte attribution is EXACT (written through a real Utf8JsonWriter), because
//      "how much of a frame is the order array" is the whole reason Stage 4 exists.
// Plus the shared perf-report/1 envelope shape + the percentile contract every couch-coop report shares.
// Pure (no socket, no live game); assert-or-throw harness style.
internal static class SceneDeltaWireMetricsTests
{
    public static void Run()
    {
        DisarmedRecordsNothing();
        ArmedRecordsSerializedBytes();
        OrderedIdsBytesMatchTheSerializedArray();
        OrderPatchBytesMatchTheSerializedPatch();
        RingBufferKeepsNewest();
        PercentilesAreNearestRank();
        EnvelopeShapeMatchesTheSharedContract();
        WindowsSplitAndFrameRate();
        AReplayedRecordingReportsNoCpuAndSaysWhy();
        ALiveCaptureCarriesTheSharedCpuBlock();
        EnvKindIsTheSharedEnumAndDefaultsToHost();
        RestoreDefaults();
    }

    // ---- the shared cross-repo `cpu` block ---------------------------------------------------------------

    private static void AReplayedRecordingReportsNoCpuAndSaysWhy()
    {
        // THE honesty case for this profile, and the common one: the offline harness replays a recorded mirror
        // stream, whose bytes were produced by a game process that exited months ago. The replaying process's
        // CPU is a different number entirely, so there must be no cpu block — with the reason in `params`.
        SceneDeltaWireMetrics.Enabled = false;
        SceneDeltaWireMetrics.Reset();
        for (var i = 0; i < 10; i++)
        {
            SceneDeltaWireMetrics.Record(new SceneDeltaWireMetrics.Sample(i * 20.0, 1000, 5, 0, 0, 0, i == 0));
        }

        var json = JsonNode.Parse(PerfReport.ToJson(
            SceneDeltaWireMetrics.BuildReport("replay", SceneDeltaWireMetrics.Snapshot(), windows: 2)))!.AsObject();

        Assert(!json["metrics"]!.AsObject().ContainsKey("cpu"), "a replayed recording carries no cpu block");
        Assert((string?)json["params"]!["cpuSource"] == "unmeasured", "params say the CPU was not measured");
        var reason = (string?)json["params"]!["cpuOmittedReason"] ?? string.Empty;
        Assert(reason.Contains("replayed", StringComparison.Ordinal), $"and name the replay as the reason (got '{reason}')");
        SceneDeltaWireMetrics.Reset();
    }

    private static void ALiveCaptureCarriesTheSharedCpuBlock()
    {
        SceneDeltaWireMetrics.Enabled = true;
        SceneDeltaWireMetrics.Reset();

        // Real frames through the real serializer. Both the bytes and the CPU below are measured in THIS
        // process, which is exactly what entitles the report to a cpu block at all. Frame count stays well
        // under the ring's Capacity on purpose — an overflowing ring makes the report cover fewer frames than
        // the CPU window did, and the guard below refuses the block for that too.
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        var frames = 0;
        while (frames < 2000)
        {
            BrowserSceneDeltaMessage.Serialize(Delta([Node("a", "A"), Node("b", "B")], ordered: ["a", "b"]));
            frames++;
        }

        // Then hold until the window clears the CPU clock's resolution floor.
        while (deadline.ElapsedMilliseconds < ProcessCpuMetrics.MinWindowMs * 2)
        {
            Thread.Sleep(5);
        }

        var samples = SceneDeltaWireMetrics.Snapshot();
        var json = JsonNode.Parse(PerfReport.ToJson(
            SceneDeltaWireMetrics.BuildReport("live", samples, windows: 2)))!.AsObject();
        var cpu = json["metrics"]!["cpu"];
        Assert(cpu is JsonObject, $"a live send-path capture ({frames} frames) carries a cpu block");

        var block = cpu!.AsObject();
        Assert((double?)block["windowMs"] >= ProcessCpuMetrics.MinWindowMs, "cpu.windowMs is the measured wall window");
        Assert((double?)block["totalCpuMs"] >= 0, "cpu.totalCpuMs is a real process-CPU delta");
        var entry = block["byThread"]!.AsArray()[0]!.AsObject();
        Assert((string?)entry["thread"] == "process-total", "byThread names the process-wide reading honestly");
        Assert(((string?)entry["process"])?.Length > 0, "…and names the process it was measured in");
        Assert((double?)entry["cpuMs"] == (double?)block["totalCpuMs"] && (double?)entry["wallMs"] == (double?)block["windowMs"],
            "the single entry and the totals are the same measurement");
        // One contiguous process-CPU delta covers the whole window: there is no unattributed sub-interval, so
        // coverage is 1 as a statement about this counter rather than as a filler value.
        Assert((double?)block["cpuCoverage"] == 1, "cpuCoverage is 1 for a single contiguous window");
        var byProcess = block["byProcess"]!.AsObject();
        Assert(byProcess.Count == 1, "byProcess is a real one-process entry, not the empty object");
        Assert((double?)byProcess.First().Value!["cpuMs"] == (double?)block["totalCpuMs"], "…carrying the same CPU");
        Assert(!json["metrics"]!.AsObject().ContainsKey("gpu"), "no gpu block on a CPU-only profile");
        Assert((string?)json["params"]!["cpuSource"] == ProcessCpuMetrics.Source, "params name the source");
        Assert(json["params"]!["cpuIdleTailMs"] is not null,
            "params expose the idle tail: the window closes when the REPORT is asked for, not at the last frame");

        // One CPU delta was taken over the whole capture, so it is reported once — attributing a slice of it to
        // each `runs` window would claim a per-window measurement that was never made.
        foreach (var run in json["runs"]!.AsArray())
        {
            Assert(!run!.AsObject().ContainsKey("cpu"), "no per-window cpu block: only one delta was measured");
        }

        SceneDeltaWireMetrics.Enabled = false;
        SceneDeltaWireMetrics.Reset();

        // And the frame-set guard: overflow the ring, and the CPU window no longer covers the frames the report
        // covers. A ratio over a mismatched frame set is not comparable with anything, so it is withheld.
        SceneDeltaWireMetrics.Enabled = true;
        SceneDeltaWireMetrics.Reset();
        for (var i = 0; i < SceneDeltaWireMetrics.Capacity + 5; i++)
        {
            BrowserSceneDeltaMessage.Serialize(Delta([Node("a", "A")], ordered: ["a"]));
        }

        var overflowed = JsonNode.Parse(PerfReport.ToJson(SceneDeltaWireMetrics.BuildReport(
            "overflow", SceneDeltaWireMetrics.Snapshot(), windows: 1)))!.AsObject();
        Assert(!overflowed["metrics"]!.AsObject().ContainsKey("cpu"), "a ring that dropped frames reports no cpu");
        Assert(((string?)overflowed["params"]!["cpuOmittedReason"])!.Contains("dropped", StringComparison.Ordinal),
            "and names the drop as the reason");

        SceneDeltaWireMetrics.Enabled = false;
        SceneDeltaWireMetrics.Reset();
    }

    private static void EnvKindIsTheSharedEnumAndDefaultsToHost()
    {
        SceneDeltaWireMetrics.Reset();
        SceneDeltaWireMetrics.Record(new SceneDeltaWireMetrics.Sample(0, 100, 1, 0, 0, 0, false));
        var samples = SceneDeltaWireMetrics.Snapshot();

        // env.kind is an ENUM in the shared validator (ci | host | device). This repo's reports are `host`:
        // they come out of a running game on someone's machine, which is neither a harness run nor a phone.
        var byDefault = SceneDeltaWireMetrics.BuildReport("k", samples, windows: 1)["env"]!.AsObject();
        Assert((string?)byDefault["kind"] == PerfReport.DefaultEnvKind(), "the default kind is the shared default");
        Assert(PerfReport.IsValidEnvKind((string?)byDefault["kind"]), "…and it is a value the validator accepts");
        Assert(!byDefault.ContainsKey("kindRaw"), "one field for one concept: no shadow copy of the kind");

        foreach (var kind in PerfReport.EnvKinds)
        {
            var env = SceneDeltaWireMetrics.BuildReport("k", samples, windows: 1, envKind: kind)["env"]!.AsObject();
            Assert((string?)env["kind"] == kind, $"'{kind}' is emitted verbatim, with no mapping layer");
        }

        // A word outside the enum drops the whole report over one field, so it fails at the source. The perf
        // route, whose kind comes from a query string, checks it itself and answers 400.
        var rejected = false;
        try
        {
            SceneDeltaWireMetrics.BuildReport("k", samples, windows: 1, envKind: "live");
        }
        catch (ArgumentException)
        {
            rejected = true;
        }

        Assert(rejected, "an env.kind outside the enum is rejected rather than silently emitted");
        Assert(!PerfReport.IsValidEnvKind("live") && !PerfReport.IsValidEnvKind("Host") && !PerfReport.IsValidEnvKind(null),
            "the enum check is exact — no case folding, no legacy words");
        SceneDeltaWireMetrics.Reset();
    }

    private static RuntimeSceneNodeDelta Node(string id, string? name = null) => new(
        Id: id, ParentId: null, Name: name, NodeType: name is null ? null : "Control", Rect: null,
        Visible: true, Opacity: 1, ZIndex: null, Rotation: 0, Texture: null, NinePatch: false, Text: null);

    private static RuntimeSceneDelta Delta(
        IReadOnlyList<RuntimeSceneNodeDelta>? upserts = null,
        IReadOnlyList<string>? removed = null,
        IReadOnlyList<string>? ordered = null)
        => new(false, "run", "screen:run:live", upserts ?? [], removed ?? [], ordered);

    private static void DisarmedRecordsNothing()
    {
        SceneDeltaWireMetrics.Enabled = false;
        SceneDeltaWireMetrics.Reset();
        BrowserSceneDeltaMessage.Serialize(Delta([Node("a", "A")], ordered: ["a"]));
        Assert(SceneDeltaWireMetrics.Snapshot().Count == 0, "a disarmed recorder captures nothing");
    }

    private static void ArmedRecordsSerializedBytes()
    {
        SceneDeltaWireMetrics.Enabled = true;
        SceneDeltaWireMetrics.Reset();

        var bytes = BrowserSceneDeltaMessage.Serialize(
            Delta([Node("a", "A"), Node("b")], removed: ["gone", "gone2"], ordered: ["a", "b"]));
        var samples = SceneDeltaWireMetrics.Snapshot();

        Assert(samples.Count == 1, "one frame recorded per serialize");
        var sample = samples[0];
        Assert(sample.WireBytes == bytes.Length, $"wireBytes == the produced message length ({sample.WireBytes} vs {bytes.Length})");
        Assert(sample.UpsertCount == 2, $"upsertCount from the wire delta (got {sample.UpsertCount})");
        Assert(sample.RemovedCount == 2, $"removedCount from the wire delta (got {sample.RemovedCount})");
        Assert(!sample.Full, "an incremental delta is not a keyframe");

        SceneDeltaWireMetrics.Reset();
        BrowserSceneDeltaMessage.Serialize(new RuntimeSceneDelta(true, "run", "screen:run:live", [Node("a", "A")], [], ["a"]));
        Assert(SceneDeltaWireMetrics.Snapshot()[0].Full, "a full keyframe is flagged");
    }

    private static void OrderedIdsBytesMatchTheSerializedArray()
    {
        SceneDeltaWireMetrics.Enabled = true;
        SceneDeltaWireMetrics.Reset();

        // Includes an id needing JSON escaping, so an id-length ESTIMATE would disagree with the writer.
        string[] ids = ["root", "card:1", "quote\"id", "ünïcode"];
        BrowserSceneDeltaMessage.Serialize(Delta([Node("root", "Root")], ordered: ids));
        var recorded = SceneDeltaWireMetrics.Snapshot()[0].OrderedIdsBytes;

        var json = Encoding.UTF8.GetString(BrowserSceneDeltaMessage.Serialize(Delta([Node("root", "Root")], ordered: ids)));
        var start = json.IndexOf("\"orderedIds\":", StringComparison.Ordinal) + "\"orderedIds\":".Length;
        var end = json.IndexOf(']', start) + 1;
        var actualArrayBytes = Encoding.UTF8.GetByteCount(json[start..end]);

        Assert(recorded == actualArrayBytes,
            $"orderedIdsBytes is the EXACT serialized array length (recorded {recorded}, on the wire {actualArrayBytes}: {json[start..end]})");
        Assert(SceneDeltaWireMetrics.Snapshot()[0].OrderPatchBytes == 0, "no patch on the wire => 0 patch bytes");
    }

    private static void OrderPatchBytesMatchTheSerializedPatch()
    {
        SceneDeltaWireMetrics.Enabled = true;
        SceneDeltaWireMetrics.Reset();

        var patch = new SceneOrderPatch(["root"], [new SceneOrderParentPatch("root", ["a", "b"])]);
        var bytes = BrowserSceneDeltaMessage.Serialize(Delta([Node("a")]), patch);
        var json = Encoding.UTF8.GetString(bytes);
        var start = json.IndexOf("\"orderPatch\":", StringComparison.Ordinal) + "\"orderPatch\":".Length;
        // The patch object ends right before the next top-level key; find its matching brace by depth.
        var depth = 0;
        var end = start;
        for (; end < json.Length; end++)
        {
            if (json[end] == '{') depth++;
            else if (json[end] == '}' && --depth == 0) { end++; break; }
        }

        var recorded = SceneDeltaWireMetrics.Snapshot()[0].OrderPatchBytes;
        var actual = Encoding.UTF8.GetByteCount(json[start..end]);
        Assert(recorded == actual, $"orderPatchBytes is the EXACT serialized patch length (recorded {recorded}, wire {actual}: {json[start..end]})");
    }

    private static void RingBufferKeepsNewest()
    {
        SceneDeltaWireMetrics.Enabled = true;
        SceneDeltaWireMetrics.Reset();
        for (var i = 0; i < SceneDeltaWireMetrics.Capacity + 10; i++)
        {
            SceneDeltaWireMetrics.Record(new SceneDeltaWireMetrics.Sample(i, i, 0, 0, 0, 0, false));
        }

        var samples = SceneDeltaWireMetrics.Snapshot();
        Assert(samples.Count == SceneDeltaWireMetrics.Capacity, "the ring is capped at Capacity");
        Assert(samples[^1].WireBytes == SceneDeltaWireMetrics.Capacity + 9, "the newest frame survives");
        Assert(samples[0].WireBytes == 10, "the oldest frames are the ones dropped");
        Assert(SceneDeltaWireMetrics.DroppedSamples == 10, "drops are counted, not hidden");
        SceneDeltaWireMetrics.Reset();
    }

    private static void PercentilesAreNearestRank()
    {
        double[] values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        Assert(PerfStats.Percentile(values, 0.50) == 5, "p50 = nearest-rank (ceil(0.5*10)=5th = 5)");
        Assert(PerfStats.Percentile(values, 0.95) == 10, "p95 = nearest-rank (ceil(0.95*10)=10th = 10)");
        Assert(PerfStats.Max(values) == 10, "max");
        Assert(PerfStats.Median(values) == 5.5, "median interpolates the two middles on an even count");
        Assert(PerfStats.Percentile([], 0.5) is null, "an empty sample set reports null, never 0");
    }

    private static void EnvelopeShapeMatchesTheSharedContract()
    {
        SceneDeltaWireMetrics.Enabled = true;
        SceneDeltaWireMetrics.Reset();
        for (var i = 0; i < 20; i++)
        {
            SceneDeltaWireMetrics.Record(new SceneDeltaWireMetrics.Sample(i * 50.0, 1000 + i, 5, 1, 200, 0, i == 0));
        }

        var report = SceneDeltaWireMetrics.BuildReport(
            "unit-scenario", SceneDeltaWireMetrics.Snapshot(), windows: 4, envKind: "ci", envLabel: "unit", cpuThrottle: 6);
        var json = JsonNode.Parse(PerfReport.ToJson(report))!.AsObject();

        Assert((string?)json["schema"] == "perf-report/1", "schema");
        Assert((string?)json["repo"] == "sts2-couch-coop", "repo");
        // The metric block is per-PROFILE: a wire-bytes report must not be validated against the
        // browser-render metric set (it has no initialRenderMs to give, and would have to invent one).
        Assert((string?)json["profile"] == "wire-payload", "profile names the metric set this report carries");
        Assert((string?)json["scenario"] == "unit-scenario", "scenario");
        var env = json["env"]!.AsObject();
        Assert((string?)env["kind"] == "ci" && (string?)env["label"] == "unit", "env.kind/label");
        Assert((double?)env["cpuThrottle"] == 6, "env.cpuThrottle");
        Assert(env["device"] is null, "env.device is null when there is no device");
        Assert((int?)json["repeats"] == 4 && json["runs"]!.AsArray().Count == 4, "repeats == runs.length");
        Assert(json["runs"]!.AsArray().Count > 0, "runs is never empty — a report with no runs measured nothing");
        Assert(json["warmups"] is not null && json["artifacts"] is JsonObject && json["params"] is JsonObject,
            "warmups/artifacts/params present");

        var metrics = json["metrics"]!.AsObject();
        foreach (var key in new[] { "wireBytes", "upsertCount", "removedCount", "orderedIdsBytes" })
        {
            var block = metrics[key]!.AsObject();
            Assert(block.ContainsKey("p50") && block.ContainsKey("p95") && block.ContainsKey("max"), $"metrics.{key} p50/p95/max");
        }

        Assert((int?)metrics["frames"] == 20, "metrics.frames counts every sample");
        Assert((int?)metrics["fullKeyframes"] == 1, "metrics.fullKeyframes");
        Assert((double?)metrics["framesPerSec"] is not null, "metrics.framesPerSec present");
        Assert((double?)metrics["wireBytes"]!["max"] >= (double?)metrics["wireBytes"]!["p50"], "max >= p50");
    }

    private static void WindowsSplitAndFrameRate()
    {
        SceneDeltaWireMetrics.Reset();
        // 21 frames, exactly 20ms apart => 50Hz.
        for (var i = 0; i < 21; i++)
        {
            SceneDeltaWireMetrics.Record(new SceneDeltaWireMetrics.Sample(i * 20.0, 100, 1, 0, 0, 0, false));
        }

        var report = SceneDeltaWireMetrics.BuildReport("rate", SceneDeltaWireMetrics.Snapshot(), windows: 3);
        var runs = report["runs"]!.AsArray();
        Assert(runs.Count == 3, $"three contiguous windows (got {runs.Count})");
        var frames = runs.Sum(r => (int)r!["frames"]!);
        Assert(frames == 21, $"every frame lands in exactly one window (got {frames})");
        Assert((double?)runs[0]!["framesPerSec"] == 50, $"framesPerSec from the sample timestamps (got {runs[0]!["framesPerSec"]})");
        Assert((string?)report["params"]!["runSplit"] == "contiguous-windows",
            "params names the split, so nobody reads windows as independent repeats");

        // A single-frame window has no interval: null, not a fabricated rate.
        SceneDeltaWireMetrics.Reset();
        SceneDeltaWireMetrics.Record(new SceneDeltaWireMetrics.Sample(0, 100, 1, 0, 0, 0, false));
        var single = SceneDeltaWireMetrics.BuildReport("single", SceneDeltaWireMetrics.Snapshot(), windows: 1);
        Assert(single["runs"]![0]!["framesPerSec"] is null, "one frame => framesPerSec null");
    }

    private static void RestoreDefaults()
    {
        SceneDeltaWireMetrics.Enabled = false;
        SceneDeltaWireMetrics.Reset();
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"SceneDeltaWireMetricsTests failed: {label}.");
        }
    }
}
