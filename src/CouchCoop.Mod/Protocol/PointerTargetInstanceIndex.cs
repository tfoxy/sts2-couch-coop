using Godot;

namespace CouchCoop.Mod.Protocol;

/// <summary>
/// The streaming seat's instance roots by scene file (C3), kept as nodes enter the tree so a pointer target's
/// <c>scene</c> resolves with no tree walk. <see cref="Session.RenderStreamItemTagger"/> feeds it from its
/// <c>SceneTree.NodeAdded</c> handler (and its first full walk), so it exists exactly where viewers' targets come from;
/// elsewhere <see cref="IsTracking"/> is false and <see cref="GodotPointerTargetFinder"/> walks the tree instead.
/// Game thread only. Dead entries are dropped when a scene is read, and compacted when a scene's list doubles.
/// </summary>
internal static class PointerTargetInstanceIndex
{
    private static readonly Dictionary<string, Roots> ByScene = new(StringComparer.Ordinal);

    private sealed class Roots
    {
        public readonly List<ulong> Ids = [];
        public int CompactAt = 16;
    }

    /// <summary>The tagger feeds the index (the streaming seat).</summary>
    public static bool IsTracking { get; private set; }

    public static void StartTracking() => IsTracking = true;

    /// <summary>A node entered the tree: remember it when it is an instance root.</summary>
    public static void Track(Node node)
    {
        var scene = node.SceneFilePath;
        if (string.IsNullOrEmpty(scene))
        {
            return;
        }

        if (!ByScene.TryGetValue(scene, out var roots))
        {
            ByScene[scene] = roots = new Roots();
        }

        roots.Ids.Add(node.GetInstanceId());
        if (roots.Ids.Count >= roots.CompactAt)
        {
            Prune(roots);
            roots.CompactAt = Math.Max(16, roots.Ids.Count * 2);
        }
    }

    /// <summary>The live, in-tree instance roots of <paramref name="scene"/>, in the order they entered.</summary>
    public static IReadOnlyList<ulong> Instances(string scene)
    {
        if (!ByScene.TryGetValue(scene, out var roots))
        {
            return [];
        }

        Prune(roots);
        return roots.Ids;
    }

    private static void Prune(Roots roots)
    {
        roots.Ids.RemoveAll(id => !GodotObject.IsInstanceIdValid(id)
            || GodotObject.InstanceFromId(id) is not Node { } node || !node.IsInsideTree());
        // A node that left the tree and came back is tracked again by its NodeAdded: keep one entry per id.
        if (roots.Ids.Count > 1)
        {
            var seen = new HashSet<ulong>();
            roots.Ids.RemoveAll(id => !seen.Add(id));
        }
    }
}
