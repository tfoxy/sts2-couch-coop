using System.Text.Json;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Session;

// A seat must run the SAME copy of CouchCoop as the host that spawned it.
//
// Two copies of this mod can be installed at once — a local deploy in the install's `mods/` dir and a Steam
// Workshop subscription — and the game chooses between them per process. On the beta it chooses by VERSION,
// so the choice can differ between the host and the seats it spawns: during one beta QA session the host ran
// the local build while every seat silently loaded the Workshop one, and the whole session measured a
// different binary than the one under test.
//
// Two independent defences, both covered here:
//   1. the seat is SEEDED so the choice is not a version comparison at all (HeadlessSeatModSelection),
//   2. and if it diverges anyway, the seat REFUSES rather than joining (HeadlessSeatBuildGuard).
internal static class SeatModBuildTests
{
    public static void Run()
    {
        MismatchOnlyFiresWhenTheHostSaidSomethingDifferent();
        MismatchDetailNamesTheFileTheSeatLoaded();
        ModSourceIsClassifiedByPathShape();
        SeatDisablesTheCopyTheHostIsNotRunning();
        PinDisablesAnEnabledWorkshopRow();
        PinAppendsAMissingRow();
        PinLeavesAnAlreadyDisabledRowAlone();
        PinPreservesEveryOtherSettingAndTheGodotJsonShape();
        PinRefusesToInventAModList();
        SeedingPinsEveryProfileItCopied();
        Console.WriteLine("SeatModBuildTests: ok");
    }

    // ---------------------------------------------------------------------------------------------
    // The guard's comparison.
    // ---------------------------------------------------------------------------------------------

    private static void MismatchOnlyFiresWhenTheHostSaidSomethingDifferent()
    {
        Assert(HeadlessSeatBuildGuard.Mismatch("1.0.0+abc", "1.0.0+abc", "/mods/couchcoop/CouchCoop.Mod.dll") is null,
            "the same build on both sides is not a mismatch");

        // A host that predates the check sets nothing. That seat must start exactly as it did before —
        // refusing on a missing variable would break every seat spawned by an older host.
        Assert(HeadlessSeatBuildGuard.Mismatch(null, "1.0.0+abc", "/mods/couchcoop/CouchCoop.Mod.dll") is null,
            "an absent host build is not a mismatch");
        Assert(HeadlessSeatBuildGuard.Mismatch("", "1.0.0+abc", "/mods/couchcoop/CouchCoop.Mod.dll") is null,
            "an empty host build is not a mismatch");
        Assert(HeadlessSeatBuildGuard.Mismatch("   ", "1.0.0+abc", "/mods/couchcoop/CouchCoop.Mod.dll") is null,
            "a blank host build is not a mismatch");

        Assert(HeadlessSeatBuildGuard.Mismatch("1.0.0+abc", "0.1.1+snapshot.def", "/x") is not null,
            "a different build on the seat is a mismatch");
        // Not a version comparison in either direction: the browser wire contract moves between commits
        // with no version bump of its own, so "newer" is not "compatible".
        Assert(HeadlessSeatBuildGuard.Mismatch("0.1.1", "9999.0.0+dev.abc", "/x") is not null,
            "a HIGHER seat version is still a mismatch");
        Assert(HeadlessSeatBuildGuard.Mismatch("1.0.0+ABC", "1.0.0+abc", "/x") is not null,
            "the comparison is ordinal — a commit hash differing only in case is a different build");
        Assert(HeadlessSeatBuildGuard.Mismatch("1.0.0+abc", null, "/x") is not null,
            "a seat that cannot name its own build, against a host that can, is a mismatch");
    }

