using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Which role the game gave the lobby of one screen instance, and which saved run it was given, as reported by the
/// hook on the method that assigns it.
/// </summary>
/// <remarks>
/// <para>
/// WHY THIS EXISTS. The load-saved-run lobby screen keeps its lobby in a private field and exposes no accessor, so
/// the only typed way to learn whether it is a host lobby or a client lobby is to be told when the game assigns
/// it. A postfix on the screen's host and client initializers records the answer here, per screen instance, and the
/// gate reads it back only when it evaluates a screen that is current.
/// </para>
/// <para>
/// STALENESS IS NOT TRACKED, ON PURPOSE. The game clears a lobby by leaving the screen, and no screen on top means
/// no QR panel and nothing to decide, so a role left over from a finished lobby is never read as an answer. Do not
/// build invalidation for it.
/// </para>
/// <para>
/// Weak per instance so a freed screen takes its entry with it, and game-free (plain <see cref="object"/> keys) so
/// the contract is testable without an engine. Thread-safe: <see cref="ConditionalWeakTable{TKey, TValue}"/> is.
/// </para>
/// <para>
/// THE SAVED RUN IS RECORDED TOO, for the same reason. That lobby's player cap is the number of players in the save
/// it was given (it admits exactly those), and the screen exposes neither the lobby nor the save. The hook keeps the
/// object the initializer received (untouched, as an <see cref="object"/>: a postfix only records) and the reader
/// counts its players later, at a frame boundary.
/// </para>
/// </remarks>
internal static class LobbyAssignmentRecord
{
    private static readonly ConditionalWeakTable<object, string> Roles = new();
    private static readonly ConditionalWeakTable<object, object> SavedRuns = new();
    private static readonly ConditionalWeakTable<object, object> Lobbies = new();

    /// <summary>Remember (or replace) the role assigned to <paramref name="screen"/>.</summary>
    internal static void Record(object screen, string role)
    {
        ArgumentNullException.ThrowIfNull(screen);
        ArgumentException.ThrowIfNullOrEmpty(role);
        Roles.AddOrUpdate(screen, role);
    }

    /// <summary>The role last recorded for <paramref name="screen"/>, or false when none was.</summary>
    internal static bool TryGet(object screen, out string role)
    {
        if (screen is not null && Roles.TryGetValue(screen, out var found))
        {
            role = found;
            return true;
        }

        role = string.Empty;
        return false;
    }

    /// <summary>
    /// Remember (or replace) what the game handed <paramref name="screen"/> when it assigned the saved-run lobby: the
    /// save itself on the host's initializer, the join response that carries it on the client's. Not inspected here.
    /// </summary>
    internal static void RecordSavedRun(object screen, object payload)
    {
        ArgumentNullException.ThrowIfNull(screen);
        ArgumentNullException.ThrowIfNull(payload);
        SavedRuns.AddOrUpdate(screen, payload);
    }

    /// <summary>What the saved-run screen was last handed, or false when it was handed nothing that was recorded.</summary>
    internal static bool TryGetSavedRun(object screen, [NotNullWhen(true)] out object? payload)
    {
        if (screen is not null && SavedRuns.TryGetValue(screen, out var found))
        {
            payload = found;
            return true;
        }

        payload = null;
        return false;
    }

    /// <summary>
    /// Remember (or replace) the saved-run LOBBY OBJECT the game built for <paramref name="screen"/>, as its constructor
    /// hook (<see cref="Patches.RosterSignalPatch"/>) saw it. Not inspected here.
    /// </summary>
    /// <remarks>
    /// This is what the roster read needs beyond the save: which players the lobby has ADMITTED, which the save cannot say
    /// (a peer is connected before the lobby admits it, and only the admitted are seated). The lobby also carries the save
    /// it was built around, so the same entry answers the seat list.
    /// </remarks>
    internal static void RecordLobby(object screen, object lobby)
    {
        ArgumentNullException.ThrowIfNull(screen);
        ArgumentNullException.ThrowIfNull(lobby);
        Lobbies.AddOrUpdate(screen, lobby);
    }

    /// <summary>The lobby object last recorded for the saved-run <paramref name="screen"/>, or false when none was.</summary>
    internal static bool TryGetLobby(object screen, [NotNullWhen(true)] out object? lobby)
    {
        if (screen is not null && Lobbies.TryGetValue(screen, out var found))
        {
            lobby = found;
            return true;
        }

        lobby = null;
        return false;
    }
}
