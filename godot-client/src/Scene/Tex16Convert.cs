// Track F1: convert a decoded page to a packed 16-bit format (RGB565 / RGBA4444) with an optional ordered-dither
// pre-pass. This runs ENTIRELY on the decode WORKER thread (called from TextureStore.DecodeImageOffThread /
// SpineClipStore.DecodeImage) — every op here (DetectAlpha, GenerateMipmaps-carry,
// GetData/SetData, Convert, plus the plain-managed dither loop) is self-contained thread-safe Image / byte work, the
// same class of op already proven off-thread by Track E. NO Godot logging, NO node access, NO GPU upload here.
//
// ── MIP ORDERING (verified against engine core/io/image.cpp, godot 4.5.1-stable) ──────────────────────────────────
// We MIPGEN ON RGBA8 FIRST, then Convert to the packed format. This order is both the higher-quality one AND the only
// one the engine permits for the alpha case:
//   • Image::generate_mipmaps() hard-fails on RGBA4444 (image.cpp:1933 "Cannot generate mipmaps from RGBA4444
//     format."), so convert-then-mipgen is IMPOSSIBLE whenever a page has alpha — mipgen must precede the convert.
//   • Image::convert() CARRIES ALL EXISTING MIPS THROUGH: it loops `get_mipmap_count()+1` levels (image.cpp:556) and
//     constructs the destination with the source's `mipmaps` flag (image.cpp:560/585), converting each level. RGBA8→
//     RGB565/RGBA4444 are format-INCOMPATIBLE (_are_formats_compatible, image.cpp:533 — packed 16-bit formats sit
//     above RGBA8 in the enum) so it takes the get_pixel/set_pixel path, but that path ALSO iterates every mip level.
// So the caller's existing `GenerateMipmaps()` (on the decoded RGBA8) stays put and this Convert preserves the whole
// chain — the deferred main-thread CreateFromImage upload just carries the mips it already has. Only mip 0 is
// dithered; the minified mips convert undithered (dithering a downsampled level fights the averaging that already
// removed the banding — see the dither note below).
//
// ── DITHER (ordered Bayer 4×4, base level only) ───────────────────────────────────────────────────────────────────
// RGBA4444's 4-bit channels band hard on gradient-heavy card art. Before the Convert we run an ordered-dither pass in
// plain C# over the raw RGBA8 base-level bytes. Engine set_pixel quantizes packed formats by TRUNCATION
// (`uint16_t(CLAMP(c*L, 0, L))`, image.cpp:3289/3299), so we pre-bias each channel byte to the CENTRE of its target
// quantization bucket for the dithered level `n` — floor() then recovers exactly `n`, making the displayed result a
// clean ordered-dithered image independent of engine rounding edges. Per-cell/per-value output is a precomputed LUT
// (16 bayer cells × 256 input bytes) so the hot loop is a table lookup, not float math.

using Godot;

namespace CouchCoop.GodotClient.Scene;

public static class Tex16Convert
{
    // Bayer 4×4 ordered-dither matrix (row-major, values 0..15). Cell for pixel (x,y) = ((y&3)<<2)|(x&3).
    private static readonly int[] Bayer =
    {
        0, 8, 2, 10,
        12, 4, 14, 6,
        3, 11, 1, 9,
        15, 7, 13, 5,
    };

    // Per-bit-depth dither LUTs, indexed [(cell << 8) | inputByte] → output RGBA8 byte (bucket-centre for the dithered
    // level). L15 = RGBA4444's 4-bit channels; L31 / L63 = RGB565's 5/6/5 channels. Built once at type init.
    private static readonly byte[] Lut15 = BuildLut(15);
    private static readonly byte[] Lut31 = BuildLut(31);
    private static readonly byte[] Lut63 = BuildLut(63);

