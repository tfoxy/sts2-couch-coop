using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Connections;

/// <summary>The three cheap facts ConnectionHostingTracker needs, replacing a full state snapshot read.</summary>
internal interface IHostingSessionFacts
{
    /// <summary>This process has an installed net host (a hosting session was started and not yet reset).</summary>
    bool IsHostActive();

    /// <summary>The local game is inside a run — stays true through the end-of-run death/Architect summary.</summary>
    bool IsRunInProgress();

    /// <summary>The screen on top is a registered lobby screen (new-run character select, or load-run).</summary>
    bool IsOnLobbyScreen();
}

/// <summary>Production reads: transport bookkeeping, the game's run manager, the lobby screen registry.</summary>
internal sealed class HostingSessionFacts : IHostingSessionFacts
{
    public bool IsHostActive() => CouchCoopHostPeers.IsHostActive;

    // MegaCrit.Sts2.Core.Runs.RunManager.Instance.IsInProgress reads identically on both API lanes (spirectl's
    // bridge-mod already reads this member the same way with no lane split — see
    // Sts2DevelopmentActionHandler.cs). Re-verify against the installed v111 build before merging; if it
    // disagrees, split with #if STS2_API_V107 / STS2_API_V111 the way HostNetIdPatch.cs does.
    public bool IsRunInProgress() => MegaCrit.Sts2.Core.Runs.RunManager.Instance?.IsInProgress == true;

    public bool IsOnLobbyScreen()
    {
        try
        {
            return HostUi.CouchCoopQrHostPanelController.IsAnyLobbyScreenCurrent();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"connection hosting lobby-screen check failed: {exception.GetType().Name}: {exception.Message}");
            return false;
        }
    }
}
