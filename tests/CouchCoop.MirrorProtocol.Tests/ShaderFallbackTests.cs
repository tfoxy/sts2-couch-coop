using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Pure-logic coverage for native screen-read shader handling and the SDF/ripple 16-bit exemption. ScreenReadShaders
// classifies framebuffer readers and supplies dark_blur's scrim alpha; Tex16Exempt keeps float `.exr` SDF pages at
// their required precision.
// All shader bodies are SYNTHETIC (hand-written) — no game content committed. The Godot-side wiring
// (ShaderStore/PaintGates/ShaderAttachment/Tex16Convert) delegates to exactly these functions, so covering them
// here is the Exe-runner analog of a paint-gate / packing test without a Godot host (the ShaderStaticRewrite
// precedent).
internal static class ShaderFallbackTests
{
    public static void Run()
    {
        ScreenReadClassification();
        DarkBlurMatch();
        ScrimAlphaMapping();
        Tex16FloatExemption();
    }

    // dark_blur-style sources (hint_screen_texture / SCREEN_TEXTURE) classify screen-read; card_ripple + hsv do NOT.
    private static void ScreenReadClassification()
    {
        const string darkBlur =
            "shader_type canvas_item;\n" +
            "uniform float lod: hint_range(0.0, 5.0) = 5.0;\n" +
            "uniform sampler2D SCREEN_TEXTURE : hint_screen_texture, filter_linear_mipmap;\n" +
            "uniform float mix_percentage: hint_range(0.0, 1.0) = 0.3;\n" +
            "void fragment(){ vec4 c = texture(SCREEN_TEXTURE, SCREEN_UV, lod); COLOR = mix(c, vec4(0,0,0,1), mix_percentage); }\n";
        Check.That(ScreenReadShaders.ReferencesScreenRead(darkBlur), "dark_blur (hint_screen_texture + SCREEN_TEXTURE) ⇒ screen-read");

        // Only the Godot-4 hint token.
        Check.That(ScreenReadShaders.ReferencesScreenRead(
            "shader_type canvas_item;\nuniform sampler2D scr : hint_screen_texture;\nvoid fragment(){ COLOR = texture(scr, SCREEN_UV); }\n"),
            "hint_screen_texture alone ⇒ screen-read");
        // Only the Godot-3 built-in name.
        Check.That(ScreenReadShaders.ReferencesScreenRead(
            "shader_type canvas_item;\nvoid fragment(){ COLOR = texture(SCREEN_TEXTURE, SCREEN_UV); }\n"),
            "SCREEN_TEXTURE alone ⇒ screen-read");

        const string cardRipple =
            "shader_type canvas_item;\nrender_mode blend_add;\n" +
            "uniform float ease; uniform float modulo_width; uniform float width; uniform float ripple_speed;\n" +
            "void fragment(){ float a = mod(TIME * ripple_speed + COLOR.a, modulo_width); COLOR.a = smoothstep(1.0-width, width+(1.0-width), a); }\n";
        Check.That(!ScreenReadShaders.ReferencesScreenRead(cardRipple), "card_ripple (TIME + COLOR.a, no screen read) ⇒ NOT screen-read");

        const string hsv =
            "shader_type canvas_item;\nuniform float hue; uniform float sat; uniform float val;\n" +
            "void fragment(){ vec4 c = texture(TEXTURE, UV); COLOR = c; }\n";
        Check.That(!ScreenReadShaders.ReferencesScreenRead(hsv), "hsv color transform ⇒ NOT screen-read");

        Check.That(!ScreenReadShaders.ReferencesScreenRead(null), "null source ⇒ NOT screen-read");
        Check.That(!ScreenReadShaders.ReferencesScreenRead(""), "empty source ⇒ NOT screen-read");
    }

