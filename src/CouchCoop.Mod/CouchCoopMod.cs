using CouchCoop.Mod.Localization;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Spirectl.Sts2;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod;

public static class CouchCoopMod
{
    private static readonly object Gate = new();
    private static CouchCoopRuntimeHost? _runtime;
    private static CouchCoopHostUiServices? _hostUi;
    private static CouchCoopHostUiSnapshot? _hostUiStartupFailure;
    private static CancellationTokenSource? _spinePrerenderStop;
    private static Task? _spinePrerenderTask;
    private static bool _spinePrerenderStarted;
    private static CancellationTokenSource? _bgPrerenderStop;
    private static Task? _bgPrerenderTask;
    private static bool _bgPrerenderStarted;
    private static CancellationTokenSource? _geoclipPrerenderStop;
    private static Task? _geoclipPrerenderTask;
    private static bool _geoclipPrerenderStarted;

    /// <summary>Bounded support checkpoints shared by the lobby mount, controller and listener seams.</summary>
    internal static LobbySupportCheckpoints LobbyCheckpoints { get; } = new(
        CouchCoopLog.Stderr,
        CouchCoopLog.Info,
        CouchCoopLog.Error);

    // True when this game instance was spawned by HeadlessClientManager to serve a single
    // browser player in co-op. Headless clients skip the QR overlay (no display) and do
    // not spawn sub-headless instances of their own.
    public static bool IsHeadlessClient { get; } =
        Environment.GetEnvironmentVariable("COUCHCOOP_HEADLESS_CLIENT") == "1";

    /// <summary>
    /// "A real game process is running behind this assembly." Latched TRUE by <see cref="Init"/>, which is the
    /// only writer, and false everywhere else: test runners, benches, the hosted server harness, and any
    /// tooling that loads these types without an engine.
    /// </summary>
    /// <remarks>
    /// <para>
    /// EVERY READER GATES A NATIVE CALL, AND THE LATCH — NOT A <c>try</c> — IS WHAT MAKES IT SAFE. GodotSharp
    /// (and STS2's own logger) bind and JIT perfectly well in a process that merely has the DLL on its probing
    /// path, and then SEGFAULT in native interop, which no <c>catch</c> can see. A <c>try</c> only covers the
    /// other case, where the assembly fails to LOAD at all. Readers today: the static-background tracker's
    /// deferred probe, <c>BrowserPortFile</c>, <c>CouchCoopWebSocketConnection.ApplyBrowserSettings</c>,
    /// <c>CouchCoopAtlasManifest.Warm</c>, <c>CouchCoopCacheRoot</c>'s game-data-dir resolution, and
    /// <c>CouchCoopLog</c>.
    /// </para>
    /// <para>
    /// IT LIVES HERE, ON THE ROOT TYPE, BECAUSE THAT IS THE ONLY SINGLE-INSTANCE HOME. <c>Server/*.cs</c> is
    /// link-compiled into <c>CouchCoop.Mod.HotReload</c> as well, so a latch stored on any type in that folder
    /// exists TWICE with independent statics, and <c>Init</c> could only ever set the <c>CouchCoop.Mod</c> copy.
    /// The hot generation really does construct its own <c>SpirectlAssetBinaryCache</c>
    /// (<c>CouchCoopHotServerGeneration</c>), so a per-assembly latch would have left the reloaded generation
    /// resolving a DIFFERENT cache root than its host. <c>CouchCoopMod</c> is not link-compiled, so both
    /// assemblies reach this one field through the project reference — the same route
    /// <c>CachedSpirectlAssetHttpAdapter</c> already takes to <see cref="IsHeadlessClient"/>.
    /// </para>
    /// </remarks>
    public static volatile bool EngineAvailable;

    // True when this instance has NO real window — a spawned headless CLIENT (above) OR a host launched with
    // Godot's `--headless` (dev/server). Any windowless instance needs the 16:9 viewport force: with no window and
    // no saved aspect setting the root viewport goes Auto→Expand → a ~1920x1920 SQUARE that vertically offsets the
    // 16:9 content, which the browser mirror then shows mis-framed (the menu shifted down under a black band). A
    // windowed host is deliberately NOT forced — NGame's own display apply owns its real window.
    // Primary signal is the headless display server; command line is a defensive fallback in case DisplayServer
    // isn't queryable this early in Init.
    private static bool IsHeadlessDisplay()
    {
        try
        {
            if (Godot.DisplayServer.GetName() == "headless")
            {
                return true;
            }
        }
        catch
        {
            // DisplayServer not ready / unavailable this early — fall through to the command-line check.
        }

        return Array.IndexOf(Environment.GetCommandLineArgs(), "--headless") >= 0;
    }

