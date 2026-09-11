// Track-D static background pre-composite ("static bake"). Replaces the bottom-most STATIC run of the painter's order
// (background / room / floor ≈ 33% of scene fill, ~80% static) with ONE pre-composited quad, re-baking only on change.
// The phone is GPU fill-bound inside the design-res raster; a baked bottom prefix rasterizes its ~1.7 screens of
// coverage ONCE into a viewport texture instead of every frame.
//
// MECHANISM — clone-tree one-shot bake (chosen over reparent/flat-replay: it never touches the live tree's node
// identities, tweens or pool, and composes bit-exactly). A throwaway nested tree of fresh MirrorNodeView CLONES is
// built into an offscreen design-res SubViewport (TransparentBg, UpdateMode.Once) and set up via the SAME
// view.Apply(node, liveView.StreamedLocal, ctx) + copied SpreadOffset/SpreadWidth as the live views — identical
// drawers / materials / clip stencils / text layout ⇒ AE=0 by construction. The bake quad draws that viewport texture
// over the full design rect with premultiplied-alpha blend ("over" onto the transparent stage background is
// associative → bit-exact composition). The baked ORIGINALS get self-paint suppression only (SetSelfPaintBaked) so
// they don't double-draw; their child views (any live, non-baked descendants) stay live and draw on top of the quad.
//
// MOUNTED as a SIBLING of the SceneReconciler, added BEFORE it under the render-stage viewport, so the quad composites
// UNDERNEATH the live tree (sibling order = paint order). It is NOT a reconciler child (ApplyLevel's MoveChild pass
// tail-pushes non-view children). Clones are plain Free()d — NEVER ResetForPool (that would ReleaseFor the LIVE
// node's id; the clone shares it). The pure-C# StaticBakePlanner owns the eligibility + prefix + stability math; this
// controller owns the Godot state machine, the clone build/free, and the excluded-set + telemetry plumbing.
//
// STATE MACHINE: Disabled → Idle → Baking (clones built, viewport Once, originals STILL live) → Active (quad shown,
// originals suppressed) → invalidate → Idle (after a cooldown). Every build/swap/invalidate Marks RenderActivity so
// the Once viewport renders even from an on-demand-Disabled stage (the 8-frame grace covers the 2-frame render wait),
// and an Active bake is pure static content (composes with the T1 on-demand skip).
//
// The persisted static-bake setting controls whether this optional rendering feature is active.

