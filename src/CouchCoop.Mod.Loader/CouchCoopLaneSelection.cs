using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;

[assembly: InternalsVisibleTo("CouchCoop.Mod.Tests")]

namespace CouchCoop.Mod.Loader;

/// <summary>
/// WHICH BUILD OF COUCHCOOP THIS GAME GETS, decided at load time from one payload that carries several.
/// </summary>
/// <remarks>
/// <para>
/// CouchCoop is compiled per game build: a handful of the game members it binds to were renamed between
/// v0.107.1 and v0.111.0, so <c>CouchCoop.Mod.dll</c> and <c>CouchCoop.Spirectl.dll</c> exist once per lane.
/// Shipping those as two branch-linked Workshop revisions does not work — the Steam client resolves a
/// branch link only on the subscribe/first-acquire path, and every later periodic refresh takes the item's
/// NEWEST revision branch-blind — so a stable subscriber silently drifts onto the beta payload and the game
/// refuses it ("declares min game version … higher than current game version"). One payload carrying both
/// lanes, choosing at runtime, is the shape that survives that refresh.
/// </para>
/// <para>
/// THE DIRECTORY NAMES ARE THE LANE TABLE. <c>lanes/0.107.1/</c>, <c>lanes/0.111.0/</c> — each named by the
/// FLOOR game version it was compiled for, bare <c>M.m.p</c>. There is deliberately no manifest file beside
/// them: the game scans every <c>*.json</c> under a mod directory, recursively and unbounded, as a candidate
/// mod manifest, so a second one would register a phantom mod (see <c>godot-log-hygiene</c> in project
/// memory). A directory listing costs nothing and cannot be mistaken for a manifest.
/// </para>
/// <para>
/// NO <c>lanes/</c> DIRECTORY IS NOT AN ERROR. A dev deploy (<c>scripts/build-local-mod.sh</c>) writes a flat
/// tree with the implementation assemblies beside the loader, and that must keep working untouched — so an
/// absent <c>lanes/</c> means "flat", silently. A <c>lanes/</c> directory that cannot answer, by contrast, is
/// a broken payload and refuses loudly: running the wrong lane is a crash deep inside a game callback with
/// nothing pointing back here.
/// </para>
/// <para>
/// Godot-free, Steam-free and dependency-free on purpose, for two reasons. It runs BEFORE any lane assembly
/// is loaded, so it cannot call the equivalent ladder in <c>Spirectl.Sts2.Live.Sts2GameBuildIdentity</c> —
/// that type lives in <c>CouchCoop.Spirectl.dll</c>, which is itself one of the two lane-varying assemblies.
/// And staying off the game's API surface keeps the loader lane-neutral: it binds exactly two game types
/// (<c>[ModInitializer]</c> and <c>Log</c>), which is what lets ONE <c>couchcoop.dll</c> load under both
/// builds.
/// </para>
/// </remarks>
internal static class CouchCoopLaneSelection
{
    /// <summary>The per-lane implementation directory, relative to the mod root.</summary>
    internal const string LanesDirectoryName = "lanes";

    internal const string ReleaseInfoFileName = "release_info.json";

    /// <summary>
    /// How far up from a starting directory to look for <c>release_info.json</c>, counting the starting
    /// directory itself.
    /// </summary>
    /// <remarks>
    /// Bounded rather than fixed-depth, matching <c>Sts2GameBuildIdentity.TryWalkToInstallRoot</c>, so a
    /// differently nested deployment still resolves and a pathological symlink loop still terminates. The
    /// number is set by the deepest real start: a mod inside a macOS <c>.app</c> sits at
    /// <c>&lt;app&gt;.app/Contents/MacOS/mods/&lt;mod&gt;/</c>, four steps below the bundle's
    /// <c>Contents/</c>, and the game's mod scan is recursive — so a payload may nest itself further under
    /// <c>mods/</c> and must still resolve.
    /// </remarks>
    internal const int InstallRootWalkDepth = 8;

    /// <summary>The macOS application-bundle directories this walk has to know about.</summary>
    private const string BundleSuffix = ".app";
    private const string BundleContentsDirectoryName = "Contents";
    private const string BundleResourcesDirectoryName = "Resources";

