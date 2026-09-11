namespace CouchCoop.MirrorProtocol.SceneModel;

using System;
using System.Collections.Generic;

// Track-C "full-resolution card layer" — the PURE-C# eligibility + paint-order planner (Godot-free, Exe-testable,
// exactly like TextOverlayPlanner / StaticBakePlanner). At a Half/Quarter render scale the whole mirror stage
// rasterizes at design/2 (or /4) res and gets scaled up, so a CARD's title / type / description text AND its framed
// art — read pixel-for-pixel — turns mushy. This planner decides WHICH whole NCard subtrees can be promoted as
// design-res CLONES onto a CanvasLayer ABOVE the scaled stage (the CardLayer controller builds the clones, syncs each
// promoted card's holder to the live view's global transform per frame, hoist-suppresses the live members so they
// don't double-draw, and leaves the card's effect subtrees — glow/sparkles — live in-stage).
//
// Reuses the SHARED PaintOrderTables (IsOpaqueBlocker/ChainCovers/RenderedAabb/BlockerAabb/Blocker/EffectiveModulate +
// the paint-order index) so "which card is safe to promote" is decided by the EXACT same occlusion model as "which
// label is safe". CONSERVATIVE: a missed promotion just forgoes crispness; a WRONG promotion floats a crisp card over
// a panel that should cover it, or freezes an animating card member. Every rule errs toward NOT promoting.
//
// MEMBER ENUMERATION uses the PARENT/CHILDREN structure, NOT an OrderedIds index range: the producer's paint order
// interleaves foreign nodes within a card's OrderedIds span (a card subtree is NOT contiguous), so a range walk would
// skip real members and claim foreign ones. Members are the card root's descendants (via a children map), in pre-order
// with siblings sorted by paint-order index; an effect-bearing member's whole subtree is excluded to LiveEffectIds.
//
// THE CRUX (crisp-during-hover/drag): a promoted card's ROOT is EXEMPT from the dynamic-owned check — a hovered/lifted/
// spread card moves via its ROOT (or an ancestor), motion the controller absorbs by re-sampling GetGlobalTransform onto
// the holder every frame. Only a NON-ROOT member going dynamic forces a demote.
public sealed class CardLayerPlanner
{
    public const double DesignHeight = CullIndex.DesignHeight;

    // Slack (design px) around a promoted card's TEXT member boxes (font/outline/shadow overflow) and text-blockers.
    public const double CardSlackPx = 24;

    // Extra horizontal slack when widened (F≠1): a member's box is shifted by its cumulative SpreadRecord.Dx.
    public const double SpreadSlackPx = 16;

    public enum CardReject
    {
        None,           // promotable
        AncestorClip,   // a clipping ancestor (the un-nested clone can't reproduce the clip)
        AncestorEffect, // a particle/spine/shader/intent/material ancestor
        AncestorBlend,  // a non-Mix canvas blend ancestor
        ZOrder,         // ZIndex≠0 / ShowBehindParent on an ancestor, or ZIndex≠0 on a cloneable member
        Invisible,      // the card or an ancestor is not visible, or the effective modulate alpha is ~0
        UnknownBounds,  // no cloneable member has a trusted design-space box (or a painting member has none)
        Offscreen,      // the cluster's box is fully outside the design rect
        MemberDynamic,  // a NON-ROOT cloneable member is tween/anim/lift/unsettled owned
        Occluded,       // something paints on top of the card and overlaps it
        Nested,         // an NCard nested inside another accepted card (the outer card owns it)
    }

    private readonly Func<MirrorNode, bool> _clips;

    public CardLayerPlanner(Func<MirrorNode, bool>? clipPredicate = null) =>
        _clips = clipPredicate ?? (static n => n.ClipChildren != 0);

    private readonly PaintOrderTables _tables = new();

    // Reused scratch (avoid per-Plan allocation on the hot path).
    private readonly Dictionary<string, List<string>> _childrenByParent = new(StringComparer.Ordinal);

    private static readonly HashSet<string> EmptySet = new(StringComparer.Ordinal);

    private readonly Dictionary<CardReject, int> _histogram = new();
    public IReadOnlyDictionary<CardReject, int> LastRejectHistogram => _histogram;
    public int LastEvaluated { get; private set; }
    public int LastPromoted { get; private set; }

    // WS-CRISP capture (dumpcrisp verb): when CaptureRejects is set the LAST Plan records the per-NCard-root first-fail
    // reject (None for a promoted root). Opt-in so a normal card eval pays zero recording cost; cleared + refilled by
    // that diagnostic Plan. The controller augments each root with its unsettled member ids + wantUrls off the views.
    public bool CaptureRejects;
    private readonly Dictionary<string, CardReject> _rejectByRoot = new(StringComparer.Ordinal);
    public IReadOnlyDictionary<string, CardReject> LastRejectByRoot => _rejectByRoot;

