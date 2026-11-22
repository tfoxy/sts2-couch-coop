using CouchCoop.Mod.Runtime;
using Godot;
using System.Text.Json;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Session;

/// <summary>Forwards raw schedules while this seat is armed and any stream page requests them.</summary>
public sealed class CouchCoopStreamTweenAnnouncer
{
    private static readonly CouchCoopStreamTweenAnnouncer Shared = new(
        EmbeddableTweenScheduleHub.Shared.Subscribe, new GodotRenderStreamCapture(), CouchCoopLog.Info);
    private readonly Func<Action<TweenSchedule>, Action<TweenEnd>, IDisposable> _subscribe;
    private readonly IRenderStreamTweenCapture _capture;
    private readonly Action<string> _log;
    private readonly Func<ulong, ulong?> _resolveMaterial;
    private readonly HashSet<long> _announced = [];
    private readonly Dictionary<string, long> _unsupported = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _hostOnly = new(StringComparer.Ordinal);
    private IDisposable? _subscription;
    private bool _armed;
    private bool _desired;
    private long _begins, _steps, _cancels, _finished, _retimed, _relative, _loops;
    private static volatile bool _pageDesired;

    internal CouchCoopStreamTweenAnnouncer(
        Func<Action<TweenSchedule>, Action<TweenEnd>, IDisposable> subscribe,
        IRenderStreamTweenCapture capture, Action<string> log, Func<ulong, ulong?>? resolveMaterial = null)
        => (_subscribe, _capture, _log, _resolveMaterial) = (subscribe, capture, log, resolveMaterial ?? ResolveMaterial);

    internal static void SetArmed(bool armed) => Shared.UpdateArmed(armed);

    public static void SetDesired(bool desired)
    {
        if (_pageDesired == desired) return;
        _pageDesired = desired;
        if (CouchCoopMod.EngineAvailable)
            GameDeferred.Post(() => Shared.UpdateDesired(_pageDesired));
    }

    internal void UpdateArmed(bool armed)
    {
        if (_armed == armed) return;
        _armed = armed;
        Reconcile();
        if (!armed)
        {
            _log($"[stream-tweens] begins={_begins} steps={_steps} cancels={_cancels} "
                + $"finished={_finished} retimed={_retimed} relative={_relative} loops={_loops} unsupported="
                + string.Join(",", _unsupported.OrderBy(p => p.Key).Select(p => $"{p.Key}:{p.Value}"))
                + " host_only="
                + string.Join(",", _hostOnly.OrderBy(p => p.Key).Select(p => $"{p.Key}:{p.Value}"))
                + " capture=" + CaptureCounters());
            _begins = _steps = _cancels = _finished = _retimed = _relative = _loops = 0;
            _unsupported.Clear();
            _hostOnly.Clear();
        }
    }

    private string CaptureCounters()
    {
        try
        {
            // The armed callback runs before capture teardown clears these per-session counters.
            var counters = _capture.TweenCounters();
            return counters is null ? "unavailable" : JsonSerializer.Serialize(counters);
        }
        catch { return "unavailable"; } // Diagnostics must not interrupt disarm.
    }

    internal void UpdateDesired(bool desired)
    {
        _desired = desired;
        Reconcile();
    }

    private void Reconcile()
    {
        if (_armed && _desired)
        {
            _subscription ??= _subscribe(Begin, End);
            return;
        }
        _subscription?.Dispose();
        _subscription = null;
        // Cancel existing claims when the last interested page opts out. Disarm already clears capture state.
        if (_armed)
            foreach (var id in _announced) { _capture.TweenCancel(id); _cancels++; }
        _announced.Clear();
    }

