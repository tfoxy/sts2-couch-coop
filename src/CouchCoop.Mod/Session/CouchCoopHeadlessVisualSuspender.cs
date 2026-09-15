using Godot;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Headless-only CPU saver. It permanently freezes the game-side visual simulation the browser mirror never
/// consumes — decorative per-frame animators (<see cref="FreezeDecorativeAnimators"/>), particle nodes
/// (<see cref="FreezeAllParticles"/>), and spine skeletons (<see cref="FreezeAllSpine"/>) — using base
/// <see cref="Node"/> APIs only. Particles and spine flip <see cref="Node.ProcessMode"/> to
/// <see cref="Node.ProcessModeEnum.Disabled"/>; the decorative freeze picks per type between that and the
/// narrower <see cref="Node.SetProcess"/>(false), because ProcessMode=Disabled ALSO pauses the node's own
/// TWEEN_PAUSE_BOUND tweens (see <see cref="DecorativeAnimatorTypes"/> — this is what used to strand the combat
/// energy orb off-position). All three are ALWAYS-ON and never restored (freed on scene teardown). The one
/// remaining idle-GATED lever is the frame-rate throttle: after
/// <see cref="IdleThresholdMs"/> of no activity it also drops <see cref="Engine.MaxFps"/> and restores it on the
/// next input/scene-delta.
///
/// Why this reclaims CPU: the profiler proved the live <c>--headless</c> flow spends its per-frame budget on the
/// game's SCRIPT simulation — spine skeletal mesh deformation (which spine-godot runs in
/// <c>NOTIFICATION_INTERNAL_PROCESS</c>) and particle simulation — NOT on rasterization (the dummy renderer does
/// zero draw calls). The mirror never consumes that visual work: for spine it streams only the anim NAME + a
/// WALL-CLOCK track time and the browser plays a server-baked clip on its own rAF clock; for particles it streams
/// the spec and the browser re-runs the sim. So a skeleton deforming its idle clip (or an enemy attacking) is
/// computing a mesh every frame for nobody. Freezing it always — not just when idle — is pure waste elimination.
///
/// Spine freeze without losing anim-TYPE changes: a permanently-frozen SpineSprite no longer runs its process, so
/// it stops emitting the <c>animation_started</c> signal and its native track queue stops advancing on its own —
/// which is how the producer used to learn the current animation. The producer instead observes each animation
/// change where it is REQUESTED, on a hook that fires whether or not the node is processing (spirectl
/// <c>Sts2SpineAnimationHooks</c>), and REPLAYS the sequence off wall-clock. So the mirror still switches
/// idle→attack→idle with the node frozen; only the game-side deformation is gone. (This is the spine analog of the
/// particle <c>Restart()</c> hook that keeps one-shot re-bursts replaying on frozen particle nodes.) The one
/// exception is <see cref="SpineFreezeExemptScriptTypes"/>: self-freeing one-shot VFX overlays, which need
/// their own <c>animation_completed</c> to fire in order to disappear.
///
/// The particle freeze has the same problem — one-shot VFX that delete themselves when their particles report
/// <c>finished</c>, a signal only the (now disabled) particle process emits, so the VFX node is never freed and its
/// subtree stays in the game tree forever (the live-confirmed phantom potion). It is solved two ways.
/// <see cref="ParticleFreezeExemptScriptTypes"/> is the narrow, live-proven exemption (one entry). The general cure
/// keeps everything frozen and SYNTHESIZES what the disabled process owed: when the freeze walk disables a one-shot
/// that is mid-burst, it schedules that node's END-OF-BURST for the burst's natural end
/// (<see cref="FinishNudgeDelaySeconds"/> — Godot's own <c>lifetime * (2 - explosiveness)</c> plus a margin), which
/// preserves game pacing and lets the browser's re-simulated burst finish its tail before the removal delta lands.
/// <c>Patches.HeadlessParticleRestartNudgePatch</c> extends this to bursts (re)started AFTER the node was frozen, and
/// <c>Patches.HeadlessDeathDelayCapPatch</c> caps the one death-sequence await that no particle signal can reach
/// (the ceremonial beast's, whose particle restart is driven by a now-frozen SPINE animation event).
///
/// A due nudge does TWO things, because a one-shot's own process owes its listeners a <c>finished</c> AND owes the
/// NODE a cleared <c>Emitting</c> flag (Godot ends the cycle from the very process this freeze disables). Only the
/// first was synthesized, so a frozen mid-burst one-shot latched <c>Emitting == true</c> FOREVER and the mirror
/// producer kept streaming <c>particleEmitting: true</c> — which is how the browser ended up drawing a permanent
/// "energy ring" burst (<c>vfx_common_ring_polar_a</c> and the rest of the regent energy-counter VFX cluster: all
/// one-shots that sit dormant until the counter fires them) over an energy counter the real game was showing
/// bare.
/// <see cref="ComputeDueNudgeActions"/> keeps the end-of-cycle signal and emitting-flag repair together.
///
/// Spine license (<c>.ai/Spine-Runtimes-License-Agreement.txt</c>): the freeze here touches ONLY Godot base-Node
/// APIs — it identifies spine by the native class string (<see cref="LooksLikeSpine"/> matches the "Spine" family:
/// SpineSprite / SpineMesh2D / SpineSlotNode / SpineBoneNode) and flips <see cref="Node.ProcessMode"/>. It never
/// calls any spine-godot method. (The producer's anim capture lives in spirectl and observes the game's own
/// animation requests / reads animation names — game-produced data, shipping/patching no Spine
/// Runtimes.) <see cref="Node.ProcessModeEnum.Disabled"/> is the same lever spirectl's still-capture path already
/// uses to freeze SpineSprites (<c>Sts2AssetExtractProvider.RenderAssets.cs</c>).
///
/// Crash-safety: this removes / reparents / nulls nothing (orthogonal to the known spine scene-transition
/// GP-fault, which was REMOVING SpineSlot/BoneNode structural children). It only flips
/// <see cref="Node.ProcessMode"/> / the per-node <see cref="Node.SetProcess"/> flag on steady-state nodes (freezing
/// runs on a once-per-<see cref="RescanIntervalMs"/> scan, so a node has ~1s to build its skeleton before it is
/// frozen — the same timing the old idle freeze used).
///
/// Late-appearing nodes: every always-on freeze re-scans the tree once per <see cref="RescanIntervalMs"/>, so
/// nodes that spawn later (a combat scene loading, a summoned enemy) are caught on the next scan. Each scan skips
/// already-frozen nodes (per-category instance-id set), so it is a cheap allocation-free tree walk.
///
/// Implementation mirrors <see cref="CouchCoopHeadlessCpuProfiler"/>: the mod has no Godot source generator, so
/// a custom <c>Node._Process</c> never fires — the tick is driven off a built-in <see cref="Godot.Timer"/>'s
/// <c>Timeout</c> signal, and the timer create + tree walk marshal onto the game main thread via
/// <c>Callable.From(...).CallDeferred()</c>. It runs for any WINDOWLESS instance (a spawned headless client OR a
/// <c>--headless</c> dev/server host — both serve the browser mirror, with no display of their own). Installed from
/// <see cref="CouchCoopMod"/>.Init's windowless branch.
///
/// NOT headless-ONLY any more, on two counts. (1) The browser Settings panel can turn a freeze on for ANY instance:
/// a WINDOWED host never runs the startup Install, so nothing here is applied there — which is exactly why
/// <see cref="EffectiveFreezes"/> (installed-aware), not the raw <c>_freeze*</c> flags, is what the <c>session</c>
/// envelope reports to the panel. (2) When a viewer does turn one on there, <see cref="EnsureFreezeMachinery"/>
/// installs in RESCAN-ONLY mode: the Timer + the once-per-<see cref="RescanIntervalMs"/> freeze rescan and nothing
/// else — no idle <see cref="Engine.MaxFps"/> throttle, no baseline capture — so the freeze also catches nodes that
/// spawn later without dropping the frame rate of a game a human is watching. On such an instance the freeze is
/// VISIBLE (it is the host's own screen); the panel says so.
/// </summary>
public static class CouchCoopHeadlessVisualSuspender
{
    public const string NodeName = "CouchCoopHeadlessVisualSuspender";

    // Check often enough that resume latency on activity is small, but idle enough to cost nothing when steady:
    // the steady tick is a single timestamp compare; the (cheap, alloc-free) tree walk runs only on the idle
    // transition and then at most once per RescanIntervalMs while suspended. 200ms tick ⇒ up to ~200ms to resume
    // after input, acceptable for this idle-focused step.
    private const double CheckIntervalSeconds = 0.2;
    private const long IdleThresholdMs = 1000;
    private const long RescanIntervalMs = 1000;

    // Idle frame-rate throttle: while idle we ALSO drop Engine.MaxFps to a low value, which linearly cuts every
    // per-frame cost at once (FMOD's native update callback, decorative _Process animations, the engine's tick
    // over the whole tree) — far more than freezing individual nodes. 24fps is just a copied player setting
    // (NGame sets Engine.MaxFps=SettingsSave.FpsLimit once; nothing re-asserts it on headless), and the co-op
    // ENet client tolerates low-fps servicing by a huge margin (host peer timeout ~20s, 500ms pings). 8fps keeps
    // the 0.2s check timer near-nominal and ENet servicing brisk.
    private const int DefaultIdleMaxFps = 8;

    private static readonly object Gate = new();
    // Written under Gate, read from any thread (the effective-state accessor the session envelope calls, and the
    // runtime setters) — volatile so a browser thread never sees a stale "not installed".
    private static volatile bool _started;
    // RESCAN-ONLY install (see EnsureFreezeMachinery): the Timer + the once-per-second freeze rescan run, and
    // NOTHING else — no idle Engine.MaxFps throttle, no baseline capture. This is the mode a WINDOWED host gets
    // when a viewer turns a freeze on from the browser Settings panel; the windowless startup path installs the
    // full suspender (rescan + idle throttle) as before.
    private static volatile bool _rescanOnly;
    private static int _idleFps; // resolved in Install: 0 = throttle disabled; >0 = idle Engine.MaxFps cap

