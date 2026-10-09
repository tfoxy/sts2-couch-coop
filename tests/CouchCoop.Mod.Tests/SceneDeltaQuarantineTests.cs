using System.Text.Json;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;

// A scene node whose numbers have no JSON form must cost that node, not the frame it rides in. Covers the leaf
// converters writing 0 for a non-finite channel (and saying which node needed it), SceneDeltaSafeSerializer
// quarantining an upsert that throws while every other field of the frame survives, the coalescer re-queue that
// keeps a quarantined id from being lost, and the per-node rate limit on the log lines. Pure; assert-or-throw.
internal static class SceneDeltaQuarantineTests
{
    public static void Run()
    {
        NonFiniteTransformAndColourSerializeAsZero();
        CleanSerializeResetsTheSanitizeSignal();
        ThrowingUpsertIsQuarantinedAndTheRestIsSent();
        ChildrenOfAQuarantinedAddAreHeldWithIt();
        VolatileQuarantineHoldsNoChildren();
        AllQuarantinedIncrementalSendsNothing();
        KeyframeWithABadNodeStillSends();
        ThrowingHintIsDroppedAndTheFrameIsSent();
        RequeuedIdIsRequestedByTheNextTake();
        RemovalAfterRequeueWins();
        RemovalBeforeRequeueWins();
        PendingFullIgnoresRequeue();
        RequestKeyframeMakesTheNextTakeAKeyframe();
        DiagnosticsRateLimitPerNodeWithSuppressedCount();
        DescribeNodePathWalksTheRetainedParents();
    }

    private static RuntimeSceneNodeDelta Node(string id, string? parentId = null) => new(
        Id: id, ParentId: parentId, Name: id, NodeType: "Node2D", Rect: null,
        Visible: true, Opacity: 1, ZIndex: null, Rotation: 0, Texture: null, NinePatch: false, Text: null)
    {
        Transform = new RuntimeSceneTransform2DSnapshot(new(1, 0), new(0, 1), new(10, 20)),
    };

    // Opacity is a plain double on the wire (no leaf converter), so NaN there still throws: the quarantine case.
    private static RuntimeSceneNodeDelta Throwing(string id, string? parentId = null)
        => Node(id, parentId) with { Opacity = double.NaN };

    private static RuntimeSceneDelta Incremental(
        IReadOnlyList<RuntimeSceneNodeDelta> upserts,
        IReadOnlyList<string>? removed = null,
        IReadOnlyList<TweenHintDelta>? hints = null)
        => new(false, "combat", "screen:combat:live", upserts, removed ?? [], null, hints);

    private static readonly SceneOrderPatch Patch = new(null, [new SceneOrderParentPatch("p", ["a", "b"])]);

    private static JsonElement Parse(byte[]? bytes)
    {
        Assert(bytes is not null, "bytes were produced");
        return JsonDocument.Parse(bytes!).RootElement.Clone();
    }

    private static string[] UpsertIds(JsonElement root)
        => root.GetProperty("upserts").EnumerateArray().Select(node => node.GetProperty("id").GetString()!).ToArray();

    private static void NonFiniteTransformAndColourSerializeAsZero()
    {
        var bad = Node("bad") with
        {
            // NaN, Infinity, and a double too large for float32 (the `(float)` cast makes it Infinity).
            Transform = new RuntimeSceneTransform2DSnapshot(new(double.PositiveInfinity, 0), new(0, 1e300), new(double.NaN, 5)),
            // A colour without its hex goes out as float channels — the other converter that writes raw numbers.
            Modulate = new RuntimeSceneColorSnapshot(double.NaN, 1, 1, 1, null),
        };
        var result = SceneDeltaSafeSerializer.Serialize(Incremental([Node("fine"), bad]));
        var root = Parse(result.Bytes);
        var badWire = root.GetProperty("upserts")[1];
        var transform = badWire.GetProperty("transform");
        Assert(transform.GetProperty("xAxis").GetProperty("x").GetDouble() == 0, "Infinity axis channel written as 0");
        Assert(transform.GetProperty("yAxis").GetProperty("y").GetDouble() == 0, "out-of-float-range channel written as 0");
        Assert(transform.GetProperty("origin").GetProperty("x").GetDouble() == 0, "NaN origin channel written as 0");
        Assert(transform.GetProperty("origin").GetProperty("y").GetDouble() == 5, "finite channel beside it unchanged");
        Assert(badWire.GetProperty("modulate").GetProperty("r").GetDouble() == 0, "NaN colour channel written as 0");
        Assert(result.SanitizedIds.SequenceEqual(["bad"]), $"sanitize signal names the node; got [{string.Join(",", result.SanitizedIds)}]");
        Assert(result.Quarantined.Count == 0 && result.Failure is null, "a sanitized node is sent, not quarantined");
        Assert(UpsertIds(root).SequenceEqual(["fine", "bad"]), "both nodes ride the frame");
    }

