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
