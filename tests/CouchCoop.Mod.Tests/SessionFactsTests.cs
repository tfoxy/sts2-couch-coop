using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;

// The roster and the lobby cap one `session` envelope is built from, read together (WP3 path 3).
//
// The point of the read is its cost: an envelope, and a fan-out of them to every connection, costs ONE hop to the game's
// main thread, where the roster and the cap used to be a full state snapshot plus a second hop hidden behind the seat table.
// What must hold, and where it is pinned:
//   * one marshal from any other thread, none from the main thread, whichever halves are asked for;
//   * the cap is read only when a seat table wants it, and each half fails on its own (an unreadable roster is unavailable,
//     never "nobody here", and it does not cost the cap);
//   * a marshal that fails, or a dispatcher that hands nothing back, is unavailable rather than an exception in the caller;
//   * a process with no engine behind it reads nothing;
//   * the cap is judged usable exactly as MaxCouchSeats judges it, and feeds the same "unreadable" notice.
internal static class SessionFactsTests
{
    public static void Run()
    {
        OneHopFromAnyOtherThread();
        NoHopFromTheMainThread();
        TheCapIsReadOnlyWhenAskedFor();
        EachHalfFailsOnItsOwn();
        AFailedOrEmptyMarshalIsUnavailable();
        NoEngineReadsNothing();
        TheCapIsJudgedAsMaxCouchSeatsJudgesIt();
        Console.WriteLine("SessionFactsTests: ok");
    }

    private static RosterFacts Roster() => new(RosterRootScenes.MainMenu, null, null);

    // The cap reader marshals through the main thread as the production reader does (inline when already on it), so a
    // nested cap read shows up as a hop only if the front failed to read it inside the roster's hop.
    private static CouchCoopGameFactsTests.FakeFacts Game(RosterFactsTests.DedicatedThread mainThread, int? cap = 8)
        => new()
        {
            RosterRead = Roster,
            CapRead = () => mainThread.Invoke(() => cap),
        };

    private static void OneHopFromAnyOtherThread()
    {
        using var mainThread = new RosterFactsTests.DedicatedThread();
        var previous = GameMainThread.Source;
        GameMainThread.Source = mainThread;
        var fake = Game(mainThread);
        try
        {
            CouchCoopGameFactsTests.WithSource(fake, () =>
            {
                var caller = Environment.CurrentManagedThreadId;
                var read = Task.Run(() => CouchCoopGameFacts.ReadSessionFacts(withLobbyCap: true)).GetAwaiter().GetResult();
                Expect(read.Roster == Roster() && read.LobbyCap == 8, "a read from a pool thread returns the roster and the cap");
                Expect(fake.RosterReads == 1 && fake.CapReads == 1, "one read of each");
                Expect(mainThread.Marshals == 1, $"…in ONE hop, not one per fact (got {mainThread.Marshals})");
                Expect(fake.RosterReadThread == mainThread.ThreadId && fake.RosterReadThread != caller, "…on the game main thread");
            });
        }
        finally
        {
            GameMainThread.Source = previous;
        }
    }

    private static void NoHopFromTheMainThread()
    {
        using var mainThread = new RosterFactsTests.DedicatedThread();
        var previous = GameMainThread.Source;
        GameMainThread.Source = mainThread;
        var fake = Game(mainThread);
        try
        {
            CouchCoopGameFactsTests.WithSource(fake, () =>
            {
                var read = mainThread.Run(() => CouchCoopGameFacts.ReadSessionFacts(withLobbyCap: true));
                Expect(read.Roster == Roster() && read.LobbyCap == 8, "a read on the main thread returns both");
                Expect(mainThread.Marshals == 0, "with no hop at all (the static-background publish is on it)");
            });
        }
        finally
        {
            GameMainThread.Source = previous;
        }
    }

    private static void TheCapIsReadOnlyWhenAskedFor()
    {
        using var mainThread = new RosterFactsTests.DedicatedThread();
        var previous = GameMainThread.Source;
        GameMainThread.Source = mainThread;
        var fake = Game(mainThread);
        try
        {
            CouchCoopGameFactsTests.WithSource(fake, () =>
            {
                var read = Task.Run(() => CouchCoopGameFacts.ReadSessionFacts(withLobbyCap: false)).GetAwaiter().GetResult();
                Expect(read.Roster == Roster() && read.LobbyCap is null, "with no seat table to size, the cap is not read");
                Expect(fake.CapReads == 0 && mainThread.Marshals == 1, "…at no cost beyond the roster's own hop");
            });
        }
        finally
        {
            GameMainThread.Source = previous;
        }
    }

