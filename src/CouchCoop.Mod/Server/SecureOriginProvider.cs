using System.Net;
using System.Security.Cryptography.X509Certificates;

namespace CouchCoop.Mod.Server;

/// <summary>
/// A source of a TLS certificate for the mod's OPT-IN secure browser origin, plus the public DNS
/// domain that certificate covers.
/// </summary>
/// <remarks>
/// <para>
/// <b>What this family of services is.</b> A "published-private-key wildcard" provider registers a
/// public domain whose DNS wildcard maps a dashed IPv4 label back to that literal address —
/// <c>192-168-1-5.my.local-ip.co</c> resolves, publicly, to <c>192.168.1.5</c> — and then publishes a
/// real CA-issued wildcard certificate for the domain TOGETHER WITH ITS PRIVATE KEY, for anyone to
/// use. That combination is what lets a LAN-only game host serve a browser-trusted <c>https://</c>
/// origin with no domain of its own, no CA account, and no certificate-issuance service to run.
/// </para>
/// <para>
/// <b>SECURITY POSTURE — READ THIS BEFORE EXTENDING.</b> The private key is PUBLIC. Anyone who can put
/// packets on the same LAN can present the identical certificate and machine-in-the-middle this origin;
/// the padlock the phone draws means "this name is spelled correctly", NOT "this connection is private".
/// The TLS here buys exactly one thing: a browser SECURE CONTEXT, which is the gate on service workers
/// (asset caching, offline page) and the Screen Wake Lock. It buys no confidentiality and no
/// authenticity against a LAN attacker.
/// <br/>
/// That is an acceptable trade for a couch co-op game on a home LAN — the traffic is a rendered view of
/// a single-player-ish roguelike, there are no credentials on the wire, and the alternative is asking a
/// non-technical player to install a local CA. It is NOT acceptable to reuse this transport for
/// anything sensitive, and it is precisely why the feature is OPT-IN, off by default, and why the plain
/// HTTP LAN URL remains the default QR. Do not "promote" this to the default, and do not put anything
/// on this origin you would not shout across the room.
/// </para>
/// <para>
/// <b>Why it is pluggable.</b> These services break periodically and predictably: publishing a private
/// key is, under the CA/Browser Forum baseline requirements, a key-compromise event, so the certificate
/// is subject to mandatory revocation once someone reports it, after which the operator must re-issue —
/// often from a DIFFERENT CA (the default provider below has already moved from Sectigo to GlobalSign,
/// which is why <see cref="LocalIpCoCertificateProvider"/> refuses to trust the chain file it publishes;
/// see the remarks there). An interface plus a runtime fetch means swapping or adding a provider is a
/// small, testable change rather than a re-architecture, and a dead provider degrades to "the checkbox
/// is disabled with a reason" instead of a broken host.
/// </para>
/// </remarks>
public interface ISecureOriginCertificateProvider
{
    /// <summary>Stable short id, used in logs and diagnostics.</summary>
    string Id { get; }

    /// <summary>
    /// The DNS suffix the published wildcard covers, e.g. <c>my.local-ip.co</c>. The QR's secure host is
    /// <c>&lt;ip-with-dashes&gt;.&lt;this&gt;</c>.
    /// </summary>
    string Domain { get; }

    /// <summary>
    /// Fetch the current bundle, or <see langword="null"/> when the provider cannot serve one right now.
    /// Implementations MUST NOT throw for the ordinary failures (offline, 404, timeout, malformed) —
    /// those are a <see langword="null"/> return, because every caller treats "no certificate" as a
    /// normal state.
    /// </summary>
    Task<SecureCertificateBundle?> FetchAsync(HttpClient http, CancellationToken cancellationToken);
}

/// <summary>
/// A fetched certificate + its published private key, as PEM, plus any intermediates we could prove
/// belong in the chain.
/// </summary>
/// <remarks>
/// PEM rather than a materialised <see cref="X509Certificate2"/> so the whole thing is trivially
/// cacheable as text on disk and comparable in tests without a crypto provider.
/// </remarks>
public sealed record SecureCertificateBundle(
    string CertificatePem,
    string PrivateKeyPem,
    string? IntermediatesPem);

