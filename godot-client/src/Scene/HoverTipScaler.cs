// Feature A (WS-VIEW) HoverTip 1.2× scaler. A per-DRAIN pass (never per-frame) driven by SceneReconciler.OnDrained
// (after ApplySpread, before TweenReplayer.Consume) and OnSpreadChanged: it renders every visible NHoverTipSet the
// game is showing 1.2× bigger, anchored so the extra 20% grows AWAY from any screen edge the tip hugs and clamped
// to stay on-screen. Bigger tips = readable keyword/card/creature tooltips at Half render scale on a phone.
//
// The pure-C# HoverTipScaleMath (MirrorProtocol, Exe-tested) owns the anchor + clamp geometry; this controller owns
// the Godot-side plumbing: collect the tip-set roots, measure each direct child's paint-bearing design AABB, hand
// them to the math, convert the returned pivot/clamp into the root view's parent frame, and stamp the scale channel
// (MirrorNodeView.SetHoverTipScale). The measurement reads the STORE transform index — the wire (un-scaled, un-hover)
// design globals — NOT the live view globals, so a prior drain's applied scale can NEVER feed back into the next
// drain's measurement (the store is immune to the client cosmetic). The parent-frame conversion uses the LIVE parent
// view global (feedback-free — the scale lives on the ROOT's local, not its parent — and the exact rendered frame).
//
// The pass early-outs when no NHoverTipSet id is present in OrderedIds (the overwhelmingly common no-tip case).

