using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;

// Unit checks for the per-connection scene-delta coalescer: folding a sequence of incremental deltas into one
// pending update, full-keyframe supersession, the upsert/remove interplay, the wire-diet per-id NeedsStatic /
// IntentDirty bookkeeping (Stage 1), and the Stage 4 order-patch decision (full array first, patch thereafter).
// Pure (no socket / no live game); assert-or-throw harness style.
internal static class SceneDeltaCoalescerTests
{
    public static void Run()
    {
        UpsertsCoalesceByIdLatestWins();
        UpsertThenRemoveYieldsRemoval();
        RemoveThenUpsertYieldsUpsert();
        FullKeyframeSupersedesPending();
        OrderedIdsCarryThrough();
        NothingResolvableTakesNull();
        TakeClearsPending();
        StaticThenVolatileFoldKeepsNeedsStatic();
        VolatileOnlyIdRequestsVolatileProjection();
        IntentDirtyTrackedFromAnyFold();
        LineDirtyTrackedFromAnyFold();
        KeyframeUnaffectedByPendingFlags();
        FirstStructuralSendIsFullThenPatch();
        ResetDropsPendingAndOrderBaseline();
    }

    // Node parenthood for the structure-index stub (null = root). Includes a small multi-parent tree so the Stage 4
    // >25%-dirty fallback (correct for the real hundreds-of-parents scene) doesn't trip on a single reorder.
    private static readonly Dictionary<string, string?> NodeParents = new(StringComparer.Ordinal)
    {
        ["R"] = null, ["a"] = "R", ["b"] = "R", ["c"] = "R",
        ["g0"] = "R", ["g1"] = "R", ["g2"] = "R",
        ["x0"] = "g0", ["y0"] = "g0", ["x1"] = "g1", ["y1"] = "g1", ["x2"] = "g2", ["y2"] = "g2",
    };

    // A FULL (static-carrying) node: Name is non-null → an add/keyframe upsert.
    private static RuntimeSceneNodeDelta Node(string id) => new(
        Id: id, ParentId: NodeParents.GetValueOrDefault(id), Name: id, NodeType: "Control", Rect: null,
        Visible: true, Opacity: 1, ZIndex: null, Rotation: 0, Texture: null, NinePatch: false, Text: null);

    // A VOLATILE-ONLY node: Name null → a per-tick upsert (no static block).
    private static RuntimeSceneNodeDelta VolatileNode(string id) => Node(id) with { Name = null, NodeType = null };

    private static RuntimeSceneIntentFramesSnapshot IntentFrames(string anim) =>
        new(anim, 15, [new RuntimeSceneIntentFrameSnapshot("res://images/intent.png", null, null)]);

    private static RuntimeSceneDelta Delta(
        bool full = false,
        IReadOnlyList<RuntimeSceneNodeDelta>? upserts = null,
        IReadOnlyList<string>? removed = null,
        IReadOnlyList<string>? ordered = null)
        => new(full, "run", "screen:run:live", upserts ?? [], removed ?? [], ordered);

    // Resolve requests to nodes (mimics the observer's retained map: one current node per requested id).
    private static readonly Func<IReadOnlyList<PendingUpsertRequest>, IReadOnlyList<RuntimeSceneNodeDelta>> Resolve =
        requests => requests.Select(r => Node(r.Id)).ToList();

    private static readonly Func<RuntimeSceneDelta?> Keyframe =
        () => Delta(full: true, upserts: [Node("KF")], ordered: ["KF"]);

    // Structure-index builder stub (the observer does this from its node map in production): a,b,c are children of
    // R; everything else is a root. Both orders indexed the same way — the coalescer diffs them for Stage 4.
    private static readonly Func<IReadOnlyList<string>, IReadOnlyList<string>, (SceneStructureIndex, SceneStructureIndex)> BuildIndexes =
        (oldOrder, newOrder) => (BuildIndex(oldOrder), BuildIndex(newOrder));

    private static SceneStructureIndex BuildIndex(IReadOnlyList<string> order)
    {
        var roots = new List<string>();
        var children = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        var lists = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var id in order)
        {
            var parent = NodeParents.GetValueOrDefault(id);
            if (parent is not null && order.Contains(parent))
            {
                if (!lists.TryGetValue(parent, out var list))
                {
                    list = [];
                    lists[parent] = list;
                    children[parent] = list;
                }

                list.Add(id);
            }
            else
            {
                roots.Add(id);
            }
        }

