using System.Diagnostics;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Connections;

/// <summary>Retains connection history through scene transitions and expires it when hosting ends.</summary>
/// <remarks>
/// The state subscription is capability-gated and exists only while a browser or an owned headless seat needs
/// hosting supervision. A detached browser seat still owns a live process and therefore keeps this monitor alive
/// until run-end reaping. With zero demand, neither the 500 ms state capture nor the one-second expiry timer exists.
/// </remarks>
internal sealed class ConnectionHostingTracker : IDisposable
{
    private readonly object _hostingEndGate = new();
    private readonly object _gate = new();
    private readonly CouchCoopRuntimeHost _runtime;
    private readonly HeadlessClientManager? _manager;
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

    public ConnectionHostingTracker(CouchCoopRuntimeHost runtime, HeadlessClientManager? manager)
    {
        _runtime = runtime;
        _manager = manager;
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

    internal void SetBrowserDemand(int count, long generation)
        => SetDemand(count, generation, browser: true);

    internal void SetOwnedSeatDemand(int count, long generation)
        => SetDemand(count, generation, browser: false);

    private void SetDemand(int count, long generation, bool browser)
    {
        // Serialize a new demand generation with the fallback's destructive EndHosting call. The manager publishes
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
        if (_runtime.HasCapability(CouchCoopRuntimeHost.StateCapability))
        {
            try
            {
                subscription = _runtime.SubscribeCurrentState(new CurrentStateSubscriptionRequest(
                    EmitInitial: true,
                    MinCaptureInterval: TimeSpan.FromMilliseconds(500),
                    MaxIdleInterval: TimeSpan.FromSeconds(2)),
                    observed => ObserveState(generation, observed));
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr(
                    $"connection hosting state monitor unavailable: {exception.GetType().Name}: {exception.Message}");
            }
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
            subscription?.Dispose();
            return;
        }

    }

    private void ObserveState(long generation, CurrentStateWatchEvent observed)
    {
        if (observed.State is not { } state)
        {
            return;
        }

        lock (_gate)
        {
            if (_disposed || !HasDemandLocked || _activeGeneration != generation)
            {
                return;
            }

            if (state.CharacterSelect?.Lobby?.NetGameType == "host"
                || state.Run?.Players.Any(player => player.IsHost && player.IsLocal) == true)
            {
                _hasHosted = true;
                _leftAt = null;
            }
            else if (_hasHosted && state.Run is null && state.CharacterSelect is null && state.RootScene == "screens/main_menu")
            {
                _leftAt ??= Stopwatch.GetTimestamp();
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
                if (_leftAt is not { } left || Stopwatch.GetElapsedTime(left) < TimeSpan.FromSeconds(5)) return;
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
