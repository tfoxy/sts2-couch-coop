namespace CouchCoop.Mod.Server;

/// <summary>
/// The home-screen / favicon art the SPA asks for, and where each size comes from.
/// </summary>
/// <remarks>
/// <para>
/// These used to be three hand-drawn placeholder PNGs checked into <c>frontend/public/icons/</c>. They are
/// now RENDERED from the game's own 1024px app icon, so an installed PWA on a phone shows the same art as
/// the game does in a taskbar. The static files stay exactly where they are — they are the fail-open
/// fallback (see <c>CouchCoopBrowserServer.HandleAppIconRequestAsync</c>), not the product.
/// </para>
/// <para>
/// Pure lookup on purpose: which paths exist, what each one asks the asset seam for, and at what size are
/// the whole decision, and they have to agree with three separate consumers that this class cannot see —
/// <c>frontend/public/manifest.webmanifest</c> (192/512), <c>frontend/index.html</c>'s
/// <c>apple-touch-icon</c> (180) and <c>StaticSpaFileProvider.IsReserved</c>. A test asserts the manifest's
/// declared sizes against this table so a rename cannot drift them apart silently.
/// </para>
/// </remarks>
public static class CouchCoopAppIcons
{
    /// <summary>The game's own app icon, the source every size is resampled from.</summary>
    public const string SourceResourcePath = "res://images/icon_1024.png";

    /// <summary>Route prefix. Mirrored by the service worker's cache-first allowlist (frontend/public/sw.js).</summary>
    public const string RoutePrefix = "/icons/";

    private static readonly CouchCoopAppIcon[] Icons =
    [
        // 180: iOS apple-touch-icon (frontend/index.html). iOS ignores the manifest for this.
        new("/icons/icon-180.png", 180),
        // 192/512: the two manifest entries (frontend/public/manifest.webmanifest).
        new("/icons/icon-192.png", 192),
        new("/icons/icon-512.png", 512),
    ];

    /// <summary>Every icon this host serves from the game's art, in route order.</summary>
    public static IReadOnlyList<CouchCoopAppIcon> All => Icons;

    /// <summary>The icon a request path names, or <see langword="null"/> when it names none of them.</summary>
    public static CouchCoopAppIcon? TryResolve(string? rawPath)
    {
        if (string.IsNullOrEmpty(rawPath))
        {
            return null;
        }

        foreach (var icon in Icons)
        {
            if (string.Equals(rawPath, icon.Path, StringComparison.Ordinal))
            {
                return icon;
            }
        }

        return null;
    }

    /// <summary>True when this path is one of the game-rendered icons (the reserved-route predicate).</summary>
    public static bool IsIconRoute(string? rawPath) => TryResolve(rawPath) is not null;
}

/// <param name="Path">The exact request path, e.g. <c>/icons/icon-192.png</c>.</param>
/// <param name="SizePx">Square edge in pixels; both the render size asked of spirectl and the manifest's claim.</param>
public sealed record CouchCoopAppIcon(string Path, int SizePx)
{
    /// <summary>Where the static fallback copy lives, relative to the SPA static root.</summary>
    public string StaticRelativePath => Path.TrimStart('/');
}
