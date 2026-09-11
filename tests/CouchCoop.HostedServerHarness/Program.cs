using System.Net;
using System.Text.Json;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.MirrorProtocol.Discovery;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.Perspective;
using Spirectl.Sts2.Core.Protocol;
using Spirectl.Sts2.Core.Reference;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

var options = HarnessOptions.Parse(args);
if (!Directory.Exists(options.StaticRoot))
{
    throw new DirectoryNotFoundException($"Static root does not exist: {options.StaticRoot}");
}

using var stop = new CancellationTokenSource();
void RequestStop()
{
    try
    {
        stop.Cancel();
    }
    catch (ObjectDisposedException)
    {
    }
}

Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    RequestStop();
};
AppDomain.CurrentDomain.ProcessExit += (_, _) => RequestStop();

await using var server = new CouchCoopBrowserServer(
    new StaticSpaFileProvider(options.StaticRoot),
    new FakeAssetAdapter(),
    new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode), new FakeSpirectlRuntime(options.Mode)))),
    bindAddress: IPAddress.Loopback,
    preferredPort: options.Port,
    resourceCacheRoot: Environment.GetEnvironmentVariable("COUCHCOOP_CACHE_ROOT"));

var baseUri = await server.StartAsync(stop.Token).ConfigureAwait(false);
Console.WriteLine(JsonSerializer.Serialize(new { baseUrl = baseUri.ToString() }));
Console.Out.Flush();

// M3 WS-T host-discovery leg: also answer UDP discovery probes on the same port the TCP server chose, so a
// no-args native client on the Connect screen can find this harness at 127.0.0.1:<port>.
await using var discovery = new HostDiscoveryResponder(
    baseUri.Port,
    () => new HostDiscoveryReply("127.0.0.1", baseUri.Port, baseUri.ToString(), "harness", HostDiscovery.ProtocolVersion),
    Console.Error.WriteLine);

_ = Task.Run(async () =>
{
    try
    {
        var line = await Console.In.ReadLineAsync(stop.Token).ConfigureAwait(false);
        if (line is not null)
        {
            stop.Cancel();
        }
    }
    catch (OperationCanceledException)
    {
    }
}, CancellationToken.None);

try
{
    await Task.Delay(Timeout.InfiniteTimeSpan, stop.Token).ConfigureAwait(false);
}
catch (OperationCanceledException)
{
}

await server.StopAsync(CancellationToken.None).ConfigureAwait(false);

internal sealed record HarnessOptions(string StaticRoot, int Port, HarnessMode Mode)
{
    public static HarnessOptions Parse(string[] args)
    {
        var staticRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../frontend/dist"));
        var port = 13337;
        var mode = HarnessMode.Run;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                // The real game launcher passes these headless/bootstrap flags. The harness does not need
                // them, but it must tolerate them so browser join tests can complete the spawn path.
                case "--headless":
                case "-fastmp":
                case "join":
                    break;
                // WS-U (M3) disk-cache e2e leg: FakeAssetAdapter self-detects this flag from the process args and
                // serves a deterministic 1x1 PNG for ANY res:// image key (so a full combat recording's ~N textures
                // all resolve). Tolerated + ignored here (Parse rejects unknown flags); FakeAssetAdapter reads it.
                case "--assets-fake-any":
                    break;
                // Missing-textures-fix e2e leg: "--assets-stall <n>x<seconds>" makes FakeAssetAdapter HOLD the first
                // n asset responses for <seconds> before serving them (reproducing a busy host whose main-thread
                // extraction stalls /res responses). Self-detected by the adapter like --assets-fake-any.
                case "--assets-stall":
                    _ = RequireValue(args, ref index, "--assets-stall");
                    break;
                case "--clientId":
                    _ = RequireValue(args, ref index, "--clientId");
                    break;
                case "--static-root":
                    staticRoot = RequireValue(args, ref index, "--static-root");
                    break;
                case "--port":
                    port = int.Parse(RequireValue(args, ref index, "--port"));
                    break;
                case "--mode":
                    mode = ParseMode(RequireValue(args, ref index, "--mode"));
                    break;
                default:
                    throw new ArgumentException($"Unknown argument: {args[index]}");
            }
        }

        return new HarnessOptions(Path.GetFullPath(staticRoot), port, mode);
    }

    private static string RequireValue(string[] args, ref int index, string name)
    {
        if (index + 1 >= args.Length)
        {
            throw new ArgumentException($"{name} requires a value.");
        }

        index++;
        return args[index];
    }

    private static HarnessMode ParseMode(string value)
        => value.Trim().ToLowerInvariant() switch
        {
            "lobby" => HarnessMode.Lobby,
            "run" => HarnessMode.Run,
            "unsupported" => HarnessMode.Unsupported,
            "unsupported-run" => HarnessMode.UnsupportedRun,
            "singleplayer-ambiguous" => HarnessMode.SingleplayerAmbiguous,
            "singleplayer-safe" => HarnessMode.SingleplayerSafe,
            _ => throw new ArgumentException($"Unknown harness mode: {value}")
        };
}

