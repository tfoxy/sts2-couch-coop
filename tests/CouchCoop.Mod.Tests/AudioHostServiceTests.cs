using CouchCoop.Mod.Audio;
using CouchCoop.Mod.Audio.Delivery;
using CouchCoop.Mod.Audio.Takes;
using CouchCoop.Mod.Server;
using CouchCoop.MirrorProtocol.Audio;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Net.WebSockets;
using CouchCoop.Mod.Audio.Render;
using CouchCoop.Mod.Runtime;

internal static class AudioHostServiceTests
{
    internal static async Task RunAsync()
    {
        KeyAndWaveValidation();
        CacheBoundsAndQuotaFallback();
        await RouteHeadersAndRefusals();
        await AudioOffHasNoRoutes();
        await RenderLaneValidationAndDedup();
        await ProgressiveFirstBlock();
        await ProgressiveFirstBlockOverSocket();
        await DisconnectedListenerDoesNotAbortSharedTake();
        ShutdownBalancesDemand();
        await DeadlineOrderingAndBounds();
    }

    private static void KeyAndWaveValidation()
    {
        if (!AudioService.TryParseKey("event:/sfx/card_draw", out var path, out var parameters) ||
            path != "event:/sfx/card_draw" || parameters.Length != 0 ||
            AudioService.TryParseKey("event:/sfx/../music", out _, out _) ||
            AudioService.TryParseKey("event:/music/act1", out _, out _) ||
            AudioService.TryParseKey("event:/sfx/ambience/act1", out _, out _) ||
            AudioService.TryParseKey("event:/sfx/card|z=1,a=2", out _, out _))
            throw new Exception("Audio key validation failed");
        byte[] wave = AudioService.Wav(new byte[8]);
        if (wave.Length != 52 || !wave.AsSpan(0, 4).SequenceEqual("RIFF"u8))
            throw new Exception("Audio WAV header failed");
    }

    private static void CacheBoundsAndQuotaFallback()
    {
        string root = Path.Combine(Path.GetTempPath(), "audio-cache-tests-" + Guid.NewGuid().ToString("N"));
        try
        {
            var quota = new ManagedCacheQuota(root, [root], ceilingBytes: 0, freeSpaceReserveBytes: 0,
                freeSpace: _ => 0);
            var cache = new TakeCache(root, quota, memoryLimit: 120);
            string bank = new('a', 32), one = new('1', 32), two = new('2', 32);
            byte[] wav = AudioService.Wav(new byte[20]);
            cache.Put(bank, one, wav);
            if (cache.Get(bank, one) is null || cache.MemoryCount != 1) throw new Exception("Quota fallback lost memory take");
            cache.Put(bank, two, wav);
            if (cache.MemoryBytes > 120 || cache.Get(bank, one) is not null || cache.Get(bank, two) is null)
                throw new Exception("Audio cache LRU bound failed");
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }
    }

    private static async Task DeadlineOrderingAndBounds()
    {
        var seen = new List<uint>();
        ulong current = 1_000_000;
        await using var sender = new DeadlineSender((bytes, _) =>
        {
            if (!AudioFrame.TryDecode(bytes, out var frame)) throw new Exception("Invalid queued audio frame");
            lock (seen) seen.Add(frame.BlockIndex);
            return Task.CompletedTask;
        }, () => Volatile.Read(ref current));
        byte[] pcm = new byte[512 * 4];
        sender.Enqueue(Frame(2, 1_500_000), pcm);
        sender.Enqueue(Frame(1, 1_450_000), pcm);
        await Task.Delay(20);
        lock (seen) if (seen.Count != 0) throw new Exception("Audio was released earlier than due minus 100 ms");
        Volatile.Write(ref current, 1_400_000);
        sender.Enqueue(Frame(0, 1_400_000), pcm);
        await Task.Delay(20);
        lock (seen) if (seen.Count == 0 || seen[0] != 0) throw new Exception("Audio due ordering failed");
        for (uint i = 0; i < 1000; i++) sender.Enqueue(Frame(i + 10, 4_000_000), pcm);
        if (sender.Queued > 400) throw new Exception("Audio queue byte bound failed");
    }

    private static AudioFrame Frame(uint index, ulong due) =>
        new(AudioFrameKind.Lane, AudioLane.Music, 0, index, 512, AudioFrameFlags.None, due, 0);

