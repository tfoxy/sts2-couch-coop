using System.Globalization;
using System.IO;

namespace CouchCoop.Mod.Session;

/// <summary>
/// WHAT THIS IS: a copy of the host's own Slay the Spire 2 profile, taken ONCE per host process, immediately
/// before the first browser seat of that session is spawned. It is a safety net, not a feature — nothing in the
/// mod ever reads it back. A player reads it, with a file manager, on the day something went wrong.
/// </summary>
/// <remarks>
/// <para>
/// WHY IT EXISTS. Before v0.2.3 a spawned seat wrote its now-stale copy of the host's profile into the player's
/// Steam Cloud storage; the game's own startup sync then copied cloud-over-local (the cloud stamp being newer)
/// and deleted local files the cloud did not have. A player lost their progress that way; see
/// <c>docs/save-recovery.md</c>. <see cref="Patches.SeatCloudSaveIsolationPatch"/> closes that write path — but
/// only from INSIDE a seat that actually loaded and patched this mod. A seat that refused its lane, hit an
/// assembly conflict, fell into the loader's blanket catch, or loaded a different copy of CouchCoop runs none of
/// our code at all, and no in-seat defence can reach it. This backup is the part of the defence that does not
/// depend on the seat: taken by the HOST, before the seat process exists, so whatever the seat then does the
/// pre-session profile is still on disk and recovery is a file copy.
/// </para>
/// <para>
/// WHERE IT LANDS, AND WHY EXACTLY THERE. <c>&lt;user dir&gt;/couch-coop/save-backups/&lt;utc stamp&gt;/steam/…</c>
/// — under the mod's own folder (everything this mod writes to the user dir lives there), and deliberately NOT
/// under any name in <see cref="HeadlessUserDirSeeder.SeedCopyDirNames"/>. That is the load-bearing half: a
/// directory inside a seed dir would be copied into every seat on every spawn, and a copy of the profile living
/// INSIDE the profile is exactly the kind of thing the game's save store and its cloud sync would then see. The
/// relative layout under the stamp is the profile's own, unchanged, so the recovery page's instructions ("copy
/// progress.save back into steam/&lt;id&gt;/modded/profile&lt;N&gt;/saves/") apply verbatim to a file found here.
/// </para>
/// <para>
/// WHAT IS COPIED: the <c>steam/</c> and <c>default/</c> trees — <c>progress.save</c>, <c>prefs.save</c>,
/// <c>settings.save</c>, <c>profile.save</c> and <c>saves/history/</c>, which together ARE the progression. See
/// <see cref="IsExcluded"/> for the (short) list of what is left out, and why a quarantined save is NOT on it.
/// </para>
/// <para>
/// TOTAL, AND NEVER IN THE WAY. Every failure here is logged and swallowed: a join must not fail, or wait,
/// because a backup could not be written. The size cap is the same instinct — over it, this skips and SAYS so
/// rather than silently doubling a multi-gigabyte <c>history/</c> on the player's disk.
/// </para>
/// <para>
/// NO ENGINE IS TOUCHED. Every path comes from the caller (ultimately
/// <see cref="HeadlessUserDirPrepareResult.HostUserDir"/>), never from Godot, so this type is callable from the
/// test runner — see the latch note on <c>CouchCoopMod.EngineAvailable</c> for what calling into Godot without a
/// game process actually costs.
/// </para>
/// </remarks>
internal static class HostProfileBackup
{
    /// <summary>Sibling of <c>cache</c>, <c>headless-slots</c> and <c>seat-logs</c> under <c>couch-coop/</c>.</summary>
    internal const string BackupsDirName = "save-backups";

    /// <summary>
    /// The profile subtrees worth keeping — the same two <see cref="HeadlessUserDirSeeder"/> seeds that the
    /// game's own save store owns. <c>steam/&lt;id&gt;/</c> is where a Steam profile actually lives;
    /// <c>default/</c> is carried for the same reason the seeder carries it ("the game uses the steam path, but
    /// we seed both cheaply") — it costs nothing under the cap and removes the question of what an install whose
    /// profile is NOT under <c>steam/</c> would have backed up. <c>mod_configs/</c> is left out: it is other
    /// mods' settings, not the player's progression.
    /// </summary>
    private static readonly string[] BackedUpDirs = ["default", "steam"];

