using Godot;
using MegaCrit.Sts2.Core.ControllerInput;
using MegaCrit.Sts2.Core.Nodes.GodotExtensions;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Shared plumbing for the mod's game-styled buttons: an <see cref="NButton"/> subclass with a
/// <c>Visuals/Image</c> + <c>Visuals/Label</c> tree, hooked up so it works WITHOUT Godot script
/// dispatch into this assembly.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this is not just "subclass NButton and override _Ready".</b> This mod is compiled without
/// Godot's C# source generators, so the assembly carries no <c>AssemblyHasScripts</c> registration and
/// the engine has no <c>CSharpScript</c> for these types. A node created with <c>new</c> therefore gets
/// a managed BINDING but not a script instance, and the engine's calls into script virtuals —
/// <c>_Ready</c>, <c>_EnterTree</c>, <c>_Input</c>, and critically <c>_GuiInput</c> — may never arrive.
/// Nothing here is allowed to depend on them:
/// </para>
/// <list type="bullet">
/// <item><description>
/// <c>_Ready</c> is still overridden (it costs nothing if it does fire) but the controller calls
/// <see cref="Install"/> explicitly after <c>AddChild</c>, and <see cref="Install"/> is idempotent so
/// both paths together are harmless.
/// </description></item>
/// <item><description>
/// <c>_GuiInput</c> is the load-bearing one: <see cref="NClickableControl"/> gets BOTH its mouse clicks
/// and its controller/keyboard activations (the <c>MegaInput.select</c> action) from there, and would
/// otherwise be permanently unactivatable. Godot emits the NATIVE <c>gui_input</c> SIGNAL for the same
/// events (the engine emits the signal and then calls the virtual), and a signal reaches a plain
/// <c>Callable</c> without any script instance. So we connect to the signal and drive
/// <c>OnPressHandler</c>/<c>OnReleaseHandler</c> ourselves, for both input sources, replicating the
/// base's own gate (enabled + visible + focused) exactly. Missing the action half is what made every
/// CouchCoop button dead on a Steam Deck in Game Mode, which has no mouse at all.
/// </description></item>
/// </list>
/// <para>
/// If script dispatch DOES work in some configuration, both paths run. That is deliberately safe:
/// <c>OnReleaseHandler</c> is already idempotent via the base's <c>_isPressed</c> latch, and
/// <see cref="OnPress"/> below is made idempotent by its own state check, so a doubled press cannot
/// double-play the click SFX or re-run the press animation.
/// </para>
/// <para>
/// Hover/focus need none of this: <c>ConnectSignals()</c> wires them to native <c>mouse_entered</c> /
/// <c>focus_entered</c> signals, which are already Callable-based. Note the base gates activation on
/// <c>IsFocused</c>, which is hovered OR controller-focused — so a synthetic click that never hovered
/// first does nothing. That is the game's behaviour, not ours, and QA drives these by hovering first.
/// The controller half of the same flag is why <see cref="FocusMode"/> must stay <c>All</c>: engine
/// focus raises <c>focus_entered</c>, which is what makes the select action's gate passable on a Deck.
/// </para>
/// </remarks>
internal abstract partial class CouchCoopTextureButton : NButton
{
    public const string VisualsName = "Visuals";
    public const string ImageName = "Image";
    public const string LabelName = "Label";

    private readonly Control _visuals = new() { Name = VisualsName };
    private readonly TextureRect _image = new() { Name = ImageName };
    private readonly Label _label = new() { Name = LabelName };
    private ShaderMaterial? _hsv;
    private Tween? _tween;
    private bool _installed;
    private bool _pressed;

    /// <summary>Invoked once per completed click (press then release on this control).</summary>
    public Action? Activated { get; set; }

    /// <summary>
    /// No hotkeys, so <c>ConnectSignals()</c> skips <c>RegisterHotkeys()</c> entirely. That keeps the
    /// game's <c>NHotkeyManager</c> stack untouched by an injected button — a mod-registered binding
    /// would sit on the LIFO stack and shadow the screen's own handler for that action.
    /// </summary>
    protected override string[] Hotkeys => [];

    protected Control Visuals => _visuals;
    protected TextureRect Image => _image;
    protected Label ButtonLabel => _label;
    protected ShaderMaterial? Hsv => _hsv;

