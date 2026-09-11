using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit coverage for the raw shader-resource parser. All bodies are synthetic so no game content is committed.
internal static class ShaderResourceParserTests
{
    public static void Run()
    {
        RawShaderSource();
        RawTresWithExtShaderAndDefaults();
        RawTresWithInlineSubShader();
        RawTresLiteralKinds();
        RawTresSkipsSubResourceSamplerDefault();
        SniffAndImageDetection();
        SubResourceShaderLookup();
    }

    private static MirrorShaderParam Find(ParsedShaderResource r, string name) =>
        r.Defaults.FirstOrDefault(p => p.Name == name)
            ?? throw new Exception($"default '{name}' not found in [{string.Join(",", r.Defaults.Select(d => d.Name))}]");

    // A bare `.gdshader` (or a host-resolved `.tres`-as-text, e.g. vfx_stepped_shader_fire_add.tres): compiled
    // verbatim, no material defaults (the source `= …` initializers ARE the defaults, applied by Godot).
    private static void RawShaderSource()
    {
        const string body = "shader_type canvas_item;\nrender_mode blend_add;\n\nuniform float width = 0.0;\n" +
                            "void fragment() { COLOR.a = width; }\n";
        var r = ShaderResourceParser.Parse(body);
        Check.Equal(r.Format, ShaderResourceFormat.RawShader, "raw shader → RawShader format");
        Check.Equal(r.ShaderCode, body, "raw shader → ShaderCode is the verbatim body");
        Check.That(r.ShaderExtPath is null, "raw shader → no ext path");
        Check.Equal(r.Defaults.Count, 0, "raw shader → no material defaults");
    }

    // `[gd_resource ShaderMaterial]` referencing an ExtResource Shader `.gdshader` + numeric defaults (the
    // fade_transition_mat.tres / energy_orb_dark.tres shape).
    private static void RawTresWithExtShaderAndDefaults()
    {
        const string body =
            "[gd_resource type=\"ShaderMaterial\" load_steps=2 format=3 uid=\"uid://c02rttrnpcdyu\"]\n\n" +
            "[ext_resource type=\"Shader\" uid=\"uid://c66\" path=\"res://shaders/hsv.gdshader\" id=\"1_gniyc\"]\n\n" +
            "[resource]\n" +
            "shader = ExtResource(\"1_gniyc\")\n" +
            "shader_parameter/h = 1.0\n" +
            "shader_parameter/s = 0.5\n" +
            "shader_parameter/v = 0.85\n";
        var r = ShaderResourceParser.Parse(body);
        Check.Equal(r.Format, ShaderResourceFormat.RawTres, "ext-shader tres → RawTres");
        Check.That(r.ShaderCode is null, "ext-shader tres → no inline code (needs 2nd fetch)");
        Check.Equal(r.ShaderExtPath, "res://shaders/hsv.gdshader", "ext-shader tres → follows the ExtResource path");
        Check.Equal(r.Defaults.Count, 3, "ext-shader tres → three numeric defaults");
        Check.Equal(Find(r, "h").Kind, "number", "h is a number");
        Check.Close(Find(r, "s").Number!.Value, 0.5, "s default 0.5");
        Check.Close(Find(r, "v").Number!.Value, 0.85, "v default 0.85");
    }

    // `[gd_resource]` with an INLINE `[sub_resource type="Shader"]` whose `code = "…"` spans multiple lines with
    // escapes (the defect_transition_mat.tres shape); the sampler ExtResource default resolves to an image path.
    private static void RawTresWithInlineSubShader()
    {
        const string body =
            "[gd_resource type=\"ShaderMaterial\" load_steps=3 format=3 uid=\"uid://dp66722ubmv5r\"]\n\n" +
            "[ext_resource type=\"Texture2D\" uid=\"uid://x\" path=\"res://images/ui/transition.png\" id=\"1_gwmkq\"]\n\n" +
            "[sub_resource type=\"Shader\" id=\"Shader_spnx5\"]\n" +
            "code = \"shader_type canvas_item;\n\n" +
            "uniform sampler2D transitionTex;\n" +
            "uniform float threshold : hint_range(0,1);\n\n" +
            "void fragment() {\n" +
            "    float falloff = 1.0 - texture(transitionTex, UV).r;\n" +
            "    COLOR.a = step(falloff, threshold);\n" +
            "}\n" +
            "\"\n\n" +
            "[resource]\n" +
            "resource_local_to_scene = true\n" +
            "shader = SubResource(\"Shader_spnx5\")\n" +
            "shader_parameter/threshold = 0.332\n" +
            "shader_parameter/transitionTex = ExtResource(\"1_gwmkq\")\n";
        var r = ShaderResourceParser.Parse(body);
        Check.Equal(r.Format, ShaderResourceFormat.RawTres, "inline-shader tres → RawTres");
        Check.That(r.ShaderExtPath is null, "inline-shader tres → no ext path");
        Check.That(r.ShaderCode is not null && r.ShaderCode.Contains("void fragment()"),
            "inline-shader tres → code captured");
        Check.That(r.ShaderCode!.StartsWith("shader_type canvas_item;"), "inline code starts at shader_type");
        Check.That(!r.ShaderCode.Contains('\\'), "inline code un-escaped (no stray backslashes)");
        Check.Close(Find(r, "threshold").Number!.Value, 0.332, "threshold default 0.332");
        Check.Equal(Find(r, "transitionTex").Kind, "resource", "sampler default is a resource");
        Check.Equal(Find(r, "transitionTex").ResourcePath, "res://images/ui/transition.png", "sampler → image path");
    }

