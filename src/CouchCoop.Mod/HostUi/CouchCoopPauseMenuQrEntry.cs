using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.addons.mega_text;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The pause menu's "Couch Co-Op QR Code" row, and the dialog it opens.
/// </summary>
/// <remarks>
/// <para>
/// WHY A SECOND ENTRY POINT AT ALL. <see cref="CouchCoopQrHostPanel"/> lives on the lobby screens and is gone the
/// moment the run embarks, so a device that joined and then lost its browser — a locked phone, a closed tab, a
/// dropped Wi-Fi — has no way back to the join URL without abandoning the run. The pause menu is the one screen
/// reachable from anywhere mid-run.
/// </para>
/// <para>
/// <b>The row is the GAME'S widget, not a CouchCoop restyle.</b> It is an instance of the game's own
/// <c>pause_menu_button.tscn</c>, so it carries that scene's texture, hsv shader, font, outline and the whole
/// hover/press/settle choreography for free — and, because the instance keeps the game's <c>CSharpScript</c>, the
/// engine dispatches its lifecycle normally. None of <see cref="CouchCoopTextureButton"/>'s no-script-dispatch
/// machinery applies here; that type exists because nodes constructed with <c>new</c> in THIS assembly get no
/// script instance, which is not what happens to an instanced game scene.
/// </para>
/// <para>
/// <b>It is inserted, never positioned.</b> The row is added to the menu's own <c>ButtonContainer</c>
/// (a <c>VBoxContainer</c>) and moved to <c>GiveUp</c>'s index; the container lays it out and the outer panel
/// column grows to fit, exactly as it does for the game's own rows. Nothing here sets an anchor, offset or
/// position on the row.
/// </para>
/// <para>
/// <b>Both injected nodes are stream-skipped.</b> A viewer who picked "watch the host" mirrors this very tree and
/// drives it with REAL injected input, so an unstamped row could be pressed from a phone onto the host's TV — the
/// same hazard <see cref="CouchCoopStreamSkip"/> exists for in the lobby. Stamped BEFORE <c>AddChild</c>, because
/// the scene watcher can observe a node the moment it enters the tree.
/// </para>
/// <para>
/// <b>Event-driven, with no timer of its own.</b> The gate is re-evaluated on the pause menu's
/// <c>visibility_changed</c> and nowhere else. The lobby's 0.25s chain exists because <c>netGameType</c> flips
/// live while a host sits in a lobby; a run's does not, so there is nothing here worth a tick — and the host's
/// idle cost is a product requirement (see <see cref="CouchCoopQrHostPanelController"/>).
/// </para>
/// <para>
/// <b>No <c>ReassertWhileOpen</c> heartbeat, deliberately.</b> <c>NPauseMenu.OnSubmenuOpened</c> calls
/// <c>AddBlockingScreen</c>, which pushes a swallow-everything binding for every action; this dialog's own
/// cancel/pauseAndBack push lands ON TOP of it, because the menu was already open long before the player could
/// reach the row. That is the difference the lobby round measured between a modal that opens by itself during a
/// screen's setup (out-ranked, needs re-asserting) and one the player opens afterwards (not).
/// </para>
/// </remarks>
internal sealed partial class CouchCoopPauseMenuQrEntry : Control
{
    /// <summary>The dialog host under the pause menu. Part of the QA node contract.</summary>
    public const string NodeName = "CouchCoopPauseMenuQrEntry";

    /// <summary>The injected row inside the menu's own button column. Part of the QA node contract.</summary>
    public const string ButtonNodeName = "CouchCoopPauseMenuQrButton";

    /// <summary>
    /// The game scene every pause-menu row is an instance of. A resource path the mod needs in order to address
    /// the game's content — the row cannot be built without it.
    /// </summary>
    internal const string ButtonScenePath = "res://scenes/pause_menu/pause_menu_button.tscn";

    /// <summary>The menu's button column, by its scene-unique name, and the plain path as a fallback.</summary>
    private const string ButtonContainerUniquePath = "%ButtonContainer";
    private const string ButtonContainerFallbackPath = "PanelContainer/ButtonContainer";

