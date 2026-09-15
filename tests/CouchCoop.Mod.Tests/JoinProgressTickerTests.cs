using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Server;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Tests;

// The join-progress stream: what the browser is shown while a join is still being resolved.
//
// The defect it answers (measured live 2026-09-15): for the whole 75s seat-spawn deadline the phone showed a bare
// "Joining…" spinner — and a SUCCESSFUL join showed the identical screen for its first 10-15s. A legitimate cold
// spawn takes 20-60s, so "slow" and "dead" were indistinguishable and players closed the tab.
//
// Three properties are asserted here because a join depends on all three: the ticker REPORTS the registry rather
// than keeping a model of its own, it sends only when something the viewer reads has changed, and it is dead —
// awaited, not merely signalled — before the join's own terminal reply goes out.
internal static class JoinProgressTickerTests
{
    public static async Task RunAsync()
    {
        await EmitsOnChangeAndCoalescesRepeatsAsync();
        await StopsWhenTheAttemptResolvesAsync();
        await ASendFailureNeverFaultsTheJoinAsync();
    }

    private static async Task EmitsOnChangeAndCoalescesRepeatsAsync()
    {
        var time = new FakeTime();
        var registry = new ConnectionRegistry(time);
        var delay = new ControlledDelay();
        var sent = new SentEnvelopes();
        var session = Guid.NewGuid();
        registry.Connected(session, "phone");
        registry.BeginAttempt(session);

        var ticker = JoinProgressTicker.Start(registry, session, "join:1", sent.Record, CancellationToken.None,
            TimeSpan.FromSeconds(1), delay.Delay);

        // The FIRST tick reports immediately — the viewer must not wait a second for the first word, and the
        // whole point is that "Joining…" alone says nothing.
        Assert(delay.WaitForPending(1), "the ticker reaches its first wait");
        Assert(sent.Count == 1, "the first tick reports at once");
        // Exact bytes, because this envelope IS the contract the frontend parses (browserEnvelope.ts).
        Assert(sent.Json(0) == "{\"type\":\"join-progress\",\"requestId\":\"join:1\",\"stage\":\"choosing\",\"step\":2,\"stepTotal\":6,\"elapsedMs\":0}",
            $"the wire shape is the one the browser parses (was: {sent.Json(0)})");

        // Nothing moved — no clock, no stage — so nothing is sent. A join that sits in one stage for 40 seconds
        // must cost one message, not forty.
        delay.ReleaseNext();
        Assert(delay.WaitForPending(2), "the ticker ticks again");
        Assert(sent.Count == 1, "an unchanged tick sends nothing");

        // A second passed: the elapsed line the viewer reads has changed, so it is re-sent.
        time.Advance(1_000);
        delay.ReleaseNext();
        Assert(delay.WaitForPending(3), "the ticker ticks after the clock moves");
        Assert(sent.Count == 2, "a new elapsed second is reported");
        Assert(sent.At(1).ElapsedMs == 1_000, "elapsed comes from the registry's own measurement");
        Assert(sent.At(1).Stage == BrowserJoinProgressStages.Choosing, "the stage is unchanged");

        // A stage change is reported even inside the same second — it is the most informative thing that can
        // happen here, and the elapsed rounding must never delay it.
        time.Advance(300);
        registry.Advance(session, ConnectionStage.Initializing);
        delay.ReleaseNext();
        Assert(delay.WaitForPending(4), "the ticker ticks after the stage moves");
        Assert(sent.Count == 3, "a stage change is reported");
        Assert(sent.At(2).Stage == BrowserJoinProgressStages.Initializing, "…as the seat-spawn stage");
        Assert(sent.At(2).Step == 3 && sent.At(2).StepTotal == 6, "…carrying the registry's step of total");
        Assert(sent.At(2).ElapsedMs == 1_300, "…and the exact elapsed millisecond count");

        // Sub-second movement inside the same stage stays quiet (1300ms and 1800ms are both "1 second").
        time.Advance(500);
        delay.ReleaseNext();
        Assert(delay.WaitForPending(5), "the ticker ticks again");
        Assert(sent.Count == 3, "sub-second movement inside one stage sends nothing");

        await ticker.StopAsync();
    }

