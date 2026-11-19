using System.Buffers.Binary;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Server.LanRtc;
using Transport = LanRtcTunnelTests.FakeTransport;

internal static class LanRtcWebSocketTests
{
    internal static readonly IPEndPoint Candidate = new(IPAddress.Parse("192.0.2.1"), 13337);
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public static async Task RunAsync()
    {
        await EchoAsync(WebSocketMessageType.Text, "hello"u8.ToArray());
        await EchoAsync(WebSocketMessageType.Binary, [0, 255, 127]);
        await EchoAsync(WebSocketMessageType.Text, Enumerable.Repeat((byte)97, 70001).ToArray());
        await EchoAsync(WebSocketMessageType.Binary, Enumerable.Range(0, 70001).Select(i => (byte)(i % 251)).ToArray());
        await PingAsync();
        await CloseAsync();
        await RefusalAsync();
        await InvalidUpgradeAsync();
        await AbortAsync();
        await InboundLimitAsync();
        await BackpressureAsync();
        await InvalidFramesAsync();
        await BrowserServerRouteTests.RunLanRtcRelayRoutesAsync();
        Console.WriteLine("LanRtcWebSocketTests: 14 cases passed");
    }

    private static async Task EchoAsync(WebSocketMessageType type, byte[] content)
    {
        var transport = new Transport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, remote, token) =>
        {
            var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
            Expect(request.IsWebSocketUpgrade && request.Header("Host") == Candidate.ToString()
                && request.Header("Origin") == CouchCoopWebOrigin.Resolve()
                && request.Header("Sec-WebSocket-Protocol") == "test.1"
                && request.Header("Sec-WebSocket-Version") == "13" && request.Header("Sec-WebSocket-Key") != "untrusted"
                && request.Header("X-Hop") is null && request.Header("Forwarded") is null
                && request.Header("X-Forwarded-For") is null && request.Header("Content-Length") is null && remote.Equals(IPAddress.Parse("192.0.2.44")), "upgrade is stamped and keeps the peer address");
            await UpgradeAsync(stream, request, token, "test.1");
            using var socket = WebSocket.CreateFromStream(stream, true, "test.1", System.Threading.Timeout.InfiniteTimeSpan);
            using var body = new MemoryStream();
            var buffer = new byte[4000];
            ValueWebSocketReceiveResult read;
            do
            {
                read = await socket.ReceiveAsync(buffer.AsMemory(), token);
                Expect(read.MessageType == type, "client frames preserve type and satisfy server masking checks");
                body.Write(buffer, 0, read.Count);
            } while (!read.EndOfMessage);
            Expect(body.ToArray().SequenceEqual(content), "upload continuation preserves the logical message");
            await socket.SendAsync(content.AsMemory(), type, true, token);
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "done", token);
            await socket.ReceiveAsync(buffer.AsMemory(), token);
        }, Candidate);
        transport.WebSocketRequest("/echo", ["test.1"], [["Host", "evil.invalid"], ["Origin", "https://evil.invalid"],
            ["Connection", "X-Hop"], ["X-Hop", "strip"], ["Sec-WebSocket-Key", "untrusted"],
            ["Sec-WebSocket-Protocol", "untrusted"], ["Content-Length", "999"],
            ["Forwarded", "for=127.0.0.1"], ["X-Forwarded-For", "127.0.0.1"]]);
        ExpectUpgrade(await transport.ReadMessageAsync(), "test.1");
        EmitMessage(transport, type == WebSocketMessageType.Text ? 1 : 2, content);
        var echoed = await ReadLogicalAsync(transport);
        Expect(echoed.Opcode == (type == WebSocketMessageType.Text ? 1 : 2) && echoed.Data.SequenceEqual(content), "response logical message round trips");
        if (content.Length > 16384) Expect(echoed.Fragments > 1, "large response has continuation frames");
        var close = await transport.ReadMessageAsync();
        Expect(close.Data[0] == 0x88, "server close is forwarded");
        await transport.ResponseAsync();
    }

    private static async Task PingAsync()
    {
        var transport = new Transport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
            await UpgradeAsync(stream, request, token);
            await stream.WriteAsync(new byte[] { 0x89, 3, 104, 101, 121 }, token);
            var prefix = new byte[2]; await stream.ReadExactlyAsync(prefix, token);
            Expect(prefix[0] == 0x8a && prefix[1] == 0x83, "server ping receives a local masked pong");
            var rest = new byte[7]; await stream.ReadExactlyAsync(rest, token);
            for (var index = 0; index < 3; index++) rest[index + 4] ^= rest[index];
            Expect(rest.AsSpan(4).SequenceEqual("hey"u8), "pong retains the ping payload");
            await stream.WriteAsync(new byte[] { 0x81, 2, 111, 107, 0x88, 2, 3, 232 }, token);
            await stream.ReadExactlyAsync(prefix, token);
            Expect(prefix[0] == 0x88 && (prefix[1] & 128) != 0, "server close receives a masked acknowledgement");
        }, Candidate);
        transport.WebSocketRequest("/ping");
        ExpectUpgrade(await transport.ReadMessageAsync(), null);
        var message = await transport.ReadMessageAsync();
        Expect(message.Data.SequenceEqual(new byte[] { 0x81, 111, 107 }), "ping is consumed without reaching the data channel");
        Expect((await transport.ReadMessageAsync()).Data[0] == 0x88, "close follows the application message");
        Expect((await transport.ResponseAsync()).Count == 3, "only upgrade, application data and close cross the tunnel");
    }

    private static async Task CloseAsync()
    {
        var transport = new Transport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
            await UpgradeAsync(stream, request, token);
            using var socket = WebSocket.CreateFromStream(stream, true, null, System.Threading.Timeout.InfiniteTimeSpan);
            var read = await socket.ReceiveAsync(new byte[1].AsMemory(), token);
            Expect(read.MessageType == WebSocketMessageType.Close && socket.CloseStatus == WebSocketCloseStatus.EndpointUnavailable
                && socket.CloseStatusDescription == "bye", "client close code and reason are masked toward the server");
            await socket.CloseOutputAsync(socket.CloseStatus!.Value, socket.CloseStatusDescription, token);
        }, Candidate);
        transport.WebSocketRequest("/close");
        ExpectUpgrade(await transport.ReadMessageAsync(), null);
        transport.Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: [0x88, 3, 233, 98, 121, 101]));
        Expect((await transport.ReadMessageAsync()).Data.SequenceEqual(new byte[] { 0x88, 3, 233, 98, 121, 101 }), "close code and reason round trip");
        await transport.ResponseAsync();
    }

    private static async Task RefusalAsync()
    {
        var transport = new Transport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
            await stream.WriteAsync("HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\nno"u8.ToArray(), token), Candidate);
        transport.WebSocketRequest("/refused");
        var response = await transport.ResponseAsync();
        using var header = JsonDocument.Parse(response[0].Data);
        Expect(header.RootElement.GetProperty("s").GetInt32() == 403 && response.Skip(1).SelectMany(m => m.Data.Skip(1)).SequenceEqual("no"u8.ToArray()), "HTTP upgrade refusal preserves status and body");
    }

    private static async Task InvalidUpgradeAsync()
    {
        var transport = new Transport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
            await stream.WriteAsync("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: invalid\r\n\r\n"u8.ToArray(), token), Candidate);
        transport.WebSocketRequest("/bad-upgrade");
        Expect((await transport.ResponseAsync()).Count == 0, "invalid accept is refused before announcing an upgrade");
    }

    private static async Task AbortAsync()
    {
        var transport = new Transport();
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            try
            {
                var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
                await UpgradeAsync(stream, request, token);
                using var socket = WebSocket.CreateFromStream(stream, true, null, System.Threading.Timeout.InfiniteTimeSpan);
                await socket.ReceiveAsync(new byte[1].AsMemory(), token);
            }
            finally { stopped.TrySetResult(); }
        }, Candidate);
        transport.WebSocketRequest("/abort");
        ExpectUpgrade(await transport.ReadMessageAsync(), null);
        transport.Emit(new(LanRtcEventKind.Closed, 1, 1));
        await transport.ResponseAsync(); await stopped.Task.WaitAsync(Timeout);
    }

    private static async Task InboundLimitAsync()
    {
        var transport = new Transport();
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var logs = new List<string>();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
            if (!request.IsWebSocketUpgrade)
            { await stream.WriteAsync("HTTP/1.1 204 No Content\r\n\r\n"u8.ToArray(), token); return; }
            try
            {
                await UpgradeAsync(stream, request, token);
                // Leave the upload unread so only this channel's receive budget fills.
                await Task.Delay(System.Threading.Timeout.Infinite, token);
            }
            finally { stopped.TrySetResult(); }
        }, Candidate, logs.Add);
        transport.WebSocketRequest("/blocked");
        ExpectUpgrade(await transport.ReadMessageAsync(), null);
        EmitMessage(transport, 2, new byte[LanRtcTunnel.InboxByteBudget + 16384]);
        transport.Emit(new(LanRtcEventKind.Open, 1, 2, Label: LanRtcTunnel.Label));
        transport.Emit(new(LanRtcEventKind.Message, 1, 2, Data: JsonSerializer.SerializeToUtf8Bytes(new
            { v = 1, t = "fetch", m = "GET", p = "/independent", h = Array.Empty<string[]>(), sp = Array.Empty<string>() })));
        transport.Emit(new(LanRtcEventKind.Message, 1, 2, Binary: true, Data: [0x80]));
        using var response = JsonDocument.Parse((await transport.ReadMessageAsync(2)).Data);
        Expect(response.RootElement.GetProperty("s").GetInt32() == 204, "saturated WebSocket never delays another channel");
        await transport.WaitClosedAsync(2);
        var close = await transport.ReadMessageAsync();
        Expect(close.Binary && close.Data.SequenceEqual(new byte[] { 0x88, 3, 241 }), "inbound overload sends close code 1009");
        await transport.ResponseAsync(); await stopped.Task.WaitAsync(Timeout);
        Expect(logs.Count == 1 && logs[0].Contains("1009"), "inbound overload logs once");
    }

    private static async Task BackpressureAsync()
    {
        var transport = new Transport();
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var content = new byte[100000];
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
            await UpgradeAsync(stream, request, token);
            await resume.Task.WaitAsync(token);
            using var socket = WebSocket.CreateFromStream(stream, true, null, System.Threading.Timeout.InfiniteTimeSpan);
            await socket.SendAsync(content.AsMemory(), WebSocketMessageType.Binary, true, token);
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, token);
            await socket.ReceiveAsync(new byte[1].AsMemory(), token);
        }, Candidate);
        transport.WebSocketRequest("/backpressure");
        ExpectUpgrade(await transport.ReadMessageAsync(), null);
        transport.BlockSend = true;
        resume.TrySetResult();
        await transport.Full.Task.WaitAsync(Timeout);
        var attempts = transport.Attempts;
        Expect(attempts == 2, "WebSocket download pauses at the first full send");
        transport.BlockSend = false;
        transport.Emit(new(LanRtcEventKind.Low, 1, 1));
        Expect((await ReadLogicalAsync(transport)).Data.SequenceEqual(content), "dc_low resumes the intact WebSocket message");
        Expect((await transport.ReadMessageAsync()).Data[0] == 0x88, "backpressured socket closes normally");
        await transport.ResponseAsync();
    }

    private static async Task InvalidFramesAsync()
    {
        foreach (var frame in new byte[][] { [0x80, 1], [0x89], [0x88, 1], new byte[16386] })
        {
            var transport = new Transport();
            await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
            {
                var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
                await UpgradeAsync(stream, request, token);
                using var socket = WebSocket.CreateFromStream(stream, true, null, System.Threading.Timeout.InfiniteTimeSpan);
                await socket.ReceiveAsync(new byte[32].AsMemory(), token);
            }, Candidate);
            transport.WebSocketRequest("/invalid");
            ExpectUpgrade(await transport.ReadMessageAsync(), null);
            transport.Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: frame));
            Expect((await transport.ResponseAsync()).Count == 1, "invalid continuation/control/oversized frame aborts the channel");
        }
    }

    internal static async Task UpgradeAsync(Stream stream, CouchCoopHttpRequest request, CancellationToken token, string? protocol = null)
    {
        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(request.Header("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " + accept + "\r\n"
            + (protocol is null ? "" : "Sec-WebSocket-Protocol: " + protocol + "\r\n") + "\r\n"), token);
    }

    internal static void ExpectUpgrade(LanRtcTunnelTests.Message message, string? protocol)
    {
        using var header = JsonDocument.Parse(message.Data);
        Expect(!message.Binary && header.RootElement.GetProperty("s").GetInt32() == 101
            && header.RootElement.GetProperty("sp").GetString() == protocol, "text JSON announces the accepted upgrade and selected protocol");
    }

    internal static void EmitMessage(Transport transport, int opcode, byte[] content)
    {
        for (var offset = 0; offset < content.Length || offset == 0; offset += 16384)
        {
            var count = Math.Min(16384, content.Length - offset);
            var frame = new byte[count + 1];
            frame[0] = (byte)((offset == 0 ? opcode : 0) | (offset + count == content.Length ? 128 : 0));
            content.AsSpan(offset, count).CopyTo(frame.AsSpan(1));
            transport.Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: frame));
        }
    }

    internal static async Task<(int Opcode, byte[] Data, int Fragments)> ReadLogicalAsync(Transport transport)
    {
        using var bytes = new MemoryStream();
        var opcode = -1; var fragments = 0;
        while (true)
        {
            var frame = await transport.ReadMessageAsync();
            Expect(frame.Binary && frame.Data.Length is >= 1 and <= 16385, "WebSocket frame stays within the tunnel payload limit");
            var current = frame.Data[0] & 127;
            if (opcode == -1) { opcode = current; Expect(opcode is 1 or 2, "logical message starts with text or binary opcode"); }
            else Expect(current == 0, "continuation opcode follows the initial fragment");
            bytes.Write(frame.Data, 1, frame.Data.Length - 1); fragments++;
            if ((frame.Data[0] & 128) != 0) return (opcode, bytes.ToArray(), fragments);
        }
    }

    private static void Expect(bool condition, string reason)
    { if (!condition) throw new Exception("LanRtcWebSocketTests: " + reason); }
}
