using System.Net;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;

// THE IDLE-HOST CONTRACT. With the mod installed and nobody connected, a player's machine must behave like an
// unmodded one — that is the product requirement, and these are the two places it used to be broken:
//
//   1. The QR/activity panel controller found its screens by recursively walking the WHOLE scene tree, four
//      times a second, forever, on the game main thread. It ran in combat, on the map and on the main menu,
//      with a browser client connected or with none ever connected.
//   2. The LAN discovery responder, the `.local` mDNS name and the secure-origin certificate fetch all started
//      at mod init — so a player who never opened a co-op lobby still had a multicast socket parsing their
//      whole LAN's mDNS traffic and made one outbound WAN request on every single launch.
//
// Both are now gated: screens arrive by Harmony (LobbyScreenMountPatch → LobbyScreenRegistry) and the tick
// exists only while that registry is occupied; the network services wait for a HOST lobby to be on screen.
// The controller itself is Godot-bound, so what is asserted here is the pure half — the registry's arm/disarm
// contract, the patch's target resolution, and the host-UI deferral over real loopback sockets.
//
//   3. …and "only while that registry is occupied" turned out to be the WHOLE SESSION. The game readies its
//      character-select screen during main-menu load and never frees that node, so the registry never emptied
//      and the 0.25s chain, once started at the main menu, ran for the rest of the process on both platforms.
//      Each tick was cheap after (1) — a prune plus one IsVisibleInTree per screen — but it never parked.
//      Presence is now PUSHED (the game's active-screen event + Godot's visibility_changed) and the timer
//      exists only while a lobby screen is the CURRENT screen. LobbyEvaluationPlanner is that rule, kept
//      Godot-free for the same reason LobbyScreenRegistry is.
internal static class IdleHostCostTests
{
    public static async Task RunAsync(string rootPath)
    {
        EmptyRegistryParksTheTick();
        FirstScreenArmsTheTickAndOnlyTheFirst();
        AFreedScreenIsPrunedAndParksTheTick();
        AHiddenOrDetachedScreenKeepsItsEntry();
        LobbyEvaluationContract();
        MountPlanContract();
        MountTargetsResolve();
        PauseMenuMountTargetsResolve();
        MountPatchRefusesAnInheritedReady();
        await DeferredHostUiKeepsTheListenerButNotTheNetworkAsync(rootPath);
        await PendingDiscoveryCannotPublishAfterStopAsync(rootPath);

        Console.WriteLine("IdleHostCostTests: ok");
    }

    // ---- LobbyScreenRegistry: the arm/disarm contract the timer's lifetime rides on -------------------

    // THE WHOLE POINT. An empty registry means "no lobby anywhere", which is the state a player is in for
    // almost all of a run — and it must cost nothing at all.
    private static void EmptyRegistryParksTheTick()
    {
        var registry = new LobbyScreenRegistry(_ => true);
        Expect(!registry.IsOccupied, "a fresh registry is unoccupied, so the controller schedules no tick");
        Expect(registry.Live().Count == 0, "an empty registry has no screens to scan");
    }

    // Add returns the EMPTY -> occupied transition, and that return value is what starts the timer chain. A
    // second screen (both lobby screens can be mounted at once) must NOT report a transition, or the
    // controller would start a second, permanently-doubled chain.
    private static void FirstScreenArmsTheTickAndOnlyTheFirst()
    {
        var registry = new LobbyScreenRegistry(_ => true);

        Expect(registry.Add(11) is { Added: true, BecameOccupied: true }, "the first screen reports the transition that starts the tick");
        Expect(registry.IsOccupied, "the registry is occupied after the first screen");
        Expect(registry.Add(22) is { Added: true, BecameOccupied: false }, "a SECOND screen is added without starting a second chain");
        Expect(registry.Add(11) is { Added: false, BecameOccupied: false }, "a re-readied screen (RequestReady) must not start a second chain either");
        Expect(registry.Live().Count == 2, "both distinct screens survive; the duplicate was folded");
    }

