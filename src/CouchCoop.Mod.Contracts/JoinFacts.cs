namespace CouchCoop.Mod.Contracts;

/// <summary>
/// What one browser join reads of the game before it decides anything, taken in a single hop onto the game's main
/// thread so the roster and the cap describe the same frame.
/// </summary>
/// <param name="Roster">Who is in the lobby or the run, or <see langword="null"/> when that could not be read.</param>
/// <param name="LobbyCap">
/// The player cap the lobby on the current screen reports, exactly as <see cref="IGameFacts.ReadLobbyCap"/> answers
/// it, or <see langword="null"/> when there is no lobby screen or the read could not be made.
/// </param>
public readonly record struct JoinRead(RosterFacts? Roster, int? LobbyCap);

/// <summary>
/// The two facts the seat manager launches a join on, handed to it by the join that already read them so the manager
/// does not ask the game again.
/// </summary>
/// <param name="MaxCouchSeats">
/// How many couch seats the live lobby has room for (its player cap minus the host's seat), or
/// <see langword="null"/> when there is no usable cap to size by. Null is UNKNOWN, never a small number: the seat
/// range then opens as far as its guard band instead of refusing a seat the lobby had room for.
/// </param>
/// <param name="RunInProgress">
/// Whether the host is inside a run, which is what refuses launching a seat process that the host would refuse on
/// arrival. An unreadable answer is <see langword="false"/>, the answer an unreadable game has always given here.
/// </param>
public readonly record struct JoinSeatFacts(int? MaxCouchSeats, bool RunInProgress);
