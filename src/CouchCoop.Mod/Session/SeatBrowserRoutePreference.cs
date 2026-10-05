using System.Text.Json;

namespace CouchCoop.Mod.Session;

/// <summary>How newly launched browser seats expose their view to phones.</summary>
public enum SeatBrowserRouteMode
{
    Shared,
    Direct,
}

/// <summary>A host choice stored independently from QR address selection.</summary>
public static class SeatBrowserRoutePreference
{
    public const string PathEnvironmentVariable = "COUCHCOOP_SEAT_ROUTE_PREFS";
    private const string FileName = "seat-route-prefs.json";

    public static SeatBrowserRouteMode Read()
    {
        try
        {
            var path = ResolvePath();
            if (!File.Exists(path)) return SeatBrowserRouteMode.Shared;
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("mode", out var mode)
                && mode.ValueKind == JsonValueKind.String)
            {
                return mode.GetString() switch
                {
                    "direct" => SeatBrowserRouteMode.Direct,
                    "shared" => SeatBrowserRouteMode.Shared,
                    _ => SeatBrowserRouteMode.Shared,
                };
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException
            or ArgumentException or NotSupportedException)
        {
        }
        return SeatBrowserRouteMode.Shared;
    }

    /// <summary>Returns false if the choice could not be persisted; the active choice is unchanged.</summary>
    public static bool Write(SeatBrowserRouteMode mode)
    {
        if (mode is not (SeatBrowserRouteMode.Shared or SeatBrowserRouteMode.Direct)) return false;
        string? temporary = null;
        try
        {
            var path = ResolvePath();
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteString("mode", mode == SeatBrowserRouteMode.Shared ? "shared" : "direct");
                writer.WriteEndObject();
            }
            File.Move(temporary, path, overwrite: true);
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
            or ArgumentException or NotSupportedException)
        {
            return false;
        }
        finally
        {
            if (temporary is not null)
            {
                try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }

    internal static string ResolvePath()
    {
        var configured = Environment.GetEnvironmentVariable(PathEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured)) return configured.Trim();
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local)) local = Path.GetTempPath();
        return Path.Combine(local, "SlayTheSpire2", "couch-coop", FileName);
    }
}
