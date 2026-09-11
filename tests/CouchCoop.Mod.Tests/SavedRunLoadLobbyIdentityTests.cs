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
        var listener = new RecordingListener();

        try
        {
            CouchCoopHostTransport.ActivateSavedRunFallbackHostIdentity(service, savedSteamHost);
            Assert(service.NativeNetId == 1UL, "the underlying offline ENet host remains native id 1");
            Assert(service.NetId == savedSteamHost, "the saved fallback service exposes the saved Steam id");

            var lobby = new LoadRunLobby(service, listener, Run(savedSteamHost, 1002UL));
            lobby.AddLocalHostPlayer();

            Assert(lobby.ConnectedPlayerIds.SetEquals([savedSteamHost]),
                "LoadRunLobby registers only the saved Steam host, never ENet id 1");
            Assert(listener.ConnectedPlayerIds.SequenceEqual([savedSteamHost]),
                "the loaded-lobby listener receives the saved Steam host id");
            Assert(lobby.Run.Players.Single(player => player.NetId == lobby.NetService.NetId).NetId == savedSteamHost,
                "the loaded lobby can resolve its local saved player by the service identity");
            lobby.CleanUp(disconnectSession: false);
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
    }

    private sealed class RecordingListener : ILoadRunLobbyListener
    {
        public List<ulong> ConnectedPlayerIds { get; } = [];

        public void PlayerConnected(ulong playerId) => ConnectedPlayerIds.Add(playerId);
        public void RemotePlayerDisconnected(ulong playerId) { }
        public Task<bool> ShouldAllowRunToBegin() => Task.FromResult(true);
        public void BeginRun() { }
        public void PlayerReadyChanged(ulong playerId) { }
        public void LocalPlayerDisconnected(NetErrorInfo info) { }
    }
}
