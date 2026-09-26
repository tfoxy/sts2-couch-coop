using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Embedding;

// Run presence for a browser disconnect and a seat launch: one typed member read instead of a full state snapshot.
//
// What must hold, and where it is pinned:
//   * the read is one typed fact, through the CouchCoopGameFacts front, and an unreadable answer is "unavailable"
//     (null), not "no run";
//   * every caller keeps the failure semantics it always had: an unreadable state read as "not in a run" for the
//     disconnect decision and the launch gate, and made the hosting tracker skip the evaluation;
//   * a disconnect and a launch refusal cost ZERO state snapshots and never marshal to the game's main thread;
//   * the answer equals the retired snapshot predicate on every fixture the suites already share.
//
// The production reader needs an engine, which a test process must never reach (it faults in native code), so the
// reader is exercised through the seam that stands where the game would: CouchCoopGameFactsTests.FakeFacts.
internal static class RunPresenceTests
{
    public static async Task RunAsync()
    {
        FrontPassesTheReadersAnswerThrough();
        FrontTurnsAThrowingReaderIntoUnavailable();
        ProductionReaderIsUnavailableWithoutAnEngine();
        UnavailableReadsAsNoRunForTheDisconnectAndLaunchCallers();
        HostingTrackerSkipsAnEvaluationItCannotRead();
        await DisconnectInARunKeepsTheSeatDetached();
        await DisconnectInTheLobbyReleasesTheSeatAndEvictsItsPeer();
        await DisconnectWhenTheReadIsUnavailableReleasesTheSeat();
        await DisconnectWithoutASeatEvictsNothing();
        await LaunchIsRefusedInARunAndAllowedOtherwise();
        await ALaunchAfterAnUnreadableAnswerIsNotRefused();
        await DisconnectAndLaunchRefusalCostNoStateSnapshotAndNoMainThreadHop();
        await TheReadRunsOnTheCallersThread();
        ReadIsDemandFreeInsideAServedConnectionAndTheReleaseGrace();
        Console.WriteLine("RunPresenceTests: ok");
    }

    // ---- the front ---------------------------------------------------------------------------------------------

    private static void FrontPassesTheReadersAnswerThrough()
    {
        var fake = new CouchCoopGameFactsTests.FakeFacts { RunRead = () => true };
        CouchCoopGameFactsTests.WithSource(fake, () =>
        {
            Expect(CouchCoopGameFacts.ReadRunInProgress() == true, "a run reads as true");
            fake.RunRead = () => false;
            Expect(CouchCoopGameFacts.ReadRunInProgress() == false, "no run reads as false, which is not unavailable");
            fake.RunRead = () => null;
            Expect(CouchCoopGameFacts.ReadRunInProgress() is null, "an unreadable answer stays null");
            Expect(fake.RunReads == 3, "each call is one read of the reader");
        });
    }

    private static void FrontTurnsAThrowingReaderIntoUnavailable()
    {
        var fake = new CouchCoopGameFactsTests.FakeFacts { RunRead = () => throw new InvalidOperationException("the game moved") };
        CouchCoopGameFactsTests.WithSource(fake, () =>
        {
            Expect(CouchCoopGameFacts.ReadRunInProgress() is null, "a throwing reader is unavailable, never an exception in the caller");
        });
    }

    // No engine behind the process: unavailable without touching a game type (reaching RunManager here is the
    // exit-139 hazard), through the front and through the consumer that maps it.
    private static void ProductionReaderIsUnavailableWithoutAnEngine()
    {
        Expect(!CouchCoop.Mod.CouchCoopMod.EngineAvailable, "this process has no engine");
        Expect(GameFactsReader.Instance.ReadRunInProgress() is null, "the production reader answers unavailable");
        ZeroClientGuard.ResetForTests(armed: false);
        try
        {
            Expect(CouchCoopGameFacts.ReadRunInProgress() is null, "the front over the production reader answers unavailable");
            Expect(!Participation(new BrowserServerRouteTests.RecordingSpirectlRuntime()).IsRunInProgress(),
                "and the consumer reads that as no run");
        }
        finally
        {
            ZeroClientGuard.ResetForTests();
        }
    }

    // ---- failure semantics, stated once per caller ----------------------------------------------------------------

