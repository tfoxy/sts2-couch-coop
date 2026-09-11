// WS-EMITTER: the ONE place that rebuilds Godot Gradient/Curve resources (and the sampler CurveTexture/GradientTexture
// wrappers) from mirror-wire data. Shared by ParticleLayer (over-life color ramps + scale/alpha/hue curves on the
// ParticleProcessMaterial — the streamed spec, flat tangents) and MaterialSamplerStore (the material `.tres` sampler
// sub-resources a shader reads — full hermite tangents + value range parsed from the `.tres`). Godot-thread only
// (every builder news a Godot Resource); callers run on the main thread.

using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public static class ParticleTextureBuilders
{
    // A Gradient from over-life / sampler stops (Offset 0..1 + [r,g,b,a] linear). Offsets are set first (they resize
    // the point count) then Colors (same length) — a valid Gradient definition.
    public static Gradient BuildGradient(IReadOnlyList<MirrorGradientStop> stops)
    {
        var offsets = new float[stops.Count];
        var colors = new Color[stops.Count];
        for (int i = 0; i < stops.Count; i++)
        {
            offsets[i] = (float)stops[i].Offset;
            colors[i] = ToColor(stops[i].Color);
        }

        var g = new Gradient();
        g.Offsets = offsets;
        g.Colors = colors;
        return g;
    }

    // Godot's DEFAULT Gradient: 2 stops, black(0,0,0,1) at 0 -> white(1,1,1,1) at 1. What an authored
    // `[sub_resource type="Gradient"]` with no offsets/colors resolves to at runtime (built explicitly rather
    // than relying on `new Gradient()`'s implicit endpoints).
    private static Gradient DefaultBlackWhiteGradient()
    {
        var g = new Gradient();
        g.Offsets = new float[] { 0f, 1f };
        g.Colors = new Color[] { new Color(0f, 0f, 0f, 1f), new Color(1f, 1f, 1f, 1f) };
        return g;
    }

    // A Curve from streamed over-life points — FLAT tangents (the inspector emits only positions; tangents are not on
    // the wire), default 0..1 value range. Inverse of the spec's point list.
    public static Curve BuildCurve(IReadOnlyList<MirrorCurvePoint> points)
    {
        var c = new Curve();
        c.ClearPoints(); // drop the two default endpoints; the spec carries the real points (flat tangents)
        foreach (var p in points)
        {
            c.AddPoint(new Vector2((float)p.X, (float)p.Y));
        }

        return c;
    }

    // A Curve from a material `.tres` sampler — the full hermite tangents AND the value range (`_limits`) parsed from
    // the resource, so the baked CurveTexture reproduces the game's interpolation (a hue-shift curve authored over a
    // NEGATIVE [-0.1, 0.1] range would otherwise clamp to 0). Min/Max are set BEFORE AddPoint (which clamps Y).
    public static Curve BuildSamplerCurve(MaterialSampler s)
    {
        var c = new Curve
        {
            MinValue = (float)s.MinValue,
            MaxValue = (float)s.MaxValue,
        };
        c.ClearPoints();
        if (s.CurvePoints is not null)
        {
            foreach (var p in s.CurvePoints)
            {
                c.AddPoint(new Vector2((float)p.X, (float)p.Y), (float)p.LeftTangent, (float)p.RightTangent);
            }
        }

        return c;
    }

    // A materialized sampler Texture2D (the resource a shader's `uniform sampler2D` reads) from a parsed material
    // sub-resource. Returns null for an Image kind (resolved via the TextureStore by the caller) or an empty payload.
    public static Texture2D? BuildSamplerTexture(MaterialSampler s)
    {
        switch (s.Kind)
        {
            case MaterialSamplerKind.Curve:
                return new CurveTexture { Width = Math.Max(1, s.Width), Curve = BuildSamplerCurve(s) };
            case MaterialSamplerKind.Gradient1D when s.GradientStops is { Count: > 0 } stops1:
                return new GradientTexture1D { Gradient = BuildGradient(stops1), UseHdr = s.UseHdr };
            case MaterialSamplerKind.Gradient2D when s.GradientStops is { Count: > 0 } stops2:
                return new GradientTexture2D { Gradient = BuildGradient(stops2), UseHdr = s.UseHdr };
            // An EMPTY inner Gradient (`[sub_resource type="Gradient"]` with no offsets/colors) is NOT "no sampler":
            // it is Godot's DEFAULT black->white 2-stop gradient. Returning null here left the shader on its
            // hint_default_white default, which turned the power-applied panning-noise `lut` tint ramp into a solid
            // WHITE wash (the power-gain white square). Materialize the real default instead. (EmitterSamplerFix)
            case (MaterialSamplerKind.Gradient1D or MaterialSamplerKind.Gradient2D):
                return s.Kind == MaterialSamplerKind.Gradient1D
                    ? new GradientTexture1D { Gradient = DefaultBlackWhiteGradient(), UseHdr = s.UseHdr }
                    : new GradientTexture2D { Gradient = DefaultBlackWhiteGradient(), UseHdr = s.UseHdr };
            default:
                return null;
        }
    }

    // WS-PARTICLE #1: a 32×32 white SOFT ROUND DOT — the native equivalent of gsw's untextured-particle fragment
    // (render-webgl.ts: r = length(uv - 0.5) * 2; alpha = 1 - smoothstep(0.7, 1.0, r); rgb white). Used by
    // ParticleLayer.DefaultTexture when a spec has no texture url, and as the permanent-failure fallback, so an
    // untextured / unresolvable emitter draws soft dots (web parity) instead of raw quads or an opaque square. The
    // per-particle tint/blend come from the emitter's own color/material, exactly like the textured path.
    public static ImageTexture SoftDotTexture()
    {
        const int size = 32;
        var img = Image.CreateEmpty(size, size, false, Image.Format.Rgba8);
        for (int y = 0; y < size; y++)
        {
            for (int x = 0; x < size; x++)
            {
                // uv at the pixel CENTER, mapped to gsw's r = length(uv - 0.5) * 2 (0 at center, 1 at an axis edge).
                float ux = (x + 0.5f) / size;
                float uy = (y + 0.5f) / size;
                float dx = ux - 0.5f;
                float dy = uy - 0.5f;
                float r = MathF.Sqrt((dx * dx) + (dy * dy)) * 2f;
                float alpha = 1f - Smoothstep(0.7f, 1.0f, r);
                img.SetPixel(x, y, new Color(1f, 1f, 1f, alpha));
            }
        }

        return ImageTexture.CreateFromImage(img);
    }

    // GLSL smoothstep: t = clamp((x - edge0) / (edge1 - edge0), 0, 1); t*t*(3 - 2t). Matches the gsw shader exactly.
    private static float Smoothstep(float edge0, float edge1, float x)
    {
        float t = Math.Clamp((x - edge0) / (edge1 - edge0), 0f, 1f);
        return t * t * (3f - (2f * t));
    }

    private static Color ToColor(IReadOnlyList<double> c) =>
        new(
            (float)(c.Count > 0 ? c[0] : 1),
            (float)(c.Count > 1 ? c[1] : 1),
            (float)(c.Count > 2 ? c[2] : 1),
            (float)(c.Count > 3 ? c[3] : 1));
}
