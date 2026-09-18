using System.Globalization;
using System.Text;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

/// <summary>Why a seat is not yet serving its browser. One cause per fix.</summary>
internal enum SeatReadinessCause
{
    /// <summary>Nothing is wrong. A cold seat routinely takes 20-60 seconds to come up.</summary>
    StillStarting,

    /// <summary>Something else on this computer owns the port the browser was, or would be, sent to.</summary>
    PortConflict,

    /// <summary>The seat is listening on the expected port and this computer still cannot reach it.</summary>
    HostLocalBlock,

    /// <summary>The seat is up and the host can reach it; the viewer's device never did.</summary>
    NetworkPath,
}

/// <summary>Everything the HOST knows about one seat's readiness, at one moment.</summary>
/// <param name="ExpectedPort">
/// <c>HeadlessClientManager.SlotToPort(slot)</c> — the port handed to the browser and probed for readiness.
/// </param>
/// <param name="ReportedPort">
/// The port the seat says it actually bound, over its authenticated heartbeat. <c>0</c> until it has said,
/// which is a different answer from a disagreement and must never read as one.
/// </param>
/// <param name="PortOwner">
/// What the pre-spawn check found owning <paramref name="ExpectedPort"/>, or <see langword="null"/>. English.
/// </param>
/// <param name="HostMember">Whether the host's own lobby lists this seat's netId.</param>
/// <param name="NativePhase">The seat's self-reported phase, or <see langword="null"/> when it has not reported.</param>
/// <param name="HeartbeatFresh">Whether an authenticated seat heartbeat arrived inside the freshness window.</param>
/// <param name="ListenerResponding">
/// The host's own loopback HTTP probe of <paramref name="ExpectedPort"/>: <see langword="null"/> until it has run.
/// </param>
/// <param name="ProbeFailure">
/// WHY that probe failed — exception type / socket error, how long it took, and then what the follow-up raw TCP
/// connect found (<c>"TaskCanceledException after 812 ms; TCP connect succeeded"</c>). Recorded because the
/// message split below cannot be trusted without it: "not responding" was the single unexplained signal the old
/// sentence was built on. Composed in one place, <c>HeadlessClientManager.DefaultHttpReadinessAsync</c>, so the
/// evidence tail never has to re-derive it from <paramref name="TcpReachability"/> and risk saying it twice.
/// </param>
/// <param name="TcpReachability">
/// What a raw TCP connect found straight after a failed HTTP probe. The HTTP timeout alone does NOT separate a
/// dropped packet from a listener that is bound but wedged — both time out identically — and only the first of
/// those is a firewall.
/// </param>
/// <param name="ConnectedBrowserCount">How many browsers the seat says are attached to it.</param>
/// <param name="SeatViewerArrivals">
/// How many requests from something other than this machine have reached the SEAT's own listener, as the seat
/// itself reports it over the authenticated heartbeat; <see langword="null"/> until it has said. The only fact in
/// this record the host cannot take for itself — that request lands in another process and leaves no trace here —
/// and the one that separates "the device never got through" from "the viewer has not tapped the link yet".
/// Loopback is excluded at the source, so the host's own readiness probe of this seat is never counted as a
/// device, and an arrival whose remote address could not be read counts AS one: this number can only ever be too
/// generous, never too accusing.
/// </param>
/// <param name="ElapsedMs">How long this attempt has been waiting.</param>
/// <param name="DeadlineMs">The wait it is measured against.</param>
/// <param name="ControlChannel">
/// What this host has HEARD from the seat, and REFUSED from anything, on the authenticated control channel —
/// English, composed once in <c>HeadlessClientManager.DescribeControlChannel</c> for the same reason
/// <paramref name="ProbeFailure"/> is composed in one place.
/// <para>
/// Evidence only: no verdict below turns on it, because the cause it speaks to (the seat cannot reach the host
/// at all) is settled at the contact deadline rather than here. It prints on EVERY verdict because it is free —
/// the counters ride the status snapshot the loop already takes — and because its absence is what made a
/// missing heartbeat unreadable: "nothing arrived" and "this host refused what arrived" were the same silence.
/// </para>
/// </param>
internal sealed record SeatReadinessFacts(
    int ExpectedPort,
    int ReportedPort,
    string? PortOwner,
    bool HostMember,
    string? NativePhase,
    bool HeartbeatFresh,
    bool? ListenerResponding,
    string? ProbeFailure,
    SeatPortReachability TcpReachability,
    int ConnectedBrowserCount,
    long? SeatViewerArrivals,
    long ElapsedMs,
    long DeadlineMs,
    string? ControlChannel = null);

