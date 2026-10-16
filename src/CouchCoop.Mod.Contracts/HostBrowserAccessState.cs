namespace CouchCoop.Mod.Contracts;

/// <summary>The server's permission to expose this process's host screen and accept browser input.</summary>
public sealed record HostBrowserAccessState(bool Allowed, string Reason, long Generation, long SceneResetGeneration = 0);

public static class HostBrowserAccessReasons
{
    public const string Allowed = "allowed";
    public const string MultiplayerRequired = "outside-multiplayer";
    public const string MenuOpen = "menu-open";
    public const string Transition = "transitioning";
    public const string Unavailable = "unavailable";
}

/// <summary>A demand-owned, event-driven authorization source. Generations invalidate queued work.</summary>
public interface IHostBrowserAccess : IDisposable
{
    HostBrowserAccessState State { get; }
    event Action<HostBrowserAccessState>? Changed;
    void Start();
    void Stop();
    bool IsAllowed(long generation);
}
