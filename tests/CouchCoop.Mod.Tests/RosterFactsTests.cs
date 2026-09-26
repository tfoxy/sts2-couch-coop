using System.Collections.Concurrent;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.State;

// The roster read (WP3 path 2): who is in the lobby or the run, as CouchCoop's own facts.
//
// What must hold, and where it is pinned:
//   * the facts compare by value, element by element, so two reads of the same game are equal and a change is one
//     unequal comparison;
//   * every decision made from them equals the retired snapshot read on every fixture the suites already share (the
//     parity oracle below, TEST ONLY): the change signature, the names published to the seats, and what counts as the
//     game having left the run and the lobby;
//   * the front marshals to the game main thread from any other thread, runs inline on it, and turns a failed read
//     into "unavailable" (null), which is never "nobody is here";
//   * the production reader is unavailable without an engine, and the saved-run lobby record is per screen.
//
// The production reader needs an engine, which a test process must never reach (it faults in native code), so it is
// exercised through the seam that stands where the game would: CouchCoopGameFactsTests.FakeFacts.
internal static class RosterFactsTests
{
    public static void Run()
    {
        FactsCompareByValue();
        RootScenesAreTheFourSnapshotStrings();
        SignatureFormatIsTheRetiredOne();
        LeavingTheRunAndLobbyIsTheReapPredicate();
        NamesAreNormalizedLikeTheSnapshotNames();
        ParityWithTheRetiredSnapshot();
        ProjectionEqualsTheFactsTheReaderProduces();
        FrontReturnsTheReadersFactsAndTurnsAFailureIntoUnavailable();
        FrontMarshalsToTheMainThreadFromAnyOtherThread();
        FrontRunsInlineOnTheMainThread();
        ProductionReaderIsUnavailableWithoutAnEngine();
        SavedRunLobbyRecordIsPerScreenAndLastWins();
        Console.WriteLine("RosterFactsTests: ok");
    }

    // ---- the facts -----------------------------------------------------------------------------------------

    private static RosterFacts SampleLobby(bool connected = true, string name = "Ann")
        => new(
            RosterRootScenes.CharacterSelect,
            new RosterLobby(
                NetTypes.Host,
                "p:1",
                IsSavedRun: false,
                [new RosterLobbySeat("p:1", "Host", "IRONCLAD", true), new RosterLobbySeat("p:1002", name, "SILENT", connected)],
                []),
            Run: null);

    private static class NetTypes
    {
        public const string Host = NetTypeNames.Host;
    }

    private static void FactsCompareByValue()
    {
        Expect(SampleLobby() == SampleLobby(), "two reads of the same lobby are equal, element by element");
        Expect(SampleLobby().GetHashCode() == SampleLobby().GetHashCode(), "and hash alike");
        Expect(SampleLobby() != SampleLobby(connected: false), "a seat's connectedness is part of the value");
        Expect(SampleLobby() != SampleLobby(name: "Bob"), "so is a display name");

        var withSaved = new RosterLobby(NetTypes.Host, "p:1", true, [], ["p:1002", "p:1003"]);
        var sameSaved = new RosterLobby(NetTypes.Host, "p:1", true, [], ["p:1002", "p:1003"]);
        Expect(withSaved == sameSaved && withSaved.GetHashCode() == sameSaved.GetHashCode(), "saved-run seat ids compare by value");
        Expect(withSaved != sameSaved with { SavedRunSeatIds = ["p:1002"] }, "a different saved-run seat list is a different roster");
        Expect(withSaved != sameSaved with { IsSavedRun = false }, "the saved-run flag is part of the value");

        var run = new RosterRun("host", "p:1", [new RosterRunSeat("p:1", "Host", "IRONCLAD", true, true)]);
        Expect(run == new RosterRun("host", "p:1", [new RosterRunSeat("p:1", "Host", "IRONCLAD", true, true)]), "run seats compare by value");
        Expect(run != new RosterRun("host", "p:1", [new RosterRunSeat("p:1", "Host", "IRONCLAD", true, false)]), "a run seat dropping is a change");
        Expect(new RosterFacts(RosterRootScenes.Run, null, run) != new RosterFacts(RosterRootScenes.Run, null, null), "run presence is part of the value");
    }

