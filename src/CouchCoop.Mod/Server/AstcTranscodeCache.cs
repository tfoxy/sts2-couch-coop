using System.Security.Cryptography;

namespace CouchCoop.Mod.Server;

// Track F2a: the host-side ASTC transcode cache the `/res/{path}?fmt=astc` route serves from. It is CONTENT-
// ADDRESSED: the sidecar batch (scripts/transcode-texture-cache.mjs) transcodes each served PNG/WEBP blob to a
// CCTX/ASTC-4x4 container keyed by the sha256 of the SOURCE bytes → <root>/astc/<sha256>.cctx. The route hashes
// the response body it is about to send and, on a hit, serves the precompressed container instead; on a miss it
// serves the original bytes UNCHANGED and drops the source into <root>/pending/<sha256>.bin so the next sidecar
// run can encode it. Content addressing means the same cache serves BOTH clients identically and needs no asset-
// key→path bookkeeping (the replay bench proxy uses the exact same hash-of-origin-bytes lookup).
//
// This class NEVER encodes (Image.compress is TOOLS_ENABLED-only and must not run inside the game process) and
// NEVER blocks the request: reads are a small File.Exists + File.ReadAllBytes; the pending drop is fire-and-forget.
public sealed class AstcTranscodeCache
{
    // The transcode-cache root layout — <root>/astc/<sha256>.cctx + <root>/pending/<sha256>.bin — is shared VERBATIM
    // by the mod route (here), the sidecar batch (scripts/transcode-texture-cache.mjs), and the replay bench proxy
    // (scripts/replay-ws-server.mjs). No hidden schema subdir, so `--astc-cache <dir>` on the batch/proxy and this
    // route's root point at the same files. Rotate the whole root if the CCTX layout or ASTC encode settings change.
    private readonly string? _root;

    // Track T: tiny-PNG transcode threshold. Device measurement showed CCTX averages ~2.39x the source PNG bytes on
    // the wire, and tiny VFX PNGs (well under this threshold) inflate up to ~142x for ~zero GPU benefit — ASTC only
    // pays off once decode/mipgen/DRAM savings outweigh the container overhead. Sources below this are never queued
    // (RecordPending) and never looked up (TryReadForContent), so a stale cache still holding tiny cctx entries from
    // before this change serves the original bytes anyway. Mirrors DEFAULT_MIN_BYTES in
    // scripts/transcode-texture-cache.mjs and MIN_ASTC_SOURCE_BYTES in scripts/replay-ws-server.mjs — keep all three
    // in sync.
    private const int MinSourceBytesForAstc = 32768;
    private readonly string? _astcDir;
    private readonly string? _pendingDir;
    private readonly ManagedCacheQuota? _quota;
    private readonly SemaphoreSlim _pendingWrites = new(4, 4);

    public AstcTranscodeCache(string? root = null) : this(root, null) { }

    /// <summary>Points this cache at an operator-chosen directory, used verbatim.</summary>
    public const string RootEnvironmentVariable = "COUCHCOOP_ASTC_CACHE_ROOT";

    internal AstcTranscodeCache(string? root, ManagedCacheQuota? quota)
    {
        // An explicit root — the constructor argument, or the env override the sidecar batch and replay proxy
        // are pointed at with `--astc-cache` — is used VERBATIM. Re-scoping it would point this route at files
        // those tools never wrote. Only the default path goes through the version-scoped, purge-on-stale root.
        var configured = string.IsNullOrWhiteSpace(root)
            ? Environment.GetEnvironmentVariable(RootEnvironmentVariable)
            : root;
        // The default root is the VERSION directory itself: this cache owns two leaves under it (`astc/` and
        // `pending/`) rather than one, so it hangs them beside `assets/` and `geoclips/` instead of nesting.
        var explicitRoot = !string.IsNullOrWhiteSpace(configured);
        var resolved = explicitRoot ? configured : CouchCoopCacheRoot.VersionRoot;
        if (string.IsNullOrWhiteSpace(resolved))
        {
            return;
        }

        _root = resolved;
        _astcDir = Path.Combine(_root, "astc");
        _pendingDir = Path.Combine(_root, "pending");
        _quota = quota ?? (explicitRoot ? CreateQuota(_root) : CouchCoopCacheRoot.Quota);
    }

    public bool IsEnabled => _root is not null;

    public string? RootPath => _root;

    // Return the precompressed CCTX bytes for `sourceBytes` when the sidecar has already transcoded them, else null.
    // Content-addressed by sha256(sourceBytes). Small synchronous read (fine on the request thread).
    public byte[]? TryReadForContent(byte[] sourceBytes)
    {
        if (_astcDir is null || sourceBytes.Length < MinSourceBytesForAstc)
        {
            return null;
        }

        var path = Path.Combine(_astcDir, Sha256Hex(sourceBytes) + ".cctx");
        try
        {
            return File.Exists(path) ? File.ReadAllBytes(path) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // Record `sourceBytes` for background transcode (fire-and-forget; never blocks the request, never execs). Writes
    // the raw source into the pending inbox keyed by content hash so the OUT-OF-PROCESS sidecar is self-sufficient.
    // No-op when the cctx already exists or the source is already pending (dedup by existence).
    public void RecordPending(byte[] sourceBytes)
    {
        if (_pendingDir is null || _astcDir is null || sourceBytes.Length < MinSourceBytesForAstc)
        {
            return;
        }

        var hash = Sha256Hex(sourceBytes);
        if (File.Exists(Path.Combine(_astcDir, hash + ".cctx"))
            || File.Exists(Path.Combine(_pendingDir, hash + ".bin")))
        {
            return;
        }
        if (!_pendingWrites.Wait(0))
        {
            return;
        }
        _ = Task.Run(() =>
        {
            string? temporary = null;
            try
            {
                if (File.Exists(Path.Combine(_astcDir, hash + ".cctx")))
                {
                    return; // already transcoded
                }

                var pending = Path.Combine(_pendingDir, hash + ".bin");
                if (File.Exists(pending))
                {
                    return; // already queued
                }

                using var reservation = _quota?.TryReserve(sourceBytes.LongLength);
                if (reservation is null) return;
                Directory.CreateDirectory(_pendingDir);
                temporary = pending + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    File.WriteAllBytes(temporary, sourceBytes);
                    File.Move(temporary, pending, overwrite: true);
                }
                finally
                {
                    try { File.Delete(temporary); }
                    catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // best-effort hint for the sidecar; a lost drop just means it waits for the next full cache sweep
            }
            finally { _pendingWrites.Release(); }
        });
    }

    private static ManagedCacheQuota CreateQuota(string astcRoot)
        => ManagedCacheQuota.ForCacheRoot(astcRoot);

    public static string Sha256Hex(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
