using CouchCoop.Mod.Patches;
using HarmonyLib;

// Regression guard for HeadlessAudioMutePatch: every method it Harmony-skips to sever a headless client from FMOD
// must still resolve against the installed STS2 assemblies. If a game update renames/removes a forward, this fails
// the build instead of silently leaving a live game->FMOD path that would re-enter the torn-down native server
// (HeadlessFmodShutdown calls FmodServer.shutdown()) — most dangerously the per-act bank load on an act transition.
// Pure metadata reflection (AccessTools.Method), same resolution the patch itself uses; no live game, no native lib.
internal static class HeadlessAudioMuteTargetsTests
{
    public static void Run()
    {
        AllPatchTargetsResolve();
        EveryTargetHasASkipValue();
        CoversBothForwarders();
    }

    private static void AllPatchTargetsResolve()
    {
        var missing = new List<string>();
        foreach (var (type, name, args) in HeadlessAudioMutePatch.Targets)
        {
            if (AccessTools.Method(type, name, args) is null)
            {
                missing.Add($"{type.FullName}.{name}({string.Join(", ", args.Select(a => a.Name))})");
            }
        }

        Assert(missing.Count == 0,
            $"every HeadlessAudioMutePatch target resolves against the installed STS2 assemblies (missing: {string.Join("; ", missing)})");
    }

    // Resolving is only half of it: a prefix that skips the original makes the method return `default` for its
    // return type, so a forward that starts RETURNING something (v0.111.0 turned LoadActBank's void into a
    // load-succeeded bool) hands its caller a value the patch never decided on. The patch knows a skip value for
    // void and for bool; anything else must fail here rather than be invented at runtime.
    private static void EveryTargetHasASkipValue()
    {
        var unhandled = new List<string>();
        foreach (var (type, name, args) in HeadlessAudioMutePatch.Targets)
        {
            var target = AccessTools.Method(type, name, args);
            if (target is not null && target.ReturnType != typeof(void) && target.ReturnType != typeof(bool))
            {
                unhandled.Add($"{type.Name}.{name} returns {target.ReturnType.Name}");
            }
        }

        Assert(unhandled.Count == 0,
            $"every HeadlessAudioMutePatch target returns void or bool, the two shapes it can skip (unhandled: {string.Join("; ", unhandled)})");
    }

    private static void CoversBothForwarders()
    {
        // The two C#->FMOD forwarders. If either is absent from the target list, a whole path to FMOD survives.
        var types = HeadlessAudioMutePatch.Targets.Select(t => t.Type.Name).Distinct().ToHashSet();
        Assert(types.Contains("NAudioManager"), "target list covers NAudioManager (SFX / loops / volumes)");
        Assert(types.Contains("NRunMusicController"), "target list covers NRunMusicController (music / per-act bank load)");
        // Bank streaming is the highest-risk post-shutdown call; assert it is explicitly listed.
        Assert(HeadlessAudioMutePatch.Targets.Any(t => t.Type.Name == "NRunMusicController" && t.Name == "LoadActBank"),
            "target list includes NRunMusicController.LoadActBank (per-act bank load into a torn-down server must be a no-op)");
        Assert(HeadlessAudioMutePatch.Targets.Any(t => t.Type.Name == "NRunMusicController" && t.Name == "UnloadActBanks"),
            "target list includes NRunMusicController.UnloadActBanks");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HeadlessAudioMuteTargetsTests] FAILED: {label}");
        }
    }
}