    // Only dark_blur is matched for the flat-scrim approximation; other screen-read shaders paint nothing.
    private static void DarkBlurMatch()
    {
        Check.That(ScreenReadShaders.IsDarkBlur("res://shaders/dark_blur.gdshader"), "dark_blur path ⇒ IsDarkBlur");
        Check.That(!ScreenReadShaders.IsDarkBlur("res://shaders/overlay_blend.gdshader"), "overlay_blend ⇒ NOT dark_blur");
        Check.That(!ScreenReadShaders.IsDarkBlur("res://shaders/card_ripple.gdshader"), "card_ripple ⇒ NOT dark_blur");
        Check.That(!ScreenReadShaders.IsDarkBlur(null), "null shaderId ⇒ NOT dark_blur");
    }

    // dark_blur scrim opacity from the streamed uniforms: mix_percentage → alpha, default 0.3 when absent, 0 →
    // transparent, clamped to [0,1].
    private static void ScrimAlphaMapping()
    {
        Check.Close(ScreenReadShaders.ScrimAlpha(new[] { Num("mix_percentage", 0.5) }), 0.5, "mix_percentage 0.5 → 0.5");
        Check.Close(ScreenReadShaders.ScrimAlpha(new[] { Num("mix_percentage", 0.0) }), 0.0, "mix_percentage 0 → 0 (fully transparent)");
        Check.Close(ScreenReadShaders.ScrimAlpha(null), 0.3, "null params → shader default 0.3");
        Check.Close(ScreenReadShaders.ScrimAlpha(new[] { Num("lod", 5.0) }), 0.3, "no mix_percentage param → default 0.3");
        Check.Close(ScreenReadShaders.ScrimAlpha(new[] { Num("mix_percentage", 1.5) }), 1.0, "mix_percentage 1.5 → clamped 1.0");
        Check.Close(ScreenReadShaders.ScrimAlpha(new[] { Num("mix_percentage", -0.25) }), 0.0, "mix_percentage -0.25 → clamped 0.0");
        // The default constant matches the dark_blur.gdshader authored default.
        Check.Close(ScreenReadShaders.DefaultScrimAlpha, 0.3, "DefaultScrimAlpha == dark_blur authored default 0.3");
    }

    // Fix 2: a float `.exr` SOURCE page is exempt from 16-bit packing (stays RGBA8); ordinary art still packs. The
    // predicate ignores any `?query` and is case-insensitive; null/empty and non-.exr are not exempt.
    private static void Tex16FloatExemption()
    {
        Check.That(Tex16Exempt.IsFloatSourcePage("/res/images/packed/card_template/card_frame_sdf.exr"),
            "card_frame_sdf.exr request url ⇒ exempt (stays Rgba8)");
        Check.That(Tex16Exempt.IsFloatSourcePage("res://images/packed/card_template/card_frame_sdf.exr"),
            "res:// .exr source path ⇒ exempt");
        Check.That(Tex16Exempt.IsFloatSourcePage("/res/x.exr?fmt=astc"), ".exr with query string ⇒ exempt (query ignored)");
        Check.That(Tex16Exempt.IsFloatSourcePage("/res/x.EXR"), ".EXR (case-insensitive) ⇒ exempt");
        Check.That(!Tex16Exempt.IsFloatSourcePage("/res/images/atlas/cards_0.png"), "normal .png art ⇒ NOT exempt (still packs)");
        Check.That(!Tex16Exempt.IsFloatSourcePage("/res/frame.webp"), ".webp art ⇒ NOT exempt");
        Check.That(!Tex16Exempt.IsFloatSourcePage("/res/exr_named.png"), "'.exr' only in stem ⇒ NOT exempt");
        Check.That(!Tex16Exempt.IsFloatSourcePage(null), "null ⇒ NOT exempt");
        Check.That(!Tex16Exempt.IsFloatSourcePage(""), "empty ⇒ NOT exempt");
    }

    private static MirrorShaderParam Num(string name, double value) =>
        new(name, "number", value, null, null, null, null, null);
}
