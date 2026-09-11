// Maps a node's canvas_blend_mode (Godot CanvasItemMaterial.BlendMode, streamed as node.CanvasBlendMode:
// 1 ADD / 2 SUB / 3 MUL) to a shared CanvasItemMaterial applied to the MirrorNodeView, so a glow/darken
// composites correctly against the framebuffer. Web spec: nodeStyles.ts L224-228 (mix-blend-mode
// plus-lighter/difference/multiply) — but native SUB is the real Godot subtract, MORE correct than the web's
// `difference` approximation, so we use CanvasItemMaterial's native Sub.
//
// Materials are CACHED per blend mode (one shared immutable material per mode, reused by every node with that
// mode). null → the default alpha (Mix) blend, which needs no material at all.

using System.Collections.Generic;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public static class BlendMaterials
{
    // One shared CanvasItemMaterial per blend mode (keyed by the wire int). Built lazily, never mutated.
    private static readonly Dictionary<int, CanvasItemMaterial> Cache = new();

    // Returns the shared Material for a canvas blend mode, or null for the default (alpha/Mix) blend. The wire
    // ints line up 1:1 with CanvasItemMaterial.BlendModeEnum (Add=1, Sub=2, Mul=3), but map explicitly so an
    // out-of-range value degrades to the default rather than an undefined enum.
    public static Material? For(int? canvasBlendMode)
    {
        int mode = canvasBlendMode ?? 0;
        var blend = mode switch
        {
            1 => CanvasItemMaterial.BlendModeEnum.Add,
            2 => CanvasItemMaterial.BlendModeEnum.Sub,
            3 => CanvasItemMaterial.BlendModeEnum.Mul,
            _ => CanvasItemMaterial.BlendModeEnum.Mix, // 0 / null / unknown → default alpha blend (no material)
        };

        if (blend == CanvasItemMaterial.BlendModeEnum.Mix)
        {
            return null;
        }

        if (!Cache.TryGetValue(mode, out var mat))
        {
            mat = new CanvasItemMaterial { BlendMode = blend };
            Cache[mode] = mat;
        }

        return mat;
    }
}
