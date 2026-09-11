using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The lobby's "Couch Co-Op QR Code" button, styled after
/// <c>scenes/combat/ping_button.tscn</c>.
/// </summary>
/// <remarks>
/// The shipped scene's script (<c>NPingButton</c>) cannot be reused: its <c>_Ready</c> reaches for the
/// combat manager, so instancing it in a lobby throws. The VISUALS are replicated instead — same
/// texture, same hsv shader, same font/outline/shadow constants, same focus/press choreography — which
/// is why the numbers below look arbitrary but are not: each one is transcribed from that scene.
/// </remarks>
internal sealed partial class CouchCoopEventButton : CouchCoopTextureButton
{
    public const string NodeName = "CouchCoopQrButton";

    /// <summary>Brightness the ping button pops to while hovered/focused (hsv <c>v</c>).</summary>
    private const float FocusHsvValue = 1.5f;
    private const float RestingHsvValue = 1.0f;

    /// <summary>Visuals lift while focused, and dip while held — the scene's (0,-2) / (0,4).</summary>
    private static readonly Vector2 FocusOffset = new(0f, -2f);
    private static readonly Vector2 RestingOffset = Vector2.Zero;
    private static readonly Vector2 PressedOffset = new(0f, 4f);

    private const float SettleSeconds = 0.5f;
    private const float PressSeconds = 0.1f;

    public CouchCoopEventButton(int fontSize)
        : base(NodeName, CouchCoopGameUiTheme.EventButtonTexture, TextureRect.ExpandModeEnum.IgnoreSize)
    {
        CouchCoopGameUiTheme.ApplyFont(ButtonLabel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, fontSize);
        ButtonLabel.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.ButtonFontColor);
        ButtonLabel.AddThemeColorOverride("font_outline_color", CouchCoopGameUiTheme.ButtonOutlineColor);
        ButtonLabel.AddThemeColorOverride("font_shadow_color", CouchCoopGameUiTheme.ButtonShadowColor);
        ButtonLabel.AddThemeConstantOverride("outline_size", CouchCoopGameUiTheme.ButtonOutlineSize);
        ButtonLabel.AddThemeConstantOverride("shadow_outline_size", CouchCoopGameUiTheme.ButtonOutlineSize);
        ButtonLabel.AddThemeConstantOverride("shadow_offset_x", CouchCoopGameUiTheme.ButtonShadowOffsetX);
        ButtonLabel.AddThemeConstantOverride("shadow_offset_y", CouchCoopGameUiTheme.ButtonShadowOffsetY);
        ButtonLabel.AddThemeConstantOverride("line_spacing", -4);
    }

    /// <summary>Re-applies the hot-reloadable label size without rebuilding the node.</summary>
    public void ApplyFontSize(int fontSize)
        => CouchCoopGameUiTheme.ApplyFont(ButtonLabel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, fontSize);

    // Instant, like the scene: the pop must feel attached to the cursor crossing the edge.
    protected override void ApplyFocusVisual()
    {
        KillTween();
        SetHsvValue(FocusHsvValue);
        Visuals.Position = FocusOffset;
        Visuals.Modulate = Colors.White;
    }

    protected override void ApplyPressedVisual()
    {
        SetHsvValue(RestingHsvValue);
        Visuals.Modulate = CouchCoopGameUiTheme.PressedModulate;

        var tween = RestartTween();
        if (tween is null)
        {
            Visuals.Position = PressedOffset;
            return;
        }

        tween.TweenProperty(Visuals, "position", PressedOffset, PressSeconds)
            .SetEase(Tween.EaseType.Out)
            .SetTrans(Tween.TransitionType.Cubic);
    }

    protected override void ApplyRestingVisual(bool animate = false)
    {
        var tween = animate ? RestartTween() : null;
        if (tween is null)
        {
            KillTween();
            SetHsvValue(RestingHsvValue);
            Visuals.Position = RestingOffset;
            Visuals.Modulate = Colors.White;
            return;
        }

        // The scene's unfocus settle: everything eases back together over half a second.
        TweenHsvValue(tween, RestingHsvValue, SettleSeconds, Tween.EaseType.Out, Tween.TransitionType.Expo);
        tween.Parallel().TweenProperty(Visuals, "position", RestingOffset, SettleSeconds)
            .SetEase(Tween.EaseType.Out)
            .SetTrans(Tween.TransitionType.Expo);
        tween.Parallel().TweenProperty(Visuals, "modulate", Colors.White, SettleSeconds)
            .SetEase(Tween.EaseType.Out)
            .SetTrans(Tween.TransitionType.Expo);
    }
}