    // Liveness is the freed check, and emptying the registry is what tells the tick to stop. Without this the
    // controller would keep ticking for the rest of the process after the player left the lobby — which is
    // the regression the whole change exists to prevent.
    private static void AFreedScreenIsPrunedAndParksTheTick()
    {
        var alive = new HashSet<ulong> { 11, 22 };
        var registry = new LobbyScreenRegistry(id => alive.Contains(id));
        _ = registry.Add(11);
        _ = registry.Add(22);

        alive.Remove(22);
        Expect(registry.Live() is [11], "a freed screen is dropped and the survivor is kept");
        Expect(registry.IsOccupied, "one live screen still keeps the tick running");

        alive.Clear();
        Expect(registry.Live().Count == 0, "with every screen freed the registry empties");
        Expect(!registry.IsOccupied, "…and the controller parks the tick until the next _Ready");

        // Re-arming after parking is the "back out to the menu and come back" path.
        alive.Add(33);
        Expect(registry.Add(33) is { Added: true, BecameOccupied: true }, "a screen mounted after parking reports the transition that restarts the tick");
    }

    // NOT "is it in the tree". Godot runs _Ready once per node, so a screen that is hidden behind a submenu or
    // detached and re-attached would never announce itself again — dropping it on tree-exit would cost the
    // lobby its panels permanently. The controller re-reads VISIBILITY every tick instead.
    private static void AHiddenOrDetachedScreenKeepsItsEntry()
    {
        var registry = new LobbyScreenRegistry(_ => true); // alive, whatever the tree says
        _ = registry.Add(11);
        Expect(registry.Live() is [11], "a screen that is merely hidden or detached keeps its registration");
    }

    // ---- LobbyEvaluationPlanner: what wakes the evaluation, and when state is pulled ------------------

    // Internal for the same reason as MountPlanContract below: the `-- host-guards` verb runs this slice alone,
    // and this is the rule that decides whether the lobby gets a QR button at all.
    internal static void LobbyEvaluationContract()
    {
        NoScreensMeansNoTimerAtAll();
        AVisibleButNotCurrentLobbyIsLeftAlone();
        ACurrentLobbyPullsStateAndTicks();
        AHiddenLobbyGivesUpItsPanelAndParks();
        WithoutTheScreenEventNothingIsGated();
    }

    // The registry empties only when every screen has been FREED, which is why this is not the case that
    // mattered — but it is still the floor: nothing registered, nothing to do.
    private static void NoScreensMeansNoTimerAtAll()
    {
        var plan = LobbyEvaluationPlanner.Decide([], currentScreenKnown: true);

        Expect(!plan.PullState, "no lobby screen, no state pull");
        Expect(!plan.KeepTicking, "no lobby screen, no timer");
        Expect(plan.Alert == LobbyAlertUpdate.Rearm, "no lobby on screen re-arms the once-per-mount alert latch");
    }

    // THE CASE THE CHANGE EXISTS FOR, and the one with a trap in it. A lobby screen sitting VISIBLE underneath
    // the screen the player is actually on (a submenu, a modal) must cost nothing: no state pull, no timer. But
    // it must also keep its PANEL — the game's current-screen answer is whatever is on top, including a modal
    // opened over the lobby, and CouchCoop's own dialog is a child of that panel, so "not current ⇒ remove"
    // would close the player's dialog out from under them every time. Removal stays keyed on VISIBILITY.
    private static void AVisibleButNotCurrentLobbyIsLeftAlone()
    {
        var parked = new LobbyScreenFacts(Id: 11, Visible: true, Current: false);
        var plan = LobbyEvaluationPlanner.Decide([parked], currentScreenKnown: true);

        Expect(!plan.PullState, "a lobby that is not the current screen does NOT pull state");
        Expect(!plan.KeepTicking, "…and does not keep a timer alive either");
        Expect(
            LobbyEvaluationPlanner.IsParkedUnderAnotherScreen(parked, currentScreenKnown: true),
            "…and the screen is left entirely alone, panel included");
        Expect(
            plan.Alert == LobbyAlertUpdate.Hold,
            "a modal over the lobby is not an unmount: re-arming here would pop the transport alert again "
            + "every time the player closed a dialog");
    }

    // The only state in which the expensive half runs. netGameType flips live while the host sits in the lobby
    // (a singleplayer lobby becoming a host lobby), so presence alone cannot be read once and trusted — that is
    // the whole reason a bounded tick survives, and it survives ONLY here.
    private static void ACurrentLobbyPullsStateAndTicks()
    {
        var current = new LobbyScreenFacts(Id: 22, Visible: true, Current: true);
        var plan = LobbyEvaluationPlanner.Decide([current], currentScreenKnown: true);

        Expect(plan.PullState, "the current lobby screen is the one case that pulls state");
        Expect(plan.KeepTicking, "…and the only one that keeps the 0.25s netGameType re-read alive");
        Expect(plan.Alert == LobbyAlertUpdate.Decide, "the alert is decided from whatever panel was mounted");
        Expect(
            !LobbyEvaluationPlanner.IsParkedUnderAnotherScreen(current, currentScreenKnown: true),
            "the current screen is never skipped");

        // BOTH lobby screens can be registered at once, and only one of them is ever current. The gate is an
        // ANY over the registry, not a property of the first entry.
        var mixed = LobbyEvaluationPlanner.Decide(
            [new LobbyScreenFacts(11, Visible: true, Current: false), current],
            currentScreenKnown: true);
        Expect(mixed.PullState && mixed.KeepTicking, "a current screen anywhere in the registry arms the evaluation");
    }

