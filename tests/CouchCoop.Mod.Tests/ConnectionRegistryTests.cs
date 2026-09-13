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

        foreach (var confirmedCode in new[] { "browser-transport-lost", "native-join-rejected", "process-exited" })
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
}
