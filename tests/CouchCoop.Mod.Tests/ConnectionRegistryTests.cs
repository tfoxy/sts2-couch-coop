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
        AViewerThatNeverArrivedIsNotALostBrowser();
        SeatConditionIsAWarningThatDedupesAndWithdraws();
        DirectViewAndSlowWarning();
        SlowWarningWaitRechecksEarlyWakeAndAttempt();
        SavedIssueTimingAndOutcomes();
        CloseDismissOverflowAndDedupe();
        HostingEndedKeepsTheEvidenceAndResetsTheLiveRow();
    }

    /// <summary>
    /// Backing out to the main menu must not destroy the report for a failure that already happened — the one
    /// moment a player is most likely to do it is straight after the failure they would be reporting.
    /// </summary>
    private static void HostingEndedKeepsTheEvidenceAndResetsTheLiveRow()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var id = Guid.NewGuid();
        registry.Connected(id, "iPhone iOS 18.7 · Safari 18.7");
        registry.BeginAttempt(id);
        registry.RecordDiagnostic(id, "clientVitals", "stage=dom->dom canvasPx=41287680");
        registry.Fail(id, "browser-transport-lost", "The browser connection ended unexpectedly.",
            "Check this device's network connection and reload the browser tab.", "ThrowEOFUnexpected");
        var reportId = registry.Snapshot().Rows.Single().Attempt!.IssueId!.Value;

        registry.HostingEnded();

        // The evidence survives, still readable and still carrying the census that names the cause.
        var report = registry.BuildReport(reportId);
        Assert(report is not null, "the failed attempt's report survives hosting ending");
        Assert(report!.Contains("canvasPx=41287680", StringComparison.Ordinal),
            $"…and it still carries the client census (actual: {report})");
        Assert(registry.Snapshot().Rows.Any(row => row.Issue?.Code == "browser-transport-lost"),
            "…and the panel still shows it as a row to copy from");

        // …while the LIVE connection is reset to a fresh pre-attempt state, because that part really is gone.
        var live = registry.Snapshot().Rows.Single(row => row.Id == id);
        Assert(live.Issue is null && live.Attempt!.IssueId is null,
            "the live connection no longer carries the finished attempt's issue");
        Assert(live.Stage == ConnectionStage.Choosing, "the live connection is back at the first stage");
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

        // …and identically for the seat this host stopped over the player's cloud saves. Same shape, same
        // reason: the seat is killed the moment the host learns it cannot vouch for them, so the browser socket
        // closing is downstream of the cause, and "reconnect this device" would be advice about the wrong thing.
        var cloudId = Guid.NewGuid();
        registry.Connected(cloudId, "phone"); registry.BeginAttempt(cloudId);
        registry.Fail(cloudId, "browser-transport-lost", "Socket closed", "Reconnect", "No close detail");
        registry.Fail(cloudId, CouchCoop.Mod.Session.HeadlessClientManager.SeatCloudIsolationCode,
            "No cloud save promise", "Restart and retry", "the seat never declared the isolation");
        Assert(registry.Snapshot().Rows.Single(entry => entry.Id == cloudId).Issue!.Code
                == CouchCoop.Mod.Session.HeadlessClientManager.SeatCloudIsolationCode,
            "a cloud-isolation refusal replaces the browser transport symptom too");

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
                     CouchCoop.Mod.Session.HeadlessClientManager.SeatCloudIsolationCode,
                     CouchCoop.Mod.Session.HeadlessDisconnectReason.RunInProgressCode,
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

        // THE ONE REPLACEMENT ALLOWED, and its direction. A seat reports a drop generically first and names the
        // real reason a beat later; without this the row keeps the generic native rejection and the host is told
        // to check that game and mod versions match, for a run the player is simply not in.
        var refined = Complete();
        registry.Fail(refined, "native-join-rejected", "Native rejection", "Retry", "the socket went away");
        registry.Fail(refined, CouchCoop.Mod.Session.HeadlessDisconnectReason.RunInProgressCode,
            "The run was already in progress", "Reload the saved run", "RunInProgress");
        Assert(registry.Snapshot().Rows.Any(row => row.Id == refined
                && row.Issue?.Code == CouchCoop.Mod.Session.HeadlessDisconnectReason.RunInProgressCode),
            "a late run-in-progress refusal replaces the generic native cause recorded before it");
        registry.Fail(refined, "native-disconnected", "Disconnected", "Retry", "a later generic report");
        Assert(registry.Snapshot().Rows.Any(row => row.Id == refined
                && row.Issue?.Code == CouchCoop.Mod.Session.HeadlessDisconnectReason.RunInProgressCode),
            "…and nothing generic takes it back");
    }

    /// <summary>
    /// The Sep-16 defect: a phone that completes its join, is redirected to its seat and cannot reach it was
    /// reported to the HOST as a closed browser tab ("reload the browser and select the same player"), while the
    /// phone itself was correctly told its network path was blocked. Two surfaces, two diagnoses, the host's
    /// wrong. Both producers of that row are asserted here, because the one the panel actually shows is the
    /// client's own report, not the child-count inference.
    /// </summary>
    private static void AViewerThatNeverArrivedIsNotALostBrowser()
    {
        var time = new FakeTime();
        var registry = new ConnectionRegistry(time);

        // A viewer redirected to a seat it cannot open. The seat monitor keeps saying "no browser attached", and
        // the browser reports its game-view socket as closed the moment it gives up — it never opened.
        var blocked = Guid.NewGuid();
        registry.Connected(blocked, "phone");
        var blockedAttempt = registry.BeginAttempt(blocked);
        registry.ConfigureView(blocked, requiresChild: true);
        registry.Advance(blocked, ConnectionStage.LoadingView);
        registry.SetReadiness(blocked, member: true, childBrowser: false);
        time.Advance(10_000);
        registry.SetReadiness(blocked, member: true, childBrowser: false);
        Assert(registry.ClientViewError(blocked, blockedAttempt, "browser-transport-lost", "socket closed"),
            "the client's view error is still accepted and recorded");
        var blockedRow = registry.Snapshot().Rows.Single(row => row.Id == blocked);
        Assert(blockedRow.Issue is null && blockedRow.Stage == ConnectionStage.LoadingView,
            "a viewer that never reached its seat is not reported as a lost browser tab");
        Assert(registry.BuildReport(blocked)!.Contains("before any browser reached", StringComparison.Ordinal),
            "…and the report it could not fail still carries what the browser said");

        // …and the same attempt, once a browser HAS been attached, keeps today's behaviour on both producers.
        registry.SetReadiness(blocked, member: true, childBrowser: true);
        Assert(registry.ClientViewError(blocked, blockedAttempt, "browser-transport-lost", "socket closed"),
            "a view error after a real attachment is recorded");
        Assert(registry.Snapshot().Rows.Single(row => row.Id == blocked).Issue?.Code == "browser-transport-lost",
            "a browser that HAD a view and lost it is still reported as transport loss");

        // The child-count inference, both ways. Reaching Complete needs a frame and an attached browser, so the
        // never-attached side is built by taking the attachment away again after the row completed.
        var everSeen = Guid.NewGuid();
        registry.Connected(everSeen, "phone");
        var everSeenAttempt = registry.BeginAttempt(everSeen);
        registry.ConfigureView(everSeen, requiresChild: true);
        registry.Advance(everSeen, ConnectionStage.LoadingView);
        registry.SetReadiness(everSeen, member: true, childBrowser: true);
        registry.Presented(everSeen, everSeenAttempt);
        Assert(registry.Snapshot().Rows.Single(row => row.Id == everSeen).Stage == ConnectionStage.Complete,
            "the attached row completes");
        registry.SetReadiness(everSeen, member: true, childBrowser: false);
        time.Advance(2_000);
        registry.SetReadiness(everSeen, member: true, childBrowser: false);
        Assert(registry.Snapshot().Rows.Single(row => row.Id == everSeen).Issue?.Code == "browser-transport-lost",
            "a completed view whose browser goes away is still inferred as transport loss");

        // The gate itself: a Complete row that requires a child and has NEVER had one cannot infer transport
        // loss. Reached by the one live path that produces it — a direct view (which completes without a child)
        // that then asks for a seat, which is ConfigureView(requiresChild: true, reused: true).
        var promoted = Guid.NewGuid();
        registry.Connected(promoted, "phone");
        var promotedAttempt = registry.BeginAttempt(promoted);
        // ConfigureView grants membership and the view outright for a direct view, so no browser is ever
        // REPORTED attached on this attempt — which is exactly the state the latch has to survive.
        registry.ConfigureView(promoted, requiresChild: false);
        registry.Advance(promoted, ConnectionStage.LoadingView);
        registry.Presented(promoted, promotedAttempt);
        Assert(registry.Snapshot().Rows.Single(row => row.Id == promoted).Stage == ConnectionStage.Complete,
            "the direct view completes");
        registry.ConfigureView(promoted, requiresChild: true, reused: true);
        registry.SetReadiness(promoted, member: true, childBrowser: false);
        time.Advance(2_000);
        registry.SetReadiness(promoted, member: true, childBrowser: false);
        Assert(registry.Snapshot().Rows.Single(row => row.Id == promoted).Issue is null,
            "a completed row promoted to a seat view infers nothing until a browser has reached that seat");
    }

    /// <summary>
    /// The seat monitor's verdict on the host's own row: a WARNING (the session is alive and the join completed),
    /// deduplicated so a 250 ms monitor tick cannot bump the revision, and withdrawn when the cause stops holding.
    /// </summary>
    private static void SeatConditionIsAWarningThatDedupesAndWithdraws()
    {
        var time = new FakeTime();
        var registry = new ConnectionRegistry(time);
        var id = Guid.NewGuid();
        registry.Connected(id, "phone");
        registry.BeginAttempt(id);
        registry.ConfigureView(id, requiresChild: true);
        registry.Advance(id, ConnectionStage.LoadingView);

        var networkPath = new ConnectionIssue(CouchCoop.Mod.Session.SeatReadinessVerdict.NetworkPathCode,
            "This player's game is running, but their device never reached it.", "Check the network.", "evidence tail");
        registry.ReportSeatCondition(id, null);
        Assert(registry.Snapshot().Rows.Single(row => row.Id == id).Issue is null, "nothing to withdraw is a no-op");

        registry.ReportSeatCondition(id, networkPath);
        var raised = registry.Snapshot();
        var row = raised.Rows.Single(entry => entry.Id == id);
        Assert(row.Issue?.Code == CouchCoop.Mod.Session.SeatReadinessVerdict.NetworkPathCode
            && row.Issue.IsWarning && row.Issue.Outcome == ConnectionIssueOutcome.Degraded
            && row.Stage == ConnectionStage.LoadingView,
            "the seat verdict reaches the row as a warning and leaves a live session live");

        // Saving an issue kicks off an asynchronous log capture that bumps the revision once on its own, so let
        // the row settle before measuring what a DUPLICATE report costs.
        var settled = Settled(registry);
        registry.ReportSeatCondition(id, networkPath with { Detail = "a later tick of the same cause" });
        var deduped = registry.Snapshot();
        Assert(deduped.Revision == settled,
            "re-reporting the same cause does not bump the revision, so the panel does not repaint on every tick");
        Assert(deduped.Rows.Single(entry => entry.Id == id).Issue?.Detail == "evidence tail",
            "…and the row keeps the first report of that cause rather than being rewritten every tick");

        registry.ReportSeatCondition(id, null);
        Assert(registry.Snapshot().Rows.Single(entry => entry.Id == id).Issue is null
            && registry.Snapshot().Rows.Count(entry => entry.Id != id) == 0,
            "a cause that stops holding is withdrawn from the row and leaves no archived issue behind");

        registry.ReportSeatCondition(id, networkPath);
        Assert(registry.Snapshot().Rows.Single(entry => entry.Id == id).Issue?.Code
            == CouchCoop.Mod.Session.SeatReadinessVerdict.NetworkPathCode, "the same cause can be raised again");

        // A recorded failure is the more specific word, and outranks a warning in both directions.
        registry.Fail(id, "process-exited", "The client game process closed unexpectedly.", "Retry.", "exit 1");
        registry.ReportSeatCondition(id, networkPath);
        Assert(registry.Snapshot().Rows.Single(entry => entry.Id == id).Issue?.Code == "process-exited",
            "a seat condition never overwrites a recorded failure");
        registry.ReportSeatCondition(id, null);
        Assert(registry.Snapshot().Rows.Single(entry => entry.Id == id).Issue?.Code == "process-exited",
            "…and a withdrawal only ever retracts the warning this entry point raised");
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

    /// <summary>
    /// The registry's revision once the asynchronous log capture behind <c>SaveIssue</c> has stopped moving it.
    /// </summary>
    private static long Settled(ConnectionRegistry registry)
    {
        var revision = registry.Snapshot().Revision;
        for (var attempt = 0; attempt < 200; attempt++)
        {
            Thread.Sleep(10);
            var next = registry.Snapshot().Revision;
            if (next == revision) return revision;
            revision = next;
        }
        return revision;
    }

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
