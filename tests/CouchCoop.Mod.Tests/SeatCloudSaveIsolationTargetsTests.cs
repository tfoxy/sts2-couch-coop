using CouchCoop.Mod.Patches;
using HarmonyLib;

// Regression guard for SeatCloudSaveIsolationPatch: every method it Harmony-skips to keep a spawned seat out of
// the player's Steam Cloud save storage must still resolve against the installed STS2 assemblies. A target that
// quietly stops resolving is not a lost feature — it is a seat writing its stale slot copy of a profile over the
// player's own cloud saves, from outside the per-slot user dir the seeder built, with nothing on screen to see.
// Pure metadata reflection (AccessTools.Method), the same resolution the patch itself uses: no live game, no
// Steam client, no native library.
internal static class SeatCloudSaveIsolationTargetsTests
{
    public static void Run()
    {
        AllPatchTargetsResolve();
        EveryTargetHasASkipValue();
        CoversEveryCloudMutationAndTheStartupSync();
    }

    private static void AllPatchTargetsResolve()
    {
        var missing = new List<string>();
        foreach (var (type, name, args) in SeatCloudSaveIsolationPatch.Targets)
        {
            if (AccessTools.Method(type, name, args) is null)
            {
                missing.Add($"{type.FullName}.{name}({string.Join(", ", args.Select(a => a.Name))})");
            }
        }

        Assert(missing.Count == 0,
            $"every SeatCloudSaveIsolationPatch target resolves against the installed STS2 assemblies (missing: {string.Join("; ", missing)})");
    }

    // Resolving is only half of it. A prefix that skips the original makes the method return `default` for its
    // return type, and `default(Task)` is null — which the caller of a skipped async target would dereference.
    // The patch knows a skip value for void and for Task; anything else must fail here rather than be invented
    // at runtime.
    private static void EveryTargetHasASkipValue()
    {
        var unhandled = new List<string>();
        foreach (var (type, name, args) in SeatCloudSaveIsolationPatch.Targets)
        {
            var target = AccessTools.Method(type, name, args);
            if (target is not null
                && target.ReturnType != typeof(void)
                && target.ReturnType != typeof(Task))
            {
                unhandled.Add($"{type.Name}.{name} returns {target.ReturnType.Name}");
            }
        }

        Assert(unhandled.Count == 0,
            $"every SeatCloudSaveIsolationPatch target returns void or Task, the two shapes it can skip (unhandled: {string.Join("; ", unhandled)})");
    }

    // The list is a CLAIM about which paths can still reach the account's cloud storage. Spell the claim out here
    // so a target dropped from the patch fails a test rather than silently re-opening a write path.
    private static void CoversEveryCloudMutationAndTheStartupSync()
    {
        var byType = SeatCloudSaveIsolationPatch.Targets
            .ToLookup(t => t.Type.Name, t => t.Name);

        foreach (var mutation in new[]
                 {
                     "WriteFile", "WriteFileAsync", "DeleteFile", "RenameFile",
                     "CreateDirectory", "DeleteDirectory", "DeleteTemporaryFiles", "ForgetFile",
                 })
        {
            Assert(byType["SteamRemoteSaveStore"].Contains(mutation),
                $"target list closes SteamRemoteSaveStore.{mutation} (a seat→cloud mutation)");
        }

        // Both write overloads AND both async twins: the store takes text and bytes, and one of each is awaited.
        Assert(SeatCloudSaveIsolationPatch.Targets.Count(t => t.Name == "WriteFile") == 2,
            "both WriteFile overloads (string content and byte[]) are closed");
        Assert(SeatCloudSaveIsolationPatch.Targets.Count(t => t.Name == "WriteFileAsync") == 2,
            "both WriteFileAsync overloads (string content and byte[]) are closed");

        // …and the startup sync, which is both the read half (pulling the account's cloud state into a slot) and
        // the reason the seeder is free to stop seeding run saves: with no sync there is no per-missing-file
        // remote round trip for startup to wait on.
        Assert(byType["NGame"].Contains("DoCloudSync"),
            "target list skips the seat's startup cloud sync (NGame.DoCloudSync)");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[SeatCloudSaveIsolationTargetsTests] FAILED: {label}");
        }
    }
}
