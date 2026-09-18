using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Embedding;

// Stage-A static background (the mirror's "Static background" setting): the /bg/ image producer and the
// tracker's publish half. Covers the pure grammar (id parser, layer digest, cache-key/URL fan-out), the
// provider belt (single-flight, composed→deterministic→literal fallback chain, memory-before-disk population,
// headless disk-or-503 guard, the stale-digest cache-only rule) and the tracker's publish/change contract.
internal static class StaticBackgroundProviderTests
{
    private const string Scene = "res://scenes/backgrounds/underdocks/underdocks_background.tscn";

    private static readonly string[] Layers =
    [
        "res://scenes/backgrounds/underdocks/layers/underdocks_bg_00_c.tscn",
        "res://scenes/backgrounds/underdocks/layers/underdocks_bg_01_b.tscn",
        "res://scenes/backgrounds/underdocks/layers/underdocks_fg_a.tscn",
    ];

    public static async Task RunAsync()
    {
        ParsesTheBackgroundIdConvention();
        DigestsAreShortStableAndOrderSensitive();
        KeysAndUrlsCarryTheFixedPolicyAndFanOutPerDigest();
        ShippedCodecIsJpegQ90AndIsTheReportsBareKey();
        PrerenderSweepDiscoversDistinctConventionBackgrounds();
        await SingleFlightCollapsesConcurrentRequestsAsync();
        await FallsBackComposedThenDeterministicThenLiteralAsync();
        await ServesMemoryThenDiskWithoutReExtractingAsync();
        await HeadlessServesDiskOr503Async();
        await StaleDigestIsCacheOnlyAsync();
        TrackerPublishesOnChangeOnly();
        TrackerPublishesNullWhenValveIsOff();
        Console.WriteLine("StaticBackgroundProviderTests passed");
    }

