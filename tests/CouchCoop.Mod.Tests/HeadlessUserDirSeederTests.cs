using CouchCoop.Mod.Session;

// Pure filesystem checks for the per-headless Godot user-dir seeder. The tests inject the platform and
// environment lookup so Windows path behavior is covered without requiring a Windows test runner.
internal static class HeadlessUserDirSeederTests
{
    public static void Run()
    {
        LinuxPolicyUsesXdgDataHome();
        WindowsPolicyUsesAppData();
        SeedingOverwritesProfileFilesFromTheHost();
        SeedingPreservesLogsAndSeedsRunHistoryOnce();
        RunSavesAreNeitherSeededNorLeftBehind();
        SharedCachesAreLinkedPerLeafWithoutAnAncestorCycle();
        SeedingNeverFollowsDirectorySymlinks();
        UnsupportedPlatformReturnsNull();
        MacOsPolicyBuildsAnIsolatedFakeHomeFarm();
        MacOsRequiresHomeAndLogsTheFallback();
        UnixPolicyGivesEachSeatAShortPerHostTempDir();
        SeatTempDirAndItsSocketsFitSunPath();
        SeatTempDirIsNarrowedToOwnerOnly();
        SeatTempDirRefusesASymlinkAndKeepsTheRestOfTheIsolation();
        SeatTempDirRefusesAnotherUsersDirectory();
        UnixPathInspectionDoesNotFollowLinks();
    }

    private static void LinuxPolicyUsesXdgDataHome()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostTemp = HostTemp(root);
        var result = HeadlessUserDirSeeder.Prepare(
            2,
            HeadlessUserDirPlatform.Linux,
            Env(("XDG_DATA_HOME", xdg)),
            _ => Path.Combine(root.Path, "home"),
            hostTempPath: hostTemp);

