using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using MegaCrit.Sts2.Core.Nodes.Screens;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.PauseMenu;
using MegaCrit.Sts2.Core.Nodes.Screens.Settings;

internal static class HostBrowserAccessPolicyTests
{
    internal static void Run()
    {
        PermissionMatrix();
        OrdinaryRefreshPreservesPermission();
        LoadingPreservesSceneUntilHardRevocation();
        TypedHookClassification();
        SignalsRevokeBeforeReading();
        MissingSignalsFailClosed();
        LifecycleInvalidatesQueuedWork();
        ConcurrentReadCannotGrant();
        FailedCancellationDeniesUntilRecovered();
        ConnectingDuringTransitionObservesCompletion();
        DormantTransitionBookkeepingDoesNotAllocate();
        Console.WriteLine("HostBrowserAccessPolicyTests: ok");
    }

    internal static void AssertHookTargets()
    {
        var bindings = HostBrowserAccessHooks.Bindings;
        Expect(bindings.Count == HostBrowserAccessTargets.Targets.Count, "metadata and typed targets agree");
        for (var i = 0; i < bindings.Count; ++i)
        {
            var binding = bindings[i];
            var metadata = HostBrowserAccessTargets.Targets[i];
            Expect(binding.Type.FullName == metadata.TypeName && binding.MethodName == metadata.MethodName
                && binding.Parameters.Length == metadata.ParameterCount, "metadata target matches typed hook");
            var method = HostBrowserAccessHooks.Resolve(binding);
            Expect(method is not null, $"required public lifecycle hook resolves: {metadata}");
            Expect(!binding.Async || method!.ReturnType == typeof(Task), "async lifecycle exposes a Task completion");
        }
    }

    private static void PermissionMatrix()
    {
        foreach (var netType in new[] { NetTypeNames.Host, NetTypeNames.Client })
        {
            foreach (var inRun in new[] { false, true })
            {
                var facts = new GateFacts(inRun, inRun ? null : netType, inRun ? netType : null);
                Expect(Decide(facts) == HostBrowserAccessReasons.Allowed, "multiplayer lobby/run and run summary allowed");
                Expect(Decide(facts, menu: true) == HostBrowserAccessReasons.MenuOpen, "pause/settings/descendants denied");
                Expect(Decide(facts, transition: true) == HostBrowserAccessReasons.Transition, "loading denied");
                Expect(Decide(facts, screen: false) == HostBrowserAccessReasons.Unavailable, "unknown screen denied");
            }
        }
        foreach (var netType in new[] { NetTypeNames.Singleplayer, NetTypeNames.Replay, NetTypeNames.None, NetTypeNames.Unknown, null })
        {
            Expect(Decide(new GateFacts(false, netType, null)) == HostBrowserAccessReasons.MultiplayerRequired, "non-multiplayer lobby denied");
            Expect(Decide(new GateFacts(true, null, netType)) == HostBrowserAccessReasons.MultiplayerRequired, "non-multiplayer run denied");
        }
        Expect(Decide(null) == HostBrowserAccessReasons.Unavailable, "unreadable facts denied");
    }

    private static string Decide(GateFacts? facts, bool screen = true, bool transition = false, bool menu = false)
        => HostBrowserAccessMonitor.Decide(facts, screen, transition, menu);

    private static void OrdinaryRefreshPreservesPermission()
    {
        using var fixture = new Fixture();
        fixture.Monitor.Start();
        fixture.Flush();
        var baseline = fixture.Monitor.State;
        var notifications = 0;
        fixture.Monitor.Changed += _ => ++notifications;
        for (var i = 0; i < 8; ++i) fixture.Wake!(HostBrowserAccessSignal.Refresh);
        Expect(fixture.Queue.Count == 1 && fixture.Monitor.State == baseline && fixture.Cancelled == 0,
            "map, deck, ordinary dialog and roster notifications preserve permission and holds immediately");
        fixture.Flush();
        Expect(fixture.Monitor.State == baseline && notifications == 0 && fixture.Cancelled == 0 && fixture.Reads == 2,
            "unchanged deferred facts publish nothing and preserve both epochs");
        fixture.OnRead = () => { fixture.OnRead = null; fixture.Wake!(HostBrowserAccessSignal.Refresh); };
        fixture.Wake!(HostBrowserAccessSignal.Refresh);
        fixture.Queue.Dequeue()();
        Expect(fixture.Queue.Count == 1 && fixture.Monitor.State == baseline, "refresh during read owns another deferred read");
        fixture.Flush();
    }

