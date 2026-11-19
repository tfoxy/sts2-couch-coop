using System.Buffers.Binary;
using System.Net.WebSockets;
using System.Text;

namespace CouchCoop.Mod.Server.LanRtc;

internal static class LanRtcWebSocketRelay
{
    public static async Task RunAsync(LanRtcHttpStream stream, string? protocol,
        Func<CancellationToken, ValueTask<LanRtcEvent>> receive,
        Func<bool, byte[], CancellationToken, Task> send, CancellationToken token)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        using var socket = WebSocket.CreateFromStream(stream.CreateClientStream(), new WebSocketCreationOptions
        { IsServer = false, SubProtocol = protocol, KeepAliveInterval = Timeout.InfiniteTimeSpan });
        var upload = UploadAsync(socket, receive, stop.Token);
        var download = DownloadAsync(socket, send, stop.Token);
        try
        {
            var first = await Task.WhenAny(upload, download).ConfigureAwait(false);
            await first.ConfigureAwait(false);
            if (first == upload) await download.ConfigureAwait(false);
        }
        finally
        {
            stop.Cancel();
            try { await Task.WhenAll(upload, download).ConfigureAwait(false); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        }
    }

    private static async Task UploadAsync(WebSocket socket,
        Func<CancellationToken, ValueTask<LanRtcEvent>> receive, CancellationToken token)
    {
        WebSocketMessageType? fragmented = null;
        while (true)
        {
            var message = await receive(token).ConfigureAwait(false);
            var data = message.Data;
            if (!message.Binary || data is null || data.Length is < 1 or > 16385)
                throw new InvalidDataException("Invalid WebSocket tunnel frame.");
            var opcode = data[0] & 0x7f;
            var fin = (data[0] & 0x80) != 0;
            if (opcode == 8)
            {
                if (!fin || data.Length is 2 or > 126) throw new InvalidDataException("Invalid close frame.");
                var status = data.Length == 1 ? WebSocketCloseStatus.Empty
                    : (WebSocketCloseStatus)BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(1));
                var reason = data.Length <= 3 ? null : new UTF8Encoding(false, true).GetString(data, 3, data.Length - 3);
                await socket.CloseOutputAsync(status, reason, token).ConfigureAwait(false);
                return;
            }
            var type = opcode switch
            {
                0 when fragmented is not null => fragmented.Value,
                1 when fragmented is null => WebSocketMessageType.Text,
                2 when fragmented is null => WebSocketMessageType.Binary,
                _ => throw new InvalidDataException("Invalid WebSocket continuation.")
            };
            await socket.SendAsync(data.AsMemory(1), type, fin, token).ConfigureAwait(false);
            fragmented = fin ? null : type;
        }
    }

    private static async Task DownloadAsync(WebSocket socket,
        Func<bool, byte[], CancellationToken, Task> send, CancellationToken token)
    {
        var buffer = new byte[16385];
        var initial = true;
        while (true)
        {
            // ManagedWebSocket consumes control pings and writes the masked pong on this private stream.
            var read = await socket.ReceiveAsync(buffer.AsMemory(1), token).ConfigureAwait(false);
            if (read.MessageType == WebSocketMessageType.Close)
            {
                var reason = Encoding.UTF8.GetBytes(socket.CloseStatusDescription ?? "");
                var close = new byte[socket.CloseStatus is null or WebSocketCloseStatus.Empty ? 1 : reason.Length + 3];
                close[0] = 0x88;
                if (close.Length > 1)
                {
                    BinaryPrimitives.WriteUInt16BigEndian(close.AsSpan(1), (ushort)socket.CloseStatus!.Value);
                    reason.CopyTo(close.AsSpan(3));
                }
                await send(true, close, token).ConfigureAwait(false);
                if (socket.State == WebSocketState.CloseReceived)
                    await socket.CloseOutputAsync(socket.CloseStatus ?? WebSocketCloseStatus.Empty,
                        socket.CloseStatusDescription, token).ConfigureAwait(false);
                return;
            }
            buffer[0] = (byte)((initial ? read.MessageType == WebSocketMessageType.Text ? 1 : 2 : 0)
                | (read.EndOfMessage ? 0x80 : 0));
            await send(true, buffer[..(read.Count + 1)], token).ConfigureAwait(false);
            initial = read.EndOfMessage;
        }
    }
}
