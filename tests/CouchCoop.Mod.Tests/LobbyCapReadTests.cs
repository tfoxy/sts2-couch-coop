using System.Reflection;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Multiplayer.Game.Lobby;
using MegaCrit.Sts2.Core.Multiplayer.Messages.Lobby;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Saves.Runs;
using Spirectl.Sts2.Core.State;

// The lobby's player cap, read without a full game-state snapshot (WP3 path 5).
//
// The cap sizes browser admission (a socket ceiling per WebSocket upgrade), the seat allocator's slot range, and,
// at host start, the ENet listener. It used to be `CurrentState()?.CharacterSelect?.Lobby.MaxPlayers`, a whole
// snapshot for one integer, once per upgrade. It is now `CouchCoopGameFacts.ReadLobbyCap()`: the current lobby
// screen's own cap, read on the main thread from whichever thread asks. Nothing here can construct a lobby screen
// (a test process that does segfaults), so each piece runs through the seam that stands where the game would: a
// fake reader behind the front, plain objects for screens, and reflection over the game build's metadata for the
// one member the reader has to look up by name.
internal static class LobbyCapReadTests
{
    public static void Run()
    {
        FrontReturnsTheReaderAnswer();
        FrontLogsAFailureOnceAndRecovers();
        ProductionReaderIsUnavailableWithoutAnEngine();
        UnknownStaysUnknownAndUsableCapsPass();
        NoLobbyLeavesTheNoticeAlone();
        AdmissionCeilingFollowsTheCapExactlyAsBefore();
        HostStartSizingReadsTheSameCapThroughTheSeam();
        HostStartReadIsAnAllowedZeroDemandRead();
        SavedRunCapIsTheSavesPlayerCount();
        ParityWithTheDeletedSnapshotRead();
        Console.WriteLine("LobbyCapReadTests: ok");
    }

    // ---- the seam ----------------------------------------------------------------------------------------

    // The one IGameFacts fake is CouchCoopGameFactsTests.FakeFacts; a cap fake is that with `CapRead` set.
    private static CouchCoopGameFactsTests.FakeFacts Cap(Func<int?> read) => new() { CapRead = read };

    // Runs `body` with the front pointed at `source`, the zero-client tripwire quiet unless a case arms it, the cap
    // notice reset (it is static and this suite drives it), and everything put back afterwards.
    private static void WithSource(IGameFacts source, Action body, bool armed = false)
    {
        var previous = CouchCoopGameFacts.Source;
        ZeroClientGuard.ResetForTests(armed);
        CouchCoopLobbyParticipation.ResetLobbyCapNotice();
        CouchCoopGameFacts.Source = source;
        try
        {
            body();
        }
        finally
        {
            CouchCoopGameFacts.Source = previous;
            CouchCoopLobbyParticipation.ResetLobbyCapNotice();
            ZeroClientGuard.ResetForTests();
        }
    }

    private static void FrontReturnsTheReaderAnswer()
    {
        var fake = Cap(() => 16);
        WithSource(fake, () =>
        {
            Expect(CouchCoopGameFacts.ReadLobbyCap() == 16 && fake.CapReads == 1, "the reader's cap comes back, one read");
        });

        var none = Cap(() => null);
        WithSource(none, () =>
        {
            Expect(CouchCoopGameFacts.ReadLobbyCap() is null, "no lobby reads as no cap");
        });
    }

