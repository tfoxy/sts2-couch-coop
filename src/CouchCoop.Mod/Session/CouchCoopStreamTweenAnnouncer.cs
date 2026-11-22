using Godot;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Session;

/// <summary>Forwards raw schedules while this seat is armed and any stream page requests them.</summary>
public sealed class CouchCoopStreamTweenAnnouncer
{
    private static readonly CouchCoopStreamTweenAnnouncer Shared = new(
        EmbeddableTweenScheduleHub.Shared.Subscribe, new GodotRenderStreamCapture(), CouchCoopLog.Info);
    private readonly Func<Action<TweenSchedule>, Action<long>, IDisposable> _subscribe;
    private readonly IRenderStreamTweenCapture _capture;
    private readonly Action<string> _log;
    private readonly HashSet<long> _announced = [];
    private readonly Dictionary<string, long> _unsupported = new(StringComparer.Ordinal);
    private IDisposable? _subscription;
    private bool _armed;
    private bool _desired;
    private long _begins, _steps, _cancels, _relative, _loops;
    private static volatile bool _pageDesired;

    internal CouchCoopStreamTweenAnnouncer(
        Func<Action<TweenSchedule>, Action<long>, IDisposable> subscribe,
        IRenderStreamTweenCapture capture, Action<string> log)
        => (_subscribe, _capture, _log) = (subscribe, capture, log);

    internal static void SetArmed(bool armed) => Shared.UpdateArmed(armed);

    public static void SetDesired(bool desired)
    {
        if (_pageDesired == desired) return;
        _pageDesired = desired;
        if (CouchCoopMod.EngineAvailable)
            Callable.From(() => Shared.UpdateDesired(_pageDesired)).CallDeferred();
    }

    internal void UpdateArmed(bool armed)
    {
        if (_armed == armed) return;
        _armed = armed;
        Reconcile();
        if (!armed)
        {
            _log($"[stream-tweens] begins={_begins} steps={_steps} cancels={_cancels} "
                + $"relative={_relative} loops={_loops} unsupported="
                + string.Join(",", _unsupported.OrderBy(p => p.Key).Select(p => $"{p.Key}:{p.Value}")));
            _begins = _steps = _cancels = _relative = _loops = 0;
            _unsupported.Clear();
        }
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
            _subscription ??= _subscribe(Begin, Cancel);
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
        List<IReadOnlyDictionary<string, object>>? steps = null;
        foreach (var step in schedule.Steps)
        {
            if (!Supported(step.Property, schedule.IsNode2D))
            {
                _unsupported[step.Property] = _unsupported.GetValueOrDefault(step.Property) + 1;
                continue;
            }
            var values = new Dictionary<string, object>
            {
                ["property"] = step.Property, ["to"] = step.To,
                ["start_ms"] = step.StartMs, ["duration_ms"] = step.DurationMs,
                ["trans"] = step.Trans, ["ease"] = step.Ease
            };
            if (step.From is not null) values["from"] = step.From;
            (steps ??= []).Add(values);
        }
        if (steps is null) return;
        _capture.TweenBegin(new Dictionary<string, object>
        {
            ["tween_id"] = schedule.TweenId, ["object_id"] = schedule.ObjectId,
            ["started_usec"] = schedule.StartedUsec, ["steps"] = steps
        });
        _announced.Add(schedule.TweenId);
        _begins++;
        _steps += steps.Count;
    }

    private void Cancel(long id)
    {
        if (!_armed || !_desired || !_announced.Remove(id)) return;
        _capture.TweenCancel(id);
        _cancels++;
    }

    internal static bool Supported(string property, bool node2D) => property switch
    {
        "position" or "position:x" or "position:y" or "rotation"
            or "scale" or "scale:x" or "scale:y"
            or "modulate" or "modulate:r" or "modulate:g" or "modulate:b" or "modulate:a"
            or "self_modulate" or "self_modulate:r" or "self_modulate:g" or "self_modulate:b" or "self_modulate:a" => true,
        "skew" => node2D,
        _ => false
    };
}
