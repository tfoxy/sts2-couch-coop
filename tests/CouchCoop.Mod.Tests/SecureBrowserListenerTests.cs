using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Contracts;

// WS6a: the TLS listener, over a real loopback socket and a real handshake.
//
// This is deliberately an integration test rather than a mock: the whole change is "wrap the accepted
// stream in SslStream and hand it to the same handler", and the only failure modes worth catching are the
// ones a mock would paper over — a handler still typed on NetworkStream, a certificate the platform will
// not serve with, a listener that does not port-walk, and a bad client that kills the accept loop.
//
// It self-signs its own certificate; nothing here touches the network or the real provider.
internal static class SecureBrowserListenerTests
{
    public static void RunAsync() => RunAsyncCore().GetAwaiter().GetResult();

    private static async Task RunAsyncCore()
    {
        await ServesAHandlerOverTls();
        await PortWalksPastAnOccupiedPort();
        await RefusesToStartWithoutACertificate();
        await ABadHandshakeDoesNotKillTheListener();
        await StalledHandshakeTimesOutAndReleasesAdmission();
        MaterialisesAPemBundleAndRejectsAMismatch();

        Console.WriteLine("SecureBrowserListenerTests: ok");
    }

    private static async Task StalledHandshakeTimesOutAndReleasesAdmission()
    {
        using var certificate = SelfSigned("localhost");
        var limiter = new NetworkAdmissionLimiter();
        var handled = 0;
        await using var listener = new SecureBrowserListener(
            IPAddress.Loopback,
            (_, _, _) => { Interlocked.Increment(ref handled); return Task.CompletedTask; },
            _ => { },
            limiter,
            TimeSpan.FromMilliseconds(100));
        Expect(listener.TryStart(certificate, PickFreePort()), "short-timeout TLS listener starts");

        using (var stalled = new TcpClient())
        {
            await stalled.ConnectAsync(IPAddress.Loopback, listener.Port);
            var one = new byte[1];
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var read = await stalled.GetStream().ReadAsync(one, deadline.Token);
            Expect(read == 0, "a client that sends no ClientHello is closed at the handshake deadline");
        }

        Expect(Volatile.Read(ref handled) == 0, "a timed-out handshake never reaches HTTP handling");
        var recoveredSlots = Enumerable.Range(0, NetworkAdmissionLimiter.MaxHttpConnectionsPerAddress)
            .Select(_ => limiter.TryAcquireHttp(IPAddress.Loopback)).ToArray();
        Expect(recoveredSlots.All(lease => lease is not null), "a timed-out handshake releases every occupied admission slot");
        foreach (var lease in recoveredSlots) lease?.Dispose();
        var received = await ReadOverTlsAsync(listener.Port);
        Expect(received == string.Empty, "the released admission slot accepts the next valid TLS connection");
        Expect(Volatile.Read(ref handled) == 1, "the valid client reaches the handler exactly once");
    }

    // The headline: the handler receives a decrypted Stream and its bytes reach a real TLS client.
    private static async Task ServesAHandlerOverTls()
    {
        using var certificate = SelfSigned("localhost");
        const string body = "couch-coop-over-tls";

        await using var listener = new SecureBrowserListener(
            IPAddress.Loopback,
            async (_, stream, token) =>
            {
                var bytes = Encoding.UTF8.GetBytes(body);
                await stream.WriteAsync(bytes, token);
                await stream.FlushAsync(token);
            },
            _ => { });

        Expect(listener.TryStart(certificate, PickFreePort()), "the secure listener starts with a certificate");
        Expect(listener.Port > 0, "and reports the port it actually bound");

        var received = await ReadOverTlsAsync(listener.Port);
        Expect(received == body, $"the handler's bytes arrive over TLS (got '{received}')");
    }

    // The secure listener port-walks exactly like the HTTP one, which is why callers must advertise
    // listener.Port and never "preferred + offset".
    private static async Task PortWalksPastAnOccupiedPort()
    {
        using var certificate = SelfSigned("localhost");

        var blocker = new TcpListener(IPAddress.Loopback, 0);
        blocker.Start();
        var occupied = ((IPEndPoint)blocker.LocalEndpoint).Port;

        try
        {
            await using var listener = new SecureBrowserListener(IPAddress.Loopback, (_, _, _) => Task.CompletedTask, _ => { });
            Expect(listener.TryStart(certificate, occupied), "it starts even though the preferred port is taken");
            Expect(listener.Port > occupied, $"by walking upward (preferred {occupied}, bound {listener.Port})");
        }
        finally
        {
            blocker.Stop();
        }
    }

