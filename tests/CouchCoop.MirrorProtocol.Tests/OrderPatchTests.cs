using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Port of frontend/src/mirror/__tests__/orderPatch.spec.ts: the applier reconstructs orderedIds from a compact
// Stage 4 order patch (rebuild structure from previous orderedIds + node map, apply dirty parents/roots, pre-order
// flatten). Deterministic shapes + a randomized cross-check (patch-apply == directly-built order) over random tree
// mutations, using the SAME diff the server computes.
internal static class OrderPatchTests
{
    public static void Run()
    {
        ReordersAParentsChildren();
        InsertsANewChildSubtree();
        RemovesAChild();
        ReparentsANode();
        AppliesARootsReorder();
        ProducesANewOrderedIdsReference();
        RandomizedCrossCheck();
    }

    private static Dictionary<string, object?> WireNode(string id, string? parentId) =>
        new() { ["id"] = id, ["parentId"] = parentId, ["name"] = id, ["nodeType"] = "Control" };

    private static void Full(MirrorState state, string[] order, Dictionary<string, string?> parents)
    {
        var upserts = order.Select(id => (object?)WireNode(id, parents.GetValueOrDefault(id))).ToList();
        var delta = SceneDeltaReader.Parse(TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "scene-delta",
            ["full"] = true,
            ["screenType"] = "run",
            ["upserts"] = upserts,
            ["orderedIds"] = order.Cast<object?>().ToList(),
        }))!;
        SceneTreeApplier.ApplySceneDelta(state, delta);
    }

    private static void PatchDelta(
        MirrorState state,
        List<object?>? upserts,
        List<object?>? removedIds,
        string[]? roots,
        List<object?> parents)
    {
        var orderPatch = new Dictionary<string, object?> { ["parents"] = parents };
        if (roots is not null)
        {
            orderPatch["roots"] = roots.Cast<object?>().ToList();
        }

        var delta = SceneDeltaReader.Parse(TestFixtures.J(new Dictionary<string, object?>
        {
            ["type"] = "scene-delta",
            ["full"] = false,
            ["screenType"] = "run",
            ["upserts"] = upserts ?? [],
            ["removedIds"] = removedIds ?? [],
            ["orderPatch"] = orderPatch,
        }))!;
        SceneTreeApplier.ApplySceneDelta(state, delta);
    }

    private static object? Parent(string p, params string[] c) =>
        new Dictionary<string, object?> { ["p"] = p, ["c"] = c.Cast<object?>().ToList() };

    private static void ReordersAParentsChildren()
    {
        var state = MirrorState.Create();
        Full(state, ["R", "a", "b", "c"], new() { ["R"] = null, ["a"] = "R", ["b"] = "R", ["c"] = "R" });
        PatchDelta(state, null, null, null, [Parent("R", "c", "a", "b")]);
        Check.SequenceEqual(state.OrderedIds, ["R", "c", "a", "b"], "reorder children");
    }

    private static void InsertsANewChildSubtree()
    {
        var state = MirrorState.Create();
        Full(state, ["R", "a", "b"], new() { ["R"] = null, ["a"] = "R", ["b"] = "R" });
        PatchDelta(
            state,
            [WireNode("x", "R"), WireNode("x1", "x")],
            null,
            null,
            [Parent("R", "a", "x", "b"), Parent("x", "x1")]);
        Check.SequenceEqual(state.OrderedIds, ["R", "a", "x", "x1", "b"], "insert subtree");
    }

    private static void RemovesAChild()
    {
        var state = MirrorState.Create();
        Full(state, ["R", "a", "b", "c"], new() { ["R"] = null, ["a"] = "R", ["b"] = "R", ["c"] = "R" });
        PatchDelta(state, null, ["b"], null, [Parent("R", "a", "c")]);
        Check.SequenceEqual(state.OrderedIds, ["R", "a", "c"], "remove child");
    }

    private static void ReparentsANode()
    {
        var state = MirrorState.Create();
        Full(state, ["R", "P1", "x", "P2"], new() { ["R"] = null, ["P1"] = "R", ["x"] = "P1", ["P2"] = "R" });
        PatchDelta(state, [WireNode("x", "P2")], null, null, [Parent("P1"), Parent("P2", "x")]);
        Check.SequenceEqual(state.OrderedIds, ["R", "P1", "P2", "x"], "reparent");
    }

    private static void AppliesARootsReorder()
    {
        var state = MirrorState.Create();
        Full(state, ["A", "B"], new() { ["A"] = null, ["B"] = null });
        PatchDelta(state, null, null, ["B", "A"], []);
        Check.SequenceEqual(state.OrderedIds, ["B", "A"], "roots reorder");
    }

    private static void ProducesANewOrderedIdsReference()
    {
        var state = MirrorState.Create();
        Full(state, ["R", "a", "b"], new() { ["R"] = null, ["a"] = "R", ["b"] = "R" });
        var before = state.OrderedIds;
        PatchDelta(state, null, null, null, [Parent("R", "b", "a")]);
        Check.That(!ReferenceEquals(before, state.OrderedIds), "new orderedIds reference");
    }

    // ---- randomized cross-check ---------------------------------------------------------------------------------

    private sealed class Tree
    {
        public required List<string> Keys { get; init; }
        public required Dictionary<string, string?> Parent { get; init; }
        public required List<string> Order { get; init; }
    }

    private static (List<string> RootIds, Dictionary<string, List<string>> Children) BuildStructure(
        IReadOnlyList<string> order,
        IReadOnlyCollection<string> live,
        IReadOnlyDictionary<string, string?> parent)
    {
        var children = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var roots = new List<string>();
        var liveSet = live as HashSet<string> ?? new HashSet<string>(live, StringComparer.Ordinal);
        foreach (var id in order)
        {
            if (!liveSet.Contains(id))
            {
                continue;
            }

            var p = parent.GetValueOrDefault(id);
            if (p is not null && liveSet.Contains(p))
            {
                if (!children.TryGetValue(p, out var list))
                {
                    list = [];
                    children[p] = list;
                }

                list.Add(id);
            }
            else
            {
                roots.Add(id);
            }
        }

        return (roots, children);
    }

    private static List<string> Flatten(IReadOnlyList<string> roots, IReadOnlyDictionary<string, List<string>> children)
    {
        var output = new List<string>();
        var stack = new Stack<string>();
        for (var i = roots.Count - 1; i >= 0; i--)
        {
            stack.Push(roots[i]);
        }

        while (stack.Count > 0)
        {
            var id = stack.Pop();
            output.Add(id);
            if (children.TryGetValue(id, out var kids))
            {
                for (var i = kids.Count - 1; i >= 0; i--)
                {
                    stack.Push(kids[i]);
                }
            }
        }

        return output;
    }

    private static bool SameList(IReadOnlyList<string> a, IReadOnlyList<string> b) =>
        a.Count == b.Count && a.SequenceEqual(b);

    // The server's diff (BuildPatch): dirty parents + roots, using BOTH orders indexed against the CURRENT nodes.
    private static (List<string>? Roots, List<(string P, List<string> C)> Parents) ServerDiff(
        IReadOnlyList<string> oldOrder,
        IReadOnlyList<string> newOrder,
        HashSet<string> live,
        Dictionary<string, string?> parent)
    {
        var (oldRoots, oldChildren) = BuildStructure(oldOrder, live, parent);
        var (newRoots, newChildren) = BuildStructure(newOrder, live, parent);
        var dirty = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (p, list) in newChildren)
        {
            if (!oldChildren.TryGetValue(p, out var old) || !SameList(old, list))
            {
                dirty.Add(p);
            }
        }

        foreach (var p in oldChildren.Keys)
        {
            if (!newChildren.ContainsKey(p))
            {
                dirty.Add(p);
            }
        }

        var rootsDirty = !SameList(oldRoots, newRoots);
        var parents = dirty.Select(p => (p, newChildren.GetValueOrDefault(p) ?? [])).ToList();
        return (rootsDirty ? newRoots : null, parents);
    }

    // Deterministic PRNG (mulberry32) so a failure reproduces.
    private static Func<double> Rng(uint seed)
    {
        var a = seed;
        return () =>
        {
            a += 0x6d2b79f5u;
            var t = a;
            t = (t ^ (t >> 15)) * (t | 1u);
            t ^= t + (t ^ (t >> 7)) * (t | 61u);
            return ((t ^ (t >> 14)) & 0xffffffffu) / 4294967296.0;
        };
    }

    private static Tree RandomTree(Func<double> rand, int size)
    {
        var parent = new Dictionary<string, string?>(StringComparer.Ordinal);
        var keys = new List<string> { "n0" };
        parent["n0"] = null;
        for (var i = 1; i < size; i++)
        {
            var id = $"n{i}";
            var p = keys[(int)(rand() * keys.Count)];
            parent[id] = p;
            keys.Add(id);
        }

        var live = new HashSet<string>(keys, StringComparer.Ordinal);
        var (roots, children) = BuildStructure(keys, live, parent);
        return new Tree { Keys = keys, Parent = parent, Order = Flatten(roots, children) };
    }

    private static Tree Mutate(Func<double> rand, Tree tree, ref int nextId)
    {
        var parent = new Dictionary<string, string?>(tree.Parent, StringComparer.Ordinal);
        var keys = new List<string>(tree.Keys);
        var ids = new List<string>(keys); // snapshot for random selection (matches TS `[...nodes.keys()]`)
        var op = (int)(rand() * 4);
        if (op == 0)
        {
            var id = $"m{nextId++}";
            parent[id] = ids[(int)(rand() * ids.Count)];
            keys.Add(id);
        }
        else if (op == 1 && ids.Count > 1)
        {
            var parentsSet = new HashSet<string>(parent.Values.Where(v => v is not null)!, StringComparer.Ordinal);
            var leaves = ids.Where(id => parent.GetValueOrDefault(id) is not null && !parentsSet.Contains(id)).ToList();
            if (leaves.Count > 0)
            {
                var victim = leaves[(int)(rand() * leaves.Count)];
                parent.Remove(victim);
                keys.Remove(victim);
            }
        }
        else if (op == 2 && ids.Count > 2)
        {
            var movable = ids.Where(id => parent.GetValueOrDefault(id) is not null).ToList();
            if (movable.Count > 0)
            {
                var node = movable[(int)(rand() * movable.Count)];
                var descendants = new HashSet<string>(StringComparer.Ordinal) { node };
                var grew = true;
                while (grew)
                {
                    grew = false;
                    foreach (var (c, p) in parent)
                    {
                        if (p is not null && descendants.Contains(p) && !descendants.Contains(c))
                        {
                            descendants.Add(c);
                            grew = true;
                        }
                    }
                }

                var candidates = ids.Where(id => !descendants.Contains(id)).ToList();
                if (candidates.Count > 0)
                {
                    parent[node] = candidates[(int)(rand() * candidates.Count)];
                }
            }
        }

        var live = new HashSet<string>(keys, StringComparer.Ordinal);
        var (roots, children) = BuildStructure(keys, live, parent);
        return new Tree { Keys = keys, Parent = parent, Order = Flatten(roots, children) };
    }

    private static void RandomizedCrossCheck()
    {
        for (uint seed = 1; seed <= 40; seed++)
        {
            var rand = Rng(seed);
            var tree = RandomTree(rand, 10 + (int)(rand() * 20));
            var nextId = 0;

            var state = MirrorState.Create();
            var parents = tree.Keys.ToDictionary(id => id, id => tree.Parent.GetValueOrDefault(id), StringComparer.Ordinal);
            Full(state, tree.Order.ToArray(), parents);

            for (var step = 0; step < 12; step++)
            {
                var prevOrder = tree.Order;
                var next = Mutate(rand, tree, ref nextId);
                var nextLive = new HashSet<string>(next.Keys, StringComparer.Ordinal);
                var removedIds = tree.Keys.Where(id => !nextLive.Contains(id)).Cast<object?>().ToList();
                var upserts = next.Keys.Select(id => (object?)WireNode(id, next.Parent.GetValueOrDefault(id))).ToList();
                var (diffRoots, diffParents) = ServerDiff(prevOrder, next.Order, nextLive, next.Parent);

                var parentDicts = diffParents.Select(pp => (object?)new Dictionary<string, object?>
                {
                    ["p"] = pp.P,
                    ["c"] = pp.C.Cast<object?>().ToList(),
                }).ToList();

                PatchDelta(state, upserts, removedIds, diffRoots?.ToArray(), parentDicts);
                Check.SequenceEqual(state.OrderedIds, next.Order, $"seed {seed} step {step}");
                tree = next;
            }
        }
    }
}
