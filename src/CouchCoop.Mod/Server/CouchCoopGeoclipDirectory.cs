using System.Text;
using System.Text.Json;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Where the DEV-ONLY <c>/geoclips/</c> route reads its bytes from, and the whole of its filesystem policy.
/// </summary>
/// <remarks>
/// <para>
/// A "geoclip" is a baked per-part mesh-geometry artifact for ONE animation of one Spine rig: a
/// <c>manifest.json</c> plus packed sheet images — PNG or WebP, see <see cref="PageExtensions"/> — and a
/// <c>verts.bin</c>. This type is the OPERATOR root and the whole filesystem policy: a static file server over
/// a directory an operator names in <c>COUCHCOOP_GEOCLIPS_DIR</c>, hand-seeded with an out-of-band bake. With
/// the variable unset <see cref="TryResolveRoot"/> answers null and this root contributes nothing.
/// </para>
/// <para>
/// TWO ROOTS, IN ORDER. The route consults this one FIRST and <see cref="CouchCoopGeoclipStore"/> — the managed,
/// host-produced cache — second, so an operator who points <c>COUCHCOOP_GEOCLIPS_DIR</c> at a bake keeps
/// overriding whatever the host baked for itself, exactly as before. The two differ in how they NAME a pose
/// directory (predictable-sanitized here, hashed there) and in what they share (nothing here, atlas pages there),
/// which is why the store has its own resolver; they share the traversal policy through
/// <see cref="TryResolveFileUnder"/> and the whitelist through <see cref="IsAllowedFileName"/>.
/// </para>
/// <para>
/// ADDRESSING. Artifacts are addressed by the SAME canonical <c>spine://…</c> key the <c>/spines/</c> route
/// mints (<see cref="CouchCoopSpineClipProvider.BuildSpineKey"/>) — one identity, one name, whichever route
/// you are looking at. That key is not a legal path segment, so a directory is found in two steps:
/// <see cref="SanitizeKey"/> first (a pure, reproducible mangling an operator can predict), then a
/// <c>map.json</c> in the root (<c>{"&lt;key&gt;": "&lt;dirName&gt;"}</c>) so a directory the baker already
/// named something else can be pointed at WITHOUT renaming it. The map is read per request: this is a dev
/// route, and an operator who drops in a new bake expects it served without restarting the game.
/// </para>
/// <para>
/// TRAVERSAL. Both halves of the address are constrained rather than merely checked for "..": a key is
/// sanitized down to <c>[A-Za-z0-9._-]</c> (so it cannot contain a separator at all), a mapped directory name
/// must be a single such segment, and the file name must match one of the four artifact shapes. The resolved
/// path is then re-verified to live under the root, which is the belt for a root that is itself a symlink.
/// </para>
/// </remarks>
public static class CouchCoopGeoclipDirectory
{
    /// <summary>Names the directory of baked geoclip artifacts. Unset (or blank) ⇒ the route is off.</summary>
    public const string RootEnvVar = "COUCHCOOP_GEOCLIPS_DIR";

    /// <summary>Optional <c>{"&lt;spine key&gt;": "&lt;directory name&gt;"}</c> lookup at the root.</summary>
    public const string MapFileName = "map.json";

    /// <summary>
    /// A sanitized key longer than this is refused outright rather than truncated: truncation would silently
    /// alias two different clips onto one directory, and the operator has <c>map.json</c> for long keys.
    /// </summary>
    private const int MaxSanitizedKeyLength = 240;

    /// <summary>
    /// Cap on a page/sheet name's stem. Longer than the widest name the managed store can mint (a 16-character
    /// content hash) and than any positional index a baker will ever write, and short enough that the whitelist
    /// stays a whitelist.
    /// </summary>
    private const int MaxPageStemLength = 64;

    /// <summary>
    /// Packed sheets are the only CouchCoop-published image artifact. Raw upstream bake pages are staging input,
    /// never a route-visible contract.
    /// </summary>
    private static readonly string[] PagePrefixes = ["sheet-"];

    /// <summary>
    /// The image containers a page/sheet may BE, each with the type it is served as — in the order a lookup that
    /// has to guess should prefer them. ONE table, so the whitelist and the content type cannot drift apart.
    /// </summary>
    /// <remarks>
    /// PNG was the only entry while the baker re-encoded every page out of the runtime texture. It no longer has
    /// to: an exported Godot build ships no source images, but it does ship, per imported texture, a container
    /// whose payload is already a LOSSLESS WebP — byte-identical pixels to the PNG the baker used to write, in
    /// about two thirds of the bytes and none of the encode time (~150 ms for a four-page rig). Those bytes are a
    /// WebP file and the artifact is named for what it is, hence a second extension here rather than a PNG name
    /// carrying WebP bytes.
    /// <para>
    /// A STORE HOLDS A MIX, and must: pages are addressed by the hash of their own bytes, never by their
    /// extension, so every pose baked before that change keeps resolving beside every pose baked after it. Adding
    /// an entry here widens the whitelist and nothing else — the stem rule below is unchanged and applies
    /// identically to every extension.
    /// </para>
    /// </remarks>
    private static readonly (string Extension, string ContentType)[] PageFormats =
    [
        (".png", "image/png"),
        (".webp", "image/webp"),
    ];

