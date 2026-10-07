using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Audio;
using CouchCoop.Mod.Audio.Delivery;
using CouchCoop.MirrorProtocol.Audio;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Server;

/// <summary>A host-terminated socket; text controls and binary media share one serialized send gate.</summary>
internal static class AudioRenderLaneConnection
{
    internal const int MaxInboundBytes = 1024;
    internal const int RatePerSecond = 64;
    internal const int Burst = 128;
    private static readonly JsonSerializerOptions WireJson = new(JsonSerializerDefaults.Web);

    internal static async Task AcceptAsync(Stream stream, CouchCoopHttpRequest request, AudioService audio, CancellationToken token)
    {
        if (!request.IsWebSocketUpgrade || string.IsNullOrWhiteSpace(request.Header("Sec-WebSocket-Key")))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.BadRequest, "invalid-websocket-upgrade",
                "Missing required WebSocket upgrade headers.", token).ConfigureAwait(false); return;
        }
        using var subscription = audio.Subscribe();
        string accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(
            request.Header("Sec-WebSocket-Key")!.Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        await HttpResponseWriter.WriteRawAsync(stream, 101, "Switching Protocols",
            new Dictionary<string, string> { ["Upgrade"] = "websocket", ["Connection"] = "Upgrade", ["Sec-WebSocket-Accept"] = accept },
            cancellationToken: token).ConfigureAwait(false);
        using var socket = WebSocket.CreateFromStream(stream, true, null, TimeSpan.FromSeconds(30));
        using var sendGate = new SemaphoreSlim(1, 1);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        async Task Send(byte[] bytes, WebSocketMessageType type, CancellationToken ct)
        {
            await sendGate.WaitAsync(ct).ConfigureAwait(false);
            try { await socket.SendAsync(bytes.AsMemory(), type, true, ct).ConfigureAwait(false); }
            finally { sendGate.Release(); }
        }
        Task SendControl(object message, CancellationToken ct) => Send(JsonSerializer.SerializeToUtf8Bytes(message,
            message.GetType(), WireJson), WebSocketMessageType.Text, ct);
        async Task SendClock(ulong hostUs, long? seq, double? clientPerfMs, CancellationToken ct)
        {
            await sendGate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                ulong sentUs = DeadlineSender.HostMicroseconds();
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new AudioClock(hostUs, sentUs, seq, clientPerfMs),
                    WireJson);
                await socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
            }
            finally { sendGate.Release(); }
        }
        await using var sender = new DeadlineSender((bytes, ct) => Send(bytes, WebSocketMessageType.Binary, ct));
        await SendControl(new AudioHello(SoundKey.Schema, audio.Bankset), stop.Token).ConfigureAwait(false);
        for (int i = 0; i < 8; i++)
        {
            ulong t = DeadlineSender.HostMicroseconds();
            await SendClock(t, null, null, stop.Token).ConfigureAwait(false);
        }
        byte[] buffer = new byte[MaxInboundBytes + 1];
        double tokens = Burst;
        ulong last = DeadlineSender.HostMicroseconds();
        uint streamId = 0;
        int outstanding = 0;
        var lanes = new Dictionary<AudioLane, IDisposable>();
        void SetLane(AudioLane lane, bool enabled)
        {
            lock (lanes)
            {
                if (enabled)
                {
                    if (!lanes.ContainsKey(lane)) lanes.Add(lane, audio.SubscribeLane(lane, sender.Enqueue));
                }
                else if (lanes.Remove(lane, out var old)) old.Dispose();
            }
        }
        void OnStreamFailed(string reason)
        {
            _ = Task.Run(async () =>
            {
                try { await SendControl(new AudioUnavailable("", reason), stop.Token).ConfigureAwait(false); }
                catch (Exception) { }
                finally
                {
                    lock (lanes)
                    {
                        foreach (var lane in lanes.Values) lane.Dispose();
                        lanes.Clear();
                    }
                }
            });
        }
        audio.StreamFailed += OnStreamFailed;
        try
        {
            while (!stop.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var result = await socket.ReceiveAsync(buffer.AsMemory(), stop.Token).ConfigureAwait(false);
                ulong receivedUs = DeadlineSender.HostMicroseconds();
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage || result.Count > MaxInboundBytes)
                { await ClosePolicy(socket, "invalid-audio-message"); break; }
                ulong current = receivedUs;
                tokens = Math.Min(Burst, tokens + (current - last) * (RatePerSecond / 1_000_000d)); last = current;
                if (tokens < 1) { await ClosePolicy(socket, "audio-rate-limit"); break; }
                tokens--;
                using var document = JsonDocument.Parse(buffer.AsMemory(0, result.Count));
                var root = document.RootElement;
                if (!root.TryGetProperty("kind", out var kind)) { await ClosePolicy(socket, "invalid-audio-message"); break; }
                switch (kind.GetString())
                {
                    case "clock":
                    {
                        if (!root.TryGetProperty("seq", out var sequence) || !sequence.TryGetInt64(out long seq) ||
                            seq < 0 || seq > 9_007_199_254_740_991L ||
                            !root.TryGetProperty("clientPerfMs", out var clientPerf) ||
                            !clientPerf.TryGetDouble(out double clientPerfMs) ||
                            !double.IsFinite(clientPerfMs) || clientPerfMs < 0)
                        { await ClosePolicy(socket, "invalid-audio-clock"); return; }
                        await SendClock(receivedUs, seq, clientPerfMs, stop.Token).ConfigureAwait(false);
                        continue;
                    }
                    case "play":
                    {
                        string? keyId = root.GetProperty("keyId").GetString();
                        string? key = root.GetProperty("key").GetString();
                        if (keyId is null || key is null || !SoundKey.IsId(keyId) || SoundKey.Id(key) != keyId ||
                            !AudioService.TryParseKey(key, out string path, out _) ||
                            path.StartsWith("event:/music", StringComparison.OrdinalIgnoreCase) ||
                            path.StartsWith("event:/ambience", StringComparison.OrdinalIgnoreCase))
                        { await ClosePolicy(socket, "invalid-sound-key"); return; }
                        uint id = ++streamId;
                        if (Interlocked.Increment(ref outstanding) > 8)
                        { Interlocked.Decrement(ref outstanding); await ClosePolicy(socket, "audio-play-capacity"); return; }
                        _ = DeliverTakeAsync(audio, keyId, key, id, sender, SendControl, stop.Token)
                            .ContinueWith(_ => Interlocked.Decrement(ref outstanding), TaskScheduler.Default);
                        break;
                    }
                    case "lanes":
                        try
                        {
                            SetLane(AudioLane.Music, root.GetProperty("music").GetBoolean());
                            SetLane(AudioLane.Ambience, root.GetProperty("ambience").GetBoolean());
                            SetLane(AudioLane.Loops, root.GetProperty("loops").GetBoolean());
                        }
                        catch (InvalidOperationException)
                        {
                            await SendControl(new AudioUnavailable("", "stream-unavailable"), stop.Token).ConfigureAwait(false);
                        }
                        break;
                    default: await ClosePolicy(socket, "invalid-audio-message"); return;
                }
                await SendClock(receivedUs, null, null, stop.Token).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or IOException or OperationCanceledException or JsonException or KeyNotFoundException or InvalidOperationException) { }
        finally
        {
            audio.StreamFailed -= OnStreamFailed;
            lock (lanes)
            {
                foreach (var lane in lanes.Values) lane.Dispose();
                lanes.Clear();
            }
            stop.Cancel();
        }
    }

    private static async Task DeliverTakeAsync(AudioService audio, string keyId, string key, uint id,
        DeadlineSender sender, Func<object, CancellationToken, Task> control, CancellationToken token)
    {
        try
        {
            bool cold = audio.Cached(keyId) is null;
            ulong due = DeadlineSender.HostMicroseconds() + 100_000;
            if (cold)
            {
                await control(new AudioTakeStart(keyId, id), token).ConfigureAwait(false);
            }
            void OnBlock(byte[] pcm, int block, bool last)
            {
                if (!cold || token.IsCancellationRequested) return;
                int frames = pcm.Length / 4;
                var flags = (block == 0 ? AudioFrameFlags.First : 0) |
                    (last ? AudioFrameFlags.Last : 0);
                sender.Enqueue(new AudioFrame(AudioFrameKind.Take, AudioLane.Take, id, (uint)block,
                    (ushort)frames, flags, due + (ulong)(block * 512L * 1_000_000 / 48_000), 0), pcm);
            }
            await audio.GetTakeAsync(keyId, key, cold ? OnBlock : null).ConfigureAwait(false);
            if (token.IsCancellationRequested) return;
            string url = $"/audio/take/{SoundKey.Schema}/{audio.Bankset}/{keyId}.wav" + CouchCoopAssetVersion.QuerySuffix(false);
            await control(new AudioTakeReady(keyId, id, url), token).ConfigureAwait(false);
        }
        catch (Exception) when (!token.IsCancellationRequested)
        { await control(new AudioUnavailable(keyId, "render-failed"), token).ConfigureAwait(false); }
    }

    private static Task ClosePolicy(WebSocket socket, string reason)
        => socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, reason, CancellationToken.None);
}
