using CouchCoop.Mod.Contracts;

// Explicit synthetic game state for server tests; production always uses the game-backed monitor.
internal sealed class TestHostBrowserAccess(bool allowed = true) : IHostBrowserAccess
{
    private HostBrowserAccessState _state = new(allowed, allowed ? "allowed" : "outside-multiplayer", 1);
    public HostBrowserAccessState State => Volatile.Read(ref _state);
    public event Action<HostBrowserAccessState>? Changed;
    public bool Started { get; private set; }
    public int StartCount { get; private set; }
    public int StopCount { get; private set; }
    public bool ListenerPresentAtStart { get; private set; }
    public int ListenerCount => Changed?.GetInvocationList().Length ?? 0;
    public void Start() { Started = true; StartCount++; ListenerPresentAtStart = ListenerCount > 0; }
    public void Stop() { if (Started) StopCount++; Started = false; }
    public void Dispose() => Stop();
    public bool IsAllowed(long generation) => State is { Allowed: true } state && state.Generation == generation;
    public void Set(bool allowed, string reason = "menu-open")
    {
        var next = new HostBrowserAccessState(allowed, allowed ? "allowed" : reason, State.Generation + 1, State.SceneResetGeneration + (allowed ? 0 : 1));
        Volatile.Write(ref _state, next);
        Changed?.Invoke(next);
    }
}
