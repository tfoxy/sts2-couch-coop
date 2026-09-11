using System.Diagnostics.CodeAnalysis;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The PUBLIC HTTPS origin that hosts the browser client for the "web link" QR option, and the rules for
/// deciding whether a given origin is allowed to talk to this server.
/// </summary>
/// <remarks>
/// <para>
/// <b>What the web-link mode is.</b> Instead of the phone loading the SPA from this machine, it loads a tiny
/// bootstrap from a public origin — ordinary DNS, ordinary certificate — which then reaches THIS server by
/// literal IPv4 over plain HTTP, gated by the browser's Local Network Access permission. That buys a secure
/// context (PWA install, service worker, wake lock) without the <see cref="LocalIpCoCertificateProvider"/>
/// trick of resolving a public name to a private address, which routers with DNS-rebinding protection
/// refuse. See <c>docs/agents/local-network-access.md</c> for the measured browser behaviour.
/// </para>
/// <para>
/// <b>Why it is configurable.</b> The shipped default is the origin this project publishes, but the value is
/// baked into a QR that players scan, so it has to be overridable without a rebuild: the tunnel used to
/// rehearse the flow, a staging deploy, and anyone self-hosting their own copy all need to point the QR
/// somewhere else. It is also the value the WebSocket origin check trusts, so the two can never drift.
/// </para>
/// </remarks>
public static class CouchCoopWebOrigin
{
    /// <summary>Overrides <see cref="DefaultOrigin"/>. Empty or unparseable falls back to the default.</summary>
    public const string EnvironmentVariable = "COUCHCOOP_WEB_ORIGIN";

    /// <summary>Set to <c>0</c> to disable the WebSocket origin check entirely. See <see cref="IsAllowedWebSocketOrigin"/>.</summary>
    public const string OriginCheckEnvironmentVariable = "COUCHCOOP_WS_ORIGIN_CHECK";

    /// <summary>Where the published bootstrap lives.</summary>
    public const string DefaultOrigin = "https://sts2-couch.pages.dev";

    /// <summary>
    /// The configured public origin, normalised to a bare scheme+host+port with no trailing slash.
    /// </summary>
    public static string Resolve()
        => Normalize(Environment.GetEnvironmentVariable(EnvironmentVariable)) ?? DefaultOrigin;

