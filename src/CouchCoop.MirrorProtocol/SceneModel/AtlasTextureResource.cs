using System.Collections.Generic;
using System.Globalization;

namespace CouchCoop.MirrorProtocol.SceneModel;

// WS-ATLAS: the client-side crop of a standalone AtlasTexture `.tres` NODE texture (relic icons, intent icons).
//
// A Sprite2D/TextureRect whose texture is a standalone AtlasTexture `.tres` streams its `texture.resourcePath`
// on the wire but NO textureRegion. Today the native client asks the host to crop it per-sprite
// (`GET <x>.tres?format=png` → spirectl's cropped-region PNG). WS-ATLAS instead fetches the `.tres` TEXT (the
// Godot-native-first `/res` route serves `[gd_resource type="AtlasTexture" …]` raw by default), parses out the
// atlas PAGE path + region + margin here, and lets the native client download the page ONCE (TextureStore,
// decode-once) and crop each sprite client-side via TextureDrawer.DrawAtlasRegion — the SAME contract the web
// client already uses (raw Godot resource text + atlasBaker.ts).
//
// This is a PURE (Godot-free, allocation-light) parser homed alongside ShaderResourceParser so the Exe test
// runner covers the fiddly Godot-literal parsing without a Godot host. It handles quoted paths, ExtResource
// id→path mapping, `Rect2(x, y, w, h)` region/margin, a missing margin (defaults to zero), an optional
// `filter_clip`, and returns null for a body that is NOT a standalone AtlasTexture (some other `.tres`
// resource type, an embedded sub-resource atlas the /res route can't crop independently, or non-`.tres`
// text) — the caller keeps today's `?format=png` server crop for those.
public sealed record ParsedAtlasTexture(
    string AtlasPath,   // the atlas PAGE resource path (res://…png), resolved from the `atlas` ExtResource
    MirrorRect Region,  // Rect2(x, y, w, h) — the sprite's rect within the page, in page pixels
    MirrorRect Margin,  // Rect2(x, y, w, h) — the transparent frame Godot pads around the region (0 when absent)
    bool FilterClip);   // AtlasTexture.filter_clip (absent ⇒ false); recorded for fidelity, not required to draw

public static class AtlasTextureResourceParser
{
    // Parse an AtlasTexture `.tres` TEXT. Returns the resolved page path + region + margin, or null when the
    // body is not a standalone AtlasTexture whose atlas page is an ExtResource with a parsable region.
    public static ParsedAtlasTexture? Parse(string body)
    {
        string trimmed = body.TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (trimmed.Length == 0 || trimmed[0] != '[')
        {
            return null; // JSON doc / raw image bytes / raw shader / empty → not a text `.tres`
        }

        var extPaths = new Dictionary<string, string>(System.StringComparer.Ordinal); // ext id → path
        bool sawAtlasResourceHeader = false;
        string currentSection = "";

        string? atlasRefId = null;
        MirrorRect? region = null;
        MirrorRect? margin = null;
        bool filterClip = false;

        string[] lines = body.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        foreach (var raw in lines)
        {
            string line = raw.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (line[0] == '[')
            {
                var (kind, attrs) = ParseHeader(line);
                currentSection = kind;
                switch (kind)
                {
                    case "gd_resource":
                        // The document type MUST be AtlasTexture — a ShaderMaterial/Font/other `.tres` (or a
                        // `[gd_scene …]`) is not croppable here, so bail so the caller keeps the server crop.
                        if (attrs.GetValueOrDefault("type") != "AtlasTexture")
                        {
                            return null;
                        }

                        sawAtlasResourceHeader = true;
                        break;

                    case "ext_resource":
                    {
                        string? id = attrs.GetValueOrDefault("id");
                        string? path = attrs.GetValueOrDefault("path");
                        if (id is not null && path is not null)
                        {
                            extPaths[id] = path;
                        }

                        break;
                    }
                }

                continue;
            }

            if (currentSection != "resource")
            {
                continue; // only the [resource] body carries atlas/region/margin/filter_clip
            }

            var (key, value) = SplitAssignment(line);
            switch (key)
            {
                case "atlas":
                {
                    // `atlas = ExtResource("1")` → the page id; a SubResource/inline atlas is not independently
                    // fetchable, so atlasRefId stays null and Parse returns null below (server-crop fallback).
                    var (refType, refId) = ParseRef(value);
                    if (refType == "ExtResource" && refId is not null)
                    {
                        atlasRefId = refId;
                    }

                    break;
                }

                case "region":
                    region = ParseRect(value);
                    break;
                case "margin":
                    margin = ParseRect(value);
                    break;
                case "filter_clip":
                    filterClip = value.Trim() == "true";
                    break;
            }
        }

        if (!sawAtlasResourceHeader || atlasRefId is null || region is null ||
            !extPaths.TryGetValue(atlasRefId, out var atlasPath))
        {
            return null;
        }

        return new ParsedAtlasTexture(atlasPath, region, margin ?? new MirrorRect(0, 0, 0, 0), filterClip);
    }

    // `key = value` → (key, rawValueText). A value never spans lines in an atlas `.tres`, so the line tail is
    // the whole value. Returns ("", "") for a non-assignment line.
    private static (string Key, string Value) SplitAssignment(string line)
    {
        int eq = line.IndexOf('=');
        if (eq < 0)
        {
            return ("", "");
        }

        return (line[..eq].Trim(), line[(eq + 1)..].Trim());
    }

    // `Rect2(x, y, w, h)` → MirrorRect, or null if the literal is malformed / not a 4-arg Rect2.
    private static MirrorRect? ParseRect(string value)
    {
        string v = value.Trim();
        if (!v.StartsWith("Rect2(", System.StringComparison.Ordinal))
        {
            return null;
        }

        int close = v.LastIndexOf(')');
        if (close < 0)
        {
            return null;
        }

        string[] parts = v["Rect2(".Length..close].Split(',');
        if (parts.Length < 4)
        {
            return null;
        }

        var nums = new double[4];
        for (int i = 0; i < 4; i++)
        {
            if (!double.TryParse(parts[i].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out nums[i]))
            {
                return null;
            }
        }

        return new MirrorRect(nums[0], nums[1], nums[2], nums[3]);
    }

    // `ExtResource("1")` → ("ExtResource", "1"). A non-ref literal → (raw, null). Mirrors ShaderResourceParser.
    private static (string Type, string? Id) ParseRef(string text)
    {
        string t = text.Trim();
        int paren = t.IndexOf('(');
        if (paren < 0)
        {
            return (t, null);
        }

        string type = t[..paren].Trim();
        int close = t.IndexOf(')', paren);
        string inside = close < 0 ? t[(paren + 1)..] : t[(paren + 1)..close];
        inside = inside.Trim().Trim('"');
        return (type, inside.Length > 0 ? inside : null);
    }

    // Parse `[kind attr="v" attr2=bare]` → (kind, attrs). Values may be quoted or bare. Mirrors the header
    // grammar ShaderResourceParser.ParseHeader accepts.
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
}