    private static void RootScenesAreTheFourSnapshotStrings()
    {
        Expect(RosterRootScenes.Run == "run"
                && RosterRootScenes.CharacterSelect == "screens/character_select_screen"
                && RosterRootScenes.LoadGame == "screens/multiplayer_load_game_screen"
                && RosterRootScenes.MainMenu == "screens/main_menu",
            "the root scenes keep the four strings the snapshot used, so the join screen's title and kind do not move");
    }

    // ---- the change signature --------------------------------------------------------------------------------

    private static void SignatureFormatIsTheRetiredOne()
    {
        Expect(CouchCoopRosterChange.Signature(SampleLobby())
                == "lobby:p:1=Host:True,p:1002=Ann:True|scene:screens/character_select_screen",
            "a lobby signature is its seats (id, name, connected) then the scene");
        Expect(CouchCoopRosterChange.Signature(new RosterFacts(RosterRootScenes.MainMenu, null, null))
                == "lobby:|scene:screens/main_menu",
            "no lobby and no run is an empty lobby signature with the scene");
        var saved = new RosterFacts(
            RosterRootScenes.LoadGame,
            new RosterLobby(NetTypes.Host, "p:1", true, [new RosterLobbySeat("p:1", "Host", null, true)], ["p:1", "p:1002"]),
            null);
        Expect(CouchCoopRosterChange.Signature(saved) == "lobby:p:1=Host:True|saved:p:1,p:1002|scene:screens/multiplayer_load_game_screen",
            "a saved-run lobby carries its saved seat ids");
        var run = new RosterFacts(
            RosterRootScenes.Run,
            null,
            new RosterRun("host", "p:1", [new RosterRunSeat("p:1", "Host", null, true, true), new RosterRunSeat("p:1002", "Ann", null, false, false)]));
        Expect(CouchCoopRosterChange.Signature(run) == "run:p:1=True,p:1002=False|scene:run",
            "a run signature is each seat's connectedness, so a drop is a change");
        Expect(CouchCoopRosterChange.Signature(run) != CouchCoopRosterChange.Signature(
                run with { Run = run.Run! with { Seats = [.. run.Run.Seats.Select(seat => seat with { IsConnected = true })] } }),
            "a seat reconnecting changes the signature");
        Expect(CouchCoopRosterChange.Signature(SampleLobby()) == CouchCoopRosterChange.Signature(SampleLobby() with
            {
                Lobby = SampleLobby().Lobby! with { Seats = [.. SampleLobby().Lobby!.Seats.Select(seat => seat with { CharacterId = "DEFECT" })] },
            }),
            "a character change is not a roster change: nothing acts on it");
    }

    // The rule the maintainer set: the reap fires only once the game has left BOTH the run and any lobby. The death or
    // Architect summary is still the run, and a lobby screen is not the run having ended.
    private static void LeavingTheRunAndLobbyIsTheReapPredicate()
    {
        var run = new RosterRun("host", "p:1", []);
        var lobby = SampleLobby().Lobby!;
        Expect(CouchCoopRosterChange.HasLeftRunAndLobby(new RosterFacts(RosterRootScenes.MainMenu, null, null)), "the main menu has left both");
        Expect(!CouchCoopRosterChange.HasLeftRunAndLobby(new RosterFacts(RosterRootScenes.Run, null, run)),
            "a run in progress has not, and the end-of-run summary is a run in progress");
        Expect(!CouchCoopRosterChange.HasLeftRunAndLobby(new RosterFacts(RosterRootScenes.CharacterSelect, lobby, null)),
            "a lobby screen is not the run having ended");
        Expect(!CouchCoopRosterChange.HasLeftRunAndLobby(new RosterFacts(RosterRootScenes.LoadGame, lobby with { IsSavedRun = true }, null)),
            "neither is the saved-run lobby");
        Expect(!CouchCoopRosterChange.HasLeftRunAndLobby(new RosterFacts(RosterRootScenes.Run, lobby, run)),
            "a run starting under its lobby screen has not left either");
    }

