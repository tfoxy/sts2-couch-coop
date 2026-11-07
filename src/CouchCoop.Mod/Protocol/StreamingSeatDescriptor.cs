using System.Globalization;
using System.Text.RegularExpressions;
namespace CouchCoop.Mod.Protocol;

/// <summary>
/// The streaming seat's half of the pairing: the <c>renderStream</c> descriptor its own <c>session</c> envelope
/// carries, so this seat's viewer can open the hub.
/// </summary>
/// <remarks>
/// <para>
/// Everything is read back from the capture's own environment, which the host set at launch
/// (<see cref="StreamingSeatLaunch.Environment"/>): the listener, the wire version, the presentation size and the
/// allowed page origins. The token is the file the capture wrote at arm (<c>$GRC_EVIDENCE_DIR/live-token</c>, 64
/// lowercase hex, mode 0600); it is read once it exists and kept for the process, whose capture never changes it.
/// </para>
/// <para>
/// WEBTRANSPORT WHEN THE HUB SERVES IT (CAR7). When <c>GRC_LIVE_CARRIERS</c> lists <c>wt</c>, the descriptor also
/// carries <c>webTransport</c>: <c>https://&lt;GRC_LIVE_WT_LISTEN&gt;/render-stream</c> and the self-signed
/// certificate's hash, which the net module writes to <c>$GRC_EVIDENCE_DIR/live-cert-sha256</c> only once its UDP
/// socket is bound. No hash file (yet), or a malformed one, means no <c>webTransport</c>: the page streams over
/// WebSocket. The client (carrier <c>auto</c>) prefers WebTransport on a secure-context page and falls back to
/// WebSocket once if it fails before opening.
/// </para>
/// <para>
/// ONLY FOR A PAGE THE HUB WILL SERVE. The descriptor goes out only on a connection whose browser <c>Origin</c> is
/// exactly one of <c>GRC_LIVE_ALLOWED_ORIGINS</c>: the hub answers any other Origin with 403. A request with no Origin
/// is not a browser and gets none either. Not the streaming seat, no listener, no token: none.
/// </para>
/// <para>
/// LAN PAGES (CAR7b, <c>GRC_LIVE_EXPOSE=lan</c>, which the host always launches). The hub listens on <c>0.0.0.0</c>
/// and the host has allowed its LAN page origins. Such a page is described at its own host on the hub's port:
/// <c>webTransport</c> for an https page (self-signed, pinned by hash, whatever the host name); plain <c>ws://</c> for
/// an http page, which the hub serves beside wss (<see cref="LanPlaintextEnvironmentVariable"/>); and <c>wss://</c> for
/// an https page when the consumer certificate (<c>GRC_LIVE_TLS_CERT</c>) names that host. A page no carrier could
/// serve gets no descriptor.
/// </para>
/// <para>
/// In <c>Protocol/</c>, not <c>Session/</c>, because the hot-reload assembly compiles the connection that calls it
/// from source: it reads the role's flag itself (<see cref="RoleEnvironmentVariable"/>, which
/// <c>Session.StreamingSeatRole</c> uses too) instead of reaching into the mod assembly's internals.
/// </para>
/// </remarks>
internal static class StreamingSeatDescriptor
{
    internal const string TokenFileName = "live-token";

    /// <summary>The <c>wt</c> carrier's certificate hash file (godot-scene-web rs-net), 64 lowercase hex.</summary>
    internal const string CertificateHashFileName = "live-cert-sha256";

    /// <summary><c>COUCHCOOP_STREAMING_SEAT</c>: exactly <c>1</c> marks the streaming seat.</summary>
    internal const string RoleEnvironmentVariable = "COUCHCOOP_STREAMING_SEAT";

    /// <summary>godot-scene-web's <c>GRC_LIVE_LAN_PLAINTEXT</c>: <c>allow</c> serves plain ws to LAN peers beside wss.</summary>
    internal const string LanPlaintextEnvironmentVariable = "GRC_LIVE_LAN_PLAINTEXT";

    private static readonly bool IsStreamingSeat = Environment.GetEnvironmentVariable(RoleEnvironmentVariable) == "1";

