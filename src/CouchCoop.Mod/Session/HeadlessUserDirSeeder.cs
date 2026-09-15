using System.IO;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Prepares an ISOLATED Godot user directory for a headless instance so each one writes its own
/// <c>logs/godot.log</c>, settings, and caches instead of interleaving into the host's single user dir
/// (and racing to overwrite shared files). The game sets <c>use_custom_user_dir=true</c> /
/// <c>custom_user_dir_name="SlayTheSpire2"</c>. Godot resolves that directory from <c>XDG_DATA_HOME</c>
/// on Linux and <c>APPDATA</c> on Windows, so the launcher points the relevant child-process data root at
/// a per-slot directory. Mods load from the install <c>mods/</c> dir (NOT <c>user://</c>), so isolating
/// <c>user://</c> does not affect mod loading.
/// </summary>
internal static class HeadlessUserDirSeeder
{
    // Large, regenerable, content-addressed caches living at the TOP of the user dir: SHARED with the host via
    // symlink so a fresh slot doesn't pay a cold-start cache rebuild, and concurrent writes (sha256-named files)
    // don't collide. These are the GAME's caches, so they stay where the game puts them.
    private static readonly string[] SharedCacheDirs = ["shader_cache", "vulkan"];

    // Everything the MOD creates in the user dir lives under `user://couch-coop/` — including the per-slot
    // headless dirs (see SlotBase). The mod's own caches are shared with the host per LEAF, not by linking the
    // whole `couch-coop` dir: the slot dirs are themselves inside `couch-coop`, so a slot-level
    // `couch-coop -> <userdir>/couch-coop` link would point at its own ancestor and turn any recursive walk of
    // the user dir into an infinite descent (recursive enumeration follows directory symlinks and has no cycle
    // detection — dotnet/runtime#97123). Linking the leaf keeps the warm cache shared with the cycle gone.
    //
    // ONE leaf, because every cache now hangs under `couch-coop/cache/<branch>/` (CouchCoopCacheRoot) rather
    // than beside each other at the top. A slot resolves the same branch as the host — it is the same install —
    // so it lands in the same branch directory through the link and shares the host's warm cache.
    private const string CouchCoopDirName = "couch-coop";
    private static readonly string[] SharedCouchCoopCacheDirs = ["cache"];

    // Mutable config + the Steam profile: COPIED (per-file) so the slot OWNS its own writable copy instead of
    // sharing the host's. Seeding `steam/` is REQUIRED: without an existing profile the game sees every profile
    // file "Local file exists: False", kicks off a Steam cloud sync, and opens a modal — which blocks the
    // headless's CouchCoop browser server from ever starting (the readiness probe then times out). With the
    // profile seeded there's no sync and the browser server comes up in ~4s. The game uses the `steam/<id>/`
    // profile path (not `default/`), but we seed both cheaply.
    //
    // The copy OVERWRITES: Prepare() runs only from HeadlessClientManager.LaunchReal, i.e. only when a NEW
    // instance is about to be spawned (a reused live instance never re-enters this path), so every spawn must
    // inherit the host's CURRENT settings. Language and fps live in steam/<id>/settings.save; fast-mode lives in
    // steam/<id>/[modded/]profile<N>/saves/prefs.save — the `steam` tree covers all of them. Copy-if-missing
    // (the previous behavior) froze a slot at whatever it was first seeded with, which is how slots ended up on
    // language "esp" and fps 24 while the host was on "eng"/60.
    //
    // WHAT THE COPY DOES NOT CARRY, and it is a settings value living in this very file: the per-mod enable
    // flags (`mod_settings.mod_list`, one row per (mod id, source) pair in steam/<id>/settings.save). Those the
    // host REWRITES from the mods it found, after it has already decided which ones to load — so the copy is a
    // record of what the host discovered, not of what it chose. The seat's CouchCoop row is therefore pinned
    // explicitly after the copy; see HeadlessSeatModSelection.
    private static readonly string[] SeedCopyDirs = ["default", "mod_configs", "steam"];

    // spirectl leaves many "settings.save.spirectl-backup-<ts>" files in steam/<id>/; they're pure cruft for a
    // fresh slot (≈half the dir) — skip them so each slot copies only the real profile (~real files, not backups).
    private const string BackupMarker = ".spirectl-backup-";

    // The game quarantines unreadable saves as "<name>.VAL.corrupt"; never propagate that into a slot.
    private const string CorruptMarker = ".VAL.corrupt";

