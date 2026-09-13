using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Spirectl.Sts2;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Server;

/// <summary>
/// WHERE EVERY COUCHCOOP ON-DISK CACHE LIVES, AND WHEN IT IS THROWN AWAY.
/// </summary>
/// <remarks>
/// <para>
/// Everything these caches hold is DERIVED FROM THE GAME'S CONTENT — asset bytes the host rendered, geoclips it
/// baked, ASTC containers transcoded from those bytes. So the bytes a <c>res://</c> path maps to are a property
/// of the game build, and two builds of Slay the Spire 2 render different pixels from identical paths. A cache
/// keyed only on the path serves one build's pixels for the other's, which shows up as a rendering bug with no
/// cause anywhere near the rendering code.
/// </para>
/// <para>
/// ONE DIRECTORY PER STEAM BRANCH, AT MOST TWO. The branch is the axis a player actually moves along: Steam
/// switches an install between <c>public</c> and <c>public-beta</c> in place, and somebody who moves back and
/// forth should not pay a cold rebuild each way. Keying by branch keeps both warm. Keying by game VERSION
/// instead would mint a new directory per patch and grow without bound, so the version is not in the path — it
/// is in the stamp, and a version move empties the branch's directory rather than adding a sibling. Two is a
/// hard cap, enforced by evicting the least recently used, so nothing can accumulate here.
/// </para>
/// <code>
///   &lt;base&gt;/&lt;branch&gt;/.cache-identity.json   the stamp every field of which must match
///   &lt;base&gt;/&lt;branch&gt;/assets/                 SpirectlAssetBinaryCache
///   &lt;base&gt;/&lt;branch&gt;/geoclips/               CouchCoopGeoclipStore
///   &lt;base&gt;/&lt;branch&gt;/astc/ + pending/        AstcTranscodeCache
///   &lt;base&gt;/&lt;branch&gt;/.cache-budget/           ManagedCacheQuota, per branch
///   &lt;base&gt;/.trash/&lt;guid&gt;/                    renamed-aside trees, deleted in the background
/// </code>
/// <para>
/// THE RENAME IS THE GUARANTEE, not the delete. A stale tree is moved aside before anything reads or writes it —
/// one directory rename, whatever the tree weighs — and the multi-gigabyte recursive delete happens on a
/// background thread afterwards. Deleting in place would either block the Godot main thread at startup for
/// seconds or leave a window in which the old bytes are still servable.
/// </para>
/// <para>
/// RESOLVED ONCE PER PROCESS, at the top of mod init, before anything can touch the disk. It needs no runtime
/// and no game state — just the install on disk and, when Steam is up, Steam — which is exactly why it can run
/// that early.
/// </para>
/// </remarks>
public static class CouchCoopCacheRoot
{
    /// <summary>
    /// CouchCoop's own cache generation. Bump when THIS repository changes what it stores or how it is
    /// addressed — the key grammar, the blob container, the directory layout.
    /// </summary>
    /// <remarks>
    /// Not the same lever as <see cref="SpirectlSts2Runtime.AssetPayloadVersion"/>, which versions the bytes
    /// spirectl produces and moves on spirectl's schedule. Both ride the stamp separately so either side can
    /// invalidate without the other having to know.
    /// </remarks>
    public const int CacheVersion = 1;

    /// <summary>Overrides the machine's cache base. Branch scoping still applies underneath it.</summary>
    public const string RootEnvironmentVariable = "COUCHCOOP_CACHE_ROOT";

    /// <summary>Dot-prefixed so it is never servable and never mistaken for cached content.</summary>
    internal const string IdentityFileName = ".cache-identity.json";

    internal const string TrashFolderName = ".trash";

    /// <summary>What a branch directory is called when nothing could identify one.</summary>
    internal const string UnknownBranch = "unknown";

    private static readonly JsonSerializerOptions StampJson = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private static readonly Lazy<Resolution> Current = new(
        () => ResolveOnce(DefaultBaseRoot(), CouchCoopCacheIdentity.Resolve(), DefaultLog),
        LazyThreadSafetyMode.ExecutionAndPublication);

    /// <summary>
    /// Force resolution (and, if the stamp has moved, the purge) now, and report what happened.
    /// </summary>
    /// <remarks>
    /// Called at the very top of mod init. Everything else reaches this lazily, so forgetting the call costs
    /// correctness nothing — it only moves the work to whichever request happens to need the cache first.
    /// </remarks>
    public static void Warm() => _ = Current.Value;

    /// <summary>The branch directory in use, or null when no cache root could be resolved at all.</summary>
    public static string? BranchRoot => Current.Value.BranchRoot;

