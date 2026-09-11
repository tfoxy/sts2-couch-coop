using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for SpreadMath.ParentFrameOffset — the parent-frame delta the native reconciler folds into a nested
// view's transform origin to reproduce a world (design-px) horizontal shift `relDx`. The key correctness property:
// applying the parent's linear 2×2 to the returned offset must recover exactly (relDx, 0) — under identity, scale,
// rotation, and sheared/rotated-scaled parents. Plus the degenerate + zero-shift short-circuits and SpreadRecord
// value semantics.
internal static class SpreadMathTests
{
    public static void Run()
    {
        IdentityParentPassesShiftThrough();
        UnrotatedScaledParentDividesByXScale();
        NinetyDegreeRotationMapsToNegativeY();
        RotatedScaledShearedParentRoundTrips();
        ZeroShiftIsZeroOffset();
        SingularParentFallsBackToZero();
        SpreadRecordValueSemantics();
    }

    // Apply the parent's LINEAR 2×2 (from the 6-tuple [a,b,c,d,..]) to a local (dx,dy) → the world vector it produces.
    // world.x = a·dx + c·dy, world.y = b·dx + d·dy (the CSS matrix() convention).
    private static (double X, double Y) ApplyLinear(double[] parentGlobal, double dx, double dy)
    {
        double a = parentGlobal[0], b = parentGlobal[1], c = parentGlobal[2], d = parentGlobal[3];
        return ((a * dx) + (c * dy), (b * dx) + (d * dy));
    }

    // The core invariant: L · ParentFrameOffset(L, relDx) == (relDx, 0), i.e. the local offset renders as a pure
    // horizontal world shift of relDx (no vertical drift), whatever the parent basis.
    private static void CheckRoundTrip(double[] parentGlobal, double relDx, string label)
    {
        var (dx, dy) = SpreadMath.ParentFrameOffset(parentGlobal, relDx);
        var (wx, wy) = ApplyLinear(parentGlobal, dx, dy);
        Check.Close(wx, relDx, $"{label}: world-x recovers relDx");
        Check.Close(wy, 0, $"{label}: world-y stays 0 (no vertical drift)");
    }

    private static void IdentityParentPassesShiftThrough()
    {
        double[] identity = [1, 0, 0, 1, 0, 0];
        var (dx, dy) = SpreadMath.ParentFrameOffset(identity, 600);
        Check.Close(dx, 600, "identity parent: dx == relDx");
        Check.Close(dy, 0, "identity parent: dy == 0");
        CheckRoundTrip(identity, 600, "identity");
    }

    // A parent scaled 2× in x, 3× in y (no rotation): a 600px world shift needs a 300px LOCAL x offset (relDx/a), 0 y.
    private static void UnrotatedScaledParentDividesByXScale()
    {
        double[] scaled = [2, 0, 0, 3, 40, 90];
        var (dx, dy) = SpreadMath.ParentFrameOffset(scaled, 600);
        Check.Close(dx, 300, "scaled parent: dx == relDx / xScale");
        Check.Close(dy, 0, "scaled parent: dy == 0 (unrotated)");
        CheckRoundTrip(scaled, 600, "scaled");
    }

    // A parent rotated 90° CCW (a=0,b=1,c=-1,d=0): local +x → world +y, local +y → world −x. So a world +x shift is
    // achieved by a local −y offset. Offset == (0, −relDx).
    private static void NinetyDegreeRotationMapsToNegativeY()
    {
        double[] rot90 = [0, 1, -1, 0, 0, 0];
        var (dx, dy) = SpreadMath.ParentFrameOffset(rot90, 600);
        Check.Close(dx, 0, "rot90 parent: dx == 0");
        Check.Close(dy, -600, "rot90 parent: dy == -relDx");
        CheckRoundTrip(rot90, 600, "rot90");
    }

    // An arbitrary non-singular sheared/rotated-scaled parent basis. Only the round-trip invariant is asserted (the
    // hand-derived closed form would just re-implement the code); it must hold for negative shifts too.
    private static void RotatedScaledShearedParentRoundTrips()
    {
        double[] messy = [1.5, 0.5, -0.3, 2.0, 100, 200];
        CheckRoundTrip(messy, 600, "messy +600");
        CheckRoundTrip(messy, -287.5, "messy -287.5");

        // A composed rotate(30°)·scale(1.5, 0.75) basis, from the same Affine.Multiply the walk uses.
        double cos = Math.Cos(Math.PI / 6), sin = Math.Sin(Math.PI / 6);
        double[] rot = [cos, sin, -sin, cos, 0, 0];
        double[] scale = [1.5, 0, 0, 0.75, 0, 0];
        double[] composed = [.. Affine.Multiply(rot, scale)];
        CheckRoundTrip(composed, 480, "rotate30·scale composed");
    }

    private static void ZeroShiftIsZeroOffset()
    {
        double[] messy = [1.5, 0.5, -0.3, 2.0, 100, 200];
        var (dx, dy) = SpreadMath.ParentFrameOffset(messy, 0);
        Check.Close(dx, 0, "zero shift: dx == 0");
        Check.Close(dy, 0, "zero shift: dy == 0");
    }

    // A degenerate (zero-determinant) parent basis yields (0,0) rather than NaN/∞ — the view renders unshifted.
    private static void SingularParentFallsBackToZero()
    {
        double[] singular = [0, 0, 0, 0, 10, 10]; // det 0
        var (dx, dy) = SpreadMath.ParentFrameOffset(singular, 600);
        Check.Close(dx, 0, "singular parent: dx == 0 (no NaN)");
        Check.Close(dy, 0, "singular parent: dy == 0 (no NaN)");

        double[] collinear = [2, 4, 1, 2, 0, 0]; // rows proportional → det 0
        var (dx2, dy2) = SpreadMath.ParentFrameOffset(collinear, 600);
        Check.Close(dx2, 0, "collinear parent: dx == 0");
        Check.Close(dy2, 0, "collinear parent: dy == 0");
    }

    // SpreadRecord is a value type: default is all-zero/false, and equal-valued records compare equal.
    private static void SpreadRecordValueSemantics()
    {
        SpreadRecord d = default;
        Check.Close(d.Dx, 0, "default SpreadRecord.Dx == 0");
        Check.Close(d.RenderedWidth, 0, "default SpreadRecord.RenderedWidth == 0");
        Check.That(!d.Prop, "default SpreadRecord.Prop == false");
        Check.That(!d.Paints, "default SpreadRecord.Paints == false");

        var a = new SpreadRecord(600, 840, true, true);
        var b = new SpreadRecord(600, 840, true, true);
        Check.Equal(a, b, "equal-valued SpreadRecords compare equal");
        Check.That(a != new SpreadRecord(600, 840, false, true), "differing Prop makes records unequal");
    }
}
