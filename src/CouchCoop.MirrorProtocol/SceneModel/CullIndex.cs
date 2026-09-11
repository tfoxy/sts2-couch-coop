namespace CouchCoop.MirrorProtocol.SceneModel;

using System.Collections.Generic;

// M3 fill-reduction (CULL): a GENERAL, conservative offscreen / invisible-content culling pass for the mirror stage.
// The phone is GPU fill-bound INSIDE the design-res raster (~2.6MP); today NOTHING is culled — nodes fully outside the
// design viewport (map content beyond the view, off-screen piles/hand under overlays) and fully-transparent subtrees
// still rasterize every frame. This index turns the retained MirrorState + the GlobalTransformIndex globals into a
// per-node cull DECISION the SceneReconciler applies to its views.
//
// PURE MATH (Godot-free, Exe-testable). NO node-name / scene-specific rules — every decision is proved from geometry
// (a node's own paint AABB under its global affine) and streamed alpha only. The guiding invariant is CONSERVATIVE:
// any uncertainty (unknown bounds, an effect that overflows its rect, a custom shader that may ignore modulate, a
// transform whose streamed value is pinned under an active tween) forces "keep visible". A missed cull only wastes
// fill; a wrong cull drops visible pixels — so the math always errs toward keeping.
//
// THREE decisions (see <see cref="Decision"/>):
//   * SelfPaint       — the node's OWN paint box is fully outside the (margin-inflated) design rect. Suppress ONLY its
//                       self _Draw + its text attachment; CHILD views stay live (their own decisions stand). Effect-
//                       bearing and clip-only nodes are EXEMPT (their paint overflows / is structural).
//   * SubtreeOffscreen— EVERY paint-bearing descendant has a KNOWN box AND the union of the whole subtree is fully
//                       outside the rect → the reconciler hides the subtree root (Visible=false), skipping the whole
//                       branch's rasterization in one flag. Any unknown-bounds / effect-bearing / tween-uncertain
//                       descendant BLOCKS it (the union can't be trusted).
//   * SubtreeZeroAlpha— the node's own (inherited-multiplicative) modulate alpha is EXACTLY 0 and NO shader lives
//                       anywhere in its subtree (a custom shader may ignore modulate) → hide the subtree. The
//                       reconciler additionally guards this with the view's live modulate-tween ownership (a fade
//                       pins streamed alpha at an endpoint while animating through it).
//
// INCREMENTAL. Self bounds recompute ONLY for the ids the GlobalTransformIndex just recomputed (its LastRecomputed —
// changed seeds + moved descendants), extended UP to their ancestors for the bottom-up subtree aggregation (a moved
// leaf changes every ancestor's subtree union). A full recompute runs on a transform-index full pass (keyframe /
// revision reset) or a design-width change (the cull rect moved → every decision re-derives). Map
// scrolling — the hot re-eval path — streams a transform delta for the whole map subtree each frame, so its changed
// set is inherently large; combat steady state touches a handful of nodes.
public sealed class CullIndex
{
    // The design rect is ALWAYS 1080 tall (StageStretch.DesignHeight); only the width widens with the spread factor.
    public const double DesignHeight = 1080;

    public enum Decision : byte
    {
        None = 0,
        SelfPaint = 1,
        SubtreeOffscreen = 2,
        SubtreeZeroAlpha = 3,
    }

    // Per-node SELF attributes (own paint only), retained so an ancestor's subtree aggregate can re-roll without
    // re-touching an unchanged child. Recomputed whenever the node is in the affected set.
    private readonly struct Self
    {
        public readonly DesignAabb Bounds;   // own paint box in design space (valid iff HasBounds)
        public readonly bool HasBounds;      // node has a trusted own LocalRect paint box (known global + not tween-uncertain)
        public readonly bool Blocks;         // effect-bearing OR tween-uncertain OR paints-with-unknown-bounds → forbids any ancestor subtree cull
        public readonly bool HasShader;      // node.ShaderId set → a subtree containing it can't zero-alpha cull
        public readonly bool SelfCullable;   // eligible for SelfPaint suppression (trusted bounds, not effect/clip/uncertain)
        public readonly bool OwnAlphaZero;   // own streamed modulate alpha is EXACTLY 0 (exact — a fade tweens through small alphas)

        public Self(DesignAabb bounds, bool hasBounds, bool blocks, bool hasShader, bool selfCullable, bool ownAlphaZero)
        {
            Bounds = bounds;
            HasBounds = hasBounds;
            Blocks = blocks;
            HasShader = hasShader;
            SelfCullable = selfCullable;
            OwnAlphaZero = ownAlphaZero;
        }
    }

