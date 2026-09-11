using System.Text.Json;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Server;
using CouchCoop.MirrorProtocol.Envelopes;
using Spirectl.Sts2.Core.SceneInspection;

// Stage-B walk skip (static background): the PURE halves of the "skip the combat bg subtree from the producer
// walk" feature — the unanimity decision (skip ⇔ valve on AND somebody streams AND nobody streaming still needs
// the subtree), the required canonical `?staticBg=0|1` connect selector, the
// settings-envelope wire twins (`staticBg` field both directions), the tracker's Godot-less desired-skip latch,
// and the retained-map re-admission shape (unstamp ⇒ spirectl re-emits STATIC-BEARING upserts, which the couch
// retained pipeline must take verbatim). The live socket half — accept parse, live settings flips, disconnects —
// rides BrowserServerRouteTests.AssertStaticBgWalkSkipAggregateAsync; the stamp semantics themselves are
// spirectl's (Sts2StreamSkipMetaTests, `spirectl_stream_skip`).
internal static class WalkSkipUnanimityTests
{
    public static void Run()
    {
        UnanimityTruthTable();
        UnanimityScenarioTuples();
        SettingsEnvelopeRoundTripsStaticBg();
        SettingsMessageTwinSerializesStaticBg();
        TrackerLatchesDesiredSkipWithoutAnEngine();
        UnstampReadmissionShipsStaticBearingUpserts();
        Console.WriteLine("WalkSkipUnanimityTests passed");
    }

    // The count-form decision, exhaustively over its two inputs (the Sts2StreamSkipMetaTests truth-table style).
    private static void UnanimityTruthTable()
    {
        foreach (var streaming in new[] { 0, 1, 2 })
        {
            foreach (var needed in new[] { 0, 1, 2 })
            {
                var expected = streaming > 0 && needed == 0;
                var actual = CouchCoopBrowserServer.ComputeBgSkipDesired(streaming, needed);
                Assert(actual == expected, $"streaming={streaming} needed={needed}: expected {expected}, got {actual}");
            }
        }

        // The per-connection classification: only a STREAMING connection with staticBg OFF needs the
        // subtree. A gated mirror viewer never counts (it receives nothing while gated).
        Assert(CouchCoopBrowserServer.NeedsBgStream(wantsSceneStream: true, wantsStaticBg: false), "streaming mirror with staticBg off needs the subtree");
        Assert(!CouchCoopBrowserServer.NeedsBgStream(wantsSceneStream: true, wantsStaticBg: true), "streaming mirror with staticBg on does not");
        Assert(!CouchCoopBrowserServer.NeedsBgStream(wantsSceneStream: false, wantsStaticBg: false), "a gated mirror viewer does not count");
        Assert(!CouchCoopBrowserServer.NeedsBgStream(wantsSceneStream: false, wantsStaticBg: true), "…regardless of staticBg");
    }

    // The scenario (tuple) form: each entry is one mirror connection's (WantsSceneStream, WantsStaticBg) pair.
    private static void UnanimityScenarioTuples()
    {
        // staticBg=0 means needs-bg: a sole streaming client with that selector keeps the subtree flowing.
        Assert(
            !CouchCoopBrowserServer.ComputeBgSkipDesired([(true, false)]),
            "staticBg=0 ⇒ needs-bg ⇒ no skip");

        // Two streaming clients, both ON ⇒ unanimous ⇒ skip.
        Assert(
            CouchCoopBrowserServer.ComputeBgSkipDesired([(true, true), (true, true)]),
            "two streaming clients with staticBg ON ⇒ skip");

        // One toggles OFF live (the panel, or the client's fetch fail-open push) ⇒ unanimity broken ⇒ unskip.
        Assert(
            !CouchCoopBrowserServer.ComputeBgSkipDesired([(true, true), (true, false)]),
            "one live toggle OFF ⇒ unskip (subtree re-admitted)");

        // The needs-bg client disconnects ⇒ the remaining voter is unanimous again ⇒ skip.
        Assert(
            CouchCoopBrowserServer.ComputeBgSkipDesired([(true, true)]),
            "the needs-bg client leaving restores unanimity");

        // The LAST client disconnects ⇒ nobody streams ⇒ no skip (a fresh viewer must never connect into a
        // stamped tree it did not vote for).
        Assert(
            !CouchCoopBrowserServer.ComputeBgSkipDesired([]),
            "no streaming connections ⇒ no skip");

        // A GATED viewer (picker) contributes nothing either way: it neither blocks a skip (it receives no
        // bytes) nor sustains one (streaming count is what arms the decision).
        Assert(
            CouchCoopBrowserServer.ComputeBgSkipDesired([(true, true), (false, false)]),
            "a gated needs-bg viewer does not block the skip");
        Assert(
            !CouchCoopBrowserServer.ComputeBgSkipDesired([(false, true)]),
            "a gated staticBg viewer alone does not engage the skip");

    }