    // ---- names ---------------------------------------------------------------------------------------------

    private static void NamesAreNormalizedLikeTheSnapshotNames()
    {
        Expect(GameFactsReader.NormalizeName("  Bob \r\n the  ") == "Bob   the", "line breaks flatten to a space and the ends trim");
        Expect(GameFactsReader.NormalizeName("   ") is null && GameFactsReader.NormalizeName(null) is null && GameFactsReader.NormalizeName("") is null,
            "a blank name is no name");
        Expect(GameFactsReader.NormalizeNullable(" ironclad ") == "ironclad" && GameFactsReader.NormalizeNullable(" ") is null,
            "identifiers trim and blank is null");
        Expect(GameFactsReader.PlayerId(1002) == "p:1002" && GameFactsReader.PlayerId(76561198000000123UL) == "p:76561198000000123",
            "ids stay p:{netId}");
    }

    // ---- the parity oracle (TEST ONLY) -----------------------------------------------------------------------
    //
    // DELETE THIS SECTION WITH `Project` AND `OldSignature` WHEN THE LAST WP3 READ PATH LANDS. It exists so the move from
    // the full state snapshot to the typed roster is provably a no-op on every fixture the suites already own:
    // `Project` reads a snapshot the way the reader reports the same game, and `OldSignature` is the retired change
    // fingerprint verbatim.

    /// <summary>The roster the typed reader would report for the game a snapshot describes.</summary>
    internal static RosterFacts? Project(StateSnapshot? state)
    {
        if (state is null)
        {
            return null;
        }

        var lobby = state.CharacterSelect?.Lobby is { } source
            ? new RosterLobby(
                source.NetGameType,
                source.HostPlayerId,
                IsSavedRun: source.SavedRun is not null,
                [.. source.Players.Select(player => new RosterLobbySeat(player.Id, player.DisplayName, player.CharacterId, player.IsConnected))],
                [.. source.SavedRun?.Players.Select(player => player.Id) ?? []])
            : null;
        var run = state.Run is { } sourceRun
            ? new RosterRun(
                sourceRun.NetGameType,
                sourceRun.Players.FirstOrDefault(player => player.IsHost)?.Id,
                [.. sourceRun.Players.Select(player => new RosterRunSeat(player.Id, player.DisplayName, player.CharacterId, player.IsHost, player.IsConnected))])
            : null;
        return new RosterFacts(state.RootScene ?? "", lobby, run);
    }

    // The retired CouchCoopBrowserServer.RosterSignature(StateSnapshot), verbatim.
    private static string OldSignature(StateSnapshot snapshot)
    {
        string scene = "|scene:" + (snapshot.RootScene ?? "");
        if (snapshot.Run is { } run)
        {
            return "run:" + string.Join(",", run.Players.Select(player => $"{player.Id}={player.IsConnected}")) + scene;
        }

        var lobby = snapshot.CharacterSelect?.Lobby;
        var players = lobby?.Players;
        if (players is null || players.Count == 0)
        {
            return "lobby:" + scene;
        }

        var saved = lobby?.SavedRun is { } savedRun
            ? "|saved:" + string.Join(",", savedRun.Players.Select(player => player.Id))
            : "";
        return "lobby:"
            + string.Join(",", players.Select(player => $"{player.Id}={player.DisplayName}:{player.IsConnected}"))
            + saved
            + scene;
    }

