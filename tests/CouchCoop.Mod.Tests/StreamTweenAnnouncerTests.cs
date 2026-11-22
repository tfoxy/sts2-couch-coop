using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Tests;

internal static class StreamTweenAnnouncerTests
{
    internal static void Run()
    {
        GatingHasZeroCaptureWork();
        AnyPageGating();
        DictionaryShapeAndExplicitFrom();
        CancelMapsOnlyAnnouncedIds();
        UnsupportedPropertiesAreCounted();
        RelativeAndLoopsAreFiltered();
        LastOptOutCancelsAndUnsubscribes();
        DisarmCleansUpAndLogsOnce();
        PropertyAllowlist();
        Console.WriteLine("stream tweens: ok (9 cases)");
    }

    private static TweenSchedule Schedule(long id = 9007199254740993, string property = "position:x",
        IReadOnlyList<double>? from = null, bool relative = false, int loops = 1)
        => new(id, 42, 123456789, true, loops,
            [new(property, [50], from, 125, 300, 7, 2, relative)]);

    private static void GatingHasZeroCaptureWork()
    {
        foreach (var armed in new[] { false, true })
        foreach (var desired in new[] { false, true })
        {
            var f = new Fixture();
            f.Announcer.UpdateArmed(armed);
            f.Announcer.UpdateDesired(desired);
            Assert(f.Source.Subscriptions == (armed && desired ? 1 : 0), "subscribe iff armed × desired");
            f.Source.Emit(Schedule());
            Assert(f.Capture.Begins.Count == (armed && desired ? 1 : 0), "no dictionary or capture calls while off");
            Assert(f.Capture.Cancels.Count == 0, "no cancellation work while off");
        }
    }

    private static void AnyPageGating()
    {
        foreach (var armed in new[] { false, true })
        foreach (var pages in new bool[][] { [], [false], [true], [false, true], [true, false], [false, false] })
            Assert(CouchCoopBrowserServer.ComputeStreamTweenDesired(armed, pages) == (armed && pages.Contains(true)),
                "any interested stream page suffices");
    }

    private static void DictionaryShapeAndExplicitFrom()
    {
        var f = Active();
        f.Source.Emit(Schedule(from: [2]));
        var begin = f.Capture.Begins.Single();
        Keys(begin, "tween_id", "object_id", "started_usec", "steps");
        Assert(begin["tween_id"] is long id && id == 9007199254740993, "full signed int64 id");
        Assert(begin["object_id"] is ulong target && target == 42, "target ObjectID");
        Assert(begin["started_usec"] is ulong time && time == 123456789, "creation timestamp forwarded unchanged");
        var step = Steps(begin).Single();
        Keys(step, "property", "to", "from", "start_ms", "duration_ms", "trans", "ease");
        Assert((string)step["property"] == "position:x", "exact property spelling");
        Assert(((IReadOnlyList<double>)step["to"]).SequenceEqual([50d]), "absolute to");
        Assert(((IReadOnlyList<double>)step["from"]).SequenceEqual([2d]), "explicit from");
        Assert((double)step["start_ms"] == 125 && (double)step["duration_ms"] == 300, "flattened timing");
        Assert((int)step["trans"] == 7 && (int)step["ease"] == 2, "Godot enums");
        f.Source.Emit(Schedule(id: long.MinValue));
        begin = f.Capture.Begins.Last();
        Assert((long)begin["tween_id"] == long.MinValue, "negative int64 id preserved");
        Keys(Steps(begin).Single(), "property", "to", "start_ms", "duration_ms", "trans", "ease");
    }

    private static void CancelMapsOnlyAnnouncedIds()
    {
        var f = Active();
        f.Source.Emit(Schedule());
        f.Source.Cancel(123);
        f.Source.Cancel(9007199254740993);
        f.Source.Cancel(9007199254740993);
        Assert(f.Capture.Cancels.SequenceEqual([9007199254740993L]), "only one cancel for announced id");
        f.Source.Emit(Schedule());
        f.Source.Cancel(9007199254740993);
        Assert(f.Capture.Cancels.Count == 2, "id can be reused after cancellation");
    }

