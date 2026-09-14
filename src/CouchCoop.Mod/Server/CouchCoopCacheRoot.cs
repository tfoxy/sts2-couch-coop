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
/// ONE DIRECTORY PER GAME VERSION, named after it. The version comes from the install's own
/// <c>release_info.json</c>, so it is a fact the install states about ITSELF — which is what makes the layout
/// immune to the flakiest input in the identity, the Steam branch. Two installs of different versions cannot
/// collide however their branch resolves; an install that hops between versions gets a sibling per version and
/// keeps both warm.
/// </para>
/// <para>
/// THIS USED TO BE KEYED BY BRANCH, and the objection to versions then was that they "mint a new directory per
/// patch and grow without bound". The map below is the answer to that objection: it records which version each
/// branch is currently on, so when a branch moves we know exactly which directory it left and may delete it —
/// by knowledge rather than by an LRU guess. The cap is still there, demoted to a backstop for a map we could
/// not read.
/// </para>
/// <code>
///   &lt;base&gt;/.cache-versions.json              branch -> version, the map that says what may be deleted
///   &lt;base&gt;/&lt;version&gt;/.cache-identity.json  the stamp; its CONTENT fields must match
///   &lt;base&gt;/&lt;version&gt;/assets/               SpirectlAssetBinaryCache
///   &lt;base&gt;/&lt;version&gt;/geoclips/             CouchCoopGeoclipStore
///   &lt;base&gt;/&lt;version&gt;/astc/ + pending/      AstcTranscodeCache
///   &lt;base&gt;/&lt;version&gt;/.cache-budget/        ManagedCacheQuota, per version
///   &lt;base&gt;/.trash/&lt;guid&gt;/                   renamed-aside trees, deleted in the background
/// </code>
/// <para>
/// THE ORDINARY START ASKS STEAM NOTHING. When the version directory is already there and its stamp matches,
/// that is the whole answer: the branch decides nothing about where bytes live, so nothing needs to resolve it.
/// It is consulted only on the slow path, to do the map bookkeeping — where a wrong answer costs a directory
/// that lingers, never a directory that serves the wrong bytes. See <see cref="ResolveOnce"/>.
/// </para>
/// <para>
/// THE RENAME IS THE GUARANTEE, not the delete. A stale tree is moved aside before anything reads or writes it —
/// one directory rename, whatever the tree weighs — and the multi-gigabyte recursive delete happens on a
/// background thread afterwards. Deleting in place would either block the Godot main thread at startup for
/// seconds or leave a window in which the old bytes are still servable.
/// </para>
/// <para>
/// RESOLVED ONCE PER PROCESS, at the top of mod init, before anything can touch the disk. It needs no runtime
/// and no game state — just the install on disk, and Steam only on the slow path — which is exactly why it can
/// run that early.
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

    /// <summary>Overrides the machine's cache base. Version scoping still applies underneath it.</summary>
    public const string RootEnvironmentVariable = "COUCHCOOP_CACHE_ROOT";

    /// <summary>Dot-prefixed so it is never servable and never mistaken for cached content.</summary>
    internal const string IdentityFileName = ".cache-identity.json";

    /// <summary>
    /// The branch → version map, at the BASE root. Dot-prefixed for the same reason the stamp is, and for one
    /// more: every other entry at this level is a version directory, and this must never be mistaken for one.
    /// </summary>
    internal const string VersionMapFileName = ".cache-versions.json";

    internal const string TrashFolderName = ".trash";

    /// <summary>What a version directory is called when the install could not state its version.</summary>
    internal const string UnknownVersion = "unknown";

    private static readonly JsonSerializerOptions StampJson = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private static readonly Lazy<Resolution> Current = new(
        () => ResolveOnce(
            DefaultBaseRoot(),
            CouchCoopCacheContent.Resolve(),
            CouchCoopCacheSlot.Resolve,
            DefaultLog),
        LazyThreadSafetyMode.ExecutionAndPublication);

    /// <summary>
    /// Force resolution (and, if the stamp has moved, the purge) now, and report what happened.
    /// </summary>
    /// <remarks>
    /// Called at the very top of mod init. Everything else reaches this lazily, so forgetting the call costs
    /// correctness nothing — it only moves the work to whichever request happens to need the cache first.
    /// </remarks>
    public static void Warm() => _ = Current.Value;

    /// <summary>The version directory in use, or null when no cache root could be resolved at all.</summary>
    public static string? VersionRoot => Current.Value.VersionRoot;

    /// <summary>
    /// What this install says about its own content. Never null; may be entirely unknown. Steam-free, so
    /// reading it never forces a branch lookup.
    /// </summary>
    public static CouchCoopCacheContent Content => Current.Value.Content;

    /// <summary>
    /// The branch this process resolved, or null when the fast path meant nobody ever had to ask.
    /// </summary>
    /// <remarks>
    /// Diagnostics only. Nothing may key cached bytes — on disk or on a client — off a value that is present
    /// or absent depending on which path a start happened to take.
    /// </remarks>
    public static CouchCoopCacheSlot? ResolvedSlot => Current.Value.Slot;

    /// <summary>
    /// The two cache leaves, named here rather than in each cache, because an EXPLICITLY-rooted cache uses the
    /// same names: one on-disk shape means anything that walks a cache (the geoclip bench's snapshot diff, an
    /// operator reading the directory) has one rule rather than two.
    /// </summary>
    public const string AssetsFolderName = "assets";
    public const string GeoclipFolderName = "geoclips";

    public static string? AssetsRoot => Combine(AssetsFolderName);
    public static string? GeoclipRoot => Combine(GeoclipFolderName);
    // AstcTranscodeCache owns two leaves rather than one (`astc/` and `pending/`), so it takes the version root
    // directly and hangs both beside `assets/` and `geoclips/`.

    /// <summary>
    /// The admission quota for this version's whole directory — one budget covering every cache under it.
    /// </summary>
    internal static ManagedCacheQuota? Quota => Current.Value.Quota;

    private static string? Combine(string leaf) =>
        Current.Value.VersionRoot is { } root ? Path.Combine(root, leaf) : null;

    // ---- resolution ---------------------------------------------------------------------------------------

    internal sealed record Resolution(
        string? VersionRoot,
        CouchCoopCacheContent Content,
        CouchCoopCacheSlot? Slot,
        ManagedCacheQuota? Quota);

    /// <summary>
    /// The whole policy, as a pure-ish function of a base root and what the install says about itself, so tests
    /// drive it without a game.
    /// </summary>
    /// <param name="resolveSlot">
    /// The branch, resolved ONLY if the slow path needs it. A <c>Func</c> rather than a value because "did this
    /// start have to ask Steam?" is a property worth being able to assert — the fast path must never call it.
    /// </param>
    internal static Resolution ResolveOnce(
        string? baseRoot,
        CouchCoopCacheContent content,
        Func<CouchCoopCacheSlot> resolveSlot,
        Action<string> log,
        bool sweepLegacy = true)
    {
        if (string.IsNullOrWhiteSpace(baseRoot))
        {
            log("[couch-coop] cache disabled: no writable cache root could be resolved");
            return new Resolution(null, content, null, null);
        }

        var versionName = DirectoryNameFor(content.GameVersion);
        var versionRoot = Path.Combine(baseRoot, versionName);
        var trashRoot = Path.Combine(baseRoot, TrashFolderName);
        var stamp = CacheIdentityStamp.For(content);
        CouchCoopCacheSlot? slot = null;

        // Cross-process: the host and every headless seat come up together after a game update and would
        // otherwise each try to move the same tree aside — and, now, to rewrite the same map. Same named-mutex
        // shape ManagedCacheQuota uses. The map is a read-modify-write, so it has to happen in here.
        using var gate = new CacheGate(baseRoot);
        var held = gate.Enter();
        try
        {
            var existing = TryReadStamp(versionRoot);
            if (existing is not null && existing.Matches(stamp))
            {
                // THE FAST PATH. The directory for this version is here and vouched for, which is the entire
                // answer — so no branch is resolved, no map is read, and Steam is never asked anything.
                TouchLastUsed(versionRoot, stamp, log);
            }
            else
            {
                slot = resolveSlot();
                var reason = Directory.Exists(versionRoot)
                    ? (existing is null ? "no readable stamp" : existing.DescribeDifference(stamp))
                    : null;

                // The map bookkeeping comes FIRST, so the directory this branch is leaving is released even if
                // the (rarer) purge of a mismatched current directory fails below.
                ReleaseThePreviousVersion(baseRoot, trashRoot, slot.Branch, versionName, log);

                if (reason is not null)
                {
                    if (!TryMoveAside(versionRoot, trashRoot, log))
                    {
                        // Refusing the cache entirely is the only safe answer left: the tree that is there
                        // was written for something else, and serving from it is the one forbidden outcome.
                        log($"[couch-coop] cache disabled: stale cache at {versionRoot} could not be moved aside ({reason})");
                        return new Resolution(null, content, slot, null);
                    }
                    log($"[couch-coop] cache purged version={versionName} reason={reason}");
                }

                SweepOrphans(baseRoot, versionName, trashRoot, log);
                WriteStamp(versionRoot, stamp, slot, log);
            }

            EvictBeyondCap(baseRoot, versionRoot, trashRoot, log);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            log($"[couch-coop] cache disabled: {exception.GetType().Name}: {exception.Message}");
            return new Resolution(null, content, slot, null);
        }
        finally
        {
            if (held)
            {
                gate.Release();
            }
        }

        // The branch is reported only when this start actually had to resolve one. "branch not consulted" is
        // the ordinary case and the line says so, rather than printing a stale or invented value.
        log($"[couch-coop] cache game={Describe(content.GameVersion)} hash={content.MainAssemblyHash} "
            + $"cache=v{content.CacheVersion}+sp{content.AssetPayloadVersion} root={versionRoot} "
            + (slot is null
                ? "(branch not consulted)"
                : $"branch={Describe(slot.Branch)} source={slot.BranchSource} build={slot.SteamBuildId}"));

        StartBackgroundSweep(trashRoot, sweepLegacy ? LegacyRootsFor(baseRoot) : []);
        return new Resolution(versionRoot, content, slot, ManagedCacheQuota.ForCacheRoot(versionRoot));
    }

    private static string Describe(string value) => value.Length == 0 ? "unknown" : value;

    // ---- the branch -> version map -------------------------------------------------------------------------

    /// <summary>
    /// Point <paramref name="branch"/> at <paramref name="versionName"/>, and move aside the version it was on.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the whole reason the map exists. A branch that moves to a new version leaves its old directory
    /// behind, and only the map knows WHICH directory that was — the alternative is an LRU guess that throws
    /// away whichever directory happened to be touched least recently, which on a two-install machine is
    /// routinely the wrong one.
    /// </para>
    /// <para>
    /// ONLY IF NO OTHER BRANCH IS ON IT. Two branches legitimately share a version — a beta that has been
    /// promoted to stable is the same build under two names — and the one that moves away must not delete the
    /// directory the other is still using.
    /// </para>
    /// </remarks>
    private static void ReleaseThePreviousVersion(
        string baseRoot,
        string trashRoot,
        string branch,
        string versionName,
        Action<string> log)
    {
        var key = MapKeyFor(branch);
        var map = ReadVersionMap(baseRoot);
        var previous = map.GetValueOrDefault(key);

        if (previous is not null
            && !string.Equals(previous, versionName, StringComparison.Ordinal)
            && !map.Any(entry =>
                !string.Equals(entry.Key, key, StringComparison.Ordinal)
                && string.Equals(entry.Value, previous, StringComparison.Ordinal)))
        {
            var previousRoot = Path.Combine(baseRoot, previous);
            if (Directory.Exists(previousRoot) && TryMoveAside(previousRoot, trashRoot, log))
            {
                log($"[couch-coop] cache released version={previous} (branch={key} moved to {versionName})");
            }
        }

        map[key] = versionName;
        WriteVersionMap(baseRoot, map, log);
    }

    /// <summary>The map's key for a branch — never blank, so an unidentified install still gets one slot.</summary>
    private static string MapKeyFor(string branch) =>
        string.IsNullOrWhiteSpace(branch) ? UnknownVersion : branch.Trim();

    /// <summary>
    /// The map, or an EMPTY one when it is absent, unreadable or not the shape we write.
    /// </summary>
    /// <remarks>
    /// Degrading to empty is right for all three: the map is regenerable bookkeeping, not a contract, and the
    /// cost of having forgotten an entry is a directory the orphan sweep or the cap reclaims instead.
    /// </remarks>
    internal static Dictionary<string, string> ReadVersionMap(string baseRoot)
    {
        try
        {
            var path = Path.Combine(baseRoot, VersionMapFileName);
            if (!File.Exists(path))
            {
                return new(StringComparer.Ordinal);
            }

            var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path), StampJson);
            return parsed is null
                ? new(StringComparer.Ordinal)
                : new Dictionary<string, string>(parsed, StringComparer.Ordinal);
        }
        catch (Exception exception) when (IsIoFailure(exception) || exception is JsonException)
        {
            return new(StringComparer.Ordinal);
        }
    }

    private static void WriteVersionMap(string baseRoot, Dictionary<string, string> map, Action<string> log)
    {
        try
        {
            Directory.CreateDirectory(baseRoot);
            var path = Path.Combine(baseRoot, VersionMapFileName);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(map, StampJson));
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            // A map we cannot write means a directory we will not be able to release by name later. The cap
            // still bounds the damage, so this is a log line rather than a refusal.
            log($"[couch-coop] cache version-map write failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// Move aside every version directory that is neither the one in use nor named by the map.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A directory no map entry names is unreachable: nothing will ever resolve to it, because resolution goes
    /// by version name and the map is what remembers the versions a branch has been on.
    /// </para>
    /// <para>
    /// It is also how the PREVIOUS layout is reclaimed. Caches used to be named after the branch
    /// (<c>public/</c>, <c>public-beta/</c>); under version naming those are orphans on the first start after
    /// the change, and this collects them in one pass rather than leaving gigabytes for the cap to dribble out.
    /// </para>
    /// <para>Runs on the slow path only, which is where the map has just been made current.</para>
    /// </remarks>
    private static void SweepOrphans(string baseRoot, string versionName, string trashRoot, Action<string> log)
    {
        var named = new HashSet<string>(ReadVersionMap(baseRoot).Values, StringComparer.Ordinal) { versionName };

        foreach (var directory in VersionDirectories(baseRoot))
        {
            if (named.Contains(Path.GetFileName(directory)))
            {
                continue;
            }

            if (TryMoveAside(directory, trashRoot, log))
            {
                log($"[couch-coop] cache reclaimed orphan version={Path.GetFileName(directory)}");
            }
        }
    }

    /// <summary>
    /// The version directories under <paramref name="baseRoot"/> — everything that is not dot-prefixed.
    /// </summary>
    /// <remarks>
    /// Dot-prefixed is the rule rather than a list of known names, because the base now holds a dot-prefixed
    /// FILE (the map) beside <c>.trash/</c>, and anything added later should be excluded by being named that
    /// way rather than by being remembered here.
    /// </remarks>
    private static IEnumerable<string> VersionDirectories(string baseRoot)
    {
        if (!Directory.Exists(baseRoot))
        {
            return [];
        }

        return Directory.EnumerateDirectories(baseRoot)
            .Where(path => !Path.GetFileName(path).StartsWith('.'))
            .ToArray();
    }

    /// <summary>
    /// A game version reduced to one safe path segment.
    /// </summary>
    /// <remarks>
    /// <c>.</c> survives, because the whole point is that a directory called <c>v0.107.1</c> is readable by the
    /// person looking at it — but a name that is EMPTY, all dots, or leads with one is refused: a leading dot
    /// would hide the directory and put it in the class this file reserves for metadata, and <c>.</c>/<c>..</c>
    /// are the traversal the sanitiser exists to stop.
    /// </remarks>
    internal static string DirectoryNameFor(string version)
    {
        if (string.IsNullOrWhiteSpace(version))
        {
            return UnknownVersion;
        }

        var builder = new StringBuilder(version.Length);
        foreach (var c in version.Trim())
        {
            builder.Append(char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.' ? c : '_');
        }

        var name = builder.ToString();
        return name.Length == 0 || name.StartsWith('.') || name.All(c => c == '.')
            ? UnknownVersion
            : name;
    }

    // ---- the directory cap, now a backstop -----------------------------------------------------------------

    internal const int MaxVersionDirectories = 3;

    /// <summary>
    /// Keep this version plus at most two others, the most recently used. Everything else moves to trash.
    /// </summary>
    /// <remarks>
    /// A BACKSTOP, not the policy. The map releases a directory the moment its branch moves off it, which is
    /// both earlier and better targeted than any LRU rule — but a map that could not be read or written forgets
    /// entries, and without a cap that would mean gigabytes nothing will ever reclaim. Three because the two
    /// supported branches plus one in flight during an update is the most a working machine should hold.
    /// The version in use is never a candidate for eviction whatever its timestamp says.
    /// </remarks>
    private static void EvictBeyondCap(string baseRoot, string versionRoot, string trashRoot, Action<string> log)
    {
        if (!Directory.Exists(baseRoot))
        {
            return;
        }

        var others = VersionDirectories(baseRoot)
            .Where(path => !PathsEqual(path, versionRoot))
            .Select(path => (Path: path, LastUsed: TryReadStamp(path)?.LastUsedUtcTicks ?? 0L))
            .OrderByDescending(entry => entry.LastUsed)
            .ToList();

        foreach (var (path, _) in others.Skip(MaxVersionDirectories - 1))
        {
            if (TryMoveAside(path, trashRoot, log))
            {
                log($"[couch-coop] cache evicted version={Path.GetFileName(path)} (keeping at most {MaxVersionDirectories})");
            }
        }
    }

    // ---- the stamp ----------------------------------------------------------------------------------------

    internal static CacheIdentityStamp? TryReadStamp(string versionRoot)
    {
        try
        {
            var path = Path.Combine(versionRoot, IdentityFileName);
            return File.Exists(path)
                ? JsonSerializer.Deserialize<CacheIdentityStamp>(File.ReadAllText(path), StampJson)
                : null;
        }
        catch (Exception exception) when (IsIoFailure(exception) || exception is JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Write the stamp. <paramref name="slot"/> is the branch this start resolved, or null on the fast path —
    /// it is RECORDED, never compared, so a refresh that never asked keeps whatever the last one wrote.
    /// </summary>
    private static void WriteStamp(
        string versionRoot,
        CacheIdentityStamp stamp,
        CouchCoopCacheSlot? slot,
        Action<string> log)
    {
        try
        {
            Directory.CreateDirectory(versionRoot);
            var path = Path.Combine(versionRoot, IdentityFileName);
            var labelled = slot is null
                ? stamp with { LastUsedUtcTicks = DateTime.UtcNow.Ticks }
                : stamp with
                {
                    LastUsedUtcTicks = DateTime.UtcNow.Ticks,
                    Branch = slot.Branch,
                    BranchSource = slot.BranchSource,
                    SteamBuildId = slot.SteamBuildId,
                };
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(labelled, StampJson));
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            // A stamp we cannot write means the next start re-purges a cache that was actually fine. Wasteful,
            // never wrong — so it is a log line, not a refusal.
            log($"[couch-coop] cache stamp write failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// Refresh the stamp's <c>lastUsedUtcTicks</c> so the cap's LRU ordering stays honest.
    /// </summary>
    /// <remarks>
    /// Deliberately carries NO slot: this is the fast path, where no branch was resolved. Passing null preserves
    /// whatever labels the directory already holds rather than blanking them — the stamp keeps its record of the
    /// last start that did know.
    /// </remarks>
    private static void TouchLastUsed(string versionRoot, CacheIdentityStamp stamp, Action<string> log)
    {
        var existing = TryReadStamp(versionRoot);
        WriteStamp(
            versionRoot,
            existing is null
                ? stamp
                : stamp with
                {
                    Branch = existing.Branch,
                    BranchSource = existing.BranchSource,
                    SteamBuildId = existing.SteamBuildId,
                },
            slot: null,
            log);
    }

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
/// EVERYTHING THAT MAKES CACHED BYTES VALID OR STALE — and nothing else.
/// </summary>
/// <remarks>
/// <para>
/// Four facts, and what they have in common is the point: every one is something the INSTALL states about
/// itself (<c>release_info.json</c>) or something this repository decides. None of them needs Steam, a library
/// layout, or a client that may or may not be running — so the ordinary start can compare all four and be done.
/// </para>
/// <para>
/// WHAT IS DELIBERATELY NOT HERE: the branch, how it was learned, and the Steam build id. Those are labels for
/// a build, not statements about its content, and each needs an answer from outside the install. They live on
/// <see cref="CouchCoopCacheSlot"/>, are recorded in the stamp for diagnostics, and are compared by nothing.
/// The Steam build id is the one real loss — it would catch an asset-only Steam rebuild that kept both the
/// version string and the assembly hash — and it is not worth an appmanifest parse on every single start.
/// </para>
/// </remarks>
public sealed record CouchCoopCacheContent(
    string GameVersion,
    int MainAssemblyHash,
    int CacheVersion,
    int AssetPayloadVersion)
{
    /// <summary>Read this install's own declaration, and pair it with our two cache generations.</summary>
    public static CouchCoopCacheContent Resolve()
    {
        var (version, mainAssemblyHash) = Sts2GameBuildIdentity.ResolveContent();
        return new CouchCoopCacheContent(
            version,
            mainAssemblyHash,
            CouchCoopCacheRoot.CacheVersion,
            SpirectlSts2Runtime.AssetPayloadVersion);
    }
}

/// <summary>
/// WHICH BRANCH THIS INSTALL IS — the label, used for one job only: naming a row in the branch → version map.
/// </summary>
/// <remarks>
/// <para>
/// Resolving this is the expensive, circumstantial half of the identity: a Steamworks reflection probe that
/// needs a running Steam client, then a walk to the install manifest. It is therefore resolved LAZILY, only
/// when <see cref="CouchCoopCacheRoot.ResolveOnce"/> has to write the map — i.e. when this install has moved to
/// a version it has no directory for.
/// </para>
/// <para>
/// A wrong answer here cannot serve wrong bytes. The worst it does is release the wrong row of the map, which
/// leaves a directory for the cap to reclaim.
/// </para>
/// </remarks>
public sealed record CouchCoopCacheSlot(string Branch, string BranchSource, int SteamBuildId)
{
    /// <summary>
    /// The branch from spirectl's ladder, falling back to the spirectl API LANE when nothing could identify one
    /// — a copied install launched outside a Steam library.
    /// </summary>
    /// <remarks>
    /// The lane is a good fallback KEY specifically because of what it is: a compile-time property of the bridge
    /// (<c>GameApi/V107</c>, <c>GameApi/V111</c>), so it is coarse and does not move with a patch. A key that
    /// changed every time the game did would never match the row it wrote last time, and the map would grow a
    /// dead entry per update instead of releasing the directory it names.
    /// </remarks>
    public static CouchCoopCacheSlot Resolve()
    {
        var build = Sts2GameBuildIdentity.Resolve();
        var branch = build.HasBranch ? build.Branch : BridgeBuildInfo.Sts2ApiLane;
        var source = build.HasBranch ? build.BranchSource : (branch.Length > 0 ? "api-lane" : "unknown");
        return new CouchCoopCacheSlot(branch, source, build.BuildId);
    }
}

/// <summary>
/// The on-disk stamp: what a version directory says it was written for.
/// </summary>
/// <remarks>
/// <para>
/// Only the four <see cref="CouchCoopCacheContent"/> fields take part in the staleness comparison. The rest is
/// RECORDED FOR A READER — <see cref="SteamBuildId"/>, <see cref="Branch"/> and <see cref="BranchSource"/> tell
/// whoever opens this file which install last wrote here and how it was identified, and
/// <see cref="LastUsedUtcTicks"/> is what orders the cap's LRU.
/// </para>
/// <para>
/// The labels are written only by a start that actually resolved them, so a run of fast-path starts leaves the
/// last known answer in place rather than blanking it. That is also why they cannot be compared: they would be
/// present or absent depending on which path a start happened to take.
/// </para>
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
    public static CacheIdentityStamp For(CouchCoopCacheContent content) => new(
        content.CacheVersion,
        content.AssetPayloadVersion,
        content.GameVersion,
        content.MainAssemblyHash,
        SteamBuildId: 0,
        Branch: string.Empty,
        BranchSource: string.Empty,
        LastUsedUtcTicks: 0);

    public bool Matches(CacheIdentityStamp other) =>
        CacheVersion == other.CacheVersion
        && AssetPayloadVersion == other.AssetPayloadVersion
        && MainAssemblyHash == other.MainAssemblyHash
        && string.Equals(GameVersion, other.GameVersion, StringComparison.Ordinal);

    /// <summary>Which field moved, for the one log line a purge emits.</summary>
    /// <remarks>
    /// Only the compared fields can appear here. <see cref="SteamBuildId"/>, <see cref="Branch"/> and
    /// <see cref="BranchSource"/> are recorded for whoever reads this file by hand and take no part in the
    /// decision, so "no difference" is a real answer when only they moved.
    /// </remarks>
    public string DescribeDifference(CacheIdentityStamp other)
    {
        if (CacheVersion != other.CacheVersion) return $"cacheVersion {CacheVersion}→{other.CacheVersion}";
        if (AssetPayloadVersion != other.AssetPayloadVersion) return $"assetPayloadVersion {AssetPayloadVersion}→{other.AssetPayloadVersion}";
        if (!string.Equals(GameVersion, other.GameVersion, StringComparison.Ordinal)) return $"gameVersion {Show(GameVersion)}→{Show(other.GameVersion)}";
        if (MainAssemblyHash != other.MainAssemblyHash) return $"mainAssemblyHash {MainAssemblyHash}→{other.MainAssemblyHash}";
        return "no difference";
    }

    private static string Show(string value) => value.Length == 0 ? "(none)" : value;
}
