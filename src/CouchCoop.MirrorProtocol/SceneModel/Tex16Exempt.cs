using System;

namespace CouchCoop.MirrorProtocol.SceneModel;

// PURE (Godot-free) predicate for the 16-bit texture-packing exemption. Float `.exr` source pages carry semantic
// precision: a card_ripple / SDF
// shader reads their smooth alpha via COLOR.a, and RGBA4444's 4-bit alpha + Bayer 4x4 dither collapses that SDF
// into dot patterns (the "ripple renders as Bayer dots" bug — card_frame_sdf.exr). So a page whose SOURCE resource
// path is a float `.exr` is never packed to 16-bit; ordinary 8-bit art (.png/.webp) still packs (the real
// texture-fetch perf lever is intact). Kept here (not the Godot Tex16Convert, which type-loads Godot) so the Exe
// suite covers the rule without a Godot host.
public static class Tex16Exempt
{
    // True when the page's source resource path / request url is a float `.exr` (case-insensitive; any `?query` is
    // ignored). Null/empty → not exempt (normal packing). The mirror wire preserves the `.exr` extension end-to-end
    // (res://images/.../card_frame_sdf.exr → /res/images/.../card_frame_sdf.exr), so the request url suffices.
    public static bool IsFloatSourcePage(string? sourcePathOrUrl)
    {
        if (string.IsNullOrEmpty(sourcePathOrUrl))
        {
            return false;
        }

        var s = sourcePathOrUrl;
        int q = s.IndexOf('?');
        if (q >= 0)
        {
            s = s.Substring(0, q);
        }

        return s.EndsWith(".exr", StringComparison.OrdinalIgnoreCase);
    }
}
