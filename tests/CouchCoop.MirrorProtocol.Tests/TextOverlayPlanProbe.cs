using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Text-overlay planner probe. Point COUCHCOOP_TEXTOVL_PROBE_NDJSON at a recording; it replays every scene-delta to
// build the final MirrorState, runs the current TextOverlayPlanner policy, and prints its promoted count, reject
// histogram, and a per-label verdict for
// the elements the user flagged (creature HP number, power/block stack count) matched by node NAME. This is the
// ground-truth for whether the current policy promotes these labels without a Godot host. The static-snapshot
// sweep passes EMPTY dynamic sets (a headless replay has no live views), so a persistent static label (HP/power/block)
// is representative; a transient rising notification (Wears Off) is usually gone from the FINAL frame (reported if
// present). Skips SILENTLY when the env var is unset / the file is absent (nothing committed).
internal static class TextOverlayPlanProbe
{
    // The user's flagged elements, by wire node NAME (see .ai/plans/trackz-diagnosis.md).
    private static readonly string[] TargetNames = { "HpLabel", "AmountLabel", "BlockLabel", "WearsOff" };

    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_TEXTOVL_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        // Optional: stop replaying after N frames, to snapshot a transient element (a rising "Wears Off" notification /
        // a creature power that later expires) that the FINAL frame no longer carries.
        int maxFrames = int.TryParse(Environment.GetEnvironmentVariable("COUCHCOOP_TEXTOVL_PROBE_MAXFRAMES"), out var mf) ? mf : int.MaxValue;

        var state = MirrorState.Create();
        int applied = 0;
        foreach (var line in File.ReadLines(path))
        {
            if (applied >= maxFrames)
            {
                break;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            string deltaJson;
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (!doc.RootElement.TryGetProperty("data", out var dataEl) || dataEl.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                deltaJson = dataEl.GetString()!;
            }
            catch
            {
                continue;
            }

            var delta = SceneDeltaReader.Parse(deltaJson);
            if (delta is null)
            {
                continue;
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
            applied++;
        }

        if (applied == 0)
        {
            Console.Error.WriteLine($"[textovl-probe] {Path.GetFileName(path)}: no deltas applied");
            return;
        }

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);
        var planner = new TextOverlayPlanner();
        planner.RebuildIndex(state);

        var empty = new HashSet<string>(StringComparer.Ordinal);
        double DxOf(string _) => 0.0;

        Console.Error.WriteLine($"[textovl-probe] file={Path.GetFileName(path)} nodes={state.Nodes.Count} " +
                                $"orderedIds={state.OrderedIds.Count}");

        // Capture the current per-candidate eval/occlusion trace so a still-mushy TARGET's reject
        // reason (Occluded by whom / Invisible / …) is explainable.
        var trace = new List<string>();
        planner.Debug = trace.Add;
        var current = Report(planner, state, transforms, DxOf, empty, "current");
        planner.Debug = null;

        var targetIds = new HashSet<string>(
            state.Nodes.Values.Where(n => TargetNames.Contains(n.Name) && n.Text is { Text.Length: > 0 }).Select(n => n.Id),
            StringComparer.Ordinal);
        foreach (var t in trace.Where(l => targetIds.Any(id => l.Contains("id=" + id))))
        {
            Console.Error.WriteLine($"[textovl-probe]   trace: {t}");
        }

        // Per-target verdict: for each flagged NAME, list its ids present in the final state + whether each promotes.
        var currentIds = new HashSet<string>(current.Select(i => i.Id), StringComparer.Ordinal);
        foreach (var name in TargetNames)
        {
            var hits = state.Nodes.Values.Where(n => n.Name == name && n.Text is { Text.Length: > 0 }).ToList();
            if (hits.Count == 0)
            {
                Console.Error.WriteLine($"[textovl-probe]   TARGET '{name}': not present in the FINAL frame");
                continue;
            }

            foreach (var n in hits)
            {
                Console.Error.WriteLine($"[textovl-probe]   TARGET '{name}' id={n.Id} text='{n.Text!.Text}' effZ={EffZ(state, n.Id)} " +
                                        $"→ {(currentIds.Contains(n.Id) ? "PROMOTED" : "mushy")}");
            }
        }
    }

    private static IReadOnlyList<TextOverlayItem> Report(
        TextOverlayPlanner planner, MirrorState state, GlobalTransformIndex transforms, Func<string, double> dxOf,
        IReadOnlySet<string> empty, string label)
    {
        var plan = planner.Plan(state, transforms, 1.0, dxOf, empty, empty, empty, null,
            false, new TextOverlayOptions(), null, null);
        var hist = planner.LastRejectHistogram
            .OrderBy(kv => kv.Key.ToString(), StringComparer.Ordinal)
            .Select(kv => $"{kv.Key}={kv.Value}");
        Console.Error.WriteLine($"[textovl-probe]   {label}: promoted={plan.Items.Count} evaluated={planner.LastEvaluated} " +
                                $"histogram[{string.Join(" ", hist)}]");
        return plan.Items;
    }

    // effZ = Σ ZIndex down the ancestor chain (the same band the planner computes), for the per-target report only.
    private static int EffZ(MirrorState state, string id)
    {
        int z = 0;
        string? cur = id;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var n) && guard++ < 4096)
        {
            z += n.ZIndex ?? 0;
            cur = n.ParentId;
        }

        return z;
    }
}
