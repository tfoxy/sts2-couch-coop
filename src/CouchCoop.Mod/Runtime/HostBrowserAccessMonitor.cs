using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Runtime;

internal enum HostBrowserAccessSignal { Refresh, Transition, ProtectedMenu, Unsafe }

internal readonly record struct HostBrowserAccessFacts(GateFacts? Gates, bool ScreenAvailable,
    bool InTransition, bool ProtectedMenuOpen, bool MainMenuOpen = false);

/// <summary>Revokes synchronously at unsafe boundaries; ordinary notifications only refresh deferred facts.</summary>
public sealed class HostBrowserAccessMonitor : IHostBrowserAccess
{
    private readonly object _gate = new();
    private readonly Func<Action<HostBrowserAccessSignal>, IDisposable?> _subscribe;
    private readonly Func<HostBrowserAccessFacts> _readFacts;
    private readonly Func<CouchPlayMode> _readMode;
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
    private bool _lastAllowedSolo;

    /// <summary>Install lifecycle hooks before a browser can connect; performs no game reads or subscriptions.</summary>
    public static bool Prepare()
    {
        if (!CouchCoopMod.EngineAvailable) return false;
        try { return HostBrowserAccessHooks.Prepare(); }
        catch (Exception exception) { Report("prepare", exception); return false; }
    }

    internal sealed record Source(Func<Action, IDisposable?> Subscribe, Func<HostBrowserAccessFacts> ReadFacts,
        Action<Action> Schedule, Func<CouchPlayMode>? ReadMode = null);
    internal static Func<Source>? SourceFactoryOverride { get; set; }

    public HostBrowserAccessMonitor(Action cancelInjectedInput)
    {
        _readMode = () => CouchPlayModeStore.Current;
        if (SourceFactoryOverride is { } factory)
        {
            var testSource = factory();
            _subscribe = signal => testSource.Subscribe(() => signal(HostBrowserAccessSignal.Unsafe));
            _readFacts = testSource.ReadFacts;
            _readMode = testSource.ReadMode ?? _readMode;
            _schedule = testSource.Schedule;
            _cancelInjectedInput = cancelInjectedInput;
            return;
        }
        var source = new HostBrowserAccessGameSource();
        _subscribe = source.Subscribe;
        _readFacts = source.ReadFacts;
        _schedule = GameNextFrame.Schedule;
        _cancelInjectedInput = cancelInjectedInput;
    }

    internal HostBrowserAccessMonitor(Func<Action<HostBrowserAccessSignal>, IDisposable?> subscribe, Func<HostBrowserAccessFacts> readFacts,
        Action<Action> schedule, Action cancelInjectedInput, Func<CouchPlayMode>? readMode = null)
    {
        _subscribe = subscribe;
        _readFacts = readFacts;
        _readMode = readMode ?? (() => CouchPlayModeStore.Current);
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

        ModeSubscription? subscription = null;
        try
        {
            Action<CouchPlayMode> changed = _ => Wake(lifetime, HostBrowserAccessSignal.Refresh);
            CouchPlayModeStore.Changed += changed;
            try { subscription = new ModeSubscription(_subscribe(signal => Wake(lifetime, signal)), changed); }
            catch { CouchPlayModeStore.Changed -= changed; throw; }
        }
        catch (Exception exception) { Report("subscribe", exception); }
        lock (_gate)
        {
            if (_started && _lifetime == lifetime)
            {
                _subscription = subscription;
                _signalsAvailable = subscription?.SignalsAvailable == true;
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
            // Solo navigation preserves access only after an allowed solo evaluation; every-screen
            // navigation can always refresh. Other menu/unknown boundaries still revoke immediately.
            if (signal is HostBrowserAccessSignal.ProtectedMenu or HostBrowserAccessSignal.Unsafe)
            {
                var mode = _readMode();
                if (mode == CouchPlayMode.EveryScreen
                    || (mode == CouchPlayMode.SoloScreens && _state.Allowed && _lastAllowedSolo))
                    signal = HostBrowserAccessSignal.Refresh;
            }
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
        HostBrowserAccessFacts facts = default;
        if (readable)
        {
            try
            {
                facts = _readFacts();
                reason = Decide(facts, _readMode());
            }
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
            _lastAllowedSolo = allowed && !facts.MainMenuOpen && IsSolo(facts.Gates);
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
            _lastAllowedSolo = false;
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

    private sealed class ModeSubscription(IDisposable? signals, Action<CouchPlayMode> changed) : IDisposable
    {
        internal bool SignalsAvailable => signals is not null;
        public void Dispose()
        {
            CouchPlayModeStore.Changed -= changed;
            signals?.Dispose();
        }
    }

    internal static string Decide(HostBrowserAccessFacts facts, CouchPlayMode mode)
    {
        if (facts.InTransition) return HostBrowserAccessReasons.Transition;
        if (!facts.ScreenAvailable || facts.Gates is null) return HostBrowserAccessReasons.Unavailable;
        if (mode == CouchPlayMode.EveryScreen) return HostBrowserAccessReasons.Allowed;
        // Screen identity wins over run facts that have not caught up to a return to the main menu.
        if (facts.MainMenuOpen) return HostBrowserAccessReasons.MultiplayerRequired;
        if (IsSolo(facts.Gates))
            return mode == CouchPlayMode.SoloScreens ? HostBrowserAccessReasons.Allowed : HostBrowserAccessReasons.CouchPlayOff;
        var gates = facts.Gates.Value;
        var netType = gates.RunInProgress ? gates.RunNetType : gates.CurrentLobbyNetType;
        if (netType is not (NetTypeNames.Host or NetTypeNames.Client)) return HostBrowserAccessReasons.MultiplayerRequired;
        return facts.ProtectedMenuOpen ? HostBrowserAccessReasons.MenuOpen : HostBrowserAccessReasons.Allowed;
    }

    private static bool IsSolo(GateFacts? facts)
        => facts is { } gates && (gates.RunInProgress ? gates.RunNetType : gates.CurrentLobbyNetType) == NetTypeNames.Singleplayer;

    private static void Report(string operation, Exception exception)
        => CouchCoopLog.Stderr($"host browser access {operation} failed: {exception.GetType().Name}: {exception.Message}");
}