    internal const int DefaultKeepCount = 3;

    /// <summary>
    /// Over this, no backup is taken at all. A profile that big is dominated by <c>saves/history/</c>, and
    /// quietly writing another copy of it per session is a worse outcome for the player than no backup.
    /// </summary>
    internal const long DefaultMaxBytes = 200L * 1024 * 1024;

    /// <summary>Set to <c>0</c> / <c>off</c> / <c>false</c> to take no backups at all.</summary>
    internal const string EnabledEnvironmentVariable = "COUCHCOOP_SAVE_BACKUPS";

    /// <summary>Sortable as text, so retention needs no timestamps off the filesystem.</summary>
    private const string StampFormat = "yyyyMMdd'T'HHmmss'Z'";

    private static int _claimed;

    /// <summary>
    /// Take the backup if this host process has not already taken one. Called from
    /// <c>HeadlessClientManager.EnsureHeadlessAsync</c>, at the top, where a browser player is asking for a seat.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY HERE AND NOT AT THE SPAWN ITSELF. The spawn (<c>LaunchReal</c>) runs inside the manager's <c>_lock</c>,
    /// and the game's MAIN THREAD takes that lock on every screen change — holding it across slow work there is
    /// exactly the room-load freeze this repo has already had once. A whole profile copy is slow work by
    /// definition (the cap permits ~200 MB), and it does not need the lock, a slot, or anything the lock
    /// protects: it reads the HOST's user dir, which <see cref="HeadlessUserDirSeeder.ResolveHostUserDir"/>
    /// resolves from the environment alone. So it runs before the lock is taken, on the caller's own
    /// thread — synchronously, because it must be finished before any seat process can exist to write anything.
    /// </para>
    /// <para>
    /// WHAT THAT COSTS, and why it is the right trade: this entry is reached on every join, including ones that
    /// end up REUSING a live instance or being refused outright, where the pre-lock spawn is not yet certain. In
    /// practice the first join of a host process cannot be a reuse — there is nothing live to reuse until a
    /// spawn has happened — so the backup still lands before the session's first seat. The residual case is a
    /// first join that is REFUSED (a run already in progress, a taken seat port): that pays one backup for a
    /// seat that never starts. Once per process, off the lock, ~0.6s on a real 8.5 MB profile — cheaper than the
    /// alternative, which is doing it under a lock the game's main thread is waiting on.
    /// </para>
    /// <para>
    /// The claim is taken BEFORE the work and is never released: a backup that failed must not be retried on
    /// every subsequent join, both because the failure will repeat and because a join is exactly when there is
    /// no time to spare.
    /// </para>
    /// </remarks>
    public static void EnsureForThisHostOnce()
    {
        // ONLY A REAL GAME PROCESS BACKS UP A REAL PROFILE. This resolves the machine's actual user dir from the
        // environment, so in any other process — the C# suites, a bench, the hosted-server harness — it would
        // copy the developer's or player's live profile as a side effect of running a test. `EnsureHeadlessAsync`
        // IS reachable from the suite (that is the point of the FakeProcess harness), so this is not theoretical.
        // The latch is the same one every other "am I inside the game" question here uses; it is not guarding a
        // native call, it is guarding a write to somebody's save folder. Checked BEFORE the claim below, so it
        // never burns the one backup this process is allowed. The suite exercises the overload underneath.
        if (!CouchCoopMod.EngineAvailable)
        {
            return;
        }

        EnsureForThisHostOnce(HeadlessUserDirSeeder.ResolveHostUserDir);
    }

