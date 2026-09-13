namespace CouchCoop.Mod.Connections;

/// <summary>Process lifetime input gate shared by built-in and hot-reloaded browser servers.</summary>
public static class ConnectionInputAvailability
{
    private static int _available = 1;
    public static bool IsAvailable => Volatile.Read(ref _available) != 0;
    public static void Stop() => Volatile.Write(ref _available, 0);
}
