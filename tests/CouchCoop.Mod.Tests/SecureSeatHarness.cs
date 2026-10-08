using System.Diagnostics;
using System.Net;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

// WS6 follow-up live harness: the HOST -> SEAT secure handshake, across two REAL processes.
//
//   dotnet run --project tests/CouchCoop.Mod.Tests -- secure-seat-harness
//
// The unit suite drives the handshake over loopback inside one process, which cannot answer the two
// questions that actually decide whether a joined seat works over the secure origin:
//
//   1. Does a SEPARATE process, started the way a headless seat is started (COUCHCOOP_HEADLESS_CLIENT=1 and
//      its own isolated XDG_DATA_HOME), actually bring a secure listener up at all?
//   2. Does it do so from the HOST's certificate cache — i.e. without its own WAN fetch — now that the host
//      hands COUCHCOOP_SECURE_CERT_CACHE down to it?
//
// The parent fetches once, then spawns itself as a "seat" with a deliberately isolated data home and the
// handed-down cache. It explicitly requests TLS over loopback, as a secure viewer redirect does. The child
// is told to REFUSE to fetch, so a cache miss is a visible failure rather than a silent round-trip — which
// makes this a test of deferred setup, the cache hand-down, and the listener.
internal static class SecureSeatHarness
{
    public const string Verb = "secure-seat-harness";
    private const string ChildArg = "child";

    // Set on the child only. The child asserts the certificate came from the cache; if the cache were not
    // shared it would have to fetch, and it fails instead.
    private const string ChildNoFetchVariable = "COUCHCOOP_SECURE_HARNESS_NO_FETCH";

    public static async Task<int> RunAsync(string[] args)
        => args is [_, ChildArg, ..] ? await RunChildAsync() : await RunParentAsync();

    private static async Task<int> RunParentAsync()
    {
        var cacheRoot = Path.Combine(Path.GetTempPath(), "couchcoop-secure-harness-" + Guid.NewGuid().ToString("N"));
        Console.WriteLine($"[parent] cache={cacheRoot}");

        // 1. Host-role acquisition: the harness stands in for a player selecting the HTTPS QR row.
        var certificates = new SecureOriginCertificates(cacheRoot: cacheRoot, log: Console.WriteLine);
        await certificates.StartAsync();
        if (!certificates.Status.IsReady)
        {
            Console.WriteLine($"[parent] SKIP: no certificate ({certificates.Status.Reason}). Needs internet.");
            certificates.Dispose();
            return 0;
        }

        Console.WriteLine($"[parent] host certificate ready, cache written: "
            + $"{string.Join(", ", Directory.GetFiles(cacheRoot).Select(Path.GetFileName))}");
        certificates.Dispose();

        // 2. Spawn a SEAT-shaped child: headless flag on, data home isolated (which is what breaks the cache
        //    by default), and the host's cache handed down the way HeadlessClientManager does it.
        var exe = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(exe))
        {
            Console.WriteLine("[parent] FAIL: cannot resolve this process's path to re-spawn.");
            return 1;
        }

        var slotHome = Path.Combine(Path.GetTempPath(), "couchcoop-secure-harness-slot-" + Guid.NewGuid().ToString("N"));
        var psi = new ProcessStartInfo(exe) { UseShellExecute = false, RedirectStandardOutput = true };
        psi.ArgumentList.Add(Verb);
        psi.ArgumentList.Add(ChildArg);
        psi.EnvironmentVariables["COUCHCOOP_HEADLESS_CLIENT"] = "1";
        psi.EnvironmentVariables["XDG_DATA_HOME"] = slotHome;
        psi.EnvironmentVariables["LOCALAPPDATA"] = slotHome;
        psi.EnvironmentVariables[SecureOriginCertificates.CacheRootEnvironmentVariable] = cacheRoot;
        psi.EnvironmentVariables[ChildNoFetchVariable] = "1";

        using var child = Process.Start(psi);
        if (child is null)
        {
            Console.WriteLine("[parent] FAIL: could not start the seat process.");
            return 1;
        }