    private static void LoadingPreservesSceneUntilHardRevocation()
    {
        using var fixture = new Fixture();
        fixture.Monitor.Start();
        fixture.Flush();
        var baseline = fixture.Monitor.State;
        fixture.Reason = HostBrowserAccessReasons.Transition;
        fixture.Wake!(HostBrowserAccessSignal.Transition);
        Expect(!fixture.Monitor.State.Allowed && fixture.Monitor.State.SceneResetGeneration == baseline.SceneResetGeneration
            && fixture.Cancelled == 1, "loading revokes input while retaining the authorized display");
        fixture.Flush();
        fixture.Reason = HostBrowserAccessReasons.Allowed;
        fixture.Wake!(HostBrowserAccessSignal.Refresh);
        fixture.Flush();
        Expect(fixture.Monitor.State.Allowed && fixture.Monitor.State.SceneResetGeneration == baseline.SceneResetGeneration
            && fixture.Monitor.State.Generation > baseline.Generation, "resume uses fresh work epoch without resetting display");
        fixture.Wake!(HostBrowserAccessSignal.ProtectedMenu);
        var reset = fixture.Monitor.State.SceneResetGeneration;
        Expect(reset > baseline.SceneResetGeneration, "protected menu immediately requires a scene clear");
        fixture.Wake!(HostBrowserAccessSignal.Transition);
        fixture.Flush();
        Expect(fixture.Monitor.State.Allowed && fixture.Monitor.State.SceneResetGeneration == reset,
            "hard clear survives coalesced protected/loading/allowed updates");
        fixture.Reason = HostBrowserAccessReasons.Unavailable;
        fixture.Wake!(HostBrowserAccessSignal.Refresh);
        fixture.Flush();
        Expect(!fixture.Monitor.State.Allowed && fixture.Monitor.State.SceneResetGeneration > reset,
            "unreadable facts on an ordinary refresh still clear the scene");
        Expect(Decide(null, screen: false, transition: true) == HostBrowserAccessReasons.Transition,
            "known loading remains a suspension while temporary screen facts are unavailable");
        Expect(Decide(null, screen: false, transition: true, menu: true) == HostBrowserAccessReasons.MenuOpen,
            "protected menu facts win over loading");
    }

    private static void TypedHookClassification()
    {
        var signals = new List<HostBrowserAccessSignal>();
        using var listener = HostBrowserAccessHooks.ListenInstalled(signals.Add);
        HostBrowserAccessHooks.BeforeCapstone(CapstoneSubmenuType.Compendium);
        HostBrowserAccessHooks.BeforeCapstone(CapstoneSubmenuType.Feedback);
        HostBrowserAccessHooks.BeforeCapstone(CapstoneSubmenuType.PauseMenu);
        HostBrowserAccessHooks.BeforeCapstone(CapstoneSubmenuType.Settings);
        HostBrowserAccessHooks.BeforeCapstone((CapstoneSubmenuType)int.MaxValue);
        HostBrowserAccessHooks.Protect();
        HostBrowserAccessHooks.Refresh();
        HostBrowserAccessHooks.Transition();
        HostBrowserAccessHooks.Unsafe();
        Expect(signals.SequenceEqual(new[] { HostBrowserAccessSignal.Refresh, HostBrowserAccessSignal.Refresh,
            HostBrowserAccessSignal.ProtectedMenu, HostBrowserAccessSignal.ProtectedMenu, HostBrowserAccessSignal.Unsafe,
            HostBrowserAccessSignal.ProtectedMenu, HostBrowserAccessSignal.Refresh, HostBrowserAccessSignal.Transition,
            HostBrowserAccessSignal.Unsafe }), "installed typed prefix entrypoints distinguish ordinary, menu, transition and unsafe signals");
        Expect(HostBrowserAccessHooks.ClassifyPush(typeof(NRunSubmenuStack), typeof(NSubmenu)) == HostBrowserAccessSignal.Refresh,
            "run dialogs refresh without revocation");
        Expect(HostBrowserAccessHooks.ClassifyPush(typeof(NRunSubmenuStack), typeof(NSettingsScreen)) == HostBrowserAccessSignal.ProtectedMenu
            && HostBrowserAccessHooks.ClassifyPush(typeof(NRunSubmenuStack), typeof(NPauseMenu)) == HostBrowserAccessSignal.ProtectedMenu,
            "protected run dialogs revoke synchronously");
        Expect(HostBrowserAccessHooks.ClassifyPush(typeof(NSubmenuStack), typeof(NSubmenu)) == HostBrowserAccessSignal.Unsafe
            && HostBrowserAccessHooks.ClassifyPush(typeof(NRunSubmenuStack), null) == HostBrowserAccessSignal.Unsafe,
            "main-menu and unknown dialog changes fail closed");
        Expect(HostBrowserAccessHooks.ClassifyScene(true, true, true, true) == HostBrowserAccessSignal.Transition
            && HostBrowserAccessHooks.ClassifyScene(true, false, false, false) == HostBrowserAccessSignal.Refresh,
            "known run loading suspends and non-root room changes refresh");
        Expect(HostBrowserAccessHooks.ClassifyScene(true, true, false, true) == HostBrowserAccessSignal.Unsafe
            && HostBrowserAccessHooks.ClassifyScene(false, false, true, true) == HostBrowserAccessSignal.Unsafe
            && HostBrowserAccessHooks.ClassifyScene(true, true, true, false) == HostBrowserAccessSignal.Unsafe,
            "main-menu, unknown root and unexplained root changes clear immediately");
        HostBrowserAccessHooks.CacheTransition(false);
    }

