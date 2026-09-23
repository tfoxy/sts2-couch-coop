using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using CouchCoop.Mod.Connections;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Session;

/// <summary>A mod the running game reports it loaded, as far as the inventory can use one.</summary>
/// <param name="Source">
/// The source as the reporter spells it. <see cref="SeatModInventory.NormalizeSource"/> maps it onto the
/// <c>mod_list</c> spelling; when it cannot, <paramref name="Path"/> is classified instead.
/// </param>
/// <param name="Path">The mod's own directory, which is where its manifest is.</param>
internal sealed record SeatLoadedMod(string Id, string? Source, string? Name, string? Path);

/// <summary>
/// The game's own account of which mods it loaded — an optional sharper input to <see cref="SeatModInventory"/>,
/// never a required one.
/// </summary>
/// <remarks>
/// Nothing supplies one today: the default is <see cref="NoSeatLoadedMods"/>, and the disk path is the whole
/// production path — it finds every manifest on its own. What a live source would add is certainty about WHICH
/// copy's manifest applies when a mod's directory is known outright rather than searched for. Wire one with
/// <see cref="SeatModSelectionService.UseLoadedMods"/>.
/// </remarks>
internal interface ISeatLoadedModSource
{
    IReadOnlyList<SeatLoadedMod> ReadLoadedMods();
}

/// <summary>The default: no live account of loaded mods, so the inventory reads the disk alone.</summary>
internal sealed class NoSeatLoadedMods : ISeatLoadedModSource
{
    internal static NoSeatLoadedMods Instance { get; } = new();

    public IReadOnlyList<SeatLoadedMod> ReadLoadedMods() => [];
}

/// <summary>One mod manifest found on disk: a JSON object with a string <c>id</c>.</summary>
/// <param name="AffectsGameplay">
/// True unless the manifest says <c>"affects_gameplay": false</c> in so many words — and true as well when its
/// dependency list is present but unreadable.
/// </param>
/// <param name="Source">
/// Which <c>mod_list</c> source the manifest's location implies (<see cref="CouchCoopModBuildIdentity.ModSourceOf"/>),
/// or <see langword="null"/> when its path has neither shape.
/// </param>
internal sealed record SeatModManifest(
    string Id,
    string? Name,
    bool AffectsGameplay,
    IReadOnlyList<string> DependencyIds,
    string Path,
    string? Source);

/// <summary>Where the disk half of the inventory looks.</summary>
/// <param name="HostUserDir">The host's game user dir, whose profiles hold the <c>mod_list</c>.</param>
/// <param name="WorkshopContentDirs">
/// This game's Steam Workshop content dirs (<c>…/workshop/content/&lt;appid&gt;</c>), each holding one directory
/// per subscribed item.
/// </param>
/// <param name="LocalModsDirs">The install's local <c>mods</c> dirs, each holding one directory per mod.</param>
internal sealed record SeatModInventoryRoots(
    string? HostUserDir,
    IReadOnlyList<string> WorkshopContentDirs,
    IReadOnlyList<string> LocalModsDirs)
{
    /// <summary>
    /// Why each way of finding a Workshop content dir found none, one entry per way tried. Only meaningful when
    /// <see cref="WorkshopContentDirs"/> is empty — that is when every Workshop mod drops out of the panel.
    /// </summary>
    public IReadOnlyList<string> WorkshopMisses { get; init; } = [];

    /// <summary>Why each place a local <c>mods</c> dir was looked for had none. Meaningful when none was found.</summary>
    public IReadOnlyList<string> LocalMisses { get; init; } = [];
}

/// <summary>
/// The host's mods as seat selection sees them: one descriptor per id for the panel, and the (id, source) rows
/// behind them for the seat-side rewrite.
/// </summary>
internal sealed class SeatModInventorySnapshot
{
    internal static SeatModInventorySnapshot Empty { get; } = new([], []);

    internal SeatModInventorySnapshot(IReadOnlyList<SeatModDescriptor> mods, IReadOnlyList<SeatModRowKey> rows)
    {
        Mods = mods;
        Rows = rows;
    }

    /// <summary>One per id, in the host's <c>mod_list</c> order. Never <c>couchcoop</c>.</summary>
    public IReadOnlyList<SeatModDescriptor> Mods { get; }

    /// <summary>Every enabled row behind <see cref="Mods"/>, in <c>mod_list</c> order.</summary>
    public IReadOnlyList<SeatModRowKey> Rows { get; }

