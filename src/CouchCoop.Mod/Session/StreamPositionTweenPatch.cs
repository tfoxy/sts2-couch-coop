using System.Reflection;
using Godot;
using HarmonyLib;

namespace CouchCoop.Mod.Session;

/// <summary>One engine hook shared by scoped presentation writers.</summary>
internal static class StreamPositionTweenPatch
{
    internal delegate Action<PropertyTweener>? Handler(GodotObject node, NodePath property, ref Variant target);
    private static readonly List<Handler> Handlers = [];
    private static bool _applied;

    internal static MethodInfo? Resolve()
        => typeof(Tween).GetMethod(nameof(Tween.TweenProperty), BindingFlags.Public | BindingFlags.Instance,
            [typeof(GodotObject), typeof(NodePath), typeof(Variant), typeof(double)]);

    internal static void Register(Handler handler)
    {
        if (!_applied)
        {
            var target = Resolve() ?? throw new MissingMethodException(nameof(Tween.TweenProperty));
            new Harmony("com.couchcoop.stream-position-tween").Patch(target,
                prefix: new HarmonyMethod(typeof(StreamPositionTweenPatch), nameof(BeforeTween)),
                postfix: new HarmonyMethod(typeof(StreamPositionTweenPatch), nameof(AfterTween)));
            _applied = true;
        }
        Handlers.Add(handler);
    }

    private static void BeforeTween(GodotObject __0, NodePath __1, ref Variant __2,
        out Action<PropertyTweener>? __state)
        => __state = Dispatch(Handlers, __0, __1, ref __2);

    internal static Action<PropertyTweener>? Dispatch(IEnumerable<Handler> handlers,
        GodotObject node, NodePath property, ref Variant target)
    {
        Action<PropertyTweener>? result = null;
        foreach (var handler in handlers) result += handler(node, property, ref target);
        return result;
    }

    private static void AfterTween(PropertyTweener __result, Action<PropertyTweener>? __state)
        => __state?.Invoke(__result);

    internal static void OnFinished(Tweener tweener, Action retire)
        => tweener.Connect(Tweener.SignalName.Finished, Callable.From(retire),
            (uint)GodotObject.ConnectFlags.OneShot);

    internal static void Track<THolder, TTweener>(Dictionary<THolder, TTweener> tweeners,
        THolder holder, TTweener tweener, Action<Action> onFinished)
        where THolder : notnull where TTweener : class
    {
        tweeners[holder] = tweener;
        onFinished(() =>
        {
            if (tweeners.TryGetValue(holder, out var current) && ReferenceEquals(current, tweener))
                tweeners.Remove(holder);
        });
    }
}
