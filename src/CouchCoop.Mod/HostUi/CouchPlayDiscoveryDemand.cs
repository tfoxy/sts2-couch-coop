using CouchCoop.Mod.Contracts;

namespace CouchCoop.Mod.HostUi;

/// <summary>Discovery survives entry dismissal for reconnects, until solo is disabled or hosting ends.</summary>
internal sealed class CouchPlayDiscoveryDemand
{
    private bool _soloArmed;
    public bool MultiplayerHosting { get; set; }
    public bool SoloLobbyPresented { get; set; }
    public bool SoloPausePresented { get; set; }

    public bool ShouldRun(CouchPlayMode mode)
    {
        if (mode == CouchPlayMode.Off) _soloArmed = false;
        else if (SoloLobbyPresented || SoloPausePresented) _soloArmed = true;
        return MultiplayerHosting || _soloArmed;
    }
}
