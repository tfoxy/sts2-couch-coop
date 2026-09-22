using CouchCoop.Mod.Session;
using Godot;
using System;
using CouchCoop.Mod.Localization;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Finds the lobby screens and keeps exactly one <see cref="CouchCoopQrHostPanel"/> installed on each
/// for as long as this instance is hosting a lobby.
/// </summary>
/// <remarks>
/// <para>
/// The state pull is the expensive half of an evaluation, so this controller owns the sole native host surface.
/// </para>
/// <para>
/// An evaluation GATES as well as installs: <see cref="CouchCoopLobbyHostGate"/> is evaluated every time and the
/// panel is installed or removed from the answer, so there is no separate teardown path that could miss a
/// transition. <c>netGameType</c> flips live while the host sits in the lobby, which is why a bounded 0.25s tick
/// survives at all rather than a one-shot install — but it now runs ONLY while a lobby screen is the current
/// screen, and parks the moment it is not.
/// </para>
/// <para>
/// WHAT THE EVALUATION NO LONGER DOES — and this is the point of the whole file, in two rounds.
/// </para>
/// <para>
/// ROUND ONE removed the SEARCH. It used to FIND its screens by recursively walking the entire scene tree from
/// <c>SceneTree.Root</c>, every 0.25s, forever, on the game main thread: in combat, on the map, on the main menu,
/// with a browser client connected or with none ever connected. Per node that was a native
/// <c>IsInstanceValid</c>, a <c>GetType()</c> and a <c>GetChildren()</c> that allocates a Godot array and
/// marshals a managed wrapper per child, so on a multi-thousand-node combat tree it was a periodic main-thread
/// hitch that an unmodded game does not pay. Screens now arrive by
/// <see cref="Patches.LobbyScreenMountPatch"/> and live in <see cref="LobbyScreenRegistry"/>. The recursive walk
/// survives as a ONE-SHOT startup seed (and the shutdown sweep) — see <see cref="Initialize"/>.
/// </para>
/// <para>
/// ROUND TWO removed the TIMER. The registry-gated chain was documented as existing "only while the registry is
/// occupied", and that turned out to be the whole session: the game readies its character-select screen during
/// main-menu LOAD and never frees that node, so <see cref="LobbyScreenRegistry.Live"/> never emptied and the
/// chain never parked. The early-out made each tick cheap — a prune plus one <c>IsVisibleInTree</c> per screen —
/// but 4 Hz of cheap, forever, is still a timer an unmodded game does not run. Presence is PUSHED now:
/// <c>Sts2ScreenContext.SubscribeUpdated</c> (the game's own "the active screen may have changed" event) plus
/// Godot's <c>visibility_changed</c> on each registered screen wake <see cref="Evaluate"/>, and the tick exists
/// only between them, while a lobby screen is actually current.
/// </para>
/// <para>
/// CURRENT, NOT MERELY VISIBLE. The gate on the state pull is
/// <c>visible AND Sts2ScreenContext.IsCurrent(screen)</c>. A screen parked visible underneath the one the player
/// is on is not the current screen, so the pull stops there — but such a screen KEEPS ITS PANEL. Removal is
/// driven by visibility and nothing else, because the game's current-screen answer is whatever is on top,
/// including a modal opened over the lobby, and CouchCoop's own dialog is a child of the panel that would be
/// torn down with it. See <see cref="LobbyEvaluationPlanner"/>, where that rule lives and is tested.
/// </para>
/// <para>
/// THE SAFETY VALVE. Everything above is optional by construction. If the active-screen event cannot be
/// subscribed (an older or newer game build), or the current screen cannot be resolved at that moment, the
/// evaluation falls back to EXACTLY the pre-existing behaviour — pull on visible, tick unconditionally — and
/// says so once on stderr. A screen-detection change must not be able to cost the lobby its QR button.
/// </para>
/// <para>
/// That same evaluation is the mod's only mount/unmount signal, so it also drives
/// <see cref="HostTransportAlert"/>'s once-per-mount latch. The latch is this in-memory field and
/// nothing else — see that type's remarks for why there is deliberately no persistence.
/// </para>
/// </remarks>
public static class CouchCoopQrHostPanelController
{
    /// <summary>The bounded re-read that covers a live <c>netGameType</c> flip, while a lobby is current.</summary>
    private const double TickSeconds = 0.25;

    /// <summary>
    /// First delay after a WAKE. Zero, so the evaluation lands on the next processed frame: a Godot signal or the
    /// game's screen event can be raised mid-transition, and the timer callback is the same safe point the tick
    /// has always installed from. It also coalesces a burst of events into one evaluation, because the
    /// <see cref="_scanScheduled"/> latch holds until the timer fires.
    /// </summary>
    /// <remarks>
    /// This frame boundary is not a nicety, it is the crash guard: it is the whole of what separates a game
    /// callback from reading engine state the game has not finished writing. Keep every wake path on the near
    /// side of it — see <see cref="WakeEvaluation"/>.
    /// </remarks>
    private const double WakeSeconds = 0.0;

    private static readonly object Gate = new();
    private static bool _initialized;
    private static bool _scanScheduled;

