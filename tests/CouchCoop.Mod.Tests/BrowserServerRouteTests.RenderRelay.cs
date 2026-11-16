using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Reflection;
using System.Text;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Tests;

internal sealed partial class BrowserServerRouteTests
{
    private static int _relayAssertions;

    private static void RelayExpect(bool condition, string label)
    {
        Expect(condition, label);
        _relayAssertions++;
    }

    internal static async Task RunRenderRelayRoutesAsync()
    {
        _relayAssertions = 0;
        var oldOrigins = Environment.GetEnvironmentVariable("GRC_LIVE_ALLOWED_ORIGINS");
        var oldCheck = Environment.GetEnvironmentVariable(CouchCoopWebOrigin.OriginCheckEnvironmentVariable);
        Environment.SetEnvironmentVariable("GRC_LIVE_ALLOWED_ORIGINS", "http://127.0.0.1:13337");
        Environment.SetEnvironmentVariable(CouchCoopWebOrigin.OriginCheckEnvironmentVariable, null);
        try
        {
            await CouchCoopGameFactsTests.WithSourceAsync(new CouchCoopGameFactsTests.FakeFacts(), async () =>
            {
                await using var fixture = await RenderRelayFixture.StartAsync();
                var route = fixture.Host.RenderStreamSeatRoute;
                var resource = $"/render-stream/{route}/resources/sha256/{new string('a', 64)}";
                var body = new byte[] { 0x28, 0xb5, 0x2f, 0xfd, 0, 255, 128, 1 };
                fixture.Response = "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Type: application/octet-stream\r\nContent-Encoding: zstd\r\nETag: \"abc\"\r\nCache-Control: public, max-age=86400\r\nVary: Accept-Encoding\r\nAccess-Control-Allow-Origin: http://127.0.0.1:13337\r\nAccess-Control-Allow-Credentials: true\r\n\r\n";
                fixture.Body = body;
                var response = await fixture.GetAsync(resource);
                var text = Encoding.Latin1.GetString(response);
                RelayExpect(response.AsSpan(response.Length - body.Length).SequenceEqual(body), "compressed bytes stream unchanged through the pipe");
                RelayExpect(text.Contains("Content-Encoding: zstd") && text.Contains("ETag: \"abc\"") && text.Contains("Cache-Control: public"), "encoding and cache validators survive");
                RelayExpect(text.Contains("Access-Control-Allow-Origin: " + CouchCoopWebOrigin.DefaultOrigin + "\r\n")
                    && !text.Contains("Access-Control-Allow-Credentials") && text.Contains("Vary: Accept-Encoding, Origin"), "CORS reflects the original validated public origin once");
                RelayExpect(fixture.LastRequest!.Path == "/resources/sha256/" + new string('a', 64)
                    && fixture.LastRequest.Header("Origin") == "http://127.0.0.1:13337"
                    && fixture.LastRequest.Header("Connection") == "close"
                    && fixture.LastRequest.Header("Authorization") == "Bearer test-token", "private forwarding fixes target, origin and connection while preserving authorization");

                fixture.Response = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Encoding: gzip\r\n\r\n";
                fixture.Body = "3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"u8.ToArray();
                response = await fixture.GetAsync(resource);
                RelayExpect(Encoding.ASCII.GetString(response).EndsWith("3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"), "chunked resource streams without decompression");
                fixture.Response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nAccess-Control-Allow-Headers: authorization\r\n\r\n";
                fixture.Body = [];
                text = Encoding.ASCII.GetString(await fixture.GetAsync(resource, "OPTIONS"));
                RelayExpect(text.StartsWith("HTTP/1.1 204") && text.Contains("Access-Control-Allow-Headers: authorization,")
                    && fixture.LastRequest!.Method == "OPTIONS", "authorization preflight traverses the authenticated pipe");
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource, "HEAD")).StartsWith("HTTP/1.1 405"), "HEAD is refused before the hub");
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource, origin: "https://foreign.invalid")).StartsWith("HTTP/1.1 403"), "foreign origin is refused before rewriting");
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource.Replace(route!, new string('b', 32)))).StartsWith("HTTP/1.1 410"), "the host refuses an unknown seat route");
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource.Replace(route!, new string('b', 32)), directSeat: true)).StartsWith("HTTP/1.1 410"), "the seat independently validates its own launched route");
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource + "?upstream=http://elsewhere")).StartsWith("HTTP/1.1 410"), "query selectors cannot choose an upstream");
                fixture.Host.ListenOverride = "192.0.2.1:80";
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource)).StartsWith("HTTP/1.1 502"), "a non-loopback upstream is refused before connecting");
                fixture.Host.ListenOverride = null;
                fixture.Host.State = "arming";
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource)).StartsWith("HTTP/1.1 410"), "unarmed resources are refused");
                fixture.Host.State = "armed";
                fixture.Response = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 3\r\nCache-Control: public, max-age=999\r\nWWW-Authenticate: Bearer\r\n\r\n";
                fixture.Body = "bad"u8.ToArray();
                text = Encoding.ASCII.GetString(await fixture.GetAsync($"/render-stream/{route}/ws", upgrade: true));
                RelayExpect(text.StartsWith("HTTP/1.1 401") && text.Contains("Cache-Control: no-store") && text.EndsWith("bad")
                    && text.Contains("WWW-Authenticate: Bearer"), "valid WebSocket refusal preserves status and body without caching");
                fixture.Response = "not-http\r\n\r\n";
                fixture.Body = [];
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource)).StartsWith("HTTP/1.1 502"), "malformed upstream response becomes 502");
                fixture.Response = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: invalid\r\n\r\n";
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync($"/render-stream/{route}/ws", upgrade: true)).StartsWith("HTTP/1.1 502"), "malformed upgrade becomes 502");
                fixture.Response = "HTTP/1.1 302 Found\r\nLocation: http://elsewhere.invalid/\r\nContent-Length: 0\r\n\r\n";
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource)).StartsWith("HTTP/1.1 302"), "redirect is forwarded without following it");
                fixture.OnRequest = () => fixture.Host.Token = new string('e', 64);
                fixture.Response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource)).StartsWith("HTTP/1.1 502"), "arm replacement fences a pending response");
                fixture.OnRequest = null;
                RelayExpect(fixture.SeatAlive, "render refusals and upstream failures never retire the managed seat");
                await fixture.AssertWebSocketAsync();
                await AssertRenderRelayDeadlineAndEofAsync();
                await AssertRendererNegotiationAsync(fixture);
                await AssertHostRelayOfferAsync(fixture.Host);
                fixture.ExitSeat();
                RelayExpect(Encoding.ASCII.GetString(await fixture.GetAsync(resource)).StartsWith("HTTP/1.1 410"), "an exited seat's public route is unavailable");
                Console.WriteLine($"render-stream relay: {_relayAssertions} assertions passed.");
            });
        }
        finally
        {
            Environment.SetEnvironmentVariable("GRC_LIVE_ALLOWED_ORIGINS", oldOrigins);
            Environment.SetEnvironmentVariable(CouchCoopWebOrigin.OriginCheckEnvironmentVariable, oldCheck);
        }
    }

    private static async Task AssertHostRelayOfferAsync(RelayRendererHost relay)
    {
        using var root = new TempStaticRoot();
        var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.MultiplayerRun };
        using var manager = new HeadlessClientManager(_ => null, registerProcessExit: false,
            streamingConfig: new StreamingSeatLaunch.Config("/capture/renderer.gdextension", "/capture/calibration.json"));
        manager.StreamingSeatLanContext = () => new StreamingSeatLan.Context([], null, null, null);
        await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path), new CapturingAssetAdapter(),
            runtime.NewEnvelopeFactory(), preferredPort: 0, isHeadlessClient: false, headlessManager: manager, rendererSwapHost: relay);
        await server.StartAsync();
        foreach (var supported in new[] { true, false })
        {
            relay.SupportsRelay = supported;
            using var socket = new ClientWebSocket();
            socket.Options.SetRequestHeader("Origin", CouchCoopWebOrigin.DefaultOrigin);
            await socket.ConnectAsync(new UriBuilder(new Uri(server.BaseUri!, "/ws?" + GatedQuery)) { Scheme = "ws" }.Uri, CancellationToken.None);
            using var session = await ReadSessionAsync(socket);
            var offer = session.RootElement.GetProperty("renderStreamLan");
            RelayExpect(supported ? offer.GetProperty("relay").GetBoolean() : !offer.TryGetProperty("relay", out _),
                "host offer reflects the installed optional relay capability");
            RelayExpect(!session.RootElement.TryGetProperty("renderStream", out _), "host offers never include seat credentials");
            await CloseWebSocketSilentlyAsync(socket);
        }
        relay.SupportsRelay = true;
    }

    private static async Task AssertRendererNegotiationAsync(RenderRelayFixture fixture)
    {
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Origin", CouchCoopWebOrigin.DefaultOrigin);
        await socket.ConnectAsync(new UriBuilder(new Uri(fixture.Server.BaseUri!, "/ws?" + GatedQuery)) { Scheme = "ws" }.Uri, CancellationToken.None);
        using (var initial = await ReadSessionAsync(socket)) RelayExpect(!initial.RootElement.TryGetProperty("renderStream", out _), "coordination has no credentials");
        await SendControlAsync(socket, "{\"type\":\"renderer\",\"renderer\":\"stream\"}");
        using (var legacy = await ReadSessionAsync(socket)) ExpectRenderer(legacy.RootElement, "failed", "renderer-update-required");
        RelayExpect(fixture.Host.Requests == 1 && !fixture.Host.Wants, "legacy stream never adds capture demand");
        await SendRendererAsync(socket, "stream");
        using var session = await ReadRendererAsync(socket, "armed");
        var descriptor = session.RootElement.GetProperty("renderStream");
        RelayExpect(descriptor.GetProperty("url").GetString() == $"/render-stream/{fixture.Host.RenderStreamSeatRoute}/ws"
            && descriptor.GetProperty("resourceBase").GetString() == $"/render-stream/{fixture.Host.RenderStreamSeatRoute}"
            && !descriptor.TryGetProperty("webTransport", out _), "negotiated seat descriptor is relative and WebSocket only");
        await CloseWebSocketSilentlyAsync(socket);
    }

    private static async Task AssertRenderRelayDeadlineAndEofAsync()
    {
        using var upstreamListener = new TcpListener(IPAddress.Loopback, 0);
        using var browserListener = new TcpListener(IPAddress.Loopback, 0);
        upstreamListener.Start(); browserListener.Start();
        using var upstreamPeer = new TcpClient();
        using var browserPeer = new TcpClient();
        await upstreamPeer.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)upstreamListener.LocalEndpoint).Port);
        await browserPeer.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)browserListener.LocalEndpoint).Port);
        using var upstream = await upstreamListener.AcceptTcpClientAsync();
        using var browser = await browserListener.AcceptTcpClientAsync();
        var raw = Encoding.ASCII.GetBytes("GET /render-stream HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
        using var input = new MemoryStream(raw);
        var request = (await CouchCoopHttpRequest.TryReadAsync(input))!;
        var relay = RenderStreamRelay.ForwardAsync(upstream.GetStream(), browser.GetStream(), request, raw, CancellationToken.None,
            responseTimeout: TimeSpan.FromMilliseconds(80));
        var buffer = new byte[1024];
        var read = await browserPeer.GetStream().ReadAsync(buffer).AsTask().WaitAsync(TimeSpan.FromSeconds(3));
        RelayExpect(Encoding.ASCII.GetString(buffer, 0, read).StartsWith("HTTP/1.1 504"), "upstream handshake timeout is bounded 504");
        await relay.WaitAsync(TimeSpan.FromSeconds(3));
        relay = RenderStreamRelay.ForwardAsync(upstream.GetStream(), browser.GetStream(), request, raw, CancellationToken.None);
        browserPeer.Dispose();
        await relay.WaitAsync(TimeSpan.FromSeconds(3));
    }

    private sealed class RelayRendererHost : IHotRendererSwapHost, IHotRenderStreamRelayHost
    {
        internal int Port;
        internal string? ListenOverride;
        internal string Token = new('d', 64);
        internal string State = "armed";
        internal bool Wants;
        internal int Requests;
        private event Action? Changed;
        internal bool SupportsRelay = true;
        public bool SupportsRenderStreamRelay => SupportsRelay;
        public string? RenderStreamSeatRoute { get; internal set; } = new string('c', 32);
        public (string State, string? Reason, (string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)? Snapshot) RendererStatus
            => (State, null, (ListenOverride ?? $"127.0.0.1:{Port}", Token, "", "1920x1080", 13));
        public bool WantsRenderStream(string pageId) => Wants;
        public void RequestRenderer(string pageId, bool wantsStream, double? aspect) { Requests++; Wants = wantsStream; Changed?.Invoke(); }
        public void ReleaseRenderer(string pageId) => Wants = false;
        public IDisposable SubscribeRendererChanged(Action handler) { Changed += handler; return new CallbackCancellation(() => Changed -= handler); }
    }

    private sealed class RenderRelayFixture : IAsyncDisposable
    {
        internal readonly RelayRendererHost Host = new();
        internal CouchCoopBrowserServer Server = null!;
        internal CouchCoopHttpRequest? LastRequest;
        internal string Response = "";
        internal byte[] Body = [];
        internal Action? OnRequest;
        internal bool SeatAlive => !_process.HasExited;
        internal void ExitSeat() => _process.Exit();
        private readonly TempStaticRoot _root = new();
        private readonly TcpListener _hub = new(IPAddress.Loopback, 0);
        private CouchCoopBrowserServer _public = null!;
        private HeadlessClientManager _manager = null!;
        private readonly HeadlessConnectionLifecycleTests.FakeProcess _process = new(40002);
        private Task<int?> _joining = null!;
        private readonly Guid _sessionId = Guid.NewGuid();
        private SeatBrowserPipe _pipe = null!;
        private readonly CancellationTokenSource _stop = new();
        private Task _acceptHub = Task.CompletedTask;

        internal static async Task<RenderRelayFixture> StartAsync()
        {
            var f = new RenderRelayFixture();
            f._hub.Start();
            f.Host.Port = ((IPEndPoint)f._hub.LocalEndpoint).Port;
            var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.MultiplayerRun };
            f.Server = new(new StaticSpaFileProvider(f._root.Path), new CapturingAssetAdapter(), runtime.NewEnvelopeFactory(),
                preferredPort: 0, isHeadlessClient: true, rendererSwapHost: f.Host);
            await f.Server.StartAsync();
            Dictionary<string, string?>? environment = null;
            f._manager = new HeadlessClientManager(slot =>
            {
                var start = new ProcessStartInfo();
                typeof(HeadlessClientManager).GetMethod("ApplyConnectionEnvironmentLocked", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .Invoke(f._manager, [slot, start]);
                environment = new(start.Environment);
                return f._process;
            }, (_, _) => Task.FromResult(true), sharedRelay: true, registerProcessExit: false);
            f._manager.ConfigureConnectionMonitoring(_ => false, () => 12345);
            f._joining = f._manager.EnsureHeadlessAsync(f._sessionId, "relay", f._stop.Token);
            await HeadlessConnectionLifecycleTests.WaitForControlAsync(f._sessionId);
            f.Host.RenderStreamSeatRoute = environment![SeatBrowserPipe.RouteEnvironmentVariable];
            RelayExpect(StreamingSeatDescriptor.IsSeatRoute(f.Host.RenderStreamSeatRoute), "launch carries its owned route identity");
            RelayExpect(f._manager.TryResolveSeatRelay(f.Host.RenderStreamSeatRoute!, out var name, out var credential)
                && name == environment[SeatBrowserPipe.NameEnvironmentVariable]
                && credential == environment[SeatBrowserPipe.TokenEnvironmentVariable], "host resolves only its launch's authenticated pipe");
            f._pipe = SeatBrowserPipe.Start(name, credential, f.Server.ServeAsync);
            f._public = new(new StaticSpaFileProvider(f._root.Path), new CapturingAssetAdapter(), runtime.NewEnvelopeFactory(),
                preferredPort: 0, isHeadlessClient: false, headlessManager: f._manager);
            await f._public.StartAsync();
            f._acceptHub = f.AcceptHubAsync();
            return f;
        }

        private async Task AcceptHubAsync()
        {
            try
            {
                while (true)
                {
                    var peer = await _hub.AcceptTcpClientAsync(_stop.Token);
                    _ = ServeHubAsync(peer);
                }
            }
            catch (Exception) when (_stop.IsCancellationRequested) { }
        }

        private async Task ServeHubAsync(TcpClient peer)
        {
            using (peer)
            {
                var stream = peer.GetStream();
                LastRequest = await CouchCoopHttpRequest.TryReadAsync(stream, _stop.Token);
                OnRequest?.Invoke();
                if (LastRequest!.IsWebSocketUpgrade && Response == "websocket")
                {
                    var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(LastRequest.Header("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                    await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: render-stream.v13\r\n\r\n"));
                    using var ws = WebSocket.CreateFromStream(stream, true, "render-stream.v13", TimeSpan.FromSeconds(30));
                    var bytes = new byte[1024];
                    var read = await ws.ReceiveAsync(bytes.AsMemory(), _stop.Token);
                    await ws.SendAsync(bytes.AsMemory(0, read.Count), WebSocketMessageType.Binary, true, _stop.Token);
                }
                else
                {
                    foreach (var part in Response.Chunk(7)) await stream.WriteAsync(Encoding.ASCII.GetBytes(new string(part)), _stop.Token);
                    await stream.WriteAsync(Body, _stop.Token);
                }
            }
        }

        internal async Task<byte[]> GetAsync(string path, string method = "GET", string? origin = null, bool upgrade = false, bool directSeat = false)
        {
            using var peer = new TcpClient();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await peer.ConnectAsync(IPAddress.Loopback, (directSeat ? Server : _public).BaseUri!.Port, deadline.Token);
            var request = $"{method} {path} HTTP/1.1\r\nHost: relay.test:13337\r\nOrigin: {origin ?? CouchCoopWebOrigin.DefaultOrigin}\r\nAuthorization: Bearer test-token\r\n"
                + (upgrade ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" : "Connection: close\r\n") + "\r\n";
            await peer.GetStream().WriteAsync(Encoding.ASCII.GetBytes(request), deadline.Token);
            using var output = new MemoryStream();
            await peer.GetStream().CopyToAsync(output, deadline.Token);
            return output.ToArray();
        }

        internal async Task AssertWebSocketAsync()
        {
            Response = "websocket";
            using var ws = new ClientWebSocket();
            ws.Options.SetRequestHeader("Origin", CouchCoopWebOrigin.DefaultOrigin);
            ws.Options.AddSubProtocol("render-stream.v13");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{_public.BaseUri!.Port}/render-stream/{Host.RenderStreamSeatRoute}/ws"), deadline.Token);
            RelayExpect(ws.SubProtocol == "render-stream.v13", "subprotocol survives both hops");
            await ws.SendAsync(new byte[] { 1, 255, 2 }, WebSocketMessageType.Binary, true, deadline.Token);
            var buffer = new byte[16];
            var read = await ws.ReceiveAsync(buffer.AsMemory(), deadline.Token);
            RelayExpect(buffer.AsSpan(0, read.Count).SequenceEqual(new byte[] { 1, 255, 2 }), "WebSocket bytes survive both hops");
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel(); _hub.Stop();
            try { await _joining; } catch (OperationCanceledException) { }
            await _acceptHub;
            await _public.DisposeAsync();
            _manager.Dispose();
            HeadlessConnectionLifecycleTests.CleanupControl(_sessionId);
            await _pipe.DisposeAsync(); await Server.DisposeAsync();
            _root.Dispose(); _stop.Dispose();
        }
    }
}
