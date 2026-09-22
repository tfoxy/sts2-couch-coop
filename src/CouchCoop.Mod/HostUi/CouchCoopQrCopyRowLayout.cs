namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Where the copy affordance sits in the QR dialog's URL row: beside the rendered address, not pinned to
/// the card's edge.
/// </summary>
/// <remarks>
/// <para>
/// The URL label spans the whole text column and centres its text inside it, so "to the side of the URL"
/// is a function of how wide the address actually RENDERS — a short <c>http://10.0.0.4:13337/</c> and a
/// long secure link put the icon in different places. Pinning it to the column's right edge instead would
/// leave it stranded a couple of hundred units away from the thing it acts on, reading as a stray control
/// rather than as part of the row.
/// </para>
/// <para>
/// Godot-free, like <see cref="CouchCoopModalFocusChain"/> and <see cref="CouchCoopButtonActivation"/>:
/// the measurement needs a live font, but the arithmetic on top of it does not, and it is the arithmetic
/// that has the edge cases (an address wider than the column, a font the engine could not measure).
/// </para>
/// </remarks>
internal readonly record struct CouchCoopQrCopyRowPlacement(float X, float Y)
{
    /// <summary>
    /// Place a <paramref name="iconEdge"/>-square icon <paramref name="gap"/> to the right of centred
    /// text of width <paramref name="measuredTextWidth"/>, vertically centred in the row.
    /// </summary>
    /// <param name="measuredTextWidth">
    /// Width of the rendered address. <c>0</c> or less means the engine could not measure it, which
    /// right-aligns the icon in the row — the degraded answer, but still a reachable button on the right
    /// line rather than one stacked on top of the address.
    /// </param>
    internal static CouchCoopQrCopyRowPlacement For(
        float rowLeft,
        float rowWidth,
        float rowTop,
        float rowHeight,
        float measuredTextWidth,
        float iconEdge,
        float gap)
    {
        var y = rowTop + ((rowHeight - iconEdge) / 2f);
        var rightLimit = rowLeft + rowWidth - iconEdge;

        if (measuredTextWidth <= 0f)
        {
            return new CouchCoopQrCopyRowPlacement(MathF.Max(rowLeft, rightLimit), y);
        }

        // An address wider than the column is already being clipped by the label; the icon follows the
        // column's edge rather than chasing text that is not on screen.
        var textWidth = MathF.Min(measuredTextWidth, rowWidth);
        var textRight = rowLeft + ((rowWidth + textWidth) / 2f);
        return new CouchCoopQrCopyRowPlacement(Math.Clamp(textRight + gap, rowLeft, MathF.Max(rowLeft, rightLimit)), y);
    }
}
