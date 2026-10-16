using System.Reflection;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.Screens;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.PauseMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.Settings;

namespace CouchCoop.Mod.Runtime;

/// <summary>Public lifecycle entrypoints revoke before a changed screen can receive another browser event.</summary>
internal static class HostBrowserAccessHooks
{
    private static readonly object Gate = new();
    private static readonly HashSet<MethodInfo> Installed = [];
    private static Harmony? _harmony;
    private static Action? _changed;
    private static readonly Dictionary<MethodBase, WeakReference<Task>> Transitions = [];

    internal readonly record struct Binding(Type Type, string MethodName, Type[] Parameters, bool Async);
    internal static IReadOnlyList<Binding> Bindings { get; } =
    [
        new(typeof(NSubmenuStack), nameof(NSubmenuStack.Push), [typeof(NSubmenu)], false),
        new(typeof(NSubmenuStack), nameof(NSubmenuStack.Pop), [], false),
        new(typeof(NCapstoneSubmenuStack), nameof(NCapstoneSubmenuStack.ShowScreen), [typeof(CapstoneSubmenuType)], false),
        new(typeof(NCapstoneSubmenuStack), nameof(NCapstoneSubmenuStack.AfterCapstoneClosed), [], false),
        new(typeof(NPauseMenu), nameof(NPauseMenu.OnSubmenuOpened), [], false),
        new(typeof(NPauseMenu), nameof(NPauseMenu.OnSubmenuClosed), [], false),
        new(typeof(NSettingsScreen), nameof(NSettingsScreen.OnSubmenuOpened), [], false),
        new(typeof(NSettingsScreen), nameof(NSettingsScreen.OnSubmenuClosed), [], false),
        new(typeof(NTransition), nameof(NTransition.FadeIn), [typeof(float), typeof(string), typeof(CancellationToken?)], true),
        new(typeof(NTransition), nameof(NTransition.FadeOut), [typeof(float), typeof(string), typeof(CancellationToken?)], true),
        new(typeof(NTransition), nameof(NTransition.RoomFadeIn), [typeof(bool)], true),
        new(typeof(NTransition), nameof(NTransition.RoomFadeOut), [], true),
    ];

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
                    prefix: new HarmonyMethod(typeof(HostBrowserAccessHooks), nameof(BeforeChange)),
                    postfix: binding.Async
                        ? new HarmonyMethod(typeof(HostBrowserAccessHooks), nameof(AfterAsyncChange)) : null);
                Installed.Add(target);
            }
            return true;
        }
    }

    internal static IDisposable? Listen(Action wake)
        => Prepare() ? ListenInstalled(wake) : null;

    internal static IDisposable ListenInstalled(Action wake)
    {
        Task[] pending;
        lock (Gate)
        {
            _changed += wake;
            pending = PendingTransitions();
        }
        foreach (var task in pending) OnCompletion(task, wake);
        return new Listener(wake);
    }

    internal static bool HasPendingTransition
    {
        get { lock (Gate) return Transitions.Values.Any(reference => reference.TryGetTarget(out var task) && !task.IsCompleted); }
    }

    private static Task[] PendingTransitions()
        => Transitions.Values.Select(reference => reference.TryGetTarget(out var task) ? task : null)
            .Where(task => task is not null && !task.IsCompleted).Cast<Task>().ToArray();

    private static void BeforeChange() => Volatile.Read(ref _changed)?.Invoke();

    internal static void AfterAsyncChange(MethodBase __originalMethod, Task __result)
    {
        Action? listeners;
        lock (Gate)
        {
            // Bounded by the four transition methods; no continuation is installed without browser demand.
            Transitions[__originalMethod] = new WeakReference<Task>(__result);
            listeners = _changed;
        }
        if (listeners is not null) OnCompletion(__result, listeners);
    }

    private static void OnCompletion(Task task, Action listeners)
    {
        _ = task.ContinueWith(_ => listeners(), CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    private sealed class Listener(Action wake) : IDisposable
    {
        private Action? _wake = wake;
        public void Dispose()
        {
            var wake = Interlocked.Exchange(ref _wake, null);
            if (wake is null) return;
            lock (Gate) _changed -= wake;
        }
    }
}
