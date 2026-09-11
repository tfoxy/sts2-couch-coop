// WS-U (M3): ONE shared read-through / write-through disk byte cache for all four asset stores (TextureStore,
// FontStore, ShaderStore, SpineClipStore). Godot's HttpRequest ignores the server's `Cache-Control: immutable`, so
// every launch re-fetches ~83-103 atlas textures + multi-MB spine clips over the LAN. This cache serves those bytes
// from disk on the SECOND+ launch, keyed by the sha256 of each asset url under a per-token NAMESPACE directory.
//
// LAYOUT (mirrors the server's user://couch-coop/assets):  <root>/<tokenNamespace>/<sha256(relUrl)>.bin
//   root       = COUCHCOOP_ASSET_CACHE_ROOT (absolute; tests/e2e) OR ProjectSettings.GlobalizePath("user://couch-coop/assetcache/v1").
//   namespace  = the server-composed assetCacheToken (sanitized to a safe dir name). A token change = a new
//                namespace; the old one is pruned lazily. Seeded from the persisted `lastAssetToken` at Create so the
//                common warm case starts in the right namespace immediately (before the first `session` arrives).
//   No `.meta`: the stores sniff codec by magic on decode, so a content-type sidecar is unneeded.
//
// KILL SWITCH: env COUCHCOOP_ASSET_CACHE=0 disables at Create (authoritative; default ON). The SettingsPanel "Disk
// asset cache" toggle flips the static Enabled at runtime (seams re-check it each fetch). CAP: COUCHCOOP_ASSET_CACHE_MB
// (default 512) bounds the active namespace via an oldest-write-first prune (approximate-LRU: reads touch mtime).
//
// The cache NEVER touches the scene-delta apply path — only byte ACQUISITION — so state parity + the --shot settle
// gate are unaffected (a hit passes through the store's in-flight/waiter bookkeeping exactly like a network fetch).

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using CouchCoop.MirrorProtocol.Assets;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed class AssetDiskCache
{
    // user://settings.cfg [mirror] lastAssetToken — persists the active token so the next launch seeds the right
    // namespace before the first `session` message (belt-and-suspenders for the fetch-beats-session race).
    private const string SettingsPath = "user://settings.cfg";
    private const string CfgSection = "mirror";
    private const string CfgTokenKey = "lastAssetToken";
    // WS-PERSIST: the SettingsPanel "Disk asset cache" toggle is persisted under this key (by ClientSettingsStore).
    // Create() reads it as the enabled DEFAULT when the env kill switch is not set, so a user's persisted OFF survives
    // the next launch (Create otherwise re-forces Enabled from env on every render-stage mount). Same key as
    // ClientSettingsStore.DiskAssetCacheKey — duplicated here per the repo's each-owner-spells-out-its-key pattern.
    private const string CfgEnabledKey = "diskAssetCache";

    // The ONE shared instance (created in AppShell.MountRenderStage; nulled in ReturnToMenu — files persist on disk so
    // the cache is warm across a back-to-menu rebuild / reconnect).
    public static AssetDiskCache? Shared;

    // Default resolved at Create (see ResolveEnabledDefault): env COUCHCOOP_ASSET_CACHE=0 forces OFF, any other set
    // value forces ON, else the persisted SettingsPanel "Disk asset cache" toggle (default ON). The toggle flips this
    // at runtime too; every seam re-reads it, so a mid-session flip takes effect on the next fetch.
    public static bool Enabled;

    // Static counters (the cache is shared) surfaced in the settle line + BENCH_RESULT. Mutated ONLY on the main
    // thread (the store seams run there), so no interlock is needed.
    public static long Hits;
    public static long Misses;
    public static long Writes;

    private static bool _loggedFirstHit;
    private static bool _loggedFirstMiss;

    private readonly string _root;
    private readonly long _capBytes;
    private string _activeNamespace = "pending";
    private string _activeDir;
    private bool _prunedSiblings;

    private AssetDiskCache(string root, long capBytes)
    {
        _root = root;
        _capBytes = capBytes;
        _activeDir = AssetCachePaths.NamespaceDir(root, _activeNamespace);
    }

    public string ActiveNamespace => _activeNamespace;

    // Create the shared cache: read the env kill switch + cap, resolve the root, reset counters, and seed the active
    // namespace from the persisted lastAssetToken (else "pending"). Called at the top of AppShell.MountRenderStage,
    // BEFORE the stores are constructed. Idempotent per mount (a new stage replaces the old instance).
    public static void Create()
    {
        Enabled = ResolveEnabledDefault();
        Hits = 0;
        Misses = 0;
        Writes = 0;
        _loggedFirstHit = false;
        _loggedFirstMiss = false;

        var root = ResolveRoot();
        var cap = ResolveCapBytes();
        var cache = new AssetDiskCache(root, cap);

        var seed = ReadPersistedToken();
        cache._activeNamespace = AssetCachePaths.SanitizeToken(seed);
        cache._activeDir = AssetCachePaths.NamespaceDir(root, cache._activeNamespace);
        cache.PruneActiveToCapAsync(); // bound the seeded namespace's size on mount

        Shared = cache;
        GD.Print($"M3_CACHE: created enabled={Enabled} root='{root}' namespace={cache._activeNamespace} " +
                 $"capMB={cap / (1024 * 1024)}");
    }

    // Drop the shared instance (AppShell.ReturnToMenu teardown). Disk files persist (warm across reconnect); only the
    // singleton reference is cleared so the next stage's Create rebuilds it.
    public static void ResetInstance() => Shared = null;

    // "hits=H misses=M writes=W" — folded into the settle-begin log + the M1C_SHOT save line.
    public static string CounterSummary() => $"hits={Hits} misses={Misses} writes={Writes}";

    // ---- seam surface (called from the four stores' Fetch/RequestCompleted) --------------------------------------

    // Return the cached bytes for `relUrl` when the cache is enabled AND the entry exists; else null (a miss). Does
    // NOT count a hit — the seam counts a hit only AFTER a cache-sourced decode succeeds (a corrupt entry self-heals).
    public static byte[]? Read(string relUrl)
    {
        if (!Enabled || Shared is not { } cache)
        {
            return null;
        }

        return cache.TryRead(relUrl);
    }

    // The seam calls this once a cache-sourced blob has DECODED successfully (a real hit).
    public static void CountHit()
    {
        Hits++;
        if (!_loggedFirstHit)
        {
            _loggedFirstHit = true;
            GD.Print($"M3_CACHE: first disk hit (namespace={Shared?.ActiveNamespace})");
        }
    }

    // Write-through on an HTTP success (a miss that we now cache), enabled-guarded, and count it. The write itself is
    // off-thread + atomic (temp-then-move), so the store's decode/upload is never blocked.
    public static void Write(string relUrl, byte[] bytes)
    {
        if (!Enabled || Shared is not { } cache)
        {
            return;
        }

        cache.WriteThrough(relUrl, bytes);
        Misses++;
        Writes++;
        if (!_loggedFirstMiss)
        {
            _loggedFirstMiss = true;
            GD.Print($"M3_CACHE: first disk miss→write (namespace={Shared?.ActiveNamespace})");
        }
    }

    // ---- namespace ------------------------------------------------------------------------------------------------

    // Switch to the token's namespace on `session` arrival (AppShell wires SessionUpdated → here). Idempotent: a null
    // or equal token doesn't switch. On a real switch it re-bases the active dir, persists the token, and bounds the
    // new namespace to cap. On the FIRST call (switch or not) it lazily prunes every STALE sibling namespace.
    public void SetNamespace(string? token)
    {
        var sanitized = AssetCachePaths.SanitizeToken(token);
        bool changed = !string.Equals(sanitized, _activeNamespace, StringComparison.Ordinal);
        if (changed)
        {
            _activeNamespace = sanitized;
            _activeDir = AssetCachePaths.NamespaceDir(_root, _activeNamespace);
            PersistToken(sanitized);
            PruneActiveToCapAsync();
            GD.Print($"M3_CACHE: namespace → {sanitized}");
        }

        if (!_prunedSiblings)
        {
            _prunedSiblings = true;
            PruneSiblingNamespacesAsync();
        }
    }

    // ---- IO -------------------------------------------------------------------------------------------------------

    // Synchronous read of the `.bin` (small textures/fonts/shaders; multi-MB spine clips are read here but the store
    // pushes their decode off-thread). Best-effort mtime touch (off-thread) so warm assets survive prune. null on any
    // IO error (treated as a miss).
    public byte[]? TryRead(string relUrl)
    {
        var path = FilePath(relUrl);
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            var bytes = File.ReadAllBytes(path);
            TouchAsync(path);
            return bytes;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // Atomic temp-then-move write on a background thread (copies the server cache's proven pattern) so the store's
    // decode/GPU-upload is never blocked by disk IO. Best-effort: IO failures are swallowed (mirrors the server).
    public void WriteThrough(string relUrl, byte[] bytes)
    {
        var dir = _activeDir;
        var path = FilePath(relUrl);
        Task.Run(() =>
        {
            try
            {
                Directory.CreateDirectory(dir);
                var tmp = path + ".tmp";
                File.WriteAllBytes(tmp, bytes);
                File.Move(tmp, path, overwrite: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // best-effort cache
            }
        });
    }

    // Delete a single entry (self-heal: a cache-sourced blob that failed to decode is poisoned — drop it and let the
    // store re-fetch over HTTP). No-op when the entry is absent.
    public void DeleteEntry(string relUrl)
    {
        try
        {
            var path = FilePath(relUrl);
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // best-effort
        }
    }

    private string FilePath(string relUrl) =>
        Path.Combine(_activeDir, AssetCachePaths.Sha256Hex(relUrl) + ".bin");

    private static void TouchAsync(string path) =>
        Task.Run(() =>
        {
            try
            {
                File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
            }
            catch
            {
                // best-effort LRU touch
            }
        });

    // ---- prune ----------------------------------------------------------------------------------------------------

    private void PruneActiveToCapAsync()
    {
        var dir = _activeDir;
        var cap = _capBytes;
        Task.Run(() =>
        {
            try
            {
                if (!Directory.Exists(dir))
                {
                    return;
                }

                var files = new List<(string Path, long Size, DateTime WriteUtc)>();
                foreach (var path in Directory.GetFiles(dir, "*.bin"))
                {
                    try
                    {
                        var info = new FileInfo(path);
                        files.Add((path, info.Length, info.LastWriteTimeUtc));
                    }
                    catch
                    {
                        // skip a file we can't stat
                    }
                }

                foreach (var victim in AssetCachePaths.PrunePlan(files, cap))
                {
                    try
                    {
                        File.Delete(victim);
                    }
                    catch
                    {
                        // best-effort
                    }
                }
            }
            catch
            {
                // best-effort
            }
        });
    }

    private void PruneSiblingNamespacesAsync()
    {
        var root = _root;
        var active = _activeDir;
        Task.Run(() =>
        {
            try
            {
                if (!Directory.Exists(root))
                {
                    return;
                }

                var activeFull = Path.GetFullPath(active);
                foreach (var dir in Directory.GetDirectories(root))
                {
                    if (string.Equals(Path.GetFullPath(dir), activeFull, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    try
                    {
                        Directory.Delete(dir, recursive: true);
                    }
                    catch
                    {
                        // best-effort — a stale sibling that won't delete is harmless
                    }
                }
            }
            catch
            {
                // best-effort
            }
        });
    }

    // ---- env / persisted-token resolution -------------------------------------------------------------------------

    private static string ResolveRoot()
    {
        // COUCHCOOP_ASSET_CACHE_ROOT is an absolute dir that REPLACES the user:// root (used by the e2e cold/warm
        // leg to point cold and warm runs at a controllable directory).
        var overrideRoot = System.Environment.GetEnvironmentVariable("COUCHCOOP_ASSET_CACHE_ROOT");
        if (!string.IsNullOrWhiteSpace(overrideRoot))
        {
            return overrideRoot;
        }

        // A new root starts the Couch-owned byte cache at v1 without touching the user settings file or the
        // upstream-composed asset token stored there. Existing cache bytes are intentionally left unreachable.
        return ProjectSettings.GlobalizePath("user://couch-coop/assetcache/v1");
    }

    private static long ResolveCapBytes()
    {
        var mb = System.Environment.GetEnvironmentVariable("COUCHCOOP_ASSET_CACHE_MB");
        if (long.TryParse(mb, out var value) && value > 0)
        {
            return value * 1024L * 1024L;
        }

        return 512L * 1024L * 1024L;
    }

    private static string? ReadPersistedToken()
    {
        var cfg = new ConfigFile();
        if (cfg.Load(SettingsPath) != Error.Ok)
        {
            return null;
        }

        var value = cfg.GetValue(CfgSection, CfgTokenKey, "").AsString();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    // The effective enabled DEFAULT at Create. "0" is the authoritative kill switch (tests / e2e); any OTHER explicit
    // env value keeps the legacy "non-0 = on" behavior; an UNSET env falls back to the persisted SettingsPanel toggle
    // (default ON on a fresh profile), so a user's persisted OFF survives across launches / render-stage rebuilds.
    private static bool ResolveEnabledDefault()
    {
        var env = System.Environment.GetEnvironmentVariable("COUCHCOOP_ASSET_CACHE");
        if (env == "0")
        {
            return false;
        }

        if (!string.IsNullOrEmpty(env))
        {
            return true;
        }

        return ReadPersistedEnabled();
    }

    private static bool ReadPersistedEnabled()
    {
        var cfg = new ConfigFile();
        if (cfg.Load(SettingsPath) != Error.Ok)
        {
            return true; // fresh profile → default ON (matches the historical env-unset behavior)
        }

        return cfg.GetValue(CfgSection, CfgEnabledKey, true).AsBool();
    }

    private static void PersistToken(string token)
    {
        var cfg = new ConfigFile();
        cfg.Load(SettingsPath); // ignore result — the file may not exist yet
        cfg.SetValue(CfgSection, CfgTokenKey, token);
        Error e = cfg.Save(SettingsPath);
        if (e != Error.Ok)
        {
            GD.PrintErr($"M3_CACHE: failed to persist lastAssetToken to {SettingsPath}: {e}");
        }
    }
}