    /// <summary>The identity this process resolved. Never null; may be entirely unknown.</summary>
    public static CouchCoopCacheIdentity Identity => Current.Value.Identity;

    /// <summary>
    /// The two cache leaves, named here rather than in each cache, because an EXPLICITLY-rooted cache uses the
    /// same names: one on-disk shape means anything that walks a cache (the geoclip bench's snapshot diff, an
    /// operator reading the directory) has one rule rather than two.
    /// </summary>
    public const string AssetsFolderName = "assets";
    public const string GeoclipFolderName = "geoclips";

    public static string? AssetsRoot => Combine(AssetsFolderName);
    public static string? GeoclipRoot => Combine(GeoclipFolderName);
    // AstcTranscodeCache owns two leaves rather than one (`astc/` and `pending/`), so it takes the branch root
    // directly and hangs both beside `assets/` and `geoclips/`.

    /// <summary>
    /// The admission quota for this branch's whole directory — one budget covering every cache under it.
    /// </summary>
    internal static ManagedCacheQuota? Quota => Current.Value.Quota;

    private static string? Combine(string leaf) =>
        Current.Value.BranchRoot is { } root ? Path.Combine(root, leaf) : null;

    // ---- resolution ---------------------------------------------------------------------------------------

    internal sealed record Resolution(string? BranchRoot, CouchCoopCacheIdentity Identity, ManagedCacheQuota? Quota);

    /// <summary>
    /// The whole policy, as a pure-ish function of a base root and an identity, so tests drive it without a game.
    /// </summary>
    internal static Resolution ResolveOnce(
        string? baseRoot,
        CouchCoopCacheIdentity identity,
        Action<string> log,
        bool sweepLegacy = true)
    {
        if (string.IsNullOrWhiteSpace(baseRoot))
        {
            log("[couch-coop] cache disabled: no writable cache root could be resolved");
            return new Resolution(null, identity, null);
        }

        var branchRoot = Path.Combine(baseRoot, DirectoryNameFor(identity.Branch));
        var trashRoot = Path.Combine(baseRoot, TrashFolderName);
        var stamp = CacheIdentityStamp.For(identity);

        // Cross-process: the host and every headless seat come up together after a game update and would
        // otherwise each try to move the same tree aside. Same named-mutex shape ManagedCacheQuota uses.
        using var gate = new CacheGate(baseRoot);
        var held = gate.Enter();
        try
        {
            var existing = TryReadStamp(branchRoot);
            if (existing is not null && existing.Matches(stamp))
            {
                TouchLastUsed(branchRoot, stamp, log);
            }
            else
            {
                if (Directory.Exists(branchRoot))
                {
                    var reason = existing is null ? "no readable stamp" : existing.DescribeDifference(stamp);
                    if (!TryMoveAside(branchRoot, trashRoot, log))
                    {
                        // Refusing the cache entirely is the only safe answer left: the tree that is there
                        // was written for something else, and serving from it is the one forbidden outcome.
                        log($"[couch-coop] cache disabled: stale cache at {branchRoot} could not be moved aside ({reason})");
                        return new Resolution(null, identity, null);
                    }
                    log($"[couch-coop] cache purged branch={identity.Branch} reason={reason}");
                }

                WriteStamp(branchRoot, stamp, log);
            }

            EvictBeyondCap(baseRoot, branchRoot, trashRoot, log);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            log($"[couch-coop] cache disabled: {exception.GetType().Name}: {exception.Message}");
            return new Resolution(null, identity, null);
        }
        finally
        {
            if (held)
            {
                gate.Release();
            }
        }

        log($"[couch-coop] cache branch={identity.Branch} source={identity.BranchSource} "
            + $"game={Describe(identity.GameVersion)} build={identity.SteamBuildId} "
            + $"cache=v{identity.CacheVersion}+sp{identity.AssetPayloadVersion} root={branchRoot}");

        StartBackgroundSweep(trashRoot, sweepLegacy ? LegacyRootsFor(baseRoot) : []);
        return new Resolution(branchRoot, identity, ManagedCacheQuota.ForCacheRoot(branchRoot));
    }

    private static string Describe(string value) => value.Length == 0 ? "unknown" : value;

    /// <summary>A branch name reduced to one safe path segment.</summary>
    internal static string DirectoryNameFor(string branch)
    {
        if (string.IsNullOrWhiteSpace(branch))
        {
            return UnknownBranch;
        }

        var builder = new StringBuilder(branch.Length);
        foreach (var c in branch.Trim())
        {
            builder.Append(char.IsAsciiLetterOrDigit(c) || c is '_' or '-' ? c : '_');
        }

        return builder.Length == 0 ? UnknownBranch : builder.ToString();
    }

