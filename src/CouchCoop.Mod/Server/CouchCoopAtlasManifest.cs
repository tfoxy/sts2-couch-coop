using Godot;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The atlas PAGES this game build actually ships, enumerated once from <c>res://images/atlases/</c> and published
/// on the <c>session</c> envelope so a client never has to guess which of them exist.
/// </summary>
/// <remarks>
/// <para>
/// WHY THIS EXISTS. The browser's idle atlas prefetch (frontend/src/mirror/imagePrefetch.ts) warms a fixed
/// wish-list of pages during connect/join. That list was a literal array of <c>res://</c> paths compiled into the
/// frontend, so it described the game build the frontend was WRITTEN against rather than the one it is talking to.
/// The game's <c>public-beta</c> branch repacked the card atlas from three pages into two, and every client then
/// asked a host that has no <c>card_atlas_2.png</c> for it — a miss that costs a main-thread
/// <c>ResourceLoader.Load</c> failure on the host, is not negatively cached, and so repeats for every new client
/// (24 such lines in one beta host's <c>godot.log</c>).
/// </para>
/// <para>
/// The page count is not something a client can be told once and for all: it moves with a repack, which is a
/// content decision the game makes per build. So the host answers it, from the install it is actually running.
/// </para>
/// <para>
/// PAGES, NOT SPRITES. Only the <c>.png</c> atlas pages directly in the directory are published. The
/// <c>&lt;atlas&gt;.sprites/</c> subdirectories hold the per-sprite <c>.tres</c> documents that NAME a page; they
/// are fetched on demand by the renderer and are not prefetch candidates, so this never recurses.
/// </para>
/// <para>
/// EXPORTED PROJECTS SHIP THE SIDECAR. In an exported game the source image is not in the PCK at its own path —
/// Godot stores the compiled texture under <c>res://.godot/imported/</c> and ships the <c>.import</c> sidecar
/// beside the original path, which is what <c>ResourceLoader</c> follows. So a directory listing here yields
/// <c>card_atlas_0.png.import</c>, not <c>card_atlas_0.png</c>, and the sidecar suffix is stripped to recover the
/// loadable path. An unexported/dev tree lists both spellings; they dedupe onto one entry.
/// </para>
/// <para>
/// UNKNOWN IS A REAL ANSWER. <see cref="Pages"/> stays null until <see cref="Warm"/> has actually enumerated
/// something — no engine (the Godot-less test harness), an unreadable directory, or a build whose atlases live
/// somewhere else. The field is then omitted from the wire entirely and the client keeps its own compiled-in
/// fallback list, which is exactly the behaviour that shipped before this existed.
/// </para>
/// </remarks>
public static class CouchCoopAtlasManifest
{
    /// <summary>The one directory the game keeps its atlas pages in, trailing slash included.</summary>
    public const string AtlasDirectory = "res://images/atlases/";

    /// <summary>
    /// Suffixes a directory listing can carry on top of the resource path a client would load. Longest first, so
    /// a doubled sidecar cannot strip the shorter half and leave the rest.
    /// </summary>
    private static readonly string[] SidecarSuffixes = [".import", ".remap"];

    private static volatile string[]? _pages;

    /// <summary>
    /// Where this file's one-line result goes, on top of <c>Console.Error</c>.
    /// </summary>
    /// <remarks>
    /// A hook rather than a direct <c>CouchCoopLog</c> call for the reason <see cref="CouchCoopCacheRoot.LogSink"/>
    /// documents and the compiler enforces: <c>Server/*.cs</c> is also link-compiled into
    /// <c>CouchCoop.Mod.HotReload</c>, which cannot see the mod assembly's internals. <c>CouchCoopMod</c> points it
    /// at <c>CouchCoopLog.Info</c>, the only channel that reaches <c>godot.log</c> in the shipped Steam flow.
    /// </remarks>
    public static Action<string>? LogSink { get; set; }

