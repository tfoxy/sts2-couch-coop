using CouchCoop.Mod.Runtime;
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

    // Run presence is CouchCoop's one typed read, shared with the QR gates and the browser-disconnect and seat-launch
    // decisions (CouchCoopGameFacts.ReadRunInProgress); the member behind it is declared identically on both API
    // lanes. An unreadable answer throws instead of reading "no run": the tracker treats "left every run and lobby"
    // as evidence hosting ended, so a failed read must skip the evaluation (its catch logs it), never count toward
    // that.
    public bool IsRunInProgress()
        => CouchCoopGameFacts.ReadRunInProgress()
           ?? throw new InvalidOperationException("The run manager's presence could not be read.");

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