    /// <summary>
    /// Whether the running chain has actually found a current lobby. Purely a log gate: a wake arms without
    /// asking the engine anything, so "a chain started" is no longer news — "a chain reached a lobby" is.
    /// </summary>
    private static bool _chainProductive;
    private static bool _refreshRequested;
    // Keep the pending timer wrapper with the controller until its callback has run; the scan chain owns this
    // callback and must not rely on a temporary local surviving until the next tick.
    private static SceneTreeTimer? _scanTimer;

    /// <summary>
    /// The handle on the game's "active screen may have changed" event, or null when that seam is unavailable.
    /// </summary>
    private static IDisposable? _screenContextSubscription;

    /// <summary>
    /// Whether presence is actually being PUSHED to us. Read on the evaluation path; written once by
    /// <see cref="Initialize"/> and cleared by <see cref="Shutdown"/>, hence volatile.
    /// </summary>
    /// <remarks>
    /// The whole current-screen gate hangs off this. Without a subscription nothing would ever wake the
    /// evaluation, so gating on "is this the current screen?" would strand the panel — the fallback is not an
    /// optimisation to skip, it is the correctness condition for the gate.
    /// </remarks>
    private static volatile bool _screenContextSubscribed;

    /// <summary>
    /// The lobby screens currently alive, fed by <see cref="Patches.LobbyScreenMountPatch"/>. The tick runs
    /// only while this is occupied; that is the whole idle-cost fix.
    /// </summary>
    private static readonly LobbyScreenRegistry Screens = new(IsAliveNode);
    private static readonly LobbyCheckpointState Checkpoints = new(CouchCoopMod.LobbyCheckpoints);

    // Main-thread only (the scan timer), like the panels themselves.
    private static HostTransportAlertState _alertState = HostTransportAlertState.Initial;

    /// <summary>
    /// Raised (main thread) on the first evaluation that finds a HOST lobby on screen — the moment co-op is
    /// plausibly about to be used.
    /// </summary>
    /// <remarks>
    /// This is the arming signal for the LAN/WAN services that used to start unconditionally at mod init:
    /// see <see cref="CouchCoopHostUiServices.StartDiscoveryServices"/>. It fires on a HOST lobby only — a
    /// singleplayer character-select is not a co-op session and must arm nothing — which is why it is raised
    /// from the evaluation, where the state gate has already been answered, rather than from the mount patch.
    /// </remarks>
    public static event Action? HostLobbyPresented;

