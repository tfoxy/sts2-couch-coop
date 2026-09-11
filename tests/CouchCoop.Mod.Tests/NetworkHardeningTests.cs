using System.Net;
using System.Text;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Server;

internal static class NetworkHardeningTests
{
    public static async Task RunAsync()
    {
        await HeaderLimitRejectsUnterminatedAsync();
        await IncompleteNetworkHeaderTimesOutAsync();
        HeaderLimitAcceptsBoundaryTerminator();
        AdmissionCapsAndRecovers();
        AttachedAdmissionTransfersOwnership();
        await InputQueueAppliesAwaitableBackpressureInOrder();
        MainThreadPingRemainsSingleFlightUntilCallback();
        MainThreadPingHasProcessWideCallbackCeiling();
        Console.WriteLine("NetworkHardeningTests: ok");
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

    private static void HeaderLimitAcceptsBoundaryTerminator()
    {
        var prefix = "GET / HTTP/1.1\r\nX: ";
        var padding = new string('a', CouchCoopHttpRequest.MaxHeaderBytes - Encoding.ASCII.GetByteCount(prefix) - 4);
        using var stream = new MemoryStream(Encoding.ASCII.GetBytes(prefix + padding + "\r\n\r\n"));
        var request = CouchCoopHttpRequest.TryReadAsync(stream).GetAwaiter().GetResult();
        Assert(request?.Path == "/", "terminator ending at byte 32 KiB is accepted");
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
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception("NetworkHardeningTests failed: " + message);
    }
}
