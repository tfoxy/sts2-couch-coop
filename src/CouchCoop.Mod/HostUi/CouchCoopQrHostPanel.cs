using Godot;
using CouchCoop.Mod.Localization;
using MegaCrit.Sts2.Core.ControllerInput;
using MegaCrit.Sts2.Core.Nodes.CommonUi;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The single node the mod injects into a lobby screen: a transparent full-rect host for the
/// "Couch Co-Op QR Code" button, the dialog it opens, and the host-transport alert.
/// </summary>
/// <remarks>
/// One root keeps the contract with the rest of the system simple — one node to stamp with
/// <see cref="CouchCoopStreamSkip"/>, one to find, one to <c>QueueFree</c>. The root itself is
/// <see cref="Control.MouseFilterEnum.Ignore"/>, so the lobby underneath stays fully clickable while
/// only the button is showing; the button and the dialogs' scrims do their own blocking.
/// <para>
/// Both modals live under this one stamped root for the same safety reason the button does: mirror
/// clients drive the host with real injected input, so a phone that can see a modal could dismiss it on
/// the host's TV.
/// </para>
/// <para>
/// <b>A controller can only reach the button through <see cref="HotkeyAction"/>.</b> The lobby's focus
/// ring is closed — the character-select screen pins every character button's top/bottom neighbour to
/// itself and rings left/right among those buttons alone, so no injected control can ever be focused —
/// and in controller mode the game warps the mouse off-screen, so hovering is not a fallback. The panel
/// therefore takes a hotkey for as long as it is mounted, exactly as <see cref="CouchCoopModalDialog"/>
/// takes Escape for as long as a modal is up, and <see cref="CouchCoopQrHotkeyHint"/> draws the glyph so
/// the binding is discoverable rather than folklore.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopQrHostPanel : Control
{
    public const string NodeName = "CouchCoopQrHostPanel";

    /// <summary>
    /// The action that opens the QR dialog from a controller.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The hotkey manager dispatches to the LAST-pushed binding for an action and marks the event handled,
    /// so an action already in use by a lobby screen would be SHADOWED for as long as this panel is
    /// mounted — which is why <c>CouchCoopTextureButton.Hotkeys</c> is deliberately empty and why this one
    /// binding is chosen rather than assumed. Nothing reachable on either lobby screen
    /// (<c>NCharacterSelectScreen</c>, <c>NMultiplayerLoadGameScreen</c>, and the panels and buttons they
    /// mount) binds <c>topPanel</c>: between them they take <c>cancel</c>/<c>pauseAndBack</c>/<c>back</c>
    /// (their back and unready buttons), <c>select</c> and <c>accept</c> (embark/confirm),
    /// <c>viewDeckAndTabLeft</c> and <c>viewExhaustPileAndTabRight</c> (the ascension panel's arrows), and
    /// <c>viewMap</c> (the invite-players button inside the remote-player container).
    /// </para>
    /// <para>
    /// <c>topPanel</c> also has no default keyboard key and is not in the game's remappable-KEYBOARD list —
    /// it is controller-only by construction. So this binding cannot swallow a key from a
    /// mouse-and-keyboard host, who reaches the button by clicking it as before. On a controller it is the
    /// west face button (X on an Xbox pad and on a Steam Deck), and every controller config ships a glyph
    /// for it.
    /// </para>
    /// </remarks>
    public static readonly string HotkeyAction = MegaInput.topPanel;

    private readonly CouchCoopEventButton _button;
    private readonly CouchCoopQrHotkeyHint _hint = new(HotkeyAction);
    private readonly CouchCoopQrDialog _dialog = new();
    private readonly CouchCoopHostTransportAlertDialog _alert = new();
    private readonly Action _openAction;
    private HostLobbyQrOverlayLayout _layout = HostLobbyQrOverlayLayout.Default;
    private CouchCoopHostUiSnapshot _snapshot = CouchCoopHostUiSnapshot.Unavailable([]);
    private bool _installed;
    private bool _hotkeyBound;
    private int _localeRevision = -1;

    public CouchCoopQrHostPanel()
    {
        Name = NodeName;
        SetAnchorsPreset(LayoutPreset.FullRect);
        MouseFilter = MouseFilterEnum.Ignore;
        _openAction = OpenDialogFromHotkey;

        _button = new CouchCoopEventButton(_layout.ButtonFontSize)
        {
            Text = ButtonText,
            Activated = OpenDialog,
        };

        _dialog.Closed = () => _button.Visible = true;
        _alert.Closed = () => _button.Visible = true;

        // Under the BUTTON, not the panel: the hint anchors to the button's bottom edge, so it follows the
        // hot-reloadable button rect for free and disappears with it while a modal is up.
        _button.AddChild(_hint);
        AddChild(_button);
        AddChild(_dialog);
        // Added last so the alert draws over the QR dialog if the two are ever up together. They cannot
        // be in practice — the alert fires once, on mount, before the button is reachable.
        AddChild(_alert);
    }

    /// <summary>Wording is part of the QA contract; the probe reads this label.</summary>
    public static string ButtonText => CouchCoopLocalization.Resolve("couchcoop_qr_button");

    /// <summary>
    /// Idempotent wiring, called by the controller after <c>AddChild</c> rather than relying on
    /// <c>_Ready</c> — see <see cref="CouchCoopTextureButton"/> for why engine dispatch into this
    /// assembly cannot be assumed.
    /// </summary>
    public void Install()
    {
        if (_installed)
        {
            return;
        }

        _installed = true;
        _button.Install();
        _hint.Install();
        _dialog.Install();
        _alert.Install();
        BindHotkey();
        ApplyLayout();
    }

    public override void _Ready() => Install();

    /// <summary>Re-reads the hot-reloadable layout. Called on install and on an explicit refresh only.</summary>
    public void ApplyLayout()
    {
        _layout = HostLobbyQrOverlayLayoutProvider.Current();

        _button.AnchorLeft = _layout.AnchorLeft;
        _button.AnchorTop = _layout.AnchorTop;
        _button.AnchorRight = _layout.AnchorRight;
        _button.AnchorBottom = _layout.AnchorBottom;
        _button.OffsetLeft = _layout.OffsetLeft;
        _button.OffsetTop = _layout.OffsetTop;
        _button.OffsetRight = _layout.OffsetRight;
        _button.OffsetBottom = _layout.OffsetBottom;
        _button.CustomMinimumSize = _layout.ButtonSize;
        _button.ApplyFontSize(_layout.ButtonFontSize);

        _dialog.ApplyLayout();
        _alert.ApplyLayout();
        RefreshLocalization(force: true);
    }

    /// <summary>
    /// Per-scan refresh. Deliberately cheap: it only records the snapshot the dialog will use when it
    /// is next opened. The layout is NOT re-read here — that walks the hot-reload protocol by
    /// reflection and deserialises JSON, which has no business running four times a second.
    /// </summary>
    public void Apply(CouchCoopHostUiSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        _snapshot = snapshot;
        RefreshLocalization();
    }

    public void RefreshLocalization(bool force = false)
    {
        var revision = CouchCoopLocalization.Revision;
        if (!force && revision == _localeRevision)
        {
            return;
        }

        _localeRevision = revision;
        _button.Text = ButtonText;
        _button.ApplyFontSize(_layout.ButtonFontSize);
        _hint.RefreshLocalization();
        _dialog.RefreshLocalization(_snapshot);
        _alert.RefreshLocalization();
    }

    // ---- controller hotkey ------------------------------------------------------------------------

    /// <summary>
    /// Take <see cref="HotkeyAction"/> for as long as this panel is mounted.
    /// </summary>
    /// <remarks>
    /// Bound on install and released from the NATIVE <c>tree_exiting</c> signal, because the controller
    /// uninstalls a panel by <c>QueueFree</c> and this assembly cannot rely on <c>_ExitTree</c> being
    /// dispatched into it. Releasing matters: the binding list holds the delegate, so a panel that never
    /// unbound would leave a handler on a freed node behind on the game's hotkey manager for the rest of
    /// the process — and the panel is rebuilt on every trip through the lobby. Best-effort, like the
    /// modal's Escape: failing to bind must not stop the panel appearing, since the mouse path is intact.
    /// </remarks>
    private void BindHotkey()
    {
        if (_hotkeyBound)
        {
            return;
        }

        try
        {
            Connect(Node.SignalName.TreeExiting, Callable.From(UnbindHotkey));
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] qr hotkey exit hook failed detail={exception.GetType().Name}: {exception.Message}");
            return;
        }

        try
        {
            NHotkeyManager.Instance?.PushHotkeyPressedBinding(HotkeyAction, _openAction);
            _hotkeyBound = NHotkeyManager.Instance is not null;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] qr hotkey bind failed detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    private void UnbindHotkey()
    {
        if (!_hotkeyBound)
        {
            return;
        }

        _hotkeyBound = false;
        try
        {
            NHotkeyManager.Instance?.RemoveHotkeyPressedBinding(HotkeyAction, _openAction);
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] qr hotkey unbind failed detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// The hotkey's half of <see cref="OpenDialog"/>.
    /// </summary>
    /// <remarks>
    /// Gated on both modals being down and the button being reachable. The hotkey manager defers its
    /// dispatch by a frame, so a press that landed while a dialog was already opening would otherwise
    /// re-enter <c>Open</c>; and a press while the transport alert is up must not put a second dialog
    /// behind it. The alert's own dismiss button and the modal's Escape stay the way back.
    /// </remarks>
    private void OpenDialogFromHotkey()
    {
        try
        {
            if (!GodotObject.IsInstanceValid(this) || !IsVisibleInTree() || _dialog.IsOpen || _alert.IsOpen)
            {
                return;
            }

            OpenDialog();
        }
        catch (Exception exception)
        {
            // The hotkey manager invokes this from a deferred Callable, outside any of our own try/catch:
            // a throw here would surface as an engine error on the host's screen, so swallow and log.
            Console.Error.WriteLine(
                $"[couch-coop] qr hotkey open failed detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// Opens the dialog and HIDES the button for as long as it is up.
    /// </summary>
    /// <remarks>
    /// Hiding is what unlatches the button's hover state, not just tidiness. <c>NClickableControl</c>
    /// keeps <c>_isHovered</c> until a <c>mouse_exited</c> arrives, and Godot only re-evaluates which
    /// control is hovered on mouse MOTION — so the dialog's scrim covering the button emits nothing,
    /// the button stays "focused", and it is still wearing its hover visual when the dialog closes
    /// under a stationary cursor. Hiding it drives the base's own <c>OnVisibilityChanged</c> →
    /// unfocus path (and makes Godot drop the mouse-over, clearing <c>_isHovered</c> for real), so the
    /// button comes back idle like every other button in the lobby. It is behind an 85%-opaque scrim
    /// meanwhile, so nothing visibly disappears.
    /// </remarks>
    private void OpenDialog()
    {
        // Open first, hide second: if Open() ever throws, the lobby keeps its button rather than
        // losing it to a half-applied state.
        _dialog.Open(_snapshot);
        _button.Visible = false;
    }

    /// <summary>
    /// Pop the host-transport alert carrying <paramref name="note"/>. Driven by
    /// <see cref="HostTransportAlert"/> from the controller's scan, which owns the once-per-mount latch;
    /// this method just renders and is safe to call again (a second call while it is up is a no-op).
    /// </summary>
    public void ShowHostTransportAlert(CouchCoopText note)
    {
        if (_alert.IsOpen || _dialog.IsOpen)
        {
            return;
        }

        // Same order and same reasoning as OpenDialog: open first, then hide the button so a throw
        // cannot strand the lobby without it.
        _alert.Open(note);
        if (_alert.IsOpen)
        {
            _button.Visible = false;
        }
    }
}