        try
        {
            // The child prints "SEAT-HTTP <port>" once its browser server is listening.
            var httpPort = await ReadSeatPortAsync(child, TimeSpan.FromSeconds(30));
            if (httpPort is null)
            {
                Console.WriteLine("[parent] FAIL: the seat never reported an HTTP port.");
                return 1;
            }

            Console.WriteLine($"[parent] seat http port={httpPort}");

            // 3. Explicitly request setup on the seat, then resolve its TLS port as the secure redirect does.
            var requested = await HeadlessClientManager.RequestSecureOriginAsync(
                httpPort.Value, CancellationToken.None);
            if (!requested)
            {
                Console.WriteLine("[parent] FAIL: the seat refused the loopback secure-setup request.");
                return 1;
            }

            var securePort = await HeadlessClientManager.TryResolveSecurePortAsync(
                httpPort.Value, TimeSpan.FromSeconds(15), CancellationToken.None);

            if (securePort is null)
            {
                Console.WriteLine("[parent] FAIL: the seat published no secure port — a TLS join would fail closed here.");
                return 1;
            }

            if (securePort != httpPort)
            {
                Console.WriteLine($"[parent] FAIL: seat TLS port {securePort} differs from HTTP port {httpPort}.");
                return 1;
            }

            Console.WriteLine($"[parent] PASS: a seat process enabled TLS on its HTTP port {securePort} "
                + $"from the handed-down cache (no fetch of its own), and the host resolved it over /secure-port.");
            return 0;
        }
        finally
        {
            try { if (!child.HasExited) child.Kill(entireProcessTree: true); } catch { }
            try { Directory.Delete(cacheRoot, recursive: true); } catch { }
            try { Directory.Delete(slotHome, recursive: true); } catch { }
        }
    }

    private static async Task<int> RunChildAsync()
    {
        // Do not touch the cache at startup. The loopback setup route below loads it only when the host asks.
        var cacheRoot = Environment.GetEnvironmentVariable(SecureOriginCertificates.CacheRootEnvironmentVariable);
        SecureOriginCertificates? certificates = null;
        CouchCoopBrowserServer? server = null;
        var requestStarted = 0;

        async Task EnableSecureOriginAsync()
        {
            if (Interlocked.Exchange(ref requestStarted, 1) != 0) return;
            var setup = new SecureOriginCertificates(
                provider: Environment.GetEnvironmentVariable(ChildNoFetchVariable) == "1"
                    ? new RefusingProvider()
                    : null,
                cacheRoot: cacheRoot,
                log: message => Console.WriteLine($"[seat] {message}"));
            certificates = setup;
            await setup.StartAsync();
            if (!setup.Status.IsReady)
            {
                Console.WriteLine($"[seat] FAIL: no certificate from the handed-down cache ({setup.Status.Reason}).");
                return;
            }

            if (server?.TryStartSecureListener(setup.Certificate, setup.Intermediates) != true)
            {
                Console.WriteLine("[seat] FAIL: the secure listener did not start.");
            }
        }

        var browserServer = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(Path.Combine(Path.GetTempPath(), "couchcoop-harness-static")),
            new NoAssets(),
            bindAddress: IPAddress.Loopback,
            preferredPort: 13500,
            isHeadlessClient: true,
            requestSecureOrigin: () => _ = Task.Run(EnableSecureOriginAsync),
            log: _ => { });
        server = browserServer;

        var baseUri = await browserServer.StartAsync();

        Console.WriteLine($"SEAT-HTTP {baseUri.Port}");
        Console.Out.Flush();

        await Task.Delay(TimeSpan.FromSeconds(60));
        certificates?.Dispose();
        await browserServer.DisposeAsync();
        return 0;
    }

    private static async Task<int?> ReadSeatPortAsync(Process child, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var line = await child.StandardOutput.ReadLineAsync();
            if (line is null)
            {
                return null;
            }

            Console.WriteLine($"[seat] {line}");
            if (line.StartsWith("SEAT-HTTP ", StringComparison.Ordinal)
                && int.TryParse(line["SEAT-HTTP ".Length..].Trim(), out var port))
            {
                return port;
            }
        }

        return null;
    }

    // Fails every fetch, so the child can only succeed via the shared cache.
    private sealed class RefusingProvider : ISecureOriginCertificateProvider
    {
        public string Id => "harness-refusing";

        public string Domain => "my.local-ip.co";

        public Task<SecureCertificateBundle?> FetchAsync(HttpClient http, CancellationToken cancellationToken)
        {
            Console.WriteLine("[seat] fetch attempted — the handed-down cache did NOT satisfy this seat.");
            return Task.FromResult<SecureCertificateBundle?>(null);
        }
    }

    private sealed class NoAssets : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
            string opaqueKey,
            CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new CouchCoopAssetHttpResponse(null, null, new Dictionary<string, string>(), null));
    }
}
