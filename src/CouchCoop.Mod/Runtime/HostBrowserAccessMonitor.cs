using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Runtime;

internal enum HostBrowserAccessSignal { Refresh, Transition, ProtectedMenu, Unsafe }

/// <summary>Revokes synchronously at unsafe boundaries; ordinary notifications only refresh deferred facts.</summary>
public sealed class HostBrowserAccessMonitor : IHostBrowserAccess
{
    private readonly object _gate = new();
    private readonly Func<Action<HostBrowserAccessSignal>, IDisposable?> _subscribe;
    private readonly Func<string> _readReason;
    private readonly Action<Action> _schedule;
    private readonly Action _cancelInjectedInput;
    private HostBrowserAccessState _state = new(false, HostBrowserAccessReasons.Unavailable, 0);
    private IDisposable? _subscription;
    private bool _started;
    private bool _disposed;
    private bool _pending;
    private long _lifetime;
    private long _signalVersion;
    private bool _signalsAvailable;
    private bool _cancellationFailed;

    /// <summary>Install lifecycle hooks before a browser can connect; performs no game reads or subscriptions.</summary>
    public static bool Prepare()
    {
        if (!CouchCoopMod.EngineAvailable) return false;
        try { return HostBrowserAccessHooks.Prepare(); }
        catch (Exception exception) { Report("prepare", exception); return false; }
    }

    internal sealed record Source(Func<Action, IDisposable?> Subscribe, Func<string> ReadReason, Action<Action> Schedule);
    internal static Func<Source>? SourceFactoryOverride { get; set; }

    public HostBrowserAccessMonitor(Action cancelInjectedInput)
    {
        if (SourceFactoryOverride is { } factory)
        {
            var testSource = factory();
            _subscribe = signal => testSource.Subscribe(() => signal(HostBrowserAccessSignal.Unsafe));
            _readReason = testSource.ReadReason;
            _schedule = testSource.Schedule;
            _cancelInjectedInput = cancelInjectedInput;
            return;
        }
        var source = new HostBrowserAccessGameSource();
        _subscribe = source.Subscribe;
        _readReason = source.ReadReason;
        _schedule = GameNextFrame.Schedule;
        _cancelInjectedInput = cancelInjectedInput;
    }

    internal HostBrowserAccessMonitor(Func<Action<HostBrowserAccessSignal>, IDisposable?> subscribe, Func<string> readReason,
        Action<Action> schedule, Action cancelInjectedInput)
    {
        _subscribe = subscribe;
        _readReason = readReason;
        _schedule = schedule;
        _cancelInjectedInput = cancelInjectedInput;
    }

    public HostBrowserAccessState State => Volatile.Read(ref _state);
    public event Action<HostBrowserAccessState>? Changed;
    public bool IsAllowed(long generation) => State is { Allowed: true } state && state.Generation == generation;

    public void Start()
    {
        long lifetime;
        lock (_gate)
        {
            if (_started || _disposed) return;
            _started = true;
            lifetime = ++_lifetime;
        }

        IDisposable? subscription = null;
        try { subscription = _subscribe(signal => Wake(lifetime, signal)); }
        catch (Exception exception) { Report("subscribe", exception); }
        lock (_gate)
        {
            if (_started && _lifetime == lifetime)
            {
                _subscription = subscription;
                _signalsAvailable = subscription is not null;
                subscription = null;
            }
        }
        try { subscription?.Dispose(); }
        catch (Exception exception) { Report("detach", exception); }
        Wake(lifetime, HostBrowserAccessSignal.Refresh);
    }

    private void Wake(long lifetime, HostBrowserAccessSignal signal)
    {
        HostBrowserAccessState? next = null;
        bool cancel;
        bool schedule;
        lock (_gate)
        {
            if (!_started || _lifetime != lifetime) return;
            ++_signalVersion;
            cancel = (signal != HostBrowserAccessSignal.Refresh && _state.Allowed) || _cancellationFailed;
            if (signal != HostBrowserAccessSignal.Refresh)
            {
                var hard = signal != HostBrowserAccessSignal.Transition;
                var reason = signal switch
                {
                    HostBrowserAccessSignal.Transition => HostBrowserAccessReasons.Transition,
                    HostBrowserAccessSignal.ProtectedMenu => HostBrowserAccessReasons.MenuOpen,
                    _ => HostBrowserAccessReasons.Unavailable,
                };
                next = _state = new(false, reason, _state.Generation + 1,
                    _state.SceneResetGeneration + (hard ? 1 : 0));
            }
            schedule = !_pending;
            _pending = true;
        }
        if (cancel) CancelInput();
        if (next is not null) Publish(State);
        if (!schedule) return;
        try { _schedule(() => Evaluate(lifetime)); }
        catch (Exception exception)
        {
            lock (_gate) { if (_lifetime == lifetime) _pending = false; }
            // Without a deferred read, even an ordinary refresh can no longer establish permission.
            var cancelOnFailure = State.Allowed;
            DenyUnavailable();
            if (cancelOnFailure) CancelInput();
            Report("schedule", exception);
        }
    }

