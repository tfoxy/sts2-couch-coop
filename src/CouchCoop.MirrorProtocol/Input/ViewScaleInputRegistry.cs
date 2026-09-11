using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Input;

// R5 (WS-A) — the PURE construction of the view-scale input-gate registry, split out of ViewScaler so the neighbour
// selection is Godot-free and Exe-testable. ViewScaler now only MEASURES the stamps (needs the Godot views) and hands
// the applied stamps here; the neighbour walk + the four exclusion rules live entirely on this MirrorProtocol side.
//
// WHAT A "NEIGHBOUR" IS (and why the round-2→round-4 collection was wrong). A stamp's inverse remap must fire for a
// tap that belongs to the SCALED item and stay identity for a tap that belongs to some UN-SCALED thing sitting in the
// scaled item's enlarged halo. ViewScaleInput.IsExempt makes a point identity when a "neighbour" rect contains it. So
// a neighbour must be exactly an un-scaled surface DRAWN ON TOP of the scaled item — a non-descendant OVERLAY (the
// TopBar deck/gold/settings buttons over a scaled card-reward group) or, for an item stamp, a displaced sibling in the
// halo band. It must NEVER be an ANCESTOR, a full-viewport BACKDROP, or anything painted UNDER the item: those enclose
// the whole stamp, so treating them as neighbours exempts EVERY interior tap → the stamp's inverse never fires → taps
// land "as if the container was never scaled" (the R5 card-reward bug: the group root's ≥12 full-viewport ancestors —
// NGame / RootSceneContainer / NRun / … / NRewardsScreen — all overlapped the 1.10 NoClamp group ScaledBox and were
// collected as neighbours because the old subtree walk only went UP).
//
// FOUR EXCLUSION RULES drop a candidate rect (one that overlaps the ScaledBox and is outside every stamped subtree):
//   1. Ancestor      — the rect's node is a strict ANCESTOR of the stamped node (the root-cause kill).
//   2. Enclosure     — the rect's design box ENCLOSES the stamp's PRE-scale DesignBox (±0.5px). Tested against the
//                      pre-scale box on purpose: a 1920×1080 backdrop does NOT enclose the ~2112×1188 NoClamp
//                      ScaledBox, so testing the ScaledBox would miss the pollution. Also clears the latent same-class
//                      pollution for item stamps.
//   3. Stage-band    — the rect's rendered horizontal extent is ≥ 0.95×designWidth (a full-stage bar/backdrop can't
//                      speak for a specific widget under the pointer). Lockstep with NearMiss.StageBandFraction /
//                      PointerField's backdrop-demote threshold.
//   4. Z-rule       — the rect's paint index is BELOW the stamp's paint floor (painted UNDER it ⇒ invisible under it;
//                      a legitimate overlay paints AFTER the whole stamped subtree). The floor is the group root's
//                      index for a GROUP stamp, and the stamp NODE's own index for an ITEM stamp — see PaintFloor.
//
// WEB TWIN (keep in lockstep): frontend/src/mirror/mirrorRenderer.ts `buildViewScaleInputStamps` +
// `groupPaintFloor` / `buildPaintOrderIndex`. It shipped with rules 1/2/3 only for two rounds, and the missing rule 4
// WAS the round-9 map-legend input bug (the map screen paints over the room it was opened from, so that room's
// creature Hitbox / HpBarHitbox / Intent rects — interactive, narrow, painted ~2000 slots below the legend — survived
// 1/2/3, overlapped the legend's 1.2x ScaledBox and exempted its whole interior). Mirrored truth tables live in
// ViewScaleInputRegistryTests (here) and frontend/src/mirror/__tests__/viewScaleInputRegistry.spec.ts.
//
public static class ViewScaleInputRegistry
{
    // Lockstep with NearMiss.StageBandFraction / PointerField's 0.95 backdrop-demote threshold: a rect covering at
    // least this fraction of the (widened) design width is a full-stage bar/backdrop, never a per-widget neighbour.
    public const double StageBandFraction = 0.95;

    // Enclosure comparison epsilon (design px) — a rect whose box is within this of enclosing the stamp's pre-scale
    // DesignBox on every side counts as enclosing (a backdrop measured a fraction of a px inside still encloses).
    public const double EnclosureEps = 0.5;

    // One applied view-scale stamp as the registry builder sees it — a pure mirror of ViewScaler.AppliedStamp (all its
    // fields are already MirrorProtocol types), so ViewScaler maps its per-drain Registry into these and hands them in.
    public readonly record struct Applied(
        string Id,
        HoverTipScaleMath.Stamp Stamp,
        DesignAabb DesignBox,
        DesignAabb ScaledBox,
        bool IsGroup);