    private static void CleanSerializeResetsTheSanitizeSignal()
    {
        var bad = Node("bad") with { Transform = new RuntimeSceneTransform2DSnapshot(new(double.NaN, 0), new(0, 1), new(0, 0)) };
        _ = BrowserSceneDeltaMessage.Serialize(Incremental([bad]));
        Assert(SceneWireNonFinite.Count == 1, "the signal counts the one sanitized channel");
        _ = BrowserSceneDeltaMessage.Serialize(Incremental([Node("fine")]));
        Assert(SceneWireNonFinite.Count == 0, "the next Serialize starts the count over");
        var clean = SceneDeltaSafeSerializer.Serialize(Incremental([Node("fine")]));
        Assert(!clean.HasFaults && clean.Bytes is not null, "a clean frame reports nothing");
    }

    private static void ThrowingUpsertIsQuarantinedAndTheRestIsSent()
    {
        var hint = new TweenHintDelta("a", "modulate:a", "1", 200, "linear", "in_out", EndOpacity: 1);
        var delta = Incremental([Node("a"), Throwing("bad"), Node("b")], removed: ["gone"], hints: [hint]);
        var threw = false;
        try { _ = BrowserSceneDeltaMessage.Serialize(delta, Patch); }
        catch (ArgumentException) { threw = true; }
        Assert(threw, "precondition: the plain serializer throws ArgumentException for a NaN double");

        var result = SceneDeltaSafeSerializer.Serialize(delta, Patch);
        var root = Parse(result.Bytes);
        Assert(UpsertIds(root).SequenceEqual(["a", "b"]), "the other upserts are sent, in order");
        Assert(root.GetProperty("removedIds").EnumerateArray().Select(id => id.GetString()).SequenceEqual(["gone"]), "removedIds intact");
        Assert(root.GetProperty("orderPatch").GetProperty("parents")[0].GetProperty("p").GetString() == "p", "orderPatch intact");
        Assert(root.GetProperty("hints").GetArrayLength() == 1, "hints intact");
        Assert(root.GetProperty("type").GetString() == "scene-delta" && !root.GetProperty("full").GetBoolean(), "envelope intact");
        Assert(result.Quarantined.Select(fault => fault.Node.Id).SequenceEqual(["bad"]), "the throwing node is reported");
        Assert(result.Quarantined[0].Exception is ArgumentException, "with the exception it threw");
        Assert(result.Requeue.Select(node => node.Id).SequenceEqual(["bad"]), "and handed back for re-queue");
        Assert(result.Failure is null, "the frame itself did not fail");
    }

    private static void ChildrenOfAQuarantinedAddAreHeldWithIt()
    {
        var delta = Incremental([Throwing("vfx"), Node("child", "vfx"), Node("grandchild", "child"), Node("other")]);
        var result = SceneDeltaSafeSerializer.Serialize(delta);
        Assert(UpsertIds(Parse(result.Bytes)).SequenceEqual(["other"]), "the subtree under a quarantined add is not sent alone");
        Assert(result.Held.Select(node => node.Id).OrderBy(id => id).SequenceEqual(["child", "grandchild"]), "its descendants are held");
        Assert(result.Requeue.Select(node => node.Id).OrderBy(id => id).SequenceEqual(["child", "grandchild", "vfx"]), "and re-queued with it");
    }

    private static void VolatileQuarantineHoldsNoChildren()
    {
        // A volatile re-send (no Name) of a node the client already holds: its children are not orphaned.
        var delta = Incremental([Throwing("vfx") with { Name = null, NodeType = null }, Node("child", "vfx")]);
        var result = SceneDeltaSafeSerializer.Serialize(delta);
        Assert(UpsertIds(Parse(result.Bytes)).SequenceEqual(["child"]), "the child of a volatile re-send still goes out");
        Assert(result.Held.Count == 0, "nothing held");
    }