    // WS-CRISP: every top-level NCard root the LAST Plan discovered and evaluated (Pass 0 candidates — nested cards
    // are claimed by their outer root and not listed). The TextOverlay reads this via the
    // controller: a root in here that is NOT currently promoted was DECLINED, so its labels may promote as loose
    // text; a root NOT in here is unknown-this-plan and stays conservatively card-owned.
    private readonly HashSet<string> _lastCandidateRoots = new(StringComparer.Ordinal);
    public IReadOnlyCollection<string> LastCandidateRoots => _lastCandidateRoots;

    public Action<string>? Debug;

    public void RebuildIndex(MirrorState state) => _tables.RebuildIndex(state);

    // ---- the plan --------------------------------------------------------------------------------------------------

    public CardLayerPlan Plan(
        MirrorState state,
        GlobalTransformIndex transforms,
        double spreadFactor,
        Func<string, double> spreadDxOf,
        IReadOnlySet<string> dynamicallyExcluded,
        IReadOnlySet<string> transformOwned,
        IReadOnlySet<string>? boundedCosmetic = null,
        IReadOnlySet<string>? unsettledExcluded = null,
        Func<string, double>? spreadWidthOf = null,
        IReadOnlyDictionary<string, DesignAabb>? blockerArtExtents = null,
        IReadOnlyDictionary<string, DesignAabb>? blockerArtHoles = null)
    {
        boundedCosmetic ??= EmptySet;
        _histogram.Clear();
        LastEvaluated = 0;
        LastPromoted = 0;
        if (CaptureRejects)
        {
            _rejectByRoot.Clear();
        }

        var ordered = state.OrderedIds;
        int n = ordered.Count;
        if (n == 0)
        {
            return CardLayerPlan.None;
        }

        bool widened = spreadFactor != 1;
        double designWidth = 1920 * spreadFactor;

        BuildChildren(state); // parent → children, each list sorted by paint-order index

        // ---- Pass 0: candidate discovery (NCard leaves; a candidate whose ancestor is an accepted card is Nested) ---
        var candidates = new List<string>();
        var acceptedRoots = new HashSet<string>(StringComparer.Ordinal);
        _lastCandidateRoots.Clear();
        for (int i = 0; i < n; i++)
        {
            var id = ordered[i];
            if (!state.Nodes.TryGetValue(id, out var node) || NodeTypeLeaf(node.NodeType) != "NCard")
            {
                continue;
            }

            if (AncestorInSet(state, id, acceptedRoots))
            {
                Bump(CardReject.Nested); // nested inside an already-accepted outer card — the outer clones it
                if (CaptureRejects)
                {
                    _rejectByRoot[id] = CardReject.Nested;
                }

                Debug?.Invoke($"eval root={id} name='{node.Name}' reject=Nested");
                continue;
            }

            candidates.Add(id);
            acceptedRoots.Add(id);
            _lastCandidateRoots.Add(id);
        }

        // Everything under any accepted card (members + effect subtrees) is "claimed" — never an independent Pass A
        // blocker. Computed from the parent structure (robust to the non-contiguous OrderedIds span).
        var claimed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var root in candidates)
        {
            CollectSubtree(root, claimed);
        }

        // ---- Pass 0b: eligibility per candidate → eligible clusters + rejected-but-visible blockers -----------------
        var eligible = new List<CardClusterItem>();
        var rejectedBlockers = new List<(string Id, DesignAabb Box)>();
        foreach (var rootId in candidates)
        {
            LastEvaluated++;
            var r = Evaluate(rootId, state, transforms, spreadDxOf, widened, designWidth, dynamicallyExcluded,
                transformOwned, unsettledExcluded ?? EmptySet, spreadWidthOf);

            // Per-candidate eval trace (mirrors TextOverlayPlanner's `eval id=… reject=…` line): one line per NCard
            // root naming its pre-occlusion verdict, so a "why is this dialog/reward card not crisp" diagnosis reads
            // straight off the gated debug log instead of a debugger. Occlusion verdicts land in Pass B ("card-
            // occluded …"). Null sink in production — zero cost.
            if (Debug is not null && state.Nodes.TryGetValue(rootId, out var rootNode))
            {
                Debug($"eval root={rootId} name='{rootNode.Name}' reject={r.Reject} box={FormatBox(r.Aabb)} " +
                      $"visible={r.Visible} members={r.Cluster?.MemberIds.Count ?? 0} effZ={_tables.EffZOf(rootId)}");
            }

            if (CaptureRejects)
            {
                _rejectByRoot[rootId] = r.Reject; // pre-occlusion verdict; overwritten to Occluded in Pass B if it falls there
            }

            if (r.Reject == CardReject.None && r.Cluster is { } built)
            {
                eligible.Add(built);
            }
            else
            {
                Bump(r.Reject);
                if (r.Visible && r.Reject != CardReject.Offscreen && r.Aabb is { } ab)
                {
                    rejectedBlockers.Add((rootId, ab));
                }
            }
        }

        // ---- Pass A: decision events (eligible) + rejected-card blockers + blockers from non-claimed painters -------
        var events = new List<Event>(eligible.Count + 16);
        var agnostic = new List<CardBlocker>();
        bool agnosticUnknown = false;
        string? agnosticUnknownId = null;