    /// <summary>Every snapshot the suites share that describes a lobby or a run, plus the roster shapes the classifier reads.</summary>
    internal static IEnumerable<(StateSnapshot? State, string What)> Fixtures()
    {
        foreach (var fixture in CouchCoopLobbyHostGateTests.Fixtures())
        {
            yield return fixture;
        }

        // The player-name suite's lobby and run (host, a Steam friend, couch seats, blank and placeholder names).
        yield return (PlayerNameRosterTests.Lobby(
            PlayerNameRosterTests.LobbyPlayer("p:76561198000000123", "Plapla"),
            PlayerNameRosterTests.LobbyPlayer("p:76561198000000999", "Remote Friend"),
            PlayerNameRosterTests.LobbyPlayer("p:1002", "pla1"),
            PlayerNameRosterTests.LobbyPlayer("p:1003", null),
            PlayerNameRosterTests.LobbyPlayer("p:1004", "1004"),
            PlayerNameRosterTests.LobbyPlayer("not-a-player-id", "Nope")), "named lobby");
        yield return (PlayerNameRosterTests.Run(
            PlayerNameRosterTests.RunPlayer("p:76561198000000123", "Plapla", isHost: true),
            PlayerNameRosterTests.RunPlayer("p:1002", "pla1", isHost: false)), "named run");

        // The seat suite's saved-run lobby (live and saved seats, some absent) and its run with a dropped seat.
        yield return (MirrorSeatRosterTests.LoadGameLobby(
            lobby: [MirrorSeatRosterTests.LobbyPlayer("p:1", "Hosty", connected: true)],
            saved: ["p:1", "p:1002", "p:1003"]), "saved-run lobby with absent seats");
        yield return (MirrorSeatRosterTests.LoadGameLobby(
            lobby: [MirrorSeatRosterTests.LobbyPlayer("p:1", "Hosty", connected: true), MirrorSeatRosterTests.LobbyPlayer("p:1002", "Ann", connected: false)],
            saved: ["p:1", "p:1002"]), "saved-run lobby with a disconnected live seat");
        yield return (MirrorSeatRosterTests.Run(
            MirrorSeatRosterTests.RunPlayer("p:1", "Hosty", isHost: true, connected: true),
            MirrorSeatRosterTests.RunPlayer("p:1002", "Ann", isHost: false, connected: true),
            MirrorSeatRosterTests.RunPlayer("p:1003", "Bea", isHost: false, connected: false)), "run with a dropped seat");
    }

    private static void ParityWithTheRetiredSnapshot()
    {
        var count = 0;
        foreach (var (state, what) in Fixtures())
        {
            var facts = Project(state);
            if (state is null)
            {
                Expect(facts is null, $"no state is unavailable ({what})");
                count++;
                continue;
            }

            Expect(CouchCoopRosterChange.Signature(facts!) == OldSignature(state), $"signature parity on {what}");
            Expect(CouchCoopRosterChange.HasLeftRunAndLobby(facts!) == (state.Run is null && state.CharacterSelect is null),
                $"run-and-lobby parity on {what}");
            var oldNames = CouchCoopLobbyParticipation.RosterNames(state);
            var newNames = CouchCoopLobbyParticipation.RosterNames(facts!);
            Expect(oldNames.SequenceEqual(newNames), $"published names parity on {what}: [{string.Join(", ", oldNames)}] vs [{string.Join(", ", newNames)}]");
            count++;
        }

        Expect(count == 19, $"the parity oracle covered every shared fixture (got {count})");
    }

