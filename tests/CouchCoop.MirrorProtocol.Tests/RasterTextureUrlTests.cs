using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-PARTICLE: the pure raster-format policy for `.tres` particle/sampler textures. NeedsRasterFormat decides when
// a texture url must be fetched with the explicit raster ask (`?format=png`); For composes the qualified url with
// the `?`/`&` rule TextureStore.AstcUrl uses, so the astc suffix still appends cleanly afterwards.
internal static class RasterTextureUrlTests
{
    public static void Run()
    {
        NeedsRaster();
        NeedsNodeTextureRaster();
        ComposesUrl();
    }

    // The NODE-texture fetch path (MirrorNodeView.ResolveTexture) raster-qualifies a standalone `.tres` (the intent-
    // atlas class rendered as a node texture) but NEVER an embedded `::` sub-resource ref (the /res route can't crop
    // it independently → `?format=png` would just re-fail). Otherwise it mirrors NeedsRasterFormat.
    private static void NeedsNodeTextureRaster()
    {
        // The bug case: a standalone AtlasTexture `.tres` node texture → raster ask.
        Check.That(
            RasterTextureUrl.NeedsNodeTextureRaster("res://images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres"),
            "node-raster: standalone .tres node texture needs the raster format");
        Check.That(
            RasterTextureUrl.NeedsNodeTextureRaster("/res/images/atlases/intent_atlas.sprites/intent_defend.tres?x=1"),
            "node-raster: query-suffixed .tres still needs raster");

        // An embedded sub-resource ref is left on the raw path (host can't crop it as an independent atlas).
        Check.That(
            !RasterTextureUrl.NeedsNodeTextureRaster("res://scenes/combat/combat.tscn::SubResource_atlas7"),
            "node-raster: an embedded :: sub-resource ref is NOT raster-qualified");
        Check.That(
            !RasterTextureUrl.NeedsNodeTextureRaster("res://scenes/foo.tscn::AtlasTexture_abc?x=1"),
            "node-raster: a :: sub-resource ref stays raw even with a query");

        // Decodable images and null/empty behave exactly like NeedsRasterFormat (raw path).
        Check.That(!RasterTextureUrl.NeedsNodeTextureRaster("/res/images/cards/portrait.png"), "node-raster: png stays raw");
        Check.That(!RasterTextureUrl.NeedsNodeTextureRaster(null), "node-raster: null url never qualifies");
        Check.That(!RasterTextureUrl.NeedsNodeTextureRaster(""), "node-raster: empty url never qualifies");
    }

    private static void NeedsRaster()
    {
        // The bug case: AtlasTexture `.tres` particle textures (confirmed on the wire for IntentParticle nodes).
        Check.That(
            RasterTextureUrl.NeedsRasterFormat("/res/images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres"),
            "raster: .tres particle texture needs the raster format");
        Check.That(
            RasterTextureUrl.NeedsRasterFormat("res://images/atlases/intent_atlas.sprites/intent_defend.tres"),
            "raster: res:// form of a .tres path needs the raster format");

        // Decodable/raster-served image extensions never re-qualify (the raw route already serves raster bytes).
        Check.That(!RasterTextureUrl.NeedsRasterFormat("/res/images/vfx/common/common_glow.png"), "raster: png stays raw");
        Check.That(!RasterTextureUrl.NeedsRasterFormat("/res/images/vfx/light.WEBP"), "raster: webp (any case) stays raw");
        Check.That(!RasterTextureUrl.NeedsRasterFormat("/res/images/photo.jpg"), "raster: jpg stays raw");
        Check.That(!RasterTextureUrl.NeedsRasterFormat("/res/images/cards/card_frame_sdf.exr"), "raster: exr stays raw (Tex16 exemption path)");
        Check.That(!RasterTextureUrl.NeedsRasterFormat("/res/images/ui/icon.svg"), "raster: svg stays raw");

        // A query never hides the extension decision (matches Tex16Exempt's query-stripping rule).
        Check.That(!RasterTextureUrl.NeedsRasterFormat("/res/images/vfx/dot.png?fmt=astc"), "raster: query-suffixed png stays raw");
        Check.That(RasterTextureUrl.NeedsRasterFormat("/res/images/atlases/a.sprites/b.tres?x=1"), "raster: query-suffixed .tres still needs raster");

        // Null/empty → no qualification (ApplyTexture already early-returns on null).
        Check.That(!RasterTextureUrl.NeedsRasterFormat(null), "raster: null url never qualifies");
        Check.That(!RasterTextureUrl.NeedsRasterFormat(""), "raster: empty url never qualifies");
    }

    private static void ComposesUrl()
    {
        Check.Equal(
            RasterTextureUrl.For("/res/images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres"),
            "/res/images/atlases/intent_atlas.sprites/attack/intent_attack_3.tres?format=png",
            "raster: bare url gets ?format=png");
        Check.Equal(
            RasterTextureUrl.For("/res/images/atlases/a.tres?x=1"),
            "/res/images/atlases/a.tres?x=1&format=png",
            "raster: url with a query appends &format=png");
    }
}
