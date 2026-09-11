using System;
using System.Text;

namespace CouchCoop.MirrorProtocol.SceneModel;

// PURE (Godot-free) gdshader source rewrite for the static-bake "alpha-preserving additive clone" variant
// (WS-ADDBAKE). An Add-blend SHADER carrier baked into a region's SubViewport must NOT render with its live
// `blend_add` (Godot's canvas Add writes src.alpha into the transparent bake target, so the region's premult-over
// composite would OCCLUDE live content below it instead of ADDING). Instead we render the add carrier into the bake
// viewport with `blend_premul_alpha` plus a fragment epilogue that folds the additive contribution into RGB and
// zeroes alpha:
//
//     COLOR.rgb *= COLOR.a;   COLOR.a = 0.0;
//
// Under PMALPHA (src ONE, dst 1-SRC_ALPHA) that accumulates (rgb*a, 0) into the bake target WITHOUT touching dst
// alpha, so a region texel that is add-only stays (rgb, 0) and its premult-over composite onto the stage is a TRUE
// additive draw — identical to blend_add's src.rgb*src.a contribution. The micro-leg (WS-ADDBAKE) measured this
// identity closing to within RGBA8 rounding (diff 0), including the (1-a_mix) attenuation of an earlier add by a
// later mix inside the same region.
//
// This rewrite COMPOSES ON TOP of the Static TIME-pin rewrite (ShaderStaticRewrite): the bake-add variant consumes
// the STATIC-rewritten source, so a baked add shader is both TIME-frozen AND premult-folded. Kept in the protocol
// library (NOT the Godot ShaderStore) so the Exe test suite covers the fiddly brace/return logic without a Godot
// host; ShaderStore.Compile calls it once per Add-blend shader and caches the resulting "bakeAdd" variant.
//
// CONSERVATIVE: any fragment we cannot mechanically prove the epilogue will run for (no `void fragment()`, unbalanced
// braces, a `discard`, or a non-bare `return <expr>;`) returns Ok=false — the carrier then stays LIVE (never baked
// raw). Ok=false is containment, not a bug.
public static class ShaderBakeRewrite
{
    // The two-statement epilogue appended before fragment()'s closing brace and wrapped around every bare `return;`.
    public const string Epilogue = "COLOR.rgb *= COLOR.a; COLOR.a = 0.0;";

    // Rewrite an Add-blend gdshader source into its bake-add premul variant: swap the whole-word `blend_add` in the
    // render_mode for `blend_premul_alpha`, and inject the epilogue so it always runs (append before the fragment
    // close brace + wrap any bare `return;`). Returns (Rewritten, Ok). Ok=false ⇒ Rewritten is the UNCHANGED source
    // and the caller keeps the carrier live.
    public static (string Rewritten, bool Ok) RewriteAddToBakePremul(string gdshaderSrc)
    {
        if (string.IsNullOrEmpty(gdshaderSrc))
        {
            return (gdshaderSrc, false);
        }

        // Must be an Add-blend shader (the only carriers we convert). Whole-word so a comment mention doesn't count.
        if (!ContainsWholeWord(gdshaderSrc, "blend_add"))
        {
            return (gdshaderSrc, false);
        }

        // Locate the fragment() body. gdshader canvas_item fragment is `void fragment() { ... }`.
        int open = FindFragmentOpenBrace(gdshaderSrc);
        if (open < 0)
        {
            return (gdshaderSrc, false);
        }

        int close = MatchBrace(gdshaderSrc, open);
        if (close < 0)
        {
            return (gdshaderSrc, false);
        }

        string body = gdshaderSrc.Substring(open + 1, close - open - 1);

        // `discard` throws away the fragment — the epilogue would not run, so we cannot guarantee the premult fold.
        if (ContainsWholeWord(body, "discard"))
        {
            return (gdshaderSrc, false);
        }

        // Wrap every bare `return;` in fragment so the epilogue precedes the early exit. A non-bare `return expr;`
        // (should never appear in a void fragment) bails to containment.
        if (!WrapBareReturns(body, out var wrappedBody))
        {
            return (gdshaderSrc, false);
        }

        // Reassemble: fragment body = wrapped body + a trailing epilogue for the fall-through path.
        var sb = new StringBuilder(gdshaderSrc.Length + 96);
        sb.Append(gdshaderSrc, 0, open + 1);
        sb.Append(wrappedBody);
        sb.Append("\n    ").Append(Epilogue).Append('\n');
        sb.Append(gdshaderSrc, close, gdshaderSrc.Length - close);

        // Swap the blend mode (whole-word) last — it lives in render_mode, disjoint from the body edits above.
        string swapped = ReplaceWholeWord(sb.ToString(), "blend_add", "blend_premul_alpha");
        return (swapped, true);
    }

