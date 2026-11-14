using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Tests;

// Runtime renderer changes travel through the host relay and the seat's real WebSocket receive loop.
// Capture signals are injected at the process-lifetime host; no credential files or native engine are needed.
internal sealed partial class BrowserServerRouteTests
{
    public const string RenderStreamSeatChildVerb = "render-stream-seat-child";

    private const string AllowedPageOrigin = "http://127.0.0.1:13337";
    private const string RenderStreamSeatToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    internal static async Task RunRenderStreamDescriptorRoutesAsync()
    {
        await using (var seat = await RelayedSeat.StartAsync())
        {
            using var socket = await seat.ConnectAsync(AllowedPageOrigin);
            using (var session = await ReadSessionAsync(socket)) ExpectRenderer(session.RootElement, "mirror");
            await SendRendererAsync(socket, "stream");
            using (var session = await ReadSessionAsync(socket)) ExpectRenderer(session.RootElement, "failed", "no-capture");
            await SendRendererAsync(socket, "mirror");
            using (var session = await ReadSessionAsync(socket)) ExpectRenderer(session.RootElement, "mirror");
        }

        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(typeof(BrowserServerRouteTests).Assembly.Location);
        start.ArgumentList.Add(RenderStreamSeatChildVerb);
        start.Environment["COUCHCOOP_HEADLESS_CLIENT"] = "1";
        start.Environment["COUCHCOOP_STREAMING_SEAT"] = "1";
        start.Environment["GRC_LIVE_ALLOWED_ORIGINS"] = $"{AllowedPageOrigin},http://localhost:13337";
        start.Environment["GRC_LIVE_LISTEN"] = "127.0.0.1:13366";
        start.Environment["GRC_STREAM_VERSION"] = "13";
        start.Environment["GRC_LIVE_AUTH"] = "token";
        start.Environment["GRC_LIVE_CARRIERS"] = "ws,wt";
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
        Console.WriteLine("render-stream descriptor routes: 3 passed.");
    }

