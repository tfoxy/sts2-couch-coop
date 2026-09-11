using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-EMITTER unit coverage for ShaderResourceParser.ParseMaterialSamplers — the additive parse that re-derives a
// material `.tres`'s baked sampler sub-resources (CurveTexture→Curve, GradientTexture1D/2D→Gradient) so the native
// emitter can rebuild the sampler textures the shader reads (streamed as NULL SubResource refs on the wire). ALL
// bodies here are SYNTHETIC (hand-written to the real vfx_ring_polar / vfx_fire_flipbook / vfx_glow SHAPES, matching
// ShaderResourceParserTests' convention) so no game content is committed.
internal static class MaterialSamplerParserTests
{
    public static void Run()
    {
        RingPolarCurveSampler();
        FlipbookMixedSamplers();
        GlowGradientSampler();
        SubResourceOrderIndependent();
        NonTresBodiesAreEmpty();
        ExtImageSampler();
    }

    private static MaterialSampler Get(ParsedMaterialSamplers s, string subId)
    {
        Check.That(s.BySubId.TryGetValue(subId, out _), $"sampler '{subId}' present in [{string.Join(",", s.BySubId.Keys)}]");
        return s.BySubId[subId];
    }

    // vfx_ring_polar shape: a CurveTexture (explicit width=64) → an inner 2-point Curve carrying tangents in `_data`.
    private static void RingPolarCurveSampler()
    {
        const string body =
            "[gd_resource type=\"ShaderMaterial\" load_steps=4 format=3]\n\n" +
            "[ext_resource type=\"Shader\" path=\"res://shaders/vfx/common/vfx_ring_polar_shader.gdshader\" id=\"1_a\"]\n\n" +
            "[sub_resource type=\"Curve\" id=\"Curve_8q0jc\"]\n" +
            "_data = [Vector2(0, 0.499536), 0.0, 1.15666, 0, 0, Vector2(1, 1), 0.0, 0.0, 0, 0]\n" +
            "point_count = 2\n\n" +
            "[sub_resource type=\"CurveTexture\" id=\"CurveTexture_i84de\"]\n" +
            "width = 64\n" +
            "curve = SubResource(\"Curve_8q0jc\")\n\n" +
            "[resource]\n" +
            "shader = ExtResource(\"1_a\")\n" +
            "shader_parameter/erosion_curve = SubResource(\"CurveTexture_i84de\")\n" +
            "shader_parameter/erosion_offset = 0.1\n";
        var s = ShaderResourceParser.ParseMaterialSamplers(body);
        var curve = Get(s, "CurveTexture_i84de");
        Check.Equal(curve.Kind, MaterialSamplerKind.Curve, "ring_polar sampler is a Curve");
        Check.Equal(curve.Width, 64, "CurveTexture explicit width 64");
        Check.Close(curve.MinValue, 0.0, "curve default min 0");
        Check.Close(curve.MaxValue, 1.0, "curve default max 1");
        Check.That(curve.CurvePoints is { Count: 2 }, "two curve points");
        Check.Close(curve.CurvePoints![0].X, 0.0, "point0 x");
        Check.Close(curve.CurvePoints[0].Y, 0.499536, "point0 y");
        Check.Close(curve.CurvePoints[0].RightTangent, 1.15666, "point0 right tangent parsed (not flat)");
        Check.Close(curve.CurvePoints[1].X, 1.0, "point1 x");
        Check.Close(curve.CurvePoints[1].Y, 1.0, "point1 y");
    }

