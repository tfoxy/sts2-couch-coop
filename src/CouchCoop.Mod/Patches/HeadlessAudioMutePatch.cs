using System;
using System.Collections.Generic;
using System.Reflection;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Audio;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Severs a HEADLESS co-op client from FMOD at the source: Harmony-patches EVERY <see cref="NAudioManager"/> and
/// <see cref="NRunMusicController"/> method that forwards to the native FMOD system (through their GDScript
/// <c>"Proxy"</c> child) to a no-op, so no game code ever asks FMOD to play, stop, set a parameter, set a volume,
/// or load/unload a bank on a headless instance.
///
/// Why patch here rather than a launch flag or an OS env var:
/// STS2 plays audio through <b>FMOD</b> (a native middleware GDExtension), NOT Godot's own <c>AudioServer</c>. So
/// Godot's <c>--headless</c> / <c>--audio-driver Dummy</c> do not silence it, and an OS null audio device only
/// DISCARDS FMOD's output while FMOD keeps mixing. Because this is a C# Harmony patch it works identically on
/// Windows (WASAPI) — unlike a Linux-only PulseAudio/ALSA env var.
///
/// Relationship to <see cref="Session.HeadlessFmodShutdown"/>: that helper additionally tears the FMOD system down
/// (<c>FmodServer.shutdown()</c>) to reclaim the always-on native mixer/DSP thread — the frame-rate-INDEPENDENT
/// audio CPU that muting alone can never stop. This patch is its safety net: once the system is shut down, any
/// surviving game→FMOD forward (most dangerously per-act BANK LOAD on an act transition, but also stop/param/volume
/// calls) would hit an uninitialized native server; no-opping every forward here guarantees nothing re-enters it.
/// The two are complementary — this patch is correct on its own (no audio) even when shutdown is disabled.
///
/// Coverage is <see cref="Targets"/> — one list, read both by <see cref="Apply"/> and by the reflection guard test,
/// so the thing we patch and the thing we assert can no longer drift apart.
/// - <see cref="NAudioManager"/>: PlayLoop, StopLoop, SetParam, StopAllLoops, PlayOneShot(×2), PlayMusic,
///   UpdateMusicParameter, StopMusic, SetMasterVol, SetSfxVol, SetAmbienceVol, SetBgmVol.
/// - <see cref="NRunMusicController"/>: UpdateMusic, PlayCustomMusic, UpdateCustomTrack, StopCustomMusic,
///   UpdateAmbience, UpdateTrack(×2), UpdateMusicParameter, ToggleMerchantTrack, TriggerEliteSecondPhase,
///   TriggerCampfireGoingOut, StopMusic, and the private LoadActBank / UnloadActBanks (per-act bank streaming).
/// Neither type touches FMOD per frame — the only per-frame FMOD driver is the <c>FmodManager</c> GDScript
/// autoload, handled by <see cref="Session.HeadlessFmodShutdown"/>.
///
/// <b>A target that does not resolve is a REFUSAL, not a shrug.</b> <see cref="Targets"/> is pinned to the game
/// API lane this assembly was compiled for, so the list is a CLAIM about the installed build rather than a guess;
/// a claim that turns out to be false means we are wrong about what this instance is running, and the old
/// behaviour — log the miss, patch the rest, carry on — left a headless seat streaming per-act FMOD banks into a
/// torn-down native server with no crash and nothing on screen to see. <see cref="Apply"/> therefore throws,
/// naming every target it could not take. This is the same posture the bridge takes for its own lane-pinned
/// members, and it is unreachable in a shipped build: <c>HeadlessAudioMuteTargetsTests</c> resolves the identical
/// list at test time, so a rename fails the gate long before it can fail a seat.
///
/// Scoped to headless clients only (applied from <c>CouchCoopMod.Init</c> when <c>IsHeadlessClient</c>), so the
/// real player-facing host keeps full audio. STS2 audio is presentational / fire-and-forget (no gameplay or
/// netcode depends on it), so skipping it cannot change game or co-op state.
/// </summary>
internal static class HeadlessAudioMutePatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>
    /// The complete set of (declaring type, method name, parameter types) this patch targets, in the order it
    /// takes them — the single source for <see cref="Apply"/> and for the reflection guard test.
    /// </summary>
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        // --- NAudioManager: SFX / loops / one-shots / music-param / volumes ---
        (typeof(NAudioManager), "PlayLoop", [typeof(string), typeof(bool)]),
        (typeof(NAudioManager), "StopLoop", [typeof(string)]),
        (typeof(NAudioManager), "SetParam", [typeof(string), typeof(string), typeof(float)]),
        (typeof(NAudioManager), "StopAllLoops", []),
        // PlayOneShot(string, float) internally calls the dict overload; patch both so both are no-ops.
        (typeof(NAudioManager), "PlayOneShot", [typeof(string), typeof(Dictionary<string, float>), typeof(float)]),
        (typeof(NAudioManager), "PlayOneShot", [typeof(string), typeof(float)]),
        (typeof(NAudioManager), "PlayMusic", [typeof(string)]),
        (typeof(NAudioManager), "UpdateMusicParameter", [typeof(string), typeof(string)]),
        (typeof(NAudioManager), "StopMusic", []),
        (typeof(NAudioManager), "SetMasterVol", [typeof(float)]),
        (typeof(NAudioManager), "SetSfxVol", [typeof(float)]),
        (typeof(NAudioManager), "SetAmbienceVol", [typeof(float)]),
        (typeof(NAudioManager), "SetBgmVol", [typeof(float)]),

        // --- NRunMusicController: music / ambience / global params / per-act bank streaming ---
        (typeof(NRunMusicController), "UpdateMusic", []),
        (typeof(NRunMusicController), "PlayCustomMusic", [typeof(string)]),
        (typeof(NRunMusicController), "UpdateCustomTrack", [typeof(string), typeof(float)]),
        (typeof(NRunMusicController), "StopCustomMusic", []),
        (typeof(NRunMusicController), "UpdateAmbience", []),
        (typeof(NRunMusicController), "UpdateTrack", []),
        (typeof(NRunMusicController), "UpdateTrack", [typeof(string), typeof(float)]),
        (typeof(NRunMusicController), "UpdateMusicParameter", [typeof(string), typeof(float)]),
        (typeof(NRunMusicController), "ToggleMerchantTrack", []),
        (typeof(NRunMusicController), "TriggerEliteSecondPhase", []),
        (typeof(NRunMusicController), "TriggerCampfireGoingOut", []),
        (typeof(NRunMusicController), "StopMusic", []),
