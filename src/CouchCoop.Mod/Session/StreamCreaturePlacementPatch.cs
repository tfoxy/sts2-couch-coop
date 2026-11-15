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
    [ThreadStatic] private static NCreature? _companion;
    private static readonly Placement<NCreature> Creatures = new(
        Valid, node => node.Position, (node, position) => node.Position = position,
        node => node.GetParent() is CanvasItem parent ? parent.GetGlobalTransformWithCanvas() : Transform2D.Identity,
        node => node.GetParent()?.GetParent() is CanvasItem layoutParent
            ? layoutParent.GetGlobalTransformWithCanvas() : Transform2D.Identity,
        node => node.TreeExiting += () => Creatures!.Forget(node));
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

    // The companion placement entry points exist from the v113 lane on; earlier lanes carry none.
    internal static IReadOnlyList<Binding> CompanionBindings { get; } =
    [
#if STS2_API_V113
        new(nameof(NCreature.ScaleAndPositionOsty), [typeof(float), typeof(double)]),
        new(nameof(NCreature.PositionWuppy), [typeof(bool)]),
#endif
    ];

    internal static MethodInfo? ResolveCompanion(Binding binding)
        => typeof(NCreature).GetMethod(binding.Method,
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly, binding.Parameters);

    internal static MethodInfo? ResolveMethodTween()
        => typeof(Tween).GetMethod(nameof(Tween.TweenMethod), BindingFlags.Public | BindingFlags.Instance,
            [typeof(Callable), typeof(Variant), typeof(Variant), typeof(double)]);

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
        // The tween hooks only act inside a companion scope, so a lane without companion targets needs neither.
        if (CompanionBindings.Count == 0) return;
        try
        {
            StreamPositionTweenPatch.Register(HandleTween);
            foreach (var binding in CompanionBindings)
                harmony.Patch(ResolveCompanion(binding)
                    ?? throw new MissingMethodException(typeof(NCreature).FullName, binding.Method),
                    prefix: new HarmonyMethod(typeof(StreamCreaturePlacementPatch), nameof(BeforeCompanion)),
                    finalizer: new HarmonyMethod(typeof(StreamCreaturePlacementPatch), nameof(FinishCompanion)));
            harmony.Patch(ResolveMethodTween() ?? throw new MissingMethodException(nameof(Tween.TweenMethod)),
                prefix: new HarmonyMethod(typeof(StreamCreaturePlacementPatch), nameof(BeforeMethodTween)));
        }
        catch (Exception exception)
        {
            CouchCoopPatchDiagnostics.PatchFailed(nameof(StreamCreaturePlacementPatch),
                $"companions: {exception.GetType().Name}: {exception.Message}", costsCoop: false);
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

    private sealed record CompanionScope(NCreature? Previous, bool Native);

    private static void BeforeCompanion(NCreature __instance, out CompanionScope __state)
    {
        __state = new(_companion, Creatures.BeginNative());
        _companion = __instance;
    }

    private static Exception? FinishCompanion(NCreature __instance, CompanionScope __state, Exception? __exception)
    {
        _companion = __state.Previous;
        if (__state.Native) Creatures.EndNative([__instance]);
        return __exception;
    }

    private static Action<PropertyTweener>? HandleTween(GodotObject node, NodePath property, ref Variant target)
    {
        // No native objects or variants are read outside the typed placement scope.
        if (_companion is not { } companion || !ReferenceEquals(node, companion)
            || property.ToString() != "position" || target.VariantType != Variant.Type.Vector2) return null;
        var baseline = target.AsVector2();
        target = Creatures.Endpoint(companion, baseline);
        return tweener => Creatures.TrackEndpoint(companion, baseline, position =>
        {
            if (!GodotObject.IsInstanceValid(tweener)) return false;
            var held = tweener.From(position);
            if (held is null) return false;
            held.SetCustomInterpolator(Callable.From<double, double>(HoldInitial));
            return true;
        }, retire => StreamPositionTweenPatch.OnFinished(tweener, retire));
    }

    private static double HoldInitial(double _) => 0;

    private static void BeforeMethodTween(ref Callable __0, Variant __1, Variant __2)
    {
        if (_companion is not { } companion || __1.VariantType != Variant.Type.Vector2
            || __2.VariantType != Variant.Type.Vector2) return;
        var native = __0;
        __0 = Callable.From<Vector2>(offset => Creatures.RunNative(companion, () => native.Call(offset)));
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
        Action<T>? tracked = null) where T : class
    {
        private readonly Dictionary<T, Vector2> _saved = new();
        private readonly Dictionary<T, List<Func<Vector2, bool>>> _tweens = new();
        private readonly HashSet<T> _pendingEndpoints = [];
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
                if (valid(node) && !_pendingEndpoints.Contains(node)) Save(node);
            if (--_nativeDepth == 0)
            {
                Reapply();
                _pendingEndpoints.Clear();
            }
        }

        internal Vector2 Endpoint(T node, Vector2 baseline)
            => Spread(baseline, parent(node), _width, layoutParent(node));

        internal void TrackEndpoint(T node, Vector2 baseline, Func<Vector2, bool> hold,
            Action<Action>? onFinished = null)
        {
            if (!_saved.ContainsKey(node)) tracked?.Invoke(node);
            _saved[node] = baseline;
            if (!_tweens.TryGetValue(node, out var tweens)) _tweens.Add(node, tweens = []);
            tweens.Add(hold);
            onFinished?.Invoke(() =>
            {
                if (!_tweens.TryGetValue(node, out var active)) return;
                active.Remove(hold);
                if (active.Count == 0) _tweens.Remove(node);
            });
            if (InNative) _pendingEndpoints.Add(node);
        }

        internal void RunNative(T node, Action native)
        {
            var active = BeginNative();
            try { native(); }
            finally { if (active) EndNative([node]); }
        }

        internal void Forget(T node)
        {
            _saved.Remove(node);
            _tweens.Remove(node);
            _pendingEndpoints.Remove(node);
        }

        private void Save(T node)
        {
            var first = !_saved.ContainsKey(node);
            _saved[node] = read(node);
            if (first) tracked?.Invoke(node);
        }

        private void Restore()
        {
            foreach (var (node, baseline) in _saved.ToArray())
                if (valid(node))
                {
                    Hold(node, baseline);
                    write(node, baseline);
                }
                else Forget(node);
        }

        private void Reapply()
        {
            foreach (var (node, baseline) in _saved.ToArray())
                if (!valid(node)) Forget(node);
                else
                {
                    // A just-registered tween keeps its opening pose and owns later animation steps.
                    var pending = _pendingEndpoints.Contains(node);
                    var position = Endpoint(node, pending ? read(node) : baseline);
                    Hold(node, pending ? Endpoint(node, baseline) : position, keepLatest: pending);
                    write(node, position);
                }
        }

        private void Hold(T node, Vector2 position, bool keepLatest = false)
        {
            if (!_tweens.TryGetValue(node, out var tweens)) return;
            for (var i = tweens.Count - (keepLatest ? 2 : 1); i >= 0; i--)
                if (!tweens[i](position)) tweens.RemoveAt(i);
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
