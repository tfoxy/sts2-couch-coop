using System.Globalization;
using Godot;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Owns a seat's capture demand. Requests, releases, signals and scheduled callbacks run on the main thread.
/// Capture state is read only on those events; the grace deadline never probes the capture.
/// </summary>
internal sealed class RenderStreamSwap : IDisposable
{
    internal const int MaxRetainedPages = 128;
    internal static readonly TimeSpan GracePeriod = TimeSpan.FromSeconds(90);

    private enum Phase { Mirror, Arming, Armed, Disarming }

    private readonly IRenderStreamCapture _capture;
    private readonly Func<TimeSpan, Action, IDisposable> _schedule;
    private readonly Action<bool> _setSuspenderEnabled;
    private readonly Action<bool> _setStreamSpinesArmed;
    private readonly Action _requestTrim;
    private readonly Action _onChanged;
    private readonly Action<int> _setPresentationWidth;
    private readonly Func<int, bool>? _trySetPresentationWidth;
    private Action? _unsubscribeViewport;
    private readonly Action<Action> _deferSignal;
    private readonly Action<Action> _deferPresentation;
    private readonly int _maxWidth;
    private sealed record Page(bool Stream, bool Watch, double? Aspect, long Order, bool Connected = true, long ReleasedOrder = 0);
    private long _requestOrder;
    private long _releaseOrder;
    private readonly Dictionary<string, Page> _pages = new(StringComparer.Ordinal);
    private bool _dormant;
    private int _armedWidth = 1920;
    private long _presentationRevision;
    internal long PresentationEpoch { get; private set; }
    internal bool PresentationReady { get; private set; } = true;
    internal int PresentationWidth { get; private set; } = 1920;
    private Phase _phase;
    private IDisposable? _signals;
    private IDisposable? _grace;
    private int _graceGeneration;
    private int _armGeneration;
    private bool _disposed;

    internal string[] WantingPages => _pages.Where(p => p.Value.Stream && p.Value.Connected).Select(p => p.Key).ToArray();

    internal bool MirrorRestoreComplete { get; private set; } = true;
    internal string State { get; private set; } = "mirror";
    internal string? Reason { get; private set; }
    internal RenderStreamSnapshot? Snapshot { get; private set; }

    internal RenderStreamSwap(
        IRenderStreamCapture capture,
        Func<TimeSpan, Action, IDisposable> schedule,
        Action<bool> setSuspenderEnabled,
        Action requestTrim,
        Action onChanged,
        Action<int> setPresentationWidth,
        int maxWidth = StreamingSeatLaunch.DefaultMaxPresentationWidth,
        Action<Action>? deferSignal = null, Action<Action>? deferPresentation = null, Func<int, bool>? trySetPresentationWidth = null,
        Action<bool>? setStreamSpinesArmed = null)
    {
        _capture = capture;
        _schedule = schedule;
        _setSuspenderEnabled = setSuspenderEnabled;
        _setStreamSpinesArmed = setStreamSpinesArmed ?? (_ => { });
        _requestTrim = requestTrim;
        _onChanged = onChanged;
        _setPresentationWidth = setPresentationWidth;
        _deferSignal = deferSignal ?? (callback => callback());
        _deferPresentation = deferPresentation ?? (callback => callback());
        _trySetPresentationWidth = trySetPresentationWidth;
        _maxWidth = maxWidth;
    }

    internal void Request(string pageId, bool wantsStream, double? aspect = null)
        => UpdatePage(pageId, wantsStream, true, aspect, explicitRequest: true);

    internal void UpdatePage(string pageId, bool wantsStream, bool watching, double? aspect, bool explicitRequest = false)
    {
        if (_disposed) return;
        _pages.TryGetValue(pageId, out var prior);
        var order = wantsStream && prior?.Stream != true ? ++_requestOrder : prior?.Order ?? 0;
        _pages[pageId] = new(wantsStream, watching, aspect, order);
        if (explicitRequest || watching) _dormant = false;
        Recompute(explicitMirror: explicitRequest && !wantsStream);
    }

