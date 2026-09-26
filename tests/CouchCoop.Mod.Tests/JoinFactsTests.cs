using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Tests;
using CouchCoop.MirrorProtocol.Envelopes;
using Spirectl.Sts2.Embedding;

// A browser join's read of the game (WP3 path 4) and the seat wait's membership check (WP3 path 6), both made from
// CouchCoop's own typed facts instead of a full game-state snapshot.
//
// What must hold, and where it is pinned:
//   * the join context equals what the retired snapshot read produced, on every fixture the suites already share
//     (the parity oracle below, TEST ONLY): the spawn window, the host's name, which netIds already hold a seat (the
//     live lobby's, the saved run's absent ones, a dropped seat's) and the names published to the seats;
//   * an unreadable roster is the EMPTY context, exactly what a failed snapshot gave: no run, no spawn window, no host
//     name, no seat table;
//   * the seat facts (how many couch seats the lobby has room for, whether a run is live) follow the lobby's cap, which a
//     multiplayer limit mod can raise between two joins, and an unknown cap is UNKNOWN, never a small number;
//   * a join asks the game ONCE: the roster and the cap in a single hop onto the main thread, run presence beside
//     them, and the seat manager is handed what was read instead of asking its own probes again;
//   * lobby membership (the seat wait) and peer connectivity (the monitor) are answered from the roster, with no state
//     snapshot, including on the game's own ENet host path where CouchCoop's transport is not the running host.
//
// The production reader needs an engine, which a test process must never reach (it faults in native code), so it is
// exercised through the seam that stands where the game would: CouchCoopGameFactsTests.FakeFacts.
internal static class JoinFactsTests
{
    public static async Task RunAsync()
    {
        TheContextKeepsTheRulesTheRetiredReadHad();
        AnUnreadableRosterIsTheEmptyContext();
        SeatFactsFollowTheLobbyCap();
        AJoinAsksTheGameOnceInOneHop();
        AJoinContextAloneIsOneRosterRead();
        await TheSeatManagerIsHandedTheFactsItWouldHaveProbed();
        await AManagerWithoutProbesStaysUnprobed();
        await ALaunchRefusalFromHandedFactsCostsNothing();
        MembershipUsesTypedRoster();
        MembershipIsOneRosterReadAndNoStateSnapshot();
        SeatPeerFallbackIsOneHopAndNoStateSnapshot();
        SeatPeerFallbackSurvivesAFailingMainThread();
        await TheJoinWaitAndTheMonitorBuildNoStateSnapshot();
        Console.WriteLine("JoinFactsTests: ok");
    }

    private static void SameContext(
        CouchCoopLobbyParticipation.MirrorJoinContext old,
        CouchCoopLobbyParticipation.MirrorJoinContext fresh,
        string what)
    {
        Expect(old.IsSingleplayerRun == fresh.IsSingleplayerRun, $"singleplayer parity on {what}");
        Expect(old.SpawnAllowed == fresh.SpawnAllowed, $"spawn-window parity on {what}");
        Expect(old.HostName == fresh.HostName, $"host-name parity on {what} (old '{old.HostName}', new '{fresh.HostName}')");
        Expect((old.SeatNetIds is null) == (fresh.SeatNetIds is null), $"seat-table presence parity on {what}");
        Expect(old.SeatNetIds is null || old.SeatNetIds.SetEquals(fresh.SeatNetIds!),
            $"seat-table parity on {what}: [{Show(old.SeatNetIds)}] vs [{Show(fresh.SeatNetIds)}]");
        Expect((old.RosterNames is null) == (fresh.RosterNames is null), $"names presence parity on {what}");
        Expect(old.RosterNames is null || old.RosterNames.SequenceEqual(fresh.RosterNames!),
            $"names parity on {what}: [{string.Join(", ", old.RosterNames ?? [])}] vs [{string.Join(", ", fresh.RosterNames ?? [])}]");
        foreach (var netId in new ulong[] { 1, 1002, 1003, 1004, 76561198000000123UL })
        {
            Expect(old.MayRejoinNetId(netId) == fresh.MayRejoinNetId(netId), $"reclaim parity for {netId} on {what}");
        }
    }

    private static string Show(IReadOnlySet<ulong>? set) => set is null ? "none" : string.Join(",", set.Order());

