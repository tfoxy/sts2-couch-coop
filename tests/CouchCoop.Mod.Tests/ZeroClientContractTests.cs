using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Text;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.Protocol;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

// THE ZERO-CLIENT CONTRACT. The standing rule is that a host nobody is connected to does no recurring work:
// no state capture, no scene or state subscription, no main-thread wake-up, no timer. It was broken once with no
// test noticing: the Sep-13 hosting tracker built an always-on state subscription at mod init, and every suite
// checked NAMED components (IdleHostCostTests, ConnectionHostingDemandTests) rather than the host as a whole, so
// nothing failed while a preview-clone leak of ~450 MB/hour shipped for two releases.
//
// This suite is the whole-host version. It composes the REAL host services the mod builds at init
// (CouchCoopHostUiServices -> HotReloadableBrowserServerHost -> the hosting tracker, the seat manager, the browser
// server generation and its observers) over COUNTING doubles for the only ways they can reach the game: the ten
// runtime ports (CouchCoopRuntimeDependencies) and the two CouchCoop-owned fronts for spirectl's statics
// (GameScreenContext, GameMainThread). It drives the phases a player's machine spends its life in and asserts, for
// each, that nothing ran that nobody asked for.
//
// It is only as good as its ability to fail. Three things keep it honest, all in this file:
//   * every phase also proves the doubles are LIVE (a viewer makes them count), so "zero" cannot be vacuous;
//   * every registered entry point has a rogue driver, and the SAME checker that guards the phases must reject it;
//   * the runtime tripwire (ZeroClientGuard) must name the rogue's caller, and stay silent in every clean phase.
//
// NOT COMPOSABLE HERE: anything constructing Godot nodes (the QR host panel, the pause-menu row, the lobby mount
// patch). Their state/screen use is covered by the tripwire's named allowances instead, which the hygiene leg pins.
internal static class ZeroClientContractTests
{
    internal const string Verb = "zero-client";

    private static readonly TimeSpan QuietWindow = TimeSpan.FromMilliseconds(1500);

    // Above what teardown leaves behind, far below any loop: a 50 ms poll makes 30 items in a quiet window.
    private const long HotLoopItems = 20;

