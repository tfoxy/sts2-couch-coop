using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer.Transport;
using MegaCrit.Sts2.Core.Multiplayer.Transport.ENet;
using MegaCrit.Sts2.Core.Multiplayer.Transport.Steam;

namespace CouchCoop.Mod.Session;

/// <summary>Which transport a peer lives on.</summary>
internal enum DualHostSide
{
    Steam,
    Enet,
}

/// <summary>
/// The peer→transport decision, kept pure and separate from <see cref="DualNetHost"/> so it can be tested without
/// a Steam runtime.
/// </summary>
internal static class DualHostRouting
{
    /// <summary>
    /// Routes a peer by MEMBERSHIP of the Steam side, and sends everything else — including ids we have never
    /// heard of — to ENet.
    /// <para>
    /// The asymmetry is deliberate and load-bearing: <c>SteamHost.SendMessageToClient</c> THROWS
    /// (<c>InvalidOperationException</c>, "Could not find connection for peer") when it doesn't know the peer,
    /// while <c>ENetHost.SendMessageToClient</c> only logs an error. A stale or racing id must therefore land on
    /// the side that tolerates it; guessing "big number ⇒ Steam" would turn a dropped couch seat into a thrown
    /// exception inside the game's own broadcast loop.
    /// </para>
    /// </summary>
    internal static DualHostSide RouteFor(ulong peerId, IEnumerable<ulong> steamPeerIds)
    {
        foreach (var steamPeerId in steamPeerIds)
        {
            if (steamPeerId == peerId)
            {
                return DualHostSide.Steam;
            }
        }

        return DualHostSide.Enet;
    }
}

/// <summary>
/// One <c>NetHost</c> that is BOTH a Steam host and an ENet host, so a single <c>NetHostGameService</c> can carry
/// remote Steam friends and local couch seats in the same lobby.
///
/// <para><b>Why this is possible at all.</b> The lobby itself is transport-agnostic: <c>StartRunLobby</c> keys
/// players by a 64-bit netId and allocates the first free of 4 slots. The service's broadcast fans out PER PEER
/// through <c>NetHost.SendMessageToClient</c> (it never calls <c>SendMessageToAll</c>), and the sender id travels
/// inside the payload — so one routing override covers every message type without patching the generic
/// <c>SendMessage&lt;T&gt;</c>. And <c>_connectedPeers</c> lives on the SERVICE, populated from handler callbacks,
/// so a second <c>ENetHost</c> pointed at the same service feeds the identical pipeline.</para>
///
/// <para><b>Why it derives from <c>SteamHost</c> rather than <c>NetHost</c>.</b>
/// <c>SteamPlatformUtilStrategy</c> pattern-matches <c>NetHost: SteamHost { LobbyId: ... }</c> to drive the
/// in-lobby Invite button. A composite deriving straight from <c>NetHost</c> would silently break invites on a
/// Steam-hosted session. Deriving from <c>SteamHost</c> also means <c>NetId</c> (our SteamID64),
/// <c>GetRawLobbyIdentifier</c> and the whole lobby lifecycle are inherited unchanged.</para>
///
/// <para><b>The ENet side's handler shim.</b> <c>ENetHost.StopHost</c> unconditionally fires
/// <c>_handler.OnDisconnected</c>, and so does <c>SteamHost.StopHost</c>. Handing both the real service would
/// report the host as disconnected twice. The inner ENet host therefore talks to a <see cref="SideHandler"/> that
/// forwards peer traffic verbatim and drops <c>OnDisconnected</c>; the single notification always comes from the
/// Steam side (or from us, if that throws first).</para>
/// </summary>
internal sealed class DualNetHost : SteamHost
{
    private readonly INetHostHandler _service;
    private readonly SideHandler _enetHandler;
    private readonly ENetHost _enet;
    private bool _enetStarted;
    private bool _enetUpdateFailureLogged;

    internal DualNetHost(INetHostHandler handler)
        : base(handler)
    {
        _service = handler ?? throw new ArgumentNullException(nameof(handler));
        _enetHandler = new SideHandler(handler);
        _enet = new ENetHost(_enetHandler);
    }

    /// <summary>True once the ENet listener is bound and couch seats can join.</summary>
    internal bool EnetStarted => _enetStarted;

    /// <summary>
    /// Brings the ENet side up ALONGSIDE the already-started Steam lobby. A bind failure is not fatal — the Steam
    /// session stays up and the host simply has no couch seats — so this reports success rather than throwing.
    /// </summary>
    internal bool TryStartEnetSide(ushort port, int maxClients)
    {
        if (_enetStarted) return true;

        try
        {
            var error = _enet.StartHost(port, maxClients);
            if (error.HasValue)
            {
                CouchCoopHostTransport.Log(
                    $"ENet side failed to bind port {port} ({error.Value}) — continuing Steam-only (no couch seats). "
                    + "Another game instance is the usual cause.");
                return false;
            }
        }
        catch (Exception exception)
        {
            CouchCoopHostTransport.Log(
                $"ENet side threw while binding port {port} ({exception.GetType().Name}: {exception.Message}) — continuing Steam-only.");
            return false;
        }

        _enetStarted = true;
        return true;
    }

