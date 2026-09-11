// WS-perf3 — continuous-render-node budget (adaptive flame-fidelity throttle).
//
// The Tezcatara "ancient" event mounts ~166 continuous GPU-particle emitters (the lava/fire atmosphere — the
// `render[continuous=166]` term in M3_WALK), an order of magnitude more than a normal combat (~29-30). On a weak
// PHONE GPU that additive fire overdraw is fill-bound and drags the frame to 9-14fps; the user has approved
// degrading the flames' fidelity to recover it. (Measured honestly: on a DESKTOP RTX 2060 the same scene is NOT
// fill-bound — degrading the flames there saves ~nothing because that GPU eats the overdraw trivially and the
// 2255x1080 Xvfb repro is dominated by a window-present artifact, not the scene. This lever targets the phone's
// overdraw, so its win shows on-device / on a fill-bound GPU, not on the desktop harness. See the round report.)
//
// Mechanism: when the count of continuous PARTICLE emitters exceeds a HIGH threshold we ENGAGE and multiply every
// Dynamic emitter's AmountRatio by a Floor (fewer live particles ⇒ proportionally less overdraw), leaving the
// emitters ALIVE and animating (a thinner, still-flickering fire — the user-approved degrade, NOT a frozen Static
// pose). AmountRatio is a cheap runtime property (no emitter rebuild, fully reversible). We DISENGAGE below a LOW
// threshold (hysteresis ⇒ no oscillation). Combat's ~30 emitters sit safely below LOW, so the lever never touches a
// normal fight. Throttling AmountRatio does NOT drop the continuous registration (each emitter stays 1 continuous),
// so the engaged count stays high and the state is stable.
//
// Godot-free static (exactly like RenderActivity / IdleSuspend / ClientEffectSettings): the reconciler polls
// Evaluate() each tick and, on a state flip (Generation bump), re-Applies every live view through the SAME
// RefreshEffects path an effect-mode flip uses, so ParticleAttachment.Configure re-reads Multiplier. New emitters
// mounting while engaged read Multiplier directly in Configure.
//

namespace CouchCoop.GodotClient.Scene;

public static class ContinuousBudget
{
    // This current policy brackets normal combat below Low and high-overdraw scenes above High.
    public const int High = 64;
    public const int Low = 40;

    // AmountRatio multiplier applied to every Dynamic particle emitter while engaged (the fill/overdraw throttle).
    // 1 ⇒ no degrade (a no-op engage); 0.4 ⇒ 60% fewer particles.
    public const float Floor = 0.4f;

    // True while the throttle is active (hysteretic). Read by ParticleAttachment.Configure via Multiplier.
    public static bool Engaged { get; private set; }

    // Bumped on every engage/disengage flip; the reconciler polls it (like ClientEffectSettings.Generation) and
    // re-Applies live views on a change so the multiplier reaches already-mounted emitters.
    public static int Generation { get; private set; }

    // The AmountRatio multiplier ParticleAttachment.Configure applies to a Dynamic emitter's spec AmountRatio.
    public static float Multiplier => Engaged ? Floor : 1f;

    // Telemetry (M3_WALK + QaState): the last particle-continuous count Evaluate saw.
    public static int LastCount { get; private set; }

    // Called once per reconciler tick with the live particle-continuous count. Applies hysteresis and bumps
    // Generation on a state change.
    public static void Evaluate(int particleContinuous)
    {
        LastCount = particleContinuous;
        bool next = Engaged;
        if (!Engaged && particleContinuous > High)
        {
            next = true;
        }
        else if (Engaged && particleContinuous < Low)
        {
            next = false;
        }

        if (next != Engaged)
        {
            Engaged = next;
            Generation++;
            Godot.GD.Print($"M3_BUDGET: {(Engaged ? "engaged" : "disengaged")} particleContinuous={particleContinuous} " +
                           $"high={High} low={Low} floor={Floor:0.##} multiplier={Multiplier:0.##}");
        }
    }

    // Back-to-menu teardown: clear state so the rebuilt stack starts disengaged (AppShell calls this alongside
    // RenderActivity.Reset / IdleSuspend.Reset). Generation is NOT reset toward the reconciler's applied value here;
    // a fresh reconciler seeds its own _appliedBudgetGen from the current Generation in its ctor, so leaving
    // Generation monotonic is harmless. We still zero it for a clean session snapshot.
    public static void Reset()
    {
        Engaged = false;
        Generation = 0;
        LastCount = 0;
    }

}
