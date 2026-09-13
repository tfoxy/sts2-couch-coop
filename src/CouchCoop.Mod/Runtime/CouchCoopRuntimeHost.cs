using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Runtime;

public sealed class CouchCoopRuntimeHost : IDisposable, ICouchCoopCapabilityPolicy, IRuntimeAssetSource, IRuntimeStateSource, IAnimationHintSource, ISemanticActionSource
{
    // The ids spirectl publishes, taken from its own constants rather than re-spelled here: a literal that
    // drifts from the published list reads as "no such capability" and refuses every call behind it, silently.
    // spirectl pins EmbeddableCapabilityIds against the list GetCapabilities() actually returns, so these names
    // are checked by its build, and a capability renamed upstream fails OUR compile instead of our runtime.
    public const string StateCapability = EmbeddableCapabilityIds.State;
    public const string GameModelsCapability = EmbeddableCapabilityIds.GameModels;
    public const string SemanticActionsCapability = EmbeddableCapabilityIds.SemanticActions;
    public const string AssetExtractionCapability = EmbeddableCapabilityIds.AssetExtraction;
    public const string SpineCatalogCapability = EmbeddableCapabilityIds.SpineCatalog;

    /// <summary>
    /// The capability id for baking a spine GEOCLIP (per-part posed geometry) rather than rendering a raster clip.
    /// </summary>
    /// <remarks>
    /// Published by spirectl and guarded on directly. It carried a fallback to
    /// <see cref="AssetExtractionCapability"/> for as long as this id was believed to be unpublished; it was
    /// published all along, so the fallback only ever masked which gate had refused.
    /// </remarks>
    public const string SpineGeoClipBakeCapability = EmbeddableCapabilityIds.SpineGeoClipBake;

    public const string LiveSts2HostCapability = EmbeddableCapabilityIds.LiveSts2Host;
    public const string AnimationHintsCapability = EmbeddableCapabilityIds.AnimationHints;

    // Live runtime scene-tree stream — the transport the mirror renders off. Kept independent of
    // StateCapability: the state path exists only to keep the `session` envelope live.
    public const string SceneCapability = EmbeddableCapabilityIds.SceneWatch;

    private readonly IRuntimeCapabilitySource _capabilitiesSource;
    private readonly IRuntimeAssetSource _assetsSource;
    private readonly IRuntimeStateSource _stateSource;
    private readonly IAnimationHintSource _animationHintSource;
    private readonly IRuntimeSceneDeltaSource _sceneDeltaSource;
    private readonly IGameModelSource _modelSource;
    private readonly ISpineCatalogSource _spineCatalogSource;
    private readonly ISpineGeoClipBaker _spineGeoClipBaker;
    private readonly ISemanticActionSource _actionSource;
    private readonly IRuntimeSceneWatchControlSource _sceneWatchControlSource;
    private readonly IRuntimeMultiplayerConnectionSource _multiplayerConnection;
    private readonly IDisposable? _lifetime;
    private readonly Action<string> _log;
    private readonly Lazy<EmbeddableRuntimeCapabilities> _capabilities;

    public CouchCoopRuntimeHost(CouchCoopRuntimeDependencies runtime, Action<string>? log = null)
    {
        ArgumentNullException.ThrowIfNull(runtime);
        _capabilitiesSource = runtime.Capabilities;
        _assetsSource = runtime.Assets;
        _stateSource = runtime.State;
        _animationHintSource = runtime.AnimationHints;
        _sceneDeltaSource = runtime.SceneDelta;
        _modelSource = runtime.Models;
        _spineCatalogSource = runtime.SpineCatalog;
        _spineGeoClipBaker = runtime.SpineGeoClipBaker;
        _actionSource = runtime.Actions;
        _sceneWatchControlSource = runtime.SceneWatchControls;
        _multiplayerConnection = runtime.MultiplayerConnection ?? EmptyMultiplayerConnectionSource.Instance;
        _lifetime = runtime.Lifetime;
        _log = log ?? (message => Console.Error.WriteLine(message));
        _capabilities = new Lazy<EmbeddableRuntimeCapabilities>(
            DiscoverCapabilities,
            LazyThreadSafetyMode.ExecutionAndPublication);
        Assets = new HostedAssetProvider(this, _assetsSource.Assets);
    }

