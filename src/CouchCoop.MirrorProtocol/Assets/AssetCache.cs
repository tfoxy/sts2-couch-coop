// Pure, game-free/Godot-free helpers for the WS-U disk asset cache (M3). These live in the shared MirrorProtocol
// layer so BOTH sides consume them: the SERVER composes an assetCacheToken (BrowserStateEnvelopeFactory) and the
// native Godot CLIENT keys its on-disk cache by the sha of each asset url + the token namespace (AssetDiskCache).
// Kept 100% pure (no IO, no Godot) so they are Exe-testable in tests/CouchCoop.MirrorProtocol.Tests.

using System.Security.Cryptography;
using System.Text;

namespace CouchCoop.MirrorProtocol.Assets;

// Composes the CACHE-INVALIDATION token that names a client cache namespace. The token changes iff the bytes a
// given asset url maps to can change — i.e. the game version, the mod version, or the server asset schema. A blank
// input normalizes to "unknown" (the same convention BrowserResourceHttpAdapter uses for a missing gameVersion), so
// the token is DETERMINISTIC and STABLE within a game/mod version even when gameVersion is unreported.
public static class AssetCacheToken
{
    // "cc-" + first 16 hex chars of sha256("g={game}\nm={mod}\na={schema}"). The prefix keeps it recognizable and a
    // safe directory-name lead char; 16 hex chars (64 bits) is collision-safe for the handful of live namespaces.
    public static string Compose(string? gameVersion, string? modVersion, string? assetSchema)
    {
        var g = Normalize(gameVersion);
        var m = Normalize(modVersion);
        var a = Normalize(assetSchema);
        var joined = $"g={g}\nm={m}\na={a}";
        return "cc-" + Sha256Hex(joined)[..16];
    }

    private static string Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? "unknown" : value;

    private static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

// Pure path/prune math for the client disk cache. The client turns these into real IO in AssetDiskCache; keeping the
// math here makes the layout + LRU-prune policy Exe-testable without touching disk.
public static class AssetCachePaths
{
    // The full 64-char lowercase sha256 hex of an asset url — the stable `.bin` filename within a namespace. Distinct
    // urls never collide; the same url is byte-identical across runs (matches the server's per-key hashing).
    public static string Sha256Hex(string relUrl) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(relUrl))).ToLowerInvariant();

    // The absolute directory for a token's namespace: `<root>/<sanitized-token>`. The token is sanitized to a safe
    // directory name (only A-Za-z0-9_- survive; every other char → '_') so a hostile/odd token can never escape root
    // or inject path separators.
    public static string NamespaceDir(string root, string token) =>
        System.IO.Path.Combine(root, SanitizeToken(token));

    // Restrict a token to a safe single-segment directory name. A blank token → "pending" (the pre-session default).
    public static string SanitizeToken(string? token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return "pending";
        }

        var sb = new StringBuilder(token.Length);
        foreach (var c in token)
        {
            sb.Append((char.IsAsciiLetterOrDigit(c) || c is '_' or '-') ? c : '_');
        }

        return sb.Length == 0 ? "pending" : sb.ToString();
    }

    // The oldest-write-first list of file paths to delete so the total byte size drops to <= capBytes. Pure: the
    // caller enumerates the namespace (path/size/last-write-utc) and does the deletes. Returns empty when already
    // under cap; deletes oldest first (approximate-LRU — writes touch mtime so warm assets survive).
    public static IReadOnlyList<string> PrunePlan(
        IReadOnlyList<(string Path, long Size, DateTime WriteUtc)> files,
        long capBytes)
    {
        long total = 0;
        foreach (var f in files)
        {
            total += f.Size;
        }

        if (total <= capBytes)
        {
            return Array.Empty<string>();
        }

        var ordered = new List<(string Path, long Size, DateTime WriteUtc)>(files);
        ordered.Sort((x, y) => x.WriteUtc.CompareTo(y.WriteUtc)); // oldest write first

        var toDelete = new List<string>();
        foreach (var f in ordered)
        {
            if (total <= capBytes)
            {
                break;
            }

            toDelete.Add(f.Path);
            total -= f.Size;
        }

        return toDelete;
    }
}

// Shared percentile math (linear interpolation between the two nearest ranks — identical to the algorithm AppShell
// used inline for frameMs). Reused by WS-U (asset-cache diagnostics) and WS-W (walk timings), and de-duplicates the
// old AppShell.Percentile. General on purpose: any number of quantiles, order-independent input.
public static class Percentiles
{
    // For each requested quantile q in [0,1], the linearly-interpolated percentile of `values`. Order of `values`
    // does not matter (a copy is sorted). Empty input → all zeros. Results are returned in the order requested.
    public static double[] Compute(IReadOnlyList<double> values, params double[] quantiles)
    {
        var result = new double[quantiles.Length];
        if (values.Count == 0)
        {
            return result; // all zeros
        }

        var sorted = new List<double>(values);
        sorted.Sort();

        for (int i = 0; i < quantiles.Length; i++)
        {
            double q = quantiles[i] < 0 ? 0 : (quantiles[i] > 1 ? 1 : quantiles[i]);
            double pos = q * (sorted.Count - 1);
            int lo = (int)Math.Floor(pos);
            int hi = (int)Math.Ceiling(pos);
            result[i] = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
        }

        return result;
    }
}
