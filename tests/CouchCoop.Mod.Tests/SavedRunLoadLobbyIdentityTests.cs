using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Multiplayer.Game.Lobby;
using MegaCrit.Sts2.Core.Multiplayer.Quality;
using MegaCrit.Sts2.Core.Multiplayer.Serialization;
using MegaCrit.Sts2.Core.Multiplayer.Transport;
using MegaCrit.Sts2.Core.Platform;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Saves.Runs;

// Regression for Steam-created multiplayer saves opened while Steam falls back to ENet. The actual ENet listener
// still starts with native id 1; LoadRunLobby must instead receive the saved Steam host id when it registers the
// local host and when it resolves that player from SerializableRun.Players.
internal static class SavedRunLoadLobbyIdentityTests
{
    public static void Run()
    {
        SavedSteamHostIsRegisteredByLoadLobby();
        PlainEnetAndUnboundServicesKeepNativeIdentity();
    }

    private static void SavedSteamHostIsRegisteredByLoadLobby()
    {
        const ulong savedSteamHost = 76561198000000123UL;
        var service = new FallbackHostService(nativeNetId: 1UL);

        try
        {
            CouchCoopHostTransport.ActivateSavedRunFallbackHostIdentity(service, savedSteamHost);
            Assert(service.NativeNetId == 1UL, "the underlying offline ENet host remains native id 1");
            Assert(service.NetId == savedSteamHost, "the saved fallback service exposes the saved Steam id");

            // The lobby half of this regression cannot run in a test process, and used to end it. Constructing a
            // LoadRunLobby runs game code, which reaches GodotSharp entry points that only a running engine fills
            // in; in a bare test process they are null, so the call lands on address 0 and the process dies
            // (`segfault at 0 ip 0000000000000000`, exit 139). It is uncatchable, it killed every suite registered
            // after this one, and for six days it was misattributed to an unrelated suite above.
            //
            // What is left here is the half that is ours and that actually regressed: the identity the lobby will
            // read. The lobby's own use of it is a live-game behaviour — assert the seam we depend on still exists,
            // and prove the registration itself against a running game.
            Assert(Run(savedSteamHost, 1002UL).Players.Single(player => player.NetId == service.NetId).NetId == savedSteamHost,
                "the saved run resolves its local player by the identity the lobby will read off the service");

            var addLocalHost = typeof(LoadRunLobby).GetMethod(nameof(LoadRunLobby.AddLocalHostPlayer));
            Assert(addLocalHost is not null,
                "LoadRunLobby still registers its local host through AddLocalHostPlayer (the call that reads NetService.NetId)");
        }
        finally
        {
            CouchCoopHostTransport.ResetSession();
        }

        Assert(service.NetId == 1UL, "session reset removes the saved identity binding");
    }

    private static void PlainEnetAndUnboundServicesKeepNativeIdentity()
    {
        var plainEnetService = new FallbackHostService(nativeNetId: 1UL);
        var couchSeatService = new FallbackHostService(nativeNetId: 1002UL);

        Assert(CouchCoopHostTransport.ResolveSavedRunFallbackHostNetId(plainEnetService, plainEnetService.NativeNetId) == 1UL,
            "a plain ENet save keeps host id 1");
        Assert(CouchCoopHostTransport.ResolveSavedRunFallbackHostNetId(couchSeatService, couchSeatService.NativeNetId) == 1002UL,
            "an unbound couch-seat identity is never remapped");
    }

    /// <summary>
    /// Every netId the loaded lobby has registered, in registration order. v0.107.1 exposes them as a
    /// <c>HashSet</c> (<c>ConnectedPlayerIds</c>); v0.111.0 replaced that with a projection over the new
    /// per-player records (<c>PlayerIds</c>). One element either way here, so ordering costs this test nothing.
    /// <para>Nothing calls this any more — see the note in <see cref="SavedSteamHostIsRegisteredByLoadLobby"/> for
    /// why a lobby cannot be built here. It stays because it still COMPILES, which is the cheap half of the guard:
    /// if a game update moves the registered-player projection again, this stops building on that lane and says so
    /// at build time instead of at whatever live session next tries to resume a saved Steam run.</para>
    /// </summary>
    private static IReadOnlyList<ulong> RegisteredNetIds(LoadRunLobby lobby)
#if STS2_API_V111
        => lobby.PlayerIds.ToList();
#else
        => lobby.ConnectedPlayerIds.ToList();
#endif

