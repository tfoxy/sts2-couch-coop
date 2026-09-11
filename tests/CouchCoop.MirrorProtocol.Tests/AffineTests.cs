using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Port of frontend/src/mirror/__tests__/affine.spec.ts.
internal static class AffineTests
{
    public static void Run()
    {
        NodeMatrixComposesGlobalWithLocalOrigin();
        InverseTimesMIsIdentity();
        ReExpressesChildRelativeToClipParent();
        SingularReturnsNull();
    }

    private static void NodeMatrixComposesGlobalWithLocalOrigin()
    {
        // translate(100,50) · scale(2) box at (10,20) → origin maps to (100 + 2*10, 50 + 2*20).
        var m = Affine.NodeMatrix([2, 0, 0, 2, 100, 50], 10, 20);
        Check.SequenceClose(m, [2, 0, 0, 2, 120, 90], "nodeMatrix");
    }

    private static void InverseTimesMIsIdentity()
    {
        double[] m = [2, 0, 0, 3, 120, 90];
        var inv = Affine.Inverse(m);
        Check.That(inv is not null, "inverse not null");
        Check.SequenceClose(Affine.Multiply(inv!, m), Affine.Identity, "inv · M == identity");
    }

    private static void ReExpressesChildRelativeToClipParent()
    {
        var clipper = Affine.NodeMatrix([1, 0, 0, 1, 200, 100], 0, 0);
        var child = Affine.NodeMatrix([1, 0, 0, 1, 205, 96], 0, 0);
        var rel = Affine.Multiply(Affine.Inverse(clipper)!, child);
        Check.SequenceClose(rel, [1, 0, 0, 1, 5, -4], "clipInv · childGlobal");
    }

    private static void SingularReturnsNull()
    {
        Check.That(Affine.Inverse([0, 0, 0, 0, 1, 1]) is null, "singular matrix → null");
    }
}
