using System.Diagnostics;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Godot;

namespace CouchCoop.Mod.Protocol;

/// <summary>
/// <see cref="IPointerTargetFinder"/> over the live scene tree (game thread only). A target identity is the render
/// stream's <c>item_meta</c> pair: <c>scene</c> is the <c>scene_file_path</c> of the node's instance root and
/// <c>path</c> the node's path under that root (<c>.</c> is the root itself). So every node whose
/// <c>SceneFilePath</c> is <c>scene</c> is an instance root, and <c>GetNodeOrNull(path)</c> under each is a
/// candidate.
///
/// <para><b>Cost.</b> On the streaming seat (where viewers' targets come from) the instance roots are indexed as
/// nodes enter the tree (<see cref="PointerTargetInstanceIndex"/>), so nothing walks. Elsewhere finding instance roots
/// is one walk of the tree (3449 nodes took 4.3 ms in a combat), so the roots of a scene are cached by instance
/// id. A cached answer is used while all of it is still alive; a <c>fresh</c> request (the placement asks for one
/// before it would MOVE an event or call a target missing or ambiguous, never for an event that simply lands) walks
/// again unless this frame already did, so a newly created instance is never missed on the decisions that matter.
/// Nothing runs unless a viewer's message names a target.</para>
/// </summary>
internal sealed class GodotPointerTargetFinder : IPointerTargetFinder
{
    private static readonly RateLimitedDiagnosticLog WalkLog = new(CouchCoopLog.Stderr, TimeSpan.FromSeconds(5));

    private readonly Dictionary<string, Roots> _roots = new(StringComparer.Ordinal);

    private sealed record Roots(ulong[] Ids, ulong Frame);

    public IReadOnlyList<IPointerTargetNode> Find(string scene, string path, bool fresh)
    {
        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
        {
            return [];
        }

        IReadOnlyList<ulong> ids;
        if (PointerTargetInstanceIndex.IsTracking)
        {
            // The streaming seat indexes instance roots as they enter the tree: always complete, never a walk.
            ids = PointerTargetInstanceIndex.Instances(scene);
        }
        else
        {
            var frame = Engine.GetProcessFrames();
            if (!_roots.TryGetValue(scene, out var roots) || (fresh && roots.Frame != frame) || !AllAlive(roots.Ids))
            {
                roots = new Roots(Walk(root, scene), frame);
                _roots[scene] = roots;
            }

            ids = roots.Ids;
        }

        var nodePath = new NodePath(path);
        var found = new List<IPointerTargetNode>(ids.Count);
        foreach (var id in ids)
        {
            if (GodotObject.InstanceFromId(id) is Node instance && instance.GetNodeOrNull(nodePath) is { } node)
            {
                found.Add(new LiveNode(node.GetInstanceId()));
            }
        }

        return found;
    }

    private static bool AllAlive(ulong[] ids)
    {
        foreach (var id in ids)
        {
            if (!GodotObject.IsInstanceIdValid(id) || GodotObject.InstanceFromId(id) is not Node { } node || !node.IsInsideTree())
            {
                return false;
            }
        }

        return true;
    }

    // Every node under the root whose SceneFilePath is `scene`, in tree order.
    private static ulong[] Walk(Node root, string scene)
    {
        var watch = Stopwatch.StartNew();
        var found = new List<ulong>();
        var stack = new Stack<Node>();
        stack.Push(root);
        var visited = 0;
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            visited++;
            if (node.SceneFilePath == scene)
            {
                found.Add(node.GetInstanceId());
            }

            var children = node.GetChildren();
            for (var i = children.Count - 1; i >= 0; i--)
            {
                stack.Push(children[i]);
            }
        }

        WalkLog.Write("pointer-target-walk",
            $"[pointer-target] walked {visited} nodes for {scene} in {watch.Elapsed.TotalMilliseconds:0.0} ms ({found.Count} instances)");
        return [.. found];
    }

    private sealed class LiveNode(ulong id) : IPointerTargetNode
    {
        private Node? Node => GodotObject.IsInstanceIdValid(id) ? GodotObject.InstanceFromId(id) as Node : null;

        public bool IsAlive => Node is { } node && node.IsInsideTree();

        public bool IsVisibleCanvasItem => Node is CanvasItem item && item.IsVisibleInTree();

        public Transform2D CanvasTransform => Node is CanvasItem item ? item.GetGlobalTransformWithCanvas() : Transform2D.Identity;

        public Vector2? ControlSize => Node is Control control ? control.Size : null;
    }
}
