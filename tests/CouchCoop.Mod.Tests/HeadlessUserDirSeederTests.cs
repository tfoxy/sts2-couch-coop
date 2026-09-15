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
        SharedCachesAreLinkedPerLeafWithoutAnAncestorCycle();
        SeedingNeverFollowsDirectorySymlinks();
        UnsupportedPlatformReturnsNull();
        MacOsDeclinesOutLoud();
    }

    private static void LinuxPolicyUsesXdgDataHome()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var result = HeadlessUserDirSeeder.Prepare(
            2,
            HeadlessUserDirPlatform.Linux,
            Env(("XDG_DATA_HOME", xdg)),
            _ => Path.Combine(root.Path, "home"));

        var expectedSlotBase = Path.Combine(xdg, "SlayTheSpire2", "couch-coop", "headless-slots", "slot-2");
        Assert(result is not null, "linux prepare succeeds");
        Assert(result!.SlotBase == expectedSlotBase, "linux slot base is under XDG_DATA_HOME/SlayTheSpire2");
        Assert(result.SlotUserDir == Path.Combine(expectedSlotBase, "SlayTheSpire2"), "linux slot user dir nests SlayTheSpire2");
        Assert(result.EnvironmentVariables.TryGetValue("XDG_DATA_HOME", out var childXdg) && childXdg == expectedSlotBase,
            "linux child gets XDG_DATA_HOME=slot base");
        Assert(Directory.Exists(Path.Combine(result.SlotUserDir, "logs")), "linux prepare creates logs dir");
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

    /// <summary>
    /// macOS declines like any unsupported platform — and, unlike before, says so. The seat is still launched
    /// (into the host's user dir), so a silent null is a limitation nobody can see: one <c>godot.log</c> and
    /// one settings/save profile for every player on the machine, with nothing in either naming the cause.
    /// </summary>
    private static void MacOsDeclinesOutLoud()
    {
        using var root = new TempDir();
        var lines = new List<string>();
        HeadlessUserDirSeeder.LogSink = lines.Add;
        try
        {
            var policy = HeadlessUserDirSeeder.ResolvePolicy(
                4,
                HeadlessUserDirPlatform.MacOs,
                Env(),
                _ => Path.Combine(root.Path, "home"));
            Assert(policy is null, "macOS has no per-slot data-root variable to offer");
            Assert(lines.Count == 1 && lines[0].Contains("MacOs", StringComparison.Ordinal)
                && lines[0].Contains("slot=4", StringComparison.Ordinal),
                "the refused policy names the platform and the slot");

            lines.Clear();
            var result = HeadlessUserDirSeeder.Prepare(
                4,
                HeadlessUserDirPlatform.MacOs,
                Env(),
                _ => Path.Combine(root.Path, "home"));
            Assert(result is null, "macOS prepare still returns null — WS1 makes it visible, it does not fix it");
            Assert(lines.Count == 2 && lines[1].Contains("shares the host's user directory", StringComparison.Ordinal),
                "the skipped seed states the consequence, not just the cause");

            // Linux is untouched: the proven path stays quiet.
            lines.Clear();
            var linux = HeadlessUserDirSeeder.Prepare(
                4,
                HeadlessUserDirPlatform.Linux,
                Env(("XDG_DATA_HOME", Path.Combine(root.Path, "xdg"))),
                _ => Path.Combine(root.Path, "home"));
            Assert(linux is not null && lines.Count == 0, "a working platform logs nothing new");
        }
        finally
        {
            HeadlessUserDirSeeder.LogSink = null;
        }
    }

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
