using CouchCoop.Mod.Session;

internal static class RenderStreamCaptureQuitTests
{
    public static void Run()
    {
        NoSingletonCompletesImmediately();
        InactiveCaptureCompletesImmediately();
        DisarmedSignalCompletesAfterDisarm();
        ArmingCaptureAlsoWaitsForDisarm();
        EndedCaptureWaitsForDisarm();
        DisarmingCaptureWaitsForDisarm();
        StreamEndedSignalDoesNotComplete();
        RefusedDisarmCompletesImmediately();
        MissingSignalCompletesAtTheFallbackDeadline();
        SignalsAndFallbackCompleteOnlyOnceInEitherOrder();
        DisarmTimeoutCoversTheCaptureCarrierStop();
        Console.WriteLine("RenderStreamCaptureQuitTests: 11 passed.");
    }

    private static void NoSingletonCompletesImmediately()
    {
        var fixture = new Fixture { Capture = { HasSingleton = false } };
        fixture.Run();
        Assert(fixture.Done == 1, "no singleton completes immediately");
        Assert(fixture.Capture.StateReads == 0, "no singleton is never queried for state");
        Assert(fixture.Capture.DisarmCalls == 0 && fixture.Fallback is null, "no capture work is scheduled");
    }

    private static void InactiveCaptureCompletesImmediately()
    {
        foreach (var state in new[] { "loading", "standby", "refused" })
        {
            var fixture = new Fixture { Capture = { CurrentState = state } };
            fixture.Run();
            Assert(fixture.Done == 1, $"{state} completes immediately");
            Assert(fixture.Capture.DisarmCalls == 0 && fixture.Fallback is null,
                $"{state} does not disarm or schedule a fallback");
            Assert(fixture.Capture.Callbacks.Count == 0, $"{state} does not subscribe to capture signals");
        }
    }

    private static void DisarmedSignalCompletesAfterDisarm()
    {
        var fixture = new Fixture();
        fixture.Run();
        Assert(fixture.Done == 0, "a scheduled disarm keeps the main loop alive");
        Assert(fixture.Capture.DisarmCalls == 1, "armed capture receives one disarm");
        Assert(fixture.Capture.Reason == "seat-quit" && fixture.Capture.LingerMs == 0,
            "seat shutdown disarms without lingering for the departed host");
        fixture.Capture.Emit("disarmed");
        Assert(fixture.Done == 1, "disarmed completes after capture teardown");
    }

    private static void ArmingCaptureAlsoWaitsForDisarm()
    {
        var fixture = new Fixture { Capture = { CurrentState = "arming" } };
        fixture.Run();
        Assert(fixture.Done == 0 && fixture.Capture.DisarmCalls == 1, "arming capture is also disarmed");
        fixture.Capture.Emit("disarmed");
        Assert(fixture.Done == 1, "arming capture completes when disarmed");
    }

    private static void EndedCaptureWaitsForDisarm()
    {
        var fixture = new Fixture { Capture = { CurrentState = "ended" } };
        fixture.Run();
        Assert(fixture.Done == 0 && fixture.Capture.DisarmCalls == 1, "ended capture still needs disarming");
        Assert(fixture.Capture.Reason == "seat-quit" && fixture.Capture.LingerMs == 0,
            "ended capture disarms without lingering");
        fixture.Capture.Emit("disarmed");
        Assert(fixture.Done == 1, "ended capture completes only after disarm completes");
    }

    private static void DisarmingCaptureWaitsForDisarm()
    {
        var fixture = new Fixture { Capture = { CurrentState = "disarming" } };
        fixture.Run();
        Assert(fixture.Done == 0 && fixture.Capture.DisarmCalls == 0,
            "disarming capture waits without requesting another disarm");
        fixture.Capture.Emit("disarmed");
        Assert(fixture.Done == 1, "disarming capture completes after the existing disarm completes");
    }

    private static void StreamEndedSignalDoesNotComplete()
    {
        var fixture = new Fixture();
        fixture.Run();
        Assert(fixture.Done == 0, "armed capture waits for a completion signal");
        Assert(!fixture.Capture.Callbacks.ContainsKey("stream_ended"), "stream_ended is not a completion signal");
        fixture.Capture.Emit("stream_ended");
        fixture.Advance(TimeSpan.FromMilliseconds(4499));
        Assert(fixture.Done == 0, "stream_ended alone does not complete before the fallback");
        fixture.Advance(TimeSpan.FromMilliseconds(1));
        Assert(fixture.Done == 1, "only the fallback completes when stream_ended is the sole signal");
    }

