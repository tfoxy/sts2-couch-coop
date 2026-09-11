// Track-C "full-resolution card layer". At a Half/Quarter render scale the whole mirror stage rasterizes at design/2
// (or /4) res and is scaled up, so a CARD — its title / type / description text AND its framed art, read
// pixel-for-pixel — turns mushy. Track-B (TextOverlay) promotes only the label text; this controller promotes WHOLE
// eligible NCard subtrees as design-res CLONES onto a CanvasLayer (Layer 16, between the stage at 0 and the TextOverlay
// at 32). Per promoted card: a Node2D holder at the live root view's exact global transform (design space == the
// design-res root RT under NOSTRETCH) carrying a nested MirrorNodeView clone tree built by the SAME view.Apply as the
// live views — identical drawers/materials/text layout, but rasterized crisp at native res. The live card members'
// self-paint is HOISTED-suppressed (view.SetSelfPaintHoisted) so they don't double-draw UNDER the clone; effect
// subtrees (glow/sparkles) stay LIVE in-stage (the crisp clone covers the card face; only spill beyond the silhouette
// survives — a documented cosmetic trade). Result: "perceived Full" cards at Half's cheaper fill rate.
//
// The pure-C# CardLayerPlanner owns the eligibility + paint-order occlusion math (Godot-free, Exe-tested, reusing the
// shared PaintOrderTables). This controller owns the Godot clone build/free, the per-frame holder sync (the crux of
// crisp-during-hover/drag — a moving card is tracked by re-sampling GetGlobalTransform, NOT re-cloned), the per-drain
// demotion guard, and the gating.
//
// Active when the "Crisp text" client setting is on and RenderScale != Full. Promotion runs at an eval cadence (every EvalCadenceFrames
// AND AssetStores.AllIdle — the font/asset-settled gate) plus an immediate structural replan on OrderChanged (a hand
// re-fan). Per-frame work is holder transform/visibility only. Active→false ⇒ TeardownAll. Freed with the stage.

