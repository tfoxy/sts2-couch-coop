namespace CouchCoop.Mod.Session;

/// <summary>
/// Whether this host can start couch seats at all, and — when it cannot — the one English sentence that says
/// why.
/// </summary>
/// <remarks>
/// <para>
/// A deliberately dumb seam, in the style of <see cref="HostUi.CouchCoopHostUiNotices"/>: a settable value with
/// no behaviour, so the seat allocator and the connection registry can state the cause without taking a
/// compile-time dependency on the networking layer or on any game type. The producer is
/// <see cref="CouchCoopHostTransport"/>, which is the only thing that knows.
/// </para>
/// <para>
/// WHY THIS EXISTS. <c>MaySpawnCouchSeat</c> already gates the launch, and
/// <see cref="HeadlessClientManager"/>'s launcher returns <see langword="null"/> when it is false — but a null
/// carries no reason, so the viewer's report said "The process launcher returned no process handle. No further
/// cause is available." while the host had known the actual cause since it started hosting. Measured Sep-22
/// 2026 during release validation: an orphaned game process from an earlier session still owned UDP 33771, the
/// couch ENet side could not bind, and every phone join failed in 141 ms with that sentence. The host's own
/// <c>godot.log</c> had 32 <c>[couchcoop]</c> lines for the session and not one of them mentioned the
/// transport.
/// </para>
/// <para>
/// Null is the healthy value and the default. Everything that reads it must treat null as "no opinion" and keep
/// whatever behaviour it had before — a genuine <c>Process.Start</c> returning null is still possible and still
/// has no cause to report.
/// </para>
/// </remarks>
/// <remarks>
/// PUBLIC, like <see cref="SeatReadinessVerdict"/> beside it, and for the same mechanical reason: it is named
/// from <c>Server/CouchCoopWebSocketConnection.cs</c>, and every type a <c>Server/*.cs</c> file mentions is
/// source-linked into the hot-reload project, which cannot see internals.
/// </remarks>
public static class CouchSeatAvailability
{
    /// <summary>
    /// The issue code every surface keys on: the host panel's copy map, the seat-refusal failure, and the
    /// <c>joinRejection</c> the browser renders. Shaped like the other host-side codes (see
    /// <c>SeatReadinessVerdict.PortTakenCode</c>) because it travels the same paths they do.
    /// </summary>
    public const string NoCouchListenerCode = "host-no-couch-listener";

    /// <summary>
    /// The English this condition reports under, at BOTH of its call sites — the host's own row raised at host
    /// start, and the refused player's row raised at join time. Word-for-word the
    /// <c>couchcoop_connection_error_host_no_couch_seats_*</c> catalog entries the panel renders above them, so
    /// a copyable report and the panel never read as two different diagnoses. Shared as constants rather than
    /// written out twice, so they cannot drift apart later.
    /// </summary>
    public const string IssueSummary = "Players on this computer can't join this lobby.";

    /// <inheritdoc cref="IssueSummary"/>
    public const string IssueAction =
        "Close any other copy of Slay the Spire 2 running on this computer, then host again.";

    /// <summary>
    /// Why no couch seat can start right now, or <see langword="null"/> when they can. English, technical, and
    /// destined for a copyable report — the translated sentences a player and a host actually read are resolved
    /// from catalog keys at each surface, with this riding underneath as the evidence.
    /// </summary>
    public static string? UnavailableDetail { get; set; }

    /// <summary>Forget the current host's answer. Called from every transport reset path.</summary>
    public static void Clear() => UnavailableDetail = null;
}
