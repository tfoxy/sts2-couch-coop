using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Text;
using CouchCoop.Mod;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Tests;

internal static class SeatBrowserPipeTests
{
    public const string HostUiChildVerb = "seat-pipe-hostui-child";
    private static readonly TimeSpan TestDeadline = TimeSpan.FromSeconds(10);

    public static async Task RunAsync()
    {
        await TwoSeatsShareOneBrowserListenerAsync();
        await WrongTokenCannotReachSeatAsync();
        await RejectedUpgradeIsReportedAsync();
        await ClosedViewerDoesNotFailSeatAsync();
        await IncompletePreludeTimesOutAndSeatStillAcceptsAsync();
        await HeadlessHostUiKeepsPipeAliveAsync();
        Console.WriteLine("SeatBrowserPipeTests: ok");
    }

    public static async Task<int> RunHostUiChildAsync()
    {
        try
        {
            Expect(CouchCoopMod.IsHeadlessClient, "child process is a headless seat");
            var deps = new CouchCoopRuntimeDependencies(
                new BrowserServerRouteTests.RecordingSpirectlRuntime(), new BrowserServerRouteTests.RecordingSpirectlRuntime(), new BrowserServerRouteTests.RecordingSpirectlRuntime(),
                new BrowserServerRouteTests.RecordingSpirectlRuntime(), new BrowserServerRouteTests.RecordingSpirectlRuntime(), new BrowserServerRouteTests.RecordingSpirectlRuntime(),
                new BrowserServerRouteTests.RecordingSpirectlRuntime(), new BrowserServerRouteTests.RecordingSpirectlRuntime(), new BrowserServerRouteTests.RecordingSpirectlRuntime());
            await using var service = new CouchCoopHostUiServices(new CouchCoopRuntimeHost(deps),
                staticRoot: Path.GetTempPath(), bindAddress: IPAddress.Loopback,
                preferredPort: 13357, deferDiscoveryServices: false);
            var snapshot = await service.StartAsync();
            Expect(!snapshot.Available && snapshot.ListenerBaseUri?.Scheme == "pipe",
                "pipe-backed seat has an inert host-UI snapshot, not a TCP join URL");
            Expect(service.HotServerHost is HotReloadableBrowserServerHost { IsRunning: true },
                "host-UI startup keeps the seat pipe server running");
            Expect(HeadlessConnectionReporter.IsRelayReadyForTests,
                "the built-in browser generation announces pipe readiness during startup");
            using var peer = new NamedPipeClientStream(".",
                Environment.GetEnvironmentVariable(SeatBrowserPipe.NameEnvironmentVariable)!,
                PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await peer.ConnectAsync(1000);
            Expect(peer.IsConnected, "the private pipe is connectable after host-UI startup");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static async Task HeadlessHostUiKeepsPipeAliveAsync()
    {
        var assembly = typeof(SeatBrowserPipeTests).Assembly.Location;
        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(assembly);
        start.ArgumentList.Add(HostUiChildVerb);
        start.Environment["COUCHCOOP_HEADLESS_CLIENT"] = "1";
        start.Environment[SeatBrowserPipe.NameEnvironmentVariable] = PipeName();
        start.Environment[SeatBrowserPipe.TokenEnvironmentVariable] = new string('f', 64);
        using var child = Process.Start(start) ?? throw new InvalidOperationException("Could not start seat host-UI child.");
        using var deadline = new CancellationTokenSource(TestDeadline);
        await child.WaitForExitAsync(deadline.Token);
        var stderr = await child.StandardError.ReadToEndAsync(deadline.Token);
        Expect(child.ExitCode == 0, "headless host-UI startup keeps the pipe alive: " + stderr);
    }

    private static async Task TwoSeatsShareOneBrowserListenerAsync()
    {
        var observed = new ConcurrentBag<(string Seat, string Header, bool Secure, IPAddress Address)>();
        var nameA = PipeName();
        var nameB = PipeName();
        var tokenA = new string('a', 64);
        var tokenB = new string('b', 64);
        using var legacyA = HoldOrObserveOccupiedSeatPort(13357);
        using var legacyB = HoldOrObserveOccupiedSeatPort(13367);
        await using var seatA = SeatBrowserPipe.Start(nameA, tokenA,
            (stream, secure, address, cancellation) => ServeSeatAsync("A", stream, secure, address, observed, cancellation));
        await using var seatB = SeatBrowserPipe.Start(nameB, tokenB,
            (stream, secure, address, cancellation) => ServeSeatAsync("B", stream, secure, address, observed, cancellation));

        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var browserPort = ((IPEndPoint)listener.LocalEndpoint).Port;
        using var deadline = new CancellationTokenSource(TestDeadline);
        var accepted = Enumerable.Range(0, 3).Select(async _ =>
        {
            using var browser = await listener.AcceptTcpClientAsync(deadline.Token);
            var stream = browser.GetStream();
            var header = await ReadHeaderAsync(stream, deadline.Token);
            var forA = Encoding.ASCII.GetString(header).StartsWith("GET /ws?seat=A ", StringComparison.Ordinal);
            await SeatBrowserPipe.RelayAsync(forA ? nameA : nameB, forA ? tokenA : tokenB,
                stream, header, IPAddress.Loopback, !forA, deadline.Token);
        }).ToArray();

        var firstA = BrowserRoundTripAsync(browserPort, "A", "one", deadline.Token);
        var firstB = BrowserRoundTripAsync(browserPort, "B", "two", deadline.Token);
        await Task.WhenAll(firstA, firstB);
        Expect(firstA.Result == "A:one" && firstB.Result == "B:two",
            "concurrent browser streams receive only their own seat response");
        var reconnectA = await BrowserRoundTripAsync(browserPort, "A", "new", deadline.Token);
        Expect(reconnectA == "A:new", "a browser can reconnect to its same private seat pipe");
        await Task.WhenAll(accepted);

        Expect(observed.Count == 3, "each of three browser streams reached exactly one seat callback");
        Expect(observed.Count(item => item.Seat == "A") == 2 && observed.Count(item => item.Seat == "B") == 1,
            "the two seats and A's reconnect remain isolated");
        foreach (var item in observed)
        {
            Expect(item.Header == BrowserHeader(item.Seat),
                "the original WebSocket upgrade request reaches the selected seat byte for byte");
            Expect(item.Address.Equals(IPAddress.Loopback), "the original browser address reaches the seat");
            Expect(item.Secure == (item.Seat == "B"), "the host's secure flag reaches the selected seat");
        }
        // The legacy browser ports stay occupied throughout both joins and the reconnect. The
        // sole browser listener above is enough; neither SeatBrowserPipe.Start binds a TCP port.
    }

    private static async Task WrongTokenCannotReachSeatAsync()
    {
        var name = PipeName();
        var calls = 0;
        await using var seat = SeatBrowserPipe.Start(name, new string('c', 64),
            (_, _, _, _) => { Interlocked.Increment(ref calls); return Task.CompletedTask; });
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var deadline = new CancellationTokenSource(TestDeadline);
        var relay = Task.Run(async () =>
        {
            using var accepted = await listener.AcceptTcpClientAsync(deadline.Token);
            var stream = accepted.GetStream();
            var header = await ReadHeaderAsync(stream, deadline.Token);
            await SeatBrowserPipe.RelayAsync(name, new string('d', 64), stream, header,
                IPAddress.Loopback, false, deadline.Token);
        });
        using var browser = new TcpClient();
        await browser.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port, deadline.Token);
        await browser.GetStream().WriteAsync(Encoding.ASCII.GetBytes(BrowserHeader("wrong-token")), deadline.Token);
        var rejected = false;
        try { await relay; }
        catch (IOException) { rejected = true; }
        Expect(rejected, "a wrong private token closes before an upgrade response");
        Expect(Volatile.Read(ref calls) == 0, "an unauthenticated stream never reaches the seat server");
    }

    private static async Task RejectedUpgradeIsReportedAsync()
    {
        var name = PipeName();
        var token = new string('8', 64);
        await using var seat = SeatBrowserPipe.Start(name, token, async (stream, _, _, cancellation) =>
        {
            await ReadHeaderAsync(stream, cancellation);
            await stream.WriteAsync(Encoding.ASCII.GetBytes(
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n"), cancellation);
        });
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var deadline = new CancellationTokenSource(TestDeadline);
        var relay = Task.Run(async () =>
        {
            using var accepted = await listener.AcceptTcpClientAsync(deadline.Token);
            var stream = accepted.GetStream();
            var header = await ReadHeaderAsync(stream, deadline.Token);
            await SeatBrowserPipe.RelayAsync(name, token, stream, header,
                IPAddress.Loopback, false, deadline.Token);
        });
        using var browser = new TcpClient();
        await browser.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port, deadline.Token);
        await browser.GetStream().WriteAsync(Encoding.ASCII.GetBytes(BrowserHeader("rejected")), deadline.Token);
        var rejected = false;
        try { await relay; }
        catch (SeatRelayUpgradeRejectedException) { rejected = true; }
        Expect(rejected, "a seat HTTP 503 is reported as a failed upgrade, never accepted as a WebSocket");
    }

    private static async Task ClosedViewerDoesNotFailSeatAsync()
    {
        var name = PipeName();
        var token = new string('9', 64);
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        await using var seat = SeatBrowserPipe.Start(name, token, async (stream, _, _, cancellation) =>
        {
            await ReadHeaderAsync(stream, cancellation);
            if (Interlocked.Increment(ref calls) == 1)
            {
                firstEntered.TrySetResult();
                await releaseFirst.Task.WaitAsync(cancellation);
                return;
            }
            await stream.WriteAsync(Encoding.ASCII.GetBytes(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"), cancellation);
        });
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var deadline = new CancellationTokenSource(TestDeadline);
        var browserPort = ((IPEndPoint)listener.LocalEndpoint).Port;
        var relay = Task.Run(async () =>
        {
            using var accepted = await listener.AcceptTcpClientAsync(deadline.Token);
            var stream = accepted.GetStream();
            var header = await ReadHeaderAsync(stream, deadline.Token);
            await SeatBrowserPipe.RelayAsync(name, token, stream, header,
                IPAddress.Loopback, false, deadline.Token);
        });
        using (var browser = new TcpClient())
        {
            await browser.ConnectAsync(IPAddress.Loopback, browserPort, deadline.Token);
            await browser.GetStream().WriteAsync(Encoding.ASCII.GetBytes(BrowserHeader("closed")), deadline.Token);
            await firstEntered.Task.WaitAsync(deadline.Token);
        }
        await relay.WaitAsync(TimeSpan.FromSeconds(2));
        releaseFirst.TrySetResult();

        var nextRelay = Task.Run(async () =>
        {
            using var accepted = await listener.AcceptTcpClientAsync(deadline.Token);
            var stream = accepted.GetStream();
            var header = await ReadHeaderAsync(stream, deadline.Token);
            await SeatBrowserPipe.RelayAsync(name, token, stream, header,
                IPAddress.Loopback, false, deadline.Token);
        });
        using var nextBrowser = new TcpClient();
        await nextBrowser.ConnectAsync(IPAddress.Loopback, browserPort, deadline.Token);
        await nextBrowser.GetStream().WriteAsync(Encoding.ASCII.GetBytes(BrowserHeader("next")), deadline.Token);
        var upgrade = Encoding.ASCII.GetString(await ReadHeaderAsync(nextBrowser.GetStream(), deadline.Token));
        Expect(upgrade.StartsWith("HTTP/1.1 101", StringComparison.Ordinal),
            "a viewer closing during a slow upgrade leaves the seat relay reusable");
        nextBrowser.Close();
        await nextRelay.WaitAsync(deadline.Token);
        Expect(Volatile.Read(ref calls) == 2, "the second viewer reaches the same seat pipe");
    }

    private static async Task IncompletePreludeTimesOutAndSeatStillAcceptsAsync()
    {
        var name = PipeName();
        var seat = SeatBrowserPipe.Start(name, new string('e', 64),
            (_, _, _, _) => Task.CompletedTask);
        try
        {
            using var stalled = new NamedPipeClientStream(".", name, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            await stalled.ConnectAsync(1000, deadline.Token);
            var read = await stalled.ReadAsync(new byte[1], deadline.Token);
            Expect(read == 0, "an incomplete prelude is closed at the pipe's authentication deadline");

            using var next = new NamedPipeClientStream(".", name, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await next.ConnectAsync(1000, deadline.Token);
            Expect(next.IsConnected, "one stalled connection does not stop the seat pipe listener");
        }
        finally { await seat.DisposeAsync(); }

        using var stopped = new NamedPipeClientStream(".", name, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        using var stopDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var refused = false;
        try { await stopped.ConnectAsync(250, stopDeadline.Token); }
        catch (Exception error) when (error is TimeoutException or IOException) { refused = true; }
        Expect(refused, "disposing a seat removes its private listener");
    }

    private static async Task ServeSeatAsync(string seat, Stream stream, bool secure, IPAddress address,
        ConcurrentBag<(string Seat, string Header, bool Secure, IPAddress Address)> observed,
        CancellationToken cancellation)
    {
        var header = Encoding.ASCII.GetString(await ReadHeaderAsync(stream, cancellation));
        observed.Add((seat, header, secure, address));
        await stream.WriteAsync(Encoding.ASCII.GetBytes(
            $"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nX-Seat: {seat}\r\n\r\n"), cancellation);
        var request = new byte[3];
        await stream.ReadExactlyAsync(request, cancellation);
        await stream.WriteAsync(Encoding.ASCII.GetBytes($"{seat}:{Encoding.ASCII.GetString(request)}"), cancellation);
    }

    private static async Task<string> BrowserRoundTripAsync(int port, string seat, string message,
        CancellationToken cancellation)
    {
        using var browser = new TcpClient();
        await browser.ConnectAsync(IPAddress.Loopback, port, cancellation);
        var stream = browser.GetStream();
        await stream.WriteAsync(Encoding.ASCII.GetBytes(BrowserHeader(seat)), cancellation);
        var response = Encoding.ASCII.GetString(await ReadHeaderAsync(stream, cancellation));
        Expect(response.StartsWith("HTTP/1.1 101 Switching Protocols\r\n", StringComparison.Ordinal)
            && response.Contains($"X-Seat: {seat}\r\n", StringComparison.Ordinal),
            "each browser sees the selected seat's upgrade response");
        await stream.WriteAsync(Encoding.ASCII.GetBytes(message), cancellation);
        var result = new byte[2 + message.Length];
        await stream.ReadExactlyAsync(result, cancellation);
        return Encoding.ASCII.GetString(result);
    }

    private static async Task<byte[]> ReadHeaderAsync(Stream stream, CancellationToken cancellation)
    {
        using var header = new MemoryStream();
        var next = new byte[1];
        while (header.Length < 4096)
        {
            if (await stream.ReadAsync(next, cancellation) == 0)
                throw new EndOfStreamException("The browser or seat closed before the upgrade header.");
            header.WriteByte(next[0]);
            var bytes = header.GetBuffer();
            var length = (int)header.Length;
            if (length >= 4 && bytes[length - 4] == '\r' && bytes[length - 3] == '\n'
                && bytes[length - 2] == '\r' && bytes[length - 1] == '\n') return header.ToArray();
        }
        throw new InvalidDataException("The upgrade header exceeded the test limit.");
    }

    private static string PipeName() => "CouchSeatTest" + Guid.NewGuid().ToString("N");

    private static string BrowserHeader(string seat)
        => $"GET /ws?seat={seat} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";

    private static Socket? HoldOrObserveOccupiedSeatPort(int port)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        try
        {
            socket.Bind(new IPEndPoint(IPAddress.Any, port));
            socket.Listen(1);
            return socket;
        }
        catch (SocketException error) when (error.SocketErrorCode == SocketError.AddressAlreadyInUse)
        {
            socket.Dispose();
            return null; // Another process already provides the occupied-port condition.
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"SeatBrowserPipeTests failed: {because}");
    }
}