#if STS2_API_V111
        // v0.111.0: LoadActBank(bankPath, verifyEvent) returns whether the bank loaded, and wraps a retry loop
        // of its own. Skipping it reports "not loaded", which is the truth on a seat with no FMOD — see
        // SkipOriginalReturningFalse.
        (typeof(NRunMusicController), "LoadActBank", [typeof(string), typeof(string)]),
#else
        (typeof(NRunMusicController), "LoadActBank", [typeof(string)]),
#endif
        (typeof(NRunMusicController), "UnloadActBanks", []),
    ];

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome — don't repeat missing-method lookups each Init

            var harmony = new Harmony("com.couchcoop.headless-audio-mute");
            var refused = new List<string>();
            foreach (var (type, name, args) in Targets)
            {
                PatchSkip(harmony, type, name, args, refused);
            }

            if (refused.Count > 0)
            {
                throw new InvalidOperationException(
                    Session.CouchCoopLog.Line("HeadlessAudioMutePatch could not mute ")
                    + $"{refused.Count} of {Targets.Count} game→FMOD forwards on this build, so a headless seat "
                    + "would keep driving a torn-down FMOD server. Refusing rather than running half-muted: "
                    + string.Join("; ", refused));
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
        // SHAPE of the skip depends on that type: a bool-returning forward gets the explicit `false` (which is
        // also what it means — nothing was loaded), a void one gets the plain skip, and anything else is a
        // forward whose skipped value we have not reasoned about and must not invent.
        var prefixName = target.ReturnType == typeof(void)
            ? nameof(SkipOriginal)
            : target.ReturnType == typeof(bool)
                ? nameof(SkipOriginalReturningFalse)
                : null;
        if (prefixName is null)
        {
            refused.Add($"{label} returns {target.ReturnType.Name}, which this patch has no skip value for");
            return;
        }

        try
        {
            var prefix = typeof(HeadlessAudioMutePatch)
                .GetMethod(prefixName, BindingFlags.NonPublic | BindingFlags.Static);
            harmony.Patch(target, prefix: new HarmonyMethod(prefix));
        }
        catch (Exception ex)
        {
            refused.Add($"Harmony patch of {label} failed ({ex.GetType().Name}: {ex.Message})");
        }
    }

    // Harmony prefix: returning false skips the original body (and its FMOD-proxy forwarding call).
    private static bool SkipOriginal() => false;

    /// <summary>
    /// The same skip for a forward that reports SUCCESS as a bool. Harmony would leave <c>__result</c> at its
    /// default anyway; it is assigned explicitly because the value is a decision, not a leftover — a seat with
    /// no FMOD genuinely did not load the bank, and a caller that reads it must see that rather than a
    /// silently-defaulted "true" if the game's polarity ever flips.
    /// </summary>
    private static bool SkipOriginalReturningFalse(ref bool __result)
    {
        __result = false;
        return false;
    }
}
