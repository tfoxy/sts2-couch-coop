using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for GlobalTransformIndex (game-space global Transform2D per node id): local chain composition == hand-multiplied, downward dirtying on a parent transform change, keyframe
// full-recompute + stale purge, revision-reset full recompute, and missing/orphaned-parent tolerance.
internal static class GlobalTransformIndexTests
{
    public static void Run()
    {
        LocalChainEqualsHandMultiplied();
        ParentTransformChangeDirtiesDescendants();
        KeyframeFullRecomputePurgesStale();
        RevisionResetForcesFullRecompute();
        MissingAndOrphanedParentsTolerated();
        OrderOnlyDeltaIsNoOp();
    }

    private static MirrorNode Node(string id, string? parent, double[]? transform) =>
        new() { Id = id, ParentId = parent, Transform = transform };

    // Populate a state's node map + ordered ids, mark the given ids changed, and bump the revision (an applied delta).
    private static void Mark(MirrorState state, params string[] changed)
    {
        state.ChangedIds.Clear();
        foreach (var id in changed)
        {
            state.ChangedIds.Add(id);
        }

        state.Revision++;
    }

    private static void Add(MirrorState state, MirrorNode node)
    {
        state.Nodes[node.Id] = node;
        if (!state.OrderedIds.Contains(node.Id))
        {
            state.OrderedIds.Add(node.Id);
        }
    }

    private static double[] Global(GlobalTransformIndex index, string id)
    {
        Check.That(index.TryGetGlobal(id, out var g), $"has global for {id}");
        return [.. g];
    }

    // "local" space: compose down the parent chain; the result equals the hand-multiplied Affine chain.
    private static void LocalChainEqualsHandMultiplied()
    {
        double[] ta = [1, 0, 0, 1, 100, 0];
        double[] tb = [2, 0, 0, 2, 0, 50];
        double[] tc = [1, 0, 0, 1, 5, 0];

        var state = MirrorState.Create();
        Add(state, Node("a", null, ta));
        Add(state, Node("b", "a", tb));
        Add(state, Node("c", "b", tc));
        Mark(state, "a", "b", "c");

        var index = new GlobalTransformIndex();
        index.Update(state);

        var expectedB = Affine.Multiply(ta, tb);
        var expectedC = Affine.Multiply(expectedB, tc);
        Check.SequenceClose(Global(index, "a"), ta, "local a == own transform (root)");
        Check.SequenceClose(Global(index, "b"), expectedB, "local b == ta·tb");
        Check.SequenceClose(Global(index, "c"), expectedC, "local c == (ta·tb)·tc");
    }

    // Changing ONLY the parent's transform (parent alone in changedIds) must move the whole subtree's globals.
    private static void ParentTransformChangeDirtiesDescendants()
    {
        double[] ta = [1, 0, 0, 1, 100, 0];
        double[] tb = [2, 0, 0, 2, 0, 50];
        double[] tc = [1, 0, 0, 1, 5, 0];

        var state = MirrorState.Create();
        Add(state, Node("a", null, ta));
        Add(state, Node("b", "a", tb));
        Add(state, Node("c", "b", tc));
        Mark(state, "a", "b", "c");

        var index = new GlobalTransformIndex();
        index.Update(state);
        Check.Close(Global(index, "c")[4], 110, "baseline c.tx");
        var version0 = index.Version;

        // Replace ONLY the parent's transform, mark ONLY "a" changed (incremental path, not a keyframe).
        double[] ta2 = [1, 0, 0, 1, 200, 0];
        state.Nodes["a"] = Node("a", null, ta2);
        Mark(state, "a");
        index.Update(state);

        Check.That(index.Version > version0, "version bumped after incremental recompute");
        var expectedB = Affine.Multiply(ta2, tb);
        var expectedC = Affine.Multiply(expectedB, tc);
        Check.SequenceClose(Global(index, "a"), ta2, "a moved to new transform");
        Check.SequenceClose(Global(index, "b"), expectedB, "descendant b moved (parent change propagated)");
        Check.SequenceClose(Global(index, "c"), expectedC, "descendant c moved (parent change propagated)");
        Check.Close(Global(index, "c")[4], 210, "c.tx shifted 110→210 by parent-only change");
    }

