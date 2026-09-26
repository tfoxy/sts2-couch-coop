using System.Runtime.CompilerServices;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Runtime;

// The roster read of the CouchCoopGameFacts front (WP3 path 2). Kept in its own file beside the gate read.
public static partial class CouchCoopGameFacts
{
    /// <summary>
    /// Who is in the lobby or the run, or <see langword="null"/> when that could not be read. Callable from ANY thread:
    /// the read runs on the game main thread, inline when the caller is already there and marshalled otherwise.
    /// </summary>
    /// <remarks>
    /// NEVER CALL IT WHILE HOLDING A MOD LOCK (the marshal waits on the main thread, and the main thread may be waiting on
    /// that lock: the <c>DescribeSeats</c> deadlock), and never from inside a game callback such as a postfix, where
    /// resolving the current screen faults the process. A caller that wants to learn of a change is the roster observer,
    /// which is woken by a signal and reads one frame later.
    /// </remarks>
    public static RosterFacts? ReadRoster(
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.HostFactsRead, caller, file);
        try
        {
            return GameMainThread.Invoke(() => Source.ReadRoster(), caller, file);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"roster read failed detail={exception.GetType().Name}: {exception.Message}");
            return null;
        }
    }

    /// <summary>
    /// The roster and the lobby's player cap for one browser join, read in ONE hop onto the game main thread (inline
    /// when already there), so the two describe the same frame and a join pays a single marshal for both. Each half is
    /// read through its own front, so each keeps its own failure semantics: an unreadable roster is
    /// <see langword="null"/> (never "nobody is here") and an unreadable cap is <see langword="null"/> (never a small
    /// number). Callable from ANY thread, and under the same rule as <see cref="ReadRoster"/>: never while holding a mod
    /// lock, never inside a game callback. An on-demand read for a user action, never something to poll.
    /// </summary>
    public static JoinRead ReadRosterAndLobbyCap(
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.HostFactsRead, caller, file);
        try
        {
            return GameMainThread.Invoke(() => new JoinRead(ReadRoster(caller, file), ReadLobbyCap(caller, file)), caller, file);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"join facts read failed detail={exception.GetType().Name}: {exception.Message}");
            return default;
        }
    }
}