/// <summary>
/// The default provider: <c>local-ip.co</c>, whose wildcard <c>*.my.local-ip.co</c> resolves
/// <c>&lt;a&gt;-&lt;b&gt;-&lt;c&gt;-&lt;d&gt;.my.local-ip.co</c> to <c>a.b.c.d</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Verified live on 2026-08-15</b> before being wired in, because a provider in this family is dead
/// as often as it is alive:
/// DNS <c>192-168-1-5.my.local-ip.co</c> → <c>192.168.1.5</c>;
/// leaf <c>CN=*.my.local-ip.co</c> (SAN <c>*.my.local-ip.co</c>, <c>my.local-ip.co</c>) issued by
/// <c>GlobalSign GCC R6 AlphaSSL CA 2025</c>, valid 2026-06-06 → 2026-12-22;
/// the published key's public half matches the leaf's;
/// and OCSP at <c>ocsp.globalsign.com</c> answered <c>good</c> (i.e. NOT revoked).
/// The sibling service <c>traefik.me</c> no longer publishes a certificate at all (its documented
/// bundle URLs 404), which is exactly the failure mode this interface exists to absorb.
/// </para>
/// <para>
/// <b>The chain file is deliberately distrusted.</b> <c>/cert/chain.pem</c> still serves the operator's
/// PREVIOUS Sectigo chain while <c>/cert/server.pem</c> is now a GlobalSign leaf — serving that mismatch
/// to a phone is worse than serving no intermediate at all. So the chain is accepted only for
/// certificates that actually issue the leaf (subject == leaf issuer), and otherwise we follow the
/// leaf's own Authority Information Access <c>caIssuers</c> pointer, which is authoritative and
/// self-heals across the operator's next CA move.
/// </para>
/// </remarks>
public sealed class LocalIpCoCertificateProvider : ISecureOriginCertificateProvider
{
    /// <summary>Where the leaf, the published key and the (untrusted, see remarks) chain live.</summary>
    public const string CertificateUrl = "http://local-ip.co/cert/server.pem";
    public const string PrivateKeyUrl = "http://local-ip.co/cert/server.key";
    public const string ChainUrl = "http://local-ip.co/cert/chain.pem";

    /// <summary>
    /// The provider's DNS suffix as a constant, for callers that need to NAME the secure host before —
    /// or without — a certificate fetch ever running (the QR dialog labels a not-yet-available secure
    /// row with the host it WOULD encode). <see cref="Domain"/> stays the instance-side source so the
    /// provider abstraction is untouched.
    /// </summary>
    public const string DefaultDomain = "my.local-ip.co";

    public string Id => "local-ip.co";

    public string Domain => DefaultDomain;

    public async Task<SecureCertificateBundle?> FetchAsync(HttpClient http, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(http);

        var certificatePem = await TryGetStringAsync(http, CertificateUrl, cancellationToken).ConfigureAwait(false);
        var privateKeyPem = await TryGetStringAsync(http, PrivateKeyUrl, cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(certificatePem) || string.IsNullOrWhiteSpace(privateKeyPem))
        {
            return null;
        }

        var chainPem = await TryGetStringAsync(http, ChainUrl, cancellationToken).ConfigureAwait(false);
        var intermediates = await ResolveIntermediatesAsync(http, certificatePem!, chainPem, cancellationToken)
            .ConfigureAwait(false);

        return new SecureCertificateBundle(certificatePem!, privateKeyPem!, intermediates);
    }

    /// <summary>
    /// Pick the intermediates that genuinely issue <paramref name="certificatePem"/>: first from the
    /// published chain, then — when that chain is stale, which it currently is — from the leaf's AIA
    /// <c>caIssuers</c> URL. Returns <see langword="null"/> when neither yields a match; a leaf-only
    /// handshake still works in most browsers (they cache or AIA-fetch intermediates themselves), so
    /// this is a quality upgrade, not a hard requirement.
    /// </summary>
    internal static async Task<string?> ResolveIntermediatesAsync(
        HttpClient http,
        string certificatePem,
        string? chainPem,
        CancellationToken cancellationToken)
    {
        X509Certificate2? leaf = null;
        try
        {
            leaf = X509Certificate2.CreateFromPem(certificatePem);

            if (!string.IsNullOrWhiteSpace(chainPem)
                && SelectIssuersOf(leaf, chainPem!) is { Length: > 0 } fromChain)
            {
                return fromChain;
            }

            foreach (var url in AuthorityInformationAccessIssuerUrls(leaf))
            {
                var bytes = await TryGetBytesAsync(http, url, cancellationToken).ConfigureAwait(false);
                if (bytes is null)
                {
                    continue;
                }

                try
                {
                    // AIA serves DER, occasionally PEM. X509CertificateLoader sniffs neither, so try the
                    // DER path and fall back to treating the payload as PEM text.
                    var issuer = X509CertificateLoader.LoadCertificate(bytes);
                    if (IsIssuerOf(leaf, issuer))
                    {
                        return ToPem(issuer);
                    }
                }
                catch (System.Security.Cryptography.CryptographicException)
                {
                    var text = System.Text.Encoding.UTF8.GetString(bytes);
                    if (SelectIssuersOf(leaf, text) is { Length: > 0 } fromAia)
                    {
                        return fromAia;
                    }
                }
            }
        }
        catch (Exception exception) when (exception is System.Security.Cryptography.CryptographicException or FormatException)
        {
            // A malformed leaf is the caller's problem to report, not ours to throw over.
        }
        finally
        {
            leaf?.Dispose();
        }

        return null;
    }

