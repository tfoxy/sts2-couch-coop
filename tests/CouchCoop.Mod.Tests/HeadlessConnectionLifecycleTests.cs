using System.Diagnostics;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

/// <summary>Serial lifecycle checks for the host-owned headless connection monitor.</summary>
internal static class HeadlessConnectionLifecycleTests
{
    public static async Task RunAsync()
    {
        await RequiresHttpMembershipAndAuthenticatedStatus();
        await FailureDuringListenerProbeRefusesRedirect();
        await MembershipChangeDuringListenerProbeKeepsWaiting();
        await HealthyChildDoesNotCompleteBeforeBrowserAcknowledgement();
        await NativeFailureRetainsItsCauseWhenChildExits();
        await EarlyProcessExitFailsTheAttempt();
        await StalledShutdownIsForcedBeforeEnsureReturns();
        await RetryFencesOldGenerationAndEvictsTheOldPeer();
        await CleanLiveReuseUsesShortPath();
        await FailedKillQuarantinesTheSeatAgainstReleaseAndRetry();
        await ConcurrentReuseKeepsPerAttemptStepTotals();
        await BrowserDropCapturesAnAlreadyExitedProcess();
        await RetiredCleanupDoesNotEvictAgain();
    }

    private static async Task RequiresHttpMembershipAndAuthenticatedStatus()
    {
        var id = BeginAttempt();
        var member = false;
        var httpReady = false;
        var process = new FakeProcess(31);
        using var manager = NewManager(_ => process, () => member, () => httpReady);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "gating", CancellationToken.None);
            var control = await WaitForControlAsync(id);
            RegisterKnown(control, id, "gating-token");