    private static async Task StopsWhenTheAttemptResolvesAsync()
    {
        var time = new FakeTime();
        var registry = new ConnectionRegistry(time);
        var delay = new ControlledDelay();
        var sent = new SentEnvelopes();
        var session = Guid.NewGuid();
        registry.Connected(session, "phone");
        registry.BeginAttempt(session);

        var ticker = JoinProgressTicker.Start(registry, session, "join:7", sent.Record, CancellationToken.None,
            TimeSpan.FromSeconds(1), delay.Delay);
        Assert(delay.WaitForPending(1), "the ticker starts");
        Assert(sent.Count == 1, "the first tick reports");

        // The join resolved. StopAsync AWAITS the loop, so by the time it returns no further envelope can be
        // produced — that ordering is what keeps "still starting" from landing after the terminal reply.
        await ticker.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));

        // Everything that would have produced a message had the ticker survived.
        time.Advance(5_000);
        registry.Advance(session, ConnectionStage.LoadingView);
        registry.Fail(session, "spawn-failed", "no", "retry");
        delay.ReleaseNext();
        await Task.Delay(50);
        Assert(sent.Count == 1, "a stopped ticker never reports again");

        // Idempotent: teardown paths call it from a finally, and one of them may already have run.
        await ticker.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static async Task ASendFailureNeverFaultsTheJoinAsync()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var delay = new ControlledDelay();
        var session = Guid.NewGuid();
        registry.Connected(session, "phone");
        registry.BeginAttempt(session);

        // A closing socket throws out of the send. A diagnostic that can fail the thing it describes is worse
        // than no diagnostic, so the loop swallows it and ends.
        var ticker = JoinProgressTicker.Start(registry, session, "join:9",
            _ => throw new InvalidOperationException("socket closed"), CancellationToken.None,
            TimeSpan.FromSeconds(1), delay.Delay);

        await ticker.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));

        // …and the connection's own cancellation ends it too, with no pending-wait leak.
        using var connection = new CancellationTokenSource();
        var sent = new SentEnvelopes();
        var second = JoinProgressTicker.Start(registry, session, "join:10", sent.Record, connection.Token,
            TimeSpan.FromSeconds(1), delay.Delay);
        Assert(delay.WaitForPending(1), "the second ticker starts");
        await connection.CancelAsync();
        await second.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
    }

    private sealed class SentEnvelopes
    {
        private readonly object _gate = new();
        private readonly List<BrowserJoinProgressEnvelope> _sent = [];

        public Task Record(BrowserJoinProgressEnvelope envelope)
        {
            lock (_gate) _sent.Add(envelope);
            return Task.CompletedTask;
        }

        public int Count { get { lock (_gate) return _sent.Count; } }
        public BrowserJoinProgressEnvelope At(int index) { lock (_gate) return _sent[index]; }
        // Serialized the way the connection really serializes it (BrowserJson: web camelCase, nulls omitted).
        public string Json(int index) => BrowserJson.Serialize(At(index));
    }

    private static void Assert(bool value, string message)
    {
        if (!value) throw new Exception("[JoinProgressTickerTests] " + message);
    }

    private sealed class FakeTime : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Volatile.Read(ref _timestamp);
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddMilliseconds(Volatile.Read(ref _timestamp));
        public void Advance(long milliseconds) => Volatile.Write(ref _timestamp, Volatile.Read(ref _timestamp) + milliseconds);
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

        public bool WaitForPending(int count) =>
            SpinWait.SpinUntil(() => Volatile.Read(ref _scheduled) >= count, TimeSpan.FromSeconds(5));

        public void ReleaseNext()
        {
            TaskCompletionSource? completion = null;
            lock (_gate) _pending.TryDequeue(out completion);
            completion?.TrySetResult();
        }
    }
}
