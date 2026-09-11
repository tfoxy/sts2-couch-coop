// The main-scene script for the CouchCoop native Godot client (M1b). Routes by OS.GetCmdlineUserArgs():
//
//   --connect <host[:port]>  (default port 13337) → the REAL stack (ConnectionCoordinator + MirrorStore): runs the
//       join dance, applies + acks scene-deltas, logs session directives + per-delta counts + dual-bucket RTT.
//       --name <n> auto-joins once; --duration <s> quits with a summary.
//   --replay <ndjson-path>   → NO socket: feed each recorded message through the SAME parse worker + store apply
//       path, then print a final summary. With --dump-final-state, print one machine-readable M1B_FINAL_STATE line
//       (node/orderedIds counts + FNV-1a of the joined orderedIds + per-type counts + revision)
//       and quit — this feeds the cross-language state-parity check (scripts/compare-replay-final-state.mjs).
//   NO recognized mode (M1e) → mount the UiRoot chrome in its Connect state (stub Connect screen) instead of quitting;
//       its Connect button starts the coordinator against the default host. --connect additionally mounts the
//       InputRouter gesture router and skips the Connect screen. New M1e flags: --latency (RTT overlay + probes on),
//       --input-probe / --demo-input <script> (stub hooks forwarded to the InputRouter). The RTT ping cadence is now
//       gated (250ms only while --latency / --bench / the Settings panel is open, else off).
//   --qa-port <n> (Track Q) → mount the localhost-only debug QA control channel (QaServer) on 127.0.0.1:<n>. Also
//       enabled by a [qa] port=<n> key in user://settings.cfg (the Android path). DEFAULT OFF; interactive modes only.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CouchCoop.GodotClient.Input;
using CouchCoop.GodotClient.Scene;
using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.GodotClient.Ui;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.App;

public partial class AppShell : Node2D
{
    // The RTT probe cadence (matches the web's PROBE_INTERVAL_MS). M1e GATES it like the web: probes run only while
    // --latency OR --bench OR the UiRoot Settings panel is open (see DesiredPingMs); otherwise off (0).
    private const double ProbeIntervalMs = 250;

    // The host the no-args Connect screen targets when its Connect button is pressed (the on-device default host).
    private const string DefaultConnectHost = "127.0.0.1:13337";

    // --shot settle: capture once the texture in-flight queue is empty for this many consecutive idle frames.
    private const int ShotSettleFrames = 8;
    // Hard cap so a stuck/failed fetch can't hang the shot forever.
    private const double ShotTimeoutSec = 30;

    // On-demand mirror-stage rendering (RenderActivity): while the stage is idle (SubViewport Disabled), force ONE
    // render this often as a safety net so any visual change that slipped past every Mark/continuous signal self-heals
    // within a second (Godot auto-reverts an UpdateMode.Once back to Disabled after it renders once).
    private const double RenderHeartbeatSec = 1.0;

    private ConnectionCoordinator? _coordinator;
    private MirrorStore? _store;
    private TextureStore? _textures;
    private SceneReconciler? _reconciler;
    private StaticBake? _staticBake; // Track-D: static background pre-composite controller (settings-controlled, inert when off)
    private TextOverlay? _textOverlay; // Track-B: native-res "perceived Full" text overlay (inert at Full / switch-off)
    private IdleSuspendController? _idleSuspendController; // Track I: idle-animation-suspend controller (freezes continuous effects → stage reaches Disabled)
    private CardLayer? _cardLayer; // Track-C: native-res full-resolution card layer (inert at Full / switch-off)
    private SubViewportContainer? _renderStageContainer;
    private SubViewport? _renderStageViewport;
    private int _appliedRenderSettingsGeneration = -1;
    private double _sinceRenderHeartbeat; // seconds since the last render while the on-demand stage is Disabled

    // WS-FULLRES (direct-Full native-resolution stage hosting). At RenderScale.Full, hosting the SceneReconciler
    // directly under this AppShell node (instead of inside the SubViewportContainer) makes the stage rasterize into the
    // ROOT render target. What resolution that root RT is decides everything:
    //   * canvas_items content-scale (project.godot default, StretchCollapse OFF) → root RT = NATIVE window pixels →
    //     the stage rasterizes at native res → card text + icon outlines are CRISP even on a hidpi window. This is the
    //     desktop DEFAULT, and since 2026-08-01 the mobile default too ("Native full-scale rendering" now ships CHECKED)
    //     — the blur fix.
    //   * viewport content-scale (StretchCollapse ON) → root RT = DESIGN res → the stage rasterizes at design res and
    //     the mandatory present blit upscales for free (cheaper composite, but blurry on a hidpi window). On Android
    //     this is now the OPT-OUT path: it applies when the user unchecks "Native full-scale rendering" or drops below
    //     Full (the Half-scale frame-pacing pipeline depends on the design-res composite).
    // Half/Quarter always keep the SubViewport chain (its StretchShrink is the shrink mechanism). Reparenting preserves
    // the whole MirrorNodeView subtree + textures + tween/effect state (design space is identical in both hosts).
    //
    // The "directFull" setting resolves to desktop native raster or the Android SettingsPanel checkbox
    // (ClientSettingsStore.DirectFull,
    // fresh-profile default ON since 2026-08-01). History: direct-Full under canvas_items was measured at +17% GPU
    // cycles/frame on the fill-bound Mali-G615, which is why it originally shipped OPT-IN on mobile; the defaults
    // unification took that cost knowingly in exchange for crisp text, and unchecking the box still buys it back.
    // Desktop is not fill-bound, so it was always the default there. The platform/setting halves are read live so the mobile checkbox + scale changes are
    // reactive (see ApplyContentScaleModeIfChanged).
    private bool _directStageHosting; // true while the reconciler is parented directly under AppShell (direct-Full hosting)

    // WS-FULLRES (stretch-collapse — the window ContentScaleMode). Viewport mode = the design-res-collapse pipeline
    // (Android's frame-pacing default); canvas_items mode = the native-res pipeline (project.godot default, the desktop
    // default and the mobile "Native full-scale rendering" opt-in path). StretchCollapseEffective() resolves it live:
    //   * DESKTOP ⇒ canvas_items (OFF): project.godot IS this pipeline, so no ContentScaleMode write happens and
    //     the 1920×1080 output stays byte-identical to pre-WS-FULLRES (native == design at 1080).
    //   * else ANDROID ⇒ Viewport (collapse) UNLESS native-full is active AT Full (directFull checked && scale==Full) —
    //     then canvas_items, so Full rasterizes at native window res exactly like desktop. Since both halves now default
    //     that way, canvas_items is what a fresh phone profile gets. At Half/Quarter (or unchecked) it falls back to
    //     Viewport, so the device's Half-scale pacing win is UNTOUCHED for anyone who opts back into it.
    // Viewport-mode invariants are preserved: GetVisibleRect() still returns design space, so chrome, the TextOverlay
    // holders, InputRouter's letterbox-inverse (get_final_transform().inverse(), applied to input in BOTH modes) and
    // StageStretch's ContentScaleSize widening are all UNCHANGED. The window mode is (re)applied by
    // ApplyContentScaleModeIfChanged each frame, so a mobile checkbox toggle or a render-scale change flips it at
    // runtime.

    // The mobile "Native full-scale rendering" checkbox + render-scale changes are reactive while desktop stays static.
    private static bool DirectFullEffective() =>
        !ClientSettingsStore.IsMobileUi || ClientSettingsStore.DirectFull;

    // Whether the window is in Viewport (design-res collapse) content-scale: desktop-canvas_items(false) >
    // Android Viewport unless the native-full opt-in is active at Full.
    private static bool StretchCollapseEffective() =>
        ClientSettingsStore.IsMobileUi
            && !(ClientSettingsStore.DirectFull && ClientEffectSettings.RenderScale == RenderScale.Full);

    // Track S step 4, only meaningful with StretchCollapse.
    // In viewport mode the root viewport's font oversampling falls to 1.0 (canvas_items derived it from window/design),
    // so chrome + TextOverlay glyphs rasterize at design density and soften slightly after the present upscale (device:
    // moto g86 ~1.13x upscale softens SettingsPanel/chrome glyphs). This binds Viewport.OversamplingOverride =
    // windowHeight/1080 (the canvas_items ratio; exact when the window is at least as wide as the design aspect — the
    // phone/landscape case) so glyph atlases rasterize back at native density. No-op unless StretchCollapse is also on;
    // at windowHeight<=1080 the override clamps to 1.0 (== the automatic viewport oversampling → byte-identical to OFF,
    // so desktop 1080 runs are unaffected).
    private double _appliedOversampling = -1; // last OversamplingOverride pushed (re-applied when windowHeight changes)

    // M2 wide-screen stage widening (WS-O). Mounted once for ALL modes; persists across a Back-to-menu store rebuild.
    // Default-OFF; --stretch forces on, --no-stretch forces off. On an F change it pushes the CURRENT store's
    // SetSpreadFactor (the onFactor closure reads the live _store field).
    private StageStretch? _stageStretch;
    private bool _stretchForced;
    private bool _stretchDisabled;

    // M1e UI/input foundation: the chrome layer + gesture router (stubs the M1e workstreams fill), plus the gated
    // ping cadence + the optional --latency overlay (AppShell's own chrome).
    private UiRoot? _uiRoot;
    private InputRouter? _inputRouter;
    private bool _latency;               // --latency: show the RTT overlay + keep probes on
    private bool _inputProbe;            // --input-probe: stub hook forwarded to InputRouter (WS-M) + the Track-S geometry probe
    private bool _geomProbed;            // Track S: the one-shot input-geometry dump has fired (fires once, after the window is sized)
    private string? _demoInput;          // --demo-input <script>: stub hook forwarded to InputRouter (WS-M)
    private QaServer? _qaServer;         // Track Q: localhost-only debug QA control channel (null/absent unless enabled)
    private double _appliedPingMs = -1;  // last cadence pushed to the coordinator (re-applied on change)
    private CanvasLayer? _latencyLayer;  // the --latency overlay's own layer (freed on ReturnToMenu)
    private Label? _latencyLabel;