    // A reader that throws is "no cap known" (null), never an exception on a listener thread, and one failing build
    // does not write a line per WebSocket upgrade: it says so once and again only after a read has worked.
    private static void FrontLogsAFailureOnceAndRecovers()
    {
        var fail = true;
        var fake = Cap(() => fail ? throw new MissingFieldException("the game moved") : 8);
        WithSource(fake, () =>
        {
            var log = CaptureStderr(() =>
            {
                Expect(CouchCoopGameFacts.ReadLobbyCap() is null, "a throwing reader is unavailable");
                Expect(CouchCoopGameFacts.ReadLobbyCap() is null, "and stays unavailable");
                Expect(CouchCoopGameFacts.ReadLobbyCap() is null, "on every read");
            });
            Expect(CountOf(log, "lobby cap read failed") == 1, $"three failures write one line (got: {log.Trim()})");
            Expect(log.Contains("MissingFieldException", StringComparison.Ordinal), "the line names what failed");

            fail = false;
            Expect(CouchCoopGameFacts.ReadLobbyCap() == 8, "a working read recovers");

            fail = true;
            var again = CaptureStderr(() => CouchCoopGameFacts.ReadLobbyCap());
            Expect(CountOf(again, "lobby cap read failed") == 1, "and a later failure is reported afresh");
        });
    }

    // The real reader in a process with no engine behind it answers "no cap" without touching a game type or the
    // main-thread dispatcher. Reaching either here is the exit-139 hazard, so this is also the guard's own test.
    private static void ProductionReaderIsUnavailableWithoutAnEngine()
    {
        Expect(!CouchCoop.Mod.CouchCoopMod.EngineAvailable, "this process has no engine");
        Expect(GameFactsReader.Instance.ReadLobbyCap() is null, "no engine: no cap");
        Expect(GameFactsReader.LobbyCapOfScreen(null) is null, "no screen: no cap");
        Expect(GameFactsReader.LobbyCapOfScreen(new object()) is null, "a screen that is not a lobby: no cap");
    }

    // ---- the decision the callers still make --------------------------------------------------------------

    // `LobbyCapOf` keeps its rule: a cap of 1 or less is not a usable one, and unknown fails open. Both the instance
    // method the seat allocator and limiter call and the static one the host transport calls go through it.
    private static void UnknownStaysUnknownAndUsableCapsPass()
    {
        (int? Reported, int? Expected)[] cases =
        [
            (null, null), (-1, null), (0, null), (1, null), (2, 2), (4, 4), (8, 8), (16, 16),
        ];

        foreach (var (reported, expected) in cases)
        {
            WithSource(Cap(() => reported), () =>
            {
                var participation = new CouchCoopLobbyParticipation(NoStateRuntimeHost());
                Expect(participation.MaxLobbyPlayers() == expected, $"MaxLobbyPlayers for a reported {Show(reported)}");
                Expect(CouchCoopLobbyParticipation.ReadMaxLobbyPlayers() == expected, $"ReadMaxLobbyPlayers for a reported {Show(reported)}");
                Expect(participation.MaxCouchSeats() == (expected - 1), $"MaxCouchSeats for a reported {Show(reported)}");
            });
        }
    }

    // No lobby screen on top says nothing about the cap: it must not start (or reset) the unreadable-cap notice, which
    // is about a lobby that IS there and will not say how many it fits.
    private static void NoLobbyLeavesTheNoticeAlone()
    {
        var at = new DateTimeOffset(2026, 9, 26, 12, 0, 0, TimeSpan.Zero);
        var previousClock = CouchCoopLobbyParticipation.LobbyCapClock;
        int? reported = -1;
        try
        {
            WithSource(Cap(() => reported), () =>
            {
                var now = at;
                CouchCoopLobbyParticipation.LobbyCapClock = () => now;
                var log = CaptureStderr(() =>
                {
                    _ = CouchCoopLobbyParticipation.ReadMaxLobbyPlayers();
                    reported = null;
                    now = at + CouchCoopLobbyParticipation.UnreadableLobbyCapGrace + TimeSpan.FromMinutes(1);
                    _ = CouchCoopLobbyParticipation.ReadMaxLobbyPlayers();
                });
                Expect(!log.Contains("WITHOUT a known cap", StringComparison.Ordinal),
                    "a read that finds no lobby is not evidence the lobby's cap stayed unreadable");
            });
        }
        finally
        {
            CouchCoopLobbyParticipation.LobbyCapClock = previousClock;
        }
    }

