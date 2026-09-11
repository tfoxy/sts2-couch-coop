using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.Input;

namespace CouchCoop.MirrorProtocol.SceneModel;

// R8 (WS-2) — the PURE per-drain view-scale stamp index. This replaces the whole stateful native ViewScaler
// machinery (LastStamped / ThisStamped / LastApplied / the reset loop / TryCarryGroupStamp / ViewScaleGroupCarry /
// the tween-settle backstop) with ONE function of THIS DRAIN'S WIRE STATE:
//
//     Build(state, transforms, spread, …)  →  id → Stamped
//
// WHY (the event-option scale flicker, 3rd recurrence). The old pass walked the live Godot views, wrote the scale
// through a setter, and remembered what it had stamped so it could UN-stamp on the next drain. Every per-drain gate
// it grew (tween-owned transform, tween-owned ancestor, not-yet-visible, a momentarily null measure, a clip reject,
// a missing/recycled view) therefore had TWO possible outcomes — "defer" or "drop to scale 1" — and any gate that
// dropped produced a visible snap-back on an otherwise idle screen. Round-4 (TWEENHOLD), round-6 (settle backstop)
// and round-7 (GROUPCARRY) each patched ONE of those gates with a carry; the class survived because the carry set
// and the drop set were maintained by hand.
//
// The structural cure is to remove the *choice*: there is no remembered stamp to drop, and no separate "apply" pass
// whose gating can disagree with the renderer. The index is rebuilt from scratch every drain; a node either resolves
// a stamp from the wire state THIS DRAIN or it does not, and the value is folded at the single transform choke point
// (MirrorNodeView.FoldCosmetic, via ViewScaler.TryGetParentStamp) — the same place the spread/lift/block channels
// fold. Consequences that used to need bespoke code and now hold BY CONSTRUCTION:
//   * a StaticBake CLONE (a fresh MirrorNodeView carrying the same wire id) folds the same stamp as its live
//     original, so a baked region can never render a view-scaled subtree at scale 1;
//   * a POOL-RECYCLED view re-resolves on its first fold instead of inheriting a stale channel;
//   * RefreshEffects / a light apply / a tween settle all re-fold through the same resolve;
//   * a TWEEN-owned node needs no gate at all — TweenReplayer folds its endpoints through FoldCosmetic
//     (FoldForTween), so the scale rides the tween instead of being deferred until it settles.
//
// The web mirror (frontend/src/mirror/mirrorRenderer.ts applyViewScalePass) is the reference implementation: it has
// no cross-drain stamp memory either, and it converts the design-space stamp through the WIRE parent global
// (`shiftedParentGlobal`), not the rendered one — which is also what makes NESTED stamps (the card-reward 1.10 group
// ∘ per-card 1.15) compose correctly. This index does the same conversion, so both clients agree by construction.
//
// PURE: no Godot, no environment, no static mutable state. Kill switches stay with the consumer (ViewScaler).
public static class ViewScaleStampIndex
{
    // One node's resolved view-scale stamp for a single drain.
    //   * <see cref="Design"/>/<see cref="DesignBox"/>/<see cref="ScaledBox"/>/<see cref="IsGroup"/> are the
    //     DESIGN-space quantities the input registry, the tap probe and the HoverTip owner-compose consume
    //     (identical shape to the old ViewScaler.AppliedStamp, so those consumers are unchanged).
    //   * <see cref="PivotX"/>/<see cref="PivotY"/>/<see cref="ClampX"/>/<see cref="ClampY"/> are the SAME stamp
    //     pre-converted into the node's PARENT frame — exactly what MirrorNodeView.FoldCosmetic needs. Converting
    //     here (off the wire parent global) instead of at fold time is what makes a bake clone — whose Godot parent
    //     chain is a throwaway SubViewport tree, not the live one — fold identically to the live view.
    public readonly record struct Stamped(
        string Id,
        HoverTipScaleMath.Stamp Design,
        DesignAabb DesignBox,
        DesignAabb ScaledBox,
        bool IsGroup,
        double PivotX,
        double PivotY,
        double ClampX,
        double ClampY);

    // A shared empty index (the overwhelmingly common case — every combat/map/rest drain).
    public static readonly IReadOnlyDictionary<string, Stamped> Empty =
        new Dictionary<string, Stamped>(0, StringComparer.Ordinal);

