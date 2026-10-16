using System.Runtime.CompilerServices;
using CouchCoop.Mod.HostUi;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer.Game;
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Nodes.Screens.CustomRun;
using MegaCrit.Sts2.Core.Nodes.Screens.DailyRun;
using MegaCrit.Sts2.Core.Runs;

namespace CouchCoop.Mod.Runtime;

/// <summary>Evicts a dead CouchCoop seat from the host service of the current lobby or run.</summary>
internal static class GameSeatPeerCleanup
{
    internal enum Context { None, NewRunLobby, SavedRunLobby, Run }

    internal static void Disconnect(ulong netId)
    {
        if (!CouchCoopMod.EngineAvailable)
            throw new InvalidOperationException("Peer cleanup requires the game runtime.");
        GameMainThread.Invoke(() => DisconnectOnMainThread(netId));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool DisconnectOnMainThread(ulong netId)
    {
        var screen = GameScreenContext.GetCurrent();
        var context = LobbyContextOf(screen?.GetType());
        if (context == Context.None && RunManager.Instance is { IsInProgress: true, NetService: not null })
            context = Context.Run;
        object? service = context switch
        {
            Context.NewRunLobby => GameFactsReader.StartRunLobbyOfScreen(screen)?.NetService,
            Context.SavedRunLobby => LobbyAssignmentRecord.TryGetLobby(screen!, out var lobby)
                && lobby is MegaCrit.Sts2.Core.Multiplayer.Game.Lobby.LoadRunLobby loaded
                    ? loaded.NetService : null,
            Context.Run => RunManager.Instance?.NetService,
            _ => null,
        };
        return DisconnectFromService(context, service, netId);
    }

    internal static Context LobbyContextOf(Type? screenType)
    {
        if (screenType is null) return Context.None;
        if (typeof(NCharacterSelectScreen).IsAssignableFrom(screenType)
            || typeof(NDailyRunScreen).IsAssignableFrom(screenType)
            || typeof(NCustomRunScreen).IsAssignableFrom(screenType))
            return Context.NewRunLobby;
        return typeof(NMultiplayerLoadGameScreen).IsAssignableFrom(screenType)
            ? Context.SavedRunLobby : Context.None;
    }

    // Kept game-free at the call boundary so tests can cover the saved-lobby selection and failure contract.
    internal static bool DisconnectFromService(Context context, object? service, ulong netId)
    {
        if (context == Context.None) return false; // the host already left multiplayer
        if (service is not INetHostGameService host)
            throw new InvalidOperationException($"Peer cleanup has no host service in {context}.");
        host.DisconnectClient(netId, NetError.Kicked);
        return true;
    }
}
