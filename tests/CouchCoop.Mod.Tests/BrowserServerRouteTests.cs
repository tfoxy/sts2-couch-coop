using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod;
using CouchCoop.Mod.Activity;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Loader;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Envelopes;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.Perspective;
using Spirectl.Sts2.Core.Protocol;
using Spirectl.Sts2.Core.Reference;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

// WS8: `dotnet run --project tests/CouchCoop.Mod.Tests -- mdns-harness [seconds] [name]` runs ONLY the mDNS
// responder, so it can be probed with a real resolver (`dig @224.0.0.251 -p 5353 <name> A`) alongside a live
// avahi. It is a manual verification path — the suite below never opens port 5353. See MdnsResponderHarness.
if (args is [MdnsResponderHarness.Verb, ..])
{
    await MdnsResponderHarness.RunAsync(args);
    return;
}

// S9 offline report: `dotnet run --project tests/CouchCoop.Mod.Tests -- wire-report <recording.ndjson>` replays a
// recorded mirror stream through the live wire recorder's aggregator and prints the shared perf-report/1
// envelope. Like the mDNS harness this is a measurement path, not a suite — it runs alone and exits.
if (args is [WireReportHarness.Verb, ..])
{
    Environment.Exit(await WireReportHarness.RunAsync(args));
}

// WS6 live check: `dotnet run --project tests/CouchCoop.Mod.Tests -- secure-origin-harness` proves the
// published-private-key provider is STILL alive — real fetch, real listener, real system-trust-store
// handshake. Needs internet, so it is a manual/pre-release path rather than a suite. See the file header.
if (args is [SecureOriginHarness.Verb, ..])
{
    Environment.Exit(await SecureOriginHarness.RunAsync(args));
}

// Join-failure live check: `dotnet run --project tests/CouchCoop.Mod.Tests -- join-fault-harness <staticRoot>
// [port]` serves the REAL browser server with a HeadlessClientManager whose launcher throws, so a real browser
// pointed at it takes the `joinRejection: "join-failed"` path end to end and renders the picker's failure copy.
// A manual path like the harnesses above: it holds a port and never exits on its own. Same spirit as the
// harness's `--assets-stall` — inject the fault at the seam where the real one lived, rather than mocking the UI.
if (args is [BrowserServerRouteTests.JoinFaultVerb, ..])
{
    Environment.Exit(await BrowserServerRouteTests.ServeJoinFaultAsync(args));
}

// WS6 follow-up live check: `-- secure-seat-harness` proves, across two REAL processes, that a seat-shaped
// child (headless flag, isolated data home) brings up its own secure listener from the HOST's handed-down
// certificate cache, and that the host can resolve its port. See the file header.
if (args is [SecureSeatHarness.Verb, ..])
{
    Environment.Exit(await SecureSeatHarness.RunAsync(args));
}

if (args is [ManagedCacheProcessTests.ChildVerb, ..])
{
    Environment.Exit(await ManagedCacheProcessTests.RunChildAsync(args));
}

// `dotnet run --project tests/CouchCoop.Mod.Tests -- host-guards` runs the WS-1 hosting guards ALONE: the patch
// TARGET resolution, the composite host's peer routing, and the Harmony ordering + client-cap rules that decide
// how many players can actually connect. They are pure — no IO, no Harmony install, no live game, no port — which
// makes them the one slice of this suite that is safe to run on its own, and the way to verify a hosting change
// when something else in the full run is unhappy. They also run in the normal sequence below.
if (args is ["host-guards", ..])
{
    NetTransportPatchTargetsTests.Run();
    HostPeerRoutingTests.Run();
    HostTransportCapacityTests.Run();
    Console.WriteLine("host guards: ok");
    return;
}

// `dotnet run --project tests/CouchCoop.Mod.Tests -- seats` runs the seat allocator ALONE: slot/netId
// allocation and reuse, the lobby-cap-driven slot range (which is what decides whether a fifth-to-eighth player
// gets a seat at all), the reap/detach bookkeeping, the seat launch contract, and the lock-ordering pins that
// keep the cap probe off the manager's lock. Pure in the same sense as host-guards — a fake launcher and an
// instant readiness probe stand in for a real game process and a real HTTP poll — and registered here because
// the full sequence does not reach it on some machines (see the note above HeadlessAudioMuteTargetsTests), which
// makes this the only way to verify a change to the seat cap.
if (args is ["seats", ..])
{
    await HeadlessClientManagerTests.RunAsync();
    // The suite narrates every seat it starts, so say plainly that it finished — an exit code is easy to lose
    // in that scroll, which is the same reason host-guards prints its own line.
    Console.WriteLine("seats: ok");
    return;
}

// `dotnet run --project tests/CouchCoop.Mod.Tests -- host-ui` runs the pure host-UI decisions ALONE. Same
// rationale as `host-guards` above — no IO, no Harmony, no Godot engine, no live game — and the same
// arrangement: they also run in the normal sequence below. This is the reachable way to verify a host-UI
// change, because a full run of this Exe currently dies partway through (see the note above
// HeadlessAudioMuteTargetsTests) and never reaches most of the sequence.
if (args is ["host-ui", ..])
{
    CouchCoopButtonActivationTests.Run();
    Console.WriteLine("host ui: ok");
    return;
}

// `dotnet run --project tests/CouchCoop.Mod.Tests -- localization` runs the catalog suite ALONE, and it is
// registered here rather than only in the normal sequence for a concrete reason: the sequence below does not
// reach it on some machines, and while it was unreachable nine catalogs shipped with TRANSLATED placeholder
// tokens ({nombre}, {名前}) that never resolve. Two changes in the same round then added a key each with no
// gate at all. Catalog parity is cheap to check and expensive to get wrong in a language nobody here reads.
if (args is ["localization", ..])
{
    CouchCoopLocalizationTests.Run();
    Console.WriteLine("localization: ok");
    return;
}

// `dotnet run --project tests/CouchCoop.Mod.Tests -- seat-timeout` runs the seat READINESS deadline alone: the
// clamp band behind COUCHCOOP_SEAT_READY_TIMEOUT_SECONDS, its relationship to the browser's own join ceiling,
// the one "still loading" progress line, and the early-exit path that must keep failing fast regardless. Same
// standing as host-guards above — pure, no IO, no game executable, nothing to race — and it also runs in the
// normal sequence below. Its two waiting cases take ~2s each against deliberately shortened deadlines.
if (args is ["seat-timeout", ..])
{
    await SeatReadyTimeoutTests.RunAsync();
    return;
}

// `dotnet run --project tests/CouchCoop.Mod.Tests -- beta-targets` runs ONLY the Harmony patch-TARGET guards:
// every game member this mod patches or reflects over, resolved against the STS2 assemblies this build was
// compiled with. That is the whole per-GAME-BUILD question, which makes it the one-liner to run after a game
// update or when adding an API lane — point Sts2AssembliesDir at the new build, build, run this. The legs are
// pure metadata reflection (no Harmony install, no live game, no IO), so like host-guards above they are safe
// alone, and unlike the full sequence they are reachable: it dies partway through on some machines (see the
// note above HeadlessAudioMuteTargetsTests) and never reaches most of what is registered after it.
//
// Every leg is run even when an earlier one fails, and each is named on its own line: a game update typically
// breaks several members at once, and stopping at the first would hide the rest behind another build+run cycle.
if (args is ["beta-targets", ..])
{
    var failures = new List<string>();
    void Leg(string name, Action body)
    {
        try
        {
            body();
            Console.WriteLine($"  {name}: ok");
        }
        catch (Exception exception)
        {
            failures.Add(name);
            Console.WriteLine($"  {name}: FAILED -- {exception.Message}");
        }
    }

    // WS-1 networking/hosting seams, the headless FMOD forwards, the clean-exit popup suppression, and the two
    // lobby-screen mount points — in the same order the full sequence takes them.
    Leg(nameof(NetTransportPatchTargetsTests), NetTransportPatchTargetsTests.Run);
    Leg(nameof(HeadlessAudioMuteTargetsTests), HeadlessAudioMuteTargetsTests.Run);
    Leg(nameof(HeadlessDisconnectExitTests), () => HeadlessDisconnectExitTests.RunAsync().GetAwaiter().GetResult());
    Leg("IdleHostCostTests.MountTargets", IdleHostCostTests.MountTargetsResolve);

    Console.WriteLine(failures.Count == 0
        ? "beta-targets: every patch target resolves"
        : $"beta-targets: {failures.Count} leg(s) FAILED: {string.Join(", ", failures)}");
    Environment.Exit(failures.Count == 0 ? 0 : 1);
}

// Point the asset binary cache at a throwaway temp root BEFORE any browser-server / host-UI test constructs a
// SpirectlAssetBinaryCache. Without this, the cache's DefaultRoot() falls through to TryResolveGameDataDir() ->
// Godot.ProjectSettings.GlobalizePath("user://..."), whose static cctor calls native GodotSharp
// (godotsharp_string_name_new_from_string). GodotSharp is LINKED here (via the spirectl bridge) but NO Godot
// engine is running, so that native call segfaults — an uncatchable SIGSEGV the DefaultRoot() try/catch can't
// intercept (it only guards a MANAGED assembly-load failure). Setting COUCHCOOP_CACHE_ROOT makes DefaultRoot()
// return early, so the whole Exe suite runs to completion instead of dying in AssertHostUiServicesAsync.
Environment.SetEnvironmentVariable(
    "COUCHCOOP_CACHE_ROOT",
    Path.Combine(Path.GetTempPath(), "couchcoop-mod-tests-" + Guid.NewGuid().ToString("N")));

HotReloadInteropTests.Run();
SpirectlEmbeddedAssemblyBoundaryTests.Run();
// Steam Deck: the shared gate that decides whether a gui_input event activates a CouchCoop button, which now
// answers to the controller's select action as well as to the mouse. Placed up here deliberately — it is pure
// C# with no Godot types at all, and everything from HeadlessAudioMuteTargetsTests below is currently
// unreachable on some machines (see the next comment). Also reachable alone as `-- host-ui`.
CouchCoopButtonActivationTests.Run();

// Pure suites (no IO) run first so they execute regardless of the network-suite flakiness.
// CAUTION: "pure" here means no IO, not no Godot — this next suite reflects over game types through
// GodotSharp, and on some machines that SIGSEGVs the whole process (exit 139) with no engine running. When it
// does, every suite registered after it silently never runs. Verify a change through one of the verbs above
// rather than reading a truncated full run as green.
HeadlessAudioMuteTargetsTests.Run();
// WS-1 networking/hosting: every game member the host-transport / CLI-override / host-netId / save-compat patches
// bind to must still resolve, including the two private NetHostGameService seams the composite host rewrites.
NetTransportPatchTargetsTests.Run();
// WS-1: the env-gated CommandLineHelper override table — EMPTY on a host (so it hosts normally, Steam included),
// fastmp=join + clientId on a headless couch seat launched with no CLI args at all.
CommandLineOverrideTests.Run();
// WS-1: the composite Steam+ENet host — its shape (a missed override silently makes a message type Steam-only)
// and its peer routing (unknown ids must reach ENet, never Steam, which throws on an unknown peer).
DualNetHostShapeTests.Run();
SavedRunEnetHostShapeTests.Run();
SavedRunLoadLobbyIdentityTests.Run();
HostPeerRoutingTests.Run();
// WS-1 host capacity: our StartSteamHost prefix REPLACES the method, so it has to be the last prefix or it cuts
// a multiplayer limit mod's cap raise out of the host start — pinned against Harmony's own patch comparer, since
// the StartSteamHost path needs a real Steam session and is not reachable from automated QA.
HostTransportCapacityTests.Run();
// WS-1: couchcoop.json must keep affects_gameplay=false or JoinFlow's mod-list comparison locks out every
// vanilla Steam friend — silently, since nothing else in the build would fail.
ModManifestGameplayRelevanceTests.Run();
// WS-3 energy orb: the decorative freeze must use the tween-safe mechanism per node type (see the file header).
HeadlessDecorativeFreezeTests.Run();
// WS-D phantom potion: the particle freeze must exempt the self-freeing potion-flash VFX (see the file header).
HeadlessParticleFreezeExemptionTests.Run();
// WS-3 idle wire: the spine freeze re-asserts on every scan — its dedup set is a reporting set, never the gate
// (a node whose ProcessMode came back used to be skipped forever; see the file header).
HeadlessSpineFreezeTests.Run();
// Geoclip round: all three freeze walks skip an OFF-SCREEN EXTRACTION subtree (they DFS from SceneTree.Root, so
// they otherwise freeze the detached rig a bake is posing and it returns one pose repeated) — and skip nothing
// else, so a non-marked SubViewport's spine children stay frozen.
HeadlessExtractionExemptionTests.Run();
// WS-1 leaking VFX: the five self-free-on-`finished` VFX stay frozen and get a synthesized END-OF-BURST at their
// burst's natural end — the `finished` they await AND the `Emitting` clear that stops the mirror drawing an ended
// burst — plus a cap on the ceremonial beast's unbounded death await (see the file header).
HeadlessParticleFinishNudgeTests.Run();
// WS-8: headless clean-exit on a permanent host disconnect — Harmony target resolution (incl. the NErrorPopup.Create
// overload discrimination) + the exit sequence's arm-backstop-first / one-shot contract.
await HeadlessDisconnectExitTests.RunAsync();
InputMappingTests.Run();
SceneDeltaCoalescerTests.Run();
CouchCoopSceneObserverTests.Run();
BrowserSceneDeltaMessageTests.Run();
// S9/S10 perf instruments: the scene-delta wire recorder (exact bytes, inert when disarmed, order-byte
// attribution) and the /bg render-time recorder, plus the shared perf-report/1 envelope both emit.
SceneDeltaWireMetricsTests.Run();
StaticBackgroundRenderMetricsTests.Run();
// The /spines bake instrument + the phase-table mapping both host renders share (blocking vs parked, and
// "not measured" never rendering as "measured zero").
SpineBakeMetricsTests.Run();
// …and the GEOCLIP half of the same instrument: the producer's `bake.profile` lifted out of the manifest it
// writes (the only copy that crosses the seam), the geoclip's own metric block so it never averages into the
// raster rows it is meant to be compared against, the extraction-gate wait that used to be measured nowhere in
// this lane, and the refusal header that says what a geoclip 404 meant.
GeoclipBakeMetricsTests.Run();
SceneOrderDiffTests.Run();
InputCoalescerTests.Run();
await NetworkHardeningTests.RunAsync();
HeadlessUserDirSeederTests.Run();
// M3 WS-T host-discovery responder (real UDP loopback round-trip). Runs before the flaky network suite below.
await HostDiscoveryResponderTests.RunAsync();
AssetCacheTokenEnvelopeTests.Run();
// WS-2 host-performance truth: the `session` envelope reports the freezes THIS instance actually applies (all off
// on a windowed host, which never installs the suspender), so the mirror panel's checkboxes stop lying.
HostPerformanceEnvelopeTests.Run();
// R13 host hint counters: the `session` envelope carries the embedded producer's per-family emit/decline tallies, so
// a passive `/ws?watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0` read answers "did the host emit hints, and if not which gate ate them".
// FIX 2b: a single-frame &still=1 clip parses (client decoder) to a paintable frame with non-degenerate Local* placement.
SpineStillClipTests.Run();
// WS-7 (#14): the spine bake admission policy — instance count, degrade threshold, degraded-still key derivation.
SpineBakeBudgetTests.Run();
// Track T: tiny-PNG transcode threshold (pure filesystem, no IO beyond a temp dir).
AstcTranscodeCacheTests.Run();
await ManagedCacheQuotaTests.RunAsync();
await ManagedCacheProcessTests.RunAsync();
// Spine geoclip (dev): the /geoclips/ artifact route — its filesystem policy, its two addressing forms, its two
// ORDERED roots (operator override first, managed store second), and the load-bearing DISARMED case
// (no COUCHCOOP_GEOCLIPS_DIR, no store ⇒ 404, nothing created, nothing else on the host changed).
await GeoclipRouteTests.RunAsync();
// …and the managed store behind that second root: layout, the .complete gate, atlas pages shared across poses by
// content hash, the key's opaque `gv` policy version, single-flight, and the unarmed no-bake/no-touch path.
await GeoclipStoreTests.RunAsync();
// …and the --prerender-spine-deltas sweep that fills that store, plus the spirectl bake seam it goes through:
// the trigger's defensive argv union, REFUSED counted apart from FAILED, restart-from-disk after a mid-sweep
// death, the summary's shape, and the per-rig delta-vs-raster table.
await GeoclipPrerenderTests.RunAsync();
// …and the ENCOUNTER-SCOPED twin of that sweep, which bakes only the creatures the loading encounter puts on
// screen: that it is OFF unless COUCHCOOP_PRERENDER_ENCOUNTER_GEOCLIPS=1 (proved through the whole controller,
// not just the env reader), that the roster is the client's own (scene, node, currentAnim) rule, that a
// concurrent browser request for a swept key coalesces onto the sweep's bake instead of starting a second
// main-thread render, and that a refusal is remembered rather than re-decided on every room.
await EncounterGeoclipPrerenderTests.RunAsync();
// Memory round: a headless seat serves assets from disk or errors, and NEVER extracts — the belt that stops an
// evicted (1x1) texture from being written through into the asset cache the host shares.
HeadlessAssetExtractionGuardTests.Run();
// WS-3 rejoin: per-seat status derivation (grace window + zombie reap) and the mp-load-game saved-run union.
MirrorSeatRosterTests.Run();
// Player names on a seat: what the host publishes (itself + remote Steam players, which a seat cannot resolve),
// how that merges into the durable mp_names.json roster, and how a running seat picks up later joiners.
PlayerNameRosterTests.Run();
// WS-F: advertised LAN IPv4 ranking (Tailscale/docker/APIPA demotion) + the COUCHCOOP_ADVERTISED_HOST override.
LanAddressRankingTests.Run();
// WS-2 QR dialog: the option list the dialog offers (adapter x method cross product, tier-first grouping,
// mdns always last, per-adapter link rows, disabled-with-blocker availability, selection restore, .local
// derivation, payload parity).
QrHostOptionsTests.Run();
// WS6 secure origin: the pure half — dashed-host derivation, the https scheme, the per-adapter secure ROW
// (enabled or disabled-with-reason), and the persisted selection preference incl. its checkbox-era reads.
SecureOriginTests.Run();
// The "web link" option: the public-origin client that reaches this PC by literal IPv4 under the browser's
// Local Network Access permission. The pure half — origin parsing, the per-adapter web row, that the QR
// encodes the PUBLIC origin with the adapter's address in ?h= (and that ?h= survives the payload
// normaliser that strips every other query key), and the WebSocket Origin allow-list that is the real
// access control now that HTTP answers a wildcard CORS grant.
WebOriginTests.Run();
// The hover-tip copy the redesigned dialog shows per option: register (no engine jargon), rich-text safety
// (no '[' — the description lands in a BBCode label), length bounds, and the key-prefix contract for the
// titles merged into the game's loc table.
QrHoverTipCopyTests.Run();
// Native catalogs, locale fallback, structured retained activity and BBCode-safe late resolution.
CouchCoopLocalizationTests.Run();
// WS6 secure origin: the TLS listener over a real loopback handshake with a self-signed certificate —
// port-walk, no-certificate refusal, bad-handshake isolation, and the PEM->server-certificate step.
SecureBrowserListenerTests.RunAsync();
// WS6 follow-up: a JOINED seat over the secure origin. The host cannot derive a headless instance's TLS
// port (separate process, own port-walk), so the instance publishes it on /secure-port and the host reads
// it — driven here over real loopback sockets — plus the give-up deadline that lets a join fail closed and
// the certificate-cache hand-down that keeps every seat off the WAN.
SecureHeadlessRedirectTests.RunAsync();
// WS8 mDNS responder: the pure DNS wire codec behind the `.local` name the QR dialog defaults to (query parse
// incl. compression pointers, case-insensitive match, multicast/legacy/QU response bytes, TTL-0 goodbye) plus
// the kill-switch. Opens no socket — live multicast behaviour is verified against avahi by hand.
MdnsResponderTests.Run();
// WS-2 QR dialog: when the "Couch Co-Op QR Code" button exists (and, just as importantly, when it does not).
CouchCoopLobbyHostGateTests.Run();
// F1 host connectivity log: the ring, the player-facing copy (asserted literally — it is a QA contract
// shared with the live probe) and the bbcode escaping that keeps a browser-typed display name from
// re-styling the host's television. Runs FIRST of the log-touching suites and resets the process-global
// ring on its way out, since the manager/server suites below append to the same one.
CouchCoopActivityLogTests.Run();
// F2: the wire's screen.mirrorMode kind for each host screen — the ONE decision behind "does this phone get a
// join form, or does it just mirror?". Shares CouchCoopLobbyHostGateTests' snapshot builders, so it runs beside
// it: the QR gate and the mirror kind are two readings of the same lobby shape.
BrowserAssignmentClassifierTests.Run();
// WS-2 QR dialog: the four-way overlay layout contract (runtime default, hot-reload logic, shell copy,
// validator) plus the constant-extent invariant. Runs BEFORE any hot-reload test so the shell still
// reports its compiled-in default.
CouchCoopQrLayoutContractTests.Run();
// The QR renders at the SAME on-screen size for both real join URLs (37- and 41-module codes), with every
// module an identical whole number of source pixels and the difference absorbed as white quiet zone.
QrRasterTests.Run();
// The Steam-offline modal's pure once-per-mount predicate, including the unmount re-arm and the fact that
// the latch is a value with no storage behind it.
HostTransportAlertTests.Run();
// Stage-A static background: the /bg/ image producer (grammar, single-flight, fallback chain, headless guard)
// and the tracker's publish/change contract. The route + envelope halves ride BrowserServerRouteTests below.
await StaticBackgroundProviderTests.RunAsync();
// …and the EVENT family (/bg/events/<id>): grammar, the single literal-scene rung on the shared belt, the
// digest-less contract, and the tracker's event-backdrop BFS locate.
await StaticBackgroundEventsTests.RunAsync();
// …and the tracker's MOUNTED-LAYER probe, which decides WHICH variant the render depicts (the placeholder
// containers hide the instanced variant one level down — see the file header).
StaticBackgroundLayerProbeTests.Run();
// Stage-B walk skip: the pure unanimity decision, the `?staticBg=` polarity, the settings-envelope wire twins,
// the tracker's Godot-less desired-skip latch and the retained-map re-admission shape. The live socket half
// (accept parse, live flips, disconnects, valve) rides BrowserServerRouteTests below.
WalkSkipUnanimityTests.Run();
var tests = new BrowserServerRouteTests();
await tests.RunAsync();
await HeadlessClientManagerTests.RunAsync();
// The readiness deadline that manager waits on: the clamp band, the progress line, the untouched early exit.
await SeatReadyTimeoutTests.RunAsync();
Console.WriteLine("""{"ok":true,"hostedServerRoutes":true}""");

internal sealed class BrowserServerRouteTests
{
    internal const string JoinFaultVerb = "join-fault-harness";

