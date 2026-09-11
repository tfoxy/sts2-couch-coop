namespace CouchCoop.Mod.HostUi;

/// <summary>A remembered pick: which method, and (for per-adapter methods) which address it was for.</summary>
/// <remarks>
/// The host is the ADAPTER's IPv4, not the row's display host — a web row's display host is the public
/// origin, which every adapter's web row shares. Null for the methods that have no adapter (mdns,
/// override).
/// </remarks>
public sealed record QrSelectionMemory(string Method, string? Host)
{
    /// <summary>
    /// The exact <see cref="QrHostOption.SelectionKey"/> this memory names.
    /// </summary>
    public string PreferredSelectionKey => Host is { Length: > 0 } ? $"{Method}|{Host}" : Method;
}

/// <summary>
/// Where the QR dialog's selected option is remembered between sessions.
/// </summary>
/// <remarks>
/// <para>
/// ABSENT BY DEFAULT, and absent is what an unreadable, malformed or unknown store returns — a player
/// who has never picked anything, or whose config file is corrupt, gets the dialog's own default (the
/// first available option, which is the plain address that works with no internet). That polarity is
/// the whole safety property, inherited from the checkbox-era store this replaces.
/// </para>
/// <para>
/// The tiny JSON file is written directly rather than through the reflection serializer (the mod loads into a
/// trimmed game process), and remains readable from the Godot-less unit suite.
/// </para>
/// </remarks>
public static class CouchCoopQrSelectionPreference
{
    /// <summary>Overrides the settings file location; also what the unit suite points at a temp path.</summary>
    public const string PathEnvironmentVariable = "COUCHCOOP_QR_PREFS";

    private const string FileName = "qr-prefs.json";

    private static readonly string[] KnownMethods = ["ipv4", "web", "secure", "mdns", "override"];

    /// <summary>Read the remembered pick. Any failure or unknown content answers <see langword="null"/>.</summary>
    public static QrSelectionMemory? Read() => TryRead(ResolvePath());

    /// <summary>Persist the pick. Best-effort: a store we cannot write costs the player one re-pick.</summary>
    public static void Write(QrHostOption option)
    {
        ArgumentNullException.ThrowIfNull(option);
        TryWrite(ResolvePath(), new QrSelectionMemory(option.MethodToken, option.Adapter?.Address.ToString()));
    }

    internal static QrSelectionMemory? TryRead(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return null;
        }

        try
        {
            using var stream = File.OpenRead(path);
            using var document = System.Text.Json.JsonDocument.Parse(stream);
            if (document.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object)
            {
                return null;
            }

            // The current shape.
            if (document.RootElement.TryGetProperty("selection", out var selection)
                && selection.ValueKind == System.Text.Json.JsonValueKind.Object
                && selection.TryGetProperty("method", out var method)
                && method.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                var methodValue = method.GetString();
                if (methodValue is null || !KnownMethods.Contains(methodValue, StringComparer.Ordinal))
                {
                    // A method a NEWER build wrote that this one does not know: fall back to the
                    // dialog's default rather than guess.
                    return null;
                }

                var host = selection.TryGetProperty("host", out var hostProperty)
                    && hostProperty.ValueKind == System.Text.Json.JsonValueKind.String
                        ? hostProperty.GetString()
                        : null;
                return new QrSelectionMemory(methodValue, string.IsNullOrWhiteSpace(host) ? null : host);
            }

            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    internal static void TryWrite(string? path, QrSelectionMemory memory)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            using var stream = File.Create(path);
            using var writer = new System.Text.Json.Utf8JsonWriter(stream);
            writer.WriteStartObject();
            writer.WriteStartObject("selection");
            writer.WriteString("method", memory.Method);
            if (memory.Host is { Length: > 0 })
            {
                writer.WriteString("host", memory.Host);
            }

            writer.WriteEndObject();
            writer.WriteEndObject();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
        }
    }

    internal static string? ResolvePath()
    {
        var configured = System.Environment.GetEnvironmentVariable(PathEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured.Trim();
        }

        try
        {
            var local = System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData);
            return string.IsNullOrWhiteSpace(local)
                ? Path.Combine(Path.GetTempPath(), "SlayTheSpire2", "couch-coop", FileName)
                : Path.Combine(local, "SlayTheSpire2", "couch-coop", FileName);
        }
        catch (Exception exception) when (exception is ArgumentException or PlatformNotSupportedException)
        {
            return null;
        }
    }
}
