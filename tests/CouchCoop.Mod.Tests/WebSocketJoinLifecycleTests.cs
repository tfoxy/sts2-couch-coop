using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Tests;

internal static class WebSocketJoinLifecycleTests
{
    public static async Task RunAsync()
    {
        await CloseCancelsHeldJoinOverRealWebSocketAsync();
        await FaultsAreObservedAndDoNotBlockRetryAsync();
        await ClosedOperationRefusesNewWorkAsync();
        await FaultObserverCannotPreventTeardownAsync();
    }

    private static async Task CloseCancelsHeldJoinOverRealWebSocketAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var endpoint = (IPEndPoint)listener.LocalEndpoint;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lateReply = false;
        var rejectedSecondJoin = false;

        var server = Task.Run(async () =>
        {
            using var client = await listener.AcceptTcpClientAsync(timeout.Token);
            await using var stream = client.GetStream();
            var request = await ReadHeadersAsync(stream, timeout.Token);
            var key = request.Split("Sec-WebSocket-Key: ", StringSplitOptions.None)[1]
                .Split("\r\n", StringSplitOptions.None)[0];
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(
                key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            await stream.WriteAsync(Encoding.ASCII.GetBytes(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                + accept + "\r\n\r\n"), timeout.Token);
            using var socket = WebSocket.CreateFromStream(stream, true, null, TimeSpan.FromSeconds(3));
            using var join = new ConnectionJoinOperation();
            var buffer = new byte[256];
            while (true)
            {
                var frame = await socket.ReceiveAsync(buffer, timeout.Token);
                if (frame.MessageType == WebSocketMessageType.Close) break;
                if (!join.TryStart(timeout.Token, async token =>
                    {
                        started.TrySetResult();
                        try { await Task.Delay(Timeout.InfiniteTimeSpan, token); lateReply = true; }
                        catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
                    }))
                    rejectedSecondJoin = true;
            }
            await join.CancelAndWaitAsync();
            if (socket.State == WebSocketState.CloseReceived)
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "closed", timeout.Token);
        }, timeout.Token);

        using var browser = new ClientWebSocket();
        await browser.ConnectAsync(new Uri($"ws://127.0.0.1:{endpoint.Port}/ws"), timeout.Token);
        await browser.SendAsync(Encoding.UTF8.GetBytes("join"), WebSocketMessageType.Text, true, timeout.Token);
        await started.Task.WaitAsync(timeout.Token);
        await browser.SendAsync(Encoding.UTF8.GetBytes("join"), WebSocketMessageType.Text, true, timeout.Token);
        await browser.CloseAsync(WebSocketCloseStatus.NormalClosure, "closed", timeout.Token);
        await server.WaitAsync(timeout.Token);
        listener.Stop();

        Assert(rejectedSecondJoin, "a pending join rejects a second join on the same socket");
        Assert(cancelled.Task.IsCompleted, "close cancels a held join promptly");
        Assert(!lateReply, "cancelled join never produces a late reply");
    }

    private static async Task FaultsAreObservedAndDoNotBlockRetryAsync()
    {
        var fault = new TaskCompletionSource<Exception>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var operation = new ConnectionJoinOperation(exception => fault.TrySetResult(exception));
        Assert(operation.TryStart(CancellationToken.None, _ => Task.FromException(new InvalidOperationException("fault"))),
            "the first join starts");
        Assert((await fault.Task.WaitAsync(TimeSpan.FromSeconds(1))).Message == "fault", "fault is observed immediately");
        var retry = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Assert(operation.TryStart(CancellationToken.None, _ => { retry.TrySetResult(); return Task.CompletedTask; }),
            "a completed faulted join does not block retry");
        await retry.Task.WaitAsync(TimeSpan.FromSeconds(1));
    }

    private static async Task ClosedOperationRefusesNewWorkAsync()
    {
        using var operation = new ConnectionJoinOperation();
        await operation.CancelAndWaitAsync();
        Assert(!operation.TryStart(CancellationToken.None, _ => Task.CompletedTask),
            "canceled operation refuses new work");
    }

    private static async Task FaultObserverCannotPreventTeardownAsync()
    {
        using var operation = new ConnectionJoinOperation(_ => throw new IOException("diagnostics unavailable"));
        Assert(operation.TryStart(CancellationToken.None, _ => throw new InvalidOperationException("reply failed")),
            "synchronous join failure is contained");
        await operation.CancelAndWaitAsync().WaitAsync(TimeSpan.FromSeconds(1));
        Assert(!operation.TryStart(CancellationToken.None, _ => Task.CompletedTask),
            "teardown completes even when error reporting also fails");
    }

    private static async Task<string> ReadHeadersAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        var bytes = new List<byte>();
        var next = new byte[1];
        while (true)
        {
            await stream.ReadExactlyAsync(next, cancellationToken);
            bytes.Add(next[0]);
            if (bytes.Count >= 4 && bytes[^4] == 13 && bytes[^3] == 10 && bytes[^2] == 13 && bytes[^1] == 10)
                return Encoding.ASCII.GetString([.. bytes]);
        }
    }

    private static void Assert(bool value, string message)
    {
        if (!value) throw new Exception("[WebSocketJoinLifecycleTests] " + message);
    }
}
