// Track I — idle-animation suspend controller (the Node that drives IdleSuspend's static core).
//
// Mounted by AppShell alongside the render stage. Two jobs:
//   1. Detect idle: a 0.25s-cadence poll — now − LastDrainMs ≥ N && now − LastInputMs ≥ N && no live tween && !Hold —
//      then Freeze() sweeps every live view and suspends each continuous animator per category. ContinuousCount then
//      falls to 0 and the per-frame Marks stop, so AppShell's EXISTING UpdateRenderStageActivity reaches its
//      heartbeat/Disabled path with no new render logic here.
//   2. Wake on every seam that means "something visible is about to change", ALWAYS resuming BEFORE the change lands:
//        * a store drain (OnDrained) — subscribed BEFORE the reconciler (AppShell calls SubscribeEarly before
//          _reconciler.Bind), so Resume runs FIRST in the drain callstack and the reconciler then reconciles onto
//          already-resumed effects (wake-then-apply; DEBUG-asserted against the reconciler's LastReconciledRevision).
//        * real/QA input (LastInputMs advanced past the suspend start) — checked every _Process for same-frame wake.
//        * an effect-mode flip (ClientEffectSettings.Generation) — polled here at ProcessPriority −100 so it resumes
//          BEFORE the reconciler's own effect-gen poll (priority 0) fires the global RefreshEffects.
//        * a wide-screen relayout (OnSpreadChanged) and the --shot Hold.
//
// Frozen-node retention: per-category lists of the suspended views, resumed idempotently from any wake seam with
// IsInstanceValid guards. Safe because pool release only happens inside a drain, and a drain wakes (resumes) first.

