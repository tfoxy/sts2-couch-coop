using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Godot;
using Timer = System.Threading.Timer;

namespace CouchCoop.Mod.Connections;

/// <summary>Retains connection history through scene transitions and expires it when hosting ends.</summary>
/// <remarks>
/// While monitoring, the tracker is driven by the game's own "the active screen may have changed" event
/// (<see cref="GameScreenContext.SubscribeUpdated"/>) rather than a poll: a hosting session's end is a screen
/// transition (back to the menu), so there is nothing to catch between two screen-changed events. It exists only
/// while a browser or an owned headless seat needs hosting supervision. A detached browser seat still owns a live
/// process and therefore keeps this monitor alive until run-end reaping. With zero demand, neither the
/// subscription nor the one-second expiry timer exists.
/// <para>
/// There is deliberately no backstop for a game build whose screen event cannot be resolved: the tracker then
/// logs that once and does nothing, and hosting ends only through the transport's own end signal
/// (<see cref="CouchCoopHostTransport.HostingEnded"/>). Polling game state to cover that case is what this class
/// used to do, and it is the recurring full-state read the empty-host dormancy rule exists to prevent.
/// </para>
/// </remarks>
internal sealed class ConnectionHostingTracker : IDisposable
{
    private readonly object _hostingEndGate = new();
    private readonly object _gate = new();
    private readonly HeadlessClientManager? _manager;
    private readonly IHostingSessionFacts _facts;
    private readonly Func<Action, IDisposable?> _subscribeScreenChanged;
    private readonly Action<Action> _scheduleEvaluation;
    private readonly TimeProvider _time;
    private IDisposable? _subscription;
    private Timer? _timer;
    private int _browserDemand;
    private int _ownedSeatDemand;
    private long _browserDemandGeneration = -1;
    private long _ownedSeatDemandGeneration = -1;
    private long _activeGeneration;
    private bool _disposed;
    private bool _hasHosted;
    private long? _leftAt;
    // Same log-once idiom as CouchCoopHostTransport's _peerReadFailureLogged, so a process that never resolves the
    // game's screen event says so a single time rather than once per monitoring start.
    private static int _triggerUnavailableLogged;

    public ConnectionHostingTracker(HeadlessClientManager? manager)
        : this(manager, new HostingSessionFacts(), SubscribeGameScreenUpdated,
               ScheduleOnNextFrame, TimeProvider.System)
    {
    }

    /// <summary>
    /// The game's screen event through CouchCoop's own front, which returns null outside a running game process
    /// (the raw seam can reach an uninitialized engine there and crash uncatchably) and reports any use at zero
    /// demand to the zero-client tripwire.
    /// </summary>
    private static IDisposable? SubscribeGameScreenUpdated(Action handler)
        => GameScreenContext.SubscribeUpdated(handler);

    internal ConnectionHostingTracker(
        HeadlessClientManager? manager, IHostingSessionFacts facts,
        Func<Action, IDisposable?> subscribeScreenChanged, Action<Action> scheduleEvaluation, TimeProvider time)
    {
        _manager = manager;
        _facts = facts;
        _subscribeScreenChanged = subscribeScreenChanged;
        _scheduleEvaluation = scheduleEvaluation;
        _time = time;
        CouchCoopHostTransport.HostingEnded += OnNativeHostingEnded;
    }

    internal bool IsMonitoring
    {
        get
        {
            lock (_gate)
            {
                return _subscription is not null || _timer is not null;
            }
        }
    }

    /// <summary>
    /// Test-only hook: runs the same expiry check the real 1s <see cref="Timer"/> calls, without waiting for it.
    /// The timer's cadence isn't what tests need to control — only <c>_leftAt</c> age, which the injected
    /// <see cref="TimeProvider"/> already makes deterministic.
    /// </summary>
    internal void TickForTests() => Tick(_activeGeneration);

    internal void SetBrowserDemand(int count, long generation)
        => SetDemand(count, generation, browser: true);

    internal void SetOwnedSeatDemand(int count, long generation)
        => SetDemand(count, generation, browser: false);

    private void SetDemand(int count, long generation, bool browser)
    {
        // Serialize a new demand generation with the expiry tick's destructive EndHosting call. The manager publishes
        // its resulting seat-count changes asynchronously, so this ordering cannot re-enter us through its lock.
        lock (_hostingEndGate)
        {
            SetDemandCore(count, generation, browser);
        }
    }

    private void SetDemandCore(int count, long generation, bool browser)
    {
        long startGeneration = 0;
        IDisposable? stopSubscription = null;
        Timer? stopTimer = null;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            ref long knownGeneration = ref (browser ? ref _browserDemandGeneration : ref _ownedSeatDemandGeneration);
            if (generation < knownGeneration)
            {
                return;
            }

            knownGeneration = generation;
            var hadDemand = HasDemandLocked;
            if (browser)
            {
                _browserDemand = Math.Max(0, count);
            }
            else
            {
                _ownedSeatDemand = Math.Max(0, count);
            }

            if (hadDemand == HasDemandLocked)
            {
                return;
            }

            var lifecycleGeneration = ++_activeGeneration;
            if (HasDemandLocked)
            {
                startGeneration = lifecycleGeneration;
            }
            else
            {
                stopSubscription = _subscription;
                stopTimer = _timer;
                _subscription = null;
                _timer = null;
                _leftAt = null;
            }
        }

