// The range-fill sub-layer (progress bars): paints node.Range as a fraction of the node box width. Called from
// _Draw AFTER NinePatchDrawer and BEFORE the text layer.
//
// Web spec: nodeStyles.ts rangeFillStyle L457-462 (width % = clamp((value-min)/(max-min))) rendered by the
// `.mirror-range-fill` element (MirrorView.vue L428-435: left:0 top:0 height:100%, `background: currentColor`,
// opacity 0.55). The web's `currentColor` analog is the node's own tint: we draw the fill WHITE at 0.55 alpha
// and let the engine-applied modulate x self_modulate tint it (same contract as the other drawers). NOTE: STS2
// combat health bars are NOT Godot Range/ProgressBar nodes — they're a clip-mask + nine-patch fill (see
// NinePatchDrawer / TextureDrawer clip-mask), so this path is dormant in combat; it renders any true
// ProgressBar/Slider the producer streams with rangeValue/min/max.

using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Drawers;

public static class RangeDrawer
{
    // The `.mirror-range-fill` translucency (MirrorView.vue: opacity 0.55).
    private const float FillAlpha = 0.55f;

    public static void Draw(CanvasItem ci, MirrorNode node)
    {
        if (node.Range is not { } range)
        {
            return;
        }

        if (TextureDrawer.PaintBox(node) is not { } box || box.Size.X <= 0 || box.Size.Y <= 0)
        {
            return;
        }

        double span = range.Max - range.Min;
        double pct = span > 0 ? System.Math.Clamp((range.Value - range.Min) / span, 0, 1) : 0;
        if (pct <= 0)
        {
            return;
        }

        // Fill the left `pct` of the box, full height, at the box origin (mirrors `.mirror-range-fill`).
        var fill = new Rect2(box.Position, new Vector2((float)(box.Size.X * pct), box.Size.Y));
        ci.DrawRect(fill, new Color(1, 1, 1, FillAlpha)); // white x self_modulate/modulate = the bar's own color
    }
}
