using System.Text.Json;
using CouchCoop.Mod.Server;

/// <summary>
/// The version-scoped cache root: when a stamp is honoured, when the tree is thrown away, and the two rules —
/// the branch → version map and the directory cap behind it — that keep this from growing.
/// </summary>
/// <remarks>
/// <para>These drive <see cref="CouchCoopCacheRoot.ResolveOnce"/> with an explicit base root, an explicit
/// content identity and an explicit slot resolver, so no game, no Steam and no Godot are involved — the identity
/// ladder itself is spirectl's (<c>Sts2GameBuildIdentityTests</c>), and what is tested here is the POLICY hung
/// off whatever it answers.</para>
/// <para>The purge is the load-bearing half. Everything these caches hold is rendered from the game's content,
/// so a stale tree does not degrade to a miss — it serves confident, wrong pixels for the right key, for ever,
/// with nothing in the rendering path to blame.</para>
/// <para>The SLOT RESOLVER is passed as a delegate rather than a value for one reason these tests exercise
/// directly: "did this start have to ask Steam?" is a property worth asserting, and the ordinary start must be
/// able to answer without asking anything.</para>
/// </remarks>
internal static class CacheRootPurgeTests
{
    public static void Run()
    {
        AMatchingStampKeepsTheCache();
        TheFastPathNeverResolvesABranch();
        EachContentFieldInvalidates();
        TheLabelsAloneDoNotInvalidate();
        AMissingStampOnANonEmptyDirectoryPurges();
        ACorruptStampPurges();
        AFreshDirectoryIsStampedNotPurged();
        VersionsGetTheirOwnDirectories();
        ABranchSwitchAtTheSameVersionSharesOneDirectory();
        AFirstSlowPathWritesTheMap();
        ABranchMovingVersionReleasesTheOneItLeft();
        ASharedVersionIsNotReleasedWhileAnotherBranchIsOnIt();
        AnOrphanDirectoryIsReclaimed();
        ACorruptMapDegradesToAbsent();
        AtMostThreeVersionDirectoriesSurvive();
        TheCurrentVersionIsNeverEvicted();
        AVersionNameIsReducedToOneSafeSegment();
        LegacyLayoutIsSweptOnce();
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

    // THE HEADLINE PROPERTY. A start that finds its version directory already stamped has its whole answer, so
    // nothing resolves a branch — no Steamworks probe, no appmanifest walk. The resolver throws if called, which
    // is the only way to state "this must not happen" rather than "this happens to be cheap".
    private static void TheFastPathNeverResolvesABranch()
    {
        using var temp = new TempDir();
        Resolve(temp, Content());

        var second = CouchCoopCacheRoot.ResolveOnce(
            temp.Path,
            Content(),
            () => throw new Exception("the fast path resolved a branch"),
            _ => { },
            sweepLegacy: false);

        Expect(second.VersionRoot is not null, "the second start resolves a root");
        Expect(second.Slot is null, "…and reports that no branch was consulted");

        // The consequence that forced the asset token to drop its branch and build id. A token composed from a
        // value only the SLOW path learns would come out different on these two starts of the same host — same
        // build, two tokens, every client re-downloading for nothing. Composing from the CONTENT makes the two
        // paths indistinguishable to a client, which is what this asserts.
        var slow = Resolve(new TempDir(), Content());
        Expect(
            CouchCoopAssetVersion.DescribeGameBuild(slow.Content)
                == CouchCoopAssetVersion.DescribeGameBuild(second.Content),
            "a fast-path start and a slow-path start publish the same build token");
    }

    // Each of these is a reason the bytes on disk can no longer be trusted, and each has to be able to say so on
    // its own: a game build that moved without its version string still moves the hash.
    private static void EachContentFieldInvalidates()
    {
        var moved = new (string Name, CouchCoopCacheContent Content)[]
        {
            ("gameVersion", Content() with { GameVersion = "v0.107.2" }),
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
    }

    // The three LABELS. None of them says anything about what was cached, and each needs an answer from outside
    // the install — so they are recorded in the stamp and compared by nothing. Comparing them is also impossible
    // in principle now: the fast path never learns them, so they would be absent on exactly the starts that must
    // keep the cache.
    private static void TheLabelsAloneDoNotInvalidate()
    {
        var labels = new (string Name, CouchCoopCacheSlot Slot)[]
        {
            ("branch", Slot() with { Branch = "public-beta" }),
            ("branchSource", Slot() with { BranchSource = "appmanifest" }),
            ("steamBuildId", Slot() with { SteamBuildId = 24000000 }),
        };

        foreach (var (name, slot) in labels)
        {
            using var temp = new TempDir();
            var witness = Seed(Resolve(temp, Content()).VersionRoot!, "assets/res/deadbeef.bin");

            Resolve(temp, Content(), slot);

            Expect(File.Exists(witness), $"a moved {name} is recorded, not acted on");
        }
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
            Content() with { GameVersion = "v0.111.0", MainAssemblyHash = 1579942752 },
            Slot() with { Branch = "v111", BranchSource = "api-lane", SteamBuildId = 0 }).VersionRoot!;

        Expect(Path.GetFileName(stable) == "v0.107.1", "the directory is named after the version");
        Expect(Path.GetFileName(beta) == "v0.111.0", "…for both of them");
        Expect(beta != stable, "a second version gets its own directory");
        Expect(File.Exists(stableWitness), "and leaves the first version's cache untouched");
    }

    // The mirror image, and the thing branch-scoping got wrong: a beta promoted to stable is the SAME build under
    // a second name. Naming the directory after the version means the two share it instead of each cold-rebuilding
    // what the other just built.
    private static void ABranchSwitchAtTheSameVersionSharesOneDirectory()
    {
        using var temp = new TempDir();
        var first = Resolve(temp, Content(), Slot() with { Branch = "public-beta" }).VersionRoot!;
        var witness = Seed(first, "assets/res/deadbeef.bin");

        var second = Resolve(temp, Content(), Slot() with { Branch = "public" });

        Expect(second.VersionRoot == first, "the same version is the same directory whatever the branch is called");
        Expect(File.Exists(witness), "so the bytes survive the switch");
    }

    private static void AFirstSlowPathWritesTheMap()
    {
        using var temp = new TempDir();
        Resolve(temp, Content(), Slot() with { Branch = "public" });

        var map = CouchCoopCacheRoot.ReadVersionMap(temp.Path);

        Expect(map.GetValueOrDefault("public") == "v0.107.1", "the map records which version this branch is on");
    }

    // The reason the map exists. Only it knows WHICH directory a branch just left — an LRU guess would throw away
    // whichever directory happened to be touched least recently, which on a two-install machine is routinely the
    // one the other install is still using.
    private static void ABranchMovingVersionReleasesTheOneItLeft()
    {
        using var temp = new TempDir();
        var old = Resolve(temp, Content(), Slot() with { Branch = "public" }).VersionRoot!;
        Seed(old, "assets/res/deadbeef.bin");

        Resolve(temp, Content() with { GameVersion = "v0.107.2" }, Slot() with { Branch = "public" });

        Expect(!Directory.Exists(old), "the version the branch left is released");
        Expect(
            CouchCoopCacheRoot.ReadVersionMap(temp.Path).GetValueOrDefault("public") == "v0.107.2",
            "and the map now names the new one");
    }

    // Two branches legitimately share a version. The one that moves away must not delete the directory the other
    // is still pointing at.
    private static void ASharedVersionIsNotReleasedWhileAnotherBranchIsOnIt()
    {
        using var temp = new TempDir();
        Resolve(temp, Content(), Slot() with { Branch = "public" });
        var shared = Resolve(temp, Content(), Slot() with { Branch = "public-beta" }).VersionRoot!;
        var witness = Seed(shared, "assets/res/deadbeef.bin");

        // `public-beta` moves on; `public` is still on v0.107.1.
        Resolve(temp, Content() with { GameVersion = "v0.111.0" }, Slot() with { Branch = "public-beta" });

        Expect(Directory.Exists(shared), "a version another branch still names survives");
        Expect(File.Exists(witness), "with its bytes intact");
    }

    // A directory no map entry names is unreachable — nothing will ever resolve to it again. This is also how the
    // PREVIOUS layout is reclaimed: caches used to be named after the branch (`public/`, `public-beta/`), and
    // under version naming those are orphans on the first start after the change.
    private static void AnOrphanDirectoryIsReclaimed()
    {
        using var temp = new TempDir();
        var legacy = Seed(Path.Combine(temp.Path, "public"), "assets/res/deadbeef.bin");
        var legacyBeta = Seed(Path.Combine(temp.Path, "public-beta"), "assets/res/deadbeef.bin");

        Resolve(temp, Content(), Slot() with { Branch = "public" });

        Expect(!File.Exists(legacy), "a branch-named directory from the old layout is reclaimed");
        Expect(!File.Exists(legacyBeta), "…including the one this start is not even for");
        Expect(Directory.Exists(Path.Combine(temp.Path, "v0.107.1")), "and the version directory is created");
    }

    // The map is regenerable bookkeeping, not a contract. Anything unreadable has to read as "no map" — the cost
    // is a directory the orphan sweep or the cap reclaims, and the alternative is a throw on the startup path.
    private static void ACorruptMapDegradesToAbsent()
    {
        using var temp = new TempDir();
        File.WriteAllText(Path.Combine(temp.Path, ".cache-versions.json"), "{ not json");

        var resolution = Resolve(temp, Content(), Slot() with { Branch = "public" });

        Expect(resolution.VersionRoot is not null, "a corrupt map still resolves a root");
        Expect(
            CouchCoopCacheRoot.ReadVersionMap(temp.Path).GetValueOrDefault("public") == "v0.107.1",
            "and is replaced with a readable one");
    }

    // The BACKSTOP. The map releases a directory the moment its branch moves off it; this is what bounds the
    // damage when the map could not be read or written and has forgotten an entry.
    private static void AtMostThreeVersionDirectoriesSurvive()
    {
        using var temp = new TempDir();
        var roots = new List<string>();
        foreach (var version in new[] { "v0.1.0", "v0.2.0", "v0.3.0", "v0.4.0" })
        {
            // A DIFFERENT branch each time, so the map never releases anything and only the cap can.
            roots.Add(Resolve(temp, Content() with { GameVersion = version }, Slot() with { Branch = version })
                .VersionRoot!);
        }

        Expect(Directory.Exists(roots[3]), "the version in use survives");
        Expect(!Directory.Exists(roots[0]), "the least recently used is evicted");
        Expect(VersionDirectories(temp.Path).Count == CouchCoopCacheRoot.MaxVersionDirectories,
            $"leaving exactly {CouchCoopCacheRoot.MaxVersionDirectories} version directories");
    }

    // A version that has sat unused for months is still the one being asked for, and evicting it here would
    // delete the cache the very next line is about to fill.
    private static void TheCurrentVersionIsNeverEvicted()
    {
        using var temp = new TempDir();
        var stale = Resolve(temp, Content() with { GameVersion = "v0.1.0" }, Slot() with { Branch = "a" }).VersionRoot!;
        Backdate(stale);
        Resolve(temp, Content() with { GameVersion = "v0.2.0" }, Slot() with { Branch = "b" });
        Resolve(temp, Content() with { GameVersion = "v0.3.0" }, Slot() with { Branch = "c" });

        var again = Resolve(temp, Content() with { GameVersion = "v0.1.0" }, Slot() with { Branch = "a" });

        Expect(again.VersionRoot == stale, "the version in use resolves");
        Expect(Directory.Exists(stale), "however old its stamp is");
    }

    private static void AVersionNameIsReducedToOneSafeSegment()
    {
        // Dots SURVIVE — the whole point of naming by version is that a person can read the directory.
        Expect(CouchCoopCacheRoot.DirectoryNameFor("v0.107.1") == "v0.107.1", "a version keeps its dots");
        Expect(!CouchCoopCacheRoot.DirectoryNameFor("../../etc").Contains('/'), "a traversal attempt cannot escape");
        Expect(!CouchCoopCacheRoot.DirectoryNameFor("..\\..\\etc").Contains('\\'), "nor on Windows separators");
        // A leading dot would hide the directory AND put it in the class this file reserves for metadata
        // (.trash, .cache-versions.json), which the directory walk skips wholesale.
        Expect(CouchCoopCacheRoot.DirectoryNameFor(".hidden") == "unknown", "a leading dot is refused");
        Expect(CouchCoopCacheRoot.DirectoryNameFor("..") == "unknown", "and so is a name that is only dots");
        Expect(CouchCoopCacheRoot.DirectoryNameFor("  ") == "unknown", "a blank version gets its own directory name");
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
        CouchCoopCacheRoot.ResolveOnce(
            Path.Combine(couchCoop, "cache"), Content(), () => Slot(), _ => { }, sweepLegacy: true);

        Expect(WaitUntilGone(legacyAsset), "the pre-scoping asset cache is reclaimed");
        Expect(WaitUntilGone(legacyAstc), "and so is the pre-scoping astc cache");
    }

    // ---- helpers ----------------------------------------------------------------------------------------

    private static CouchCoopCacheContent Content() => new(
        GameVersion: "v0.107.1",
        MainAssemblyHash: 1692500715,
        CacheVersion: CouchCoopCacheRoot.CacheVersion,
        AssetPayloadVersion: 1);

    private static CouchCoopCacheSlot Slot() => new(
        Branch: "public",
        BranchSource: "steamworks",
        SteamBuildId: 23811903);

    private static CouchCoopCacheRoot.Resolution Resolve(
        TempDir temp,
        CouchCoopCacheContent content,
        CouchCoopCacheSlot? slot = null,
        List<string>? log = null)
        => CouchCoopCacheRoot.ResolveOnce(
            temp.Path,
            content,
            () => slot ?? Slot(),
            line => log?.Add(line),
            sweepLegacy: false);

    private static string Seed(string root, string relativePath)
    {
        var path = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "cached");
        return path;
    }

    // Make a version look long-unused without waiting: rewrite its stamp's lastUsedUtcTicks in place.
    private static void Backdate(string versionRoot)
    {
        var path = Path.Combine(versionRoot, ".cache-identity.json");
        var node = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(path))!;
        node["lastUsedUtcTicks"] = JsonSerializer.SerializeToElement(1L);
        File.WriteAllText(path, JsonSerializer.Serialize(node));
    }

    // Everything at the base that is not dot-prefixed — i.e. the same rule the resolver's own walk uses, so the
    // map file and `.trash` never count as version directories here either.
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
