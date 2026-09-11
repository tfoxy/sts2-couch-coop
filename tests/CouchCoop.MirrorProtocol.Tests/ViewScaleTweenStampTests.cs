using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-SHOP (round 6): pure matrix over ViewScaleTweenStamp — the endpoint-global compose + the stamp predicate + the
// design-box measurement that let ViewScaler stamp a GROUP being slid on-screen by a transform tween (the shop open
// slide) at its tween ENDPOINT, on the arm drain, before TweenReplayer folds the endpoints. Godot-free / env-free.
internal static class ViewScaleTweenStampTests
{
    private const double DesignWidth = 1920;
    private const double DesignHeight = 1080;

    public static void Run()
    {
        EndpointGlobalLocalCompose();
        EndpointGlobalNullCases();
        DesignBoxMatchesFourCornerTransform();
        ShopOpenStampEqualsSettled();
        Console.Error.WriteLine("[viewscale-tweenstamp] ok");
    }

    // LOCAL wire: endpointGlobal = parentStreamedGlobal · endpointLocal (Affine.Multiply, child-then-parent).
    private static void EndpointGlobalLocalCompose()
    {
        // Parent global = translate(200,60); endpoint LOCAL = translate(118,51) (the on-screen slot origin).
        double[] parentGlobal = { 1, 0, 0, 1, 200, 60 };
        double[] endpointLocal = { 1, 0, 0, 1, 118, 51 };
        var g = ViewScaleTweenStamp.EndpointGlobal(endpointLocal, parentGlobal);
        Check.That(g is not null, "[endpoint-global local] composed");
        Check.SequenceClose(g, new double[] { 1, 0, 0, 1, 318, 111 }, "[endpoint-global local] = parent · local");
    }

    private static void EndpointGlobalNullCases()
    {
        // Endpoint not a usable 6-tuple → null (no stamp).
        Check.That(
            ViewScaleTweenStamp.EndpointGlobal(new double[] { 1, 0, 0, 1 }, new double[] { 1, 0, 0, 1, 0, 0 }) is null,
            "[endpoint-global] short endpoint → null");
        Check.That(
            ViewScaleTweenStamp.EndpointGlobal(null, new double[] { 1, 0, 0, 1, 0, 0 }) is null,
            "[endpoint-global] null endpoint → null");
        // LOCAL wire with a missing parent global → null (can't compose).
        Check.That(
            ViewScaleTweenStamp.EndpointGlobal(new double[] { 1, 0, 0, 1, 118, 51 }, parentGlobal: null) is null,
            "[endpoint-global] local + missing parent → null");
    }

    // DesignBox transforms the 4 local-box corners through the wire affine, exactly like ViewScaler.DesignAabbOf.
    private static void DesignBoxMatchesFourCornerTransform()
    {
        // A rotate-ish affine so corner min/max isn't the trivial (origin, origin+size) case.
        double[] g = { 0, 1, -1, 0, 500, 100 }; // 90° rot: x' = -y + 500, y' = x + 100
        var box = ViewScaleTweenStamp.DesignBox(g, 0, 0, 10, 20);
        // corners: (0,0)->(500,100) (10,0)->(500,110) (0,20)->(480,100) (10,20)->(480,110)
        Check.Close(box.MinX, 480, "[design-box] rot MinX");
        Check.Close(box.MaxX, 500, "[design-box] rot MaxX");
        Check.Close(box.MinY, 100, "[design-box] rot MinY");
        Check.Close(box.MaxY, 110, "[design-box] rot MaxY");
    }

    // The shop open scenario grounded in the REAL audit-shop.ndjson numbers: SlotsContainer (the shop rug + all items)
    // localRect 1747×978, parked at local origin (118,−1000) while closed, slides to an on-screen endpoint. The stamp
    // ViewScaler computes at the ENDPOINT (on the arm drain, streamed box still parked) must EQUAL the stamp it would
    // compute once the group is SETTLED at that same global — so the whole slide renders at the merchant group scale.
    private static void ShopOpenStampEqualsSettled()
    {
        // Root-level group for the purpose of the geometry (parent = identity). LocalRect 1747×978.
        const double w = 1747, h = 978;
        double[] parkedGlobal = { 1, 0, 0, 1, 118, -1000 };   // closed: entirely off the top
        double[] endpointLocal = { 1, 0, 0, 1, 118, 51 };     // open: on-screen
        var endpointGlobal = ViewScaleTweenStamp.EndpointGlobal(endpointLocal, Identity);
        Check.That(endpointGlobal is not null, "[shop] endpoint global composed");

        var parkedBox = ViewScaleTweenStamp.DesignBox(parkedGlobal, 0, 0, w, h);
        var endpointBox = ViewScaleTweenStamp.DesignBox(endpointGlobal!, 0, 0, w, h);

        Check.That(parkedBox.FullyOutside(DesignWidth, DesignHeight, 0), "[shop] parked box is fully off-stage");
        Check.That(!endpointBox.FullyOutside(DesignWidth, DesignHeight, 0), "[shop] endpoint box lands on-screen");

        // stamp(endpoint) == stamp(settled): the settled state IS the group measured at the endpoint global — so the
        // arm-drain endpoint override and a post-settle normal measure yield the identical anchored stamp.
        var settledBox = ViewScaleTweenStamp.DesignBox(endpointGlobal!, 0, 0, w, h); // same global once settled
        var stampAtEndpoint = HoverTipScaleMath.ComputeAnchoredStamp(
            endpointBox, ViewScale.MerchantGroupScale, DesignWidth, DesignHeight, HoverTipScaleMath.AnchorPivot.Center, 0, 0, false);
        var stampSettled = HoverTipScaleMath.ComputeAnchoredStamp(
            settledBox, ViewScale.MerchantGroupScale, DesignWidth, DesignHeight, HoverTipScaleMath.AnchorPivot.Center, 0, 0, false);
        Check.That(stampAtEndpoint is { } && stampSettled is { }, "[shop] both stamps non-null");
        Check.Close(stampAtEndpoint!.Value.Scale, ViewScale.MerchantGroupScale, "[shop] endpoint stamp scale == merchant group");
        Check.Close(stampAtEndpoint!.Value.PivotX, stampSettled!.Value.PivotX, "[shop] endpoint stamp pivotX == settled");
        Check.Close(stampAtEndpoint!.Value.PivotY, stampSettled!.Value.PivotY, "[shop] endpoint stamp pivotY == settled");
        Check.Close(stampAtEndpoint!.Value.ClampX, stampSettled!.Value.ClampX, "[shop] endpoint stamp clampX == settled");
        Check.Close(stampAtEndpoint!.Value.ClampY, stampSettled!.Value.ClampY, "[shop] endpoint stamp clampY == settled");
    }

    private static readonly double[] Identity = { 1, 0, 0, 1, 0, 0 };
}
