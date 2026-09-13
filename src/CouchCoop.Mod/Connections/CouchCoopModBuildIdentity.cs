using System.Reflection;

namespace CouchCoop.Mod.Connections;

/// <summary>
/// WHICH COPY OF COUCHCOOP THIS PROCESS IS RUNNING — the build string, the file it was loaded from, and
/// where in the install that file lives.
/// </summary>
/// <remarks>
/// <para>
/// One definition, because three callers need the same answer and a second spelling would let them
/// disagree: the connection report's <c>modVersion</c> fact, the value a host hands each seat it spawns
/// (<c>COUCHCOOP_HOST_MOD_BUILD</c>), and the seat-side guard that compares the two.
/// </para>
/// <para>
/// The build string is the assembly's INFORMATIONAL version, which is
/// <c>&lt;assembly version&gt;+&lt;source commit&gt;</c> for both a release publish and an ordinary local
/// build — so two processes running the same commit agree exactly, and two processes running different
/// commits differ. It is not a version comparison: any difference at all is a mismatch, because the
/// browser wire contract moves between commits with no version bump of its own.
/// </para>
/// </remarks>
internal static class CouchCoopModBuildIdentity
{
    /// <summary>
    /// The host's own build, handed to every seat it spawns. Absent means "a host that predates this
    /// check, or a process nobody spawned as a seat" — never a mismatch.
    /// </summary>
    internal const string HostBuildEnvironmentVariable = "COUCHCOOP_HOST_MOD_BUILD";

    /// <summary>The mod row source an install's <c>mods/</c> directory produces.</summary>
    internal const string LocalModSource = "mods_directory";

    /// <summary>The mod row source a Steam Workshop subscription produces.</summary>
    internal const string WorkshopModSource = "steam_workshop";

    private static readonly Assembly Self = typeof(CouchCoopModBuildIdentity).Assembly;

    /// <summary>This process's CouchCoop build, or <c>"unknown"</c>.</summary>
    public static string Current { get; } = BuildOf(Self);

    /// <summary>The file this process's CouchCoop was loaded from, or <c>"unknown"</c>.</summary>
    public static string AssemblyPath { get; } = PathOf(Self);

    /// <summary>
    /// Which mod-list row source <see cref="AssemblyPath"/> belongs to, or <see langword="null"/> when it
    /// cannot be told.
    /// </summary>
    public static string? ModSource { get; } = ModSourceOf(AssemblyPath);

    internal static string BuildOf(Assembly assembly)
    {
        try
        {
            return assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                is { Length: > 0 } informational
                ? informational
                : "unknown";
        }
        catch
        {
            return "unknown";
        }
    }

    internal static string PathOf(Assembly assembly)
    {
        try
        {
            return string.IsNullOrEmpty(assembly.Location) ? "unknown" : assembly.Location;
        }
        catch
        {
            // A single-file / in-memory load has no Location and can throw rather than return empty.
            return "unknown";
        }
    }

    /// <summary>
    /// Classify a loaded-from path as the Workshop copy or the install's local copy, by PATH SHAPE.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two locations, two shapes. Steam installs a subscribed item under
    /// <c>…/workshop/content/&lt;appid&gt;/&lt;itemid&gt;/</c> — a Steam-wide layout, not a game detail —
    /// and the game reads its own local mods from a <c>mods</c> directory beside the executable.
    /// </para>
    /// <para>
    /// Shape rather than "is it under &lt;install&gt;/mods" on purpose: the install root reached through
    /// <c>/proc/self/exe</c> is the SYMLINK-RESOLVED path, which is a different string from the one the
    /// mod was loaded through whenever the install (or the binary inside it) is a symlink — and that is
    /// how the private game-root farm is built. Comparing shapes has no such failure mode.
    /// </para>
    /// <para>
    /// Segment equality, never a string prefix: <c>mods_STEAMTEST</c> starts with <c>mods</c> but is a
    /// different directory that the game reads as a Workshop source. An unrecognised shape returns
    /// <see langword="null"/> and every caller treats that as "do not act", which is the only safe
    /// default for a signal that decides which copy of the mod a process loads.
    /// </para>
    /// </remarks>
    internal static string? ModSourceOf(string? assemblyPath)
    {
        if (string.IsNullOrWhiteSpace(assemblyPath)) return null;
        var segments = assemblyPath.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries);
        for (var i = 0; i + 1 < segments.Length; i++)
        {
            if (string.Equals(segments[i], "workshop", StringComparison.OrdinalIgnoreCase)
                && string.Equals(segments[i + 1], "content", StringComparison.OrdinalIgnoreCase))
            {
                return WorkshopModSource;
            }
        }

        return segments.Any(segment => string.Equals(segment, "mods", StringComparison.OrdinalIgnoreCase))
            ? LocalModSource
            : null;
    }
}