    // Track E (keyframe-diff bench): COUCHCOOP_MIRROR_BENCH_RELOADS=N drives N user-Reload cycles (coordinator.Resync
    // → fresh socket → the server pushes a Full=true keyframe → the reconciler's keyframe path runs on the ALREADY-BUILT
    // tree, i.e. the exact Reload hitch we optimize). Debug-only; inert (0) unless set. Each cycle's keyframe drain lands
    // as a real _Process frame so _frameMsMaxSeen captures the worst-frame spike (the Track E deliverable). Read ONCE.
    private static readonly int BenchReloads =
        int.TryParse(System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_BENCH_RELOADS"), out var r) && r > 0 ? r : 0;
    // Seconds between reload cycles — must exceed the reconnect delay (Resync resets the backoff ladder to ~1s) so each
    // fresh keyframe fully lands + settles before the next teardown.
    private const double BenchReloadIntervalSec = 3.0;
    private int _benchReloadsRemaining;
    private double _sinceBenchReload;
    private bool _benchReloadArmed; // set once the initial tree is built (revision > 0) — the first Resync waits for it

    private double _durationSec = -1;
    private double _elapsed;
    private double _sinceDeltaLog;
    private double _sinceRttLog;
    private double _sinceWalkLog; // WS-W: 10s-cadence M3_WALK live log cadence
    private int _lastLoggedRevision = -1;
    private bool _quitting;

    // --shot / --shot-after state.
    private string? _shotPath;
    private double _shotAfterSec = -1;
    private bool _capturePending;
    private double _captureWaited;
    private int _idleFrames;

    // --bench state (connect mode): per-frame process-time ring + GC alloc
    // baseline; one BENCH_RESULT JSON line prints at duration end for the on-device native-vs-web comparison.
    private bool _bench;
    private readonly double[] _frameRing = new double[2048];
    private int _frameRingHead;
    private int _frameRingCount;
    // Never-evicted worst frame across the WHOLE bench (the ring holds only the last 2048 frames, so a spike early in
    // a long run — e.g. cold-cache decode at combat load — would age out of the ring before BENCH_RESULT prints). The
    // running max captures the true worst frame regardless of run length; it's the direct Track E spike deliverable.
    private double _frameMsMaxSeen;
    // Track E: precise Stopwatch max wall-time of any single drain (ApplySceneDelta + reconcile) — the true per-frame
    // keyframe-rebuild hitch, unpolluted by the ~1Hz Performance.TimeProcess sampling / reconnect I/O.
    private double _drainMsMaxSeen;
    private long _startAllocBytes;
    private long _deltasApplied;

    // WS-B GC telemetry: bench-start GC baselines, seeded in StartConnect alongside _startAllocBytes, so
    // BENCH_RESULT can print gen0/1/2 collection + total-pause deltas next to gcAllocBytesDelta.
    private int _startGc0;
    private int _startGc1;
    private int _startGc2;
    private double _startGcPauseMs;

    // QA `state` frame percentiles: a tiny ALWAYS-ON ring of per-frame process delta ms (~2s at 60fps), updated once
    // per frame at the top of _Process in every mode (the --bench ring above is 2048 samples, bench-gated, and only
    // fills while connected — not reusable here). Percentiles are computed only when the `state` verb is served
    // (sorted copy via the shared Percentiles.Compute) — never per frame.
    private readonly double[] _qaFrameRing = new double[120];
    private int _qaFrameRingHead;
    private int _qaFrameRingCount;

    // WS-B spike attribution, updated at the QA-ring write site: the ring sample (`delta`) IS the previous frame's
    // cost, so the attribution there reads state recorded DURING that frame — _lastGc* vs now = collections that
    // landed in it, _prevFrameApplied = its drain work. A "spike" is a frame slower than SpikeThresholdMs (~1.3x
    // 60Hz vsync). GC.CollectionCount is a cheap FCALL, safe once per frame. Counters reset with the session
    // (ReturnToMenu); snapshots seed in _Ready so the first frame never reports a spurious GC.
    private const double SpikeThresholdMs = 22.0;
    private int _lastGc0;
    private int _lastGc1;
    private int _lastGc2;
    private int _prevFrameApplied; // deltas the PREVIOUS frame's DrainInto applied (set right after the drain below)
    private long _spikeFrames;
    private long _spikeFramesGc;
    private long _spikeFramesDrain;

    // WS-B M3_WALK heartbeat: last-heartbeat GC snapshots so the 10s walk line reports per-heartbeat deltas.
    private int _walkGc0;
    private int _walkGc1;
    private int _walkGc2;
    private double _walkGcPauseMs;
    private long _walkAllocBytes;

    public override void _Ready()
    {
        // WS-PERSIST: read the device-local client settings ONCE, before anything mounts. This seeds
        // ClientEffectSettings.* (so the very first ApplyRenderScaleIfChanged already sees the persisted / fresh-profile
        // -default RenderScale — Full on BOTH platforms since 2026-08-01) and holds the SettingsPanel toggle defaults
        // the panel reads when it builds. Load never writes, so a --replay / --dump run leaves settings.cfg (and its
        // lastHost / lastPlayerName / lastAssetToken siblings) untouched.
        ClientSettingsStore.Load();

        // The client-owned candle-fire loop is always active and folds into the view transform.

        // WS-B GC telemetry: seed the per-frame and per-heartbeat GC snapshots so the first frame / first M3_WALK
        // line report deltas, not process-lifetime absolutes (boot-time collections would otherwise pollute both).
        _lastGc0 = _walkGc0 = GC.CollectionCount(0);
        _lastGc1 = _walkGc1 = GC.CollectionCount(1);
        _lastGc2 = _walkGc2 = GC.CollectionCount(2);
        _walkGcPauseMs = GC.GetTotalPauseDuration().TotalMilliseconds;
        _walkAllocBytes = GC.GetTotalAllocatedBytes();

        // WS-FULLRES: set the window content-scale mode BEFORE any diagnostic reads it or StageStretch writes
        // ContentScaleSize. Desktop resolves to canvas_items (== project.godot ⇒ NO write ⇒ byte-identical native-res
        // pipeline); Android resolves to Viewport-collapse unless the native-full opt-in is active at Full. Reactive
        // thereafter via ApplyContentScaleModeIfChanged in _Process (mobile checkbox / render-scale changes).
        ApplyContentScaleModeIfChanged();
        GD.Print($"STRETCH_COLLAPSE: init mode={GetWindow().ContentScaleMode} collapse={StretchCollapseEffective()} " +
                 $"directFull={DirectFullEffective()} mobileUi={ClientSettingsStore.IsMobileUi} " +
                 $"oversampleGlyphs=true renderScale={ClientEffectSettings.RenderScale}");

        LogPreRotation(); // Track C: one-shot swapchain pre-rotation diagnostic (read from logcat on-device)

        var args = ParseArgs(OS.GetCmdlineUserArgs());
        _stretchForced = args.Stretch;
        _stretchDisabled = args.NoStretch;
        MountStageStretch(); // ALL modes: the widening + finalXform-inverse input mapping must be live everywhere

        MaybeMountQaChannel(args); // Track Q: localhost-only debug control channel — DEFAULT OFF (no arg/key ⇒ no listener)

        if (args.Replay is not null)
        {
            RunReplay(args);
            return;
        }

        if (args.Connect is not null)
        {
            StartConnect(args);
            return;
        }

        // M1e: NO recognized mode → show the Connect screen stub (UiRoot in Connect state) instead of quitting. Its
        // Connect button starts the coordinator against DefaultConnectHost via the callback below. (--connect keeps
        // its unchanged behaviour and skips the Connect screen.)
        StartConnectScreen(args);
    }

    // Track C — one-shot swapchain pre-rotation diagnostic. Round-1 RenderDoc established that Godot's Vulkan RD ends
    // every frame with a MANDATORY root→swapchain blit (P30) that also folds in the surface pre-rotation (shipped in
    // Godot 4.4). The engine exposes RenderingDevice::screen_get_pre_rotation_degrees in C++, but that method is NOT
    // bound to C#/GDScript in this GodotSharp (4.5.1) — verified against GodotSharp.xml (no PreRotation member). So we
    // log the best available proxies in ONE PREROTATION line the on-device logcat check reads: the root-viewport /
    // window / physical-screen sizes and the DisplayServer orientation. Interpretation (per plan): on a landscape phone
    // a WINDOW whose aspect is SWAPPED relative to the PHYSICAL screen (a natively-portrait panel) ⇒ the compositor is
    // pre-rotating (a hidden 90/270 pass exists → a future surface-timing fix); matching aspect + Landscape orientation
    // is consistent with 0°. The reflective probe below transparently upgrades to the real degrees if a future
    // GodotSharp ever binds the accessor.
    private void LogPreRotation()
    {
        string engineDegrees = "UNAVAILABLE(RenderingDevice.screen_get_pre_rotation_degrees not bound to C# in GodotSharp 4.5.1)";
        try
        {
            var rd = RenderingServer.GetRenderingDevice();
            var method = rd?.GetType().GetMethod(
                "ScreenGetPreRotationDegrees",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
            if (rd is not null && method is not null)
            {
                object[] callArgs = method.GetParameters().Length == 0
                    ? System.Array.Empty<object>()
                    : new object[] { 0 };
                engineDegrees = System.Convert.ToString(method.Invoke(rd, callArgs), CultureInfo.InvariantCulture) ?? "null";
            }
        }
        catch (System.Exception e)
        {
            engineDegrees = $"UNAVAILABLE(probe-threw:{e.GetType().Name})";
        }

        var rootViewport = GetViewport().GetVisibleRect().Size;
        var window = DisplayServer.WindowGetSize();
        var screen = DisplayServer.ScreenGetSize();
        var orientation = DisplayServer.ScreenGetOrientation();
        bool windowLandscape = window.X >= window.Y;
        bool screenLandscape = screen.X >= screen.Y;
        string proxy = windowLandscape != screenLandscape
            ? "window/screen aspect SWAPPED => compositor pre-rotation LIKELY active (hidden 90/270 blit)"
            : "window/screen aspect MATCHES => consistent with 0deg pre-rotation";

        GD.Print($"PREROTATION: engineDegrees={engineDegrees} " +
                 $"rootViewport={rootViewport.X:0}x{rootViewport.Y:0} window={window.X}x{window.Y} " +
                 $"screen={screen.X}x{screen.Y} orientation={orientation} proxy=\"{proxy}\"");
    }

    public override void _Process(double delta)
    {
        if (_quitting)
        {
            return;
        }

        // QA `state` frame ring: one array write per frame, all modes (before the no-coordinator early-return).
        _qaFrameRing[_qaFrameRingHead] = delta * 1000.0;
        _qaFrameRingHead = (_qaFrameRingHead + 1) % _qaFrameRing.Length;
        if (_qaFrameRingCount < _qaFrameRing.Length)
        {
            _qaFrameRingCount++;
        }

        // WS-B spike attribution: `delta` is the PREVIOUS frame's cost, so classify it against the state recorded
        // during that frame — did a GC collection land in it (any gen count moved since the last check), did its
        // DrainInto apply deltas. The two attributions are independent (a spike frame can count in both / neither).
        int gc0 = GC.CollectionCount(0);
        int gc1 = GC.CollectionCount(1);
        int gc2 = GC.CollectionCount(2);
        bool gcHappened = gc0 != _lastGc0 || gc1 != _lastGc1 || gc2 != _lastGc2;
        _lastGc0 = gc0;
        _lastGc1 = gc1;
        _lastGc2 = gc2;
        if (delta * 1000.0 > SpikeThresholdMs)
        {
            _spikeFrames++;
            if (gcHappened)
            {
                _spikeFramesGc++;
            }

            if (_prevFrameApplied > 0)
            {
                _spikeFramesDrain++;
            }
        }

        RenderActivity.BeginFrame(); // decay the on-demand render grace window once per frame (before this frame's Marks)
        IdleSuspend.Hold = _capturePending; // Track I: while the --shot capture-settle owns the frame, never idle-suspend (kept in lockstep with _capturePending; QA `shot` uses a separate flag, so it captures the FROZEN frame)
        FitRenderStageToViewport();       // Marks on a size/position change
        ApplyRenderScaleIfChanged();      // Marks on a client-effect generation change
        ApplyContentScaleModeIfChanged(); // WS-FULLRES: react to a mobile directFull toggle / scale change (runtime mode flip)
        ApplyStaticBakeEnableIfChanged(); // WS-MISC item 3: react to a live staticBake toggle (arm/disarm the bake without a reconnect)
        ApplyGlyphOversampling();         // Track S step 4: restore chrome/overlay glyph density under viewport mode (opt-in)
        MaybeLogInputGeometryProbe(); // --input-probe: one-shot corner→design + chrome-rect dump (Track S proof)

        // On-demand mirror-stage render decision — every frame, in ALL modes, BEFORE the no-coordinator early-return
        // so replay --shot's capture-settle path still renders. Reads this frame's Fit/RenderScale marks; a delta's
        // Mark during DrainInto below rides the 8-frame grace window into the next frame (imperceptible wake lag).
        UpdateRenderStageActivity(delta);

        // Capture settle runs in BOTH modes (replay --shot has no coordinator; connect --shot-after does).
        if (_capturePending)
        {
            MaybeCapture(delta);
        }

        if (_coordinator is null || _store is null)
        {
            return;
        }

        ApplyPingGating();
        _coordinator.Poll(delta);

        // Track E: precise wall-time of the drain (ApplySceneDelta main-thread apply + FinishDrain reconcile). This is
        // the actual per-frame CPU hitch a keyframe rebuild causes — unlike Performance.TimeProcess below (a ~1Hz-sampled
        // engine monitor that smears reconnect I/O + GPU render-during-alive over ~1s of frames), it isolates the drain.
        // WS-B stream gate: while the viewer is parked on the join picker the host sends nothing and the socket
        // drops any straggler, so the queue is empty by construction — but skip the drain outright so a gated
        // client provably does no decode/apply/ack work (and never acks a frame it did not render). Also hide the
        // live tree, so a frame rendered BEFORE the host entered a multiplayer screen can't linger behind the
        // picker (the web twin unmounts MirrorView for the same reason).
        bool watching = _coordinator.Watching;
        ApplyStreamGateVisibility(watching);

        long drainStart = System.Diagnostics.Stopwatch.GetTimestamp();
        int appliedThisFrame = watching ? _store.DrainInto() : 0;
        _deltasApplied += appliedThisFrame;
        _prevFrameApplied = appliedThisFrame; // WS-B: read by the NEXT frame's spike attribution (this frame's cost)
        if (appliedThisFrame > 0)
        {
            double drainMs = (System.Diagnostics.Stopwatch.GetTimestamp() - drainStart) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            if (drainMs > _drainMsMaxSeen)
            {
                _drainMsMaxSeen = drainMs;
            }

            if (BenchReloads > 0)
            {
                GD.Print(string.Format(CultureInfo.InvariantCulture, "DRAIN_FRAME: t={0:0.0}s applied={1} drainMs={2:0.0}", _elapsed, appliedThisFrame, drainMs));
            }
        }

        if (_bench)
        {
            // Performance.TimeProcess is the previous frame's full process time (the spike ring's proven source).
            double frameMs = Performance.GetMonitor(Performance.Monitor.TimeProcess) * 1000.0;
            _frameRing[_frameRingHead] = frameMs;
            _frameRingHead = (_frameRingHead + 1) % _frameRing.Length;
            if (_frameRingCount < _frameRing.Length)
            {
                _frameRingCount++;
            }

            if (frameMs > _frameMsMaxSeen)
            {
                _frameMsMaxSeen = frameMs; // never-evicted worst frame (survives ring wrap-around)
            }
        }

        _elapsed += delta;

        _sinceDeltaLog += delta;
        if (_sinceDeltaLog >= 1.0)
        {
            _sinceDeltaLog = 0;
            if (_store.Revision != _lastLoggedRevision)
            {
                _lastLoggedRevision = _store.Revision;
                GD.Print($"M1B: revision={_store.Revision} nodes={_store.State.Nodes.Count} " +
                         $"orderedIds={_store.State.OrderedIds.Count}");
            }
        }

        _sinceRttLog += delta;
        if (_sinceRttLog >= 5.0)
        {
            _sinceRttLog = 0;
            PrintRtt();
        }

        DriveBenchReloads(delta); // Track E: keyframe-reload soak (inert unless COUCHCOOP_MIRROR_BENCH_RELOADS is set)

        // WS-W: a low-frequency walk-perf line so an ordinary --connect session (no --bench) surfaces drain/
        // reconcile/spread/tween cost too. Gated on ≥1 recorded drain so an idle/no-delta run stays silent.
        _sinceWalkLog += delta;
        if (_sinceWalkLog >= 10.0)
        {
            _sinceWalkLog = 0;
            PrintWalkLog();
        }

        UpdateLatencyOverlay();

        // --shot-after: begin the settle-then-capture once the delay elapses (keeps the connection alive so late
        // textures still arrive during settle).
        if (_shotPath is not null && !_capturePending && _shotAfterSec >= 0 && _elapsed >= _shotAfterSec)
        {
            _capturePending = true;
            GD.Print($"M1C_SHOT: settle begin at {_elapsed:0.0}s (views={_reconciler?.ViewCount} " +
                     $"assets[{AssetStores.Summary()}] assetCache[{AssetDiskCache.CounterSummary()}])");
        }

        if (_shotPath is null && _durationSec > 0 && _elapsed >= _durationSec)
        {
            FinishConnect("duration reached");
        }
    }

    // ==============================================================================================
    // --shot capture (settle: replay fully applied + texture queue empty + N idle frames → SavePng)
    // ==============================================================================================

    private void MaybeCapture(double delta)
    {
        _captureWaited += delta;

        // Settle on ALL registered asset sources (textures + fonts + M1d spine/shader stores), not just textures —
        // AssetStores.AllIdle fixes the latent race where a --shot could fire before fonts arrived. Track-D ADDs the
        // static-bake terminal: the shot waits until the bake has reached Active (a scene-bearing recording — so the
        // ON parity shot is provably non-vacuous) or has decided there's nothing to bake (IsShotSettled). Disabled /
        // no controller → always settled (the OFF shot is unaffected).
        if (AssetStores.AllIdle && (_staticBake?.IsShotSettled ?? true) && (_textOverlay?.IsShotSettled ?? true)
            && (_cardLayer?.IsShotSettled ?? true))
        {
            _idleFrames++;
        }
        else
        {
            _idleFrames = 0;
        }

        bool timedOut = _captureWaited >= ShotTimeoutSec;
        if (_idleFrames >= ShotSettleFrames || timedOut)
        {
            CaptureAndQuit(timedOut);
        }
    }

    private async void CaptureAndQuit(bool timedOut)
    {
        _quitting = true;

        // Grab the fully-drawn frame (not a mid-draw one).
        await ToSignal(RenderingServer.Singleton, RenderingServer.SignalName.FramePostDraw);

        MaybeDumpTextAlign(); // R5: env-gated per-text-node alignment JSON at the settled frame (the --shot twin of `dumpalign`).

        var image = GetViewport().GetTexture().GetImage();
        Error err = image.SavePng(_shotPath);
        GD.Print($"M1C_SHOT: saved='{_shotPath}' err={err} size={image.GetWidth()}x{image.GetHeight()} " +
                 $"views={_reconciler?.ViewCount} texFetched={_textures?.Fetched} texFailed={_textures?.Failed} " +
                 $"culled[self={_reconciler?.CulledSelfCount ?? 0} subtree={_reconciler?.CulledSubtreeCount ?? 0}] " +
                 $"{_staticBake?.ShotStatus() ?? "bake[disabled]"} " +
                 $"{_textOverlay?.ShotStatus() ?? "textOverlay[disabled]"} " +
                 $"{_cardLayer?.ShotStatus() ?? "cardLayer[disabled]"} " +
                 $"assetCache[{AssetDiskCache.CounterSummary()}] timedOut={timedOut}");
        // Leak-probe snapshot at capture (the PrintWalkLog lk[...] line never fires in the short --shot settle window).
        // created-minus-freed is the bounded live series; *Shared counts allocs the signature caches avoided.
        GD.Print("M1C_SHOT_LEAK: emitterShaders=true " +
                 $"emShMat={LeakProbe.EmitterShaderMat}-{LeakProbe.EmitterShaderMatFreed}f/{LeakProbe.EmitterShaderMatShared}sh " +
                 $"procMat={LeakProbe.ParticleProcMat}/{ParticleLayer.ProcMatShared}sh " +
                 $"shMat={LeakProbe.ShaderMat}-{LeakProbe.ShaderMatFreed}f/{LeakProbe.ShaderMatShared}sh " +
                 $"gpuEm={LeakProbe.GpuEmitter}-{LeakProbe.GpuEmitterFreed}f " +
                 $"engineResources={(long)Performance.GetMonitor(Performance.Monitor.ObjectResourceCount)} " +
                 $"engineOrphans={(long)Performance.GetMonitor(Performance.Monitor.ObjectOrphanNodeCount)} " +
                 $"renderVMemMib={Math.Round(Performance.GetMonitor(Performance.Monitor.RenderVideoMemUsed) / (1024.0 * 1024.0), 1)}");
        GetTree().Quit();
    }

    // R5 text-alignment --shot env twin: the QA `dumpalign` verb does NOT mount under --replay (no interactive socket),
    // so COUCHCOOP_MIRROR_TEXTALIGN_DUMP=1 prints the SAME per-text-node placement JSON at the settled capture frame on
    // one machine-readable line (`M1C_TEXTALIGN: {json}`). Default OFF (byte-identical shot log). Used by
    // scripts/verify-text-align.sh to source the streamed boxes + a numeric cross-check of the ink measurement.
    private void MaybeDumpTextAlign()
    {
        if (System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_TEXTALIGN_DUMP") != "1"
            || _reconciler is null || _store is null)
        {
            return;
        }

        GD.Print($"M1C_TEXTALIGN: {Scene.TextAlignDump.Collect(_reconciler, _store, null).ToJsonString()}");
    }

    // Create + mount the render stage (texture source + reconciler) under this Node2D. The project's canvas_items
    // stretch letterboxes the design space onto the window. The mirror stage renders through a full-rect
    // SubViewportContainer so StretchShrink can reduce rasterization without changing the stage's design-space
    // coordinates. `opts` carries the render-mode toggles (InstantTweens in --replay so the final state renders with
    // no in-flight animation; false in --connect for live play).
    private void MountRenderStage(string assetsBaseUrl, RenderOptions opts)
    {
        // WS-U: create the ONE shared disk asset cache BEFORE the stores (they read AssetDiskCache.Shared each fetch),
        // seeded from the persisted lastAssetToken so the common warm case starts in the right namespace immediately
        // (the `session` message's SetNamespace, wired below, corrects it if the token changed — see OnSessionEnvelope).
        AssetDiskCache.Create();

        _textures = new TextureStore { BaseUrl = assetsBaseUrl.TrimEnd('/') };
        AddChild(_textures);

        _renderStageContainer = new SubViewportContainer
        {
            Name = "MirrorStageRenderScale",
            Stretch = true,
            MouseFilter = Control.MouseFilterEnum.Ignore,
        };
        // AppShell is a Node2D, not a Control, so viewport-relative anchors do not size this child reliably. Keep
        // top-left anchors and maintain the actual full-rect size from the root viewport in FitRenderStageToViewport.

        _renderStageViewport = new SubViewport
        {
            Name = "MirrorStageViewport",
            Size2DOverride = new Vector2I(StageStretch.BaseDesignWidth, StageStretch.DesignHeight),
            Size2DOverrideStretch = true,
            RenderTargetUpdateMode = SubViewport.UpdateMode.Always,
            HandleInputLocally = false,
            TransparentBg = true,
        };
        _renderStageContainer.AddChild(_renderStageViewport);
        AddChild(_renderStageContainer);

        _reconciler = new SceneReconciler();

        // Track I: mount the idle-suspend controller and SUBSCRIBE it to the store's Drained/SpreadChanged BEFORE the
        // reconciler binds — so on a drain its wake-resume runs FIRST in the callstack (strictly before the reconciler
        // reconciles this drain: wake-then-apply). Bind wires the reconciler handle (Freeze/Resume sweep target) once
        // the reconciler exists. A direct AppShell child (not inside the stage subtree, which reparents on a hosting
        // switch and is freed on teardown mid-reconcile); ProcessPriority=-100 keeps its _Process ahead of the
        // reconciler's effect-gen poll regardless of tree position.
        _idleSuspendController = new IdleSuspendController();
        _idleSuspendController.SubscribeEarly(_store!);
        _reconciler.Bind(_store!, _textures, opts); // subscribe BEFORE the first drain
        _idleSuspendController.Bind(_reconciler, _store!);
        AddChild(_idleSuspendController);
        // Track-D: mount the StaticBake controller as a SIBLING BEFORE the reconciler, so its pre-composited quad
        // paints UNDERNEATH the live tree (sibling order = paint order). It must NOT be a reconciler child
        // (ApplyLevel's MoveChild pass tail-pushes non-view children). Bind wires the bidirectional hooks; the
        // controller is inactive when its persisted setting is off. Added before the reconciler, and
        // ApplyStageHosting reparents it ALONGSIDE the reconciler (Track A) so the quad always shares the stage host.
        _staticBake = new StaticBake();
        _staticBake.Bind(_reconciler, _store!);
        _reconciler.AttachStaticBake(_staticBake);
        _renderStageViewport.AddChild(_staticBake);

        // Track-B: the "perceived Full" text overlay. A native-res CanvasLayer (Layer 32) added to AppShell — the ROOT
        // viewport, NOT the SubViewport — so its promoted proxy labels rasterize crisp at native res above the scaled
        // stage. Bound AFTER the reconciler (it reuses the reconciler's render context). Inert (Active=false) at Full
        // or with the Crisp Text setting off, so this is a no-op for direct-Full hosting.
        _textOverlay = new TextOverlay();
        _textOverlay.Bind(_reconciler, _store!);
        _reconciler.AttachTextOverlay(_textOverlay);
        AddChild(_textOverlay);

        // Track-C: the "full-resolution card layer". A native-res CanvasLayer (Layer 16, between the stage at 0 and the
        // TextOverlay at 32) added to AppShell — the ROOT viewport, NOT the SubViewport — so its promoted card clones
        // rasterize crisp at native res above the scaled stage. Bound AFTER the reconciler (reuses its render context).
        // Inert (Active=false) at Full or with the Crisp Text setting off.
        _cardLayer = new CardLayer();
        _cardLayer.Bind(_reconciler, _store!);
        _reconciler.AttachCardLayer(_cardLayer);
        AddChild(_cardLayer);
        _idleSuspendController?.SetCardLayer(_cardLayer); // Track I: idle sweep must also freeze the card CLONE shaders

        // Start hosted in the SubViewport; ApplyRenderScaleIfChanged (below) reparents it straight under AppShell when
        // the current scale is Full and DirectFull is enabled (Track A). Both hosts are the design coordinate space.
        _renderStageViewport.AddChild(_reconciler);
        _directStageHosting = false;

        // On-demand rendering: start this fresh stage's activity tracker clean, then Mark so the initial frames render
        // while the first keyframe + assets settle. Route the store's per-drain signals through Mark — Drained fires
        // only when ≥1 delta applied (a real visual change) and SpreadChanged fires on a bare wide-screen F change (a
        // relayout with no incoming delta); both must wake the stage. The store is recreated per connection and
        // disposed on back-to-menu, so these subscriptions die with it (RenderActivity is static and holds nothing).
        RenderActivity.Reset();
        RenderActivity.Mark();
        _sinceRenderHeartbeat = 0;
        _store!.Drained += _ => RenderActivity.Mark();
        _store!.SpreadChanged += RenderActivity.Mark;

        _appliedRenderSettingsGeneration = -1;
        FitRenderStageToViewport();
        SyncRenderStageDesignSize();
        ApplyRenderScaleIfChanged();
    }

    private void FitRenderStageToViewport()
    {
        if (_renderStageContainer is null)
        {
            return;
        }

        var visibleSize = GetViewport().GetVisibleRect().Size;
        if (_renderStageContainer.Position != Vector2.Zero)
        {
            _renderStageContainer.Position = Vector2.Zero;
            RenderActivity.Mark(); // stage geometry moved — re-render (rare)
        }

        if (_renderStageContainer.Size != visibleSize)
        {
            _renderStageContainer.Size = visibleSize;
            RenderActivity.Mark(); // window resize widened/narrowed the blit rect — re-render
        }
    }

    // Track S step 4, only with StretchCollapse. In viewport content-scale
    // the root viewport's font oversampling is 1.0 (canvas_items instead derives MAX(window/design) automatically), so
    // chrome + TextOverlay glyphs rasterize at design density and soften after the present upscale. Bind
    // Viewport.OversamplingOverride = windowHeight/1080 — the canvas_items ratio (exact when the window is at least as
    // wide as the design aspect, i.e. the phone/landscape case; the portrait/narrow case is width-limited and this is a
    // slight over-estimate, harmless — denser atlas). Re-applied only when the window height changes (an int-quantized
    // compare). OFF (either switch) ⇒ never touched ⇒ override stays 0 ⇒ engine keeps its automatic oversampling.
    private void ApplyGlyphOversampling()
    {
        // WS-FULLRES: the override is only meaningful in Viewport (collapse) content-scale. In canvas_items mode the
        // engine derives glyph oversampling automatically, so any override we set under Viewport must be CLEARED when
        // the mode flips back (the mobile directFull toggle flips it at Full at runtime). On desktop this branch never
        // writes (the override stays the engine default 0 ⇒ byte-identical to the pre-WS-FULLRES OFF path).
        if (!StretchCollapseEffective())
        {
            if (_appliedOversampling > 0)
            {
                _appliedOversampling = 0;
                GetViewport().OversamplingOverride = 0f;
                RenderActivity.Mark();
                GD.Print("STRETCH_COLLAPSE_OVERSAMPLE: canvas_items mode → override cleared (engine automatic)");
            }

            return;
        }

        double target = System.Math.Max(1.0, GetWindow().Size.Y / (double)StageStretch.DesignHeight);
        if (System.Math.Abs(target - _appliedOversampling) < 0.0001)
        {
            return;
        }

        _appliedOversampling = target;
        GetViewport().OversamplingOverride = (float)target;
        RenderActivity.Mark(); // a glyph-density change must re-render promoted overlay text
        GD.Print($"STRETCH_COLLAPSE_OVERSAMPLE: windowH={GetWindow().Size.Y} oversamplingOverride={target:0.####}");
    }

    // Track S input+chrome geometry proof (debug-only, gated on --input-probe; runs in ALL modes incl. --replay --shot,
    // so it never sends anything upstream to the live game). Fires ONCE after the window is sized. The engine maps every
    // incoming pointer event to design space via GetViewport().GetFinalTransform().affine_inverse() (Viewport::
    // _make_input_local, applied in BOTH canvas_items and viewport content-scale modes), so this logs exactly where a
    // synthetic click at each window-corner / center pixel WOULD land in design space — without driving real input. The
    // window→design composite is get_final_transform = window_transform * stretch_transform * global_canvas_transform:
    // canvas_items folds the design→window scale into stretch_transform, viewport folds it into window_transform, so the
    // composite (hence this design landing) is INVARIANT across the switch. GetVisibleRect() is the design-space chrome
    // rect (UiRoot/JoinPanel/ConnectScreen/SettingsPanel + the TextOverlay holders all live here); it too is unchanged.
    private void MaybeLogInputGeometryProbe()
    {
        if (!_inputProbe || _geomProbed)
        {
            return;
        }

        _geomProbed = true;
        var vp = GetViewport();
        var win = GetWindow().Size;
        var vis = vp.GetVisibleRect();
        Transform2D final = vp.GetFinalTransform();
        Transform2D inv = final.AffineInverse();
        string mode = GetWindow().ContentScaleMode.ToString();

        GD.Print($"INPUT_GEOM: mode={mode} window={win.X}x{win.Y} " +
                 $"visibleRect={vis.Size.X:0}x{vis.Size.Y:0}@({vis.Position.X:0},{vis.Position.Y:0}) " +
                 $"final=[{final.X.X:0.####},{final.X.Y:0.####},{final.Y.X:0.####},{final.Y.Y:0.####}," +
                 $"{final.Origin.X:0.##},{final.Origin.Y:0.##}]");

        // Map fixed WINDOW-pixel probe points through the inverse final transform to design space (the engine's exact
        // input mapping). Corners + center + a mid-edge; identical design values ON vs OFF prove the invariant.
        (string tag, Vector2 px)[] pts =
        {
            ("TL", new Vector2(0, 0)),
            ("TR", new Vector2(win.X, 0)),
            ("BL", new Vector2(0, win.Y)),
            ("BR", new Vector2(win.X, win.Y)),
            ("C", new Vector2(win.X / 2f, win.Y / 2f)),
            ("MB", new Vector2(win.X / 2f, win.Y)), // mid bottom edge — the STS2 hand/play-zone band
        };
        foreach (var (tag, px) in pts)
        {
            Vector2 design = inv * px;
            GD.Print($"INPUT_GEOM_PT: mode={mode} pt={tag} win=({px.X:0.##},{px.Y:0.##}) design=({design.X:0.##},{design.Y:0.##})");
        }
    }

    private void ApplyRenderScaleIfChanged()
    {
        if (_renderStageContainer is null)
        {
            return;
        }

        int generation = ClientEffectSettings.Generation;
        if (generation == _appliedRenderSettingsGeneration)
        {
            return;
        }

        _appliedRenderSettingsGeneration = generation;
        _renderStageContainer.StretchShrink = (int)ClientEffectSettings.RenderScale;
        ApplyStageHosting(); // Track A/S: reparent between direct-Full and the SubViewport for the new render scale
        RenderActivity.Mark(); // a client-effect generation change (render scale / shader / particle mode) needs a re-render
        // hostReason explains whether the stage is direct-hosted for collapsed stretch or native full-scale rendering.
        string hostReason = _directStageHosting
            ? (StretchCollapseEffective() ? "nostretch" : "directfull")
            : "subviewport";
        GD.Print($"RENDER_SCALE: resolution={ClientEffectSettings.RenderScale} " +
                 $"shrink={_renderStageContainer.StretchShrink} " +
                 $"hosting={(_directStageHosting ? "direct" : "subviewport")} hostReason={hostReason}");
    }

    // WS-FULLRES: (re)apply the window ContentScaleMode from StretchCollapseEffective() and keep the stage hosting in
    // sync. Called at _Ready (initial) and every frame (a cheap enum compare). On DESKTOP the desired mode always equals
    // project.godot's canvas_items, so this NEVER writes — the 1920×1080 output stays byte-identical (native == design).
    // On ANDROID the mobile "Native full-scale rendering" checkbox (ClientSettingsStore.DirectFull, polled live) or a
    // render-scale change can flip the effective mode at RUNTIME: Window.ContentScaleMode is runtime-settable, so we
    // flip it live, re-run stage hosting (the mode flip changes the direct-Full raster resolution — design vs native),
    // and re-render. ApplyGlyphOversampling picks up the mode change next frame and clears/re-applies its override.
    private void ApplyContentScaleModeIfChanged()
    {
        var desired = StretchCollapseEffective()
            ? Window.ContentScaleModeEnum.Viewport
            : Window.ContentScaleModeEnum.CanvasItems;
        var win = GetWindow();
        if (win.ContentScaleMode == desired)
        {
            return;
        }

        win.ContentScaleMode = desired;
        ApplyStageHosting();   // hosting keys on scale; the mode flip changes the direct-Full raster resolution
        RenderActivity.Mark(); // a content-scale flip must re-render the stage + any promoted overlay text
        GD.Print($"STRETCH_COLLAPSE: mode={desired} collapse={StretchCollapseEffective()} " +
                 $"directFull={DirectFullEffective()} renderScale={ClientEffectSettings.RenderScale} " +
                 $"mobileUi={ClientSettingsStore.IsMobileUi}");
    }

    // Hot-apply static bake. Poll the persisted setting, flipped live by SettingsPanel or QA, each frame so a toggle
    // takes effect without a reconnect.
    // Cheap: SetEnabled is a no-op once the armed state matches (it never interferes with a steady replay/parity leg,
    // whose enable stays constant). Mirrors ApplyContentScaleModeIfChanged's live-poll shape; no-op before the stage
    // mounts (_staticBake null) or under a Disabled stage.
    private void ApplyStaticBakeEnableIfChanged()
    {
        _staticBake?.SetEnabled(ClientSettingsStore.StaticBake);
    }

    // Bake-enable source before a controller mounts, matching the controller's persisted-setting state.
    private static string StaticBakeEnableSourceFallback() =>
        ClientSettingsStore.StaticBake ? "settings" : "off";

    // Track A / Track S: host the reconciler where the current render scale actually pays. At Full — when Track S's
    // stretch-collapse is on or native full-scale rendering is active — reparent it directly under
    // AppShell: the stage draws into the ROOT default canvas layer and the SubViewportContainer composite (RenderDoc
    // P28) is gone; the container is hidden and its now-empty SubViewport parked Disabled so it never renders a wasted
    // frame. Half/Quarter reparent it back under the SubViewport (whose StretchShrink is the shrink mechanism). The
    // reparent is RemoveChild+AddChild: the reconciler's Transform is identity in BOTH hosts (design space either way —
    // the SubViewport's Size2DOverride is the design size, the root canvas is design space via StageStretch's
    // ContentScaleSize), so keeping the local transform lands the same coordinates, and the whole MirrorNodeView subtree
    // + textures + tween/effect state ride along untouched. Paint order: the reconciler draws in the ROOT default canvas
    // layer (Layer 0); the TextOverlay (CanvasLayer 32, inert at Full), UiRoot (Layer 64) and the latency overlay
    // (Layer 128) always composite above it, and the only other Layer-0 CanvasItem sibling (the SubViewportContainer)
    // is hidden in this mode. Idempotent: a no-op when already in the target hosting.
    //
    // The root canvas's resolution is what makes direct-Full pay or regress: under Track S (viewport content-scale) the
    // root RT is DESIGN-res, so the stage rasterizes at design res (cheap) and the mandatory present blit upscales for
    // free. With canvas-items native full-scale rendering the root target is window-resolution; collapsed stretch uses
    // the design-resolution target. Both preserve the supported DirectFull setting's intended behavior.
    // WS-B stream gate: show/hide the whole live tree (the reconciler root + the StaticBake quad that paints under
    // it) as the gate flips, so a frame rendered BEFORE the host entered a multiplayer screen cannot linger behind
    // the join picker. The web twin gets this for free by unmounting MirrorView.
    //
    // Toggling THESE two roots rather than `_renderStageContainer` is deliberate: the container's visibility is owned
    // by ApplyStageHosting, and under DIRECT hosting the reconciler isn't inside the container at all. The two roots'
    // own Visible writers (SceneReconciler.Bind, StaticBake's bake state machine) all run on the DRAIN path, which is
    // exactly what the gate suspends — so they cannot fight this while gated. Restoring ANDs the QA force-hide flags
    // so `hide stage` / `hide bake` still win, and SceneReconciler re-asserts the static flag on a stack rebuild.
    // Visibility only: the retained tree is untouched, and a re-enable ships a fresh keyframe that rebuilds it.
    private bool _stageHiddenByGate;

    private void ApplyStreamGateVisibility(bool watching)
    {
        if (_stageHiddenByGate == !watching)
        {
            return; // already in the target state
        }

        _stageHiddenByGate = !watching;
        SceneReconciler.StreamGateHidden = !watching;
        if (_reconciler is not null)
        {
            _reconciler.Visible = watching && !QaForcedHide.StageHidden;
        }

        if (_staticBake is not null)
        {
            _staticBake.Visible = watching && !QaForcedHide.BakeHidden;
        }

        RenderActivity.Mark(); // the stage must repaint for the hide/restore to actually land
    }

    private void ApplyStageHosting()
    {
        if (_reconciler is null || _renderStageContainer is null || _renderStageViewport is null)
        {
            return;
        }

        bool direct = ClientEffectSettings.RenderScale == RenderScale.Full && (StretchCollapseEffective() || DirectFullEffective());
        if (direct == _directStageHosting && _reconciler.GetParent() is not null)
        {
            return; // already in the target hosting (and actually parented) — nothing to do
        }

        var currentParent = _reconciler.GetParent();
        if (direct)
        {
            if (currentParent != this)
            {
                currentParent?.RemoveChild(_reconciler);
                // Track-D: the StaticBake controller rides along, ALWAYS inserted before the reconciler (sibling order
                // = paint order — its pre-composited quad must draw underneath the live tree in EITHER host; leaving
                // it behind in the hidden SubViewport would suppress baked originals while the quad renders nowhere).
                MoveStaticBakeTo(this);
                AddChild(_reconciler);
            }

            _renderStageContainer.Visible = false; // no composite blit (P28 gone)
            _renderStageViewport.RenderTargetUpdateMode = SubViewport.UpdateMode.Disabled; // emptied viewport renders nothing
        }
        else
        {
            if (currentParent != _renderStageViewport)
            {
                currentParent?.RemoveChild(_reconciler);
                MoveStaticBakeTo(_renderStageViewport); // Track-D: back under the SubViewport, still before the reconciler
                _renderStageViewport.AddChild(_reconciler);
            }

            _renderStageContainer.Visible = true;
            // Back to Always here; UpdateRenderStageActivity resumes on-demand gating next frame.
            _renderStageViewport.RenderTargetUpdateMode = SubViewport.UpdateMode.Always;
        }

        _directStageHosting = direct;
        RenderActivity.Mark(); // a hosting switch must re-render the stage in its new home
    }

    // Track-D × Track-A: reparent the StaticBake controller to the reconciler's target host. Called immediately BEFORE
    // the reconciler's own AddChild so the controller ends up the earlier sibling (its quad paints underneath). A
    // hosting switch invalidates any active bake anyway (the reparent Mark + the controller's own drain/geometry
    // hooks re-run), so no bake state needs carrying across.
    private void MoveStaticBakeTo(Node target)
    {
        if (_staticBake is null || _staticBake.GetParent() == target)
        {
            return;
        }

        _staticBake.GetParent()?.RemoveChild(_staticBake);
        target.AddChild(_staticBake);
    }

    private void SyncRenderStageDesignSize()
    {
        if (_renderStageViewport is null || _stageStretch is null)
        {
            return;
        }

        var size = new Vector2I(_stageStretch.ComputeDesignWidth(), StageStretch.DesignHeight);
        if (_renderStageViewport.Size2DOverride != size)
        {
            _renderStageViewport.Size2DOverride = size;
            RenderActivity.Mark(); // the wide-screen design width changed — re-render at the new stage size
        }
    }

    // On-demand mirror-stage render decision (see RenderActivity.cs). Runs EVERY frame in ALL modes. The stage renders (Always) while
    // visually ALIVE — a recent Mark's grace window, a live GPU animator (continuousCount), a running declarative
    // tween, or the --shot capture-settle (which MUST render) — else it goes Disabled and the SubViewportContainer
    // keeps blitting the last-rendered texture (all UI chrome lives in the ROOT viewport, so nothing chrome-side is
    // affected). A once-per-second heartbeat forces one render (UpdateMode.Once, which Godot auto-reverts to Disabled
    // after rendering) to self-heal anything that slipped past the signals. renderedFrames/skippedFrames are counted
    // here for the M3_WALK / BENCH_RESULT telemetry.
    private void UpdateRenderStageActivity(double delta)
    {
        if (_renderStageViewport is null)
        {
            return;
        }

        // Track A direct-Full hosting: the stage is a direct root-canvas child rendered every root frame — there is no
        // SubViewport to gate, so the on-demand idle-skip does not apply here (it is a SubViewport-mode feature; phones
        // default Half, so idle-skip still fires for them). Keep the emptied SubViewport Disabled and count each frame
        // as rendered so the counters stay honest; the hosting field in M3_WALK / BENCH_RESULT explains why skipped==0.
        if (_directStageHosting)
        {
            _renderStageViewport.RenderTargetUpdateMode = SubViewport.UpdateMode.Disabled;
            RenderActivity.RecordRendered();
            return;
        }

        bool alive = RenderActivity.AliveByMarkOrContinuous
                     || TweenReplayer.ActiveCount > 0
                     || _capturePending;

        if (alive)
        {
            _renderStageViewport.RenderTargetUpdateMode = SubViewport.UpdateMode.Always;
            _sinceRenderHeartbeat = 0;
            RenderActivity.RecordRendered();
            return;
        }

        _sinceRenderHeartbeat += delta;
        if (_sinceRenderHeartbeat >= RenderHeartbeatSec)
        {
            _sinceRenderHeartbeat = 0;
            _renderStageViewport.RenderTargetUpdateMode = SubViewport.UpdateMode.Once; // one render, then Godot reverts to Disabled
            RenderActivity.RecordRendered();
            return;
        }

        _renderStageViewport.RenderTargetUpdateMode = SubViewport.UpdateMode.Disabled;
        RenderActivity.RecordSkipped();
    }

    public override void _ExitTree()
    {
        _coordinator?.Shutdown();
        _store?.Dispose();
    }

    // ==============================================================================================
    // M2 wide-screen stage widening
    // ==============================================================================================

    // Mount StageStretch once (persists across store rebuilds). Its enable getter combines DefaultEnabled + the dev
    // --stretch/--no-stretch overrides + the Settings toggle; its onFactor routes to the CURRENT store.
    private void MountStageStretch()
    {
        _stageStretch = new StageStretch(StretchEnabled, f =>
        {
            _store?.SetSpreadFactor(f);
            SyncRenderStageDesignSize();
        });
        AddChild(_stageStretch);
    }

    // The effective stretch-enabled decision (read live by StageStretch per resize): --no-stretch forces off,
    // --stretch forces on, else the foundation default (false until the integration commit) gated by the Settings
    // "Widescreen stretch" client toggle (default ON via UiRoot.ToggleStretch).
    private bool StretchEnabled()
    {
        if (_stretchDisabled)
        {
            return false;
        }

        if (_stretchForced)
        {
            return true;
        }

        return StageStretch.DefaultEnabled && (_uiRoot?.ToggleStretch ?? true);
    }

    // ==============================================================================================
    // --connect
    // ==============================================================================================

    private void StartConnect(Args args)
    {
        _durationSec = args.DurationSec;
        _shotPath = args.Shot;
        _shotAfterSec = args.ShotAfterSec;
        _bench = args.Bench;
        _benchReloadsRemaining = BenchReloads; // Track E: N keyframe-reload cycles once the initial tree is built
        _latency = args.Latency;
        _inputProbe = args.InputProbe;
        _demoInput = args.DemoInput;
        _startAllocBytes = GC.GetTotalAllocatedBytes();
        // WS-B GC telemetry: bench GC baselines alongside the alloc baseline (BENCH_RESULT prints the deltas).
        _startGc0 = GC.CollectionCount(0);
        _startGc1 = GC.CollectionCount(1);
        _startGc2 = GC.CollectionCount(2);
        _startGcPauseMs = GC.GetTotalPauseDuration().TotalMilliseconds;
        _store = new MirrorStore();

        // Render stage: textures come from the connect host's /res route by default, or --assets when the scene
        // stream (WS) and the asset origin differ (e.g. a local replay WS server + the live host's /res). Mounted
        // before the coordinator starts so the reconciler is subscribed for the first keyframe.
        MountRenderStage(
            string.IsNullOrEmpty(args.Assets) ? $"http://{args.Connect}" : args.Assets,
            new RenderOptions(InstantTweens: false)); // live play animates real tweens
        _stageStretch?.Apply(); // seed the fresh store's spread factor from the live window aspect

        _coordinator = new ConnectionCoordinator(_store, args.Connect!, args.Name, DesiredPingMs());
        _coordinator.Directive += d => GD.Print($"M1B_SESSION: {d}");
        _coordinator.Notice += n => GD.Print($"M1B: {n}");
        _coordinator.SessionUpdated += OnSessionEnvelope; // WS-U: switch the disk-cache namespace to the server token

        // M1e: mount the UI chrome (starts in Mirror — --connect skips the Connect screen) + the gesture router,
        // wired with the live handles. Both are foundation stubs the M1e workstreams fill without touching this file.
        MountUi(withInputRouter: true);
        _uiRoot!.SetState(UiRoot.UiState.Mirror);
        _uiRoot.AttachCoordinator(_coordinator);
        EnsureLatencyOverlay();

        _coordinator.Start();

        string dur = _durationSec > 0 ? $"{_durationSec:0.#}s" : "until close";
        string shot = _shotPath is not null ? $" shot='{_shotPath}' after={_shotAfterSec:0.#}s" : "";
        GD.Print($"M1B: --connect {args.Connect} name={args.Name ?? "<none>"} " +
                 $"prefill={_coordinator.PrefillName ?? "<none>"} duration={dur}{shot}");
    }

    // ==============================================================================================
    // M1e UI / input mounting + no-args Connect screen + ping gating + latency overlay
    // ==============================================================================================

    // Mount the UiRoot chrome (always) and, when requested, the InputRouter gesture router wired with the live
    // handles (coordinator send-channel, view tree, node model, chrome surface). InputRouter is mounted only when the
    // real stack exists (--connect); the no-args Connect screen mounts UiRoot alone until a connection begins.
    private void MountUi(bool withInputRouter)
    {
        _uiRoot = new UiRoot();
        _uiRoot.ConnectRequested += OnConnectScreenSubmit;
        _uiRoot.BackToMenuRequested += ReturnToMenu;
        AddChild(_uiRoot);

        if (withInputRouter)
        {
            MountInputRouter();
        }
    }

    // Mount the gesture router (+ bind the cosmetic HeldCardLift) once the real stack exists. Idempotent: a no-op if
    // already mounted or the stack isn't built yet. Called both by --connect (MountUi) and by the connect-screen
    // submit path (OnConnectScreenSubmit) so the no-args connect flow — and a back-to-menu→reconnect — also get
    // gestures. On a rebuild this hands HeldCardLift the FRESH reconciler+store (see HeldCardLift.Bind re-hook).
    private void MountInputRouter()
    {
        if (_inputRouter is not null || _coordinator is null || _reconciler is null || _store is null || _uiRoot is null)
        {
            return;
        }

        _inputRouter = new InputRouter { InputProbe = _inputProbe, DemoInputScript = _demoInput };
        _inputRouter.Bind(_coordinator, _reconciler, _store, _uiRoot);
        HeldCardLift.Bind(_reconciler);
        AddChild(_inputRouter);
    }

    // No-args mode: show the Connect screen stub. Pressing Connect starts the coordinator (OnConnectScreenSubmit).
    // With --shot present (no mode selected) capture the screen once it settles — the no-args gate evidence.
    private void StartConnectScreen(Args args)
    {
        _latency = args.Latency;
        _bench = args.Bench;
        _inputProbe = args.InputProbe;
        _demoInput = args.DemoInput;
        _shotPath = args.Shot;

        MountUi(withInputRouter: false);
        _uiRoot!.SetState(UiRoot.UiState.Connect);
        GD.Print($"M1E: no mode selected — Connect screen stub (Connect targets {DefaultConnectHost}).");

        if (_shotPath is not null)
        {
            _capturePending = true;
            GD.Print($"M1E_SHOT: Connect-screen capture armed → '{_shotPath}'");
        }
    }

    // The Connect button's callback: build the real stack against the entered host[:port] (blank → the default),
    // switch UiRoot to Mirror, and start the coordinator. The Connect screen is IP-ONLY now, so NO auto-join name is
    // supplied — the post-connect JoinPanel collects the player name (the coordinator still prefills from
    // lastPlayerName and persists it on a successful join). One-shot (ignores a second press once connected).
    private void OnConnectScreenSubmit(string hostPort)
    {
        if (_coordinator is not null)
        {
            return;
        }

        var host = string.IsNullOrWhiteSpace(hostPort) ? DefaultConnectHost : hostPort.Trim();
        if (!host.Contains(':'))
        {
            // The socket layer defaults a port-less entry to :13337, but the ASSET base URL below is built from
            // this raw string — without this a bare IP yields http://<ip> (port 80) and every texture fetch
            // fails: the mirror renders gray, text-only. (First hit by a phone user typing just the LAN IP.)
            host += ":13337";
        }
        _store = new MirrorStore();
        MountRenderStage($"http://{host}", new RenderOptions(InstantTweens: false));
        _stageStretch?.Apply(); // seed the fresh store's spread factor from the live window aspect

        // No auto-join name from the IP-only form (null); the JoinPanel supplies the name after connect.
        _coordinator = new ConnectionCoordinator(_store, host, autoJoinName: null, DesiredPingMs());
        _coordinator.Directive += d => GD.Print($"M1B_SESSION: {d}");
        _coordinator.Notice += n => GD.Print($"M1B: {n}");
        _coordinator.SessionUpdated += OnSessionEnvelope; // WS-U: switch the disk-cache namespace to the server token
        _uiRoot!.AttachCoordinator(_coordinator);
        _uiRoot.SetState(UiRoot.UiState.Mirror);
        MountInputRouter(); // the connect-screen path now gets gestures too (parity with --connect)
        EnsureLatencyOverlay();
        _coordinator.Start();

        GD.Print($"M1E: connect-screen submit → connect {host} (name via JoinPanel)");
    }

    // WS-U: on every `session` message, point the disk cache at the server's assetCacheToken namespace (no-op when
    // equal/null). ORDERING: the coordinator dispatches `session` synchronously in Poll BEFORE the store drains the
    // first keyframe (which is what issues the first asset fetches), so this runs before any fetch. The persisted-token
    // mount seed (MountRenderStage) covers the pathological "fetch beats session" case — worst case a few writes land
    // in the stale namespace and get pruned on the next mount; correctness is preserved.
    private void OnSessionEnvelope(SessionEnvelope env) => AssetDiskCache.Shared?.SetNamespace(env.AssetCacheToken);

    // Settings → "Back to menu": tear the entire live stack down and rebuild the Connect screen. This is the first
    // mid-process teardown+rebuild — everything that assumed a single lifecycle is reset here (process-static asset
    // caches + the HeldCardLift Drained hook) so the rebuilt stack starts clean.
    public void ReturnToMenu()
    {
        GD.Print("M1E: back-to-menu — tearing down the live stack.");

        // Teardown. Shutdown() closes sockets; nulling _coordinator also clears OnConnectScreenSubmit's one-shot guard.
        _coordinator?.Shutdown();
        _coordinator = null;

        // Unhook the process-static input/asset caches BEFORE freeing their nodes / disposing the store.
        HeldCardLift.ClearBinding();
        AssetStores.Reset();
        FontStore.ResetInstance();
        SpineClipStore.ResetInstance();
        ShaderStore.ResetInstance();
        MaterialSamplerStore.ResetInstance(); // WS-EMITTER: drop the material-sampler singleton (frees with the stage)
        AtlasTresStore.ResetInstance(); // WS-ATLAS: drop the atlas-`.tres` singleton (frees with the stage)
        AssetDiskCache.ResetInstance(); // WS-U: drop the shared cache singleton (disk files persist — warm on reconnect)
        WalkProfiler.Reset(); // WS-W: clear the walk-perf rings/counters so the rebuilt stack's percentiles start clean
        SceneReconciler.ResetPoolTotals(); // WS-P1: clear the cumulative pool telemetry alongside the walk rings
        TweenReplayer.ClearHideLatches(); // Feature B: drop any tween hide-latches + probe state for the rebuilt stack
        ParticleLayer.ResetTotals(); // WS-PARTICLE-REUSE: clear the particle rebuild/reuse counters for the rebuilt stack
        ShaderAttachment.ResetCaches(); // SHADERMATSHARE: dispose + drop the shared ShaderMaterial cache for the rebuilt stack
        LeakProbe.ResetTotals(); // descriptor-set-leak hunt: clear the created-resource counters for the rebuilt stack
        RenderActivity.Reset(); // on-demand rendering: clear grace/continuous/rendered-skipped so the rebuilt stack starts clean (the RemoveContinuous underflow guard tolerates the freed nodes' later _ExitTree releases)
        IdleSuspend.Reset(); // Track I: clear the suspended flag + counters + idle clocks so the rebuilt stack starts clean
        ContinuousBudget.Reset(); // WS-perf3: disengage the continuous-node budget so the rebuilt stack starts un-throttled

        _inputRouter?.QueueFree();
        _inputRouter = null;
        // Track I: the idle-suspend controller is a direct AppShell child (never inside the stage subtree), so free it
        // explicitly on back-to-menu (its _ExitTree unsubscribes from the now-disposed store's Drained/SpreadChanged).
        _idleSuspendController?.QueueFree();
        _idleSuspendController = null;
        // Track A: in direct-Full hosting the reconciler is parented under AppShell, NOT the container, so freeing the
        // container alone would leak it — free it explicitly (a harmless double-queue no-op in the SubViewport case,
        // where it is already a descendant of the container being freed).
        _reconciler?.QueueFree();
        _renderStageContainer?.QueueFree();
        _renderStageContainer = null;
        _renderStageViewport = null;
        _reconciler = null;
        _directStageHosting = false;
        // Track-D: in subviewport hosting the controller is freed with the stage subtree above; in direct-Full hosting
        // it was reparented under AppShell alongside the reconciler, so free it explicitly (double-queue is harmless).
        _staticBake?.QueueFree();
        _staticBake = null;
        // Track-B: the overlay CanvasLayer is a direct AppShell child (root viewport), never inside the stage subtree,
        // so free it explicitly on back-to-menu (else its promoted proxies leak past the rebuild).
        _textOverlay?.QueueFree();
        _textOverlay = null;
        // Track-C: the card layer CanvasLayer is likewise a direct AppShell child — free it explicitly (else its
        // promoted card clones leak past the rebuild).
        _cardLayer?.QueueFree();
        _cardLayer = null;
        _textures?.QueueFree();
        _textures = null;

        _store?.Dispose();
        _store = null;

        _latencyLayer?.QueueFree();
        _latencyLayer = null;
        _latencyLabel = null;

        _uiRoot?.QueueFree();
        _uiRoot = null;

        // Reset per-session AppShell state so the rebuilt stack is clean.
        _appliedPingMs = -1;
        _capturePending = false;
        _captureWaited = 0;
        _idleFrames = 0;
        _elapsed = 0;
        _deltasApplied = 0;
        _frameMsMaxSeen = 0;
        _drainMsMaxSeen = 0;
        // WS-B: spike-attribution counters share the per-session lifecycle (the heartbeat GC snapshots roll
        // forward on their own cadence, so they need no reset here).
        _spikeFrames = 0;
        _spikeFramesGc = 0;
        _spikeFramesDrain = 0;
        _prevFrameApplied = 0;
        _benchReloadArmed = false; // Track E: a rebuilt stack re-arms its reload soak from the next first keyframe
        _lastLoggedRevision = -1;
        _sinceDeltaLog = 0;
        _sinceRttLog = 0;
        _sinceWalkLog = 0;
        _appliedRenderSettingsGeneration = -1;
        _sinceRenderHeartbeat = 0;

        // Rebuild: a FRESH UiRoot (+ fresh ConnectScreen, sidestepping its _submitted latch) in Connect state, with
        // ConnectRequested + BackToMenuRequested wired via MountUi.
        MountUi(withInputRouter: false);
        _uiRoot!.SetState(UiRoot.UiState.Connect);
        GD.Print("M1E: back-to-menu complete — Connect screen rebuilt.");
    }

    // ==============================================================================================
    // Track Q — QA channel (localhost-only debug control channel; see QaServer.cs / DemoInputPlayer.cs)
    // ==============================================================================================

    // Mount the QA control channel when enabled: the CLI --qa-port wins, else the [qa] port key in user://settings.cfg
    // (the Android path — apps can't set env). It is mounted only for interactive connect / connect-screen sessions,
    // never for replay. DEFAULT OFF ⇒ port<=0 ⇒ never mounted ⇒ zero listeners / threads / cost.
    private void MaybeMountQaChannel(Args args)
    {
        if (args.Replay is not null)
        {
            return;
        }

        int port = args.QaPort > 0 ? args.QaPort : ClientSettingsStore.ReadQaPort();
        if (port <= 0)
        {
            return; // OFF — no listener, no threads, byte-identical to a build with the channel absent
        }

        _qaServer = new QaServer(port, args.QaPort > 0 ? "cli" : "settings.cfg");
        AddChild(_qaServer);
    }

    // The live retained mirror store (null until a connection mounts it) — the QA `dump`/`dumpcards`/`state` verbs read
    // it. The player re-resolves this each command, so it tracks connect/disconnect without re-binding.
    public MirrorStore? CurrentStore => _store;

    // The live stage root + static-bake controller (null until a connection mounts them) — the QA `hide`/`show` verbs
    // resolve these each command, same lazy pattern as CurrentStore.
    internal SceneReconciler? CurrentReconciler => _reconciler;
    internal StaticBake? CurrentStaticBake => _staticBake;

    // WS-CRISP dumpcrisp: the live crisp-text controllers (null until a connection mounts them) — the QA `dumpcrisp`
    // verb resolves them each command, same lazy pattern as CurrentStore.
    internal TextOverlay? CurrentTextOverlay => _textOverlay;
    internal CardLayer? CurrentCardLayer => _cardLayer;

    // QA `connect <host[:port]>`: drive the SAME path the ConnectScreen "tap connect" takes. null on success, else an
    // error reason. Refuses when a coordinator already exists (disconnect first) or outside an interactive Connect state.
    public string? QaConnect(string hostPort)
    {
        if (_coordinator is not null)
        {
            return "already-connected";
        }

        if (_uiRoot is null)
        {
            return "no-connect-screen";
        }

        OnConnectScreenSubmit(hostPort ?? string.Empty);
        return null;
    }

    // QA `disconnect`: tear the live stack down back to the Connect screen (ReturnToMenu). Err when idle.
    public string? QaDisconnect()
    {
        if (_coordinator is null)
        {
            return "not-connected";
        }

        ReturnToMenu();
        return null;
    }

    // QA `reload`: re-sync a fresh keyframe on the live connection (coordinator.Resync). Err when idle.
    public string? QaReload()
    {
        if (_coordinator is null)
        {
            return "not-connected";
        }

        _coordinator.Resync();
        return null;
    }

    // QA `state`: one JSON line built ONLY from fields already tracked for telemetry — nothing new/invasive computed.
    public string QaStateJson()
    {
        var frameP = QaFramePercentiles(); // sorted-copy percentile math runs HERE only, never per frame
        var obj = new JsonObject
        {
            ["connected"] = _coordinator is not null && _coordinator.Status == "connected",
            ["status"] = _coordinator?.Status ?? "disconnected",
            ["revision"] = _store?.Revision ?? 0,
            ["nodeCount"] = _store?.State.Nodes.Count ?? 0,
            ["renderScale"] = ClientEffectSettings.RenderScale.ToString(),
            ["hosting"] = _directStageHosting ? "direct" : "subviewport",
            ["stretchCollapse"] = StretchCollapseEffective(),
            ["directFull"] = DirectFullEffective(),
            ["overlayPromoted"] = _textOverlay?.PromotedCount ?? 0,
            // WS-CRISP R18 capture: the aggregate reject histograms so a `state` snapshot on the deck/card grid tells
            // where the crisp-text headroom is (cards MemberDynamic? sort labels Clip/Effect?) without a full dumpcrisp.
            ["cardRejects"] = _cardLayer?.RejectHistogram() ?? "off",
            ["cardTopReject"] = _cardLayer?.TopReject() ?? "off",
            ["textRejects"] = _textOverlay?.RejectHistogram() ?? "off",
            ["textTopReject"] = _textOverlay?.TopReject() ?? "off",
            // Track-ST: the before/after headline metric — crisp↔mushy transitions this session + per-minute rate, split
            // text-labels vs card-clusters. The user's flicker bug is "these should collapse to genuine occlusion events".
            ["stableText"] = true,
            ["textOverlayTransitions"] = _textOverlay?.TransitionsTotal ?? 0,
            ["cardLayerTransitions"] = _cardLayer?.TransitionsTotal ?? 0,
            ["transitionsPerMin"] = Math.Round(TransitionsPerMin(), 2),
            // Track-Z telemetry fix: the user-facing flicker rate (builds + screen-visible demotes; revives excluded).
            ["visibleTransitionsPerMin"] = Math.Round(VisibleTransitionsPerMin(), 2),
            ["buildsPerMin"] = Math.Round(BuildsPerMin(), 2),
            ["fps"] = Math.Round(Performance.GetMonitor(Performance.Monitor.TimeFps), 1),
            ["drainMsMax"] = Math.Round(_drainMsMaxSeen, 3),
            // QA GPU-experiment instrumentation: whole-frame render monitors + frame-time percentiles over the
            // always-on ring + the active forced-hide selector count (so a measurement script can sanity-check that
            // its hide config is really in force — 0 when the feature is unused).
            ["drawCalls"] = (long)Performance.GetMonitor(Performance.Monitor.RenderTotalDrawCallsInFrame),
            ["primitives"] = (long)Performance.GetMonitor(Performance.Monitor.RenderTotalPrimitivesInFrame),
            ["renderObjects"] = (long)Performance.GetMonitor(Performance.Monitor.RenderTotalObjectsInFrame),
            ["frameMsP50"] = Math.Round(frameP[0], 3),
            ["frameMsP95"] = Math.Round(frameP[1], 3),
            ["qaHidden"] = QaForcedHide.Count,
            // Track-D static bake: live state + node/region counts + cumulative build/rebake counters, so a QA soak can
            // watch RebakeTotal for a churn/thrash storm (flat after the initial settle = healthy per-region invalidation).
            // WS-MISC item 3 honest diagnostics: bakeEnabled = the EFFECTIVE (armed) enable, bakeEnable = its source
            // (env|settings|off), shaderMode = the client shader mode (Dynamic ⇒ combat band stays live ⇒ bakes little).
            ["bakeEnabled"] = _staticBake?.IsEffectivelyEnabled ?? ClientSettingsStore.StaticBake,
            ["bakeEnable"] = _staticBake?.BakeEnableSource ?? StaticBakeEnableSourceFallback(),
            ["shaderMode"] = ClientEffectSettings.ShaderMode.ToString(),
            // R9 item 10: the live manual spine override, so a QA leg can assert the mode it just pushed actually
            // took (and which mode a capture was taken under).
            ["spineMode"] = ClientEffectSettings.SpineMode.ToString(),
            ["bakeState"] = (_staticBake?.State ?? StaticBake.BakeState.Disabled).ToString(),
            ["bakeRegions"] = _staticBake?.RegionCount ?? 0,
            ["bakeNodes"] = _staticBake?.BakedNodeCount ?? 0,
            ["bakeCarriers"] = _staticBake?.CarrierNodeCount ?? 0,
            ["bakeBuilds"] = _staticBake?.BuildTotal ?? 0,
            ["bakeRebakes"] = _staticBake?.RebakeTotal ?? 0,
            // WS-BGBAKE band flatten: whether the CURRENT plan came from the flatten path + the live re-leveled
            // band painter count + the OrderChanged drains a live band bake SURVIVED via the band-prefix order guard
            // + the drains it survived via the carrier-transform follow (screen shake retransforms the quads).
            // Combat soak: bakeBand=true staying put, ~flat bakeRebakes after the wave-banner exile strikes,
            // climbing bakeOrderSkips/bakeCarrierFollows = healthy.
            ["bakeBand"] = _staticBake?.BandPlanActive ?? false,
            ["bakeLiveZ"] = _staticBake?.LiveZCount ?? 0,
            ["bakeOrderSkips"] = _staticBake?.OrderSkipTotal ?? 0,
            ["bakeCarrierFollows"] = _staticBake?.CarrierFollowTotal ?? 0,
            // Round 3: double-buffer + keyframe-survival + spread-restamp residency counters. bakeUnbakedVisibleFrames
            // is THE loop gate (frames of raw scene after the room had a bake — must stay 0 across loop seams).
            ["bakeUnbakedVisibleFrames"] = _staticBake?.UnbakedVisibleFrames ?? 0,
            ["bakeGenSwaps"] = _staticBake?.GenSwapTotal ?? 0,
            ["bakeStaleDrops"] = _staticBake?.StaleDropTotal ?? 0,
            ["bakeStaleQuadFrames"] = _staticBake?.StaleQuadFrames ?? 0,
            ["bakeStaleMaxRun"] = _staticBake?.StaleMaxRun ?? 0,
            ["bakeKeyframeSurvives"] = _staticBake?.KeyframeSurviveTotal ?? 0,
            ["bakeSpreadRestampInvalidations"] = _staticBake?.SpreadRestampInvalidationTotal ?? 0,
            ["bakeSpreadRestampSuppressed"] = _staticBake?.SpreadRestampSuppressedTotal ?? 0,
            // On-demand render counters (so a QA soak can watch renderStageSkipped climb once idle-suspend engages).
            ["renderStageRendered"] = RenderActivity.RenderedFrames,
            ["renderStageSkipped"] = RenderActivity.SkippedFrames,
            ["renderStageContinuous"] = RenderActivity.ContinuousCount,
            // WS-flameperf: cumulative MirrorNodeView._Draw invocations (canvas-item re-records). A QA soak samples the
            // delta/sec on an idle Tezcatara scene: with the flame fold ON the 79×3 flame quads stop re-recording per
            // frame.
            ["viewDrawInvocations"] = MirrorNodeView.DrawInvocations,
            // Track I per-category continuous split — localizes WHICH category holds a residual continuous while
            // idleSuspended=true (the on-device gap was a late-mounting effect re-registering behind the controller's
            // back). Only particles + shaders ever use the continuous signal (cosmetic/intent/spine are Mark-based;
            // tween is folded in by AppShell), so those are the two keys — both read 0 in a settled idle window.
            ["renderStageContinuousByCat"] = new JsonObject
            {
                ["particle"] = RenderActivity.ContinuousParticle,
                ["shader"] = RenderActivity.ContinuousShader,
            },
            // WS-perf3 continuous-render-node budget: engaged state + the AmountRatio multiplier in force + the last
            // particle-continuous count it saw, so a QA soak can confirm it engages on Tezcatara (particle>hi) and
            // never on combat (particle<lo). budgetEnabled reports the active budget policy.
            ["continuousBudgetEnabled"] = true,
            ["continuousBudgetEngaged"] = ContinuousBudget.Engaged,
            ["continuousBudgetMultiplier"] = Math.Round(ContinuousBudget.Multiplier, 3),
            ["continuousBudgetCount"] = ContinuousBudget.LastCount,
            // WS-PARTICLE-REUSE: GPU-particle emitter/material rebuild churn (the Mali/Vulkan descriptor-set exhaustion
            // driver). particleRebuilds = fresh emitter+material builds (== new descriptor sets); particleReuseSkips =
            // identical-content keyframe respecs served from the live emitter (rebuild avoided). Before the fix skips=0.
            ["particleReuseEnabled"] = true,
            ["particleRebuilds"] = ParticleLayer.RebuildTotal,
            ["particleReuseSkips"] = ParticleLayer.RebuildSkipped,
            // DESCRIPTOR-SET-LEAK HUNT (temporary telemetry). engineResources/engineObjects/engineOrphans are Godot's
            // OWN net live counts — a monotonic climb == a leak. The LeakProbe.* are per-subsystem CREATED counters (a
            // create-rate that shows up 1:1 in engineResources growth localizes the leak). SameBuild mismatch reasons:
            // particleReuseMissContent (a list/scalar genuinely differed) vs particleReuseMissNull (first build).
            ["engineResources"] = (long)Performance.GetMonitor(Performance.Monitor.ObjectResourceCount),
            ["engineObjects"] = (long)Performance.GetMonitor(Performance.Monitor.ObjectCount),
            ["engineNodes"] = (long)Performance.GetMonitor(Performance.Monitor.ObjectNodeCount),
            ["engineOrphans"] = (long)Performance.GetMonitor(Performance.Monitor.ObjectOrphanNodeCount),
            ["renderVideoMemMib"] = Math.Round(Performance.GetMonitor(Performance.Monitor.RenderVideoMemUsed) / (1024.0 * 1024.0), 2),
            ["lkGpuEmitter"] = LeakProbe.GpuEmitter,
            ["lkCpuEmitter"] = LeakProbe.CpuEmitter,
            ["lkProcMat"] = LeakProbe.ParticleProcMat,
            ["lkCanvasMat"] = LeakProbe.ParticleCanvasMat,
            ["lkShaderMat"] = LeakProbe.ShaderMat,
            // Long-session accumulation fix: deterministic-free (Dispose/Free) counters. created-minus-freed
            // (lkShaderMat − lkShaderMatFreed, lkGpuEmitter − lkGpuEmitterFreed, …) is the bounded live-wrapper series
            // the soak watches go flat vs the base commit's linear climb. lkShaderMatShared = per-view ShaderMaterial
            // allocs the SHADERMATSHARE immutable cache avoided (so lkShaderMat itself climbs far slower with it on).
            ["shaderMatShareEnabled"] = true,
            ["lkShaderMatFreed"] = LeakProbe.ShaderMatFreed,
            ["lkShaderMatShared"] = LeakProbe.ShaderMatShared,
            ["lkGpuEmitterFreed"] = LeakProbe.GpuEmitterFreed,
            ["lkCpuEmitterFreed"] = LeakProbe.CpuEmitterFreed,
            // WS-EMITTER: signature-shared emitter ShaderMaterials. lkEmitterShaderMat (created) stays bounded to the
            // distinct ShaderId|MaterialRef|mode|params signatures (a handful); lkEmitterShaderMatShared (reuses) absorbs
            // the rest; Freed advances on back-to-menu dispose. created-minus-freed is the bounded live series.
            ["emitterShadersEnabled"] = true,
            ["lkEmitterShaderMat"] = LeakProbe.EmitterShaderMat,
            ["lkEmitterShaderMatFreed"] = LeakProbe.EmitterShaderMatFreed,
            ["lkEmitterShaderMatShared"] = LeakProbe.EmitterShaderMatShared,
            ["particleReuseMissContent"] = ParticleLayer.ReuseMissContent,
            ["particleReuseMissNull"] = ParticleLayer.ReuseMissNull,
            ["particleReuseMissMode"] = ParticleLayer.ReuseMissMode,
            // WS-PARTICLE-MATSHARE: shared-material cache hits (set-3 ProcessMaterial + CanvasItemMaterial allocs
            // avoided). matShareEnabled off ⇒ per-emitter materials (pre-fix). With it on, procMatShared should DOMINATE
            // lkProcMat (only distinct signatures ever build a fresh material; the rest reuse a cached one).
            ["particleMatShareEnabled"] = true,
            ["particleProcMatShared"] = ParticleLayer.ProcMatShared,
            ["particleCanvasMatShared"] = ParticleLayer.CanvasMatShared,
            // Track I idle-animation suspend: live state + session counters (all from IdleSuspend's static core).
            ["idleSuspendEnabled"] = true,
            ["idleSuspended"] = IdleSuspend.Suspended,
            ["idleSuspendTotal"] = IdleSuspend.SuspendedTotal,
            ["idleResumeTotal"] = IdleSuspend.ResumedTotal,
            ["idleSuspendedMs"] = Math.Round(IdleSuspend.CumulativeSuspendedMs, 1),
            // WS-B GC/spike telemetry (ONE contiguous block — a sibling branch also edits QaStateJson). gc0/1/2 are
            // ABSOLUTE process collection counts (the 1Hz QA sampler diffs them); gcPauseMs is the cumulative
            // process GC pause; spikeFrames* are the >SpikeThresholdMs frame attribution counters (GC / drain).
            ["gc0"] = GC.CollectionCount(0),
            ["gc1"] = GC.CollectionCount(1),
            ["gc2"] = GC.CollectionCount(2),
            ["gcAllocBytes"] = GC.GetTotalAllocatedBytes(),
            ["gcPauseMs"] = Math.Round(GC.GetTotalPauseDuration().TotalMilliseconds, 1),
            ["spikeFrames"] = _spikeFrames,
            ["spikeFramesGc"] = _spikeFramesGc,
            ["spikeFramesDrain"] = _spikeFramesDrain,
            // WS-B drain budget: deferral count (~0 in steady play; climbs only during bursts) + the pending-parsed
            // gauge (returns to 0 after each burst — the no-stuck-deltas assertion the QA soak watches).
            ["drainDeferrals"] = _store?.DrainDeferrals ?? 0,
            ["drainPendingParsed"] = _store?.PendingParsed ?? 0,
            // WS-B material-cache overflow counters (spec-only hardening round): >0 means a full cap forced fresh
            // un-cached/private materials — the pre-cache churn hazard — and the soak evidence that would justify
            // building the refcounted LRU (docs/material-cache-eviction.md). Expected 0.
            ["matCacheOverflow"] = ParticleLayer.MatCacheOverflow,
            ["sharedMatOverflow"] = ShaderAttachment.SharedMatOverflow,
        };
        return obj.ToJsonString();
    }

    // P50/P95 of the always-on frame-delta ring via the shared Percentiles.Compute (empty ring → zeros).
    private double[] QaFramePercentiles()
    {
        var samples = new double[_qaFrameRingCount];
        Array.Copy(_qaFrameRing, samples, _qaFrameRingCount);
        return CouchCoop.MirrorProtocol.Assets.Percentiles.Compute(samples, 0.50, 0.95);
    }

    // Track-ST: the combined text + card crisp↔mushy transition rate (per minute over the elapsed session) — the
    // headline before/after number. Zero before any elapsed time to avoid a divide-by-zero spike.
    private double TransitionsPerMin()
    {
        long total = (_textOverlay?.TransitionsTotal ?? 0) + (_cardLayer?.TransitionsTotal ?? 0);
        return _elapsed > 0.5 ? total / (_elapsed / 60.0) : 0;
    }

    // Track-Z telemetry fix: the USER-FACING flicker rate — builds + screen-visible demotes only (revive pairs
    // excluded; a demote of text/cards that vanished anyway is imperceptible). The raw TransitionsPerMin above is kept
    // for soak-to-soak comparability with the ST-era numbers.
    private double VisibleTransitionsPerMin()
    {
        long total = (_textOverlay?.VisibleTransitionsTotal ?? 0) + (_cardLayer?.VisibleTransitionsTotal ?? 0);
        return _elapsed > 0.5 ? total / (_elapsed / 60.0) : 0;
    }

    // The raw promotion rate (fresh proxy/cluster builds per minute) — the cost-side signal a soak watches alongside
    // the flicker rate (a build is a viewport draw + layout, so a build storm is a perf smell even when invisible).
    private double BuildsPerMin()
    {
        long total = (_textOverlay?.BuildTotal ?? 0) + (_cardLayer?.BuildTotal ?? 0);
        return _elapsed > 0.5 ? total / (_elapsed / 60.0) : 0;
    }

    // The gated ping cadence: probes run only while --latency OR --bench OR the Settings panel is open, else off.
    private double DesiredPingMs() =>
        (_latency || _bench || (_uiRoot?.SettingsPanelOpen ?? false)) ? ProbeIntervalMs : 0;

    // Push the desired cadence to the coordinator whenever it changes (SettingsPanelOpen can toggle at runtime).
    private void ApplyPingGating()
    {
        double want = DesiredPingMs();
        if (want != _appliedPingMs)
        {
            _appliedPingMs = want;
            _coordinator?.SetPingInterval(want);
        }
    }

    // A minimal --latency RTT overlay (AppShell's OWN chrome, above UiRoot). Created once; updated each frame.
    private void EnsureLatencyOverlay()
    {
        if (!_latency || _latencyLabel is not null)
        {
            return;
        }

        _latencyLayer = new CanvasLayer { Layer = 128 };
        _latencyLabel = new Label { Position = new Vector2(12, 12) };
        _latencyLayer.AddChild(_latencyLabel);
        AddChild(_latencyLayer);
    }

    private void UpdateLatencyOverlay()
    {
        if (_latencyLabel is null || _coordinator is null)
        {
            return;
        }

        var n = _coordinator.Network;
        var g = _coordinator.Game;
        _latencyLabel.Text = $"status={_coordinator.Status}  net p50={Ms(n.P50)} p95={Ms(n.P95)}  " +
                             $"game p50={Ms(g.P50)} p95={Ms(g.P95)}";
    }

    private void FinishConnect(string reason)
    {
        if (_quitting)
        {
            return;
        }

        _quitting = true;
        GD.Print($"M1B_SUMMARY: reason={reason} elapsed={_elapsed:0.0}s revision={_store!.Revision} " +
                 $"nodes={_store.State.Nodes.Count} orderedIds={_store.State.OrderedIds.Count} " +
                 $"joined={_coordinator!.Joined} directView={_coordinator.DirectView} skipped={_store.Skipped}");
        PrintRtt();

        if (_bench)
        {
            PrintBenchResult(reason);
        }

        GetTree().Quit();
    }

    // One machine-readable line for the on-device bench harness (native-vs-web same-phone comparison). Frame times
    // come from the in-app ring — the canonical native source (gfxinfo is structurally empty for Godot/Vulkan).
    private void PrintBenchResult(string reason)
    {
        var frames = new List<double>(_frameRingCount);
        for (int i = 0; i < _frameRingCount; i++)
        {
            frames.Add(_frameRing[i]);
        }

        // WS-W: walk-perf percentiles (drain/reconcile/spread/tween), same shape as the frame-time percentiles above.
        var walkDrain = WalkProfiler.Percentiles(WalkProfiler.Metric.Drain);
        var walkReconcile = WalkProfiler.Percentiles(WalkProfiler.Metric.Reconcile);
        var walkSpread = WalkProfiler.Percentiles(WalkProfiler.Metric.Spread);
        var walkSpreadIndex = WalkProfiler.Percentiles(WalkProfiler.Metric.SpreadIndex);
        var walkTween = WalkProfiler.Percentiles(WalkProfiler.Metric.Tween);
        var walkCull = WalkProfiler.Percentiles(WalkProfiler.Metric.Cull);
        var walkBake = WalkProfiler.Percentiles(WalkProfiler.Metric.Bake);
        var walkTextOverlay = WalkProfiler.Percentiles(WalkProfiler.Metric.TextOverlay);
        var walkCardLayer = WalkProfiler.Percentiles(WalkProfiler.Metric.CardLayer);

        var obj = new JsonObject
        {
            ["reason"] = JsonValue.Create(reason),
            ["elapsedSec"] = JsonValue.Create(Math.Round(_elapsed, 3)),
            ["deltasApplied"] = JsonValue.Create(_deltasApplied),
            ["revision"] = JsonValue.Create(_store!.Revision),
            ["nodes"] = JsonValue.Create(_store.State.Nodes.Count),
            ["views"] = JsonValue.Create(_reconciler?.ViewCount ?? 0),
            ["texFetched"] = JsonValue.Create(_textures?.Fetched ?? 0),
            ["texFailed"] = JsonValue.Create(_textures?.Failed ?? 0),
            ["assetCacheHits"] = JsonValue.Create(AssetDiskCache.Hits),
            ["assetCacheMisses"] = JsonValue.Create(AssetDiskCache.Misses),
            ["assetCacheWrites"] = JsonValue.Create(AssetDiskCache.Writes),
            ["frameMsP50"] = JsonValue.Create(Math.Round(Percentile(frames, 0.50), 3)),
            ["frameMsP95"] = JsonValue.Create(Math.Round(Percentile(frames, 0.95), 3)),
            ["frameMsP99"] = JsonValue.Create(Math.Round(Percentile(frames, 0.99), 3)),
            ["frameMsMax"] = JsonValue.Create(Math.Round(_frameMsMaxSeen, 3)),
            // Track E: the precise Stopwatch max single-drain wall-time (the real keyframe-rebuild hitch).
            ["drainMsMax"] = JsonValue.Create(Math.Round(_drainMsMaxSeen, 3)),
            ["frameSamples"] = JsonValue.Create(_frameRingCount),
            ["gcAllocBytesDelta"] = JsonValue.Create(GC.GetTotalAllocatedBytes() - _startAllocBytes),
            // WS-B GC telemetry: collection/pause deltas since the StartConnect baselines + spike attribution.
            ["gcGen0Delta"] = JsonValue.Create(GC.CollectionCount(0) - _startGc0),
            ["gcGen1Delta"] = JsonValue.Create(GC.CollectionCount(1) - _startGc1),
            ["gcGen2Delta"] = JsonValue.Create(GC.CollectionCount(2) - _startGc2),
            ["gcPauseMsDelta"] = JsonValue.Create(Math.Round(GC.GetTotalPauseDuration().TotalMilliseconds - _startGcPauseMs, 1)),
            ["spikeFrames"] = JsonValue.Create(_spikeFrames),
            ["spikeFramesGc"] = JsonValue.Create(_spikeFramesGc),
            ["spikeFramesDrain"] = JsonValue.Create(_spikeFramesDrain),
            // WS-B drain budget: times DrainInto deferred a burst's tail to the next frame (~0 in steady play).
            ["drainDeferrals"] = JsonValue.Create(_store.DrainDeferrals),
            ["rttNetP50Ms"] = JsonValue.Create(_coordinator!.Network.P50),
            ["rttNetP95Ms"] = JsonValue.Create(_coordinator.Network.P95),
            ["rttGameP50Ms"] = JsonValue.Create(_coordinator.Game.P50),
            ["rttGameP95Ms"] = JsonValue.Create(_coordinator.Game.P95),
            ["walkDrainMsP50"] = JsonValue.Create(Math.Round(walkDrain.P50, 3)),
            ["walkDrainMsP95"] = JsonValue.Create(Math.Round(walkDrain.P95, 3)),
            ["walkDrainMsP99"] = JsonValue.Create(Math.Round(walkDrain.P99, 3)),
            ["walkReconcileMsP50"] = JsonValue.Create(Math.Round(walkReconcile.P50, 3)),
            ["walkReconcileMsP95"] = JsonValue.Create(Math.Round(walkReconcile.P95, 3)),
            ["walkReconcileMsP99"] = JsonValue.Create(Math.Round(walkReconcile.P99, 3)),
            ["walkSpreadMsP50"] = JsonValue.Create(Math.Round(walkSpread.P50, 3)),
            ["walkSpreadMsP95"] = JsonValue.Create(Math.Round(walkSpread.P95, 3)),
            ["walkSpreadMsP99"] = JsonValue.Create(Math.Round(walkSpread.P99, 3)),
            ["walkSpreadIndexMsP50"] = JsonValue.Create(Math.Round(walkSpreadIndex.P50, 3)),
            ["walkSpreadIndexMsP95"] = JsonValue.Create(Math.Round(walkSpreadIndex.P95, 3)),
            ["walkSpreadIndexMsP99"] = JsonValue.Create(Math.Round(walkSpreadIndex.P99, 3)),
            ["walkTweenMsP50"] = JsonValue.Create(Math.Round(walkTween.P50, 3)),
            ["walkTweenMsP95"] = JsonValue.Create(Math.Round(walkTween.P95, 3)),
            ["walkTweenMsP99"] = JsonValue.Create(Math.Round(walkTween.P99, 3)),
            ["walkCullMsP50"] = JsonValue.Create(Math.Round(walkCull.P50, 3)),
            ["walkCullMsP95"] = JsonValue.Create(Math.Round(walkCull.P95, 3)),
            ["walkCullMsP99"] = JsonValue.Create(Math.Round(walkCull.P99, 3)),
            ["walkBakeMsP50"] = JsonValue.Create(Math.Round(walkBake.P50, 3)),
            ["walkBakeMsP95"] = JsonValue.Create(Math.Round(walkBake.P95, 3)),
            ["walkBakeMsP99"] = JsonValue.Create(Math.Round(walkBake.P99, 3)),
            ["culledSelf"] = JsonValue.Create(_reconciler?.CulledSelfCount ?? 0),
            ["culledSubtree"] = JsonValue.Create(_reconciler?.CulledSubtreeCount ?? 0),
            // Static-bake state and cumulative counters support map-scroll and combat-churn soak checks.
            ["bakeEnabled"] = JsonValue.Create(
                _staticBake?.IsEffectivelyEnabled ?? ClientSettingsStore.StaticBake),
            ["bakeEnable"] = JsonValue.Create(_staticBake?.BakeEnableSource ?? StaticBakeEnableSourceFallback()),
            ["bakeState"] = JsonValue.Create((_staticBake?.State ?? StaticBake.BakeState.Disabled).ToString()),
            ["bakeRegions"] = JsonValue.Create(_staticBake?.RegionCount ?? 0),
            ["bakeNodes"] = JsonValue.Create(_staticBake?.BakedNodeCount ?? 0),
            ["bakeCarriers"] = JsonValue.Create(_staticBake?.CarrierNodeCount ?? 0),
            ["bakeBuilds"] = JsonValue.Create(_staticBake?.BuildTotal ?? 0),
            ["bakeRebakes"] = JsonValue.Create(_staticBake?.RebakeTotal ?? 0),
            // WS-BGBAKE band flatten: final band-plan flag + live re-leveled painter count + order-guard skip and
            // carrier-follow totals (see QaStateJson).
            ["bakeBand"] = JsonValue.Create(_staticBake?.BandPlanActive ?? false),
            ["bakeLiveZ"] = JsonValue.Create(_staticBake?.LiveZCount ?? 0),
            ["bakeOrderSkips"] = JsonValue.Create(_staticBake?.OrderSkipTotal ?? 0),
            ["bakeCarrierFollows"] = JsonValue.Create(_staticBake?.CarrierFollowTotal ?? 0),
            // Round 3 residency counters (see QaStateJson).
            ["bakeUnbakedVisibleFrames"] = JsonValue.Create(_staticBake?.UnbakedVisibleFrames ?? 0),
            ["bakeGenSwaps"] = JsonValue.Create(_staticBake?.GenSwapTotal ?? 0),
            ["bakeStaleDrops"] = JsonValue.Create(_staticBake?.StaleDropTotal ?? 0),
            ["bakeStaleQuadFrames"] = JsonValue.Create(_staticBake?.StaleQuadFrames ?? 0),
            ["bakeStaleMaxRun"] = JsonValue.Create(_staticBake?.StaleMaxRun ?? 0),
            ["bakeKeyframeSurvives"] = JsonValue.Create(_staticBake?.KeyframeSurviveTotal ?? 0),
            ["bakeSpreadRestampInvalidations"] = JsonValue.Create(_staticBake?.SpreadRestampInvalidationTotal ?? 0),
            ["bakeSpreadRestampSuppressed"] = JsonValue.Create(_staticBake?.SpreadRestampSuppressedTotal ?? 0),
            // Track-B text overlay: enabled/active + promoted-count + build/demote totals + the per-eval walk-ms
            // percentiles + the dominant reject reason + the full reject histogram (v2 headroom signal).
            ["textOverlayEnabled"] = JsonValue.Create(true),
            ["textOverlayActive"] = JsonValue.Create(_textOverlay?.Active ?? false),
            ["textOverlayPromoted"] = JsonValue.Create(_textOverlay?.PromotedCount ?? 0),
            ["textOverlayEvaluated"] = JsonValue.Create(_textOverlay?.LastEvaluated ?? 0),
            ["textOverlayBuilds"] = JsonValue.Create(_textOverlay?.BuildTotal ?? 0),
            ["textOverlayRevives"] = JsonValue.Create(_textOverlay?.ReviveTotal ?? 0),
            ["textOverlayDemotes"] = JsonValue.Create(_textOverlay?.DemoteTotal ?? 0),
            ["textOverlayParked"] = JsonValue.Create(_textOverlay?.ParkedCount ?? 0),
            // Track-ST: the headline before/after transition telemetry (see QaStateJson).
            ["stableText"] = JsonValue.Create(true),
            ["textOverlayTransitions"] = JsonValue.Create(_textOverlay?.TransitionsTotal ?? 0),
            ["cardLayerTransitions"] = JsonValue.Create(_cardLayer?.TransitionsTotal ?? 0),
            ["transitionsPerMin"] = JsonValue.Create(Math.Round(TransitionsPerMin(), 2)),
            // Track-Z telemetry fix: the USER-FACING flicker rate — builds + screen-visible demotes only (revive pairs
            // excluded; a demote of text that vanished anyway is imperceptible) + the raw promotion rate.
            ["zRelax"] = JsonValue.Create(true),
            ["textOverlayVisibleTransitions"] = JsonValue.Create(_textOverlay?.VisibleTransitionsTotal ?? 0),
            ["cardLayerVisibleTransitions"] = JsonValue.Create(_cardLayer?.VisibleTransitionsTotal ?? 0),
            ["visibleTransitionsPerMin"] = JsonValue.Create(Math.Round(VisibleTransitionsPerMin(), 2)),
            ["buildsPerMin"] = JsonValue.Create(Math.Round(BuildsPerMin(), 2)),
            ["textOverlayTopReject"] = JsonValue.Create(_textOverlay?.TopReject() ?? "off"),
            ["textOverlayRejectHistogram"] = JsonValue.Create(_textOverlay?.RejectHistogram() ?? "off"),
            ["walkTextOverlayMsP50"] = JsonValue.Create(Math.Round(walkTextOverlay.P50, 3)),
            ["walkTextOverlayMsP95"] = JsonValue.Create(Math.Round(walkTextOverlay.P95, 3)),
            ["walkTextOverlayMsP99"] = JsonValue.Create(Math.Round(walkTextOverlay.P99, 3)),
            ["cardLayerEnabled"] = JsonValue.Create(true),
            ["cardLayerActive"] = JsonValue.Create(_cardLayer?.Active ?? false),
            ["cardLayerPromoted"] = JsonValue.Create(_cardLayer?.PromotedCount ?? 0),
            ["cardLayerBuilds"] = JsonValue.Create(_cardLayer?.BuildTotal ?? 0),
            ["cardLayerDemotes"] = JsonValue.Create(_cardLayer?.DemoteTotal ?? 0),
            ["cardLayerClusterRebuilds"] = JsonValue.Create(_cardLayer?.ClusterRebuildTotal ?? 0),
            ["cardLayerRevives"] = JsonValue.Create(_cardLayer?.ReviveTotal ?? 0),
            ["cardLayerReviveReapplies"] = JsonValue.Create(_cardLayer?.ReviveMembersReapplied ?? 0),
            ["cardLayerTopReject"] = JsonValue.Create(_cardLayer?.TopReject() ?? "off"),
            // WS-CRISP: the FULL card-layer reject histogram (mirrors textOverlayRejectHistogram — the card-side
            // v2-headroom signal; previously only the dominant reason was surfaced).
            ["cardLayerRejectHistogram"] = JsonValue.Create(_cardLayer?.RejectHistogram() ?? "off"),
            ["walkCardLayerMsP50"] = JsonValue.Create(Math.Round(walkCardLayer.P50, 3)),
            ["walkCardLayerMsP95"] = JsonValue.Create(Math.Round(walkCardLayer.P95, 3)),
            ["walkCardLayerMsP99"] = JsonValue.Create(Math.Round(walkCardLayer.P99, 3)),
            ["walkDrainCount"] = JsonValue.Create(walkDrain.Count),
            ["walkStructuralDrains"] = JsonValue.Create(WalkProfiler.StructuralDrains),
            ["walkSpreadBails"] = JsonValue.Create(_store?.Spread.Bails ?? 0),
            ["viewPoolCreated"] = JsonValue.Create(SceneReconciler.PoolCreatedTotal),
            ["viewPoolReused"] = JsonValue.Create(SceneReconciler.PoolReusedTotal),
            ["viewPoolPooled"] = JsonValue.Create(SceneReconciler.PoolPooledTotal),
            ["viewPoolFreed"] = JsonValue.Create(SceneReconciler.PoolFreedTotal),
            // On-demand mirror-stage rendering (RenderActivity): frames the SubViewport actually rendered vs skipped
            // (Disabled), plus the live GPU-animator count at run end.
            ["renderStageOnDemand"] = JsonValue.Create(true),
            ["renderStageRendered"] = JsonValue.Create(RenderActivity.RenderedFrames),
            ["renderStageSkipped"] = JsonValue.Create(RenderActivity.SkippedFrames),
            ["renderStageContinuous"] = JsonValue.Create(RenderActivity.ContinuousCount),
            ["renderStageContinuousParticle"] = JsonValue.Create(RenderActivity.ContinuousParticle),
            ["renderStageContinuousShader"] = JsonValue.Create(RenderActivity.ContinuousShader),
            // GPU-particle rebuild churn: rebuilds count material pairs and reuseSkips identical-content respecs.
            ["particleReuseEnabled"] = JsonValue.Create(true),
            ["particleRebuilds"] = JsonValue.Create(ParticleLayer.RebuildTotal),
            ["particleReuseSkips"] = JsonValue.Create(ParticleLayer.RebuildSkipped),
            // Idle-animation suspension lets render-stage skips climb in idle combat.
            ["idleSuspendEnabled"] = JsonValue.Create(true),
            ["idleSuspendSec"] = JsonValue.Create(IdleSuspend.IdleSeconds),
            ["idleSuspended"] = JsonValue.Create(IdleSuspend.Suspended),
            ["idleSuspendTotal"] = JsonValue.Create(IdleSuspend.SuspendedTotal),
            ["idleResumeTotal"] = JsonValue.Create(IdleSuspend.ResumedTotal),
            ["idleSuspendedMs"] = JsonValue.Create(Math.Round(IdleSuspend.CumulativeSuspendedMs, 1)),
            // Track A: how the stage is hosted at run end — "direct" (reconciler under AppShell's root canvas at Full,
            // composite skipped, no idle-skip) or "subviewport" (the SubViewport chain at reduced scales).
            ["renderStageHosting"] = JsonValue.Create(_directStageHosting ? "direct" : "subviewport"),
            // Track S: window content-scale collapsed to viewport mode (P28 gone at Full, shrunk at Half). false ⇒ the
            // shipped canvas_items pipeline (byte-identical to pre-Track-S). oversampleGlyphs = the step-4 sub-switch.
            ["stretchCollapse"] = JsonValue.Create(StretchCollapseEffective()),
            ["directFull"] = JsonValue.Create(DirectFullEffective()),
            ["stretchCollapseOversample"] = JsonValue.Create(StretchCollapseEffective()),
        };

        GD.Print("BENCH_RESULT " + obj.ToJsonString());
    }

    private static double Percentile(List<double> values, double q)
    {
        if (values.Count == 0)
        {
            return 0;
        }

        var sorted = new List<double>(values);
        sorted.Sort();
        double pos = q * (sorted.Count - 1);
        int lo = (int)Math.Floor(pos);
        int hi = (int)Math.Ceiling(pos);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    }

    // Track E keyframe-diff bench driver. Inert unless COUCHCOOP_MIRROR_BENCH_RELOADS>0. Arms once the initial tree is
    // built (revision > 0), then every BenchReloadIntervalSec fires one coordinator.Resync() — a fresh socket whose Full
    // keyframe re-drives the reconciler's keyframe path over the already-built tree (the Reload hitch). Each keyframe
    // drain runs in a _Process frame, so _frameMsMaxSeen / M3_SPAWN / M3_KEYDIFF capture the per-cycle cost. Relies on
    // --duration to quit + print BENCH_RESULT after the last cycle settles.
    private void DriveBenchReloads(double delta)
    {
        if (BenchReloads == 0 || _benchReloadsRemaining == 0 || _coordinator is null)
        {
            return;
        }

        if (!_benchReloadArmed)
        {
            // Wait for the first real keyframe to have built the tree before reloading (revision advances on ≥1 drain).
            if (_store is { Revision: > 0 })
            {
                _benchReloadArmed = true;
                _sinceBenchReload = 0;
            }

            return;
        }

        _sinceBenchReload += delta;
        if (_sinceBenchReload < BenchReloadIntervalSec)
        {
            return;
        }

        _sinceBenchReload = 0;
        int cycle = BenchReloads - _benchReloadsRemaining + 1;
        _benchReloadsRemaining--;
        GD.Print($"BENCH_RELOAD: cycle={cycle}/{BenchReloads} Resync at t={_elapsed:0.0}s " +
                 $"(views={_reconciler?.ViewCount} nodes={_store?.State.Nodes.Count})");
        _coordinator.Resync();
    }

    private void PrintRtt()
    {
        var n = _coordinator!.Network;
        var g = _coordinator.Game;
        GD.Print($"M1B_RTT: net p50={Ms(n.P50)} p95={Ms(n.P95)} (n={n.Count}) " +
                 $"game p50={Ms(g.P50)} p95={Ms(g.P95)} (n={g.Count})");
    }

    // WS-W: live-session walk-perf line (see PrintBenchResult for the --bench equivalent). Silent until ≥1 drain has
    // been recorded — an idle Connect/no-delta session never prints this.
    private void PrintWalkLog()
    {
        var drain = WalkProfiler.Percentiles(WalkProfiler.Metric.Drain);
        if (drain.Count == 0)
        {
            return;
        }

        var reconcile = WalkProfiler.Percentiles(WalkProfiler.Metric.Reconcile);
        var spread = WalkProfiler.Percentiles(WalkProfiler.Metric.Spread);
        var spreadIndex = WalkProfiler.Percentiles(WalkProfiler.Metric.SpreadIndex);
        var tween = WalkProfiler.Percentiles(WalkProfiler.Metric.Tween);
        var cull = WalkProfiler.Percentiles(WalkProfiler.Metric.Cull);
        var bake = WalkProfiler.Percentiles(WalkProfiler.Metric.Bake);
        var textOverlay = WalkProfiler.Percentiles(WalkProfiler.Metric.TextOverlay);
        var cardLayer = WalkProfiler.Percentiles(WalkProfiler.Metric.CardLayer);

        // WS-B: per-heartbeat GC deltas (collections per gen, GC pause ms, MB allocated since the previous M3_WALK
        // line) + the cumulative spike-attribution counters. The snapshots roll forward each heartbeat.
        int gcNow0 = GC.CollectionCount(0);
        int gcNow1 = GC.CollectionCount(1);
        int gcNow2 = GC.CollectionCount(2);
        double gcPauseNow = GC.GetTotalPauseDuration().TotalMilliseconds;
        long allocNow = GC.GetTotalAllocatedBytes();
        string gcSeg = string.Format(
            CultureInfo.InvariantCulture,
            "gc[g0={0} g1={1} g2={2} pauseMs={3:0.0} allocMb={4:0.0} spikes={5}/gc{6}/drain{7}] ",
            gcNow0 - _walkGc0, gcNow1 - _walkGc1, gcNow2 - _walkGc2,
            gcPauseNow - _walkGcPauseMs, (allocNow - _walkAllocBytes) / (1024.0 * 1024.0),
            _spikeFrames, _spikeFramesGc, _spikeFramesDrain);
        _walkGc0 = gcNow0;
        _walkGc1 = gcNow1;
        _walkGc2 = gcNow2;
        _walkGcPauseMs = gcPauseNow;
        _walkAllocBytes = allocNow;

        GD.Print($"M3_WALK: drain p50/p95/p99={FmtWalk(drain)} reconcile={FmtWalk(reconcile)} " +
                 $"spread={FmtWalk(spread)} spreadIndex={FmtWalk(spreadIndex)} tween={FmtWalk(tween)} " +
                 $"cull={FmtWalk(cull)} bake={FmtWalk(bake)} textOverlay={FmtWalk(textOverlay)} cardLayer={FmtWalk(cardLayer)} " +
                 $"(n={drain.Count} struct={WalkProfiler.StructuralDrains} spreadBails={_store?.Spread.Bails ?? 0} " +
                 $"culled[self={_reconciler?.CulledSelfCount ?? 0} subtree={_reconciler?.CulledSubtreeCount ?? 0}] " +
                 $"bake[state={_staticBake?.State ?? StaticBake.BakeState.Disabled} nodes={_staticBake?.BakedNodeCount ?? 0} " +
                 $"carriers={_staticBake?.CarrierNodeCount ?? 0} builds={_staticBake?.BuildTotal ?? 0} rebakes={_staticBake?.RebakeTotal ?? 0}] " +
                 $"text[promoted={_textOverlay?.PromotedCount ?? 0} totals={_textOverlay?.BuildTotal ?? 0}/{_textOverlay?.DemoteTotal ?? 0} " +
                 $"trans={_textOverlay?.TransitionsTotal ?? 0} topReject={_textOverlay?.TopReject() ?? "off"}] " +
                 $"card[promoted={_cardLayer?.PromotedCount ?? 0} totals={_cardLayer?.BuildTotal ?? 0}/{_cardLayer?.DemoteTotal ?? 0} " +
                 $"trans={_cardLayer?.TransitionsTotal ?? 0} rebuilds={_cardLayer?.ClusterRebuildTotal ?? 0} topReject={_cardLayer?.TopReject() ?? "off"}] " +
                 $"transPerMin={Math.Round(TransitionsPerMin(), 1)} " +
                 $"pool[created={SceneReconciler.PoolCreatedTotal} reused={SceneReconciler.PoolReusedTotal} " +
                 $"pooled={SceneReconciler.PoolPooledTotal} freed={SceneReconciler.PoolFreedTotal}] " +
                 $"render[ondemand=true rendered={RenderActivity.RenderedFrames} " +
                 $"skipped={RenderActivity.SkippedFrames} continuous={RenderActivity.ContinuousCount} " +
                 $"cont[p={RenderActivity.ContinuousParticle} s={RenderActivity.ContinuousShader}] " +
                 $"idle[suspended={IdleSuspend.Suspended}] " +
                 $"budget[engaged={ContinuousBudget.Engaged} mult={ContinuousBudget.Multiplier.ToString("0.##", CultureInfo.InvariantCulture)} " +
                 $"count={ContinuousBudget.LastCount} hi={ContinuousBudget.High} lo={ContinuousBudget.Low}] " +
                 gcSeg +
                 $"lk[shMat={LeakProbe.ShaderMat}-{LeakProbe.ShaderMatFreed}f/{LeakProbe.ShaderMatShared}sh " +
                 $"emShMat={LeakProbe.EmitterShaderMat}-{LeakProbe.EmitterShaderMatFreed}f/{LeakProbe.EmitterShaderMatShared}sh " +
                 $"gpu={LeakProbe.GpuEmitter}-{LeakProbe.GpuEmitterFreed}f cpu={LeakProbe.CpuEmitter}-{LeakProbe.CpuEmitterFreed}f " +
                 $"orphans={(long)Performance.GetMonitor(Performance.Monitor.ObjectOrphanNodeCount)}] " +
                 $"hosting={(_directStageHosting ? "direct" : "subviewport")} stretchCollapse={StretchCollapseEffective()} directFull={DirectFullEffective()}])");
    }

    private static string FmtWalk(WalkProfiler.Stats s) =>
        $"{s.P50.ToString("0.00", CultureInfo.InvariantCulture)}/" +
        $"{s.P95.ToString("0.00", CultureInfo.InvariantCulture)}/" +
        $"{s.P99.ToString("0.00", CultureInfo.InvariantCulture)}";

    // ==============================================================================================
    // --replay
    // ==============================================================================================

    private void RunReplay(Args args)
    {
        _inputProbe = args.InputProbe; // Track S: enable the one-shot input-geometry probe in the socket-free replay path
        _store = new MirrorStore(); // no socket → SendAck stays null → no acks

        // --dump-spread: seed the spread factor from the (stretched) window BEFORE feeding, so FinishDrain's
        // Spread.Update walks at the real F≠1 — the dump below reads _store.Spread's per-node records. No render
        // stage (pure data dump); pairs with the web `data-spread-*` attributes for a root→leaf DATA diff.
        if (args.DumpSpread)
        {
            _stageStretch?.Apply(); // seed SpreadFactor from the live window aspect (same as the --shot path)
        }

        // --dump-final-state keeps the PRISTINE M1b path (no rendering) so the cross-language parity harness is
        // unaffected. Only --shot mounts the render stage.
        bool render = args.Shot is not null && !args.DumpFinalState;
        if (render)
        {
            _shotPath = args.Shot;
            if (string.IsNullOrEmpty(args.Assets))
            {
                GD.PrintErr("M1C_SHOT: --shot in --replay mode needs --assets <baseUrl> for textures; art will be blank.");
            }

            // Replay is a deterministic single-shot: InstantTweens so the final state renders with no in-flight
            // animation. Subscribe before CompleteInputAndDrain triggers the keyframe.
            MountRenderStage(args.Assets ?? "", new RenderOptions(InstantTweens: true));
            _stageStretch?.Apply(); // seed the spread factor BEFORE CompleteInputAndDrain (so FinishDrain uses it)
        }

        int fed;
        try
        {
            fed = FeedRecording(args.Replay!, _store);
        }
        catch (Exception e)
        {
            GD.PrintErr($"M1B: replay read failed for '{args.Replay}': {e.Message}");
            GetTree().Quit();
            return;
        }

        _store.CompleteInputAndDrain();

        if (args.DumpFinalState)
        {
            GD.Print("M1B_FINAL_STATE: " + BuildFinalStateJson(_store));
            GetTree().Quit();
            return;
        }

        if (args.DumpSpread)
        {
            DumpSpread(_store);
            GetTree().Quit();
            return;
        }

        GD.Print($"M1B: replay done fed={fed} revision={_store.Revision} " +
                 $"nodes={_store.State.Nodes.Count} orderedIds={_store.State.OrderedIds.Count} " +
                 $"skipped={_store.Skipped}");

        if (render)
        {
            // Views are built + textures requested; settle in _Process, then SavePng and quit.
            GD.Print($"M1C_SHOT: replay applied views={_reconciler?.ViewCount} assets[{AssetStores.Summary()}] " +
                     $"assetCache[{AssetDiskCache.CounterSummary()}] — settling…");
            _capturePending = true;
            return;
        }

        GetTree().Quit();
    }

    // Feed every repro/1 message's `data` string through the store's parse worker. The first non-empty line is an
    // exact format declaration; accepting a headerless stream would silently keep the retired passive-recording
    // format alive. Non-scene-delta data still parses to null in the worker and is skipped, exactly like live input.
    private static int FeedRecording(string path, MirrorStore store)
    {
        int fed = 0;
        bool headerRead = false;
        foreach (var line in File.ReadLines(path))
        {
            if (line.Length == 0)
            {
                continue;
            }

            if (!headerRead)
            {
                RequireReproV1Header(line, path);
                headerRead = true;
                continue;
            }

            string? data = ExtractData(line);
            if (data is null)
            {
                continue;
            }

            store.EnqueueRawDelta(Encoding.UTF8.GetBytes(data));
            fed++;
        }

        if (!headerRead)
        {
            throw new InvalidDataException($"Recording '{path}' has no repro/1 header.");
        }

        return fed;
    }

    private static void RequireReproV1Header(string line, string path)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("meta", out var meta)
                && meta.ValueKind == JsonValueKind.Object
                && meta.TryGetProperty("format", out var format)
                && format.ValueKind == JsonValueKind.String
                && format.GetString() == "repro/1")
            {
                return;
            }
        }
        catch (JsonException)
        {
            // The uniform error below names the required current recording contract.
        }