    internal void Release(string pageId)
    {
        if (_disposed) return;
        if (_pages.TryGetValue(pageId, out var page))
        {
            _pages[pageId] = page with { Connected = false, Watch = false, ReleasedOrder = ++_releaseOrder };
            var retired = _pages.Where(p => !p.Value.Connected).OrderByDescending(p => p.Value.ReleasedOrder)
                .Skip(MaxRetainedPages).Select(p => p.Key).ToArray();
            foreach (var id in retired) _pages.Remove(id);
        }
        Recompute();
    }

    private bool HasStream => _pages.Values.Any(p => p.Stream && p.Connected);
    private int TargetWidth => _pages.Values.Any(p => !p.Stream && p.Watch && p.Connected)
        ? 1920 : StreamingSeatLaunch.PresentationWidth(_pages.Values.OrderBy(p => p.Order).FirstOrDefault(p => p.Stream && p.Connected)?.Aspect, _maxWidth);

    private void Recompute(bool explicitMirror = false)
    {
        if (_phase == Phase.Disarming) { _onChanged(); return; }
        if (_phase is Phase.Arming or Phase.Armed)
        {
            if (!HasStream && !_pages.Values.Any(p => !p.Stream && p.Watch && p.Connected) && !explicitMirror) { _onChanged(); return; }
            if (TargetWidth != _armedWidth || (explicitMirror && !HasStream)) Disarm("mirror");
            else _onChanged();
            return;
        }
        if (!HasStream || _dormant) { Change(State == "failed" && !explicitMirror ? "failed" : "mirror", explicitMirror ? null : Reason); return; }
        if (!_capture.HasSingleton) { Change("failed", "no-capture"); return; }
        _signals ??= _capture.Subscribe(new RenderStreamCaptureSignals(
            Armed, () => DeferSignal(Disarmed), reason => DeferSignal(() => ArmFailed(reason)),
            StreamEnded, _ => CancelGrace(), (_, _) => ClientLeft()));
        Arm();
    }

    private void BeginTransition()
    {
        PresentationEpoch++;
        _presentationRevision++;
        PresentationReady = false;
        MirrorRestoreComplete = false;
        _onChanged();
    }

    private bool ApplyPresentation(int width)
    {
        if (_trySetPresentationWidth is { } apply) return apply(width);
        _setPresentationWidth(width);
        return true;
    }

    private void InvalidatePresentation()
    {
        if (_disposed) return;
        if (PresentationReady) BeginTransition();
        else _presentationRevision++;
    }

    private void ReassertedPresentation(bool success)
    {
        if (_disposed || _phase == Phase.Disarming) return;
        if (success) Settle(PresentationWidth);
        else
        {
            InvalidatePresentation();
            Change("failed", "presentation-unavailable");
        }
    }

    private void Settle(int width)
    {
        PresentationWidth = width;
        var epoch = PresentationEpoch;
        var revision = ++_presentationRevision;
        _deferPresentation(() =>
        {
            if (_disposed || epoch != PresentationEpoch || revision != _presentationRevision
                || PresentationWidth != width || _phase == Phase.Disarming) return;
            PresentationReady = true;
            MirrorRestoreComplete = width == 1920;
            _onChanged();
        });
    }

    private void Arm()
    {
        _armGeneration++;
        if (PresentationReady) BeginTransition();
        _setSuspenderEnabled(false);
        _phase = Phase.Arming;
        Change("arming");
        _armedWidth = TargetWidth;
        if (!ApplyPresentation(_armedWidth))
        {
            ArmFailed("presentation-unavailable");
            return;
        }
        Settle(_armedWidth);
        var result = _capture.Arm(new Dictionary<string, string>
        {
            ["GRC_ROOT_SIZE"] = $"presentation:{_armedWidth.ToString(CultureInfo.InvariantCulture)}x1080",
        });
        if (result != 0) ArmFailed($"arm-refused:{result.ToString(CultureInfo.InvariantCulture)}");
    }

    private void Armed(RenderStreamSnapshot snapshot)
    {
        if (_disposed || _phase != Phase.Arming) return;
        _phase = Phase.Armed;
        _setStreamSpinesArmed(true);
        Snapshot = snapshot;
        Change("armed");
        if (_capture.Clients == 0) StartGrace();
    }

