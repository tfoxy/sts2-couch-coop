using System.Text.Json;
using CouchCoop.Mod.Server;

/// <summary>
/// The branch-scoped cache root: when a stamp is honoured, when the tree is thrown away, and the two-directory
/// cap that keeps this from growing.
/// </summary>
/// <remarks>
/// <para>These drive <see cref="CouchCoopCacheRoot.ResolveOnce"/> with an explicit base root and an explicit
/// identity, so no game, no Steam and no Godot are involved — the identity ladder itself is spirectl's
/// (<c>Sts2GameBuildIdentityTests</c>), and what is tested here is the POLICY hung off whatever it answers.</para>
/// <para>The purge is the load-bearing half. Everything these caches hold is rendered from the game's content,
/// so a stale tree does not degrade to a miss — it serves confident, wrong pixels for the right key, for ever,
/// with nothing in the rendering path to blame.</para>
/// </remarks>
internal static class CacheRootPurgeTests
{
    public static void Run()
    {
        AMatchingStampKeepsTheCache();
        EachIdentityFieldInvalidates();
        TheBranchSourceAloneDoesNotInvalidate();
        AMissingStampOnANonEmptyDirectoryPurges();
        ACorruptStampPurges();
        AFreshDirectoryIsStampedNotPurged();
        BranchesGetTheirOwnDirectories();
        AtMostTwoBranchDirectoriesSurvive();
        TheCurrentBranchIsNeverEvicted();
        ABranchNameIsReducedToOneSafeSegment();
        LegacyLayoutIsSweptOnce();
        Console.WriteLine("cache root: ok");
    }

    private static void AMatchingStampKeepsTheCache()
    {
        using var temp = new TempDir();
        var identity = Identity();

        var first = Resolve(temp, identity);
        var witness = Seed(first.BranchRoot!, "assets/res/deadbeef.bin");

        var second = Resolve(temp, identity);

        Expect(second.BranchRoot == first.BranchRoot, "the same identity resolves the same branch directory");
        Expect(File.Exists(witness), "an unchanged identity keeps every cached file");
    }

    // Each of these is a reason the bytes on disk can no longer be trusted, and each has to be able to say so on
    // its own: a game build that moved without its version string still moves the hash, and a branch switch can
    // keep both.
    private static void EachIdentityFieldInvalidates()
    {
        var moved = new (string Name, CouchCoopCacheIdentity Identity)[]
        {
            ("gameVersion", Identity() with { GameVersion = "v0.107.2" }),
            ("mainAssemblyHash", Identity() with { MainAssemblyHash = 999 }),
            ("steamBuildId", Identity() with { SteamBuildId = 24000000 }),
            ("cacheVersion", Identity() with { CacheVersion = CouchCoopCacheRoot.CacheVersion + 1 }),
            ("assetPayloadVersion", Identity() with { AssetPayloadVersion = 99 }),
        };

        foreach (var (name, next) in moved)
        {
            using var temp = new TempDir();
            var witness = Seed(Resolve(temp, Identity()).BranchRoot!, "assets/res/deadbeef.bin");

            var after = Resolve(temp, next);

            Expect(after.BranchRoot is not null, $"a moved {name} still yields a usable cache root");
            Expect(!File.Exists(witness), $"a moved {name} throws the cached bytes away");
        }
    }

    // How the branch was LEARNED says nothing about what was cached. A start where Steam happened to be down
    // falls back to the install manifest and gets the same branch — throwing the cache away for that would cost
    // a full rebuild for no reason at all.
    private static void TheBranchSourceAloneDoesNotInvalidate()
    {
        using var temp = new TempDir();
        var witness = Seed(Resolve(temp, Identity()).BranchRoot!, "assets/res/deadbeef.bin");

        Resolve(temp, Identity() with { BranchSource = "appmanifest" });

        Expect(File.Exists(witness), "only the branch itself matters, not which source reported it");
    }

