using System.Buffers;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Server;

internal static class NetworkHardeningTests
{
    public static async Task RunAsync()
    {
        await FragmentedHeadersAndPrefixesArePreservedAsync();
        await HeaderLimitRejectsUnterminatedAsync();
        await HeaderLimitRejectsTerminatorPastBoundaryAsync();
        await IncompleteNetworkHeaderTimesOutAsync();
        await CancellationAndTimeoutReturnRentedBuffersAsync();
        await ServerReturns431Async();
        await ServerConsumesBodyPrefixAsync();
        await HeaderLimitAcceptsBoundaryTerminatorAsync();
        QueryValuesAreParsedOnce();
        AdmissionCapsAndRecovers();
        AttachedAdmissionTransfersOwnership();
        await InputQueueAppliesAwaitableBackpressureInOrder();
        MainThreadPingRemainsSingleFlightUntilCallback();
        MainThreadPingHasProcessWideCallbackCeiling();
        Console.WriteLine("NetworkHardeningTests: ok");
    }

    private static async Task FragmentedHeadersAndPrefixesArePreservedAsync()
    {
        var requestHead = Encoding.ASCII.GetBytes("POST /probe?name=Zo%C3%AB HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r");
        var body = Encoding.ASCII.GetBytes("\nBODY");
        await using var fragmented = new SegmentedDuplexStream(requestHead, body);
        using (var read = await CouchCoopHttpRequest.TryReadWithPrefixAsync(fragmented))
        {
            Assert(read is not null, "a delimiter split across reads is recognized");
            Assert(read!.Request.Method == "POST" && read.Request.Name == "Zoë",
                "the fragmented request and its percent-decoded query parse correctly");
            var preservedBody = new byte[4];
            Assert(await read.Stream.ReadAsync(preservedBody) == preservedBody.Length
                && Encoding.ASCII.GetString(preservedBody) == "BODY",
                "a POST body received with the final delimiter byte is replayed to the route");
        }

        var webSocketPrefix = new byte[] { 0x81, 0x02, (byte)'{', (byte)'}' };
        var upgrade = Encoding.ASCII.GetBytes(
            "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        await using var eagerSocket = new SegmentedDuplexStream(upgrade.Concat(webSocketPrefix).ToArray());
        using (var read = await CouchCoopHttpRequest.TryReadWithPrefixAsync(eagerSocket))
        {
            Assert(read?.Request.IsWebSocketUpgrade == true, "an eager WebSocket upgrade parses");
            var replayed = new byte[webSocketPrefix.Length];
            Assert(await read!.Stream.ReadAsync(replayed) == replayed.Length
                && replayed.SequenceEqual(webSocketPrefix),
                "a first WebSocket frame received with its upgrade is replayed byte-exactly");
        }

        // Exercise the actual .NET WebSocket parser, not only a raw stream read. The first masked frame is sent
        // in the same transport read as the upgrade headers, so it can be received only through prefix replay.
        var message = Encoding.UTF8.GetBytes("{\"type\":\"ping\"}");
        var mask = new byte[] { 1, 2, 3, 4 };
        var frame = new byte[2 + mask.Length + message.Length];
        frame[0] = 0x81;
        frame[1] = (byte)(0x80 | message.Length);
        mask.CopyTo(frame, 2);
        for (var index = 0; index < message.Length; index++)
            frame[6 + index] = (byte)(message[index] ^ mask[index % mask.Length]);
        await using var eagerManagedSocket = new SegmentedDuplexStream(upgrade.Concat(frame).ToArray());
        using (var read = await CouchCoopHttpRequest.TryReadWithPrefixAsync(eagerManagedSocket))
        using (var socket = WebSocket.CreateFromStream(
            read!.Stream, isServer: true, subProtocol: null, keepAliveInterval: Timeout.InfiniteTimeSpan))
        using (var stop = new CancellationTokenSource(TimeSpan.FromSeconds(1)))
        {
            var received = new byte[message.Length];
            var result = await socket.ReceiveAsync(received, stop.Token);
            Assert(result.MessageType == WebSocketMessageType.Text && result.EndOfMessage
                && result.Count == message.Length && received.SequenceEqual(message),
                "ManagedWebSocket receives an eager masked frame after the pooled header handoff");
        }

        await using var legacy = new MemoryStream(Encoding.ASCII.GetBytes("POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\nBODY"));
        var legacyRequest = await CouchCoopHttpRequest.TryReadAsync(legacy);
        var legacyBody = new byte[4];
        Assert(legacyRequest?.Method == "POST" && await legacy.ReadAsync(legacyBody) == legacyBody.Length
            && Encoding.ASCII.GetString(legacyBody) == "BODY",
            "the legacy request-only reader leaves a following body on the underlying stream");
    }

    private static void AttachedAdmissionTransfersOwnership()
    {
        var limiter = new NetworkAdmissionLimiter();
        using var client = new System.Net.Sockets.TcpClient();
        var lease = limiter.TryAcquireHttp(IPAddress.Loopback)
            ?? throw new Exception("failed to acquire attached admission test lease");
        limiter.AttachHttp(client, lease);
        Assert(ReferenceEquals(limiter.TakeAttachedHttp(client), lease),
            "a listener-acquired lease transfers to the generation exactly once");
        Assert(limiter.TakeAttachedHttp(client) is null,
            "a transferred lease cannot be taken or released twice");
        lease.Dispose();
    }

    private static void MainThreadPingRemainsSingleFlightUntilCallback()
    {
        var gate = new MainThreadPingGate();
        Assert(gate.TryBegin(), "first main-thread ping schedules a callback");
        Assert(!gate.TryBegin(), "a second ping cannot schedule while the first callback is queued");
        // A response timeout deliberately does not touch the gate; only the queued callback does.
        Assert(!gate.TryBegin(), "a response timeout cannot permit an unbounded callback backlog");
        gate.Complete();
        Assert(gate.TryBegin(), "the slot reopens when the queued callback actually executes");
        gate.Complete();
    }

    private static void MainThreadPingHasProcessWideCallbackCeiling()
    {
        var gates = Enumerable.Range(0, MainThreadPingGate.MaxProcessOutstanding)
            .Select(_ => new MainThreadPingGate())
            .ToArray();
        var blocked = new MainThreadPingGate();
        try
        {
            Assert(gates.All(gate => gate.TryBegin()), "128 connections may each queue one main-thread ping callback");
            Assert(!blocked.TryBegin(), "the 129th process-wide callback is refused");
            gates[0].Complete();
            Assert(blocked.TryBegin(), "global admission recovers only after a queued callback completes");
        }
        finally
        {
            foreach (var gate in gates) gate.Complete();
            blocked.Complete();
        }
    }

    private static async Task IncompleteNetworkHeaderTimesOutAsync()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var client = new System.Net.Sockets.TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
        using var accepted = await listener.AcceptTcpClientAsync();
        await client.GetStream().WriteAsync(Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\nHost: localhost\r\n"));
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            await CouchCoopHttpRequest.TryReadAsync(accepted.GetStream()).WaitAsync(TimeSpan.FromSeconds(13));
            throw new Exception("incomplete network headers were accepted");
        }
        catch (HttpHeaderTimeoutException)
        {
            Assert(elapsed.Elapsed >= TimeSpan.FromSeconds(9), "the HTTP deadline permits a normal header to complete");
        }
    }