    /// <summary>The row this one goes ABOVE.</summary>
    private const string GiveUpNodeName = "GiveUp";

    private const string RowLabelNodeName = "Label";
    private const string RowImageNodeName = "ButtonImage";

    // The hsv values every row but GiveUp carries (GiveUp's h=0.5 is what makes it read red). The material is
    // resource_local_to_scene, so setting these touches this instance's own copy and no other row's.
    private const float RowHue = 1.0f;
    private const float RowSaturation = 1.0f;
    private const float RowValue = 1.0f;

    private static readonly object Gate = new();

    /// <summary>
    /// Every entry this process has mounted, so <see cref="Shutdown"/> can take them down again.
    /// </summary>
    /// <remarks>
    /// Instance ids rather than references: a pause menu freed with its run takes its entry with it, and holding
    /// a managed reference to a dead node is exactly the shape that made the lobby controller throw on every
    /// later tick. Ids are resolved through <c>InstanceFromId</c> and dropped when they no longer resolve.
    /// </remarks>
    private static readonly List<ulong> Mounted = [];

    private readonly CouchCoopQrDialog _dialog = new();
    private readonly Callable _visibilityChanged;
    private Control? _row;
    private Node? _pauseMenu;
    private bool _installed;
    private int _localeRevision = -1;

    public CouchCoopPauseMenuQrEntry()
    {
        Name = NodeName;
        SetAnchorsPreset(LayoutPreset.FullRect);
        // Ignore on the host: the pause menu underneath must stay fully clickable while only the row is showing.
        // The dialog's scrim does its own blocking once it is up.
        MouseFilter = MouseFilterEnum.Ignore;
        _visibilityChanged = Callable.From(OnPauseMenuVisibilityChanged);
        AddChild(_dialog);
    }

    /// <summary>The row's wording, shared with the lobby button so the two entry points cannot drift apart.</summary>
    public static string ButtonText => CouchCoopQrHostPanel.ButtonText;