    // Only certificates that actually issued the leaf. Subject/issuer name equality is the cheap,
    // dependency-free test; it is enough to reject the operator's stale cross-CA chain, which is the
    // failure this guards.
    private static string? SelectIssuersOf(X509Certificate2 leaf, string candidatePem)
    {
        X509Certificate2Collection candidates = [];
        try
        {
            candidates.ImportFromPem(candidatePem);
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return null;
        }

        var matches = new List<string>();
        foreach (var candidate in candidates)
        {
            if (IsIssuerOf(leaf, candidate))
            {
                matches.Add(ToPem(candidate));
            }
        }

        return matches.Count == 0 ? null : string.Join("\n", matches);
    }

    private static bool IsIssuerOf(X509Certificate2 leaf, X509Certificate2 candidate)
        => string.Equals(candidate.Subject, leaf.Issuer, StringComparison.Ordinal)
            && !string.Equals(candidate.Subject, candidate.Issuer, StringComparison.Ordinal);

    private static string ToPem(X509Certificate2 certificate) => certificate.ExportCertificatePem();

    // The caIssuers URLs from the leaf's AIA extension, in order. Parsed via the framework extension type
    // where present; a certificate without AIA simply yields nothing.
    private static IEnumerable<string> AuthorityInformationAccessIssuerUrls(X509Certificate2 leaf)
    {
        foreach (var extension in leaf.Extensions)
        {
            if (extension is X509AuthorityInformationAccessExtension aia)
            {
                foreach (var url in aia.EnumerateCAIssuersUris())
                {
                    if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                        || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    {
                        yield return url;
                    }
                }
            }
        }
    }

    private static async Task<string?> TryGetStringAsync(HttpClient http, string url, CancellationToken cancellationToken)
    {
        var bytes = await TryGetBytesAsync(http, url, cancellationToken).ConfigureAwait(false);
        return bytes is null ? null : System.Text.Encoding.UTF8.GetString(bytes);
    }

    // Every ordinary network failure is a null, never a throw: the whole feature is best-effort and the
    // caller's contract is "no certificate == the secure listener does not start".
    private static async Task<byte[]?> TryGetBytesAsync(HttpClient http, string url, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            return await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or IOException or InvalidOperationException or UriFormatException)
        {
            return null;
        }
    }
}

/// <summary>
/// Pure helpers shared by the secure listener and the QR dialog: which IPv4 addresses can carry a
/// secure origin, and what the resulting host name is.
/// </summary>
/// <remarks>
/// Deliberately Godot-free, socket-free and provider-instance-free (it takes the domain as a string) so
/// "what does the phone scan when the box is ticked" stays unit-testable without a game, a NIC or a
/// network — the same property <see cref="CouchCoop.Mod.HostUi.QrHostOptions"/> documents and relies on.
/// </remarks>
public static class SecureOriginHost
{
    /// <summary>
    /// <c>192.168.1.5</c> + <c>my.local-ip.co</c> → <c>192-168-1-5.my.local-ip.co</c>, or
    /// <see langword="null"/> when the address cannot carry a secure origin.
    /// </summary>
    /// <remarks>
    /// The wildcard these providers publish is single-label (<c>*.my.local-ip.co</c>), so the dashed
    /// quad must be exactly ONE label — a name with a further dot in it would not be covered by the
    /// certificate and would fail the phone's hostname check.
    /// </remarks>
    public static string? ToHostName(IPAddress? address, string? domain)
    {
        if (!IsSecureOriginEligible(address) || string.IsNullOrWhiteSpace(domain))
        {
            return null;
        }

        var trimmed = domain!.Trim().Trim('.');
        return trimmed.Length == 0
            ? null
            : string.Concat(address!.ToString().Replace('.', '-'), ".", trimmed);
    }

    /// <summary>
    /// Whether <paramref name="address"/> is an IPv4 literal the provider's DNS will actually map back.
    /// </summary>
    /// <remarks>
    /// Loopback is excluded because the point is a phone reaching this PC, and link-local/APIPA
    /// (169.254/16) because an address that means "DHCP failed" is never routable from a handset. IPv6
    /// is excluded outright: the dashed-quad scheme these providers publish is IPv4-shaped, exactly like
    /// the rest of the join URL, the QR and the discovery reply.
    /// </remarks>
    public static bool IsSecureOriginEligible(IPAddress? address)
    {
        if (address is null || address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
        {
            return false;
        }

        if (IPAddress.IsLoopback(address) || IPAddress.Any.Equals(address) || IPAddress.Broadcast.Equals(address))
        {
            return false;
        }

        var octets = address.GetAddressBytes();
        // 169.254/16 link-local, and 0.0.0.0/8 / 224+ (multicast and reserved) which are not host addresses.
        return !(octets[0] == 169 && octets[1] == 254) && octets[0] != 0 && octets[0] < 224;
    }
}