internal enum HarnessMode
{
    Lobby,
    Run,
    Unsupported,
    UnsupportedRun,
    SingleplayerAmbiguous,
    SingleplayerSafe
}

internal sealed class FakeAssetAdapter : ICouchCoopAssetHttpAdapter
{
    private static readonly byte[] RawTestResource = System.Text.Encoding.UTF8.GetBytes(
        "[gd_resource type=\"AtlasTexture\" format=3]\n");

    // WS-U (M3): when --assets-fake-any is on the process command line, serve a deterministic 1x1 PNG for ANY res://
    // image key (so the disk-cache cold/warm e2e leg resolves a full combat recording's ~N textures identically).
    // Self-detected here (not threaded through HarnessOptions/StartAsync) to keep this edit confined to this adapter.
    private readonly bool _fakeAny = Array.IndexOf(Environment.GetCommandLineArgs(), "--assets-fake-any") >= 0;

    // Missing-textures-fix e2e: "--assets-stall <n>x<seconds>" holds the FIRST n asset responses for <seconds>
    // before serving (simulates the busy-host main-thread extraction stall that wedged untimed HttpRequests).
    // Thread-safe decrement; once the budget is spent every later request serves immediately.
    private static readonly (int Count, int Seconds) Stall = ParseStall();
    private int _stallBudget = Stall.Count;

    private static (int, int) ParseStall()
    {
        var argv = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(argv, "--assets-stall");
        if (i >= 0 && i + 1 < argv.Length)
        {
            var parts = argv[i + 1].Split('x');
            if (parts.Length == 2 && int.TryParse(parts[0], out int n) && int.TryParse(parts[1], out int sec))
            {
                return (n, sec);
            }
        }

        return (0, 0);
    }

    private async Task StallIfArmedAsync(CancellationToken cancellationToken)
    {
        if (Stall.Count > 0 && Interlocked.Decrement(ref _stallBudget) >= 0)
        {
            await Task.Delay(TimeSpan.FromSeconds(Stall.Seconds), cancellationToken);
        }
    }

    private async Task<CouchCoopAssetHttpResponse> ServeFakeAnyAsync(CancellationToken cancellationToken)
    {
        await StallIfArmedAsync(cancellationToken);
        return Cached(OnePng, "image/png");
    }