    // Per-node SUBTREE aggregate (this node + all descendants), rolled up bottom-up.
    private readonly struct Agg
    {
        public readonly DesignAabb Bounds;   // union of every KNOWN self box in the subtree (valid iff HasBounds)
        public readonly bool HasBounds;      // any node in the subtree contributed a box
        public readonly bool Blocked;        // any node in the subtree Blocks a subtree cull
        public readonly bool HasShader;      // any node in the subtree carries a shader

        public Agg(DesignAabb bounds, bool hasBounds, bool blocked, bool hasShader)
        {
            Bounds = bounds;
            HasBounds = hasBounds;
            Blocked = blocked;
            HasShader = hasShader;
        }

        public static Agg FromSelf(Self s) => new(s.Bounds, s.HasBounds, s.Blocks, s.HasShader);

        public Agg Merge(Agg c)
        {
            DesignAabb b;
            bool hasB;
            if (HasBounds && c.HasBounds)
            {
                b = Bounds.Union(c.Bounds);
                hasB = true;
            }
            else if (HasBounds)
            {
                b = Bounds;
                hasB = true;
            }
            else
            {
                b = c.Bounds;
                hasB = c.HasBounds;
            }

            return new Agg(b, hasB, Blocked || c.Blocked, HasShader || c.HasShader);
        }
    }

    private readonly Dictionary<string, Self> _self = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, Agg> _agg = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, Decision> _decision = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> _childrenByParent = new(System.StringComparer.Ordinal);

    // The ids whose decision was (re)computed this Update — the reconciler applies exactly these to its views
    // (every one was either a moved node, a moved node's ancestor, or — on a full pass — the whole tree). Rebuilt in
    // place each Update.
    private readonly List<string> _decisionDirty = new();

    // Scratch reused across Updates (avoid per-drain allocation on the hot path).
    private readonly HashSet<string> _affected = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _computed = new(System.StringComparer.Ordinal);

    private bool _firstRun = true;
    private bool _forceFull;
    private double _lastDesignWidth = -1;
    private double _margin;

    // CURRENT cull-state population (not cumulative): how many live nodes sit in each cull decision right now. Surfaced
    // in M3_WALK / BENCH_RESULT. Maintained by diffing the prior vs new decision as each is written.
    public long CulledSelf { get; private set; }
    public long CulledSubtree { get; private set; }

    public IReadOnlyList<string> DecisionDirty => _decisionDirty;

    public bool TryGetDecision(string id, out Decision decision) => _decision.TryGetValue(id, out decision);

    // Force the NEXT Update to take the full-recompute branch regardless of the transform index's changed set. Used
    // when something outside the streamed-delta path invalidated every view's cull-relevant state (the reconciler's
    // effect-mode re-Apply re-stamps Visible on all views, clobbering subtree culls).
    public void MarkDirtyAll() => _forceFull = true;

