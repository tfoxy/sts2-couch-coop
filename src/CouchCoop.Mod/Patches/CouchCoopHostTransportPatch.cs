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
            if (CouchCoopHostTransport.SeamsResolve)
            {
                Patch(
                    harmony,
                    typeof(NetHostGameService),
                    "StartSteamHost",
                    [typeof(int)],
                    prefix: nameof(PrefixStartSteamHost));
            }
            else
            {
                Console.Error.WriteLine(
                    "[couch-coop] CouchCoopHostTransportPatch: NetHostGameService._netHost / Platform setter not found — "
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
                Console.Error.WriteLine(
                    "[couch-coop] CouchCoopHostTransportPatch: ENet host bookkeeping unavailable — couch seats will be "
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
    private static void PostfixStartENetHost(NetErrorInfo? __result)
        => CouchCoopHostTransport.NoteEnetHostStarted(failed: __result.HasValue);

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
            Console.Error.WriteLine(
                "[couch-coop] CouchCoopHostTransportPatch: NetHostGameService.NetId getter not found — "
                + "saved Steam runs may not load through an ENet fallback.");
            return;
        }

        try
        {
            harmony.Patch(NetIdGetter, prefix: new HarmonyMethod(Local(nameof(PrefixGetNetId))));
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] CouchCoopHostTransportPatch: NetHostGameService.NetId getter patch failed "
                + $"({exception.GetType().Name}: {exception.Message}) — saved Steam runs may not load through an ENet fallback.");
        }
    }

    /// <summary>Installs one patch; returns whether it is actually live.</summary>
    private static bool Patch(
        Harmony harmony,
        Type type,
        string name,
        Type[] args,
        string? prefix = null,
        string? postfix = null)
    {
        var label = $"{type.Name}.{name}({string.Join(", ", Array.ConvertAll(args, a => a.Name))})";
        var target = AccessTools.Method(type, name, args);
        if (target is null)
        {
            Console.Error.WriteLine($"[couch-coop] CouchCoopHostTransportPatch: {label} not found — host transport bookkeeping skipped.");
            return false;
        }

        try
        {
            harmony.Patch(
                target,
                prefix: prefix is null ? null : new HarmonyMethod(Local(prefix)),
                postfix: postfix is null ? null : new HarmonyMethod(Local(postfix)));
            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[couch-coop] CouchCoopHostTransportPatch: Harmony patch of {label} failed ({ex.GetType().Name}: {ex.Message}).");
            return false;
        }
    }

    private static MethodInfo Local(string name)
        => typeof(CouchCoopHostTransportPatch).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new MissingMethodException(nameof(CouchCoopHostTransportPatch), name);
}