    // Build the pure input-gate registry ViewScaleInput.Remap consumes: for every applied stamp, compose the full
    // ancestor→leaf channel before collecting interactive rects overlapping its fully scaled box. One
    // InteractiveRectScan per drain.
    // Parallels ViewScaler.Registry's paint order (topmost last), so Remap resolves the topmost item when halos overlap.
    public static List<ViewScaleInput.Stamp> Build(
        MirrorState state,
        GlobalTransformIndex transforms,
        SpreadIndex spread,
        IReadOnlyList<Applied> applied,
        IReadOnlySet<string> stampedIds,
        double designWidth)
    {
        var output = new List<ViewScaleInput.Stamp>();
        if (applied.Count == 0)
        {
            return output;
        }

        var rects = InteractiveRectScan.Collect(state, transforms, spread);

        // Fold each interactive rect to its design box (anchor-widened width, spread-Dx shifted) ONCE.
        var rectBoxes = new List<(string Id, DesignAabb Box)>(rects.Count);
        foreach (var r in rects)
        {
            double width = r.RenderedWidth > 0 ? r.RenderedWidth : r.LocalRect.Width;
            var b = CullBounds.OfRect(r.Global, r.LocalRect.X, r.LocalRect.Y, width, r.LocalRect.Height).ShiftX(r.SpreadDx);
            rectBoxes.Add((r.Id, b));
        }

        var orderIndex = BuildOrderIndex(state);
        var appliedById = new Dictionary<string, Applied>(applied.Count, StringComparer.Ordinal);
        foreach (var a in applied)
        {
            appliedById[a.Id] = a;
        }

        foreach (var a in applied)
        {
            // R10 WS-F — EFFECTIVE VISIBILITY. A SCREEN is hidden by clearing the flag on its ROOT, so every
            // descendant keeps Visible=true and the stamp INDEX (deliberately) still stamps it — a stamp on a node
            // nothing draws is free, and keeping it is what stops the reappear frame rendering at scale 1
            // (ViewScaleStampIndexTests.StampSurvivesTransientInvisible pins that). THIS registry is different: it is
            // coordinate-only and draws nothing, so an invisible stamp here silently CLAIMS pointers. A closed map
            // screen behind a combat room kept remapping every pointer whose game X crossed the MapLegend's 1.2 band
            // or a 1.5 map point — measured on the web twin as a 66.7 design-px instantaneous cursor jump at
            // 1920x1080 and 67.6 at 2520x1080 (scripts/probe-targeting-drag-jump.mjs). InteractiveRectScan already
            // drops ancestor-hidden rects, so this is the same predicate on the other half of the input path.
            // Web twin: the ancestorChainHidden gate in mirrorRenderer.buildViewScaleInputStamps.
            if (!EffectivelyVisible(state, a.Id))
            {
                continue;
            }

            var composed = ComposeInputChannel(state, appliedById, a);
            int paintFloor = PaintFloor(state, stampedIds, a, orderIndex);

            List<DesignAabb>? neighbors = null;
            foreach (var (rid, rbox) in rectBoxes)
            {
                if (!rbox.Overlaps(composed.ScaledBox) || InAnyStampedSubtree(state, stampedIds, rid))
                {
                    continue;
                }

                if (DroppedByFilter(state, orderIndex, a, rid, rbox, designWidth, paintFloor))
                {
                    continue;
                }

                (neighbors ??= new List<DesignAabb>()).Add(rbox);
            }

            output.Add(new ViewScaleInput.Stamp(
                composed.Channel, composed.ScaledBox, a.DesignBox, a.IsGroup,
                (IReadOnlyList<DesignAabb>?)neighbors ?? Array.Empty<DesignAabb>(), composed.OwnUnscaledBox));
        }

        return output;
    }

    // The candidate rect `rid` (already known to overlap the stamp's ScaledBox and sit outside every stamped subtree)
    // is NOT a legitimate neighbour when ANY of the four rules holds. Individual rules are public for the unit truth
    // table.
    private static bool DroppedByFilter(
        MirrorState state, IReadOnlyDictionary<string, int> orderIndex, Applied a, string rid, DesignAabb rbox,
        double designWidth, int paintFloor)
    {
        // 1. Ancestor — the whole point of the R5 fix: a full-viewport ancestor is never a neighbour.
        if (IsStrictAncestor(state, rid, a.Id))
        {
            return true;
        }

        // 2. Enclosure — a backdrop/container that wraps the stamp's PRE-scale box (not the ScaledBox) exempts every
        //    interior tap, so it can't be a neighbour.
        if (EnclosesDesignBox(rbox, a.DesignBox))
        {
            return true;
        }

        // 3. Stage-band — a full-stage bar/backdrop can't own a specific widget's tap.
        if (IsStageBand(rbox, designWidth))
        {
            return true;
        }

        // 4. Z-rule — a rect painted UNDER the stamp is invisible under it, never a neighbour.
        if (orderIndex.TryGetValue(rid, out int ri) && ri < paintFloor)
        {
            return true;
        }

        return false;
    }

