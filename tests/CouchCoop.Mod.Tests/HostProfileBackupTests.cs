using CouchCoop.Mod.Session;

// The host's pre-spawn copy of its OWN save profile — the safety net behind SeatCloudSaveIsolationPatch, for the
// case where a seat never loads our code and no in-seat defence can run at all. Pure filesystem against temp
// roots: no game, no Steam, no Godot (every path is injected, the clock included).
internal static class HostProfileBackupTests
{
    public static void Run()
    {
        // FIRST, because the "once per host process" latch is process-global and this is its only caller.
        ASecondSpawnInTheSameProcessTakesNoSecondBackup();
        TheHostUserDirResolvesWithoutASlotAndWithoutASeatShapedLogLine();
        TheBackupLandsOutsideEverySeedDirectory();
        ProgressAndHistoryAreCopiedAndRunSavesAreNot();
        AQuarantinedProgressSaveIsKeptAndAQuarantinedRunSaveIsNot();
        RetentionKeepsTheNewestAndDropsTheOldest();
        AnOversizeProfileIsSkippedRatherThanHalfCopied();
        DirectorySymlinksInsideTheProfileAreNotDescendedInto();
        TheBackupCanBeTurnedOff();
    }

    // The backup runs BEFORE a slot has been chosen and off the manager's lock, so it resolves the host's user
    // dir on its own. That resolver shares the platform switch with ResolvePolicy (one place to get the two
    // platforms nobody here can run right) and must stay SILENT: a "slot=… isolation unavailable" line from a
    // path that has no slot would read as a seat problem.
    private static void TheHostUserDirResolvesWithoutASlotAndWithoutASeatShapedLogLine()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var appData = Path.Combine(root.Path, "Roaming");
        var home = Path.Combine(root.Path, "home");

        var lines = new List<string>();
        HeadlessUserDirSeeder.LogSink = lines.Add;
        try
        {
            Assert(
                HeadlessUserDirSeeder.ResolveHostUserDir(
                    HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", xdg)), _ => home)
                    == Path.Combine(xdg, "SlayTheSpire2"),
                "linux host user dir is XDG_DATA_HOME/SlayTheSpire2");
            Assert(
                HeadlessUserDirSeeder.ResolveHostUserDir(
                    HeadlessUserDirPlatform.Windows, Env(("APPDATA", appData)), _ => home)
                    == Path.Combine(appData, "SlayTheSpire2"),
                "windows host user dir is APPDATA/SlayTheSpire2");
            Assert(
                HeadlessUserDirSeeder.ResolveHostUserDir(
                    HeadlessUserDirPlatform.MacOs, Env(("HOME", home)), _ => home)
                    == Path.Combine(home, "Library", "Application Support", "SlayTheSpire2"),
                "macOS host user dir is HOME/Library/Application Support/SlayTheSpire2");

            // …and it agrees with the policy the seeder resolves for a slot, which is the thing it must not drift
            // from. Same input, same host dir, on every platform.
            foreach (var (platform, env) in new[]
                     {
                         (HeadlessUserDirPlatform.Linux, Env(("XDG_DATA_HOME", xdg))),
                         (HeadlessUserDirPlatform.Windows, Env(("APPDATA", appData))),
                         (HeadlessUserDirPlatform.MacOs, Env(("HOME", home))),
                     })
            {
                Assert(
                    HeadlessUserDirSeeder.ResolveHostUserDir(platform, env, _ => home)
                        == HeadlessUserDirSeeder.ResolvePolicy(3, platform, env, _ => home)?.HostUserDir,
                    $"the slot-free resolver and the slot policy agree on {platform}");
            }

            Assert(
                HeadlessUserDirSeeder.ResolveHostUserDir(
                    HeadlessUserDirPlatform.Unsupported, Env(), _ => home) is null
                && HeadlessUserDirSeeder.ResolveHostUserDir(
                    HeadlessUserDirPlatform.MacOs, Env(("HOME", "  ")), _ => home) is null,
                "a platform with no data-root lever, and a blank HOME, resolve to nothing");
            Assert(lines.Count == 0, "resolving without a slot never emits a slot-shaped refusal line");
        }
        finally
        {
            HeadlessUserDirSeeder.LogSink = null;
        }
    }