    private static async Task RouteHeadersAndRefusals()
    {
        string root = Path.Combine(Path.GetTempPath(), "audio-route-tests-" + Guid.NewGuid().ToString("N"));
        string bank = new('a', 32), key = new('b', 32);
        Directory.CreateDirectory(Path.Combine(root, "audio", "1", bank));
        File.WriteAllBytes(Path.Combine(root, "audio", "1", bank, key + ".wav"), AudioService.Wav(new byte[8]));
        try
        {
            using var service = new AudioService("unused", versionRoot: root, banksetOverride: bank);
            var route = new AudioHttpRoutes(() => service);
            var take = await Dispatch(route, $"/audio/take/1/{bank}/{key}.wav");
            if (!take.Contains("200 OK") || !take.Contains("Content-Type: audio/wav") ||
                !take.Contains("public, max-age=2592000, immutable")) throw new Exception("Take route headers failed");
            var index = await Dispatch(route, "/audio/takes");
            if (!index.Contains("\"schema\":1") || !index.Contains("\"bankset\":\"" + bank + "\"") ||
                !index.Contains(key)) throw new Exception("Take index failed");
            if (!(await Dispatch(route, $"/audio/take/1/{bank}/bad.wav")).Contains("400 BadRequest") ||
                !(await Dispatch(route, $"/audio/take/1/{new string('c', 32)}/{key}.wav")).Contains("400 BadRequest"))
                throw new Exception("Take route refusal failed");
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static async Task<string> Dispatch(AudioHttpRoutes route, string path)
    {
        await using var input = new MemoryStream(Encoding.ASCII.GetBytes($"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n"));
        var request = await CouchCoopHttpRequest.TryReadAsync(input) ?? throw new Exception("HTTP parse failed");
        await using var output = new MemoryStream();
        if (!await route.TryHandleAsync(output, request, CancellationToken.None)) throw new Exception("Audio route did not handle request");
        return Encoding.ASCII.GetString(output.ToArray());
    }

    private static async Task AudioOffHasNoRoutes()
    {
        string? original = Environment.GetEnvironmentVariable("COUCHCOOP_AUDIO");
        string root = Path.Combine(Path.GetTempPath(), "audio-off-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            Environment.SetEnvironmentVariable("COUCHCOOP_AUDIO", "off");
            await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root), new MissingAssets(),
                bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: false);
            Uri address = await server.StartAsync();
            using var client = new TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, address.Port);
            await using var connection = client.GetStream();
            await connection.WriteAsync(Encoding.ASCII.GetBytes("GET /audio/takes HTTP/1.1\r\nHost: localhost\r\n\r\n"));
            using var response = new MemoryStream();
            await connection.CopyToAsync(response);
            if (!Encoding.ASCII.GetString(response.ToArray()).Contains("404 NotFound"))
                throw new Exception("Audio off exposed route");
        }
        finally
        {
            Environment.SetEnvironmentVariable("COUCHCOOP_AUDIO", original);
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class MissingAssets : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(string key,
            CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
            => Task.FromResult(CouchCoopAssetHttpResponse.Missing(new CouchCoopAssetHttpError(
                "missing", "missing", "key", key, [])));
    }

    private static async Task RenderLaneValidationAndDedup()
    {
        string root = Path.Combine(Path.GetTempPath(), "audio-ws-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var backend = new FakeBackend();
        using var service = new AudioService("unused", () => backend, banksetOverride: new string('a', 32));
        try
        {
            await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root), new MissingAssets(),
                bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: false,
                injectedAudioService: service);
            Uri address = await server.StartAsync();
            var endpoint = new UriBuilder(address) { Scheme = "ws", Path = "/audio" }.Uri;
            using var first = new ClientWebSocket();
            using var second = new ClientWebSocket();
            await first.ConnectAsync(endpoint, CancellationToken.None);
            await second.ConnectAsync(endpoint, CancellationToken.None);
            string hello = await ReceiveText(first);
            if (!hello.Contains("\"kind\":\"hello\"") || !hello.Contains("\"bankset\""))
                throw new Exception("Render lane hello wire casing failed");
            _ = await ReceiveText(second);
            byte[] sample = "{\"kind\":\"clock\",\"seq\":42,\"clientPerfMs\":1234.25}"u8.ToArray();
            await first.SendAsync(sample, WebSocketMessageType.Text, true, CancellationToken.None);
            using (var echoed = await AwaitClock(first, 42))
            {
                var clock = echoed.RootElement;
                if (clock.GetProperty("kind").GetString() != "clock" ||
                    clock.GetProperty("seq").GetInt64() != 42 ||
                    clock.GetProperty("clientPerfMs").GetDouble() != 1234.25 ||
                    clock.GetProperty("hostUs").GetUInt64() == 0 ||
                    clock.GetProperty("sentUs").GetUInt64() < clock.GetProperty("hostUs").GetUInt64())
                    throw new Exception("Clock echo fields or stamps failed");
            }
            byte[] maximum = Encoding.UTF8.GetBytes(Encoding.ASCII.GetString(sample) +
                new string(' ', AudioRenderLaneConnection.MaxInboundBytes - sample.Length));
            await first.SendAsync(maximum, WebSocketMessageType.Text, true, CancellationToken.None);
            using (var echoed = await AwaitClock(first, 42))
                if (echoed.RootElement.GetProperty("clientPerfMs").GetDouble() != 1234.25)
                    throw new Exception("Maximum-length clock was refused");
            string key = "event:/sfx/card_draw", id = SoundKey.Id(key);
            byte[] play = Encoding.UTF8.GetBytes($"{{\"kind\":\"play\",\"keyId\":\"{id}\",\"key\":\"{key}\"}}");
            await first.SendAsync(play, WebSocketMessageType.Text, true, CancellationToken.None);
            await second.SendAsync(play, WebSocketMessageType.Text, true, CancellationToken.None);
            await AwaitReady(first);
            await AwaitReady(second);
            if (backend.Renders != 1) throw new Exception("Concurrent cold key rendered more than once");
            using var invalid = new ClientWebSocket();
            await invalid.ConnectAsync(endpoint, CancellationToken.None);
            await invalid.SendAsync(new byte[] { 1 }, WebSocketMessageType.Binary, true, CancellationToken.None);
            if (await AwaitClose(invalid) != WebSocketCloseStatus.PolicyViolation)
                throw new Exception("Binary inbound was accepted");
            using var oversized = new ClientWebSocket();
            await oversized.ConnectAsync(endpoint, CancellationToken.None);
            await oversized.SendAsync(new byte[1025], WebSocketMessageType.Text, true, CancellationToken.None);
            if (await AwaitClose(oversized) != WebSocketCloseStatus.PolicyViolation)
                throw new Exception("Oversized inbound was accepted");
            using var flood = new ClientWebSocket();
            await flood.ConnectAsync(endpoint, CancellationToken.None);
            byte[] clockBurst = "{\"kind\":\"clock\",\"seq\":0,\"clientPerfMs\":0}"u8.ToArray();
            for (int i = 0; i < 140; i++)
            {
                try { await flood.SendAsync(clockBurst, WebSocketMessageType.Text, true, CancellationToken.None); }
                catch (WebSocketException) { break; }
            }
            if (await AwaitClose(flood) != WebSocketCloseStatus.PolicyViolation)
                throw new Exception("Render lane rate burst was accepted");
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static async Task<string> ReceiveText(ClientWebSocket socket)
    {
        byte[] buffer = new byte[4096];
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, deadline.Token);
            if (result.MessageType == WebSocketMessageType.Text)
                return Encoding.UTF8.GetString(buffer, 0, result.Count);
        }
    }