    /// <summary>The streaming seat's half, in a process launched with the seat's environment.</summary>
    internal static async Task<int> RunRenderStreamSeatChildAsync(string[] args)
    {
        _ = args;
        try
        {
            await using var seat = await RelayedSeat.StartAsync(withCapture: true);
            using var socket = await seat.ConnectAsync(AllowedPageOrigin);
            using (var first = await ReadSessionAsync(socket)) ExpectRenderer(first.RootElement, "mirror");
            await SendRendererAsync(socket, "stream", "2.1666666666666665");
            using (var arming = await ReadRendererAsync(socket, "arming")) ExpectRenderer(arming.RootElement, "arming");
            GameMainThread.Invoke(() => true);
            Expect(seat.Capture!.ArmCalls == 1 && seat.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:2340x1080",
                "the renderer message's aspect reaches the main-thread controller");
            seat.Armed(RenderStreamSeatToken);
            using (var armed = await ReadRendererAsync(socket, "armed")) ExpectDescriptor(armed.RootElement, "armed", 2340);
            Expect(seat.StreamingDemand == 0, "arming does not flip the page's watch gate");

            foreach (var origin in new[] { AllowedPageOrigin, "http://localhost:13337" })
            {
                using var session = await seat.SessionAsync(origin, wantsStream: true);
                ExpectDescriptor(session.RootElement, $"an armed seat's session for {origin}", 2340);
            }
            foreach (var origin in new string?[] { "http://192.168.1.20:13337", "https://127.0.0.1:13338", null })
            {
                using var session = await seat.SessionAsync(origin, wantsStream: true);
                Expect(!session.RootElement.TryGetProperty("renderStream", out _), "the hub's origin gate still hides credentials");
                Expect(session.RootElement.GetProperty("rendererState").GetProperty("state").GetString() == "armed",
                    "headless sessions still report renderer state without an allowed Origin");
            }
            await SendControlAsync(socket, "{\"type\":\"session-refresh\"}");
            using (var refreshed = await ReadSessionAsync(socket)) ExpectDescriptor(refreshed.RootElement, "session-refresh", 2340);

            // Credentials belong only to pages that explicitly ask, even while the seat is already armed.
            using var second = await seat.ConnectAsync(AllowedPageOrigin);
            using (var current = await ReadSessionAsync(second)) ExpectRenderer(current.RootElement, "armed");
            await SendRendererAsync(second, "stream");
            using (var current = await ReadRendererAsync(second, "armed")) ExpectDescriptor(current.RootElement, "shared arm", 2340);
            Expect(seat.Capture.ArmCalls == 1, "a second page shares this arm without rearming");
            await SendRendererAsync(second, "mirror");
            using (var current = await ReadRendererAsync(second, "armed")) ExpectRenderer(current.RootElement, "armed");
            Expect(seat.Capture.DisarmCalls == 0, "one page's mirror choice keeps the other page streaming");
            await SendControlAsync(socket, "{\"type\":\"session-refresh\"}");
            using (var current = await ReadSessionAsync(socket)) ExpectDescriptor(current.RootElement, "remaining wanting page", 2340);
            await SendRendererAsync(second, "stream");
            using (var current = await ReadRendererAsync(second, "armed")) ExpectDescriptor(current.RootElement, "asking again", 2340);
            seat.DemandHost!.Released = new(TaskCreationOptions.RunContinuationsAsynchronously);
            await CloseWebSocketSilentlyAsync(socket);
            await seat.DemandHost.Released.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Expect(seat.Capture.DisarmCalls == 0, "closing a wanting page does not disarm");
            await SendRendererAsync(second, "mirror");
            using (var mirror = await ReadRendererAsync(second, "mirror")) ExpectRenderer(mirror.RootElement, "mirror");
            GameMainThread.Invoke(() => true);
            Expect(seat.Capture.DisarmCalls == 1, "socket close released the first page's demand");
            seat.Disarmed();
            // Malformed renderer/aspect values cannot turn into an accidental mirror request or fail the socket.
            foreach (var invalid in new[] { "null", "7", "{}", "\"STREAM\"", "\"other\"" })
                await SendControlAsync(second, "{\"type\":\"renderer\",\"renderer\":" + invalid + "}");
            await SendRendererAsync(second, "stream", "\"wide\"");
            using (var arming = await ReadRendererAsync(second, "arming")) ExpectRenderer(arming.RootElement, "arming");
            GameMainThread.Invoke(() => true);
            Expect(seat.Capture.ArmCalls == 2 && seat.Capture.Options!["GRC_ROOT_SIZE"] == "presentation:1920x1080",
                "an invalid aspect uses the base size");
            var nextToken = new string('8', 64);
            seat.Armed(nextToken, width: 1920, hash: new string('d', 64));
            using (var rearmed = await ReadRendererAsync(second, "armed"))
            {
                var descriptor = rearmed.RootElement.GetProperty("renderStream");
                Expect(descriptor.GetProperty("token").GetString() == nextToken, "the next arm publishes its new token");
                Expect(descriptor.GetProperty("webTransport").GetProperty("certificateHashes")[0].GetString() == new string('d', 64),
                    "the next arm publishes its new certificate");
            }
            seat.FailStream("capture-ended");
            using (var failed = await ReadRendererAsync(second, "failed")) ExpectRenderer(failed.RootElement, "failed", "capture-ended");
            seat.Disarmed();
            await CloseWebSocketSilentlyAsync(second);
            Expect(seat.Capture.Subscriptions == 1, "signals are subscribed once across arms");
            await seat.StopServerAsync();
            Expect(seat.DemandHost!.Subscribers == 0, "the stopped generation unsubscribes from renderer changes");

            await using var hotSeat = await RelayedSeat.StartAsync(withCapture: true, hotGeneration: true);
            using var beforeReload = await hotSeat.ConnectAsync(AllowedPageOrigin);
            using (var initial = await ReadSessionAsync(beforeReload)) ExpectRenderer(initial.RootElement, "mirror");
            await SendRendererAsync(beforeReload, "stream");
            using (var arming = await ReadRendererAsync(beforeReload, "arming")) ExpectRenderer(arming.RootElement, "arming");
            GameMainThread.Invoke(() => true);
            hotSeat.Armed(RenderStreamSeatToken, width: 1920);
            using (var armed = await ReadRendererAsync(beforeReload, "armed")) ExpectDescriptor(armed.RootElement, "hot generation");
            hotSeat.DemandHost!.Released = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var reload = hotSeat.ReloadAsync();
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
            {
                using var notice = JsonDocument.Parse(await ReadWsMessageAsync(beforeReload, deadline.Token));
                Expect(notice.RootElement.GetProperty("type").GetString() == "server-reload", "replacement closes the old socket");
            }
            await CloseWebSocketSilentlyAsync(beforeReload);
            await reload;
            await hotSeat.DemandHost.Released.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Expect(hotSeat.DemandHost.Subscribers == 0, "the old hot generation unsubscribes");
            using var afterReload = await hotSeat.ConnectAsync(AllowedPageOrigin);
            using (var current = await ReadSessionAsync(afterReload)) ExpectRenderer(current.RootElement, "armed");
            await SendRendererAsync(afterReload, "stream");
            using (var current = await ReadRendererAsync(afterReload, "armed")) ExpectDescriptor(current.RootElement, "replacement generation");
            Expect(hotSeat.DemandHost.Subscribers == 1, "the replacement hot generation subscribes once");
            await SendRendererAsync(afterReload, "mirror");
            using (var mirror = await ReadRendererAsync(afterReload, "mirror")) ExpectRenderer(mirror.RootElement, "mirror");
            GameMainThread.Invoke(() => true);
            Expect(hotSeat.Capture!.Subscriptions == 1 && hotSeat.Capture.ArmCalls == 1 && hotSeat.Capture.DisarmCalls == 1,
                "controller demand and subscriptions survive a real hot-generation replacement");
            hotSeat.Disarmed();
            await CloseWebSocketSilentlyAsync(afterReload);
            return 0;
        }
        catch (Exception error)
        {
            // The message names what failed; the assertions never put the token in it.
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void ExpectDescriptor(JsonElement session, string where, int width = 1920)
    {
        Expect(session.TryGetProperty("renderStream", out var rs), $"{where}: carries renderStream");
        Expect(rs.GetProperty("url").GetString() == "ws://127.0.0.1:13366/render-stream", $"{where}: hub url");
        Expect(rs.GetProperty("resourceBase").GetString() == "http://127.0.0.1:13366", $"{where}: resource base");
        Expect(rs.GetProperty("token").GetString() == RenderStreamSeatToken, $"{where}: the capture's token");
        Expect(rs.GetProperty("protocol").GetInt32() == 13, $"{where}: /13");
        Expect(rs.GetProperty("webTransport").GetProperty("certificateHashes")[0].GetString() == new string('c', 64),
            $"{where}: this arm's certificate");
        Expect(session.GetProperty("rendererState").GetProperty("state").GetString() == "armed", $"{where}: armed state");
        Expect(rs.GetProperty("presentation").EnumerateArray().Select(e => e.GetInt32()).SequenceEqual([width, 1080]),
            $"{where}: this arm's presentation");
    }

    private static void ExpectRenderer(JsonElement session, string state, string? reason = null)
    {
        var renderer = session.GetProperty("rendererState");
        Expect(renderer.GetProperty("state").GetString() == state, $"renderer state is {state}");
        if (reason is null) Expect(!renderer.TryGetProperty("reason", out _), "absent renderer reason is omitted");
        else Expect(renderer.GetProperty("reason").GetString() == reason, "renderer failure reason");
        Expect(!session.TryGetProperty("renderStream", out _), "no descriptor before armed or after disarm");
    }

    private static Task SendControlAsync(ClientWebSocket socket, string json)
        => socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None);

    private static Task SendRendererAsync(ClientWebSocket socket, string renderer, string? aspect = null)
        => SendControlAsync(socket, "{\"type\":\"renderer\",\"renderer\":\"" + renderer + "\""
            + (aspect is null ? "" : ",\"aspect\":" + aspect) + "}");

    private static async Task<JsonDocument> ReadRendererAsync(ClientWebSocket socket, string state)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (true)
        {
            var document = JsonDocument.Parse(await ReadWsMessageAsync(socket, deadline.Token));
            if (document.RootElement.TryGetProperty("rendererState", out var renderer)
                && renderer.GetProperty("state").GetString() == state) return document;
            document.Dispose();
        }
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
        private readonly IGameMainThread _previousThread;
        private readonly CouchCoopBrowserServer _server;
        private readonly SeatBrowserPipe _pipe;
        private readonly TcpListener _host;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _relay;
        internal HotReloadableBrowserServerHost? Host;
        internal TrackingRendererHost? DemandHost;
        internal RenderStreamSwapTests.FakeCapture? Capture;
        internal int StreamingDemand;
        private ICouchCoopHotGeneration? _hotGeneration;

        private ICouchCoopHotGeneration CreateHotGeneration()
        {
            var path = Path.Combine(AppContext.BaseDirectory, "CouchCoop.Mod.HotReload.dll");
            var logic = Assembly.LoadFrom(path).GetType("CouchCoop.Mod.HotReload.CouchCoopHotLogic", throwOnError: true)!;
            Expect(logic.Assembly != typeof(CouchCoopBrowserServer).Assembly, "the route uses the separately compiled server generation");
            return (ICouchCoopHotGeneration)logic.GetMethod("CreateGeneration")!.Invoke(null,
                [DemandHost!, new HotReloadActivationContext(1, _root.Path, path)])!;
        }

        internal async Task ReloadAsync()
        {
            await _hotGeneration!.StopAsync(new("server-reload", 2), CancellationToken.None);
            await _hotGeneration.DisposeAsync();
            _hotGeneration = CreateHotGeneration();
        }

        private Task ServeSeatAsync(Stream stream, bool secure, IPAddress address, CancellationToken cancellation)
            => _hotGeneration is ICouchCoopAddressedStreamGeneration addressed
                ? addressed.ServeAsync(stream, secure, address, cancellation)
                : _server.ServeAsync(stream, secure, address, cancellation);

        internal void Armed(string token, int width = 2340, string? hash = null)
            => GameMainThread.Invoke(() => { Capture!.EmitArmed(new("127.0.0.1:13366", token, hash ?? new string('c', 64),
                $"{width}x1080", 13)); return true; });
        internal void Disarmed() => GameMainThread.Invoke(() => { Capture!.EmitDisarmed(); return true; });
        internal void FailStream(string reason) => GameMainThread.Invoke(() => { Capture!.EmitStreamEnded(reason); return true; });
        internal Task StopServerAsync() => _server.StopGenerationAsync();

        private RelayedSeat(TempStaticRoot root, HopCountingMainThread mainThread, IGameMainThread previousThread,
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

        public static async Task<RelayedSeat> StartAsync(bool withCapture = false, bool hotGeneration = false)
        {
            var root = new TempStaticRoot();
            var previous = GameMainThread.Source;
            var mainThread = new HopCountingMainThread();
            GameMainThread.Source = mainThread;
            var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.MultiplayerRun };
            HotReloadableBrowserServerHost? host = null;
            RenderStreamSwapTests.FakeCapture? capture = null;
            if (withCapture)
            {
                capture = new([]);
                capture.BeforeArm = () => Expect(Thread.CurrentThread.Name == "test-game-main", "Arm runs on the game main thread");
                capture.BeforeDisarm = () => Expect(Thread.CurrentThread.Name == "test-game-main", "Disarm runs on the game main thread");
                var injectedCapture = capture;
                host = new(runtime.NewEnvelopeFactory().RuntimeHost, root.Path);
                host.CreateRendererSwap = changed => new RenderStreamSwap(injectedCapture,
                    (_, _) => new NoopCancellation(), _ => { }, () => { }, changed, _ => { });
            }
            var demandHost = host is null ? null : new TrackingRendererHost(host);
            RelayedSeat? seat = null;
            var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path), new CapturingAssetAdapter(),
                runtime.NewEnvelopeFactory(), preferredPort: 0, isHeadlessClient: true,
                hostBrowserAccess: new TestHostBrowserAccess(), rendererSwapHost: demandHost,
                onSceneStreamingDemandChanged: (count, _) => { if (seat is not null) seat.StreamingDemand = count; });
            await server.StartAsync();
            var pipeName = SeatBrowserPipe.EndpointFor("CouchRsTest" + Guid.NewGuid().ToString("N"));
            var pipeToken = new string('c', 64);
            var pipe = SeatBrowserPipe.Start(pipeName, pipeToken,
                (stream, secure, address, cancellation) => seat!.ServeSeatAsync(stream, secure, address, cancellation));
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            seat = new RelayedSeat(root, mainThread, previous, server, pipe, listener, pipeName, pipeToken)
            { Host = host, Capture = capture, DemandHost = demandHost };
            if (hotGeneration) seat._hotGeneration = seat.CreateHotGeneration();
            return seat;
        }

        public async Task<ClientWebSocket> ConnectAsync(string? origin)
        {
            var socket = new ClientWebSocket();
            if (origin is not null) socket.Options.SetRequestHeader("Origin", origin);
            var port = ((IPEndPoint)_host.LocalEndpoint).Port;
            await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/ws?seat=rs&{GatedQuery}"), CancellationToken.None);
            return socket;
        }

        public async Task<JsonDocument> SessionAsync(string? origin, bool wantsStream = false)
        {
            using var socket = await ConnectAsync(origin);
            var session = await ReadSessionAsync(socket);
            if (wantsStream)
            {
                session.Dispose();
                await SendRendererAsync(socket, "stream");
                session = await ReadRendererAsync(socket, "armed");
            }
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
            if (_hotGeneration is not null)
            {
                await _hotGeneration.StopAsync(new("test-dispose", 0), CancellationToken.None);
                await _hotGeneration.DisposeAsync();
            }
            if (Host is not null) await Host.DisposeAsync();
            GameMainThread.Source = _previousThread;
            _mainThread.Dispose();
            _root.Dispose();
            _stop.Dispose();
        }
    }

    private sealed class TrackingRendererHost(HotReloadableBrowserServerHost host) : IHotRendererSwapHost, IHotServerHost, IHotBrowserDemandHost
    {
        public object RuntimeHost => host.RuntimeHost;
        public object? HeadlessManager => host.HeadlessManager;
        public string StaticRoot => host.StaticRoot;
        public string? ResourceCacheRoot => host.ResourceCacheRoot;
        public bool IsHeadlessClient => host.IsHeadlessClient;
        public void Log(string message) => host.Log(message);
        public Action<int, long> CreateBrowserDemandReporter() => host.CreateBrowserDemandReporter();
        internal int Subscribers;
        internal TaskCompletionSource Released = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public (string State, string? Reason,
            (string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)? Snapshot) RendererStatus
            => host.RendererStatus;
        public bool WantsRenderStream(string pageId) => host.WantsRenderStream(pageId);
        public void RequestRenderer(string pageId, bool wantsStream, double? aspect) => host.RequestRenderer(pageId, wantsStream, aspect);
        public void ReleaseRenderer(string pageId)
        {
            host.ReleaseRenderer(pageId);
            Released.TrySetResult();
        }
        public IDisposable SubscribeRendererChanged(Action handler)
        {
            Interlocked.Increment(ref Subscribers);
            var subscription = host.SubscribeRendererChanged(handler);
            return new CallbackCancellation(() => { subscription.Dispose(); Interlocked.Decrement(ref Subscribers); });
        }
    }

    private sealed class CallbackCancellation(Action callback) : IDisposable
    {
        public void Dispose() => callback();
    }

    private sealed class NoopCancellation : IDisposable
    {
        public void Dispose() { }
    }
}