    private static void MismatchDetailNamesTheFileTheSeatLoaded()
    {
        // The path is the whole point of the report. "versions differ" is not a diagnosis; a path under
        // steamapps/workshop/content tells a player they have the published copy installed.
        const string workshop = "/home/p/.steam/steamapps/workshop/content/2868840/3800644054/CouchCoop.Mod.dll";
        var detail = HeadlessSeatBuildGuard.Mismatch("1.0.0+abc", "0.1.1+snapshot.def", workshop);
        Assert(detail is not null, "a mismatch produces a detail");
        Assert(detail!.Contains(workshop, StringComparison.Ordinal), "the detail names the assembly the seat loaded");
        Assert(detail.Contains("1.0.0+abc", StringComparison.Ordinal), "the detail names the host's build");
        Assert(detail.Contains("0.1.1+snapshot.def", StringComparison.Ordinal), "the detail names the seat's build");

        var unknownPath = HeadlessSeatBuildGuard.Mismatch("1.0.0+abc", "0.1.1", null);
        Assert(unknownPath is not null && unknownPath.Contains("unknown", StringComparison.Ordinal),
            "an unavailable assembly path is reported as unknown rather than swallowing the mismatch");

        // The host bounds ErrorDetail at 2048 characters, so a path can never make the report unsendable.
        Assert(detail.Length < 2048, "the detail fits the control channel's bound");
    }

    // ---------------------------------------------------------------------------------------------
    // Which copy of the mod a path is.
    // ---------------------------------------------------------------------------------------------

    private static void ModSourceIsClassifiedByPathShape()
    {
        Assert(CouchCoopModBuildIdentity.ModSourceOf(
                "/home/p/.steam/steamapps/workshop/content/2868840/3800644054/CouchCoop.Mod.dll")
            == CouchCoopModBuildIdentity.WorkshopModSource, "a Steam UGC install path is the Workshop copy");
        Assert(CouchCoopModBuildIdentity.ModSourceOf(
                @"C:\Program Files\Steam\steamapps\workshop\content\2868840\3800644054\CouchCoop.Mod.dll")
            == CouchCoopModBuildIdentity.WorkshopModSource, "the Windows separator is classified the same way");
        Assert(CouchCoopModBuildIdentity.ModSourceOf("/games/Slay the Spire 2/mods/couchcoop/CouchCoop.Mod.dll")
            == CouchCoopModBuildIdentity.LocalModSource, "an install mods/ path is the local copy");

        // The Workshop test runs FIRST: a Workshop item extracted under a directory that happens to contain
        // a `mods` segment is still the Workshop copy.
        Assert(CouchCoopModBuildIdentity.ModSourceOf("/steamapps/workshop/content/2868840/1/mods/CouchCoop.Mod.dll")
            == CouchCoopModBuildIdentity.WorkshopModSource, "workshop/content wins over a nested mods segment");

        // Segment equality, not a string prefix — `mods_STEAMTEST` is a different directory the game reads
        // as a Workshop source, and mistaking it for the local one would disable the wrong row.
        Assert(CouchCoopModBuildIdentity.ModSourceOf("/games/sts2/mods_STEAMTEST/couchcoop/CouchCoop.Mod.dll") is null,
            "mods_STEAMTEST is not the mods directory and is not guessed at");
        Assert(CouchCoopModBuildIdentity.ModSourceOf("/somewhere/else/CouchCoop.Mod.dll") is null,
            "an unrecognised path is unknown rather than assumed");
        Assert(CouchCoopModBuildIdentity.ModSourceOf(null) is null, "a null path is unknown");
        Assert(CouchCoopModBuildIdentity.ModSourceOf("  ") is null, "a blank path is unknown");
    }

