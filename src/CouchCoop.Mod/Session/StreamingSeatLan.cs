using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Streaming the new renderer to the host's LAN pages (CAR7b): the streaming seat's render-stream hub serves the host's
/// own LAN pages, not only its loopback page. Always on, as the host's browser server and seat relays are.
/// </summary>
/// <remarks>
/// <para>
/// The seat is launched with godot-scene-web's LAN exposure (carrier-design.md D10): <c>GRC_LIVE_EXPOSE=lan</c>, the
/// hub on <c>0.0.0.0</c> (the interfaces the browser server serves), token auth (always on), and an origin allow-list
/// extended with the host's own LAN page origins (<see cref="PageOrigins"/>). The hub runs only while a viewer has
/// asked for the new renderer.
/// </para>
/// <para>
/// CARRIERS ON THE LAN. WebTransport (with the net module) uses the capture's self-signed certificate, pinned by
/// hash, so it works from any secure-context page whatever its host name. wss needs a certificate the browser
/// already trusts and that names the page's host: the host's Direct-IP HTTPS leaf (IP SANs; preferred, because the
/// operator set it up and its devices trust its CA) or else the secure-origin certificate (the published wildcard for
/// <c>&lt;dashed ip&gt;.&lt;domain&gt;</c>). Its PEM pair is written into the seat's private evidence directory (mode
/// 0600 on Unix) as <c>GRC_LIVE_TLS_CERT</c>/<c>KEY</c>; the key is never logged. Plain ws is served to LAN peers
/// either way (with a pair through <c>GRC_LIVE_LAN_PLAINTEXT=allow</c>), so the host's plain-http LAN page streams
/// over ws, as its own socket to the host already does, with no certificate the device must trust.
/// </para>
/// <para>
/// NOT THE PUBLIC WEBSITE ORIGIN. The pages.dev bootstrap page is served on the default https port, so its Origin
/// carries no port, and the capture's allow-list accepts only exact <c>scheme://host:port</c> entries. That page is
/// therefore never allowed, and also sits behind Chrome's Local Network Access checks (see docs/security.md).
/// </para>
/// </remarks>
internal static class StreamingSeatLan
{
    /// <summary>The PEM pair's file names in the seat's private evidence directory.</summary>
    internal const string CertificateFileName = "tls-cert.pem";
    internal const string KeyFileName = "tls-key.pem";

    /// <summary>Which certificate wss uses: <c>direct-ip</c>, <c>secure-origin</c>, or none.</summary>
    internal sealed record TlsPair(string Kind, string CertificatePem, string KeyPem);

    /// <summary>What the host knows about its own LAN pages when it launches the seat.</summary>
    /// <param name="Addresses">The eligible LAN IPv4 addresses (the QR dialog's set).</param>
    /// <param name="MdnsHost">The <c>&lt;machine&gt;.local</c> name the mod publishes, lower case, or null.</param>
    /// <param name="SecureOriginDomain">The secure-origin wildcard's domain, when its certificate is cached and valid.</param>
    internal sealed record Context(
        IReadOnlyList<IPAddress> Addresses, string? MdnsHost, string? SecureOriginDomain, TlsPair? Tls);

    /// <summary>
    /// The host's LAN page origins the hub must accept: <c>http</c> and <c>https</c> on every LAN address and on the
    /// mDNS name (Direct-IP HTTPS shares the browser port), and <c>https</c> on each secure-origin host name. Each in
    /// the exact form a browser serialises (lower case, explicit port).
    /// </summary>
    internal static IReadOnlyList<string> PageOrigins(Context context, int hostBrowserPort)
    {
        ArgumentNullException.ThrowIfNull(context);
        var port = hostBrowserPort.ToString(CultureInfo.InvariantCulture);
        var origins = new List<string>();
        void Add(string origin)
        {
            if (!origins.Contains(origin, StringComparer.Ordinal)) origins.Add(origin);
        }

        foreach (var address in context.Addresses)
        {
            if (address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork || IPAddress.IsLoopback(address)) continue;
            Add($"http://{address}:{port}");
            Add($"https://{address}:{port}");
        }

        if (!string.IsNullOrWhiteSpace(context.MdnsHost))
        {
            var mdns = context.MdnsHost.Trim().ToLowerInvariant();
            Add($"http://{mdns}:{port}");
            Add($"https://{mdns}:{port}");
        }

        if (!string.IsNullOrWhiteSpace(context.SecureOriginDomain))
        {
            foreach (var address in context.Addresses)
            {
                if (SecureOriginHost.ToHostName(address, context.SecureOriginDomain) is { } name)
                {
                    Add($"https://{name.ToLowerInvariant()}:{port}");
                }
            }
        }

        return origins;
    }

    /// <summary>
    /// Gather the context from this machine: its LAN addresses and mDNS name, the Direct-IP leaf the host published
    /// for its seats, and the cached secure-origin certificate. Never throws; anything unreadable is simply absent.
    /// </summary>
    internal static Context Gather(Action<string>? log = null)
    {
        IReadOnlyList<IPAddress> addresses;
        try
        {
            addresses = [.. LanAddressRanking.GatherFromOs().Where(LanAddressRanking.IsEligible)
                .Select(candidate => candidate.Address).Distinct()];
        }
        catch (Exception exception) when (exception is System.Net.NetworkInformation.NetworkInformationException
                                              or InvalidOperationException or PlatformNotSupportedException)
        {
            log?.Invoke($"render-stream lan: no LAN addresses ({exception.GetType().Name})");
            addresses = [];
        }

        var mdns = QrHostOptions.ToMdnsHostName(System.Environment.MachineName)?.ToLowerInvariant();
        var secure = ReadSecureOrigin(SecureOriginCertificates.DefaultCacheRoot(), DateTimeOffset.UtcNow);
        var direct = ReadDirectIp(DirectIpCertificates.DefaultSeatMaterialRoot(), addresses);
        return new Context(addresses, mdns, secure?.Domain, direct ?? secure?.Pair);
    }

