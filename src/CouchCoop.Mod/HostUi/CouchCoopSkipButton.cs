using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The dismiss button every <see cref="CouchCoopModalDialog"/> ends with, styled after
/// <c>scenes/ui/choice_selection_skip_button.tscn</c>.
/// </summary>
/// <remarks>
/// Same reasoning as <see cref="CouchCoopEventButton"/>: the shipped script is not reusable, so the
/// visuals are replicated. This one reacts with brightness AND scale rather than a lift, which is what
/// makes it read as the "dismiss" affordance the reward screen trained the player on.
/// <para>
/// Note the resting brightness is 0.9, not 1.0 — the shipped button sits slightly dimmed so that the
/// hover step to 1.1 is visible. Starting it at 1.0 would make the hover almost imperceptible.
/// </para>
/// <para>
/// The node name defaults to the QR dialog's published <c>CouchCoopQrCloseButton</c> — that string is
/// asserted by the QA probes and the architecture map — and is overridable so a second modal can own a
/// button of the same type without colliding with that contract.
/// </para>
/// </remarks>
internal sealed partial class CouchCoopSkipButton : CouchCoopTextureButton
{
    public const string NodeName = "CouchCoopQrCloseButton";

    /// <summary>Design width of the shipped skip button.</summary>
    /// <remarks>
    /// The two halves are <c>const</c> as well as being the <see cref="DesignSize"/> vector, so a card-geometry
    /// contract can read them without touching a Godot-derived type: a <c>const</c> is inlined into the caller
    /// at compile time, while reading the <c>static readonly</c> vector would load this class.
    /// </remarks>
    internal const float DesignWidth = 300f;

    /// <summary>Design height of the shipped skip button. See <see cref="DesignWidth"/>.</summary>
    internal const float DesignHeight = 73f;

    /// <summary>Design size of the shipped skip button.</summary>
    public static readonly Vector2 DesignSize = new(DesignWidth, DesignHeight);

    /// <summary>Design font size of the shipped skip button's label.</summary>
    public const int DesignFontSize = 34;

    private const float RestingHsvValue = 0.9f;
    private const float FocusHsvValue = 1.1f;
    private const float PressedHsvValue = 0.7f;

    private const float FocusScale = 1.05f;
    private const float PressedScale = 0.95f;
    private const float RestingScale = 1.0f;

    private const float SettleSeconds = 0.2f;
    private readonly int _fontSize;

    public CouchCoopSkipButton(int fontSize = DesignFontSize, string? nodeName = null)
        : base(nodeName ?? NodeName, CouchCoopGameUiTheme.RewardSkipButtonTexture, TextureRect.ExpandModeEnum.FitWidthProportional)
    {
        _fontSize = fontSize;
        CustomMinimumSize = DesignSize;
        CouchCoopGameUiTheme.ApplyFont(ButtonLabel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceTwo, fontSize);
        ButtonLabel.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.SkipFontColor);
        ButtonLabel.AddThemeColorOverride("font_outline_color", CouchCoopGameUiTheme.SkipOutlineColor);
        ButtonLabel.AddThemeColorOverride("font_shadow_color", CouchCoopGameUiTheme.SkipShadowColor);
        ButtonLabel.AddThemeConstantOverride("outline_size", CouchCoopGameUiTheme.SkipOutlineSize);
        ButtonLabel.AddThemeConstantOverride("shadow_outline_size", 0);
        ButtonLabel.AddThemeConstantOverride("shadow_offset_x", CouchCoopGameUiTheme.SkipShadowOffsetX);
        ButtonLabel.AddThemeConstantOverride("shadow_offset_y", CouchCoopGameUiTheme.SkipShadowOffsetY);
    }

    public void RefreshLocalization() => CouchCoopGameUiTheme.ApplyFont(ButtonLabel, CouchCoopGameUiTheme.KreonBoldGlyphSpaceTwo, _fontSize);

    protected override void ApplyFocusVisual() => Snap(FocusHsvValue, FocusScale);

    protected override void ApplyPressedVisual() => Snap(PressedHsvValue, PressedScale);

    protected override void ApplyRestingVisual(bool animate = false)
    {
        var tween = animate ? RestartTween() : null;
        if (tween is null)
        {
            Snap(RestingHsvValue, RestingScale);
            return;
        }

        TweenHsvValue(tween, RestingHsvValue, SettleSeconds, Tween.EaseType.Out, Tween.TransitionType.Quad);
        tween.Parallel().TweenProperty(Visuals, "scale", Vector2.One * RestingScale, SettleSeconds)
            .SetEase(Tween.EaseType.Out)
            .SetTrans(Tween.TransitionType.Quad);
    }

    private void Snap(float hsvValue, float scale)
    {
        KillTween();
        SetHsvValue(hsvValue);
        Visuals.Scale = Vector2.One * scale;
    }
}
