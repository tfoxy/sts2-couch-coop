using System.Globalization;
using System.Reflection;
using HarmonyLib;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Multiplayer.Quality;
using MegaCrit.Sts2.Core.Multiplayer.Transport.ENet;
#if STS2_API_V111
using MegaCrit.Sts2.Core.Multiplayer.Connection;
#endif

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
/// <para><b>The fix, in three layers.</b>
/// <list type="number">
///   <item>Prefix the <c>ENetClient.HostNetId</c> getter with the id the host handed us in
///     <c>COUCHCOOP_HOST_NETID</c>. This is the real cure: the client's quality tracker, its disconnect
///     bookkeeping and its send guard then all agree on one identity.</item>
///   <item>Coerce <c>senderId</c> in <c>NetQualityTracker.HandleHeartbeatRequestMessage</c> to whatever the local
///     client's <c>HostNetId</c> currently is. A one-line property getter is a prime inlining candidate, so if
///     layer 1 is bypassed this still keeps the echo on the only address the client is allowed to send to. When
///     layer 1 did take, this is a no-op (the two values are already equal).</item>
///   <item><b>v0.111.0 and later only.</b> Coerce <c>senderId</c> in
///     <c>HandshakeManager.HandshakeMessageReceived</c> from the transport's placeholder <c>1</c> to that same
///     host id. See below — this is the layer without which a Steam-hosted beta seat cannot join at all.</item>
/// </list></para>
///
/// <para><b>Why layer 3 exists.</b> The two ends of this identity have always disagreed and it never mattered:
/// the transport reports the host as <c>1</c> on the way IN (every inbound packet is labelled with that fixed
/// sender id, whoever actually sent it), while the patched getter reports the SteamID64 on the way OUT. Ordinary
/// traffic never notices, because a message's true sender travels inside its payload and replaces the transport's
/// label once the message is deserialized. v0.111.0 added a peer-version handshake that is matched to its
/// in-progress record by the raw transport label instead, and the client registers that record under
/// <c>ENetClient.HostNetId</c> — so the beta's handshake is the first code path that compares the two, and on a
/// Steam-hosted session it finds <c>1</c> where the seat filed a SteamID64. The seat then never answers and the
/// host drops it at its 10s handshake deadline (<c>HandshakeTimeout</c>) — the whole join, not a logged throw.
/// One substitution settles every consumer downstream of it at once: the in-progress lookup, its removal, the
/// address the reply is written to (a client may only send to its own host id, so the reply must be addressed to
/// the PATCHED id and not to <c>1</c>), and the success callback that hands the id to the quality tracker.</para>
///
/// <para>The alternative — dropping layer 1 so the getter reports the stock <c>1</c> — would also make the two
/// ends agree, but it un-fixes the heartbeat throw layer 1 exists to cure and changes every other client-side
/// identity comparison on the shipped stable lane. Layer 3 is additive and beta-only.</para>
///
/// <para>Headless-seat only, and only when the host reports a netId other than 1 (an ENet-hosted session already
/// matches the stock value and takes the unpatched path). Layer 3 additionally refuses to touch anything unless
/// the manager it is running inside belongs to a CLIENT (<c>IHandshakeHandler.Type</c>): a host process owns a
/// <c>HandshakeManager</c> too, and there <c>senderId</c> is a real joining peer's netId that must never be
/// rewritten.</para>
/// </summary>
internal static class HostNetIdPatch
{
    private static readonly object _sync = new();
    private static bool _applied;

    /// <summary>Env var carrying the HOST's netId, set on the seat process by <c>HeadlessClientManager</c>.</summary>
    internal const string HostNetIdEnvVar = "COUCHCOOP_HOST_NETID";

    /// <summary>
    /// The sender id the ENet transport stamps on every inbound packet, whoever actually sent it. It is right by
    /// accident on an ENet-hosted session (the host IS netId 1) and wrong on a Steam-hosted one.
    /// </summary>
    internal const ulong TransportSenderPlaceholder = 1UL;

    private static ulong _hostNetId;
    private static FieldInfo? _netServiceField;
#if STS2_API_V111
    private static FieldInfo? _handshakeHandlerField;
#endif

    /// <summary>The game members this patch binds to, shared with the reflection guard test.</summary>
    internal static IReadOnlyList<(Type Type, string Name, Type[] Args)> Targets { get; } =
    [
        (typeof(ENetClient), "get_HostNetId", []),
        (typeof(NetQualityTracker), "HandleHeartbeatRequestMessage",
            [typeof(MegaCrit.Sts2.Core.Multiplayer.Messages.HeartbeatRequestMessage), typeof(ulong)]),
#if STS2_API_V111
        // Layer 3. The peer-version handshake does not exist on v0.107.1, so neither does this target.
        (typeof(HandshakeManager), "HandshakeMessageReceived",
            [typeof(ulong), typeof(MegaCrit.Sts2.Core.Multiplayer.Serialization.PacketReader)]),
#endif
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

    /// <summary>
    /// Layer 3's whole decision, as a pure function so it can be tested without Harmony or a game process: the
    /// inbound handshake's sender id, and the host netId this seat was launched with, in — the sender id the
    /// handshake should have been told about, out.
    ///
    /// <para>Only the transport's <see cref="TransportSenderPlaceholder"/> is rewritten, and only when we have a
    /// real host id to rewrite it to. Anything else is somebody we have no claim about, so it passes through
    /// untouched and the game keeps its stock behaviour for it.</para>
    ///
    /// <para>Deliberately NOT compiled out on the v107 lane even though only the v111 patch calls it: it is
    /// arithmetic over two <c>ulong</c>s with no game types in it, so keeping it lane-independent lets the gate
    /// test cover it on every build rather than only the one where it happens to be wired up.</para>
    /// </summary>
    internal static ulong CoerceHandshakeSenderId(ulong senderId, ulong hostNetId)
    {
        if (hostNetId <= TransportSenderPlaceholder) return senderId;
        return senderId == TransportSenderPlaceholder ? hostNetId : senderId;
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

            // One call per layer, and each one bails on its own missing members: they cure different failures, so
            // a layer that cannot bind must not take the others down with it.
            ApplyHostNetIdGetter(harmony);
            ApplyHeartbeatCoercion(harmony);
#if STS2_API_V111
            ApplyHandshakeSenderCoercion(harmony);
#endif
        }
    }