    /// <summary>The page/sheet extensions this route will serve, in preference order.</summary>
    public static IReadOnlyList<string> PageExtensions { get; } = [.. PageFormats.Select(format => format.Extension)];

    /// <summary>
    /// The configured artifact root, or null when the route is disarmed — the variable is unset/blank, or names
    /// a directory that does not exist. Both cases are "no geoclips here"; neither is an error worth a 500.
    /// </summary>
    public static string? TryResolveRoot()
    {
        var configured = Environment.GetEnvironmentVariable(RootEnvVar);
        if (string.IsNullOrWhiteSpace(configured))
        {
            return null;
        }

        var root = configured.Trim();
        return Directory.Exists(root) ? Path.GetFullPath(root) : null;
    }

    /// <summary>
    /// The predictable directory name for a canonical spine key: every character outside
    /// <c>[A-Za-z0-9._-]</c> becomes <c>_</c>. Deliberately NOT a hash — an operator listing the root has to be
    /// able to tell which clip a directory holds, and `sed` the same rule to produce one.
    /// </summary>
    public static string SanitizeKey(string key)
    {
        if (string.IsNullOrEmpty(key))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(key.Length);
        foreach (var ch in key)
        {
            builder.Append(char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-' ? ch : '_');
        }

        return builder.ToString();
    }

    /// <summary>
    /// The three artifact shapes this route will serve: the manifest, the packed vertex blob, and packed sheets.
    /// A whitelist, not a filter — anything else in the directory stays private.
    /// </summary>
    public static bool IsAllowedFileName(string? fileName)
    {
        if (string.IsNullOrEmpty(fileName))
        {
            return false;
        }

        if (fileName is "manifest.json" or "verts.bin")
        {
            return true;
        }

        return IsPageFileName(fileName);
    }

    /// <summary>
    /// Whether <paramref name="fileName"/> is a packed sheet artifact the managed store shares across poses,
    /// and the only image family its <c>pages/</c> fallback will resolve.
    /// </summary>
    public static bool IsPageFileName(string? fileName) => PageExtensionOf(fileName) is not null;

    /// <summary>
    /// The container extension <paramref name="fileName"/> is a legal page/sheet artifact IN, or null when it is
    /// not one at all. The whitelist and the "what format is this" question are one lookup deliberately: a caller
    /// that has to name a file by its extension (the managed store, adopting a page) must never be able to accept
    /// a name and then disagree with this method about what its extension was.
    /// </summary>
    /// <remarks>
    /// THE STEM RULE IS THE WHITELIST. The managed store names a packed sheet by the hash of its own bytes
    /// (<see cref="CouchCoopGeoclipStore.PageFileNameFor"/>), so it admits <c>a-f</c> as well as digits. Still a
    /// whitelist, per extension: a bounded run of hex and nothing else — no separators, no dots, no case-mixing
    /// tricks, and the length cap keeps a pathological name from ever reaching the filesystem. In particular a
    /// double extension does NOT slip through, because the leftover dot lands in the stem:
    /// <c>sheet-ab.png.webp</c> has stem <c>ab.png</c>, which is not hex.
    /// </remarks>
    public static string? PageExtensionOf(string? fileName)
    {
        if (string.IsNullOrEmpty(fileName))
        {
            return null;
        }

        foreach (var prefix in PagePrefixes)
        {
            if (!fileName.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            foreach (var (extension, _) in PageFormats)
            {
                if (!fileName.EndsWith(extension, StringComparison.Ordinal))
                {
                    continue;
                }

                // A prefix ends in '-' and an extension starts in '.', so a name matching both is at least as
                // long as the two together and this slice cannot invert.
                var stem = fileName[prefix.Length..^extension.Length];
                if (stem.Length is > 0 and <= MaxPageStemLength && stem.All(char.IsAsciiHexDigit))
                {
                    return extension;
                }
            }
        }

        return null;
    }

    /// <summary>Content type for an allowed artifact file name.</summary>
    public static string ContentTypeFor(string fileName)
    {
        if (fileName.EndsWith(".json", StringComparison.Ordinal))
        {
            return "application/json; charset=utf-8";
        }

        foreach (var (extension, contentType) in PageFormats)
        {
            if (fileName.EndsWith(extension, StringComparison.Ordinal))
            {
                return contentType;
            }
        }

        return "application/octet-stream";
    }

    /// <summary>
    /// The directory holding <paramref name="key"/>'s artifacts, or null when nothing under
    /// <paramref name="root"/> claims that key. Order: the sanitized name first (the convention), then the
    /// <c>map.json</c> indirection (the escape hatch for a directory the baker named itself).
    /// </summary>
    public static string? TryResolveDirectory(string root, string key)
    {
        if (string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(key))
        {
            return null;
        }

        var sanitized = SanitizeKey(key.Trim());
        if (sanitized.Length is > 0 and <= MaxSanitizedKeyLength && IsSafeSegment(sanitized))
        {
            var direct = Path.Combine(root, sanitized);
            if (Directory.Exists(direct) && TryResolveUnder(root, direct) is { } resolvedDirect)
            {
                return resolvedDirect;
            }
        }

        var mapped = TryReadMappedDirectoryName(root, key.Trim());
        if (mapped is null)
        {
            return null;
        }

        var viaMap = Path.Combine(root, mapped);
        return Directory.Exists(viaMap) ? TryResolveUnder(root, viaMap) : null;
    }

    /// <summary>
    /// The full path of one artifact file under the OPERATOR-seeded root, or null when the key, the file name or
    /// the file itself does not resolve. Deliberately unchanged: no shared-pages fallback, so an operator root
    /// resolves exactly the paths it resolved before the managed store existed.
    /// </summary>
    public static string? TryResolveFile(string root, string key, string fileName)
    {
        if (!IsAllowedFileName(fileName))
        {
            return null; // refused by the whitelist BEFORE any path is combined
        }

        var directory = TryResolveDirectory(root, key);
        return directory is null ? null : TryResolveFileUnder(root, directory, fileName, sharedPagesFallback: false);
    }

    /// <summary>
    /// The traversal policy for ONE artifact, given a directory already known to sit under
    /// <paramref name="root"/>. Split out so <see cref="CouchCoopGeoclipStore"/> — which addresses its pose
    /// directories by hash rather than by <see cref="SanitizeKey"/>, and shares its pages across them — reuses
    /// this policy instead of writing a second one.
    /// </summary>
    /// <param name="sharedPagesFallback">
    /// When the artifact is a PAGE that the pose directory does not carry, also look in
    /// <c>&lt;root&gt;/pages/</c>. Opt-IN, and off for the operator root: adding a fallback there would let a
    /// request that used to 404 start serving bytes, which is not "the operator path keeps working unchanged".
    /// </param>
    public static string? TryResolveFileUnder(string root, string directory, string fileName, bool sharedPagesFallback)
    {
        if (string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(directory) || !IsAllowedFileName(fileName))
        {
            return null;
        }

        var path = Path.GetFullPath(Path.Combine(directory, fileName));
        if (File.Exists(path) && TryResolveUnder(root, path) is { } resolvedPath)
        {
            return resolvedPath;
        }

        if (!sharedPagesFallback || !IsPageFileName(fileName))
        {
            return null;
        }

        var shared = Path.GetFullPath(Path.Combine(root, CouchCoopGeoclipStore.PagesFolderName, fileName));
        return File.Exists(shared) ? TryResolveUnder(root, shared) : null;
    }

    /// <summary>
    /// The directory name <c>map.json</c> gives for this key, or null. Every failure mode — no map, unreadable
    /// map, malformed JSON, a non-string or unsafe value — answers null: a dev lookup table must never be able
    /// to take the host's request thread down, and an operator who typos it gets a 404 to debug, not a 500.
    /// </summary>
    private static string? TryReadMappedDirectoryName(string root, string key)
    {
        var mapPath = Path.Combine(root, MapFileName);
        var resolvedMapPath = File.Exists(mapPath) ? TryResolveUnder(root, mapPath) : null;
        if (resolvedMapPath is null)
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(resolvedMapPath));
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty(key, out var value)
                || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var name = value.GetString()?.Trim();
            return !string.IsNullOrEmpty(name) && IsSafeSegment(name) ? name : null;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// A single path segment with no separator, no drive/root, and no dot-dot — the shape a directory name is
    /// allowed to take before it is combined with the root.
    /// </summary>
    private static bool IsSafeSegment(string segment)
    {
        if (segment.Length == 0 || segment is "." or "..")
        {
            return false;
        }

        if (Path.IsPathRooted(segment) || segment.Contains("..", StringComparison.Ordinal))
        {
            return false;
        }

        return segment.IndexOfAny(['/', '\\', ':']) < 0
            && segment.IndexOfAny(Path.GetInvalidFileNameChars()) < 0;
    }

    /// <summary>Whether <paramref name="candidate"/> resolves inside <paramref name="root"/>.</summary>
    private static string? TryResolveUnder(string root, string candidate)
    {
        try
        {
            var fullRoot = Path.GetFullPath(root);
            var relative = Path.GetRelativePath(fullRoot, Path.GetFullPath(candidate));
            if (Path.IsPathRooted(relative)
                || relative == ".."
                || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                return null;
            }

            var resolvedRoot = StaticSpaFileProvider.ResolveExistingPath(fullRoot);
            var resolvedCandidate = StaticSpaFileProvider.ResolveExistingPath(Path.Combine(resolvedRoot, relative));
            return StaticSpaFileProvider.IsUnderResolvedRoot(resolvedRoot, resolvedCandidate) ? resolvedCandidate : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
