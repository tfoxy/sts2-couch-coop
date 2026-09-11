using System;
using System.Collections.Generic;

namespace CouchCoop.MirrorProtocol.SceneModel;

// PURE (Godot-free) classification + approximation math for gdshaders that sample the framebuffer (Godot 4
// `hint_screen_texture` / the Godot 3 `SCREEN_TEXTURE` built-in). The native mirror client has no BackBufferCopy,
// so that screen sample is undefined (white on the target Mali GPU) and such a shader is unrenderable natively.
// The native renderer handles it three ways, all consulting this one classifier so nothing diverges:
//   - ShaderAttachment.EnsureMaterial never mounts the ShaderMaterial (and never pins on-demand rendering),
//   - PaintGates never paints the node's raw base fill/texture (the opaque white ColorRect must not paint),
//   - the one screen-read shader with a faithful flat approximation — dark_blur, a full-screen modal dimmer — draws
//     a solid BLACK rect over its own box at the streamed dim amount (ScrimDrawer). Every OTHER screen-read shader
//     (overlay_blend / radial_blur / doom_overlay / vfx_water_reflection_post / distortions) paints NOTHING.
//
// Kept in the protocol library (NOT the Godot ShaderStore, which type-loads Godot) so the Exe test suite covers the
// classification + alpha math without a Godot host — the ShaderStaticRewrite precedent. ShaderStore.Compile calls
// ReferencesScreenRead once per shader; PaintGates + ShaderAttachment read it back via ShaderStore.PeekScreenReads,
// so there is exactly ONE screen-read rule.
public static class ScreenReadShaders
{
    // dark_blur's authored `mix_percentage` default (res://shaders/dark_blur.gdshader: `mix(screen, black, 0.3)`).
    // Used as the scrim opacity when the node never streams the uniform.
    public const float DefaultScrimAlpha = 0.3f;

    // A gdshader samples the framebuffer when its SOURCE references the Godot 4 hint (`hint_screen_texture`) or the
    // Godot 3 built-in name (`SCREEN_TEXTURE`). Substring match is sufficient — the tokens are distinct and a false
    // positive only suppresses an already-broken shader. card_ripple (TIME + COLOR.a) and hsv reference neither.
    public static bool ReferencesScreenRead(string? code) =>
        code is not null &&
        (code.Contains("hint_screen_texture", StringComparison.Ordinal) ||
         code.Contains("SCREEN_TEXTURE", StringComparison.Ordinal));

    // The single screen-read shader we approximate: dark_blur (the full-screen modal scrim). Matched by shader
    // id/path so the drawer knows to paint the flat black scrim; every other screen-read shader paints nothing.
    public static bool IsDarkBlur(string? shaderId) =>
        shaderId is not null && shaderId.Contains("dark_blur", StringComparison.Ordinal);

    // dark_blur's scrim opacity from the streamed uniforms: the `mix_percentage` number param, clamped to [0,1];
    // the shader default (0.3) when the param is absent. dark_blur is `mix(SCREEN_TEXTURE, black, mix_percentage)`;
    // with an undefined screen sample this reduces to "darken whatever renders behind by mix_percentage", i.e. a
    // black rect at alpha = mix_percentage (0 → fully transparent, live-updating as the game fades the dialog in).
    public static float ScrimAlpha(IReadOnlyList<MirrorShaderParam>? parameters)
    {
        float alpha = DefaultScrimAlpha;
        if (parameters is not null)
        {
            foreach (var p in parameters)
            {
                if (p.Kind == "number" && p.Name == "mix_percentage" && p.Number is { } n)
                {
                    alpha = (float)n;
                    break;
                }
            }
        }

        return alpha < 0f ? 0f : alpha > 1f ? 1f : alpha;
    }
}
