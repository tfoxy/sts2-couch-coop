using CouchCoop.Mod.Session;

internal static class RenderStreamSwapTests
{
    public static void Run()
    {
        Action[] tests =
        [
            ForcedTrimBypassesIdleAndIntervalGates,
            IdleTrimRetainsItsGates,
            MissingTrimSymbolLatchesOffBothPaths,
            InitialMirrorDoesNoCaptureWork,
            ArmResumesBeforeCallingCapture,
            ArmUsesTheRequestingAspectAndConfiguredCap,
            OnlyArmedPublishesTheSnapshot,
            RefusedArmRestoresTheSuspender,
            ArmFailureAllowsAnExplicitRetry,
            PagesShareOneArm,
            OnlyTheLastMirrorRequestDisarms,
            MirrorCanCancelAnArmingCapture,
            DisarmClearsTheSnapshotBeforeCallingCapture,
            NeverConnectedCaptureGetsNinetySeconds,
            ConnectingCancelsGrace,
            OnlyTheLastClientLeavingStartsGrace,
            CancelledDeadlinesCannotDisarmALaterArm,
            ReleaseAndReloadDoNotResetGrace,
            RequestDuringDisarmRearmsAfterTeardown,
            WithdrawnDemandDuringDisarmDoesNotRearm,
            StreamEndedFailsWithoutAutomaticRearm,
            StreamEndedDuringArmingAlsoDisarms,
            NewDemandDuringFailedTeardownCanRearm,
            SecondArmUsesTheNewSignalSnapshot,
            NoCaptureReportsFailureWithoutSideEffects,
            SingletonDiscoverySubscribesOnlyOnce,
            DisposalCancelsGraceAndSignalSubscriptions,
            QuitStillDisarmsArmingAndArmedCaptures,
            DisarmRefusalsHandleAlreadyStoppedOrStopping,
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"RenderStreamSwapTests: {tests.Length} passed.");
    }

    private static void ForcedTrimBypassesIdleAndIntervalGates()
    {
        var calls = 0;
        var gate = new HeadlessMallocTrim.Gate(() => calls++);
        gate.MaybeTrim(idleMs: 0, nowMs: 100);
        Assert(calls == 0, "activity prevents an idle trim");
        gate.Trim(100);
        gate.Trim(101);
        Assert(calls == 2 && gate.TrimCount == 2, "teardown trims immediately even within the maintenance interval");
        gate.MaybeTrim(idleMs: 5000, nowMs: 102);
        Assert(calls == 2, "forced trim also starts the maintenance interval");
    }

    private static void IdleTrimRetainsItsGates()
    {
        var calls = 0;
        var gate = new HeadlessMallocTrim.Gate(() => calls++);
        gate.MaybeTrim(idleMs: 4999, nowMs: 100);
        Assert(calls == 0, "maintenance waits for idle");
        gate.MaybeTrim(idleMs: 5000, nowMs: 100);
        gate.MaybeTrim(idleMs: 5000, nowMs: 30099);
        Assert(calls == 1, "maintenance retains its minimum interval");
        gate.MaybeTrim(idleMs: 5000, nowMs: 30100);
        Assert(calls == 2, "maintenance can trim at the interval boundary");
    }

    private static void MissingTrimSymbolLatchesOffBothPaths()
    {
        foreach (var error in new Exception[] { new DllNotFoundException(), new EntryPointNotFoundException() })
        foreach (var forceFirst in new[] { false, true })
        {
            var calls = 0;
            var gate = new HeadlessMallocTrim.Gate(() => { calls++; throw error; });
            if (forceFirst) gate.Trim(100);
            else gate.MaybeTrim(idleMs: 5000, nowMs: 100);
            gate.Trim(101);
            gate.MaybeTrim(idleMs: 5000, nowMs: 30100);
            Assert(calls == 1 && gate.TrimCount == 0, "a missing libc symbol latches off both paths after one attempt");
        }
    }

    private static void InitialMirrorDoesNoCaptureWork()
    {
        using var f = new Fixture();
        Assert(f.Swap.State == "mirror" && f.Swap.Reason is null && f.Swap.Snapshot is null, "initial mirror state");
        Assert(f.Events.Count == 0 && f.Capture.Discoveries == 0 && f.Deadlines.Count == 0, "construction has no capture effects");
    }