    public ISpirectlAssetProvider Assets { get; }
    public ISpineGeoClipBaker SpineGeoClipBaker => _spineGeoClipBaker;
    public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request)
        => _assetsSource.GetPresentationAssets(request);
    public IRuntimeSceneWatchControls SceneWatchControls => _sceneWatchControlSource.SceneWatchControls;
    public MultiplayerConnectionSnapshot? GetCurrentMultiplayerConnection()
        => _multiplayerConnection.GetCurrentMultiplayerConnection();
    public IDisposable SubscribeMultiplayerConnection(Action<MultiplayerConnectionSnapshot> onEvent)
        => _multiplayerConnection.SubscribeMultiplayerConnection(onEvent);

    private sealed class EmptyMultiplayerConnectionSource : IRuntimeMultiplayerConnectionSource
    {
        public static EmptyMultiplayerConnectionSource Instance { get; } = new();

        public MultiplayerConnectionSnapshot? GetCurrentMultiplayerConnection() => null;

        public IDisposable SubscribeMultiplayerConnection(Action<MultiplayerConnectionSnapshot> onEvent)
            => EmptySubscription.Instance;

        private sealed class EmptySubscription : IDisposable
        {
            public static EmptySubscription Instance { get; } = new();
            public void Dispose() { }
        }
    }

    public EmbeddableRuntimeCapabilities Capabilities => _capabilities.Value;

    public IReadOnlyList<CouchCoopRuntimeNotice> Notices
        => [.. Capabilities.Capabilities.Select(CouchCoopRuntimeNotice.FromCapability)];

    public bool HasCapability(string capabilityId)
        => TryFindCapability(capabilityId, out var capability) && capability.Supported;

    public CouchCoopRuntimeNotice RequireCapability(string capabilityId)
    {
        if (!TryFindCapability(capabilityId, out var capability))
        {
            var missing = new CouchCoopRuntimeNotice(
                capabilityId,
                Supported: false,
                Provisional: true,
                UnsupportedReason: "The embedded spirectl runtime did not report this capability.");
            LogUnsupported(missing);
            throw new NotSupportedException($"Spirectl capability '{capabilityId}' is not reported.");
        }

        var notice = CouchCoopRuntimeNotice.FromCapability(capability);
        if (!notice.Supported)
        {
            LogUnsupported(notice);
            throw new NotSupportedException(
                $"Spirectl capability '{capabilityId}' is unsupported: {notice.UnsupportedReason ?? "no reason provided"}");
        }

        return notice;
    }

    public EmbeddableRuntimeCapabilities GetCapabilities() => Capabilities;

    public CurrentStateResult GetCurrentState(CurrentStateRequest request)
    {
        RequireCapability(StateCapability);
        return _stateSource.GetCurrentState(request);
    }

    // Subscribe ONCE to the live state watcher; the callback fires on a background thread whenever the
    // game state changes (and is force-refreshed after every accepted action). The browser server caches
    // the latest snapshot and broadcasts it to all clients. Returns the subscription's IDisposable.
    public IDisposable SubscribeCurrentState(
        CurrentStateSubscriptionRequest request,
        Action<CurrentStateWatchEvent> onEvent,
        Action<EmbeddableRuntimeError>? onError = null)
    {
        RequireCapability(StateCapability);
        return _stateSource.SubscribeCurrentState(request, onEvent, onError);
    }

    public IAsyncEnumerable<CurrentStateWatchEvent> WatchCurrentStateAsync(
        CurrentStateSubscriptionRequest request, CancellationToken cancellationToken = default)
    {
        RequireCapability(StateCapability);
        return _stateSource.WatchCurrentStateAsync(request, cancellationToken);
    }

    // Subscribe ONCE to the live Godot-tween timing HINT stream. Distinct from the state and
    // combat-event subscriptions: hints are a hot, ephemeral, non-buffered PRE-ARM signal (no
    // sequence / ring / replay) used only to arm CSS transition timings. The FIRST subscription
    // ENABLES the producer's cheap "lite" capture path; disposing the LAST disables it. onHint fires
    // on the GAME thread at tween finalize, so it MUST be non-blocking (the collector only enqueues
    // into a bounded channel). Returns the subscription's IDisposable.
    public IDisposable SubscribeAnimationHints(
        AnimationHintSubscriptionRequest request,
        Action<TweenAnimationHint> onHint,
        Action<EmbeddableRuntimeError>? onError = null)
    {
        RequireCapability(AnimationHintsCapability);
        return _animationHintSource.SubscribeAnimationHints(request, onHint, onError);
    }

    public IAsyncEnumerable<TweenAnimationHint> WatchAnimationHintsAsync(
        AnimationHintSubscriptionRequest request, CancellationToken cancellationToken = default)
    {
        RequireCapability(AnimationHintsCapability);
        return _animationHintSource.WatchAnimationHintsAsync(request, cancellationToken);
    }

    // Subscribe ONCE to the live scene-DELTA stream (the "mirror" transport). The callback fires on a
    // background thread whenever the live tree changes; the first emission is a Full keyframe, then
    // incremental deltas. Independent of SubscribeCurrentState — a mirror-only deployment never touches
    // the state path.
    public IDisposable SubscribeRuntimeSceneDelta(
        RuntimeSceneSubscriptionRequest request,
        Action<RuntimeSceneDelta> onDelta,
        Action<EmbeddableRuntimeError>? onError = null)
    {
        RequireCapability(SceneCapability);
        return _sceneDeltaSource.SubscribeRuntimeSceneDelta(request, onDelta, onError);
    }

    public ModelCatalogOperationResult GetModels(ModelCatalogRequestSnapshot request)
    {
        RequireCapability(GameModelsCapability);
        return _modelSource.GetModels(request);
    }

    public SpineCatalogOperationResult GetSpineCatalog(SpineCatalogRequestSnapshot request)
    {
        RequireCapability(SpineCatalogCapability);
        return _spineCatalogSource.GetSpineCatalog(request);
    }

    /// <summary>
    /// Bake one (scene, node, animation) into a geoclip artifact DIRECTORY — per-part posed triangles, uvs, tints,
    /// blend mode, draw order and the atlas pages they sample. Forwarded exactly as
    /// <see cref="GetSpineCatalog"/> is, capability guard included.
    /// </summary>
    /// <remarks>
    /// BLOCKING, and NOT callable from the Godot MAIN THREAD: the runtime posts the bake onto that thread and
    /// waits for engine frames, so a call from there cannot make progress. spirectl checks it and answers a
    /// structured error instead of deadlocking, but the check is a belt — the only caller,
    /// <c>CouchCoopGeoclipProvider</c>, offloads with <c>Task.Run</c> behind the extraction gate, and that must
    /// stay that way.
    /// </remarks>
    public SpineGeoClipBakeResultSnapshot BakeSpineGeoClip(SpineGeoClipBakeRequestSnapshot request)
    {
        RequireCapability(SpineGeoClipBakeCapability);
        return _spineGeoClipBaker.BakeSpineGeoClip(request);
    }

    public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request)
    {
        RequireCapability(SemanticActionsCapability);
        return _actionSource.ExecuteAction(request);
    }

    public void Dispose()
    {
        _lifetime?.Dispose();
    }

    private EmbeddableRuntimeCapabilities DiscoverCapabilities()
    {
        var capabilities = _capabilitiesSource.GetCapabilities();
        foreach (var notice in capabilities.Capabilities
                     .Where(capability => !capability.Supported)
                     .Select(CouchCoopRuntimeNotice.FromCapability))
        {
            LogUnsupported(notice);
        }

        return capabilities;
    }

    /// <summary>
    /// Which capability id the geoclip bake is guarded on: the dedicated one when this runtime publishes it at
    /// all (supported or not — an explicitly UNSUPPORTED entry must still be honoured, and
    /// <see cref="RequireCapability"/> is what reports its reason), otherwise
    /// <see cref="AssetExtractionCapability"/>. See <see cref="SpineGeoClipBakeCapability"/> for why the fallback
    /// exists rather than a hard requirement on an id nothing publishes.
    /// </summary>
    private bool TryFindCapability(string capabilityId, out EmbeddableRuntimeCapability capability)
    {
        capability = Capabilities.Capabilities.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, capabilityId, StringComparison.Ordinal))!;
        return capability is not null;
    }

    private void LogUnsupported(CouchCoopRuntimeNotice notice)
    {
        _log(
            "[couch-coop] unsupported spirectl capability "
            + $"id={notice.CapabilityId} supported={notice.Supported} provisional={notice.Provisional} "
            + $"reason={notice.UnsupportedReason ?? "unspecified"}");
    }

    private sealed class HostedAssetProvider(CouchCoopRuntimeHost host, ISpirectlAssetProvider inner) : ISpirectlAssetProvider
    {
        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
        {
            host.RequireCapability(AssetExtractionCapability);
            return inner.GetAsset(request);
        }

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
        {
            host.RequireCapability(AssetExtractionCapability);
            return inner.GetAssets(request);
        }
    }
}