    private static async Task HeaderLimitRejectsUnterminatedAsync()
    {
        await using var stream = new MemoryStream(Enumerable.Repeat((byte)'x', CouchCoopHttpRequest.MaxHeaderBytes).ToArray());
        try
        {
            await CouchCoopHttpRequest.TryReadAsync(stream);
            throw new Exception("unterminated 32 KiB header was accepted");
        }
        catch (HttpHeaderLimitException) { }
    }

    private static async Task HeaderLimitRejectsTerminatorPastBoundaryAsync()
    {
        var prefix = "GET / HTTP/1.1\r\nX: ";
        var padding = new string('a', CouchCoopHttpRequest.MaxHeaderBytes - Encoding.ASCII.GetByteCount(prefix) - 3);
        await using var stream = new MemoryStream(Encoding.ASCII.GetBytes(prefix + padding + "\r\n\r\n"));
        try
        {
            await CouchCoopHttpRequest.TryReadWithPrefixAsync(stream);
            throw new Exception("a header ending one byte past the 32 KiB boundary was accepted");
        }
        catch (HttpHeaderLimitException) { }
    }

    private static async Task CancellationAndTimeoutReturnRentedBuffersAsync()
    {
        var timeoutPool = new TrackingBytePool();
        await using (var stalled = new BlockingReadStream())
        {
            try
            {
                await CouchCoopHttpRequest.TryReadWithPrefixAsync(
                    stalled, timeoutPool, TimeSpan.FromMilliseconds(20));
                throw new Exception("a stalled header did not time out");
            }
            catch (HttpHeaderTimeoutException) { }
        }
        Assert(timeoutPool.Outstanding == 0, "a header timeout returns its rented buffer");

        var cancellationPool = new TrackingBytePool();
        await using (var stalled = new BlockingReadStream())
        using (var stop = new CancellationTokenSource(TimeSpan.FromMilliseconds(20)))
        {
            try
            {
                await CouchCoopHttpRequest.TryReadWithPrefixAsync(
                    stalled, cancellationPool, TimeSpan.FromSeconds(1), stop.Token);
                throw new Exception("a cancelled header read completed");
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        }
        Assert(cancellationPool.Outstanding == 0, "caller cancellation returns its rented buffer");

        var prefixPool = new TrackingBytePool();
        await using var prefixed = new SegmentedDuplexStream(Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\n\r\nbody"));
        var result = await CouchCoopHttpRequest.TryReadWithPrefixAsync(
            prefixed, prefixPool, TimeSpan.FromSeconds(1));
        Assert(prefixPool.Outstanding == 1, "a live prefix stream owns its rented buffer");
        result!.Dispose();
        Assert(prefixPool.Outstanding == 0, "disposing an unread prefix stream returns its buffer");

        var zeroReadPool = new TrackingBytePool();
        var zeroReadPrefix = zeroReadPool.Rent(4);
        Encoding.ASCII.GetBytes("body").CopyTo(zeroReadPrefix, 0);
        await using (var stalledInner = new BlockingReadStream())
        using (var replay = new PrefixPreservingStream(stalledInner, zeroReadPool, zeroReadPrefix, 0, 4))
        using (var stop = new CancellationTokenSource(TimeSpan.FromMilliseconds(100)))
        {
            Assert(await replay.ReadAsync(Memory<byte>.Empty, stop.Token) == 0,
                "a zero-byte read returns immediately while a prefix is buffered");
            Assert(replay.Read(Array.Empty<byte>(), 0, 0) == 0,
                "a synchronous zero-byte read also leaves the prefix buffered");
            stop.Cancel();
            try
            {
                await replay.ReadAsync(new byte[1], stop.Token);
                throw new Exception("a cancelled prefix read consumed data");
            }
            catch (OperationCanceledException) { }
            var body = new byte[4];
            Assert(await replay.ReadAsync(body) == 4 && Encoding.ASCII.GetString(body) == "body",
                "zero-byte and cancelled reads preserve the complete prefix");
        }
        Assert(zeroReadPool.Outstanding == 0, "a zero-byte replay path returns its buffer once");

        var headerOnlyPool = new TrackingBytePool();
        await using var headerOnly = new SegmentedDuplexStream(Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\n\r\n"));
        using var headerOnlyResult = await CouchCoopHttpRequest.TryReadWithPrefixAsync(
            headerOnly, headerOnlyPool, TimeSpan.FromSeconds(1));
        Assert(headerOnlyPool.Outstanding == 0,
            "a chunked header read with no overread prefix returns its 32 KiB buffer immediately");
    }

    private static async Task ServerReturns431Async()
    {
        var root = Path.Combine(Path.GetTempPath(), "couchcoop-header-431-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            await using var server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(root), new MissingAssetAdapter(), isHeadlessClient: true);
            await using var stream = new SegmentedDuplexStream(
                Enumerable.Repeat((byte)'x', CouchCoopHttpRequest.MaxHeaderBytes).ToArray());
            await server.ServeAsync(stream, CancellationToken.None);
            Assert(stream.WrittenText.StartsWith("HTTP/1.1 431 ", StringComparison.Ordinal),
                "the server maps an over-limit header to HTTP 431");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task ServerConsumesBodyPrefixAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "couchcoop-body-prefix-" + Guid.NewGuid().ToString("N"));
        var staticRoot = Path.Combine(root, "static");
        var artifactRoot = Path.Combine(root, "artifacts");
        Directory.CreateDirectory(staticRoot);
        try
        {
            var diagnostics = new BrowserLifecycleDiagnostics(artifactRoot);
            var meta = diagnostics.BeginVisitMeta();
            const string contentPrefix = "content=\"";
            var encodedStart = meta.IndexOf(contentPrefix, StringComparison.Ordinal) + contentPrefix.Length;
            var encodedEnd = meta.IndexOf('"', encodedStart);
            using var config = System.Text.Json.JsonDocument.Parse(
                Encoding.UTF8.GetString(Convert.FromBase64String(meta[encodedStart..encodedEnd])));
            var nonce = config.RootElement.GetProperty("nonce").GetString();
            var body = $"{{\"nonce\":\"{nonce}\",\"events\":[]}}";
            var request = Encoding.UTF8.GetBytes(
                $"POST {BrowserLifecycleDiagnostics.Route} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\n\r\n{body}");

            await using var server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(staticRoot), new MissingAssetAdapter(), isHeadlessClient: true,
                lifecycleDiagnostics: diagnostics);
            await using var stream = new SegmentedDuplexStream(request);
            await server.ServeAsync(stream, CancellationToken.None);
            Assert(stream.WrittenText.StartsWith("HTTP/1.1 204 ", StringComparison.Ordinal),
                "a POST body overread with its headers reaches the route intact");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task HeaderLimitAcceptsBoundaryTerminatorAsync()
    {
        var prefix = "GET / HTTP/1.1\r\nX: ";
        var padding = new string('a', CouchCoopHttpRequest.MaxHeaderBytes - Encoding.ASCII.GetByteCount(prefix) - 4);
        await using var stream = new MemoryStream(Encoding.ASCII.GetBytes(prefix + padding + "\r\n\r\n"));
        using var read = await CouchCoopHttpRequest.TryReadWithPrefixAsync(stream);
        Assert(read?.Request.Path == "/", "terminator ending at byte 32 KiB is accepted");
    }

    private static void QueryValuesAreParsedOnce()
    {
        using var stream = new MemoryStream(Encoding.ASCII.GetBytes("GET /?a=one&b=two HTTP/1.1\r\n\r\n"));
        var request = CouchCoopHttpRequest.TryReadAsync(stream).GetAwaiter().GetResult();
        Assert(request is not null && ReferenceEquals(request.QueryValues, request.QueryValues),
            "query parsing is cached on the request");
        Assert(request!.QueryValues["a"] == "one" && request.QueryValues["b"] == "two",
            "the cached query retains decoded values");
    }

    private static void AdmissionCapsAndRecovers()
    {
        var limiter = new NetworkAdmissionLimiter(() => 20); // WS limit = 80
        var address = IPAddress.Parse("192.0.2.1");
        var leases = Enumerable.Range(0, NetworkAdmissionLimiter.MaxHttpConnectionsPerAddress)
            .Select(_ => limiter.TryAcquireHttp(address)).ToArray();
        Assert(leases.All(x => x is not null), "per-address HTTP capacity is admitted");
        Assert(limiter.TryAcquireHttp(address) is null, "per-address HTTP capacity is enforced");
        leases[0]!.Dispose();
        Assert(limiter.TryAcquireHttp(address) is { } recovered && DisposeTrue(recovered), "released HTTP capacity is reusable");
        foreach (var lease in leases) lease?.Dispose();

        var global = Enumerable.Range(0, NetworkAdmissionLimiter.MaxHttpConnections)
            .Select(i => limiter.TryAcquireHttp(IPAddress.Parse(i < 64 ? "192.0.2.1" : "192.0.2.2"))).ToArray();
        Assert(global.All(x => x is not null), "two addresses can fill the global HTTP ceiling");
        Assert(limiter.TryAcquireHttp(IPAddress.Parse("192.0.2.3")) is null, "another address cannot exceed the global ceiling");
        foreach (var lease in global) lease?.Dispose();

        var sockets = Enumerable.Range(0, 80).Select(_ => limiter.TryAcquireWebSocket()).ToArray();
        Assert(sockets.All(x => x is not null), "four WebSockets per supported player are admitted");
        Assert(limiter.TryAcquireWebSocket() is null, "dynamic WebSocket ceiling is enforced");
        sockets[0]!.Dispose();
        Assert(limiter.TryAcquireWebSocket() is { } wsRecovered && DisposeTrue(wsRecovered), "released WebSocket capacity is reusable");
        foreach (var lease in sockets) lease?.Dispose();
    }

    private static async Task InputQueueAppliesAwaitableBackpressureInOrder()
    {
        var queue = new BoundedInputQueue(256);
        for (var i = 0; i < 256; i++)
        {
            await queue.EnqueueAsync(new BrowserInputRequestEnvelope("input", i.ToString(), BrowserInputKinds.Click, Button: "left"), CancellationToken.None);
        }
        var blocked = queue.EnqueueAsync(new BrowserInputRequestEnvelope("input", "256", BrowserInputKinds.Click, Button: "left"), CancellationToken.None);
        await Task.Delay(25);
        Assert(!blocked.IsCompleted, "the 257th discrete input waits instead of growing the queue");
        Assert(queue.Take()?.RequestId == "0", "the oldest accepted edge drains first");
        await blocked.WaitAsync(TimeSpan.FromSeconds(1));
        for (var i = 1; i <= 256; i++)
        {
            Assert(queue.Take()?.RequestId == i.ToString(), "backpressured edges retain FIFO order");
        }
    }

    private static bool DisposeTrue(IDisposable value) { value.Dispose(); return true; }

    private sealed class MissingAssetAdapter : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
            string opaqueKey,
            CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default,
            CancellationToken cancellationToken = default)
            => Task.FromResult(CouchCoopAssetHttpResponse.Missing(
                new CouchCoopAssetHttpError("missing", "missing")));
    }

    private sealed class TrackingBytePool : ArrayPool<byte>
    {
        private int _outstanding;
        public int Outstanding => Volatile.Read(ref _outstanding);

        public override byte[] Rent(int minimumLength)
        {
            Interlocked.Increment(ref _outstanding);
            return new byte[minimumLength];
        }

        public override void Return(byte[] array, bool clearArray = false)
        {
            if (Interlocked.Decrement(ref _outstanding) < 0)
                throw new Exception("a rented HTTP buffer was returned twice");
        }
    }

    private sealed class BlockingReadStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class SegmentedDuplexStream(params byte[][] segments) : Stream
    {
        private readonly Queue<byte[]> _segments = new(segments);
        private readonly MemoryStream _written = new();
        private int _segmentOffset;

        public string WrittenText => Encoding.UTF8.GetString(_written.ToArray());
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
            => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            if (_segments.Count == 0) return 0;
            var segment = _segments.Peek();
            var copied = Math.Min(buffer.Length, segment.Length - _segmentOffset);
            segment.AsSpan(_segmentOffset, copied).CopyTo(buffer);
            _segmentOffset += copied;
            if (_segmentOffset == segment.Length)
            {
                _segments.Dequeue();
                _segmentOffset = 0;
            }
            return copied;
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(Read(buffer.Span));
        }

        public override void Write(byte[] buffer, int offset, int count) => _written.Write(buffer, offset, count);
        public override void Write(ReadOnlySpan<byte> buffer) => _written.Write(buffer);
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _written.Write(buffer.Span);
            return ValueTask.CompletedTask;
        }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing) _written.Dispose();
            base.Dispose(disposing);
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception("NetworkHardeningTests failed: " + message);
    }
}
