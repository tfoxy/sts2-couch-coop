using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-SHOP (round 6) HEADLESS live-data verification of the shop OPEN slide + the closed-shop non-regression — no Godot,
// no display, no live lock. Two env-gated legs (each skips SILENTLY when its var is unset, so a plain checkout stays
// green; the audit .ndjson files live in the gitignored .sts2/bench):
//
//   * COUCHCOOP_MIRROR_SHOPOPEN_PROBE_NDJSON → a recorder-with-shop-CLOSED-then-OPENED capture. Asserts the shop rug
//     SlotsContainer resolves the merchant GROUP (1.20), that a TRANSFORM tween hint slides it (an on-screen endpoint),
//     that its item subtree is ALREADY populated (the content-staleness verdict: content is pre-streamed while parked
//     — the "empty cards" is decode latency, cause (b), NOT withheld descendant transforms, cause (a)), and that the
//     endpoint global composed against the parent's streamed global lands on-screen + yields a merchant-scale stamp.
//   * COUCHCOOP_MIRROR_SHOP_PROBE_NDJSON → the existing closed-only audit-shop.ndjson. Asserts SlotsContainer resolves
//     the group, is parked FULLY off-stage, and — with NO transform hint targeting it — the endpoint-stamp predicate
//     stays FALSE (the P4 closed-shop phantom fix is preserved: a parked group with no tween never stamps).
internal static class ShopOpenScaleReplayProbe
{
    private const double DesignWidth = 1920;
    private const double DesignHeight = 1080;

    public static void Run()
    {
        OpenLeg(Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_SHOPOPEN_PROBE_NDJSON"));
        ClosedLeg(Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_SHOP_PROBE_NDJSON"));
    }

    private static void OpenLeg(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var (state, hints) = ReplayProbeSupport.Replay(path);
        var (slotsId, slots) = FindSlotsContainer(state);
        Check.That(slots is not null, "[shopopen-probe] SlotsContainer present");

        var res = ViewScale.ResolveFor(slotsId!, state);
        Check.Close(res.Scale, ViewScale.MerchantGroupScale, "[shopopen-probe] SlotsContainer → 1.20 merchant group");
        Check.That(res.IsGroup, "[shopopen-probe] SlotsContainer resolves a GROUP");

        // A transform tween hint slid it in — its endpoint must be an on-screen local (NOT the parked y≈−1000).
        var slide = LastTransformHint(hints, slotsId!);
        Check.That(slide is not null, "[shopopen-probe] a transform hint slides the SlotsContainer");
        double endY = slide!.EndTransform![5];
        Check.That(endY > -500, "[shopopen-probe] slide endpoint local Y is on-screen (not parked)");

        // Content-staleness EVIDENCE (cause b, not a): the item subtree is already populated while sliding.
        int merchantCards = CountDescendantLeaves(state, slotsId!, "NMerchantCard");
        Check.That(merchantCards >= 1, "[shopopen-probe] SlotsContainer subtree carries merchant item cards (content pre-streamed)");

        // Endpoint global (local wire) composed against the parent's streamed global → on-screen box + merchant stamp.
        var index = new GlobalTransformIndex();
        index.Update(state);
        IReadOnlyList<double>? parentGlobal = new double[] { 1, 0, 0, 1, 0, 0 };
        if (slots!.ParentId is { } pid)
        {
            index.TryGetGlobal(pid, out parentGlobal);
        }

        var endpointGlobal = ViewScaleTweenStamp.EndpointGlobal(slide.EndTransform, parentGlobal);
        Check.That(endpointGlobal is not null, "[shopopen-probe] endpoint global composes");
        var lr = slots.LocalRect!;
        var endBox = ViewScaleTweenStamp.DesignBox(endpointGlobal!, lr.X, lr.Y, lr.Width, lr.Height);
        Check.That(!endBox.FullyOutside(DesignWidth, DesignHeight, 0), "[shopopen-probe] endpoint box lands on-screen");

        Console.Error.WriteLine(
            $"[shopopen-probe] SlotsContainer id={slotsId} group=1.20 slideEndY={endY:0.#} merchantCards={merchantCards} " +
            $"endpointBox=({endBox.MinX:0},{endBox.MinY:0},{endBox.MaxX:0},{endBox.MaxY:0})");
    }

    private static void ClosedLeg(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var (state, hints) = ReplayProbeSupport.Replay(path);
        var (slotsId, slots) = FindSlotsContainer(state);
        Check.That(slots is not null, "[shopclosed-probe] SlotsContainer present");

        var res = ViewScale.ResolveFor(slotsId!, state);
        Check.Close(res.Scale, ViewScale.MerchantGroupScale, "[shopclosed-probe] SlotsContainer → 1.20 merchant group");

        // Parked entirely off-stage (the closed shop) and no tween slides it → the endpoint-stamp predicate is FALSE.
        var index = new GlobalTransformIndex();
        index.Update(state);
        Check.That(index.TryGetGlobal(slotsId!, out var g), "[shopclosed-probe] SlotsContainer has a global");
        var lr = slots!.LocalRect!;
        var box = ViewScaleTweenStamp.DesignBox(g, lr.X, lr.Y, lr.Width, lr.Height);
        Check.That(box.FullyOutside(DesignWidth, DesignHeight, 0), "[shopclosed-probe] closed SlotsContainer is parked off-stage");

        bool hasSlide = LastTransformHint(hints, slotsId!) is not null;
        Check.That(!hasSlide, "[shopclosed-probe] parked closed shop has no transform slide");

        Console.Error.WriteLine(
            $"[shopclosed-probe] SlotsContainer id={slotsId} parked=({box.MinX:0},{box.MinY:0},{box.MaxX:0},{box.MaxY:0}) hasSlide={hasSlide}");
    }

    private static (string?, MirrorNode?) FindSlotsContainer(MirrorState state)
    {
        foreach (var id in state.OrderedIds)
        {
            if (state.Nodes.TryGetValue(id, out var n) && n.Name == "SlotsContainer" && n.LocalRect is { })
            {
                return (id, n);
            }
        }

        return (null, null);
    }

    private static MirrorTweenHint? LastTransformHint(IReadOnlyList<MirrorTweenHint> hints, string id)
    {
        MirrorTweenHint? found = null;
        foreach (var h in hints)
        {
            if (h.TargetId == id && h.EndTransform is { Count: 6 })
            {
                found = h;
            }
        }

        return found;
    }

    private static int CountDescendantLeaves(MirrorState state, string rootId, string leaf)
    {
        int count = 0;
        foreach (var (_, n) in state.Nodes)
        {
            if (Leaf(n.NodeType) != leaf)
            {
                continue;
            }

            for (var cur = n; cur is not null;
                 cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var p) ? p : null)
            {
                if (cur.Id == rootId)
                {
                    count++;
                    break;
                }
            }
        }

        return count;
    }

    private static string Leaf(string nodeType)
    {
        int dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