using System.Collections.Generic;
using CouchCoop.GodotClient.Scene.Effects;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class IdleSuspendController : Node
{
    private const double PollCadenceSec = 0.25;

    // Track I late-arrival fix: while suspended, re-sweep on this low cadence to freeze+enroll any latecomer effect
    // (async mount / loop-reset burst) that registered continuous after the one-shot freeze. Cheap — sweeps only when
    // suspended (a bounded live-view walk once every ~2s), and only actually toggles the handful of new views.
    private const double ReSweepCadenceSec = 2.0;

    // The single live controller. Attachments are static and cannot hold a handle, so a late Configure/Sync that
    // self-freezes a view enrolls it here (EnrollLateFrozen) — that keeps the controller's frozen sets complete so a
    // real wake resumes the latecomer too (not just the views frozen at the one-shot sweep).
    private static IdleSuspendController? _current;

    // Which per-category frozen set an attachment late-enrollment belongs to.
    public enum LateCategory
    {
        Cosmetic,
        Intent,
        Spine,
        Particles,
        Shaders,
    }

    private SceneReconciler? _reconciler;
    private MirrorStore? _store;
    private CardLayer? _cardLayer; // Track I: card clones live outside the reconciler's _views (see FreezeSweep)
    private bool _subscribed;

    // The views suspended per category. HashSet (not List): dedups the initial sweep, the low-cadence re-sweep AND the
    // attachment late-enrollment, and lets the re-sweep skip already-frozen views cheaply. Resumed idempotently.
    private readonly HashSet<MirrorNodeView> _frozenCosmetic = new();
    private readonly HashSet<MirrorNodeView> _frozenIntent = new();
    private readonly HashSet<MirrorNodeView> _frozenSpine = new();
    private readonly HashSet<MirrorNodeView> _frozenParticles = new();
    private readonly HashSet<MirrorNodeView> _frozenShaders = new();

    private int _appliedEffectGen = ClientEffectSettings.Generation;
    private double _sincePoll;
    private double _sinceReSweep; // time since the last suspended re-sweep (reset at Freeze + each re-sweep)
    private long _skippedAtSuspend; // RenderActivity.SkippedFrames snapshot at the last Freeze (for skippedDuring)

    public IdleSuspendController()
    {
        // Run before the reconciler's _Process (its effect-gen poll → RefreshEffects) so an effect-mode flip resumes
        // FIRST. Lower priority = processed earlier in Godot.
        ProcessPriority = -100;
    }

    // Attachment late-enrollment (static → the single live controller). A late Configure/Sync that self-froze a view
    // while the controller was suspended records it here so Resume covers it. HashSet.Add dedups; the Suspended guard
    // drops a stray call after a wake.
    public static void EnrollLateFrozen(MirrorNodeView view, LateCategory cat) => _current?.EnrollInstance(view, cat);

    private void EnrollInstance(MirrorNodeView view, LateCategory cat)
    {
        if (!IdleSuspend.Suspended)
        {
            return;
        }

        switch (cat)
        {
            case LateCategory.Cosmetic: _frozenCosmetic.Add(view); break;
            case LateCategory.Intent: _frozenIntent.Add(view); break;
            case LateCategory.Spine: _frozenSpine.Add(view); break;
            case LateCategory.Particles: _frozenParticles.Add(view); break;
            case LateCategory.Shaders: _frozenShaders.Add(view); break;
        }
    }

    // Subscribe to the store's Drained + SpreadChanged BEFORE the reconciler binds (AppShell calls this before
    // _reconciler.Bind), so a resume runs strictly BEFORE the reconciler's OnDrained in the same callstack.
    public void SubscribeEarly(MirrorStore store)
    {
        if (_subscribed)
        {
            return;
        }

        _store = store;
        store.Drained += OnDrained;
        store.SpreadChanged += OnSpreadChanged;
        _subscribed = true;
    }

    // Bind the reconciler + store handles (called AFTER the reconciler exists).
    public void Bind(SceneReconciler reconciler, MirrorStore store)
    {
        _reconciler = reconciler;
        _store = store;
    }

    // Wire the CardLayer (created AFTER this controller in AppShell.MountRenderStack). Its promoted/parked card clones
    // live outside the reconciler's _views; the freeze/resume sweep covers them too so their shaders don't pin the stage.
    public void SetCardLayer(CardLayer cardLayer) => _cardLayer = cardLayer;

    public override void _Ready()
    {
        _current = this; // publish for attachment late-enrollment (one controller per mounted stack)

        // Start the idle clocks at mount so a fresh stack doesn't count pre-connection wall-time as idle.
        double now = Time.GetTicksMsec();
        IdleSuspend.LastInputMs = now;
        IdleSuspend.LastDrainMs = now;
    }

    public override void _ExitTree()
    {
        if (_current == this)
        {
            _current = null;
        }

        if (_subscribed && _store is not null)
        {
            _store.Drained -= OnDrained;
            _store.SpreadChanged -= OnSpreadChanged;
            _subscribed = false;
        }
    }

    // A drain arrived. Stamp the idle clock and — wake-then-apply — resume BEFORE the reconciler reconciles this drain.
    private void OnDrained(MirrorStore.DrainInfo info)
    {
        IdleSuspend.LastDrainMs = Time.GetTicksMsec();

        if (!IdleSuspend.Suspended)
        {
            return;
        }

        // DEBUG proof of wake-then-apply: the reconciler subscribed AFTER us, so it has NOT yet reconciled this drain
        // (its LastReconciledRevision still holds the previous drain's value).
        System.Diagnostics.Debug.Assert(
            _reconciler is null || _reconciler.LastReconciledRevision != info.Revision,
            "IdleSuspend resume must run BEFORE the reconciler reconciles this drain (wake-then-apply)");

        Resume("drain");
    }

    private void OnSpreadChanged()
    {
        if (IdleSuspend.Suspended)
        {
            Resume("spread");
        }
    }

    public override void _Process(double delta)
    {
        // Effect-mode flip wake (before the reconciler's own effect-gen poll via ProcessPriority −100).
        int gen = ClientEffectSettings.Generation;
        if (gen != _appliedEffectGen)
        {
            _appliedEffectGen = gen;
            if (IdleSuspend.Suspended)
            {
                Resume("effectgen");
            }
        }

        // Same-frame input wake: NotifyInput advanced LastInputMs past the suspend start.
        if (IdleSuspend.Suspended && IdleSuspend.LastInputMs > IdleSuspend.SuspendStartMs)
        {
            Resume("input");
        }

        // Hold (the --shot capture-settle) resumes immediately and blocks any suspend while held.
        if (IdleSuspend.Hold)
        {
            if (IdleSuspend.Suspended)
            {
                Resume("hold");
            }

            return;
        }

        _sincePoll += delta;
        if (_sincePoll < PollCadenceSec)
        {
            return;
        }

        double pollDelta = _sincePoll;
        _sincePoll = 0;

        if (_reconciler is null)
        {
            return; // nothing to sweep without a reconciler
        }

        if (IdleSuspend.Suspended)
        {
            // Stay suspended until a wake seam, but keep the frozen set complete: re-sweep any latecomer that
            // registered continuous after the one-shot Freeze (async mount / loop reset).
            RunSuspendedMaintenance(pollDelta);
            return;
        }

        double now = Time.GetTicksMsec();
        double idleMs = IdleSuspend.IdleSeconds * 1000.0;
        bool idle = (now - IdleSuspend.LastDrainMs) >= idleMs
                    && (now - IdleSuspend.LastInputMs) >= idleMs
                    && TweenReplayer.ActiveCount == 0
                    && !IdleSuspend.Hold;
        if (idle)
        {
            Freeze();
        }
    }

    private void Freeze()
    {
        int continuousBefore = RenderActivity.ContinuousCount;
        var (anim, intent, spine, particles, shaders) = FreezeSweep();

        IdleSuspend.RecordSuspended();
        _skippedAtSuspend = RenderActivity.SkippedFrames;
        _sinceReSweep = 0;

        GD.Print($"M3_IDLE: suspended idleSec={IdleSuspend.IdleSeconds:0.#} anim={anim} intent={intent} " +
                 $"spine={spine} particles={particles} shaders={shaders} " +
                 $"continuousBefore={continuousBefore} after={RenderActivity.ContinuousCount} " +
                 $"byCat[particle={RenderActivity.ContinuousParticle} shader={RenderActivity.ContinuousShader}]");
    }

    // The per-category freeze sweep, shared by the initial Freeze and the low-cadence re-sweep. A per-set Contains
    // guard means a view already frozen is skipped (so the counts are NEWLY-frozen views and the re-sweep is idempotent
    // even though the attachments' SetSuspended returns true whenever the child exists). Returns the newly-frozen count
    // per category.
    private (int anim, int intent, int spine, int particles, int shaders) FreezeSweep()
    {
        var c = new int[5]; // [0]=anim [1]=intent [2]=spine [3]=particles [4]=shaders

        void SweepView(MirrorNodeView view)
        {
            if (!_frozenCosmetic.Contains(view) && view.HasAnimChild
                && CosmeticAnimator.SetSuspended(view, true))
            {
                _frozenCosmetic.Add(view);
                c[0]++;
            }

            if (!_frozenIntent.Contains(view) && view.HasIntentChild
                && IntentPlayer.SetSuspended(view, true))
            {
                _frozenIntent.Add(view);
                c[1]++;
            }

            if (!_frozenSpine.Contains(view) && view.HasSpineChild
                && SpineAttachment.SetSuspended(view, true))
            {
                _frozenSpine.Add(view);
                c[2]++;
            }

            if (!_frozenParticles.Contains(view) && view.HasParticleChild
                && ParticleAttachment.SetSuspended(view, true))
            {
                _frozenParticles.Add(view);
                c[3]++;
            }

            // Shaders have no MirrorNodeView presence flag (per-view material, not a child node); SetSuspended acts
            // only on a view whose shader is a live animating Dynamic material and returns false otherwise, so this is
            // a cheap ConditionalWeakTable probe per view.
            if (!_frozenShaders.Contains(view)
                && ShaderAttachment.SetSuspended(view, true))
            {
                _frozenShaders.Add(view);
                c[4]++;
            }
        }

        _reconciler!.ForEachLiveView(SweepView);

        // ALSO sweep the CardLayer's promoted/parked card clones — they live outside the reconciler's _views, and at
        // Half/Quarter (where CardLayer is active) their card-face shaders held the residual continuous that pinned the
        // stage awake on device. Same per-category freeze; the frozen sets dedup, and Resume covers them via the sets.
        _cardLayer?.ForEachCloneView(SweepView);

        return (c[0], c[1], c[2], c[3], c[4]);
    }

    // While suspended, re-sweep every ~2s to freeze and enroll any latecomer that registered continuous after the
    // initial Freeze. Runs only when suspended, so it is off the hot path.
    private void RunSuspendedMaintenance(double pollDelta)
    {
        _sinceReSweep += pollDelta;
        if (_sinceReSweep < ReSweepCadenceSec)
        {
            return;
        }

        _sinceReSweep = 0;

        int before = RenderActivity.ContinuousCount;
        var (anim, intent, spine, particles, shaders) = FreezeSweep();
        if (anim + intent + spine + particles + shaders > 0 || before != RenderActivity.ContinuousCount)
        {
            GD.Print($"M3_IDLE: resweep froze anim={anim} intent={intent} spine={spine} particles={particles} " +
                     $"shaders={shaders} continuousBefore={before} after={RenderActivity.ContinuousCount} " +
                     $"byCat[particle={RenderActivity.ContinuousParticle} shader={RenderActivity.ContinuousShader}]");
        }
    }

    private void Resume(string reason)
    {
        double frozenMs = Time.GetTicksMsec() - IdleSuspend.SuspendStartMs;

        int anim = ResumeList(_frozenCosmetic, static v => CosmeticAnimator.SetSuspended(v, false));
        int intent = ResumeList(_frozenIntent, static v => IntentPlayer.SetSuspended(v, false));
        int spine = ResumeList(_frozenSpine, static v => SpineAttachment.SetSuspended(v, false));
        int particles = ResumeList(_frozenParticles, static v => ParticleAttachment.SetSuspended(v, false));
        int shaders = ResumeList(_frozenShaders, static v => ShaderAttachment.SetSuspended(v, false));

        IdleSuspend.RecordResumed();
        long skippedDuring = RenderActivity.SkippedFrames - _skippedAtSuspend;

        GD.Print($"M3_IDLE: resumed reason={reason} frozenMs={frozenMs:0.0} skippedDuring={skippedDuring} " +
                 $"anim={anim} intent={intent} spine={spine} particles={particles} shaders={shaders}");
    }

    // Resume every retained view in `set` (IsInstanceValid-guarded), clear it, and return the count that actually
    // toggled. Idempotent: a view whose category self-resumed defensively is a no-op here.
    private static int ResumeList(HashSet<MirrorNodeView> set, System.Func<MirrorNodeView, bool> resume)
    {
        int n = 0;
        foreach (var view in set)
        {
            if (GodotObject.IsInstanceValid(view) && resume(view))
            {
                n++;
            }
        }

        set.Clear();
        return n;
    }
}