    // Recompute cull decisions for this drain. `transforms` MUST already be updated for this drain (the reconciler
    // runs after MirrorStore.FinishDrain's Transforms.Update). `designWidth` is the widened design width (1920·factor);
    // `margin` the conservative slack (design px). `boundsUncertain` = the ids whose view currently owns a transform
    // tween (streamed transform pinned → bounds untrusted); null / empty when none. `structural` = keyframe || order
    // change (rebuild the parent→children map). Reads the transform index's OWN recomputed set + full flag — no
    // parallel dirty machinery.
    public void Update(
        MirrorState state,
        GlobalTransformIndex transforms,
        double designWidth,
        double margin,
        IReadOnlySet<string>? boundsUncertain,
        bool structural)
    {
        _margin = margin;
        _decisionDirty.Clear();

        // A design-width change moves the cull rect → every decision must re-derive; a transform-index full pass
        // (keyframe / revision reset) dropped the globals we'd trust → recompute from scratch too.
        bool full = _firstRun || _forceFull || transforms.LastWasFull || designWidth != _lastDesignWidth;
        _firstRun = false;
        _forceFull = false;
        _lastDesignWidth = designWidth;

        if (full)
        {
            RebuildChildren(state);
            PruneToLive(state);

            _affected.Clear();
            foreach (var (id, node) in state.Nodes)
            {
                _self[id] = ComputeSelf(node, transforms, boundsUncertain);
                _affected.Add(id);
            }
        }
        else
        {
            var changed = transforms.LastRecomputed;
            if (changed.Count == 0)
            {
                return; // nothing moved → no bounds to refresh, decisions retained
            }

            // A brand-new node (streamed this drain) that isn't yet in the children map forces a rebuild even if the
            // draw-order flag didn't trip (defensive — adds normally ride an order change).
            bool needChildrenRebuild = structural;
            foreach (var id in changed)
            {
                if (state.Nodes.ContainsKey(id))
                {
                    if (!needChildrenRebuild && !_self.ContainsKey(id))
                    {
                        needChildrenRebuild = true;
                    }
                }
                else
                {
                    DropNode(id); // removed this drain — purge its retained state + decision counters
                }
            }

            if (needChildrenRebuild)
            {
                RebuildChildren(state);
            }

            // Affected = the moved live nodes (self bounds refresh) closed UP over their ancestors (a moved node
            // changes every ancestor's subtree union). Recompute self for each affected node — unchanged ancestors
            // recompute to the same value cheaply, which keeps the aggregation's self lookups always present.
            _affected.Clear();
            foreach (var id in changed)
            {
                if (state.Nodes.ContainsKey(id))
                {
                    AddAncestors(id, state);
                }
            }

            foreach (var id in _affected)
            {
                _self[id] = ComputeSelf(state.Nodes[id], transforms, boundsUncertain);
            }
        }

        // Bottom-up subtree aggregation over the affected set (memoized recursion; unchanged children ride their
        // retained aggregate).
        _computed.Clear();
        foreach (var id in _affected)
        {
            Aggregate(id, state, _computed);
        }

        // Decide + publish. Diff the prior decision to keep the current-population counters exact.
        foreach (var id in _affected)
        {
            var decision = Decide(id);
            _decision.TryGetValue(id, out var prior);
            if (decision != prior)
            {
                Recount(prior, -1);
                Recount(decision, +1);
                _decision[id] = decision;
            }

            _decisionDirty.Add(id);
        }
    }

    private void Recount(Decision d, int delta)
    {
        if (d == Decision.SelfPaint)
        {
            CulledSelf += delta;
        }
        else if (d is Decision.SubtreeOffscreen or Decision.SubtreeZeroAlpha)
        {
            CulledSubtree += delta;
        }
    }

    private Decision Decide(string id)
    {
        var self = _self[id];
        var agg = _agg[id];
        double w = _lastDesignWidth;

        // 1. Provably-offscreen subtree (strongest; unconditional hide). Needs a non-empty, fully-known, un-blocked
        // union that lies entirely outside the margin-inflated rect.
        if (agg.HasBounds && !agg.Blocked && agg.Bounds.FullyOutside(w, DesignHeight, _margin))
        {
            return Decision.SubtreeOffscreen;
        }

        // 2. Fully-transparent subtree (own inherited alpha exactly 0, no shader anywhere below). The reconciler
        // guards the actual hide on the view's live modulate-tween ownership.
        if (self.OwnAlphaZero && !agg.HasShader)
        {
            return Decision.SubtreeZeroAlpha;
        }

        // 3. Own paint fully offscreen → suppress just this node's self paint (+ its text), leaving child views live.
        if (self.SelfCullable && self.HasBounds && self.Bounds.FullyOutside(w, DesignHeight, _margin))
        {
            return Decision.SelfPaint;
        }

        return Decision.None;
    }

