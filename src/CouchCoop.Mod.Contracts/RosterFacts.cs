namespace CouchCoop.Mod.Contracts;

/// <summary>
/// The root screen names the roster reports. They are the four strings the old full state snapshot used for its
/// root scene, kept spelled the same so the join screen's title and kind (which are derived from them) do not change.
/// </summary>
public static class RosterRootScenes
{
    /// <summary>A run is in progress, through the end-of-run death or Architect summary.</summary>
    public const string Run = "run";

    /// <summary>The new-run lobby (character select) is the current screen.</summary>
    public const string CharacterSelect = "screens/character_select_screen";

    /// <summary>The saved-run lobby (load a saved multiplayer run) is the current screen.</summary>
    public const string LoadGame = "screens/multiplayer_load_game_screen";

    /// <summary>Anything else: the main menu and every screen that is neither a run nor a lobby.</summary>
    public const string MainMenu = "screens/main_menu";
}

/// <summary>
/// One seat of a lobby, as the game lists it. <see cref="Id"/> is <c>p:{netId}</c>. A seat is
/// <see cref="IsConnected"/> only when it is the local player or the host's peer list holds it (on a client the peer
/// list is not readable, so only the local player is connected); on the saved-run lobby the lobby's own admitted-player
/// list decides instead.
/// </summary>
public sealed record RosterLobbySeat(string Id, string? DisplayName, string? CharacterId, bool IsConnected);

/// <summary>
/// One seat of the run in progress. <see cref="IsConnected"/> FAILS OPEN: it is true whenever connectedness cannot be
/// determined (a client, a singleplayer run), so an unknown never reads as a dropped player.
/// </summary>
public sealed record RosterRunSeat(string Id, string? DisplayName, string? CharacterId, bool IsHost, bool IsConnected);

/// <summary>
/// The lobby on the current screen. <see cref="NetType"/> is a <see cref="NetTypeNames"/> value.
/// <see cref="IsSavedRun"/> marks the saved-run lobby, whose expected seats are <see cref="SavedRunSeatIds"/> (empty
/// otherwise); the saved seats are roster rows too, present or not.
/// </summary>
public sealed record RosterLobby(
    string NetType,
    string? HostPlayerId,
    bool IsSavedRun,
    IReadOnlyList<RosterLobbySeat> Seats,
    IReadOnlyList<string> SavedRunSeatIds)
{
    public bool Equals(RosterLobby? other)
        => other is not null
            && string.Equals(NetType, other.NetType, StringComparison.Ordinal)
            && string.Equals(HostPlayerId, other.HostPlayerId, StringComparison.Ordinal)
            && IsSavedRun == other.IsSavedRun
            && Seats.SequenceEqual(other.Seats)
            && SavedRunSeatIds.SequenceEqual(other.SavedRunSeatIds, StringComparer.Ordinal);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        hash.Add(NetType);
        hash.Add(HostPlayerId);
        hash.Add(IsSavedRun);
        foreach (var seat in Seats) hash.Add(seat);
        foreach (var id in SavedRunSeatIds) hash.Add(id);
        return hash.ToHashCode();
    }
}

/// <summary>The run in progress. <see cref="NetType"/> is a <see cref="NetTypeNames"/> value.</summary>
public sealed record RosterRun(string NetType, string? HostPlayerId, IReadOnlyList<RosterRunSeat> Seats)
{
    public bool Equals(RosterRun? other)
        => other is not null
            && string.Equals(NetType, other.NetType, StringComparison.Ordinal)
            && string.Equals(HostPlayerId, other.HostPlayerId, StringComparison.Ordinal)
            && Seats.SequenceEqual(other.Seats);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        hash.Add(NetType);
        hash.Add(HostPlayerId);
        foreach (var seat in Seats) hash.Add(seat);
        return hash.ToHashCode();
    }
}

/// <summary>
/// Who is where: the whole of what CouchCoop reads of the game's lobby and run rosters, and nothing else. Read on
/// demand through <see cref="IGameFacts.ReadRoster"/>; value equality holds element by element, so two reads of the
/// same game compare equal.
/// </summary>
/// <param name="RootScene">One of <see cref="RosterRootScenes"/>.</param>
/// <param name="Lobby">
/// Present exactly when a lobby screen is the current screen and the game has assigned it a lobby. It can be present
/// together with <paramref name="Run"/> for the moment a run starts under the lobby screen; the run wins.
/// </param>
/// <param name="Run">
/// Present while a run is in progress, and it stays present through the end-of-run summary: the run ends only when
/// the game cleans it up, on the way back to the menu.
/// </param>
public sealed record RosterFacts(string RootScene, RosterLobby? Lobby, RosterRun? Run);

public partial interface IGameFacts
{
    // ---- Roster (WP3 path 2) -------------------------------------------------------------------------------

    /// <summary>
    /// Who is in the lobby or the run right now, or <see langword="null"/> when that could not be read (no engine, or
    /// the game threw): "unavailable", which is not the answer "no lobby and no run". An implementation reads on the
    /// calling thread, which must be the game main thread; the <c>CouchCoopGameFacts</c> front is what callers on any
    /// other thread use, because it marshals there (inline when already there). Never call it while holding a mod lock,
    /// and never from inside a game callback such as a postfix: the roster observer reads it one frame after a signal.
    /// </summary>
    RosterFacts? ReadRoster();
}
