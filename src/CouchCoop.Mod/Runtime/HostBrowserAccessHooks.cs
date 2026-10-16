using System.Reflection;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.Screens;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.PauseMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.Settings;
using MegaCrit.Sts2.Core.Runs;

namespace CouchCoop.Mod.Runtime;

/// <summary>Typed lifecycle boundaries distinguish ordinary UI changes from authorization revocations.</summary>
internal static class HostBrowserAccessHooks
{
    private static readonly object Gate = new();
    private static readonly HashSet<MethodInfo> Installed = [];
    private static Harmony? _harmony;
    private static Action<HostBrowserAccessSignal>? _changed;
    private static readonly WeakReference<NSceneContainer> Root = new(null!);
    private static bool _knownTransition;

    internal readonly record struct Binding(Type Type, string MethodName, Type[] Parameters, bool Async, string Prefix);
    internal static IReadOnlyList<Binding> Bindings { get; } =
    [
        new(typeof(NSubmenuStack), nameof(NSubmenuStack.Push), [typeof(NSubmenu)], false, nameof(BeforePush)),
        new(typeof(NSubmenuStack), nameof(NSubmenuStack.Pop), [], false, nameof(BeforePop)),
        new(typeof(NCapstoneSubmenuStack), nameof(NCapstoneSubmenuStack.ShowScreen), [typeof(CapstoneSubmenuType)], false, nameof(BeforeCapstone)),
        new(typeof(NCapstoneSubmenuStack), nameof(NCapstoneSubmenuStack.AfterCapstoneClosed), [], false, nameof(Refresh)),
        new(typeof(NPauseMenu), nameof(NPauseMenu.OnSubmenuOpened), [], false, nameof(Protect)),
        new(typeof(NPauseMenu), nameof(NPauseMenu.OnSubmenuClosed), [], false, nameof(Refresh)),
        new(typeof(NSettingsScreen), nameof(NSettingsScreen.OnSubmenuOpened), [], false, nameof(Protect)),
        new(typeof(NSettingsScreen), nameof(NSettingsScreen.OnSubmenuClosed), [], false, nameof(Refresh)),
        new(typeof(NTransition), nameof(NTransition.FadeIn), [typeof(float), typeof(string), typeof(CancellationToken?)], true, nameof(Transition)),
        new(typeof(NTransition), nameof(NTransition.FadeOut), [typeof(float), typeof(string), typeof(CancellationToken?)], true, nameof(Transition)),
        new(typeof(NTransition), nameof(NTransition.RoomFadeIn), [typeof(bool)], true, nameof(Transition)),
        new(typeof(NTransition), nameof(NTransition.RoomFadeOut), [], true, nameof(Transition)),
        new(typeof(NSceneContainer), nameof(NSceneContainer.SetCurrentScene), [typeof(Control)], false, nameof(BeforeScene)),
        new(typeof(RunManager), nameof(RunManager.CleanUp), [typeof(bool)], false, nameof(Unsafe)),
    ];

    // Each public transition entrypoint owns one reusable weak slot, including at zero demand.
    private sealed class TransitionSlot(MethodInfo? method)
    {
        internal readonly MethodInfo? Method = method;
        internal readonly WeakReference<Task> Task = new(null!);
    }
    private static readonly TransitionSlot[] Transitions = Bindings.Where(binding => binding.Async)
        .Select(binding => new TransitionSlot(Resolve(binding))).ToArray();

    internal static MethodInfo? Resolve(Binding binding)
        => binding.Type.GetMethod(binding.MethodName,
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly, null, binding.Parameters, null);

    internal static bool Prepare()
    {
        lock (Gate)
        {
            _harmony ??= new Harmony("com.couchcoop.host-browser-access");
            foreach (var binding in Bindings)
            {
                var target = Resolve(binding);
                if (target is null) return false;
                if (Installed.Contains(target)) continue;
                _harmony.Patch(target,
                    prefix: new HarmonyMethod(typeof(HostBrowserAccessHooks), binding.Prefix),
                    postfix: binding.Async
                        ? new HarmonyMethod(typeof(HostBrowserAccessHooks), nameof(AfterAsyncChange)) : null);
                Installed.Add(target);
            }
            return true;
        }
    }

    internal static IDisposable? Listen(Action<HostBrowserAccessSignal> wake)
        => Prepare() ? ListenInstalled(wake) : null;

    internal static IDisposable ListenInstalled(Action<HostBrowserAccessSignal> wake)
    {
        Task[] pending;
        lock (Gate)
        {
            _changed += wake;
            pending = Transitions.Select(slot => slot.Task.TryGetTarget(out var task) ? task : null)
                .Where(task => task is not null && !task.IsCompleted).Cast<Task>().ToArray();
        }
        foreach (var task in pending) OnCompletion(task, wake);
        return new Listener(wake);
    }

