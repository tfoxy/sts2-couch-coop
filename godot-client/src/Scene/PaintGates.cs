// The node-level "does this node paint X?" gates, factored OUT of MirrorNodeView so the shader workstream (WS-H)
// owns the flip WITHOUT touching MirrorNodeView. WS-H (M1d) semantics — a WebGL-input shader node's base paint now
// tracks the shader's MOUNT state (a pure ShaderStore.PeekState read):
//   - MOUNTED shader ⇒ the node paints its base (texture AND fill) — the ShaderMaterial transforms it.
//   - FAILED shader  ⇒ suppressed-blank (ShaderStore has emitted the one-time `SHADER: failed` notice).
//   - PENDING/absent ⇒ M1c behavior: don't paint the shader-INPUT blob yet (no flash before the shader arrives).
// HSV-adjust ids are NOT WebGL-input (they keep their base texture as final art under a color transform), so they
// paint in every state — unchanged. Non-shader / atlas-region nodes are likewise unaffected.

using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.GodotClient.Scene;

public static class PaintGates
{
    // HSV-adjust shader ids (frontend/src/mirror/shaderResources.ts HSV_SHADER_IDS): their texture is FINAL art
    // (the shader is a hue/sat/val color transform over it), so it always paints — un-shifted while the shader is
    // pending, correctly shifted once the real hsv.gdshader mounts. Hence NOT treated as WebGL-input-only.
    public static readonly string[] HsvShaderIds = ["res://shaders/hsv.gdshader", "uid://c66gb6g7tup3n"];

    // Port of nodeStyles.ts paintsTexture (L252-257): paint a node's texture unless it's a clip-only node, a
    // particle sprite, or a WebGL shader-INPUT texture whose shader is NOT yet mounted (a meaningless blob without
    // its shader). A mounted shader ⇒ the base paints and the ShaderMaterial transforms it.
    public static bool PaintsTexture(MirrorNode node)
    {
        if (node.TextureUrl is null)
        {
            return false;
        }

        if (node.ClipChildren == 1)
        {
            return false;
        }

        if (node.ParticleSpec is not null)
        {
            return false;
        }

        // A screen-read shader (dark_blur scrim, overlay_blend, …) is unrenderable natively without a BackBufferCopy.
        // Suppress its raw base — the opaque white ColorRect must not paint; ScrimDrawer approximates dark_blur and
        // other screen-read shaders render nothing.
        if (IsSuppressedScreenRead(node))
        {
            return false;
        }

        if (!IsWebglEligible(node))
        {
            return true; // HSV / atlas-region / non-shader → base is final art, always paints
        }

        // WS-EFFECTS-NATIVE: shaders Off → no ShaderMaterial is applied, so paint the base as final art (the
        // "effects off" fallback; matches the web CSS-fallback shape) rather than suppressing it forever.
        if (ClientEffectSettings.ShaderMode == EffectMode.Off)
        {
            return true;
        }

        // WebGL shader-INPUT node: paint the base only once the shader has MOUNTED (else suppressed / not-yet-flashed).
        return ShaderStore.PeekState(node.ShaderId!) == ShaderState.Mounted;
    }

    // Port of shaderAttributes.ts isWebglEligible: a shader node whose own texture/fill is shader INPUT (not final
    // art). Native runs the real ShaderMaterial on the node's own draw, so — unlike the web self-layer — an atlas
    // sprite (textureRegion) is NOT structurally excluded here; but we keep the exclusion so its region crop stays
    // the base the shader transforms rather than sampling the whole packed page (matches the web fallback shape).
    public static bool IsWebglEligible(MirrorNode node)
    {
        if (node.ParticleSpec is not null)
        {
            return false;
        }

        if (node.ShaderId is null || System.Array.IndexOf(HsvShaderIds, node.ShaderId) >= 0)
        {
            return false;
        }

        if (node.TextureUrl is null && node.FillColor is null)
        {
            return false;
        }

        if (node.TextureRegion is not null)
        {
            return false; // atlas sprite → region crop is the base (always paints), the shader transforms it
        }

        return true;
    }

    // The TextureDrawer fill-rect gate. A fillColor rect paints when the node has no shader (M1c), when its shader is
    // HSV (base is final art), or when a shader-owning fill's shader has MOUNTED (the ShaderMaterial transforms the
    // fill). A pending/failed shader-owned fill is suppressed.
    public static bool PaintFill(MirrorNode node)
    {
        if (node.FillColor is null)
        {
            return false;
        }

        // Suppress the raw fill of a screen-read shader node (the white BlurBackstop ColorRect), matching
        // PaintsTexture.
        if (IsSuppressedScreenRead(node))
        {
            return false;
        }

        if (node.ShaderId is null || System.Array.IndexOf(HsvShaderIds, node.ShaderId) >= 0)
        {
            return true;
        }

        // WS-EFFECTS-NATIVE: shaders Off → the fill is final art (no ShaderMaterial transforms it) — paint it.
        if (ClientEffectSettings.ShaderMode == EffectMode.Off)
        {
            return true;
        }

        return ShaderStore.PeekState(node.ShaderId) == ShaderState.Mounted;
    }

    // Does this node's base paint get suppressed because its shader samples the framebuffer? ShaderStore populates
    // the compiled classification from the single ReferencesScreenRead rule. Independent of shader mode, the raw
    // base never paints because ScrimDrawer supplies the dark_blur approximation instead.
    public static bool IsSuppressedScreenRead(MirrorNode node) =>
        node.ShaderId is not null && ShaderStore.PeekScreenReads(node.ShaderId);
}
