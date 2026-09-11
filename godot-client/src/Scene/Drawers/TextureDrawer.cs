// The backmost self-paint sub-layer of a MirrorNodeView: the node's own fill rect + texture (plain or atlas
// region). Static + stateless — the seam that keeps MirrorNodeView agnostic of paint specifics. Ported from the
// web renderer's paint contract:
//   - fillColor rect     : nodeStyles.ts L229 (`backgroundColor`, gated by the caller's `paintFill` — the
//                          PaintGates.PaintFill decision, i.e. only when the node has NO shaderId so a shader owns
//                          the fill/base itself; the shaderId check lives in PaintGates now so WS-H owns the flip).
//   - plain texture      : nodeStyles.ts L347-353 (background-image, basic stretch — WS-G refines StretchMode 0-6).
//   - atlas-region sprite: nodeStyles.ts L266-315 fit-box math (keep-aspect fit + textureMargin + flips), drawn
//                          via DrawTextureRectRegion off a decode-once atlas page (atlasBaker's contract).
//
// The CanvasItem's own modulate × self_modulate is applied by the engine to every draw here, so colors/textures
// are passed at full white and the node's tint/alpha compose automatically (mirrors the web self-layer filter).

using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Drawers;

public static class TextureDrawer
{
    // Shared white StyleBoxFlat reused (mutated per draw) to stencil ROUNDED clip masks (health-bar capsules).
    private static StyleBoxFlat? _maskBox;

    // Paint the node's fill rect (when applicable) then its texture (already gated: `texture` is non-null only when
    // the node's texture actually paints — see PaintGates.PaintsTexture; `paintFill` is PaintGates.PaintFill).
    //
    // WS-ATLAS: `clientRegion`/`clientMargin` are the region+margin the client resolved from a standalone AtlasTexture
    // `.tres` (relic/intent icon), with `texture` being the whole atlas PAGE. The WIRE region WINS: they are consulted
    // ONLY when the node streamed NO TextureRegion (an atlas node whose region the producer didn't supply). Both null
    // (every non-atlas-client-crop caller) → identical to the pre-WS-ATLAS draw.
    public static void Draw(
        CanvasItem ci,
        MirrorNode node,
        Texture2D? texture,
        bool paintFill,
        MirrorRect? clientRegion = null,
        MirrorRect? clientMargin = null)
    {
        // Clip-only (mode 1): the node's own paint is the clip STENCIL, not visible content. WS-E/nodeStyle
        // suppress a clip node's texture (web parity), so a clip node that draws NOTHING would mask its whole
        // subtree to an EMPTY shape and every descendant vanishes (the disappearing health bars). Draw an opaque
        // box — rounded to the capsule when nine-patch margins imply a rounded clip, mirroring the web's
        // overflow:hidden + border-radius. Godot's ClipChildrenMode.Only (set on the view) uses this draw as the
        // mask and does NOT display it; AndDraw(2) nodes already draw their own content as the mask.
        //
        // Godot caveat: NESTED clip_children is a no-op — an ancestor clip already owns the CanvasGroup, so a
        // nested clip's CLIP_ONLY never engages and its opaque mask box would draw VISIBLY, occluding the whole
        // subtree (the health-bar HpForegroundContainer[clip] > Mask[clip] pair). So only the OUTERMOST clip in a
        // chain draws the stencil; a nested clip draws nothing (its fills are cropped by the outer clip, and the
        // health-bar pill fill/background textures supply the rounded ends). Web/CSS nests overflow fine; native
        // can't, so this is the faithful native reproduction.
        if (node.ClipChildren == 1)
        {
            if (!IsNestedUnderClip(ci))
            {
                DrawClipMask(ci, node);
            }

            return;
        }

        if (paintFill && node.FillColor is { } fill && PaintBox(node) is { } fillBox)
        {
            ci.DrawRect(fillBox, new Color((float)fill.R, (float)fill.G, (float)fill.B, (float)fill.A));
        }

        if (texture is null)
        {
            return;
        }

        // Region precedence (WS-ATLAS): the WIRE region (node.TextureRegion) always wins and pairs with the wire
        // margin — this is the pre-existing atlas path, unchanged. A client-resolved region (from a standalone
        // AtlasTexture `.tres` whose page is `texture`) is used ONLY when the wire streamed no region.
        if (node.TextureRegion is { } wireRegion)
        {
            DrawAtlasRegion(ci, node, texture, wireRegion, node.TextureMargin);
        }
        else if (clientRegion is { } cr)
        {
            DrawAtlasRegion(ci, node, texture, cr, clientMargin);
        }
        else
        {
            DrawPlain(ci, node, texture);
        }
    }