    /// <param name="useFallbackPanel">
    /// Draw flat chrome when <paramref name="texture"/> is null. True for buttons that are SUPPOSED to
    /// have art (so a failed load stays visible); false for controls that are intentionally
    /// texture-less, like the dropdown rows, which draw their own highlight instead.
    /// </param>
    protected CouchCoopTextureButton(
        string name,
        Texture2D? texture,
        TextureRect.ExpandModeEnum expandMode,
        bool useFallbackPanel = true)
    {
        Name = name;
        // Stop (not Ignore, not Pass): the button must consume its own clicks so a press on it never
        // also reaches the lobby art behind it.
        MouseFilter = MouseFilterEnum.Stop;

        _visuals.SetAnchorsPreset(LayoutPreset.FullRect);
        _visuals.MouseFilter = MouseFilterEnum.Ignore;

        _hsv = CouchCoopGameUiTheme.CreateHsvMaterial();
        _image.SetAnchorsPreset(LayoutPreset.FullRect);
        _image.MouseFilter = MouseFilterEnum.Ignore;
        _image.ExpandMode = expandMode;
        _image.StretchMode = TextureRect.StretchModeEnum.KeepAspectCentered;
        _image.Texture = texture;
        if (_hsv is not null)
        {
            _image.Material = _hsv;
        }

        if (texture is null && useFallbackPanel)
        {
            // R3 fallback: a game update that renames the texture must still leave a visible, clickable
            // control rather than an invisible hit-box.
            var fallback = new Panel { Name = "Fallback" };
            fallback.SetAnchorsPreset(LayoutPreset.FullRect);
            fallback.MouseFilter = MouseFilterEnum.Ignore;
            fallback.AddThemeStyleboxOverride("panel", CouchCoopGameUiTheme.CreateFallbackStyle(
                new Color(0.055f, 0.067f, 0.09f, 0.92f), new Color(1f, 1f, 1f, 0.24f), cornerRadius: 10, borderWidth: 2));
            _visuals.AddChild(fallback);
        }

        _label.SetAnchorsPreset(LayoutPreset.FullRect);
        _label.MouseFilter = MouseFilterEnum.Ignore;
        _label.HorizontalAlignment = HorizontalAlignment.Center;
        _label.VerticalAlignment = VerticalAlignment.Center;
        _label.AutowrapMode = TextServer.AutowrapMode.WordSmart;

        _visuals.AddChild(_image);
        _visuals.AddChild(_label);
        AddChild(_visuals);
    }

    public string Text
    {
        get => _label.Text;
        set => _label.Text = value;
    }

    /// <summary>
    /// Idempotent wiring. Safe to call from <c>_Ready</c> AND from the controller after
    /// <c>AddChild</c> — whichever arrives first does the work.
    /// </summary>
    public void Install()
    {
        if (_installed)
        {
            return;
        }

        _installed = true;

        // FocusMode must be All BEFORE ConnectSignals(): the base snapshots it into its
        // _isControllerNavigable flag there, and a later change would not be picked up (so the button
        // would lose controller navigation across any Disable()/Enable() round trip).
        FocusMode = FocusModeEnum.All;

        try
        {
            ConnectSignals();
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] host-ui button ConnectSignals failed name={Name} detail={exception.GetType().Name}: {exception.Message}");
        }

        Connect(Control.SignalName.GuiInput, Callable.From<InputEvent>(OnGuiInputSignal));

        // Keep the scale pivot centred as the button is laid out, so a hover/press scale grows from the
        // middle instead of the top-left corner. Native signal, so no script dispatch needed.
        _visuals.Connect(Control.SignalName.Resized, Callable.From(RecentrePivot));
        RecentrePivot();