    private static SerializableRun Run(params ulong[] playerIds) => new()
    {
        Players = playerIds.Select(netId => new SerializablePlayer { NetId = netId }).ToList(),
    };

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[SavedRunLoadLobbyIdentityTests] FAILED: {label}");
        }
    }

    private sealed class FallbackHostService(ulong nativeNetId) : INetHostGameService
    {
        public ulong NativeNetId { get; } = nativeNetId;
        public ulong NetId => CouchCoopHostTransport.ResolveSavedRunFallbackHostNetId(this, NativeNetId);
        public bool IsConnected => true;
        public bool IsGameLoading => false;
        public NetGameType Type => NetGameType.Host;
        public PlatformType Platform => PlatformType.None;
        public IReadOnlyList<NetClientData> ConnectedPeers => [];
        public NetHost? NetHost => null;

        public event Action<NetErrorInfo>? Disconnected;
        public event Action<ulong>? ClientConnected
        {
            add { }
            remove { }
        }
        public event Action<ulong, NetErrorInfo>? ClientDisconnected;

        public void SendMessage<T>(T message, ulong playerId) where T : INetMessage { }
        public void SendMessage<T>(T message) where T : INetMessage { }
        public void RegisterMessageHandler<T>(MessageHandlerDelegate<T> messageHandlerDelegate) where T : INetMessage { }
        public void UnregisterMessageHandler<T>(MessageHandlerDelegate<T> messageHandlerDelegate) where T : INetMessage { }
        public void Update() { }
        public void Disconnect(NetError reason, bool now = false) => Disconnected?.Invoke(new NetErrorInfo(reason, selfInitiated: true));
        public ConnectionStats? GetStatsForPeer(ulong peerId) => null;
        public void SetGameLoading(bool isLoading) { }
        public void SetBufferMessages(bool bufferMessages) { }
        public string? GetRawLobbyIdentifier() => null;
        public void DisconnectClient(ulong peerId, NetError reason, bool now = false)
            => ClientDisconnected?.Invoke(peerId, new NetErrorInfo(reason, selfInitiated: true));
        public void SetPeerReadyForBroadcasting(ulong peerId) { }
#if STS2_API_V111
        // v0.111.0 widened both service interfaces with the peer-version handshake and a connection-FAILED
        // event (distinct from a disconnect: the peer never got in). Nothing this test asserts goes near them;
        // they are here so the fake still satisfies the interface on that build.
        public MegaCrit.Sts2.Core.Multiplayer.PeerVersionInfo LocalVersion => default;
        public event Action<ulong, NetErrorInfo>? ClientConnectionFailed
        {
            add { }
            remove { }
        }
        public MegaCrit.Sts2.Core.Multiplayer.PeerVersionInfo? GetVersionInfoForPeer(ulong peerId) => null;
#endif
    }

    /// <summary>
    /// Kept for the same reason as <see cref="RegisteredNetIds"/>: no lobby can be constructed here to hand it to,
    /// but implementing the game's listener interface is a compile-time pin on that interface's shape across both
    /// API lanes. A widened interface fails the build rather than a live resume.
    /// </summary>
    private sealed class RecordingListener : ILoadRunLobbyListener
    {
        public List<ulong> ConnectedPlayerIds { get; } = [];

#if STS2_API_V111
        // v0.111.0 hands the listener the whole lobby-player record rather than a bare netId.
        public void PlayerConnected(LoadRunLobbyPlayer player) => ConnectedPlayerIds.Add(player.id);
#else
        public void PlayerConnected(ulong playerId) => ConnectedPlayerIds.Add(playerId);
#endif
        public void RemotePlayerDisconnected(ulong playerId) { }
        public Task<bool> ShouldAllowRunToBegin() => Task.FromResult(true);
        public void BeginRun() { }
        public void PlayerReadyChanged(ulong playerId) { }
        public void LocalPlayerDisconnected(NetErrorInfo info) { }
    }
}