    // The projection is only an oracle if it agrees with what the reader really emits. Each snapshot fixture is
    // paired with the facts the typed reader reports for that situation, written out by hand.
    private static void ProjectionEqualsTheFactsTheReaderProduces()
    {
        var lobby = PlayerNameRosterTests.Lobby(
            PlayerNameRosterTests.LobbyPlayer("p:1", "Host"),
            PlayerNameRosterTests.LobbyPlayer("p:1002", "Ann"));
        Expect(Project(lobby) == new RosterFacts(
                RosterRootScenes.CharacterSelect,
                new RosterLobby(
                    NetTypeNames.Host,
                    "p:1",
                    IsSavedRun: false,
                    [new RosterLobbySeat("p:1", "Host", "ironclad", true), new RosterLobbySeat("p:1002", "Ann", "ironclad", true)],
                    []),
                Run: null),
            "a new-run lobby");
        var saved = MirrorSeatRosterTests.LoadGameLobby(
            lobby: [MirrorSeatRosterTests.LobbyPlayer("p:1", "Hosty", connected: true)],
            saved: ["p:1", "p:1003"]);
        var projected = Project(saved)!;
        Expect(projected.Lobby is { IsSavedRun: true } && projected.Lobby.SavedRunSeatIds.SequenceEqual(["p:1", "p:1003"]),
            "a saved-run lobby keeps its saved seat ids");
        var run = Project(MirrorSeatRosterTests.Run(
            MirrorSeatRosterTests.RunPlayer("p:1", "Hosty", isHost: true, connected: true),
            MirrorSeatRosterTests.RunPlayer("p:1003", "Bea", isHost: false, connected: false)))!;
        Expect(run.Run is { HostPlayerId: "p:1" } && run.Run.Seats.SequenceEqual(
                [new RosterRunSeat("p:1", "Hosty", "ironclad", true, true), new RosterRunSeat("p:1003", "Bea", "ironclad", false, false)]),
            "a run keeps its host and each seat's connectedness");
    }

    // ---- the front ---------------------------------------------------------------------------------------

    private static void FrontReturnsTheReadersFactsAndTurnsAFailureIntoUnavailable()
    {
        var fake = new CouchCoopGameFactsTests.FakeFacts { RosterRead = () => SampleLobby() };
        CouchCoopGameFactsTests.WithSource(fake, () =>
        {
            Expect(CouchCoopGameFacts.ReadRoster() == SampleLobby(), "the reader's facts come back");
            fake.RosterRead = () => null;
            Expect(CouchCoopGameFacts.ReadRoster() is null, "an unreadable answer stays null");
            fake.RosterRead = () => throw new InvalidOperationException("the game moved");
            Expect(CouchCoopGameFacts.ReadRoster() is null, "a throwing reader is unavailable, never an exception in the caller");
            Expect(fake.RosterReads == 3, "each call is one read of the reader");
        });
    }

    // Callable from ANY thread: from a socket thread the read runs on the game main thread, which the front reaches through
    // GameMainThread. The fake main thread here is a real second thread, so "it ran there" is observable.
    private static void FrontMarshalsToTheMainThreadFromAnyOtherThread()
    {
        using var mainThread = new DedicatedThread();
        var previous = GameMainThread.Source;
        GameMainThread.Source = mainThread;
        var fake = new CouchCoopGameFactsTests.FakeFacts { RosterRead = () => SampleLobby() };
        try
        {
            CouchCoopGameFactsTests.WithSource(fake, () =>
            {
                var caller = Environment.CurrentManagedThreadId;
                var roster = Task.Run(() => CouchCoopGameFacts.ReadRoster()).GetAwaiter().GetResult();
                Expect(roster == SampleLobby(), "a read from a pool thread returns the facts");
                Expect(fake.RosterReadThread == mainThread.ThreadId, "…which were read on the game main thread");
                Expect(fake.RosterReadThread != caller, "and not on the caller's thread");
                Expect(mainThread.Marshals == 1, "one marshal per read");
            });
        }
        finally
        {
            GameMainThread.Source = previous;
        }
    }

