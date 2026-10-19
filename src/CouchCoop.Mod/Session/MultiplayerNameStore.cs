using System.Diagnostics;
using System.Text.Json;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Session;

/// <summary>The durable host roster, shared with seats independently of their isolated user directories.</summary>
internal static class MultiplayerNameStore
{
    internal const string FileName = "mp_names.json";
    internal const string PathEnvironmentVariable = "COUCHCOOP_MULTIPLAYER_NAMES_PATH";
    private static readonly IReadOnlyDictionary<ulong, string> EmptyNames = new Dictionary<ulong, string>();

    internal static string? ResolveWritePath()
    {
        var inherited = Environment.GetEnvironmentVariable(PathEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(inherited))
        {
            // A relative override would reintroduce the launch-directory dependency this store removes.
            try
            {
                return Path.IsPathFullyQualified(inherited)
                    && !string.IsNullOrEmpty(Path.GetFileName(inherited))
                    && !string.IsNullOrEmpty(Path.GetDirectoryName(inherited))
                        ? inherited
                        : null;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        return CouchCoopUserFile.TryResolve(FileName);
    }

    internal static string? ResolveReadPath()
    {
        try
        {
            var canonical = ResolveWritePath();
            if (canonical is not null && File.Exists(canonical)) return canonical;
            var legacy = Path.Combine(Directory.GetCurrentDirectory(), FileName);
            return File.Exists(legacy) ? legacy : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    internal static IReadOnlyDictionary<ulong, string> Read()
    {
        var canonical = ResolveWritePath();
        var source = ResolveReadPath();
        if (source is null || !TryRead(source, out var names)) return EmptyNames;

        // An existing canonical file is authoritative, including an empty or malformed one. Only a real,
        // readable legacy file is migrated; no file is ever created in the launch directory.
        if (canonical is not null && !string.Equals(source, canonical, StringComparison.Ordinal))
        {
            try
            {
                WriteAtomic(canonical, names.Select(entry => new HeadlessClientManager.MultiplayerNameEntry
                {
                    net_id = entry.Key,
                    name = entry.Value,
                }).ToList(), overwrite: false);
            }
            catch (IOException) when (File.Exists(canonical))
            {
                // Another reader or the host published the canonical map while migration was in flight.
                return TryRead(canonical, out var published) ? published : EmptyNames;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                CouchCoopLog.Warn($"could not migrate player names: {exception.Message}");
            }
        }

        return names;
    }

    internal static void Write(string path, IReadOnlyList<HeadlessClientManager.MultiplayerNameEntry> entries)
        => WriteAtomic(path, entries, overwrite: true);

    private static void WriteAtomic(
        string path,
        IReadOnlyList<HeadlessClientManager.MultiplayerNameEntry> entries,
        bool overwrite)
    {
        if (!Path.IsPathFullyQualified(path)) throw new ArgumentException("Player-name path must be absolute.", nameof(path));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(entries));
            File.Move(temporary, path, overwrite);
        }
        finally
        {
            try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    private static bool TryRead(string path, out IReadOnlyDictionary<ulong, string> names)
    {
        names = EmptyNames;
        try
        {
            var entries = JsonSerializer.Deserialize<List<HeadlessClientManager.MultiplayerNameEntry>>(File.ReadAllText(path));
            if (entries is null) return false;
            var map = new Dictionary<ulong, string>();
            foreach (var entry in entries)
            {
                var name = entry?.name?.Trim();
                if (!string.IsNullOrEmpty(name)) map[entry!.net_id] = name;
            }
            names = map;
            return true;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    internal static void ConfigureSeatLaunch(ProcessStartInfo start, bool hasWrapper)
    {
        var path = ResolveWritePath();
        if (path is null) return;
        start.EnvironmentVariables[PathEnvironmentVariable] = path;
        // Direct game launches also retain the native startup reader's relative-file contract. Custom
        // wrappers keep their working directory because their own arguments may contain relative paths.
        var directory = Path.GetDirectoryName(path)!;
        if (!hasWrapper && Directory.Exists(directory)) start.WorkingDirectory = directory;
    }
}
