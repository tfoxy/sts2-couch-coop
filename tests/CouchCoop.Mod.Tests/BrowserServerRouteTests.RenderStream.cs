using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Tests;

// "Use new renderer (Beta)" (MIR-3): the streaming seat's descriptor on the seat's OWN socket, exactly as a viewer
// reaches it — a browser WebSocket to a host listener that relays the upgrade through the seat's private pipe
// (SeatBrowserPipe.RelayAsync, the host's /ws?seat= path) to the seat's real browser server.
//
// What must hold:
//   * the streaming seat's `session` carries `renderStream` (hub url, resource base, the capture's token, /12,
//     1920x1080) for a page whose Origin the hub allows, on connect and again on `session-refresh`;
//   * the same seat sends none to any other Origin, nor to a client that sends no Origin;
//   * a seat that is not the streaming seat sends none, even to an allowed Origin.
//
// The role is read once per process, so the streaming half runs in a child process launched with the seat's
// environment (RenderStreamSeatChildVerb); this process is the non-streaming seat.
internal sealed partial class BrowserServerRouteTests
{
    public const string RenderStreamSeatChildVerb = "render-stream-seat-child";

    private const string AllowedPageOrigin = "http://127.0.0.1:13337";
    private const string RenderStreamSeatToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    internal static async Task RunRenderStreamDescriptorRoutesAsync()
    {
        // This process is a seat that does not stream.
        Expect(Environment.GetEnvironmentVariable("COUCHCOOP_STREAMING_SEAT") != "1", "the parent is not the streaming seat");
        using (var evidence = new TempEvidence())
        {
            await using var seat = await RelayedSeat.StartAsync();
            using var session = await seat.SessionAsync(AllowedPageOrigin);
            Expect(!session.RootElement.TryGetProperty("renderStream", out _),
                "a seat that is not the streaming seat sends no descriptor, even to an allowed page");
        }

        using var child = new TempEvidence();
        File.WriteAllText(Path.Combine(child.Path, "live-token"), RenderStreamSeatToken + "\n");
        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(typeof(BrowserServerRouteTests).Assembly.Location);
        start.ArgumentList.Add(RenderStreamSeatChildVerb);
        start.Environment["COUCHCOOP_STREAMING_SEAT"] = "1";
        start.Environment["GRC_LIVE_ALLOWED_ORIGINS"] = $"{AllowedPageOrigin},http://localhost:13337";
        start.Environment["GRC_LIVE_LISTEN"] = "127.0.0.1:13366";
        start.Environment["GRC_STREAM_VERSION"] = "12";
        start.Environment["GRC_LIVE_AUTH"] = "token";
        start.Environment["GRC_EVIDENCE_DIR"] = child.Path;
        start.Environment["GRC_ROOT_SIZE"] = "presentation:1920x1080";
        // The browser server's own Origin-vs-Host check (CouchCoopWebOrigin) is not what is under test, and this
        // rig cannot be reached at a LAN or `localhost` Host for every Origin it sends; the descriptor gate is.
        start.Environment["COUCHCOOP_WS_ORIGIN_CHECK"] = "0";
        using var process = Process.Start(start) ?? throw new InvalidOperationException("could not start the seat child");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        try
        {
            await process.WaitForExitAsync(deadline.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            throw new Exception("[render-stream route] the streaming seat child did not finish in 60 s");
        }

        var output = await stdout + await stderr;
        Expect(process.ExitCode == 0, $"the streaming seat child passed (exit {process.ExitCode}): {output}");
        Expect(!output.Contains(RenderStreamSeatToken, StringComparison.Ordinal), "the child printed no token");
        Console.WriteLine("render-stream descriptor routes: ok");
    }

    /// <summary>The streaming seat's half, in a process launched with the seat's environment.</summary>
    internal static async Task<int> RunRenderStreamSeatChildAsync(string[] args)
    {
        _ = args;
        try
        {
            await using var seat = await RelayedSeat.StartAsync();
            foreach (var origin in new[] { AllowedPageOrigin, "http://localhost:13337" })
            {
                using var session = await seat.SessionAsync(origin);
                ExpectDescriptor(session.RootElement, $"the streaming seat's session for {origin}");
            }

            foreach (var origin in new string?[] { "http://192.168.1.20:13337", "https://127.0.0.1:13338", null })
            {
                using var session = await seat.SessionAsync(origin);
                Expect(!session.RootElement.TryGetProperty("renderStream", out _),
                    $"no descriptor for a page the hub refuses ({origin ?? "no Origin"})");
            }

            // `session-refresh` (the new renderer's one ask after `unauthorized`) answers with the current descriptor.
            using var socket = await seat.ConnectAsync(AllowedPageOrigin);
            using (var first = await ReadSessionAsync(socket)) ExpectDescriptor(first.RootElement, "connect");
            await socket.SendAsync(Encoding.UTF8.GetBytes("{\"type\":\"session-refresh\"}"), WebSocketMessageType.Text,
                true, CancellationToken.None);
            using (var refreshed = await ReadSessionAsync(socket)) ExpectDescriptor(refreshed.RootElement, "session-refresh");
            await CloseWebSocketSilentlyAsync(socket);
            return 0;
        }
        catch (Exception error)
        {
            // The message names what failed; the assertions never put the token in it.
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static void ExpectDescriptor(JsonElement session, string where)
    {
        Expect(session.TryGetProperty("renderStream", out var rs), $"{where}: carries renderStream");
        Expect(rs.GetProperty("url").GetString() == "ws://127.0.0.1:13366/render-stream", $"{where}: hub url");
        Expect(rs.GetProperty("resourceBase").GetString() == "http://127.0.0.1:13366", $"{where}: resource base");
        Expect(rs.GetProperty("token").GetString() == RenderStreamSeatToken, $"{where}: the capture's token");
        Expect(rs.GetProperty("protocol").GetInt32() == 12, $"{where}: /12");
        Expect(rs.GetProperty("presentation").EnumerateArray().Select(e => e.GetInt32()).SequenceEqual([1920, 1080]),
            $"{where}: 1920x1080");
    }

    private static async Task<JsonDocument> ReadSessionAsync(ClientWebSocket socket)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (true)
        {
            var document = JsonDocument.Parse(await ReadWsMessageAsync(socket, deadline.Token));
            if (document.RootElement.TryGetProperty("type", out var type) && type.GetString() == "session") return document;
            document.Dispose();
        }
    }

    // A seat's real browser server behind its private pipe, and a "host" listener that relays a browser's upgrade to
    // it the way CouchCoopBrowserServer.RelaySeatWebSocketAsync does: the raw header, Origin included, byte for byte.
    private sealed class RelayedSeat : IAsyncDisposable
    {
        private readonly TempStaticRoot _root;
        private readonly HopCountingMainThread _mainThread;
        private readonly IGameMainThread? _previousThread;
        private readonly CouchCoopBrowserServer _server;
        private readonly SeatBrowserPipe _pipe;
        private readonly TcpListener _host;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _relay;

        private RelayedSeat(TempStaticRoot root, HopCountingMainThread mainThread, IGameMainThread? previousThread,
            CouchCoopBrowserServer server, SeatBrowserPipe pipe, TcpListener host, string pipeName, string pipeToken)
        {
            _root = root;
            _mainThread = mainThread;
            _previousThread = previousThread;
            _server = server;
            _pipe = pipe;
            _host = host;
            _relay = RelayLoopAsync(pipeName, pipeToken);
        }

        public static async Task<RelayedSeat> StartAsync()
        {
            var root = new TempStaticRoot();
            var previous = GameMainThread.Source;
            var mainThread = new HopCountingMainThread();
            GameMainThread.Source = mainThread;
            var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.MultiplayerRun };
            var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path), new CapturingAssetAdapter(),
                runtime.NewEnvelopeFactory(), preferredPort: 0, isHeadlessClient: true,
                hostBrowserAccess: new TestHostBrowserAccess());
            await server.StartAsync();
            var pipeName = SeatBrowserPipe.EndpointFor("CouchRsTest" + Guid.NewGuid().ToString("N"));
            var pipeToken = new string('c', 64);
            var pipe = SeatBrowserPipe.Start(pipeName, pipeToken,
                (stream, secure, address, cancellation) => server.ServeAsync(stream, secure, address, cancellation));
            var host = new TcpListener(IPAddress.Loopback, 0);
            host.Start();
            return new RelayedSeat(root, mainThread, previous, server, pipe, host, pipeName, pipeToken);
        }