    // Past-run history (steam/<id>/profile<N>/saves/history/) is ~2/3 of the profile bytes, is append-only, and
    // carries no settings — so it is seeded copy-if-missing instead of being re-copied on every spawn. It is
    // still seeded (rather than skipped outright) so the slot's profile stays complete and the game has no reason
    // to start a Steam cloud sync for missing files.
    private static readonly string RunHistoryDirSegment =
        Path.DirectorySeparatorChar + Path.Combine("saves", "history") + Path.DirectorySeparatorChar;

    private const string UserDataDirName = "SlayTheSpire2";

    /// <summary>
    /// An extra sink for the lines this type narrates. <c>CouchCoopMod.Init</c> points it at
    /// <c>CouchCoopLog.Error</c>, which is the only channel that reaches <c>godot.log</c> in the shipped Steam
    /// flow — and, keeping only ERROR entries, the connections report's log excerpt.
    /// </summary>
    /// <remarks>
    /// A hook rather than a direct <c>CouchCoopLog</c> call, for the reason
    /// <see cref="Server.CouchCoopCacheRoot.LogSink"/> gives and one more: this type IS reachable from the
    /// suite, which runs with no Godot engine, and the game's logger is not safe to call from there.
    /// The suite uses the same hook to read the lines back.
    /// </remarks>
    internal static Action<string>? LogSink { get; set; }

    /// <summary>
    /// Both channels, for the reason this round exists: <c>Console.Error</c> is discarded by a Steam-launched
    /// game, so a line that goes only there cannot be read by the player who hit the problem.
    /// </summary>
    private static void Log(string message)
    {
        Console.Error.WriteLine(message);
        LogSink?.Invoke(message);
    }

    /// <summary>
    /// Returns the child environment needed to isolate <c>user://</c> for <paramref name="slot"/>, re-seeding it
    /// from the host's user dir. Called once per SPAWN (never for a reused live instance), so the settings the
    /// host currently has — language, fps, fast mode — are what the new instance starts with.
    /// Best-effort: returns null if the slot dir can't be prepared (the caller then launches without isolation).
    /// </summary>
    public static HeadlessUserDirPrepareResult? Prepare(int slot)
        => Prepare(
            slot,
            CurrentPlatform(),
            Environment.GetEnvironmentVariable,
            Environment.GetFolderPath,
            HeadlessSeatModSelection.SourceToDisableForThisHost());