        throw new InvalidDataException($"Recording '{path}' must begin with a repro/1 meta header.");
    }

    private static string? ExtractData(string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                doc.RootElement.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.String)
            {
                return data.GetString();
            }
        }
        catch (JsonException)
        {
            // Not a JSON envelope line (meta/other) — skip.
        }

        return null;
    }

    // The cross-language final-state summary (matched byte-for-value by scripts/compare-replay-final-state.mjs's
    // TS replay): node/orderedIds counts, a 32-bit FNV-1a over the newline-joined orderedIds, the per-nodeType
    // counts (sorted), and the revision.
    private static string BuildFinalStateJson(MirrorStore store)
    {
        var state = store.State;

        var typeCounts = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var node in state.Nodes.Values)
        {
            var type = node.NodeType ?? "";
            typeCounts[type] = typeCounts.TryGetValue(type, out var c) ? c + 1 : 1;
        }

        var counts = new JsonObject();
        foreach (var kv in typeCounts)
        {
            counts[kv.Key] = JsonValue.Create(kv.Value);
        }

        var obj = new JsonObject
        {
            ["nodeCount"] = JsonValue.Create(state.Nodes.Count),
            ["orderedIdsCount"] = JsonValue.Create(state.OrderedIds.Count),
            ["orderedIdsFnv1a"] = JsonValue.Create(Fnv1a32(string.Join("\n", state.OrderedIds))),
            ["nodeTypeCounts"] = counts,
            ["revision"] = JsonValue.Create(state.Revision),
        };

        return obj.ToJsonString();
    }

    // DEBUG (--dump-spread): one NDJSON line per node with its SpreadIndex record — the native analog of the web's
    // per-element `data-spread-*` attributes. Pairs with a Playwright DOM dump for a root→leaf DATA diff of the
    // wide-screen walk (id/parentId let a consumer rebuild any chain). Gated behind the flag; prints nothing on 16:9.
    private void DumpSpread(MirrorStore store)
    {
        var state = store.State;
        GD.Print($"M2_SPREAD_DUMP_BEGIN factor={store.SpreadFactor.ToString("0.######", CultureInfo.InvariantCulture)} " +
                 $"nodes={state.Nodes.Count}");
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            store.Spread.TryGet(id, out var rec);
            double gx = store.Transforms.TryGetGlobal(id, out var g) ? g[4] : 0;
            var obj = new JsonObject
            {
                ["id"] = JsonValue.Create(id),
                ["parentId"] = JsonValue.Create(node.ParentId),
                ["name"] = JsonValue.Create(node.Name),
                ["type"] = JsonValue.Create(node.NodeType),
                ["dx"] = JsonValue.Create(Math.Round(rec.Dx, 3)),
                ["w"] = JsonValue.Create(Math.Round(rec.RenderedWidth, 3)),
                ["prop"] = JsonValue.Create(rec.Prop),
                ["paints"] = JsonValue.Create(rec.Paints),
                ["anchorL"] = JsonValue.Create(node.AnchorLeft),
                ["anchorR"] = JsonValue.Create(node.AnchorRight),
                ["mouseFilter"] = JsonValue.Create(node.MouseFilter),
                ["rectW"] = JsonValue.Create(node.LocalRect is { } lr ? Math.Round(lr.Width, 3) : (double?)null),
                ["gx"] = JsonValue.Create(Math.Round(gx, 3)),
                ["z"] = JsonValue.Create(node.ZIndex),
                ["tex"] = JsonValue.Create(node.TextureUrl is not null),
                ["fx"] = JsonValue.Create(node.ParticleSpec is not null || node.SpineSceneResPath is not null || node.ShaderId is not null || node.IntentFrames is not null || node.MaterialRef is not null),
            };
            GD.Print("M2_SPREAD_NODE " + obj.ToJsonString());
        }

        GD.Print("M2_SPREAD_DUMP_END");
    }

    // FNV-1a 32-bit over the UTF-8 bytes of `s` (identical to the TS side's Buffer-based hash).
    private static uint Fnv1a32(string s)
    {
        uint hash = 2166136261;
        foreach (var b in Encoding.UTF8.GetBytes(s))
        {
            hash ^= b;
            hash *= 16777619;
        }

        return hash;
    }

    // ==============================================================================================
    // arg parsing
    // ==============================================================================================

    private sealed class Args
    {
        public string? Connect;
        public string? Replay;
        public bool DumpFinalState;
        public bool DumpSpread;       // --dump-spread (replay): NDJSON per-node SpreadIndex records (debug DATA diff)
        public string? Name;
        public double DurationSec = -1;
        public string? Shot;          // --shot <path.png>
        public double ShotAfterSec;   // --shot-after <s> (connect mode; 0 = as soon as settled)
        public string? Assets;        // --assets <baseUrl> (texture origin for --replay --shot)
        public bool Bench;            // --bench (connect mode): BENCH_RESULT line at --duration end
        public bool Latency;          // --latency: show the RTT overlay + keep probes on
        public bool InputProbe;       // --input-probe: stub hook (WS-M)
        public string? DemoInput;     // --demo-input <script>: stub hook (WS-M)
        public bool Stretch;          // --stretch: force the M2 wide-screen widening ON (overrides the default-OFF)
        public bool NoStretch;        // --no-stretch: force it OFF (overrides both the default and the Settings toggle)
        public int QaPort = -1;       // --qa-port <n>: Track Q localhost-only debug control channel (default -1 = off)
    }

    private static Args ParseArgs(string[] argv)
    {
        var a = new Args();
        for (int i = 0; i < argv.Length; i++)
        {
            switch (argv[i])
            {
                case "--connect":
                    a.Connect = Next(argv, ref i);
                    break;
                case "--replay":
                    a.Replay = Next(argv, ref i);
                    break;
                case "--dump-final-state":
                    a.DumpFinalState = true;
                    break;
                case "--dump-spread":
                    a.DumpSpread = true;
                    break;
                case "--name":
                    a.Name = Next(argv, ref i);
                    break;
                case "--duration":
                    double.TryParse(Next(argv, ref i), NumberStyles.Any, CultureInfo.InvariantCulture, out a.DurationSec);
                    break;
                case "--shot":
                    a.Shot = Next(argv, ref i);
                    break;
                case "--shot-after":
                    double.TryParse(Next(argv, ref i), NumberStyles.Any, CultureInfo.InvariantCulture, out a.ShotAfterSec);
                    break;
                case "--assets":
                    a.Assets = Next(argv, ref i);
                    break;
                case "--bench":
                    a.Bench = true;
                    break;
                case "--latency":
                    a.Latency = true;
                    break;
                case "--input-probe":
                    a.InputProbe = true;
                    break;
                case "--demo-input":
                    a.DemoInput = Next(argv, ref i);
                    break;
                case "--stretch":
                    a.Stretch = true;
                    break;
                case "--no-stretch":
                    a.NoStretch = true;
                    break;
                case "--qa-port":
                    int.TryParse(Next(argv, ref i), NumberStyles.Integer, CultureInfo.InvariantCulture, out a.QaPort);
                    break;
                default:
                    // Unknown flags are ignored so engine-injected arguments remain harmless.
                    break;
            }
        }

        if (a.Connect is { Length: > 0 } && !a.Connect.Contains(':'))
        {
            a.Connect += ":13337";
        }

        return a;
    }

    private static string? Next(string[] argv, ref int i) => i + 1 < argv.Length ? argv[++i] : null;

    private static string Ms(double? v) => v is { } d ? d.ToString("0.0", CultureInfo.InvariantCulture) : "-";
}
