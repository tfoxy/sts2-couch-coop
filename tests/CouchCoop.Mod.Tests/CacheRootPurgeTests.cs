using CouchCoop.Mod.Server;

/// <summary>
/// The version-scoped cache root: when a stamp is honoured, when the tree is thrown away, and the one rule —
/// keep two directories, retire the lowest version — that keeps this from growing.
/// </summary>
/// <remarks>
/// <para>These drive <see cref="CouchCoopCacheRoot.ResolveOnce"/> with an explicit base root and an explicit
/// content identity, so no game, no Steam and no Godot are involved. Nothing in the resolver asks for a Steam
/// branch at all any more; the version separates the builds and the version numbers decide what is retired.</para>
/// <para>The purge is the load-bearing half. Everything these caches hold is rendered from the game's content,
/// so a stale tree does not degrade to a miss — it serves confident, wrong pixels for the right key, for ever,
/// with nothing in the rendering path to blame.</para>
/// </remarks>
internal static class CacheRootPurgeTests
{
    public static void Run()
    {
        AMatchingStampKeepsTheCache();
        AnUnknownVersionRefusesTheCache();
        EachContentFieldInvalidates();
        AMissingStampOnANonEmptyDirectoryPurges();
        ACorruptStampPurges();
        AFreshDirectoryIsStampedNotPurged();
        VersionsGetTheirOwnDirectories();
        AtMostTwoVersionDirectoriesSurvive();
        TheLowestVersionIsTheOneRetired();
        ABranchNamedDirectoryIsRetiredFirst();
        TheCurrentVersionIsNeverEvicted();
        TheFastPathWritesNothing();
        AVersionNameIsReducedToOneSafeSegment();
        VersionNamesCompareNumerically();
        LegacyLayoutIsSweptOnce();
        NoFailureAnywhereInResolutionEscapes();
        ARootAndAQuotaAreResolvedTogetherOrNotAtAll();
        Console.WriteLine("cache root: ok");
    }

    private static void AMatchingStampKeepsTheCache()
    {
        using var temp = new TempDir();
        var content = Content();

        var first = Resolve(temp, content);
        var witness = Seed(first.VersionRoot!, "assets/res/deadbeef.bin");

        var second = Resolve(temp, content);

        Expect(second.VersionRoot == first.VersionRoot, "the same content resolves the same version directory");
        Expect(File.Exists(witness), "an unchanged identity keeps every cached file");
    }

    // THE BUG THAT FORCED THIS. A Workshop-installed mod lives outside the game tree, so release_info.json
    // cannot be found by walking up from it and the version comes back blank. Every build then resolves to one
    // directory whose stamp ALSO matches every build — so stable would serve beta's pixels off a fast-path hit.
    // Refusing is the only safe answer; a slower session beats a rendering bug with no visible cause.
    private static void AnUnknownVersionRefusesTheCache()
    {
        using var temp = new TempDir();
        var lines = new List<string>();

        var resolution = Resolve(temp, Content() with { GameVersion = "" }, lines);

        Expect(resolution.VersionRoot is null, "an install that will not state its version gets no cache");
        Expect(resolution.Quota is null, "…and no quota to admit anything into one");
        Expect(lines.Any(l => l.Contains("cache disabled", StringComparison.Ordinal)), "…and says so out loud");
        Expect(!Directory.EnumerateDirectories(temp.Path).Any(), "…leaving no directory behind to be shared");
    }