using System.Collections.Generic;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Scene.Drawers;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public static class HoverTipScaler
{
    // The fixed magnification. 1.2× is the recording-derived target (readable at Half without overflowing typical
    // anchored tips before the clamp engages).
    private const float ScaleFactor = 1.2f;

    // Reused scratch (the pass is single-threaded on the drain callstack): the per-direct-child column AABBs handed to
    // the math, cleared per root.
    private static readonly List<DesignAabb> ColumnScratch = new();

    // Stamp every visible NHoverTipSet root's scale channel for this drain. `views` is the reconciler's live view map;
    // `store` supplies the wire state, transform index, and spread records. No-op when the switch is off or no tip-set
    // is present. A tip-set whose measurement yields no paint-bearing child is stamped back to scale 1 (a tip that
    // just emptied/hid must not keep a stale magnification).
    public static void Apply(MirrorStore store, IReadOnlyDictionary<string, MirrorNodeView> views)
    {
        var state = store.State;
        double designWidth = store.SpreadFactor * StageStretch.BaseDesignWidth;

        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var root)
                || NodeTypeLeaf(root.NodeType) != "NHoverTipSet"
                || !views.TryGetValue(id, out var rootView)
                || !GodotObject.IsInstanceValid(rootView))
            {
                continue;
            }

            // A hidden tip-set (or one hidden by an ancestor) contributes nothing; make sure any prior scale is dropped.
            if (!EffectivelyVisible(state, root))
            {
                rootView.SetHoverTipScale(1f, Vector2.Zero, Vector2.Zero);
                continue;
            }

            var stamp = ComputeStampFor(store, root, rootView, designWidth);
            if (stamp is not { } s)
            {
                rootView.SetHoverTipScale(1f, Vector2.Zero, Vector2.Zero); // nothing paints → un-scale (idempotent)
                continue;
            }

            ApplyStamp(rootView, s);
        }
    }

    // Measure each direct child's paint-bearing design AABB (STORE globals + spread Dx) plus the tip's anchor-owner
    // box, and run the math. The owner box lets the math grow the tip AWAY from the anchored card/creature/HP-bar
    // (R4 defect fix) rather than chasing a screen edge.
    private static HoverTipScaleMath.Stamp? ComputeStampFor(MirrorStore store, MirrorNode root, MirrorNodeView rootView, double designWidth)
    {
        ColumnScratch.Clear();

        foreach (var child in rootView.GetChildren())
        {
            if (child is not MirrorNodeView childView || !GodotObject.IsInstanceValid(childView))
            {
                continue; // effect-attachment children (__text/__spine/…) never bear a tip column
            }

            if (TryMeasureSubtree(store, childView, out var column))
            {
                ColumnScratch.Add(column);
            }
        }

        var (owner, followX, followY) = MeasureOwner(store, root.AnchorOwnerId);
        var kind = ResolveOwnerKind(store, root.AnchorOwnerId);
        return HoverTipScaleMath.ComputeStamp(
            ColumnScratch, designWidth, StageStretch.DesignHeight, ScaleFactor, owner, kind, followX, followY);
    }

    // The tip's owner KIND (#17/#18 growth side), from the anchor-owner node's type leaf + owning scene file.
    private static HoverTipScaleMath.TipOwnerKind ResolveOwnerKind(MirrorStore store, string? ownerId)
    {
        if (ownerId is null || !store.State.Nodes.TryGetValue(ownerId, out var owner))
        {
            return HoverTipScaleMath.TipOwnerKind.None;
        }

        var (file, _) = SceneIdentity.Resolve(ownerId, store.State);
        return HoverTipScaleMath.ResolveOwnerKind(NodeTypeLeaf(owner.NodeType), file);
    }

    // The tip's anchor-owner design AABB + its view-scale FOLLOW delta. R5 (H2): resolve the VISUAL owner first (a 0×0
    // NHandCardHolder → its painting card child) so the box is the card the user sees, not the zero-size anchor.
    // R5 (item 6): if that visual owner sits inside a view-scaled item (the reward/merchant enlargement), forward-map
    // its box through the containing stamp AND return followX/Y = mappedCentre − rawCentre so the tip stays glued to
    // the enlarged owner. Returns (null,0,0) when the tip has no owner / it is unmeasurable → the math falls back to
    // the screen-edge rule.
    private static (DesignAabb? Owner, double FollowX, double FollowY) MeasureOwner(MirrorStore store, string? ownerId)
    {
        if (ownerId is null || !store.State.Nodes.TryGetValue(ownerId, out _))
        {
            return (null, 0, 0);
        }

        // H2: the on-screen thing the tip points at (a 0×0 holder resolves to its painting card child).
        string resolvedId = TipOwnerResolve.ResolveVisualOwnerId(store.State, store.Transforms, store.Spread, ownerId);
        if (!store.State.Nodes.TryGetValue(resolvedId, out var owner)
            || owner.LocalRect is not { } lr
            || !store.Transforms.TryGetGlobal(resolvedId, out var g))
        {
            return (null, 0, 0);
        }

        var rect = new Rect2((float)lr.X, (float)lr.Y, (float)lr.Width, (float)lr.Height);
        double dx = store.Spread.TryGet(resolvedId, out var rec) ? rec.Dx : 0;
        var raw = DesignAabbOf(WireXform(g), rect).ShiftX(dx);

        // Item 6 (R6/WS-TIP): forward-map through EVERY containing view-scale stamp (outer group ∘ inner card), not just
        // one — so a tip on an off-centre card in a scaled GROUP follows the group displacement — and compute the follow
        // delta from the composed mapped-minus-raw centre.
        if (ViewScaler.MapThroughContainingStamps(store.State, resolvedId, raw, out var mapped))
        {
            double followX = ((mapped.MinX + mapped.MaxX) - (raw.MinX + raw.MaxX)) / 2.0;
            double followY = ((mapped.MinY + mapped.MaxY) - (raw.MinY + raw.MaxY)) / 2.0;
            return (mapped, followX, followY);
        }

        return (raw, 0, 0);
    }

    // Union the paint-bearing design AABBs of `view` and every MirrorNodeView descendant into one column box. Returns
    // false when the subtree paints nothing (a pure container / all-hidden branch). Design boxes come from the STORE
    // transform index (feedback-free) with the node's cumulative spread Dx folded in (wide-screen parity).
    private static bool TryMeasureSubtree(MirrorStore store, MirrorNodeView view, out DesignAabb column)
    {
        column = default;
        bool any = false;
        AccumulateSubtree(store, view, ref column, ref any);
        return any;
    }

    private static void AccumulateSubtree(MirrorStore store, MirrorNodeView view, ref DesignAabb column, ref bool any)
    {
        string id = view.NodeId;
        if (store.State.Nodes.TryGetValue(id, out var node) && node.Visible && IsPaintBearing(node)
            && TextureDrawer.PaintBox(node) is { } box && box.Size.X > 0 && box.Size.Y > 0
            && store.Transforms.TryGetGlobal(id, out var g))
        {
            double dx = store.Spread.TryGet(id, out var rec) ? rec.Dx : 0;
            var aabb = DesignAabbOf(WireXform(g), box).ShiftX(dx);
            column = any ? column.Union(aabb) : aabb;
            any = true;
        }

        foreach (var child in view.GetChildren())
        {
            if (child is MirrorNodeView childView && GodotObject.IsInstanceValid(childView))
            {
                AccumulateSubtree(store, childView, ref column, ref any);
            }
        }
    }

    // Convert the math's DESIGN-space pivot + clamp into the root view's PARENT frame (the frame FoldCosmetic works in)
    // and stamp the scale channel. The parent's LIVE global is the exact frame the root's local renders in and is
    // feedback-free (the root's own scale never touches its parent). A translation (the clamp) maps through the basis
    // only. Pure-translation parents (the common UI-anchored tip) make the design→parent scale exact; a rotated/scaled
    // parent leaves the known bounded widescreen residual.
    private static void ApplyStamp(MirrorNodeView rootView, HoverTipScaleMath.Stamp s)
    {
        Transform2D inv = rootView.GetParent() is Node2D parent
            ? parent.GetGlobalTransform().AffineInverse()
            : Transform2D.Identity;

        Vector2 pivot = inv * new Vector2((float)s.PivotX, (float)s.PivotY);
        Vector2 clamp = inv.BasisXform(new Vector2((float)s.ClampX, (float)s.ClampY));
        rootView.SetHoverTipScale((float)s.Scale, pivot, clamp);
    }

    // A node paints (and so contributes to a tip column's box) when it draws texture / fill / nine-patch / range art
    // or carries non-empty text. Mirrors the drawer gates (PaintGates + the _Draw sub-layer set) — a pure layout
    // container with none of these adds nothing to the union.
    private static bool IsPaintBearing(MirrorNode node) =>
        PaintGates.PaintsTexture(node)
        || PaintGates.PaintFill(node)
        || node.NinePatch
        || node.Range is not null
        || node.Text is { Text.Length: > 0 };

    // The design-space AABB of a view-local Rect2 under a global affine — the four transformed corners' min/max (the
    // DesignAabbOf pattern; identical to TextOverlay.DesignAabbOf / CullBounds.OfRect).
    private static DesignAabb DesignAabbOf(Transform2D gt, Rect2 local)
    {
        Vector2 p = local.Position;
        Vector2 sz = local.Size;
        Vector2 c0 = gt * p;
        Vector2 c1 = gt * (p + new Vector2(sz.X, 0));
        Vector2 c2 = gt * (p + new Vector2(0, sz.Y));
        Vector2 c3 = gt * (p + sz);
        float minX = Mathf.Min(Mathf.Min(c0.X, c1.X), Mathf.Min(c2.X, c3.X));
        float minY = Mathf.Min(Mathf.Min(c0.Y, c1.Y), Mathf.Min(c2.Y, c3.Y));
        float maxX = Mathf.Max(Mathf.Max(c0.X, c1.X), Mathf.Max(c2.X, c3.X));
        float maxY = Mathf.Max(Mathf.Max(c0.Y, c1.Y), Mathf.Max(c2.Y, c3.Y));
        return new DesignAabb(minX, minY, maxX, maxY);
    }

    // Wire CSS matrix [a,b,c,d,tx,ty] → Godot Transform2D (identical to SceneReconciler.WireXform).
    private static Transform2D WireXform(IReadOnlyList<double> m) =>
        new((float)m[0], (float)m[1], (float)m[2], (float)m[3], (float)m[4], (float)m[5]);

    // True when the node and every ancestor is Visible (the tip is really on-screen). Mirrors HeldCardLift's gate.
    private static bool EffectivelyVisible(MirrorState state, MirrorNode node)
    {
        var cur = node;
        while (cur is not null)
        {
            if (!cur.Visible)
            {
                return false;
            }

            cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        return true;
    }

    private static string NodeTypeLeaf(string nodeType)
    {
        int dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