    // Main-thread-only state (all mutated inside Tick, which runs on the game main thread via the Timer signal).
    // _suspended tracks the idle FPS-throttle transition only (the node freezes below are always-on, not idle-gated).
    private static bool _suspended;
    // FPS-throttle state: baseline captured once on the first tick; _fpsThrottled is read from a background thread
    // (NotifyMainThreadActivity) and written on the main thread, so it's volatile.
    private static int _baselineMaxFps;
    private static bool _baselineCaptured;
    private static volatile bool _fpsThrottled;

    // ALWAYS-ON decorative freeze (independent of idle). These node types run a purely-decorative per-frame
    // animation (a spinning counter orb, a bobbing enemy-intent icon, a flickering candle) that combat never awaits
    // — but whose transform churn makes the mirror producer walk + emit EVERY frame, which (a) is the dominant
    // headless cost and (b) keeps the client "active" so the idle throttle never engages. Freezing them once stops
    // the churn so a "thinking" combat goes quiet; the browser reproduces the motion on its own clock (see
    // `animAttributes.ts` / `CosmeticAnimator.cs` + the presentation catalog's `animation` bindings). Matched by C#
    // type NAME (GetType().Name) — these are script classes on native Control/Node2D bases, so GetClass() would be
    // ambiguous. Never restored (decorative; freed on scene teardown), so no saved-mode list — just dedup sets.
    //
    // TWO MECHANISMS, because "decorative" nodes come in two shapes, and using the wrong one strands the node:
    //
    //   * <see cref="DecorFreeze.ProcessOnly"/> — the churn comes from the node's own `_Process` OVERRIDE. Freeze
    //     with <see cref="Node.SetProcess"/>(false), which clears ONLY per-frame NOTIFICATION_PROCESS delivery
    //     (`Node::can_process_notification` reads the separate `data.process` flag) and leaves
    //     `Node::can_process()` untouched.
    //   * <see cref="DecorFreeze.WholeNode"/> — the churn IS a bound tween chain and the node has no `_Process` at
    //     all. Pausing the bound tween is the POINT, so these keep ProcessMode=Disabled.
    //
    // Why the distinction is load-bearing (the energy-orb bug): Godot 4.5.1 tweens default to TWEEN_PAUSE_BOUND,
    // and `Tween::can_process()` returns `bound_node->is_inside_tree() && bound_node->can_process()` — while
    // `Node::_can_process()` returns FALSE outright for PROCESS_MODE_DISABLED. So ProcessMode=Disabled also pauses
    // every tween the node created on ITSELF via CreateTween(). The combat energy counter SLIDES IN on exactly such
    // a tween at the start of a fight, so freezing it mid-slide stranded it off-position FOREVER — the whole orb
    // sat outside the combat UI, or (when the strand left the cull-eligible Label just across the cull margin while
    // the shader/particle orb nodes stayed resident) only its text vanished. Independent per-process scan phase is
    // why it hit ~2 of 4 players. (A recording of the old behaviour: the counter pinned at
    // (-20.374207, 5.4331055) for all 1190 deltas — a tween frozen part-way through its slide, not a layout bug.)
    //
    // Rejected alternative — "freeze only the %RotationLayers subtree": ProcessMode on a CHILD does not stop the
    // PARENT's `_Process` from writing `RotationDegrees` onto that child, so the churn would continue unchanged.
    /// <summary>Which freeze mechanism a decorative animator type gets. Public for the regression test.</summary>
    public enum DecorFreeze
    {
        /// <summary>SetProcess(false) — kills the `_Process` override; self-bound tweens keep running.</summary>
        ProcessOnly,

        /// <summary>ProcessMode=Disabled — also pauses self-bound tweens (which IS the churn for these).</summary>
        WholeNode,
    }

    /// <summary>
    /// The decorative-freeze policy, keyed by C# type NAME. Public so
    /// <c>HeadlessDecorativeFreezeTests</c> can assert the invariant that keeps the energy orb on-position:
    /// every <see cref="DecorFreeze.ProcessOnly"/> type overrides <c>_Process</c> (so SetProcess actually stops its
    /// churn) and every <see cref="DecorFreeze.WholeNode"/> type does NOT (so ProcessMode is the only lever left).
    /// </summary>
    public static readonly Dictionary<string, DecorFreeze> DecorativeAnimatorTypes = new()
    {
        // Combat energy orb. Its per-frame work is 100% decorative (the %RotationLayers rings spinning). Its
        // slide-in / slide-out POSITION tweens are self-bound and must keep running, or the counter strands
        // off-screen — see above.
        ["NEnergyCounter"] = DecorFreeze.ProcessOnly,
        // DELIBERATELY ABSENT — the combat star counter (`NStarCounter`). Do not add it back; the omission is
        // pinned by HeadlessDecorativeFreezeTests.TheStarCounterIsNeverFrozen.
        // Freezing it stopped the browser's star COUNT from ever rising. On screen a gain RAMPS the number up to
        // its new total over a moment, and that ramp is the only thing that writes the label on the way up — a
        // spend lands on it at once, which is why spending alone looked healthy. So a frozen seat sat on a stale
        // count for the rest of the fight (Venerate as the Regent: `…/StarCounter/MarginContainer/CountLabel`
        // never left its old value) while the game's own window was correct.
        // Re-admitting its spin costs the wire NOTHING, because the PRODUCER already removes that spin rather
        // than leaning on this freeze to stop it: spirectl's `Sts2OrbSpinFold` names the star counter's rotation
        // layers (`Icon/RotationLayers/Layer1|Layer2` in star_counter.tscn) and `Sts2RuntimeSceneWatcher` divides
        // the accumulated rotation analytically back out to the layers' authored rest angle before emitting, so
        // the spin never reaches a delta and cannot double up with the client's own `rotate` replay
        // (`animAttributes.ts`). That fold is local-transform-mode only, which CouchCoop satisfies —
        // `EmitLocalTransforms = true` in CouchCoopMod. A doubled spin comes back only if the fold is switched
        // OFF (`SPIRECTL_ORB_SPIN_FOLD=0`, or the master `SPIRECTL_DECOR_EMIT_SUPPRESS=0`), and then it is the
        // browser's rings turning at twice their rate — not a stale count.
        // The per-frame cost this hands back is small and bounded: per seat per frame, two rotation writes and
        // one smoothing step. The label re-renders only when the integer it shows actually changes.
        // If a future round DOES find a reason to freeze it, it is ProcessOnly and never WholeNode: a gain
        // brightens the star icon and settles it back over ~200ms on a self-bound tween that ProcessMode=Disabled
        // strands mid-flight, leaving the icon permanently too bright.
        // Enemy intent icon: its per-frame work bobs %IntentHolder and cycles the icon's flip-book at 15fps.
        // CAVEAT (pre-existing, NOT introduced here): that same per-frame cycle is the only thing that writes
        // `%Intent.Texture`, so a frozen intent keeps showing the PREVIOUS intent's icon after the frame list is
        // swapped (the value label + particle texture DO update — they are written elsewhere).
        ["NIntent"] = DecorFreeze.ProcessOnly,
        // Tezcatara candle-fire root (Node2D script). It runs no per-frame process at all: the flame's pulse
        // (scale.Y in [0.85,1.05] of its rest height) and its side-to-side lean (skew ±0.15rad) are self-chaining
        // tween chains — pure transform churn on 79 roots that floods the mirror producer every frame forever.
        // Bound tweens are TWEEN_PAUSE_BOUND, so ProcessMode=Disabled on the root stops both chains, which is
        // precisely what we want here. The browser replays the flicker/sway with a client-side `flameFlicker` sine
        // loop keyed on the quad leaves.
        ["NRestSiteFireVfx"] = DecorFreeze.WholeNode,
    };

    // Frozen-node bookkeeping, split by mechanism so the runtime SetFreezeDecor(false) toggle can undo each
    // correctly (ProcessMode=Inherit vs SetProcess(true)).
    private static readonly HashSet<ulong> _decorativeFrozenIds = [];
    private static readonly HashSet<ulong> _decorativeProcessFrozenIds = [];
    private static long _lastDecorativeScanMs;
    // Mutable + volatile: the browser Settings panel can flip it at runtime (SetFreezeDecor), read here on the
    // main-thread scan and written from a WS background thread.
    private static volatile bool _freezeDecor = true;

    // ALWAYS-ON particle freeze (independent of idle). Particle nodes run a per-frame CPU simulation that the
    // browser reproduces itself from the streamed particle spec, so the game-side sim is pure waste at ALL times.
    // Freezing them once (ProcessMode.Disabled) reclaims the particle-sim CPU during active play too, not just
    // idle. Never restored — the browser owns the sim (freed on scene teardown), so no saved-mode list, just a
    // dedup set. Kept separate from the spine idle suspend/resume path (spine still resumes on activity). The one
    // exception is <see cref="ParticleFreezeExemptScriptTypes"/>: self-freeing one-shot VFX overlays, which need
    // their own particles' `finished` signal to fire in order to disappear (the particle twin of the spine
    // exemption above). What a frozen node can no longer do FOR ITSELF — end a one-shot cycle: emit `finished`,
    // clear `Emitting` — is synthesized at the burst's natural end (see the end-of-burst nudge section below).
    private static readonly HashSet<ulong> _particleFrozenIds = [];
    // Mutable + volatile so the browser Settings panel can toggle it at runtime (SetFreezeParticles).
    private static volatile bool _freezeParticles = true;

