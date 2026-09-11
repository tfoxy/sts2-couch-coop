using System.Reflection;
using HarmonyLib;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Patches <c>ENetClient.Update()</c> so it does nothing until the client is connected.
///
/// Without this, a headless couch seat's ENet join intermittently TIMES OUT: two things race for the host's
/// handshake ack, and when the frame-driven update loop wins it the join path never sees the ack and gives up
/// after its own polling window. Making the update loop inert until the connection is established leaves the ack
/// where the join path can consume it, and the loop then runs normally for the rest of the session.
///
/// The connection flag is read reflectively (see <c>Apply</c>) — a game update that renames it logs and skips the
/// patch rather than throwing during mod init.
/// </summary>
internal static class ENetHandshakePatch
{
    private static readonly object _sync = new();
    private static bool _applied;
    private static FieldInfo? _isConnectedField;

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;

            var target = AccessTools.Method("ENetClient:Update");
            if (target is null)
            {
                Console.Error.WriteLine("[couch-coop] ENetHandshakePatch: ENetClient.Update not found — handshake patch skipped.");
                return;
            }

            _isConnectedField = AccessTools.Field(target.DeclaringType!, "_isConnected");
            if (_isConnectedField is null)
            {
                Console.Error.WriteLine("[couch-coop] ENetHandshakePatch: ENetClient._isConnected not found — handshake patch skipped.");
                return;
            }

            var prefix = typeof(ENetHandshakePatch).GetMethod(nameof(PrefixUpdate), BindingFlags.NonPublic | BindingFlags.Static);
            try
            {
                new Harmony("com.couchcoop.enet-handshake").Patch(target, prefix: new HarmonyMethod(prefix));
                _applied = true;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[couch-coop] ENetHandshakePatch: Harmony patch failed ({ex.GetType().Name}: {ex.Message}) — handshake patch skipped.");
            }
        }
    }

    // Harmony prefix on ENetClient.Update().
    // Returns false (skip the original) until the client reports itself connected, so the update loop cannot
    // consume the handshake ack before the join path's own poll gets to it.
    private static bool PrefixUpdate(object __instance)
    {
        if (_isConnectedField is null) return true;
        return (bool)_isConnectedField.GetValue(__instance)!;
    }
}