    private static readonly Regex TokenShape = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex LoopbackListen = new(
        @"^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);
    private static readonly Regex AnyOrLoopbackListen = new(
        @"^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0):([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);
    private static readonly Regex Presentation = new(
        @"^presentation:([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);

    private static string? _token;
    private static string? _certificateHash;
    private static System.Security.Cryptography.X509Certificates.X509Certificate2? _consumerCertificate;

    /// <summary>This process's descriptor for a connection whose page sent <paramref name="origin"/>, or null.</summary>
    internal static BrowserRenderStreamDto? ForOrigin(string? origin)
        => Build(IsStreamingSeat, origin, Environment.GetEnvironmentVariable, ReadTokenOnce, ReadCertificateHashOnce,
            CertificateCovers);

    /// <summary>
    /// Pure apart from the three readers, which are asked only when everything else holds. Without
    /// <paramref name="readCertificateHash"/> no <c>webTransport</c> is described; without
    /// <paramref name="certificateCovers"/> (the consumer certificate at a path names a host) no LAN page gets wss.
    /// </summary>
    internal static BrowserRenderStreamDto? Build(
        bool streamingSeat, string? origin, Func<string, string?> environment, Func<string, string?> readToken,
        Func<string, string?>? readCertificateHash = null, Func<string, string, bool>? certificateCovers = null)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(readToken);
        if (!streamingSeat || string.IsNullOrWhiteSpace(origin)) return null;

        var allowed = (environment("GRC_LIVE_ALLOWED_ORIGINS") ?? string.Empty)
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (!allowed.Contains(origin, StringComparer.Ordinal)) return null;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var page) || page.Scheme is not ("http" or "https")) return null;

        var lan = environment("GRC_LIVE_EXPOSE")?.Trim() == "lan";
        if (HubAddress(environment("GRC_LIVE_LISTEN"), lan) is not { } hub) return null;

        if (!int.TryParse(environment("GRC_STREAM_VERSION"), NumberStyles.None, CultureInfo.InvariantCulture, out var protocol)
            || protocol is not (11 or 12 or 13))
        {
            return null;
        }

        // The page the hub serves, and how. The host's own loopback http page reaches the hub on loopback, as it always
        // did. A LAN page (only under GRC_LIVE_EXPOSE=lan) reaches it at the page's own host -- the Origin's, which the
        // allow-list above has just matched, so it is one of this host's addresses -- on the hub's port.
        var loopbackPage = page.Scheme == "http" && page.Host is "127.0.0.1" or "localhost" or "[::1]";
        if (!loopbackPage && !lan) return null;
        var host = loopbackPage ? (hub.Host == "0.0.0.0" ? "127.0.0.1" : hub.Host) : page.Host;
        var securePage = page.Scheme == "https" || loopbackPage;
        var portText = hub.Port.ToString(CultureInfo.InvariantCulture);

        string? token = null;
        if (environment("GRC_LIVE_AUTH") == "token")
        {
            var evidence = environment("GRC_EVIDENCE_DIR");
            if (string.IsNullOrWhiteSpace(evidence)) return null;
            token = readToken(Path.Combine(evidence, TokenFileName))?.Trim();
            // No token yet (or a malformed one) means the hub would refuse every hello: say nothing rather than
            // hand out a descriptor that can only fail.
            if (token is null || !TokenShape.IsMatch(token)) return null;
        }

        var webTransport = securePage ? WebTransportFor(environment, readCertificateHash, host, lan) : null;
        string url;
        string resourceBase;
        if (loopbackPage)
        {
            // Plaintext from a loopback peer is always served, with or without a consumer certificate.
            (url, resourceBase) = ($"ws://{host}:{portText}/render-stream", $"http://{host}:{portText}");
        }
        else
        {
            // An http page gets plain ws whenever the hub serves LAN plaintext: always without a consumer certificate,
            // and with one under GRC_LIVE_LAN_PLAINTEXT=allow (otherwise the hub refuses it, tls-required). Plain ws
            // needs no certificate the device must trust, and is no less private than that page's own socket. An
            // https page cannot open plain ws (mixed content): it gets wss when the certificate names its host, else
            // WebTransport or nothing.
            var certificate = environment("GRC_LIVE_TLS_CERT");
            var covers = !string.IsNullOrWhiteSpace(certificate) && certificateCovers?.Invoke(certificate, host) == true;
            var plain = string.IsNullOrWhiteSpace(certificate);
            var plainServed = plain || environment(LanPlaintextEnvironmentVariable)?.Trim() == "allow";
            var tls = !plain && !(plainServed && page.Scheme == "http");
            var socketWorks = tls ? covers : page.Scheme == "http";
            if (!socketWorks && webTransport is null) return null;
            (url, resourceBase) = ($"{(tls ? "wss" : "ws")}://{host}:{portText}/render-stream",
                $"{(tls || page.Scheme == "https" ? "https" : "http")}://{host}:{portText}");
        }

        int[]? presentation = null;
        if (environment("GRC_ROOT_SIZE") is { } rootSize && Presentation.Match(rootSize.Trim()) is { Success: true } size)
        {
            presentation =
            [
                int.Parse(size.Groups[1].Value, CultureInfo.InvariantCulture),
                int.Parse(size.Groups[2].Value, CultureInfo.InvariantCulture),
            ];
        }

        return new BrowserRenderStreamDto(url, resourceBase, token, protocol, presentation, webTransport);
    }

