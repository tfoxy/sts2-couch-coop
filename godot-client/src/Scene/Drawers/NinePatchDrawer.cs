// The nine-patch sub-layer of a MirrorNodeView: 9-slices the node's texture across its box using
// node.NinePatchMargins. Called from _Draw AFTER TextureDrawer and BEFORE RangeDrawer.
//
// Native path: RenderingServer.CanvasItemAddNinePatch — the EXACT primitive Godot's own NinePatchRect._draw
// calls (scene/gui/nine_patch_rect.cpp:48), so the border/edge/center slicing AND the degenerate-margin clamp
// (margins overlapping the source or the box get scaled down internally by the same code) match what the game
// draws 1:1, with no need for the web's CSS border-image + stretched-under fallback (nodeStyles.ts, which
// exists only because CSS border-image can't clamp).
//
// Over-atlas variant (nodeStyles.ts / ninePatch.ts): the node's texture is a shared atlas PAGE and the 9-slice
// SOURCE is node.TextureRegion within that page — passed as the `source` rect (the whole page for a plain
// texture). The engine-applied modulate x self_modulate tints the white-drawn slices (e.g. HpForeground's red
// selfModulate paints the health fill), so the per-primitive modulate is left white.

using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Drawers;

public static class NinePatchDrawer
{
    // `texture` is the node's resolved page/texture (null until fetched, or when the node doesn't paint it).
    public static void Draw(CanvasItem ci, MirrorNode node, Texture2D? texture)
    {
        // Only a genuine nine-patch node paints here.
        if (node is not { NinePatch: true, NinePatchMargins: { } m })
        {
            return;
        }

        // A clip-only (mode 1) nine-patch (the health-bar Mask) uses its texture as the clip STENCIL, not as a
        // painted nine-patch — TextureDrawer draws its (rounded) mask box, and MirrorNodeView never fetches the
        // texture for it (PaintsTexture is false), so there'd be nothing to slice anyway. Skip.
        if (node.ClipChildren == 1 || texture is null)
        {
            return;
        }

        if (TextureDrawer.PaintBox(node) is not { } rect || rect.Size.X <= 0 || rect.Size.Y <= 0)
        {
            return;
        }

        // Source: the atlas region within the page, else the whole texture.
        Rect2 src = node.TextureRegion is { } r
            ? new Rect2((float)r.X, (float)r.Y, (float)r.Width, (float)r.Height)
            : new Rect2(Vector2.Zero, texture.GetSize());

        RenderingServer.CanvasItemAddNinePatch(
            ci.GetCanvasItem(),
            rect,
            src,
            texture.GetRid(),
            new Vector2((float)m.Left, (float)m.Top),
            new Vector2((float)m.Right, (float)m.Bottom),
            RenderingServer.NinePatchAxisMode.Stretch,
            RenderingServer.NinePatchAxisMode.Stretch,
            drawCenter: true,
            Colors.White); // tint composes from the item's self_modulate x modulate (the engine applies it)
    }
}
