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
/// <param name="ElapsedMs">How long this attempt has been waiting.</param>
/// <param name="DeadlineMs">The wait it is measured against.</param>
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
    long ElapsedMs,
    long DeadlineMs);

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
/// </remarks>
internal static class SeatReadinessVerdict
{
    /// <summary>
    /// The connection issue a seat whose assigned browser port has a foreign owner is reported as — whether the
    /// host found that owner before spawning, or the seat itself reported a different bound port afterwards.
    /// Public-by-const because the report copy and the host panel's issue mapping both key on the literal.
    /// </summary>
    internal const string PortTakenCode = "seat-port-taken";

    /// <summary>The seat is listening where it should be and THIS computer cannot reach it.</summary>
    internal const string PortBlockedCode = "seat-port-blocked";

    /// <summary>The seat is reachable from the host; the viewer's device never arrived.</summary>
    internal const string NetworkPathCode = "seat-network-path";

    /// <summary>Nothing was wrong; it was simply not finished. The pre-existing code, unchanged.</summary>
    internal const string StillStartingCode = "startup-timeout";

    public static SeatReadinessVerdictResult Describe(SeatReadinessFacts facts)
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
        var boundWhereExpected = facts.HeartbeatFresh && facts.ReportedPort == facts.ExpectedPort;

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

        // 3. It is listening there, the host reached it, the lobby has it — and no viewer ever arrived. The
        //    listener is fine; the path to it is not. Membership is required so a seat whose lobby join is
        //    flickering is not mislabelled as a network problem.
        if (boundWhereExpected
            && facts.HostMember
            && facts.ListenerResponding == true
            && facts.ConnectedBrowserCount == 0)
        {
            return SeatReadinessCause.NetworkPath;
        }

        return SeatReadinessCause.StillStarting;
    }

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
                return "This player's game is running and answering on the host, but the device never reached it. "
                    + $"The path from the phone to port {port} is blocked (firewall, guest/AP isolation, or the "
                    + "wrong address).";

            default:
                return "This player's game is still starting, and nothing has failed yet.";
        }
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
        SeatReadinessCause.PortConflict => new(
            PortTakenCode,
            "Another program on this computer is using this player's port.",
            "Restart Slay the Spire 2 on the host computer to free the port, then try again.",
            detail),
        SeatReadinessCause.HostLocalBlock => new(
            PortBlockedCode,
            "This computer is blocking the port this player's game is serving on.",
            "Allow Slay the Spire 2 through this computer's firewall or security software, then try again.",
            detail),
        SeatReadinessCause.NetworkPath => new(
            NetworkPathCode,
            "This player's game is running, but their device never reached it.",
            "Put the device on the same Wi-Fi as this computer and turn off guest network or client isolation on "
                + "the router, then scan the code again.",
            detail),
        _ => new(
            StillStartingCode,
            "The game did not join the host before the connection deadline.",
            "Retry after the host finishes loading. If this repeats, copy the report and check that game and mod "
                + "versions match.",
            detail),
    };
}