    // The index of the `{` that opens the canvas_item `void fragment()` body, or -1. Comment-agnostic on the
    // signature (real signatures carry no comments), but the body scan below is comment-aware.
    private static int FindFragmentOpenBrace(string s)
    {
        int i = 0;
        while (true)
        {
            int f = IndexOfWholeWord(s, "fragment", i);
            if (f < 0)
            {
                return -1;
            }

            // Require a preceding `void` token and a `()` param list, then the opening brace.
            int p = f + "fragment".Length;
            p = SkipWs(s, p);
            if (p < s.Length && s[p] == '(')
            {
                p = SkipWs(s, p + 1);
                if (p < s.Length && s[p] == ')')
                {
                    p = SkipWs(s, p + 1);
                    if (p < s.Length && s[p] == '{' && PrecededByVoid(s, f))
                    {
                        return p;
                    }
                }
            }

            i = f + "fragment".Length;
        }
    }

    private static bool PrecededByVoid(string s, int fragmentIdx)
    {
        int j = fragmentIdx - 1;
        while (j >= 0 && char.IsWhiteSpace(s[j]))
        {
            j--;
        }

        // j is the last char of the token before `fragment`; check it spells `void`.
        return j >= 3 && s[j] == 'd' && s[j - 1] == 'i' && s[j - 2] == 'o' && s[j - 3] == 'v'
            && (j - 3 == 0 || !IsIdentChar(s[j - 4]));
    }

    // Comment-aware brace matcher: from the `{` at openIdx, return the index of the matching `}`, or -1.
    private static int MatchBrace(string s, int openIdx)
    {
        int depth = 0;
        int i = openIdx;
        while (i < s.Length)
        {
            char c = s[i];
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '/')
            {
                i += 2;
                while (i < s.Length && s[i] != '\n')
                {
                    i++;
                }

                continue;
            }

            if (c == '/' && i + 1 < s.Length && s[i + 1] == '*')
            {
                i += 2;
                while (i + 1 < s.Length && !(s[i] == '*' && s[i + 1] == '/'))
                {
                    i++;
                }

                i += 2;
                continue;
            }

            if (c == '{')
            {
                depth++;
            }
            else if (c == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return i;
                }
            }

            i++;
        }

        return -1;
    }

    // Wrap every bare `return;` in `body` as `{ <epilogue> return; }`. Comment-aware. Returns false (bail) on a
    // non-bare `return <expr>;`.
    private static bool WrapBareReturns(string body, out string wrapped)
    {
        var sb = new StringBuilder(body.Length + 64);
        int i = 0;
        while (i < body.Length)
        {
            char c = body[i];

            // Copy comments verbatim (a `return` inside one is not code).
            if (c == '/' && i + 1 < body.Length && body[i + 1] == '/')
            {
                int start = i;
                i += 2;
                while (i < body.Length && body[i] != '\n')
                {
                    i++;
                }

                sb.Append(body, start, i - start);
                continue;
            }

            if (c == '/' && i + 1 < body.Length && body[i + 1] == '*')
            {
                int start = i;
                i += 2;
                while (i + 1 < body.Length && !(body[i] == '*' && body[i + 1] == '/'))
                {
                    i++;
                }

                i = Math.Min(body.Length, i + 2);
                sb.Append(body, start, i - start);
                continue;
            }

            if (c == 'r' && IsWholeWordAt(body, i, "return"))
            {
                int p = SkipWs(body, i + "return".Length);
                if (p < body.Length && body[p] == ';')
                {
                    sb.Append("{ ").Append(Epilogue).Append(" return; }");
                    i = p + 1;
                    continue;
                }

                wrapped = body; // `return expr;` — cannot mechanically fold; bail to containment.
                return false;
            }

            sb.Append(c);
            i++;
        }

        wrapped = sb.ToString();
        return true;
    }

    // ---- small text helpers (whole-word aware) --------------------------------------------------------------------

    private static int SkipWs(string s, int i)
    {
        while (i < s.Length && char.IsWhiteSpace(s[i]))
        {
            i++;
        }

        return i;
    }

    private static bool IsIdentChar(char c) => c == '_' || char.IsLetterOrDigit(c);

    private static bool IsWholeWordAt(string s, int i, string word)
    {
        if (i + word.Length > s.Length)
        {
            return false;
        }

        for (int k = 0; k < word.Length; k++)
        {
            if (s[i + k] != word[k])
            {
                return false;
            }
        }

        if (i > 0 && IsIdentChar(s[i - 1]))
        {
            return false;
        }

        int after = i + word.Length;
        return after >= s.Length || !IsIdentChar(s[after]);
    }

    private static int IndexOfWholeWord(string s, string word, int from)
    {
        for (int i = from; i + word.Length <= s.Length; i++)
        {
            if (s[i] == word[0] && IsWholeWordAt(s, i, word))
            {
                return i;
            }
        }

        return -1;
    }

    private static bool ContainsWholeWord(string s, string word) => IndexOfWholeWord(s, word, 0) >= 0;

    private static string ReplaceWholeWord(string s, string word, string replacement)
    {
        var sb = new StringBuilder(s.Length + 16);
        int i = 0;
        while (i < s.Length)
        {
            if (s[i] == word[0] && IsWholeWordAt(s, i, word))
            {
                sb.Append(replacement);
                i += word.Length;
            }
            else
            {
                sb.Append(s[i]);
                i++;
            }
        }

        return sb.ToString();
    }
}