    // The three reasons a directory's OWN bytes stop being trustworthy while its name still applies: the game
    // was rebuilt without moving its version string, or one of our two cache generations moved. Each has to be
    // able to say so on its own, and each empties the directory in place.
    private static void EachContentFieldInvalidates()
    {
        var moved = new (string Name, CouchCoopCacheContent Content)[]
        {
            ("mainAssemblyHash", Content() with { MainAssemblyHash = 999 }),
            ("cacheVersion", Content() with { CacheVersion = CouchCoopCacheRoot.CacheVersion + 1 }),
            ("assetPayloadVersion", Content() with { AssetPayloadVersion = 99 }),
        };

        foreach (var (name, next) in moved)
        {
            using var temp = new TempDir();
            var witness = Seed(Resolve(temp, Content()).VersionRoot!, "assets/res/deadbeef.bin");

            var after = Resolve(temp, next);

            Expect(after.VersionRoot is not null, $"a moved {name} still yields a usable cache root");
            Expect(!File.Exists(witness), $"a moved {name} throws the cached bytes away");
        }

        // A moved VERSION is the one that does not purge: it addresses a different directory, and keeping the
        // one it came from warm is the entire point of naming them this way.
        using var hop = new TempDir();
        var kept = Seed(Resolve(hop, Content()).VersionRoot!, "assets/res/deadbeef.bin");

        var next107 = Resolve(hop, Content() with { GameVersion = "v0.107.2" });

        Expect(Path.GetFileName(next107.VersionRoot!) == "v0.107.2", "a moved version addresses its own directory");
        Expect(File.Exists(kept), "and leaves the version it came from intact");
    }

    private static void AMissingStampOnANonEmptyDirectoryPurges()
    {
        using var temp = new TempDir();
        var versionRoot = Path.Combine(temp.Path, "v0.107.1");
        var witness = Seed(versionRoot, "assets/res/deadbeef.bin");

        var resolution = Resolve(temp, Content());

        Expect(resolution.VersionRoot == versionRoot, "an unstamped directory is still this version's directory");
        Expect(!File.Exists(witness), "bytes nothing vouches for are not served");
        Expect(CouchCoopCacheRoot.TryReadStamp(versionRoot) is not null, "and the directory is stamped going forward");
    }

    private static void ACorruptStampPurges()
    {
        using var temp = new TempDir();
        var versionRoot = Resolve(temp, Content()).VersionRoot!;
        var witness = Seed(versionRoot, "assets/res/deadbeef.bin");
        File.WriteAllText(Path.Combine(versionRoot, ".cache-identity.json"), "{ not json");

        Resolve(temp, Content());

        Expect(!File.Exists(witness), "an unreadable stamp is treated as no stamp, not as a match");
    }

    // A host that has never cached anything must not pay a spurious "purge" line, and must end up stamped.
    private static void AFreshDirectoryIsStampedNotPurged()
    {
        using var temp = new TempDir();
        var lines = new List<string>();

        var resolution = Resolve(temp, Content(), log: lines);

        Expect(resolution.VersionRoot is not null, "a first run resolves a root");
        Expect(!lines.Any(line => line.Contains("purged", StringComparison.Ordinal)), "and purges nothing");
        Expect(CouchCoopCacheRoot.TryReadStamp(resolution.VersionRoot!) is not null, "and leaves a stamp behind");
    }

    // The whole point: two builds of the same game render different pixels for the same res:// path, so their
    // bytes may never meet. The VERSION is what separates them, and it is read from each install's own
    // release_info.json — so this holds however the branch resolves, including not at all.
    private static void VersionsGetTheirOwnDirectories()
    {
        using var temp = new TempDir();
        var stable = Resolve(temp, Content()).VersionRoot!;
        var stableWitness = Seed(stable, "assets/res/deadbeef.bin");

        var beta = Resolve(
            temp,
            Content() with { GameVersion = "v0.111.0", MainAssemblyHash = 1579942752 }).VersionRoot!;

        Expect(Path.GetFileName(stable) == "v0.107.1", "the directory is named after the version");
        Expect(Path.GetFileName(beta) == "v0.111.0", "…for both of them");
        Expect(beta != stable, "a second version gets its own directory");
        Expect(File.Exists(stableWitness), "and leaves the first version's cache untouched");
    }