    // ---- browser admission --------------------------------------------------------------------------------

    // The limiter as the browser server wires it: the ceiling per WebSocket upgrade is four sockets per player the
    // game will admit, floored at 32, and an unknown cap is the floor. One cap read per upgrade, and the ceiling
    // follows the live answer.
    private static void AdmissionCeilingFollowsTheCapExactlyAsBefore()
    {
        (int? Reported, int Ceiling)[] cases = [(null, 32), (1, 32), (4, 32), (8, 32), (9, 36), (20, 80)];
        foreach (var (reported, ceiling) in cases)
        {
            var fake = Cap(() => reported);
            WithSource(fake, () =>
            {
                var host = NoStateRuntimeHost();
                var limiter = new NetworkAdmissionLimiter(() => new CouchCoopLobbyParticipation(host).MaxLobbyPlayers());
                var leases = new List<NetworkAdmissionLimiter.Lease>();
                for (var index = 0; index < ceiling; index++)
                {
                    var lease = limiter.TryAcquireWebSocket();
                    Expect(lease is not null, $"socket {index + 1} of {ceiling} is admitted (reported {Show(reported)})");
                    leases.Add(lease!);
                }

                Expect(limiter.TryAcquireWebSocket() is null, $"socket {ceiling + 1} is refused (reported {Show(reported)})");
                Expect(fake.CapReads == ceiling + 1, $"one cap read per upgrade attempt (reported {Show(reported)}, got {fake.CapReads})");
                leases[0].Dispose();
                Expect(limiter.TryAcquireWebSocket() is { } recovered && Dispose(recovered), "a released socket's place is reusable");
                foreach (var lease in leases.Skip(1)) lease.Dispose();
            });
        }

        // A cap raised while the host runs raises the very next ceiling: nothing is remembered between upgrades.
        var live = 8;
        WithSource(Cap(() => live), () =>
        {
            var host = NoStateRuntimeHost();
            var limiter = new NetworkAdmissionLimiter(() => new CouchCoopLobbyParticipation(host).MaxLobbyPlayers());
            var held = Enumerable.Range(0, 32).Select(_ => limiter.TryAcquireWebSocket()).ToArray();
            Expect(held.All(lease => lease is not null), "eight players admit thirty-two sockets");
            Expect(limiter.TryAcquireWebSocket() is null, "and no more");
            live = 16;
            Expect(limiter.TryAcquireWebSocket() is { } raised && Dispose(raised), "a limit mod raising the cap raises the ceiling at once");
            foreach (var lease in held) lease?.Dispose();
        });
    }

    // ---- host start ---------------------------------------------------------------------------------------

    // The ENet listener's sizing reads the same cap through the same seam: only ever raises, never invents one.
    private static void HostStartSizingReadsTheSameCapThroughTheSeam()
    {
        (int? Reported, int Requested, int Expected, string Why)[] cases =
        [
            (16, 4, 16, "a lobby that admits more than the request raises it"),
            (8, 8, 8, "an equal cap changes nothing"),
            (2, 8, 8, "a smaller cap never shrinks a limit mod's raise"),
            (null, 8, 8, "no lobby leaves the request alone"),
            (1, 4, 4, "a cap of one is unknown, not a shrink"),
        ];

        foreach (var (reported, requested, expected, why) in cases)
        {
            var fake = Cap(() => reported);
            WithSource(fake, () => WithProbe(CouchCoopHostTransport.ReadLobbyCapAtHostStart, () =>
            {
                Expect(CouchCoopHostTransport.Capacity.Resolve(requested) == expected, why);
                Expect(fake.CapReads == 1, $"one cap read per host start ({why})");
                Expect(CouchCoopHostTransport.EffectiveMaxClients == expected, $"the decision is recorded ({why})");
            }));
        }

        WithSource(Cap(() => throw new InvalidOperationException("the game moved")), () => WithProbe(
            CouchCoopHostTransport.ReadLobbyCapAtHostStart,
            () => Expect(CouchCoopHostTransport.Capacity.Resolve(8) == 8, "an unreadable cap leaves the request alone")));
    }

