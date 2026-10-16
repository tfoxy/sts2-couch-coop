using System.Net;
using System.Net.Sockets;
using System.Text;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

// WS6 follow-up: a JOINED seat over the secure origin.
//
// The bug this closes: a joined mirror seat is redirected to its OWN headless instance BY PORT, and the
// client builds that redirect from the PAGE's scheme. On an https page that yields `wss://host:<port>` — so
// sending the headless instance's plain-HTTP port produces a socket the browser blocks or hangs on, and the
// secure viewer can watch but never take a seat. The host therefore has to learn the headless instance's
// real TLS port and send THAT.
//
// It cannot derive it: each instance is a separate process that port-walks its own listeners. So the
// instance publishes it on /secure-port and the host asks. These tests drive that handshake over real
// loopback sockets, plus the fail-closed behaviour when no secure port exists.
internal static class SecureHeadlessRedirectTests
{
    public static void RunAsync() => RunAsyncCore().GetAwaiter().GetResult();

    private static async Task RunAsyncCore()
    {
        OnlySecureDirectSeatRedirectsRequestTls();
        await DirectIpSetupWaitsForSpecificIdentity();
        await DirectIpRefreshIsBoundToHostIdentity();
        await SecureSetupRouteIsLoopbackAndHeadlessOnly();
        await RouteReportsZeroWhenThereIsNoSecureListener();
        await RouteReportsThePublishedPort();
        await HostResolvesAHeadlessSecurePortOverLoopback();
        await ResolveGivesUpWhenTheInstanceNeverPublishes();
        await ResolveGivesUpOnADeadPort();
        CacheRootIsHandedToSeatsRatherThanRediscovered();

        Console.WriteLine("SecureHeadlessRedirectTests: ok");
    }

    private static void OnlySecureDirectSeatRedirectsRequestTls()
    {
        Expect(!CouchCoopWebSocketConnection.ShouldRequestSecureOriginForSeat(
                isSecure: false, headlessPath: null, headlessPort: 13357, joinRejection: null),
            "a plain HTTP seat join does not request TLS setup");
        Expect(CouchCoopWebSocketConnection.ShouldRequestSecureOriginForSeat(
                isSecure: true, headlessPath: null, headlessPort: 13357, joinRejection: null),
            "an HTTPS direct-seat redirect requests TLS setup");
        Expect(!CouchCoopWebSocketConnection.ShouldRequestSecureOriginForSeat(
                isSecure: true, headlessPath: "pipe://seat", headlessPort: null, joinRejection: null),
            "a shared seat path already inherits the host's secure connection");
        Expect(!CouchCoopWebSocketConnection.ShouldRequestSecureOriginForSeat(
                isSecure: true, headlessPath: null, headlessPort: 13357, joinRejection: "spawn-failed"),
            "a rejected seat spawn does not request TLS setup");
    }

    private static async Task SecureSetupRouteIsLoopbackAndHeadlessOnly()
    {
        var requested = 0;
        await using (var seat = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(Path.Combine(Path.GetTempPath(), "couchcoop-missing-static")),
            new NullAssetHttpAdapter(),
            bindAddress: IPAddress.Loopback,
            preferredPort: PickFreePort(),
            isHeadlessClient: true,
            requestSecureOrigin: () => Interlocked.Increment(ref requested),
            log: _ => { }))
        {
            var baseUri = await seat.StartAsync();
            var accepted = await HeadlessClientManager.RequestSecureOriginAsync(baseUri.Port, CancellationToken.None);
            Expect(accepted && requested == 1,
                "a loopback POST asks a headless seat to prepare TLS");

            using var http = new HttpClient();
            using var get = await http.GetAsync(
                $"http://127.0.0.1:{baseUri.Port}{SecureOriginEndpoint.EnableRoute}");
            Expect(get.StatusCode == System.Net.HttpStatusCode.NotFound && requested == 1,
                "the setup route does not accept GET or repeat its action");
        }

