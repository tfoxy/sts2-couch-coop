using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Session;

/// <summary>
/// ConnectionHostingTracker is driven by three cheap facts (host-active, in-run, on-lobby-screen), re-read on the
/// game's screen-changed event. It has no state-snapshot path and no poll: when the screen event cannot be
/// resolved it does nothing, and hosting ends only on the transport's own signal.
/// </summary>
internal static class ConnectionHostingTrackerStateTests
{
    public static void Run()
    {
        DormancyLeavesNoScreenSubscriptionAndNoTimer();
        MenuExpiryEndsHostingAfterFiveSeconds();
        LoadingTransitionDoesNotEndHosting();
        EndOfRunSummaryNeverArmsTheCountdown();
        JoinedSomeoneElsesLobbyNeverLatches();
        NativeEndIsImmediate();
        UnavailableScreenTriggerLeavesOnlyTheNativeEnd();
    }

    private static void DormancyLeavesNoScreenSubscriptionAndNoTimer()
    {
        var facts = new FakeFacts();
        var trigger = new FakeScreenTrigger();
        using var tracker = NewTracker(facts, trigger, new FakeTime());

        tracker.SetBrowserDemand(1, generation: 1);
        Assert(trigger.SubscribedCount == 1, "monitoring start subscribes to the screen-changed trigger");
        Assert(!trigger.Disposed, "the subscription stays open while demand is active");

        tracker.SetBrowserDemand(0, generation: 2);
        Assert(trigger.Disposed, "zero demand disposes the screen-changed subscription");
        Assert(!tracker.IsMonitoring, "zero demand leaves neither a subscription nor the expiry timer");
    }