    // The one read that runs with nobody connected is named, and it is the ONLY thing excused: the same read outside
    // the host-start scope is idle work like any other.
    private static void HostStartReadIsAnAllowedZeroDemandRead()
    {
        var fake = Cap(() => 4);
        WithSource(fake, () =>
        {
            _ = CouchCoopHostTransport.ReadLobbyCapAtHostStart();
            Expect(ZeroClientGuard.Violations == 0, "the host-start read is excused, not reported");
            Expect(ZeroClientAllowances.HostTransportSizing.Hits >= 1, "and the allowance that excused it is the named one");
            Expect(ZeroClientEntries.HostFactsRead.Hits == 0, "it is not counted as a stray facts read");

            _ = CouchCoopGameFacts.ReadLobbyCap();
            Expect(ZeroClientGuard.Violations == 1 && ZeroClientEntries.HostFactsRead.Hits == 1,
                "the same read outside that scope, with nobody connected, is idle work");
        }, armed: true);

        // With a client connected there is demand, and the read is not the tripwire's business.
        WithSource(Cap(() => 4), () =>
        {
            ZeroClientGuard.ClientOpened();
            _ = CouchCoopGameFacts.ReadLobbyCap();
            Expect(ZeroClientGuard.Violations == 0, "an upgrade's own cap read has demand by definition");
            ZeroClientGuard.ClientClosed();
        }, armed: true);
    }

    // ---- the saved-run lobby ------------------------------------------------------------------------------

    // That lobby admits exactly the players in its save, so its cap is that count. The screen exposes nothing, so
    // what its initializer was handed is recorded (see LobbyAssignmentRecord) and counted at read time.
    private static void SavedRunCapIsTheSavesPlayerCount()
    {
        var host = new SerializableRun { Players = [new SerializablePlayer(), new SerializablePlayer(), new SerializablePlayer()] };
        Expect(GameFactsReader.SavedRunPlayerCount(host) == 3, "a hosted save's cap is its player count");

        var response = new ClientLoadJoinResponseMessage { serializableRun = host };
        Expect(GameFactsReader.SavedRunPlayerCount(response) == 3, "a client's join response carries the same save");
        Expect(GameFactsReader.SavedRunPlayerCount(new SerializableRun { Players = [] }) == 0, "an empty save reports zero, which is unknown");
        Expect(GameFactsReader.SavedRunPlayerCount(new ClientLoadJoinResponseMessage()) == 0, "a response with no save reports zero");
        Expect(GameFactsReader.SavedRunPlayerCount(new object()) is null, "anything else is no answer");

        // The record is per screen instance and keeps the payload untouched.
        var screen = new object();
        Expect(!LobbyAssignmentRecord.TryGetSavedRun(screen, out _), "nothing recorded before the game assigns a lobby");
        LobbyAssignmentRecord.RecordSavedRun(screen, host);
        Expect(LobbyAssignmentRecord.TryGetSavedRun(screen, out var payload) && ReferenceEquals(payload, host),
            "the payload is read back as recorded");
        Expect(!LobbyAssignmentRecord.TryGetSavedRun(new object(), out _), "another screen has its own (empty) answer");
        var another = new SerializableRun { Players = [new SerializablePlayer()] };
        LobbyAssignmentRecord.RecordSavedRun(screen, another);
        Expect(LobbyAssignmentRecord.TryGetSavedRun(screen, out payload) && ReferenceEquals(payload, another),
            "a later assignment on the same screen replaces the earlier one");
    }