    // A roster that cannot be read is null, which an envelope reports as an unsupported screen; it must not take the cap
    // with it (the seat table still wants sizing) and a cap that cannot be read must not take the roster.
    private static void EachHalfFailsOnItsOwn()
    {
        var fake = new CouchCoopGameFactsTests.FakeFacts
        {
            RosterRead = () => throw new InvalidOperationException("the game moved"),
            CapRead = () => 6,
        };
        CouchCoopGameFactsTests.WithSource(fake, () =>
        {
            var read = CouchCoopGameFacts.ReadSessionFacts(withLobbyCap: true);
            Expect(read.Roster is null && read.LobbyCap == 6, "a throwing roster read is unavailable and keeps the cap");

            fake.RosterRead = () => null;
            Expect(CouchCoopGameFacts.ReadSessionFacts(true).Roster is null, "an unreadable roster stays null: unavailable, not empty");

            fake.RosterRead = Roster;
            fake.CapRead = () => throw new MissingFieldException("the game moved");
            var again = CouchCoopGameFacts.ReadSessionFacts(true);
            Expect(again.Roster == Roster() && again.LobbyCap is null, "a throwing cap read is no cap known and keeps the roster");
        });
    }

    private sealed class HollowMainThread(bool throws) : IGameMainThread
    {
        public T Invoke<T>(Func<T> action) => throws ? throw new InvalidOperationException("no main thread") : default!;

        public Task<T> InvokeAsync<T>(Func<Task<T>> action) => Task.FromResult(default(T)!);
    }

    private static void AFailedOrEmptyMarshalIsUnavailable()
    {
        var previous = GameMainThread.Source;
        var fake = new CouchCoopGameFactsTests.FakeFacts { RosterRead = Roster, CapRead = () => 4 };
        try
        {
            foreach (var throws in new[] { true, false })
            {
                GameMainThread.Source = new HollowMainThread(throws);
                CouchCoopGameFactsTests.WithSource(fake, () =>
                {
                    var read = CouchCoopGameFacts.ReadSessionFacts(withLobbyCap: true);
                    Expect(read.Roster is null && read.LobbyCap is null,
                        throws ? "a marshal that throws is unavailable" : "a dispatcher that hands nothing back is unavailable");
                });
            }
        }
        finally
        {
            GameMainThread.Source = previous;
        }
    }

    private static void NoEngineReadsNothing()
    {
        Expect(!CouchCoop.Mod.CouchCoopMod.EngineAvailable, "this process has no engine");
        // The production reader, behind the front, with the zero-client tripwire quiet (its own suite owns those counters).
        CouchCoopGameFactsTests.WithSource(GameFactsReader.Instance, () =>
        {
            var read = CouchCoopGameFacts.ReadSessionFacts(withLobbyCap: true);
            Expect(read.Roster is null && read.LobbyCap is null, "no engine: nothing is read, and nothing is claimed about the game");
        });
    }

    private static void TheCapIsJudgedAsMaxCouchSeatsJudgesIt()
    {
        CouchCoopLobbyParticipation.ResetLobbyCapNotice();
        Expect(CouchCoopLobbyParticipation.MaxCouchSeatsOf(null) is null, "no cap known is no seat count");
        Expect(CouchCoopLobbyParticipation.MaxCouchSeatsOf(4) == 3, "a stock lobby has three couch seats beside the host");
        Expect(CouchCoopLobbyParticipation.MaxCouchSeatsOf(16) == 15, "a raised cap opens more");
        Expect(CouchCoopLobbyParticipation.MaxCouchSeatsOf(1) is null, "a one-player cap is not a lobby anyone can join");
        Expect(CouchCoopLobbyParticipation.MaxCouchSeatsOf(-1) is null && CouchCoopLobbyParticipation.MaxCouchSeatsOf(0) is null,
            "an unusable cap is unknown, never a guess");

        // It feeds the same notice MaxLobbyPlayers does: a cap that stays unreadable across the grace is said once.
        var origin = new DateTimeOffset(2026, 9, 26, 12, 0, 0, TimeSpan.Zero);
        var previousError = Console.Error;
        var said = new StringWriter();
        Console.SetError(said);
        try
        {
            CouchCoopLobbyParticipation.ResetLobbyCapNotice();
            CouchCoopLobbyParticipation.LobbyCapClock = () => origin;
            _ = CouchCoopLobbyParticipation.MaxCouchSeatsOf(-1);
            CouchCoopLobbyParticipation.LobbyCapClock = () => origin + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace;
            _ = CouchCoopLobbyParticipation.MaxCouchSeatsOf(-1);
        }
        finally
        {
            Console.SetError(previousError);
            CouchCoopLobbyParticipation.ResetLobbyCapNotice();
            CouchCoopLobbyParticipation.LobbyCapClock = () => DateTimeOffset.UtcNow;
        }

        Expect(said.ToString().Contains("WITHOUT a known cap", StringComparison.Ordinal),
            "a cap read for the seat table still feeds the unreadable-cap notice");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"SessionFactsTests failed: {because}");
        }
    }
}
