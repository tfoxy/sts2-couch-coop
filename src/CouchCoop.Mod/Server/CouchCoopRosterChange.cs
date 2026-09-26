using CouchCoop.Mod.Contracts;

namespace CouchCoop.Mod.Server;

/// <summary>
/// What the browser server decides from a roster read, as pure functions: whether the join screen's roster changed, and
/// whether the game has left both the run and any lobby.
/// </summary>
public static class CouchCoopRosterChange
{
    /// <summary>
    /// A cheap fingerprint of the join-screen-relevant roster: run-vs-lobby, the lobby roster (id, display name and
    /// connectedness), the saved run's seat ids, and the root scene. The scene matters because the session's Screen block
    /// (the title, kind and mirror mode the pre-join gate renders) is derived from it: without it, a viewer that connected
    /// on one screen kept a stale gate forever.
    /// </summary>
    /// <remarks>
    /// Per-player CONNECTEDNESS is part of the signature on both branches (and the run branch has a per-player signature
    /// at all only because of it). A player dropping out of a live run is precisely the moment the join screen has to
    /// change (that seat becomes reclaimable, and the mirror picker is the only way back into it), and nothing else about
    /// the run roster moves when it happens.
    /// </remarks>
    public static string Signature(RosterFacts roster)
    {
        ArgumentNullException.ThrowIfNull(roster);
        var scene = "|scene:" + roster.RootScene;
        if (roster.Run is { } run)
        {
            return "run:" + string.Join(",", run.Seats.Select(seat => $"{seat.Id}={seat.IsConnected}")) + scene;
        }

        var lobby = roster.Lobby;
        var seats = lobby?.Seats;
        if (lobby is null || seats is null || seats.Count == 0)
        {
            return "lobby:" + scene;
        }

        // The saved run's seats ride along on a load-game lobby: they are roster rows too (the union in
        // BrowserAssignmentClassifier.LobbyPlayers), so a save being loaded or cleared must re-send the session.
        var saved = lobby.IsSavedRun ? "|saved:" + string.Join(",", lobby.SavedRunSeatIds) : "";
        return "lobby:"
            + string.Join(",", seats.Select(seat => $"{seat.Id}={seat.DisplayName}:{seat.IsConnected}"))
            + saved
            + scene;
    }

    /// <summary>
    /// True when the game is in neither a run nor a lobby (the main menu, the epoch screens, anything else), which is when
    /// detached seats are reaped. The end-of-run death or Architect summary is still the run (run presence stays true
    /// until the game cleans the run up), and a lobby screen is not the run having ended, so neither reaps.
    /// </summary>
    public static bool HasLeftRunAndLobby(RosterFacts roster)
    {
        ArgumentNullException.ThrowIfNull(roster);
        return roster.Run is null && roster.Lobby is null;
    }
}
