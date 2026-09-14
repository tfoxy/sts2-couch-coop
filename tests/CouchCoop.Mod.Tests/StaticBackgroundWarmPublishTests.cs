using CouchCoop.Mod.Server;

// WARM-AT-PUBLISH: the fix for the permanently-404ing qualified variant.
//
// THE DEFECT. `/bg/<id>?layers=<digest>&v=1` may only RENDER while `<digest>` is the tracker's CURRENT publish
// (the immutable-URL contract: serving different bytes under a URL that names a variant is the one forbidden
// outcome). The host keeps no `digest → layer paths` history, so a client fetch that arrives one publish late
// cannot be served from anything — it is a PERMANENT `unknown-background-variant` 404, not a transient one. Live
// evidence on the beta host: `/perf/bg.json` reported 1 render in 68 minutes with the digest-qualified lane
// 0-for-N, while the digest-less URL 200'd with 280 KB.
//
// THE FIX, pinned here: the tracker hands every QUALIFIED publish to a warm callback the moment it publishes, so
// the bytes are rendered and cached before any client asks and the currency rule never has to adjudicate whether
// to SERVE. These are the pure halves — the gate, the family/id resolution, the callback's firing discipline, and
// the server's viewer-admission rule. The render itself needs a Godot main thread and is exercised live.
internal static class StaticBackgroundWarmPublishTests
{
    public static void Run()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            OnlyQualifiedVariantsWarm();
            VariantTargetsResolvePerFamily();
            PublishFiresTheWarmCallbackOncePerChange();
            WarmAdmissionCountsAnyStaticBgViewer();
            Console.WriteLine("StaticBackgroundWarmPublishTests passed");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    private const string UnderdocksScene = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";
    private const string NeowScene = "res://scenes/events/background_scenes/neow.tscn";
    private const string MerchantScene = "res://scenes/rooms/merchant_room.tscn";

    // The gate: warm a variant whose URL is only renderable while it is current, and nothing else. An UNqualified
    // variant has no such window (it is always renderable, and CouchCoopStaticBackgroundPrerenderJob bakes every
    // one of them at startup), so warming it again would pay a ~282ms render for bytes that are already there.
    private static void OnlyQualifiedVariantsWarm()
    {
        Assert(
            CouchCoopStaticBackgroundTracker.IsWarmableVariant(Combat("6f2d501405db6ef5")),
            "a layer-digest-qualified combat variant warms");
        Assert(
            CouchCoopStaticBackgroundTracker.IsWarmableVariant(Event("105.6,99.4,0.890")),
            "a frame-qualified event variant warms (the frame rule is the digest rule's twin)");
        Assert(
            !CouchCoopStaticBackgroundTracker.IsWarmableVariant(Combat(null)),
            "the digest-less combat variant does NOT warm — it is always renderable and the sweep bakes it");
        Assert(
            !CouchCoopStaticBackgroundTracker.IsWarmableVariant(Event(null)),
            "…and neither does the frame-less event variant");
        Assert(
            !CouchCoopStaticBackgroundTracker.IsWarmableVariant(null),
            "publishing NOTHING (a screen with no background) warms nothing");
    }

    // The warm has to address the provider by (family, id), and the only thing the published state carries is a
    // scene path. All three grammars must resolve, and a foreign path must resolve to nothing rather than to a
    // wrong family.
    private static void VariantTargetsResolvePerFamily()
    {
        Assert(
            CouchCoopStaticBackgroundTracker.TryResolveVariantTarget(Combat("abc123")) is (StaticBackgroundFamily.Combat, "underdocks"),
            "the combat convention resolves to (Combat, <dir name>)");
        Assert(
            CouchCoopStaticBackgroundTracker.TryResolveVariantTarget(Event("1.0,2.0,1.000")) is (StaticBackgroundFamily.Events, "neow"),
            "the strict event convention resolves to (Events, <id>)");
        Assert(
            CouchCoopStaticBackgroundTracker.TryResolveVariantTarget(Room("1.0,2.0,1.000")) is (StaticBackgroundFamily.Rooms, "merchant_room"),
            "the room-backdrop table resolves to (Rooms, <room id>)");
        Assert(
            CouchCoopStaticBackgroundTracker.TryResolveVariantTarget(new CouchCoopStaticBackgroundState(
                "res://scenes/backgrounds/underdocks/layers/underdocks_bg_00_c.tscn", [], "abc123", "/bg/x")) is null,
            "a per-layer sub-scene follows NO family grammar and resolves to nothing");
    }