    // ---- the four rules as individually testable predicates ----

    // Rule 1: `maybeAncestorId` is a STRICT ancestor of `nodeId` (walks nodeId's parents up, excludes self).
    public static bool IsStrictAncestor(MirrorState state, string maybeAncestorId, string nodeId)
    {
        if (!state.Nodes.TryGetValue(nodeId, out var node))
        {
            return false;
        }

        for (var cur = Parent(state, node); cur is not null; cur = Parent(state, cur))
        {
            if (cur.Id == maybeAncestorId)
            {
                return true;
            }
        }

        return false;
    }

    // Rule 2: `candidate` encloses `inner` on every side (± EnclosureEps). `inner` is the stamp's PRE-scale DesignBox.
    public static bool EnclosesDesignBox(DesignAabb candidate, DesignAabb inner, double eps = EnclosureEps) =>
        candidate.MinX <= inner.MinX + eps
        && candidate.MinY <= inner.MinY + eps
        && candidate.MaxX >= inner.MaxX - eps
        && candidate.MaxY >= inner.MaxY - eps;

    // Rule 3: `candidate`'s rendered horizontal extent is ≥ StageBandFraction × designWidth (a full-stage backdrop).
    public static bool IsStageBand(DesignAabb candidate, double designWidth) =>
        candidate.MaxX - candidate.MinX >= StageBandFraction * designWidth;

    // Rule 4: `candidateId` is painted BELOW the group's paint floor. Self-contained wrapper (builds the paint index
    // internally) for the unit truth table; the Build loop uses the precomputed index + per-stamp floor.
    public static bool IsPaintedUnderGroup(
        MirrorState state, IReadOnlySet<string> stampedIds, string groupId, string candidateId)
    {
        var orderIndex = BuildOrderIndex(state);
        int floor = GroupPaintFloor(state, stampedIds, groupId, orderIndex);
        return orderIndex.TryGetValue(candidateId, out int ci) && ci < floor;
    }

    // Rule 4's paint floor for one applied stamp.
    //   GROUP → GroupPaintFloor (the root's own index, with the non-contiguity fallback).
    //   ITEM  → R19: the stamp NODE's OWN paint index. An item's halo is the pixels the enlarged item PAINTS OVER, so a
    //     rect the item paints over cannot be what the finger is on — the same argument as the group rule, with the item
    //     itself as the floor. Without it the card dialog's "Show upgrade" tickbox was dead in its own halo: the deck
    //     grid's card-holder hitboxes sit UNDER the inspect popup, survive rules 1/2/3 (not ancestors, not enclosing its
    //     287x64 pre-scale box, not stage bands) and overlap its 1.4x ScaledBox, so every halo point was exempt ⇒
    //     identity ⇒ the coordinate stayed outside the tickbox and landed on the screen's full-stage backstop, whose
    //     released handler closes the dialog. Measured on the web twin against .sts2/bench/r9-carddetail.ndjson: 13
    //     neighbours claimed that halo and 0/34 in-halo hover samples reached the tickbox, at 2520x1080 AND 1920x1080
    //     (unlike the rest of this family, it is not a wide-stage bug). A legitimate overlay still paints AFTER the item
    //     and keeps its exemption.
    // int.MinValue ⇒ the rule can never fire (the stamp node isn't in the paint order at all).
    private static int PaintFloor(
        MirrorState state, IReadOnlySet<string> stampedIds, Applied a, IReadOnlyDictionary<string, int> orderIndex) =>
        a.IsGroup
            ? GroupPaintFloor(state, stampedIds, a.Id, orderIndex)
            : orderIndex.TryGetValue(a.Id, out int idx) ? idx : int.MinValue;