    private Agg Aggregate(string id, MirrorState state, HashSet<string> computed)
    {
        if (!computed.Add(id))
        {
            return _agg.TryGetValue(id, out var done) ? done : default;
        }

        // Self must be present for any affected id (computed above); a defensive default keeps a malformed set safe.
        var agg = _self.TryGetValue(id, out var s) ? Agg.FromSelf(s) : default;

        if (_childrenByParent.TryGetValue(id, out var kids))
        {
            foreach (var kid in kids)
            {
                if (!state.Nodes.ContainsKey(kid))
                {
                    continue; // stale (removed) child still lingering in the retained map — skip
                }

                Agg childAgg = _affected.Contains(kid)
                    ? Aggregate(kid, state, computed)
                    : (_agg.TryGetValue(kid, out var retained) ? retained : default);
                agg = agg.Merge(childAgg);
            }
        }

        _agg[id] = agg;
        return agg;
    }

    // Add `id` and every ancestor to the affected set, stopping at the first ancestor already present (its chain is
    // already covered). Ancestor pointers come straight from state.Nodes (no children map needed for the upward walk).
    private void AddAncestors(string id, MirrorState state)
    {
        // Existence check BEFORE adding: a mid-drain state can hold a child whose ParentId was removed in the SAME
        // drain (dangling ancestor). Adding such an id to _affected made the later `state.Nodes[id]` self-recompute
        // throw KeyNotFoundException and abort the whole cull update for that drain (stale decisions until the next
        // full rebuild). A dangling ancestor has no Self/aggregate identity, so skipping it is exact.
        string? cur = id;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var node))
        {
            if (!_affected.Add(cur))
            {
                break;
            }

            cur = node.ParentId;
        }
    }

    private Self ComputeSelf(MirrorNode node, GlobalTransformIndex transforms, IReadOnlySet<string>? boundsUncertain)
    {
        bool uncertain = boundsUncertain is not null && boundsUncertain.Contains(node.Id);
        bool effect = IsEffectBearing(node);
        bool hasShader = node.ShaderId is not null;

        DesignAabb bounds = default;
        bool hasBounds = false;
        if (!uncertain && LocalPaintBox(node) is { } box && transforms.TryGetGlobal(node.Id, out var g))
        {
            bounds = CullBounds.OfRect(g, box.X, box.Y, box.Width, box.Height);
            hasBounds = true;
        }

        // Something that produces pixels but whose extent we can't bound (no box, or a tween-pinned box) → a subtree
        // cull spanning it can't be trusted. (A pure group that paints nothing does NOT block: culling an empty
        // branch is a no-op.)
        bool paintsUnknown = !hasBounds && PaintsSomething(node);
        bool blocks = effect || uncertain || paintsUnknown;

        // Self-paint suppression: trusted bounds only; never an effect (overflows its rect), never a clip-only node
        // (its box is the clip STENCIL — suppressing it would un-clip the subtree), never tween-uncertain.
        bool selfCullable = hasBounds && !effect && node.ClipChildren != 1;

        double ownAlpha = node.Modulate is { } m ? m.A : node.Opacity;
        bool ownAlphaZero = ownAlpha == 0.0;

        return new Self(bounds, hasBounds, blocks, hasShader, selfCullable, ownAlphaZero);
    }

    // A node's own LocalRect paint box in its transform-local frame (mirrors TextureDrawer.PaintBox).
    private static MirrorRect? LocalPaintBox(MirrorNode node) => node.LocalRect;

    private static bool IsEffectBearing(MirrorNode node) =>
        node.ParticleSpec is not null
        || node.SpineSceneResPath is not null
        || node.ShaderId is not null
        || node.IntentFrames is not null;

    // Does the node emit any visible pixels of its own (independent of a known box)? Used only to decide whether an
    // unknown-bounds node blocks a subtree cull.
    private static bool PaintsSomething(MirrorNode node) =>
        node.TextureUrl is not null
        || node.FillColor is not null
        || node.Range is not null
        || node.Text is { Text.Length: > 0 }
        || IsEffectBearing(node);

    private void RebuildChildren(MirrorState state)
    {
        _childrenByParent.Clear();
        foreach (var (id, node) in state.Nodes)
        {
            if (node.ParentId is { } pid)
            {
                if (!_childrenByParent.TryGetValue(pid, out var list))
                {
                    list = new List<string>();
                    _childrenByParent[pid] = list;
                }

                list.Add(id);
            }
        }
    }

    // Full recompute: drop retained self/agg/decision entries for ids no longer in the tree (and un-count their
    // decisions), so the counters + maps stay bounded across keyframes.
    private void PruneToLive(MirrorState state)
    {
        List<string>? stale = null;
        foreach (var id in _self.Keys)
        {
            if (!state.Nodes.ContainsKey(id))
            {
                (stale ??= new List<string>()).Add(id);
            }
        }

        if (stale is not null)
        {
            foreach (var id in stale)
            {
                DropNode(id);
            }
        }
    }

    private void DropNode(string id)
    {
        if (_decision.TryGetValue(id, out var prior))
        {
            Recount(prior, -1);
            _decision.Remove(id);
        }

        _self.Remove(id);
        _agg.Remove(id);
    }
}