    // THE WHOLE GC POLICY: keep two, retire the lowest version. No map, no timestamps, no branch.
    private static void AtMostTwoVersionDirectoriesSurvive()
    {
        using var temp = new TempDir();
        foreach (var version in new[] { "v0.1.0", "v0.2.0", "v0.3.0" })
        {
            Resolve(temp, Content() with { GameVersion = version });
        }

        Expect(VersionDirectories(temp.Path).Count == CouchCoopCacheRoot.MaxVersionDirectories,
            $"exactly {CouchCoopCacheRoot.MaxVersionDirectories} version directories survive");
        Expect(Directory.Exists(Path.Combine(temp.Path, "v0.3.0")), "the version in use survives");
        Expect(Directory.Exists(Path.Combine(temp.Path, "v0.2.0")), "so does the next highest");
        Expect(!Directory.Exists(Path.Combine(temp.Path, "v0.1.0")), "the lowest version is retired");
    }

    // Arrival ORDER must not decide it — the point of comparing versions rather than timestamps is that going
    // back to an older build does not retire the newer one a player is about to switch back to.
    private static void TheLowestVersionIsTheOneRetired()
    {
        using var temp = new TempDir();
        var high = Resolve(temp, Content() with { GameVersion = "v0.111.0" }).VersionRoot!;
        var low = Resolve(temp, Content() with { GameVersion = "v0.9.0" }).VersionRoot!;
        var witness = Seed(high, "assets/res/deadbeef.bin");

        // A third, in the middle. v0.9.0 is the lowest and goes, even though it was used most recently.
        Resolve(temp, Content() with { GameVersion = "v0.107.1" });

        Expect(Directory.Exists(high), "v0.111.0 survives");
        Expect(File.Exists(witness), "with its bytes");
        Expect(!Directory.Exists(low), "v0.9.0 is retired — numerically lowest, not oldest by use");
    }

    // The migration from the layout this replaced. A directory named after a BRANCH is not a version, so nothing
    // will ever resolve to it — it is unreachable rather than merely old, and it must not occupy one of the two
    // slots. Both go in a single pass, however many there are.
    private static void ABranchNamedDirectoryIsRetiredFirst()
    {
        using var temp = new TempDir();
        var legacy = Seed(Path.Combine(temp.Path, "public"), "assets/res/deadbeef.bin");
        Seed(Path.Combine(temp.Path, "public-beta"), "assets/res/deadbeef.bin");

        Resolve(temp, Content());

        Expect(!File.Exists(legacy), "a branch-named directory is retired");
        Expect(!Directory.Exists(Path.Combine(temp.Path, "public-beta")), "…and so is the other one");
        Expect(Directory.Exists(Path.Combine(temp.Path, "v0.107.1")), "leaving the version directory in use");
        Expect(VersionDirectories(temp.Path).Count == 1, "and nothing else at all");
    }

    // A version that sorts lowest is still the one being asked for, and evicting it would delete the cache the
    // very next line is about to fill.
    private static void TheCurrentVersionIsNeverEvicted()
    {
        using var temp = new TempDir();
        Resolve(temp, Content() with { GameVersion = "v0.9.0" });
        Resolve(temp, Content() with { GameVersion = "v0.111.0" });

        var again = Resolve(temp, Content() with { GameVersion = "v0.9.0" });

        Expect(again.VersionRoot is not null, "the lowest version still resolves when it is the one in use");
        Expect(Directory.Exists(again.VersionRoot!), "and survives its own eviction pass");
    }

    // A start that finds its directory stamped does no IO beyond reading the stamp — no touch, no re-stamp.
    // That is what makes the ordinary start free, and it is easy to regress by "refreshing" something.
    private static void TheFastPathWritesNothing()
    {
        using var temp = new TempDir();
        var root = Resolve(temp, Content()).VersionRoot!;
        var stampPath = Path.Combine(root, ".cache-identity.json");
        var before = File.GetLastWriteTimeUtc(stampPath);
        var bytesBefore = File.ReadAllText(stampPath);

        Thread.Sleep(20);
        Resolve(temp, Content());

        Expect(File.GetLastWriteTimeUtc(stampPath) == before, "the stamp is not rewritten on a hit");
        Expect(File.ReadAllText(stampPath) == bytesBefore, "and its contents are byte-identical");
    }

