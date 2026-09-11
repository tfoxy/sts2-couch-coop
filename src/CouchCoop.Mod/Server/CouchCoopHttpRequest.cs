using System.Net;
using System.Text;

namespace CouchCoop.Mod.Server;

public sealed class CouchCoopHttpRequest
{
    public const int MaxHeaderBytes = 32 * 1024;
    public static readonly TimeSpan HeaderReadTimeout = TimeSpan.FromSeconds(10);
    private CouchCoopHttpRequest(
        string method,
        string target,
        string rawPath,
        string path,
        string query,
        IReadOnlyDictionary<string, string> headers)
    {
        Method = method;
        Target = target;
        RawPath = rawPath;
        Path = path;
        Query = query;
        Headers = headers;
    }

    public string Method { get; }

    public string Target { get; }

    public string RawPath { get; }

    public string Path { get; }

    public string Query { get; }

    public IReadOnlyDictionary<string, string> Headers { get; }

    public string? Name => QueryValues.TryGetValue("name", out var value) ? value : null;

    public IReadOnlyDictionary<string, string> QueryValues => ParseQuery(Query);

    public bool IsWebSocketUpgrade =>
        Headers.TryGetValue("Upgrade", out var upgrade)
        && string.Equals(upgrade, "websocket", StringComparison.OrdinalIgnoreCase)
        && Headers.TryGetValue("Connection", out var connection)
        && connection.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Any(value => string.Equals(value, "Upgrade", StringComparison.OrdinalIgnoreCase));

    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;

    public static async Task<CouchCoopHttpRequest?> TryReadAsync(Stream stream, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(HeaderReadTimeout);
        var buffer = new byte[MaxHeaderBytes];
        var count = 0;
        try
        {
            while (count < buffer.Length)
            {
                // This raw server has no buffered-stream handoff. Stop exactly at CRLFCRLF so bytes from the first
                // WebSocket frame cannot be consumed here and then lost when WebSocket.CreateFromStream takes over.
                var read = await stream.ReadAsync(buffer.AsMemory(count, 1), deadline.Token).ConfigureAwait(false);
                if (read == 0)
                {
                    return null;
                }

                count += read;
                if (count >= 4
                    && buffer[count - 4] == '\r' && buffer[count - 3] == '\n'
                    && buffer[count - 2] == '\r' && buffer[count - 1] == '\n')
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new HttpHeaderTimeoutException();
        }

        if (count < 4 || buffer[count - 4] != '\r' || buffer[count - 3] != '\n'
            || buffer[count - 2] != '\r' || buffer[count - 1] != '\n')
        {
            throw new HttpHeaderLimitException();
        }

        var headerText = Encoding.ASCII.GetString(buffer, 0, count);
        var lines = headerText.Split("\r\n", StringSplitOptions.None);
        if (lines.Length == 0)
        {
            return null;
        }

        var requestParts = lines[0].Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
        if (requestParts.Length < 2)
        {
            return null;
        }

        var method = requestParts[0];
        var target = requestParts[1];
        var question = target.IndexOf('?', StringComparison.Ordinal);
        var rawPath = question >= 0 ? target[..question] : target;
        var query = question >= 0 ? target[(question + 1)..] : string.Empty;
        var path = string.IsNullOrEmpty(rawPath) ? "/" : Uri.UnescapeDataString(rawPath);

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            if (string.IsNullOrEmpty(line))
            {
                break;
            }

            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon <= 0)
            {
                continue;
            }

            headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
        }

        return new CouchCoopHttpRequest(method, target, rawPath, path, query, headers);
    }

    private static IReadOnlyDictionary<string, string> ParseQuery(string query)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(query))
        {
            return values;
        }

        foreach (var part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = part.IndexOf('=', StringComparison.Ordinal);
            var key = equals >= 0 ? part[..equals] : part;
            var value = equals >= 0 ? part[(equals + 1)..] : string.Empty;
            values[WebUtility.UrlDecode(key)] = WebUtility.UrlDecode(value);
        }

        return values;
    }
}

public sealed class HttpHeaderLimitException : IOException
{
    public HttpHeaderLimitException() : base("HTTP headers were not complete within 32 KiB.") { }
}

public sealed class HttpHeaderTimeoutException : IOException
{
    public HttpHeaderTimeoutException() : base("HTTP headers were not complete within 10 seconds.") { }
}
