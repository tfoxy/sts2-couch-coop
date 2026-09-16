using CouchCoop.Mod.Session;
using Godot;
using System;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Finds the lobby screens and keeps exactly one <see cref="CouchCoopQrHostPanel"/> installed on each
/// for as long as this instance is hosting a lobby.
/// </summary>
/// <remarks>
/// <para>
/// The state pull is the expensive half of the tick, so this controller owns the sole native host surface.
/// </para>
/// <para>
/// The 0.25s tick GATES as well as installs: <see cref="CouchCoopLobbyHostGate"/> is evaluated every
/// tick and the panel is installed or removed from the answer, so there is no separate teardown path
/// that could miss a transition. <c>netGameType</c> flips live while the host sits in the lobby, which
/// is why a tick is still the right shape here rather than a one-shot install.
/// </para>
/// <para>
/// WHAT THE TICK NO LONGER DOES — and this is the point of the whole file. It used to FIND its screens
/// by recursively walking the entire scene tree from <c>SceneTree.Root</c>, every 0.25s, forever, on the
/// game main thread: in combat, on the map, on the main menu, with a browser client connected or with
/// none ever connected. Per node that was a native <c>IsInstanceValid</c>, a <c>GetType()</c> and a
/// <c>GetChildren()</c> that allocates a Godot array and marshals a managed wrapper per child, so on a
/// multi-thousand-node combat tree it was a periodic main-thread hitch that an unmodded game does not
/// pay. The mod's contract is that an unused install is indistinguishable from no install, and that walk
/// was the largest breach of it. Screens now arrive by <see cref="Patches.LobbyScreenMountPatch"/> and
/// live in <see cref="LobbyScreenRegistry"/>; the timer exists ONLY while that registry is occupied, so
/// outside a lobby this controller does nothing at all. The recursive walk survives as a ONE-SHOT
/// startup seed (and the shutdown sweep) — see <see cref="Initialize"/>.
/// </para>
/// <para>
/// That same tick is the mod's only mount/unmount signal, so it also drives
/// <see cref="HostTransportAlert"/>'s once-per-mount latch. The latch is this in-memory field and
/// nothing else — see that type's remarks for why there is deliberately no persistence.
/// </para>
/// </remarks>
public static class CouchCoopQrHostPanelController
{
    private static readonly object Gate = new();
    private static bool _initialized;
    private static bool _scanScheduled;
    private static bool _refreshRequested;
    // Keep the pending timer wrapper with the controller until its callback has run; the scan chain owns this
    // callback and must not rely on a temporary local surviving until the next tick.
    private static SceneTreeTimer? _scanTimer;

    /// <summary>
    /// The lobby screens currently alive, fed by <see cref="Patches.LobbyScreenMountPatch"/>. The tick runs
    /// only while this is occupied; that is the whole idle-cost fix.
    /// </summary>
    private static readonly LobbyScreenRegistry Screens = new(IsAliveNode);

    // Main-thread only (the scan timer), like the panels themselves.
    private static HostTransportAlertState _alertState = HostTransportAlertState.Initial;

    /// <summary>
    /// Raised (main thread) on the first tick that finds a HOST lobby on screen — the moment co-op is
    /// plausibly about to be used.
    /// </summary>
    /// <remarks>
    /// This is the arming signal for the LAN/WAN services that used to start unconditionally at mod init:
    /// see <see cref="CouchCoopHostUiServices.StartDiscoveryServices"/>. It fires on a HOST lobby only — a
    /// singleplayer character-select is not a co-op session and must arm nothing — which is why it is raised
    /// from the tick, where the state gate has already been evaluated, rather than from the mount patch.
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

