using CouchCoop.Mod.HostUi;

// The copy affordance beside the QR dialog's printed address, in the two halves that can be checked
// without an engine: the glyph it draws, and where that glyph sits on the row.
//
// Both matter more than they look, because the whole design of this control is "faint, wordless, and off
// to one side". A glyph that rasterizes as a blob is not a subtle affordance, it is a smudge; an icon
// that lands on top of the address is not beside it. Neither failure trips a compiler, and the only other
// gate on either is somebody looking hard at a screenshot.
internal static class CouchCoopQrCopyAffordanceTests
{
    public static void Run()
    {
        CopyGlyphStacksTwoSheetsWithTheFrontOneOnTop();
        BothGlyphsAreWhiteWithTheShapeInTheAlphaAlone();
        CheckGlyphIsOneElbowStrokeClearOfTheEdges();
        TheIconSitsJustPastTheEndOfTheAddress();
        AnUnmeasurableAddressStillLandsOnTheRow();
        TheIconNeverLeavesTheTextColumn();

        Console.WriteLine("CouchCoopQrCopyAffordanceTests: ok");
    }

    private const int Edge = 64;

    // The URL row as the dialog actually lays it out: the shipped 24-unit panel padding inside a
    // 1000-wide card, and CouchCoopQrDialog.UrlHeight.
    private const float RowLeft = 24f;
    private const float RowWidth = 952f;
    private const float RowTop = 750f;
    private const float RowHeight = CouchCoopQrDialog.UrlHeight;
    private const float IconEdge = 26f;
    private const float Gap = 14f;

    // ---- the glyph ------------------------------------------------------------------------------------

    private static void CopyGlyphStacksTwoSheetsWithTheFrontOneOnTop()
    {
        var pixels = CouchCoopGlyphRaster.RenderCopyRgba8(Edge);
        Expect(pixels.Length == Edge * Edge * QrRaster.BytesPerPixel, "the buffer is one RGBA8 pixel per canvas cell");
        ExpectClearBorder(pixels, "copy");

        // Halfway down, where a horizontal cut passes through both sheets' side strokes.
        const float middle = 0.5f;
        const float intoStroke = CouchCoopGlyphRaster.Stroke / 2f;

        Expect(IsInk(pixels, CouchCoopGlyphRaster.FrontLeft + intoStroke, middle), "the front sheet's left edge is drawn");
        Expect(IsInk(pixels, CouchCoopGlyphRaster.FrontRight - intoStroke, middle), "the front sheet's right edge is drawn");
        Expect(IsInk(pixels, CouchCoopGlyphRaster.BackRight - intoStroke, middle), "the back sheet's right edge is drawn");

        // THE property that makes this read as a stack of two sheets rather than two crossed rectangles:
        // the back sheet's left edge runs straight through the front one and must not be visible there.
        Expect(IsClear(pixels, CouchCoopGlyphRaster.BackLeft + intoStroke, middle),
            "the back sheet's left edge is hidden behind the front sheet");

        // An outline, not a filled tile — a solid blob at this size is a smudge, not an icon.
        Expect(IsClear(pixels, 0.50f, 0.59f), "the front sheet is hollow");

        // Three crossings on that cut: the front sheet's two edges, then the back sheet's right one. A
        // fourth would mean the occlusion above stopped working; two would mean a sheet went missing.
        Expect(InkRuns(pixels, middle) == 3,
            $"a cut across the middle crosses both sheets exactly three times (got {InkRuns(pixels, middle)})");
    }

    private static void BothGlyphsAreWhiteWithTheShapeInTheAlphaAlone()
    {
        // The use site colours these with Modulate — one buffer serves the resting cream, the hover, the
        // green tick and the red failure — so any colour baked into the pixels would fight it. White under
        // the TRANSPARENT pixels too: they are sampled by the downscale to on-screen size, and transparent
        // black there drags a dark fringe around every edge.
        foreach (var (name, pixels) in Glyphs())
        {
            for (var offset = 0; offset < pixels.Length; offset += QrRaster.BytesPerPixel)
            {
                if (pixels[offset] == byte.MaxValue && pixels[offset + 1] == byte.MaxValue && pixels[offset + 2] == byte.MaxValue)
                {
                    continue;
                }

                Expect(false, $"the {name} glyph is white everywhere, shape in the alpha alone (colour at byte {offset})");
            }
        }
    }

