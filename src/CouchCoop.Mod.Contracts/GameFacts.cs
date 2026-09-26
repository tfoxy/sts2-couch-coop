namespace CouchCoop.Mod.Contracts;

/// <summary>
/// The net game type names CouchCoop's own facts use. Lower case, and the same spelling the old full state
/// snapshot reported, so a gate decided from these is decided exactly as it was.
/// </summary>
public static class NetTypeNames
{
    public const string Host = "host";
    public const string Client = "client";
    public const string Singleplayer = "singleplayer";
    public const string Replay = "replay";
    public const string None = "none";

    /// <summary>A run is in progress but the game reports no net service for it.</summary>
    public const string Unknown = "";
}

/// <summary>
/// The whole of what the QR host panel's gates and the pause-menu row decide on, read from the game without a full
/// state snapshot.
/// </summary>
/// <param name="RunInProgress">
/// A run exists. Stays true through the end-of-run death or Architect summary, because the game's own run
/// presence does.
/// </param>
/// <param name="CurrentLobbyNetType">
/// The net game type of the lobby on the screen the caller named as current, or <see langword="null"/> when that
/// screen is not a lobby (or its lobby is not assigned yet). Only meaningful together with
/// <paramref name="RunInProgress"/> being false.
/// </param>
/// <param name="RunNetType">
/// The net game type of the run in progress, or <see langword="null"/> when no run is in progress.
/// </param>
public readonly record struct GateFacts(bool RunInProgress, string? CurrentLobbyNetType, string? RunNetType);

/// <summary>
/// CouchCoop's own reader of the few game facts it decides on, typed against the game rather than routed through
/// spirectl's full state. One interface, one method per read path, added as each path stops using the snapshot.
/// </summary>
/// <remarks>
/// Unless a method says otherwise, it may reach into the game, so a caller must be at a frame boundary and never
/// inside a game callback. A method returns <see langword="null"/> when the read could not be made (no engine behind
/// the process, or the game threw): that is "unavailable", which is not the same answer as "no lobby".
/// </remarks>
public partial interface IGameFacts
{
    /// <summary>
    /// The facts the QR gates need. <paramref name="currentScreen"/> is the screen on top, resolved by the caller
    /// at its own frame boundary, or <see langword="null"/> when the caller has no lobby screen in hand (the pause
    /// menu, which is only interested in the run).
    /// </summary>
    GateFacts? ReadGates(object? currentScreen);

    // ---- WP3 path 7: run presence for a browser disconnect and a seat launch -----------------------------------

    /// <summary>
    /// Whether the host's game is in a run right now: <see langword="true"/> from the moment a run exists (past
    /// character select) through the end-of-run death or Architect summary, <see langword="false"/> at the main
    /// menu and on a lobby screen (the load-saved-run lobby included), and <see langword="null"/> when it could not
    /// be read. Unlike the other reads, this one is a plain member read that touches no engine object, so it may
    /// be called from any thread, with or without a mod lock held; it never marshals to the main thread.
    /// </summary>
    /// <remarks>
    /// Callers decide what unavailable means for them. The disconnect and seat-launch callers treat it as "no run",
    /// which is what an unreadable state has always meant to them: the game refuses a launch it cannot take
    /// anyway, and a disconnect that cannot tell falls back to releasing the seat.
    /// </remarks>
    bool? ReadRunInProgress();

    // ---- WP3 path 5: the lobby player cap -------------------------------------------------------------------

    /// <summary>
    /// The player cap the lobby on the screen that is current RIGHT NOW reports, host seat included, exactly as the
    /// game holds it: the new-run lobby's own cap, or for the saved-run lobby the number of players in the save
    /// (it admits exactly those). <see langword="null"/> when no lobby screen is current, its lobby is not assigned
    /// yet, or the read could not be made. A value of 1 or less is a lobby that has not settled on a cap, which is
    /// the caller's to judge (see <c>CouchCoopLobbyParticipation.LobbyCapOf</c>), not this reader's.
    /// </summary>
    /// <remarks>
    /// Unlike <see cref="ReadGates"/> this may be called from ANY thread and takes no screen: it runs where the game
    /// can be touched and looks at the current screen there. The admission limiter asks once per WebSocket
    /// upgrade, on a listener thread, so the answer must be live rather than remembered. A caller must not hold a
    /// lock the game's main thread could be waiting for.
    /// </remarks>
    int? ReadLobbyCap();
}