    public static CouchCoopRuntimeHost Init()
    {
        lock (Gate)
        {
            // FIRST OF ALL, above even the build guard: Init only ever runs inside a real game process, so this
            // is the one place that may say so. Everything gated on the latch — STS2's own logger, the cache
            // root's game-data-dir resolution, the static-background probe, the atlas walk — is a native call
            // that SEGFAULTS rather than throwing when there is no engine behind it, so the flag has to be on
            // before the first of them. It sits above the seat build guard below because that guard's refusal
            // is exactly the kind of line a player's godot.log has to carry.
            EngineAvailable = true;
            Checkpoint("mod-init");

            // FIRST, before a patch is applied, a cache is warmed or a runtime exists: a seat running a
            // different CouchCoop build than the host that spawned it reports that and terminates. Everything
            // below this line assumes the two sides of the browser wire contract were compiled together, and
            // the failure when they were not is either silent divergence or an opaque readiness timeout.
            // No-op on a host, and on a seat whose host predates the check.
            if (IsHeadlessClient) HeadlessSeatBuildGuard.EnforceOrExit();

            // Then the log path, BEFORE the first thing that can report a host issue. It used to be set in
            // StartHostUiServices, a hundred lines below the Harmony patch block — so any issue raised during
            // patching captured no log excerpt at all, which is exactly the failure whose evidence lives in
            // that file. Nothing reads it earlier than this, and every reader (ConnectionRegistry.Connected,
            // BeginAttempt, ReportHostIssue, the seat launcher) resolves it at call time.
            InitializeHostLogPath();

            // A spawned seat has no local player. Its copy of the global input map must not retain joypad actions,
            // or one controller connected to the host can drive both the host and its headless seat. Do this before
            // any game screen can consume input; the host's map is deliberately untouched.
            if (IsHeadlessClient)
            {
                var removedJoypadBindings = HeadlessJoypadInputMapIsolation.RemoveJoypadBindings();
                CouchCoopLog.Info($"headless input map: removed {removedJoypadBindings} joypad binding(s)");
            }

            CouchCoopLocalization.Initialize();

            // Resolve (and, when the game build or a cache generation has moved, purge) the on-disk cache before
            // ANYTHING can read or write it. Everything those caches hold is derived from the game's content, so
            // a cache written by another build — or by the other Steam branch — serves wrong pixels for the right
            // key. It goes first because it can: no runtime, no game state, just the install on disk and Steam.
            //
            // AND IT CANNOT TAKE INIT WITH IT. A cache is an optimisation; every line below this one is the
            // mod. Warm() is total in its own right, but the failure that is total-proof from the inside is
            // not the only one — this type failing to INITIALISE surfaces here, at the first touch, and no
            // try inside it would ever run. Above this frame there is only the loader's blanket catch, which
            // logs and returns: a mod that does nothing, because a cache could not be set up.
            try
            {
                Server.CouchCoopCacheRoot.LogSink = Session.CouchCoopLog.Info;
                Server.CouchCoopCacheRoot.Warm();
            }
            catch (Exception exception)
            {
                Session.CouchCoopLog.Info(
                    $"cache unavailable: {exception.GetType().Name}: {exception.Message} "
                    + "-- continuing without one");
            }

            // Same hook, same reason, for the per-seat user-dir seeder: its preparation failures must not be
            // silent, especially where stderr goes nowhere. Error level — the connections report's log excerpt
            // keeps only those.
            Session.HeadlessUserDirSeeder.LogSink = Session.CouchCoopLog.Error;

            // Enumerate the atlas pages THIS build ships, once, while we are on the main thread with an engine.
            // Published on every session envelope so the browser's idle prefetch stops guessing: the game's
            // public-beta branch repacked the card atlas from three pages to two, and a client asking for the
            // page that no longer exists costs the host a failed main-thread ResourceLoader.Load per new client.
            // Safe to leave unknown — the client keeps its own compiled-in list — so this never blocks Init.
            Server.CouchCoopAtlasManifest.LogSink = Session.CouchCoopLog.Info;
            Server.CouchCoopAtlasManifest.Warm();

            // Crash-proof self-reaper: if the host dies without killing us (e.g. it segfaults), terminate this
            // orphaned headless instead of lingering invisibly. Idempotent + no-op when not host-spawned.
            if (IsHeadlessClient) HeadlessHostWatchdog.Start();

            if (_runtime is not null)
            {
                // Any windowless instance (headless client OR a --headless host) needs the 16:9 viewport force so
                // its mirror isn't a square-viewport mis-frame; a windowed host keeps its own NGame display apply.
                if (IsHeadlessClient || IsHeadlessDisplay()) HeadlessViewportConfigurator.Configure();
                if (!IsHeadlessClient) InitializeQrHostPanel();
                return _runtime;
            }

            // KEEP THIS ABOVE EVERY Apply() BELOW. Harmony's detours go through MonoMod, which dlopens a native
            // exec-helper that resolves libgcc's unwinder from the process's GLOBAL symbol namespace — and the
            // game's runtime does not leave it there. Without this preload the dlopen fails with
            // "undefined symbol: _Unwind_RaiseException" and EVERY patch below dies, each one logging its own
            // failure and degrading on its own terms: no command-line override (so a seat cannot join), no
            // transport bookkeeping, and no lobby-screen mount signal — which costs the lobby its QR button for
            // the whole session. The spirectl runtime preloads it too, but it does that when the runtime is
            // COMPOSED, which is a hundred lines below here.
            EnsureMonoModCanPatch();
            // FIRST OF THE PATCHES, and the order is the whole point. A seat's user:// is isolated per slot;
            // Steam Cloud storage is not — it is addressed by (account, app) and is therefore the SAME store the
            // player's own game writes to. This closes every seat→cloud write and skips the seat's startup cloud
            // sync, so a seat can neither overwrite the player's cloud saves nor block its own startup
            // reconciling against them. Seat-only; the host keeps cloud saves.
            //
            // It used to sit NINTH, after two cache warms and eight other Apply() calls — including the
            // command-line override immediately below, which is what lets a seat join at all. A throw from any of
            // them left a seat that had joined, was playing, and was writing into the account's cloud storage
            // with no protection installed. Nothing above it here but EnsureMonoModCanPatch(), which it needs;
            // everything that can fail belongs below the protection, not above it.
            if (IsHeadlessClient) HeadlessSeatCloudIsolationGuard.EnforceOrExit();
            // Feed the game an env-gated override table through CommandLineHelper. EMPTY on a host (it hosts
            // normally, Steam included — the old FastmpPatch forced ENet on everyone and made a real Steam
            // session impossible); on a headless couch seat it re-materializes "fastmp=join" + "clientId=<netId>"
            // from the environment so the seat needs NO game CLI args of its own.
            CommandLineOverridePatch.Apply();
            // Track what transport the live host is actually running (host netId; whether an ENet listener exists
            // for couch seats to join) so the seat launcher and the browser server stop ASSUMING ENet. Bookkeeping
            // only at this stage — it changes no hosting behavior.
            CouchCoopHostTransportPatch.Apply();
            // A Steam-created save records its host by SteamID64. If Steam is offline, preserve that identity on
            // the ENet fallback so the loaded lobby matches its existing host seat; ordinary and ENet-created
            // saves stay on their native paths.
            if (!IsHeadlessClient) SavedRunHostIdentityPatch.Apply();
            // A seat joining a STEAM-hosted session must know the host answers to a SteamID64, not the hardcoded
            // ENetClient.HostNetId of 1 — otherwise NetClientGameService.SendMessage throws on every 200ms
            // heartbeat echo. No-op on an ENet-hosted session (COUCHCOOP_HOST_NETID is 1).
            if (IsHeadlessClient) HostNetIdPatch.Apply();
            // Escape hatch (no in-game join UI exists): COUCHCOOP_JOIN_HOST=ip[:port] redirects the ONE place
            // every ENet join is constructed. Inert unless the env var is set, so an ordinary player is unaffected.
            JoinHostOverridePatch.Apply();
            // Tell the QR panel controller when a lobby screen is readied, so it does not have to go
            // looking: it used to walk the WHOLE scene tree four times a second for the life of the process,
            // which is the largest thing this mod did on a machine nobody was using it from. Host-only — a
            // headless seat renders no panels — and mounted here, with the other patches, because it must be
            // installed before the first lobby screen runs its _Ready.
            if (!IsHeadlessClient) LobbyScreenMountPatch.Apply();
            // Patch ENetClient.Update() to skip while _isConnected == false, preventing the
            // NetServiceUpdateLoop from draining and discarding the handshake-ack before
            // SendAndWaitForNetIdAck can consume it (fixes headless join timeout).
            ENetHandshakePatch.Apply();
            // Headless clients render sound to nobody. STS2 audio is FMOD (a native GDExtension), which Godot's
            // --headless does NOT silence, so mute it at the source. Host-only patch. This severs every game→FMOD
            // forward but does NOT stop FMOD's always-on native mixer/DSP thread — HeadlessFmodShutdown does that.
            if (IsHeadlessClient) HeadlessAudioMutePatch.Apply();
            // A headless instance that permanently loses its ENet connection (host process died, or dropped it
            // mid-run) has no human to dismiss STS2's network-error / "report a bug" modal and no retry of its
            // own — it used to sit behind that dialog forever, holding its seat's slot. Suppress the popup and
            // exit cleanly instead, so the host sees the process go, reports the seat offline with the "reload
            // the saved run" guidance, and a rejoin spawns a fresh instance. Host-only patch by construction.
            if (IsHeadlessClient) HeadlessDisconnectExitPatch.Apply();
            // Reclaim the frame-independent FMOD mixer/DSP thread by tearing the FMOD system down once it's up:
            // first disables the FmodManager autoload's per-frame FmodServer.update() (else shutdown SIGSEGVs), then
            // calls FmodServer.shutdown().
            if (IsHeadlessClient) HeadlessFmodShutdown.Install();
            // Opt-in CPU attribution logger (COUCHCOOP_HEADLESS_PROFILE=1): logs the per-frame process/physics/
            // render split to the per-slot godot.log so we can see where the headless CPU goes. No-op otherwise.
            // Also installs on a plain `--headless` instance, which is where the memory levers are A/B'd — its
            // `[couchcoop][memory] rss_mb=` line reads /proc/self/statm and so measures the reclaim without
            // needing ptrace access from outside (yama blocks that for a game the profiler did not spawn).
            //
            // …and on a WINDOWED host, which is the one machine whose idle cost is the product requirement: the
            // mod must leave a player's frame budget indistinguishable from an unmodded game while nobody is
            // connected, and that claim is only falsifiable with a number from the display instance itself. The
            // env var alone gates it (it used to also require a windowless display server, which excluded exactly
            // the instance we need to measure); unset, nothing is installed and no timer is created, so an
            // ordinary player's launch is untouched. The type keeps its `Headless` name — its per-frame Godot
            // Performance monitors and process-CPU sampling are display-server agnostic.
            if (IsHeadlessClient || Environment.GetEnvironmentVariable("COUCHCOOP_HEADLESS_PROFILE") == "1")
            {
                CouchCoopHeadlessCpuProfiler.Install();
            }
            // MEMORY saver for a headless CLIENT:
            // Godot's dummy renderer keeps a full CPU copy of every texture's pixels forever (a real renderer
            // uploads to the GPU and frees it), which measured 456MB across 1,491 images on a live 1374MB seat
            // against 227MB in the drawing host. Releases the VRAM-compressed tier, which nothing in a process
            // that never draws can consume. Headless CLIENT only — a `--headless` dev HOST still serves asset
            // extraction from those very images (see the /res guard in CouchCoopBrowserServer).
            if (IsHeadlessClient)
            {
                HeadlessTextureImageEvictor.Install();
            }
            // CPU saver for any WINDOWLESS instance:
            // freezes decorative per-frame animators (intent bob / energy-orb spin, whose transform churn otherwise
            // drives a mirror scene-delta EVERY frame), particle + spine simulation, AND throttles Engine.MaxFps
            // while idle — all CPU the mirror never consumes (the browser reproduces the motion on its own rAF
            // clock). Runs for a spawned headless CLIENT and for a `--headless` dev/server HOST alike: both are
            // windowless (no human watching their own screen) and both serve the browser mirror, which is the sole
            // consumer. A WINDOWED display host is excluded — its own on-screen animators must keep running.
            if (IsHeadlessClient || IsHeadlessDisplay()) CouchCoopHeadlessVisualSuspender.Install();
            // Deadlock backstop for the same freeze, WINDOWLESS ONLY (positive COUCHCOOP_HEADLESS_DEATH_DELAY_CAP
            // overrides the safe default):
            // A dying creature waits on every death delayer attached to it and nothing bounds that wait; the one
            // delayer in the game reports finished off a SPINE animation event — which a spine-frozen headless
            // instance never raises, so that boss death would hang forever. Caps the wait at 10s, returning
            // normally. A windowed instance runs its spine and must keep the game's exact pacing.
            if (IsHeadlessClient || IsHeadlessDisplay()) HeadlessDeathDelayCapPatch.Apply();

            // CouchCoop's scene wire is parent-relative. The mirror composes transforms down its element tree, so a
            // container move ships one local update rather than rewriting every descendant.
            Spirectl.Sts2.Live.Sts2SceneWatchRuntimeSettings.EmitLocalTransforms = true;

            _runtime = new CouchCoopRuntimeHost(CouchCoopRuntimeDependencies.FromFactory(Sts2EmbeddableRuntimeFactory.Create()));
            _ = _runtime.Capabilities;
            // Let the host transport size its ENet listener from the LIVE lobby cap instead of the maxClients it
            // is handed — see CouchCoopHostTransport.MaxLobbyPlayersProbe for why that argument cannot be trusted
            // once a multiplayer limit mod is installed. Safe to set on a seat too (it never hosts).
            Session.CouchCoopHostTransport.MaxLobbyPlayersProbe =
                new Session.CouchCoopLobbyParticipation(_runtime).MaxLobbyPlayers;
            // Seat-only: keep this instance's player names in step with the host's durable roster
            // (mp_names.json), which the game itself reads only once at startup — otherwise everyone who joined
            // AFTER this seat booted renders as a raw netId. See HeadlessClientNameSync for why it owns its own
            // clock rather than riding the browser server's state observer.
            if (IsHeadlessClient) Session.HeadlessClientNameSync.Start(_runtime);
            if (IsHeadlessClient) Session.HeadlessConnectionReporter.Initialize(
                _runtime,
                HeadlessDisconnectExitPatch.RequestExit);
            StartHostUiServices(_runtime);
            StartSpinePrerenderIfRequested(_runtime);
            StartGeoclipPrerenderIfRequested(_runtime);
            StartStaticBackgroundPrerenderIfRequested(_runtime);
            // Any windowless instance (headless client OR a --headless host) needs the 16:9 viewport force so its
            // mirror isn't a square-viewport mis-frame; a windowed host keeps its own NGame display apply.
            if (IsHeadlessClient || IsHeadlessDisplay()) HeadlessViewportConfigurator.Configure();
            if (!IsHeadlessClient) InitializeQrHostPanel();
            return _runtime;
        }
    }

