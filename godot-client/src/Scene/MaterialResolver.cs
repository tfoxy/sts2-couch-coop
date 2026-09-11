// Chooses the CanvasItemMaterial (or ShaderMaterial) for a MirrorNodeView. Factored out of MirrorNodeView so the
// shader workstream owns the material decision without editing the view.
//
// WS-H (M1d): a node with a usable (MOUNTED) ShaderId that is NOT a particle node gets its per-view ShaderMaterial
// (ShaderAttachment.EnsureMaterial builds/caches it off the shared compiled Shader; its render_mode owns blending,
// so it supersedes the CanvasBlendMode material). Otherwise — no shader, a pending/failed shader, or a particle
// node — the M1c behavior stands: the node's canvas blend mode → one of the three shared BlendMaterials (Add/Sub/
// Mul) or null (default alpha Mix).

using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public static class MaterialResolver
{
    public static Material? For(MirrorNodeView view, MirrorNode node)
    {
        // A shader node's per-view material (for a static-bake Add clone this is the bake-add premul variant off the
        // per-shader ShaderBakeRewrite; ShaderAttachment owns that swap). Its render_mode owns blending.
        var shaderMat = ShaderAttachment.EnsureMaterial(view, node);
        if (shaderMat is not null)
        {
            return shaderMat;
        }

        // WS-ADDBAKE: a static-bake region clone of a PLAIN Add painter (no shader) folds into the alpha-preserving
        // additive variant so the region's premult-over composite is a TRUE add (never occludes live content below).
        // Gated on the ADDBAKE lever (off ⇒ v3 raw-Add behavior). Sub/Mul keep their plain blend material (they only
        // ever bake in region 0, at the paint-order bottom, where a plain blend is already associative).
        if (view.IsStaticBakeClone && node.CanvasBlendMode == 1)
        {
            return BakeAddMaterials.Variant;
        }

        return BlendMaterials.For(node.CanvasBlendMode);
    }
}
