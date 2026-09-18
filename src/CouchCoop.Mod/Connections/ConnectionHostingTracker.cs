using System.Diagnostics;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Connections;

/// <summary>Retains connection history through scene transitions and expires it when hosting ends.</summary>
/// <remarks>
/// The state subscription is GATED on the capability rather than demanded, like every other subscriber in the
/// mod (<see cref="Server.CouchCoopStateObserver"/>, <see cref="Server.CouchCoopSceneObserver"/>,
/// <see cref="Server.CouchCoopAnimationHintCollector"/>). This one is constructed by
/// <see cref="Server.HotReloadableBrowserServerHost"/>'s constructor, so demanding it meant a runtime that does
/// not report `state` took down the whole browser server — and with it the host UI's listener — at startup,
/// rather than costing only the connection-history expiry this type performs. Keeping stale rows on screen is a
/// far smaller failure than having no server to show them on.
/// </remarks>
internal sealed class ConnectionHostingTracker : IDisposable
{
    private readonly object _gate = new();
    private readonly IDisposable? _subscription;
    private readonly Timer _timer;
    private readonly HeadlessClientManager? _manager;
    private bool _hasHosted;
    private long? _leftAt;

    public ConnectionHostingTracker(CouchCoopRuntimeHost runtime, HeadlessClientManager? manager)
    {
        _manager = manager;
        if (runtime.HasCapability(CouchCoopRuntimeHost.StateCapability))
        {
            _subscription = runtime.SubscribeCurrentState(new CurrentStateSubscriptionRequest(
                EmitInitial: true, MinCaptureInterval: TimeSpan.FromMilliseconds(500), MaxIdleInterval: TimeSpan.FromSeconds(2)), observed =>
            {
                if (observed.State is not { } state) return;
                lock (_gate)
                {
                    if (state.CharacterSelect?.Lobby?.NetGameType == "host" || state.Run?.Players.Any(player => player.IsHost && player.IsLocal) == true)
                    {
                        _hasHosted = true;
                        _leftAt = null;
                    }
                    else if (_hasHosted && state.Run is null && state.CharacterSelect is null && state.RootScene == "screens/main_menu")
                        _leftAt ??= Stopwatch.GetTimestamp();
                }
            });
        }

        _timer = new Timer(_ => Tick(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    }

    private void Tick()
    {
        lock (_gate)
        {
            // Allow loading transitions to replace the lobby with a run before expiring any evidence.
            if (_leftAt is not { } left || Stopwatch.GetElapsedTime(left) < TimeSpan.FromSeconds(5)) return;
            _leftAt = null;
            _hasHosted = false;
        }
        _manager?.EndHosting();
        ConnectionRegistry.Shared.HostingEnded();
    }

    public void Dispose() { _timer.Dispose(); _subscription?.Dispose(); }
}
