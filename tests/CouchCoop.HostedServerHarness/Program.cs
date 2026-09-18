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
static CouchCoopRuntimeDependencies Dependencies(FakeSpirectlRuntime runtime)
    => new(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime);
if (options.Mode == HarnessMode.IphoneBurstSelfTest)
{
    FakeSpirectlRuntime.AssertIphoneBurstShape();
    await FakeSpirectlRuntime.AssertIphoneBurstFlowAsync();
    Console.WriteLine("iphone-burst-self-test: ok");
    return;
}
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

var diagnostics = options.ArtifactDirectory is null ? null : new BrowserLifecycleDiagnostics(options.ArtifactDirectory);
var runtime = new FakeSpirectlRuntime(options.Mode == HarnessMode.IphoneBurst
    ? HarnessMode.IphoneBurstControl
    : options.Mode);
await using var server = new CouchCoopBrowserServer(
    new StaticSpaFileProvider(options.StaticRoot),
    new FakeAssetAdapter(),
    new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(Dependencies(runtime))),
    bindAddress: IPAddress.Loopback,
    preferredPort: options.Port,
    resourceCacheRoot: Environment.GetEnvironmentVariable("COUCHCOOP_CACHE_ROOT"),
    lifecycleDiagnostics: diagnostics,
    lifecycleSocketRole: options.Mode == HarnessMode.IphoneBurst ? "host" : null,
    onSceneAck: runtime.ReleaseIphoneBurst);

var baseUri = await server.StartAsync(stop.Token).ConfigureAwait(false);
// iphone-burst deliberately owns TWO real browser servers. The control remains alive when the browser enters the
// seat-shaped scene server, matching the production host/seat socket lifetime without launching a game process.
var seatRuntime = options.Mode == HarnessMode.IphoneBurst ? new FakeSpirectlRuntime(HarnessMode.IphoneBurst) : null;
await using var seatServer = options.Mode == HarnessMode.IphoneBurst
    ? new CouchCoopBrowserServer(
        new StaticSpaFileProvider(options.StaticRoot), new FakeAssetAdapter(),
        new BrowserStateEnvelopeFactory(new CouchCoopRuntimeHost(Dependencies(seatRuntime!))),
        bindAddress: IPAddress.Loopback, preferredPort: 0,
        resourceCacheRoot: Environment.GetEnvironmentVariable("COUCHCOOP_CACHE_ROOT"),
        lifecycleDiagnostics: diagnostics, lifecycleSocketRole: "seat",
        onSceneAck: seatRuntime!.ReleaseIphoneBurst)
    : null;
var seatUri = seatServer is null ? null : await seatServer.StartAsync(stop.Token).ConfigureAwait(false);
if (seatUri is not null) server.SyntheticSeatPort = seatUri.Port;
Console.WriteLine(JsonSerializer.Serialize(new { baseUrl = baseUri.ToString(), seatBaseUrl = seatUri?.ToString(), mode = options.Mode.ToString().ToLowerInvariant(), artifactDirectory = options.ArtifactDirectory }));
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
if (seatServer is not null) await seatServer.StopAsync(CancellationToken.None).ConfigureAwait(false);