    // ---- One-shot end-of-burst nudge (the general cure for self-freeing particle VFX, and for a latched flag) ----
    //
    // A one-shot particle node's own PROCESS ends its cycle, and that process is exactly what the freeze disables.
    // Two different things are owed at that moment, and BOTH have to be synthesized:
    //
    //   (1) the `finished` SIGNAL. Five VFX take themselves off screen only once it arrives (the hit and block
    //       sparks, the line burst — which is itself the emitter — the ground fire, and the ceremonial beast's
    //       death burst; the rename guards in HeadlessParticleFinishNudgeTests pin each). Without it a frozen
    //       one-shot leaks its VFX subtree forever, and the beast's can hold a death sequence open with nothing
    //       bounding the wait.
    //   (2) the `Emitting` FLAG. Godot clears it from that same process at the end of the cycle, so on a frozen
    //       node it LATCHES true forever. Nothing in the game cares — but the mirror producer streams it, and the
    //       browser draws a burst for as long as it says true. That is the permanent "energy ring" over the combat
    //       energy counter: the whole regent energy-VFX cluster (vfx_common_ring_polar_a, vfx_common_glow,
    //       vfx_common_ray, vfx_starry_impact_small_stars, vfx_starry_impact_constellation_small_a — every one of
    //       them authored `one_shot = true, emitting = false`) latched on after its first burst and never let go,
    //       while the real game's counter sat bare.
    //
    // Rather than exempting each VFX by name — an allow-list that has to chase every new VFX, that cannot help the
    // beast at all (its DeathParticles are SIBLINGS of the script's subtree: the script node lives at
    // Visuals/NCeremonialBeastVfx while the particles are `../../DeathParticles`, so a subtree exemption rooted at
    // the script never covers them), and that does nothing whatsoever for (2) — we keep EVERYTHING frozen and
    // synthesize both at the moment the node's own process would have acted.
    //
    // Natural TIMING, not "act immediately", and this is load-bearing for BOTH halves: the browser re-simulates the
    // burst on its own clock. Emitting `finished` at freeze time would free the VFX (and ship its removal delta)
    // while the client is still drawing the burst's opening frames; clearing `Emitting` at freeze time would erase
    // a burst the client has only just started drawing — the same defect as the stuck ring, mirrored. Instead we
    // schedule for when Godot itself would have acted — `lifetime * (2 - explosiveness)` is the engine's own
    // `active_time` for a one-shot cycle (particles.cpp), plus a small margin — so game pacing and the client's
    // tail both survive. Clamped so a pathological spec can neither fire instantly nor pin an entry forever.
    //
    // A nudge on a node nobody listens to is a plain no-op, so this needs no allow-list. EmitSignal and the
    // `Emitting` write are both Object-layer calls, unaffected by ProcessMode.Disabled.
    private const double FinishNudgeMarginSeconds = 0.25;
    private const double MinFinishNudgeSeconds = 0.5;
    private const double MaxFinishNudgeSeconds = 10.0;

    // instance id -> due Environment.TickCount64. Drained by Tick (0.2s cadence): this mod has no Godot source
    // generator, so a custom `_Process` never fires and everything is Timer-driven. Guarded by its own gate
    // because the Harmony restart hook (HeadlessParticleRestartNudgePatch) also writes here.
    private static readonly Dictionary<ulong, long> _pendingFinishNudges = [];
    private static readonly object _nudgeGate = new();

    // ALWAYS-ON spine freeze (independent of idle). Spine nodes run per-frame skeletal mesh deformation that the
    // browser reproduces itself by playing a server-baked clip off its own wall-clock, so the game-side sim is
    // pure waste at ALL times. Freezing them once (ProcessMode.Disabled) reclaims that CPU during active play too.
    // Never restored — the browser owns playback (freed on scene teardown), so no saved-mode list, just a dedup
    // set. Anim-TYPE changes still reach the mirror because the producer captures them where the animation is
    // REQUESTED (spirectl Sts2SpineAnimationHooks), not from the node's now-frozen per-frame process.
    private static readonly HashSet<ulong> _spineFrozenIds = [];
    // Mutable + volatile so the browser Settings panel can toggle it at runtime (SetFreezeSpines).
    private static volatile bool _freezeSpine = true;

    /// <summary>Idempotent.</summary>
    public static void Install() => Install(rescanOnly: false);

    // The shared install body. `rescanOnly` installs the freeze machinery WITHOUT the headless-only extras — see
    // _rescanOnly and EnsureFreezeMachinery. Returns true when the machinery is running afterwards (already
    // installed counts).
    private static bool Install(bool rescanOnly)
    {
        lock (Gate)
        {
            if (_started)
            {
                return true;
            }

            if (rescanOnly)
            {
                // Adopt the EFFECTIVE state as the new baseline: nothing is frozen in a process that never
                // installed, whatever the startup defaults say. Without this, the first browser toggle would
                // start a rescan that also froze the other two levers (their defaults are ON), i.e. the panel
                // would show two unchecked boxes over two freezes that just took effect — the exact lie this
                // whole path exists to remove. The caller then flips its ONE lever back on immediately after.
                _freezeParticles = false;
                _freezeSpine = false;
                _freezeDecor = false;
            }

            _rescanOnly = rescanOnly;
            _started = true;
        }

        // Rescan-only: no idle throttle at all (0 disables ApplyFpsThrottle). A windowed host's frame rate is the
        // player's own on-screen frame rate — dropping it to 8fps because the game went quiet would be a visible
        // stutter on the TV, and it is not what the viewer asked for by ticking "Freeze particles".
        _idleFps = rescanOnly ? 0 : DefaultIdleMaxFps;
        Console.Error.WriteLine(
            $"[couchcoop][suspend] {(rescanOnly ? "on-demand freeze rescan enabling (browser Settings toggle on a non-headless instance)" : "headless idle visual suspend enabling")}; "
            + $"idle fps cap={(_idleFps > 0 ? _idleFps.ToString() : "off")}");

        // Catch one-shots that are (re)started AFTER their node was already frozen — the freeze walk only sees a
        // node's state at scan time. Only worth installing when the particle freeze is actually on;
        // the patch itself is best-effort and degrades to a log line if a target can't be resolved. (A rescan-only
        // install has just zeroed the flags, so the particle setter applies the patch itself — see
        // SetFreezeParticles.)
        if (_freezeParticles)
        {
            Patches.HeadlessParticleRestartNudgePatch.Apply();
        }

        _ = Task.Run(InstallLoopAsync);
        return true;
    }

    /// <summary>
    /// True when the freeze machinery (the Timer + its once-per-<see cref="RescanIntervalMs"/> rescan) is running in
    /// THIS process. False on a WINDOWED host that never installed it — where the <c>_freeze*</c> flags still hold
    /// their startup defaults but NOTHING is frozen, which is why <see cref="EffectiveFreezes"/> and not the raw flags is
    /// what the session envelope reports.
    /// </summary>
    public static bool IsInstalled => _started;

    /// <summary>The three always-on freezes as they are EFFECTIVELY applied in one process.</summary>
    public readonly record struct FreezeStates(bool Particles, bool Spines, bool Decor);

    /// <summary>
    /// The effective-state RULE, pure so <c>HostPerformanceEnvelopeTests</c> can assert it with no live process:
    /// an installed suspender applies its flags verbatim; a process that never installed the machinery applies
    /// NOTHING, whatever its env-seeded flags say (a windowed host — <c>CouchCoopMod.Init</c> only installs for
    /// <c>IsHeadlessClient || IsHeadlessDisplay()</c>).
    /// </summary>
    public static FreezeStates ComputeEffectiveFreezes(bool installed, bool particles, bool spines, bool decor)
        => installed ? new FreezeStates(particles, spines, decor) : new FreezeStates(false, false, false);

    /// <summary>
    /// What THIS instance actually has frozen right now — the truth the <c>session</c> envelope carries so the
    /// browser Settings panel's "Host performance" checkboxes can seed from the instance they are about to control
    /// (headless seat: the env defaults; the host's own windowed game: all off until a viewer turns one on).
    /// Plain volatile field reads: no Godot call, so no main-thread hop is needed (unlike
    /// <see cref="GetEffectiveBaselineMaxFpsAsync"/>, which reads <see cref="Engine.MaxFps"/>).
    /// </summary>
    public static FreezeStates EffectiveFreezes()
        => ComputeEffectiveFreezes(_started, _freezeParticles, _freezeSpine, _freezeDecor);

    /// <summary>
    /// Make sure the freeze machinery is RUNNING before a runtime toggle turns a freeze on, installing it in
    /// rescan-only mode if this process never had it (a windowed host driven from the browser Settings panel).
    /// Returns false only when the kill-switch refuses, in which case the caller must NOT flip its lever.
    ///
    /// Why an install and not a bare walk: the freeze walk only ever sees the nodes that exist AT SCAN TIME. Before
    /// this, ticking a box on a non-headless instance ran exactly one walk with no maintenance — the combat that
    /// loaded a second later, every summoned enemy and every new VFX kept simulating, so the freeze silently
    /// decayed into a half-frozen scene. The Timer's once-per-second rescan is what makes it stick.
    /// </summary>
    private static bool EnsureFreezeMachinery() => _started || Install(rescanOnly: true);

    // Poll from a background task until the SceneTree root exists, then marshal the timer create + attach onto the
    // game main thread (creating a Godot node / touching the tree off-thread is unsafe). Same shape as the profiler.
    private static async Task InstallLoopAsync()
    {
        for (var attempt = 0; attempt < 120; attempt++)
        {
            try
            {
                if (Engine.GetMainLoop() is SceneTree { Root: { } root } && GodotObject.IsInstanceValid(root))
                {
                    Callable.From(() => AttachOnMainThread(root)).CallDeferred();
                    return;
                }
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(
                    $"[couchcoop][suspend] install attempt failed: {exception.GetType().Name}: {exception.Message}");
            }

            await Task.Delay(250).ConfigureAwait(false);
        }

        Console.Error.WriteLine("[couchcoop][suspend] install gave up (SceneTree never became ready)");
    }

