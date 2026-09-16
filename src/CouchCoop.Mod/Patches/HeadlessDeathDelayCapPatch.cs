using System;
using System.Globalization;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using CouchCoop.Mod.Session;
using HarmonyLib;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Headless-only deadlock backstop for the game's <c>IDeathDelayer</c> contract: caps the task returned by
/// <c>NCeremonialBeastVfx.GetDelayTask()</c> so a boss death sequence can never hang forever waiting on an
/// animation a frozen node will never play.
///
/// <para>The hang. A dying creature is not freed until every death-delayer attached to it says it is finished,
/// and that wait has no timeout of its own. The one death-delayer in the game reports finished off a SPINE
/// animation event — and a windowless couch instance freezes spine
/// (<c>CouchCoopHeadlessVisualSuspender.FreezeAllSpine</c>), so on that instance the event never arrives, the
/// wait never ends, and the creature is never freed. The particle <c>finished</c> nudge cannot rescue this one:
/// the missing signal is upstream of any particle state, so there is nothing to nudge.</para>
///
/// <para>The cap: a Harmony postfix replaces <c>__result</c> with an await-either of (the original task, a
/// <c>Task.Delay</c>). Natural completion always wins when the chain does run — the original's outcome is awaited
/// and propagated unchanged — and a timeout RETURNS NORMALLY rather than faulting, because the caller awaits it
/// bare and a fault would abort the rest of the death sequence instead of continuing it. Default cap 10s, chosen
/// against the real burst, which reports finished at ≈7.4s.</para>
///
/// <para>Env <c>COUCHCOOP_HEADLESS_DEATH_DELAY_CAP</c>: a positive number of seconds overrides the default.
/// Invalid or non-positive values retain the safe default. Installed from
/// <c>CouchCoopMod.Init</c>'s WINDOWLESS branch only — a windowed/interactive instance runs its spine, gets the
/// real animation event, and must keep the game's exact death pacing.</para>
///
/// <para>The target type is resolved by NAME-SCAN over the loaded game assembly (same style as
/// <see cref="HeadlessParticleRestartNudgePatch"/>'s by-name method resolution) rather than a compile-time
/// reference, and every step is try/caught: a rename or removal logs once and leaves the game unpatched.</para>
/// </summary>
internal static class HeadlessDeathDelayCapPatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>Cap used when <c>COUCHCOOP_HEADLESS_DEATH_DELAY_CAP</c> is unset (death particle lifetime 7s + margin).</summary>
    internal const double DefaultCapSeconds = 10.0;

    /// <summary>The game type whose <c>GetDelayTask</c> is capped. Shared with the reflection test.</summary>
    internal const string TargetTypeName = "NCeremonialBeastVfx";

    /// <summary>The capped method name. Shared with the reflection test.</summary>
    internal const string TargetMethodName = "GetDelayTask";

    // Resolved in Apply, read by the postfix. Written once before any patched call can run.
    private static double _capSeconds = DefaultCapSeconds;

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome

            var capSeconds = ParseCapSeconds(
                Environment.GetEnvironmentVariable("COUCHCOOP_HEADLESS_DEATH_DELAY_CAP"));
            _capSeconds = capSeconds;

            try
            {
                var target = ResolveTarget();
                if (target is null)
                {
                    CouchCoopLog.Stderr(
                        $"HeadlessDeathDelayCapPatch: {TargetTypeName}.{TargetMethodName} not found "
                        + "— a headless death sequence can still stall on a frozen death-particle signal.");
                    return;
                }

                var postfix = typeof(HeadlessDeathDelayCapPatch)
                    .GetMethod(nameof(CapDelayTaskPostfix), BindingFlags.NonPublic | BindingFlags.Static);
                if (postfix is null)
                {
                    CouchCoopLog.Stderr(
                        "HeadlessDeathDelayCapPatch: postfix method was not found; skipping.");
                    return;
                }

                new Harmony("com.couchcoop.headless-death-delay-cap")
                    .Patch(target, postfix: new HarmonyMethod(postfix));
                CouchCoopLog.Stderr(
                    $"HeadlessDeathDelayCapPatch: capped {TargetTypeName}.{TargetMethodName} at "
                    + $"{_capSeconds:0.##}s.");
            }
            catch (Exception ex)
            {
                // Seat-side backstop for a frozen death animation; its absence costs a stall, not a join.
                CouchCoopPatchDiagnostics.PatchFailed(
                    nameof(HeadlessDeathDelayCapPatch),
                    $"patching {TargetTypeName}.{TargetMethodName} failed ({ex.GetType().Name}: {ex.Message}).",
                    costsCoop: false);
            }
        }
    }

    /// <summary>
    /// COUCHCOOP_HEADLESS_DEATH_DELAY_CAP: unset/blank or an invalid/non-positive value ⇒
    /// <see cref="DefaultCapSeconds"/>; a positive number ⇒ that many seconds. Pure, for the reflection test.
    /// </summary>
    internal static double ParseCapSeconds(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return DefaultCapSeconds;
        }

        if (!double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
            || !double.IsFinite(seconds))
        {
            return DefaultCapSeconds;
        }

        return seconds > 0 ? seconds : DefaultCapSeconds;
    }

    /// <summary>
    /// Resolve <c>NCeremonialBeastVfx.GetDelayTask</c> by scanning the loaded game assembly for the bare type
    /// NAME — namespaces have moved between game versions, and the type is reachable here only through the
    /// <c>sts2</c> reference. Returns null when the game no longer declares it.
    /// </summary>
    internal static MethodInfo? ResolveTarget()
    {
        var sts2 = typeof(MegaCrit.Sts2.Core.Nodes.Audio.NAudioManager).Assembly;
        Type? beast = null;
        foreach (var type in sts2.GetTypes())
        {
            if (type.Name == TargetTypeName)
            {
                beast = type;
                break;
            }
        }

        return beast?.GetMethod(
            TargetMethodName,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
            binder: null,
            types: Type.EmptyTypes,
            modifiers: null);
    }

    // Harmony postfix. `__result` is the task the death sequence awaits; swap in a wrapper that also gives up
    // after the cap. Already-completed tasks are passed through untouched (no allocation on the common path).
    private static void CapDelayTaskPostfix(ref Task __result)
    {
        try
        {
            var original = __result;
            if (original is null || original.IsCompleted)
            {
                return;
            }

            __result = AwaitWithCapAsync(original, _capSeconds);
        }
        catch
        {
            // A backstop must never itself break the death sequence — leave the original task in place.
        }
    }

    // Await-either. The original's outcome is propagated unchanged when it wins (so a real completion keeps the
    // game's exact semantics, faults included); a timeout returns NORMALLY, because the caller awaits this bare
    // and a fault would abort the rest of the death sequence instead of continuing it. The CTS stops the losing
    // Task.Delay from holding a 10s timer after a natural completion.
    private static async Task AwaitWithCapAsync(Task original, double capSeconds)
    {
        using var cancelDelay = new CancellationTokenSource();
        var timeout = Task.Delay(TimeSpan.FromSeconds(capSeconds), cancelDelay.Token);
        var winner = await Task.WhenAny(original, timeout).ConfigureAwait(false);
        if (!ReferenceEquals(winner, original))
        {
            CouchCoopLog.Stderr(
                $"HeadlessDeathDelayCapPatch: {TargetTypeName}.{TargetMethodName} exceeded "
                + $"{capSeconds:0.##}s (frozen spine never raised the death-particle event); continuing the death sequence.");
            return;
        }

        cancelDelay.Cancel();
        await original.ConfigureAwait(false);
    }
}