    // The retired read was `CurrentState()?.Run is not null`: a state that could not be read (no capability, a
    // failed read) was "not in a run", and both callers below were written against that. The typed read keeps it.
    private static void UnavailableReadsAsNoRunForTheDisconnectAndLaunchCallers()
    {
        var runtime = new BrowserServerRouteTests.RecordingSpirectlRuntime();
        var fake = new CouchCoopGameFactsTests.FakeFacts { RunRead = () => null };
        CouchCoopGameFactsTests.WithSource(fake, () =>
        {
            Expect(!Participation(runtime).IsRunInProgress(), "unavailable is 'not in a run' for the disconnect and launch callers");
            fake.RunRead = () => true;
            Expect(Participation(runtime).IsRunInProgress(), "a run is a run");
            fake.RunRead = () => false;
            Expect(!Participation(runtime).IsRunInProgress(), "no run is no run");
            fake.RunRead = () => throw new InvalidOperationException("the game moved");
            Expect(!Participation(runtime).IsRunInProgress(), "a throwing read is 'not in a run' too, and never escapes");
        });
    }

    // The hosting tracker treats "left every run and lobby" as evidence hosting ended, so an unreadable answer must
    // NOT read as "no run" there: it throws, the tracker's catch logs it and skips the evaluation (as a throwing
    // read always did).
    private static void HostingTrackerSkipsAnEvaluationItCannotRead()
    {
        var fake = new CouchCoopGameFactsTests.FakeFacts { RunRead = () => true };
        CouchCoopGameFactsTests.WithSource(fake, () =>
        {
            var facts = new HostingSessionFacts();
            Expect(facts.IsRunInProgress(), "the tracker reads a run through the one typed read");
            fake.RunRead = () => false;
            Expect(!facts.IsRunInProgress(), "and no run");
            fake.RunRead = () => null;
            var threw = false;
            try
            {
                facts.IsRunInProgress();
            }
            catch (InvalidOperationException)
            {
                threw = true;
            }

            Expect(threw, "an unreadable answer skips the tracker's evaluation instead of counting toward hosting end");
        });
    }

    // ---- the disconnect decision --------------------------------------------------------------------------------

    // A seat manager wired the way production wires it: its run probe is CouchCoopLobbyParticipation.IsRunInProgress
    // over a runtime host whose runtime counts every full state snapshot it is asked for.
    private sealed class Rig : IDisposable
    {
        public readonly List<FakeProcess> Spawned = [];
        public readonly List<ulong> Evicted = [];
        public readonly List<ulong> NamesCleared = [];
        public readonly CouchCoopGameFactsTests.FakeFacts Facts = new() { RunRead = () => false };
        public readonly BrowserServerRouteTests.RecordingSpirectlRuntime Runtime = new();
        public readonly CouchCoopRuntimeHost Host;
        public readonly HeadlessClientManager Manager;

