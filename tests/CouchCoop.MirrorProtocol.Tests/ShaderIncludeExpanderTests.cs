using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-SHINC unit coverage for the PURE gdshader `#include` expander (ShaderIncludeExpander). The native ShaderStore
// BFS-prefetches include bodies then hands them to Expand; this suite pins the directive scan, the splice, and the
// cycle/depth guards without a Godot host. All shader bodies are SYNTHETIC (hand-written) — no game content committed.
internal static class ShaderIncludeExpanderTests
{
    public static void Run()
    {
        FindsDistinctIncludePathsInOrder();
        HasIncludesGate();
        InlinesSingleInclude();
        InlinesNestedIncludes();
        CycleReplacedWithComment();
        UnresolvedIncludeLeftInPlace();
        IncludeFreeSourceUnchanged();
        OnlyMatchesLineLeadingDirective();
        IncludedBodyTimeSurvivesForRewrite();
    }

    private static string? Resolve(Dictionary<string, string> map, string path) =>
        map.TryGetValue(path, out var v) ? v : null;

    private static void FindsDistinctIncludePathsInOrder()
    {
        const string src =
            "shader_type canvas_item;\n" +
            "#include \"res://a.gdshaderinc\"\n" +
            "#include \"res://b.gdshaderinc\"\n" +
            "#include \"res://a.gdshaderinc\"\n" + // duplicate → de-duped
            "void fragment(){}\n";
        var paths = ShaderIncludeExpander.FindIncludePaths(src);
        Check.Equal(paths.Count, 2, "two distinct include paths");
        Check.Equal(paths[0], "res://a.gdshaderinc", "first path preserved");
        Check.Equal(paths[1], "res://b.gdshaderinc", "second path preserved");
    }

    private static void HasIncludesGate()
    {
        Check.That(ShaderIncludeExpander.HasIncludes("#include \"res://x.gdshaderinc\"\n"), "detects a directive");
        Check.That(!ShaderIncludeExpander.HasIncludes("shader_type canvas_item;\nvoid fragment(){}\n"),
            "include-free source → false (byte-identical compile path)");
        Check.That(!ShaderIncludeExpander.HasIncludes(""), "empty → false");
    }

    private static void InlinesSingleInclude()
    {
        var map = new Dictionary<string, string>
        {
            ["res://util.gdshaderinc"] = "float helper(float x){ return x * 2.0; }",
        };
        const string src =
            "shader_type canvas_item;\n#include \"res://util.gdshaderinc\"\nvoid fragment(){ COLOR.a = helper(0.5); }\n";
        string expanded = ShaderIncludeExpander.Expand(src, p => Resolve(map, p));
        Check.That(!expanded.Contains("#include", StringComparison.Ordinal), "no #include directive remains");
        Check.That(expanded.Contains("float helper(float x)"), "include body spliced in");
        Check.That(expanded.Contains("shader_type canvas_item;") && expanded.Contains("void fragment()"),
            "surrounding source preserved");
    }

    private static void InlinesNestedIncludes()
    {
        var map = new Dictionary<string, string>
        {
            ["res://a.gdshaderinc"] = "#include \"res://b.gdshaderinc\"\nfloat a(){ return b(); }",
            ["res://b.gdshaderinc"] = "float b(){ return 1.0; }",
        };
        const string src = "shader_type canvas_item;\n#include \"res://a.gdshaderinc\"\nvoid fragment(){}\n";
        string expanded = ShaderIncludeExpander.Expand(src, p => Resolve(map, p));
        Check.That(!expanded.Contains("#include", StringComparison.Ordinal), "nested #include fully resolved");
        Check.That(expanded.Contains("float b()") && expanded.Contains("float a()"), "both nested bodies present");
        Check.That(expanded.IndexOf("float b()", StringComparison.Ordinal)
                   < expanded.IndexOf("float a()", StringComparison.Ordinal),
            "b (included by a) appears before a's own body");
    }

    private static void CycleReplacedWithComment()
    {
        var map = new Dictionary<string, string>
        {
            ["res://a.gdshaderinc"] = "#include \"res://b.gdshaderinc\"\nfloat a(){return 0.0;}",
            ["res://b.gdshaderinc"] = "#include \"res://a.gdshaderinc\"\nfloat b(){return 0.0;}",
        };
        const string src = "shader_type canvas_item;\n#include \"res://a.gdshaderinc\"\n";
        string expanded = ShaderIncludeExpander.Expand(src, p => Resolve(map, p));
        Check.That(expanded.Contains("skipped recursive include res://a.gdshaderinc"),
            "the recursive edge back to a is skipped with a comment (no infinite loop)");
        Check.That(expanded.Contains("float a()") && expanded.Contains("float b()"), "both bodies still spliced once");
        Check.That(!expanded.Contains("#include", StringComparison.Ordinal), "no live #include directive remains");
    }

    private static void UnresolvedIncludeLeftInPlace()
    {
        // resolve returns null → the raw directive line is left (ShaderStore FAILS the shader before reaching here for a
        // truly-unresolvable include; this is the defensive belt).
        const string src = "shader_type canvas_item;\n#include \"res://missing.gdshaderinc\"\nvoid fragment(){}\n";
        string expanded = ShaderIncludeExpander.Expand(src, _ => null);
        Check.That(expanded.Contains("#include \"res://missing.gdshaderinc\""),
            "unresolved include line preserved verbatim");
    }

    private static void IncludeFreeSourceUnchanged()
    {
        const string src = "shader_type canvas_item;\nuniform float a;\nvoid fragment(){ COLOR.a = a; }\n";
        string expanded = ShaderIncludeExpander.Expand(src, _ => "SHOULD_NOT_BE_CALLED");
        Check.Equal(expanded, src, "include-free source returned unchanged (byte-identical compile path)");
    }

    private static void OnlyMatchesLineLeadingDirective()
    {
        // A `#include` that is NOT a line-leading directive (here inside a string-ish tail) must not be treated as one.
        const string src = "shader_type canvas_item;\n// not an #include \"res://x.gdshaderinc\" really\nvoid f(){}\n";
        var paths = ShaderIncludeExpander.FindIncludePaths(src);
        Check.Equal(paths.Count, 0, "a commented/non-leading #include is not a directive");
    }

    // The include splice must run BEFORE the ShaderStaticRewrite TIME scan: an include body carrying whole-word TIME
    // must survive into the merged source so the Static variant freezes it.
    private static void IncludedBodyTimeSurvivesForRewrite()
    {
        var map = new Dictionary<string, string>
        {
            ["res://anim.gdshaderinc"] = "float wobble(vec2 uv){ return sin(uv.x + TIME); }",
        };
        const string src = "shader_type canvas_item;\n#include \"res://anim.gdshaderinc\"\nvoid fragment(){}\n";
        string expanded = ShaderIncludeExpander.Expand(src, p => Resolve(map, p));
        Check.That(expanded.Contains("sin(uv.x + TIME)"), "whole-word TIME from the include survives inlining");
        var (rewritten, referenced) = ShaderStaticRewrite.RewriteTimeToStaticUniform(expanded);
        Check.That(referenced, "the merged source's TIME is now visible to the Static rewrite");
        Check.That(rewritten.Contains("couch_static_time"), "TIME frozen after inlining");
    }
}