internal sealed record HarnessOptions(string StaticRoot, int Port, HarnessMode Mode, string? ArtifactDirectory)
{
    public static HarnessOptions Parse(string[] args)
    {
        var staticRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../frontend/dist"));
        var port = 13337;
        var mode = HarnessMode.Run;
        string? artifactDirectory = null;

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--help":
                    Console.WriteLine("HostedServerHarness: --mode iphone-burst --artifact-dir PATH [--static-root PATH] [--port PORT]");
                    Environment.Exit(0);
                    break;
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
                case "--artifact-dir":
                    artifactDirectory = RequireValue(args, ref index, "--artifact-dir");
                    break;
                default:
                    throw new ArgumentException($"Unknown argument: {args[index]}");
            }
        }

        if (mode == HarnessMode.IphoneBurst && string.IsNullOrWhiteSpace(artifactDirectory))
            throw new ArgumentException("--mode iphone-burst requires --artifact-dir PATH.");
        return new HarnessOptions(Path.GetFullPath(staticRoot), port, mode,
            artifactDirectory is null ? null : Path.GetFullPath(artifactDirectory));
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
            "iphone-burst" => HarnessMode.IphoneBurst,
            "iphone-burst-self-test" => HarnessMode.IphoneBurstSelfTest,
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
    SingleplayerSafe,
    IphoneBurst,
    IphoneBurstControl,
    IphoneBurstSelfTest
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

        if (opaqueKey.StartsWith("res://synthetic/iphone/", StringComparison.Ordinal))
        {
            return ServeSyntheticIphonePngAsync(opaqueKey, cancellationToken);
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

    private static async Task<CouchCoopAssetHttpResponse> ServeSyntheticIphonePngAsync(string key, CancellationToken cancellationToken)
    {
        var pieces = (key.Split('/').LastOrDefault() ?? "0-16.png").Split('-', '.', StringSplitOptions.RemoveEmptyEntries);
        _ = int.TryParse(pieces.ElementAtOrDefault(0), out var index);
        _ = int.TryParse(pieces.ElementAtOrDefault(1), out var dimension);
        dimension = dimension is 16 or 24 or 32 or 48 or 64 or 96 ? dimension : 16;
        var delay = index switch { < 6 => 0, < 12 => 50, < 18 => 150, _ => 400 };
        if (delay > 0) await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
        if (index >= 22) await SyntheticBurstResources.FinalGroup.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
        return Cached(BuildPatternPng(dimension, index), "image/png");
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

    private static byte[] BuildPatternPng(int size, int seed)
    {
        var raw = new byte[(size * 4 + 1) * size];
        for (var y = 0; y < size; y++)
        {
            raw[y * (size * 4 + 1)] = 0;
            for (var x = 0; x < size; x++)
            {
                var at = y * (size * 4 + 1) + 1 + x * 4;
                var bright = ((x / 4 + y / 4 + seed) & 1) == 0;
                raw[at] = bright ? (byte)(30 + seed * 7) : (byte)220;
                raw[at + 1] = bright ? (byte)170 : (byte)(30 + seed * 3);
                raw[at + 2] = bright ? (byte)240 : (byte)80;
                raw[at + 3] = 255;
            }
        }
        using var compressed = new System.IO.MemoryStream();
        using (var zlib = new System.IO.Compression.ZLibStream(compressed, System.IO.Compression.CompressionLevel.Fastest, leaveOpen: true)) zlib.Write(raw);
        using var output = new System.IO.MemoryStream();
        output.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
        var ihdr = new byte[13];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(ihdr, (uint)size);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(ihdr.AsSpan(4), (uint)size);
        ihdr[8] = 8; ihdr[9] = 6;
        WriteChunk(output, "IHDR", ihdr); WriteChunk(output, "IDAT", compressed.ToArray()); WriteChunk(output, "IEND", []);
        return output.ToArray();
    }

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
    private Action<RuntimeSceneDelta>? _sceneCallback;
    private int _burstReleased;

    public IRuntimeSceneWatchControls SceneWatchControls { get; } = new NoopSceneWatchControls();

    public FakeSpirectlRuntime(HarnessMode mode)
    {
        _mode = mode;
    }

    public ISpirectlAssetProvider Assets { get; } = new FakeSpirectlAssetProvider();

    public EmbeddableRuntimeCapabilities GetCapabilities()
    {
        var capabilities = new List<EmbeddableRuntimeCapability>
        {
            Capability(CouchCoopRuntimeHost.StateCapability),
            Capability(CouchCoopRuntimeHost.GameModelsCapability),
            Capability(CouchCoopRuntimeHost.SemanticActionsCapability),
            Capability(CouchCoopRuntimeHost.AssetExtractionCapability),
            Capability(CouchCoopRuntimeHost.LiveSts2HostCapability)
        };
        if (_mode == HarnessMode.IphoneBurst)
            capabilities.Insert(1, Capability(CouchCoopRuntimeHost.SceneCapability));

        return new(
            "spirectl/v1",
            "test-game",
            "test-bridge",
            "embedded",
            RuntimeAttachmentState.Attached,
            DataSourceKind.Stub,
            Provisional: false,
            capabilities,
            []);
    }

    public CurrentStateResult GetCurrentState(CurrentStateRequest request)
    {
        var isControlLobby = _mode is HarnessMode.Lobby or HarnessMode.IphoneBurstControl;
        return new(
            true,
            new StateSnapshot(
                StateSnapshot.CurrentSchemaVersion,
                "en",
                isControlLobby ? "screens/character_select_screen" : "run",
                isControlLobby ? CreateStateCharacterSelect() : null,
                isControlLobby ? null : CreateStateRun(["Host", "Alice", "Bob"])),
            null);
    }

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
    {
        _sceneCallback = onDelta;
        if (_mode == HarnessMode.IphoneBurst)
        {
            Console.Error.WriteLine("iphone-burst scene subscription active");
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(80).ConfigureAwait(false);
                    onDelta(BuildIphoneKeyframe());
                    Console.Error.WriteLine("iphone-burst keyframe emitted");
                }
                catch (Exception exception)
                {
                    Console.Error.WriteLine($"iphone-burst keyframe failed: {exception.GetType().Name}: {exception.Message}");
                }
            });
        }
        return new NoopDisposable();
    }

    public void ReleaseIphoneBurst()
    {
        if (_mode != HarnessMode.IphoneBurst || Interlocked.Exchange(ref _burstReleased, 1) != 0) return;
        SyntheticBurstResources.FinalGroup.TrySetResult();
        _ = Task.Run(async () =>
        {
            // The final resource group and the incremental scene change are released only by the first actual
            // browser scene acknowledgement, not a timer.  This is the synthetic slow-Safari survival boundary.
            await Task.Delay(20).ConfigureAwait(false);
            _sceneCallback?.Invoke(BuildIphoneDelta());
        });
    }

    internal static RuntimeSceneDelta BuildIphoneKeyframe()
    {
        var nodes = new List<RuntimeSceneNodeDelta>();
        var order = new List<string>();
        nodes.Add(Node("root", null, "SyntheticRoot", "Control", 0, 0, 1920, 1080, null, null));
        order.Add("root");
        for (var index = 0; index < 64; index++)
        {
            var text = string.Concat(Enumerable.Range(0, 3).Select(offset => char.ConvertFromUtf32(0x0400 + index * 3 + offset)));
            var id = $"text-{index}";
            nodes.Add(Node(id, "root", id, "Label", 40 + (index % 8) * 230, 40 + (index / 8) * 100, 210, 72, text, null));
            order.Add(id);
        }
        foreach (var control in new[] { ("control-panel", "Panel", 120d, 690d), ("control-play", "Button", 390d, 690d), ("control-ready", "Button", 660d, 690d) })
        {
            nodes.Add(Node(control.Item1, "root", control.Item1, control.Item2, control.Item3, control.Item4, 220, 80, control.Item1, null));
            order.Add(control.Item1);
        }
        int[] dimensions = [16, 24, 32, 48, 64, 96];
        for (var index = 0; index < 24; index++)
        {
            var dimension = dimensions[index % dimensions.Length];
            var id = $"image-{index}";
            nodes.Add(Node(id, "root", id, "TextureRect", 30 + (index % 12) * 155, 850 + (index / 12) * 100, 90, 90, null,
                new RuntimeSceneResourceRefSnapshot("texture", $"res://synthetic/iphone/{index}-{dimension}.png", "CompressedTexture2D", id)));
            order.Add(id);
        }
        return new RuntimeSceneDelta(true, "run", "synthetic:iphone-burst", nodes, [], order, TransformSpace: "local");
    }

    internal static RuntimeSceneDelta BuildIphoneDelta()
    {
        var changed = new List<RuntimeSceneNodeDelta>();
        for (var index = 0; index < 8; index++)
            changed.Add(Node($"text-{index}", "root", null, null, 90 + index * 210, 120, 210, 72, $"delta-{index}", null,
                new RuntimeSceneColorSnapshot(index / 8.0, 0.3, 1 - index / 8.0, 1, null)));
        changed.Add(Node("delta-added", "root", "delta-added", "Label", 840, 720, 240, 80, "second-ack", null));
        return new RuntimeSceneDelta(false, "run", "synthetic:iphone-burst", changed, [], null, TransformSpace: "local");
    }

    private static RuntimeSceneNodeDelta Node(string id, string? parent, string? name, string? type, double x, double y, double width, double height, string? text, RuntimeSceneResourceRefSnapshot? texture, RuntimeSceneColorSnapshot? color = null)
        => new(
            id, parent, name, type, null, true, 1, 0, 0, texture, false,
            text is null ? null : new RuntimeSceneTextPropertiesSnapshot(text, text, false, "synthetic", "iphone-burst", null, 28, null, color ?? new RuntimeSceneColorSnapshot(1, 1, 1, 1, "#ffffff"), null, null, null, [], []),
            Modulate: color,
            Transform: new RuntimeSceneTransform2DSnapshot(new RuntimeSceneVector2Snapshot(1, 0), new RuntimeSceneVector2Snapshot(0, 1), new RuntimeSceneVector2Snapshot(x, y)),
            LocalRect: new RuntimeSceneRect2Snapshot(new RuntimeSceneVector2Snapshot(0, 0), new RuntimeSceneVector2Snapshot(width, height)));

    internal static void AssertIphoneBurstShape()
    {
        var frame = BuildIphoneKeyframe();
        if (BrowserSceneDeltaMessage.Serialize(frame).Length == 0) throw new InvalidOperationException("synthetic keyframe serialization");
        if (frame.Upserts.Count(node => node.Text is not null) < 64 || frame.Upserts.Count(node => node.Texture is not null) != 24) throw new InvalidOperationException("synthetic keyframe node count");
        var chars = frame.Upserts.Where(node => node.Text?.Text is not null).SelectMany(node => node.Text!.Text!).ToHashSet();
        if (chars.Count < 192 || !frame.Upserts.Any(node => node.Id == "root" && node.LocalRect?.Size.X == 1920 && node.LocalRect.Size.Y == 1080)) throw new InvalidOperationException("synthetic keyframe dimensions or character diversity");
        if (frame.Upserts.Where(node => node.Texture is not null).Select(node => node.Texture!.ResourcePath.Split('-', '.')[1]).Distinct().Count() != 6) throw new InvalidOperationException("synthetic texture dimensions");
        var delta = BuildIphoneDelta();
        if (BrowserSceneDeltaMessage.Serialize(delta).Length == 0) throw new InvalidOperationException("synthetic delta serialization");
        if (delta.Full || delta.Upserts.Count < 9 || delta.Upserts.All(node => node.Id != "delta-added")) throw new InvalidOperationException("synthetic incremental delta");
    }

    internal static async Task AssertIphoneBurstFlowAsync()
    {
        var runtime = new FakeSpirectlRuntime(HarnessMode.IphoneBurst);
        var first = new TaskCompletionSource<RuntimeSceneDelta>(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new TaskCompletionSource<RuntimeSceneDelta>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var subscription = runtime.SubscribeRuntimeSceneDelta(
            new RuntimeSceneSubscriptionRequest(),
            delta => (delta.Full ? first : second).TrySetResult(delta));
        if (!(await first.Task.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false)).Full)
            throw new InvalidOperationException("synthetic first scene was not a keyframe");
        runtime.ReleaseIphoneBurst();
        if ((await second.Task.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false)).Full)
            throw new InvalidOperationException("synthetic second scene was not incremental");
    }

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
                "p:1",
                "p:1",
                ConnectingPlayerCount: 0,
                Ascension: 0,
                MaxAscension: 20,
                Act1: "random",
                Seed: null,
                ModifierIds: [],
                Players:
                [
                    new StateCharacterSelectPlayerSnapshot("p:1", 0, "ironclad", false, 20, "Host"),
                    new StateCharacterSelectPlayerSnapshot("p:1002", 1, "silent", true, 20, "Alice", IsConnected: false)
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

internal static class SyntheticBurstResources
{
    public static TaskCompletionSource FinalGroup { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed class FakeSpirectlAssetProvider : ISpirectlAssetProvider
{
    public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
        => new(false, null, new EmbeddableAssetError("missing-asset", "Asset bytes are supplied by the HTTP harness adapter."));

    public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
        => new("ok", []);
}