    private static void ArmResumesBeforeCallingCapture()
    {
        using var f = new Fixture();
        f.Capture.BeforeArm = () => Assert(f.Events.SequenceEqual(new[] { "subscribe", "suspender:False", "changed:arming", "arm" }),
            "subscribe and resume before arm, publishing arming along the way");
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "arming" && f.Swap.Snapshot is null, "arming has no descriptor");
        Assert(f.Capture.Options is { Count: 1 } && f.Capture.Options["GRC_ROOT_SIZE"] == "presentation:1920x1080",
            "only the per-arm root size overrides the standby environment");
    }

    private static void ArmUsesTheRequestingAspectAndConfiguredCap()
    {
        foreach (var (aspect, cap, width) in new (double?, int, int)[]
        {
            (null, 2520, 1920), (double.NaN, 2520, 1920), (double.PositiveInfinity, 2520, 1920),
            (0.2, 2520, 1920), (5.1, 2520, 1920), (0.25, 2520, 1920),
            (2340.0 / 1080, 2520, 2340), (3, 2520, 2520), (3, 2600, 2600),
            (1940.0 / 1080, 2520, 1938), (3, 1000, 1920),
        })
        {
            using var f = new Fixture(cap);
            f.Swap.Request("page", true, aspect);
            Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == $"presentation:{width}x1080", "aspect follows presentation width clamping");
        }
    }

    private static void OnlyArmedPublishesTheSnapshot()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        var snapshot = Snapshot("first");
        f.Capture.EmitArmed(snapshot);
        Assert(ReferenceEquals(f.Swap.Snapshot, snapshot), "signal facts are preserved, including certificate and root size");
        Assert(f.Swap.State == "armed" && f.Swap.Reason is null, "armed is exposed to pages");
        Assert(f.Changes[^1] == ("armed", snapshot), "change notification sees the armed snapshot");
        Assert(!snapshot.ToString().Contains(snapshot.Token, StringComparison.Ordinal), "snapshot formatting excludes the token");
    }

    private static void RefusedArmRestoresTheSuspender()
    {
        foreach (var result in new[] { 31, 44 })
        {
            using var f = new Fixture();
            f.Capture.ArmResult = result;
            f.Swap.Request("page", true);
            Assert(f.Swap.State == "failed" && f.Swap.Reason == $"arm-refused:{result}", "refusal is observable without a signal");
            Assert(f.SuspenderEnabled && f.Swap.Snapshot is null && f.Deadlines.Count == 0, "refusal restores mirror immediately");
            f.Capture.ArmResult = 0;
            f.Swap.Request("page", true);
            Assert(f.Capture.ArmCalls == 2 && f.Swap.State == "arming", "an explicit request retries a refused arm");
        }
    }

    private static void ArmFailureAllowsAnExplicitRetry()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        f.Capture.EmitArmFailed("capture-start-failed");
        Assert(f.Swap.State == "failed" && f.Swap.Reason == "capture-start-failed" && f.SuspenderEnabled, "arm failure restores mirror");
        Assert(f.Capture.ArmCalls == 1 && f.TrimCalls == 0, "failure does not automatically retry or trim");
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "arming" && f.Swap.Reason is null && f.Capture.Subscriptions == 1, "retry keeps the persistent subscription");
    }

    private static void PagesShareOneArm()
    {
        using var f = new Fixture();
        f.Swap.Request("one", true);
        f.Swap.Request("two", true, 3);
        f.Capture.EmitArmed(Snapshot("first"));
        f.Swap.Request("two", true, 2);
        Assert(f.Capture.ArmCalls == 1 && f.Capture.Subscriptions == 1, "requests during arming and armed share the capture");
        Assert(f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:1920x1080", "the first requester owns this arm's size");
    }

    private static void OnlyTheLastMirrorRequestDisarms()
    {
        using var f = new Fixture();
        f.Arm();
        f.Swap.Request("two", true);
        f.Swap.Request("page", false);
        Assert(f.Capture.DisarmCalls == 0, "another wanting page keeps the capture");
        f.Swap.Request("two", false);
        Assert(f.Capture.DisarmCalls == 1 && f.Capture.DisarmReason == "mirror", "last explicit mirror request disarms");

        using var released = new Fixture();
        released.Arm();
        released.Swap.Request("two", true);
        released.Swap.Release("page");
        Assert(released.Capture.DisarmCalls == 0, "one released page does not disarm");
        released.Swap.Request("two", false);
        Assert(released.Capture.DisarmCalls == 1, "released pages no longer count as wanting the stream");
    }

    private static void MirrorCanCancelAnArmingCapture()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        f.Swap.Request("page", false);
        Assert(f.Capture.DisarmCalls == 1 && f.Swap.State == "mirror", "arming can be cancelled");
        f.Capture.EmitArmed(Snapshot("late"));
        Assert(f.Swap.Snapshot is null && f.Deadlines.Count == 0, "late armed cannot republish during teardown");
        f.Capture.EmitDisarmed();
        Assert(f.SuspenderEnabled && f.TrimCalls == 1 && f.Capture.ArmCalls == 1, "cancelled arm stays in mirror after teardown");
    }

    private static void DisarmClearsTheSnapshotBeforeCallingCapture()
    {
        using var f = new Fixture();
        f.Arm();
        f.Events.Clear();
        f.Capture.BeforeDisarm = () =>
        {
            Assert(f.Swap.Snapshot is null && f.Swap.State == "mirror", "descriptor is already cleared inside Disarm");
            Assert(f.Events.SequenceEqual(new[] { "changed:mirror", "disarm" }), "change notification precedes capture teardown");
            Assert(!f.SuspenderEnabled && f.TrimCalls == 0, "suspender and trim wait for disarmed");
        };
        f.Swap.Request("page", false);
        Assert(f.Capture.LingerMs == 1500, "normal teardown keeps the capture's default linger");
        f.Capture.EmitDisarmed();
        Assert(f.Events.TakeLast(3).SequenceEqual(new[] { "suspender:True", "trim", "changed:mirror" }), "disarmed resumes memory saving then requests trim");
        f.Capture.EmitDisarmed();
        Assert(f.TrimCalls == 1, "a duplicate disarmed signal cannot trim again");
    }

    private static void NeverConnectedCaptureGetsNinetySeconds()
    {
        using var f = new Fixture();
        f.Arm();
        Assert(f.Deadlines is [{ Delay: var delay }] && delay == TimeSpan.FromSeconds(90), "armed starts one ninety-second grace for zero clients");
        var reads = f.Capture.ClientReads;
        f.Advance(TimeSpan.FromMilliseconds(89_999));
        Assert(f.Capture.DisarmCalls == 0, "grace does not expire early");
        f.Advance(TimeSpan.FromMilliseconds(1));
        Assert(f.Capture.DisarmReason == "grace" && f.Swap.Snapshot is null, "never-connected capture disarms at grace");
        Assert(f.Capture.ClientReads == reads && f.Capture.StateReads == 0, "deadline does not poll capture state");
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 1 && f.Swap.WantingPages.Length == 0, "grace forgets wanting pages");
    }

    private static void ConnectingCancelsGrace()
    {
        using var f = new Fixture();
        f.Arm();
        f.Capture.EmitClientConnected(1);
        Assert(f.Deadlines[0].Cancelled, "client connection cancels the grace handle");
        f.Advance(TimeSpan.FromMinutes(5));
        Assert(f.Capture.DisarmCalls == 0, "connected stream is not timed out");

        using var alreadyConnected = new Fixture();
        alreadyConnected.Capture.ClientCount = 1;
        alreadyConnected.Arm();
        Assert(alreadyConnected.Deadlines.Count == 0, "armed with clients does not start grace");
    }

    private static void OnlyTheLastClientLeavingStartsGrace()
    {
        using var f = new Fixture();
        f.Capture.ClientCount = 2;
        f.Arm();
        f.Capture.EmitClientLeft(1);
        Assert(f.Deadlines.Count == 0, "non-last client departure does not start grace");
        f.Capture.EmitClientLeft(0);
        Assert(f.Deadlines.Count == 1, "last departure starts a one-shot grace");
        f.Capture.EmitClientConnected(1);
        Assert(f.Deadlines[0].Cancelled, "reconnection cancels departure grace");
        f.Capture.EmitClientLeft(0);
        f.Advance(TimeSpan.FromSeconds(90));
        Assert(f.Capture.DisarmReason == "grace", "a later last departure gets its own grace");
    }

    private static void CancelledDeadlinesCannotDisarmALaterArm()
    {
        using var f = new Fixture();
        f.Arm();
        var stale = f.Deadlines[0];
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        f.Arm();
        stale.Callback();
        Assert(f.Capture.DisarmCalls == 1 && f.Swap.State == "armed", "cancelled callback cannot affect a newer arm");
    }

    private static void ReleaseAndReloadDoNotResetGrace()
    {
        using var f = new Fixture();
        f.Arm();
        f.Advance(TimeSpan.FromSeconds(40));
        f.Swap.Release("page");
        Assert(f.Capture.DisarmCalls == 0, "socket closure alone does not disarm");
        f.Swap.Request("reload", true);
        Assert(f.Deadlines.Count == 1 && f.Capture.ArmCalls == 1, "reload inherits the current arm and deadline");
        f.Advance(TimeSpan.FromSeconds(50));
        Assert(f.Capture.DisarmReason == "grace", "page demand alone does not extend stream-client grace");
    }

    private static void RequestDuringDisarmRearmsAfterTeardown()
    {
        using var f = new Fixture();
        f.Arm();
        f.Swap.Request("page", false);
        f.Swap.Request("reload", true, 2340.0 / 1080);
        Assert(f.Capture.ArmCalls == 1 && f.Swap.Snapshot is null, "request waits while disarming");
        f.Events.Clear();
        f.Capture.EmitDisarmed();
        Assert(f.Events.SequenceEqual(new[] { "suspender:True", "trim", "changed:mirror", "suspender:False", "changed:arming", "arm" }),
            "teardown restores and trims before the next arm resumes visuals");
        Assert(f.Capture.ArmCalls == 2 && f.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:2340x1080", "pending page supplies the next size");
    }

    private static void WithdrawnDemandDuringDisarmDoesNotRearm()
    {
        foreach (var release in new[] { false, true })
        {
            using var f = new Fixture();
            f.Arm();
            f.Swap.Request("page", false);
            f.Swap.Request("reload", true);
            if (release) f.Swap.Release("reload");
            else f.Swap.Request("reload", false);
            f.Capture.EmitDisarmed();
            Assert(f.Capture.ArmCalls == 1 && f.Swap.State == "mirror", "withdrawn pending demand does not rearm");
        }
    }

    private static void StreamEndedFailsWithoutAutomaticRearm()
    {
        using var f = new Fixture();
        f.Arm();
        f.Swap.Request("two", true);
        var reason = new string('x', 100);
        f.Capture.BeforeDisarm = () => Assert(f.Swap.State == "failed" && f.Swap.Reason == reason && f.Swap.Snapshot is null,
            "failure and mirror fallback are published before disarm");
        f.Capture.EmitStreamEnded(reason);
        Assert(f.Capture.DisarmReason == "stream-ended" && f.Deadlines[0].Cancelled, "ended disarms with a bounded reason and cancels grace");
        f.Capture.EmitDisarmed();
        Assert(f.Swap.State == "failed" && f.Swap.Reason == reason && f.Capture.ArmCalls == 1, "failure survives teardown without retry");
    }

    private static void StreamEndedDuringArmingAlsoDisarms()
    {
        using var f = new Fixture();
        f.Swap.Request("page", true);
        f.Capture.EmitStreamEnded("stopped");
        f.Capture.EmitDisarmed();
        Assert(f.Capture.DisarmCalls == 1 && f.Swap.State == "failed" && f.SuspenderEnabled, "stream ended during startup also restores mirror");
    }

    private static void NewDemandDuringFailedTeardownCanRearm()
    {
        using var f = new Fixture();
        f.Arm();
        f.Capture.EmitStreamEnded("stopped");
        f.Swap.Request("retry", true);
        f.Capture.EmitDisarmed();
        Assert(f.Capture.ArmCalls == 2 && f.Swap.State == "arming" && f.Swap.Reason is null, "new explicit demand can retry after failure teardown");
    }

    private static void SecondArmUsesTheNewSignalSnapshot()
    {
        using var f = new Fixture();
        f.Arm();
        var old = f.Swap.Snapshot;
        f.Swap.Request("page", false);
        f.Capture.EmitDisarmed();
        f.Swap.Request("page", true);
        Assert(f.Swap.Snapshot is null, "old descriptor is unavailable during the second arm");
        var current = Snapshot("second");
        f.Capture.EmitArmed(current);
        Assert(f.Swap.Snapshot == current && current.Token != old!.Token && current.CertificateHash != old.CertificateHash,
            "second signal replaces both token and certificate without file reads");
        Assert(f.Capture.Subscriptions == 1, "signals are subscribed once across arms");
    }

    private static void NoCaptureReportsFailureWithoutSideEffects()
    {
        using var f = new Fixture();
        f.Capture.Available = false;
        f.Swap.Request("page", true);
        Assert(f.Swap.State == "failed" && f.Swap.Reason == "no-capture", "missing capture gives a page-visible reason");
        Assert(f.SuspenderEnabled && f.Capture.ArmCalls == 0 && f.Capture.Subscriptions == 0 && f.Deadlines.Count == 0,
            "no capture has no native or timer effects");
        f.Swap.Request("page", false);
        Assert(f.Swap.State == "mirror" && f.Swap.Reason is null, "mirror clears the no-capture failure");
    }

    private static void SingletonDiscoverySubscribesOnlyOnce()
    {
        using var f = new Fixture();
        f.Capture.Available = false;
        f.Swap.Request("page", true);
        f.Capture.Available = true;
        f.Swap.Request("page", true);
        Assert(f.Capture.Subscriptions == 1 && f.Swap.State == "arming", "next message can find the singleton without startup polling");
        f.Capture.EmitArmFailed("failed");
        f.Swap.Request("page", true);
        Assert(f.Capture.Subscriptions == 1, "retry does not subscribe again");
    }

    private static void DisposalCancelsGraceAndSignalSubscriptions()
    {
        using var f = new Fixture();
        f.Arm();
        var signals = f.Capture.Signals!;
        f.Swap.Dispose();
        f.Swap.Dispose();
        Assert(f.Deadlines[0].Cancelled && f.Capture.Unsubscriptions == 1, "disposal cancels the deadline and unsubscribes once");
        var events = f.Events.Count;
        f.Deadlines[0].Callback();
        signals.Armed(Snapshot("late"));
        signals.Disarmed();
        signals.ArmFailed("late");
        signals.StreamEnded("late");
        signals.ClientLeft(1, "late");
        f.Swap.Request("late", true);
        Assert(f.Events.Count == events && f.Capture.DisarmCalls == 0, "late callbacks and requests have no effects");
    }

    private static void QuitStillDisarmsArmingAndArmedCaptures()
    {
        foreach (var armed in new[] { false, true })
        {
            using var f = new Fixture();
            f.Swap.Request("page", true);
            if (armed) f.Capture.EmitArmed(Snapshot("first"));
            var done = 0;
            new RenderStreamCaptureQuit(f.Capture, () => done++, (delay, callback) => f.Schedule(delay, callback)).Run();
            Assert(done == 0 && f.Capture.DisarmReason == "seat-quit" && f.Capture.LingerMs == 0, "quit waits for active capture teardown");
            f.Capture.EmitDisarmed();
            Assert(done == 1 && f.Capture.ArmCalls == 1 && f.Swap.Snapshot is null, "quit completes without the swap controller rearming old demand");
        }
    }

    private static void DisarmRefusalsHandleAlreadyStoppedOrStopping()
    {
        foreach (var result in new[] { 3, 44 })
        {
            using var f = new Fixture();
            f.Arm();
            f.Capture.DisarmResult = result;
            f.Swap.Request("page", false);
            Assert(f.Swap.Snapshot is null && f.Swap.State == "mirror", "refused disarm still clears descriptor");
            Assert(f.SuspenderEnabled == (result == 3), "already stopped restores immediately; already stopping waits");
            if (result == 44) f.Capture.EmitDisarmed();
            Assert(f.SuspenderEnabled && f.TrimCalls == 1, "stopped capture restores memory saving once");
        }
    }

    private static RenderStreamSnapshot Snapshot(string arm) => new(
        "127.0.0.1:19849", $"test-token-{arm}", $"test-certificate-{arm}", "2340x1080", 13);

    private sealed class Fixture : IDisposable
    {
        internal readonly List<string> Events = [];
        internal readonly List<(string State, RenderStreamSnapshot? Snapshot)> Changes = [];
        internal readonly List<Deadline> Deadlines = [];
        internal readonly FakeCapture Capture;
        internal readonly RenderStreamSwap Swap;
        internal bool SuspenderEnabled = true;
        internal int TrimCalls;
        private TimeSpan _now;

        internal Fixture(int maxWidth = 2520)
        {
            Capture = new FakeCapture(Events);
            Swap = new RenderStreamSwap(Capture, Schedule,
                on => { SuspenderEnabled = on; Events.Add($"suspender:{on}"); },
                () => { TrimCalls++; Events.Add("trim"); },
                () => { Events.Add($"changed:{Swap!.State}"); Changes.Add((Swap.State, Swap.Snapshot)); }, maxWidth);
        }

        internal void Arm()
        {
            Swap.Request("page", true);
            Capture.EmitArmed(Snapshot("first"));
        }

        internal IDisposable Schedule(TimeSpan delay, Action callback)
        {
            var deadline = new Deadline(delay, _now + delay, callback);
            Deadlines.Add(deadline);
            return deadline;
        }

        internal void Advance(TimeSpan elapsed)
        {
            _now += elapsed;
            foreach (var deadline in Deadlines.Where(d => !d.Cancelled && !d.Fired && d.At <= _now).ToArray())
            {
                deadline.Fired = true;
                deadline.Callback();
            }
        }

        public void Dispose() => Swap.Dispose();
    }

    private sealed class Deadline(TimeSpan delay, TimeSpan at, Action callback) : IDisposable
    {
        internal TimeSpan Delay => delay;
        internal TimeSpan At => at;
        internal Action Callback => callback;
        internal bool Cancelled;
        internal bool Fired;
        public void Dispose() => Cancelled = true;
    }

    internal sealed class FakeCapture(List<string> events) : IRenderStreamCapture
    {
        internal bool Available = true;
        internal int Discoveries, StateReads, ClientReads, ArmCalls, DisarmCalls, Subscriptions, Unsubscriptions;
        internal int ArmResult, DisarmResult, ClientCount;
        internal string CurrentState = "standby";
        internal string? DisarmReason;
        internal int LingerMs;
        internal Dictionary<string, string>? Options;
        internal Action? BeforeArm, BeforeDisarm;
        internal RenderStreamCaptureSignals? Signals;
        private readonly Dictionary<string, Action> _oneShot = [];

        public bool HasSingleton { get { Discoveries++; return Available; } }
        public int Clients { get { ClientReads++; return ClientCount; } }
        public string State() { StateReads++; return CurrentState; }

        public int Arm(IReadOnlyDictionary<string, string> options)
        {
            Assert(Signals is not null, "persistent signals are subscribed before arm");
            ArmCalls++;
            Options = new(options);
            events.Add("arm");
            BeforeArm?.Invoke();
            if (ArmResult == 0) CurrentState = "arming";
            return ArmResult;
        }

        public int Disarm(string reason, int lingerMs)
        {
            DisarmCalls++;
            DisarmReason = reason;
            LingerMs = lingerMs;
            events.Add("disarm");
            BeforeDisarm?.Invoke();
            if (DisarmResult == 0) CurrentState = "disarming";
            return DisarmResult;
        }

        public IDisposable Subscribe(RenderStreamCaptureSignals signals)
        {
            Assert(Signals is null, "only one persistent subscription is installed");
            Signals = signals;
            Subscriptions++;
            events.Add("subscribe");
            return new Subscription(() => { Signals = null; Unsubscriptions++; });
        }

        public void ConnectOneShot(string signal, Action callback) => _oneShot.Add(signal, callback);
        internal void EmitArmed(RenderStreamSnapshot snapshot) { CurrentState = "armed"; Signals?.Armed(snapshot); }
        internal void EmitArmFailed(string reason) { CurrentState = "standby"; Signals?.ArmFailed(reason); }
        internal void EmitStreamEnded(string reason) { CurrentState = "ended"; Signals?.StreamEnded(reason); }
        internal void EmitClientConnected(int clients) { ClientCount = clients; Signals?.ClientConnected(1); }
        internal void EmitClientLeft(int clients) { ClientCount = clients; Signals?.ClientLeft(1, "closed"); }
        internal void EmitDisarmed()
        {
            CurrentState = "standby";
            Signals?.Disarmed();
            if (_oneShot.Remove("disarmed", out var callback)) callback();
        }

        private sealed class Subscription(Action unsubscribe) : IDisposable
        {
            public void Dispose() => unsubscribe();
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"RenderStreamSwapTests: {message}");
    }
}
