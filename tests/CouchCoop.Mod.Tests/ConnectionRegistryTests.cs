using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionRegistryTests
{
    public static void Run()
    {
        AnonymousRowsAndMonotonicStages();
        IdenticalDeviceLabelsRemainDistinct();
        ConfirmedCauseReplacesOnlyTransportSymptom();
        RetryFencesOldAttemptAndPreservesIssue();
        FrameNeedsMembershipAndChildReadiness();
        CleanSocketCloseDoesNotRetainChildCountInference();
        DirectViewAndSlowWarning();
        SlowWarningWaitRechecksEarlyWakeAndAttempt();
        SavedIssueTimingAndOutcomes();
        CloseDismissOverflowAndDedupe();
    }

    private static void ConfirmedCauseReplacesOnlyTransportSymptom()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var id = Guid.NewGuid(); registry.Connected(id, "phone"); registry.BeginAttempt(id);
        registry.Fail(id, "browser-transport-lost", "Socket closed", "Reconnect", "No close detail");
        var reportId = registry.Snapshot().Rows.Single().Attempt!.IssueId;
        registry.Fail(id, "native-join-rejected", "Native rejection", "Retry", "native reason");
        registry.Fail(id, "process-exited", "Later exit", "Retry", "exit 0");
        var row = registry.Snapshot().Rows.Single();
        Assert(row.Issue!.Code == "native-join-rejected", "confirmed native cause replaces symptom and survives teardown");
        Assert(row.Attempt!.IssueId == reportId, "cause refinement keeps one report");

        // The same rule for a seat that refused to run: it replaces the browser symptom, and the report ID
        // and timing stay the first record's.
        var mismatchId = Guid.NewGuid();
        registry.Connected(mismatchId, "tablet"); registry.BeginAttempt(mismatchId);
        registry.Fail(mismatchId, "browser-transport-lost", "Socket closed", "Reconnect", "No close detail");
        var mismatchReportId = registry.Snapshot().Rows.Single(entry => entry.Id == mismatchId).Attempt!.IssueId;
        registry.Fail(mismatchId, CouchCoop.Mod.Session.HeadlessClientManager.SeatBuildMismatchCode,
            "Different build", "Keep one copy", "loaded from /steamapps/workshop/content/2868840/1/CouchCoop.Mod.dll");
        var mismatchRow = registry.Snapshot().Rows.Single(entry => entry.Id == mismatchId);
        Assert(mismatchRow.Issue!.Code == CouchCoop.Mod.Session.HeadlessClientManager.SeatBuildMismatchCode,
            "a seat build mismatch replaces the browser transport symptom");
        Assert(mismatchRow.Attempt!.IssueId == mismatchReportId, "…and keeps the first report's identity");
        registry.Disconnected(id);
        var report = registry.BuildReport(id)!;
        Assert(report.Contains("Earlier browser symptom", StringComparison.Ordinal), "original transport observation retained");
        Assert(report.Contains("native reason", StringComparison.Ordinal) && report.Contains("exit 0", StringComparison.Ordinal), "known cause and later diagnostic retained");
    }

    private static void IdenticalDeviceLabelsRemainDistinct()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var first = Guid.NewGuid(); var second = Guid.NewGuid();
        registry.Connected(first, "iPhone iOS 17.4 · Safari 17.4");
        registry.Connected(second, "iPhone iOS 17.4 · Safari 17.4");
        registry.BeginAttempt(first); registry.BeginAttempt(second);
        registry.Fail(first, "native", "first failed", "retry");
        registry.Fail(second, "native", "second failed", "retry");
        registry.Fail(second, "secondary", "should not replace", "retry");

        var rows = registry.Snapshot().Rows;
        Assert(rows.Count(row => row.DeviceLabel == "iPhone iOS 17.4 · Safari 17.4") == 2,
            "identical display labels never merge independently owned browser rows");
        Assert(rows.Single(row => row.Id == second).Issue?.Code == "native",
            "a repeated failure keeps the first precise cause instead of duplicating or replacing it");
    }

    private static void AnonymousRowsAndMonotonicStages()
    {
        var time = new FakeTime(); var registry = new ConnectionRegistry(time);
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); registry.Connected(a, null); registry.Connected(b, null);
        Assert(registry.Snapshot().Rows.Count == 2, "anonymous rows remain distinct");
        registry.BeginAttempt(a); time.Advance(1_000); registry.Advance(a, ConnectionStage.Initializing);
        registry.RecordDiagnostic(a, "join readiness", "waiting for child");
        var revision = registry.Snapshot().Revision;
        time.Advance(3_000); registry.Advance(a, ConnectionStage.Initializing);
        registry.RecordDiagnostic(a, "join readiness", "waiting for child");
        Assert(registry.Snapshot().Revision == revision,
            "unchanged heartbeat data does not rebuild focused native rows");
        var row = registry.Snapshot().Rows.Single(x => x.Id == a);
        Assert(row.StageElapsedMs == 3_000, "repeated advance does not reset stage clock");
        registry.Advance(a, ConnectionStage.Choosing);
        Assert(registry.Snapshot().Rows.Single(x => x.Id == a).Stage == ConnectionStage.Initializing, "stages never move backwards");
    }

    private static void RetryFencesOldAttemptAndPreservesIssue()
    {
        var time = new FakeTime(); var registry = new ConnectionRegistry(time); var id = Guid.NewGuid(); registry.Connected(id, null);
        var old = registry.BeginAttempt(id); registry.Fail(id, "native", "native failed", "retry", "cause");
        time.Advance(100_000); var fresh = registry.BeginAttempt(id);
        Assert(!registry.ForAttempt(id, old, r => r.Fail(id, "stale", "bad", "bad")), "old attempt cannot fail replacement");
        Assert(registry.BuildReport(registry.Snapshot().Rows.Single(x => !x.IsLive).Id)?.Contains("native failed", StringComparison.Ordinal) == true, "old issue is frozen for report");
        Assert(registry.ForAttempt(id, fresh, _ => { }), "current attempt is accepted");
        Assert(registry.Snapshot().Rows.Single(x => x.Id == id).ElapsedMs == 0, "retry resets attempt duration");
    }

    private static void FrameNeedsMembershipAndChildReadiness()
    {
        var registry = new ConnectionRegistry(new FakeTime()); var id = Guid.NewGuid(); registry.Connected(id, null);
        var attempt = registry.BeginAttempt(id); registry.ConfigureView(id, requiresChild: true); registry.Advance(id, ConnectionStage.LoadingView);
        Assert(registry.Presented(id, attempt), "frame acknowledgement latches before readiness");
        Assert(registry.Snapshot().Rows.Single(x => x.Id == id).Stage == ConnectionStage.LoadingView, "frame alone cannot complete");
        registry.SetReadiness(id, member: true, childBrowser: false);
        Assert(registry.Snapshot().Rows.Single(x => x.Id == id).Stage == ConnectionStage.LoadingView, "membership alone cannot complete child view");
        registry.SetReadiness(id, member: true, childBrowser: true);
        Assert(registry.Snapshot().Rows.Single(x => x.Id == id).Stage == ConnectionStage.Complete, "matching member and child complete attempt");
    }

    private static void CleanSocketCloseDoesNotRetainChildCountInference()
    {
        var time = new FakeTime();
        var registry = new ConnectionRegistry(time);
        Guid Complete()
        {
            var id = Guid.NewGuid();
            registry.Connected(id, "phone");
            var attempt = registry.BeginAttempt(id);
            registry.Advance(id, ConnectionStage.LoadingView);
            registry.SetReadiness(id, true, true);
            registry.Presented(id, attempt);
            return id;
        }

        var childClosesFirst = Complete();
        registry.SetReadiness(childClosesFirst, true, false);
        time.Advance(250);
        registry.SetReadiness(childClosesFirst, true, false);
        Assert(registry.Snapshot().Rows.Single().Issue is null, "ordinary socket-close ordering does not flash an issue");
        registry.TransportClosing(childClosesFirst);
        time.Advance(5_000);
        registry.SetReadiness(childClosesFirst, true, false);
        registry.Disconnected(childClosesFirst);
        Assert(registry.Snapshot().Rows.Count == 0, "clean close is removed even while join teardown waits");

        var hostClosesFirst = Complete();
        registry.TransportClosing(hostClosesFirst);
        registry.SetReadiness(hostClosesFirst, true, false);
        time.Advance(5_000);
        registry.SetReadiness(hostClosesFirst, true, false);
        registry.Disconnected(hostClosesFirst);
        Assert(registry.Snapshot().Rows.Count == 0, "original socket may close before child count drops");

        var delayedClose = Complete();
        registry.SetReadiness(delayedClose, true, false);
        time.Advance(2_000);
        registry.SetReadiness(delayedClose, true, false);
        Assert(registry.Snapshot().Rows.Single().Issue?.Code == "browser-transport-lost", "a child loss with a live original socket remains actionable");
        registry.TransportClosing(delayedClose);
        registry.Disconnected(delayedClose);
        Assert(registry.Snapshot().Rows.Count == 0, "late clean close retracts only an inferred child-count issue");

        // `seat-build-mismatch` is in this set for the same reason as the native/process causes: the seat
        // reported it about ITSELF and then force-exited, so the socket closing afterwards is its consequence
        // and must not be allowed to retract it.
        foreach (var confirmedCode in new[]
                 {
                     "browser-transport-lost", "native-join-rejected", "process-exited",
                     CouchCoop.Mod.Session.HeadlessClientManager.SeatBuildMismatchCode,
                 })
        {
            var failed = Complete();
            registry.SetReadiness(failed, true, false);
            time.Advance(2_000);
            registry.SetReadiness(failed, true, false);
            registry.Fail(failed, confirmedCode, "Known failure", "Retry", "Confirmed detail");
            registry.TransportClosing(failed);
            registry.Disconnected(failed);
            Assert(registry.Snapshot().Rows.Any(row => row.Issue?.Code == confirmedCode), "clean teardown retains confirmed failures");
        }
    }

    private static void DirectViewAndSlowWarning()
    {
        var time = new FakeTime(); var registry = new ConnectionRegistry(time); var id = Guid.NewGuid(); registry.Connected(id, null);
        var attempt = registry.BeginAttempt(id); registry.ConfigureView(id, requiresChild: false); registry.Advance(id, ConnectionStage.LoadingView);
        Assert(registry.Snapshot().Rows.Single(x => x.Id == id).StepTotal == 4, "direct view uses four steps");
        time.Advance(30_000); registry.NoticeSlowView(id);
        Assert(registry.Snapshot().Rows.Single(x => x.Id == id).Issue?.IsWarning == true, "slow browser is a warning");
        registry.Presented(id, attempt);
        Assert(registry.Snapshot().Rows.Single(x => x.Id == id).Stage == ConnectionStage.Complete, "warning does not terminate healthy completion");
    }

    private static void SlowWarningWaitRechecksEarlyWakeAndAttempt()
    {
        var time = new FakeTime(); var delay = new ControlledDelay(); var registry = new ConnectionRegistry(time, delay.Delay);
        var id = Guid.NewGuid(); registry.Connected(id, null); var attempt = registry.BeginAttempt(id);
        registry.ConfigureView(id, false); registry.Advance(id, ConnectionStage.LoadingView);
        var wait = registry.NoticeSlowViewWhenDueAsync(id, attempt);
        Assert(delay.WaitForPending(1), "slow warning schedules its first delay");
        delay.ReleaseNext();
        Assert(delay.WaitForPending(2), "an early timer wake schedules the remaining monotonic duration");
        time.Advance(30_000); delay.ReleaseNext(); wait.GetAwaiter().GetResult();
        Assert(registry.Snapshot().Rows.Single(row => row.Id == id).Issue?.Code == "browser-view-slow",
            "an early wake cannot permanently skip the slow warning");

        var staleId = Guid.NewGuid(); registry.Connected(staleId, null); var stale = registry.BeginAttempt(staleId);
        registry.ConfigureView(staleId, false); registry.Advance(staleId, ConnectionStage.LoadingView);
        var staleWait = registry.NoticeSlowViewWhenDueAsync(staleId, stale);
        Assert(delay.WaitForPending(3), "stale attempt schedules its delay");
        registry.BeginAttempt(staleId); delay.ReleaseNext(); staleWait.GetAwaiter().GetResult();
        Assert(registry.Snapshot().Rows.Single(row => row.Id == staleId).Issue is null,
            "a superseded attempt cannot create a warning on its replacement");

        var cancelledId = Guid.NewGuid(); registry.Connected(cancelledId, null); var cancelled = registry.BeginAttempt(cancelledId);
        registry.ConfigureView(cancelledId, false); registry.Advance(cancelledId, ConnectionStage.LoadingView);
        using var cancellation = new CancellationTokenSource(); var cancelledWait = registry.NoticeSlowViewWhenDueAsync(cancelledId, cancelled, cancellation.Token);
        Assert(delay.WaitForPending(4), "cancellable wait schedules its delay");
        cancellation.Cancel(); cancelledWait.GetAwaiter().GetResult();
        Assert(registry.Snapshot().Rows.Single(row => row.Id == cancelledId).Issue is null, "cancellation leaves no warning behind");
    }

    private static void SavedIssueTimingAndOutcomes()
    {
        var time = new FakeTime(); var registry = new ConnectionRegistry(time); var id = Guid.NewGuid();
        registry.Connected(id, null); var attempt = registry.BeginAttempt(id); registry.ConfigureView(id, requiresChild: false);
        time.Advance(10_000); registry.Advance(id, ConnectionStage.LoadingView); time.Advance(30_000); registry.NoticeSlowView(id);
        var warning = registry.Snapshot().Rows.Single(row => row.Id == id);
        Assert(warning.Issue?.Outcome == ConnectionIssueOutcome.Waiting && warning.Issue.Timing?.StageElapsedMs == 30_000
            && warning.Issue.Timing.AttemptElapsedMs == 40_000, "warning records its first observed timing");
        time.Advance(200_000); var laterWarning = registry.Snapshot().Rows.Single(row => row.Id == id);
        Assert(laterWarning.ElapsedMs == 40_000 && laterWarning.StageElapsedMs == 30_000, "warning problem duration stays frozen while the attempt lives");
        registry.Fail(id, "browser-transport-lost", "Socket closed", "Retry", "first cause");
        var failed = registry.Snapshot().Rows.Single(row => row.Id == id);
        Assert(failed.Issue?.Outcome == ConnectionIssueOutcome.Failed && failed.Issue.Timing == warning.Issue!.Timing
            && failed.ElapsedMs == 40_000 && failed.StageElapsedMs == 30_000 && failed.StepCount == 3,
            "failure captures before changing the stage and preserves warning timing and progress");
        var reportId = failed.Attempt!.IssueId!.Value; var reportBefore = registry.BuildReport(id)!; time.Advance(50_000); registry.RecordDiagnostic(id, "late", "diagnostic");
        registry.AttachLogExcerpt(id, "client", "late log", "error"); registry.Fail(id, "native-join-rejected", "Native rejected", "Retry", "refined cause");
        var reportAfter = registry.BuildReport(id)!;
        Assert(reportBefore.Contains("stage: LoadingView", StringComparison.Ordinal) && reportBefore.Contains("elapsed: 40000 ms", StringComparison.Ordinal)
            && reportBefore.Contains("stage elapsed: 30000 ms", StringComparison.Ordinal)
            && reportBefore.Contains("LoadingView: 30000 ms", StringComparison.Ordinal), "report includes the captured stage and both frozen durations");
        Assert(reportAfter.Contains("stage: LoadingView", StringComparison.Ordinal) && reportAfter.Contains("elapsed: 40000 ms", StringComparison.Ordinal)
            && reportAfter.Contains("stage elapsed: 30000 ms", StringComparison.Ordinal)
            && reportAfter.Contains("summary: Native rejected", StringComparison.Ordinal), "late diagnostics, logs, and refinement keep report timing frozen");
        Assert(registry.Snapshot().Rows.Single(row => row.Id == id).Issue!.Timing == warning.Issue!.Timing,
            "late diagnostics do not move saved timing");
        registry.Disconnected(id); var archived = registry.Snapshot().Rows.Single(row => row.Id == reportId);
        Assert(archived.ElapsedMs == 40_000 && archived.StageElapsedMs == 30_000 && archived.Issue?.Outcome == ConnectionIssueOutcome.Failed,
            "closed failure snapshot remains stable");

        var recover = Guid.NewGuid(); registry.Connected(recover, null); var recoverAttempt = registry.BeginAttempt(recover);
        registry.ConfigureView(recover, false); registry.Advance(recover, ConnectionStage.LoadingView); time.Advance(30_000); registry.NoticeSlowView(recover);
        var recoveredId = registry.Snapshot().Rows.Single(row => row.Id == recover).Attempt!.IssueId!.Value;
        registry.Presented(recover, recoverAttempt);
        Assert(registry.Snapshot().Rows.Single(row => row.Id == recoveredId).Issue?.Outcome == ConnectionIssueOutcome.Recovered,
            "first presented frame archives waiting warning as recovered");

        var ended = Guid.NewGuid(); registry.Connected(ended, null); registry.BeginAttempt(ended); registry.ConfigureView(ended, false);
        registry.Advance(ended, ConnectionStage.LoadingView); time.Advance(30_000); registry.NoticeSlowView(ended);
        var endedId = registry.Snapshot().Rows.Single(row => row.Id == ended).Attempt!.IssueId!.Value; registry.Disconnected(ended);
        Assert(registry.Snapshot().Rows.Single(row => row.Id == endedId).Issue?.Outcome == ConnectionIssueOutcome.Ended,
            "clean close archives waiting warning as ended");

        var retry = Guid.NewGuid(); registry.Connected(retry, null); registry.BeginAttempt(retry); time.Advance(5_000);
        registry.Fail(retry, "first", "First", "Retry"); registry.BeginAttempt(retry); time.Advance(12_000);
        registry.Fail(retry, "second", "Second", "Retry");
        Assert(registry.Snapshot().Rows.Single(row => row.Id == retry).Issue?.Timing?.AttemptElapsedMs == 12_000,
            "retry creates a new issue timing instead of reusing the prior attempt");

        var dismissed = Guid.NewGuid(); registry.Connected(dismissed, null); registry.BeginAttempt(dismissed); time.Advance(5_000);
        registry.Fail(dismissed, "dismiss", "Dismiss", "Retry"); registry.Dismiss(dismissed); time.Advance(9_000);
        var resumed = registry.Snapshot().Rows.Single(row => row.Id == dismissed);
        Assert(resumed.Issue is null && resumed.StageElapsedMs == 9_000 && resumed.ElapsedMs == 14_000,
            "dismissal returns a live row to its monotonic timer");
    }

    private static void CloseDismissOverflowAndDedupe()
    {
        var registry = new ConnectionRegistry(new FakeTime()); var clean = Guid.NewGuid(); registry.Connected(clean, null); registry.Disconnected(clean);
        Assert(registry.Snapshot().Rows.Count == 0, "clean close is removed");
        var active = Guid.NewGuid(); registry.Connected(active, null); registry.Fail(active, "x", "x", "retry"); registry.Dismiss(active);
        Assert(registry.Snapshot().Rows.Any(x => x.Id == active), "active failed dismiss retains live row");
        registry.Fail(active, "new", "new cause", "retry");
        registry.Fail(active, "again", "secondary", "retry");
        Assert(registry.Snapshot().Rows.Single(row => row.Id == active).Issue?.Summary == "new cause", "first failure cause is retained");
        for (var i = 0; i < 140; i++) { var id = Guid.NewGuid(); registry.Connected(id, null); registry.Fail(id, "x", "x", "x"); registry.Disconnected(id); }
        Assert(registry.Snapshot().OverflowCount > 0, "failure overflow is reported");
    }

    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }

    private sealed class FakeTime : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => _timestamp;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddMilliseconds(_timestamp);
        public void Advance(long milliseconds) => _timestamp += milliseconds;
    }

    private sealed class ControlledDelay
    {
        private readonly object _gate = new();
        private readonly Queue<TaskCompletionSource> _pending = [];
        private int _scheduled;

        public Task Delay(TimeSpan _, CancellationToken cancellationToken)
        {
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_gate) { _pending.Enqueue(completion); _scheduled++; }
            cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
            return completion.Task;
        }

        public bool WaitForPending(int count) => SpinWait.SpinUntil(() => Volatile.Read(ref _scheduled) >= count, TimeSpan.FromSeconds(1));
        public void ReleaseNext()
        {
            TaskCompletionSource completion;
            lock (_gate) completion = _pending.Dequeue();
            completion.TrySetResult();
        }
    }
}