    /// <summary>
    /// The outcome of a lane decision: at most one of <paramref name="LaneDirectory"/> (use it) and
    /// <paramref name="Refusal"/> (do not load at all) is set; both null means the flat dev layout.
    /// </summary>
    /// <param name="LaneDirectory">
    /// The chosen <c>lanes/&lt;floor&gt;</c> directory, or <see langword="null"/> for the flat root.
    /// </param>
    /// <param name="DetectedVersion">The raw <c>version</c> string read from the install, if any.</param>
    /// <param name="Refusal">A player-readable reason not to load, or <see langword="null"/>.</param>
    internal sealed record LaneSelection(string? LaneDirectory, string? DetectedVersion, string? Refusal);

    /// <summary>A three-component game version, compared numerically per component.</summary>
    /// <remarks>
    /// Never compared as text: "0.111.0" sorts BELOW "0.9.0" ordinally, which would pick the wrong lane on
    /// the very first two-digit minor the game shipped.
    /// </remarks>
    internal readonly record struct LaneVersion(int Major, int Minor, int Patch)
        : IComparable<LaneVersion>
    {
        public int CompareTo(LaneVersion other)
        {
            var major = Major.CompareTo(other.Major);
            if (major != 0)
            {
                return major;
            }

            var minor = Minor.CompareTo(other.Minor);
            return minor != 0 ? minor : Patch.CompareTo(other.Patch);
        }

        public override string ToString() =>
            string.Create(CultureInfo.InvariantCulture, $"{Major}.{Minor}.{Patch}");
    }

    /// <summary>
    /// Parse a game or lane version tolerantly: an optional <c>v</c>/<c>V</c> prefix, then exactly three
    /// numeric components, then anything after the first <c>-</c> or <c>+</c> discarded.
    /// </summary>
    /// <remarks>
    /// The game writes its own version WITH the prefix ("v0.107.1" on this box's stable install), while the
    /// lane directories are bare ("0.107.1") so they read as plain version folders. Both must parse, and the
    /// prerelease/build suffixes are accepted because a future game build carrying one must still land in the
    /// lane its numeric version selects rather than refusing over punctuation.
    /// <para>
    /// The prefix is only stripped when a DIGIT follows it, so a directory called "vnext" stays unparseable
    /// rather than becoming a version with a missing major.
    /// </para>
    /// </remarks>
    internal static bool TryParseVersion(string? text, out LaneVersion version)
    {
        version = default;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var span = text.AsSpan().Trim();
        if (span.Length > 1 && (span[0] == 'v' || span[0] == 'V') && char.IsAsciiDigit(span[1]))
        {
            span = span[1..];
        }

        var prerelease = span.IndexOf('-');
        if (prerelease >= 0)
        {
            span = span[..prerelease];
        }

        var build = span.IndexOf('+');
        if (build >= 0)
        {
            span = span[..build];
        }

        Span<int> components = stackalloc int[3];
        var count = 0;
        foreach (var range in SplitOnDots(span))
        {
            if (count == 3)
            {
                return false; // four or more components — not the shape the lane table uses
            }

            // NumberStyles.None on purpose: no sign, no whitespace, no thousands separators, so "+1",
            // " 1" and "1,000" are all rejected rather than silently becoming a component.
            if (!int.TryParse(span[range], NumberStyles.None, CultureInfo.InvariantCulture, out var value))
            {
                return false;
            }

            components[count++] = value;
        }

        if (count != 3)
        {
            return false;
        }

        version = new LaneVersion(components[0], components[1], components[2]);
        return true;
    }

    private static List<Range> SplitOnDots(ReadOnlySpan<char> span)
    {
        var ranges = new List<Range>(3);
        var start = 0;
        for (var index = 0; index < span.Length; index++)
        {
            if (span[index] != '.')
            {
                continue;
            }

            ranges.Add(new Range(start, index));
            start = index + 1;
            if (ranges.Count > 3)
            {
                return ranges; // the caller rejects on count anyway; stop growing
            }
        }

        ranges.Add(new Range(start, span.Length));
        return ranges;
    }

