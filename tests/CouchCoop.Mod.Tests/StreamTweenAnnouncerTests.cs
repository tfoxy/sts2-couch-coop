using Godot;
using System.Text.Json;
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
        FinishedRetiresWithoutCancel();
        OtherEndsCancel();
        UnknownEndsAreSilent();
        EndCounters();
        UnsupportedPropertiesAreCounted();
        HostOnlyPropertiesAreCountedSeparately();
        RelativeAndLoopsAreFiltered();
        LastOptOutCancelsAndUnsubscribes();
        DisarmCleansUpAndLogsOnce();
        PropertyAllowlist();
        EndpointKinds();
        ShaderParameterAllowlist();
        DirectMaterialSchedule();
        NodeMaterialSplitsAndEnds();
        MaterialOnlyEndsAndOptOut();
        MissingMaterialIsUnsupported();
        CaptureCountersLoggedOnce();
        MissingCaptureCountersAreUnavailable();
        FailedCaptureCountersAreUnavailable();
        Console.WriteLine("stream tweens: ok (22 cases)");
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
        Assert(((RenderStreamTweenEndpoint)step["to"]).Components.SequenceEqual([50d]), "absolute to");
        Assert(((RenderStreamTweenEndpoint)step["from"]).Components.SequenceEqual([2d]), "explicit from");
        Assert((double)step["start_ms"] == 125 && (double)step["duration_ms"] == 300, "flattened timing");
        Assert((int)step["trans"] == 7 && (int)step["ease"] == 2, "Godot enums");
        f.Source.Emit(Schedule(id: long.MinValue));
        begin = f.Capture.Begins.Last();
        Assert((long)begin["tween_id"] == long.MinValue, "negative int64 id preserved");
        Keys(Steps(begin).Single(), "property", "to", "start_ms", "duration_ms", "trans", "ease");
    }

    private static void FinishedRetiresWithoutCancel()
    {
        var f = Active();
        f.Source.Emit(Schedule());
        f.Source.End(9007199254740993, TweenEndReason.Finished);
        f.Source.End(9007199254740993, TweenEndReason.Killed);
        f.Announcer.UpdateDesired(false);
        Assert(f.Capture.Cancels.Count == 0, "finished id retires without cancelling a lagging client");
        f.Announcer.UpdateDesired(true);
        f.Source.Emit(Schedule());
        f.Source.End(9007199254740993, TweenEndReason.Killed);
        Assert(f.Capture.Cancels.SequenceEqual([9007199254740993L]), "id can be reused after finishing");
    }

    private static void OtherEndsCancel()
    {
        foreach (var reason in new[] { TweenEndReason.Killed, TweenEndReason.Stopped,
            TweenEndReason.Paused, TweenEndReason.Retimed })
        {
            var f = Active();
            f.Source.Emit(Schedule());
            f.Source.End(9007199254740993, reason);
            f.Source.End(9007199254740993, reason);
            Assert(f.Capture.Cancels.SequenceEqual([9007199254740993L]), $"{reason} cancels exactly once");
            f.Source.Emit(Schedule());
            f.Source.End(9007199254740993, reason);
            Assert(f.Capture.Cancels.Count == 2, $"id can be reused after {reason}");
            f.Announcer.UpdateDesired(false);
            Assert(f.Capture.Cancels.Count == 2, $"{reason} retired the id before opt-out");
        }
    }

    private static void UnknownEndsAreSilent()
    {
        var f = Active();
        foreach (var reason in Enum.GetValues<TweenEndReason>()) f.Source.End(123, reason);
        f.Announcer.UpdateArmed(false);
        Assert(f.Capture.Cancels.Count == 0, "unknown ends never reach capture");
        Assert(f.Logs.Single().Contains("cancels=0 finished=0 retimed=0"), "unknown ends do not count");
    }

    private static void EndCounters()
    {
        var f = Active();
        foreach (var reason in Enum.GetValues<TweenEndReason>())
        {
            f.Source.Emit(Schedule(id: (long)reason));
            f.Source.End((long)reason, reason);
        }
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Single().Contains("begins=5 steps=5 cancels=4 finished=1 retimed=1"), "end reasons counted");
        f.Announcer.UpdateArmed(true);
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Last().Contains("cancels=0 finished=0 retimed=0"), "end counters reset per arm");
    }

    private static void UnsupportedPropertiesAreCounted()
    {
        var f = Active();
        f.Source.Emit(Schedule(property: "size"));
        f.Source.End(9007199254740993, TweenEndReason.Killed);
        Assert(f.Capture.Begins.Count == 0 && f.Capture.Cancels.Count == 0, "unsupported-only schedules build no capture dictionary");
        var supported = Schedule(id: 2);
        f.Source.Emit(supported with { Steps = [Schedule(property: "size").Steps[0], supported.Steps[0]] });
        Assert(Steps(f.Capture.Begins.Single()).Count == 1, "mixed schedule preserves supported steps");
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Single().Contains("unsupported=size:2"), "unsupported counts by exact property");
    }

    private static void HostOnlyPropertiesAreCountedSeparately()
    {
        var f = Active();
        foreach (var property in new[] { "amount", "offset_left", "offset_right", "offset_custom", "amount" })
            f.Source.Emit(Schedule(property: property));
        f.Source.End(9007199254740993, TweenEndReason.Killed);
        Assert(f.Capture.Begins.Count == 0 && f.Capture.Cancels.Count == 0, "host-only schedules never reach capture");
        var supported = Schedule(id: 2);
        f.Source.Emit(supported with { Steps = [Schedule(property: "amount").Steps[0],
            Schedule(property: "unknown").Steps[0], supported.Steps[0]] });
        Assert(Steps(f.Capture.Begins.Single()).Count == 1, "mixed schedule preserves only supported steps");
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Single().Contains("unsupported=unknown:1 host_only=amount:3,offset_custom:1,offset_left:1,offset_right:1"),
            "host-only and unsupported counts stay separate");
        f.Announcer.UpdateArmed(true);
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Last().Contains("unsupported= host_only="), "property counters reset per arm");
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
        f.Source.End(4, TweenEndReason.Killed);
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
        f.Source.End(9007199254740993, TweenEndReason.Killed);
        Assert(f.Capture.Cancels.Count == 0, "previous arm ids cleared");
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Last().Contains("begins=0 steps=0 cancels=0 finished=0 retimed=0 relative=0 loops=0 unsupported= host_only="), "per-arm counters reset");
    }

    private static void PropertyAllowlist()
    {
        foreach (var property in new[] { "position", "position:x", "position:y", "scale", "scale:x", "scale:y",
            "global_position", "global_position:x", "global_position:y", "rotation", "rotation_degrees", "modulate", "modulate:r", "modulate:g", "modulate:b", "modulate:a",
            "self_modulate", "self_modulate:r", "self_modulate:g", "self_modulate:b", "self_modulate:a" })
        foreach (var node2D in new[] { false, true })
            Assert(CouchCoopStreamTweenAnnouncer.Supported(property, node2D), $"supported {property}, Node2D={node2D}");
        Assert(CouchCoopStreamTweenAnnouncer.Supported("skew", true), "Node2D skew supported");
        Assert(!CouchCoopStreamTweenAnnouncer.Supported("skew", false), "Control skew unsupported");
        foreach (var property in new[] { "amount", "offset_left", "offset_custom", "global_position:z", "position:z", "rotation:x", "modulate:x", "position.x", "Position", "" })
            Assert(!CouchCoopStreamTweenAnnouncer.Supported(property, true), $"unsupported {property}");
    }

    private static void EndpointKinds()
    {
        (TweenValueKind Kind, double[] Components, object Expected)[] cases =
        [
            (TweenValueKind.Float, [0.5], 0.5d),
            (TweenValueKind.Int, [1], 1d),
            (TweenValueKind.Vector2, [1, 2], new Vector2(1, 2)),
            (TweenValueKind.Vector3, [1, 2, 3], new Vector3(1, 2, 3)),
            (TweenValueKind.Vector4, [1, 2, 3, 4], new Vector4(1, 2, 3, 4)),
            (TweenValueKind.Color, [1, 2, 3, 4], new Color(1, 2, 3, 4)),
            (TweenValueKind.Unknown, [1], 1d),
            (TweenValueKind.Unknown, [1, 2], new Vector2(1, 2)),
            (TweenValueKind.Unknown, [1, 2, 3, 4], new Color(1, 2, 3, 4))
        ];
        foreach (var (kind, components, expected) in cases)
        {
            var f = Active();
            var step = Schedule(property: "shader_parameter/value").Steps[0] with
                { Kind = kind, To = components, From = components };
            f.Source.Emit(Schedule() with { Steps = [step] });
            foreach (var key in new[] { "to", "from" })
            {
                var endpoint = (RenderStreamTweenEndpoint)Steps(f.Capture.Begins.Single()).Single()[key];
                Assert(endpoint.Kind == kind, $"{key} carries {kind}");
                var value = GodotRenderStreamCapture.EndpointValue(endpoint);
                Assert(value?.GetType() == expected.GetType() && expected.Equals(value), $"{key} maps {kind} exactly");
            }
        }
        Assert(GodotRenderStreamCapture.EndpointValue(new(TweenValueKind.Unknown, [1, 2, 3])) is null,
            "unknown arity retains nil fallback");
    }

    private static void ShaderParameterAllowlist()
    {
        foreach (var prefix in new[] { "shader_parameter/", "material:shader_parameter/" })
        foreach (var name in new[] { "threshold", "_Color2" })
        foreach (var component in new[] { "", ":x", ":y", ":z", ":w", ":r", ":g", ":b", ":a" })
        foreach (var node2D in new[] { false, true })
            Assert(CouchCoopStreamTweenAnnouncer.Supported(prefix + name + component, node2D),
                $"shader parameter {prefix + name + component}");
        foreach (var property in new[] { "shader_parameter/", "shader_parameter/1bad", "shader_parameter/a/b",
            "shader_parameter/a:q", "shader_parameter/a:xx", "shader_parameter/a:x:y", "shader_parameter/a:",
            "shader_parameter/a[0]", "shader_parameter/é", "material:position", "material:material:shader_parameter/a",
            "instance_shader_parameter/a", "Shader_parameter/a" })
            Assert(!CouchCoopStreamTweenAnnouncer.Supported(property, true), $"invalid shader parameter {property}");
    }

    private static void DirectMaterialSchedule()
    {
        var f = Active();
        f.Source.Emit(Schedule(property: "shader_parameter/threshold"));
        var begin = f.Capture.Begins.Single();
        Assert((ulong)begin["object_id"] == 42 && (long)begin["tween_id"] == 9007199254740993,
            "direct material target and id preserved");
        Assert((string)Steps(begin).Single()["property"] == "shader_parameter/threshold", "direct property unchanged");
        Assert(f.Resolutions == 0, "direct material schedules need no node lookup");
    }

    private static void NodeMaterialSplitsAndEnds()
    {
        foreach (var reason in Enum.GetValues<TweenEndReason>())
        {
            var f = Active();
            f.MaterialId = 84;
            var schedule = Schedule(id: 17);
            f.Source.Emit(schedule with { Steps = [schedule.Steps[0],
                Schedule(property: "material:shader_parameter/threshold").Steps[0],
                Schedule(property: "material:shader_parameter/tint:a").Steps[0]] });
            Assert(f.Capture.Begins.Count == 2, "node and material announce separately");
            var node = f.Capture.Begins[0];
            var material = f.Capture.Begins[1];
            Assert((long)node["tween_id"] == 17 && (ulong)node["object_id"] == 42, "node id and target preserved");
            Assert((long)material["tween_id"] == -17 && (ulong)material["object_id"] == 84, "derived id and material target");
            Assert((ulong)material["started_usec"] == schedule.StartedUsec, "split preserves creation time");
            Assert(Steps(node).Count == 1 && Steps(material).Count == 2, "steps grouped by target");
            Assert(Steps(material).Select(step => (string)step["property"])
                .SequenceEqual(["shader_parameter/threshold", "shader_parameter/tint:a"]), "node paths rewritten");
            Assert(f.Resolutions == 1 && f.ResolvedObject == 42, "resolve the material once at begin");
            f.Source.Emit(Schedule(id: 18));
            f.Source.End(17, reason);
            f.Source.End(17, reason);
            Assert(f.Capture.Cancels.SequenceEqual(reason == TweenEndReason.Finished ? [] : new long[] { 17, -17 }),
                $"{reason} reaches both split ids exactly once");
            f.Announcer.UpdateDesired(false);
            Assert(f.Capture.Cancels.Last() == 18, "another producer id remains independent");
            Assert(f.Capture.Cancels.Count == (reason == TweenEndReason.Finished ? 1 : 3), "both split ids retired");
        }
    }

    private static void MaterialOnlyEndsAndOptOut()
    {
        var f = Active();
        f.MaterialId = 84;
        f.Source.Emit(Schedule(id: 17, property: "material:shader_parameter/value"));
        Assert((long)f.Capture.Begins.Single()["tween_id"] == -17, "material-only node schedule uses derived id");
        f.Source.End(17, TweenEndReason.Killed);
        Assert(f.Capture.Cancels.SequenceEqual([-17L]), "end reaches derived id without a node begin");
        f.Source.Emit(Schedule(id: 17, property: "material:shader_parameter/value"));
        f.Announcer.UpdateDesired(false);
        Assert(f.Capture.Cancels.SequenceEqual([-17L, -17L]), "opt-out cancels derived id too");
    }

    private static void MissingMaterialIsUnsupported()
    {
        var f = Active();
        var schedule = Schedule(id: 17);
        f.Source.Emit(schedule with { Steps = [Schedule(property: "material:shader_parameter/value").Steps[0],
            Schedule(property: "material:shader_parameter/value").Steps[0]] });
        f.Source.End(17, TweenEndReason.Killed);
        Assert(f.Capture.Begins.Count == 0 && f.Capture.Cancels.Count == 0, "missing ShaderMaterial drops steps silently");
        Assert(f.Resolutions == 1, "failed material lookup is sampled only at begin");
        f.Source.Emit(schedule with { Steps = [schedule.Steps[0], Schedule(property: "material:shader_parameter/value").Steps[0]] });
        Assert(Steps(f.Capture.Begins.Single()).Count == 1, "missing material preserves node steps");
        f.Announcer.UpdateArmed(false);
        Assert(f.Logs.Single().Contains("unsupported=material:shader_parameter/value:3 host_only="),
            "missing material counted as unsupported, not host-only");
    }

    private static Fixture Active()
    {
        var f = new Fixture();
        f.Announcer.UpdateDesired(true);
        f.Announcer.UpdateArmed(true);
        return f;
    }

    private static void CaptureCountersLoggedOnce()
    {
        var f = Active();
        f.Capture.Counters = new Dictionary<string, object>
        {
            ["begins_accepted"] = 2L, ["steps_accepted"] = 3L,
            ["begins_dropped"] = 1L, ["steps_dropped"] = 2L,
            ["drops_by_reason"] = new Dictionary<string, object>
            {
                ["unsupported-property"] = 1L, ["material-not-published"] = 1L
            }
        };
        f.Source.Emit(Schedule());
        f.Announcer.UpdateDesired(false);
        Assert(f.Capture.CounterReads == 0, "no counter reads at arm, begin or opt-out");
        f.Announcer.UpdateArmed(false);
        f.Announcer.UpdateArmed(false);
        var line = f.Logs.Single();
        Assert(line.StartsWith("[stream-tweens] begins=1"), "capture counters share the announcer line");
        Assert(line.Contains(" capture="), "capture counters logged at disarm");
        using var json = JsonDocument.Parse(line[(line.IndexOf(" capture=", StringComparison.Ordinal) + 9)..]);
        var capture = json.RootElement;
        Assert(capture.GetProperty("begins_accepted").GetInt64() == 2
            && capture.GetProperty("steps_accepted").GetInt64() == 3
            && capture.GetProperty("begins_dropped").GetInt64() == 1
            && capture.GetProperty("steps_dropped").GetInt64() == 2, "capture acceptance and drop totals preserved");
        var drops = capture.GetProperty("drops_by_reason");
        Assert(drops.GetProperty("unsupported-property").GetInt64() == 1
            && drops.GetProperty("material-not-published").GetInt64() == 1, "nested drop reasons preserved");
        Assert(f.Capture.CounterReads == 1, "one snapshot per disarm");
        f.Capture.Counters = new Dictionary<string, object> { ["begins_accepted"] = 0L };
        f.Announcer.UpdateArmed(true);
        f.Announcer.UpdateArmed(false);
        Assert(f.Capture.CounterReads == 2 && f.Logs.Last().EndsWith("capture={\"begins_accepted\":0}"),
            "rearm reads fresh capture counters");
    }

    private static void MissingCaptureCountersAreUnavailable()
    {
        var f = Active();
        f.Announcer.UpdateArmed(false);
        Assert(f.Capture.CounterReads == 1 && f.Logs.Single().EndsWith("capture=unavailable"),
            "older captures without client_tweens remain safe");
    }

    private static void FailedCaptureCountersAreUnavailable()
    {
        var f = Active();
        f.Capture.CounterReadFails = true;
        f.Announcer.UpdateArmed(false);
        Assert(!f.Source.Active && f.Capture.CounterReads == 1 && f.Logs.Single().EndsWith("capture=unavailable"),
            "diagnostic read failure cannot interrupt disarm");
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
        internal ulong? MaterialId;
        internal int Resolutions;
        internal ulong ResolvedObject;
        internal Fixture() => Announcer = new(Source.Subscribe, Capture, Logs.Add, objectId =>
        {
            Resolutions++;
            ResolvedObject = objectId;
            return MaterialId;
        });
    }

    private sealed class Source
    {
        internal int Subscriptions, Disposals;
        internal bool Active;
        private Action<TweenSchedule>? _begin;
        private Action<TweenEnd>? _end;
        internal IDisposable Subscribe(Action<TweenSchedule> begin, Action<TweenEnd> end)
        {
            Subscriptions++;
            Active = true;
            (_begin, _end) = (begin, end);
            return new Subscription(() => { Active = false; Disposals++; });
        }
        internal void Emit(TweenSchedule schedule) => _begin?.Invoke(schedule);
        internal void End(long id, TweenEndReason reason) => _end?.Invoke(new(id, reason));
        private sealed class Subscription(Action dispose) : IDisposable { public void Dispose() => dispose(); }
    }

    private sealed class Capture : IRenderStreamTweenCapture
    {
        internal readonly List<IReadOnlyDictionary<string, object>> Begins = [];
        internal readonly List<long> Cancels = [];
        internal IReadOnlyDictionary<string, object>? Counters;
        internal int CounterReads;
        internal bool CounterReadFails;
        public void TweenBegin(IReadOnlyDictionary<string, object> schedule) => Begins.Add(schedule);
        public void TweenCancel(long tweenId) => Cancels.Add(tweenId);
        public IReadOnlyDictionary<string, object>? TweenCounters()
        {
            CounterReads++;
            if (CounterReadFails) throw new InvalidOperationException("capture unavailable");
            return Counters;
        }
    }
}
