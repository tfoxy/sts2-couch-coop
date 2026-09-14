using System.Reflection;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Assets;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.Perspective;
using Spirectl.Sts2.Core.Protocol;
using Spirectl.Sts2.Core.Reference;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

// WS-U (M3): the `session` envelope carries the client asset-cache invalidation token, composed from the host's
// GAME BUILD + the mod assembly version + the server asset schema. The native client names its disk-cache
// namespace after it; the BROWSER puts it in the url of every asset it fetches (`?b=`) and drops its durable
// service-worker /res/ store when it moves.
//
// THE URL IS THE INVALIDATOR, and that is what the /bg/ case here exists for. Every asset answer carries
// `Cache-Control: public, max-age=31536000, immutable`, which is true of the bytes and not of the url: a client
// that joined a public-beta host holds that build's atlas under a url THIS build also mints, for a year. A cache
// wipe cannot reach that (the browser's HTTP cache is not the service worker's, and on the plain-HTTP LAN path
// there is no worker at all) — a url that names the build needs no wipe.
//
// The game-build half comes from CouchCoopCacheRoot — the same identity the host keys its OWN on-disk cache on —
// and deliberately NOT from the runtime's reported capabilities, which is what the last case here pins. The
// embedded runtime facade reports GameVersion as the empty string, so composing from it normalized to "unknown"
// and the token never moved when the game updated at all.
internal static class AssetCacheTokenEnvelopeTests
{
    public static void Run()
    {
        // CreateSessionEnvelope reads the host's baseline MaxFps, which on the desktop path hops to the Godot main
        // thread via Callable/Engine — a NATIVE call that SEGFAULTS in a headless test process (this is the runner's
        // known "intermittent segfault"). Arm the captured-baseline fast path so the read is a plain field return and
        // the rest of CreateSessionEnvelope stays fully managed.
        ArmBaselineFastPath();

        EnvelopeCarriesComposedToken();
        GameBuildFlowsIntoToken();
        TheRuntimesReportedVersionIsNotTheSource();
        AssetUrlsTheHostMintsCarryTheSameToken();
    }

    private static void ArmBaselineFastPath()
    {
        var type = typeof(CouchCoopHeadlessVisualSuspender);
        var captured = type.GetField("_baselineCaptured", BindingFlags.NonPublic | BindingFlags.Static);
        var maxFps = type.GetField("_baselineMaxFps", BindingFlags.NonPublic | BindingFlags.Static);
        Assert(captured is not null && maxFps is not null, "visual-suspender baseline fields are reflectable (test hook)");
        maxFps!.SetValue(null, 60);
        captured!.SetValue(null, true);
    }