    private void Begin(TweenSchedule schedule)
    {
        if (!_armed || !_desired) return;
        if (schedule.Loops != 1) { _loops++; return; }
        // Relative steps change subsequent implicit starts; reject the complete target schedule.
        if (schedule.Steps.Any(s => s.Relative)) { _relative++; return; }
        List<IReadOnlyDictionary<string, object>>? steps = null, materialSteps = null;
        ulong? materialId = null;
        var materialResolved = false;
        foreach (var step in schedule.Steps)
        {
            if (step.Property == "amount" || step.Property.StartsWith("offset_", StringComparison.Ordinal))
            {
                _hostOnly[step.Property] = _hostOnly.GetValueOrDefault(step.Property) + 1;
                continue;
            }
            if (!Supported(step.Property, schedule.IsNode2D))
            {
                _unsupported[step.Property] = _unsupported.GetValueOrDefault(step.Property) + 1;
                continue;
            }
            var property = step.Property;
            var nodeMaterial = property.StartsWith("material:", StringComparison.Ordinal);
            if (nodeMaterial)
            {
                if (!materialResolved)
                {
                    materialId = _resolveMaterial(schedule.ObjectId);
                    materialResolved = true;
                }
                if (materialId is null)
                {
                    _unsupported[property] = _unsupported.GetValueOrDefault(property) + 1;
                    continue;
                }
                property = property["material:".Length..];
            }
            var values = new Dictionary<string, object>
            {
                ["property"] = property, ["to"] = new RenderStreamTweenEndpoint(step.Kind, step.To),
                ["start_ms"] = step.StartMs, ["duration_ms"] = step.DurationMs,
                ["trans"] = step.Trans, ["ease"] = step.Ease
            };
            if (step.From is not null) values["from"] = new RenderStreamTweenEndpoint(step.Kind, step.From);
            if (nodeMaterial) (materialSteps ??= []).Add(values);
            else (steps ??= []).Add(values);
        }
        if (steps is not null) Announce(schedule, schedule.TweenId, schedule.ObjectId, steps);
        // Producer ids are positive; reserve their negatives for the node's material schedule.
        if (materialSteps is not null) Announce(schedule, -schedule.TweenId, materialId!.Value, materialSteps);
    }

    private void Announce(TweenSchedule schedule, long id, ulong objectId,
        IReadOnlyList<IReadOnlyDictionary<string, object>> steps)
    {
        _capture.TweenBegin(new Dictionary<string, object>
        {
            ["tween_id"] = id, ["object_id"] = objectId,
            ["started_usec"] = schedule.StartedUsec, ["steps"] = steps
        });
        _announced.Add(id);
        _begins++;
        _steps += steps.Count;
    }

    private void End(TweenEnd end)
    {
        Retire(end.TweenId, end.Reason);
        Retire(-end.TweenId, end.Reason);
    }

    private void Retire(long id, TweenEndReason reason)
    {
        if (!_announced.Remove(id)) return;
        // Let lagging clients reach the endpoint on their own schedule after a natural finish.
        if (reason == TweenEndReason.Finished) { _finished++; return; }
        if (reason == TweenEndReason.Retimed) _retimed++;
        _capture.TweenCancel(id);
        _cancels++;
    }

    private static ulong? ResolveMaterial(ulong objectId)
        => GodotObject.InstanceFromId(objectId) is CanvasItem { Material: ShaderMaterial material }
            ? material.GetInstanceId() : null;

    internal static bool Supported(string property, bool node2D) => property switch
    {
        "position" or "position:x" or "position:y"
            or "global_position" or "global_position:x" or "global_position:y"
            or "rotation" or "rotation_degrees"
            or "scale" or "scale:x" or "scale:y"
            or "modulate" or "modulate:r" or "modulate:g" or "modulate:b" or "modulate:a"
            or "self_modulate" or "self_modulate:r" or "self_modulate:g" or "self_modulate:b" or "self_modulate:a" => true,
        "skew" => node2D,
        _ => SupportedShaderParameter(property)
    };

    private static bool SupportedShaderParameter(string property)
    {
        if (property.StartsWith("material:", StringComparison.Ordinal)) property = property["material:".Length..];
        const string prefix = "shader_parameter/";
        if (!property.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var name = property.AsSpan(prefix.Length);
        var colon = name.IndexOf(':');
        if (colon >= 0)
        {
            var component = name[(colon + 1)..];
            if (component.Length != 1 || "xyzwrgba".IndexOf(component[0]) < 0) return false;
            name = name[..colon];
        }
        if (name.IsEmpty || !(char.IsAsciiLetter(name[0]) || name[0] == '_')) return false;
        foreach (var c in name)
            if (!(char.IsAsciiLetterOrDigit(c) || c == '_')) return false;
        return true;
    }
}
