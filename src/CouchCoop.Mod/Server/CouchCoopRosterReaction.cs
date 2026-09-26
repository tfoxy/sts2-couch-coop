using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server;

/// <summary>
/// What the browser server does with each roster the roster observer reads: on a change, republish the names and re-send
/// every connection's session; once the game has left both the run and any lobby, reap the detached seats.
/// </summary>
/// <remarks>
/// The effects are injected so the decisions are testable without a server, a game or a seat process. Not thread-safe
/// across calls: <see cref="Apply"/> is called one roster at a time (the server serialises them), while
/// <see cref="Reset"/> may come from any thread.
/// </remarks>
public sealed class CouchCoopRosterReaction(
    Action<IReadOnlyList<(ulong NetId, string Name)>>? publishNames,
    Action resendSessions,
    Action? reapDetachedSeats,
    Action<string>? log = null)
{
    private readonly Action<string> _log = log ?? CouchCoopLog.Stderr;
    private readonly object _gate = new();
    private string? _lastSignature;

    /// <summary>
    /// Forget the last roster signature, so the next roster read counts as a change. Called when the observer that
    /// produced the signature stops: the next observer must be free to re-broadcast the very first roster it reads.
    /// </summary>
    public void Reset()
    {
        lock (_gate)
        {
            _lastSignature = null;
        }
    }

    /// <summary>Apply one roster: the change broadcast first, then the reap, in the order the join screen needs them.</summary>
    public void Apply(RosterFacts roster)
    {
        ArgumentNullException.ThrowIfNull(roster);
        RebroadcastIfChanged(roster);
        if (reapDetachedSeats is not null && CouchCoopRosterChange.HasLeftRunAndLobby(roster))
        {
            reapDetachedSeats();
        }
    }

    private void RebroadcastIfChanged(RosterFacts roster)
    {
        var signature = CouchCoopRosterChange.Signature(roster);
        lock (_gate)
        {
            if (string.Equals(signature, _lastSignature, StringComparison.Ordinal))
            {
                return;
            }

            _lastSignature = signature;
        }

        // Host-only: the roster just changed, so republish the netId→name map the couch seats read (mp_names.json).
        // This is what names a player the seats CANNOT resolve themselves — the host (a SteamID64 on a Steam-hosted
        // session) and any genuine remote Steam friend — on instances that are already running. Free here: the roster
        // is in hand, and the signature gate above means it runs on a real roster change rather than every read.
        //
        // The join handler publishes too (CouchCoopWebSocketConnection), which is the path that matters for a seat about
        // to be spawned. Between them the only uncovered case is a remote player joining while NO browser is attached to
        // the host at all — this observer is connection-driven, so there is nobody to drive it then, and the next join
        // message closes the gap.
        if (publishNames is not null)
        {
            try
            {
                publishNames(CouchCoopLobbyParticipation.RosterNames(roster));
            }
            catch (Exception exception)
            {
                // Naming is cosmetic: never let it break the session rebroadcast this method exists for.
                _log($"publishing roster names failed: {exception.GetType().Name}: {exception.Message}");
            }
        }

        resendSessions();
    }
}
