using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading.Tasks;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Platform.Steam;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Keeps a spawned co-op SEAT out of the player's Steam Cloud save storage, by Harmony-skipping every
/// <see cref="SteamRemoteSaveStore"/> method that MUTATES it, plus the startup cloud-sync entry point on
/// <see cref="NGame"/>.
///
/// <b>What this is protecting.</b> <see cref="Session.HeadlessUserDirSeeder"/> gives each seat an isolated
/// Godot <c>user://</c> (a per-slot data-root env var), so a seat's local writes land in its own slot
/// directory. Steam Remote Storage has no such seam: it is addressed by (Steam account, app id), so it is the
/// SAME store for the host and for every seat on the machine, and a seat writing into it writes over the
/// player's own saves from outside the sandbox the seeder built. When Steam is initialized the game's save
/// store is a cloud-mirroring wrapper around the local one, so an ordinary seat-side save is also a cloud
/// write — which is how a seat's stale slot copy of a profile, and a quarantined save file, reached the
/// account's cloud storage.
///
/// <b>Why a patch rather than launching the seat without Steam.</b> The game has a first-party switch that
/// leaves Steam uninitialized, and with no Steam there is no cloud store to write to — but mod discovery for
/// Steam Workshop items is behind the same initialization. A seat launched that way loads only the mods in
/// the install's <c>mods/</c> directory, so on any machine whose host runs a Workshop mod (CouchCoop's own
/// Workshop build; any content mod a player subscribes to) the seat would run a DIFFERENT mod set than the
/// host it is joining. That is a desync, so the switch is unusable here and the write path is closed
/// directly instead.
///
/// <b>Scope: mutations only.</b> Reads are left alone — they are answered from the local store, and the one
/// path that pulls FROM the cloud is the startup sync, which is skipped here as a whole. Skipping the sync
/// also removes a seat's startup round trip to Steam for every save file it does not have locally, which is
/// what lets <see cref="Session.HeadlessUserDirSeeder"/> stop seeding run saves into a slot at all.
///
/// <b>A target that does not resolve is a REFUSAL, not a shrug</b> — the same posture, and for a sharper
/// reason, than <see cref="HeadlessAudioMutePatch"/>: a seat that launches with half this patch installed
/// silently overwrites the player's cloud saves, and nothing on screen says so. <see cref="Apply"/> therefore
/// throws, naming every target it could not take. It is unreachable in a shipped build, because
/// <c>SeatCloudSaveIsolationTargetsTests</c> resolves the identical <see cref="Targets"/> list at test time.
///
/// Applied from <c>CouchCoopMod.Init</c> for a headless seat only (<c>COUCHCOOP_HEADLESS_CLIENT=1</c>): the
/// real player-facing host keeps its cloud saves working exactly as the game shipped them.
/// </summary>
internal static class SeatCloudSaveIsolationPatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>
    /// The complete set of (declaring type, method name, parameter types) this patch targets — the single
    /// source for <see cref="Apply"/> and for the reflection guard test.
    /// </summary>
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        // --- Every mutating SteamRemoteSaveStore method the cloud wrapper forwards to ---
        (typeof(SteamRemoteSaveStore), "WriteFile", [typeof(string), typeof(string)]),
        (typeof(SteamRemoteSaveStore), "WriteFile", [typeof(string), typeof(byte[])]),
        (typeof(SteamRemoteSaveStore), "WriteFileAsync", [typeof(string), typeof(string)]),
        (typeof(SteamRemoteSaveStore), "WriteFileAsync", [typeof(string), typeof(byte[])]),
        (typeof(SteamRemoteSaveStore), "DeleteFile", [typeof(string)]),
        (typeof(SteamRemoteSaveStore), "RenameFile", [typeof(string), typeof(string)]),
        (typeof(SteamRemoteSaveStore), "CreateDirectory", [typeof(string)]),
        (typeof(SteamRemoteSaveStore), "DeleteDirectory", [typeof(string)]),
        (typeof(SteamRemoteSaveStore), "DeleteTemporaryFiles", [typeof(string)]),
        // "Forget" removes the file from remote storage while keeping the local one — a cloud mutation like
        // the rest, and the one a seat reaches while trimming what it thinks is its own cloud footprint.
        (typeof(SteamRemoteSaveStore), "ForgetFile", [typeof(string)]),

        // --- …and the startup sync, so a seat never reconciles its slot against the account's cloud at all ---
        (typeof(NGame), "DoCloudSync", []),
    ];

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome — don't repeat missing-method lookups each Init

            var harmony = new Harmony("com.couchcoop.seat-cloud-save-isolation");
            var refused = new List<string>();
            foreach (var (type, name, args) in Targets)
            {
                PatchSkip(harmony, type, name, args, refused);
            }

            if (refused.Count > 0)
            {
                throw new InvalidOperationException(
                    "[couchcoop] SeatCloudSaveIsolationPatch could not close "
                    + $"{refused.Count} of {Targets.Count} seat→Steam-Cloud write paths on this build, so a seat "
                    + "would write into the player's own account save storage. Refusing rather than launching a "
                    + "seat that corrupts saves: " + string.Join("; ", refused));
            }
        }
    }

    private static void PatchSkip(Harmony harmony, Type type, string name, Type[] args, ICollection<string> refused)
    {
        var label = $"{type.Name}.{name}({string.Join(", ", Array.ConvertAll(args, a => a.Name))})";
        var target = AccessTools.Method(type, name, args);
        if (target is null)
        {
            refused.Add($"{label} does not resolve against the installed STS2 assemblies");
            return;
        }

        // A prefix that returns false makes the patched method return `default` for its return type, so the
        // SHAPE of the skip depends on that type. `default(Task)` is NULL, which every awaiting caller here
        // would dereference, so a Task-returning target gets an explicitly completed Task instead — "this
        // finished, immediately, having done nothing", which is the truth for a seat with no cloud store.
        var prefixName = target.ReturnType == typeof(void)
            ? nameof(SkipOriginal)
            : target.ReturnType == typeof(Task)
                ? nameof(SkipOriginalReturningCompletedTask)
                : null;
        if (prefixName is null)
        {
            refused.Add($"{label} returns {target.ReturnType.Name}, which this patch has no skip value for");
            return;
        }

        try
        {
            var prefix = typeof(SeatCloudSaveIsolationPatch)
                .GetMethod(prefixName, BindingFlags.NonPublic | BindingFlags.Static);
            harmony.Patch(target, prefix: new HarmonyMethod(prefix));
        }
        catch (Exception ex)
        {
            refused.Add($"Harmony patch of {label} failed ({ex.GetType().Name}: {ex.Message})");
        }
    }

    // Harmony prefix: returning false skips the original body (and its write to Steam Remote Storage).
    private static bool SkipOriginal() => false;

    /// <summary>
    /// The same skip for a target whose result is awaited. Assigning <see cref="Task.CompletedTask"/> is not
    /// cosmetic: Harmony would otherwise leave <c>__result</c> at <see langword="null"/>, and the caller
    /// awaits it.
    /// </summary>
    private static bool SkipOriginalReturningCompletedTask(ref Task __result)
    {
        __result = Task.CompletedTask;
        return false;
    }
}
