using System.Text.Json;
using System.Text.Json.Nodes;

namespace CouchCoop.Mod.Diagnostics;

// The SHARED rendering/perf A/B report envelope. Its JSON shape is owned by godot-scene-web
// (packages/perf-harness/src/report.ts) and deliberately reproduced here by SHAPE ONLY — no build dependency,
// no cross-repo import. A couch-coop report and a gsw report must be diffable/mergeable field-for-field, which
// is the whole point: a unit-level win measured in gsw is only real if the integration-level envelope from this
// repo moves the same way.
//
//   {
//     "schema": "perf-report/1",
//     "repo": "sts2-couch-coop",
//     "profile": "wire-payload",
//     "scenario": "<scenario name>",
//     "env": { "kind": "host", "label": "<label>", "cpuThrottle": null, "device": null },
//     "params": { … },
//     "repeats": 5, "warmups": 1,
//     "metrics": { … medians across repeats … },
//     "runs": [ … per-repeat raw metrics … ],
//     "artifacts": { }
//   }
//
// Built as a JsonObject rather than a DTO tree: every producer (scene-delta wire, /bg render timing, whatever
// comes next) has a different metric block, and a JsonObject keeps each one's shape local to its own recorder
// instead of forcing a union DTO that every future metric has to widen.
public static class PerfReport
{
    public const string Schema = "perf-report/1";
    public const string Repo = "sts2-couch-coop";

    // The metric block is PER PROFILE: the shared validator only demands the browser-render metric set of a
    // browser-render report, so a wire-bytes or asset-render report is not forced to invent an
    // `initialRenderMs` it could never measure. These are the profiles this repo emits.
    public const string ProfileWirePayload = "wire-payload";
    public const string ProfileAssetRender = "asset-render";

    // Envelope-writer JSON options: indented for a human/CI artifact, and NOT camel-cased — every key in the
    // envelope is written literally by the builder, so the contract field names are exactly what appears here.
    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true };

    /// <summary>A controlled harness run.</summary>
    public const string CiKind = "ci";

    /// <summary>
    /// A real process on a developer/host machine — what every number these routes serve is, because they come
    /// out of a running game rather than a harness.
    /// </summary>
    public const string HostKind = "host";

    /// <summary>A physical phone.</summary>
    public const string DeviceKind = "device";

    /// <summary>
    /// The <c>env.kind</c> ENUM, fixed on the shared validator's side. <c>ci</c> and <c>host</c> are the same
    /// hardware class and follow the same rules; the split that decides comparability is local-box vs phone.
    /// This repo's reports are <c>host</c> — calling a capture from a running game "ci" would be false.
    /// </summary>
    public static readonly IReadOnlyList<string> EnvKinds = [CiKind, HostKind, DeviceKind];

    /// <summary>True when <paramref name="kind"/> is a value the shared validator accepts.</summary>
    public static bool IsValidEnvKind(string? kind) => kind is not null && EnvKinds.Contains(kind, StringComparer.Ordinal);

    /// <summary><c>ci</c> under a CI runner, otherwise <c>host</c>.</summary>
    public static string DefaultEnvKind()
        => string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("CI")) ? HostKind : CiKind;

    /// <summary>
    /// Assemble the envelope. <paramref name="runs"/> are the per-repeat raw metric objects and
    /// <paramref name="metrics"/> the medians across them (the caller computes those — only the caller knows
    /// which of its fields are numbers to take a median of and which are labels).
    /// </summary>
    public static JsonObject Build(
        string profile,
        string scenario,
        JsonObject metrics,
        IReadOnlyList<JsonObject> runs,
        JsonObject? parameters = null,
        string? envKind = null,
        string? envLabel = null,
        double? cpuThrottle = null,
        string? device = null,
        int warmups = 0,
        JsonObject? artifacts = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(profile);
        ArgumentException.ThrowIfNullOrWhiteSpace(scenario);

        var kind = envKind ?? DefaultEnvKind();
        // env.kind is an ENUM on the validator's side, so a word outside it drops the whole report over one
        // field. This repo shipped `live` for a round and every envelope it produced was invalid; fail at the
        // source instead. Callers that take the kind from user input (the perf routes) check it themselves and
        // answer 400, so this only fires on a programming error.
        if (!IsValidEnvKind(kind))
        {
            throw new ArgumentException(
                $"'{kind}' is not a perf-report env.kind; expected one of {string.Join(", ", EnvKinds)}.",
                nameof(envKind));
        }

        var runArray = new JsonArray();
        foreach (var run in runs)
        {
            runArray.Add(run);
        }

        return new JsonObject
        {
            ["schema"] = Schema,
            ["repo"] = Repo,
            ["profile"] = profile,
            ["scenario"] = scenario,
            ["env"] = new JsonObject
            {
                ["kind"] = kind,
                ["label"] = envLabel is null ? null : JsonValue.Create(envLabel),
                ["cpuThrottle"] = cpuThrottle is null ? null : JsonValue.Create(cpuThrottle.Value),
                ["device"] = device is null ? null : JsonValue.Create(device),
            },
            ["params"] = parameters ?? [],
            ["repeats"] = runs.Count,
            ["warmups"] = warmups,
            ["metrics"] = metrics,
            ["runs"] = runArray,
            ["artifacts"] = artifacts ?? [],
        };
    }

    public static string ToJson(JsonObject report) => report.ToJsonString(WriteOptions);
}

