// On-demand mirror-stage rendering (CPU-for-GPU trade). The mirror scene renders into AppShell's render-scale
// SubViewport, whose RenderTargetUpdateMode used to be Always: the ENTIRE mirrored tree re-rasterized every frame
// forever, even on a static screen (a map, a shop, a paused combat), burning GPU/battery for zero visible change. The
// parent SubViewportContainer keeps blitting the LAST rendered texture when the SubViewport is Disabled, and ALL the
// UI chrome (join/lobby SPA shell, letterboxing, latency overlay) lives in the ROOT viewport — never inside this
// SubViewport — so leaving the stage un-rendered on an idle frame is invisible to the user; only the game scene
// pauses its re-raster.
//
// This static tracker is the "is the stage visually alive THIS frame?" oracle AppShell reads each _Process to decide
// whether to render the SubViewport (Always) or leave it Disabled. It is deliberately Godot-FREE (a plain static
// class, exactly like ClientEffectSettings) so every producer of visual change — MirrorNodeView setters, the effect
// attachments, the reconciler — can Mark()/AddContinuous() without a Godot dependency, and AppShell owns the actual
// SubViewport.RenderTargetUpdateMode write + the heartbeat timer.
//
// TWO liveness sources, because visual change reaches us two different ways:
//
//   1. Mark() — an EDGE signal: "a C# code path changed a pixel this frame" (a QueueRedraw, a transform re-fold, a
//      texture arrival, a drained delta, a tween tick's settle, a stage resize). Because async work (texture decode,
//      shader compile, a settling tween's Finished callback) can land a frame or two AFTER the last Mark, a Mark keeps
//      the stage alive for a GRACE window of GraceFrames frames, not just the marked frame. A steadily-animating C#
//      ticker (the intent bob / orb spin) Marks every frame it moves — even while the SubViewport is render-Disabled
//      its _Process still runs (Godot keeps processing nodes in a non-rendering SubViewport), so its setter Marks keep
//      the grace window topped up and the stage renders continuously while it visibly animates. That is the intended
//      mechanism; there is deliberately NO separate "is a ticker animating" flag.
//
//   2. Continuous counters — a LEVEL signal for GPU-driven animators that emit NO per-frame C# signal at all: a
//      Dynamic-mode particle emitter (the GPU simulates it; C# never hears a frame tick) and a Dynamic-mode shader
//      whose source references TIME / a screen read (the fragment output changes every frame with zero C# callback).
//      These call AddContinuous() while mounted-and-live and RemoveContinuous() on unmount / mode-flip / freeze; while
//      the count is > 0 the stage is force-alive. (A Static-mode particle is SpeedScale=0 → frozen → NOT continuous; a
//      Static-mode shader is TIME-frozen → NOT continuous; a Spine clip drives frame changes through a C# QueueRedraw,
//      so it Marks and needs no continuous entry.)
//
// AppShell folds in two more alive sources it owns directly (a running Godot Tween via TweenReplayer.ActiveCount, and
// the --shot capture-settle which MUST render), plus a once-per-second HEARTBEAT while otherwise-idle so any visual
// change that slipped past both signals self-heals within a second.
//
// FALSE-ALIVE IS SAFE, FALSE-IDLE IS THE BUG: over-rendering an idle frame merely spends the GPU we were spending
// before; skipping a frame that actually changed shows a stale image. Every judgement call here errs toward alive.
//

namespace CouchCoop.GodotClient.Scene;

public static class RenderActivity
{
    // Track I telemetry: the ONLY two liveness categories that use the continuous (LEVEL) signal — a Dynamic-mode
    // particle emitter and a Dynamic-mode TIME/screen-read shader. Everything else (bob/spin cosmetic, intent frames,
    // spine clips) drives the stage via the Mark() grace window, and a running Godot Tween is folded in by AppShell
    // (TweenReplayer.ActiveCount) — none of those are counted here. Splitting the count by category is what localizes
    // the on-device "idleSuspended=true yet renderStageContinuous stayed 18" gap: a late-mounting effect re-registered
    // continuous behind the suspend controller's back, and this shows WHETHER those were particles or shaders.
    public enum ContinuousCategory
    {
        Particle,
        Shader,
    }

