namespace CouchCoop.MirrorProtocol.SceneModel;

// 1:1 C# port of frontend/src/mirror/affine.ts. 2D affine transforms as CSS `matrix()` 6-tuples
// [a, b, c, d, e, f] (column-major: x' = a·x + c·y + e, y' = b·x + d·y + f).
public static class Affine
{
    public static readonly double[] Identity = [1, 0, 0, 1, 0, 0];

    // m · n (apply n first, then m), matching CSS `transform: matrix(m) matrix(n)`.
    public static double[] Multiply(IReadOnlyList<double> m, IReadOnlyList<double> n)
    {
        double a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
        double a2 = n[0], b2 = n[1], c2 = n[2], d2 = n[3], e2 = n[4], f2 = n[5];
        return
        [
            a * a2 + c * b2,
            b * a2 + d * b2,
            a * c2 + c * d2,
            b * c2 + d * d2,
            a * e2 + c * f2 + e,
            b * e2 + d * f2 + f,
        ];
    }

    // Inverse of an affine matrix, or null when singular (degenerate scale — caller falls back to identity).
    public static double[]? Inverse(IReadOnlyList<double> m)
    {
        double a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
        var det = a * d - b * c;
        if (!double.IsFinite(det) || Math.Abs(det) < 1e-9)
        {
            return null;
        }

        var ia = d / det;
        var ib = -b / det;
        var ic = -c / det;
        var id = a / det;
        return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
    }

    // A node's placement matrix: its GLOBAL Transform2D [a,b,c,d,tx,ty] composed with a translate to its
    // node-local box origin (localX, localY), so the box can render at (0,0,w,h).
    public static double[] NodeMatrix(IReadOnlyList<double> transform, double localX, double localY)
    {
        double a = transform[0], b = transform[1], c = transform[2], d = transform[3], tx = transform[4], ty = transform[5];
        return [a, b, c, d, a * localX + c * localY + tx, b * localX + d * localY + ty];
    }

}