    // The parity above only means something if the oracle agrees with what the rules actually are, so the rules that
    // matter are also written out by hand, one situation each.
    private static RosterFacts LobbyRoster(string netType = "host", string hostName = "Hosty", bool saved = false,
        bool seatConnected = true, bool includeHost = true)
        => new(saved ? RosterRootScenes.LoadGame : RosterRootScenes.CharacterSelect,
            new RosterLobby(netType, "p:1", saved,
                [.. (includeHost ? new[] { new RosterLobbySeat("p:1", hostName, "ironclad", true) } : []),
                 new RosterLobbySeat("p:1002", "Ann", "silent", seatConnected)],
                saved ? ["p:1", "p:1002", "p:1003"] : []), null);

    private static RosterFacts SavedLobbyRoster(bool seatConnected = true)
        => LobbyRoster(saved: true, seatConnected: seatConnected);

    private static RosterFacts RunRoster(string netType = "host", string hostName = "Hosty", bool seatConnected = true)
        => new(RosterRootScenes.Run, null,
            new RosterRun(netType, "p:1",
                [new RosterRunSeat("p:1", hostName, "ironclad", true, true),
                 new RosterRunSeat("p:1002", "Ann", "silent", false, seatConnected)]));

    private static CouchCoopLobbyParticipation.MirrorJoinContext Context(RosterFacts? roster)
        => CouchCoopLobbyParticipation.DescribeMirrorJoinContext(roster);

    private static void TheContextKeepsTheRulesTheRetiredReadHad()
    {
        Expect(Context(LobbyRoster()).SpawnAllowed, "a host lobby opens the spawn window");
        Expect(!Context(LobbyRoster("client")).SpawnAllowed, "a client lobby cannot spawn");
        Expect(!Context(LobbyRoster("singleplayer")).SpawnAllowed, "a singleplayer lobby cannot spawn");
        var hostRun = Context(RunRoster());
        Expect(!hostRun.SpawnAllowed && !hostRun.IsSingleplayerRun, "a multiplayer run closes the spawn window");
        Expect(Context(RunRoster("singleplayer")).IsSingleplayerRun, "a singleplayer run is identified");
        Expect(Context(RunRoster(hostName: "  Hosty  ")).HostName == "Hosty", "the host name is trimmed");
        Expect(Context(RunRoster(hostName: "   ")).HostName is null, "a blank host name is absent");
        Expect(Context(LobbyRoster(includeHost: false)).HostName is null, "a host absent from the lobby has no name");
        var both = LobbyRoster() with { Run = RunRoster().Run };
        Expect(!Context(both).SpawnAllowed, "a run starting under its lobby screen closes the spawn window");
        var saved = Context(SavedLobbyRoster(seatConnected: false));
        Expect(saved.MayRejoinNetId(1002) && saved.MayRejoinNetId(1003) && !saved.MayRejoinNetId(1004),
            "saved and dropped seats may rejoin, strangers may not");
        Expect(saved.SpawnAllowed, "a saved-run host lobby opens the spawn window");
        Expect(hostRun.MayRejoinNetId(1002) && !hostRun.MayRejoinNetId(1003), "run seats are reclaimable");
        Expect(hostRun.RosterNames is { } names && names.SequenceEqual(new (ulong, string)[] { (1, "Hosty"), (1002, "Ann") }),
            "roster names ride the join context");
        var menu = Context(new RosterFacts(RosterRootScenes.MainMenu, null, null));
        Expect(!menu.IsSingleplayerRun && !menu.SpawnAllowed && menu.HostName is null && menu.SeatNetIds is null,
            "the main menu is an empty context");
    }

