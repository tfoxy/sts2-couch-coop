using Spirectl.Sts2.Core.State;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Decides whether the "Couch Co-Op QR Code" button belongs on screen right now.
/// </summary>
/// <remarks>
/// <para>
/// Pure so the gate is testable without a game. The controller calls this once per scan tick and
/// installs or removes the panel accordingly, which is also how the button disappears when the host
/// leaves the lobby — there is no separate teardown path to keep in sync.
/// </para>
/// </remarks>
public static class CouchCoopLobbyHostGate
{
    /// <summary>The lobby's <c>netGameType</c> for a session other devices can join.</summary>
    public const string HostNetGameType = "host";

    /// <summary>
    /// True when this instance is hosting a joinable lobby AND has a browser server for a phone to
    /// reach.
    /// </summary>
    /// <param name="listenerBaseUri">
    /// <c>CouchCoopHostUiSnapshot.ListenerBaseUri</c> — the port the browser server actually bound.
    /// <para>
    /// DELIBERATE divergence from the old overlay, which gated on <c>Available</c>. <c>Available</c>
    /// is false whenever no LAN IPv4 could be ranked, and the old overlay then rendered a diagnostics
    /// blob instead of a QR. The dialog does not need a ranked LAN address: its default option is this
    /// machine's <c>.local</c> name, which <see cref="MdnsResponder"/> answers even on a box whose only
    /// other addresses we refuse to advertise. Gating on the listener instead means "we have a server
    /// on a known port", which is the real precondition for a scannable URL. The no-address case is
    /// now surfaced by the dialog's own option list (it simply has fewer rows) rather than by hiding
    /// the entry point, and the lost diagnostics surface moved into the unit suite.
    /// </para>
    /// </param>
    /// <param name="state">
    /// Latest runtime state, or <see langword="null"/> when the state capability is unavailable (then
    /// the button stays hidden — we cannot prove we are hosting).
    /// </param>
    public static bool ShouldShow(Uri? listenerBaseUri, StateSnapshot? state)
        => listenerBaseUri is not null && IsHostLobby(state);

    /// <summary>
    /// The lobby predicate, matching <c>CouchCoopLobbyParticipation.MayLaunchNewHeadless</c>: no run in
    /// progress, and a character-select lobby whose net game type is <c>host</c>.
    /// <para>
    /// This covers BOTH lobby screens on purpose. The multiplayer load-saved-game screen
    /// (<c>NMultiplayerLoadGameScreen</c>) reports a <c>CharacterSelect</c> lobby with
    /// <c>NetGameType == "host"</c> and a non-null <c>SavedRun</c>, so the single predicate puts the
    /// button on the load screen too — which is required, since resuming a saved co-op run is exactly
    /// when absent players need to scan back in.
    /// </para>
    /// <para>
    /// A true singleplayer lobby reports <c>"singleplayer"</c> and is correctly refused: nothing can
    /// join it, so a QR would be a promise we cannot keep.
    /// </para>
    /// </summary>
    public static bool IsHostLobby(StateSnapshot? state)
        => state is { Run: null, CharacterSelect.Lobby.NetGameType: HostNetGameType };
}