    internal static bool HasPendingTransition
    {
        get
        {
            lock (Gate)
            {
                foreach (var slot in Transitions)
                    if (slot.Task.TryGetTarget(out var task) && !task.IsCompleted) return true;
                return false;
            }
        }
    }

    // Only the deferred fact reader updates this identity; hook callbacks never traverse game nodes.
    internal static void CacheRoot(NSceneContainer root) => Root.SetTarget(root);
    internal static void CacheTransition(bool active) => Volatile.Write(ref _knownTransition, active);

    internal static HostBrowserAccessSignal ClassifyPush(Type? stack, Type? screen)
        => screen is not null && (typeof(NPauseMenu).IsAssignableFrom(screen) || typeof(NSettingsScreen).IsAssignableFrom(screen))
            ? HostBrowserAccessSignal.ProtectedMenu
            : stack is not null && typeof(NRunSubmenuStack).IsAssignableFrom(stack) && screen is not null
                ? HostBrowserAccessSignal.Refresh : HostBrowserAccessSignal.Unsafe;

    internal static HostBrowserAccessSignal ClassifyCapstone(CapstoneSubmenuType type)
        => type switch
        {
            CapstoneSubmenuType.PauseMenu or CapstoneSubmenuType.Settings => HostBrowserAccessSignal.ProtectedMenu,
            CapstoneSubmenuType.Compendium or CapstoneSubmenuType.Feedback => HostBrowserAccessSignal.Refresh,
            _ => HostBrowserAccessSignal.Unsafe,
        };

    internal static HostBrowserAccessSignal ClassifyScene(bool rootKnown, bool isRoot, bool isRun, bool inTransition)
        => !rootKnown ? HostBrowserAccessSignal.Unsafe
            : !isRoot ? HostBrowserAccessSignal.Refresh
            : isRun && inTransition ? HostBrowserAccessSignal.Transition : HostBrowserAccessSignal.Unsafe;

    internal static void BeforePush(NSubmenuStack __instance, NSubmenu __0)
    {
        var listeners = Volatile.Read(ref _changed);
        if (listeners is not null) listeners(ClassifyPush(__instance?.GetType(), __0?.GetType()));
    }
    internal static void BeforePop(NSubmenuStack __instance)
        => Volatile.Read(ref _changed)?.Invoke(__instance is NRunSubmenuStack
            ? HostBrowserAccessSignal.Refresh : HostBrowserAccessSignal.Unsafe);
    internal static void BeforeCapstone(CapstoneSubmenuType __0)
        => Volatile.Read(ref _changed)?.Invoke(ClassifyCapstone(__0));
    internal static void BeforeScene(NSceneContainer __instance, Control __0)
    {
        var listeners = Volatile.Read(ref _changed);
        if (listeners is null) return;
        var known = Root.TryGetTarget(out var root);
        listeners(ClassifyScene(known, ReferenceEquals(root, __instance), __0 is NRun, Volatile.Read(ref _knownTransition) || HasPendingTransition));
    }
    internal static void Refresh() => Volatile.Read(ref _changed)?.Invoke(HostBrowserAccessSignal.Refresh);
    internal static void Protect() => Volatile.Read(ref _changed)?.Invoke(HostBrowserAccessSignal.ProtectedMenu);
    internal static void Transition()
    {
        var listeners = Volatile.Read(ref _changed);
        if (listeners is null) return;
        CacheTransition(true);
        listeners(HostBrowserAccessSignal.Transition);
    }
    internal static void Unsafe() => Volatile.Read(ref _changed)?.Invoke(HostBrowserAccessSignal.Unsafe);

    internal static void AfterAsyncChange(MethodBase __originalMethod, Task __result)
    {
        Action<HostBrowserAccessSignal>? listeners;
        lock (Gate)
        {
            foreach (var slot in Transitions)
                if (slot.Method == __originalMethod) { slot.Task.SetTarget(__result); break; }
            listeners = _changed;
        }
        if (listeners is not null) OnCompletion(__result, listeners);
    }

    private static void OnCompletion(Task task, Action<HostBrowserAccessSignal> listeners)
    {
        _ = task.ContinueWith(_ => listeners(HostBrowserAccessSignal.Refresh), CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    private sealed class Listener(Action<HostBrowserAccessSignal> wake) : IDisposable
    {
        private Action<HostBrowserAccessSignal>? _wake = wake;
        public void Dispose()
        {
            var wake = Interlocked.Exchange(ref _wake, null);
            if (wake is null) return;
            lock (Gate) _changed -= wake;
        }
    }
}
