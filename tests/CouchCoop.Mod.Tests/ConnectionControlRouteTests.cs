using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionControlRouteTests
{
    public static async Task RunAsync()
    {
        await AcceptsOnlyBoundLoopbackReports();
        await RefusesNonLoopbackReports();
        await EveryRefusalIsCounted();
        await HealthyHeartbeatDoesNotWaitForAnotherSeatLaunch();
        await TerminalStatusIsAppliedBeforeReply();
    }

    private static async Task HealthyHeartbeatDoesNotWaitForAnotherSeatLaunch()
    {
        using var root = new TempStaticSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssetAdapter(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
        using var client = new HttpClient { BaseAddress = await server.StartAsync() };
        var firstId = HeadlessConnectionLifecycleTests.BeginAttempt();
        var secondId = Guid.NewGuid();
        var launchEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var releaseLaunch = new ManualResetEventSlim();
        using var secondStop = new CancellationTokenSource();
        using var manager = new HeadlessClientManager(slot =>
        {
            if (slot != 2)
            {
                launchEntered.TrySetResult();
                if (!releaseLaunch.Wait(TimeSpan.FromSeconds(10)))
                    throw new TimeoutException("The test did not release the second seat's launch.");
            }
            return new HeadlessConnectionLifecycleTests.FakeProcess(800 + slot);
        }, (_, _) => Task.FromResult(true));
        manager.ConfigureConnectionMonitoring(_ => true, () => 12345);
        Task<int?>? secondJoin = null;
        try
        {
            var firstJoin = manager.EnsureHeadlessAsync(firstId, "first-seat", CancellationToken.None);
            var control = await HeadlessConnectionLifecycleTests.WaitForControlAsync(firstId);
            HeadlessConnectionLifecycleTests.RegisterKnown(control, firstId, "launch-concurrency-token");
            var status = new HeadlessConnectionStatus(1, "Connecting", null, null, 1,
                CloudSaveIsolated: true, RelayReady: true);
            using var initial = await SendAsync(client, "launch-concurrency-token", control.Generation,
                JsonSerializer.Serialize(status));
            Assert(initial.StatusCode == HttpStatusCode.OK, "the first seat's initial heartbeat is accepted");
            Assert(await firstJoin.WaitAsync(TimeSpan.FromSeconds(2)) is not null,
                "the first seat has joined before another begins launching");

            ConnectionRegistry.Shared.Connected(secondId, null);
            ConnectionRegistry.Shared.BeginAttempt(secondId);
            // A dedicated thread holds the real allocation lock in the injected launcher. The request's
            // result must not depend on that launch, or on thread-pool growth accommodating a blocked test.
            secondJoin = Task.Factory.StartNew(
                () => manager.EnsureHeadlessAsync(secondId, "second-seat", secondStop.Token),
                CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();
            await launchEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));

            var received = 0;
            void ObserveSignal(HeadlessConnectionControlSnapshot snapshot)
            {
                if (snapshot.SourceSessionId == firstId && snapshot.Status?.Sequence > 1)
                    Interlocked.Increment(ref received);
            }
            HeadlessConnectionControl.Shared.StatusChanged += ObserveSignal;
            try
            {
                var started = Stopwatch.GetTimestamp();
                HttpResponseMessage heartbeatResponse;
                try
                {
                    heartbeatResponse = await SendAsync(client, "launch-concurrency-token", control.Generation,
                        JsonSerializer.Serialize(status with { Sequence = 2, ConnectedChildBrowserCount = 0 }))
                        .WaitAsync(TimeSpan.FromSeconds(1));
                }
                catch (TimeoutException)
                {
                    Console.WriteLine($"control heartbeat blocked behind seat launch for {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F1} ms");
                    throw;
                }
                using var heartbeat = heartbeatResponse;
                var elapsed = Stopwatch.GetElapsedTime(started);
                Console.WriteLine($"control heartbeat during blocked seat launch: {elapsed.TotalMilliseconds:F1} ms");
                Assert(heartbeat.StatusCode == HttpStatusCode.OK && !releaseLaunch.IsSet,
                    "a healthy Connecting heartbeat is answered while another seat's launch is still blocked");
                var observed = HeadlessConnectionControl.Shared.Snapshot(control.Slot, control.Generation)!;
                Assert(observed.Status?.Sequence == 2 && observed.Status.ConnectedChildBrowserCount == 0,
                    "the heartbeat still refreshes authenticated seat and browser state");
                Assert(Volatile.Read(ref received) == 1,
                    "status signals still wake the shared-relay monitor before the HTTP reply");
            }
            finally { HeadlessConnectionControl.Shared.StatusChanged -= ObserveSignal; }
        }
        finally
        {
            secondStop.Cancel();
            releaseLaunch.Set();
            if (secondJoin is not null)
            {
                try { await secondJoin.WaitAsync(TimeSpan.FromSeconds(3)); }
                catch (OperationCanceledException) { }
            }
            manager.Dispose();
            HeadlessConnectionLifecycleTests.CleanupControl(firstId);
            HeadlessConnectionLifecycleTests.CleanupControl(secondId);
            ConnectionRegistry.Shared.Clear();
        }
    }

    private static async Task TerminalStatusIsAppliedBeforeReply()
    {
        using var root = new TempStaticSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssetAdapter(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
        using var client = new HttpClient { BaseAddress = await server.StartAsync() };
        foreach (var (status, expectedCode) in new[]
        {
            (new HeadlessConnectionStatus(1, "mod-init", null, null, 0), HeadlessClientManager.SeatCloudIsolationCode),
            (new HeadlessConnectionStatus(1, "FAILED", null, null, 0, CloudSaveIsolated: true), "native-join-rejected"),
            (new HeadlessConnectionStatus(1, "disconnected", null, null, 0, CloudSaveIsolated: true), "native-disconnected"),
            (new HeadlessConnectionStatus(1, "Connecting", HeadlessDisconnectReason.RunInProgressCode, null, 0,
                CloudSaveIsolated: true), HeadlessDisconnectReason.RunInProgressCode),
            (new HeadlessConnectionStatus(1, "Connecting", null, "RunInProgress", 0,
                CloudSaveIsolated: true), HeadlessDisconnectReason.RunInProgressCode),
        })
        {
            var id = HeadlessConnectionLifecycleTests.BeginAttempt();
            using var stop = new CancellationTokenSource();
            using var manager = new HeadlessClientManager(
                _ => new HeadlessConnectionLifecycleTests.FakeProcess(890), (_, _) => Task.FromResult(true));
            manager.ConfigureConnectionMonitoring(_ => true, () => 12345);
            var pending = manager.EnsureHeadlessAsync(id, "terminal-seat", stop.Token);
            try
            {
                var control = await HeadlessConnectionLifecycleTests.WaitForControlAsync(id);
                HeadlessConnectionLifecycleTests.RegisterKnown(control, id, "terminal-route-token");
                using var response = await SendAsync(client, "terminal-route-token", control.Generation,
                    JsonSerializer.Serialize(status));
                Assert(response.StatusCode == HttpStatusCode.OK, "the terminal status itself is accepted");
                Assert(ConnectionRegistry.Shared.Snapshot().Rows.Single(row => row.Id == id).Issue?.Code == expectedCode,
                    $"{expectedCode} reaches the host's report before the child receives its response");
            }
            finally
            {
                stop.Cancel();
                manager.Dispose();
                try { await pending.WaitAsync(TimeSpan.FromSeconds(3)); }
                catch (OperationCanceledException) { }
                HeadlessConnectionLifecycleTests.CleanupControl(id);
                ConnectionRegistry.Shared.Clear();
            }
        }
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
