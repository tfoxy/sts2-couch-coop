using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Audio.Seat;
using CouchCoop.Mod.Audio;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Server;

/// <summary>A dedicated, seat-terminated audio socket with no scene send gate.</summary>
internal static class SeatAudioLaneConnection
{
    internal const int MaxInboundBytes = 1024;

    internal static async Task AcceptAsync(Stream stream, CouchCoopHttpRequest request, CancellationToken cancellationToken)
    {
        if (!request.IsWebSocketUpgrade || string.IsNullOrWhiteSpace(request.Header("Sec-WebSocket-Key")))
        {
            await HttpResponseWriter.WriteJsonErrorAsync(stream, HttpStatusCode.BadRequest,
                "invalid-websocket-upgrade", "Missing required WebSocket upgrade headers.", cancellationToken).ConfigureAwait(false);
            return;
        }
        using var subscription = await SeatAudioFeed.OpenAsync().ConfigureAwait(false);
        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(
            request.Header("Sec-WebSocket-Key")!.Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        await HttpResponseWriter.WriteRawAsync(stream, 101, "Switching Protocols",
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Upgrade"] = "websocket", ["Connection"] = "Upgrade", ["Sec-WebSocket-Accept"] = accept
            }, cancellationToken: cancellationToken).ConfigureAwait(false);
        using var socket = WebSocket.CreateFromStream(stream, true, null, TimeSpan.FromSeconds(30));
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        await SendAsync(socket, subscription.Snapshot, subscription.ConnectionId, stop.Token).ConfigureAwait(false);
        var sender = SendLoopAsync(socket, subscription, stop.Token);
        try
        {
            var buffer = new byte[MaxInboundBytes + 1];
            while (!stop.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var result = await socket.ReceiveAsync(buffer.AsMemory(), stop.Token).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "closed", CancellationToken.None)
                        .ConfigureAwait(false);
                    break;
                }
                if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage || result.Count > MaxInboundBytes)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "invalid-audio-message", CancellationToken.None)
                        .ConfigureAwait(false);
                    break;
                }
                // The lane is outbound. Its only inbound controls are a bounded hello and ack.
                try
                {
                    using var document = JsonDocument.Parse(buffer.AsMemory(0, result.Count));
                    var kind = document.RootElement.GetProperty("kind").GetString();
                    if (kind is not ("hello" or "ack")) break;
                }
                catch (JsonException) { break; }
                catch (InvalidOperationException) { break; }
                catch (KeyNotFoundException) { break; }
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or IOException) { }
        finally
        {
            stop.Cancel();
            try { await sender.ConfigureAwait(false); }
            catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or IOException) { }
            AudioDiagnostics.FlushFinal();
        }
    }

    private static async Task SendLoopAsync(WebSocket socket, SeatAudioFeed.Subscription subscription, CancellationToken token)
    {
        while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var message = await subscription.ReadAsync(token).ConfigureAwait(false);
            if (message is null) return;
            await SendAsync(socket, message, subscription.ConnectionId, token).ConfigureAwait(false);
        }
    }

    private static async Task SendAsync(WebSocket socket, object message, long connectionId, CancellationToken token)
    {
        var (seatTUs, keyId, path) = AudioDiagnostics.Enabled ? SeatAudioFeed.Identity(message) : default;
        byte[] bytes = message switch
        {
            SeatAudioSfx sfx => JsonSerializer.SerializeToUtf8Bytes(sfx, ProtocolJsonContext.Default.SeatAudioSfx),
            SeatAudioTmpSfx tmp => JsonSerializer.SerializeToUtf8Bytes(tmp, ProtocolJsonContext.Default.SeatAudioTmpSfx),
            SeatAudioLoop loop => JsonSerializer.SerializeToUtf8Bytes(loop, ProtocolJsonContext.Default.SeatAudioLoop),
            SeatAudioVolumes volumes => JsonSerializer.SerializeToUtf8Bytes(volumes, ProtocolJsonContext.Default.SeatAudioVolumes),
            _ => throw new InvalidOperationException("Unknown seat audio event"),
        };
        if (AudioDiagnostics.Enabled)
            AudioDiagnostics.Trace(new AudioDiagnostics.Mark("seat-send-start", AudioDiagnostics.NowUs(),
                connectionId, seatTUs, keyId, path));
        try
        {
            await socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, token).ConfigureAwait(false);
            if (AudioDiagnostics.Enabled)
                AudioDiagnostics.Trace(new AudioDiagnostics.Mark("seat-send-done", AudioDiagnostics.NowUs(),
                    connectionId, seatTUs, keyId, path));
        }
        finally { AudioDiagnostics.RequestFlush(); }
    }

}