    // The node's own paint box in its transform-local frame.
    public static Rect2? PaintBox(MirrorNode node)
    {
        if (node.LocalRect is { } lr)
        {
            return new Rect2((float)lr.X, (float)lr.Y, (float)lr.Width, (float)lr.Height);
        }

        return null;
    }

    // Plain (non-atlas) texture: place per Godot TextureRect stretch mode, using the web's background-size analog
    // (stretchModeToBackgroundSize, nodeStyles.ts L347-353): Scale/Tile/default → fill (100% 100%); the Keep*
    // family → contain (uniform fit, centered); KeepAspectCovered → cover (uniform fill, centered, cropped). The
    // web does NOT flip plain textures (only atlas regions), so we don't either (parity).
    private static void DrawPlain(CanvasItem ci, MirrorNode node, Texture2D texture)
    {
        if (PaintBox(node) is not { } box)
        {
            ci.DrawTexture(texture, Vector2.Zero);
            return;
        }

        Vector2 tex = texture.GetSize();
        Fit fit = StretchFit(node.TextureStretchMode);
        if (fit == Fit.Fill || tex.X <= 0 || tex.Y <= 0 || box.Size.X <= 0 || box.Size.Y <= 0)
        {
            ci.DrawTextureRect(texture, box, tile: false);
            return;
        }

        double sx = box.Size.X / tex.X;
        double sy = box.Size.Y / tex.Y;
        if (fit == Fit.Cover)
        {
            // Uniform scale to COVER the box, centered, cropping the overflow: fill the box from a centered
            // sub-region of the texture (background-size: cover + background-position: center).
            double s = System.Math.Max(sx, sy);
            double srcW = box.Size.X / s;
            double srcH = box.Size.Y / s;
            var src = new Rect2((float)((tex.X - srcW) / 2), (float)((tex.Y - srcH) / 2), (float)srcW, (float)srcH);
            ci.DrawTextureRectRegion(texture, box, src);
        }
        else
        {
            // Contain: uniform scale to FIT inside the box, centered, no crop (background-size: contain + center).
            double s = System.Math.Min(sx, sy);
            double w = tex.X * s;
            double h = tex.Y * s;
            var dest = new Rect2(
                (float)(box.Position.X + (box.Size.X - w) / 2),
                (float)(box.Position.Y + (box.Size.Y - h) / 2),
                (float)w,
                (float)h);
            ci.DrawTextureRect(texture, dest, tile: false);
        }
    }

    private enum Fit
    {
        Fill,
        Contain,
        Cover,
    }

    // Godot TextureRect StretchMode → the web's background-size bucket (stretchModeToBackgroundSize).
    private static Fit StretchFit(int? mode) => mode switch
    {
        6 => Fit.Cover, // KeepAspectCovered
        2 or 3 or 4 or 5 => Fit.Contain, // Keep / KeepCentered / KeepAspect / KeepAspectCentered
        _ => Fit.Fill, // 0 Scale, 1 Tile, null/unknown
    };

    // True when a CanvasItem ancestor already clips its children — Godot then ignores THIS node's clip, so its
    // stencil box must not be drawn (it would render visibly and occlude the subtree).
    private static bool IsNestedUnderClip(CanvasItem ci)
    {
        for (Node? p = ci.GetParent(); p is not null; p = p.GetParent())
        {
            if (p is CanvasItem c && c.ClipChildren != CanvasItem.ClipChildrenMode.Disabled)
            {
                return true;
            }
        }

        return false;
    }

