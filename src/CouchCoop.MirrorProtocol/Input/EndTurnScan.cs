using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Input;

// R4 change-2 wiring: the END-TURN button hit-test behind GestureCallbacks.EndTurnBoxAt. Pure (Godot-free) so the
// Exe suite can unit-test it; the godot-client InputRouter curries the live store handles over BoxAt.
//
// The button is identified by its owning INSTANCED SCENE (v0.107.1 promoted it to its own
// res://scenes/combat/end_turn_button.tscn — see TextScale's End-turn rule), resolved per rect via
// SceneIdentity.Resolve, and its box comes from the EXISTING InteractiveRectScan surface (visible, mouse-visible
// Stop/Pass, transform + box, ancestor-visible — the exact eligibility the game's own hover honors): the UNION
// game-space AABB of every eligible rect the scene owns, so it never matters whether the mouse-visible Control is
// the scene root or a descendant (a Label-only box would under-report the button and park the cursor still ON it).
// Coordinates are RESOLVED 1920×1080 GAME space on both sides (the machine passes the release's resolved point;
// spread shifts are irrelevant here, exactly like InputRouter.TargetsAtResolved). Web twin: mirrorRenderer.endTurnBoxAt.
public static class EndTurnScan
{
    // Scene-file SUFFIX match (TextScale-style; tolerant of a path move like the v0.107.1 promotion).
    private const string EndTurnSceneFileSuffix = "end_turn_button.tscn";

    /// <summary>
    /// The END-TURN button's game-space AABB when the RESOLVED game point (<paramref name="x"/>, <paramref name="y"/>)
    /// lands on it, else null (also null when no eligible end-turn rect is on screen — out of combat / hidden).
    /// </summary>
    public static EndTurnBox? BoxAt(MirrorState state, GlobalTransformIndex transforms, SpreadIndex spread, double x, double y)
    {
        double minX = double.PositiveInfinity, minY = double.PositiveInfinity;
        double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
        var any = false;

        InteractiveRectScan.ForEach(state, transforms, spread, r =>
        {
            var (file, _) = SceneIdentity.Resolve(r.Id, state);
            if (file is null || !file.EndsWith(EndTurnSceneFileSuffix, StringComparison.Ordinal))
            {
                return;
            }

            // Union this rect's game-space AABB: map the local box corners through the same NodeMatrix
            // TouchTargetScan.PointInBox inverts (the box renders at local (0,0,w,h) under it).
            var m = Affine.NodeMatrix(r.Global, r.LocalRect.X, r.LocalRect.Y);
            ExpandByCorner(m, 0, 0, ref minX, ref minY, ref maxX, ref maxY);
            ExpandByCorner(m, r.LocalRect.Width, 0, ref minX, ref minY, ref maxX, ref maxY);
            ExpandByCorner(m, 0, r.LocalRect.Height, ref minX, ref minY, ref maxX, ref maxY);
            ExpandByCorner(m, r.LocalRect.Width, r.LocalRect.Height, ref minX, ref minY, ref maxX, ref maxY);
            any = true;
        });

        if (!any)
        {
            return null;
        }

        return x >= minX && x <= maxX && y >= minY && y <= maxY
            ? new EndTurnBox(minX, minY, maxX, maxY)
            : null;
    }

    private static void ExpandByCorner(
        IReadOnlyList<double> m,
        double cx,
        double cy,
        ref double minX,
        ref double minY,
        ref double maxX,
        ref double maxY)
    {
        var gx = (m[0] * cx) + (m[2] * cy) + m[4];
        var gy = (m[1] * cx) + (m[3] * cy) + m[5];
        minX = Math.Min(minX, gx);
        minY = Math.Min(minY, gy);
        maxX = Math.Max(maxX, gx);
        maxY = Math.Max(maxY, gy);
    }
}
