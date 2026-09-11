// WS-EMITTER: the ONE kind→SetShaderParameter mapping for a streamed/authored MirrorShaderParam, shared by
// ShaderAttachment (per-view shader nodes) and ParticleLayer (emitter ShaderMaterials). Handles every NON-resource
// uniform kind directly; a "resource" (sampler) kind is caller-specific (an image path → TextureStore for a view; a
// `::`-qualified material sub-resource → the materialized Curve/Gradient sampler for an emitter), so it is reported
// back via the result rather than bound here. An unknown kind is likewise reported so each caller logs its own notice.

using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public enum ShaderUniformBindResult
{
    Bound,       // a non-resource kind was applied to the material
    Resource,    // a "resource" (sampler) kind — the caller binds the texture itself
    Unsupported, // an unrecognized kind — the caller logs a one-time notice
}

public static class ShaderUniformBinder
{
    // Apply `p`'s value to `mat` for every non-resource kind. Returns Resource for a sampler kind (unbound) and
    // Unsupported for an unrecognized kind. Value-less params (a null payload for the declared kind) are treated as
    // Bound no-ops — the uniform keeps its prior value / shader default, matching the pre-extraction behavior.
    public static ShaderUniformBindResult TryBindNonResource(ShaderMaterial mat, MirrorShaderParam p)
    {
        switch (p.Kind)
        {
            case "number":
                if (p.Number is { } num)
                {
                    mat.SetShaderParameter(p.Name, (float)num);
                }

                return ShaderUniformBindResult.Bound;
            case "bool":
                if (p.Bool is { } b)
                {
                    mat.SetShaderParameter(p.Name, b);
                }

                return ShaderUniformBindResult.Bound;
            case "string":
                if (p.String is { } s)
                {
                    mat.SetShaderParameter(p.Name, s);
                }

                return ShaderUniformBindResult.Bound;
            case "color":
                if (p.Color is { } c)
                {
                    // Wire floats are the linear channels Godot reports — set them DIRECTLY (no srgb/html decode).
                    mat.SetShaderParameter(p.Name, new Color((float)c.R, (float)c.G, (float)c.B, (float)c.A));
                }

                return ShaderUniformBindResult.Bound;
            case "vector2":
                if (p.Vector2 is { } v2)
                {
                    mat.SetShaderParameter(p.Name, new Vector2((float)v2.X, (float)v2.Y));
                }

                return ShaderUniformBindResult.Bound;
            case "vector3":
                if (p.Vector3 is { } v3)
                {
                    mat.SetShaderParameter(p.Name, new Vector3((float)v3.X, (float)v3.Y, (float)v3.Z));
                }

                return ShaderUniformBindResult.Bound;
            case "vector4":
                if (p.Vector4 is { } v4)
                {
                    mat.SetShaderParameter(p.Name, new Vector4((float)v4.X, (float)v4.Y, (float)v4.Z, (float)v4.W));
                }

                return ShaderUniformBindResult.Bound;
            case "rect2":
                if (p.Rect2 is { } r)
                {
                    mat.SetShaderParameter(p.Name, new Rect2((float)r.X, (float)r.Y, (float)r.Width, (float)r.Height));
                }

                return ShaderUniformBindResult.Bound;
            case "transform2d":
                if (p.Transform2D is { Count: >= 6 } t)
                {
                    mat.SetShaderParameter(p.Name, new Transform2D(
                        (float)t[0], (float)t[1], (float)t[2], (float)t[3], (float)t[4], (float)t[5]));
                }

                return ShaderUniformBindResult.Bound;
            case "vector2Array":
                mat.SetShaderParameter(p.Name, BuildVector2Array(p.NumberArray));
                return ShaderUniformBindResult.Bound;
            case "vector3Array":
                mat.SetShaderParameter(p.Name, BuildVector3Array(p.NumberArray));
                return ShaderUniformBindResult.Bound;
            case "vector4Array":
                mat.SetShaderParameter(p.Name, BuildVector4Array(p.NumberArray));
                return ShaderUniformBindResult.Bound;
            case "floatArray":
            case "intArray":
                mat.SetShaderParameter(p.Name, BuildFloatArray(p.NumberArray));
                return ShaderUniformBindResult.Bound;
            case "resource":
                return ShaderUniformBindResult.Resource;
            default:
                return ShaderUniformBindResult.Unsupported;
        }
    }

    private static Vector2[] BuildVector2Array(IReadOnlyList<double>? flat)
    {
        if (flat is null)
        {
            return System.Array.Empty<Vector2>();
        }

        var arr = new Vector2[flat.Count / 2];
        for (int i = 0; i < arr.Length; i++)
        {
            arr[i] = new Vector2((float)flat[(i * 2) + 0], (float)flat[(i * 2) + 1]);
        }

        return arr;
    }

    private static Vector3[] BuildVector3Array(IReadOnlyList<double>? flat)
    {
        if (flat is null)
        {
            return System.Array.Empty<Vector3>();
        }

        var arr = new Vector3[flat.Count / 3];
        for (int i = 0; i < arr.Length; i++)
        {
            arr[i] = new Vector3((float)flat[(i * 3) + 0], (float)flat[(i * 3) + 1], (float)flat[(i * 3) + 2]);
        }

        return arr;
    }

    private static Vector4[] BuildVector4Array(IReadOnlyList<double>? flat)
    {
        if (flat is null)
        {
            return System.Array.Empty<Vector4>();
        }

        var arr = new Vector4[flat.Count / 4];
        for (int i = 0; i < arr.Length; i++)
        {
            arr[i] = new Vector4(
                (float)flat[(i * 4) + 0], (float)flat[(i * 4) + 1], (float)flat[(i * 4) + 2], (float)flat[(i * 4) + 3]);
        }

        return arr;
    }

    private static float[] BuildFloatArray(IReadOnlyList<double>? flat)
    {
        if (flat is null)
        {
            return System.Array.Empty<float>();
        }

        var arr = new float[flat.Count];
        for (int i = 0; i < arr.Length; i++)
        {
            arr[i] = (float)flat[i];
        }

        return arr;
    }
}