    // Keep rendering this many frames after the LAST Mark so async settle (texture decode / shader compile / a
    // tween's Finished re-apply landing a frame or two late) still paints. ~8 frames ≈ 130ms at 60fps.
    private const int GraceFrames = 8;

    // Frames remaining in the current grace window (refilled to GraceFrames by Mark, decayed one per frame by
    // BeginFrame). > 0 ⇒ a recent Mark keeps the stage alive.
    private static int _graceRemaining;

    // Live GPU-driven animators (Dynamic particles / TIME|screen-read shaders) with no per-frame C# signal, split by
    // category (the aggregate ContinuousCount is their sum). While the sum is > 0 the stage is force-alive. Each is
    // guarded against underflow so a late _ExitTree RemoveContinuous after Reset can't drive it negative.
    private static int _continuousParticle;
    private static int _continuousShader;

    // Telemetry (surfaced in M3_WALK + BENCH_RESULT; cleared on Reset). renderedFrames = frames the stage rendered
    // (Always or a heartbeat Once); skippedFrames = frames it stayed Disabled (the win). Only advanced while the
    // feature is Enabled (AppShell records nothing on the plain-Always kill-switch path).
    public static long RenderedFrames { get; private set; }
    public static long SkippedFrames { get; private set; }

    // A pixel changed via a C# path this frame — refill the grace window.
    public static void Mark() => _graceRemaining = GraceFrames;

    // A GPU-driven animator became live / stopped. Paired + category-tagged; the underflow guard tolerates a stray
    // Remove after Reset. The category is telemetry-only (both categories force the stage alive identically).
    public static void AddContinuous(ContinuousCategory cat)
    {
        if (cat == ContinuousCategory.Particle)
        {
            _continuousParticle++;
        }
        else
        {
            _continuousShader++;
        }
    }

    public static void RemoveContinuous(ContinuousCategory cat)
    {
        if (cat == ContinuousCategory.Particle)
        {
            if (_continuousParticle > 0)
            {
                _continuousParticle--;
            }
        }
        else if (_continuousShader > 0)
        {
            _continuousShader--;
        }
    }

    public static int ContinuousCount => _continuousParticle + _continuousShader;

    // Per-category continuous counts (surfaced in QaStateJson renderStageContinuousByCat + the M3_WALK log). These are
    // the diagnostic that tells the device pass WHICH category holds a residual continuous while idleSuspended=true.
    public static int ContinuousParticle => _continuousParticle;
    public static int ContinuousShader => _continuousShader;

    // Call ONCE per AppShell frame BEFORE reading AliveByMarkOrContinuous — decays the grace window. Marks landing
    // later in the same frame (a drain, a ticker's _Process) refill it, so the decay-then-decide-then-mark order over
    // a run of frames yields exactly "render for GraceFrames frames after the final Mark".
    public static void BeginFrame()
    {
        if (_graceRemaining > 0)
        {
            _graceRemaining--;
        }
    }

    // The two tracker-owned alive sources. AppShell ORs in TweenReplayer.ActiveCount > 0 and the --shot capture-settle.
    public static bool AliveByMarkOrContinuous => _graceRemaining > 0 || ContinuousCount > 0;

    public static void RecordRendered() => RenderedFrames++;

    public static void RecordSkipped() => SkippedFrames++;

    // Back-to-menu teardown / fresh stage mount: clear every counter so the rebuilt stack starts clean (AppShell calls
    // this alongside WalkProfiler.Reset). The continuous count is zeroed here; the RemoveContinuous underflow guard
    // makes a node's later _ExitTree release a harmless no-op regardless of teardown ordering.
    public static void Reset()
    {
        _graceRemaining = 0;
        _continuousParticle = 0;
        _continuousShader = 0;
        RenderedFrames = 0;
        SkippedFrames = 0;
    }
}