    /// <summary>
    /// Serve the real browser server with a launcher that THROWS, so a real browser can be driven through the
    /// join-failure path against real server code. The automated twin is
    /// <c>AssertJoinFaultReachesTheViewerAsync</c>, which asserts the wire; this exists to put actual pixels
    /// behind the claim that the picker renders the failure.
    /// </summary>
    internal static async Task<int> ServeJoinFaultAsync(string[] args)
    {
        var staticRoot = args.Length > 1 ? args[1] : throw new ArgumentException("usage: join-fault-harness <staticRoot> [port]");
        var port = args.Length > 2 ? int.Parse(args[2]) : 13400;
        // This runs ALONE in a fresh process, unlike the suite, so a first-touch static initializer failure on a
        // connection thread would otherwise take the process down with nothing printed at all.
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Console.Error.WriteLine($"[join-fault-harness] UNHANDLED: {e.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, e) =>
            Console.Error.WriteLine($"[join-fault-harness] UNOBSERVED: {e.Exception}");

        // Arm the visual suspender's CAPTURED-BASELINE fast path, exactly as HostPerformanceEnvelopeTests does.
        // Without it every `session` build hops to the Godot main thread for the real MaxFps, which in a runner
        // with no native Godot is a SIGSEGV — the process dies on the first WebSocket with nothing printed. The
        // suite only survives because HostPerformanceEnvelopeTests runs first and leaves these set.
        var suspender = typeof(CouchCoopHeadlessVisualSuspender);
        const System.Reflection.BindingFlags Statics =
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
        suspender.GetField("_baselineMaxFps", Statics)!.SetValue(null, 60);
        suspender.GetField("_baselineCaptured", Statics)!.SetValue(null, true);
        const string faultText = "The given key 'MALLOC_ARENA_MAX' was not present in the dictionary.";

        // "host" is what makes DescribeMirrorJoinContext report SpawnAllowed — without it the join is refused
        // earlier (not-a-session-player) and never reaches the launcher we want to blow up.
        var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.Lobby, LobbyNetGameType = "host" };
        using var manager = new HeadlessClientManager(launcher: _ => throw new KeyNotFoundException(faultText));
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(staticRoot),
            new CapturingAssetAdapter(),
            new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime))),
            preferredPort: port,
            headlessManager: manager,
            isHeadlessClient: false);

        var baseUri = await server.StartAsync();
        Console.WriteLine($"join-fault-harness listening on {baseUri} (every join throws: {faultText})");
        Console.Out.Flush();
        await Task.Delay(Timeout.InfiniteTimeSpan);
        return 0;
    }

    private const string LobbyScreenId = "Screens.CharacterSelect.NCharacterSelectScreen";
    private const string HoverTipSceneId = "ui/hover_tip";

    public async Task RunAsync()
    {
        await SeatDirectoryIsLiveOnTheConnectionPathWithoutStartAsync();
        await AssertStaticFileContainmentAsync();

        using var root = new TempStaticRoot();
        using var cacheRoot = new TempResourceCacheRoot();
        var assets = new CapturingAssetAdapter();
        var runtime = new RecordingSpirectlRuntime();
        var envelopeFactory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));
        await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path), assets, envelopeFactory, resourceCacheRoot: cacheRoot.Path);
        var baseUri = await server.StartAsync();
        Expect(baseUri.Host == "127.0.0.1", "server binds to loopback");
        Expect(baseUri.Port >= 13337, "server uses default port range");

        var rootResponse = await GetAsync(baseUri, "/");
        Expect(rootResponse.StatusLine.Contains("200 OK", StringComparison.Ordinal), "root serves index");
        Expect(rootResponse.Body.Contains("spa-index", StringComparison.Ordinal), "root body is index");

        var fallback = await GetAsync(baseUri, "/players/alice");
        Expect(fallback.StatusLine.Contains("200 OK", StringComparison.Ordinal), "SPA route falls back");
        Expect(fallback.Body.Contains("spa-index", StringComparison.Ordinal), "SPA fallback body is index");

        // The home-screen PWA manifest is a real static file (frontend/public/manifest.webmanifest) that must
        // be served with the manifest content type so iOS/Android honor it as a web app manifest.
        var manifest = await GetAsync(baseUri, "/manifest.webmanifest");
        Expect(manifest.StatusLine.Contains("200 OK", StringComparison.Ordinal), "manifest route serves the static file (not the SPA fallback)");
        Expect(manifest.Headers.TryGetValue("Content-Type", out var manifestContentType) && manifestContentType == "application/manifest+json; charset=utf-8", "webmanifest content type is application/manifest+json");
        Expect(manifest.Body.Contains("couchcoop-manifest", StringComparison.Ordinal), "manifest route serves the manifest body, not index");

        // `/app-boot.json` is a route, served from the extensionless on-disk `app-boot` file and re-emitted
        // field by field with the origin verdict. A `*.json` on disk would trip STS2's mod-manifest scan.
        var bootManifest = await GetAsync(baseUri, "/app-boot.json");
        Expect(bootManifest.StatusLine.Contains("200 OK", StringComparison.Ordinal), "boot manifest route serves the extensionless app-boot file");
        Expect(bootManifest.Headers.TryGetValue("Content-Type", out var bootContentType) && bootContentType == "application/json; charset=utf-8", "boot manifest is served as application/json");
        Expect(bootManifest.Body.Contains("/app/index-testhash1.js", StringComparison.Ordinal), "boot manifest body carries the on-disk entry field");
        Expect(bootManifest.Body.Contains("originAllowed", StringComparison.Ordinal), "boot manifest route adds the origin verdict");

        var reservedWs = await GetAsync(baseUri, "/ws");
        Expect(reservedWs.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "/ws is reserved from SPA fallback");
        Expect(reservedWs.Body.Contains("invalid-websocket-upgrade", StringComparison.Ordinal), "/ws requires upgrade");
        await AssertWebSocketContractAsync(baseUri);

        var missingNestedAsset = await GetAsync(baseUri, "/assets/card:strike_r:image");
        Expect(missingNestedAsset.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "a missing nested asset-like path is a static 404");
        Expect(!missingNestedAsset.Body.Contains("spa-index", StringComparison.Ordinal), "a missing nested asset-like path never receives the SPA shell");

        var missingImage = await GetAsync(baseUri, "/missing-image.png");
        Expect(missingImage.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "a missing asset-shaped path is a static 404");
        Expect(!missingImage.Body.Contains("spa-index", StringComparison.Ordinal), "a missing asset-shaped path never receives the SPA shell");

        var favicon = await GetAsync(baseUri, "/favicon.ico");
        Expect(favicon.StatusLine.Contains("200 OK", StringComparison.Ordinal), "favicon route succeeds");
        Expect(favicon.Headers.TryGetValue("Content-Type", out var faviconContentType) && faviconContentType == "image/x-icon", "favicon content type is forwarded");
        Expect(favicon.Headers.TryGetValue("Cache-Control", out var faviconCache) && faviconCache == "public, max-age=31536000, immutable", "favicon immutable cache header is set");
        Expect(assets.LastKey == "res://images/icon.ico", "favicon route forwards the game icon resource");

        // The home-screen icons are RENDERED from the game's 1024px app icon rather than served from the
        // shipped placeholders, so an installed PWA shows the game's art. Each route asks the seam for the
        // same source key at its own square size — that resize is the whole reason the asset seam grew a
        // render-size argument, so assert the size actually travels rather than just that bytes came back.
        var icon192 = await GetAsync(baseUri, "/icons/icon-192.png");
        Expect(icon192.StatusLine.Contains("200 OK", StringComparison.Ordinal), "icon route succeeds");
        Expect(assets.LastKey == CouchCoopAppIcons.SourceResourcePath, "icon route renders the game's own app icon");
        Expect(assets.LastFormat == CouchCoopResourceFormat.Png, "icon route asks for a raster");
        Expect(assets.LastRenderSize == new CouchCoopAssetRenderSize(192, 192), "icon route asks for the route's own size");
        Expect(icon192.Headers.TryGetValue("X-Icon-Source", out var icon192Source) && icon192Source == "game", "icon route reports which branch answered");
        Expect(icon192.Headers.TryGetValue("Cache-Control", out var icon192Cache) && icon192Cache == "public, max-age=31536000, immutable", "icon route is immutable-cached");

        // /icons/ is cache-FIRST in the service worker, so an icon that changed with the game or the mod would
        // otherwise pin itself in every installed PWA forever. The ETag carries the asset-cache schema version
        // for exactly that reason; prove it round-trips to a 304 so the revalidation path is real.
        Expect(icon192.Headers.TryGetValue("ETag", out var icon192ETag) && icon192ETag.Contains(SpirectlAssetBinaryCache.SchemaVersion, StringComparison.Ordinal), "icon ETag carries the asset-cache schema version");
        var icon192Revalidated = await GetAsync(baseUri, "/icons/icon-192.png", ("If-None-Match", icon192ETag!));
        Expect(icon192Revalidated.StatusLine.Contains("304", StringComparison.Ordinal), "an unchanged icon revalidates to 304");

        var icon512 = await GetAsync(baseUri, "/icons/icon-512.png");
        Expect(icon512.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the 512 icon route succeeds");
        Expect(assets.LastRenderSize == new CouchCoopAssetRenderSize(512, 512), "each icon route asks for its own size");

        // The SPA fallback must not shadow an icon: without the reservation a miss would answer index.html
        // with a 200, and the browser would cache HTML as the app icon.
        var iconUnknown = await GetAsync(baseUri, "/icons/icon-999.png");
        Expect(!iconUnknown.Body.Contains("spa-index", StringComparison.Ordinal), "an unlisted icon path does not fall through to the SPA index");

        // The asset routes carry the resource path readably and mint the scheme themselves; anything
        // that embeds its own scheme (http://…, the legacy escaped res:// form, model:// keys) is
        // rejected before reaching the seam.
        var invalidResource = await GetAsync(baseUri, "/res/http%3A%2F%2Fevil%2Fsteal");
        Expect(invalidResource.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "/res rejects keys that embed their own scheme");
        Expect(invalidResource.Body.Contains("invalid-resource-route", StringComparison.Ordinal), "/res rejection is structured");

        var legacyEscapedResource = await GetAsync(baseUri, "/res/res%3A%2F%2Fimages%2Fopaque.png");
        Expect(legacyEscapedResource.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "/res rejects the legacy escaped scheme-prefixed form");
        Expect(legacyEscapedResource.Body.Contains("invalid-resource-route", StringComparison.Ordinal), "legacy escaped form rejection is structured");

        var legacyModelResource = await GetAsync(baseUri, "/res/model%3A%2F%2Fcharacters%2Fironclad%2Ficon");
        Expect(legacyModelResource.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "/res no longer serves model:// keys (use /models/{path})");

        var seamKeyBeforeInvalidPaths = assets.LastKey;
        foreach (var invalidPath in new[]
                 {
                     "/res/%2e%2e/outside.json",
                     "/res/images/%2e%2e/outside.json",
                     "/res/C%3A%2FWindows%2Fwin.ini",
                     "/res/images%5Coutside.json",
                     "/res/images/file%00.json",
                     "/res/shaders/subresource_fixture.tres%3A%3AShader_ok%3A%3Aextra",
                 })
        {
            var rejected = await GetAsync(baseUri, invalidPath);
            Expect(rejected.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), $"unsafe resource path is rejected: {invalidPath}");
            Expect(assets.LastKey == seamKeyBeforeInvalidPaths, $"unsafe resource path never reaches extraction: {invalidPath}");
        }

        var missingResource = await GetAsync(baseUri, "/res/missing");
        Expect(missingResource.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "missing resource returns 404");
        Expect(missingResource.Body.Contains("missing-asset", StringComparison.Ordinal), "missing resource is structured");
        Expect(missingResource.Body.Contains("field", StringComparison.Ordinal), "missing resource preserves structured fields");

        var resource = await GetAsync(baseUri, "/res/images/opaque.png");
        Expect(resource.StatusLine.Contains("200 OK", StringComparison.Ordinal), "resource route succeeds");
        Expect(resource.Headers.TryGetValue("Content-Type", out var contentType) && contentType == "image/png", "resource content type is forwarded");
        Expect(resource.Headers.TryGetValue("Cache-Control", out var cache) && cache == "public, max-age=31536000, immutable", "resource immutable cache header is set");
        Expect(assets.LastKey == "res://images/opaque.png", "res resource path is decoded and minted into a res:// key");
        // Godot-native-first: /res defaults to the raw resource format.
        Expect(assets.LastFormat == CouchCoopResourceFormat.Raw, "/res defaults to the raw resource format with no ?format flag");

        var jsonResource = await GetAsync(baseUri, "/res/images/opaque.png?format=json");
        Expect(jsonResource.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "retired ?format=json is rejected");
        Expect(jsonResource.Body.Contains("invalid-resource-format", StringComparison.Ordinal), "retired JSON format rejection is structured");

        var otherFormat = await GetAsync(baseUri, "/res/images/opaque.png?format=xml");
        Expect(otherFormat.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "an unknown ?format value is rejected");
        Expect(otherFormat.Body.Contains("invalid-resource-format", StringComparison.Ordinal), "unknown format rejection is structured");

        // WS-PARTICLE: `?format=png` is the explicit raster ask (an AtlasTexture `.tres` particle texture
        // rasterizes via spirectl's cropped-region PNG path instead of serving `[gd_resource]` text).
        var pngResource = await GetAsync(baseUri, "/res/images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres?format=png");
        Expect(pngResource.StatusLine.Contains("200 OK", StringComparison.Ordinal), "resource route succeeds with ?format=png");
        Expect(assets.LastFormat == CouchCoopResourceFormat.Png, "?format=png selects the raster resource variant");
        Expect(assets.LastKey == "res://images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres", "the ?format=png query is not folded into the res:// key");

        // Scenes are no longer intercepted by a host serializer — a .tscn path flows through the
        // /res route to the spirectl asset seam like any other res:// key (the seam returns
        // GodotSceneState JSON in the live game; the test stub returns its generic payload).
        var sceneResource = await GetAsync(baseUri, "/res/scenes/screens/character_select_screen.tscn");
        Expect(sceneResource.StatusLine.Contains("200 OK", StringComparison.Ordinal), "scene res path succeeds via the asset seam");
        Expect(assets.LastKey == "res://scenes/screens/character_select_screen.tscn", "scene res path is forwarded to the asset seam");

        // R6 P6-F2 — `::`-QUALIFIED SUB-RESOURCES. Godot addresses a resource embedded inside a text resource as
        // `<parent>::<sub id>`, and the mirror streams those qualified paths verbatim. Before this route they were
        // minted whole, named a file that does not exist, and 404'd — which the web client could only report as
        // "source unresolved". The parent is fetched through the ordinary path and the block is read out of it.
        var subResource = await GetAsync(baseUri, "/res/shaders/subresource_fixture.tres%3A%3AShader_aaaaa");
        Expect(subResource.StatusLine.Contains("200 OK", StringComparison.Ordinal), "a ::-qualified sub-resource is served");
        Expect(assets.LastKey == "res://shaders/subresource_fixture.tres", "the PARENT key is what reaches the seam — the sub id is not part of it");
        Expect(assets.LastFormat == CouchCoopResourceFormat.Raw, "a sub-resource is read out of the parent's raw text");
        Expect(subResource.Body.Contains("uniform float a", StringComparison.Ordinal), "the named block's own source comes back");
        Expect(!subResource.Body.Contains("uniform float b", StringComparison.Ordinal), "and only that block");
        Expect(subResource.Headers.TryGetValue("Content-Type", out var subType) && subType.StartsWith("text/plain", StringComparison.Ordinal), "shader source is served as text");
        Expect(subResource.Headers.TryGetValue("Cache-Control", out var subCache) && subCache == "public, max-age=31536000, immutable", "a sub-resource carries the same immutable cache policy as any other asset");

        // The block the parent's own `[resource]` section does NOT reference — the case that makes this a
        // different question from parsing the material, and the one every transition material actually is.
        var otherSub = await GetAsync(baseUri, "/res/shaders/subresource_fixture.tres%3A%3AShader_bbbbb");
        Expect(otherSub.StatusLine.Contains("200 OK", StringComparison.Ordinal), "an unreferenced sub-resource is served too");
        Expect(otherSub.Body.Contains("uniform float b", StringComparison.Ordinal), "…and it is the right one");

        // The parent exists and has no such block: a genuine miss, and a DIFFERENT fact from "no such resource".
        var missingSub = await GetAsync(baseUri, "/res/shaders/subresource_fixture.tres%3A%3AShader_zzzzz");
        Expect(missingSub.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "an unknown sub-resource id is a 404");
        Expect(missingSub.Body.Contains("missing-subresource", StringComparison.Ordinal), "…named separately from a missing asset");

        var emptySub = await GetAsync(baseUri, "/res/shaders/subresource_fixture.tres%3A%3A");
        Expect(emptySub.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a `::` with nothing after it is a bad request");

        // `?format` selects how the PARENT is rendered, a question with no meaning for the block inside it.
        var formattedSub = await GetAsync(baseUri, "/res/shaders/subresource_fixture.tres%3A%3AShader_aaaaa?format=json");
        Expect(formattedSub.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "?format on a sub-resource is refused, not ignored");

        // The scheme guard is the SAME guard, applied to the parent half: a `::` request cannot smuggle one in.
        var schemeSub = await GetAsync(baseUri, "/res/http%3A%2F%2Fevil%2Fsteal%3A%3AShader_aaaaa");
        Expect(schemeSub.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a ::-qualified request still rejects an embedded scheme");

        // And a MISSING parent keeps the ordinary asset error, rather than being reported as a missing block.
        var missingParentSub = await GetAsync(baseUri, "/res/missing.tres%3A%3AShader_aaaaa");
        Expect(missingParentSub.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "a missing parent is still a 404");
        Expect(missingParentSub.Body.Contains("missing-asset", StringComparison.Ordinal), "…and it is reported as a missing ASSET, not a missing sub-resource");

        await AssertModelAssetRoutesAsync(baseUri, assets);
        AssertSpineClipWire();
        await AssertSpineClipProviderAsync();
        await AssertSpinePrerenderAsync();
        await AssertSpineClipRoutesAsync(baseUri, runtime);
        await AssertAssetBinaryCacheAsync();
        // WS-PARTICLE raster format mapping. Runs HERE (before the animation-hint suite below, which has a known
        // pre-existing failure that aborts the process) so the raster contract is actually exercised.
        await AssertRasterResourceFormatAsync();

        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new UriBuilder(baseUri)
        {
            Scheme = "ws",
            Path = "/ws",
            Query = "watch=1&staticBg=1&cardFlight=1&handTween=1&trailDrive=1"
        }.Uri, CancellationToken.None);
        // On connect: a one-time anonymous `session` reply, and nothing else — the mirror carries no state
        // keyframe (the scene arrives as `scene-delta` frames).
        using (var connectSession = JsonDocument.Parse(await ReadWsMessageAsync(ws)))
        {
            AssertAnonymousConnectSession(connectSession.RootElement);
        }
        // Identity is established by an explicit join (no `?name=` on the URL).
        var joined = await SendJoinAsync(ws, "browser:req:join-alice", "  Alice  ");
        AssertJoinedRunSession(joined);
        await AssertActionExecutionProbesAsync(ws, runtime);
        await AssertSessionLifecycleProbesAsync(baseUri, ws, runtime);
        // Last connect-based assert: pushing a scene caches it, so a later DrainConnectAsync (fixed
        // session+state frames) would also receive a trailing `scene` frame. Keep this after the others.
        await AssertSceneBroadcastAsync(baseUri, runtime);
        // WS-B stream gate. Runs after the scene broadcast (it depends on the same pushed-delta plumbing) and
        // before the server-reload teardown.
        await AssertSceneStreamGateAsync(baseUri, runtime);
        await AssertStaticBgWalkSkipAggregateAsync(server, baseUri, runtime);
        await AssertInboundWebSocketLimitsAsync(baseUri, runtime);
        await AssertServerReloadClosesWebSocketAsync(server, baseUri);

        await server.StopAsync();

        await AssertInternalServerErrorsAreStructuredAsync(root.Path);
        await AssertAppIconFailsOpenAsync(root.Path);
        // WS-B prerequisite, on a DEDICATED server so no stateful connection can mask it.
        await AssertMirrorOnlyHostKeepsSessionsLiveAsync(root.Path);
        // Stage-A static background: the /bg/ route belt and the session envelope's descriptor, on DEDICATED
        // servers (the tracker's published slot is process-wide and the env valve is scoped per assert).
        await AssertStaticBackgroundRoutesAsync(root.Path);
        await AssertStaticBackgroundEnvelopeAsync();
        // S9/S10 perf report routes (same reason for a dedicated server: both recorders are process-wide).
        await AssertPerfReportRoutesAsync(root.Path);
        await AssertPortFallbackAsync(root.Path);
        await AssertHostUiServicesAsync(root.Path);
        // The idle-host contract: with nobody connected, the mod must cost a player nothing. The lobby-screen
        // registry that replaced the 4 Hz whole-tree walk, the mount patch's game seams, and the host-UI
        // deferral that keeps the LAN/WAN services off the network until a host lobby is on screen. Runs
        // beside AssertHostUiServicesAsync because it stands up a host UI of its own on a loopback port.
        await IdleHostCostTests.RunAsync(root.Path);
        await AssertHotReloadableServerHostSwapAsync(root.Path);
        // F1 host connectivity log, viewer channel. Dedicated server for the same reason as the neighbours
        // above: the log is a process-global ring, so this leg resets it and must not share one with a
        // connection another assert left open.
        await AssertActivityViewerNarrationAsync(root.Path);
        AssertQrGeneration();
        AssertAssignmentDtos();
        AssertJoinRejectionDetailPlumbing();
        await AssertJoinFaultReachesTheViewerAsync(root.Path);
        AssertRuntimeHostCallsCapabilitiesFirst();
        await AssertSpirectlAssetAdapterAsync();
        await HotReloadProtocolAssertions();
    }

    private static void AssertQrGeneration()
    {
        var qrCode = OfflineQrCode.EncodeJoinUrl(new Uri("http://127.0.0.1:13337/"));

        Expect(qrCode.Payload == "http://127.0.0.1:13337/", "QR payload is the hosted browser base URL");
        Expect(qrCode.Size > qrCode.QuietZone * 2, "QR matrix has encoded modules beyond the quiet zone");
        Expect(qrCode.Width == qrCode.Height, "QR matrix is square");
        Expect(Enumerable.Range(0, qrCode.Size).Any(y => Enumerable.Range(0, qrCode.Size).Any(x => qrCode.IsDark(x, y))), "QR matrix has dark modules");

        for (var i = 0; i < qrCode.Size; i++)
        {
            Expect(!qrCode.IsDark(i, 0), "QR top quiet zone is clear");
            Expect(!qrCode.IsDark(i, qrCode.Size - 1), "QR bottom quiet zone is clear");
            Expect(!qrCode.IsDark(0, i), "QR left quiet zone is clear");
            Expect(!qrCode.IsDark(qrCode.Size - 1, i), "QR right quiet zone is clear");
        }

        var normalized = OfflineQrCode.EncodeJoinUrl(new Uri("http://127.0.0.1:13337/?name=Alice#token"));
        Expect(normalized.Payload == "http://127.0.0.1:13337/", "QR payload omits browser identity query and fragments");

        var repeat = OfflineQrCode.EncodeJoinUrl(new Uri("http://127.0.0.1:13337/"));
        Expect(repeat.Size == qrCode.Size, "QR generation is deterministic in size");
        Expect(Enumerable.Range(0, qrCode.Size).All(y => Enumerable.Range(0, qrCode.Size).All(x => repeat.IsDark(x, y) == qrCode.IsDark(x, y))), "QR generation is deterministic in modules");

        AssertQuietZoneIsAlreadyEmbedded();
    }

    /// <summary>
    /// The shipped layout passes <c>quietZoneModules: 0</c>. That is only correct because QRCoder's
    /// own <c>ModuleMatrix</c> already carries the spec-mandated 4-module quiet zone, so this pins
    /// the assumption: with zero added modules the code must still have exactly four clear rings.
    /// </summary>
    private static void AssertQuietZoneIsAlreadyEmbedded()
    {
        var bare = OfflineQrCode.EncodeJoinUrl(new Uri("http://192.168.0.89:13337/"), quietZoneModules: 0);
        Expect(bare.QuietZone == 0, "the bare QR adds no quiet zone of its own");

        var clearRings = 0;
        while (clearRings < bare.Size / 2 && RingIsClear(bare, clearRings))
        {
            clearRings++;
        }

        Expect(clearRings == 4, $"QRCoder embeds the spec's 4-module quiet zone (measured {clearRings})");
        Expect(bare.Size == 37, $"the join URL encodes as a 37-module matrix (measured {bare.Size})");

        // Adding a quiet zone on top of the embedded one is what made the old overlay look padded:
        // the same payload occupies a strictly smaller share of the same on-screen extent.
        var padded = OfflineQrCode.EncodeJoinUrl(new Uri("http://192.168.0.89:13337/"), quietZoneModules: 4);
        Expect(padded.Size == bare.Size + 8, "a non-zero quiet zone double-pads the embedded one");

        static bool RingIsClear(OfflineQrCode code, int ring)
        {
            for (var i = ring; i < code.Size - ring; i++)
            {
                if (code.IsDark(i, ring) || code.IsDark(i, code.Size - 1 - ring)
                    || code.IsDark(ring, i) || code.IsDark(code.Size - 1 - ring, i))
                {
                    return false;
                }
            }

            return true;
        }
    }

    // The /models ASSET route (3+ segments): /models/{path} mints model://{path} and the seam resolves it
    // directly — including camelCase kinds and 4-segment layer keys. This is the route the mirror join picker's
    // seat character icons ride (joinModel.seatCharacterIconUrl).
    private static async Task AssertModelAssetRoutesAsync(Uri baseUri, CapturingAssetAdapter assets)
    {
        var icon = await GetAsync(baseUri, "/models/characters/ironclad/icon");
        Expect(icon.StatusLine.Contains("200 OK", StringComparison.Ordinal), "model icon route succeeds");
        Expect(icon.Headers.TryGetValue("Content-Type", out var iconContentType) && iconContentType == "image/png", "model icon content type is forwarded");
        Expect(assets.LastKey == "model://characters/ironclad/icon", "model asset path is minted into a model:// key for the seam");

        var layer = await GetAsync(baseUri, "/models/acts/act1/backgroundLayer/sky");
        Expect(layer.StatusLine.Contains("200 OK", StringComparison.Ordinal), "deep model asset path succeeds");
        Expect(assets.LastKey == "model://acts/act1/backgroundLayer/sky", "deep model asset path is forwarded whole to the seam");

        var legacyEscapedModel = await GetAsync(baseUri, "/models/model%3A%2F%2Fcharacters%2Fironclad%2Ficon");
        Expect(legacyEscapedModel.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "/models rejects scheme-prefixed keys");
        Expect(legacyEscapedModel.Body.Contains("invalid-model-route", StringComparison.Ordinal), "/models rejection is structured");

        var before = assets.LastKey;
        foreach (var path in new[] { "/models/%2e%2e/secret", "/models/C%3A%2FWindows%2Fwin.ini", "/models/a%5Cb/c" })
        {
            var rejected = await GetAsync(baseUri, path);
            Expect(rejected.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), $"unsafe model path is rejected: {path}");
            Expect(assets.LastKey == before, $"unsafe model path never reaches extraction: {path}");
        }
    }

    private static async Task AssertStaticFileContainmentAsync()
    {
        var parent = Path.Combine(Path.GetTempPath(), "couchcoop-static-boundary-" + Guid.NewGuid().ToString("N"));
        var realRoot = Path.Combine(parent, "frontend");
        var sibling = Path.Combine(parent, "frontend-secret");
        var configuredRoot = Path.Combine(parent, "configured-root");
        try
        {
            Directory.CreateDirectory(realRoot);
            Directory.CreateDirectory(sibling);
            await File.WriteAllTextAsync(Path.Combine(realRoot, "index.html"), "safe-index");
            await File.WriteAllTextAsync(Path.Combine(sibling, "secret.txt"), "sibling-secret");
            Directory.CreateSymbolicLink(configuredRoot, realRoot);
            File.CreateSymbolicLink(Path.Combine(realRoot, "escape.txt"), Path.Combine(sibling, "secret.txt"));
            Directory.CreateSymbolicLink(Path.Combine(realRoot, "escape-dir"), sibling);
            Directory.CreateSymbolicLink(Path.Combine(realRoot, "redirected-parent"), sibling);
            File.CreateSymbolicLink(
                Path.Combine(realRoot, "chained-escape.txt"),
                Path.Combine(realRoot, "redirected-parent", "secret.txt"));

            var provider = new StaticSpaFileProvider(configuredRoot);
            Expect((await provider.TryOpenAsync("/index.html"))?.Bytes is { Length: > 0 }, "a configured root symlink remains supported");
            Expect(await provider.TryReadExactAsync("/../frontend-secret/secret.txt") is null, "a similarly-prefixed sibling is outside the static root");
            Expect(await provider.TryReadExactAsync("/escape.txt") is null, "a descendant symlink cannot escape the static root");
            Expect(await provider.TryReadExactAsync("/escape-dir/secret.txt") is null, "an exact read cannot escape through a descendant directory symlink");
            Expect(await provider.TryOpenAsync("/escape-dir/secret.txt") is null, "a SPA read cannot escape through a descendant directory symlink");
            Expect(await provider.TryReadExactAsync("/chained-escape.txt") is null, "an in-root file symlink target cannot escape through a second symlinked parent");
            Expect(await provider.TryOpenAsync("/chained-escape.txt") is null, "the SPA path rejects a chained parent-symlink escape too");

            var nestedRealParent = Path.Combine(parent, "nested-real");
            var nestedRoot = Path.Combine(nestedRealParent, "frontend");
            Directory.CreateDirectory(nestedRoot);
            await File.WriteAllTextAsync(Path.Combine(nestedRoot, "index.html"), "nested-safe-index");
            var nestedParentLink = Path.Combine(parent, "nested-parent-link");
            Directory.CreateSymbolicLink(nestedParentLink, nestedRealParent);
            var nestedProvider = new StaticSpaFileProvider(Path.Combine(nestedParentLink, "frontend"));
            Expect((await nestedProvider.TryOpenAsync("/index.html"))?.Bytes is { Length: > 0 }, "a configured root beneath a symlinked parent remains supported");
        }
        finally
        {
            try { Directory.Delete(parent, recursive: true); } catch (IOException) { }
        }
    }

    // The SpineClipWire binary format round-trips: header (magic/version/canvas/duration) + ascending
    // length-prefixed PNG frames carrying their placement (offset within the shared canvas). The frontend
    // reader (mirror/spineClip.ts) must mirror exactly what this writes.
    private static void AssertSpineClipWire()
    {
        var frames = new List<SpineClipFrame>
        {
            new(1, 3, 4, 2, 2, 33, [0xD, 0xE]),
            new(0, -1, 2, 5, 6, 33, [0xA, 0xB, 0xC]),
        };
        var blob = SpineClipWire.Serialize(frames, canvasWidth: 8, canvasHeight: 9, totalDurationMs: 66, localX: -1.5, localY: 2.25, localWidth: 8, localHeight: 9);
        Expect(blob.Length == SpineClipWire.HeaderSize + (SpineClipWire.FrameHeaderSize + 3) + (SpineClipWire.FrameHeaderSize + 2), "serialized clip length is header + per-frame (header + png)");
        Expect(blob[0] == (byte)'S' && blob[1] == (byte)'P' && blob[2] == (byte)'C' && blob[3] == (byte)'L', "clip starts with the SPCL magic");
        Expect(blob[4] == SpineClipWire.Version, "clip carries the wire version");

        var clip = SpineClipWire.Deserialize(blob);
        Expect(clip.CanvasWidth == 8 && clip.CanvasHeight == 9, "clip preserves the shared canvas size");
        Expect(clip.TotalDurationMs == 66, "clip preserves the total duration");
        Expect(Math.Abs(clip.LocalX - (-1.5)) < 1e-4 && Math.Abs(clip.LocalY - 2.25) < 1e-4, "clip preserves the node-local placement origin");
        Expect(Math.Abs(clip.LocalWidth - 8) < 1e-4 && Math.Abs(clip.LocalHeight - 9) < 1e-4, "clip preserves the node-local placement size");
        Expect(clip.Frames.Count == 2, "clip preserves the frame count");
        Expect(clip.Frames[0].Index == 0 && clip.Frames[1].Index == 1, "frames are ordered by ascending index");
        Expect(clip.Frames[0].OffsetX == -1 && clip.Frames[0].OffsetY == 2, "first frame preserves its signed placement offset");
        Expect(clip.Frames[0].Width == 5 && clip.Frames[0].Height == 6, "first frame preserves its cropped size");
        Expect(clip.Frames[0].EncodedImage is [0xA, 0xB, 0xC], "first frame preserves its encoded image bytes");
        Expect(clip.Frames[1].EncodedImage is [0xD, 0xE], "second frame preserves its encoded image bytes");

        var empty = SpineClipWire.Deserialize(SpineClipWire.Serialize([], 0, 0, 0));
        Expect(empty.Frames.Count == 0, "an empty clip round-trips to zero frames");

        var malformed = false;
        try
        {
            SpineClipWire.Deserialize([0x00, 0x01, 0x02, 0x03]);
        }
        catch (FormatException)
        {
            malformed = true;
        }

        Expect(malformed, "a stream without the SPCL header is rejected");
    }

    // The in-process clip producer: single-flight (concurrent requests for one key share ONE extraction),
    // write-through disk cache (the next request HITs), and a structured error for a frameless clip.
    private static async Task AssertSpineClipProviderAsync()
    {
        var root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-spine-clip-" + Guid.NewGuid().ToString("N"));
        try
        {
            var fake = new GatedSpineAssetProvider();
            var provider = new CouchCoopSpineClipProvider(fake, new SpirectlAssetBinaryCache(root));
            const string key = "spine://characters/ironclad/ironclad_visuals.tscn?anim=idle_loop";

            // Five concurrent requests for an uncached key. The extraction blocks until released, so all
            // five are in flight together — single-flight must collapse them onto ONE extraction.
            var concurrent = Enumerable.Range(0, 5).Select(_ => provider.GetClipAsync(key)).ToArray();
            Expect(await Task.Run(fake.WaitUntilEntered), "the shared extraction starts");
            Expect(fake.Calls == 1, "single-flight runs one extraction for five concurrent requests");
            fake.Release();
            var results = await Task.WhenAll(concurrent);
            Expect(fake.Calls == 1, "single-flight is still one extraction after all requests settle");
            Expect(results.All(result => result.Error is null && result.Blob is not null), "all concurrent clip requests succeed");
            Expect(results.All(result => result.CacheStatus == "MISS"), "concurrent uncached clip requests are served from the one MISS extraction");

            var rendered = SpineClipWire.Deserialize(results[0].Blob!);
            Expect(rendered.Frames.Count == 2, "the rendered clip carries the extracted frames");
            Expect(rendered.CanvasWidth == 8 && rendered.CanvasHeight == 8, "the rendered clip carries the shared canvas from the frame metadata");
            Expect(rendered.Frames[0].OffsetX == 1 && rendered.Frames[0].OffsetY == 2, "the rendered clip preserves per-frame placement through the embeddable seam");
            Expect(Math.Abs(rendered.LocalX - (-100)) < 1e-3 && Math.Abs(rendered.LocalWidth - 8) < 1e-3, "the rendered clip carries the node-local canvas placement from the payload");

            var hit = await provider.GetClipAsync(key);
            Expect(hit.Error is null && hit.CacheStatus == "HIT", "the cached clip is a HIT");
            Expect(hit.Blob!.SequenceEqual(results[0].Blob!), "the cached clip bytes match the rendered clip");
            Expect(fake.Calls == 1, "a cache HIT does not re-extract");

            var empty = await provider.GetClipAsync("spine://x/y.tscn?anim=empty");
            Expect(empty.Error?.Code == "empty-spine-clip", "a frameless clip is a structured empty-spine-clip error");
            Expect(empty.Blob is null, "a failed clip carries no body");
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }

    private static async Task AssertSpinePrerenderAsync()
    {
        Expect(CouchCoopMod.IsSpinePrerenderRequested(["game", "--prerender-spines"]), "the exact spine prerender argument is detected");
        Expect(!CouchCoopMod.IsSpinePrerenderRequested(["--prerender-spines=true"]), "a similarly named argument is not detected");
        Expect(CouchCoopMod.IsSpinePrerenderEnvRequested("1"), "COUCHCOOP_PRERENDER_SPINES=1 triggers the warmup");
        Expect(!CouchCoopMod.IsSpinePrerenderEnvRequested(null), "an unset COUCHCOOP_PRERENDER_SPINES does not trigger the warmup");
        Expect(!CouchCoopMod.IsSpinePrerenderEnvRequested("0") && !CouchCoopMod.IsSpinePrerenderEnvRequested("true"), "only the exact value 1 triggers the warmup");

        var root = Path.Combine(Path.GetTempPath(), "couchcoop-spine-prerender-" + Guid.NewGuid().ToString("N"));
        try
        {
            var runtime = new RecordingSpirectlRuntime
            {
                SpineCatalog = SpineCatalogOperationResult.Success(
                    DataSourceKind.Live,
                    provisional: false,
                    scannedSceneCount: 3,
                    spineNodeCount: 2,
                    entries:
                    [
                        new SpineCatalogEntrySnapshot("res://scenes/a.tscn", "Visuals/Spine", "idle"),
                        new SpineCatalogEntrySnapshot("res://scenes/b.tscn", null, "broken")
                    ],
                    failures: [new SpineCatalogFailureSnapshot("res://scenes/bad.tscn", "scene-load-failed", "malformed")],
                    notes: [])
            };
            var logs = new List<string>();
            var host = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime));
            var provider = new CouchCoopSpineClipProvider(host.Assets, new SpirectlAssetBinaryCache(root));
            var first = await new CouchCoopSpinePrerenderJob(host, provider, logs.Add).RunAsync();

            Expect(first.TotalClips == 2, "prerender summary counts catalog clips");
            Expect(first.SpineNodes == 2, "prerender summary counts distinct Spine nodes");
            Expect(first.CacheHits == 0 && first.RenderedClips == 1, "prerender renders one still per renderable entry");
            Expect(first.Failures == 2, "prerender continues after the discovery and still-render failures");
            Expect(logs.Any(log => log.StartsWith("COUCHCOOP_SPINE_PRERENDER ", StringComparison.Ordinal)), "prerender emits a final JSON summary");
            Expect(
                logs.Any(line => line.Contains("pass=Stills status=rendered", StringComparison.Ordinal))
                    && !logs.Any(line => line.Contains("pass=Clips", StringComparison.Ordinal)),
                "only the still pass reports progress");

            var second = await new CouchCoopSpinePrerenderJob(host, provider, logs.Add).RunAsync();
            Expect(second.CacheHits == 1 && second.RenderedClips == 0, "a second prerender skips the cached still");
            Expect(runtime.Calls.Count(call => call == "Assets.GetAsset") == 3, "cached prerender items avoid the second renderer call");

            // An independent cache root proves the one-pass contract from a cold cache.
            var staticLogs = new List<string>();
            {
                var stillsOnlyProvider = new CouchCoopSpineClipProvider(
                    host.Assets,
                    new SpirectlAssetBinaryCache(Path.Combine(root, "static-belt")));
                var stillsOnly = await new CouchCoopSpinePrerenderJob(host, stillsOnlyProvider, staticLogs.Add).RunAsync();
                Expect(stillsOnly.Status == "complete", "the default (stills-only) prerender completes");
                Expect(stillsOnly.TotalClips == 2, "the default run still discovers the whole catalog");
                Expect(
                    stillsOnly.RenderedClips == 1 && stillsOnly.CacheHits == 0,
                    "the default run bakes ONE still per renderable entry and no animated clip");
                Expect(
                    stillsOnly.Failures == 2,
                    "the broken entry fails ONCE under the default (one pass), plus the discovery failure");
                Expect(
                    staticLogs.Any(line => line.Contains("pass=Stills status=rendered", StringComparison.Ordinal)),
                    "the default run reports its stills pass");
                Expect(
                    !staticLogs.Any(line => line.Contains("pass=Clips", StringComparison.Ordinal)),
                    "the default run never enters the Clips pass at all");
            }

            // Cancelled: a run whose token is already cancelled winds down as "cancelled" but still emits its
            // final JSON summary line (captured via the ctor log Action).
            var cancelledLogs = new List<string>();
            var cancelled = await new CouchCoopSpinePrerenderJob(host, provider, cancelledLogs.Add)
                .RunAsync(new CancellationToken(canceled: true));
            Expect(cancelled.Status == "cancelled", "a pre-cancelled prerender run reports cancelled");
            Expect(
                cancelledLogs.Any(line => line.StartsWith("COUCHCOOP_SPINE_PRERENDER ", StringComparison.Ordinal)),
                "a cancelled run still emits its final JSON summary");

            // Failed: an exception thrown while scanning the Spine catalog aborts the whole run before any clip
            // is rendered, so the summary is "failed" with a single failure tallied.
            var failedRuntime = new RecordingSpirectlRuntime
            {
                SpineCatalogException = new InvalidOperationException("catalog probe failed")
            };
            var failedHost = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(failedRuntime, failedRuntime, failedRuntime, failedRuntime, failedRuntime, failedRuntime, failedRuntime, failedRuntime, failedRuntime, failedRuntime));
            var failedProvider = new CouchCoopSpineClipProvider(failedHost.Assets, new SpirectlAssetBinaryCache(root));
            var failed = await new CouchCoopSpinePrerenderJob(failedHost, failedProvider, new List<string>().Add).RunAsync();
            Expect(failed.Status == "failed", "a catalog scan exception yields a failed summary");
            Expect(failed.Failures == 1, "a catalog scan exception counts as a single failure");

            // Rendered-cache-write-failed: point the cache at a namespace root whose parent is a regular FILE, so
            // TryWriteAsync's Directory.CreateDirectory throws IOException (returning false). The clip still
            // renders, so it counts as rendered AND as a cache-write failure, and logs the distinct status.
            Directory.CreateDirectory(root);
            var blockingFile = Path.Combine(root, "cache-blocking-file-" + Guid.NewGuid().ToString("N"));
            await File.WriteAllTextAsync(blockingFile, "regular file where a cache directory would go");
            var writeFailRuntime = new RecordingSpirectlRuntime
            {
                SpineCatalog = SpineCatalogOperationResult.Success(
                    DataSourceKind.Live,
                    provisional: false,
                    scannedSceneCount: 1,
                    spineNodeCount: 1,
                    entries: [new SpineCatalogEntrySnapshot("res://scenes/a.tscn", null, "idle")],
                    failures: [],
                    notes: [])
            };
            var writeFailHost = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(writeFailRuntime, writeFailRuntime, writeFailRuntime, writeFailRuntime, writeFailRuntime, writeFailRuntime, writeFailRuntime, writeFailRuntime, writeFailRuntime, writeFailRuntime));
            var writeFailProvider = new CouchCoopSpineClipProvider(writeFailHost.Assets, new SpirectlAssetBinaryCache(blockingFile));
            var writeFailLogs = new List<string>();
            var writeFail = await new CouchCoopSpinePrerenderJob(writeFailHost, writeFailProvider, writeFailLogs.Add).RunAsync();
            Expect(writeFail.RenderedClips == 1, "an entry whose cache write fails still counts as rendered");
            Expect(writeFail.CacheWriteFailures == 1, "a failed cache write is tallied separately");
            Expect(
                writeFailLogs.Any(line => line.Contains("status=rendered-cache-write-failed", StringComparison.Ordinal)),
                "a cache-write failure is logged with the rendered-cache-write-failed status");

            AssertBuildSpineKeyEdges();
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }

    // Direct edge coverage for the canonical spine:// key builder shared by the /spines route and the warmup job.
    private static void AssertBuildSpineKeyEdges()
    {
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle")
                == "spine://scenes/a.tscn?anim=idle&codec=webp&fps=15&q=85",
            "BuildSpineKey strips res:// and emits the no-node anim+policy key exactly");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("  /scenes/a.tscn/  ", null, "  idle  ")
                == "spine://scenes/a.tscn?anim=idle&codec=webp&fps=15&q=85",
            "BuildSpineKey trims surrounding whitespace and slashes from the scene and anim");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", "Visuals/Spine", "idle")
                == "spine://scenes/a.tscn?node=Visuals/Spine&anim=idle&codec=webp&fps=15&q=85",
            "BuildSpineKey emits node before anim before the size policy");
        // #14: the still tail is `&still=1&sf=<policy>` — `still=1` is the producer's selector, `sf` an OPAQUE
        // discriminator the producer ignores and the disk cache keys on, so bumping the STILL-FRAME policy (mid /
        // terminal-last sampling) invalidates stills alone and leaves every cached full clip valid.
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, null, still: true)
                == "spine://scenes/a.tscn?codec=webp&fps=15&q=85&still=1&sf=1",
            "BuildSpineKey permits a null anim for a still and appends the still tail");
        Expect(
            CouchCoopSpineClipProvider.StillSelector.StartsWith("&still=1", StringComparison.Ordinal),
            "the still tail still opens with the producer's own &still=1 selector");

        // WS-spine wire contract: absent skin/skel/v yield a BYTE-IDENTICAL key to the pre-contract form (zero
        // clip-cache invalidation) — the default-arg overload and an explicit-nulls call must match the base key.
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", "Visuals/Spine", "idle", still: false, skin: null, skel: null, retry: false)
                == "spine://scenes/a.tscn?node=Visuals/Spine&anim=idle&codec=webp&fps=15&q=85",
            "BuildSpineKey with null skin/skel/v is byte-identical to the base key (no invalidation)");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", "Visuals/Spine", "idle", retry: false)
                == "spine://scenes/a.tscn?node=Visuals/Spine&anim=idle&codec=webp&fps=15&q=85",
            "BuildSpineKey omits retry when false (implicit v1 = the base key)");

        // #8 material discriminator: the shaded standalone-skeleton bake depends on runtime uniform values that are
        // NOT part of the (scene, node, anim, skin, skel) address, so `mat` must widen the key — and stay absent
        // (byte-identical) for the overwhelming majority of nodes, which carry no shader material at all.
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", "Visuals/Spine", "idle", mat: null)
                == "spine://scenes/a.tscn?node=Visuals/Spine&anim=idle&codec=webp&fps=15&q=85",
            "BuildSpineKey with a null mat is byte-identical to the base key (no invalidation)");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", mat: "0123456789abcdef")
                != CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", mat: "fedcba9876543210"),
            "BuildSpineKey discriminates two different material signatures (the re-tint must re-bake)");

        // Selector ORDER (contract, FIXED): node → anim → skin → mat → skel → policy → v.
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", skin: "poisoned")
                == "spine://scenes/a.tscn?anim=idle&skin=poisoned&codec=webp&fps=15&q=85",
            "BuildSpineKey appends skin after anim, before the size policy");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", skel: "res://x/y.tres")
                == "spine://scenes/a.tscn?anim=idle&skel=res://x/y.tres&codec=webp&fps=15&q=85",
            "BuildSpineKey appends skel after anim, before the size policy");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", retry: true)
                == "spine://scenes/a.tscn?anim=idle&codec=webp&fps=15&q=85&retry=1",
            "BuildSpineKey appends v (>1) AFTER the size policy");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", mat: "0123456789abcdef")
                == "spine://scenes/a.tscn?anim=idle&mat=0123456789abcdef&codec=webp&fps=15&q=85",
            "BuildSpineKey appends mat after skin, before skel and the size policy");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", "Visuals/Spine", "idle", still: false, skin: "poisoned", skel: "res://x/y.tres", retry: true, mat: "0123456789abcdef")
                == "spine://scenes/a.tscn?node=Visuals/Spine&anim=idle&skin=poisoned&mat=0123456789abcdef&skel=res://x/y.tres&codec=webp&fps=15&q=85&retry=1",
            "BuildSpineKey emits the full node→anim→skin→mat→skel→policy→v order");

        // R10 PAUSED-STILL TIME (`&t=`). Only a still carries it, only when the client pinned one, and it is
        // quantized to 2 decimals so a millisecond of drift can't mint a fresh bake per request. The closed
        // treasure chest is the case: the game freezes its "animation" clip at t=0, and without the pin the host's
        // mid-frame still heuristic renders a HALF-OPEN lid on a chest nobody has touched.
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/rooms/treasure_room.tscn", "Chest/ChestVisual", "animation", still: true, stillTimeSeconds: 0)
                == "spine://scenes/rooms/treasure_room.tscn?node=Chest/ChestVisual&anim=animation&codec=webp&fps=15&q=85&still=1&sf=1&t=0.00",
            "BuildSpineKey appends the paused-still time at the very end of the still tail");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", still: true, stillTimeSeconds: null)
                == CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", still: true),
            "BuildSpineKey with no paused-still time is byte-identical to the pre-R10 still key (no invalidation)");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", still: false, stillTimeSeconds: 1.5)
                == "spine://scenes/a.tscn?anim=idle&codec=webp&fps=15&q=85",
            "BuildSpineKey ignores a still time on an ANIMATED clip (only a collapsed still samples one time)");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", still: true, stillTimeSeconds: 1.2301)
                == CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", still: true, stillTimeSeconds: 1.2344),
            "BuildSpineKey quantizes the paused-still time to 2 decimals (one cache entry, not one per millisecond)");
        Expect(
            CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", still: true, stillTimeSeconds: 0)
                != CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "idle", still: true, stillTimeSeconds: 0.5),
            "BuildSpineKey discriminates two different paused times (the chest's closed vs open pose)");
        Expect(
            CouchCoopSpineClipProvider.FormatStillTime(0) == "0.00"
                && CouchCoopSpineClipProvider.FormatStillTime(1.239) == "1.24"
                && CouchCoopSpineClipProvider.FormatStillTime(null) is null
                && CouchCoopSpineClipProvider.FormatStillTime(-0.1) is null
                && CouchCoopSpineClipProvider.FormatStillTime(double.NaN) is null
                && CouchCoopSpineClipProvider.FormatStillTime(double.PositiveInfinity) is null
                && CouchCoopSpineClipProvider.FormatStillTime(10_000) is null,
            "FormatStillTime quantizes a sane value and rejects null/negative/NaN/infinite/out-of-range");

        Expect(
            ThrowsArgumentException(() => CouchCoopSpineClipProvider.BuildSpineKey("res://http://x", null, "idle")),
            "BuildSpineKey rejects a scene that still embeds a scheme after res:// is stripped");
        Expect(
            ThrowsArgumentException(() => CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, null, still: false)),
            "BuildSpineKey rejects a null anim when not a still");
        Expect(
            ThrowsArgumentException(() => CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/a.tscn", null, "   ", still: false)),
            "BuildSpineKey rejects a whitespace anim when not a still");
    }

    private static bool ThrowsArgumentException(Action action)
    {
        try
        {
            action();
            return false;
        }
        catch (ArgumentException)
        {
            return true;
        }
    }

    // The /spines/ route always mints the current still key from the readable path + selectors.
    private static async Task AssertSpineClipRoutesAsync(Uri baseUri, RecordingSpirectlRuntime runtime)
    {
        await AssertStaticSpineBeltRoutesAsync(baseUri, runtime);
    }

    // STATIC-SPINE BELT (the default). The host refuses to bake animated clips: every /spines request is minted as
    // the canonical STILL key instead. It is a degrade, not a rejection — a stale tab or the recon
    // view keeps getting a usable single frame — and it lands on exactly the key the prerender job bakes and the
    // still-first client already asks for, so one cache entry serves all of them.
    private static async Task AssertStaticSpineBeltRoutesAsync(Uri baseUri, RecordingSpirectlRuntime runtime)
    {

        const string stillKey =
            "spine://characters/ironclad/ironclad_visuals.tscn?anim=idle_loop&codec=webp&fps=15&q=85&still=1&sf=1";

        var animated = await GetRawAsync(baseUri, "/spines/characters/ironclad/ironclad_visuals.tscn?anim=idle_loop");
        Expect(animated.StatusLine.Contains("200 OK", StringComparison.Ordinal), "an animated spine request still succeeds under the belt");
        Expect(runtime.LastAssetRequest?.Key == stillKey, "the belt mints the STILL key for a request that asked for the animation");
        Expect(
            animated.Headers.TryGetValue("X-Cache", out var animatedCache) && animatedCache == "MISS",
            "the first belt request renders (cold cache)");

        // …and it is the SAME entry an explicit `&still=1` addresses, so the still-first client and a legacy
        // animated client share one bake rather than each getting their own.
        var explicitStill = await GetRawAsync(baseUri, "/spines/characters/ironclad/ironclad_visuals.tscn?anim=idle_loop&still=1");
        Expect(
            explicitStill.Headers.TryGetValue("X-Cache", out var stillCache) && stillCache == "HIT",
            "an explicit &still=1 request HITs the entry the degraded animated request just populated");
        Expect(explicitStill.Body.SequenceEqual(animated.Body), "…and streams byte-identical frames");

        // anim becomes OPTIONAL under the belt: `still` is forced BEFORE the anim check, so the request the old
        // code answered with a 400 now serves the extractor's default preview frame.
        var noAnim = await GetRawAsync(baseUri, "/spines/characters/ironclad/ironclad_visuals.tscn");
        Expect(noAnim.StatusLine.Contains("200 OK", StringComparison.Ordinal), "an anim-less request degrades to a still instead of a 400");
        Expect(
            runtime.LastAssetRequest?.Key
                == "spine://characters/ironclad/ironclad_visuals.tscn?codec=webp&fps=15&q=85&still=1&sf=1",
            "the anim-less still key omits anim and carries the still tail");

        // The belt only changes the still flag — a structurally invalid path is still a 400.
        var embeddedScheme = await GetRawAsync(baseUri, "/spines/spine%3A%2F%2Fx%2Fy.tscn?anim=idle_loop");
        Expect(
            embeddedScheme.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal),
            "the belt does not excuse a /spines path that embeds its own scheme");
    }

    /// <summary>Sets an environment variable for the scope's lifetime, restoring the previous value on dispose.</summary>
    private sealed class EnvScope : IDisposable
    {
        private readonly string _name;
        private readonly string? _previous;

        public EnvScope(string name, string? value)
        {
            _name = name;
            _previous = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }

        public void Dispose() => Environment.SetEnvironmentVariable(_name, _previous);
    }

    // S9/S10 perf report routes. What is checkable WITHOUT a live game is everything except the wall time of a
    // real Godot render: that the routes answer the shared perf-report/1 envelope, that arming the wire
    // recorder makes the live send path record real frames, that the /bg measurement route is opt-in, and —
    // the one that actually matters for a 1920-vs-2520 comparison — that the requested size reaches the
    // embeddable render seam and that the measurement bypasses BOTH caches (a non-policy render must never be
    // served or stored under a policy key). The render TIME itself needs a running host; see /perf/bg.json.
    private static async Task AssertPerfReportRoutesAsync(string staticRoot)
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        SceneDeltaWireMetrics.Enabled = false;
        SceneDeltaWireMetrics.Reset();
        StaticBackgroundRenderMetrics.Reset();
        try
        {
            using var cacheRoot = new TempResourceCacheRoot();
            var runtime = new RecordingSpirectlRuntime();
            var envelopeFactory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));
            await using var server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new CapturingAssetAdapter(),
                envelopeFactory,
                resourceCacheRoot: cacheRoot.Path);
            var baseUri = await server.StartAsync();

            var unknown = await GetAsync(baseUri, "/perf/nope.json");
            Expect(unknown.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "an unknown perf report is a 404");
            Expect(unknown.Body.Contains("unknown-perf-report", StringComparison.Ordinal), "the unknown-report failure is structured");

            // ---- S9: arm, serialize real deltas through the real send path, report ---------------------------
            var armed = await GetAsync(baseUri, "/perf/scene-delta.json?arm=1&reset=1&scenario=route-test");
            Expect(armed.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the scene-delta report answers 200");
            Expect(SceneDeltaWireMetrics.Enabled, "?arm=1 arms the wire recorder");
            using (var armedDoc = JsonDocument.Parse(armed.Body))
            {
                var root = armedDoc.RootElement;
                Expect(root.GetProperty("schema").GetString() == "perf-report/1", "the report carries the shared schema");
                Expect(root.GetProperty("profile").GetString() == "wire-payload", "the scene-delta report is the wire-payload profile");
                Expect(root.GetProperty("repo").GetString() == "sts2-couch-coop", "the report names this repo");
                Expect(root.GetProperty("scenario").GetString() == "route-test", "?scenario rides the envelope");
            }

            // Three frames through the REAL serializer (this is the instrumented path, not a stub).
            var node = new RuntimeSceneNodeDelta(
                Id: "n1", ParentId: null, Name: "Root", NodeType: "Control", Rect: null,
                Visible: true, Opacity: 1, ZIndex: null, Rotation: 0, Texture: null, NinePatch: false, Text: null);
            var bytes = 0;
            for (var i = 0; i < 3; i++)
            {
                bytes = BrowserSceneDeltaMessage
                    .Serialize(new RuntimeSceneDelta(false, "run", "screen:run:live", [node], [], ["n1"]))
                    .Length;
            }

            var measured = await GetAsync(baseUri, "/perf/scene-delta.json?windows=1&arm=0");
            using (var measuredDoc = JsonDocument.Parse(measured.Body))
            {
                var metrics = measuredDoc.RootElement.GetProperty("metrics");
                Expect(metrics.GetProperty("frames").GetInt32() == 3, "every serialized frame was recorded");
                Expect(
                    metrics.GetProperty("wireBytes").GetProperty("p50").GetInt32() == bytes,
                    "the reported wire bytes ARE the produced message length");
                Expect(metrics.GetProperty("upsertCount").GetProperty("p50").GetInt32() == 1, "upserts per frame");
                Expect(
                    metrics.GetProperty("orderedIdsBytes").GetProperty("p50").GetInt32() > 0,
                    "the order array's byte share is attributed");
                Expect(measuredDoc.RootElement.GetProperty("runs").GetArrayLength() >= 1, "runs is never empty");
            }

            Expect(!SceneDeltaWireMetrics.Enabled, "?arm=0 disarms the recorder again");

            // ---- S10: the /bg render report + the opt-in size comparison --------------------------------------
            var benchOff = await GetAsync(baseUri, "/perf/bg-render.json?id=underdocks");
            Expect(benchOff.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "the bg render bench is OFF by default");
            Expect(benchOff.Body.Contains("bg-bench-disabled", StringComparison.Ordinal), "the disabled bench says how to enable itself");

            Environment.SetEnvironmentVariable(StaticBackgroundRenderMetrics.BenchEnvVar, "1");
            try
            {
                var malformed = await GetAsync(baseUri, "/perf/bg-render.json?id=underdocks&sizes=1920");
                Expect(malformed.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a malformed size list is rejected, not silently dropped");

                StaticBackgroundRenderMetrics.Reset();
                var callsBefore = runtime.Calls.Count(call => call == "Assets.GetAsset");
                var bench = await GetAsync(
                    baseUri,
                    "/perf/bg-render.json?id=underdocks&sizes=1920x1080,2520x1080&repeats=2&warmups=1&scenario=static-background-render");
                Expect(bench.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the bg render bench answers 200");
                var calls = runtime.Calls.Count(call => call == "Assets.GetAsset") - callsBefore;
                Expect(calls == 6, $"2 sizes x (1 warmup + 2 repeats) renders reached the seam, cache bypassed both ways (got {calls})");

                using var benchDoc = JsonDocument.Parse(bench.Body);
                var benchRoot = benchDoc.RootElement;
                Expect(benchRoot.GetProperty("profile").GetString() == "asset-render", "the bg report is the asset-render profile");
                Expect(benchRoot.GetProperty("scenario").GetString() == "static-background-render", "?scenario rides the envelope");
                Expect(benchRoot.GetProperty("warmups").GetInt32() == 1, "warmups are reported, not folded into the repeats");
                var benchMetrics = benchRoot.GetProperty("metrics");
                Expect(benchMetrics.TryGetProperty("1920x1080", out _), "the report has a metric block per requested size");
                Expect(benchMetrics.TryGetProperty("2520x1080", out _), "…including the shipped policy size");
                Expect(
                    benchMetrics.GetProperty("1920x1080").GetProperty("renders").GetInt32() == 2,
                    "the warmup render is excluded from the reported repeats");
                Expect(benchRoot.GetProperty("runs").GetArrayLength() == 4, "runs carries every measured render");
                Expect(
                    benchRoot.GetProperty("params").GetProperty("policyWidthPx").GetInt32() == CouchCoopStaticBackgroundProvider.RenderWidthPx,
                    "the envelope records the shipped policy size the comparison is against");

                // The point of the whole exercise: the requested size actually reached the render seam.
                Expect(runtime.LastAssetRequest is { RenderWidth: 2520, RenderHeight: 1080 }, "the last benched size reached the embeddable seam");

                // ---- R21: the codec[@quality][:opaque] candidate grammar --------------------------------------
                var badCodec = await GetAsync(baseUri, "/perf/bg-render.json?id=underdocks&sizes=1920x1080&formats=avif");
                Expect(badCodec.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "an unsupported codec is rejected, not silently rendered as png");
                var badQuality = await GetAsync(baseUri, "/perf/bg-render.json?id=underdocks&sizes=1920x1080&formats=webp@85");
                Expect(badQuality.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a quality outside (0,1] is rejected rather than quietly measured as lossless");

                StaticBackgroundRenderMetrics.Reset();
                var shippedLabel = CouchCoopStaticBackgroundProvider.ShippedCodec.Label;
                var codecBench = await GetAsync(
                    baseUri,
                    $"/perf/bg-render.json?id=underdocks&sizes=1920x1080&formats={shippedLabel},png,webp@0.85:opaque&repeats=1&warmups=0");
                Expect(codecBench.StatusLine.Contains("200 OK", StringComparison.Ordinal), "a codec matrix answers 200");
                // The encode knobs must reach the SEAM, not just the report: a bench that labels a row
                // "webp@0.85" while rendering lossless png is a table of fiction.
                Expect(
                    runtime.LastAssetRequest is { Format: "webp", ImageOpaque: true }
                    && runtime.LastAssetRequest.ImageQuality is { } benchedQuality
                    && Math.Abs(benchedQuality - 0.85f) < 1e-6,
                    "the codec, quality and opacity all reached the embeddable seam");

                using (var codecDoc = JsonDocument.Parse(codecBench.Body))
                {
                    var codecMetrics = codecDoc.RootElement.GetProperty("metrics");
                    Expect(codecMetrics.TryGetProperty("1920x1080", out _), "the shipped-policy candidate keeps the bare size key");
                    Expect(
                        codecMetrics.TryGetProperty("1920x1080:png", out _),
                        "…png is now an ordinary candidate and gets its own block");
                    Expect(
                        codecMetrics.TryGetProperty("1920x1080:webp@0.85:opaque", out _),
                        "…and the lossy candidate gets its own labelled block instead of averaging in");
                }

                // …and nothing the bench rendered may be served afterwards: the /bg route still renders its own.
                var served = await GetRawAsync(baseUri, "/bg/underdocks?v=1");
                Expect(served.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the real /bg route still serves");
                Expect(
                    served.Headers.TryGetValue("X-Cache", out var servedStatus) && servedStatus == "miss",
                    "the bench populated NO cache entry — the served render is still a fresh miss");
                Expect(runtime.LastAssetRequest is { RenderWidth: 2520, RenderHeight: 1080 }, "the served render is still the fixed policy size");
            }
            finally
            {
                Environment.SetEnvironmentVariable(StaticBackgroundRenderMetrics.BenchEnvVar, null);
            }

            var bgReport = await GetAsync(baseUri, "/perf/bg.json?scenario=served-renders");
            using (var bgDoc = JsonDocument.Parse(bgReport.Body))
            {
                var bgRoot = bgDoc.RootElement;
                Expect(bgRoot.GetProperty("profile").GetString() == "asset-render", "the served-render report is the asset-render profile");
                Expect(bgRoot.GetProperty("runs").GetArrayLength() > 0, "the served renders are reported");
                Expect(
                    bgRoot.GetProperty("env").GetProperty("cpuThrottle").ValueKind == JsonValueKind.Null,
                    "a host-side report has no cpu throttle (null is legal for the non-browser profiles)");
                Expect(
                    bgRoot.GetProperty("params").TryGetProperty("phasedRenders", out _),
                    "the report says how many renders carry a phase breakdown, so an unphased one is visible as such");
            }

            // ---- the /spines bake report + its opt-in bench -----------------------------------------------
            var spineBenchOff = await GetAsync(baseUri, "/perf/spine-render.json?key=spine://scenes/x.tscn?anim=idle");
            Expect(spineBenchOff.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "the spine bake bench is OFF by default");
            Expect(spineBenchOff.Body.Contains("spine-bench-disabled", StringComparison.Ordinal), "the disabled bench says how to enable itself");

            Environment.SetEnvironmentVariable(SpineBakeMetrics.BenchEnvVar, "1");
            try
            {
                var notAKey = await GetAsync(baseUri, "/perf/spine-render.json?key=res://scenes/x.tscn");
                Expect(notAKey.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a non-spine:// key is rejected rather than baked");
            }
            finally
            {
                Environment.SetEnvironmentVariable(SpineBakeMetrics.BenchEnvVar, null);
            }

            var spineReport = await GetAsync(baseUri, "/perf/spine.json?scenario=served-bakes");
            using (var spineDoc = JsonDocument.Parse(spineReport.Body))
            {
                var spineRoot = spineDoc.RootElement;
                Expect(spineRoot.GetProperty("profile").GetString() == "asset-render", "the bake report shares the background report's profile");
                Expect(spineRoot.GetProperty("scenario").GetString() == "served-bakes", "?scenario rides the envelope");
                Expect(spineRoot.GetProperty("metrics").TryGetProperty("failedBakes", out _), "failures are always reported, even with no bakes yet");
            }

            var unknownReport = await GetAsync(baseUri, "/perf/nope.json");
            Expect(unknownReport.Body.Contains("/perf/spine.json", StringComparison.Ordinal), "the route list names the new reports");
        }
        finally
        {
            SceneDeltaWireMetrics.Enabled = false;
            SceneDeltaWireMetrics.Reset();
            StaticBackgroundRenderMetrics.Reset();
            SpineBakeMetrics.Reset();
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    // Stage-A static background: /bg/<id>?layers=<digest>&v=1 — 200 + image/png + immutable + X-Cache
    // (miss → memory → disk hit), 400 on malformed paths/digests, 404 on unknown ids / stale digests / valve-off,
    // and the current-digest render carrying the tracker's published layer set as the CompositionSelector.
    private static async Task AssertStaticBackgroundRoutesAsync(string staticRoot)
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            using var cacheRoot = new TempResourceCacheRoot();
            var runtime = new RecordingSpirectlRuntime();
            var envelopeFactory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));
            await using var server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new CapturingAssetAdapter(),
                envelopeFactory,
                resourceCacheRoot: cacheRoot.Path);
            var baseUri = await server.StartAsync();

            int AssetCalls() => runtime.Calls.Count(call => call == "Assets.GetAsset");

            var badId = await GetAsync(baseUri, "/bg/Under-Docks.png");
            Expect(badId.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "an id outside the lowercase convention is malformed");
            Expect(badId.Body.Contains("invalid-bg-route", StringComparison.Ordinal), "/bg malformed rejection is structured");

            var badDigest = await GetAsync(baseUri, "/bg/underdocks?layers=XYZ");
            Expect(badDigest.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a garbled layers digest is malformed");

            var unknown = await GetAsync(baseUri, "/bg/missing_bg");
            Expect(unknown.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "a background the renderer does not know is a 404");
            Expect(unknown.Body.Contains("missing-asset", StringComparison.Ordinal), "the unknown-background failure is structured");

            // Deterministic variant (no digest): the first request renders ONCE through the embeddable seam at
            // the pinned 2520x1080 policy with NO CompositionSelector.
            //
            // R21: the canonical URL lost its file extension, because the encoder became a policy (jpg@0.9 today)
            // and Content-Type is what names it. `/bg/<id>` used to be a 400 — this is the assertion that flipped.
            var callsBefore = AssetCalls();
            var miss = await GetRawAsync(baseUri, "/bg/underdocks?v=1");
            Expect(miss.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the deterministic bg request succeeds without a file extension");
            Expect(
                miss.Headers.TryGetValue("Content-Type", out var bgContentType) && bgContentType == "image/jpeg",
                $"the bg response announces the shipped codec's type (got {(miss.Headers.TryGetValue("Content-Type", out var seen) ? seen : "<none>")})");
            Expect(
                miss.Headers.TryGetValue("Cache-Control", out var bgCache) && bgCache == "public, max-age=31536000, immutable",
                "the bg response carries immutable caching (the digest in the URL is what keeps that safe)");
            Expect(miss.Headers.TryGetValue("X-Cache", out var missStatus) && missStatus == "miss", "the first bg request is a miss");
            Expect(runtime.LastAssetRequest is
            {
                Key: "composed://combat-background/underdocks/image",
                Format: "jpg",
                RenderWidth: 2520,
                RenderHeight: 1080,
                CompositionSelector: null,
            }, "the deterministic render addresses the composed key at the fixed policy with no selector");
            Expect(
                runtime.LastAssetRequest!.ImageQuality is { } bgQuality && Math.Abs(bgQuality - 0.9f) < 1e-6,
                "…and the shipped quality reaches the seam, not just the codec name");

            // Memory hit: the second request answers from RAM — ZERO further provider calls.
            var afterMiss = AssetCalls();
            Expect(afterMiss == callsBefore + 1, "the miss extracted exactly once");
            var memory = await GetRawAsync(baseUri, "/bg/underdocks?v=1");
            Expect(memory.Headers.TryGetValue("X-Cache", out var memoryStatus) && memoryStatus == "memory", "the second bg request serves from memory");
            Expect(memory.Body.SequenceEqual(miss.Body), "memory serves the identical bytes");
            Expect(AssetCalls() == afterMiss, "a memory hit makes zero provider calls");

            // Filename aliases are not part of the current namespace: Content-Type names the codec and a stale
            // filename must not mint a second cache address for the same rendered bytes.
            foreach (var legacy in new[] { "/bg/underdocks.png?v=1", "/bg/underdocks.jpg?v=1", "/bg/underdocks.webp?v=1" })
            {
                var alias = await GetRawAsync(baseUri, legacy);
                Expect(alias.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), $"the retired filename URL {legacy} is rejected");
            }

            // Disk hit: a COLD server over the same cache root (fresh provider, empty memory map) serves the
            // write-through without extracting.
            var coldRuntime = new RecordingSpirectlRuntime();
            await using (var coldServer = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot),
                new CapturingAssetAdapter(),
                new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(coldRuntime, coldRuntime, coldRuntime, coldRuntime, coldRuntime, coldRuntime, coldRuntime, coldRuntime, coldRuntime, coldRuntime))),
                resourceCacheRoot: cacheRoot.Path))
            {
                var coldBase = await coldServer.StartAsync();
                var hit = await GetRawAsync(coldBase, "/bg/underdocks?v=1");
                Expect(hit.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the cold-server bg request succeeds");
                Expect(hit.Headers.TryGetValue("X-Cache", out var hitStatus) && hitStatus == "hit", "the cold server serves the disk cache");
                Expect(hit.Body.SequenceEqual(miss.Body), "disk serves the identical bytes");
                Expect(coldRuntime.Calls.Count(call => call == "Assets.GetAsset") == 0, "a disk hit makes zero provider calls");
            }

            // Digest resolution: the digest matching the tracker's CURRENT published variant renders WITH that
            // layer set (CompositionSelector); any other digest is cache-only and 404s cold.
            string[] layers =
            [
                "res://scenes/backgrounds/underdocks/layers/underdocks_bg_00_c.tscn",
                "res://scenes/backgrounds/underdocks/layers/underdocks_fg_a.tscn",
            ];
            var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(layers)!;
            new CouchCoopStaticBackgroundTracker().PublishForTest(new CouchCoopStaticBackgroundState(
                "res://scenes/backgrounds/underdocks/underdocks_background.tscn",
                layers,
                digest,
                CouchCoopStaticBackgroundProvider.BuildImageUrl("underdocks", digest)));

            var variant = await GetRawAsync(baseUri, $"/bg/underdocks?layers={digest}&v=1");
            Expect(variant.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the current-digest bg request renders");
            Expect(variant.Headers.TryGetValue("X-Cache", out var variantStatus) && variantStatus == "miss", "the current-digest variant is its own cache entry");
            Expect(
                runtime.LastAssetRequest?.CompositionSelector == string.Join(',', layers),
                "the current-digest render carries the published layer set as the CompositionSelector");

            var stale = await GetAsync(baseUri, "/bg/underdocks?layers=0123456789abcdef&v=1");
            Expect(stale.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "a stale (non-current) digest 404s instead of rendering");
            Expect(stale.Body.Contains("unknown-background-variant", StringComparison.Ordinal), "the stale-digest failure is structured");

            // EVENT family: /bg/events/<id>?v=1 renders the literal event backdrop scene at the same fixed
            // policy, always digest-less (event backdrops mount no layer variants).
            var eventCallsBefore = AssetCalls();
            var eventMiss = await GetRawAsync(baseUri, "/bg/events/neow?v=1");
            Expect(eventMiss.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the event bg request succeeds");
            Expect(eventMiss.Headers.TryGetValue("X-Cache", out var eventMissStatus) && eventMissStatus == "miss", "the first event bg request is a miss");
            Expect(runtime.LastAssetRequest is
            {
                Key: "res://scenes/events/background_scenes/neow.tscn",
                Format: "jpg",
                RenderWidth: 2520,
                RenderHeight: 1080,
                CompositionSelector: null,
            }, "the event render addresses the literal backdrop scene at the fixed policy with no selector");
            Expect(AssetCalls() == eventCallsBefore + 1, "the event miss extracted exactly once");

            var eventMemory = await GetRawAsync(baseUri, "/bg/events/neow?v=1");
            Expect(
                eventMemory.Headers.TryGetValue("X-Cache", out var eventMemoryStatus) && eventMemoryStatus == "memory",
                "the second event bg request serves from memory");
            Expect(eventMemory.Body.SequenceEqual(eventMiss.Body), "event memory serves the identical bytes");
            Expect(AssetCalls() == eventCallsBefore + 1, "an event memory hit makes zero provider calls");

            var eventWithDigest = await GetAsync(baseUri, "/bg/events/neow?layers=0123abc&v=1");
            Expect(
                eventWithDigest.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal),
                "an event URL carrying layers= is malformed (no such URL is ever minted)");

            var eventMissing = await GetAsync(baseUri, "/bg/events/neow_missing?v=1");
            Expect(eventMissing.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "an unknown event backdrop is a 404");

            // Bare "/bg/events" (ONE segment) still parses as the combat id "events", exactly as it always did:
            // family disambiguation is by segment count, never by the id's spelling.
            _ = await GetRawAsync(baseUri, "/bg/events?v=1");
            Expect(
                runtime.LastAssetRequest?.Key == "composed://combat-background/events/image",
                "a bare /bg/events reaches the combat composed key (segment-count disambiguation)");

            // The FRAME rule, the digest rule's events twin: only the tracker's CURRENT frame renders; a stale
            // frame is cache-only (404 cold); combat URLs never carry one; a garbled spec is a 400.
            var frameSpec = CouchCoopStaticBackgroundProvider.FormatEventFrameSpec(105.6, 99.4, 0.89);
            new CouchCoopStaticBackgroundTracker().PublishForTest(new CouchCoopStaticBackgroundState(
                "res://scenes/events/background_scenes/neow.tscn",
                [],
                Digest: null,
                CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null, frameSpec),
                EventFrame: frameSpec));
            var framed = await GetRawAsync(baseUri, $"/bg/events/neow?frame={Uri.EscapeDataString(frameSpec)}&v=1");
            Expect(framed.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the current-frame event request renders");
            Expect(
                runtime.LastAssetRequest?.EventBackgroundFrame == frameSpec,
                "the probed frame reaches the render seam");
            var staleFrame = await GetAsync(baseUri, "/bg/events/neow?frame=1.0,2.0,0.500&v=1");
            Expect(staleFrame.StatusLine.Contains("404 NotFound", StringComparison.Ordinal), "a stale (non-current) frame 404s instead of rendering");
            Expect(staleFrame.Body.Contains("unknown-background-variant", StringComparison.Ordinal), "the stale-frame failure is structured");
            var combatFrame = await GetAsync(baseUri, $"/bg/underdocks?frame={Uri.EscapeDataString(frameSpec)}&v=1");
            Expect(combatFrame.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a combat URL carrying frame= is malformed");
            var garbledFrame = await GetAsync(baseUri, "/bg/events/neow?frame=nonsense&v=1");
            Expect(garbledFrame.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a garbled frame spec is malformed");

            // ROOMS family: /bg/rooms/<id>?v=1 renders the committed subtree via a scene-subtree:// key.
            var room = await GetRawAsync(baseUri, "/bg/rooms/merchant_room?v=1");
            Expect(room.StatusLine.Contains("200 OK", StringComparison.Ordinal), "the room backdrop request renders");
            Expect(
                runtime.LastAssetRequest?.Key == "scene-subtree://res://scenes/rooms/merchant_room.tscn?node=SceneContainer%2FBgContainer",
                $"the room render addresses the subtree key (got {runtime.LastAssetRequest?.Key})");
            Expect(
                runtime.LastAssetRequest is { RenderWidth: 2520, RenderHeight: 1080 },
                "…at the fixed policy size");
            var roomDigest = await GetAsync(baseUri, "/bg/rooms/merchant_room?layers=abc&v=1");
            Expect(roomDigest.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), "a room URL carrying layers= is malformed");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    // The session envelope's staticBackground descriptor: filled from the tracker's published volatile,
    // null-OMITTED from the wire when unknown.
    private static async Task AssertStaticBackgroundEnvelopeAsync()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            var factory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime())));
            var absent = await factory.CreateSessionEnvelope("Alice", "browser:req:bg-absent", session: null);
            Expect(absent.StaticBackground is null, "the descriptor is null while nothing is published");
            Expect(
                !BrowserJson.Serialize(absent).Contains("staticBackground", StringComparison.Ordinal),
                "a null descriptor is omitted from the wire entirely");

            const string scene = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";
            string[] layers = ["res://scenes/backgrounds/underdocks/layers/underdocks_bg_00_c.tscn"];
            var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(layers)!;
            var url = CouchCoopStaticBackgroundProvider.BuildImageUrl("underdocks", digest);
            new CouchCoopStaticBackgroundTracker().PublishForTest(new CouchCoopStaticBackgroundState(scene, layers, digest, url));

            var present = await factory.CreateSessionEnvelope("Alice", "browser:req:bg-present", session: null);
            using var document = JsonDocument.Parse(BrowserJson.Serialize(present));
            var descriptor = document.RootElement.GetProperty("staticBackground");
            Expect(descriptor.GetProperty("scenePath").GetString() == scene, "the descriptor carries the live bg scene path");
            Expect(descriptor.GetProperty("url").GetString() == url, "the descriptor carries the ready-to-fetch digest-qualified /bg/ URL");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    private static async Task AssertInternalServerErrorsAreStructuredAsync(string staticRoot)
    {
        using var cacheRoot = new TempResourceCacheRoot();
        var logs = new List<string>();
        var runtime = new RecordingSpirectlRuntime();
        var envelopeFactory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime), logs.Add));
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(staticRoot),
            new ThrowingAssetAdapter(),
            envelopeFactory,
            resourceCacheRoot: cacheRoot.Path,
            log: logs.Add);
        var baseUri = await server.StartAsync();

        var response = await GetAsync(baseUri, "/res/images/boom.png");
        Expect(response.StatusLine.Contains("500 InternalServerError", StringComparison.Ordinal), "unexpected server errors return HTTP 500");
        using (var document = JsonDocument.Parse(response.Body))
        {
            var root = document.RootElement;
            Expect(root.GetProperty("type").GetString() == "error", "unexpected server errors use error envelopes");
            Expect(root.GetProperty("code").GetString() == "internal-server-error", "unexpected server errors use a stable code");
            Expect(!root.TryGetProperty("diagnostics", out _), "unexpected server errors do not expose internal diagnostics");
            Expect(!response.Body.Contains(nameof(ApplicationException), StringComparison.Ordinal)
                && !response.Body.Contains("asset test failure", StringComparison.Ordinal), "unexpected server errors keep exception details out of the wire response");
        }

        Expect(logs.Any(entry =>
            entry.Contains("internal-server-error", StringComparison.Ordinal)
            && entry.Contains(nameof(ApplicationException), StringComparison.Ordinal)), "unexpected server errors are logged structurally");
    }

    // A headless seat refuses to EXTRACT (CachedSpirectlAssetHttpAdapter answers `asset-extraction-unavailable`
    // rather than poisoning the shared asset cache with a 1x1), and a host whose runtime is not up yet answers
    // nothing at all. Neither is a reason for a phone's home-screen icon to 404 — the shipped placeholder is
    // still a perfectly good icon, so the route FAILS OPEN to it and says so in X-Icon-Source.
    private static async Task AssertAppIconFailsOpenAsync(string staticRoot)
    {
        using var cacheRoot = new TempResourceCacheRoot();
        var logs = new List<string>();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(staticRoot),
            new RefusingAssetAdapter(),
            envelopeFactory: null,
            resourceCacheRoot: cacheRoot.Path,
            log: logs.Add);
        var baseUri = await server.StartAsync();

        var icon = await GetAsync(baseUri, "/icons/icon-512.png");
        Expect(icon.StatusLine.Contains("200 OK", StringComparison.Ordinal), "an icon still answers when the game cannot render it");
        Expect(icon.Headers.TryGetValue("X-Icon-Source", out var source) && source == "static", "the fallback branch reports itself");
        Expect(icon.Body.Contains("shipped-icon-512", StringComparison.Ordinal), "the fallback serves the SHIPPED bytes for that size");

        // The two branches must not share an ETag: a client that cached the game-rendered icon and then hits a
        // host serving the fallback (or the reverse) has to re-fetch, not revalidate to a stale 304.
        Expect(icon.Headers.TryGetValue("ETag", out var etag) && etag.Contains("static", StringComparison.Ordinal), "the fallback's ETag is distinguishable from the rendered one's");
    }

    private sealed class RefusingAssetAdapter : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string opaqueKey, CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw, CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
            => Task.FromResult(CouchCoopAssetHttpResponse.Missing(new CouchCoopAssetHttpError(
                "asset-extraction-unavailable",
                "Asset extraction is unavailable on this instance.",
                "key",
                opaqueKey,
                [])));
    }

    private static void AssertAssignmentDtos()
    {
        var runtime = new RecordingSpirectlRuntime();
        var factory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));

        var trimmed = factory.CreateSessionEnvelope("  Alice  ", "session", null).GetAwaiter().GetResult();
        using var trimmedJson = JsonDocument.Parse(BrowserJson.Serialize(trimmed));
        Expect(trimmedJson.RootElement.GetProperty("session").GetProperty("name").GetString() == "Alice", "assignment trims names exactly");
        Expect(trimmedJson.RootElement.GetProperty("players").EnumerateArray().Count(player => player.GetProperty("name").GetString() == "Alice") == 1, "duplicate name rejoins existing identity");

        runtime.Mode = RuntimeStateMode.Unsupported;
        var unsupported = factory.CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();
        using var unsupportedJson = JsonDocument.Parse(BrowserJson.Serialize(unsupported));
        Expect(unsupportedJson.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "unsupported", "unsupported screens are classified");
        Expect(unsupportedJson.RootElement.GetProperty("screen").GetProperty("title").GetString() == "Main Menu", "unsupported screen title is exposed");
        Expect(unsupportedJson.RootElement.GetProperty("assignmentNotices")[0].GetProperty("code").GetString() == "unsupported-screen", "unsupported screen notice is structured");
        Expect(!unsupportedJson.RootElement.TryGetProperty("renderSnapshot", out _), "unsupported screens do not expose render controls");

        // A singleplayer-netGameType run is now browser-controllable too (the local bridge drives the
        // local player), so BrowserAssignmentState.Classify treats it as a normal, joinable "run" — it is
        // no longer a distinct "singleplayerUnsupported" screen. (See BrowserAssignmentState.Classify.)
        runtime.Mode = RuntimeStateMode.SingleplayerAmbiguous;
        var singleplayer = factory.CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();
        using var singleplayerJson = JsonDocument.Parse(BrowserJson.Serialize(singleplayer));
        Expect(singleplayerJson.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "run", "singleplayer runs are browser-controllable and classified as run");
        Expect(singleplayerJson.RootElement.GetProperty("session").GetProperty("joined").GetBoolean(), "singleplayer run can be assigned to the browser");
        Expect(!singleplayerJson.RootElement.TryGetProperty("renderSnapshot", out _), "run sessions do not expose render controls");

        runtime.Mode = RuntimeStateMode.Lobby;
        var lobby = factory.CreateSessionEnvelope("", "session", null).GetAwaiter().GetResult();
        using var lobbyJson = JsonDocument.Parse(BrowserJson.Serialize(lobby));
        Expect(lobbyJson.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "lobby", "lobby screens are classified");
        Expect(lobbyJson.RootElement.GetProperty("players").GetArrayLength() >= 2, "lobby session exposes shared lobby players");
        Expect(!lobbyJson.RootElement.TryGetProperty("lobbyState", out _), "session message omits the redundant lobbyState re-encoding");

        runtime.Mode = RuntimeStateMode.SingleplayerSafe;
        var safeSingleplayer = factory.CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();
        using var safeJson = JsonDocument.Parse(BrowserJson.Serialize(safeSingleplayer));
        Expect(safeJson.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "run", "safe singleplayer is classified as run");
        Expect(safeJson.RootElement.GetProperty("session").GetProperty("joined").GetBoolean(), "safe singleplayer can be assigned");
    }

    // A server-side fault inside the join handler is converted into `joinRejection: "join-failed"` + the exception
    // text, because the `action-result` the receive loop would otherwise answer with is a message type the mirror
    // client ignores — which is how a shipped KeyNotFoundException reached a viewer as a "Joining…" spinner that
    // never ended. This asserts the ENVELOPE half of that contract (the throw→rejection conversion itself lives
    // inside ReceiveLoopAsync and is covered by the live check, not by a socket harness).
    private static void AssertJoinRejectionDetailPlumbing()
    {
        var factory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime())));

        var failed = factory
            .CreateSessionEnvelope("Alice", "session", null, null, null, "join-failed", "boom: the host threw")
            .GetAwaiter().GetResult();
        using var failedJson = JsonDocument.Parse(BrowserJson.Serialize(failed));
        Expect(failedJson.RootElement.GetProperty("joinRejection").GetString() == "join-failed", "join-failed rides the rejection channel");
        Expect(failedJson.RootElement.GetProperty("joinRejectionDetail").GetString() == "boom: the host threw", "the host's fault text reaches the viewer");
        // The existing refusal guard must cover the new code too, or the client's terminal handling is skipped.
        Expect(!failedJson.RootElement.GetProperty("session").GetProperty("joined").GetBoolean(), "a failed join never also reports itself joined");

        // A rejection with no detail (every self-describing code) omits the field entirely — no wire change for
        // any path that worked before this existed.
        var plain = factory
            .CreateSessionEnvelope("Alice", "session", null, null, null, "no-free-instance")
            .GetAwaiter().GetResult();
        using var plainJson = JsonDocument.Parse(BrowserJson.Serialize(plain));
        Expect(!plainJson.RootElement.TryGetProperty("joinRejectionDetail", out _), "a detail-free rejection sends no detail field");

        // And a detail with no rejection to explain is dropped rather than emitted on its own.
        var orphan = factory
            .CreateSessionEnvelope("Alice", "session", null, null, null, null, "orphaned detail")
            .GetAwaiter().GetResult();
        using var orphanJson = JsonDocument.Parse(BrowserJson.Serialize(orphan));
        Expect(!orphanJson.RootElement.TryGetProperty("joinRejectionDetail", out _), "detail without a rejection is dropped");
    }

    // THE LIVE SHAPE OF THE DEFECT, driven through the real receive loop over a real socket. The envelope test
    // above proves the wire fields; this proves the CONVERSION — that a throw from inside the join decision comes
    // back to the browser as a rejection it can act on, instead of the `action-result` the mirror client ignores.
    //
    // The fault is injected exactly where the shipped one lived: HeadlessClientManager's launcher, which is what
    // threw KeyNotFoundException on 2026-08-15 (an unguarded `psi.EnvironmentVariables[key]` read). Nothing here
    // is contrived — the launcher delegate is the manager's only seam and a launch really can fail.
    private static async Task AssertJoinFaultReachesTheViewerAsync(string staticRoot)
    {
        const string faultText = "The given key 'MALLOC_ARENA_MAX' was not present in the dictionary.";
        // A HOSTING lobby: the one state in which the join handler really reaches the spawn path, which is what
        // makes the injected launcher fault reproduce the shipped defect instead of a rejection taken earlier.
        var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.Lobby, LobbyNetGameType = "host" };
        var envelopeFactory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));
        using var manager = new HeadlessClientManager(launcher: _ => throw new KeyNotFoundException(faultText));
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(staticRoot),
            new CapturingAssetAdapter(),
            envelopeFactory,
            headlessManager: manager,
            isHeadlessClient: false);
        var baseUri = await server.StartAsync();

        using var mirror = new ClientWebSocket();
        await mirror.ConnectAsync(
            new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri,
            CancellationToken.None);
        _ = await ReadWsMessageAsync(mirror); // the anonymous connect session

        var reply = await SendJoinAsync(mirror, "browser:req:join-boom", "Zed");
        Expect(reply.GetProperty("type").GetString() == "session", "a faulted join still answers on the session channel");
        Expect(reply.GetProperty("joinRejection").GetString() == "join-failed", "the throw is converted into a rejection the client handles terminally");
        Expect(reply.GetProperty("joinRejectionDetail").GetString() == "The game could not complete the join. Try again.",
            "the viewer receives a retryable explanation without internal exception details");
        Expect(!reply.GetRawText().Contains(faultText, StringComparison.Ordinal), "join exception details stay in local logs");
        Expect(!reply.TryGetProperty("headlessMirrorPort", out _), "a faulted join hands out no port");
        Expect(!reply.TryGetProperty("directView", out _), "…and does not silently downgrade to watching the host");
        Expect(!reply.GetProperty("session").GetProperty("joined").GetBoolean(), "…and never reports itself joined");

        // The socket SURVIVES, and the RETRY fails the same way. Both halves matter:
        //   * the connection must outlive the fault — the viewer is sent back to a picker rendered from this very
        //     session stream, and is about to tap again;
        //   * the retry must not be handed a port. A faulted launch used to leave the session BOUND to the slot it
        //     had just failed to start (the binding is made before the launch, and only the null-return path undid
        //     it), so the second attempt short-circuited to "you are already on port N" — a port with nothing
        //     listening, i.e. a dead redirect that is strictly worse than the honest failure it retried.
        var retry = await SendJoinAsync(mirror, "browser:req:join-boom-2", "Zed");
        Expect(retry.GetProperty("joinRejection").GetString() == "join-failed", "a retry after a fault fails again, honestly");
        Expect(!retry.TryGetProperty("headlessMirrorPort", out _), "…and is never redirected to the slot the failed launch had bound");

        await CloseWebSocketSilentlyAsync(mirror);
    }

    private static void AssertRuntimeHostCallsCapabilitiesFirst()
    {
        AssertRuntimeCallOrder(host => host.GetCurrentState(new CurrentStateRequest()), "GetCurrentState");
        AssertRuntimeCallOrder(host => host.GetModels(new ModelCatalogRequestSnapshot("characters", ["ironclad"])), "GetModels");
        AssertRuntimeCallOrder(host => host.ExecuteAction(new EmbeddableActionRequest("request:test", SemanticActionKind.EndTurn)), "ExecuteAction");
        AssertRuntimeCallOrder(host => host.Assets.GetAsset(new EmbeddableAssetRequest("asset:key")), "Assets.GetAsset");
    }

    private static void AssertRuntimeCallOrder(Action<CouchCoopRuntimeHost> invoke, string expectedCall)
    {
        var fake = new RecordingSpirectlRuntime();
        var logs = new List<string>();
        var host = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(fake, fake, fake, fake, fake, fake, fake, fake, fake, fake), logs.Add);

        invoke(host);

        Expect(fake.Calls.Count >= 2, $"{expectedCall} records capability discovery and downstream call");
        Expect(fake.Calls[0] == "GetCapabilities", $"{expectedCall} observes capabilities first");
        Expect(fake.Calls[1] == expectedCall, $"{expectedCall} invokes downstream runtime second");
        Expect(fake.Calls.Count(call => call == "GetCapabilities") == 1, $"{expectedCall} caches capabilities");
    }

    // WS-PARTICLE: a `.tres` request under the raster format must return PNG magic bytes, not `[gd_` text. The
    // recording runtime emulates spirectl's format contract for `.tres` keys (format "png" → cropped-region PNG
    // bytes, structure-family formats → the raw `[gd_resource]` text — the real routing is covered by spirectl's
    // own suites); this asserts the ADAPTER maps CouchCoopResourceFormat.Png to the embeddable "png" ask and
    // passes the raster bytes through untouched.
    private static async Task AssertRasterResourceFormatAsync()
    {
        var runtime = new RecordingSpirectlRuntime();
        var adapter = new SpirectlAssetHttpAdapter(runtime.Assets, new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));
        const string tresKey = "res://images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres";

        var raster = await adapter.TryGetAssetAsync(tresKey, CouchCoopResourceFormat.Png);
        Expect(runtime.LastAssetRequest?.Format == "png", "a Png-format .tres request reaches the embeddable seam as format=png");
        Expect(raster.Error is null && raster.Bytes is { Length: >= 8 }, "raster .tres request returns bytes");
        Expect(raster.Bytes![0] == 0x89 && raster.Bytes[1] == (byte)'P' && raster.Bytes[2] == (byte)'N' && raster.Bytes[3] == (byte)'G',
            "raster .tres request returns PNG magic bytes");
        Expect(raster.ContentType == "image/png", "raster .tres request carries the image/png content type");

        var raw = await adapter.TryGetAssetAsync(tresKey, CouchCoopResourceFormat.Raw);
        Expect(runtime.LastAssetRequest?.Format == "raw", "a Raw-format .tres request reaches the embeddable seam as format=raw");
        Expect(raw.Bytes is not null && Encoding.UTF8.GetString(raw.Bytes).StartsWith("[gd_", StringComparison.Ordinal),
            "raw .tres request still returns the [gd_resource] text (Godot-native-first default unchanged)");
    }

    private static async Task AssertSpirectlAssetAdapterAsync()
    {
        var runtime = new RecordingSpirectlRuntime();
        var adapter = new SpirectlAssetHttpAdapter(runtime.Assets, new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));

        var asset = await adapter.TryGetAssetAsync("asset:key%2Fopaque");
        Expect(asset.Error is null, "spirectl asset adapter succeeds when runtime returns bytes");
        Expect(asset.ContentType == "image/webp", "spirectl asset adapter forwards payload content type");
        Expect(asset.Bytes is [9, 8, 7], "spirectl asset adapter forwards payload bytes");
        Expect(runtime.LastAssetRequest?.Key == "asset:key%2Fopaque", "spirectl asset adapter preserves asset key");
        Expect(runtime.LastAssetRequest?.RequestId == "http-asset", "spirectl asset adapter preserves request id");

        // model:// is texture ART: request a raster format so scene-backed art (e.g. a character's
        // spine-still background) renders to PNG instead of GodotSceneState JSON (which the renderer
        // can't paint). res:// defaults to "raw" (Godot-native-first): the native client re-hydrates the
        // game's own .tscn/.tres/PNG bytes; consumers that need a raster request ?format=png explicitly.
        await adapter.TryGetAssetAsync("model://characters/ironclad/characterSelectBgSpineStill");
        Expect(runtime.LastAssetRequest?.Format == "png", "model:// art is requested as a rendered PNG");
        await adapter.TryGetAssetAsync("res://scenes/screens/character_select_screen.tscn");
        Expect(runtime.LastAssetRequest?.Format == "raw", "res:// keys default to raw (Godot-native-first)");

        var missing = await adapter.TryGetAssetAsync("missing:key");
        Expect(missing.Error?.Code == "missing-asset", "spirectl asset adapter forwards missing asset code");
        Expect(missing.Error?.Notices?.Count == 1, "spirectl asset adapter exposes asset error notices");

        var unsupportedRuntime = new RecordingSpirectlRuntime { AssetExtractionSupported = false };
        var unsupported = await new SpirectlAssetHttpAdapter(unsupportedRuntime.Assets, new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(unsupportedRuntime, unsupportedRuntime, unsupportedRuntime, unsupportedRuntime, unsupportedRuntime, unsupportedRuntime, unsupportedRuntime, unsupportedRuntime, unsupportedRuntime, unsupportedRuntime))).TryGetAssetAsync("asset:key");
        Expect(unsupported.Error?.Code == CouchCoopRuntimeHost.AssetExtractionCapability, "unsupported asset capability is structured");
        Expect(unsupported.Error?.Notices?.Count > 0, "unsupported asset capability exposes runtime notices");
    }

    private static async Task HotReloadProtocolAssertions()
    {
        using var hotReloadRoot = new TempHotReloadRoot();
        CouchCoopHotReloadProtocol.Initialize(hotReloadRoot.Path);

        var accepted = await RequestHotReloadAsync(hotReloadRoot.ArtifactPath, expectedContractVersion: 1);
        Expect(accepted.GetProperty("accepted").GetBoolean(), "hot reload accepts valid layout artifact");
        var acceptedStatus = accepted.GetProperty("status");
        var activeGeneration = acceptedStatus.GetProperty("activeGeneration").GetUInt32();
        Expect(activeGeneration > 0, "hot reload reports active generation after valid load");
        Expect(accepted.GetProperty("report").GetProperty("status").GetString() == "loaded", "hot reload reports loaded status");
        Expect(accepted.GetProperty("report").GetProperty("previousGeneration").ValueKind == JsonValueKind.Number, "loaded report exposes previous generation");
        Expect(!accepted.GetProperty("report").GetProperty("previousRemainsActive").GetBoolean(), "loaded report marks previous generation inactive");
        Expect(accepted.GetProperty("report").GetProperty("previousDisposed").GetBoolean(), "loaded report marks previous generation disposed");
        Expect(accepted.GetProperty("report").GetProperty("previousUnloadRequested").GetBoolean(), "loaded report marks previous unload requested");
        Expect(accepted.GetProperty("report").GetProperty("previousCollected").GetBoolean(), "loaded report marks previous generation collected");

        var activeLayout = CouchCoopHotReloadProtocol.GetOverlayLayoutJson();
        using (var statusDocument = JsonDocument.Parse(CouchCoopHotReloadProtocol.DescribeSpirectlHotReloadStatusJson()))
        {
            var status = statusDocument.RootElement;
            Expect(status.GetProperty("activeGeneration").GetUInt32() == activeGeneration, "status JSON exposes active generation");
            Expect(status.GetProperty("lastReloadReport").GetProperty("status").GetString() == "loaded", "status JSON exposes last reload report");
            Expect(!status.GetProperty("restartRequired").GetBoolean(), "status JSON exposes shell restart-required flag");
            Expect(status.GetProperty("lastReloadReport").TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Null, "successful status report exposes null error");
        }

        var rejected = await CouchCoopHotReloadProtocol.RequestSpirectlHotReloadJsonAsync("{");
        using (var rejectedDocument = JsonDocument.Parse(rejected))
        {
            var root = rejectedDocument.RootElement;
            Expect(!root.GetProperty("accepted").GetBoolean(), "invalid hot reload request is rejected");
            Expect(root.GetProperty("notices")[0].GetProperty("code").GetString() == "hot-reload-request-invalid", "invalid hot reload request uses structured notice code");
            var rejectedReport = root.GetProperty("report");
            Expect(rejectedReport.GetProperty("status").GetString() == "failed", "invalid hot reload request includes failed report");
            Expect(rejectedReport.GetProperty("previousGeneration").GetUInt32() == activeGeneration, "invalid request report preserves previous generation");
            Expect(rejectedReport.GetProperty("previousRemainsActive").GetBoolean(), "invalid request keeps previous generation active");
            Expect(!rejectedReport.GetProperty("previousDisposed").GetBoolean(), "invalid request does not dispose previous generation");
            Expect(!rejectedReport.GetProperty("previousUnloadRequested").GetBoolean(), "invalid request does not request previous unload");
            Expect(!rejectedReport.GetProperty("previousCollected").GetBoolean(), "invalid request does not collect previous generation");
            Expect(!rejectedReport.GetProperty("error").GetProperty("restartRequired").GetBoolean(), "invalid request does not require restart");
        }

        var missingPath = Path.Combine(hotReloadRoot.Path, "hot-reload", "missing.dll");
        var missing = await RequestHotReloadAsync(missingPath, expectedContractVersion: 1);
        Expect(!missing.GetProperty("accepted").GetBoolean(), "missing hot reload artifact fails structurally");
        var missingReport = missing.GetProperty("report");
        Expect(missingReport.GetProperty("status").GetString() == "failed", "missing artifact report is failed");
        Expect(missingReport.GetProperty("previousGeneration").GetUInt32() == activeGeneration, "missing artifact report preserves previous generation");
        Expect(missingReport.GetProperty("previousRemainsActive").GetBoolean(), "missing artifact keeps previous generation active");
        Expect(!missingReport.GetProperty("previousDisposed").GetBoolean(), "missing artifact does not dispose previous generation");
        Expect(!missingReport.GetProperty("previousUnloadRequested").GetBoolean(), "missing artifact does not request previous unload");
        Expect(!missingReport.GetProperty("previousCollected").GetBoolean(), "missing artifact does not collect previous generation");
        Expect(!missingReport.GetProperty("error").GetProperty("restartRequired").GetBoolean(), "missing artifact does not require restart");
        Expect(missing.GetProperty("status").GetProperty("activeGeneration").GetUInt32() == activeGeneration, "failed missing reload preserves active status generation");
        Expect(CouchCoopHotReloadProtocol.GetOverlayLayoutJson() == activeLayout, "failed missing reload preserves active overlay layout");

        var mismatch = await RequestHotReloadAsync(hotReloadRoot.ArtifactPath, expectedContractVersion: 999);
        Expect(!mismatch.GetProperty("accepted").GetBoolean(), "contract-version mismatch fails structurally");
        var mismatchError = mismatch.GetProperty("report").GetProperty("error");
        Expect(mismatchError.GetProperty("code").GetString() == "reload_contract_version_mismatch", "contract-version mismatch is structured");
        Expect(mismatchError.GetProperty("restartRequired").GetBoolean(), "contract-version mismatch requires restart");
        Expect(mismatch.GetProperty("status").GetProperty("restartRequired").GetBoolean(), "contract-version mismatch surfaces restart-required status");
        Expect(mismatch.GetProperty("status").GetProperty("activeGeneration").GetUInt32() == activeGeneration, "contract mismatch preserves active generation");
        Expect(CouchCoopHotReloadProtocol.GetOverlayLayoutJson() == activeLayout, "contract mismatch preserves active overlay layout");

        var legacyWildcard = await RequestHotReloadAsync(hotReloadRoot.ArtifactPath, expectedContractVersion: 0);
        Expect(!legacyWildcard.GetProperty("accepted").GetBoolean(), "contract-version zero is rejected rather than treated as a wildcard");
        Expect(
            legacyWildcard.GetProperty("report").GetProperty("error").GetProperty("code").GetString()
                == "reload_contract_version_mismatch",
            "contract-version zero rejection is structured");

        OverlayLayoutValidationAssertions(activeLayout);
    }

    private static void OverlayLayoutValidationAssertions(string activeLayout)
    {
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(activeLayout) is null, "the shipped overlay layout passes shell validation");

        using (var layoutDocument = JsonDocument.Parse(activeLayout))
        {
            var layout = layoutDocument.RootElement;
            foreach (var field in new[]
            {
                "left", "top", "right", "bottom", "qrDialogExtent", "quietZoneModules", "titleFontScale",
                "urlFontScale", "buttonFontScale",
                "panelPadding", "panelCornerRadius", "panelBorderWidth", "panelColor", "panelBorderColor"
            })
            {
                Expect(layout.TryGetProperty(field, out _), $"overlay layout exposes {field}");
            }

            Expect(layout.GetProperty("right").GetSingle() > layout.GetProperty("left").GetSingle(), "overlay layout rect has positive width");
            Expect(layout.GetProperty("bottom").GetSingle() > layout.GetProperty("top").GetSingle(), "overlay layout rect has positive height");
            Expect(layout.GetProperty("quietZoneModules").GetInt32() == 0, "overlay layout adds no quiet zone on top of QRCoder's embedded one");
            Expect(layout.GetProperty("panelPadding").GetSingle() > 0f, "overlay layout insets the dialog card's content");

            AssertShippedRectClearsLobbyUi(layout);
        }

        // The lobby's lower-left gap, measured from the live NCharacterSelectScreen node rects in
        // 1920x1080 design space. Every neighbour is a painted-descendant union that includes the
        // currently-hidden children (left ascension arrow, ready-and-waiting panel, unready button),
        // so the shipped rect stays clear in every lobby state rather than just the solo idle one.
        // The rect is now the QR BUTTON rather than the old always-on overlay, and it is SHORTER
        // (bottom 1072 -> 868) — so it clears strictly more than it used to, including the character
        // card row it previously only just missed horizontally.
        static void AssertShippedRectClearsLobbyUi(JsonElement layout)
        {
            var left = layout.GetProperty("left").GetSingle();
            var top = layout.GetProperty("top").GetSingle();
            var right = layout.GetProperty("right").GetSingle();
            var bottom = layout.GetProperty("bottom").GetSingle();

            foreach (var (name, x0, y0, x1, y1) in new[]
            {
                ("character info panel", 209f, 321f, 909f, 723f),
                ("ascension strip", 586f, 738f, 1326f, 874f),
                ("character card row", 619f, 870.6f, 1302f, 1025.4f),
                ("back button", -64f, 710f, 218f, 875f),
                ("unready button", -244f, 710f, 38f, 875f),
                ("confirm button", 1704f, 710f, 1986f, 875f),
                ("player list", 36f, 44f, 465f, 145.8f),
                ("ready-and-waiting panel", 592f, 885f, 1328f, 1007f)
            })
            {
                var overlaps = left < x1 && x0 < right && top < y1 && y0 < bottom;
                Expect(!overlaps, $"the shipped overlay rect stays clear of the lobby {name}");
            }

            Expect(right <= 1920f && bottom <= 1080f, "the shipped overlay rect stays inside the design viewport");
        }

        static string Layout(
            float left = 226f,
            float top = 732f,
            float right = 578f,
            float bottom = 868f,
            float qrDialogExtent = 620f,
            int quietZoneModules = 0,
            float titleFontScale = 1.75f,
            float urlFontScale = 1.375f,
            float buttonFontScale = 1.75f,
            float panelPadding = 24f,
            float panelCornerRadius = 16f,
            float panelBorderWidth = 3f,
            string panelColor = "#0e1117f7",
            string panelBorderColor = "#ffffff33")
            => JsonSerializer.Serialize(new
            {
                left,
                top,
                right,
                bottom,
                qrDialogExtent,
                quietZoneModules,
                titleFontScale,
                urlFontScale,
                buttonFontScale,
                panelPadding,
                panelCornerRadius,
                panelBorderWidth,
                panelColor,
                panelBorderColor
            }, BrowserJson.Options);

        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout()) is null, "a well-formed overlay layout is accepted");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout("{") is not null, "malformed overlay layout JSON is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout("null") is not null, "null overlay layout JSON is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout("{}") is not null, "an empty overlay layout rect is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(left: -1f)) is not null, "a negative overlay rect origin is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(top: -1f)) is not null, "a negative overlay rect top is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(right: 100f)) is not null, "an inverted overlay rect width is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(bottom: 400f)) is not null, "an inverted overlay rect height is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(right: 99999f)) is not null, "an out-of-range overlay rect is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(qrDialogExtent: 0f)) is not null, "a non-positive QR dialog extent is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(qrDialogExtent: 40f)) is not null, "a QR dialog extent below one 1:1 version-1 code is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(buttonFontScale: 0f)) is not null, "a zero button font scale is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(buttonFontScale: 1000f)) is not null, "an absurd button font scale is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(quietZoneModules: -1)) is not null, "a negative quiet zone is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(quietZoneModules: 1000)) is not null, "an absurd quiet zone is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(titleFontScale: 0f)) is not null, "a zero title font scale is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(urlFontScale: -2f)) is not null, "a negative URL font scale is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(titleFontScale: 1000f)) is not null, "an absurd title font scale is rejected");
        // The rect is the BUTTON now, so the fit question is whether its own caption fits inside it —
        // a clipped caption on the only entry point to the join flow is worse than a rejected reload.
        Expect(
            CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(top: 0f, bottom: 30f, buttonFontScale: 3f)) is not null,
            "a button too short for its scaled label line is rejected");
        Expect(
            CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(panelPadding: 600f)) is not null,
            "padding that swallows the dialog card's content column is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(panelPadding: -1f)) is not null, "negative panel padding is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(panelCornerRadius: -1f)) is not null, "a negative panel corner radius is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(panelBorderWidth: -1f)) is not null, "a negative panel border width is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(panelColor: "not-a-colour")) is not null, "a malformed panel colour is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(panelBorderColor: "#12345")) is not null, "a wrong-length panel border colour is rejected");
        Expect(CouchCoopHotReloadProtocol.ValidateOverlayLayout(Layout(panelColor: "0e1117eb")) is null, "a panel colour without the leading hash is accepted");
    }

    private static async Task<JsonElement> RequestHotReloadAsync(string artifactPath, int expectedContractVersion)
    {
        var request = JsonSerializer.Serialize(new
        {
            requestId = "test-reload",
            projectId = "couchcoop",
            shellModId = "couchcoop",
            logicArtifactPath = artifactPath,
            expectedContractVersion,
            waitForCompletion = true,
            timeoutMs = 5000
        }, BrowserJson.Options);
        using var document = JsonDocument.Parse(await CouchCoopHotReloadProtocol.RequestSpirectlHotReloadJsonAsync(request));
        return document.RootElement.Clone();
    }

    private static async Task AssertPortFallbackAsync(string rootPath)
    {
        var occupied = new TcpListener(IPAddress.Loopback, 0);
        occupied.Start();
        var preferred = ((IPEndPoint)occupied.LocalEndpoint).Port;
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(rootPath),
            new CapturingAssetAdapter(),
            new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime()))),
            preferredPort: preferred);
        var baseUri = await server.StartAsync();
        Expect(baseUri.Port > preferred, "server advances when preferred port is unavailable");
        await server.StopAsync();
        occupied.Stop();
    }

    /// <summary>Every line currently on the host connectivity panel, oldest first.</summary>
    private static List<string> ActivityNarration()
        => CouchCoopActivityLog.Snapshot().Select(entry => entry.Message).ToList();

    private static async Task AssertHostUiServicesAsync(string rootPath)
    {
        var logs = new List<string>();
        var preferred = ReserveEphemeralPort();
        // F1: the SERVER channel of the host connectivity log (B1/B3/B6). Asserted by CONTAINMENT rather
        // than as an exact sequence — the secure-origin leg is a detached task that may add its own B4/B5
        // line at an unpredictable moment, and pinning the order here would make this suite flaky on a
        // machine with a different network shape.
        CouchCoopActivityLog.Reset();
        Uri? advertised = null;
        await using (var services = new CouchCoopHostUiServices(
                         new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime()), logs.Add),
                         rootPath,
                         IPAddress.Loopback,
                         preferredPort: preferred,
                         logs.Add))
        {
            var snapshot = await services.StartAsync();
            advertised = snapshot.JoinBaseUri;
            Expect(snapshot.Available, "host UI service reports available server");
            Expect(snapshot.JoinBaseUri is not null, "host UI service reports join base URI");
            Expect(snapshot.ListenerBaseUri is not null, "host UI service preserves listener base URI");
            Expect(snapshot.JoinBaseUri!.Host == "127.0.0.1", "host UI service advertises loopback test host");
            Expect(snapshot.JoinBaseUri.Query == string.Empty, "host UI join base URI omits name query");
            Expect(snapshot.JoinBaseUri.AbsolutePath == "/", "host UI join base URI is unaffiliated root");
            Expect(logs.Any(log => log.Contains("browser server available", StringComparison.Ordinal)
                                   && log.Contains(snapshot.JoinBaseUri.ToString(), StringComparison.Ordinal)
                                   && !log.Contains("?name=", StringComparison.Ordinal)), "host UI service logs selected URL without name query");
        }

        var startedNarration = ActivityNarration();
        Expect(
            startedNarration.Contains($"Phone connection ready — {advertised}"),
            "B1: the activity panel carries the ADVERTISED join URL — the string a host reads out to somebody typing it into a phone, never the wildcard the listener bound");
        Expect(
            startedNarration.Contains("Phone connection stopped."),
            "B6: disposing a RUNNING server reports that phones can no longer reach it");

        CouchCoopActivityLog.Reset();
        var failureLogs = new List<string>();
        await using var unavailable = new CouchCoopHostUiServices(
            new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime()), failureLogs.Add),
            rootPath,
            IPAddress.Loopback,
            preferredPort: ushort.MaxValue + 1,
            failureLogs.Add);
        var failed = await unavailable.StartAsync();
        Expect(!failed.Available, "host UI service reports unavailable server after startup failure");
        Expect(failed.JoinBaseUri is null, "host UI service omits join URI when startup fails");
        Expect(failed.Diagnostics.Any(diagnostic => diagnostic.Code == CouchCoopHostUiServices.BrowserServerUnavailableCode), "host UI service records structured startup diagnostic");
        Expect(failureLogs.Any(log => log.Contains(CouchCoopHostUiServices.BrowserServerUnavailableCode, StringComparison.Ordinal)), "host UI service logs diagnostic code");

        var failedNarration = ActivityNarration();
        Expect(
            failedNarration.Contains("Couldn't start the phone connection service."),
            "B3: THE event the activity panel exists for — and the reason its gate is IsHostLobby rather than ShouldShow, since a host with no listener has no QR panel either");
        Expect(
            !failedNarration.Contains("Phone connection stopped."),
            "a server that never bound must not also report STOPPING — the unwind path runs DisposeBrowserServerAsync, so this is gated on IsRunning, not on non-null");
    }

    private static async Task AssertHotReloadableServerHostSwapAsync(string rootPath)
    {
        var preferred = ReserveEphemeralPort();
        // F1: a hot-reload GENERATION SWAP is not a restart. The listener, the port and every open socket
        // survive it, so nothing in this class may write to the host connectivity log — a host in a lobby
        // would otherwise be told their phones had dropped when nothing happened. Pinned as "the log's
        // revision does not move", which catches any future emission anywhere on this path.
        CouchCoopActivityLog.Reset();
        var sequenceBefore = CouchCoopActivityLog.NewestSequence;

        await using (var host = new HotReloadableBrowserServerHost(
            new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime())),
            rootPath,
            IPAddress.Loopback,
            preferred))
        {
            var baseUri = await host.StartAsync();
            var builtInResponse = await GetAsync(baseUri, "/");
            Expect(builtInResponse.Body.Contains("spa-index", StringComparison.Ordinal), "hot server host serves built-in generation before hot reload");

            var first = new TestHotGeneration("generation-one");
            await host.ReplaceGenerationAsync(first, 1);
            var firstResponse = await GetAsync(baseUri, "/");
            Expect(firstResponse.Body.Contains("generation-one", StringComparison.Ordinal), "hot server host dispatches to active generation");

            var second = new TestHotGeneration("generation-two");
            await host.ReplaceGenerationAsync(second, 2);
            Expect(host.BaseUri == baseUri, "hot server host preserves listener URI across generation swap");
            Expect(first.StopCount == 1, "hot server host stops previous generation during swap");
            var secondResponse = await GetAsync(baseUri, "/");
            Expect(secondResponse.Body.Contains("generation-two", StringComparison.Ordinal), "hot server host dispatches to swapped generation");
        }

        Expect(
            CouchCoopActivityLog.NewestSequence == sequenceBefore,
            "a generation swap (and the host's own start/dispose) writes NOTHING to the host connectivity log");
    }

    /// <summary>
    /// F1: the VIEWER channel of the host connectivity log (V1/V5), over real sockets.
    /// </summary>
    /// <remarks>
    /// The curation is the point, not the logging. `/ws` is opened by every page load — before anyone has
    /// typed a name, on every refresh, on every reconnect — so an anonymous socket that merely comes and
    /// goes must leave the panel untouched. Only a connection that ANNOUNCED itself may announce its
    /// departure.
    /// </remarks>
    private static async Task AssertActivityViewerNarrationAsync(string rootPath)
    {
        var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.Lobby, LobbyNetGameType = "host" };
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(rootPath),
            new CapturingAssetAdapter(),
            new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime))),
            preferredPort: ReserveEphemeralPort());
        var baseUri = await server.StartAsync();

        // 1. An ANONYMOUS connection, opened and closed without ever joining: zero entries.
        CouchCoopActivityLog.Reset();
        using (var anonymous = new ClientWebSocket())
        {
            await anonymous.ConnectAsync(
                new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri,
                CancellationToken.None);
            _ = await ReadWsMessageAsync(anonymous); // the anonymous connect session
            await CloseWebSocketSilentlyAsync(anonymous);
        }

        // The teardown is asynchronous (the client's CloseAsync returns on the server's ACK, before the
        // receive loop's finally runs), so give it a window in which it COULD have written something.
        await Task.Delay(300);
        Expect(
            CouchCoopActivityLog.Count == 0,
            "an anonymous page load that comes and goes writes nothing to the panel — otherwise the log would be nothing but refreshes");

        // 2. A client that joins by name: announced on arrival, and again on departure. It picks the HOST's own
        //    seat ("Alice" is this lobby's host), which is the one join outcome that neither spawns nor rejects —
        //    the viewer watches the host's stream in place (V2).
        using (var named = new ClientWebSocket())
        {
            await named.ConnectAsync(new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri, CancellationToken.None);
            _ = await DrainConnectAsync(named);
            _ = await SendJoinAsync(named, "browser:req:activity-join", "Alice");

            Expect(
                ActivityNarration().Contains("Alice connected — watching this screen."),
                "V2: a viewer granted DIRECT VIEW is announced as watching the host's own screen");
            Expect(
                CouchCoopActivityLog.Count == 1,
                "…and it is ONE line: the connect itself was anonymous and stayed silent");

            // A re-sent join must not repaint the panel — the announcement is latched per connection.
            _ = await SendJoinAsync(named, "browser:req:activity-join-again", "Alice");
            Expect(CouchCoopActivityLog.Count == 1, "a repeated join does not re-announce the same viewer");

            await CloseWebSocketSilentlyAsync(named);
        }

        Expect(
            await WaitForAsync(() => ActivityNarration().Contains("Alice's phone disconnected.")),
            "V5: a viewer who announced their arrival announces their departure");
        CouchCoopActivityLog.Reset();
        await server.StopAsync();
    }

    private static int ReserveEphemeralPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static async Task AssertInboundWebSocketLimitsAsync(Uri baseUri, RecordingSpirectlRuntime runtime)
    {
        static Uri WsUri(Uri origin) => new UriBuilder(origin)
        {
            Scheme = "ws",
            Path = "/ws",
            Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0"
        }.Uri;
        static async Task<WebSocketReceiveResult> ReadCloseAsync(ClientWebSocket socket)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var buffer = new byte[4096];
            while (true)
            {
                var result = await socket.ReceiveAsync(buffer, deadline.Token);
                if (result.MessageType == WebSocketMessageType.Close) return result;
            }
        }

        using (var binary = new ClientWebSocket())
        {
            await binary.ConnectAsync(WsUri(baseUri), CancellationToken.None);
            _ = await DrainConnectAsync(binary);
            await binary.SendAsync(new byte[] { 1, 2, 3 }, WebSocketMessageType.Binary,
                WebSocketMessageFlags.EndOfMessage, CancellationToken.None);
            var result = await ReadCloseAsync(binary);
            Expect(result.MessageType == WebSocketMessageType.Close
                && result.CloseStatus == WebSocketCloseStatus.InvalidMessageType,
                $"a binary message is rejected immediately with close 1003 (type={result.MessageType}, status={result.CloseStatus})");
        }

        using (var oversized = new ClientWebSocket())
        {
            await oversized.ConnectAsync(WsUri(baseUri), CancellationToken.None);
            _ = await DrainConnectAsync(oversized);
            var first = new byte[200 * 1024];
            var second = new byte[60 * 1024];
            await oversized.SendAsync(first, WebSocketMessageType.Text, WebSocketMessageFlags.None, CancellationToken.None);
            await oversized.SendAsync(second, WebSocketMessageType.Text, WebSocketMessageFlags.EndOfMessage, CancellationToken.None);
            var result = await ReadCloseAsync(oversized);
            Expect(result.MessageType == WebSocketMessageType.Close
                && result.CloseStatus == WebSocketCloseStatus.MessageTooBig,
                $"fragment accumulation over 256 KiB is rejected with close 1009 (type={result.MessageType}, status={result.CloseStatus})");
        }

        using (var oversizedInput = new ClientWebSocket())
        {
            await oversizedInput.ConnectAsync(WsUri(baseUri), CancellationToken.None);
            _ = await DrainConnectAsync(oversizedInput);
            var executeCount = runtime.Calls.Count(call => call == "ExecuteAction");
            var payload = JsonSerializer.Serialize(new
            {
                type = "input",
                requestId = "input:oversized",
                kind = "key",
                key = new string('x', CouchCoopWebSocketConnection.MaxInputMessageBytes)
            });
            await oversizedInput.SendAsync(Encoding.UTF8.GetBytes(payload), WebSocketMessageType.Text,
                WebSocketMessageFlags.EndOfMessage, CancellationToken.None);
            using var response = JsonDocument.Parse(await ReadCorrelatedReplyAsync(oversizedInput, "input:oversized"));
            Expect(response.RootElement.GetProperty("requestId").GetString() == "input:oversized"
                && response.RootElement.GetProperty("code").GetString() == CouchCoopWebSocketConnection.InvalidInputMessageCode,
                "an input envelope over 4 KiB is rejected with stable invalid-input-message");
            await Task.Delay(100);
            Expect(runtime.Calls.Count(call => call == "ExecuteAction") == executeCount,
                "an oversized input envelope never reaches runtime input injection");
            await CloseWebSocketSilentlyAsync(oversizedInput);
        }

        using var recovered = new ClientWebSocket();
        await recovered.ConnectAsync(WsUri(baseUri), CancellationToken.None);
        var session = await DrainConnectAsync(recovered);
        Expect(session.GetProperty("type").GetString() == "session",
            "a valid peer is admitted after rejected peers release their WebSocket slots");
        await CloseWebSocketSilentlyAsync(recovered);
    }

    // On connect the server sends exactly one `session` reply and nothing else.
    private static async Task<JsonElement> DrainConnectAsync(ClientWebSocket socket)
    {
        using var session = JsonDocument.Parse(await ReadWsMessageAsync(socket));
        return session.RootElement.Clone();
    }

    private static void AssertAnonymousConnectSession(JsonElement root)
    {
        Expect(root.GetProperty("type").GetString() == "session", "connect emits a one-time session reply");
        Expect(root.GetProperty("session").GetProperty("joined").GetBoolean() == false, "connect session is anonymous until an explicit join");
        Expect(root.GetProperty("session").GetProperty("connectionCount").GetInt32() == 0,
            "an anonymous session has no assigned-player connection count");
        Expect(root.GetProperty("capabilities").GetProperty("capabilities").GetArrayLength() >= 4, "session includes runtime capabilities");
        Expect(root.GetProperty("notices")[0].GetProperty("capabilityId").GetString() == CouchCoopRuntimeHost.StateCapability, "session includes structured notices");
        Expect(root.GetProperty("screen").GetProperty("kind").GetString() == "run", "session classifies the current screen");
        Expect(root.GetProperty("rewardAction").GetBoolean(), "session advertises element-addressed reward claims");
        Expect(!root.TryGetProperty("lobbyState", out _), "session message omits the redundant lobbyState re-encoding");
    }

    private static void AssertJoinedRunSession(JsonElement root)
    {
        Expect(root.GetProperty("type").GetString() == "session", "join emits an updated session reply");
        Expect(root.GetProperty("session").GetProperty("name").GetString() == "Alice", "session exposes trimmed public browser name");
        Expect(root.GetProperty("session").GetProperty("playerId").GetString() == "Alice", "session exposes assigned internal player id");
        Expect(root.GetProperty("screen").GetProperty("kind").GetString() == "run", "run state is classified");
        Expect(root.GetProperty("assignmentNotices")[0].GetProperty("code").GetString() == "host-in-run", "run state emits structured notice");
        Expect(root.GetProperty("players").EnumerateArray().Count(player => player.GetProperty("name").GetString() == "Alice") == 1, "duplicate public names are collapsed");
        Expect(root.GetProperty("players").EnumerateArray().Any(player => player.GetProperty("name").GetString() == "Bob" && player.GetProperty("disconnected").GetBoolean()), "uncontrolled run players are marked disconnected");
        var publicIdentityFields = new[]
        {
            root.GetProperty("session"),
            root.GetProperty("players")
        };
        Expect(!publicIdentityFields.Any(element => ContainsPublicIdentityField(element, "slot")), "session does not expose public slot fields");
        Expect(!publicIdentityFields.Any(element => ContainsPublicIdentityField(element, "peer")), "session does not expose public peer fields");
        Expect(!publicIdentityFields.Any(element => ContainsPublicIdentityField(element, "index")), "session does not expose public index fields");
    }

    // The live scene-tree mirror: one pushed delta reaches the mirror client as a `scene-delta` frame carrying
    // the node's live local transform and node-local box.
    private static async Task AssertSceneBroadcastAsync(Uri baseUri, RecordingSpirectlRuntime runtime)
    {
        runtime.Mode = RuntimeStateMode.MultiplayerRun;
        using var mirror = new ClientWebSocket();
        await mirror.ConnectAsync(new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri, CancellationToken.None);
        using (var mirrorSession = JsonDocument.Parse(await ReadWsMessageAsync(mirror)))
        {
            AssertAnonymousConnectSession(mirrorSession.RootElement);
        }

        Expect(await WaitForSceneSubscriptionAsync(runtime, active: true),
            "the scene observer is registered before the test publishes its first delta");
        runtime.PushSceneDelta(BuildSampleSceneDelta());

        using var mirrorScene = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(
            mirror,
            // Placement rides in the node's local `transform` (origin = position), not the dropped legacy `rect`.
            // Match defensively so any unrelated delta (e.g. an empty on-connect keyframe) is skipped, not thrown on.
            root => TryReadFirstUpsertOriginX(root) == 100));
        Expect(mirrorScene.RootElement.GetProperty("type").GetString() == "scene-delta", "the mirror client receives scene-delta frames");
        Expect(mirrorScene.RootElement.GetProperty("full").GetBoolean(), "the keyframe delta is flagged full");
        Expect(mirrorScene.RootElement.GetProperty("screenType").GetString() == "run", "the scene delta carries the live screen type");
        Expect(mirrorScene.RootElement.GetProperty("upserts").GetArrayLength() == 1, "the scene delta carries the live node upserts");
        var placement = mirrorScene.RootElement.GetProperty("upserts")[0];
        Expect(placement.GetProperty("transform").GetProperty("origin").GetProperty("x").GetDouble() == 100, "scene node carries its local transform origin for the mirror");
        Expect(placement.GetProperty("localRect").GetProperty("size").GetProperty("x").GetDouble() == 320, "scene node carries its node-local box size for the mirror");

        await CloseWebSocketSilentlyAsync(mirror);
    }

    // WS-B STREAM GATE, end to end against the real hosted server.
    //
    // Product rule: a viewer connecting to a host that is on a MULTIPLAYER screen (lobby / saved game / mp run)
    // must NOT have the host's game streamed — and therefore rendered — behind its join picker. The gate is per
    // connection and CLIENT-driven (only the client computes the join mode), so what the host owes is: honour
    // `?watch=0` from the very first byte, honour the live `watch` message both ways, re-seed correctly on
    // re-enable, and — the actual CPU win — stop the scene producer once no viewer is watching.
    //
    // Every "the gated socket received nothing" assertion below is made while a SECOND, watching mirror is being
    // served frames from the same broadcast, so it proves the per-connection predicate rather than an idle host.
    private static async Task AssertSceneStreamGateAsync(Uri baseUri, RecordingSpirectlRuntime runtime)
    {
        runtime.Mode = RuntimeStateMode.MultiplayerRun;

        // The previous suite's mirror socket is closing asynchronously; wait for its observer generation to end so
        // the accounting assertions below start from a known state.
        Expect(
            await WaitForSceneSubscriptionAsync(runtime, active: false),
            "the scene observer stops once the previous suite's last mirror client disconnects");

        // ---- 1. a GATED connection never starts the producer -----------------------------------------------
        using var gated = new ClientWebSocket();
        await gated.ConnectAsync(
            new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri,
            CancellationToken.None);
        using (var session = JsonDocument.Parse(await ReadWsMessageAsync(gated)))
        {
            AssertAnonymousConnectSession(session.RootElement);
        }

        await Task.Delay(150);
        Expect(
            !runtime.SceneSubscriptionActive,
            "a `watch=0` mirror connection does not start the scene observer (no producer walk while every viewer is on the picker)");

        // The orphaned observer from the previous generation still drives the server's fan-out, so this exercises
        // the real per-connection predicate rather than merely an absent producer.
        runtime.PushSceneDelta(BuildSampleSceneDelta());
        await AssertNoSceneDeltaAsync(gated, "a gated connection receives ZERO scene bytes");

        // ---- 2. an explicitly watching current-contract connection restarts it ------------------------------
        using var watcher = new ClientWebSocket();
        await watcher.ConnectAsync(
            new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri,
            CancellationToken.None);
        using (var session = JsonDocument.Parse(await ReadWsMessageAsync(watcher)))
        {
            AssertAnonymousConnectSession(session.RootElement);
        }

        Expect(
            await WaitForSceneSubscriptionAsync(runtime, active: true),
            "a mirror connection with `watch=1` streams and starts the scene observer");

        // A keyframe both clients' hosts can be measured against: node 1001 at originX 100.
        runtime.PushSceneDelta(BuildSampleSceneDelta());
        using (var frame = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(
            watcher, root => TryReadFirstUpsertOriginX(root) == 100)))
        {
            Expect(frame.RootElement.GetProperty("full").GetBoolean(), "the watching client receives the keyframe");
        }

        await AssertNoSceneDeltaAsync(
            gated,
            "the gated connection still receives nothing while the very same delta is served to a watching one");

        // ---- 3. `watch:on` re-seeds with a FRESH FULL keyframe ------------------------------------------------
        await SendWatchAsync(gated, true);
        using (var keyframe = JsonDocument.Parse(await ReadNextWsMessageOfTypeAsync(gated, "scene-delta")))
        {
            var root = keyframe.RootElement;
            Expect(root.GetProperty("full").GetBoolean(), "re-enabling the stream sends a FULL keyframe, not an incremental delta");
            Expect(TryReadFirstUpsertOriginX(root) == 100, "the re-enable keyframe carries the host's CURRENT retained scene");
            Expect(
                root.GetProperty("orderedIds").EnumerateArray().Select(id => id.GetString()).SequenceEqual(["1001"]),
                "the re-enable keyframe carries the whole draw order");
        }

        // ---- 4. the order baseline is reset: the first structural send after the gap is a FULL array ----------
        await SendSceneAckAsync(watcher);
        runtime.PushSceneDelta(BuildSampleSceneDelta(id: "1002", originX: 250, full: false, orderedIds: ["1001", "1002"]));
        using (var incremental = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(
            gated, root => TryReadFirstUpsertOriginX(root) == 250)))
        {
            var root = incremental.RootElement;
            Expect(!root.GetProperty("full").GetBoolean(), "the post-keyframe send is incremental");
            Expect(
                !root.TryGetProperty("orderPatch", out _),
                "no order PATCH after a gap — the pre-gap baseline was dropped, so there is nothing to diff against");
            Expect(
                root.GetProperty("orderedIds").EnumerateArray().Select(id => id.GetString()).SequenceEqual(["1001", "1002"]),
                "the first structural send after a gap ships the FULL order array (a patch here would scramble the client's tree)");
        }

        // ---- 5. `watch:off` stops the bytes again -------------------------------------------------------------
        await SendWatchAsync(gated, false);
        await Task.Delay(150);
        await SendSceneAckAsync(watcher);
        runtime.PushSceneDelta(BuildSampleSceneDelta(id: "1003", originX: 400, full: false, orderedIds: ["1001", "1002", "1003"]));
        using (var served = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(
            watcher, root => TryReadFirstUpsertOriginX(root) == 400)))
        {
            Expect(served.RootElement.GetProperty("type").GetString() == "scene-delta", "the watching client keeps streaming");
        }

        await AssertNoSceneDeltaAsync(gated, "gating back off stops the bytes again");
        Expect(runtime.SceneSubscriptionActive, "the producer stays up while ANY viewer is still watching");

        // ---- 6. a re-enable after a connection HAS streamed drops the pre-gap order baseline ------------------
        // Unlike step 4 (a first-ever enable, whose baseline is null anyway), this connection has already been sent
        // a structural delta — so an un-reset coalescer WOULD now diff the next order against a pre-gap array the
        // client no longer holds. That renders as a subtly scrambled tree rather than an obvious failure, which is
        // exactly why it is asserted on the wire and not only in the coalescer unit test.
        await SendWatchAsync(gated, true);
        using (var keyframe = JsonDocument.Parse(await ReadNextWsMessageOfTypeAsync(gated, "scene-delta")))
        {
            Expect(keyframe.RootElement.GetProperty("full").GetBoolean(), "re-enabling after a gap sends a FULL keyframe again");
            Expect(
                keyframe.RootElement.GetProperty("orderedIds").EnumerateArray().Select(id => id.GetString())
                    .SequenceEqual(["1001", "1002", "1003"]),
                "the second re-enable keyframe carries everything that changed while the connection was gated");
        }

        await SendSceneAckAsync(watcher);
        runtime.PushSceneDelta(BuildSampleSceneDelta(id: "1004", originX: 550, full: false, orderedIds: ["1001", "1002", "1003", "1004"]));
        using (var incremental = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(
            gated, root => TryReadFirstUpsertOriginX(root) == 550)))
        {
            var root = incremental.RootElement;
            Expect(
                !root.TryGetProperty("orderPatch", out _),
                "after a stream GAP the order baseline is dropped, so no patch is diffed against the pre-gap order");
            Expect(
                root.GetProperty("orderedIds").EnumerateArray().Select(id => id.GetString())
                    .SequenceEqual(["1001", "1002", "1003", "1004"]),
                "the first structural send after a gap ships the FULL order array");
        }

        // ---- 7. the STREAMING count — not the connection count — drives the producer ---------------------------
        await SendWatchAsync(gated, false);
        await CloseWebSocketSilentlyAsync(watcher);
        Expect(
            await WaitForSceneSubscriptionAsync(runtime, active: false),
            "the scene observer stops when the last WATCHING viewer leaves, even though a (gated) mirror client is still connected");

        await SendWatchAsync(gated, true);
        Expect(
            await WaitForSceneSubscriptionAsync(runtime, active: true),
            "a gate flip alone restarts the scene observer (the streaming count is maintained across flips, not just connects)");

        await CloseWebSocketSilentlyAsync(gated);
        Expect(
            await WaitForSceneSubscriptionAsync(runtime, active: false),
            "disconnecting a STREAMING connection gives its streaming count back (teardown reports the final gate state)");
    }

    // Stage-B walk skip: the UNANIMITY AGGREGATE end to end over real sockets — `?staticBg=1` parsed at accept,
    // the `settings` message's live flips, disconnect re-evaluation and the valve — observed through the server's
    // internal (streaming, needed, skipDesired) seam. The tracker side is deliberately Godot-less here: the
    // desired-skip verdict latches (WalkSkipUnanimityTests proves that separately) but nothing is stamped, so the
    // suite exercises exactly the couch aggregate; the stamp/walk semantics are spirectl's (Sts2StreamSkipMeta).
    private static async Task AssertStaticBgWalkSkipAggregateAsync(
        CouchCoopBrowserServer server,
        Uri baseUri,
        RecordingSpirectlRuntime runtime)
    {
        runtime.Mode = RuntimeStateMode.MultiplayerRun;

        // Start from a settled, viewer-less server (the previous suite's sockets close asynchronously).
        Expect(
            await WaitForBgSkipAsync(server, desired: false),
            "no streaming viewers ⇒ no skip (baseline)");
        Expect(
            await WaitForAsync(() => server.BgSkipStateForTest().StreamingMirrorConnections == 0),
            "the previous suite's viewers are gone before the aggregate is measured");

        // ---- 1. a SOLE streaming viewer declaring `?staticBg=1` engages the skip (accept-time parse) ---------
        using var staticViewer = new ClientWebSocket();
        await staticViewer.ConnectAsync(
            new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=1&staticBg=1&cardFlight=1&handTween=1&trailDrive=0" }.Uri,
            CancellationToken.None);
        using (var session = JsonDocument.Parse(await ReadWsMessageAsync(staticViewer)))
        {
            AssertAnonymousConnectSession(session.RootElement);
        }

        Expect(
            await WaitForBgSkipAsync(server, desired: true),
            "a sole streaming viewer with `?staticBg=1` reaches unanimity (the connect-query parse is live)");
        var engaged = server.BgSkipStateForTest();
        Expect(engaged.BgStreamNeeded == 0, "the declaring viewer is not counted as needing the subtree");
        Expect(engaged.StreamingMirrorConnections == 1, "exactly the one viewer streams");

        // ---- 2. a second viewer declaring staticBg=0 breaks unanimity ------------------
        using var liveViewer = new ClientWebSocket();
        await liveViewer.ConnectAsync(
            new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri,
            CancellationToken.None);
        using (var session = JsonDocument.Parse(await ReadWsMessageAsync(liveViewer)))
        {
            AssertAnonymousConnectSession(session.RootElement);
        }

        Expect(
            await WaitForBgSkipAsync(server, desired: false),
            "staticBg:false counts as needs-bg and disengages the skip");
        Expect(server.BgSkipStateForTest().BgStreamNeeded == 1, "exactly the live-bg viewer needs the subtree");

        // ---- 3. the live-bg viewer flips ON (`settings` message) ⇒ unanimous again ----------------------
        await SendStaticBgSettingsAsync(liveViewer, true);
        Expect(
            await WaitForBgSkipAsync(server, desired: true),
            "a live `settings staticBg:true` restores unanimity and re-engages the skip");

        // ---- 4. the fail-open push (`settings staticBg:false`) re-admits the subtree ------------------------
        await SendStaticBgSettingsAsync(liveViewer, false);
        Expect(
            await WaitForBgSkipAsync(server, desired: false),
            "a live `settings staticBg:false` (the client's fetch fail-open push) disengages the skip");

        // ---- 5. the needs-bg viewer disconnecting re-evaluates unanimity over the remainder -----------------
        await CloseWebSocketSilentlyAsync(liveViewer);
        Expect(
            await WaitForBgSkipAsync(server, desired: true),
            "the needs-bg viewer leaving restores unanimity for the remaining static viewer");

        // ---- 6. the LAST viewer disconnecting drops the skip (no streaming ⇒ no skip) -----------------------
        await CloseWebSocketSilentlyAsync(staticViewer);
        Expect(
            await WaitForBgSkipAsync(server, desired: false),
            "the last streaming viewer leaving disengages the skip (a fresh viewer never connects into a stamped tree)");
        Expect(
            await WaitForSceneSubscriptionAsync(runtime, active: false),
            "the scene observer also stops with the last viewer (the suite leaves the server settled)");
    }

    private static Task<bool> WaitForBgSkipAsync(CouchCoopBrowserServer server, bool desired, int timeoutMs = 5000)
        => WaitForAsync(() => server.BgSkipStateForTest().BgSkipDesired == desired, timeoutMs);

    private static async Task SendStaticBgSettingsAsync(ClientWebSocket socket, bool staticBg)
    {
        var bytes = Encoding.UTF8.GetBytes(
            $"{{\"type\":\"settings\",\"staticBg\":{(staticBg ? "true" : "false")}}}");
        await socket.SendAsync(bytes, WebSocketMessageType.Text, WebSocketMessageFlags.EndOfMessage, CancellationToken.None);
    }

    /// <summary>
    /// WS-B PREREQUISITE — `screen.mirrorMode` must stay LIVE on a MIRROR-ONLY host.
    /// <para>
    /// The gate is client-driven off the session's `screen.mirrorMode`, so if that value can never change the gate
    /// latches shut: a viewer that arrived while the host was on a multiplayer screen would sit on the picker
    /// forever, even after the host quit to the main menu. Session re-sends are driven from BroadcastState, and
    /// before this change the state observer only ran for STATEFUL clients — so on a host whose only clients are
    /// mirrors, an already-open picker went stale (a returning client never noticed, because it opens a fresh
    /// socket and gets fresh data on connect).
    /// </para>
    /// <para>
    /// Asserted on a DEDICATED server so there is provably no stateful connection propping the observer up.
    /// </para>
    /// </summary>
    private static async Task AssertMirrorOnlyHostKeepsSessionsLiveAsync(string rootPath)
    {
        var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.MultiplayerRun };
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(rootPath),
            new CapturingAssetAdapter(),
            new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime))),
            preferredPort: ReserveEphemeralPort());
        var baseUri = await server.StartAsync();

        Expect(!runtime.StateSubscriptionActive, "no clients → no state observer");

        // ONE mirror client, GATED (the join-picker case). No stateful client exists on this server at all.
        using var gated = new ClientWebSocket();
        await gated.ConnectAsync(
            new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri,
            CancellationToken.None);
        using (var session = JsonDocument.Parse(await ReadWsMessageAsync(gated)))
        {
            Expect(session.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "run", "the connect session reports the host's current screen");
        }

        Expect(
            await WaitForAsync(() => runtime.StateSubscriptionActive),
            "a GATED mirror connection keeps the state observer alive (the only source of session re-sends on a mirror-only host)");
        Expect(!runtime.SceneSubscriptionActive, "...while the expensive SCENE observer stays stopped");

        // The host leaves the run: the gated viewer must be TOLD, or its gate can never re-open.
        runtime.Mode = RuntimeStateMode.Lobby;
        runtime.PushState();
        using (var resent = JsonDocument.Parse(await ReadNextSessionWithScreenKindAsync(gated, "lobby")))
        {
            Expect(
                resent.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "lobby",
                "the host's screen change is pushed to the gated viewer as a fresh `session` (this is what un-latches the gate)");
        }

        await CloseWebSocketSilentlyAsync(gated);
        Expect(
            await WaitForAsync(() => !runtime.StateSubscriptionActive),
            "the state observer stops again once the last (gated) mirror client leaves");

        // The GATE IS THE WHOLE RULE. `GatedMirrorConnectionsLocked > 0` is now the observer's ONLY start
        // condition (the structured-client arm that used to be the other one is gone), so a viewer that is
        // WATCHING must not start it: a streaming viewer learns about a screen change from the scene stream
        // itself (ResendSessionsIfSceneScreenChanged), and paying for a second observer on top of the producer
        // walk is exactly what the gate exists to avoid.
        using (var streaming = new ClientWebSocket())
        {
            await streaming.ConnectAsync(
                new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri,
                CancellationToken.None);
            _ = await ReadWsMessageAsync(streaming); // the anonymous connect session
            Expect(
                await WaitForAsync(() => runtime.SceneSubscriptionActive),
                "a WATCHING mirror connection starts the scene observer");
            await Task.Delay(200);
            Expect(
                !runtime.StateSubscriptionActive,
                "…and does NOT start the state observer — only a GATED viewer does");
            await CloseWebSocketSilentlyAsync(streaming);
        }

        await server.StopAsync();
    }

    // Read until a `session` frame reporting the given screen kind (skipping any earlier re-send).
    private static async Task<string> ReadNextSessionWithScreenKindAsync(ClientWebSocket socket, string kind, int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0)
            {
                throw new TimeoutException($"Timed out waiting for a session with screen kind '{kind}'.");
            }

            var message = await ReadNextWsMessageOfTypeAsync(socket, "session", (int)Math.Min(remaining, int.MaxValue)).ConfigureAwait(false);
            using var document = JsonDocument.Parse(message);
            if (document.RootElement.GetProperty("screen").GetProperty("kind").GetString() == kind)
            {
                return message;
            }
        }
    }

    private static async Task<bool> WaitForAsync(Func<bool> condition, int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            if (condition())
            {
                return true;
            }

            await Task.Delay(25);
        }

        return condition();
    }

    /// <summary>
    /// Assert that NO `scene-delta` reaches this socket — the central WS-B invariant.
    /// <para>
    /// Deliberately not a timed-out read: cancelling <c>ClientWebSocket.ReceiveAsync</c> ABORTS the connection, so
    /// that technique can only ever be the last thing done to a socket. Instead: settle (anything the server meant
    /// to send is written by then), then fence with a `ping` and read up to the matching `pong`, failing on any
    /// `scene-delta` seen along the way. Unrelated frames (a re-sent `session`) are skipped, and the socket stays
    /// usable for the rest of the suite.
    /// </para>
    /// </summary>
    private static async Task AssertNoSceneDeltaAsync(ClientWebSocket socket, string label, int settleMs = 400)
    {
        await Task.Delay(settleMs);
        var fence = Environment.TickCount64 % 1_000_000;
        var ping = Encoding.UTF8.GetBytes($"{{\"type\":\"ping\",\"t0\":{fence}}}");
        await socket.SendAsync(ping, WebSocketMessageType.Text, WebSocketMessageFlags.EndOfMessage, CancellationToken.None);

        using var cancellationSource = new CancellationTokenSource(5000);
        while (true)
        {
            using var document = JsonDocument.Parse(await ReadWsMessageAsync(socket, cancellationSource.Token));
            var type = document.RootElement.GetProperty("type").GetString();
            Expect(type != "scene-delta", label);
            if (type == "pong")
            {
                return;
            }
        }
    }

    private static async Task SendWatchAsync(ClientWebSocket socket, bool on)
    {
        var bytes = Encoding.UTF8.GetBytes($"{{\"type\":\"watch\",\"on\":{(on ? "true" : "false")}}}");
        await socket.SendAsync(bytes, WebSocketMessageType.Text, WebSocketMessageFlags.EndOfMessage, CancellationToken.None);
    }

    private static async Task SendSceneAckAsync(ClientWebSocket socket)
    {
        var bytes = Encoding.UTF8.GetBytes("{\"type\":\"scene-ack\"}");
        await socket.SendAsync(bytes, WebSocketMessageType.Text, WebSocketMessageFlags.EndOfMessage, CancellationToken.None);
    }

    // Poll for the scene observer reaching the expected subscription state (connection teardown and gate flips are
    // both asynchronous on the server side).
    private static Task<bool> WaitForSceneSubscriptionAsync(
        RecordingSpirectlRuntime runtime,
        bool active,
        int timeoutMs = 5000)
        => WaitForAsync(() => runtime.SceneSubscriptionActive == active, timeoutMs);

    private static RuntimeSceneDelta BuildSampleSceneDelta()
    {
        var node = new RuntimeSceneNodeDelta(
            Id: "1001",
            ParentId: null,
            Name: "Card",
            NodeType: "NinePatchRect",
            // Legacy global `Rect` is no longer populated by the watcher and is dropped from the wire DTO; the
            // watcher now carries placement as the node's local `Transform` (origin = position) plus its
            // node-local `LocalRect` (size). Mirror that current contract so this exercises the real wire shape.
            Rect: null,
            Visible: true,
            Opacity: 1,
            ZIndex: 0,
            Rotation: 0,
            Texture: null,
            NinePatch: true,
            Text: null,
            Transform: new RuntimeSceneTransform2DSnapshot(
                new RuntimeSceneVector2Snapshot(1, 0),
                new RuntimeSceneVector2Snapshot(0, 1),
                new RuntimeSceneVector2Snapshot(100, 200)),
            LocalRect: new RuntimeSceneRect2Snapshot(
                new RuntimeSceneVector2Snapshot(0, 0),
                new RuntimeSceneVector2Snapshot(320, 480)));

        return new RuntimeSceneDelta(
            Full: true,
            ScreenType: "run",
            ScreenInstanceId: "instance-1",
            Upserts: [node],
            RemovedIds: [],
            OrderedIds: ["1001"],
            TransformSpace: "local");
    }

    // A variant of the sample delta for the WS-B gate suite: a distinct node id + originX (so a specific frame can
    // be matched on the wire) and an explicit draw order (so a structural send is produced). The screen
    // discriminator is deliberately IDENTICAL to BuildSampleSceneDelta's, so pushing these never trips the
    // scene-path session re-send and the suite reads only the frames it asked for.
    private static RuntimeSceneDelta BuildSampleSceneDelta(
        string id,
        double originX,
        bool full,
        IReadOnlyList<string> orderedIds)
    {
        var node = new RuntimeSceneNodeDelta(
            Id: id,
            ParentId: null,
            Name: "Card" + id,
            NodeType: "NinePatchRect",
            Rect: null,
            Visible: true,
            Opacity: 1,
            ZIndex: 0,
            Rotation: 0,
            Texture: null,
            NinePatch: true,
            Text: null,
            Transform: new RuntimeSceneTransform2DSnapshot(
                new RuntimeSceneVector2Snapshot(1, 0),
                new RuntimeSceneVector2Snapshot(0, 1),
                new RuntimeSceneVector2Snapshot((float)originX, 200)),
            LocalRect: new RuntimeSceneRect2Snapshot(
                new RuntimeSceneVector2Snapshot(0, 0),
                new RuntimeSceneVector2Snapshot(320, 480)));

        return new RuntimeSceneDelta(
            Full: full,
            ScreenType: "run",
            ScreenInstanceId: "instance-1",
            Upserts: [node],
            RemovedIds: [],
            OrderedIds: orderedIds,
            TransformSpace: "local");
    }

    private static bool ContainsPublicIdentityField(JsonElement element, string fragment)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (property.Name.Contains(fragment, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }

                if (ContainsPublicIdentityField(property.Value, fragment))
                {
                    return true;
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                if (ContainsPublicIdentityField(item, fragment))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static async Task AssertActionExecutionProbesAsync(ClientWebSocket ws, RecordingSpirectlRuntime runtime)
    {
        runtime.ResetActionProbe();
        var renderRef = await SendActionAsync(ws, new
        {
            type = "action",
            requestId = "browser:req:render",
            actionRefId = "render:end-turn",
            snapshotId = "snapshot:test",
            viewerId = "Alice",
            screenType = "combat"
        });
        Expect(renderRef.GetProperty("type").GetString() == "action-result", "render ref action returns result envelope");
        Expect(renderRef.GetProperty("requestId").GetString() == "browser:req:render", "render ref action preserves browser request id");
        Expect(renderRef.GetProperty("code").GetString() == BrowserActionErrorCodes.StaleActionRef, "render refs are rejected structurally in S9");

        // R11 WS-M — MAP TRAVEL FROM THE MIRROR. The mirror taps a map point it can only address by SCENE NODE
        // (`elementId`), and mirror actions always use the served process's local player, so two things must hold: the arg lands on
        // the NAMED ElementId field (spirectl's select-map-node validation reads MapNodeId-or-ElementId, not Values),
        // and the executor dispatches with the empty process-local perspective.
        runtime.ResetActionProbe();
        var mirrorTravelRequest = new BrowserActionRequestEnvelope(
            "action",
            "browser:req:map-node",
            SemanticActionId: "select-map-node",
            ScreenType: "run",
            Args: new Dictionary<string, JsonElement>
            {
                ["elementId"] = JsonSerializer.SerializeToElement("669410934510")
            });
        var mirrorTravel = await new BrowserActionExecutor(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime))).ExecuteAsync(
            mirrorTravelRequest);
        Expect(mirrorTravel.Code is null, "a mirror connection may act without a bound viewer id");
        Expect(runtime.LastActionRequest?.Kind == SemanticActionKind.SelectMapNode, "select-map-node resolves to the SelectMapNode kind");
        Expect(runtime.LastActionRequest?.ElementId == "669410934510", "select-map-node maps args.elementId onto the named ElementId");
        Expect(string.IsNullOrEmpty(runtime.LastActionRequest?.PlayerId), "a mirror action with no bound seat acts with an empty (process-local) perspective");

        // Exercise every tooling enum member through the real LAN WebSocket boundary. New members
        // default to denied, and both viewer fields are request data rather than authority.
        foreach (var kind in Enum.GetValues<SemanticActionKind>())
        {
            var token = System.Text.RegularExpressions.Regex.Replace(kind.ToString(), "([a-z0-9])([A-Z])", "$1-$2").ToLowerInvariant();
            runtime.ResetActionProbe();
            var reply = await SendActionAsync(ws, new
            {
                type = "action",
                requestId = "browser:req:allowlist:" + token,
                semanticActionId = token,
                viewerId = "forged-player",
                viewerPlayerId = "p:1002",
                args = new { elementId = "42", mapNodeId = "map-node:1:2", offsetY = -1800, playerId = "p:1003" }
            });
            if (kind is SemanticActionKind.SelectMapNode or SemanticActionKind.SetScrollOffset or SemanticActionKind.ClaimReward)
            {
                Expect(runtime.LastActionRequest?.Kind == kind, "the product action reaches the runtime: " + token);
                Expect(string.IsNullOrEmpty(runtime.LastActionRequest?.PlayerId), "a mirror action uses process-local identity: " + token);
                Expect(runtime.LastActionRequest?.Values?.ContainsKey("playerId") != true, "generic arguments cannot override player scope");
                Expect(runtime.LastActionRequest?.ElementId == "42", "element addressing remains available");
                Expect(reply.GetProperty("result").GetProperty("error").GetProperty("code").GetString() == BrowserActionErrorCodes.InternalFailure, "upstream failure retains a stable code");
                Expect(!reply.GetRawText().Contains("semantic upstream failure", StringComparison.Ordinal), "upstream diagnostic text stays off the wire");
                Expect(reply.GetProperty("result").GetProperty("error").GetProperty("message").GetString() == "The game could not complete the action.", "the browser receives a generic failure");
                if (kind == SemanticActionKind.SetScrollOffset)
                {
                    Expect(runtime.LastActionRequest?.Values?["offsetY"] == "-1800", "scroll offset survives the boundary");
                }
            }
            else
            {
                Expect(reply.GetProperty("code").GetString() == BrowserActionErrorCodes.DisabledAction, "tooling action is refused: " + token);
                Expect(runtime.LastActionRequest is null, "refused action never reaches runtime: " + token);
            }
        }

        foreach (var actionId in new[] { "action:p:1002:disconnect-client", "debug-start-run", "future-tool-action", "disconnect-client:select-map-node:x", "action:set-scroll-offset" })
        {
            runtime.ResetActionProbe();
            var reply = await SendActionAsync(ws, new { type = "action", requestId = "browser:req:forged", semanticActionId = actionId, viewerPlayerId = "p:1002" });
            Expect(reply.GetProperty("code").GetString() == BrowserActionErrorCodes.DisabledAction, "qualified, debug and unknown commands are refused");
            Expect(runtime.LastActionRequest is null, "an alternate action-id spelling cannot reach runtime");
        }

        var inputFailure = new BrowserInputExecutor(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime))).Execute(
            new BrowserInputRequestEnvelope("input", "input-private-error", BrowserInputKinds.Key, Key: "KeyA"));
        Expect(inputFailure?.Code == BrowserActionErrorCodes.InternalFailure
            && inputFailure.Message == "The game could not apply the input.",
            "raw input failures retain stable codes and keep runtime diagnostics off the wire");

        var executor = new BrowserActionExecutor(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime)));
        runtime.ResetActionProbe();
        await executor.ExecuteAsync(mirrorTravelRequest with { ViewerId = "forged", ViewerPlayerId = "p:1002" });
        Expect(string.IsNullOrEmpty(runtime.LastActionRequest?.PlayerId), "forged browser identity fields cannot override the process-local perspective");
    }

    private static async Task AssertSessionLifecycleProbesAsync(Uri baseUri, ClientWebSocket alicePrimary, RecordingSpirectlRuntime runtime)
    {
        using var aliceSecond = new ClientWebSocket();
        await aliceSecond.ConnectAsync(new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri, CancellationToken.None);
        await DrainConnectAsync(aliceSecond);
        var aliceSecondJoined = await SendJoinAsync(aliceSecond, "browser:req:join-alice-2", "Alice");
        Expect(aliceSecondJoined.GetProperty("session").GetProperty("connectionCount").GetInt32() == 2, "second socket increments same-name connection count");
        Expect(PlayerConnectionCount(aliceSecondJoined, "Alice") == 2, "same-name run player reports both sockets");

        using var bob = new ClientWebSocket();
        await bob.ConnectAsync(new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri, CancellationToken.None);
        await DrainConnectAsync(bob);
        var bobJoined = await SendJoinAsync(bob, "browser:req:join-bob", "Bob");
        Expect(bobJoined.GetProperty("session").GetProperty("name").GetString() == "Bob", "run picker can join an existing run player");
        Expect(PlayerConnectionCount(bobJoined, "Bob") == 1, "joining controlled run player does not require exclusive ownership");

        var semanticFallback = await SendActionAsync(alicePrimary, new
        {
            type = "action",
            requestId = "browser:req:fallback-viewer",
            semanticActionId = "select-map-node",
            args = new { elementId = "42" },
            screenType = "run"
        });
        Expect(semanticFallback.GetProperty("result").GetProperty("error").GetProperty("code").GetString() == BrowserActionErrorCodes.InternalFailure, "an allowed action reaches the runtime after joining");
        Expect(string.IsNullOrEmpty(runtime.LastActionRequest?.PlayerId), "mirror actions retain process-local scope after joining");

        await aliceSecond.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
        await alicePrimary.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
        await bob.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);

        // Roster is eventually consistent after a close (server teardown runs after the close ACK); wait for the
        // disconnects to land before the observing connect below reads the roster.
        await WaitForRosterAsync(baseUri, session => PlayerDisconnected(session, "Alice") && PlayerDisconnected(session, "Bob"));

        using var runObserver = new ClientWebSocket();
        await runObserver.ConnectAsync(new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri, CancellationToken.None);
        var runObserverSession = await DrainConnectAsync(runObserver);
        Expect(PlayerDisconnected(runObserverSession, "Alice"), "run player remains visible and disconnected after last socket closes");
        Expect(PlayerDisconnected(runObserverSession, "Bob"), "joined run player remains visible and disconnected after last socket closes");

        runtime.Mode = RuntimeStateMode.Lobby;
        var lobbyState = await SendJoinAsync(runObserver, "browser:req:join-charlie", "Charlie");
        Expect(lobbyState.GetProperty("session").GetProperty("name").GetString() == "Charlie", "new lobby name creates lobby-only identity");
        Expect(lobbyState.GetProperty("players").EnumerateArray().Any(player => player.GetProperty("name").GetString() == "Charlie"), "lobby-only identity appears while connected");
        await runObserver.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);

        // Same eventual consistency: wait for Charlie's lobby-only identity to be reaped after its last socket closes.
        await WaitForRosterAsync(baseUri, session => !session.GetProperty("players").EnumerateArray()
            .Any(player => player.GetProperty("name").GetString() == "Charlie"));

        using var lobbyObserver = new ClientWebSocket();
        await lobbyObserver.ConnectAsync(new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri, CancellationToken.None);
        var lobbyObserverSession = await DrainConnectAsync(lobbyObserver);
        Expect(!lobbyObserverSession.GetProperty("players").EnumerateArray().Any(player => player.GetProperty("name").GetString() == "Charlie"), "lobby-only identity is removed after last close");
        await lobbyObserver.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
    }

    private static async Task<JsonElement> SendJoinAsync(ClientWebSocket socket, string requestId, string name)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { type = "join", requestId, name }, BrowserJson.Options));
        await socket.SendAsync(bytes, WebSocketMessageType.Text, WebSocketMessageFlags.EndOfMessage, CancellationToken.None);
        // Every connection now streams the scene by default, and the state observer re-sends `session` envelopes
        // on roster changes, so both a `scene-delta` and an unsolicited `session` (requestId "session") can land
        // between the join request and its reply. Correlate on the REQUEST ID rather than assuming ordering.
        using var document = JsonDocument.Parse(await ReadCorrelatedReplyAsync(socket, requestId));
        return document.RootElement.Clone();
    }

    // A client's CloseAsync completes when the server's close ACK is received, which happens BEFORE the server's
    // receive-loop teardown (`finally`) runs DisconnectSession / LeaveLobbyPlayer. So the browser roster is only
    // eventually consistent after a socket closes: a fresh observer connecting immediately can still read the
    // departing player as connected (or a lobby-only identity as present). Poll fresh throwaway observers until the
    // roster settles to the expected shape, so the follow-up connect+assert reads a stable roster deterministically.
    private static async Task WaitForRosterAsync(Uri baseUri, Func<JsonElement, bool> settled, int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            using var probe = new ClientWebSocket();
            await probe.ConnectAsync(new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri, CancellationToken.None);
            var session = await DrainConnectAsync(probe);
            await CloseWebSocketSilentlyAsync(probe);

            bool ok;
            try
            {
                ok = settled(session);
            }
            catch (InvalidOperationException)
            {
                // A `.First(...)` roster lookup missed — the player isn't listed yet; treat as not-settled and retry.
                ok = false;
            }

            if (ok)
            {
                return;
            }

            if (Environment.TickCount64 >= deadline)
            {
                throw new TimeoutException("Timed out waiting for the browser roster to settle after a socket close.");
            }

            await Task.Delay(25);
        }
    }

    private static int PlayerConnectionCount(JsonElement state, string name)
        => state.GetProperty("players").EnumerateArray()
            .First(player => player.GetProperty("name").GetString() == name)
            .GetProperty("connectionCount").GetInt32();

    private static bool PlayerDisconnected(JsonElement state, string name)
        => state.GetProperty("players").EnumerateArray()
            .First(player => player.GetProperty("name").GetString() == name)
            .GetProperty("disconnected").GetBoolean();

    private static async Task<HttpProbeResponse> GetAsync(Uri baseUri, string path, params (string Name, string Value)[] extraHeaders)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, baseUri.Port);
        await using var stream = client.GetStream();
        var extra = string.Concat(extraHeaders.Select(header => $"{header.Name}: {header.Value}\r\n"));
        var request = Encoding.ASCII.GetBytes($"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{baseUri.Port}\r\n{extra}Connection: close\r\n\r\n");
        await stream.WriteAsync(request);

        using var memory = new MemoryStream();
        await stream.CopyToAsync(memory);
        var text = Encoding.UTF8.GetString(memory.ToArray());
        var split = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        var headerText = split >= 0 ? text[..split] : text;
        var body = split >= 0 ? text[(split + 4)..] : string.Empty;
        var lines = headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon > 0)
            {
                headers[line[..colon]] = line[(colon + 1)..].Trim();
            }
        }

        return new HttpProbeResponse(lines.FirstOrDefault() ?? string.Empty, headers, body);
    }

    // Binary-safe GET: the body is kept as raw bytes (GetAsync UTF-8 decodes it, which corrupts a clip
    // stream). Used to assert the /spines/ SpineClipWire body byte-for-byte.
    private static async Task AssertWebSocketContractAsync(Uri baseUri)
    {
        const string canonical = "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0";
        foreach (var query in new[]
                 {
                     "watch=1&staticBg=0&cardFlight=1&handTween=1",
                     "watch=true&staticBg=0&cardFlight=1&handTween=1&trailDrive=0",
                     "watch=1&staticBg=on&cardFlight=1&handTween=1&trailDrive=0",
                     "watch=1&staticBg=0&cardFlight=off&handTween=1&trailDrive=0",
                     "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=yes",
                 })
        {
            var rejected = await GetWebSocketUpgradeRawAsync(baseUri, "/ws?" + query);
            Expect(rejected.StatusLine.Contains("400 BadRequest", StringComparison.Ordinal), $"non-canonical websocket query is rejected at admission: {query}");
            Expect(Encoding.UTF8.GetString(rejected.Body).Contains("invalid-websocket-contract", StringComparison.Ordinal), $"websocket contract rejection is structured: {query}");
        }

        using var accepted = new ClientWebSocket();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await accepted.ConnectAsync(
            new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = canonical }.Uri,
            deadline.Token);
        Expect(accepted.State == WebSocketState.Open, "the canonical websocket contract is admitted");
        using (var session = JsonDocument.Parse(await ReadWsMessageAsync(accepted, deadline.Token)))
        {
            Expect(session.RootElement.GetProperty("type").GetString() == "session",
                "the canonical websocket contract receives its session envelope");
        }

        await accepted.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", deadline.Token);
    }

    private static async Task<HttpRawResponse> GetWebSocketUpgradeRawAsync(Uri baseUri, string path)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, baseUri.Port);
        await using var stream = client.GetStream();
        var request = Encoding.ASCII.GetBytes(
            $"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{baseUri.Port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
        await stream.WriteAsync(request);

        using var memory = new MemoryStream();
        await stream.CopyToAsync(memory);
        var raw = memory.ToArray();
        var separator = IndexOfHeaderEnd(raw);
        var headerText = Encoding.ASCII.GetString(raw, 0, separator < 0 ? raw.Length : separator);
        var body = separator < 0 ? [] : raw[(separator + 4)..];
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries).Skip(1))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon > 0)
            {
                headers[line[..colon]] = line[(colon + 1)..].Trim();
            }
        }

        return new HttpRawResponse(headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? string.Empty, headers, body);
    }

    private static async Task<HttpRawResponse> GetRawAsync(Uri baseUri, string path)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, baseUri.Port);
        await using var stream = client.GetStream();
        var request = Encoding.ASCII.GetBytes($"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{baseUri.Port}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(request);

        using var memory = new MemoryStream();
        await stream.CopyToAsync(memory);
        var raw = memory.ToArray();
        var separator = IndexOfHeaderEnd(raw);
        var headerText = Encoding.ASCII.GetString(raw, 0, separator < 0 ? raw.Length : separator);
        var body = separator < 0 ? [] : raw[(separator + 4)..];
        var lines = headerText.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon > 0)
            {
                headers[line[..colon]] = line[(colon + 1)..].Trim();
            }
        }

        return new HttpRawResponse(lines.FirstOrDefault() ?? string.Empty, headers, body);
    }

    private static int IndexOfHeaderEnd(byte[] data)
    {
        for (var i = 0; i + 3 < data.Length; i++)
        {
            if (data[i] == (byte)'\r' && data[i + 1] == (byte)'\n' && data[i + 2] == (byte)'\r' && data[i + 3] == (byte)'\n')
            {
                return i;
            }
        }

        return -1;
    }

    private static Task<string> ReadWsMessageAsync(ClientWebSocket socket)
        => ReadWsMessageAsync(socket, CancellationToken.None);

    private static async Task<string> ReadWsMessageAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[4096];
        using var memory = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return Encoding.UTF8.GetString(memory.ToArray());
            }

            memory.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return Encoding.UTF8.GetString(memory.ToArray());
            }
        }
    }

    private static async Task<string?> TryReadWsMessageAsync(ClientWebSocket socket, int timeoutMs)
    {
        using var cancellationSource = new CancellationTokenSource(timeoutMs);
        try
        {
            return await ReadWsMessageAsync(socket, cancellationSource.Token);
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    private static async Task AssertServerReloadClosesWebSocketAsync(
        CouchCoopBrowserServer server,
        Uri baseUri)
    {
        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(new UriBuilder(baseUri) { Scheme = "ws", Path = "/ws", Query = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0" }.Uri, CancellationToken.None);
        _ = await DrainConnectAsync(socket);
        var readReload = ReadNextWsMessageOfTypeAsync(socket, "server-reload");
        var stop = server.StopGenerationAsync("server-reload");
        var message = await readReload;
        await CloseWebSocketSilentlyAsync(socket);
        await stop;
        using var document = JsonDocument.Parse(message);
        Expect(document.RootElement.GetProperty("type").GetString() == "server-reload", "server reload sends a structured WebSocket reload signal");
        Expect(document.RootElement.GetProperty("reason").GetString() == "server-reload", "server reload signal carries reload reason");
    }

    private static async Task CloseWebSocketSilentlyAsync(ClientWebSocket socket)
    {
        try
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived or WebSocketState.CloseSent)
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch (WebSocketException)
        {
        }
        catch (OperationCanceledException)
        {
        }
    }

    // The frame answering ONE request. The host also pushes unsolicited frames on every connection (scene-delta
    // stream, and `session` re-sends carrying requestId "session"), so a reply must be matched by its request id.
    private static async Task<string> ReadCorrelatedReplyAsync(ClientWebSocket socket, string requestId, int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0)
            {
                throw new TimeoutException($"Timed out waiting for the session reply to '{requestId}'.");
            }

            var message = await TryReadWsMessageAsync(socket, (int)Math.Min(remaining, int.MaxValue)).ConfigureAwait(false)
                ?? throw new TimeoutException($"Timed out waiting for the session reply to '{requestId}'.");

            using var document = JsonDocument.Parse(message);
            if (document.RootElement.TryGetProperty("requestId", out var id) && id.GetString() == requestId)
            {
                return message;
            }
        }
    }

    private static async Task<string> ReadNextWsMessageOfTypeAsync(ClientWebSocket socket, string type, int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0)
            {
                throw new TimeoutException($"Timed out waiting for websocket message type '{type}'.");
            }

            var message = await TryReadWsMessageAsync(socket, (int)Math.Min(remaining, int.MaxValue)).ConfigureAwait(false);
            if (message is null)
            {
                throw new TimeoutException($"Timed out waiting for websocket message type '{type}'.");
            }

            using var document = JsonDocument.Parse(message);
            if (document.RootElement.GetProperty("type").GetString() == type)
            {
                return message;
            }
        }
    }

    private static async Task<string> ReadNextSceneDeltaMatchingAsync(
        ClientWebSocket socket,
        Func<JsonElement, bool> matches,
        int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0)
            {
                throw new TimeoutException("Timed out waiting for matching scene-delta message.");
            }

            var message = await ReadNextWsMessageOfTypeAsync(socket, "scene-delta", (int)Math.Min(remaining, int.MaxValue)).ConfigureAwait(false);
            using var document = JsonDocument.Parse(message);
            if (matches(document.RootElement))
            {
                return message;
            }
        }
    }

    // Defensive read of the first upsert's local transform origin.x, or null when the delta has no such upsert
    // (e.g. an empty keyframe or an unrelated incremental delta). Lets a scene-delta matcher skip non-matching
    // frames instead of throwing KeyNotFoundException on a delta that omits the expected placement.
    private static double? TryReadFirstUpsertOriginX(JsonElement root)
    {
        if (!root.TryGetProperty("upserts", out var upserts)
            || upserts.ValueKind != JsonValueKind.Array
            || upserts.GetArrayLength() == 0)
        {
            return null;
        }

        return upserts[0].TryGetProperty("transform", out var transform)
            && transform.TryGetProperty("origin", out var origin)
            && origin.TryGetProperty("x", out var x)
            && x.ValueKind == JsonValueKind.Number
            ? x.GetDouble()
            : null;
    }

    private static async Task<bool> ReadWsCloseAsync(ClientWebSocket socket)
    {
        var buffer = new byte[256];
        var result = await socket.ReceiveAsync(buffer, CancellationToken.None);
        return result.MessageType == WebSocketMessageType.Close
               || socket.State is WebSocketState.CloseReceived or WebSocketState.Closed;
    }

    private static async Task<JsonElement> SendActionAsync(ClientWebSocket socket, object envelope)
    {
        var json = JsonSerializer.Serialize(envelope, BrowserJson.Options);
        string? requestId;
        using (var request = JsonDocument.Parse(json))
        {
            requestId = request.RootElement.TryGetProperty("requestId", out var id) ? id.GetString() : null;
        }

        await socket.SendAsync(
            Encoding.UTF8.GetBytes(json),
            WebSocketMessageType.Text,
            WebSocketMessageFlags.EndOfMessage,
            CancellationToken.None);
        // Every connection streams the scene and receives unsolicited `session` re-sends, so the answer to this
        // request is not reliably the next frame — correlate on the request id.
        var message = requestId is null
            ? await ReadWsMessageAsync(socket)
            : await ReadCorrelatedReplyAsync(socket, requestId);
        using var document = JsonDocument.Parse(message);
        return document.RootElement.Clone();
    }

    // THE OTHER HALF OF THE ROUND-8 LIVE DEFECT. The per-seat status and the join gate were completely INERT on a
    // real host: HotReloadableBrowserServerHost owns the TCP listener and hands each accepted socket straight to a
    // generation's HandleClientAsync, so StartAsync — where the seat directory used to be built — never ran. Every
    // connection therefore got the null "no opinion" directory, which reports EVERY seat ready and refuses no join,
    // no matter what MirrorSeatDirectory would have decided. Every other test in this file calls StartAsync, which
    // is precisely why the suite never saw it; this one deliberately does not.
    private static async Task SeatDirectoryIsLiveOnTheConnectionPathWithoutStartAsync()
    {
        using var root = new TempStaticRoot();
        var envelopeFactory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime(), new RecordingSpirectlRuntime())));
        using var manager = new HeadlessClientManager(launcher: _ => null);
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path),
            new CapturingAssetAdapter(),
            envelopeFactory,
            headlessManager: manager,
            isHeadlessClient: false);

        // Deliberately NO StartAsync: this is the shipped hot-reload generation's lifecycle.
        var statuses = server.MirrorSeats().Evaluate(new HashSet<ulong>(), MirrorSeatDirectory.RunMirrorMode);
        Expect(statuses.Count > 0, "the connection path's seat directory has a real seat table without StartAsync");
        Expect(
            statuses.Values.All(status => status.Status == MirrorSeatStatuses.Offline),
            "…and it actually judges — mid-run, seats with no instance read offline instead of the null "
            + "directory's blanket ready");
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class TempStaticRoot : IDisposable
    {
        public TempStaticRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-static-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
            File.WriteAllText(System.IO.Path.Combine(Path, "index.html"), "<!doctype html><div>spa-index</div>");
            File.WriteAllText(System.IO.Path.Combine(Path, "app.js"), "console.log('app');");
            File.WriteAllText(System.IO.Path.Combine(Path, "manifest.webmanifest"), "{\"name\":\"couchcoop-manifest\"}");

            // The boot manifest is emitted by the frontend build as an EXTENSIONLESS file named `app-boot`
            // (a `*.json` here would be scanned as a mod manifest by STS2 and logged as an error). The
            // `/app-boot.json` route reads it via StaticSpaFileProvider.BootManifestDiskName and re-emits it.
            File.WriteAllText(
                System.IO.Path.Combine(Path, "app-boot"),
                "{\"entry\":\"/app/index-testhash1.js\",\"css\":[\"/app/index-testhash1.css\"],\"buildId\":\"testhash1\",\"bootProtocol\":1}\n");

            // The shipped icon PNGs are the FAIL-OPEN fallback for the game-rendered ones, so a static root
            // without them cannot exercise that branch. Content is a marker, not a PNG — the route forwards
            // bytes verbatim and never parses them.
            var icons = System.IO.Path.Combine(Path, "icons");
            Directory.CreateDirectory(icons);
            foreach (var icon in CouchCoopAppIcons.All)
            {
                File.WriteAllText(System.IO.Path.Combine(Path, icon.StaticRelativePath), "shipped-icon-" + icon.SizePx.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private sealed class TempResourceCacheRoot : IDisposable
    {
        public TempResourceCacheRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-resource-cache-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private sealed class TempHotReloadRoot : IDisposable
    {
        public TempHotReloadRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-hot-reload-" + Guid.NewGuid().ToString("N"));
            var hotReloadPath = System.IO.Path.Combine(Path, "hot-reload");
            Directory.CreateDirectory(hotReloadPath);
            var sourceArtifact = System.IO.Path.Combine(AppContext.BaseDirectory, "CouchCoop.Mod.HotReload.dll");
            if (!File.Exists(sourceArtifact))
            {
                throw new FileNotFoundException("Hot-reload test artifact was not copied to the validation output.", sourceArtifact);
            }

            ArtifactPath = System.IO.Path.Combine(hotReloadPath, "CouchCoop.Mod.HotReload.dll");
            File.Copy(sourceArtifact, ArtifactPath);
            CopyIfPresent(sourceArtifact, ".pdb");
            CopyIfPresent(sourceArtifact, ".deps.json");
            CopyIfPresent(sourceArtifact, ".runtimeconfig.json");
        }

        public string Path { get; }
        public string ArtifactPath { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);

        private void CopyIfPresent(string sourceArtifact, string suffix)
        {
            var source = System.IO.Path.ChangeExtension(sourceArtifact, null) + suffix;
            if (File.Exists(source))
            {
                File.Copy(source, System.IO.Path.ChangeExtension(ArtifactPath, null) + suffix);
            }
        }
    }

    private async Task AssertAssetBinaryCacheAsync()
    {
        var root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-asset-cache-" + Guid.NewGuid().ToString("N"));
        try
        {
            var inner = new CountingAssetAdapter([7, 8, 9], "image/png");
            var cache = new SpirectlAssetBinaryCache(root);
            Expect(cache.IsEnabled, "asset binary cache is enabled for an explicit root");
            var cached = new CachedSpirectlAssetHttpAdapter(inner, cache);
            const string key = "model://characters/ironclad/characterSelectBgSpineStill";

            var miss = await cached.TryGetAssetAsync(key);
            Expect(miss.Error is null && miss.Bytes is { Length: 3 }, "first asset request returns bytes");
            Expect(miss.Headers.TryGetValue("X-Cache", out var missStatus) && missStatus == "MISS", "first asset request is a cache MISS");
            Expect(inner.Calls == 1, "first asset request hits the inner seam");

            var hit = await cached.TryGetAssetAsync(key);
            Expect(hit.Error is null && hit.Bytes is { Length: 3 } && hit.Bytes[0] == 7, "cached asset request returns the stored bytes");
            Expect(hit.ContentType == "image/png", "cached asset request preserves the content type");
            Expect(hit.Headers.TryGetValue("X-Cache", out var hitStatus) && hitStatus == "HIT", "second asset request is a cache HIT");
            Expect(inner.Calls == 1, "cache HIT does not re-hit the inner seam");

            // Format-aware cache key: raster bytes are a separate entry from the raw resource. The prior two calls
            // used the default raw format.
            const string resKey = "res://images/atlases/card_atlas.sprites/status/slimed.tres";
            var rawResMiss = await cached.TryGetAssetAsync(resKey, CouchCoopResourceFormat.Raw);
            Expect(rawResMiss.Headers.TryGetValue("X-Cache", out var rawResStatus) && rawResStatus == "MISS", "raw .tres request is a cache MISS");
            Expect(inner.Calls == 2, "raw .tres request hits the inner seam");

            var rawResHit = await cached.TryGetAssetAsync(resKey, CouchCoopResourceFormat.Raw);
            Expect(rawResHit.Headers.TryGetValue("X-Cache", out var rawResHitStatus) && rawResHitStatus == "HIT", "raw .tres request caches under the bare key");
            Expect(inner.Calls == 2, "raw .tres HIT does not re-hit the inner seam");

            // The raster (`png`) variant is an independent cache entry — a raw `[gd_resource]`
            // text hit must never be served for a raster request (that is exactly the white-quads bug).
            var pngResMiss = await cached.TryGetAssetAsync(resKey, CouchCoopResourceFormat.Png);
            Expect(pngResMiss.Headers.TryGetValue("X-Cache", out var pngResStatus) && pngResStatus == "MISS", "png .tres variant is a SEPARATE cache MISS (format-qualified key)");
            Expect(inner.Calls == 3, "png .tres variant hits the inner seam independently of raw");

            var pngResHit = await cached.TryGetAssetAsync(resKey, CouchCoopResourceFormat.Png);
            Expect(pngResHit.Headers.TryGetValue("X-Cache", out var pngResHitStatus) && pngResHitStatus == "HIT", "png .tres variant caches under its own key");
            Expect(inner.Calls == 3, "png .tres HIT does not re-hit the inner seam");
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }

    private sealed class CountingAssetAdapter(byte[] bytes, string contentType) : ICouchCoopAssetHttpAdapter
    {
        public int Calls { get; private set; }

        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string opaqueKey, CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw, CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
        {
            Calls++;
            return Task.FromResult(CouchCoopAssetHttpResponse.Found(
                bytes,
                contentType,
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)));
        }
    }

    // An asset seam that faults UNEXPECTEDLY (not a structured miss), so the server's top-level
    // internal-server-error translation can be asserted end to end.
    private sealed class ThrowingAssetAdapter : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string opaqueKey, CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw, CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
            => throw new ApplicationException("asset test failure");
    }

    private sealed class CapturingAssetAdapter : ICouchCoopAssetHttpAdapter
    {
        public string? LastKey { get; private set; }

        public CouchCoopResourceFormat LastFormat { get; private set; }

        public CouchCoopAssetRenderSize LastRenderSize { get; private set; }

        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string opaqueKey, CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw, CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
        {
            LastKey = opaqueKey;
            LastFormat = format;
            LastRenderSize = renderSize;
            if (string.Equals(opaqueKey, "res://images/icon.ico", StringComparison.Ordinal))
            {
                return Task.FromResult(CouchCoopAssetHttpResponse.Found(
                    [0, 0, 1, 0],
                    "image/x-icon",
                    new Dictionary<string, string> { ["Cache-Control"] = "public, max-age=31536000, immutable" }));
            }

            // R6 P6-F2 — a SYNTHETIC `.tres` carrying two shader sub-resources, for the `::` route below. Hand
            // written (no game content), and served as raw text exactly as the real seam serves a `.tres`.
            if (string.Equals(opaqueKey, "res://shaders/subresource_fixture.tres", StringComparison.Ordinal))
            {
                const string body =
                    "[gd_resource type=\"ShaderMaterial\" load_steps=3 format=3]\n\n" +
                    "[sub_resource type=\"Shader\" id=\"Shader_aaaaa\"]\n" +
                    "code = \"shader_type canvas_item;\nuniform float a = 1.0;\n\"\n\n" +
                    "[sub_resource type=\"Shader\" id=\"Shader_bbbbb\"]\n" +
                    "code = \"shader_type canvas_item;\nuniform float b = 2.0;\n\"\n\n" +
                    "[resource]\n" +
                    "shader = SubResource(\"Shader_aaaaa\")\n";
                return Task.FromResult(CouchCoopAssetHttpResponse.Found(
                    Encoding.UTF8.GetBytes(body),
                    "text/plain; charset=utf-8",
                    new Dictionary<string, string> { ["Cache-Control"] = "public, max-age=31536000, immutable" }));
            }

            if (opaqueKey.Contains("missing", StringComparison.Ordinal))
            {
                return Task.FromResult(CouchCoopAssetHttpResponse.Missing(new CouchCoopAssetHttpError(
                    "missing-asset",
                    "Asset was not found.",
                    "key",
                    opaqueKey,
                    [
                        new EmbeddableAssetNotice("missing-asset", "error", "Asset was not found.", "key")
                    ])));
            }

            return Task.FromResult(CouchCoopAssetHttpResponse.Found(
                [1, 2, 3],
                "image/png",
                new Dictionary<string, string> { ["Cache-Control"] = "public, max-age=31536000, immutable" }));
        }
    }

    private enum RuntimeStateMode
    {
        MultiplayerRun,
        Lobby,
        Unsupported,
        SingleplayerAmbiguous,
        SingleplayerSafe
    }

    private sealed class RecordingSpirectlRuntime : IRuntimeCapabilitySource, IRuntimeAssetSource, IRuntimeStateSource, IAnimationHintSource, IRuntimeSceneDeltaSource, IGameModelSource, ISpineCatalogSource, ISpineGeoClipBaker, ISemanticActionSource, IRuntimeSceneWatchControlSource
    {
        public IRuntimeSceneWatchControls SceneWatchControls => Spirectl.Sts2.Live.Sts2RuntimeSceneWatchControls.Instance;
        private readonly RecordingAssetProvider _assets;

        public RecordingSpirectlRuntime()
        {
            _assets = new RecordingAssetProvider(Calls);
            _assets.Owner = this;
        }

        public List<string> Calls { get; } = [];
        public bool AssetExtractionSupported { get; set; } = true;
        public bool StateSupported { get; set; } = true;
        public Exception? SpineCatalogException { get; set; }
        public SpineCatalogOperationResult SpineCatalog { get; set; } = SpineCatalogOperationResult.Success(
            DataSourceKind.Stub,
            provisional: false,
            scannedSceneCount: 0,
            spineNodeCount: 0,
            entries: [],
            failures: [],
            notes: []);
        public RuntimeStateMode Mode { get; set; } = RuntimeStateMode.MultiplayerRun;
        // The lobby's netGameType. "host" is what opens the mirror SPAWN window
        // (CouchCoopLobbyParticipation.DescribeMirrorJoinContext reads exactly this), so a test that needs the join
        // handler to actually reach HeadlessClientManager sets it. Defaults to the pre-existing "multiplayer" so
        // every other assert in this file sees the state it always did.
        public string LobbyNetGameType { get; set; } = "multiplayer";
        public ManualResetEventSlim? ExecuteActionGate { get; set; }
        public EmbeddableActionRequest? LastActionRequest { get; private set; }
        public EmbeddableAssetRequest? LastAssetRequest { get; set; }

        public ISpirectlAssetProvider Assets => _assets;

        public EmbeddableRuntimeCapabilities GetCapabilities()
        {
            Calls.Add("GetCapabilities");
            return new EmbeddableRuntimeCapabilities(
                "spirectl/v1",
                "test-game",
                "test-bridge",
                "embedded",
                RuntimeAttachmentState.Attached,
                DataSourceKind.Stub,
                Provisional: false,
                [
                    new EmbeddableRuntimeCapability(
                        CouchCoopRuntimeHost.StateCapability,
                        CouchCoopRuntimeHost.StateCapability,
                        Supported: StateSupported,
                        Provisional: false,
                        UnsupportedReason: StateSupported ? null : "state disabled by test"),
                    Capability(CouchCoopRuntimeHost.GameModelsCapability),
                    Capability(CouchCoopRuntimeHost.SemanticActionsCapability),
                    new EmbeddableRuntimeCapability(
                        CouchCoopRuntimeHost.AssetExtractionCapability,
                        CouchCoopRuntimeHost.AssetExtractionCapability,
                        Supported: AssetExtractionSupported,
                        Provisional: false,
                        UnsupportedReason: AssetExtractionSupported ? null : "asset extraction disabled by test"),
                    Capability(CouchCoopRuntimeHost.LiveSts2HostCapability),
                    Capability(CouchCoopRuntimeHost.AnimationHintsCapability),
                    Capability(CouchCoopRuntimeHost.SpineCatalogCapability),
                    Capability(CouchCoopRuntimeHost.SceneCapability)
                ],
                []);
        }

        public SpineCatalogOperationResult GetSpineCatalog(SpineCatalogRequestSnapshot request)
        {
            Calls.Add("GetSpineCatalog");
            if (SpineCatalogException is not null)
            {
                throw SpineCatalogException;
            }

            return SpineCatalog;
        }

        public SpineGeoClipBakeResultSnapshot BakeSpineGeoClip(SpineGeoClipBakeRequestSnapshot request)
            => throw new NotSupportedException();

        public CurrentStateResult GetCurrentState(CurrentStateRequest request)
        {
            Calls.Add("GetCurrentState");
            return new CurrentStateResult(
                true,
                new StateSnapshot(
                    StateSnapshot.CurrentSchemaVersion,
                    "en",
                    Mode switch
                    {
                        RuntimeStateMode.Lobby => "screens/character_select_screen",
                        RuntimeStateMode.Unsupported => "main-menu",
                        _ => "run"
                    },
                    Mode == RuntimeStateMode.Lobby ? CreateStateCharacterSelect(LobbyNetGameType) : null,
                    Mode switch
                    {
                        RuntimeStateMode.SingleplayerAmbiguous => CreateStateRun(["Alice"], "singleplayer"),
                        RuntimeStateMode.SingleplayerSafe => CreateStateRun(["Alice"], "multiplayer"),
                        RuntimeStateMode.MultiplayerRun => CreateStateRun(["Alice", "Bob"], "multiplayer"),
                        _ => null
                    }),
                null);
        }

        private static StateCharacterSelectSnapshot CreateStateCharacterSelect(string netGameType)
            => new(
                new StateCharacterSelectLobbySnapshot(
                    netGameType,
                    "Alice",
                    "Alice",
                    ConnectingPlayerCount: 0,
                    Ascension: 0,
                    MaxAscension: 20,
                    Act1: "random",
                    Seed: null,
                    ModifierIds: [],
                    Players:
                    [
                        new StateCharacterSelectPlayerSnapshot("Alice", 0, "ironclad", false, 20, "Alice"),
                        new StateCharacterSelectPlayerSnapshot("Bob", 1, "silent", true, 20, "Bob")
                    ]),
                CharacterButtons:
                [
                    new StateCharacterButtonSnapshot("button:ironclad", "ironclad", false),
                    new StateCharacterButtonSnapshot("button:silent", "silent", true)
                ],
                View: new StateCharacterSelectViewSnapshot("Alice", null));

        private static StateRunSnapshot CreateStateRun(IReadOnlyList<string> playerIds, string netGameType)
        {
            var players = playerIds
                .Select(playerId => new StateRunPlayerSnapshot(
                    playerId,
                    "test",
                    NetId: null,
                    DisplayName: playerId,
                    CharacterId: playerId == "Alice" ? "ironclad" : "silent",
                    IsLocal: playerId == "Alice",
                    IsHost: playerId == "Alice",
                    IsRemote: playerId != "Alice",
                    Creature: null,
                    Gold: 99,
                    Deck: null,
                    Relics: [],
                    InventoryComplete: true,
                    Notices: []))
                .ToArray();

            return new StateRunSnapshot(
                "test",
                "test",
                netGameType,
                "standard",
                "seed:test",
                AscensionLevel: 0,
                ActId: "act1",
                CurrentActIndex: 0,
                ActFloor: 0,
                TotalFloor: 0,
                BossEncounterId: null,
                SecondBossEncounterId: null,
                CurrentMapCoord: null,
                CurrentMapPointId: null,
                VisitedMapCoords: [],
                Players: players,
                Map: null,
                CurrentRoom: null,
                Notices: [],
                View: new StateRunViewSnapshot("Alice", null));
        }

        public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request)
        {
            Calls.Add("GetPresentationAssets");
            return new EmbeddableAssetBatchResult("ok", []);
        }

        public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request)
        {
            Calls.Add("ExecuteAction");
            LastActionRequest = request;
            ExecuteActionGate?.Wait(TimeSpan.FromSeconds(5));
            return new EmbeddableActionResult(false, null, new EmbeddableRuntimeError("semantic-failed", "semantic upstream failure"));
        }

        private Action<CurrentStateWatchEvent>? _stateObserver;

        private int _stateSubscribeCount;
        private int _stateDisposeCount;

        // WS-B: whether the server currently holds a LIVE state-watch subscription. On a MIRROR-ONLY host this is
        // what keeps `session` envelopes flowing (RebroadcastSessionsIfRosterChanged) — i.e. the only way a viewer
        // parked on the picker ever learns the host left the multiplayer screen, so the gate can't latch shut.
        public bool StateSubscriptionActive
            => Volatile.Read(ref _stateSubscribeCount) > Volatile.Read(ref _stateDisposeCount);

        public IDisposable SubscribeCurrentState(
            CurrentStateSubscriptionRequest request,
            Action<CurrentStateWatchEvent> onEvent,
            Action<EmbeddableRuntimeError>? onError = null)
        {
            _stateObserver = onEvent;
            Interlocked.Increment(ref _stateSubscribeCount);
            if (request.EmitInitial)
            {
                EmitState();
            }

            // As with the scene subscription: dispose is COUNTED but `_stateObserver` is deliberately left wired,
            // so a test can keep driving state at the server without racing an asynchronous teardown.
            return new CountingDisposable(this, state: true);
        }

        // Re-emit the current state to the observer — the test's stand-in for the live watcher's
        // tick/force-refresh, used to exercise the server's broadcast fan-out.
        public void PushState() => EmitState();

        private void EmitState()
        {
            var observer = _stateObserver;
            var state = GetCurrentState(new CurrentStateRequest()).State;
            if (observer is not null && state is not null)
            {
                observer(new CurrentStateWatchEvent(
                    CurrentStateWatchEventType.Initial,
                    1,
                    DateTimeOffset.UnixEpoch,
                    "fingerprint",
                    1,
                    state,
                    null,
                    null));
            }
        }

        public async IAsyncEnumerable<CurrentStateWatchEvent> WatchCurrentStateAsync(
            CurrentStateSubscriptionRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }

        // Required by ISpirectlRuntime; the host no longer subscribes, so this is an inert stub.
        public IDisposable SubscribeCombatEvents(
            CombatEventSubscriptionRequest request,
            Action<CombatWatchEvent> onEvent,
            Action<EmbeddableRuntimeError>? onError = null)
            => new NoopDisposable();

        private Action<RuntimeSceneDelta>? _sceneObserver;
        private int _sceneSubscribeCount;
        private int _sceneDisposeCount;

        // WS-B: whether the server currently holds a LIVE scene-watch subscription. The scene producer is by far
        // the most expensive thing a host does, and the stream gate's whole point is that it stops while every
        // viewer sits on the join picker — so the tests assert on this, not merely on the absence of frames.
        public bool SceneSubscriptionActive
            => Volatile.Read(ref _sceneSubscribeCount) > Volatile.Read(ref _sceneDisposeCount);

        public IDisposable SubscribeRuntimeSceneDelta(
            RuntimeSceneSubscriptionRequest request,
            Action<RuntimeSceneDelta> onDelta,
            Action<EmbeddableRuntimeError>? onError = null)
        {
            _sceneObserver = onDelta;
            Interlocked.Increment(ref _sceneSubscribeCount);
            // Deliberately does NOT clear `_sceneObserver` on dispose: a test can then keep driving deltas at the
            // (orphaned) observer to prove the server's fan-out itself drops them for a gated connection, without
            // racing an earlier connection's asynchronous teardown.
            return new CountingDisposable(this, state: false);
        }

        private sealed class CountingDisposable(RecordingSpirectlRuntime owner, bool state) : IDisposable
        {
            private int _disposed;

            public void Dispose()
            {
                if (Interlocked.Exchange(ref _disposed, 1) != 0)
                {
                    return;
                }

                if (state)
                {
                    Interlocked.Increment(ref owner._stateDisposeCount);
                }
                else
                {
                    Interlocked.Increment(ref owner._sceneDisposeCount);
                }
            }
        }

        // Drive a live scene delta to the observer — the test's stand-in for the live watcher tick, used
        // to exercise the server's scene-delta broadcast fan-out.
        public void PushSceneDelta(RuntimeSceneDelta delta)
            => _sceneObserver?.Invoke(delta);

        public async IAsyncEnumerable<CombatWatchEvent> WatchCombatEventsAsync(
            CombatEventSubscriptionRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }

        // Multiple independent subscribers, keyed by id, mirroring the real bridge's
        // EmbeddableAnimationHintHub: each SubscribeAnimationHints gets its own subscription and Publish fans
        // out to ALL of them.
        private readonly object _animHintGate = new();
        private readonly Dictionary<ulong, Action<TweenAnimationHint>> _animHintObservers = [];
        private ulong _nextAnimHintSubscriberId = 1;

        // Capture the collector's subscription so a test can drive tween-timing hints, mirroring the combat
        // observer capture. Subscribing is what enables the producer in production; here it just wires the
        // push seam. The returned disposable removes only this subscriber (again mirroring the real hub).
        public IDisposable SubscribeAnimationHints(
            AnimationHintSubscriptionRequest request,
            Action<TweenAnimationHint> onHint,
            Action<EmbeddableRuntimeError>? onError = null)
        {
            ulong id;
            lock (_animHintGate)
            {
                id = _nextAnimHintSubscriberId++;
                _animHintObservers[id] = onHint;
            }

            return new AnimationHintSubscription(this, id);
        }

        // Drive a tween-timing hint to every live subscriber — the test's stand-in for the live tween hook,
        // used to exercise the server embedding hints in the next broadcast state frame.
        public void PushAnimationHint(string scene, string nodePath, string prop, double durationMs, string? trans = null, string? ease = null)
        {
            var hint = new TweenAnimationHint(scene, nodePath, prop, To: null, durationMs, trans, ease);
            Action<TweenAnimationHint>[] observers;
            lock (_animHintGate)
            {
                observers = [.. _animHintObservers.Values];
            }

            foreach (var observer in observers)
            {
                observer(hint);
            }
        }

        private void RemoveAnimationHintSubscriber(ulong id)
        {
            lock (_animHintGate)
            {
                _animHintObservers.Remove(id);
            }
        }

        private sealed class AnimationHintSubscription(RecordingSpirectlRuntime owner, ulong id) : IDisposable
        {
            private RecordingSpirectlRuntime? _owner = owner;

            public void Dispose()
            {
                var owner = _owner;
                _owner = null;
                owner?.RemoveAnimationHintSubscriber(id);
            }
        }

        public async IAsyncEnumerable<TweenAnimationHint> WatchAnimationHintsAsync(
            AnimationHintSubscriptionRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }

        public ModelCatalogOperationResult GetModels(ModelCatalogRequestSnapshot request)
        {
            Calls.Add("GetModels");
            if (request.Family is not "characters" and not "relics")
            {
                return ModelCatalogOperationResult.Failure(
                    DataSourceKind.Stub,
                    provisional: false,
                    request.Family,
                    "en",
                    ModelCatalogStatus.UnsupportedFamily,
                    "unsupported-model-family",
                    "Model family is unsupported by the test runtime.",
                    []);
            }

            var models = new List<GameModelSnapshot>();
            var missing = new List<string>();
            foreach (var id in request.Ids)
            {
                if (request.Family == "characters" && id == "ironclad")
                {
                    models.Add(new CharacterGameModelSnapshot(
                        Id: "ironclad",
                        Title: "Ironclad",
                        NameColor: "#ff0000",
                        StartingHp: 80,
                        StartingGold: 99,
                        MaxEnergy: 3,
                        EnergyLabelOutlineColor: "#000000",
                        BaseOrbSlotCount: 0,
                        ShouldAlwaysShowStarCounter: false,
                        StartingRelics: ["burning_blood"],
                        CharacterSelectTitle: "Ironclad",
                        CharacterSelectDesc: "A sturdy test character.",
                        UnlockText: null,
                        DialogueColor: "#ffffff",
                        SpeechBubbleColor: "#111111",
                        MapDrawingColor: "#222222",
                        VisualsAssetKey: "model:character:ironclad:visuals",
                        IconAssetKey: "model:character:ironclad:icon",
                        IconOutlineAssetKey: "model:character:ironclad:icon-outline",
                        EnergyCounterAssetKey: "model:character:ironclad:energy",
                        MerchantAnimAssetKey: null,
                        RestSiteAnimAssetKey: null,
                        CharacterSelectBgAssetKey: null,
                        CharacterSelectBgSpineStillAssetKey: null,
                        CharacterSelectIconAssetKey: null,
                        CharacterSelectLockedIconAssetKey: null,
                        MapMarkerAssetKey: "model:character:ironclad:map-marker",
                        IconPath: null,
                        IconOutlinePath: null,
                        EnergyCounterPath: null,
                        MerchantAnimPath: null,
                        RestSiteAnimPath: null,
                        CharacterSelectBgPath: null,
                        CharacterSelectIconPath: null,
                        CharacterSelectLockedIconPath: null,
                        MapMarkerPath: null));
                }
                else if (request.Family == "relics" && id == "burning_blood")
                {
                    models.Add(new RelicGameModelSnapshot(
                        Id: "burning_blood",
                        Title: "Burning Blood",
                        Flavor: "It pulses warmly.",
                        Description: "Heal after combat.",
                        IconPath: "res://burning_blood.png",
                        IconOutlinePath: null,
                        BigIconPath: null,
                        Rarity: "starter",
                        IconAssetKey: "model:relic:burning_blood:icon",
                        IconOutlineAssetKey: "model:relic:burning_blood:outline",
                        BigIconAssetKey: "model:relic:burning_blood:big",
                        PoolId: null,
                        IsTradable: false,
                        IsAllowedInShops: false,
                        HasUponPickupEffect: false,
                        SpawnsPets: false,
                        AddsPet: false,
                        IsStackable: false,
                        MerchantCost: 0,
                        ShowCounter: false,
                        FlashSfx: null));
                }
                else
                {
                    missing.Add(id);
                }
            }

            return ModelCatalogOperationResult.Success(
                DataSourceKind.Stub,
                provisional: false,
                request.Family,
                "en",
                missing.Count == 0 ? ModelCatalogStatus.Ok : ModelCatalogStatus.Partial,
                models,
                missing,
                []);
        }

        // Required by ISpirectlRuntime; no route reads game reference data any more.
        public ReferenceOperationResult GetReference(ReferenceRequestSnapshot request)
        {
            Calls.Add("GetReference");
            return ReferenceOperationResult.Success(
                DataSourceKind.Stub,
                provisional: false,
                topic: request.Topic,
                status: ReferenceStatus.UnsupportedTopic,
                payload: null,
                missingKeys: [],
                notices: []);
        }

        private static EmbeddableRuntimeCapability Capability(string id)
            => new(id, id, Supported: true, Provisional: false, UnsupportedReason: null);

        public void ResetActionProbe()
        {
            LastActionRequest = null;
        }

        private sealed class NoopDisposable : IDisposable
        {
            public void Dispose()
            {
            }
        }
    }

        private sealed class RecordingAssetProvider(List<string> calls) : ISpirectlAssetProvider
        {
            public RecordingSpirectlRuntime? Owner { get; set; }

            public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
            {
                calls.Add("Assets.GetAsset");
                if (Owner is not null)
                {
                    Owner.LastAssetRequest = request;
                }

                if (request.Key.StartsWith("missing", StringComparison.Ordinal))
                {
                    return new EmbeddableAssetResult(
                        false,
                        null,
                        new EmbeddableAssetError(
                            "missing-asset",
                            "Asset was not found.",
                            "key",
                            request.Key,
                            [new EmbeddableAssetNotice("missing-asset", "error", "Asset was not found.", "key")]));
                }

                if (request.Key.StartsWith("spine://", StringComparison.Ordinal))
                {
                    return BuildSpineClipResult(request);
                }

                // Stage-A static background: the /bg/ route's composed render (and its literal-scene fallback),
                // plus the EVENT family's literal backdrop-scene render (/bg/events/<id>).
                // The payload ECHOES the requested codec, exactly as the real extractor does — the /bg/ URL now
                // carries no file extension, so Content-Type is the only thing that names the encoding and a fake
                // that always answered "png" could not tell a working codec switch from a broken one. A key naming
                // "missing" fails structurally so the route's 404 is testable.
                if (request.Key.StartsWith("composed://combat-background/", StringComparison.Ordinal)
                    || request.Key.EndsWith("_background.tscn", StringComparison.Ordinal)
                    || request.Key.StartsWith("res://scenes/events/background_scenes/", StringComparison.Ordinal)
                    || request.Key.StartsWith("scene-subtree://", StringComparison.Ordinal))
                {
                    if (request.Key.Contains("missing", StringComparison.Ordinal))
                    {
                        return new EmbeddableAssetResult(
                            false,
                            null,
                            new EmbeddableAssetError("missing-asset", "Background was not found.", "key", request.Key));
                    }

                    var (bgFormat, bgContentType, bgBytes) = request.Format switch
                    {
                        "jpg" or "jpeg" => ("jpeg", "image/jpeg", new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 }),
                        "webp" => ("webp", "image/webp", [(byte)'R', (byte)'I', (byte)'F', (byte)'F']),
                        _ => ("png", "image/png", [0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A]),
                    };

                    return new EmbeddableAssetResult(
                        true,
                        new EmbeddableAssetPayload(
                            request.RequestId ?? string.Empty,
                            request.Key,
                            "image",
                            bgFormat,
                            bgContentType,
                            request.RenderWidth ?? 1920,
                            request.RenderHeight ?? 1080,
                            bgBytes,
                            [],
                            new EmbeddableAssetProvenance("bg", request.Key, request.Key, "combat_background", "test"),
                            []),
                        null);
                }

                // WS-PARTICLE: emulate spirectl's `.tres` format contract (asserted end-to-end by spirectl's own
                // suites): a raster format ("png") routes an AtlasTexture `.tres` to cropped-region PNG bytes;
                // the structure-family formats serve the raw `[gd_resource]` text under "raw".
                if (request.Key.EndsWith(".tres", StringComparison.Ordinal))
                {
                    bool raster = string.Equals(request.Format, "png", StringComparison.Ordinal);
                    byte[] tresBytes = raster
                        ? [0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A]
                        : Encoding.UTF8.GetBytes("[gd_resource type=\"AtlasTexture\" format=3]\n");
                    return new EmbeddableAssetResult(
                        true,
                        new EmbeddableAssetPayload(
                            request.RequestId ?? string.Empty,
                            request.Key,
                            raster ? "image" : "resource",
                            raster ? "png" : "tres",
                            raster ? "image/png" : "text/plain; charset=utf-8",
                            raster ? 32 : 0,
                            raster ? 32 : 0,
                            tresBytes,
                            [],
                            new EmbeddableAssetProvenance("root", "source", "load", "runtime", "test"),
                            []),
                        null);
                }

                return new EmbeddableAssetResult(
                    true,
                    new EmbeddableAssetPayload(
                        request.RequestId ?? string.Empty,
                        request.Key,
                        "image",
                        "webp",
                        "image/webp",
                        32,
                        32,
                        [9, 8, 7],
                        [],
                        new EmbeddableAssetProvenance("root", "source", "load", "runtime", "test"),
                        []),
                    null);
            }

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
        {
            calls.Add("Assets.GetAssets");
            return new EmbeddableAssetBatchResult("ok", []);
        }
    }

    private sealed record HttpProbeResponse(string StatusLine, IReadOnlyDictionary<string, string> Headers, string Body);

    private sealed record HttpRawResponse(string StatusLine, IReadOnlyDictionary<string, string> Headers, byte[] Body);

    private sealed class TestHotGeneration(string body) : ICouchCoopHotGeneration
    {
        private readonly string _body = body;

        public int StopCount { get; private set; }

        // A VALID layout on the current schema — the point of this double is to stand in for a healthy
        // generation, and a stale schema here would silently make it a rejected one instead.
        public string DescribeOverlayLayoutJson()
            => """{"left":226,"top":732,"right":578,"bottom":868,"qrDialogExtent":620,"quietZoneModules":0,"titleFontScale":1.75,"urlFontScale":1.375,"buttonFontScale":1.75,"panelPadding":24,"panelCornerRadius":16,"panelBorderWidth":3,"panelColor":"#0e1117f7","panelBorderColor":"#ffffff33"}""";

        public async Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
        {
            using var disposeClient = client;
            await using var stream = client.GetStream();
            _ = await CouchCoopHttpRequest.TryReadAsync(stream, cancellationToken).ConfigureAwait(false);
            var bytes = Encoding.UTF8.GetBytes(_body);
            await HttpResponseWriter.WriteBytesAsync(
                stream,
                200,
                "OK",
                bytes,
                "text/plain",
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        public Task StopAsync(HotReloadShutdownContext context, CancellationToken cancellationToken)
        {
            StopCount++;
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    // A SpineSprite clip asset seam whose extraction blocks on a gate, so a single-flight test can prove
    // that N concurrent requests collapse onto ONE extraction while it is genuinely in flight.
    private sealed class GatedSpineAssetProvider : ISpirectlAssetProvider
    {
        private readonly ManualResetEventSlim _entered = new(initialState: false);
        private readonly ManualResetEventSlim _release = new(initialState: false);
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        public bool WaitUntilEntered() => _entered.Wait(TimeSpan.FromSeconds(5));

        public void Release() => _release.Set();

        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
        {
            Interlocked.Increment(ref _calls);
            _entered.Set();
            _release.Wait(TimeSpan.FromSeconds(5));
            return BuildSpineClipResult(request);
        }

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
            => new("ok", [GetAsset(request.Requests[0])]);
    }

    // A two-frame Spine clip Timeline payload (frames carry their placement through the embeddable seam);
    // anim=empty yields a frameless timeline and anim=broken yields a structured extraction failure.
    private static EmbeddableAssetResult BuildSpineClipResult(EmbeddableAssetRequest request)
    {
        if (request.Key.Contains("anim=broken", StringComparison.Ordinal))
        {
            return new EmbeddableAssetResult(
                false,
                null,
                new EmbeddableAssetError(
                    "render-failed",
                    "Spine clip render failed.",
                    "key",
                    request.Key,
                    [new EmbeddableAssetNotice("render-failed", "error", "Spine clip render failed.")]));
        }

        var provenance = new EmbeddableAssetProvenance("spine", request.Key, request.Key, "spine_scene", "live");
        EmbeddableAssetFrame[] frames = request.Key.Contains("anim=empty", StringComparison.Ordinal)
            ? []
            :
            [
                new EmbeddableAssetFrame(0, "png", "image/png", 2, 2, [0xA, 0xB, 0xC], 33, OffsetX: 1, OffsetY: 2, CanvasWidth: 8, CanvasHeight: 8),
                new EmbeddableAssetFrame(1, "png", "image/png", 2, 2, [0xD, 0xE], 33, OffsetX: 3, OffsetY: 4, CanvasWidth: 8, CanvasHeight: 8),
            ];

        return new EmbeddableAssetResult(
            true,
            new EmbeddableAssetPayload(
                request.RequestId ?? string.Empty,
                request.Key,
                "timeline",
                "png",
                "application/json",
                8,
                8,
                [],
                frames,
                provenance,
                [])
            {
                DurationMs = 66,
                ClipLocalX = -100,
                ClipLocalY = -200,
                ClipLocalWidth = 8,
                ClipLocalHeight = 8,
            },
            null);
    }
}
