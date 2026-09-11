using System.Collections.Generic;

namespace CouchCoop.MirrorProtocol.SceneModel;

// WS-SHOP (round 6) — pure geometry + predicate for ENDPOINT-based view-scale stamping across a transform-tween
// TRANSITION (the shop open slide, and any group that enters from off-stage under a client-replayed transform tween).
//
// Why this is needed: the per-drain view-scale index measures each group's box from its STREAMED (wire) transform,
// but at a screen TRANSITION that transform is still parked off-stage (the closed shop's SlotsContainer sits at local
// y≈−1000) while a transform tween hint carries it on-screen — the producer suppresses a tweened channel, so the wire
// never moves during the slide. The FullyOutside reject would then fire against the parked box and the group would
// render at scale 1 for the whole slide, popping to 1.2 at settle. Measuring the box with its transform OVERRIDDEN by
// the tween ENDPOINT stamps it where it will SETTLE, so TweenReplayer folds the scale into both slide endpoints (via
// MirrorNodeView.FoldForTween) and the whole slide renders scaled.
// R8 (WS-2): consumed by the pure ViewScaleStampIndex.Build (the stateful ViewScaler pass this was written for is
// gone); the geometry + the P4 endpoint-also-off-stage guard are unchanged.
//
// This module is Godot-free + env-free so it is Exe-testable. It does two things:
    //   * <see cref="EndpointGlobal"/> — compose the endpoint global affine from the hint's endpoint local transform
    //     and the parent's streamed global.
// Plus <see cref="DesignBox"/>, the pure 4-corner design-AABB used to measure a box at an overridden global (twin of
// ViewScaler.DesignAabbOf) so the endpoint measurement + its tests never touch Godot.
public static class ViewScaleTweenStamp
{
    // Compose the endpoint global affine [a,b,c,d,tx,ty] from the tween hint's endpoint local transform. The hint
    // endpoint is the node's end-local transform, so endpointGlobal = parentStreamedGlobal · endpointLocal
    // (Affine.Multiply — apply the child, then the parent), matching GlobalTransformIndex's composition. A root
    // passes Affine.Identity as the parent. Returns null when either input is not a usable 6-tuple — the
    // caller then skips the endpoint stamp (leaves the group un-scaled until settle, the pre-fix behavior).
    public static IReadOnlyList<double>? EndpointGlobal(
        IReadOnlyList<double>? endpointLocal, IReadOnlyList<double>? parentGlobal)
    {
        if (endpointLocal is not { Count: 6 })
        {
            return null;
        }

        if (parentGlobal is not { Count: 6 })
        {
            return null;
        }

        return Affine.Multiply(parentGlobal, endpointLocal);
    }

    // The design-space AABB of a node-local box [localX, localY, w, h] transformed through a GLOBAL wire affine
    // [a,b,c,d,tx,ty] (column-major: x' = a·x + c·y + tx, y' = b·x + d·y + ty). Pure twin of ViewScaler.DesignAabbOf —
    // used to measure a group at its overridden ENDPOINT global (and to test the endpoint stamp == the settled stamp).
    public static DesignAabb DesignBox(
        IReadOnlyList<double> global, double localX, double localY, double w, double h)
    {
        double a = global[0], b = global[1], c = global[2], d = global[3], tx = global[4], ty = global[5];

        double x0 = localX, y0 = localY, x1 = localX + w, y1 = localY + h;
        double cx0 = (a * x0) + (c * y0) + tx, cy0 = (b * x0) + (d * y0) + ty; // (x0,y0)
        double cx1 = (a * x1) + (c * y0) + tx, cy1 = (b * x1) + (d * y0) + ty; // (x1,y0)
        double cx2 = (a * x0) + (c * y1) + tx, cy2 = (b * x0) + (d * y1) + ty; // (x0,y1)
        double cx3 = (a * x1) + (c * y1) + tx, cy3 = (b * x1) + (d * y1) + ty; // (x1,y1)

        double minX = System.Math.Min(System.Math.Min(cx0, cx1), System.Math.Min(cx2, cx3));
        double minY = System.Math.Min(System.Math.Min(cy0, cy1), System.Math.Min(cy2, cy3));
        double maxX = System.Math.Max(System.Math.Max(cx0, cx1), System.Math.Max(cx2, cx3));
        double maxY = System.Math.Max(System.Math.Max(cy0, cy1), System.Math.Max(cy2, cy3));
        return new DesignAabb(minX, minY, maxX, maxY);
    }
}
