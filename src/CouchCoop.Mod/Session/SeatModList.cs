using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace CouchCoop.Mod.Session;

/// <summary>
/// One <c>mod_list</c> row's identity: the mod id and the source the copy was installed from. The same id can
/// be installed twice (a local deploy and a Workshop subscription), and the game keys each copy's enable flag
/// separately, so the id alone does not name a row.
/// </summary>
/// <remarks>
/// Ids compare case-insensitively (<see cref="SeatModSelectionPlan.IdComparer"/>), for the reason given there;
/// sources compare ordinally, because they are two fixed tokens the game writes itself and a source that differs
/// only in case is not one this code knows.
/// </remarks>
internal readonly record struct SeatModRowKey(string Id, string Source)
{
    public bool Equals(SeatModRowKey other)
        => SeatModSelectionPlan.IdComparer.Equals(Id, other.Id)
            && string.Equals(Source, other.Source, StringComparison.Ordinal);

    public override int GetHashCode()
        => HashCode.Combine(
            SeatModSelectionPlan.IdComparer.GetHashCode(Id ?? string.Empty),
            StringComparer.Ordinal.GetHashCode(Source ?? string.Empty));

    public override string ToString() => $"{Id}/{Source}";
}

/// <summary>A row as a <c>mod_list</c> holds it.</summary>
/// <param name="IsEnabled">
/// True only for an explicit <c>"is_enabled": true</c>. A row that says anything else is not counted as enabled,
/// which for every caller is the direction that disables nothing.
/// </param>
internal sealed record SeatModListRow(string Id, string Source, bool IsEnabled)
{
    public SeatModRowKey Key => new(Id, Source);
}

/// <summary>What <see cref="SeatModList.Disable"/> did to one <c>settings.save</c>.</summary>
/// <param name="Updated">The rewritten file, or <see langword="null"/> when it must be left byte-identical.</param>
/// <param name="NotDisabled">
/// Requested rows the file does NOT end up disabling — only ever rows that were missing from a list this code
/// declined to append into (see <see cref="SeatModList.Disable"/>). Empty when every requested row is off.
/// </param>
/// <param name="Refusal">
/// Why the whole file was left alone, or <see langword="null"/>. A refusal is a list this code has no business
/// editing, not an error.
/// </param>
/// <param name="NothingToPin">
/// The refusal is one of the two deliberate ones for a profile with no rows to edit: it has NO mod list (no
/// <c>mod_settings</c>, or no <c>mod_list</c> in it), or an EMPTY one. Such a profile is one a modded launch has
/// not written a list into yet, so a caller accounting for a seat counts it as nothing to pin rather than a
/// miss. False for every other refusal — a file whose settings are in a shape this code does not know is a
/// profile it could not pin, and says so.
/// </param>
internal sealed record SeatModListEdit(
    string? Updated,
    IReadOnlyList<SeatModRowKey> NotDisabled,
    string? Refusal,
    bool NothingToPin = false)
{
    /// <summary>Every requested row is disabled in the file as it now stands (rewritten or already so).</summary>
    public bool Applied => Refusal is null && NotDisabled.Count == 0;
}

/// <summary>
/// The one reader and rewriter of a profile's <c>settings.save</c> → <c>mod_settings.mod_list</c>: the list the
/// game keys every installed mod's enable flag by, one <c>{id, source, is_enabled}</c> row per (mod, source)
/// pair.
/// </summary>
/// <remarks>
/// <para>
/// Two callers, one parser, so they cannot disagree about which rows exist: seat launch, which DISABLES rows in
/// the copy of the host's profile a seat is seeded with (<see cref="HeadlessSeatModSelection"/>), and the host's
/// mod inventory, which READS the host's own list to learn which rows there are to disable
/// (<c>SeatModInventory</c>). Factored out of <see cref="HeadlessSeatModSelection"/>, whose single
/// <c>couchcoop</c> row is now one row of the set this edits.
/// </para>
/// <para>
/// BCL-only on purpose: <see cref="HeadlessSeatModSelection"/> is source-linked into the game-free macOS suite,
/// and so is this.
/// </para>
/// </remarks>
internal static class SeatModList
{
    internal const string SettingsFileName = "settings.save";

    // Where a profile's settings.save lives, one level under each of these: `steam/<steamid>/` when Steam is
    // initialized (the normal case) and `default/<n>/` when it is not. A seat is seeded with both and pinned in
    // both — a seat that falls back to the offline profile must make the same choice as one that does not — and
    // the host's inventory considers both.
    private static readonly string[] ProfileRoots = ["steam", "default"];