    private static void SeatDisablesTheCopyTheHostIsNotRunning()
    {
        // SYMMETRIC. Hardcoding "disable the Workshop row" would leave an ordinary subscriber — who has no
        // local deploy at all — with seats that load no CouchCoop whatsoever.
        Assert(HeadlessSeatModSelection.SourceToDisable(CouchCoopModBuildIdentity.LocalModSource)
            == CouchCoopModBuildIdentity.WorkshopModSource,
            "a host running the local deploy disables the seat's Workshop row");
        Assert(HeadlessSeatModSelection.SourceToDisable(CouchCoopModBuildIdentity.WorkshopModSource)
            == CouchCoopModBuildIdentity.LocalModSource,
            "a host running the Workshop build disables the seat's local row");
        Assert(HeadlessSeatModSelection.SourceToDisable(null) is null,
            "a host that cannot tell where its own mod came from pins nothing rather than guessing");
        Assert(HeadlessSeatModSelection.SourceToDisable("something_else") is null,
            "an unrecognised source pins nothing");
    }

    // ---------------------------------------------------------------------------------------------
    // The settings.save edit.
    // ---------------------------------------------------------------------------------------------

    private const string WorkshopSource = "steam_workshop";
    private const string LocalSource = "mods_directory";

    private static string Settings(string modListJson, string extra = "")
        => $$"""
        {
          "language": "eng",
          "volume_master": 0.5,{{extra}}
          "mod_settings": {
            "mod_list": {{modListJson}},
            "mods_enabled": true
          }
        }
        """;

    private static void PinDisablesAnEnabledWorkshopRow()
    {
        // The live shape: couchcoop present TWICE, once per source, with the Workshop row enabled. This is
        // exactly what a seat inherited when every one of them loaded the published build.
        var original = Settings("""
            [
              {"id": "spirectlbridge", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": true, "source": "steam_workshop"}
            ]
            """);
        var updated = HeadlessSeatModSelection.Pin(original, WorkshopSource);
        Assert(updated is not null, "an enabled Workshop row is rewritten");

        var rows = ModList(updated!);
        Assert(Enabled(rows, "couchcoop", WorkshopSource) == false, "the Workshop couchcoop row is disabled");
        Assert(Enabled(rows, "couchcoop", LocalSource) == true, "the LOCAL couchcoop row is untouched");
        Assert(Enabled(rows, "spirectlbridge", LocalSource) == true, "an unrelated mod's row is untouched");
        Assert(rows.Count == 3, "no row is added when the row already exists");
        // Order doubles as the player's manual load order.
        Assert(rows[0].GetProperty("id").GetString() == "spirectlbridge"
            && rows[2].GetProperty("source").GetString() == WorkshopSource, "row order is preserved");
    }

    private static void PinAppendsAMissingRow()
    {
        // Observed live: the host's settings.save carried NO Workshop couchcoop row at all, so there was
        // nothing to copy and nothing to flip — yet the seat still discovered and loaded that copy.
        var original = Settings("""
            [
              {"id": "spirectlbridge", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": true, "source": "mods_directory"}
            ]
            """);
        var updated = HeadlessSeatModSelection.Pin(original, WorkshopSource);
        Assert(updated is not null, "a missing Workshop row is added");

        var rows = ModList(updated!);
        Assert(rows.Count == 3, "exactly one row is appended");
        Assert(rows[2].GetProperty("id").GetString() == "couchcoop"
            && rows[2].GetProperty("source").GetString() == WorkshopSource
            && rows[2].GetProperty("is_enabled").GetBoolean() == false,
            "the appended row disables the Workshop copy");
        Assert(rows[0].GetProperty("id").GetString() == "spirectlbridge"
            && rows[1].GetProperty("id").GetString() == "couchcoop",
            "appending leaves every existing row at the index it already had");
    }

    private static void PinLeavesAnAlreadyDisabledRowAlone()
    {
        var original = Settings("""
            [
              {"id": "couchcoop", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": false, "source": "steam_workshop"}
            ]
            """);
        Assert(HeadlessSeatModSelection.Pin(original, WorkshopSource) is null,
            "an already-correct file is left byte-identical rather than rewritten on every spawn");
    }