    // Host parse side: the TS client's `{"type":"settings","staticBg":…}` lands in the trailing StaticBg field;
    // omission stays null, so this partial update leaves the connection's prior value unchanged.
    private static void SettingsEnvelopeRoundTripsStaticBg()
    {
        var withFalse = BrowserJson.Deserialize<BrowserSettingsRequestEnvelope>(
            """{"type":"settings","requestId":"settings:7","staticBg":false}""");
        Assert(withFalse is { StaticBg: false }, "staticBg:false parses into StaticBg=false (the fail-open push)");

        var withTrue = BrowserJson.Deserialize<BrowserSettingsRequestEnvelope>(
            """{"type":"settings","staticBg":true,"refreshRate":24}""");
        Assert(withTrue is { StaticBg: true, RefreshRate: 24 }, "staticBg:true parses beside the other levers");

        var absent = BrowserJson.Deserialize<BrowserSettingsRequestEnvelope>(
            """{"type":"settings","tweenReplay":false}""");
        Assert(absent is { StaticBg: null, TweenReplay: false }, "an absent staticBg field stays null (unchanged)");

        // Round-trip through the host serializer: null is omitted (older-wire bytes identical), a value rides
        // camelCased.
        var serializedNull = BrowserJson.Serialize(new BrowserSettingsRequestEnvelope("settings"));
        Assert(!serializedNull.Contains("staticBg", StringComparison.Ordinal), "null StaticBg is omitted from the wire");
        var serialized = BrowserJson.Serialize(new BrowserSettingsRequestEnvelope("settings", StaticBg: true));
        using var document = JsonDocument.Parse(serialized);
        Assert(
            document.RootElement.TryGetProperty("staticBg", out var value) && value.ValueKind == JsonValueKind.True,
            "StaticBg serializes as camelCase `staticBg`");
    }

    // Send-side twin (SettingsMessage, what the native client / round-trip tooling speaks): same field, same
    // omit-null rule, byte-compatible with the TS client's payload.
    private static void SettingsMessageTwinSerializesStaticBg()
    {
        var omitted = ProtocolJson.Serialize(new SettingsMessage(RequestId: "settings:1", TweenReplay: false));
        Assert(!omitted.Contains("staticBg", StringComparison.Ordinal), "a null StaticBg is omitted (pre-field wire identical)");

        var serialized = ProtocolJson.Serialize(new SettingsMessage(RequestId: "settings:2", StaticBg: false));
        using var document = JsonDocument.Parse(serialized);
        Assert(
            document.RootElement.TryGetProperty("staticBg", out var value) && value.ValueKind == JsonValueKind.False,
            "SettingsMessage serializes staticBg camelCased");
        Assert(
            BrowserJson.Deserialize<BrowserSettingsRequestEnvelope>(serialized) is { StaticBg: false },
            "the host parses the twin's bytes back into StaticBg (send/parse lockstep)");
    }

    // SetDesiredSkip in a Godot-less host (this very process): the verdict must LATCH — a later real probe applies
    // it — and the call must be inert (no native Godot call, no throw). EngineAvailable is false here by
    // construction (only CouchCoopMod.Init sets it, inside a real game process).
    private static void TrackerLatchesDesiredSkipWithoutAnEngine()
    {
        Assert(!CouchCoopStaticBackgroundTracker.EngineAvailable, "test host is Godot-less (the latch precondition)");
        var tracker = new CouchCoopStaticBackgroundTracker();
        Assert(!tracker.DesiredSkipForTest, "desired-skip starts false");
        tracker.SetDesiredSkip(true);
        Assert(tracker.DesiredSkipForTest, "SetDesiredSkip(true) latches Godot-less");
        tracker.SetDesiredSkip(true);
        Assert(tracker.DesiredSkipForTest, "an idempotent repeat is a no-op");
        tracker.SetDesiredSkip(false);
        Assert(!tracker.DesiredSkipForTest, "SetDesiredSkip(false) latches back (the un-stamp direction)");
    }

