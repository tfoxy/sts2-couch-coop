using Godot;
using MegaCrit.Sts2.Core.ControllerInput;
using MegaCrit.Sts2.Core.Nodes.CommonUi;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The node names one modal answers to. Every modal has the same four structural nodes; only the
/// strings differ, so a QA probe can address each dialog without the dialogs sharing a name.
/// </summary>
/// <remarks>
/// Names are a PARAMETER rather than derived from the type because the QR dialog's four
/// (<c>CouchCoopQrDialog</c> / <c>…Scrim</c> / <c>…Panel</c> / <c>CouchCoopQrCloseButton</c>) are a
/// published contract that <c>scripts/probe-lib-lobby-qr.mjs</c> and the architecture map both assert.
/// Extracting the shared chrome must not rename them.
/// </remarks>
internal readonly record struct CouchCoopModalNames(string Root, string Scrim, string Card, string Dismiss);

/// <summary>
/// The mod's shared modal: a click-blocking scrim, a centred card in the browser client's panel
/// language, one dismiss button, Escape-to-close, and focus parking. Subclasses supply the BODY and the
/// button's wording; everything else is fixed.
/// </summary>
/// <remarks>
/// <para>
/// <b>Own scrim, not <c>NModalContainer</c>.</b> The game's modal host hard-casts its caller to
/// <c>IScreenContext</c>, which an injected <c>Control</c> is not, so it is unusable from a mod. The
/// scrim below does the same job: it is the topmost full-rect <c>Stop</c> control, so it consumes every
/// click that is not on a dialog element — which both blocks the lobby underneath and gives the
/// click-outside-to-close behaviour for free.
/// </para>
/// <para>
/// <b><c>_Ready</c> is not trusted.</b> This assembly is built without Godot's C# source generators, so
/// the engine may never dispatch into these types (see <see cref="CouchCoopTextureButton"/>'s remarks).
/// Wiring therefore goes through an idempotent <see cref="Install"/> the owner calls after
/// <c>AddChild</c>, and every input path is a native signal <c>Callable</c> rather than a virtual.
/// </para>
/// <para>
/// <b>The card is not a close surface.</b> Only the scrim and the dismiss button close a modal. A player
/// lining a phone up over a QR will graze the card, and losing the dialog to that is maddening.
/// </para>
/// </remarks>
internal abstract partial class CouchCoopModalDialog : Control
{
    /// <summary>Gap between the dismiss button and the card's padded bottom edge.</summary>
    private const float DismissBottomInset = 16f;

    private readonly ColorRect _scrim;
    private readonly Panel _card;
    private readonly StyleBoxFlat _cardStyle = new();
    private readonly CouchCoopSkipButton _dismiss;
    private readonly Action _closeAction;
    private readonly Vector2 _cardSize;
    private readonly Vector2 _dismissSize;

    private HostLobbyQrOverlayLayout _layout = HostLobbyQrOverlayLayout.Default;
    private Control? _restoreFocus;
    private bool _escapeBound;
    private bool _installed;

    /// <summary>Raised after the dialog hides, so the owning panel can restore its own state.</summary>
    public Action? Closed { get; set; }

    public bool IsOpen => Visible;