        public async Task<ClientWebSocket> ConnectAsync(string? origin)
        {
            var socket = new ClientWebSocket();
            if (origin is not null) socket.Options.SetRequestHeader("Origin", origin);
            var port = ((IPEndPoint)_host.LocalEndpoint).Port;
            await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws?seat=rs&{GatedQuery}"), CancellationToken.None);
            return socket;
        }

        public async Task<JsonDocument> SessionAsync(string? origin)
        {
            using var socket = await ConnectAsync(origin);
            var session = await ReadSessionAsync(socket);
            await CloseWebSocketSilentlyAsync(socket);
            return session;
        }

        private async Task RelayLoopAsync(string pipeName, string pipeToken)
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient browser;
                try
                {
                    browser = await _host.AcceptTcpClientAsync(_stop.Token);
                }
                catch (Exception) when (_stop.IsCancellationRequested)
                {
                    return;
                }

                _ = Task.Run(async () =>
                {
                    using (browser)
                    {
                        var stream = browser.GetStream();
                        var header = await ReadUpgradeHeaderAsync(stream, _stop.Token);
                        try
                        {
                            await SeatBrowserPipe.RelayAsync(pipeName, pipeToken, stream, header, IPAddress.Loopback,
                                false, _stop.Token);
                        }
                        catch (Exception) when (_stop.IsCancellationRequested)
                        {
                        }
                    }
                });
            }
        }

        private static async Task<byte[]> ReadUpgradeHeaderAsync(Stream stream, CancellationToken cancellation)
        {
            using var header = new MemoryStream();
            var next = new byte[1];
            while (header.Length < 8192)
            {
                if (await stream.ReadAsync(next, cancellation) == 0) throw new EndOfStreamException("browser closed");
                header.WriteByte(next[0]);
                var bytes = header.GetBuffer();
                var length = (int)header.Length;
                if (length >= 4 && bytes[length - 4] == '\r' && bytes[length - 3] == '\n'
                    && bytes[length - 2] == '\r' && bytes[length - 1] == '\n')
                {
                    return header.ToArray();
                }
            }

            throw new InvalidDataException("upgrade header too long");
        }

        public async ValueTask DisposeAsync()
        {
            await _stop.CancelAsync();
            _host.Stop();
            try { await _relay; } catch { }
            await _pipe.DisposeAsync();
            await _server.DisposeAsync();
            GameMainThread.Source = _previousThread;
            _mainThread.Dispose();
            _root.Dispose();
            _stop.Dispose();
        }
    }

    private sealed class TempEvidence : IDisposable
    {
        public TempEvidence()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-rs-evidence-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); } catch (IOException) { }
        }
    }
}