    // The RE-ADMISSION shape, over the couch retained map (CouchCoopSceneObserver.Apply's documented rule:
    // an upsert for an id the map does NOT hold is taken VERBATIM — MergeVolatile only runs for a retained id
    // with a volatile-only upsert). Timeline: (1) the bg root streams with its full static block; (2) the stamp
    // lands ⇒ the producer stale-sweeps the subtree (RemovedIds) ⇒ the retained map drops it; (3) the un-stamp
    // re-admits it — spirectl's contract is a fresh JustAdded, STATIC-BEARING upsert (Name present), which is
    // exactly what makes step 3 land a fully-styled node and the next keyframe carry it. The counterfactual is
    // asserted too: a volatile-only upsert after the removal would leave a style-less node, which is WHY the
    // producer's re-admission must ship statics.
    private static void UnstampReadmissionShipsStaticBearingUpserts()
    {
        const string BgId = "7042";
        const string BgScene = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";
        var color = new RuntimeSceneColorSnapshot(0.1, 0.2, 0.3, 1, "#1a334cff");

        RuntimeSceneNodeDelta StaticBearing() => new(
            Id: BgId, ParentId: "bgc", Name: "UnderdocksBackground", NodeType: "Godot.Node2D", Rect: null,
            Visible: true, Opacity: 1, ZIndex: null, Rotation: 0, Texture: null, NinePatch: false, Text: null)
        {
            SceneFilePath = BgScene,
            FillColor = color,
        };

        // (1) streamed while somebody needed it.
        var nodes = new Dictionary<string, RuntimeSceneNodeDelta> { [BgId] = StaticBearing() };

        // (2) the stamp's stale sweep.
        nodes.Remove(BgId);
        var (upsertsGone, orderGone) = CouchCoopSceneObserver.BuildKeyframeContents([BgId], nodes);
        Assert(upsertsGone.Count == 0 && orderGone.Count == 0, "while stamped, the retained keyframe carries neither the node nor its order id");

        // (3) un-stamp ⇒ static-bearing re-admission: no retained entry exists, so the upsert lands verbatim.
        var readmitted = StaticBearing();
        nodes[BgId] = nodes.TryGetValue(BgId, out var existing) && readmitted.Name is null
            ? CouchCoopSceneObserver.MergeVolatile(existing, readmitted)
            : readmitted;
        Assert(
            nodes[BgId] is { Name: "UnderdocksBackground", SceneFilePath: BgScene, FillColor: not null },
            "the re-admitted upsert restores the FULL static block (name + sceneFilePath + styling)");
        var (upserts, order) = CouchCoopSceneObserver.BuildKeyframeContents([BgId], nodes);
        Assert(
            upserts is [{ Id: BgId, SceneFilePath: BgScene }] && order is [BgId],
            "the next keyframe carries the re-admitted subtree again");

        // Counterfactual: a VOLATILE-ONLY upsert after the removal would land a style-less node — the reason the
        // spirectl re-admission contract (fresh JustAdded ⇒ statics included) is load-bearing for the couch map.
        var brokenMap = new Dictionary<string, RuntimeSceneNodeDelta>();
        var volatileOnly = new RuntimeSceneNodeDelta(
            Id: BgId, ParentId: "bgc", Name: null, NodeType: null, Rect: null,
            Visible: true, Opacity: 1, ZIndex: null, Rotation: 0, Texture: null, NinePatch: false, Text: null);
        brokenMap[BgId] = brokenMap.TryGetValue(BgId, out var none) && volatileOnly.Name is null
            ? CouchCoopSceneObserver.MergeVolatile(none, volatileOnly)
            : volatileOnly;
        Assert(
            brokenMap[BgId] is { Name: null, SceneFilePath: null, FillColor: null },
            "a volatile-only re-admission would strand a style-less node (the shape the contract forbids)");
    }

    private static void Assert(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException(because);
        }
    }
}
