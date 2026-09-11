using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for the Q1 Tezcatara candle-fire math (EffectMath.FlameScaleY / FlameSkew / FlamePhaseMs) — the pure
// port backing CosmeticAnimator's flame ticker. Pins the two sine tracks (scaleY ±8% ~1.7s, skew ±0.1rad ~2.6s)
// and the per-flame FNV-1a phase hash, which is a byte-for-byte TWIN of the web `flamePhaseMs`
// (frontend/src/mirror/animAttributes.ts) — the pinned values here equal the ones the web vitest asserts, so a
// native/web drift is caught by the Exe runner.
internal static class FlameMathTests
{
    private const double Tau = 2.0 * System.Math.PI;

    // The amplitudes CosmeticAnimator passes (private consts there): scaleY ±8%, skew ±0.1rad.
    private const double ScaleAmp = 0.08;
    private const double SkewAmp = 0.1;
    private const double ScalePeriod = 1700.0;
    private const double SkewPeriod = 2600.0;

    public static void Run()
    {
        ScaleYCentresOnOneAndHitsExtrema();
        ScaleYReturnsToOneOverAFullPeriod();
        SkewCentresOnZeroAndHitsExtrema();
        DegeneratePeriodsCollapseToIdentity();
        PhaseIsStableInRange();
        PhaseMatchesWebTwinValues();
        PhaseSharedByParentDesyncedAcrossFlames();
        // WS-flameperf: the fold matrix (== the old draw matrix) + the reduced-rate ticker gate.
        FlameMatrixIsIdentityAtRest();
        FlameMatrixKeepsBottomCenterPivotFixed();
        FlameMatrixMatchesTheDrawBasisAndOrigin();
        ReducedRateAccumulatorGatesTicks();
        ReducedRateDegenerateIntervalNeverThrottles();
    }

    // 1 + amp·sin(2π·frac): frac 0 → 1; .25 → 1+amp (peak); .5 → 1; .75 → 1−amp (trough). Centred on 1.0.
    private static void ScaleYCentresOnOneAndHitsExtrema()
    {
        Check.Close(EffectMath.FlameScaleY(0, 0, ScalePeriod, ScaleAmp), 1.0, "frac 0 → 1");
        Check.Close(EffectMath.FlameScaleY(ScalePeriod * 0.25, 0, ScalePeriod, ScaleAmp), 1.0 + ScaleAmp, "frac .25 → 1+amp");
        Check.Close(EffectMath.FlameScaleY(ScalePeriod * 0.5, 0, ScalePeriod, ScaleAmp), 1.0, "frac .5 → 1", 1e-9);
        Check.Close(EffectMath.FlameScaleY(ScalePeriod * 0.75, 0, ScalePeriod, ScaleAmp), 1.0 - ScaleAmp, "frac .75 → 1-amp");
    }

    // A full period returns to 1.0, and a large wall-clock t keeps precision (mod-1 reduction).
    private static void ScaleYReturnsToOneOverAFullPeriod()
    {
        Check.Close(EffectMath.FlameScaleY(ScalePeriod, 0, ScalePeriod, ScaleAmp), 1.0, "full period → 1", 1e-9);
        Check.Close(EffectMath.FlameScaleY(ScalePeriod * 1000.0, 0, ScalePeriod, ScaleAmp), 1.0, "large t → 1", 1e-6);
        // A phase offset shifts the cycle: phase == period/4 at t=0 → the .25 peak.
        Check.Close(EffectMath.FlameScaleY(0, ScalePeriod * 0.25, ScalePeriod, ScaleAmp), 1.0 + ScaleAmp, "phase .25 → peak at t0");
    }

    // amp·sin(2π·frac), centred on 0: frac 0 → 0; .25 → amp; .75 → −amp.
    private static void SkewCentresOnZeroAndHitsExtrema()
    {
        Check.Close(EffectMath.FlameSkew(0, 0, SkewPeriod, SkewAmp), 0.0, "frac 0 → 0");
        Check.Close(EffectMath.FlameSkew(SkewPeriod * 0.25, 0, SkewPeriod, SkewAmp), SkewAmp, "frac .25 → +amp");
        Check.Close(EffectMath.FlameSkew(SkewPeriod * 0.75, 0, SkewPeriod, SkewAmp), -SkewAmp, "frac .75 → -amp");
    }

