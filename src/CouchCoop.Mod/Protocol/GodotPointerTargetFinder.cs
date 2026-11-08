using System.Diagnostics;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Godot;

namespace CouchCoop.Mod.Protocol;

/// <summary>
/// Resolves instance ids directly. Legacy scene/path targets use an on-demand tree walk, with scene roots cached
/// until freed or a fresh answer is requested. No tree work runs for an instance target.
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

        var frame = Engine.GetProcessFrames();
        if (!_roots.TryGetValue(scene, out var roots) || (fresh && roots.Frame != frame) || !AllAlive(roots.Ids))
        {
            roots = new Roots(Walk(root, scene), frame);
            _roots[scene] = roots;
        }

        var ids = roots.Ids;
        var nodePath = new NodePath(path);
        var found = new List<IPointerTargetNode>(ids.Length);
        foreach (var id in ids)
        {
            if (GodotObject.InstanceFromId(id) is Node instance && instance.GetNodeOrNull(nodePath) is { } node)
            {
                found.Add(new LiveNode(node.GetInstanceId()));
            }
        }

        return found;
    }

    public IPointerTargetNode? FindInstance(ulong instanceId)
        => GodotObject.InstanceFromId(instanceId) is CanvasItem item && item.IsInsideTree()
            ? new LiveNode(instanceId) : null;

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

        public bool MatchesIdentity(string scene, string path)
            => Node is { } node && IdentityMatches(node.SceneFilePath, node.Owner?.SceneFilePath,
                node.Owner?.GetPathTo(node).ToString(), scene, path);
    }

    /// <summary>
    /// Whether scene/path is the capture's item_meta identity of a node: its instance root is the node itself when it
    /// has a scene file, else its owner. The owner, not the nearest scene-file ancestor: an editable child added under
    /// a nested instance is owned by the outer scene and named by it.
    /// </summary>
    internal static bool IdentityMatches(string? selfScene, string? ownerScene, string? pathFromOwner, string scene, string path)
        => !string.IsNullOrEmpty(selfScene)
            ? selfScene == scene && path == "."
            : !string.IsNullOrEmpty(ownerScene) && ownerScene == scene && pathFromOwner == path;
}
