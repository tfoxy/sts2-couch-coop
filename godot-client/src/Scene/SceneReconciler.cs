// The M1c core renderer: turns the retained MirrorState into a live Godot Node2D tree of MirrorNodeViews, one per
// wire node, nested to mirror the scene structure. Subscribes to MirrorStore.Drained (fired between the transform-
// index refresh and the ChangedIds clear), so it consumes exactly the changed set each drain.
//
// Keyframe (or first drain) → full rebuild. Otherwise incremental: update only the ChangedIds nodes, create/remove
// views as nodes appear/vanish, and re-run the structure pass (reparent + sibling order via MoveChild following
// BuildOrderStructure) only when order/adds/removes actually changed structure.
//
// Transforms are local: the wire matrix is the node-local Transform2D, and Godot's tree nesting composes globals.
//
// This is the STAGE root (a Node2D at the origin) mounted inside AppShell's SubViewport render-scale wrapper; the
// project's canvas_items stretch still maps its design coordinates to the root window.

using System.Collections.Generic;
using System.Diagnostics;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class SceneReconciler : Node2D
{
    private readonly Dictionary<string, MirrorNodeView> _views = new(System.StringComparer.Ordinal);

    private MirrorStore _store = null!;
    private RenderContext _ctx = null!; // built once in Bind; passed to every view.Apply + TweenReplayer.Consume
    private bool _built;

    // WS-B stream gate: true while the viewer sits on the join picker (the host is on a multiplayer screen and this
    // device has not chosen a seat). AppShell flips it with the socket's gate and hides this root, so a frame
    // rendered BEFORE the host entered that screen cannot linger behind the picker. Static — and re-asserted in Bind
    // — for the same reason QaForcedHide.StageHidden is: a rebuilt stack must not silently un-hide the stage.
    internal static bool StreamGateHidden;

    // Track I: the store Revision this reconciler last finished reconciling (set at the tail of OnDrained). The
    // idle-suspend controller — which subscribes to Drained BEFORE this reconciler, so its resume runs first in the
    // same drain callstack — DEBUG-asserts this is still the PREVIOUS revision when it wakes (wake-then-apply proof).
    internal int LastReconciledRevision { get; private set; } = -1;

    // Track A (direct-Full hosting): AppShell reparents this reconciler between the SubViewport (Half/Quarter) and its
    // own root canvas (Full) at runtime. A RemoveChild fires _ExitTree, which would drop the store subscription; the
    // flag lets Subscribe/UnsubscribeStore be idempotent so _EnterTree can re-attach on every (re-)entry without ever
    // double-subscribing (the first mount subscribes in Bind, before the node is added to the tree).
    private bool _storeSubscribed;

    // Wide-screen spread pass (M2): true while ANY view currently carries a non-zero spread offset/width. Lets the
    // pass early-out entirely at F=1 steady state, yet still run ONCE on an F→1 transition to zero the stale offsets.
    private bool _spreadDirty;

    // WS-EFFECTS-NATIVE live-flip. The Dynamic/Static/Off effect modes are RAM-only client prefs (ClientEffectSettings)
    // that never touch the wire, so a mode change produces no drain to piggy-back on. Instead — exactly like StageStretch
    // polls the widescreen getter each frame — this polls the mode generation and, on a change, re-runs the full Apply
    // pass on every live view so the effect attachments rebuild against the new mode. Steady-state cost: one int compare.
    private int _appliedEffectGen = ClientEffectSettings.Generation;
    private int _appliedBudgetGen = ContinuousBudget.Generation; // WS-perf3: last ContinuousBudget flip this reconciler re-Applied

    // ---- WS-P2 incremental ApplySpread --------------------------------------------------------------------------
    // At a widened aspect (F≠1) ApplySpread used to re-derive EVERY view's offset/width every drain. The SpreadIndex
    // walk already recomputes each node and now exposes the pre-resolved per-view stamp + a dirty set, so the pass
    // stamps ONLY the views whose stamp changed since last drain (the vast majority ride their parent unchanged).
    // ---- WS-P2 light apply --------------------------------------------------------------------------------------
    // For an EXISTING view whose per-node change set is a subset of Transform|Tint (SceneTreeApplier's differ), take
    // the cheap MirrorNodeView.ApplyLight — the streamed-truth + transform/modulate/visibility writes only — instead
    // of the full Apply (MaterialResolver + ResolveTexture + five effect Syncs + text sync + QueueRedraw).
    // ---- Track A keyframe diff ----------------------------------------------------------------------------------
    // On a keyframe drain over an ALREADY-BUILT tree (a Reload / reconnect), reconcile the keyframe as a DIFF against
    // the live views instead of parking + rebuilding the whole tree: keep same-id views in place, ClassifyKeyframe each
    // against the view's prior node (content-identical → skip Apply, transform/tint-only → ApplyLight, heavier → full
    // Apply), Acquire+build only new ids, and run the existing ReconcileStructure to fix parents/order + release vanished
    // ids. The trailing spread/tween/cull/bake/overlay passes run UNCHANGED (the tree is complete within the same drain).

    // ---- WS-P2 scene-identity/text-scale cache ------------------------------------------------------------------
    // Memoizes SceneIdentity.Resolve + TextScale.ScaleFor per node (CosmeticAnimator + SyncText read it via the
    // RenderContext). Invalidated wholesale on any Static-bearing / keyframe / order-change drain (identity inputs
    // are all static/structural); a volatile-only drain leaves it intact.
    private SceneIdentityCache _idCache = null!;

    // ---- WS-P1 MirrorNodeView pool -------------------------------------------------------------------------------
    // Recycle parked (fully reset) views instead of new/Free per drain: re-opening a card dialog re-keys an existing
    // view + re-Applies rather than instantiating a fresh subtree. Cap 512 (overflow → Free). Parked views are ORPHANS (removed
    // from the tree), so _ExitTree MUST Free them or they leak past a back-to-menu teardown.
    private const int PoolCap = 512;
    private readonly Stack<MirrorNodeView> _pool = new();

    // ---- CULL offscreen / invisible-content culling (M3 fill reduction) -----------------------------------------
    // The phone is GPU fill-bound inside the design-res raster; nodes fully outside the design viewport (map content
    // beyond the view, off-screen piles/hand under overlays) and fully-transparent subtrees still rasterize every
    // frame. The pure-math CullIndex (MirrorProtocol) turns the retained state + globals into a per-node cull decision;
    // this pass applies it to views: SelfPaint → suppress own _Draw + text; SubtreeOffscreen / SubtreeZeroAlpha →
    // Visible=false on the subtree root. All decisions are conservative (uncertain → visible).

    // Conservative slack (design px) added on every side of the design rect: absorbs the intent bob / held-card lift
    // (small, and only on ON-screen content) and text/effect overflow near a box edge. Generous by design — a missed
    // cull only wastes fill, a wrong cull drops pixels.
    private const double CullMargin = 128;

    private readonly CullIndex _cull = new();

    // ---- Track-D static bake -----------------------------------------------------------------------------------
    // The StaticBake controller (a sibling mounted BEFORE this reconciler under the stage viewport). This reconciler
    // drives it via three tail-hooks (OnDrained / InvalidateAll) and exposes the render context + a per-view
    // "dynamically owned" set the controller's planner needs. Null until AppShell attaches it; every hook is
    // null-conditional, and the controller itself is inert (Disabled) when static bake is disabled.
    private StaticBake? _staticBake;

    public void AttachStaticBake(StaticBake bake) => _staticBake = bake;

    // Track-B: the TextOverlay controller (a native-res CanvasLayer sibling of the stage, mounted by AppShell). This
    // reconciler drives it via tail-hooks (OnDrained / OnSpreadChanged / OnRefreshEffects) fired AFTER the StaticBake
    // hooks, and exposes the render context + the CollectBakeExcluded sweep it reuses. Null until AppShell attaches it;
    // every hook is null-conditional and the controller is inert (Active=false) at Full or with the feature off — so
    // this stays byte-identical to pre-Track-B when the overlay is not promoting.
    private TextOverlay? _textOverlay;

    public void AttachTextOverlay(TextOverlay overlay) => _textOverlay = overlay;

    // Track-C: the CardLayer controller (a native-res CanvasLayer sibling of the stage, mounted by AppShell). Driven by
    // tail-hooks fired AFTER the TextOverlay hooks; exposes CollectCardPromoted so the TextOverlay skips a promoted
    // card's own labels. Null until AppShell attaches it; every hook is null-conditional and the controller is inert
    // (Active=false) at Full or with the feature off.
    private CardLayer? _cardLayer;

    public void AttachCardLayer(CardLayer layer) => _cardLayer = layer;

    // Track-C: add the ids of every currently-promoted card's cloneable members to `into` — the TextOverlay folds this
    // into its excluded set so a promoted card's title/type/description labels are not ALSO promoted as loose proxies.
    internal void CollectCardPromoted(ISet<string> into) => _cardLayer?.CollectPromotedMemberIds(into);

    // WS-CRISP v3: the CardLayer's NCard root verdict sets (promoted-or-building / evaluated-last-plan) the
    // TextOverlay's narrowed CardOwned rule reads. No-op (both stay empty) with no card layer attached.
    internal void CollectCardRootSets(ISet<string> promotedInto, ISet<string> knownInto) =>
        _cardLayer?.CollectCardRootSets(promotedInto, knownInto);

    // Track-ST: is the CardLayer currently ACTIVE (enabled, Crisp-text on, non-Full)? The TextOverlay uses this to gate
    // its NCard-subtree exclusion — when the card layer owns cards, the text overlay must never double-promote a card's
    // own label (closes the same-drain double-text window the dynamic-candidate relaxation would otherwise open).
    internal bool CardLayerActive => _cardLayer?.Active ?? false;

    // Track-ST: add the ids of every live view whose texture has NOT decoded yet (a still-pending fetch) to `into`. The
    // CardLayer planner uses this as the ONLY member-dynamic reject under stable-text mode (an unsettled member's clone
    // would freeze a blank), while tween/anim/lift motion is tracked live by the per-frame member sync. Cheap: a bool
    // read per view, run only at the card eval cadence / structural replan (never per frame).
    internal void CollectUnsettledTextures(System.Collections.Generic.ISet<string> into)
    {
        foreach (var (id, view) in _views)
        {
            // WS-CRISP R18: a PERMANENTLY-failed texture (device wifi fetch exhaustion) never decodes, so the live view
            // is frozen blank forever — treating it as unsettled would keep the card MemberDynamic (never promoted) for
            // the whole session. TextureSettledOrFailed clears such a member (the clone paints the same blank).
            if (GodotObject.IsInstanceValid(view) && !view.TextureSettledOrFailed())
            {
                into.Add(id);
            }
        }
    }

    // Track-ST: true when the LAST drain this reconciler processed took the park-and-rebuild FullRebuild path (a first
    // build or a keyframe with KEYDIFF off) — every view object was replaced, so any TextOverlay/CardLayer proxy
    // referencing a surviving view id would point at a fresh, un-promoted view. A keyframe DIFF (KEYDIFF on) or an
    // incremental drain keeps the view objects, so a same-drain replan can keep the proxies. Set at the top of OnDrained.
    internal bool LastDrainFullRebuilt { get; private set; }

    // The render context threaded into every view.Apply — the StaticBake controller reuses it to Apply its clones so
    // the bake is drawer/material/text-identical to the live views.
    internal RenderContext BakeContext => _ctx;

    // Track-B: the render context (texture cache + store + IdentityCache) the TextOverlay controller reuses so its
    // native-res proxy labels are configured from the SAME TextBuilder + metrics as the in-stage "__text" children.
    internal RenderContext Context => _ctx;

    // Assemble the ids whose LIVE view is currently dynamically owned — a transform/modulate tween, an "__anim"
    // bob/spin ticker, a non-zero input lift, or a still-decoding texture — so the StaticBake planner never bakes
    // (freezes) them. Iterated by the controller at plan time (eval cadence), not per drain; near-empty at steady
    // state, so a full sweep of the live views is cheap and infrequent.
    // Assemble the ids whose LIVE view is currently dynamically owned into `into`, and — when `boundedCosmeticInto` is
    // supplied (Track-V) — in the SAME sweep the subset whose ONLY dynamism is a bounded cosmetic: a ±10px enemy-intent
    // bob or an in-place orb spin (HasAnimChild) with NO tween ownership, NO input lift, and a settled texture. Such a
    // node, when it OCCLUDES an earlier label, jitters only within the small known cosmetic envelope, so the planner
    // gives it the modest BoundedCosmeticSlackPx halo instead of the full unbounded DynamicSlackPx. One `_views` pass
    // fills both sets (the TextOverlay eval needs both; StaticBake passes only `into`). boundedCosmeticInto ⊆ into.
    internal void CollectBakeExcluded(
        System.Collections.Generic.ISet<string> into,
        System.Collections.Generic.ISet<string>? boundedCosmeticInto = null)
    {
        foreach (var (id, view) in _views)
        {
            if (!GodotObject.IsInstanceValid(view))
            {
                continue;
            }

            bool tweenOwned = view.TweenOwnsTransform || view.TweenOwnsModulateA || view.TweenOwnsSelfModulateA;
            bool lifted = view.LiftOffset != Vector2.Zero;
            bool unsettled = !view.TextureSettled;

            if (tweenOwned || view.HasAnimChild || lifted || unsettled)
            {
                into.Add(id);

                // Pure-cosmetic = an anim ticker with none of the UNBOUNDED sources (tween/lift) and a settled texture.
                if (boundedCosmeticInto is not null && view.HasAnimChild && !tweenOwned && !lifted && !unsettled)
                {
                    boundedCosmeticInto.Add(id);
                }
            }
        }
    }

    // Track I: run `action` over every live (IsInstanceValid) view — the idle-suspend controller's per-category freeze
    // sweep. Infrequent (one pass per idle-transition / wake), so a full _views walk is cheap.
    internal void ForEachLiveView(System.Action<MirrorNodeView> action)
    {
        foreach (var (_, view) in _views)
        {
            if (GodotObject.IsInstanceValid(view))
            {
                action(view);
            }
        }
    }

    // Reused across drains: the ids whose view currently owns a transform tween (streamed transform pinned → the cull
    // index treats them as bounds-uncertain). Cleared + refilled each cull pass; near-empty at steady state.
    private readonly System.Collections.Generic.HashSet<string> _boundsUncertain = new(System.StringComparer.Ordinal);

    // Cumulative pool telemetry (session totals; surfaced in BENCH_RESULT / M3_WALK, cleared on back-to-menu). Per-
    // drain M3_SPAWN can only show reuse when a single drain recycles ≥ 32 views (a dialog re-open / screen re-entry);
    // steady combat churn recycles a few views per drain, so these session totals are the robust "the pool is
    // actually recycling" evidence.
    public static long PoolCreatedTotal;
    public static long PoolReusedTotal;
    public static long PoolPooledTotal;
    public static long PoolFreedTotal;

    // Back-to-menu: clear the cumulative pool totals so the rebuilt stack's telemetry starts clean (AppShell calls
    // this alongside WalkProfiler.Reset).
    public static void ResetPoolTotals()
    {
        PoolCreatedTotal = 0;
        PoolReusedTotal = 0;
        PoolPooledTotal = 0;
        PoolFreedTotal = 0;
    }

    // ---- WS-P1 per-drain spawn attribution (reset each OnDrained; one M3_SPAWN line when created ≥ 32) -----------
    // Raw Stopwatch ticks accumulated unconditionally (near-free); formatted to ms only on the gated print.
    private long _spawnNewTicks;        // `new MirrorNodeView(...)` construction
    private long _spawnAddChildTicks;   // AddChild / RemoveChild / MoveChild (placeholder add + structure pass + release detach)
    private long _spawnApplyTicks;      // view.Apply total
    private long _spawnStructureTicks;  // ReconcileStructure (the structure pass) total
    private int _spawnCreated;          // views constructed new this drain
    private int _spawnFreed;            // released views destroyed (pool off / pool full)
    private int _spawnReused;           // released views recycled out of the pool
    private int _spawnPooled;           // released views parked into the pool
    private int _spawnLightApplied;     // WS-P2: existing views that took the light (transform/tint) apply this drain

    // ---- Track A keyframe-diff per-drain attribution (reset each OnDrained; one M3_KEYDIFF line when a keyframe diff ran)
    private bool _keydiffRan;           // this drain took the keyframe-diff path (drives the M3_KEYDIFF print)
    private int _keydiffSkipped;        // existing views whose content was byte-identical → Apply skipped (the win)
    private int _keydiffLight;          // existing views whose change set was transform/tint-only → ApplyLight
    private int _keydiffFull;           // existing views that took the full Apply (a real content change)
    private int _keydiffNew;            // ids with no live view → Acquire + full Apply (brand-new nodes)

    // Wire up the store hook + build the render context (texture cache + store + render options). Call BEFORE the
    // first drain (and before AddChild-ing this node so it is in the tree when Drained fires).
    public void Bind(MirrorStore store, TextureStore textures, RenderOptions opts)
    {
        _store = store;
        _idCache = new SceneIdentityCache();
        _ctx = new RenderContext(textures, store, opts, _idCache);
        // QA `hide stage` AND the WS-B stream gate both survive a stack rebuild (reconnect). These two static flags
        // are the ONLY writers of this root's Visible besides AppShell's gate flip, which ANDs the same pair.
        Visible = !QaForcedHide.StageHidden && !StreamGateHidden;
        SubscribeStore(); // idempotent; _EnterTree re-runs it after a Track-A reparent RemoveChild fired _ExitTree
    }

    // Track A: (re-)attach the store hooks. Idempotent via _storeSubscribed so the mount subscribe (Bind) + every
    // tree (re-)entry are safe, and a reparent's _ExitTree → _EnterTree round-trip nets exactly one subscription.
    private void SubscribeStore()
    {
        if (_store is null || _storeSubscribed)
        {
            return;
        }

        _store.Drained += OnDrained;
        _store.SpreadChanged += OnSpreadChanged; // relayout on a bare F change (no incoming delta)
        _storeSubscribed = true;
    }

    private void UnsubscribeStore()
    {
        if (_store is null || !_storeSubscribed)
        {
            return;
        }

        _store.Drained -= OnDrained;
        _store.SpreadChanged -= OnSpreadChanged;
        _storeSubscribed = false;
    }

    // Track A: re-attach the store subscription whenever this node (re-)enters the tree — a RemoveChild during a
    // render-scale hosting switch fired _ExitTree, which detached it. The live MirrorNodeView subtree rides the
    // reparent as this node's children (they are not re-created); only this subscription + the orphan pool need care.
    public override void _EnterTree() => SubscribeStore();

    // Poll the client effect-mode generation (RAM-only, no drain to hook). On a Dynamic/Static/Off flip, re-Apply
    // every live view so ShaderAttachment/ParticleAttachment rebuild against the new mode — the same poll-a-value/
    // act-on-change shape StageStretch uses for the widescreen toggle. No allocation at steady state.
    public override void _Process(double delta)
    {
        int gen = ClientEffectSettings.Generation;
        if (gen != _appliedEffectGen)
        {
            _appliedEffectGen = gen;
            RefreshEffects();
        }

        // WS-perf3 continuous-render-node budget: evaluate the live particle-continuous count (hysteretic) and, on a
        // state flip, re-Apply every live view through the SAME RefreshEffects path a mode flip uses so
        // ParticleAttachment.Configure re-reads ContinuousBudget.Multiplier onto already-mounted emitters. A flip is
        // rare (once on Tezcatara entry, once on exit — hysteresis), so the heavy RefreshEffects is off the hot path.
        // Multiplier reduction does not drop the continuous registration, so the engaged count stays high → no oscillation.
        ContinuousBudget.Evaluate(RenderActivity.ContinuousParticle);
        if (ContinuousBudget.Generation != _appliedBudgetGen)
        {
            _appliedBudgetGen = ContinuousBudget.Generation;
            RefreshEffects();
        }

        // Feature B: drain-starvation safety — expire stale hide-latches even when no drain arrives to run the
        // OnDrained sweep (a fade finishes, then the stream idles). Near-free when the registry is empty.
        TweenReplayer.SweepHideLatches();

        // R8 (WS-2): the round-6 tween-settle backstop that re-ran the view-scale pass on an idle frame is GONE. It
        // existed because the old pass could DEFER a stamp at a screen-entry transition and then never get another
        // drain to land it; the pure index has no deferral (a settling tween's endpoints fold through FoldCosmetic
        // like any other transform), so there is nothing to back-stop.
    }

    // Re-run the full Apply pipeline on every live view (retained node + streamed transform + ctx) — the same call
    // ShaderAttachment fires on an async shader mount. Re-runs MaterialResolver + the effect Syncs, so a mode flip
    // swaps shader variants / warms-or-frees particles / re-gates base paint. Only fires on an actual flip.
    private void RefreshEffects()
    {
        if (!_built)
        {
            return;
        }

        foreach (var (_, view) in _views)
        {
            if (GodotObject.IsInstanceValid(view) && view.NodeData is not null)
            {
                view.Apply(view.NodeData, view.StreamedLocal, _ctx);
            }
        }

        // The full re-Apply above stamped Visible=node.Visible on every view — clobbering any subtree cull. Force a
        // full cull re-derive so off-screen subtrees re-hide immediately instead of waiting for the next drain.
        _cull.MarkDirtyAll();
        RunCull(structural: false);

        // Track-D: an effect-mode flip re-Applied every view (re-showing suppressed "__text" + resetting Visible), so
        // any live bake's suppression is now inconsistent — tear it down and re-plan.
        _staticBake?.InvalidateAll();

        // Track-B: the full re-Apply re-showed every suppressed/promoted "__text" and may have changed which nodes are
        // effect-bearing (a mode flip toggles shader/particle attachments), so drop all proxies and re-plan next eval.
        _textOverlay?.OnRefreshEffects();

        // Track-C: the full re-Apply re-showed every hoisted member and may have toggled effect-bearing nodes — drop
        // all card clusters and re-plan next eval.
        _cardLayer?.OnRefreshEffects();
    }

    public override void _ExitTree()
    {
        // Track A: a RemoveChild during a hosting switch fires this; UnsubscribeStore is idempotent and _EnterTree
        // re-subscribes on the matching AddChild, so a reparent nets no subscription change. On the real back-to-menu
        // teardown (QueueFree) it detaches for good and the pool free below reclaims the orphan parked views.
        UnsubscribeStore();

        // WS-P1: parked views are orphans (detached from the tree), so the reconciler's own teardown does NOT cascade
        // to them — Free them explicitly or they leak past a back-to-menu rebuild.
        while (_pool.Count > 0)
        {
            var view = _pool.Pop();
            if (GodotObject.IsInstanceValid(view))
            {
                view.Free();
            }
        }
    }

    public int ViewCount => _views.Count;

    // Look up the live view for a wire node id (M1e input seam: WS-M's HeldCardLift resolves the held card's view to
    // write MirrorNodeView.LiftOffset). Returns false + a null view when the id has no live view.
    public bool TryGetView(string id, [System.Diagnostics.CodeAnalysis.MaybeNullWhen(false)] out MirrorNodeView view) =>
        _views.TryGetValue(id, out view);

    private void OnDrained(MirrorStore.DrainInfo info)
    {
        // WS-P1: zero the per-drain spawn accumulators before this drain's create/apply/structure work.
        ResetSpawnCounters();

        // WS-P2: invalidate the scene-identity/text-scale cache BEFORE the Applies below read it. Identity inputs are
        // all static/structural, so only a keyframe, an order change (reparent/rename), or a Static-bearing delta can
        // change them; a purely volatile drain leaves the cache valid (the win).
        MaybeInvalidateIdentityCache(info);

        // R8 (WS-2) #19 view scale: rebuild the PURE per-drain stamp index FIRST, before any view is applied.
        // MirrorStore.FinishDrain already refreshed Transforms + Spread, so the index is a function of this drain's
        // settled wire state; every fold below (fresh view, recycled view, light apply, tween endpoint, StaticBake
        // clone) then resolves its own channel from it. Inert (empty index) off a view-scale screen.
        ViewScaler.Rebuild(_store, info.Hints);

        // WS-W: Reconcile times the FullRebuild/Incremental branch ONLY (stops before ApplySpread, which gets its
        // own Spread bucket below) so the two don't double-count.
        long reconcileStart = WalkProfiler.Start();

        // WS-P2: a full rebuild re-acquires every view (fresh, zero spread offset), so the spread pass below must
        // take its FULL loop to re-stamp them all — the SpreadIndex's per-node dirty set can be empty on a keyframe
        // that re-created identical nodes (unchanged stamps), which would leave the fresh views un-widened. Track A:
        // a keyframe diff also acquires SOME fresh views (new ids) and re-stamps every kept view's offset, so it too
        // wants the spread pass's full loop — hence `forceFull` below is any-keyframe, not just FullRebuild.
        bool firstBuild = !_built;
        // Track A: a keyframe over an already-built tree diffs against the live views instead of park-and-rebuild.
        bool keydiff = info.Keyframe && !firstBuild;
        bool fullRebuild = firstBuild;
        LastDrainFullRebuilt = fullRebuild; // Track-ST: the overlay tail-hooks read this to decide replan-vs-DemoteAll
        if (fullRebuild)
        {
            FullRebuild();
        }
        else if (keydiff)
        {
            KeyframeDiff(info);
        }
        else
        {
            Incremental(info);
        }

        // A structural drain (full rebuild OR any draw-order change) — a single counter, cheaper than a second ring.
        if (info.Keyframe || info.OrderChanged)
        {
            WalkProfiler.StructuralDrains++;
        }

        WalkProfiler.Stop(WalkProfiler.Metric.Reconcile, reconcileStart);

        // WS-P1: one spawn-attribution line for a heavy drain (≥ 32 created OR ≥ 32 reused — dialog open / re-open /
        // keyframe FullRebuild). totalMs = the reconcile-branch elapsed measured from reconcileStart.
        long reconcileTicks = Stopwatch.GetTimestamp() - reconcileStart;
        MaybePrintSpawn(reconcileTicks);
        MaybePrintKeydiff(reconcileTicks); // Track A: one M3_KEYDIFF line per keyframe-diff drain (the Reload split)

        // Stamp each view's wide-screen spread offset/width from this drain's fresh SpreadIndex records — BEFORE the
        // tween arm, so a tween endpoint armed this frame (folded via MirrorNodeView.FoldForTween) sees the current
        // offset. Near-free at F=1 (early-out).
        long spreadStart = WalkProfiler.Start();
        ApplySpread(forceFull: fullRebuild || keydiff);
        WalkProfiler.Stop(WalkProfiler.Metric.Spread, spreadStart);

        // R8 (WS-2) #19: re-fold the handful of views whose view-scale stamp changed this drain but which the walk
        // above did not re-apply (an idle view-scale screen where only an ancestor moved). The index itself was built
        // at the TOP of this method; this is a pure trigger, never a source of truth. Runs AFTER the spread stamp
        // (the fold reads SpreadOffset) and BEFORE the HoverTip pass (which reads the view-scale registry via
        // MapThroughContainingStamps to glue a tip to a view-scaled owner). Empty set ⇒ free.
        ViewScaler.Refold(_views);

        // Feature A: render every visible NHoverTipSet 1.2× bigger — AFTER the spread stamp (so a widened tip measures
        // its shifted design box) + the view-scale pass (so a tip forward-maps a view-scaled owner) and BEFORE the tween
        // arm (so a tween endpoint armed this frame folds through the current scale via FoldForTween). Inert (early-out)
        // with the switch off or no tip-set present.
        HoverTipScaler.Apply(_store, _views);

        // Arm declarative tween replay AFTER the views for this drain exist/updated (web order): the replayer needs
        // the target views present + their streamed truth recorded before it can take channel ownership.
        long tweenStart = WalkProfiler.Start();
        TweenReplayer.Consume(info.Hints, _views, _ctx);
        // Feature B: expire any hide-latch whose grace elapsed this drain (the arm/settle for this drain already ran
        // inside Consume's Finished callbacks). Near-free when the registry is empty.
        TweenReplayer.SweepHideLatches();
        WalkProfiler.Stop(WalkProfiler.Metric.Tween, tweenStart);

        // CULL LAST, after Apply (which re-sets Visible=node.Visible) and after the tween arm/settle (so a fade's live
        // modulate ownership is current for the zero-alpha guard). A structural drain rebuilds the cull index's
        // parent→children map. The cull index's own incremental machinery keys off the transform index's recomputed
        // set, so this stays O(changed).
        RunCull(structural: info.Keyframe || info.OrderChanged);

        // Track-D: AFTER RunCull (so the bake sees this drain's final cull/suppression state). Advances the planner's
        // stability bookkeeping and invalidates a live bake the SAME frame if this drain touched the baked prefix
        // (keyframe / order change / changed-id ∩ prefix / hint-target ∩ prefix) — never a stale quad.
        _staticBake?.OnDrained(info);

        // Track-B: AFTER the bake (so promoted proxies see the final suppression state). Keyframe/OrderChanged
        // demotes all proxies (dialog opens are order changes); otherwise the cheap CollectDemotions guard demotes
        // new-occluder / fading / swept-tween labels, rebuilds changed promoted labels in place, and refreshes every
        // holder's transform/modulate for this drain.
        _textOverlay?.OnDrained(info);

        // Track-C: AFTER the TextOverlay (a promoted card hoist-suppresses its members' text, so the overlay must have
        // already reconciled its own proxies this drain). Keyframe ⇒ teardown + replan next frame; OrderChanged ⇒
        // immediate re-plan/diff (hand re-fan); else the per-drain demotion guard.
        _cardLayer?.OnDrained(info);

        // Track I: mark this drain reconciled LAST (the idle-suspend controller's wake ran FIRST in this callstack, so
        // until now LastReconciledRevision still held the previous drain's value — its DEBUG assert relies on that).
        LastReconciledRevision = info.Revision;

        // Feature B: env-gated flash-detector probe, sampling this drain's final rendered alphas (after cull). No-op
        // unless COUCHCOOP_MIRROR_HIDELATCH_PROBE=1.
        TweenReplayer.ProbeHideLatch(_views);
    }

    // WS-P2: clear the identity cache when this drain could have moved a node's scene identity — a keyframe, a draw-
    // order change (reparents/renames arrive that way), or any node carrying the Static change flag (name/type/parent/
    // scene/anchor/mouseFilter or a re-declared static block). A purely volatile drain leaves the cache intact. No-op
    // when no cache was populated.
    private void MaybeInvalidateIdentityCache(MirrorStore.DrainInfo info)
    {
        if (info.Keyframe || info.OrderChanged)
        {
            _idCache.Clear();
            return;
        }

        foreach (var flags in _store.State.ChangeFlags.Values)
        {
            if ((flags & CouchCoop.MirrorProtocol.SceneModel.NodeChangeFlags.Static) != 0)
            {
                _idCache.Clear();
                return;
            }
        }
    }

    // Re-stamp every view's spread offset/width on a bare F change (no incoming delta) — the store already recomputed
    // the SpreadIndex in SetSpreadFactor before raising SpreadChanged.
    private void OnSpreadChanged()
    {
        if (_built)
        {
            // A bare F change set SpreadIndex.DirtyAll (factor changed), so ApplySpread takes its full loop here — no
            // forceFull needed (no view churn happened; the views are all live).
            ApplySpread(forceFull: false);

            // #19: the view-scale item boxes + the design width moved with the factor → rebuild the stamp index and
            // re-fold the affected views FIRST (R5 item 6: the tip pass below reads the refreshed registry).
            ViewScaler.Rebuild(_store);
            ViewScaler.Refold(_views);

            // Feature A: the tip design boxes + the design width moved with the factor → re-stamp the hover scale.
            HoverTipScaler.Apply(_store, _views);

            // The design width moved with the factor → the cull rect moved. CullIndex.Update self-detects the width
            // change and re-derives every decision (the transform index was NOT refreshed here — no delta — but the
            // full path ignores the stale changed set).
            RunCull(structural: false);

            // Track-D: the spread relayout shifted the whole baked geometry (and the bake viewport width changed) —
            // drop the bake and re-plan at the new width.
            _staticBake?.InvalidateAll();

            // Track-B: every promoted label's holder transform (and the widened boxes) moved — drop all proxies and
            // re-plan at the new factor next eval.
            _textOverlay?.OnSpreadChanged();

            // Track-C: every promoted card's holder moved with the factor — drop all clusters and re-plan next eval.
            _cardLayer?.OnSpreadChanged();
        }
    }

    // ---- wide-screen spread pass (M2) -------------------------------------------------------------------------

    // Map each view's SpreadIndex record onto MirrorNodeView.SpreadOffset (parent-relative delta → parent-frame px)
    // + SpreadWidth. The setters early-out on unchanged values, so a steady widened scene re-stamps cheaply and a
    // 16:9 (F=1) scene skips entirely once its offsets are zeroed. Sole writer of SpreadOffset/SpreadWidth.
    //
    // WS-P2: at F≠1, when the incremental switch is ON and this is a steady-factor drain with no full rebuild, stamp
    // ONLY the views the SpreadIndex flagged dirty (DirtyIds) — the vast majority ride their parent unchanged and
    // keep their prior offset. The full loop still runs for F=1 zeroing, a factor change (DirtyAll), a full rebuild
    // (forceFull — fresh views), and the kill switch.
    // WS-BGBAKE round 3 spread fix (ii): the ids whose SpreadOffset/SpreadWidth WRITE really changed the value this
    // pass — reported to the StaticBake controller (steady-factor restamps used to leave a live band bake silently
    // mis-offset on widescreen). Collected only while a band bake wants them (WantsSpreadRestamps — F=1 is inert:
    // the fast path writes nothing). Reused scratch.
    private readonly List<string> _spreadRestamped = new();
    private bool _spreadReport;

    private void FlushSpreadRestamps()
    {
        if (_spreadReport && _spreadRestamped.Count > 0)
        {
            _staticBake?.OnSpreadRestamped(_spreadRestamped);
        }

        _spreadReport = false;
    }

    private void ApplySpread(bool forceFull)
    {
        double factor = _store.SpreadFactor;
        _spreadReport = _staticBake is { } sb && sb.WantsSpreadRestamps;
        if (_spreadReport)
        {
            _spreadRestamped.Clear();
        }

        // F=1: zero any lingering offsets ONCE (an F→1 transition set _spreadDirty from the last widened pass), then
        // early-out on every subsequent 16:9 frame. The full loop below does the zeroing (factor==1 → offset stays 0).
        if (factor == 1)
        {
            if (_spreadDirty)
            {
                ApplySpreadFull(factor);
            }

            FlushSpreadRestamps();
            return;
        }

        var spread = _store.Spread;
        bool useIncremental = !forceFull && !spread.DirtyAll;
        if (!useIncremental)
        {
            ApplySpreadFull(factor);
            FlushSpreadRestamps();
            return;
        }

        // Incremental: re-stamp only the changed/pruned views; the rest keep last drain's offset (their stamp is
        // unchanged). A pruned view is already zeroed (ResetForPool ran at release) AND absent from _views → skipped.
        foreach (var id in spread.DirtyIds)
        {
            if (!_views.TryGetValue(id, out var view))
            {
                continue; // pruned/never-had a view
            }

            Vector2 newOffset;
            double newWidth;
            if (spread.TryGetStamp(id, out var stamp))
            {
                newOffset = new Vector2((float)stamp.Ox, (float)stamp.Oy);
                newWidth = stamp.Width;
            }
            else
            {
                // Dirty but no stamp = pruned from the index but the view still lives (rare) → zero it.
                newOffset = Vector2.Zero;
                newWidth = 0;
            }

            if (_spreadReport && (view.SpreadOffset != newOffset || view.SpreadWidth != newWidth))
            {
                _spreadRestamped.Add(id);
            }

            view.SpreadOffset = newOffset;
            view.SpreadWidth = newWidth;
        }

        // At F≠1 the widened frame always carries offsets, so keep _spreadDirty armed for the eventual F→1 zeroing.
        _spreadDirty = true;

        FlushSpreadRestamps();
    }

    // The full per-view spread pass: derive each view's offset/width straight from the SpreadIndex RECORD (the ground
    // truth the incremental stamps mirror). Also the F=1 zeroing pass (factor==1 → the record branch is skipped, so
    // every view zeroes). Sets _spreadDirty from whether any offset/width remains non-zero.
    private void ApplySpreadFull(double factor)
    {
        var state = _store.State;
        var spread = _store.Spread;
        bool anyNonZero = false;

        foreach (var (id, view) in _views)
        {
            var (offset, width) = FullSpreadFor(state, spread, id, factor);
            if (_spreadReport && (view.SpreadOffset != offset || view.SpreadWidth != width))
            {
                _spreadRestamped.Add(id); // round 3 spread fix (ii): a value-changing restamp — see ApplySpread
            }

            view.SpreadOffset = offset;
            view.SpreadWidth = width;
            if (offset != Vector2.Zero || width != 0)
            {
                anyNonZero = true;
            }
        }

        _spreadDirty = anyNonZero;
    }

    // The ground-truth per-view offset/width for `id` at `factor`, derived from the SpreadIndex record exactly as the
    // pre-M2 loop did: fold the parent-relative delta (rec.Dx − parent's record Dx) through the parent's unshifted
    // global.
    private (Vector2 Offset, double Width) FullSpreadFor(MirrorState state, SpreadIndex spread, string id, double factor)
    {
        if (factor == 1 || !spread.TryGet(id, out var rec))
        {
            return (Vector2.Zero, 0);
        }

        double parentDx = 0;
        IReadOnlyList<double> parentGlobal = Affine.Identity;
        if (state.Nodes.TryGetValue(id, out var node) && node.ParentId is { } pid)
        {
            if (spread.TryGet(pid, out var prec))
            {
                parentDx = prec.Dx;
            }

            if (_store.Transforms.TryGetGlobal(pid, out var pg))
            {
                parentGlobal = pg;
            }
        }

        var (ox, oy) = SpreadMath.ParentFrameOffset(parentGlobal, rec.Dx - parentDx);
        return (new Vector2((float)ox, (float)oy), rec.RenderedWidth);
    }

    // ---- CULL offscreen / invisible-content culling -----------------------------------------------------------

    // Current cull-state population (not cumulative) surfaced in M3_WALK / BENCH_RESULT. SelfPaint nodes count as "self"; SubtreeOffscreen + SubtreeZeroAlpha as
    // "subtree".
    public long CulledSelfCount => _cull.CulledSelf;
    public long CulledSubtreeCount => _cull.CulledSubtree;

    // Recompute + apply the cull decisions for this drain (or a bare spread/effect re-eval). Times itself on the Cull
    // walk bucket. No-op before the first build. `structural` rebuilds the index's
    // parent→children map (keyframe / draw-order change).
    private void RunCull(bool structural)
    {
        if (!_built)
        {
            return;
        }

        long start = WalkProfiler.Start();

        // Bounds-uncertain = the ids whose view currently owns a transform tween (streamed transform pinned at the
        // pre-tween value while Godot animates the visible transform). Near-empty at steady state; EMPTY during map
        // scroll and under InstantTweens.
        _boundsUncertain.Clear();
        TweenReplayer.CollectTransformOwned(_boundsUncertain);

        double designWidth = _store.SpreadFactor * StageStretch.BaseDesignWidth;
        _cull.Update(_store.State, _store.Transforms, designWidth, CullMargin, _boundsUncertain, structural);

        var state = _store.State;
        foreach (var id in _cull.DecisionDirty)
        {
            if (_views.TryGetValue(id, out var view)
                && GodotObject.IsInstanceValid(view)
                && state.Nodes.TryGetValue(id, out var node))
            {
                _cull.TryGetDecision(id, out var decision);
                ApplyCull(view, node, decision);
            }
        }

        WalkProfiler.Stop(WalkProfiler.Metric.Cull, start);
    }

    // Map a per-node cull decision onto its view. Restores the streamed Visible on the None/SelfPaint paths (a prior
    // subtree cull may have hidden it). The zero-alpha hide is GUARDED on live modulate-tween ownership: a fade pins
    // streamed alpha at an endpoint (0) while animating THROUGH it, so hiding then would blank a fading element.
    private static void ApplyCull(MirrorNodeView view, MirrorNode node, CullIndex.Decision decision)
    {
        switch (decision)
        {
            case CullIndex.Decision.SubtreeOffscreen:
                view.SetSelfPaintCulled(false);
                view.Visible = false;
                break;
            case CullIndex.Decision.SubtreeZeroAlpha:
                view.SetSelfPaintCulled(false);
                view.Visible = view.TweenOwnsModulateA ? node.Visible : false;
                break;
            case CullIndex.Decision.SelfPaint:
                view.Visible = node.Visible;
                view.SetSelfPaintCulled(true);
                break;
            default: // None
                view.Visible = node.Visible;
                view.SetSelfPaintCulled(false);
                break;
        }

        // QA forced-hide (hide/show verbs): re-assert AFTER the cull decision — the None/SelfPaint paths above
        // restore the streamed Visible, which must not resurrect a force-hidden node. Free when unused (Active guard).
        if (QaForcedHide.Active && QaForcedHide.Matches(node))
        {
            view.Visible = false;
        }
    }

    // ---- QA forced hide (hide/show verbs; sole caller DemoInputPlayer) ------------------------------------------

    // Re-derive every live view's Visible after the forced-hide set changed, AT VERB TIME — a static scene may not
    // drain for seconds, and the per-drain enforcement (Apply/ApplyLight/ApplyCull) only touches drained nodes. A
    // `hide` lands immediately; a `show` restores via the blanket streamed-Visible re-stamp, then the full cull
    // re-derive re-hides legitimately culled subtrees (the same restore-then-recull shape RefreshEffects uses).
    internal void QaApplyForcedHide()
    {
        if (!_built)
        {
            return;
        }

        var state = _store.State;
        foreach (var (id, view) in _views)
        {
            if (GodotObject.IsInstanceValid(view) && state.Nodes.TryGetValue(id, out var node))
            {
                view.Visible = node.Visible && !(QaForcedHide.Active && QaForcedHide.Matches(node));
            }
        }

        _cull.MarkDirtyAll();
        RunCull(structural: false);
    }

    // ---- full rebuild -----------------------------------------------------------------------------------------

    private void FullRebuild()
    {
        // WS-P1: park the whole old tree into the pool (child-first via ReleaseSubtree) so BuildSubtree below can
        // recycle the views instead of allocating a fresh subtree — immediate (not QueueFree) so no ghost draws this
        // frame. Pop one entry at a time: ReleaseSubtree removes each released view AND its descendants from _views,
        // so the loop terminates for any pop order (a popped parent recurses into its children first; a popped child
        // is detached from its parent before the parent is reached).
        while (_views.Count > 0)
        {
            string id = null!;
            MirrorNodeView view = null!;
            foreach (var kv in _views)
            {
                id = kv.Key;
                view = kv.Value;
                break;
            }

            _views.Remove(id);
            ReleaseSubtree(id, view);
        }

        var state = _store.State;
        var (rootIds, childIdsByParent) = SceneTreeApplier.BuildOrderStructure(state.OrderedIds, state.Nodes);
        foreach (var rid in rootIds)
        {
            BuildSubtree(rid, this, childIdsByParent);
        }

        _built = true;
    }

    private void BuildSubtree(string id, Node parent, Dictionary<string, List<string>> childIdsByParent)
    {
        var node = _store.State.Nodes[id];
        var view = Acquire(id);
        _views[id] = view;
        TimedAddChild(parent, view);
        TimedApply(view, node, LocalXform(node, view));

        if (childIdsByParent.TryGetValue(id, out var kids))
        {
            foreach (var kid in kids)
            {
                BuildSubtree(kid, view, childIdsByParent);
            }
        }
    }

    // ---- incremental ------------------------------------------------------------------------------------------

    private void Incremental(MirrorStore.DrainInfo info)
    {
        var state = _store.State;
        bool structural = info.OrderChanged;

        foreach (var id in info.ChangedIds)
        {
            if (state.Nodes.TryGetValue(id, out var node))
            {
                if (!_views.TryGetValue(id, out var view))
                {
                    view = Acquire(id); // WS-P1: pop a parked view (re-keyed) or construct new
                    _views[id] = view;
                    TimedAddChild(this, view); // placeholder parent; the structure pass reparents it
                    structural = true;
                    TimedApply(view, node, LocalXform(node, view)); // a fresh view must fully populate
                }
                else if (state.ChangeFlags.TryGetValue(id, out var flags)
                         && NodeChangeDiffer.IsLightEligible(flags))
                {
                    // WS-P2: only transform/tint (+ R11 same-size region re-crop) changed on an already-populated
                    // view → the cheap subset; pass the Region flag so a flame frame swap nudges a redraw.
                    TimedApplyLight(view, node, LocalXform(node, view), (flags & NodeChangeFlags.Region) != 0);
                }
                else
                {
                    TimedApply(view, node, LocalXform(node, view));
                }
            }
            else if (_views.ContainsKey(id))
            {
                structural = true; // a view whose node vanished — released in the structure pass
            }
        }

        if (structural)
        {
            long structStart = Stopwatch.GetTimestamp();
            ReconcileStructure();
            _spawnStructureTicks += Stopwatch.GetTimestamp() - structStart;
        }

    }

    // ---- Track A keyframe diff --------------------------------------------------------------------------------

    // Reconcile a keyframe over the ALREADY-BUILT tree as a DIFF instead of park-and-rebuild. For every live node:
    // keep its existing view and ClassifyKeyframe it against the view's prior node — content-identical → skip Apply
    // (rebind the data ref only), transform/tint-only → ApplyLight, heavier → full Apply; an id with no view → Acquire
    // + full Apply (a brand-new node). Then ReconcileStructure fixes parents/order (a keyframe always replaces the draw
    // order) AND releases views whose node vanished (its stale loop). The trailing spread/tween/cull/bake/overlay passes
    // in OnDrained run UNCHANGED — the tree is complete within this drain, so there is no partial-tree hazard.
    private void KeyframeDiff(MirrorStore.DrainInfo info)
    {
        var state = _store.State;
        _keydiffRan = true;

        foreach (var (id, node) in state.Nodes)
        {
            if (!_views.TryGetValue(id, out var view))
            {
                // Brand-new node: pop a parked view (re-keyed) or construct one, attach under a placeholder parent
                // (the structure pass reparents it), and fully populate it — exactly the Incremental new-node path.
                view = Acquire(id);
                _views[id] = view;
                TimedAddChild(this, view);
                TimedApply(view, node, LocalXform(node, view));
                _keydiffNew++;
                continue;
            }

            // Diff the keyframe's node against the view's last-applied node. A live view always carries NodeData (its
            // acquire-time Apply set it); guard defensively → full Apply if somehow absent.
            //
            // NOTE (effect animation phase): keydiff keeps views in place, so a node's CLIENT-SIDE effect animation
            // state — a particle sim, a static-baked shader's frozen TIME, a cosmetic bob/spin ticker; none of which
            // rides the wire — keeps running across a Reload instead of resetting to a fresh child the way FullRebuild's
            // park-and-rebuild does. This is web-parity (the frontend reconciler is incremental too) and avoids a
            // reset-pop, but it means a Reload's still is NOT pixel-identical to a FullRebuild reload for the handful of
            // actively-animating decorative effect nodes. Verified isolated to effects (COUCHCOOP_EFFECTS=off → the
            // keydiff and FullRebuild reload stills are AE=0 across the whole screen). All non-effect content is exact.
            var prior = view.NodeData;
            NodeChangeFlags flags = prior is null
                ? NodeChangeDiffer.StructuralAll
                : NodeChangeDiffer.ClassifyKeyframe(prior, node);

            if (flags == NodeChangeFlags.None)
            {
                // Content byte-identical → NO render work. Repoint the data ref at the live store object so NodeData
                // stays consistent (effect attachments / RefreshEffects read it), and keep the current transform (a
                // live tween / cosmetic fold owns it) untouched.
                view.RebindNode(node);
                _keydiffSkipped++;
            }
            else if (NodeChangeDiffer.IsLightEligible(flags))
            {
                TimedApplyLight(view, node, LocalXform(node, view), (flags & NodeChangeFlags.Region) != 0);
                _keydiffLight++;
            }
            else
            {
                TimedApply(view, node, LocalXform(node, view));
                _keydiffFull++;
            }
        }

        // A keyframe always re-sends the draw order, so run the structure pass unconditionally: it reparents/reorders
        // every kept view to the current structure (near-free now that ApplyLevel skips MoveChild for already-placed
        // views) AND releases the views whose node vanished (its stale loop). Timed into the structure bucket.
        long structStart = Stopwatch.GetTimestamp();
        ReconcileStructure();
        _spawnStructureTicks += Stopwatch.GetTimestamp() - structStart;

    }

    // Reparent + reorder every live view to match the current draw-order structure, then free views whose node is
    // gone (their live descendants were already pulled out to their correct parents by the reparent pass).
    private void ReconcileStructure()
    {
        var state = _store.State;
        var (rootIds, childIdsByParent) = SceneTreeApplier.BuildOrderStructure(state.OrderedIds, state.Nodes);

        ApplyLevel(rootIds, this, childIdsByParent);

        List<string>? stale = null;
        foreach (var (id, _) in _views)
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
                // ReleaseSubtree may have already parked this view via a stale PARENT's child-first recursion — skip
                // it then. (Live descendants were already reparented out to their live parents by ApplyLevel, so a
                // stale view's remaining MirrorNodeView children are all stale.) WS-P1: Release parks to the pool.
                if (_views.TryGetValue(id, out var view))
                {
                    _views.Remove(id);
                    ReleaseSubtree(id, view);
                }
            }
        }
    }

    private void ApplyLevel(List<string> ids, Node parentNode, Dictionary<string, List<string>> childIdsByParent)
    {
        for (int i = 0; i < ids.Count; i++)
        {
            if (!_views.TryGetValue(ids[i], out var view))
            {
                continue;
            }

            if (view.GetParent() != parentNode)
            {
                TimedRemoveChild(view.GetParent(), view);
                TimedAddChild(parentNode, view);
            }

            // Skip a no-op MoveChild when the view already sits at its target index. Views occupy indices 0..k-1 (the
            // effect-attachment children are end-appended past them), so the loop index i IS a placed view's absolute
            // child index — a match means it is already correctly ordered. Load-bearing for Track A: a Reload keyframe's
            // order is unchanged, so this turns 1000+ redundant MoveChild calls into cheap GetIndex compares. Behavior-
            // identical (MoveChild to the current index is a no-op) so the Incremental structural path is unaffected too.
            if (view.GetIndex() != i)
            {
                TimedMoveChild(parentNode, view, i);
            }

            if (childIdsByParent.TryGetValue(ids[i], out var kids))
            {
                ApplyLevel(kids, view, childIdsByParent);
            }
        }
    }

    // ---- WS-P1 pool acquire / release --------------------------------------------------------------------------

    // Get a view for `id`: pop a parked (already fully reset) view and re-key it, else construct a fresh one. The pop
    // path is near-free (no reset here — the reset happened at RELEASE time, so parked views are provably inert).
    private MirrorNodeView Acquire(string id)
    {
        if (_pool.Count > 0)
        {
            var recycled = _pool.Pop();
            recycled.Rekey(id);
            _spawnReused++;
            PoolReusedTotal++;
            return recycled;
        }

        long start = Stopwatch.GetTimestamp();
        var view = new MirrorNodeView(id);
        _spawnNewTicks += Stopwatch.GetTimestamp() - start;
        _spawnCreated++;
        PoolCreatedTotal++;
        return view;
    }

    // Release a view whose MirrorNodeView children have ALREADY been released (caller guarantees child-first): detach
    // it from the tree, do the COMPLETE reset (which frees the effect-attachment children + runs the tween/shader
    // linchpins), then park it (or Free on overflow / kill switch). Sole caller of MirrorNodeView.ResetForPool.
    private void Release(string id, MirrorNodeView view)
    {
        if (!GodotObject.IsInstanceValid(view))
        {
            return;
        }

        // #7 instrumentation (COUCHCOOP_MIRROR_TWEEN_DEBUG=1): trace the release — id + the view's scale at removal +
        // whether a transform tween owns it — so the death-shrink agent can see if a view shrinks (a settle/tween)
        // right before it's parked/freed. No behavior change.
        if (TweenDebugSettings.Enabled)
        {
            GD.Print($"TWEEN_DEBUG: release id={id} transformScale=({view.Transform.Scale.X:0.###},{view.Transform.Scale.Y:0.###}) tweenOwnsTransform={view.TweenOwnsTransform}");
        }

        var parent = view.GetParent();
        if (parent is not null)
        {
            TimedRemoveChild(parent, view);
        }

        view.ResetForPool();

        if (_pool.Count < PoolCap)
        {
            _pool.Push(view);
            _spawnPooled++;
            PoolPooledTotal++;
        }
        else
        {
            view.Free();
            _spawnFreed++;
            PoolFreedTotal++;
        }
    }

    // Release an entire subtree CHILD-FIRST so each view parks with no MirrorNodeView children remaining (the reset's
    // free-children step then only sees effect attachments — its DEBUG assert relies on this). Recurses into the
    // view's MirrorNodeView children (all stale in the stale-loop context; the whole tree in FullRebuild), pulling
    // each out of _views before releasing it.
    private void ReleaseSubtree(string id, MirrorNodeView view)
    {
        if (!GodotObject.IsInstanceValid(view))
        {
            return;
        }

        List<MirrorNodeView>? kids = null;
        foreach (var child in view.GetChildren())
        {
            if (child is MirrorNodeView mv)
            {
                (kids ??= new List<MirrorNodeView>()).Add(mv);
            }
        }

        if (kids is not null)
        {
            foreach (var mv in kids)
            {
                _views.Remove(mv.NodeId);
                ReleaseSubtree(mv.NodeId, mv);
            }
        }

        Release(id, view);
    }

    // ---- WS-P1 spawn-attribution timing helpers ----------------------------------------------------------------

    private void TimedAddChild(Node parent, Node child)
    {
        long start = Stopwatch.GetTimestamp();
        parent.AddChild(child);
        _spawnAddChildTicks += Stopwatch.GetTimestamp() - start;
    }

    private void TimedRemoveChild(Node? parent, Node child)
    {
        if (parent is null)
        {
            return;
        }

        long start = Stopwatch.GetTimestamp();
        parent.RemoveChild(child);
        _spawnAddChildTicks += Stopwatch.GetTimestamp() - start;
    }

    private void TimedMoveChild(Node parent, Node child, int index)
    {
        long start = Stopwatch.GetTimestamp();
        parent.MoveChild(child, index);
        _spawnAddChildTicks += Stopwatch.GetTimestamp() - start;
    }

    private void TimedApply(MirrorNodeView view, MirrorNode node, Transform2D local)
    {
        long start = Stopwatch.GetTimestamp();
        view.Apply(node, local, _ctx);
        _spawnApplyTicks += Stopwatch.GetTimestamp() - start;
    }

    // WS-P2: a light apply counts into the SAME applyMs bucket (so total apply cost stays comparable) but is tallied
    // separately so M3_SPAWN can report how many of a heavy drain's touches took the cheap path.
    private void TimedApplyLight(MirrorNodeView view, MirrorNode node, Transform2D local, bool regionRedraw = false)
    {
        long start = Stopwatch.GetTimestamp();
        view.ApplyLight(node, local);
        // R11: a same-size atlas re-crop (Region flag) rode the light path — ApplyLight refreshed the node but skipped
        // QueueRedraw, so nudge the drawer to re-sample the new crop. A plain transform/tint light apply skips this.
        if (regionRedraw)
        {
            view.MarkRegionRedraw();
        }

        _spawnApplyTicks += Stopwatch.GetTimestamp() - start;
        _spawnLightApplied++;
    }

    private void ResetSpawnCounters()
    {
        _spawnNewTicks = 0;
        _spawnAddChildTicks = 0;
        _spawnApplyTicks = 0;
        _spawnStructureTicks = 0;
        _spawnCreated = 0;
        _spawnFreed = 0;
        _spawnReused = 0;
        _spawnPooled = 0;
        _spawnLightApplied = 0;

        _keydiffRan = false;
        _keydiffSkipped = 0;
        _keydiffLight = 0;
        _keydiffFull = 0;
        _keydiffNew = 0;
    }

    // One machine-readable spawn line per heavy drain — the dialog-open / keyframe class. Gated on created ≥ 32 (the
    // spec's fresh-construction threshold) OR reused ≥ 32, so a dialog RE-open (which recycles ≥ 32 pooled views with
    // few/no fresh constructions) still surfaces its reused count. The split drives follow-up decisions (is the cost
    // construction, tree wiring, Apply, or the structure walk?).
    private void MaybePrintSpawn(long totalTicks)
    {
        if (_spawnCreated < 32 && _spawnReused < 32)
        {
            return;
        }

        GD.Print(
            $"M3_SPAWN: created={_spawnCreated} freed={_spawnFreed} reused={_spawnReused} " +
            $"newMs={Ms(_spawnNewTicks)} addChildMs={Ms(_spawnAddChildTicks)} applyMs={Ms(_spawnApplyTicks)} " +
            $"structureMs={Ms(_spawnStructureTicks)} totalMs={Ms(totalTicks)} pooled={_spawnPooled} " +
            $"lightApplied={_spawnLightApplied}");
    }

    // Track A: one machine-readable line per keyframe-diff drain (the Reload split). Always prints when the keyframe-diff
    // path ran (keyframes are infrequent), so the reload soak reports per-cycle skipped/applied/new/released + the ms
    // buckets even though created/reused are ~0 (the FullRebuild-gated M3_SPAWN would stay silent). `released` = views
    // whose node vanished, reclaimed by the structure pass (pooled + freed this drain).
    private void MaybePrintKeydiff(long totalTicks)
    {
        if (!_keydiffRan)
        {
            return;
        }

        GD.Print(
            $"M3_KEYDIFF: nodes={_views.Count} skipped={_keydiffSkipped} light={_keydiffLight} full={_keydiffFull} " +
            $"new={_keydiffNew} released={_spawnPooled + _spawnFreed} newMs={Ms(_spawnNewTicks)} " +
            $"addChildMs={Ms(_spawnAddChildTicks)} applyMs={Ms(_spawnApplyTicks)} structureMs={Ms(_spawnStructureTicks)} " +
            $"totalMs={Ms(totalTicks)} reused={_spawnReused}");
    }

    private static string Ms(long ticks) =>
        (ticks * 1000.0 / Stopwatch.Frequency).ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);

    // ---- transform derivation ---------------------------------------------------------------------------------

    // #11: read-once TRANS_DEBUG lever (shared with CardLayer/TextOverlay). When on, logs the LocalXform global-miss
    // for an already-placed node — the smoking gun for the "discard card goes to (0,0)" reparent collapse. A live
    // Survivor-discard repro with this on confirms the client-side hold vs a producer-side (0,0) (which would instead
    // show a PRESENT global at (0,0), never reaching this leg). Web confirm: record-mirror-stream / replay-ws-server.
    private static readonly bool TransDebug =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_TRANS_DEBUG") == "1";

    private Transform2D LocalXform(MirrorNode node, MirrorNodeView view)
    {
        // Strict v1 scene deltas carry node-local transforms only. A transform-less delta for an already-placed view
        // holds its last known placement rather than snapping it to identity.
        if (node.Transform is { } t)
        {
            return WireXform(t);
        }

        return HoldOrIdentity(node, view, "local-null");
    }

    // Hold an already-placed view's last-known local when its transform is omitted; a never-placed view has no
    // meaningful prior transform, so identity is safer. Logs under TRANS_DEBUG.
    private Transform2D HoldOrIdentity(MirrorNode node, MirrorNodeView view, string why)
    {
        if (!view.HasPlacedTransform)
        {
            return Transform2D.Identity;
        }

        if (TransDebug)
        {
            var leaf = node.NodeType;
            var dot = leaf.LastIndexOf('.');
            if (dot >= 0)
            {
                leaf = leaf[(dot + 1)..];
            }

            GD.Print($"M3_TRANS: hold id={node.Id} leaf={leaf} why={why} parent={node.ParentId ?? "-"} " +
                     $"visible={node.Visible} (held last-known local instead of collapsing to origin)");
        }

        return view.StreamedLocal;
    }

    // Wire CSS matrix [a,b,c,d,tx,ty] → Godot Transform2D(xx=a, xy=b, yx=c, yy=d, ox=tx, oy=ty) — direct mapping
    // (both express x' = a·x + c·y + tx, y' = b·x + d·y + ty).
    private static Transform2D WireXform(IReadOnlyList<double> m) =>
        new((float)m[0], (float)m[1], (float)m[2], (float)m[3], (float)m[4], (float)m[5]);
}