    // No certificate is the ordinary offline state, not an error: the listener declines and the caller
    // simply never offers the secure origin. It must not throw and must not bind.
    private static async Task RefusesToStartWithoutACertificate()
    {
        await using var listener = new SecureBrowserListener(IPAddress.Loopback, (_, _, _) => Task.CompletedTask, _ => { });

        Expect(!listener.TryStart(null, PickFreePort()), "no certificate means no secure listener");
        Expect(!listener.IsRunning, "and nothing is bound");
        Expect(listener.Port == 0, "and no port is advertised");
    }

    // A plain-HTTP request aimed at the TLS port is the single most likely bad client (someone typing the
    // secure port with http://). It must cost that one socket and nothing else.
    private static async Task ABadHandshakeDoesNotKillTheListener()
    {
        using var certificate = SelfSigned("localhost");
        const string body = "still-alive";

        await using var listener = new SecureBrowserListener(
            IPAddress.Loopback,
            async (_, stream, token) =>
            {
                await stream.WriteAsync(Encoding.UTF8.GetBytes(body), token);
                await stream.FlushAsync(token);
            },
            _ => { });

        Expect(listener.TryStart(certificate, PickFreePort()), "the listener starts");

        // Garbage that is not a TLS ClientHello.
        using (var rude = new TcpClient())
        {
            await rude.ConnectAsync(IPAddress.Loopback, listener.Port);
            await rude.GetStream().WriteAsync(Encoding.UTF8.GetBytes("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
            await rude.GetStream().FlushAsync();
        }

        var received = await ReadOverTlsAsync(listener.Port);
        Expect(received == body, "a well-formed client is still served after a failed handshake");
    }

    // The PEM -> server-usable certificate step, including the mismatch that a rotated provider produces.
    private static void MaterialisesAPemBundleAndRejectsAMismatch()
    {
        using var source = SelfSigned("example.test");
        var certificatePem = source.ExportCertificatePem();
        var keyPem = source.GetRSAPrivateKey()!.ExportPkcs8PrivateKeyPem();

        var good = new SecureCertificateBundle(certificatePem, keyPem, null);
        Expect(SecureOriginCertificates.TryMaterialise(good, out var materialised, out _, out var reason),
            $"a matching leaf and key materialise (reason={reason})");
        Expect(materialised is not null, "producing a certificate");
        Expect(materialised!.HasPrivateKey, "with its private key attached, which SslStream requires");
        materialised.Dispose();

        // A key that belongs to a DIFFERENT certificate is exactly what a half-rotated provider serves.
        using var other = SelfSigned("other.test");
        var mismatched = new SecureCertificateBundle(certificatePem, other.GetRSAPrivateKey()!.ExportPkcs8PrivateKeyPem(), null);
        Expect(!SecureOriginCertificates.TryMaterialise(mismatched, out _, out _, out var failure),
            "a key that does not match the leaf is refused");
        Expect(failure.HasValue && !string.IsNullOrWhiteSpace(failure.GetValueOrDefault().Resolve()), "with a one-line reason for the dialog");
    }

    // ---- helpers ---------------------------------------------------------------------------------------

    private static async Task<string> ReadOverTlsAsync(int port)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, port);
        using var tls = new SslStream(
            client.GetStream(),
            leaveInnerStreamOpen: false,
            // The certificate is self-signed here, so trust is asserted by the test rather than by a CA.
            userCertificateValidationCallback: (_, _, _, _) => true);

        await tls.AuthenticateAsClientAsync("localhost");

        var buffer = new byte[256];
        var read = await tls.ReadAsync(buffer);
        return Encoding.UTF8.GetString(buffer, 0, read);
    }

    private static X509Certificate2 SelfSigned(string commonName)
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest($"CN={commonName}", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var subjectAlternativeName = new SubjectAlternativeNameBuilder();
        subjectAlternativeName.AddDnsName(commonName);
        request.CertificateExtensions.Add(subjectAlternativeName.Build());

        var certificate = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddDays(-1),
            DateTimeOffset.UtcNow.AddDays(1));

        // Same PKCS#12 round-trip the production path uses: an ephemeral key cannot be used for server
        // authentication on every platform, so the test must exercise the persistable form.
        return X509CertificateLoader.LoadPkcs12(
            certificate.Export(X509ContentType.Pkcs12),
            password: null,
            keyStorageFlags: X509KeyStorageFlags.Exportable);
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
            throw new InvalidOperationException($"SecureBrowserListenerTests failed: {because}");
        }
    }
}
