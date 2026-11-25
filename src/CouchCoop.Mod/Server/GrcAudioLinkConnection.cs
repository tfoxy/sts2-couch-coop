using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using CouchCoop.Mod.Audio.Host;
using CouchCoop.Mod.Audio.Seat;

namespace CouchCoop.Mod.Server;

internal static class GrcAudioLinkConnection
{
    internal static bool Authorized(CouchCoopHttpRequest request, IPAddress remote, bool seat, string? token)
        => seat && GrcAudioLink.Enabled && IPAddress.IsLoopback(remote) && request.Header("Origin") is null
            && token is { Length: 64 } && request.Header("X-CouchCoop-Pipe-Token") is { Length: 64 } supplied
            && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(token), Encoding.ASCII.GetBytes(supplied));

    internal static async Task AcceptSeatAsync(Stream stream, CouchCoopHttpRequest request, CancellationToken token)
    {
        using var socket = await UpgradeAsync(stream, request, token).ConfigureAwait(false);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var queue = AudioLinkTransport.CreateQueue();
        using var link = GrcAudioLink.Attach(bytes =>
        {
            if (queue.Writer.TryWrite(bytes)) return true;
            stop.Cancel();
            return false;
        });
        await AudioLinkTransport.RunAsync(socket, queue, bytes =>
        {
            if (!link.Input(bytes)) stop.Cancel();
        }, stop, acknowledge: true).ConfigureAwait(false);
    }

    internal static async Task AcceptViewerAsync(Stream stream, CouchCoopHttpRequest request,
        string route, string pipe, string pipeToken, CancellationToken token)
    {
        using var socket = await UpgradeAsync(stream, request, token).ConfigureAwait(false);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
            deadline.CancelAfter(TimeSpan.FromSeconds(10));
            await using var demand = await GrcStreamAudio.SubscribeAsync(route,
                ct => SeatBrowserPipe.ConnectAudioLinkAsync(pipe, pipeToken, ct), deadline.Token).ConfigureAwait(false);
            await socket.SendAsync("{\"kind\":\"ready\"}"u8.ToArray().AsMemory(), WebSocketMessageType.Text, true, stop.Token).ConfigureAwait(false);
            var closed = socket.ReceiveAsync(new byte[1].AsMemory(), stop.Token).AsTask();
            await Task.WhenAny(closed, demand.Completion).ConfigureAwait(false);
            stop.Cancel();
            socket.Abort();
            try { await closed.ConfigureAwait(false); }
            catch (Exception error) when (error is OperationCanceledException or WebSocketException) { }
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or WebSocketException
            or OperationCanceledException or DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
        {
            socket.Abort();
        }
    }

    private static async Task<WebSocket> UpgradeAsync(Stream stream, CouchCoopHttpRequest request, CancellationToken token)
    {
        if (!request.IsWebSocketUpgrade || string.IsNullOrEmpty(request.Header("Sec-WebSocket-Key")))
            throw new IOException("Invalid audio WebSocket upgrade");
        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(
            request.Header("Sec-WebSocket-Key")!.Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        await HttpResponseWriter.WriteRawAsync(stream, 101, "Switching Protocols",
            new Dictionary<string, string> { ["Upgrade"] = "websocket", ["Connection"] = "Upgrade", ["Sec-WebSocket-Accept"] = accept },
            cancellationToken: token).ConfigureAwait(false);
        return WebSocket.CreateFromStream(stream, true, null, TimeSpan.FromSeconds(30));
    }
}
