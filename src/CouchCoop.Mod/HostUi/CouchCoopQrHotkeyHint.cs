using Godot;
using CouchCoop.Mod.Localization;
using MegaCrit.Sts2.Core.Nodes.CommonUi;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The mouseless affordance for the lobby QR button: the glyph of the action that opens the dialog, plus one
/// short line of copy, shown only while the game is actually being driven without a mouse.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a hint exists at all.</b> The lobby's controller focus ring is closed — the character-select
/// screen pins each character button's top/bottom neighbour to itself and rings left/right among those
/// buttons only, so focus can never reach an injected control. And in controller mode the game warps the
/// mouse off-screen, so there is no hover fallback either. The button is therefore driven by a hotkey
/// (see <see cref="CouchCoopQrHostPanel"/>), and a hotkey nobody can see is a hotkey nobody presses.
/// </para>
/// <para>
/// <b>"Without a mouse" is wider than "with a controller", and only on one game build.</b> Game v0.107.1
/// offers a single boolean, <c>NControllerManager.IsUsingController</c>, so on that build the two questions
/// are the same question and the hint follows the boolean. v0.111.0 replaces it with
/// <c>NControllerManager.InputType</c> (<c>MouseAndKeyboard</c> / <c>KeyboardOnlyMode</c> / <c>Controller</c>),
/// and there the hint shows for BOTH non-mouse modes, because everything the first paragraph says about a
/// controller is equally true of keyboard-only mode: the mouse is taken away on screen, so there is no hover
/// fallback and the closed focus ring still cannot reach this button, while the hotkey itself keeps firing
/// (the hotkey manager dispatches on the input ACTION, and the keyboard is mapped into it). That partition is
/// the game's own, not ours — its public <c>ShouldShowInputGlyphs</c> and <c>IsUsingDirectionalNavigation</c>
/// draw the line in the same place. Mapping the boolean to
/// <c>== Controller</c> would have silently dropped every keyboard-only player, which is a mode v0.111.0
/// shipped as a feature. The two lanes therefore behave DIFFERENTLY on purpose: v0.107.1 cannot express
/// keyboard-only mode at all, so there is nothing there to show the hint for.
/// </para>
/// <para>
/// The GLYPH is narrower than the hint. <c>GetHotkeyIcon</c> answers with the action's CONTROLLER button, so a
/// keyboard-only player would be shown a gamepad button they do not have; the texture is therefore fetched
/// only in controller mode, which lands keyboard-only mode in the already-designed "copy without an icon"
/// state below. The game's own hint widget draws the bound KEY NAME there instead; doing the same here is a
/// worthwhile follow-up and wants a live beta lobby to look at, so it is deliberately not guessed at here.
/// </para>
/// <para>
/// <b>Cheap, and off the tick.</b> The glyph is fetched once on install and then only when the game says
/// the input picture changed — <c>ControllerDetected</c> / <c>MouseDetected</c> on the controller manager
/// and <c>InputRebound</c> on the input manager. The 0.25s panel scan never touches this node. Those two
/// signals cover keyboard-only mode too: v0.111.0 announces a switch INTO it as <c>ControllerDetected</c>
/// and a switch back to the mouse as <c>MouseDetected</c>, so no third connection is needed.
/// </para>
/// <para>
/// <b>Lifecycle.</b> This assembly is built without Godot's C# source generators, so <c>_Ready</c> and
/// <c>_ExitTree</c> may never be dispatched into it (see <c>CouchCoopTextureButton</c>'s remarks). Wiring
/// is an explicit idempotent <see cref="Install"/>, and the unhook hangs off the NATIVE
/// <c>tree_exiting</c> signal. Unhooking matters more here than usual: a <c>Callable.From</c> delegate is
/// not owned by any Godot object, so a connection left behind on the game's long-lived managers would
/// outlive this node and be invoked against a freed one — and the panel is built and freed on every trip
/// through the lobby.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopQrHotkeyHint : Control
{
    public const string NodeName = "CouchCoopQrHotkeyHint";
    public const string GlyphName = "CouchCoopQrHotkeyGlyph";

    /// <summary>Node name of the copy line. Deliberately NOT "Label": the QA probe's row helper finds the
    /// first descendant named <c>Label</c>, and the button already owns one.</summary>
    public const string HintLabelName = "CouchCoopQrHotkeyLabel";

    /// <summary>Gap below the button's bottom edge, and the strip's height, in the 1920x1080 design space.</summary>
    private const float TopGap = 10f;
    private const float StripHeight = 44f;

    /// <summary>Square glyph box, sized to sit level with the copy at <see cref="HintFontSize"/>.</summary>
    private const float GlyphExtent = 40f;
    private const int HintFontSize = 24;
    private const int RowSeparation = 10;

    private readonly string _action;
    private readonly HBoxContainer _row = new() { Name = "Row" };
    private readonly TextureRect _glyph = new() { Name = GlyphName };
    private readonly Label _label = new() { Name = HintLabelName };
    private readonly Callable _refresh;

    private bool _installed;
    private bool _wired;

    /// <param name="action">
    /// The <c>MegaInput</c> action whose glyph to draw. Chosen by the panel, which owns the binding.
    /// </param>
    public CouchCoopQrHotkeyHint(string action)
    {
        _action = action;
        _refresh = Callable.From(Refresh);

        Name = NodeName;
        // Anchored to the BUTTON's bottom edge (this node is the button's child), so the strip follows the
        // hot-reloadable button rect with no layout code of its own. A child may draw outside its parent's
        // rect — the button sets no clip — which is what puts the hint under the button rather than in it.
        AnchorLeft = 0f;
        AnchorRight = 1f;
        AnchorTop = 1f;
        AnchorBottom = 1f;
        OffsetTop = TopGap;
        OffsetBottom = TopGap + StripHeight;
        MouseFilter = MouseFilterEnum.Ignore;
        Visible = false;

        _row.SetAnchorsPreset(LayoutPreset.FullRect);
        _row.MouseFilter = MouseFilterEnum.Ignore;
        _row.Alignment = BoxContainer.AlignmentMode.Center;
        _row.AddThemeConstantOverride("separation", RowSeparation);

        _glyph.MouseFilter = MouseFilterEnum.Ignore;
        _glyph.CustomMinimumSize = new Vector2(GlyphExtent, GlyphExtent);
        _glyph.ExpandMode = TextureRect.ExpandModeEnum.IgnoreSize;
        _glyph.StretchMode = TextureRect.StretchModeEnum.KeepAspectCentered;
        _glyph.Visible = false;

        _label.MouseFilter = MouseFilterEnum.Ignore;
        _label.VerticalAlignment = VerticalAlignment.Center;
        _label.HorizontalAlignment = HorizontalAlignment.Center;
        CouchCoopGameUiTheme.ApplyFont(_label, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, HintFontSize);
        _label.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ButtonFontColor);
        _label.AddThemeColorOverride("font_outline_color", CouchCoopGameUiTheme.ButtonOutlineColor);
        _label.AddThemeColorOverride("font_shadow_color", CouchCoopGameUiTheme.ButtonShadowColor);
        _label.AddThemeConstantOverride("outline_size", CouchCoopGameUiTheme.ButtonOutlineSize);
        _label.AddThemeConstantOverride("shadow_offset_x", CouchCoopGameUiTheme.ButtonShadowOffsetX);
        _label.AddThemeConstantOverride("shadow_offset_y", CouchCoopGameUiTheme.ButtonShadowOffsetY);

        _row.AddChild(_glyph);
        _row.AddChild(_label);
        AddChild(_row);
    }

    /// <summary>Wording is part of the QA contract, like the button's own.</summary>
    public static string HintText => CouchCoopLocalization.Resolve("couchcoop_qr_button_hotkey");

    /// <summary>Idempotent wiring, called by the owner after <c>AddChild</c>.</summary>
    public void Install()
    {
        if (_installed)
        {
            return;
        }

        _installed = true;
        Wire();
        RefreshLocalization();
        Refresh();
    }

    public override void _Ready() => Install();

    public void RefreshLocalization()
    {
        _label.Text = HintText;
        CouchCoopGameUiTheme.ApplyFont(_label, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, HintFontSize);
    }

    /// <summary>
    /// Re-reads whether the game is being driven without a mouse and which glyph that action currently wears.
    /// </summary>
    /// <remarks>
    /// Best-effort throughout: the hint is an affordance, and neither a missing singleton nor a glyph that
    /// failed to load is worth taking a lobby down for. A null texture hides the icon but keeps the copy,
    /// so the line still says the button can be opened without the mouse.
    /// </remarks>
    private void Refresh()
    {
        if (!GodotObject.IsInstanceValid(this))
        {
            return;
        }

        try
        {
            var input = CouchCoopHostInputMode.Read();
            Visible = input.WithoutMouse;
            if (!input.WithoutMouse)
            {
                return;
            }

            // NInputManager, not NControllerManager: it maps the ACTION through the player's (possibly
            // rebound) controller map before asking for the button's glyph, which is what the game's own
            // buttons and the ascension panel do. Controller mode only — that map answers with a gamepad
            // button, which is not what a keyboard-only player is holding.
            var icon = input.OnController ? NInputManager.Instance?.GetHotkeyIcon(_action) : null;
            _glyph.Texture = icon;
            _glyph.Visible = icon is not null;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] qr hotkey hint refresh failed detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    private void Wire()
    {
        if (_wired)
        {
            return;
        }

        // tree_exiting first: if a later Connect throws, the unhook is already armed for whatever did land.
        try
        {
            Connect(Node.SignalName.TreeExiting, Callable.From(Unwire));
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] qr hotkey hint exit hook failed detail={exception.GetType().Name}: {exception.Message}");
            return;
        }

        _wired = true;
        ConnectRefresh(NControllerManager.Instance, NControllerManager.SignalName.ControllerDetected);
        ConnectRefresh(NControllerManager.Instance, NControllerManager.SignalName.MouseDetected);
        ConnectRefresh(NInputManager.Instance, NInputManager.SignalName.InputRebound);
    }

    private void Unwire()
    {
        if (!_wired)
        {
            return;
        }

        _wired = false;
        DisconnectRefresh(NControllerManager.Instance, NControllerManager.SignalName.ControllerDetected);
        DisconnectRefresh(NControllerManager.Instance, NControllerManager.SignalName.MouseDetected);
        DisconnectRefresh(NInputManager.Instance, NInputManager.SignalName.InputRebound);
    }

    private void ConnectRefresh(GodotObject? source, StringName signal)
    {
        if (source is null || !GodotObject.IsInstanceValid(source))
        {
            return;
        }

        try
        {
            if (!source.IsConnected(signal, _refresh))
            {
                source.Connect(signal, _refresh);
            }
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] qr hotkey hint connect failed signal={signal} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    private void DisconnectRefresh(GodotObject? source, StringName signal)
    {
        if (source is null || !GodotObject.IsInstanceValid(source))
        {
            return;
        }

        try
        {
            if (source.IsConnected(signal, _refresh))
            {
                source.Disconnect(signal, _refresh);
            }
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] qr hotkey hint disconnect failed signal={signal} detail={exception.GetType().Name}: {exception.Message}");
        }
    }
}