    /// <summary>
    /// Every row of every id in <paramref name="ids"/> — BOTH copies of a mod installed twice, because switching
    /// a mod off for seats means switching off whichever copy the seat would otherwise load.
    /// </summary>
    public IReadOnlyList<SeatModRowKey> RowsFor(IEnumerable<string> ids)
    {
        ArgumentNullException.ThrowIfNull(ids);
        var wanted = new HashSet<string>(ids, SeatModSelectionPlan.IdComparer);
        return [.. Rows.Where(row => wanted.Contains(row.Id))];
    }
}

/// <summary>
/// Which mods this host has, whether each declares itself able to change gameplay, and what each depends on —
/// the input <see cref="SeatModSelectionPlan"/> decides over.
/// </summary>
/// <remarks>
/// <para>
/// THE ROWS come from the host's own <c>mod_list</c>, because that is what the seat-side rewrite keys by: a mod
/// the list does not name is not one a seat can be told to skip. Only rows the host has ENABLED count — a mod
/// the host itself does not run is not the host's to take away from a seat, and is already off in the copy
/// the seat is seeded with. <c>couchcoop</c> is excluded outright: it declares no gameplay effect and has no
/// dependents, so the rule would otherwise offer to switch off the mod that makes a seat a seat. Its rows stay
/// governed by the copy pin alone (<see cref="HeadlessSeatModSelection"/>).
/// </para>
/// <para>
/// THE MANIFESTS are found on disk, under this game's Workshop content dir and the install's local
/// <c>mods</c> dir, by a bounded search: any <c>*.json</c> at most two levels into a mod's directory that is a
/// JSON object with a string <c>id</c>. Two levels because a manifest is not always at an item's root (a
/// Workshop item can hold its mod one directory down), and bounded because a mod directory can hold a great deal
/// of JSON that is not a manifest. The game install and the user dir are not assumed to be anywhere near each
/// other — they can be on different drives — and Workshop content is not assumed to be under the install.
/// </para>
/// <para>
/// FAIL SAFE, in one direction only. A row whose manifest cannot be found or read is recorded as affecting
/// gameplay, so it is never offered. Several manifests for one row, or one mod installed from two sources,
/// collapse to ONE descriptor whose gameplay flag is the OR and whose dependencies are the union — every
/// ambiguity resolves towards "leave it on". What that does not cover: an unknown mod's dependencies are
/// unknown, so a library it needs could still be offered. Switching such a library off leaves the seat without
/// a mod the host runs — which, for a gameplay mod, the game's own mod comparison at join is expected to refuse
/// (see <c>ModManifestGameplayRelevanceTests</c>): a loud failure the host can undo, not a quiet desync. Locking
/// every row behind one unreadable manifest was the alternative, and it would make the panel useless on exactly
/// the machine whose layout this search did not anticipate.
/// </para>
/// <para>
/// PURE CORE, IO EDGE: <see cref="ParseManifest"/> and <see cref="Build"/> take strings and records, so the
/// whole decision is testable from fixture text; <see cref="Read"/> and <see cref="ResolveRoots()"/> are the
/// only members that touch the filesystem.
/// </para>
/// </remarks>
internal static class SeatModInventory
{
    // How deep into one mod's directory a manifest may sit: the directory itself (1) or one directory down (2).
    private const int ManifestSearchDepth = 2;

    // A manifest is a few hundred bytes. The caps keep a mod that ships large or numerous JSON data files from
    // turning an inventory read into a crawl; a manifest they skip leaves its row unknown, which is fail-safe.
    private const long MaxManifestBytes = 64 * 1024;
    private const int MaxJsonFilesPerMod = 256;

    // How far up from the install root (or the executable) to look for the Steam library it sits in. Inside a
    // macOS bundle the install root is `<library>/common/<game>/<name>.app/Contents/Resources`, four levels
    // under `common`.
    private const int LibrarySearchDepth = 8;

