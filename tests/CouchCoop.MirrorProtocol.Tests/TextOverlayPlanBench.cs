using System.Diagnostics;
using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Optional planner micro-benchmark (Track-V). Point COUCHCOOP_TEXTOVL_BENCH_NDJSON at a recording (e.g.
// .sts2/bench/combat-2026-07-15T16-40-09-999Z.ndjson); it applies every scene-delta to build the final MirrorState,
// then times TextOverlayPlanner.Plan over many iterations and prints p50/p95/p99 in ms. This measures the DOMINANT
// per-eval cost of the TextOverlay walk (the ordered-ids sweep + eligibility + occlusion) in isolation from Godot, so
// the ~2.15ms overlay-walk budget can be checked on a clean machine. Skips SILENTLY when the env var is unset / the
// file is absent, so the suite stays green in a checkout without a recording (nothing is committed).
internal static class TextOverlayPlanBench
{
    public static void Run()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_TEXTOVL_BENCH_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var state = MirrorState.Create();
        int applied = 0;
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            // The recording wraps each frame as {"t":<ms>,"data":"<raw scene-delta json>"}; the first line is {"meta"}.
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
            return;
        }

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);
        var planner = new TextOverlayPlanner();
        planner.RebuildIndex(state);

        var empty = new HashSet<string>(StringComparer.Ordinal);
        double DxOf(string _) => 0.0;

        // Warm up (JIT + caches).
        int promoted = 0;
        for (int i = 0; i < 50; i++)
        {
            promoted = planner.Plan(state, transforms, 1.0, DxOf, empty, empty, empty, null, false, new TextOverlayOptions(), null, null).Items.Count;
        }

        const int iters = 4000;
        var ms = new double[iters];
        for (int i = 0; i < iters; i++)
        {
            long t0 = Stopwatch.GetTimestamp();
            planner.Plan(state, transforms, 1.0, DxOf, empty, empty, empty, null, false, new TextOverlayOptions(), null, null);
            long t1 = Stopwatch.GetTimestamp();
            ms[i] = (t1 - t0) * 1000.0 / Stopwatch.Frequency;
        }

        Array.Sort(ms);
        double P(double q) => ms[(int)Math.Clamp(q * (iters - 1), 0, iters - 1)];
        Console.Error.WriteLine(
            $"[textovl-plan-bench] nodes={state.Nodes.Count} evaluated={planner.LastEvaluated} promoted={promoted} " +
            $"plan_ms p50={P(0.50):0.000} p95={P(0.95):0.000} p99={P(0.99):0.000} (iters={iters})");

        // Track-Z: the same timing with the z-aware paint order ON (the production default) — the effZ lookups ride the
        // paint-key path, so this bounds the z-relaxation's added walk cost on a real scene.
        int promotedZ = 0;
        for (int i = 0; i < 50; i++)
        {
            promotedZ = planner.Plan(state, transforms, 1.0, DxOf, empty, empty, empty, null, false, new TextOverlayOptions(), null, null).Items.Count;
        }

        for (int i = 0; i < iters; i++)
        {
            long t0 = Stopwatch.GetTimestamp();
            planner.Plan(state, transforms, 1.0, DxOf, empty, empty, empty, null, false, new TextOverlayOptions(), null, null);
            long t1 = Stopwatch.GetTimestamp();
            ms[i] = (t1 - t0) * 1000.0 / Stopwatch.Frequency;
        }

        Array.Sort(ms);
        Console.Error.WriteLine(
            $"[textovl-plan-bench] zrelax=ON promoted={promotedZ} " +
            $"plan_ms p50={P(0.50):0.000} p95={P(0.95):0.000} p99={P(0.99):0.000} (iters={iters})");
    }
}
