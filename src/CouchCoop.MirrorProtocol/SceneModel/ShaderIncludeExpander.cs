using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace CouchCoop.MirrorProtocol.SceneModel;

// PURE (Godot-free) gdshader `#include` resolution for the native mirror client (WS-SHINC).
//
// A Godot `.gdshader` may pull util code with a preprocessor line:  #include "res://.../foo.gdshaderinc"
// Godot's ShaderInclude system resolves those at compile; the native ShaderStore compiles a `new Shader { Code = … }`
// off streamed source, so the includes must be spliced in FIRST or the compile fails silently (Godot logs a
// SHADER ERROR and renders NOTHING — the node then paints its raw base fill, which for the low-HP border VFX is a
// full-screen WHITE ColorRect → the "bright full-screen sheet" defect). This matches the web transpiler's
// `expandGodotShaderIncludes` (godot-scene-web webgl/transpile.ts) directive shape and semantics so ONE bridge fix
// (serving `.gdshaderinc` bodies) feeds BOTH clients.
//
// Kept in the protocol library (NOT the Godot ShaderStore, which type-loads Godot) so the Exe test suite covers the
// directive scan + splice + cycle/depth handling without a Godot host. The ASYNC fetching of include bodies lives in
// ShaderStore (it BFS-prefetches every transitive include, then hands the raw-body map to Expand below).
public static class ShaderIncludeExpander
{
    // A `#include "path"` on its own line (leading/trailing horizontal whitespace allowed). Mirrors the web regex
    // `^[ \t]*#include\s+"([^"]+)"[ \t]*$` (single-line, so `\s+` is narrowed to `[ \t]+` — identical for real source).
    private static readonly Regex IncludeLine =
        new("^[ \\t]*#include[ \\t]+\"([^\"]+)\"[ \\t]*$", RegexOptions.Multiline | RegexOptions.Compiled);

    // The distinct include paths referenced by `source` at its own top level (NOT transitive). ShaderStore uses this to
    // BFS-discover the full include set to fetch. Order-preserving, de-duplicated.
    public static IReadOnlyList<string> FindIncludePaths(string source)
    {
        if (string.IsNullOrEmpty(source) || source.IndexOf("#include", StringComparison.Ordinal) < 0)
        {
            return Array.Empty<string>();
        }

        var paths = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in IncludeLine.Matches(source))
        {
            string path = m.Groups[1].Value;
            if (seen.Add(path))
            {
                paths.Add(path);
            }
        }

        return paths;
    }

    // True when `source` has at least one `#include "…"` directive line (cheap gate so the include-free path — every
    // other game shader — stays byte-identical to the pre-fix compile).
    public static bool HasIncludes(string source) =>
        !string.IsNullOrEmpty(source)
        && source.IndexOf("#include", StringComparison.Ordinal) >= 0
        && IncludeLine.IsMatch(source);

    // Splice every `#include "path"` line with the body returned by `resolve(path)`, recursing into included bodies
    // (their own includes are expanded too). Matches gsw expandGodotShaderIncludes:
    //   - a per-ANCESTRY `seen` set guards cycles (an include that recurs along the current path → replaced with a
    //     `/* skipped recursive include … */` comment, not re-expanded — never an infinite loop);
    //   - `resolve` returning null leaves the raw `#include` line in place (ShaderStore prefetches every transitive
    //     include and FAILS the shader before calling Expand if any body is unavailable, so a reachable include never
    //     resolves null here — the leftover line is only a defensive belt);
    //   - `maxDepth` caps nesting; beyond it the source is returned un-expanded at that level (leftover `#include`
    //     lines then trip the ShaderStore compile-failure check rather than recursing without bound).
    public static string Expand(string source, Func<string, string?> resolve, int maxDepth = 8) =>
        ExpandInner(source, resolve, new HashSet<string>(StringComparer.Ordinal), 0, maxDepth);

    private static string ExpandInner(
        string source,
        Func<string, string?> resolve,
        HashSet<string> seen,
        int depth,
        int maxDepth)
    {
        if (string.IsNullOrEmpty(source) || source.IndexOf("#include", StringComparison.Ordinal) < 0)
        {
            return source;
        }

        if (depth > maxDepth)
        {
            return source; // pathological nesting — stop; leftover #include lines fail the compile honestly
        }

        var sb = new StringBuilder(source.Length);
        int lastIndex = 0;
        foreach (Match m in IncludeLine.Matches(source))
        {
            sb.Append(source, lastIndex, m.Index - lastIndex);
            lastIndex = m.Index + m.Length;

            string path = m.Groups[1].Value;
            if (seen.Contains(path))
            {
                sb.Append("\n/* skipped recursive include ").Append(path).Append(" */\n");
                continue;
            }

            string? body = resolve(path);
            if (body is null)
            {
                sb.Append(m.Value); // leave the raw #include line (defensive; ShaderStore normally fails first)
                continue;
            }

            var nextSeen = new HashSet<string>(seen, StringComparer.Ordinal) { path };
            sb.Append(ExpandInner(body, resolve, nextSeen, depth + 1, maxDepth));
        }

        sb.Append(source, lastIndex, source.Length - lastIndex);
        return sb.ToString();
    }
}
