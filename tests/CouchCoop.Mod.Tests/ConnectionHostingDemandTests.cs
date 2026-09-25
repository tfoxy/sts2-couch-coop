using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;

internal static class ConnectionHostingDemandTests
{
    public static void Run()
    {
        StartsDormantAndStopsAtZeroAggregateDemand();
        StaleCleanupCannotStopNewerDemand();
        OverlappingServerGenerationsKeepIndependentCounts();
        SceneStreamingDemandTracksWatchAndTeardown();
        SceneStreamingDemandSurvivesOverlapAndDelayedCallbacks();
        SceneStreamingPresenceTransitionsWakeAndParkOnce();
        RescanTimerDemandKeepsOwedFinishNudgesAlive();
    }

    private static void StartsDormantAndStopsAtZeroAggregateDemand()
    {
        using var runtime = Runtime();
        using var tracker = new ConnectionHostingTracker(runtime, manager: null);

        Assert(!tracker.IsMonitoring, "construction does not start the hosting monitor");
        tracker.SetBrowserDemand(1, generation: 1);
        Assert(tracker.IsMonitoring, "the first browser starts hosting supervision");
        tracker.SetOwnedSeatDemand(1, generation: 1);
        tracker.SetBrowserDemand(0, generation: 2);
        Assert(tracker.IsMonitoring, "an owned seat retains supervision after the last browser leaves");
        tracker.SetOwnedSeatDemand(0, generation: 2);
        Assert(!tracker.IsMonitoring, "zero browsers and zero owned seats stop all hosting supervision");
    }

    private static void StaleCleanupCannotStopNewerDemand()
    {
        using var runtime = Runtime();
        using var tracker = new ConnectionHostingTracker(runtime, manager: null);

        tracker.SetBrowserDemand(1, generation: 8);
        tracker.SetBrowserDemand(0, generation: 7);
        Assert(tracker.IsMonitoring, "an older zero cannot tear down newer browser demand");
        tracker.SetBrowserDemand(0, generation: 9);
        Assert(!tracker.IsMonitoring, "the current generation can release browser demand");
    }

    private static void OverlappingServerGenerationsKeepIndependentCounts()
    {
        using var runtime = Runtime();
        using var tracker = new ConnectionHostingTracker(runtime, manager: null);
        var reports = new List<(int Count, long Generation)>();
        var ledger = new BrowserDemandLedger((count, generation) =>
        {
            reports.Add((count, generation));
            tracker.SetBrowserDemand(count, generation);
        });
        var oldServer = ledger.CreateReporter();
        var newServer = ledger.CreateReporter();
        oldServer(2, 8);
        newServer(1, 1);
        oldServer(0, 9);
        Assert(tracker.IsMonitoring && reports[^1].Count == 1,
            "closing the old server cannot remove the new generation's browser demand");
        oldServer(2, 8);
        Assert(reports.Count == 3, "an old source's delayed update is ignored");
        newServer(0, 2);
        Assert(!tracker.IsMonitoring && reports[^1].Count == 0,
            "the final current-generation socket releases supervision");
        Assert(reports.Select(row => row.Generation).SequenceEqual(new long[] { 1, 2, 3, 4 }),
            "all source versions become a monotonic host-wide sequence");
    }

    private static CouchCoopRuntimeHost Runtime()
    {
        var stub = new AssetCacheTokenEnvelopeTests.StubRuntime("hosting-demand-test");
        return new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
            stub, stub, stub, stub, stub, stub, stub, stub, stub, stub));
    }

    private static void SceneStreamingDemandTracksWatchAndTeardown()
    {
        var demand = new StreamingViewerDemand();
        var report = demand.CreateReporter();
        Assert(!demand.HasViewers, "the freeze walks start dormant with no streaming viewer");
        report(1, 1);
        Assert(demand.HasViewers, "watch on enables periodic freeze walks");
        report(0, 2);
        Assert(!demand.HasViewers, "watch off or disconnect parks the walks");
        report(1, 3);
        report(0, 4);
        Assert(!demand.HasViewers, "a generation teardown publishes zero even after a re-enable");
        report(1, 3);
        Assert(!demand.HasViewers, "a late source update cannot reopen a stopped generation");
    }

    private static void SceneStreamingDemandSurvivesOverlapAndDelayedCallbacks()
    {
        var demand = new StreamingViewerDemand();
        var oldServer = demand.CreateReporter();
        var newServer = demand.CreateReporter();
        oldServer(1, 1);
        newServer(1, 1);
        oldServer(0, 2);
        Assert(demand.HasViewers, "closing an old server cannot park a newer viewer");
        oldServer(1, 1);
        Assert(demand.HasViewers, "a stale old-server report cannot revive its count");
        newServer(0, 2);
        Assert(!demand.HasViewers, "the last streaming viewer parks the walks");

        demand.Accept(1, 20);
        demand.Accept(0, 19);
        Assert(demand.HasViewers, "a delayed older zero cannot park newer demand");
        demand.Accept(0, 21);
        demand.Accept(1, 20);
        Assert(!demand.HasViewers, "a delayed older positive cannot reopen zero demand");
    }

    private static void SceneStreamingPresenceTransitionsWakeAndParkOnce()
    {
        var transitions = 0;
        var demand = new StreamingViewerDemand(() => transitions++);
        demand.Accept(1, 1);
        demand.Accept(2, 2);
        demand.Accept(0, 1);
        Assert(transitions == 1 && demand.HasViewers,
            "only the first accepted viewer transition requests a timer wake");
        demand.Accept(0, 3);
        demand.Accept(0, 4);
        Assert(transitions == 2 && !demand.HasViewers,
            "only the last viewer transition requests a timer park");
        demand.Accept(1, 3);
        Assert(transitions == 2 && !demand.HasViewers,
            "a stale positive update cannot restart a parked timer");
    }

    private static void RescanTimerDemandKeepsOwedFinishNudgesAlive()
    {
        static bool Runs(bool rescanOnly, bool viewers, bool nudges) =>
            CouchCoopHeadlessVisualSuspender.ShouldRunTimer(rescanOnly, viewers, nudges);
        Assert(!Runs(true, false, false), "an empty windowed host parks the rescan timer");
        Assert(Runs(true, true, false), "a streaming viewer wakes the rescan timer");
        Assert(Runs(true, false, true), "an owed finish nudge keeps the timer running after viewers leave");
        Assert(Runs(true, true, true), "both demands keep the timer running");
        Assert(Runs(false, false, false), "headless supervision remains active at zero demand");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"ConnectionHostingDemandTests failed: {label}.");
        }
    }
}
