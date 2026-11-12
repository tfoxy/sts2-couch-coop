using System.Diagnostics;
using CouchCoop.Mod;
using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Nodes;

internal static class HostSeatExitTests
{
    internal const string Verb = "host-seat-exit";

    internal static async Task RunAsync()
    {
        PatchTargetResolves();
        await SignalsBeforeKillsWithOneDeadline();
        await PendingJoinCannotLaunchAfterExit();
        await DeadSeatCannotRespawnAfterExit();
        await CooperativeAndEmptyHostsDoNotWaitForTheDeadline();
        await BindingCallbackCannotLaunchAfterExit();
        await QueuedReconnectExpiryCannotInterruptHostExit();
        await BrowserAndHostingTeardownCannotInterruptHostExit();
        Console.WriteLine("host seat exit: 8 passed.");
    }

    internal static void PatchTargetResolves()
    {
        var target = HostQuitPatch.ResolveTarget();
        Assert(target is not null && target.DeclaringType == typeof(NGame)
            && target.Name == nameof(NGame.Quit) && !target.IsStatic
            && target.ReturnType == typeof(void) && target.GetParameters().Length == 0,
            "the host quit prefix resolves the parameterless game quit entry point");
    }

    private static async Task SignalsBeforeKillsWithOneDeadline()
    {
        var children = new List<Child>();
        var signals = 0;
        var flaggedBeforeSignals = true;
        var allSignalledBeforeWait = true;
        var allSignalledBeforeKill = true;
        HeadlessClientManager? manager = null;
        manager = new HeadlessClientManager(slot =>
        {
            var child = new Child(slot) { ThrowOnSignal = slot == 2, IgnoreWaitCancellation = slot == 4 };
            child.OnSignal = () =>
            {
                signals++;
                flaggedBeforeSignals &= manager!.EnsureHeadlessAsync(Guid.NewGuid(), "late", default).GetAwaiter().GetResult() is null;
            };
            child.OnKill = () => allSignalledBeforeKill &= signals == 3;
            child.OnWait = () => allSignalledBeforeWait &= signals == 3;
            children.Add(child);
            return child;
        }, (_, _) => Task.FromResult(true), registerProcessExit: false);
        for (var n = 0; n < 3; n++)
            await manager.EnsureHeadlessAsync(Guid.NewGuid(), "seat" + n, default);
        var started = Stopwatch.StartNew();
        var dispose = Task.Run(manager.Dispose);
        // The ProcessExit handler calls the same Dispose entry point.
        var processExit = Task.Run(manager.Dispose);
        await Task.WhenAll(dispose, processExit).WaitAsync(TimeSpan.FromSeconds(5));
        manager.BeginHostExit();
        manager.Dispose();
        Assert(flaggedBeforeSignals && allSignalledBeforeWait && allSignalledBeforeKill,
            "flag precedes every signal; every signal precedes every wait and kill");
        Assert(started.Elapsed >= TimeSpan.FromSeconds(2.5) && started.Elapsed < TimeSpan.FromSeconds(3.5),
            "three unresponsive seats share a single three-second deadline");
        Assert(children.All(child => child.Signals == 1 && child.Kills == 1 && child.HostExitKills == 1 && child.Disposals == 1),
            "Dispose and ProcessExit signal, kill and dispose each seat exactly once");
        Assert(children.Select(child => child.WaitToken).Distinct().Count() == 1,
            "all process waits use one deadline token, even when signal delivery fails");
    }

    private static async Task PendingJoinCannotLaunchAfterExit()
    {
        var probe = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var launches = 0;
        using var manager = new HeadlessClientManager(_ => { launches++; return new Child(2); },
            (_, _) => Task.FromResult(true), seatPortProbe: (_, _) => { entered.TrySetResult(); return probe.Task; },
            registerProcessExit: false);
        var pending = manager.EnsureHeadlessAsync(Guid.NewGuid(), "pending", default);
        await entered.Task;
        manager.BeginHostExit();
        probe.SetResult(null);
        Assert(await pending is null && launches == 0, "a pending allocation rechecks exit under the lock");
    }

