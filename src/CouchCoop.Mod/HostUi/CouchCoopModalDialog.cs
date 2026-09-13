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
/// language, one dismiss button, cancel-to-close, and focus parking. Subclasses supply the BODY and the
/// button's wording; everything else is fixed.
/// </summary>
/// <remarks>
/// <para>
/// <b>A controller must be able to get out of it.</b> Three things together are what make that true, and
/// the Steam Deck leg measured each of them failing: focus parks on the dismiss button while a controller
/// is in use (<see cref="CouchCoopModalFocusParking"/>) so the select action has something to activate;
/// directional focus runs a closed vertical chain inside the dialog (<see cref="PinFocusChain"/>) so it
/// cannot escape onto a lobby control behind the scrim; and the cancel binding is re-taken while the modal
/// is up (<see cref="ReassertCancelBinding"/>) so B closes the dialog rather than leaving the lobby.
/// </para>
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
    private readonly Callable _inputModeChanged;
    private readonly Vector2 _cardSize;
    private readonly Vector2 _dismissSize;

    // The focus chain, and the scratch list the body declares into. Fields rather than locals because the
    // chain is rebuilt on every list expand/collapse and option rebuild, and because ApplyFocusTarget has
    // to be able to find the chain HEAD after the fact.
    private readonly List<Control> _declared = [];
    private readonly List<Control> _chain = [];

    private HostLobbyQrOverlayLayout _layout = HostLobbyQrOverlayLayout.Default;
    private Control? _restoreFocus;
    private bool _cancelBound;
    private bool _inputModeWired;
    private bool _installed;
    private bool _closing;

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
        _inputModeChanged = Callable.From(OnInputModeChanged);

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
        // lighting anything up — a Panel draws no focus visual. That is the MOUSE parking spot only; a
        // controller gets the dismiss button instead (see CouchCoopModalFocusParking).
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
        PinFocusChain();
        WireInputMode();
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

    /// <summary>Show the modal, parking focus and taking cancel for as long as it is up.</summary>
    protected void OpenModal()
    {
        Visible = true;
        _restoreFocus = GetViewport()?.GuiGetFocusOwner();
        // Focus must leave the lobby control behind the scrim, or the select action would activate it
        // straight through the dialog. WHERE it lands depends on the input the host is actually using —
        // see CouchCoopModalFocusParking for both halves of that rule.
        ApplyFocusTarget(CouchCoopModalFocusParking.OnOpen(IsUsingController()));
        BindCancel();
    }

    public void Close()
    {
        // The hotkey manager invokes its binding through a DEFERRED Callable, so a cancel pressed on the
        // frame the lobby tore this panel down arrives after the node is gone. The tree_exiting teardown
        // drops the binding, but a dispatch already in flight cannot be recalled.
        if (!GodotObject.IsInstanceValid(this) || !Visible)
        {
            return;
        }

        // OnClosing tears the body down, and a body that collapses a list from there raises a focus-chain
        // change — which must not grab focus for a dialog that is on its way out, or it would fight the
        // restore below.
        _closing = true;
        try
        {
            OnClosing();
        }
        finally
        {
            _closing = false;
        }

        Visible = false;
        UnbindCancel();

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

    // ---- focus ------------------------------------------------------------------------------------

    /// <summary>
    /// Declare the body controls that take part in the focus chain, in top-to-bottom order. The dismiss
    /// button is appended by the caller and is always last; a dialog that declares nothing gets exactly
    /// the single self-pinned button it had before chains existed.
    /// </summary>
    /// <remarks>
    /// Only controls that can hold focus RIGHT NOW belong here — a body whose rows are hidden must not
    /// declare them, because a chain that walks onto a hidden control is a dead end.
    /// </remarks>
    protected virtual void CollectFocusChain(List<Control> chain)
    {
    }

    /// <summary>
    /// Re-pin the chain after the body changed its shape, and give a controller somewhere to stand if the
    /// change left the dialog with no focus owner.
    /// </summary>
    /// <remarks>
    /// Driven by the body — the QR dialog calls this from its option list's expand, collapse and rebuild
    /// — rather than from a timer, so the pinned neighbours can never describe a set of rows that no
    /// longer exists. It is cheap and idempotent by design: re-pinning an unchanged chain writes the same
    /// six paths back onto the same controls.
    /// </remarks>
    protected void RefreshFocusChain()
    {
        if (!_installed)
        {
            // Install() pins once at the end of its own wiring; a body that reports a change while it is
            // still being built would only be pinned against a half-built tree.
            return;
        }

        PinFocusChain();

        if (!Visible || _closing)
        {
            return;
        }

        ApplyFocusTarget(CouchCoopModalFocusParking.OnChainChanged(IsUsingController(), CurrentFocus()));
    }

    /// <summary>
    /// Keeps directional focus INSIDE the dialog: every participating control's up and down walk to its
    /// neighbours in the chain, the ends wrap, and left/right pin to the control itself.
    /// </summary>
    /// <remarks>
    /// Without this, Godot's geometric neighbour search runs against every focusable control in the
    /// viewport and happily hands focus to a LOBBY control behind the scrim — which the select action
    /// would then activate through the dialog. Pinning a neighbour to the control itself is the game's
    /// own idiom (the character-select ring pins each button's top/bottom to itself), and a one-control
    /// chain reduces to exactly that.
    /// <para>
    /// The chain is VERTICAL: up and down walk it, left and right stay put. The QR dialog's rows are a
    /// column, and leaving left/right unpinned would reopen the escape this whole ring exists to close.
    /// </para>
    /// </remarks>
    private void PinFocusChain()
    {
        try
        {
            BuildChain();

            var self = new NodePath(".");
            var head = _chain[0];
            var toHead = _card.GetPathTo(head);
            _card.FocusNeighborTop = toHead;
            _card.FocusNeighborBottom = toHead;
            _card.FocusNeighborLeft = toHead;
            _card.FocusNeighborRight = toHead;
            _card.FocusNext = toHead;
            _card.FocusPrevious = toHead;

            for (var index = 0; index < _chain.Count; index++)
            {
                var control = _chain[index];
                var link = CouchCoopModalFocusChain.Neighbors(index, _chain.Count);
                var up = PathBetween(control, _chain[link.Previous]);
                var down = PathBetween(control, _chain[link.Next]);

                control.FocusNeighborTop = up;
                control.FocusPrevious = up;
                control.FocusNeighborBottom = down;
                control.FocusNext = down;
                control.FocusNeighborLeft = self;
                control.FocusNeighborRight = self;
            }
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] modal focus ring failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// Rebuild <see cref="_chain"/> from what the body declares now, dropping anything that cannot hold
    /// focus. The dismiss button is always last and always kept.
    /// </summary>
    private void BuildChain()
    {
        _declared.Clear();
        CollectFocusChain(_declared);
        _declared.Add(_dismiss);

        var eligibility = new bool[_declared.Count];
        for (var index = 0; index < _declared.Count; index++)
        {
            eligibility[index] = IsChainEligible(_declared[index]);
        }

        _chain.Clear();
        foreach (var index in CouchCoopModalFocusChain.Participants(eligibility))
        {
            _chain.Add(_declared[index]);
        }
    }

    // A freed row, one already queued for deletion, or one the body greyed out (FocusMode None) cannot
    // hold focus, and a chain that walks onto it is a dead end. Visibility is the DECLARER's business:
    // the body knows whether its list is expanded, and this runs during Install() when nothing is in the
    // tree yet.
    private static bool IsChainEligible(Control control)
        => GodotObject.IsInstanceValid(control)
            && !control.IsQueuedForDeletion()
            && control.FocusMode != FocusModeEnum.None;

    private static NodePath PathBetween(Control from, Control to)
        => ReferenceEquals(from, to) ? new NodePath(".") : from.GetPathTo(to);

    /// <summary>
    /// Where engine focus sits, as far as this dialog is concerned. Anything that cannot be read counts
    /// as "outside", which is the conservative answer: it re-grabs onto the dismiss button, the behaviour
    /// this had before there was a chain at all.
    /// </summary>
    private CouchCoopModalFocusParking.FocusState CurrentFocus()
    {
        try
        {
            var owner = GetViewport()?.GuiGetFocusOwner();
            if (owner is null || !GodotObject.IsInstanceValid(owner))
            {
                return new CouchCoopModalFocusParking.FocusState(false, false);
            }

            // IsAncestorOf, not a chain lookup: the body's rows and anything a subclass adds later are
            // all under this node, so the predicate cannot go stale when the chain changes.
            //
            // The CARD is the one descendant that does not count. It is where a mouse parks so that
            // nothing reads as pre-selected — it draws no focus visual and there is nothing on it to
            // activate — so a host sitting on it and then picking up a pad is, for every purpose here,
            // exactly as stranded as one whose focus the lobby stole. Counting it as "inside" would leave
            // them in the state this whole Deck fix exists to end.
            //
            // A HIDDEN owner does not count either, and that is not hypothetical: activating a host row
            // collapses the list under it. Godot is expected to release focus from a control it has just
            // hidden, but the activation gate requires IsVisibleInTree() anyway, so a focus owner nobody
            // can see is a dead end whether the engine let go of it or not. Asking directly means this
            // does not depend on which way that goes.
            var inside = !_card.HasFocus() && IsAncestorOf(owner) && owner.IsVisibleInTree();
            return new CouchCoopModalFocusParking.FocusState(inside, _dismiss.HasFocus());
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] modal focus read failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
            return new CouchCoopModalFocusParking.FocusState(false, false);
        }
    }

    private void ApplyFocusTarget(CouchCoopModalFocusParking.Target target)
    {
        try
        {
            switch (target)
            {
                case CouchCoopModalFocusParking.Target.Dismiss:
                    _dismiss.GrabFocus();
                    break;
                case CouchCoopModalFocusParking.Target.Card:
                    _card.GrabFocus();
                    break;
                case CouchCoopModalFocusParking.Target.ChainHead:
                    // The chain always has the dismiss button in it, so the head is never nothing — but
                    // a modal that has not been Install()ed has not built one yet.
                    (_chain.Count > 0 ? _chain[0] : _dismiss).GrabFocus();
                    break;
            }
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] modal focus parking failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// Whether the host is driving without a mouse, and so needs the dismiss button reachable by focus ring.
    /// Read through <see cref="CouchCoopHostInputMode"/>, which is the one place that knows the game reports
    /// this differently on different builds; false whenever it cannot be read.
    /// </summary>
    private static bool IsUsingController() => CouchCoopHostInputMode.Read().WithoutMouse;

    /// <summary>A pad was picked up (or put down) — re-park focus if this modal is the thing on screen.</summary>
    private void OnInputModeChanged()
    {
        if (!GodotObject.IsInstanceValid(this) || !Visible)
        {
            return;
        }

        ApplyFocusTarget(CouchCoopModalFocusParking.OnInputModeChanged(IsUsingController(), CurrentFocus()));
    }

    /// <summary>
    /// Subscribe to the game's input-mode signals for the life of this node, and arm the teardown.
    /// </summary>
    /// <remarks>
    /// Same lifetime discipline as <see cref="CouchCoopQrHotkeyHint"/>, and for the same reason: a
    /// <c>Callable.From</c> delegate is owned by no Godot object, so a connection left on the game's
    /// long-lived managers would outlive this node and be invoked against a freed one — and the panel
    /// holding these dialogs is built and freed on every trip through the lobby. The unhook hangs off the
    /// NATIVE <c>tree_exiting</c> signal because <c>_ExitTree</c> is not dispatched into this assembly.
    /// <para>
    /// The same teardown drops the cancel binding. That matters more than it looks: the lobby can be torn
    /// down while a modal is still up (B on the transport alert used to do exactly that), and a binding
    /// left behind would fire <see cref="Close"/> on a freed node the next time anyone pressed cancel.
    /// </para>
    /// </remarks>
    private void WireInputMode()
    {
        if (_inputModeWired)
        {
            return;
        }

        // tree_exiting first: if the Connect below throws, the teardown is already armed for the cancel
        // binding, which is the half that can outlive this node.
        try
        {
            Connect(Node.SignalName.TreeExiting, Callable.From(OnTreeExiting));
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] modal exit hook failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
            return;
        }

        _inputModeWired = true;
        ConnectInputMode(NControllerManager.SignalName.ControllerDetected);
        ConnectInputMode(NControllerManager.SignalName.MouseDetected);
    }

    private void OnTreeExiting()
    {
        UnwireInputMode();
        UnbindCancel();
    }

    private void UnwireInputMode()
    {
        if (!_inputModeWired)
        {
            return;
        }

        _inputModeWired = false;
        DisconnectInputMode(NControllerManager.SignalName.ControllerDetected);
        DisconnectInputMode(NControllerManager.SignalName.MouseDetected);
    }

    private void ConnectInputMode(StringName signal)
    {
        var source = NControllerManager.Instance;
        if (source is null || !GodotObject.IsInstanceValid(source))
        {
            return;
        }

        try
        {
            if (!source.IsConnected(signal, _inputModeChanged))
            {
                source.Connect(signal, _inputModeChanged);
            }
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] modal input mode connect failed signal={signal} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    private void DisconnectInputMode(StringName signal)
    {
        var source = NControllerManager.Instance;
        if (source is null || !GodotObject.IsInstanceValid(source))
        {
            return;
        }

        try
        {
            if (source.IsConnected(signal, _inputModeChanged))
            {
                source.Disconnect(signal, _inputModeChanged);
            }
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] modal input mode disconnect failed signal={signal} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    // ---- cancel binding ---------------------------------------------------------------------------

    // Escape / controller B, and the pause action with it. The hotkey manager keeps ONE list per action
    // and dispatches to the LAST-pushed binding, so pushing on open is what makes cancel close the dialog
    // instead of reaching the lobby's back button; removing on close hands it straight back. Instance is
    // nullable (it hangs off NGame), and the whole thing is best-effort: failing to bind must not stop the
    // dialog from opening, since the dismiss button and the click-outside path both still work.
    //
    // pauseAndBack is taken as well, matching the game's own modal screens (NInspectCardScreen and
    // NInspectRelicScreen both bind cancel AND pauseAndBack to their Close). Before this, Start on a pad
    // did nothing at all while a modal was up.
    private void BindCancel()
    {
        if (_cancelBound)
        {
            return;
        }

        try
        {
            var manager = NHotkeyManager.Instance;
            if (manager is null)
            {
                return;
            }

            manager.PushHotkeyPressedBinding(MegaInput.cancel, _closeAction);
            manager.PushHotkeyPressedBinding(MegaInput.pauseAndBack, _closeAction);
            _cancelBound = true;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"[couch-coop] modal cancel bind failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// The open modal's heartbeat, called from the lobby panel's 0.25s scan: re-take the cancel bindings
    /// and re-park controller focus. A no-op while no modal is up.
    /// </summary>
    /// <remarks>
    /// Both halves guard against the SAME thing — the lobby screen finishing its own setup after a modal
    /// that opened by itself. See <see cref="ReassertCancelBinding"/> and
    /// <see cref="CouchCoopModalFocusParking.OnHeartbeat"/>.
    /// </remarks>
    public void ReassertWhileOpen()
    {
        if (!GodotObject.IsInstanceValid(this) || !Visible)
        {
            return;
        }

        // Idempotent, and a retry: a bind that could not take at open time (no hotkey manager yet) would
        // otherwise leave this modal with no cancel at all for as long as it is up.
        BindCancel();
        ReassertCancelBinding();
        // The predicate is "focus is somewhere in this dialog", not "the dismiss button has focus": with a
        // walkable chain the second would drag a player off a host row four times a second.
        ApplyFocusTarget(CouchCoopModalFocusParking.OnHeartbeat(IsUsingController(), CurrentFocus()));
    }

    /// <summary>
    /// Re-take the cancel bindings, if this modal is up, so a binding pushed AFTER ours cannot keep them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Called from the lobby panel's 0.25s scan, and the reason it exists is measured: on a controller,
    /// B on the host-transport alert backed the player out of the whole lobby instead of dismissing it,
    /// while B on the QR dialog closed that dialog correctly. The difference is WHEN each opens. The
    /// lobby's back button pushes its own cancel/pauseAndBack/back handlers from <c>NButton.OnEnable</c>
    /// and drops them on <c>OnDisable</c>, and the screen runs that enable/disable cycle from its own
    /// visibility changes — so anything that cycles it after a modal opened puts the back handler back on
    /// top of ours. A dialog the player opens later, once the lobby has settled, never sees that.
    /// </para>
    /// <para>
    /// Remove-then-push is how a binding moves to the end of the list: the manager de-duplicates by
    /// delegate, so a bare re-push of an action already in the list does nothing. It is a no-op reorder
    /// when we are already last, which is the normal case, and it runs only while a modal is visible.
    /// </para>
    /// </remarks>
    private void ReassertCancelBinding()
    {
        if (!_cancelBound || !Visible)
        {
            return;
        }

        try
        {
            var manager = NHotkeyManager.Instance;
            if (manager is null)
            {
                return;
            }

            manager.RemoveHotkeyPressedBinding(MegaInput.cancel, _closeAction);
            manager.PushHotkeyPressedBinding(MegaInput.cancel, _closeAction);
            manager.RemoveHotkeyPressedBinding(MegaInput.pauseAndBack, _closeAction);
            manager.PushHotkeyPressedBinding(MegaInput.pauseAndBack, _closeAction);
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"[couch-coop] modal cancel reassert failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    private void UnbindCancel()
    {
        if (!_cancelBound)
        {
            return;
        }

        _cancelBound = false;
        try
        {
            var manager = NHotkeyManager.Instance;
            manager?.RemoveHotkeyPressedBinding(MegaInput.cancel, _closeAction);
            manager?.RemoveHotkeyPressedBinding(MegaInput.pauseAndBack, _closeAction);
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"[couch-coop] modal cancel unbind failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
        }
    }
}