    // Leaving the lobby hides the screen; it is NOT freed, so the registry keeps it (Godot runs _Ready once, so
    // dropping it would lose a screen we could never be told about again). Before this change that left the
    // chain ticking forever. Now: the panel goes, the alert latch re-arms, and the timer stops.
    private static void AHiddenLobbyGivesUpItsPanelAndParks()
    {
        var hidden = new LobbyScreenFacts(Id: 11, Visible: false, Current: false);
        var plan = LobbyEvaluationPlanner.Decide([hidden], currentScreenKnown: true);

        Expect(!plan.PullState, "a hidden lobby screen has nothing to decide");
        Expect(!plan.KeepTicking, "…and parks the timer instead of running it for the rest of the session");
        Expect(
            !LobbyEvaluationPlanner.IsParkedUnderAnotherScreen(hidden, currentScreenKnown: true),
            "a hidden screen is NOT left alone — it gives up its panel, exactly as before this change");
        Expect(plan.Alert == LobbyAlertUpdate.Rearm, "backing out to the menu re-arms the alert latch");
    }

    // THE SAFETY VALVE. `currentScreenKnown` is false when the game's active-screen event could not be
    // subscribed, or when the current screen cannot be resolved at that moment. "Not current" and "could not
    // tell" are the same bit in the facts and must not mean the same thing: without a subscription nothing
    // would ever wake an evaluation, so gating on current would cost the lobby its QR button on a game build
    // whose seam has moved. The answer degrades to exactly the pre-change behaviour.
    private static void WithoutTheScreenEventNothingIsGated()
    {
        var visible = new LobbyScreenFacts(Id: 11, Visible: true, Current: false);
        var plan = LobbyEvaluationPlanner.Decide([visible], currentScreenKnown: false);

        Expect(plan.PullState, "with no screen event the pull falls back to the visibility gate");
        Expect(plan.KeepTicking, "…and the 0.25s chain runs unconditionally, as it did before");
        Expect(plan.Alert == LobbyAlertUpdate.Decide, "…and the alert is decided, not held");
        Expect(
            !LobbyEvaluationPlanner.IsParkedUnderAnotherScreen(visible, currentScreenKnown: false),
            "…and no screen is skipped for being 'not current', because nothing knows which one is");

        var hidden = LobbyEvaluationPlanner.Decide(
            [new LobbyScreenFacts(11, Visible: false, Current: false)],
            currentScreenKnown: false);
        Expect(!hidden.PullState, "the fallback still skips the pull when nothing is visible");
        Expect(hidden.KeepTicking, "…while keeping the unconditional chain, which is what it is falling back TO");
        Expect(hidden.Alert == LobbyAlertUpdate.Rearm, "…and still re-arms the alert latch with nothing on screen");
    }

    // ---- LobbyScreenMountPlan: a failed patch is retried, a successful one never is -------------------

    // THE REGRESSION THIS ENCODES. The patch used to latch "applied" on its first call whatever the outcome,
    // and its documented consolation — the controller's startup scan — finds nothing, because that scan runs
    // at mod init when no lobby screen exists (`seeded=0` on every launch). So one failed attempt cost the
    // lobby its QR button for the whole process. It happened for real: MonoMod's native exec-helper could not
    // be dlopened at mod-init time, all eleven of the mod's Harmony patches died, and the very next dlopen
    // 18ms later succeeded. A failure is worth retrying; a success never is.
    // Internal so the `-- host-guards` verb can run these alone: the full sequence reaches this file near its
    // end, and for six days it aborted long before getting here.
    internal static void MountPlanContract()
    {
        MountPlanRetriesOnlyWhatFailed();
        MountPlanIsInertOnceComplete();
        MountPlanSurvivesAThrowingTarget();
    }

