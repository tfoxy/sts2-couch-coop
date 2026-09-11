using System;

namespace CouchCoop.MirrorProtocol.SceneModel;

// PURE (Godot-free) helper for the WS-PARTICLE `.tres` texture fix (kill switch COUCHCOOP_MIRROR_PARTICLE_TEXFIX,
// read on the Godot side — this class is policy only, so the Exe suite covers it without a Godot host).
//
// THE BUG: particle textures (and shader sampler defaults) can reference an AtlasTexture `.tres`
// (res://images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres). The mirror wire maps that to the raw
// `/res/...` route, which Godot-native-first serves as the `.tres` TEXT (`[gd_resource ...`). TextureStore's codec
// sniff only decodes PNG/WEBP → permanent decode fail → the emitter never receives a texture → Godot draws its
// DEFAULT UNTEXTURED QUADS (glitchy white/colored squares; Static mode freezes them into a solid square).
//
// THE FIX: when a texture url's path is NOT a decodable raster image, ask the host to RASTERIZE it by qualifying
// the request with `?format=png` — the `/res` route then routes an AtlasTexture `.tres` through spirectl's
// cropped-region PNG extraction (the same resolver raster requests already use). The query param makes it a
// DISTINCT TextureStore/disk-cache key (the `?fmt=astc` pattern), so raw and raster variants never collide.
public static class RasterTextureUrl
{
    // Extensions the raw `/res` route already serves as raster bytes the client can decode. Matches
    // ShaderResourceParser.ImageExtensions (image SOURCE paths): even the exotic ones (.svg/.exr/.ktx/.bmp/.tga)
    // are re-encoded to PNG by spirectl's raw texture extraction, so only NON-image paths (`.tres`, …) need the
    // explicit raster ask.
    public static bool NeedsRasterFormat(string? url)
    {
        if (string.IsNullOrEmpty(url))
        {
            return false;
        }

        var path = url;
        int q = path.IndexOf('?');
        if (q >= 0)
        {
            path = path.Substring(0, q);
        }

        return !ShaderResourceParser.IsImagePath(path);
    }

    // The NODE-texture fetch path (MirrorNodeView.ResolveTexture) needs the raster ask for the SAME intent-atlas
    // `.tres` class — a Sprite2D/TextureRect whose texture is a standalone AtlasTexture `.tres` served by the /res
    // route as `.tres` TEXT that TextureStore's codec sniff can't decode. But unlike a particle/shader sampler ref,
    // a node texture can also be an EMBEDDED sub-resource ref (`res://foo.tscn::SubResource_x`): the host's /res
    // route can't crop that as an independent atlas (it lives inside a parent doc), so `?format=png` on it would
    // just re-fail — leave those on the raw path. So: raster-qualify only a non-image resource that is NOT a `::`
    // sub-resource ref. (Callers still gate on their own kill switch.)
    public static bool NeedsNodeTextureRaster(string? url)
        => NeedsRasterFormat(url) && url!.IndexOf("::", StringComparison.Ordinal) < 0;

    // The raster-qualified fetch url: append `format=png` with `?`/`&` per the existing query state (the same
    // composition rule as TextureStore.AstcUrl, so `?format=png&fmt=astc` remains well-formed).
    public static string For(string url)
        => url + (url.Contains('?') ? "&format=png" : "?format=png");
}
