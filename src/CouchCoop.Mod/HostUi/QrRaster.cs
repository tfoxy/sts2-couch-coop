namespace CouchCoop.Mod.HostUi;

/// <summary>
/// How one QR code is laid out on its raster canvas: the whole number of source pixels every module
/// occupies, and the white margin that pads the result out to a FIXED canvas edge.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why the padding exists.</b> The dialog's <c>TextureRect</c> has a constant on-screen extent, so a
/// 41-module code (the secure URL) must end up on the same size canvas as a 37-module one (the plain LAN
/// URL) or ticking the checkbox visibly resizes the code. The naive fix — stretch the raster to the box —
/// resamples the module grid at a fractional scale, which merges and splits modules and can make a code
/// unscannable at exactly the moment someone is pointing a phone at it.
/// </para>
/// <para>
/// So the difference is absorbed as WHITE PADDING instead of as a display scale. Every module keeps an
/// identical whole number of source pixels (<see cref="PixelsPerModule"/>, a floor division, so there is
/// no off-by-one row or column), and whatever is left over becomes a centred white border. Padding a QR
/// with white is <i>adding quiet zone</i>, which is explicitly allowed and never hurts scanning — the
/// spec-mandated 4-module zone is already inside <see cref="OfflineQrCode"/>'s matrix (see
/// <c>HostLobbyQrOverlayLayout</c>'s remarks on <c>QuietZoneModules</c>), and this only widens it.
/// </para>
/// <para>
/// What the player sees is that the code fills MOST of a box that never changes size, rather than the box
/// tracking the code. With the shipped 592-unit extent the two URLs the mod actually produces land at
/// 592 (37 modules x 16px) and 574 (41 modules x 14px) — a 3% difference, against the 592-vs-492 (17%)
/// jump of the old whole-number-display-scale scheme.
/// </para>
/// </remarks>
/// <param name="Modules">Edge of the code's module matrix, quiet zone included. 0 for "no code".</param>
/// <param name="PixelsPerModule">Source pixels per module, identical for every module. 0 iff no code.</param>
/// <param name="CanvasPixels">Edge of the square raster. Never smaller than <see cref="ContentPixels"/>.</param>
public readonly record struct QrRasterPlan(int Modules, int PixelsPerModule, int CanvasPixels)
{
    /// <summary>Edge of the drawn module grid, before padding.</summary>
    public int ContentPixels => Modules * PixelsPerModule;

    /// <summary>White pixels above and to the left of the grid.</summary>
    public int PadLeading => (CanvasPixels - ContentPixels) / 2;

    /// <summary>White pixels below and to the right. Carries the odd pixel when the pad is not even.</summary>
    public int PadTrailing => CanvasPixels - ContentPixels - PadLeading;

    /// <summary>
    /// Plan a code of <paramref name="modules"/> modules onto a canvas of
    /// <paramref name="targetCanvasPixels"/> pixels square.
    /// </summary>
    /// <remarks>
    /// Degrades rather than dividing to zero. A pathological module count (more modules than the canvas
    /// has pixels) would floor to 0 px per module and render nothing at all, so the module size clamps at
    /// 1 and the canvas GROWS to hold the grid instead — the code is still complete and still uniform, it
    /// is merely downscaled by the constant-extent <c>TextureRect</c>. Cropping is never an option: a
    /// clipped QR is not a QR. In practice this branch is unreachable — <see cref="OfflineQrCode"/> tops
    /// out at QRCoder's version-40 (177) matrix plus a validated quiet zone.
    /// </remarks>
    public static QrRasterPlan For(int modules, int targetCanvasPixels)
    {
        var canvas = Math.Max(1, targetCanvasPixels);
        if (modules <= 0)
        {
            return new QrRasterPlan(0, 0, canvas);
        }

        var pixelsPerModule = Math.Max(1, canvas / modules);
        return new QrRasterPlan(modules, pixelsPerModule, Math.Max(canvas, modules * pixelsPerModule));
    }
}