    public override bool IsConnected => base.IsConnected || (_enetStarted && _enet.IsConnected);

    public override IEnumerable<ulong> ConnectedPeerIds
        => _enetStarted ? base.ConnectedPeerIds.Concat(_enet.ConnectedPeerIds) : base.ConnectedPeerIds;

    public override void Update()
    {
        base.Update();
        if (!_enetStarted) return;

        try
        {
            _enet.Update();
        }
        catch (Exception exception)
        {
            // Never let the couch side take the Steam session down, and never spam a per-frame log. We keep
            // pumping: ENetHost.Update throws only on a malformed service event, which is not sticky.
            if (!_enetUpdateFailureLogged)
            {
                _enetUpdateFailureLogged = true;
                CouchCoopHostTransport.Log(
                    $"ENet side update failed ({exception.GetType().Name}: {exception.Message}) — logged once, still pumping.");
            }
        }
    }

    public override void SendMessageToClient(ulong peerId, byte[] bytes, int length, NetTransferMode mode, int channel = 0)
    {
        if (_enetStarted && DualHostRouting.RouteFor(peerId, base.ConnectedPeerIds) == DualHostSide.Enet)
        {
            _enet.SendMessageToClient(peerId, bytes, length, mode, channel);
            return;
        }

        base.SendMessageToClient(peerId, bytes, length, mode, channel);
    }

    public override void SendMessageToAll(byte[] bytes, int length, NetTransferMode mode, int channel = 0)
    {
        base.SendMessageToAll(bytes, length, mode, channel);
        if (_enetStarted)
        {
            _enet.SendMessageToAll(bytes, length, mode, channel);
        }
    }

    public override void DisconnectClient(ulong peerId, NetError reason, bool now = false)
    {
        if (_enetStarted && DualHostRouting.RouteFor(peerId, base.ConnectedPeerIds) == DualHostSide.Enet)
        {
            _enet.DisconnectClient(peerId, reason, now);
            return;
        }

        base.DisconnectClient(peerId, reason, now);
    }

    // Steam-only by nature: "closed" means the lobby stops being visible to friends. The ENet side has no such
    // concept (its own implementation is an empty method). Guarded because SteamHost dereferences _lobbyId.
    public override void SetHostIsClosed(bool isClosed)
    {
        try
        {
            base.SetHostIsClosed(isClosed);
        }
        catch (Exception exception)
        {
            CouchCoopHostTransport.Log($"could not set lobby visibility ({exception.GetType().Name}: {exception.Message}).");
        }
    }

    public override void StopHost(NetError reason, bool now = false)
    {
        if (_enetStarted)
        {
            _enetStarted = false;
            try
            {
                // SideHandler drops the ENet side's OnDisconnected, so the service is told exactly once (below).
                _enet.StopHost(reason, now);
            }
            catch (Exception exception)
            {
                CouchCoopHostTransport.Log($"ENet side failed to stop ({exception.GetType().Name}: {exception.Message}).");
            }
        }

        try
        {
            base.StopHost(reason, now);
        }
        catch (Exception exception)
        {
            // SteamHost.OnDisconnected is the LAST thing base.StopHost does, so a throw means the service was
            // never told the host is gone — it would keep a dead session alive. Deliver that one notification.
            CouchCoopHostTransport.Log($"steam side failed to stop ({exception.GetType().Name}: {exception.Message}) — notifying the service directly.");
            _service.OnDisconnected(new NetErrorInfo(reason, selfInitiated: true));
        }
    }

    /// <summary>
    /// The inner ENet host's handler. Forwards peer connect/disconnect/packets to the real service verbatim — that
    /// is what makes a couch seat an ordinary peer of the same lobby — and DROPS <c>OnDisconnected</c>, which
    /// <c>ENetHost.StopHost</c> fires unconditionally and which the Steam side already reports.
    /// </summary>
    private sealed class SideHandler(INetHostHandler service) : INetHostHandler
    {
        private readonly INetHostHandler _service = service;

        public void OnPeerConnected(ulong peerId) => _service.OnPeerConnected(peerId);

        public void OnPeerDisconnected(ulong peerId, NetErrorInfo info) => _service.OnPeerDisconnected(peerId, info);

        public void OnPacketReceived(ulong senderId, byte[] packetBytes, NetTransferMode mode, int channel)
            => _service.OnPacketReceived(senderId, packetBytes, mode, channel);

        // Deliberately swallowed: the composite reports the host's disconnection exactly once, from the Steam side.
        public void OnDisconnected(NetErrorInfo info)
        {
        }
    }
}