            HeadlessConnectionControl.Shared.Observe("gating-token", control.Generation,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 1));
            await Task.Delay(100);
            Assert(!pending.IsCompleted, "HTTP false or host membership false must not redirect");

            member = true;
            await Task.Delay(100);
            Assert(!pending.IsCompleted, "host membership without the HTTP listener must not redirect");

            httpReady = true;
            HeadlessConnectionControl.Shared.Observe("gating-token", control.Generation,
                new HeadlessConnectionStatus(2, "Connecting", null, null, 1));
            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(2)) == HeadlessClientManager.SlotToPort(control.Slot),
                "a fresh authenticated report, membership, and HTTP listener make the child redirectable");
        }
        finally { CleanupControl(id); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task HealthyChildDoesNotCompleteBeforeBrowserAcknowledgement()
    {
        var id = BeginAttempt();
        var process = new FakeProcess(32);
        using var manager = NewManager(_ => process, () => true, () => true);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "ack", CancellationToken.None);
            var control = await WaitForControlAsync(id);
            RegisterKnown(control, id, "ack-token");
            HeadlessConnectionControl.Shared.Observe("ack-token", control.Generation,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 1));
            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(2)) is not null, "healthy child becomes redirectable");

            var row = ConnectionRegistry.Shared.Snapshot().Rows.Single(entry => entry.Id == id);
            Assert(row.Stage != ConnectionStage.Complete,
                "host membership and child liveness never substitute for the source browser first-frame acknowledgement");
        }
        finally { CleanupControl(id); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task FailureDuringListenerProbeRefusesRedirect()
    {
        var id = BeginAttempt();
        var probeEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finishProbe = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var process = new FakeProcess(321);
        using var manager = new HeadlessClientManager(
            _ => process,
            async (_, _) => { probeEntered.TrySetResult(); await finishProbe.Task; return true; });
        manager.ConfigureConnectionMonitoring(_ => true, () => 12345);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "probe-race", CancellationToken.None);
            var control = await WaitForControlAsync(id);
            RegisterKnown(control, id, "probe-race-token");
            HeadlessConnectionControl.Shared.Observe("probe-race-token", control.Generation,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 0));
            await probeEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

            HeadlessConnectionControl.Shared.Observe("probe-race-token", control.Generation,
                new HeadlessConnectionStatus(2, "Failed", "late-native-failure", "failed while listener was probed", 0));
            process.Exit();
            finishProbe.TrySetResult();

            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(2)) is null,
                "a terminal status arriving inside the listener probe cannot redirect the browser");
        }
        finally { CleanupControl(id); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task MembershipChangeDuringListenerProbeKeepsWaiting()
    {
        var id = BeginAttempt();
        var probeEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finishProbe = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var process = new FakeProcess(322);
        var member = true;
        using var manager = new HeadlessClientManager(_ => process,
            async (_, _) => { probeEntered.TrySetResult(); await finishProbe.Task; return true; });
        manager.ConfigureConnectionMonitoring(_ => member, () => 12345);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "membership-race", CancellationToken.None);
            var control = await WaitForControlAsync(id);
            RegisterKnown(control, id, "membership-race-token");
            HeadlessConnectionControl.Shared.Observe("membership-race-token", control.Generation,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 0));
            await probeEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            member = false;
            finishProbe.TrySetResult();
            await Task.Delay(300);
            Assert(!pending.IsCompleted && !process.HasExited, "lost readiness keeps waiting without a redirect or terminal cleanup");
            Assert(ConnectionRegistry.Shared.Snapshot().Rows.Single().Issue is null, "a transient membership observation is not invented as an error");
            member = true;
            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(2)) is not null, "readiness may recover within the same attempt deadline");
        }
        finally { finishProbe.TrySetResult(); CleanupControl(id); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task NativeFailureRetainsItsCauseWhenChildExits()
    {
        var id = BeginAttempt();
        var process = new FakeProcess(33);
        using var manager = NewManager(_ => process, () => false, () => true);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "native-failure", CancellationToken.None);
            var control = await WaitForControlAsync(id);
            RegisterKnown(control, id, "native-token");
            HeadlessConnectionControl.Shared.Observe("native-token", control.Generation,
                new HeadlessConnectionStatus(1, "Failed", "native-network-error", "precise native cause", 0));
            process.Exit(); // models the child's own graceful failure backstop.

            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(2)) is null, "native failure refuses a redirect");
            Assert(!process.Killed, "an already-exited child is not force-killed during cleanup");
            var report = ConnectionRegistry.Shared.BuildReport(id) ?? "";
            Assert(report.Contains("precise native cause", StringComparison.Ordinal),
                "the native failure detail remains the primary diagnostic after cleanup");
        }
        finally { CleanupControl(id); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task EarlyProcessExitFailsTheAttempt()
    {
        var id = BeginAttempt();
        var process = new FakeProcess(34, exitCode: 41);
        using var manager = NewManager(_ => process, () => false, () => true);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "early-exit", CancellationToken.None);
            await WaitForControlAsync(id);
            process.Exit();
            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(2)) is null, "an early process exit refuses redirect");
            var report = ConnectionRegistry.Shared.BuildReport(id) ?? "";
            Assert(report.Contains("Process exit code: 41", StringComparison.Ordinal),
                "the process exit code is retained for the failed attempt");
        }
        finally { CleanupControl(id); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task StalledShutdownIsForcedBeforeEnsureReturns()
    {
        var prior = Environment.GetEnvironmentVariable(HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable);
        Environment.SetEnvironmentVariable(HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable, "1");
        var id = BeginAttempt();
        var process = new FakeProcess(35);
        using var manager = NewManager(_ => process, () => true, () => false);
        try
        {
            var started = Stopwatch.GetTimestamp();
            var result = await manager.EnsureHeadlessAsync(id, "timeout", CancellationToken.None)
                .WaitAsync(TimeSpan.FromSeconds(9));
            var elapsed = Stopwatch.GetElapsedTime(started);
            Assert(result is null, "a seat that never joins times out");
            Assert(ConnectionRegistry.Shared.Snapshot().Rows.Single(row => row.Id == id).Issue?.Code == "startup-timeout",
                "pre-existing host membership without a child heartbeat still gets the startup deadline");
            var report = ConnectionRegistry.Shared.BuildReport(id)!;
            Assert(report.Contains("Host lobby membership: True", StringComparison.Ordinal)
                   && report.Contains("child phase: not reported", StringComparison.Ordinal)
                   && report.Contains("child HTTP listener: not yet probed", StringComparison.Ordinal),
                "timeout distinguishes a missing authenticated heartbeat from the known membership and untested listener");
            Assert(process.Killed, "the parent force-kills a child that outlives its five-second shutdown grace");
            Assert(elapsed >= TimeSpan.FromSeconds(5), "Ensure waits through the five-second forced-cleanup fence");
        }
        finally
        {
            Environment.SetEnvironmentVariable(HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable, prior);
            CleanupControl(id);
            ConnectionRegistry.Shared.Clear();
        }
    }

    private static async Task RetryFencesOldGenerationAndEvictsTheOldPeer()
    {
        var oldId = BeginAttempt();
        var launched = new List<FakeProcess>();
        var evicted = new List<ulong>();
        var member = false;
        using var manager = new HeadlessClientManager(
            _ => { var process = new FakeProcess(40 + launched.Count); launched.Add(process); return process; },
            (_, _) => Task.FromResult(true),
            evicted.Add);
        manager.ConfigureConnectionMonitoring(_ => member, () => 12345);
        try
        {
            var oldEnsure = manager.EnsureHeadlessAsync(oldId, "retry", CancellationToken.None);
            var oldControl = await WaitForControlAsync(oldId);
            RegisterKnown(oldControl, oldId, "old-token");
            HeadlessConnectionControl.Shared.Observe("old-token", oldControl.Generation,
                new HeadlessConnectionStatus(1, "Failed", "old-native", "old failure", 0));
            launched.Single().Exit();
            Assert(await oldEnsure.WaitAsync(TimeSpan.FromSeconds(2)) is null, "failed generation is cleaned up before retry");
            await WaitUntilAsync(() => evicted.Count == 1, "failed generation evicts its stale host peer");
            Assert(evicted.Single() == HeadlessClientManager.SlotToNetId(oldControl.Slot), "cleanup evicts the failed slot's peer");

            var newId = BeginAttempt();
            member = true;
            var newEnsure = manager.EnsureHeadlessAsync(newId, "retry", CancellationToken.None);
            var newControl = await WaitForControlAsync(newId);
            Assert(newControl.Generation > oldControl.Generation, "retry owns a new process generation");
            Assert(!HeadlessConnectionControl.Shared.Observe("old-token", oldControl.Generation,
                    new HeadlessConnectionStatus(2, "Connecting", null, null, 1)).Accepted,
                "a late report from the failed generation cannot update its replacement");
            RegisterKnown(newControl, newId, "new-token");
            HeadlessConnectionControl.Shared.Observe("new-token", newControl.Generation,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 1));
            Assert(await newEnsure.WaitAsync(TimeSpan.FromSeconds(2)) is not null, "replacement generation becomes ready independently");
            Assert(launched.Count == 2, "retry has one new child and no ghost peer process");
            CleanupControl(newId);
        }
        finally { CleanupControl(oldId); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task CleanLiveReuseUsesShortPath()
    {
        var firstId = BeginAttempt();
        var process = new FakeProcess(50);
        using var manager = NewManager(_ => process, () => true, () => true);
        try
        {
            var first = manager.EnsureHeadlessAsync(firstId, "reused", CancellationToken.None);
            var control = await WaitForControlAsync(firstId);
            RegisterKnown(control, firstId, "reuse-token");
            HeadlessConnectionControl.Shared.Observe("reuse-token", control.Generation,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 1));
            await first.WaitAsync(TimeSpan.FromSeconds(2));

            var secondId = BeginAttempt();
            Assert(await manager.EnsureHeadlessAsync(secondId, "reused", CancellationToken.None) is not null,
                "a clean live child is reused without a fresh launch");
            var row = ConnectionRegistry.Shared.Snapshot().Rows.Single(entry => entry.Id == secondId);
            Assert(row.StepTotal == 4, "a clean reused child uses the short four-step path");
        }
        finally { CleanupControl(firstId); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task FailedKillQuarantinesTheSeatAgainstReleaseAndRetry()
    {
        var prior = Environment.GetEnvironmentVariable(HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable);
        Environment.SetEnvironmentVariable(HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable, "1");
        var id = BeginAttempt();
        var launches = 0;
        var process = new FakeProcess(61, throwOnKill: true);
        using var manager = new HeadlessClientManager(
            _ => { launches++; return process; },
            (_, _) => Task.FromResult(false));
        manager.ConfigureConnectionMonitoring(_ => false, () => 12345);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "quarantine", CancellationToken.None);
            var control = await WaitForControlAsync(id);
            RegisterKnown(control, id, "quarantine-token");
            HeadlessConnectionControl.Shared.Observe("quarantine-token", control.Generation,
                new HeadlessConnectionStatus(1, "Failed", "native-failure", "kill must not free this slot", 0));
            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(8)) is null, "failed child is not redirectable");
            Assert(process.KillAttempts > 0, "failed cleanup attempted forced termination");
            Assert(manager.Release(id) is null, "release cannot free a seat whose client still may be live");

            var retryId = BeginAdditionalAttempt();
            Assert(await manager.EnsureHeadlessAsync(retryId, "quarantine", CancellationToken.None) is null,
                "retry cannot reuse a quarantined seat");
            Assert(launches == 1, "quarantine prevents launching a second client on the same seat");
            CleanupControl(retryId);
        }
        finally
        {
            process.Exit();
            Environment.SetEnvironmentVariable(HeadlessClientManager.SeatReadyTimeoutEnvironmentVariable, prior);
            CleanupControl(id);
            ConnectionRegistry.Shared.Clear();
        }
    }

    private static async Task ConcurrentReuseKeepsPerAttemptStepTotals()
    {
        ConnectionRegistry.Shared.Clear();
        var firstId = BeginAdditionalAttempt();
        var secondId = BeginAdditionalAttempt();
        var process = new FakeProcess(62);
        using var manager = NewManager(_ => process, () => true, () => true);
        try
        {
            var first = manager.EnsureHeadlessAsync(firstId, "same-name", CancellationToken.None);
            var control = await WaitForControlAsync(firstId);
            RegisterKnown(control, firstId, "same-name-token");
            var second = manager.EnsureHeadlessAsync(secondId, "same-name", CancellationToken.None);
            HeadlessConnectionControl.Shared.Observe("same-name-token", control.Generation,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 0));
            await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(2));

            var rows = ConnectionRegistry.Shared.Snapshot().Rows;
            Assert(rows.Single(row => row.Id == firstId).StepTotal == 6, "the original launch retains six steps");
            Assert(rows.Single(row => row.Id == secondId).StepTotal == 4, "the concurrent live reuse uses four steps");
        }
        finally { CleanupControl(firstId); CleanupControl(secondId); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task BrowserDropCapturesAnAlreadyExitedProcess()
    {
        var id = BeginAttempt();
        var process = new FakeProcess(63, exitCode: 137);
        using var manager = NewManager(_ => process, () => true, () => true);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "exited-view", CancellationToken.None);
            var control = await WaitForControlAsync(id);
            RegisterKnown(control, id, "exited-view-token");
            HeadlessConnectionControl.Shared.Observe("exited-view-token", control.Generation,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 1));
            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(2)) is not null, "view was joined");
            ConnectionRegistry.Shared.Fail(id, "browser-transport-lost", "Socket closed", "Reconnect");
            process.Exit();
            await manager.FinishReportedFailureAsync(id).WaitAsync(TimeSpan.FromSeconds(2));
            var row = ConnectionRegistry.Shared.Snapshot().Rows.Single(entry => entry.Id == id);
            Assert(row.Issue?.Code == "process-exited" && row.Issue.Detail!.Contains("137"), "disconnect captures actual process exit before detaching the attempt");
        }
        finally { CleanupControl(id); ConnectionRegistry.Shared.Clear(); }
    }

    private static async Task RetiredCleanupDoesNotEvictAgain()
    {
        var id = BeginAttempt();
        var process = new FakeProcess(64);
        var evictions = new List<ulong>();
        using var manager = new HeadlessClientManager(_ => process, (_, _) => Task.FromResult(false), evictions.Add);
        manager.ConfigureConnectionMonitoring(_ => false, () => 12345);
        try
        {
            var pending = manager.EnsureHeadlessAsync(id, "released-during-cleanup", CancellationToken.None);
            var control = await WaitForControlAsync(id);
            RegisterKnown(control, id, "released-during-cleanup-token");
            HeadlessConnectionControl.Shared.Observe("released-during-cleanup-token", control.Generation,
                new HeadlessConnectionStatus(1, "Failed", "rejected", "native reason", 0));
            await WaitUntilAsync(() => HeadlessConnectionControl.Shared.Snapshot(control.Slot, control.Generation)?.ShutdownRequested == true,
                "failure cleanup starts");
            Assert(manager.Release(id) == HeadlessClientManager.SlotToNetId(control.Slot), "browser release takes ownership of peer eviction");
            Assert(await pending.WaitAsync(TimeSpan.FromSeconds(2)) is null, "the retired failed attempt finishes");
            Assert(evictions.Count == 0, "an old cleanup does not evict after the browser already retired its generation");
        }
        finally { CleanupControl(id); ConnectionRegistry.Shared.Clear(); }
    }

    private static Guid BeginAttempt()
    {
        var id = Guid.NewGuid();
        ConnectionRegistry.Shared.Clear();
        return BeginAdditionalAttempt(id);
    }

    private static Guid BeginAdditionalAttempt()
        => BeginAdditionalAttempt(Guid.NewGuid());

    private static Guid BeginAdditionalAttempt(Guid id)
    {
        ConnectionRegistry.Shared.Connected(id, null);
        ConnectionRegistry.Shared.BeginAttempt(id);
        return id;
    }

    private static HeadlessClientManager NewManager(Func<int, IHeadlessProcess?> launcher, Func<bool> member, Func<bool> httpReady)
    {
        var manager = new HeadlessClientManager(launcher, (_, _) => Task.FromResult(httpReady()));
        manager.ConfigureConnectionMonitoring(_ => member(), () => 12345);
        return manager;
    }

    private static void RegisterKnown(HeadlessConnectionControlSnapshot control, Guid id, string token)
        => HeadlessConnectionControl.Shared.Register(control.Slot, control.Generation, id, token);

    private static async Task<HeadlessConnectionControlSnapshot> WaitForControlAsync(Guid id)
    {
        HeadlessConnectionControlSnapshot? control = null;
        await WaitUntilAsync(() => (control = HeadlessConnectionControl.Shared.Snapshot()
            .LastOrDefault(snapshot => snapshot.SourceSessionId == id)) is not null, "headless control registration");
        return control!;
    }

    private static async Task WaitUntilAsync(Func<bool> condition, string description)
    {
        var deadline = Stopwatch.GetTimestamp() + (long)(Stopwatch.Frequency * 2);
        while (!condition())
        {
            if (Stopwatch.GetTimestamp() >= deadline) throw new Exception($"[HeadlessConnectionLifecycleTests] timed out waiting for {description}");
            await Task.Delay(20);
        }
    }

    private static void CleanupControl(Guid id)
    {
        foreach (var entry in HeadlessConnectionControl.Shared.Snapshot().Where(entry => entry.SourceSessionId == id))
            HeadlessConnectionControl.Shared.Unregister(entry.Slot, entry.Generation);
    }

    private sealed class FakeProcess(int id, int exitCode = 0, bool throwOnKill = false) : IHeadlessProcess
    {
        public int Id => id;
        public bool HasExited { get; private set; }
        public int ExitCode => exitCode;
        public bool GracefulStopRequested { get; private set; }
        public bool Killed { get; private set; }
        public int KillAttempts { get; private set; }
        public bool RequestGracefulStop() { GracefulStopRequested = true; return false; }
        public void Kill()
        {
            KillAttempts++;
            if (throwOnKill) throw new InvalidOperationException("kill refused");
            Killed = true;
            HasExited = true;
        }
        public void Dispose() { }
        public void Exit() => HasExited = true;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[HeadlessConnectionLifecycleTests] FAILED: {message}");
    }
}
