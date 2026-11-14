using System.Reflection;
using CouchCoop.Mod.Patches;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Screens.Map;

namespace CouchCoop.Mod.Session;

/// <summary>Carry the map toolbar by half the extra width only while a wide stream owns the seat.</summary>
internal static class StreamMapDrawingToolsPatch
{
    private static bool _applied;
    private static readonly Placement<Control> Toolbar = new(
        node => GodotObject.IsInstanceValid(node) && !node.IsQueuedForDeletion(),
        node => new Layout(node.AnchorLeft, node.AnchorRight, node.OffsetLeft, node.OffsetRight),
        (node, layout) =>
        {
            node.OffsetLeft = layout.OffsetLeft;
            node.OffsetRight = layout.OffsetRight;
        });

    internal static MethodInfo? Resolve()
        => typeof(NMapScreen).GetMethod(nameof(NMapScreen._Ready),
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly, Type.EmptyTypes);

    // Installed before any map is ready, only on headless capture seats.
    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        try
        {
            var target = Resolve() ?? throw new MissingMethodException(typeof(NMapScreen).FullName, nameof(NMapScreen._Ready));
            new Harmony("com.couchcoop.stream-map-drawing-tools").Patch(target,
                postfix: new HarmonyMethod(typeof(StreamMapDrawingToolsPatch), nameof(AfterReady)));
        }
        catch (Exception exception)
        {
            CouchCoopPatchDiagnostics.PatchFailed(nameof(StreamMapDrawingToolsPatch),
                $"{exception.GetType().Name}: {exception.Message}", costsCoop: false);
        }
    }

    // Ownership transitions already run on the main thread, before capture or mirror work resumes.
    internal static void SetWidth(int width)
    {
        Toolbar.SetWidth(width);
        if (Toolbar.Wide) Register(NMapScreen.Instance);
    }

    private static void AfterReady(NMapScreen __instance)
    {
        if (Engine.GetMainLoop() is SceneTree tree)
            tree.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(() => Register(__instance)),
                (uint)GodotObject.ConnectFlags.OneShot);
    }

    private static void Register(NMapScreen? map)
    {
        if (!Toolbar.Wide || map is null || !GodotObject.IsInstanceValid(map) || map.IsQueuedForDeletion()) return;
        if (map.GetNodeOrNull<Control>("%DrawingTools") is { } tools) Toolbar.Register(tools);
    }

    internal readonly record struct Layout(float AnchorLeft, float AnchorRight, float OffsetLeft, float OffsetRight)
    {
        // Both edges keep their 1920 positions and move by (W - 1920) / 2, without stretching the panel.
        internal Layout Centered(int width) => this with
        {
            OffsetLeft = OffsetLeft + (width - 1920) / 2f,
            OffsetRight = OffsetRight + (width - 1920) / 2f,
        };
    }

    internal sealed class Placement<T>(Func<T, bool> valid, Func<T, Layout> read, Action<T, Layout> write)
        where T : class
    {
        private readonly Dictionary<T, Layout> _saved = new();
        private int _width = 1920;
        internal bool Wide => _width > 1920;

        internal void SetWidth(int width)
        {
            width = Math.Max(1920, width);
            if (_width == width) return;
            _width = width;
            foreach (var (node, layout) in _saved.ToArray())
                if (valid(node)) write(node, Wide ? layout.Centered(_width) : layout);
                else _saved.Remove(node);
            if (!Wide) _saved.Clear();
        }

        internal void Register(T node)
        {
            if (!Wide || !valid(node)) return;
            foreach (var stale in _saved.Keys.Where(node => !valid(node)).ToArray()) _saved.Remove(stale);
            if (_saved.ContainsKey(node)) return;
            var layout = read(node);
            _saved.Add(node, layout);
            write(node, layout.Centered(_width));
        }
    }
}