    /// <param name="names">The published node names for this particular modal.</param>
    /// <param name="cardSize">Card geometry in the game's 1920x1080 design space.</param>
    /// <param name="dismissSize">
    /// Dismiss button size. Passed in rather than fixed at <see cref="CouchCoopSkipButton.DesignSize"/>
    /// so an alert whose only affordance IS the button can make it bigger than a QR dialog's tucked-away
    /// close button.
    /// </param>
    /// <param name="dismissFontSize">Label size for the dismiss button, matched to its box.</param>
    protected CouchCoopModalDialog(
        CouchCoopModalNames names,
        Vector2 cardSize,
        Vector2? dismissSize = null,
        int dismissFontSize = CouchCoopSkipButton.DesignFontSize)
    {
        _cardSize = cardSize;
        _dismissSize = dismissSize ?? CouchCoopSkipButton.DesignSize;
        _closeAction = Close;

        Name = names.Root;
        Visible = false;
        SetAnchorsPreset(LayoutPreset.FullRect);
        // Ignore on the root: the scrim child is the thing that blocks, and a Stop root would also
        // swallow input while the dialog is HIDDEN (Godot hit-tests hidden nodes' filters not at all,
        // but keeping the root inert makes the intent unambiguous).
        MouseFilter = MouseFilterEnum.Ignore;

        _scrim = new ColorRect { Name = names.Scrim };
        _scrim.SetAnchorsPreset(LayoutPreset.FullRect);
        _scrim.MouseFilter = MouseFilterEnum.Stop;
        _scrim.Color = new Color(0f, 0f, 0f, 0.85f);

        _card = new Panel { Name = names.Card };
        _card.AnchorLeft = 0.5f;
        _card.AnchorRight = 0.5f;
        _card.AnchorTop = 0.5f;
        _card.AnchorBottom = 0.5f;
        _card.OffsetLeft = -_cardSize.X / 2f;
        _card.OffsetRight = _cardSize.X / 2f;
        _card.OffsetTop = -_cardSize.Y / 2f;
        _card.OffsetBottom = _cardSize.Y / 2f;
        _card.MouseFilter = MouseFilterEnum.Stop;
        // Focusable so Open() can park keyboard focus here (off the lobby, off the buttons) without
        // lighting anything up — a Panel draws no focus visual.
        _card.FocusMode = FocusModeEnum.All;
        _cardStyle.AntiAliasing = true;
        _card.AddThemeStyleboxOverride("panel", _cardStyle);

        _dismiss = new CouchCoopSkipButton(dismissFontSize, names.Dismiss) { Activated = Close };

        AddChild(_scrim);
        AddChild(_card);
        // First child of the card, so anything a subclass adds draws ABOVE it — which is what keeps the
        // QR dialog's expanded host list on top of the close button, as it was before the extraction.
        _card.AddChild(_dismiss);
    }

    protected Panel Card => _card;
    protected CouchCoopSkipButton DismissButton => _dismiss;
    protected HostLobbyQrOverlayLayout Layout => _layout;
    protected float CardWidth => _cardSize.X;
    protected float CardHeight => _cardSize.Y;

    /// <summary>Text on the dismiss button. Wording is part of each dialog's QA contract.</summary>
    protected string DismissText
    {
        get => _dismiss.Text;
        set => _dismiss.Text = value;
    }

    /// <summary>Idempotent wiring, called by the owner after <c>AddChild</c>.</summary>
    public void Install()
    {
        if (_installed)
        {
            return;
        }

        _installed = true;

        InstallBody();
        _dismiss.Install();
        // Background clicks. Both are Stop controls, so anything that is NOT a dialog element lands on
        // one of them; the elements consume their own clicks first.
        _scrim.Connect(Control.SignalName.GuiInput, Callable.From<InputEvent>(OnScrimInput));
        _card.Connect(Control.SignalName.GuiInput, Callable.From<InputEvent>(OnCardInput));
        ApplyLayout();
    }

    /// <summary>Re-reads the hot-reloadable layout and re-runs geometry.</summary>
    public void ApplyLayout()
    {
        var previous = _layout;
        _layout = HostLobbyQrOverlayLayoutProvider.Current();

        _cardStyle.BgColor = _layout.ResolvedPanelColor;
        _cardStyle.BorderColor = _layout.ResolvedPanelBorderColor;
        _cardStyle.SetBorderWidthAll(_layout.ResolvedPanelBorderWidth);
        _cardStyle.SetCornerRadiusAll(_layout.ResolvedPanelCornerRadius);

        ApplyBodyLayout(previous, _layout);
        LayoutContent();
    }

    protected void RefreshDialogFont() => _dismiss.RefreshLocalization();

    /// <summary>Show the modal, parking focus and taking Escape for as long as it is up.</summary>
    protected void OpenModal()
    {
        Visible = true;
        _restoreFocus = GetViewport()?.GuiGetFocusOwner();
        // Park keyboard focus on the CARD, not on a button: focus must leave the lobby control behind
        // the scrim (or ui_accept would activate it through the dialog), but a button that opens already
        // lit in its focus state reads as pre-selected. A Panel draws no focus visual, and arrow keys
        // still walk from it to the body controls and the dismiss button.
        _card.GrabFocus();
        BindEscape();
    }

    public void Close()
    {
        if (!Visible)
        {
            return;
        }

        OnClosing();
        Visible = false;
        UnbindEscape();

        if (_restoreFocus is { } previous && GodotObject.IsInstanceValid(previous))
        {
            previous.GrabFocus();
        }

        _restoreFocus = null;
        Closed?.Invoke();
    }

    // ---- subclass seams -------------------------------------------------------------------------

    /// <summary>Install the body's own controls. Called once, before the shared wiring.</summary>
    protected virtual void InstallBody()
    {
    }