    private static void MountPlanRetriesOnlyWhatFailed()
    {
        var plan = new LobbyScreenMountPlan(["alpha", "beta"]);
        Expect(plan.TargetCount == 2, "the plan remembers its denominator for the targets=n/m line");
        Expect(!plan.IsComplete, "a fresh plan has everything to do");

        var attempted = new List<string>();
        var patched = plan.Attempt(target =>
        {
            attempted.Add(target);
            return target == "alpha"; // beta fails, exactly as a patch does when the native helper is missing
        });

        Expect(!patched, "an attempt that could not install every target reports incomplete");
        Expect(attempted.Count == 2, "the first attempt tries both targets");
        Expect(plan.Pending is ["beta"], "the installed target is dropped and only the failure stays pending");

        attempted.Clear();
        var second = plan.Attempt(target =>
        {
            attempted.Add(target);
            return true;
        });

        Expect(second, "a retry that installs the remainder completes the plan");
        Expect(attempted is ["beta"], "the retry re-patches ONLY the pending target — Harmony would happily install a second copy of the other");
        Expect(plan.IsComplete && plan.Pending.Count == 0, "a completed plan has nothing left to attempt");
    }

    // Once everything is hooked the plan must go inert, because the panel controller calls Apply() a second
    // time on every process and a second postfix on the same _Ready would report each mount twice.
    private static void MountPlanIsInertOnceComplete()
    {
        var plan = new LobbyScreenMountPlan(["alpha"]);
        Expect(plan.Attempt(_ => true), "the first attempt completes the plan");

        var calls = 0;
        Expect(plan.Attempt(_ => { calls++; return true; }), "a completed plan still reports complete");
        Expect(calls == 0, "…and does no work: an installed target is never patched twice");
    }

    // A target that THROWS must not take its siblings down with it, and must stay retryable. The live failure
    // mode is a DllNotFoundException out of Harmony, which is per-target and transient.
    private static void MountPlanSurvivesAThrowingTarget()
    {
        var plan = new LobbyScreenMountPlan(["alpha", "beta"]);
        var complete = plan.Attempt(target => target == "alpha"
            ? true
            : throw new DllNotFoundException("mm-exhelper.so: undefined symbol: _Unwind_RaiseException"));

        Expect(!complete, "a throwing target leaves the plan incomplete");
        Expect(plan.Pending is ["beta"], "the throw is a failure, not an abort — the sibling still installed and the thrower stays pending");
    }

    // ---- LobbyScreenMountPatch: the game seam ---------------------------------------------------------

    // The reflection guard, same contract as NetTransportPatchTargetsTests: if a game update renames either
    // lobby screen or stops declaring _Ready, this fails the build rather than silently costing the lobby its
    // QR button. Pure metadata reflection — no Harmony install, no live game.
    // Internal, not private: the `-- beta-targets` verb runs the four patch-TARGET legs alone against a given
    // game build, and it must run THIS leg rather than a second copy of it.
    internal static void MountTargetsResolve()
    {
        Expect(LobbyScreenMountPatch.ScreenTypeNames.Count == 2, "both lobby screens are patch targets");

        foreach (var typeName in LobbyScreenMountPatch.ScreenTypeNames)
        {
            var target = LobbyScreenMountPatch.ResolveDeclaredReady(typeName);
            Expect(target is not null, $"{typeName}._Ready resolves against the installed STS2 assemblies");
            Expect(
                target!.DeclaringType?.FullName == typeName,
                $"{typeName} DECLARES _Ready — an inherited one would be Godot.Node's, and patching that hooks every node in the game");
        }
    }

    // ---- PauseMenuMountPatch: the other game seam ----------------------------------------------------
    //
    // Same contract, same consequence, one screen: if a game update renames NPauseMenu or stops declaring
    // _Ready, this fails the build rather than silently costing the pause menu its QR row. Internal for the
    // same reason as MountTargetsResolve above — the `-- beta-targets` verb runs this leg rather than a copy.
    internal static void PauseMenuMountTargetsResolve()
    {
        Expect(PauseMenuMountPatch.ScreenTypeNames.Count == 1, "the pause menu is the one patch target");

        foreach (var typeName in PauseMenuMountPatch.ScreenTypeNames)
        {
            var target = PauseMenuMountPatch.ResolveDeclaredReady(typeName);
            Expect(target is not null, $"{typeName}._Ready resolves against the installed STS2 assemblies");
            Expect(
                target!.DeclaringType?.FullName == typeName,
                $"{typeName} DECLARES _Ready — an inherited one would be Godot.Node's, and patching that hooks every node in the game");
        }
    }

