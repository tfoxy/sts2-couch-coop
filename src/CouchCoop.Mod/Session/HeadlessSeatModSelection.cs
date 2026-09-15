using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Pins a spawned seat's mod selection to the copy of CouchCoop the HOST is running, by editing the
/// <c>settings.save</c> files <see cref="HeadlessUserDirSeeder"/> has just copied into the seat's
/// isolated user dir.
/// </summary>
/// <remarks>
/// <para>
/// WHY THE COPY IS NOT ENOUGH. The per-mod enable flag does live in the file the seeder copies —
/// <c>steam/&lt;id&gt;/settings.save</c>, under <c>mod_settings.mod_list</c>, one <c>{id, source,
/// is_enabled}</c> row per (mod, source) pair. But the file is not a record of what the host LOADED. The
/// game reads that list while starting up, decides from it, and then rewrites the list from the mods it
/// actually found; the rewritten rows do not necessarily carry the enable flags the host started with.
/// A seat is seeded from the host's user dir long after that rewrite, so it inherits the rewritten file,
/// not the host's decision. On a developer machine with both a local deploy and a Workshop
/// subscription, the host ran the local build and every seat ran the Workshop one, with one
/// <c>[WARN]</c> in each seat's log to say so.
/// </para>
/// <para>
/// So the seat is told explicitly: the row for the OTHER copy of <c>couchcoop</c> is written
/// <c>is_enabled: false</c>. That is not a version comparison and not a subscription check — the game
/// skips a mod whose (id, source) row is disabled before it ever compares two copies' versions, so the
/// outcome no longer depends on either.
/// </para>
/// <para>
/// SYMMETRIC, which matters for real players rather than for QA. The row disabled is derived from where
/// the host's own CouchCoop was loaded from (<see cref="CouchCoopModBuildIdentity.ModSource"/>): a host
/// running the Workshop build disables the seat's local row, not its Workshop one. Hardcoding "disable
/// the Workshop row" would have left an ordinary subscriber's seats with no CouchCoop at all.
/// </para>
/// <para>
/// Best-effort throughout, like the rest of the seeder: a seat that could not be pinned still launches,
/// because a seat that launches and might load the wrong copy beats a seat that does not launch. Every
/// skip says why on stderr.
/// </para>
/// </remarks>
internal static class HeadlessSeatModSelection
{
    private const string ModId = "couchcoop";
    private const string SettingsFileName = "settings.save";

    // Where a profile's settings.save lives, one level under each of these: `steam/<steamid>/` when Steam
    // is initialized (the normal case) and `default/<n>/` when it is not. Both are seeded, so both are
    // pinned — a seat that falls back to the offline profile must make the same choice as one that does not.
    private static readonly string[] ProfileRoots = ["steam", "default"];

    /// <summary>
    /// The mod-list row source a seat must DISABLE so it loads the same copy of CouchCoop as a host whose
    /// own copy came from <paramref name="hostModSource"/>. <see langword="null"/> when the host's source
    /// could not be told, in which case nothing is pinned.
    /// </summary>
    internal static string? SourceToDisable(string? hostModSource)
        => hostModSource switch
        {
            CouchCoopModBuildIdentity.LocalModSource => CouchCoopModBuildIdentity.WorkshopModSource,
            CouchCoopModBuildIdentity.WorkshopModSource => CouchCoopModBuildIdentity.LocalModSource,
            _ => null,
        };

    /// <summary>The source this process's own CouchCoop implies its seats must disable.</summary>
    internal static string? SourceToDisableForThisHost() => SourceToDisable(CouchCoopModBuildIdentity.ModSource);

    /// <summary>
    /// Pin every profile <c>settings.save</c> under <paramref name="slotUserDir"/>. Returns how many files
    /// were rewritten.
    /// </summary>
    internal static int PinSeatProfiles(string slotUserDir, string sourceToDisable, int slot)
    {
        var pinned = 0;
        foreach (var root in ProfileRoots)
        {
            var rootPath = Path.Combine(slotUserDir, root);
            if (!Directory.Exists(rootPath)) continue;
            // One level, explicitly enumerated — the same rule the seeder's copy walk follows, so a
            // directory symlink is never descended into.
            foreach (var profile in new DirectoryInfo(rootPath).EnumerateDirectories())
            {
                if (profile.LinkTarget is not null) continue;
                var settings = Path.Combine(profile.FullName, SettingsFileName);
                if (!File.Exists(settings)) continue;
                if (PinFile(settings, sourceToDisable, slot)) pinned++;
            }
        }

        return pinned;
    }

