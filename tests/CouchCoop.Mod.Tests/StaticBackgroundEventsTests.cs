using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Embedding;
using Spirectl.Sts2.Live;

// The EVENT half of the static-background feature (the mirror's "Static background" setting on event screens):
// the /bg/events/<id> grammar, the provider's single literal-scene render rung riding the same
// memory/disk/single-flight belt, the digest-less contract, and the tracker's event-backdrop locate (the pure
// BFS the main-thread probe drives over the live tree).
internal static class StaticBackgroundEventsTests
{
    private const string NeowScene = "res://scenes/events/background_scenes/neow.tscn";

    public static async Task RunAsync()
    {
        ParsesTheEventBackdropConvention();
        EventKeysAndUrlsAreDigestLessAndNamespaced();
        FrameSpecsFormatValidateAndQualifyKeys();
        await RendersTheLiteralEventSceneThroughTheSharedBeltAsync();
        await EventDigestMisuseThrowsAsync();
        await HeadlessEventServesDiskOr503Async();
        FindsTheShallowestEventBackdropWithinBudget();
        TrackerPublishesEventStatesDigestLess();
        LateBackdropMountReArmsTheProbe();
        Console.WriteLine("StaticBackgroundEventsTests passed");
    }

    private static void ParsesTheEventBackdropConvention()
    {
        Assert(CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(NeowScene) == "neow", "the event convention parses to its id");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId("res://scenes/events/background_scenes/tezcatara.tscn") == "tezcatara",
            "tezcatara lives under the same directory and parses");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId("res://scenes/backgrounds/underdocks/underdocks_background.tscn") is null,
            "combat backgrounds (a different convention) do not parse");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId("res://scenes/events/background_scenes/neow/props.tscn") is null,
            "a nested sub-scene is not the backdrop root");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId("res://scenes/events/background_scenes/neow_water.gdshader") is null,
            "non-scene resources under the directory do not parse");
        Assert(CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(null) is null, "null is rejected");
    }

    private static void EventKeysAndUrlsAreDigestLessAndNamespaced()
    {
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null)
            == "bg://events/neow?w=2520&h=1080&v=1",
            "the event cache key rides the bg://events/ namespace with the fixed policy");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null)
            == "/bg/events/neow?v=1",
            "the event URL grammar is /bg/events/<id>?v=1");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null)
            != CouchCoopStaticBackgroundProvider.BuildCacheKey("neow", null),
            "an event id can never collide with a combat background of the same name");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", null)
            == CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Combat, "underdocks", null),
            "the combat shorthand and the family overload mint the same key (no combat key changed)");
    }

    // `frame=` is the events counterpart of the combat layers digest: the tracker-probed LIVE backdrop frame
    // (the recovered placement lerp drifted from the shipped game — measured container y 99.4 vs the lerp's 40
    // on Neow), minted canonically so the same transform always produces the same immutable URL.
    private static void FrameSpecsFormatValidateAndQualifyKeys()
    {
        var frame = CouchCoopStaticBackgroundProvider.FormatEventFrameSpec(105.6, 99.44, 0.89);
        Assert(frame == "105.6,99.4,0.890", $"the spec format is invariant 0.1/0.001 (got {frame})");
        Assert(CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec(frame), "the canonical format validates");
        Assert(CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec("-140.0,110.0,1.000"), "negative positions validate");
        Assert(!CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec("105.6,99.4"), "two segments are garbled");
        Assert(!CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec("105.6,99.4,-1.0"), "a negative scale is garbled");
        Assert(!CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec("1e3,0,1"), "exponent notation is garbled");

        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null, frame)
            == $"bg://events/neow?w=2520&h=1080&frame={frame}&v=1",
            "the frame rides the cache key (a distinct variant)");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null, frame)
            == $"/bg/events/neow?frame={Uri.EscapeDataString(frame)}&v=1",
            "the frame rides the URL, escaped");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null, frame)
            != CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null),
            "frame-qualified and reference variants are distinct cache entries");
    }

    private static async Task RendersTheLiteralEventSceneThroughTheSharedBeltAsync()
    {
        var root = TempRoot();
        try
        {
            var fake = new RecordingAssetProvider();
            var provider = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(root), isHeadlessClient: false);

            var miss = await provider.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(miss.Error is null && miss.CacheStatus == "miss", "the first event request renders");
            Assert(fake.Requests.Count == 1, "the event chain is ONE literal rung — no composed keys to fall back through");
            Assert(fake.Requests[0].Key == NeowScene, "the rung addresses the literal event backdrop scene");
            Assert(fake.Requests[0] is { RenderWidth: 2520, RenderHeight: 1080, CompositionSelector: null }, "the render is pinned to the digest-less 2520x1080 policy");

            var memory = await provider.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(memory.CacheStatus == "memory" && fake.Requests.Count == 1, "the second event request is a memory hit");

            // A COLD provider instance (fresh memory map, same disk root) serves the write-through.
            var coldFake = new RecordingAssetProvider();
            var cold = new CouchCoopStaticBackgroundProvider(coldFake, new SpirectlAssetBinaryCache(root), isHeadlessClient: false);
            var hit = await cold.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(hit.CacheStatus == "hit" && coldFake.Requests.Count == 0, "a cold instance serves the event disk cache without extracting");
            Assert(hit.Bytes!.SequenceEqual(miss.Bytes!), "disk serves the identical bytes");
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static async Task EventDigestMisuseThrowsAsync()
    {
        var root = TempRoot();
        try
        {
            var provider = new CouchCoopStaticBackgroundProvider(new RecordingAssetProvider(), new SpirectlAssetBinaryCache(root), isHeadlessClient: false);
            try
            {
                await provider.GetImageAsync(StaticBackgroundFamily.Events, "neow", "0123456789abcdef", null);
                Assert(false, "an event request carrying a digest must throw");
            }
            catch (ArgumentException)
            {
                // The route 400s this before the provider; reaching here means a CALLER confused the families.
            }
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static async Task HeadlessEventServesDiskOr503Async()
    {
        var root = TempRoot();
        try
        {
            var fake = new RecordingAssetProvider();
            var headless = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(root), isHeadlessClient: true);

            var cold = await headless.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(cold.Error?.Code == "static-bg-unavailable" && cold.ServiceUnavailable, "a cold headless event answer is a 503-mapped structured error");
            Assert(fake.Requests.Count == 0, "a dummy-renderer process never extracts");

            var key = CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null);
            Assert(await new SpirectlAssetBinaryCache(root).TryWriteAsync(key, [1, 2, 3], "image/jpeg"), "seeding the event disk cache succeeds");
            var seeded = await headless.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(seeded.Error is null && seeded.Bytes is [1, 2, 3], "a headless instance serves disk-cached event bytes");
        }
        finally
        {
            TryDelete(root);
        }
    }

    // The tracker's pure BFS half (FindEventBackgroundRoot): shallowest match wins, the parse is the STRICT
    // convention, and the node budget bounds the sweep — a budget hit means "no backdrop", never a partial answer.
    private static void FindsTheShallowestEventBackdropWithinBudget()
    {
        // room ── ui ──── deep(tezcatara)          <- deeper match, must lose
        //      └─ layout ─ backdrop(neow)          <- shallowest match, must win
        var deeper = N("res://scenes/events/background_scenes/tezcatara.tscn");
        var backdrop = N(NeowScene);
        var tree = N(null, N(null, N(null, deeper)), N(null, backdrop));

        var found = CouchCoopStaticBackgroundTracker.FindEventBackgroundRoot(tree, n => n.Children, n => n.Scene);
        Assert(found is { Id: "neow" }, "the shallowest backdrop wins");
        Assert(ReferenceEquals(found!.Value.Node, backdrop), "the located node is the backdrop root itself (the Stage-B stamping target)");
        Assert(found.Value.ScenePath == NeowScene, "the located path is the scene path the descriptor publishes");

        // Non-matching scene paths (combat convention, nested event sub-scenes) never match.
        var noMatch = N(null, N("res://scenes/backgrounds/underdocks/underdocks_background.tscn"), N("res://scenes/events/background_scenes/neow/props.tscn"));
        Assert(
            CouchCoopStaticBackgroundTracker.FindEventBackgroundRoot(noMatch, n => n.Children, n => n.Scene) is null,
            "foreign conventions do not locate");

        // Budget: a sweep that would only reach the backdrop beyond the budget reports "none".
        var wide = N(null, Enumerable.Range(0, 8).Select(_ => N(null)).Append(backdrop).ToArray());
        Assert(
            CouchCoopStaticBackgroundTracker.FindEventBackgroundRoot(wide, n => n.Children, n => n.Scene, nodeBudget: 4) is null,
            "hitting the node budget means no backdrop, not a partial answer");
        Assert(
            CouchCoopStaticBackgroundTracker.FindEventBackgroundRoot(wide, n => n.Children, n => n.Scene) is { Id: "neow" },
            "the same tree locates under the real budget");
    }

    private static void TrackerPublishesEventStatesDigestLess()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            var fired = 0;
            var tracker = new CouchCoopStaticBackgroundTracker(() => fired++);
            var state = new CouchCoopStaticBackgroundState(
                NeowScene,
                [],
                Digest: null,
                CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null));

            tracker.PublishForTest(state);
            Assert(fired == 1 && CouchCoopStaticBackgroundTracker.Published == state, "an event publish fires the change callback");
            Assert(CouchCoopStaticBackgroundTracker.Published!.Url == "/bg/events/neow?v=1", "the published URL is the digest-less event URL");
            Assert(CouchCoopStaticBackgroundTracker.Published.Digest is null, "an event publish is always digest-less");

            tracker.PublishForTest(state with { LayerPaths = [] });
            Assert(fired == 1, "an identical event re-publish is a no-op (no session resend storm)");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    // The late-mount race, measured live on the first Neow fixture entry: the screen-change probe ran one
    // main-thread hop after the screen delta, the backdrop scene mounted a tick LATER, and the tracker published
    // null forever (nothing re-probed). The backdrop's ADD is itself an upsert carrying SceneFilePath, so the
    // re-probe condition is "this delta upserts a strict event backdrop the current publish does not name".
    private static void LateBackdropMountReArmsTheProbe()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            static RuntimeSceneDelta Delta(params RuntimeSceneNodeDelta[] upserts)
                => new(false, "Rooms.NEventRoom", "screen:1", upserts, [], null);

            Assert(
                CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(Delta(WireNode("a", NeowScene))),
                "an unpublished backdrop upsert re-arms the probe");
            Assert(
                !CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(Delta(WireNode("a", null), WireNode("b", "res://scenes/rooms/rest_site_room.tscn"))),
                "deltas without an event backdrop never re-arm");
            Assert(
                !CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(Delta(WireNode("a", "res://scenes/events/background_scenes/neow/props.tscn"))),
                "a nested sub-scene is not a backdrop mount");

            new CouchCoopStaticBackgroundTracker().PublishForTest(new CouchCoopStaticBackgroundState(
                NeowScene,
                [],
                Digest: null,
                CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null)));
            Assert(
                !CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(Delta(WireNode("a", NeowScene))),
                "once the publish names the path, further upserts of the backdrop stop re-arming (no probe storm)");
            Assert(
                CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(
                    Delta(WireNode("a", "res://scenes/events/background_scenes/tezcatara.tscn"))),
                "a DIFFERENT backdrop mounting still re-arms");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    private static RuntimeSceneNodeDelta WireNode(string id, string? scenePath)
        => new(id, null, id, "Node2D", null, true, 1, null, 0, null, false, null, SceneFilePath: scenePath);

    private sealed record TestNode(string? Scene, IReadOnlyList<TestNode> Children);

    private static TestNode N(string? scene, params TestNode[] children) => new(scene, children);

    private static string TempRoot()
        => Path.Combine(Path.GetTempPath(), "couchcoop-static-bg-events-" + Guid.NewGuid().ToString("N"));

    private static void TryDelete(string root)
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (IOException)
        {
            // Best-effort temp cleanup.
        }
    }

    private static void Assert(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException(because);
        }
    }

    // Succeeds for any key with tiny JPEG-tagged bytes; the event chain has no rungs to script, so recording the
    // requests is the whole job.
    private sealed class RecordingAssetProvider : ISpirectlAssetProvider
    {
        public List<EmbeddableAssetRequest> Requests { get; } = [];

        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
        {
            Requests.Add(request);
            return new(
                true,
                new EmbeddableAssetPayload(
                    request.RequestId ?? string.Empty,
                    request.Key,
                    "image",
                    "jpeg",
                    "image/jpeg",
                    request.RenderWidth ?? 0,
                    request.RenderHeight ?? 0,
                    [0xFF, 0xD8, 0xFF, 0xE0],
                    [],
                    new EmbeddableAssetProvenance("bg", request.Key, request.Key, "event_background", "test"),
                    []),
                null);
        }

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
            => new("ok", [GetAsset(request.Requests[0])]);
    }
}
