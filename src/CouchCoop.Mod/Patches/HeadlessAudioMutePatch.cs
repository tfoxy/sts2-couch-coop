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
/// Coverage (each name is a Harmony target below; the reflection guard test fails the build if one disappears):
/// - <see cref="NAudioManager"/>: PlayLoop, StopLoop, SetParam, StopAllLoops, PlayOneShot(×2), PlayMusic,
///   UpdateMusicParameter, StopMusic, SetMasterVol, SetSfxVol, SetAmbienceVol, SetBgmVol.
/// - <see cref="NRunMusicController"/>: UpdateMusic, PlayCustomMusic, UpdateCustomTrack, StopCustomMusic,
///   UpdateAmbience, UpdateTrack(×2), UpdateMusicParameter, ToggleMerchantTrack, TriggerEliteSecondPhase,
///   TriggerCampfireGoingOut, StopMusic, and the private LoadActBank / UnloadActBanks (per-act bank streaming).
/// Each patch is null-guarded, so a future game update that renames/removes a method just logs and is skipped
/// (a matching reflection test fails the build first). Neither type touches FMOD per frame — the only per-frame
/// FMOD driver is the <c>FmodManager</c> GDScript autoload, handled by <see cref="Session.HeadlessFmodShutdown"/>.
///
/// Scoped to headless clients only (applied from <c>CouchCoopMod.Init</c> when <c>IsHeadlessClient</c>), so the
/// real player-facing host keeps full audio. STS2 audio is presentational / fire-and-forget (void calls; no
/// gameplay or netcode depends on it), so skipping it cannot change game or co-op state.
/// </summary>
internal static class HeadlessAudioMutePatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome — don't repeat missing-method lookups each Init

            var harmony = new Harmony("com.couchcoop.headless-audio-mute");

            // --- NAudioManager: SFX / loops / one-shots / music-param / volumes ---
            var audio = typeof(NAudioManager);
            PatchSkip(harmony, audio, "PlayLoop", [typeof(string), typeof(bool)]);
            PatchSkip(harmony, audio, "StopLoop", [typeof(string)]);
            PatchSkip(harmony, audio, "SetParam", [typeof(string), typeof(string), typeof(float)]);
            PatchSkip(harmony, audio, "StopAllLoops", []);
            // PlayOneShot(string, float) internally calls the dict overload; patch both so both are no-ops.
            PatchSkip(harmony, audio, "PlayOneShot",
                [typeof(string), typeof(Dictionary<string, float>), typeof(float)]);
            PatchSkip(harmony, audio, "PlayOneShot", [typeof(string), typeof(float)]);
            PatchSkip(harmony, audio, "PlayMusic", [typeof(string)]);
            PatchSkip(harmony, audio, "UpdateMusicParameter", [typeof(string), typeof(string)]);
            PatchSkip(harmony, audio, "StopMusic", []);
            PatchSkip(harmony, audio, "SetMasterVol", [typeof(float)]);
            PatchSkip(harmony, audio, "SetSfxVol", [typeof(float)]);
            PatchSkip(harmony, audio, "SetAmbienceVol", [typeof(float)]);
            PatchSkip(harmony, audio, "SetBgmVol", [typeof(float)]);

            // --- NRunMusicController: music / ambience / global params / per-act bank streaming ---
            var music = typeof(NRunMusicController);
            PatchSkip(harmony, music, "UpdateMusic", []);
            PatchSkip(harmony, music, "PlayCustomMusic", [typeof(string)]);
            PatchSkip(harmony, music, "UpdateCustomTrack", [typeof(string), typeof(float)]);
            PatchSkip(harmony, music, "StopCustomMusic", []);
            PatchSkip(harmony, music, "UpdateAmbience", []);
            PatchSkip(harmony, music, "UpdateTrack", []);
            PatchSkip(harmony, music, "UpdateTrack", [typeof(string), typeof(float)]);
            PatchSkip(harmony, music, "UpdateMusicParameter", [typeof(string), typeof(float)]);
            PatchSkip(harmony, music, "ToggleMerchantTrack", []);
            PatchSkip(harmony, music, "TriggerEliteSecondPhase", []);
            PatchSkip(harmony, music, "TriggerCampfireGoingOut", []);
            PatchSkip(harmony, music, "StopMusic", []);
            PatchSkip(harmony, music, "LoadActBank", [typeof(string)]);
            PatchSkip(harmony, music, "UnloadActBanks", []);
        }
    }

    /// <summary>The complete set of (declaring type, method name, parameter types) this patch targets — shared with
    /// the reflection test so it asserts exactly what we patch. Keep in sync with the <see cref="Apply"/> calls.</summary>
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        (typeof(NAudioManager), "PlayLoop", [typeof(string), typeof(bool)]),
        (typeof(NAudioManager), "StopLoop", [typeof(string)]),
        (typeof(NAudioManager), "SetParam", [typeof(string), typeof(string), typeof(float)]),
        (typeof(NAudioManager), "StopAllLoops", []),
        (typeof(NAudioManager), "PlayOneShot", [typeof(string), typeof(Dictionary<string, float>), typeof(float)]),
        (typeof(NAudioManager), "PlayOneShot", [typeof(string), typeof(float)]),
        (typeof(NAudioManager), "PlayMusic", [typeof(string)]),
        (typeof(NAudioManager), "UpdateMusicParameter", [typeof(string), typeof(string)]),
        (typeof(NAudioManager), "StopMusic", []),
        (typeof(NAudioManager), "SetMasterVol", [typeof(float)]),
        (typeof(NAudioManager), "SetSfxVol", [typeof(float)]),
        (typeof(NAudioManager), "SetAmbienceVol", [typeof(float)]),
        (typeof(NAudioManager), "SetBgmVol", [typeof(float)]),
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
        (typeof(NRunMusicController), "LoadActBank", [typeof(string)]),
        (typeof(NRunMusicController), "UnloadActBanks", []),
    ];

    private static void PatchSkip(Harmony harmony, Type type, string name, Type[] args)
    {
        var label = $"{type.Name}.{name}({string.Join(", ", Array.ConvertAll(args, a => a.Name))})";
        var target = AccessTools.Method(type, name, args);
        if (target is null)
        {
            Console.Error.WriteLine(
                $"[couch-coop] HeadlessAudioMutePatch: {label} not found — that forward not muted for headless.");
            return;
        }

        try
        {
            var prefix = typeof(HeadlessAudioMutePatch)
                .GetMethod(nameof(SkipOriginal), BindingFlags.NonPublic | BindingFlags.Static);
            harmony.Patch(target, prefix: new HarmonyMethod(prefix));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[couch-coop] HeadlessAudioMutePatch: Harmony patch of {label} failed ({ex.GetType().Name}: {ex.Message}).");
        }
    }

    // Harmony prefix: returning false skips the original body (and its FMOD-proxy forwarding call).
    private static bool SkipOriginal() => false;
}