    public static async Task RunAsync()
    {
        var oldSecure = Environment.GetEnvironmentVariable("COUCHCOOP_SECURE_ORIGIN");
        var oldMdns = Environment.GetEnvironmentVariable("COUCHCOOP_MDNS_RESPONDER");
        var root = Path.Combine(Path.GetTempPath(), "couchcoop-zero-client-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            // No WAN certificate fetch and no multicast socket: this suite is about game work, not the network.
            Environment.SetEnvironmentVariable("COUCHCOOP_SECURE_ORIGIN", "0");
            Environment.SetEnvironmentVariable("COUCHCOOP_MDNS_RESPONDER", "0");

            GuardContract();
            AllowListHygiene();
            HotReloadAssemblyDoesNotDuplicateTheGuard();
            await WholeHostStaysQuietWithoutClientsAsync(root);
            await EveryEntryPointHasARogueThatFailsTheContractAsync(root);
            await RogueAlwaysOnSubscriberFailsTheWholeHostContractAsync(root);
            await RogueTimerFailsTheWholeHostContractAsync(root);
            Console.WriteLine("ZeroClientContractTests: ok");
        }
        finally
        {
            Environment.SetEnvironmentVariable("COUCHCOOP_SECURE_ORIGIN", oldSecure);
            Environment.SetEnvironmentVariable("COUCHCOOP_MDNS_RESPONDER", oldMdns);
            ZeroClientGuard.ResetForTests();
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }

    // ---- the tripwire on its own -------------------------------------------------------------------------

    private static void GuardContract()
    {
        var clock = new FakeClock();
        var lines = new List<string>();

        void Fresh(bool? armed = true)
        {
            ZeroClientGuard.ResetForTests(armed);
            lines.Clear();
            ZeroClientGuard.Clock = () => clock.Now;
            ZeroClientGuard.LogSink = lines.Add;
        }

        // A client or an owned seat means the work is asked for: one integer read, nothing recorded.
        Fresh();
        ZeroClientGuard.ClientOpened();
        ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
        ZeroClientGuard.EnterPort(ZeroClientEntries.SceneSubscribe);
        Expect(ZeroClientGuard.Violations == 0 && lines.Count == 0, "work while a client is served is silent");
        ZeroClientGuard.ClientClosed();

        // Zero demand: counted, and named. The line carries the caller from the compiler and the entry name.
        Fresh();
        ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
        Expect(ZeroClientGuard.Violations == 1 && ZeroClientEntries.StateRead.Hits == 1, "a zero-demand use is counted once");
        Expect(lines.Count == 1
            && lines[0].StartsWith("[idle-work] ZeroClientContractTests.GuardContract state.read", StringComparison.Ordinal),
            $"the line names the caller and the entry point (got: {string.Join(" | ", lines)})");
        Expect(CouchCoopLog.Line(lines[0]).StartsWith("[couchcoop][idle-work] ", StringComparison.Ordinal),
            "through the log seam the line reads [couchcoop][idle-work] <caller> <entry point>");

        // Rate limit: a poller costs one line a minute per caller and entry, not one per call.
        for (var i = 0; i < 200; i++) ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
        Expect(lines.Count == 1 && ZeroClientGuard.Violations == 201, "the counter keeps counting; the log line does not repeat");
        clock.Advance(TimeSpan.FromSeconds(61));
        ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
        Expect(lines.Count == 2, "the same caller is reported again after the interval");
        ZeroClientGuard.Enter(ZeroClientEntries.ScreenRead);
        Expect(lines.Count == 3, "another entry point is its own line");

        // A caller resolved from the stack (the port path) names the code that called through the interface.
        Fresh();
        ClassifyPortCaller(ZeroClientEntries.StateSubscribe);
        Expect(lines.Count == 1 && lines[0].Contains("ZeroClientContractTests.ClassifyPortCaller state.subscribe", StringComparison.Ordinal),
            $"a port entry is attributed to its caller by stack (got: {string.Join(" | ", lines)})");

        // Grace: the tail of in-flight work after the last client leaves is teardown, not a leak.
        Fresh();
        ZeroClientGuard.ClientOpened();
        ZeroClientGuard.ClientClosed();
        ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
        Expect(ZeroClientGuard.Violations == 0, "work inside the release grace is excused");
        clock.Advance(ZeroClientGuard.ReleaseGrace + TimeSpan.FromSeconds(1));
        ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
        Expect(ZeroClientGuard.Violations == 1, "the same work after the grace is idle work");

        // Allowances: only the named entries, only inside the scope, and the scope restores what was there.
        Fresh();
        using (ZeroClientGuard.Permit(ZeroClientAllowances.QrHostPanel))
        {
            ZeroClientGuard.Enter(ZeroClientEntries.ScreenRead);
            Expect(ZeroClientGuard.Violations == 0 && ZeroClientAllowances.QrHostPanel.Hits == 1, "a covered entry inside its scope is excused and counted");
            ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
            Expect(ZeroClientGuard.Violations == 1, "an entry the allowance does not cover is still idle work");
            using (ZeroClientGuard.Permit(ZeroClientAllowances.LobbyPanelStateRead))
            {
                ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
            }

            ZeroClientGuard.Enter(ZeroClientEntries.ScreenRead);
            Expect(ZeroClientGuard.Violations == 1 && ZeroClientAllowances.QrHostPanel.Hits == 2, "leaving a nested scope restores the outer allowance");
        }

        ZeroClientGuard.Enter(ZeroClientEntries.ScreenRead);
        Expect(ZeroClientGuard.Violations == 2, "outside the scope the same entry is idle work again");

        // Disarmed (a spawned seat) is silent, and owned seats are demand with the ledger's generation rules.
        Fresh(armed: false);
        ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
        Expect(ZeroClientGuard.Violations == 0, "a disarmed guard (a spawned seat) never reports");

        Fresh();
        var seatOwner = ZeroClientGuard.CreateOwnedSeatReporter();
        seatOwner(1, 5);
        ZeroClientGuard.Enter(ZeroClientEntries.StateRead);
        Expect(ZeroClientGuard.Violations == 0 && ZeroClientGuard.HasDemand, "an owned seat is demand");
        seatOwner(0, 4);
        Expect(ZeroClientGuard.HasDemand, "an older zero cannot remove a newer seat count");
        seatOwner(0, long.MaxValue);
        Expect(!ZeroClientGuard.HasDemand, "retiring the owner releases its seats");

        // Client counting clamps: an unbalanced close must not make the next client invisible.
        Fresh();
        ZeroClientGuard.ClientClosed();
        ZeroClientGuard.ClientOpened();
        Expect(ZeroClientGuard.HasDemand, "an unbalanced close never drives demand negative");
        ZeroClientGuard.ClientClosed();

        ZeroClientGuard.ResetForTests();
        Console.WriteLine("  guard contract: ok");
    }

    // Stands in for a component reaching the runtime through the interface: the frame that matters is this one.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ClassifyPortCaller(ZeroClientEntry entry) => ZeroClientGuard.EnterPort(entry);

    // ---- the allow-list is the review point ---------------------------------------------------------------

    private static void AllowListHygiene()
    {
        var names = new HashSet<string>();
        foreach (var allowance in ZeroClientAllowances.All)
        {
            Expect(names.Add(allowance.Name), $"allowance '{allowance.Name}' is unique");
            Expect(allowance.Entries.Count > 0, $"allowance '{allowance.Name}' covers at least one entry point");
            Expect(allowance.Reason.Length >= 120,
                $"allowance '{allowance.Name}' says why the work is demand-free (a real sentence, not a label)");
            Expect(allowance.Reason.Contains(' ') && allowance.Reason.TrimEnd().EndsWith('.'),
                $"allowance '{allowance.Name}' reads as a sentence");
        }

        Expect(ZeroClientAllowances.All.Count == 4,
            "the allow-list is exactly the reviewed set; a new entry needs this count, its reason and a reviewer");
        Expect(ZeroClientEntries.All.Select(entry => entry.Name).Distinct().Count() == ZeroClientEntries.All.Count,
            "entry point names are unique");
        Console.WriteLine("  allow-list hygiene: ok");
    }

    // The tripwire is only one set of counters because it lives where the hot-reload assembly does not link it.
    // (CouchCoopMod.EngineAvailable is the precedent; Server/ is compiled into both assemblies, Runtime/ is not.)
    private static void HotReloadAssemblyDoesNotDuplicateTheGuard()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CouchCoop.sln")))
        {
            dir = dir.Parent;
        }

        Expect(dir is not null, "found the repo root");
        var csproj = File.ReadAllText(Path.Combine(dir!.FullName, "src", "CouchCoop.Mod.HotReload", "CouchCoop.Mod.HotReload.csproj"));
        Expect(!csproj.Contains("CouchCoop.Mod/Runtime", StringComparison.Ordinal),
            "the hot-reload assembly must not link Runtime/: the guard's statics would exist twice, and the hot generation's calls would count into a copy nothing reads");
        Console.WriteLine("  single-instance guard: ok");
    }

    // ---- the whole host, phase by phase ------------------------------------------------------------------

