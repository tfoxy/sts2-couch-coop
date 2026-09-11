// OWNER: WS-M (native input shim). M1e.
//
// The sink for GestureCallbacks.OnHeldCard — it turns a held-card lift into a cosmetic MirrorNodeView.LiftOffset on
// the card's view (and the card's tooltips ride along). OnHeldCard(...) matches the delegate signature EXACTLY
// (Action<string?, double, double, HeldMode>) so the InputRouter assigns `callbacks.OnHeldCard = HeldCardLift.OnHeldCard`
// directly. Views are resolved through the frozen SceneReconciler.TryGetView seam; the input side is the SOLE writer
// of the LiftOffset channel.
//
// LIFT RULES (HeldCardLiftModel — the native twin of the browser client's mirrorRenderer.applyHeldLift):
//   * A fresh grab (null → id, or an id switch) resets the play-zone latch and records dragStartY = the design-Y of
//     the FIRST OnHeldCard call of this hold.
//   * Peek lifts unconditionally (PeekLiftPx); a drag lifts by DragLiftPx while `!enteredPlayZone || aboveLine`, and
//     a visible NTargetingArrow drops a drag lift (never a peek).
//   * The lifted offset is applied to the card view AND every effectively-visible NHoverTipSet view (the card's
//     tooltips lift with it). A clear (id == null) or an un-lift zeroes them all.
//   * A keyframe rebuild creates fresh views with LiftOffset zero, so we re-assert the current lift on every
//     MirrorStore.Drained.
//
// CARD-ONLY GATE (web parity — mirrorRenderer.applyHeldLift's `nodeTypeLeaf(...) === "NCard"` test):
// GestureMachine's drag/peek gesture forwards OnHeldCard for ANY touch target — TouchTargetScan.TargetsAt has no
// card filter, so e.g. an NRewardButton on the reward screen is a valid held id too (TouchTargetScan.cs:20-25). Web
// mirrors this unfiltered forward but gates the COSMETIC LIFT itself on the node being a real NCard leaf; a non-card
// id is still tracked as "held" (so a SWITCH away from a previously-lifted card still clears it immediately — see
// mirrorRenderer setHeldCard's `id !== heldCardId` branch, which is not itself gated on card-ness) but never runs
// the play-zone hysteresis and never gets a nonzero offset. We mirror that exactly via IsCard(...) below.

using System.Collections.Generic;
using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Input;

public static class HeldCardLift
{
    // Bound once (from InputRouter.Bind) so OnHeldCard can resolve views + inspect the tree without a per-call arg.
    // Both are re-bound after a back-to-menu teardown+rebuild (a NEW reconciler + store), so the Drained hook tracks
    // the CURRENT store by identity (see Bind) — the old guard would have left us subscribed to the disposed store.
    private static SceneReconciler? _reconciler;
    private static MirrorStore? _store;

    // ---- current lift state (one hold at a time) ----
    private static string? _heldId;         // the touch target currently held — MAY be a non-card id (see IsCard
                                             // gate in OnHeldCard); null = nothing held
    private static HeldCardLiftModel _model; // the play-zone hysteresis truth-table (value type; retained per hold)
    private static double? _dragStartY;      // design-Y of the FIRST OnHeldCard of this hold (grab point)
    private static bool _lifted;             // last computed lift decision
    private static HeldMode _mode;           // last mode (drives LiftPx)
    private static readonly List<string> _liftedTooltipIds = new(); // NHoverTipSet views we last offset (to zero later)

    // Transition log de-dupe (log a lift/clear only when the (card, lifted, mode) triple changes — never per frame).
    private static string? _logCardId;
    private static bool _logLifted;
    private static HeldMode _logMode;

    // AppShell (frozen) calls this single-arg overload. Kept working; it only rebinds the reconciler.
    public static void Bind(SceneReconciler reconciler) => _reconciler = reconciler;

    // The InputRouter calls this richer overload with the store too, so we can (a) detect a visible NTargetingArrow
    // for the drag-lift drop and (b) re-assert the lift after each drain (fresh views start at LiftOffset zero).
    //
    // Re-bindable: a back-to-menu teardown+rebuild hands us a NEW store, so we MUST move the Drained hook off the old
    // (disposed) store onto the new one — otherwise the re-assert would stay wired to the dead store and held-card
    // lift would silently break after the first reconnect. Rebinding the SAME store is a no-op (no double-subscribe).
    public static void Bind(SceneReconciler reconciler, MirrorStore store)
    {
        _reconciler = reconciler;
        if (!ReferenceEquals(store, _store))
        {
            if (_store is not null)
            {
                _store.Drained -= OnDrained;
            }

            _store = store;
            store.Drained += OnDrained;
        }

        ClearState();
    }

    // Full teardown (AppShell.ReturnToMenu, before the store is disposed): unhook the Drained subscription and drop
    // all references to the freed stage so nothing pins the old reconciler/store across the rebuild.
    public static void ClearBinding()
    {
        if (_store is not null)
        {
            _store.Drained -= OnDrained;
        }

        _store = null;
        _reconciler = null;
        ClearState();
    }