    private static void FrontRunsInlineOnTheMainThread()
    {
        using var mainThread = new DedicatedThread();
        var previous = GameMainThread.Source;
        GameMainThread.Source = mainThread;
        var fake = new CouchCoopGameFactsTests.FakeFacts { RosterRead = () => SampleLobby() };
        try
        {
            CouchCoopGameFactsTests.WithSource(fake, () =>
            {
                // On the main thread itself (an evaluation one frame after a signal) the read must not marshal again.
                var roster = mainThread.Run(() => CouchCoopGameFacts.ReadRoster());
                Expect(roster == SampleLobby(), "a read on the main thread returns the facts");
                Expect(fake.RosterReadThread == mainThread.ThreadId, "…on that thread");
                Expect(mainThread.Marshals == 0, "with no second hop");
            });
        }
        finally
        {
            GameMainThread.Source = previous;
        }
    }

    // A dedicated thread standing in for the game's main thread: Invoke posts to it and waits, except when the caller is
    // already on it, where it runs inline (which is the dispatcher's own contract).
    private sealed class DedicatedThread : IGameMainThread, IDisposable
    {
        private readonly BlockingCollection<Action> _queue = [];
        private readonly Thread _thread;
        private int _marshals;

        public DedicatedThread()
        {
            _thread = new Thread(() =>
            {
                foreach (var work in _queue.GetConsumingEnumerable())
                {
                    work();
                }
            })
            { IsBackground = true, Name = "test-main-thread" };
            _thread.Start();
        }

        public int ThreadId => _thread.ManagedThreadId;
        public int Marshals => Volatile.Read(ref _marshals);

        public T Invoke<T>(Func<T> action)
        {
            if (Environment.CurrentManagedThreadId == ThreadId)
            {
                return action();
            }

            Interlocked.Increment(ref _marshals);
            var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            _queue.Add(() =>
            {
                try { done.SetResult(action()); }
                catch (Exception exception) { done.SetException(exception); }
            });
            return done.Task.GetAwaiter().GetResult();
        }

        public Task<T> InvokeAsync<T>(Func<Task<T>> action) => Task.Run(() => Invoke(() => action().GetAwaiter().GetResult()));

        /// <summary>Run <paramref name="body"/> on the dedicated thread, as the game's next-frame callback would.</summary>
        public T Run<T>(Func<T> body)
        {
            var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            _queue.Add(() =>
            {
                try { done.SetResult(body()); }
                catch (Exception exception) { done.SetException(exception); }
            });
            return done.Task.GetAwaiter().GetResult();
        }

        public void Dispose() => _queue.CompleteAdding();
    }

    // No engine behind the process: unavailable without touching a game type (reaching RunManager here is the exit-139
    // hazard), through the reader and through the front.
    private static void ProductionReaderIsUnavailableWithoutAnEngine()
    {
        Expect(!CouchCoop.Mod.CouchCoopMod.EngineAvailable, "this process has no engine");
        Expect(GameFactsReader.Instance.ReadRoster() is null, "the production reader answers unavailable");
        ZeroClientGuard.ResetForTests(armed: false);
        try
        {
            Expect(CouchCoopGameFacts.ReadRoster() is null, "the front over the production reader answers unavailable");
        }
        finally
        {
            ZeroClientGuard.ResetForTests();
        }
    }

    // ---- the saved-run lobby record ------------------------------------------------------------------------

    private static void SavedRunLobbyRecordIsPerScreenAndLastWins()
    {
        var screen = new object();
        var other = new object();
        var first = new object();
        var second = new object();
        Expect(!LobbyAssignmentRecord.TryGetLobby(screen, out _), "nothing is recorded before the game builds a lobby");
        LobbyAssignmentRecord.RecordLobby(screen, first);
        Expect(LobbyAssignmentRecord.TryGetLobby(screen, out var found) && ReferenceEquals(found, first), "the lobby recorded for a screen comes back");
        Expect(!LobbyAssignmentRecord.TryGetLobby(other, out _), "another screen has none");
        LobbyAssignmentRecord.RecordLobby(screen, second);
        Expect(LobbyAssignmentRecord.TryGetLobby(screen, out found) && ReferenceEquals(found, second), "a later lobby for the same screen replaces the earlier one");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"RosterFactsTests failed: {because}");
        }
    }
}