    /// <summary>
    /// Choose the implementation directory for <paramref name="detectedVersion"/> under
    /// <paramref name="modDirectory"/>.
    /// </summary>
    /// <remarks>
    /// NEAREST-LOWER-OR-EQUAL, not exact match: a game build newer than every lane in the payload still gets
    /// the highest lane that was compiled for an older build, which is what keeps a shipped mod alive across
    /// a game patch that changed nothing it binds to. The opposite direction is refused outright — a lane
    /// compiled against a NEWER game binds members the running build does not have, which surfaces as a
    /// MissingMethodException from inside a game callback with nothing naming CouchCoop.
    /// </remarks>
    internal static LaneSelection Select(string modDirectory, string? detectedVersion)
    {
        var lanesDirectory = Path.Combine(modDirectory, LanesDirectoryName);
        string[] laneDirectories;
        try
        {
            if (!Directory.Exists(lanesDirectory))
            {
                // The flat dev layout. Silent by design — this is the path every `build-local-mod.sh`
                // deploy takes, and it predates lanes entirely.
                return new LaneSelection(null, detectedVersion, null);
            }

            laneDirectories = Directory.GetDirectories(lanesDirectory);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            return new LaneSelection(
                null,
                detectedVersion,
                $"CouchCoop could not read its lane directory '{lanesDirectory}': {exception.Message}");
        }

        // Every directory name, parseable or not — this list is the diagnostic, and a payload whose lane
        // folder is misnamed ("0.111" say) is exactly the case where naming only the parseable ones would
        // print "(none)" and hide the reason.
        var present = new List<string>(laneDirectories.Length);
        foreach (var directory in laneDirectories)
        {
            var name = LeafName(directory);
            if (!string.IsNullOrEmpty(name))
            {
                present.Add(name);
            }
        }

        present.Sort(StringComparer.Ordinal);
        var presentText = present.Count == 0 ? "(none)" : string.Join(", ", present);

        if (!TryParseVersion(detectedVersion, out var running))
        {
            // Deliberately NOT a fall-back to the newest lane. "I could not tell which game this is" and
            // "this is the newest game" are different facts, and guessing the second from the first is how
            // a stable install ends up running beta code — the exact failure this whole mechanism exists
            // to stop.
            var detail = string.IsNullOrWhiteSpace(detectedVersion)
                ? $"its '{ReleaseInfoFileName}' was not found or carried no version"
                : $"'{detectedVersion}' is not a M.m.p version";
            return new LaneSelection(
                null,
                detectedVersion,
                $"CouchCoop cannot tell which build of Slay the Spire 2 this is ({detail}), so it will not "
                + $"choose one of its implementation lanes ({presentText}). The mod is not loaded.");
        }

        string? best = null;
        var bestVersion = default(LaneVersion);
        foreach (var directory in laneDirectories)
        {
            // Not a lane — a README folder, a stray copy, anything. Ignored, never fatal.
            if (!TryParseVersion(LeafName(directory), out var laneVersion))
            {
                continue;
            }

            if (laneVersion.CompareTo(running) > 0)
            {
                continue; // compiled against a newer game than the one running
            }

            if (best is null || laneVersion.CompareTo(bestVersion) > 0)
            {
                best = directory;
                bestVersion = laneVersion;
            }
        }

        if (best is null)
        {
            return new LaneSelection(
                null,
                detectedVersion,
                $"CouchCoop has no implementation lane for Slay the Spire 2 {detectedVersion} "
                + $"(lanes present: {presentText}). This copy of the mod is built for a newer game build; "
                + "update the game, or install the release that supports it. The mod is not loaded.");
        }

        return new LaneSelection(best, detectedVersion, null);
    }