/// <summary>
/// Rasterizes an <see cref="OfflineQrCode"/> into raw RGBA8 bytes. Deliberately Godot-free so the whole
/// "did every module survive" question is unit-testable without an engine.
/// </summary>
/// <remarks>
/// One buffer, filled by hand and handed to <c>Image.CreateFromData</c> in a single interop call. The
/// previous rasterizer used <c>Image.SetPixel</c> per pixel, which is why the raster had to stay tiny
/// (~148px) and be upscaled: at the 592px canvas the constant-extent scheme needs, a per-pixel interop
/// loop would be ~350k marshalled calls on a lobby frame. Writing bytes makes the canvas size free.
/// </remarks>
public static class QrRaster
{
    /// <summary>Channels per pixel in <see cref="RenderRgba8"/>'s output (R, G, B, A).</summary>
    public const int BytesPerPixel = 4;

    /// <summary>
    /// Render <paramref name="code"/> onto <paramref name="plan"/>'s canvas: black modules on white,
    /// centred, with the plan's padding left white.
    /// </summary>
    public static byte[] RenderRgba8(OfflineQrCode code, QrRasterPlan plan)
    {
        ArgumentNullException.ThrowIfNull(code);
        if (plan.Modules != code.Size)
        {
            throw new ArgumentException(
                $"The raster plan is for a {plan.Modules}-module code but this code is {code.Size}.", nameof(plan));
        }

        if (plan.CanvasPixels <= 0 || plan.CanvasPixels < plan.ContentPixels)
        {
            throw new ArgumentException(
                $"A {plan.CanvasPixels}px canvas cannot hold a {plan.ContentPixels}px module grid without cropping it.",
                nameof(plan));
        }

        var edge = plan.CanvasPixels;
        var pixels = new byte[checked(edge * edge * BytesPerPixel)];

        // Opaque white everywhere first; the pad is then literally untouched canvas, which is exactly
        // what "the padding is quiet zone" means.
        Array.Fill(pixels, byte.MaxValue);

        var origin = plan.PadLeading;
        var moduleSize = plan.PixelsPerModule;

        for (var moduleY = 0; moduleY < plan.Modules; moduleY++)
        {
            for (var moduleX = 0; moduleX < plan.Modules; moduleX++)
            {
                if (!code.IsDark(moduleX, moduleY))
                {
                    continue;
                }

                var firstX = origin + (moduleX * moduleSize);
                var firstY = origin + (moduleY * moduleSize);
                for (var y = firstY; y < firstY + moduleSize; y++)
                {
                    var offset = ((y * edge) + firstX) * BytesPerPixel;
                    for (var column = 0; column < moduleSize; column++)
                    {
                        // Alpha is already 255 from the fill; only the colour channels go dark.
                        pixels[offset] = 0;
                        pixels[offset + 1] = 0;
                        pixels[offset + 2] = 0;
                        offset += BytesPerPixel;
                    }
                }
            }
        }

        return pixels;
    }

    /// <summary>
    /// Reads a rendered buffer back as "is this module dark", the inverse of <see cref="RenderRgba8"/>.
    /// </summary>
    /// <remarks>
    /// Exists for the suite: recovering the exact module matrix out of the pixels is what proves the
    /// raster is a lossless rendering of the code (and therefore that padding it changed nothing a
    /// scanner reads). Cheap enough to keep next to the writer so the two cannot drift.
    /// </remarks>
    public static bool IsModuleDark(ReadOnlySpan<byte> pixels, QrRasterPlan plan, int moduleX, int moduleY)
    {
        if ((uint)moduleX >= (uint)plan.Modules || (uint)moduleY >= (uint)plan.Modules)
        {
            throw new ArgumentOutOfRangeException(
                nameof(moduleX), $"Module ({moduleX}, {moduleY}) is outside a {plan.Modules}-module code.");
        }

        var firstX = plan.PadLeading + (moduleX * plan.PixelsPerModule);
        var firstY = plan.PadLeading + (moduleY * plan.PixelsPerModule);
        var offset = ((firstY * plan.CanvasPixels) + firstX) * BytesPerPixel;
        return pixels[offset] == 0;
    }
}