        try
        {
            if (Engine.GetMainLoop() is not SceneTree { Root: { } root })
            {
                CouchCoopLog.Stderr("qr host panel unavailable: scene tree not ready");
                return;
            }

            // ONE-SHOT seed, not a tick. The mount patch only hears about screens readied AFTER it was
            // installed, so a lobby already on screen (a hot-reload generation, or a patch that landed late)
            // would otherwise never be found. This is the only full-tree walk left on the live path and it
            // runs exactly once per process.
            var seeded = 0;
            foreach (var screen in FindLobbyScreens(root))
            {
                if (GodotObject.IsInstanceValid(screen) && Screens.Add(screen.GetInstanceId()))
                {
                    seeded++;
                }
            }

            CouchCoopLog.Stderr($"qr host panel armed seeded={seeded}");
            if (Screens.IsOccupied)
            {
                EnsureScanScheduled(root);
            }
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"qr host panel scan failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// A lobby screen has just been readied. Called from <see cref="Patches.LobbyScreenMountPatch"/> on the
    /// game main thread; starts the scan timer if it was parked.
    /// </summary>
    /// <remarks>
    /// Registers even before <see cref="Initialize"/> has run (a screen readied that early is vanishingly
    /// unlikely, but dropping it would cost the lobby its panels for the rest of the process): the timer is
    /// then started by <see cref="Initialize"/>'s own occupancy check.
    /// </remarks>
    public static void NoteLobbyScreenMounted(Node? screen)
    {
        if (screen is null || !GodotObject.IsInstanceValid(screen))
        {
            return;
        }

        if (!Screens.Add(screen.GetInstanceId()))
        {
            return; // already known — a re-ready must not start a second timer chain
        }

        CouchCoopLog.Stderr($"lobby screen mounted screen={screen.GetType().Name}");

        bool initialized;
        lock (Gate)
        {
            initialized = _initialized;
        }

        if (initialized && Engine.GetMainLoop() is SceneTree { Root: { } root })
        {
            EnsureScanScheduled(root);
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
    /// Ask every installed QR panel to re-apply its layout on the next scan tick.
    /// </summary>
    public static void RefreshAll()
    {
        lock (Gate)
        {
            _refreshRequested = true;
        }
    }

    public static void Shutdown()
    {
        lock (Gate)
        {
            _initialized = false;
            _scanScheduled = false;
            _refreshRequested = false;
            _scanTimer = null;
            _alertState = HostTransportAlertState.Initial;
        }

        // A live tick chain checks _scanScheduled only when it re-arms, so an in-flight timer may still fire
        // once after this. Emptying the registry is what makes that last tick a no-op: it parks itself.
        Screens.Clear();

        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
        {
            return;
        }

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

    /// <summary>Start the tick chain unless one is already running.</summary>
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

        CouchCoopLog.Stderr("qr host panel scan scheduled");
        ScheduleScan(root);
    }

    /// <summary>Mark the chain stopped so the next mount can start a fresh one.</summary>
    private static void ParkScan()
    {
        lock (Gate)
        {
            _scanScheduled = false;
            _scanTimer = null;
        }
    }

    private static void ScheduleScan(Node root)
    {
        if (!GodotObject.IsInstanceValid(root))
        {
            ParkScan();
            return;
        }

        var timer = root.GetTree().CreateTimer(0.25,
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
            // is taken inside Scan, before anything fallible runs.
            var keepTicking = true;
            try
            {
                keepTicking = Scan();
            }
            catch (Exception exception)
            {
                // A throw here would kill the timer chain and with it every future scan, so the panel
                // would never appear again this session. Log and keep the loop alive instead.
                CouchCoopLog.Stderr($"qr host panel scan tick failed: {exception.GetType().Name}: {exception.Message}");
            }

            if (!keepTicking)
            {
                // No lobby screen left alive: stop ticking entirely. This is the idle state an unmodded
                // game is being compared against — the next _Ready postfix restarts the chain.
                ParkScan();
                CouchCoopLog.Stderr("qr host panel scan parked (no lobby screen)");
                return;
            }

            ScheduleScan(root);
        };
    }

    /// <summary>One tick. Returns whether the chain should keep running.</summary>
    private static bool Scan()
    {
        // FIRST, and infallible: prune freed screens and take the occupancy answer before any Godot call
        // that could throw, so "should I keep ticking?" is never decided by a transient fault.
        var ids = Screens.Live();
        if (ids.Count == 0)
        {
            // No lobby in the tree at all is an unmount as far as the alert is concerned, and this is the
            // early return the rest of the scan takes on the main menu and mid-run — so the latch has to
            // be re-armed HERE, not only below.
            DecideHostTransportAlert(null);
            return false;
        }

        var screens = new List<Node>(ids.Count);
        foreach (var id in ids)
        {
            if (GodotObject.InstanceFromId(id) is Node node && GodotObject.IsInstanceValid(node))
            {
                screens.Add(node);
            }
        }

        // The visibility gate, hoisted out of the per-screen loop. When NOTHING is visible, ScanScreen takes
        // the `!visible` arm for both panels regardless of the two state gates, so the outcome is identical
        // with or without the state pull — and the pull is the expensive half of this tick. A lobby screen
        // that is merely hidden (backed out to the menu, a submenu on top) therefore costs one
        // IsVisibleInTree per screen and nothing else.
        var anyVisible = false;
        foreach (var screen in screens)
        {
            if (IsVisibleInTree(screen))
            {
                anyVisible = true;
                break;
            }
        }

        if (!anyVisible)
        {
            foreach (var screen in screens)
            {
                RemoveFrom(screen);
            }

            DecideHostTransportAlert(null);
            return true;
        }

        // Only pull state once a lobby screen is actually on screen — the state read is the expensive half
        // of this tick, and on the main menu or mid-combat there is nothing to decide.
        var snapshot = CouchCoopMod.HostUiSnapshot;
        var lobbyState = CouchCoopMod.TryGetLobbyState();
        // Keep the QR entry point reachable when the browser listener failed. The dialog's empty state
        // names that failure; hiding the only host-facing explanation stranded controller users in the lobby.
        var shouldShow = CouchCoopLobbyHostGate.IsHostLobby(lobbyState);
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
        foreach (var screen in screens)
        {
            try
            {
                // Unconditional: `mounted ??= ScanScreen(...)` would short-circuit and skip installing on a
                // second visible lobby screen. Only the FIRST panel is remembered, as the alert's host.
                var panel = ScanScreen(screen, snapshot, shouldShow, refresh);
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
    /// One screen's half of <see cref="Scan"/>, isolated so a stale node cannot poison the whole tick.
    /// </summary>
    /// <returns>The QR panel mounted on this screen, or <see langword="null"/> if none is usable yet.</returns>
    private static CouchCoopQrHostPanel? ScanScreen(
        Node screen,
        CouchCoopHostUiSnapshot snapshot,
        bool shouldShow,
        bool refresh)
    {
        if (!GodotObject.IsInstanceValid(screen))
        {
            return null;
        }

        var visible = IsVisibleInTree(screen);
        CouchCoopQrHostPanel? mounted = null;

        // Isolate installation so a transient node failure cannot stop later refreshes.
        try
        {
            if (!shouldShow || !visible)
            {
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
    /// Runs the once-per-mount latch and pops the alert on the tick it says to.
    /// </summary>
    /// <param name="mounted">
    /// The visible host-lobby panel, or <see langword="null"/> for "no host lobby on screen" — which
    /// re-arms the latch, so backing out to the menu and coming back shows the alert again.
    /// </param>
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
        var panel = screen.GetNodeOrNull<CouchCoopQrHostPanel>(CouchCoopQrHostPanel.NodeName);
        if (panel is not null && !IsUsablePanel(panel))
        {
            return null;
        }

        if (panel is null)
        {
            panel = new CouchCoopQrHostPanel();
            // Stamp BEFORE AddChild: spirectl's scene watcher can observe the node the moment it enters
            // the tree, so a stamp applied afterwards races a keyframe and the button could reach a
            // phone — where tapping it would open this dialog on the host's TV.
            CouchCoopStreamSkip.Stamp(panel);
            screen.AddChild(panel);
            panel.Install();
            CouchCoopLog.Stderr($"qr host panel installed screen={screen.GetType().Name}");
        }
        else if (refreshLayout)
        {
            panel.ApplyLayout();
        }

        panel.Visible = true;
        panel.Apply(snapshot);
        return panel;
    }

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
