using System.Reflection;
using CouchCoop.Mod.Audio.Seat;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Audio.Debug;
using MegaCrit.Sts2.Core.Nodes;

namespace CouchCoop.Mod.Patches;

/// <summary>Reports Godot TmpSfx after the seat has drawn its pitch.</summary>
internal static class SeatAudioReportPatch
{
    private static bool _applied;
    [ThreadStatic] private static int _backgroundMuteDepth;
    internal static bool InBackgroundMute => _backgroundMuteDepth != 0;
    internal static string PlayerNodeName(string streamName) => ("StreamPlayer-" + streamName).Replace('.', '_');
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        (typeof(NDebugAudioManager), "Play", [typeof(string), typeof(float), typeof(PitchVariance)]),
        (typeof(NDebugAudioManager), "SetMasterAudioVolume", [typeof(float)]),
        (typeof(NDebugAudioManager), "SetSfxAudioVolume", [typeof(float)]),
    ];

    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        var backgroundTarget = AccessTools.DeclaredMethod(typeof(NMuteInBackgroundHandler),
            nameof(NMuteInBackgroundHandler.MethodName.SetMasterVolume), [typeof(float)]);
        if (backgroundTarget is null)
            throw new InvalidOperationException("Seat audio background-mute bracket target unresolved");
        var harmony = new Harmony("com.couchcoop.seat-audio-report");
        var failures = new List<string>();
        foreach (var (type, name, args) in Targets)
        {
            var target = AccessTools.DeclaredMethod(type, name, args);
            if (target is null) { failures.Add($"{type.Name}.{name} unresolved"); continue; }
            var methodName = name switch
            {
                "Play" => nameof(ReportPlay),
                "SetMasterAudioVolume" => nameof(ReportMasterBus),
                _ => nameof(ReportSfxBus),
            };
            try
            {
                harmony.Patch(target, postfix: new HarmonyMethod(typeof(SeatAudioReportPatch)
                    .GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)));
            }
            catch (Exception ex) { failures.Add($"{type.Name}.{name}: {ex.GetType().Name}"); }
        }
        try
        {
            harmony.Patch(backgroundTarget,
                prefix: new HarmonyMethod(typeof(SeatAudioReportPatch).GetMethod(nameof(EnterBackgroundMute),
                    BindingFlags.NonPublic | BindingFlags.Static)),
                finalizer: new HarmonyMethod(typeof(SeatAudioReportPatch).GetMethod(nameof(LeaveBackgroundMute),
                    BindingFlags.NonPublic | BindingFlags.Static)));
        }
        catch (Exception ex) { failures.Add($"background mute bracket: {ex.GetType().Name}"); }
        if (failures.Count != 0) throw new InvalidOperationException("Seat audio targets: " + string.Join("; ", failures));
    }

    private static void EnterBackgroundMute() => _backgroundMuteDepth++;
    private static Exception? LeaveBackgroundMute(Exception? __exception)
    {
        _backgroundMuteDepth--;
        return __exception;
    }

    private static void ReportPlay(NDebugAudioManager __instance, string streamName, float volume, int __result)
    {
        if (!SeatAudioFeed.HasSubscribers) return;
        try
        {
            // Play has completed; the player's pitch is now the actual randomised value.
            AudioStreamPlayer? newest = null;
            float youngest = float.MaxValue;
            // Godot normalizes punctuation in Node.Name (for example, .mp3 becomes _mp3).
            var wanted = PlayerNodeName(streamName);
            foreach (var child in __instance.GetChildren())
            {
                // Headless seats may have no active output, so Playing is not a reliable report gate.
                if (child is not AudioStreamPlayer player || player.Name != wanted) continue;
                var age = player.GetPlaybackPosition();
                if (age > youngest) continue;
                youngest = age;
                newest = player;
            }
            if (newest is not null)
                SeatAudioFeed.TmpSfx("res://debug_audio/" + streamName, newest.PitchScale, volume);
        }
        catch { /* Audio reporting never changes a game's sound path. */ }
    }

    private static void ReportMasterBus(float linearVolume)
    {
        if (!SeatAudioFeed.HasSubscribers || InBackgroundMute) return;
        ReadBusDb("Master", SeatAudioFeed.SetGodotMasterDb);
    }

    private static void ReportSfxBus(float linearVolume)
    {
        if (!SeatAudioFeed.HasSubscribers) return;
        ReadBusDb("SFX", SeatAudioFeed.SetGodotSfxDb);
    }

    private static void ReadBusDb(string busName, Action<float> report)
    {
        try
        {
            var audio = AudioServer.Singleton;
            var index = audio.GetBusIndex(busName);
            if (index >= 0) report(audio.GetBusVolumeDb(index));
        }
        catch { }
    }
}
