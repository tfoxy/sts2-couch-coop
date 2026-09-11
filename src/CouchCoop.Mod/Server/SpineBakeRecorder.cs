using System.Diagnostics;
using CouchCoop.Mod.Diagnostics;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Times ONE spine bake end to end and files it with <see cref="SpineBakeMetrics"/>. A bake is a sequence the
/// provider walks through — queue for the shared extraction gate, render on the Godot main thread, serialize,
/// write through to disk — and each step is a different kind of cost, so the recorder is a small state machine
/// the provider drives rather than a stopwatch around the whole thing.
/// </summary>
/// <remarks>
/// The <see cref="RequestId"/> it mints is the address the render lane files its own phase breakdown under
/// (<see cref="Sts2RenderPhaseProfile.TryTake"/>), which is why the provider passes it as the asset request's id
/// instead of the fixed "spine-clip"/"spine-still" labels it used before: two concurrent bakes sharing one id
/// would let one drain the other's table.
/// <para>
/// Every recorder call is best-effort: a bake that fails still records (with <c>Success = false</c>), and a
/// recorder that is never finished simply never records — measurement must not be able to break a bake.
/// </para>
/// </remarks>
public sealed class SpineBakeRecorder
{
    private readonly string _spineKey;
    private readonly string _route;
    private readonly string _kind;
    private readonly long _started;
    private readonly ProcessCpuMetrics.Mark? _cpuMark;
    private readonly List<Sts2RenderPhaseProfile.PhaseCost> _hostPhases = [];

    private double _gateWaitMs;
    private double _renderMs;
    private ProcessCpuMetrics.Window? _cpuWindow;
    private IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost>? _producerPhases;
    private IReadOnlyDictionary<string, long>? _producerCounters;
    private int _claimsProven;
    private int _claimsUnproven;
    private bool _hasClaimProvenance;
    private bool _recorded;

    private SpineBakeRecorder(string spineKey, string route, string? kind)
    {
        _spineKey = spineKey;
        _route = route;
        _kind = kind ?? SpineBakeMetrics.KindOf(spineKey);
        _started = Stopwatch.GetTimestamp();
        _cpuMark = ProcessCpuMetrics.TryMark();
        RequestId = $"spine:{route}:{Guid.NewGuid():N}";
    }

    /// <summary>The asset-request id this bake renders under; also the key its phase breakdown is filed under.</summary>
    public string RequestId { get; }

    /// <param name="kind">
    /// The metric block this bake belongs in, or null to derive it from <paramref name="spineKey"/>. Passed
    /// explicitly by a lane whose kind the key cannot express — see <see cref="SpineBakeMetrics.GeoclipKind"/>.
    /// </param>
    public static SpineBakeRecorder Start(string spineKey, string route, string? kind = null)
        => new(spineKey, route, kind);

    /// <summary>The shared main-thread extraction gate admitted this bake — everything before was queueing.</summary>
    public void GateAdmitted() => _gateWaitMs = ElapsedMs(_started);

    /// <summary>
    /// Adopt a phase table this bake's PRODUCER measured and published itself, for a lane whose breakdown does not
    /// come back through <see cref="Sts2RenderPhaseProfile.TryTake"/>.
    /// </summary>
    /// <remarks>
    /// The geoclip seam is the case: it carries no request id, so the baker mints its own recorder key and closes
    /// it inside the bake, and the only copy of the breakdown that survives is the one it wrote into the artifact
    /// (see <see cref="GeoclipBakeProfileReader"/>). An EMPTY or absent table is ignored rather than stored, so
    /// "the producer was not profiling" can never become a phase table of zeros.
    /// </remarks>
    public void ProducerProfile(
        IReadOnlyList<Sts2RenderPhaseProfile.PhaseCost>? phases,
        IReadOnlyDictionary<string, long>? counters = null)
    {
        if (phases is not { Count: > 0 })
        {
            return;
        }

        _producerPhases = phases;
        _producerCounters = counters;
    }