    // vfx_fire_flipbook shape: two CurveTextures (one default-width, one over a NEGATIVE-range `_limits` curve) +
    // a GradientTexture1D with use_hdr over an HDR-color Gradient.
    private static void FlipbookMixedSamplers()
    {
        const string body =
            "[gd_resource type=\"ShaderMaterial\" load_steps=8 format=3]\n\n" +
            "[ext_resource type=\"Shader\" path=\"res://shaders/vfx/common/vfx_flipbook_shader.gdshader\" id=\"1_m\"]\n\n" +
            "[sub_resource type=\"Curve\" id=\"Curve_ejie0\"]\n" +
            "_data = [Vector2(0, 0), 0.0, 1.6273886, 0, 0, Vector2(1, 1), 0.28151762, 0.0, 0, 0]\n" +
            "point_count = 2\n\n" +
            "[sub_resource type=\"CurveTexture\" id=\"CurveTexture_m4nbr\"]\n" +
            "curve = SubResource(\"Curve_ejie0\")\n\n" +
            "[sub_resource type=\"Curve\" id=\"Curve_fklqn\"]\n" +
            "_limits = [-0.1, 0.1, 0.0, 1.0]\n" +
            "_data = [Vector2(0, -0.07439024), 0.0, 0.0, 0, 0, Vector2(1, 0.07317073), 0.0, 0.0, 0, 0]\n" +
            "point_count = 2\n\n" +
            "[sub_resource type=\"CurveTexture\" id=\"CurveTexture_0qefg\"]\n" +
            "curve = SubResource(\"Curve_fklqn\")\n\n" +
            "[sub_resource type=\"Gradient\" id=\"Gradient_vpe4n\"]\n" +
            "offsets = PackedFloat32Array(0.56691, 0.759124)\n" +
            "colors = PackedColorArray(1, 1, 1, 1, 1.5, 1.5, 1.5, 1)\n\n" +
            "[sub_resource type=\"GradientTexture1D\" id=\"GradientTexture1D_dfb5y\"]\n" +
            "gradient = SubResource(\"Gradient_vpe4n\")\n" +
            "use_hdr = true\n\n" +
            "[resource]\n" +
            "shader = ExtResource(\"1_m\")\n" +
            "shader_parameter/lut = SubResource(\"GradientTexture1D_dfb5y\")\n" +
            "shader_parameter/flipbook_curve = SubResource(\"CurveTexture_m4nbr\")\n" +
            "shader_parameter/hue_shift_curve = SubResource(\"CurveTexture_0qefg\")\n";
        var s = ShaderResourceParser.ParseMaterialSamplers(body);

        var flip = Get(s, "CurveTexture_m4nbr");
        Check.Equal(flip.Width, 256, "flipbook curve default width 256 (no explicit width)");
        Check.Close(flip.CurvePoints![0].RightTangent, 1.6273886, "flipbook curve tangent");

        var hue = Get(s, "CurveTexture_0qefg");
        Check.Close(hue.MinValue, -0.1, "hue curve NEGATIVE min from _limits");
        Check.Close(hue.MaxValue, 0.1, "hue curve max from _limits");
        Check.Close(hue.CurvePoints![0].Y, -0.07439024, "hue curve negative y preserved");

        var lut = Get(s, "GradientTexture1D_dfb5y");
        Check.Equal(lut.Kind, MaterialSamplerKind.Gradient1D, "lut is Gradient1D");
        Check.That(lut.UseHdr, "lut use_hdr true");
        Check.That(lut.GradientStops is { Count: 2 }, "two gradient stops");
        Check.Close(lut.GradientStops![0].Offset, 0.56691, "stop0 offset");
        Check.Close(lut.GradientStops[1].Color[0], 1.5, "stop1 HDR red 1.5 preserved");
        Check.Close(lut.GradientStops[1].Color[3], 1.0, "stop1 alpha");
    }

    // vfx_glow shape: a single-stop Gradient → GradientTexture1D (no use_hdr).
    private static void GlowGradientSampler()
    {
        const string body =
            "[gd_resource type=\"ShaderMaterial\" load_steps=4 format=3]\n\n" +
            "[ext_resource type=\"Shader\" path=\"res://shaders/vfx/common/vfx_grayscale_particle_shader.gdshader\" id=\"1_r\"]\n\n" +
            "[sub_resource type=\"Gradient\" id=\"Gradient_rvmb5\"]\n" +
            "offsets = PackedFloat32Array(1)\n" +
            "colors = PackedColorArray(1, 1, 1, 1)\n\n" +
            "[sub_resource type=\"GradientTexture1D\" id=\"GradientTexture1D_4kh46\"]\n" +
            "gradient = SubResource(\"Gradient_rvmb5\")\n\n" +
            "[resource]\n" +
            "shader = ExtResource(\"1_r\")\n" +
            "shader_parameter/lut = SubResource(\"GradientTexture1D_4kh46\")\n";
        var s = ShaderResourceParser.ParseMaterialSamplers(body);
        var lut = Get(s, "GradientTexture1D_4kh46");
        Check.Equal(lut.Kind, MaterialSamplerKind.Gradient1D, "glow lut Gradient1D");
        Check.That(!lut.UseHdr, "glow lut no use_hdr");
        Check.That(lut.GradientStops is { Count: 1 }, "single stop");
        Check.Close(lut.GradientStops![0].Offset, 1.0, "single stop at offset 1");
    }