    // Draw the opaque clip STENCIL for a clip-only node. Square by default; a rounded capsule when the node's
    // nine-patch margins imply a rounded clip (the health-bar Mask). The engine hides this via ClipChildrenMode.
    private static void DrawClipMask(CanvasItem ci, MirrorNode node)
    {
        if (PaintBox(node) is not { } box || box.Size.X <= 0 || box.Size.Y <= 0)
        {
            return;
        }

        float radius = ClipCornerRadius(node);
        if (radius <= 0)
        {
            ci.DrawRect(box, Colors.White);
            return;
        }

        var sb = _maskBox ??= new StyleBoxFlat { BgColor = Colors.White };
        sb.SetCornerRadiusAll(Mathf.RoundToInt(radius));
        ci.DrawStyleBox(sb, box);
    }

    // The corner radius that rounds a clip node's box to its capsule texture (health_bar.png), restated from
    // nodeStyles.ts's clipCornerRadius: the nine-patch patch margin IS the cap radius, clamped to
    // half the box so pill-height margins round into fully-round ends. 0 (square clip) when there's no rounding.
    private static float ClipCornerRadius(MirrorNode node)
    {
        if (node.TextureUrl is null || node.NinePatchMargins is not { } m || PaintBox(node) is not { } box ||
            box.Size.X <= 0 || box.Size.Y <= 0)
        {
            return 0;
        }

        double maxMargin = System.Math.Max(System.Math.Max(m.Left, m.Right), System.Math.Max(m.Top, m.Bottom));
        return (float)System.Math.Min(System.Math.Min(maxMargin, box.Size.X / 2), box.Size.Y / 2);
    }

    // Atlas-region sprite: reproduce the Control's keep-aspect fit (nodeStyles.ts L266-315) and crop the region out
    // of the decode-once atlas page via DrawTextureRectRegion. Requires a transform + localRect (the fit is defined
    // relative to the node box); without them the region can't be placed, so paint nothing (web parity). `margin` is
    // the AtlasTexture margin frame (the wire margin for a wire region, the `.tres` margin for a client region): Godot
    // reports get_size() = region.size + margin.size and draws the region pixels at margin.position inside that frame,
    // which this fit-box math reproduces exactly (matching the host's server-crop framed sprite pixel-for-pixel).
    private static void DrawAtlasRegion(CanvasItem ci, MirrorNode node, Texture2D texture, MirrorRect region, MirrorRect? margin)
    {
        if (node.LocalRect is not { } lr || node.Transform is null)
        {
            return;
        }

        double mx = margin?.X ?? 0;
        double my = margin?.Y ?? 0;
        double texW = region.Width + (margin?.Width ?? 0);
        double texH = region.Height + (margin?.Height ?? 0);
        if (texW <= 0 || texH <= 0)
        {
            return;
        }

        var src = new Rect2((float)region.X, (float)region.Y, (float)region.Width, (float)region.Height);

        // Scale (0) / Tile (1) / null → fill the box anisotropically. Keep-Aspect family (2-5) → uniform contain fit.
        bool isFill = node.TextureStretchMode is null or 0 or 1;
        if (isFill)
        {
            double scaleX = lr.Width > 0 ? lr.Width / texW : 1;
            double scaleY = lr.Height > 0 ? lr.Height / texH : 1;
            double x0 = lr.X + mx * scaleX;
            double y0 = lr.Y + my * scaleY;
            double w = region.Width * scaleX;
            double h = region.Height * scaleY;
            // Godot flips a texture-rect-region when the DEST rect size is negative (canvas_item_add_texture_rect_
            // region normalizes size + sets FLIP), keeping the same top-left footprint — exactly the web's negative
            // scale about the top-left origin.
            var dest = new Rect2(
                (float)x0,
                (float)y0,
                (float)(node.TextureFlipH ? -w : w),
                (float)(node.TextureFlipV ? -h : h));
            ci.DrawTextureRectRegion(texture, dest, src);
        }
        else
        {
            double fit = lr.Width > 0 && lr.Height > 0 ? System.Math.Min(lr.Width / texW, lr.Height / texH) : 1;
            double cx = (lr.Width - texW * fit) / 2;
            double cy = (lr.Height - texH * fit) / 2;
            var dest = new Rect2(
                (float)(lr.X + cx + mx * fit),
                (float)(lr.Y + cy + my * fit),
                (float)(region.Width * fit),
                (float)(region.Height * fit));
            ci.DrawTextureRectRegion(texture, dest, src);
        }
    }
}