        await using var host = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(Path.Combine(Path.GetTempPath(), "couchcoop-missing-static")),
            new NullAssetHttpAdapter(),
            bindAddress: IPAddress.Loopback,
            preferredPort: PickFreePort(),
            isHeadlessClient: false,
            requestSecureOrigin: () => Interlocked.Increment(ref requested),
            log: _ => { });
        var hostUri = await host.StartAsync();
        Expect(!await HeadlessClientManager.RequestSecureOriginAsync(hostUri.Port, CancellationToken.None)
            && requested == 1,
            "a non-seat browser server does not expose the seat-only setup action");
    }

    private static async Task DirectIpSetupWaitsForSpecificIdentity()
    {
        var request = new DirectIpSeatPreparation(new string('A', 64), "192.168.1.5", new string('B', 64));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var requests = 0;
        await using var seat = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(Path.Combine(Path.GetTempPath(), "couchcoop-missing-static")),
            new NullAssetHttpAdapter(), bindAddress: IPAddress.Loopback, preferredPort: PickFreePort(),
            isHeadlessClient: true, log: _ => { });
        var baseUri = await seat.StartAsync();
        seat.EnableDirectIpSeatAsync = async (preparation, token) =>
        {
            Expect(preparation == request, "seat receives exact bundle, IP and authority identity");
            Interlocked.Increment(ref requests);
            entered.TrySetResult();
            await release.Task.WaitAsync(token);
            return baseUri.Port;
        };
        var pending = HeadlessClientManager.RequestDirectIpOriginAsync(baseUri.Port, request, CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Expect(!pending.IsCompleted && requests == 1, "host awaits a single readiness request without polling");
        release.TrySetResult();
        Expect(await pending == baseUri.Port && requests == 1, "prepared IP identity returns actual seat port");
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
        var url = $"http://127.0.0.1:{baseUri.Port}{SecureOriginEndpoint.EnableDirectIpRoute}?bundle={request.BundleId}&address={request.Address}&ca={request.CaFingerprint}&hostPort=0";
        using var get = await http.GetAsync(url);
        Expect(get.StatusCode == HttpStatusCode.NotFound, "GET cannot prepare an identity");
        using (var remote = new MemoryStream())
        {
            var requestBytes = Encoding.ASCII.GetBytes($"POST {new Uri(url).PathAndQuery} HTTP/1.1\r\nHost: 192.168.1.5\r\nContent-Length: 0\r\n\r\n");
            remote.Write(requestBytes);
            remote.Position = 0;
            await seat.ServeAsync(remote, false, IPAddress.Parse("192.168.1.20"), CancellationToken.None);
            Expect(Encoding.UTF8.GetString(remote.ToArray()).Contains("HTTP/1.1 404 ", StringComparison.Ordinal)
                && requests == 1, "LAN callers cannot activate a seat certificate");
        }
        using var forged = new HttpRequestMessage(HttpMethod.Post, url);
        forged.Headers.Add("Origin", "https://unrelated.example");
        using var forgedResult = await http.SendAsync(forged);
        Expect(forgedResult.StatusCode == HttpStatusCode.NotFound && requests == 1, "browser-origin POST cannot prepare an identity");
        Expect(await HeadlessClientManager.RequestDirectIpOriginAsync(baseUri.Port,
            request with { BundleId = "../../authority" }, CancellationToken.None) is null && requests == 1,
            "filesystem paths cannot be passed as opaque bundles");
        seat.EnableDirectIpSeatAsync = (_, _) => Task.FromResult<int?>(baseUri.Port + 1);
        Expect(await HeadlessClientManager.RequestDirectIpOriginAsync(baseUri.Port, request, CancellationToken.None) is null,
            "readiness cannot redirect to an unrelated port");
        seat.EnableDirectIpSeatAsync = (_, _) => Task.FromResult<int?>(null);
        Expect(await HeadlessClientManager.RequestDirectIpOriginAsync(baseUri.Port, request, CancellationToken.None) is null,
            "missing leaf material fails closed without HTTP fallback");
        using var cancel = new CancellationTokenSource(); cancel.Cancel();
        try
        {
            await HeadlessClientManager.RequestDirectIpOriginAsync(baseUri.Port, request, cancel.Token);
            throw new InvalidOperationException("cancelled preparation unexpectedly completed");
        }
        catch (OperationCanceledException) { }
        Expect(CouchCoopWebSocketConnection.DirectIpAddressFromRequest(true, "192.168.1.5:13337")?.ToString() == request.Address,
            "secure IP request selects the direct-IP seat path");
        Expect(CouchCoopWebSocketConnection.DirectIpAddressFromRequest(true, "192-168-1-5.my.local-ip.co:13337") is null
            && CouchCoopWebSocketConnection.DirectIpAddressFromRequest(false, "192.168.1.5:13337") is null,
            "hostname and HTTP requests retain their existing paths");
    }

    private static async Task DirectIpRefreshIsBoundToHostIdentity()
    {
        await using var host = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(Path.Combine(Path.GetTempPath(), "couchcoop-missing-static")),
            new NullAssetHttpAdapter(), bindAddress: IPAddress.Loopback, preferredPort: PickFreePort(),
            isHeadlessClient: false, log: _ => { });
        var uri = await host.StartAsync();
        var expected = new DirectIpSeatPreparation(new string('A', 64), "192.168.1.5", new string('B', 64), uri.Port);
        var requests = 0;
        host.RefreshDirectIpSeatMaterialAsync = (request, _) =>
        {
            requests++;
            return Task.FromResult(request == expected);
        };
        Expect(await HeadlessClientManager.RequestDirectIpRefreshAsync(uri.Port, expected, CancellationToken.None),
            "seat can request one host refresh for its authorized IP and root");
        Expect(requests == 1, "renewal is one bounded request");
        Expect(!await HeadlessClientManager.RequestDirectIpRefreshAsync(uri.Port,
            expected with { CaFingerprint = new string('C', 64) }, CancellationToken.None),
            "host rejects a stale or unrecognized authority");
        Expect(!await HeadlessClientManager.RequestDirectIpRefreshAsync(uri.Port,
            expected with { HostPort = uri.Port + 1 }, CancellationToken.None) && requests == 2,
            "wrong host port fails before sending");
        Expect(await HeadlessClientManager.RequestDirectIpOriginAsync(uri.Port, expected, CancellationToken.None) is null,
            "host cannot load a seat bundle through the seat-only endpoint");
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
        using var requestWithOrigin = new HttpRequestMessage(HttpMethod.Post,
            $"http://127.0.0.1:{uri.Port}{SecureOriginEndpoint.RefreshDirectIpRoute}?bundle={expected.BundleId}&address={expected.Address}&ca={expected.CaFingerprint}&hostPort={uri.Port}");
        requestWithOrigin.Headers.Add("Origin", "https://unrelated.example");
        using var response = await http.SendAsync(requestWithOrigin);
        Expect(response.StatusCode == HttpStatusCode.NotFound && requests == 2, "browser-origin refresh is refused");
    }

    // The honest answer for an instance with no secure origin is 0 — not a 404, which the caller could not
    // distinguish from an older build, and not a guess.
    private static async Task RouteReportsZeroWhenThereIsNoSecureListener()
    {
        SecureOriginEndpoint.Publish(0);
        using var host = new StubSecurePortHost(0);

        var reported = await HeadlessClientManager.TryResolveSecurePortAsync(
            host.Port, TimeSpan.FromMilliseconds(300), CancellationToken.None);

        Expect(reported is null, $"a zero secure port resolves to null, not 0 (got {reported?.ToString() ?? "null"})");
    }

    private static async Task RouteReportsThePublishedPort()
    {
        using var host = new StubSecurePortHost(24601);

        var reported = await HeadlessClientManager.TryResolveSecurePortAsync(
            host.Port, TimeSpan.FromSeconds(2), CancellationToken.None);

        Expect(reported == 24601, $"the published port is reported verbatim (got {reported?.ToString() ?? "null"})");
    }

    // The real handshake: a browser server standing in for a headless instance publishes its port through
    // SecureOriginEndpoint and serves the route from its own routing table; the host's resolver reads it.
    // This is the pair that has to agree across two processes in production.
    private static async Task HostResolvesAHeadlessSecurePortOverLoopback()
    {
        const int pretendSecurePort = 13358;
        SecureOriginEndpoint.Publish(0);
        try
        {
            await using var server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(Path.Combine(Path.GetTempPath(), "couchcoop-missing-static")),
                new NullAssetHttpAdapter(),
                bindAddress: IPAddress.Loopback,
                // A REAL preferred port, not 0: StartAsync builds BaseUri from the loop variable, so an
                // ephemeral bind would advertise port 0 and the resolver would short-circuit on it.
                preferredPort: PickFreePort(),
                isHeadlessClient: true,
                requestSecureOrigin: () => SecureOriginEndpoint.Publish(pretendSecurePort),
                log: _ => { });

            var baseUri = await server.StartAsync();
            var requested = await HeadlessClientManager.RequestSecureOriginAsync(baseUri.Port, CancellationToken.None);
            Expect(requested, "the host explicitly asks the headless seat to prepare secure setup");

            var reported = await HeadlessClientManager.TryResolveSecurePortAsync(
                baseUri.Port, TimeSpan.FromSeconds(3), CancellationToken.None);

            Expect(reported == pretendSecurePort,
                $"the host reads the instance's real secure port off the live route (got {reported?.ToString() ?? "null"})");
        }
        finally
        {
            SecureOriginEndpoint.Publish(0);
        }
    }

    // An instance whose certificate never lands keeps answering 0. The resolver must give up on its own
    // deadline so the join can fail closed rather than leaving the picker spinning.
    private static async Task ResolveGivesUpWhenTheInstanceNeverPublishes()
    {
        using var host = new StubSecurePortHost(0);

        var started = DateTimeOffset.UtcNow;
        var reported = await HeadlessClientManager.TryResolveSecurePortAsync(
            host.Port, TimeSpan.FromMilliseconds(700), CancellationToken.None);
        var elapsed = DateTimeOffset.UtcNow - started;

        Expect(reported is null, "a never-published port resolves to null");
        Expect(elapsed < TimeSpan.FromSeconds(5), $"and gives up on its deadline (took {elapsed.TotalMilliseconds:F0}ms)");
    }

    private static async Task ResolveGivesUpOnADeadPort()
    {
        var dead = PickFreePort();

        var reported = await HeadlessClientManager.TryResolveSecurePortAsync(
            dead, TimeSpan.FromMilliseconds(500), CancellationToken.None);

        Expect(reported is null, "a port with nothing listening resolves to null rather than throwing");

        // ...and a nonsense port short-circuits without any network work at all.
        Expect(await HeadlessClientManager.TryResolveSecurePortAsync(0, TimeSpan.FromSeconds(5), CancellationToken.None) is null,
            "port 0 short-circuits");
    }

    // The seat spawn must HAND DOWN the host's certificate cache. The per-slot user-dir isolation repoints
    // LocalApplicationData, so a seat left to its own devices resolves an always-empty cache and re-fetches
    // the same published bundle over the WAN — once per seat, on the path a join is waiting on.
    private static void CacheRootIsHandedToSeatsRatherThanRediscovered()
    {
        var hostRoot = SecureOriginCertificates.DefaultCacheRoot();
        Expect(!string.IsNullOrWhiteSpace(hostRoot), "the host resolves a cache root to share");

        // Simulate what the seeder does to a seat: repoint the per-user data root.
        var previous = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
        var slotHome = Path.Combine(Path.GetTempPath(), "couchcoop-slot-" + Guid.NewGuid().ToString("N"));
        try
        {
            Environment.SetEnvironmentVariable("XDG_DATA_HOME", slotHome);

            // Without an explicit override a seat WOULD diverge (this is the defect, asserted so a future
            // change to DefaultCacheRoot cannot silently make the hand-down unnecessary-looking while it is
            // still load-bearing). Only meaningful where the platform honours XDG_DATA_HOME.
            if (OperatingSystem.IsLinux())
            {
                var seatRoot = SecureOriginCertificates.DefaultCacheRoot();
                Expect(seatRoot != hostRoot,
                    "a seat's default cache root diverges from the host's once its data home is isolated");
            }

            // With the override the host hands down, it converges again.
            Environment.SetEnvironmentVariable(SecureOriginCertificates.CacheRootEnvironmentVariable, hostRoot);
            Expect(SecureOriginCertificates.DefaultCacheRoot() == hostRoot,
                "the handed-down override makes a seat resolve the host's cache");
        }
        finally
        {
            Environment.SetEnvironmentVariable(SecureOriginCertificates.CacheRootEnvironmentVariable, null);
            Environment.SetEnvironmentVariable("XDG_DATA_HOME", previous);
        }
    }

    // ---- helpers ---------------------------------------------------------------------------------------

    // A one-route HTTP server that answers /secure-port exactly as the browser server does, so the resolver
    // can be driven without standing up a whole game server.
    private sealed class StubSecurePortHost : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _stop = new();

        public StubSecurePortHost(int securePort)
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _ = Task.Run(() => ServeAsync(securePort, _stop.Token));
        }

        public int Port { get; }

        private async Task ServeAsync(int securePort, CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync(ct);
                }
                catch
                {
                    return;
                }

                using (client)
                {
                    try
                    {
                        var stream = client.GetStream();
                        // One read is enough: the resolver sends a single small GET and we only need to have
                        // drained enough of it to answer. The return is deliberately ignored.
                        var buffer = new byte[1024];
                        _ = await stream.ReadAsync(buffer, ct);

                        var json = $$"""{"securePort":{{securePort}}}""";
                        var response =
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                            + $"Content-Length: {Encoding.UTF8.GetByteCount(json)}\r\nConnection: close\r\n\r\n{json}";
                        await stream.WriteAsync(Encoding.UTF8.GetBytes(response), ct);
                        await stream.FlushAsync(ct);
                    }
                    catch
                    {
                    }
                }
            }
        }

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Stop();
            _stop.Dispose();
        }
    }

    private sealed class NullAssetHttpAdapter : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
            string opaqueKey,
            CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new CouchCoopAssetHttpResponse(null, null, new Dictionary<string, string>(), null));
    }

    private static int PickFreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"SecureHeadlessRedirectTests failed: {because}");
        }
    }
}
