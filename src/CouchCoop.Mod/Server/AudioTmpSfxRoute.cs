using System.Net;
using Godot;
using CouchCoop.Mod.Runtime;

namespace CouchCoop.Mod.Server;

/// <summary>Serves the small set of game-owned MP3 streams used by TmpSfx audio events.</summary>
internal sealed class AudioTmpSfxRoute(IAudioTmpSfxSource source)
{
    private readonly IAudioTmpSfxSource _source = source;
    public const string Prefix = "/audio/tmpsfx/";
    public const int MaximumAssetBytes = 2 * 1024 * 1024;
    private const int MaximumMemoEntries = 16;
    private const int MaximumMemoBytes = 8 * 1024 * 1024;
    private const string CacheControl = "public, max-age=31536000, immutable";
    private readonly object _gate = new();
    private readonly Dictionary<string, (byte[] Bytes, LinkedListNode<string> Node)> _memo = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _lru = new();
    private int _memoBytes;

    internal int MemoCount { get { lock (_gate) return _memo.Count; } }
    internal int MemoBytes { get { lock (_gate) return _memoBytes; } }

    public async Task<bool> TryHandleAsync(
        Stream stream,
        CouchCoopHttpRequest request,
        CancellationToken cancellationToken)
    {
        if (!request.RawPath.StartsWith(Prefix, StringComparison.Ordinal)
            && !string.Equals(request.RawPath, "/audio/tmpsfx", StringComparison.Ordinal))
        {
            return false;
        }

        if (string.Equals(request.RawPath, "/audio/tmpsfx", StringComparison.Ordinal))
        {
            await RefuseAsync(stream, HttpStatusCode.BadRequest, "invalid-tmpsfx-path", cancellationToken).ConfigureAwait(false);
            return true;
        }

        string resourcePath;
        try
        {
            resourcePath = "res://" + Uri.UnescapeDataString(request.RawPath[Prefix.Length..]);
        }
        catch (UriFormatException)
        {
            await RefuseAsync(stream, HttpStatusCode.BadRequest, "invalid-tmpsfx-path", cancellationToken).ConfigureAwait(false);
            return true;
        }

        if (!IsAllowedResourcePath(resourcePath))
        {
            await RefuseAsync(stream, HttpStatusCode.BadRequest, "invalid-tmpsfx-path", cancellationToken).ConfigureAwait(false);
            return true;
        }

        var bytes = GetMemo(resourcePath);
        if (bytes is null)
        {
            bytes = _source.TryLoadMp3(resourcePath);
            if (bytes is null)
            {
                await RefuseAsync(stream, HttpStatusCode.NotFound, "tmpsfx-not-found", cancellationToken).ConfigureAwait(false);
                return true;
            }

            if (bytes.Length == 0 || bytes.Length > MaximumAssetBytes)
            {
                await RefuseAsync(stream, (HttpStatusCode)413, "tmpsfx-too-large", cancellationToken).ConfigureAwait(false);
                return true;
            }

            bytes = Remember(resourcePath, bytes);
        }

        await HttpResponseWriter.WriteBytesAsync(
            stream,
            (int)HttpStatusCode.OK,
            "OK",
            bytes,
            "audio/mpeg",
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Cache-Control"] = CacheControl },
            cancellationToken).ConfigureAwait(false);
        return true;
    }

    internal static bool IsAllowedResourcePath(string? path)
    {
        if (!BrowserResourcePath.IsSafeResPath(path)
            || !path!.StartsWith("res://debug_audio/", StringComparison.Ordinal))
        {
            return false;
        }

        var filename = path["res://debug_audio/".Length..];
        // The game's TmpSfx directory is flat. Refuse subdirectories so this stays a narrow resource surface.
        return filename.Length > 4
            && !filename.Contains('/', StringComparison.Ordinal)
            && filename.EndsWith(".mp3", StringComparison.OrdinalIgnoreCase);
    }

    private byte[]? GetMemo(string key)
    {
        lock (_gate)
        {
            if (!_memo.TryGetValue(key, out var entry)) return null;
            _lru.Remove(entry.Node);
            _lru.AddFirst(entry.Node);
            return entry.Bytes;
        }
    }

    private byte[] Remember(string key, byte[] bytes)
    {
        // Copy before retaining or returning the memoized value: provider-owned mutable buffers cannot mutate
        // bytes already handed to another response.
        var immutable = bytes.ToArray();
        lock (_gate)
        {
            if (_memo.TryGetValue(key, out var existing))
            {
                _lru.Remove(existing.Node);
                _memoBytes -= existing.Bytes.Length;
                _memo.Remove(key);
            }

            while (_memo.Count >= MaximumMemoEntries || _memoBytes + immutable.Length > MaximumMemoBytes)
            {
                var oldest = _lru.Last;
                if (oldest is null) break;
                var victim = _memo[oldest.Value];
                _memoBytes -= victim.Bytes.Length;
                _memo.Remove(oldest.Value);
                _lru.RemoveLast();
            }

            var node = _lru.AddFirst(key);
            _memo.Add(key, (immutable, node));
            _memoBytes += immutable.Length;
        }

        return immutable;
    }

    private static Task RefuseAsync(Stream stream, HttpStatusCode status, string code, CancellationToken cancellationToken) =>
        HttpResponseWriter.WriteJsonErrorAsync(stream, status, code, "The requested TmpSfx resource is unavailable.", cancellationToken);
}

internal interface IAudioTmpSfxSource
{
    byte[]? TryLoadMp3(string resourcePath);
}

internal sealed class GodotAudioTmpSfxSource : IAudioTmpSfxSource
{
    public byte[]? TryLoadMp3(string resourcePath) => GameMainThread.Invoke(() =>
    {
        // The generic type check is the route's type boundary: a same-named non-MP3 resource is never returned.
        var stream = ResourceLoader.Load<AudioStreamMP3>(resourcePath);
        return stream is null ? null : stream.Data.ToArray();
    });
}
