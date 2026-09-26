using System.Collections.Concurrent;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

// The roster read (WP3 path 2): who is in the lobby or the run, as CouchCoop's own facts.
//
// What must hold, and where it is pinned:
//   * the facts compare by value, element by element, so two reads of the same game are equal and a change is one
//     unequal comparison;
//   * the names and reap decision equal the retired snapshot read on every shared fixture (the parity oracle below,
//     TEST ONLY); the diagnostic signature now includes all facts rather than the retired subset;
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
        SignatureDisplaysEveryRosterFact();
        LeavingTheRunAndLobbyIsTheReapPredicate();
        NamesAreNormalizedLikeTheSnapshotNames();
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

    // ---- the diagnostic signature -----------------------------------------------------------------------------

    private static void SignatureDisplaysEveryRosterFact()
    {
        var lobby = SampleLobby();
        var signature = CouchCoopRosterChange.Signature(lobby);
        Expect(signature.Contains("\"RootScene\":\"screens/character_select_screen\"", StringComparison.Ordinal)
                && signature.Contains("\"CharacterId\":\"SILENT\"", StringComparison.Ordinal)
                && signature.Contains("\"DisplayName\":\"Ann\"", StringComparison.Ordinal),
            "the trace shows scene, name and character");
        Expect(signature != CouchCoopRosterChange.Signature(lobby with
            {
                Lobby = lobby.Lobby! with { Seats = [lobby.Lobby.Seats[0], lobby.Lobby.Seats[1] with { CharacterId = "DEFECT" }] },
            }), "a character change is visible in the trace");
        Expect(CouchCoopRosterChange.Signature(new RosterFacts(RosterRootScenes.MainMenu, null, null))
                == "{\"RootScene\":\"screens/main_menu\",\"Lobby\":null,\"Run\":null}",
            "the trace shows that there is neither a lobby nor a run");
        var saved = new RosterFacts(
            RosterRootScenes.LoadGame,
            new RosterLobby(NetTypes.Host, "p:1", true, [new RosterLobbySeat("p:1", "Host", null, true)], ["p:1", "p:1002"]),
            null);
        Expect(CouchCoopRosterChange.Signature(saved).Contains("\"SavedRunSeatIds\":[\"p:1\",\"p:1002\"]", StringComparison.Ordinal),
            "a saved-run lobby trace carries its saved seat ids");
        var run = new RosterFacts(
            RosterRootScenes.Run,
            null,
            new RosterRun("host", "p:1", [new RosterRunSeat("p:1", "Host", null, true, true), new RosterRunSeat("p:1002", "Ann", null, false, false)]));
        Expect(CouchCoopRosterChange.Signature(run).Contains("\"IsHost\":true,\"IsConnected\":true", StringComparison.Ordinal),
            "the run trace includes host role and connectivity");
        Expect(CouchCoopRosterChange.Signature(run) != CouchCoopRosterChange.Signature(
                run with { Run = run.Run! with { Seats = [.. run.Run.Seats.Select(seat => seat with { IsConnected = true })] } }),
            "a seat reconnecting changes the trace");
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
    internal sealed class DedicatedThread : IGameMainThread, IDisposable
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
