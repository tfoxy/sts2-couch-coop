using System.Security.Cryptography;
using CouchCoop.Mod.Server;

// Track T: the tiny-PNG transcode threshold on AstcTranscodeCache. Below MinSourceBytesForAstc (32768, mirrored in
// scripts/transcode-texture-cache.mjs and scripts/replay-ws-server.mjs), the cache must never be consulted for a
// read (even a stale cache still holding a tiny cctx entry from before this change must NOT be served) and must
// never queue a pending-transcode entry (so the pending inbox stays clean). Pure filesystem, no Godot dependency —
// the cache root is passed explicitly so DefaultRoot()'s GodotSharp probe is never reached.
internal static class AstcTranscodeCacheTests
{
    private const int MinSourceBytesForAstc = 32768; // mirrors the private const in AstcTranscodeCache.cs

    public static void Run()
    {
        TinySourceNeverReadsEvenOnStaleHit();
        EligibleSourceReadsAHit();
        BoundaryAtThresholdIsEligible();
        TinySourceNeverRecordsPending();
        EligibleSourceRecordsPending();
        MissingEligibleSourceReadsNull();
    }

    // A stale cache root that still has a cctx for a tiny source's hash (as if it was transcoded before this
    // change shipped) must NOT be served — the size guard applies before the cache is even consulted.
    private static void TinySourceNeverReadsEvenOnStaleHit()
    {
        using var root = new TempCacheRoot();
        var tiny = new byte[MinSourceBytesForAstc - 1];
        Random.Shared.NextBytes(tiny);
        root.SeedCctx(tiny, "fake-cctx-bytes"u8.ToArray());

        var cache = new AstcTranscodeCache(root.Path);
        var result = cache.TryReadForContent(tiny);

        Assert(result is null, "a tiny source never reads from the astc cache, even on a stale hit");
    }

    private static void EligibleSourceReadsAHit()
    {
        using var root = new TempCacheRoot();
        var eligible = new byte[MinSourceBytesForAstc + 1024];
        Random.Shared.NextBytes(eligible);
        var cctxBytes = "real-cctx-bytes"u8.ToArray();
        root.SeedCctx(eligible, cctxBytes);

        var cache = new AstcTranscodeCache(root.Path);
        var result = cache.TryReadForContent(eligible);

        Assert(result is not null, "a source at/above the threshold reads a cache hit");
        Assert(result!.SequenceEqual(cctxBytes), "the bytes returned are exactly the cctx file's bytes");
    }

    // The guard is `< threshold`, so a source of EXACTLY MinSourceBytesForAstc bytes is eligible, not skipped.
    private static void BoundaryAtThresholdIsEligible()
    {
        using var root = new TempCacheRoot();
        var atThreshold = new byte[MinSourceBytesForAstc];
        Random.Shared.NextBytes(atThreshold);
        var cctxBytes = "boundary-cctx-bytes"u8.ToArray();
        root.SeedCctx(atThreshold, cctxBytes);

        var cache = new AstcTranscodeCache(root.Path);
        var result = cache.TryReadForContent(atThreshold);

        Assert(result is not null, "a source of exactly MinSourceBytesForAstc bytes is eligible (< not <=)");
        Assert(result!.SequenceEqual(cctxBytes), "boundary hit returns the exact cctx bytes");
    }

    private static void TinySourceNeverRecordsPending()
    {
        using var root = new TempCacheRoot();
        var tiny = new byte[MinSourceBytesForAstc - 1];
        Random.Shared.NextBytes(tiny);

        var cache = new AstcTranscodeCache(root.Path);
        cache.RecordPending(tiny);

        // The threshold guard returns BEFORE the fire-and-forget Task.Run is ever spawned, so a tiny source's
        // pending-file check is synchronous — no need to poll like the eligible-source case below.
        Assert(!root.PendingFileEverAppears(tiny, TimeSpan.Zero),
            "a tiny source is never written to the pending inbox");
    }

    private static void EligibleSourceRecordsPending()
    {
        using var root = new TempCacheRoot();
        var eligible = new byte[MinSourceBytesForAstc + 512];
        Random.Shared.NextBytes(eligible);

        var cache = new AstcTranscodeCache(root.Path);
        cache.RecordPending(eligible);

        Assert(root.PendingFileEverAppears(eligible, TimeSpan.FromSeconds(5)),
            "a source at/above the threshold IS written to the pending inbox");
    }

    private static void MissingEligibleSourceReadsNull()
    {
        using var root = new TempCacheRoot();
        var eligible = new byte[MinSourceBytesForAstc + 10];
        Random.Shared.NextBytes(eligible);
        // No cctx seeded for this hash.

        var cache = new AstcTranscodeCache(root.Path);
        var result = cache.TryReadForContent(eligible);

        Assert(result is null, "an eligible source with no transcoded cctx yet is a normal cache miss");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"AstcTranscodeCacheTests: {label}");
        }
    }

    private sealed class TempCacheRoot : IDisposable
    {
        public TempCacheRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-astc-cache-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "astc"));
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "pending"));
        }

        public string Path { get; }

        public void SeedCctx(byte[] sourceBytes, byte[] cctxBytes)
        {
            var hash = Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant();
            File.WriteAllBytes(System.IO.Path.Combine(Path, "astc", hash + ".cctx"), cctxBytes);
        }

        public bool PendingFileEverAppears(byte[] sourceBytes, TimeSpan timeout)
        {
            var hash = Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant();
            var pendingFile = System.IO.Path.Combine(Path, "pending", hash + ".bin");
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (File.Exists(pendingFile))
                {
                    return true;
                }

                Thread.Sleep(25);
            }

            return File.Exists(pendingFile);
        }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