    // ---- parity with the deleted read (TEST ONLY) ---------------------------------------------------------
    //
    // DELETE THIS SECTION WITH `ProjectCap` WHEN THE LAST WP3 READ PATH LANDS. It exists so the move from the state
    // snapshot to the typed reader is provably a no-op on every fixture the suite already owns: `ProjectCap` reads a
    // snapshot the way the typed reader reports the same game, and `OldMaxLobbyPlayers` is the retired method verbatim.

    /// <summary>The cap the typed reader would report for the game a snapshot describes.</summary>
    internal static int? ProjectCap(StateSnapshot? state) => state?.CharacterSelect?.Lobby.MaxPlayers;

    private static int? OldMaxLobbyPlayers(StateSnapshot? state)
        => state?.CharacterSelect?.Lobby is { } lobby ? CouchCoopLobbyParticipation.LobbyCapOf(lobby.MaxPlayers) : null;

    private static StateSnapshot WithCap(StateSnapshot state, int cap)
        => state with { CharacterSelect = state.CharacterSelect! with { Lobby = state.CharacterSelect.Lobby with { MaxPlayers = cap } } };

    private static IEnumerable<(StateSnapshot? State, string What)> CapFixtures()
    {
        foreach (var fixture in CouchCoopLobbyHostGateTests.Fixtures())
        {
            yield return fixture;
        }

        foreach (var cap in new[] { -1, 0, 1, 2, 3, 4, 8, 16, 99 })
        {
            yield return (WithCap(CouchCoopLobbyHostGateTests.Lobby("host"), cap), $"host lobby capped at {cap}");
        }

        // The saved-run lobby's snapshot cap is its saved roster; the typed reader reports the save's player count.
        foreach (var players in new[] { 1, 2, 3, 4 })
        {
            var saved = new StateCharacterSelectSavedRunSnapshot(
                CurrentActIndex: 0,
                ActFloor: 3,
                Players: Enumerable.Range(0, players)
                    .Select(index => new StateCharacterSelectSavedRunPlayerSnapshot($"p:{1000 + index}", 40, 80, 120))
                    .ToArray());
            yield return (WithCap(CouchCoopLobbyHostGateTests.Lobby("host", saved), players), $"saved-run lobby of {players}");
        }
    }

    private static void ParityWithTheDeletedSnapshotRead()
    {
        var count = 0;
        foreach (var (state, what) in CapFixtures())
        {
            CouchCoopLobbyParticipation.ResetLobbyCapNotice();
            var old = OldMaxLobbyPlayers(state);

            int? fresh = null;
            var fake = Cap(() => ProjectCap(state));
            WithSource(fake, () => fresh = CouchCoopLobbyParticipation.ReadMaxLobbyPlayers());

            Expect(fake.CapReads == 1, $"the typed side asked once on {what}");
            Expect(fresh == old, $"cap parity on {what} (old {Show(old)}, typed {Show(fresh)})");
            count++;
        }

        // 14 shared gate fixtures + 9 capped host lobbies + 4 saved-run lobbies.
        Expect(count == 27, $"the parity oracle covered every fixture (got {count})");

        // The projection is only an oracle if it agrees with what the reader really emits, written out by hand.
        Expect(ProjectCap(CouchCoopLobbyHostGateTests.MainMenu()) is null, "main menu has no lobby cap");
        Expect(ProjectCap(CouchCoopLobbyHostGateTests.RunInProgress("host")) is null, "a run has no lobby cap");
        Expect(ProjectCap(WithCap(CouchCoopLobbyHostGateTests.Lobby("host"), 16)) == 16, "a 16-player lobby reports 16");
        Expect(ProjectCap(null) is null, "no state is no cap");
    }

    // ---- the member the reader looks up by name (pinned against the installed game build) ------------------