    private static void SignalsRevokeBeforeReading()
    {
        using var fixture = new Fixture();
        Expect(!fixture.Monitor.State.Allowed && fixture.Reads == 0, "construction is dormant and denied");
        fixture.Monitor.Start();
        fixture.Monitor.Start();
        Expect(fixture.Subscriptions == 1 && fixture.Reads == 0, "start only subscribes and defers one baseline read");
        fixture.Flush();
        var oldGeneration = fixture.Monitor.State.Generation;
        Expect(fixture.Monitor.IsAllowed(oldGeneration), "baseline allows a multiplayer run");
        fixture.Reason = HostBrowserAccessReasons.MenuOpen;
        fixture.Wake!(HostBrowserAccessSignal.ProtectedMenu);
        Expect(!fixture.Monitor.IsAllowed(oldGeneration) && fixture.Reads == 1 && fixture.Cancelled == 1,
            "signal synchronously denies and cancels held input without reading game facts");
        fixture.Wake!(HostBrowserAccessSignal.ProtectedMenu);
        fixture.Wake!(HostBrowserAccessSignal.ProtectedMenu);
        Expect(fixture.Queue.Count == 1, "a burst coalesces into one next-frame read");
        fixture.Flush();
        Expect(fixture.Monitor.State.Reason == HostBrowserAccessReasons.MenuOpen, "nested protected menu stays blocked");
        fixture.Reason = HostBrowserAccessReasons.Allowed;
        fixture.Wake!(HostBrowserAccessSignal.Refresh);
        fixture.Flush();
        Expect(fixture.Monitor.State.Allowed && !fixture.Monitor.IsAllowed(oldGeneration), "resume cannot resurrect queued input");
    }

    private static void MissingSignalsFailClosed()
    {
        var reads = 0;
        using var monitor = new HostBrowserAccessMonitor(_ => null, () => { ++reads; return HostBrowserAccessReasons.Allowed; },
            work => work(), () => { });
        monitor.Start();
        Expect(!monitor.State.Allowed && monitor.State.Reason == HostBrowserAccessReasons.Unavailable && reads == 0,
            "required missing hooks fail closed without reading");
        using var fixture = new Fixture();
        fixture.ThrowOnRead = true;
        fixture.Monitor.Start();
        fixture.Flush();
        Expect(!fixture.Monitor.State.Allowed && fixture.Queue.Count == 0, "failed read denies without backstop retry");
    }

    private static void LifecycleInvalidatesQueuedWork()
    {
        using var fixture = new Fixture();
        fixture.Monitor.Start();
        var oldWake = fixture.Wake!;
        fixture.Monitor.Stop();
        fixture.Flush();
        Expect(fixture.Reads == 0 && fixture.Subscriptions == 0, "stop detaches and drops pending baseline reads");
        fixture.Monitor.Start();
        oldWake(HostBrowserAccessSignal.Unsafe);
        fixture.Flush();
        Expect(fixture.Reads == 1 && fixture.Monitor.State.Allowed, "old subscription callbacks cannot affect a new lifetime");
        fixture.Monitor.Stop();
        Expect(fixture.Cancelled == 1 && fixture.Subscriptions == 0, "stop cancels held input and leaves no subscriptions");
        fixture.Monitor.Dispose();
        fixture.Monitor.Start();
        Expect(fixture.Subscriptions == 0 && fixture.Queue.Count == 0, "disposed observer remains dormant");
    }