    /// <summary>
    /// Apply the hot-reloadable layout to the body (font sizes, cache invalidation).
    /// </summary>
    /// <param name="previous">The layout in force before this refresh, for change detection.</param>
    /// <param name="next">The layout now in force; also available as <see cref="Layout"/>.</param>
    protected virtual void ApplyBodyLayout(HostLobbyQrOverlayLayout previous, HostLobbyQrOverlayLayout next)
    {
    }

    /// <summary>
    /// Place the body's controls. <paramref name="padding"/> is the card's content inset and
    /// <paramref name="textWidth"/> the column it leaves, so the one layout knob still means "how much
    /// air inside the card".
    /// </summary>
    protected virtual void LayoutBody(float padding, float textWidth)
    {
    }

    /// <summary>
    /// A left press landed on the scrim. Return <see langword="true"/> to swallow it instead of closing —
    /// the QR dialog uses this to collapse its open option list first.
    /// </summary>
    protected virtual bool OnScrimPressed() => false;

    /// <summary>A left press landed on the card background. Never closes; may dismiss a nearer layer.</summary>
    protected virtual void OnCardPressed()
    {
    }

    /// <summary>Runs just before the modal hides, while it is still visible.</summary>
    protected virtual void OnClosing()
    {
    }

    /// <summary>Re-runs geometry after the body changed something that moves other rows.</summary>
    protected void LayoutContent()
    {
        var padding = _layout.ResolvedPanelPadding;
        var textWidth = MathF.Max(_cardSize.X - (padding * 2f), 1f);

        LayoutBody(padding, textWidth);

        _dismiss.Position = new Vector2(
            (_cardSize.X - _dismissSize.X) / 2f,
            _cardSize.Y - padding - _dismissSize.Y - DismissBottomInset);
        _dismiss.Size = _dismissSize;
    }

    /// <summary>The mod's shared label styling: centred game font, dropdown shadow, no mouse.</summary>
    protected static void ConfigureLabel(Label label, HorizontalAlignment alignment, Color color)
    {
        label.SetAnchorsPreset(LayoutPreset.TopLeft);
        label.MouseFilter = MouseFilterEnum.Ignore;
        label.HorizontalAlignment = alignment;
        label.VerticalAlignment = VerticalAlignment.Center;
        label.AutowrapMode = TextServer.AutowrapMode.WordSmart;
        CouchCoopGameUiTheme.ApplyFont(label, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, 24);
        label.AddThemeColorOverride("font_color", color);
        label.AddThemeColorOverride("font_shadow_color", CouchCoopGameUiTheme.DropdownShadowColor);
        label.AddThemeConstantOverride("shadow_offset_x", CouchCoopGameUiTheme.DropdownShadowOffsetX);
        label.AddThemeConstantOverride("shadow_offset_y", CouchCoopGameUiTheme.DropdownShadowOffsetY);
    }

    // ---- input ----------------------------------------------------------------------------------

    private void OnScrimInput(InputEvent inputEvent)
    {
        if (!IsLeftPress(inputEvent) || OnScrimPressed())
        {
            return;
        }

        Close();
    }

    private void OnCardInput(InputEvent inputEvent)
    {
        if (IsLeftPress(inputEvent))
        {
            OnCardPressed();
        }
    }

    private static bool IsLeftPress(InputEvent inputEvent)
        => inputEvent is InputEventMouseButton { ButtonIndex: MouseButton.Left, Pressed: true };

    // Escape/cancel. The hotkey manager dispatches to the LAST-pushed binding for an action, so pushing
    // on open makes this win over the lobby's own back handler for exactly as long as the dialog is up;
    // removing on close hands it straight back. Instance is nullable (it hangs off NGame), and the whole
    // thing is best-effort: failing to bind Escape must not stop the dialog from opening, since the
    // dismiss button and the click-outside path both still work.
    private void BindEscape()
    {
        if (_escapeBound)
        {
            return;
        }

        try
        {
            NHotkeyManager.Instance?.PushHotkeyPressedBinding(MegaInput.cancel, _closeAction);
            _escapeBound = NHotkeyManager.Instance is not null;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"[couch-coop] modal escape bind failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    private void UnbindEscape()
    {
        if (!_escapeBound)
        {
            return;
        }

        _escapeBound = false;
        try
        {
            NHotkeyManager.Instance?.RemoveHotkeyPressedBinding(MegaInput.cancel, _closeAction);
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"[couch-coop] modal escape unbind failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
        }
    }
}
