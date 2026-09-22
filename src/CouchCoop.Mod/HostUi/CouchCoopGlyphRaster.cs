namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The mod's two hand-drawn UI glyphs — the copy affordance and the tick that confirms it — as raw
/// RGBA8 bytes.
/// </summary>
/// <remarks>
/// <para>
/// Same split as <see cref="QrRaster"/>, and for the same reason: the shape is ordinary arithmetic, so it
/// is written here without a Godot type in sight and the engine half is two calls at the use site. It is
/// also the only way to draw these at all — this assembly is compiled without Godot's C# source
/// generators, so <c>_Draw</c> is never dispatched into it (see <see cref="CouchCoopTextureButton"/>'s
/// remarks) and a <c>Control</c> that paints itself is not an option.
/// </para>
/// <para>
/// <b>Every pixel is WHITE and carries the shape in its alpha alone</b>, so the use site's
/// <c>Modulate</c> owns the colour: one buffer serves the resting cream, the hover, the green tick and
/// the red failure. That includes the transparent pixels — the glyph is rasterized larger than it is
/// drawn and downscaled bilinearly, which samples them, and a transparent BLACK border would drag a dark
/// fringe around every edge.
/// </para>
/// <para>
/// Edges are antialiased from a signed distance field rather than by supersampling. Every shape here is a
/// rounded rectangle or a thick line segment, both of which have an exact distance function, so coverage
/// is <c>clamp(0.5 - d, 0, 1)</c> with <c>d</c> in pixels and one sample per pixel is enough.
/// </para>
/// </remarks>
internal static class CouchCoopGlyphRaster
{
    /// <summary>Smallest canvas the shapes still resolve on; below this the stroke rounds away.</summary>
    internal const int MinEdge = 16;

    /// <summary>Index of the alpha byte within one RGBA8 pixel.</summary>
    private const int AlphaChannel = QrRaster.BytesPerPixel - 1;

    // Unit-square geometry, multiplied up by the canvas edge. `internal` so the suite can probe NAMED
    // points — the back sheet's hidden left edge, the front sheet's hollow middle — rather than re-typing
    // coordinates that a tweak here would silently invalidate.
    internal const float BackLeft = 0.34f;
    internal const float BackTop = 0.10f;
    internal const float BackRight = 0.90f;
    internal const float BackBottom = 0.72f;
    internal const float FrontLeft = 0.10f;
    internal const float FrontTop = 0.28f;
    internal const float FrontRight = 0.66f;
    internal const float FrontBottom = 0.90f;

    /// <summary>Line thickness shared by both glyphs, in unit-square terms.</summary>
    internal const float Stroke = 0.075f;

    private const float Corner = 0.07f;

    /// <summary>
    /// Clearance the front sheet keeps around itself where it covers the back one. Without it the two
    /// outlines touch and the pair reads as one lumpy shape instead of as a stack.
    /// </summary>
    private const float Gap = 0.05f;

    // The tick, as an elbow of two segments. Deliberately not centred on the square: a check mark reads
    // as balanced when its long arm ends higher than its short one starts.
    private const float CheckStartX = 0.18f;
    private const float CheckStartY = 0.52f;
    private const float CheckElbowX = 0.40f;
    private const float CheckElbowY = 0.76f;
    private const float CheckEndX = 0.84f;
    private const float CheckEndY = 0.24f;

    /// <summary>Two offset sheets, the back one punched out where the front sits on it.</summary>
    public static byte[] RenderCopyRgba8(int edge)
    {
        var size = Math.Max(MinEdge, edge);
        var back = new Box(BackLeft, BackTop, BackRight, BackBottom).Scaled(size);
        var front = new Box(FrontLeft, FrontTop, FrontRight, FrontBottom).Scaled(size);
        var stroke = Stroke * size;
        var corner = Corner * size;
        var gap = Gap * size;

        return Render(size, (x, y) =>
        {
            var frontSheet = Coverage(Ring(x, y, front, corner, stroke));
            // The back sheet shows only outside the front one's footprint. Subtracting a COVERAGE rather
            // than testing a boolean is what keeps the cut antialiased along with everything else.
            var covered = Coverage(RoundRect(x, y, front.Inflated(gap), corner + gap));
            var backSheet = Math.Min(Coverage(Ring(x, y, back, corner, stroke)), 1f - covered);
            return Math.Max(frontSheet, backSheet);
        });
    }

