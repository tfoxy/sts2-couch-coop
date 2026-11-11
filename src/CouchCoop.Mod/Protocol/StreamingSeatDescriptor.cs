using System.Globalization;
using System.Text.RegularExpressions;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Protocol;

/// <summary>
/// The streaming seat's half of the pairing: the <c>renderStream</c> descriptor its own <c>session</c> envelope
/// carries, so this seat's viewer can open the hub.
/// </summary>
internal static class StreamingSeatDescriptor
{
    /// <summary>godot-scene-web's <c>GRC_LIVE_LAN_PLAINTEXT</c>: <c>allow</c> serves plain ws to LAN peers beside wss.</summary>
    internal const string LanPlaintextEnvironmentVariable = "GRC_LIVE_LAN_PLAINTEXT";

    private static readonly Regex TokenShape = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex LoopbackListen = new(
        @"^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);
    private static readonly Regex AnyOrLoopbackListen = new(
        @"^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0):([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);
    private static readonly Regex Presentation = new(
        @"^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);

    private static System.Security.Cryptography.X509Certificates.X509Certificate2? _consumerCertificate;

    /// <summary>Describe this arm only to a page the hub serves; credentials come from its armed signal.</summary>
    internal static BrowserRenderStreamDto? Build(
        (string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)? snapshot,
        string? origin, Func<string, string?> environment, Func<string, string, bool>? certificateCovers = null)
    {
        ArgumentNullException.ThrowIfNull(environment);
        if (snapshot is not { } armed || string.IsNullOrWhiteSpace(origin)) return null;

        var allowed = (environment("GRC_LIVE_ALLOWED_ORIGINS") ?? string.Empty)
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (!allowed.Contains(origin, StringComparer.Ordinal)) return null;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var page) || page.Scheme is not ("http" or "https")) return null;

        var lan = environment("GRC_LIVE_EXPOSE")?.Trim() == "lan";
        if (HubAddress(armed.Listen, lan) is not { } hub) return null;

        var protocol = armed.StreamVersion;
        if (protocol is not (11 or 12 or 13)) return null;

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
            token = armed.Token.Trim();
            if (!TokenShape.IsMatch(token)) return null;
        }

        var webTransport = securePage ? WebTransportFor(environment, armed.Listen, armed.CertificateHash, host, lan) : null;
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
        if (Presentation.Match(armed.RootSize.Trim()) is { Success: true } size)
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
        Func<string, string?> environment, string armedListen, string certificateHash, string host, bool lan)
    {
        var carriers = (environment("GRC_LIVE_CARRIERS") ?? string.Empty)
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (!carriers.Contains("wt", StringComparer.Ordinal)) return null;

        // The capture's default for GRC_LIVE_WT_LISTEN is GRC_LIVE_LISTEN (the same port number, over UDP).
        if (HubAddress(environment("GRC_LIVE_WT_LISTEN") ?? armedListen, lan) is not { } listen) return null;
        if (!lan && listen.Host != host) return null;

        var hash = certificateHash.Trim();
        if (!TokenShape.IsMatch(hash)) return null;

        return new BrowserRenderStreamWebTransportDto(
            $"https://{host}:{listen.Port.ToString(CultureInfo.InvariantCulture)}/render-stream", [hash]);
    }

    /// <summary>Whether the PEM certificate at <paramref name="path"/> names <paramref name="host"/> (read once).</summary>
    internal static bool CertificateCovers(string path, string host)
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
}