        stopTimer?.Dispose();
        stopSubscription?.Dispose();
        if (startGeneration != 0)
        {
            StartMonitoring(startGeneration);
        }
    }

    private bool HasDemandLocked => _browserDemand > 0 || _ownedSeatDemand > 0;

    private void StartMonitoring(long generation)
    {
        IDisposable? subscription = null;
        try
        {
            subscription = _subscribeScreenChanged(() => ScheduleEvaluation(generation));
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"connection hosting screen trigger failed: {exception.GetType().Name}: {exception.Message}");
        }

        if (subscription is null)
        {
            // Nothing can arm the expiry countdown without the trigger, so there is nothing for a timer to do either.
            if (Interlocked.Exchange(ref _triggerUnavailableLogged, 1) == 0)
            {
                CouchCoopLog.Stderr(
                    "connection hosting screen trigger unavailable: hosting will end only on the transport's own signal");
            }

            return;
        }

        var timer = new Timer(_ => Tick(generation), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        timer.Change(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));

        var keep = false;
        lock (_gate)
        {
            if (!_disposed && HasDemandLocked && _activeGeneration == generation)
            {
                _subscription = subscription;
                _timer = timer;
                keep = true;
            }
        }

        if (!keep)
        {
            timer.Dispose();
            subscription.Dispose();
            return;
        }

        ScheduleEvaluation(generation); // once at start, deferred a frame like every other evaluation
    }

    private void ScheduleEvaluation(long generation)
    {
        try
        {
            _scheduleEvaluation(() => EvaluateFacts(generation));
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"connection hosting evaluation scheduling failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// Defers <paramref name="evaluate"/> by one processed frame on the game thread.
    /// </summary>
    /// <remarks>
    /// Reading the active screen synchronously inside the game's screen-transition callback is unsafe — see
    /// <see cref="HostUi.CouchCoopQrHostPanelController.IsAnyLobbyScreenCurrent"/>'s remarks for the incident that
    /// requires this — so every evaluation waits for the next frame boundary before touching that seam, exactly
    /// like <c>CouchCoopQrHostPanelController.ScheduleScan</c>. With no valid <see cref="SceneTree"/> root
    /// (a test host, or a torn-down engine), there is no frame to wait for, so it runs inline instead of dropping
    /// the evaluation.
    /// </remarks>
    private static void ScheduleOnNextFrame(Action evaluate)
        => GameMainThread.Invoke(() =>
        {
            if (Engine.GetMainLoop() is SceneTree { Root: { } root } && GodotObject.IsInstanceValid(root))
            {
                root.GetTree().CreateTimer(0, processAlways: true, ignoreTimeScale: true).Timeout += evaluate;
            }
            else
            {
                evaluate();
            }
            return true; // Invoke<T> requires a return value.
        });

    /// <summary>
    /// Reads the three cheap hosting facts and applies the latch/countdown rule: hosting latches once a net host is
    /// installed and the game is in a run or on a lobby screen, and the expiry countdown starts when it is in
    /// neither. Facts are read OUTSIDE <see cref="_gate"/> — they touch live game objects — and only their result is
    /// applied under the lock.
    /// </summary>
    private void EvaluateFacts(long generation)
    {
        bool hostActive, inRun, onLobbyScreen;
        try
        {
            hostActive = _facts.IsHostActive();
            inRun = _facts.IsRunInProgress();
            onLobbyScreen = _facts.IsOnLobbyScreen();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"connection hosting fact read failed: {exception.GetType().Name}: {exception.Message}");
            return;
        }

        lock (_gate)
        {
            if (_disposed || !HasDemandLocked || _activeGeneration != generation)
            {
                return;
            }

            if (hostActive && (inRun || onLobbyScreen))
            {
                _hasHosted = true;
                _leftAt = null;
            }
            else if (_hasHosted && !inRun && !onLobbyScreen)
            {
                _leftAt ??= _time.GetTimestamp();
            }
        }
    }

    private void Tick(long generation)
    {
        lock (_hostingEndGate)
        {
            lock (_gate)
            {
                if (_disposed || !HasDemandLocked || _activeGeneration != generation)
                {
                    return;
                }
                // Allow loading transitions to replace the lobby with a run before expiring any evidence.
                if (_leftAt is not { } left || _time.GetElapsedTime(left) < TimeSpan.FromSeconds(5)) return;
                _leftAt = null;
                _hasHosted = false;
            }

            _manager?.EndHosting();
            ConnectionRegistry.Shared.HostingEnded();
        }
    }

    private void OnNativeHostingEnded()
    {
        lock (_hostingEndGate)
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }
                _leftAt = null;
                _hasHosted = false;
            }

            _manager?.EndHosting();
            ConnectionRegistry.Shared.HostingEnded();
        }
    }

    public void Dispose()
    {
        IDisposable? subscription;
        Timer? timer;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            _activeGeneration++;
            subscription = _subscription;
            timer = _timer;
            _subscription = null;
            _timer = null;
        }

        CouchCoopHostTransport.HostingEnded -= OnNativeHostingEnded;
        timer?.Dispose();
        subscription?.Dispose();
    }
}
