using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CouchCoop.Mod.Diagnostics;

// S9 OFFLINE harness. The live recorder (SceneDeltaWireMetrics, armed on the send path) needs a running game;
// a RECORDED mirror stream does not — and the recording IS the serializer's output, byte for byte, from a real
// combat. So replaying one through the same aggregator produces the real integration-level wire report with no
// game in the loop, and the live route reports the identical envelope shape when a game is there.
//
//   dotnet run --project tests/CouchCoop.Mod.Tests -- wire-report <recording.ndjson> \
//       [--out <file>] [--scenario <name>] [--label <label>] [--windows 5]
//
// Every number is measured from the recorded bytes: wireBytes is the UTF-8 length of the message that was on
// the socket, orderedIds/orderPatch bytes are the RAW JSON text of those members as recorded (not an estimate),
// and framesPerSec comes from the recording's own delivery timestamps.
internal static class WireReportHarness
{
    public const string Verb = "wire-report";

    public static async Task<int> RunAsync(string[] args)
    {
        string? path = null;
        string? outPath = null;
        string? scenario = null;
        string? label = null;
        var windows = 5;

        for (var i = 1; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--out": outPath = Next(args, ref i); break;
                case "--scenario": scenario = Next(args, ref i); break;
                case "--label": label = Next(args, ref i); break;
                case "--windows":
                    windows = int.TryParse(Next(args, ref i), out var parsed) ? parsed : windows;
                    break;
                default:
                    if (args[i].StartsWith("--", StringComparison.Ordinal))
                    {
                        Console.Error.WriteLine($"unknown option {args[i]}");
                        return 2;
                    }

                    path ??= args[i];
                    break;
            }
        }

        if (path is null)
        {
            Console.Error.WriteLine($"usage: {Verb} <recording.ndjson> [--out <file>] [--scenario <name>] [--label <l>] [--windows <n>]");
            return 2;
        }

        if (!File.Exists(path))
        {
            Console.Error.WriteLine($"recording not found: {path}");
            return 2;
        }

        SceneDeltaWireMetrics.Reset();
        var lines = 0;
        var nonDelta = 0;
        await foreach (var line in File.ReadLinesAsync(path))
        {
            if (line.Length == 0)
            {
                continue;
            }

            lines++;
            if (!TryReadFrame(line, out var sample))
            {
                nonDelta++;
                continue;
            }

            SceneDeltaWireMetrics.Record(sample);
        }

        var samples = SceneDeltaWireMetrics.Snapshot();
        var report = SceneDeltaWireMetrics.BuildReport(
            scenario ?? Path.GetFileNameWithoutExtension(path),
            samples,
            windows,
            // `host` off a CI runner: this harness is a local tool replaying a recording on someone's box.
            envKind: PerfReport.DefaultEnvKind(),
            envLabel: label,
            cpuThrottle: null,
            extraParams: new JsonObject
            {
                ["source"] = "recording",
                ["recording"] = Path.GetFullPath(path),
                ["recordedMessages"] = lines,
                ["nonSceneDeltaMessages"] = nonDelta,
            });

        var json = PerfReport.ToJson(report);
        if (outPath is not null)
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(outPath));
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            await File.WriteAllTextAsync(outPath, json + Environment.NewLine);
            Console.Error.WriteLine($"[wire-report] {samples.Count} scene-delta frames -> {Path.GetFullPath(outPath)}");
        }

        Console.WriteLine(json);
        SceneDeltaWireMetrics.Reset();
        return 0;
    }

    private static string Next(string[] args, ref int i) => i + 1 < args.Length ? args[++i] : string.Empty;

    // One recorded line: {"t":<ms>,"data":"<the exact message text>"}. Only scene-delta messages are frames;
    // session/state/… messages ride the same socket and are counted separately rather than folded in.
    private static bool TryReadFrame(string line, out SceneDeltaWireMetrics.Sample sample)
    {
        sample = default;
        try
        {
            using var envelope = JsonDocument.Parse(line);
            if (!envelope.RootElement.TryGetProperty("data", out var dataElement)
                || dataElement.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            var data = dataElement.GetString()!;
            using var message = JsonDocument.Parse(data);
            var root = message.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("type", out var type)
                || type.GetString() != "scene-delta")
            {
                return false;
            }

            var timestampMs = envelope.RootElement.TryGetProperty("t", out var t) && t.ValueKind == JsonValueKind.Number
                ? t.GetDouble()
                : 0;

            sample = new SceneDeltaWireMetrics.Sample(
                TimestampMs: timestampMs,
                WireBytes: Encoding.UTF8.GetByteCount(data),
                UpsertCount: ArrayLength(root, "upserts"),
                RemovedCount: ArrayLength(root, "removedIds"),
                OrderedIdsBytes: RawBytes(root, "orderedIds"),
                OrderPatchBytes: RawBytes(root, "orderPatch"),
                Full: root.TryGetProperty("full", out var full) && full.ValueKind == JsonValueKind.True);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static int ArrayLength(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array ? value.GetArrayLength() : 0;

    // The member's RAW recorded JSON text — the exact bytes it contributed to that frame.
    private static int RawBytes(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined
            ? Encoding.UTF8.GetByteCount(value.GetRawText())
            : 0;
}
