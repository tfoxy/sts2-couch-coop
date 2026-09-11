using Godot;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The Godot half of QR rasterization: <see cref="QrRaster"/> produces the bytes, this wraps them in an
/// <see cref="ImageTexture"/>. Everything worth testing lives on the other side of that split.
/// </summary>
public static class QrCodeTextureFactory
{
    public static ImageTexture Create(Uri joinBaseUri, int quietZoneModules, QrRasterPlan plan)
        => Create(OfflineQrCode.EncodeJoinUrl(joinBaseUri, quietZoneModules), plan);

    /// <summary>
    /// Rasterize <paramref name="qrCode"/> onto <paramref name="plan"/>'s fixed-size canvas.
    /// </summary>
    /// <remarks>
    /// One <c>CreateFromData</c> call rather than a <c>SetPixel</c> loop. The loop was affordable only
    /// because the raster was tiny and got integer-upscaled on display; the constant-extent scheme needs
    /// a full-size canvas (~350k pixels at the shipped extent), and marshalling that per pixel would be a
    /// visible hitch on the lobby frame that opens the dialog.
    /// </remarks>
    public static ImageTexture Create(OfflineQrCode qrCode, QrRasterPlan plan)
    {
        ArgumentNullException.ThrowIfNull(qrCode);

        var pixels = QrRaster.RenderRgba8(qrCode, plan);
        var image = Image.CreateFromData(plan.CanvasPixels, plan.CanvasPixels, false, Image.Format.Rgba8, pixels);
        return ImageTexture.CreateFromImage(image);
    }
}
