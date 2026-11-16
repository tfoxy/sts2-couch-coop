using System.IO;
using System.Text.Json;
using CouchCoop.Mod.Contracts;

namespace CouchCoop.Mod.Session;

/// <summary>Remembers the game machine's couch play choice; unreadable settings default to Off.</summary>
public static class CouchPlayModeStore
{
    internal const string PathEnvironmentVariable = "COUCHCOOP_COUCH_PLAY";
    private const string FileName = "couch-play.json";
    private static readonly object Gate = new();
    private static CouchPlayMode? _current;

    public static CouchPlayMode Current
    {
        get { lock (Gate) return _current ??= Read(ResolvePath()); }
    }

    public static event Action<CouchPlayMode>? Changed;

    /// <summary>Publish a new choice only after it has been saved successfully.</summary>
    public static bool TrySet(CouchPlayMode mode)
    {
        if (mode is not (CouchPlayMode.Off or CouchPlayMode.SoloScreens or CouchPlayMode.EveryScreen)) return false;
        bool changed;
        lock (Gate)
        {
            var previous = _current ??= Read(ResolvePath());
            if (!TryWrite(ResolvePath(), mode)) return false;
            _current = mode;
            changed = previous != mode;
        }
        if (changed) Changed?.Invoke(mode);
        return true;
    }

    private static CouchPlayMode Read(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return CouchPlayMode.Off;
        try
        {
            using var stream = File.OpenRead(path);
            using var document = JsonDocument.Parse(stream);
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("mode", out var value)
                || value.ValueKind != JsonValueKind.String) return CouchPlayMode.Off;
            return value.GetString() switch
            {
                nameof(CouchPlayMode.SoloScreens) => CouchPlayMode.SoloScreens,
                nameof(CouchPlayMode.EveryScreen) => CouchPlayMode.EveryScreen,
                _ => CouchPlayMode.Off,
            };
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException or NotSupportedException)
        {
            return CouchPlayMode.Off;
        }
    }

    private static bool TryWrite(string? path, CouchPlayMode mode)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            using var stream = File.Create(path);
            using var writer = new Utf8JsonWriter(stream);
            writer.WriteStartObject();
            writer.WriteString("mode", mode switch
            {
                CouchPlayMode.SoloScreens => nameof(CouchPlayMode.SoloScreens),
                CouchPlayMode.EveryScreen => nameof(CouchPlayMode.EveryScreen),
                _ => nameof(CouchPlayMode.Off),
            });
            writer.WriteEndObject();
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return false;
        }
    }

    internal static string? ResolvePath()
    {
        var configured = Environment.GetEnvironmentVariable(PathEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured)) return configured.Trim();
        try
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(string.IsNullOrWhiteSpace(local) ? Path.GetTempPath() : local,
                "SlayTheSpire2", "couch-coop", FileName);
        }
        catch (Exception exception) when (exception is ArgumentException or PlatformNotSupportedException)
        {
            return null;
        }
    }

    internal static void ResetForTests()
    {
        lock (Gate) _current = null;
    }
}