    private static void RefusedDisarmCompletesImmediately()
    {
        var fixture = new Fixture { Capture = { DisarmResult = 1 } };
        fixture.Run();
        Assert(fixture.Done == 1 && fixture.Capture.DisarmCalls == 1, "a refused disarm completes immediately");
        fixture.Advance(TimeSpan.FromSeconds(4.5));
        fixture.Capture.Emit("disarmed");
        Assert(fixture.Done == 1, "a refusal's pending callbacks cannot complete twice");
    }

    private static void MissingSignalCompletesAtTheFallbackDeadline()
    {
        foreach (var state in new[] { "arming", "armed", "ended", "disarming" })
        {
            var fixture = new Fixture { Capture = { CurrentState = state } };
            fixture.Run();
            Assert(fixture.Capture.DisarmCalls == (state == "disarming" ? 0 : 1),
                $"{state} requests disarm only when needed");
            Assert(fixture.Delay == TimeSpan.FromSeconds(4.5), $"{state} fallback is bounded to 4.5 seconds");
            fixture.Advance(TimeSpan.FromMilliseconds(4499));
            Assert(fixture.Done == 0, $"{state} fallback does not complete early");
            fixture.Advance(TimeSpan.FromMilliseconds(1));
            Assert(fixture.Done == 1, $"{state} completes at the fallback deadline without a signal");
        }
    }

    private static void SignalsAndFallbackCompleteOnlyOnceInEitherOrder()
    {
        foreach (var state in new[] { "arming", "armed", "ended", "disarming" })
        foreach (var first in new[] { "disarmed", "fallback" })
        {
            var fixture = new Fixture { Capture = { CurrentState = state } };
            fixture.Run();
            fixture.Capture.Emit("stream_ended");
            Assert(fixture.Done == 0, $"{state} does not complete on stream_ended");
            if (first == "fallback") fixture.Advance(TimeSpan.FromSeconds(4.5));
            else fixture.Capture.Emit(first);
            Assert(fixture.Done == 1, $"{state}: {first} requests the first complete");
            fixture.Capture.Emit("disarmed");
            fixture.Capture.Emit("stream_ended");
            fixture.Advance(TimeSpan.FromSeconds(4.5));
            Assert(fixture.Done == 1, $"{state}: {first} wins and all later callbacks are harmless");
        }
    }

    private static void DisarmTimeoutCoversTheCaptureCarrierStop()
    {
        Assert(RenderStreamCaptureQuit.DisarmTimeout >= TimeSpan.FromSeconds(3.9),
            "disarm covers sequential websocket flush (2 s), WebTransport stop (1.75 s) and release");
    }

    private sealed class Fixture
    {
        internal FakeCapture Capture { get; } = new();
        internal int Done;
        internal TimeSpan Delay;
        internal Action? Fallback;
        private TimeSpan _elapsed;

        internal void Run() => new RenderStreamCaptureQuit(
            Capture, () => Done++, (delay, callback) => { Delay = delay; Fallback = callback; }).Run();

        internal void Advance(TimeSpan elapsed)
        {
            _elapsed += elapsed;
            if (_elapsed < Delay) return;
            var callback = Fallback;
            Fallback = null;
            callback?.Invoke();
        }
    }

    private sealed class FakeCapture : IRenderStreamCapture
    {
        public bool HasSingleton { get; set; } = true;
        internal string CurrentState = "armed";
        internal int StateReads;
        internal int DisarmCalls;
        internal int DisarmResult;
        internal string? Reason;
        internal int? LingerMs;
        internal Dictionary<string, Action> Callbacks { get; } = new();

        public string State()
        {
            StateReads++;
            Assert(HasSingleton, "state requires a singleton");
            return CurrentState;
        }

        public int Disarm(string reason, int lingerMs)
        {
            Assert(Callbacks.ContainsKey("disarmed"), "disarmed is connected before scheduling disarm");
            DisarmCalls++;
            Reason = reason;
            LingerMs = lingerMs;
            return DisarmResult;
        }

        public void ConnectOneShot(string signal, Action callback) => Callbacks.Add(signal, callback);

        internal void Emit(string signal)
        {
            if (Callbacks.Remove(signal, out var callback)) callback();
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"RenderStreamCaptureQuitTests: {message}");
    }
}
