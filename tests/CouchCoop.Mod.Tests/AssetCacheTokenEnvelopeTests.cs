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
// namespace after it; the browser's service worker drops its durable /res/ store when it moves.
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
            BrowserStateEnvelopeFactory.DescribeGameBuild(CouchCoopCacheRoot.Identity),
            ModAssemblyVersion(),
            SpirectlAssetBinaryCache.SchemaVersion);
        Assert(envelope.AssetCacheToken == expected, "token == Compose(gameBuild, modVersion, assetSchema)");
        Assert(envelope.AssetCacheToken!.StartsWith("cc-", StringComparison.Ordinal), "token has the cc- prefix");
    }

    // Each part of the build identity has to be able to move the token on its own: a rebuild can keep the version
    // string while moving the content hash, a Steam build id moves with no version change at all, and two
    // branches can share a version while rendering different pixels.
    private static void GameBuildFlowsIntoToken()
    {
        var baseline = new CouchCoopCacheIdentity(
            Branch: "public",
            BranchSource: "steamworks",
            SteamBuildId: 23811903,
            GameVersion: "v0.107.1",
            MainAssemblyHash: 1692500715,
            CacheVersion: CouchCoopCacheRoot.CacheVersion,
            AssetPayloadVersion: 1);

        var moved = new (string Name, CouchCoopCacheIdentity Identity)[]
        {
            ("gameVersion", baseline with { GameVersion = "v0.107.2" }),
            ("mainAssemblyHash", baseline with { MainAssemblyHash = 999 }),
            ("steamBuildId", baseline with { SteamBuildId = 24000000 }),
            ("branch", baseline with { Branch = "public-beta" }),
        };

        var reference = Token(baseline);
        foreach (var (name, identity) in moved)
        {
            Assert(Token(identity) != reference, $"a moved {name} yields a different token");
        }

        // And how the branch was LEARNED is not part of the answer — a start where Steam was down reports the
        // same branch through the install manifest, and must not invalidate every phone's cache for it.
        Assert(
            Token(baseline with { BranchSource = "appmanifest" }) == reference,
            "the branch SOURCE does not move the token");
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

    private static string Token(CouchCoopCacheIdentity identity) => AssetCacheToken.Compose(
        BrowserStateEnvelopeFactory.DescribeGameBuild(identity),
        ModAssemblyVersion(),
        SpirectlAssetBinaryCache.SchemaVersion);

    // Recompute the mod assembly version exactly as BrowserStateEnvelopeFactory does, so the expected token matches
    // regardless of the SDK-default version this build resolves to.
    private static string ModAssemblyVersion() =>
        typeof(BrowserStateEnvelopeFactory).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? typeof(BrowserStateEnvelopeFactory).Assembly.GetName().Version?.ToString()
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
