using System.Globalization;
using Godot;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Owns a seat's capture demand. Requests, releases, signals and scheduled callbacks run on the main thread.
/// Capture state is read only on those events; the grace deadline never probes the capture.
/// </summary>
internal sealed class RenderStreamSwap : IDisposable
{
    internal static readonly TimeSpan GracePeriod = TimeSpan.FromSeconds(90);

    private enum Phase { Mirror, Arming, Armed, Disarming }

    private readonly IRenderStreamCapture _capture;
    private readonly Func<TimeSpan, Action, IDisposable> _schedule;
    private readonly Action<bool> _setSuspenderEnabled;
    private readonly Action _requestTrim;
    private readonly Action _onChanged;
    private readonly int _maxWidth;
    private readonly Dictionary<string, double?> _wantingPages = new(StringComparer.Ordinal);
    private Phase _phase;
    private IDisposable? _signals;
    private IDisposable? _grace;
    private int _graceGeneration;
    private bool _disposed;

    internal string[] WantingPages => _wantingPages.Keys.ToArray();

    internal string State { get; private set; } = "mirror";
    internal string? Reason { get; private set; }
    internal RenderStreamSnapshot? Snapshot { get; private set; }

    internal RenderStreamSwap(
        IRenderStreamCapture capture,
        Func<TimeSpan, Action, IDisposable> schedule,
        Action<bool> setSuspenderEnabled,
        Action requestTrim,
        Action onChanged,
        int maxWidth = StreamingSeatLaunch.DefaultMaxPresentationWidth)
    {
        _capture = capture;
        _schedule = schedule;
        _setSuspenderEnabled = setSuspenderEnabled;
        _requestTrim = requestTrim;
        _onChanged = onChanged;
        _maxWidth = maxWidth;
    }

    internal void Request(string pageId, bool wantsStream, double? aspect = null)
    {
        if (_disposed) return;
        if (!wantsStream)
        {
            _wantingPages.Remove(pageId);
            if (_wantingPages.Count == 0 && _phase is Phase.Arming or Phase.Armed) Disarm("mirror");
            else if (_phase == Phase.Mirror) Change("mirror");
            else _onChanged();
            return;
        }

        _wantingPages[pageId] = aspect;
        if (_phase != Phase.Mirror)
        {
            _onChanged();
            return;
        }
        if (!_capture.HasSingleton)
        {
            Change("failed", "no-capture");
            return;
        }

        _signals ??= _capture.Subscribe(new RenderStreamCaptureSignals(
            Armed, Disarmed, ArmFailed, StreamEnded, _ => CancelGrace(), (_, _) => ClientLeft()));
        Arm(aspect);
    }

    internal void Release(string pageId)
    {
        // A page reload must get the same grace as a disconnected stream client.
        if (_wantingPages.Remove(pageId)) _onChanged();
    }

    private void Arm(double? aspect)
    {
        _setSuspenderEnabled(false);
        _phase = Phase.Arming;
        Change("arming");
        var width = StreamingSeatLaunch.PresentationWidth(aspect, _maxWidth);
        var result = _capture.Arm(new Dictionary<string, string>
        {
            ["GRC_ROOT_SIZE"] = $"presentation:{width.ToString(CultureInfo.InvariantCulture)}x1080",
        });
        if (result != 0) ArmFailed($"arm-refused:{result.ToString(CultureInfo.InvariantCulture)}");
    }

    private void Armed(RenderStreamSnapshot snapshot)
    {
        if (_disposed || _phase != Phase.Arming) return;
        _phase = Phase.Armed;
        Snapshot = snapshot;
        Change("armed");
        if (_capture.Clients == 0) StartGrace();
    }

    private void ArmFailed(string reason)
    {
        if (_disposed || _phase != Phase.Arming) return;
        _phase = Phase.Mirror;
        Snapshot = null;
        _setSuspenderEnabled(true);
        Change("failed", reason);
    }

    private void StreamEnded(string reason)
    {
        if (_disposed || _phase is not (Phase.Arming or Phase.Armed)) return;
        _wantingPages.Clear();
        // The capture bounds disarm reasons to 64 characters; keep the full failure for the page.
        Disarm("stream-ended", reason);
    }

    private void Disarm(string reason, string? failure = null)
    {
        CancelGrace();
        _phase = Phase.Disarming;
        Snapshot = null;
        Change(failure is null ? "mirror" : "failed", failure);
        // Publish the mirror fallback before beginning teardown, in this same main-thread turn.
        var result = _capture.Disarm(reason, lingerMs: 1500);
        if (result == 3) Disarmed();
        else if (result is not (0 or 44)) Change("failed", $"disarm-refused:{result.ToString(CultureInfo.InvariantCulture)}");
    }

    private void Disarmed()
    {
        if (_disposed || _phase == Phase.Mirror) return;
        var rearm = _phase == Phase.Disarming && _wantingPages.Count != 0;
        if (!rearm) _wantingPages.Clear();
        CancelGrace();
        _phase = Phase.Mirror;
        Snapshot = null;
        _setSuspenderEnabled(true);
        _requestTrim();
        if (State != "failed") Change("mirror");
        if (rearm) Arm(_wantingPages.First().Value);
    }

    private void ClientLeft()
    {
        if (!_disposed && _phase == Phase.Armed && _capture.Clients == 0) StartGrace();
    }

    private void StartGrace()
    {
        CancelGrace();
        var generation = _graceGeneration;
        _grace = _schedule(GracePeriod, () =>
        {
            if (_disposed || _phase != Phase.Armed || generation != _graceGeneration) return;
            _wantingPages.Clear();
            Disarm("grace");
        });
    }

    private void CancelGrace()
    {
        _graceGeneration++;
        _grace?.Dispose();
        _grace = null;
    }

    private void Change(string state, string? reason = null)
    {
        State = state;
        Reason = reason;
        _onChanged();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        CancelGrace();
        _signals?.Dispose();
    }

    internal static RenderStreamSwap CreateForSeat(Action onChanged) => new(
        new GodotRenderStreamCapture(), ScheduleOnMainThread,
        CouchCoopHeadlessVisualSuspender.SetEnabled, HeadlessMallocTrim.Trim, onChanged,
        StreamingSeatLaunch.ParseMaxPresentationWidth(
            System.Environment.GetEnvironmentVariable(StreamingSeatLaunch.MaxPresentationWidthEnvironmentVariable), out _));

    private static IDisposable ScheduleOnMainThread(TimeSpan delay, Action callback)
    {
        if (Engine.GetMainLoop() is not SceneTree tree) throw new InvalidOperationException("No SceneTree for capture grace.");
        var timer = tree.CreateTimer(delay.TotalSeconds, ignoreTimeScale: true);
        var callable = Callable.From(callback);
        timer.Connect(SceneTreeTimer.SignalName.Timeout, callable, (uint)GodotObject.ConnectFlags.OneShot);
        return new TimerCancellation(timer, callable);
    }

    private sealed class TimerCancellation(SceneTreeTimer timer, Callable callback) : IDisposable
    {
        public void Dispose()
        {
            if (GodotObject.IsInstanceValid(timer) && timer.IsConnected(SceneTreeTimer.SignalName.Timeout, callback))
                timer.Disconnect(SceneTreeTimer.SignalName.Timeout, callback);
        }
    }
}