        return new SceneStructureIndex { RootIds = roots, ChildIdsByParent = children };
    }

    // A resolve that CAPTURES the requests so a test can assert the per-id NeedsStatic / IntentDirty flags.
    private static (Func<IReadOnlyList<PendingUpsertRequest>, IReadOnlyList<RuntimeSceneNodeDelta>> resolve,
        List<PendingUpsertRequest> captured) CapturingResolve()
    {
        var captured = new List<PendingUpsertRequest>();
        return (requests =>
        {
            captured.Clear();
            captured.AddRange(requests);
            return requests.Select(r => Node(r.Id)).ToList();
        }, captured);
    }

    private static void UpsertsCoalesceByIdLatestWins()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [Node("a")]));
        c.Fold(Delta(upserts: [Node("a"), Node("b")]));
        var taken = c.Take(Keyframe, Resolve, BuildIndexes)!.Delta;
        var ids = taken.Upserts.Select(n => n.Id).OrderBy(x => x).ToArray();
        Assert(ids.SequenceEqual(["a", "b"]), "two folds of 'a' coalesce to a single upsert id");
        Assert(taken.RemovedIds.Count == 0 && !taken.Full, "incremental, no removals");
    }

    private static void UpsertThenRemoveYieldsRemoval()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [Node("a"), Node("b")]));
        c.Fold(Delta(removed: ["a"]));
        var taken = c.Take(Keyframe, Resolve, BuildIndexes)!.Delta;
        Assert(taken.Upserts.Select(n => n.Id).SequenceEqual(["b"]), "removed id drops from pending upserts");
        Assert(taken.RemovedIds.SequenceEqual(["a"]), "removed id is reported");
    }

    private static void RemoveThenUpsertYieldsUpsert()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(removed: ["a"]));
        c.Fold(Delta(upserts: [Node("a")]));
        var taken = c.Take(Keyframe, Resolve, BuildIndexes)!.Delta;
        Assert(taken.Upserts.Select(n => n.Id).SequenceEqual(["a"]), "re-added id upserts");
        Assert(taken.RemovedIds.Count == 0, "re-added id is no longer a removal");
    }

    private static void FullKeyframeSupersedesPending()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [Node("a")], removed: ["z"]));
        c.Fold(Delta(full: true, upserts: [Node("x")], ordered: ["x"]));
        var taken = c.Take(Keyframe, Resolve, BuildIndexes)!.Delta;
        Assert(taken.Full, "a pending Full makes Take rebuild a keyframe");
        Assert(taken.Upserts.Select(n => n.Id).SequenceEqual(["KF"]), "keyframe comes from buildKeyframe, not the folded incrementals");
    }

    private static void OrderedIdsCarryThrough()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [Node("a")], ordered: ["a", "b"]));
        // First structural send after construction: no baseline → full array (not a patch).
        var taken = c.Take(Keyframe, Resolve, BuildIndexes)!;
        Assert(taken.Delta.OrderedIds is not null && taken.Delta.OrderedIds.SequenceEqual(["a", "b"]), "structural orderedIds carry through");
        Assert(taken.OrderPatch is null, "first structural send is the full array, no patch");
    }

    private static void NothingResolvableTakesNull()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [Node("a")]));
        // Resolve returns nothing (the node vanished) and there were no removals/order → nothing to send.
        var taken = c.Take(Keyframe, _ => [], BuildIndexes);
        Assert(taken is null, "an empty resolvable delta yields null (no wasted frame)");
    }

    private static void TakeClearsPending()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [Node("a")]));
        Assert(c.HasPending, "pending after fold");
        c.Take(Keyframe, Resolve, BuildIndexes);
        Assert(!c.HasPending, "not pending after take");
    }

    private static void StaticThenVolatileFoldKeepsNeedsStatic()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [Node("a")]));
        c.Fold(Delta(upserts: [VolatileNode("a")]));
        var (resolve, captured) = CapturingResolve();
        c.Take(Keyframe, resolve, BuildIndexes);
        Assert(captured.Single(r => r.Id == "a").NeedsStatic, "NeedsStatic sticks once a static fold arrived in the window");

        var d = new SceneDeltaCoalescer();
        d.Fold(Delta(upserts: [VolatileNode("a")]));
        d.Fold(Delta(upserts: [Node("a")]));
        var (resolve2, captured2) = CapturingResolve();
        d.Take(Keyframe, resolve2, BuildIndexes);
        Assert(captured2.Single(r => r.Id == "a").NeedsStatic, "a static fold anywhere in the window sets NeedsStatic");
    }

    private static void VolatileOnlyIdRequestsVolatileProjection()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [VolatileNode("a")]));
        c.Fold(Delta(upserts: [VolatileNode("a")]));
        var (resolve, captured) = CapturingResolve();
        c.Take(Keyframe, resolve, BuildIndexes);
        var req = captured.Single(r => r.Id == "a");
        Assert(!req.NeedsStatic, "a pure-volatile id resolves as a volatile projection (NeedsStatic false)");
        Assert(!req.IntentDirty, "no intent frames folded → IntentDirty false");
        Assert(!req.LineDirty, "no stroke geometry folded → LineDirty false (an idle map re-ships no points)");
    }

    // LineDirty is the IntentDirty twin for the Line2D stroke unit: a fresh point array anywhere in the window makes
    // the resolved volatile projection carry the retained geometry. Latest-wins is exactly right for a mid-drag
    // stroke — a slow client skips the intermediate arrays and gets the newest one. The three line fields ship as one
    // unit, so LinePoints alone decides. An EMPTY array (the clear/undo instruction) must ALSO set the flag, or the
    // client would never be told to erase.
    private static void LineDirtyTrackedFromAnyFold()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [VolatileNode("stroke")]));
        c.Fold(Delta(upserts: [VolatileNode("stroke") with { LinePoints = [1, 2, 3, 4] }]));
        var (resolve, captured) = CapturingResolve();
        c.Take(Keyframe, resolve, BuildIndexes);
        var req = captured.Single(r => r.Id == "stroke");
        Assert(req.LineDirty, "a fresh stroke fold sets LineDirty");
        Assert(!req.NeedsStatic, "a stroke change on a volatile upsert does not force the full static block");

        var d = new SceneDeltaCoalescer();
        d.Fold(Delta(upserts: [VolatileNode("stroke") with { LinePoints = [] }]));
        d.Fold(Delta(upserts: [VolatileNode("stroke")]));
        var (resolve2, captured2) = CapturingResolve();
        d.Take(Keyframe, resolve2, BuildIndexes);
        Assert(captured2.Single(r => r.Id == "stroke").LineDirty,
            "an EMPTY (cleared) stroke fold sets LineDirty, and a later plain volatile fold does not clear it");
    }

    private static void IntentDirtyTrackedFromAnyFold()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [VolatileNode("glyph")]));
        c.Fold(Delta(upserts: [VolatileNode("glyph") with { IntentFrames = IntentFrames("attack") }]));
        var (resolve, captured) = CapturingResolve();
        c.Take(Keyframe, resolve, BuildIndexes);
        var req = captured.Single(r => r.Id == "glyph");
        Assert(req.IntentDirty, "a fresh intent-frame fold sets IntentDirty");
        Assert(!req.NeedsStatic, "an intent change on a volatile upsert does not force the full static block");
    }

    private static void KeyframeUnaffectedByPendingFlags()
    {
        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(upserts: [VolatileNode("a") with { IntentFrames = IntentFrames("cast") }]));
        c.Fold(Delta(full: true, upserts: [Node("x")], ordered: ["x"]));
        var (resolve, captured) = CapturingResolve();
        var taken = c.Take(Keyframe, resolve, BuildIndexes)!;
        Assert(taken.Delta.Full, "pending Full supersedes the accumulated volatile/intent bookkeeping");
        Assert(captured.Count == 0, "keyframe path never asks resolve to project pending ids");
    }

    // Stage 4: the FIRST structural send after a keyframe has no baseline → full array; a subsequent reorder ships
    // a compact patch (and drops the full array from the raw delta).
    private static void FirstStructuralSendIsFullThenPatch()
    {
        // A 4-parent tree (R + g0,g1,g2) so a single reorder is well under the >25%-dirty fallback.
        string[] baseOrder = ["R", "g0", "x0", "y0", "g1", "x1", "y1", "g2", "x2", "y2"];
        string[] reordered = ["R", "g0", "y0", "x0", "g1", "x1", "y1", "g2", "x2", "y2"]; // g0's kids swapped
        RuntimeSceneNodeDelta[] Tree() => baseOrder.Select(Node).ToArray();

        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(full: true, upserts: Tree(), ordered: baseOrder));
        var kf = c.Take(() => Delta(full: true, upserts: Tree(), ordered: baseOrder), Resolve, BuildIndexes)!;
        Assert(kf.Delta.Full && kf.OrderPatch is null, "keyframe carries the full order, no patch");

        // A reorder of g0's children (x0,y0) → (y0,x0): patch expected.
        c.Fold(Delta(upserts: [Node("x0"), Node("y0")], ordered: reordered));
        var taken = c.Take(Keyframe, Resolve, BuildIndexes)!;
        Assert(taken.OrderPatch is not null, "subsequent structural send ships a patch");
        Assert(taken.Delta.OrderedIds is null, "the full array is dropped when a patch is sent");
        Assert(taken.OrderPatch!.Parents.Any(p => p.ParentId == "g0" && p.ChildIds.SequenceEqual(["y0", "x0"])), "patch reorders g0's children");
    }

    // WS-B stream gate: Reset() drops BOTH halves of the coalescer's carried state.
    //  - the pending accumulator, so a delta folded before the gap is never resolved and shipped after it;
    //  - `_lastSentOrder`, so the first structural send after the gap ships the FULL array instead of a patch
    //    diffed against an order the client no longer holds (which would render as a scrambled tree). This is the
    //    same "no baseline yet" state a fresh connection is in, and the pre-Reset half of this test proves the
    //    baseline really was armed — i.e. that without the reset a patch WOULD have been emitted.
    private static void ResetDropsPendingAndOrderBaseline()
    {
        string[] baseOrder = ["R", "g0", "x0", "y0", "g1", "x1", "y1", "g2", "x2", "y2"];
        string[] reordered = ["R", "g0", "y0", "x0", "g1", "x1", "y1", "g2", "x2", "y2"];
        RuntimeSceneNodeDelta[] Tree() => baseOrder.Select(Node).ToArray();

        var c = new SceneDeltaCoalescer();
        c.Fold(Delta(full: true, upserts: Tree(), ordered: baseOrder));
        c.Take(() => Delta(full: true, upserts: Tree(), ordered: baseOrder), Resolve, BuildIndexes);

        // Baseline armed: a reorder now WOULD ship a patch (this is the state a gap must not be entered with).
        c.Fold(Delta(upserts: [Node("x0"), Node("y0")], ordered: reordered));
        Assert(c.HasPending, "a folded delta marks the accumulator pending");
        Assert(c.Take(Keyframe, Resolve, BuildIndexes)!.OrderPatch is not null, "baseline armed → patch");

        // Re-arm the accumulator, then Reset as the gate does.
        c.Fold(Delta(upserts: [Node("x0")], ordered: baseOrder));
        Assert(c.HasPending, "pre-Reset the accumulator holds a pending delta");
        c.Reset();
        Assert(!c.HasPending, "Reset drops the pending accumulator");
        Assert(c.Take(Keyframe, Resolve, BuildIndexes) is null, "nothing accumulated survives a Reset");

        // Post-Reset the FIRST structural send is a full array again — no patch against the pre-gap order.
        c.Fold(Delta(upserts: [Node("x0"), Node("y0")], ordered: reordered));
        var afterReset = c.Take(Keyframe, Resolve, BuildIndexes)!;
        Assert(afterReset.OrderPatch is null, "Reset clears the order baseline → no patch on the first send after a gap");
        Assert(
            afterReset.Delta.OrderedIds is not null && afterReset.Delta.OrderedIds.SequenceEqual(reordered),
            "the first structural send after a Reset ships the FULL order array");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"SceneDeltaCoalescerTests failed: {label}.");
        }
    }
}