    /// <summary>
    /// The ownership evidence a GEOCLIP bake carried: how many of its slot→mesh claims were positively proven and
    /// how many were not. Published as counters on this bake's run, admitted or refused.
    /// </summary>
    /// <remarks>
    /// <para>DELIBERATELY NOT ROUTED THROUGH <see cref="ProducerProfile"/>. That method drops its counters
    /// whenever the phase table is empty — correctly, because they are the phase profiler's counters and a table
    /// of them without the phases they explain is noise. These are not: they come off the bake SEAM, they exist
    /// whether or not the producer's profiler is armed, and they are the input to the admission rule rather than
    /// a breakdown of a duration. Filing them through the profile would have made the round's central reading
    /// vanish on any host running with <c>SPIRECTL_RENDER_PHASE_PROFILE=0</c>.</para>
    /// <para>A ZERO PAIR IS IGNORED. Both counts zero means the producing path recorded no provenance at all, and
    /// writing <c>0</c>/<c>0</c> would present that as "nothing proved" — the opposite reading, and the one that
    /// sends an operator to investigate a rig when the answer is an old bridge. Absent means unmeasured here
    /// exactly as it does for the phase table.</para>
    /// </remarks>
    public void ClaimProvenance(int claimsProven, int claimsUnproven)
    {
        if (claimsProven + claimsUnproven <= 0)
        {
            return;
        }

        _claimsProven = claimsProven;
        _claimsUnproven = claimsUnproven;
        _hasClaimProvenance = true;
    }

    /// <summary>The main-thread render returned; the CPU window closes here, before the disk work.</summary>
    public void RenderReturned()
    {
        _renderMs = ElapsedMs(_started) - _gateWaitMs;
        _cpuWindow = ProcessCpuMetrics.TryClose(_cpuMark);
    }

    /// <summary>Packing the rendered frames into the clip wire blob (clip bakes only).</summary>
    public void Serialized(long startedTimestamp)
        => _hostPhases.Add(HostRenderPhases.Phase(HostRenderPhases.Serialize, ElapsedMs(startedTimestamp)));

    /// <summary>The write-through into the binary cache, which the requester is still waiting on.</summary>
    public void CacheWritten(long startedTimestamp)
        => _hostPhases.Add(HostRenderPhases.Phase(HostRenderPhases.CacheWrite, ElapsedMs(startedTimestamp)));

    public void Succeeded(int outputBytes, int frames) => Finish(true, outputBytes, frames);

    public void Failed() => Finish(false, 0, 0);

    private void Finish(bool success, int outputBytes, int frames)
    {
        if (_recorded)
        {
            return; // a failure path that also ran a success path (or vice versa) records once, not twice
        }

        _recorded = true;
        var taken = Sts2RenderPhaseProfile.TryTake(RequestId);
        var phases = (taken?.Phases ?? _producerPhases)?.ToList();
        if (phases is { Count: > 0 })
        {
            // Only decorate a table the render lane actually produced: appending host phases to an empty one
            // would present "the lane was not recording" as "the bake was all queue and disk".
            phases.Add(HostRenderPhases.Phase(HostRenderPhases.GateWait, _gateWaitMs));
            phases.AddRange(_hostPhases);
        }

        SpineBakeMetrics.Record(new SpineBakeMetrics.Sample(
            TimestampMs: Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency,
            Key: _spineKey,
            Kind: _kind,
            // The bake as the REQUESTER experiences it: queue + render + serialize + cache write.
            BakeMs: ElapsedMs(_started),
            OutputBytes: outputBytes,
            Frames: frames,
            Success: success,
            Route: _route,
            CpuMs: _cpuWindow?.CpuMs,
            CpuWallMs: _cpuWindow?.WallMs,
            Phases: phases,
            Counters: WithClaimProvenance(taken?.Counters ?? _producerCounters)));
    }

    /// <summary>
    /// The bake's counters with the claim provenance folded in, or the counters untouched when none was recorded.
    /// </summary>
    /// <remarks>
    /// Copies rather than mutates: the source dictionary belongs to the phase profiler or to the producer's
    /// manifest reading, and a recorder that wrote into it would be scribbling on somebody else's measurement.
    /// </remarks>
    private IReadOnlyDictionary<string, long>? WithClaimProvenance(IReadOnlyDictionary<string, long>? counters)
    {
        if (!_hasClaimProvenance)
        {
            return counters;
        }

        var merged = counters is null
            ? new Dictionary<string, long>(2, StringComparer.Ordinal)
            : new Dictionary<string, long>(counters, StringComparer.Ordinal);
        merged[SpineBakeMetrics.ClaimsProvenCounter] = _claimsProven;
        merged[SpineBakeMetrics.ClaimsUnprovenCounter] = _claimsUnproven;
        return merged;
    }

    /// <summary>The render leg alone (gate wait excluded), for a caller that logs a one-line bake summary.</summary>
    public double RenderMs => _renderMs;

    /// <summary>
    /// How long this bake QUEUED for the shared main-thread extraction gate, for the same one-line summary. Zero
    /// until <see cref="GateAdmitted"/> is called — a lane that never calls it never waited on the gate, which is
    /// a different fact from a lane that waited no time.
    /// </summary>
    public double GateWaitMs => _gateWaitMs;

    private static double ElapsedMs(long startedTimestamp)
        => (Stopwatch.GetTimestamp() - startedTimestamp) * 1000.0 / Stopwatch.Frequency;
}
