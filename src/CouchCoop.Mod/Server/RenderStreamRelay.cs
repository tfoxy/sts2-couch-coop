using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace CouchCoop.Mod.Server;

/// <summary>One bounded HTTP response, or a validated WebSocket upgrade, without decoding resource bytes.</summary>
internal static class RenderStreamRelay
{
    internal static readonly TimeSpan ResponseTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// The relay's socket to the capture hub. Viewer acks are a few hundred bytes each; with Nagle on, the kernel
    /// holds each one until the hub's next frame carries back a TCP ACK, which adds a whole host frame to every
    /// credit round trip. So the upstream socket always sends at once.
    /// </summary>
    internal static async Task<TcpClient> ConnectUpstreamAsync(IPAddress address, int port, CancellationToken cancellationToken)
    {
        var client = new TcpClient { NoDelay = true };
        try
        {
            await client.ConnectAsync(address, port, cancellationToken).ConfigureAwait(false);
            return client;
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    internal static async Task ForwardAsync(Stream upstream, Stream browser, CouchCoopHttpRequest request,
        ReadOnlyMemory<byte> header, CancellationToken cancellationToken,
        Func<bool>? stillCurrent = null, TimeSpan? responseTimeout = null)
    {
        var committed = false;
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        // Read the viewer during the handshake so a closed page cancels a cold upstream immediately.
        Task? viewer = null;
        Task<byte[]>? responseTask = null;
        try
        {
            await WriteAsync(upstream, header, stop.Token).ConfigureAwait(false);
            viewer = ObserveViewerAsync(browser, request.IsWebSocketUpgrade ? upstream : null, stop.Token);
            responseTask = ReadHeaderAsync(upstream, stop.Token, responseTimeout ?? ResponseTimeout);
            if (await Task.WhenAny(viewer, responseTask).ConfigureAwait(false) == viewer)
            {
                await viewer.ConfigureAwait(false);
                return;
            }
            var response = await responseTask.ConfigureAwait(false);
            var (status, headers) = ParseResponse(response);
            if (stillCurrent?.Invoke() == false) throw new IOException("The render arm changed.");
            if (status == 101) ValidateUpgrade(request, headers);
            var output = ResponseHeader(response, status, headers, request.Header("Origin"));
            await WriteAsync(browser, output, stop.Token).ConfigureAwait(false);
            committed = true;
            if (status == 101)
            {
                var downstream = PumpAsync(upstream, browser, stop.Token, idleDeadline: false);
                await Task.WhenAny(viewer, downstream).ConfigureAwait(false);
                stop.Cancel();
                try { await Task.WhenAll(viewer, downstream).ConfigureAwait(false); }
                catch (Exception error) when (IsConnectionEnd(error)) { }
            }
            else if (status is not (204 or 304))
            {
                await CopyBodyAsync(upstream, browser, headers, stop.Token).ConfigureAwait(false);
            }
        }
        catch (Exception error) when (IsConnectionEnd(error) || error is TimeoutException)
        {
            if (!committed && !cancellationToken.IsCancellationRequested && viewer?.IsCompleted != true)
            {
                try
                {
                    await ErrorAsync(browser, error is TimeoutException ? 504 : 502,
                        request.Header("Origin"), cancellationToken).ConfigureAwait(false);
                }
                catch (Exception writeError) when (IsConnectionEnd(writeError)) { }
            }
        }
        finally
        {
            stop.Cancel();
            try { if (viewer is not null) await viewer.ConfigureAwait(false); }
            catch (Exception error) when (IsConnectionEnd(error)) { }
            try { if (responseTask is not null) await responseTask.ConfigureAwait(false); }
            catch (Exception error) when (IsConnectionEnd(error) || error is TimeoutException) { }
        }
    }

    internal static Task ErrorAsync(Stream stream, int status, string? origin, CancellationToken token)
    {
        var headers = Cors(origin);
        headers["Cache-Control"] = "no-store";
        return HttpResponseWriter.WriteBytesAsync(stream, status, status switch
        {
            403 => "Forbidden", 405 => "Method Not Allowed", 410 => "Gone", 504 => "Gateway Timeout", _ => "Bad Gateway"
        }, [], "text/plain", headers, token);
    }

    internal static Dictionary<string, string> Cors(string? origin)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Access-Control-Allow-Methods"] = "GET, OPTIONS",
            ["Access-Control-Allow-Headers"] = "authorization, accept, content-type, range, if-none-match, if-modified-since",
            ["Access-Control-Expose-Headers"] = "ETag, Content-Encoding, Content-Length, Cache-Control, Last-Modified, Content-Range",
            ["Vary"] = "Origin, Accept-Encoding",
        };
        if (!string.IsNullOrEmpty(origin)) headers["Access-Control-Allow-Origin"] = origin;
        return headers;
    }

