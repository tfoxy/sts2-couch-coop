// #19 general VIEW-SCALE pass. Renders specific interactive items the game shows too small on a phone (the
// post-combat reward list, card rewards, the merchant carpet, event option lists — see ViewScale.Entries) enlarged
// about a per-entry anchor, clamped on-screen.
//
// R8 (WS-2) STRUCTURAL REWRITE. This file used to BE the pass: it walked the live Godot views, wrote the scale
// through MirrorNodeView.SetHoverTipScale, and kept cross-drain memory (LastStamped / ThisStamped / LastApplied) so
// it could un-stamp on the next drain. Every per-drain gate it grew therefore had a "defer" and a "drop to scale 1"
// outcome, and each drop was a visible snap-back on an idle screen — the event-option scale flicker, patched three
// times (R4 TWEENHOLD, R6 settle backstop, R7 GROUPCARRY) and reported three times.
//
// It is now a thin ADAPTER around the pure ViewScaleStampIndex:
//   * Rebuild()  — build THIS DRAIN'S id → stamp index from the wire state (+ the input-gate registry + the applied
//                  list the HoverTip owner-compose reads). No memory: nothing is carried, nothing is un-stamped.
//   * MirrorNodeView.FoldCosmetic resolves its own stamp from the index (TryGetParentStamp) at the single transform
//     choke point, so bake clones, pool-recycled views, RefreshEffects and tween settles are correct BY
//     CONSTRUCTION rather than by a per-consumer patch.
//   * Refold() — a per-drain re-fold TRIGGER for the handful of views whose stamp changed but which no other pass
//     re-applied this drain. It is NOT a source of truth (it carries no value of its own): the value always comes
//     from the index inside the fold.
//
// The index is empty on every non-view-scale screen (the cheap SceneFilePath presence gate inside
// ViewScaleStampIndex.Build), so combat pays nothing.