    internal static void EnsureForThisHostOnce(Func<string?> resolveHostUserDir)
    {
        // A seat spawns no seats of its own, but say it anyway: a seat's user dir is its ISOLATED slot dir, so a
        // backup taken there would snapshot the copy rather than the original.
        if (CouchCoopMod.IsHeadlessClient)
        {
            return;
        }

        if (Interlocked.Exchange(ref _claimed, 1) != 0)
        {
            return;
        }

        try
        {
            var hostUserDir = resolveHostUserDir();
            if (string.IsNullOrWhiteSpace(hostUserDir))
            {
                // The resolver is silent by design, so this is the only line. The seeder will separately, and
                // loudly, say that this platform gets no per-slot isolation either.
                HeadlessUserDirSeeder.Log(
                    "host profile backup skipped — this platform's game user directory could not be resolved, "
                    + "so no copy of your save profile was made before this session's players joined.");
                return;
            }

            Run(
                hostUserDir,
                DateTimeOffset.UtcNow,
                DefaultKeepCount,
                DefaultMaxBytes,
                IsEnabled(Environment.GetEnvironmentVariable(EnabledEnvironmentVariable)),
                logRoutine: LogRoutine,
                logProblem: HeadlessUserDirSeeder.Log);
        }
        catch (Exception ex)
        {
            // Run is total in its own right; this covers resolving, and getting as far as calling it.
            HeadlessUserDirSeeder.Log(
                $"host profile backup failed: {ex.GetType().Name}: {ex.Message} — this session's seats are "
                + "starting without a pre-session copy of your save profile.");
        }
    }

    /// <summary>
    /// A routine line, so it goes where routine lines go: stderr for a launcher capture, and <c>[INFO]</c> in
    /// <c>godot.log</c> for the player who is later asked where their backup is. Deliberately NOT the seeder's
    /// ERROR sink — that one is also the connections report's log excerpt, which keeps only ERROR entries
    /// precisely so nothing routine appears in it.
    /// </summary>
    private static void LogRoutine(string message)
    {
        CouchCoopLog.Stderr(message);
        CouchCoopLog.Info(message);
    }

