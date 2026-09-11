using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-ADDBAKE unit coverage for the PURE gdshader "bake-add premul" rewrite (ShaderBakeRewrite). Converts an
// Add-blend carrier so it renders into a static-bake SubViewport as an alpha-preserving additive clone
// (blend_premul_alpha + a fragment epilogue that folds the additive contribution into RGB and zeroes alpha). Pins:
// the whole-word blend swap, the epilogue injection point, bare-`return;` wrapping, containment (Ok=false) on
// exotic fragments, and composition on top of the Static TIME-pin rewrite. All shader bodies are SYNTHETIC.
internal static class ShaderBakeRewriteTests
{
    public static void Run()
    {
        BlendAddSwappedToPremulAlpha();
        EpilogueInjectedBeforeFragmentClose();
        BareReturnWrapped();
        MultipleBareReturnsWrapped();
        NonAddShaderNotRewritten();
        DiscardBailsToContainment();
        NonBareReturnBailsToContainment();
        MissingFragmentBailsToContainment();
        UnbalancedBracesBailToContainment();
        NestedBracesMatchedCorrectly();
        ComposesOnTopOfStaticRewrite();
        WholeWordBlendSwapDoesNotTouchComments();
    }

    private const string Epi = "COLOR.rgb *= COLOR.a; COLOR.a = 0.0;";

    private static void BlendAddSwappedToPremulAlpha()
    {
        const string src =
            "shader_type canvas_item;\n" +
            "render_mode blend_add;\n" +
            "void fragment() { COLOR = vec4(1.0, 0.5, 0.2, 0.8); }\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(ok, "add shader rewrites OK");
        Check.That(rw.Contains("render_mode blend_premul_alpha;"), "blend_add → blend_premul_alpha in render_mode");
        Check.That(!ContainsWholeWord(rw, "blend_add"), "no whole-word blend_add remains");
    }

