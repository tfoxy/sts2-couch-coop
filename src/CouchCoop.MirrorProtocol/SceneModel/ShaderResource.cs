using System.Globalization;
using System.Text;

namespace CouchCoop.MirrorProtocol.SceneModel;

// The FORMAT the server served a shader resource in (WS-H, M1d). The producer route is transitioning to Godot-
// native-first raw serving, so the native ShaderStore supports the two raw shapes:
//   RawShader : a `.gdshader` body (or a `.tres` the host resolved to compiled shader source) — starts with a
//               `shader_type ...;` declaration. Compiled directly; the source's `uniform x = default` initializers
//               ARE the authored defaults (Godot applies them), so no material-default table is parsed here.
//   RawTres   : a `[gd_resource]` Godot text resource (ShaderMaterial) — an ext/sub shader ref + shader_parameter
//               overrides. Needs a SECOND fetch when the shader is an ExtResource `.gdshader`.
public enum ShaderResourceFormat
{
    Unknown,
    RawShader,
    RawTres,
}

// The result of parsing a fetched shader resource body. Exactly one of ShaderCode / ShaderExtPath is set for a
// resolvable resource (ShaderCode = inline source to compile now; ShaderExtPath = a `res://…gdshader` to fetch and
// then compile). Defaults are the material's AUTHORED shader_parameter overrides (empty for RawShader — Godot reads
// the source initializers itself); they're expressed as MirrorShaderParam so the native applier reuses ONE
// kind→SetShaderParameter mapper for both authored defaults and streamed uniforms.
public sealed record ParsedShaderResource(
    ShaderResourceFormat Format,
    string? ShaderCode,
    string? ShaderExtPath,
    IReadOnlyList<MirrorShaderParam> Defaults)
{
    public static readonly IReadOnlyList<MirrorShaderParam> NoDefaults = System.Array.Empty<MirrorShaderParam>();
}

// WS-EMITTER: the kind of a materialized `.tres` sampler sub-resource. A particle/shader emitter's sampler uniform
// streams as a `::`-qualified SubResource ref (e.g. `…vfx_ring_polar.tres::CurveTexture_i84de`) whose default value
// is NULL on the wire (ShaderResourceParser.ParseDefaultValue skips SubResource refs). ParseMaterialSamplers reads the
// material `.tres` FULL TEXT and re-derives the sampler's baked data so the native side can rebuild the CurveTexture /
// GradientTexture the shader samples.
public enum MaterialSamplerKind
{
    Curve,        // CurveTexture (baked from an inner Curve)
    Gradient1D,   // GradientTexture1D (baked from an inner Gradient)
    Gradient2D,   // GradientTexture2D (baked from an inner Gradient)
    Image,        // an ExtResource image path the CurveTexture/GradientTexture is NOT (a plain sampler ExtResource)
}

// One Godot Curve control point re-read from a `.tres` `_data` block: position (X,Y) PLUS the hermite tangents (which
// — unlike the streamed over-life particle curves — ARE present in the material text, so the baked CurveTexture can
// reproduce the game's interpolation faithfully rather than falling back to flat tangents).
public sealed record MaterialSamplerCurvePoint(double X, double Y, double LeftTangent, double RightTangent);

// A single materialized sampler sub-resource, keyed (in ParsedMaterialSamplers) by the SubResource id the streamed
// `::` ref carries. Exactly one payload field is populated per Kind: CurvePoints (Curve), GradientStops (Gradient1D/2D),
// ImagePath (Image). Width/Height/UseHdr/MinValue/MaxValue carry the texture-bake parameters the native builder needs.
public sealed record MaterialSampler(
    string SubId,
    MaterialSamplerKind Kind,
    int Width,
    int Height,
    bool UseHdr,
    double MinValue,
    double MaxValue,
    IReadOnlyList<MaterialSamplerCurvePoint>? CurvePoints,
    IReadOnlyList<MirrorGradientStop>? GradientStops,
    string? ImagePath);

// The samplers materialized from one material `.tres`, keyed by SubResource id (the `::`-suffix of the streamed ref).
public sealed record ParsedMaterialSamplers(IReadOnlyDictionary<string, MaterialSampler> BySubId)
{
    public static readonly ParsedMaterialSamplers Empty =
        new(new Dictionary<string, MaterialSampler>(System.StringComparer.Ordinal));
}

