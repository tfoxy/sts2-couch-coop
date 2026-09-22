using Spirectl.Sts2.Core.State;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Decides whether the pause menu's "Couch Co-Op QR Code" row belongs on screen right now.
/// </summary>
/// <remarks>
/// <para>
/// The mid-run twin of <see cref="CouchCoopLobbyHostGate"/>, and pure for the same reason: the entry
/// re-evaluates it every time the pause menu becomes visible and shows or hides the row from the answer, so
/// this predicate is also the row's teardown path. Testable without a game.
/// </para>
/// <para>
/// WHY A RUN NEEDS A DIFFERENT PREDICATE AT ALL. <see cref="CouchCoopLobbyHostGate.IsHostLobby"/> requires
/// <c>Run: null</c> — it answers "can a NEW device join?", which is only true in a lobby. This one answers a
/// narrower question: "is the URL this host would hand out worth anything?". Mid-run the answer is yes for a
/// device that already has a seat and lost its browser — a locked phone, a closed tab, a dropped Wi-Fi — which
/// is precisely the case the lobby button can no longer serve, because the lobby is gone.
/// </para>
/// </remarks>
public static class CouchCoopPauseMenuGate
{
    /// <summary>
    /// True when this instance has a browser server AND is hosting a multiplayer run.
    /// </summary>
    /// <param name="listenerBaseUri">
    /// <c>CouchCoopHostUiSnapshot.ListenerBaseUri</c> — the port the browser server actually bound. Same
    /// reasoning as the lobby gate: "we have a server on a known port" is the real precondition for a scannable
    /// URL, and the dialog surfaces a missing LAN address itself rather than having the entry point hidden.
    /// </param>
    /// <param name="state">
    /// Latest runtime state, or <see langword="null"/> when the state capability is unavailable — then the row
    /// stays hidden, because we cannot prove we are hosting.
    /// </param>
    public static bool ShouldShow(Uri? listenerBaseUri, StateSnapshot? state)
        => listenerBaseUri is not null && IsHostRun(state);

    /// <summary>
    /// A live run this instance is HOSTING.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A true singleplayer run reports <c>"singleplayer"</c> and is refused: nothing can join it, so a QR would
    /// be a promise we cannot keep. A run we joined as someone else's client is refused too — that session's
    /// browser players belong to ITS host, and our URL would hand out a seat we do not own.
    /// </para>
    /// <para>
    /// A couch-coop host reports <c>"host"</c> even when it is alone in the run (a multiplayer host is a host
    /// whatever transport it runs on), which is what keeps the row reachable for a player whose only couch
    /// companion dropped out — the exact moment they need it.
    /// </para>
    /// </remarks>
    public static bool IsHostRun(StateSnapshot? state)
        => state is { Run.NetGameType: CouchCoopLobbyHostGate.HostNetGameType };
}