    internal static bool IsEnabled(string? configured)
        => configured is null
            || !(configured.Equals("0", StringComparison.OrdinalIgnoreCase)
                 || configured.Equals("off", StringComparison.OrdinalIgnoreCase)
                 || configured.Equals("false", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The whole job, with every input injected so the suite can run it against a temp tree. Never throws.
    /// </summary>
    internal static HostProfileBackupOutcome Run(
        string hostUserDir,
        DateTimeOffset utcNow,
        int keep,
        long maxBytes,
        bool enabled,
        Action<string> logRoutine,
        Action<string> logProblem)
    {
        if (!enabled)
        {
            return new HostProfileBackupOutcome(HostProfileBackupStatus.Disabled);
        }

        try
        {
            var plan = Plan(hostUserDir, maxBytes);
            if (plan.ExceededCap)
            {
                logProblem(
                    $"host profile backup skipped — the profile under {hostUserDir} is larger than the "
                    + $"{maxBytes / (1024 * 1024)} MB this backup will copy. Your saves are not being copied "
                    + "before browser players join; take your own copy of the folder if you want one.");
                return new HostProfileBackupOutcome(HostProfileBackupStatus.TooLarge, Bytes: plan.Bytes);
            }

            if (plan.Files.Count == 0)
            {
                return new HostProfileBackupOutcome(HostProfileBackupStatus.NothingToBackUp);
            }

            var backupsRoot = Path.Combine(hostUserDir, HeadlessUserDirSeeder.CouchCoopDirName, BackupsDirName);
            var destination = ReserveDirectory(backupsRoot, utcNow);
            var failed = 0;
            foreach (var file in plan.Files)
            {
                var target = Path.Combine(destination, file.RelativePath);
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    File.Copy(file.FullPath, target, overwrite: true);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    // One unreadable file is not a reason to throw away the rest of the copy; the count of the
                    // ones that went missing rides on the summary line so the backup is never read as complete.
                    failed++;
                    CouchCoopLog.Stderr(
                        $"host profile backup file skipped file={file.FullPath}: {ex.GetType().Name}: {ex.Message}");
                }
            }

            var pruned = Prune(backupsRoot, keep, destination, logProblem);
            logRoutine(
                $"host profile backup written dir={destination} files={plan.Files.Count - failed} "
                + $"bytes={plan.Bytes}"
                + (failed > 0 ? $" incomplete={failed}" : string.Empty)
                + (pruned > 0 ? $" pruned={pruned}" : string.Empty));
            return new HostProfileBackupOutcome(
                HostProfileBackupStatus.Made,
                destination,
                plan.Bytes,
                plan.Files.Count - failed,
                failed,
                pruned);
        }
        catch (Exception ex)
        {
            logProblem(
                $"host profile backup failed: {ex.GetType().Name}: {ex.Message} — this session's seats are "
                + "starting without a pre-session copy of your save profile.");
            return new HostProfileBackupOutcome(HostProfileBackupStatus.Failed);
        }
    }

    /// <summary>
    /// Walk first, copy second. Measuring in a separate pass is what makes the cap a REFUSAL rather than a
    /// half-written tree: nothing is created until the whole plan is known to fit.
    /// </summary>
    private static BackupPlan Plan(string hostUserDir, long maxBytes)
    {
        var files = new List<PlannedFile>();
        long bytes = 0;
        foreach (var name in BackedUpDirs)
        {
            var source = Path.Combine(hostUserDir, name);
            if (!Directory.Exists(source))
            {
                continue;
            }

            if (!Collect(source, name, files, ref bytes, maxBytes))
            {
                return new BackupPlan(files, bytes, ExceededCap: true);
            }
        }

        return new BackupPlan(files, bytes, ExceededCap: false);
    }

    /// <summary>
    /// Explicit recursion, never <see cref="SearchOption.AllDirectories"/> — for the reason
    /// <see cref="HeadlessUserDirSeeder"/>'s own walks give: recursive enumeration follows reparse points with
    /// no cycle detection (dotnet/runtime#97123), and the mod's slot directories live inside <c>couch-coop</c>,
    /// so one stray link would be walked forever. Returns false once the cap is blown, which stops the walk.
    /// </summary>
    private static bool Collect(
        string directory,
        string relativePath,
        List<PlannedFile> files,
        ref long bytes,
        long maxBytes)
    {
        foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos())
        {
            if (entry.LinkTarget is not null)
            {
                continue; // never follow (or reproduce) a link inside the profile
            }

            if (entry is DirectoryInfo childDir)
            {
                if (!Collect(childDir.FullName, Path.Combine(relativePath, entry.Name), files, ref bytes, maxBytes))
                {
                    return false;
                }

                continue;
            }

            if (IsExcluded(entry.Name))
            {
                continue;
            }

            bytes += ((FileInfo)entry).Length;
            if (bytes > maxBytes)
            {
                return false;
            }

            files.Add(new PlannedFile(entry.FullName, Path.Combine(relativePath, entry.Name)));
        }

        return true;
    }

    /// <summary>
    /// What a backup does NOT carry — a SHORTER list than the seeder's, by one entry, on purpose.
    /// </summary>
    /// <remarks>
    /// <para>
    /// In-progress run saves go (the maintainer has declared them disposable), and so do spirectl's backup
    /// copies (dead weight). A <c>*.VAL.corrupt</c> QUARANTINE STAYS, which is where this parts company with
    /// <see cref="HeadlessUserDirSeeder"/>: the game renames a save it refuses rather than deleting it, and
    /// <c>docs/save-recovery.md</c> tells players that file is still their save and renaming it back is worth
    /// trying. A backup that dropped it would be throwing away the very thing the page sends them to look for.
    /// The seeder must keep skipping every quarantine for the opposite reason — a seat INHERITING one is how it
    /// grew one — and a quarantined run save is excluded here anyway, by the run-save rule that already covers
    /// <c>current_run*.&lt;ts&gt;.VAL.corrupt</c>.
    /// </para>
    /// </remarks>
    internal static bool IsExcluded(string fileName)
        => HeadlessUserDirSeeder.IsSpirectlBackupFile(fileName)
           || HeadlessUserDirSeeder.IsRunSaveFile(fileName);

