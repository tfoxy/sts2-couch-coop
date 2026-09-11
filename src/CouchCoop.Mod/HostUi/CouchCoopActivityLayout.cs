namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Geometry for the host connectivity log panel, in the game's 1920x1080 <c>canvas_items</c> design space.
/// </summary>
/// <remarks>
/// <para>
/// <b>Right-ANCHORED, not absolute.</b> <c>project.godot</c> stretches <c>canvas_items</c> with
/// <c>expand</c>, so an ultrawide window grows the design WIDTH rather than letterboxing. An absolute
/// left/right pair (which is what <see cref="HostLobbyQrOverlayLayout"/> uses for the button in the
/// lobby's lower-left dead space) would leave this panel stranded mid-screen there. Anchoring both
/// horizontal edges to 1.0 and carrying negative offsets keeps it hugging the right edge at any width.
/// </para>
/// <para>
/// <b>Why y=96.</b> The game's own version text (<c>main_menu.tscn :: ReleaseInfo</c>, anchored 1/1,
/// design y 18..63) shows through on the lobby — clearly visible against a Regent-orange background. The
/// top edge sits below it with room to spare. Verified clear of the load screen's <c>NinePatchRect</c>
/// (x 906..1333), the character-select info panel / character row / ready panel, the remote-player
/// container and the QR button. One accepted overlap: an OPEN act-dropdown list (y 75..250) would collide,
/// but that list is not normally visible on these screens.
/// </para>
/// <para>
/// <b>Deliberately NOT on the hot-reload overlay-layout JSON path.</b> <see cref="HostLobbyQrOverlayLayout"/>
/// is a positional record deserialised from the loader's JSON, where a missing field silently becomes
/// <c>default(float)</c> — i.e. a panel at 0x0. These are compile-time constants precisely so that trap
/// cannot apply to a surface whose whole job is to be visible when something else has gone wrong.
/// </para>
/// </remarks>
internal static class CouchCoopActivityLayout
{
    /// <summary>Panel width. 560 fits a full sentence at <see cref="LogFontSize"/> without wrapping most rows.</summary>
    public const float Width = 560f;

    /// <summary>Gap between the panel and the right edge of the design space.</summary>
    public const float RightMargin = 24f;

    /// <summary>Top edge — below the game's ReleaseInfo version label (which ends at y 63).</summary>
    public const float Top = 96f;

    /// <summary>Bottom edge when expanded (440 units tall).</summary>
    public const float Bottom = 536f;

    /// <summary>Header strip height. The COLLAPSED panel is exactly this tall, with the same top edge.</summary>
    public const float HeaderHeight = 44f;

    /// <summary>Inset between the card's edges and its content.</summary>
    public const float ContentPadding = 12f;

    /// <summary>Width reserved on the header's right for the "–" / "+" affordance.</summary>
    public const float ToggleWidth = 32f;

    public const int TitleFontSize = 20;
    public const int LogFontSize = 18;

    public const float CardCornerRadius = 16f;
    public const float CardBorderWidth = 3f;

    /// <summary>Same chrome as the QR dialog card, so the two injected surfaces read as one mod.</summary>
    public const string CardColorHtml = HostLobbyQrOverlayLayout.DefaultPanelColorHtml;

    /// <inheritdoc cref="CardColorHtml"/>
    public const string CardBorderColorHtml = HostLobbyQrOverlayLayout.DefaultPanelBorderColorHtml;

    /// <summary>Offset from the RIGHT anchor to the panel's left edge (negative: -584).</summary>
    public const float OffsetLeft = -(RightMargin + Width);

    /// <summary>Offset from the RIGHT anchor to the panel's right edge (negative: -24).</summary>
    public const float OffsetRight = -RightMargin;

    /// <summary>Expanded height.</summary>
    public const float ExpandedHeight = Bottom - Top;
}
