using System.Text.Json.Nodes;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Diagnostics;

/// <summary>
/// The phases of a host render that happen on THIS side of the spirectl seam, in the same vocabulary the render
/// lanes use (<see cref="Sts2RenderPhaseProfile"/>), so one phase table describes the whole cost a client waits
/// on rather than only the part that ran inside the extractor.
/// </summary>
/// <remarks>
/// None of these hold the Godot main thread — they are queueing and disk, on a request/threadpool thread — so they
/// are all recorded with <c>blocking: false</c>. That is the same split the render lanes make: "the game stalled"
/// and "the phone waited" are different costs and must never be summed into one bar.
/// </remarks>
public static class HostRenderPhases
{
    /// <summary>Waiting for the host-wide main-thread extraction admission gate (a bake ahead of us in line).</summary>
    public const string GateWait = "gateWait";

    /// <summary>Reading the binary cache before deciding to render.</summary>
    public const string CacheRead = "cacheRead";

    /// <summary>The write-through into the binary cache after a successful render.</summary>
    public const string CacheWrite = "cacheWrite";

    /// <summary>Packing rendered frames into the wire blob a client streams (spine clips only).</summary>
    public const string Serialize = "serialize";

    /// <summary>Build a phase entry in the shared shape. Always non-blocking — see the type remarks.</summary>
    public static Sts2RenderPhaseProfile.PhaseCost Phase(string name, double elapsedMs, int calls = 1)
        => new(name, elapsedMs, calls, Blocking: false);
}

/// <summary>
/// Maps a render's phase costs into the shared <c>perf-report/1</c> envelope: one object per render under
/// <c>runs[]</c>, and a per-phase distribution in the metric block.
/// </summary>
/// <remarks>
/// A render with NO recorded phases (the profiler switched off, or a render that predates it) is reported as
/// absent — <c>phases: null</c> plus a <c>phasedRenders</c> count — never as a table of zeros. Same rule as
/// <see cref="ProcessCpuMetrics"/>'s omitted CPU block: "not measured" and "measured cheap" must not look alike.
/// </remarks>
public static class RenderPhaseReport
{
    /// <summary>
    /// One render's scalar counters (<see cref="Sts2RenderPhaseProfile.Counter"/>), or null when it recorded
    /// none. These are what a duration alone cannot explain — how many layer scenes were loaded, how many render
    /// lanes were built versus retired, how many frames the render parked on, how many pixels the encoder was
    /// handed. Without them a phase table shows that a phase was expensive but not what made it expensive.
    /// </summary>
    public static JsonObject? CountersJson(IReadOnlyDictionary<string, long>? counters)
    {
        if (counters is null || counters.Count == 0)
        {
            return null;
        }

        var json = new JsonObject();
        foreach (var counter in counters.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            json[counter.Key] = counter.Value;
        }

        return json;
    }

    /// <summary>One render's phases, in render order, or null when nothing was recorded.</summary>
    public static JsonObject? PhasesJson(IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost> phases)
    {
        if (phases.Count == 0)
        {
            return null;
        }

        var json = new JsonObject();
        foreach (var phase in phases)
        {
            json[phase.Phase] = new JsonObject
            {
                ["ms"] = PerfStats.JsonValueOrNull(PerfStats.Round(phase.Ms, 2)),
                ["calls"] = phase.Calls,
                ["blocking"] = phase.Blocking,
            };
        }

        return json;
    }

    /// <summary>
    /// Per-phase distributions across a set of renders, in render order. Each phase reports the distribution over
    /// the renders that ACTUALLY RAN it (<c>renders</c>) — a phase only some renders reach (the layer loads of a
    /// selector render, an extra spine lane) must not be averaged against zeros from renders that skipped it.
    /// </summary>
    public static JsonObject? PhaseDistributions(IReadOnlyList<IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost>> renders)
    {
        var measured = renders.Where(phases => phases.Count > 0).ToList();
        if (measured.Count == 0)
        {
            return null;
        }

        var byPhase = new Dictionary<string, List<Sts2RenderPhaseProfile.PhaseCost>>(StringComparer.Ordinal);
        foreach (var phase in measured.SelectMany(phases => phases))
        {
            if (!byPhase.TryGetValue(phase.Phase, out var bucket))
            {
                byPhase[phase.Phase] = bucket = [];
            }

            bucket.Add(phase);
        }

        var json = new JsonObject();
        foreach (var phase in Sts2RenderPhaseProfile.Fold([.. measured.Select(ToSnapshot)]))
        {
            var bucket = byPhase[phase.Phase];
            json[phase.Phase] = new JsonObject
            {
                ["renders"] = bucket.Count,
                ["blocking"] = phase.Blocking,
                ["totalMs"] = PerfStats.JsonValueOrNull(PerfStats.Round(phase.Ms, 2)),
                ["calls"] = phase.Calls,
                ["ms"] = PerfStats.Distribution([.. bucket.Select(entry => entry.Ms)], 2),
            };
        }

        return json;
    }

    /// <summary>
    /// The headline split for a set of renders: how much of the measured time held the Godot main thread (the
    /// stall a player sees) versus parked on frames/queues/disk (latency only). Null when nothing was measured.
    /// </summary>
    public static JsonObject? BlockingSplit(IReadOnlyList<IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost>> renders)
    {
        var measured = renders.Where(phases => phases.Count > 0).ToList();
        if (measured.Count == 0)
        {
            return null;
        }

        var blocking = measured.Select(phases => phases.Where(phase => phase.Blocking).Sum(phase => phase.Ms)).ToList();
        var parked = measured.Select(phases => phases.Where(phase => !phase.Blocking).Sum(phase => phase.Ms)).ToList();
        var measuredMs = blocking.Sum() + parked.Sum();
        return new JsonObject
        {
            ["phasedRenders"] = measured.Count,
            ["blockingMs"] = PerfStats.Distribution(blocking, 2),
            ["parkedMs"] = PerfStats.Distribution(parked, 2),
            // Of the time we ATTRIBUTED, the share that held the main thread. Deliberately not a share of the
            // render's wall clock: unattributed time exists (see Snapshot.UnattributedMs) and folding it in here
            // would quietly present it as non-blocking.
            ["blockingShare"] = PerfStats.JsonValueOrNull(
                measuredMs > 0 ? PerfStats.Round(blocking.Sum() / measuredMs, 4) : null),
        };
    }

    // Fold() is defined over snapshots; a phase list is all it reads, so wrap rather than duplicate the fold.
    private static Sts2RenderPhaseProfile.Snapshot ToSnapshot(IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost> phases)
        => new(string.Empty, 0, 0, 0, phases, new Dictionary<string, long>());
}