    /// <summary>
    /// The enumerated page paths (<c>res://images/atlases/&lt;name&gt;.png</c>), ordinal-sorted, or null when this
    /// process never managed to enumerate them. Null means "unknown", never "none".
    /// </summary>
    public static IReadOnlyList<string>? Pages => _pages;

    /// <summary>
    /// Enumerate the atlas directory once and cache the result. Called from <c>CouchCoopMod.Init()</c>, on the
    /// Godot main thread, inside a real engine. Idempotent: a second call with a result already cached returns
    /// immediately, so a re-entered Init cannot pay for the walk twice.
    /// </summary>
    /// <remarks>
    /// Gated on the same <c>EngineAvailable</c> latch the static-background tracker uses, and for the same reason:
    /// <see cref="DirAccess"/> is GodotSharp, and a server process that has GodotSharp on its probing path but no
    /// engine running SEGFAULTS in native interop rather than throwing something catchable.
    /// </remarks>
    public static void Warm()
    {
        if (_pages is not null || !CouchCoopStaticBackgroundTracker.EngineAvailable)
        {
            return;
        }

        string[] pages;
        try
        {
            pages = PagesFromEntries(ListDirectory());
        }
        catch (Exception exception)
        {
            // A build with no such directory, or a listing this version of Godot refuses. Leaving the manifest
            // unknown costs the beta its 404s again; it never costs a page that does exist.
            Log($"[couchcoop] atlas manifest unavailable: {exception.Message}");
            return;
        }

        if (pages.Length == 0)
        {
            Log($"[couchcoop] atlas manifest empty under {AtlasDirectory} -- not published");
            return;
        }

        _pages = pages;
        Log($"[couchcoop] atlas manifest: {pages.Length} page(s) under {AtlasDirectory}");
    }

    private static void Log(string message)
    {
        Console.Error.WriteLine(message);
        LogSink?.Invoke(message);
    }

    /// <summary>
    /// The file names directly inside <see cref="AtlasDirectory"/>. Same <c>DirAccess.Open</c> + ListDir walk as
    /// spirectl's <c>Sts2SpineCatalogService</c>, minus the recursion.
    /// </summary>
    private static List<string> ListDirectory()
    {
        var entries = new List<string>();
        using var directory = DirAccess.Open(AtlasDirectory);
        if (directory is null)
        {
            return entries;
        }

        directory.ListDirBegin();
        try
        {
            for (var entry = directory.GetNext(); !string.IsNullOrEmpty(entry); entry = directory.GetNext())
            {
                // The `<atlas>.sprites/` folders are sprite documents, not pages.
                if (directory.CurrentIsDir())
                {
                    continue;
                }

                entries.Add(entry);
            }
        }
        finally
        {
            directory.ListDirEnd();
        }

        return entries;
    }

    /// <summary>
    /// Turn one directory listing into the loadable page paths: strip an import/remap sidecar suffix, keep only
    /// <c>.png</c>, qualify with the directory, dedupe and ordinal-sort.
    /// </summary>
    /// <remarks>
    /// Split out from the walk because it is the whole of the interesting behaviour and the only half that can be
    /// tested — the walk itself needs a live engine, this needs a list of strings.
    /// </remarks>
    internal static string[] PagesFromEntries(IEnumerable<string> entries)
    {
        var pages = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var raw in entries)
        {
            var name = raw?.Trim();
            if (string.IsNullOrEmpty(name) || name is "." or "..")
            {
                continue;
            }

            foreach (var sidecar in SidecarSuffixes)
            {
                if (name.EndsWith(sidecar, StringComparison.OrdinalIgnoreCase))
                {
                    name = name[..^sidecar.Length];
                    break;
                }
            }

            if (!name.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            pages.Add(AtlasDirectory + name);
        }

        return [.. pages];
    }

    /// <summary>TEST-ONLY: pin (or clear, with null) the published manifest without an engine.</summary>
    internal static void SetPagesForTest(IEnumerable<string>? pages)
        => _pages = pages is null ? null : [.. pages];
}