        for (int ci = 0; ci < eligible.Count; ci++)
        {
            var c = eligible[ci];
            events.Add(new Event(PaintOrderTables.PaintKey(_tables.EffZOf(c.RootId), _tables.IndexOf(c.RootId), 0, 0),
                EventKind.Decision, c.RootId, c.Aabb, Suffix: false, ClusterIdx: ci));
        }

        foreach (var (rid, box) in rejectedBlockers)
        {
            events.Add(new Event(PaintOrderTables.PaintKey(_tables.EffZOf(rid), _tables.IndexOf(rid), 0, 0),
                EventKind.SelfPaint, rid, box, Suffix: false, ClusterIdx: -1));
        }

        for (int i = 0; i < n; i++)
        {
            var id = ordered[i];
            if (claimed.Contains(id) || !state.Nodes.TryGetValue(id, out var node))
            {
                continue; // a card's members/effects are represented as clusters, never as independent blockers
            }

            bool paintsSelf = PaintOrderTables.IsOpaqueBlocker(node) && PaintOrderTables.ChainCovers(state, node, id);
            // A text blocker must render visible through its WHOLE chain (ChainCovers), NOT just its own Visible flag —
            // else a HIDDEN dev-console overlay (an NDevConsole whose text node is Visible=true but whose ConsoleScreen
            // ancestor is Visible=false) would spuriously occlude every card under it.
            bool textBearing = node.Text is { Text.Length: > 0 } && PaintOrderTables.ChainCovers(state, node, id);
            if (!paintsSelf && !textBearing)
            {
                continue;
            }

            DesignAabb? labelBox = PaintOrderTables.RenderedAabb(id, node, transforms, spreadDxOf, widened, CardSlackPx, SpreadSlackPx);

            // WS-crisp2: a client-MEASURED drawn-art box for a textured occluder (decode-time alpha used-rect,
            // stretch-mapped into the drawn frame by the live view) tightens the layout-rect blocker box — the same
            // occluder-tightening the TextOverlay planner already applies (a deck-dialog `BorderGradient` streams no
            // TextureRegion, so BlockerAabb can only give its full 1920×1002 rect). Can only SHRINK vs the rect ⇒
            // never under-covers real art. Absent id → the conservative BlockerAabb (byte-identical to pre-crisp2).
            DesignAabb? blockerBox = !paintsSelf ? null
                : blockerArtExtents is { } artMap && artMap.TryGetValue(id, out var art) ? art
                : PaintOrderTables.BlockerAabb(id, node, transforms, spreadDxOf, widened);

            // WS-crisp2: a measured transparent HOLE inside this blocker's art (the see-through middle band of a
            // stretched scroll-edge fade covering the whole grid) — a card whose box sits entirely inside the hole is
            // NOT covered. Only trusted for a STATIC blocker (a jittering one's hole moves), mirroring the text side.
            DesignAabb? blockerHole = paintsSelf && !dynamicallyExcluded.Contains(id)
                && blockerArtHoles is { } holeMap && holeMap.TryGetValue(id, out var hole)
                ? hole
                : null;

            // Z-indexed painters use their effective Z paint key; only ShowBehindParent remains order-agnostic.
            bool orderAgnostic = node.ShowBehindParent;
            if (orderAgnostic && (paintsSelf || textBearing))
            {
                DesignAabb? agBox = textBearing ? labelBox : blockerBox;
                if (agBox is { } ab)
                {
                    agnostic.Add(new CardBlocker(PaintOrderTables.Blocker(id, ab, dynamicallyExcluded, boundedCosmetic,
                        PaintOrderTables.DynamicSlackPx, PaintOrderTables.BoundedCosmeticSlackPx), id,
                        textBearing ? null : blockerHole));
                }
                else
                {
                    agnosticUnknown = true;
                    agnosticUnknownId ??= id;
                }

                continue;
            }

            if (paintsSelf && !(blockerBox is null && PaintOrderTables.IsEffectBearing(node)))
            {
                DesignAabb? haloed = blockerBox is { } bb
                    ? PaintOrderTables.Blocker(id, bb, dynamicallyExcluded, boundedCosmetic,
                        PaintOrderTables.DynamicSlackPx, PaintOrderTables.BoundedCosmeticSlackPx)
                    : (DesignAabb?)null;
                events.Add(new Event(PaintOrderTables.PaintKey(_tables.EffZOf(id), _tables.IndexOf(id), 0, 0),
                    EventKind.SelfPaint, id, haloed, Suffix: transformOwned.Contains(id), ClusterIdx: -1, Hole: blockerHole));
            }

            if (textBearing)
            {
                events.Add(new Event(PaintOrderTables.PaintKey(_tables.EffZOf(id), _tables.SubtreeEndOf(id), 1, -_tables.DepthOf(id)),
                    EventKind.Text, id, labelBox, Suffix: false, ClusterIdx: -1));
            }
        }

        // ---- Pass B: single reverse sweep (latest paint key first) --------------------------------------------------
        events.Sort(static (a, b) => b.Key.CompareTo(a.Key));