    private static void PinPreservesEveryOtherSettingAndTheGodotJsonShape()
    {
        var original = Settings(
            """
            [
              {"id": "couchcoop", "is_enabled": true, "source": "steam_workshop"}
            ]
            """,
            extra: "\n  \"player_label\": \"Zoë — 日本語\",");
        var updated = HeadlessSeatModSelection.Pin(original, WorkshopSource);
        Assert(updated is not null, "the file is rewritten");

        using var document = JsonDocument.Parse(updated!);
        var root = document.RootElement;
        Assert(root.GetProperty("language").GetString() == "eng", "unrelated settings survive");
        Assert(root.GetProperty("volume_master").GetDouble() == 0.5, "numeric settings survive");
        Assert(root.GetProperty("mod_settings").GetProperty("mods_enabled").GetBoolean(),
            "mods_enabled is never touched — turning it off would disable every mod in the seat");

        // A rewrite of somebody else's file must not smuggle in an encoding change: the default
        // System.Text.Json encoder escapes every non-ASCII character, which would rewrite a player's
        // localized settings into an equivalent-but-different file on each spawn.
        Assert(root.GetProperty("player_label").GetString() == "Zoë — 日本語", "non-ASCII values round-trip");
        Assert(updated.Contains("Zoë — 日本語", StringComparison.Ordinal),
            "non-ASCII values are written literally, not as \\uXXXX escapes");
        Assert(!updated.EndsWith('\n'), "no trailing newline is added (the game writes none)");
        Assert(updated.Contains("\n  \"language\"", StringComparison.Ordinal),
            "two-space indentation matches what the game writes");
    }

    private static void PinRefusesToInventAModList()
    {
        // Nothing here is a mod list this code may author. The game owns discovery, and declaring the
        // surrounding object would mean declaring defaults for flags that can turn mods off entirely.
        Assert(HeadlessSeatModSelection.Pin("""{"language": "eng"}""", WorkshopSource) is null,
            "a settings file with no mod_settings is left alone");
        Assert(HeadlessSeatModSelection.Pin("""{"mod_settings": {"mods_enabled": true}}""", WorkshopSource) is null,
            "a mod_settings with no mod_list is left alone");
        Assert(HeadlessSeatModSelection.Pin("""{"mod_settings": {"mod_list": "nope"}}""", WorkshopSource) is null,
            "a mod_list that is not an array is left alone");
        // An EMPTY list is the game's own signal that this profile has never launched modded, and it
        // migrates the profile's unmodded saves on that basis. A row appended here would cancel that.
        Assert(HeadlessSeatModSelection.Pin("""{"mod_settings": {"mod_list": []}}""", WorkshopSource) is null,
            "an empty mod_list is left alone");
        Assert(HeadlessSeatModSelection.Pin("""[1, 2, 3]""", WorkshopSource) is null,
            "a settings file that is not an object is left alone");

        // A row is only APPENDED into a file that already writes `source` as a string. Writing a row in a
        // shape the file does not use risks a settings.save the game cannot deserialize — and it quarantines
        // an unreadable one wholesale, costing the seat every setting rather than just this row.
        var numericSources = Settings("""
            [
              {"id": "spirectlbridge", "is_enabled": true, "source": 1}
            ]
            """);
        Assert(HeadlessSeatModSelection.Pin(numericSources, WorkshopSource) is null,
            "no row is appended into a mod list that does not write `source` as a string");
        // …but an existing matching row is still flipped, because that row proves the shape itself.
        var mixed = Settings("""
            [
              {"id": "spirectlbridge", "is_enabled": true, "source": 1},
              {"id": "couchcoop", "is_enabled": true, "source": "steam_workshop"}
            ]
            """);
        var flipped = HeadlessSeatModSelection.Pin(mixed, WorkshopSource);
        Assert(flipped is not null && Enabled(ModList(flipped!), "couchcoop", WorkshopSource) == false,
            "an existing string-sourced row is still disabled beside rows this code does not recognise");
    }