// A design-space axis-aligned bounding box (a rendered node's paint extent after its global affine). Empty is encoded
// as Max < Min so a defaulted value never reads as "covers the origin".
public readonly record struct DesignAabb(double MinX, double MinY, double MaxX, double MaxY)
{
    public DesignAabb Union(DesignAabb o) => new(
        System.Math.Min(MinX, o.MinX),
        System.Math.Min(MinY, o.MinY),
        System.Math.Max(MaxX, o.MaxX),
        System.Math.Max(MaxY, o.MaxY));

    // True when this box lies ENTIRELY outside the design rect [0,width]×[0,height] inflated by `margin` on every side
    // — i.e. it cannot contribute a single pixel inside the (generously padded) viewport.
    public bool FullyOutside(double width, double height, double margin) =>
        MaxX < -margin
        || MinX > width + margin
        || MaxY < -margin
        || MinY > height + margin;

    // Grow the box by `m` on every side (Track-B text-overlay slack inflation). Reusable AABB math.
    public DesignAabb Inflate(double m) => new(MinX - m, MinY - m, MaxX + m, MaxY + m);

    // Translate the box horizontally by `dx` (Track-B: fold a node's absolute wide-screen spread Dx into its
    // rendered design-space box — the reconciler shifts the VIEW by the parent-relative delta, but the absolute
    // rendered X is shifted by the node's cumulative SpreadRecord.Dx).
    public DesignAabb ShiftX(double dx) => new(MinX + dx, MinY, MaxX + dx, MaxY);

    // Closed-box overlap test (touching edges count as overlapping — conservative for the occlusion gate).
    public bool Overlaps(DesignAabb o) =>
        MinX <= o.MaxX && o.MinX <= MaxX && MinY <= o.MaxY && o.MinY <= MaxY;
}

// Pure AABB math for the cull index (game-free, Exe-testable).
public static class CullBounds
{
    // The design-space AABB of a local-frame rect (x,y,w,h) under a global affine 6-tuple [a,b,c,d,tx,ty]. Transforms
    // ALL FOUR corners and takes their min/max, so rotation / non-uniform scale / skew are handled exactly (a rotated
    // box's AABB is larger than the box). The CSS 6-tuple encodes X' = a·x + c·y + tx, Y' = b·x + d·y + ty.
    public static DesignAabb OfRect(IReadOnlyList<double> global, double x, double y, double w, double h)
    {
        double a = global[0], b = global[1], c = global[2], d = global[3], tx = global[4], ty = global[5];

        double x0 = x, y0 = y, x1 = x + w, y1 = y + h;

        // Four corners of the local box, each mapped through the affine.
        double cx0 = (a * x0) + (c * y0) + tx, cy0 = (b * x0) + (d * y0) + ty;
        double cx1 = (a * x1) + (c * y0) + tx, cy1 = (b * x1) + (d * y0) + ty;
        double cx2 = (a * x0) + (c * y1) + tx, cy2 = (b * x0) + (d * y1) + ty;
        double cx3 = (a * x1) + (c * y1) + tx, cy3 = (b * x1) + (d * y1) + ty;

        double minX = System.Math.Min(System.Math.Min(cx0, cx1), System.Math.Min(cx2, cx3));
        double maxX = System.Math.Max(System.Math.Max(cx0, cx1), System.Math.Max(cx2, cx3));
        double minY = System.Math.Min(System.Math.Min(cy0, cy1), System.Math.Min(cy2, cy3));
        double maxY = System.Math.Max(System.Math.Max(cy0, cy1), System.Math.Max(cy2, cy3));

        return new DesignAabb(minX, minY, maxX, maxY);
    }
}
