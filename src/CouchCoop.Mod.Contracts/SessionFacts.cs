namespace CouchCoop.Mod.Contracts;

/// <summary>
/// Everything one <c>session</c> envelope is built from, read together: who is in the lobby or the run, and how many
/// players the lobby on the current screen holds. The two are read in one hop to the game's main thread, so an envelope
/// (or a fan-out of them to every connection) costs one marshal, not one per fact.
/// </summary>
/// <param name="Roster">
/// The lobby and run roster, or <see langword="null"/> when it could not be read: "unavailable", which the envelope
/// reports as an unsupported screen rather than as "nobody is here".
/// </param>
/// <param name="LobbyCap">
/// The raw player cap of the lobby on the current screen (see <see cref="IGameFacts.ReadLobbyCap"/>), or
/// <see langword="null"/> when there is no lobby screen, its cap is unread, or the caller did not ask for it. It is
/// the reader's number, not yet judged usable: the seat table sizes itself from it through
/// <c>CouchCoopLobbyParticipation.MaxCouchSeatsOf</c>.
/// </param>
public sealed record SessionFacts(RosterFacts? Roster, int? LobbyCap)
{
    /// <summary>A read that could not be made at all.</summary>
    public static SessionFacts Unavailable { get; } = new(null, null);
}