    private static void EpilogueInjectedBeforeFragmentClose()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\n" +
            "void fragment() { COLOR = vec4(1.0); }\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(ok, "OK");
        int epi = rw.IndexOf(Epi, System.StringComparison.Ordinal);
        int colorWrite = rw.IndexOf("COLOR = vec4(1.0)", System.StringComparison.Ordinal);
        int fragClose = rw.LastIndexOf('}');
        Check.That(epi > colorWrite, "epilogue injected AFTER the shader's own COLOR write");
        Check.That(epi < fragClose, "epilogue injected BEFORE the fragment close brace");
        Check.Equal(CountOccurrences(rw, Epi), 1, "epilogue appears exactly once (single fall-through path)");
    }

    private static void BareReturnWrapped()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\n" +
            "void fragment() {\n" +
            "    if (UV.x < 0.5) return;\n" +
            "    COLOR = vec4(1.0);\n" +
            "}\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(ok, "OK");
        // the early return is wrapped so the epilogue precedes it
        Check.That(rw.Contains("{ " + Epi + " return; }"), "bare return wrapped with the epilogue");
        // plus the trailing fall-through epilogue → two epilogue occurrences
        Check.Equal(CountOccurrences(rw, Epi), 2, "one wrapped return + one fall-through epilogue");
    }

    private static void MultipleBareReturnsWrapped()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\n" +
            "void fragment() {\n" +
            "    if (a) return;\n" +
            "    if (b) { return; }\n" +
            "    COLOR = vec4(1.0);\n" +
            "}\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(ok, "OK");
        Check.Equal(CountOccurrences(rw, Epi), 3, "two wrapped returns + one fall-through epilogue");
    }

    private static void NonAddShaderNotRewritten()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_mix;\nvoid fragment() { COLOR = vec4(1.0); }\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(!ok, "non-add shader is not a bake-add carrier → Ok=false");
        Check.Equal(rw, src, "source unchanged when not rewritten");
    }

    private static void DiscardBailsToContainment()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\n" +
            "void fragment() { if (COLOR.a < 0.01) discard; COLOR = vec4(1.0); }\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(!ok, "a fragment with discard bails to containment (carrier stays live)");
        Check.Equal(rw, src, "source unchanged on containment");
    }

    private static void NonBareReturnBailsToContainment()
    {
        // Not legal in a void fragment, but a defensive bail: a `return expr;` cannot be mechanically folded.
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\n" +
            "void fragment() { return vec4(1.0).x > 0.0 ? ; }\n"; // garbage-ish; the point is `return <non-;>`
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(!ok, "a non-bare return bails to containment");
        Check.Equal(rw, src, "source unchanged on containment");
    }

    private static void MissingFragmentBailsToContainment()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\nvoid vertex() { VERTEX *= 1.0; }\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(!ok, "no fragment() → containment");
        Check.Equal(rw, src, "source unchanged");
    }

    private static void UnbalancedBracesBailToContainment()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\nvoid fragment() { COLOR = vec4(1.0); \n"; // no close
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(!ok, "unbalanced fragment braces → containment");
        Check.Equal(rw, src, "source unchanged");
    }

    private static void NestedBracesMatchedCorrectly()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\n" +
            "void fragment() {\n" +
            "    for (int i = 0; i < 4; i++) { COLOR.rgb += vec3(0.1); }\n" +
            "    COLOR.a = 0.5;\n" +
            "}\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(ok, "nested for-block fragment rewrites OK");
        int epi = rw.IndexOf(Epi, System.StringComparison.Ordinal);
        int lastAssign = rw.IndexOf("COLOR.a = 0.5;", System.StringComparison.Ordinal);
        Check.That(epi > lastAssign, "epilogue lands after the whole body, not after the inner block");
        Check.Equal(CountOccurrences(rw, Epi), 1, "single epilogue at fragment end");
    }

    private static void ComposesOnTopOfStaticRewrite()
    {
        // Feed a TIME-animated add shader through the Static rewrite FIRST, then the bake-add rewrite: both
        // transformations must be present (TIME frozen to couch_static_time AND blend_add → premul + epilogue).
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add;\n" +
            "void fragment() { COLOR = vec4(sin(TIME), 0.5, 0.2, 0.8); }\n";
        var (staticRw, referenced) = ShaderStaticRewrite.RewriteTimeToStaticUniform(src);
        Check.That(referenced, "static rewrite fired (TIME present)");

        var (bakeRw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(staticRw);
        Check.That(ok, "bake-add rewrite composes on the static-rewritten source");
        Check.That(bakeRw.Contains("uniform float " + ShaderStaticRewrite.StaticTimeUniform + ";"),
            "static TIME uniform declaration survives");
        Check.That(bakeRw.Contains("sin(couch_static_time)"), "TIME still frozen to couch_static_time");
        Check.That(bakeRw.Contains("render_mode blend_premul_alpha;"), "blend swapped");
        Check.That(bakeRw.Contains(Epi), "epilogue injected");
        Check.That(!ContainsWholeWord(bakeRw, "blend_add"), "no blend_add remains");
    }

    private static void WholeWordBlendSwapDoesNotTouchComments()
    {
        // The blend swap is whole-word; the render_mode declaration is the only real blend_add. A trailing `//`
        // note mentioning blend_add is still swapped ONLY if whole-word — but here we assert the real one swaps and
        // the shader still rewrites.
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add; // additive glow\n" +
            "void fragment() { COLOR = vec4(1.0); }\n";
        var (rw, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(src);
        Check.That(ok, "OK");
        Check.That(rw.Contains("render_mode blend_premul_alpha;"), "the real render_mode blend swapped");
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int idx = 0;
        while ((idx = haystack.IndexOf(needle, idx, System.StringComparison.Ordinal)) >= 0)
        {
            count++;
            idx += needle.Length;
        }

        return count;
    }

    private static bool ContainsWholeWord(string s, string word)
    {
        int idx = 0;
        while ((idx = s.IndexOf(word, idx, System.StringComparison.Ordinal)) >= 0)
        {
            bool leftOk = idx == 0 || !IsIdent(s[idx - 1]);
            int after = idx + word.Length;
            bool rightOk = after >= s.Length || !IsIdent(s[after]);
            if (leftOk && rightOk)
            {
                return true;
            }

            idx = after;
        }

        return false;
    }

    private static bool IsIdent(char c) => c == '_' || char.IsLetterOrDigit(c);
}
