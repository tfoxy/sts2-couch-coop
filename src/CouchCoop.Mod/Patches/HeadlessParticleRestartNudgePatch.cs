using System;
using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;
using HarmonyLib;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Late half of the headless one-shot <c>finished</c> nudge (see
/// <see cref="CouchCoopHeadlessVisualSuspender"/>): Harmony postfixes on <c>GpuParticles2D</c>/<c>CpuParticles2D</c>
/// <c>Restart()</c> and their <c>Emitting</c> setters, so a burst started on an ALREADY-FROZEN node still gets a
/// synthesized <c>finished</c> scheduled.
///
/// <para>Why the freeze walk alone is not enough: it reads each node's state once per scan (1s cadence) and only
/// nudges a one-shot it catches mid-burst. A VFX whose particles are dormant at scan time — a burst that has not
/// been triggered yet — is frozen quiet, and its later <c>Restart()</c> starts a cycle whose process never runs:
/// no <c>finished</c>, forever. Worse, on a frozen node <c>Emitting</c> LATCHES true (only the node's own process
/// clears it at cycle end), so a re-burst produces no observable state change at all. Hooking the CALL is the only
/// signal that survives the freeze; this is the same reason spirectl's <c>Sts2ParticleRestartHooks</c> drives the
/// mirror's burst epoch off the call rather than off the streamed <c>Emitting</c> edge. Postfixes stack, so both
/// hooks run.</para>
///
/// <para>Installed from <see cref="CouchCoopHeadlessVisualSuspender.Install"/> — i.e. windowless instances only —
/// when the particle freeze is on. Targets are resolved BY NAME (Godot's binding
/// exposes <c>Restart</c> as either a parameterless method or a <c>Restart(bool keepSeed)</c> overload depending on
/// engine version), and every patch is individually try/caught: a target that cannot be resolved logs once and is
/// skipped, never thrown — a missing hook means that node's VFX may leak, not a crash.</para>
/// </summary>
internal static class HeadlessParticleRestartNudgePatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome — don't repeat failed lookups on a second Install

            Harmony harmony;
            try
            {
                harmony = new Harmony("com.couchcoop.headless-particle-finish-nudge");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(
                    "[couchcoop] HeadlessParticleRestartNudgePatch: Harmony init failed "
                    + $"({ex.GetType().Name}: {ex.Message}); frozen one-shots restarted later will not report `finished`.");
                return;
            }

            var restartPostfix = typeof(HeadlessParticleRestartNudgePatch)
                .GetMethod(nameof(RestartPostfix), BindingFlags.NonPublic | BindingFlags.Static);
            var setEmittingPostfix = typeof(HeadlessParticleRestartNudgePatch)
                .GetMethod(nameof(SetEmittingPostfix), BindingFlags.NonPublic | BindingFlags.Static);
            if (restartPostfix is null || setEmittingPostfix is null)
            {
                Console.Error.WriteLine(
                    "[couchcoop] HeadlessParticleRestartNudgePatch: postfix methods were not found; skipping.");
                return;
            }

            var patched = 0;
            patched += TryPatchRestart(harmony, typeof(GpuParticles2D), restartPostfix) ? 1 : 0;
            patched += TryPatchRestart(harmony, typeof(CpuParticles2D), restartPostfix) ? 1 : 0;
            patched += TryPatchSetEmitting(harmony, typeof(GpuParticles2D), setEmittingPostfix) ? 1 : 0;
            patched += TryPatchSetEmitting(harmony, typeof(CpuParticles2D), setEmittingPostfix) ? 1 : 0;

            Console.Error.WriteLine(
                $"[couchcoop] HeadlessParticleRestartNudgePatch: installed ({patched}/{TargetCount} targets); "
                + "one-shot bursts started on frozen particle nodes now schedule a synthesized `finished`.");
        }
    }

    /// <summary>Number of (type × trigger) Harmony targets this patch installs — shared with the reflection test.</summary>
    internal const int TargetCount = 4;

    // Godot's binding exposes Restart as Restart() or Restart(bool keepSeed = false) depending on engine version;
    // resolve by NAME and take the first instance method so we never couple to one signature.
    private static bool TryPatchRestart(Harmony harmony, Type type, MethodInfo postfix)
    {
        try
        {
            MethodInfo? target = null;
            foreach (var method in type.GetMethods(BindingFlags.Instance | BindingFlags.Public))
            {
                if (method.Name == "Restart" && !method.IsGenericMethodDefinition)
                {
                    target = method;
                    break;
                }
            }

            if (target is null)
            {
                Console.Error.WriteLine(
                    $"[couchcoop] HeadlessParticleRestartNudgePatch: {type.Name}.Restart not found — "
                    + "a post-freeze restart on that type will not schedule a `finished` nudge.");
                return false;
            }

            harmony.Patch(target, postfix: new HarmonyMethod(postfix));
            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[couchcoop] HeadlessParticleRestartNudgePatch: patching {type.Name}.Restart failed "
                + $"({ex.GetType().Name}: {ex.Message}).");
            return false;
        }
    }

    private static bool TryPatchSetEmitting(Harmony harmony, Type type, MethodInfo postfix)
    {
        try
        {
            var target = type.GetProperty("Emitting")?.GetSetMethod();
            if (target is null)
            {
                Console.Error.WriteLine(
                    $"[couchcoop] HeadlessParticleRestartNudgePatch: {type.Name}.set_Emitting not found — "
                    + "a post-freeze `Emitting = true` on that type will not schedule a `finished` nudge.");
                return false;
            }

            harmony.Patch(target, postfix: new HarmonyMethod(postfix));
            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[couchcoop] HeadlessParticleRestartNudgePatch: patching {type.Name}.set_Emitting failed "
                + $"({ex.GetType().Name}: {ex.Message}).");
            return false;
        }
    }

    // Harmony binds __instance to the receiver. Restart() sets emitting NATIVELY (it does not go through the
    // managed set_Emitting), so this never double-fires with SetEmittingPostfix — and a duplicate schedule would
    // just overwrite the same map entry anyway.
    private static void RestartPostfix(GodotObject __instance)
        => CouchCoopHeadlessVisualSuspender.NotifyParticleRestarted(__instance);

    // The property setter's parameter is named `value`; Harmony binds postfix parameters by name. Only a set to
    // TRUE starts a burst — `Emitting = false` is a stop, which owes nobody a `finished`. That filter is also what
    // keeps the nudge from feeding itself: a due nudge CLEARS `Emitting` on the frozen node (see
    // CouchCoopHeadlessVisualSuspender.ComputeDueNudgeActions), and a postfix that treated that write as a new
    // burst would re-arm the entry that had just fired, forever.
    private static void SetEmittingPostfix(GodotObject __instance, bool value)
    {
        if (value)
        {
            CouchCoopHeadlessVisualSuspender.NotifyParticleRestarted(__instance);
        }
    }
}