        ApplyRestingVisual();
    }

    private void RecentrePivot() => _visuals.PivotOffset = _visuals.Size / 2f;

    public override void _Ready() => Install();

    // The engine-dispatch-free activation path. Gated on the same conditions the game's own clickable controls
    // use (enabled, visible in tree, focused), so an activation here behaves identically to one the engine
    // delivered. The gate and the press/release choice live in CouchCoopButtonActivation, which is testable
    // without a Godot engine; this half only classifies the event and calls the base's handlers.
    private void OnGuiInputSignal(InputEvent inputEvent)
    {
        var input = Classify(inputEvent);
        var outcome = CouchCoopButtonActivation.Resolve(input, IsEnabled, IsVisibleInTree(), IsFocused);

        // Consume an activation that came from the SELECT ACTION, and only that. Godot routes a non-mouse
        // event to the focused control first and only then to `_unhandled_input`, where the game's hotkey
        // manager lives — and the lobby screens bind `select` to their embark/confirm button. Without this,
        // pressing A on a CouchCoop dismiss button would ALSO fire the lobby's embark behind the scrim.
        // Mouse events are left exactly as they were: the viewport already treats a click on a Stop control
        // as handled, so accepting one here would change nothing and is not worth the blast radius.
        if (outcome != CouchCoopButtonActivation.Outcome.None
            && input is CouchCoopButtonActivation.Input.SelectPress or CouchCoopButtonActivation.Input.SelectRelease)
        {
            AcceptEvent();
        }

        switch (outcome)
        {
            case CouchCoopButtonActivation.Outcome.Press:
                OnPressHandler();
                break;
            case CouchCoopButtonActivation.Outcome.Release:
                OnReleaseHandler();
                break;
        }
    }

    /// <summary>
    /// The two input sources a CouchCoop button answers to, reduced to the shape the rule takes.
    /// </summary>
    /// <remarks>
    /// The select action is what makes these buttons usable on a Steam Deck in Game Mode, where there is no
    /// mouse at all: the base activates on <c>MegaInput.select</c> from <c>_GuiInput</c>, which never reaches
    /// this assembly, so the same two calls are made from the native signal instead. Godot delivers a non-mouse
    /// event through <c>gui_input</c> to whichever control holds keyboard/controller focus, which is the same
    /// control the gate requires to be focused.
    /// <para>
    /// Left mouse is matched first so the pre-existing click path is untouched, and a doubled activation (if
    /// script dispatch also runs, or if a device maps both) is absorbed by the idempotent handlers.
    /// </para>
    /// </remarks>
    private static CouchCoopButtonActivation.Input Classify(InputEvent inputEvent)
    {
        if (inputEvent is InputEventMouseButton { ButtonIndex: MouseButton.Left } mouse)
        {
            return mouse.Pressed
                ? CouchCoopButtonActivation.Input.MousePress
                : CouchCoopButtonActivation.Input.MouseRelease;
        }

        if (inputEvent.IsActionPressed(MegaInput.select))
        {
            return CouchCoopButtonActivation.Input.SelectPress;
        }

        return inputEvent.IsActionReleased(MegaInput.select)
            ? CouchCoopButtonActivation.Input.SelectRelease
            : CouchCoopButtonActivation.Input.None;
    }

    protected override void OnFocus()
    {
        TryBaseSfx(base.OnFocus);
        if (!_pressed)
        {
            ApplyFocusVisual();
        }
    }

    protected override void OnUnfocus()
    {
        _pressed = false;
        ApplyRestingVisual(animate: true);
    }

    protected override void OnPress()
    {
        // Idempotent: see the class remarks — press may arrive twice if script dispatch also works.
        if (_pressed)
        {
            return;
        }

        _pressed = true;
        TryBaseSfx(base.OnPress);
        ApplyPressedVisual();
    }

    protected override void OnRelease()
    {
        _pressed = false;
        if (IsFocused)
        {
            ApplyFocusVisual();
        }
        else
        {
            ApplyRestingVisual(animate: true);
        }

        Activated?.Invoke();
    }

    /// <summary>Instant snap to the hovered/controller-focused look.</summary>
    protected abstract void ApplyFocusVisual();

    /// <summary>Instant snap to the held look.</summary>
    protected abstract void ApplyPressedVisual();

    /// <summary>Back to the idle look; <paramref name="animate"/> requests the game's ease-out settle.</summary>
    protected abstract void ApplyRestingVisual(bool animate = false);

    protected void SetHsvValue(float value)
    {
        _hsv?.SetShaderParameter("v", value);
        if (_hsv is null)
        {
            // No shader to brighten — fake the emphasis with modulate so the fallback still reacts.
            _visuals.Modulate = new Color(value, value, value, 1f);
        }
    }

    /// <summary>Stops any settle in flight so an instant state change is not fought by it.</summary>
    protected void KillTween()
    {
        _tween?.Kill();
        _tween = null;
    }

    /// <summary>
    /// Starts a fresh tween, killing any in flight. Returns null outside the tree (where Godot cannot
    /// create one), which every caller treats as "apply the end state instantly". Only call this when
    /// tweeners will actually be added — an empty tween is a Godot error.
    /// </summary>
    protected Tween? RestartTween()
    {
        KillTween();
        if (!IsInsideTree())
        {
            return null;
        }

        _tween = CreateTween();
        return _tween;
    }

    protected void TweenHsvValue(Tween tween, float target, float seconds, Tween.EaseType ease, Tween.TransitionType transition)
    {
        if (_hsv is not null)
        {
            tween.Parallel().TweenProperty(_hsv, CouchCoopGameUiTheme.HsvValueParameter, target, seconds)
                .SetEase(ease)
                .SetTrans(transition);
        }
        else
        {
            tween.Parallel().TweenProperty(_visuals, "modulate", new Color(target, target, target, 1f), seconds)
                .SetEase(ease)
                .SetTrans(transition);
        }
    }

    // The base's OnPress/OnFocus only play a UI sound. That reaches the game's audio stack, which an
    // injected button has no business taking the lobby down over.
    private static void TryBaseSfx(Action baseCall)
    {
        try
        {
            baseCall();
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"[couch-coop] host-ui button sfx skipped detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _tween?.Kill();
            _tween = null;
        }

        base.Dispose(disposing);
    }
}