    private void Evaluate(long lifetime)
    {
        long version;
        bool readable;
        lock (_gate)
        {
            if (!_started || _lifetime != lifetime) return;
            _pending = false;
            version = _signalVersion;
            readable = _signalsAvailable && !_cancellationFailed;
        }
        var reason = HostBrowserAccessReasons.Unavailable;
        if (readable)
        {
            try { reason = _readReason(); }
            catch (Exception exception) { Report("read", exception); }
        }
        HostBrowserAccessState next;
        bool cancel;
        lock (_gate)
        {
            // A signal during the read owns the next evaluation. Never publish an old allowance over it.
            if (!_started || _lifetime != lifetime || _signalVersion != version) return;
            if (_cancellationFailed) reason = HostBrowserAccessReasons.Unavailable;
            var allowed = reason == HostBrowserAccessReasons.Allowed;
            if (_state.Allowed == allowed && _state.Reason == reason) return;
            cancel = !allowed && _state.Allowed;
            var hard = !allowed && reason != HostBrowserAccessReasons.Transition;
            next = _state = new(allowed, reason, _state.Generation + 1,
                _state.SceneResetGeneration + (hard ? 1 : 0));
        }
        if (cancel) CancelInput();
        Publish(State);
    }

    public void Stop()
    {
        IDisposable? subscription;
        HostBrowserAccessState next;
        bool cancel;
        lock (_gate)
        {
            if (!_started) return;
            _started = false;
            ++_lifetime;
            _pending = false;
            _signalsAvailable = false;
            subscription = _subscription;
            _subscription = null;
            cancel = _state.Allowed || _cancellationFailed;
            next = _state = new(false, HostBrowserAccessReasons.Unavailable, _state.Generation + 1, _state.SceneResetGeneration + 1);
        }
        try { subscription?.Dispose(); }
        catch (Exception exception) { Report("detach", exception); }
        if (cancel)
        {
            CancelInput();
        }
        Publish(next);
    }

    public void Dispose()
    {
        lock (_gate) _disposed = true;
        Stop();
    }

    private void CancelInput()
    {
        try
        {
            _cancelInjectedInput();
            lock (_gate) _cancellationFailed = false;
        }
        catch (Exception exception)
        {
            lock (_gate) _cancellationFailed = true;
            DenyUnavailable();
            Report("cancel input", exception);
        }
    }

    private void DenyUnavailable()
    {
        HostBrowserAccessState next;
        lock (_gate)
            next = _state = new(false, HostBrowserAccessReasons.Unavailable,
                _state.Generation + 1, _state.SceneResetGeneration + 1);
        Publish(next);
    }

    private void Publish(HostBrowserAccessState state)
    {
        // An observer may trigger another signal. Do not deliver a stale grant to later listeners.
        foreach (var handler in Changed?.GetInvocationList() ?? [])
        {
            if (!ReferenceEquals(State, state)) return;
            try { ((Action<HostBrowserAccessState>)handler)(state); }
            catch (Exception exception) { Report("notify", exception); }
        }
    }

    internal static string Decide(GateFacts? facts, bool screenAvailable, bool inTransition, bool protectedMenuOpen)
    {
        if (protectedMenuOpen) return HostBrowserAccessReasons.MenuOpen;
        if (inTransition) return HostBrowserAccessReasons.Transition;
        if (!screenAvailable || facts is null) return HostBrowserAccessReasons.Unavailable;
        var netType = facts.Value.RunInProgress ? facts.Value.RunNetType : facts.Value.CurrentLobbyNetType;
        return netType is NetTypeNames.Host or NetTypeNames.Client
            ? HostBrowserAccessReasons.Allowed : HostBrowserAccessReasons.MultiplayerRequired;
    }

    private static void Report(string operation, Exception exception)
        => CouchCoopLog.Stderr($"host browser access {operation} failed: {exception.GetType().Name}: {exception.Message}");
}