    private static async Task DeadSeatCannotRespawnAfterExit()
    {
        var launches = 0;
        var child = new Child(2) { ExitOnSignal = true };
        using var manager = new HeadlessClientManager(_ => { launches++; return child; },
            (_, _) => Task.FromResult(true), registerProcessExit: false);
        var session = Guid.NewGuid();
        await manager.EnsureHeadlessAsync(session, "returning", default);
        manager.BeginHostExit();
        Assert(!manager.RetainForBrowserReconnect(session, _ => throw new Exception("expired")),
            "no reconnect grace accepted during exit");
        Assert(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "returning", default) is null,
            "same-name dead-seat reconnect is refused");
        Assert(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "bound", default, targetNetId: 1002) is null,
            "netId-bound respawn is refused");
        Assert(launches == 1, "none of the reconnect routes relaunches a seat");
    }

    private static async Task CooperativeAndEmptyHostsDoNotWaitForTheDeadline()
    {
        var children = new List<Child>();
        using var manager = new HeadlessClientManager(slot =>
        {
            var child = new Child(slot) { ExitOnSignal = true };
            children.Add(child);
            return child;
        }, (_, _) => Task.FromResult(true), registerProcessExit: false);
        await manager.EnsureHeadlessAsync(Guid.NewGuid(), "cooperative", default);
        var elapsed = Stopwatch.StartNew();
        manager.Dispose();
        Assert(elapsed.Elapsed < TimeSpan.FromSeconds(1) && children.All(c => c.Kills == 0 && c.Disposals == 1),
            "cooperative seats exit without a hard kill or waiting for the deadline");
        using var empty = new HeadlessClientManager(_ => throw new Exception("unexpected spawn"),
            registerProcessExit: false);
        elapsed.Restart();
        empty.Dispose();
        Assert(elapsed.Elapsed < TimeSpan.FromSeconds(1), "empty hosts do not wait for the deadline");
    }

    private static async Task BindingCallbackCannotLaunchAfterExit()
    {
        var launches = 0;
        using var manager = new HeadlessClientManager(_ => { launches++; return new Child(2); },
            (_, _) => Task.FromResult(true), registerProcessExit: false);
        var result = await manager.EnsureHeadlessAsync(Guid.NewGuid(), "binding", default,
            onSlotBound: (_, _) => manager.BeginHostExit());
        Assert(result is null && launches == 0, "a reentrant exit before launch cannot bypass the final gate");
    }

    private static async Task QueuedReconnectExpiryCannotInterruptHostExit()
    {
        var clock = new HeadlessClientManagerTests.ReconnectClock();
        var child = new Child(2) { ExitOnSignal = true };
        var expired = 0;
        using var manager = new HeadlessClientManager(_ => child, (_, _) => Task.FromResult(true),
            browserReconnectTime: clock, registerProcessExit: false);
        var session = Guid.NewGuid();
        await manager.EnsureHeadlessAsync(session, "refreshing", default);
        Assert(manager.RetainForBrowserReconnect(session, _ => expired++), "grace is armed before exit");
        var timer = clock.Timers.Single();
        manager.BeginHostExit();
        Assert(timer.Disposed && clock.ActiveCount == 0, "exit cancels the outstanding grace timer");
        timer.FireQueuedCallback();
        Assert(expired == 0 && child.Kills == 0, "a previously queued expiry cannot interrupt graceful exit");
        manager.Dispose();
        Assert(child.Signals == 1 && child.Disposals == 1, "the retained seat belongs to host shutdown");
    }

    private static async Task BrowserAndHostingTeardownCannotInterruptHostExit()
    {
        var child = new Child(2);
        using var manager = new HeadlessClientManager(_ => child, (_, _) => Task.FromResult(true),
            registerProcessExit: false);
        var session = Guid.NewGuid();
        await manager.EnsureHeadlessAsync(session, "leaving", default);
        var elapsed = Stopwatch.StartNew();
        HostQuitPatch.Bind(manager);
        try
        {
            HostQuitPatch.BeforeQuit();
            HostQuitPatch.BeforeQuit();
        }
        finally { HostQuitPatch.Bind(null); }
        manager.EndHosting();
        Assert(child.Signals == 1 && child.Kills == 0 && child.Disposals == 0,
            "the non-blocking quit prefix signals once before hosting teardown can kill the seat");
        Assert(await manager.EnsureHeadlessAsync(Guid.NewGuid(), "late", default) is null,
            "no seat can spawn after the quit prefix");
        var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        child.OnWait = () => waiting.TrySetResult();
        var stop = Task.Run(manager.Dispose);
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Assert(manager.Release(session) is null, "browser release leaves the host-owned process alone");
        manager.EndHosting();
        Assert(child.Kills == 0 && child.Disposals == 0, "hosting teardown cannot bypass the common deadline");
        await stop.WaitAsync(TimeSpan.FromSeconds(3.5));
        Assert(elapsed.Elapsed >= TimeSpan.FromSeconds(2.5) && elapsed.Elapsed < TimeSpan.FromSeconds(3.5),
            "the survivor gets the original grace window even when hosting ends before Dispose");
        Assert(child.Signals == 1 && child.Kills == 1 && child.HostExitKills == 1 && child.Disposals == 1,
            "Dispose kills the survivor only after the shared deadline, without sending a second signal");
    }

    private sealed class Child(int slot) : IHeadlessProcess, IHeadlessProcessExitSignal
    {
        private readonly TaskCompletionSource _exit = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Action? OnSignal, OnWait, OnKill;
        public bool ExitOnSignal, ThrowOnSignal, IgnoreWaitCancellation;
        public int Signals, Kills, HostExitKills, Disposals;
        public CancellationToken WaitToken;
        public int Id => 20000 + slot;
        public int ExitCode => 0;
        public bool HasExited => _exit.Task.IsCompleted;
        public bool RequestGracefulStop()
        {
            Signals++;
            OnSignal?.Invoke();
            if (ThrowOnSignal) throw new IOException("stop signal unavailable");
            if (ExitOnSignal) _exit.TrySetResult();
            return false;
        }
        public Task WaitForExitAsync(CancellationToken cancellationToken)
        {
            OnWait?.Invoke();
            WaitToken = cancellationToken;
            return IgnoreWaitCancellation ? _exit.Task : _exit.Task.WaitAsync(cancellationToken);
        }
        public void Kill() { Kills++; OnKill?.Invoke(); _exit.TrySetResult(); }
        public void KillForHostExit() { HostExitKills++; Kill(); }
        public void Exit() => _exit.TrySetResult();
        public void Dispose() => Disposals++;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("HostSeatExitTests: " + message);
    }
}