    /// <summary>
    /// Every profile <c>settings.save</c> under <paramref name="userDir"/>, steam profiles first.
    /// </summary>
    /// <remarks>
    /// One level, explicitly enumerated — the same rule the seeder's copy walk follows, so a directory symlink is
    /// never descended into.
    /// </remarks>
    internal static IEnumerable<string> ProfileSettingsFiles(string userDir)
    {
        foreach (var root in ProfileRoots)
        {
            var rootPath = Path.Combine(userDir, root);
            if (!Directory.Exists(rootPath)) continue;
            foreach (var profile in new DirectoryInfo(rootPath).EnumerateDirectories())
            {
                if (profile.LinkTarget is not null) continue;
                var settings = Path.Combine(profile.FullName, SettingsFileName);
                if (File.Exists(settings)) yield return settings;
            }
        }
    }

    /// <summary>
    /// The rows of <paramref name="settingsJson"/>'s mod list, in list order, or <see langword="null"/> — with
    /// the reason in <paramref name="refusal"/> — when the file has no list this code would act on. Rows that
    /// are not an object with a string <c>id</c> and a string <c>source</c> are skipped.
    /// </summary>
    /// <exception cref="JsonException">The file is not JSON at all.</exception>
    internal static IReadOnlyList<SeatModListRow>? ReadRows(string settingsJson, out string? refusal)
    {
        using var document = JsonDocument.Parse(settingsJson);
        if (!TryGetModList(document.RootElement, out var modList, out refusal, out _)) return null;

        var rows = new List<SeatModListRow>();
        foreach (var entry in modList.EnumerateArray())
        {
            if (!TryKey(entry, out var key)) continue;
            var enabled = entry.TryGetProperty("is_enabled", out var flag) && flag.ValueKind == JsonValueKind.True;
            rows.Add(new SeatModListRow(key.Id, key.Source, enabled));
        }

        return rows;
    }

