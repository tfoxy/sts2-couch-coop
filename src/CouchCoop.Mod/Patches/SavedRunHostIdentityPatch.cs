using System.Reflection;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;
using MegaCrit.Sts2.Core.Platform;
using MegaCrit.Sts2.Core.Saves;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Carries a saved host's Steam identity into the immediately following host start. This is needed only when a
/// Steam-created save falls back to ENet: its saved lobby seat is keyed by the Steam id, while a plain ENet host
/// always reports id 1. The save's transport label cannot select this lookup: a Steam-hosted run may retain the
/// ENet label after offline recovery even though its host player is still keyed by Steam id.
/// </summary>
internal static class SavedRunHostIdentityPatch
{
    private static readonly object Sync = new();
    private static bool _applied;

    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets =>
    [
        (typeof(NMultiplayerSubmenu), "StartHost", [typeof(SerializableRun)]),
    ];

    internal static void Apply()
    {
        lock (Sync)
        {
            if (_applied) return;
            _applied = true;

            try
            {
                var target = AccessTools.Method(typeof(NMultiplayerSubmenu), "StartHost", [typeof(SerializableRun)])
                    ?? throw new MissingMethodException("Saved-run host identity target was not found");
                new Harmony("com.couchcoop.saved-run-host-identity").Patch(
                    target,
                    prefix: new HarmonyMethod(Local(nameof(PrefixStartHost))));
            }
            catch (Exception exception)
            {
                CouchCoopMod.DisableFeature(nameof(SavedRunHostIdentityPatch), exception);
                // Degraded, not lost: a saved Steam run falls back to stock hosting rather than becoming
                // unjoinable, so this records and logs without adding a row the player cannot act on.
                CouchCoopPatchDiagnostics.PatchFailed(
                    nameof(SavedRunHostIdentityPatch),
                    $"patch failed ({exception.GetType().Name}: {exception.Message}) — saved runs use stock hosting.",
                    costsCoop: false);
            }
        }
    }

    private static void PrefixStartHost(SerializableRun run)
    {
        try
        {
            // StartHostAsync only consumes this handoff when the CURRENT launch chose the Steam path. Use the
            // current Steam identity, not run.PlatformType: the latter describes the saved transport and can be
            // None for a Steam-created run that was previously recovered through ENet.
            var localPlayerId = PlatformUtil.GetLocalPlayerId(PlatformType.Steam);
            CouchCoopHostTransport.ArmSavedRunHostNetId(ResolveSavedRunHostNetId(localPlayerId, run));
        }
        catch (Exception exception)
        {
            CouchCoopHostTransport.ClearSavedRunHostNetId();
            CouchCoopHostTransport.Log(
                $"could not resolve saved-run host identity ({exception.GetType().Name}: {exception.Message}) — using stock ENet identity if fallback is needed.");
        }
    }

    /// <summary>
    /// Resolves the local saved host from the current Steam identity. The run's platform label intentionally does
    /// not participate: it reflects the saved transport and can be ENet after a prior offline recovery.
    /// </summary>
    internal static ulong? ResolveSavedRunHostNetId(ulong currentSteamPlayerId, SerializableRun run)
    {
        ArgumentNullException.ThrowIfNull(run);
        return CouchCoopHostTransport.ResolveSavedRunHostNetId(
            currentSteamPlayerId,
            run.Players?.Select(player => player.NetId));
    }

    private static MethodInfo Local(string name)
        => typeof(SavedRunHostIdentityPatch).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new MissingMethodException(nameof(SavedRunHostIdentityPatch), name);
}
