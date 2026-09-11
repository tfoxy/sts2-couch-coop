using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.Activity;

/// <summary>
/// Every sentence the host connectivity log can print, in one place.
/// </summary>
/// <remarks>
/// <para>
/// The audience is the person holding the TV remote, not the person holding the debugger. So: no slot
/// numbers, no netIds, no ports, no exception type names — the parallel <see cref="System.Console.Error"/>
/// line at each emission point still carries all of that, byte for byte, for whoever is attached to a
/// terminal. What survives here is the fact a player can act on ("every player slot is in use") rather
/// than the mechanism that produced it.
/// </para>
/// <para>
/// <b>These strings are a QA contract.</b> The unit suite asserts them literally and the live probe greps
/// the rendered panel for them, so an edit here is an edit to two other files. That is intentional: the
/// wording IS the feature, and a silent copy change would otherwise land unreviewed.
/// </para>
/// <para>
/// <b>No gendered pronouns.</b> The mod knows a display name and nothing else, so every sentence that
/// needs one uses singular <i>they</i>. It reads correctly for the "A player" fallback too.
/// </para>
/// <para>
/// Pure — no Godot, no IO, no state. That is what lets the whole copy surface be unit-tested in a
/// Godot-less host while the panel that renders it stays untested and trivial.
/// </para>
/// </remarks>
public static class CouchCoopActivityMessages
{
    /// <summary>Stands in for a viewer who joined without a name (an anonymous browser, a freed seat).</summary>
    public const string UnnamedPlayerKey = "couchcoop_activity_unnamed_player";

    /// <summary>A player's display name as it should be read aloud, or <see cref="UnnamedPlayer"/>.</summary>
    public static CouchCoopTextArgument Who(string? name)
    {
        var trimmed = name?.Trim();
        return string.IsNullOrEmpty(trimmed)
            ? CouchCoopTextArgument.LocalizedValue(new CouchCoopText(UnnamedPlayerKey))
            : CouchCoopTextArgument.Value(trimmed);
    }

    // ---- seats: a player's headless game window (S1..S17) ------------------------------------------------

    /// <summary>S1/S2 — a returning browser re-claimed a still-running game window.</summary>
    public static CouchCoopText SeatReconnected(string? name) => Named("couchcoop_activity_seat_reconnected", name);

    /// <summary>S3 — every slot has a live instance, so there is nothing left to give this player.</summary>
    public static CouchCoopText SeatPoolFull(string? name) => Named("couchcoop_activity_seat_pool_full", name);

    /// <summary>S4 — the launch is starting. Emitted BEFORE the process, because the wait is the long part.</summary>
    public static CouchCoopText SeatLaunching(string? name) => Named("couchcoop_activity_seat_launching", name);

    /// <summary>S5/S6 — the launcher threw, or returned nothing.</summary>
    public static CouchCoopText SeatLaunchFailed(string? name) => Named("couchcoop_activity_seat_launch_failed", name);

    /// <summary>S7 — the process exists. It is NOT playable yet; the ~20-30s asset preload starts here.</summary>
    public static CouchCoopText SeatLaunchOpened(string? name) => Named("couchcoop_activity_seat_launch_opened", name);

    /// <summary>S8 — this host has no ENet listener, so a seat could boot but would never reach the game.</summary>
    public static CouchCoopText SeatNoLocalTransport(string? name) => Named("couchcoop_activity_seat_no_transport", name);

    /// <summary>S9 — the process died during its own start-up.</summary>
    public static CouchCoopText SeatExitedEarly(string? name) => Named("couchcoop_activity_seat_exited_early", name);

    /// <summary>S10 — the instance is serving; the phone is about to be redirected onto it.</summary>
    public static CouchCoopText SeatReady(string? name) => Named("couchcoop_activity_seat_ready", name);

    /// <summary>S11 — the readiness deadline expired; the half-started instance is being killed.</summary>
    public static CouchCoopText SeatStartTimedOut(string? name) => Named("couchcoop_activity_seat_start_timed_out", name);

    /// <summary>S12 — the browser closed OUTSIDE a run, so the window was closed with it.</summary>
    public static CouchCoopText SeatReleased(string? name) => Named("couchcoop_activity_seat_released", name);

    /// <summary>S13 — the browser closed DURING a run; the window is kept so the same player can come back.</summary>
    public static CouchCoopText SeatDetached(string? name) => Named("couchcoop_activity_seat_detached", name);

    /// <summary>S14 — a zombie (up, but the game refused or dropped its peer) is being reaped.</summary>
    public static CouchCoopText SeatStuckReaped(string? name) => Named("couchcoop_activity_seat_stuck_reaped", name);

    /// <summary>S15 — a process we still held a handle for had already exited (crash / external kill).</summary>
    public static CouchCoopText SeatWindowGone(string? name) => Named("couchcoop_activity_seat_window_gone", name);

    /// <summary>S16 — the host quit the run, so the kept-alive windows of departed browsers go with it.</summary>
    public static CouchCoopText SeatRunEndReaped(string? name) => Named("couchcoop_activity_seat_run_end", name);

