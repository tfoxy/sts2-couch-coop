using CouchCoop.Mod.HostUi;
using MegaCrit.Sts2.Core.Multiplayer.Game.Lobby;
#if STS2_API_V113
using MegaCrit.Sts2.Core.Nodes.Screens.Blitz;
using MegaCrit.Sts2.Core.Nodes.Screens.Dread;
#endif
using MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect;
using MegaCrit.Sts2.Core.Nodes.Screens.CustomRun;
using MegaCrit.Sts2.Core.Nodes.Screens.DailyRun;

namespace CouchCoop.Mod.Runtime;

internal sealed partial class GameFactsReader
{
    // One source for QR eligibility, roster and capacity. Daily is recorded by the construction hook;
    // all reads happen after the hook, on the game thread.
    internal static StartRunLobby? StartRunLobbyOfScreen(object? screen) => screen switch
    {
        NCharacterSelectScreen standard => standard.Lobby,
        NCustomRunScreen custom => custom.Lobby,
#if STS2_API_V113
        NBlitzScreen blitz => blitz.Lobby,
        NDreadScreen dread => dread.Lobby,
#endif
        NDailyRunScreen daily => LobbyAssignmentRecord.TryGetLobby(daily, out var lobby)
            ? lobby as StartRunLobby : null,
        _ => null,
    };
}
