using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for EffectMath — the pure math backing WS-J's native cosmetic effects (intent-glyph frame cycling,
// enemy-intent bob wave, orb spin). These pin the native twins of frontend/src/mirror/mirrorRenderer.ts's
// intentFrameIndex, the intent bob sine, and the presentation ROTATE spin, so a native/web drift is caught by the
// Exe runner.
internal static class IntentMathTests
{
    public static void Run()
    {
        IntentFrameIndexDegenerate();
        IntentFrameIndexFloorModMatchesWeb();
        IntentFrameIndexWrapsAtCount();
        BobPhaseSeedsLeftToRightWave();
        BobOffsetHitsSineExtrema();
        BobOffsetDiffersAcrossHalfPeriod();
        SpinAngleWrapsPerPeriod();
        SpinLayer3IsTwiceLayer2Rate();
        SpinPeriodResolvesEnergyCounterLayers();
        SpinPeriodResolvesStarCounterByChildIndex();
        SpinPeriodRejectsNonRotationLayers();
    }

    private const double Tau = 2.0 * System.Math.PI;

    // ≤1 frame, non-positive fps/elapsed, and non-finite elapsed all collapse to frame 0 (the web guard).
    private static void IntentFrameIndexDegenerate()
    {
        Check.Equal(EffectMath.IntentFrameIndex(500, 15, 1), 0, "single-frame → 0");
        Check.Equal(EffectMath.IntentFrameIndex(500, 15, 0), 0, "zero-frame → 0");
        Check.Equal(EffectMath.IntentFrameIndex(500, 0, 30), 0, "zero fps → 0");
        Check.Equal(EffectMath.IntentFrameIndex(500, -15, 30), 0, "negative fps → 0");
        Check.Equal(EffectMath.IntentFrameIndex(0, 15, 30), 0, "zero elapsed → 0");
        Check.Equal(EffectMath.IntentFrameIndex(-100, 15, 30), 0, "negative elapsed → 0");
        Check.Equal(EffectMath.IntentFrameIndex(double.NaN, 15, 30), 0, "NaN elapsed → 0");
        Check.Equal(EffectMath.IntentFrameIndex(double.PositiveInfinity, 15, 30), 0, "Inf elapsed → 0");
    }

    // floor(elapsedMs/1000 * fps) mod count — same values the web intentFrameIndex yields (fps 15, the recording's).
    private static void IntentFrameIndexFloorModMatchesWeb()
    {
        // 100ms @ 15fps = floor(1.5) = 1.
        Check.Equal(EffectMath.IntentFrameIndex(100, 15, 30), 1, "100ms@15fps → frame 1");
        // 66ms = floor(0.99) = 0; 67ms = floor(1.005) = 1 (the ~15fps step).
        Check.Equal(EffectMath.IntentFrameIndex(66, 15, 30), 0, "66ms@15fps → frame 0");
        Check.Equal(EffectMath.IntentFrameIndex(67, 15, 30), 1, "67ms@15fps → frame 1");
        // 1000ms @ 15fps = floor(15) = 15.
        Check.Equal(EffectMath.IntentFrameIndex(1000, 15, 30), 15, "1000ms@15fps → frame 15");
        // 45-frame 'defend' set at 3000ms = floor(45) = 45 → wraps to 0.
        Check.Equal(EffectMath.IntentFrameIndex(3000, 15, 45), 0, "one full defend cycle wraps to 0");
    }

    private static void IntentFrameIndexWrapsAtCount()
    {
        // 30-frame buff at 2000ms = floor(30) % 30 = 0; 2066ms still floor(30.99)=30 → 0; 2134ms floor(32.01)=32 → 2.
        Check.Equal(EffectMath.IntentFrameIndex(2000, 15, 30), 0, "2000ms buff wraps to 0");
        Check.Equal(EffectMath.IntentFrameIndex(2066, 15, 30), 0, "2066ms buff still 0");
        Check.Equal(EffectMath.IntentFrameIndex(2134, 15, 30), 2, "2134ms buff → frame 2");
    }

    // Phase = −(globalX/1920)·period: a leaf further right gets a more-negative phase (later in the wave), so adjacent
    // intents bob as a wave, not lockstep. x=0 → 0; x=1920 → −period; x=960 → −period/2.
    private static void BobPhaseSeedsLeftToRightWave()
    {
        Check.Close(EffectMath.BobPhaseMs(0, 2000), 0, "x=0 → phase 0");
        Check.Close(EffectMath.BobPhaseMs(1920, 2000), -2000, "x=1920 → phase -period");
        Check.Close(EffectMath.BobPhaseMs(960, 2000), -1000, "x=960 → phase -period/2");
    }

    // baseline + amp·sin(2π·frac): frac 0 → baseline; 0.25 → baseline+amp (top); 0.5 → baseline; 0.75 → baseline−amp.
    private static void BobOffsetHitsSineExtrema()
    {
        const double period = 2000, amp = 10, baseline = -8;
        Check.Close(EffectMath.BobOffsetY(0, 0, period, amp, baseline), baseline, "frac 0 → baseline");
        Check.Close(EffectMath.BobOffsetY(period * 0.25, 0, period, amp, baseline), baseline + amp, "frac .25 → baseline+amp");
        Check.Close(EffectMath.BobOffsetY(period * 0.5, 0, period, amp, baseline), baseline, "frac .5 → baseline", 1e-9);
        Check.Close(EffectMath.BobOffsetY(period * 0.75, 0, period, amp, baseline), baseline - amp, "frac .75 → baseline-amp");
        // Full period returns to baseline (large-t precision guard: mod-1 reduction keeps sin exact).
        Check.Close(EffectMath.BobOffsetY(period * 1000.0, 0, period, amp, baseline), baseline, "large t returns to baseline", 1e-6);
    }

