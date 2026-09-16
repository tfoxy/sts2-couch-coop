namespace CouchCoop.Mod.Connections;

/// <summary>
/// What a seat is currently telling its viewers: a wire cause token (see
/// <c>CouchCoop.MirrorProtocol.Envelopes.BrowserSeatNoticeCauses</c>) and the host's own English technical line.
/// </summary>
/// <remarks>
/// A <see langword="null"/> <c>SeatNotice?</c> is "nothing to say", which on the wire becomes a WITHDRAWAL if the
/// viewer was last told something. The token, not the host's <c>SeatReadinessCause</c> enum, is what travels: this
/// type sits on the boundary between the seat monitor and a browser socket, and the enum's names and ordinals are
/// internal bookkeeping neither the wire nor this hub should inherit.
/// <para>
/// Public for the reason every other type in this namespace that a socket touches is: <c>CouchCoop.Mod.HotReload</c>
/// link-compiles <c>Server/*.cs</c> into its OWN assembly while referencing this one, so anything the WebSocket
/// connection names — <see cref="ConnectionRegistry"/>, <see cref="HeadlessConnectionControl"/>, and now this —
/// has to be reachable from outside <c>CouchCoop.Mod</c>.
/// </para>
/// </remarks>
public readonly record struct SeatNotice(string Cause, string Detail);

/// <summary>
/// Carries a seat's readiness verdict to the BROWSERS bound to that seat, on the socket they already have open.
/// </summary>
/// <remarks>
/// <para>
/// WHY IT EXISTS. The host names four causes precisely (<c>SeatReadinessVerdict</c>) and every one of them reached
/// the host's connection panel, the host log and the copyable report — and in the case that matters most to a
/// player, none of them reached the player. With the path from a device to its seat port blocked, the host's own
/// loopback probe of that seat succeeds, so the join is answered as a success and the browser is redirected to a
/// port it cannot open. The viewer then sits on "Loading…" forever while the host computes
/// <c>SeatReadinessCause.NetworkPath</c> about that exact seat, on real evidence, four times a second.
/// </para>
/// <para>
/// This is process-owned and generation-free, in the shape of <see cref="HeadlessConnectionControl"/>: the seat
/// monitor outlives any one hot-reloaded browser-server generation, and a viewer that drops and reconnects comes
/// back as a NEW session — which is exactly why the "what has this viewer already been told" record below is kept
/// per session id and dropped on unsubscribe, rather than per seat. A reconnecting phone re-learns the verdict on
/// the monitor's next tick instead of inheriting a delivery record that belonged to a socket that is gone.
/// </para>
/// <para>
/// THREE PROPERTIES, all enforced here rather than at the call site. It sends only on CHANGE, because the verdict
/// is recomputed four times a second and a frame per tick would be a flood of a sentence that has not moved. It
/// only ever reaches the sessions the caller names, so one seat's diagnosis can never appear on an unrelated
/// viewer's screen. And it cannot fault its caller: the monitor is a 250 ms loop whose own exception handler
/// kills the seat, so a delivery that throws is swallowed here — a diagnostic that breaks the thing it describes
/// is worse than no diagnostic.
/// </para>
/// </remarks>
public sealed class SeatNoticeHub
{
    /// <summary>The process-wide hub. The seat monitor publishes to it; each browser socket subscribes itself.</summary>
    public static SeatNoticeHub Shared { get; } = new();

    private readonly object _gate = new();
    private readonly Dictionary<Guid, Subscriber> _subscribers = [];

    /// <summary>
    /// Register <paramref name="deliver"/> as the way to reach the browser behind <paramref name="sessionId"/>.
    /// </summary>
    /// <remarks>
    /// <paramref name="deliver"/> is invoked on the seat monitor's loop thread and MUST NOT BLOCK — a socket
    /// write belongs in a task the delegate hands off, not in the delegate. A second subscribe for the same
    /// session replaces the first (a session id is one socket's, and the last registration is the live one).
    /// </remarks>
    public void Subscribe(Guid sessionId, Action<SeatNotice?> deliver)
    {
        ArgumentNullException.ThrowIfNull(deliver);
        lock (_gate) _subscribers[sessionId] = new Subscriber(deliver);
    }

    /// <summary>
    /// Forget this session: its socket is gone. Drops the "already told" record with it, so a viewer that
    /// reconnects under a new session id is told the current verdict rather than being debounced against a
    /// conversation that happened with a socket that no longer exists.
    /// </summary>
    public void Unsubscribe(Guid sessionId)
    {
        lock (_gate) _subscribers.Remove(sessionId);
    }

    /// <summary>
    /// Tell <paramref name="sessionId"/> what its seat is saying, if that is not what it was told last time.
    /// </summary>
    /// <param name="notice">
    /// The named cause, or <see langword="null"/> for "nothing to say". A null after a named cause is a
    /// WITHDRAWAL — the accusation is taken off the viewer's screen rather than left there once it stops being
    /// true. A null with nothing outstanding sends nothing at all, which is why a healthy join (permanently
    /// "still starting") is silent on the wire.
    /// </param>
    /// <returns>Whether anything was actually sent — for tests and for the caller's own logging.</returns>
    public bool Publish(Guid sessionId, SeatNotice? notice)
    {
        lock (_gate)
        {
            if (!_subscribers.TryGetValue(sessionId, out var subscriber))
            {
                // No socket for this session. Deliberately NOT recorded: a subscriber that registers a moment
                // later must receive the current verdict on the next tick, not be debounced against a delivery
                // that never happened.
                return false;
            }

            if (subscriber.Delivered == notice)
            {
                return false;
            }

            subscriber.Delivered = notice;
            try
            {
                subscriber.Deliver(notice);
            }
            catch
            {
                // A closing socket, or a handler that threw. The seat monitor must survive either: its own
                // exception path sets `process-monitor-failed` and tears the seat down, which would turn a
                // diagnostic into the outage it was describing.
            }

            return true;
        }
    }

    /// <summary>
    /// Drop every subscription. A test seam: in production a subscription is owned by the socket that made it
    /// and ends with it, so there is no state here for a hosting session to reset.
    /// </summary>
    public void Clear()
    {
        lock (_gate) _subscribers.Clear();
    }

    private sealed class Subscriber(Action<SeatNotice?> deliver)
    {
        public Action<SeatNotice?> Deliver { get; } = deliver;

        /// <summary>The last notice actually handed to <see cref="Deliver"/>; null means "told nothing".</summary>
        public SeatNotice? Delivered { get; set; }
    }
}