    // Runs on the game main thread (deferred). Attaches a repeating Timer whose Timeout drives Tick.
    private static void AttachOnMainThread(Node root)
    {
        if (!GodotObject.IsInstanceValid(root) || root.GetNodeOrNull(NodeName) is not null)
        {
            return;
        }

        var timer = new Godot.Timer
        {
            Name = NodeName,
            WaitTime = CheckIntervalSeconds,
            OneShot = false,
            Autostart = true,
            // Always so the idle check keeps running even if the tree pauses; also keeps THIS timer node out of
            // the set of things that could ever freeze itself (it's a Timer, not a spine/particle node anyway).
            ProcessMode = Node.ProcessModeEnum.Always,
        };
        timer.Timeout += () => Tick(root);
        root.AddChild(timer);
        CouchCoopLog.Info(
            $"[couchcoop][suspend] headless idle visual suspend ready (idle>={IdleThresholdMs}ms, check={CheckIntervalSeconds:0.##}s, "
            + $"idle fps cap={(_idleFps > 0 ? _idleFps.ToString() : "off")})");
    }

    // Runs on the game main thread (Timer.Timeout). One timestamp compare per tick; the tree walk runs only on
    // the idle transition and then throttled while suspended.
    private static void Tick(Node root)
    {
        if (!GodotObject.IsInstanceValid(root))
        {
            return;
        }

        // Capture the real baseline Engine.MaxFps once (=24 here, the copied player FpsLimit) — must run on the
        // main thread, and before we ever throttle, so we never save a throttled value as the baseline. Skipped in
        // rescan-only mode: there is no throttle to restore from, and latching a baseline there would make
        // GetEffectiveBaselineMaxFpsAsync report that stale snapshot instead of the windowed host's LIVE fps limit
        // (which the player can still change in the game's own settings).
        if (!_baselineCaptured && !_rescanOnly)
        {
            _baselineCaptured = true;
            _baselineMaxFps = Engine.MaxFps;
        }

        // ALWAYS-ON (regardless of idle): freeze decorative per-frame animators (so their transform churn stops
        // driving the mirror producer every frame), every particle node (the browser re-runs the particle sim
        // itself), and every spine node (the browser plays a baked clip off wall-clock; anim-type changes still
        // reach the mirror via the producer's CreatureAnimator hook). All three share one throttled
        // once-per-RescanIntervalMs scan; each is individually kill-switched and a cheap no-op once the combat
        // scene's nodes are all frozen.
        var nowDeco = System.Environment.TickCount64;
        if (nowDeco - _lastDecorativeScanMs >= RescanIntervalMs)
        {
            _lastDecorativeScanMs = nowDeco;
            if (_freezeDecor) FreezeDecorativeAnimators(root);
            if (_freezeParticles) FreezeAllParticles(root);
            if (_freezeSpine) FreezeAllSpine(root);
        }

        // EVERY tick (not throttled to the rescan cadence): fire the end-of-burst owed by frozen one-shots whose
        // natural burst time has now elapsed — the `finished` the awaiting VFX need in order to free themselves,
        // and the `Emitting` clear that stops the mirror drawing an ended burst. Empty-map fast path.
        FlushFinishNudges(nowDeco);

        // Rescan-only (browser-toggled freeze on a non-headless instance): the freezes above are the WHOLE job.
        // Everything below is the headless idle FPS throttle, which a windowed host must never get — its frame
        // rate is what a human is watching.
        if (_rescanOnly)
        {
            return;
        }

        var idle = HeadlessIdleActivity.MsSinceActivity() >= IdleThresholdMs;

        if (!idle)
        {
            if (_suspended)
            {
                Resume();
            }

            return;
        }

        // Idle. The node freezes (decor/particles/spine) are all always-on above; the only idle-gated lever left
        // is the frame-rate throttle. Drop the frame rate on the idle transition (restored on the next activity).
        if (!_suspended)
        {
            _suspended = true;
            ApplyFpsThrottle();
        }
    }

    // Walk the tree and freeze every decorative per-frame animator (by C# type name) not already frozen, using the
    // per-type mechanism from <see cref="DecorativeAnimatorTypes"/>. Runs ALWAYS (not idle-gated) so their transform
    // churn never reaches the mirror producer; the browser reproduces the motion on its own clock. Never restored —
    // decorative, and freed on scene teardown. Alloc-free DFS, main thread only (SetProcess is thread-guarded).
    //
    // The ProcessOnly branch RE-ASSERTS on every scan (two cheap bool reads) instead of gating on the dedup set,
    // because Godot re-enables processing at NOTIFICATION_READY for any node whose script overrides `_Process`
    // (node.cpp NOTIFICATION_READY → set_process(true)). A node caught by a scan BEFORE its ready would otherwise
    // stay unfrozen forever; here the next scan picks it back up.
    private static void FreezeDecorativeAnimators(Node root)
    {
        var froze = 0;
        var stack = new Stack<Node>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();

            // An OFF-SCREEN EXTRACTION subtree is exempt, subtree and all (see IsOffscreenExtractionSubtreeRoot).
            // All three walks share the shape because they share the hazard: the bake's own nodes must run.
            if (IsOffscreenExtractionSubtreeRoot(node.Name.ToString()))
            {
                continue;
            }

            if (node.ProcessMode != Node.ProcessModeEnum.Disabled
                && DecorativeAnimatorTypes.TryGetValue(node.GetType().Name, out var how))
            {
                if (how == DecorFreeze.WholeNode)
                {
                    if (_decorativeFrozenIds.Add(node.GetInstanceId()))
                    {
                        node.ProcessMode = Node.ProcessModeEnum.Disabled;
                        froze++;
                    }
                }
                else if (node.IsProcessing() || node.IsPhysicsProcessing())
                {
                    node.SetProcess(false);
                    node.SetPhysicsProcess(false);
                    if (_decorativeProcessFrozenIds.Add(node.GetInstanceId()))
                    {
                        froze++;
                    }
                }
            }

            var childCount = node.GetChildCount();
            for (var i = 0; i < childCount; i++)
            {
                stack.Push(node.GetChild(i));
            }
        }