/// <summary>A named cause, its English technical detail, and the issue it becomes if the wait runs out.</summary>
internal sealed record SeatReadinessVerdictResult(SeatReadinessCause Cause, string Detail)
{
    public ConnectionIssue Issue => SeatReadinessVerdict.IssueFor(Cause, Detail);
}

/// <summary>
/// Turns the host's own facts about a seat into ONE named cause, instead of one sentence that fitted several.
/// </summary>
/// <remarks>
/// <para>
/// WHAT THIS REPLACES. The host built a single readiness sentence ending in
/// <c>child HTTP listener: not responding</c>, and printed it for at least three unrelated conditions: a foreign
/// program on the seat's port, a local firewall rule dropping the host's own loopback probe, and a blocked path
/// between the phone and a seat that was serving perfectly. The three need opposite fixes and were
/// indistinguishable from the text — measured Sep-15 2026, byte-identical across two of them. The line even
/// contradicted itself for anyone who knew the system: <c>authenticated heartbeat fresh: True</c> proves the seat
/// process is alive and talking to the host, in the same sentence that calls its listener unresponsive.
/// </para>
/// <para>
/// THE DETAIL STAYS ENGLISH. It is quoted verbatim into the copyable report and rendered as the grey technical
/// line under the friendly message, on the panel and on the phone. The friendly summary and next action above it
/// ARE localized, by issue code, through <c>CouchCoopConnectionPanel.IssueKey</c> — which is why each cause needs
/// its own code rather than a differently-worded detail under one.
/// </para>
/// <para>
/// EVERY MESSAGE CARRIES THE SAME EVIDENCE TAIL, so a report that names the wrong cause can still be re-read: the
/// verdict is an interpretation of the facts, and the facts are printed beside it.
/// </para>
/// <para>
/// PUBLIC for one reason, and it is a build constraint rather than a design one: <c>Server/*.cs</c> is
/// link-compiled into <c>CouchCoop.Mod.HotReload</c> as a second assembly, and
/// <c>CouchCoopWebSocketConnection.ClassifyFailedSpawn</c> names the four codes below to decide which
/// <c>joinRejection</c> a refused join carries. <c>Session/</c> is NOT link-compiled, so <c>internal</c> here
/// compiles perfectly in <c>CouchCoop.Mod</c> and then breaks the other project — where no test suite would
/// have caught it. The CODES are the public surface; everything that interprets them stays internal.
/// </para>
/// </remarks>
public static class SeatReadinessVerdict
{
    /// <summary>
    /// The connection issue a seat whose assigned browser port has a foreign owner is reported as — whether the
    /// host found that owner before spawning, or the seat itself reported a different bound port afterwards.
    /// Public-by-const because the report copy and the host panel's issue mapping both key on the literal.
    /// </summary>
    public const string PortTakenCode = "seat-port-taken";

    /// <summary>The seat is listening where it should be and THIS computer cannot reach it.</summary>
    public const string PortBlockedCode = "seat-port-blocked";

    /// <summary>The seat is reachable from the host; the viewer's device never arrived.</summary>
    public const string NetworkPathCode = "seat-network-path";

    /// <summary>Nothing was wrong; it was simply not finished. The pre-existing code, unchanged.</summary>
    public const string StillStartingCode = "startup-timeout";

    internal static SeatReadinessVerdictResult Describe(SeatReadinessFacts facts)
    {
        ArgumentNullException.ThrowIfNull(facts);
        var cause = Classify(facts);
        return new SeatReadinessVerdictResult(cause, $"{Cause(cause, facts)} {Evidence(facts)}");
    }

