using CouchCoop.MirrorProtocol.Assets;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-U (M3): the pure path + LRU-prune math the client disk cache turns into real IO. Sha keys are stable per url;
// tokens sanitize to a safe single-segment dir name; PrunePlan deletes oldest-write-first until under cap.
internal static class AssetCachePathsTests
{
    public static void Run()
    {
        Sha256HexStableAndDistinct();
        SanitizeToken();
        NamespaceDirComposesUnderRoot();
        PrunePlanUnderCapIsEmpty();
        PrunePlanDeletesOldestFirstUntilUnderCap();
        PrunePlanZeroCapDeletesEverything();
    }

    private static void Sha256HexStableAndDistinct()
    {
        var a = AssetCachePaths.Sha256Hex("/res/images/foo.png");
        Check.Equal(a, AssetCachePaths.Sha256Hex("/res/images/foo.png"), "same url → same sha");
        Check.Equal(a.Length, 64, "sha256 hex is 64 chars");
        Check.That(a.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')), "sha is lowercase hex");
        Check.That(a != AssetCachePaths.Sha256Hex("/res/images/bar.png"), "distinct urls → distinct sha");
    }

    private static void SanitizeToken()
    {
        Check.Equal(AssetCachePaths.SanitizeToken("cc-0123abcdef012345"), "cc-0123abcdef012345", "clean token unchanged");
        Check.Equal(AssetCachePaths.SanitizeToken(null), "pending", "null → pending");
        Check.Equal(AssetCachePaths.SanitizeToken("   "), "pending", "whitespace → pending");
        // Path separators + illegal chars become '_' so a hostile token can't escape the root.
        Check.Equal(AssetCachePaths.SanitizeToken("../a/b:c*d"), "___a_b_c_d", "illegal chars → underscore");
        Check.Equal(AssetCachePaths.SanitizeToken("ok_-9"), "ok_-9", "underscore + hyphen + digits survive");
    }

    private static void NamespaceDirComposesUnderRoot()
    {
        var dir = AssetCachePaths.NamespaceDir("/tmp/cache", "cc-abc");
        Check.Equal(dir, System.IO.Path.Combine("/tmp/cache", "cc-abc"), "namespace dir = root/<token>");

        var sanitized = AssetCachePaths.NamespaceDir("/tmp/cache", "a/b");
        Check.Equal(sanitized, System.IO.Path.Combine("/tmp/cache", "a_b"), "namespace dir sanitizes the token segment");
    }

    private static void PrunePlanUnderCapIsEmpty()
    {
        var t = new DateTime(2026, 7, 18, 0, 0, 0, DateTimeKind.Utc);
        var files = new List<(string, long, DateTime)>
        {
            ("a", 100, t),
            ("b", 100, t.AddSeconds(1)),
        };
        var plan = AssetCachePaths.PrunePlan(files, 1000);
        Check.Equal(plan.Count, 0, "already under cap → nothing to prune");
    }

    private static void PrunePlanDeletesOldestFirstUntilUnderCap()
    {
        var t = new DateTime(2026, 7, 18, 0, 0, 0, DateTimeKind.Utc);
        // Provide them out of write-order to prove the plan sorts by WriteUtc, not input order.
        var files = new List<(string, long, DateTime)>
        {
            ("c", 100, t.AddSeconds(2)),
            ("a", 100, t),               // oldest
            ("b", 100, t.AddSeconds(1)),
        };
        // total 300, cap 150 → delete oldest (a) → 200, still > 150 → delete next (b) → 100 <= 150 → stop.
        var plan = AssetCachePaths.PrunePlan(files, 150);
        Check.SequenceEqual(plan, new[] { "a", "b" }, "oldest-write-first until under cap");
    }

    private static void PrunePlanZeroCapDeletesEverything()
    {
        var t = new DateTime(2026, 7, 18, 0, 0, 0, DateTimeKind.Utc);
        var files = new List<(string, long, DateTime)>
        {
            ("a", 10, t),
            ("b", 10, t.AddSeconds(1)),
        };
        var plan = AssetCachePaths.PrunePlan(files, 0);
        Check.SequenceEqual(plan, new[] { "a", "b" }, "zero cap → delete everything oldest-first");
    }
}