    // Every Godot literal kind the default parser supports.
    private static void RawTresLiteralKinds()
    {
        const string body =
            "[gd_resource type=\"ShaderMaterial\" format=3]\n\n" +
            "[ext_resource type=\"Shader\" path=\"res://s.gdshader\" id=\"1\"]\n\n" +
            "[resource]\n" +
            "shader = ExtResource(\"1\")\n" +
            "shader_parameter/flag = true\n" +
            "shader_parameter/off = false\n" +
            "shader_parameter/step = Vector2(1, 0)\n" +
            "shader_parameter/dir = Vector3(0.1, 0.2, 0.3)\n" +
            "shader_parameter/quad = Vector4(0, 1, 0.67, 0)\n" +
            "shader_parameter/tint = Color(0.6175565, 0.11198568, 1, 1)\n" +
            "shader_parameter/box = Rect2(1, 2, 3, 4)\n" +
            "shader_parameter/xf = Transform2D(1, 0, 0, 1, 5, 6)\n" +
            "shader_parameter/label = \"hello\"\n" +
            "shader_parameter/radius = 32.0\n";
        var r = ShaderResourceParser.Parse(body);
        Check.Equal(Find(r, "flag").Bool, true, "bool true");
        Check.Equal(Find(r, "off").Bool, false, "bool false");
        Check.Close(Find(r, "step").Vector2!.X, 1, "vector2 x");
        Check.Close(Find(r, "step").Vector2!.Y, 0, "vector2 y");
        Check.Close(Find(r, "dir").Vector3!.Z, 0.3, "vector3 z");
        Check.Close(Find(r, "quad").Vector4!.Z, 0.67, "vector4 z");
        Check.Close(Find(r, "tint").Color!.R, 0.6175565, "color r");
        Check.Close(Find(r, "tint").Color!.A, 1, "color a");
        Check.Close(Find(r, "box").Rect2!.Width, 3, "rect2 width");
        Check.SequenceClose(Find(r, "xf").Transform2D, new double[] { 1, 0, 0, 1, 5, 6 }, "transform2d 6-tuple");
        Check.Equal(Find(r, "label").Kind, "string", "quoted default → string");
        Check.Equal(Find(r, "label").String, "hello", "string value");
        Check.Close(Find(r, "radius").Number!.Value, 32.0, "number 32.0");
    }

    // A SubResource sampler default (GradientTexture1D, …) can't be reconstructed client-side → skipped so the
    // shader's own default stays; the numeric sibling still parses.
    private static void RawTresSkipsSubResourceSamplerDefault()
    {
        const string body =
            "[gd_resource type=\"ShaderMaterial\" format=3]\n\n" +
            "[ext_resource type=\"Shader\" path=\"res://s.gdshader\" id=\"1\"]\n\n" +
            "[sub_resource type=\"GradientTexture1D\" id=\"Grad_1\"]\n\n" +
            "[resource]\n" +
            "shader = ExtResource(\"1\")\n" +
            "shader_parameter/lut = SubResource(\"Grad_1\")\n" +
            "shader_parameter/pivot_offset = Vector2(0, 0)\n";
        var r = ShaderResourceParser.Parse(body);
        Check.That(r.Defaults.All(d => d.Name != "lut"), "SubResource sampler default skipped");
        Check.That(r.Defaults.Any(d => d.Name == "pivot_offset"), "numeric sibling default kept");
    }

    private static void SniffAndImageDetection()
    {
        Check.Equal(ShaderResourceParser.Parse("  \n{}").Format, ShaderResourceFormat.RawShader, "non-resource text stays raw");
        Check.Equal(ShaderResourceParser.Parse("").Format, ShaderResourceFormat.Unknown, "empty → Unknown");
        Check.That(ShaderResourceParser.IsImagePath("res://x.PNG"), "case-insensitive image ext");
        Check.That(!ShaderResourceParser.IsImagePath("res://x.tres::Sub"), "sub-resource ref is not an image");
        Check.That(!ShaderResourceParser.IsImagePath("res://x.gdshader"), "gdshader is not an image");
    }

