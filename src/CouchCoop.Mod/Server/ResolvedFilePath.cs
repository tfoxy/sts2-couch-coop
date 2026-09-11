namespace CouchCoop.Mod.Server;

/// <summary>Resolves existing links in every component, including ancestors of a link's target.</summary>
internal static class ResolvedFilePath
{
    public static string Resolve(string path) => Resolve(path, 0);

    private static string Resolve(string path, int links)
    {
        if (links > 40) throw new IOException("Too many filesystem links.");
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full) ?? throw new IOException("Path has no filesystem root.");
        var current = root;
        foreach (var part in full[root.Length..].Split(
                     [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            if (!Directory.Exists(current) && !File.Exists(current)) continue;
            FileSystemInfo info = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
            if (info.ResolveLinkTarget(true) is { } target)
                current = Resolve(target.FullName, links + 1);
        }
        return Path.GetFullPath(current);
    }
}
