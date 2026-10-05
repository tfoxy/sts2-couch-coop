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
            await stream.WriteAsync(Encoding.UTF8.GetBytes("secure"), token);
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            _listener.Stop();
            await _acceptLoop;
            _stop.Dispose();
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

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"SecureBrowserListenerTests failed: {because}");
    }
}
