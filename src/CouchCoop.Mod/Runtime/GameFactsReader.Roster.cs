using System.Globalization;
using System.Runtime.CompilerServices;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Multiplayer.Game.Lobby;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Platform;
using MegaCrit.Sts2.Core.Runs;

namespace CouchCoop.Mod.Runtime;

// The roster read of the production reader (WP3 path 2): who is in the lobby on the current screen, and who is in the
// run. Every game type is touched only from methods behind the engine guard, on the game main thread.
internal sealed partial class GameFactsReader
{
    public RosterFacts? ReadRoster()
    {
        // A test process can load the game assemblies and then fault in native code, so no game type is touched
        // without an engine behind the process.
        if (!CouchCoopMod.EngineAvailable)
        {
            return null;
        }

        return ReadRosterFromGame();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static RosterFacts? ReadRosterFromGame()
    {
        var manager = RunManager.Instance;
        if (manager is null)
        {
            return null;
        }

        // The screen on top, resolved here on the main thread: this method is only ever reached at a frame boundary
        // (see IGameFacts.ReadRoster), never from inside a game callback.
        var screen = GameScreenContext.GetCurrent();
        var run = ReadRun(manager, screen);
        var lobby = screen switch
        {
            NCharacterSelectScreen characterSelect => ReadStartRunLobby(characterSelect),
            NMultiplayerLoadGameScreen loadRun => ReadLoadRunLobby(loadRun),
            _ => null,
        };

        // The root scene is the same four strings the old snapshot named: a run wins, then whichever lobby screen is
        // on top (even one the game has not assigned a lobby to yet), then the menu.
        var rootScene = run is not null
            ? RosterRootScenes.Run
            : screen switch
            {
                NCharacterSelectScreen => RosterRootScenes.CharacterSelect,
                NMultiplayerLoadGameScreen => RosterRootScenes.LoadGame,
                _ => RosterRootScenes.MainMenu,
            };
        return new RosterFacts(rootScene, lobby, run);
    }

    // ---- the run --------------------------------------------------------------------------------------------

    private static RosterRun? ReadRun(RunManager manager, object? screen)
    {
        // The one shared read of run presence (see RunInProgressFromGame): true through the end-of-run summary.
        if (RunInProgressFromGame() != true)
        {
            return null;
        }

        RunState? state;
        try
        {
            state = manager.DebugOnlyGetState();
        }
        catch
        {
            return null;
        }

        if (state is null)
        {
            return null;
        }

        var service = manager.NetService;
        var localNetId = TryNetId(service);
        var hostPlayerId = HostPlayerId(service, localNetId);
        // Connectedness comes from the host's peer list. The run's own service is preferred; a run that has none yet
        // borrows the new-run lobby's, when that lobby is what is on screen.
        var peers = ReadPeerNetIds(service ?? (screen as NCharacterSelectScreen)?.Lobby?.NetService, localNetId);
        var platform = service?.Platform;

        var seats = new List<RosterRunSeat>();
        foreach (var player in state.Players)
        {
            if (player is null)
            {
                continue;
            }

            var netId = player.NetId;
            var playerId = PlayerId(netId);
            seats.Add(new RosterRunSeat(
                playerId,
                PlayerName(platform, netId),
                CharacterId(player.Character) ?? "unknown",
                IsHost: string.Equals(playerId, hostPlayerId, StringComparison.Ordinal),
                // FAILS OPEN: with no readable peer list every seat counts as connected.
                IsConnected: peers is null || peers.Contains(netId)));
        }

        return new RosterRun(NetTypeName(service?.Type), hostPlayerId, seats);
    }

    // ---- the lobbies -----------------------------------------------------------------------------------------

    /// <summary>The new-run lobby. Its screen exposes it, so the seats are read straight off the lobby.</summary>
    private static RosterLobby? ReadStartRunLobby(NCharacterSelectScreen screen)
    {
        var lobby = screen.Lobby;
        if (lobby is null)
        {
            return null;
        }

        var service = lobby.NetService;
        var localNetId = TryNetId(service);
        var peers = ReadPeerNetIds(service, localNetId);
        var platform = service?.Platform;

        var seats = new List<RosterLobbySeat>();
        foreach (var player in lobby.Players)
        {
            seats.Add(new RosterLobbySeat(
                PlayerId(player.id),
                PlayerName(platform, player.id),
                CharacterId(player.character),
                // Strict: a remote seat is connected only once the host's peer list holds it.
                IsConnected: (localNetId.HasValue && player.id == localNetId.Value) || (peers?.Contains(player.id) ?? false)));
        }

        return new RosterLobby(NetTypeName(service?.Type), HostPlayerId(service, localNetId), IsSavedRun: false, seats, []);
    }

    /// <summary>
    /// The saved-run lobby. The screen keeps its lobby private, so it is the one the constructor hook recorded for this
    /// screen (see <see cref="LobbyAssignmentRecord.RecordLobby"/>; it carries the same save the assignment hook recorded).
    /// Its seats are the players the save expects, present or not; a seat is connected when it is the local player or the
    /// lobby has admitted it.
    /// </summary>
    private static RosterLobby? ReadLoadRunLobby(NMultiplayerLoadGameScreen screen)
    {
        if (!LobbyAssignmentRecord.TryGetLobby(screen, out var recorded) || recorded is not LoadRunLobby lobby)
        {
            return null;
        }

        var service = lobby.NetService;
        var localNetId = TryNetId(service);
        var platform = service?.Platform;

        var seats = new List<RosterLobbySeat>();
        var savedIds = new List<string>();
        foreach (var player in lobby.Run?.Players ?? [])
        {
            var netId = player.NetId;
            var playerId = PlayerId(netId);
            savedIds.Add(playerId);
            seats.Add(new RosterLobbySeat(
                playerId,
                PlayerName(platform, netId),
                NormalizeNullable(player.CharacterId?.Entry),
                IsConnected: (localNetId.HasValue && netId == localNetId.Value) || IsAdmitted(lobby, netId)));
        }

        return new RosterLobby(NetTypeName(service?.Type), HostPlayerId(service, localNetId), IsSavedRun: true, seats, savedIds);
    }

    /// <summary>
    /// Whether the saved-run lobby has admitted <paramref name="netId"/>. The lobby's admitted players are a set of ids
    /// on v0.107.1 and a list of per-player records on v0.111.0.
    /// </summary>
    private static bool IsAdmitted(LoadRunLobby lobby, ulong netId)
#if STS2_API_V111
        => lobby.PlayerIds.Contains(netId);
#else
        => lobby.ConnectedPlayerIds.Contains(netId);
#endif

    // ---- shared reads ----------------------------------------------------------------------------------------

    /// <summary>The service's own net id, or null when the service is not connected yet (the game throws for that).</summary>
    private static ulong? TryNetId(INetGameService? service)
    {
        if (service is null)
        {
            return null;
        }

        try
        {
            return service.NetId;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Who hosts: the local player on a host, the host's id on a client, nobody otherwise (a singleplayer service has no
    /// host). A client that cannot say yet reports none.
    /// </summary>
    private static string? HostPlayerId(INetGameService? service, ulong? localNetId)
    {
        switch (service?.Type)
        {
            case NetGameType.Host:
                return localNetId.HasValue ? PlayerId(localNetId.Value) : null;
            case NetGameType.Client when service is NetClientGameService client:
                try
                {
                    var hostNetId = client.HostNetId;
                    return hostNetId > 0 ? PlayerId(hostNetId) : null;
                }
                catch
                {
                    return null;
                }
            default:
                return null;
        }
    }

    /// <summary>
    /// The host's live peer list plus the local player, or null when it cannot be read (a client, a singleplayer service,
    /// or a service that is not a host at all): connectedness is then unknown, and each caller says what that means.
    /// </summary>
    private static HashSet<ulong>? ReadPeerNetIds(INetGameService? service, ulong? localNetId)
    {
        HashSet<ulong>? peers = null;
        try
        {
            if (service is NetHostGameService host)
            {
                peers = [];
                foreach (var peer in host.ConnectedPeers)
                {
                    peers.Add(peer.peerId);
                }
            }
            else if (service is INetHostGameService hostService && hostService.NetHost is { } netHost)
            {
                peers = [];
                foreach (var peerId in netHost.ConnectedPeerIds)
                {
                    peers.Add(peerId);
                }
            }
        }
        catch
        {
            return null;
        }

        if (peers is not null && localNetId.HasValue)
        {
            peers.Add(localNetId.Value);
        }

        return peers;
    }

    /// <summary>
    /// The name the game shows for a player. Read through <see cref="PlatformUtil.GetPlayerNameRaw"/>, which is where the
    /// display-name overrides CouchCoop sets for its seats apply, and NOT through <c>GetPlayerName</c>: that wrapper only
    /// adds BBCode escaping on top, for a rich-text label, and the browser roster and the names file published to the
    /// seats are plain text.
    /// </summary>
    private static string? PlayerName(PlatformType? platform, ulong netId)
    {
        if (platform is null)
        {
            return null;
        }

        try
        {
            return NormalizeName(PlatformUtil.GetPlayerNameRaw(platform.Value, netId));
        }
        catch
        {
            return null;
        }
    }

    private static string? CharacterId(CharacterModel? character)
    {
        var id = character?.Id;
        return id is null ? null : NormalizeNullable(id.Entry) ?? NormalizeNullable(id.ToString());
    }

    /// <summary>A player name with line breaks flattened and the ends trimmed; null when nothing is left.</summary>
    internal static string? NormalizeName(string? name)
        => string.IsNullOrWhiteSpace(name) ? null : name.ReplaceLineEndings(" ").Trim();

    internal static string? NormalizeNullable(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>A player id as every roster consumer spells it: <c>p:{netId}</c>.</summary>
    internal static string PlayerId(ulong netId) => "p:" + netId.ToString(CultureInfo.InvariantCulture);
}
