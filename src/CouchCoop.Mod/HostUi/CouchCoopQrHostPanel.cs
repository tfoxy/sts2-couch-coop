using Godot;
using CouchCoop.Mod.Localization;

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
/// </remarks>
internal sealed partial class CouchCoopQrHostPanel : Control
{
    public const string NodeName = "CouchCoopQrHostPanel";

    private readonly CouchCoopEventButton _button;
    private readonly CouchCoopQrDialog _dialog = new();
    private readonly CouchCoopHostTransportAlertDialog _alert = new();
    private HostLobbyQrOverlayLayout _layout = HostLobbyQrOverlayLayout.Default;
    private CouchCoopHostUiSnapshot _snapshot = CouchCoopHostUiSnapshot.Unavailable([]);
    private bool _installed;
    private int _localeRevision = -1;

    public CouchCoopQrHostPanel()
    {
        Name = NodeName;
        SetAnchorsPreset(LayoutPreset.FullRect);
        MouseFilter = MouseFilterEnum.Ignore;

        _button = new CouchCoopEventButton(_layout.ButtonFontSize)
        {
            Text = ButtonText,
            Activated = OpenDialog,
        };

        _dialog.Closed = () => _button.Visible = true;
        _alert.Closed = () => _button.Visible = true;

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
        _dialog.Install();
        _alert.Install();
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
        _dialog.RefreshLocalization(_snapshot);
        _alert.RefreshLocalization();
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
