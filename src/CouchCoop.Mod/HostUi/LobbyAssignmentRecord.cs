using System.Runtime.CompilerServices;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Which role the game gave the lobby of one screen instance, as reported by the hook on the method that assigns it.
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
/// </remarks>
internal static class LobbyAssignmentRecord
{
    private static readonly ConditionalWeakTable<object, string> Roles = new();

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
}