    private static SeatReadinessCause Classify(SeatReadinessFacts facts)
    {
        // 1. A known owner, or a seat serving somewhere other than where we send the browser. Either way the
        //    address the player is handed answers to something that is not their game.
        if (facts.PortOwner is not null
            || (facts.ReportedPort > 0 && facts.ReportedPort != facts.ExpectedPort))
        {
            return SeatReadinessCause.PortConflict;
        }

        // Everything below needs the seat's own word for where it is. A seat that has not reported a port yet is
        // simply not up — never a disagreement, and never grounds for accusing a firewall.
        var boundWhereExpected = BoundWhereExpected(facts);

        // 2. It says it is listening there, this computer cannot reach it from 127.0.0.1, AND the raw connect
        //    was dropped rather than answered. This is the case an unscoped
        //    `iptables -I INPUT -p tcp --dport 13347:13417 -j DROP` produces: it sits above any `-i lo ACCEPT`
        //    and drops the host's own probe.
        //
        //    THE SECOND CLAUSE IS NOT BELT-AND-BRACES. A failed HTTP probe on its own fits two states that need
        //    opposite advice: the dropped packet above, and a listener that is BOUND BUT WEDGED — its accept
        //    loop stuck, or its HTTP server still initialising — which completes the TCP handshake out of the
        //    kernel backlog and only fails the read. Both print the same client-side timeout. Sending the second
        //    player to their firewall settings would be this round's own mistake repeated: a message naming the
        //    wrong component. So the block is claimed only where a connect could not complete at all; a connect
        //    that was ACCEPTED (wedged) or REFUSED (nothing listening yet) falls through to "still starting",
        //    which is the honest answer in both, and the evidence tail records which it was.
        if (boundWhereExpected
            && facts.ListenerResponding == false
            && facts.TcpReachability == SeatPortReachability.Unreachable)
        {
            return SeatReadinessCause.HostLocalBlock;
        }

        // 3. It is listening there, the host reached it, the lobby has it, no browser ever completed a
        //    connection — AND the seat itself has seen nothing arrive from outside this machine.
        //
        //    THE LAST CLAUSE IS WHAT MAKES THIS AN OBSERVATION. Without it this verdict rested on
        //    ConnectedBrowserCount == 0, which says only "no browser FINISHED connecting" and fits a blocked
        //    path and a viewer who has not tapped the link yet equally well — and it accused the player's
        //    network on the strength of that. The seat knows the difference, because anything from a real
        //    device that reached its listener is in the seat's own arrival log, and it carries the count up on
        //    its heartbeat.
        //
        //    AN AFFIRMATIVE ZERO, never a missing one. `null` is "the seat has not said" and falls through:
        //    this is the one cause that blames something the player owns, and it may not be reached by a field
        //    that merely defaulted.
        if (HostSideIsClear(facts) && facts.SeatViewerArrivals == 0)
        {
            return SeatReadinessCause.NetworkPath;
        }

        // AND THE NEAR MISS IS DELIBERATELY NOT A FIFTH CAUSE. Everything above true except the zero — the seat
        // WAS reached and no browser connection completed — sounds specific and is not:
        //   * it is the normal state of every healthy join for as long as the seat's page is loading. The first
        //     arrival is the SPA document; the browser is only counted at the WebSocket upgrade, and 1.3 MB of
        //     JS plus a 417 KB wasm separate the two on a phone. A cause here would print a diagnosis over
        //     every successful join and defeat the silence the monitor's still-starting gate exists for.
        //   * the count is process-wide, not per-visit, so "something reached the seat" is not "THIS device
        //     reached the seat" — a second viewer, a reload, or a LAN scanner produces the same number. The
        //     specific claim it appears to license is one this evidence cannot support.
        //   * a cause exists to name a fix (one enum member, one pair of catalog entries, one next action), and
        //     this condition has no single fix behind it: a refused upgrade, a page that failed to boot, a
        //     closed tab and a reload loop all land here.
        // So it stays "still starting" — honest — and says what it saw in one extra English sentence plus the
        // evidence tail, instead of fourteen catalogs of advice nobody could act on.
        return SeatReadinessCause.StillStarting;
    }

    /// <summary>Whether the seat is bound where the host expects it and the host's own probe agrees.</summary>
    private static bool BoundWhereExpected(SeatReadinessFacts facts)
        => facts.HeartbeatFresh && facts.ReportedPort == facts.ExpectedPort;

    /// <summary>
    /// Everything the network-path verdict needs from the HOST's side of the wire: the seat is listening where
    /// the browser is being sent, the lobby has it, this computer can reach it, and no browser has ever completed
    /// a connection to it. Shared by the classifier and the message so the "was reached anyway" sentence is
    /// spoken in exactly the state that would otherwise have been a network-path verdict, and nowhere else.
    /// </summary>
    private static bool HostSideIsClear(SeatReadinessFacts facts)
        => BoundWhereExpected(facts)
            && facts.HostMember
            && facts.ListenerResponding == true
            && facts.ConnectedBrowserCount == 0;