    public static void Initialize()
    {
        lock (Gate)
        {
            if (_initialized)
            {
                return;
            }

            _initialized = true;
        }

        // SECOND CHANCE at the mount patch, and the last one. Init applies it with the other patches, at the
        // very top of the mod's startup; this runs at the bottom, after the spirectl runtime has been composed.
        // A native precondition that was not satisfied up there may well be by now — the failure that motivated
        // this cost every patch in the mod, and a dlopen 18 ms later succeeded — and a target already installed
        // is not touched again. Still long before any lobby screen runs its _Ready, which is the ordering that
        // matters. Nothing retries after this: the miss is reported, loudly, by the patch itself.
        try
        {
            Patches.LobbyScreenMountPatch.Apply();
        }
        catch (Exception exception)
        {
            // _initialized is latched above, so a throw escaping here would cost the seed walk and every later
            // arm — the panel would be gone for the process over a retry that was only ever a second chance.
            CouchCoopLog.Stderr(
                $"lobby screen mount retry failed: {exception.GetType().Name}: {exception.Message}");
        }

        SubscribeScreenContext();

        try
        {
            if (Engine.GetMainLoop() is not SceneTree { Root: { } root })
            {
                CouchCoopLog.Stderr("qr host panel unavailable: scene tree not ready");
                return;
            }

            // This is the first point at which the controller can actually seed or scan. Do not report it
            // armed before a valid tree exists: an early engine failure is not a usable lobby controller.
            Checkpoints.ControllerArmed();

            // ONE-SHOT seed, not a tick. The mount patch only hears about screens readied AFTER it was
            // installed, so a lobby already on screen (a hot-reload generation, or a patch that landed late)
            // would otherwise never be found. This is the only full-tree walk left on the live path and it
            // runs exactly once per process.
            var seeded = 0;
            foreach (var screen in FindLobbyScreens(root))
            {
                if (!GodotObject.IsInstanceValid(screen))
                {
                    continue;
                }

                var registration = Screens.Add(screen.GetInstanceId());
                if (registration.Added)
                {
                    seeded++;
                    ConnectVisibility(screen);
                    if (CheckpointKind(screen) is { } kind)
                    {
                        Checkpoints.ScreenMounted(screen.GetInstanceId(), kind);
                    }
                }
            }

            CouchCoopLog.Stderr($"qr host panel armed seeded={seeded}");
            // Only does anything if the seed found a screen at all (a hot-reload generation, a patch that
            // landed late); the evaluation it schedules then parks itself unless that screen is current.
            // Otherwise nothing runs until a wake says otherwise.
            WakeEvaluation();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"qr host panel scan failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// A lobby screen has just been readied. Called from <see cref="Patches.LobbyScreenMountPatch"/> on the
    /// game main thread; connects the screen's visibility signal and wakes an evaluation for the next frame.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Registers even before <see cref="Initialize"/> has run (a screen readied that early is vanishingly
    /// unlikely, but dropping it would cost the lobby its panels for the rest of the process): the evaluation is
    /// then armed by <see cref="Initialize"/>'s own pass over the registry.
    /// </para>
    /// <para>
    /// A MOUNT IS NOT A LOBBY. The game readies its character-select screen during main-menu load and reuses
    /// that same node when the player later opens the lobby — no second <c>_Ready</c>, so no second call here.
    /// This is therefore only ever the moment a screen becomes KNOWN; whether it is on screen is
    /// <see cref="Evaluate"/>'s question, asked again on every wake.
    /// </para>
    /// <para>
    /// That main-menu load is also why nothing here may ask the game about its screens: this body runs inside
    /// the character-select <c>_Ready</c>, which the game invokes from underneath
    /// <c>NSceneContainer.SetCurrentScene</c> — the current screen is mid-assignment and reading it faults
    /// hard. Register, connect, wake; see <see cref="WakeEvaluation"/>.
    /// </para>
    /// </remarks>
    public static void NoteLobbyScreenMounted(Node? screen)
    {
        if (screen is null || !GodotObject.IsInstanceValid(screen))
        {
            return;
        }

        var registration = Screens.Add(screen.GetInstanceId());
        if (!registration.Added)
        {
            return; // already known — a re-ready must not connect a second signal or start a second timer chain
        }

        ConnectVisibility(screen);

        if (CheckpointKind(screen) is { } kind)
        {
            Checkpoints.ScreenMounted(screen.GetInstanceId(), kind);
        }

        CouchCoopLog.Stderr($"lobby screen mounted screen={screen.GetType().Name}");

        bool initialized;
        lock (Gate)
        {
            initialized = _initialized;
        }

        if (initialized)
        {
            WakeEvaluation();
        }
    }

    /// <summary>
    /// Take the game's "the active screen may have changed" event, if it is there.
    /// </summary>
    /// <remarks>
    /// Runs once, from <see cref="Initialize"/>, which is latched — so the fallback line below is logged at most
    /// once per process. <c>SubscribeUpdated</c> is documented to return null rather than throw when the seam is
    /// unavailable; the catch is belt-and-braces, because a throw escaping here would cost the seed walk and
    /// every later arm.
    /// </remarks>
    private static void SubscribeScreenContext()
    {
        IDisposable? subscription = null;
        try
        {
            subscription = Sts2ScreenContext.SubscribeUpdated(OnScreenContextUpdated);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"qr host panel screen context subscribe failed: {exception.GetType().Name}: {exception.Message}");
        }

        lock (Gate)
        {
            _screenContextSubscription = subscription;
        }

        _screenContextSubscribed = subscription is not null;
        if (subscription is null)
        {
            // THE SAFETY VALVE, and the one line that tells you it opened. Without the event nothing would wake
            // an evaluation, so the current-screen gate is abandoned wholesale and the 0.25s chain reverts to
            // running unconditionally while a screen is registered — the pre-change behaviour, cost and all.
            CouchCoopLog.Stderr(
                "qr host panel screen context unavailable: falling back to the unconditional 0.25s scan");
        }
    }

    /// <summary>The game says the screen on top may have changed.</summary>
    /// <remarks>
    /// Raised from inside the game's own screen transition, so this must not ask the game anything — see
    /// <see cref="WakeEvaluation"/>. It schedules; the frame boundary is what makes the answer safe to read.
    /// </remarks>
    private static void OnScreenContextUpdated() => WakeEvaluation();

    /// <summary>A registered lobby screen was shown or hidden (Godot's <c>visibility_changed</c>).</summary>
    /// <remarks>
    /// Only the SHOWN direction needs this: while a lobby screen is current the tick chain is running, so every
    /// transition away from that state — hidden, freed, or no longer current — is already seen by its next tick.
    /// Handling both directions keeps the handler free of that reasoning and costs nothing, because a wake with
    /// a chain already running returns immediately.
    /// </remarks>
    private static void OnLobbyScreenVisibilityChanged() => WakeEvaluation();

    /// <summary>
    /// Connect a newly registered screen's visibility signal.
    /// </summary>
    /// <remarks>
    /// Connected exactly once per registration (<see cref="LobbyScreenRegistry.Add"/> reports whether the id was
    /// new), and never disconnected on the live path: freeing the node drops the connection with it, which is
    /// also why the registry's liveness probe is "not freed" rather than "in the tree". The handler is static, so
    /// the connection holds no reference back to anything that could keep a screen alive.
    /// </remarks>
    private static void ConnectVisibility(Node screen)
    {
        if (screen is not CanvasItem canvasItem)
        {
            return;
        }

        try
        {
            canvasItem.VisibilityChanged += OnLobbyScreenVisibilityChanged;
        }
        catch (Exception exception)
        {
            // Not fatal: the game's own screen event covers the same transitions, and the fallback covers the
            // case where neither is there.
            CouchCoopLog.Stderr(
                $"qr host panel visibility connect failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// A wake: schedule ONE evaluation on the next processed frame, unless a chain is already running.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A WAKE ASKS THE ENGINE NOTHING. It takes the two answers it already owns — is a chain running, is the
    /// registry occupied — and schedules the deferred evaluation. Whether a lobby is actually current is
    /// <see cref="Evaluate"/>'s question, answered one frame later, and a wake that turns out to have found
    /// nothing costs exactly one evaluation that parks itself.
    /// </para>
    /// <para>
    /// WHY THE CURRENT-SCREEN PRE-CHECK IS GONE, and it must not come back. Every wake source fires from
    /// inside the game: the mount postfix runs within the screen's own <c>_Ready</c>, and the game raises its
    /// active-screen event mid-transition. Resolving <c>Sts2ScreenContext.Current</c> there reaches into
    /// <c>ActiveScreenContext</c> while the game is still assigning the current screen — during main-menu load
    /// the character-select <c>_Ready</c> runs underneath <c>NSceneContainer.SetCurrentScene</c>, so the
    /// answer does not exist yet and the read is a null dereference. In this runtime that is NOT a catchable
    /// <see cref="NullReferenceException"/>: the signal-handler chain is broken, so it takes the process down
    /// with a bare kernel <c>segfault … in memfd:doublemapper</c> and no managed stack. The <c>try</c> below
    /// cannot save it and neither can the one in <see cref="Survey"/>. Deferring by a frame is the fix —
    /// <see cref="WakeSeconds"/> already existed for exactly this reason, and the pre-check defeated it.
    /// </para>
    /// <para>
    /// Nothing is skipped by scheduling unconditionally. The chain is running whenever a lobby screen is
    /// visible and current, so every transition OUT of that state is observed by its next tick; a wake only
    /// ever has to catch a transition INTO it, and <see cref="_scanScheduled"/> coalesces a burst of events
    /// into one evaluation.
    /// </para>
    /// </remarks>
    private static void WakeEvaluation()
    {
        try
        {
            lock (Gate)
            {
                if (_scanScheduled)
                {
                    return; // a chain is already running and re-asks this question within a tick
                }
            }

            if (!Screens.IsOccupied)
            {
                return;
            }

            if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
            {
                return;
            }

            EnsureScanScheduled(root);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"qr host panel wake failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>Liveness probe for <see cref="Screens"/>: has this node been freed?</summary>
    /// <remarks>
    /// NOT "is it in the tree" — see <see cref="LobbyScreenRegistry"/> for why a hidden or detached screen
    /// must keep its entry.
    /// </remarks>
    private static bool IsAliveNode(ulong id)
    {
        try
        {
            return GodotObject.InstanceFromId(id) is Node node && GodotObject.IsInstanceValid(node);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Ask every installed QR panel to re-apply its layout on the next evaluation.
    /// </summary>
    /// <remarks>
    /// A FLAG, AND DELIBERATELY NOTHING ELSE — this is the one entry point here that is NOT main-thread. The
    /// hot-reload shell calls it by reflection (<c>CouchCoopHotReloadProtocol.RefreshOverlayLayout</c>) from
    /// whichever thread served the reload request, and the locale hook calls it under its own lock, so touching
    /// a Godot object from here would be a cross-thread call into the engine. It does not need to wake an
    /// evaluation either: a re-layout only has an effect while a panel is on screen, and while a lobby is
    /// current the 0.25s chain is running and picks the flag up within a tick.
    /// </remarks>
    public static void RefreshAll()
    {
        lock (Gate)
        {
            _refreshRequested = true;
        }
    }

    public static void Shutdown()
    {
        IDisposable? subscription;
        lock (Gate)
        {
            _initialized = false;
            _scanScheduled = false;
            _chainProductive = false;
            _refreshRequested = false;
            _scanTimer = null;
            _alertState = HostTransportAlertState.Initial;
            subscription = _screenContextSubscription;
            _screenContextSubscription = null;
        }

        _screenContextSubscribed = false;
        try
        {
            subscription?.Dispose();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"qr host panel screen context unsubscribe failed: {exception.GetType().Name}: {exception.Message}");
        }

        // A live tick chain checks _scanScheduled only when it re-arms, so an in-flight timer may still fire
        // once after this. Emptying the registry is what makes that last tick a no-op: it parks itself — so it
        // happens on BOTH arms below, tree or no tree.
        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
        {
            Screens.Clear();
            return;
        }

        // Drop the visibility connections BEFORE the registry forgets which screens have one, so a later
        // Initialize (a hot-reload generation) re-registering the same surviving node cannot connect twice and
        // double-fire. A freed screen took its connection with it and is pruned by Live() here.
        DisconnectVisibility();
        Screens.Clear();

        foreach (var screen in FindLobbyScreens(root))
        {
            RemoveFrom(screen);
        }
    }

    public static void RemoveFrom(Node? node)
    {
        if (node is null || !GodotObject.IsInstanceValid(node))
        {
            return;
        }

        node.GetNodeOrNull<CouchCoopQrHostPanel>(CouchCoopQrHostPanel.NodeName)?.QueueFree();
    }

    /// <summary>Start the tick chain unless one is already running. First evaluation lands next frame.</summary>
    private static void EnsureScanScheduled(Node root)
    {
        lock (Gate)
        {
            if (_scanScheduled)
            {
                return;
            }

            _scanScheduled = true;
        }

        ScheduleScan(root, WakeSeconds);
    }

    /// <summary>
    /// Forget every visibility connection this controller made, for the screens that still exist.
    /// </summary>
    /// <remarks>
    /// Paired exactly with <see cref="ConnectVisibility"/>: the registry is connected on <c>Add</c> and cleared
    /// only by <see cref="Shutdown"/>, so the ids surviving <see cref="LobbyScreenRegistry.Live"/> here are
    /// precisely the live screens that were connected.
    /// </remarks>
    private static void DisconnectVisibility()
    {
        foreach (var id in Screens.Live())
        {
            try
            {
                if (GodotObject.InstanceFromId(id) is CanvasItem canvasItem
                    && GodotObject.IsInstanceValid(canvasItem))
                {
                    canvasItem.VisibilityChanged -= OnLobbyScreenVisibilityChanged;
                }
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr(
                    $"qr host panel visibility disconnect failed: {exception.GetType().Name}: {exception.Message}");
            }
        }
    }

    /// <summary>
    /// Mark the chain stopped so the next mount can start a fresh one. Returns whether the chain had reached a
    /// current lobby, which is what makes this park worth a log line.
    /// </summary>
    private static bool ParkScan()
    {
        lock (Gate)
        {
            var wasProductive = _chainProductive;
            _scanScheduled = false;
            _scanTimer = null;
            _chainProductive = false;
            return wasProductive;
        }
    }

    private static void ScheduleScan(Node root, double delaySeconds)
    {
        if (!GodotObject.IsInstanceValid(root))
        {
            ParkScan();
            return;
        }

        var timer = root.GetTree().CreateTimer(delaySeconds,
            processAlways: true,
            ignoreTimeScale: true);
        lock (Gate)
        {
            _scanTimer = timer;
        }
        timer.Timeout += () =>
        {
            lock (Gate)
            {
                if (!ReferenceEquals(_scanTimer, timer))
                {
                    return;
                }
                _scanTimer = null;
            }
            if (!GodotObject.IsInstanceValid(root))
            {
                ParkScan();
                return;
            }

            // Default TRUE on a throw: a transient fault must not park the chain permanently, which would
            // cost the lobby its panels for the rest of the process. The occupancy answer that CAN park it
            // is taken inside Evaluate, before anything fallible runs.
            var keepTicking = true;
            try
            {
                keepTicking = Evaluate();
            }
            catch (Exception exception)
            {
                // A throw here would kill the timer chain and with it every future evaluation, so the panel
                // would never appear again this session. Log and keep the loop alive instead.
                CouchCoopLog.Stderr($"qr host panel scan tick failed: {exception.GetType().Name}: {exception.Message}");
            }

            // The first evaluation to find a current lobby announces the chain; the rest say nothing. A wake
            // arms unconditionally (see WakeEvaluation), so most chains are one evaluation that parks again
            // immediately — logging those would put a line pair on stderr for every map open, submenu push and
            // screen change in the game.
            if (keepTicking)
            {
                bool announce;
                lock (Gate)
                {
                    announce = !_chainProductive;
                    _chainProductive = true;
                }

                if (announce)
                {
                    CouchCoopLog.Stderr("qr host panel scan running (lobby screen current)");
                }
            }
            else
            {
                // No lobby screen is current any more: stop ticking entirely. This is the idle state an
                // unmodded game is being compared against — a wake restarts the chain. Both reasons are
                // logged because they are different bugs when one of them is wrong: an empty registry means
                // the screens were freed, a non-current one means the player navigated away.
                if (ParkScan())
                {
                    CouchCoopLog.Stderr(Screens.IsOccupied
                        ? "qr host panel scan parked (lobby screen not current)"
                        : "qr host panel scan parked (no lobby screen)");
                }

                return;
            }

            ScheduleScan(root, TickSeconds);
        };
    }

    /// <summary>The nodes behind a set of registered ids, skipping any that went stale in between.</summary>
    private static List<Node> ResolveScreens(IReadOnlyList<ulong> ids)
    {
        var screens = new List<Node>(ids.Count);
        foreach (var id in ids)
        {
            if (GodotObject.InstanceFromId(id) is Node node && GodotObject.IsInstanceValid(node))
            {
                screens.Add(node);
            }
        }

        return screens;
    }

    /// <summary>
    /// Read the two engine facts the gate needs, per screen, plus whether the current-screen seam could answer
    /// at all. The returned list is index-aligned with <paramref name="screens"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>Sts2ScreenContext.Current</c> is resolved ONCE per evaluation and compared by reference — which is
    /// exactly what <c>Sts2ScreenContext.IsCurrent</c> does per call — because the evaluation also has to
    /// distinguish "this screen is not the current one" from "the seam cannot tell me what the current one is".
    /// Only the first is a reason to skip work; the second is the fallback, and asking per screen would throw
    /// that distinction away.
    /// </para>
    /// <para>
    /// CALLERS MUST BE AT A FRAME BOUNDARY — i.e. inside the <see cref="ScheduleScan"/> timer callback, which
    /// is the only caller. Resolving the current screen from within a game callback (a <c>_Ready</c> postfix,
    /// the active-screen event) reads <c>ActiveScreenContext</c> mid-transition and faults; the <c>catch</c>
    /// below does not help, because this runtime cannot turn that fault into a managed exception. See
    /// <see cref="WakeEvaluation"/> for the full account.
    /// </para>
    /// </remarks>
    private static List<LobbyScreenFacts> Survey(List<Node> screens, out bool currentScreenKnown)
    {
        object? current = null;
        try
        {
            current = Sts2ScreenContext.Current;
        }
        catch
        {
            // Documented as total, but a null answer is the safe reading either way: it opens the fallback.
        }

        currentScreenKnown = _screenContextSubscribed && current is not null;

        var facts = new List<LobbyScreenFacts>(screens.Count);
        foreach (var screen in screens)
        {
            facts.Add(new LobbyScreenFacts(
                screen.GetInstanceId(),
                IsVisibleInTree(screen),
                ReferenceEquals(screen, current)));
        }

        return facts;
    }

    /// <summary>One evaluation. Returns whether the bounded tick chain should keep running.</summary>
    private static bool Evaluate()
    {
        // FIRST, and infallible: prune freed screens and take the occupancy answer before any Godot call
        // that could throw, so "should I keep ticking?" is never decided by a transient fault.
        var ids = Screens.Live();
        if (ids.Count == 0)
        {
            // No lobby in the tree at all is an unmount as far as the alert is concerned, and this is the
            // early return the rest of the evaluation takes on the main menu and mid-run — so the latch has
            // to be re-armed HERE, not only below.
            DecideHostTransportAlert(null);
            return false;
        }

        var screens = ResolveScreens(ids);
        var facts = Survey(screens, out var currentScreenKnown);
        var plan = LobbyEvaluationPlanner.Decide(facts, currentScreenKnown);

        if (!plan.PullState)
        {
            // Nothing is both visible and current, so the state pull — the expensive half — would decide
            // nothing. Hidden screens still give up their panels: removal is keyed on VISIBILITY, exactly as
            // before, so a lobby parked visible under a modal keeps its panel (and with it CouchCoop's own
            // open dialog, which is that panel's child).
            for (var index = 0; index < screens.Count; index++)
            {
                if (facts[index].Visible)
                {
                    continue;
                }

                var screen = screens[index];
                if (CheckpointKind(screen) is { } kind)
                {
                    Checkpoints.EndVisibleEpoch(screen.GetInstanceId(), kind);
                }
                RemoveFrom(screen);
            }

            if (plan.Alert == LobbyAlertUpdate.Rearm)
            {
                DecideHostTransportAlert(null);
            }

            return plan.KeepTicking;
        }

        // Only pull state once a lobby screen is actually the screen the player is on — the state read is the
        // expensive half of an evaluation, and on the main menu or mid-combat there is nothing to decide.
        var snapshot = CouchCoopMod.HostUiSnapshot;
        var lobbyState = CouchCoopMod.TryGetLobbyState();
        // Keep the QR entry point reachable when the browser listener failed. The dialog's empty state
        // names that failure; hiding the only host-facing explanation stranded controller users in the lobby.
        var shouldShow = CouchCoopLobbyHostGate.IsHostLobby(lobbyState);
        var evaluation = lobbyState is null
            ? LobbyCheckpointEvaluation.Unavailable
            : shouldShow ? LobbyCheckpointEvaluation.Host : LobbyCheckpointEvaluation.NotHost;
        // A host lobby is on screen: arm the LAN/WAN services that no longer start at mod init. Raised on
        // IsHostLobby (not ShouldShow) so a host whose listener failed to bind still gets them — and never
        // on a singleplayer lobby, which is the whole point of gating here rather than at the mount patch.
        // The subscriber is idempotent and self-latching, so re-raising it every tick is harmless; keeping
        // the raise unconditional means there is no "already armed?" flag here to fall out of sync.
        if (CouchCoopLobbyHostGate.IsHostLobby(lobbyState))
        {
            try
            {
                HostLobbyPresented?.Invoke();
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr(
                    $"host lobby arm failed: {exception.GetType().Name}: {exception.Message}");
            }
        }

        bool refresh;
        lock (Gate)
        {
            refresh = _refreshRequested;
            _refreshRequested = false;
        }

        CouchCoopQrHostPanel? mounted = null;
        for (var index = 0; index < screens.Count; index++)
        {
            var screen = screens[index];
            try
            {
                // Index-aligned with `screens` by construction: Survey emits one fact per screen, in order.
                var screenFacts = facts[index];

                // A lobby parked visible UNDERNEATH the current screen is left entirely alone — panel
                // included. See LobbyEvaluationPlanner.IsParkedUnderAnotherScreen for why removal must not
                // follow "not current".
                if (LobbyEvaluationPlanner.IsParkedUnderAnotherScreen(screenFacts, currentScreenKnown))
                {
                    continue;
                }

                if (screenFacts.Visible && CheckpointKind(screen) is { } kind)
                {
                    Checkpoints.VisibleHostLobbyEvaluated(screen.GetInstanceId(), kind, evaluation);
                }

                // Unconditional: `mounted ??= ScanScreen(...)` would short-circuit and skip installing on a
                // second visible lobby screen. Only the FIRST panel is remembered, as the alert's host.
                var panel = ScanScreen(screen, snapshot, shouldShow, refresh, screenFacts.Visible);
                mounted ??= panel;
            }
            catch (Exception exception)
            {
                // PER SCREEN, deliberately. One stale node used to throw out of the whole tick, and since
                // the next tick walks the same tree it threw again — for the rest of the process, with both
                // panels gone and surviving main-menu round trips. Isolating a screen keeps its siblings
                // working and lets the next tick re-install once the stale node has actually gone.
                CouchCoopLog.Stderr(
                    $"qr host panel screen scan failed: {exception.GetType().Name}: {exception.Message}");
            }
        }

        DecideHostTransportAlert(mounted);
        return true;
    }

    /// <summary>
    /// One screen's half of <see cref="Evaluate"/>, isolated so a stale node cannot poison the whole
    /// evaluation.
    /// </summary>
    /// <param name="visible">
    /// This screen's <c>IsVisibleInTree</c>, as surveyed for the gate. Passed rather than re-read so the panel
    /// decision and the gate decision cannot disagree about what was on screen this evaluation.
    /// </param>
    /// <returns>The QR panel mounted on this screen, or <see langword="null"/> if none is usable yet.</returns>
    private static CouchCoopQrHostPanel? ScanScreen(
        Node screen,
        CouchCoopHostUiSnapshot snapshot,
        bool shouldShow,
        bool refresh,
        bool visible)
    {
        if (!GodotObject.IsInstanceValid(screen))
        {
            return null;
        }

        CouchCoopQrHostPanel? mounted = null;

        // Isolate installation so a transient node failure cannot stop later refreshes.
        try
        {
            if (!visible)
            {
                if (CheckpointKind(screen) is { } hiddenKind)
                {
                    Checkpoints.EndVisibleEpoch(screen.GetInstanceId(), hiddenKind);
                }
                RemoveFrom(screen);
            }
            else if (!shouldShow)
            {
                if (CheckpointKind(screen) is { } nonHostKind)
                {
                    Checkpoints.EndPanelInstallEpoch(screen.GetInstanceId(), nonHostKind);
                }
                RemoveFrom(screen);
            }
            else
            {
                mounted = EnsurePanel(screen, snapshot, refresh);
            }
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"qr host panel step failed: {exception.GetType().Name}: {exception.Message}");
        }

        return mounted;
    }

    /// <summary>
    /// Runs the once-per-mount latch and pops the alert on the evaluation it says to.
    /// </summary>
    /// <param name="mounted">
    /// The visible host-lobby panel, or <see langword="null"/> for "no host lobby on screen" — which
    /// re-arms the latch, so backing out to the menu and coming back shows the alert again.
    /// </param>
    /// <remarks>
    /// NOT called at all when a lobby is visible but not current (<see cref="LobbyAlertUpdate.Hold"/>): a modal
    /// opening over the lobby is not an unmount, and passing null there would re-arm the latch and pop the alert
    /// again every time the player closed a dialog.
    /// </remarks>
    private static void DecideHostTransportAlert(CouchCoopQrHostPanel? mounted)
    {
        // A panel that went stale between install and here is NOT a mount: treating it as one would both
        // throw on ShowHostTransportAlert and burn the once-per-mount latch on an alert nobody saw.
        if (mounted is not null && !GodotObject.IsInstanceValid(mounted))
        {
            mounted = null;
        }

        var notice = CouchCoopHostUiNotices.HostTransportNote;
        var decision = HostTransportAlert.Decide(
            _alertState,
            mounted is not null,
            notice);
        _alertState = decision.Next;

        if (!decision.Open || mounted is null)
        {
            return;
        }

        if (notice is { } localizedNotice)
        {
            mounted.ShowHostTransportAlert(localizedNotice);
        }
        CouchCoopLog.Stderr($"host transport alert shown note={notice?.ResolveForLanguage(CouchCoopLocalization.EnglishLanguage)}");
    }

    /// <summary>
    /// Whether a panel already found on a screen can be driven this tick.
    /// </summary>
    /// <remarks>
    /// <c>GetNodeOrNull</c> will happily hand back a node that has already been <c>QueueFree</c>d (the free
    /// lands at the end of the frame) or whose native half has gone, and touching one throws
    /// <see cref="ObjectDisposedException"/> out of the tick. Answering NO drops the stale reference and
    /// installs NOTHING this tick — adding a replacement while the dying node still holds the contracted
    /// node name would get the newcomer renamed by Godot, breaking the name contract that both the live
    /// probe and the mirror stream-skip stamp depend on. The next tick, 0.25s later, installs it cleanly.
    /// </remarks>
    private static bool IsUsablePanel(Node? panel)
        => panel is not null && GodotObject.IsInstanceValid(panel) && !panel.IsQueuedForDeletion();

    private static CouchCoopQrHostPanel? EnsurePanel(Node screen, CouchCoopHostUiSnapshot snapshot, bool refreshLayout)
    {
        var kind = CheckpointKind(screen);
        var instanceId = screen.GetInstanceId();
        CouchCoopQrHostPanel? panel;
        try
        {
            panel = screen.GetNodeOrNull<CouchCoopQrHostPanel>(CouchCoopQrHostPanel.NodeName);
        }
        catch
        {
            if (kind is { } lookupKind && Checkpoints.BeginPanelInstall(instanceId, lookupKind))
            {
                Checkpoints.PanelInstallFailed(instanceId, lookupKind, QrPanelInstallFailureCategory.Lookup);
            }
            return null;
        }

        if (panel is not null && !IsUsablePanel(panel))
        {
            return null;
        }

        if (panel is null)
        {
            if (kind is { } installKind)
            {
                _ = Checkpoints.BeginPanelInstall(instanceId, installKind);
            }

            try
            {
                panel = new CouchCoopQrHostPanel();
            }
            catch
            {
                PanelInstallFailed(instanceId, kind, QrPanelInstallFailureCategory.Create, null);
                return null;
            }

            // Stamp BEFORE AddChild: spirectl's scene watcher can observe the node the moment it enters
            // the tree, so a stamp applied afterwards races a keyframe and the button could reach a
            // phone — where tapping it would open this dialog on the host's TV.
            try
            {
                CouchCoopStreamSkip.Stamp(panel);
            }
            catch
            {
                PanelInstallFailed(instanceId, kind, QrPanelInstallFailureCategory.StreamSkip, panel);
                return null;
            }

            try
            {
                screen.AddChild(panel);
            }
            catch
            {
                PanelInstallFailed(instanceId, kind, QrPanelInstallFailureCategory.Attach, panel);
                return null;
            }

            try
            {
                panel.Install();
            }
            catch
            {
                PanelInstallFailed(instanceId, kind, QrPanelInstallFailureCategory.Initialize, panel);
                return null;
            }

            CouchCoopLog.Stderr($"qr host panel installed screen={screen.GetType().Name}");
        }
        else if (refreshLayout)
        {
            panel.ApplyLayout();
        }

        try
        {
            panel.Visible = true;
            panel.Apply(snapshot);
        }
        catch
        {
            PanelInstallFailed(instanceId, kind, QrPanelInstallFailureCategory.Activate, panel);
            return null;
        }

        if (kind is { } completeKind)
        {
            Checkpoints.PanelInstallComplete(instanceId, completeKind);
        }
        return panel;
    }

    private static void PanelInstallFailed(
        ulong instanceId,
        LobbyCheckpointScreenKind? kind,
        QrPanelInstallFailureCategory category,
        CouchCoopQrHostPanel? panel)
    {
        if (kind is { } checkpointKind)
        {
            Checkpoints.PanelInstallFailed(instanceId, checkpointKind, category);
        }

        if (panel is null)
        {
            return;
        }

        try
        {
            if (GodotObject.IsInstanceValid(panel))
            {
                panel.QueueFree();
            }
        }
        catch
        {
            // The panel is auxiliary. The bounded checkpoint above is the support record.
        }
    }

    private static LobbyCheckpointScreenKind? CheckpointKind(Node node)
        => node.GetType().Name switch
        {
            "NCharacterSelectScreen" => LobbyCheckpointScreenKind.CharacterSelect,
            "NMultiplayerLoadGameScreen" => LobbyCheckpointScreenKind.LoadGame,
            _ => null,
        };

    /// <summary>
    /// Every lobby screen under <paramref name="root"/>, skipping nodes that have gone stale.
    /// </summary>
    /// <remarks>
    /// <para>
    /// TWO CALLERS, BOTH ONE-SHOT: the startup seed in <see cref="Initialize"/> and the shutdown sweep. This
    /// used to run on every 0.25s tick, which is the idle cost the mount patch removed — do not put it back
    /// on the timer. It is kept for the seed because a screen readied before the patch landed has no other
    /// way to be found, and that case is worth one walk per process.
    /// </para>
    /// An explicit stack rather than the recursive iterator this replaces, for one reason: a single freed
    /// node anywhere in the tree threw <see cref="ObjectDisposedException"/> out of the walk, which aborted
    /// the tick before any panel could be installed — and because every tick re-walks from the same root, it
    /// aborted every LATER tick too, so both panels stayed gone for the rest of the process. C# forbids
    /// <c>yield return</c> inside a <c>try</c>/<c>catch</c>, so the walk cannot be both lazy and defensive;
    /// it is now eager and swallows a bad node in favour of its siblings. Children are pushed in reverse so
    /// the pop order stays the original pre-order DFS (the FIRST screen found hosts the transport alert).
    /// </remarks>
    private static List<Node> FindLobbyScreens(Node root)
    {
        var found = new List<Node>();
        if (!GodotObject.IsInstanceValid(root))
        {
            return found;
        }

        var pending = new Stack<Node>();
        pending.Push(root);

        while (pending.Count > 0)
        {
            var node = pending.Pop();
            if (!GodotObject.IsInstanceValid(node))
            {
                continue;
            }

            try
            {
                if (IsLobbyScreen(node))
                {
                    found.Add(node);
                }

                var children = node.GetChildren();
                for (var i = children.Count - 1; i >= 0; i--)
                {
                    pending.Push(children[i]);
                }
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr(
                    $"qr host panel walk skipped a stale node: {exception.GetType().Name}: {exception.Message}");
            }
        }

        return found;
    }

    // Matched by name as well as full name because the mod must not hard-bind to a game type it only
    // reaches reflectively at runtime. Both screens are lobbies the host can be joined from: the
    // character-select screen for a new run, and the multiplayer load screen for resuming a saved one.
    private static bool IsLobbyScreen(Node node)
    {
        var type = node.GetType();
        return type.Name is "NCharacterSelectScreen" or "NMultiplayerLoadGameScreen"
            || type.FullName is "MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen"
                or "MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NMultiplayerLoadGameScreen";
    }

    private static bool IsVisibleInTree(Node node)
        => node is not CanvasItem canvasItem || canvasItem.IsVisibleInTree();
}