    private void ArmFailed(string reason)
    {
        if (_disposed || _phase != Phase.Arming) return;
        BeginTransition();
        _setStreamSpinesArmed(false);
        _phase = Phase.Mirror;
        Snapshot = null;
        var restored = ApplyPresentation(StreamingSeatLaunch.PresentationBaseWidth);
        if (restored) _setSuspenderEnabled(true);
        if (restored) Settle(1920);
        _dormant = true;
        Change("failed", reason);
    }

    private void StreamEnded(string reason)
    {
        if (_disposed || _phase is not (Phase.Arming or Phase.Armed)) return;
        _dormant = true;
        // The capture bounds disarm reasons to 64 characters; keep the full failure for the page.
        Disarm("stream-ended", reason);
    }

    private void Disarm(string reason, string? failure = null)
    {
        CancelGrace();
        BeginTransition();
        _setStreamSpinesArmed(false);
        _phase = Phase.Disarming;
        Snapshot = null;
        Change(failure is null ? "disarming" : "failed", failure);
        // Publish the mirror fallback before beginning teardown, in this same main-thread turn.
        var result = _capture.Disarm(reason, lingerMs: 1500);
        if (result == 3) Disarmed();
        else if (result is not (0 or 44))
        {
            Change("failed", $"disarm-refused:{result.ToString(CultureInfo.InvariantCulture)}");
        }
    }

    private void Disarmed()
    {
        if (_disposed || _phase == Phase.Mirror) return;
        var rearm = _phase == Phase.Disarming && HasStream && !_dormant;
        CancelGrace();
        _setStreamSpinesArmed(false);
        _phase = Phase.Mirror;
        Snapshot = null;
        var restored = ApplyPresentation(StreamingSeatLaunch.PresentationBaseWidth);
        if (restored) _setSuspenderEnabled(true);
        if (restored) Settle(1920);
        _requestTrim();
        if (State != "failed") Change("mirror");
        else _onChanged();
        if (rearm) Arm();
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
            _dormant = true;
            Disarm("grace");
        });
    }

    private void CancelGrace()
    {
        _graceGeneration++;
        _grace?.Dispose();
        _grace = null;
    }

    private void DeferSignal(Action callback)
    {
        var generation = _armGeneration;
        _deferSignal(() =>
        {
            if (!_disposed && generation == _armGeneration) callback();
        });
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
        _setStreamSpinesArmed(false);
        CancelGrace();
        _signals?.Dispose();
        _unsubscribeViewport?.Invoke();
    }

    internal static RenderStreamSwap CreateForSeat(Action onChanged)
    {
        if (Engine.GetMainLoop() is not SceneTree tree) throw new InvalidOperationException("No SceneTree for capture swap.");
        void Defer(Action callback) => tree.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(callback), (uint)GodotObject.ConnectFlags.OneShot);
        var swap = new RenderStreamSwap(
            new GodotRenderStreamCapture(), ScheduleOnMainThread,
            CouchCoopHeadlessVisualSuspender.SetEnabled, HeadlessMallocTrim.Trim, onChanged,
            HeadlessViewportConfigurator.SetStreamPresentationWidth,
            StreamingSeatLaunch.ParseMaxPresentationWidth(
                System.Environment.GetEnvironmentVariable(StreamingSeatLaunch.MaxPresentationWidthEnvironmentVariable), out _),
            // Restore outside the capture signal, before resuming the mirror's visual suspender.
            deferSignal: Defer, deferPresentation: Defer,
            trySetPresentationWidth: HeadlessViewportConfigurator.TrySetStreamPresentationWidth,
            setStreamSpinesArmed: armed =>
            {
                CouchCoopStreamSpineStills.SetArmed(armed);
                CouchCoopStreamStaticParticles.SetArmed(armed);
            });
        HeadlessViewportConfigurator.PresentationInvalidated += swap.InvalidatePresentation;
        HeadlessViewportConfigurator.PresentationReasserted += swap.ReassertedPresentation;
        swap._unsubscribeViewport = () =>
        {
            HeadlessViewportConfigurator.PresentationInvalidated -= swap.InvalidatePresentation;
            HeadlessViewportConfigurator.PresentationReasserted -= swap.ReassertedPresentation;
        };
        return swap;
    }

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