    // A full keyframe (changedIds covering the whole tree) recomputes all and purges nodes that vanished.
    private static void KeyframeFullRecomputePurgesStale()
    {
        var state = MirrorState.Create();
        Add(state, Node("a", null, [1, 0, 0, 1, 10, 0]));
        Add(state, Node("b", "a", [1, 0, 0, 1, 0, 20]));
        Mark(state, "a", "b");

        var index = new GlobalTransformIndex();
        index.Update(state);
        Check.That(index.TryGetGlobal("b", out _), "b present before keyframe");

        // Keyframe: the applier clears + re-upserts; here b is gone, a is re-transformed, d is new. changedIds spans
        // the removed + the re-added ids (count ≥ node count ⇒ the full-recompute path).
        state.Nodes.Remove("b");
        state.OrderedIds.Remove("b");
        state.Nodes["a"] = Node("a", null, [3, 0, 0, 3, 0, 0]);
        Add(state, Node("d", "a", [1, 0, 0, 1, 7, 0]));
        Mark(state, "a", "b", "d");
        index.Update(state);

        Check.That(!index.TryGetGlobal("b", out _), "stale b purged on keyframe full-recompute");
        Check.SequenceClose(Global(index, "a"), [3, 0, 0, 3, 0, 0], "a recomputed on keyframe");
        Check.SequenceClose(Global(index, "d"), Affine.Multiply([3, 0, 0, 3, 0, 0], [1, 0, 0, 1, 7, 0]), "new d composed under new a");
    }

    // A brand-new MirrorState (Revision reset to 0) forces a full recompute even without a keyframe flag.
    private static void RevisionResetForcesFullRecompute()
    {
        var index = new GlobalTransformIndex();

        var first = MirrorState.Create();
        Add(first, Node("a", null, [1, 0, 0, 1, 1, 1]));
        Mark(first, "a"); // Revision → 1
        index.Update(first);
        Check.That(index.TryGetGlobal("a", out _), "a present from first state");

        // A fresh state object starts at Revision 0 (< lastRevision) → treated as a full rebuild.
        var replaced = MirrorState.Create();
        Add(replaced, Node("z", null, [5, 0, 0, 5, 9, 9]));
        // NOTE: no Mark() → Revision stays 0, exercising the revision-reset trigger even with a small changed set.
        replaced.ChangedIds.Add("z");
        index.Update(replaced);

        Check.That(!index.TryGetGlobal("a", out _), "old node dropped after state replacement");
        Check.SequenceClose(Global(index, "z"), [5, 0, 0, 5, 9, 9], "z from replaced state");
    }

    // A parent id pointing at a missing node (never-present or removed) resolves against identity, not a crash.
    private static void MissingAndOrphanedParentsTolerated()
    {
        double[] tx = [2, 0, 0, 2, 4, 8];
        double[] tb = [1, 0, 0, 1, 3, 3];

        var state = MirrorState.Create();
        // "x" references a parent that is not in the tree; an extra "z" keeps the incremental path alive later.
        Add(state, Node("a", null, [1, 0, 0, 1, 50, 0]));
        Add(state, Node("b", "a", tb));
        Add(state, Node("x", "ghost", tx));
        Add(state, Node("z", null, [1, 0, 0, 1, 0, 0]));
        Mark(state, "a", "b", "x", "z");

        var index = new GlobalTransformIndex();
        index.Update(state);
        // Missing parent ⇒ identity parent ⇒ global == own transform.
        Check.SequenceClose(Global(index, "x"), tx, "missing-parent node resolves against identity");
        Check.SequenceClose(Global(index, "b"), Affine.Multiply([1, 0, 0, 1, 50, 0], tb), "b composed under a");

        // Remove "a" incrementally (node count 3 > changed count 1 ⇒ incremental path). Orphaned b must fall back to
        // an identity parent, not keep composing under the now-missing "a".
        state.Nodes.Remove("a");
        state.OrderedIds.Remove("a");
        Mark(state, "a");
        index.Update(state);

        Check.That(!index.TryGetGlobal("a", out _), "removed a purged (incremental)");
        Check.SequenceClose(Global(index, "b"), tb, "orphaned b falls back to identity parent (incremental)");
    }

    // An order-only delta (revision bumped, nothing in changedIds) leaves globals + Version untouched.
    private static void OrderOnlyDeltaIsNoOp()
    {
        var state = MirrorState.Create();
        Add(state, Node("a", null, [1, 0, 0, 1, 1, 0]));
        Add(state, Node("b", "a", [1, 0, 0, 1, 0, 1]));
        Mark(state, "a", "b");

        var index = new GlobalTransformIndex();
        index.Update(state);
        var version0 = index.Version;
        var bBefore = Global(index, "b");

        // A pure reorder: applier bumps Revision but adds nothing to changedIds.
        state.OrderedIds.Reverse();
        Mark(state); // clears changedIds, Revision++
        index.Update(state);

        Check.Equal(index.Version, version0, "order-only delta does not bump Version");
        Check.SequenceClose(Global(index, "b"), bBefore, "order-only delta leaves globals unchanged");
    }
}