    // Non-positive periods return identity (scaleY 1, skew 0) — no divide-by-zero, no NaN.
    private static void DegeneratePeriodsCollapseToIdentity()
    {
        Check.Close(EffectMath.FlameScaleY(500, 0, 0, ScaleAmp), 1.0, "zero period scaleY → 1");
        Check.Close(EffectMath.FlameSkew(500, 0, 0, SkewAmp), 0.0, "zero period skew → 0");
    }

    // The phase seed lives in [0, FlamePhaseModMs) for any parent path.
    private static void PhaseIsStableInRange()
    {
        foreach (var p in new[] { "", "a", "Fires/SteppedFireTezcatara3", "EventBg/pink4/child" })
        {
            double ph = EffectMath.FlamePhaseMs(p);
            Check.That(ph >= 0 && ph < EffectMath.FlamePhaseModMs, $"phase in range for '{p}'");
        }
    }

    // The pinned values equal the web `flamePhaseMs` twin (animAttributes.ts) — proves the FNV-1a hash + mod match
    // byte-for-byte across clients (the web vitest asserts the same 1652 / 2376).
    private static void PhaseMatchesWebTwinValues()
    {
        Check.Equal(EffectMath.FlamePhaseMs("Fires/SteppedFireTezcatara3"), 1652.0, "web twin phase for Tezcatara3");
        Check.Equal(EffectMath.FlamePhaseMs("Fires/SteppedFireTezcatara7"), 2376.0, "web twin phase for Tezcatara7");
        Check.Equal(EffectMath.FlamePhaseMs(""), 861.0, "web twin phase for empty parent");
    }

    // A flame's three quads share the parent path → the same phase (stay mutually layered); different roots desync.
    private static void PhaseSharedByParentDesyncedAcrossFlames()
    {
        double a = EffectMath.FlamePhaseMs("Fires/SteppedFireTezcatara3");
        double b = EffectMath.FlamePhaseMs("Fires/SteppedFireTezcatara3"); // same parent (a second quad)
        double c = EffectMath.FlamePhaseMs("Fires/SteppedFireTezcatara7"); // different flame
        Check.Equal(a, b, "same parent → same phase");
        Check.That(a != c, "different flame roots desync");
    }

    // ---- WS-flameperf: the fold matrix (byte-identical to the removed draw-time DrawSetTransformMatrix) ------------
    // FlameMatrix is the pure reference for M = T(c)·L·T(−c); the native FoldCosmetic path (MirrorNodeView.
    // FlameAboutPivot) recomputes the SAME expression in float, so pinning the reference pins the fold ⇔ draw equality.

    // A bottom-center pivot for a 100×200 box at local origin: centre-x = 50, bottom-y = 200.
    private const double PivotX = 50.0;
    private const double PivotY = 200.0;

    // At rest (scaleY 1, skew 0) the matrix is the pure identity — a resting flame quad renders byte-stable (no fold).
    private static void FlameMatrixIsIdentityAtRest()
    {
        var m = EffectMath.FlameMatrix(1.0, 0.0, PivotX, PivotY);
        Check.Close(m.Xx, 1.0, "rest Xx"); Check.Close(m.Xy, 0.0, "rest Xy");
        Check.Close(m.Yx, 0.0, "rest Yx"); Check.Close(m.Yy, 1.0, "rest Yy");
        Check.Close(m.Ox, 0.0, "rest Ox"); Check.Close(m.Oy, 0.0, "rest Oy");
    }

    // The DEFINING property of the pivot: M·(pivot) == pivot, for every representative (scaleY, skew). Fire rises from
    // its base, so the bottom-center point must never move under the scale.Y/skew flicker.
    private static void FlameMatrixKeepsBottomCenterPivotFixed()
    {
        foreach (var (sy, skew) in new[] { (1.08, 0.0), (0.92, 0.0), (1.0, 0.1), (1.0, -0.1), (1.05, -0.05), (1.08, 0.1) })
        {
            var m = EffectMath.FlameMatrix(sy, skew, PivotX, PivotY);
            double px = (m.Xx * PivotX) + (m.Yx * PivotY) + m.Ox;
            double py = (m.Xy * PivotX) + (m.Yy * PivotY) + m.Oy;
            Check.Close(px, PivotX, $"pivot x fixed (sy={sy}, skew={skew})", 1e-9);
            Check.Close(py, PivotY, $"pivot y fixed (sy={sy}, skew={skew})", 1e-9);
        }
    }