        var blockers = new List<CardBlocker>();
        bool suffixBlockAll = agnosticUnknown;
        string? suffixCulprit = agnosticUnknownId;
        var promotedIdx = new List<int>();

        foreach (var ev in events)
        {
            switch (ev.Kind)
            {
                case EventKind.SelfPaint:
                    if (ev.Suffix || ev.Box is null)
                    {
                        suffixBlockAll = true;
                        suffixCulprit ??= ev.Id;
                    }
                    else
                    {
                        blockers.Add(new CardBlocker(ev.Box.Value, ev.Id, ev.Hole));
                    }

                    break;

                case EventKind.Text:
                    if (ev.Box is { } tb)
                    {
                        blockers.Add(new CardBlocker(tb, ev.Id, null));
                    }
                    else
                    {
                        suffixBlockAll = true;
                        suffixCulprit ??= ev.Id;
                    }

                    break;

                case EventKind.Decision:
                    var aabb = ev.Box!.Value;
                    string? culprit;
                    DesignAabb? culpritBox = null;
                    if (suffixBlockAll)
                    {
                        culprit = suffixCulprit;
                    }
                    else if (FirstOverlapEntry(aabb, blockers) is { } hb)
                    {
                        culprit = hb.Id;
                        culpritBox = hb.Box;
                    }
                    else if (FirstOverlapEntry(aabb, agnostic) is { } ha)
                    {
                        culprit = ha.Id;
                        culpritBox = ha.Box;
                    }
                    else
                    {
                        culprit = null;
                    }

                    if (culprit is not null)
                    {
                        Bump(CardReject.Occluded);
                        if (CaptureRejects)
                        {
                            _rejectByRoot[ev.Id] = CardReject.Occluded;
                        }

                        if (Debug is not null)
                        {
                            string cn = state.Nodes.TryGetValue(culprit, out var cnode) ? cnode.Name : "?";
                            Debug($"card-occluded root={ev.Id} by={culprit} byName='{cn}' byType={cnode?.NodeType ?? "?"} " +
                                  $"byDyn={dynamicallyExcluded.Contains(culprit)} byBox={FormatBox(culpritBox)} box={FormatBox(aabb)}");
                        }

                        blockers.Add(new CardBlocker(aabb, ev.Id, null)); // demoted → its in-stage raster covers earlier cards (leftward cascade)
                    }
                    else
                    {
                        promotedIdx.Add(ev.ClusterIdx);
                    }

                    break;
            }
        }

        promotedIdx.Reverse(); // filled in descending-key order → reverse to ascending
        var promoted = new List<CardClusterItem>(promotedIdx.Count);
        foreach (var idx in promotedIdx)
        {
            promoted.Add(eligible[idx]);
        }

