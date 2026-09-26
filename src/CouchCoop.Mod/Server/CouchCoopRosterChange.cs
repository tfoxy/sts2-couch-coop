using CouchCoop.Mod.Contracts;
using System.Text.Json;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Diagnostic display of a roster read, and the predicate for leaving both the run and any lobby. The reaction uses
/// <see cref="RosterFacts"/> value equality to decide whether to re-send sessions.
/// </summary>
public static class CouchCoopRosterChange
{
    /// <summary>
    /// A trace representation of every roster fact. It is for comparing settled live reads in logs, not a change gate.
    /// </summary>
    /// <remarks>
    /// The JSON field names make name, character, role, connectivity, lobby/run presence, saved seats and scene visible
    /// without maintaining a second, potentially incomplete list of fields beside the value-equal records.
    /// </remarks>
    public static string Signature(RosterFacts roster)
    {
        ArgumentNullException.ThrowIfNull(roster);
        return JsonSerializer.Serialize(roster);
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
