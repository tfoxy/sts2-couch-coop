using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-crisp2: the pure alpha USED-RECT + transparent-HOLE scan (ArtAlphaScan) behind TextureStore.RecordArtInfo.
// Proves the threshold lets a scroll-edge fade whose middle only APPROACHES 0 register a hole (the strict alpha!=0
// scan did not), that a genuinely opaque middle stays hole-free, that the exact-0 real-BorderGradient case is found
// under BOTH thresholds, and the used-rect + row/column-orientation geometry.
internal static class ArtAlphaScanTests
{
    public static void Run()
    {
        MidAlpha5FindsHoleUnderDefaultThreshold();
        MidAlpha5FindsNoHoleUnderStrictThreshold();
        MidAlpha51FindsNoHoleUnderDefaultThreshold();
        ExactZeroBandFoundUnderBothThresholds();
        FullyOpaqueHasNoHole();
        FullyTransparentUsedRectEmpty();
        ColumnOrientedHoleForHorizontalFade();
        UsedRectSpansEdgeBandsFullHeight();
    }

    private const int DefaultThreshold = 8;   // TextureStore.ArtAlphaThreshold default (~3%)
    private const int Strict = ArtAlphaScan.StrictThreshold; // 1 == the pre-crisp2 alpha!=0 test

    // A W×H vertical fade: `edge` opaque rows top+bottom, `midAlpha` across the middle band (like a GradientTexture2D
    // scroll-edge scrim whose middle fades toward — but not necessarily to — 0).
    private static byte[] VerticalFade(int w, int h, int edge, byte midAlpha)
    {
        var buf = new byte[w * h * 4];
        for (int y = 0; y < h; y++)
        {
            byte a = (y < edge || y >= h - edge) ? (byte)255 : midAlpha;
            for (int x = 0; x < w; x++)
            {
                buf[((y * w) + x) * 4 + 3] = a;
            }
        }

        return buf;
    }

    // A W×H horizontal fade: `edge` opaque cols left+right, `midAlpha` across the middle columns.
    private static byte[] HorizontalFade(int w, int h, int edge, byte midAlpha)
    {
        var buf = new byte[w * h * 4];
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                byte a = (x < edge || x >= w - edge) ? (byte)255 : midAlpha;
                buf[((y * w) + x) * 4 + 3] = a;
            }
        }

        return buf;
    }

    // min alpha 0.02 ≈ 5/255: below the default 8 threshold ⇒ the middle band reads as a transparent HOLE.
    private static void MidAlpha5FindsHoleUnderDefaultThreshold()
    {
        var (used, hole) = ArtAlphaScan.Scan(VerticalFade(2, 256, 13, 5), 2, 256, DefaultThreshold);
        Check.That(hole is not null, "min-alpha 0.02 gradient finds a hole under the default threshold");
        var h = hole!.Value;
        Check.Equal(h.X, 0, "hole spans full width X");
        Check.Equal(h.Width, 2, "hole spans full width");
        Check.Equal(h.Y, 13, "hole starts after the top opaque band");
        Check.Equal(h.Height, 256 - 26, "hole covers the 230-row transparent middle");
        Check.Equal(used.Width, 2, "used-rect full width");
        Check.Equal(used.Height, 256, "used-rect full height (both opaque edge bands painted)");
    }

    // The pre-crisp2 strict alpha!=0 scan sees alpha 5 as PAINTED, so it finds NO hole — this is the crisp2 fix.
    private static void MidAlpha5FindsNoHoleUnderStrictThreshold()
    {
        var (_, hole) = ArtAlphaScan.Scan(VerticalFade(2, 256, 13, 5), 2, 256, Strict);
        Check.That(hole is null, "strict alpha!=0 scan finds NO hole in a fade that only approaches 0");
    }

    // min alpha 0.2 ≈ 51/255: well above 8 ⇒ the middle is genuinely opaque, NO hole (the fade look is preserved).
    private static void MidAlpha51FindsNoHoleUnderDefaultThreshold()
    {
        var (_, hole) = ArtAlphaScan.Scan(VerticalFade(2, 256, 13, 51), 2, 256, DefaultThreshold);
        Check.That(hole is null, "a >=20%-alpha middle stays opaque — no hole under the default threshold");
    }

    // The REAL BorderGradient shape (offsets 0.05..0.95 exactly alpha 0): found under BOTH thresholds — the diagnosis
    // that this texture's hole WOULD scan if art-info were recorded.
    private static void ExactZeroBandFoundUnderBothThresholds()
    {
        foreach (var t in new[] { Strict, DefaultThreshold })
        {
            var (_, hole) = ArtAlphaScan.Scan(VerticalFade(2, 256, 13, 0), 2, 256, t);
            Check.That(hole is not null, $"exact-0 band found (threshold {t})");
            Check.Equal(hole!.Value.Height, 256 - 26, $"exact-0 hole covers the middle (threshold {t})");
        }
    }

    private static void FullyOpaqueHasNoHole()
    {
        var (used, hole) = ArtAlphaScan.Scan(VerticalFade(4, 8, 4, 255), 4, 8, DefaultThreshold);
        Check.That(hole is null, "a fully-opaque image has no hole");
        Check.Equal(used.Width, 4, "used full width");
        Check.Equal(used.Height, 8, "used full height");
    }

    private static void FullyTransparentUsedRectEmpty()
    {
        var buf = new byte[4 * 8 * 4]; // all zero alpha
        var (used, hole) = ArtAlphaScan.Scan(buf, 4, 8, DefaultThreshold);
        Check.That(used.IsEmpty, "a fully-transparent image has an empty used-rect");
        Check.That(hole is not null && hole.Value.Height == 8, "a fully-transparent image's hole spans every row");
    }

    // A horizontal fade picks the COLUMN orientation (a full-height run of transparent columns covers more area).
    private static void ColumnOrientedHoleForHorizontalFade()
    {
        var (_, hole) = ArtAlphaScan.Scan(HorizontalFade(256, 2, 13, 5), 256, 2, DefaultThreshold);
        Check.That(hole is not null, "a horizontal fade finds a hole");
        var h = hole!.Value;
        Check.Equal(h.Y, 0, "column hole spans full height Y");
        Check.Equal(h.Height, 2, "column hole spans full height");
        Check.Equal(h.X, 13, "column hole starts after the left opaque band");
        Check.Equal(h.Width, 256 - 26, "column hole covers the transparent middle columns");
    }

    private static void UsedRectSpansEdgeBandsFullHeight()
    {
        var (used, _) = ArtAlphaScan.Scan(VerticalFade(2, 256, 13, 0), 2, 256, DefaultThreshold);
        Check.Equal(used.Y, 0, "used starts at the top opaque band");
        Check.Equal(used.Height, 256, "used spans to the bottom opaque band");
    }
}