    // The callback's firing discipline: exactly once per accepted CHANGE, never on a no-op re-publish, and never
    // for an unqualified variant. A storm here would be a render storm on the game's main thread.
    private static void PublishFiresTheWarmCallbackOncePerChange()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        var warmed = new List<string>();
        var resends = 0;
        var tracker = new CouchCoopStaticBackgroundTracker(
            onPublishedChanged: () => resends++,
            log: _ => { },
            warmVariant: state => warmed.Add(state.Url));

        tracker.PublishForTest(Combat(null));
        Assert(resends == 1, "the unqualified publish still re-sends sessions");
        Assert(warmed.Count == 0, "…but warms nothing");

        var qualified = Combat("6f2d501405db6ef5");
        tracker.PublishForTest(qualified);
        Assert(warmed.Count == 1 && warmed[0] == qualified.Url, $"the qualified publish warms its own URL (got [{string.Join(',', warmed)}])");

        // Re-publishing the identical state is rejected by the change check BEFORE the warm, so an idle host that
        // re-probes the same room does not re-render it.
        tracker.PublishForTest(Combat("6f2d501405db6ef5"));
        Assert(warmed.Count == 1, "an unchanged re-publish warms nothing");

        tracker.PublishForTest(Event("105.6,99.4,0.890"));
        Assert(warmed.Count == 2 && warmed[1].Contains("/bg/events/neow", StringComparison.Ordinal), "a new frame-qualified event publish warms too");

        tracker.PublishForTest(null);
        Assert(warmed.Count == 2, "publishing null (leaving the room) warms nothing");

        // A warm callback that throws must never break the publish the clients are waiting on.
        CouchCoopStaticBackgroundTracker.ResetForTest();
        var throwingResends = 0;
        var throwing = new CouchCoopStaticBackgroundTracker(
            onPublishedChanged: () => throwingResends++,
            log: _ => { },
            warmVariant: _ => throw new InvalidOperationException("no renderer here"));
        throwing.PublishForTest(Combat("deadbeefdeadbeef"));
        Assert(throwingResends == 1, "the session resend happened before the warm and is unaffected by its failure");
        Assert(
            CouchCoopStaticBackgroundTracker.Published?.Digest == "deadbeefdeadbeef",
            "…and the publish itself stands");
        CouchCoopStaticBackgroundTracker.ResetForTest();
    }

    // The server's admission rule for a warm. Deliberately WEAKER than the walk-skip unanimity
    // (ComputeBgSkipDesired): a mixed room — one viewer on the still, one on the live scenery — still has
    // somebody waiting on the picture, and warming for them is the entire point. Derived from the two counts the
    // skip aggregate already keeps: `needed` is "streaming AND NOT staticBg", so `streaming - needed` is
    // "streaming AND staticBg".
    private static void WarmAdmissionCountsAnyStaticBgViewer()
    {
        Assert(!CouchCoopBrowserServer.HasStaticBgViewer(0, 0), "nobody streaming ⇒ nothing to warm for");
        Assert(!CouchCoopBrowserServer.HasStaticBgViewer(1, 1), "one streaming viewer, and they want the live scenery ⇒ no warm");
        Assert(CouchCoopBrowserServer.HasStaticBgViewer(1, 0), "one streaming viewer showing the still ⇒ warm");
        Assert(CouchCoopBrowserServer.HasStaticBgViewer(2, 1), "MIXED: one still + one live ⇒ still warm, unlike the skip verdict");
        Assert(!CouchCoopBrowserServer.ComputeBgSkipDesired(2, 1), "…which the unanimity rule would refuse, as it must");
        Assert(CouchCoopBrowserServer.HasStaticBgViewer(3, 0), "every streaming viewer on the still ⇒ warm");
    }

    private static CouchCoopStaticBackgroundState Combat(string? digest)
        => new(
            UnderdocksScene,
            digest is null ? [] : ["res://scenes/backgrounds/underdocks/layers/underdocks_bg_00_c.tscn"],
            digest,
            CouchCoopStaticBackgroundProvider.BuildImageUrl("underdocks", digest));

    private static CouchCoopStaticBackgroundState Event(string? frame)
        => new(
            NeowScene,
            [],
            Digest: null,
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null, frame),
            EventFrame: frame);

    private static CouchCoopStaticBackgroundState Room(string? frame)
        => new(
            MerchantScene,
            [],
            Digest: null,
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Rooms, "merchant_room", null, frame),
            EventFrame: frame);

    private static void Assert(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException(because);
        }
    }
}