    // What the retired read did when it could not build a snapshot: `CurrentState()` was null (no state capability, or a
    // failed read), so no branch matched and the join got an empty context. The roster's "unavailable" is null, and it
    // must land in exactly that place, however the read fails.
    private static void AnUnreadableRosterIsTheEmptyContext()
    {
        var old = new CouchCoopLobbyParticipation.MirrorJoinContext(false, false, null);
        SameContext(old, CouchCoopLobbyParticipation.DescribeMirrorJoinContext((RosterFacts?)null), "a null roster");
        Expect(old.SeatNetIds is null && old.RosterNames is null, "the retired failed read carried no seat table and no names");
        Expect(!old.MayRejoinNetId(1002), "…so no seat could be reclaimed");

        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
        var lobby = new CouchCoopLobbyParticipation(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
            runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));
        var fake = new CouchCoopGameFactsTests.FakeFacts { RosterRead = () => null };
        CouchCoopGameFactsTests.WithSource(fake, () =>
        {
            SameContext(old, lobby.DescribeMirrorJoinContext(), "an unreadable roster through the instance");
            fake.RosterRead = () => throw new InvalidOperationException("the game moved");
            SameContext(old, lobby.DescribeMirrorJoinContext(), "a throwing reader through the instance, which never escapes");
            var join = lobby.DescribeJoin();
            SameContext(old, join.Context, "an unreadable roster through the join read");
            Expect(join.Seats == new JoinSeatFacts(null, false), "…with no known cap and no run");
        });

