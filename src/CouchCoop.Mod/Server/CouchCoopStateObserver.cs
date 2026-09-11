using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Server;

// Subscribes ONCE to spirectl's live state watcher and caches the latest snapshot, so the browser
// server can broadcast game-state changes to every connected client without each client pulling
// GetCurrentState. The watcher's onEvent fires on a BACKGROUND thread (Task.Run) and is force-refreshed
// after every accepted action, so `Latest` is lock-guarded and `StateChanged` subscribers must be
// thread-safe. When the state capability is unsupported the observer simply never subscribes (no broadcast).
public sealed class CouchCoopStateObserver(IRuntimeStateSource state, ICouchCoopCapabilityPolicy capabilities) : IDisposable
{
    private readonly IRuntimeStateSource _state = state ?? throw new ArgumentNullException(nameof(state));
    private readonly ICouchCoopCapabilityPolicy _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
    private readonly object _gate = new();
    private StateSnapshot? _latest;
    private IDisposable? _subscription;

    // Raised (on a background thread) whenever the live game state changes.
    public event Action<StateSnapshot>? StateChanged;

    public StateSnapshot? Latest
    {
        get
        {
            lock (_gate)
            {
                return _latest;
            }
        }
    }

    public void Start()
    {
        lock (_gate)
        {
            if (_subscription is not null || !_capabilities.HasCapability(CouchCoopRuntimeHost.StateCapability))
            {
                return;
            }

            _subscription = _state.SubscribeCurrentState(
                new CurrentStateSubscriptionRequest(
                    EmitInitial: true,
                    MinCaptureInterval: TimeSpan.FromMilliseconds(50)),
                OnEvent);
        }
    }

    private void OnEvent(CurrentStateWatchEvent watchEvent)
    {
        if (watchEvent.State is null)
        {
            return;
        }

        lock (_gate)
        {
            _latest = watchEvent.State;
        }

        StateChanged?.Invoke(watchEvent.State);
    }

    public void Dispose()
    {
        IDisposable? subscription;
        lock (_gate)
        {
            subscription = _subscription;
            _subscription = null;
        }

        subscription?.Dispose();
    }
}
