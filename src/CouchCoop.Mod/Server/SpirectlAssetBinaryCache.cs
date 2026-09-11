using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using Spirectl.Sts2;

namespace CouchCoop.Mod.Server;

// On-disk cache for /res asset BYTES (textures, Spine PNGs, scene JSON, localization, fonts). The
// spirectl asset seam renders/extracts each asset on the Godot MAIN THREAD (slow — especially Spine
// sprites, which render to PNG); a disk hit serves the bytes straight from a background thread with no
// main-thread hop. Asset keys (res:// / model:// / composed://) are static per path/id, so cached bytes
// never go stale within a game/mod version — the schema-version subfolder invalidates across upgrades.
public sealed class SpirectlAssetBinaryCache
{
    // The generation of the asset BYTES this cache holds. It is spirectl's own payload-shape version, not a
    // number kept here: every one of the twelve bumps this constant went through was a spirectl-side change to
    // what a key renders (composed spine placement, shaded bakes, raw-vs-JSON resource docs), spotted by hand
    // after the fact and rolled here — an out-of-band count that could only ever be late. spirectl now publishes
    // the number it bumps when it changes those bytes, so the invalidation happens with the change that caused
    // it. The value is 13, the generation this cache had already reached, so adopting it invalidated nothing.
    //
    // Public so the session envelope's assetCacheToken (WS-U) folds the server asset schema into the CLIENT disk
    // cache's invalidation key — a schema bump re-namespaces the client cache exactly as it invalidates this one.
    //
    // A cache-visible change on OUR side (the key grammar, the blob container, what we choose to store) is not
    // covered by spirectl's number: add a local suffix here if that ever happens.
    public static readonly string SchemaVersion = $"couchcoop-asset-cache-v{SpirectlSts2Runtime.AssetPayloadVersion}";
    private readonly string? _root;
    private readonly ManagedCacheQuota? _quota;

    public SpirectlAssetBinaryCache(string? root = null) : this(root, null) { }

    internal SpirectlAssetBinaryCache(string? root, ManagedCacheQuota? quota)
    {
        var resolved = string.IsNullOrWhiteSpace(root) ? DefaultRoot() : root;
        _root = string.IsNullOrWhiteSpace(resolved) ? null : Path.Combine(resolved, SchemaVersion);
        _quota = _root is null ? null : quota ?? CreateQuota(resolved!);
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

    /// <summary>
    /// The machine's asset-cache ROOT — the directory every couch-coop on-disk cache hangs its own
    /// schema-version folder under (this one appends <see cref="SchemaVersion"/>;
    /// <see cref="CouchCoopGeoclipStore"/> appends its own). Internal rather than private so the geoclip store
    /// resolves the root the SAME way instead of re-deriving it: the <c>COUCHCOOP_CACHE_ROOT</c> override, the
    /// GodotSharp-guarded game data dir, and the LocalApplicationData fallback are one policy, and the tests'
    /// temp-root override has to move both caches or it moves neither.
    /// </summary>
    internal static string? DefaultRoot()
    {
        var configured = Environment.GetEnvironmentVariable("COUCHCOOP_CACHE_ROOT");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return Path.Combine(configured, "assets");
        }

        // GodotSharp is provided by the running game, not the test/headless runner — referencing it can
        // throw an assembly-load failure when the method is JIT-compiled, so the call is isolated in a
        // non-inlined method and the failure is caught HERE (a try INSIDE that method would never run).
        string? gameDir = null;
        try
        {
            gameDir = TryResolveGameDataDir();
        }
        catch
        {
            // GodotSharp unavailable (headless/test) — fall back below.
        }

        if (!string.IsNullOrWhiteSpace(gameDir))
        {
            return gameDir;
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return string.IsNullOrWhiteSpace(local)
            ? Path.Combine(Path.GetTempPath(), "SlayTheSpire2", "couch-coop", "assets")
            : Path.Combine(local, "SlayTheSpire2", "couch-coop", "assets");
    }

    internal static ManagedCacheQuota CreateQuota(string assetRoot)
        => ManagedCacheQuota.ForAssetRoot(assetRoot);

    // The game data dir (where the game writes logs) is Godot's user://; GlobalizePath converts it to an
    // absolute OS path. The user asked for a `couch-coop` folder beside `logs`, so the cache lives at
    // user://couch-coop/assets. Must be called on the Godot main thread (this runs at mod init).
    // NoInlining keeps the GodotSharp reference out of the caller's JIT so the caller can catch a load
    // failure when GodotSharp is absent.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static string? TryResolveGameDataDir()
    {
        var globalized = Godot.ProjectSettings.GlobalizePath("user://couch-coop/assets");
        return string.IsNullOrWhiteSpace(globalized) || globalized.StartsWith("user://", StringComparison.Ordinal)
            ? null
            : globalized;
    }
}

public sealed record SpirectlAssetCacheEntry(byte[] Bytes, string ContentType);
