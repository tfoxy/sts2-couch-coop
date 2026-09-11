using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-EFFECTS-NATIVE unit coverage for the PURE gdshader "Static" rewrite (ShaderStaticRewrite). Freezing an effect
// on the native client swaps the live built-in TIME for a client-pinned `couch_static_time` uniform; this suite
// pins the word-boundary rule (whole-word TIME only), the uniform injection point, and the no-TIME "skip" signal.
// All shader bodies are SYNTHETIC (hand-written) — no game content committed.
internal static class ShaderStaticRewriteTests
{
    public static void Run()
    {
        WholeWordTimeReplaced();
        NonWholeWordTokensUntouched();
        NoTimeSourceUnchangedAndSkips();
        UniformInjectedAfterRenderMode();
        UniformInjectedAfterShaderTypeWhenNoRenderMode();
        EmptySourceSkips();
        MultipleTimesAllReplaced();
    }

    // A shader referencing whole-word TIME → every occurrence becomes couch_static_time, the built-in is gone, and the
    // uniform is declared exactly once.
    private static void WholeWordTimeReplaced()
    {
        const string src =
            "shader_type canvas_item;\n" +
            "render_mode blend_add;\n\n" +
            "void fragment() {\n" +
            "    COLOR.rgb *= sin(TIME);\n" +
            "}\n";
        var (rewritten, referenced) = ShaderStaticRewrite.RewriteTimeToStaticUniform(src);

        Check.That(referenced, "whole-word TIME → ReferencedTime true");
        Check.That(rewritten.Contains("sin(couch_static_time)"), "TIME token replaced with couch_static_time");
        Check.That(!ContainsWholeWord(rewritten, "TIME"), "no whole-word TIME remains after rewrite");
        Check.Equal(CountOccurrences(rewritten, "uniform float couch_static_time;"), 1, "uniform declared exactly once");
    }

    // TIMER / ATIME / LIFETIME / TIME_SCALE embed the letters TIME but are NOT whole words — left untouched.
    private static void NonWholeWordTokensUntouched()
    {
        const string src =
            "shader_type canvas_item;\n" +
            "uniform float TIMER;\n" +          // trailing ident char R
            "uniform float ATIME;\n" +          // leading ident char A
            "uniform float LIFETIME;\n" +       // leading ident chars LIFE
            "uniform float TIME_SCALE;\n" +     // trailing ident char _
            "void fragment() {\n" +
            "    COLOR.a = TIMER + ATIME + LIFETIME + TIME_SCALE;\n" +
            "}\n";
        var (rewritten, referenced) = ShaderStaticRewrite.RewriteTimeToStaticUniform(src);

        Check.That(!referenced, "no whole-word TIME (only TIMER/ATIME/LIFETIME/TIME_SCALE) → ReferencedTime false");
        Check.Equal(rewritten, src, "source with only non-whole-word TIME substrings is returned unchanged");
        Check.That(rewritten.Contains("TIMER") && rewritten.Contains("ATIME") &&
                   rewritten.Contains("LIFETIME") && rewritten.Contains("TIME_SCALE"),
            "TIMER/ATIME/LIFETIME/TIME_SCALE all preserved verbatim");
        Check.That(!rewritten.Contains("couch_static_time"), "no uniform injected when nothing was replaced");
    }

    // A shader that never references TIME at all → skip (static ≡ dynamic), unchanged source.
    private static void NoTimeSourceUnchangedAndSkips()
    {
        const string src =
            "shader_type canvas_item;\n" +
            "uniform sampler2D tex;\n" +
            "void fragment() { COLOR = texture(tex, UV); }\n";
        var (rewritten, referenced) = ShaderStaticRewrite.RewriteTimeToStaticUniform(src);

        Check.That(!referenced, "no TIME → ReferencedTime false (skip static variant)");
        Check.Equal(rewritten, src, "no-TIME source unchanged");
    }

    // Injection must sit AFTER render_mode (Godot requires render_mode directly after shader_type).
    private static void UniformInjectedAfterRenderMode()
    {
        const string src =
            "shader_type canvas_item;\nrender_mode blend_add, unshaded;\nvoid fragment(){ COLOR.a = TIME; }\n";
        var (rewritten, referenced) = ShaderStaticRewrite.RewriteTimeToStaticUniform(src);

        Check.That(referenced, "referenced");
        int rm = rewritten.IndexOf("render_mode", System.StringComparison.Ordinal);
        int decl = rewritten.IndexOf("uniform float couch_static_time;", System.StringComparison.Ordinal);
        int frag = rewritten.IndexOf("void fragment", System.StringComparison.Ordinal);
        Check.That(rm >= 0 && decl > rm, "uniform declared after render_mode");
        Check.That(decl < frag, "uniform declared before the fragment function (a legal global-scope position)");
    }

    // No render_mode → inject right after shader_type;.
    private static void UniformInjectedAfterShaderTypeWhenNoRenderMode()
    {
        const string src = "shader_type canvas_item;\nvoid fragment(){ COLOR.a = TIME; }\n";
        var (rewritten, _) = ShaderStaticRewrite.RewriteTimeToStaticUniform(src);

        int st = rewritten.IndexOf("shader_type canvas_item;", System.StringComparison.Ordinal);
        int decl = rewritten.IndexOf("uniform float couch_static_time;", System.StringComparison.Ordinal);
        int frag = rewritten.IndexOf("void fragment", System.StringComparison.Ordinal);
        Check.That(st == 0 && decl > st, "uniform declared after shader_type");
        Check.That(decl < frag, "uniform declared before the first function");
    }

    private static void EmptySourceSkips()
    {
        var (rewritten, referenced) = ShaderStaticRewrite.RewriteTimeToStaticUniform("");
        Check.That(!referenced, "empty source → not referenced");
        Check.Equal(rewritten, "", "empty source unchanged");
    }

    private static void MultipleTimesAllReplaced()
    {
        const string src =
            "shader_type canvas_item;\nvoid fragment(){ COLOR.r = sin(TIME); COLOR.g = cos(TIME*2.0); }\n";
        var (rewritten, referenced) = ShaderStaticRewrite.RewriteTimeToStaticUniform(src);
        Check.That(referenced, "referenced");
        Check.Equal(CountOccurrences(rewritten, "couch_static_time"), 3, "two TIME uses + one uniform decl = 3 mentions");
        Check.That(!ContainsWholeWord(rewritten, "TIME"), "no whole-word TIME remains");
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