    // Consumes GestureCallbacks.OnHeldCard. GestureMachine forwards ANY touch target here (no card filter), so `id`
    // may name a non-card widget (e.g. NRewardButton) — see the CARD-ONLY GATE note above. id == null → clear the
    // current lift; otherwise track `id` toward the design-space point (x, y) for the given HeldMode, but only a
    // real NCard runs the play-zone hysteresis / gets a nonzero offset (Peek raises unconditionally; Drag hysteresis
    // in the model).
    public static void OnHeldCard(string? id, double designX, double designY, HeldMode mode)
    {
        if (_reconciler is null)
        {
            return;
        }

        if (id is null)
        {
            ClearLift();
            return;
        }

        // A switch to a different id (web parity: mirrorRenderer setHeldCard's `id !== heldCardId` branch is NOT
        // gated on card-ness): clear the previous id's lift (+ tooltips) before starting the new hold — even if the
        // OLD id was a card and the NEW one isn't (or vice versa).
        if (_heldId is not null && _heldId != id)
        {
            ClearLift();
        }

        // A fresh grab of this id: reset the latch + capture the grab Y (the first OnHeldCard of the hold).
        if (_heldId != id)
        {
            _heldId = id;
            _model.Reset();
            _dragStartY = designY;
        }

        _mode = mode;

        // CARD-ONLY GATE: a non-card id must never run the hysteresis (it would mutate `_model`'s play-zone latch
        // off a touch target the web never lifts) — short-circuit `&&` skips Update(...) entirely when IsCard is
        // false, so `_lifted` just stays false (ApplyLift below then writes a zero offset, same as web leaving a
        // non-card el's translate untouched).
        _lifted = IsCard(id) && _model.Update(mode, _dragStartY, designY, MirrorDesignHeight, HasVisibleTargetingArrow());
        ApplyLift();
    }

    // ---- internals ----

    private const double MirrorDesignHeight = 1080; // mirrorRenderer MIRROR_DESIGN_HEIGHT

    // Re-assert the current lift after a drain — a keyframe rebuild frees + recreates views with LiftOffset zero.
    private static void OnDrained(MirrorStore.DrainInfo info)
    {
        if (_heldId is not null)
        {
            ApplyLift();
        }
    }

    private static void ApplyLift()
    {
        if (_reconciler is null || _heldId is null)
        {
            return;
        }

        var offset = _lifted ? new Vector2(0, -(float)HeldCardLiftModel.LiftPx(_mode)) : Vector2.Zero;

        if (_reconciler.TryGetView(_heldId, out var cardView))
        {
            cardView.LiftOffset = offset;
        }

        ApplyTooltipLift(offset);

        // One line per (card, lifted, mode) transition — direct evidence of the lift firing (not per frame).
        if (_heldId != _logCardId || _lifted != _logLifted || _mode != _logMode)
        {
            _logCardId = _heldId;
            _logLifted = _lifted;
            _logMode = _mode;
            GD.Print($"M1E_LIFT: card={_heldId} mode={_mode} lifted={_lifted} offsetY={offset.Y:0} " +
                     $"tooltips={_liftedTooltipIds.Count}");
        }
    }

    // Lift every effectively-visible NHoverTipSet view by the same offset (the card's tooltips ride along). Tooltip
    // views that were lifted last time but are no longer present/visible get zeroed so a stale offset never lingers.
    private static void ApplyTooltipLift(Vector2 offset)
    {
        if (_reconciler is null || _store is null)
        {
            return;
        }

        var current = new List<string>();
        var state = _store.State;
        foreach (var id in state.OrderedIds)
        {
            if (state.Nodes.TryGetValue(id, out var node)
                && NodeTypeLeaf(node.NodeType) == "NHoverTipSet"
                && EffectivelyVisible(state, node))
            {
                current.Add(id);
            }
        }

        // Zero any previously-lifted tooltip that dropped out of the current visible set.
        foreach (var prev in _liftedTooltipIds)
        {
            if (!current.Contains(prev) && _reconciler.TryGetView(prev, out var stale))
            {
                stale.LiftOffset = Vector2.Zero;
            }
        }

        foreach (var id in current)
        {
            if (_reconciler.TryGetView(id, out var view))
            {
                view.LiftOffset = offset;
            }
        }

        _liftedTooltipIds.Clear();
        _liftedTooltipIds.AddRange(current);
    }

    private static void ClearLift()
    {
        if (_heldId is not null)
        {
            GD.Print($"M1E_LIFT: card={_heldId} CLEARED (offset zeroed, tooltips={_liftedTooltipIds.Count})");
        }

        if (_reconciler is not null)
        {
            if (_heldId is not null && _reconciler.TryGetView(_heldId, out var cardView))
            {
                cardView.LiftOffset = Vector2.Zero;
            }

            foreach (var id in _liftedTooltipIds)
            {
                if (_reconciler.TryGetView(id, out var view))
                {
                    view.LiftOffset = Vector2.Zero;
                }
            }
        }

        ClearState();
    }

    private static void ClearState()
    {
        _heldId = null;
        _dragStartY = null;
        _lifted = false;
        _model.Reset();
        _liftedTooltipIds.Clear();

        // Reset the transition-log de-dupe so the next grab logs fresh (even if it's the same card id).
        _logCardId = null;
        _logLifted = false;
    }

    // Whether `id` names a real card — delegates to TouchTargetScan.IsCard (the SAME predicate TouchTargetScan used
    // to classify the touch target in the first place: node-type leaf == "NCard") so this can never drift from the
    // scan. No store bound (not yet Bind'd) ⇒ false, matching "nothing resolvable, so nothing lifts".
    private static bool IsCard(string id) => _store is not null && TouchTargetScan.IsCard(_store.State, id);

    // Any effectively-visible node whose type leaf is "NTargetingArrow" → a drag drops its lift (arrow tip reads at
    // the finger). Peek ignores this (the model checks the mode first).
    private static bool HasVisibleTargetingArrow()
    {
        if (_store is null)
        {
            return false;
        }

        var state = _store.State;
        foreach (var node in state.Nodes.Values)
        {
            if (NodeTypeLeaf(node.NodeType) == "NTargetingArrow" && EffectivelyVisible(state, node))
            {
                return true;
            }
        }

        return false;
    }

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
        var dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
