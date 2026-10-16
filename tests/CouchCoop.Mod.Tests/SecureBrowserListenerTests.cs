using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Contracts;

// Real loopback integration coverage for HTTP and HTTPS sharing one raw TcpListener.
internal static class SecureBrowserListenerTests
{
    public static void RunAsync() => RunAsyncCore().GetAwaiter().GetResult();

    private static async Task RunAsyncCore()
    {
        await HttpWorksBeforeAndAfterCertificate();
        await TlsWorksOnTheHttpPortAndReleasesAdmission();
        await StalledPrefaceTimesOut();
        await BadTlsHandshakeDoesNotKillTheListener();
        MaterialisesAPemBundleAndRejectsAMismatch();
        await DirectIpIdentitySelectionAndTrust();
        await ReplacementKeepsAnEstablishedConnection();
        await RenewalCannotUndoDisable();
        await StalledRenewalObeysHandshakeDeadline();
        await SeatsRevalidateEvenBeforeRenewalWindow();
        HotGenerationSharesTlsContracts();
        Console.WriteLine("SecureBrowserListenerTests: ok");
    }

    private static async Task HttpWorksBeforeAndAfterCertificate()
    {
        using var certificate = SelfSigned("localhost");
        await using var server = new SharedPortServer();
        Expect(!server.Transport.TryEnable(null), "no certificate leaves TLS unavailable");
        Expect(!server.Transport.IsRunning, "TLS is unavailable before a certificate");
        Expect(await ReadPlainAsync(server.Port) == "plain", "plain HTTP works without a certificate");
        Expect(server.Transport.TryEnable(certificate), "TLS can be enabled after the TCP listener starts");
        Expect(await ReadPlainAsync(server.Port) == "plain", "plain HTTP still works after TLS is enabled");
        Expect(await ReadTlsAsync(server.Port) == "secure", "HTTPS uses that same TCP port");
        Expect(server.PlainCount == 2 && server.SecureCount == 1, "each protocol reaches only its handler");
    }

    private static async Task TlsWorksOnTheHttpPortAndReleasesAdmission()
    {
        using var certificate = SelfSigned("localhost");
        var limiter = new NetworkAdmissionLimiter();
        await using var server = new SharedPortServer(limiter);
        Expect(server.Transport.TryEnable(certificate), "TLS enabled");
        Expect(await ReadTlsAsync(server.Port) == "secure", "the TLS handler receives decrypted bytes");
        var leases = Enumerable.Range(0, NetworkAdmissionLimiter.MaxHttpConnectionsPerAddress)
            .Select(_ => limiter.TryAcquireHttp(IPAddress.Loopback)).ToArray();
        Expect(leases.All(lease => lease is not null), "completed TLS handshake releases every admission slot");
        foreach (var lease in leases) lease?.Dispose();
    }

    private static async Task StalledPrefaceTimesOut()
    {
        await using var server = new SharedPortServer(timeout: TimeSpan.FromMilliseconds(100));
        using var stalled = new TcpClient();
        await stalled.ConnectAsync(IPAddress.Loopback, server.Port);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var read = await stalled.GetStream().ReadAsync(new byte[1], deadline.Token);
        Expect(read == 0, "a client that sends no first byte closes at the bounded peek deadline");
        Expect(await ReadPlainAsync(server.Port) == "plain", "a stalled connection does not block the listener");
    }

    private static async Task BadTlsHandshakeDoesNotKillTheListener()
    {
        using var certificate = SelfSigned("localhost");
        await using var server = new SharedPortServer();
        Expect(server.Transport.TryEnable(certificate), "TLS enabled");
        using (var malformed = new TcpClient())
        {
            await malformed.ConnectAsync(IPAddress.Loopback, server.Port);
            await malformed.GetStream().WriteAsync(new byte[] { 0x16, 0x00, 0x00, 0x00 });
        }
        Expect(await ReadTlsAsync(server.Port) == "secure", "a later TLS handshake still succeeds");
        Expect(await ReadPlainAsync(server.Port) == "plain", "plain HTTP remains available");
    }

    private sealed class SharedPortServer : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly NetworkAdmissionLimiter _admission;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _acceptLoop;
        private int _plainCount;
        private int _secureCount;
        private int _disposed;

        public SharedPortServer(NetworkAdmissionLimiter? admission = null, TimeSpan? timeout = null)
        {
            _admission = admission ?? new NetworkAdmissionLimiter();
            Transport = new SecureBrowserListener(_ => { }, timeout);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _acceptLoop = AcceptAsync();
        }