    private static async Task WholeHostStaysQuietWithoutClientsAsync(string root)
    {
        await using var rig = await Rig.StartAsync(root);

        // 1. STARTUP / MENU. Immediately after init, before any window: nothing subscribed and nothing read. This
        //    is the Sep-13 failure exactly (a subscription built at mod init), so it is asserted with no settle time.
        rig.AssertQuiet("startup", baseline: default, window: null);
        rig.AssertQuiet("menu, observed", baseline: rig.Snapshot(), window: QuietWindow);

        // 2. A HOSTING LOBBY OPENED, THEN CLOSED. The host UI arms discovery when a host lobby is on screen and
        //    disarms it when hosting ends; neither touches the game. Ending it also disarms the reachability watch.
        var beforeLobby = rig.Snapshot();
        rig.Services.StartDiscoveryServices();
        await rig.Services.DiscoveryServicesReady.WaitAsync(TimeSpan.FromSeconds(10));
        Expect(rig.Services.DiscoveryServicesRunning, "the lobby armed discovery");
        // The one timer a hosting lobby is allowed: the reachability watch's single 90 s delay ("nobody has connected
        // yet"), armed when hosting starts, cancelled by the first inbound connection or by hosting ending. It fires
        // once at most; it is not a poll.
        rig.AssertQuiet("hosting lobby open", beforeLobby, QuietWindow, allowedTimers: 1);
        await rig.Services.StopDiscoveryServicesAsync();
        Expect(!rig.Services.DiscoveryServicesRunning, "hosting ended: discovery stopped");
        rig.AssertQuiet("hosting lobby closed", beforeLobby, QuietWindow);

        // 3. AN ACTIVE RUN WITH NO VIEWERS. The game changes screens and state constantly; a host nobody is watching
        //    must not notice. (The fake game raises its screen event to whoever is subscribed: nobody should be.)
        rig.Runtime.Mode = "run";
        var beforeRun = rig.Snapshot();
        for (var i = 0; i < 25; i++) rig.Screens.Fire();
        rig.AssertQuiet("active run, no viewers", beforeRun, QuietWindow);

        // 4. A 0 -> 1 -> 0 VIEWER CYCLE. While the viewers are connected the doubles MUST count (a contract that
        //    cannot see work is vacuous); once they are gone the host returns to exactly nothing.
        await using (var picker = await rig.ConnectViewerAsync(watch: false, staticBackground: true))
        await using (var streaming = await rig.ConnectViewerAsync(watch: true, staticBackground: false))
        {
            Expect(await rig.WaitAsync(() => rig.Runtime.StateLive >= 1),
                "a picker-parked viewer keeps the state observer alive (it is demand, so the tripwire allows it)");
            Expect(await rig.WaitAsync(() => rig.Runtime.SceneLive >= 1 && rig.Runtime.HintLive >= 1),
                "a streaming viewer starts the scene producer and the hint collector");
            Expect(await rig.WaitAsync(() => rig.Screens.Live >= 2),
                "the hosting tracker and the static-background probe both subscribe to the screen event while a viewer is served");
            Expect(rig.Runtime.StateCaptures >= 1, "the handshake read the game state for the viewer's session");
            Expect(await rig.WaitAsync(() => rig.MainThread.Dispatches >= 1), "the tracker's first evaluation is a main-thread dispatch");
            Expect(ZeroClientGuard.Violations == 0, "all of that work was demanded, so the tripwire says nothing");
            Expect(rig.Server.IsHostingSupervisionActive, "hosting supervision runs while a viewer is served");
        }

        Expect(await rig.WaitAsync(rig.IsFullyParked, timeoutMs: 15_000),
            $"every subscription is released after the last viewer leaves ({rig.Describe()})");
        rig.Clock.Advance(ZeroClientGuard.ReleaseGrace + TimeSpan.FromSeconds(1));
        Expect(await rig.QuiesceAsync(),
            "every timer the viewers caused is gone within seconds of the last viewer leaving");
        rig.AssertQuiet("after a 0-1-0 viewer cycle", rig.Snapshot(), QuietWindow);
        Expect(!rig.Server.IsHostingSupervisionActive, "hosting supervision stops with the last viewer");

        // 5. A SEAT DETACHES MID-RUN. Its process stays owned, and supervising it is the one thing the dormancy rule
        //    lets a client-less host keep doing: the tracker listens to the screen event and ticks once a second.
        //    Still no game state, no scene, no hints, and the tripwire agrees it is demanded.
        var beforeSeat = rig.Snapshot();
        rig.Server.ReportOwnedSeatDemand(1, generation: 1);
        Expect(rig.Server.IsHostingSupervisionActive, "an owned seat keeps hosting supervision alive with no viewer");
        rig.AssertQuiet(
            "seat detached mid-run",
            beforeSeat,
            TimeSpan.FromMilliseconds(2500),
            allowedScreenSubscribes: 1,
            allowedDispatches: 3,
            allowedTimers: 1);
        Expect(rig.Screens.Live == 1, "exactly one screen subscription, the tracker's, supervises the detached seat");
        rig.Server.ReportOwnedSeatDemand(0, generation: 2);
        Expect(await rig.WaitAsync(rig.IsFullyParked), "reaping the seat releases supervision");
        rig.Clock.Advance(ZeroClientGuard.ReleaseGrace + TimeSpan.FromSeconds(1));
        Expect(await rig.QuiesceAsync(), "supervision leaves no timer behind once its last seat is reaped");
        rig.AssertQuiet("seat reaped", rig.Snapshot(), QuietWindow);

        Expect(rig.TripwireLines.Count == 0,
            $"the tripwire stayed silent through every phase (got: {string.Join(" | ", rig.TripwireLines)})");
        Console.WriteLine("  whole-host phases: ok");
    }

    // ---- the test must bite ------------------------------------------------------------------------------

