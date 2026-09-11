using CouchCoop.Mod.Server;

// Stage 4 order-diff checks: SceneOrderDiff computes a compact order patch (dirty parents + roots) that
// reconstructs the exact new draw order from the last-sent structure, and falls back to the full array when the
// churn is too big. Goldens for insert / remove / reorder / reparent / root changes, plus the self-check + fallback.
// Pure; assert-or-throw.
internal static class SceneOrderDiffTests
{
    public static void Run()
    {
        ReorderSiblings();
        InsertChild();
        RemoveChild();
        Reparent();
        RootsReordered();
        FirstChildAndLostAllChildren();
        FallbackWhenTooManyDirtyParents();
        NoChangeYieldsEmptyPatch();
    }

    private static SceneStructureIndex Index(string[] roots, params (string p, string[] c)[] children)
    {
        var map = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var (p, c) in children)
        {
            map[p] = c;
        }

        return new SceneStructureIndex { RootIds = roots, ChildIdsByParent = map };
    }

    // Pre-order flatten of an index — the reference "what order does this structure represent" used by the tests.
    private static List<string> Flatten(SceneStructureIndex index)
    {
        var order = new List<string>();
        var stack = new Stack<string>();
        for (var i = index.RootIds.Count - 1; i >= 0; i--)
        {
            stack.Push(index.RootIds[i]);
        }

        while (stack.Count > 0)
        {
            var id = stack.Pop();
            order.Add(id);
            if (index.ChildIdsByParent.TryGetValue(id, out var kids))
            {
                for (var i = kids.Count - 1; i >= 0; i--)
                {
                    stack.Push(kids[i]);
                }
            }
        }

        return order;
    }

    // Apply a patch to an old index and flatten — mirrors the client, used to assert the emitted patch is correct.
    private static List<string> ApplyPatch(SceneStructureIndex oldIndex, SceneOrderPatch patch)
    {
        var children = new Dictionary<string, IReadOnlyList<string>>(oldIndex.ChildIdsByParent, StringComparer.Ordinal);
        foreach (var p in patch.Parents)
        {
            children[p.ParentId] = p.ChildIds;
        }

        var roots = patch.Roots ?? oldIndex.RootIds;
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

    // Build the pure diff patch (no size fallback) and assert it reconstructs the new order — the algorithm goldens
    // use small trees where the >25%-dirty fallback would otherwise trip (that heuristic is covered separately).
    private static SceneOrderPatch PatchOrThrow(SceneStructureIndex oldIndex, SceneStructureIndex newIndex, string label)
    {
        var (patch, _) = SceneOrderDiff.BuildPatch(oldIndex, newIndex);
        Assert(ApplyPatch(oldIndex, patch).SequenceEqual(Flatten(newIndex)), $"{label}: patch reconstructs the new order");
        return patch;
    }

    private static void ReorderSiblings()
    {
        var oldI = Index(["R"], ("R", ["a", "b", "c"]));
        var newI = Index(["R"], ("R", ["c", "b", "a"]));
        var patch = PatchOrThrow(oldI, newI, "reorder");
        Assert(patch.Roots is null, "reorder: roots unchanged");
        Assert(patch.Parents.Count == 1 && patch.Parents[0].ParentId == "R", "reorder: only R dirty");
        Assert(patch.Parents[0].ChildIds.SequenceEqual(["c", "b", "a"]), "reorder: R's new child list");
    }

    private static void InsertChild()
    {
        var oldI = Index(["R"], ("R", ["a", "b"]));
        var newI = Index(["R"], ("R", ["a", "x", "b"]));
        var patch = PatchOrThrow(oldI, newI, "insert");
        Assert(patch.Parents.Single().ChildIds.SequenceEqual(["a", "x", "b"]), "insert: R gains x");
    }

    private static void RemoveChild()
    {
        var oldI = Index(["R"], ("R", ["a", "b", "c"]));
        var newI = Index(["R"], ("R", ["a", "c"]));
        var patch = PatchOrThrow(oldI, newI, "remove");
        Assert(patch.Parents.Single().ChildIds.SequenceEqual(["a", "c"]), "remove: b dropped from R");
    }

    private static void Reparent()
    {
        var oldI = Index(["R"], ("R", ["P1", "P2"]), ("P1", ["x"]));
        var newI = Index(["R"], ("R", ["P1", "P2"]), ("P2", ["x"]));
        var patch = PatchOrThrow(oldI, newI, "reparent");
        // P1 lost its only child (→ empty list), P2 gained it.
        var byParent = patch.Parents.ToDictionary(p => p.ParentId, p => p.ChildIds);
        Assert(byParent.ContainsKey("P1") && byParent["P1"].Count == 0, "reparent: P1 cleared");
        Assert(byParent.ContainsKey("P2") && byParent["P2"].SequenceEqual(["x"]), "reparent: P2 gains x");
        Assert(patch.Roots is null, "reparent: roots unchanged");
    }

    private static void RootsReordered()
    {
        var oldI = Index(["A", "B"]);
        var newI = Index(["B", "A"]);
        var patch = PatchOrThrow(oldI, newI, "roots");
        Assert(patch.Roots is not null && patch.Roots.SequenceEqual(["B", "A"]), "roots: new root order shipped");
    }

    private static void FirstChildAndLostAllChildren()
    {
        // A parent gains its FIRST child (absent from old index) and another loses its LAST.
        var oldI = Index(["R"], ("R", ["P", "Q"]), ("Q", ["y"]));
        var newI = Index(["R"], ("R", ["P", "Q"]), ("P", ["x"]));
        var patch = PatchOrThrow(oldI, newI, "first/last child");
        var byParent = patch.Parents.ToDictionary(p => p.ParentId, p => p.ChildIds);
        Assert(byParent["P"].SequenceEqual(["x"]), "P gains its first child");
        Assert(byParent["Q"].Count == 0, "Q loses its last child");
    }

    private static void FallbackWhenTooManyDirtyParents()
    {
        // 70 parents each with one child, all reordered → >64 dirty → full-array fallback (null patch).
        var oldChildren = new (string, string[])[70];
        var newChildren = new (string, string[])[70];
        var roots = new string[70];
        for (var i = 0; i < 70; i++)
        {
            roots[i] = $"P{i}";
            oldChildren[i] = ($"P{i}", [$"a{i}", $"b{i}"]);
            newChildren[i] = ($"P{i}", [$"b{i}", $"a{i}"]);
        }

        var oldI = Index(roots, oldChildren);
        var newI = Index(roots, newChildren);
        Assert(SceneOrderDiff.TryComputePatch(oldI, newI, Flatten(newI)) is null, "70 dirty parents → full-array fallback");
    }

    private static void NoChangeYieldsEmptyPatch()
    {
        var idx = Index(["R"], ("R", ["a", "b"]));
        var (patch, dirty) = SceneOrderDiff.BuildPatch(idx, idx);
        Assert(dirty == 0 && patch.Parents.Count == 0 && patch.Roots is null, "no structural change → empty patch");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"SceneOrderDiffTests failed: {label}.");
        }
    }
}