    private static void MenuExpiryEndsHostingAfterFiveSeconds()
    {
        var facts = new FakeFacts { HostActive = true, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(facts, trigger, time);

        tracker.SetBrowserDemand(1, generation: 1);
        trigger.Fire(); // hosted, on the lobby screen: latches
        Assert(tracker.IsMonitoring, "monitoring stays active once hosting latches");

        facts.HostActive = true;
        facts.OnLobbyScreen = false; // back at the menu (neither in-run nor on a lobby screen)
        trigger.Fire();

        var beforeExpiry = HostingEndedRevision();
        time.Advance(TimeSpan.FromSeconds(4.9));
        tracker.TickForTests();
        Assert(HostingEndedRevision() == beforeExpiry, "hosting has not aged out at 4.9s");

        time.Advance(TimeSpan.FromSeconds(0.2));
        tracker.TickForTests();
        Assert(HostingEndedRevision() > beforeExpiry, "hosting ends once the menu has been showing for 5s");
    }

    private static void LoadingTransitionDoesNotEndHosting()
    {
        var facts = new FakeFacts { HostActive = true, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(facts, trigger, time);
        var before = HostingEndedRevision();

        tracker.SetBrowserDemand(1, generation: 1);
        trigger.Fire(); // latched in the lobby

        facts.OnLobbyScreen = false; // the lobby screen is torn down while the run loads
        trigger.Fire();
        time.Advance(TimeSpan.FromSeconds(2));
        tracker.TickForTests();
        Assert(HostingEndedRevision() == before, "still within the 5s loading-transition grace");

        facts.RunInProgress = true; // the run screen is up before the grace period elapsed
        trigger.Fire();
        time.Advance(TimeSpan.FromSeconds(10));
        tracker.TickForTests();
        Assert(HostingEndedRevision() == before,
            "hosting never ends once the run replaces the lobby inside the grace window");
    }

    private static void EndOfRunSummaryNeverArmsTheCountdown()
    {
        var facts = new FakeFacts { HostActive = true, RunInProgress = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(facts, trigger, time);
        var before = HostingEndedRevision();

        tracker.SetBrowserDemand(1, generation: 1);
        trigger.Fire(); // latched in-run

        // Death/the Architect summary: RunManager.IsInProgress stays true (roster-push-only-run-end-rule), and
        // the summary is not a registered lobby screen either way.
        facts.OnLobbyScreen = false;
        trigger.Fire();
        time.Advance(TimeSpan.FromSeconds(30));
        tracker.TickForTests();
        Assert(HostingEndedRevision() == before, "the end-of-run summary never starts the expiry countdown");
    }

    private static void JoinedSomeoneElsesLobbyNeverLatches()
    {
        var facts = new FakeFacts { HostActive = false, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(facts, trigger, time);
        var before = HostingEndedRevision();

        tracker.SetBrowserDemand(1, generation: 1);
        trigger.Fire();
        time.Advance(TimeSpan.FromSeconds(10));
        tracker.TickForTests();
        Assert(tracker.IsMonitoring, "monitoring stays alive under active demand");

        facts.RunInProgress = true;
        trigger.Fire();
        time.Advance(TimeSpan.FromSeconds(10));
        tracker.TickForTests();
        Assert(HostingEndedRevision() == before,
            "a seat that never hosted (HostActive stays false) never latches, so hosting never ends here either");
    }

    private static void NativeEndIsImmediate()
    {
        var facts = new FakeFacts { HostActive = true, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(facts, trigger, time);

        tracker.SetBrowserDemand(1, generation: 1);
        trigger.Fire(); // latched, with _leftAt never armed (still hosting, per the facts above)

        var before = HostingEndedRevision();
        CouchCoopHostTransport.ResetSession(); // raises HostingEnded, the native end path
        Assert(HostingEndedRevision() > before,
            "the native path ends hosting immediately, with no 5s grace and regardless of _leftAt");
        Assert(tracker.IsMonitoring, "the native end path stops hosting, not the monitor's demand-driven lifecycle");
    }

    private static void UnavailableScreenTriggerLeavesOnlyTheNativeEnd()
    {
        var facts = new FakeFacts { HostActive = true, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger { Unavailable = true };
        var time = new FakeTime();
        using var tracker = NewTracker(facts, trigger, time);
        var before = HostingEndedRevision();

        tracker.SetBrowserDemand(1, generation: 1);
        Assert(trigger.SubscribedCount == 0, "an unavailable trigger factory is never subscribed to");
        Assert(!tracker.IsMonitoring, "without the trigger nothing is subscribed and no expiry timer exists");

        // No backstop: whatever the game does, an unresolvable trigger can never arm the countdown.
        facts.OnLobbyScreen = false;
        time.Advance(TimeSpan.FromSeconds(30));
        tracker.TickForTests();
        Assert(HostingEndedRevision() == before, "without the trigger the expiry countdown never runs");

        tracker.SetBrowserDemand(0, generation: 2);
        tracker.SetBrowserDemand(1, generation: 3);
        Assert(!tracker.IsMonitoring, "demand transitions stay inert while the trigger is unavailable");

        CouchCoopHostTransport.ResetSession(); // the transport's own end signal is the only way hosting ends
        Assert(HostingEndedRevision() > before, "the native end still ends hosting immediately");
    }

    // ConnectionHostingTracker signals "hosting ended" through ConnectionRegistry.Shared.HostingEnded(), not
    // through IsMonitoring (which only tracks whether the demand-driven subscription/timer exist). Its Snapshot
    // revision is bumped by every call, monotonically, so a strict increase across an action is proof that call
    // happened — regardless of any unrelated bump another suite made earlier in the same process.
    private static long HostingEndedRevision() => ConnectionRegistry.Shared.Snapshot().Revision;

    private static ConnectionHostingTracker NewTracker(
        IHostingSessionFacts facts, FakeScreenTrigger trigger, TimeProvider time)
        => new(manager: null, facts, trigger.Subscribe, evaluate => evaluate(), time);

    /// <summary>A tracker with an always-available, inert trigger: for tests that only exercise demand lifecycle.</summary>
    internal static ConnectionHostingTracker NewIdleTracker()
        => NewTracker(new FakeFacts(), new FakeScreenTrigger(), new FakeTime());

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"ConnectionHostingTrackerStateTests failed: {label}.");
        }
    }

    /// <summary>Three settable facts, standing in for the transport/run-manager/lobby-screen reads.</summary>
    internal sealed class FakeFacts : IHostingSessionFacts
    {
        public bool HostActive;
        public bool RunInProgress;
        public bool OnLobbyScreen;

        public bool IsHostActive() => HostActive;
        public bool IsRunInProgress() => RunInProgress;
        public bool IsOnLobbyScreen() => OnLobbyScreen;
    }

    /// <summary>
    /// Stands in for <c>Sts2ScreenContext.SubscribeUpdated</c>: holds the last-subscribed handler so a test can
    /// fire a "screen changed" event on demand, and can report itself unavailable (returns null) the way the real
    /// seam does outside a game process.
    /// </summary>
    internal sealed class FakeScreenTrigger
    {
        private Action? _handler;
        public bool Unavailable;
        public int SubscribedCount { get; private set; }
        public bool Disposed { get; private set; }

        public IDisposable? Subscribe(Action handler)
        {
            if (Unavailable)
            {
                return null;
            }

            _handler = handler;
            SubscribedCount++;
            Disposed = false;
            return new Subscription(this);
        }

        public void Fire() => _handler?.Invoke();

        private sealed class Subscription(FakeScreenTrigger owner) : IDisposable
        {
            public void Dispose() => owner.Disposed = true;
        }
    }

    /// <summary>Mutable <see cref="TimeProvider"/> so 5s-expiry math is deterministic instead of a real sleep.</summary>
    internal sealed class FakeTime : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => _timestamp;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddMilliseconds(_timestamp);
        public void Advance(TimeSpan delta) => _timestamp += (long)delta.TotalMilliseconds;
    }
}
