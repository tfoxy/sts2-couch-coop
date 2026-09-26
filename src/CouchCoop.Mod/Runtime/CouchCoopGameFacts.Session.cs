using System.Runtime.CompilerServices;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Runtime;

// The session read of the CouchCoopGameFacts front (WP3 path 3): the roster and the lobby cap one `session` envelope is
// built from, in ONE hop to the game's main thread. Kept in its own file beside the other reads.
public static partial class CouchCoopGameFacts
{
    /// <summary>
    /// Who is in the lobby or the run and, when <paramref name="withLobbyCap"/>, the player cap of the lobby on the
    /// current screen, read together on the game main thread: one marshal from any other thread, none from the main
    /// thread itself. Each half fails on its own, so an unreadable roster does not cost the cap and the reverse; a
    /// marshal that fails is <see cref="SessionFacts.Unavailable"/>. Never throws.
    /// </summary>
    /// <remarks>
    /// NEVER CALL IT WHILE HOLDING A MOD LOCK (the marshal waits on the main thread, and the main thread may be waiting
    /// on that lock: the <c>DescribeSeats</c> deadlock), and never from inside a game callback such as a postfix.
    /// <paramref name="withLobbyCap"/> is for the seat table: a caller with no seats to size (a headless seat, a host
    /// with no seat manager) leaves it off and pays nothing for the cap.
    /// </remarks>
    public static SessionFacts ReadSessionFacts(
        bool withLobbyCap,
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.HostFactsRead, caller, file);
        try
        {
            // A dispatcher that hands nothing back (a test double that never runs the work) is an unread game, not a crash.
            return GameMainThread.Invoke<SessionFacts?>(
                () =>
                {
                    RosterFacts? roster = null;
                    try
                    {
                        roster = Source.ReadRoster();
                    }
                    catch (Exception exception)
                    {
                        CouchCoopLog.Stderr($"roster read failed detail={exception.GetType().Name}: {exception.Message}");
                    }

                    // Already on the main thread here, so the cap reader's own marshal runs inline.
                    return new SessionFacts(roster, withLobbyCap ? ReadLobbyCapFromSource() : null);
                },
                caller,
                file) ?? SessionFacts.Unavailable;
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"session facts read failed detail={exception.GetType().Name}: {exception.Message}");
            return SessionFacts.Unavailable;
        }
    }
}