    /// <summary>S17 — the host game is exiting. Printed once, however many windows are open.</summary>
    public static CouchCoopText SeatsShuttingDown => new("couchcoop_activity_seats_shutting_down");

    // ---- viewers: a browser on the host's own server (V1..V5) --------------------------------------------

    /// <summary>V1 — a structured (non-mirror) client joined and is being served by the host directly.</summary>
    public static CouchCoopText ViewerConnected(string? name) => Named("couchcoop_activity_viewer_connected", name);

    /// <summary>V2 — a mirror client is watching the host's own screen rather than taking a seat.</summary>
    public static CouchCoopText ViewerWatching(string? name) => Named("couchcoop_activity_viewer_watching", name);

    /// <summary>V3 — the browser is being redirected to its own game window (the seat hand-off).</summary>
    public static CouchCoopText ViewerHandedOff(string? name) => Named("couchcoop_activity_viewer_handed_off", name);

    /// <summary>V4 — the join was refused. <paramref name="rejectionCode"/> is the wire code.</summary>
    public static CouchCoopText ViewerRejected(string? name, string? rejectionCode)
        => CouchCoopText.Create("couchcoop_activity_viewer_rejected", ("name", Who(name)), ("reason", CouchCoopTextArgument.LocalizedValue(DescribeJoinRejection(rejectionCode))));

    /// <summary>V5 — a browser that HAD announced itself went away without being handed to a seat.</summary>
    public static CouchCoopText ViewerDisconnected(string? name) => Named("couchcoop_activity_viewer_disconnected", name);

    /// <summary>
    /// Player-facing reason for a <c>joinRejection</c> wire code. An unknown code falls back to the raw
    /// string rather than to a friendly lie: a code this table has not learned yet is still more useful on
    /// screen than "something went wrong".
    /// </summary>
    public static CouchCoopText DescribeJoinRejection(string? rejectionCode)
        => rejectionCode switch
        {
            "no-free-instance" => new("couchcoop_activity_rejection_no_free_instance"),
            "not-a-session-player" => new("couchcoop_activity_rejection_not_session_player"),
            "spawn-failed" => new("couchcoop_activity_rejection_spawn_failed"),
            "join-failed" => new("couchcoop_activity_rejection_join_failed"),
            // MirrorSeatStatuses.UnavailableRejection. Spelled literally so this file stays free of protocol
            // types — see the assembly-boundary note in CouchCoopActivityLog's header.
            "seat-unavailable" => new("couchcoop_activity_rejection_seat_unavailable"),
            _ => string.IsNullOrWhiteSpace(rejectionCode)
                ? new CouchCoopText("couchcoop_activity_rejection_default")
                : CouchCoopText.FromLiteral(rejectionCode),
        };

    // ---- the host's own services (B1..B7) ----------------------------------------------------------------

    /// <summary>B1 — the browser server is up and this is the address a phone should be pointed at.</summary>
    public static CouchCoopText BrowserServerReady(string? joinBaseUri)
        => CouchCoopText.Create("couchcoop_activity_browser_ready", ("url", CouchCoopTextArgument.Value(joinBaseUri)));

    /// <summary>B2 — the server bound, but nothing on this PC is worth advertising to a phone.</summary>
    public static CouchCoopText BrowserServerNoAddress => new("couchcoop_activity_browser_no_address");

    /// <summary>B3/B7 — the browser server did not come up at all. The one event a host MUST see.</summary>
    public static CouchCoopText BrowserServerFailed => new("couchcoop_activity_browser_failed");

    /// <summary>B4 — the opt-in TLS listener is live.</summary>
    public static CouchCoopText SecureOriginReady => new("couchcoop_activity_secure_ready");

    /// <summary>B5 — the secure origin is not on offer; <paramref name="reason"/> remains semantic until display.</summary>
    public static CouchCoopText SecureOriginUnavailable(CouchCoopText? reason)
        => reason is { } value
            ? CouchCoopText.Create("couchcoop_activity_secure_unavailable_reason",
                ("reason", CouchCoopTextArgument.LocalizedValue(value)))
            : new CouchCoopText("couchcoop_activity_secure_unavailable");

    /// <summary>B6 — the browser server was torn down (host shutdown, or a restart).</summary>
    public static CouchCoopText BrowserServerStopped => new("couchcoop_activity_browser_stopped");

    // ---- seat status transitions (MirrorSeatDirectory) ---------------------------------------------------

    /// <summary>A seat the pickers were offering has become unusable mid-run.</summary>
    public static CouchCoopText SeatWentOffline(string? name) => Named("couchcoop_activity_seat_offline", name);

    /// <summary>A seat that had been refused is being offered again.</summary>
    public static CouchCoopText SeatAvailableAgain(string? name) => Named("couchcoop_activity_seat_available", name);

    private static CouchCoopText Named(string key, string? name)
        => CouchCoopText.Create(key, ("name", Who(name)));
}
