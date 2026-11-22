using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Server.LanRtc;

internal static class LanRtcHostTests
{
    private static readonly IPAddress Peer = IPAddress.Parse("192.0.2.44");
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    public static async Task RunAsync()
    {
        LibraryPaths();
        await OffByDefaultAsync();
        await HostLifecycleAsync();
        await MissingLibraryAsync();
        await InvalidBudgetAsync();
        await SmallBudgetAsync();
        await FailedIdentityAsync();
        await UnavailableUdpAsync();
        await AddressedDispatchAsync();
        var native = Environment.GetEnvironmentVariable(LanRtcModule.LibraryEnvironmentVariable);
        if (string.IsNullOrEmpty(native)) Console.WriteLine("LanRtcHostTests: native lifecycle skipped (COUCHCOOP_LAN_RTC_LIB unset)");
        else await NativeLifecycleAsync();
        Console.WriteLine($"LanRtcHostTests: {(string.IsNullOrEmpty(native) ? 9 : 10)} cases passed");
    }

    private static void LibraryPaths()
    {
        var root = Path.Combine(Path.GetTempPath(), "rtc-payload");
        var os = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux";
        var file = OperatingSystem.IsWindows() ? "render_stream_net.dll" : OperatingSystem.IsMacOS()
            ? "librender_stream_net.dylib" : "librender_stream_net.so";
        var expected = Path.Combine(root, "render-capture", os, file);
        Expect(LanRtcModule.ResolveLibraryPath(root, null) == expected &&
            LanRtcModule.ResolveLibraryPath(Path.Combine(root, "lanes", "v113"), null) == expected,
            "flat and lane payloads resolve the net module without capture/calibration files");
        Expect(LanRtcModule.ResolveLibraryPath(root, Path.Combine(root, "override", "capture.gdextension")) ==
            Path.Combine(root, "override", file), "capture override locates its adjacent net module");
    }

    private static async Task OffByDefaultAsync()
    {
        var old = Environment.GetEnvironmentVariable(LanRtcHost.EnableEnvironmentVariable);
        try
        {
            foreach (var value in new string?[] { null, "0", "true" })
            {
                Environment.SetEnvironmentVariable(LanRtcHost.EnableEnvironmentVariable, value);
                using var f = new Fixture();
                await using var service = f.Services();
                service.LanRtcEnabled = null;
                var creates = 0;
                service.CreateLanRtcModule = (_, _, _, _, _) => { creates++; return null; };
                var snapshot = await service.StartAsync();
                service.StartDiscoveryServices();
                await service.DiscoveryServicesReady;
                Expect(creates == 0 && !Directory.Exists(f.IdentityRoot) && LanRtcAvailability.FingerprintFor(f.Address, f.Port) is null,
                    $"RTC stays off without {LanRtcHost.EnableEnvironmentVariable}=1 (value {value ?? "unset"})");
                Expect(!f.WebQr().Contains("&f=", StringComparison.Ordinal), "an off tunnel keeps f out of the Website QR");
                await f.AssertBootAsync(snapshot.JoinBaseUri!, false);
                Expect(f.Logs.Any(line => line.Contains("LAN RTC off", StringComparison.Ordinal)), "off state is logged");
            }
            Environment.SetEnvironmentVariable(LanRtcHost.EnableEnvironmentVariable, "1");
            using (var f = new Fixture())
            {
                await using var service = f.Services();
                service.LanRtcEnabled = null;
                var creates = 0;
                service.CreateLanRtcModule = (_, _, _, _, _) => { creates++; return null; };
                await service.StartAsync();
                service.StartDiscoveryServices();
                await service.DiscoveryServicesReady;
                Expect(creates == 1, $"{LanRtcHost.EnableEnvironmentVariable}=1 starts RTC");
            }
        }
        finally { Environment.SetEnvironmentVariable(LanRtcHost.EnableEnvironmentVariable, old); }
    }

