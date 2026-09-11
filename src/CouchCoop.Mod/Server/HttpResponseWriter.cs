using System.Net;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Protocol;

namespace CouchCoop.Mod.Server;

internal static class HttpResponseWriter
{
    internal static readonly TimeSpan NetworkWriteTimeout = TimeSpan.FromSeconds(30);
    public static Task WriteBytesAsync(
        Stream stream,
        int statusCode,
        string reason,
        byte[] body,
        string contentType,
        IReadOnlyDictionary<string, string>? headers = null,
        CancellationToken cancellationToken = default)
    {
        var responseHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Type"] = contentType,
            ["Content-Length"] = body.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Connection"] = "close"
        };

        if (headers is not null)
        {
            foreach (var (key, value) in headers)
            {
                responseHeaders[key] = value;
            }
        }

        return WriteRawAsync(stream, statusCode, reason, responseHeaders, body, cancellationToken);
    }

    // A streamed Spine animation clip (SpineClipWire body: header + length-prefixed PNG frames). v1 writes
    // the whole pre-serialized blob with a known Content-Length — the frame framing lives in the body, so
    // the frontend still decodes frame-by-frame off response.body as bytes arrive. A future progressive
    // upgrade (frames flushed as the bridge encodes them) would replace this with a chunked per-frame write.
    /// <summary>The response header that marks a #14 DEGRADED (single-frame stand-in) spine clip.</summary>
    public const string SpineDegradedHeader = "X-Spine-Degraded";

    public static Task WriteSpineClipAsync(
        Stream stream,
        byte[] body,
        string cacheStatus,
        bool degraded = false,
        CancellationToken cancellationToken = default)
    {
        // A DEGRADED body is the single-frame stand-in for a clip the host declined to bake under machine
        // pressure — the exact opposite of immutable: the very same URL must return the real clip once the
        // pressure drops. So it is `no-store` (no browser/proxy may pin it) and carries the marker header both
        // clients read to (a) skip the `&retry=1` "the producer collapsed my clip" escalation and (b) keep it out of
        // their own caches. An ordinary clip is byte-identical to before.
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Cache-Control"] = degraded ? "no-store" : "public, max-age=31536000, immutable",
            ["X-Cache"] = cacheStatus
        };

        if (degraded)
        {
            headers[SpineDegradedHeader] = "1";
        }

        return WriteBytesAsync(stream, 200, "OK", body, SpineClipWire.ContentType, headers, cancellationToken);
    }

    // Stream a large file off disk without buffering it in memory (the APK is ~97MB; WriteBytesAsync would
    // hold the whole body per concurrent download). Content-Length comes from the open stream's length.
    public static async Task WriteFileAsync(
        Stream stream,
        string filePath,
        string contentType,
        IReadOnlyDictionary<string, string>? headers = null,
        CancellationToken cancellationToken = default)
    {
        await using var file = new FileStream(
            filePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);

        var responseHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Content-Type"] = contentType,
            ["Content-Length"] = file.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Connection"] = "close"
        };

        if (headers is not null)
        {
            foreach (var (key, value) in headers)
            {
                responseHeaders[key] = value;
            }
        }

        await WriteRawAsync(stream, 200, "OK", responseHeaders, body: null, cancellationToken).ConfigureAwait(false);
        var buffer = new byte[64 * 1024];
        int read;
        while ((read = await file.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
        {
            await WriteWithDeadlineAsync(stream, buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
        }
    }

    /// <param name="headers">
    /// Extra response headers. Additive only, and the BODY is unaffected: a route that explains itself in a header
    /// (the geoclip refusal diagnostic) must keep answering the same bytes it answered before, because the body is
    /// what clients and tests are pinned to.
    /// </param>
    public static Task WriteJsonErrorAsync(
        Stream stream,
        HttpStatusCode statusCode,
        string code,
        string message,
        CancellationToken cancellationToken = default,
        IReadOnlyDictionary<string, string>? headers = null)
    {
        var body = Encoding.UTF8.GetBytes(BrowserJson.Serialize(new BrowserErrorEnvelope(
            "error",
            "http",
            code,
            message)));

        return WriteBytesAsync(
            stream,
            (int)statusCode,
            statusCode.ToString(),
            body,
            "application/json; charset=utf-8",
            headers,
            cancellationToken);
    }

    public static Task WriteJsonAsync(
        Stream stream,
        HttpStatusCode statusCode,
        object body,
        CancellationToken cancellationToken = default)
    {
        var bytes = Encoding.UTF8.GetBytes(BrowserJson.Serialize(body));
        return WriteBytesAsync(
            stream,
            (int)statusCode,
            statusCode.ToString(),
            bytes,
            "application/json; charset=utf-8",
            cancellationToken: cancellationToken);
    }

    /// <summary>
    /// The cross-origin grant every response carries. See the remarks — the value is deliberately <c>*</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Why a wildcard, and why that is not the weakening it looks like.</b> Under the "web link" QR the
    /// SPA is served from a public origin and reaches this server cross-origin, so the responses it needs
    /// (the app bundle, <c>/res</c>, <c>/bg</c>, <c>/spines</c>, <c>/models</c>, <c>/catalog</c>) must be
    /// readable cross-origin or nothing renders.
    /// </para>
    /// <para>
    /// Every route this server exposes over HTTP serves the same PUBLIC game content to every caller: there
    /// is no per-player data, no session, no cookie, and no credential accepted anywhere on the HTTP
    /// surface — the entire player-specific channel is the WebSocket. So an echoed allow-list would buy no
    /// confidentiality over a wildcard, while adding a <c>Vary: Origin</c> that every one of these
    /// aggressively-cached asset responses would then have to carry correctly. A wildcard cannot be got
    /// subtly wrong; an echo can.
    /// </para>
    /// <para>
    /// The capability worth protecting — join the game and drive input — lives on <c>/ws</c>, which CORS has
    /// never gated in any browser. That is checked by ORIGIN at the upgrade instead (see
    /// <c>CouchCoopBrowserServer.IsAllowedWebSocketOrigin</c>), which is where the real control belongs.
    /// And in the remote-hosted topology the browser's Local Network Access permission sits in front of all
    /// of it: a public page cannot make ANY of these requests until the player has said yes to a prompt.
    /// </para>
    /// <para>
    /// Deliberately NOT paired with <c>Access-Control-Allow-Credentials</c>: that combination is illegal
    /// with a wildcard, and the frontend sends <c>credentials: "omit"</c> for exactly this reason.
    /// </para>
    /// </remarks>
    public const string CorsAllowOrigin = "*";

    public static async Task WriteRawAsync(
        Stream stream,
        int statusCode,
        string reason,
        IReadOnlyDictionary<string, string> headers,
        byte[]? body = null,
        CancellationToken cancellationToken = default)
    {
        var builder = new StringBuilder();
        builder.Append("HTTP/1.1 ").Append(statusCode).Append(' ').Append(reason).Append("\r\n");
        // Applied HERE — the single funnel every HTTP response passes through — rather than at ~20 call
        // sites, so no future route can be added that silently lacks it and fails only under the web-link
        // QR. A caller that set the header explicitly still wins.
        if (!headers.ContainsKey("Access-Control-Allow-Origin"))
        {
            builder.Append("Access-Control-Allow-Origin: ").Append(CorsAllowOrigin).Append("\r\n");
        }

        foreach (var (key, value) in headers)
        {
            builder.Append(key).Append(": ").Append(value).Append("\r\n");
        }

        builder.Append("\r\n");
        await WriteWithDeadlineAsync(stream, Encoding.ASCII.GetBytes(builder.ToString()), cancellationToken).ConfigureAwait(false);
        if (body is { Length: > 0 })
        {
            for (var offset = 0; offset < body.Length; offset += 64 * 1024)
            {
                await WriteWithDeadlineAsync(
                    stream,
                    body.AsMemory(offset, Math.Min(64 * 1024, body.Length - offset)),
                    cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private static async Task WriteWithDeadlineAsync(Stream stream, ReadOnlyMemory<byte> bytes, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(NetworkWriteTimeout);
        await stream.WriteAsync(bytes, deadline.Token).ConfigureAwait(false);
    }
}
