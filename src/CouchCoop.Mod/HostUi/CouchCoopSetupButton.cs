using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>Guide-only button: artwork and input bounds remain the same size inside wider layout slots.</summary>
internal sealed partial class CouchCoopSetupButton : CouchCoopTextureButton
{
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

    public void RefreshLocalization() => CouchCoopGameUiTheme.ApplyFont(ButtonLabel,
        CouchCoopGameUiTheme.KreonBoldGlyphSpaceOne, DirectIpSetupLayout.ButtonFontSize);
    protected override void ApplyFocusVisual() => SetHsvValue(1.2f);
    protected override void ApplyPressedVisual() => SetHsvValue(0.7f);
    protected override void ApplyRestingVisual(bool animate = false) => SetHsvValue(0.9f);
}