    private static void AllQuarantinedIncrementalSendsNothing()
    {
        var result = SceneDeltaSafeSerializer.Serialize(Incremental([Throwing("bad")]));
        Assert(result.Bytes is null, "an incremental frame with nothing left produces no bytes");
        Assert(result.Failure is null, "which is not a failure");
        Assert(result.HasRequeue && result.Quarantined.Single().Node.Id == "bad", "the node is still handed back");
    }

    private static void KeyframeWithABadNodeStillSends()
    {
        var keyframe = new RuntimeSceneDelta(true, "combat", "screen:combat:live", [Node("root"), Throwing("bad", "root")], [], ["root", "bad"]);
        var result = SceneDeltaSafeSerializer.Serialize(keyframe);
        var root = Parse(result.Bytes);
        Assert(root.GetProperty("full").GetBoolean(), "still a keyframe");
        Assert(UpsertIds(root).SequenceEqual(["root"]), "without the bad node");
        Assert(root.GetProperty("orderedIds").GetArrayLength() == 2, "order kept as built (the client skips ids it holds no node for)");
        Assert(result.Quarantined.Single().Node.Id == "bad", "bad node reported");

        var empty = SceneDeltaSafeSerializer.Serialize(keyframe with { Upserts = [Throwing("bad")], OrderedIds = ["bad"] });
        Assert(empty.Bytes is not null, "a keyframe is sent even when every node was quarantined");
    }

    private static void ThrowingHintIsDroppedAndTheFrameIsSent()
    {
        var good = new TweenHintDelta("a", "position", null, 200, "linear", "in_out", EndTransform: [1, 0, 0, 1, 5, 5]);
        var bad = new TweenHintDelta("b", "position", null, 200, "linear", "in_out", EndTransform: [1, 0, 0, 1, double.NaN, 5]);
        var result = SceneDeltaSafeSerializer.Serialize(Incremental([Node("a")], hints: [good, bad]));
        var root = Parse(result.Bytes);
        Assert(root.GetProperty("hints").GetArrayLength() == 1
               && root.GetProperty("hints")[0].GetProperty("targetId").GetString() == "a", "the good hint survives");
        Assert(UpsertIds(root).SequenceEqual(["a"]), "the node rides as usual");
        Assert(result.DroppedHints.Single().TargetId == "b", "the bad hint is reported");
        Assert(result.Quarantined.Count == 0 && result.Failure is null, "no node quarantined, no failure");
    }

    // ---- coalescer re-queue ------------------------------------------------------------------------------------

    private static readonly Func<RuntimeSceneDelta?> Keyframe =
        () => new RuntimeSceneDelta(true, "combat", "screen:combat:live", [Node("KF")], [], ["KF"]);

    private static readonly Func<IReadOnlyList<string>, IReadOnlyList<string>, (SceneStructureIndex, SceneStructureIndex)> NoIndexes =
        (_, _) => (new SceneStructureIndex { RootIds = [], ChildIdsByParent = new Dictionary<string, IReadOnlyList<string>>() },
                   new SceneStructureIndex { RootIds = [], ChildIdsByParent = new Dictionary<string, IReadOnlyList<string>>() });

    private static (CoalescedSceneDelta? Taken, List<PendingUpsertRequest> Requests) Take(SceneDeltaCoalescer coalescer)
    {
        var requests = new List<PendingUpsertRequest>();
        var taken = coalescer.Take(Keyframe, batch =>
        {
            requests.AddRange(batch);
            return batch.Select(request => Node(request.Id)).ToList();
        }, NoIndexes);
        return (taken, requests);
    }

    private static void RequeuedIdIsRequestedByTheNextTake()
    {
        var coalescer = new SceneDeltaCoalescer();
        coalescer.Fold(Incremental([Node("a"), Node("b")]));
        _ = Take(coalescer);
        Assert(!coalescer.HasPending, "the Take emptied the accumulator");

        coalescer.Requeue([Node("a"), Node("v") with { Name = null, NodeType = null }]);
        Assert(coalescer.HasPending, "a re-queue makes the coalescer pending");
        var (taken, requests) = Take(coalescer);
        Assert(requests.Select(r => r.Id).OrderBy(id => id).SequenceEqual(["a", "v"]), "the next Take requests exactly the re-queued ids");
        Assert(requests.Single(r => r.Id == "a").NeedsStatic, "a quarantined add still resolves FULL");
        Assert(!requests.Single(r => r.Id == "v").NeedsStatic, "a quarantined volatile re-send stays volatile");
        Assert(taken is not null && taken.Delta.Upserts.Count == 2, "and the resolved nodes ride the frame");
    }

