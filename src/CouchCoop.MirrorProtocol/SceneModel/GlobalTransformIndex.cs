namespace CouchCoop.MirrorProtocol.SceneModel;

// Maintains a game-space GLOBAL Transform2D (CSS `matrix()` 6-tuple [a,b,c,d,tx,ty]) per node id over a
// MirrorState, mirroring the `gNode` computation in frontend/src/mirror/mirrorRenderer.ts's `visit`:
//
//   gNode =
//     node.transform == null ? parentGlobal                     // pass-through group (NOT identity/origin)
//     : affineMul(parentGlobal, node.transform)
//
// with the root walk starting from `parentGlobal = IDENTITY_AFFINE`. This is the base global the reconciler bakes
// per node and that input hit-testing inverts (after composing the node-local box with `Affine.NodeMatrix`); this
// index owns only the pure math, no Godot references.
//
// Incremental: `Update` recomputes only the nodes whose global actually moved — the changed set (state.ChangedIds)
// PLUS every descendant of a changed node (a parent's transform change moves the whole subtree). Order changes
// (sibling reorders) never move a global and are ignored; reparents/removals ride ChangedIds. A full recompute
// runs on the first update, a Revision reset (new/replaced state), or a full keyframe
// (detected as "changed count covers the whole tree").
public sealed class GlobalTransformIndex
{
    private static readonly double[] Identity = [1, 0, 0, 1, 0, 0];

    private readonly Dictionary<string, double[]> _globals = new(StringComparer.Ordinal);
    // Rebuilt per incremental update from state.Nodes' ParentId, used to close the dirty set over descendants. A
    // removed parent still keys any surviving children here (they keep pointing at its id), so their globals get
    // recomputed (and fall back to identity for the now-missing parent).
    private readonly Dictionary<string, List<string>> _childrenByParent = new(StringComparer.Ordinal);

    private int _lastRevision = -1;

    // Bumps on every update that recomputes at least one global (a change-detection handle for consumers).
    public int Version { get; private set; }

    // ---- CULL: recomputed-set exposure (reuse this dirty machinery instead of a parallel one) -------------------
    // The exact set of node ids whose global was (re)computed by the LAST Update — i.e. the changed seeds PLUS every
    // descendant that rode a moved ancestor (CloseOverDescendants), or ALL live nodes on a full recompute. The cull
    // pass keys its per-node self-bounds recompute off THIS set: a node's own paint AABB can only change when its
    // global changed, which is precisely membership here. Includes ids that were removed this update (their global was
    // purged) — a consumer filters against state.Nodes. Rebuilt in place each Update (never handed out to escape).
    private readonly HashSet<string> _lastRecomputed = new(StringComparer.Ordinal);

    public IReadOnlyCollection<string> LastRecomputed => _lastRecomputed;

    // True when the last Update took the FULL-recompute branch (first run, revision reset, or a keyframe
    // whose changed set covered the whole tree). The cull index promotes itself to a full recompute in lockstep so it
    // never trusts stale retained bounds after the transform index dropped them.
    public bool LastWasFull { get; private set; }

    // The current global for a node, or false (with identity) when the id is unknown.
    public bool TryGetGlobal(string id, out IReadOnlyList<double> matrix)
    {
        if (_globals.TryGetValue(id, out var g))
        {
            matrix = g;
            return true;
        }

        matrix = Identity;
        return false;
    }

    public void Update(MirrorState state)
    {
        // A full recompute is required when we can't trust the retained globals: first run, the state's revision
        // went backwards (a fresh/replaced MirrorState), or
        // a keyframe re-upserted every node (changed count ≥ node count, matching mirrorRenderer's scene-wide bail).
        var full =
            _lastRevision < 0
            || state.Revision < _lastRevision
            || (state.Nodes.Count > 0 && state.ChangedIds.Count >= state.Nodes.Count);
        _lastRevision = state.Revision;
        LastWasFull = full;

        if (!full && state.ChangedIds.Count == 0)
        {
            // Nothing moved this update → the cull index has no self-bounds to refresh. Publish an empty set (a stale
            // one from a prior drain must not be re-consumed as "these moved this frame").
            _lastRecomputed.Clear();
            return;
        }

        HashSet<string> dirty;
        if (full)
        {
            // Drop stale (removed) entries wholesale, then recompute every live node.
            _globals.Clear();
            dirty = [.. state.Nodes.Keys];
        }
        else
        {
            RebuildChildren(state);
            dirty = CloseOverDescendants(state.ChangedIds);
            // Removed / no-longer-present ids: purge their globals (their surviving descendants stay in `dirty` and
            // get recomputed against an identity parent).
            foreach (var id in dirty)
            {
                if (!state.Nodes.ContainsKey(id))
                {
                    _globals.Remove(id);
                }
            }
        }

        // Recompute each live dirty node, parent-before-child (the memoized recursion pulls a dirty parent's fresh
        // global first, and reads a clean parent's already-correct retained global).
        var computed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in dirty)
        {
            if (state.Nodes.ContainsKey(id))
            {
                Resolve(id, state, dirty, computed);
            }
        }

        // Publish the recomputed set for the cull index (the SAME `dirty` closure just walked — changed seeds plus
        // moved descendants, or every node on a full recompute). Copied out so a later mutation of `dirty` (there is
        // none today) could never leak into a retained consumer view.
        _lastRecomputed.Clear();
        foreach (var id in dirty)
        {
            _lastRecomputed.Add(id);
        }

        Version++;
    }

    private double[] Resolve(string id, MirrorState state, HashSet<string> dirty, HashSet<string> computed)
    {
        if (!computed.Add(id))
        {
            // Already computed this pass (or re-entered via a cycle — Godot trees have none, but tolerate).
            return _globals.TryGetValue(id, out var done) ? done : Identity;
        }

        var node = state.Nodes[id];
        var parentGlobal = Identity;
        if (node.ParentId is { } pid && state.Nodes.ContainsKey(pid))
        {
            // A dirty parent must be resolved first; a clean parent already holds its correct retained global.
            parentGlobal = dirty.Contains(pid)
                ? Resolve(pid, state, dirty, computed)
                : _globals.TryGetValue(pid, out var pg) ? pg : Identity;
        }

        var global = ComputeGlobal(node, parentGlobal);
        _globals[id] = global;
        return global;
    }

    private double[] ComputeGlobal(MirrorNode node, double[] parentGlobal)
    {
        // Transform-less node: its global is the parent's (pass-through group).
        if (node.Transform is not { } transform)
        {
            return parentGlobal;
        }

        return Affine.Multiply(parentGlobal, transform);
    }

    private void RebuildChildren(MirrorState state)
    {
        _childrenByParent.Clear();
        foreach (var (id, node) in state.Nodes)
        {
            if (node.ParentId is { } pid)
            {
                if (!_childrenByParent.TryGetValue(pid, out var list))
                {
                    list = [];
                    _childrenByParent[pid] = list;
                }

                list.Add(id);
            }
        }
    }

    private HashSet<string> CloseOverDescendants(IEnumerable<string> seeds)
    {
        var dirty = new HashSet<string>(StringComparer.Ordinal);
        var queue = new Queue<string>();
        foreach (var seed in seeds)
        {
            if (dirty.Add(seed))
            {
                queue.Enqueue(seed);
            }
        }

        while (queue.Count > 0)
        {
            var cur = queue.Dequeue();
            if (_childrenByParent.TryGetValue(cur, out var kids))
            {
                foreach (var kid in kids)
                {
                    if (dirty.Add(kid))
                    {
                        queue.Enqueue(kid);
                    }
                }
            }
        }

        return dirty;
    }
}
