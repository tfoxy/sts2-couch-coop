namespace CouchCoop.MirrorProtocol.SceneModel;

using System;

// PURE (Godot-free, Exe-testable) alpha USED-RECT + transparent-HOLE scan for a decoded RGBA8 image. Extracted from
// TextureStore.RecordArtInfo (the occluder-tightening path) so the threshold + hole geometry are covered
// by the MirrorProtocol Exe suite without a Godot host.
//
// The occluder-tightening path bounds a textured blocker by the pixels it actually PAINTS: the used-rect (smallest
// box containing every painted pixel) tightens the blocker box, and a transparent HOLE (the largest full-width run of
// transparent ROWS, or full-height run of transparent COLUMNS) lets the planner clear a card/label that sits entirely
// inside the see-through middle of a scroll-edge fade scrim (a deck-dialog `BorderGradient` is a 2×256 vertical fade
// stretched over the whole 1920×1002 grid — opaque only at its extreme rows, transparent across the middle band).
//
// ALPHA THRESHOLD (WS-crisp2): a pixel counts as PAINTED only when alpha >= `alphaThreshold`. The pre-crisp2 scan used
// a strict alpha != 0 test (threshold 1); a GradientTexture2D fade that only APPROACHES 0 across its middle then never
// produced a hole. A <=3%-alpha (threshold 8/255) scrim region is visually imperceptible, so treating it as
// transparent lets a crisp clone render above it unchanged — safe — while the >=threshold fade band near the edges
// keeps its opaque status so edge cards/labels stay legitimately occluded (the scroll-fade look is preserved).
public static class ArtAlphaScan
{
    // The strict (pre-crisp2) alpha test: any non-zero alpha is painted. Passing this restores the exact old scan.
    public const int StrictThreshold = 1;

    // A texture-space pixel rect (matches Godot's Rect2I shape without depending on Godot).
    public readonly record struct PixelRect(int X, int Y, int Width, int Height)
    {
        public bool IsEmpty => Width <= 0 || Height <= 0;
    }

    // Scan a row-major RGBA8 buffer (`rgba.Length` must be >= width*height*4). A pixel is PAINTED iff its alpha byte
    // is >= `alphaThreshold` (clamped to >= 1). Returns:
    //   Used — the bounding box of every painted pixel (an empty rect at origin when nothing is painted), and
    //   Hole — the largest fully-transparent full-width ROW run (or full-height COLUMN run, whichever covers more
    //          area), or null when there is no transparent run. The hole is a strict SUBSET of the transparent region
    //          for the chosen orientation, so mapping it into the drawn frame never claims a painted pixel.
    public static (PixelRect Used, PixelRect? Hole) Scan(ReadOnlySpan<byte> rgba, int width, int height, int alphaThreshold)
    {
        if (width <= 0 || height <= 0 || (long)width * height * 4 > rgba.Length)
        {
            return (default, null);
        }

        int threshold = alphaThreshold < 1 ? 1 : alphaThreshold;
        int w = width, h = height;
        var rowAny = new bool[h];
        var colAny = new bool[w];
        for (int y = 0; y < h; y++)
        {
            int row = y * w * 4;
            for (int x = 0; x < w; x++)
            {
                if (rgba[row + (x * 4) + 3] >= threshold)
                {
                    rowAny[y] = true;
                    colAny[x] = true;
                }
            }
        }

        int minX = w, maxX = -1, minY = h, maxY = -1;
        for (int y = 0; y < h; y++)
        {
            if (rowAny[y]) { if (y < minY) { minY = y; } maxY = y; }
        }

        for (int x = 0; x < w; x++)
        {
            if (colAny[x]) { if (x < minX) { minX = x; } maxX = x; }
        }

        var used = maxY < 0 ? new PixelRect(0, 0, 0, 0) : new PixelRect(minX, minY, maxX - minX + 1, maxY - minY + 1);

        var (rs, rl) = LongestClearRun(rowAny);
        var (cs, cl) = LongestClearRun(colAny);
        long rowArea = (long)rl * w, colArea = (long)cl * h;
        PixelRect? hole = null;
        if (rl > 0 && rowArea >= colArea)
        {
            hole = new PixelRect(0, rs, w, rl);
        }
        else if (cl > 0)
        {
            hole = new PixelRect(cs, 0, cl, h);
        }

        return (used, hole);
    }

    // The longest contiguous run of FALSE entries (fully-transparent rows/columns) in `any`.
    private static (int Start, int Length) LongestClearRun(bool[] any)
    {
        int bestStart = 0, bestLen = 0, runStart = -1;
        for (int i = 0; i < any.Length; i++)
        {
            if (!any[i])
            {
                if (runStart < 0)
                {
                    runStart = i;
                }

                if (i - runStart + 1 > bestLen)
                {
                    bestLen = i - runStart + 1;
                    bestStart = runStart;
                }
            }
            else
            {
                runStart = -1;
            }
        }

        return (bestStart, bestLen);
    }
}
