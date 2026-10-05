using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Fixed geometry for the QR dialog's right-hand companion card, in the 1920×1080 design space.
/// </summary>
/// <remarks>
/// The card is the connection card's mirror image about x=960, so its outer box is BORROWED from
/// <see cref="CouchCoopConnectionLayout"/> rather than re-typed: the two cards cannot drift apart in width,
/// height or gap, and the QR card between them stays centred. Only the interior is this card's own.
/// </remarks>
internal static class CouchCoopSeatModLayout
{
    public const float Width = CouchCoopConnectionLayout.Width;
    public const float Height = CouchCoopConnectionLayout.Height;
    public const float Gap = CouchCoopConnectionLayout.Gap;
    public const float MainCardWidth = CouchCoopConnectionLayout.MainCardWidth;
    public const float Padding = CouchCoopConnectionLayout.Padding;
    public const float InnerWidth = Width - Padding * 2;

    public const float RouteTitleTop = 8f;
    public const float RouteTitleHeight = 44f;
    public const float SharedRouteTop = 64f;
    public const float DirectRouteTop = 124f;
    public const float RouteButtonHeight = 52f;
    public const float RouteNoteTop = 188f;
    public const float RouteNoteHeight = 84f;
    public const float RouteOnlyHeight = 296f;
    public const float TitleTop = 276f;
    public const float TitleHeight = 44f;
    public const float ListTop = 328f;
    public const float RowHeight = 68f;

    // The explanation box sits under the list and the confirm pair under that, pinned to the card floor. While
    // no confirm is pending the box takes the pair's strip back, so the list never moves under a d-pad walk.
    public const float ButtonWidth = 180f;
    public const float ButtonHeight = 48f;
    public const float ButtonTop = Height - Padding - ButtonHeight;
    public const float DetailTop = 724f;
    public const float DetailGap = 8f;
    public const float ListHeight = DetailTop - DetailGap - ListTop;
    public static float DetailHeightFor(bool confirming)
        => confirming ? ButtonTop - DetailGap - DetailTop : Height - Padding - DetailTop;

    /// <summary>Left edge when the unchanged QR card is centred at x=960: its right edge plus the shared gap.</summary>
    public const float Left = (1920f + MainCardWidth) / 2f + Gap;
    public const float Top = (1080f - Height) / 2f;

    public static readonly Vector2 Size = new(Width, Height);
}
