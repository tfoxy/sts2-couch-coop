using System.Globalization;
using System.Text.RegularExpressions;
namespace CouchCoop.Mod.Protocol;

/// <summary>
/// The streaming seat's half of the pairing: the <c>renderStream</c> descriptor its own <c>session</c> envelope
/// carries, so this seat's viewer can open the hub (handoff-mirror-new-renderer.md §3 Q2).
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
/// exactly one of <c>GRC_LIVE_ALLOWED_ORIGINS</c>: the hub answers any other Origin with 403, and a LAN or HTTPS page
/// could not reach a loopback hub anyway, so it sees "unavailable" instead of a descriptor it cannot use. A request
/// with no Origin is not a browser and gets none either. Not the streaming seat, no listener, no token: none.
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

    private static readonly bool IsStreamingSeat = Environment.GetEnvironmentVariable(RoleEnvironmentVariable) == "1";

    private static readonly Regex TokenShape = new("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex LoopbackListen = new(
        @"^(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$", RegexOptions.CultureInvariant);
    private static readonly Regex Presentation = new(
        @"^presentation:([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$", RegexOptions.CultureInvariant);

    private static string? _token;
    private static string? _certificateHash;

    /// <summary>This process's descriptor for a connection whose page sent <paramref name="origin"/>, or null.</summary>
    internal static BrowserRenderStreamDto? ForOrigin(string? origin)
        => Build(IsStreamingSeat, origin, Environment.GetEnvironmentVariable, ReadTokenOnce, ReadCertificateHashOnce);

    /// <summary>
    /// Pure apart from <paramref name="readToken"/> and <paramref name="readCertificateHash"/>, which are asked only
    /// when everything else holds. Without <paramref name="readCertificateHash"/> no <c>webTransport</c> is described.
    /// </summary>
    internal static BrowserRenderStreamDto? Build(
        bool streamingSeat, string? origin, Func<string, string?> environment, Func<string, string?> readToken,
        Func<string, string?>? readCertificateHash = null)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(readToken);
        if (!streamingSeat || string.IsNullOrWhiteSpace(origin)) return null;

        var allowed = (environment("GRC_LIVE_ALLOWED_ORIGINS") ?? string.Empty)
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (!allowed.Contains(origin, StringComparer.Ordinal)) return null;

        var listen = environment("GRC_LIVE_LISTEN")?.Trim();
        if (listen is null || !LoopbackListen.IsMatch(listen)) return null;

        if (!int.TryParse(environment("GRC_STREAM_VERSION"), NumberStyles.None, CultureInfo.InvariantCulture, out var protocol)
            || protocol is not (11 or 12 or 13))
        {
            return null;
        }

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

        int[]? presentation = null;
        if (environment("GRC_ROOT_SIZE") is { } rootSize && Presentation.Match(rootSize.Trim()) is { Success: true } size)
        {
            presentation =
            [
                int.Parse(size.Groups[1].Value, CultureInfo.InvariantCulture),
                int.Parse(size.Groups[2].Value, CultureInfo.InvariantCulture),
            ];
        }

        return new BrowserRenderStreamDto($"ws://{listen}/render-stream", $"http://{listen}", token, protocol, presentation,
            WebTransportFor(environment, readCertificateHash));
    }

    /// <summary>The <c>webTransport</c> member, or null when the hub does not serve it or its certificate is unknown.</summary>
    private static BrowserRenderStreamWebTransportDto? WebTransportFor(
        Func<string, string?> environment, Func<string, string?>? readCertificateHash)
    {
        if (readCertificateHash is null) return null;
        var carriers = (environment("GRC_LIVE_CARRIERS") ?? string.Empty)
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (!carriers.Contains("wt", StringComparer.Ordinal)) return null;

        // The capture's default for GRC_LIVE_WT_LISTEN is GRC_LIVE_LISTEN (the same port number, over UDP).
        var listen = (environment("GRC_LIVE_WT_LISTEN") ?? environment("GRC_LIVE_LISTEN"))?.Trim();
        if (listen is null || !LoopbackListen.IsMatch(listen)) return null;

        var evidence = environment("GRC_EVIDENCE_DIR");
        if (string.IsNullOrWhiteSpace(evidence)) return null;
        var hash = readCertificateHash(Path.Combine(evidence, CertificateHashFileName))?.Trim();
        if (hash is null || !TokenShape.IsMatch(hash)) return null;

        return new BrowserRenderStreamWebTransportDto($"https://{listen}/render-stream", [hash]);
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