    /// <param name="seatModSourceToDisable">
    /// The <c>couchcoop</c> mod-list row source the seeded profiles must disable, so the seat loads the same copy
    /// of the mod as this host. <see langword="null"/> leaves the seeded mod list exactly as copied — which is
    /// what the pure seeding tests want, and what a host that cannot tell where its own CouchCoop came from must
    /// do rather than guess.
    /// </param>
    internal static HeadlessUserDirPrepareResult? Prepare(
        int slot,
        HeadlessUserDirPlatform platform,
        Func<string, string?> getEnvironmentVariable,
        Func<Environment.SpecialFolder, string> getFolderPath,
        string? seatModSourceToDisable = null)
    {
        try
        {
            var policy = ResolvePolicy(slot, platform, getEnvironmentVariable, getFolderPath);
            if (policy is null)
            {
                // Was silent, and it is the one return in this file a player can be affected by without any
                // trace: the caller launches the seat anyway, into the HOST's user dir. Say what that costs.
                // The log half of this used to be named here too. It is no longer true: the LAUNCHER hands a
                // seat with no isolation its own --log-file, so the host's godot.log survives the spawn. What
                // remains unisolated — and unfixable without a per-slot user dir — is the profile.
                Log($"[couchcoop] headless user-dir seed skipped slot={slot} platform={platform} — this seat "
                    + "shares the host's user directory: one settings/save profile for every player on this "
                    + "computer.");
                return null;
            }

            var hostUserDir = policy.HostUserDir;
            // Keep per-slot dirs together under the mod's own folder (user://couch-coop/headless-slots/slot-N) so
            // NOTHING the mod creates in the user profile sits outside `couch-coop`. They stay nested one level
            // under `headless-slots` rather than directly under `couch-coop` so a future cache sweeper can never
            // mistake a slot for a cache namespace. The platform data-root env points at the slot base; user://
            // nests SlayTheSpire2 underneath it.
            var slotBase = policy.SlotBase;
            var slotUserDir = policy.SlotUserDir;
            Directory.CreateDirectory(slotUserDir);
            Directory.CreateDirectory(Path.Combine(slotUserDir, "logs"));
            foreach (var dir in policy.EnvironmentVariables.Values)
            {
                Directory.CreateDirectory(dir);
            }

            // Symlink shared caches best-effort (skip if the host dir is absent; replace a stale/broken link).
            // Windows often denies symlink creation without developer mode/admin; isolation still works without
            // the warm shared cache, just slower on a cold slot.
            foreach (var name in SharedCacheDirs)
            {
                var target = Path.Combine(hostUserDir, name);
                if (Directory.Exists(target))
                {
                    TryLinkSharedCache(slot, Path.Combine(slotUserDir, name), target);
                }
            }

            // The mod's own caches: a REAL `couch-coop` dir in the slot holding one symlink per shared leaf (see
            // SharedCouchCoopCacheDirs for why the whole dir must not be linked). Host leaves are created if
            // absent so the link always resolves — they're inside the mod's own folder, which is the one place
            // the mod is allowed to create things.
            var slotCouchCoop = Path.Combine(slotUserDir, CouchCoopDirName);
            Directory.CreateDirectory(slotCouchCoop);
            foreach (var leaf in SharedCouchCoopCacheDirs)
            {
                var target = Path.Combine(hostUserDir, CouchCoopDirName, leaf);
                try
                {
                    Directory.CreateDirectory(target);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    Console.Error.WriteLine($"[couchcoop] headless user-dir host cache dir skipped slot={slot} name={CouchCoopDirName}/{leaf}: {ex.GetType().Name}: {ex.Message}");
                    continue;
                }
                TryLinkSharedCache(slot, Path.Combine(slotCouchCoop, leaf), target);
            }

            // Re-seed config + the Steam profile from the host on EVERY spawn (per-file overwrite) so a new
            // instance always runs the host's current language / fps / fast-mode. Only the seed dirs are touched:
            // `logs/` (the whole reason per-slot dirs exist), the shared-cache links, and anything else the slot
            // owns are left alone. Backup and quarantine cruft is skipped; run history is copy-if-missing.
            foreach (var name in SeedCopyDirs)
            {
                var src = Path.Combine(hostUserDir, name);
                if (Directory.Exists(src))
                {
                    CopySeedTree(src, Path.Combine(slotUserDir, name), slot);
                }
            }

            // AFTER the copy, and only over the copy: the seat's own settings.save now says which copy of
            // CouchCoop it may load, instead of inheriting a mod list the host rewrote from discovery.
            if (seatModSourceToDisable is not null)
            {
                HeadlessSeatModSelection.PinSeatProfiles(slotUserDir, seatModSourceToDisable, slot);
            }

            return new HeadlessUserDirPrepareResult(slotBase, slotUserDir, policy.EnvironmentVariables, hostUserDir);
        }
        catch (Exception ex)
        {
            Log($"[couchcoop] headless user-dir seed failed slot={slot}: {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    private static HeadlessUserDirPlatform CurrentPlatform()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return HeadlessUserDirPlatform.Linux;
        }
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return HeadlessUserDirPlatform.Windows;
        }
        // Named rather than folded into Unsupported: macOS is a platform this mod actually runs on, and a
        // diagnostic that says "MacOs" is the difference between a known gap and an unexplained one. There is
        // no isolation to offer yet — Godot resolves user:// from $HOME there and has no --user-dir flag — so
        // the policy below still declines; it declines OUT LOUD.
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return HeadlessUserDirPlatform.MacOs;
        }
        return HeadlessUserDirPlatform.Unsupported;
    }

    internal static HeadlessUserDirPolicy? ResolvePolicy(
        int slot,
        HeadlessUserDirPlatform platform,
        Func<string, string?> getEnvironmentVariable,
        Func<Environment.SpecialFolder, string> getFolderPath)
    {
        string dataHome;
        Dictionary<string, string> environment;
        switch (platform)
        {
            case HeadlessUserDirPlatform.Linux:
                var xdg = getEnvironmentVariable("XDG_DATA_HOME");
                dataHome = string.IsNullOrWhiteSpace(xdg)
                    ? Path.Combine(getFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share")
                    : xdg;
                environment = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["XDG_DATA_HOME"] = SlotBase(Path.Combine(dataHome, UserDataDirName), slot),
                };
                break;

            case HeadlessUserDirPlatform.Windows:
                var appData = getEnvironmentVariable("APPDATA");
                dataHome = string.IsNullOrWhiteSpace(appData)
                    ? getFolderPath(Environment.SpecialFolder.ApplicationData)
                    : appData;
                var slotBase = SlotBase(Path.Combine(dataHome, UserDataDirName), slot);
                environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["APPDATA"] = slotBase,
                    ["LOCALAPPDATA"] = Path.Combine(slotBase, "LocalAppData"),
                };
                break;

            default:
                // No per-slot data-root variable is known here. macOS is the case that matters: Godot resolves
                // user:// from $HOME alone and offers no --user-dir, so there is nothing to point at a slot.
                Log($"[couchcoop] headless user-dir isolation unavailable slot={slot} platform={platform} — "
                    + "no per-slot data-root environment variable is known for this platform.");
                return null;
        }

        if (string.IsNullOrWhiteSpace(dataHome))
        {
            Log($"[couchcoop] headless user-dir isolation unavailable slot={slot} platform={platform} — "
                + "this platform's data-root path resolved empty.");
            return null;
        }

        var hostUserDir = Path.Combine(dataHome, UserDataDirName);
        var resolvedSlotBase = environment.TryGetValue("XDG_DATA_HOME", out var linuxSlotBase)
            ? linuxSlotBase
            : environment["APPDATA"];
        var slotUserDir = Path.Combine(resolvedSlotBase, UserDataDirName);
        return new HeadlessUserDirPolicy(hostUserDir, resolvedSlotBase, slotUserDir, environment);
    }

    private static string SlotBase(string hostUserDir, int slot)
    {
        return Path.Combine(hostUserDir, CouchCoopDirName, "headless-slots", $"slot-{slot}");
    }

    private static void TryLinkSharedCache(int slot, string link, string target)
    {
        try
        {
            EnsureSymlink(link, target);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            Console.Error.WriteLine($"[couchcoop] headless user-dir cache link skipped slot={slot} link={link}: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static void EnsureSymlink(string link, string target)
    {
        // LinkTarget is non-null exactly when `link` is itself a symlink (including a broken one, where
        // Exists is false), so check it before Exists.
        var info = new DirectoryInfo(link);
        if (info.LinkTarget is not null)
        {
            if (string.Equals(info.LinkTarget, target, StringComparison.Ordinal))
            {
                return; // already the correct link
            }
            Directory.Delete(link); // stale link → recreate below (unlinks; never recurses into the target)
        }
        else if (info.Exists)
        {
            return; // a real dir already seeded there — leave it untouched
        }
        else if (File.Exists(link))
        {
            File.Delete(link);
        }

        Directory.CreateSymbolicLink(link, target);
    }

    // Recursively copy the host's seed tree over the slot's, OVERWRITING so a newly spawned instance picks up the
    // host's current settings. Walks explicitly (rather than SearchOption.AllDirectories) so directory symlinks are
    // never descended into: recursive enumeration follows reparse points with no cycle detection, and the slot dirs
    // now live inside `couch-coop`, so a stray link back to a shared cache would otherwise be walked (and copied)
    // forever. Backup + quarantine cruft is skipped, and run history is copy-if-missing (see RunHistoryDirSegment).
    // Per-file failures are logged and skipped: a partial re-seed still beats launching with no isolation at all.
    private static void CopySeedTree(string src, string dst, int slot, string relativePath = "")
    {
        var inRunHistory = relativePath.Length > 0
            && (Path.DirectorySeparatorChar + relativePath + Path.DirectorySeparatorChar)
                .Contains(RunHistoryDirSegment, StringComparison.Ordinal);
        Directory.CreateDirectory(dst);
        foreach (var entry in new DirectoryInfo(src).EnumerateFileSystemInfos())
        {
            if (entry.LinkTarget is not null)
            {
                continue; // never follow (or reproduce) a link inside the seed tree
            }

            var destination = Path.Combine(dst, entry.Name);
            if (entry is DirectoryInfo childDir)
            {
                CopySeedTree(childDir.FullName, destination, slot, Path.Combine(relativePath, entry.Name));
                continue;
            }

            if (entry.Name.Contains(BackupMarker, StringComparison.Ordinal)
                || entry.Name.EndsWith(CorruptMarker, StringComparison.Ordinal))
            {
                continue;
            }

            if (inRunHistory && File.Exists(destination))
            {
                continue; // bulky, append-only, settings-free: seed once, never re-copy
            }

            try
            {
                File.Copy(entry.FullName, destination, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"[couchcoop] headless user-dir seed file skipped slot={slot} file={entry.FullName}: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }
}

internal enum HeadlessUserDirPlatform
{
    Unsupported,
    Linux,
    Windows,

    /// <summary>
    /// Runs the game, has no user-dir isolation. Kept distinct from <see cref="Unsupported"/> so the log line
    /// and the connections row can name it — see <see cref="HeadlessUserDirSeeder.ResolvePolicy"/>.
    /// </summary>
    MacOs,
}

internal sealed record HeadlessUserDirPrepareResult(
    string SlotBase,
    string SlotUserDir,
    IReadOnlyDictionary<string, string> EnvironmentVariables,
    string? HostUserDir = null);

internal sealed record HeadlessUserDirPolicy(
    string HostUserDir,
    string SlotBase,
    string SlotUserDir,
    IReadOnlyDictionary<string, string> EnvironmentVariables);
