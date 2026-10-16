using CouchCoop.Mod.Contracts;

// Explicit synthetic game state for server tests; production always uses the game-backed monitor.
internal sealed class TestHostBrowserAccess(bool allowed = true) : IHostBrowserAccess
{
    private HostBrowserAccessState _state = new(allowed, allowed ? "allowed" : "outside-multiplayer", 1);
    public HostBrowserAccessState State => Volatile.Read(ref _state);
    public event Action<HostBrowserAccessState>? Changed;
    public bool Started { get; private set; }
    public void Start() => Started = true;
    public void Stop() => Started = false;
    public void Dispose() => Stop();
    public bool IsAllowed(long generation) => State is { Allowed: true } state && state.Generation == generation;
    public void Set(bool allowed, string reason = "menu-open")
    {
        var next = new HostBrowserAccessState(allowed, allowed ? "allowed" : reason, State.Generation + 1);
        Volatile.Write(ref _state, next);
        Changed?.Invoke(next);
    }
}