// A PURE (Godot-free, allocation-light) parser for the raw shader-resource wire formats. Kept in the protocol
// library so the Exe test runner covers the fiddly Godot-literal + escaped-string parsing without a Godot host.
// Image-extension detection here decides whether a shader_parameter sampler default is a fetchable texture path or
// a `::`/sub-resource ref the native side must skip (keeping the shader's own default).
public static class ShaderResourceParser
{
    private static readonly string[] ImageExtensions =
        [".png", ".webp", ".jpg", ".jpeg", ".svg", ".exr", ".ktx", ".bmp", ".tga"];

    public static bool IsImagePath(string path)
    {
        foreach (var ext in ImageExtensions)
        {
            if (path.EndsWith(ext, System.StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    // Whitespace/BOM tolerant: a `[` (…gd_resource/ext/sub) → raw `.tres`; anything else is raw shader source.
    public static ParsedShaderResource Parse(string body)
    {
        string trimmed = body.TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (trimmed.Length == 0)
        {
            return new ParsedShaderResource(ShaderResourceFormat.Unknown, null, null, ParsedShaderResource.NoDefaults);
        }

        if (trimmed[0] == '[')
        {
            return ParseRawTres(body);
        }

        // A raw shader source body (or a `.tres` the host already resolved to shader text): compile verbatim.
        return new ParsedShaderResource(ShaderResourceFormat.RawShader, body, null, ParsedShaderResource.NoDefaults);
    }

    // ---- raw `.tres` (Godot text resource) --------------------------------------------------------------------

    // R6 P6-F1 — the shader source of ONE named `[sub_resource type="Shader" id="…"]` inside a `.tres` body, or
    // null when this body has no such sub-resource (unknown id, a sub-resource of some other type, or one with no
    // `code` property).
    //
    // WHY THIS IS NEEDED SEPARATELY FROM `Parse`. `Parse` answers the question a MATERIAL asks: "which shader does
    // this resource use, and what are its authored parameter defaults" — so it follows the `[resource]` section's
    // own `shader = SubResource("…")` reference and ignores every sub-resource that reference does not name. A
    // `::`-qualified request is the other question: the CALLER already knows which sub-resource it wants, because
    // the scene tree streamed the qualified id to it, and the parent's `[resource]` section may not point at it at
    // all. Answering that with `Parse` would silently serve a different sub-resource, or none.
    //
    // Reuses the same section splitter, which is the part that is easy to get wrong: a shader body legitimately
    // contains lines beginning with `[`, and only a splitter that tracks the multi-line quoted value knows they
    // are not section headers.
    public static string? TryGetSubResourceShaderCode(string body, string subId)
    {
        if (string.IsNullOrEmpty(body) || string.IsNullOrEmpty(subId))
        {
            return null;
        }

        foreach (var section in SplitSections(body))
        {
            var (kind, attrs) = ParseHeader(section.Header);
            if (kind != "sub_resource"
                || attrs.GetValueOrDefault("type") != "Shader"
                || !string.Equals(attrs.GetValueOrDefault("id"), subId, System.StringComparison.Ordinal))
            {
                continue;
            }

            return ParseProps(section.Body).TryGetValue("code", out var code) ? code.Text : null;
        }

        return null;
    }

    private static ParsedShaderResource ParseRawTres(string body)
    {
        var extShaderPaths = new Dictionary<string, string>(System.StringComparer.Ordinal); // id → Shader path
        var extAnyPaths = new Dictionary<string, string>(System.StringComparer.Ordinal);    // id → any ext path
        var subShaderCode = new Dictionary<string, string>(System.StringComparer.Ordinal);  // id → inline code
        Dictionary<string, PropValue>? resourceProps = null;

        foreach (var section in SplitSections(body))
        {
            var (kind, attrs) = ParseHeader(section.Header);
            switch (kind)
            {
                case "ext_resource":
                {
                    string? id = attrs.GetValueOrDefault("id");
                    string? path = attrs.GetValueOrDefault("path");
                    if (id is not null && path is not null)
                    {
                        extAnyPaths[id] = path;
                        if (attrs.GetValueOrDefault("type") == "Shader")
                        {
                            extShaderPaths[id] = path;
                        }
                    }

                    break;
                }

                case "sub_resource":
                {
                    string? id = attrs.GetValueOrDefault("id");
                    if (id is not null && attrs.GetValueOrDefault("type") == "Shader")
                    {
                        var props = ParseProps(section.Body);
                        if (props.TryGetValue("code", out var code))
                        {
                            subShaderCode[id] = code.Text;
                        }
                    }

                    break;
                }

                case "resource":
                    resourceProps = ParseProps(section.Body);
                    break;
            }
        }

        string? shaderCode = null;
        string? shaderExtPath = null;
        var defaults = new List<MirrorShaderParam>();

        if (resourceProps is not null)
        {
            if (resourceProps.TryGetValue("shader", out var shaderRef) && !shaderRef.Quoted)
            {
                var (refType, refId) = ParseRef(shaderRef.Text);
                if (refType == "ExtResource" && refId is not null && extShaderPaths.TryGetValue(refId, out var extPath))
                {
                    shaderExtPath = extPath;
                }
                else if (refType == "SubResource" && refId is not null && subShaderCode.TryGetValue(refId, out var code))
                {
                    shaderCode = code;
                }
            }

            foreach (var (key, value) in resourceProps)
            {
                if (!key.StartsWith("shader_parameter/", System.StringComparison.Ordinal))
                {
                    continue;
                }

                string name = key["shader_parameter/".Length..];
                var param = ParseDefaultValue(name, value, extAnyPaths);
                if (param is not null)
                {
                    defaults.Add(param);
                }
            }
        }

        return new ParsedShaderResource(ShaderResourceFormat.RawTres, shaderCode, shaderExtPath, defaults);
    }

    // A `.tres` section: its `[header]` line + the body lines until the next top-level `[`.
    private readonly record struct Section(string Header, string Body);

    // Split into sections, treating a line-leading `[` as a header ONLY when not inside a multi-line quoted value
    // (the `code = "…"` shader block can contain lines that start with `[`).
    private static List<Section> SplitSections(string body)
    {
        var sections = new List<Section>();
        string[] lines = body.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

        string? header = null;
        var current = new StringBuilder();
        bool inQuote = false;

        void Flush()
        {
            if (header is not null)
            {
                sections.Add(new Section(header, current.ToString()));
            }
        }

        foreach (var line in lines)
        {
            if (!inQuote && line.StartsWith("[", System.StringComparison.Ordinal))
            {
                Flush();
                header = line;
                current.Clear();
            }
            else if (header is not null)
            {
                current.Append(line).Append('\n');
            }

            inQuote = ScanQuoteState(line, inQuote);
        }

        Flush();
        return sections;
    }

    // Toggle quote state across a line, honoring `\`-escapes (so `\"` doesn't close a string).
    private static bool ScanQuoteState(string line, bool inQuote)
    {
        for (int i = 0; i < line.Length; i++)
        {
            char c = line[i];
            if (c == '\\')
            {
                i++; // skip the escaped char
                continue;
            }

            if (c == '"')
            {
                inQuote = !inQuote;
            }
        }

        return inQuote;
    }

    // Parse `[kind attr="v" attr2="v2" bare=val]` → (kind, attrs). Values may be quoted or bare (id=1, uid=…).
    private static (string Kind, Dictionary<string, string> Attrs) ParseHeader(string header)
    {
        string inner = header.Trim();
        if (inner.StartsWith("[", System.StringComparison.Ordinal))
        {
            inner = inner[1..];
        }

        int close = inner.IndexOf(']');
        if (close >= 0)
        {
            inner = inner[..close];
        }

        inner = inner.Trim();
        var attrs = new Dictionary<string, string>(System.StringComparer.Ordinal);

        int space = inner.IndexOf(' ');
        string kind = space < 0 ? inner : inner[..space];
        if (space < 0)
        {
            return (kind, attrs);
        }

        string rest = inner[(space + 1)..];
        int i = 0;
        while (i < rest.Length)
        {
            while (i < rest.Length && rest[i] == ' ')
            {
                i++;
            }

            int eq = rest.IndexOf('=', i);
            if (eq < 0)
            {
                break;
            }

            string key = rest[i..eq].Trim();
            int v = eq + 1;
            string val;
            if (v < rest.Length && rest[v] == '"')
            {
                int end = rest.IndexOf('"', v + 1);
                if (end < 0)
                {
                    break;
                }

                val = rest[(v + 1)..end];
                i = end + 1;
            }
            else
            {
                int end = rest.IndexOf(' ', v);
                if (end < 0)
                {
                    end = rest.Length;
                }

                val = rest[v..end];
                i = end;
            }

            if (key.Length > 0)
            {
                attrs[key] = val;
            }
        }

        return (kind, attrs);
    }

    private readonly record struct PropValue(string Text, bool Quoted);

    // Parse `key = value` assignments from a section body. A value beginning with `"` is a (possibly multi-line)
    // escaped string → Text is the UNESCAPED content, Quoted=true. Otherwise Text is the raw trimmed literal.
    private static Dictionary<string, PropValue> ParseProps(string sectionBody)
    {
        var props = new Dictionary<string, PropValue>(System.StringComparer.Ordinal);
        int i = 0;
        int n = sectionBody.Length;

        while (i < n)
        {
            // Skip leading whitespace / blank lines.
            while (i < n && (sectionBody[i] == ' ' || sectionBody[i] == '\t' || sectionBody[i] == '\n' ||
                             sectionBody[i] == '\r'))
            {
                i++;
            }

            if (i >= n)
            {
                break;
            }

            // Read key up to '=' (keys never contain spaces/quotes in .tres).
            int keyStart = i;
            while (i < n && sectionBody[i] != '=' && sectionBody[i] != '\n')
            {
                i++;
            }

            if (i >= n || sectionBody[i] == '\n')
            {
                continue; // malformed / non-assignment line
            }

            string key = sectionBody[keyStart..i].Trim();
            i++; // skip '='

            while (i < n && (sectionBody[i] == ' ' || sectionBody[i] == '\t'))
            {
                i++;
            }

            if (i < n && sectionBody[i] == '"')
            {
                var (unescaped, next) = ReadQuoted(sectionBody, i);
                props[key] = new PropValue(unescaped, true);
                i = next;
            }
            else
            {
                int valStart = i;
                while (i < n && sectionBody[i] != '\n')
                {
                    i++;
                }

                props[key] = new PropValue(sectionBody[valStart..i].Trim(), false);
            }
        }

        return props;
    }

    // Read a Godot-escaped string starting at the opening `"` at `start`; returns (unescaped, indexAfterClose).
    private static (string Value, int Next) ReadQuoted(string s, int start)
    {
        var sb = new StringBuilder();
        int i = start + 1; // past opening quote
        int n = s.Length;
        while (i < n)
        {
            char c = s[i];
            if (c == '\\' && i + 1 < n)
            {
                char e = s[i + 1];
                sb.Append(e switch
                {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    '"' => '"',
                    '\\' => '\\',
                    _ => e,
                });
                i += 2;
                continue;
            }

            if (c == '"')
            {
                return (sb.ToString(), i + 1);
            }

            sb.Append(c);
            i++;
        }

        return (sb.ToString(), i);
    }

    // `ExtResource("1_0d6mo")` / `SubResource("Shader_x")` → (type, id). Non-ref → (raw, null).
    private static (string Type, string? Id) ParseRef(string text)
    {
        int paren = text.IndexOf('(');
        if (paren < 0)
        {
            return (text, null);
        }

        string type = text[..paren].Trim();
        int close = text.IndexOf(')', paren);
        string inside = close < 0 ? text[(paren + 1)..] : text[(paren + 1)..close];
        inside = inside.Trim().Trim('"');
        return (type, inside.Length > 0 ? inside : null);
    }

    // A `.tres` shader_parameter literal → MirrorShaderParam, or null to skip (keep the shader/Godot default).
    private static MirrorShaderParam? ParseDefaultValue(string name, PropValue value, Dictionary<string, string> extPaths)
    {
        if (value.Quoted)
        {
            return Param(name, "string", str: value.Text);
        }

        string v = value.Text.Trim();
        if (v.Length == 0)
        {
            return null;
        }

        if (v == "true" || v == "false")
        {
            return Param(name, "bool", b: v == "true");
        }

        if (TryConstructor(v, "Vector2", out var v2) && v2.Length >= 2)
        {
            return Param(name, "vector2", vector2: new MirrorVector2(v2[0], v2[1]));
        }

        if (TryConstructor(v, "Vector3", out var v3) && v3.Length >= 3)
        {
            return Param(name, "vector3", vector3: new MirrorVector3(v3[0], v3[1], v3[2]));
        }

        if (TryConstructor(v, "Vector4", out var v4) && v4.Length >= 4)
        {
            return Param(name, "vector4", vector4: new MirrorVector4(v4[0], v4[1], v4[2], v4[3]));
        }

        if (TryConstructor(v, "Color", out var col) && col.Length >= 4)
        {
            return Param(name, "color", color: new MirrorColor(col[0], col[1], col[2], col[3], ""));
        }

        if (TryConstructor(v, "Rect2", out var r) && r.Length >= 4)
        {
            return Param(name, "rect2", rect2: new MirrorRect(r[0], r[1], r[2], r[3]));
        }

        if (TryConstructor(v, "Transform2D", out var t) && t.Length >= 6)
        {
            return Param(name, "transform2d", transform2d: new[] { t[0], t[1], t[2], t[3], t[4], t[5] });
        }

        if (v.StartsWith("ExtResource(", System.StringComparison.Ordinal))
        {
            var (_, id) = ParseRef(v);
            if (id is not null && extPaths.TryGetValue(id, out var path) && IsImagePath(path))
            {
                return Param(name, "resource", resourcePath: path);
            }

            return null; // non-image ext sampler → keep the shader default (native side notices at apply)
        }

        if (v.StartsWith("SubResource(", System.StringComparison.Ordinal))
        {
            return null; // inline sub-resource sampler (GradientTexture1D, …) → keep the shader default
        }

        if (double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var num))
        {
            return Param(name, "number", num);
        }

        return null;
    }

    // `Name(a, b, c)` → the comma-separated float args, tolerant of whitespace. Returns false if the prefix/parens
    // don't match.
    private static bool TryConstructor(string v, string name, out double[] args)
    {
        args = System.Array.Empty<double>();
        if (!v.StartsWith(name + "(", System.StringComparison.Ordinal))
        {
            return false;
        }

        int close = v.LastIndexOf(')');
        if (close < 0)
        {
            return false;
        }

        string inside = v[(name.Length + 1)..close];
        string[] parts = inside.Split(',');
        var parsed = new double[parts.Length];
        for (int i = 0; i < parts.Length; i++)
        {
            if (!double.TryParse(parts[i].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out parsed[i]))
            {
                return false;
            }
        }

        args = parsed;
        return true;
    }

    // ---- WS-EMITTER: material `.tres` sampler sub-resource materialization -------------------------------------

    // Parse a raw material `[gd_resource]` `.tres` FULL TEXT into its baked sampler sub-resources, keyed by SubResource
    // id (the `::`-suffix a streamed sampler ref carries). Additive to ParseDefaultValue (which still returns null for
    // SubResource refs — that path is unchanged). Handles the CurveTexture(→Curve) and GradientTexture1D/2D(→Gradient)
    // families seen on the game's emitter materials (vfx_ring_polar / vfx_fire_flipbook_N / vfx_glow) plus a plain
    // ExtResource-image sampler; any unrecognized sub-resource is simply absent (the caller keeps the shader default).
    // A non-`.tres` body (JSON / raw shader / empty) → Empty. Pure + Godot-free (Exe-tested against real bodies).
    public static ParsedMaterialSamplers ParseMaterialSamplers(string body)
    {
        string trimmed = body.TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (trimmed.Length == 0 || trimmed[0] != '[')
        {
            return ParsedMaterialSamplers.Empty;
        }

        var extImagePaths = new Dictionary<string, string>(System.StringComparer.Ordinal); // ext id → image path
        var curves = new Dictionary<string, CurveRaw>(System.StringComparer.Ordinal);       // Curve id → points/limits
        var gradients = new Dictionary<string, List<MirrorGradientStop>>(System.StringComparer.Ordinal); // Gradient id → stops
        // CurveTexture / GradientTexture blocks captured with their inner refs — resolved in a 2nd pass (section order
        // is not guaranteed to place the referenced Curve/Gradient before its texture wrapper).
        var curveTextures = new List<(string Id, int Width, string? CurveRef)>();
        var gradientTextures = new List<(string Id, MaterialSamplerKind Kind, bool UseHdr, string? GradRef)>();

        foreach (var section in SplitSections(body))
        {
            var (kind, attrs) = ParseHeader(section.Header);
            if (kind == "ext_resource")
            {
                string? id = attrs.GetValueOrDefault("id");
                string? path = attrs.GetValueOrDefault("path");
                if (id is not null && path is not null && IsImagePath(path))
                {
                    extImagePaths[id] = path;
                }

                continue;
            }

            if (kind != "sub_resource")
            {
                continue;
            }

            string? subId = attrs.GetValueOrDefault("id");
            string? type = attrs.GetValueOrDefault("type");
            if (subId is null || type is null)
            {
                continue;
            }

            var props = ParseProps(section.Body);
            switch (type)
            {
                case "Curve":
                    curves[subId] = ParseCurveRaw(props);
                    break;
                case "CurveTexture":
                {
                    int width = props.TryGetValue("width", out var w)
                        && int.TryParse(w.Text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var pw)
                        ? pw : 256; // Godot CurveTexture default width
                    string? curveRef = props.TryGetValue("curve", out var cr) ? ParseRef(cr.Text).Id : null;
                    curveTextures.Add((subId, width, curveRef));
                    break;
                }

                case "Gradient":
                    gradients[subId] = ParseGradientStops(props);
                    break;
                case "GradientTexture1D":
                case "GradientTexture2D":
                {
                    bool hdr = props.TryGetValue("use_hdr", out var uh) && uh.Text.Trim() == "true";
                    string? gradRef = props.TryGetValue("gradient", out var gr) ? ParseRef(gr.Text).Id : null;
                    var texKind = type == "GradientTexture2D" ? MaterialSamplerKind.Gradient2D : MaterialSamplerKind.Gradient1D;
                    gradientTextures.Add((subId, texKind, hdr, gradRef));
                    break;
                }
            }
        }

        var result = new Dictionary<string, MaterialSampler>(System.StringComparer.Ordinal);

        foreach (var (id, width, curveRef) in curveTextures)
        {
            if (curveRef is not null && curves.TryGetValue(curveRef, out var raw))
            {
                result[id] = new MaterialSampler(
                    id, MaterialSamplerKind.Curve, width, 1, false, raw.MinValue, raw.MaxValue, raw.Points, null, null);
            }
        }

        foreach (var (id, texKind, hdr, gradRef) in gradientTextures)
        {
            if (gradRef is not null && gradients.TryGetValue(gradRef, out var stops))
            {
                result[id] = new MaterialSampler(id, texKind, 256, 1, hdr, 0.0, 1.0, null, stops, null);
            }
        }

        return new ParsedMaterialSamplers(result);
    }

    // The raw contents of a `[sub_resource type="Curve"]` block: the control points (with tangents) + the value range
    // (`_limits[0..1]` → min/max value; absent ⇒ Godot's default 0..1). Domain/mode fields are not needed to bake the
    // CurveTexture the shader samples, so they're dropped.
    private readonly record struct CurveRaw(IReadOnlyList<MaterialSamplerCurvePoint> Points, double MinValue, double MaxValue);

    private static CurveRaw ParseCurveRaw(Dictionary<string, PropValue> props)
    {
        double min = 0.0, max = 1.0;
        if (props.TryGetValue("_limits", out var lim))
        {
            var limits = ParseBracketScalars(lim.Text);
            if (limits.Count >= 2)
            {
                min = limits[0];
                max = limits[1];
            }
        }

        var points = new List<MaterialSamplerCurvePoint>();
        if (props.TryGetValue("_data", out var data))
        {
            // `_data = [Vector2(x, y), left_tan, right_tan, left_mode, right_mode, Vector2(...), …]` — groups of 5
            // top-level tokens per point (the Vector2 keeps its interior comma via the paren-aware split).
            var tokens = SplitTopLevelCommas(StripBrackets(data.Text));
            for (int i = 0; i + 2 < tokens.Count; i += 5)
            {
                if (!TryConstructor(tokens[i].Trim(), "Vector2", out var xy) || xy.Length < 2)
                {
                    continue;
                }

                double lt = ParseScalarOr(tokens[i + 1], 0.0);
                double rt = ParseScalarOr(tokens[i + 2], 0.0);
                points.Add(new MaterialSamplerCurvePoint(xy[0], xy[1], lt, rt));
            }
        }

        return new CurveRaw(points, min, max);
    }

    // A `[sub_resource type="Gradient"]` block → its stops. `offsets = PackedFloat32Array(o0, o1, …)` +
    // `colors = PackedColorArray(r,g,b,a, r,g,b,a, …)`; the two arrays are index-aligned per stop.
    private static List<MirrorGradientStop> ParseGradientStops(Dictionary<string, PropValue> props)
    {
        var offsets = props.TryGetValue("offsets", out var o) && TryConstructor(o.Text.Trim(), "PackedFloat32Array", out var oa)
            ? oa : System.Array.Empty<double>();
        var colors = props.TryGetValue("colors", out var c) && TryConstructor(c.Text.Trim(), "PackedColorArray", out var ca)
            ? ca : System.Array.Empty<double>();

        var stops = new List<MirrorGradientStop>();
        int count = offsets.Length;
        for (int i = 0; i < count; i++)
        {
            int ci = i * 4;
            var color = ci + 3 < colors.Length
                ? new double[] { colors[ci], colors[ci + 1], colors[ci + 2], colors[ci + 3] }
                : new double[] { 1, 1, 1, 1 };
            stops.Add(new MirrorGradientStop(offsets[i], color));
        }

        return stops;
    }

    // Strip a leading `[` and trailing `]` (Godot array literal) — tolerant of surrounding whitespace.
    private static string StripBrackets(string s)
    {
        string t = s.Trim();
        if (t.StartsWith("[", System.StringComparison.Ordinal))
        {
            t = t[1..];
        }

        if (t.EndsWith("]", System.StringComparison.Ordinal))
        {
            t = t[..^1];
        }

        return t;
    }

    // `[a, b, c]` (no interior parens) → its scalar values, skipping non-numeric tokens.
    private static List<double> ParseBracketScalars(string s)
    {
        var list = new List<double>();
        foreach (var tok in StripBrackets(s).Split(','))
        {
            if (double.TryParse(tok.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v))
            {
                list.Add(v);
            }
        }

        return list;
    }

    private static double ParseScalarOr(string token, double fallback) =>
        double.TryParse(token.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : fallback;

    // Split on commas that are NOT inside parentheses, so `Vector2(x, y)` stays a single token.
    private static List<string> SplitTopLevelCommas(string s)
    {
        var tokens = new List<string>();
        int depth = 0;
        int start = 0;
        for (int i = 0; i < s.Length; i++)
        {
            char ch = s[i];
            if (ch == '(')
            {
                depth++;
            }
            else if (ch == ')')
            {
                if (depth > 0)
                {
                    depth--;
                }
            }
            else if (ch == ',' && depth == 0)
            {
                tokens.Add(s[start..i]);
                start = i + 1;
            }
        }

        if (start <= s.Length)
        {
            string tail = s[start..].Trim();
            if (tail.Length > 0)
            {
                tokens.Add(s[start..]);
            }
        }

        return tokens;
    }

    private static MirrorShaderParam Param(
        string name,
        string kind,
        double? number = null,
        bool? b = null,
        string? str = null,
        MirrorColor? color = null,
        MirrorVector2? vector2 = null,
        string? resourcePath = null,
        MirrorVector3? vector3 = null,
        MirrorVector4? vector4 = null,
        MirrorRect? rect2 = null,
        IReadOnlyList<double>? transform2d = null) =>
        new(name, kind, number, b, str, color, vector2, resourcePath, vector3, vector4, rect2, transform2d, null);
}
