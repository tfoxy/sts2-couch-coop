using System.Security.Cryptography;
using System.Text;
using Spirectl.Sts2;

namespace CouchCoop.Mod.Server;

// On-disk cache for /res asset BYTES (textures, Spine PNGs, scene JSON, localization, fonts). The
// spirectl asset seam renders/extracts each asset on the Godot MAIN THREAD (slow — especially Spine
// sprites, which render to PNG); a disk hit serves the bytes straight from a background thread with no
// main-thread hop. Asset keys (res:// / model:// / composed://) are static per path/id, so cached bytes
// never go stale within a game/mod version — CouchCoopCacheRoot owns invalidation across upgrades, and
// across the two game branches that render different pixels for the same key.
public sealed class SpirectlAssetBinaryCache
{
    // The two generations that decide whether cached bytes are still readable: CouchCoop's own (what WE store
    // and how it is addressed) and spirectl's (what a key RENDERS — composed spine placement, shaded bakes,
    // raw-vs-JSON resource docs). Both move on their own schedule, which is why they are two numbers rather
    // than one, and neither appears in a path any more: CouchCoopCacheRoot stamps them into the branch
    // directory's identity file, and a move there empties the directory instead of orphaning a sibling.
    //
    // Public so the session envelope's assetCacheToken (WS-U) folds the server asset schema into the CLIENT
    // cache's invalidation key — a generation bump re-namespaces the client cache exactly as it invalidates
    // this one.
    public static readonly string SchemaVersion =
        $"couchcoop-cache-v{CouchCoopCacheRoot.CacheVersion}+sp{SpirectlSts2Runtime.AssetPayloadVersion}";
    private readonly string? _root;
    private readonly ManagedCacheQuota? _quota;

    public SpirectlAssetBinaryCache(string? root = null) : this(root, null) { }

    internal SpirectlAssetBinaryCache(string? root, ManagedCacheQuota? quota)
    {
        // An explicitly-passed root (tests, benches, the hosted harness) is NOT branch scoped — those callers own
        // a scratch directory and wipe it themselves — but it still gets the same `assets/` leaf the branch
        // layout uses, so there is exactly one on-disk shape for anything that walks a cache to recognise.
        if (!string.IsNullOrWhiteSpace(root))
        {
            _root = Path.Combine(root, CouchCoopCacheRoot.AssetsFolderName);
            _quota = quota ?? CreateQuota(root);
            return;
        }

        _root = CouchCoopCacheRoot.AssetsRoot;
        _quota = _root is null ? null : quota ?? CouchCoopCacheRoot.Quota;
    }

    public bool IsEnabled => _root is not null;

    public string? RootPath => _root;

    internal ManagedCacheQuota? Quota => _quota;

    public async Task<SpirectlAssetCacheEntry?> TryReadAsync(string assetKey, CancellationToken cancellationToken = default)
    {
        if (_root is null)
        {
            return null;
        }

        var (binPath, metaPath) = PathsFor(assetKey);
        if (!File.Exists(binPath) || !File.Exists(metaPath))
        {
            return null;
        }

        try
        {
            var bytes = await File.ReadAllBytesAsync(binPath, cancellationToken).ConfigureAwait(false);
            var contentType = (await File.ReadAllTextAsync(metaPath, cancellationToken).ConfigureAwait(false)).Trim();
            return new SpirectlAssetCacheEntry(
                bytes,
                string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// The SIZE of a cached blob without reading it, or null when it is not cached. For measurement only — the
    /// geoclip sweep compares a rig's delta bytes against the raster stills they would replace, and reading a few
    /// hundred multi-hundred-KB webps to learn their lengths would cost more than the comparison is worth.
    /// </summary>
    public long? TryMeasureBytes(string assetKey)
    {
        if (_root is null || string.IsNullOrWhiteSpace(assetKey))
        {
            return null;
        }

        var (binPath, metaPath) = PathsFor(assetKey);
        try
        {
            // Both files, exactly as TryReadAsync requires: a .bin without its .meta is not a cache hit.
            return File.Exists(binPath) && File.Exists(metaPath) ? new FileInfo(binPath).Length : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public async Task WriteAsync(string assetKey, byte[] bytes, string? contentType, CancellationToken cancellationToken = default)
    {
        await TryWriteAsync(assetKey, bytes, contentType, cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> TryWriteAsync(string assetKey, byte[] bytes, string? contentType, CancellationToken cancellationToken = default)
    {
        if (_root is null)
        {
            return false;
        }

        var (binPath, metaPath) = PathsFor(assetKey);
        var metaBytes = Encoding.UTF8.GetByteCount(
            string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType);
        using var reservation = _quota?.TryReserve(checked((long)bytes.Length + metaBytes));
        if (reservation is null)
        {
            return false;
        }
        var suffix = "." + Guid.NewGuid().ToString("N") + ".tmp";
        var tempBin = binPath + suffix;
        var tempMeta = metaPath + suffix;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(binPath)!);
            // Atomic temp-then-move so a concurrent reader never sees a half-written file.
            await File.WriteAllBytesAsync(tempBin, bytes, cancellationToken).ConfigureAwait(false);
            File.Move(tempBin, binPath, overwrite: true);

            await File.WriteAllTextAsync(
                tempMeta,
                string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType,
                cancellationToken).ConfigureAwait(false);
            File.Move(tempMeta, metaPath, overwrite: true);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Best-effort cache; ignore write failures.
            return false;
        }
        finally
        {
            foreach (var temporary in new[] { tempBin, tempMeta })
            {
                try { File.Delete(temporary); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    private (string BinPath, string MetaPath) PathsFor(string assetKey)
    {
        var scheme = SchemeOf(assetKey);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(assetKey))).ToLowerInvariant();
        var dir = Path.Combine(_root!, scheme);
        return (Path.Combine(dir, hash + ".bin"), Path.Combine(dir, hash + ".meta"));
    }

    private static string SchemeOf(string assetKey)
    {
        var index = assetKey.IndexOf("://", StringComparison.Ordinal);
        return index <= 0 ? "other" : assetKey[..index];
    }

    internal static ManagedCacheQuota CreateQuota(string cacheRoot)
        => ManagedCacheQuota.ForCacheRoot(cacheRoot);
}

public sealed record SpirectlAssetCacheEntry(byte[] Bytes, string ContentType);