    internal static byte[] RequestHeader(CouchCoopHttpRequest request, string target, string host, string origin)
    {
        var headers = new Dictionary<string, string>(request.Headers, StringComparer.OrdinalIgnoreCase);
        // Only the fixed target is forwarded; neither an absolute URI nor a browser-supplied Host chooses upstream.
        headers["Host"] = host;
        headers["Origin"] = origin;
        headers["Connection"] = request.IsWebSocketUpgrade ? "Upgrade" : "close";
        foreach (var name in new[] { "Content-Length", "Transfer-Encoding", "Proxy-Connection", "Keep-Alive", "Expect", "Trailer" })
            headers.Remove(name);
        var builder = new StringBuilder($"{request.Method} {target} HTTP/1.1\r\n");
        foreach (var (name, value) in headers) builder.Append(name).Append(": ").Append(value).Append("\r\n");
        return Encoding.ASCII.GetBytes(builder.Append("\r\n").ToString());
    }

    private static byte[] ResponseHeader(byte[] response, int status, Dictionary<string, string> headers, string? origin)
    {
        var firstLine = Encoding.ASCII.GetString(response).Split("\r\n", 2)[0];
        var output = new StringBuilder(firstLine + "\r\n");
        var cors = Cors(origin);
        if (headers.TryGetValue("Vary", out var vary))
            cors["Vary"] = string.Join(", ", vary.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Concat(new[] { "Origin", "Accept-Encoding" }).Distinct(StringComparer.OrdinalIgnoreCase));
        var connectionHeaders = headers.GetValueOrDefault("Connection", "").Split(',', StringSplitOptions.TrimEntries);
        foreach (var (name, value) in headers)
        {
            if (name.StartsWith("Access-Control-", StringComparison.OrdinalIgnoreCase) || name.Equals("Vary", StringComparison.OrdinalIgnoreCase)
                || name.Equals("Connection", StringComparison.OrdinalIgnoreCase) || name.Equals("Keep-Alive", StringComparison.OrdinalIgnoreCase)
                || name.Equals("Proxy-Authenticate", StringComparison.OrdinalIgnoreCase) || name.Equals("Proxy-Authorization", StringComparison.OrdinalIgnoreCase)
                || (status != 101 && connectionHeaders.Contains(name, StringComparer.OrdinalIgnoreCase))
                || (status >= 400 && name.Equals("Cache-Control", StringComparison.OrdinalIgnoreCase))) continue;
            output.Append(name).Append(": ").Append(value).Append("\r\n");
        }
        foreach (var (name, value) in cors) output.Append(name).Append(": ").Append(value).Append("\r\n");
        if (status >= 400) output.Append("Cache-Control: no-store\r\n");
        output.Append(status == 101 ? "Connection: Upgrade\r\n\r\n" : "Connection: close\r\n\r\n");
        return Encoding.ASCII.GetBytes(output.ToString());
    }