    private static void AMissingStampOnANonEmptyDirectoryPurges()
    {
        using var temp = new TempDir();
        var branchRoot = Path.Combine(temp.Path, "public");
        var witness = Seed(branchRoot, "assets/res/deadbeef.bin");

        var resolution = Resolve(temp, Identity());

        Expect(resolution.BranchRoot == branchRoot, "an unstamped directory is still the branch's directory");
        Expect(!File.Exists(witness), "bytes nothing vouches for are not served");
        Expect(CouchCoopCacheRoot.TryReadStamp(branchRoot) is not null, "and the directory is stamped going forward");
    }

    private static void ACorruptStampPurges()
    {
        using var temp = new TempDir();
        var branchRoot = Resolve(temp, Identity()).BranchRoot!;
        var witness = Seed(branchRoot, "assets/res/deadbeef.bin");
        File.WriteAllText(Path.Combine(branchRoot, ".cache-identity.json"), "{ not json");

        Resolve(temp, Identity());

        Expect(!File.Exists(witness), "an unreadable stamp is treated as no stamp, not as a match");
    }

    // A host that has never cached anything must not pay a spurious "purge" line, and must end up stamped.
    private static void AFreshDirectoryIsStampedNotPurged()
    {
        using var temp = new TempDir();
        var lines = new List<string>();

        var resolution = Resolve(temp, Identity(), lines);

        Expect(resolution.BranchRoot is not null, "a first run resolves a root");
        Expect(!lines.Any(line => line.Contains("purged", StringComparison.Ordinal)), "and purges nothing");
        Expect(CouchCoopCacheRoot.TryReadStamp(resolution.BranchRoot!) is not null, "and leaves a stamp behind");
    }

    // The whole point: two branches of the same game render different pixels for the same res:// path, so their
    // bytes may never meet.
    private static void BranchesGetTheirOwnDirectories()
    {
        using var temp = new TempDir();
        var stable = Resolve(temp, Identity()).BranchRoot!;
        var stableWitness = Seed(stable, "assets/res/deadbeef.bin");

        var beta = Resolve(temp, Identity() with { Branch = "public-beta", GameVersion = "v0.111.0" }).BranchRoot!;

        Expect(beta != stable, "a second branch gets its own directory");
        Expect(File.Exists(stableWitness), "and leaves the first branch's cache untouched");
    }

    // Without a cap, a renamed upstream branch or a launch that could identify nothing leaves gigabytes nobody
    // will ever read again.
    private static void AtMostTwoBranchDirectoriesSurvive()
    {
        using var temp = new TempDir();
        var oldest = Resolve(temp, Identity() with { Branch = "oldest" }).BranchRoot!;
        var middle = Resolve(temp, Identity() with { Branch = "middle" }).BranchRoot!;
        var newest = Resolve(temp, Identity() with { Branch = "newest" }).BranchRoot!;

        Expect(Directory.Exists(newest), "the branch in use survives");
        Expect(Directory.Exists(middle), "so does the most recently used other branch");
        Expect(!Directory.Exists(oldest), "the least recently used is evicted");
        Expect(BranchDirectories(temp.Path).Count == 2, "leaving exactly two branch directories");
    }

    // A branch that has sat unused for months is still the one being asked for, and evicting it here would
    // delete the cache the very next line is about to fill.
    private static void TheCurrentBranchIsNeverEvicted()
    {
        using var temp = new TempDir();
        var stale = Resolve(temp, Identity() with { Branch = "stale" }).BranchRoot!;
        Backdate(stale);
        Resolve(temp, Identity() with { Branch = "other" });
        Resolve(temp, Identity() with { Branch = "third" });

        var again = Resolve(temp, Identity() with { Branch = "stale" });

        Expect(again.BranchRoot == stale, "the branch in use resolves");
        Expect(Directory.Exists(stale), "however old its stamp is");
    }

