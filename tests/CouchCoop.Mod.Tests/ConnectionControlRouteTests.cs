using System.Net;
using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionControlRouteTests
{
    public static async Task RunAsync()
    {
        await AcceptsOnlyBoundLoopbackReports();
        await RefusesNonLoopbackReports();
        await EveryRefusalIsCounted();
    }

    /// <summary>
    /// A refused status is COUNTED, per seat and per host, with the reason the last one carried.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The point of the counters, and why this asserts the zero as hard as the increments: on the host, a seat
    /// with no heartbeat is the same silence whether nothing ever arrived or everything that arrived was turned
    /// away — and those two have opposite fixes. Before this, both read as "authenticated heartbeat fresh:
    /// false" and nothing else. So a host that refused NOTHING has to be able to say so.
    /// </para>
    /// <para>
    /// The two refusals with no entry to charge them to (no token at all, and a token this host does not know)
    /// are the reason the host-wide pair exists; both are exercised here.
    /// </para>
    /// </remarks>
    private static async Task EveryRefusalIsCounted()
    {
        using var root = new TempStaticSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssetAdapter(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
        var baseUri = await server.StartAsync();
        var session = Guid.NewGuid();
        HeadlessConnectionControl.Shared.Register(84, 11, session, "counted-token");
        var before = HeadlessConnectionControl.Shared.Refusals;
        try
        {
            using var client = new HttpClient { BaseAddress = baseUri };
            Assert((await SendAsync(client, "counted-token", 11, StatusJson(1))).StatusCode == HttpStatusCode.OK,
                "a healthy report is accepted");
            var accepted = HeadlessConnectionControl.Shared.Snapshot(84, 11)!;
            Assert(accepted.AcceptedCount == 1 && accepted.RefusedCount == 0
                    && accepted.LastRefusal == HeadlessConnectionRejection.None,
                "…and counted as accepted, with nothing refused and no reason to name");
            Assert(HeadlessConnectionControl.Shared.Refusals.Count == before.Count,
                "…and an accepted report never moves the host's refusal count");

            await SendAsync(client, "counted-token", 12, StatusJson(2));
            var generation = HeadlessConnectionControl.Shared.Snapshot(84, 11)!;
            Assert(generation.RefusedCount == 1
                    && generation.LastRefusal == HeadlessConnectionRejection.GenerationMismatch,
                "a status from a generation this host has replaced is refused, and says so");

            await SendAsync(client, "counted-token", 11, StatusJson(1));
            var stale = HeadlessConnectionControl.Shared.Snapshot(84, 11)!;
            Assert(stale.RefusedCount == 2 && stale.LastRefusal == HeadlessConnectionRejection.StaleSequence,
                "a sequence already seen is refused, and says so");
            Assert(stale.AcceptedCount == 1, "…and neither refusal is mistaken for something heard");

            await SendAsync(client, "not-a-known-token", 11, StatusJson(3));
            var unknown = HeadlessConnectionControl.Shared.Refusals;
            Assert(unknown.Count == before.Count + 3 && unknown.Last == HeadlessConnectionRejection.UnknownToken,
                "a token this host never issued is counted on the host, which is the only place it can be");
            Assert(HeadlessConnectionControl.Shared.Snapshot(84, 11)!.RefusedCount == 2,
                "…and is not charged to an innocent seat");
        }
        finally
        {
            HeadlessConnectionControl.Shared.Unregister(84, 11);
        }
    }

    private static async Task AcceptsOnlyBoundLoopbackReports()
    {
        using var root = new TempStaticSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssetAdapter(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
        var baseUri = await server.StartAsync();
        var session = Guid.NewGuid();
        HeadlessConnectionControl.Shared.Register(82, 7, session, "route-token");
        try
        {
            using var client = new HttpClient { BaseAddress = baseUri };
            var healthy = await SendAsync(client, "route-token", 7, StatusJson(1));
            Assert(healthy.StatusCode == HttpStatusCode.OK, "loopback POST with bound token and generation is accepted");
            Assert(await healthy.Content.ReadAsStringAsync() is var healthyBody
                   && healthyBody.Contains("\"shutdown\":false", StringComparison.Ordinal),
                "accepted report returns the shutdown command");

            var wrongToken = await SendAsync(client, "wrong-token", 7, StatusJson(2));
            Assert(wrongToken.StatusCode == HttpStatusCode.Unauthorized, "wrong bearer token is rejected");

            var wrongGeneration = await SendAsync(client, "route-token", 8, StatusJson(2));
            Assert(wrongGeneration.StatusCode == HttpStatusCode.Unauthorized, "wrong generation is rejected");

            var staleSequence = await SendAsync(client, "route-token", 7, StatusJson(1));
            Assert(staleSequence.StatusCode == HttpStatusCode.Unauthorized, "repeated sequence is rejected");

            var invalidJson = await SendAsync(client, "route-token", 7, "{");
            Assert(invalidJson.StatusCode == HttpStatusCode.BadRequest, "invalid JSON is rejected");

            var tooLarge = await SendAsync(client, "route-token", 7, new string('x', 16 * 1024 + 1));
            Assert(tooLarge.StatusCode == HttpStatusCode.RequestEntityTooLarge, "body larger than 16 KiB is rejected");

            var get = await client.GetAsync("/internal/client-status");
            Assert(get.StatusCode == HttpStatusCode.NotFound, "status endpoint does not answer GET");

            var manyBrowsers = await SendAsync(client, "route-token", 7,
                "{\"Sequence\":2,\"NativePhase\":\"Connecting\",\"ConnectedChildBrowserCount\":65}");
            Assert(manyBrowsers.StatusCode == HttpStatusCode.OK,
                "status reporting does not impose a lower browser limit than the configurable server");
        }
        finally
        {
            HeadlessConnectionControl.Shared.Unregister(82, 7);
        }
    }

    private static async Task RefusesNonLoopbackReports()
    {
        var lanAddress = FindLanAddress();
        Assert(lanAddress is not null, "a local non-loopback IPv4 address is required for the TCP route check");
        var preferredPort = FindFreePort();
        using var root = new TempStaticSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssetAdapter(), envelopeFactory: null,
            bindAddress: IPAddress.Any, preferredPort: preferredPort, isHeadlessClient: true);
        await server.StartAsync();

        var session = Guid.NewGuid();
        HeadlessConnectionControl.Shared.Register(83, 9, session, "lan-token");
        try
        {
            using var client = new HttpClient { BaseAddress = new Uri($"http://{lanAddress}:{preferredPort}/") };
            var response = await SendAsync(client, "lan-token", 9, StatusJson(1));
            Assert(response.StatusCode == HttpStatusCode.NotFound,
                "the loopback-only status endpoint is hidden from a non-loopback local TCP source");
        }
        finally
        {
            HeadlessConnectionControl.Shared.Unregister(83, 9);
        }
    }

    private static Task<HttpResponseMessage> SendAsync(HttpClient client, string token, long generation, string body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/internal/client-status")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("X-CouchCoop-Generation", generation.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return client.SendAsync(request);
    }

    private static string StatusJson(long sequence)
        => $"{{\"Sequence\":{sequence},\"NativePhase\":\"Connecting\",\"ConnectedChildBrowserCount\":0}}";

    private static IPAddress? FindLanAddress()
        => NetworkInterface.GetAllNetworkInterfaces()
            .Where(network => network.OperationalStatus == OperationalStatus.Up)
            .SelectMany(network => network.GetIPProperties().UnicastAddresses)
            .Select(address => address.Address)
            .FirstOrDefault(address => address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(address));

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Any, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private sealed class UnusedAssetAdapter : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
            string opaqueKey, CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("The status route must not request assets.");
    }

    private sealed class TempStaticSpa : IDisposable
    {
        public TempStaticSpa()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couch-control-route-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
            File.WriteAllText(System.IO.Path.Combine(Path, "index.html"), "test");
        }

        public string Path { get; }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[ConnectionControlRouteTests] FAILED: {message}");
    }
}