        // No engine behind the process: the production reader answers unavailable, so a host with no game reads the same.
        Expect(!CouchCoop.Mod.CouchCoopMod.EngineAvailable, "this process has no engine");
        CouchCoopGameFactsTests.WithSource(GameFactsReader.Instance, () =>
        {
            SameContext(old, lobby.DescribeMirrorJoinContext(), "the production reader with no engine");
            var join = lobby.DescribeJoin();
            SameContext(old, join.Context, "…through the join read");
            Expect(join.Seats == new JoinSeatFacts(null, false), "…which knows no cap and no run");
        });
    }

    // ---- the seat facts --------------------------------------------------------------------------------------

    private static void SeatFactsFollowTheLobbyCap()
    {
        CouchCoopLobbyParticipation.ResetLobbyCapNotice();
        try
        {
            Expect(SeatsFor(4).MaxCouchSeats == 3, "the stock four-player lobby has room for three couch seats");
            Expect(SeatsFor(8).MaxCouchSeats == 7, "a limit mod's eight players leave seven");
            Expect(SeatsFor(16).MaxCouchSeats == 15, "…and sixteen leave fifteen");
            Expect(SeatsFor(2).MaxCouchSeats == 1, "a two-player lobby leaves one");
            foreach (var unusable in new[] { -1, 0, 1 })
            {
                Expect(SeatsFor(unusable).MaxCouchSeats is null, $"a reported cap of {unusable} is UNKNOWN, not a tiny lobby");
            }

            Expect(SeatsFor(null).MaxCouchSeats is null, "no lobby screen, no cap: unknown");
            Expect(CouchCoopLobbyParticipation.DescribeJoin(new JoinRead(null, 4), runInProgress: true).Seats == new JoinSeatFacts(3, true),
                "run presence passes through beside the cap");
            Expect(CouchCoopLobbyParticipation.DescribeJoin(new JoinRead(null, null), runInProgress: false).Seats == new JoinSeatFacts(null, false),
                "and an unreadable game is unknown and not in a run");

            // A limit mod raises the cap AFTER the mod is built, so each join must ask again: a value kept from an earlier
            // read would keep a fifth player out of a sixteen-player lobby.
            var cap = 4;
            var fake = new CouchCoopGameFactsTests.FakeFacts { RosterRead = () => null, CapRead = () => cap, RunRead = () => false };
            var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
            var lobby = new CouchCoopLobbyParticipation(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
                runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));
            CouchCoopGameFactsTests.WithSource(fake, () =>
            {
                Expect(lobby.DescribeJoin().Seats.MaxCouchSeats == 3, "the first join sees the stock cap");
                cap = 16;
                Expect(lobby.DescribeJoin().Seats.MaxCouchSeats == 15, "a later join sees the raised cap");
                Expect(fake.CapReads == 2, "one cap read per join");
            });
        }
        finally
        {
            CouchCoopLobbyParticipation.ResetLobbyCapNotice();
        }
    }

    private static JoinSeatFacts SeatsFor(int? cap)
        => CouchCoopLobbyParticipation.DescribeJoin(new JoinRead(null, cap), runInProgress: false).Seats;

    // ---- what it costs -----------------------------------------------------------------------------------------

    // A stand-in for the game's main thread that counts HOPS: a call from off it is one hop, and a call already on it
    // (the dispatcher's own contract) runs inline and counts nothing.
    private sealed class HopCounter : IGameMainThread
    {
        [ThreadStatic]
        private static bool _onMainThread;

        private int _hops;

        public int Hops => Volatile.Read(ref _hops);

        public T Invoke<T>(Func<T> action)
        {
            if (_onMainThread)
            {
                return action();
            }

            Interlocked.Increment(ref _hops);
            _onMainThread = true;
            try
            {
                return action();
            }
            finally
            {
                _onMainThread = false;
            }
        }

        public Task<T> InvokeAsync<T>(Func<Task<T>> action) => Task.Run(() => Invoke(() => action().GetAwaiter().GetResult()));
    }

    private static T WithHops<T>(HopCounter hops, Func<T> body)
    {
        var previous = GameMainThread.Source;
        GameMainThread.Source = hops;
        try
        {
            return body();
        }
        finally
        {
            GameMainThread.Source = previous;
        }
    }

    private static CouchCoopLobbyParticipation NewLobby(BrowserServerRouteTests.RecordingSpirectlRuntime runtime)
        => new(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
            runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));

    private static RosterFacts HostLobbyRoster()
        => LobbyRoster();

    private static void AJoinAsksTheGameOnceInOneHop()
    {
        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
        var lobby = NewLobby(runtime);
        var fake = new CouchCoopGameFactsTests.FakeFacts { RosterRead = HostLobbyRoster, CapRead = () => 4, RunRead = () => false };
        var hops = new HopCounter();
        var callerThread = Environment.CurrentManagedThreadId;
        CouchCoopLobbyParticipation.JoinDescription join = default;
        CouchCoopGameFactsTests.WithSource(fake, () => join = WithHops(hops, () => lobby.DescribeJoin()));

        Expect(join.Context.SpawnAllowed && join.Context.HostName == "Hosty", "the context is read from the roster");
        Expect(join.Seats == new JoinSeatFacts(3, false), "the seat facts are read from the cap and run presence");
        Expect(fake.RosterReads == 1 && fake.CapReads == 1 && fake.RunReads == 1,
            $"one read each of the roster, the cap and run presence (got {fake.RosterReads}/{fake.CapReads}/{fake.RunReads})");
        Expect(hops.Hops == 1, $"the roster and the cap share ONE hop onto the main thread (got {hops.Hops})");
        Expect(fake.RunReadThread == callerThread, "run presence is a plain member read on the caller's thread, with no hop of its own");
    }

    private static void AJoinContextAloneIsOneRosterRead()
    {
        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
        var lobby = NewLobby(runtime);
        var fake = new CouchCoopGameFactsTests.FakeFacts { RosterRead = HostLobbyRoster, CapRead = () => 4, RunRead = () => false };
        var hops = new HopCounter();
        CouchCoopGameFactsTests.WithSource(fake, () => WithHops(hops, () => lobby.DescribeMirrorJoinContext()));
        Expect(fake.RosterReads == 1 && fake.CapReads == 0 && fake.RunReads == 0, "the context alone is one roster read and nothing else");
        Expect(hops.Hops == 1, "…in one hop");
    }

    // ---- the seat manager takes what the join read -------------------------------------------------------------

    private sealed class CountingProbes
    {
        private int _cap;
        private int _run;

        public int CapProbes => Volatile.Read(ref _cap);
        public int RunProbes => Volatile.Read(ref _run);
        public int? Cap { get; set; } = 5;
        public bool Run { get; set; }

        public int? ProbeCap()
        {
            Interlocked.Increment(ref _cap);
            return Cap;
        }

        public bool ProbeRun()
        {
            Interlocked.Increment(ref _run);
            return Run;
        }
    }

    private sealed class FakeProcess(int slot) : IHeadlessProcess
    {
        public int Id => 30000 + slot;
        public bool HasExited { get; private set; }
        public int ExitCode => 0;
        public void ForceExit() => HasExited = true;
        public bool RequestGracefulStop() { HasExited = true; return true; }
        public void Kill() => HasExited = true;
        public void Dispose() { }
    }

    private static HeadlessClientManager NewManager(CountingProbes probes, List<FakeProcess> spawned)
        => new(
            launcher: slot =>
            {
                var process = new FakeProcess(slot);
                spawned.Add(process);
                return process;
            },
            readinessProbe: (_, _) => Task.FromResult(true),
            maxSeatsProbe: probes.ProbeCap,
            runInProgressProbe: probes.ProbeRun);

    private static async Task TheSeatManagerIsHandedTheFactsItWouldHaveProbed()
    {
        var probes = new CountingProbes { Cap = 5 };
        var spawned = new List<FakeProcess>();
        using var manager = NewManager(probes, spawned);

        // Facts handed in: the manager asks its probes nothing, and sizes the seat range from THEM, not from what a probe
        // would have said. One couch seat (a two-player lobby) leaves room for exactly one name.
        var facts = new JoinSeatFacts(MaxCouchSeats: 1, RunInProgress: false);
        var first = await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, hostFacts: facts);
        var second = await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Bea", default, hostFacts: facts);
        Expect(first == HeadlessClientManager.SlotToPort(2), "the first name gets the seat the handed cap allows");
        Expect(second is null, "the second finds the range full: the handed cap won over the probe's five");
        Expect(probes.CapProbes == 0 && probes.RunProbes == 0, "the manager asked its probes nothing");

        // Without facts the manager asks its own probes, once each, exactly as it always did.
        var probesAlone = new CountingProbes { Cap = 5 };
        var spawnedAlone = new List<FakeProcess>();
        using var alone = NewManager(probesAlone, spawnedAlone);
        var port = await alone.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Expect(port == HeadlessClientManager.SlotToPort(2), "a caller with no facts still gets a seat");
        Expect(probesAlone.CapProbes == 1 && probesAlone.RunProbes == 1, "…from one ask of each probe");

        // An unknown cap opens the seat range as far as its guard band instead of refusing on a guess.
        var probesUnknown = new CountingProbes();
        using var wide = NewManager(probesUnknown, []);
        var unknown = new JoinSeatFacts(MaxCouchSeats: null, RunInProgress: false);
        for (var i = 0; i < 6; i++)
        {
            Expect(await wide.EnsureHeadlessAsync(Guid.NewGuid(), "Player" + i, default, hostFacts: unknown) is not null,
                $"an unknown cap refuses nobody (player {i + 1})");
        }
    }

    // A manager built with no probes is an UNPROBED one (a standalone server, most tests): the stock three seats and no
    // run refusal. Handing it facts must not turn it into a probed one.
    private static async Task AManagerWithoutProbesStaysUnprobed()
    {
        using var manager = new HeadlessClientManager(
            launcher: slot => new FakeProcess(slot),
            readinessProbe: (_, _) => Task.FromResult(true));
        var facts = new JoinSeatFacts(MaxCouchSeats: 1, RunInProgress: true);
        for (var i = 0; i < 3; i++)
        {
            Expect(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Player" + i, default, hostFacts: facts) is not null,
                $"an unprobed manager keeps the stock three seats whatever it is handed (player {i + 1})");
        }

        Expect(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Player3", default, hostFacts: facts) is null,
            "…and no fourth");
    }

    // The launch refusal (a seat whose process died is not relaunched into a run, because the host refuses the peer on
    // arrival) decided from the run presence the join handed over, with the manager's own probe never asked.
    private static async Task ALaunchRefusalFromHandedFactsCostsNothing()
    {
        var probes = new CountingProbes { Run = false };
        var spawned = new List<FakeProcess>();
        using var manager = NewManager(probes, spawned);
        var seats = new JoinSeatFacts(MaxCouchSeats: 3, RunInProgress: false);
        Expect(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, hostFacts: seats) is not null, "the seat is launched");
        spawned[0].ForceExit();

        var refused = await manager.EnsureHeadlessAsync(
            Guid.NewGuid(), "Ann", default, allowNewSlot: false, hostFacts: seats with { RunInProgress = true });
        Expect(refused is null && spawned.Count == 1, "in a run the dead seat is not relaunched, though the probe says no run");
        Expect(probes.CapProbes == 0 && probes.RunProbes == 0, "…and the manager asked no probe");

        var relaunched = await manager.EnsureHeadlessAsync(
            Guid.NewGuid(), "Ann", default, allowNewSlot: false, hostFacts: seats);
        Expect(relaunched == HeadlessClientManager.SlotToPort(2) && spawned.Count == 2, "between runs the same request launches again");
    }

    // ---- membership --------------------------------------------------------------------------------------------

    private static void MembershipUsesTypedRoster()
    {
        var lobby = SavedLobbyRoster(seatConnected: true);
        Expect(CouchCoopLobbyParticipation.IsPlayerConnected(lobby, 1002), "a connected lobby seat is a member");
        Expect(!CouchCoopLobbyParticipation.IsPlayerConnected(lobby, 1003), "an absent saved seat is not connected");
        Expect(!CouchCoopLobbyParticipation.IsPlayerConnected(lobby, 1004), "a stranger is not connected");
        var dropped = SavedLobbyRoster(seatConnected: false);
        Expect(!CouchCoopLobbyParticipation.IsPlayerConnected(dropped, 1002), "a disconnected lobby seat is not connected");
        var run = RunRoster(NetTypeNames.Host, "Hosty", seatConnected: false);
        Expect(CouchCoopLobbyParticipation.IsPlayerConnected(run, 1), "the run host is connected");
        Expect(!CouchCoopLobbyParticipation.IsPlayerConnected(run, 1002), "a dropped run seat is not connected");
        Expect(!CouchCoopLobbyParticipation.IsPlayerConnected(null, 1002), "an unreadable roster has no confirmed member");
    }

    private static CouchCoopGameFactsTests.FakeFacts ConnectedSeatFacts(bool connected = true)
        => new() { RosterRead = () => SavedLobbyRoster(seatConnected: connected) };

    // The join wait's question, over and over (~200 ms while a seat joins): one roster read each and no snapshot.
    private static void MembershipIsOneRosterReadAndNoStateSnapshot()
    {
        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
        var lobby = NewLobby(runtime);
        var fake = ConnectedSeatFacts();
        CouchCoopGameFactsTests.WithSource(fake, () =>
        {
            for (var i = 0; i < 25; i++)
            {
                Expect(lobby.IsGamePlayerConnected(1002), "the connected seat is a member");
            }

            Expect(!lobby.IsGamePlayerConnected(1005), "a stranger is not");
            fake.RosterRead = () => null;
            Expect(!lobby.IsGamePlayerConnected(1002), "an unreadable roster is not membership");
            fake.RosterRead = () => throw new InvalidOperationException("the game moved");
            Expect(!lobby.IsGamePlayerConnected(1002), "…and a throwing one never escapes");
        });

        Expect(fake.RosterReads == 28, $"one roster read per question (got {fake.RosterReads})");

    }

    // The monitor's question on the game's OWN ENet host, the path that never passes through CouchCoop's transport:
    // the transport has no host of ours installed, so its peer read is "unknown" and the question falls to the roster.
    // That fallback used to build a full snapshot every 250 ms per seat; it is now one roster read, in the SAME hop as the
    // peer read, and never a snapshot.
    private static void SeatPeerFallbackIsOneHopAndNoStateSnapshot()
    {
        Expect(CouchCoopHostPeers.IsPeerConnected(1002) is null && !CouchCoopHostPeers.IsHostActive,
            "this process has no transport-installed host, which is the stock ENet shape");
        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
        var lobby = NewLobby(runtime);
        var fake = ConnectedSeatFacts();
        var hops = new HopCounter();
        CouchCoopGameFactsTests.WithSource(fake, () => WithHops(hops, () =>
        {
            for (var i = 0; i < 40; i++)
            {
                Expect(lobby.IsSeatPeerConnected(1002), "the seat is connected on the stock ENet host");
            }

            Expect(!lobby.IsSeatPeerConnected(1005), "a stranger is not");
            fake.RosterRead = () => ConnectedSeatFacts(connected: false).RosterRead!();
            Expect(!lobby.IsSeatPeerConnected(1002), "a seat the game lists as disconnected reads as gone");
            return 0;
        }));

        Expect(fake.RosterReads == 42, $"one roster read per monitor tick (got {fake.RosterReads})");
        Expect(hops.Hops == 42, $"…each in ONE hop onto the main thread, the peer read and the fallback together (got {hops.Hops})");
    }

    // The marshal itself failing (the game is shutting down): the monitor's question still answers, never throws, and the
    // fallback is the roster read (which fails the same way and reads as "not connected").
    private static void SeatPeerFallbackSurvivesAFailingMainThread()
    {
        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
        var lobby = NewLobby(runtime);
        var fake = ConnectedSeatFacts();
        var previous = GameMainThread.Source;
        GameMainThread.Source = new ThrowingMainThread();
        try
        {
            CouchCoopGameFactsTests.WithSource(fake, () =>
            {
                Expect(!lobby.IsSeatPeerConnected(1002), "a main thread that cannot be reached is 'not connected', not an exception");
            });
        }
        finally
        {
            GameMainThread.Source = previous;
        }

    }

    // The two probes wired EXACTLY as production wires them (CouchCoopLobbyParticipation's lobby-membership check for the
    // join wait, its peer check for the monitor) over a runtime that counts every full state snapshot, with a roster that
    // says when the lobby admits the seat. The join wait polls (~200 ms) while the lobby has not admitted the seat, then
    // the monitor polls (250 ms) for the seat's life, on the game's own ENet host where CouchCoop's transport has no host of
    // its own and the peer check falls back to the roster. Neither loop is changed; each iteration is now one roster read.
    // It drives the real seat manager through the lifecycle suite's own helpers.
    private static async Task TheJoinWaitAndTheMonitorBuildNoStateSnapshot()
    {
        var id = HeadlessConnectionLifecycleTests.BeginAttempt();
        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
        var lobby = NewLobby(runtime);
        var admitted = false;
        var facts = new CouchCoopGameFactsTests.FakeFacts { RosterRead = () => SeatRoster(Volatile.Read(ref admitted)) };
        var process = new HeadlessConnectionLifecycleTests.FakeProcess(34);
        await CouchCoopGameFactsTests.WithSourceAsync(facts, async () =>
        {
            using var manager = new HeadlessClientManager(_ => process, (_, _) => Task.FromResult(true));
            manager.ConfigureConnectionMonitoring(lobby.IsGamePlayerConnected, () => 12345, lobby.IsSeatPeerConnected);
            try
            {
                var pending = manager.EnsureHeadlessAsync(id, "wired", CancellationToken.None);
                var control = await HeadlessConnectionLifecycleTests.WaitForControlAsync(id);
                HeadlessConnectionLifecycleTests.RegisterKnown(control, id, "wired-token");
                HeadlessConnectionControl.Shared.Observe("wired-token", control.Generation,
                    new HeadlessConnectionStatus(1, "Connecting", null, null, 1, CloudSaveIsolated: true));

                await Task.Delay(700);
                Expect(!pending.IsCompleted, "a seat the lobby has not admitted is not redirected");
                var waitReads = facts.RosterReads;
                Expect(waitReads >= 3, $"the join wait asked lobby membership on every ~200 ms pass (got {waitReads} reads)");

                Volatile.Write(ref admitted, true);
                HeadlessConnectionControl.Shared.Observe("wired-token", control.Generation,
                    new HeadlessConnectionStatus(2, "Connecting", null, null, 1, CloudSaveIsolated: true));
                Expect(await pending.WaitAsync(TimeSpan.FromSeconds(2)) == HeadlessClientManager.SlotToPort(control.Slot),
                    "once the lobby lists the seat as connected the join completes");

                var joinReads = facts.RosterReads;
                await Task.Delay(900);
                var monitorReads = facts.RosterReads - joinReads;
                Expect(monitorReads >= 3,
                    "the monitor asked the peer check on its 250 ms ticks and, with no transport host of ours, it fell back to "
                    + $"the roster (got {monitorReads} reads)");

            }
            finally
            {
                HeadlessConnectionLifecycleTests.CleanupControl(id);
                ConnectionRegistry.Shared.Clear();
            }
        });
    }

    // The lobby the seat joins: the host, and the couch seat (slot 2, netId 1002) once the lobby has admitted it.
    private static RosterFacts SeatRoster(bool seatAdmitted)
    {
        var seats = new List<RosterLobbySeat> { new("p:1", "Hosty", "IRONCLAD", true) };
        if (seatAdmitted)
        {
            seats.Add(new RosterLobbySeat("p:1002", "Ann", "SILENT", true));
        }

        return new RosterFacts(
            RosterRootScenes.CharacterSelect,
            new RosterLobby(NetTypeNames.Host, "p:1", IsSavedRun: false, seats, []),
            Run: null);
    }

    private sealed class ThrowingMainThread : IGameMainThread
    {
        public T Invoke<T>(Func<T> action) => throw new InvalidOperationException("the main thread is gone");
        public Task<T> InvokeAsync<T>(Func<Task<T>> action) => throw new InvalidOperationException("the main thread is gone");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"JoinFactsTests failed: {because}");
        }
    }
}