    // Pin the exact basis + origin against the draw path's formula (yAxis = (−sin·sy, cos·sy); origin = c − L·c). A
    // scale.Y bump about the bottom anchors the base (y=200 fixed) and lifts the top edge (y=0 → −200·(sy−1)).
    private static void FlameMatrixMatchesTheDrawBasisAndOrigin()
    {
        // Pure scale.Y (skew 0): sin0=0, cos0=1 → yAxis=(0, sy); Ox=0; Oy = cy·(1−sy).
        var s = EffectMath.FlameMatrix(1.08, 0.0, PivotX, PivotY);
        Check.Close(s.Yx, 0.0, "scaleY Yx"); Check.Close(s.Yy, 1.08, "scaleY Yy");
        Check.Close(s.Ox, 0.0, "scaleY Ox"); Check.Close(s.Oy, PivotY * (1.0 - 1.08), "scaleY Oy = cy·(1−sy)", 1e-9);
        // The top edge (local y=0, x=50) lifts by cy·(sy−1) = 200·0.08 = 16px (fire grows upward from the base).
        double topY = (s.Xy * PivotX) + (s.Yy * 0.0) + s.Oy;
        Check.Close(topY, -PivotY * (1.08 - 1.0), "top edge lifts by cy·(sy−1)", 1e-9);

        // Pure skew (scaleY 1): yAxis=(−sin(skew), cos(skew)); Ox = −Yx·cy; Oy = cy·(1−cos(skew)).
        double sk = 0.1;
        var k = EffectMath.FlameMatrix(1.0, sk, PivotX, PivotY);
        Check.Close(k.Yx, -System.Math.Sin(sk), "skew Yx = −sin", 1e-12);
        Check.Close(k.Yy, System.Math.Cos(sk), "skew Yy = cos", 1e-12);
        Check.Close(k.Ox, -k.Yx * PivotY, "skew Ox = −Yx·cy", 1e-12);
        Check.Close(k.Oy, PivotY * (1.0 - System.Math.Cos(sk)), "skew Oy = cy·(1−cos)", 1e-12);
    }

    // ---- WS-flameperf: reduced-rate flame ticker accumulator -------------------------------------------------------

    // Sub-interval frames don't fire; crossing the interval fires AND resets (drops the backlog — one tick per
    // interval, no catch-up burst after a big delta / frame hitch).
    private static void ReducedRateAccumulatorGatesTicks()
    {
        double acc = 0;
        Check.That(!EffectMath.FlameTickDue(ref acc, 10.0, 33.0), "10ms < 33ms → not due");
        Check.That(!EffectMath.FlameTickDue(ref acc, 10.0, 33.0), "20ms cumulative < 33ms → not due");
        Check.That(EffectMath.FlameTickDue(ref acc, 20.0, 33.0), "40ms cumulative ≥ 33ms → due");
        Check.Close(acc, 0.0, "accumulator resets to 0 after firing", 1e-12);
        Check.That(!EffectMath.FlameTickDue(ref acc, 16.0, 33.0), "16ms after reset < 33ms → not due");

        // A single huge delta fires once; the reset drops the backlog so the NEXT call starts fresh from 0.
        Check.That(EffectMath.FlameTickDue(ref acc, 500.0, 33.0), "big delta fires");
        Check.Close(acc, 0.0, "backlog dropped after big delta (no catch-up)", 1e-12);
        Check.That(!EffectMath.FlameTickDue(ref acc, 1.0, 33.0), "next call starts fresh from 0 (no burst)");
    }

    // A non-positive interval degenerates to "every call fires" (no throttle) — the safe fallback.
    private static void ReducedRateDegenerateIntervalNeverThrottles()
    {
        double acc = 0;
        Check.That(EffectMath.FlameTickDue(ref acc, 0.0, 0.0), "zero interval → always due");
        Check.That(EffectMath.FlameTickDue(ref acc, 0.0, -5.0), "negative interval → always due");
    }
}