    // Layer 1.
    private static void ApplyHostNetIdGetter(Harmony harmony)
    {
        var getter = AccessTools.PropertyGetter(typeof(ENetClient), "HostNetId");
        if (getter is null)
        {
            Console.Error.WriteLine("[couchcoop] HostNetIdPatch: ENetClient.HostNetId getter not found — relying on the heartbeat coercion alone.");
            return;
        }

        TryPatch(harmony, getter, nameof(PrefixHostNetId), "ENetClient.get_HostNetId");
    }

    // Layer 2.
    private static void ApplyHeartbeatCoercion(Harmony harmony)
    {
        var heartbeat = AccessTools.Method(
            typeof(NetQualityTracker),
            "HandleHeartbeatRequestMessage",
            [typeof(MegaCrit.Sts2.Core.Multiplayer.Messages.HeartbeatRequestMessage), typeof(ulong)]);
        if (heartbeat is null)
        {
            Console.Error.WriteLine("[couchcoop] HostNetIdPatch: NetQualityTracker.HandleHeartbeatRequestMessage not found — inlining fallback unavailable.");
            return;
        }

        _netServiceField = AccessTools.Field(typeof(NetQualityTracker), "_netService");
        if (_netServiceField is null)
        {
            Console.Error.WriteLine("[couchcoop] HostNetIdPatch: NetQualityTracker._netService not found — inlining fallback unavailable.");
            return;
        }

        TryPatch(harmony, heartbeat, nameof(PrefixHandleHeartbeatRequestMessage), "NetQualityTracker.HandleHeartbeatRequestMessage");
    }

#if STS2_API_V111
    // Layer 3.
    private static void ApplyHandshakeSenderCoercion(Harmony harmony)
    {
        var received = AccessTools.Method(
            typeof(HandshakeManager),
            "HandshakeMessageReceived",
            [typeof(ulong), typeof(MegaCrit.Sts2.Core.Multiplayer.Serialization.PacketReader)]);
        if (received is null)
        {
            Console.Error.WriteLine("[couchcoop] HostNetIdPatch: HandshakeManager.HandshakeMessageReceived not found — a Steam-hosted seat will time out on the peer-version handshake.");
            return;
        }

        // Read in the same style as NetQualityTracker._netService: the handler is how the prefix tells a client's
        // handshake manager from a host's, and without it the prefix leaves senderId alone (see the prefix).
        _handshakeHandlerField = AccessTools.Field(typeof(HandshakeManager), "_handler");
        if (_handshakeHandlerField is null)
        {
            Console.Error.WriteLine("[couchcoop] HostNetIdPatch: HandshakeManager._handler not found — refusing to coerce a handshake sender we cannot prove belongs to a client.");
            return;
        }

        TryPatch(harmony, received, nameof(PrefixHandshakeMessageReceived), "HandshakeManager.HandshakeMessageReceived");
    }
#endif

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

#if STS2_API_V111
    // Harmony prefix on HandshakeManager.HandshakeMessageReceived(ulong senderId, PacketReader reader).
    // Rewrites the transport's placeholder sender to the host id this seat was launched with, so the handshake is
    // matched to — and answered at — the identity the rest of the client already uses. Runs only on a CLIENT's
    // handshake manager; on a host's, senderId is a real joining peer and nothing is touched.
    private static bool PrefixHandshakeMessageReceived(object __instance, ref ulong senderId)
    {
        try
        {
            if (_handshakeHandlerField?.GetValue(__instance) is IHandshakeHandler { Type: NetGameType.Client })
            {
                senderId = CoerceHandshakeSenderId(senderId, _hostNetId);
            }
        }
        catch
        {
            // Fail safe: an un-coerced handshake is the stock game's behaviour, and it is the host's decision
            // what to do with it. Never let the coercion itself be what breaks a join.
        }

        return true;
    }
#endif

    private static void TryPatch(Harmony harmony, MethodBase target, string prefix, string label)
    {
        try
        {
            var method = typeof(HostNetIdPatch).GetMethod(prefix, BindingFlags.NonPublic | BindingFlags.Static);
            harmony.Patch(target, prefix: new HarmonyMethod(method));
        }
        catch (Exception ex)
        {
            // Seat-side, and the seat cannot stay joined to a Steam-hosted session without it.
            CouchCoopPatchDiagnostics.PatchFailed(
                nameof(HostNetIdPatch),
                $"Harmony patch of {label} failed ({ex.GetType().Name}: {ex.Message}).",
                costsCoop: true);
        }
    }
}