    private static void ConcurrentReadCannotGrant()
    {
        using var fixture = new Fixture();
        fixture.Monitor.Start();
        fixture.OnRead = () => { fixture.OnRead = null; fixture.Wake!(HostBrowserAccessSignal.ProtectedMenu); };
        fixture.Queue.Dequeue()();
        Expect(!fixture.Monitor.State.Allowed && fixture.Queue.Count == 1, "signal during read prevents stale permission grant");
        fixture.Reason = HostBrowserAccessReasons.MenuOpen;
        fixture.Flush();
        Expect(!fixture.Monitor.State.Allowed, "follow-up read remains authoritative");
    }

    private static void FailedCancellationDeniesUntilRecovered()
    {
        using var fixture = new Fixture();
        fixture.Monitor.Start();
        fixture.Flush();
        fixture.ThrowOnCancel = true;
        fixture.Wake!(HostBrowserAccessSignal.ProtectedMenu);
        fixture.Flush();
        Expect(!fixture.Monitor.State.Allowed && fixture.Reads == 1,
            "failed cancellation stays denied even while the game is otherwise allowed");
        fixture.ThrowOnCancel = false;
        fixture.Wake!(HostBrowserAccessSignal.ProtectedMenu);
        fixture.Flush();
        Expect(fixture.Monitor.State.Allowed && fixture.Cancelled == 2,
            "next real signal retries cancellation before allowing again");
    }

    private static void ConnectingDuringTransitionObservesCompletion()
    {
        var task = new TaskCompletionSource();
        var key = HostBrowserAccessHooks.Resolve(HostBrowserAccessHooks.Bindings.First(binding => binding.Async))!;
        HostBrowserAccessHooks.AfterAsyncChange(key, task.Task);
        Expect(HostBrowserAccessHooks.HasPendingTransition, "transition begun without viewers remains identifiable");
        var notifications = 0;
        using (HostBrowserAccessHooks.ListenInstalled(_ => ++notifications))
        {
            Expect(notifications == 0, "joining mid-transition does not poll or manufacture a completion");
            task.SetResult();
            Expect(notifications == 1 && !HostBrowserAccessHooks.HasPendingTransition,
                "existing transition completion wakes the newly connected viewer exactly once");
        }
        var second = new TaskCompletionSource();
        HostBrowserAccessHooks.AfterAsyncChange(key, second.Task);
        second.SetResult();
        Expect(notifications == 1, "completed transition at zero demand notifies nobody");
    }

    private static void DormantTransitionBookkeepingDoesNotAllocate()
    {
        var targets = HostBrowserAccessHooks.Bindings.Where(binding => binding.Async)
            .Select(binding => HostBrowserAccessHooks.Resolve(binding)!).ToArray();
        Expect(targets.Length == 4, "transition bookkeeping has exactly four reusable slots");
        foreach (var target in targets) HostBrowserAccessHooks.AfterAsyncChange(target, Task.CompletedTask);
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 100; ++i)
            foreach (var target in targets) HostBrowserAccessHooks.AfterAsyncChange(target, Task.CompletedTask);
        Expect(GC.GetAllocatedBytesForCurrentThread() == before,
            "zero-demand transition hooks retain no per-event allocation or completion tasks");
        Expect(!HostBrowserAccessHooks.HasPendingTransition, "completed dormant slots are not pending");
    }

    private sealed class Fixture : IDisposable
    {
        internal readonly Queue<Action> Queue = [];
        internal Action<HostBrowserAccessSignal>? Wake;
        internal Action? OnRead;
        internal int Reads, Subscriptions, Cancelled;
        internal bool ThrowOnRead, ThrowOnCancel;
        internal string Reason = HostBrowserAccessReasons.Allowed;
        internal HostBrowserAccessMonitor Monitor;
        internal Fixture()
        {
            Monitor = new HostBrowserAccessMonitor(wake =>
            {
                Wake = wake;
                ++Subscriptions;
                return new Subscription(() => --Subscriptions);
            }, () =>
            {
                ++Reads;
                OnRead?.Invoke();
                if (ThrowOnRead) throw new InvalidOperationException("fixture unreadable");
                return Reason;
            }, Queue.Enqueue, () =>
            {
                ++Cancelled;
                if (ThrowOnCancel) throw new InvalidOperationException("fixture cancellation failed");
            });
        }
        internal void Flush() { while (Queue.TryDequeue(out var work)) work(); }
        public void Dispose() => Monitor.Dispose();
    }

    private sealed class Subscription(Action unsubscribe) : IDisposable
    {
        public void Dispose() => unsubscribe();
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("HostBrowserAccessPolicyTests: " + message);
    }
}