        var expectedSlotBase = Path.Combine(xdg, "SlayTheSpire2", "couch-coop", "headless-slots", "slot-2");
        var expectedTemp = HeadlessUserDirSeeder.SeatTempDir(hostTemp, Path.Combine(xdg, "SlayTheSpire2"), 2);
        Assert(result is not null, "linux prepare succeeds");
        Assert(result!.SlotBase == expectedSlotBase, "linux slot base is under XDG_DATA_HOME/SlayTheSpire2");
        Assert(result.SlotUserDir == Path.Combine(expectedSlotBase, "SlayTheSpire2"), "linux slot user dir nests SlayTheSpire2");
        Assert(result.EnvironmentVariables.TryGetValue("XDG_DATA_HOME", out var childXdg) && childXdg == expectedSlotBase,
            "linux child gets XDG_DATA_HOME=slot base");
        // Two since the seat got its own temp dir: the same isolation Windows has through TEMP/TMP.
        Assert(result.EnvironmentVariables.Count == 2
               && result.EnvironmentVariables.TryGetValue("TMPDIR", out var childTemp)
               && expectedTemp is not null && childTemp == expectedTemp,
            "linux child environment is exactly XDG_DATA_HOME and its own TMPDIR");
        Assert(Directory.Exists(Path.Combine(result.SlotUserDir, "logs")), "linux prepare creates logs dir");
        AssertOwnerOnlyDirectory(expectedTemp!, "linux prepare creates the seat temp dir owner-only");
    }

    private static void WindowsPolicyUsesAppData()
    {
        using var root = new TempDir();
        var appData = Path.Combine(root.Path, "Roaming");
        var result = HeadlessUserDirSeeder.Prepare(
            3,
            HeadlessUserDirPlatform.Windows,
            Env(("APPDATA", appData)),
            folder => folder == Environment.SpecialFolder.ApplicationData ? appData : Path.Combine(root.Path, "unused"));

        var expectedSlotBase = Path.Combine(appData, "SlayTheSpire2", "couch-coop", "headless-slots", "slot-3");
        Assert(result is not null, "windows prepare succeeds");
        Assert(result!.SlotBase == expectedSlotBase, "windows slot base is under APPDATA/SlayTheSpire2");
        Assert(result.SlotUserDir == Path.Combine(expectedSlotBase, "SlayTheSpire2"), "windows slot user dir nests SlayTheSpire2");
        Assert(result.EnvironmentVariables.TryGetValue("APPDATA", out var childAppData) && childAppData == expectedSlotBase,
            "windows child gets APPDATA=slot base");
        Assert(result.EnvironmentVariables.TryGetValue("LOCALAPPDATA", out var childLocalAppData)
               && childLocalAppData == Path.Combine(expectedSlotBase, "LocalAppData"),
            "windows child gets LOCALAPPDATA beside slot base");
        var expectedTemp = Path.Combine(expectedSlotBase, "Temp");
        Assert(result.EnvironmentVariables.TryGetValue("TEMP", out var childTemp) && childTemp == expectedTemp
               && result.EnvironmentVariables.TryGetValue("TMP", out var childTmp) && childTmp == expectedTemp,
            "windows child gets its own TEMP and TMP under the slot base, not the host's temp dir");
        Assert(result.EnvironmentVariables.ContainsKey("tmp") && result.EnvironmentVariables.ContainsKey("Temp"),
            "windows temp variables match the parent's spelling case-insensitively");
        Assert(Directory.Exists(expectedTemp), "windows prepare creates the seat temp dir");
        Assert(!result.EnvironmentVariables.ContainsKey("XDG_DATA_HOME"), "windows child does not get XDG_DATA_HOME");
        Assert(Directory.Exists(Path.Combine(result.SlotUserDir, "logs")), "windows prepare creates logs dir");
    }

    // Every spawn re-seeds from the host, so a host settings change (language / fps / fast mode) reaches the next
    // headless instance instead of the slot staying frozen on whatever it was first seeded with.
    private static void SeedingOverwritesProfileFilesFromTheHost()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostUserDir = Path.Combine(xdg, "SlayTheSpire2");
        var slotUserDir = SlotUserDir(xdg, 4);

        Directory.CreateDirectory(Path.Combine(hostUserDir, "default"));
        File.WriteAllText(Path.Combine(hostUserDir, "default", "settings.save"), "host-default");

        Directory.CreateDirectory(Path.Combine(hostUserDir, "mod_configs"));
        File.WriteAllText(Path.Combine(hostUserDir, "mod_configs", "couchcoop.json"), "host-config");

        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "123"));
        // language + fps live here...
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "settings.save"), "host-steam");
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "settings.save.spirectl-backup-123"), "backup");
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "settings.save.VAL.corrupt"), "corrupt");
        // ...and fast mode lives here.
        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "123", "modded", "profile2", "saves"));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "modded", "profile2", "saves", "prefs.save"), "host-fast");

        Directory.CreateDirectory(Path.Combine(slotUserDir, "steam", "123", "modded", "profile2", "saves"));
        File.WriteAllText(Path.Combine(slotUserDir, "steam", "123", "settings.save"), "slot-steam");
        File.WriteAllText(Path.Combine(slotUserDir, "steam", "123", "modded", "profile2", "saves", "prefs.save"), "slot-normal");
        // A file the slot owns that the host does not have is left alone (only host files are re-copied).
        File.WriteAllText(Path.Combine(slotUserDir, "steam", "123", "console_history.log"), "slot-only");

        var result = HeadlessUserDirSeeder.Prepare(
            4,
            HeadlessUserDirPlatform.Linux,
            Env(("XDG_DATA_HOME", xdg)),
            _ => Path.Combine(root.Path, "home"));

        Assert(result is not null, "seed prepare succeeds");
        Assert(result!.SlotUserDir == slotUserDir, "slot user dir is nested under couch-coop/headless-slots");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "default", "settings.save")) == "host-default",
            "default settings are copied");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "mod_configs", "couchcoop.json")) == "host-config",
            "mod config is copied");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "steam", "123", "settings.save")) == "host-steam",
            "existing slot profile IS overwritten from the host (language/fps propagate)");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "steam", "123", "modded", "profile2", "saves", "prefs.save")) == "host-fast",
            "modded profile prefs are overwritten from the host (fast mode propagates)");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "steam", "123", "console_history.log")) == "slot-only",
            "slot-only files outside the host tree are preserved");
        Assert(!File.Exists(Path.Combine(slotUserDir, "steam", "123", "settings.save.spirectl-backup-123")),
            "spirectl backup files are skipped");
        Assert(!File.Exists(Path.Combine(slotUserDir, "steam", "123", "settings.save.VAL.corrupt")),
            "quarantined *.VAL.corrupt files are skipped");
    }

    // logs/ is the entire reason per-slot dirs exist, and run history is bulky + settings-free so it is seeded
    // once and never re-copied.
    private static void SeedingPreservesLogsAndSeedsRunHistoryOnce()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostUserDir = Path.Combine(xdg, "SlayTheSpire2");
        var slotUserDir = SlotUserDir(xdg, 5);
        var historyDir = Path.Combine("steam", "123", "profile2", "saves", "history");

        Directory.CreateDirectory(Path.Combine(hostUserDir, historyDir));
        File.WriteAllText(Path.Combine(hostUserDir, historyDir, "run-1.save"), "host-run-1");
        File.WriteAllText(Path.Combine(hostUserDir, historyDir, "run-2.save"), "host-run-2");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "123"));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "settings.save"), "host-steam");

        // Pretend a previous launch already ran in this slot: it has a log and its own history file.
        Directory.CreateDirectory(Path.Combine(slotUserDir, "logs"));
        File.WriteAllText(Path.Combine(slotUserDir, "logs", "godot.log"), "previous run");
        Directory.CreateDirectory(Path.Combine(slotUserDir, historyDir));
        File.WriteAllText(Path.Combine(slotUserDir, historyDir, "run-1.save"), "slot-run-1");

        var result = HeadlessUserDirSeeder.Prepare(
            5,
            HeadlessUserDirPlatform.Linux,
            Env(("XDG_DATA_HOME", xdg)),
            _ => Path.Combine(root.Path, "home"));

        Assert(result is not null, "history seed prepare succeeds");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "logs", "godot.log")) == "previous run",
            "re-seed preserves the slot's logs dir");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, historyDir, "run-1.save")) == "slot-run-1",
            "existing run-history files are not re-copied");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, historyDir, "run-2.save")) == "host-run-2",
            "missing run-history files are still seeded (profile stays complete, no Steam cloud sync)");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "steam", "123", "settings.save")) == "host-steam",
            "settings beside history still overwrite");
    }

    // An in-progress run save is state bound to the players it was created for, not configuration: a seat that
    // inherits the host's copy validates it, rejects it, and quarantines it in the player's profile. So it is
    // never copied — AND it is pruned from a slot an older build of this seeder already put one in, which is the
    // half that actually clears the field (CopySeedTree only ever adds and overwrites). Everything else the
    // profile carries — settings, prefs, progress, run history — must still seed exactly as before.
    private static void RunSavesAreNeitherSeededNorLeftBehind()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostUserDir = Path.Combine(xdg, "SlayTheSpire2");
        var slotUserDir = SlotUserDir(xdg, 8);
        var savesDir = Path.Combine("steam", "123", "modded", "profile1", "saves");
        var historyDir = Path.Combine(savesDir, "history");

        Directory.CreateDirectory(Path.Combine(hostUserDir, historyDir));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "settings.save"), "host-settings");
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "prefs.save"), "host-prefs");
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "progress.save"), "host-progress");
        File.WriteAllText(Path.Combine(hostUserDir, historyDir, "run-9.save"), "host-run-9");
        // The host's LIVE run, in every shape it appears in a profile.
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "current_run.save"), "host-live-run");
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "current_run.save.backup"), "host-live-run-backup");
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "current_run_mp.save"), "host-live-mp-run");
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "current_run_mp.save.backup"), "host-live-mp-backup");

        // …and a slot that an older build of this seeder already seeded, including a quarantine the seat made
        // out of one of them. None of these have a host counterpart any more, so only a prune can remove them.
        Directory.CreateDirectory(Path.Combine(slotUserDir, savesDir));
        File.WriteAllText(Path.Combine(slotUserDir, savesDir, "current_run.save"), "stale-slot-run");
        File.WriteAllText(Path.Combine(slotUserDir, savesDir, "current_run_mp.save"), "stale-slot-mp-run");
        File.WriteAllText(Path.Combine(slotUserDir, savesDir, "current_run_mp.save.backup"), "stale-slot-mp-backup");
        File.WriteAllText(Path.Combine(slotUserDir, savesDir, "current_run_mp.1789519058.VAL.corrupt"), "quarantined");

        var result = HeadlessUserDirSeeder.Prepare(
            8,
            HeadlessUserDirPlatform.Linux,
            Env(("XDG_DATA_HOME", xdg)),
            _ => Path.Combine(root.Path, "home"));

        Assert(result is not null, "run-save prepare succeeds");
        Assert(result!.SlotUserDir == slotUserDir, "run-save slot user dir resolves as usual");

        foreach (var name in new[]
                 {
                     "current_run.save", "current_run.save.backup",
                     "current_run_mp.save", "current_run_mp.save.backup",
                     "current_run_mp.1789519058.VAL.corrupt",
                 })
        {
            Assert(!File.Exists(Path.Combine(slotUserDir, savesDir, name)),
                $"no run save reaches or survives in a slot ({name})");
        }

        // The host keeps its own, untouched — the prune walks the SLOT tree only.
        Assert(File.ReadAllText(Path.Combine(hostUserDir, savesDir, "current_run.save")) == "host-live-run",
            "the host's live run save is not touched by seeding");
        Assert(File.ReadAllText(Path.Combine(hostUserDir, savesDir, "current_run_mp.save")) == "host-live-mp-run",
            "the host's live multiplayer run save is not touched by seeding");

        // Everything the seat genuinely inherits still arrives.
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "steam", "123", "settings.save")) == "host-settings",
            "settings.save still seeds (language / fps)");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, savesDir, "prefs.save")) == "host-prefs",
            "prefs.save still seeds (fast mode)");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, savesDir, "progress.save")) == "host-progress",
            "progress.save still seeds");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, historyDir, "run-9.save")) == "host-run-9",
            "saves/history/ still seeds");

        // The prefix rule itself, including the two shapes the filesystem leg above does not stage: a `.FUT`
        // quarantine (which the seeder's separate `.VAL.corrupt` marker does NOT match) and the names that must
        // keep seeding. A rule this short is worth pinning directly — it is the whole definition of the family.
        foreach (var runSave in new[]
                 {
                     "current_run.save", "current_run.save.backup", "current_run_mp.save",
                     "current_run_mp.save.backup", "current_run_mp.1789519058.VAL.corrupt",
                     "current_run.1788707420.FUT.corrupt", "current_run_mp.save.1777029871.VAL.corrupt",
                 })
        {
            Assert(HeadlessUserDirSeeder.IsRunSaveFile(runSave), $"{runSave} is a run save");
        }

        foreach (var keep in new[] { "settings.save", "prefs.save", "progress.save", "profile.save", "run-9.save" })
        {
            Assert(!HeadlessUserDirSeeder.IsRunSaveFile(keep), $"{keep} is NOT a run save and keeps seeding");
        }
    }

    // The slot dirs live INSIDE couch-coop/, so linking the whole couch-coop dir would point a slot at its own
    // ancestor and make any recursive walk of the user dir infinite. Only the leaf caches are linked.
    private static void SharedCachesAreLinkedPerLeafWithoutAnAncestorCycle()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostUserDir = Path.Combine(xdg, "SlayTheSpire2");
        var slotUserDir = SlotUserDir(xdg, 6);

        Directory.CreateDirectory(Path.Combine(hostUserDir, "shader_cache"));
        File.WriteAllText(Path.Combine(hostUserDir, "shader_cache", "warm.bin"), "warm");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "vulkan"));
        // The branch-scoped cache (CouchCoopCacheRoot): a slot resolves the same branch as the host — it is the
        // same install — so one `cache` link shares every cache under it, warm.
        Directory.CreateDirectory(Path.Combine(hostUserDir, "couch-coop", "cache", "public", "assets"));
        File.WriteAllText(Path.Combine(hostUserDir, "couch-coop", "cache", "public", "assets", "cached.bin"), "asset");

        var result = HeadlessUserDirSeeder.Prepare(
            6,
            HeadlessUserDirPlatform.Linux,
            Env(("XDG_DATA_HOME", xdg)),
            _ => Path.Combine(root.Path, "home"));

        Assert(result is not null, "cache-link prepare succeeds");
        var slotCouchCoop = Path.Combine(slotUserDir, "couch-coop");
        Assert(new DirectoryInfo(slotCouchCoop).LinkTarget is null, "slot couch-coop is a real directory");
        Assert(
            new DirectoryInfo(Path.Combine(slotCouchCoop, "cache")).LinkTarget
                == Path.Combine(hostUserDir, "couch-coop", "cache"),
            "slot couch-coop/cache links to the host's shared cache leaf");
        Assert(File.ReadAllText(Path.Combine(slotCouchCoop, "cache", "public", "assets", "cached.bin")) == "asset",
            "the warm host asset cache is reachable through the leaf link");
        Assert(new DirectoryInfo(Path.Combine(slotUserDir, "shader_cache")).LinkTarget
               == Path.Combine(hostUserDir, "shader_cache"),
            "top-level game caches are still whole-dir links");
        Assert(!Directory.Exists(Path.Combine(slotUserDir, "CouchCoop")),
            "the legacy CouchCoop dir is no longer linked into a slot");

        Assert(File.Exists(Path.Combine(hostUserDir, "couch-coop", "cache", "public", "assets", "cached.bin")),
            "the host's warm cache remains intact");
        Assert(File.Exists(Path.Combine(hostUserDir, "shader_cache", "warm.bin")),
            "host shader cache contents survive seeding");
    }

    // The copy walk must never descend into a directory symlink: recursive enumeration follows reparse points
    // with no cycle detection, so a link inside the seed tree would otherwise be copied (and could loop).
    private static void SeedingNeverFollowsDirectorySymlinks()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostUserDir = Path.Combine(xdg, "SlayTheSpire2");
        var slotUserDir = SlotUserDir(xdg, 7);

        Directory.CreateDirectory(Path.Combine(hostUserDir, "couch-coop", "cache"));
        File.WriteAllText(Path.Combine(hostUserDir, "couch-coop", "cache", "huge.bin"), "warm-cache");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "123"));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "settings.save"), "host-steam");
        // A link inside the seed tree pointing at the shared cache (and one pointing at its own ancestor).
        Directory.CreateSymbolicLink(
            Path.Combine(hostUserDir, "steam", "123", "cache-link"),
            Path.Combine(hostUserDir, "couch-coop", "cache"));
        Directory.CreateSymbolicLink(
            Path.Combine(hostUserDir, "steam", "loop"),
            Path.Combine(hostUserDir, "steam"));

        var result = HeadlessUserDirSeeder.Prepare(
            7,
            HeadlessUserDirPlatform.Linux,
            Env(("XDG_DATA_HOME", xdg)),
            _ => Path.Combine(root.Path, "home"));

        Assert(result is not null, "symlink-in-seed-tree prepare succeeds");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "steam", "123", "settings.save")) == "host-steam",
            "real seed files are still copied past a sibling symlink");
        Assert(!Directory.Exists(Path.Combine(slotUserDir, "steam", "123", "cache-link")),
            "a directory symlink inside the seed tree is not followed or reproduced");
        Assert(!Directory.Exists(Path.Combine(slotUserDir, "steam", "loop")),
            "a self-referential symlink inside the seed tree is not followed");
        Assert(File.ReadAllText(Path.Combine(hostUserDir, "couch-coop", "cache", "huge.bin")) == "warm-cache",
            "the host's shared cache is untouched by seeding");
    }

    private static string SlotUserDir(string xdg, int slot)
        => Path.Combine(xdg, "SlayTheSpire2", "couch-coop", "headless-slots", $"slot-{slot}", "SlayTheSpire2");

    private static void UnsupportedPlatformReturnsNull()
    {
        using var root = new TempDir();
        var result = HeadlessUserDirSeeder.Prepare(
            2,
            HeadlessUserDirPlatform.Unsupported,
            Env(),
            _ => Path.Combine(root.Path, "home"));
        Assert(result is null, "unsupported platform returns null");
    }

    private static void MacOsPolicyBuildsAnIsolatedFakeHomeFarm()
    {
        using var root = new TempDir();
        var home = Path.Combine(root.Path, "home");
        var hostUserDir = Path.Combine(home, "Library", "Application Support", "SlayTheSpire2");
        var slotBase = Path.Combine(hostUserDir, "couch-coop", "headless-slots", "slot-4");
        var slotUserDir = Path.Combine(slotBase, "Library", "Application Support", "SlayTheSpire2");

        Directory.CreateDirectory(Path.Combine(home, "Desktop"));
        File.WriteAllText(Path.Combine(home, "Desktop", "host-only.txt"), "host desktop");
        Directory.CreateSymbolicLink(Path.Combine(home, "LinkedDesktop"), Path.Combine(home, "Desktop"));
        Directory.CreateSymbolicLink(Path.Combine(home, "SelfHome"), home);
        File.WriteAllText(Path.Combine(home, ".zprofile"), "host profile");
        File.WriteAllText(Path.Combine(home, "Documents.txt"), "host document");
        Directory.CreateDirectory(Path.Combine(home, "Library", "Preferences"));
        File.WriteAllText(Path.Combine(home, "Library", "Preferences", "host.pref"), "host preference");
        File.WriteAllText(Path.Combine(home, "Library", "host-library-file"), "library file");
        Directory.CreateDirectory(Path.Combine(home, "Library", "Application Support", "Steam"));
        File.WriteAllText(Path.Combine(home, "Library", "Application Support", "Steam", "steam.pid"), "steam");
        Directory.CreateDirectory(hostUserDir);
        File.WriteAllText(Path.Combine(hostUserDir, "host-only.txt"), "host user data");
        if (OperatingSystem.IsMacOS())
        {
            Assert(Directory.Exists(Path.Combine(home, "lIbRaRy")),
                "the macOS runner's APFS volume resolves case variants of an existing directory");
        }

        Assert(HeadlessUserDirSeeder.IsMacOsFakeHomeExclusion("lIbRaRy", "Library")
               && HeadlessUserDirSeeder.IsMacOsFakeHomeExclusion("aPpLiCaTiOn SuPpOrT", "Application Support")
               && HeadlessUserDirSeeder.IsMacOsFakeHomeExclusion("sLaYtHeSpIrE2", "SlayTheSpire2")
               && !HeadlessUserDirSeeder.IsMacOsFakeHomeExclusion("Steam", "SlayTheSpire2"),
            "all fake-home exclusions compare names OrdinalIgnoreCase");

        // A real entry in a slot is owned by that slot and must survive even when the real home has the same name.
        Directory.CreateDirectory(Path.Combine(slotBase, "Desktop"));
        File.WriteAllText(Path.Combine(slotBase, "Desktop", "slot-only.txt"), "slot desktop");
        File.WriteAllText(Path.Combine(slotBase, "Documents.txt"), "slot document");
        File.CreateSymbolicLink(Path.Combine(slotBase, ".zprofile"), Path.Combine(root.Path, "stale-profile"));
        Directory.CreateDirectory(SlotLibrary(slotBase));
        Directory.CreateSymbolicLink(
            Path.Combine(SlotLibrary(slotBase), "Preferences"),
            Path.Combine(root.Path, "stale-preferences"));

        var hostTemp = HostTemp(root);
        var policy = HeadlessUserDirSeeder.ResolvePolicy(
            4,
            HeadlessUserDirPlatform.MacOs,
            Env(("HOME", home)),
            _ => Path.Combine(root.Path, "unused"),
            hostTemp);
        Assert(policy is not null, "macOS policy resolves with HOME");
        Assert(policy!.HostUserDir == hostUserDir, "macOS host user dir is HOME/Library/Application Support/SlayTheSpire2");
        Assert(policy.SlotBase == slotBase, "macOS slot base remains under the host user dir");
        Assert(policy.SlotUserDir == slotUserDir, "macOS slot user dir is inside the fake home");
        Assert(policy.EnvironmentVariables.Count == 2
               && policy.EnvironmentVariables.TryGetValue("HOME", out var childHome)
               && childHome == slotBase
               && policy.EnvironmentVariables.TryGetValue("TMPDIR", out var policyTemp)
               && policyTemp == policy.SeatTempDir
               && policyTemp == HeadlessUserDirSeeder.SeatTempDir(hostTemp, hostUserDir, 4),
            "macOS child environment is exactly HOME=slot base and its own TMPDIR");

        var result = HeadlessUserDirSeeder.Prepare(
            4,
            HeadlessUserDirPlatform.MacOs,
            Env(("HOME", home)),
            _ => Path.Combine(root.Path, "unused"),
            hostTempPath: hostTemp);
        Assert(result is not null, "macOS fake-home prepare succeeds");
        Assert(result!.SlotBase == slotBase && result.SlotUserDir == slotUserDir,
            "macOS prepare returns the resolved fake-home paths");
        Assert(result.EnvironmentVariables.TryGetValue("TMPDIR", out var preparedTemp) && preparedTemp == policy.SeatTempDir,
            "macOS prepare keeps the seat's own TMPDIR beside the fake HOME");
        AssertOwnerOnlyDirectory(policy.SeatTempDir!, "macOS prepare creates the seat temp dir owner-only");
        Assert(!Directory.Exists(Path.Combine(slotBase, Path.GetFileName(policy.SeatTempDir!))),
            "the seat temp dir is not part of the fake-home farm");

        Assert(new DirectoryInfo(Path.Combine(slotBase, "Library")).LinkTarget is null,
            "fake-home Library is a real first exclusion layer");
        Assert(new DirectoryInfo(Path.Combine(slotBase, "Library", "Application Support")).LinkTarget is null,
            "fake-home Application Support is a real second exclusion layer");
        Assert(new DirectoryInfo(slotUserDir).LinkTarget is null,
            "fake-home SlayTheSpire2 is a real isolated third exclusion layer");
        Assert(new FileInfo(Path.Combine(slotBase, ".zprofile")).LinkTarget == Path.Combine(home, ".zprofile"),
            "an ordinary home file is linked and a stale file link is repaired");
        Assert(new DirectoryInfo(Path.Combine(slotBase, "Desktop")).LinkTarget is null
               && File.ReadAllText(Path.Combine(slotBase, "Desktop", "slot-only.txt")) == "slot desktop",
            "a real slot-owned directory is preserved instead of replaced by a farm link");
        Assert(new FileInfo(Path.Combine(slotBase, "Documents.txt")).LinkTarget is null
               && File.ReadAllText(Path.Combine(slotBase, "Documents.txt")) == "slot document",
            "a real slot-owned file is preserved instead of replaced by a farm link");
        Assert(new DirectoryInfo(Path.Combine(slotBase, "LinkedDesktop")).LinkTarget == Path.Combine(home, "LinkedDesktop"),
            "a source directory symlink is mirrored without being followed");
        Assert(new DirectoryInfo(Path.Combine(slotBase, "SelfHome")).LinkTarget == Path.Combine(home, "SelfHome"),
            "a self-referential home symlink is mirrored without traversal");
        Assert(new DirectoryInfo(Path.Combine(slotBase, "Library", "Preferences")).LinkTarget
               == Path.Combine(home, "Library", "Preferences"),
            "an ordinary Library directory is linked and a stale directory link is repaired");
        Assert(new FileInfo(Path.Combine(slotBase, "Library", "host-library-file")).LinkTarget
               == Path.Combine(home, "Library", "host-library-file"),
            "an ordinary Library file is linked");
        Assert(File.ReadAllText(Path.Combine(slotBase, "Library", "Application Support", "Steam", "steam.pid")) == "steam",
            "Steam remains reachable through the fake-home farm");

        File.WriteAllText(Path.Combine(slotUserDir, "slot-write.txt"), "slot write");
        Assert(File.ReadAllText(Path.Combine(slotUserDir, "slot-write.txt")) == "slot write"
               && !File.Exists(Path.Combine(hostUserDir, "slot-write.txt")),
            "writes under isolated SlayTheSpire2 do not reach the host profile");
        Assert(new DirectoryInfo(slotBase).LinkTarget is null
               && new DirectoryInfo(SlotLibrary(slotBase)).LinkTarget is null
               && !Path.GetFullPath(SlotLibrary(slotBase)).StartsWith(
                   Path.GetFullPath(slotUserDir) + Path.DirectorySeparatorChar,
                   StringComparison.Ordinal),
            "the fake-home ancestors are real rather than links back through the isolated user dir");

        var repeated = HeadlessUserDirSeeder.Prepare(
            4,
            HeadlessUserDirPlatform.MacOs,
            Env(("HOME", home)),
            _ => Path.Combine(root.Path, "unused"));
        Assert(repeated is not null
               && new FileInfo(Path.Combine(slotBase, ".zprofile")).LinkTarget == Path.Combine(home, ".zprofile"),
            "the fake-home farm is idempotent");
    }

    private static void MacOsRequiresHomeAndLogsTheFallback()
    {
        using var root = new TempDir();
        var lines = new List<string>();
        HeadlessUserDirSeeder.LogSink = lines.Add;
        try
        {
            var policy = HeadlessUserDirSeeder.ResolvePolicy(
                4,
                HeadlessUserDirPlatform.MacOs,
                Env(("HOME", "  ")),
                _ => Path.Combine(root.Path, "unused"));
            Assert(policy is null && lines.Count == 1 && lines[0].Contains("HOME resolved empty", StringComparison.Ordinal),
                "macOS refuses a blank HOME and logs why");

            lines.Clear();
            var result = HeadlessUserDirSeeder.Prepare(
                4,
                HeadlessUserDirPlatform.MacOs,
                Env(),
                _ => Path.Combine(root.Path, "unused"));
            Assert(result is null && lines.Count == 2
                   && lines[0].Contains("HOME resolved empty", StringComparison.Ordinal)
                   && lines[1].Contains("shares the host's user directory", StringComparison.Ordinal),
                "a failed macOS farm reaches the existing visible shared-profile fallback");
        }
        finally
        {
            HeadlessUserDirSeeder.LogSink = null;
        }
    }

    private static void UnixPolicyGivesEachSeatAShortPerHostTempDir()
    {
        var linux = HeadlessUserDirSeeder.ResolvePolicy(
            3, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", "/home/alice/.local/share")), _ => "/unused", "/tmp/")!;
        var instance = HeadlessUserDirSeeder.HostInstanceId("/home/alice/.local/share/SlayTheSpire2");
        Assert(instance is { Length: 12 }, "the host instance id is 12 hex digits");
        Assert(linux.SeatTempDir == "/tmp/cc" + instance![..6] + "3"
               && linux.EnvironmentVariables["TMPDIR"] == linux.SeatTempDir,
            "a linux seat's TMPDIR is <host temp>/cc<6 hex of the host instance><slot>");
        Assert(System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(linux.SeatTempDir!), "^cc[0-9a-f]{6}3$"),
            "the seat temp dir name is short, lowercase hex and slot-suffixed");

        var otherHost = HeadlessUserDirSeeder.ResolvePolicy(
            3, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", "/srv/qa/xdg")), _ => "/unused", "/tmp/");
        var otherSlot = HeadlessUserDirSeeder.ResolvePolicy(
            4, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", "/home/alice/.local/share")), _ => "/unused", "/tmp/");
        Assert(otherHost?.SeatTempDir is { } a && a != linux.SeatTempDir
               && otherSlot?.SeatTempDir is { } b && b != linux.SeatTempDir,
            "two hosts on one machine, and two slots of one host, never share a seat temp dir");

        var macTemp = "/var/folders/qh/" + new string('x', 30) + "/T/";
        var mac = HeadlessUserDirSeeder.ResolvePolicy(
            2, HeadlessUserDirPlatform.MacOs, Env(("HOME", "/Users/alice")), _ => "/unused", macTemp);
        Assert(mac?.SeatTempDir is { } macSeat && macSeat.StartsWith(macTemp + "cc", StringComparison.Ordinal)
               && mac.EnvironmentVariables["TMPDIR"] == macSeat && mac.EnvironmentVariables.ContainsKey("HOME"),
            "a macOS seat's TMPDIR sits in the host's per-user temp dir, beside its fake HOME");

        var windows = HeadlessUserDirSeeder.ResolvePolicy(
            2, HeadlessUserDirPlatform.Windows, Env(("APPDATA", @"C:\Users\a\AppData\Roaming")), _ => "/unused", @"C:\Temp\");
        Assert(windows is not null && windows.SeatTempDir is null && !windows.EnvironmentVariables.ContainsKey("TMPDIR"),
            "windows keeps its own TEMP/TMP isolation and gets no TMPDIR");

        var noHostTemp = HeadlessUserDirSeeder.ResolvePolicy(
            2, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", "/home/alice/.local/share")), _ => "/unused");
        var relativeHostTemp = HeadlessUserDirSeeder.ResolvePolicy(
            2, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", "/home/alice/.local/share")), _ => "/unused", "tmp/");
        Assert(noHostTemp is { SeatTempDir: null } && !noHostTemp.EnvironmentVariables.ContainsKey("TMPDIR")
               && relativeHostTemp is { SeatTempDir: null },
            "without a rooted host temp dir the seat keeps the host's");
    }

    private static void SeatTempDirAndItsSocketsFitSunPath()
    {
        // A representative macOS per-user temp dir (/var/folders/<2>/<30>/T/) and Linux's /tmp/, at the highest
        // slot two digits allow. The runtime's diagnostics socket is the longest thing created inside it.
        var cases = new[]
        {
            (HeadlessUserDirPlatform.MacOs, Env(("HOME", "/Users/alice")), "/var/folders/qh/" + new string('x', 30) + "/T/"),
            (HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", "/home/alice/.local/share")), "/tmp/"),
        };
        foreach (var (platform, env, hostTemp) in cases)
        {
            foreach (var slot in new[] { 2, 99 })
            {
                var seatTemp = HeadlessUserDirSeeder.ResolvePolicy(slot, platform, env, _ => "/unused", hostTemp)!.SeatTempDir!;
                var socket = seatTemp + "/" + new string('d', HeadlessUserDirSeeder.DiagnosticsSocketNameBytes(platform));
                Assert(System.Text.Encoding.UTF8.GetByteCount(socket) <= HeadlessUserDirSeeder.MaxUnixSocketPathBytes,
                    $"{platform} slot {slot}: the diagnostics socket in {seatTemp} fits sun_path");
            }
        }

        Assert($"dotnet-diagnostic-{99998}-{1760000000}-socket".Length
                   == HeadlessUserDirSeeder.DiagnosticsSocketNameBytes(HeadlessUserDirPlatform.MacOs)
               && $"dotnet-diagnostic-{4194304}-{9999999999}-socket".Length
                   == HeadlessUserDirSeeder.DiagnosticsSocketNameBytes(HeadlessUserDirPlatform.Linux),
            "the diagnostics socket budget matches the runtime's longest names");
    }

    private static void SeatTempDirIsNarrowedToOwnerOnly()
    {
        if (OperatingSystem.IsWindows()) return;
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostTemp = HostTemp(root);
        var seatTemp = HeadlessUserDirSeeder.SeatTempDir(hostTemp, Path.Combine(xdg, "SlayTheSpire2"), 2)!;
        Directory.CreateDirectory(seatTemp);
        File.SetUnixFileMode(seatTemp, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        File.WriteAllText(Path.Combine(seatTemp, "left-by-a-previous-seat"), "x");

        var result = HeadlessUserDirSeeder.Prepare(
            2, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", xdg)), _ => "/unused", hostTempPath: hostTemp);
        Assert(result?.EnvironmentVariables.TryGetValue("TMPDIR", out var childTemp) == true && childTemp == seatTemp,
            "an existing seat temp dir of ours is reused");
        AssertOwnerOnlyDirectory(seatTemp, "a reused seat temp dir is narrowed to owner-only");
        Assert(File.Exists(Path.Combine(seatTemp, "left-by-a-previous-seat")), "reusing the seat temp dir does not empty it");
    }

    private static void SeatTempDirRefusesASymlinkAndKeepsTheRestOfTheIsolation()
    {
        if (OperatingSystem.IsWindows()) return;
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostTemp = HostTemp(root);
        var seatTemp = HeadlessUserDirSeeder.SeatTempDir(hostTemp, Path.Combine(xdg, "SlayTheSpire2"), 2)!;
        var elsewhere = Path.Combine(root.Path, "elsewhere");
        Directory.CreateDirectory(elsewhere);
        var openMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;
        File.SetUnixFileMode(elsewhere, openMode);
        Directory.CreateSymbolicLink(seatTemp, elsewhere);

        var (result, lines) = PrepareCapturingLog(() => HeadlessUserDirSeeder.Prepare(
            2, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", xdg)), _ => "/unused", hostTempPath: hostTemp));
        Assert(result is not null && result.EnvironmentVariables.ContainsKey("XDG_DATA_HOME")
               && !result.EnvironmentVariables.ContainsKey("TMPDIR"),
            "a symlink at the seat temp dir drops TMPDIR only; the user-dir isolation stays");
        Assert(lines.Count == 1 && lines[0].Contains("seat temp dir refused", StringComparison.Ordinal)
               && lines[0].Contains("symbolic link", StringComparison.Ordinal),
            "the refusal is one visible line naming the reason");
        Assert(new DirectoryInfo(seatTemp).LinkTarget == elsewhere && File.GetUnixFileMode(elsewhere) == openMode,
            "the link is left alone and its target is never chmod-ed through it");

        Directory.Delete(seatTemp);
        File.WriteAllText(seatTemp, "not a directory");
        var (fileResult, fileLines) = PrepareCapturingLog(() => HeadlessUserDirSeeder.Prepare(
            2, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", xdg)), _ => "/unused", hostTempPath: hostTemp));
        Assert(fileResult is not null && !fileResult.EnvironmentVariables.ContainsKey("TMPDIR")
               && fileLines.Count == 1 && fileLines[0].Contains("not a directory", StringComparison.Ordinal),
            "a plain file at the seat temp dir is refused the same way");
    }

    private static void SeatTempDirRefusesAnotherUsersDirectory()
    {
        if (OperatingSystem.IsWindows()) return;
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostTemp = HostTemp(root);
        var seatTemp = HeadlessUserDirSeeder.SeatTempDir(hostTemp, Path.Combine(xdg, "SlayTheSpire2"), 2)!;
        // A directory another user owns cannot be made without root; the inspector stands in for one.
        var inspected = new List<string>();
        var (result, lines) = PrepareCapturingLog(() => HeadlessUserDirSeeder.Prepare(
            2, HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", xdg)), _ => "/unused", hostTempPath: hostTemp,
            inspectTempDir: path =>
            {
                inspected.Add(path);
                return new UnixPathStatus(Exists: true, IsSymbolicLink: false, IsDirectory: true,
                    OwnedByCurrentUser: false, Mode: 0x41C0);
            }));
        Assert(inspected.SequenceEqual([seatTemp]), "only the seat temp dir is inspected");
        Assert(result is not null && result.EnvironmentVariables.ContainsKey("XDG_DATA_HOME")
               && !result.EnvironmentVariables.ContainsKey("TMPDIR"),
            "another user's directory at the seat temp dir drops TMPDIR only");
        Assert(lines.Count == 1 && lines[0].Contains("owned by another user", StringComparison.Ordinal),
            "the foreign-owner refusal is one visible line");
        Assert(!Directory.Exists(seatTemp), "nothing is created in place of a refused seat temp dir");
    }

    private static void UnixPathInspectionDoesNotFollowLinks()
    {
        if (OperatingSystem.IsWindows()) return;
        using var root = new TempDir();
        var dir = Path.Combine(root.Path, "dir");
        Directory.CreateDirectory(dir);
        var link = Path.Combine(root.Path, "link");
        Directory.CreateSymbolicLink(link, dir);

        var real = HeadlessUserDirSeeder.InspectUnixPath(dir);
        var linked = HeadlessUserDirSeeder.InspectUnixPath(link);
        var dangling = Path.Combine(root.Path, "dangling");
        Directory.CreateSymbolicLink(dangling, Path.Combine(root.Path, "missing"));
        var missing = HeadlessUserDirSeeder.InspectUnixPath(Path.Combine(root.Path, "missing"));
        Assert(real is { Exists: true, IsDirectory: true, IsSymbolicLink: false, OwnedByCurrentUser: true }
               && (real.Mode & 0x1FF) == (int)File.GetUnixFileMode(dir),
            "a directory of ours reads as ours, with its permission bits");
        Assert(linked is { Exists: true, IsSymbolicLink: true, IsDirectory: false },
            "a link to a directory reads as a link, not as its target");
        Assert(HeadlessUserDirSeeder.InspectUnixPath(dangling) is { Exists: true, IsSymbolicLink: true }
               && missing is { Exists: false },
            "a dangling link exists; a missing path does not");
    }

    private static (HeadlessUserDirPrepareResult? Result, List<string> Lines) PrepareCapturingLog(
        Func<HeadlessUserDirPrepareResult?> prepare)
    {
        var lines = new List<string>();
        HeadlessUserDirSeeder.LogSink = lines.Add;
        try
        {
            return (prepare(), lines);
        }
        finally
        {
            HeadlessUserDirSeeder.LogSink = null;
        }
    }

    // The host temp dir a test hands the seeder: inside its own fixture, so nothing lands in the real /tmp.
    private static string HostTemp(TempDir root)
    {
        var hostTemp = Path.Combine(root.Path, "t") + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(hostTemp);
        return hostTemp;
    }

    private static void AssertOwnerOnlyDirectory(string path, string label)
    {
        if (OperatingSystem.IsWindows()) return;
        Assert(new DirectoryInfo(path) is { Exists: true, LinkTarget: null }
               && File.GetUnixFileMode(path) == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute),
            label);
    }

    private static string SlotLibrary(string slotBase) => Path.Combine(slotBase, "Library");

    private static Func<string, string?> Env(params (string Key, string Value)[] values)
    {
        var map = values.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        return key => map.TryGetValue(key, out var value) ? value : null;
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-tests-" + Guid.NewGuid().ToString("N"));

        public TempDir()
        {
            Directory.CreateDirectory(Path);
        }

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); } catch { }
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"HeadlessUserDirSeederTests failed: {label}.");
        }
    }
}