    // The whole point of the backup is that it survives what comes next. If it lived under a seed dir it would be
    // copied into every seat on every spawn — a copy of the profile INSIDE the profile, which is exactly the
    // shape the game's save store and its cloud sync are able to see.
    private static void TheBackupLandsOutsideEverySeedDirectory()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostUserDir = Path.Combine(xdg, "SlayTheSpire2");
        var savesDir = Path.Combine("steam", "123", "modded", "profile1", "saves");
        Directory.CreateDirectory(Path.Combine(hostUserDir, savesDir));
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "progress.save"), "host-progress");

        var outcome = Backup(hostUserDir, Stamp(1));
        Assert(outcome.Status == HostProfileBackupStatus.Made, "a backup is made");

        var backupsRoot = Path.Combine(hostUserDir, "couch-coop", "save-backups");
        Assert(outcome.BackupDirectory == Path.Combine(backupsRoot, "20260916T120001Z"),
            "the backup is a UTC-stamped directory under couch-coop/save-backups");
        foreach (var seedDir in HeadlessUserDirSeeder.SeedCopyDirNames)
        {
            Assert(!string.Equals(seedDir, "couch-coop", StringComparison.Ordinal)
                   && !string.Equals(seedDir, HostProfileBackup.BackupsDirName, StringComparison.Ordinal),
                $"the seed dir '{seedDir}' is not the backup's own root (a seat would copy it)");
            Assert(!Directory.Exists(Path.Combine(hostUserDir, seedDir, HostProfileBackup.BackupsDirName)),
                $"no backup directory appears inside the seed dir '{seedDir}'");
        }

        // …and prove it end to end: seed a real slot from this host and look for the backup anywhere in it.
        var prepared = HeadlessUserDirSeeder.Prepare(
            11,
            HeadlessUserDirPlatform.Linux,
            Env(("XDG_DATA_HOME", xdg)),
            _ => Path.Combine(root.Path, "home"));
        Assert(prepared is not null, "the slot prepare after a backup succeeds");
        Assert(File.ReadAllText(Path.Combine(prepared!.SlotUserDir, savesDir, "progress.save")) == "host-progress",
            "the slot is still seeded normally");
        Assert(FindEntry(prepared.SlotUserDir, HostProfileBackup.BackupsDirName) is null,
            "no seat ever receives a copy of the host's save backups");
    }

    // What a backup is FOR: the progression files, and nothing that is merely the state of a game in progress.
    private static void ProgressAndHistoryAreCopiedAndRunSavesAreNot()
    {
        using var root = new TempDir();
        var hostUserDir = Path.Combine(root.Path, "SlayTheSpire2");
        var savesDir = Path.Combine("steam", "123", "modded", "profile1", "saves");
        var historyDir = Path.Combine(savesDir, "history");
        Directory.CreateDirectory(Path.Combine(hostUserDir, historyDir));

        var kept = new (string Path, string Content)[]
        {
            (Path.Combine("steam", "123", "settings.save"), "host-settings"),
            (Path.Combine("steam", "123", "profile.save"), "host-which-profile"),
            (Path.Combine(savesDir, "prefs.save"), "host-prefs"),
            (Path.Combine(savesDir, "progress.save"), "host-progress"),
            (Path.Combine(historyDir, "run-9.save"), "host-run-9"),
        };
        foreach (var (path, content) in kept)
        {
            File.WriteAllText(Path.Combine(hostUserDir, path), content);
        }

        var dropped = new[]
        {
            Path.Combine(savesDir, "current_run.save"),
            Path.Combine(savesDir, "current_run.save.backup"),
            Path.Combine(savesDir, "current_run_mp.save"),
            Path.Combine(savesDir, "current_run_mp.1789519058.VAL.corrupt"),
            Path.Combine("steam", "123", "settings.save.spirectl-backup-123"),
        };
        foreach (var path in dropped)
        {
            File.WriteAllText(Path.Combine(hostUserDir, path), "not-worth-backing-up");
        }

        // default/ is carried too — the seeder seeds it, and it costs nothing under the cap.
        Directory.CreateDirectory(Path.Combine(hostUserDir, "default"));
        File.WriteAllText(Path.Combine(hostUserDir, "default", "settings.save"), "default-settings");
        // Neither of these is the player's progression, and neither is copied.
        Directory.CreateDirectory(Path.Combine(hostUserDir, "mod_configs"));
        File.WriteAllText(Path.Combine(hostUserDir, "mod_configs", "someothermod.json"), "other mod config");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "logs"));
        File.WriteAllText(Path.Combine(hostUserDir, "logs", "godot.log"), "host log");

        var outcome = Backup(hostUserDir, Stamp(2));
        Assert(outcome.Status == HostProfileBackupStatus.Made && outcome.FailedFiles == 0,
            "the profile backup completes");

        var backup = outcome.BackupDirectory!;
        foreach (var (path, content) in kept)
        {
            Assert(File.Exists(Path.Combine(backup, path)) && File.ReadAllText(Path.Combine(backup, path)) == content,
                $"{path} is backed up at its own relative path (the recovery page's instructions still apply)");
        }

        foreach (var path in dropped)
        {
            Assert(!File.Exists(Path.Combine(backup, path)),
                $"{path} is a disposable run save or profile cruft and is not backed up");
        }

        Assert(File.ReadAllText(Path.Combine(backup, "default", "settings.save")) == "default-settings",
            "default/ is backed up alongside steam/, as the seeder seeds both");
        Assert(!Directory.Exists(Path.Combine(backup, "mod_configs"))
               && !Directory.Exists(Path.Combine(backup, "logs")),
            "other mods' configs and the logs are not the progression and are not backed up");
        Assert(outcome.Files == kept.Length + 1, "every kept file is counted, and only those");
        Assert(outcome.Bytes == kept.Sum(file => (long)file.Content.Length) + "default-settings".Length,
            "the reported byte count is the copy");
        Assert(File.ReadAllText(Path.Combine(hostUserDir, savesDir, "current_run.save")) == "not-worth-backing-up",
            "the host's own profile is read-only to this — nothing is moved or pruned out of it");
    }

    // The one place the backup's exclusion list is SHORTER than the seeder's. The game renames a save it refuses
    // instead of deleting it, and docs/save-recovery.md tells players that file is still their save and renaming
    // it back is worth trying — so a backup that dropped it would throw away the thing the page sends them to
    // look for. The seeder must keep skipping every quarantine for the opposite reason (a seat inheriting one is
    // how a slot grows one), and a quarantined RUN save is excluded here anyway by the run-save prefix rule.
    private static void AQuarantinedProgressSaveIsKeptAndAQuarantinedRunSaveIsNot()
    {
        using var root = new TempDir();
        var hostUserDir = Path.Combine(root.Path, "SlayTheSpire2");
        var savesDir = Path.Combine("steam", "123", "modded", "profile1", "saves");
        Directory.CreateDirectory(Path.Combine(hostUserDir, savesDir));
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "progress.1789519058.VAL.corrupt"), "still-your-save");
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "current_run_mp.1789519058.VAL.corrupt"), "a dead run");
        File.WriteAllText(Path.Combine(hostUserDir, savesDir, "current_run.1788707420.FUT.corrupt"), "a dead run");

        var outcome = Backup(hostUserDir, Stamp(9));
        var backup = outcome.BackupDirectory!;
        Assert(File.ReadAllText(Path.Combine(backup, savesDir, "progress.1789519058.VAL.corrupt")) == "still-your-save",
            "a quarantined PROGRESS save is backed up — it is still the player's save");
        Assert(!File.Exists(Path.Combine(backup, savesDir, "current_run_mp.1789519058.VAL.corrupt"))
               && !File.Exists(Path.Combine(backup, savesDir, "current_run.1788707420.FUT.corrupt")),
            "a quarantined RUN save is not — the run-save rule covers its whole family");
        Assert(outcome.Files == 1, "exactly the quarantined progress save is copied");

        // The two predicates disagree about exactly one thing, and that disagreement is the point.
        Assert(!HostProfileBackup.IsExcluded("progress.1789519058.VAL.corrupt")
               && HostProfileBackup.IsExcluded("current_run_mp.1789519058.VAL.corrupt")
               && HostProfileBackup.IsExcluded("settings.save.spirectl-backup-123")
               && !HostProfileBackup.IsExcluded("progress.save"),
            "the backup skips spirectl backups and run saves, and nothing else");
        Assert(HeadlessUserDirSeeder.IsSpirectlBackupFile("settings.save.spirectl-backup-123")
               && !HeadlessUserDirSeeder.IsSpirectlBackupFile("progress.1789519058.VAL.corrupt"),
            "the shared rule is the spirectl-backup one only; the quarantine rule stays the seeder's");
    }

    // Three sessions' worth by default, oldest first out. Ordinal name order IS chronological order here, so a
    // restored or copied tree with rewritten filesystem timestamps still prunes correctly.
    private static void RetentionKeepsTheNewestAndDropsTheOldest()
    {
        using var root = new TempDir();
        var hostUserDir = Path.Combine(root.Path, "SlayTheSpire2");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "123"));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "progress.save"), "host-progress");

        var backupsRoot = Path.Combine(hostUserDir, "couch-coop", "save-backups");
        var older = new[] { "20260101T000000Z", "20260202T000000Z", "20260303T000000Z", "20260404T000000Z" };
        foreach (var name in older)
        {
            Directory.CreateDirectory(Path.Combine(backupsRoot, name));
            File.WriteAllText(Path.Combine(backupsRoot, name, "marker.txt"), name);
        }

        // Something the player put here themselves. Never a prune candidate: far likelier to be their own
        // rescued copy than anything worth deleting.
        Directory.CreateDirectory(Path.Combine(backupsRoot, "my-rescued-saves"));
        File.WriteAllText(Path.Combine(backupsRoot, "my-rescued-saves", "keep.txt"), "mine");

        var outcome = Backup(hostUserDir, Stamp(3));
        Assert(outcome.Status == HostProfileBackupStatus.Made && outcome.Pruned == 2,
            "keeping 3, with 4 already present and 1 just written, prunes 2");
        Assert(!Directory.Exists(Path.Combine(backupsRoot, older[0]))
               && !Directory.Exists(Path.Combine(backupsRoot, older[1])),
            "the oldest stamped backups go first");
        Assert(File.ReadAllText(Path.Combine(backupsRoot, older[2], "marker.txt")) == older[2]
               && File.ReadAllText(Path.Combine(backupsRoot, older[3], "marker.txt")) == older[3],
            "the surviving backups are kept whole");
        Assert(
            new DirectoryInfo(backupsRoot).EnumerateDirectories()
                .Count(dir => HostProfileBackup.IsBackupDirectoryName(dir.Name)) == HostProfileBackup.DefaultKeepCount,
            "exactly N backups remain — the new one counts towards N");
        Assert(File.Exists(Path.Combine(outcome.BackupDirectory!, "steam", "123", "progress.save")),
            "the backup just written is never a prune candidate");
        Assert(File.ReadAllText(Path.Combine(backupsRoot, "my-rescued-saves", "keep.txt")) == "mine",
            "a directory this type did not mint is left alone");
        Assert(HostProfileBackup.IsBackupDirectoryName("20260916T120001Z")
               && HostProfileBackup.IsBackupDirectoryName("20260916T120001Z-2")
               && !HostProfileBackup.IsBackupDirectoryName("my-rescued-saves")
               && !HostProfileBackup.IsBackupDirectoryName("2026-09-16")
               && !HostProfileBackup.IsBackupDirectoryName("20260916T120001Z-x"),
            "only stamped names (with the collision suffix) are recognised as ours");
    }

    // Over the cap the answer is "no backup, and say so" — never a half-written tree, and never a silent second
    // copy of a multi-gigabyte history/ on the player's disk. Measuring before creating anything is what makes
    // the refusal clean.
    private static void AnOversizeProfileIsSkippedRatherThanHalfCopied()
    {
        using var root = new TempDir();
        var hostUserDir = Path.Combine(root.Path, "SlayTheSpire2");
        var historyDir = Path.Combine(hostUserDir, "steam", "123", "saves", "history");
        Directory.CreateDirectory(historyDir);
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "settings.save"), "host-settings");
        for (var i = 0; i < 8; i++)
        {
            File.WriteAllText(Path.Combine(historyDir, $"run-{i}.save"), new string('x', 200));
        }

        var routine = new List<string>();
        var problems = new List<string>();
        var outcome = HostProfileBackup.Run(
            hostUserDir,
            Stamp(4),
            HostProfileBackup.DefaultKeepCount,
            maxBytes: 512,
            enabled: true,
            routine.Add,
            problems.Add);

        Assert(outcome.Status == HostProfileBackupStatus.TooLarge, "an oversize profile is refused");
        Assert(!Directory.Exists(Path.Combine(hostUserDir, "couch-coop", "save-backups")),
            "nothing at all is written — not even an empty stamped directory");
        Assert(routine.Count == 0 && problems.Count == 1
               && problems[0].Contains("larger than", StringComparison.Ordinal),
            "the refusal is reported through the seeder's sink, which is what reaches godot.log");

        // …and the same profile under a cap it fits is copied normally, so the cap is the only thing refusing.
        var fits = Backup(hostUserDir, Stamp(5));
        Assert(fits.Status == HostProfileBackupStatus.Made && fits.Files == 9,
            "the identical profile backs up once it is under the cap");
    }

    // Recursive enumeration follows reparse points with no cycle detection, and the mod's own slot dirs live
    // under couch-coop/ — so a link inside the profile must be skipped, not walked and not reproduced.
    private static void DirectorySymlinksInsideTheProfileAreNotDescendedInto()
    {
        using var root = new TempDir();
        var hostUserDir = Path.Combine(root.Path, "SlayTheSpire2");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "123"));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "progress.save"), "host-progress");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "couch-coop", "cache"));
        File.WriteAllText(Path.Combine(hostUserDir, "couch-coop", "cache", "huge.bin"), "warm-cache");
        Directory.CreateSymbolicLink(
            Path.Combine(hostUserDir, "steam", "123", "cache-link"),
            Path.Combine(hostUserDir, "couch-coop", "cache"));
        Directory.CreateSymbolicLink(
            Path.Combine(hostUserDir, "steam", "loop"),
            Path.Combine(hostUserDir, "steam"));
        File.CreateSymbolicLink(
            Path.Combine(hostUserDir, "steam", "123", "linked.save"),
            Path.Combine(hostUserDir, "steam", "123", "progress.save"));

        var outcome = Backup(hostUserDir, Stamp(6));
        Assert(outcome.Status == HostProfileBackupStatus.Made && outcome.Files == 1,
            "exactly the one real file is backed up");
        var backup = outcome.BackupDirectory!;
        Assert(File.ReadAllText(Path.Combine(backup, "steam", "123", "progress.save")) == "host-progress",
            "a real file beside a symlink is still copied");
        Assert(!Directory.Exists(Path.Combine(backup, "steam", "123", "cache-link")),
            "a directory symlink inside the profile is not followed or reproduced");
        Assert(!Directory.Exists(Path.Combine(backup, "steam", "loop")),
            "a self-referential symlink inside the profile is not followed");
        Assert(!File.Exists(Path.Combine(backup, "steam", "123", "linked.save")),
            "a file symlink inside the profile is not reproduced either");
        Assert(File.ReadAllText(Path.Combine(hostUserDir, "couch-coop", "cache", "huge.bin")) == "warm-cache",
            "the host's warm cache is not dragged into a save backup");
    }

    // One backup per host session, taken on the first join. The second, third and fourth player to join must
    // cost nothing — and must not overwrite the pre-session profile with a mid-session one. Goes through the
    // REAL entry point (resolver seam and all), which is also the one exercise of the process-global claim.
    private static void ASecondSpawnInTheSameProcessTakesNoSecondBackup()
    {
        using var root = new TempDir();
        var hostUserDir = Path.Combine(root.Path, "SlayTheSpire2");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "123"));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "progress.save"), "before the session");

        var resolved = 0;
        string? Resolve()
        {
            resolved++;
            return hostUserDir;
        }

        // FIRST, the guard that keeps a test run out of the real player's save folder. The production entry
        // resolves the MACHINE's user dir, and EnsureHeadlessAsync — which calls it — is reachable from this
        // suite, so without the engine latch running these tests would copy this machine's live profile. It must
        // also be a no-op that does not burn the one claim, which the backup below proves.
        Assert(!CouchCoop.Mod.CouchCoopMod.EngineAvailable, "the suite runs with no game engine behind it");
        HostProfileBackup.EnsureForThisHostOnce();

        HostProfileBackup.EnsureForThisHostOnce(Resolve);
        var backupsRoot = Path.Combine(hostUserDir, "couch-coop", "save-backups");
        Assert(Directory.Exists(backupsRoot) && Directory.GetDirectories(backupsRoot).Length == 1,
            "the first join of the session takes one backup");

        // A second player joins after the host has played on. This entry is reached on EVERY join — including
        // ones that reuse a live seat or are refused — so the claim, not the caller, is what makes it once.
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "progress.save"), "mid-session");
        HostProfileBackup.EnsureForThisHostOnce(Resolve);
        HostProfileBackup.EnsureForThisHostOnce(Resolve);
        var only = Directory.GetDirectories(backupsRoot);
        Assert(only.Length == 1, "a later join in the same host process takes no second backup");
        Assert(File.ReadAllText(Path.Combine(only[0], "steam", "123", "progress.save")) == "before the session",
            "the one backup is still the PRE-session profile");
        Assert(resolved == 1,
            "a later join does not even resolve the user dir — the claim is taken before any work");
    }

    private static void TheBackupCanBeTurnedOff()
    {
        using var root = new TempDir();
        var hostUserDir = Path.Combine(root.Path, "SlayTheSpire2");
        Directory.CreateDirectory(Path.Combine(hostUserDir, "steam", "123"));
        File.WriteAllText(Path.Combine(hostUserDir, "steam", "123", "progress.save"), "host-progress");

        var outcome = HostProfileBackup.Run(
            hostUserDir,
            Stamp(7),
            HostProfileBackup.DefaultKeepCount,
            HostProfileBackup.DefaultMaxBytes,
            enabled: false,
            _ => { },
            _ => { });
        Assert(outcome.Status == HostProfileBackupStatus.Disabled
               && !Directory.Exists(Path.Combine(hostUserDir, "couch-coop", "save-backups")),
            "the kill switch writes nothing");
        Assert(HostProfileBackup.IsEnabled(null)
               && HostProfileBackup.IsEnabled("1")
               && !HostProfileBackup.IsEnabled("0")
               && !HostProfileBackup.IsEnabled("off")
               && !HostProfileBackup.IsEnabled("FALSE"),
            "only an explicit off value disables backups");

        // An empty profile is a no-op rather than an empty stamped directory.
        using var empty = new TempDir();
        var emptyOutcome = Backup(Path.Combine(empty.Path, "SlayTheSpire2"), Stamp(8));
        Assert(emptyOutcome.Status == HostProfileBackupStatus.NothingToBackUp,
            "a host with no profile yet leaves nothing behind");
    }

    private static HostProfileBackupOutcome Backup(string hostUserDir, DateTimeOffset utcNow)
        => HostProfileBackup.Run(
            hostUserDir,
            utcNow,
            HostProfileBackup.DefaultKeepCount,
            HostProfileBackup.DefaultMaxBytes,
            enabled: true,
            _ => { },
            message => throw new Exception($"HostProfileBackupTests: unexpected problem line: {message}"));

    private static DateTimeOffset Stamp(int second)
        => new(2026, 9, 16, 12, 0, second, TimeSpan.Zero);

    // Explicit walk, skipping links, for the same reason the production walks do.
    private static string? FindEntry(string directory, string name)
    {
        foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos())
        {
            if (entry.LinkTarget is not null)
            {
                continue;
            }

            if (string.Equals(entry.Name, name, StringComparison.Ordinal))
            {
                return entry.FullName;
            }

            if (entry is DirectoryInfo child && FindEntry(child.FullName, name) is { } found)
            {
                return found;
            }
        }

        return null;
    }

    private static Func<string, string?> Env(params (string Key, string Value)[] values)
    {
        var map = values.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        return key => map.TryGetValue(key, out var value) ? value : null;
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "couchcoop-backup-tests-" + Guid.NewGuid().ToString("N"));

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
            throw new Exception($"HostProfileBackupTests failed: {label}.");
        }
    }
}