    private static async Task<System.Text.Json.JsonDocument> AwaitClock(ClientWebSocket socket, long seq)
    {
        for (int i = 0; i < 32; i++)
        {
            var document = System.Text.Json.JsonDocument.Parse(await ReceiveText(socket));
            if (document.RootElement.TryGetProperty("seq", out var found) && found.GetInt64() == seq)
                return document;
            document.Dispose();
        }
        throw new Exception("Clock echo not received");
    }

    private static async Task AwaitReady(ClientWebSocket socket)
    {
        for (int i = 0; i < 64; i++)
            if ((await ReceiveText(socket)).Contains("\"kind\":\"take-ready\"")) return;
        throw new Exception("No take-ready control received");
    }

    private static async Task<WebSocketCloseStatus?> AwaitClose(ClientWebSocket socket)
    {
        byte[] buffer = new byte[4096];
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, deadline.Token);
            if (result.MessageType == WebSocketMessageType.Close) return result.CloseStatus;
        }
    }

    private sealed class FakeBackend : IFmodRenderBackend
    {
        private int renders;
        public int Renders => Volatile.Read(ref renders);
        public TakeResult Render(TakeRequest request, IAudioBlockSink sink)
        {
            Interlocked.Increment(ref renders);
            sink.OnBlock(new byte[512 * 4], 0, true);
            return new TakeResult(request.KeyId, 512, 100, 0, 0, 0, false);
        }
        public void Dispose() { }
    }

    private static async Task ProgressiveFirstBlock()
    {
        using var release = new ManualResetEventSlim();
        var first = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var service = new AudioService("unused", () => new BlockingBackend(release), banksetOverride: new string('a', 32));
        using var subscriber = service.Subscribe();
        string key = "event:/sfx/progressive", id = SoundKey.Id(key);
        try
        {
            Task<byte[]> completed = service.GetTakeAsync(id, key, (pcm, index, _) =>
            {
                if (index == 0 && pcm.Length == 512 * 4) first.TrySetResult(true);
            });
            await first.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (completed.IsCompleted) throw new Exception("First block waited for completed take");
            release.Set();
            byte[] wav = await completed.WaitAsync(TimeSpan.FromSeconds(5));
            if (wav.Length != 44 + 2 * 512 * 4) throw new Exception("Progressive take was not assembled");
        }
        finally { release.Set(); }
    }

    private sealed class BlockingBackend(ManualResetEventSlim release) : IFmodRenderBackend
    {
        public TakeResult Render(TakeRequest request, IAudioBlockSink sink)
        {
            sink.OnBlock(new byte[512 * 4], 0, false);
            if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Progressive render release timed out");
            sink.OnBlock(new byte[512 * 4], 1, true);
            return new TakeResult(request.KeyId, 1024, 100, 0, 0, 0, false);
        }
        public void Dispose() { }
    }

    private static void ShutdownBalancesDemand()
    {
        var service = new AudioService("unused", () => new FakeBackend(), banksetOverride: new string('a', 32));
        var first = service.Subscribe();
        var second = service.Subscribe();
        if (!ZeroClientGuard.HasDemand) throw new Exception("Audio subscriptions did not establish demand");
        service.Dispose();
        if (ZeroClientGuard.HasDemand) throw new Exception("Audio shutdown retained demand");
        first.Dispose(); second.Dispose();
        if (ZeroClientGuard.HasDemand) throw new Exception("Late audio disconnect unbalanced demand");
    }

    private static async Task ProgressiveFirstBlockOverSocket()
    {
        string root = Path.Combine(Path.GetTempPath(), "audio-progressive-ws-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        using var release = new ManualResetEventSlim();
        using var service = new AudioService("unused", () => new BlockingBackend(release), banksetOverride: new string('a', 32));
        try
        {
            await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root), new MissingAssets(),
                bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: false,
                injectedAudioService: service);
            var endpoint = new UriBuilder(await server.StartAsync()) { Scheme = "ws", Path = "/audio" }.Uri;
            using var socket = new ClientWebSocket();
            await socket.ConnectAsync(endpoint, CancellationToken.None);
            string key = "event:/sfx/slow", id = SoundKey.Id(key);
            byte[] play = Encoding.UTF8.GetBytes($"{{\"kind\":\"play\",\"keyId\":\"{id}\",\"key\":\"{key}\"}}");
            await socket.SendAsync(play, WebSocketMessageType.Text, true, CancellationToken.None);
            bool started = false, firstBlock = false;
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            byte[] buffer = new byte[4096];
            while (!firstBlock)
            {
                var result = await socket.ReceiveAsync(buffer, deadline.Token);
                if (result.MessageType == WebSocketMessageType.Text)
                {
                    string message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    if (message.Contains("\"kind\":\"take-ready\"")) throw new Exception("Take-ready preceded first block");
                    if (message.Contains("\"kind\":\"take-start\"")) started = true;
                }
                else if (result.MessageType == WebSocketMessageType.Binary)
                {
                    if (!started || !AudioFrame.TryDecode(buffer.AsSpan(0, result.Count), out var frame) ||
                        frame.Kind != AudioFrameKind.Take || frame.BlockIndex != 0)
                        throw new Exception("First take block lacked start control");
                    firstBlock = true;
                }
            }
            release.Set();
            await AwaitReady(socket);
        }
        finally { release.Set(); Directory.Delete(root, recursive: true); }
    }

    private static async Task DisconnectedListenerDoesNotAbortSharedTake()
    {
        using var begin = new ManualResetEventSlim();
        var backend = new GatedBackend(begin);
        using var service = new AudioService("unused", () => backend, banksetOverride: new string('a', 32));
        using var first = service.Subscribe();
        using var second = service.Subscribe();
        string key = "event:/sfx/shared", id = SoundKey.Id(key);
        int received = 0;
        try
        {
            Task<byte[]> left = service.GetTakeAsync(id, key, (_, _, _) => throw new ObjectDisposedException("left socket"));
            Task<byte[]> right = service.GetTakeAsync(id, key, (_, _, _) => Interlocked.Increment(ref received));
            begin.Set();
            await Task.WhenAll(left, right).WaitAsync(TimeSpan.FromSeconds(5));
            if (backend.Renders != 1 || received != 2)
                throw new Exception("Disconnected listener aborted or duplicated shared take");
        }
        finally { begin.Set(); }
    }

    private sealed class GatedBackend(ManualResetEventSlim begin) : IFmodRenderBackend
    {
        private int renders;
        public int Renders => Volatile.Read(ref renders);
        public TakeResult Render(TakeRequest request, IAudioBlockSink sink)
        {
            Interlocked.Increment(ref renders);
            if (!begin.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Shared render gate timed out");
            sink.OnBlock(new byte[512 * 4], 0, false);
            sink.OnBlock(new byte[512 * 4], 1, true);
            return new TakeResult(request.KeyId, 1024, 100, 0, 0, 0, false);
        }
        public void Dispose() { }
    }
}