    /// <summary>
    /// The first <c>&lt;directory&gt;/&lt;simpleName&gt;.dll</c> that exists across
    /// <paramref name="probeDirectories"/>, in order, or <see langword="null"/>.
    /// </summary>
    /// <remarks>
    /// The chosen lane comes FIRST and the mod root second, so the lane's <c>CouchCoop.Mod.dll</c> wins while
    /// the lane-invariant assemblies beside the loader (<c>CouchCoop.Mod.Contracts.dll</c>,
    /// <c>CouchCoop.MirrorProtocol.dll</c>, the third-party dlls) resolve exactly as they did before lanes
    /// existed — one copy of each, shared by both lanes.
    /// </remarks>
    internal static string? FindAssembly(IReadOnlyList<string> probeDirectories, string? simpleName)
    {
        if (string.IsNullOrWhiteSpace(simpleName))
        {
            return null;
        }

        foreach (var directory in probeDirectories)
        {
            try
            {
                var candidate = Path.Combine(directory, $"{simpleName}.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch (Exception exception) when (IsIoFailure(exception))
            {
                // A malformed probe directory is skipped, not fatal — the next one may still answer.
            }
        }

        return null;
    }

    /// <summary>
    /// A copy of a lane-owned assembly sitting at the mod root, which the chosen lane now shadows.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Reported, never fatal, and the direction matters. Extracting a new release over an existing
    /// installation is the ordinary manual upgrade path, and the archive before lanes existed put these
    /// assemblies at the mod root — so an upgrader ends up with stale root copies beside a fresh
    /// <c>lanes/</c> tree. Probing the lane first already resolves that correctly, and refusing on the
    /// ambiguity would break every one of those upgrades to fix nothing.
    /// </para>
    /// <para>
    /// The opposite arrangement is the one that costs time: a dev deploy writes flat assemblies at the
    /// root, so a <c>lanes/</c> tree left behind by an earlier release install shadows the build you just
    /// compiled and the game runs the OLD code with no symptom. That is fixed where it is caused —
    /// <c>scripts/build-local-mod.sh</c> removes <c>lanes/</c> before it deploys — and this line is what
    /// names it if some other path reintroduces it.
    /// </para>
    /// </remarks>
    internal static string? DescribeIgnoredRootCopy(
        string modDirectory,
        string? laneDirectory,
        string simpleName)
    {
        if (laneDirectory is null)
        {
            return null;
        }

        try
        {
            var rootCopy = Path.Combine(modDirectory, $"{simpleName}.dll");
            if (!File.Exists(rootCopy) || !File.Exists(Path.Combine(laneDirectory, $"{simpleName}.dll")))
            {
                return null;
            }

            return $"CouchCoop is using '{simpleName}' from the lane '{laneDirectory}' and IGNORING the copy "
                + $"at '{rootCopy}'. That root copy is left over from an older layout — harmless after "
                + "extracting a new release over an old one, but if you just built a dev deploy it means "
                + "the lane is shadowing it and the game is running the older code.";
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            return null;
        }
    }

    /// <summary>
    /// An already-loaded assembly that is a DIFFERENT FILE from the one this payload would have loaded.
    /// </summary>
    /// <param name="Message">What to log, naming both paths.</param>
    /// <param name="Fatal">
    /// Whether to refuse rather than use the loaded copy. True only for assemblies CouchCoop OWNS; see
    /// <see cref="DescribeLoadedCopyConflict"/>.
    /// </param>
    internal sealed record LoadedCopyConflict(string Message, bool Fatal);

    /// <summary>
    /// The assembly-name prefix this payload owns — the loader itself and every assembly it ships that is
    /// built from this repo.
    /// </summary>
    internal const string OwnedAssemblyPrefix = "couchcoop";

    /// <summary>
    /// Whether an already-loaded assembly named <paramref name="simpleName"/> is a DIFFERENT FILE from the
    /// one this payload would load, and what to do about it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The loader's resolve hook hands back an already-loaded assembly of a matching simple name, which is
    /// right and necessary — it is what stops two copies of the shared protocol types existing in one
    /// process. But "matching simple name" silently accepts a FOREIGN copy: two installed copies of CouchCoop
    /// (a local deploy and a Workshop subscription) can both be present, and with lanes there is a third
    /// shape — the other lane's assembly, whose types line up well enough to load and then bind game members
    /// this build does not have.
    /// </para>
    /// <para>
    /// So the comparison is by PATH, and only when this payload actually ships a copy of that name
    /// (<paramref name="candidatePath"/> non-null). A name we do not ship is somebody else's to answer for.
    /// An already-loaded assembly with no location (dynamic, or loaded from bytes) cannot be compared, and is
    /// accepted rather than refused: a false refusal here takes the mod down on a machine where nothing is
    /// wrong.
    /// </para>
    /// <para>
    /// FATAL ONLY FOR OUR OWN ASSEMBLIES, and that narrowing is load-bearing. The payload also carries
    /// third-party dlls, and at least one of them — <c>System.Diagnostics.DiagnosticSource.dll</c> — ships in
    /// the game's own assembly directory too (MEASURED, on both v0.107.1 and v0.111.0). For a name like that,
    /// binding to the copy already in the process is the CLR's ordinary unification behaviour and is what
    /// worked before lanes existed; turning it into a refusal would invent a new way for the mod to die on a
    /// machine where nothing is wrong. It is still worth SAYING, because it is the shape a genuinely
    /// incompatible bundled dependency would take — hence a message with <c>Fatal: false</c> rather than
    /// silence.
    /// </para>
    /// </remarks>
    internal static LoadedCopyConflict? DescribeLoadedCopyConflict(
        string? simpleName,
        string? loadedLocation,
        string? candidatePath)
    {
        if (candidatePath is null || string.IsNullOrWhiteSpace(loadedLocation))
        {
            return null;
        }

        string loadedFull;
        string candidateFull;
        try
        {
            loadedFull = Path.GetFullPath(loadedLocation);
            candidateFull = Path.GetFullPath(candidatePath);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            return null;
        }

        if (string.Equals(loadedFull, candidateFull, PathComparison))
        {
            return null;
        }

        // `couchcoop` (the loader) and `CouchCoop.*` (everything built from this repo, including the private
        // CouchCoop.Spirectl rename). Ordinal-ignore-case so the rule does not depend on how a name was cased.
        var owned = simpleName is not null
            && simpleName.StartsWith(OwnedAssemblyPrefix, StringComparison.OrdinalIgnoreCase);

        return owned
            ? new LoadedCopyConflict(
                $"CouchCoop refuses to run a foreign copy of '{simpleName}': this process already loaded it "
                + $"from '{loadedFull}', but this payload would load '{candidateFull}'. Two copies of "
                + "CouchCoop are installed, or a seat was started against a different install. Remove one.",
                Fatal: true)
            : new LoadedCopyConflict(
                $"CouchCoop bundles '{simpleName}' at '{candidateFull}', but this process already loaded it "
                + $"from '{loadedFull}'; using the copy that is already loaded. Report this if CouchCoop then "
                + "misbehaves.",
                Fatal: false);
    }

    /// <summary>
    /// The game version this mod is running under, read from the install's <c>release_info.json</c>.
    /// </summary>
    /// <remarks>
    /// TWO STARTING POINTS, walked upward in order — the same ladder as
    /// <c>Sts2GameBuildIdentity.TryResolveInstallRoot()</c>, reproduced rather than called because that type
    /// ships inside one of the lane-varying assemblies this decision is made BEFORE loading.
    /// <para>
    /// 1. THE LOADER'S OWN DIRECTORY. A mod deployed into the install lives at
    /// <c>&lt;install&gt;/mods/&lt;mod&gt;/</c>, so the file is two levels up. Preferred over the executable
    /// because Godot resolves its executable through <c>/proc/self/exe</c>, which follows symlinks: a
    /// symlinked game binary reports the install it points AT rather than the one it was launched from.
    /// </para>
    /// <para>
    /// 2. THE PROCESS EXECUTABLE'S DIRECTORY. This rung is what makes a WORKSHOP install work at all. A
    /// subscribed item lives at <c>steamapps/workshop/content/&lt;appid&gt;/&lt;item&gt;/</c>, a sibling
    /// branch of the tree that is never an ancestor of the game, so rung 1 can only walk item → appid →
    /// content → workshop → steamapps and give up. That is the shape every real player has — which makes
    /// this rung, not the first, the one the shipped payload depends on.
    /// </para>
    /// </remarks>
    internal static string? ResolveGameVersion()
        => ReadInstallVersion(
            TryWalkToInstallRoot(DirectoryOf(SafeAssemblyLocation()))
            ?? TryWalkToInstallRoot(DirectoryOf(SafeProcessPath())));

    /// <summary>Walk up from <paramref name="startDirectory"/> looking for <c>release_info.json</c>.</summary>
    /// <remarks>
    /// NOT PURELY UPWARD, because inside a macOS bundle the file is not above either starting point — see
    /// <see cref="BundleResourceDirectory"/>. This walk carries more weight than spirectl's copy of it: a
    /// version it cannot read is not a slow session, it is a REFUSAL to load any lane at all.
    /// </remarks>
    internal static string? TryWalkToInstallRoot(string? startDirectory)
    {
        var directory = startDirectory;
        for (var depth = 0; depth < InstallRootWalkDepth && !string.IsNullOrWhiteSpace(directory); depth++)
        {
            try
            {
                // The directory itself first, at every level: where both shapes exist, the tree we are
                // actually sitting in is the more specific answer.
                if (File.Exists(Path.Combine(directory, ReleaseInfoFileName)))
                {
                    return directory;
                }

                if (BundleResourceDirectory(directory) is { } resources
                    && File.Exists(Path.Combine(resources, ReleaseInfoFileName)))
                {
                    return resources;
                }

                directory = Path.GetDirectoryName(directory);
            }
            catch (Exception exception) when (IsIoFailure(exception))
            {
                return null;
            }
        }

        return null;
    }

    /// <summary>
    /// <c>&lt;name&gt;.app/Contents/Resources</c>, when <paramref name="directory"/> is that bundle's
    /// <c>Contents</c>; otherwise <see langword="null"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY A WALK UPWARD IS NOT ENOUGH ON macOS, and why this is the difference between the mod running and
    /// not running at all. A <c>.app</c> is not a flat install directory: the executable lives in
    /// <c>Contents/MacOS/</c> and the shipped data — <c>release_info.json</c> among it — in
    /// <c>Contents/Resources/</c>. Those are SIBLINGS, so the file is an ancestor of neither starting point:
    /// not of the binary, and not of this loader deployed at <c>Contents/MacOS/mods/&lt;mod&gt;/</c>. No walk
    /// depth reaches a sibling. With no version, <see cref="Select"/> refuses to choose a lane — correctly, it
    /// must never guess — so a SHIPPED payload logs one line and loads nothing, on every Mac.
    /// </para>
    /// <para>
    /// Keyed on the <c>Contents</c> directory rather than on <c>MacOS</c>, so the walk finds the resource
    /// directory whichever sibling it came up through, and gated on the <c>.app</c> suffix so an ordinary
    /// directory named <c>Contents</c> is not mistaken for a bundle. Deliberately not gated on
    /// <see cref="OperatingSystem.IsMacOS"/>: the shape is unambiguous on its own, and an OS gate would make
    /// the one platform this exists for the one platform it cannot be tested on.
    /// </para>
    /// </remarks>
    private static string? BundleResourceDirectory(string directory)
    {
        var trimmed = Path.TrimEndingDirectorySeparator(directory);
        if (!string.Equals(Path.GetFileName(trimmed), BundleContentsDirectoryName, StringComparison.Ordinal))
        {
            return null;
        }

        var bundle = Path.GetFileName(Path.GetDirectoryName(trimmed));
        return !string.IsNullOrEmpty(bundle) && bundle.EndsWith(BundleSuffix, StringComparison.OrdinalIgnoreCase)
            ? Path.Combine(trimmed, BundleResourcesDirectoryName)
            : null;
    }

    /// <summary>
    /// The <c>version</c> property of <paramref name="installRoot"/>'s <c>release_info.json</c>, verbatim.
    /// </summary>
    /// <remarks>
    /// Returned unparsed so the refusal message can quote exactly what the install said — a message naming
    /// "0.107.1" when the file says "v0.107.1" sends the reader looking for the wrong string.
    /// </remarks>
    internal static string? ReadInstallVersion(string? installRoot)
    {
        if (string.IsNullOrWhiteSpace(installRoot))
        {
            return null;
        }

        try
        {
            var path = Path.Combine(installRoot, ReleaseInfoFileName);
            if (!File.Exists(path))
            {
                return null;
            }

            using var document = JsonDocument.Parse(File.ReadAllText(path));
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("version", out var version)
                && version.ValueKind == JsonValueKind.String
                ? version.GetString()
                : null;
        }
        catch (Exception exception) when (IsIoFailure(exception) || exception is JsonException)
        {
            return null;
        }
    }

    /// <summary>The last path segment, tolerant of a trailing separator.</summary>
    /// <remarks>
    /// <c>Path.GetFileName</c> of a path ending in a separator is the empty string, and while
    /// <c>Directory.GetDirectories</c> does not produce one, a hand-built probe path in a test or a future
    /// caller can — and an empty lane name silently matches nothing.
    /// </remarks>
    private static string LeafName(string directory) =>
        Path.GetFileName(directory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));

    private static string? SafeAssemblyLocation()
    {
        try
        {
            return typeof(CouchCoopLaneSelection).Assembly.Location;
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            return null;
        }
    }

    private static string? SafeProcessPath()
    {
        try
        {
            return Environment.ProcessPath;
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            return null;
        }
    }

    private static string? DirectoryOf(string? filePath)
    {
        try
        {
            return string.IsNullOrWhiteSpace(filePath) ? null : Path.GetDirectoryName(filePath);
        }
        catch (Exception exception) when (IsIoFailure(exception))
        {
            return null;
        }
    }

    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static bool IsIoFailure(Exception exception) =>
        exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException;
}