    // The gate's bob shots are ~1s apart on a 2000ms period (half-period) — the offset MUST differ meaningfully.
    private static void BobOffsetDiffersAcrossHalfPeriod()
    {
        const double period = 2000, amp = 10, baseline = -8;
        double a = EffectMath.BobOffsetY(500, 0, period, amp, baseline); // frac .25 → top (baseline+amp)
        double b = EffectMath.BobOffsetY(1500, 0, period, amp, baseline); // frac .75 → bottom (baseline−amp)
        Check.That(System.Math.Abs(a - b) > amp, "half-period apart differs by > amp");
    }

    // A full 2π turn every period: t=0 → 0; t=period/4 → π/2; t=period/2 → π; t=period → 0 (wraps).
    private static void SpinAngleWrapsPerPeriod()
    {
        const double period = 12566;
        Check.Close(EffectMath.SpinRadians(0, period), 0, "t=0 → 0");
        Check.Close(EffectMath.SpinRadians(period * 0.25, period), Tau * 0.25, "quarter → π/2");
        Check.Close(EffectMath.SpinRadians(period * 0.5, period), Tau * 0.5, "half → π");
        Check.Close(EffectMath.SpinRadians(period, period), 0, "full period wraps to 0", 1e-9);
        Check.Close(EffectMath.SpinRadians(period * 5.5, period), Tau * 0.5, "5.5 periods → π (mod)", 1e-6);
    }

    // Layer3 (6283ms) spins at twice Layer2's (12566ms) angular rate: same t → double the angle (mod 2π).
    private static void SpinLayer3IsTwiceLayer2Rate()
    {
        double t = 1570.75; // ~Layer2 quarter turn
        double layer2 = EffectMath.SpinRadians(t, 12566);
        double layer3 = EffectMath.SpinRadians(t, 6283);
        Check.Close(layer2, Tau * (t / 12566.0), "layer2 angle", 1e-9);
        Check.Close(layer3, Tau * (t / 6283.0), "layer3 angle", 1e-9);
        Check.Close(layer3, 2.0 * layer2, "layer3 rate = 2× layer2", 1e-9);
    }

    // ---- SpinPeriodMs: scene-relative path → one-turn period (twin of animAttributes.ts spinDurationMs) ----------
    // `%RotationLayers` children spin at a rate proportional to the CHILD INDEX, so the period depends on the
    // child's ORDINAL, not on its leaf number. Energy counters number them from Layer2; the star counter from
    // Layer1 — which is why a leaf-number-only rule mis-bound the star counter (round-8 item 6, secondary defect).

    // ironclad/silent/defect/regent: Layers/RotationLayers/{Layer2,Layer3} = child indices 0,1 → 1× and 2×.
    private static void SpinPeriodResolvesEnergyCounterLayers()
    {
        Check.Close(EffectMath.SpinPeriodMs("EnergyCounter/Layers/RotationLayers/Layer2") ?? -1, 12566,
            "energy counter Layer2 (child 0) = one turn / 12566ms");
        Check.Close(EffectMath.SpinPeriodMs("EnergyCounter/Layers/RotationLayers/Layer3") ?? -1, 6283,
            "energy counter Layer3 (child 1) = 2× → 6283ms");

        // necrobinder_energy_counter has ONE rotation layer; its `Layers/Layer3` is a SIBLING of RotationLayers.
        Check.Equal(EffectMath.SpinPeriodMs("NecrobinderEnergyCounter/Layers/Layer3") is null, true,
            "necrobinder Layers/Layer3 is not a RotationLayers child → no spin");
        Check.Close(EffectMath.SpinPeriodMs("NecrobinderEnergyCounter/Layers/RotationLayers/Layer2") ?? -1, 12566,
            "necrobinder's single rotation layer still spins at the child-0 rate");
    }

    // star_counter.tscn: Icon/RotationLayers/{Layer1,Layer2} = child indices 0,1. `Layer2` is the SECOND child here
    // (2×) even though the identically-named leaf is the FIRST child (1×) in an energy counter.
    private static void SpinPeriodResolvesStarCounterByChildIndex()
    {
        Check.Close(EffectMath.SpinPeriodMs("StarCounter/Icon/RotationLayers/Layer1") ?? -1, 12566,
            "star counter Layer1 (child 0) = one turn / 12566ms — previously unbound entirely");
        Check.Close(EffectMath.SpinPeriodMs("StarCounter/Icon/RotationLayers/Layer2") ?? -1, 6283,
            "star counter Layer2 (child 1) = 2× → 6283ms — previously bound at the 1× rate");
    }

    private static void SpinPeriodRejectsNonRotationLayers()
    {
        Check.Equal(EffectMath.SpinPeriodMs(null) is null, true, "null path → no spin");
        Check.Equal(EffectMath.SpinPeriodMs("SomeButton/Label") is null, true, "unrelated path → no spin");
        Check.Equal(EffectMath.SpinPeriodMs("Foo/Layers/RotationLayers/Layer2/Sprite") is null, true,
            "a CHILD of a rotation layer does not itself spin");
        Check.Equal(EffectMath.SpinPeriodMs("Foo/Layers/RotationLayers/Layer2x") is null, true,
            "trailing non-digits do not parse as a layer number");
        Check.Equal(EffectMath.SpinPeriodMs("Foo/Mystery/RotationLayers/Layer2") is null, true,
            "unknown owning container → ordinal is underivable → no spin");
        Check.Equal(EffectMath.SpinPeriodMs("/RotationLayers/Layer2") is null, true,
            "no owning container segment → no spin");
        Check.Equal(EffectMath.SpinPeriodMs("Foo/Icon/RotationLayers/Layer0") is null, true,
            "a leaf number below the container's first layer → no spin");
    }
}
