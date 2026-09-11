// WS-SHADER dark_blur approximation. dark_blur is a full-screen modal dimmer: `mix(SCREEN_TEXTURE, black,
// mix_percentage)`. Natively the screen sample is undefined (no BackBufferCopy → white on Mali), so instead of the
// real (unrenderable) shader we draw a flat BLACK rect over the node's OWN paint box at alpha = the streamed
// mix_percentage. With an undefined screen sample the real shader reduces to "darken whatever renders behind by
// mix_percentage", and drawing the black rect in the node's own paint position darkens exactly that (the deck
// dialog + map render behind the scrim in the correct CanvasLayer order — paint order is untouched). This is a
// DRAWER PATH called from MirrorNodeView._Draw, NOT a new layer, so the fixed sub-layer order is preserved.
// mix_percentage fades 0 → 0.3 as the game opens the dialog; 0 → fully transparent (nothing drawn). Every OTHER
// screen-read shader paints nothing (PaintGates suppresses its base and this drawer only matches dark_blur).

using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Drawers;

public static class ScrimDrawer
{
    // Draw dark_blur's flat black scrim when this node is its backstop. The engine multiplies the node's modulate ×
    // self_modulate onto this DrawRect exactly like any other drawer sub-layer, so a faded/tinted backstop composes
    // with the streamed dim amount.
    public static void Draw(CanvasItem ci, MirrorNode node)
    {
        if (!ScreenReadShaders.IsDarkBlur(node.ShaderId))
        {
            return;
        }

        if (TextureDrawer.PaintBox(node) is not { } box || box.Size.X <= 0 || box.Size.Y <= 0)
        {
            return;
        }

        float alpha = ScreenReadShaders.ScrimAlpha(node.ShaderParams);
        if (alpha <= 0f)
        {
            return; // fully transparent (dialog just opening / faded out) — nothing to paint
        }

        ci.DrawRect(box, new Color(0f, 0f, 0f, alpha));
    }
}
