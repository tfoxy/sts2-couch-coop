using System;
using System.Text;

namespace CouchCoop.MirrorProtocol.SceneModel;

// PURE (Godot-free) gdshader source rewrite for the native client's "Static" effect mode (WS-EFFECTS-NATIVE).
//
// The native client cannot render an effect at a fraction of resolution (Godot has no per-canvas-item render scale),
// so "Static" instead FREEZES the effect: it renders the shader once at a representative TIME and never advances.
// Godot's `TIME` is a live built-in that re-evaluates every frame, so to freeze it we swap it for a client-set
// uniform pinned to a constant. This mirrors the web/gsw frozen `static` tier (STATIC_SHADER_TIME = 1); the native
// side does it by SOURCE REWRITE because it compiles real Godot Shaders rather than a WebGL runtime that injects a
// `time` uniform.
//
// Kept in the protocol library (NOT the Godot ShaderStore, which type-loads Godot) so the Exe test suite can cover
// the fiddly word-boundary logic without a Godot host. ShaderStore.Compile calls this once per shader and caches the
// resulting "static" variant alongside the dynamic one.
public static class ShaderStaticRewrite
{
    // The synthetic uniform whole-word TIME is rewritten to. ShaderAttachment pins it to StaticShaderTime once when a
    // node's shader mode is Static (matching the web STATIC_SHADER_TIME); an unset float uniform would default to 0.
    public const string StaticTimeUniform = "couch_static_time";

    // Rewrite every WHOLE-WORD occurrence of the built-in `TIME` to the `couch_static_time` uniform and inject that
    // uniform's declaration at a legal global-scope position (after `shader_type ...;`, and after a following
    // `render_mode ...;` if present, since Godot requires render_mode immediately after shader_type).
    //
    // Returns (Rewritten, ReferencedTime). ReferencedTime is false when the source never references whole-word TIME —
    // then Rewritten is the UNCHANGED source and the caller SKIPS the static variant (static ≡ dynamic for that
    // shader). Whole-word means TIME bounded by non-identifier chars on both sides, so TIMER / ATIME / LIFETIME /
    // TIME_SCALE etc. are left untouched.
    public static (string Rewritten, bool ReferencedTime) RewriteTimeToStaticUniform(string gdshaderSrc)
    {
        if (string.IsNullOrEmpty(gdshaderSrc))
        {
            return (gdshaderSrc, false);
        }

        var sb = new StringBuilder(gdshaderSrc.Length + StaticTimeUniform.Length + 32);
        bool replaced = false;
        int i = 0;
        int n = gdshaderSrc.Length;
        while (i < n)
        {
            if (IsWholeWordTimeAt(gdshaderSrc, i))
            {
                sb.Append(StaticTimeUniform);
                i += 4; // consume "TIME"
                replaced = true;
            }
            else
            {
                sb.Append(gdshaderSrc[i]);
                i++;
            }
        }

        if (!replaced)
        {
            return (gdshaderSrc, false); // no whole-word TIME → no static variant needed
        }

        return (InjectUniform(sb.ToString()), true);
    }

    // `TIME` at [i..i+4) with non-identifier neighbours on both sides.
    private static bool IsWholeWordTimeAt(string s, int i)
    {
        if (i + 4 > s.Length || s[i] != 'T' || s[i + 1] != 'I' || s[i + 2] != 'M' || s[i + 3] != 'E')
        {
            return false;
        }

        if (i > 0 && IsIdentChar(s[i - 1]))
        {
            return false; // e.g. ...A|TIME, LIFE|TIME
        }

        if (i + 4 < s.Length && IsIdentChar(s[i + 4]))
        {
            return false; // e.g. TIME|R, TIME|_SCALE
        }

        return true;
    }

    private static bool IsIdentChar(char c) => c == '_' || char.IsLetterOrDigit(c);

    // Insert `uniform float couch_static_time;` at a legal global-scope point: after the `shader_type ...;` statement,
    // and after an immediately-following `render_mode ...;` statement if present. Defensively prepends when there is no
    // shader_type/`;` to anchor on (a body that fails to compile anyway).
    private static string InjectUniform(string src)
    {
        const string declLine = "uniform float " + StaticTimeUniform + ";";
        int at = InsertionPoint(src);
        return at < 0 ? declLine + "\n" + src : src.Insert(at, "\n" + declLine);
    }

    private static int InsertionPoint(string src)
    {
        int st = src.IndexOf("shader_type", StringComparison.Ordinal);
        if (st < 0)
        {
            return -1;
        }

        int semi = src.IndexOf(';', st);
        if (semi < 0)
        {
            return -1;
        }

        int after = semi + 1;

        // If the next global statement is render_mode, insert AFTER it (Godot requires render_mode directly after
        // shader_type, before any other declaration).
        int j = after;
        while (j < src.Length && char.IsWhiteSpace(src[j]))
        {
            j++;
        }

        if (StartsWithAt(src, j, "render_mode"))
        {
            int rmSemi = src.IndexOf(';', j);
            if (rmSemi >= 0)
            {
                after = rmSemi + 1;
            }
        }

        return after;
    }

    private static bool StartsWithAt(string s, int index, string token)
    {
        if (index < 0 || index + token.Length > s.Length)
        {
            return false;
        }

        for (int k = 0; k < token.Length; k++)
        {
            if (s[index + k] != token[k])
            {
                return false;
            }
        }

        return true;
    }
}