    // THE HAZARD THIS PATCH IS SHAPED AROUND. _EnterTree/_ExitTree are the obvious mount seams and neither
    // screen declares them, so AccessTools hands back Godot.Node's — patching which would instrument EVERY
    // node attach in the process, a far worse version of the cost being removed. The resolver must refuse an
    // inherited method, so this asserts it against a type that is KNOWN to only inherit _Ready.
    private static void MountPatchRefusesAnInheritedReady()
    {
        // Godot.Node itself declares no _Ready override chain below it to find; a plain Control does not
        // declare _Ready either, so resolving against it must be refused rather than silently patched.
        var refused = LobbyScreenMountPatch.ResolveDeclaredReady("Godot.Control");
        Expect(refused is null, "a type that only INHERITS _Ready is refused, never patched");
    }

    // ---- CouchCoopHostUiServices: the listener starts, the network does not ---------------------------

    // The deferral, over real loopback sockets. StartAsync must still bind the browser listener (that is the
    // idle server the product accepts, and every QA harness expects the port from launch) while leaving the
    // LAN discovery responder, the mDNS name and the WAN certificate fetch for the first host lobby.
    public static async Task DeferredHostUiKeepsTheListenerButNotTheNetworkAsync(string rootPath)
    {
        var logs = new List<string>();
        await using var services = new CouchCoopHostUiServices(
            new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test"), new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-test")), logs.Add),
            rootPath,
            IPAddress.Loopback,
            preferredPort: ReserveEphemeralPort(),
            logs.Add,
            deferDiscoveryServices: true);

        var snapshot = await services.StartAsync();
        Expect(snapshot.ListenerBaseUri is not null, "a deferred host UI still binds the browser listener at startup");
        Expect(snapshot.Available, "…and still advertises a join URL, so the QR is ready the moment a lobby opens");
        Expect(
            !logs.Any(log => log.Contains("host discovery services started", StringComparison.Ordinal)),
            "NOTHING touches the network until a host lobby is on screen — no mDNS socket, no discovery responder, no WAN certificate fetch");

        // …and the arm, which is what CouchCoopQrHostPanelController.HostLobbyPresented calls.
        services.StartDiscoveryServices();
        Expect(
            logs.Count(log => log.Contains("host discovery services started", StringComparison.Ordinal)) == 1,
            "the first host lobby starts the discovery services");

        // The controller raises HostLobbyPresented on EVERY tick while a host lobby is up (there is
        // deliberately no 'already armed?' flag there to fall out of sync), so the latch has to live here.
        services.StartDiscoveryServices();
        services.StartDiscoveryServices();
        Expect(
            logs.Count(log => log.Contains("host discovery services started", StringComparison.Ordinal)) == 1,
            "re-arming is idempotent — a 4 Hz tick must not open a second mDNS socket every 250ms");

        var port = snapshot.ListenerBaseUri!.Port;
        Expect(await DiscoveryRepliesAsync(port), "hosting discovery answers a real loopback probe");
        for (var cycle = 0; cycle < 3; cycle++)
        {
            await services.StopDiscoveryServicesAsync();
            Expect(!services.DiscoveryServicesRunning, "ending hosting stops its discovery services");
            Expect(!await DiscoveryRepliesAsync(port), "a stopped hosting session answers no discovery probe");
            using var client = new System.Net.Sockets.TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, port);
            Expect(client.Connected, "the parked browser listener remains ready");
            services.StartDiscoveryServices();
            await services.DiscoveryServicesReady;
            Expect(await DiscoveryRepliesAsync(port), "the next hosting session is immediately discoverable");
        }

        // Start again before the old asynchronous socket teardown finishes. Its late completion must not
        // dispose the new responders or publish an old certificate result into the new session.
        var stopping = services.StopDiscoveryServicesAsync();
        services.StartDiscoveryServices();
        await stopping;
        await services.DiscoveryServicesReady;
        Expect(services.DiscoveryServicesRunning && await DiscoveryRepliesAsync(port),
            "a quick hosting restart survives completion of the old teardown");
        await services.StopDiscoveryServicesAsync();
        await services.StopDiscoveryServicesAsync();
        Expect(!await DiscoveryRepliesAsync(port), "repeated stop is idempotent");
    }

    public static async Task PendingDiscoveryCannotPublishAfterStopAsync(string rootPath)
    {
        var oldEnabled = Environment.GetEnvironmentVariable(SecureOriginCertificates.EnabledEnvironmentVariable);
        var oldHost = Environment.GetEnvironmentVariable(LanAddressRanking.AdvertisedHostEnvironmentVariable);
        var oldProvider = new DelayedProvider("old.example");
        var newProvider = new DelayedProvider("new.example");
        CouchCoopHostUiServices? services = null;
        try
        {
            Environment.SetEnvironmentVariable(SecureOriginCertificates.EnabledEnvironmentVariable, "1");
            Environment.SetEnvironmentVariable(LanAddressRanking.AdvertisedHostEnvironmentVariable, "192.168.50.20");
            var stub = new AssetCacheTokenEnvelopeTests.StubRuntime("idle-host-pending-test");
            var runtime = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
                stub, stub, stub, stub, stub, stub, stub, stub, stub, stub), _ => { });
            var attempts = 0;
            services = new CouchCoopHostUiServices(runtime, rootPath, IPAddress.Loopback,
                ReserveEphemeralPort(), _ => { }, deferDiscoveryServices: true,
                createCertificates: () => new SecureOriginCertificates(
                    ++attempts == 1 ? oldProvider : newProvider,
                    Path.Combine(rootPath, "certificate-cache-" + Guid.NewGuid().ToString("N")), _ => { }));
            await services.StartAsync();
            services.StartDiscoveryServices();
            await oldProvider.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var stopping = services.StopDiscoveryServicesAsync().AsTask();
            Expect(oldProvider.Cancellation.IsCancellationRequested, "ending hosting cancels its pending certificate fetch");
            services.StartDiscoveryServices();
            await services.DiscoveryServicesReady.WaitAsync(TimeSpan.FromSeconds(5));
            await newProvider.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Expect(attempts == 2 && !stopping.IsCompleted,
                "the next session starts without waiting for an old WAN request to finish");
            oldProvider.Complete.TrySetResult(null);
            await stopping.WaitAsync(TimeSpan.FromSeconds(5));
            Expect(services.Snapshot.SecureDomain == newProvider.Domain,
                "the old certificate result cannot replace the restarted session's snapshot");
            Expect(services.DiscoveryServicesRunning
                && await DiscoveryRepliesAsync(services.Snapshot.ListenerBaseUri!.Port),
                "the new discovery generation survives delayed old completion");
            newProvider.Complete.TrySetResult(null);
            await services.StopDiscoveryServicesAsync();
        }
        finally
        {
            oldProvider.Complete.TrySetResult(null);
            newProvider.Complete.TrySetResult(null);
            Environment.SetEnvironmentVariable(SecureOriginCertificates.EnabledEnvironmentVariable, oldEnabled);
            Environment.SetEnvironmentVariable(LanAddressRanking.AdvertisedHostEnvironmentVariable, oldHost);
            if (services is not null) await services.DisposeAsync();
        }
    }

    private sealed class DelayedProvider(string domain) : ISecureOriginCertificateProvider
    {
        public string Id => "delayed-test";
        public string Domain => domain;
        public CancellationToken Cancellation { get; private set; }
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<SecureCertificateBundle?> Complete { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<SecureCertificateBundle?> FetchAsync(HttpClient http, CancellationToken cancellationToken)
        {
            Cancellation = cancellationToken;
            Entered.TrySetResult();
            // Deliberately complete after cancellation to exercise stale asynchronous publication.
            return Complete.Task;
        }
    }

    private static async Task<bool> DiscoveryRepliesAsync(int port)
    {
        using var client = new System.Net.Sockets.UdpClient(System.Net.Sockets.AddressFamily.InterNetwork);
        client.Client.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        var probe = CouchCoop.MirrorProtocol.Discovery.HostDiscovery.EncodeProbe();
        await client.SendAsync(probe, new IPEndPoint(IPAddress.Loopback, port));
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        try
        {
            var reply = await client.ReceiveAsync(deadline.Token);
            return CouchCoop.MirrorProtocol.Discovery.HostDiscovery.TryDecodeReply(reply.Buffer)?.Port == port;
        }
        catch (OperationCanceledException) { return false; }
        catch (System.Net.Sockets.SocketException exception)
            when (exception.SocketErrorCode == System.Net.Sockets.SocketError.ConnectionReset) { return false; }
    }

    private static int ReserveEphemeralPort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"IdleHostCostTests assertion failed: {label}");
        }
    }
}
