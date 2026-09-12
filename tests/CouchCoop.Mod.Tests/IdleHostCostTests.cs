using System.Net;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Runtime;

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
internal static class IdleHostCostTests
{
    public static async Task RunAsync(string rootPath)
    {
        EmptyRegistryParksTheTick();
        FirstScreenArmsTheTickAndOnlyTheFirst();
        AFreedScreenIsPrunedAndParksTheTick();
        AHiddenOrDetachedScreenKeepsItsEntry();
        MountTargetsResolve();
        MountPatchRefusesAnInheritedReady();
        await DeferredHostUiKeepsTheListenerButNotTheNetworkAsync(rootPath);

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

        Expect(registry.Add(11), "the first screen reports the transition that starts the tick");
        Expect(registry.IsOccupied, "the registry is occupied after the first screen");
        Expect(!registry.Add(22), "a SECOND screen must not report a transition — one tick chain, not two");
        Expect(!registry.Add(11), "a re-readied screen (RequestReady) must not start a second chain either");
        Expect(registry.Live().Count == 2, "both distinct screens survive; the duplicate was folded");
    }

    // Liveness is the freed check, and emptying the registry is what tells the tick to stop. Without this the
    // controller would keep ticking for the rest of the process after the player left the lobby — which is
    // the regression the whole change exists to prevent.
    private static void AFreedScreenIsPrunedAndParksTheTick()
    {
        var alive = new HashSet<ulong> { 11, 22 };
        var registry = new LobbyScreenRegistry(id => alive.Contains(id));
        registry.Add(11);
        registry.Add(22);

        alive.Remove(22);
        Expect(registry.Live() is [11], "a freed screen is dropped and the survivor is kept");
        Expect(registry.IsOccupied, "one live screen still keeps the tick running");

        alive.Clear();
        Expect(registry.Live().Count == 0, "with every screen freed the registry empties");
        Expect(!registry.IsOccupied, "…and the controller parks the tick until the next _Ready");

        // Re-arming after parking is the "back out to the menu and come back" path.
        alive.Add(33);
        Expect(registry.Add(33), "a screen mounted after parking reports the transition that restarts the tick");
    }

    // NOT "is it in the tree". Godot runs _Ready once per node, so a screen that is hidden behind a submenu or
    // detached and re-attached would never announce itself again — dropping it on tree-exit would cost the
    // lobby its panels permanently. The controller re-reads VISIBILITY every tick instead.
    private static void AHiddenOrDetachedScreenKeepsItsEntry()
    {
        var registry = new LobbyScreenRegistry(_ => true); // alive, whatever the tree says
        registry.Add(11);
        Expect(registry.Live() is [11], "a screen that is merely hidden or detached keeps its registration");
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
    private static async Task DeferredHostUiKeepsTheListenerButNotTheNetworkAsync(string rootPath)
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