    // ---- the two-directory cap ----------------------------------------------------------------------------

    internal const int MaxBranchDirectories = 2;

    /// <summary>
    /// Keep this branch plus at most one other, the most recently used. Everything else moves to trash.
    /// </summary>
    /// <remarks>
    /// Without this, a branch that is renamed upstream, or a fallback-named directory from a launch where
    /// neither Steam nor the manifest could answer, would sit here for ever holding gigabytes nothing reads.
    /// The current branch is never a candidate for eviction whatever its timestamp says.
    /// </remarks>
    private static void EvictBeyondCap(string baseRoot, string branchRoot, string trashRoot, Action<string> log)
    {
        if (!Directory.Exists(baseRoot))
        {
            return;
        }

        var others = Directory.EnumerateDirectories(baseRoot)
            .Where(path => !PathsEqual(path, branchRoot))
            .Where(path => !string.Equals(Path.GetFileName(path), TrashFolderName, StringComparison.Ordinal))
            .Select(path => (Path: path, LastUsed: TryReadStamp(path)?.LastUsedUtcTicks ?? 0L))
            .OrderByDescending(entry => entry.LastUsed)
            .ToList();

        foreach (var (path, _) in others.Skip(MaxBranchDirectories - 1))
        {
            if (TryMoveAside(path, trashRoot, log))
            {
                log($"[couch-coop] cache evicted branch={Path.GetFileName(path)} (keeping at most {MaxBranchDirectories})");
            }
        }
    }

    // ---- the stamp ----------------------------------------------------------------------------------------

    internal static CacheIdentityStamp? TryReadStamp(string branchRoot)
    {
        try
        {
            var path = Path.Combine(branchRoot, IdentityFileName);
            return File.Exists(path)
                ? JsonSerializer.Deserialize<CacheIdentityStamp>(File.ReadAllText(path), StampJson)
                : null;
        }
        catch (Exception exception) when (IsIoFailure(exception) || exception is JsonException)
        {
            return null;
        }
    }

    private static void WriteStamp(string branchRoot, CacheIdentityStamp stamp, Action<string> log)
    {
        try
        {
            Directory.CreateDirectory(branchRoot);
            var path = Path.Combine(branchRoot, IdentityFileName);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(stamp with { LastUsedUtcTicks = DateTime.UtcNow.Ticks }, StampJson));
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            // A stamp we cannot write means the next start re-purges a cache that was actually fine. Wasteful,
            // never wrong — so it is a log line, not a refusal.
            log($"[couch-coop] cache stamp write failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private static void TouchLastUsed(string branchRoot, CacheIdentityStamp stamp, Action<string> log)
        => WriteStamp(branchRoot, stamp, log);

    // ---- moving aside and sweeping ------------------------------------------------------------------------

    private static bool TryMoveAside(string directory, string trashRoot, Action<string> log)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                Directory.CreateDirectory(trashRoot);
                Directory.Move(directory, Path.Combine(trashRoot, Guid.NewGuid().ToString("N")));
                return true;
            }
            catch (Exception exception) when (IsIoFailure(exception))
            {
                if (attempt == 1)
                {
                    log($"[couch-coop] cache move-aside failed for {directory}: {exception.GetType().Name}: {exception.Message}");
                }
            }
        }