        public SecureBrowserListener Transport { get; }
        public int Port { get; }
        public Func<Task>? BeforeSecureResponse { get; set; }
        public int PlainCount => Volatile.Read(ref _plainCount);
        public int SecureCount => Volatile.Read(ref _secureCount);

        private async Task AcceptAsync()
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(_stop.Token); }
                catch (OperationCanceledException) { break; }
                catch (ObjectDisposedException) { break; }
                var lease = _admission.TryAcquireHttp(IPAddress.Loopback);
                if (lease is null) { client.Dispose(); continue; }
                _admission.AttachHttp(client, lease);
                _ = Task.Run(() => Transport.ClassifyAndServeAsync(client, _admission, PlainAsync, SecureAsync, _stop.Token));
            }
        }

        private async Task PlainAsync(TcpClient client, CancellationToken token)
        {
            Interlocked.Increment(ref _plainCount);
            using var stream = client.GetStream();
            var buffer = new byte[128];
            _ = await stream.ReadAsync(buffer, token);
            await stream.WriteAsync(Encoding.UTF8.GetBytes("plain"), token);
        }

        private async Task SecureAsync(TcpClient client, Stream stream, CancellationToken token)
        {
            Interlocked.Increment(ref _secureCount);
            if (BeforeSecureResponse is { } wait) await wait();
            await stream.WriteAsync(Encoding.UTF8.GetBytes("secure"), token);
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            _stop.Cancel();
            _listener.Stop();
            await _acceptLoop;
            _stop.Dispose();
            Transport.Disable();
        }
    }

    private static async Task<string> ReadPlainAsync(int port)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, port);
        using var stream = client.GetStream();
        await stream.WriteAsync(Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"));
        var buffer = new byte[128];
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var count = await stream.ReadAsync(buffer, deadline.Token);
        return Encoding.UTF8.GetString(buffer, 0, count);
    }

    private static async Task<string> ReadTlsAsync(int port)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, port);
        using var tls = new SslStream(client.GetStream(), false, (_, _, _, _) => true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await tls.AuthenticateAsClientAsync("localhost", null, System.Security.Authentication.SslProtocols.None, false);
        var buffer = new byte[128];
        var count = await tls.ReadAsync(buffer, deadline.Token);
        return Encoding.UTF8.GetString(buffer, 0, count);
    }

    private static void MaterialisesAPemBundleAndRejectsAMismatch()
    {
        using var source = SelfSigned("example.test");
        var certificatePem = source.ExportCertificatePem();
        var keyPem = source.GetRSAPrivateKey()!.ExportPkcs8PrivateKeyPem();
        var good = new SecureCertificateBundle(certificatePem, keyPem, null);
        Expect(SecureOriginCertificates.TryMaterialise(good, out var materialised, out _, out var reason),
            $"a matching leaf and key materialise (reason={reason})");
        Expect(materialised!.HasPrivateKey, "with its private key attached");
        materialised.Dispose();
        using var other = SelfSigned("other.test");
        var mismatched = new SecureCertificateBundle(certificatePem, other.GetRSAPrivateKey()!.ExportPkcs8PrivateKeyPem(), null);
        Expect(!SecureOriginCertificates.TryMaterialise(mismatched, out _, out _, out var failure),
            "a mismatched key is refused");
        Expect(failure.HasValue && !string.IsNullOrWhiteSpace(failure.GetValueOrDefault().Resolve()), "with a reason");
    }

    private static X509Certificate2 SelfSigned(string commonName)
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest($"CN={commonName}", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var subjectAlternativeName = new SubjectAlternativeNameBuilder();
        subjectAlternativeName.AddDnsName(commonName);
        request.CertificateExtensions.Add(subjectAlternativeName.Build());
        var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        return X509CertificateLoader.LoadPkcs12(certificate.Export(X509ContentType.Pkcs12), null, X509KeyStorageFlags.Exportable);
    }

    private static async Task DirectIpIdentitySelectionAndTrust()
    {
        using var material = IpMaterial(IPAddress.Loopback);
        using var hostname = SelfSigned("localhost");
        await using var server = new SharedPortServer();
        Expect(server.Transport.TryEnableDirectIp(material), "IP identity is enabled independently");
        Expect(server.Transport.IsDirectIpRunning && !server.Transport.IsHostnameRunning, "IP readiness never implies hostname readiness");
        Expect(await ReadStrictAsync(server.Port, "127.0.0.1", material.PublicRoot) == "secure", "IP SAN and installed root validate without a bypass (IP sends no SNI)");
        Expect(server.Transport.TryEnable(hostname), "hostname can be enabled after IP TLS");
        Expect(await ReadStrictAsync(server.Port, "localhost", hostname) == "secure", "matching hostname SNI chooses hostname identity");
        var refreshes = 0;
        server.Transport.DirectIpCertificateRefresh = (_, _) => { refreshes++; return Task.FromResult<DirectIpCertificateMaterial?>(IpMaterial(IPAddress.Loopback)); };
        await ExpectTlsRejected(server.Port, "unknown.test", material.PublicRoot);
        Expect(refreshes == 0, "unknown SNI cannot cause certificate issuance");
        server.Transport.DirectIpCertificateRefresh = null;
        await ExpectTlsRejected(server.Port, "127.0.0.2", material.PublicRoot);
        await ExpectTlsRejected(server.Port, "127.0.0.1", hostname);
        server.Transport.DisableDirectIp();
        Expect(!server.Transport.IsDirectIpRunning && server.Transport.IsHostnameRunning, "disabling IP preserves hostname readiness");
        await ExpectTlsRejected(server.Port, "127.0.0.1", material.PublicRoot);
        Expect(await ReadStrictAsync(server.Port, "localhost", hostname) == "secure", "hostname survives IP disable");
        Expect(await ReadPlainAsync(server.Port) == "plain", "HTTP remains available");
        using var wrongIp = IpMaterial(IPAddress.Parse("127.0.0.2"));
        Expect(server.Transport.TryEnableDirectIp(wrongIp), "other address material installs");
        await ExpectTlsRejected(server.Port, "127.0.0.1", wrongIp.PublicRoot);
        using var expired = IpMaterial(IPAddress.Loopback, expired: true);
        Expect(!server.Transport.TryEnableDirectIp(expired), "expired leaf is refused");
    }

    private static async Task ReplacementKeepsAnEstablishedConnection()
    {
        var original = IpMaterial(IPAddress.Loopback);
        using var originalRoot = X509CertificateLoader.LoadCertificate(original.PublicRoot.RawData);
        await using var server = new SharedPortServer();
        Expect(server.Transport.TryEnableDirectIp(original), "initial IP identity installed");
        original.Dispose(); // Transport must own its copies.
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        server.BeforeSecureResponse = () => { entered.TrySetResult(); return release.Task; };
        var pending = ReadStrictAsync(server.Port, "127.0.0.1", originalRoot);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var replacement = IpMaterial(IPAddress.Loopback);
        Expect(server.Transport.TryEnableDirectIp(replacement), "replacement installs atomically");
        release.TrySetResult();
        Expect(await pending == "secure", "connection authenticated with retired material completes");
        server.BeforeSecureResponse = null;
        Expect(await ReadStrictAsync(server.Port, "127.0.0.1", replacement.PublicRoot) == "secure", "new connections use replacement");
        await ExpectTlsRejected(server.Port, "127.0.0.1", originalRoot);
    }

    private static async Task RenewalCannotUndoDisable()
    {
        using var material = IpMaterial(IPAddress.Loopback);
        await using var server = new SharedPortServer();
        server.Transport.TryEnableDirectIp(material);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        server.Transport.DirectIpCertificateRefresh = async (_, token) =>
        {
            entered.TrySetResult();
            await release.Task.WaitAsync(token);
            return IpMaterial(IPAddress.Loopback);
        };
        var rejected = ExpectTlsRejected(server.Port, "127.0.0.1", material.PublicRoot);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        server.Transport.DisableDirectIp();
        release.TrySetResult();
        await rejected;
        Expect(!server.Transport.IsDirectIpRunning, "a delayed refresh cannot re-enable disabled TLS");
    }

    private static async Task StalledRenewalObeysHandshakeDeadline()
    {
        using var original = IpMaterial(IPAddress.Loopback);
        using var late = IpMaterial(IPAddress.Loopback);
        await using var server = new SharedPortServer(timeout: TimeSpan.FromMilliseconds(100));
        server.Transport.TryEnableDirectIp(original);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // Deliberately ignores cancellation, as a blocked native storage operation can do.
        var release = new TaskCompletionSource<DirectIpCertificateMaterial?>();
        server.Transport.DirectIpCertificateRefresh = (_, _) => { entered.TrySetResult(); return release.Task; };
        var rejected = ExpectTlsRejected(server.Port, "127.0.0.1", original.PublicRoot);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            await rejected.WaitAsync(TimeSpan.FromSeconds(1));
            Expect(await ReadPlainAsync(server.Port) == "plain", "stalled renewal does not block other sockets");
            await server.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(1));
        }
        finally
        {
            release.TrySetResult(late);
            try { await rejected; } catch { }
        }
        Expect(late.Certificate.Handle == IntPtr.Zero && late.PublicRoot.Handle == IntPtr.Zero,
            "late caller-owned renewal material is disposed after the cancelled wait");
        Expect(!server.Transport.IsDirectIpRunning, "late renewal cannot republish a disabled identity");
    }

    private static async Task SeatsRevalidateEvenBeforeRenewalWindow()
    {
        using var material = IpMaterial(IPAddress.Loopback, leafDays: 60);
        await using var server = new SharedPortServer();
        server.Transport.TryEnableDirectIp(material);
        var refreshes = 0;
        server.Transport.DirectIpCertificateRefresh = (_, _) =>
        {
            refreshes++;
            return Task.FromResult<DirectIpCertificateMaterial?>(null);
        };
        Expect(await ReadStrictAsync(server.Port, "127.0.0.1", material.PublicRoot) == "secure" && refreshes == 0,
            "host avoids disk or issuance work while its certificate remains fresh");
        server.Transport.DirectIpRefreshOnEveryHandshake = true;
        await ExpectTlsRejected(server.Port, "127.0.0.1", material.PublicRoot);
        Expect(refreshes == 1, "a seat notices removed authorization before leaf expiry");
    }

    private static void HotGenerationSharesTlsContracts()
    {
        var assembly = System.Reflection.Assembly.LoadFrom(Path.Combine(AppContext.BaseDirectory, "CouchCoop.Mod.HotReload.dll"));
        var generation = assembly.GetType("CouchCoop.Mod.HotReload.CouchCoopHotServerGeneration", throwOnError: true)!;
        Expect(typeof(ICouchCoopAddressedStreamGeneration).IsAssignableFrom(generation),
            "hot-reloaded TLS retains stream contract identity and peer address");
        Expect(typeof(IHotDirectIpHttpsHost).IsAssignableFrom(typeof(HotReloadableBrowserServerHost)),
            "host exposes shared BCL-only direct-IP capability across generation boundaries");
    }

    private static async Task<string> ReadStrictAsync(int port, string target, X509Certificate2 root)
    {
        using var client = new TcpClient();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await client.ConnectAsync(IPAddress.Loopback, port, deadline.Token);
        using var tls = new SslStream(client.GetStream(), false);
        var policy = new X509ChainPolicy { TrustMode = X509ChainTrustMode.CustomRootTrust, RevocationMode = X509RevocationMode.NoCheck };
        policy.CustomTrustStore.Add(root);
        await tls.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
        { TargetHost = target, CertificateChainPolicy = policy }, deadline.Token);
        var buffer = new byte[128];
        var count = await tls.ReadAsync(buffer, deadline.Token);
        return Encoding.UTF8.GetString(buffer, 0, count);
    }

    private static async Task ExpectTlsRejected(int port, string target, X509Certificate2 root)
    {
        try { await ReadStrictAsync(port, target, root); }
        catch (Exception exception) when (exception is System.Security.Authentication.AuthenticationException or IOException) { return; }
        throw new InvalidOperationException($"TLS unexpectedly accepted {target}");
    }

    private static DirectIpCertificateMaterial IpMaterial(IPAddress address, bool expired = false, int leafDays = 1)
    {
        using var rootKey = RSA.Create(2048);
        var rootRequest = new CertificateRequest("CN=Transport test CA", rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        rootRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        using var root = rootRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-10), DateTimeOffset.UtcNow.AddDays(100));
        using var leafKey = RSA.Create(2048);
        var leafRequest = new CertificateRequest("CN=Transport IP test", leafKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder(); san.AddIpAddress(address);
        leafRequest.CertificateExtensions.Add(san.Build());
        leafRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        leafRequest.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, true));
        using var publicLeaf = leafRequest.Create(root, DateTimeOffset.UtcNow.AddDays(-2),
            DateTimeOffset.UtcNow.AddDays(expired ? -1 : leafDays), RandomNumberGenerator.GetBytes(16));
        return new DirectIpCertificateMaterial(publicLeaf.CopyWithPrivateKey(leafKey), X509CertificateLoader.LoadCertificate(root.RawData), [address]);
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"SecureBrowserListenerTests failed: {because}");
    }
}
