using System.Buffers;
using System.Net;
using System.Text;

namespace CouchCoop.Mod.Server;

public sealed class CouchCoopHttpRequest
{
    public const int MaxHeaderBytes = 32 * 1024;
    internal const int HeaderReadChunkBytes = 4 * 1024;
    public static readonly TimeSpan HeaderReadTimeout = TimeSpan.FromSeconds(10);
    private readonly IReadOnlyDictionary<string, string> _queryValues;

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
        _queryValues = ParseQuery(query);
    }

    public string Method { get; }

    public string Target { get; }

    public string RawPath { get; }

    public string Path { get; }

    public string Query { get; }

    public IReadOnlyDictionary<string, string> Headers { get; }

    public string? Name => QueryValues.TryGetValue("name", out var value) ? value : null;

    public IReadOnlyDictionary<string, string> QueryValues => _queryValues;

    public bool IsWebSocketUpgrade =>
        Headers.TryGetValue("Upgrade", out var upgrade)
        && string.Equals(upgrade, "websocket", StringComparison.OrdinalIgnoreCase)
        && Headers.TryGetValue("Connection", out var connection)
        && connection.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Any(value => string.Equals(value, "Upgrade", StringComparison.OrdinalIgnoreCase));

    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;

    public static async Task<CouchCoopHttpRequest?> TryReadAsync(Stream stream, CancellationToken cancellationToken = default)
    {
        // Preserve this legacy public entry point's exact-read contract: callers receive only the parsed request,
        // so it must leave a following body/frame on the underlying stream rather than overread and discard it.
        using var read = await TryReadWithPrefixAsync(
            stream, ArrayPool<byte>.Shared, HeaderReadTimeout, readChunkBytes: 1,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return read?.Request;
    }

    /// <summary>
    /// Reads one request header and returns a stream that replays any body or WebSocket bytes received in the
    /// final header read before continuing from <paramref name="stream"/>.
    /// </summary>
    public static Task<CouchCoopHttpReadResult?> TryReadWithPrefixAsync(
        Stream stream,
        CancellationToken cancellationToken = default)
        => TryReadWithPrefixAsync(
            stream, ArrayPool<byte>.Shared, HeaderReadTimeout, HeaderReadChunkBytes, cancellationToken);

    internal static async Task<CouchCoopHttpReadResult?> TryReadWithPrefixAsync(
        Stream stream,
        ArrayPool<byte> bufferPool,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
        => await TryReadWithPrefixAsync(
            stream, bufferPool, timeout, HeaderReadChunkBytes, cancellationToken).ConfigureAwait(false);

    private static async Task<CouchCoopHttpReadResult?> TryReadWithPrefixAsync(
        Stream stream,
        ArrayPool<byte> bufferPool,
        TimeSpan timeout,
        int readChunkBytes,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        ArgumentNullException.ThrowIfNull(bufferPool);

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        var buffer = bufferPool.Rent(MaxHeaderBytes);
        var ownsBuffer = true;
        var count = 0;
        try
        {
            while (count < MaxHeaderBytes)
            {
                // A single bounded overread replaces one network read per header byte. PrefixPreservingStream
                // replays anything after CRLFCRLF, so an eager client may send a POST body or its first WebSocket
                // frame in the same packet without those bytes being lost at the protocol handoff.
                var read = await stream.ReadAsync(
                    buffer.AsMemory(count, Math.Min(readChunkBytes, MaxHeaderBytes - count)),
                    deadline.Token).ConfigureAwait(false);
                if (read == 0)
                {
                    return null;
                }

                var previousCount = count;
                count += read;
                var headerLength = FindHeaderTerminator(buffer, Math.Max(0, previousCount - 3), count);
                if (headerLength >= 0)
                {
                    if (headerLength > MaxHeaderBytes)
                    {
                        throw new HttpHeaderLimitException();
                    }

                    var request = Parse(buffer, headerLength);
                    if (request is null)
                    {
                        return null;
                    }

                    var prefixCount = count - headerLength;
                    var prefixBuffer = buffer;
                    var prefixOffset = headerLength;
                    if (prefixCount > 0)
                    {
                        // The header rent is exactly 32 KiB, while bounded overread is at most one 4 KiB chunk.
                        // Keep only that small prefix across the route/upgrade handoff.
                        prefixBuffer = bufferPool.Rent(prefixCount);
                        buffer.AsSpan(headerLength, prefixCount).CopyTo(prefixBuffer);
                        prefixOffset = 0;
                        bufferPool.Return(buffer);
                        ownsBuffer = false;
                    }
                    else
                    {
                        ownsBuffer = false;
                    }

                    var prefixed = new PrefixPreservingStream(
                        stream,
                        bufferPool,
                        prefixBuffer,
                        prefixOffset,
                        prefixCount);
                    return new CouchCoopHttpReadResult(request, prefixed);
                }
            }

            throw new HttpHeaderLimitException();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new HttpHeaderTimeoutException();
        }
        finally
        {
            if (ownsBuffer)
            {
                bufferPool.Return(buffer);
            }
        }
    }

    private static int FindHeaderTerminator(byte[] buffer, int start, int count)
    {
        for (var index = start; index <= count - 4; index++)
        {
            if (buffer[index] == '\r' && buffer[index + 1] == '\n'
                && buffer[index + 2] == '\r' && buffer[index + 3] == '\n')
            {
                return index + 4;
            }
        }

        return -1;
    }

    private static CouchCoopHttpRequest? Parse(byte[] buffer, int headerLength)
    {
        var headerText = Encoding.ASCII.GetString(buffer, 0, headerLength);
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

public sealed class CouchCoopHttpReadResult : IDisposable
{
    private readonly PrefixPreservingStream _stream;

    internal CouchCoopHttpReadResult(CouchCoopHttpRequest request, PrefixPreservingStream stream)
    {
        Request = request;
        _stream = stream;
    }

    public CouchCoopHttpRequest Request { get; }

    public Stream Stream => _stream;

    public void Dispose() => _stream.Dispose();
}

internal sealed class PrefixPreservingStream : Stream
{
    private readonly Stream _inner;
    private readonly ArrayPool<byte> _bufferPool;
    private byte[]? _prefixBuffer;
    private int _prefixOffset;
    private int _prefixCount;

    public PrefixPreservingStream(
        Stream inner,
        ArrayPool<byte> bufferPool,
        byte[] prefixBuffer,
        int prefixOffset,
        int prefixCount)
    {
        _inner = inner;
        _bufferPool = bufferPool;
        _prefixBuffer = prefixBuffer;
        _prefixOffset = prefixOffset;
        _prefixCount = prefixCount;
        if (prefixCount == 0) ReleasePrefix();
    }

    public override bool CanRead => _inner.CanRead;
    public override bool CanSeek => false;
    public override bool CanWrite => _inner.CanWrite;
    public override bool CanTimeout => _inner.CanTimeout;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int ReadTimeout { get => _inner.ReadTimeout; set => _inner.ReadTimeout = value; }
    public override int WriteTimeout { get => _inner.WriteTimeout; set => _inner.WriteTimeout = value; }

    public override int Read(byte[] buffer, int offset, int count)
    {
        ArgumentNullException.ThrowIfNull(buffer);
        if (TryCopyPrefix(buffer.AsSpan(offset, count), out var copied)) return copied;
        return _inner.Read(buffer, offset, count);
    }

    public override int Read(Span<byte> buffer)
    {
        if (TryCopyPrefix(buffer, out var copied)) return copied;
        return _inner.Read(buffer);
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(buffer);
        cancellationToken.ThrowIfCancellationRequested();
        return TryCopyPrefix(buffer.AsSpan(offset, count), out var copied)
            ? Task.FromResult(copied)
            : _inner.ReadAsync(buffer, offset, count, cancellationToken);
    }

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return TryCopyPrefix(buffer.Span, out var copied)
            ? ValueTask.FromResult(copied)
            : _inner.ReadAsync(buffer, cancellationToken);
    }

    public override void Write(byte[] buffer, int offset, int count) => _inner.Write(buffer, offset, count);
    public override void Write(ReadOnlySpan<byte> buffer) => _inner.Write(buffer);
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        => _inner.WriteAsync(buffer, offset, count, cancellationToken);
    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        => _inner.WriteAsync(buffer, cancellationToken);
    public override void Flush() => _inner.Flush();
    public override Task FlushAsync(CancellationToken cancellationToken) => _inner.FlushAsync(cancellationToken);
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        ReleasePrefix();
        base.Dispose(disposing);
    }

    public override ValueTask DisposeAsync()
    {
        ReleasePrefix();
        GC.SuppressFinalize(this);
        return ValueTask.CompletedTask;
    }

    private bool TryCopyPrefix(Span<byte> destination, out int copied)
    {
        copied = 0;
        // A zero-byte read must not wait on the network while replay bytes are already buffered.
        // Leave the prefix intact for the next nonempty read.
        if (destination.Length == 0 && _prefixBuffer is not null && _prefixCount > 0)
        {
            return true;
        }

        if (_prefixBuffer is null || _prefixCount == 0)
        {
            if (_prefixCount == 0) ReleasePrefix();
            return false;
        }

        copied = Math.Min(destination.Length, _prefixCount);
        _prefixBuffer.AsSpan(_prefixOffset, copied).CopyTo(destination);
        _prefixOffset += copied;
        _prefixCount -= copied;
        if (_prefixCount == 0) ReleasePrefix();
        return true;
    }

    private void ReleasePrefix()
    {
        var buffer = Interlocked.Exchange(ref _prefixBuffer, null);
        if (buffer is not null)
        {
            _bufferPool.Return(buffer);
        }
        _prefixOffset = 0;
        _prefixCount = 0;
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