    // R6 P6-F1 — TryGetSubResourceShaderCode: the shader text of ONE named `[sub_resource type="Shader"]`.
    //
    // This is a different question from `Parse`, and the difference is the point. `Parse` answers what a MATERIAL
    // uses, so it follows the `[resource]` section's own `shader = SubResource(...)` reference and ignores every
    // other sub-resource. A `::`-qualified request already knows which block it wants — the scene tree streamed the
    // qualified id to the client — and the parent's `[resource]` section need not point at it at all. All bodies
    // below are SYNTHETIC.
    private static void SubResourceShaderLookup()
    {
        const string twoSubs =
            "[gd_resource type=\"ShaderMaterial\" load_steps=3 format=3]\n\n" +
            "[sub_resource type=\"Shader\" id=\"Shader_aaaaa\"]\n" +
            "code = \"shader_type canvas_item;\nuniform float a = 1.0;\nvoid fragment() { COLOR.a = a; }\n\"\n\n" +
            "[sub_resource type=\"Shader\" id=\"Shader_bbbbb\"]\n" +
            "code = \"shader_type canvas_item;\nuniform float b = 2.0;\nvoid fragment() { COLOR.a = b; }\n\"\n\n" +
            "[resource]\n" +
            "shader = SubResource(\"Shader_aaaaa\")\n";

        var first = ShaderResourceParser.TryGetSubResourceShaderCode(twoSubs, "Shader_aaaaa");
        Check.That(first is not null && first.Contains("uniform float a", StringComparison.Ordinal), "names the first sub-resource by id");
        // The one the material does NOT reference — which `Parse` would never return, and which is exactly what a
        // `::`-qualified request can ask for.
        var second = ShaderResourceParser.TryGetSubResourceShaderCode(twoSubs, "Shader_bbbbb");
        Check.That(second is not null && second.Contains("uniform float b", StringComparison.Ordinal), "names an unreferenced sub-resource too");
        Check.That(ShaderResourceParser.Parse(twoSubs).ShaderCode!.Contains("uniform float a", StringComparison.Ordinal), "Parse still follows the material's own reference");

        Check.That(ShaderResourceParser.TryGetSubResourceShaderCode(twoSubs, "Shader_zzzzz") is null, "unknown id → null");
        Check.That(ShaderResourceParser.TryGetSubResourceShaderCode(twoSubs, "") is null, "empty id → null");
        Check.That(ShaderResourceParser.TryGetSubResourceShaderCode("", "Shader_aaaaa") is null, "empty body → null");

        // Right id, wrong TYPE: a `::`-qualified ref can name a gradient or a curve, and those are not shader text.
        const string wrongType =
            "[gd_resource type=\"ShaderMaterial\" format=3]\n\n" +
            "[sub_resource type=\"Gradient\" id=\"Grad_1\"]\n" +
            "colors = PackedColorArray(0, 0, 0, 1, 1, 1, 1, 1)\n\n" +
            "[resource]\n";
        Check.That(ShaderResourceParser.TryGetSubResourceShaderCode(wrongType, "Grad_1") is null, "a non-Shader sub-resource → null");

        // A Shader block with no `code` property at all: present, and still nothing to serve.
        const string noCode =
            "[gd_resource type=\"ShaderMaterial\" format=3]\n\n" +
            "[sub_resource type=\"Shader\" id=\"Shader_empty\"]\n" +
            "resource_name = \"nothing\"\n\n" +
            "[resource]\n";
        Check.That(ShaderResourceParser.TryGetSubResourceShaderCode(noCode, "Shader_empty") is null, "a Shader sub-resource with no code → null");

        // THE SPLITTER'S TRAP, restated for this entry point: shader source legitimately contains lines that begin
        // with `[`, and only a splitter tracking the multi-line quoted value knows they are not section headers. A
        // naive line scan would truncate this body's code at the array index and answer with half a shader.
        const string bracketInside =
            "[gd_resource type=\"ShaderMaterial\" format=3]\n\n" +
            "[sub_resource type=\"Shader\" id=\"Shader_brk\"]\n" +
            "code = \"shader_type canvas_item;\nuniform float w[4];\nvoid fragment() {\n" +
            "[0] is not a section;\nCOLOR.a = w[0];\n}\n\"\n\n" +
            "[resource]\n" +
            "shader = SubResource(\"Shader_brk\")\n";
        var bracket = ShaderResourceParser.TryGetSubResourceShaderCode(bracketInside, "Shader_brk");
        Check.That(bracket is not null && bracket.Contains("COLOR.a = w[0];", StringComparison.Ordinal), "a `[`-leading line inside the code block does not split the section");
    }
}