    /// <summary>
    /// A pause menu has just been readied. Called from <see cref="Patches.PauseMenuMountPatch"/> on the game main
    /// thread, inside the game's own <c>_Ready</c> frame.
    /// </summary>
    /// <remarks>
    /// Total by construction, step by step: this runs as a Harmony postfix on a game lifecycle method, so an
    /// exception escaping here would surface as an engine error in the middle of building the player's pause
    /// menu. Every failure below logs and installs nothing instead.
    /// </remarks>
    public static void NotePauseMenuMounted(Node? pauseMenu)
    {
        if (pauseMenu is null || !GodotObject.IsInstanceValid(pauseMenu))
        {
            return;
        }

        CouchCoopPauseMenuQrEntry? entry = null;
        try
        {
            if (pauseMenu.GetNodeOrNull<CouchCoopPauseMenuQrEntry>(NodeName) is not null)
            {
                return; // already mounted — a re-ready must not build a second row
            }

            entry = new CouchCoopPauseMenuQrEntry();
            // Stamp BEFORE AddChild: spirectl's scene watcher can observe the node the moment it enters the
            // tree, so a stamp applied afterwards races a keyframe and the dialog could reach a phone.
            CouchCoopStreamSkip.Stamp(entry);
            pauseMenu.AddChild(entry);
            entry.Install(pauseMenu);

            lock (Gate)
            {
                // Prune as we go: one entry is mounted per RUN, and a pause menu freed with its run took its
                // entry with it, so the list would otherwise accumulate a dead id per run for the session.
                Mounted.RemoveAll(id => GodotObject.InstanceFromId(id) is not Node node
                    || !GodotObject.IsInstanceValid(node));
                Mounted.Add(entry.GetInstanceId());
            }

            CouchCoopLog.Stderr($"pause menu qr entry installed screen={pauseMenu.GetType().Name}");
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"pause menu qr entry install failed detail={exception.GetType().Name}: {exception.Message}");
            TryFree(entry);
        }
    }

    /// <summary>Free every mounted entry. Paired with <c>CouchCoopMod.Shutdown</c>.</summary>
    public static void Shutdown()
    {
        ulong[] ids;
        lock (Gate)
        {
            ids = [.. Mounted];
            Mounted.Clear();
        }

        foreach (var id in ids)
        {
            try
            {
                if (GodotObject.InstanceFromId(id) is CouchCoopPauseMenuQrEntry entry
                    && GodotObject.IsInstanceValid(entry))
                {
                    entry.Uninstall();
                    entry.QueueFree();
                }
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr(
                    $"pause menu qr entry teardown failed detail={exception.GetType().Name}: {exception.Message}");
            }
        }
    }

    /// <summary>
    /// Idempotent wiring, called by the mount callback after <c>AddChild</c> rather than relying on
    /// <c>_Ready</c> — see <see cref="CouchCoopTextureButton"/> for why engine dispatch into this assembly
    /// cannot be assumed for a node built with <c>new</c>.
    /// </summary>
    public void Install(Node pauseMenu)
    {
        ArgumentNullException.ThrowIfNull(pauseMenu);
        if (_installed)
        {
            return;
        }

        _installed = true;
        _pauseMenu = pauseMenu;
        _dialog.Install();

        _row = BuildRow();
        if (_row is not null)
        {
            InsertRow(pauseMenu, _row);
        }

        ConnectVisibility(pauseMenu);
        // The pause menu can be readied ALREADY VISIBLE (the stack instances it on demand), and a
        // visibility_changed would then never arrive for the state it is already in — so the gate still has
        // to answer once at mount. It must not answer HERE; see ScheduleFirstRefresh.
        ScheduleFirstRefresh();
    }

    /// <summary>
    /// Ask the gate for the first time one frame AFTER the mount, rather than inside it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// EVERYTHING ABOVE IS SAFE IN A <c>_Ready</c> FRAME AND THIS IS NOT. Instancing a scene, parenting it and
    /// connecting a signal ask the game nothing. <see cref="Refresh"/> reads
    /// <c>CouchCoopMod.TryGetLobbyState()</c>, which reflects into the running game while the screen that is
    /// readying is still being assembled. That is exactly the fault removed from
    /// <see cref="CouchCoopQrHostPanelController"/> — read its <c>WakeEvaluation</c> remarks: in this runtime
    /// the resulting null dereference is NOT a catchable <see cref="NullReferenceException"/>, because the
    /// signal-handler chain is broken. It takes the process down with a bare kernel segfault and no managed
    /// stack, and the <c>try</c> wrapped around the call does not fire. Deferring by a frame is the whole fix,
    /// and the pre-check that defeated it there must not be reinvented here.
    /// </para>
    /// <para>
    /// <c>processAlways: true</c> IS LOAD-BEARING, and it is the one place this timer differs from the lobby's:
    /// a pause menu exists precisely when the tree is paused, so a timer that honoured the pause would never
    /// fire and the row would stay hidden until the player closed and reopened the menu.
    /// </para>
    /// <para>
    /// Nothing is retained to cancel. The callback re-checks both nodes, so an entry (or a pause menu) freed
    /// inside that one frame simply finds itself invalid and does nothing — the same liveness discipline
    /// <see cref="Shutdown"/> uses, and for the same reason.
    /// </para>
    /// </remarks>
    private void ScheduleFirstRefresh()
    {
        try
        {
            if (GetTree() is not { } tree)
            {
                // Not in a tree, so there is no frame to defer to. The visibility signal is still connected,
                // and the menu cannot be shown to anyone without raising it.
                CouchCoopLog.Stderr("pause menu qr first refresh skipped: entry is not in a scene tree");
                return;
            }

            var timer = tree.CreateTimer(0.0, processAlways: true, ignoreTimeScale: true);
            timer.Timeout += () =>
            {
                if (!GodotObject.IsInstanceValid(this)
                    || _pauseMenu is null
                    || !GodotObject.IsInstanceValid(_pauseMenu))
                {
                    return;
                }

                Refresh();
            };
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"pause menu qr first refresh not scheduled detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    public override void _Ready()
    {
        if (!_installed && GetParent() is { } parent)
        {
            Install(parent);
        }
    }

    // ---- the row ----------------------------------------------------------------------------------

    /// <summary>
    /// Instance the game's own pause-menu row and dress it as ours.
    /// </summary>
    /// <returns>The row, or <see langword="null"/> when the game scene could not be instanced.</returns>
    /// <remarks>
    /// There is deliberately NO CouchCoop-styled stand-in on the failure path, unlike
    /// <see cref="CouchCoopTextureButton"/>'s fallback panel. Matching the menu's other rows exactly is the whole
    /// requirement here, a hand-drawn approximation wedged between them would look worse than an absence, and a
    /// pause menu whose own row scene will not load has larger problems than a missing QR shortcut.
    /// </remarks>
    private Control? BuildRow()
    {
        Control? row;
        try
        {
            if (ResourceLoader.Load<PackedScene>(ButtonScenePath) is not { } scene)
            {
                CouchCoopLog.Stderr($"pause menu qr row unavailable: {ButtonScenePath} did not load");
                return null;
            }

            row = scene.Instantiate<Control>();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"pause menu qr row instance failed detail={exception.GetType().Name}: {exception.Message}");
            return null;
        }

        row.Name = ButtonNodeName;
        // The base scene sets neither: the PARENT scene gives each of its own rows shrink-center sizing and
        // FOCUS_ALL, so a row instanced straight from the scene would stretch full width and be unfocusable.
        row.SizeFlagsHorizontal = SizeFlags.ShrinkCenter;
        row.FocusMode = FocusModeEnum.All;
        // FAILS CLOSED. The gate turns it on; anything that stops the gate running leaves the menu exactly as
        // the game shipped it, rather than offering a join URL for a session nothing can join.
        row.Visible = false;

        ApplyRowStyle(row);
        ApplyRowText(row);

        // Same stamp, same reason, as the entry root: this node does NOT live under the entry — it is parented
        // into the game's own container — so it needs its own.
        CouchCoopStreamSkip.Stamp(row);

        try
        {
            row.Connect(NClickableControl.SignalName.Released, Callable.From<NClickableControl>(OnRowReleased));
        }
        catch (Exception exception)
        {
            // A row that cannot be activated is worse than no row: it would sit in the menu doing nothing.
            CouchCoopLog.Stderr(
                $"pause menu qr row connect failed detail={exception.GetType().Name}: {exception.Message}");
            TryFree(row);
            return null;
        }

        return row;
    }

    /// <summary>
    /// Take the hsv treatment the menu's ordinary rows carry, and NOT GiveUp's.
    /// </summary>
    /// <remarks>
    /// The scene's own default (<c>s=0.8, v=0.9</c>) is the RESTING state every row settles to after a hover, so
    /// a freshly instanced row would sit a shade dimmer than its untouched neighbours until the first time the
    /// player moused over them. Settings, Compendium, Disconnect and Save-and-Quit all override to 1/1/1 in the
    /// parent scene; this matches them. GiveUp's <c>h=0.5</c> — the hue rotation that makes it read red — is
    /// deliberately not copied.
    /// </remarks>
    private static void ApplyRowStyle(Control row)
    {
        try
        {
            if (row.GetNodeOrNull<TextureRect>(RowImageNodeName)?.Material is ShaderMaterial hsv)
            {
                hsv.SetShaderParameter("h", RowHue);
                hsv.SetShaderParameter("s", RowSaturation);
                hsv.SetShaderParameter("v", RowValue);
            }
        }
        catch (Exception exception)
        {
            // Cosmetic only — the row still works, it just wears the scene's slightly dimmer resting shade.
            CouchCoopLog.Stderr(
                $"pause menu qr row style skipped detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// Set the row's wording through the game's own auto-sizing path.
    /// </summary>
    /// <remarks>
    /// <c>SetTextAutoSize</c>, not <c>Text</c>: assigning the property skips <c>AdjustFontSize</c>, and the
    /// longer translations of this string ("Codice QR di Couch Co-Op", "Código QR do Couch Co-Op")
    /// overflow the row's 372×80 plate at the scene's 32pt default. The game sets every other row's label the
    /// same way for the same reason.
    /// </remarks>
    private static void ApplyRowText(Control row)
    {
        var text = ButtonText;
        var label = row.GetNodeOrNull<Control>(RowLabelNodeName);
        switch (label)
        {
            case MegaLabel megaLabel:
                megaLabel.SetTextAutoSize(text);
                break;
            case Label plain:
                // A game build that swapped the script out: still legible, just not auto-fitted.
                plain.Text = text;
                break;
            default:
                CouchCoopLog.Stderr($"pause menu qr row has no {RowLabelNodeName} to write '{text}' into");
                break;
        }
    }

    /// <summary>
    /// Put the row in the menu's own button column, directly above <c>GiveUp</c>, and re-close the focus ring
    /// around it.
    /// </summary>
    private void InsertRow(Node pauseMenu, Control row)
    {
        var container = pauseMenu.GetNodeOrNull<Control>(ButtonContainerUniquePath)
            ?? pauseMenu.GetNodeOrNull<Control>(ButtonContainerFallbackPath);
        if (container is null)
        {
            CouchCoopLog.Stderr(
                $"pause menu qr row has nowhere to go: neither {ButtonContainerUniquePath} nor "
                + $"{ButtonContainerFallbackPath} resolved");
            TryFree(row);
            _row = null;
            return;
        }

        container.AddChild(row);

        if (container.GetNodeOrNull<Control>(GiveUpNodeName) is { } giveUp)
        {
            container.MoveChild(row, giveUp.GetIndex());
        }
        else
        {
            // A game update renamed or dropped the row we anchor to. Last in the column is still a sane place
            // for it, and a visible QR shortcut in the wrong slot beats no QR shortcut.
            CouchCoopLog.Stderr(
                $"pause menu qr row anchored last: no {GiveUpNodeName} row to sit above");
        }

        PinFocusRing(container, row);
    }

    /// <summary>
    /// Splice the row into the menu's vertical focus ring.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>NPauseMenu._Ready</c> rings its SIX known rows top-to-bottom and pins left/right to each row itself.
    /// That loop has already run by the time this postfix does, and it cannot see an injected row — so without
    /// this a controller would walk straight past it, which is the whole reason the lobby button needed a hotkey
    /// instead.
    /// </para>
    /// <para>
    /// Neighbours are read by INDEX and wrapped, not by name: that reproduces the game's own ring arithmetic
    /// without this file re-encoding which row sits where, so it still closes correctly if we landed last.
    /// Godot chain-follows a neighbour that is hidden or unfocusable, which is how the ring already survives
    /// GiveUp / Disconnect / SaveAndQuit being hidden per net-game type — and how it survives THIS row being
    /// hidden by the gate.
    /// </para>
    /// </remarks>
    private static void PinFocusRing(Control container, Control row)
    {
        try
        {
            var count = container.GetChildCount();
            if (count == 0)
            {
                return;
            }

            var index = row.GetIndex();
            var rowPath = row.GetPath();
            row.FocusNeighborLeft = rowPath;
            row.FocusNeighborRight = rowPath;

            if (container.GetChild(((index - 1) % count + count) % count) is Control previous)
            {
                row.FocusNeighborTop = previous.GetPath();
                previous.FocusNeighborBottom = rowPath;
            }

            if (container.GetChild((index + 1) % count) is Control next)
            {
                row.FocusNeighborBottom = next.GetPath();
                next.FocusNeighborTop = rowPath;
            }
        }
        catch (Exception exception)
        {
            // The row is still reachable with a mouse; only d-pad navigation is degraded.
            CouchCoopLog.Stderr(
                $"pause menu qr focus ring skipped detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    // ---- presence ---------------------------------------------------------------------------------

    private void ConnectVisibility(Node pauseMenu)
    {
        if (pauseMenu is not CanvasItem canvasItem)
        {
            return;
        }

        try
        {
            canvasItem.Connect(CanvasItem.SignalName.VisibilityChanged, _visibilityChanged);
        }
        catch (Exception exception)
        {
            // The gate then answers once, at mount. Worth logging: on a saved-run resume that is the difference
            // between the row appearing and not.
            CouchCoopLog.Stderr(
                $"pause menu qr visibility connect failed detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>Drop the visibility connection, so a torn-down entry cannot be called back into.</summary>
    private void Uninstall()
    {
        try
        {
            if (_pauseMenu is CanvasItem canvasItem && GodotObject.IsInstanceValid(canvasItem)
                && canvasItem.IsConnected(CanvasItem.SignalName.VisibilityChanged, _visibilityChanged))
            {
                canvasItem.Disconnect(CanvasItem.SignalName.VisibilityChanged, _visibilityChanged);
            }
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"pause menu qr visibility disconnect failed detail={exception.GetType().Name}: {exception.Message}");
        }

        TryFree(_row);
        _row = null;
        _pauseMenu = null;
    }

    private void OnPauseMenuVisibilityChanged()
    {
        try
        {
            Refresh();
        }
        catch (Exception exception)
        {
            // Raised from a native signal, outside any caller's try: a throw here would surface as an engine
            // error over the player's pause menu.
            CouchCoopLog.Stderr(
                $"pause menu qr refresh failed detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// One evaluation: is the row worth showing, is its wording current, and is the dialog still wanted?
    /// </summary>
    /// <remarks>
    /// The state pull is the expensive half and happens ONLY here — on a visibility change, a handful of times
    /// per run. There is no tick.
    /// </remarks>
    private void Refresh()
    {
        // IsVisibleInTree, not Visible: the signal also fires when an ANCESTOR hides (the whole capstone
        // container closing), which leaves the menu's own flag true while nothing is on screen.
        if (_pauseMenu is CanvasItem canvasItem && GodotObject.IsInstanceValid(canvasItem)
            && !canvasItem.IsVisibleInTree())
        {
            // The menu closed. NPauseMenu.OnSubmenuClosed only sets Visible = false, so a dialog left open would
            // keep its cancel binding pushed and focus parked on something nobody can see.
            _dialog.Close();
            return;
        }

        var snapshot = CouchCoopMod.HostUiSnapshot;
        if (_row is not null && GodotObject.IsInstanceValid(_row))
        {
            _row.Visible = CouchCoopPauseMenuGate.ShouldShow(
                snapshot.ListenerBaseUri,
                CouchCoopMod.TryGetLobbyState());
        }

        RefreshLocalization(snapshot);
    }

    private void RefreshLocalization(CouchCoopHostUiSnapshot snapshot)
    {
        var revision = CouchCoopLocalization.Revision;
        if (revision == _localeRevision)
        {
            return;
        }

        _localeRevision = revision;
        if (_row is not null && GodotObject.IsInstanceValid(_row))
        {
            ApplyRowText(_row);
        }

        _dialog.RefreshLocalization(snapshot);
    }

    // ---- activation -------------------------------------------------------------------------------

    private void OnRowReleased(NClickableControl _) => OpenDialog();

    /// <summary>
    /// Open the join dialog over the paused run.
    /// </summary>
    /// <remarks>
    /// The row is NOT hidden while the dialog is up, unlike the lobby's. There the button had to be hidden to
    /// unlatch its hover visual, because nothing else took focus off it; here <c>OpenModal</c> parks focus on
    /// the dialog, which drives the game row's own unfocus settle — and leaving the menu visible behind an
    /// 85%-opaque scrim is exactly what the game's own confirm popups do over this screen.
    /// </remarks>
    private void OpenDialog() => _dialog.Open(CouchCoopMod.HostUiSnapshot);

    private static void TryFree(Node? node)
    {
        try
        {
            if (node is not null && GodotObject.IsInstanceValid(node) && !node.IsQueuedForDeletion())
            {
                node.QueueFree();
            }
        }
        catch
        {
            // Teardown of an auxiliary node. The stderr line at the call site is the record.
        }
    }
}
