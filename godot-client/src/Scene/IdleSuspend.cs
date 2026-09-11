// Track I — idle-animation suspend (the on-demand renderer's missing "reach Disabled" lever).
//
// The on-demand mirror stage (RenderActivity + AppShell.UpdateRenderStageActivity) already skips rendering an idle
// SubViewport frame. But in an idle COMBAT the stage never actually reaches idle: the enemy-intent bob / orb spin
// cosmetic tickers Mark() every frame, the intent-frame ticker Marks, a looping spine clip Marks on every frame
// change, and Dynamic particles / TIME-driven shaders hold a RenderActivity continuous registration. So the grace
// window and continuous count are pinned > 0 forever and the SubViewport renders 60fps for zero visible change —
// the phone burns GPU/battery on a static screen.
//
// This static core is the "should we be frozen and what's the state" oracle for IdleSuspendController: after N idle
// seconds (no drain, no input, no live tween) the controller sweeps every live view and FREEZES each continuous
// animator in place (SetProcess(false) on the wall-clock tickers, SpeedScale=0 + drop-continuous on particles, a
// TIME-frozen shader swap + drop-continuous on shaders). ContinuousCount then falls to 0 and the per-frame Marks
// stop, so the EXISTING UpdateRenderStageActivity reaches its heartbeat/Disabled path naturally (this file adds NO
// RenderActivity logic of its own). Every wake seam (a drain, real/QA input, an effect-mode flip, a wide-screen
// relayout, the --shot Hold) resumes all frozen animators — phase-correct — before anything re-renders.
//
// Godot-free static (exactly like RenderActivity / ClientEffectSettings) except the wall-clock stamp helpers, so
// AppShell's status JSON and the controller read it without threading a handle. Kill switches (read ONCE, repo env
// Idle suspension uses a five-second threshold.

namespace CouchCoop.GodotClient.Scene;

public static class IdleSuspend
{

    // The freeze sweep covers effects live at the idle transition. Effects that mount or reconfigure later must
    // observe this state, register as suspended instead of continuous, and enroll for the controller's low-cadence
    // re-sweep.
    public static readonly double IdleSeconds = 5;

    // Wall-clock stamps (Time.GetTicksMsec scale). LastInputMs: last real/QA input (InputRouter + DemoInputPlayer).
    // LastDrainMs: last store drain (the controller's OnDrained). The controller's poll treats now − max(both) ≥ N as
    // idle.
    public static double LastInputMs;
    public static double LastDrainMs;

    // While Hold is set (the --shot capture-settle owns the frame and MUST render every frame) the controller never
    // suspends and resumes immediately. AppShell keeps it in lockstep with _capturePending.
    public static bool Hold;

    // True between a Freeze and its Resume. Read by AppShell's status JSON + the controller's wake seams.
    public static bool Suspended { get; private set; }

    // The Time.GetTicksMsec at the last Freeze (for the resumed frozenMs telemetry).
    public static double SuspendStartMs { get; private set; }

    // Session counters (surfaced in the status JSON + BENCH_RESULT; cleared on ReturnToMenu via Reset).
    public static long SuspendedTotal { get; private set; }
    public static long ResumedTotal { get; private set; }
    public static double CumulativeSuspendedMs { get; private set; }

    // Stamp an input event (InputRouter._UnhandledInput + DemoInputPlayer's injection verbs).
    public static void NotifyInput() => LastInputMs = Godot.Time.GetTicksMsec();

    // The controller calls these around its Freeze/Resume sweeps so the counters + Suspended flag live in ONE place
    // (AppShell reads them statically, without a controller reference).
    public static void RecordSuspended()
    {
        Suspended = true;
        SuspendStartMs = Godot.Time.GetTicksMsec();
        SuspendedTotal++;
    }

    public static void RecordResumed()
    {
        if (!Suspended)
        {
            return;
        }

        Suspended = false;
        CumulativeSuspendedMs += Godot.Time.GetTicksMsec() - SuspendStartMs;
        ResumedTotal++;
    }

    // ReturnToMenu teardown: clear every counter + the suspended flag so the rebuilt stack starts clean (AppShell
    // calls this alongside RenderActivity.Reset). The fresh controller re-stamps LastInput/LastDrain in _Ready.
    public static void Reset()
    {
        Suspended = false;
        SuspendStartMs = 0;
        LastInputMs = 0;
        LastDrainMs = 0;
        Hold = false;
        SuspendedTotal = 0;
        ResumedTotal = 0;
        CumulativeSuspendedMs = 0;
    }

}