    // The referenced Curve/Gradient may appear AFTER its texture wrapper in the file — resolution is a 2nd pass.
    private static void SubResourceOrderIndependent()
    {
        const string body =
            "[gd_resource type=\"ShaderMaterial\" format=3]\n\n" +
            "[sub_resource type=\"CurveTexture\" id=\"CT\"]\n" +
            "width = 32\n" +
            "curve = SubResource(\"C\")\n\n" +
            "[sub_resource type=\"Curve\" id=\"C\"]\n" +
            "_data = [Vector2(0, 0.25), 0.0, 0.0, 0, 0, Vector2(1, 0.75), 0.0, 0.0, 0, 0]\n\n" +
            "[resource]\n" +
            "shader_parameter/x = SubResource(\"CT\")\n";
        var s = ShaderResourceParser.ParseMaterialSamplers(body);
        var ct = Get(s, "CT");
        Check.Equal(ct.Width, 32, "forward-referenced curve resolves (width)");
        Check.Close(ct.CurvePoints![1].Y, 0.75, "forward-referenced curve resolves (point)");
    }

    private static void NonTresBodiesAreEmpty()
    {
        Check.Equal(ShaderResourceParser.ParseMaterialSamplers("shader_type canvas_item;\n").BySubId.Count, 0,
            "raw shader → no samplers");
        Check.Equal(ShaderResourceParser.ParseMaterialSamplers("{ \"type\": \"ShaderMaterial\" }").BySubId.Count, 0,
            "json doc → no samplers (parse handles raw .tres only)");
        Check.Equal(ShaderResourceParser.ParseMaterialSamplers("").BySubId.Count, 0, "empty → no samplers");
    }

    // A plain ExtResource image sampler (not a CurveTexture/GradientTexture) — captured so the native side can fetch
    // it; a non-image ext (e.g. a Shader) is not a sampler and is ignored here.
    private static void ExtImageSampler()
    {
        // The ext-image path is recorded for resolution, but only a CurveTexture/GradientTexture SUB-resource keyed by
        // the `::` ref is materialized; a bare ext-image sampler default is handled on the streamed-param side, so
        // ParseMaterialSamplers itself simply must not crash on / misclassify it. Assert the CurveTexture still parses
        // alongside an ext image.
        const string body =
            "[gd_resource type=\"ShaderMaterial\" format=3]\n\n" +
            "[ext_resource type=\"Texture2D\" path=\"res://images/noise.png\" id=\"1_img\"]\n\n" +
            "[sub_resource type=\"Curve\" id=\"C\"]\n" +
            "_data = [Vector2(0, 0), 0.0, 0.0, 0, 0, Vector2(1, 1), 0.0, 0.0, 0, 0]\n\n" +
            "[sub_resource type=\"CurveTexture\" id=\"CT\"]\n" +
            "curve = SubResource(\"C\")\n\n" +
            "[resource]\n" +
            "shader_parameter/erosion_texture = ExtResource(\"1_img\")\n" +
            "shader_parameter/erosion_curve = SubResource(\"CT\")\n";
        var s = ShaderResourceParser.ParseMaterialSamplers(body);
        Check.That(s.BySubId.ContainsKey("CT"), "CurveTexture parsed alongside an ext image sampler");
        Check.That(!s.BySubId.ContainsKey("1_img"), "ext image is not emitted as a sub-resource sampler");
    }
}
