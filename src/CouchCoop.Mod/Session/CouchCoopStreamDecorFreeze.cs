using CouchCoop.Mod.Runtime;
using Godot;
using DecorFreeze = CouchCoop.Mod.Session.CouchCoopHeadlessVisualSuspender.DecorFreeze;

namespace CouchCoop.Mod.Session;

/// <summary>Event-driven decorative suspension for a unanimously opted-in render capture.</summary>
public static class CouchCoopStreamDecorFreeze
{
    // EngineAvailable guards method bodies; engine-typed statics must initialize only behind that guard.
    private static class EngineState
    {
        internal static readonly FrozenNodeStates<Node.ProcessModeEnum> Modes = new();
        internal static readonly FrozenNodeStates<bool> Processes = new();
        internal static readonly Dictionary<ulong, (Node Node, Action Exit)> Tracked = [];
        internal static readonly HashSet<Callable> DeferredFrames = [];
        internal static SceneTree? Tree;
    }

    private static volatile bool _armed;
    private static volatile bool _desired;
    private static volatile bool _tweensDesired;
    private static volatile bool _active;
    private static volatile bool _tweensActive;
    private static int _generation;

    public static bool Active => _active;
    // Any interested stream page enables schedule capture; playback is negotiated per client.
    public static bool ClientTweensActive => _tweensActive;
    public static event Action? Changed;

    public static void SetDesired(bool decor, bool tweens)
    {
        if (_desired == decor && _tweensDesired == tweens) return;
        _desired = decor;
        _tweensDesired = tweens;
        Reconcile();
    }

    internal static void SetArmed(bool armed)
    {
        _armed = armed;
        Reconcile();
    }

    internal static bool ShouldFreeze(bool armed, bool desired) => armed && desired;

    internal static DecorFreeze? PolicyFor(string type) => type switch
    {
        "NEnergyCounter" => DecorFreeze.ProcessOnly,
        "NRestSiteFireVfx" => DecorFreeze.WholeNode,
        _ => null
    };

    private static void Reconcile()
    {
        if (CouchCoopMod.EngineAvailable) ReconcileWithEngine();
    }

    private static void ReconcileWithEngine()
    {
        GameDeferred.Post(() =>
        {
            if (!ShouldFreeze(_armed, _desired)) Deactivate();
            if (Engine.GetMainLoop() is not SceneTree tree) return;
            EngineState.Tree = tree;
            // All reads and the initial walk wait one frame, including calls from capture signals.
            NextFrame(() =>
            {
                var before = (_active, _tweensActive);
                if (ShouldFreeze(_armed, _desired) && !_active)
                {
                    tree.NodeAdded += OnNodeAdded;
                    Walk(tree.Root);
                    _active = true;
                }
                _tweensActive = ShouldFreeze(_armed, _tweensDesired);
                if (before != (_active, _tweensActive)) Changed?.Invoke();
            });
        });
    }

    private static void NextFrame(Action action)
    {
        if (EngineState.Tree is null) return;
        var generation = _generation;
        Callable callback = default;
        callback = Callable.From(() =>
        {
            EngineState.DeferredFrames.Remove(callback);
            if (generation == _generation) action();
        });
        EngineState.DeferredFrames.Add(callback);
        GameDeferred.Register(() => EngineState.Tree.Connect(SceneTree.SignalName.ProcessFrame, callback, (uint)GodotObject.ConnectFlags.OneShot));
    }

    private static void OnNodeAdded(Node node) => NextFrame(() =>
    {
        if (!_active || !ShouldFreeze(_armed, _desired) || !GodotObject.IsInstanceValid(node) || !node.IsInsideTree()) return;
        for (Node? ancestor = node; ancestor is not null; ancestor = ancestor.GetParent())
            if (CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(ancestor.Name.ToString())) return;
        Walk(node);
    });

    private static void Walk(Node node)
    {
        if (CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(node.Name.ToString())) return;
        var policy = PolicyFor(node.GetType().Name);
        if (policy is not null)
        {
            var id = node.GetInstanceId();
            if (!EngineState.Tracked.ContainsKey(id))
            {
                Action exit = () => NextFrame(() => Restore(id));
                EngineState.Tracked.Add(id, (node, exit));
                node.TreeExiting += exit;
                if (policy == DecorFreeze.ProcessOnly)
                {
                    EngineState.Processes.Remember(id, node.IsProcessing());
                    node.SetProcess(false);
                }
                else
                {
                    EngineState.Modes.Remember(id, node.ProcessMode);
                    node.ProcessMode = Node.ProcessModeEnum.Disabled;
                }
            }
        }
        foreach (var child in node.GetChildren()) Walk(child);
    }

    private static void Restore(ulong id)
    {
        if (!EngineState.Tracked.Remove(id, out var tracked)) return;
        var valid = GodotObject.IsInstanceValid(tracked.Node);
        if (EngineState.Processes.TryRemove(id, out var process) && valid) tracked.Node.SetProcess(process);
        if (EngineState.Modes.TryRemove(id, out var mode) && valid) tracked.Node.ProcessMode = mode;
        if (valid) tracked.Node.TreeExiting -= tracked.Exit;
    }

    private static void Deactivate()
    {
        var changed = _active || _tweensActive;
        if (EngineState.Tree is { } tree && GodotObject.IsInstanceValid(tree))
        {
            tree.NodeAdded -= OnNodeAdded;
            foreach (var callback in EngineState.DeferredFrames) tree.Disconnect(SceneTree.SignalName.ProcessFrame, callback);
        }
        EngineState.DeferredFrames.Clear();
        _generation++;
        foreach (var id in EngineState.Tracked.Keys.ToArray()) Restore(id);
        _active = false;
        _tweensActive = false;
        EngineState.Tree = null;
        if (changed) Changed?.Invoke();
    }
}