    // Build this drain's stamps. Returns an EMPTY dictionary when no view-scale scene is present (the cheap presence
    // gate — a per-node SceneFilePath string check, no scene-identity walk), so combat pays one dictionary walk.
    //
    //   `designWidth`  the widened design width (1920·spreadFactor).
    //   `designHeight` StageStretch.DesignHeight (1080).
    //   `tweenEndpointLocals` optional id → END LOCAL transform 6-tuple for a transform tween pending/active THIS
    //                  drain. A GROUP with an endpoint is measured THERE rather than at its streamed box (WS6): the
    //                  consumer folds the endpoint as that node's transform for the tween window, so the stamp has to
    //                  be measured in the same frame — that is what makes the shop OPEN slide render scaled and stops
    //                  the CLOSE slide being clamped back on-stage off a stale open-position measure. With no
    //                  endpoints supplied the P4 closed-shop guard behaviour is unchanged (parked ⇒ no stamp).
    //   `paintBearing` optional override of the "does this node draw anything" predicate used by the per-ITEM subtree
    //                  union fallback. The Godot consumer passes its own gate (which additionally consults live
    //                  shader mount state); tests/probes use the structural default.
    public static Dictionary<string, Stamped> Build(
        MirrorState state,
        GlobalTransformIndex transforms,
        SpreadIndex spread,
        double designWidth,
        double designHeight,
        IReadOnlyDictionary<string, IReadOnlyList<double>>? tweenEndpointLocals = null,
        Func<MirrorNode, bool>? paintBearing = null)
    {
        var result = new Dictionary<string, Stamped>(StringComparer.Ordinal);
        if (!AnyViewScaleScenePresent(state))
        {
            return result;
        }

        Dictionary<string, List<string>>? children = null; // built lazily for the per-item union fallback

        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            // The SINGLE resolve choke point is ViewScale itself: this index never re-implements the table walk nor
            // any candidate pre-filter of its own (beyond the AnyViewScaleScenePresent presence gate, which is
            // ViewScale.IsRootFile). Entry matching, fast paths and pre-filters belong in ViewScale.ResolveFor so the
            // table owner can keep the per-drain whole-tree resolve cheap in one place — re-deriving them here would
            // silently diverge from the table (and from the web twin). This index owns only per-drain measurement,
            // stamping and caching.
            var res = ViewScale.ResolveFor(id, state);
            if (!res.IsActive)
            {
                continue;
            }

            // NOTE (R10 WS-F): a stamp is deliberately NOT gated on visibility here — an invisible node draws
            // nothing, so stamping it is free, and dropping it is what made the reappear frame render at scale 1
            // (StampSurvivesTransientInvisible). The coordinate-only INPUT registry is where an invisible stamp does
            // harm (it silently claims pointers), so the EffectivelyVisible gate lives in ViewScaleInputRegistry.Build.

            // MEASURE. A GROUP scales about its OWN (anchor-widened) box so a focused/enlarged child can never move
            // it; a per-ITEM entry uses its own paint box, falling back to the union of its paint-bearing subtree.
            // R8: a GROUP whose own rect is momentarily degenerate now ALSO falls back to the union instead of
            // dropping the stamp — a degenerate box cannot be "immune to a child" anyway, and dropping it is exactly
            // the transient that the old code needed ViewScaleGroupCarry to paper over.
            DesignAabb? measured = res.IsGroup
                ? MeasureGroupBox(state, transforms, spread, node)
                : MeasureItemBox(state, transforms, spread, node);
            if (measured is null)
            {
                children ??= BuildChildren(state);
                measured = MeasureSubtreeUnion(state, transforms, spread, children, node, paintBearing);
            }

            if (measured is not { } box)
            {
                continue; // nothing measurable this drain — no stamp (and nothing stale to leave behind)
            }

            // WS6 EFFECTIVE box (extends the round-6 endpoint stamp from "only when the streamed box is parked" to
            // "whenever a transform tween owns this GROUP"). While a tween owns the node the consumer folds the
            // tween's ENDPOINT as the node's transform, so the stamp composed onto it must be measured there too.
            // Measuring the streamed box instead mixes two different positions; the shop CLOSE slide is the visible
            // failure — the producer suppresses per-frame transforms for the tween window, so the streamed box still
            // holds the OPEN position while the folded transform is already the CLOSED one, and the clamp computed
            // for the open box dragged the closing panel back on-stage.
            if (res.IsGroup
                && TryMeasureAtTweenEndpoint(state, transforms, spread, node, tweenEndpointLocals, out var endBox))
            {
                box = endBox;
            }

            // P4 closed-shop phantom guard: a node can be Visible yet PARKED entirely off-stage (the closed shop's
            // SlotsContainer at local y≈−1000). AxisClamp would drag that whole box back on-screen. Reject when the
            // EFFECTIVE box has no overlap with the stage at all — which covers a resting closed shop AND a CLOSE
            // slide (its endpoint is off-stage), while the shop OPEN slide passes because its endpoint is on-stage.
            if (box.FullyOutside(designWidth, designHeight, 0))
            {
                continue;
            }

            var stamp = HoverTipScaleMath.ComputeAnchoredStamp(
                box, res.Scale, designWidth, designHeight, res.Pivot, res.TranslateX, res.TranslateY, res.NoClamp);
            if (stamp is not { } s)
            {
                continue; // degenerate box
            }

            // The ENLARGED box must stay inside every clip-children ancestor (a scaled item must not spill past a
            // scroll/mask edge).
            var scaledBox = ViewScaleInputRegistry.ScaledBox(box, s);
            if (!WithinClipAncestors(state, transforms, spread, node, scaledBox))
            {
                continue;
            }

            var (px, py, cx, cy) = ToParentFrame(state, transforms, spread, node, s);
            result[id] = new Stamped(id, s, box, scaledBox, res.IsGroup, px, py, cx, cy);
        }