    private static void ABranchNameIsReducedToOneSafeSegment()
    {
        Expect(CouchCoopCacheRoot.DirectoryNameFor("public-beta") == "public-beta", "an ordinary branch is unchanged");
        Expect(!CouchCoopCacheRoot.DirectoryNameFor("../../etc").Contains('/'), "a traversal attempt cannot escape");
        Expect(!CouchCoopCacheRoot.DirectoryNameFor("..\\..\\etc").Contains('\\'), "nor on Windows separators");
        Expect(CouchCoopCacheRoot.DirectoryNameFor("  ") == "unknown", "a blank branch gets its own directory name");
    }

    // TEMPORARY — delete this case with SweepLegacyLayout (on or after 2026-10-13). Before caches were branch
    // scoped they lived beside the new `cache` directory and are now unreachable; this reclaims them once.
    private static void LegacyLayoutIsSweptOnce()
    {
        using var temp = new TempDir();
        var couchCoop = Path.Combine(temp.Path, "couch-coop");
        var legacyAsset = Seed(Path.Combine(couchCoop, "assets"), "couchcoop-asset-cache-v13/res/deadbeef.bin");
        var legacyAstc = Seed(Path.Combine(couchCoop, "astc-cache"), "astc/deadbeef.cctx");

        // The sweep only fires for a base root named `cache`, which is the layout the mod itself resolves.
        Resolve(Path.Combine(couchCoop, "cache"), Identity(), sweepLegacy: true);

        Expect(WaitUntilGone(legacyAsset), "the pre-branch-scoping asset cache is reclaimed");
        Expect(WaitUntilGone(legacyAstc), "and so is the pre-branch-scoping astc cache");
    }

    // ---- helpers ----------------------------------------------------------------------------------------

    private static CouchCoopCacheIdentity Identity() => new(
        Branch: "public",
        BranchSource: "steamworks",
        SteamBuildId: 23811903,
        GameVersion: "v0.107.1",
        MainAssemblyHash: 1692500715,
        CacheVersion: CouchCoopCacheRoot.CacheVersion,
        AssetPayloadVersion: 1);

    private static CouchCoopCacheRoot.Resolution Resolve(
        TempDir temp, CouchCoopCacheIdentity identity, List<string>? log = null)
        => CouchCoopCacheRoot.ResolveOnce(temp.Path, identity, line => log?.Add(line), sweepLegacy: false);

    private static CouchCoopCacheRoot.Resolution Resolve(
        string baseRoot, CouchCoopCacheIdentity identity, bool sweepLegacy)
        => CouchCoopCacheRoot.ResolveOnce(baseRoot, identity, _ => { }, sweepLegacy);

    private static string Seed(string root, string relativePath)
    {
        var path = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "cached");
        return path;
    }

    // Make a branch look long-unused without waiting: rewrite its stamp's lastUsedUtcTicks in place.
    private static void Backdate(string branchRoot)
    {
        var path = Path.Combine(branchRoot, ".cache-identity.json");
        var node = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(path))!;
        node["lastUsedUtcTicks"] = JsonSerializer.SerializeToElement(1L);
        File.WriteAllText(path, JsonSerializer.Serialize(node));
    }

    private static List<string> BranchDirectories(string baseRoot) =>
        [.. Directory.EnumerateDirectories(baseRoot).Where(path => Path.GetFileName(path) != ".trash")];

    // The delete runs on a background thread by design — the rename is what makes the tree unreachable, and a
    // multi-gigabyte recursive delete must not hold up the Godot main thread at startup.
    private static bool WaitUntilGone(string path)
    {
        for (var attempt = 0; attempt < 100 && File.Exists(path); attempt++)
        {
            Thread.Sleep(20);
        }
        return !File.Exists(path);
    }

    private static void Expect(bool condition, string what)
    {
        if (!condition)
        {
            throw new Exception("cache root: " + what);
        }
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "couchcoop-cache-root-" + Guid.NewGuid().ToString("N"));

        public TempDir() => Directory.CreateDirectory(Path);

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
    }
}