    // One rogue per registered entry point. A new entry with no driver fails here, which is the point: the contract
    // must be able to see it before anyone relies on it.
    private static async Task EveryEntryPointHasARogueThatFailsTheContractAsync(string root)
    {
        // The caller the tripwire must name: the rogue's class for a runtime port (read from the stack), the rogue's
        // method for a CouchCoop front (taken from the compiler along with the file name).
        var drivers = new Dictionary<ZeroClientEntry, (Func<Rig, IDisposable> Drive, string Caller)>
        {
            [ZeroClientEntries.StateRead] = (rig => new RogueStateReader(rig.Host), "RogueStateReader.ctor"),
            [ZeroClientEntries.StateSubscribe] = (rig => new RogueStateSubscriber(rig.Host), "RogueStateSubscriber.ctor"),
            [ZeroClientEntries.SceneSubscribe] = (rig => new RogueSceneSubscriber(rig.Host), "RogueSceneSubscriber.ctor"),
            [ZeroClientEntries.AnimationHintSubscribe] = (rig => new RogueHintSubscriber(rig.Host), "RogueHintSubscriber.ctor"),
            [ZeroClientEntries.MultiplayerConnectionRead] = (rig => new RogueConnectionReader(rig.Host), "RogueConnectionReader.ctor"),
            [ZeroClientEntries.MultiplayerConnectionSubscribe] = (rig => new RogueConnectionSubscriber(rig.Host), "RogueConnectionSubscriber.ctor"),
            [ZeroClientEntries.ScreenSubscribe] = (_ => new RogueScreenWatcher(), "ZeroClientContractTests.Start"),
            [ZeroClientEntries.ScreenRead] = (_ => new RogueScreenPoller(), "ZeroClientContractTests.Poll"),
            [ZeroClientEntries.MainThreadDispatch] = (_ => new RogueMainThreadWaker(), "ZeroClientContractTests.Wake"),
        };

        foreach (var entry in ZeroClientEntries.All)
        {
            Expect(drivers.ContainsKey(entry),
                $"entry point '{entry.Name}' has a rogue driver, so the contract test can see it");
        }

        foreach (var (entry, (drive, caller)) in drivers)
        {
            await using var rig = await Rig.StartAsync(root, compose: drive);
            var failure = Record(() => rig.AssertQuiet("rogue " + entry.Name, baseline: default, window: null));
            Expect(failure is ZeroClientContractViolation,
                $"the whole-host contract rejects a rogue '{entry.Name}' (got: {failure?.GetType().Name ?? "no failure"})");
            Expect(entry.Hits >= 1, $"the tripwire counted the rogue '{entry.Name}' (hits={entry.Hits})");
            Expect(rig.TripwireLines.Any(line => line.StartsWith($"[idle-work] {caller} {entry.Name}", StringComparison.Ordinal)),
                $"the tripwire names the rogue's caller for '{entry.Name}' (lines: {string.Join(" | ", rig.TripwireLines)})");
        }

        Console.WriteLine("  every entry point has a rogue that fails the contract: ok");
    }

    // The exact regression that shipped: a component built at init that subscribes to state and stays subscribed.
    private static async Task RogueAlwaysOnSubscriberFailsTheWholeHostContractAsync(string root)
    {
        await using var rig = await Rig.StartAsync(root, compose: r => new RogueStateSubscriber(r.Host));
        var failure = Record(() => rig.AssertQuiet("startup", baseline: default, window: null));
        Expect(failure is ZeroClientContractViolation violation
                && violation.Message.Contains("state subscriptions", StringComparison.Ordinal),
            $"an always-on state subscriber built at init fails the startup phase (got: {failure?.Message})");
        Expect(rig.TripwireLines.Any(line => line.StartsWith("[idle-work] RogueStateSubscriber.ctor state.subscribe", StringComparison.Ordinal)),
            $"the tripwire names it: {string.Join(" | ", rig.TripwireLines)}");
        Console.WriteLine("  always-on subscriber is rejected: ok");
    }

    // A polling timer is invisible to a subscription counter; the worker-thread census is what catches it.
    private static async Task RogueTimerFailsTheWholeHostContractAsync(string root)
    {
        await using var rig = await Rig.StartAsync(root, compose: r => new RogueStatePoller(r.Host));
        var failure = Record(() => rig.AssertQuiet("menu, observed", baseline: rig.Snapshot(), window: QuietWindow));
        Expect(failure is ZeroClientContractViolation,
            $"a recurring poll fails the observed window (got: {failure?.Message ?? "no failure"})");
        Expect(failure!.Message.Contains("state captures", StringComparison.Ordinal),
            $"the failure says what leaked: {failure.Message}");
        Expect(failure.Message.Contains("active timers", StringComparison.Ordinal),
            $"a polling timer is caught by the exact timer census, not only by what it read: {failure.Message}");
        Console.WriteLine("  recurring poll is rejected: ok");
    }

    private static Exception? Record(Action action)
    {
        try
        {
            action();
            return null;
        }
        catch (Exception exception)
        {
            return exception;
        }
    }

    // ---- rogue components: each one is "somebody added this without demand" -------------------------------

    private sealed class RogueStateSubscriber : IDisposable
    {
        private readonly IDisposable _subscription;

        [MethodImpl(MethodImplOptions.NoInlining)]
        public RogueStateSubscriber(CouchCoopRuntimeHost runtime)
            => _subscription = runtime.SubscribeCurrentState(new CurrentStateSubscriptionRequest(EmitInitial: true), _ => { });

        public void Dispose() => _subscription.Dispose();
    }

    private sealed class RogueStateReader : IDisposable
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        public RogueStateReader(CouchCoopRuntimeHost runtime) => _ = runtime.GetCurrentState(new CurrentStateRequest());