    /// <summary>The confirmation tick, at the same line weight as the copy glyph.</summary>
    public static byte[] RenderCheckRgba8(int edge)
    {
        var size = Math.Max(MinEdge, edge);
        var halfStroke = Stroke * size / 2f;

        return Render(size, (x, y) =>
        {
            var shortArm = Segment(x, y, CheckStartX * size, CheckStartY * size, CheckElbowX * size, CheckElbowY * size);
            var longArm = Segment(x, y, CheckElbowX * size, CheckElbowY * size, CheckEndX * size, CheckEndY * size);
            return Coverage(Math.Min(shortArm, longArm) - halfStroke);
        });
    }

    /// <summary>Alpha of one pixel of a rendered buffer. Exists for the suite, like <see cref="QrRaster.IsModuleDark"/>.</summary>
    internal static byte AlphaAt(ReadOnlySpan<byte> pixels, int edge, int x, int y)
    {
        if ((uint)x >= (uint)edge || (uint)y >= (uint)edge)
        {
            throw new ArgumentOutOfRangeException(nameof(x), $"({x}, {y}) is outside a {edge}px glyph.");
        }

        return pixels[(((y * edge) + x) * QrRaster.BytesPerPixel) + AlphaChannel];
    }

    private static byte[] Render(int edge, Func<float, float, float> coverageAt)
    {
        var pixels = new byte[checked(edge * edge * QrRaster.BytesPerPixel)];
        var offset = 0;
        for (var y = 0; y < edge; y++)
        {
            for (var x = 0; x < edge; x++)
            {
                // Pixel CENTRES, which is what makes a distance of exactly 0 land on half coverage.
                var alpha = coverageAt(x + 0.5f, y + 0.5f);
                pixels[offset] = byte.MaxValue;
                pixels[offset + 1] = byte.MaxValue;
                pixels[offset + 2] = byte.MaxValue;
                pixels[offset + 3] = (byte)MathF.Round(Math.Clamp(alpha, 0f, 1f) * byte.MaxValue);
                offset += QrRaster.BytesPerPixel;
            }
        }

        return pixels;
    }

    private static float Coverage(float distance) => Math.Clamp(0.5f - distance, 0f, 1f);

    /// <summary>An outline: inside <paramref name="box"/> but outside the same box deflated by the stroke.</summary>
    private static float Ring(float x, float y, Box box, float corner, float stroke)
        => MathF.Max(RoundRect(x, y, box, corner), -RoundRect(x, y, box.Inflated(-stroke), corner - stroke));

    private static float RoundRect(float x, float y, Box box, float corner)
    {
        var halfWidth = (box.Right - box.Left) / 2f;
        var halfHeight = (box.Bottom - box.Top) / 2f;
        var radius = Math.Clamp(corner, 0f, MathF.Min(halfWidth, halfHeight));
        var offsetX = MathF.Abs(x - (box.Left + halfWidth)) - (halfWidth - radius);
        var offsetY = MathF.Abs(y - (box.Top + halfHeight)) - (halfHeight - radius);
        var outside = MathF.Sqrt(
            (MathF.Max(offsetX, 0f) * MathF.Max(offsetX, 0f)) + (MathF.Max(offsetY, 0f) * MathF.Max(offsetY, 0f)));
        // The second term is the inside distance; without it a point deep in the rect reports 0 rather
        // than how far in it is, and the ring's subtraction would have nothing to bite on.
        return outside + MathF.Min(MathF.Max(offsetX, offsetY), 0f) - radius;
    }

    private static float Segment(float x, float y, float fromX, float fromY, float toX, float toY)
    {
        var runX = toX - fromX;
        var runY = toY - fromY;
        var lengthSquared = (runX * runX) + (runY * runY);
        var along = lengthSquared <= 0f
            ? 0f
            : Math.Clamp((((x - fromX) * runX) + ((y - fromY) * runY)) / lengthSquared, 0f, 1f);
        var nearestX = fromX + (along * runX);
        var nearestY = fromY + (along * runY);
        return MathF.Sqrt(((x - nearestX) * (x - nearestX)) + ((y - nearestY) * (y - nearestY)));
    }

    private readonly record struct Box(float Left, float Top, float Right, float Bottom)
    {
        public Box Scaled(float factor) => new(Left * factor, Top * factor, Right * factor, Bottom * factor);

        public Box Inflated(float amount) => new(Left - amount, Top - amount, Right + amount, Bottom + amount);
    }
}
