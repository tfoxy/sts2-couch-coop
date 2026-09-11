namespace CouchCoop.Mod.Server;

// A parent → ordered-children / roots index, the C# mirror of the client renderer's rebuildStructure output
// (frontend/src/mirror/mirrorRenderer.ts) and the client applySceneDelta's order structure: for each id in draw
// order, if its parentId is present AND the parent is a live node it's a child of that parent, else a root. The
// producer's orderedIds is a strict pre-order DFS of this tree (verified against the canonical recording), so
// flattening the index pre-order reconstructs orderedIds byte-identically — which is what lets Stage 4 ship a
// compact order PATCH (dirty parents + roots) instead of the full ~52KB id array on every structural change.
public sealed class SceneStructureIndex
{
    public required IReadOnlyList<string> RootIds { get; init; }
    public required IReadOnlyDictionary<string, IReadOnlyList<string>> ChildIdsByParent { get; init; }
}

// One dirty parent's new ordered child-id list.
public sealed record SceneOrderParentPatch(string ParentId, IReadOnlyList<string> ChildIds);

// An incremental order update: the new root list (only when roots changed, else null) + every parent whose child
// list changed. The client applies it to its structure (rebuilt from the PREVIOUS orderedIds + its node map) and
// re-flattens to the new orderedIds.
public sealed record SceneOrderPatch(IReadOnlyList<string>? Roots, IReadOnlyList<SceneOrderParentPatch> Parents);

// Pure order-diff: computes which parents' child lists changed between the last-sent structure and the new one
// (porting the client's structureDiff.ts semantics), decides full-array vs patch, and self-verifies the patch
// reconstructs the exact new order before emitting it.
internal static class SceneOrderDiff
{
    // Full-array fallback thresholds (a big structural churn isn't worth patching — send the array).
    private const int MaxDirtyParents = 64;

    private static bool SameList(IReadOnlyList<string> a, IReadOnlyList<string> b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a.Count != b.Count)
        {
            return false;
        }

        for (var i = 0; i < a.Count; i++)
        {
            if (!string.Equals(a[i], b[i], StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    // Try to build an order PATCH that transforms `oldIndex` into `newIndex` (whose flattened order is `newOrder`).
    // Returns null when a full-array send is warranted: too many dirty parents (>64), >25% of parents dirty, or the
    // self-check fails (the patch didn't reconstruct newOrder — never emit an unverified patch).
    public static SceneOrderPatch? TryComputePatch(
        SceneStructureIndex oldIndex,
        SceneStructureIndex newIndex,
        IReadOnlyList<string> newOrder)
    {
        var (patch, dirtyCount) = BuildPatch(oldIndex, newIndex);

        var totalParents = newIndex.ChildIdsByParent.Count;
        if (dirtyCount > MaxDirtyParents || (totalParents > 0 && dirtyCount * 4 > totalParents))
        {
            return null;
        }

        // Self-check: apply the patch to the OLD structure and flatten — it MUST equal the new order, or we never
        // emit it (fall back to the full array). Guards the client against any diff bug in production.
        return SameList(ApplyAndFlatten(oldIndex, patch), newOrder) ? patch : null;
    }

    // Pure diff → patch (no size fallback, no self-check): the parents whose child lists changed (including a parent
    // that gained its first / lost its last child) plus the roots when they changed. `dirtyCount` feeds the
    // fallback thresholds. Exposed for testing the diff independent of the heuristics.
    internal static (SceneOrderPatch Patch, int DirtyCount) BuildPatch(SceneStructureIndex oldIndex, SceneStructureIndex newIndex)
    {
        var dirtyParents = new List<string>();

        // Parents present in NEW: a differing (or brand-new) child list is dirty.
        foreach (var (pid, newList) in newIndex.ChildIdsByParent)
        {
            if (!oldIndex.ChildIdsByParent.TryGetValue(pid, out var oldList) || !SameList(oldList, newList))
            {
                dirtyParents.Add(pid);
            }
        }

        // Parents present in OLD but gone from NEW lost ALL their children → emit an empty child list so the client
        // clears them (harmless if the parent itself was removed — the client just never reaches it).
        foreach (var (pid, _) in oldIndex.ChildIdsByParent)
        {
            if (!newIndex.ChildIdsByParent.ContainsKey(pid))
            {
                dirtyParents.Add(pid);
            }
        }

        var rootsDirty = !SameList(oldIndex.RootIds, newIndex.RootIds);

        var parents = new List<SceneOrderParentPatch>(dirtyParents.Count);
        foreach (var pid in dirtyParents)
        {
            var childIds = newIndex.ChildIdsByParent.TryGetValue(pid, out var list) ? list : [];
            parents.Add(new SceneOrderParentPatch(pid, childIds));
        }

        return (new SceneOrderPatch(rootsDirty ? newIndex.RootIds : null, parents), dirtyParents.Count);
    }

    // Apply `patch` to `baseIndex` and pre-order flatten — the exact operation the client performs, used here only
    // to self-verify the patch reconstructs the intended order.
    private static List<string> ApplyAndFlatten(SceneStructureIndex baseIndex, SceneOrderPatch patch)
    {
        var roots = patch.Roots ?? baseIndex.RootIds;
        var children = new Dictionary<string, IReadOnlyList<string>>(baseIndex.ChildIdsByParent, StringComparer.Ordinal);
        foreach (var parent in patch.Parents)
        {
            children[parent.ParentId] = parent.ChildIds;
        }

        var order = new List<string>();
        var stack = new Stack<string>();
        for (var i = roots.Count - 1; i >= 0; i--)
        {
            stack.Push(roots[i]);
        }

        while (stack.Count > 0)
        {
            var id = stack.Pop();
            order.Add(id);
            if (children.TryGetValue(id, out var kids))
            {
                for (var i = kids.Count - 1; i >= 0; i--)
                {
                    stack.Push(kids[i]);
                }
            }
        }

        return order;
    }
}