        return false;
    }

    private static void StartBackgroundSweep(string trashRoot, IReadOnlyList<string> legacyRoots)
    {
        if (!Directory.Exists(trashRoot) && legacyRoots.Count == 0)
        {
            return;
        }

        _ = Task.Run(() =>
        {
            if (Directory.Exists(trashRoot))
            {
                foreach (var directory in SafeEnumerate(trashRoot))
                {
                    TryDeleteTree(directory);
                }
            }

            SweepLegacyLayout(legacyRoots);
        });
    }

    private static IEnumerable<string> SafeEnumerate(string root)
    {
        try
        {
            return Directory.EnumerateDirectories(root).ToArray();
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            return [];
        }
    }

    private static void TryDeleteTree(string directory)
    {
        try { Directory.Delete(directory, recursive: true); }
        catch (Exception exception) when (IsIoFailure(exception)) { }
    }

    // ---- TEMPORARY: pre-branch-scoping layout cleanup ------------------------------------------------------

    /// <summary>
    /// REMOVE THIS METHOD AND ITS ONE CALL SITE ON OR AFTER 2026-10-13.
    /// </summary>
    /// <remarks>
    /// <para>Before caches were branch scoped they lived at <c>user://couch-coop/assets/</c> (with a
    /// <c>couchcoop-asset-cache-v13</c> / <c>couchcoop-geoclip-cache-v1</c> namespace under it) and
    /// <c>user://couch-coop/astc-cache/</c>. Nothing reads those paths any more, so on an install that ran the
    /// old layout they are simply gigabytes of unreachable files. This reclaims them once.</para>
    /// <para>It is deliberately a self-contained method with a single call site and no state anywhere else: no
    /// stamp field, no migration flag, nothing to unwind. Deleting the method and its call is the entire removal.
    /// After a month every install that is going to start has started, and it is pure dead code.</para>
    /// </remarks>
    private static void SweepLegacyLayout(IReadOnlyList<string> legacyRoots)
    {
        foreach (var root in legacyRoots)
        {
            TryDeleteTree(root);
        }
    }

    /// <summary>
    /// The pre-branch-scoping directories under <paramref name="baseRoot"/>'s parent, or empty when the base was
    /// operator-supplied (where no such layout ever existed, and where guessing at siblings could delete
    /// something that is not ours).
    /// </summary>
    /// <remarks>Removed together with <see cref="SweepLegacyLayout"/> — see its remarks for the date.</remarks>
    private static IReadOnlyList<string> LegacyRootsFor(string baseRoot)
    {
        if (!string.Equals(Path.GetFileName(baseRoot.TrimEnd(Path.DirectorySeparatorChar)), CacheFolderName, StringComparison.Ordinal))
        {
            return [];
        }

        var couchCoop = Path.GetDirectoryName(baseRoot.TrimEnd(Path.DirectorySeparatorChar));
        return string.IsNullOrWhiteSpace(couchCoop)
            ? []
            : [Path.Combine(couchCoop, "assets"), Path.Combine(couchCoop, "astc-cache")];
    }

    // ---- base root ----------------------------------------------------------------------------------------

    private const string CacheFolderName = "cache";

    /// <summary>
    /// The machine's cache BASE — the directory the branch directories hang under.
    /// </summary>
    /// <remarks>
    /// <c>COUCHCOOP_CACHE_ROOT</c> wins (the harnesses and benches point every cache at one scratch directory
    /// with it); then the game's own data dir, so the cache sits beside <c>logs</c> where a player can find and
    /// delete it; then per-user application data for a host with no Godot at all.
    /// </remarks>
    internal static string? DefaultBaseRoot()
    {
        var configured = Environment.GetEnvironmentVariable(RootEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        // GodotSharp is provided by the running game, not the test/headless runner — referencing it can throw an
        // assembly-load failure when the method is JIT-compiled, so the call is isolated in a non-inlined method
        // and the failure is caught HERE (a try INSIDE that method would never run).
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
            ? Path.Combine(Path.GetTempPath(), "SlayTheSpire2", "couch-coop", CacheFolderName)
            : Path.Combine(local, "SlayTheSpire2", "couch-coop", CacheFolderName);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static string? TryResolveGameDataDir()
    {
        var globalized = Godot.ProjectSettings.GlobalizePath("user://couch-coop/" + CacheFolderName);
        return string.IsNullOrWhiteSpace(globalized) || globalized.StartsWith("user://", StringComparison.Ordinal)
            ? null
            : globalized;
    }

    // ---- plumbing -----------------------------------------------------------------------------------------

    /// <summary>
    /// An extra sink for the one line this type narrates. Set it BEFORE <see cref="Warm"/>.
    /// </summary>
    /// <remarks>
    /// A hook rather than a direct call to <c>CouchCoopLog</c>, for a reason the compiler enforces: this file is
    /// also linked into <c>CouchCoop.Mod.HotReload</c>, which does not reference the game assemblies at all, so a
    /// reference to the game's logger here would not build there. <c>CouchCoopMod</c> points it at
    /// <c>CouchCoopLog.Info</c>, which is the only channel that reaches <c>godot.log</c> in the shipped Steam
    /// flow — <c>Console.Error</c>, written unconditionally below, does not.
    /// </remarks>
    public static Action<string>? LogSink { get; set; }

    private static void DefaultLog(string message)
    {
        Console.Error.WriteLine(message);
        LogSink?.Invoke(message);
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static bool IsIoFailure(Exception exception) =>
        exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException
            or System.Security.SecurityException;

    /// <summary>Cross-process serialization of the resolve/purge/evict sequence for one base root.</summary>
    private sealed class CacheGate(string baseRoot) : IDisposable
    {
        private readonly Mutex _mutex = new(
            false,
            "couchcoop-cache-identity-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                OperatingSystem.IsWindows() ? baseRoot.ToUpperInvariant() : baseRoot))));

        public bool Enter()
        {
            // Bounded: a peer wedged holding this must not wedge the game's startup with it. Proceeding without
            // the gate is safe — every step below is idempotent and the loser simply re-reads a fresh stamp.
            try { return _mutex.WaitOne(TimeSpan.FromSeconds(10)); }
            catch (AbandonedMutexException) { return true; }
        }

        public void Release()
        {
            try { _mutex.ReleaseMutex(); }
            catch (ApplicationException) { }
        }

        public void Dispose() => _mutex.Dispose();
    }
}

/// <summary>
/// Everything that makes cached bytes valid or stale: which game build produced them, and which cache
/// generations wrote them.
/// </summary>
public sealed record CouchCoopCacheIdentity(
    string Branch,
    string BranchSource,
    int SteamBuildId,
    string GameVersion,
    int MainAssemblyHash,
    int CacheVersion,
    int AssetPayloadVersion)
{
    /// <summary>
    /// Resolve this process's identity: the install's Steam branch and build from spirectl, plus our own two
    /// cache generations.
    /// </summary>
    /// <remarks>
    /// The branch falls back to the spirectl API LANE when Steam cannot be asked at all — a copied install
    /// launched outside Steam. A lane is a coarser answer than a branch (one lane can serve several game builds)
    /// but it separates the two supported builds, which is what the directory is for; the stamp still carries the
    /// exact version, so a build move inside a lane still purges.
    /// </remarks>
    public static CouchCoopCacheIdentity Resolve()
    {
        var build = Sts2GameBuildIdentity.Resolve();
        var branch = build.HasBranch ? build.Branch : BridgeBuildInfo.Sts2ApiLane;
        var source = build.HasBranch ? build.BranchSource : (branch.Length > 0 ? "api-lane" : "unknown");
        return new CouchCoopCacheIdentity(
            branch,
            source,
            build.BuildId,
            build.Version,
            build.MainAssemblyHash,
            CouchCoopCacheRoot.CacheVersion,
            SpirectlSts2Runtime.AssetPayloadVersion);
    }
}

/// <summary>
/// The on-disk stamp. Every field but <see cref="LastUsedUtcTicks"/> takes part in the staleness comparison.
/// </summary>
/// <remarks>
/// <see cref="BranchSource"/> is recorded but NOT compared: it says how the branch was learned, not what was
/// cached, so a start where Steam happened to be down must not throw away a cache Steam itself validated.
/// </remarks>
internal sealed record CacheIdentityStamp(
    int CacheVersion,
    int AssetPayloadVersion,
    string GameVersion,
    int MainAssemblyHash,
    int SteamBuildId,
    string Branch,
    string BranchSource,
    long LastUsedUtcTicks)
{
    public static CacheIdentityStamp For(CouchCoopCacheIdentity identity) => new(
        identity.CacheVersion,
        identity.AssetPayloadVersion,
        identity.GameVersion,
        identity.MainAssemblyHash,
        identity.SteamBuildId,
        identity.Branch,
        identity.BranchSource,
        LastUsedUtcTicks: 0);

    public bool Matches(CacheIdentityStamp other) =>
        CacheVersion == other.CacheVersion
        && AssetPayloadVersion == other.AssetPayloadVersion
        && MainAssemblyHash == other.MainAssemblyHash
        && SteamBuildId == other.SteamBuildId
        && string.Equals(GameVersion, other.GameVersion, StringComparison.Ordinal)
        && string.Equals(Branch, other.Branch, StringComparison.Ordinal);

    /// <summary>Which field moved, for the one log line a purge emits.</summary>
    public string DescribeDifference(CacheIdentityStamp other)
    {
        if (CacheVersion != other.CacheVersion) return $"cacheVersion {CacheVersion}→{other.CacheVersion}";
        if (AssetPayloadVersion != other.AssetPayloadVersion) return $"assetPayloadVersion {AssetPayloadVersion}→{other.AssetPayloadVersion}";
        if (!string.Equals(GameVersion, other.GameVersion, StringComparison.Ordinal)) return $"gameVersion {Show(GameVersion)}→{Show(other.GameVersion)}";
        if (MainAssemblyHash != other.MainAssemblyHash) return $"mainAssemblyHash {MainAssemblyHash}→{other.MainAssemblyHash}";
        if (SteamBuildId != other.SteamBuildId) return $"steamBuildId {SteamBuildId}→{other.SteamBuildId}";
        if (!string.Equals(Branch, other.Branch, StringComparison.Ordinal)) return $"branch {Show(Branch)}→{Show(other.Branch)}";
        return "no difference";
    }

    private static string Show(string value) => value.Length == 0 ? "(none)" : value;
}
