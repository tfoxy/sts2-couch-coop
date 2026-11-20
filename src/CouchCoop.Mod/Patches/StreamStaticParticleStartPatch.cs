using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;
using HarmonyLib;

namespace CouchCoop.Mod.Patches;

/// <summary>Start and stop notifications for CPU particles held by the opt-in stream freeze.</summary>
internal static class StreamStaticParticleStartPatch
{
    private static readonly object Sync = new();
    private static bool _attempted;
    private static bool _applied;

    internal static MethodInfo? ResolveRestart() => Array.Find(
        typeof(CpuParticles2D).GetMethods(BindingFlags.Instance | BindingFlags.Public),
        method => method.Name == nameof(CpuParticles2D.Restart) && !method.IsGenericMethodDefinition);

    internal static MethodInfo? ResolveEmittingSetter()
        => typeof(CpuParticles2D).GetProperty(nameof(CpuParticles2D.Emitting))?.GetSetMethod();

    internal static bool Apply()
    {
        lock (Sync)
        {
            if (_attempted) return _applied;
            _attempted = true;
            try
            {
                var restart = ResolveRestart();
                var setter = ResolveEmittingSetter();
                if (restart is null || setter is null)
                {
                    CouchCoopLog.Stderr("StreamStaticParticleStartPatch: CPU particle start targets missing; static particles remain live.");
                    return false;
                }
                var harmony = new Harmony("com.couchcoop.stream-static-particle-start");
                harmony.Patch(restart, postfix: new HarmonyMethod(typeof(StreamStaticParticleStartPatch), nameof(RestartPostfix)));
                harmony.Patch(setter, postfix: new HarmonyMethod(typeof(StreamStaticParticleStartPatch), nameof(SetEmittingPostfix)));
                _applied = true;
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr($"StreamStaticParticleStartPatch: {exception.GetType().Name}: {exception.Message}; static particles remain live.");
            }
            return _applied;
        }
    }

    private static void RestartPostfix(CpuParticles2D __instance)
        => CouchCoopStreamStaticParticles.NotifyStarted(__instance);

    private static void SetEmittingPostfix(CpuParticles2D __instance, bool value)
    {
        if (value) CouchCoopStreamStaticParticles.NotifyStarted(__instance);
        else CouchCoopStreamStaticParticles.NotifyStopped(__instance);
    }
}
