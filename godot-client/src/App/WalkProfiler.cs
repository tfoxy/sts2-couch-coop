// WS-W (M3): native walk-perf instrumentation. Zero visibility existed into the drain/reconcile path's per-frame
// cost before this — this gives the on-device bench (BENCH_RESULT) and a live --connect session (the periodic
// M3_WALK log, AppShell._Process) the same P50/P95/P99 shape the web/M0 already reports for frame time.
//
// Fixed-size Stopwatch-tick rings (2048, matching the frame ring at AppShell.cs `_frameRing`) for the four timed
// buckets the design calls out: Drain (MirrorStore.FinishDrain — includes Transforms.Update + Spread.Update),
// Reconcile (SceneReconciler.OnDrained's FullRebuild/Incremental branch), Spread (ApplySpread), and Tween
// (TweenReplayer.Consume). A ring only advances when a drain actually applies ≥1 delta — an idle frame (no deltas →
// no drain) never calls Start/Stop, so idle overhead is zero. StructuralDrains is a single counter (not a ring):
// bumped whenever a drain's Keyframe or OrderChanged flag is set (SceneReconciler.OnDrained), cheaply bucketing
// structural vs. incremental reconciles without a second timing ring.
using System;
using System.Diagnostics;
using CouchCoop.MirrorProtocol.Assets;

namespace CouchCoop.GodotClient.App;

public static class WalkProfiler
{
    public enum Metric
    {
        Drain,
        Reconcile,
        Spread,
        Tween,

        // WS-P1: the Spread.Update(...) call inside MirrorStore.FinishDrain (recompute the per-node spread records),
        // distinct from the Spread bucket above (SceneReconciler.ApplySpread, which STAMPS the records onto views).
        SpreadIndex,

        // CULL (M3 fill reduction): the SceneReconciler cull pass — CullIndex.Update (bounds/decision math) plus the
        // per-view decision application. The hot re-eval path is a map scroll (a transform delta for the whole map
        // subtree every frame); the target is <1ms p95 in combat.
        Cull,

        // Track-D static bake: the StaticBake controller's plan-and-build attempt (excluded-set sweep +
        // StaticBakePlanner.Plan + the clone-tree build). Runs only at the eval cadence (~30 frames), never per drain,
        // so its samples are sparse; the p95 bounds the worst clone-build hitch.
        Bake,

        // Track-B text overlay: the TextOverlay controller's per-eval plan-and-build (excluded-set sweep +
        // TextOverlayPlanner.Plan + proxy build/diff) AND its per-drain CollectDemotions guard. Eval samples are sparse
        // (~30-frame cadence); the per-drain demotion pass is cheap. The p95 bounds the worst text-overlay hitch.
        TextOverlay,

        // Track-C card layer: the CardLayer controller's per-eval plan-and-diff (excluded-set sweep +
        // CardLayerPlanner.Plan + clone build/diff) AND its OrderChanged immediate replan AND its per-drain
        // CollectDemotions guard. Eval + OrderChanged samples are the heavy ones (clone-tree builds); the per-drain
        // demotion pass is cheap. The p95 bounds the worst card-layer hitch (target: <0.5ms steady, <3ms on replans).
        CardLayer,
    }

    private const int RingSize = 2048;
    private static readonly int MetricCount = Enum.GetValues<Metric>().Length;

    // One ring per metric, each with its own head/count (ring-capped, feeds the percentile math) and a total-count
    // (uncapped, the `walk*Count` / `(n=..)` figure — a long bench can apply far more than 2048 drains).
    private static readonly double[][] Rings = MakeRings();
    private static readonly int[] Heads = new int[MetricCount];
    private static readonly int[] RingCounts = new int[MetricCount];
    private static readonly long[] TotalCounts = new long[MetricCount];

    // Bumped by SceneReconciler.OnDrained when a drain's Keyframe or OrderChanged flag is set.
    public static long StructuralDrains;

    private static double[][] MakeRings()
    {
        var rings = new double[MetricCount][];
        for (int i = 0; i < MetricCount; i++)
        {
            rings[i] = new double[RingSize];
        }

        return rings;
    }

    // Allocation-free, monotonic (Stopwatch.GetTimestamp) — call at the top of a timed section.
    public static long Start() => Stopwatch.GetTimestamp();

    // Convert elapsed ticks since `start` to milliseconds and record it in `metric`'s ring. Call at the bottom of
    // the same timed section.
    public static void Stop(Metric metric, long start)
    {
        double elapsedMs = (Stopwatch.GetTimestamp() - start) * 1000.0 / Stopwatch.Frequency;
        int m = (int)metric;
        Rings[m][Heads[m]] = elapsedMs;
        Heads[m] = (Heads[m] + 1) % RingSize;
        if (RingCounts[m] < RingSize)
        {
            RingCounts[m]++;
        }

        TotalCounts[m]++;
    }

    public readonly record struct Stats(double P50, double P95, double P99, long Count);

    // P50/P95/P99 over the ring's most-recent (up to RingSize) samples via the shared Percentiles.Compute (WS-U);
    // Count is the TOTAL number of Stop calls for this metric (uncapped), so a long-running bench's `walk*Count`
    // reflects the real drain total even once the ring itself has wrapped.
    public static Stats Percentiles(Metric metric)
    {
        int m = (int)metric;
        int ringCount = RingCounts[m];
        if (ringCount == 0)
        {
            return new Stats(0, 0, 0, TotalCounts[m]);
        }

        var values = new double[ringCount];
        Array.Copy(Rings[m], values, ringCount);
        var p = CouchCoop.MirrorProtocol.Assets.Percentiles.Compute(values, 0.50, 0.95, 0.99);
        return new Stats(p[0], p[1], p[2], TotalCounts[m]);
    }

    // Back-to-menu rebuild: clear every ring/counter so the rebuilt stack's percentiles start clean (matches the
    // other process-static caches reset in AppShell.ReturnToMenu).
    public static void Reset()
    {
        for (int m = 0; m < MetricCount; m++)
        {
            Heads[m] = 0;
            RingCounts[m] = 0;
            TotalCounts[m] = 0;
            Array.Clear(Rings[m]);
        }

        StructuralDrains = 0;
    }
}