    private static void UnsupportedPropertiesAreCounted()
    {
        var f = Active();
        f.Source.Emit(Schedule(property: "size"));
        f.Source.Cancel(9007199254740993);
        Assert(f.Capture.Begins.Count == 0 && f.Capture.Cancels.Count == 0, "unsupported-only schedules build no capture dictionary");
        var supported = Schedule(id: 2);
        f.Source.Emit(supported with { Steps = [Schedule(property: "size").Steps[0], supported.Steps[0]] });
        Assert(Steps(f.Capture.Begins.Single()).Count == 1, "mixed schedule preserves supported steps");
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Single().Contains("unsupported=size:2"), "unsupported counts by exact property");
    }

    private static void RelativeAndLoopsAreFiltered()
    {
        var f = Active();
        f.Source.Emit(Schedule(relative: true));
        f.Source.Emit(Schedule(loops: 0));
        f.Source.Emit(Schedule(loops: 2));
        f.Source.Emit(Schedule(loops: -1));
        Assert(f.Capture.Begins.Count == 0, "relative and looping schedules rejected");
        f.Source.Emit(Schedule(loops: 1));
        Assert(f.Capture.Begins.Count == 1, "a single run is announced");
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Single().Contains("relative=1 loops=3"), "rejection counters logged");
    }

    private static void LastOptOutCancelsAndUnsubscribes()
    {
        var f = Active();
        f.Source.Emit(Schedule());
        f.Announcer.UpdateDesired(false);
        Assert(!f.Source.Active && f.Source.Disposals == 1, "last opt-out unsubscribes producer");
        Assert(f.Capture.Cancels.Count == 1, "last opt-out releases claims");
        f.Source.Emit(Schedule(id: 4));
        f.Source.Cancel(4);
        Assert(f.Capture.Begins.Count == 1 && f.Capture.Cancels.Count == 1, "late callbacks have no work");
        f.Announcer.UpdateDesired(true);
        Assert(f.Source.Active && f.Source.Subscriptions == 2, "opt-in resumes event-driven capture");
    }

    private static void DisarmCleansUpAndLogsOnce()
    {
        var f = Active();
        f.Source.Emit(Schedule());
        f.Announcer.UpdateArmed(false);
        f.Announcer.UpdateArmed(false);
        Assert(!f.Source.Active && f.Source.Disposals == 1 && f.Logs.Count == 1, "disarm unsubscribes and logs once");
        Assert(f.Capture.Cancels.Count == 0, "disarmed capture already cleared its state");
        f.Announcer.UpdateArmed(true);
        f.Source.Cancel(9007199254740993);
        Assert(f.Capture.Cancels.Count == 0, "previous arm ids cleared");
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Last().Contains("begins=0 steps=0 cancels=0 relative=0 loops=0 unsupported="), "per-arm counters reset");
    }

    private static void PropertyAllowlist()
    {
        foreach (var property in new[] { "position", "position:x", "position:y", "scale", "scale:x", "scale:y",
            "rotation", "modulate", "modulate:r", "modulate:g", "modulate:b", "modulate:a",
            "self_modulate", "self_modulate:r", "self_modulate:g", "self_modulate:b", "self_modulate:a" })
            Assert(CouchCoopStreamTweenAnnouncer.Supported(property, false), $"supported {property}");
        Assert(CouchCoopStreamTweenAnnouncer.Supported("skew", true), "Node2D skew supported");
        Assert(!CouchCoopStreamTweenAnnouncer.Supported("skew", false), "Control skew unsupported");
        foreach (var property in new[] { "global_position", "position:z", "rotation:x", "modulate:x", "position.x", "Position", "" })
            Assert(!CouchCoopStreamTweenAnnouncer.Supported(property, true), $"unsupported {property}");
    }

    private static Fixture Active()
    {
        var f = new Fixture();
        f.Announcer.UpdateDesired(true);
        f.Announcer.UpdateArmed(true);
        return f;
    }

    private static IReadOnlyList<IReadOnlyDictionary<string, object>> Steps(IReadOnlyDictionary<string, object> begin)
        => (IReadOnlyList<IReadOnlyDictionary<string, object>>)begin["steps"];
    private static void Keys(IReadOnlyDictionary<string, object> value, params string[] expected)
        => Assert(value.Keys.Order().SequenceEqual(expected.Order()), "exact dictionary keys");
    private static void Assert(bool value, string message)
    {
        if (!value) throw new InvalidOperationException($"StreamTweenAnnouncerTests: {message}");
    }

    private sealed class Fixture
    {
        internal readonly Source Source = new();
        internal readonly Capture Capture = new();
        internal readonly List<string> Logs = [];
        internal readonly CouchCoopStreamTweenAnnouncer Announcer;
        internal Fixture() => Announcer = new(Source.Subscribe, Capture, Logs.Add);
    }

    private sealed class Source
    {
        internal int Subscriptions, Disposals;
        internal bool Active;
        private Action<TweenSchedule>? _begin;
        private Action<long>? _cancel;
        internal IDisposable Subscribe(Action<TweenSchedule> begin, Action<long> cancel)
        {
            Subscriptions++;
            Active = true;
            (_begin, _cancel) = (begin, cancel);
            return new Subscription(() => { Active = false; Disposals++; });
        }
        internal void Emit(TweenSchedule schedule) => _begin?.Invoke(schedule);
        internal void Cancel(long id) => _cancel?.Invoke(id);
        private sealed class Subscription(Action dispose) : IDisposable { public void Dispose() => dispose(); }
    }

    private sealed class Capture : IRenderStreamTweenCapture
    {
        internal readonly List<IReadOnlyDictionary<string, object>> Begins = [];
        internal readonly List<long> Cancels = [];
        public void TweenBegin(IReadOnlyDictionary<string, object> schedule) => Begins.Add(schedule);
        public void TweenCancel(long tweenId) => Cancels.Add(tweenId);
    }
}
