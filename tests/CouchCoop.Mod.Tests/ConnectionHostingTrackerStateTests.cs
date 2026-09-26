using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.Protocol;
using Spirectl.Sts2.Core.Reference;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Embedding;

/// <summary>
/// The screen-trigger-driven replacement for ConnectionHostingTracker's full-state poll: the three cheap facts
/// (host-active, in-run, on-lobby-screen) drive the same latch/countdown state machine ObserveState used to run
/// off a state snapshot, and the state subscription now exists only as a fallback for when the game's screen
/// event cannot be resolved.
/// </summary>
internal static class ConnectionHostingTrackerStateTests
{
    public static void Run()
    {
        DormancyLeavesNoScreenSubscriptionAndNeverTouchesState();
        MenuExpiryEndsHostingAfterFiveSeconds();
        LoadingTransitionDoesNotEndHosting();
        EndOfRunSummaryNeverArmsTheCountdown();
        JoinedSomeoneElsesLobbyNeverLatches();
        NativeEndIsImmediate();
        FallbackUsesTheStateSubscriptionWhenTheScreenTriggerIsUnavailable();
    }

    private static void DormancyLeavesNoScreenSubscriptionAndNeverTouchesState()
    {
        var (runtime, runtimeStub) = FakeRuntime();
        var facts = new FakeFacts();
        var trigger = new FakeScreenTrigger();
        using var tracker = NewTracker(runtime, facts, trigger, new FakeTime());

        tracker.SetBrowserDemand(1, generation: 1);
        Assert(trigger.SubscribedCount == 1, "monitoring start subscribes to the screen-changed trigger");
        Assert(!trigger.Disposed, "the subscription stays open while demand is active");

        tracker.SetBrowserDemand(0, generation: 2);
        Assert(trigger.Disposed, "zero demand disposes the screen-changed subscription");
        Assert(!runtimeStub.Calls.Contains("SubscribeCurrentState"),
            "dormancy never falls back to the full-state subscription");
    }

    private static void MenuExpiryEndsHostingAfterFiveSeconds()
    {
        var (runtime, runtimeStub) = FakeRuntime();
        var facts = new FakeFacts { HostActive = true, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(runtime, facts, trigger, time);

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
        var (runtime, runtimeStub) = FakeRuntime();
        var facts = new FakeFacts { HostActive = true, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(runtime, facts, trigger, time);
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
        var (runtime, runtimeStub) = FakeRuntime();
        var facts = new FakeFacts { HostActive = true, RunInProgress = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(runtime, facts, trigger, time);
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
        var (runtime, runtimeStub) = FakeRuntime();
        var facts = new FakeFacts { HostActive = false, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(runtime, facts, trigger, time);
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
        var (runtime, runtimeStub) = FakeRuntime();
        var facts = new FakeFacts { HostActive = true, OnLobbyScreen = true };
        var trigger = new FakeScreenTrigger();
        var time = new FakeTime();
        using var tracker = NewTracker(runtime, facts, trigger, time);

        tracker.SetBrowserDemand(1, generation: 1);
        trigger.Fire(); // latched, with _leftAt never armed (still hosting, per the facts above)

        var before = HostingEndedRevision();
        CouchCoopHostTransport.ResetSession(); // raises HostingEnded, the native end path
        Assert(HostingEndedRevision() > before,
            "the native path ends hosting immediately, with no 5s grace and regardless of _leftAt");
        Assert(tracker.IsMonitoring, "the native end path stops hosting, not the monitor's demand-driven lifecycle");
    }

    private static void FallbackUsesTheStateSubscriptionWhenTheScreenTriggerIsUnavailable()
    {
        var (runtime, runtimeStub) = FakeRuntime();
        var facts = new FakeFacts();
        var trigger = new FakeScreenTrigger { Unavailable = true };
        using var tracker = NewTracker(runtime, facts, trigger, new FakeTime());

        tracker.SetBrowserDemand(1, generation: 1);
        Assert(trigger.SubscribedCount == 0, "an unavailable trigger factory is never subscribed to");
        Assert(runtimeStub.Calls.Contains("SubscribeCurrentState"),
            "an unresolvable screen event falls back to the full-state subscription");
        Assert(tracker.IsMonitoring, "the fallback still counts as monitoring");
    }

    // ConnectionHostingTracker signals "hosting ended" through ConnectionRegistry.Shared.HostingEnded(), not
    // through IsMonitoring (which only tracks whether the demand-driven subscription/timer exist). Its Snapshot
    // revision is bumped by every call, monotonically, so a strict increase across an action is proof that call
    // happened — regardless of any unrelated bump another suite made earlier in the same process.
    private static long HostingEndedRevision() => ConnectionRegistry.Shared.Snapshot().Revision;

    private static ConnectionHostingTracker NewTracker(
        CouchCoopRuntimeHost runtime, IHostingSessionFacts facts, FakeScreenTrigger trigger, TimeProvider time)
        => new(runtime, manager: null, facts, trigger.Subscribe, evaluate => evaluate(), time);

    private static (CouchCoopRuntimeHost Host, FakeHostingRuntime Stub) FakeRuntime()
    {
        var stub = new FakeHostingRuntime();
        var host = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
            stub, stub, stub, stub, stub, stub, stub, stub, stub, stub));
        return (host, stub);
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"ConnectionHostingTrackerStateTests failed: {label}.");
        }
    }