using System.Collections.Generic;
using System.Text.Json.Nodes;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.GodotClient.Ui;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class CardLayer : CanvasLayer
{
    // Each promoted cluster's member clones copy their live member's local transform +
    // modulate every frame, so a card promotes DURING deal-in with its members tracked live (MemberDynamic now rejects
    // ONLY an unsettled TEXTURE); a fresh eligible card starts its amortized build the SAME drain (no AllIdle wait). This
    // is what makes a newly drawn card go crisp fast instead of after ~1s.
    // The planner sweeps in Godot's true effZ paint order, so a card in a z-band promotes iff
    // the content that actually paints over it overlaps. Byte-identical to OFF on an all-z=0 scene.
    // A card under a clipping
    // ancestor promotes when that ancestor's exact rect PROVABLY contains the cluster union — the fix for the
    // deck/draw/discard/exhaust dialog AND the rest-site Smith upgrade GRID, whose cards sit in a ScrollContainer that
    // fully contains every settled grid cell (C1: all 10 deck grid cards rejected AncestorClip at Half). The planner
    // stays env-free; this flag is passed through Plan/CollectDemotions. Byte-identical to OFF for a card with no clip
    // ancestor (the common case). A scroll demotes the cluster (planner rule 5) — the clone can't reproduce a crop.
    // WS-crisp2: feed textured-occluder drawn-art boxes + transparent HOLES to the planner so a scroll-edge fade scrim
    // (the deck-dialog `BorderGradient`) stops occluding cards inside its see-through middle. Rides the text overlay's
    // Planner art machinery shares the live view geometry collection with the text overlay.
    // env-gated per-transition trace (M3_CARDLAYER_TRANS lines) — the card-cluster half of the before/after headline.
    private static readonly bool TransDebug =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_TRANS_DEBUG") == "1";

    // env-gated per-cluster design-rect dump (one M3_CARD_RECTS block per eval) for the crisp-crop verification.
    private static readonly bool DumpRects =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_CARDRECTS") == "1";

    // env-gated per-demotion occlusion trace (M3_CARDLAYER_OCC lines).
    private static readonly bool DebugOcclusion =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_CARDLAYER_DEBUG") == "1";

    // Between the stage (root default canvas, Layer 0) and the TextOverlay (Layer 32). Immune to AppShell child-order
    // churn (CanvasLayers sort by Layer, not sibling order).
    private const int CardLayerLevel = 16;

    // OrderChanged (a hand re-fan) IMMEDIATELY re-plans + diffs (a pure hover reorder must cost 0 rebuilds). If the
    // WalkProfiler CardLayer bucket shows this hot, flip to false → the reorder falls back to the eval cadence.
    // static readonly (not const — same reason as StaticBakePlanner.RestrictToMixBlend) so the fallback else-branch
    // doesn't read as unreachable code.

    private const int EvalCadenceFrames = 30;

    // Re-promote debounce (Track-V churn dampener, reused). A card whose non-root member gains a short pulse/pop tween
    // is rule-2-demoted, settles before the next eval, re-promotes — thrash. After K such demotes within N evals, skip
    // RE-PROMOTING it for M evals (it stays in-stage, a hair mushy). The DEMOTE path is never skipped (correctness).
    private const int ChurnDemoteThreshold = 2;
    private const int ChurnWindowEvals = 4;
    private const int ChurnCooldownEvals = 4;

    private SceneReconciler _reconciler = null!;
    private MirrorStore _store = null!;
    private RenderContext _ctx = null!;

    private readonly CardLayerPlanner _planner = new();
    private System.Func<string, double> _spreadDxOf = null!;

    // WS-CRISP #14 Leg A: a node's anchor-WIDENED rendered width (SpreadRecord.RenderedWidth; 0 = no override). Fed to
    // the planner so the clip-contains proof measures a horizontally-stretched ScrollContainer at its TRUE rendered
    // width at F≠1 (mirrors TextOverlay._spreadWidthOf) — else the rightmost grid column falsely fails Contains.
    private System.Func<string, double> _spreadWidthOf = null!;

    // One promoted card's live clone tree.
    private sealed class Cluster
    {
        public required Node2D Holder;
        public required string RootId;
        public required MirrorNodeView RootClone;
        public required Dictionary<string, MirrorNodeView> Clones; // member id → clone
        public required List<string> MemberIds;                    // pre-order (root first)
        public required IReadOnlyList<string> ClipAncestorIds;     // #14 Leg A: proven-containing clip ancestors (per-drain rule 5)
        public long PaintKey;
        public DesignAabb Aabb;
        public Transform2D LastHolder;   // guarded per-frame write
        public Color LastRootMod;
        public Color LastRootSelfMod;
        public bool LastVisible;
    }

    private readonly Dictionary<string, Cluster> _clusters = new(System.StringComparer.Ordinal);

    // ---- park/revive (perf: the churny-combat window demotes + re-promotes the SAME cards every eval) -------------
    // A demoted cluster's clone tree is PARKED (holder hidden, kept in-tree under this CanvasLayer) instead of freed,
    // and a re-promotion of the same root with the same member set REVIVES it: re-stamp the spread channels and
    // re-Apply ONLY the members whose retained MirrorNode object changed since park (SceneTreeApplier REPLACES the
    // node object on every upsert — MergeNode returns upsert/upsert.Clone() — so a reference compare of
    // clone.NodeData vs state.Nodes[id] is a conservative-exact "unchanged" check). This reuses the clone's Godot
    // nodes, its per-view cached ShaderMaterial (ShaderAttachment's ConditionalWeakTable — so no fresh material build)
    // and its "__text" label — measured: a fresh 27-member build ≈3ms, a revive ≈0.1–0.5ms. This is a CardLayer-LOCAL
    // reuse list: parked clones are still plain-Free()d on eviction/teardown, NEVER ResetForPool (the clone assert).
    private readonly Dictionary<string, Cluster> _parked = new(System.StringComparer.Ordinal);
    private const int ParkedCap = 12; // ≥ max hand size; overflow evicts an arbitrary parked cluster (rare)

    // Telemetry: revive vs fresh-build split (surfaced in M3_CARDLAYER; proves the park path carries the churn).
    public long ReviveTotal { get; private set; }
    public long ReviveMembersReapplied { get; private set; }

    // ---- amortized fresh builds (perf: a fresh ~27-member clone build costs ~2.5ms — construction/AddChild + text
    // label configuration dominate, measured — which alone blows the <3ms structural budget). A fresh promotion is
    // ENQUEUED instead: the builder constructs at most BuildMembersPerFrame member clones per frame into the HIDDEN
    // holder, and only on completion re-syncs any members that drifted mid-build (reference compare, same as revive),
    // hoists the live members and shows the holder — there is never a half-built visible state; the in-stage card
    // stays live meanwhile, so the trade is a few frames of mushy on a NEW card. The --shot settle gate waits for the
    // queue to drain (IsShotSettled), keeping acceptance shots deterministic.
    private sealed class PendingBuild
    {
        public required CardClusterItem Item; // refreshed by Reconcile when a replan re-lists the same member set
        public required Node2D Holder;        // hidden until complete
        public required Dictionary<string, MirrorNodeView> Clones;
        public MirrorNodeView? RootClone;
        public int NextMember;
    }

    private readonly List<PendingBuild> _pending = new(); // built front-first, one cluster at a time
    private const int BuildMembersPerFrame = 8;           // ~0.8ms worst-case slice (measured ~0.1ms/member)

    // Q6-B: member ids Demote owed a SetSelfPaintHoisted(false) but whose live view was TRANSIENTLY unresolvable
    // (_reconciler.TryGetView false) at demote time — e.g. the in-hand discard select/return flow reparents the card
    // the SAME drain it demotes the cluster, so the view is momentarily missing from the reconciler's live index. The
    // old code silently skipped the un-hoist in that case and NEVER retried, leaving the member's
    // SelfPaintSuppress.Hoisted bit stuck forever (its _Draw permanently skips content = the card goes invisible back
    // in hand). Retried every frame (FlushPendingUnhoist) until the view resolves; also re-checked at TeardownAll
    // (cluster-teardown checkpoint) regardless of whether the lookup succeeds right then. A hoist-true write
    // (CompletePendingBuild / TryRevive) removes its id from this set immediately — a legitimate re-hoist must win
    // over a stale pending un-hoist from an earlier demote of the same id.
    private readonly HashSet<string> _pendingUnhoist = new(System.StringComparer.Ordinal);
    private readonly List<string> _unhoistResolvedScratch = new();

    // Reused scratch.
    private readonly HashSet<string> _excluded = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _unsettled = new(System.StringComparer.Ordinal); // Track-ST: ids with a pending texture fetch
    private readonly HashSet<string> _transformOwned = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _boundedCosmetic = new(System.StringComparer.Ordinal);

    // WS-crisp2: per-eval tightened drawn-art boxes + transparent HOLES for textured OCCLUDERS (decode-time alpha
    // used-rect + fade-hole, mapped through each live view's stretch mode + global transform — see
    // MirrorNodeView.TryGetBlockerArtRect). Fed to the planner so a scroll-edge fade scrim (the deck-dialog
    // `BorderGradient` covering the whole grid but painting only its extreme rows) no longer occludes a card whose box
    // sits inside its see-through middle. Built the same way TextOverlay builds its `_blockerArt` maps; missing art
    // data remains fail-closed.
    private readonly Dictionary<string, DesignAabb> _blockerArt = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, DesignAabb> _blockerArtHoles = new(System.StringComparer.Ordinal);
    private System.Action<MirrorNodeView> _blockerArtView = null!;

    private readonly HashSet<string> _planRoots = new(System.StringComparer.Ordinal);
    private readonly List<string> _removeScratch = new();
    private readonly List<string> _demoteScratch = new();
    private readonly HashSet<string> _demote = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _rebuild = new(System.StringComparer.Ordinal);
    private readonly List<CardClusterItem> _currentClusters = new();

    // Churn debounce bookkeeping (same shape as TextOverlay).
    private readonly HashSet<string> _churnDemote = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _pendingChurn = new(System.StringComparer.Ordinal);
    private readonly RepromoteDebounce _debounce = new(ChurnDemoteThreshold, ChurnWindowEvals, ChurnCooldownEvals);

    public long ChurnSuppressed { get; private set; }

    private bool _active;
    private bool _indexDirty = true;
    private int _framesSinceEval;
    private bool _replanNextFrame;    // a keyframe requested a fresh plan next frame
    private bool _evaluatedThisScene; // an eval ran with assets idle (the shot-settle terminal)

    // Telemetry (instance-scoped — dies with the stage on Back-to-menu; AppShell surfaces it).
    public long BuildTotal { get; private set; }         // clusters promoted
    public long DemoteTotal { get; private set; }        // clusters torn down
    public long MemberReapplyTotal { get; private set; } // in-place member clone re-Applies (CollectDemotions rebuild)
    public long ClusterRebuildTotal { get; private set; } // torn-down-then-rebuilt on a structural member-set change

    public int PromotedCount => _clusters.Count;
    public bool Active => _active;

    // Track-ST headline metric: total card-cluster crisp↔mushy TRANSITIONS this session (fresh build + revive = crisp
    // appears; demote = crisp disappears). AppShell divides by elapsed for transitionsPerMin.
    public long TransitionsTotal => BuildTotal + ReviveTotal + DemoteTotal;

    // Track-Z telemetry fix (mirrors TextOverlay): demotes of a cluster whose root still renders visible on screen at
    // demote time — a demote of a card that just left the scene / hid is not a perceptible flip.
    public long VisibleDemoteTotal { get; private set; }

    // The USER-FACING flicker metric: builds + screen-visible demotes; revives excluded (a park+revive pair is at most
    // one visible flip, counted on the park side). Raw TransitionsTotal kept for soak comparability.
    public long VisibleTransitionsTotal => BuildTotal + VisibleDemoteTotal;

    // Wire the controller (AppShell.MountRenderStage AFTER the reconciler is bound). Parks inert until the first eval.
    public void Bind(SceneReconciler reconciler, MirrorStore store)
    {
        Layer = CardLayerLevel;
        ProcessPriority = 100; // run the per-frame holder sync LATE (after tweens settle this frame's transforms)
        _reconciler = reconciler;
        _store = store;
        _ctx = reconciler.Context;
        _spreadDxOf = id => _store.Spread.TryGet(id, out var rec) ? rec.Dx : 0.0;
        _spreadWidthOf = id => _store.Spread.TryGet(id, out var rec) ? rec.RenderedWidth : 0.0;
        _blockerArtView = MeasureBlockerArt;
        if (DebugOcclusion)
        {
            _planner.Debug = line => GD.Print($"M3_CARDLAYER_OCC: {line}");
        }

        _active = ComputeActive();
    }

    private static bool ComputeActive() =>
        ClientSettingsStore.CrispText && ClientEffectSettings.RenderScale != RenderScale.Full;

    // Track I: run `action` over every promoted/parked/pending card CLONE view. These clone MirrorNodeViews live under
    // this CanvasLayer (NOT in the reconciler's _views), so the idle-suspend controller's ForEachLiveView sweep never
    // reached them — a card-face clone's animating shader kept a RenderActivity continuous registration and pinned the
    // stage awake at Half/Quarter (CardLayer is inactive at Full), which was the dominant on-device residual-continuous
    // gap. The controller sweeps this alongside the live views so those clones freeze (and resume) too. Parked clones
    // are hidden but still hold their shader's continuous registration, so they are included. Infrequent (idle
    // transition / wake), so the full walk is cheap.
    // Free a cluster/pending holder AND release each clone view's shader state first. A card clone is plain-Free()d
    // (NEVER ResetForPool — the clone assert), so ShaderAttachment.ResetView is otherwise never called for it: the
    // clone's per-view ShaderMaterial keeps its RenderActivity continuous registration alive FOREVER (the wrapper GCs
    // but the count was never decremented). Over a combat those leaked registrations accumulate and pin the on-demand
    // stage awake even at idle (part of the on-device residual-continuous gap). ResetView drops the continuous
    // registration and deterministically frees the private material; particle continuous self-releases via the emitter
    // child's _ExitTree when the holder is freed below.
    private static void FreeClones(Node2D holder, Dictionary<string, MirrorNodeView> clones)
    {
        foreach (var clone in clones.Values)
        {
            if (GodotObject.IsInstanceValid(clone))
            {
                ShaderAttachment.ResetView(clone);
            }
        }

        holder.Free();
    }

    public void ForEachCloneView(System.Action<MirrorNodeView> action)
    {
        foreach (var cluster in _clusters.Values)
        {
            foreach (var clone in cluster.Clones.Values)
            {
                if (GodotObject.IsInstanceValid(clone))
                {
                    action(clone);
                }
            }
        }

        foreach (var cluster in _parked.Values)
        {
            foreach (var clone in cluster.Clones.Values)
            {
                if (GodotObject.IsInstanceValid(clone))
                {
                    action(clone);
                }
            }
        }

        foreach (var pending in _pending)
        {
            foreach (var clone in pending.Clones.Values)
            {
                if (GodotObject.IsInstanceValid(clone))
                {
                    action(clone);
                }
            }
        }
    }

    public override void _Process(double delta)
    {
        bool want = ComputeActive();
        if (want != _active)
        {
            _active = want;
            if (!_active)
            {
                TeardownAll();
            }
            else
            {
                _framesSinceEval = 0; // re-eval promptly on Active→true
            }
        }

        // Q6-B: retry any member id whose live view was transiently unresolvable at demote time — independent of
        // _active so a still-pending id resolves (and its card stops being permanently invisible) even after
        // CardLayer itself goes inactive. Cheap no-op the overwhelming majority of frames (empty set).
        FlushPendingUnhoist();

        if (!_active)
        {
            return;
        }

        // A keyframe deferred its replan to the next frame (the tree is fully rebuilt by then). Track-ST: text/card
        // promotion no longer waits on the global AllIdle gate — the per-member MemberDynamic-unsettled reject already
        // withholds a card whose OWN art has not decoded, and the --shot capture ANDs in AllIdle separately.
        if (_replanNextFrame)
        {
            _replanNextFrame = false;
            _framesSinceEval = 0;
            RunPlan();
        }

        // Per-frame: holder transform + visibility + (Track-ST) member-clone sync (the crux — a moving card / member is
        // tracked, never re-cloned).
        RefreshHolders();

        // Advance the amortized fresh-build queue (≤ BuildMembersPerFrame member clones per frame; no-op when empty).
        AdvancePendingBuilds();

        _framesSinceEval++;
        if (_framesSinceEval >= EvalCadenceFrames)
        {
            _framesSinceEval = 0;
            RunPlan();
        }
    }

    // ---- plan + reconcile (eval cadence + OrderChanged) --------------------------------------------------------

    // Full Plan → diff against the live clusters: keep+update same-member clusters (0 rebuilds — a pure hover reorder),
    // teardown+rebuild a member-set change, build fresh promotions (asset-idle gated), demote gone ones, reorder by
    // paint key. Folds the churn debounce. Times the whole attempt on the CardLayer walk bucket.
    private void RunPlan()
    {
        long start = WalkProfiler.Start();

        _debounce.BeginEval(_pendingChurn);
        _pendingChurn.Clear();

        if (_indexDirty)
        {
            _planner.RebuildIndex(_store.State);
            _indexDirty = false;
        }

        PruneParked(); // eval-cadence hygiene: drop parked clone trees whose card left the scene

        var plan = ComputePlan();
        _evaluatedThisScene = true;
        Reconcile(plan, allowBuild: true);

        WalkProfiler.Stop(WalkProfiler.Metric.CardLayer, start);
        LogOutcome(plan);
        if (DumpRects)
        {
            DumpRectLines(plan);
        }
    }

    private CardLayerPlan ComputePlan()
    {
        _excluded.Clear();
        _boundedCosmetic.Clear();
        _reconciler.CollectBakeExcluded(_excluded, _boundedCosmetic);
        _transformOwned.Clear();
        TweenReplayer.CollectTransformOwned(_transformOwned);

        // Per-frame member sync tracks tween/animation/lift motion; unsettled textures still reject a clone.
        _unsettled.Clear();
        _reconciler.CollectUnsettledTextures(_unsettled);

        RefreshBlockerArt();

        return _planner.Plan(
            _store.State, _store.Transforms, _store.SpreadFactor, _spreadDxOf,
            _excluded, _transformOwned, _boundedCosmetic, _unsettled, _spreadWidthOf,
            _blockerArt, _blockerArtHoles);
    }

    // WS-crisp2: rebuild the per-id tightened drawn-art boxes + transparent HOLES for textured occluders from every
    // live view (the same sweep + geometry TextOverlay.RefreshMeasurements runs). Cleared first so a view that lost its
    // texture / whose art no longer decodes drops out. A view whose texture has not decoded yields no entry, so the
    // planner keeps that occluder's full layout-rect box (fail-closed — never a wrong promotion).
    private void RefreshBlockerArt()
    {
        _blockerArt.Clear();
        _blockerArtHoles.Clear();
        _reconciler.ForEachLiveView(_blockerArtView);
    }

    // Record one live view's tightened drawn-art box (+ transparent hole) in DESIGN space (its real global transform,
    // which already folds the wide-screen spread offset, applied to the view-local art rect). Mirrors
    // TextOverlay.MeasureViewInto's blocker-art collection exactly.
    private void MeasureBlockerArt(MirrorNodeView view)
    {
        if (!view.TryGetBlockerArtRect(_ctx.Textures, out var art, out var hole))
        {
            return;
        }

        var gt = view.GetGlobalTransform();
        _blockerArt[view.NodeId] = DesignAabbOf(gt, art);
        if (hole is { } hp && Mathf.IsZeroApprox(gt.X.Y) && Mathf.IsZeroApprox(gt.Y.X))
        {
            // Only record the hole under an AXIS-ALIGNED global: an axis-aligned design box of a ROTATED hole rect
            // could claim painted pixels (the UI-chrome cases the hole exists for are never rotated). Mirrors TextOverlay.
            _blockerArtHoles[view.NodeId] = DesignAabbOf(gt, hp);
        }
    }

    // The design-space AABB of a view-local Rect2 under a global affine — the four transformed corners' min/max (so a
    // scaled/rotated rect is bounded exactly). Mirrors TextOverlay.DesignAabbOf / CullBounds.OfRect.
    private static DesignAabb DesignAabbOf(Transform2D gt, Rect2 local)
    {
        Vector2 p = local.Position;
        Vector2 s = local.Size;
        Vector2 c0 = gt * p;
        Vector2 c1 = gt * (p + new Vector2(s.X, 0));
        Vector2 c2 = gt * (p + new Vector2(0, s.Y));
        Vector2 c3 = gt * (p + s);
        float minX = Mathf.Min(Mathf.Min(c0.X, c1.X), Mathf.Min(c2.X, c3.X));
        float minY = Mathf.Min(Mathf.Min(c0.Y, c1.Y), Mathf.Min(c2.Y, c3.Y));
        float maxX = Mathf.Max(Mathf.Max(c0.X, c1.X), Mathf.Max(c2.X, c3.X));
        float maxY = Mathf.Max(Mathf.Max(c0.Y, c1.Y), Mathf.Max(c2.Y, c3.Y));
        return new DesignAabb(minX, minY, maxX, maxY);
    }

    // Diff `plan` against the live clusters. `allowBuild` gates fresh promotions on asset-idle.
    private void Reconcile(CardLayerPlan plan, bool allowBuild)
    {
        _planRoots.Clear();
        foreach (var c in plan.Clusters)
        {
            _planRoots.Add(c.RootId);
        }

        // Demote live clusters no longer in the plan.
        _removeScratch.Clear();
        foreach (var (root, _) in _clusters)
        {
            if (!_planRoots.Contains(root))
            {
                _removeScratch.Add(root);
            }
        }

        foreach (var root in _removeScratch)
        {
            Demote(root);
        }

        // Build / update in plan order.
        foreach (var item in plan.Clusters)
        {
            if (_clusters.TryGetValue(item.RootId, out var live))
            {
                if (SameMembers(live.MemberIds, item.MemberIds))
                {
                    // Pure reorder / geometry refresh — keep the clones, update the paint key + AABB (0 rebuilds).
                    //
                    // #15 (Blessing of the Forge): the potion upgrades EVERY hand card AND re-fans the hand in the
                    // SAME drain, so the drain carries BOTH an OrderChanged and per-card Text changes. OnDrained's
                    // OrderChanged branch reconciles here (not through the per-drain CollectDemotions rule-1 →
                    // ReapplyMember path), so a surviving cluster's drifted TEXT member clone was never re-Applied and
                    // the crisp layer kept the stale (un-upgraded) title/description raster permanently (ChangedIds is
                    // cleared per drain). SyncClusterMembers re-Applies ONLY the members whose retained node OBJECT
                    // changed (reference compare — the applier replaces the object on every upsert; near-free, the same
                    // pass a revive uses), so the upgraded text refreshes with no rebuild. On a vanished member it
                    // returns false → fall through to a demote + optional re-promote (the clone tree is stale anyway).
                    if (SyncClusterMembers(item.RootId, item.MemberIds, live.Clones))
                    {
                        live.PaintKey = item.PaintKey;
                        live.Aabb = item.Aabb;
                    }
                    else
                    {
                        Demote(item.RootId);
                        ClusterRebuildTotal++;
                        if (allowBuild && !RepromoteSuppressed(item.RootId))
                        {
                            Promote(item);
                        }
                    }
                }
                else
                {
                    // The card's cloneable member set changed structurally → rebuild it.
                    Demote(item.RootId);
                    ClusterRebuildTotal++;
                    if (allowBuild && !RepromoteSuppressed(item.RootId))
                    {
                        Promote(item);
                    }
                }
            }
            else if (FindPending(item.RootId) is var pi && pi >= 0)
            {
                var pb = _pending[pi];
                if (SameMembers(pb.Item.MemberIds, item.MemberIds))
                {
                    pb.Item = item; // build continues; completion uses the refreshed paint key + AABB
                }
                else
                {
                    AbandonPending(pi); // member set changed mid-build → restart from scratch
                    if (allowBuild && !RepromoteSuppressed(item.RootId))
                    {
                        Promote(item);
                    }
                }
            }
            else if (!allowBuild)
            {
                // deferred: a fresh promotion during a not-yet-idle structural replan waits for the asset-idle eval.
            }
            else if (RepromoteSuppressed(item.RootId))
            {
                ChurnSuppressed++;
            }
            else
            {
                Promote(item);
            }
        }

        // Abandon pending builds whose card is no longer in the plan (it became ineligible / occluded mid-build).
        for (int i = _pending.Count - 1; i >= 0; i--)
        {
            if (!_planRoots.Contains(_pending[i].Item.RootId))
            {
                AbandonPending(i);
            }
        }

        ReorderHolders(plan);
    }

    // Order holders by paint key ascending (later card = drawn on top), so overlapping promoted cards compose exactly
    // as the in-stage paint order would.
    private void ReorderHolders(CardLayerPlan plan)
    {
        for (int i = 0; i < plan.Clusters.Count; i++)
        {
            if (_clusters.TryGetValue(plan.Clusters[i].RootId, out var cl) && GodotObject.IsInstanceValid(cl.Holder))
            {
                MoveChild(cl.Holder, i);
            }
        }
    }

    // ---- promote / demote --------------------------------------------------------------------------------------

    // Promote `item`: try a parked-cluster REVIVE first (the cheap churny-combat path); else ENQUEUE an amortized
    // fresh build (a few frames of in-stage mushy on a genuinely new card — never a half-built visible state).
    private void Promote(CardClusterItem item)
    {
        if (TryRevive(item))
        {
            return;
        }

        var holder = new Node2D { Name = $"card_{Sanitize(item.RootId)}", Visible = false };
        AddChild(holder);
        _pending.Add(new PendingBuild
        {
            Item = item,
            Holder = holder,
            Clones = new Dictionary<string, MirrorNodeView>(System.StringComparer.Ordinal),
        });
    }

    // Advance the front pending build by up to BuildMembersPerFrame member clones (across clusters if the front one
    // completes with budget to spare). Called once per frame from _Process; times itself on the CardLayer bucket so
    // the amortized slices are visible in the walk percentiles.
    private void AdvancePendingBuilds()
    {
        if (_pending.Count == 0)
        {
            return;
        }

        long start = WalkProfiler.Start();
        int budget = BuildMembersPerFrame;
        while (budget > 0 && _pending.Count > 0)
        {
            var pb = _pending[0];
            if (!GodotObject.IsInstanceValid(pb.Holder))
            {
                _pending.RemoveAt(0);
                continue;
            }

            if (!BuildSlice(pb, ref budget))
            {
                AbandonPending(0); // a member vanished mid-build — the next eval re-plans
                continue;
            }

            if (pb.NextMember >= pb.Item.MemberIds.Count)
            {
                _pending.RemoveAt(0);
                CompletePendingBuild(pb);
            }
        }

        WalkProfiler.Stop(WalkProfiler.Metric.CardLayer, start);
    }

    // Build up to `budget` member clones for `pb` (pre-order — a member's parent clone always exists before it).
    // False when a member's node/view vanished (the caller abandons the build).
    private bool BuildSlice(PendingBuild pb, ref int budget)
    {
        var item = pb.Item;
        while (budget > 0 && pb.NextMember < item.MemberIds.Count)
        {
            var mid = item.MemberIds[pb.NextMember];
            if (!_store.State.Nodes.TryGetValue(mid, out var node)
                || !_reconciler.TryGetView(mid, out var liveView)
                || !GodotObject.IsInstanceValid(liveView))
            {
                return false;
            }

            bool isRoot = mid == item.RootId;
            Node parent = isRoot
                ? pb.Holder
                : (node.ParentId is { } pid && pb.Clones.TryGetValue(pid, out var pc) ? pc : pb.Holder);

            var clone = new MirrorNodeView(mid) { IsBakeClone = true };
            parent.AddChild(clone);

            if (isRoot)
            {
                // The holder carries the folded GLOBAL (view.GetGlobalTransform, incl. this root's FoldCosmetic +
                // ancestor motion), so the root clone must sit at IDENTITY with ZERO spread (copying the root's own
                // spread would double-shift it). SpreadWidth IS copied (an anchor-widened root box).
                clone.SpreadOffset = Vector2.Zero;
                clone.SpreadWidth = liveView.SpreadWidth;
                clone.Apply(node, Transform2D.Identity, _ctx);
                pb.RootClone = clone;
            }
            else
            {
                // A non-root member: its raw StreamedLocal + a spread copy (its FoldCosmetic reproduces the shift).
                clone.SpreadOffset = liveView.SpreadOffset;
                clone.SpreadWidth = liveView.SpreadWidth;
                clone.Apply(node, liveView.StreamedLocal, _ctx);
            }

            pb.Clones[mid] = clone;
            pb.NextMember++;
            budget--;
        }

        return true;
    }

    // The build finished: re-sync any members that drifted while the build was in flight (same reference-compare pass
    // a revive uses), THEN hoist the live members + show the holder — atomic, no half-built visible frame.
    private void CompletePendingBuild(PendingBuild pb)
    {
        if (pb.RootClone is null || !GodotObject.IsInstanceValid(pb.Holder))
        {
            if (GodotObject.IsInstanceValid(pb.Holder))
            {
                FreeClones(pb.Holder, pb.Clones);
            }

            return;
        }

        var item = pb.Item;
        if (!SyncClusterMembers(item.RootId, item.MemberIds, pb.Clones))
        {
            FreeClones(pb.Holder, pb.Clones); // a member vanished between the last slice and completion
            return;
        }

        var cluster = new Cluster
        {
            Holder = pb.Holder,
            RootId = item.RootId,
            RootClone = pb.RootClone,
            Clones = pb.Clones,
            MemberIds = new List<string>(item.MemberIds),
            ClipAncestorIds = item.ClipAncestorIds,
            PaintKey = item.PaintKey,
            Aabb = item.Aabb,
        };
        _clusters[item.RootId] = cluster;

        // Hoist-suppress the live members THIS frame (their in-stage self-paint + "__text" hide → no double draw).
        foreach (var mid in item.MemberIds)
        {
            if (_reconciler.TryGetView(mid, out var v) && GodotObject.IsInstanceValid(v))
            {
                v.SetSelfPaintHoisted(true);
                _pendingUnhoist.Remove(mid); // Q6-B: a fresh hoist supersedes any stale pending un-hoist for this id
            }
        }

        cluster.Holder.Visible = true;
        cluster.LastVisible = true;
        RefreshHolder(cluster);              // initial holder transform + visibility
        RefreshHolderModulate(cluster);      // initial ancestor modulate
        ReorderHoldersByKey();               // slot the new holder into the paint-key order among the live ones
        RenderActivity.Mark();
        BuildTotal++;
        Trace("promote", item.RootId);
    }

    private void AbandonPending(int index)
    {
        var pb = _pending[index];
        _pending.RemoveAt(index);
        if (GodotObject.IsInstanceValid(pb.Holder))
        {
            FreeClones(pb.Holder, pb.Clones);
        }
    }

    private int FindPending(string rootId)
    {
        for (int i = 0; i < _pending.Count; i++)
        {
            if (string.Equals(_pending[i].Item.RootId, rootId, System.StringComparison.Ordinal))
            {
                return i;
            }
        }

        return -1;
    }

    // Order ALL live holders by paint key ascending (used on a pending-build completion, where no fresh plan list is
    // in hand). Small n; the plan-driven ReorderHolders covers the eval path.
    private readonly List<Cluster> _orderScratch = new();

    private void ReorderHoldersByKey()
    {
        _orderScratch.Clear();
        foreach (var (_, c) in _clusters)
        {
            if (GodotObject.IsInstanceValid(c.Holder))
            {
                _orderScratch.Add(c);
            }
        }

        _orderScratch.Sort(static (a, b) => a.PaintKey.CompareTo(b.PaintKey));
        for (int i = 0; i < _orderScratch.Count; i++)
        {
            MoveChild(_orderScratch[i].Holder, i);
        }
    }

    // Re-sync every member clone of a cluster against the CURRENT retained state: re-stamp the spread channels
    // (guarded setters) and re-Apply ONLY drifted members (node-object reference compare). Shared by the revive path
    // and pending-build completion. False when a member / its live view /
    // its clone is gone.
    private bool SyncClusterMembers(string rootId, IReadOnlyList<string> memberIds, Dictionary<string, MirrorNodeView> clones)
    {
        foreach (var mid in memberIds)
        {
            if (!_store.State.Nodes.TryGetValue(mid, out var node)
                || !_reconciler.TryGetView(mid, out var liveView)
                || !GodotObject.IsInstanceValid(liveView)
                || !clones.TryGetValue(mid, out var clone)
                || !GodotObject.IsInstanceValid(clone))
            {
                return false;
            }

            bool isRoot = mid == rootId;
            clone.SpreadOffset = isRoot ? Vector2.Zero : liveView.SpreadOffset; // guarded setters (no-op when unchanged)
            clone.SpreadWidth = liveView.SpreadWidth;

            bool changed = !ReferenceEquals(clone.NodeData, node);
            if (changed)
            {
                clone.Apply(node, isRoot ? Transform2D.Identity : liveView.StreamedLocal, _ctx);
                ReviveMembersReapplied++;
            }
        }

        return true;
    }

    // Revive a PARKED cluster for `item`: same root, same member set, every member's live view still present. Re-stamp
    // the spread channels (guarded setters — near-free when unchanged) and re-Apply ONLY members whose retained node
    // OBJECT changed since park (reference compare; the applier replaces the object on every upsert). Reuses the
    // clone's Godot nodes / cached ShaderMaterial / "__text" label — the
    // measured ~3ms fresh build becomes ~0.1–0.5ms. False on any mismatch (caller falls through to the fresh build).
    private bool TryRevive(CardClusterItem item)
    {
        if (!_parked.Remove(item.RootId, out var parked))
        {
            return false;
        }

        if (!GodotObject.IsInstanceValid(parked.Holder)
            || !SameMembers(parked.MemberIds, item.MemberIds)
            || !SyncClusterMembers(item.RootId, item.MemberIds, parked.Clones))
        {
            if (GodotObject.IsInstanceValid(parked.Holder))
            {
                FreeClones(parked.Holder, parked.Clones); // member set changed / a member vanished → the clone tree is stale
            }

            return false;
        }

        parked.PaintKey = item.PaintKey;
        parked.Aabb = item.Aabb;
        parked.ClipAncestorIds = item.ClipAncestorIds; // #14 Leg A: refresh proven clip ancestors (a re-plan may re-prove)
        _clusters[item.RootId] = parked;

        foreach (var mid in item.MemberIds)
        {
            if (_reconciler.TryGetView(mid, out var v) && GodotObject.IsInstanceValid(v))
            {
                v.SetSelfPaintHoisted(true); // re-hoist THIS frame (the un-parked clone shows the same frame)
                _pendingUnhoist.Remove(mid); // Q6-B: a fresh hoist supersedes any stale pending un-hoist for this id
            }
        }

        parked.Holder.Visible = true;
        parked.LastVisible = true;
        RefreshHolder(parked);
        RefreshHolderModulate(parked);
        RenderActivity.Mark();
        ReviveTotal++;
        Trace("revive", item.RootId);
        return true;
    }

    // Tear one cluster down THIS frame: un-hoist the live members (their in-stage paint returns) THEN park the hidden
    // clone tree for a cheap revive (`park` true — the default churny path) or Free it (`park` false — teardown /
    // eviction). Same atomic order as before so there is no ghost / double frame.
    private void Demote(string root, bool park = true)
    {
        if (!_clusters.Remove(root, out var cluster))
        {
            return;
        }

        // Track-Z telemetry fix: sample screen-visibility BEFORE the teardown (the counter increment sites below both
        // follow the un-hoist, but the retained state is unchanged by it).
        bool visibleDemote = IsScreenVisibleCard(root);
        if (visibleDemote)
        {
            VisibleDemoteTotal++;
        }

        Trace("demote", root);

        foreach (var mid in cluster.MemberIds)
        {
            // Q6-B: the live view can be TRANSIENTLY unresolvable here (a same-drain reparent, e.g. the discard
            // dialog select/return flow) — the old code silently skipped the un-hoist in that case and never
            // retried, so the member's SelfPaintSuppress.Hoisted bit stuck forever (permanently invisible card).
            // Defer to _pendingUnhoist so FlushPendingUnhoist retries once the view resolves.
            if (_reconciler.TryGetView(mid, out var v) && GodotObject.IsInstanceValid(v))
            {
                v.SetSelfPaintHoisted(false); // un-hoist FIRST → the live member paints again this same frame
                _pendingUnhoist.Remove(mid);
            }
            else
            {
                _pendingUnhoist.Add(mid);
            }
        }

        if (!GodotObject.IsInstanceValid(cluster.Holder))
        {
            RenderActivity.Mark();
            DemoteTotal++;
            return;
        }

        if (park)
        {
            cluster.Holder.Visible = false; // hidden in-tree — zero draw cost, ready for revive
            cluster.LastVisible = false;
            if (_parked.Count >= ParkedCap)
            {
                EvictOneParked();
            }

            // A re-park of a root that somehow already has a parked twin (shouldn't happen — Promote consumes the
            // parked entry first) frees the stale one.
            if (_parked.Remove(root, out var stale) && GodotObject.IsInstanceValid(stale.Holder))
            {
                FreeClones(stale.Holder, stale.Clones);
            }

            _parked[root] = cluster;
        }
        else
        {
            FreeClones(cluster.Holder, cluster.Clones);
        }

        RenderActivity.Mark();
        DemoteTotal++;
    }

    // Q6-B: retry every id Demote deferred because its live view was transiently unresolvable at demote time. Called
    // every frame from _Process (independent of _active) plus once more from TeardownAll (the cluster-teardown
    // checkpoint) so a pending id gets an extra resolution attempt right when the whole layer tears down, not only on
    // the next frame. Uses a resolved-scratch list because a HashSet cannot be mutated while being enumerated.
    private void FlushPendingUnhoist()
    {
        if (_pendingUnhoist.Count == 0)
        {
            return;
        }

        _unhoistResolvedScratch.Clear();
        foreach (var mid in _pendingUnhoist)
        {
            if (_reconciler.TryGetView(mid, out var v) && GodotObject.IsInstanceValid(v))
            {
                v.SetSelfPaintHoisted(false);
                _unhoistResolvedScratch.Add(mid);
            }
        }

        foreach (var mid in _unhoistResolvedScratch)
        {
            _pendingUnhoist.Remove(mid);
        }
    }

    // Does the cluster root still render visible on screen RIGHT NOW (node present, every ancestor Visible, ancestor-
    // composed modulate alpha above the paint threshold)? The visible-transition discriminator (see VisibleDemoteTotal).
    private bool IsScreenVisibleCard(string root)
    {
        if (!_store.State.Nodes.ContainsKey(root))
        {
            return false;
        }

        string? cur = root;
        int guard = 0;
        while (cur is not null && _store.State.Nodes.TryGetValue(cur, out var n) && guard++ < 4096)
        {
            if (!n.Visible)
            {
                return false;
            }

            cur = n.ParentId;
        }

        return PaintOrderTables.EffectiveModulate(_store.State, root).A > 0.02;
    }

    private void EvictOneParked()
    {
        foreach (var (root, cluster) in _parked)
        {
            _parked.Remove(root);
            if (GodotObject.IsInstanceValid(cluster.Holder))
            {
                FreeClones(cluster.Holder, cluster.Clones);
            }

            return;
        }
    }

    // Free parked clusters whose root no longer exists in the retained state (the card left the scene — a revive can
    // never match). Called from RunPlan (eval cadence) so stale parks don't sit until eviction.
    private void PruneParked()
    {
        List<string>? dead = null;
        foreach (var (root, _) in _parked)
        {
            if (!_store.State.Nodes.ContainsKey(root))
            {
                (dead ??= new List<string>()).Add(root);
            }
        }

        if (dead is not null)
        {
            foreach (var root in dead)
            {
                if (_parked.Remove(root, out var cluster) && GodotObject.IsInstanceValid(cluster.Holder))
                {
                    FreeClones(cluster.Holder, cluster.Clones);
                }
            }
        }
    }

    private void TeardownAll()
    {
        _pendingChurn.Clear();
        _debounce.Reset();

        // Abandon every in-flight amortized build (its content is stale relative to the teardown event).
        for (int i = _pending.Count - 1; i >= 0; i--)
        {
            AbandonPending(i);
        }

        // Free every parked clone tree too — a teardown event (keyframe / spread / effect flip / Active-off) makes
        // their content stale, and a revive across it would resurrect wrong pixels.
        foreach (var (_, cluster) in _parked)
        {
            if (GodotObject.IsInstanceValid(cluster.Holder))
            {
                FreeClones(cluster.Holder, cluster.Clones);
            }
        }

        _parked.Clear();

        if (_clusters.Count == 0)
        {
            FlushPendingUnhoist(); // Q6-B: cluster-teardown checkpoint — catch any pre-existing pending id even with no live clusters
            return;
        }

        _removeScratch.Clear();
        foreach (var (root, _) in _clusters)
        {
            _removeScratch.Add(root);
        }

        foreach (var root in _removeScratch)
        {
            Demote(root, park: false);
        }

        FlushPendingUnhoist(); // Q6-B: cluster-teardown checkpoint — give the ids the loop above just deferred one immediate retry
    }

    private bool RepromoteSuppressed(string root) => _debounce.Suppressed(root);

    // ---- per-frame / per-drain holder maintenance --------------------------------------------------------------

    // Per-frame: re-sample each promoted card's ROOT global onto its holder (tracks hover-lift / drag / spread /
    // ancestor motion) + its animated modulate onto the root clone + its tree-visibility. Missing view ⇒ demote.
    private void RefreshHolders()
    {
        _demoteScratch.Clear();
        foreach (var (root, cluster) in _clusters)
        {
            if (!_reconciler.TryGetView(root, out var view) || !GodotObject.IsInstanceValid(view)
                || !GodotObject.IsInstanceValid(cluster.Holder))
            {
                _demoteScratch.Add(root);
                continue;
            }

            RefreshHolder(cluster);

            // The root clone carries the root's OWN (possibly tween-animated) modulate; the holder carries the ancestor
            // product (refreshed per-drain). Guarded writes.
            if (GodotObject.IsInstanceValid(cluster.RootClone))
            {
                if (cluster.RootClone.Modulate != view.Modulate || cluster.LastRootMod != view.Modulate)
                {
                    cluster.RootClone.Modulate = view.Modulate;
                    cluster.LastRootMod = view.Modulate;
                }

                if (cluster.RootClone.SelfModulate != view.SelfModulate || cluster.LastRootSelfMod != view.SelfModulate)
                {
                    cluster.RootClone.SelfModulate = view.SelfModulate;
                    cluster.LastRootSelfMod = view.SelfModulate;
                }
            }

            // Sync every non-root member clone's local transform and modulate from its live member each frame.
            SyncMemberClonesLive(cluster);
        }

        foreach (var root in _demoteScratch)
        {
            Demote(root);
        }
    }

    // Track-ST per-frame member-clone sync: copy each non-root member clone's LIVE local transform + modulate +
    // self-modulate from its live view (the clone tree mirrors the live structure, so copying each member's local
    // reproduces its live global under the holder). The ROOT clone stays at identity — its modulate is synced in
    // RefreshHolders and the holder carries its global. Guarded writes; ~80 clones total → sub-0.5ms.
    private void SyncMemberClonesLive(Cluster cluster)
    {
        foreach (var mid in cluster.MemberIds)
        {
            if (string.Equals(mid, cluster.RootId, System.StringComparison.Ordinal)
                || !cluster.Clones.TryGetValue(mid, out var clone) || !GodotObject.IsInstanceValid(clone)
                || !_reconciler.TryGetView(mid, out var member) || !GodotObject.IsInstanceValid(member))
            {
                continue;
            }

            var mt = member.Transform;
            if (clone.Transform != mt)
            {
                clone.Transform = mt;
            }

            if (clone.Modulate != member.Modulate)
            {
                clone.Modulate = member.Modulate;
            }

            if (clone.SelfModulate != member.SelfModulate)
            {
                clone.SelfModulate = member.SelfModulate;
            }
        }
    }

    // Sample the root view's EXACT global transform onto the holder + compose visibility (culled/baked owner ⇒ hidden;
    // the Hoisted bit is deliberately IGNORED via SelfPaintCulledOrBaked so the clone shows). Guarded writes.
    private void RefreshHolder(Cluster cluster)
    {
        if (!_reconciler.TryGetView(cluster.RootId, out var view) || !GodotObject.IsInstanceValid(view)
            || !GodotObject.IsInstanceValid(cluster.Holder))
        {
            return;
        }

        var gt = view.GetGlobalTransform();
        if (cluster.LastHolder != gt || cluster.Holder.Transform != gt)
        {
            cluster.Holder.Transform = gt;
            cluster.LastHolder = gt;
        }

        bool visible = view.IsVisibleInTree() && !view.SelfPaintCulledOrBaked;
        if (cluster.LastVisible != visible || cluster.Holder.Visible != visible)
        {
            cluster.Holder.Visible = visible;
            cluster.LastVisible = visible;
        }
    }

    // Per-drain: the holder's modulate is the EXCLUSIVE ancestor product — EffectiveModulate of the PARENT of the root
    // (the root clone carries its OWN modulate). Godot cascades the holder modulate down to the clone → the composite
    // matches the live card's full effective modulate.
    private void RefreshHolderModulate(Cluster cluster)
    {
        if (!GodotObject.IsInstanceValid(cluster.Holder))
        {
            return;
        }

        string? parentId = _store.State.Nodes.TryGetValue(cluster.RootId, out var rn) ? rn.ParentId : null;
        var mod = parentId is null
            ? new Rgba(1, 1, 1, 1)
            : PaintOrderTables.EffectiveModulate(_store.State, parentId);
        cluster.Holder.Modulate = new Color((float)mod.R, (float)mod.G, (float)mod.B, (float)mod.A);
    }

    // ---- reconciler hooks ---------------------------------------------------------------------------------------

    // Tail-called from SceneReconciler.OnDrained AFTER the TextOverlay hook. Keyframe ⇒ TeardownAll + replan next
    // frame; OrderChanged ⇒ immediate re-plan + diff (a hand re-fan; 0 rebuilds on a pure reorder); else the cheap
    // per-drain guard + per-drain holder-modulate refresh.
    public void OnDrained(MirrorStore.DrainInfo info)
    {
        if (info.Keyframe)
        {
            _indexDirty = true;
            TeardownAll();
            _evaluatedThisScene = false;
            _replanNextFrame = true; // the tree is rebuilt by next frame — replan then
            return;
        }

        if (!_active)
        {
            return;
        }

        if (info.OrderChanged)
        {
            _indexDirty = true;
            long s = WalkProfiler.Start();
            _planner.RebuildIndex(_store.State);
            _indexDirty = false;
            var plan = ComputePlan();
            _evaluatedThisScene = true;
            Reconcile(plan, allowBuild: true);
            foreach (var (_, cluster) in _clusters)
            {
                RefreshHolderModulate(cluster);
            }

            WalkProfiler.Stop(WalkProfiler.Metric.CardLayer, s);

            return;
        }

        // Track-ST event-driven promotion: a non-structural drain that introduced a new eligible NCard (no order change —
        // e.g. an occluder cleared, or a card the last replan rejected for unsettled art now touched) starts its build
        // THIS drain instead of waiting for the ~30-frame cadence. RunPlan is self-timed; it also covers the survivors.
        if (HasUnpromotedCard(info.ChangedIds))
        {
            RunPlan();
            return;
        }

        if (_clusters.Count == 0)
        {
            return;
        }

        long start = WalkProfiler.Start();

        BuildCurrentClusters();

        _excluded.Clear();
        _transformOwned.Clear();
        _reconciler.CollectBakeExcluded(_excluded);
        TweenReplayer.CollectTransformOwned(_transformOwned);

        _unsettled.Clear();
        _reconciler.CollectUnsettledTextures(_unsettled);

        _planner.CollectDemotions(
            _store.State, _store.Transforms, _store.SpreadFactor, _spreadDxOf,
            _currentClusters, info.ChangedIds, info.Hints, _excluded, _transformOwned,
            _demote, _rebuild, _churnDemote, _unsettled);

        foreach (var id in _churnDemote)
        {
            _pendingChurn.Add(id);
        }

        foreach (var root in _demote)
        {
            Demote(root);
        }

        foreach (var memberId in _rebuild)
        {
            ReapplyMember(memberId);
        }

        // Per-drain ancestor-modulate refresh (a moved/faded ancestor shifts the cascade).
        foreach (var (_, cluster) in _clusters)
        {
            RefreshHolderModulate(cluster);
        }

        WalkProfiler.Stop(WalkProfiler.Metric.CardLayer, start);
    }

    // A bare spread-factor relayout shifts every holder + re-widens boxes → drop all clusters, re-plan next eval.
    public void OnSpreadChanged()
    {
        TeardownAll();
        _indexDirty = true;
    }

    // An effect-mode flip re-Applied every view (re-showing hoisted members) and may have toggled effect-bearing nodes
    // → drop all clusters and re-plan next eval.
    public void OnRefreshEffects()
    {
        TeardownAll();
        _indexDirty = true;
    }

    // Re-Apply ONE changed member's clone in place (a changed-but-eligible member — e.g. a ticking cost/desc), with the
    // spread channels re-copied. Crisp, no teardown.
    private void ReapplyMember(string memberId)
    {
        // Find the owning cluster.
        foreach (var (root, cluster) in _clusters)
        {
            if (!cluster.Clones.TryGetValue(memberId, out var clone) || !GodotObject.IsInstanceValid(clone))
            {
                continue;
            }

            if (!_store.State.Nodes.TryGetValue(memberId, out var node)
                || !_reconciler.TryGetView(memberId, out var liveView) || !GodotObject.IsInstanceValid(liveView))
            {
                return;
            }

            bool isRoot = memberId == root;
            clone.SpreadOffset = isRoot ? Vector2.Zero : liveView.SpreadOffset;
            clone.SpreadWidth = liveView.SpreadWidth;
            clone.Apply(node, isRoot ? Transform2D.Identity : liveView.StreamedLocal, _ctx);
            MemberReapplyTotal++;
            return;
        }
    }

    // Track-ST: does this drain's changed set carry an NCard root that is NOT currently promoted, NOT mid-build, and
    // NOT churn-suppressed? A cheap pre-filter for the event-driven RunPlan (the plan does the full eligibility work).
    private bool HasUnpromotedCard(IReadOnlySet<string> changedIds)
    {
        foreach (var id in changedIds)
        {
            if (_clusters.ContainsKey(id) || FindPending(id) >= 0 || RepromoteSuppressed(id))
            {
                continue;
            }

            if (_store.State.Nodes.TryGetValue(id, out var node) && NodeTypeLeaf(node.NodeType) == "NCard")
            {
                return true;
            }
        }

        return false;
    }

    private static string NodeTypeLeaf(string nodeType)
    {
        int dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }

    private void BuildCurrentClusters()
    {
        _currentClusters.Clear();
        foreach (var (_, cluster) in _clusters)
        {
            _currentClusters.Add(new CardClusterItem(
                cluster.RootId, cluster.PaintKey, cluster.Aabb, cluster.MemberIds, System.Array.Empty<string>(),
                cluster.ClipAncestorIds));
        }
    }

    // ---- text-overlay integration ------------------------------------------------------------------------------

    // The reconciler passes this through to the TextOverlay's excluded set (via CollectCardPromoted) so a promoted
    // card's own title/type/description labels read as Dynamic and are NOT ALSO promoted by the text overlay.
    public void CollectPromotedMemberIds(ISet<string> into)
    {
        foreach (var (_, cluster) in _clusters)
        {
            foreach (var mid in cluster.MemberIds)
            {
                into.Add(mid);
            }
        }
    }

    // The NCard root sets the text planner uses to decide card ownership.
    // `promotedInto` = roots whose crisp clone is LIVE or QUEUED in the amortized build (their labels must never
    // double-promote as loose text); `knownInto` = every root the planner evaluated in its LAST plan (a known root
    // that is not promoted was DECLINED — its labels may fall through to the ordinary text-overlay rules). Both stay
    // EMPTY until the first plan of a scene (⇒ every card label reads as owned — the conservative window).
    public void CollectCardRootSets(ISet<string> promotedInto, ISet<string> knownInto)
    {
        foreach (var (root, _) in _clusters)
        {
            promotedInto.Add(root);
        }

        foreach (var pb in _pending)
        {
            promotedInto.Add(pb.Item.RootId);
        }

        foreach (var root in _planner.LastCandidateRoots)
        {
            knownInto.Add(root);
        }
    }

    // ---- shot / telemetry --------------------------------------------------------------------------------------

    // AppShell.MaybeCapture ANDs this in. Inert (not Active) → always settled. Active → wait until an idle-asset eval
    // ran this scene, so the ON card-layer shot is provably non-vacuous.
    // The amortized build queue must also be DRAINED: a --shot mid-build would capture the in-stage (mushy) card
    // non-deterministically — the settle wait keeps the acceptance shots bit-stable.
    public bool IsShotSettled => !_active || (_evaluatedThisScene && _pending.Count == 0);

    public string ShotStatus() => $"cardLayer[active={_active} promoted={_clusters.Count} evaluated={_planner.LastEvaluated}]";

    // WS-CRISP dumpcrisp: run a fresh per-root-capture Plan over the CURRENT state, then report every NCard root's
    // first-fail reject (None = promoted crisp) PLUS every card member whose texture is still pending/failed — the R18
    // "card text not crisp" black-hole surface (a permanently-failed member url holds the whole card MemberDynamic).
    // Zero cost to normal play (CaptureRejects off outside this call). Diagnostic only — mutates no cluster.
    public JsonObject DumpCrispJson()
    {
        if (!_active)
        {
            return new JsonObject { ["active"] = false, ["reason"] = "inactive" };
        }

        if (_indexDirty)
        {
            _planner.RebuildIndex(_store.State);
            _indexDirty = false;
        }

        _planner.CaptureRejects = true;
        try
        {
            ComputePlan();
        }
        finally
        {
            _planner.CaptureRejects = false;
        }

        var roots = new JsonArray();
        foreach (var (id, reject) in _planner.LastRejectByRoot)
        {
            roots.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = _store.State.Nodes.TryGetValue(id, out var n) ? n.Name : null,
                ["reject"] = reject.ToString(),
            });
        }

        // Every live member with a wanted-but-not-decoded texture: its nearest NCard root, wanted wire url, in-flight
        // fetch url, and whether that fetch has permanently FAILED (the black hole — the settled-or-failed fix clears it).
        var members = new JsonArray();
        _reconciler.ForEachLiveView(v =>
        {
            if (v.WantUrl is null || v.TextureSettled)
            {
                return; // no texture wanted, or it decoded — not a member-dynamic suspect
            }

            members.Add(new JsonObject
            {
                ["id"] = v.NodeId,
                ["root"] = NearestCardRoot(v.NodeId),
                ["wantUrl"] = v.WantUrl,
                ["fetchUrl"] = v.PendingFetchUrl,
                ["failed"] = v.TextureFailed,
                ["settledOrFailed"] = v.TextureSettledOrFailed(),
            });
        });

        return new JsonObject
        {
            ["active"] = true,
            ["evaluated"] = _planner.LastEvaluated,
            ["promoted"] = _clusters.Count,
            ["hist"] = RejectHistogram(),
            ["roots"] = roots,
            ["unsettledMembers"] = members,
        };
    }

    // The nearest NCard ancestor id of `id` (itself if it is an NCard), else null — groups an unsettled member under
    // its owning card in the dumpcrisp output.
    private string? NearestCardRoot(string id)
    {
        string? cur = id;
        int guard = 0;
        while (cur is not null && _store.State.Nodes.TryGetValue(cur, out var node) && guard++ < 4096)
        {
            int dot = node.NodeType.LastIndexOf('.');
            if ((dot >= 0 ? node.NodeType[(dot + 1)..] : node.NodeType) == "NCard")
            {
                return cur;
            }

            cur = node.ParentId;
        }

        return null;
    }

    public string TopReject()
    {
        var top = CardLayerPlanner.CardReject.None;
        int best = -1;
        foreach (var (reason, count) in _planner.LastRejectHistogram)
        {
            if (count > best)
            {
                best = count;
                top = reason;
            }
        }

        return best <= 0 ? "none" : $"{top}={best}";
    }

    public string RejectHistogram()
    {
        if (_planner.LastRejectHistogram.Count == 0)
        {
            return "none";
        }

        var parts = new List<string>();
        foreach (var (reason, count) in _planner.LastRejectHistogram)
        {
            parts.Add($"{reason}={count}");
        }

        parts.Sort(System.StringComparer.Ordinal);
        return string.Join(" ", parts);
    }

    private int _lastLoggedPromoted = -1;
    private long _lastLoggedChurnSum = -1;

    private void LogOutcome(CardLayerPlan plan)
    {
        long churnSum = BuildTotal + DemoteTotal + ClusterRebuildTotal + ReviveTotal;
        if (plan.Clusters.Count == _lastLoggedPromoted && churnSum == _lastLoggedChurnSum)
        {
            return;
        }

        _lastLoggedPromoted = plan.Clusters.Count;
        _lastLoggedChurnSum = churnSum;
        GD.Print($"M3_CARDLAYER: promoted={plan.Clusters.Count} evaluated={_planner.LastEvaluated} " +
                 $"topReject={TopReject()} hist=[{RejectHistogram()}] builds={BuildTotal} demotes={DemoteTotal} " +
                 $"revives={ReviveTotal} transitions={TransitionsTotal} visDemotes={VisibleDemoteTotal} " +
                 $"visTransitions={VisibleTransitionsTotal} reviveReapplies={ReviveMembersReapplied} parked={_parked.Count} " +
                 $"memberReapplies={MemberReapplyTotal} clusterRebuilds={ClusterRebuildTotal} churnSuppressed={ChurnSuppressed}");
    }

    // env-gated (COUCHCOOP_MIRROR_CARDRECTS=1): one block per promoted card with the DESIGN-space rects of its
    // TitleLabel / TypeLabel / DescriptionLabel clones (name-matched) for the crisp-crop gate.
    private void DumpRectLines(CardLayerPlan plan)
    {
        GD.Print($"M3_CARD_RECTS_BEGIN count={plan.Clusters.Count}");
        foreach (var item in plan.Clusters)
        {
            if (!_clusters.TryGetValue(item.RootId, out var cluster) || !GodotObject.IsInstanceValid(cluster.Holder))
            {
                continue;
            }

            foreach (var mid in cluster.MemberIds)
            {
                if (!_store.State.Nodes.TryGetValue(mid, out var node)
                    || node.Text is not { Text.Length: > 0 }
                    || !cluster.Clones.TryGetValue(mid, out var clone)
                    || !GodotObject.IsInstanceValid(clone))
                {
                    continue;
                }

                string leaf = NameLeaf(node.Name);
                if (leaf.Contains("Title") || leaf.Contains("Type") || leaf.Contains("Desc") || leaf.Contains("Name") || leaf.Contains("Label"))
                {
                    var r = DesignRectOf(clone, node);
                    GD.Print($"M3_CARD_RECT root={item.RootId} member={mid} name='{node.Name}' " +
                             $"x={r.MinX:0} y={r.MinY:0} w={r.MaxX - r.MinX:0} h={r.MaxY - r.MinY:0}");
                }
            }
        }

        GD.Print("M3_CARD_RECTS_END");
    }

    // The design-space AABB of a text member's box under its clone's global transform.
    private static DesignAabb DesignRectOf(MirrorNodeView clone, MirrorNode node)
    {
        var rect = node.LocalRect;
        var gt = clone.GetGlobalTransform();
        double x = rect?.X ?? 0, y = rect?.Y ?? 0, w = rect?.Width ?? 0, h = rect?.Height ?? 0;
        Vector2[] corners =
        {
            gt * new Vector2((float)x, (float)y),
            gt * new Vector2((float)(x + w), (float)y),
            gt * new Vector2((float)x, (float)(y + h)),
            gt * new Vector2((float)(x + w), (float)(y + h)),
        };
        float minX = corners[0].X, minY = corners[0].Y, maxX = corners[0].X, maxY = corners[0].Y;
        for (int i = 1; i < 4; i++)
        {
            minX = Mathf.Min(minX, corners[i].X);
            minY = Mathf.Min(minY, corners[i].Y);
            maxX = Mathf.Max(maxX, corners[i].X);
            maxY = Mathf.Max(maxY, corners[i].Y);
        }

        return new DesignAabb(minX, minY, maxX, maxY);
    }

    private static string NameLeaf(string name)
    {
        int slash = name.LastIndexOf('/');
        return slash >= 0 ? name[(slash + 1)..] : name;
    }

    private static bool SameMembers(IReadOnlyList<string> a, IReadOnlyList<string> b)
    {
        if (a.Count != b.Count)
        {
            return false;
        }

        for (int i = 0; i < a.Count; i++)
        {
            if (!string.Equals(a[i], b[i], System.StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    // Track-ST: env-gated one line per promote/revive/demote transition (the card-cluster half of the headline metric).
    private void Trace(string op, string rootId)
    {
        if (!TransDebug)
        {
            return;
        }

        string name = _store.State.Nodes.TryGetValue(rootId, out var n) ? n.Name : "?";
        GD.Print($"M3_CARDLAYER_TRANS: op={op} id={rootId} name='{name}' rev={_store.Revision}");
    }

    private static string Sanitize(string id)
    {
        var sb = new System.Text.StringBuilder(id.Length);
        foreach (char c in id)
        {
            sb.Append(char.IsLetterOrDigit(c) ? c : '_');
        }

        return sb.ToString();
    }
}