    // ---------------------------------------------------------------------------------------------
    // …and the seeder applying it to a real slot tree.
    // ---------------------------------------------------------------------------------------------

    private static void SeedingPinsEveryProfileItCopied()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostUserDir = Path.Combine(xdg, "SlayTheSpire2");
        var slotUserDir = Path.Combine(xdg, "SlayTheSpire2", "couch-coop", "headless-slots", "slot-8", "SlayTheSpire2");

        // The host's file as the game left it: BOTH couchcoop rows enabled, which is what the host writes
        // back after startup regardless of which copy it actually loaded.
        var hostSettings = Settings("""
            [
              {"id": "couchcoop", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": true, "source": "steam_workshop"}
            ]
            """);
        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "76561198000000000"));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "76561198000000000", "settings.save"), hostSettings);
        Directory.CreateDirectory(Path.Combine(hostUserDir, "default", "1"));
        File.WriteAllText(Path.Combine(hostUserDir, "default", "1", "settings.save"), hostSettings);

        var result = HeadlessUserDirSeeder.Prepare(
            8,
            HeadlessUserDirPlatform.Linux,
            key => key == "XDG_DATA_HOME" ? xdg : null,
            _ => Path.Combine(root.Path, "home"),
            seatModSourceToDisable: WorkshopSource);

        Assert(result is not null && result.SlotUserDir == slotUserDir, "the slot is prepared");

        foreach (var profile in new[]
                 {
                     Path.Combine(slotUserDir, "steam", "76561198000000000", "settings.save"),
                     Path.Combine(slotUserDir, "default", "1", "settings.save"),
                 })
        {
            var rows = ModList(File.ReadAllText(profile));
            Assert(Enabled(rows, "couchcoop", WorkshopSource) == false,
                $"the seat's Workshop row is disabled in {profile}");
            Assert(Enabled(rows, "couchcoop", LocalSource) == true,
                $"the seat's local row still loads in {profile}");
        }

        // The HOST's own settings are the thing a seeding bug would corrupt for everyone.
        var hostRows = ModList(File.ReadAllText(Path.Combine(hostUserDir, "steam", "76561198000000000", "settings.save")));
        Assert(Enabled(hostRows, "couchcoop", WorkshopSource) == true,
            "the host's own settings.save is never edited — only the seat's copy of it");

        // And the opt-out: no source to disable means the copied mod list is left exactly as it was.
        var untouched = HeadlessUserDirSeeder.Prepare(
            9,
            HeadlessUserDirPlatform.Linux,
            key => key == "XDG_DATA_HOME" ? xdg : null,
            _ => Path.Combine(root.Path, "home"));
        Assert(untouched is not null, "a slot prepared with no pin still succeeds");
        var unpinned = ModList(File.ReadAllText(
            Path.Combine(untouched!.SlotUserDir, "steam", "76561198000000000", "settings.save")));
        Assert(Enabled(unpinned, "couchcoop", WorkshopSource) == true,
            "with no host source to carry, the seeded mod list is left exactly as copied");
    }

    // ---------------------------------------------------------------------------------------------

    private static List<JsonElement> ModList(string settingsJson)
    {
        using var document = JsonDocument.Parse(settingsJson);
        return document.RootElement.GetProperty("mod_settings").GetProperty("mod_list")
            .EnumerateArray().Select(element => element.Clone()).ToList();
    }

    private static bool? Enabled(List<JsonElement> rows, string id, string source)
    {
        foreach (var row in rows)
        {
            if (row.GetProperty("id").GetString() == id && row.GetProperty("source").GetString() == source)
                return row.GetProperty("is_enabled").GetBoolean();
        }

        return null;
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "couchcoop-seatbuild-" + Guid.NewGuid().ToString("N"));

        public TempDir() => Directory.CreateDirectory(Path);

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); } catch { }
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"SeatModBuildTests failed: {label}.");
    }
}