    private static string Cause(SeatReadinessCause cause, SeatReadinessFacts facts)
    {
        var port = facts.ExpectedPort.ToString(CultureInfo.InvariantCulture);
        switch (cause)
        {
            case SeatReadinessCause.PortConflict:
            {
                var text = new StringBuilder($"Another program on this computer is using port {port}.");
                if (facts.ReportedPort > 0 && facts.ReportedPort != facts.ExpectedPort)
                {
                    text.Append(
                        $" This player's game bound port {facts.ReportedPort.ToString(CultureInfo.InvariantCulture)} "
                        + "instead, so the address the browser was given answers to something else.");
                }

                if (facts.PortOwner is { Length: > 0 } owner)
                {
                    text.Append($" Found before this player's game was started: {owner}.");
                }

                return text.ToString();
            }

            case SeatReadinessCause.HostLocalBlock:
                return $"This player's game is listening on port {port}, but this computer cannot reach that port "
                    + "from itself, so something on this computer is blocking it locally (a firewall rule, or "
                    + "security software).";

            case SeatReadinessCause.NetworkPath:
                return NetworkPathCause(facts.ExpectedPort, OperatingSystem.IsMacOS(), OperatingSystem.IsWindows());

            default:
            {
                var text = new StringBuilder("This player's game is still starting, and nothing has failed yet.");
                // The near miss of the network-path verdict, said out loud. Everything about the host is fine
                // and no browser has connected — the shape that used to be reported as a blocked path — but the
                // seat has been reached, so the one thing this state is NOT is a device that never got through.
                // Deliberately "something", not "this device": the count is process-wide (see Classify).
                if (HostSideIsClear(facts) && facts.SeatViewerArrivals > 0)
                {
                    text.Append(" Something from outside this computer has already reached this player's game, "
                        + "so the path to it is not the problem — no browser has finished connecting to it yet.");
                }

                return text.ToString();
            }
        }
    }

    /// <summary>
    /// The English detail for a blocked path to the seat, naming the host-side gate the CURRENT platform is
    /// most likely to be holding shut. Pure and platform-injected so all three wordings are testable off their
    /// own OS — the shape <c>HostReachabilityWatch.Describe</c> already uses for the same reason.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THE HOST'S OWN FIREWALL IS NAMED FIRST HERE, in the one verdict that blames the network. This cause
    /// is reached only when the host's loopback probe SUCCEEDED, and MEASURED Sep-17 2026 on Windows 11 with
    /// the real game: with an inbound Block rule on the browser port scoped to one peer, the host's own
    /// loopback HTTP probe still returned 200 and its raw loopback connect was still accepted in 438 ms, while
    /// that peer timed out with no RST. Windows does not filter a machine's traffic to itself, so a
    /// host-firewall block is INVISIBLE to every check this verdict makes and lands here — under copy that used
    /// to send the operator to their router and their Wi-Fi, which are not the problem in that case.
    /// </para>
    /// <para>
    /// The router and guest/AP isolation are still named, because they produce exactly the same evidence and
    /// are genuinely common. The point of the split is only that the host's own firewall is the one cause the
    /// operator can act on at the machine they are already sitting at, and on Windows it is the likeliest.
    /// </para>
    /// </remarks>
    internal static string NetworkPathCause(int port, bool isMacOS, bool isWindows)
    {
        var gate = isMacOS
            ? "this computer's firewall (System Settings > Network > Firewall) and its Local Network permission "
                + "for this game (System Settings > Privacy & Security > Local Network)"
            : isWindows
                ? "this computer's firewall — the game needs an inbound allow rule, and a network marked Public "
                    + "blocks far more than one marked Private"
                : "this computer's firewall or security software";
        return "This player's game is running and answering on the host, but the device never reached it. "
            + $"Something between the two is dropping the connection to port {port}: {gate}, security software, "
            + "guest/AP isolation on the router, or the device being on a different network. NOTE: this host "
            + "reached the port from itself, which does NOT rule its own firewall out — a machine's traffic to "
            + "itself is not filtered, so a host-side block looks exactly like this.";
    }

