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
/// Every method may reach into the game, so a caller must be at a frame boundary and never inside a game
/// callback. A method returns <see langword="null"/> when the read could not be made (no engine behind the
/// process, or the game threw): that is "unavailable", which is not the same answer as "no lobby".
/// </remarks>
public interface IGameFacts
{
    /// <summary>
    /// The facts the QR gates need. <paramref name="currentScreen"/> is the screen on top, resolved by the caller
    /// at its own frame boundary, or <see langword="null"/> when the caller has no lobby screen in hand (the pause
    /// menu, which is only interested in the run).
    /// </summary>
    GateFacts? ReadGates(object? currentScreen);
}