    /// <summary>
    /// Rewrite one <c>settings.save</c> so every row in <paramref name="rowsToDisable"/> is present and
    /// disabled. <see cref="SeatModListEdit.Updated"/> is <see langword="null"/> when the file must be left
    /// exactly as it was.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The list must ALREADY EXIST and be non-empty. A settings file with no <c>mod_settings.mod_list</c> has
    /// never been written by a game that saw mods, and inventing the object around it would be declaring defaults
    /// for flags this code has no business deciding — including the one that turns mods off wholesale. An EMPTY
    /// list is skipped for a narrower reason: the game treats "the list was empty at startup" as this profile's
    /// first modded launch and migrates its unmodded saves on that basis, so a row appended into an empty list
    /// would quietly cancel that migration in the seat.
    /// </para>
    /// <para>
    /// A row that does not exist is APPENDED rather than inserted. The list doubles as the player's manual load
    /// order, so appending leaves every existing row at the index it already had. Appending a row for a copy of a
    /// mod this machine does not have is inert — the game only consults the list for mods it discovered, and
    /// rewrites the list from those same mods afterwards. But a row is only appended into a file that already
    /// writes <c>source</c> as a string: a row in a shape this file does not use is a row the game may fail to
    /// deserialize, and an unreadable <c>settings.save</c> is quarantined wholesale, which would cost the seat
    /// every setting rather than just this one. Such a row is reported in
    /// <see cref="SeatModListEdit.NotDisabled"/> instead.
    /// </para>
    /// <para>
    /// A row already disabled is left alone, and a file whose every requested row is already off is not
    /// rewritten at all — byte-identical, so a no-op spawn does not touch it.
    /// </para>
    /// </remarks>
    /// <exception cref="JsonException">The file is not JSON at all.</exception>
    internal static SeatModListEdit Disable(string settingsJson, IEnumerable<SeatModRowKey> rowsToDisable)
    {
        ArgumentNullException.ThrowIfNull(rowsToDisable);
        var requested = DistinctUsable(rowsToDisable);

        using var document = JsonDocument.Parse(settingsJson);
        var root = document.RootElement;
        if (!TryGetModList(root, out var modList, out var refusal, out var nothingToPin))
        {
            return new SeatModListEdit(null, requested, refusal, nothingToPin);
        }

        if (requested.Count == 0) return new SeatModListEdit(null, [], null);

        var wanted = new HashSet<SeatModRowKey>(requested);
        var present = new HashSet<SeatModRowKey>();
        var needsFlip = false;
        var writesSourceAsString = false;
        foreach (var entry in modList.EnumerateArray())
        {
            if (entry.ValueKind == JsonValueKind.Object
                && entry.TryGetProperty("source", out var anySource)
                && anySource.ValueKind == JsonValueKind.String)
            {
                writesSourceAsString = true;
            }

            if (!TryKey(entry, out var key) || !wanted.Contains(key)) continue;
            present.Add(key);
            if (!IsDisabled(entry)) needsFlip = true;
        }

        var missing = requested.Where(key => !present.Contains(key)).ToList();
        var toAppend = writesSourceAsString ? missing : [];
        var notDisabled = writesSourceAsString ? [] : missing;
        if (!needsFlip && toAppend.Count == 0) return new SeatModListEdit(null, notDisabled, null);

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
                    WriteModSettings(writer, property.Value, wanted, toAppend);
                }
                else
                {
                    property.WriteTo(writer);
                }
            }

            writer.WriteEndObject();
        }

        return new SeatModListEdit(Encoding.UTF8.GetString(stream.ToArray()), notDisabled, null);
    }

    // The refusals, shared by the reader and the rewriter so the inventory never offers a row the seat-side
    // rewrite would then decline to touch for a reason of shape. `nothingToPin` separates the deliberate ones —
    // no list at all (absent or null, which is how a profile no modded launch has written reads), or an empty
    // one — from a shape this code does not know, which is a profile it could not pin. See SeatModListEdit.
    private static bool TryGetModList(
        JsonElement root,
        out JsonElement modList,
        out string? refusal,
        out bool nothingToPin)
    {
        modList = default;
        refusal = null;
        nothingToPin = false;
        if (root.ValueKind != JsonValueKind.Object)
        {
            refusal = "the file is not a JSON object";
            return false;
        }

        if (!root.TryGetProperty("mod_settings", out var modSettings) || modSettings.ValueKind == JsonValueKind.Null)
        {
            refusal = "it has no mod_settings object — no game that saw mods has written this profile";
            nothingToPin = true;
            return false;
        }

        if (modSettings.ValueKind != JsonValueKind.Object)
        {
            refusal = "mod_settings is not an object";
            return false;
        }

        if (!modSettings.TryGetProperty("mod_list", out modList) || modList.ValueKind == JsonValueKind.Null)
        {
            refusal = "mod_settings has no mod_list";
            nothingToPin = true;
            return false;
        }

        if (modList.ValueKind != JsonValueKind.Array)
        {
            refusal = "mod_settings.mod_list is not an array";
            return false;
        }

        if (modList.GetArrayLength() == 0)
        {
            refusal = "mod_settings.mod_list is empty — the profile's first modded launch, whose save migration "
                + "a row appended here would cancel";
            nothingToPin = true;
            return false;
        }

        return true;
    }

    private static bool TryKey(JsonElement entry, out SeatModRowKey key)
    {
        key = default;
        if (entry.ValueKind != JsonValueKind.Object
            || !entry.TryGetProperty("id", out var id)
            || id.ValueKind != JsonValueKind.String
            || !entry.TryGetProperty("source", out var source)
            || source.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        var idText = id.GetString();
        var sourceText = source.GetString();
        if (string.IsNullOrEmpty(idText) || string.IsNullOrEmpty(sourceText)) return false;
        key = new SeatModRowKey(idText, sourceText);
        return true;
    }

    private static bool IsDisabled(JsonElement entry)
        => entry.TryGetProperty("is_enabled", out var enabled) && enabled.ValueKind == JsonValueKind.False;

    // Order-preserving, so the rows appended to a list land in the order the caller named them, and blank keys
    // (which no list row can match) are dropped rather than appended as rows the game cannot use.
    private static List<SeatModRowKey> DistinctUsable(IEnumerable<SeatModRowKey> rows)
    {
        var seen = new HashSet<SeatModRowKey>();
        var ordered = new List<SeatModRowKey>();
        foreach (var row in rows)
        {
            if (string.IsNullOrWhiteSpace(row.Id) || string.IsNullOrWhiteSpace(row.Source)) continue;
            if (seen.Add(row)) ordered.Add(row);
        }

        return ordered;
    }

    private static void WriteModSettings(
        Utf8JsonWriter writer,
        JsonElement modSettings,
        HashSet<SeatModRowKey> wanted,
        IReadOnlyList<SeatModRowKey> toAppend)
    {
        writer.WriteStartObject();
        foreach (var property in modSettings.EnumerateObject())
        {
            if (property.NameEquals("mod_list") && property.Value.ValueKind == JsonValueKind.Array)
            {
                writer.WritePropertyName(property.Name);
                WriteModList(writer, property.Value, wanted, toAppend);
            }
            else
            {
                property.WriteTo(writer);
            }
        }

        writer.WriteEndObject();
    }

    private static void WriteModList(
        Utf8JsonWriter writer,
        JsonElement modList,
        HashSet<SeatModRowKey> wanted,
        IReadOnlyList<SeatModRowKey> toAppend)
    {
        writer.WriteStartArray();
        foreach (var entry in modList.EnumerateArray())
        {
            if (!TryKey(entry, out var key) || !wanted.Contains(key))
            {
                entry.WriteTo(writer);
                continue;
            }

            // Copy the row, forcing only `is_enabled`. `id` and `source` identify WHICH copy the row is and are
            // never rewritten — not even to the caller's spelling of the id; anything else the game may have
            // added to a row is carried through.
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

        foreach (var key in toAppend)
        {
            writer.WriteStartObject();
            writer.WriteString("id", key.Id);
            writer.WriteBoolean("is_enabled", false);
            writer.WriteString("source", key.Source);
            writer.WriteEndObject();
        }

        writer.WriteEndArray();
    }
}