    private static bool PinFile(string settingsPath, string sourceToDisable, int slot)
    {
        try
        {
            var original = File.ReadAllText(settingsPath);
            var updated = Pin(original, sourceToDisable);
            if (updated is null) return false;
            // Same-directory temp plus a replacing move: the seat is not running yet, but the HOST may be
            // reading its own tree, and a half-written settings.save is a mod list the game cannot parse.
            var temporary = settingsPath + ".couchcoop-pin.tmp";
            File.WriteAllText(temporary, updated);
            File.Move(temporary, settingsPath, overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            Console.Error.WriteLine(
                $"[couchcoop] headless seat mod selection skipped slot={slot} file={settingsPath}: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Rewrite one <c>settings.save</c> so the <c>couchcoop</c> row for <paramref name="sourceToDisable"/>
    /// is present and disabled. Returns <see langword="null"/> when the file must be left exactly as it
    /// was copied.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The list must ALREADY EXIST and be non-empty. A settings file with no <c>mod_settings.mod_list</c>
    /// has never been written by a game that saw mods, and inventing the object around it would be
    /// declaring defaults for flags this code has no business deciding — including the one that turns mods
    /// off wholesale. An EMPTY list is skipped for a narrower reason: the game treats "the list was empty
    /// at startup" as this profile's first modded launch and migrates its unmodded saves on that basis, so
    /// a row appended into an empty list would quietly cancel that migration in the seat.
    /// </para>
    /// <para>
    /// A row that does not exist is APPENDED rather than inserted. The list doubles as the player's manual
    /// load order, so appending leaves every existing row at the index it already had. Appending a row for
    /// a copy of the mod this machine does not have is inert — the game only consults the list for mods it
    /// discovered, and rewrites the list from those same mods afterwards.
    /// </para>
    /// </remarks>
    internal static string? Pin(string settingsJson, string sourceToDisable)
    {
        using var document = JsonDocument.Parse(settingsJson);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        if (!root.TryGetProperty("mod_settings", out var modSettings) || modSettings.ValueKind != JsonValueKind.Object)
            return null;
        if (!modSettings.TryGetProperty("mod_list", out var modList) || modList.ValueKind != JsonValueKind.Array)
            return null;
        if (modList.GetArrayLength() == 0) return null;
        if (!NeedsChange(modList, sourceToDisable)) return null;

        using var stream = new MemoryStream();
        // UnsafeRelaxedJsonEscaping, because this is a REWRITE of somebody else's file: the default encoder
        // escapes every non-ASCII character to \uXXXX, which would silently rewrite a player's localized
        // settings values into an equivalent-but-different file on every single seat spawn.
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Indented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        }))
        {
            writer.WriteStartObject();
            foreach (var property in root.EnumerateObject())
            {
                if (property.NameEquals("mod_settings"))
                {
                    writer.WritePropertyName(property.Name);
                    WriteModSettings(writer, property.Value, sourceToDisable);
                }
                else
                {
                    property.WriteTo(writer);
                }
            }

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static bool NeedsChange(JsonElement modList, string sourceToDisable)
    {
        var writesSourceAsString = false;
        foreach (var entry in modList.EnumerateArray())
        {
            if (entry.ValueKind == JsonValueKind.Object
                && entry.TryGetProperty("source", out var anySource)
                && anySource.ValueKind == JsonValueKind.String)
            {
                writesSourceAsString = true;
            }

            if (!IsRow(entry, sourceToDisable)) continue;
            // Already disabled: leave the file byte-identical so a no-op spawn does not rewrite it.
            return !(entry.TryGetProperty("is_enabled", out var enabled) && enabled.ValueKind == JsonValueKind.False);
        }

        // No row at all — append one, but ONLY into a file that already writes `source` as a string. A row
        // in a shape this file does not use is a row the game may fail to deserialize, and an unreadable
        // settings.save is quarantined wholesale: that would cost the seat every setting, not just this one.
        return writesSourceAsString;
    }

    private static bool IsRow(JsonElement entry, string source)
        => entry.ValueKind == JsonValueKind.Object
            && entry.TryGetProperty("id", out var id)
            && id.ValueKind == JsonValueKind.String
            && string.Equals(id.GetString(), ModId, StringComparison.Ordinal)
            && entry.TryGetProperty("source", out var entrySource)
            && entrySource.ValueKind == JsonValueKind.String
            && string.Equals(entrySource.GetString(), source, StringComparison.Ordinal);

    private static void WriteModSettings(Utf8JsonWriter writer, JsonElement modSettings, string sourceToDisable)
    {
        writer.WriteStartObject();
        foreach (var property in modSettings.EnumerateObject())
        {
            if (property.NameEquals("mod_list") && property.Value.ValueKind == JsonValueKind.Array)
            {
                writer.WritePropertyName(property.Name);
                WriteModList(writer, property.Value, sourceToDisable);
            }
            else
            {
                property.WriteTo(writer);
            }
        }

        writer.WriteEndObject();
    }

    private static void WriteModList(Utf8JsonWriter writer, JsonElement modList, string sourceToDisable)
    {
        var matched = false;
        writer.WriteStartArray();
        foreach (var entry in modList.EnumerateArray())
        {
            if (!IsRow(entry, sourceToDisable))
            {
                entry.WriteTo(writer);
                continue;
            }

            matched = true;
            // Copy the row, forcing only `is_enabled`. `source` identifies WHICH copy the row is and is
            // never rewritten; anything else the game may have added to a row is carried through.
            writer.WriteStartObject();
            foreach (var property in entry.EnumerateObject())
            {
                if (property.NameEquals("is_enabled"))
                {
                    writer.WriteBoolean(property.Name, false);
                }
                else
                {
                    property.WriteTo(writer);
                }
            }

            if (!entry.TryGetProperty("is_enabled", out _)) writer.WriteBoolean("is_enabled", false);
            writer.WriteEndObject();
        }

        if (!matched)
        {
            writer.WriteStartObject();
            writer.WriteString("id", ModId);
            writer.WriteBoolean("is_enabled", false);
            writer.WriteString("source", sourceToDisable);
            writer.WriteEndObject();
        }

        writer.WriteEndArray();
    }
}