using System.Collections.Generic;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public static class ViewScaler
{
    // A GROUP parked entirely off-stage
    // while a client-replayed TRANSFORM tween slides it on-screen (the shop open slide — SlotsContainer at local
    // y≈−1000) is measured at the tween ENDPOINT, so the whole slide renders scaled instead of popping at settle.
    // R8: this drain's stamps, keyed by wire node id. The SOLE source of truth for the view-scale channel — read by
    // MirrorNodeView's fold, the input registry, the tip owner-compose and the bake exclusion. Rebuilt from the wire
    // state every drain; never mutated in place.
    private static IReadOnlyDictionary<string, ViewScaleStampIndex.Stamped> _index = ViewScaleStampIndex.Empty;

    // Bumped whenever the index is REPLACED by a non-trivial rebuild (empty → empty leaves it alone, so a combat
    // drain never invalidates a single view's cached resolve). MirrorNodeView caches its resolved channel against
    // this, so the per-fold cost on a view-scale screen is one int compare + at most one dictionary probe per drain.
    public static int Generation { get; private set; }

    // The pure applied-stamp list (paint order) the input registry + HoverTipScaler.MeasureOwner consume.
    private static IReadOnlyList<ViewScaleInputRegistry.Applied> _applied = System.Array.Empty<ViewScaleInputRegistry.Applied>();

    // The pure input-gate view of the stamps (channel + boxes + group flag + FILTERED neighbour rects), consumed by
    // ViewScaleInput.Remap at the top of InputRouter.
    private static IReadOnlyList<ViewScaleInput.Stamp> _inputRegistry = System.Array.Empty<ViewScaleInput.Stamp>();

    // Scratch reused across drains (the refold trigger set + the tween-endpoint collection).
    private static readonly HashSet<string> RefoldIds = new(System.StringComparer.Ordinal);
    private static readonly HashSet<string> TweenOwned = new(System.StringComparer.Ordinal);
    private static readonly Dictionary<string, IReadOnlyList<double>> Endpoints = new(System.StringComparer.Ordinal);

    // True when at least one node is view-scaled this drain (the cheap gate MirrorNodeView's fold consults first).
    public static bool Any => _index.Count > 0;

    // Rebuild this drain's index from the wire state. Called ONCE per drain from SceneReconciler.OnDrained BEFORE the
    // reconcile walk (MirrorStore.FinishDrain has already refreshed Transforms + Spread), and again on a bare
    // spread-factor change. `hints` is this drain's tween hints (null on the spread pass) — a GROUP parked off-stage
    // while a transform tween slides it in is measured at that tween's endpoint.
    public static void Rebuild(MirrorStore store, IReadOnlyList<MirrorTweenHint>? hints = null)
    {
        var previous = _index;
        double designWidth = store.SpreadFactor * StageStretch.BaseDesignWidth;
        var index = ViewScaleStampIndex.Build(
            store.State, store.Transforms, store.Spread, designWidth, StageStretch.DesignHeight,
            CollectTweenEndpoints(hints), PaintBearing);

        _index = index;
        _applied = ViewScaleStampIndex.ToApplied(store.State, index);
        _inputRegistry = index.Count == 0
            ? System.Array.Empty<ViewScaleInput.Stamp>()
            : ViewScaleInputRegistry.Build(
                store.State, store.Transforms, store.Spread, _applied, StampedIds(index), designWidth);

        NoteReplaced(previous, index);
    }

    // Re-fold the views whose stamp changed this drain but which no other pass re-applied (an idle screen where only
    // an ancestor moved, or a bare spread-factor change). Pure TRIGGER: the value each view folds still comes from
    // the index, so a missed id self-heals on its next Apply/ApplyLight/spread stamp rather than going stale.
    // Near-free: the id set is the union of the previous and current stamps (a handful of nodes, empty in combat).
    public static void Refold(IReadOnlyDictionary<string, MirrorNodeView> views)
    {
        if (RefoldIds.Count == 0)
        {
            return;
        }

        foreach (var id in RefoldIds)
        {
            if (views.TryGetValue(id, out var view) && GodotObject.IsInstanceValid(view))
            {
                view.RefreshViewScale();
            }
        }
    }

    // The parent-frame view-scale channel for a node this drain: factor + parent-frame pivot + parent-frame clamp
    // translation. False (and a neutral channel) when the node carries no stamp. Read by MirrorNodeView's fold — the
    // one place the value is ever consumed, which is what makes bake clones / recycled views correct by construction.
    public static bool TryGetParentStamp(string id, out float scale, out Vector2 pivot, out Vector2 clamp)
    {
        if (_index.Count > 0 && _index.TryGetValue(id, out var s))
        {
            scale = (float)s.Design.Scale;
            pivot = new Vector2((float)s.PivotX, (float)s.PivotY);
            clamp = new Vector2((float)s.ClampX, (float)s.ClampY);
            return true;
        }

        scale = 1f;
        pivot = Vector2.Zero;
        clamp = Vector2.Zero;
        return false;
    }

    // Un-map a DESIGN-space pointer that landed on an enlarged item back to its true coordinate (the topmost item
    // whose enlarged box contains the point wins). Identity when no stamp contains the point → byte-identical to the
    // no-view-scale path. Called ONCE at the top of InputRouter, before the gesture machine / target scan.
    public static (double X, double Y) InverseRemap(double x, double y) =>
        ViewScaleInput.Remap(x, y, _inputRegistry);

    // R5/R6 (WS-TIP): forward-map a tip owner's raw design box through EVERY view-scale stamp that renders it — the
    // owner's OWN stamp AND every stamped ANCESTOR — composed innermost→outermost (group∘card), so a tip glued to an
    // off-centre card in a scaled GROUP follows the group displacement. Returns false + `mapped == ownerBox` when
    // nothing covers the owner.
    public static bool MapThroughContainingStamps(MirrorState state, string ownerId, DesignAabb ownerBox, out DesignAabb mapped) =>
        ViewScaleInputRegistry.MapThroughContainingStamps(state, _applied, ownerId, ownerBox, out mapped);

    // BELT: keep every view-scaled node AND its subtree out of the static bake (see ViewScaleStampIndex's note). The
    // fold is already clone-correct; this removes the whole "a frozen quad reproduces a cosmetic scale" surface.
    public static void CollectBakeExcluded(MirrorState state, ISet<string> into) =>
        ViewScaleStampIndex.CollectBakeExcluded(state, _index, into);

    // ---- internals ---------------------------------------------------------------------------------------------

    // Record the id set that must be re-folded (previous ∪ current stamps) and bump the generation ONLY when the
    // index CONTENT actually changed. Two consequences worth stating:
    //   * combat (empty → empty) never bumps, so every view's EnsureViewScale is a single int compare;
    //   * an IDLE view-scale screen (the steady state) produces a byte-identical index every drain, so it does not
    //     bump either — the per-view resolve stays memoized instead of re-probing the dictionary on every fold.
    // Correctness does not depend on this: an unchanged index resolves to the same channel either way.
    private static void NoteReplaced(
        IReadOnlyDictionary<string, ViewScaleStampIndex.Stamped> previous,
        IReadOnlyDictionary<string, ViewScaleStampIndex.Stamped> current)
    {
        RefoldIds.Clear();
        if (previous.Count == 0 && current.Count == 0)
        {
            return;
        }

        bool changed = previous.Count != current.Count;
        foreach (var id in previous.Keys)
        {
            RefoldIds.Add(id);
        }

        foreach (var (id, s) in current)
        {
            RefoldIds.Add(id);
            changed = changed || !previous.TryGetValue(id, out var old) || old != s;
        }

        if (changed)
        {
            Generation++;
        }
    }

    private static IReadOnlySet<string> StampedIds(IReadOnlyDictionary<string, ViewScaleStampIndex.Stamped> index)
    {
        var set = new HashSet<string>(index.Count, System.StringComparer.Ordinal);
        foreach (var id in index.Keys)
        {
            set.Add(id);
        }

        return set;
    }

    // This drain's transform-tween ENDPOINT locals: a hint PENDING this drain (preferred — the tween about to arm in
    // TweenReplayer.Consume, which runs after the reconcile) or an already-ACTIVE transform tween (a later drain).
    // Null when the endpoint stamp is switched off or nothing is tweening, so the index skips that path entirely.
    private static IReadOnlyDictionary<string, IReadOnlyList<double>>? CollectTweenEndpoints(
        IReadOnlyList<MirrorTweenHint>? hints)
    {
        Endpoints.Clear();
        TweenOwned.Clear();
        TweenReplayer.CollectTransformOwned(TweenOwned);
        foreach (var id in TweenOwned)
        {
            if (TweenReplayer.TryGetTransformEndpointLocal(id, out var active) && active is { Count: 6 })
            {
                Endpoints[id] = active;
            }
        }

        if (hints is not null)
        {
            foreach (var h in hints)
            {
                if (h.EndTransform is { Count: 6 } et)
                {
                    Endpoints[h.TargetId] = et; // a pending hint wins (last one for an id supersedes)
                }
            }
        }

        return Endpoints.Count == 0 ? null : Endpoints;
    }

    // The Godot-side "does this node draw anything" gate used by the per-item subtree-union fallback (it additionally
    // consults live shader mount state, which the pure default cannot).
    private static bool PaintBearing(MirrorNode node) =>
        PaintGates.PaintsTexture(node)
        || PaintGates.PaintFill(node)
        || node.NinePatch
        || node.Range is not null
        || node.Text is { Text.Length: > 0 };
}
