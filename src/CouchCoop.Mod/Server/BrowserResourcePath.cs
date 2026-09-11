namespace CouchCoop.Mod.Server;

/// <summary>Validation for caller-controlled resource names before they reach an asset cache or extractor.</summary>
internal static class BrowserResourcePath
{
    public static bool IsSafeRelative(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)
            || Path.IsPathRooted(path)
            || path[0] is '/' or '\\'
            || path.Contains('\\')
            || path.Contains(':')
            || path.IndexOfAny(['?', '#', '&']) >= 0
            || path.Any(char.IsControl))
        {
            return false;
        }

        return path.Split('/').All(segment => segment.Length > 0 && segment is not "." and not "..");
    }

    public static bool IsSafeResPath(string? path)
        => path is not null
           && path.StartsWith("res://", StringComparison.Ordinal)
           && IsSafeRelative(path["res://".Length..]);

    public static bool IsSafeSelector(string? value)
        => value is not null
           && !value.Any(char.IsControl)
           && value.IndexOfAny(['\\', '?', '#', '&', ':']) < 0;
}