    public static CouchCoopHostUiSnapshot HostUiSnapshot
    {
        get
        {
            lock (Gate)
            {
                return _hostUi?.Snapshot ?? _hostUiStartupFailure ?? CouchCoopHostUiSnapshot.Unavailable([]);
            }
        }
    }

    /// <summary>
    /// Reflection target for the hot-reload shell (<c>CouchCoopHotReloadProtocol.RefreshOverlayLayout</c>)
    /// after a new layout is accepted. Renaming this REQUIRES updating the method-name string there.
    /// </summary>
    public static void RefreshQrHostPanelLayout()
    {
        lock (Gate)
        {
            CouchCoopQrHostPanelController.RefreshAll();
        }
    }

    /// <summary>
    /// Latest runtime state for the lobby gate, or <see langword="null"/> when the state capability is
    /// unavailable. Same seam <see cref="Session.CouchCoopLobbyParticipation"/> reads through, so the
    /// button's visibility and the headless-launch window can never be answered from different sources.
    /// </summary>
    /// <remarks>
    /// The runtime reference is taken under the lock but the state pull happens OUTSIDE it: the pull
    /// marshals onto the Godot main thread, and holding the mod's gate across that is how you deadlock
    /// a shutdown that is already holding it.
    /// </remarks>
    public static StateSnapshot? TryGetLobbyState()
    {
        CouchCoopRuntimeHost? runtime;
        lock (Gate)
        {
            runtime = _runtime;
        }

        if (runtime is null || !runtime.HasCapability(CouchCoopRuntimeHost.StateCapability))
        {
            return null;
        }

        try
        {
            var result = runtime.GetCurrentState(new CurrentStateRequest());
            return result.Success ? result.State : null;
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"lobby state read failed detail={exception.GetType().Name}: {exception.Message}");
            return null;
        }
    }

    public static IHotServerHost? HotServerHost
    {
        get
        {
            lock (Gate)
            {
                return _hostUi?.HotServerHost;
            }
        }
    }

    /// <summary>
    /// Broadcast a <c>server-reload</c> envelope carrying <paramref name="reason"/> to every attached browser and
    /// close their sockets, leaving the listener up. The headless disconnect-exit sequence's "last gasp": the
    /// viewers of a headless that is about to quit learn WHY, so they fall back to the host's picker (and
    /// reconnect there) instead of retrying a port that is going away.
    /// <para>No-op when the host UI never started or the browser server isn't the built-in host.</para>
    /// </summary>
    internal static Task CloseBrowserConnectionsAsync(string reason, CancellationToken cancellationToken = default)
    {
        HotReloadableBrowserServerHost? server;
        lock (Gate)
        {
            server = _hostUi?.HotServerHost as HotReloadableBrowserServerHost;
        }

        return server?.CloseConnectionsAsync(reason, cancellationToken) ?? Task.CompletedTask;
    }

    public static void ActivateHotReloadGeneration(ICouchCoopHotGeneration generation, int generationNumber)
    {
        lock (Gate)
        {
            if (_hostUi is null)
            {
                throw new InvalidOperationException("Host UI services are not running.");
            }

            _hostUi.ActivateHotReloadGenerationAsync(generation, generationNumber)
                .GetAwaiter()
                .GetResult();
        }
    }

    public static void Shutdown()
    {
        lock (Gate)
        {
            if (IsHeadlessClient) Session.HeadlessConnectionReporter.Stop();
            // Cancel WITHOUT joining the prerender task on purpose: Shutdown holds the Gate lock on the Godot
            // main thread, and each clip render blocks on main-thread marshaling, so awaiting the task here
            // would deadlock (or, at best, always burn a join timeout). The job observes the token between
            // catalog items and mid-await, so it winds itself down shortly after this cancel.
            _spinePrerenderStop?.Cancel();
            _spinePrerenderStop?.Dispose();
            _spinePrerenderStop = null;
            _spinePrerenderTask = null;
            _spinePrerenderStarted = false;

            // Same cancel-without-joining contract as the spine sweep above, and here it is not merely prudent:
            // a geoclip bake BLOCKS on main-thread marshaling, and we are on the main thread holding the Gate.
            _geoclipPrerenderStop?.Cancel();
            _geoclipPrerenderStop?.Dispose();
            _geoclipPrerenderStop = null;
            _geoclipPrerenderTask = null;
            _geoclipPrerenderStarted = false;

            // Same cancel-without-joining contract as the spine sweep above, for the same reason: a background
            // render blocks on main-thread marshaling and we are holding the Gate on the main thread.
            _bgPrerenderStop?.Cancel();
            _bgPrerenderStop?.Dispose();
            _bgPrerenderStop = null;
            _bgPrerenderTask = null;
            _bgPrerenderStarted = false;

            CouchCoopQrHostPanelController.Shutdown();
            CouchCoopLocalization.Shutdown();

            if (_hostUi is not null)
            {
                _hostUi.DisposeAsync().AsTask().GetAwaiter().GetResult();
                _hostUi = null;
            }

            if (_runtime is IDisposable disposable)
            {
                disposable.Dispose();
            }

            _runtime = null;
            _hostUiStartupFailure = null;
        }
    }

    private static void StartSpinePrerenderIfRequested(CouchCoopRuntimeHost runtime)
    {
        if (IsHeadlessClient || _spinePrerenderStarted || !IsSpinePrerenderTriggered())
        {
            return;
        }

        _spinePrerenderStarted = true;
        _spinePrerenderStop = new CancellationTokenSource();
        var cancellationToken = _spinePrerenderStop.Token;
        var cache = new SpirectlAssetBinaryCache();
        // #14: the prerender job bakes through the same admission path as a live request, so give its provider the
        // same live instance count — a warmup bake must yield to the games exactly like a client-driven one.
        var clips = new CouchCoopSpineClipProvider(runtime.Assets, cache, null, CountGameInstances);
        SpinePrerenderLog($"spine-prerender requested cacheRoot={cache.RootPath ?? "disabled"}");
        _spinePrerenderTask = Task.Run(async () =>
        {
            try
            {
                await new CouchCoopSpinePrerenderJob(runtime, clips, SpinePrerenderLog).RunAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Shutdown cancellation is expected; the job emits its own cancelled summary when possible.
            }
            catch (Exception exception)
            {
                SpinePrerenderLog($"spine-prerender failed detail={exception.GetType().Name}: {exception.Message}");
            }
        }, cancellationToken);
    }

    /// <summary>
    /// Bake a single-pose GEOCLIP (per-part posed geometry) for every catalog entry, ahead of the first client
    /// that asks for one — the delta twin of <see cref="StartSpinePrerenderIfRequested"/>.
    /// </summary>
    /// <remarks>
    /// The sweep stays opt-in: it is a warming tool, not the product path, and a host that bakes what its viewers
    /// ask for should not also spend an hour baking a whole catalog nobody requested.
    /// </remarks>
    private static void StartGeoclipPrerenderIfRequested(CouchCoopRuntimeHost runtime)
    {
        if (IsHeadlessClient || _geoclipPrerenderStarted || !IsGeoclipPrerenderTriggered())
        {
            return;
        }

        _geoclipPrerenderStarted = true;
        _geoclipPrerenderStop = new CancellationTokenSource();
        var cancellationToken = _geoclipPrerenderStop.Token;
        // Its own store/provider instances, but NOT its own single-flight or its own disk:
        // CouchCoopGeoclipProvider.InFlight is static and the store is addressed by path, so a client that asks
        // for a pose this sweep is mid-bake on coalesces onto the same bake instead of starting a second
        // main-thread render.
        var store = new CouchCoopGeoclipStore();
        var geoclips = new CouchCoopGeoclipProvider(new CouchCoopRuntimeGeoclipBaker(runtime.SpineGeoClipBaker, runtime), store, SpinePrerenderLog);
        SpinePrerenderLog($"geoclip-prerender requested store={store.RootPath ?? "disabled"}");
        _geoclipPrerenderTask = Task.Run(async () =>
        {
            try
            {
                await new CouchCoopGeoclipPrerenderJob(runtime, geoclips, SpinePrerenderLog)
                    .RunAsync(cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Shutdown cancellation is expected; the job emits its own cancelled summary when possible.
            }
            catch (Exception exception)
            {
                SpinePrerenderLog($"geoclip-prerender failed detail={exception.GetType().Name}: {exception.Message}");
            }
        }, cancellationToken);
    }

    /// <summary>
    /// Bake every combat background ahead of the first client that asks for one. Separate trigger from the spine
    /// sweep because the two cost wildly different amounts: this is tens of renders, that one is ~1 175 bakes.
    /// </summary>
    /// <remarks>
    /// The job class is the seam a host-UI "prerender assets" action will call; the flag is how it is reachable
    /// (and testable) before that UI exists.
    /// </remarks>
    private static void StartStaticBackgroundPrerenderIfRequested(CouchCoopRuntimeHost runtime)
    {
        if (IsHeadlessClient
            || _bgPrerenderStarted
            || !IsStaticBackgroundPrerenderTriggered())
        {
            return;
        }

        _bgPrerenderStarted = true;
        _bgPrerenderStop = new CancellationTokenSource();
        var cancellationToken = _bgPrerenderStop.Token;
        var cache = new SpirectlAssetBinaryCache();
        // Its own provider instance, but NOT its own single-flight: CouchCoopStaticBackgroundProvider.InFlight is
        // static, so a client that asks for a variant this sweep is mid-render on coalesces onto the same render
        // instead of starting a second one. The disk cache is shared too; only the small memory map is per-instance.
        var backgrounds = new CouchCoopStaticBackgroundProvider(runtime.Assets, cache, SpinePrerenderLog);
        SpinePrerenderLog($"bg-prerender requested cacheRoot={cache.RootPath ?? "disabled"}");
        _bgPrerenderTask = Task.Run(async () =>
        {
            try
            {
                await new CouchCoopStaticBackgroundPrerenderJob(runtime, backgrounds, SpinePrerenderLog)
                    .RunAsync(cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Shutdown cancellation is expected; the job emits its own cancelled summary when possible.
            }
            catch (Exception exception)
            {
                SpinePrerenderLog($"bg-prerender failed detail={exception.GetType().Name}: {exception.Message}");
            }
        }, cancellationToken);
    }

    /// <summary>
    /// #14: how many STS2 instances are alive on this machine right now, INCLUDING this one — the host's seat table
    /// when we own one, otherwise the headless slot's lower bound. Resolved lazily per call (the browser server, and
    /// with it the seat table, may start after the prerender job does) and never throws: an unresolvable count reads
    /// as 1, which is the never-degrade behavior.
    /// </summary>
    private static int CountGameInstances()
    {
        try
        {
            var manager = (_hostUi?.HotServerHost as IHotServerHost)?.HeadlessManager as HeadlessClientManager;
            return SpineBakeBudget.CountGameInstances(
                manager?.DescribeSeats(),
                Environment.GetEnvironmentVariable("COUCHCOOP_HEADLESS_SLOT"));
        }
        catch
        {
            return 1;
        }
    }

    // Resolve the prerender trigger from a defensive UNION of arg sources plus an env var. We can't rely on
    // Environment.GetCommandLineArgs() alone: inside Godot's embedded CoreCLR host the game's native argv is not
    // surfaced there (it returns args without the game's flag), so the launch `--prerender-spines` flag was silently
    // dropped. Godot.OS.GetCmdlineArgs()/GetCmdlineUserArgs() see the real native argv; each is probed in its own
    // try/catch so arg probing can never throw during Init. COUCHCOOP_PRERENDER_SPINES=1 is a guaranteed alternative.
    private static bool IsSpinePrerenderTriggered()
        => IsSpinePrerenderRequested(TryGetGodotCmdlineArgs())
            || IsSpinePrerenderRequested(TryGetGodotCmdlineUserArgs())
            || IsSpinePrerenderRequested(Environment.GetCommandLineArgs())
            || IsSpinePrerenderEnvRequested(Environment.GetEnvironmentVariable("COUCHCOOP_PRERENDER_SPINES"));

    // Same defensive union for the GEOCLIP (spine-delta) sweep. The union is not optional here either: the
    // embedded-argv problem is a property of the host, not of the flag, and this flag would be dropped exactly
    // the way `--prerender-spines` silently was. Split into a pure overload so each arm can be driven
    // independently by a test — a union that quietly lost one source would otherwise still pass every test that
    // set the env var.
    private static bool IsGeoclipPrerenderTriggered()
        => IsGeoclipPrerenderTriggered(
            TryGetGodotCmdlineArgs(),
            TryGetGodotCmdlineUserArgs(),
            Environment.GetCommandLineArgs(),
            Environment.GetEnvironmentVariable(GeoclipPrerenderEnvVar));

    /// <summary>The flag that schedules the spine-delta sweep. Deliberately not <c>--prerender-spines</c>.</summary>
    public const string GeoclipPrerenderFlag = "--prerender-spine-deltas";

    public const string GeoclipPrerenderEnvVar = "COUCHCOOP_PRERENDER_SPINE_DELTAS";

    public static bool IsGeoclipPrerenderTriggered(
        IEnumerable<string> godotArgs,
        IEnumerable<string> godotUserArgs,
        IEnumerable<string> processArgs,
        string? envValue)
        => IsGeoclipPrerenderRequested(godotArgs)
            || IsGeoclipPrerenderRequested(godotUserArgs)
            || IsGeoclipPrerenderRequested(processArgs)
            || IsSpinePrerenderEnvRequested(envValue);

    public static bool IsGeoclipPrerenderRequested(IEnumerable<string> args)
        => args.Any(candidate => string.Equals(candidate, GeoclipPrerenderFlag, StringComparison.Ordinal));

    // Same defensive union for the background sweep — the embedded-argv problem above is not spine-specific.
    private static bool IsStaticBackgroundPrerenderTriggered()
        => IsStaticBackgroundPrerenderRequested(TryGetGodotCmdlineArgs())
            || IsStaticBackgroundPrerenderRequested(TryGetGodotCmdlineUserArgs())
            || IsStaticBackgroundPrerenderRequested(Environment.GetCommandLineArgs())
            || IsSpinePrerenderEnvRequested(Environment.GetEnvironmentVariable("COUCHCOOP_PRERENDER_BACKGROUNDS"));

    private static string[] TryGetGodotCmdlineArgs()
    {
        try
        {
            return Godot.OS.GetCmdlineArgs();
        }
        catch
        {
            return [];
        }
    }

    private static string[] TryGetGodotCmdlineUserArgs()
    {
        try
        {
            return Godot.OS.GetCmdlineUserArgs();
        }
        catch
        {
            return [];
        }
    }

    // Writes the message to BOTH stderr and the Godot log. Launcher-side stdio capture is useful while attached,
    // while the STS2-logger write leaves a durable entry in godot.log (with the [INFO] tag). Runs from a thread-pool
    // thread, so the logger call is guarded (CouchCoopLog) — logging must never kill the job — while Console.Error stays outside the catch
    // so it always emits when the game is attached to a terminal.
    private static void SpinePrerenderLog(string message)
    {
        CouchCoopLog.Stderr(message);
        CouchCoopLog.Info(message);
    }

    public static bool IsSpinePrerenderRequested(IEnumerable<string> args)
        => args.Any(candidate => string.Equals(candidate, "--prerender-spines", StringComparison.Ordinal));

    public static bool IsStaticBackgroundPrerenderRequested(IEnumerable<string> args)
        => args.Any(candidate => string.Equals(candidate, "--prerender-backgrounds", StringComparison.Ordinal));

    public static bool IsSpinePrerenderEnvRequested(string? value) => value == "1";

    private static bool _discoveryArmSubscribed;

    /// <summary>
    /// Subscribe the deferred LAN/WAN services to the panel controller's first host-lobby tick.
    /// </summary>
    /// <remarks>
    /// Subscribed once per process (the handler is idempotent, and <c>StartDiscoveryServices</c> self-latches,
    /// so the tick can raise it every 0.25s for free). Reads <c>_hostUi</c> through the field rather than
    /// capturing the instance, so a hot-reload that replaces the services still arms the live one — and takes
    /// <c>Gate</c> only to read that field, never across the call, for the reason
    /// <see cref="TryGetLobbyState"/> spells out.
    /// </remarks>
    private static void ArmDiscoveryOnFirstHostLobby()
    {
        if (_discoveryArmSubscribed)
        {
            return;
        }

        _discoveryArmSubscribed = true;
        CouchCoopQrHostPanelController.HostLobbyPresented += () =>
        {
            CouchCoopHostUiServices? hostUi;
            lock (Gate)
            {
                hostUi = _hostUi;
            }

            hostUi?.StartDiscoveryServices();
        };
    }

    private static void StartHostUiServices(CouchCoopRuntimeHost runtime)
    {
        CouchCoop.Mod.Connections.ConnectionRegistry.HostGameVersion =
            string.IsNullOrWhiteSpace(runtime.Capabilities.GameVersion)
                ? CouchCoopCacheRoot.Content.GameVersion
                : runtime.Capabilities.GameVersion;
        try
        {
            // A windowed/display HOST defers the LAN discovery responder, the `.local` mDNS name and the
            // secure-origin WAN fetch until a HOST LOBBY is actually on screen — see
            // CouchCoopHostUiServices.StartDiscoveryServices. Only the browser listener comes up here, which
            // is the idle server the product accepts and which every QA harness expects at launch.
            //
            // A headless SEAT is NOT deferred: it has no lobby screen and no panel controller to raise the
            // trigger, it is spawned only once co-op is already in use (so there is no idle cost to save),
            // and its secure listener must be up before the host redirects a browser to it.
            _hostUi = new CouchCoopHostUiServices(
                runtime,
                preferredPort: ResolvePreferredPort(),
                deferDiscoveryServices: !IsHeadlessClient,
                // A spawned seat has no display lobby and must not impersonate the host's support trail.
                checkpoints: IsHeadlessClient ? null : LobbyCheckpoints);
            _hostUiStartupFailure = null;
            _hostUi.StartAsync().GetAwaiter().GetResult();
            if (!IsHeadlessClient)
            {
                ArmDiscoveryOnFirstHostLobby();
            }
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"host-ui diagnostic code={CouchCoopHostUiServices.HostUiStartupFailedCode} detail={exception.GetType().Name}: {exception.Message}");
            // B7: the outer twin of B3. StartAsync catches the socket-shaped failures itself; anything that
            // escapes to here (a bad static root, a construction fault) leaves the host with no browser
            // server at all, which the player-facing log must report identically — the distinction between
            // the two catch sites is a developer's, and the stderr line above already carries it.
            CouchCoop.Mod.Connections.ConnectionRegistry.Shared.ReportHostIssue("host-service-failed",
                "The browser connection service could not start.", "Restart the game. If the service still fails, copy this report.", exception.ToString());
            _hostUiStartupFailure = CouchCoopHostUiSnapshot.Unavailable([
                new CouchCoopHostUiDiagnostic(
                    CouchCoopHostUiServices.HostUiStartupFailedCode,
                    "The CouchCoop host UI could not be started.",
                    exception.GetType().Name)
            ]);

            if (_hostUi is not null)
            {
                try
                {
                    _hostUi.DisposeAsync().AsTask().GetAwaiter().GetResult();
                }
                catch (Exception disposeException)
                {
                    CouchCoopLog.Stderr($"host-ui diagnostic code={CouchCoopHostUiServices.HostUiStartupDisposeFailedCode} detail={disposeException.GetType().Name}: {disposeException.Message}");
                }

                _hostUi = null;
            }
        }
    }

    // The browser server defaults to 13337 but reads COUCHCOOP_PREFERRED_PORT so several game
    // instances running side by side can each be pinned to a distinct port.
    // CouchCoopBrowserServer still port-walks upward if the chosen port is taken.
    private const int DefaultPreferredPort = 13337;

    private static int ResolvePreferredPort()
    {
        var configured = Environment.GetEnvironmentVariable("COUCHCOOP_PREFERRED_PORT");
        return int.TryParse(configured, out var port) && port is > 0 and <= ushort.MaxValue
            ? port
            : DefaultPreferredPort;
    }

    /// <summary>
    /// Point the connections panel (and every copyable report) at this process's <c>godot.log</c>.
    /// </summary>
    /// <remarks>
    /// Guarded because it is now the FIRST engine call <c>Init</c> makes, and a diagnostic path must never be
    /// the reason mod init fails: without the path, rows simply carry no log excerpt, which is what they did
    /// before this existed.
    /// </remarks>
    private static void InitializeHostLogPath()
    {
        try
        {
            CouchCoop.Mod.Connections.ConnectionRegistry.HostLogPath =
                Godot.ProjectSettings.GlobalizePath("user://logs/godot.log");
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"host log path unresolved detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// Satisfy Harmony's one native precondition, and say in <c>godot.log</c> whether it worked — or, on a
    /// platform that has no such precondition, whether patching works at all (see <see cref="ProbeNativePatching"/>).
    /// </summary>
    /// <remarks>
    /// <para>
    /// The preload itself lives in spirectl, which owns this knowledge and preloads for its own hooks — this is
    /// only the call an embedder has to make because it patches BEFORE composing that runtime. See
    /// <c>Sts2MonoModNativeDependencies</c> for the mechanism; it is idempotent and per-process, so the bridge's
    /// later call is free.
    /// </para>
    /// <para>
    /// Logged through <see cref="CouchCoopLog"/> as well as stderr ON PURPOSE. Every other patch diagnostic in
    /// this mod is stderr-only, which a launcher captures to its own file — and when this exact failure happened
    /// live, <c>godot.log</c> (the file anyone actually reads, and the one the connection report links to) held
    /// six CouchCoop lines and not one of them said why the QR button was missing.
    /// </para>
    /// </remarks>
    private static void EnsureMonoModCanPatch()
    {
        try
        {
            var preload = Spirectl.Sts2.Live.Sts2MonoModNativeDependencies.EnsureLoaded();
            if (!preload.Supported)
            {
                // Not a Linux process: there is no libgcc preload to make, and its absence is not a fault.
                // That is NOT the same as "patching works here", which is what this early return used to
                // assume. MonoMod still loads a native exec-helper on the first patch of the process, and on
                // macOS the hardened runtime is entitled to refuse it — so ASK, once, with a patch of our own.
                ProbeNativePatching();
                return;
            }

            if (preload.Loaded)
            {
                CouchCoopLog.Stderr("monomod unwinder preloaded");
                CouchCoopLog.Info("monomod unwinder preloaded (libgcc_s.so.1, RTLD_GLOBAL)");
                // The Linux behaviour is untouched; only recorded, so a report from the platform we actually
                // ship on says what its precondition did instead of "probe=not-run".
                Connections.CouchCoopPatchHealth.RecordProbe("unwinder-preloaded");
                return;
            }

            var detail = $"monomod unwinder preload FAILED detail={preload.Error} — Harmony patches "
                + "may fail with 'undefined symbol: _Unwind_RaiseException'; the lobby QR button and co-op seat "
                + "joining depend on them";
            CouchCoopLog.Stderr(detail);
            CouchCoopLog.Error(detail);
            // NOT a row: the preload failing is a strong predictor of broken patching, not proof of it (the
            // symbols are sometimes already present), and each patch that then fails raises the row itself.
            Connections.CouchCoopPatchHealth.RecordProbe($"unwinder-preload-failed({preload.Error})");
        }
        catch (Exception exception)
        {
            // Never fatal: the patches below each degrade on their own, and a mod that refuses to load is worse
            // than one that loads without its hooks.
            CouchCoopLog.Stderr(
                $"monomod unwinder preload threw detail={exception.GetType().Name}: {exception.Message}");
            Connections.CouchCoopPatchHealth.RecordProbe($"threw({exception.GetType().Name})");
        }
    }

    /// <summary>
    /// On a platform with no preload to make, find out whether Harmony can patch at all — see
    /// <see cref="Patches.CouchCoopHarmonyProbe"/> for why macOS is the platform that has to be asked.
    /// </summary>
    /// <remarks>
    /// macOS only, on purpose. Windows patching is not known to have a first-load veto and works today; adding a
    /// startup patch there would be a change to a platform this round has no way to test. It is recorded as
    /// skipped rather than as healthy, so a Windows report never claims a probe that never ran.
    /// </remarks>
    private static void ProbeNativePatching()
    {
        if (!OperatingSystem.IsMacOS())
        {
            Connections.CouchCoopPatchHealth.RecordProbe("skipped (not required on this platform)");
            return;
        }

        Checkpoint("harmony-probe-enter");
        var probe = Patches.CouchCoopHarmonyProbe.Run();
        Checkpoint($"harmony-probe-complete result={(probe.Succeeded ? "ok" : "failed")}");
        if (probe.Succeeded)
        {
            const string Message = "harmony probe ok (macOS): a trial patch of our own method applied and took effect";
            CouchCoopLog.Stderr(Message);
            CouchCoopLog.Info(Message);
            Connections.CouchCoopPatchHealth.RecordProbe("ok");
            return;
        }

        var error = probe.Error ?? "unknown";
        var message = $"harmony probe FAILED (macOS) detail={error} — no Harmony patch can be "
            + "installed in this process, so the lobby Couch Co-Op button will not appear and no player can join "
            + "a seat this session";
        CouchCoopLog.Stderr(message);
        CouchCoopLog.Error(message);
        Connections.CouchCoopPatchHealth.ProbeFailed(
            error,
            $"{message} (host {System.Runtime.InteropServices.RuntimeInformation.OSDescription})");
    }

    private static void Checkpoint(string checkpoint)
    {
        CouchCoopLog.Stderr(checkpoint);
        CouchCoopLog.Info(checkpoint);
    }

    private static void InitializeQrHostPanel()
    {
        try
        {
            CouchCoopQrHostPanelController.Initialize();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"host-ui diagnostic code={CouchCoopHostUiServices.HostUiOverlayStartupFailedCode} detail={exception.GetType().Name}: {exception.Message}");
        }
    }
}
