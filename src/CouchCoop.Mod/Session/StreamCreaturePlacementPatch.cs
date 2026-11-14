using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using CouchCoop.Mod.Patches;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Rooms;

namespace CouchCoop.Mod.Session;

/// <summary>Spread real creature origins while a wide stream owns the seat.</summary>
internal static class StreamCreaturePlacementPatch
{
    private static bool _applied;
    private static SceneTree? _tree;
    private static Action<NCombatRoom>? _adjustAspect;
    private static readonly Placement<NCreature> Creatures = new(
        Valid, node => node.Position, (node, position) => node.Position = position,
        node => node.GetParent() is CanvasItem parent ? parent.GetGlobalTransformWithCanvas() : Transform2D.Identity,
        node => node.GetParent()?.GetParent() is CanvasItem layoutParent
            ? layoutParent.GetGlobalTransformWithCanvas() : Transform2D.Identity,
        node => node.TreeExiting += () => Creatures!.Forget(node),
        node => node.Entity.PetOwner is null && node.Entity.Pets.Count == 0);
    private static readonly DeferredResize<NCombatRoom> Resize = new(
        action => _tree?.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(action),
            (uint)GodotObject.ConnectFlags.OneShot),
        room =>
        {
            if (!Creatures.Wide || !Valid(room)) return;
            var active = Creatures.BeginNative();
            try { _adjustAspect?.Invoke(room); }
            finally { if (active) Creatures.EndNative(room.CreatureNodes); }
        });

    internal readonly record struct Binding(string Method, Type[] Parameters, bool IsStatic = false);
    internal static IReadOnlyList<Binding> Bindings { get; } =
    [
        new(nameof(NCombatRoom.PositionPlayersAndPets), [typeof(List<NCreature>), typeof(float), typeof(bool)], true),
        new("PositionEnemies", [typeof(List<NCreature>), typeof(float)]),
        new("PositionCreaturesWithSlots", [typeof(List<NCreature>)]),
        new(nameof(NCombatRoom._Ready), Type.EmptyTypes),
        new(nameof(NCombatRoom.AddCreature), [typeof(Creature)]),
        new("AdjustCreatureScaleForAspectRatio", Type.EmptyTypes),
    ];

    internal static MethodInfo? Resolve(Binding binding)
        => typeof(NCombatRoom).GetMethod(binding.Method,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            | (binding.IsStatic ? BindingFlags.Static : BindingFlags.Instance), binding.Parameters);

    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        var harmony = new Harmony("com.couchcoop.stream-creature-placement");
        foreach (var binding in Bindings)
        {
            try
            {
                var target = Resolve(binding) ?? throw new MissingMethodException(typeof(NCombatRoom).FullName, binding.Method);
                if (binding.Method == "AdjustCreatureScaleForAspectRatio")
                {
                    _adjustAspect = target.CreateDelegate<Action<NCombatRoom>>();
                    harmony.Patch(target, prefix: new HarmonyMethod(typeof(StreamCreaturePlacementPatch), nameof(BeforeAspect)));
                    continue;
                }
                var postfix = binding.Method switch
                {
                    nameof(NCombatRoom._Ready) => nameof(AfterReady),
                    nameof(NCombatRoom.AddCreature) => nameof(AfterAdd),
                    _ => nameof(AfterPlacement),
                };
                harmony.Patch(target,
                    prefix: new HarmonyMethod(typeof(StreamCreaturePlacementPatch), nameof(BeforeNative)),
                    postfix: new HarmonyMethod(typeof(StreamCreaturePlacementPatch), postfix),
                    finalizer: new HarmonyMethod(typeof(StreamCreaturePlacementPatch), nameof(FinishNative)));
            }
            catch (Exception exception)
            {
                CouchCoopPatchDiagnostics.PatchFailed(nameof(StreamCreaturePlacementPatch),
                    $"{binding.Method}: {exception.GetType().Name}: {exception.Message}", costsCoop: false);
            }
        }
    }

    internal static void SetWidth(int width)
    {
        Creatures.SetWidth(width);
        if (!Creatures.Wide) { Resize.Cancel(); return; }
        var room = NCombatRoom.Instance;
        if (!Valid(room)) return;
        _tree = room.GetTree();
        Creatures.Register(room.CreatureNodes);
        Resize.Queue(room);
    }

    private static bool Valid([NotNullWhen(true)] GodotObject? node)
        => node is Node n && GodotObject.IsInstanceValid(n) && !n.IsQueuedForDeletion();

    private static void BeforeNative(out bool __state) => __state = Creatures.BeginNative();

    private static void AfterPlacement(List<NCreature> __0, bool __state)
    {
        if (__state) Creatures.EndNative(__0);
    }

    private static void AfterAdd(NCombatRoom __instance, bool __state)
    {
        if (__state) Creatures.EndNative(__instance.CreatureNodes);
    }

    private static void AfterReady(NCombatRoom __instance, bool __state)
    {
        if (__state) Creatures.EndNative(__instance.CreatureNodes);
        if (!Creatures.Wide) return;
        _tree = __instance.GetTree();
        Resize.Queue(__instance);
    }

    private static Exception? FinishNative(Exception? __exception, bool __state)
    {
        if (__exception is not null && __state) Creatures.EndNative([]);
        return __exception;
    }

    // The native SizeChanged subscription reaches this prefix. Only enqueue here; read on the next frame.
    private static bool BeforeAspect(NCombatRoom __instance)
    {
        if (!Creatures.Wide || Creatures.InNative) return true;
        Resize.Queue(__instance);
        return false;
    }

    internal static Vector2 Spread(Vector2 baseline, Transform2D parent, int width, Transform2D layoutParent)
    {
        if (width <= 1920) return baseline;
        var canvas = parent * baseline;
        // Carry the centring displacement through the layout parent, before the team's own scale.
        var displacement = layoutParent.BasisXform(new Vector2((width - 1920) / 2f, 0));
        var designX = canvas.X - displacement.X;
        canvas.X = designX + Math.Clamp(designX, 0, 1920) * (width / 1920f - 1);
        return parent.AffineInverse() * canvas;
    }

    internal sealed class Placement<T>(Func<T, bool> valid, Func<T, Vector2> read,
        Action<T, Vector2> write, Func<T, Transform2D> parent, Func<T, Transform2D> layoutParent,
        Action<T>? tracked = null, Func<T, bool>? shouldSpread = null) where T : class
    {
        private readonly Dictionary<T, Vector2> _saved = new();
        private int _width = 1920;
        private int _nativeDepth;
        internal bool Wide => _width > 1920;
        internal bool InNative => _nativeDepth > 0;

        internal void SetWidth(int width)
        {
            width = Math.Max(1920, width);
            if (_width == width) return;
            Restore();
            _width = width;
            if (Wide) Reapply();
            else _saved.Clear();
        }

        internal void Register(IEnumerable<T> nodes)
        {
            if (!Wide) return;
            foreach (var node in nodes)
                if (valid(node) && !_saved.ContainsKey(node)) Save(node);
            if (!InNative) Reapply();
        }

        internal bool BeginNative()
        {
            if (!Wide) return false;
            if (_nativeDepth++ == 0) Restore();
            return true;
        }

        internal void EndNative(IEnumerable<T> nodes)
        {
            foreach (var node in nodes)
                if (valid(node)) Save(node);
            if (--_nativeDepth == 0) Reapply();
        }

        internal void Forget(T node) => _saved.Remove(node);

        private void Save(T node)
        {
            if (shouldSpread?.Invoke(node) == false) { _saved.Remove(node); return; }
            var first = !_saved.ContainsKey(node);
            _saved[node] = read(node);
            if (first) tracked?.Invoke(node);
        }

        private void Restore()
        {
            foreach (var (node, baseline) in _saved.ToArray())
                if (valid(node))
                {
                    write(node, baseline);
                    if (shouldSpread?.Invoke(node) == false) _saved.Remove(node);
                }
                else _saved.Remove(node);
        }

        private void Reapply()
        {
            foreach (var (node, baseline) in _saved.ToArray())
                if (!valid(node)) _saved.Remove(node);
                else if (shouldSpread?.Invoke(node) == false)
                {
                    write(node, baseline);
                    _saved.Remove(node);
                }
                else write(node, Spread(baseline, parent(node), _width, layoutParent(node)));
        }
    }

    internal sealed class DeferredResize<T>(Action<Action> enqueue, Action<T> run) where T : class
    {
        private readonly HashSet<T> _pending = new();
        private int _generation;

        internal void Queue(T room)
        {
            if (!_pending.Add(room)) return;
            var generation = _generation;
            enqueue(() =>
            {
                if (generation != _generation) return;
                _pending.Remove(room);
                run(room);
            });
        }

        internal void Cancel() { _generation++; _pending.Clear(); }
    }
}
