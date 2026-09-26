using System.Runtime.CompilerServices;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Multiplayer.Game.Lobby;
using MegaCrit.Sts2.Core.Multiplayer.Messages.Lobby;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Saves;
#if STS2_API_V111
using System.Reflection;
using HarmonyLib;
#endif

namespace CouchCoop.Mod.Runtime;

// WP3 path 5: the lobby player cap. The front and the reader halves of one read, in a file of their own so this path
// does not edit the lines the other read paths add to.

public static partial class CouchCoopGameFacts
{
    private static int _lobbyCapFailureLogged;

    /// <summary>
    /// The player cap of the lobby on the current lobby screen (see <see cref="IGameFacts.ReadLobbyCap"/>), or
    /// <see langword="null"/> when there is none or it could not be read. Callable from ANY thread; it never
    /// waits on a lock of this process's, so a caller must not be holding one the game's main thread may want.
    /// </summary>
    /// <remarks>
    /// A failing read (a game build that moved the member the read depends on) is logged once and then stays quiet
    /// until a read succeeds again: the admission limiter asks on every WebSocket upgrade, and a line per upgrade
    /// would bury the one that matters.
    /// </remarks>
    public static int? ReadLobbyCap(
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ZeroClientGuard.Enter(ZeroClientEntries.HostFactsRead, caller, file);
        return ReadLobbyCapFromSource();
    }

    /// <summary>
    /// The cap read and its failure rule, shared with the session read (which asks for the cap in the same hop as the
    /// roster): a throw is "no cap known", logged once until a read succeeds again.
    /// </summary>
    private static int? ReadLobbyCapFromSource()
    {
        try
        {
            var cap = Source.ReadLobbyCap();
            Interlocked.Exchange(ref _lobbyCapFailureLogged, 0);
            return cap;
        }
        catch (Exception exception)
        {
            if (Interlocked.Exchange(ref _lobbyCapFailureLogged, 1) == 0)
            {
                CouchCoopLog.Stderr($"lobby cap read failed detail={exception.GetType().Name}: {exception.Message}");
            }

            return null;
        }
    }
}

internal sealed partial class GameFactsReader
{
    /// <summary>
    /// The current lobby screen's player cap, read on the game's main thread. The marshal runs inline when the caller
    /// is already there (host start), and the current screen is resolved at that frame rather than handed in: a
    /// listener thread has no screen of its own to pass, and marshalled work is not inside a screen callback.
    /// </summary>
    public int? ReadLobbyCap()
    {
        // Every game type is touched only from ReadLobbyCapOnMainThread, which is never JIT-compiled in a process
        // with no engine behind it (see ReadGates).
        if (!CouchCoopMod.EngineAvailable)
        {
            return null;
        }

        return GameMainThread.Invoke<int?>(ReadLobbyCapOnMainThread);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int? ReadLobbyCapOnMainThread() => LobbyCapOfScreen(GameScreenContext.GetCurrent());

    /// <summary>
    /// The cap of the lobby on <paramref name="screen"/>, or null when it is not a lobby screen or its lobby is not
    /// assigned. The new-run screen exposes its lobby. The saved-run screen does not, and its lobby admits exactly the
    /// players in the save it was given, so the cap is that save's player count, from what its assignment hook
    /// recorded (see <see cref="LobbyAssignmentRecord"/>).
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static int? LobbyCapOfScreen(object? screen)
        => screen switch
        {
            NCharacterSelectScreen characterSelect => characterSelect.Lobby is { } lobby ? StartRunLobbyCap(lobby) : null,
            NMultiplayerLoadGameScreen loadRun => LobbyAssignmentRecord.TryGetSavedRun(loadRun, out var payload)
                ? SavedRunPlayerCount(payload)
                : null,
            _ => null,
        };

    /// <summary>
    /// How many players the save holds, from what the saved-run screen's initializer was handed: the save on the
    /// host, the join response that carries it on a client. Null for anything else.
    /// </summary>
    internal static int? SavedRunPlayerCount(object payload)
        => payload switch
        {
            SerializableRun run => run.Players?.Count ?? 0,
            ClientLoadJoinResponseMessage message => message.serializableRun?.Players?.Count ?? 0,
            _ => null,
        };

#if STS2_API_V111
    /// <summary>
    /// The one by-name game member CouchCoop reads: the start-run lobby's live player cap. On this lane the game keeps
    /// it in a private field and offers no public way to learn it. It has to be the live value, not one seen when
    /// the lobby was built, because a multiplayer limit mod raises it later than that, from its own join hooks. A
    /// value recorded at construction would keep answering the stock four for a sixteen-player lobby and keep the
    /// fifth player out.
    /// </summary>
    /// <remarks>
    /// A maintainer-granted exception to "no by-name reflection", like the seat peer-list read (<c>7d089e03</c>),
    /// and the only one of its kind here. It stays a single method so it can be found and removed. Its member is
    /// pinned by <c>CouchCoopGameFactsTests.LobbyCapMemberResolves</c> and by <c>LobbyCapTargets</c> in the
    /// metadata-only lane; a build that moves it is a failed test, and at run time a read that throws (see the
    /// front) is "no cap known", never a guess. The other lane reads a public property and needs none of this.
    /// </remarks>
    internal const string LobbyCapMemberName = LobbyCapTargets.FieldName;

    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static int StartRunLobbyCap(StartRunLobby lobby)
        => (int)(LobbyCapField.Member
            ?? throw new MissingFieldException(typeof(StartRunLobby).FullName, LobbyCapMemberName)).GetValue(lobby)!;

    // Resolved on first use rather than when the reader loads, so a process that never reads a cap never touches it.
    private static class LobbyCapField
    {
        internal static readonly FieldInfo? Member = AccessTools.Field(typeof(StartRunLobby), LobbyCapMemberName);
    }
#else
    [MethodImpl(MethodImplOptions.NoInlining)]
    internal static int StartRunLobbyCap(StartRunLobby lobby) => lobby.MaxPlayers;
#endif
}