    // The paint index below which a rect is "under" the group. Normally the group root's own index (its container
    // background) — descendants paint above it, legitimate overlays paint after the whole subtree, and a candidate is
    // never a descendant of the group (InAnyStampedSubtree already excluded the group's subtree). DEFENSIVE fallback:
    // if the group's stamped subtree is NOT contiguous in paint order (a foreign node interleaves between the root and
    // its stamped descendants — a non-DFS order), raise the floor to the max paint index across the stamped subtree so
    // an interleaved underlay is still dropped.
    private static int GroupPaintFloor(
        MirrorState state, IReadOnlySet<string> stampedIds, string groupId, IReadOnlyDictionary<string, int> orderIndex)
    {
        if (!orderIndex.TryGetValue(groupId, out int rootIdx))
        {
            return int.MinValue; // the group root isn't painted → nothing is "under" it
        }

        int subtreeMax = rootIdx;
        foreach (var sid in stampedIds)
        {
            if (sid == groupId || !orderIndex.TryGetValue(sid, out int si) || si <= rootIdx)
            {
                continue;
            }

            if (DescendsFrom(state, sid, groupId))
            {
                subtreeMax = Math.Max(subtreeMax, si);
            }
        }

        if (subtreeMax == rootIdx)
        {
            return rootIdx; // no stamped descendants → the floor is the root's own index
        }

        for (int i = rootIdx + 1; i <= subtreeMax && i < state.OrderedIds.Count; i++)
        {
            if (!DescendsFrom(state, state.OrderedIds[i], groupId))
            {
                return subtreeMax; // contiguity violated → raise the floor to catch an interleaved underlay
            }
        }

        return rootIdx;
    }

    // ---- shared walks (moved from ViewScaler; keyed by the passed stampedIds set) ----

    // The node AND every ancestor carry Visible — a hidden SCREEN only clears the flag on its root. Twin of
    // PointerField/TouchTargetScan.EffectivelyVisible and of the web's ancestorChainHidden. A stamp whose node has
    // vanished from the state entirely is treated as NOT visible (there is nothing on screen to claim a pointer for).
    private static bool EffectivelyVisible(MirrorState state, string id)
    {
        if (!state.Nodes.TryGetValue(id, out var node))
        {
            return false;
        }

        for (var cur = node; cur is not null;
             cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var p) ? p : null)
        {
            if (!cur.Visible)
            {
                return false;
            }
        }

