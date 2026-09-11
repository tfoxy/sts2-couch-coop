// WS-ADDBAKE: the ONE immutable ShaderMaterial that renders a PLAIN-Add painter into a static-bake region viewport as
// an "alpha-preserving additive clone". A plain Add painter (CanvasBlendMode == 1, no shader) that bakes into a region
// must NOT render with Godot's canvas Add blend (which writes src.alpha into the transparent bake target, so the
// region's premult-over composite would OCCLUDE live content below instead of ADDING). Instead the clone renders with
// `blend_premul_alpha` + a fragment epilogue that folds the additive contribution into RGB and zeroes alpha:
//
//     COLOR *= texture(TEXTURE, UV);   // fold the base art (a plain fill's TEXTURE is the 1x1 white default → no-op)
//     COLOR.rgb *= COLOR.a;   COLOR.a = 0.0;
//
// Under PMALPHA (src ONE, dst 1-SRC_ALPHA) that accumulates (rgb*a, 0) into the bake target WITHOUT touching dst
// alpha; an add-only region texel is (rgb, 0), and its premult-over composite onto the stage IS a true add — exactly
// blend_add's src.rgb*src.a contribution (the micro-leg proved the identity to RGBA8 rounding). The per-SHADER Add
// carriers use ShaderBakeRewrite instead (their own fragment folded); this material is only for plain-Add painters.
//
// ONE shared immutable instance (like BlendMaterials) — MaterialResolver hands it to every static-bake Add clone.

using Godot;

namespace CouchCoop.GodotClient.Scene;

public static class BakeAddMaterials
{
    private const string VariantCode =
        "shader_type canvas_item;\n" +
        "render_mode blend_premul_alpha;\n" +
        "void fragment() {\n" +
        "    COLOR *= texture(TEXTURE, UV);\n" +
        "    COLOR.rgb *= COLOR.a;\n" +
        "    COLOR.a = 0.0;\n" +
        "}\n";

    private static ShaderMaterial? _variant;

    // The shared alpha-preserving additive variant material (built once, never mutated). Main-thread only.
    public static ShaderMaterial Variant
    {
        get
        {
            if (_variant is null || !GodotObject.IsInstanceValid(_variant))
            {
                _variant = new ShaderMaterial { Shader = new Shader { Code = VariantCode } };
            }

            return _variant;
        }
    }
}