/// <summary>
/// The percentile/median helpers every couch-coop perf recorder shares, so "p95" means the same thing in the
/// scene-delta report and the /bg report. NEAREST-RANK on the sorted sample list (index = ceil(p*n)-1): no
/// interpolation, so every reported value is a value that was actually measured.
/// </summary>
public static class PerfStats
{
    public static double? Percentile(IReadOnlyList<double> values, double p)
    {
        if (values.Count == 0)
        {
            return null;
        }

        var sorted = values.ToArray();
        Array.Sort(sorted);
        var rank = (int)Math.Ceiling(p * sorted.Length);
        var index = Math.Clamp(rank - 1, 0, sorted.Length - 1);
        return sorted[index];
    }

    public static double? Median(IReadOnlyList<double> values)
    {
        if (values.Count == 0)
        {
            return null;
        }

        var sorted = values.ToArray();
        Array.Sort(sorted);
        var mid = sorted.Length / 2;
        return sorted.Length % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0;
    }

    public static double? Max(IReadOnlyList<double> values) => values.Count == 0 ? null : values.Max();

    /// <summary>Round to <paramref name="digits"/> decimals, preserving null.</summary>
    public static double? Round(double? value, int digits = 2)
        => value is null ? null : Math.Round(value.Value, digits, MidpointRounding.AwayFromZero);

    /// <summary>
    /// The {p50, p95, max} block used by every metric family in this repo's reports.
    /// </summary>
    public static JsonObject Distribution(IReadOnlyList<double> values, int digits = 2) => new()
    {
        ["p50"] = JsonValueOrNull(Round(Percentile(values, 0.50), digits)),
        ["p95"] = JsonValueOrNull(Round(Percentile(values, 0.95), digits)),
        ["max"] = JsonValueOrNull(Round(Max(values), digits)),
    };

    /// <summary>
    /// The median-across-runs of one numeric field of each run object (the envelope's `metrics` block is
    /// "medians across repeats"). Missing/non-numeric fields are skipped, not counted as zero.
    /// </summary>
    public static double? MedianOfRuns(IReadOnlyList<JsonObject> runs, params string[] path)
    {
        var values = new List<double>(runs.Count);
        foreach (var run in runs)
        {
            JsonNode? node = run;
            foreach (var segment in path)
            {
                node = node is JsonObject obj && obj.TryGetPropertyValue(segment, out var child) ? child : null;
                if (node is null)
                {
                    break;
                }
            }

            if (node is JsonValue value && value.TryGetValue<double>(out var number))
            {
                values.Add(number);
            }
        }

        return Median(values);
    }

    /// <summary>The {p50,p95,max} block whose members are each the MEDIAN of that member across runs.</summary>
    public static JsonObject MedianDistribution(IReadOnlyList<JsonObject> runs, string field, int digits = 2) => new()
    {
        ["p50"] = JsonValueOrNull(Round(MedianOfRuns(runs, field, "p50"), digits)),
        ["p95"] = JsonValueOrNull(Round(MedianOfRuns(runs, field, "p95"), digits)),
        ["max"] = JsonValueOrNull(Round(MedianOfRuns(runs, field, "max"), digits)),
    };

    public static JsonNode? JsonValueOrNull(double? value) => value is null ? null : JsonValue.Create(value.Value);
}
