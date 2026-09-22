using CouchCoop.Mod.Session;
using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The quiet icon beside the QR dialog's printed join URL: one click puts that address on the system
/// clipboard, and the glyph itself is the receipt.
/// </summary>
/// <remarks>
/// <para>
/// <b>Deliberately faint.</b> The card is built around the QR code, and a second lit-up control on the
/// row under it would compete with the thing players are meant to point a phone at. So it rests at
/// <see cref="RestAlpha"/> — findable by someone looking for it, easy to not notice otherwise — and only
/// comes up to full strength under the cursor, under controller focus, or while it is reporting a copy.
/// </para>
/// <para>
/// <b>A plain <see cref="Button"/>, not a <see cref="CouchCoopTextureButton"/>.</b> That base exists to
/// replicate the game's own art-backed buttons (borrowed texture, click SFX, press-scale, the
/// <c>NClickableControl</c> activation gate), and this control wants none of it. What it does need —
/// working clicks and controller activation without Godot script dispatch — a bare <c>Button</c> already
/// has: its input handling is engine-side C++, its <c>Pressed</c> signal reaches a plain
/// <see cref="Callable"/>, and <c>CouchCoopModalDialog.SelectFocusedControl</c> already fires the select
/// action at a focused <c>Button</c>. The connection panel's own copy button is the same shape.
/// </para>
/// <para>
/// <b>The button owns no URL.</b> <see cref="Payload"/> is asked for the address at press time, so the
/// selected host option stays the single source of truth for what the QR encodes AND what gets copied —
/// the same reasoning that keeps the label and the code reading off one value in
/// <c>CouchCoopQrDialog.RenderSelection</c>.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopQrCopyButton : Button
{
    public const string NodeName = "CouchCoopQrDialogCopyButton";

    /// <summary>
    /// On-screen size, design units. <c>internal const</c> so the card-geometry contract can check it
    /// against the URL row's height without loading this Godot-derived type.
    /// </summary>
    internal const float IconEdge = 26f;

    /// <summary>Gap between the end of the rendered address and the icon's left edge.</summary>
    internal const float TextGap = 14f;

    /// <summary>Resting opacity. Low enough to recede behind the QR, high enough to find.</summary>
    private const float RestAlpha = 0.3f;

    private const float FadeSeconds = 0.12f;
    private const float FeedbackSeconds = 1.5f;

    /// <summary>Source resolution of the generated glyphs, downscaled to <see cref="IconEdge"/> on screen.</summary>
    private const int GlyphPixels = 64;

    private enum Feedback
    {
        None,
        Copied,
        Failed,
    }

    private ImageTexture? _copyGlyph;
    private ImageTexture? _checkGlyph;
    private Tween? _tween;
    private Feedback _feedback;
    private long _feedbackToken;
    private bool _hovered;
    private bool _engaged;
    private bool _installed;

    /// <summary>Asked for the address to copy at press time; <see langword="null"/> means "nothing to copy".</summary>
    public Func<string?>? Payload { get; set; }

    /// <summary>
    /// Raised when the button becomes — or stops being — the thing the player is pointing at, so the
    /// dialog can put its hover tip up and take it down.
    /// </summary>
    /// <remarks>
    /// Mouse hover OR engine focus, because the dialog's other tips work that way: the host-select rows
    /// hang theirs off <c>NClickableControl.IsFocused</c>, which is hovered-or-controller-focused. A
    /// controller host walking onto this icon has no other way to find out what it does.
    /// </remarks>
    public Action<bool>? Engaged { get; set; }

    public CouchCoopQrCopyButton()
    {
        Name = NodeName;
        Flat = true;
        ExpandIcon = true;
        FocusMode = FocusModeEnum.All;
        MouseFilter = MouseFilterEnum.Stop;
        CustomMinimumSize = new Vector2(IconEdge, IconEdge);
        Size = new Vector2(IconEdge, IconEdge);

        // No chrome at any state: the glyph IS the button. Focus is the one exception — a controller host
        // walking the dialog's ring has to be able to see where they are standing.
        AddThemeStyleboxOverride("normal", new StyleBoxEmpty());
        AddThemeStyleboxOverride("hover", new StyleBoxEmpty());
        AddThemeStyleboxOverride("pressed", new StyleBoxEmpty());
        AddThemeStyleboxOverride("disabled", new StyleBoxEmpty());
        AddThemeStyleboxOverride(
            "focus",
            CouchCoopGameUiTheme.CreateFallbackStyle(
                Colors.Transparent, CouchCoopGameUiTheme.ConnectionFocusCream, cornerRadius: 4, borderWidth: 2));

        ApplyVisualState(animate: false);
    }

    /// <summary>Idempotent wiring, called by the dialog after <c>AddChild</c>. See <see cref="CouchCoopTextureButton"/>.</summary>
    public void Install()
    {
        if (_installed)
        {
            return;
        }

        _installed = true;
        Connect(BaseButton.SignalName.Pressed, Callable.From(OnPressed));
        Connect(Control.SignalName.MouseEntered, Callable.From(() => Refresh(hovered: true)));
        Connect(Control.SignalName.MouseExited, Callable.From(() => Refresh(hovered: false)));
        // Focus is read back off the engine rather than latched: a mouse leaving a control a controller
        // still has focus on must not read as "let go of".
        Connect(Control.SignalName.FocusEntered, Callable.From(() => Refresh()));
        Connect(Control.SignalName.FocusExited, Callable.From(() => Refresh()));
    }

    /// <summary>Drop any tick or failure still on screen — the dialog calls this on close and on a re-render.</summary>
    public void ResetFeedback()
    {
        // Bumped unconditionally: it is what strands a revert timer already in flight.
        _feedbackToken++;
        if (_feedback == Feedback.None)
        {
            return;
        }

        _feedback = Feedback.None;
        ApplyVisualState(animate: false);
    }

    private void OnPressed()
    {
        if (Payload?.Invoke() is not { Length: > 0 } address)
        {
            return;
        }

        _feedback = CouchCoopClipboard.TryCopy(address, DisplayServer.ClipboardSet, DisplayServer.ClipboardGet)
            ? Feedback.Copied
            : Feedback.Failed;

        ArmRevert();
        ApplyVisualState();
    }

    private void Refresh(bool? hovered = null)
    {
        if (hovered is { } value)
        {
            _hovered = value;
        }

        ApplyVisualState();

        // Edge-triggered: the tip system throws on a second set for one owner, and the dialog's teardown
        // rule is written against transitions. Hover-leave while a controller still holds focus is not one.
        var engaged = _hovered || HasFocus();
        if (engaged == _engaged)
        {
            return;
        }

        _engaged = engaged;
        Engaged?.Invoke(engaged);
    }

    // A token rather than a stored timer: SceneTreeTimer fires once and cannot be cancelled, so a second
    // click during the first tick's window would otherwise have its receipt wiped by the older timer.
    private void ArmRevert()
    {
        _feedbackToken++;
        var token = _feedbackToken;
        if (!IsInsideTree())
        {
            return;
        }

        try
        {
            // ignoreTimeScale: a receipt on a UI control should last 1.5 seconds of the player's time
            // whatever the game has done to its own clock.
            GetTree().CreateTimer(FeedbackSeconds, processAlways: true, processInPhysics: false, ignoreTimeScale: true)
                .Connect(SceneTreeTimer.SignalName.Timeout, Callable.From(() => OnRevertElapsed(token)));
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"qr copy revert timer failed detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    private void OnRevertElapsed(long token)
    {
        if (!GodotObject.IsInstanceValid(this) || token != _feedbackToken)
        {
            return;
        }

        _feedback = Feedback.None;
        ApplyVisualState();
    }

    private void ApplyVisualState(bool animate = true)
    {
        Icon = _feedback == Feedback.Copied ? Glyph(ref _checkGlyph, check: true) : Glyph(ref _copyGlyph, check: false);

        var target = TargetModulate();
        KillTween();
        if (!animate || !IsInsideTree())
        {
            Modulate = target;
            return;
        }

        _tween = CreateTween();
        _tween.TweenProperty(this, "modulate", target, FadeSeconds)
            .SetEase(Tween.EaseType.Out)
            .SetTrans(Tween.TransitionType.Quad);
    }

    private Color TargetModulate()
    {
        var color = _feedback switch
        {
            Feedback.Copied => CouchCoopGameUiTheme.ConnectionCompleteGreen,
            Feedback.Failed => CouchCoopGameUiTheme.ConnectionFailureRed,
            _ => CouchCoopGameUiTheme.ButtonFontColor,
        };

        // Anything the player is touching, or that the button is reporting, comes up to full strength.
        var lit = _feedback != Feedback.None || _hovered || HasFocus();
        return new Color(color.R, color.G, color.B, lit ? 1f : RestAlpha);
    }

    // Built on demand and re-built if the engine frees the cached one, the same self-healing shape
    // CouchCoopGameUiTheme's DeferredResource uses: loading a fixture over a live screen frees textures,
    // and a disposed wrapper throws on every later use rather than degrading.
    private static ImageTexture? Glyph(ref ImageTexture? cached, bool check)
    {
        if (cached is not null && GodotObject.IsInstanceValid(cached))
        {
            return cached;
        }

        try
        {
            var pixels = check
                ? CouchCoopGlyphRaster.RenderCheckRgba8(GlyphPixels)
                : CouchCoopGlyphRaster.RenderCopyRgba8(GlyphPixels);
            var image = Image.CreateFromData(GlyphPixels, GlyphPixels, false, Image.Format.Rgba8, pixels);
            cached = ImageTexture.CreateFromImage(image);
        }
        catch (Exception exception)
        {
            cached = null;
            CouchCoopLog.Stderr($"qr copy glyph render failed detail={exception.GetType().Name}: {exception.Message}");
        }

        return cached;
    }

    private void KillTween()
    {
        _tween?.Kill();
        _tween = null;
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