        public Rig()
        {
            Host = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
                Runtime, Runtime, Runtime, Runtime, Runtime, Runtime, Runtime, Runtime, Runtime));
            Manager = new HeadlessClientManager(
                launcher: slot =>
                {
                    var process = new FakeProcess(slot);
                    Spawned.Add(process);
                    return process;
                },
                readinessProbe: (_, _) => Task.FromResult(true),
                maxSeatsProbe: () => 3,
                runInProgressProbe: Lobby.IsRunInProgress);
        }

        public CouchCoopLobbyParticipation Lobby => new(Host);

        /// <summary>What the typed run-presence read answers from now on.</summary>
        public bool? RunPresence
        {
            set => Facts.RunRead = () => value;
        }

        /// <summary>A browser disconnect, decided the way the WebSocket connection decides it.</summary>
        public void Disconnect(Guid session)
            => BrowserDisconnectSeat.Apply(Manager, session, Lobby.IsRunInProgress, Evicted.Add, NamesCleared.Add);

        public void Dispose() => Manager.Dispose();
    }

    private sealed class FakeProcess(int slot) : IHeadlessProcess
    {
        public int Slot { get; } = slot;
        public bool Exited { get; private set; }
        public bool HardKilled { get; private set; }
        public int Id => 20000 + Slot;
        public bool HasExited => Exited;
        public int ExitCode => 0;

        public void ForceExit() => Exited = true;

        public bool RequestGracefulStop()
        {
            Exited = true;
            return true;
        }

        public void Kill()
        {
            HardKilled = true;
            Exited = true;
        }

        public void Dispose()
        {
        }
    }

    private static async Task DisconnectInARunKeepsTheSeatDetached()
    {
        using var rig = new Rig();
        var manager = rig.Manager;
        var session = Guid.NewGuid();
        await CouchCoopGameFactsTests.WithSourceAsync(rig.Facts, async () =>
        {
            await manager.EnsureHeadlessAsync(session, "Ann", default);
            var process = rig.Spawned[0];

            rig.RunPresence = true; // the host started the run while Ann's browser was connected
            rig.Disconnect(session);

            Expect(!process.Exited && !process.HardKilled, "a disconnect in a run keeps the seat process alive");
            Expect(rig.Evicted.Count == 0, "and evicts no peer: the seat is still the run's connected player");
            Expect(rig.NamesCleared.Count == 0, "and keeps the seat's display name");
            var reaped = manager.ReapDetachedSlots();
            Expect(reaped.Count == 1 && reaped[0] == HeadlessClientManager.SlotToNetId(2),
                "the seat is marked detached, so the run-end reap finds it");
        });
    }

    private static async Task DisconnectInTheLobbyReleasesTheSeatAndEvictsItsPeer()
    {
        using var rig = new Rig();
        var manager = rig.Manager;
        var session = Guid.NewGuid();
        await CouchCoopGameFactsTests.WithSourceAsync(rig.Facts, async () =>
        {
            await manager.EnsureHeadlessAsync(session, "Ann", default);
            var process = rig.Spawned[0];

            rig.Disconnect(session);

            Expect(process.HardKilled, "a disconnect in the lobby kills the seat process");
            Expect(rig.Evicted.SequenceEqual([HeadlessClientManager.SlotToNetId(2)]),
                "and evicts its peer so a same-name rejoin is not refused as a duplicate netId");
            Expect(rig.NamesCleared.Count == 0,
                "the departing player still holds the seat's name claim, so its display name stays");
            Expect(manager.ReapDetachedSlots().Count == 0, "a released seat is not detached");
        });
    }

    private static async Task DisconnectWhenTheReadIsUnavailableReleasesTheSeat()
    {
        using var rig = new Rig();
        var manager = rig.Manager;
        var session = Guid.NewGuid();
        await CouchCoopGameFactsTests.WithSourceAsync(rig.Facts, async () =>
        {
            await manager.EnsureHeadlessAsync(session, "Ann", default);
            rig.RunPresence = null;

            rig.Disconnect(session);

            Expect(rig.Spawned[0].HardKilled && rig.Evicted.Count == 1,
                "a disconnect that cannot tell whether a run exists releases the seat, as an unreadable state always did");
        });
    }

    private static async Task DisconnectWithoutASeatEvictsNothing()
    {
        using var rig = new Rig();
        var manager = rig.Manager;
        await CouchCoopGameFactsTests.WithSourceAsync(rig.Facts, () =>
        {
            rig.Disconnect(Guid.NewGuid());
            Expect(rig.Evicted.Count == 0 && rig.NamesCleared.Count == 0, "a browser that never had a seat leaves nothing to evict");
            rig.RunPresence = true;
            rig.Disconnect(Guid.NewGuid());
            Expect(manager.ReapDetachedSlots().Count == 0, "nor anything to detach in a run");
            return Task.CompletedTask;
        });
    }

    // ---- the launch gate ---------------------------------------------------------------------------------------

    private static async Task LaunchIsRefusedInARunAndAllowedOtherwise()
    {
        using var rig = new Rig();
        var manager = rig.Manager;
        await CouchCoopGameFactsTests.WithSourceAsync(rig.Facts, async () =>
        {
            await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
            rig.Spawned[0].ForceExit(); // the seat's process died

            rig.RunPresence = true;
            var refused = await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, allowNewSlot: false);
            Expect(refused is null && rig.Spawned.Count == 1, "in a run a dead seat is not relaunched: the host would refuse it on arrival");

            rig.RunPresence = false;
            var allowed = await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, allowNewSlot: false);
            Expect(allowed == HeadlessClientManager.SlotToPort(2) && rig.Spawned.Count == 2,
                "between runs (the load-saved-run lobby included) the same request launches again");
        });
    }

    private static async Task ALaunchAfterAnUnreadableAnswerIsNotRefused()
    {
        using var rig = new Rig();
        var manager = rig.Manager;
        await CouchCoopGameFactsTests.WithSourceAsync(rig.Facts, async () =>
        {
            await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
            rig.Spawned[0].ForceExit();

            rig.RunPresence = null;
            var port = await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, allowNewSlot: false);
            Expect(port == HeadlessClientManager.SlotToPort(2) && rig.Spawned.Count == 2,
                "an unreadable answer never costs a player their seat: the game refuses the peer itself if a run was live");
        });
    }

    // ---- what it costs --------------------------------------------------------------------------------------------

    private sealed class CountingMainThread : IGameMainThread
    {
        private int _dispatches;

        public int Dispatches => Volatile.Read(ref _dispatches);

        public T Invoke<T>(Func<T> action)
        {
            Interlocked.Increment(ref _dispatches);
            return action();
        }

        public Task<T> InvokeAsync<T>(Func<Task<T>> action)
        {
            Interlocked.Increment(ref _dispatches);
            return action();
        }
    }

    private static async Task DisconnectAndLaunchRefusalCostNoStateSnapshotAndNoMainThreadHop()
    {
        using var rig = new Rig();
        var manager = rig.Manager;
        var mainThread = new CountingMainThread();
        var previousMainThread = GameMainThread.Source;
        GameMainThread.Source = mainThread;
        try
        {
            await CouchCoopGameFactsTests.WithSourceAsync(rig.Facts, async () =>
            {

                // A launch, a launch refusal in a run, a mid-run disconnect, and a lobby disconnect.
                var mid = Guid.NewGuid();
                await manager.EnsureHeadlessAsync(mid, "Ann", default);
                rig.Spawned[0].ForceExit();
                rig.RunPresence = true;
                Expect(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default, allowNewSlot: false) is null,
                    "the launch is refused in the run");
                rig.Disconnect(mid);

                rig.RunPresence = false;
                var lobbySession = Guid.NewGuid();
                await manager.EnsureHeadlessAsync(lobbySession, "Bob", default);
                rig.Disconnect(lobbySession);

                Expect(mainThread.Dispatches == 0, "and never hop to the game's main thread");
                Expect(rig.Facts.RunReads >= 4, "while the typed read was asked for each decision");
            });
        }
        finally
        {
            GameMainThread.Source = previousMainThread;
        }
    }

    // Called from a socket or listener thread: the read runs where it is asked, with no marshal.
    private static async Task TheReadRunsOnTheCallersThread()
    {
        var fake = new CouchCoopGameFactsTests.FakeFacts { RunRead = () => true };
        var callerThread = 0;
        var answer = (bool?)null;
        var mainThread = new CountingMainThread();
        var previousMainThread = GameMainThread.Source;
        GameMainThread.Source = mainThread;
        try
        {
            await CouchCoopGameFactsTests.WithSourceAsync(fake, async () =>
            {
                await Task.Run(() =>
                {
                    callerThread = Environment.CurrentManagedThreadId;
                    answer = CouchCoopGameFacts.ReadRunInProgress();
                });
            });
        }
        finally
        {
            GameMainThread.Source = previousMainThread;
        }

        Expect(answer == true, "a pool thread gets the answer");
        Expect(fake.RunReadThread == callerThread && callerThread != 0, "the reader ran on the caller's own thread");
        Expect(mainThread.Dispatches == 0, "with no main-thread dispatch");
    }

    // ---- zero-client ------------------------------------------------------------------------------------------------

    // A disconnect runs inside its own served connection's handler, so its read is demand; the read is also inside
    // the release grace when the last client just left. Only a read with nobody connected and the grace over is idle
    // work, and it is counted against the same host-facts entry the QR gates use. No new entry, no allowance.
    private static void ReadIsDemandFreeInsideAServedConnectionAndTheReleaseGrace()
    {
        var fake = new CouchCoopGameFactsTests.FakeFacts { RunRead = () => false };
        var previous = CouchCoopGameFacts.Source;
        CouchCoopGameFacts.Source = fake;
        try
        {
            var now = 1_000L;
            var lines = new List<string>();
            ZeroClientGuard.ResetForTests(armed: true);
            ZeroClientGuard.Clock = () => Volatile.Read(ref now);
            ZeroClientGuard.LogSink = lines.Add;

            ZeroClientGuard.ClientOpened();
            CouchCoopGameFacts.ReadRunInProgress();
            Expect(ZeroClientGuard.Violations == 0, "a read while a connection is served is demand");

            ZeroClientGuard.ClientClosed();
            CouchCoopGameFacts.ReadRunInProgress();
            Expect(ZeroClientGuard.Violations == 0, "a read inside the release grace is teardown");

            now += (long)ZeroClientGuard.ReleaseGrace.TotalMilliseconds + 1_000;
            CouchCoopGameFacts.ReadRunInProgress();
            Expect(ZeroClientGuard.Violations == 1 && ZeroClientEntries.HostFactsRead.Hits == 1,
                "the same read with nobody connected and the grace over is idle work, on the host-facts entry");
            Expect(lines.Count == 1 && lines[0].Contains("host-facts.read", StringComparison.Ordinal),
                "and it is named in the log");
        }
        finally
        {
            CouchCoopGameFacts.Source = previous;
            ZeroClientGuard.ResetForTests();
        }
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------

    private static CouchCoopLobbyParticipation Participation(BrowserServerRouteTests.RecordingSpirectlRuntime runtime)
        => new(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
            runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"RunPresenceTests failed: {because}");
        }
    }
}
