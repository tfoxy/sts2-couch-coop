using System.Reflection;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Keeps <see cref="CouchCoopHostTransport"/> in step with the live <c>NetHostGameService</c>.
/// <para>
/// Stage 0 (this file's postfixes) is pure bookkeeping and changes NO behavior: whenever the game starts an ENet
/// host or tears a host down, we record what the couch side needs to know (host netId, whether an ENet listener
/// exists for seats to join). Later stages add the <c>StartSteamHost</c> prefix that installs the composite host.
/// </para>
/// </summary>
internal static class CouchCoopHostTransportPatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>
    /// The exact game members this patch binds to, shared with the reflection guard test so a game update that
    /// renames one fails the build instead of silently leaving the host un-instrumented.
    /// </summary>
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        (typeof(NetHostGameService), "StartSteamHost", [typeof(int)]),
        (typeof(NetHostGameService), "StartENetHost", [typeof(ushort), typeof(int)]),
        (typeof(NetHostGameService), "Disconnect", [typeof(NetError), typeof(bool)]),
    ];

    /// <summary>
    /// The game-service identity is distinct from ENet's transport registration. The saved-run fallback must
    /// override this getter as well, because <c>LoadRunLobby</c> uses it to add the local player and to find that
    /// player's saved record.
    /// </summary>
    internal static MethodInfo? NetIdGetter { get; } =
        AccessTools.PropertyGetter(typeof(NetHostGameService), nameof(NetHostGameService.NetId));

    /// <summary>
    /// Where every patch here sits in Harmony's ordering unless it asks for something else: the default, which is
    /// also what Harmony gives a <c>HarmonyMethod</c> whose priority was never set.
    /// </summary>
    internal const int DefaultPatchPriority = Priority.Normal;

    /// <summary>
    /// The ONE ordering that is load-bearing — see the reasoning at the <c>StartSteamHost</c> patch site. Named
    /// here so the regression guard test can assert it, and assert that nothing else moved off the default.
    /// </summary>
    internal const int StartSteamHostPrefixPriority = Priority.Last;

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome

            var harmony = new Harmony("com.couchcoop.host-transport");

            // A PREFIX, not a postfix: by the time a postfix could run, the service already owns a plain
            // single-transport host and the ENet side could never share it. Replacing the call outright is the only
            // place the composite-host decision fits.
            // Guarded on the reflection seams: if either is missing we leave the stock method alone rather than
            // hand the game a half-built host.
            //
            // Priority.Last, because this prefix REPLACES the implementation rather than adjusting an argument.
            // Harmony runs prefixes in priority order and stops running the ones that could still affect the
            // original the moment any prefix returns false — which ours always does. The multiplayer limit mods
            // are exactly the shape that gets cut off: they raise the client cap by rewriting the maxClients
            // argument from a prefix on this same method, and none of them claims an ordering. At the default
            // priority Harmony falls back to registration order, couchcoop loads before the Workshop mods, and so
            // OUR prefix ran first and theirs never ran at all — the listener was built for the stock cap while
            // the lobby, created after this call, went on to admit far more. Registering last means we are handed
            // the argument after everyone else has finished adjusting it, and we size the transport from the value
            // they produced.
            //
            // The trade is that a mod returning false AHEAD of us leaves hosting stock: no composite host, no
            // couch seats beside a Steam lobby, no Steam-offline fallback. That is the same degradation this patch
            // already accepts when SeamsResolve is false, and it is the right one — a mod that has claimed this
            // method outright owns the host flow, and half-installing ourselves over it would be worse than
            // standing down.
            if (CouchCoopHostTransport.SeamsResolve)
            {
                Patch(
                    harmony,
                    typeof(NetHostGameService),
                    "StartSteamHost",
                    [typeof(int)],
                    prefix: nameof(PrefixStartSteamHost),
                    prefixPriority: StartSteamHostPrefixPriority);
            }
            else
            {
                CouchCoopLog.Stderr(
                    "CouchCoopHostTransportPatch: NetHostGameService._netHost / Platform setter not found — "
                    + "hosting left STOCK (no Steam-offline fallback, no couch seats on a Steam-hosted session).");
            }

            var enetBookkeeping = Patch(
                harmony,
                typeof(NetHostGameService),
                "StartENetHost",
                [typeof(ushort), typeof(int)],
                postfix: nameof(PostfixStartENetHost));

            Patch(
                harmony,
                typeof(NetHostGameService),
                "Disconnect",
                [typeof(NetError), typeof(bool)],
                postfix: nameof(PostfixDisconnect));

            PatchNetIdGetter(harmony);

            // Only now may anything GATE on the transport state. Until this flips, EnetAvailable means "nobody has
            // told us", and the seat launcher must fail OPEN — a renamed StartENetHost should degrade to the old
            // ungated behavior, not to "no couch player may ever join".
            CouchCoopHostTransport.BookkeepingInstalled = enetBookkeeping;
            if (!enetBookkeeping)
            {
                CouchCoopLog.Stderr(
                    "CouchCoopHostTransportPatch: ENet host bookkeeping unavailable — couch seats will be "
                    + "launched unguarded (pre-WS-1 behavior).");
            }
        }
    }

    // Harmony prefix on NetHostGameService.StartSteamHost(int). Returns false (skip the original) and hands back
    // our own Task: the stock path builds a single-transport Steam host, and a failure there aborts the whole host
    // flow with an error popup — no fallback, no couch seats.
    private static bool PrefixStartSteamHost(NetHostGameService __instance, int maxClients, ref Task<NetErrorInfo?> __result)
    {
        __result = CouchCoopHostTransport.StartHostAsync(__instance, maxClients);
        return false;
    }

    // Postfix on NetHostGameService.StartENetHost(ushort, int): a plain ENet host is running (the stock -fastmp
    // path, the debug multiplayer screen, or a Steam-uninitialized launch). Host netId is 1 and couch seats can
    // join — unless the port bind failed, which the game reports as a non-null NetErrorInfo.
    // maxClients is taken so this path can state the cap the listener was actually built for, exactly as the
    // host-start path does. A POSTFIX sees the final value, after any limit mod's prefix rewrote it, so the one
    // log line answers "how many clients could connect?" on the transport we did not build ourselves either.
    private static void PostfixStartENetHost(int maxClients, NetErrorInfo? __result)
        => CouchCoopHostTransport.NoteEnetHostStarted(failed: __result.HasValue, maxClients);

    // Postfix on NetHostGameService.Disconnect(NetError, bool): the hosting session is over. Clearing here (rather
    // than only on the next start) matters because the browser server keeps reading these statics — a stale
    // EnetAvailable would let it spawn a seat into a host that no longer exists.
    private static void PostfixDisconnect() => CouchCoopHostTransport.ResetSession();

    // This leaves the native getter alone unless this is the exact service which won a saved-run Steam-offline
    // fallback. The saved-run ENet host still owns its wire identity; this supplies the same identity to the game
    // layer that builds LoadRunLobby and later resolves the local SerializablePlayer.
    private static bool PrefixGetNetId(NetHostGameService __instance, ref ulong __result)
    {
        if (!CouchCoopHostTransport.TryGetSavedRunFallbackHostNetId(__instance, out var savedRunHostNetId))
        {
            return true;
        }

        __result = savedRunHostNetId;
        return false;
    }

    private static void PatchNetIdGetter(Harmony harmony)
    {
        if (NetIdGetter is null)
        {
            CouchCoopLog.Stderr(
                "CouchCoopHostTransportPatch: NetHostGameService.NetId getter not found — "
                + "saved Steam runs may not load through an ENet fallback.");
            return;
        }

        try
        {
            // Default ordering on purpose: this prefix only reports an identity for one specific service, so it
            // neither replaces anything nor competes with another mod for the argument.
            harmony.Patch(NetIdGetter, prefix: new HarmonyMethod(Local(nameof(PrefixGetNetId)), DefaultPatchPriority));
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr(
                $"CouchCoopHostTransportPatch: NetHostGameService.NetId getter patch failed "
                + $"({exception.GetType().Name}: {exception.Message}) — saved Steam runs may not load through an ENet fallback.");
        }
    }

    /// <summary>
    /// Installs one patch; returns whether it is actually live. <paramref name="prefixPriority"/> is threaded
    /// rather than hardcoded per target so exactly one call site has to justify an ordering and every other keeps
    /// Harmony's default — which is what the guard test asserts.
    /// </summary>
    private static bool Patch(
        Harmony harmony,
        Type type,
        string name,
        Type[] args,
        string? prefix = null,
        string? postfix = null,
        int prefixPriority = DefaultPatchPriority)
    {
        var label = $"{type.Name}.{name}({string.Join(", ", Array.ConvertAll(args, a => a.Name))})";
        var target = AccessTools.Method(type, name, args);
        if (target is null)
        {
            CouchCoopLog.Stderr($"CouchCoopHostTransportPatch: {label} not found — host transport bookkeeping skipped.");
            return false;
        }

        try
        {
            harmony.Patch(
                target,
                prefix: prefix is null ? null : new HarmonyMethod(Local(prefix), prefixPriority),
                postfix: postfix is null ? null : new HarmonyMethod(Local(postfix), DefaultPatchPriority));
            return true;
        }
        catch (Exception ex)
        {
            // The seat launcher refuses to spawn when it cannot tell that this host is running the ENet side,
            // so losing this bookkeeping costs seat joining rather than merely a statistic.
            CouchCoopPatchDiagnostics.PatchFailed(
                nameof(CouchCoopHostTransportPatch),
                $"Harmony patch of {label} failed ({ex.GetType().Name}: {ex.Message}).",
                costsCoop: true);
            return false;
        }
    }

    private static MethodInfo Local(string name)
        => typeof(CouchCoopHostTransportPatch).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new MissingMethodException(nameof(CouchCoopHostTransportPatch), name);
}