    private static void AVersionNameIsReducedToOneSafeSegment()
    {
        // Dots SURVIVE — the whole point of naming by version is that a person can read the directory.
        Expect(CouchCoopCacheRoot.DirectoryNameFor("v0.107.1") == "v0.107.1", "a version keeps its dots");
        // A traversal attempt is REFUSED rather than sanitised into something usable: separators become `_`,
        // which leaves a leading dot, and a leading dot is not a name this will hand back.
        Expect(CouchCoopCacheRoot.DirectoryNameFor("../../etc") is null, "a traversal attempt cannot escape");
        Expect(CouchCoopCacheRoot.DirectoryNameFor("..\\..\\etc") is null, "nor on Windows separators");
        // A leading dot would hide the directory AND put it in the class this file reserves for metadata
        // (.trash, .cache-identity.json), which the directory walk skips wholesale. Anything unusable is NULL —
        // there is no "unknown" bucket to fall into, because sharing one across builds is the forbidden outcome.
        Expect(CouchCoopCacheRoot.DirectoryNameFor(".hidden") is null, "a leading dot is refused");
        Expect(CouchCoopCacheRoot.DirectoryNameFor("..") is null, "and so is a name that is only dots");
        Expect(CouchCoopCacheRoot.DirectoryNameFor("  ") is null, "and so is a blank version");
    }

    // Text ordering is wrong in a way that only shows up later: "v0.9.0" sorts ABOVE "v0.10.0" as a string, and
    // the cache would start retiring the NEWER build.
    private static void VersionNamesCompareNumerically()
    {
        Expect(CouchCoopCacheRoot.CompareVersionNames("v0.9.0", "v0.10.0") < 0, "9 < 10 numerically, not textually");
        Expect(CouchCoopCacheRoot.CompareVersionNames("v0.107.1", "v0.111.0") < 0, "107 < 111");
        Expect(CouchCoopCacheRoot.CompareVersionNames("v0.107.1", "v0.107.2") < 0, "the patch component counts");
        Expect(CouchCoopCacheRoot.CompareVersionNames("v0.107", "v0.107.0") == 0, "a missing component reads as 0");
        Expect(CouchCoopCacheRoot.CompareVersionNames("0.107.1", "v0.107.1") == 0, "a leading v is ignored");
        // Not a version at all — a branch name from the old layout — sorts lowest so it is retired first.
        Expect(CouchCoopCacheRoot.CompareVersionNames("public", "v0.1.0") < 0, "a branch name sorts below any version");
        Expect(CouchCoopCacheRoot.CompareVersionNames("v0.1.0", "public-beta") > 0, "…in both directions");
    }

    // TEMPORARY — delete this case with SweepLegacyLayout (on or after 2026-10-13). Before caches were scoped at
    // all they lived beside the new `cache` directory and are now unreachable; this reclaims them once.
    private static void LegacyLayoutIsSweptOnce()
    {
        using var temp = new TempDir();
        var couchCoop = Path.Combine(temp.Path, "couch-coop");
        var legacyAsset = Seed(Path.Combine(couchCoop, "assets"), "couchcoop-asset-cache-v13/res/deadbeef.bin");
        var legacyAstc = Seed(Path.Combine(couchCoop, "astc-cache"), "astc/deadbeef.cctx");

        // The sweep only fires for a base root named `cache`, which is the layout the mod itself resolves.
        CouchCoopCacheRoot.ResolveOnce(Path.Combine(couchCoop, "cache"), Content(), _ => { }, sweepLegacy: true);

        Expect(WaitUntilGone(legacyAsset), "the pre-scoping asset cache is reclaimed");
        Expect(WaitUntilGone(legacyAstc), "and so is the pre-scoping astc cache");
    }