    private static void RemovalAfterRequeueWins()
    {
        var coalescer = new SceneDeltaCoalescer();
        coalescer.Requeue([Node("a")]);
        coalescer.Fold(Incremental([], removed: ["a"]));
        var (taken, requests) = Take(coalescer);
        Assert(requests.Count == 0, "a removal folded after the re-queue drops it");
        Assert(taken!.Delta.RemovedIds.SequenceEqual(["a"]), "and the removal is sent");
    }

    private static void RemovalBeforeRequeueWins()
    {
        var coalescer = new SceneDeltaCoalescer();
        // The node was removed while its frame was serializing (between Take and the re-queue).
        coalescer.Fold(Incremental([], removed: ["a"]));
        coalescer.Requeue([Node("a")]);
        var (taken, requests) = Take(coalescer);
        Assert(requests.Count == 0, "a re-queue does not resurrect a removed id");
        Assert(taken!.Delta.RemovedIds.SequenceEqual(["a"]), "the removal still goes out");
    }

    private static void PendingFullIgnoresRequeue()
    {
        var coalescer = new SceneDeltaCoalescer();
        coalescer.Fold(new RuntimeSceneDelta(true, "combat", "screen:combat:live", [], [], null));
        coalescer.Requeue([Node("a")]);
        var (taken, requests) = Take(coalescer);
        Assert(taken!.Delta.Full && requests.Count == 0, "a pending Full still resets everything");
        Assert(!coalescer.HasPending, "and nothing is left behind it");
    }

    private static void RequestKeyframeMakesTheNextTakeAKeyframe()
    {
        var coalescer = new SceneDeltaCoalescer();
        coalescer.Fold(Incremental([Node("a")], removed: ["z"]));
        coalescer.RequestKeyframe();
        Assert(coalescer.HasPending, "pending after a keyframe request");
        var (taken, requests) = Take(coalescer);
        Assert(taken!.Delta.Full && requests.Count == 0, "the next Take is a keyframe");
    }

    // ---- diagnostics -------------------------------------------------------------------------------------------

    private static void DiagnosticsRateLimitPerNodeWithSuppressedCount()
    {
        var lines = new List<string>();
        long now = 1_000;
        var log = new SceneSerializeDiagnostics(lines.Add, TimeSpan.FromSeconds(10), () => now);
        var result = SceneDeltaSafeSerializer.Serialize(Incremental([Throwing("bad"), Node("ok")]));
        for (var frame = 0; frame < 60; frame++)
        {
            log.Report(result, keyframe: false, id => id == "bad" ? "Root/Vfx" : null);
        }

        Assert(lines.Count == 1, $"60 failing frames inside the interval write one line; got {lines.Count}");
        Assert(lines[0].StartsWith("[scene] quarantined node bad (Root/Vfx) from a delta: ArgumentException", StringComparison.Ordinal),
            $"the line names the node, its path and the exception; got: {lines[0]}");

        now += 10_000;
        log.Report(result, keyframe: false, _ => null);
        Assert(lines.Count == 2 && lines[1].EndsWith("(+59 suppressed)", StringComparison.Ordinal),
            $"after the interval one more line carries the suppressed count; got: {lines.LastOrDefault()}");

        log.Write("other", () => "[scene] other");
        Assert(lines.Count == 3, "a different node id is limited on its own");
    }

    private static void DescribeNodePathWalksTheRetainedParents()
    {
        var nodes = new Dictionary<string, RuntimeSceneNodeDelta>(StringComparer.Ordinal)
        {
            ["1"] = Node("Combat") with { Id = "1" },
            ["2"] = Node("Vfx", "1") with { Id = "2" },
            ["3"] = Node("Burst", "2") with { Id = "3" },
        };
        Assert(CouchCoopSceneObserver.DescribeNodePath(nodes, "3") == "Combat/Vfx/Burst", "root-first name path");
        Assert(CouchCoopSceneObserver.DescribeNodePath(nodes, "missing") is null, "null for an id not retained");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"SceneDeltaQuarantineTests failed: {label}.");
        }
    }
}