    private static void EnvelopeCarriesComposedToken()
    {
        var factory = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new StubRuntime("game-42.7"), new StubRuntime("game-42.7"), new StubRuntime("game-42.7"), new StubRuntime("game-42.7"), new StubRuntime("game-42.7"), new StubRuntime("game-42.7"), new StubRuntime("game-42.7"), new StubRuntime("game-42.7"), new StubRuntime("game-42.7"), new StubRuntime("game-42.7"))));
        var envelope = factory.CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();

        Assert(envelope.AssetCacheToken is not null, "session envelope carries an assetCacheToken");

        var expected = AssetCacheToken.Compose(
            CouchCoopAssetVersion.DescribeGameBuild(CouchCoopCacheRoot.Content),
            ModAssemblyVersion(),
            SpirectlAssetBinaryCache.SchemaVersion);
        Assert(envelope.AssetCacheToken == expected, "token == Compose(gameBuild, modVersion, assetSchema)");
        Assert(envelope.AssetCacheToken == CouchCoopAssetVersion.Token, "the envelope publishes THE host token");
        Assert(envelope.AssetCacheToken!.StartsWith("cc-", StringComparison.Ordinal), "token has the cc- prefix");
    }

    // The other consumer of the same token: the /bg/ urls this host mints itself. A background is rendered from
    // the game's own scenes, so the same id and the same layer digest paint different pixels on a different
    // build — and the route promises `immutable` for a year. ONE token for both, because a client that latched
    // the envelope's value and a url that named a different build would disagree about which bytes are current.
    private static void AssetUrlsTheHostMintsCarryTheSameToken()
    {
        var token = CouchCoopAssetVersion.Token;
        var suffix = $"&b={Uri.EscapeDataString(token)}";

        var combat = CouchCoopStaticBackgroundProvider.BuildImageUrl("cultist", "d19e5f");
        Assert(combat.EndsWith(suffix, StringComparison.Ordinal), $"combat /bg/ url carries the build: {combat}");
        Assert(combat.Contains("layers=d19e5f&", StringComparison.Ordinal), "…without disturbing the layers digest");
        Assert(combat.Contains("v=", StringComparison.Ordinal), "…or the url grammar's own version");

        // Digest-less (deterministic) and event variants take it too — every shape the minter has.
        Assert(
            CouchCoopStaticBackgroundProvider.BuildImageUrl("cultist", null).EndsWith(suffix, StringComparison.Ordinal),
            "digest-less /bg/ url carries the build");
        Assert(
            CouchCoopStaticBackgroundProvider
                .BuildImageUrl(StaticBackgroundFamily.Events, "neow", null, "0.0,0.0,1.000")
                .EndsWith(suffix, StringComparison.Ordinal),
            "event /bg/ url carries the build");

        // `b`, not `v`: the /bg/ grammar already spends `v` on itself and /spines/ reserves it as a clip
        // discriminator, so a shared name would collide with a selector the route actually reads.
        Assert(CouchCoopAssetVersion.QueryParameter == "b", "the build rides `b`");
        Assert(CouchCoopAssetVersion.QuerySuffix(hasQuery: false).StartsWith("?b=", StringComparison.Ordinal),
            "a path-only route opens its query");
    }

    // THE TOKEN IS A CONTENT KEY, and it keys on exactly what the host's own cache directory compares
    // (CouchCoopCacheContent). Both halves have to be able to move it on their own: a rebuild can keep the
    // version string while moving the content hash, and the hash is 0 when release_info.json is unreadable.
    //
    // The branch and the Steam build id USED TO BE IN HERE. They are labels for a build rather than statements
    // about its content — and, concretely, the host now resolves the branch only when its cache layout needs it
    // (see CouchCoopCacheRoot), so a token carrying one would come out different depending on whether this host
    // had taken the fast or the slow path. Same build, two tokens, every client re-downloading for nothing.
    private static void GameBuildFlowsIntoToken()
    {
        var baseline = new CouchCoopCacheContent(
            GameVersion: "v0.107.1",
            MainAssemblyHash: 1692500715,
            CacheVersion: CouchCoopCacheRoot.CacheVersion,
            AssetPayloadVersion: 1);

        var moved = new (string Name, CouchCoopCacheContent Content)[]
        {
            ("gameVersion", baseline with { GameVersion = "v0.107.2" }),
            ("mainAssemblyHash", baseline with { MainAssemblyHash = 999 }),
        };

        var reference = Token(baseline);
        foreach (var (name, content) in moved)
        {
            Assert(Token(content) != reference, $"a moved {name} yields a different token");
        }

        // The token is composed from the CONTENT record, so the labels are not merely equal-by-luck — there is
        // nowhere to put them. Pin the shape that guarantees it: two fields, and the same string for two hosts
        // whose branch and build id differ.
        Assert(
            CouchCoopAssetVersion.DescribeGameBuild(baseline) == "v0.107.1/1692500715",
            "the build component is version/hash and nothing else");
    }

    // The bug this replaced: SpirectlRuntimeFacade.GetCapabilities() hardcodes GameVersion to the empty string,
    // so a token composed from it normalized to "unknown" on every real host and never moved on a game update.
    // Two hosts reporting different capability versions must now agree, because neither is consulted.
    private static void TheRuntimesReportedVersionIsNotTheSource()
    {
        var a = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new StubRuntime("v-one"), new StubRuntime("v-one"), new StubRuntime("v-one"), new StubRuntime("v-one"), new StubRuntime("v-one"), new StubRuntime("v-one"), new StubRuntime("v-one"), new StubRuntime("v-one"), new StubRuntime("v-one"), new StubRuntime("v-one"))))
            .CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();
        var b = new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new StubRuntime("v-two"), new StubRuntime("v-two"), new StubRuntime("v-two"), new StubRuntime("v-two"), new StubRuntime("v-two"), new StubRuntime("v-two"), new StubRuntime("v-two"), new StubRuntime("v-two"), new StubRuntime("v-two"), new StubRuntime("v-two"))))
            .CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();

        Assert(a.AssetCacheToken == b.AssetCacheToken, "the runtime's reported version does not feed the token");
    }

    private static string Token(CouchCoopCacheContent content) => AssetCacheToken.Compose(
        CouchCoopAssetVersion.DescribeGameBuild(content),
        ModAssemblyVersion(),
        SpirectlAssetBinaryCache.SchemaVersion);

    // Recompute the mod assembly version exactly as CouchCoopAssetVersion does, so the expected token matches
    // regardless of the SDK-default version this build resolves to.
    private static string ModAssemblyVersion() =>
        typeof(CouchCoopAssetVersion).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(CouchCoopAssetVersion).Assembly.GetName().Version?.ToString()
        ?? "0";

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"AssetCacheTokenEnvelopeTests: {label}");
        }
    }

    // A minimal ISpirectlRuntime whose only meaningful output is the game version (the rest is never exercised by
    // CreateSessionEnvelope — no State capability is declared, so CreateStateV2 returns null before any state pull).
    // `internal` (not private) because HostPerformanceEnvelopeTests builds session envelopes the same way.
    internal sealed class StubRuntime(string gameVersion) : IRuntimeCapabilitySource, IRuntimeAssetSource, IRuntimeStateSource, IAnimationHintSource, IRuntimeSceneDeltaSource, IGameModelSource, ISpineCatalogSource, ISpineGeoClipBaker, ISemanticActionSource, IRuntimeSceneWatchControlSource
    {
        public IRuntimeSceneWatchControls SceneWatchControls => Spirectl.Sts2.Live.Sts2RuntimeSceneWatchControls.Instance;
        public ISpirectlAssetProvider Assets { get; } = new StubAssetProvider();

        public EmbeddableRuntimeCapabilities GetCapabilities()
            => new(
                "spirectl/v1",
                gameVersion,
                "test-bridge",
                "embedded",
                RuntimeAttachmentState.Attached,
                DataSourceKind.Stub,
                Provisional: false,
                [],
                []);

        public CurrentStateResult GetCurrentState(CurrentStateRequest request) => throw new NotSupportedException();

        public IDisposable SubscribeCurrentState(
            CurrentStateSubscriptionRequest request,
            Action<CurrentStateWatchEvent> onEvent,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

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
    }

    internal sealed class StubAssetProvider : ISpirectlAssetProvider
    {
        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
            => new(false, null, new EmbeddableAssetError("missing-asset", "stub"));

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request) => new("ok", []);
    }
}