    /// <summary>
    /// The hub's host and port from a listen value: a loopback literal always, <c>0.0.0.0</c> only under LAN exposure
    /// (what the host launches; any other address is not this host's launch and is not described).
    /// </summary>
    private static (string Host, int Port)? HubAddress(string? listen, bool lan)
    {
        var value = listen?.Trim();
        if (value is null) return null;
        var match = (lan ? AnyOrLoopbackListen : LoopbackListen).Match(value);
        if (!match.Success) return null;
        return (match.Groups[1].Value, int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture));
    }

    /// <summary>The <c>webTransport</c> member, or null when the hub does not serve it or its certificate is unknown.</summary>
    private static BrowserRenderStreamWebTransportDto? WebTransportFor(
        Func<string, string?> environment, Func<string, string?>? readCertificateHash, string host, bool lan)
    {
        if (readCertificateHash is null) return null;
        var carriers = (environment("GRC_LIVE_CARRIERS") ?? string.Empty)
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (!carriers.Contains("wt", StringComparer.Ordinal)) return null;

        // The capture's default for GRC_LIVE_WT_LISTEN is GRC_LIVE_LISTEN (the same port number, over UDP).
        if (HubAddress(environment("GRC_LIVE_WT_LISTEN") ?? environment("GRC_LIVE_LISTEN"), lan) is not { } listen) return null;
        if (!lan && listen.Host != host) return null;

        var evidence = environment("GRC_EVIDENCE_DIR");
        if (string.IsNullOrWhiteSpace(evidence)) return null;
        var hash = readCertificateHash(Path.Combine(evidence, CertificateHashFileName))?.Trim();
        if (hash is null || !TokenShape.IsMatch(hash)) return null;

        return new BrowserRenderStreamWebTransportDto(
            $"https://{host}:{listen.Port.ToString(CultureInfo.InvariantCulture)}/render-stream", [hash]);
    }

    /// <summary>Whether the PEM certificate at <paramref name="path"/> names <paramref name="host"/> (read once).</summary>
    private static bool CertificateCovers(string path, string host)
    {
        var certificate = Volatile.Read(ref _consumerCertificate);
        if (certificate is null)
        {
            try
            {
                certificate = System.Security.Cryptography.X509Certificates.X509Certificate2.CreateFromPemFile(path);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
                                                  or System.Security.Cryptography.CryptographicException or ArgumentException)
            {
                return false;
            }

            Volatile.Write(ref _consumerCertificate, certificate);
        }

        return certificate.MatchesHostname(host, allowWildcards: true, allowCommonName: false);
    }

    /// <summary>The token file, read until it is there and well formed, then kept: the capture never rotates it.</summary>
    private static string? ReadTokenOnce(string path) => ReadHexOnce(path, ref _token);

    /// <summary>The certificate hash file, the same way: the net module generates one certificate per process.</summary>
    private static string? ReadCertificateHashOnce(string path) => ReadHexOnce(path, ref _certificateHash);

    private static string? ReadHexOnce(string path, ref string? cache)
    {
        if (Volatile.Read(ref cache) is { } cached) return cached;
        string text;
        try
        {
            text = File.ReadAllText(path).Trim();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        if (!TokenShape.IsMatch(text)) return null;
        Volatile.Write(ref cache, text);
        return text;
    }
}
