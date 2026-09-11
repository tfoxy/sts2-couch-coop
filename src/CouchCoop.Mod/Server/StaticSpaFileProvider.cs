namespace CouchCoop.Mod.Server;

public sealed class StaticSpaFileProvider(string staticRoot)
{
    // The locally-built Android client APK, deployed by scripts/build-android-apk.sh --deploy into
    // <modDir>/apk/ — a SIBLING of the SPA's frontend/ dir, NOT inside it: the frontend deploy (vite)
    // wipes its outDir on every build and would delete an APK stored there. Presence of the file IS the
    // opt-in to serve it (no config flag); served by a dedicated streaming route, NOT this provider
    // (a 97MB APK must not ride the read-whole-file-into-memory path below).
    public const string AndroidApkFileName = "couchcoop-client.apk";

    private readonly string _staticRoot = Path.GetFullPath(staticRoot);
    private readonly string _resolvedStaticRoot = ResolveExistingPath(Path.GetFullPath(staticRoot));

    public string? TryResolveAndroidApkPath()
    {
        var candidate = Path.GetFullPath(Path.Combine(_staticRoot, "..", "apk", AndroidApkFileName));
        return File.Exists(candidate) ? candidate : null;
    }

    public async Task<StaticSpaFile?> TryOpenAsync(string path, CancellationToken cancellationToken = default)
    {
        if (IsReserved(path))
        {
            return null;
        }

        var relativePath = path == "/" ? "index.html" : path.TrimStart('/');
        var candidate = Path.GetFullPath(Path.Combine(_staticRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        if (!IsLexicallyUnderRoot(candidate))
        {
            return null;
        }

        if (!File.Exists(candidate))
        {
            // Everything under /icons/ is cache-FIRST in the service worker (frontend/public/sw.js), so an
            // index.html served at 200 under an icon URL is not a harmless miss — it is HTML pinned in every
            // installed PWA's cache as that app's art. A miss here 404s instead, which the SW leaves alone.
            if (IsNoFallbackPath(path))
            {
                return null;
            }

            candidate = Path.Combine(_staticRoot, "index.html");
        }

        var resolvedCandidate = TryResolveContainedFile(candidate);
        if (resolvedCandidate is null)
        {
            return null;
        }

        var bytes = await File.ReadAllBytesAsync(resolvedCandidate, cancellationToken).ConfigureAwait(false);
        return new StaticSpaFile(bytes, ContentTypeFor(resolvedCandidate));
    }

    /// <summary>
    /// Read one static file by its EXACT path — no reserved-route filter and, critically, no
    /// <c>index.html</c> fallback: a miss returns null instead of 200-with-HTML.
    /// </summary>
    /// <remarks>
    /// Exists for the app-icon routes, which are reserved (so the SPA fallback cannot shadow the
    /// game-rendered art on a miss) but still need to serve the shipped PNG in <c>frontend/public/icons/</c>
    /// when the asset seam cannot render — a headless seat answers <c>asset-extraction-unavailable</c>, and
    /// a manifest icon that 404s is worse than a placeholder. Serving <c>index.html</c> under a
    /// <c>.png</c> URL would be worse still: the browser would cache HTML as the home-screen icon.
    /// </remarks>
    public async Task<StaticSpaFile?> TryReadExactAsync(string path, CancellationToken cancellationToken = default)
    {
        var relativePath = (path ?? string.Empty).TrimStart('/');
        if (relativePath.Length == 0)
        {
            return null;
        }

        var candidate = Path.GetFullPath(Path.Combine(_staticRoot, relativePath.Replace('/', Path.DirectorySeparatorChar)));
        var resolvedCandidate = TryResolveContainedFile(candidate);
        if (resolvedCandidate is null)
        {
            return null;
        }

        var bytes = await File.ReadAllBytesAsync(resolvedCandidate, cancellationToken).ConfigureAwait(false);
        return new StaticSpaFile(bytes, ContentTypeFor(resolvedCandidate));
    }

    /// <summary>
    /// Paths that are served from disk if present but must NEVER answer with the SPA shell on a miss.
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="IsReserved"/>: a reserved path is owned by another route entirely, whereas
    /// these are ordinary static files whose only special property is that HTML is a dangerous thing to
    /// return under them.
    /// </remarks>
    internal static bool IsNoFallbackPath(string path)
        => path.StartsWith(CouchCoopAppIcons.RoutePrefix, StringComparison.Ordinal)
           // An asset-shaped miss is never a client-side route. Returning index.html at a missing image/font/blob
           // URL poisons browser caches with HTML and hides the real missing-resource failure.
           || Path.HasExtension(path)
           || path.Contains(':')
           // The boot manifest the public-origin bootstrap reads to learn which app bundle THIS host
           // wants (vite.config.ts `couchCoopBootManifest`). A 200 of index.html here would hand the
           // bootstrap HTML to JSON.parse — an unreadable crash instead of the honest signal a 404
           // gives, which is "this host predates the web-link option; use the LAN address".
           || string.Equals(path, BootManifestPath, StringComparison.Ordinal);

    /// <summary>The URL the public-origin bootstrap fetches for the boot manifest.</summary>
    public const string BootManifestPath = "/app-boot.json";

    /// <summary>
    /// The boot manifest's filename ON DISK, relative to the static root. Deliberately NOT a <c>*.json</c>:
    /// the build's outDir is the installed mod's <c>frontend/</c> dir and STS2's <c>ModManager</c> treats
    /// every non-dot-dir <c>*.json</c> under a mod as a candidate manifest, logging an <c>[ERROR]</c> for
    /// each one that lacks an <c>id</c>. The <see cref="BootManifestPath"/> route re-emits this file, so the
    /// URL is unaffected. Kept in step with <c>vite.config.ts</c> <c>couchCoopBootManifest</c>.
    /// </summary>
    internal const string BootManifestDiskName = "/app-boot";

    public static bool IsReserved(string path)
        => string.Equals(path, "/ws", StringComparison.Ordinal)
           || string.Equals(path, "/favicon.ico", StringComparison.Ordinal)
           // The app icons are served from the GAME's icon by a dedicated route (CouchCoopAppIcons). Reserved
           // so a miss can never fall through to index.html — a manifest icon that resolves to HTML at 200 is
           // an icon the phone caches and renders as nothing. The route's own fallback reads the shipped PNG
           // through TryReadExactAsync, which is why reserving them costs nothing.
           || CouchCoopAppIcons.IsIconRoute(path)
           || string.Equals(path, "/res", StringComparison.Ordinal)
           || path.StartsWith("/models/", StringComparison.Ordinal)
           || path.StartsWith("/res/", StringComparison.Ordinal);

    private static string ContentTypeFor(string path)
        => Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".webmanifest" => "application/manifest+json; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".ico" => "image/x-icon",
            ".woff2" => "font/woff2",
            _ => "application/octet-stream"
        };

    private string? TryResolveContainedFile(string candidate)
    {
        var relative = Path.GetRelativePath(_staticRoot, Path.GetFullPath(candidate));
        if (!IsLexicallyUnderRoot(candidate))
        {
            return null;
        }

        var candidateUnderResolvedRoot = Path.GetFullPath(Path.Combine(_resolvedStaticRoot, relative));
        if (!File.Exists(candidateUnderResolvedRoot))
        {
            return null;
        }

        try
        {
            var resolved = ResolveExistingPath(candidateUnderResolvedRoot);
            return IsUnderResolvedRoot(_resolvedStaticRoot, resolved) ? resolved : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private bool IsLexicallyUnderRoot(string candidate)
    {
        var relative = Path.GetRelativePath(_staticRoot, Path.GetFullPath(candidate));
        return !Path.IsPathRooted(relative)
            && relative != ".."
            && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    internal static bool IsUnderResolvedRoot(string root, string candidate)
    {
        var suffix = Path.DirectorySeparatorChar.ToString();
        var normalizedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + suffix;
        var normalizedCandidate = candidate.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return normalizedCandidate.StartsWith(normalizedRoot,
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    }

    internal static string ResolveExistingPath(string path) => ResolvedFilePath.Resolve(path);

}

public sealed record StaticSpaFile(byte[] Bytes, string ContentType);