    /// <summary>
    /// Claim a stamped directory, disambiguating the (rare) case of two host processes starting inside the same
    /// second. Creating it here is what makes the claim exclusive.
    /// </summary>
    private static string ReserveDirectory(string backupsRoot, DateTimeOffset utcNow)
    {
        var stamp = utcNow.UtcDateTime.ToString(StampFormat, CultureInfo.InvariantCulture);
        for (var attempt = 0; ; attempt++)
        {
            var candidate = Path.Combine(backupsRoot, attempt == 0 ? stamp : $"{stamp}-{attempt}");
            if (!Directory.Exists(candidate))
            {
                Directory.CreateDirectory(candidate);
                return candidate;
            }
        }
    }

    /// <summary>
    /// Keep the newest <paramref name="keep"/> stamped directories and delete the rest. Ordinal name order IS
    /// chronological order — that is what the stamp format buys — so this needs no filesystem timestamps, which
    /// a copy or a restore would have rewritten anyway.
    /// </summary>
    /// <remarks>
    /// Only directories whose names this type minted are candidates. Anything else a player put in here is left
    /// alone: a folder in the backups directory is far more likely to be someone's own rescued copy than
    /// something worth deleting.
    /// </remarks>
    private static int Prune(string backupsRoot, int keep, string justCreated, Action<string> logProblem)
    {
        if (keep < 1)
        {
            keep = 1;
        }

        var candidates = new DirectoryInfo(backupsRoot)
            .EnumerateDirectories()
            .Where(dir => dir.LinkTarget is null
                          && IsBackupDirectoryName(dir.Name)
                          && !string.Equals(dir.FullName, justCreated, StringComparison.Ordinal))
            .OrderByDescending(dir => dir.Name, StringComparer.Ordinal)
            .Skip(keep - 1) // the one just created occupies the first slot
            .ToList();

        var pruned = 0;
        foreach (var stale in candidates)
        {
            try
            {
                // Recursive delete removes a directory link rather than descending through it (the fix for
                // dotnet/runtime#27045), and nothing here copies links in the first place.
                stale.Delete(recursive: true);
                pruned++;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logProblem(
                    $"host profile backup not pruned dir={stale.FullName}: {ex.GetType().Name}: {ex.Message}");
            }
        }

        return pruned;
    }

    /// <summary>
    /// Whether <paramref name="name"/> is a directory name this type minted: the UTC stamp, optionally followed
    /// by <c>-&lt;n&gt;</c> from <see cref="ReserveDirectory"/>.
    /// </summary>
    internal static bool IsBackupDirectoryName(string name)
    {
        var dash = name.IndexOf('-', StringComparison.Ordinal);
        var stamp = dash < 0 ? name : name[..dash];
        if (!DateTime.TryParseExact(
                stamp,
                StampFormat,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
                out _))
        {
            return false;
        }

        if (dash < 0)
        {
            return true;
        }

        var suffix = name[(dash + 1)..];
        return suffix.Length > 0 && suffix.All(char.IsAsciiDigit);
    }

    private readonly record struct PlannedFile(string FullPath, string RelativePath);

    private sealed record BackupPlan(IReadOnlyList<PlannedFile> Files, long Bytes, bool ExceededCap);
}

internal enum HostProfileBackupStatus
{
    /// <summary>A backup directory was written (possibly with some files skipped — see FailedFiles).</summary>
    Made,

    /// <summary>The host has no profile tree yet; there was nothing to copy.</summary>
    NothingToBackUp,

    /// <summary>The profile is over the byte cap, so nothing was copied and the log says why.</summary>
    TooLarge,

    /// <summary>Turned off by <see cref="HostProfileBackup.EnabledEnvironmentVariable"/>.</summary>
    Disabled,

    /// <summary>Something below the per-file level went wrong. Logged; the spawn continues regardless.</summary>
    Failed,
}

internal sealed record HostProfileBackupOutcome(
    HostProfileBackupStatus Status,
    string? BackupDirectory = null,
    long Bytes = 0,
    int Files = 0,
    int FailedFiles = 0,
    int Pruned = 0);
