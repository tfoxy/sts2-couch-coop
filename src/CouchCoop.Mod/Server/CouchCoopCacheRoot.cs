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
/// patch and grow without bound". The cap is the answer: at most two directories survive, and the one thrown
/// away is the LOWEST VERSION. Two is what the axis a player moves along actually needs — the branch they are
/// on and the one they switch to — and "lowest version" needs no bookkeeping, no timestamps and no branch.
/// </para>
/// <code>
///   &lt;base&gt;/&lt;version&gt;/.cache-identity.json  the stamp; its CONTENT fields must match
///   &lt;base&gt;/&lt;version&gt;/assets/               SpirectlAssetBinaryCache
///   &lt;base&gt;/&lt;version&gt;/geoclips/             CouchCoopGeoclipStore
///   &lt;base&gt;/&lt;version&gt;/astc/ + pending/      AstcTranscodeCache
///   &lt;base&gt;/&lt;version&gt;/.cache-budget/        ManagedCacheQuota, per version
///   &lt;base&gt;/.trash/&lt;guid&gt;/                   renamed-aside trees, deleted in the background
/// </code>
/// <para>
/// NOTHING HERE EVER ASKS FOR THE STEAM BRANCH. It decides nothing: the version already separates the builds,
/// and a directory is retired by comparing version numbers. A start whose directory is present and stamped
/// writes nothing at all. See <see cref="ResolveOnce"/>.
/// </para>
/// <para>
/// AN INSTALL THAT WILL NOT STATE ITS VERSION GETS NO CACHE. Everything here is keyed on the version, so a blank
/// one would put every build in one directory whose stamp also matches every build — one build serving another's
/// pixels for the right key. Refusing costs a slower session and cannot be silent.
/// </para>
/// <para>
/// THE RENAME IS THE GUARANTEE, not the delete. A stale tree is moved aside before anything reads or writes it —
/// one directory rename, whatever the tree weighs — and the multi-gigabyte recursive delete happens on a
/// background thread afterwards. Deleting in place would either block the Godot main thread at startup for
/// seconds or leave a window in which the old bytes are still servable.
/// </para>
/// <para>
/// RESOLVED ONCE PER PROCESS, at the top of mod init, before anything can touch the disk. It needs no runtime,
/// no game state and no Steam — just the install on disk — which is exactly why it can run that early.
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

    internal const string TrashFolderName = ".trash";

    private static readonly JsonSerializerOptions StampJson = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private static readonly Lazy<Resolution> Current = new(
        ResolveOrDisable,
        LazyThreadSafetyMode.ExecutionAndPublication);

    /// <summary>
    /// The lazy's factory, and the one place in this file that catches EVERYTHING.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A CACHE FAILURE MUST NEVER BE ABLE TO ABORT MOD INIT. There is no exception for which "the mod does not
    /// start" is a better outcome than "this session renders everything itself", and the blast radius of a throw
    /// here is much larger than one failed start: the lazy is
    /// <see cref="LazyThreadSafetyMode.ExecutionAndPublication"/>, which CACHES THE EXCEPTION, so every later
    /// read of <see cref="VersionRoot"/>, <see cref="Content"/> and <see cref="Quota"/> rethrows it for the life
    /// of the process. <see cref="Warm"/> is called at the top of mod init with nothing above it but the
    /// loader's blanket catch, so the visible result is one log line and then a mod that does nothing at all.
    /// </para>
    /// <para>
    /// The two inputs are guarded here rather than inside <see cref="ResolveOnce"/> because they are outside
    /// it: <see cref="DefaultBaseRoot"/> reads the environment and the game's data dir, and
    /// <see cref="CouchCoopCacheContent.Resolve"/> touches the embedded spirectl assembly (whose static
    /// initialiser can fail as a <c>TypeInitializationException</c> when the two halves of a deploy disagree).
    /// <see cref="ResolveOnce"/> is total in its own right; this covers getting as far as calling it.
    /// </para>
    /// <para>
    /// The narrow <see cref="IsIoFailure"/> predicate below stays narrow. Each of its uses answers a specific
    /// question about one operation ("could that file be read?"), where an unexpected type is worth seeing.
    /// This is the BOUNDARY, and a boundary's job is to be total — the same shape
    /// <c>CouchCoopAtlasManifest.Warm</c> already uses for the same reason.
    /// </para>
    /// </remarks>
    private static Resolution ResolveOrDisable()
    {
        try
        {
            return ResolveOnce(DefaultBaseRoot(), CouchCoopCacheContent.Resolve(), DefaultLog);
        }
        catch (Exception exception)
        {
            DefaultLog($"[couch-coop] cache disabled: {exception.GetType().Name}: {exception.Message}");
            return new Resolution(null, CouchCoopCacheContent.Unknown, null);
        }
    }

    /// <summary>
    /// Force resolution (and, if the stamp has moved, the purge) now, and report what happened.
    /// </summary>
    /// <remarks>
    /// Called at the very top of mod init. Everything else reaches this lazily, so forgetting the call costs
    /// correctness nothing — it only moves the work to whichever request happens to need the cache first.
    /// <para>Never throws: see <see cref="ResolveOrDisable"/>. The call site in <c>CouchCoopMod.Init</c> guards
    /// it anyway, because the one failure this cannot catch is this class failing to initialise at all.</para>
    /// </remarks>
    public static void Warm() => _ = Current.Value;

    /// <summary>The version directory in use, or null when no cache root could be resolved at all.</summary>
    public static string? VersionRoot => Current.Value.VersionRoot;

    /// <summary>
    /// What this install says about its own content. Never null; may be entirely unknown (in which case no
    /// cache was resolved at all).
    /// </summary>
    public static CouchCoopCacheContent Content => Current.Value.Content;

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
        ManagedCacheQuota? Quota);

    /// <summary>
    /// The whole policy, as a pure-ish function of a base root and what the install says about itself, so tests
    /// drive it without a game.
    /// </summary>
    internal static Resolution ResolveOnce(
        string? baseRoot,
        CouchCoopCacheContent content,
        Action<string> log,
        bool sweepLegacy = true)
    {
        if (string.IsNullOrWhiteSpace(baseRoot))
        {
            log("[couch-coop] cache disabled: no writable cache root could be resolved");
            return new Resolution(null, content, null);
        }

        // AN INSTALL THAT WILL NOT SAY WHAT IT IS GETS NO CACHE. Everything here is keyed on the version, so a
        // blank one would put every build in one directory whose stamp also matches every build — which is not a
        // miss, it is one build serving another's pixels for the right key. Refusing costs a slower session;
        // the alternative is a rendering bug with no cause anywhere near the rendering code.
        // Covers both halves: a version the install never stated, and one that cannot become a safe single path
        // segment. Neither yields a name, and there is deliberately no fallback bucket to put them in.
        if (DirectoryNameFor(content.GameVersion) is not { } versionName)
        {
            log("[couch-coop] cache disabled: this install reported no usable game version "
                + $"({Show(content.GameVersion)}) — is release_info.json readable?");
            return new Resolution(null, content, null);
        }

        var versionRoot = Path.Combine(baseRoot, versionName);
        var trashRoot = Path.Combine(baseRoot, TrashFolderName);
        var stamp = CacheIdentityStamp.For(content);

        // EVERYTHING FROM HERE IS INSIDE ONE GUARD, and the two constructions at its edges are why. Both the
        // gate below and the quota at the end build a NAMED MUTEX, which on Unix is backed by files the runtime
        // keeps under $TMPDIR — a per-user directory that is periodically purged on macOS. Neither call is
        // reading this cache; both can fail, and a named-mutex failure is not necessarily an IOException. While
        // they sat outside the guard, a throw from either escaped into the lazy that caches it forever and took
        // the whole mod's init with it — for a cache, which is an optimisation.
        try
        {
            // Cross-process: the host and every headless seat come up together after a game update and would
            // otherwise each try to move the same tree aside. Same named-mutex shape ManagedCacheQuota uses.
            using var gate = new CacheGate(baseRoot);
            var held = gate.Enter();
            try
            {
                var existing = TryReadStamp(versionRoot);
                if (existing is null || !existing.Matches(stamp))
                {
                    if (Directory.Exists(versionRoot))
                    {
                        var reason = existing is null ? "no readable stamp" : existing.DescribeDifference(stamp);
                        if (!TryMoveAside(versionRoot, trashRoot, log))
                        {
                            // Refusing the cache entirely is the only safe answer left: the tree that is there
                            // was written for something else, and serving from it is the one forbidden outcome.
                            log($"[couch-coop] cache disabled: stale cache at {versionRoot} could not be moved aside ({reason})");
                            return new Resolution(null, content, null);
                        }
                        log($"[couch-coop] cache purged version={versionName} reason={reason}");
                    }

                    WriteStamp(versionRoot, stamp, log);
                }

                DeleteTheRetiredVersionMap(baseRoot);

                // EVERY start, not just one that created a directory. Enforcing the cap costs a directory
                // listing and some string compares — it reads no stamps — and running it unconditionally is
                // what drains a machine that arrived with more than two (the branch-named directories the old
                // layout left, which a cap of two cannot clear in a single pass). In the steady state it finds
                // nothing to do, so a start whose directory is already stamped still writes nothing.
                EvictBeyondCap(baseRoot, versionRoot, trashRoot, log);
            }
            finally
            {
                if (held)
                {
                    gate.Release();
                }
            }

            // BEFORE the success line, and inside the guard. A version root without a quota is not a weaker
            // cache, it is a broken one: the geoclip store dereferences CouchCoopCacheRoot.Quota unconditionally
            // once it has a root, so "root, no quota" is a null deref waiting for the first bake. The pair is
            // resolved together or not at all — which also keeps the log honest, since a failure here must not
            // follow a line that already announced the root.
            var quota = ManagedCacheQuota.ForCacheRoot(versionRoot);

            log($"[couch-coop] cache game={content.GameVersion} hash={content.MainAssemblyHash} "
                + $"cache=v{content.CacheVersion}+sp{content.AssetPayloadVersion} root={versionRoot}");

            StartBackgroundSweep(trashRoot, sweepLegacy ? LegacyRootsFor(baseRoot) : []);
            return new Resolution(versionRoot, content, quota);
        }
        catch (Exception exception)
        {
            // TOTAL, for the reason ResolveOrDisable documents: the answer to every failure in here is the same
            // one — no cache, said out loud — and there is none for which throwing at the caller is better.
            log($"[couch-coop] cache disabled: {exception.GetType().Name}: {exception.Message}");
            return new Resolution(null, content, null);
        }
    }

    private static string Show(string value) => string.IsNullOrWhiteSpace(value) ? "(none)" : value;

    /// <summary>
    /// REMOVE THIS METHOD AND ITS ONE CALL SITE ON OR AFTER 2026-11-14.
    /// </summary>
    /// <remarks>
    /// v0.2.0 shipped a <c>.cache-versions.json</c> recording which version each Steam branch was on, so a
    /// directory could be released the moment its branch moved. Retiring the lowest version needs no such
    /// bookkeeping, so the file is now meaningless — and a meaningless file sitting beside the caches is a
    /// question somebody will eventually have to answer. Deleting the method and its call is the whole removal.
    /// </remarks>
    private static void DeleteTheRetiredVersionMap(string baseRoot)
    {
        try
        {
            var path = Path.Combine(baseRoot, ".cache-versions.json");
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            // A leftover file we could not delete costs nothing but the confusion it was meant to save.
        }
    }

    /// <summary>
    /// The version directories under <paramref name="baseRoot"/> — everything that is not dot-prefixed.
    /// </summary>
    /// <remarks>
    /// Dot-prefixed is the rule rather than a list of known names, so anything added beside them later is
    /// excluded by being named that way rather than by being remembered here.
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
    internal static string? DirectoryNameFor(string version)
    {
        if (string.IsNullOrWhiteSpace(version))
        {
            return null;
        }

        var builder = new StringBuilder(version.Length);
        foreach (var c in version.Trim())
        {
            builder.Append(char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.' ? c : '_');
        }

        var name = builder.ToString();
        return name.Length == 0 || name.StartsWith('.') || name.All(c => c == '.') ? null : name;
    }

    /// <summary>
    /// Order two version directory names lowest-first: <c>v0.107.1</c> &lt; <c>v0.111.0</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Numeric per component, because the obvious alternative is wrong in a way that only shows up later:
    /// compared as text <c>v0.9.0</c> sorts ABOVE <c>v0.10.0</c>, and the cache would start retiring the newer
    /// build. Leading <c>v</c> is ignored; a missing component reads as 0, so <c>v0.107</c> and <c>v0.107.0</c>
    /// are the same version.
    /// </para>
    /// <para>
    /// A name that is not a version at all sorts LOWEST, so it is retired first. That is what clears out the
    /// branch-named directories (<c>public/</c>, <c>public-beta/</c>) left by the layout this replaced.
    /// </para>
    /// </remarks>
    internal static int CompareVersionNames(string left, string right)
    {
        var a = VersionComponents(left);
        var b = VersionComponents(right);

        // Neither parses: fall back to ordinal so the order is at least deterministic.
        if (a is null && b is null) return string.CompareOrdinal(left, right);
        if (a is null) return -1;
        if (b is null) return 1;

        for (var i = 0; i < Math.Max(a.Count, b.Count); i++)
        {
            var difference = (i < a.Count ? a[i] : 0).CompareTo(i < b.Count ? b[i] : 0);
            if (difference != 0)
            {
                return difference;
            }
        }

        return 0;
    }

    /// <summary>Whether <paramref name="name"/> is a version this resolver could ever have minted.</summary>
    internal static bool IsVersionName(string name) => VersionComponents(name) is not null;

    /// <summary>The dot-separated integers in a version name, or null when it is not one.</summary>
    private static List<int>? VersionComponents(string name)
    {
        var trimmed = name.StartsWith('v') || name.StartsWith('V') ? name[1..] : name;
        if (trimmed.Length == 0)
        {
            return null;
        }

        var components = new List<int>();
        foreach (var part in trimmed.Split('.'))
        {
            if (!int.TryParse(part, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var value))
            {
                return null;
            }
            components.Add(value);
        }

        return components;
    }

    // ---- the directory cap -----------------------------------------------------------------------------

    /// <summary>
    /// How many version directories survive. Two is the axis a player moves along: the branch they are on and
    /// the one they switch to.
    /// </summary>
    internal const int MaxVersionDirectories = 2;

    /// <summary>
    /// Keep at most <see cref="MaxVersionDirectories"/> directories, retiring the LOWEST VERSION first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// THE WHOLE GARBAGE-COLLECTION POLICY, and it needs nothing but the directory names — no map, no
    /// timestamps, no branch. The lowest version is the one a player is least likely to go back to, and an
    /// older build that is genuinely still in use simply rebuilds its cache when it is next started.
    /// </para>
    /// <para>
    /// The version in use is never a candidate however it sorts — evicting it would delete the cache the very
    /// next line is about to fill.
    /// </para>
    /// </remarks>
    private static void EvictBeyondCap(string baseRoot, string versionRoot, string trashRoot, Action<string> log)
    {
        if (!Directory.Exists(baseRoot))
        {
            return;
        }

        var others = VersionDirectories(baseRoot)
            .Where(path => !PathsEqual(path, versionRoot))
            .ToList();

        // A name that is not a version cannot be resolved to by anything, ever — nothing computes it. So it is
        // not a cache that happens to be old, it is garbage, and it must not occupy one of the two slots. This
        // is what clears the branch-named directories (`public/`, `public-beta/`) the previous layout left.
        foreach (var path in others.Where(path => !IsVersionName(Path.GetFileName(path))).ToList())
        {
            if (TryMoveAside(path, trashRoot, log))
            {
                log($"[couch-coop] cache reclaimed unreachable directory={Path.GetFileName(path)}");
            }
            others.Remove(path);
        }

        foreach (var path in others
            .OrderByDescending(path => Path.GetFileName(path), Comparer<string>.Create(CompareVersionNames))
            .Skip(MaxVersionDirectories - 1))
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

    private static void WriteStamp(string versionRoot, CacheIdentityStamp stamp, Action<string> log)
    {
        try
        {
            Directory.CreateDirectory(versionRoot);
            var path = Path.Combine(versionRoot, IdentityFileName);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(
                temporary,
                JsonSerializer.Serialize(stamp with { StampedUtcTicks = DateTime.UtcNow.Ticks }, StampJson));
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            // A stamp we cannot write means the next start re-purges a cache that was actually fine. Wasteful,
            // never wrong — so it is a log line, not a refusal.
            log($"[couch-coop] cache stamp write failed: {exception.GetType().Name}: {exception.Message}");
        }
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
            // We DID acquire it; the previous owner died holding it. Held, so it must be released.
            catch (AbandonedMutexException) { return true; }
            // Anything else means the wait did not succeed, so nothing is held. Since proceeding ungated is
            // already a supported outcome (the timeout above returns false), a wait that cannot even be
            // attempted degrades to it rather than costing the session its whole cache.
            catch (Exception) { return false; }
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
/// WHAT IS DELIBERATELY NOT HERE: the Steam branch and build id. Neither is a statement about the build's
/// CONTENT, both need an answer from outside the install, and the version already separates the builds — so
/// nothing in the cache ever asks for them. The build id is the one real loss (it would catch an asset-only
/// Steam rebuild that kept both the version string and the assembly hash) and it is not worth making every
/// start depend on Steam.
/// </para>
/// </remarks>
public sealed record CouchCoopCacheContent(
    string GameVersion,
    int MainAssemblyHash,
    int CacheVersion,
    int AssetPayloadVersion)
{
    /// <summary>
    /// What an install that could not be asked at all says about itself: nothing.
    /// </summary>
    /// <remarks>
    /// The value <see cref="Resolve"/> could not produce, for the caller that has to answer anyway. Deliberately
    /// spelled with literals rather than by reaching for <c>SpirectlSts2Runtime.AssetPayloadVersion</c>: this
    /// exists for the case where reading that assembly is what failed, so touching it here would throw again.
    /// An empty version is refused by the resolver, so this can never become a cache directory.
    /// </remarks>
    public static readonly CouchCoopCacheContent Unknown = new(
        GameVersion: string.Empty,
        MainAssemblyHash: 0,
        CacheVersion: CouchCoopCacheRoot.CacheVersion,
        AssetPayloadVersion: 0);

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
/// The on-disk stamp: what a version directory says it was written for.
/// </summary>
/// <remarks>
/// The four <see cref="CouchCoopCacheContent"/> fields are the comparison; <see cref="StampedUtcTicks"/> is for
/// whoever opens the file by hand. Written ONCE, when the directory is created — a start that finds its
/// directory already stamped writes nothing at all.
/// </remarks>
internal sealed record CacheIdentityStamp(
    int CacheVersion,
    int AssetPayloadVersion,
    string GameVersion,
    int MainAssemblyHash,
    long StampedUtcTicks)
{
    public static CacheIdentityStamp For(CouchCoopCacheContent content) => new(
        content.CacheVersion,
        content.AssetPayloadVersion,
        content.GameVersion,
        content.MainAssemblyHash,
        StampedUtcTicks: 0);

    public bool Matches(CacheIdentityStamp other) =>
        CacheVersion == other.CacheVersion
        && AssetPayloadVersion == other.AssetPayloadVersion
        && MainAssemblyHash == other.MainAssemblyHash
        && string.Equals(GameVersion, other.GameVersion, StringComparison.Ordinal);

    /// <summary>Which field moved, for the one log line a purge emits.</summary>
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