        LastPromoted = promoted.Count;
        return new CardLayerPlan(promoted);
    }

    // ---- per-drain demotion guard --------------------------------------------------------------------------------

    // Given the CURRENTLY promoted clusters, decide which whole clusters demote (by root id), which members rebuild
    // their clone in place (by member id), and which demotes are transient churn (by root id). Conservatism invariant
    // (tested): the demote set is a SUPERSET of what a fresh Plan would now reject for those roots.
    //
    // DELIBERATE INVERSION of TextOverlay's rule 2: a hint on the ROOT or an ANCESTOR does NOT demote (the holder
    // tracks that motion per-frame). Only a NON-ROOT member going dynamic / a hint on a non-root member demotes.
    public void CollectDemotions(
        MirrorState state,
        GlobalTransformIndex transforms,
        double spreadFactor,
        Func<string, double> spreadDxOf,
        IReadOnlyList<CardClusterItem> promoted,
        IReadOnlySet<string> changedIds,
        IReadOnlyList<MirrorTweenHint> hints,
        IReadOnlySet<string> dynamicallyExcluded,
        IReadOnlySet<string> transformOwned,
        ISet<string> demoteInto,
        ISet<string> rebuildInto,
        ISet<string>? churnDemoteInto = null,
        IReadOnlySet<string>? unsettledExcluded = null)
    {
        unsettledExcluded ??= EmptySet;
        demoteInto.Clear();
        rebuildInto.Clear();
        churnDemoteInto?.Clear();
        if (promoted.Count == 0)
        {
            return;
        }

        bool widened = spreadFactor != 1;

        var memberOwner = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var c in promoted)
        {
            foreach (var m in c.MemberIds)
            {
                memberOwner[m] = c.RootId;
            }
        }

        void Demote(string root, bool churn)
        {
            demoteInto.Add(root);
            rebuildInto.Remove(root);
            if (churn)
            {
                churnDemoteInto?.Add(root);
            }
        }

        // 1. Changed members: revalidate (rebuild in place if still cloneable, demote if broken); a NON-ROOT member
        //    that went dynamic ⇒ demote + churn.
        foreach (var id in changedIds)
        {
            if (!memberOwner.TryGetValue(id, out var root) || demoteInto.Contains(root))
            {
                continue;
            }

            bool isRoot = id == root;
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                Demote(root, churn: false);
                continue;
            }

            if (PaintOrderTables.IsEffectBearing(node) || (node.ZIndex is { } z && z != 0))
            {
                Demote(root, churn: false);
                continue;
            }

            if (!isRoot && MemberDynamic(id, unsettledExcluded))
            {
                Demote(root, churn: true);
                continue;
            }

            rebuildInto.Add(id);
        }

        // 2. The per-frame member-clone sync tracks non-root tween motion. Root and ancestor hints are ignored.

        // 3. A changed NON-member painter now overlapping a promoted cluster ⇒ demote (a new occluder appeared).
        foreach (var id in changedIds)
        {
            if (memberOwner.ContainsKey(id) || !state.Nodes.TryGetValue(id, out var node) || !PaintsAny(state, id, node))
            {
                continue;
            }

            if (PaintOrderTables.RenderedAabb(id, node, transforms, spreadDxOf, widened, CardSlackPx, SpreadSlackPx) is not { } cbox)
            {
                continue;
            }

            foreach (var c in promoted)
            {
                if (!demoteInto.Contains(c.RootId) && cbox.Overlaps(c.Aabb))
                {
                    Demote(c.RootId, churn: false);
                }
            }
        }

        // 4. A transform hint's SWEPT box crossing a promoted cluster ⇒ demote — UNLESS the hint targets a member of,
        //    or an ancestor of, that cluster's root (that motion the holder already tracks).
        foreach (var h in hints)
        {
            if (h.EndTransform is not { Count: 6 } endT
                || !state.Nodes.TryGetValue(h.TargetId, out var tn)
                || tn.LocalRect is not { } rect)
            {
                continue;
            }

            DesignAabb? cur = PaintOrderTables.RenderedAabb(h.TargetId, tn, transforms, spreadDxOf, widened, 0, SpreadSlackPx);
            var endBox = CullBounds.OfRect(endT, rect.X, rect.Y, rect.Width, rect.Height);
            var swept = cur is { } cc ? cc.Union(endBox) : endBox;

            foreach (var c in promoted)
            {
                if (demoteInto.Contains(c.RootId)
                    || memberOwner.ContainsKey(h.TargetId)
                    || IsAncestorOf(state, h.TargetId, c.RootId))
                {
                    continue;
                }

                if (swept.Overlaps(c.Aabb))
                {
                    Demote(c.RootId, churn: false);
                }
            }
        }

        // 5 (WS-CRISP #14 Leg A). A promoted cluster whose PROVEN clipping ancestor changed this drain ⇒ demote. The
        //    clip-contains relax promoted this card on the proof that the clip rect fully contains it; a scroll (the
        //    ScrollContainer's own node changing) moves that containment out from under the proof mid-drain, and the
        //    un-nested clone tree cannot reproduce the crop. Demote-on-scroll (the card re-promotes at the next eval if
        //    still fully inside) instead of building clip tracking. Mirrors TextOverlayPlanner.CollectDemotions rule 5.
        //    O(changed) — small ancestor lists.
        foreach (var c in promoted)
        {
            if (demoteInto.Contains(c.RootId) || c.ClipAncestorIds.Count == 0)
            {
                continue;
            }
            foreach (var cid in c.ClipAncestorIds)
            {
                if (changedIds.Contains(cid))
                {
                    Demote(c.RootId, churn: false);
                    break;
                }
            }
        }
    }

    // ---- eligibility ---------------------------------------------------------------------------------------------

    private readonly record struct EvalResult(
        CardReject Reject, DesignAabb? Aabb, bool Visible, CardClusterItem? Cluster);

    private EvalResult Evaluate(
        string rootId, MirrorState state, GlobalTransformIndex transforms, Func<string, double> spreadDxOf,
        bool widened, double designWidth, IReadOnlySet<string> dynamicallyExcluded, IReadOnlySet<string> transformOwned,
        IReadOnlySet<string> unsettledExcluded,
        Func<string, double>? spreadWidthOf)
    {
        var rootNode = state.Nodes[rootId];

        // Exclusive ancestor chain: clip → effect → blend → z-order (+ accumulate visibility). Clip ancestors are
        // recorded (not an instant reject), while a non-clip special ancestor still rejects. A clip
        //     ancestor rejects ONLY when its exact clip rect fails to CONTAIN the cluster union (WS-CRISP #14 Leg A:
        //     the deck/draw/discard/smith GRID cards sit in a ScrollContainer whose rect fully contains every settled
        //     grid cell, so the un-nested clone reproduces no crop — the same clip-contains proof Track-B uses).
        CardReject nonClipReject = CardReject.None;
        List<string>? clipAncestors = null;
        bool anyInvisible = !rootNode.Visible;
        string? cur = rootNode.ParentId;
        int guard = 0;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var an) && guard++ < 4096)
        {
            bool clips = _clips(an);
            bool effect = PaintOrderTables.IsEffectBearing(an);
            bool blend = an.CanvasBlendMode is { } bm && bm != 0;
            bool zorder = an.ShowBehindParent;

            // Record every clip ancestor; the first non-clip special ancestor still rejects.
            if (clips)
            {
                (clipAncestors ??= new List<string>()).Add(cur);
            }

            if (nonClipReject == CardReject.None)
            {
                if (effect)
                {
                    nonClipReject = CardReject.AncestorEffect;
                }
                else if (blend)
                {
                    nonClipReject = CardReject.AncestorBlend;
                }
                else if (zorder)
                {
                    nonClipReject = CardReject.ZOrder;
                }
            }

            if (!an.Visible)
            {
                anyInvisible = true;
            }

            cur = an.ParentId;
        }

        bool visible = !anyInvisible && PaintOrderTables.EffectiveModulate(state, rootId).A > 0.02;

        // Member enumeration: DFS the card root's descendants via the children map (pre-order, siblings by paint index).
        // An effect-bearing member's whole subtree → LiveEffectIds (not cloned); a cloneable member with ZIndex≠0 →
        // ZOrder; a NON-ROOT dynamic member → MemberDynamic; else clone + accumulate the cluster AABB.
        var members = new List<string>();
        var liveEffects = new List<string>();
        DesignAabb? aabb = null;
        bool unknownBoundsPaint = false;
        CardReject memberReject = CardReject.None;

        var stack = new Stack<string>();
        stack.Push(rootId);
        while (stack.Count > 0)
        {
            var mid = stack.Pop();
            if (!state.Nodes.TryGetValue(mid, out var mnode))
            {
                continue;
            }

            if (mid != rootId && IsLiveOnlyEffect(mnode))
            {
                CollectSubtree(mid, liveEffects); // particle/spine subtree stays live in-stage (not cloned, not suppressed)
                continue; // do not recurse into it for members
            }

            if (memberReject == CardReject.None)
            {
                if (mnode.ZIndex is { } mz && mz != 0)
                {
                    memberReject = CardReject.ZOrder;
                }
                else if (mid != rootId && MemberDynamic(mid, unsettledExcluded))
                {
                    memberReject = CardReject.MemberDynamic;
                }
            }

            members.Add(mid);

            // Cluster AABB (for occlusion) accumulates ONLY reliable-geometry members — those NOT effect-bearing. A
            // shader/material member's RENDERED extent is unknowable: a card's Highlight / glass-overlay is a Mix-blend
            // HSV shader whose layout rect (e.g. 759×951) is a mostly-transparent GLOW halo ~2.5× the card body, so
            // unioning it balloons the AABB and a UI button near the halo falsely occludes the card. The non-shader
            // members (Shadow ≈ the card body, backgrounds, text labels, additive borders) define the reliable readable
            // silhouette. The shader members are STILL cloned (added to `members` above) — only their box is untrusted.
            if (!PaintOrderTables.IsEffectBearing(mnode))
            {
                bool isText = mnode.Text is { Text.Length: > 0 };
                double slack = isText ? CardSlackPx : 0;
                var box = PaintOrderTables.RenderedAabb(mid, mnode, transforms, spreadDxOf, widened, slack, SpreadSlackPx);
                if (box is { } b && b.MaxX > b.MinX && b.MaxY > b.MinY)
                {
                    aabb = aabb is { } a ? a.Union(b) : b;
                }
                else if (box is null && PaintsSomething(mnode))
                {
                    unknownBoundsPaint = true;
                }
            }

            // Push children in REVERSE (paint-index-sorted) order so they POP in forward order → pre-order, siblings
            // in paint order (the clone build AddChilds in this order → the clone's sibling paint order matches live).
            if (_childrenByParent.TryGetValue(mid, out var kids))
            {
                for (int k = kids.Count - 1; k >= 0; k--)
                {
                    stack.Push(kids[k]);
                }
            }
        }

        // Resolve the ancestor verdict now that the cluster union is known (the clip-contains proof needs it).
        CardReject ancestorReject = nonClipReject != CardReject.None
            ? nonClipReject
            : clipAncestors is not null
                ? aabb is { } cu && AllClipsContain(clipAncestors, cu, state, transforms, spreadDxOf, spreadWidthOf, widened)
                    ? CardReject.None
                    : CardReject.AncestorClip
                : CardReject.None;

        if (ancestorReject != CardReject.None)
        {
            return new EvalResult(ancestorReject, visible ? aabb : null, visible, null);
        }

        if (!visible)
        {
            return new EvalResult(CardReject.Invisible, null, false, null);
        }

        if (unknownBoundsPaint || aabb is not { } union)
        {
            return new EvalResult(CardReject.UnknownBounds, null, true, null);
        }

        if (union.FullyOutside(designWidth, DesignHeight, 0))
        {
            return new EvalResult(CardReject.Offscreen, union, true, null);
        }

        if (memberReject != CardReject.None)
        {
            return new EvalResult(memberReject, union, true, null); // rejected but visible → blocks earlier cards
        }

        // The clip ancestors are proven to contain the union (or there are none) → carry them so the per-drain guard
        // (CollectDemotions rule 5) can demote the cluster if one scrolls this drain.
        IReadOnlyList<string> clipIds = clipAncestors is null ? System.Array.Empty<string>() : clipAncestors;
        var cluster = new CardClusterItem(rootId, PaintOrderTables.PaintKey(_tables.EffZOf(rootId), _tables.IndexOf(rootId), 0, 0), union, members, liveEffects, clipIds);
        return new EvalResult(CardReject.None, union, true, cluster);
    }

    // The clip-containment proof: every clipping ancestor's
    // exact rendered rect must FULLY contain the cluster union. A null clip rect (unknown global/geometry) fails
    // conservatively. Uses the shared width-aware ClipRenderedAabb so a horizontally-stretched ScrollContainer at F≠1
    // is measured at its true anchor-widened width (else the rightmost grid column falsely fails Contains).
    private static bool AllClipsContain(
        List<string> clipAncestors, DesignAabb union, MirrorState state, GlobalTransformIndex transforms,
        Func<string, double> spreadDxOf, Func<string, double>? spreadWidthOf, bool widened)
    {
        foreach (var cid in clipAncestors)
        {
            if (!state.Nodes.TryGetValue(cid, out var cnode)
                || PaintOrderTables.ClipRenderedAabb(cid, cnode, transforms, spreadDxOf, spreadWidthOf, widened) is not { } clipRect
                || !Contains(clipRect, union))
            {
                return false;
            }
        }

        return true;
    }

    // Does `outer` fully contain `inner`? (Mirrors TextOverlayPlanner.Contains.)
    private static bool Contains(DesignAabb outer, DesignAabb inner) =>
        outer.MinX <= inner.MinX && outer.MinY <= inner.MinY && outer.MaxX >= inner.MaxX && outer.MaxY >= inner.MaxY;

    // ---- helpers -------------------------------------------------------------------------------------------------

    // Build parent → children over the whole scene, each child list sorted by paint-order index (so a DFS visits
    // siblings in paint order). Reused scratch, rebuilt per Plan.
    private void BuildChildren(MirrorState state)
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

        foreach (var list in _childrenByParent.Values)
        {
            if (list.Count > 1)
            {
                list.Sort((a, b) => _tables.IndexOf(a).CompareTo(_tables.IndexOf(b)));
            }
        }
    }

    // Add `root` + all its descendants (via the children map) to `into`.
    private void CollectSubtree(string root, ICollection<string> into)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        int guard = 0;
        while (stack.Count > 0 && guard++ < 1 << 20)
        {
            var id = stack.Pop();
            into.Add(id);
            if (_childrenByParent.TryGetValue(id, out var kids))
            {
                foreach (var k in kids)
                {
                    stack.Push(k);
                }
            }
        }
    }

    // Per-frame member-clone sync tracks transform, opacity, and input-lift motion. Only an unsettled texture rejects:
    // cloning it could freeze a blank surface.
    private static bool MemberDynamic(string mid, IReadOnlySet<string> unsettledExcluded) =>
        unsettledExcluded.Contains(mid);

    private static bool AncestorInSet(MirrorState state, string id, IReadOnlySet<string> set)
    {
        string? cur = state.Nodes.TryGetValue(id, out var node) ? node.ParentId : null;
        int guard = 0;
        while (cur is not null && guard++ < 4096)
        {
            if (set.Contains(cur))
            {
                return true;
            }

            cur = state.Nodes.TryGetValue(cur, out var n) ? n.ParentId : null;
        }

        return false;
    }

    // One accumulated occluder of a card: its (haloed) box, its id, and (WS-crisp2) an optional transparent HOLE
    // inside its art — the card is only covered when the overlapped region reaches OUTSIDE the hole. Mirrors
    // TextOverlayPlanner.BlockerEntry.
    private readonly record struct CardBlocker(DesignAabb Box, string Id, DesignAabb? Hole);

    // Does blocker `b` actually cover any part of `box`? Overlap of the blocker box, minus the hole exemption: when the
    // whole overlapped region lies INSIDE the blocker's transparent hole, nothing painted sits over the card. Mirrors
    // TextOverlayPlanner.Covers exactly (the card side must decide occlusion by the same model the text side does).
    private static bool Covers(DesignAabb box, in CardBlocker b)
    {
        if (!box.Overlaps(b.Box))
        {
            return false;
        }

        if (b.Hole is not { } h)
        {
            return true;
        }

        double ix0 = Math.Max(box.MinX, b.Box.MinX);
        double iy0 = Math.Max(box.MinY, b.Box.MinY);
        double ix1 = Math.Min(box.MaxX, b.Box.MaxX);
        double iy1 = Math.Min(box.MaxY, b.Box.MaxY);
        return !(h.MinX <= ix0 && h.MinY <= iy0 && h.MaxX >= ix1 && h.MaxY >= iy1);
    }

    private static string? FirstOverlap(DesignAabb box, List<CardBlocker> against)
    {
        foreach (var b in against)
        {
            if (Covers(box, b))
            {
                return b.Id;
            }
        }

        return null;
    }

    // Diagnostics variant of FirstOverlap: returns the overlapping blocker's box too (for the gated debug trace).
    // Mirrors TextOverlayPlanner.FirstOverlapEntry.
    private static (string Id, DesignAabb Box)? FirstOverlapEntry(DesignAabb box, List<CardBlocker> against)
    {
        foreach (var b in against)
        {
            if (Covers(box, b))
            {
                return (b.Id, b.Box);
            }
        }

        return null;
    }

    // Compact "[minX,minY maxX,maxY]" formatting for the gated debug trace (null box → "none"). Mirrors
    // TextOverlayPlanner.FormatBox.
    private static string FormatBox(DesignAabb? box) =>
        box is { } b ? $"[{b.MinX:0},{b.MinY:0} {b.MaxX:0},{b.MaxY:0}]" : "none";

    // Any own OPAQUE paint incl. visible text, rendered visible through the WHOLE ancestor chain — the "a changed node
    // now covers a promoted card" test. The chain gate keeps a chain-hidden painter (a closed dev console) from
    // demoting a card it geometrically overlaps.
    private static bool PaintsAny(MirrorState state, string id, MirrorNode node) =>
        (PaintOrderTables.IsOpaqueBlocker(node) || node.Text is { Text.Length: > 0 })
        && PaintOrderTables.ChainCovers(state, node, id);

    // Does the node emit any visible pixels of its own (independent of a known box)?
    private static bool PaintsSomething(MirrorNode node) =>
        node.TextureUrl is not null
        || node.FillColor is not null
        || node.Range is not null
        || node.Text is { Text.Length: > 0 };

    // True when `ancestorId` is a strict ancestor of `id`.
    private static bool IsAncestorOf(MirrorState state, string ancestorId, string id)
    {
        string? cur = state.Nodes.TryGetValue(id, out var node) ? node.ParentId : null;
        int guard = 0;
        while (cur is not null && guard++ < 4096)
        {
            if (string.Equals(cur, ancestorId, StringComparison.Ordinal))
            {
                return true;
            }

            cur = state.Nodes.TryGetValue(cur, out var n) ? n.ParentId : null;
        }

        return false;
    }

    // The card members that MUST stay live in-stage (NOT cloned): particle systems and spine skeletons. Unlike a
    // shader/material member — which a full MirrorNodeView CLONE renders crisp at design res (the shader shades the
    // clone's own draw; hoist-suppression skips the LIVE member's _Draw so the shader doesn't double-draw) — a
    // particle/spine member draws through an attached CHILD node that the parent's _Draw skip does NOT suppress, so
    // cloning + hoisting it would DOUBLE the particles/skeleton (live + clone). Keeping them live (in-stage, at the
    // scaled res behind the crisp clone) is the documented cosmetic trade: sparkle/glow over the card face is covered
    // by the crisp clone; spill beyond the silhouette survives. Card FRAMES use an HSV-recolor shader — those ARE
    // cloned (else the shader-framed chrome, which paints IN FRONT of the portrait, would strand behind the cloned
    // portrait on the layer above).
    private static bool IsLiveOnlyEffect(MirrorNode node) =>
        node.ParticleSpec is not null || node.SpineSceneResPath is not null;

    private static string NodeTypeLeaf(string nodeType)
    {
        int dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }

    private void Bump(CardReject reject)
    {
        _histogram.TryGetValue(reject, out var c);
        _histogram[reject] = c + 1;
    }

    private enum EventKind
    {
        SelfPaint,
        Text,
        Decision,
    }

    private readonly record struct Event(
        long Key,
        EventKind Kind,
        string Id,
        DesignAabb? Box,
        bool Suffix,
        int ClusterIdx,
        DesignAabb? Hole = null);
}

// One promotable card: its root wire id, its paint key (ascending = holder MoveChild order), its cluster design-space
// AABB (the union of the cloneable members' boxes), the pre-order cloneable member ids (root first, siblings in paint
// order), the effect subtrees left live in-stage (neither cloned nor hoisted), and (WS-CRISP #14 Leg A) the ids of the
// clipping ancestors whose rect PROVABLY contains the cluster union — the ancestors that let this card promote under
// the clip-contains relax. Empty when the card has no clip ancestors (the common case) or the relax is off (a clip
// ancestor then rejects outright). CollectDemotions rule 5 demotes the cluster when any proven clip ancestor changes
// this drain (a scroll moves that containment out from under the proof; the un-nested clone can't reproduce a crop).
public readonly record struct CardClusterItem(
    string RootId,
    long PaintKey,
    DesignAabb Aabb,
    IReadOnlyList<string> MemberIds,
    IReadOnlyList<string> LiveEffectIds,
    IReadOnlyList<string> ClipAncestorIds);

public readonly record struct CardLayerPlan(IReadOnlyList<CardClusterItem> Clusters)
{
    public bool HasAny => Clusters.Count > 0;

    public static readonly CardLayerPlan None = new(Array.Empty<CardClusterItem>());
}
