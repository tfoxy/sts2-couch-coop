namespace CouchCoop.Mod.Runtime;

/// <summary>
/// The net service of the lobby the game most recently created, remembered so the roster observer can listen for peers
/// connecting and disconnecting on it.
/// </summary>
/// <remarks>
/// <para>
/// WHY IT IS CAPTURED AND NOT ASKED FOR. Seat connectivity is a change of the host's peer list, and the game raises it as
/// an event on the host's net service. Which service that is depends on how the host was started (Steam, ENet, the
/// composite host) and the stock ENet start does not pass through any of CouchCoop's own transport hooks, but every lobby
/// is built around the one service that hosts it, and a postfix on the lobby constructors
/// (<see cref="Patches.RosterSignalPatch"/>) records it here. A run continues on the service its lobby had, so the same
/// service covers both.
/// </para>
/// <para>
/// Weak: recording must not keep a finished session's service alive. The observer holds it strongly only while it is
/// bound (see <see cref="GameRosterSignals"/>) and lets go when the observer stops.
/// </para>
/// </remarks>
internal static class RosterHostService
{
    private static WeakReference<object>? _current;

    /// <summary>The service last recorded, or null when none was or it has been collected.</summary>
    internal static object? Current
        => Volatile.Read(ref _current) is { } weak && weak.TryGetTarget(out var service) ? service : null;

    /// <summary>
    /// Remember <paramref name="service"/>. Records only: the hook that calls this wakes the roster listeners itself, and
    /// the observer binds the service just before its next read.
    /// </summary>
    internal static void Note(object? service)
    {
        if (service is null)
        {
            return;
        }

        Volatile.Write(ref _current, new WeakReference<object>(service));
    }
}