    // THE CHEAPEST GUARD AGAINST THE WHOLE CLASS, and the class is worth naming. Resolution builds two NAMED
    // MUTEXES — the cross-process gate and the quota's — and both used to sit OUTSIDE the guarded region, one
    // before it and one in the final `return`. On Unix a named mutex is backed by files the runtime keeps under
    // $TMPDIR, which on macOS is a per-user /var/folders/... path that gets purged out from under a long-running
    // process; a failure there is not necessarily an IOException, so the old narrow predicate would not have held
    // it either. A throw from either escaped into a Lazy(ExecutionAndPublication), which caches the exception for
    // the life of the process, then out through Warm() at the top of mod init and into the loader's blanket
    // catch — one log line, and a mod that does nothing at all, because a CACHE could not be set up.
    //
    // A named-mutex failure cannot be induced in-process, so the trigger here is the other real throw site with
    // the same shape: the quota resolves its coordination path through Path.GetFullPath, which refuses a path
    // carrying a NUL. What is being asserted is structural — that a throw from the quota construction cannot
    // leave ResolveOnce — and it holds for any exception, which is the point of a total boundary.
    private static void NoFailureAnywhereInResolutionEscapes()
    {
        var poisoned = Path.Combine(Path.GetTempPath(), "couchcoop-cache-root-\0-" + Guid.NewGuid().ToString("N"));

        // First: prove the construction really is a throw site, so this test cannot quietly stop testing
        // anything if the failure mode moves.
        var threw = false;
        try { ManagedCacheQuota.ForCacheRoot(Path.Combine(poisoned, "v0.107.1")); }
        catch (Exception) { threw = true; }
        Expect(threw, "the quota construction is a real throw site");

        var lines = new List<string>();
        CouchCoopCacheRoot.Resolution resolution;
        try
        {
            resolution = CouchCoopCacheRoot.ResolveOnce(poisoned, Content(), lines.Add, sweepLegacy: false);
        }
        catch (Exception exception)
        {
            throw new Exception($"cache root: resolution let a {exception.GetType().Name} escape");
        }

        Expect(resolution.VersionRoot is null, "a failure anywhere in resolution disables the cache");
        Expect(resolution.Quota is null, "…and hands back no quota");
        Expect(lines.Any(l => l.Contains("cache disabled", StringComparison.Ordinal)), "…and says so out loud");
    }

    // The pair is not two independent answers. CouchCoopGeoclipStore dereferences the quota unconditionally once
    // it has a root, so "a root, but no quota" is a null deref waiting for the first bake — which is why a quota
    // that cannot be built has to take the root down with it rather than degrade to unmetered writes.
    private static void ARootAndAQuotaAreResolvedTogetherOrNotAtAll()
    {
        using var temp = new TempDir();

        foreach (var content in new[] { Content(), Content() with { GameVersion = "" } })
        {
            var resolution = Resolve(temp, content);
            Expect(
                (resolution.VersionRoot is null) == (resolution.Quota is null),
                $"a root and a quota are resolved together or not at all ({Show(content.GameVersion)})");
        }
    }

    private static string Show(string value) => value.Length == 0 ? "(no version)" : value;

    // ---- helpers ----------------------------------------------------------------------------------------

    private static CouchCoopCacheContent Content() => new(
        GameVersion: "v0.107.1",
        MainAssemblyHash: 1692500715,
        CacheVersion: CouchCoopCacheRoot.CacheVersion,
        AssetPayloadVersion: 1);

    private static CouchCoopCacheRoot.Resolution Resolve(
        TempDir temp,
        CouchCoopCacheContent content,
        List<string>? log = null)
        => CouchCoopCacheRoot.ResolveOnce(temp.Path, content, line => log?.Add(line), sweepLegacy: false);

    private static string Seed(string root, string relativePath)
    {
        var path = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "cached");
        return path;
    }

    // Everything at the base that is not dot-prefixed — the same rule the resolver's own walk uses, so `.trash`
    // never counts as a version directory here either.
    private static List<string> VersionDirectories(string baseRoot) =>
        [.. Directory.EnumerateDirectories(baseRoot).Where(path => !Path.GetFileName(path).StartsWith('.'))];

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