    public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string opaqueKey, CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw, CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.Equals(opaqueKey, "res://images/icon.ico", StringComparison.Ordinal))
        {
            return Task.FromResult(Cached([0, 0, 1, 0], "image/x-icon"));
        }

        if (string.Equals(opaqueKey, "res://images/packed/common_ui/cursor_default.png", StringComparison.Ordinal)
            || string.Equals(opaqueKey, "res://images/packed/common_ui/cursor_tilted.png", StringComparison.Ordinal))
        {
            return Task.FromResult(Cached([0x89, 0x50, 0x4e, 0x47], "image/png"));
        }

        if (string.Equals(opaqueKey, "res://test-resource.tres", StringComparison.Ordinal))
        {
            // Match the active resource contract: a .tres is Godot-native raw text by default, while consumers
            // that need pixels explicitly opt into the independently-rendered PNG representation.
            return Task.FromResult(format == CouchCoopResourceFormat.Png
                ? Cached(OnePng, "image/png")
                : Cached(RawTestResource, "text/plain; charset=utf-8"));
        }

        // WS-U e2e fallback: any res:// image key → the deterministic 1x1 PNG (identical bytes cold + warm).
        if (_fakeAny && opaqueKey.StartsWith("res://", StringComparison.Ordinal) && IsImageKey(opaqueKey))
        {
            return ServeFakeAnyAsync(cancellationToken);
        }

        return Task.FromResult(CouchCoopAssetHttpResponse.Missing(new CouchCoopAssetHttpError(
            "missing-asset",
            "Asset was not found.",
            "key",
            opaqueKey,
            [
                new EmbeddableAssetNotice("missing-asset", "error", "Fake provider has no asset for this key.", "key")
            ])));
    }

    private static CouchCoopAssetHttpResponse Cached(byte[] payload, string contentType)
        => CouchCoopAssetHttpResponse.Found(
            payload,
            contentType,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Cache-Control"] = "public, max-age=31536000, immutable"
            });

    private static bool IsImageKey(string key)
    {
        var q = key.IndexOf('?');
        var path = q >= 0 ? key[..q] : key;
        return path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".webp", StringComparison.OrdinalIgnoreCase);
    }

    // A deterministic, valid 1x1 opaque-black RGBA PNG built once at startup: Godot decodes it, and it is byte-for-byte
    // identical every call, so the cold and warm cache runs render identical frames. Built with a real zlib IDAT +
    // CRC32 chunks so it is guaranteed decodable (a hand-typed base64 blob risks a wrong CRC → decode failure).
    private static readonly byte[] OnePng = BuildOnePng();

    private static byte[] BuildOnePng()
    {
        byte[] raw = { 0x00, 0x00, 0x00, 0x00, 0xFF }; // [filter=0][R][G][B][A]
        byte[] idat;
        using (var ms = new System.IO.MemoryStream())
        {
            using (var z = new System.IO.Compression.ZLibStream(ms, System.IO.Compression.CompressionLevel.Optimal, leaveOpen: true))
            {
                z.Write(raw, 0, raw.Length);
            }

            idat = ms.ToArray();
        }

        var ihdr = new byte[13];
        ihdr[3] = 1; // width  = 1
        ihdr[7] = 1; // height = 1
        ihdr[8] = 8; // bit depth
        ihdr[9] = 6; // color type RGBA (compression/filter/interlace = 0)

        using var outMs = new System.IO.MemoryStream();
        outMs.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }); // PNG signature
        WriteChunk(outMs, "IHDR", ihdr);
        WriteChunk(outMs, "IDAT", idat);
        WriteChunk(outMs, "IEND", Array.Empty<byte>());
        return outMs.ToArray();
    }

    private static void WriteChunk(System.IO.Stream s, string type, byte[] data)
    {
        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        Span<byte> len = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(len, (uint)data.Length);
        s.Write(len);
        s.Write(typeBytes);
        s.Write(data);
        uint crc = 0xFFFFFFFFu;
        crc = Crc32(crc, typeBytes);
        crc = Crc32(crc, data);
        crc ^= 0xFFFFFFFFu;
        Span<byte> crcBytes = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(crcBytes, crc);
        s.Write(crcBytes);
    }

    private static uint Crc32(uint crc, byte[] data)
    {
        foreach (var b in data)
        {
            crc ^= b;
            for (int i = 0; i < 8; i++)
            {
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
            }
        }

        return crc;
    }
}

internal sealed class FakeSpirectlRuntime : IRuntimeCapabilitySource, IRuntimeAssetSource, IRuntimeStateSource, IAnimationHintSource, IRuntimeSceneDeltaSource, IGameModelSource, ISpineCatalogSource, ISpineGeoClipBaker, ISemanticActionSource, IRuntimeSceneWatchControlSource
{
    private readonly HarnessMode _mode;

    public IRuntimeSceneWatchControls SceneWatchControls { get; } = new NoopSceneWatchControls();

    public FakeSpirectlRuntime(HarnessMode mode)
    {
        _mode = mode;
    }