        public void Dispose() { }
    }

    private sealed class RogueStatePoller : IDisposable
    {
        private readonly Timer _timer;

        public RogueStatePoller(CouchCoopRuntimeHost runtime)
            => _timer = new Timer(_ => runtime.GetCurrentState(new CurrentStateRequest()), null, TimeSpan.Zero, TimeSpan.FromMilliseconds(100));

        public void Dispose() => _timer.Dispose();
    }

    private sealed class RogueSceneSubscriber : IDisposable
    {
        private readonly IDisposable _subscription;

        [MethodImpl(MethodImplOptions.NoInlining)]
        public RogueSceneSubscriber(CouchCoopRuntimeHost runtime)
            => _subscription = runtime.SubscribeRuntimeSceneDelta(new RuntimeSceneSubscriptionRequest(), _ => { });

        public void Dispose() => _subscription.Dispose();
    }

    private sealed class RogueHintSubscriber : IDisposable
    {
        private readonly IDisposable _subscription;

        [MethodImpl(MethodImplOptions.NoInlining)]
        public RogueHintSubscriber(CouchCoopRuntimeHost runtime)
            => _subscription = runtime.SubscribeAnimationHints(new AnimationHintSubscriptionRequest(BufferCapacity: 8), _ => { });

        public void Dispose() => _subscription.Dispose();
    }

    private sealed class RogueConnectionReader : IDisposable
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        public RogueConnectionReader(CouchCoopRuntimeHost runtime) => _ = runtime.GetCurrentMultiplayerConnection();

        public void Dispose() { }
    }

    private sealed class RogueConnectionSubscriber : IDisposable
    {
        private readonly IDisposable _subscription;

        [MethodImpl(MethodImplOptions.NoInlining)]
        public RogueConnectionSubscriber(CouchCoopRuntimeHost runtime)
            => _subscription = runtime.SubscribeMultiplayerConnection(_ => { });

        public void Dispose() => _subscription.Dispose();
    }

    // The next tracker: subscribes to the game's screen event through the CouchCoop front, from its own method.
    private sealed class RogueScreenWatcher : IDisposable
    {
        private readonly IDisposable? _subscription;

        public RogueScreenWatcher() => _subscription = Start();

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static IDisposable? Start() => GameScreenContext.SubscribeUpdated(() => { });

        public void Dispose() => _subscription?.Dispose();
    }

    private sealed class RogueScreenPoller : IDisposable
    {
        public RogueScreenPoller() => Poll();

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Poll() => GameScreenContext.GetCurrent();

        public void Dispose() { }
    }

    private sealed class RogueMainThreadWaker : IDisposable
    {
        public RogueMainThreadWaker() => Wake();

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void Wake() => GameMainThread.Invoke(() => true);

        public void Dispose() { }
    }

    // ---- the composed host --------------------------------------------------------------------------------

    /// <summary>What a phase is allowed to have done, and the readings it is compared against.</summary>
    private readonly record struct Counters(
        long StateCaptures,
        long StateSubscribes,
        long SceneSubscribes,
        long HintSubscribes,
        long ConnectionUses,
        long ScreenSubscribes,
        long ScreenReads,
        long Dispatches,
        long Violations,
        long Timers,
        long PoolItems);

    private sealed class ZeroClientContractViolation(string message) : Exception(message);

    private sealed class FakeClock
    {
        private long _now = 1_000_000;

        public long Now => Interlocked.Read(ref _now);

        public void Advance(TimeSpan by) => Interlocked.Add(ref _now, (long)by.TotalMilliseconds);
    }

    private sealed class Rig : IAsyncDisposable
    {
        private readonly List<string> _tripwire = [];
        private IDisposable? _rogue;

        private Rig(
            CountingRuntime runtime, FakeScreens screens, FakeMainThread mainThread, FakeClock clock,
            CouchCoopRuntimeHost host, CouchCoopHostUiServices services)
        {
            Runtime = runtime;
            Screens = screens;
            MainThread = mainThread;
            Clock = clock;
            Host = host;
            Services = services;
        }

        public CountingRuntime Runtime { get; }
        public FakeScreens Screens { get; }
        public FakeMainThread MainThread { get; }
        public FakeClock Clock { get; }
        public CouchCoopRuntimeHost Host { get; }
        public CouchCoopHostUiServices Services { get; }
        public Uri BaseUri { get; private set; } = new("http://127.0.0.1/");

        /// <summary>Managed timers alive before the composed host existed: other suites' leftovers are not the host's.</summary>
        public long BaselineTimers { get; private set; }
        public IReadOnlyList<string> TripwireLines => _tripwire;

        public HotReloadableBrowserServerHost Server
            => (HotReloadableBrowserServerHost)(Services.HotServerHost
                ?? throw new InvalidOperationException("The composed host has no browser server."));

        /// <param name="compose">A component "built at mod init", constructed after the services exist and before they start.</param>
        public static async Task<Rig> StartAsync(string root, Func<Rig, IDisposable>? compose = null)
        {
            var clock = new FakeClock();
            var runtime = new CountingRuntime();
            var screens = new FakeScreens();
            var mainThread = new FakeMainThread();
            var host = new CouchCoopRuntimeHost(
                new CouchCoopRuntimeDependencies(
                    runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime,
                    Lifetime: null, MultiplayerConnection: runtime),
                _ => { });
            var services = new CouchCoopHostUiServices(
                host, root, IPAddress.Loopback, ReserveEphemeralPort(), _ => { }, deferDiscoveryServices: true);

            var rig = new Rig(runtime, screens, mainThread, clock, host, services) { BaselineTimers = Timer.ActiveCount };
            ZeroClientGuard.ResetForTests(armed: true);
            ZeroClientGuard.Clock = () => clock.Now;
            ZeroClientGuard.LogSink = line => { lock (rig._tripwire) rig._tripwire.Add(line); };
            GameScreenContext.Source = screens;
            GameMainThread.Source = mainThread;

            if (compose is not null)
            {
                rig._rogue = compose(rig);
            }

            var snapshot = await services.StartAsync();
            rig.BaseUri = snapshot.ListenerBaseUri
                ?? throw new InvalidOperationException("The composed host did not bind a listener.");
            return rig;
        }

        public async ValueTask DisposeAsync()
        {
            _rogue?.Dispose();
            await Services.DisposeAsync();
            GameScreenContext.Source = SpirectlGameScreenSource.Instance;
            GameMainThread.Source = SpirectlGameMainThread.Instance;
            ZeroClientGuard.ResetForTests();
        }

        public Counters Snapshot() => new(
            Runtime.StateCaptures,
            Runtime.StateSubscribes,
            Runtime.SceneSubscribes,
            Runtime.HintSubscribes,
            Runtime.ConnectionUses,
            Screens.Subscribes,
            Screens.Reads,
            MainThread.Dispatches,
            ZeroClientGuard.Violations,
            Timer.ActiveCount,
            ThreadPool.CompletedWorkItemCount);

        public bool IsFullyParked()
            => Runtime.StateLive == 0 && Runtime.SceneLive == 0 && Runtime.HintLive == 0
               && Screens.Live == 0 && !Server.IsHostingSupervisionActive;

        public string Describe()
            => $"stateLive={Runtime.StateLive} sceneLive={Runtime.SceneLive} hintLive={Runtime.HintLive} "
               + $"screenLive={Screens.Live} supervision={Server.IsHostingSupervisionActive}";

        /// <summary>
        /// THE CONTRACT. Everything since <paramref name="baseline"/> (or since construction, for the default) must be
        /// nothing, apart from what the caller names. With a <paramref name="window"/> it also sits quietly for that long
        /// and counts worker-pool work: a timer or a polling loop of any kind shows up there even when it is not
        /// behind one of the seams.
        /// </summary>
        public void AssertQuiet(
            string phase,
            Counters baseline,
            TimeSpan? window,
            long allowedScreenSubscribes = 0,
            long allowedDispatches = 0,
            long allowedTimers = 0)
        {
            if (window is { } observe)
            {
                Settle();
                baseline = baseline == default ? Snapshot() : baseline with { PoolItems = ThreadPool.CompletedWorkItemCount };
                Thread.Sleep(observe);
            }
            else if (baseline == default)
            {
                baseline = new Counters(0, 0, 0, 0, 0, 0, 0, 0, 0, BaselineTimers, ThreadPool.CompletedWorkItemCount);
            }

            var now = Snapshot();
            var problems = new List<string>();
            void Check(string what, long delta, long allowed = 0)
            {
                if (delta > allowed) problems.Add($"{delta} {what}" + (allowed > 0 ? $" (allowed {allowed})" : string.Empty));
            }

            Check("state captures", now.StateCaptures - baseline.StateCaptures);
            Check("state subscriptions", now.StateSubscribes - baseline.StateSubscribes);
            Check("scene subscriptions", now.SceneSubscribes - baseline.SceneSubscribes);
            Check("animation-hint subscriptions", now.HintSubscribes - baseline.HintSubscribes);
            Check("multiplayer-connection uses", now.ConnectionUses - baseline.ConnectionUses);
            Check("screen-event subscriptions", now.ScreenSubscribes - baseline.ScreenSubscribes, allowedScreenSubscribes);
            Check("screen reads", now.ScreenReads - baseline.ScreenReads);
            Check("main-thread dispatches", now.Dispatches - baseline.Dispatches, allowedDispatches);
            Check("tripwire violations", now.Violations - baseline.Violations);
            // EXACT for every managed timer (System.Threading.Timer, Task.Delay, CancelAfter, PeriodicTimer all sit on
            // the same queue): a recurring timer is one that is still there when nothing is asked of the host.
            // It is a LEVEL, not a delta: measured against what was alive before the host existed, so a timer created
            // before this phase began still counts against it.
            Check("active timers", now.Timers - BaselineTimers, allowedTimers);
            if (window is not null)
            {
                // The worker-pool census is deliberately coarse. Teardown and the runtime itself leave a few stray
                // items behind (measured: up to 3, decaying), so this only catches what timers cannot: a hot loop.
                Check("worker-pool work items (a hot loop is running)", now.PoolItems - baseline.PoolItems, HotLoopItems);
            }

            if (problems.Count > 0)
            {
                throw new ZeroClientContractViolation($"[{phase}] the host did work nobody asked for: {string.Join("; ", problems)}");
            }
        }

        // Let queued completions from the previous step drain, so the census measures steady state.
        private static void Settle()
        {
            var deadline = Environment.TickCount64 + 3000;
            while (ThreadPool.PendingWorkItemCount > 0 && Environment.TickCount64 < deadline)
            {
                Thread.Sleep(20);
            }

            Thread.Sleep(400);
        }

        /// <summary>
        /// Waits for the host to give back every timer it took. Teardown (a socket's close handshake, a registry row's
        /// bookkeeping) needs a moment after the last subscription is released, so the observed window that follows
        /// a release starts here.
        /// </summary>
        public async Task<bool> QuiesceAsync(long allowedTimers = 0, int timeoutMs = 15_000)
        {
            var settled = await WaitAsync(() => Timer.ActiveCount - BaselineTimers <= allowedTimers, timeoutMs);
            await Task.Delay(300);
            return settled;
        }

        public async Task<bool> WaitAsync(Func<bool> condition, int timeoutMs = 10_000)
        {
            var deadline = Environment.TickCount64 + timeoutMs;
            while (Environment.TickCount64 < deadline)
            {
                if (condition()) return true;
                await Task.Delay(25);
            }

            return condition();
        }

        public async Task<Viewer> ConnectViewerAsync(bool watch, bool staticBackground)
        {
            var viewer = await Viewer.ConnectAsync(
                BaseUri.Port,
                $"watch={(watch ? 1 : 0)}&staticBg={(staticBackground ? 1 : 0)}&cardFlight=1&handTween=1&trailDrive=0");
            Expect(viewer.FirstMessage.Contains("\"session\"", StringComparison.Ordinal),
                "a viewer's first frame is its session envelope");
            return viewer;
        }

        private static int ReserveEphemeralPort()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }
    }

    /// <summary>
    /// A browser, as far as the host can tell: a raw TCP socket speaking just enough of RFC 6455 to open /ws, read
    /// the session envelope and close. Not <c>ClientWebSocket</c> on purpose: its connection pool keeps timers of its
    /// own in THIS process, which the worker-pool census would then blame on the host.
    /// </summary>
    private sealed class Viewer : IAsyncDisposable
    {
        private readonly TcpClient _tcp;
        private readonly NetworkStream _stream;

        private Viewer(TcpClient tcp, string firstMessage)
        {
            _tcp = tcp;
            _stream = tcp.GetStream();
            FirstMessage = firstMessage;
        }

        public string FirstMessage { get; }

        public static async Task<Viewer> ConnectAsync(int port, string query)
        {
            var tcp = new TcpClient();
            await tcp.ConnectAsync(IPAddress.Loopback, port);
            var stream = tcp.GetStream();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var key = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16));
            var request = $"GET /ws?{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                + $"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(request), timeout.Token);

            var head = new StringBuilder();
            var one = new byte[1];
            while (!head.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
            {
                if (await stream.ReadAsync(one, timeout.Token) == 0) throw new IOException("the host closed the upgrade");
                head.Append((char)one[0]);
            }

            Expect(head.ToString().StartsWith("HTTP/1.1 101", StringComparison.Ordinal),
                $"the host upgraded /ws to a WebSocket (got: {head.ToString().Split('\n')[0].Trim()})");

            // Server frames are unmasked. Read one whole message, following continuation frames.
            var message = new MemoryStream();
            while (true)
            {
                var header = new byte[2];
                await ReadExactAsync(stream, header, timeout.Token);
                var fin = (header[0] & 0x80) != 0;
                long length = header[1] & 0x7F;
                if (length == 126)
                {
                    var ext = new byte[2];
                    await ReadExactAsync(stream, ext, timeout.Token);
                    length = (ext[0] << 8) | ext[1];
                }
                else if (length == 127)
                {
                    var ext = new byte[8];
                    await ReadExactAsync(stream, ext, timeout.Token);
                    length = 0;
                    foreach (var part in ext) length = (length << 8) | part;
                }

                var payload = new byte[length];
                await ReadExactAsync(stream, payload, timeout.Token);
                message.Write(payload);
                if (fin) break;
            }

            return new Viewer(tcp, Encoding.UTF8.GetString(message.ToArray()));
        }

        private static async Task ReadExactAsync(NetworkStream stream, byte[] buffer, CancellationToken token)
        {
            var read = 0;
            while (read < buffer.Length)
            {
                var n = await stream.ReadAsync(buffer.AsMemory(read), token);
                if (n == 0) throw new IOException("the host closed the socket mid-frame");
                read += n;
            }
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                // A masked close frame, status 1000: what a browser sends when its tab closes.
                var mask = System.Security.Cryptography.RandomNumberGenerator.GetBytes(4);
                var frame = new byte[] { 0x88, 0x82, mask[0], mask[1], mask[2], mask[3], (byte)(0x03 ^ mask[0]), (byte)(0xE8 ^ mask[1]) };
                await _stream.WriteAsync(frame);
            }
            catch (IOException)
            {
            }

            _tcp.Dispose();
        }
    }

    // ---- counting doubles ---------------------------------------------------------------------------------

    private sealed class FakeScreens : IGameScreenSource
    {
        private readonly object _gate = new();
        private readonly List<Action> _handlers = [];
        private long _subscribes;
        private long _reads;

        public long Subscribes => Interlocked.Read(ref _subscribes);
        public long Reads => Interlocked.Read(ref _reads);
        public int Live { get { lock (_gate) return _handlers.Count; } }

        public IDisposable? SubscribeUpdated(Action handler)
        {
            Interlocked.Increment(ref _subscribes);
            lock (_gate) _handlers.Add(handler);
            return new Release(() => { lock (_gate) _handlers.Remove(handler); });
        }

        public object? Current
        {
            get
            {
                Interlocked.Increment(ref _reads);
                return null;
            }
        }

        public bool IsCurrent(object? node)
        {
            Interlocked.Increment(ref _reads);
            return false;
        }

        // The game raising "the screen on top may have changed" to whoever listens.
        public void Fire()
        {
            Action[] handlers;
            lock (_gate) handlers = [.. _handlers];
            foreach (var handler in handlers) handler();
        }
    }

    // Counts every marshal and runs none of them: the closures reach Godot types, which cannot exist in this process.
    private sealed class FakeMainThread : IGameMainThread
    {
        private long _dispatches;

        public long Dispatches => Interlocked.Read(ref _dispatches);

        public T Invoke<T>(Func<T> action)
        {
            Interlocked.Increment(ref _dispatches);
            return default!;
        }

        public Task<T> InvokeAsync<T>(Func<Task<T>> action)
        {
            Interlocked.Increment(ref _dispatches);
            return Task.FromResult(default(T)!);
        }
    }

    private sealed class Release(Action release) : IDisposable
    {
        private Action? _release = release;

        public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
    }

    /// <summary>
    /// Every port of the runtime host, all supported, counting each use of a state or scene entry. Live counts fall
    /// when the subscription is disposed, which is how "released" is observed.
    /// </summary>
    private sealed class CountingRuntime : IRuntimeCapabilitySource, IRuntimeAssetSource, IRuntimeStateSource,
        IAnimationHintSource, IRuntimeSceneDeltaSource, IGameModelSource, ISpineCatalogSource, ISpineGeoClipBaker,
        ISemanticActionSource, IRuntimeSceneWatchControlSource, IRuntimeMultiplayerConnectionSource
    {
        private long _stateCaptures;
        private long _stateSubscribes;
        private long _sceneSubscribes;
        private long _hintSubscribes;
        private long _connectionUses;
        private int _stateLive;
        private int _sceneLive;
        private int _hintLive;

        public string Mode { get; set; } = "main-menu";
        public long StateCaptures => Interlocked.Read(ref _stateCaptures);
        public long StateSubscribes => Interlocked.Read(ref _stateSubscribes);
        public long SceneSubscribes => Interlocked.Read(ref _sceneSubscribes);
        public long HintSubscribes => Interlocked.Read(ref _hintSubscribes);
        public long ConnectionUses => Interlocked.Read(ref _connectionUses);
        public int StateLive => Volatile.Read(ref _stateLive);
        public int SceneLive => Volatile.Read(ref _sceneLive);
        public int HintLive => Volatile.Read(ref _hintLive);

        public IRuntimeSceneWatchControls SceneWatchControls => Spirectl.Sts2.Live.Sts2RuntimeSceneWatchControls.Instance;
        public ISpirectlAssetProvider Assets { get; } = new EmptyAssets();

        public EmbeddableRuntimeCapabilities GetCapabilities()
            => new(
                "spirectl/v1", "test-game", "test-bridge", "embedded", RuntimeAttachmentState.Attached,
                DataSourceKind.Stub, Provisional: false,
                [
                    Supported(CouchCoopRuntimeHost.StateCapability),
                    Supported(CouchCoopRuntimeHost.GameModelsCapability),
                    Supported(CouchCoopRuntimeHost.SemanticActionsCapability),
                    Supported(CouchCoopRuntimeHost.AssetExtractionCapability),
                    Supported(CouchCoopRuntimeHost.LiveSts2HostCapability),
                    Supported(CouchCoopRuntimeHost.AnimationHintsCapability),
                    Supported(CouchCoopRuntimeHost.SpineCatalogCapability),
                    Supported(CouchCoopRuntimeHost.SceneCapability),
                ],
                []);

        private static EmbeddableRuntimeCapability Supported(string id)
            => new(id, id, Supported: true, Provisional: false, UnsupportedReason: null);

        public CurrentStateResult GetCurrentState(CurrentStateRequest request)
        {
            Interlocked.Increment(ref _stateCaptures);
            return new CurrentStateResult(true, new StateSnapshot(StateSnapshot.CurrentSchemaVersion, "en", Mode, null, null), null);
        }

        public IDisposable SubscribeCurrentState(
            CurrentStateSubscriptionRequest request, Action<CurrentStateWatchEvent> onEvent, Action<EmbeddableRuntimeError>? onError = null)
        {
            Interlocked.Increment(ref _stateSubscribes);
            Interlocked.Increment(ref _stateLive);
            return new Release(() => Interlocked.Decrement(ref _stateLive));
        }

        public async IAsyncEnumerable<CurrentStateWatchEvent> WatchCurrentStateAsync(
            CurrentStateSubscriptionRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _stateSubscribes);
            await Task.CompletedTask;
            yield break;
        }

        public IDisposable SubscribeAnimationHints(
            AnimationHintSubscriptionRequest request, Action<TweenAnimationHint> onHint, Action<EmbeddableRuntimeError>? onError = null)
        {
            Interlocked.Increment(ref _hintSubscribes);
            Interlocked.Increment(ref _hintLive);
            return new Release(() => Interlocked.Decrement(ref _hintLive));
        }

        public async IAsyncEnumerable<TweenAnimationHint> WatchAnimationHintsAsync(
            AnimationHintSubscriptionRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _hintSubscribes);
            await Task.CompletedTask;
            yield break;
        }

        public IDisposable SubscribeRuntimeSceneDelta(
            RuntimeSceneSubscriptionRequest request, Action<RuntimeSceneDelta> onDelta, Action<EmbeddableRuntimeError>? onError = null)
        {
            Interlocked.Increment(ref _sceneSubscribes);
            Interlocked.Increment(ref _sceneLive);
            return new Release(() => Interlocked.Decrement(ref _sceneLive));
        }

        public MultiplayerConnectionSnapshot? GetCurrentMultiplayerConnection()
        {
            Interlocked.Increment(ref _connectionUses);
            return null;
        }

        public IDisposable SubscribeMultiplayerConnection(Action<MultiplayerConnectionSnapshot> onEvent)
        {
            Interlocked.Increment(ref _connectionUses);
            return new Release(() => { });
        }

        public ModelCatalogOperationResult GetModels(ModelCatalogRequestSnapshot request) => throw new NotSupportedException();

        public SpineCatalogOperationResult GetSpineCatalog(SpineCatalogRequestSnapshot request) => throw new NotSupportedException();

        public SpineGeoClipBakeResultSnapshot BakeSpineGeoClip(SpineGeoClipBakeRequestSnapshot request) => throw new NotSupportedException();

        public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request) => new("ok", []);

        public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request) => throw new NotSupportedException();

        private sealed class EmptyAssets : ISpirectlAssetProvider
        {
            public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
                => new(false, null, new EmbeddableAssetError("missing-asset", "test"));

            public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request) => new("ok", []);
        }
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"ZeroClientContractTests assertion failed: {label}");
        }
    }
}