    private static async Task HostLifecycleAsync()
    {
        using var f = new Fixture();
        using var fake = new LanRtcModuleTests.Fake();
        await using var service = f.Services();
        var creates = 0;
        service.CreateLanRtcModule = (identity, candidate, socket, log, budget) =>
        { creates++; return CreateFake(fake, identity, candidate, socket, log, budget); };
        var oldBudget = Environment.GetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable);
        Environment.SetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable, "123456");
        try
        {
            var snapshot = await service.StartAsync();
            Expect(snapshot.Available && creates == 0 && !Directory.Exists(f.IdentityRoot), "deferred host has no RTC work before discovery");
            await f.AssertBootAsync(snapshot.JoinBaseUri!, false);
            service.StartDiscoveryServices();
            await service.DiscoveryServicesReady;
            Expect(creates == 1 && Budget(fake) == 123456, "discovery starts RTC once with the configured send budget");
            service.StartDiscoveryServices();
            Expect(creates == 1, "repeated start does not create another module");
            var socket = service.BrowserPortUdpSocket!;
            using var identity = LanRtcIdentity.LoadOrCreate(f.IdentityRoot, _ => { });
            var fingerprint = LanRtcAvailability.FingerprintFor(f.Address, f.Port);
            Expect(fingerprint == identity.Fingerprint, "active QR uses the persistent identity");
            Expect(f.WebQr().Contains("&f=" + fingerprint, StringComparison.Ordinal), "Website QR discovers active availability by default");
            var other = new QrAdapterInfo("other", QrAdapterKind.Wifi, Peer);
            Expect(!QrHostOptions.DescribeWebFor(other, f.Port, CouchCoopWebOrigin.Resolve())!.AbsoluteUri!.Contains("&f="),
                "an unadvertised interface does not claim the single native candidate");
            await f.AssertBootAsync(snapshot.JoinBaseUri!, true);
            var destroyedInOrder = false;
            SetDestroy(fake, () => destroyedInOrder = socket.IsListening && LanRtcAvailability.FingerprintFor(f.Address, f.Port) is null);
            await service.StopDiscoveryServicesAsync();
            Expect(fake.Destroys == 1 && destroyedInOrder && !socket.IsListening, "withdraw, destroy, then dispose UDP");
            Expect(!f.WebQr().Contains("&f="), "stopped Website QR loses the fingerprint");
            await f.AssertBootAsync(snapshot.JoinBaseUri!, false);
            service.StartDiscoveryServices();
            await service.DiscoveryServicesReady;
            Expect(creates == 2 && LanRtcAvailability.FingerprintFor(f.Address, f.Port) == fingerprint,
                "hosting restart recreates the module with the same identity");
            SetDestroy(fake, null);
            await service.DisposeAsync();
            Expect(fake.Destroys == 2 && LanRtcAvailability.FingerprintFor(f.Address, f.Port) is null,
                "full host disposal clears availability and destroys once per module");
        }
        finally { Environment.SetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable, oldBudget); }
    }

    private static async Task MissingLibraryAsync()
    {
        using var f = new Fixture();
        await using var service = f.Services();
        service.CreateLanRtcModule = (identity, candidate, socket, log, budget) => LanRtcModule.TryCreate(
            identity, candidate, socket, log, budget, Path.Combine(f.Root, "missing-library"));
        var snapshot = await service.StartAsync();
        service.StartDiscoveryServices();
        Expect(f.Logs.Count(l => l.StartsWith("LAN RTC unavailable:")) == 1 && service.BrowserPortUdpSocket!.IsListening,
            "missing library logs once and leaves discovery available");
        Expect(!f.WebQr().Contains("&f="), "missing module keeps the QR unchanged");
        await f.AssertBootAsync(snapshot.JoinBaseUri!, false);
    }

    private static async Task InvalidBudgetAsync()
    {
        using var f = new Fixture();
        await using var service = f.Services();
        var old = Environment.GetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable);
        Environment.SetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable, "-1");
        try
        {
            var snapshot = await service.StartAsync();
            service.StartDiscoveryServices();
            Expect(f.Logs.Any(l => l.Contains("Invalid " + LanRtcHost.SendBudgetEnvironmentVariable)), "invalid budget fails RTC only");
            await f.AssertBootAsync(snapshot.JoinBaseUri!, false);
        }
        finally { Environment.SetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable, old); }
    }

    private static async Task SmallBudgetAsync()
    {
        var old = Environment.GetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable);
        try
        {
            foreach (var setting in new uint[] { 0, 1, 16385, 65535, 65536 })
            {
                Environment.SetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable, setting.ToString());
                using var f = new Fixture();
                using var fake = new LanRtcModuleTests.Fake();
                await using var service = f.Services();
                var creates = 0;
                service.CreateLanRtcModule = (identity, candidate, socket, log, budget) =>
                { creates++; return CreateFake(fake, identity, candidate, socket, log, budget); };
                var snapshot = await service.StartAsync();
                service.StartDiscoveryServices();
                await service.DiscoveryServicesReady;
                service.StartDiscoveryServices();
                var rejected = setting is > 0 and < 65536;
                Expect(creates == 1 && Budget(fake) == (rejected ? 0 : setting),
                    "small association budgets fall back to the module default; zero and the minimum are accepted");
                Expect(f.Logs.Count(l => l.Contains(LanRtcHost.SendBudgetEnvironmentVariable)) == (rejected ? 1 : 0),
                    "a rejected small budget logs exactly once");
                await f.AssertBootAsync(snapshot.JoinBaseUri!, true);
            }
        }
        finally { Environment.SetEnvironmentVariable(LanRtcHost.SendBudgetEnvironmentVariable, old); }
    }

    private static async Task FailedIdentityAsync()
    {
        using var f = new Fixture();
        await File.WriteAllTextAsync(f.IdentityRoot, "not a directory");
        await using var service = f.Services();
        var snapshot = await service.StartAsync();
        service.StartDiscoveryServices();
        Expect(f.Logs.Any(l => l.StartsWith("LAN RTC unavailable:")), "identity failure leaves the host running");
        await f.AssertBootAsync(snapshot.JoinBaseUri!, false);
    }

    private static async Task UnavailableUdpAsync()
    {
        using var f = new Fixture();
        var socket = new BrowserPortUdpSocket(0, _ => null, _ => { });
        var port = socket.Port;
        await socket.DisposeAsync();
        await using var host = LanRtcHost.TryStart(new(f.Address, port), socket, (_, _, _) => Task.CompletedTask,
            _ => { }, f.IdentityRoot, (_, _, _, _, _) => throw new Exception("must not create"));
        Expect(host is null && !Directory.Exists(f.IdentityRoot), "an unavailable UDP socket never creates or advertises RTC");
    }

    private static async Task AddressedDispatchAsync()
    {
        using var f = new Fixture();
        await using var host = new HotReloadableBrowserServerHost(f.Runtime, f.Root, f.Address, f.Port, log: _ => { });
        await host.StartAsync();
        var candidate = new IPEndPoint(f.Address, f.Port);
        var transport = new LanRtcTunnelTests.FakeTransport();
        await using (var tunnel = new LanRtcTunnel(transport, host.ServeLanRtcAsync, candidate))
        {
            transport.Request("POST", "/internal/client-status");
            Expect(Status(await transport.ResponseAsync()) == 404, "built-in generation refuses LAN access to loopback routes");
        }
        var first = new AddressedGeneration();
        await host.ReplaceGenerationAsync(first, 1);
        await AssertGenerationAsync(host, candidate, first);
        var second = new AddressedGeneration();
        await host.ReplaceGenerationAsync(second, 2);
        await AssertGenerationAsync(host, candidate, second);
        Expect(first.Calls == 1 && second.Calls == 1, "new channels resolve the current hot generation");
        var legacy = new LegacyGeneration();
        await host.ReplaceGenerationAsync(legacy, 3);
        transport = new();
        await using (var tunnel = new LanRtcTunnel(transport, host.ServeLanRtcAsync, candidate))
        {
            transport.Request("GET", "/");
            Expect(Status(await transport.ResponseAsync()) == 503 && legacy.Calls == 0, "addressless generations fail closed");
        }
    }

    private static async Task AssertGenerationAsync(HotReloadableBrowserServerHost host, IPEndPoint candidate, AddressedGeneration generation)
    {
        var transport = new LanRtcTunnelTests.FakeTransport();
        await using var tunnel = new LanRtcTunnel(transport, host.ServeLanRtcAsync, candidate);
        transport.Request("POST", "/echo", "upload"u8.ToArray());
        Expect(Status(await transport.ResponseAsync()) == 204 && generation.Remote!.Equals(Peer) && !generation.Secure &&
            generation.Body == "upload", "addressed seam preserves IP, security and body through FIN");
    }

    private static async Task NativeLifecycleAsync()
    {
        using var f = new Fixture();
        await using var service = f.Services();
        var snapshot = await service.StartAsync();
        service.StartDiscoveryServices();
        await service.DiscoveryServicesReady;
        await f.AssertBootAsync(snapshot.JoinBaseUri!, true);
        Expect(LanRtcAvailability.FingerprintFor(f.Address, f.Port) is not null, "real native module is attached inside host services");
        await service.StopDiscoveryServicesAsync();
        await f.AssertBootAsync(snapshot.JoinBaseUri!, false);
        service.StartDiscoveryServices();
        await service.DiscoveryServicesReady;
        await f.AssertBootAsync(snapshot.JoinBaseUri!, true);
        await service.DisposeAsync();
        Expect(LanRtcAvailability.FingerprintFor(f.Address, f.Port) is null, "real native host disposes without traffic or stale readiness");
    }

    private static int Status(List<LanRtcTunnelTests.Message> response)
    { using var json = JsonDocument.Parse(response[0].Data); return json.RootElement.GetProperty("s").GetInt32(); }
    private static unsafe LanRtcModule CreateFake(LanRtcModuleTests.Fake fake, LanRtcIdentity identity,
        IPEndPoint candidate, BrowserPortUdpSocket socket, Action<string> log, uint budget)
        => LanRtcModule.Create(fake.Api, identity, candidate, socket, log, budget);
    private static unsafe uint Budget(LanRtcModuleTests.Fake fake) => fake.Config.SendBudget;
    private static unsafe void SetDestroy(LanRtcModuleTests.Fake fake, Action? action) => fake.OnDestroy = action;
    private static void Expect(bool condition, string reason)
    { if (!condition) throw new InvalidOperationException("LanRtcHostTests: " + reason); }

    private sealed class Fixture : IDisposable
    {
        public string Root { get; } = Directory.CreateTempSubdirectory("couch-rtc-host-").FullName;
        public string IdentityRoot => Path.Combine(Root, "identity");
        public IPAddress Address { get; } = NetworkInterface.GetAllNetworkInterfaces().SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Select(a => a.Address).First(BrowserPortUdpSocket.IsRtcSource);
        public int Port { get; }
        public List<string> Logs { get; } = [];
        public CouchCoopRuntimeHost Runtime { get; }
        public Fixture()
        {
            using var listener = new TcpListener(Address, 0);
            listener.Start(); Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            File.WriteAllText(Path.Combine(Root, "index.html"), "rtc host");
            // A stale disk field must never advertise a module that isn't attached.
            File.WriteAllText(Path.Combine(Root, StaticSpaFileProvider.BootManifestDiskName.TrimStart('/')), "{\"tunnel\":\"stale\",\"build\":\"test\"}");
            var source = new BrowserServerRouteTests.RecordingSpirectlRuntime();
            Runtime = new(new CouchCoopRuntimeDependencies(source, source, source, source, source, source, source, source, source), _ => { });
        }
        public CouchCoopHostUiServices Services() => new(Runtime, Root, Address, Port, Logs.Add, deferDiscoveryServices: true)
            { LanRtcIdentityStorageRoot = IdentityRoot, LanRtcEnabled = true };
        public string WebQr() => QrHostOptions.DescribeWebFor(new("lan", QrAdapterKind.Wifi, Address), Port,
            CouchCoopWebOrigin.Resolve())!.AbsoluteUri!;
        public async Task AssertBootAsync(Uri uri, bool available)
        {
            using var client = new HttpClient(new SocketsHttpHandler { UseProxy = false }) { Timeout = Timeout };
            using var json = JsonDocument.Parse(await client.GetStringAsync(new Uri(uri, "/app-boot.json")));
            var root = json.RootElement;
            Expect(root.GetProperty("build").GetString() == "test", "manifest fields preserved");
            Expect(root.TryGetProperty("tunnel", out var tunnel) == available && (!available || tunnel.GetString() == LanRtcAvailability.Protocol),
                "boot availability follows the attached module, overriding stale disk metadata");
        }
        public void Dispose() { Runtime.Dispose(); Directory.Delete(Root, true); }
    }

    private class LegacyGeneration : ICouchCoopHotGeneration, ICouchCoopStreamGeneration
    {
        public int Calls;
        public string DescribeOverlayLayoutJson() => "";
        public Task HandleClientAsync(TcpClient client, CancellationToken token) => throw new NotSupportedException();
        public Task ServeAsync(Stream stream, bool isSecure, CancellationToken token) { Calls++; throw new Exception("address lost"); }
        public Task StopAsync(HotReloadShutdownContext context, CancellationToken token) => Task.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
    private sealed class AddressedGeneration : LegacyGeneration, ICouchCoopAddressedStreamGeneration
    {
        public IPAddress? Remote;
        public bool Secure;
        public string? Body;
        public async Task ServeAsync(Stream stream, bool isSecure, IPAddress remoteAddress, CancellationToken token)
        {
            Calls++; Remote = remoteAddress; Secure = isSecure;
            Expect(stream is not ILanRtcRequestStream, "tunnel uses HTTP framing across a generation boundary");
            var request = (await CouchCoopHttpRequest.TryReadAsync(stream, token))!;
            var body = new byte[int.Parse(request.Header("Content-Length")!)];
            await stream.ReadExactlyAsync(body, token); Body = Encoding.UTF8.GetString(body);
            await stream.WriteAsync("HTTP/1.1 204 No Content\r\n\r\n"u8.ToArray(), token);
        }
    }
}