    private static (int Status, Dictionary<string, string> Headers) ParseResponse(byte[] response)
    {
        var lines = Encoding.ASCII.GetString(response).Split("\r\n");
        var statusLine = lines[0].Split(' ', 3);
        if (statusLine.Length < 3 || statusLine[0] is not ("HTTP/1.1" or "HTTP/1.0")
            || statusLine[1].Length != 3 || !int.TryParse(statusLine[1], out var status) || status is < 101 or > 599
            || status is > 101 and < 200) throw new IOException("Invalid render response status.");
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1).Where(line => line.Length > 0))
        {
            var colon = line.IndexOf(':');
            if (colon <= 0 || line[..colon].Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-')
                || line.Any(c => char.IsControl(c) && c != '\t')) throw new IOException("Invalid render response header.");
            var name = line[..colon];
            var value = line[(colon + 1)..].Trim();
            if (headers.ContainsKey(name))
            {
                if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) throw new IOException("Ambiguous render response framing.");
                headers[name] += ", " + value;
            }
            else headers.Add(name, value);
        }
        if (headers.ContainsKey("Transfer-Encoding") && headers.ContainsKey("Content-Length"))
            throw new IOException("Ambiguous render response framing.");
        if (headers.TryGetValue("Transfer-Encoding", out var coding) && !coding.Equals("chunked", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Unsupported render response framing.");
        if (headers.TryGetValue("Content-Length", out var length) && (!long.TryParse(length, NumberStyles.None, CultureInfo.InvariantCulture, out var size) || size < 0))
            throw new IOException("Invalid render response length.");
        return (status, headers);
    }

    private static void ValidateUpgrade(CouchCoopHttpRequest request, Dictionary<string, string> headers)
    {
        var key = request.Header("Sec-WebSocket-Key");
        var accept = key is null ? null : Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        if (!request.IsWebSocketUpgrade || accept is null || headers.GetValueOrDefault("Sec-WebSocket-Accept") != accept
            || !string.Equals(headers.GetValueOrDefault("Upgrade"), "websocket", StringComparison.OrdinalIgnoreCase)
            || !headers.GetValueOrDefault("Connection", "").Split(',', StringSplitOptions.TrimEntries).Contains("Upgrade", StringComparer.OrdinalIgnoreCase))
            throw new IOException("Invalid render WebSocket upgrade.");
        if (headers.TryGetValue("Sec-WebSocket-Protocol", out var protocol)
            && !(request.Header("Sec-WebSocket-Protocol") ?? "").Split(',', StringSplitOptions.TrimEntries).Contains(protocol, StringComparer.Ordinal))
            throw new IOException("Invalid render WebSocket protocol.");
    }

    private static async Task<byte[]> ReadHeaderAsync(Stream stream, CancellationToken token, TimeSpan timeout)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(timeout);
        using var header = new MemoryStream();
        var next = new byte[1];
        try
        {
            while (header.Length < CouchCoopHttpRequest.MaxHeaderBytes)
            {
                if (await stream.ReadAsync(next, deadline.Token).ConfigureAwait(false) == 0) throw new IOException("Render upstream closed during response.");
                header.WriteByte(next[0]);
                var bytes = header.GetBuffer();
                var n = (int)header.Length;
                if (n >= 4 && bytes[n - 4] == '\r' && bytes[n - 3] == '\n' && bytes[n - 2] == '\r' && bytes[n - 1] == '\n') return header.ToArray();
            }
            throw new IOException("Render response header is too large.");
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new TimeoutException("Render response timed out."); }
    }

    private static async Task CopyBodyAsync(Stream upstream, Stream browser, Dictionary<string, string> headers, CancellationToken token)
    {
        if (headers.ContainsKey("Transfer-Encoding"))
        {
            var trailerBytes = 0;
            while (true)
            {
                var line = await ReadLineAsync(upstream, token).ConfigureAwait(false);
                if (!long.TryParse(line.Split(';')[0], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var length) || length < 0)
                    throw new IOException("Invalid render chunk.");
                await WriteAsync(browser, Encoding.ASCII.GetBytes(line + "\r\n"), token).ConfigureAwait(false);
                if (length == 0)
                {
                    do
                    {
                        line = await ReadLineAsync(upstream, token).ConfigureAwait(false);
                        trailerBytes += line.Length + 2;
                        if (trailerBytes > CouchCoopHttpRequest.MaxHeaderBytes) throw new IOException("Render trailers too large.");
                        // Trailers cannot replace response policy or cache headers.
                    } while (line.Length != 0);
                    await WriteAsync(browser, "\r\n"u8.ToArray(), token).ConfigureAwait(false);
                    return;
                }
                await CopyLengthAsync(upstream, browser, length, token).ConfigureAwait(false);
                if (await ReadLineAsync(upstream, token).ConfigureAwait(false) != "") throw new IOException("Invalid render chunk terminator.");
                await WriteAsync(browser, "\r\n"u8.ToArray(), token).ConfigureAwait(false);
            }
        }
        else if (headers.TryGetValue("Content-Length", out var length))
            await CopyLengthAsync(upstream, browser, long.Parse(length, CultureInfo.InvariantCulture), token).ConfigureAwait(false);
        else await PumpAsync(upstream, browser, token).ConfigureAwait(false);
    }

    private static async Task<string> ReadLineAsync(Stream stream, CancellationToken token)
    {
        var bytes = new List<byte>();
        var next = new byte[1];
        while (bytes.Count < 8192)
        {
            if (await ReadAsync(stream, next, token).ConfigureAwait(false) == 0) throw new IOException("Truncated render chunk.");
            bytes.Add(next[0]);
            if (bytes.Count >= 2 && bytes[^2] == '\r' && bytes[^1] == '\n') return Encoding.ASCII.GetString(bytes.ToArray(), 0, bytes.Count - 2);
        }
        throw new IOException("Render chunk line too large.");
    }

    private static async Task CopyLengthAsync(Stream source, Stream target, long length, CancellationToken token)
    {
        var bytes = new byte[16 * 1024];
        while (length > 0)
        {
            var read = await ReadAsync(source, bytes.AsMemory(0, (int)Math.Min(length, bytes.Length)), token).ConfigureAwait(false);
            if (read == 0) throw new IOException("Truncated render body.");
            await WriteAsync(target, bytes.AsMemory(0, read), token).ConfigureAwait(false);
            length -= read;
        }
    }

    private static async Task ObserveViewerAsync(Stream browser, Stream? upstream, CancellationToken token)
    {
        var bytes = new byte[16 * 1024];
        while (true)
        {
            var read = await browser.ReadAsync(bytes, token).ConfigureAwait(false);
            if (read == 0) return;
            if (upstream is not null) await WriteAsync(upstream, bytes.AsMemory(0, read), token).ConfigureAwait(false);
        }
    }

    private static async Task PumpAsync(Stream source, Stream target, CancellationToken token, bool idleDeadline = true)
    {
        var bytes = new byte[16 * 1024];
        int read;
        while ((read = idleDeadline ? await ReadAsync(source, bytes, token).ConfigureAwait(false)
                   : await source.ReadAsync(bytes, token).ConfigureAwait(false)) > 0)
            await WriteAsync(target, bytes.AsMemory(0, read), token).ConfigureAwait(false);
    }

    private static async Task<int> ReadAsync(Stream stream, Memory<byte> bytes, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(ResponseTimeout);
        return await stream.ReadAsync(bytes, deadline.Token).ConfigureAwait(false);
    }

    private static async Task WriteAsync(Stream stream, ReadOnlyMemory<byte> bytes, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(HttpResponseWriter.NetworkWriteTimeout);
        await stream.WriteAsync(bytes, deadline.Token).ConfigureAwait(false);
    }

    private static bool IsConnectionEnd(Exception error)
        => error is IOException or OperationCanceledException or ObjectDisposedException;
}
