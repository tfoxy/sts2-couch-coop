using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Server.LanRtc;

internal static class LanRtcTunnelTests
{
    private static readonly IPAddress Peer = IPAddress.Parse("192.0.2.44");
    private static readonly IPEndPoint Candidate = new(IPAddress.Parse("192.0.2.1"), 13337);
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    public static async Task RunAsync()
    {
        foreach (var method in new[] { "GET", "HEAD", "POST" }) await MethodAsync(method);
        await BurstUploadAsync();
        await OversizedFetchAsync();
        await RequestStreamingAsync();
        await LargeResponseAsync();
        await ChunkedAsync();
        await CloseDelimitedAsync();
        await AbortedRequestAsync();
        await TruncatedResponseAsync();
        await HeadersAsync();
        await BackpressureAsync();
        await AssociationBudgetAsync();
        await AbortBlockedResponseAsync();
        await RejectChannelsAsync();
        await BadFramingAsync();
        await RealServerAsync();
        await LifecyclePostAsync();
        await ControlWhileInboxFullAsync();
        Console.WriteLine("LanRtcTunnelTests: 20 cases passed");
    }

    private static async Task MethodAsync(string method)
    {
        var content = Enumerable.Range(0, 70001).Select(i => (byte)(i % 251)).ToArray();
        byte[] upload = method == "POST" ? content : [];
        var transport = new FakeTransport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, remote, token) =>
        {
            var request = await CouchCoopHttpRequest.TryReadAsync(stream, token);
            Expect(request!.Method == method && request.Target == "/test?q=1" && remote.Equals(Peer), "method, path and authenticated address");
            using var body = new MemoryStream();
            await stream.CopyToAsync(body, token);
            Expect(request.Header("Content-Length") is null && body.ToArray().SequenceEqual(upload), "POST body streams to FIN without trusting a length");
            await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Length: {content.Length}\r\nX-Test: yes\r\n\r\n"), token);
            if (method != "HEAD") await stream.WriteAsync(content, token);
        }, Candidate);
        transport.Request(method, "/test?q=1", upload);
        var response = await transport.ResponseAsync();
        AssertResponse(response, 200, method == "HEAD" ? [] : content);
        Expect(response.Where(m => m.Binary).All(m => m.Data.Length <= 16385), "large body split at 16 KiB");
        if (method != "HEAD") Expect(response.Count(m => m.Binary) >= 6, "large body has multiple fragments and FIN");
    }

    private static async Task BurstUploadAsync()
    {
        var transport = new FakeTransport(eventCapacity: 4);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var expected = LanRtcTunnel.FetchBodyLimit;
        var received = 0;
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            await CouchCoopHttpRequest.TryReadAsync(stream, token);
            entered.TrySetResult();
            await resume.Task.WaitAsync(token);
            var buffer = new byte[4096];
            int count;
            while ((count = await stream.ReadAsync(buffer, token)) != 0)
            {
                Expect(buffer.AsSpan(0, count).IndexOfAnyExcept((byte)42) < 0, "burst bytes retained in order");
                received += count;
            }
            await stream.WriteAsync("HTTP/1.1 204 No Content\r\n\r\n"u8.ToArray(), token);
        }, Candidate);
        transport.Request("POST", "/", finish: false);
        await entered.Task.WaitAsync(Timeout);
        var upload = transport.BodyAsync(new byte[expected].Select(_ => (byte)42).ToArray());
        await upload.WaitAsync(Timeout);
        resume.TrySetResult();
        await upload.WaitAsync(Timeout);
        AssertResponse(await transport.ResponseAsync(), 204, []);
        Expect(received == expected, "a queued upload exactly at the 1 MiB limit is delivered completely");
    }

    private static async Task OversizedFetchAsync()
    {
        var transport = new FakeTransport();
        var logs = new List<string>();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            await CouchCoopHttpRequest.TryReadAsync(stream, token);
            await stream.CopyToAsync(Stream.Null, token);
            await stream.WriteAsync("HTTP/1.1 204 No Content\r\n\r\n"u8.ToArray(), token);
        }, Candidate, logs.Add);
        transport.Request("POST", "/", new byte[LanRtcTunnel.FetchBodyLimit + 1]);
        AssertResponse(await transport.ResponseAsync(), 413, []);
        Expect(logs.Count == 1 && logs[0].Contains("413"), "oversized fetch logs once and closes");
    }

    private static async Task RequestStreamingAsync()
    {
        var transport = new FakeTransport();
        var firstRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            await CouchCoopHttpRequest.TryReadAsync(stream, token);
            var first = new byte[3];
            await stream.ReadExactlyAsync(first, token);
            Expect(first.SequenceEqual("abc"u8.ToArray()), "body is available before FIN");
            firstRead.TrySetResult();
            using var rest = new MemoryStream();
            await stream.CopyToAsync(rest, token);
            Expect(rest.ToArray().SequenceEqual("def"u8.ToArray()), "remaining body follows initial chunk");
            await stream.WriteAsync("HTTP/1.1 204 No Content\r\n\r\n"u8.ToArray(), token);
        }, Candidate);
        transport.Request("POST", "/", finish: false);
        transport.Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: [2, 97, 98, 99]));
        await firstRead.Task.WaitAsync(Timeout);
        transport.Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: [128, 100, 101, 102]));
        AssertResponse(await transport.ResponseAsync(), 204, []);
    }

    private static async Task LargeResponseAsync()
    {
        const int size = 16 * 1024 * 1024 + 1337;
        var transport = new FakeTransport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Length: {size}\r\n\r\n"), token);
            var chunk = Enumerable.Repeat((byte)42, 16384).ToArray();
            for (var sent = 0; sent < size; sent += chunk.Length)
                await stream.WriteAsync(chunk.AsMemory(0, Math.Min(chunk.Length, size - sent)), token);
        }, Candidate);
        transport.Request("GET", "/");
        var response = await transport.ResponseAsync();
        var frames = response.Skip(1).ToArray();
        Expect(frames.Sum(f => f.Data.Length - 1) == size && frames[^1].Data[0] == 128, "response exceeds the old total body limit and reaches FIN");
        Expect(frames.All(f => f.Binary && f.Data.Length <= 16385 && f.Data.AsSpan(1).IndexOfAnyExcept((byte)42) < 0), "large response stays within frame limits with intact content");
    }

    private static async Task ChunkedAsync()
    {
        var transport = new FakeTransport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            await stream.WriteAsync("HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nX-Test: kept\r\n\r\n3;ext=x\r\nabc\r\n5\r\ndefgh\r\n0\r\nX-Trailer: discarded\r\n\r\n"u8.ToArray(), token);
        }, Candidate);
        transport.Request("GET", "/");
        var response = await transport.ResponseAsync();
        AssertResponse(response, 201, "abcdefgh"u8.ToArray());
        using var header = JsonDocument.Parse(response[0].Data);
        Expect(!header.RootElement.GetProperty("h").EnumerateArray().Any(h =>
            h[0].GetString()!.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)), "chunked encoding removed after decoding");
    }

    private static async Task CloseDelimitedAsync()
    {
        var transport = new FakeTransport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
            await stream.WriteAsync("HTTP/1.1 200 OK\r\n\r\nclose delimited"u8.ToArray(), token), Candidate);
        transport.Request("GET", "/");
        AssertResponse(await transport.ResponseAsync(), 200, "close delimited"u8.ToArray());
    }

    private static async Task AbortedRequestAsync()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            await CouchCoopHttpRequest.TryReadAsync(stream, token);
            entered.TrySetResult();
            try { await stream.CopyToAsync(Stream.Null, token); }
            finally { stopped.TrySetResult(); }
        }, Candidate);
        transport.Request("POST", "/", finish: false);
        await entered.Task.WaitAsync(Timeout);
        transport.Emit(new(LanRtcEventKind.Closed, 1, 1));
        var response = await transport.ResponseAsync();
        Expect(response.Count == 0, "early close aborts the streaming request without a response FIN");
        await stopped.Task.WaitAsync(Timeout);
    }

    private static async Task TruncatedResponseAsync()
    {
        var transport = new FakeTransport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
            await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort"u8.ToArray(), token), Candidate);
        transport.Request("GET", "/");
        var response = await transport.ResponseAsync();
        Expect(response.Count > 0 && !response.Any(m => m.Binary && (m.Data[0] & 128) != 0), "truncated response closes without FIN");
    }

    private static async Task HeadersAsync()
    {
        var headers = new[] { new[] { "Host", "evil" }, ["Origin", "https://evil.invalid"], ["Connection", "X-Secret, Keep-Alive"],
            ["X-Secret", "strip"], ["Keep-Alive", "timeout=5"], ["Sec-WebSocket-Key", "strip"], ["Sec-WebSocket-Protocol", "strip"],
            ["Content-Length", "999"], ["Content-Encoding", "gzip"], ["Transfer-Encoding", "chunked"], ["Forwarded", "for=127.0.0.1"],
            ["X-Forwarded-For", "127.0.0.1"], ["Range", "bytes=2-8"], ["Authorization", "Bearer retained"] };
        var transport = new FakeTransport();
        await using var tunnel = new LanRtcTunnel(transport, async (stream, remote, token) =>
        {
            var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
            Expect(request.Header("Host") == Candidate.ToString() && request.Header("Origin") == CouchCoopWebOrigin.Resolve()
                && request.Header("Connection") == "close" && request.Header("Content-Length") is null, "trusted headers stamped");
            foreach (var name in new[] { "X-Secret", "Keep-Alive", "Sec-WebSocket-Key", "Sec-WebSocket-Protocol", "Content-Encoding", "Transfer-Encoding", "Forwarded", "X-Forwarded-For" })
                Expect(request.Header(name) is null, "untrusted " + name + " stripped");
            Expect(request.Header("Range") == "bytes=2-8" && request.Header("Authorization") == "Bearer retained", "end-to-end headers retained");
            await stream.WriteAsync("HTTP/1.1 204 No Content\r\nContent-Length: 99\r\nConnection: X-Hop\r\nX-Hop: strip\r\n\r\n"u8.ToArray(), token);
        }, Candidate);
        transport.Request("GET", "/", headers: headers);
        var response = await transport.ResponseAsync();
        AssertResponse(response, 204, []);
        using var json = JsonDocument.Parse(response[0].Data);
        Expect(!json.RootElement.GetProperty("h").EnumerateArray().Any(h => h[0].GetString() == "X-Hop"), "response hop headers stripped");
    }

    private static async Task BackpressureAsync()
    {
        var content = Enumerable.Repeat((byte)42, 100000).ToArray();
        var transport = new FakeTransport { BlockSend = true };
        var produced = 0;
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            try
            {
                await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n"u8.ToArray(), token);
                for (var i = 0; i < content.Length; i += 10000)
                {
                    await stream.WriteAsync(content.AsMemory(i, 10000), token);
                    Interlocked.Add(ref produced, 10000);
                }
            }
            finally { cancelled.TrySetResult(); }
        }, Candidate);
        transport.Request("GET", "/");
        await transport.Full.Task.WaitAsync(Timeout);
        Expect(Volatile.Read(ref produced) <= 20000, "blocked send stops reading server stream with bounded credit");
        Expect(transport.Attempts == 1, "no retry without dc_low");
        transport.BlockSend = false;
        transport.Emit(new(LanRtcEventKind.Low, 1, 1));
        AssertResponse(await transport.ResponseAsync(), 200, content);
        await cancelled.Task.WaitAsync(Timeout);
    }

    private static async Task AssociationBudgetAsync()
    {
        var root = Directory.CreateTempSubdirectory("couch-rtc-budget-").FullName;
        try
        {
            using var identity = LanRtcIdentity.LoadOrCreate(root, _ => { });
            await using var socket = new BrowserPortUdpSocket(0, _ => null, _ => { });
            using var fake = new LanRtcModuleTests.Fake();
            using var module = CreateBufferedModule(fake, identity, socket);
            var buffer = new AssociationBuffer(fake);
            fake.OnSend = buffer.Send;
            fake.OnCloseChannel = buffer.Close;
            OpenBufferedChannels(fake);
            for (uint channel = 1; channel <= 5; channel++)
                for (var message = 0; message < 3; message++)
                    Expect(module.Send(1, channel, true, new byte[16385]) == 0, "initial association credit accepts three frames per channel");
            Expect(buffer.Total == 5 * 3 * 16385, "five channels share the default 262144-byte association budget");
            var drained = Enumerable.Range(1, 5).Select(channel => module.GetSignals(1, (uint)channel)!.Drained).ToArray();
            await using var tunnel = new LanRtcTunnel(module, async (stream, _, token) =>
            {
                await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 16384\r\n\r\n"u8.ToArray(), token);
                await stream.WriteAsync(new byte[16384], token);
            }, Candidate);
            RequestBufferedChannels(fake);
            await buffer.AllBlocked.Task.WaitAsync(Timeout);
            Expect(!buffer.AllClosed.Task.IsCompleted, "every response waits for association credit");
            buffer.Drain(1);
            Expect(drained.All(task => task.IsCompleted), "one channel draining broadcasts credit to every sibling");
            for (uint channel = 2; channel <= 5; channel++) buffer.Drain(channel);
            await buffer.AllClosed.Task.WaitAsync(Timeout);
            Expect(buffer.CompletedResponses, "every pending body send and FIN completes after threshold-driven drains");
        }
        finally { Directory.Delete(root, true); }
    }

    private static unsafe LanRtcModule CreateBufferedModule(LanRtcModuleTests.Fake fake,
        LanRtcIdentity identity, BrowserPortUdpSocket socket)
        => LanRtcModule.Create(fake.Api, identity, new(Candidate.Address, socket.Port), socket, _ => { });

    private static unsafe void OpenBufferedChannels(LanRtcModuleTests.Fake fake)
    {
        var callbacks = fake.Callbacks;
        var address = LanRtcAddress.From(new(Peer, 45000));
        callbacks.Peer(callbacks.User, 1, 1, &address);
        var label = Encoding.UTF8.GetBytes(LanRtcTunnel.Label);
        fixed (byte* bytes = label)
            for (uint channel = 1; channel <= 5; channel++)
                callbacks.Open(callbacks.User, 1, channel, bytes, (nuint)label.Length);
    }

    private static unsafe void RequestBufferedChannels(LanRtcModuleTests.Fake fake)
    {
        var callbacks = fake.Callbacks;
        var request = "{\"v\":1,\"t\":\"fetch\",\"m\":\"GET\",\"p\":\"/\",\"h\":[]}"u8.ToArray();
        byte fin = 0x80;
        fixed (byte* bytes = request)
            for (uint channel = 1; channel <= 5; channel++)
            {
                callbacks.Message(callbacks.User, 1, channel, 0, bytes, (nuint)request.Length);
                callbacks.Message(callbacks.User, 1, channel, 1, &fin, 1);
            }
    }

    private sealed class AssociationBuffer
    {
        private readonly object _gate = new();
        private readonly LanRtcModuleTests.Fake _fake;
        private readonly uint _threshold, _budget;
        private readonly Dictionary<uint, int> _buffered = new();
        private readonly Dictionary<uint, List<int>> _accepted = new();
        private readonly HashSet<uint> _blocked = new(), _closed = new();
        public TaskCompletionSource AllBlocked { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource AllClosed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public unsafe AssociationBuffer(LanRtcModuleTests.Fake fake)
        { _fake = fake; _threshold = fake.Config.LowThreshold; _budget = fake.Config.SendBudget == 0 ? 262144 : fake.Config.SendBudget; }
        public int Total { get { lock (_gate) return _buffered.Values.Sum(); } }
        public bool CompletedResponses
        {
            get
            {
                lock (_gate) return _accepted.Count == 5 && _accepted.Values.All(messages =>
                    messages.Count == 6 && messages[4] == 16385 && messages[5] == 1);
            }
        }
        public int Send(uint peer, uint channel, int length)
        {
            lock (_gate)
            {
                if (_buffered.Values.Sum() + length > _budget)
                {
                    _blocked.Add(channel);
                    if (_blocked.Count == 5) AllBlocked.TrySetResult();
                    return 1;
                }
                _buffered[channel] = _buffered.GetValueOrDefault(channel) + length;
                if (!_accepted.TryGetValue(channel, out var messages)) _accepted[channel] = messages = new();
                messages.Add(length);
                return 0;
            }
        }
        public unsafe void Drain(uint channel)
        {
            bool crossing;
            lock (_gate)
            {
                var before = _buffered.GetValueOrDefault(channel);
                _buffered[channel] = 0;
                crossing = before > _threshold && _buffered[channel] <= _threshold;
            }
            if (crossing) _fake.Callbacks.Low(_fake.Callbacks.User, 1, channel);
        }
        public void Close(uint peer, uint channel)
        {
            lock (_gate)
            {
                _closed.Add(channel);
                if (_closed.Count == 5) AllClosed.TrySetResult();
            }
        }
    }

    private static async Task AbortBlockedResponseAsync()
    {
        var transport = new FakeTransport { BlockSend = true };
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            try
            {
                await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n"u8.ToArray(), token);
                await stream.WriteAsync(new byte[100000], token);
            }
            finally { stopped.TrySetResult(); }
        }, Candidate);
        transport.Request("GET", "/");
        await transport.Full.Task.WaitAsync(Timeout);
        transport.Emit(new(LanRtcEventKind.Closed, 1, 1));
        Expect((await transport.ResponseAsync()).Count == 0, "closed channel aborts a blocked send");
        await stopped.Task.WaitAsync(Timeout);
    }

    private static async Task RejectChannelsAsync()
    {
        var transport = new FakeTransport();
        var served = false;
        await using var tunnel = new LanRtcTunnel(transport, (_, _, _) => { served = true; return Task.CompletedTask; }, Candidate);
        transport.Emit(new(LanRtcEventKind.PeerConnected, 1, Address: Peer));
        transport.Emit(new(LanRtcEventKind.Open, 1, 1, Label: "wrong-label"));
        await transport.ResponseAsync();
        Expect(!served, "unwanted label closed");
        var local = new FakeTransport();
        await using var second = new LanRtcTunnel(local, (_, _, _) => throw new Exception("must not serve loopback"), Candidate);
        local.Emit(new(LanRtcEventKind.PeerConnected, 1, Address: IPAddress.Loopback));
        local.Emit(new(LanRtcEventKind.Open, 1, 1, Label: LanRtcTunnel.Label));
        await local.ResponseAsync();
    }

    private static async Task BadFramingAsync()
    {
        foreach (var bad in new byte[][] { [], [0x81], new byte[16386] })
        {
            var transport = new FakeTransport();
            await using var tunnel = new LanRtcTunnel(transport, (_, _, _) => throw new Exception("invalid frame must not serve"), Candidate);
            transport.Request("POST", "/", finish: false);
            transport.Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: bad));
            Expect((await transport.ResponseAsync()).Count == 0, "bad body frame closed");
        }
    }

    private static async Task RealServerAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "couch-rtc-http-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, "index.html"), "tunnel static page");
        try
        {
            await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root), null!,
                preferredPort: 0, isHeadlessClient: false, log: _ => { });
            var transport = new FakeTransport();
            await using (var tunnel = new LanRtcTunnel(transport, server, Candidate))
            {
                transport.Request("GET", "/index.html");
                AssertResponse(await transport.ResponseAsync(), 200, "tunnel static page"u8.ToArray());
            }
            transport = new FakeTransport();
            await using (var tunnel = new LanRtcTunnel(transport, server, Candidate))
            {
                transport.Request("POST", "/internal/client-status", headers: [["Authorization", "Bearer x"], ["X-CouchCoop-Generation", "1"]]);
                var response = await transport.ResponseAsync();
                using var json = JsonDocument.Parse(response[0].Data);
                Expect(json.RootElement.GetProperty("s").GetInt32() == 404, "loopback-gated route refuses authenticated LAN address");
            }
            // This control proves that the refusal depends on the remote address rather than request syntax.
            using var direct = new LanRtcHttpStream("POST /internal/client-status HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n"u8.ToArray());
            var serve = server.ServeAsync(direct, false, IPAddress.Loopback, CancellationToken.None);
            async Task CompleteAsync() { try { await serve; } finally { direct.CompleteResponse(); } }
            var complete = CompleteAsync();
            using var reader = new StreamReader(direct.Response);
            Expect((await reader.ReadLineAsync())!.Contains("401"), "loopback control reaches route validation");
            await reader.ReadToEndAsync(); await complete;
        }
        finally { Directory.Delete(root, true); }
    }

    private static async Task LifecyclePostAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "couch-rtc-lifecycle-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var diagnostics = new BrowserLifecycleDiagnostics(root);
            var meta = diagnostics.BeginVisitMeta();
            var encoded = meta.Split("content=\"", StringSplitOptions.None)[1].Split('"')[0];
            using var json = JsonDocument.Parse(Convert.FromBase64String(encoded));
            var body = JsonSerializer.SerializeToUtf8Bytes(new { nonce = json.RootElement.GetProperty("nonce").GetString(), events = Array.Empty<object>() });
            await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root), null!,
                preferredPort: 0, isHeadlessClient: false, lifecycleDiagnostics: diagnostics, log: _ => { });
            var transport = new FakeTransport();
            await using (var tunnel = new LanRtcTunnel(transport, server, Candidate))
            {
                transport.Request("POST", BrowserLifecycleDiagnostics.Route, body);
                AssertResponse(await transport.ResponseAsync(), 204, []);
            }
            transport = new FakeTransport();
            await using (var tunnel = new LanRtcTunnel(transport, server, Candidate))
            {
                transport.Request("POST", BrowserLifecycleDiagnostics.Route, new byte[BrowserLifecycleDiagnostics.MaximumRequestBytes + 1]);
                var response = await transport.ResponseAsync();
                using var rejected = JsonDocument.Parse(response[0].Data);
                Expect(rejected.RootElement.GetProperty("s").GetInt32() == 400, "streaming diagnostics retains the bounded body limit");
            }
        }
        finally { Directory.Delete(root, true); }
    }

    private static async Task ControlWhileInboxFullAsync()
    {
        var transport = new FakeTransport { BlockSend = true };
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var sent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var tunnel = new LanRtcTunnel(transport, async (stream, _, token) =>
        {
            await CouchCoopHttpRequest.TryReadAsync(stream, token);
            entered.TrySetResult();
            await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 65536\r\n\r\n"u8.ToArray(), token);
            await stream.WriteAsync(new byte[65536], token);
            sent.TrySetResult();
        }, Candidate);
        transport.Request("POST", "/", finish: false);
        await entered.Task.WaitAsync(Timeout);
        var frame = new byte[16385]; frame[0] = 2;
        for (var index = 0; index < 40; index++)
        {
            transport.Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: frame));
            frame = new byte[16385];
        }
        transport.Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: [128]));
        await transport.Full.Task.WaitAsync(Timeout);
        transport.BlockSend = false;
        transport.Emit(new(LanRtcEventKind.Low, 1, 1));
        var response = await transport.ResponseAsync();
        AssertResponse(response, 200, new byte[65536]);
        await sent.Task.WaitAsync(Timeout);
    }

    private static void AssertResponse(List<Message> response, int status, byte[] expected)
    {
        Expect(response.Count >= 2 && !response[0].Binary, "first response is text JSON");
        using var json = JsonDocument.Parse(response[0].Data);
        Expect(json.RootElement.GetProperty("s").GetInt32() == status, "response status");
        var frames = response.Skip(1).ToArray();
        Expect(frames.All(f => f.Binary && f.Data.Length is >= 1 and <= 16385), "binary response frame limits");
        Expect((frames[^1].Data[0] & 128) != 0 && frames[..^1].All(f => (f.Data[0] & 128) == 0), "FIN exactly at body end");
        Expect(frames.SelectMany(f => f.Data.Skip(1)).SequenceEqual(expected), "response body round trips");
        if (expected.Length > 0) Expect((frames[0].Data[0] & 127) == 2 && frames.Skip(1).All(f => (f.Data[0] & 127) == 0), "binary message with continuation fragments");
    }

    private static void Expect(bool condition, string reason)
    { if (!condition) throw new Exception("LanRtcTunnelTests: " + reason); }

    internal sealed record Message(bool Binary, byte[] Data);
    internal sealed class FakeTransport : ILanRtcTransport
    {
        private readonly Channel<LanRtcEvent> _events;
        private readonly ConcurrentDictionary<(uint, uint), LanRtcChannelSignals> _signals = new();
        public FakeTransport(int eventCapacity = 0) => _events = eventCapacity == 0
            ? Channel.CreateUnbounded<LanRtcEvent>() : Channel.CreateBounded<LanRtcEvent>(eventCapacity);
        public LanRtcChannelSignals? GetSignals(uint peer, uint channel) => _signals.GetValueOrDefault((peer, channel));
        public readonly TaskCompletionSource InputFull = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly ConcurrentQueue<Message> _sent = new();
        private readonly ConcurrentDictionary<uint, Channel<Message>> _outgoing = new();
        private readonly ConcurrentDictionary<uint, TaskCompletionSource> _channelClosed = new();
        public async Task<Message> ReadMessageAsync(uint channel = 1)
            => await _outgoing.GetOrAdd(channel, _ => Channel.CreateUnbounded<Message>()).Reader.ReadAsync().AsTask().WaitAsync(Timeout);
        public Task WaitClosedAsync(uint channel) => _channelClosed.GetOrAdd(channel,
            _ => new(TaskCreationOptions.RunContinuationsAsynchronously)).Task.WaitAsync(Timeout);
        public void WebSocketRequest(string path, string[]? protocols = null, string[][]? headers = null)
        {
            Emit(new(LanRtcEventKind.PeerConnected, 1, Address: Peer));
            Emit(new(LanRtcEventKind.Open, 1, 1, Label: LanRtcTunnel.Label));
            Emit(new(LanRtcEventKind.Message, 1, 1, Data: JsonSerializer.SerializeToUtf8Bytes(new
                { v = 1, t = "ws", m = "GET", p = path, h = headers ?? [], sp = protocols ?? [] })));
        }
        private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource Full = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public volatile bool BlockSend;
        public int Attempts;
        public ChannelReader<LanRtcEvent> Events => _events.Reader;
        public void Emit(LanRtcEvent value)
        {
            Notify(value);
            if (value.Kind == LanRtcEventKind.Message) return;
            if (!_events.Writer.TryWrite(value)) throw new Exception("Fake event queue full; use EmitAsync.");
        }
        private void Notify(LanRtcEvent value)
        {
            var key = (value.Peer, value.Channel);
            if (value.Kind == LanRtcEventKind.Open) _signals.TryAdd(key, new());
            if (value.Kind == LanRtcEventKind.Message) GetSignals(value.Peer, value.Channel)?.Message(value);
            if (value.Kind == LanRtcEventKind.Low)
                foreach (var item in _signals.Where(item => item.Key.Item1 == value.Peer)) item.Value.Low();
            if (value.Kind == LanRtcEventKind.Closed && _signals.TryRemove(key, out var closed)) closed.Close();
            if (value.Kind == LanRtcEventKind.PeerRemoved)
                foreach (var item in _signals.Where(item => item.Key.Item1 == value.Peer)) item.Value.Close();
        }
        public async Task EmitAsync(LanRtcEvent value)
        {
            Notify(value);
            if (value.Kind == LanRtcEventKind.Message) return;
            if (!_events.Writer.TryWrite(value))
            { InputFull.TrySetResult(); await _events.Writer.WriteAsync(value); }
        }
        public async Task BodyAsync(byte[] body)
        {
            for (var offset = 0; offset < body.Length; offset += 16384)
            {
                var count = Math.Min(16384, body.Length - offset);
                var frame = new byte[count + 1];
                frame[0] = (byte)((offset == 0 ? 2 : 0) | (offset + count == body.Length ? 128 : 0));
                body.AsSpan(offset, count).CopyTo(frame.AsSpan(1));
                await EmitAsync(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: frame));
            }
        }
        public int Send(uint peer, uint channel, bool binary, ReadOnlySpan<byte> data)
        {
            Interlocked.Increment(ref Attempts);
            if (BlockSend) { Full.TrySetResult(); return 1; }
            var message = new Message(binary, data.ToArray());
            _sent.Enqueue(message);
            _outgoing.GetOrAdd(channel, _ => Channel.CreateUnbounded<Message>()).Writer.TryWrite(message);
            return 0;
        }
        public void CloseChannel(uint peer, uint channel)
        {
            _channelClosed.GetOrAdd(channel, _ => new(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();
            if (channel == 1) _closed.TrySetResult();
        }
        public async Task<List<Message>> ResponseAsync()
        { await _closed.Task.WaitAsync(Timeout); return _sent.ToList(); }
        public void Request(string method, string path, byte[]? body = null, string[][]? headers = null, bool finish = true)
        {
            Emit(new(LanRtcEventKind.PeerConnected, 1, Address: Peer));
            Emit(new(LanRtcEventKind.Open, 1, 1, Label: LanRtcTunnel.Label));
            Emit(new(LanRtcEventKind.Message, 1, 1, Data: JsonSerializer.SerializeToUtf8Bytes(new
                { v = 1, t = "fetch", m = method, p = path, h = headers ?? [], sp = Array.Empty<string>() })));
            if (finish)
            {
                body ??= [];
                var offset = 0;
                do
                {
                    var count = Math.Min(16384, body.Length - offset);
                    var frame = new byte[count + 1];
                    frame[0] = (byte)((offset == 0 ? 2 : 0) | (offset + count == body.Length ? 128 : 0));
                    body.AsSpan(offset, count).CopyTo(frame.AsSpan(1));
                    Emit(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: frame));
                    offset += count;
                } while (offset < body.Length);
            }
        }
    }
}