    private static void CheckGlyphIsOneElbowStrokeClearOfTheEdges()
    {
        var pixels = CouchCoopGlyphRaster.RenderCheckRgba8(Edge);
        Expect(pixels.Length == Edge * Edge * QrRaster.BytesPerPixel, "the tick buffer is one RGBA8 pixel per canvas cell");
        ExpectClearBorder(pixels, "check");

        // The elbow and both arms' midpoints: a tick that lost an arm still passes a "something is drawn"
        // check, and the arm it loses is the long one that makes it legible as a tick at all.
        Expect(IsInk(pixels, 0.40f, 0.76f), "the tick's elbow is drawn");
        Expect(IsInk(pixels, 0.29f, 0.64f), "the tick's short arm is drawn");
        Expect(IsInk(pixels, 0.62f, 0.50f), "the tick's long arm is drawn");

        Expect(IsClear(pixels, 0.15f, 0.15f), "the tick leaves the top-left corner empty");
        Expect(IsClear(pixels, 0.90f, 0.90f), "the tick leaves the bottom-right corner empty");
    }

    // ---- where it sits --------------------------------------------------------------------------------

    private static void TheIconSitsJustPastTheEndOfTheAddress()
    {
        const float textWidth = 300f;
        var placement = Place(textWidth);

        // The label centres its text in the column, so the address ends here.
        var textRight = RowLeft + ((RowWidth + textWidth) / 2f);
        Expect(placement.X == textRight + Gap,
            $"the icon sits one gap past the end of the address (expected {textRight + Gap}, got {placement.X})");
        Expect(placement.Y == RowTop + ((RowHeight - IconEdge) / 2f),
            $"and is centred in the row (got {placement.Y})");
        Expect(placement.X >= textRight, "it never overlaps the address it acts on");
    }

    private static void AnUnmeasurableAddressStillLandsOnTheRow()
    {
        // The degraded answer when the engine cannot measure the font: right-aligned in the column, which
        // is still a reachable button on the correct line rather than one stacked on the address.
        var placement = Place(0f);
        Expect(placement.X == RowLeft + RowWidth - IconEdge, $"an unmeasurable address right-aligns the icon (got {placement.X})");
        Expect(placement.Y == RowTop + ((RowHeight - IconEdge) / 2f), "on the same row as ever");
    }

    private static void TheIconNeverLeavesTheTextColumn()
    {
        // An address wider than the column is already being clipped by the label; chasing text that is not
        // on screen would push the icon off the card.
        var placement = Place(5000f);
        Expect(placement.X + IconEdge <= RowLeft + RowWidth,
            $"an over-wide address cannot push the icon past the column (got {placement.X})");
        Expect(placement.X >= RowLeft, "nor before the start of it");
    }

    private static CouchCoopQrCopyRowPlacement Place(float measuredTextWidth)
        => CouchCoopQrCopyRowPlacement.For(RowLeft, RowWidth, RowTop, RowHeight, measuredTextWidth, IconEdge, Gap);

    // ---- helpers --------------------------------------------------------------------------------------

    private static (string Name, byte[] Pixels)[] Glyphs() =>
    [
        ("copy", CouchCoopGlyphRaster.RenderCopyRgba8(Edge)),
        ("check", CouchCoopGlyphRaster.RenderCheckRgba8(Edge)),
    ];

    private static void ExpectClearBorder(byte[] pixels, string name)
    {
        for (var index = 0; index < Edge; index++)
        {
            var clear = CouchCoopGlyphRaster.AlphaAt(pixels, Edge, index, 0) == 0
                && CouchCoopGlyphRaster.AlphaAt(pixels, Edge, index, Edge - 1) == 0
                && CouchCoopGlyphRaster.AlphaAt(pixels, Edge, 0, index) == 0
                && CouchCoopGlyphRaster.AlphaAt(pixels, Edge, Edge - 1, index) == 0;
            Expect(clear, $"the {name} glyph keeps clear of the canvas edge (row/column {index})");
        }
    }

    private static bool IsInk(byte[] pixels, float unitX, float unitY) => AlphaAt(pixels, unitX, unitY) > 200;

    private static bool IsClear(byte[] pixels, float unitX, float unitY) => AlphaAt(pixels, unitX, unitY) < 16;

    private static byte AlphaAt(byte[] pixels, float unitX, float unitY)
        => CouchCoopGlyphRaster.AlphaAt(pixels, Edge, Pixel(unitX), Pixel(unitY));

    private static int Pixel(float unit) => Math.Clamp((int)MathF.Round(unit * Edge), 0, Edge - 1);

    /// <summary>Contiguous runs of ink along one horizontal cut — how many strokes it crosses.</summary>
    private static int InkRuns(byte[] pixels, float unitY)
    {
        var y = Pixel(unitY);
        var runs = 0;
        var inside = false;
        for (var x = 0; x < Edge; x++)
        {
            var ink = CouchCoopGlyphRaster.AlphaAt(pixels, Edge, x, y) > 128;
            if (ink && !inside)
            {
                runs++;
            }

            inside = ink;
        }

        return runs;
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopQrCopyAffordanceTests failed: {because}");
        }
    }
}
