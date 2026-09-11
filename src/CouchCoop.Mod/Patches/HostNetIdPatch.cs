using System.Globalization;
using System.Reflection;
using HarmonyLib;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Multiplayer.Quality;
using MegaCrit.Sts2.Core.Multiplayer.Transport.ENet;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Teaches a headless couch seat who its host actually is.
///
/// <para><b>The problem.</b> <c>ENetClient.HostNetId</c> reports a fixed <c>1uL</c> — right when the ENet host IS
/// netId 1, but a Steam-hosted session's host answers to its SteamID64. The seat learns the real id from the
/// packets it receives, so its heartbeat replies are addressed to that SteamID64 — and a client may only send to
/// its own host id, so every reply throws. The host heartbeats every 200ms, which means a seat throwing five
/// times a second for as long as it is connected.</para>
///
/// <para><b>The fix, in two layers.</b>
/// <list type="number">
///   <item>Prefix the <c>ENetClient.HostNetId</c> getter with the id the host handed us in
///     <c>COUCHCOOP_HOST_NETID</c>. This is the real cure: the client's quality tracker, its disconnect
///     bookkeeping and its send guard then all agree on one identity.</item>
///   <item>Coerce <c>senderId</c> in <c>NetQualityTracker.HandleHeartbeatRequestMessage</c> to whatever the local
///     client's <c>HostNetId</c> currently is. A one-line property getter is a prime inlining candidate, so if
///     layer 1 is bypassed this still keeps the echo on the only address the client is allowed to send to. When
///     layer 1 did take, this is a no-op (the two values are already equal).</item>
/// </list></para>
///
/// <para>Headless-seat only, and only when the host reports a netId other than 1 (an ENet-hosted session already
/// matches the stock value and takes the unpatched path).</para>
/// </summary>
internal static class HostNetIdPatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>Env var carrying the HOST's netId, set on the seat process by <c>HeadlessClientManager</c>.</summary>
    internal const string HostNetIdEnvVar = "COUCHCOOP_HOST_NETID";

    private static ulong _hostNetId;
    private static FieldInfo? _netServiceField;

    /// <summary>The game members this patch binds to, shared with the reflection guard test.</summary>
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        (typeof(ENetClient), "get_HostNetId", []),
        (typeof(NetQualityTracker), "HandleHeartbeatRequestMessage",
            [typeof(MegaCrit.Sts2.Core.Multiplayer.Messages.HeartbeatRequestMessage), typeof(ulong)]),
    ];

    /// <summary>
    /// Parses the host netId the seat was launched with. Pure. Returns null for anything that isn't a real,
    /// non-default host id: unset, blank, unparseable, 0, or 1 (which is what the transport already reports, so
    /// there is nothing to patch).
    /// </summary>
    internal static ulong? ResolveHostNetId(string? raw)
    {
        var trimmed = raw?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        if (!ulong.TryParse(trimmed, NumberStyles.None, CultureInfo.InvariantCulture, out var value)) return null;
        return value > 1UL ? value : null;
    }

    internal static void Apply()
    {
        lock (_sync)
        {
            if (_applied) return;
            _applied = true; // one-shot regardless of outcome

            if (ResolveHostNetId(Environment.GetEnvironmentVariable(HostNetIdEnvVar)) is not ulong hostNetId)
            {
                // ENet-hosted session (host netId 1) or no value: the stock HostNetId is already right.
                return;
            }

            _hostNetId = hostNetId;
            var harmony = new Harmony("com.couchcoop.host-netid");

            var getter = AccessTools.PropertyGetter(typeof(ENetClient), "HostNetId");
            if (getter is null)
            {
                Console.Error.WriteLine("[couch-coop] HostNetIdPatch: ENetClient.HostNetId getter not found — relying on the heartbeat coercion alone.");
            }
            else
            {
                TryPatch(harmony, getter, nameof(PrefixHostNetId), "ENetClient.get_HostNetId");
            }

            var heartbeat = AccessTools.Method(
                typeof(NetQualityTracker),
                "HandleHeartbeatRequestMessage",
                [typeof(MegaCrit.Sts2.Core.Multiplayer.Messages.HeartbeatRequestMessage), typeof(ulong)]);
            if (heartbeat is null)
            {
                Console.Error.WriteLine("[couch-coop] HostNetIdPatch: NetQualityTracker.HandleHeartbeatRequestMessage not found — inlining fallback unavailable.");
                return;
            }

            _netServiceField = AccessTools.Field(typeof(NetQualityTracker), "_netService");
            if (_netServiceField is null)
            {
                Console.Error.WriteLine("[couch-coop] HostNetIdPatch: NetQualityTracker._netService not found — inlining fallback unavailable.");
                return;
            }

            TryPatch(harmony, heartbeat, nameof(PrefixHandleHeartbeatRequestMessage), "NetQualityTracker.HandleHeartbeatRequestMessage");
        }
    }

    // Harmony prefix on ENetClient.HostNetId's getter: report the host's real netId instead of the stock one.
    private static bool PrefixHostNetId(ref ulong __result)
    {
        __result = _hostNetId;
        return false;
    }

    // Harmony prefix on NetQualityTracker.HandleHeartbeatRequestMessage(HeartbeatRequestMessage, ulong senderId).
    // Rewrites senderId to the address this client is actually allowed to send to. On a client that is exactly the
    // host, so the echo still reaches the right peer; it just can no longer throw.
    private static bool PrefixHandleHeartbeatRequestMessage(object __instance, ref ulong senderId)
    {
        try
        {
            if (_netServiceField?.GetValue(__instance) is INetClientGameService clientService
                && clientService.NetClient is { } netClient
                && netClient.HostNetId != senderId)
            {
                senderId = netClient.HostNetId;
            }
        }
        catch
        {
            // Never let the coercion break the heartbeat path; the un-coerced call is what the stock game does.
        }

        return true;
    }

    private static void TryPatch(Harmony harmony, MethodBase target, string prefix, string label)
    {
        try
        {
            var method = typeof(HostNetIdPatch).GetMethod(prefix, BindingFlags.NonPublic | BindingFlags.Static);
            harmony.Patch(target, prefix: new HarmonyMethod(method));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[couch-coop] HostNetIdPatch: Harmony patch of {label} failed ({ex.GetType().Name}: {ex.Message}).");
        }
    }
}