    private static readonly JsonDocumentOptions ManifestParseOptions = new()
    {
        // Lenient on purpose: a manifest this reader cannot parse is a row that cannot be offered, and the
        // cost of reading a sloppy one is nothing.
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private static readonly EnumerationOptions OneLevel = new()
    {
        RecurseSubdirectories = false,
        IgnoreInaccessible = true,
        MatchCasing = MatchCasing.CaseInsensitive,
    };

    private static readonly Regex InstallDirPattern = new(
        "\"installdir\"\\s+\"(?<dir>[^\"]*)\"",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    // ---------------------------------------------------------------------------------------------------------
    // Pure core.
    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Read one JSON file as a mod manifest, or <see langword="null"/> when it is not one (not JSON, not an
    /// object, or no string <c>id</c>).
    /// </summary>
    /// <remarks>
    /// A leading byte-order mark is tolerated: real manifests ship with one, and a BOM read as "unreadable" would
    /// — under the fail-safe — lock exactly the mod a host needs to switch off.
    /// </remarks>
    internal static SeatModManifest? ParseManifest(string json, string path)
    {
        ArgumentNullException.ThrowIfNull(json);
        try
        {
            using var document = JsonDocument.Parse(json.TrimStart('\uFEFF'), ManifestParseOptions);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("id", out var idElement)
                || idElement.ValueKind != JsonValueKind.String
                || idElement.GetString() is not { } rawId
                || string.IsNullOrWhiteSpace(rawId))
            {
                return null;
            }

            var id = rawId.Trim();
            var name = root.TryGetProperty("name", out var nameElement)
                && nameElement.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(nameElement.GetString())
                    ? nameElement.GetString()!.Trim()
                    : null;

            // Only an explicit false counts. A missing flag, or one of the wrong type, is not a declaration.
            var affectsGameplay = !(root.TryGetProperty("affects_gameplay", out var flag)
                && flag.ValueKind == JsonValueKind.False);

            var dependencies = new List<string>();
            var dependenciesReadable = true;
            if (root.TryGetProperty("dependencies", out var list) && list.ValueKind != JsonValueKind.Null)
            {
                if (list.ValueKind != JsonValueKind.Array)
                {
                    dependenciesReadable = false;
                }
                else
                {
                    foreach (var entry in list.EnumerateArray())
                    {
                        // Entries are objects with an `id`; a bare string is accepted as the same thing.
                        var dependency = entry.ValueKind switch
                        {
                            JsonValueKind.Object when entry.TryGetProperty("id", out var depId)
                                && depId.ValueKind == JsonValueKind.String => depId.GetString(),
                            JsonValueKind.String => entry.GetString(),
                            _ => null,
                        };
                        if (string.IsNullOrWhiteSpace(dependency))
                        {
                            dependenciesReadable = false;
                            continue;
                        }

                        dependencies.Add(dependency.Trim());
                    }
                }
            }

            // A dependency list that is there but cannot be read is a set of dependencies nobody can vouch for,
            // so the manifest stops vouching for its own harmlessness too.
            return new SeatModManifest(
                id,
                name,
                affectsGameplay || !dependenciesReadable,
                dependencies,
                path,
                CouchCoopModBuildIdentity.ModSourceOf(path));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// The <c>mod_list</c> spelling of a source a live reporter gave as <paramref name="reported"/>, falling back
    /// to classifying <paramref name="path"/> by shape. <see langword="null"/> when neither says.
    /// </summary>
    /// <remarks>
    /// The one place two spellings of the same two sources are reconciled: <c>settings.save</c> writes
    /// <c>mods_directory</c> / <c>steam_workshop</c>, while a live read of the game's loaded mods names the same
    /// values the way the code does (<c>ModsDirectory</c> / <c>SteamWorkshop</c>). Compared with separators
    /// removed and case ignored, so either spelling lands on the same row.
    /// </remarks>
    internal static string? NormalizeSource(string? reported, string? path)
    {
        if (!string.IsNullOrWhiteSpace(reported))
        {
            var squashed = reported.Replace("_", string.Empty, StringComparison.Ordinal)
                .Replace("-", string.Empty, StringComparison.Ordinal)
                .Replace(" ", string.Empty, StringComparison.Ordinal);
            if (string.Equals(squashed, "modsdirectory", StringComparison.OrdinalIgnoreCase))
                return CouchCoopModBuildIdentity.LocalModSource;
            if (string.Equals(squashed, "steamworkshop", StringComparison.OrdinalIgnoreCase))
                return CouchCoopModBuildIdentity.WorkshopModSource;
        }

        return CouchCoopModBuildIdentity.ModSourceOf(path);
    }

    /// <summary>
    /// Rows × manifests → descriptors. <paramref name="loaded"/> may be empty, and is by default.
    /// </summary>
    internal static SeatModInventorySnapshot Build(
        IReadOnlyList<SeatModListRow> hostRows,
        IReadOnlyList<SeatModManifest> manifests,
        IReadOnlyList<SeatLoadedMod> loaded)
    {
        ArgumentNullException.ThrowIfNull(hostRows);
        ArgumentNullException.ThrowIfNull(manifests);
        ArgumentNullException.ThrowIfNull(loaded);

        var enabled = new List<SeatModListRow>();
        var seenRows = new HashSet<SeatModRowKey>();
        foreach (var row in hostRows)
        {
            if (!row.IsEnabled || HeadlessSeatModSelection.IsCouchCoop(row.Id)) continue;
            if (seenRows.Add(row.Key)) enabled.Add(row);
        }

        // Stable, so "the first name found" means the same file on every read.
        var orderedManifests = manifests.OrderBy(m => m.Path, StringComparer.Ordinal).ToList();

        var mods = new List<SeatModDescriptor>();
        var rows = new List<SeatModRowKey>();
        foreach (var group in enabled.GroupBy(row => row.Id, SeatModSelectionPlan.IdComparer))
        {
            var copies = group.ToList();
            var affectsGameplay = false;
            var dependencies = new List<string>();
            var seenDependencies = new HashSet<string>(SeatModSelectionPlan.IdComparer) { group.Key };
            string? manifestName = null;
            string? loadedName = null;
            string? loadedSource = null;

            foreach (var row in copies)
            {
                rows.Add(row.Key);
                var live = LoadedMatch(row, loaded, copies.Count);
                if (live is not null)
                {
                    loadedName ??= string.IsNullOrWhiteSpace(live.Name) ? null : live.Name.Trim();
                    loadedSource ??= row.Source;
                }

                var found = ManifestsFor(row, live, orderedManifests);
                if (found.Count == 0)
                {
                    // FAIL SAFE: a copy nobody can vouch for is a copy that may change gameplay.
                    affectsGameplay = true;
                    continue;
                }

                foreach (var manifest in found)
                {
                    affectsGameplay |= manifest.AffectsGameplay;
                    manifestName ??= manifest.Name;
                    foreach (var dependency in manifest.DependencyIds)
                    {
                        if (seenDependencies.Add(dependency)) dependencies.Add(dependency);
                    }
                }
            }

            var first = copies[0];
            mods.Add(new SeatModDescriptor(
                first.Id,
                // The copy the game says it loaded, when it says; otherwise the list's first.
                loadedSource ?? first.Source,
                loadedName ?? manifestName ?? first.Id,
                affectsGameplay,
                dependencies));
        }

        return new SeatModInventorySnapshot(mods, rows);
    }

    /// <summary>
    /// The mod list to read the host's rows from, out of every profile's: the most recently written one that has
    /// a usable list, ties going to the earlier candidate (steam profiles are offered first).
    /// </summary>
    /// <remarks>
    /// MOST RECENTLY WRITTEN, because the game rewrites the running profile's list from the mods it discovered
    /// every time it starts — so while the host is running, the newest file IS the running profile's, and any
    /// other profile (a second Steam account, the offline <c>default/</c> one) describes a mod set from whenever
    /// that profile last ran. A union across profiles would offer mods the host is not running; picking by
    /// directory kind would pick the offline profile on the day Steam fails to start.
    /// </remarks>
    internal static IReadOnlyList<SeatModListRow>? PickHostRows(
        IEnumerable<(IReadOnlyList<SeatModListRow>? Rows, DateTime WrittenUtc)> profiles)
    {
        IReadOnlyList<SeatModListRow>? best = null;
        var bestWritten = DateTime.MinValue;
        foreach (var (rows, written) in profiles)
        {
            if (rows is null) continue;
            if (best is null || written > bestWritten)
            {
                best = rows;
                bestWritten = written;
            }
        }

        return best;
    }

    /// <summary>
    /// The <c>…/workshop/content/&lt;appid&gt;</c> directory <paramref name="path"/> sits in, by path shape, or
    /// <see langword="null"/>. For CouchCoop's own assembly when it is the Workshop copy, this names the exact
    /// content dir its siblings are subscribed into — the appid included, with nothing to look up.
    /// </summary>
    internal static string? WorkshopContentDirOf(string? path)
    {
        var directory = DirectoryOf(path);
        for (var depth = 0; depth < 16 && !string.IsNullOrEmpty(directory); depth++)
        {
            var parent = Path.GetDirectoryName(directory);
            var grandparent = string.IsNullOrEmpty(parent) ? null : Path.GetDirectoryName(parent);
            if (!string.IsNullOrEmpty(grandparent)
                && NameIs(parent!, "content")
                && NameIs(grandparent, "workshop"))
            {
                return directory;
            }

            directory = parent;
        }

        return null;
    }

    /// <summary>
    /// The local <c>mods</c> directory <paramref name="path"/> sits in, or <see langword="null"/> when the path
    /// is not a local copy's (<see cref="CouchCoopModBuildIdentity.ModSourceOf"/>).
    /// </summary>
    internal static string? LocalModsDirOf(string? path)
    {
        if (CouchCoopModBuildIdentity.ModSourceOf(path) != CouchCoopModBuildIdentity.LocalModSource) return null;
        var directory = DirectoryOf(path);
        for (var depth = 0; depth < 16 && !string.IsNullOrEmpty(directory); depth++)
        {
            if (NameIs(directory, "mods")) return directory;
            directory = Path.GetDirectoryName(directory);
        }

        return null;
    }

    /// <summary>The <c>installdir</c> a Steam app manifest (<c>appmanifest_&lt;appid&gt;.acf</c>) names.</summary>
    internal static string? InstallDirOfAppManifest(string acfText)
    {
        var match = InstallDirPattern.Match(acfText ?? string.Empty);
        return match.Success && match.Groups["dir"].Value.Length > 0 ? match.Groups["dir"].Value : null;
    }

    // ---------------------------------------------------------------------------------------------------------
    // IO edge.
    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Read the inventory from disk. <see langword="null"/> when the host's mod list itself could not be read —
    /// distinct from an empty inventory, so a caller that caches can decline to cache a failure.
    /// </summary>
    internal static SeatModInventorySnapshot? Read(SeatModInventoryRoots roots, ISeatLoadedModSource loadedSource)
    {
        ArgumentNullException.ThrowIfNull(roots);
        ArgumentNullException.ThrowIfNull(loadedSource);
        if (string.IsNullOrWhiteSpace(roots.HostUserDir)) return null;

        var hostRows = ReadHostRows(roots.HostUserDir);
        if (hostRows is null) return null;

        IReadOnlyList<SeatLoadedMod> loaded;
        try
        {
            loaded = loadedSource.ReadLoadedMods() ?? [];
        }
        catch (Exception exception)
        {
            // A live reader is an optional sharpening; one that fails leaves the disk path to do the whole job.
            CouchCoopLog.Stderr($"seat mod inventory: loaded-mod read failed: {exception.GetType().Name}: {exception.Message}");
            loaded = [];
        }

        var manifests = new List<SeatModManifest>();
        var scanned = new HashSet<string>(StringComparer.Ordinal);
        foreach (var mod in loaded)
        {
            if (!string.IsNullOrWhiteSpace(mod.Path)) ScanInto(mod.Path, manifests, scanned);
        }

        foreach (var content in roots.WorkshopContentDirs)
        {
            foreach (var item in ChildDirectories(content)) ScanInto(item, manifests, scanned);
        }

        foreach (var modsDir in roots.LocalModsDirs)
        {
            foreach (var mod in ChildDirectories(modsDir)) ScanInto(mod, manifests, scanned);
        }

        return Build(hostRows, manifests, loaded);
    }

    /// <summary>The host's rows, from the profile <see cref="PickHostRows"/> chooses.</summary>
    internal static IReadOnlyList<SeatModListRow>? ReadHostRows(string hostUserDir)
    {
        var candidates = new List<(IReadOnlyList<SeatModListRow>? Rows, DateTime WrittenUtc)>();
        try
        {
            foreach (var settings in SeatModList.ProfileSettingsFiles(hostUserDir))
            {
                try
                {
                    candidates.Add((SeatModList.ReadRows(File.ReadAllText(settings), out _), File.GetLastWriteTimeUtc(settings)));
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
                {
                    // One unreadable profile is not a reason to ignore the others.
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        return PickHostRows(candidates);
    }

    /// <summary>Every manifest at most <see cref="ManifestSearchDepth"/> levels into <paramref name="modDirectory"/>.</summary>
    /// <remarks>
    /// Directory links ARE followed here, unlike in the seeder's walks: a local mod deployed as a link to a build
    /// directory is still a mod the game loads, and the fixed depth is what rules out an endless descent.
    /// </remarks>
    internal static IReadOnlyList<SeatModManifest> ScanModDirectory(string modDirectory)
    {
        var found = new List<SeatModManifest>();
        var budget = MaxJsonFilesPerMod;
        ScanLevel(modDirectory, 1, found, ref budget);
        return found;
    }

    private static void ScanLevel(string directory, int depth, List<SeatModManifest> found, ref int budget)
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(directory, "*.json", OneLevel))
            {
                if (budget-- <= 0) return;
                try
                {
                    if (new FileInfo(file).Length > MaxManifestBytes) continue;
                    // ReadAllText rather than a byte parse: it strips a UTF-8 byte-order mark, which real
                    // manifests carry and a byte-level JSON parse rejects.
                    if (ParseManifest(File.ReadAllText(file), file) is { } manifest) found.Add(manifest);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                }
            }

            if (depth >= ManifestSearchDepth) return;
            foreach (var child in Directory.EnumerateDirectories(directory, "*", OneLevel))
            {
                ScanLevel(child, depth + 1, found, ref budget);
                if (budget <= 0) return;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
        }
    }

    /// <summary>Where this host's mods are: its user dir, and every mods root the disk search walks.</summary>
    /// <remarks>
    /// Says what it found ONCE per process (<see cref="DescribeRoots"/>), at INFO: a root that cannot be resolved
    /// silently drops every mod under it from the panel, and the one place that shows is a support log. Once,
    /// because the facts it resolves from do not change while the game runs; the inventory is re-read only
    /// after a failed read, and a line per retry would say nothing new.
    /// </remarks>
    internal static SeatModInventoryRoots ResolveRoots()
    {
        var roots = ResolveRoots(
            HeadlessUserDirSeeder.ResolveHostUserDir(),
            CouchCoopModBuildIdentity.AssemblyPath,
            SafeInstallRoot(),
            SafeProcessDirectory());
        if (Interlocked.Exchange(ref _rootsDescribed, 1) == 0)
        {
            var line = DescribeRoots(roots);
            CouchCoopLog.Stderr(line);
            CouchCoopLog.Info(line);
        }

        return roots;
    }

    private static int _rootsDescribed;

    /// <summary>
    /// One line naming every root the inventory resolved, and — for a kind of root it found none of — why each
    /// way of finding one came up empty.
    /// </summary>
    internal static string DescribeRoots(SeatModInventoryRoots roots)
    {
        ArgumentNullException.ThrowIfNull(roots);
        var userDir = string.IsNullOrWhiteSpace(roots.HostUserDir)
            ? "unresolved, so the host's mod list cannot be read and nothing is listed"
            : roots.HostUserDir;
        var workshop = roots.WorkshopContentDirs.Count > 0
            ? $"[{string.Join(", ", roots.WorkshopContentDirs)}]"
            : $"none ({Reasons(roots.WorkshopMisses)}) — Workshop mods cannot be listed";
        var local = roots.LocalModsDirs.Count > 0
            ? $"[{string.Join(", ", roots.LocalModsDirs)}]"
            : $"none ({Reasons(roots.LocalMisses)})";
        return $"seat mod inventory roots: user dir={userDir}; workshop content={workshop}; local mods={local}";

        static string Reasons(IReadOnlyList<string> misses)
            => misses.Count == 0 ? "no reason recorded" : string.Join("; ", misses);
    }

    /// <summary>
    /// The roots, from the four facts that locate them. Each fact is optional and every root found is used, so a
    /// fact that is missing or wrong on one machine costs a root only when nothing else names it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WORKSHOP: first from CouchCoop's own path when it is the Workshop copy — which names the content dir
    /// exactly, appid and all, and is the shape every real player has. Then from the Steam library the install
    /// sits in (<c>&lt;library&gt;/common/&lt;game&gt;</c>), where Workshop content for the game lives at
    /// <c>&lt;library&gt;/workshop/content/&lt;appid&gt;</c>. That second rung is what finds Workshop mods for a
    /// host running a LOCAL CouchCoop (a developer deploy, or a player who installed it by hand) — a Workshop
    /// path is then nowhere in sight.
    /// </para>
    /// <para>
    /// LOCAL: the <c>mods</c> dir CouchCoop's own local copy sits in, and a <c>mods</c> dir beside the install root
    /// and beside the executable (the same place, except inside a macOS bundle and a symlinked install).
    /// </para>
    /// <para>
    /// Each way that finds nothing records why, in <see cref="SeatModInventoryRoots.WorkshopMisses"/> and
    /// <see cref="SeatModInventoryRoots.LocalMisses"/>, for <see cref="DescribeRoots"/>. Recording is all it does:
    /// the roots are the same with or without it.
    /// </para>
    /// </remarks>
    internal static SeatModInventoryRoots ResolveRoots(
        string? hostUserDir,
        string? ownAssemblyPath,
        string? installRoot,
        string? processDirectory)
    {
        var workshop = new List<string>();
        var local = new List<string>();
        var workshopMisses = new List<string>();
        var localMisses = new List<string>();

        var ownWorkshop = WorkshopContentDirOf(ownAssemblyPath);
        if (string.IsNullOrWhiteSpace(ownAssemblyPath))
            workshopMisses.Add("CouchCoop's own path is unknown");
        else if (ownWorkshop is null)
            workshopMisses.Add($"CouchCoop is not the Workshop copy ({ownAssemblyPath})");
        else if (!AddExisting(workshop, ownWorkshop))
            workshopMisses.Add($"{ownWorkshop} does not exist");
        AddExisting(local, LocalModsDirOf(ownAssemblyPath));

        foreach (var (start, fact) in new[] { (installRoot, "the install root"), (processDirectory, "the executable's directory") })
        {
            if (string.IsNullOrWhiteSpace(start))
            {
                workshopMisses.Add($"{fact} is unknown");
                continue;
            }

            if (SteamLibraryOf(start) is { } library)
            {
                var appIds = AppIdCandidates(library.SteamApps, library.InstallDirName, installRoot).ToList();
                var found = false;
                foreach (var appId in appIds)
                {
                    found |= AddExisting(workshop, Path.Combine(library.SteamApps, "workshop", "content", appId));
                }

                if (!found)
                {
                    var contentRoot = Path.Combine(library.SteamApps, "workshop", "content");
                    workshopMisses.Add(
                        $"no Workshop content dir in the Steam library {start} sits in "
                        + $"({contentRoot}{Path.DirectorySeparatorChar}<{string.Join("|", appIds)}> does not exist)");
                }
            }
            else
            {
                workshopMisses.Add(
                    $"{start} is not inside a Steam library (no steamapps{Path.DirectorySeparatorChar}common"
                    + $"{Path.DirectorySeparatorChar}<game> within {LibrarySearchDepth} levels above it)");
            }

            if (!AddExisting(local, Path.Combine(start, "mods")))
                localMisses.Add($"no mods dir in {start}");
        }

        return new SeatModInventoryRoots(hostUserDir, workshop, local)
        {
            // Distinct: the install root and the executable's directory are usually the same place.
            WorkshopMisses = workshopMisses.Distinct(StringComparer.Ordinal).ToList(),
            LocalMisses = localMisses.Distinct(StringComparer.Ordinal).ToList(),
        };
    }

    // The Steam library `start` sits in: the nearest ancestor-or-self whose parent is named `common`. That
    // ancestor is the game's install dir, and the parent's parent is the library's `steamapps`.
    private static (string SteamApps, string InstallDirName)? SteamLibraryOf(string start)
    {
        var directory = Path.TrimEndingDirectorySeparator(start);
        for (var depth = 0; depth < LibrarySearchDepth && !string.IsNullOrEmpty(directory); depth++)
        {
            var parent = Path.GetDirectoryName(directory);
            if (!string.IsNullOrEmpty(parent) && NameIs(parent, "common")
                && Path.GetDirectoryName(parent) is { Length: > 0 } steamApps)
            {
                return (steamApps, Path.GetFileName(directory));
            }

            directory = parent;
        }

        return null;
    }

    /// <summary>
    /// Which app ids to try under a library's Workshop content dir, best first.
    /// </summary>
    /// <remarks>
    /// The install says it in <c>appmanifest_&lt;appid&gt;.acf</c>, the file Steam keeps for every installed
    /// app, whose <c>installdir</c> names the game's directory — present on every Steam install. A
    /// <c>steam_appid.txt</c> in the install is read next, but it is NOT shipped by the game (the <c>sts2</c> CLI
    /// writes it so a directly launched binary can start Steam), so it cannot be the rung a player depends on.
    /// Last, the game's public app id (<see cref="Sts2GameBuildIdentity.SteamAppId"/>), which is only ever the
    /// answer when the library's own records are unreadable. Every candidate must exist on disk to be used.
    /// </remarks>
    private static IEnumerable<string> AppIdCandidates(string steamApps, string installDirName, string? installRoot)
    {
        var ids = new List<string>();
        try
        {
            foreach (var manifest in Directory.EnumerateFiles(steamApps, "appmanifest_*.acf", OneLevel))
            {
                var name = Path.GetFileNameWithoutExtension(manifest);
                var appId = name["appmanifest_".Length..];
                if (appId.Length == 0 || !appId.All(char.IsAsciiDigit)) continue;
                try
                {
                    if (string.Equals(
                            InstallDirOfAppManifest(File.ReadAllText(manifest)),
                            installDirName,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        ids.Add(appId);
                    }
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
        }

        if (!string.IsNullOrWhiteSpace(installRoot))
        {
            try
            {
                var appIdFile = Path.Combine(installRoot, "steam_appid.txt");
                if (File.Exists(appIdFile)
                    && File.ReadAllText(appIdFile).Trim() is { Length: > 0 } text
                    && text.All(char.IsAsciiDigit))
                {
                    ids.Add(text);
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
            {
            }
        }

        ids.Add(Sts2GameBuildIdentity.SteamAppId.ToString(CultureInfo.InvariantCulture));
        return ids.Distinct(StringComparer.Ordinal);
    }

    private static void ScanInto(string modDirectory, List<SeatModManifest> manifests, HashSet<string> scanned)
    {
        string key;
        try
        {
            key = Path.TrimEndingDirectorySeparator(Path.GetFullPath(modDirectory));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return;
        }

        if (!scanned.Add(key)) return;
        manifests.AddRange(ScanModDirectory(key));
    }

    private static IEnumerable<string> ChildDirectories(string directory)
    {
        try
        {
            return Directory.Exists(directory) ? Directory.EnumerateDirectories(directory, "*", OneLevel).ToList() : [];
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return [];
        }
    }

    // Whether `directory` exists — and so is in `into`, added now or already there.
    private static bool AddExisting(List<string> into, string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory)) return false;
        try
        {
            if (!Directory.Exists(directory)) return false;
            var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
            if (!into.Contains(full, StringComparer.Ordinal)) into.Add(full);
            return true;
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or IOException)
        {
            return false;
        }
    }

    private static SeatLoadedMod? LoadedMatch(SeatModListRow row, IReadOnlyList<SeatLoadedMod> loaded, int copies)
    {
        foreach (var mod in loaded)
        {
            if (!SeatModSelectionPlan.IdComparer.Equals(mod.Id, row.Id)) continue;
            var source = NormalizeSource(mod.Source, mod.Path);
            if (string.Equals(source, row.Source, StringComparison.Ordinal)) return mod;
            // A reporter whose source cannot be placed still identifies the mod when there is only one copy.
            if (source is null && copies == 1) return mod;
        }

        return null;
    }

    // Which manifests describe this row: the ones inside the directory the game says it loaded the copy from,
    // when it says; otherwise the ones whose location has the row's source shape; otherwise any whose location
    // has neither shape. A manifest from the OTHER source is never borrowed — two copies of a mod can be two
    // versions, and one version's declaration says nothing about the other's.
    private static List<SeatModManifest> ManifestsFor(
        SeatModListRow row,
        SeatLoadedMod? live,
        IReadOnlyList<SeatModManifest> manifests)
    {
        var byId = manifests.Where(m => SeatModSelectionPlan.IdComparer.Equals(m.Id, row.Id)).ToList();
        if (live?.Path is { Length: > 0 } liveDirectory)
        {
            var inside = byId.Where(m => IsUnder(m.Path, liveDirectory)).ToList();
            if (inside.Count > 0) return inside;
        }

        var sameSource = byId.Where(m => string.Equals(m.Source, row.Source, StringComparison.Ordinal)).ToList();
        return sameSource.Count > 0 ? sameSource : [.. byId.Where(m => m.Source is null)];
    }

    // Case-insensitive, because the platform this matters most on (Windows) compares paths that way, and on the
    // others a false match needs two mod directories differing only in case.
    private static bool IsUnder(string path, string directory)
    {
        var trimmed = directory.TrimEnd('/', '\\');
        return path.Length > trimmed.Length
            && path.StartsWith(trimmed, StringComparison.OrdinalIgnoreCase)
            && path[trimmed.Length] is '/' or '\\';
    }

    private static bool NameIs(string directory, string name)
        => string.Equals(Path.GetFileName(Path.TrimEndingDirectorySeparator(directory)), name, StringComparison.OrdinalIgnoreCase);

    private static string? DirectoryOf(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try
        {
            return Path.GetDirectoryName(path);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static string? SafeInstallRoot()
    {
        try
        {
            return Sts2GameBuildIdentity.TryResolveInstallRoot();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    private static string? SafeProcessDirectory()
    {
        try
        {
            return DirectoryOf(Environment.ProcessPath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }
}