        if (froze > 0)
        {
            CouchCoopLog.Info(
                $"[couchcoop][suspend] froze {froze} decorative animator node(s) "
                + $"(total held: process-only {_decorativeProcessFrozenIds.Count}, whole-node {_decorativeFrozenIds.Count})");
        }
    }

    // Walk the tree and freeze every particle node (GpuParticles2D / CpuParticles2D) not already frozen. Runs
    // ALWAYS (not idle-gated) so the game-side particle sim never runs — the browser re-runs it from the streamed
    // particle spec. Never restored — the browser owns the sim, freed on scene teardown, so no saved-mode list,
    // just a dedup set. Alloc-free DFS. Base-Node APIs only. Subtrees under a
    // <see cref="ParticleFreezeExemptScriptTypes"/> root are skipped whole (self-freeing one-shot VFX).
    private static int FreezeAllParticles(Node root)
    {
        var froze = 0;
        var nudged = 0;
        var stack = new Stack<Node>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();

            // SELF-FREEING one-shot particle VFX are exempt, subtree and all (see ParticleFreezeExemptScriptTypes).
            if (IsParticleFreezeExemptSubtreeRoot(node.GetType().Name))
            {
                continue;
            }

            // …as is an OFF-SCREEN EXTRACTION subtree (see IsOffscreenExtractionSubtreeRoot). It lives for
            // milliseconds and is freed, so its particles are nobody's idle-CPU problem.
            if (IsOffscreenExtractionSubtreeRoot(node.Name.ToString()))
            {
                continue;
            }

            if (node.ProcessMode != Node.ProcessModeEnum.Disabled
                && node is GpuParticles2D or CpuParticles2D
                && _particleFrozenIds.Add(node.GetInstanceId()))
            {
                node.ProcessMode = Node.ProcessModeEnum.Disabled;
                froze++;

                // A one-shot caught MID-BURST owes an end-of-cycle its disabled process can no longer deliver: the
                // `finished` its listeners await, and the `Emitting` clear that otherwise latches true forever
                // (and keeps the browser drawing the burst). Schedule both for the burst's natural end. Reading
                // the spec here — before anything else touches the node — is a plain property read on the main
                // thread.
                if (TryScheduleFinishNudge(node))
                {
                    nudged++;
                }
            }

            var childCount = node.GetChildCount();
            for (var i = 0; i < childCount; i++)
            {
                stack.Push(node.GetChild(i));
            }
        }

        if (froze > 0)
        {
            CouchCoopLog.Info(
                $"[couchcoop][suspend] froze {froze} particle node(s) (total held {_particleFrozenIds.Count}"
                + (nudged > 0 ? $", {nudged} mid-burst one-shot(s) scheduled for an end-of-burst nudge)" : ")"));
        }

        return froze;
    }

    // ---- One-shot end-of-burst nudge --------------------------------------------------------------------------

    /// <summary>
    /// Freeze-time decision: does this particle node owe a synthesized end-of-burst (the <c>finished</c> its
    /// listeners await, and the <c>Emitting</c> clear the mirror reads)? Only a ONE-SHOT that is currently
    /// EMITTING does — a looping emitter never reports finished and never self-clears <c>Emitting</c> (the game
    /// owns that flag; see <see cref="ComputeDueNudgeActions"/>), and an idle one-shot has either not started or
    /// already ended. Pure (no Godot node) so <c>HeadlessParticleFinishNudgeTests</c> can assert it without a live
    /// scene tree.
    /// </summary>
    public static bool ShouldNudgeOnFreeze(bool oneShot, bool emitting) => oneShot && emitting;

    /// <summary>
    /// Freeze-walk decision for ONE node in <see cref="FreezeAllSpine"/>: a spine node that is not already frozen
    /// gets frozen — every scan, unconditionally.
    ///
    /// <para>Note what this signature deliberately does NOT take: "have we frozen this id before". That was the
    /// bug. The walk used to read <c>… &amp;&amp; LooksLikeSpine(node) &amp;&amp; _spineFrozenIds.Add(id)</c>, so
    /// the dedup set doubled as the gate and any node whose <c>ProcessMode</c> came back — anything that writes it,
    /// or a Godot instance id recycled onto a fresh node after the original was freed (the set is never swept of
    /// dead ids) — was skipped forever while the log still counted it as held. The decorative walk's ProcessOnly
    /// branch has always re-asserted for the same class of reason; this brings the spine walk in line.</para>
    ///
    /// <para>Pure (no Godot node) so <c>HeadlessSpineFreezeTests</c> can assert it without a live scene tree, like
    /// <see cref="ShouldNudgeOnFreeze"/> and <see cref="ComputeEffectiveFreezes"/> above.</para>
    /// </summary>
    public static bool ShouldAssertSpineFreeze(bool alreadyDisabled, bool looksLikeSpine)
        => !alreadyDisabled && looksLikeSpine;

    /// <summary>
    /// Restart-hook decision (<c>HeadlessParticleRestartNudgePatch</c>): a <c>Restart()</c> / <c>Emitting = true</c>
    /// on a node the freeze walk ALREADY froze starts a burst whose process will never run, so a one-shot needs the
    /// same nudge. A not-yet-frozen node needs nothing — the next freeze walk sees it emitting and schedules then.
    /// Pure, for the same reason as <see cref="ShouldNudgeOnFreeze"/>.
    /// </summary>
    public static bool ShouldNudgeOnRestart(bool alreadyFrozen, bool oneShot) => alreadyFrozen && oneShot;

    /// <summary>
    /// How long after the burst starts Godot itself would emit <c>finished</c>, plus a margin. Godot's one-shot
    /// cycle runs for <c>lifetime * (2 - explosiveness)</c> (particles.cpp <c>active_time</c>: with
    /// explosiveness 1 every particle is born at t=0 so the cycle is one lifetime; with explosiveness 0 births are
    /// spread over a full lifetime, so the last particle dies at 2× lifetime). Clamped to
    /// [<see cref="MinFinishNudgeSeconds"/>, <see cref="MaxFinishNudgeSeconds"/>] so a degenerate spec can neither
    /// fire before the client has drawn the burst nor pin a pending entry indefinitely. Pure/static for tests.
    /// </summary>
    public static double FinishNudgeDelaySeconds(double lifetime, double explosiveness)
    {
        var active = lifetime * (2.0 - explosiveness) + FinishNudgeMarginSeconds;
        if (!double.IsFinite(active))
        {
            return MinFinishNudgeSeconds;
        }

        return Math.Clamp(active, MinFinishNudgeSeconds, MaxFinishNudgeSeconds);
    }

    /// <summary>What a DUE nudge performs on one frozen node — the two halves of the end-of-cycle its own
    /// (disabled) process owes. Public for <c>HeadlessParticleFinishNudgeTests</c>.</summary>
    public readonly record struct FinishNudgeActions(bool EmitFinished, bool ClearEmitting);

    /// <summary>
    /// Due-time decision table for one pending nudge. Pure (no Godot node, no clock) so
    /// <c>HeadlessParticleFinishNudgeTests</c> can assert it without a live scene tree.
    ///
    /// <para>The <c>finished</c> emit is unconditional: it is the signal the listeners are already awaiting, and by
    /// the due time the burst is over however the flag ended up (the game may have called
    /// <c>SetEmitting(false)</c> on the frozen node in the meantime — the listener still never got its signal).</para>
    ///
    /// <para>The <c>Emitting</c> clear is NOT. It is only ever the write the node's own process would have made, so
    /// it is refused unless the node is still a LATCHED ONE-SHOT. Clearing a LOOPER would stop an emitter the game
    /// deliberately has running (the game owns that flag for a looping emitter — it turns it off through
    /// <c>NParticlesContainer</c> when it wants it off), and a one-shot that already reads not-emitting owes
    /// nothing: either the game stopped it, or the freeze was lifted at runtime and the node's own process ended
    /// the cycle itself. That second guard also makes a re-fire inert, so the clear can never ping-pong with
    /// <c>HeadlessParticleRestartNudgePatch</c> (which ignores <c>Emitting = false</c> writes for the same reason).</para>
    /// </summary>
    public static FinishNudgeActions ComputeDueNudgeActions(bool oneShot, bool emitting)
        => new(EmitFinished: true, ClearEmitting: oneShot && emitting);

    /// <summary>
    /// The tick a nudge scheduled at <paramref name="scheduledAtMs"/> comes due — the ONE clock rule both halves
    /// of <see cref="ComputeDueNudgeActions"/> ride, so neither can drift toward "act at freeze time". Pure, with
    /// <see cref="IsFinishNudgeDue"/>, so the whole burst timeline is replayable in a test.
    /// </summary>
    public static long FinishNudgeDueMs(long scheduledAtMs, double delaySeconds)
        => scheduledAtMs + (long)Math.Round(delaySeconds * 1000.0);

    /// <summary>Whether a pending nudge due at <paramref name="dueMs"/> has come due at <paramref name="nowMs"/>.</summary>
    public static bool IsFinishNudgeDue(long dueMs, long nowMs) => dueMs <= nowMs;

    // Read the node's one-shot spec and, if it is a mid-burst one-shot, queue its end-of-burst for the burst's
    // natural end. Main thread only (plain Godot property reads). Returns true when an entry was queued.
    private static bool TryScheduleFinishNudge(Node node)
        => node switch
        {
            GpuParticles2D gpu => TryScheduleFinishNudge(
                node, ShouldNudgeOnFreeze(gpu.OneShot, gpu.Emitting), gpu.Lifetime, gpu.Explosiveness),
            CpuParticles2D cpu => TryScheduleFinishNudge(
                node, ShouldNudgeOnFreeze(cpu.OneShot, cpu.Emitting), cpu.Lifetime, cpu.Explosiveness),
            _ => false,
        };

    private static bool TryScheduleFinishNudge(Node node, bool shouldNudge, double lifetime, double explosiveness)
    {
        if (!shouldNudge)
        {
            return false;
        }

        ScheduleFinishNudge(node.GetInstanceId(), FinishNudgeDelaySeconds(lifetime, explosiveness));
        return true;
    }

    // Queue (or re-arm — a later Restart wins) the pending end-of-burst for a node id.
    private static void ScheduleFinishNudge(ulong instanceId, double delaySeconds)
    {
        var dueMs = FinishNudgeDueMs(System.Environment.TickCount64, delaySeconds);
        lock (_nudgeGate)
        {
            _pendingFinishNudges[instanceId] = dueMs;
        }
    }

    /// <summary>
    /// Called by <c>HeadlessParticleRestartNudgePatch</c>'s Harmony postfixes when the game calls
    /// <c>Restart()</c> or sets <c>Emitting = true</c> on a particle node. Only nodes the freeze walk ALREADY froze
    /// need a nudge (see <see cref="ShouldNudgeOnRestart"/>); the rest are handled by the next freeze walk.
    /// Runs on the game main thread by construction — a Godot node API like <c>Restart()</c> is only legal there.
    /// Never throws: particle bookkeeping must not be able to disrupt the game.
    /// </summary>
    public static void NotifyParticleRestarted(GodotObject node)
    {
        try
        {
            if (node is not (GpuParticles2D or CpuParticles2D) || !GodotObject.IsInstanceValid(node))
            {
                return;
            }

            var alreadyFrozen = _particleFrozenIds.Contains(node.GetInstanceId());
            switch (node)
            {
                case GpuParticles2D gpu when ShouldNudgeOnRestart(alreadyFrozen, gpu.OneShot):
                    ScheduleFinishNudge(gpu.GetInstanceId(), FinishNudgeDelaySeconds(gpu.Lifetime, gpu.Explosiveness));
                    break;
                case CpuParticles2D cpu when ShouldNudgeOnRestart(alreadyFrozen, cpu.OneShot):
                    ScheduleFinishNudge(cpu.GetInstanceId(), FinishNudgeDelaySeconds(cpu.Lifetime, cpu.Explosiveness));
                    break;
            }
        }
        catch
        {
            // Never let the nudge bookkeeping surface inside a game call.
        }
    }

    // Runs on the game main thread (Timer.Timeout). Fire the end-of-burst owed by every pending nudge whose
    // natural burst time has elapsed. Collect-under-lock then fire outside it: the emit runs arbitrary game
    // listeners (the VFX's own QueueFree chain), which must never re-enter the map while it's held.
    private static void FlushFinishNudges(long nowMs)
    {
        if (_pendingFinishNudges.Count == 0)
        {
            return;
        }

        List<ulong>? due = null;
        lock (_nudgeGate)
        {
            foreach (var pending in _pendingFinishNudges)
            {
                if (IsFinishNudgeDue(pending.Value, nowMs))
                {
                    (due ??= []).Add(pending.Key);
                }
            }

            if (due is null)
            {
                return;
            }

            foreach (var id in due)
            {
                _pendingFinishNudges.Remove(id);
            }
        }

        foreach (var id in due)
        {
            FireFinishNudge(id);
        }
    }

    // Deliver the end-of-burst a frozen one-shot's disabled process owes: the `Emitting` clear, then the
    // `finished` signal. Both are Object-layer calls — ProcessMode.Disabled gates the node's per-frame
    // NOTIFICATION_PROCESS, not its property setters or its signal dispatch — so a frozen node can still do both.
    // The node may have been freed since we queued (the scene changed, the creature died); InstanceFromId +
    // IsInstanceValid is the same validity guard Unfreeze uses.
    //
    // ORDER IS LOAD-BEARING: `finished` is what the self-freeing VFX await, so its listeners commonly QueueFree the
    // subtree this node lives in. Writing the flag AFTER that would be a write to a node on its way out (at best a
    // no-op, at worst a disposed-object throw), and the flag write is the half the browser mirror reads. Clear
    // first, emit second.
    //
    // The clear does not re-arm anything: HeadlessParticleRestartNudgePatch's set_Emitting postfix only nudges on a
    // write of TRUE, and ComputeDueNudgeActions refuses a clear on a node that already reads not-emitting — two
    // independent reasons the pair cannot self-perpetuate.
    private static void FireFinishNudge(ulong instanceId)
    {
        try
        {
            if (GodotObject.InstanceFromId(instanceId) is not { } target || !GodotObject.IsInstanceValid(target))
            {
                return;
            }

            var (oneShot, emitting) = target switch
            {
                GpuParticles2D gpu => (gpu.OneShot, gpu.Emitting),
                CpuParticles2D cpu => (cpu.OneShot, cpu.Emitting),
                _ => (false, false),
            };

            var actions = ComputeDueNudgeActions(oneShot, emitting);
            if (actions.ClearEmitting)
            {
                switch (target)
                {
                    case GpuParticles2D gpu:
                        gpu.Emitting = false;
                        break;
                    case CpuParticles2D cpu:
                        cpu.Emitting = false;
                        break;
                }
            }

            if (actions.EmitFinished)
            {
                target.EmitSignal(GpuParticles2D.SignalName.Finished);
            }
        }
        catch (Exception exception)
        {
            CouchCoopLog.Info(
                $"[couchcoop][suspend] finish-nudge fire failed for {instanceId}: "
                + $"{exception.GetType().Name}: {exception.Message}");
        }
    }

    // Walk the tree and freeze every spine node (SpineSprite / SpineMesh2D / SpineSlotNode / SpineBoneNode) not
    // already frozen. Runs ALWAYS (not idle-gated) so the game-side skeletal deformation never runs — the browser
    // plays a baked clip off its own wall-clock and the producer's CreatureAnimator hook keeps anim-type changes
    // flowing. Never restored — the browser owns playback, freed on scene teardown, so no saved-mode list, just a
    // dedup set. Alloc-free DFS; base-Node APIs only (identifies spine by native class string, never calls a
    // spine-godot method). The cheap ProcessMode check runs before LooksLikeSpine's GetClass() native read.
    //
    // RE-ASSERTS on every scan, like the decorative walk's ProcessOnly branch above and for the same reason: the
    // dedup set is a REPORTING set (how many nodes we hold), never the gate. It used to be the gate —
    // `… && LooksLikeSpine(node) && _spineFrozenIds.Add(id)` — which meant a spine node whose ProcessMode came BACK
    // (anything that writes ProcessMode on it, or an instance id recycled by Godot's ObjectDB onto a fresh node
    // after the original was freed; the set is never swept of dead ids) was skipped forever, silently un-freezing
    // one creature's skeleton for the rest of the run while the log still counted it as held. Re-asserting is free
    // in the steady state: an already-Disabled node short-circuits on the ProcessMode read and never reaches either
    // the GetClass probe or the write.
    private static int FreezeAllSpine(Node root)
    {
        var froze = 0;
        var refroze = 0;
        var stack = new Stack<Node>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();

            // SELF-FREEING one-shot VFX overlays are exempt, subtree and all (see SpineFreezeExemptScriptTypes).
            if (SpineFreezeExemptScriptTypes.Contains(node.GetType().Name))
            {
                continue;
            }

            // An OFF-SCREEN EXTRACTION subtree is exempt, subtree and all — freezing the detached rig a render is
            // posing makes it capture a stale pose, which a viewer can trigger on a WINDOWED host just by ticking
            // "freeze spines" in the panel (see IsOffscreenExtractionSubtreeRoot). Reading Name costs a StringName
            // + a string per node per rescan; the walk already allocates a managed wrapper per GetChild, and the
            // marker is a NAME precisely because the type is too broad to key on.
            if (IsOffscreenExtractionSubtreeRoot(node.Name.ToString()))
            {
                continue;
            }

            // The cheap ProcessMode read still gates the native GetClass probe (unchanged), so an already-frozen
            // node costs one property read per scan and nothing else.
            var frozenAlready = node.ProcessMode == Node.ProcessModeEnum.Disabled;
            if (ShouldAssertSpineFreeze(frozenAlready, !frozenAlready && LooksLikeSpine(node)))
            {
                node.ProcessMode = Node.ProcessModeEnum.Disabled;
                if (_spineFrozenIds.Add(node.GetInstanceId()))
                {
                    froze++;
                }
                else
                {
                    refroze++; // already held, but something had put it back — the bug this branch shape fixes
                }
            }

            var childCount = node.GetChildCount();
            for (var i = 0; i < childCount; i++)
            {
                stack.Push(node.GetChild(i));
            }
        }

        if (froze > 0 || refroze > 0)
        {
            CouchCoopLog.Info(
                $"[couchcoop][suspend] froze {froze} spine node(s) (total held {_spineFrozenIds.Count}"
                + (refroze > 0 ? $", re-froze {refroze} that had come back)" : ")"));
        }

        return froze;
    }

    // Resume the idle FPS throttle on activity. The node freezes (decor/particles/spine) are always-on and never
    // restored, so there is nothing else to undo here (RestoreFps logs the frame-rate restore).
    private static void Resume()
    {
        RestoreFps();
        _suspended = false;
    }

    /// <summary>
    /// Restore the game frame rate immediately on player input, with less latency than waiting for the next idle
    /// check tick (~250ms at 8fps). Called from <see cref="Protocol.BrowserInputExecutor"/> on any input; safe
    /// from any thread — the fps write itself is marshalled onto the main thread. Node-resume + enemy-action
    /// (scene-delta) activity are still handled by the Timer <see cref="Tick"/>.
    /// </summary>
    public static void NotifyMainThreadActivity()
    {
        if (!_fpsThrottled)
        {
            return; // fast path: not throttled (active play) → nothing to do, no per-input deferred call
        }

        // Engine.MaxFps must be set on the main thread; CallDeferred marshals there regardless of caller thread.
        Callable.From(RestoreFps).CallDeferred();
    }

    // Runs on the main thread. Drop the frame rate to the idle cap (linearly cuts every per-frame cost).
    private static void ApplyFpsThrottle()
    {
        if (_idleFps <= 0 || _fpsThrottled)
        {
            return;
        }

        _fpsThrottled = true;
        Engine.MaxFps = _idleFps;
        CouchCoopLog.Info($"[couchcoop][suspend] idle — throttled Engine.MaxFps {_baselineMaxFps}->{_idleFps}");
    }

    // Runs on the main thread. Restore the captured baseline frame rate. Idempotent.
    private static void RestoreFps()
    {
        if (!_fpsThrottled)
        {
            return;
        }

        _fpsThrottled = false;
        Engine.MaxFps = _baselineMaxFps;
        CouchCoopLog.Info($"[couchcoop][suspend] activity — restored Engine.MaxFps ->{_baselineMaxFps}");
    }

    // Match the whole spine-godot node family by native class string (SpineSprite / SpineMesh2D / SpineSlotNode /
    // SpineBoneNode) without referencing the spine-godot GDExtension type or calling any of its methods — the
    // per-frame skeletal deformation lives on these nodes. GetClass() returns the native class for a GDExtension
    // node (GetType().Name is just Godot.Node2D), so it is the reliable identifier.
    private static bool LooksLikeSpine(Node node)
        => node.GetClass().Contains("Spine", StringComparison.OrdinalIgnoreCase)
            || node.GetType().Name.Contains("Spine", StringComparison.OrdinalIgnoreCase);

    // Script classes whose WHOLE SUBTREE is exempt from the always-on spine freeze, matched by C# type NAME
    // (GetType().Name — a script class on a native Node2D base, so GetClass() would be ambiguous), exactly like
    // DecorativeAnimatorTypes above.
    //
    // NVfxSpine is the game's generic one-shot spine-overlay driver (res://scenes/vfx/vfx_bite.tscn,
    // vfx_scratch, vfx_gaze, vfx_chain, vfx_flying_slash, vfx_adrenaline, kaiser_crab_boss_explosion). Its
    // _Ready plays a single non-looping clip and connects `animation_completed` → QueueFreeSafely, i.e. THE
    // NODE DELETES ITSELF WHEN THE CLIP ENDS. Freezing its SpineSprite (ProcessMode.Disabled) stops the spine
    // update that fires that signal, so the completion never arrives, the node is never freed, and the mirror
    // keeps a dead attack overlay on screen replaying forever (round-8 item 10). These overlays are transient
    // and tiny (one skeleton for well under a second), so leaving them simulating costs nothing measurable
    // next to the permanent creature/background skeletons the freeze exists for.
    private static readonly HashSet<string> SpineFreezeExemptScriptTypes =
    [
        "NVfxSpine",
    ];

    /// <summary>
    /// The particle twin of <see cref="SpineFreezeExemptScriptTypes"/>: script classes whose WHOLE SUBTREE is
    /// exempt from the always-on particle freeze, matched by C# type NAME (<c>GetType().Name</c> — a script class
    /// on a native Node2D base, so <c>GetClass()</c> would be ambiguous), exactly like
    /// <see cref="DecorativeAnimatorTypes"/>. Public so <c>HeadlessParticleFreezeExemptionTests</c> can assert the
    /// names still resolve against the installed STS2 assemblies and still have the self-free shape.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>NPotionFlashVfx</c> (<c>res://scenes/vfx/vfx_potion_flash.tscn</c>) is the live-confirmed leak. The
    /// scene is added under a potion as the last beat of the potion-obtained animation. It paints a copy of the
    /// potion into its own 60x60 SubViewport and uses that as the texture of a one-shot <c>%Flash</c>
    /// CPUParticles2D, then removes itself once that burst reports <c>finished</c>. ProcessMode.Disabled stops
    /// CPUParticles2D's internal process, which is the ONLY emitter of <c>finished</c> — so under the freeze the
    /// VFX is never removed, and its copy of the potion lives in the tree forever.
    /// </para>
    /// <para>
    /// That leak is what the browser saw as a phantom potion pinned over the top-left portrait: the duplicate sits
    /// inside a SubViewport with no computable viewport→screen prefix, so the producer streamed it at
    /// viewport-local coordinates (≈ the design origin). spirectl's viewport-content prune now keeps that node off
    /// the wire; this exemption removes the game-side cause — belt and braces, and it also stops dead flash VFX
    /// from accumulating in the tree (one per potion ever obtained).
    /// </para>
    /// <para>
    /// A plain exemption is enough here — no need for the heavier "advance/emit <c>finished</c> at freeze time"
    /// fallback. The scan cannot catch the node in a half-built state: it runs on the game main thread off the
    /// suspender's Timer, and Godot propagates <c>_Ready</c> synchronously inside <c>AddChild</c>, so a VFX is
    /// never merely in-tree-but-not-ready when the walk sees it. And the freeze does not out-race the one-shot: the
    /// exempted particles keep processing off the real frame delta, so they finish in wall-clock time even under
    /// the idle <see cref="DefaultIdleMaxFps"/> cap (8 frames per second still advance 1s of sim per 1s of clock).
    /// The exemption window is genuinely exercised, too — Godot emits <c>finished</c> only once the post-burst
    /// inactive time exceeds the particle lifetime (≈2s for this scene), while the freeze re-scans every
    /// <see cref="RescanIntervalMs"/>, so every potion flash used to get caught mid-flight.
    /// </para>
    /// <para>
    /// Cost: one amount=1 CPUParticles2D (plus whatever particles ride along in the duplicated potion subtree)
    /// simulating for ~2s per potion obtained. Nothing next to the permanent combat emitters this freeze exists
    /// for, and self-limiting — the node deletes itself, which is the entire point.
    /// </para>
    /// <para>
    /// Deliberately NOT exempted, because they are covered by a BETTER mechanism: the other five self-free-on-
    /// <c>finished</c> VFX — <c>NHitSparkVfx</c>, <c>NBlockSparkVfx</c>, <c>NLineBurstVfx</c>, <c>NGroundFireVfx</c>
    /// and <c>NCeremonialBeastVfx</c> — stay frozen and instead get the synthesized <c>finished</c> nudge
    /// (<see cref="ShouldNudgeOnFreeze"/> / <see cref="FinishNudgeDelaySeconds"/>, plus
    /// <c>HeadlessParticleRestartNudgePatch</c> for bursts started after the freeze), with
    /// <c>HeadlessDeathDelayCapPatch</c> as the backstop for the beast's <c>IDeathDelayer.GetDelayTask</c>.
    /// </para>
    /// <para>
    /// Why the nudge rather than five more exemptions — VERIFIED, not assumed: the headless dummy renderer DOES
    /// fire GPU-particle <c>finished</c> node-side (particle cycle bookkeeping is engine-side, not a draw), so a
    /// plain exemption WOULD have worked for the four scene-rooted VFX. It loses on the other three counts.
    /// (1) Shape: it cannot fix <c>NCeremonialBeastVfx</c> at all. That script sits at
    /// <c>CeremonialBeast/Visuals/NCeremonialBeastVfx</c> while the particles it drives are SIBLINGS of
    /// <c>Visuals</c> (at <c>../../DeathParticles</c>), so a subtree exemption rooted at the script node never
    /// reaches them, and exempting the creature root would un-freeze the whole boss. (2) Maintenance: the
    /// exemption is a name allow-list that silently rots on a rename and has to chase every VFX the game adds; the
    /// nudge is shape-based (<c>OneShot &amp;&amp; Emitting</c>) and covers future pooled VFX for free — a nudge on
    /// a node with no <c>finished</c> listener is a no-op. (3) Cost: an exempted node keeps SIMULATING, which is
    /// exactly the CPU this freeze exists to reclaim; the nudge keeps everything frozen and costs one dictionary
    /// entry and one <c>EmitSignal</c>.
    /// </para>
    /// <para>
    /// <c>NPotionFlashVfx</c> nonetheless keeps its exemption: it is live-proven, and exempt subtrees are skipped
    /// BEFORE the freeze, so they are never nudged — the two mechanisms cannot collide.
    /// </para>
    /// </remarks>
    public static readonly HashSet<string> ParticleFreezeExemptScriptTypes =
    [
        "NPotionFlashVfx",
    ];

    /// <summary>
    /// The particle-freeze exemption DECISION, kept pure (a bare type name, no Godot node) so
    /// <c>HeadlessParticleFreezeExemptionTests</c> can assert it without a live scene tree. True ⇒ the freeze walk
    /// skips this node AND everything under it, so the VFX's own one-shot particles run to <c>finished</c> and it
    /// frees itself. See <see cref="ParticleFreezeExemptScriptTypes"/> for why the exemption exists.
    /// </summary>
    public static bool IsParticleFreezeExemptSubtreeRoot(string typeName)
        => ParticleFreezeExemptScriptTypes.Contains(typeName);

    /// <summary>
    /// The node NAME spirectl gives the throwaway <c>SubViewport</c> it parents onto <c>SceneTree.Root</c> for an
    /// OFF-SCREEN EXTRACTION — a spine-still render, a composed background render, a geometry bake. KEEP IN
    /// LOCKSTEP with spirectl, which stamps it (the same convention the terminal-animation token rule uses across
    /// the two repos): the string is the whole contract, so a rename on either side silently un-exempts the
    /// subtree.
    /// </summary>
    public const string OffscreenExtractionNodeName = "Sts2OffscreenExtraction";

    /// <summary>
    /// Whether this node roots an off-screen EXTRACTION subtree, which all three freeze walks skip wholesale.
    /// </summary>
    /// <remarks>
    /// <para>
    /// THE BUG THIS FIXES IS REACHABLE IN THE SHIPPED PRODUCT, with no env var and no flag. The freezes are not
    /// headless-only (see the "NOT headless-ONLY any more" paragraph on this class): a viewer ticking "freeze
    /// spines" in the browser Settings panel calls <see cref="SetFreezeSpines"/> → <c>EnsureFreezeMachinery</c> →
    /// a rescan-only install → <see cref="FreezeAllSpine"/> on ANY instance, including a WINDOWED host that can
    /// really render. All three walks are an unconditional DFS from <c>SceneTree.Root</c> — not scoped to the main
    /// viewport or to <c>CurrentScene</c>, and a <c>SubViewport</c>'s children are ordinary children — so the walk
    /// reaches the detached rig inside an extraction viewport and sets <c>ProcessMode=Disabled</c>. spine-godot
    /// deforms in <c>NOTIFICATION_INTERNAL_PROCESS</c>, so a frozen rig never re-poses and the extraction captures
    /// a stale pose. In other words: a viewer flipping a panel checkbox can corrupt the host's subsequent spine
    /// still renders. The freeze re-asserts on every rescan, so it is not a race a short render reliably wins.
    /// </para>
    /// <para>
    /// This is NOT about making a <c>--headless</c> bake work. It was measured, and a windowless bake is dead for
    /// an unrelated reason that no process mode can fix (the dummy renderer hands back each mesh surface's
    /// creation-time arrays forever, so the geometry never advances however the rig is posed). Anyone reading
    /// this later should not infer that the exemption enables headless extraction — it does not.
    /// </para>
    /// <para>
    /// SCOPE, guarded honestly. The match is on the NAME, not on the C# type: the node is a plain
    /// <c>SubViewport</c>, so a type match would exempt every off-screen viewport the GAME renders — handing back
    /// exactly the CPU this suspender exists to reclaim, silently. Keying on the name is also what makes ONE rule
    /// cover every extraction site (spirectl parents a viewport onto the root in six places, not just the geometry
    /// baker's) instead of an allow-list that has to chase them. An extraction subtree is nobody's idle-CPU
    /// problem either way: it exists for milliseconds and is freed, which is why all three walks (spine, particles,
    /// decorative) skip it rather than just the spine one.
    /// </para>
    /// <para>
    /// PREFIX-MATCHED, and this is load-bearing rather than lenient. Godot UNIQUIFIES duplicate sibling names, so
    /// a second extraction viewport alive under the root at the same time is not
    /// <c>Sts2OffscreenExtraction</c> — it is <c>Sts2OffscreenExtraction2</c>, or an engine-generated
    /// <c>@Sts2OffscreenExtraction@3</c>. An EXACT match therefore exempts the first and silently freezes the
    /// second, which is the original bug back again, now intermittent and load-dependent. The uniquifier only ever
    /// APPENDS (after at most one leading <c>@</c>), so trimming that one character makes this a plain
    /// <c>StartsWith</c>. This mirrors <c>Spirectl.Sts2.Sts2OffscreenExtraction.IsExtractionSubtreeRoot</c>
    /// EXACTLY — the two are one contract and must answer identically for every input.
    /// </para>
    /// <para>
    /// The scope guard survives the widening: a prefix match still cannot reach "every SubViewport", because the
    /// only names it admits are ones that START with a marker nothing but spirectl stamps.
    /// </para>
    /// </remarks>
    public static bool IsOffscreenExtractionSubtreeRoot(string? nodeName)
    {
        if (string.IsNullOrEmpty(nodeName))
        {
            return false;
        }

        var name = nodeName[0] == '@' ? nodeName[1..] : nodeName;
        return name.StartsWith(OffscreenExtractionNodeName, StringComparison.Ordinal);
    }

    // ---- Runtime control (browser Settings panel via the WS `settings` message) ---------------------------------
    // These flip the always-on freezes / frame-rate at runtime so a viewer can A/B the optimizations from the
    // mirror. Safe from any thread: every Godot touch (ProcessMode / SetProcess / Engine.MaxFps / tree walk) is
    // marshalled onto the game main thread via Callable.From(...).CallDeferred(), exactly like
    // Install/NotifyMainThreadActivity. Turning a freeze OFF resumes the currently-frozen nodes (ProcessMode.Inherit,
    // or SetProcess(true) for the decorative process-only mechanism) and clears the dedup set; turning it ON
    // re-freezes immediately (not just on the next scan) so the effect is instant.
    //
    // ANY instance, not just a headless one. Each setter compares against the EFFECTIVE state (see
    // EffectiveFreezes) rather than the raw flag, and an ON that finds no machinery installs it in rescan-only
    // mode first (EnsureFreezeMachinery) — so the same checkbox works on the host's own windowed game, where it
    // freezes what the host is actually looking at, and keeps working for nodes that spawn afterwards.

    /// <summary>
    /// Toggle the always-on particle freeze at runtime. OFF resumes frozen particle sims; ON re-freezes.
    /// Turning it OFF also drops every pending end-of-burst nudge: those nodes are running their own process
    /// again, so they will end their own cycles (emit the real <c>finished</c>, clear their own <c>Emitting</c>)
    /// and a synthesized one would double-fire the signal.
    /// </summary>
    public static void SetFreezeParticles(bool on)
    {
        if (EffectiveFreezes().Particles == on) return;
        if (on && !EnsureFreezeMachinery()) return;
        _freezeParticles = on;
        // Frozen one-shots owe their listeners a `finished` they can no longer emit; the freeze walk schedules one
        // for the nodes it catches mid-burst, and this hook covers bursts (re)started afterwards. Applied here
        // rather than only in Install because an on-demand install starts with the flag OFF. Idempotent +
        // best-effort.
        if (on) Patches.HeadlessParticleRestartNudgePatch.Apply();
        Callable.From(() =>
        {
            if (RootOrNull() is not { } root) return;
            if (on)
            {
                FreezeAllParticles(root);
            }
            else
            {
                Unfreeze(_particleFrozenIds);
                ClearPendingFinishNudges();
            }
        }).CallDeferred();
    }

    // Drop every queued `finished` emit (used when the particle freeze is turned off at runtime — the nodes own
    // their own `finished` again). Public-adjacent only through SetFreezeParticles; kept separate for clarity.
    private static void ClearPendingFinishNudges()
    {
        int dropped;
        lock (_nudgeGate)
        {
            dropped = _pendingFinishNudges.Count;
            _pendingFinishNudges.Clear();
        }

        if (dropped > 0)
        {
            CouchCoopLog.Info($"[couchcoop][suspend] runtime toggle — dropped {dropped} pending particle finish-nudge(s)");
        }
    }

    /// <summary>Toggle the always-on spine freeze at runtime. OFF resumes frozen skeletons; ON re-freezes.</summary>
    public static void SetFreezeSpines(bool on)
    {
        if (EffectiveFreezes().Spines == on) return;
        if (on && !EnsureFreezeMachinery()) return;
        _freezeSpine = on;
        // A frozen spine never raises the `deathParticles` animation event the beast's death delay waits on, and
        // nothing bounds that wait — so freezing spine ANYWHERE arms the same boss-death deadlock the windowless
        // branch already caps at startup. Apply the cap alongside the
        // freeze that creates the hazard (idempotent; an explicit positive cap override is honoured).
        if (on) Patches.HeadlessDeathDelayCapPatch.Apply();
        Callable.From(() =>
        {
            if (RootOrNull() is not { } root) return;
            if (on) FreezeAllSpine(root);
            else Unfreeze(_spineFrozenIds);
        }).CallDeferred();
    }

    /// <summary>
    /// Toggle the always-on decorative freeze (intent/counter/flame animators) at runtime. OFF resumes BOTH
    /// mechanisms — ProcessMode=Inherit for the whole-node freezes (which also un-pauses their self-bound tween
    /// chains) and SetProcess(true) for the process-only ones; ON re-freezes immediately.
    /// </summary>
    public static void SetFreezeDecor(bool on)
    {
        if (EffectiveFreezes().Decor == on) return;
        if (on && !EnsureFreezeMachinery()) return;
        _freezeDecor = on;
        Callable.From(() =>
        {
            if (RootOrNull() is not { } root) return;
            if (on)
            {
                FreezeDecorativeAnimators(root);
            }
            else
            {
                Unfreeze(_decorativeFrozenIds);
                UnfreezeProcess(_decorativeProcessFrozenIds);
            }
        }).CallDeferred();
    }

    /// <summary>
    /// Set the ACTIVE (non-idle) game frame-rate cap. This is the mirror's "refresh rate": it caps how often the
    /// headless game processes, which bounds how often the scene changes and how quickly input→frame round-trips.
    /// The idle throttle still applies its own lower cap when idle. No-op for non-positive values.
    /// </summary>
    public static void SetBaselineMaxFps(int fps)
    {
        if (fps <= 0) return;
        Callable.From(() =>
        {
            // Mark captured so the first Tick doesn't overwrite our chosen baseline with the engine default.
            _baselineCaptured = true;
            _baselineMaxFps = fps;
            // Apply now unless we're currently idle-throttled (RestoreFps will apply this baseline on the next
            // activity). Setting Engine.MaxFps directly here would fight the throttle.
            if (!_fpsThrottled)
            {
                Engine.MaxFps = fps;
            }
        }).CallDeferred();
    }

    /// <summary>
    /// The host's real ACTIVE frame-rate baseline (the mirror "refresh rate"), for reporting a TRUTHFUL panel label.
    /// Returns the tracked baseline once it's known (<see cref="_baselineCaptured"/> — a headless client that has
    /// ticked, or any instance after <see cref="SetBaselineMaxFps"/>), which is the UN-throttled value, not the idle
    /// cap of 8. Otherwise — the desktop host, where the suspender is never installed nor ticked (Install is gated on
    /// IsHeadlessClient) so no baseline was captured — reads the live <see cref="Engine.MaxFps"/> (the game's real
    /// FpsLimit) on the game main thread. 0 means unlimited/vsync; callers map that as they see fit.
    ///
    /// Main-thread-safe: the live read is marshalled via the same <c>Callable.From(...).CallDeferred()</c> idiom
    /// used across this file, with a TaskCompletionSource fallback (mirrors
    /// <c>CouchCoopWebSocketConnection.AnswerMainThreadPingAsync</c>). In a unit test with no SceneTree/main loop the
    /// deferred call can't run, so it resolves immediately to the (uncaptured) <see cref="_baselineMaxFps"/> = 0 —
    /// callers then emit null and nothing breaks.
    /// </summary>
    public static async Task<int> GetEffectiveBaselineMaxFpsAsync()
    {
        // Fast path: a known baseline needs no main-thread hop (plain advisory field read). Covers every headless
        // client (ticked, or after SetBaselineMaxFps) — return the un-throttled baseline even while idle-throttled.
        if (_baselineCaptured)
        {
            return _baselineMaxFps;
        }

        // Desktop host / not-yet-ticked: read the live Engine.MaxFps on the game main thread.
        var tcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            Callable.From(() => tcs.TrySetResult(Engine.MaxFps)).CallDeferred();
        }
        catch
        {
            tcs.TrySetResult(_baselineMaxFps); // no game main loop (e.g. tests) → resolve to the uncaptured baseline (0)
        }

        try
        {
            // Backstop so a stuck/paused main loop never leaks the read forever.
            return await tcs.Task.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
        }
        catch
        {
            return _baselineMaxFps; // timed out — fall back to the uncaptured baseline (0 → caller emits null)
        }
    }

    // Resume a set of frozen nodes: restore ProcessMode to Inherit (the default the freeze overwrote) and clear the
    // dedup set so a later re-enable freezes them again. Runs on the main thread (called from the deferred setters).
    private static void Unfreeze(HashSet<ulong> frozenIds)
    {
        var resumed = 0;
        foreach (var id in frozenIds)
        {
            if (GodotObject.InstanceFromId(id) is Node node && GodotObject.IsInstanceValid(node))
            {
                node.ProcessMode = Node.ProcessModeEnum.Inherit;
                resumed++;
            }
        }

        frozenIds.Clear();
        if (resumed > 0)
        {
            CouchCoopLog.Info($"[couchcoop][suspend] runtime toggle — resumed {resumed} frozen node(s)");
        }
    }

    // Twin of Unfreeze for the ProcessOnly mechanism: restore the `_Process`/`_PhysicsProcess` callbacks the freeze
    // cleared (ProcessMode was never touched, so there is nothing to restore there) and clear the dedup set so a
    // later re-enable freezes them again. Runs on the main thread (called from the deferred setter).
    private static void UnfreezeProcess(HashSet<ulong> frozenIds)
    {
        var resumed = 0;
        foreach (var id in frozenIds)
        {
            if (GodotObject.InstanceFromId(id) is Node node && GodotObject.IsInstanceValid(node))
            {
                node.SetProcess(true);
                node.SetPhysicsProcess(true);
                resumed++;
            }
        }

        frozenIds.Clear();
        if (resumed > 0)
        {
            CouchCoopLog.Info($"[couchcoop][suspend] runtime toggle — resumed _process on {resumed} decorative node(s)");
        }
    }

    private static Node? RootOrNull()
        => Engine.GetMainLoop() is SceneTree { Root: { } root } && GodotObject.IsInstanceValid(root) ? root : null;
}
