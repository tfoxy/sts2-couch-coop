using CouchCoop.MirrorProtocol.Assets;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-U/WS-W (M3): shared percentile math (linear interpolation between nearest ranks) backing the walk-timing
// summaries. Order-independent; empty → zeros; multi-quantile.
internal static class PercentilesTests
{
    public static void Run()
    {
        EmptyIsZeros();
        SingleValue();
        KnownPercentilesOfOneToTen();
        OrderIndependent();
        ClampsOutOfRangeQuantiles();
    }

    private static void EmptyIsZeros()
    {
        var p = Percentiles.Compute(Array.Empty<double>(), 0.5, 0.95, 0.99);
        Check.SequenceClose(p, new double[] { 0, 0, 0 }, "empty input → zeros");
    }

    private static void SingleValue()
    {
        var p = Percentiles.Compute(new double[] { 42 }, 0, 0.5, 1);
        Check.SequenceClose(p, new double[] { 42, 42, 42 }, "single value → that value at every quantile");
    }

    private static void KnownPercentilesOfOneToTen()
    {
        var values = new double[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 };
        var p = Percentiles.Compute(values, 0, 0.5, 0.95, 1);
        // pos = q*(n-1) with n=10: p0=1, p50=5+0.5=5.5, p95: pos=8.55 → 9+0.55=9.55, p100=10.
        Check.SequenceClose(p, new double[] { 1, 5.5, 9.55, 10 }, "known percentiles of 1..10");
    }

    private static void OrderIndependent()
    {
        var ordered = new double[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 };
        var shuffled = new double[] { 7, 2, 10, 1, 5, 9, 3, 8, 4, 6 };
        var a = Percentiles.Compute(ordered, 0.5, 0.9);
        var b = Percentiles.Compute(shuffled, 0.5, 0.9);
        Check.SequenceClose(b, a, "input order does not change the result");
    }

    private static void ClampsOutOfRangeQuantiles()
    {
        var values = new double[] { 1, 2, 3, 4, 5 };
        var p = Percentiles.Compute(values, -0.5, 1.5);
        Check.SequenceClose(p, new double[] { 1, 5 }, "q<0 clamps to min, q>1 clamps to max");
    }

}