    // Convert `img` (a decoded page, possibly already mipmapped on RGBA8) IN PLACE to a packed 16-bit format. No-op
    // when the image is empty / already packed 16-bit, or `sourceRel` names a float `.exr` page. Safe to call off the main thread. `sourceRel` is the page's
    // request url / source path (null for callers with no path, e.g. spine frames — never `.exr`).
    public static void ToPacked16(Image img, string? sourceRel = null)
    {
        // WS-SHADER SDF exemption: a float `.exr` page's alpha is a semantic SDF a card_ripple / SDF shader reads via
        // COLOR.a — RGBA4444's 4-bit alpha + Bayer dither would collapse the smooth SDF into dot patterns. Never pack
        // it; ordinary 8-bit art still packs.
        if (CouchCoop.MirrorProtocol.SceneModel.Tex16Exempt.IsFloatSourcePage(sourceRel))
        {
            return;
        }

        if (img.IsEmpty() || img.GetWidth() == 0 || img.GetHeight() == 0)
        {
            return;
        }

        Image.Format fmt = img.GetFormat();
        if (fmt == Image.Format.Rgba4444 || fmt == Image.Format.Rgb565)
        {
            return; // already packed (defensive — a decode never yields these)
        }

        // Decide the target from the SOURCE art's alpha (cheap worker-side scan): opaque → RGB565 (drops the unused
        // alpha channel), any alpha (Bit or Blend) → RGBA4444.
        bool hasAlpha = img.DetectAlpha() != Image.AlphaMode.None;
        Image.Format target = hasAlpha ? Image.Format.Rgba4444 : Image.Format.Rgb565;

        {
            // Dither the base level in RGBA8 space. Normalise a non-RGBA8 decode (e.g. an alpha-less PNG decoded to
            // RGB8) to RGBA8 first — a format-COMPATIBLE convert that preserves any mip chain (image.cpp:558-582).
            if (img.GetFormat() != Image.Format.Rgba8)
            {
                img.Convert(Image.Format.Rgba8);
            }

            DitherBaseLevelRgba8(img, hasAlpha);
        }

        img.Convert(target); // carries every mip level through (see MIP ORDERING above)
    }

    // Ordered-dither the base (mip 0) level of an RGBA8 image in place. Mips (bytes beyond w*h*4) are left untouched —
    // they convert undithered. `hasAlpha` selects the channel bit-depths: RGBA4444 dithers R,G,B,A all at 4 bits;
    // RGB565 dithers R,B at 5 bits and G at 6 bits and leaves the (to-be-dropped) alpha byte alone.
    private static void DitherBaseLevelRgba8(Image img, bool hasAlpha)
    {
        int w = img.GetWidth();
        int h = img.GetHeight();
        byte[] data = img.GetData(); // marshalled COPY (full buffer incl. mips) — must SetData back after mutating
        long baseBytes = (long)w * h * 4;
        if (data.Length < baseBytes)
        {
            return; // defensive: unexpected layout — skip dither, plain Convert still runs
        }

        if (hasAlpha)
        {
            // RGBA4444: all four channels quantize to 4 bits (Lut15).
            for (int y = 0; y < h; y++)
            {
                int cellRow = (y & 3) << 2;
                long row = (long)y * w * 4;
                for (int x = 0; x < w; x++)
                {
                    int cellBase = (cellRow | (x & 3)) << 8;
                    long o = row + ((long)x << 2);
                    data[o] = Lut15[cellBase | data[o]];
                    data[o + 1] = Lut15[cellBase | data[o + 1]];
                    data[o + 2] = Lut15[cellBase | data[o + 2]];
                    data[o + 3] = Lut15[cellBase | data[o + 3]];
                }
            }
        }
        else
        {
            // RGB565: R,B → 5 bits (Lut31), G → 6 bits (Lut63); alpha byte untouched (dropped by the convert).
            for (int y = 0; y < h; y++)
            {
                int cellRow = (y & 3) << 2;
                long row = (long)y * w * 4;
                for (int x = 0; x < w; x++)
                {
                    int cellBase = (cellRow | (x & 3)) << 8;
                    long o = row + ((long)x << 2);
                    data[o] = Lut31[cellBase | data[o]];
                    data[o + 1] = Lut63[cellBase | data[o + 1]];
                    data[o + 2] = Lut31[cellBase | data[o + 2]];
                }
            }
        }

        img.SetData(w, h, img.HasMipmaps(), Image.Format.Rgba8, data);
    }

    // Build the dither LUT for a channel quantized to `levels`+1 buckets (levels = 15/31/63). For input byte v and
    // bayer cell c: pick the ordered-dither level n = floor(f + 1 - d) where f = v/255*levels and d = (bayer+0.5)/16 ∈
    // (0,1) (round UP iff the fractional part ≥ d — spatially unbiased so the tile mean ≈ f), then emit the RGBA8 byte
    // at the CENTRE of level n's bucket so the engine's truncating quantize (floor(byte/255*levels)) recovers n.
    private static byte[] BuildLut(int levels)
    {
        var lut = new byte[16 * 256];
        for (int cell = 0; cell < 16; cell++)
        {
            double d = (Bayer[cell] + 0.5) / 16.0;
            int cellBase = cell << 8;
            for (int v = 0; v < 256; v++)
            {
                double f = v / 255.0 * levels;
                int n = (int)System.Math.Floor(f + 1.0 - d);
                if (n < 0)
                {
                    n = 0;
                }
                else if (n > levels)
                {
                    n = levels;
                }

                int outv = (int)System.Math.Round((n + 0.5) * 255.0 / levels);
                if (outv < 0)
                {
                    outv = 0;
                }
                else if (outv > 255)
                {
                    outv = 255;
                }

                lut[cellBase | v] = (byte)outv;
            }
        }

        return lut;
    }
}
