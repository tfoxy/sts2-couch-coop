using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using CouchCoop.Mod.Server;

// WS6 live harness. The unit suites prove the pure decisions and the TLS plumbing against a SELF-SIGNED
// certificate, which is exactly the part a test can own. What no unit test can stand in for is the claim
// this whole feature rests on: that a third-party published-private-key provider is CURRENTLY alive, that
// its certificate is unrevoked and browser-trusted, and that its DNS wildcard really maps a dashed quad
// back to the address we bind.
//
//   dotnet run --project tests/CouchCoop.Mod.Tests -- secure-origin-harness
//
// It fetches the real bundle, starts the real listener on loopback, and then connects to
// `127-0-0-1.<provider>` and validates the handshake against the SYSTEM TRUST STORE with real hostname
// verification — i.e. the same judgement a phone's browser makes. Requires internet; prints a verdict and
// exits non-zero on failure, so it can be run as a pre-release check when the provider inevitably rotates.
internal static class SecureOriginHarness
{
    public const string Verb = "secure-origin-harness";

    public static async Task<int> RunAsync(string[] args)
    {
        var provider = new LocalIpCoCertificateProvider();
        Console.WriteLine($"[harness] provider={provider.Id} domain={provider.Domain}");

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        var bundle = await provider.FetchAsync(http, CancellationToken.None);
        if (bundle is null)
        {
            Console.WriteLine("[harness] FAIL: the provider served no bundle (offline, or the service is down).");
            return 1;
        }

        Console.WriteLine($"[harness] fetched certificate={bundle.CertificatePem.Length}B key={bundle.PrivateKeyPem.Length}B "
            + $"intermediates={(bundle.IntermediatesPem?.Length.ToString() ?? "<none>")}");

        if (!SecureOriginCertificates.TryMaterialise(bundle, out var certificate, out var intermediates, out var failure))
        {
            Console.WriteLine($"[harness] FAIL: {failure}");
            return 1;
        }

        using (certificate)
        {
            Console.WriteLine($"[harness] subject={certificate!.Subject} issuer={certificate.Issuer}");
            Console.WriteLine($"[harness] valid={certificate.NotBefore:yyyy-MM-dd} .. {certificate.NotAfter:yyyy-MM-dd} "
                + $"intermediates={intermediates.Count}");

            // This machine's real advertised LAN IPv4 — the same one the QR would use. Loopback is
            // deliberately NOT usable here: SecureOriginHost refuses it (a phone can never reach it), so the
            // harness has to bind the address a phone would actually dial, which makes this a truer test.
            var advertised = CouchCoop.Mod.HostUi.LanAddressRanking
                .Best(CouchCoop.Mod.HostUi.LanAddressRanking.GatherFromOs())?.Address;
            var hostName = SecureOriginHost.ToHostName(advertised, provider.Domain);
            if (hostName is null)
            {
                Console.WriteLine($"[harness] SKIP: no routable LAN IPv4 on this machine (best={advertised?.ToString() ?? "<none>"}).");
                return 0;
            }

            Console.WriteLine($"[harness] advertised={advertised} host={hostName}");

            try
            {
                var resolved = await Dns.GetHostAddressesAsync(hostName);
                Console.WriteLine($"[harness] dns {hostName} -> {string.Join(", ", resolved.Select(a => a.ToString()))}");
            }
            catch (SocketException exception)
            {
                Console.WriteLine($"[harness] FAIL: {hostName} did not resolve ({exception.SocketErrorCode}).");
                return 1;
            }

            const string body = "couch-coop-secure-origin";
            await using var listener = new SecureBrowserListener(
                advertised!,
                async (_, stream, token) =>
                {
                    await stream.WriteAsync(Encoding.UTF8.GetBytes(body), token);
                    await stream.FlushAsync(token);
                },
                Console.WriteLine);

            if (!listener.TryStart(certificate, 13338, intermediates))
            {
                Console.WriteLine("[harness] FAIL: the secure listener did not start.");
                return 1;
            }

            Console.WriteLine($"[harness] listening port={listener.Port}");

            try
            {
                using var client = new TcpClient();
                // Dial the PUBLIC NAME, not the address: this is what exercises the provider's DNS wildcard
                // and the certificate's hostname match together, which is the pair a phone depends on.
                await client.ConnectAsync(hostName, listener.Port);

                // No validation callback: this is the whole point. The default policy checks the chain against
                // the machine's trust store AND verifies the hostname, exactly as a browser would.
                using var tls = new SslStream(client.GetStream(), leaveInnerStreamOpen: false);
                await tls.AuthenticateAsClientAsync(hostName);

                var buffer = new byte[256];
                var read = await tls.ReadAsync(buffer);
                var received = Encoding.UTF8.GetString(buffer, 0, read);

                if (received != body)
                {
                    Console.WriteLine($"[harness] FAIL: unexpected payload '{received}'.");
                    return 1;
                }

                Console.WriteLine($"[harness] PASS: publicly-trusted TLS to https://{hostName}:{listener.Port}/ "
                    + $"negotiated {tls.SslProtocol} and served the payload.");
                return 0;
            }
            catch (Exception exception)
            {
                Console.WriteLine($"[harness] FAIL: {exception.GetType().Name}: {exception.Message}");
                return 1;
            }
        }
    }
}