        return true;
    }

    // True when `id` or any ancestor is a currently-stamped node (its interactive rect belongs to a scaled subtree, so
    // it is not a neighbour to exempt).
    private static bool InAnyStampedSubtree(MirrorState state, IReadOnlySet<string> stampedIds, string id)
    {
        for (var cur = state.Nodes.GetValueOrDefault(id); cur is not null; cur = Parent(state, cur))
        {
            if (stampedIds.Contains(cur.Id))
            {
                return true;
            }
        }

        return false;
    }

    // True when `id` is `ancestorId` or descends from it (inclusive ancestry walk).
    private static bool DescendsFrom(MirrorState state, string id, string ancestorId)
    {
        for (var cur = state.Nodes.GetValueOrDefault(id); cur is not null; cur = Parent(state, cur))
        {
            if (cur.Id == ancestorId)
            {
                return true;
            }
        }

        return false;
    }

    private static Dictionary<string, int> BuildOrderIndex(MirrorState state)
    {
        var map = new Dictionary<string, int>(state.OrderedIds.Count, StringComparer.Ordinal);
        for (int i = 0; i < state.OrderedIds.Count; i++)
        {
            map[state.OrderedIds[i]] = i; // a duplicated id (shouldn't happen) keeps its LAST paint index
        }

        return map;
    }

    private static MirrorNode? Parent(MirrorState state, MirrorNode node) =>
        node.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;

    // The design AABB after scaling `box` about the stamp's pivot by its factor, then adding the clamp translation —
    // the same forward map ViewScaler uses for its ScaledBox / MapThroughStamp. Pure, so tests + the tap replay probe
    // reuse it.
    public static DesignAabb ScaledBox(DesignAabb box, HoverTipScaleMath.Stamp s)
    {
        double k = s.Scale;
        double minX = s.PivotX + (k * (box.MinX - s.PivotX)) + s.ClampX;
        double maxX = s.PivotX + (k * (box.MaxX - s.PivotX)) + s.ClampX;
        double minY = s.PivotY + (k * (box.MinY - s.PivotY)) + s.ClampY;
        double maxY = s.PivotY + (k * (box.MaxY - s.PivotY)) + s.ClampY;
        return new DesignAabb(minX, minY, maxX, maxY);
    }

    // Compose a leaf's own stamp and every applied ancestor in widened design space. The input registry sees raw
    // design coordinates natively, so no spread bridge is needed here; composing only after each stamp has been
    // reduced to a child-local/game channel is exactly how `(k - 1) * dx` disappears on a widened reward screen.
    private static ComposedInput ComposeInputChannel(
        MirrorState state, IReadOnlyDictionary<string, Applied> appliedById, Applied leaf)
    {
        var chain = new List<Applied>();
        for (var cur = state.Nodes.GetValueOrDefault(leaf.Id); cur is not null; cur = Parent(state, cur))
        {
            if (appliedById.TryGetValue(cur.Id, out var stamp))
            {
                chain.Insert(0, stamp);
            }
        }

        var full = IdentityStamp;
        var ancestor = IdentityStamp;
        for (int i = 0; i < chain.Count; i++)
        {
            if (i + 1 < chain.Count)
            {
                ancestor = Compose(ancestor, chain[i].Stamp);
            }
            full = Compose(full, chain[i].Stamp);
        }

        return new ComposedInput(full, ScaledBox(leaf.DesignBox, full), ScaledBox(leaf.DesignBox, ancestor));
    }

    // `outer ∘ inner`: f(x) = k*x + t, represented by the existing pivot+clamp channel. Keeping the LEAF pivot
    // makes a one-stamp channel structurally identical to its pre-composition representation while the derived clamp
    // preserves the exact composed affine.
    private static HoverTipScaleMath.Stamp Compose(HoverTipScaleMath.Stamp outer, HoverTipScaleMath.Stamp inner)
    {
        double k = outer.Scale * inner.Scale;
        double tOuterX = outer.PivotX * (1 - outer.Scale) + outer.ClampX;
        double tOuterY = outer.PivotY * (1 - outer.Scale) + outer.ClampY;
        double tInnerX = inner.PivotX * (1 - inner.Scale) + inner.ClampX;
        double tInnerY = inner.PivotY * (1 - inner.Scale) + inner.ClampY;
        double tx = outer.Scale * tInnerX + tOuterX;
        double ty = outer.Scale * tInnerY + tOuterY;
        return new HoverTipScaleMath.Stamp(
            k,
            inner.PivotX,
            inner.PivotY,
            tx - inner.PivotX * (1 - k),
            ty - inner.PivotY * (1 - k));
    }

    private static readonly HoverTipScaleMath.Stamp IdentityStamp = new(1, 0, 0, 0, 0);

    private readonly record struct ComposedInput(
        HoverTipScaleMath.Stamp Channel,
        DesignAabb ScaledBox,
        DesignAabb OwnUnscaledBox);

    // R6 (WS-TIP / item 6): forward-map `ownerBox` through EVERY view-scale stamp that renders it — the owner's OWN
    // stamp PLUS every stamped ANCESTOR — composed innermost→outermost (deepest first), i.e. group(card(box)). This
    // supersedes the old single-stamp `TryGetStampContaining` map: on the card-reward screen the exact-id map hit only
    // the per-card 1.15 stamp, which is Center+NoClamp ⇒ centre-fixed ⇒ follow delta 0, so an off-centre card's tip
    // NEVER followed the outer 1.10 GROUP that actually displaces the card by 0.10·(c−S). Composing both stamps folds
    // the group displacement in (and the correct 1.10·1.15 visual size for the side-clamp box). Selection is
    // ANCESTRY-only — the stamps that multiply into a node's screen transform are EXACTLY those applied to it or one of
    // its ancestors — so it is hierarchy-faithful, robust to arbitrary nesting, and (unlike the R5 box-containment
    // fallback it replaces) never spuriously maps a NON-scaled overlay whose centre merely lands inside a full-viewport
    // group box (a TopBar relic tip on the reward/merchant screen). Returns false + `mapped == ownerBox` when no stamp
    // on the owner or an ancestor covers it.
    public static bool MapThroughContainingStamps(
        MirrorState state, IReadOnlyList<Applied> applied, string ownerId, DesignAabb ownerBox, out DesignAabb mapped)
    {
        mapped = ownerBox;
        if (applied.Count == 0)
        {
            return false;
        }

        // Apply the owner's own stamp, then each ancestor stamp, walking UP. Because we walk from the owner outward the
        // deepest (innermost) stamp is applied first, so the fold is group(card(box)) — the render order. A small linear
        // scan over `applied` (a handful of stamps) per hop keeps this Godot-free.
        bool any = false;
        for (var cur = state.Nodes.GetValueOrDefault(ownerId); cur is not null; cur = Parent(state, cur))
        {
            foreach (var a in applied)
            {
                if (a.Id == cur.Id)
                {
                    mapped = ScaledBox(mapped, a.Stamp);
                    any = true;
                    break; // at most one stamp per node
                }
            }
        }

        return any;
    }
}
