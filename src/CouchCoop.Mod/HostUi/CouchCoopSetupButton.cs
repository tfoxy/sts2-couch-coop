using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>Guide-only button: artwork and input bounds remain the same size inside wider layout slots.</summary>
internal sealed partial class CouchCoopSetupButton : CouchCoopTextureButton
{
    private Control? _platformIcon;
    private string? _platformKey;
    public CouchCoopSetupButton(string name) : base(name, CouchCoopGameUiTheme.RewardSkipButtonTexture,
        TextureRect.ExpandModeEnum.IgnoreSize)
    {
        CustomMinimumSize = new(DirectIpSetupLayout.ButtonWidth, DirectIpSetupLayout.ButtonHeight);
        Size = CustomMinimumSize;
        SizeFlagsHorizontal = SizeFlags.ShrinkCenter;
        SizeFlagsVertical = SizeFlags.ShrinkCenter;
        ButtonLabel.OffsetLeft = DirectIpSetupLayout.ButtonPadding;
        ButtonLabel.OffsetRight = -DirectIpSetupLayout.ButtonPadding;
        ButtonLabel.OffsetTop = (DirectIpSetupLayout.ButtonHeight - DirectIpSetupLayout.ButtonTextHeight) / 2;
        ButtonLabel.OffsetBottom = -ButtonLabel.OffsetTop;
        ButtonLabel.ClipText = true;
        ButtonLabel.MaxLinesVisible = 2;
        ButtonLabel.AddThemeColorOverride("font_color", CouchCoopGameUiTheme.SkipFontColor);
        ButtonLabel.AddThemeColorOverride("font_outline_color", CouchCoopGameUiTheme.SkipOutlineColor);
        ButtonLabel.AddThemeConstantOverride("outline_size", 3);
        RefreshLocalization();
    }

    public void SetPlatformIcon(string platformKey)
    {
        if (_platformKey == platformKey) return;
        var icon = DirectIpPlatformIcons.Create(platformKey);
        if (_platformIcon is { } previous)
        {
            Visuals.RemoveChild(previous);
            previous.QueueFree();
        }
        icon.Position = new Vector2(24, 20.5f);
        icon.Modulate = CouchCoopGameUiTheme.SkipFontColor;
        Visuals.AddChild(icon);
        _platformIcon = icon;
        _platformKey = platformKey;
        ButtonLabel.OffsetLeft = 84;
        ButtonLabel.OffsetRight = -24;
    }

    public void RefreshLocalization() => CouchCoopGameUiTheme.ApplyFont(ButtonLabel,
        CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, DirectIpSetupLayout.ButtonFontSize);
    protected override void ApplyFocusVisual() => SetHsvValue(1.2f);
    protected override void ApplyPressedVisual() => SetHsvValue(0.7f);
    protected override void ApplyRestingVisual(bool animate = false) => SetHsvValue(0.9f);
}
