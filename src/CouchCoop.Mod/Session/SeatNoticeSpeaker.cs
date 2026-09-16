using CouchCoop.Mod.Connections;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Decides what ONE seat should currently be telling its viewers, from the readiness verdict the seat monitor
/// already computes. A reader of <see cref="SeatReadinessVerdict"/>, never a second classifier.
/// </summary>
/// <remarks>
/// <para>
/// Two rules live here, and both exist so the phone is never told something worse than the truth.
/// </para>
/// <para>
/// SILENCE FOR "STILL STARTING". That cause is the normal state of every healthy join for the whole 20-60 seconds
/// a cold seat spawn takes; there is nothing behind it for a player to do, and announcing it would put a
/// diagnosis on every successful join. It maps to no wire token at all (see <see cref="CauseToken"/>), so it can
/// only ever WITHDRAW a notice already on screen — which is the other half of the same rule: an accusation that
/// has stopped being true must come off the screen rather than sit there being wrong.
/// </para>
/// <para>
/// A SETTLING DELAY BEFORE THE NETWORK IS BLAMED. See <see cref="NetworkPathSettlingDelay"/>.
/// </para>
/// <para>
/// One instance per seat (<c>HeadlessClientManager.OwnedConnection</c>), fed on the monitor's 250 ms tick. It
/// keeps no per-viewer state: which viewers have been told what is the hub's business, because a viewer that
/// drops and reconnects is a new session while the seat and its cause are the same.
/// </para>
/// </remarks>
internal sealed class SeatNoticeSpeaker(TimeProvider? time = null)
{
    /// <summary>
    /// How long the <see cref="SeatReadinessCause.NetworkPath"/> cause must hold before it is said out loud.
    /// </summary>
    /// <remarks>
    /// <para>
    /// TWENTY SECONDS, and the number is picked against what the gap it covers actually costs. The cause can
    /// first hold the instant the host's own loopback probe of the seat succeeds — which is BEFORE the browser
    /// has even been told which port to open. So the window has to cover the whole handoff: the join's reply
    /// travelling back over the host socket, the page opening a socket to the new origin, and that socket's
    /// upgrade request landing on the seat's listener, which is what the seat counts as an arrival. That is one
    /// TCP connect (plus a TLS handshake on the <c>+1</c> twin) and one request — NOT the 1.3 MB of JS and 417 KB
    /// of wasm, which download only after the arrival has already been counted. Sub-second on a LAN; a couple of
    /// seconds on a phone that is roaming between access points.
    /// </para>
    /// <para>
    /// Twenty is therefore about an order of magnitude of headroom over the legitimate gap, which is the margin
    /// this needs: the one thing this message may never do is tell a player whose phone was merely slow that
    /// their router is broken. It is also short enough to still be useful. Nothing else will ever speak — the
    /// browser's own 90 s join timeout is disarmed by the redirect, so a blocked viewer waits on "Loading…"
    /// indefinitely — and it lands inside the "this can take up to a minute" the join screen has already
    /// promised (WI-2), rather than after a player has concluded the minute is up.
    /// </para>
    /// <para>
    /// It does not overlap the 20-60 second cold spawn, despite being smaller than it: this cause cannot be
    /// evaluated at all until the seat is bound where expected, listening, lobby-joined and reachable from the
    /// host, so the spawn is already paid for before the clock starts.
    /// </para>
    /// <para>
    /// The other two causes are spoken at once. Both are host-side and already well guarded by the classifier —
    /// a port conflict is a disagreement the seat itself reported, and a host-local block requires a raw TCP
    /// connect that was dropped rather than refused — so waiting would only delay a message about a machine the
    /// viewer is not sitting at.
    /// </para>
    /// </remarks>
    public static readonly TimeSpan NetworkPathSettlingDelay = TimeSpan.FromSeconds(20);

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// <summary>The cause of the last verdict seen, and the timestamp it first became this cause.</summary>
    private SeatReadinessCause? _cause;
    private long _since;

    /// <summary>
    /// The notice this seat's viewers should be showing right now, or <see langword="null"/> for "nothing to
    /// say" — which the hub turns into a withdrawal for anyone currently being shown something.
    /// </summary>
    public SeatNotice? Observe(SeatReadinessVerdictResult verdict)
    {
        ArgumentNullException.ThrowIfNull(verdict);
        if (_cause != verdict.Cause)
        {
            // A fresh episode of this cause gets its own settling window: a seat that flickered in and out of
            // "the device never reached it" has not been in that state for the delay, whatever the first
            // episode's clock said.
            _cause = verdict.Cause;
            _since = _time.GetTimestamp();
        }

        if (CauseToken(verdict.Cause) is not { } token)
        {
            return null;
        }

        if (verdict.Cause == SeatReadinessCause.NetworkPath
            && _time.GetElapsedTime(_since) < NetworkPathSettlingDelay)
        {
            return null;
        }

        return new SeatNotice(token, verdict.Detail);
    }

    /// <summary>
    /// The wire spelling of a cause, or <see langword="null"/> for one that is never announced. An unrecognised
    /// cause is treated as unannounceable rather than leaking an enum name onto a player's screen.
    /// </summary>
    internal static string? CauseToken(SeatReadinessCause cause) => cause switch
    {
        SeatReadinessCause.PortConflict => BrowserSeatNoticeCauses.PortConflict,
        SeatReadinessCause.HostLocalBlock => BrowserSeatNoticeCauses.HostLocalBlock,
        SeatReadinessCause.NetworkPath => BrowserSeatNoticeCauses.NetworkPath,
        _ => null,
    };
}