    /// <summary>
    /// Scheme+host+port, no trailing slash, or <see langword="null"/> when the value cannot be one.
    /// </summary>
    /// <remarks>
    /// Only http/https: this value ends up as the prefix of a URL in a QR code and as an entry in an
    /// allow-list, and neither has any business carrying another scheme.
    /// </remarks>
    public static string? Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri))
        {
            return null;
        }

        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
        {
            return null;
        }

        return uri.GetLeftPart(UriPartial.Authority);
    }

    /// <summary>
    /// The full URL the "web link" QR encodes: the public origin, with the LAN address the phone should
    /// connect back to carried in <c>?h=</c>.
    /// </summary>
    /// <remarks>
    /// An AUTHORITY (<c>192.168.1.5:13337</c>) rather than a full origin, purely to keep the payload short —
    /// a denser QR is a slower scan across a room, and a LAN host is never anything but <c>http:</c>. The
    /// frontend's <c>hostFromUrl</c> is the twin that parses it (and accepts a full origin too, because
    /// somebody will eventually type one).
    /// </remarks>
    public static string BuildJoinUrl(string webOrigin, string hostAuthority)
        // Escaped for safety, then the colon put back: `:` is legal unescaped in a query value, and
        // `%3A` costs three characters of QR payload for nothing. Payload length drives the module count,
        // and a denser code is a slower scan across a lit room — the one ergonomic property of a QR that
        // players actually feel.
        => $"{webOrigin.TrimEnd('/')}/?h={Uri.EscapeDataString(hostAuthority).Replace("%3A", ":", StringComparison.Ordinal)}";

    /// <summary>
    /// Whether a browser presenting <paramref name="origin"/> may open the game WebSocket on a server whose
    /// <c>Host</c> header is <paramref name="requestHost"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is where the real access control lives. Every HTTP route here serves public game content and is
    /// answered with a wildcard CORS grant (see <see cref="HttpResponseWriter.CorsAllowOrigin"/>), but
    /// <c>/ws</c> is the capability: it joins a seat and drives input. CORS has never gated WebSockets in any
    /// browser, so the <c>Origin</c> header is the only signal available, and it is checked here.
    /// </para>
    /// <para>
    /// <b>An absent Origin is ALLOWED, deliberately.</b> Browsers always send one on a WebSocket handshake;
    /// non-browser clients — the native Godot client, the QA probe, <c>curl</c> — do not. Refusing them would
    /// break every non-browser consumer to defend against an attacker who can simply omit the header, since
    /// nothing outside a browser is bound by it. The header is a defence against OTHER PAGES in a player's
    /// browser, and only a browser is subject to it.
    /// </para>
    /// <para>
    /// Same-origin is decided against the request's own <c>Host</c> header rather than an enumeration of this
    /// machine's addresses: the client reached us at that name, whatever it was — a literal IPv4, a
    /// <c>.local</c> name, the <c>local-ip.co</c> name, an operator override — so it is exactly the right
    /// comparand and needs no NIC walk to stay correct.
    /// </para>
    /// </remarks>
    public static bool IsAllowedWebSocketOrigin(string? origin, string? requestHost, string? webOrigin = null)
    {
        if (!IsOriginCheckEnabled())
        {
            return true;
        }

        // No Origin at all == not a browser. See the remarks.
        if (string.IsNullOrWhiteSpace(origin))
        {
            return true;
        }

        var normalized = Normalize(origin);
        if (normalized is null)
        {
            // A present-but-unparseable Origin is a browser behaving strangely, or something pretending to
            // be one. Neither is a caller we can vouch for.
            return false;
        }

        if (string.Equals(normalized, Normalize(webOrigin) ?? Resolve(), StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return MatchesRequestHost(normalized, requestHost);
    }

    /// <summary>Whether the check is on. Kill switch: <c>COUCHCOOP_WS_ORIGIN_CHECK=0</c>.</summary>
    /// <remarks>
    /// Present for the same reason the mDNS responder and row self-check have one: this is a new refusal on
    /// a path that used to accept everything, and a player locked out of their own game by a topology we did
    /// not anticipate needs a switch they can be talked through over voice chat.
    /// </remarks>
    public static bool IsOriginCheckEnabled()
        => Environment.GetEnvironmentVariable(OriginCheckEnvironmentVariable) is not ("0" or "false" or "off");

    /// <summary>
    /// Whether <paramref name="normalizedOrigin"/> names the same MACHINE the request arrived at.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>THE PORT IS DELIBERATELY IGNORED, and getting this wrong breaks co-op outright.</b> A joined seat
    /// is redirected to its own headless instance, which is a separate process on a DIFFERENT port
    /// (base + 10×slot). The page stays on the port it was loaded from, so the browser sends
    /// <c>Origin: http://worky.local:13337</c> to an instance whose <c>Host</c> is
    /// <c>worky.local:13357</c>. A port-sensitive comparison refuses that — i.e. refuses every headless
    /// seat, on every topology, including the plain LAN one that has always worked. This was written
    /// port-sensitive first and caught only by running a real join; the unit test that "covered" it had
    /// encoded the bug.
    /// </para>
    /// <para>
    /// Ignoring the port is also the honest trust boundary. Every port in this range belongs to this mod —
    /// the host server and the instances it spawns — so a page served by one of them may talk to another.
    /// What the check is actually defending against is an unrelated PUBLIC site poking the LAN, and that
    /// is refused by the host comparison alone (and gated again by the browser's Local Network Access
    /// permission). The residual exposure is a different service on another port of this same machine,
    /// which was already fully able to do this before the check existed at all.
    /// </para>
    /// </remarks>
    private static bool MatchesRequestHost(string normalizedOrigin, string? requestHost)
    {
        if (string.IsNullOrWhiteSpace(requestHost) || !TryReadHost(requestHost!, out var host))
        {
            return false;
        }

        return Uri.TryCreate(normalizedOrigin, UriKind.Absolute, out var originUri)
            && string.Equals(originUri.Host, host, StringComparison.OrdinalIgnoreCase);
    }

    // The Host header is `host` or `host:port`. `Uri` parses that authority reliably (including a
    // bracketed IPv6 literal) once it has a scheme to hang off.
    private static bool TryReadHost(string value, [NotNullWhen(true)] out string? host)
    {
        host = null;
        var trimmed = value.Trim();
        if (trimmed.Length == 0)
        {
            return false;
        }

        if (!Uri.TryCreate($"http://{trimmed}", UriKind.Absolute, out var uri) || uri.Host.Length == 0)
        {
            return false;
        }

        host = uri.Host;
        return true;
    }
}