    // Pure metadata reflection over the STS2 assemblies this build was compiled against: no Harmony install, no game.
    // Internal because the `beta-targets` verb runs this leg rather than a copy.
    internal static void LobbyCapMemberResolves()
    {
#if STS2_API_V111
        // The one by-name read (a granted exception): the private field must exist, be an instance int, and be the
        // one the reader names. A build that renames or retypes it fails here instead of reading nothing at run time.
        var field = AccessTools.Field(typeof(StartRunLobby), GameFactsReader.LobbyCapMemberName);
        Expect(field is not null, $"StartRunLobby.{GameFactsReader.LobbyCapMemberName} resolves (the lobby's live player cap)");
        Expect(!field!.IsStatic && field.FieldType == typeof(int), "…and is an instance int");
        Expect(field.DeclaringType == typeof(StartRunLobby), "…declared by the lobby itself, not a base type");
        Expect(GameFactsReader.LobbyCapMemberName == LobbyCapTargets.FieldName, "the reader and the metadata lane name the same member");
        // Nothing public is expected to replace it; if one appears this pin is the place that says so.
        Expect(typeof(StartRunLobby).GetProperty("MaxPlayers", BindingFlags.Instance | BindingFlags.Public) is null,
            "the lane has no public MaxPlayers, which is why the read is by name (if this fails, drop the by-name read)");
#else
        // The public property the reader calls directly is compile-checked; pin that it is still a readable int.
        var property = typeof(StartRunLobby).GetProperty("MaxPlayers", BindingFlags.Instance | BindingFlags.Public);
        Expect(property is { CanRead: true } && property.PropertyType == typeof(int), "StartRunLobby.MaxPlayers is a public readable int");
        Expect(property!.GetMethod!.Name == LobbyCapTargets.PropertyGetterName, "the metadata lane names the same getter");
#endif
        // Both lanes: the saved-run lobby's cap comes from the save's players, typed.
        Expect(typeof(SerializableRun).GetProperty("Players")?.PropertyType == typeof(List<SerializablePlayer>),
            "SerializableRun.Players is the saved roster");
        Expect(typeof(ClientLoadJoinResponseMessage).GetField("serializableRun")?.FieldType == typeof(SerializableRun),
            "the join response carries the save");
        Expect(LobbyCapTargets.StartRunLobbyType == typeof(StartRunLobby).FullName, "the metadata lane names the lobby type");
    }

    // ---- helpers ------------------------------------------------------------------------------------------

    private static void WithProbe(Func<int?>? probe, Action body)
    {
        var previous = CouchCoopHostTransport.MaxLobbyPlayersProbe;
        CouchCoopHostTransport.MaxLobbyPlayersProbe = probe;
        try
        {
            body();
        }
        finally
        {
            CouchCoopHostTransport.MaxLobbyPlayersProbe = previous;
            CouchCoopHostTransport.ResetTransportState();
        }
    }

    // A runtime host that answers no state at all. The cap no longer comes from it, so the cases that hold one are
    // showing that nothing they assert depends on it (the route test counts the snapshot reads outright).
    private static CouchCoopRuntimeHost NoStateRuntimeHost()
    {
        var stub = new AssetCacheTokenEnvelopeTests.StubRuntime("test-game");
        return new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(stub, stub, stub, stub, stub, stub, stub, stub, stub, stub));
    }

    private static bool Dispose(IDisposable lease)
    {
        lease.Dispose();
        return true;
    }

    private static string Show(int? value) => value?.ToString() ?? "null";

    private static int CountOf(string text, string needle)
    {
        var count = 0;
        for (var at = text.IndexOf(needle, StringComparison.Ordinal); at >= 0; at = text.IndexOf(needle, at + 1, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private static string CaptureStderr(Action body)
    {
        var previous = Console.Error;
        var captured = new StringWriter();
        Console.SetError(captured);
        try
        {
            body();
        }
        finally
        {
            Console.SetError(previous);
        }

        return captured.ToString();
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"LobbyCapReadTests failed: {because}");
        }
    }
}
