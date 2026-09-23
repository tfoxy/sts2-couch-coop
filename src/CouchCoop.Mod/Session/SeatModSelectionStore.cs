using System.IO;
using System.Text.Json;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Where the host's seat mod choices are remembered between sessions: the ids it EXPLICITLY switched off for
/// its seats, and nothing else.
/// </summary>
/// <remarks>
/// <para>
/// ONLY THE EXPLICIT SET. The cascade — the dependents that go off with a mod — is derived from the dependency
/// graph on every read (<see cref="SeatModSelectionPlan.Resolve"/>), never stored, which is what makes
/// re-enabling a mod bring back exactly what it took. A stored cascade would have to be reconciled every time a
/// subscription changes.
/// </para>
/// <para>
/// EMPTY BY DEFAULT, and empty is what an unreadable, malformed or unknown store returns — a host who has never
/// picked anything, or whose file is corrupt, gets seats with every mod on, which is exactly what shipped before
/// this existed. That polarity is the whole safety property, and it is the same one the QR dialog's store
/// (<c>CouchCoopQrSelectionPreference</c>) is built on; this file copies its shape on purpose: an environment
/// override for the unit suite, the file beside <c>qr-prefs.json</c>, and a direct <see cref="Utf8JsonWriter"/>
/// rather than the reflection serializer, because the mod loads into a trimmed game process.
/// </para>
/// </remarks>
internal static class SeatModSelectionStore
{
    /// <summary>Overrides the file location; also what the unit suite points at a temp path.</summary>
    internal const string PathEnvironmentVariable = "COUCHCOOP_SEAT_MODS";

    private const string FileName = "seat-mods.json";

    // Named for what it holds, so the file explains itself to whoever opens it while debugging a seat.
    private const string ExplicitlyDisabledProperty = "explicitlyDisabled";

    /// <summary>Read the explicit set. Any failure or unknown content answers an empty set.</summary>
    internal static IReadOnlySet<string> Read() => TryRead(ResolvePath());

    /// <summary>Persist the explicit set. Best-effort: a store we cannot write costs the host one re-pick.</summary>
    internal static void Write(IReadOnlyCollection<string> ids) => TryWrite(ResolvePath(), ids);

    internal static IReadOnlySet<string> TryRead(string? path)
    {
        var empty = new HashSet<string>(SeatModSelectionPlan.IdComparer);
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return empty;
        }

        try
        {
            using var stream = File.OpenRead(path);
            using var document = JsonDocument.Parse(stream);
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty(ExplicitlyDisabledProperty, out var list)
                || list.ValueKind != JsonValueKind.Array)
            {
                return empty;
            }

            var ids = new HashSet<string>(SeatModSelectionPlan.IdComparer);
            foreach (var element in list.EnumerateArray())
            {
                // One element of a shape this build did not write makes the whole file unknown. Keeping the
                // readable half would be guessing at what a newer build meant by the rest — and a guess here
                // is a mod missing from somebody's seat.
                if (element.ValueKind != JsonValueKind.String) return empty;
                var id = element.GetString();
                if (!string.IsNullOrWhiteSpace(id)) ids.Add(id.Trim());
            }

            return ids;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException or NotSupportedException)
        {
            return empty;
        }
    }

    internal static void TryWrite(string? path, IReadOnlyCollection<string> ids)
    {
        ArgumentNullException.ThrowIfNull(ids);
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

            // Deduplicated the way ids are compared, and sorted, so the same choice always writes the same bytes.
            var ordered = ids
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Select(id => id.Trim())
                .Distinct(SeatModSelectionPlan.IdComparer)
                .OrderBy(id => id, StringComparer.OrdinalIgnoreCase)
                .ThenBy(id => id, StringComparer.Ordinal)
                .ToList();

            using var stream = File.Create(path);
            using var writer = new Utf8JsonWriter(stream);
            writer.WriteStartObject();
            writer.WriteStartArray(ExplicitlyDisabledProperty);
            foreach (var id in ordered)
            {
                writer.WriteStringValue(id);
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
        }
    }

    internal static string? ResolvePath()
    {
        var configured = Environment.GetEnvironmentVariable(PathEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured.Trim();
        }

        // The same directory CouchCoopQrSelectionPreference.ResolvePath puts qr-prefs.json in, spelled out
        // rather than derived from it: deriving it would inherit that store's own test override.
        try
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
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