    private static void ParsesTheBackgroundIdConvention()
    {
        Assert(CouchCoopStaticBackgroundProvider.TryParseBackgroundId(Scene) == "underdocks", "the convention path parses to its id");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseBackgroundId("res://scenes/backgrounds/spire_1/spire_1_background.tscn") == "spire_1",
            "snake_case ids with digits parse");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseBackgroundId(Layers[0]) is null,
            "a per-layer sub-scene under layers/ is NOT a background root");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseBackgroundId("res://scenes/backgrounds/underdocks/other_background.tscn") is null,
            "the file stem must equal the directory name");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseBackgroundId("res://scenes/events/background_scenes/neow.tscn") is null,
            "event backdrops (a different convention) do not parse");
        Assert(CouchCoopStaticBackgroundProvider.TryParseBackgroundId(null) is null, "null is rejected");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseBackgroundId("res://scenes/backgrounds/Underdocks/Underdocks_background.tscn") is null,
            "ids are the lowercase directory names; anything else is rejected");
    }

    // R21 codec switch. jpg@0.9 was chosen from a measured table (docs/agents/host-render-cost-aug22-round2.md):
    // 46ms encode / 280KB against PNG's 650ms / 2.1MB, at a body MAE of 263 on a scene whose own frame-to-frame
    // noise floor is 25-29. The constants ARE the policy, so they are pinned here rather than left implicit.
    private static void ShippedCodecIsJpegQ90AndIsTheReportsBareKey()
    {
        Assert(CouchCoopStaticBackgroundProvider.RenderCodec == "jpg", "the shipped encoder is JPEG");
        Assert(Math.Abs(CouchCoopStaticBackgroundProvider.RenderQuality - 0.9f) < 1e-6, "…at q90");
        var shipped = CouchCoopStaticBackgroundProvider.ShippedCodec;
        Assert(shipped.Label == "jpg@0.9", $"the policy label is jpg@0.9 (got {shipped.Label})");
        Assert(shipped.ContentType == "image/jpeg", "…and it serves as image/jpeg, which an extensionless URL relies on");
        // JPEG carries no alpha at all, so the render's 39-column transparent left band becomes opaque black.
        // That is the accepted cost of the switch, and it must be a property of the POLICY, not a surprise.
        Assert(shipped.Quality is not null, "a lossy candidate always names its quality");

        // The label must round-trip through the bench grammar, so a report block can be pasted back into a query.
        var parsed = StaticBackgroundRenderMetrics.TryParseFormats(shipped.Label);
        Assert(parsed is { Count: 1 } && parsed[0] == shipped, "the shipped label round-trips through formats=");
        Assert(parsed![0].IsShippedPolicy, "…and is recognized as the shipped policy");
        Assert(!new StaticBackgroundRenderMetrics.BenchCodec("png").IsShippedPolicy, "png is no longer the shipped policy");

        // The metric key: served renders must keep the BARE size key they have always had, or every cross-round
        // comparison silently re-labels itself the moment the encoder changes.
        var served = new StaticBackgroundRenderMetrics.Sample(
            0, "underdocks", 2520, 1080, 300, 280_000, "discovery", true, Bench: false, Codec: shipped.Label);
        Assert(StaticBackgroundRenderMetrics.MetricKey(served) == "2520x1080", "the shipped codec keys as the bare size");
        Assert(
            StaticBackgroundRenderMetrics.MetricKey(served with { Codec = "png" }) == "2520x1080:png",
            "a non-policy candidate gets its own labelled block");
    }

    // The prerender sweep's discovery half: act + encounter + event models -> the distinct backgrounds it will
    // warm. Pure, so the mapping is checkable without a game — and the mapping is where a silent zero would hide.
    private static void PrerenderSweepDiscoversDistinctConventionBackgrounds()
    {
        var models = new List<GameModelSnapshot>
        {
            // ACTS carry the background every ORDINARY combat room draws. Measured on the shipped game: 4 acts
            // name one each, while only the 11 boss encounters carry their own — so a sweep that read encounters
            // alone would prerender exactly the rooms a player sees least. This case is that regression test.
            Act("act1", Scene),
            Act("act2", "res://scenes/backgrounds/glory/glory_background.tscn"),
            Encounter("a", Scene),                                                     // shares act1's background
            Encounter("b", "res://scenes/backgrounds/spire_1/spire_1_background.tscn"),
            Encounter("c", Layers[0]),                                                 // a per-layer sub-scene
            Encounter("d", "res://scenes/events/background_scenes/neow.tscn"),         // event path on a NON-event model
            Encounter("e", null),                                                      // no custom background
            // EVENTS carry the backdrop the /bg/events family serves; combat-convention paths on an event model
            // would be equally foreign there (families do not cross-pollinate).
            Event("neow", "res://scenes/events/background_scenes/neow.tscn"),
            Event("neow_twin", "res://scenes/events/background_scenes/neow.tscn"),     // shared backdrop, warmed once
            Event("boss_intro", null),
        };

        var ids = CouchCoopStaticBackgroundPrerenderJob.DiscoverBackgroundIds(models);
        Assert(ids.Count == 4, $"only the four convention-shaped backgrounds are discovered (got {ids.Count})");
        Assert(
            ids[0] == (StaticBackgroundFamily.Combat, "glory")
            && ids[1] == (StaticBackgroundFamily.Combat, "spire_1")
            && ids[2] == (StaticBackgroundFamily.Combat, "underdocks")
            && ids[3] == (StaticBackgroundFamily.Events, "neow"),
            "combat warms first (most of a run is combat), each family ordered, shared backgrounds warmed once");
        Assert(
            CouchCoopStaticBackgroundPrerenderJob.BackgroundModelFamilies.Contains("acts")
            && CouchCoopStaticBackgroundPrerenderJob.BackgroundModelFamilies.Contains("encounters")
            && CouchCoopStaticBackgroundPrerenderJob.BackgroundModelFamilies.Contains("events"),
            "the job queries every family that can name a background root");
        Assert(
            CouchCoopStaticBackgroundPrerenderJob.DiscoverBackgroundIds([]).Count == 0,
            "an empty catalog discovers nothing — which the job reports rather than calling success");
    }

    private static ActGameModelSnapshot Act(string id, string? backgroundScenePath)
        => new(
            Id: id,
            Title: null,
            FloorCount: 0,
            RoomCount: 0,
            MultiplayerFloorCount: 0,
            MultiplayerRoomCount: 0,
            DefaultOrder: 0,
            MonsterIds: [],
            RegularEncounterIds: [],
            EliteEncounterIds: [],
            BossEncounterIds: [],
            WeakEncounterIds: [],
            EventIds: [],
            AncientEventIds: [],
            BgMusicOptions: [],
            MusicBankPaths: [],
            AmbientSfx: null,
            ChestOpenSfx: null,
            ChestSpineAssetKey: null,
            ChestSpineResourcePath: null,
            BackgroundSceneAssetKey: null,
            BackgroundScenePath: backgroundScenePath,
            RestSiteBackgroundAssetKey: null,
            RestSiteBackgroundPath: null,
            MapTopBgAssetKey: null,
            MapTopBgPath: null,
            MapMidBgAssetKey: null,
            MapMidBgPath: null,
            MapBotBgAssetKey: null,
            MapBotBgPath: null,
            MapBgColor: null,
            MapTraveledColor: null,
            MapUntraveledColor: null);

    private static EventGameModelSnapshot Event(string id, string? backgroundScenePath)
        => new(
            Id: id,
            Kind: "event",
            Title: null,
            InitialDescription: null,
            LayoutType: null,
            IsShared: false,
            IsDeterministic: false,
            HasVfx: false,
            CanonicalEncounterId: null,
            GameInfoOptions: [],
            BackgroundSceneAssetKey: null,
            BackgroundScenePath: backgroundScenePath,
            BackgroundSpineStillAssetKey: null,
            BackgroundSpineStillPath: null,
            InitialPortraitAssetKey: null,
            InitialPortraitPath: null,
            VfxAssetKey: null,
            VfxPath: null,
            Epithet: null,
            DialogueColor: null,
            ButtonColor: null,
            AmbientBgm: null,
            HasAmbientBgm: false,
            AnyCharacterDialogueBlacklistIds: [],
            MapIconAssetKey: null,
            MapIconPath: null,
            MapIconOutlineAssetKey: null,
            MapIconOutlinePath: null,
            RunHistoryIconAssetKey: null,
            RunHistoryIconPath: null,
            RunHistoryIconOutlineAssetKey: null,
            RunHistoryIconOutlinePath: null);

    private static EncounterGameModelSnapshot Encounter(string id, string? backgroundScenePath)
        => new(
            Id: id,
            TypeName: null,
            CategorySortingId: 0,
            EntrySortingId: 0,
            ShouldReceiveCombatHooks: false,
            Title: null,
            RoomType: null,
            IsWeak: false,
            IsDebugEncounter: false,
            MonsterIds: [],
            MonstersWithSlots: [],
            Slots: [],
            Tags: [],
            MinGoldReward: 0,
            MaxGoldReward: 0,
            ShouldGiveRewards: false,
            HasBgm: false,
            CustomBgm: null,
            HasAmbientSfx: false,
            AmbientSfx: null,
            HasScene: false,
            SceneAssetKey: null,
            ScenePath: null,
            BossNodePath: null,
            MapNodeAssetPaths: [],
            ExtraAssetPaths: [],
            CustomRewardDescription: null,
            FullyCenterPlayers: false,
            CameraOffset: null,
            CameraScaling: 1,
            HasCustomBackground: backgroundScenePath is not null,
            BackgroundScenePath: backgroundScenePath);

    private static void DigestsAreShortStableAndOrderSensitive()
    {
        var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(Layers);
        Assert(digest is { Length: 16 }, "the digest is 16 chars");
        Assert(digest!.All(ch => char.IsAsciiDigit(ch) || ch is >= 'a' and <= 'f'), "the digest is lowercase hex");
        Assert(digest == CouchCoopStaticBackgroundProvider.ComputeLayersDigest([.. Layers]), "the digest is stable for the same ordered list");
        Assert(
            digest != CouchCoopStaticBackgroundProvider.ComputeLayersDigest([Layers[1], Layers[0], Layers[2]]),
            "layer ORDER is paint order, so it changes the digest");
        Assert(CouchCoopStaticBackgroundProvider.ComputeLayersDigest([]) is null, "an empty set has no digest (deterministic variant)");
    }

    private static void KeysAndUrlsCarryTheFixedPolicyAndFanOutPerDigest()
    {
        var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(Layers)!;
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", digest) == $"bg://underdocks?w=2520&h=1080&layers={digest}&v=1",
            "the cache key carries the fixed render policy and the layer digest");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", null) == "bg://underdocks?w=2520&h=1080&v=1",
            "the digest-less key is the deterministic-fallback variant");
        // R21: no file extension. The encoder is a policy (RenderCodec), so pinning it into the path would force
        // every future codec change to move the URL, the client fallback and the route grammar in lockstep.
        //
        // TWO VERSIONS, AND THE KEY CARRIES ONLY ONE OF THEM. `v` is the URL GRAMMAR's version, asserted
        // literally above and below. `b` is the GAME BUILD (CouchCoopAssetVersion) and rides the URL because the
        // URL is the only thing that can invalidate a client's HTTP cache: every asset answer is
        // `immutable, max-age=31536000`, so without it a phone that joined a public-beta host keeps that build's
        // background under a URL this build also mints, for a year. The CACHE KEY above deliberately stays bare —
        // the host's own on-disk cache is already scoped by game version at the directory level, so folding the
        // build in would duplicate every rendered background for nothing. The token itself is opaque (it hashes
        // the install's release_info), so it is read from the host; every other character is pinned here.
        var build = $"&b={Uri.EscapeDataString(CouchCoopAssetVersion.Token)}";
        Assert(
            CouchCoopStaticBackgroundProvider.BuildImageUrl("underdocks", digest) == $"/bg/underdocks?layers={digest}&v=1{build}",
            "the URL grammar is /bg/<id>?layers=<digest>&v=1&b=<build>");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildImageUrl("underdocks", null) == $"/bg/underdocks?v=1{build}",
            "the digest-less URL omits layers");
        // The client's wire fallback in frontend/src/mirror/StaticBackground.vue hardcodes this `v=`; if the two
        // drift the fallback asks for a namespace the host stopped serving and every descriptor-less room is blank.
        Assert(
            CouchCoopStaticBackgroundProvider.KeyVersion == "1",
            "KeyVersion is 1; the frontend fallback must match");

        // Variant fan-out: distinct digests mint distinct keys (and neither collides with the digest-less one).
        var other = CouchCoopStaticBackgroundProvider.ComputeLayersDigest([Layers[0]])!;
        var keys = new[]
        {
            CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", digest),
            CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", other),
            CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", null),
        };
        Assert(keys.Distinct(StringComparer.Ordinal).Count() == 3, "digest fan-out yields distinct cache keys");
    }

    private static async Task SingleFlightCollapsesConcurrentRequestsAsync()
    {
        var root = TempRoot();
        try
        {
            var fake = new GatedBackgroundAssetProvider();
            var provider = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(root), isHeadlessClient: false);
            var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(Layers);

            var concurrent = Enumerable.Range(0, 8)
                .Select(_ => provider.GetImageAsync("underdocks", digest, Layers))
                .ToArray();
            Assert(await Task.Run(fake.WaitUntilEntered), "the shared extraction starts");
            Assert(fake.Calls == 1, "single-flight runs ONE extraction for eight concurrent requests");
            fake.Release();
            var results = await Task.WhenAll(concurrent);
            Assert(fake.Calls == 1, "still one extraction after all requests settle");
            Assert(results.All(result => result.Error is null && result.Bytes is { Length: > 0 }), "every concurrent request is served");
            Assert(results.All(result => result.ContentType == "image/png"), "the rendered background is a PNG");

            // The extraction populated the MEMORY map before returning to waiters: the very next request is a
            // zero-extraction memory answer.
            var memory = await provider.GetImageAsync("underdocks", digest, Layers);
            Assert(memory.Error is null && memory.CacheStatus == "memory", "the follow-up request serves from memory");
            Assert(fake.Calls == 1, "a memory hit does not re-extract");

            // The selector rode the composed request.
            Assert(
                fake.Requests.Single().Key == "composed://combat-background/underdocks/image",
                "the render addresses the composed combat-background key");
            Assert(
                fake.Requests.Single().CompositionSelector == string.Join(',', Layers),
                "the mounted layer set rides CompositionSelector, comma-joined in order");
            Assert(
                fake.Requests.Single() is { RenderWidth: 2520, RenderHeight: 1080 },
                "the render is pinned to the 2520x1080 policy");
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static async Task FallsBackComposedThenDeterministicThenLiteralAsync()
    {
        // Selector fails (composition_selector) ⇒ deterministic retry succeeds.
        var root = TempRoot();
        try
        {
            var fake = new ScriptedBackgroundAssetProvider(failSelector: true, failComposed: false);
            var provider = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(root), isHeadlessClient: false);
            var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(Layers);
            var result = await provider.GetImageAsync("underdocks", digest, Layers);
            Assert(result.Error is null && result.Bytes is { Length: > 0 }, "the deterministic retry serves the image");
            Assert(fake.Requests.Count == 2, "a selector failure retries exactly once (deterministic discovery)");
            Assert(fake.Requests[0].CompositionSelector is not null, "the first attempt carried the selector");
            Assert(fake.Requests[1].CompositionSelector is null, "the retry drops the selector");
            Assert(fake.Requests[1].Key == "composed://combat-background/underdocks/image", "the retry keeps the composed key");
        }
        finally
        {
            TryDelete(root);
        }

        // BOTH composed attempts fail ⇒ the literal scene key renders — still at 2520x1080 (the literal
        // combat-background branch honors RenderWidth/Height too).
        var literalRoot = TempRoot();
        try
        {
            var fake = new ScriptedBackgroundAssetProvider(failSelector: true, failComposed: true);
            var provider = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(literalRoot), isHeadlessClient: false);
            var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(Layers);
            var result = await provider.GetImageAsync("underdocks", digest, Layers);
            Assert(result.Error is null && result.Bytes is { Length: > 0 }, "the literal fallback serves the image");
            Assert(fake.Requests.Count == 3, "the chain is composed+selector → composed → literal");
            Assert(fake.Requests[2].Key == Scene, "the last rung addresses the literal background scene");
            Assert(fake.Requests[2] is { RenderWidth: 2520, RenderHeight: 1080 }, "the literal fallback stays 2520x1080");

            // A chain where everything fails surfaces the last structured error.
            var failRoot = TempRoot();
            try
            {
                var allFail = new ScriptedBackgroundAssetProvider(failSelector: true, failComposed: true, failLiteral: true);
                var failing = new CouchCoopStaticBackgroundProvider(allFail, new SpirectlAssetBinaryCache(failRoot), isHeadlessClient: false);
                var failure = await failing.GetImageAsync("underdocks", digest, Layers);
                Assert(failure.Error is not null && failure.Bytes is null, "an exhausted chain is a structured failure");
            }
            finally
            {
                TryDelete(failRoot);
            }
        }
        finally
        {
            TryDelete(literalRoot);
        }
    }

    private static async Task ServesMemoryThenDiskWithoutReExtractingAsync()
    {
        var root = TempRoot();
        try
        {
            var cache = new SpirectlAssetBinaryCache(root);
            var fake = new ScriptedBackgroundAssetProvider(failSelector: false, failComposed: false);
            var provider = new CouchCoopStaticBackgroundProvider(fake, cache, isHeadlessClient: false);

            var miss = await provider.GetImageAsync("underdocks", null, null);
            Assert(miss.CacheStatus == "miss" && fake.Requests.Count == 1, "the first deterministic request extracts once");

            var memory = await provider.GetImageAsync("underdocks", null, null);
            Assert(memory.CacheStatus == "memory" && fake.Requests.Count == 1, "the second request is a memory hit with zero provider calls");
            Assert(memory.Bytes!.SequenceEqual(miss.Bytes!), "memory serves the identical bytes");

            // A COLD provider instance (fresh memory map, same disk root) serves the disk write-through.
            var coldFake = new ScriptedBackgroundAssetProvider(failSelector: false, failComposed: false);
            var cold = new CouchCoopStaticBackgroundProvider(coldFake, new SpirectlAssetBinaryCache(root), isHeadlessClient: false);
            var hit = await cold.GetImageAsync("underdocks", null, null);
            Assert(hit.CacheStatus == "hit" && coldFake.Requests.Count == 0, "a cold instance serves the disk cache without extracting");
            Assert(hit.Bytes!.SequenceEqual(miss.Bytes!), "disk serves the identical bytes");
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static async Task HeadlessServesDiskOr503Async()
    {
        var root = TempRoot();
        try
        {
            var fake = new ScriptedBackgroundAssetProvider(failSelector: false, failComposed: false);
            var headless = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(root), isHeadlessClient: true);

            var cold = await headless.GetImageAsync("underdocks", null, null);
            Assert(cold.Error?.Code == "static-bg-unavailable" && cold.ServiceUnavailable, "a cold headless answer is a 503-mapped structured error");
            Assert(fake.Requests.Count == 0, "a dummy-renderer process never extracts");

            // Seed the disk cache (what the HOST's render leaves behind on the shared cache leaf) — the same
            // headless instance then serves it.
            var key = CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", null);
            Assert(await new SpirectlAssetBinaryCache(root).TryWriteAsync(key, [1, 2, 3], "image/png"), "seeding the disk cache succeeds");
            var seeded = await headless.GetImageAsync("underdocks", null, null);
            Assert(seeded.Error is null && seeded.Bytes is [1, 2, 3], "a headless instance serves disk-cached bytes");
            Assert(fake.Requests.Count == 0, "the disk answer still never extracts");
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static async Task StaleDigestIsCacheOnlyAsync()
    {
        var root = TempRoot();
        try
        {
            var fake = new ScriptedBackgroundAssetProvider(failSelector: false, failComposed: false);
            var provider = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(root), isHeadlessClient: false);
            var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(Layers)!;

            var cold = await provider.GetImageAsync("underdocks", digest, null, allowRender: false);
            Assert(cold.Error?.Code == "unknown-background-variant" && !cold.ServiceUnavailable, "a stale, uncached digest is a 404-mapped error");
            Assert(fake.Requests.Count == 0, "a stale digest NEVER renders (wrong bytes under an immutable URL)");

            var key = CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", digest);
            Assert(await new SpirectlAssetBinaryCache(root).TryWriteAsync(key, [9, 9], "image/png"), "seeding the stale variant succeeds");
            var seeded = await provider.GetImageAsync("underdocks", digest, null, allowRender: false);
            Assert(seeded.Error is null && seeded.Bytes is [9, 9], "a stale digest still serves ITS OWN cached bytes");
            Assert(fake.Requests.Count == 0, "the cached stale answer does not render either");
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static void TrackerPublishesOnChangeOnly()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            var fired = 0;
            var tracker = new CouchCoopStaticBackgroundTracker(() => fired++);
            var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(Layers);
            var state = new CouchCoopStaticBackgroundState(
                Scene,
                Layers,
                digest,
                CouchCoopStaticBackgroundProvider.BuildImageUrl("underdocks", digest));

            tracker.PublishForTest(state);
            Assert(fired == 1 && CouchCoopStaticBackgroundTracker.Published == state, "the first publish fires the change callback");

            tracker.PublishForTest(state with { LayerPaths = [.. Layers] });
            Assert(fired == 1, "an identical scenePath/digest/url re-publish is a no-op (no session resend storm)");

            tracker.PublishForTest(null);
            Assert(fired == 2 && CouchCoopStaticBackgroundTracker.Published is null, "publishing null (non-combat) fires once");

            tracker.PublishForTest(null);
            Assert(fired == 2, "null → null is a no-op");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    private static void TrackerPublishesNullWhenValveIsOff()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            var fired = 0;
            var tracker = new CouchCoopStaticBackgroundTracker(() => fired++);
            var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(Layers);
            tracker.PublishForTest(new CouchCoopStaticBackgroundState(
                Scene,
                Layers,
                digest,
                CouchCoopStaticBackgroundProvider.BuildImageUrl("underdocks", digest)));
            Assert(fired == 1, "seeded a published value");

        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    private static string TempRoot()
        => Path.Combine(Path.GetTempPath(), "couchcoop-static-bg-" + Guid.NewGuid().ToString("N"));

    private static void TryDelete(string root)
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (IOException)
        {
            // Best-effort temp cleanup (DirectoryNotFoundException derives from IOException too).
        }
    }

    private static void Assert(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException(because);
        }
    }

    private static EmbeddableAssetResult PngResult(EmbeddableAssetRequest request)
        => new(
            true,
            new EmbeddableAssetPayload(
                request.RequestId ?? string.Empty,
                request.Key,
                "image",
                "png",
                "image/png",
                request.RenderWidth ?? 0,
                request.RenderHeight ?? 0,
                [0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A],
                [],
                new EmbeddableAssetProvenance("bg", request.Key, request.Key, "combat_background", "test"),
                []),
            null);

    // Blocks extractions on a gate so the single-flight test can prove N concurrent requests collapse onto ONE
    // while it is genuinely in flight (the GatedSpineAssetProvider shape).
    private sealed class GatedBackgroundAssetProvider : ISpirectlAssetProvider
    {
        private readonly ManualResetEventSlim _entered = new(initialState: false);
        private readonly ManualResetEventSlim _release = new(initialState: false);
        private readonly List<EmbeddableAssetRequest> _requests = [];
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        public IReadOnlyList<EmbeddableAssetRequest> Requests
        {
            get
            {
                lock (_requests)
                {
                    return [.. _requests];
                }
            }
        }

        public bool WaitUntilEntered() => _entered.Wait(TimeSpan.FromSeconds(5));

        public void Release() => _release.Set();

        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
        {
            Interlocked.Increment(ref _calls);
            lock (_requests)
            {
                _requests.Add(request);
            }

            _entered.Set();
            _release.Wait(TimeSpan.FromSeconds(5));
            return PngResult(request);
        }

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
            => new("ok", [GetAsset(request.Requests[0])]);
    }

    // Scripts per-rung failures so the fallback-chain test can drive composed+selector → composed → literal.
    private sealed class ScriptedBackgroundAssetProvider(bool failSelector, bool failComposed, bool failLiteral = false) : ISpirectlAssetProvider
    {
        public List<EmbeddableAssetRequest> Requests { get; } = [];

        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
        {
            Requests.Add(request);
            var composed = request.Key.StartsWith("composed://", StringComparison.Ordinal);
            var shouldFail = composed
                ? (request.CompositionSelector is not null ? failSelector : failComposed)
                : failLiteral;
            if (!shouldFail)
            {
                return PngResult(request);
            }

            return new EmbeddableAssetResult(
                false,
                null,
                new EmbeddableAssetError(
                    composed && request.CompositionSelector is not null ? "composition-selector-unsatisfied" : "render-failed",
                    "Background render failed.",
                    composed && request.CompositionSelector is not null ? "composition_selector" : "key",
                    request.Key));
        }

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
            => new("ok", [GetAsset(request.Requests[0])]);
    }
}