    /// <summary>The cached secure-origin certificate (server.pem + intermediates, server.key) when it is valid now.</summary>
    internal static (string Domain, TlsPair Pair)? ReadSecureOrigin(string? cacheRoot, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(cacheRoot)) return null;
        try
        {
            var certificatePath = Path.Combine(cacheRoot, "server.pem");
            var keyPath = Path.Combine(cacheRoot, "server.key");
            if (!File.Exists(certificatePath) || !File.Exists(keyPath)) return null;
            var certificatePem = File.ReadAllText(certificatePath);
            var keyPem = File.ReadAllText(keyPath);
            using var leaf = X509Certificate2.CreateFromPem(certificatePem, keyPem);
            if (now < leaf.NotBefore.ToUniversalTime() || now >= leaf.NotAfter.ToUniversalTime()) return null;
            var domain = WildcardDomain(leaf);
            if (domain is null) return null;
            var intermediatesPath = Path.Combine(cacheRoot, "intermediates.pem");
            var chain = File.Exists(intermediatesPath)
                ? certificatePem.TrimEnd() + "\n" + File.ReadAllText(intermediatesPath).Trim() + "\n"
                : certificatePem;
            return (domain, new TlsPair("secure-origin", chain, keyPem));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or CryptographicException
                                              or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>The Direct-IP leaf the host published for its seats, when one covers a LAN address and is valid.</summary>
    internal static TlsPair? ReadDirectIp(string? seatMaterialRoot, IReadOnlyList<IPAddress> addresses)
    {
        if (string.IsNullOrWhiteSpace(seatMaterialRoot) || addresses.Count == 0) return null;
        try
        {
            if (!Directory.Exists(seatMaterialRoot)) return null;
            foreach (var file in Directory.EnumerateFiles(seatMaterialRoot, "*.json"))
            {
                var bundle = Path.GetFileNameWithoutExtension(file);
                foreach (var address in addresses)
                {
                    try
                    {
                        using var material = DirectIpCertificates.LoadSeatMaterial(bundle, address, bundle, seatMaterialRoot);
                        using var key = material.Certificate.GetRSAPrivateKey();
                        if (key is null) continue;
                        return new TlsPair("direct-ip", material.Certificate.ExportCertificatePem() + "\n",
                            key.ExportPkcs8PrivateKeyPem() + "\n");
                    }
                    catch (Exception exception) when (exception is IOException or CryptographicException or ArgumentException
                                                          or UnauthorizedAccessException)
                    {
                        // Not this address, or not a current bundle: try the next.
                    }
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        return null;
    }

    /// <summary>Whether the pair's leaf certificate names <paramref name="host"/> (an IP SAN, or a wildcard DNS name).</summary>
    internal static bool Covers(TlsPair? pair, string host)
    {
        if (pair is null || string.IsNullOrWhiteSpace(host)) return false;
        try
        {
            using var leaf = X509Certificate2.CreateFromPem(pair.CertificatePem);
            return leaf.MatchesHostname(host, allowWildcards: true, allowCommonName: false);
        }
        catch (Exception exception) when (exception is CryptographicException or ArgumentException)
        {
            return false;
        }
    }

    /// <summary><c>*.my.local-ip.co</c> → <c>my.local-ip.co</c>: the single-label wildcard a secure origin needs.</summary>
    internal static string? WildcardDomain(X509Certificate2 certificate)
    {
        foreach (var extension in certificate.Extensions)
        {
            if (extension is not X509SubjectAlternativeNameExtension san) continue;
            foreach (var name in san.EnumerateDnsNames())
            {
                if (name.StartsWith("*.", StringComparison.Ordinal) && name.Length > 2) return name[2..].ToLowerInvariant();
            }
        }

        return null;
    }

    /// <summary>
    /// Write the pair into the seat's private evidence directory, replacing any previous one; the key file is created
    /// owner-only on Unix before a byte is written. Returns the two paths.
    /// </summary>
    internal static (string Certificate, string Key) WritePair(string evidenceDirectory, TlsPair pair)
    {
        ArgumentNullException.ThrowIfNull(pair);
        var certificate = Path.Combine(evidenceDirectory, CertificateFileName);
        var key = Path.Combine(evidenceDirectory, KeyFileName);
        DeletePair(evidenceDirectory);
        WritePrivate(certificate, pair.CertificatePem);
        WritePrivate(key, pair.KeyPem);
        return (certificate, key);
    }

    /// <summary>Remove a pair a previous launch left behind (no certificate this time).</summary>
    internal static void DeletePair(string evidenceDirectory)
    {
        File.Delete(Path.Combine(evidenceDirectory, CertificateFileName));
        File.Delete(Path.Combine(evidenceDirectory, KeyFileName));
    }

    private static void WritePrivate(string path, string text)
    {
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using var stream = new FileStream(path, options);
        using var writer = new StreamWriter(stream);
        writer.Write(text);
    }
}