    /// <summary>Three settable facts, standing in for the transport/run-manager/lobby-screen reads.</summary>
    private sealed class FakeFacts : IHostingSessionFacts
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
    private sealed class FakeScreenTrigger
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
    private sealed class FakeTime : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => _timestamp;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddMilliseconds(_timestamp);
        public void Advance(TimeSpan delta) => _timestamp += (long)delta.TotalMilliseconds;
    }

    /// <summary>
    /// A trimmed clone of <see cref="AssetCacheTokenEnvelopeTests.StubRuntime"/> that reports the state capability
    /// as supported and records/serves <see cref="SubscribeCurrentState"/> calls, needed only by the Fallback
    /// scenario above.
    /// </summary>
    private sealed class FakeHostingRuntime : IRuntimeCapabilitySource, IRuntimeAssetSource, IRuntimeStateSource,
        IAnimationHintSource, IRuntimeSceneDeltaSource, IGameModelSource, ISpineCatalogSource, ISpineGeoClipBaker,
        ISemanticActionSource, IRuntimeSceneWatchControlSource
    {
        public List<string> Calls { get; } = [];
        public IRuntimeSceneWatchControls SceneWatchControls => Spirectl.Sts2.Live.Sts2RuntimeSceneWatchControls.Instance;
        public ISpirectlAssetProvider Assets { get; } = new AssetCacheTokenEnvelopeTests.StubAssetProvider();

        public EmbeddableRuntimeCapabilities GetCapabilities()
            => new(
                "spirectl/v1",
                "hosting-tracker-state-test",
                "test-bridge",
                "embedded",
                RuntimeAttachmentState.Attached,
                DataSourceKind.Stub,
                Provisional: false,
                [new EmbeddableRuntimeCapability(
                    CouchCoopRuntimeHost.StateCapability, "state", Supported: true, Provisional: false, UnsupportedReason: null)],
                []);

        public CurrentStateResult GetCurrentState(CurrentStateRequest request) => throw new NotSupportedException();

        public IDisposable SubscribeCurrentState(
            CurrentStateSubscriptionRequest request,
            Action<CurrentStateWatchEvent> onEvent,
            Action<EmbeddableRuntimeError>? onError = null)
        {
            Calls.Add("SubscribeCurrentState");
            return NoopDisposable.Instance;
        }

        public IAsyncEnumerable<CurrentStateWatchEvent> WatchCurrentStateAsync(
            CurrentStateSubscriptionRequest request,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public IDisposable SubscribeCombatEvents(
            CombatEventSubscriptionRequest request,
            Action<CombatWatchEvent> onEvent,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

        public IAsyncEnumerable<CombatWatchEvent> WatchCombatEventsAsync(
            CombatEventSubscriptionRequest request,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public IDisposable SubscribeAnimationHints(
            AnimationHintSubscriptionRequest request,
            Action<TweenAnimationHint> onHint,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

        public IAsyncEnumerable<TweenAnimationHint> WatchAnimationHintsAsync(
            AnimationHintSubscriptionRequest request,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public IDisposable SubscribeRuntimeSceneDelta(
            RuntimeSceneSubscriptionRequest request,
            Action<RuntimeSceneDelta> onDelta,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

        public ModelCatalogOperationResult GetModels(ModelCatalogRequestSnapshot request) => throw new NotSupportedException();

        public SpineCatalogOperationResult GetSpineCatalog(SpineCatalogRequestSnapshot request) => throw new NotSupportedException();

        public SpineGeoClipBakeResultSnapshot BakeSpineGeoClip(SpineGeoClipBakeRequestSnapshot request) => throw new NotSupportedException();

        public ReferenceOperationResult GetReference(ReferenceRequestSnapshot request) => throw new NotSupportedException();

        public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request) => throw new NotSupportedException();

        public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request) => throw new NotSupportedException();

        private sealed class NoopDisposable : IDisposable
        {
            public static readonly NoopDisposable Instance = new();
            public void Dispose() { }
        }
    }
}