    private static string Evidence(SeatReadinessFacts facts)
    {
        var probe = facts.ListenerResponding switch
        {
            null => "not yet probed",
            true => "responding",
            false => $"not responding ({facts.ProbeFailure ?? "no failure detail was captured"})",
        };
        return "Observed: assigned port "
            + facts.ExpectedPort.ToString(CultureInfo.InvariantCulture)
            + "; port this player's game reports it bound: "
            + (facts.ReportedPort > 0 ? facts.ReportedPort.ToString(CultureInfo.InvariantCulture) : "not reported")
            + "; host lobby membership: " + facts.HostMember
            + "; child phase: " + (facts.NativePhase ?? "not reported")
            + "; authenticated heartbeat fresh: " + facts.HeartbeatFresh
            + "; host loopback probe of the assigned port: " + probe
            + "; browsers connected to this player's game: "
            + facts.ConnectedBrowserCount.ToString(CultureInfo.InvariantCulture)
            // Read as a pair with the line above it, which is why it sits here: "requests N, browsers 0" is a
            // device that arrived and did not finish, "requests 0, browsers 0" is a device that never arrived,
            // and before this the report could only print the second half of that and guess at the first.
            + "; requests to this player's game from outside this computer: "
            + (facts.SeatViewerArrivals is { } arrivals
                ? arrivals.ToString(CultureInfo.InvariantCulture)
                : "not reported")
            // Read as a pair with "authenticated heartbeat fresh" above, which says only that no status is
            // CURRENT. This says whether one ever arrived, and whether this host threw any away.
            + (facts.ControlChannel is { Length: > 0 } control ? "; " + control : string.Empty)
            // The monitor keeps producing verdicts after the join wait is over, where there is no deadline left
            // to measure against and quoting one would be an invention.
            + (facts.DeadlineMs > 0
                ? "; waited " + Seconds(facts.ElapsedMs) + " of " + Seconds(facts.DeadlineMs) + " seconds."
                : "; " + Seconds(facts.ElapsedMs) + " seconds since this seat was claimed.");
    }

    private static string Seconds(long milliseconds)
        => Math.Max(0, milliseconds / 1000).ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// The connection issue a cause becomes. Summary and action are English here because every issue carries
    /// English copy for the report; the panel and the phone show the localized twin, keyed on the code. Keep the
    /// three pairs below word-for-word identical to their <c>couchcoop_connection_error_seat_*</c> catalog
    /// entries, so a report and the panel above it never read as two different diagnoses.
    /// </summary>
    internal static ConnectionIssue IssueFor(SeatReadinessCause cause, string detail) => cause switch
    {
        // "Close whatever is using that port", NOT "restart Slay the Spire 2". Seat ports are derived from the
        // CONSTANT HostPort (HeadlessClientManager.SlotToPort, :79 and :177), never from the browser port this
        // host actually walked to — so on a machine running two copies of the game the port is very often held
        // by the OTHER instance's seats, and the old sentence sent the operator to restart the one instance
        // that was innocent. The port itself is already named in the detail under this line, and so is the
        // owner when the host found one before spawning, which is why the action can point at "that port"
        // rather than guess at a program.
        SeatReadinessCause.PortConflict => new(
            PortTakenCode,
            "Another program on this computer is using this player's port.",
            "Close whatever is using that port on the host computer, including another copy of Slay the Spire 2, "
                + "then try again.",
            detail),
        SeatReadinessCause.HostLocalBlock => new(
            PortBlockedCode,
            "This computer is blocking the port this player's game is serving on.",
            "Allow Slay the Spire 2 through this computer's firewall or security software, then try again.",
            detail),
        // The action names THIS COMPUTER'S firewall before the router, and that order is a measurement rather
        // than a guess: a host-side block is invisible to every check that reaches this verdict (see
        // NetworkPathCause's remarks), so it arrives here indistinguishable from a router problem — and it is
        // the likeliest of the two on Windows, where most hosts are. Still one sentence in fourteen languages;
        // the per-OS settings paths live in the English detail under it, not here.
        SeatReadinessCause.NetworkPath => new(
            NetworkPathCode,
            "This player's game is running, but their device never reached it.",
            "Allow Slay the Spire 2 through this computer's firewall and security software, check the device is "
                + "on this computer's network and not a guest one, then scan the code again.",
            detail),
        _ => new(
            StillStartingCode,
            "The game did not join the host before the connection deadline.",
            "Retry after the host finishes loading. If this repeats, copy the report and check that game and mod "
                + "versions match.",
            detail),
    };
}