using System.Collections.Generic;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class StaticBake : Node2D
{
    public enum BakeState
    {
        Disabled,
        Idle,
        Baking,
        Active,
        // WS-BGBAKE round 3 double-buffered teardown: a retain-class invalidation keeps the STALE generation's quads
        // shown (originals still suppressed) while the replacement plans + builds alongside; SwapGeneration() flips
        // atomically in one frame. The raw scene is never exposed between bakes (~1.3s per rebuild before this).
        Rebaking,
    }

    // Whether a Static-mode shader that samples the screen
    // (SCREEN_TEXTURE / hint_screen_texture) may be baked. Such a shader composites whatever is under it, so removing
    // the under-pixels into the same quad it draws over CAN shift its output; if the AE matrix ever shows a
    // screen-read parity break.
    // Keep non-Mix painters and Add-blend shaders out of non-bottom regions.
    // On a member touch, release only the touched region and the band above it.
    // Combat uses the current band-flatten planner.

    // Bound on how long a STALE generation may stay shown while its replacement fails to settle (~5s at 60fps).
    // Crossing it hard-drops the stale quads (raw scene) rather than showing an ever-more-wrong picture.
    private const int StaleMaxFrames = 300;


    // After an invalidation, wait this many frames before the next plan attempt (debounce a churning region so it can
    // never rebake-storm). Only applied post-invalidation — the first bake is not delayed by it.
    private const int CooldownFrames = 45;

    // Attempt a plan at most this often (a plan walks the ordered ids + collects the excluded set — not per-frame work).
    private const int EvalCadenceFrames = 30;

    // Frames to let the Once viewport render before swapping to the quad (well under RenderActivity's 8-frame grace).
    private const int BakeRenderSettleFrames = 2;

    private SceneReconciler _reconciler = null!;
    private MirrorStore _store = null!;

    private readonly StaticBakePlanner _planner = new();

    // WS-BGBAKE round 3: the PURE band drain-residency decision (keyframe/order structure verdict + culprit
    // classification + bench registration) — hoisted into SceneModel so the replay-driven residency test drives the
    // SAME logic this controller runs. Constructed here (a field initializer cannot reference _planner).
    private readonly BandResidencyMachine _residency;

    public StaticBake()
    {
        _residency = new BandResidencyMachine(_planner);
    }

    // Track-P3: one host per baked REGION (v2 = a single region). Each owns a bake viewport + a composite quad drawn at
    // the region's ABSOLUTE effZ; the quads interleave with the live band painters (re-leveled via _liveZApplied).
    private readonly List<RegionHost> _hosts = new();

    // Reused scratch (avoid per-eval / per-drain allocation).
    private readonly HashSet<string> _excluded = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _effectStaticOk = new(System.StringComparer.Ordinal); // Track-P: shader ids OK to bake in the current mode
    private readonly HashSet<string> _bottomOnly = new(System.StringComparer.Ordinal); // WS-ADDBAKE: Sub/Mul + un-rewritable Add (bake region-0 only, else live)
    private readonly List<string> _hintTargets = new();
    private readonly List<string> _invalidationCulprits = new();

    // WS-BGBAKE carrier follow: hint-target culprits (hints whose target clones into some region), split out on the
    // drain path. Reused scratch (the bench sets live in the residency machine now).
    private readonly List<string> _hintCulprits = new();

    // Track-P3c: the live band painters currently given an absolute-z override (id → z), so a partial release can clear
    // just the top-suffix and a re-plan can reconcile without touching the untouched (lower) overrides.
    private readonly Dictionary<string, int> _liveZApplied = new(System.StringComparer.Ordinal);

    private BakeState _state = BakeState.Disabled;
    private int _cooldownRemaining;
    private int _framesSinceEval;
    private bool _evaluatedEmpty; // an eval ran with assets idle and produced no bakeable plan (the shot-settle terminal)

    // WS-BGBAKE round 3 double buffer: frames the current stale generation has been shown (bounded by
    // StaleMaxFrames), plus the cumulative swap/drop telemetry the QA state JSON surfaces (C6).
    private int _staleFrames;
    private int _notIdleFrames; // C7 FASTENTRY: consecutive frames the Idle eval was blocked on busy asset stores
    public long GenSwapTotal { get; private set; }   // atomic generation swaps (invisible rebakes)
    public long StaleDropTotal { get; private set; } // stale generations HARD-dropped (bound crossed / mode flip)
    public long KeyframeSurviveTotal { get; private set; } // keyframes the band bake survived OUTRIGHT (C3)

    // WS-BGBAKE round 3 spread fix (ii): steady-factor spread RE-STAMPS (widescreen only — the reconciler reports
    // ids whose SpreadOffset/SpreadWidth write really changed the value). Debounced SpreadRestampSettleFrames of
    // quiet, then value-compared against the per-host BakedSpread snapshots: differ ⇒ retain-class rebake (never a
    // bench — spread motion is not the node's fault); equal ⇒ suppressed (counted). Inert at F=1.
    private const int SpreadRestampSettleFrames = 30;
    private readonly HashSet<string> _pendingSpreadRestamps = new(System.StringComparer.Ordinal);
    private int _spreadQuietFrames;
    public long SpreadRestampInvalidationTotal { get; private set; }
    public long SpreadRestampSuppressedTotal { get; private set; }

    // WS-BGBAKE round 3 C6 telemetry. UnbakedVisibleFrames is THE loop-residency gate: frames where the band is
    // armed, the screen is combat, a band bake HAS shown this room — and yet NO host quad is shown (raw scene
    // visible). With the double buffer + keyframe survival it must stay 0 across loop seams. StaleQuadFrames /
    // StaleMaxRun quantify how long the stale generation covers rebakes.
    public long UnbakedVisibleFrames { get; private set; }
    public long StaleQuadFrames { get; private set; }
    public long StaleMaxRun { get; private set; }
    private long _staleRun;
    private bool _bandShownThisRoom;
    private string _lastScreenType = "";

    // Cheap gate the reconciler consults BEFORE collecting restamp ids (the compare loop only runs while a band
    // bake is actually shown/building under the double buffer).
    public bool WantsSpreadRestamps =>
        BandPlanActive && _hosts.Count > 0
        && _state is BakeState.Active or BakeState.Baking or BakeState.Rebaking;

    // Reconciler callback (ApplySpread): some views' spread offsets really moved this pass. Only WATCHED ids matter
    // (a re-leveled live painter follows its own view; excluded subtrees ride their root) — queue them and restart
    // the quiet window.
    public void OnSpreadRestamped(IReadOnlyList<string> ids)
    {
        bool any = false;
        foreach (var id in ids)
        {
            if (IsWatchedAnywhere(id))
            {
                _pendingSpreadRestamps.Add(id);
                any = true;
            }
        }

        if (any)
        {
            _spreadQuietFrames = 0;
        }
    }

    // Debounce expired — decide: any watched id whose CURRENT spread differs from the value it was BAKED with forces
    // a retain-class rebake (the quads hold pixels at the old offsets); an identical round-trip (a transient that
    // settled back) is suppressed.
    private void ResolveSpreadRestamps()
    {
        bool differ = false;
        foreach (var id in _pendingSpreadRestamps)
        {
            if (!_reconciler.TryGetView(id, out var view) || !GodotObject.IsInstanceValid(view))
            {
                differ = true; // conservative — can't prove the value returned
                break;
            }

            foreach (var host in _hosts)
            {
                if (host.State == RegionHostState.StaleShown)
                {
                    continue; // already being replaced
                }

                if (host.BakedSpread.TryGetValue(id, out var baked)
                    && (baked.Offset != view.SpreadOffset || baked.Width != view.SpreadWidth))
                {
                    differ = true;
                    break;
                }
            }

            if (differ)
            {
                break;
            }
        }

        _pendingSpreadRestamps.Clear();
        _spreadQuietFrames = 0;
        if (differ)
        {
            SpreadRestampInvalidationTotal++;
            BandRetainTeardown(int.MinValue); // never benches — spread motion is not a node's misbehavior
        }
        else
        {
            SpreadRestampSuppressedTotal++;
        }
    }

    // The CURRENT plan came from the band-flatten path (false whenever the exact planner produced it, whenever
    // nothing is baked, and on disarm). Surfaced as `bakeBand` in the QA state JSON + `band=` in ShotStatus/M3.
    public bool BandPlanActive { get; private set; }

    // WS-BGBAKE order guard: the band paint-order prefix the CURRENT band plan was computed from (null for exact-path
    // plans / nothing baked — cleared by ClearRegions). OnDrained compares it against the post-drain state so an
    // OrderChanged that only shuffled the z≥0 world (hand reorders, damage-number spawns — measured 183/1190 deltas,
    // ~7/s, in the canonical combat recording) keeps the band bake instead of tearing it down.
    private IReadOnlyList<string>? _activeBandIds;

    // Round 3: the plan's slot-collapsed live-subtree roots — the order guard projects ids under these OUT of the
    // band comparison (intent-wave / VFX / HUD churn inside an excluded subtree never tears the bake down).
    private IReadOnlyList<string>? _activeExcludedRoots;

    // OrderChanged drains a live band bake SURVIVED because its band prefix was untouched (before the guard, each of
    // these was a full teardown + 45-frame cooldown ⇒ ~1% Active duty cycle in combat). Next to RebakeTotal in QA.
    public long OrderSkipTotal { get; private set; }

    // WS-BGBAKE carrier follow: drains whose only band-watch culprits were Transform-only spine-carrier moves
    // (screen shake / scene slide on the band's root container) — the quads were retransformed in place instead of
    // torn down. Surfaced as `bakeCarrierFollows` in the QA state JSON.
    public long CarrierFollowTotal { get; private set; }

    // Telemetry (instance-scoped — dies with the stage on Back-to-menu; the reconciler/AppShell surface it).
    public long BuildTotal { get; private set; }   // successful swaps to Active
    public long RebakeTotal { get; private set; }  // active/baking bakes torn down by an invalidation

    public BakeState State => _state;

    public int BakedNodeCount
    {
        get
        {
            int n = 0;
            foreach (var h in _hosts)
            {
                n += h.BakedIds.Count;
            }

            return n;
        }
    }

    public int CarrierNodeCount
    {
        get
        {
            int n = 0;
            foreach (var h in _hosts)
            {
                n += h.CarrierIds.Count;
            }

            return n;
        }
    }

    public int RegionCount => _hosts.Count;

    public int LiveZCount => _liveZApplied.Count;

    // Wire the controller. Parks in Idle or Disabled according to the persisted setting; the per-region bake viewports +
    // quads are built lazily per bake. Call AFTER SceneReconciler.Bind and BEFORE adding this node to the stage
    // viewport's tree (mounted before the reconciler so the quads sort under the live tree at equal effZ).
    public void Bind(SceneReconciler reconciler, MirrorStore store)
    {
        _reconciler = reconciler;
        _store = store;

        // QA `hide bake` survives a stack rebuild (reconnect): the composite quads are CHILDREN of this root, so
        // hiding it blanks every current AND future quad (SwapHostToActive's Quad.Show() stays under a hidden
        // parent) while the bake pipeline — viewports, originals' suppression, live-z overrides — runs unperturbed.
        Visible = !QaForcedHide.BakeHidden;

        // The persisted static-bake setting also works on Android; record its current source for diagnostics.
        bool settingsEnabled = Ui.ClientSettingsStore.StaticBake;
        _bakeEnableSource = ComputeEnableSource();
        _state = settingsEnabled ? BakeState.Idle : BakeState.Disabled;
    }

    // WS-MISC item 3 (hot-apply): re-evaluate the effective enable at runtime. AppShell polls the persisted
    // staticBake setting each frame — flipped live by the SettingsPanel checkbox or the QA `setting
    // staticbake` verb — so a toggle takes effect WITHOUT a reconnect. Arming a Disabled controller parks it in Idle so
    // the next idle-asset eval bakes; disarming runs the SAME teardown ClearRegions uses on an invalidation (un-suppress
    // every baked original + clear the live-z overrides + free every host's viewport/quad — no live node left
    // suppressed) and hard-stops the machine at Disabled. Idempotent: a no-op once the armed state already matches.
    public void SetEnabled(bool enabled)
    {
        bool armed = _state != BakeState.Disabled;
        if (enabled == armed)
        {
            return;
        }

        if (enabled)
        {
            // Arm: park in Idle and let _Process's eval cadence bake once assets settle. Mark so an on-demand-Disabled
            // stage still renders the bake viewports (the eval + the Once renders need live frames).
            _state = BakeState.Idle;
            _cooldownRemaining = 0;
            _framesSinceEval = 0;
            _evaluatedEmpty = false;
            RenderActivity.Mark();
        }
        else
        {
            // Disarm: drop any live bake (restores the live tree's current pixels — never a frozen stale bake) and
            // hard-stop the state machine. ClearRegions is idempotent from any state (Idle with no hosts → no-op body).
            ClearRegions();
            _state = BakeState.Disabled;
            _cooldownRemaining = 0;
            _framesSinceEval = 0;
            _evaluatedEmpty = false;
            BandPlanActive = false; // WS-BGBAKE: nothing baked ⇒ no band plan
        }

        _bakeEnableSource = ComputeEnableSource();
    }

    // The effective runtime enable is whether the state machine is armed.
    public bool IsEffectivelyEnabled => _state != BakeState.Disabled;

    // The persisted setting source, surfaced in QA state. Recomputed on every arm/disarm.
    public string BakeEnableSource => _bakeEnableSource;

    private static string ComputeEnableSource() =>
        Ui.ClientSettingsStore.StaticBake ? "settings" : "off";

    private string _bakeEnableSource = "off";

    public override void _Process(double delta)
    {
        if (_state == BakeState.Disabled)
        {
            return;
        }

        _planner.ObserveFrame();

        // Round 3 spread fix (ii): a queued steady-factor restamp resolves after a quiet window (screen-slide
        // settles → ONE decision instead of a rebake storm).
        if (_pendingSpreadRestamps.Count > 0 && ++_spreadQuietFrames >= SpreadRestampSettleFrames)
        {
            ResolveSpreadRestamps();
        }

        // C6 telemetry: the loop-residency gate + stale-cover accounting (armed frames only — _Process returns
        // above when Disabled).
        var screenType = _store.State.ScreenType;
        if (!string.Equals(screenType, _lastScreenType, System.StringComparison.Ordinal))
        {
            _lastScreenType = screenType;
            if (!string.Equals(screenType, "combat", System.StringComparison.Ordinal))
            {
                _bandShownThisRoom = false; // a new room starts a fresh residency window
            }
        }

        bool anyShown = false;
        bool anyStale = false;
        foreach (var host in _hosts)
        {
            if (host.State is RegionHostState.Active or RegionHostState.StaleShown)
            {
                anyShown = true;
            }

            if (host.State == RegionHostState.StaleShown)
            {
                anyStale = true;
            }
        }

        if (anyStale)
        {
            StaleQuadFrames++;
            _staleRun++;
            if (_staleRun > StaleMaxRun)
            {
                StaleMaxRun = _staleRun;
            }
        }
        else
        {
            _staleRun = 0;
        }

        if (string.Equals(screenType, "combat", System.StringComparison.Ordinal))
        {
            if (anyShown && BandPlanActive)
            {
                _bandShownThisRoom = true;
            }
            else if (_bandShownThisRoom && !anyShown)
            {
                UnbakedVisibleFrames++; // a raw-scene frame after the room had a bake — the toggling defect
            }
        }

        switch (_state)
        {
            case BakeState.Idle:
                if (_cooldownRemaining > 0)
                {
                    _cooldownRemaining--;
                    return;
                }

                _framesSinceEval++;
                if (_framesSinceEval >= EvalCadenceFrames)
                {
                    if (AssetStores.AllIdle)
                    {
                        _notIdleFrames = 0;
                        _framesSinceEval = 0;
                        TryStartBake();
                    }
                }

                break;

            case BakeState.Baking:
                // Each freshly-built host waits BakeRenderSettleFrames for its Once viewport to render, then swaps.
                // A partial re-bake leaves already-Active hosts untouched; only the Building ones count down here.
                bool anyPending = false;
                foreach (var host in _hosts)
                {
                    if (host.State == RegionHostState.Building)
                    {
                        if (--host.RenderWait <= 0)
                        {
                            SwapHostToActive(host);
                        }
                        else
                        {
                            anyPending = true;
                        }
                    }
                }

                if (!anyPending)
                {
                    FinishBaking();
                }

                break;

            case BakeState.Active:
                // Steady — invalidation is drain-driven (OnDrained) / event-driven (InvalidateAll).
                break;

            case BakeState.Rebaking:
                // Round 3 double buffer: the stale generation is still SHOWN. Bound its lifetime, count down any
                // replacement builds (no per-host swap — the flip must be atomic), then SwapGeneration() once every
                // Building host's Once render has landed; with nothing building yet, run the eval cadence to
                // produce the replacement plan.
                _staleFrames++;
                if (_staleFrames > StaleMaxFrames)
                {
                    HardDropStale(); // bounded staleness — raw scene beats an ever-more-wrong stale picture
                    break;
                }

                bool anyBuilding = false;
                bool buildPending = false;
                foreach (var host in _hosts)
                {
                    if (host.State == RegionHostState.Building)
                    {
                        anyBuilding = true;
                        host.RenderWait = System.Math.Max(0, host.RenderWait - 1);
                        if (host.RenderWait > 0)
                        {
                            buildPending = true;
                        }
                    }
                }

                if (anyBuilding)
                {
                    if (!buildPending)
                    {
                        SwapGeneration();
                    }

                    break;
                }

                if (_cooldownRemaining > 0)
                {
                    _cooldownRemaining--;
                    break;
                }

                _framesSinceEval++;
                if (_framesSinceEval >= EvalCadenceFrames && AssetStores.AllIdle)
                {
                    _framesSinceEval = 0;
                    TryStartBake();
                }

                break;
        }
    }

    // Plan + build. Times the whole attempt on the Bake walk bucket. On a bakeable plan, RECONCILES the plan against
    // any already-Active hosts (a partial re-bake keeps the untouched lower regions and builds only the released ones),
    // sets each new viewport to render Once, and enters Baking; on an empty plan, tears down any survivors and records
    // the terminal for the shot-settle gate.
    private void TryStartBake()
    {
        long start = WalkProfiler.Start();

        _excluded.Clear();
        _reconciler.CollectBakeExcluded(_excluded);

        // R8 (WS-2): a VIEW-SCALED node (#19 reward list / card reward / shop / event options) and its whole subtree
        // never bake. The clone tree already folds the same view-scale stamp as the live views by construction (a
        // clone carries the live wire id, so MirrorNodeView resolves it from the same per-drain index) — this is
        // belt-and-braces, and it removes the whole "a frozen quad has to reproduce a cosmetic scale" surface, which
        // is the shape a rebake cycle turns into "the options snap back every few seconds". Deliberately applied HERE
        // and not inside CollectBakeExcluded: that set is SHARED with the TextOverlay eval, where marking a scaled
        // subtree dynamic would suppress crisp text on exactly the screens (card reward / shop) that want it most.
        // View-scale screens are never the combat band the bake exists for, so the bake coverage cost is nil, and it
        // is free off such a screen (empty index).
        ViewScaler.CollectBakeExcluded(_store.State, _excluded);

        CollectEffectStaticOk();
        CollectBottomOnly();

        double designW = _store.SpreadFactor * StageStretch.BaseDesignWidth;

        // Combat scenes first try the band-flatten planner; a refusal and non-combat scenes use the exact planner.
        StaticBakePlan plan = StaticBakePlan.None;
        BandPlanActive = false;
        if (_store.State.ScreenType == "combat")
        {
            plan = _planner.PlanBandFlatten(_store.State, _store.Transforms, designW, _excluded, _effectStaticOk, _bottomOnly);
            BandPlanActive = plan.IsBakeable;
        }

        if (!plan.IsBakeable)
        {
            plan = _planner.Plan(_store.State, _store.Transforms, designW, _excluded, _effectStaticOk, _bottomOnly);
        }

        _activeBandIds = plan.BandIds; // order-guard identity (null on the exact path — its handling is unchanged)
        _activeExcludedRoots = plan.ExcludedLiveRoots;

        LogPlan(plan);

        if (!plan.IsBakeable)
        {
            // Round 3: while Rebaking with the double buffer on, HOLD the stale picture (the band may re-settle in
            // a moment; StaleMaxFrames bounds the hold) — never flash the raw scene on a transiently-empty plan.
            if (_state == BakeState.Rebaking && HasStaleHosts)
            {
                WalkProfiler.Stop(WalkProfiler.Metric.Bake, start);
                return;
            }

            // No bakeable plan from scratch. Any surviving (partial) hosts are stale relative to a fresh plan — drop
            // them so the live tree shows current pixels; then this is a clean empty terminal. Lingering live-z
            // overrides can outlive the hosts (a degenerate retain freed every Building host) — they re-level live
            // painters with no quads under them, so they must clear here too. Going raw at an empty terminal is a
            // DELIBERATE transition — it re-opens the residency window like every DROP-class path.
            if (_hosts.Count > 0 || _liveZApplied.Count > 0)
            {
                ClearRegions();
            }

            _bandShownThisRoom = false;
            _evaluatedEmpty = true;
            _state = BakeState.Idle;
            WalkProfiler.Stop(WalkProfiler.Metric.Bake, start);
            return;
        }

        // A non-band exact plan cannot generation-swap, so it drops a stale band generation before applying.
        if (HasStaleHosts && !BandPlanActive)
        {
            HardDropStale();
        }

        _evaluatedEmpty = false;
        bool builtAny = BuildRegions(plan, designW);
        if (HasStaleHosts)
        {
            // Double-buffered generation build: stale quads stay shown while the replacements render; the flip is
            // atomic in SwapGeneration (immediately, when every planned region matched a kept Active host).
            if (builtAny)
            {
                _state = BakeState.Rebaking;
                RenderActivity.Mark();
            }
            else
            {
                SwapGeneration();
            }
        }
        else if (builtAny)
        {
            _state = BakeState.Baking;
            RenderActivity.Mark(); // keep the stage alive so the Once viewports render
        }
        else
        {
            // Every planned region already matched an Active host (a partial eval that found nothing new to build) —
            // just reconcile the live-z overrides and stay Active.
            ApplyLiveZ(plan.LiveZ);
            _state = _hosts.Count > 0 ? BakeState.Active : BakeState.Idle;
        }

        WalkProfiler.Stop(WalkProfiler.Metric.Bake, start);
    }

    // Compute the reused `_effectStaticOk` set: the ShaderId ids the planner may treat as bakeable in the CURRENT
    // effect mode. A shader is clearable when the mode is Off, or when Static mode has a mounted premult-composable
    // shader that does not sample the screen.
    // Dynamic mode never clears a shader (its live TIME / screen animation can't be frozen). Cheap; runs at the eval
    // cadence (not per frame) with AssetStores.AllIdle already guaranteed (so every requested shader is terminal).
    private void CollectEffectStaticOk()
    {
        _effectStaticOk.Clear();
        var mode = ClientEffectSettings.ShaderMode;
        if (mode == EffectMode.Dynamic)
        {
            return; // a live shader can't be baked
        }

        foreach (var (id, node) in _store.State.Nodes)
        {
            if (node.ShaderId is not { } shaderId)
            {
                continue;
            }

            if (mode == EffectMode.Off)
            {
                _effectStaticOk.Add(id); // Off → base art is final art (no ShaderMaterial); always bakeable
                continue;
            }

            // Static: needs a compiled shader, a premult-composable blend class, and (unless allowed) no screen read.
            if (ShaderStore.PeekState(shaderId) != ShaderState.Mounted)
            {
                continue;
            }

            // Round 3 (WS-BGBAKE segmentation): Sub/Mul blend-CLASS shaders (the combat tree-shadow) are now ALSO
            // clearable — the segmented planner's segment-local bottomOnly premise (a painting member of the same
            // segment must precede them) makes their frozen output composable inside a quad, exactly like a Sub/Mul
            // plain painter. Screen-read gating below is unchanged (a screen-reading Sub/Mul stays live).
            var blend = ShaderStore.PeekBlendClass(shaderId);
            if (blend is not (ShaderBlendClass.Mix or ShaderBlendClass.Add or ShaderBlendClass.Sub or ShaderBlendClass.Mul))
            {
                continue;
            }

            // Add-blend shaders require a successful alpha-preserving fragment rewrite; otherwise they stay live.
            if (blend == ShaderBlendClass.Add && !ShaderStore.PeekBakeAddOk(shaderId))
            {
                continue;
            }

            _effectStaticOk.Add(id);
        }
    }

    // Collect ids that may bake only in the bottom region: Sub/Mul painters and unrewritable Add shaders. Rewritable
    // Add shaders use the alpha-preserving variant and may bake in any region.
    private void CollectBottomOnly()
    {
        _bottomOnly.Clear();
        foreach (var (id, node) in _store.State.Nodes)
        {
            // Cleared Mix and rewritable Add shaders are not bottom-only. Cleared Sub/Mul shaders remain bottom-only.
            if (node.ShaderId is { } shaderId && _effectStaticOk.Contains(id))
            {
                var blendClass = ShaderStore.PeekBlendClass(shaderId);
                if (blendClass is ShaderBlendClass.Sub or ShaderBlendClass.Mul)
                {
                    _bottomOnly.Add(id);
                }

                continue;
            }

            // An UN-cleared Add-blend shader (un-rewritable / screen-read / unmounted): keep it LIVE (bridged, re-leveled)
            // so it can't truncate the band — containment. Only meaningful with ADDBAKE on (off ⇒ Add shaders are cleared).
            if (node.ShaderId is { } sid2 && ShaderStore.PeekBlendClass(sid2) == ShaderBlendClass.Add)
            {
                _bottomOnly.Add(id);
                continue;
            }

            // A plain painter. Sub/Mul (2/3) are always bottom-only. Add (1): bottom-only only in the v3 fallback
            // (ADDBAKE off); with ADDBAKE on it bakes via the alpha-preserving variant.
            if (node.CanvasBlendMode is int b)
            {
                if (b is 2 or 3)
                {
                    _bottomOnly.Add(id);
                }
            }
        }
    }

    private IReadOnlyList<LiveZOverride> _pendingLiveZ = System.Array.Empty<LiveZOverride>();

    // RECONCILING build: keep every planned region that exactly matches an already-Active host (same mix/add member
    // sequence + quad z — a partial re-bake spares the untouched lower regions), build a fresh Building host for each
    // planned region that has no match, and tear down any Active host the new plan no longer contains. Returns whether
    // any NEW host was built (⇒ the controller enters Baking to await the Once renders). The plan's LiveZ overrides are
    // recorded and reconciled at FinishBaking (or directly when nothing new is built).
    private bool BuildRegions(StaticBakePlan plan, double designW)
    {
        // Track-P render-scale parity: mirror the stage's ACTUAL pixel count (Half → StretchShrink-reduced) while
        // keeping the clone coordinate space at design via Size2DOverrideStretch, so the quad draws 1:1 (no double
        // resample). Same for every region viewport.
        int overW = (int)System.Math.Round(designW);
        int overH = StageStretch.DesignHeight;
        Vector2I actual = GetViewport() switch
        {
            SubViewport sv when sv.Size is { X: > 0, Y: > 0 } => sv.Size,
            Window w when w.Size is { X: > 0, Y: > 0 } => w.Size,
            _ => new Vector2I(overW, overH),
        };

        var ctx = _reconciler.BakeContext;

        const double bakeScale = 1.0;

        var activeBySig = new Dictionary<string, RegionHost>(System.StringComparer.Ordinal);
        foreach (var host in _hosts)
        {
            if (host.State == RegionHostState.Active)
            {
                activeBySig[host.Signature] = host;
            }
        }

        var kept = new HashSet<RegionHost>();
        bool builtAny = false;
        foreach (var region in plan.Regions)
        {
            string sig = SignatureOf(region);
            if (activeBySig.TryGetValue(sig, out var existing))
            {
                kept.Add(existing); // identical region already baked & shown — keep it as-is (position-stable z)
                continue;
            }

            BuildHost(region, designW, ctx, actual, overW, overH, bakeScale);
            builtAny = true;
        }

        // Any Active host absent from the new plan is stale. Band hosts remain visible until an atomic generation swap;
        // exact-plan hosts are restored and freed immediately.
        for (int i = _hosts.Count - 1; i >= 0; i--)
        {
            var host = _hosts[i];
            if (host.State == RegionHostState.Active && !kept.Contains(host))
            {
                if (BandPlanActive)
                {
                    host.State = RegionHostState.StaleShown;
                }
                else
                {
                    UnsuppressHost(host);
                    FreeHost(host);
                    _hosts.RemoveAt(i);
                }
            }
        }

        _pendingLiveZ = plan.LiveZ;
        return builtAny;
    }

    // Build one Building host = a viewport + composite quad. Clones are built pre-order into the viewport; baked ids get
    // the full view.Apply (drawers / materials / clip stencils / text compose bit-exactly; WS-ADDBAKE: an Add member's
    // clone gets the alpha-preserving variant via MaterialResolver / ShaderAttachment), carriers get the cheap
    // ApplyLight + self-paint suppression. The host is NOT swapped yet (originals stay live, quad hidden) —
    // SwapHostToActive does that once the Once render lands.
    private void BuildHost(StaticBakeRegion region, double designW, RenderContext ctx, Vector2I actual, int overW, int overH, double bakeScale)
    {
        var host = new RegionHost
        {
            State = RegionHostState.Building,
            RenderWait = BakeRenderSettleFrames,
            MixQuadZ = region.QuadZ,
            Signature = SignatureOf(region),
        };

        // WS-BGBAKE: a sub-1.0 bake scale shrinks only the PIXEL size; Size2DOverride stays design, so the clone
        // coordinate space and quad geometry are untouched and the quad up-samples (Linear) at composite time.
        Vector2I pixels = bakeScale < 1.0
            ? new Vector2I(
                System.Math.Max(1, (int)System.Math.Round(actual.X * bakeScale)),
                System.Math.Max(1, (int)System.Math.Round(actual.Y * bakeScale)))
            : actual;

        host.Viewport = MakeBakeViewport(pixels, overW, overH);
        AddChild(host.Viewport);
        host.Quad = new BakeQuad();
        host.Quad.Init(host.Viewport, designW,
            System.Math.Clamp(region.QuadZ, -StaticBakePlanner.MaxZIndex, StaticBakePlanner.MaxZIndex),
            linearFilter: bakeScale < 1.0);
        AddChild(host.Quad);
        BuildCloneTree(host.Viewport, region.BuildOrder, region.BakedIds, ctx, host.BakedIds, host.CarrierIds, host.Watch,
            host.BakedSpread);
        foreach (var id in host.BakedIds)
        {
            host.BakedSet.Add(id);
        }

        ComputeSpineAnchor(host);
        _hosts.Add(host);
    }

    // WS-BGBAKE carrier follow: compute the host's spine carriers (carriers that are ancestors of EVERY baked
    // member) and its anchor — the deepest spine carrier — snapshotting the INVERSE of the anchor's design-space
    // global at build time (the same GlobalTransformIndex the plan was computed from, refreshed this drain). Runs
    // once per host build; a host with no spine (flat members at the root) simply never follows.
    private void ComputeSpineAnchor(RegionHost host)
    {
        host.SpineCarriers.Clear();
        host.AnchorId = null;
        if (host.BakedIds.Count == 0 || host.CarrierIds.Count == 0)
        {
            return;
        }

        var carrierSet = new HashSet<string>(host.CarrierIds, System.StringComparer.Ordinal);

        // The first member's carrier-ancestor chain, DEEPEST first — the candidate spine (ancestors-of-all form a
        // single chain, so intersecting with every other member's ancestor set filters it in place).
        var chain = new List<string>();
        var cur = _store.State.Nodes.TryGetValue(host.BakedIds[0], out var first) ? first.ParentId : null;
        while (cur is not null && _store.State.Nodes.TryGetValue(cur, out var anc))
        {
            if (carrierSet.Contains(cur))
            {
                chain.Add(cur);
            }

            cur = anc.ParentId;
        }

        if (chain.Count == 0)
        {
            return;
        }

        var candidates = new HashSet<string>(chain, System.StringComparer.Ordinal);
        var seen = new HashSet<string>(System.StringComparer.Ordinal);
        for (int i = 1; i < host.BakedIds.Count && candidates.Count > 0; i++)
        {
            seen.Clear();
            var c = _store.State.Nodes.TryGetValue(host.BakedIds[i], out var node) ? node.ParentId : null;
            while (c is not null && _store.State.Nodes.TryGetValue(c, out var anc))
            {
                seen.Add(c);
                c = anc.ParentId;
            }

            candidates.IntersectWith(seen);
        }

        foreach (var id in candidates)
        {
            host.SpineCarriers.Add(id);
        }

        foreach (var id in chain) // deepest-first — the first survivor is the anchor
        {
            if (candidates.Contains(id))
            {
                host.AnchorId = id;
                // Round 3: the authoritative follow snapshot is the anchor VIEW's RENDERED global (FoldCosmetic
                // already folds SpreadOffset into MirrorNodeView.Transform, and GlobalTransform composes the real
                // ancestor chain) — the wire-space delta ignored the spread channel, so every widescreen shake
                // displaced the quads horizontally.
                if (_reconciler.TryGetView(id, out var anchorView) && GodotObject.IsInstanceValid(anchorView))
                {
                    host.AnchorBakedRenderedInverse = anchorView.GlobalTransform.AffineInverse();
                }

                break;
            }
        }
    }

    private SubViewport MakeBakeViewport(Vector2I actual, int overW, int overH) => new()
    {
        Name = "StaticBakeViewport",
        TransparentBg = true,
        RenderTargetClearMode = SubViewport.ClearMode.Always,
        RenderTargetUpdateMode = SubViewport.UpdateMode.Once,
        HandleInputLocally = false,
        Size = actual,
        Size2DOverride = new Vector2I(overW, overH),
        Size2DOverrideStretch = true,
        UseHdr2D = false,
    };

    // Clone `buildOrder` (pre-order) into `viewport`: baked ids fully Apply + record for suppression; carriers get
    // ApplyLight + self-paint suppression (structural scaffolding only). Every cloned id joins the host `watch`.
    private void BuildCloneTree(
        SubViewport viewport, IReadOnlyList<string> buildOrder, IReadOnlyList<string> bakedIds, RenderContext ctx,
        List<string> outBaked, List<string> outCarriers, HashSet<string> watch,
        Dictionary<string, (Vector2 Offset, double Width)> bakedSpread)
    {
        var bakedSet = new HashSet<string>(bakedIds, System.StringComparer.Ordinal);
        var cloneByParent = new Dictionary<string, MirrorNodeView>(System.StringComparer.Ordinal);

        foreach (var id in buildOrder)
        {
            if (!_store.State.Nodes.TryGetValue(id, out var node) || !_reconciler.TryGetView(id, out var liveView))
            {
                continue; // defensive: the plan was computed against this exact state
            }

            Node parent = node.ParentId is { } pid && cloneByParent.TryGetValue(pid, out var pc)
                ? pc
                : viewport;

            // IsStaticBakeClone (distinct from CardLayer's IsBakeClone) routes an Add-blend member's material to the
            // alpha-preserving variant (MaterialResolver / ShaderAttachment) so it composites as a TRUE add in-region.
            var clone = new MirrorNodeView(id) { IsBakeClone = true, IsStaticBakeClone = true };
            parent.AddChild(clone);
            clone.SpreadOffset = liveView.SpreadOffset;
            clone.SpreadWidth = liveView.SpreadWidth;
            bakedSpread[id] = (liveView.SpreadOffset, liveView.SpreadWidth); // round 3 spread fix (ii) snapshot

            if (bakedSet.Contains(id))
            {
                if (node.ShaderId is not null)
                {
                    ShaderAttachment.SeedCloneParams(clone, liveView);
                }

                clone.Apply(node, liveView.StreamedLocal, ctx);
                outBaked.Add(id);
            }
            else
            {
                clone.ApplyLight(node, liveView.StreamedLocal);
                clone.SetSelfPaintBaked(true);
                outCarriers.Add(id);
            }

            watch.Add(id);
            cloneByParent[id] = clone;
        }
    }

    // Swap ONE Building host to Active: freeze its viewport, show its quad, suppress its baked originals' self-paint so
    // they don't double-draw under the quad.
    private void SwapHostToActive(RegionHost host)
    {
        host.Viewport.RenderTargetUpdateMode = SubViewport.UpdateMode.Disabled;
        host.Quad.Show();
        host.Quad.QueueRedraw();

        foreach (var id in host.BakedIds)
        {
            SuppressOriginal(id);
        }

        host.State = RegionHostState.Active;
    }

    // All Building hosts have swapped this frame → reconcile the live-band z overrides against the pending plan and
    // settle to Active. A partial re-bake re-levels only the released painters here; the untouched lower overrides are
    // idempotent.
    private void FinishBaking()
    {
        ApplyLiveZ(_pendingLiveZ);
        _state = BakeState.Active;
        BuildTotal++;
        RenderActivity.Mark();
    }

    private void SuppressOriginal(string id)
    {
        if (_reconciler.TryGetView(id, out var view) && GodotObject.IsInstanceValid(view))
        {
            view.SetSelfPaintBaked(true);
        }
    }

    // Reconcile the applied live-band absolute-z overrides to `target`: clear any applied id no longer present, then
    // set/refresh every target id whose applied z differs. Keeps the untouched (lower) overrides stable across a
    // partial re-bake.
    private void ApplyLiveZ(IReadOnlyList<LiveZOverride> target)
    {
        var wanted = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var lz in target)
        {
            wanted.Add(lz.Id);
        }

        if (_liveZApplied.Count > 0)
        {
            List<string>? drop = null;
            foreach (var id in _liveZApplied.Keys)
            {
                if (!wanted.Contains(id))
                {
                    (drop ??= new List<string>()).Add(id);
                }
            }

            if (drop is not null)
            {
                foreach (var id in drop)
                {
                    ClearLiveZ(id);
                }
            }
        }

        foreach (var lz in target)
        {
            if (!_liveZApplied.TryGetValue(lz.Id, out var z) || z != lz.Z)
            {
                if (_reconciler.TryGetView(lz.Id, out var view) && GodotObject.IsInstanceValid(view))
                {
                    view.SetZOverride(lz.Z);
                }

                _liveZApplied[lz.Id] = lz.Z;
            }
        }
    }

    private void ClearLiveZ(string id)
    {
        if (_reconciler.TryGetView(id, out var view) && GodotObject.IsInstanceValid(view))
        {
            view.ClearZOverride();
        }

        _liveZApplied.Remove(id);
    }

    // Track-P3c partial teardown: release every host whose mix quad sits at or above `cutZ` (the touched region + the
    // band drawn above it) and every live-band override at or above `cutZ`. Un-suppressed originals fall back to their
    // natural bucket z, which is ABOVE the surviving lower quads (position-stable z < bucketZ) → the composite stays
    // correct during the gap, byte-for-byte, until the released top-suffix re-bakes.
    private void ReleaseTopSuffix(int cutZ)
    {
        for (int i = _hosts.Count - 1; i >= 0; i--)
        {
            var host = _hosts[i];
            if (host.MixQuadZ >= cutZ)
            {
                UnsuppressHost(host);
                FreeHost(host);
                _hosts.RemoveAt(i);
            }
        }

        if (_liveZApplied.Count > 0)
        {
            List<string>? drop = null;
            foreach (var (id, z) in _liveZApplied)
            {
                if (z >= cutZ)
                {
                    (drop ??= new List<string>()).Add(id);
                }
            }

            if (drop is not null)
            {
                foreach (var id in drop)
                {
                    ClearLiveZ(id);
                }
            }
        }
    }

    // ---- WS-BGBAKE round 3: double-buffered teardown ------------------------------------------------------------

    private bool HasStaleHosts
    {
        get
        {
            foreach (var host in _hosts)
            {
                if (host.State == RegionHostState.StaleShown)
                {
                    return true;
                }
            }

            return false;
        }
    }

    // Retain-class invalidation for a live band bake: keep the affected quads SHOWN (originals stay suppressed) and
    // re-plan alongside — the raw scene is never exposed. cutZ scopes like ReleaseTopSuffix (int.MinValue = whole
    // band); hosts below the cut stay Active (the reconciling build keeps them by signature). Pacing mirrors the
    // Entering Rebaking arms the cooldown once; further retain hits while already Rebaking mark more
    // hosts stale but do NOT extend the cooldown or the stale bound.
    private void BandRetainTeardown(int cutZ)
    {
        bool wasRebaking = _state == BakeState.Rebaking;
        for (int i = _hosts.Count - 1; i >= 0; i--)
        {
            var host = _hosts[i];
            if (host.MixQuadZ < cutZ && cutZ != int.MinValue)
            {
                continue;
            }

            if (host.State == RegionHostState.Building)
            {
                // Never shown, originals never suppressed — an invisible sync drop.
                FreeHost(host);
                _hosts.RemoveAt(i);
            }
            else if (host.State == RegionHostState.Active)
            {
                host.State = RegionHostState.StaleShown;
            }
        }

        // Degenerate retain: nothing is SHOWN any more (e.g. a culprit hit while every host in scope was still
        // Building — all sync-freed above). "Rebaking" would then keep the KEPT live-z overrides re-leveling live
        // painters with no quads under them (a wrong picture over the raw scene) and dodge every clear path — the
        // exact wedge the residency gate caught (Idle rg=0 lz≠0, unbaked frames counting). Nothing baked is visible,
        // so a full DROP is both invisible-neutral and correct.
        bool anyShown = false;
        foreach (var host in _hosts)
        {
            if (host.State is RegionHostState.Active or RegionHostState.StaleShown)
            {
                anyShown = true;
                break;
            }
        }

        if (!anyShown)
        {
            InvalidateAllRegions();
            return;
        }

        // Live-band z overrides are KEPT — the re-leveled live painters keep compositing between the stale quads;
        // SwapGeneration reconciles them against the replacement plan.
        if (!wasRebaking)
        {
            _staleFrames = 0;
            _cooldownRemaining = CooldownFrames;
        }

        _state = BakeState.Rebaking;
        _framesSinceEval = 0;
        RenderActivity.Mark();
    }

    // The atomic generation flip, all in ONE frame: swap every Building host in (freeze viewport, show quad,
    // suppress originals), un-suppress ONLY the stale baked ids the new generation does not cover, free the stale
    // hosts, reconcile the live-z overrides. The composite goes old-bake → new-bake with no raw-scene frame between.
    private void SwapGeneration()
    {
        foreach (var host in _hosts)
        {
            if (host.State == RegionHostState.Building)
            {
                SwapHostToActive(host);
            }
        }

        var newBaked = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var host in _hosts)
        {
            if (host.State == RegionHostState.Active)
            {
                foreach (var id in host.BakedSet)
                {
                    newBaked.Add(id);
                }
            }
        }

        for (int i = _hosts.Count - 1; i >= 0; i--)
        {
            var host = _hosts[i];
            if (host.State != RegionHostState.StaleShown)
            {
                continue;
            }

            foreach (var id in host.BakedIds)
            {
                if (!newBaked.Contains(id) && _reconciler.TryGetView(id, out var view) && GodotObject.IsInstanceValid(view))
                {
                    view.SetSelfPaintBaked(false);
                }
            }

            FreeHost(host);
            _hosts.RemoveAt(i);
        }

        ApplyLiveZ(_pendingLiveZ);
        _state = _hosts.Count > 0 ? BakeState.Active : BakeState.Idle;
        int staleCovered = _staleFrames;
        _staleFrames = 0;
        BuildTotal++;
        GenSwapTotal++;
        RenderActivity.Mark();
        GD.Print($"M3_BAKE_SWAP: gen={GenSwapTotal} hosts={_hosts.Count} nodes={BakedNodeCount} " +
                 $"staleCoveredFrames={staleCovered} drops={StaleDropTotal} kfSurvive={KeyframeSurviveTotal}");
    }

    // The stale generation outlived its bound (or the mode flipped mid-rebake): un-suppress whatever the live
    // hosts don't cover, free the stale hosts, and fall back to the raw scene for the remainder of the re-plan.
    private void HardDropStale()
    {
        var stillBaked = new HashSet<string>(System.StringComparer.Ordinal);
        foreach (var host in _hosts)
        {
            if (host.State == RegionHostState.Active)
            {
                foreach (var id in host.BakedSet)
                {
                    stillBaked.Add(id);
                }
            }
        }

        bool dropped = false;
        for (int i = _hosts.Count - 1; i >= 0; i--)
        {
            var host = _hosts[i];
            if (host.State != RegionHostState.StaleShown)
            {
                continue;
            }

            foreach (var id in host.BakedIds)
            {
                if (!stillBaked.Contains(id) && _reconciler.TryGetView(id, out var view) && GodotObject.IsInstanceValid(view))
                {
                    view.SetSelfPaintBaked(false);
                }
            }

            FreeHost(host);
            _hosts.RemoveAt(i);
            dropped = true;
        }

        if (dropped)
        {
            StaleDropTotal++;
            GD.Print($"M3_BAKE_SWAP: HARD-DROP staleFrames={_staleFrames} liveHosts={_hosts.Count} " +
                     $"drops={StaleDropTotal} gen={GenSwapTotal}");
        }

        if (_hosts.Count == 0)
        {
            // Nothing shown any more — clear the live-band overrides (full-teardown parity) and re-plan from Idle.
            // A hard drop to raw is a DELIBERATE bounded-staleness give-up: it re-opens the residency window (its
            // own StaleDropTotal counter tracks the event; the unbaked gate stays scoped to the retain-path promise).
            if (_liveZApplied.Count > 0)
            {
                var ids = new List<string>(_liveZApplied.Keys);
                foreach (var id in ids)
                {
                    ClearLiveZ(id);
                }
            }

            _bandShownThisRoom = false;
            if (_state == BakeState.Rebaking)
            {
                _state = BakeState.Idle;
            }
        }

        _staleFrames = 0;
        RenderActivity.Mark();
    }

    // Full teardown: un-suppress every baked original + clear every live-band override (so the live tree shows current
    // pixels — never a stale bake), free every host, enter the cooldown. Idempotent from any state.
    private void ClearRegions()
    {
        foreach (var host in _hosts)
        {
            UnsuppressHost(host);
            FreeHost(host);
        }

        _hosts.Clear();

        if (_liveZApplied.Count > 0)
        {
            var ids = new List<string>(_liveZApplied.Keys);
            foreach (var id in ids)
            {
                ClearLiveZ(id);
            }
        }

        _pendingLiveZ = System.Array.Empty<LiveZOverride>();
        _activeBandIds = null; // WS-BGBAKE: nothing baked ⇒ no band identity to guard (a re-plan re-records it)
        _activeExcludedRoots = null;
    }

    private void UnsuppressHost(RegionHost host)
    {
        foreach (var id in host.BakedIds)
        {
            if (_reconciler.TryGetView(id, out var view) && GodotObject.IsInstanceValid(view))
            {
                view.SetSelfPaintBaked(false);
            }
        }
    }

    // Free a host's Godot nodes (viewport clone tree + quad). Plain Free() — NEVER ResetForPool (a clone shares the
    // live node's id). Freeing a viewport cascades to its clone descendants.
    private static void FreeHost(RegionHost host)
    {
        if (GodotObject.IsInstanceValid(host.Quad))
        {
            host.Quad.Free();
        }

        if (GodotObject.IsInstanceValid(host.Viewport))
        {
            host.Viewport.Free();
        }
    }

    // A deterministic identity for a planned region: its member sequence + quad z. Two plans that produce the same
    // region yield the same signature → the reconciling build keeps the live host (position-stable z).
    private static string SignatureOf(StaticBakeRegion r)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(r.QuadZ).Append('|');
        foreach (var id in r.BakedIds)
        {
            sb.Append(id).Append(',');
        }

        return sb.ToString();
    }

    // ---- reconciler hooks --------------------------------------------------------------------------------------

    // Tail-called from SceneReconciler.OnDrained AFTER RunCull. Advances the planner's stability bookkeeping, then —
    // if a bake is live — invalidates it when this drain touched the baked prefix (keyframe / order change /
    // changed-id ∩ prefix / hint-target ∩ prefix). The changed-ids that hit the prefix are also registered with the
    // planner's thrash guard so a repeat offender gets benched.
    public void OnDrained(MirrorStore.DrainInfo info)
    {
        if (_state == BakeState.Disabled)
        {
            return;
        }

        _hintTargets.Clear();
        foreach (var h in info.Hints)
        {
            _hintTargets.Add(h.TargetId);
        }

        _planner.ObserveDrain(_store.State, info.ChangedIds, _hintTargets, info.Keyframe);

        if (_state is not (BakeState.Active or BakeState.Baking or BakeState.Rebaking))
        {
            return;
        }

        // Structural facts first (keyframe / order change). An EXACT-path plan keeps the unconditional teardown
        // (its prefix depends on the WHOLE order). A BAND plan asks the residency machine: a keyframe whose band
        // prefix AND watched content are unchanged SURVIVES outright (loop restart / resync = zero visible change;
        // requires the KEYDIFF reconcile path — a FullRebuild resets the suppress bits + z overrides); band intact
        // but watched content touched ⇒ invisible retain-class rebake; band structure changed ⇒ drop. An
        // OrderChanged drain whose PROJECTED band prefix is untouched proceeds to the watch scan (combat streams ~7
        // reshuffles/s that only touch the z≥0 world / excluded subtrees). Applies to Baking/Active/Rebaking alike.
        if (info.Keyframe || info.OrderChanged)
        {
            if (!BandPlanActive || _activeBandIds is not { } bandIds)
            {
                InvalidateAllRegions();
                return;
            }

            var sv = _residency.EvaluateStructure(
                _store.State, info.Keyframe, info.OrderChanged, bandIds, _activeExcludedRoots,
                keyframeSurvivalSupported: !_reconciler.LastDrainFullRebuilt,
                isWatched: IsWatchedAnywhere);
            switch (sv)
            {
                case BandResidencyMachine.StructureVerdict.KeyframeSurvive:
                    KeyframeSurviveTotal++;
                    return; // the bake stands untouched — and NO watch scan (ChangedIds is all-ids on a keyframe)

                case BandResidencyMachine.StructureVerdict.KeyframeRetain:
                    RebakeTotal++;
                    BandRetainTeardown(int.MinValue);

                    return;

                case BandResidencyMachine.StructureVerdict.KeyframeDrop:
                    InvalidateAllRegions(); // a real room change (or FullRebuild reset the bits) — raw scene is correct
                    return;

                case BandResidencyMachine.StructureVerdict.Teardown:
                    // Retain-class: the band moved — rebake invisibly behind the stale quads (double buffer), or
                    // immediate teardown for an exact-plan host.
                    BandRetainTeardown(int.MinValue);

                    return;

                case BandResidencyMachine.StructureVerdict.ProceedOrderSkipped:
                    OrderSkipTotal++;
                    break;
            }
        }

        // Per-region watch: a changed/hint-target id that clones into some region (baked ∪ carriers, mix or add — a
        // carrier's transform/modulate change moves the band it scaffolds just as a baked node's own change does).
        // LIVE re-leveled painters are NOT watched — they draw live; only their z-order (an OrderChange) matters.
        _invalidationCulprits.Clear();
        int cutZ = int.MaxValue;
        foreach (var id in info.ChangedIds)
        {
            int z = LowestTouchedRegionZ(id);
            if (z != int.MaxValue)
            {
                _invalidationCulprits.Add(id);
                if (z < cutZ)
                {
                    cutZ = z;
                }
            }
        }

        _hintCulprits.Clear();
        foreach (var t in _hintTargets)
        {
            int z = LowestTouchedRegionZ(t);
            if (z != int.MaxValue)
            {
                _hintCulprits.Add(t);
                if (z < cutZ)
                {
                    cutZ = z; // an armed tween target on a baked/carrier clone will move it → release from there up
                }
            }
        }

        if (cutZ == int.MaxValue)
        {
            return; // nothing baked touched → the active bake stands
        }

        // WS-BGBAKE band drain decision — the residency machine classifies the culprits (BandInvalidationPolicy)
        // AND owns the bench registrations (member room-bench + non-spine-carrier subtree bench), so a teardown can
        // never skip the learning strikes: (a) screen shake / scene slide = Transform-only spine-carrier moves →
        // FOLLOW (retransform the quads); (b) baked-member culprits (the ~9s wave banner) → bench + teardown; (c)
        // anything unfollowable → subtree-bench (if a non-spine carrier) + teardown. Exact-path plans never enter.
        if (BandPlanActive)
        {
            var verdict = _residency.EvaluateCulprits(
                _invalidationCulprits, _hintCulprits,
                id => _store.State.ChangeFlags.TryGetValue(id, out var f) ? f : NodeChangeFlags.None,
                IsBakedMemberAnywhere,
                IsCommonSpineCarrier);

            if (verdict == BandResidencyMachine.CulpritVerdict.Survive)
            {
                return; // defensive — cutZ != MaxValue implies culprits, but never tear down on a Survive verdict
            }

            if (verdict == BandResidencyMachine.CulpritVerdict.Follow && TryApplyCarrierFollow())
            {
                CarrierFollowTotal++;
                return; // the bake stands, rigidly re-posed — no teardown, no cooldown
            }

            // Diagnostic sibling of M3_BAKE_INVALIDATE: which branch the classifier took (Follow here means
            // TryApplyCarrierFollow FAILED — anchor/global missing) plus the carrier/member split evidence.
            GD.Print($"M3_BAKE_DECISION: {verdict} bench={_residency.LastBenchIds.Count} " +
                $"subtreeBench={_residency.LastSubtreeBenchIds.Count} " +
                $"changed={_invalidationCulprits.Count} " +
                $"hints={_hintCulprits.Count} hosts={_hosts.Count} " +
                $"firstCulpritMember={(_invalidationCulprits.Count > 0 ? IsBakedMemberAnywhere(System.Linq.Enumerable.First(_invalidationCulprits)).ToString() : "-")} " +
                $"firstCulpritSpine={(_invalidationCulprits.Count > 0 ? IsCommonSpineCarrier(System.Linq.Enumerable.First(_invalidationCulprits)).ToString() : "-")}");
        }

        if (_invalidationCulprits.Count > 0)
        {
            _planner.RegisterInvalidation(_invalidationCulprits); // bench repeat offenders (thrash guard)
        }

        RebakeTotal++;
        LogInvalidation(cutZ);

        // Band plans retain the released suffix while rebuilding it behind the shown generation.
        if (BandPlanActive)
        {
            BandRetainTeardown(cutZ);
            return;
        }

        // Release the touched region + the band above it (position-stable z keeps the lower regions' z fixed), then
        // re-eval to re-bake the released top-suffix. The kept lower hosts stay Active (shown) across the gap.
        ReleaseTopSuffix(cutZ);
        _state = BakeState.Idle;
        _cooldownRemaining = CooldownFrames;
        _framesSinceEval = 0;
        RenderActivity.Mark();
    }

    // Rebake culprit diagnostics: which watched ids this drain touched (with node type/name from the wire) — the data
    // every bake-thrash investigation needs first. Fires only on an actual invalidation (~well under 1/s), capped at
    // 6 ids per line.
    private void LogInvalidation(int cutZ)
    {
        var sb = new System.Text.StringBuilder(160);
        sb.Append("M3_BAKE_INVALIDATE: cut=").Append(cutZ).Append(" culprits=");
        int shown = 0;
        foreach (var id in _invalidationCulprits)
        {
            if (shown++ == 6)
            {
                sb.Append(" +").Append(_invalidationCulprits.Count - 6).Append(" more");
                break;
            }

            _store.State.Nodes.TryGetValue(id, out var node);
            _store.State.ChangeFlags.TryGetValue(id, out var flags);
            sb.Append(shown > 1 ? " " : "").Append(id).Append('(').Append(node?.NodeType ?? "?")
                .Append('|').Append(flags).Append(')');
        }

        foreach (var t in _hintTargets)
        {
            if (LowestTouchedRegionZ(t) != int.MaxValue)
            {
                sb.Append(" hint=").Append(t);
            }
        }

        GD.Print(sb.ToString());
    }

    // The mix quad z of the LOWEST-z host that clones `id` (baked or carrier, mix or add partition), or int.MaxValue if
    // no host clones it. A shared carrier belongs to several hosts → the lowest wins (release from the deepest).
    private int LowestTouchedRegionZ(string id)
    {
        int z = int.MaxValue;
        foreach (var host in _hosts)
        {
            if (host.Watch.Contains(id) && host.MixQuadZ < z)
            {
                z = host.MixQuadZ;
            }
        }

        return z;
    }

    // ---- WS-BGBAKE carrier follow (drain-path classification lookups + the quad retransform) --------------------

    // Cloned into ANY host (baked or carrier — the keyframe-survival content check: a keyframe change to a watched
    // id means the shown quads no longer match the scene).
    private bool IsWatchedAnywhere(string id)
    {
        foreach (var host in _hosts)
        {
            if (host.Watch.Contains(id))
            {
                return true;
            }
        }

        return false;
    }

    // Baked member of ANY host (vs a carrier — the policy split; an id can be baked in one region while cloning as
    // a carrier of another, and its pixels are baked, so member wins).
    private bool IsBakedMemberAnywhere(string id)
    {
        foreach (var host in _hosts)
        {
            if (host.BakedSet.Contains(id))
            {
                return true;
            }
        }

        return false;
    }

    // Follow-eligible carrier: a spine carrier of EVERY host (an ancestor of ALL baked members in ALL regions — the
    // band's root container chain). Anything scoped to only one region can't be followed by a whole-quad transform.
    private bool IsCommonSpineCarrier(string id)
    {
        if (_hosts.Count == 0)
        {
            return false;
        }

        foreach (var host in _hosts)
        {
            if (!host.SpineCarriers.Contains(id))
            {
                return false;
            }
        }

        return true;
    }

    // Retransform every region quad by its host's rendered follow delta — the rigid
    // motion the changed spine carriers applied to the whole baked content. Validate-then-apply (all hosts must
    // have a usable anchor; a missing global falls back to the caller's teardown — never a half-followed band).
    // Per-host anchors keep a partial rebake correct: a host rebuilt mid-shake snapshots the DISPLACED pose, so its
    // own delta is identity now and rigid again once the carrier moves. Applies to Building hosts too (their quad
    // is still hidden — the transform is simply in place at swap).
    private bool TryApplyCarrierFollow()
    {
        var deltas = new Transform2D[_hosts.Count];
        for (int i = 0; i < _hosts.Count; i++)
        {
            var host = _hosts[i];
            if (host.AnchorId is null
                || host.AnchorBakedRenderedInverse is not { } bakedInv
                || !_reconciler.TryGetView(host.AnchorId, out var anchorView)
                || !GodotObject.IsInstanceValid(anchorView))
            {
                return false;
            }

            // Rendered-space delta: current rendered global × baked rendered inverse. FoldCosmetic already folds
            // the SpreadOffset channel into the view transform, so a widescreen shake follows without drift.
            deltas[i] = anchorView.GlobalTransform * bakedInv;

        }

        for (int i = 0; i < _hosts.Count; i++)
        {
            _hosts[i].Quad.Transform = deltas[i];
        }

        RenderActivity.Mark(); // the quads moved — the stage must render this
        return true;
    }

    // Full teardown of the whole bake (keyframe / order change / per-region lever off), then cooldown + re-plan.
    private void InvalidateAllRegions()
    {
        // Every drop-class transition deliberately exposes the raw scene (room or mode change) —
        // it opens a fresh residency window, so the UnbakedVisibleFrames gate measures only the RETAIN-path
        // guarantees (the double buffer's "never flash raw mid-room" promise).
        _bandShownThisRoom = false;
        ClearRegions();
        _state = BakeState.Idle;
        _cooldownRemaining = CooldownFrames;
        RenderActivity.Mark();
    }

    // Force a full teardown from an out-of-band change with no drain to inspect: a bare spread-factor relayout
    // (OnSpreadChanged), an effect-mode flip (RefreshEffects re-Applies every view — re-showing suppressed text), or a
    // design-width change. The whole baked geometry may have moved, so drop it and re-plan from scratch.
    public void InvalidateAll()
    {
        if (_state == BakeState.Disabled)
        {
            return;
        }

        if (_hosts.Count > 0 || _state is BakeState.Active or BakeState.Baking or BakeState.Rebaking)
        {
            RebakeTotal++;
            InvalidateAllRegions();
        }
    }

    // ---- region host + composite quad --------------------------------------------------------------------------

    private enum RegionHostState
    {
        Building,   // clones built, viewport(s) rendering Once, originals still live, quad(s) hidden
        Active,     // quad(s) shown, originals suppressed
        StaleShown, // round 3: a retained OLD-generation host — quad still shown, originals still suppressed,
                    // excluded from signature matching; freed atomically at SwapGeneration (or HardDropStale)
    }

    // A baked region: its offscreen bake viewport + composite quad. WS-ADDBAKE bakes Add members into the SAME viewport
    // (alpha-preserving variant) — no separate add partition. Carries the per-region invalidation watch (every cloned
    // id), the quad z (the release cut key), and a signature for reconciling re-bakes.
    private sealed class RegionHost
    {
        public RegionHostState State;
        public int RenderWait;
        public int MixQuadZ;
        public string Signature = string.Empty;
        public SubViewport Viewport = null!;
        public BakeQuad Quad = null!;
        public readonly List<string> BakedIds = new();
        public readonly List<string> CarrierIds = new();
        public readonly HashSet<string> Watch = new(System.StringComparer.Ordinal);

        // WS-BGBAKE carrier follow: BakedIds as a set (member-vs-carrier culprit split on the drain path).
        // SpineCarriers = carriers that are ancestors of ALL of this host's baked members (the band root container
        // chain — a Transform-only change on one moves the whole baked content rigidly). The rendered anchor snapshot
        // keeps the baked pixels aligned with the live tree, including cosmetic spread offsets.
        public readonly HashSet<string> BakedSet = new(System.StringComparer.Ordinal);
        public readonly HashSet<string> SpineCarriers = new(System.StringComparer.Ordinal);
        public string? AnchorId;
        public Transform2D? AnchorBakedRenderedInverse; // round 3: the anchor VIEW's Godot GlobalTransform inverse at
                                                        // build — RENDERED space folds the SpreadOffset cosmetic
                                                        // channel, so widescreen shakes follow without drift

        // Round 3 spread fix (ii): the SpreadOffset/SpreadWidth each cloned id was baked with (recorded at
        // BuildCloneTree) — a steady-factor spread RE-STAMP invalidates only when a watched id's value really moved.
        public readonly Dictionary<string, (Vector2 Offset, double Width)> BakedSpread = new(System.StringComparer.Ordinal);
    }

    // One region's composite quad. A sibling of the StaticBake controller (so mounted before the reconciler for the
    // equal-effZ sort), it draws its region viewport's texture over the design rect at an ABSOLUTE effZ
    // (ZAsRelative=false) so multiple regions interleave with the re-leveled live band painters. Always PremultAlpha
    // ("over") — an add-only texel in the viewport is (rgb, 0) (WS-ADDBAKE alpha-preserving variant), so premult-over
    // IS a true add. NEAREST keeps the texture→stage copy exact at reduced render scales.
    public sealed partial class BakeQuad : Node2D
    {
        private SubViewport _viewport = null!;
        private double _designW;

        public void Init(SubViewport viewport, double designW, int absoluteZ, bool linearFilter = false)
        {
            _viewport = viewport;
            _designW = designW;
            Material = new CanvasItemMaterial { BlendMode = CanvasItemMaterial.BlendModeEnum.PremultAlpha };
            // NEAREST keeps a 1:1 texture→stage copy exact; a WS-BGBAKE reduced-scale bake up-samples, so it needs
            // Linear (Nearest would block up the minified texels).
            TextureFilter = linearFilter ? TextureFilterEnum.Linear : TextureFilterEnum.Nearest;
            ZAsRelative = false;
            ZIndex = absoluteZ;
            Visible = false; // shown at swap-to-Active once the Once render completed
        }

        public override void _Draw()
        {
            var tex = _viewport?.GetTexture();
            if (tex is null)
            {
                return;
            }

            DrawTextureRect(tex, new Rect2(0, 0, (float)_designW, StageStretch.DesignHeight), false);
        }
    }

    // ---- shot / telemetry --------------------------------------------------------------------------------------

    // The --shot settle gate ANDs this in: a scene-bearing recording waits for the bake to reach Active (so the ON
    // shot is provably non-vacuous), while a scene with nothing to bake settles as soon as an idle-asset eval found no
    // bakeable plan. Disabled → always settled (the OFF shot ignores the bake).
    public bool IsShotSettled =>
        _state == BakeState.Disabled || _state == BakeState.Active || (_state == BakeState.Idle && _evaluatedEmpty);

    // Machine-readable status for the M1C_SHOT line (proves the ON parity run actually baked ≥20 nodes). WS-ADDBAKE
    // adds shaderMode + the bake-enable source (env / settings) so a Dynamic-persisted device that bakes NOTHING for
    // combat is diagnosable (shaderMode=Dynamic ⇒ no shader cleared ⇒ combat band stays live).
    public string ShotStatus() =>
        $"bake[state={_state} regions={_hosts.Count} nodes={BakedNodeCount} carriers={CarrierNodeCount} " +
        $"liveZ={LiveZCount} builds={BuildTotal} rebakes={RebakeTotal} band={BandPlanActive} orderSkips={OrderSkipTotal} " +
        $"carrierFollows={CarrierFollowTotal} " +
        $"genSwaps={GenSwapTotal} staleDrops={StaleDropTotal} kfSurvive={KeyframeSurviveTotal} " +
        $"unbakedVisible={UnbakedVisibleFrames} " +
        $"shaderMode={ClientEffectSettings.ShaderMode} enable={_bakeEnableSource} addBake=true]";

    // One M3_BAKE_PLAN line whenever the plan OUTCOME changes (bakeable/not + the reject reason), so the eval cadence
    // doesn't spam it. Explains why a scene did or didn't bake and where the prefix ended.
    private BakeReject _lastLoggedReason = (BakeReject)(-1);

    private void LogPlan(StaticBakePlan plan)
    {
        var d = _planner.LastDiagnostic;
        if (d.BoundaryReason == _lastLoggedReason && plan.IsBakeable == (_lastLoggedReason == BakeReject.None))
        {
            return;
        }

        _lastLoggedReason = d.BoundaryReason;

        // Track-P: how many CLEARED shaders sample the screen (surfaced so a screen-read parity break is diagnosable).
        int screenReaders = 0;
        foreach (var id in _effectStaticOk)
        {
            if (_store.State.Nodes.TryGetValue(id, out var n) && n.ShaderId is { } sid && ShaderStore.PeekScreenReads(sid))
            {
                screenReaders++;
            }
        }

        int totalBaked = 0;
        foreach (var r in plan.Regions)
        {
            totalBaked += r.BakedIds.Count;
        }

        GD.Print($"M3_BAKE_PLAN: bakeable={plan.IsBakeable} band={BandPlanActive} regions={plan.Regions.Count} nodes={totalBaked} " +
                 $"liveZ={plan.LiveZ.Count} carriers={d.CarrierCount} bottomOnly={_bottomOnly.Count} " +
                 $"paint={d.PaintCount} coverage={d.Coverage:0} topQuadZ={d.QuadZ} minZ={d.MinZ} " +
                 $"staticShaders={d.StaticShaderCount} shaderOk={_effectStaticOk.Count} screenReaders={screenReaders} " +
                 $"addBake=true shaderMode={ClientEffectSettings.ShaderMode} " +
                 $"rawBoundary={d.RawBoundary} bandEnd={d.TrimmedBoundary} " +
                 $"boundaryId={d.BoundaryId ?? "<none>"} reason={d.BoundaryReason}");
    }
}
