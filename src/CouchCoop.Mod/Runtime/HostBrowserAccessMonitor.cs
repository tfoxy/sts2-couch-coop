using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Runtime;

/// <summary>Revokes synchronously on game signals and evaluates permission once on the next frame.</summary>
public sealed class HostBrowserAccessMonitor : IHostBrowserAccess
{
    private readonly object _gate = new();
    private readonly Func<Action, IDisposable?> _subscribe;
    private readonly Func<string> _readReason;
    private readonly Action<Action> _schedule;
    private readonly Action _cancelInjectedInput;
    private HostBrowserAccessState _state = new(false, HostBrowserAccessReasons.Unavailable, 0);
    private IDisposable? _subscription;
    private bool _started;
    private bool _disposed;
    private bool _pending;
    private long _lifetime;
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
            _subscribe = testSource.Subscribe;
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

    internal HostBrowserAccessMonitor(Func<Action, IDisposable?> subscribe, Func<string> readReason,
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
        try { subscription = _subscribe(() => Wake(lifetime)); }
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
        Wake(lifetime);
    }

    private void Wake(long lifetime)
    {
        HostBrowserAccessState next;
        bool cancel;
        bool schedule;
        lock (_gate)
        {
            if (!_started || _lifetime != lifetime) return;
            cancel = _state.Allowed || _cancellationFailed;
            next = _state = new(false, HostBrowserAccessReasons.Transition, _state.Generation + 1);
            schedule = !_pending;
            _pending = true;
        }
        if (cancel)
        {
            CancelInput();
        }
        Publish(next);
        if (!schedule) return;
        try { _schedule(() => Evaluate(lifetime)); }
        catch (Exception exception)
        {
            lock (_gate) { if (_lifetime == lifetime) _pending = false; }
            Report("schedule", exception);
        }
    }

    private void Evaluate(long lifetime)
    {
        long generation;
        bool readable;
        lock (_gate)
        {
            if (!_started || _lifetime != lifetime) return;
            _pending = false;
            generation = _state.Generation;
            readable = _signalsAvailable && !_cancellationFailed;
        }
        var reason = HostBrowserAccessReasons.Unavailable;
        if (readable)
        {
            try { reason = _readReason(); }
            catch (Exception exception) { Report("read", exception); }
        }
        HostBrowserAccessState next;
        lock (_gate)
        {
            // A signal during the read owns the next evaluation. Never publish an old allowance over it.
            if (!_started || _lifetime != lifetime || _state.Generation != generation) return;
            if (_cancellationFailed) reason = HostBrowserAccessReasons.Unavailable;
            next = _state = new(reason == HostBrowserAccessReasons.Allowed, reason, generation);
        }
        Publish(next);
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
            next = _state = new(false, HostBrowserAccessReasons.Unavailable, _state.Generation + 1);
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
            Report("cancel input", exception);
        }
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
        if (!screenAvailable || facts is null) return HostBrowserAccessReasons.Unavailable;
        if (inTransition) return HostBrowserAccessReasons.Transition;
        if (protectedMenuOpen) return HostBrowserAccessReasons.MenuOpen;
        var netType = facts.Value.RunInProgress ? facts.Value.RunNetType : facts.Value.CurrentLobbyNetType;
        return netType is NetTypeNames.Host or NetTypeNames.Client
            ? HostBrowserAccessReasons.Allowed : HostBrowserAccessReasons.MultiplayerRequired;
    }

    private static void Report(string operation, Exception exception)
        => CouchCoopLog.Stderr($"host browser access {operation} failed: {exception.GetType().Name}: {exception.Message}");
}