        return result;
    }

    // The stamps as the pure input-registry / HoverTip-compose type, in paint order (topmost last) — the shape
    // ViewScaleInputRegistry.Build and MapThroughContainingStamps consume. `state.OrderedIds` drives the order so the
    // list parallels the old ViewScaler.Registry exactly.
    public static List<ViewScaleInputRegistry.Applied> ToApplied(
        MirrorState state, IReadOnlyDictionary<string, Stamped> index)
    {
        var applied = new List<ViewScaleInputRegistry.Applied>(index.Count);
        if (index.Count == 0)
        {
            return applied;
        }

        foreach (var id in state.OrderedIds)
        {
            if (index.TryGetValue(id, out var s))
            {
                applied.Add(new ViewScaleInputRegistry.Applied(s.Id, s.Design, s.DesignBox, s.ScaledBox, s.IsGroup));
            }
        }

        return applied;
    }

    // BELT (the StaticBake half of the fix): every view-scaled node AND its whole subtree is kept out of the static
    // bake. The fold is already correct by construction inside a bake clone (a clone carries the live wire id, so it
    // resolves the same stamp), but a pre-composited quad of a cosmetically-scaled subtree is also a class of frozen
    // pixels we simply never want — a re-bake cycle over a scaled surface is what turns any future fold mismatch into
    // the "options snap back every few seconds" report. View-scale screens (rewards / card reward / shop / events)
    // are never the combat band the bake exists for, so the coverage cost is nil.
    public static void CollectBakeExcluded(
        MirrorState state, IReadOnlyDictionary<string, Stamped> index, ISet<string> into)
    {
        if (index.Count == 0)
        {
            return;
        }

        foreach (var id in state.OrderedIds)
        {
            if (index.ContainsKey(id))
            {
                into.Add(id);
                continue;
            }

            for (var cur = state.Nodes.GetValueOrDefault(id); cur is not null; cur = Parent(state, cur))
            {
                if (index.ContainsKey(cur.Id))
                {
                    into.Add(id);
                    break;
                }
            }
        }
    }

    // ---- measurement ------------------------------------------------------------------------------------------

    // GROUP measure: the node's OWN LocalRect, anchor-widened by the SpreadRecord RenderedWidth when the node
    // stretched on a wide stage, folded through its wire global and shifted by its absolute spread Dx.
    private static DesignAabb? MeasureGroupBox(
        MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread, MirrorNode node)
    {
        if (node.LocalRect is not { } lr || lr.Width <= 0 || lr.Height <= 0
            || !transforms.TryGetGlobal(node.Id, out var g))
        {
            return null;
        }

        var (dx, width) = SpreadOf(spread, node.Id, lr.Width);
        return CullBounds.OfRect(g, lr.X, lr.Y, width, lr.Height).ShiftX(dx);
    }

    // Per-ITEM measure: the node's own LocalRect paint box.
    private static DesignAabb? MeasureItemBox(
        MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread, MirrorNode node)
    {
        if (PaintBox(node) is not { } r || r.W <= 0 || r.H <= 0 || !transforms.TryGetGlobal(node.Id, out var g))
        {
            return null;
        }

        double dx = spread.TryGet(node.Id, out var rec) ? rec.Dx : 0;
        return CullBounds.OfRect(g, r.X, r.Y, r.W, r.H).ShiftX(dx);
    }

    // Fallback measure: the union of the node's own + every descendant's paint-bearing design box (a reward-screen
    // NCard's own box is 0×0 — its art lives in descendants).
    private static DesignAabb? MeasureSubtreeUnion(
        MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread,
        IReadOnlyDictionary<string, List<string>> children, MirrorNode root, Func<MirrorNode, bool>? paintBearing)
    {
        DesignAabb union = default;
        bool any = false;
        Accumulate(root);
        return any ? union : null;

        void Accumulate(MirrorNode node)
        {
            if (node.Visible && (paintBearing ?? DefaultPaintBearing)(node) && PaintBox(node) is { } r
                && r.W > 0 && r.H > 0 && transforms.TryGetGlobal(node.Id, out var g))
            {
                double dx = spread.TryGet(node.Id, out var rec) ? rec.Dx : 0;
                var aabb = CullBounds.OfRect(g, r.X, r.Y, r.W, r.H).ShiftX(dx);
                union = any ? union.Union(aabb) : aabb;
                any = true;
            }

            if (!children.TryGetValue(node.Id, out var kids))
            {
                return;
            }

            foreach (var kid in kids)
            {
                if (state.Nodes.TryGetValue(kid, out var kn))
                {
                    Accumulate(kn);
                }
            }
        }
    }

    // Measure a GROUP at a pending/active transform tween's ENDPOINT (the shop open/close slide). Mirrors the group
    // measure exactly; only the transform differs. False when there is no usable endpoint or the parent global is
    // missing (the compose frame would be untrustworthy). WS6: it no longer rejects an off-stage endpoint itself —
    // the caller applies the SHARED FullyOutside guard to whichever box it ends up with, so a close slide (off-stage
    // endpoint) and a resting parked group are rejected by the same test.
    private static bool TryMeasureAtTweenEndpoint(
        MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread, MirrorNode node,
        IReadOnlyDictionary<string, IReadOnlyList<double>>? endpoints,
        out DesignAabb box)
    {
        box = default;
        if (endpoints is null || !endpoints.TryGetValue(node.Id, out var endpointLocal)
            || node.LocalRect is not { } lr || lr.Width <= 0 || lr.Height <= 0)
        {
            return false;
        }

        IReadOnlyList<double>? parentGlobal = Affine.Identity;
        if (node.ParentId is { } pid && !transforms.TryGetGlobal(pid, out parentGlobal))
        {
            return false;
        }

        var endpointGlobal = ViewScaleTweenStamp.EndpointGlobal(endpointLocal, parentGlobal);
        if (endpointGlobal is null)
        {
            return false;
        }

        var (dx, width) = SpreadOf(spread, node.Id, lr.Width);
        box = ViewScaleTweenStamp.DesignBox(endpointGlobal, lr.X, lr.Y, width, lr.Height).ShiftX(dx);
        return true;
    }

    // ---- design → parent frame --------------------------------------------------------------------------------

    // Re-express the DESIGN-space stamp in the node's PARENT frame, through the parent's WIRE global with the
    // PARENT's own absolute spread Dx folded into its origin. That is exactly the frame MirrorNodeView.FoldCosmetic
    // works in: it adds the node's parent-relative SpreadOffset to the local origin and THEN scales about this pivot,
    // and the node's rendered design position is parentWireGlobal·(local + spreadOffset) + (parentDx, 0).
    //
    // The parent's *rendered* Godot global is deliberately NOT used (that is what the pre-R8 code did): it bakes in
    // any ancestor's own cosmetic fold, so mapping a design-space (wire) point through it is not the same point, and
    // a bake clone's throwaway parent chain would produce a different answer than the live view. Web's
    // `shiftedParentGlobal` does the same thing, which is why nested stamps (group ∘ card) compose identically on
    // both clients. A degenerate/singular parent basis falls back to identity (design == parent frame).
    private static (double Px, double Py, double Cx, double Cy) ToParentFrame(
        MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread, MirrorNode node,
        HoverTipScaleMath.Stamp s)
    {
        IReadOnlyList<double> parentGlobal = Affine.Identity;
        double parentDx = 0;
        if (node.ParentId is { } pid)
        {
            if (!transforms.TryGetGlobal(pid, out parentGlobal))
            {
                parentGlobal = Affine.Identity;
            }

            if (spread.TryGet(pid, out var prec))
            {
                parentDx = prec.Dx;
            }
        }

        double a = parentGlobal[0], b = parentGlobal[1], c = parentGlobal[2], d = parentGlobal[3];
        double tx = parentGlobal[4] + parentDx, ty = parentGlobal[5];
        double det = (a * d) - (b * c);
        if (!double.IsFinite(det) || Math.Abs(det) < 1e-9)
        {
            return (s.PivotX, s.PivotY, s.ClampX, s.ClampY);
        }

        // L = [[a,c],[b,d]] (x' = a·x + c·y + tx). L⁻¹ = (1/det)·[[d,−c],[−b,a]].
        double ia = d / det, ic = -c / det, ib = -b / det, idd = a / det;
        double vx = s.PivotX - tx, vy = s.PivotY - ty;
        double px = (ia * vx) + (ic * vy);
        double py = (ib * vx) + (idd * vy);

        // The clamp is a post-scale TRANSLATION, so only the linear part applies (no origin subtraction).
        double cx = (ia * s.ClampX) + (ic * s.ClampY);
        double cy = (ib * s.ClampX) + (idd * s.ClampY);
        return (px, py, cx, cy);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------

    // The enlarged box must stay inside every clip-children ancestor's design box (a stretched clip uses its
    // anchor-widened rendered width). Pure port of the old ViewScaler.WithinClipAncestors.
    private static bool WithinClipAncestors(
        MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread, MirrorNode node, DesignAabb scaledBox)
    {
        for (var p = Parent(state, node); p is not null; p = Parent(state, p))
        {
            if (p.ClipChildren == 0 || p.LocalRect is not { } pr || pr.Width <= 0 || pr.Height <= 0
                || !transforms.TryGetGlobal(p.Id, out var pg))
            {
                continue;
            }

            var (dx, width) = SpreadOf(spread, p.Id, pr.Width);
            var clip = CullBounds.OfRect(pg, pr.X, pr.Y, width, pr.Height).ShiftX(dx);
            if (scaledBox.MinX < clip.MinX || scaledBox.MaxX > clip.MaxX
                || scaledBox.MinY < clip.MinY || scaledBox.MaxY > clip.MaxY)
            {
                return false;
            }
        }

        return true;
    }

    // True when at least one node belongs to a view-scale scene — the CHEAP whole-pass presence gate (a per-node
    // SceneFilePath string check, NO scene-identity parent walk).
    public static bool AnyViewScaleScenePresent(MirrorState state)
    {
        foreach (var node in state.Nodes.Values)
        {
            if (node.SceneFilePath is { } f && ViewScale.IsRootFile(f))
            {
                return true;
            }
        }

        return false;
    }

    private static (double Dx, double Width) SpreadOf(SpreadIndex spread, string id, double streamedWidth)
    {
        if (!spread.TryGet(id, out var rec))
        {
            return (0, streamedWidth);
        }

        return (rec.Dx, rec.RenderedWidth > 0 ? rec.RenderedWidth : streamedWidth);
    }

    private static Dictionary<string, List<string>> BuildChildren(MirrorState state)
    {
        var children = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var id in state.OrderedIds)
        {
            if (state.Nodes.TryGetValue(id, out var node) && node.ParentId is { } pid)
            {
                if (!children.TryGetValue(pid, out var list))
                {
                    list = new List<string>();
                    children[pid] = list;
                }

                list.Add(id);
            }
        }

        return children;
    }

    // The node's own paint box in its transform-local frame — the pure twin of the
    // godot-client TextureDrawer.PaintBox.
    private static (double X, double Y, double W, double H)? PaintBox(MirrorNode node)
    {
        return node.LocalRect is { } rect
            ? (rect.X, rect.Y, rect.Width, rect.Height)
            : null;
    }

    // Structural "does this node draw anything" default for the subtree-union fallback (the Godot consumer passes a
    // gate that also consults live shader-mount state).
    private static bool DefaultPaintBearing(MirrorNode node) =>
        node.TextureUrl is not null
        || node.FillColor is not null
        || node.NinePatch
        || node.Range is not null
        || node.Text is { Text.Length: > 0 };

    private static MirrorNode? Parent(MirrorState state, MirrorNode node) =>
        node.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
}