    public ISpirectlAssetProvider Assets { get; } = new FakeSpirectlAssetProvider();

    public EmbeddableRuntimeCapabilities GetCapabilities()
        => new(
            "spirectl/v1",
            "test-game",
            "test-bridge",
            "embedded",
            RuntimeAttachmentState.Attached,
            DataSourceKind.Stub,
            Provisional: false,
            [
                Capability(CouchCoopRuntimeHost.StateCapability),
                Capability(CouchCoopRuntimeHost.GameModelsCapability),
                Capability(CouchCoopRuntimeHost.SemanticActionsCapability),
                Capability(CouchCoopRuntimeHost.AssetExtractionCapability),
                Capability(CouchCoopRuntimeHost.LiveSts2HostCapability)
            ],
            []);

    public CurrentStateResult GetCurrentState(CurrentStateRequest request)
        => new(
            true,
            new StateSnapshot(
                StateSnapshot.CurrentSchemaVersion,
                "en",
                _mode == HarnessMode.Lobby ? "screens/character_select_screen" : "run",
                _mode == HarnessMode.Lobby ? CreateStateCharacterSelect() : null,
                _mode == HarnessMode.Lobby ? null : CreateStateRun(["Host", "Alice", "Bob"])),
            null);

    // Required by ISpirectlRuntime; unreachable from any route the harness serves.
    public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request) => new("ok", []);

    public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request)
        => new(true, ActionExecutionResult.Success("action:harness:end-turn", request.Kind, "harness semantic action accepted"), null);

    public IDisposable SubscribeCurrentState(
        CurrentStateSubscriptionRequest request,
        Action<CurrentStateWatchEvent> onEvent,
        Action<EmbeddableRuntimeError>? onError = null)
    {
        if (request.EmitInitial && GetCurrentState(new CurrentStateRequest()).State is { } state)
        {
            onEvent(new CurrentStateWatchEvent(
                CurrentStateWatchEventType.Initial,
                1,
                DateTimeOffset.UnixEpoch,
                "fingerprint",
                1,
                state,
                null,
                null));
        }

        return new NoopDisposable();
    }

    public async IAsyncEnumerable<CurrentStateWatchEvent> WatchCurrentStateAsync(
        CurrentStateSubscriptionRequest request,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await Task.CompletedTask;
        yield break;
    }

    // The offline harness never emits combat events; these satisfy the interface with inert no-ops.
    public IDisposable SubscribeCombatEvents(
        CombatEventSubscriptionRequest request,
        Action<CombatWatchEvent> onEvent,
        Action<EmbeddableRuntimeError>? onError = null)
        => new NoopDisposable();

    // The offline harness has no live scene tree; the scene-delta watch is an inert no-op.
    public IDisposable SubscribeRuntimeSceneDelta(
        RuntimeSceneSubscriptionRequest request,
        Action<RuntimeSceneDelta> onDelta,
        Action<EmbeddableRuntimeError>? onError = null)
        => new NoopDisposable();

    public async IAsyncEnumerable<CombatWatchEvent> WatchCombatEventsAsync(
        CombatEventSubscriptionRequest request,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await Task.CompletedTask;
        yield break;
    }

    // The offline harness never emits animation hints; inert no-ops mirroring the combat-event stubs.
    public IDisposable SubscribeAnimationHints(
        AnimationHintSubscriptionRequest request,
        Action<TweenAnimationHint> onHint,
        Action<EmbeddableRuntimeError>? onError = null)
        => new NoopDisposable();

    public async IAsyncEnumerable<TweenAnimationHint> WatchAnimationHintsAsync(
        AnimationHintSubscriptionRequest request,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await Task.CompletedTask;
        yield break;
    }

    public ModelCatalogOperationResult GetModels(ModelCatalogRequestSnapshot request)
    {
        if (request.Family is not "characters" and not "relics")
        {
            return ModelCatalogOperationResult.Failure(
                DataSourceKind.Stub,
                provisional: false,
                request.Family,
                "en",
                ModelCatalogStatus.UnsupportedFamily,
                "unsupported-model-family",
                "Model family is unsupported by the hosted-server harness.",
                []);
        }

        var models = new List<GameModelSnapshot>();
        var missing = new List<string>();
        foreach (var id in request.Ids)
        {
            if (request.Family == "characters" && id is "ironclad" or "silent")
            {
                models.Add(new CharacterGameModelSnapshot(
                    Id: id,
                    Title: id == "ironclad" ? "Ironclad" : "Silent",
                    NameColor: id == "ironclad" ? "#d94124" : "#5bd06c",
                    StartingHp: id == "ironclad" ? 80 : 70,
                    StartingGold: 99,
                    MaxEnergy: 3,
                    EnergyLabelOutlineColor: "#111111",
                    BaseOrbSlotCount: 0,
                    ShouldAlwaysShowStarCounter: false,
                    StartingRelics: id == "ironclad" ? ["burning_blood"] : ["ring_of_the_snake"],
                    CharacterSelectTitle: id == "ironclad" ? "Ironclad" : "Silent",
                    CharacterSelectDesc: id == "ironclad" ? "A sturdy harness character." : "A precise harness character.",
                    UnlockText: null,
                    DialogueColor: "#ffffff",
                    SpeechBubbleColor: "#111111",
                    MapDrawingColor: "#222222",
                    VisualsAssetKey: $"model:character:{id}:visuals",
                    IconAssetKey: $"model:character:{id}:icon",
                    IconOutlineAssetKey: $"model:character:{id}:icon-outline",
                    EnergyCounterAssetKey: $"model:character:{id}:energy",
                    MerchantAnimAssetKey: null,
                    RestSiteAnimAssetKey: null,
                    CharacterSelectBgAssetKey: null,
                    CharacterSelectBgSpineStillAssetKey: null,
                    CharacterSelectIconAssetKey: $"model:character:{id}:select-icon",
                    CharacterSelectLockedIconAssetKey: $"model:character:{id}:select-locked-icon",
                    MapMarkerAssetKey: $"model:character:{id}:map-marker",
                    IconPath: null,
                    IconOutlinePath: null,
                    EnergyCounterPath: null,
                    MerchantAnimPath: null,
                    RestSiteAnimPath: null,
                    CharacterSelectBgPath: null,
                    CharacterSelectIconPath: null,
                    CharacterSelectLockedIconPath: null,
                    MapMarkerPath: null));
            }
            else if (request.Family == "relics" && id is "burning_blood" or "ring_of_the_snake")
            {
                models.Add(new RelicGameModelSnapshot(
                    Id: id,
                    Title: id == "burning_blood" ? "Burning Blood" : "Ring of the Snake",
                    Flavor: "Harness relic flavor.",
                    Description: "Harness relic description.",
                    IconPath: $"res://{id}.png",
                    IconOutlinePath: null,
                    BigIconPath: null,
                    Rarity: "starter",
                    IconAssetKey: $"model:relic:{id}:icon",
                    IconOutlineAssetKey: $"model:relic:{id}:outline",
                    BigIconAssetKey: $"model:relic:{id}:big",
                    PoolId: null,
                    IsTradable: false,
                    IsAllowedInShops: false,
                    HasUponPickupEffect: false,
                    SpawnsPets: false,
                    AddsPet: false,
                    IsStackable: false,
                    MerchantCost: 0,
                    ShowCounter: false,
                    FlashSfx: null));
            }
            else
            {
                missing.Add(id);
            }
        }

        return ModelCatalogOperationResult.Success(
            DataSourceKind.Stub,
            provisional: false,
            request.Family,
            "en",
            missing.Count == 0 ? ModelCatalogStatus.Ok : ModelCatalogStatus.Partial,
            models,
            missing,
            []);
    }

    // The browser harness does not prerender spines or geoclips. Keep the current narrow ports present and make
    // their unsupported result explicit, so adding those ports to CouchCoopRuntimeDependencies never makes the
    // hosted web harness depend on game assets.
    public SpineCatalogOperationResult GetSpineCatalog(SpineCatalogRequestSnapshot request)
        => SpineCatalogOperationResult.Failure(
            DataSourceKind.Stub,
            provisional: false,
            AssetExtractFailureCode.NotImplemented,
            "Spine catalog is not implemented by the hosted-server harness.",
            []);

    public SpineGeoClipBakeResultSnapshot BakeSpineGeoClip(SpineGeoClipBakeRequestSnapshot request)
        => SpineGeoClipBakeResultSnapshot.Failure(
            AssetExtractFailureCode.NotImplemented,
            "Spine geoclip baking is not implemented by the hosted-server harness.",
            []);

    // ISpirectlRuntime requires this member; nothing the harness serves reads game reference data any more, so it
    // answers "unsupported topic" for everything rather than carrying stub payloads no route can reach.
    public ReferenceOperationResult GetReference(ReferenceRequestSnapshot request)
        => ReferenceOperationResult.Success(
            DataSourceKind.Stub,
            provisional: false,
            topic: request.Topic,
            status: ReferenceStatus.UnsupportedTopic,
            payload: null,
            missingKeys: [],
            notices: [new ReferenceNoticeSnapshot("reference-unsupported-topic", "warning", $"Unsupported reference topic '{request.Topic}'.", "topic")]);

    private static EmbeddableRuntimeCapability Capability(string id)
        => new(id, id, Supported: true, Provisional: false, UnsupportedReason: null);

    private static StateCharacterSelectSnapshot CreateStateCharacterSelect()
        => new(
            new StateCharacterSelectLobbySnapshot(
                "multiplayer",
                "Host",
                "Host",
                ConnectingPlayerCount: 0,
                Ascension: 0,
                MaxAscension: 20,
                Act1: "random",
                Seed: null,
                ModifierIds: [],
                Players:
                [
                    new StateCharacterSelectPlayerSnapshot("Host", 0, "ironclad", false, 20, "Host"),
                    new StateCharacterSelectPlayerSnapshot("Alice", 1, "silent", true, 20, "Alice")
                ]),
            CharacterButtons:
            [
                new StateCharacterButtonSnapshot("button:ironclad", "ironclad", false),
                new StateCharacterButtonSnapshot("button:silent", "silent", false)
            ],
            View: new StateCharacterSelectViewSnapshot("Host", null));

    private static StateRunSnapshot CreateStateRun(IReadOnlyList<string> playerIds)
    {
        var players = playerIds
            .Select(playerId => new StateRunPlayerSnapshot(
                playerId,
                "test",
                NetId: null,
                DisplayName: playerId,
                CharacterId: playerId == "Host" ? "ironclad" : "silent",
                IsLocal: playerId == "Host",
                IsHost: playerId == "Host",
                IsRemote: playerId != "Host",
                Creature: null,
                Gold: 99,
                Deck: null,
                Relics: [],
                InventoryComplete: true,
                Notices: []))
            .ToArray();

        return new StateRunSnapshot(
            "test",
            "test",
            "multiplayer",
            "standard",
            "seed:harness",
            AscensionLevel: 0,
            ActId: "act1",
            CurrentActIndex: 0,
            ActFloor: 0,
            TotalFloor: 0,
            BossEncounterId: null,
            SecondBossEncounterId: null,
            CurrentMapCoord: null,
            CurrentMapPointId: null,
            VisitedMapCoords: [],
            Players: players,
            Map: null,
            CurrentRoom: null,
            Notices: [],
            View: new StateRunViewSnapshot("Host", null));
    }

    private sealed class NoopDisposable : IDisposable
    {
        public void Dispose()
        {
        }
    }

    private sealed class NoopSceneWatchControls : IRuntimeSceneWatchControls
    {
        public void SetTweenReplayEnabled(bool enabled) { }
        public void SetCardFlightReplayEnabled(bool enabled) { }
        public void SetHandTweenReplayEnabled(bool enabled) { }
        public void SetTrailReplayEnabled(bool enabled) { }
    }
}

internal sealed class FakeSpirectlAssetProvider : ISpirectlAssetProvider
{
    public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
        => new(false, null, new EmbeddableAssetError("missing-asset", "Asset bytes are supplied by the HTTP harness adapter."));

    public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
        => new("ok", []);
}
