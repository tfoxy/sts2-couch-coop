using System.Net;
using System.Net.Sockets;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// The seat-port truth round: a seat's browser port is either genuinely free before we spawn into it, or the
/// join says which of four things is wrong — instead of burning 75 seconds and blaming the seat's listener.
/// </summary>
/// <remarks>
/// The measured defect these pin (Sep-15 2026, real game + real phone): anything already holding
/// <c>SlotToPort(slot)</c> made the spawned seat port-WALK, while the host kept probing — and handing the browser
/// — the computed port. The join died at the deadline with
/// <c>child HTTP listener: not responding</c>, and a blocked network path between phone and seat produced the
/// byte-identical text. Opposite fixes, identical message.
/// </remarks>
internal static class SeatPortTruthTests
{
    public static async Task RunAsync()
    {
        await ARealBlackholeListenerIsDetectedAsAnOwner();
        await AFreePortSurveysAsFree();
        await ANewPlayerSkipsASlotWhoseBrowserPortIsTaken();
        await ANewPlayerStillJoinsWhenTheFirstTwoSeatPortsAreTaken();
        await APinnedSeatFailsImmediatelyInsteadOfSpawning();
        await APinnedSeatFailureKeepsTheReconnectClaim();
        ASeatMayNotWalkOffItsAssignedPort();
        AHostStillWalks();
        TheSeatsOwnRefusalBecomesThePortTakenIssue();
        TheFourCausesReadDifferently();
        TheTwoFirewallRulesAreToldApartByTheProbe();
        AWedgedListenerIsNotAFirewall();
        await TheRealProbeMeasuresTheWedgedCaseItself();
        await ARefusedConnectIsToldApartFromADroppedOne();
        AnUnreportedPortIsNeverADisagreement();
        TheProbeFailureReasonSurvivesIntoTheMessage();
        EveryNewIssueCodeHasLocalizedCopyInAllFourteenCatalogs();
        AReportedBrowserPortIsValidatedOnTheHeartbeat();
        Console.WriteLine("SeatPortTruthTests: ok");
    }

    // ---- 1. the pre-spawn check, against a REAL squatter ------------------------------------------------------
    //
    // A bind test alone would not do: under SO_REUSEADDR a bind to 0.0.0.0:P can succeed while a listener on
    // 127.0.0.1:P still owns every loopback connection — which is exactly the traffic the host's readiness probe
    // and a redirected browser send. So the probe is asserted against a listener that accepts nothing, on
    // loopback, which is the shape of the orphaned seat that causes this in the field.

    private static async Task ARealBlackholeListenerIsDetectedAsAnOwner()
    {
        using var blackhole = new Blackhole();
        var owner = await SeatPortAvailability.DescribeOwnerAsync(
            blackhole.Port, IPAddress.Any, SeatPortAvailability.ProbeTimeout, CancellationToken.None);
        Assert(owner is not null, "a live loopback listener is detected as an owner of the port");
        Assert(owner!.Contains(blackhole.Port.ToString(), StringComparison.Ordinal),
            "the owner description names the port, because it is quoted into the player-facing detail");
    }

    /// <summary>
    /// The raw connect's three answers, against real sockets. Only the dropped one may ever become a
    /// host-local block, so the primitive underneath that claim is asserted directly rather than inferred.
    /// </summary>
    private static async Task ARefusedConnectIsToldApartFromADroppedOne()
    {
        using var blackhole = new Blackhole();
        var accepted = await SeatPortAvailability.ProbeLoopbackAsync(
            blackhole.Port, SeatPortAvailability.ProbeTimeout, CancellationToken.None);
        Assert(accepted.Reachability == SeatPortReachability.Accepted,
            "a live listener accepts the handshake even when it never reads the request");

        int free;
        using (var released = new Blackhole()) free = released.Port;
        var refused = await SeatPortAvailability.ProbeLoopbackAsync(
            free, SeatPortAvailability.ProbeTimeout, CancellationToken.None);
        Assert(refused.Reachability == SeatPortReachability.ConnectionRefused,
            "an empty port is REFUSED — which is 'nothing is listening yet', not 'this machine is blocking it'");
        Assert(refused.Reachability != SeatPortReachability.Unreachable,
            "…and must never be reported as unreachable, because that is the one answer that accuses a firewall");
    }

    private static async Task AFreePortSurveysAsFree()
    {
        int port;
        using (var blackhole = new Blackhole()) port = blackhole.Port; // bound, then released
        var owner = await SeatPortAvailability.DescribeOwnerAsync(
            port, IPAddress.Any, SeatPortAvailability.ProbeTimeout, CancellationToken.None);
        Assert(owner is null, "a port nothing is listening on surveys as free");
    }

    // ---- 2. a brand-new player routes around an occupied port -------------------------------------------------

    private static async Task ANewPlayerSkipsASlotWhoseBrowserPortIsTaken()
    {
        var harness = new SeatHarness(occupied: [HeadlessClientManager.SlotToPort(2)]);
        var port = await harness.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default);
        Assert(port == HeadlessClientManager.SlotToPort(3),
            "a new player whose first slot's port is taken simply joins on the next slot");
        Assert(harness.Launched.SequenceEqual([3]), "…and exactly one seat is launched, on that slot");
    }

    private static async Task ANewPlayerStillJoinsWhenTheFirstTwoSeatPortsAreTaken()
    {
        var harness = new SeatHarness(occupied:
            [HeadlessClientManager.SlotToPort(2), HeadlessClientManager.SlotToPort(3)]);
        Assert(await harness.Manager.EnsureHeadlessAsync(Guid.NewGuid(), "Ann", default)
                == HeadlessClientManager.SlotToPort(4),
            "the skip walks past every occupied seat port, not just the first");
    }

    // ---- 3. a PINNED seat cannot move, so it fails fast instead of spawning -----------------------------------

    private static async Task APinnedSeatFailsImmediatelyInsteadOfSpawning()
    {
        var harness = new SeatHarness(occupied: [HeadlessClientManager.SlotToPort(3)]);
        var session = BeginAttempt();
        try
        {
            var port = await harness.Manager.EnsureHeadlessAsync(session, "Bea", default, targetNetId: 1003);
            Assert(port is null, "a netId-bound rejoin onto an occupied port is refused rather than spawned");
            Assert(harness.Launched.Count == 0, "…and no seat process is started for it");

            var row = ConnectionRegistry.Shared.Snapshot().Rows.Single(entry => entry.Id == session);
            Assert(row.Issue?.Code == SeatReadinessVerdict.PortTakenCode,
                "the refusal is the seat-port-taken issue, not a generic launch failure");
            Assert(row.Issue!.Detail!.Contains("13367", StringComparison.Ordinal),
                "the technical detail names the port a human has to go and free");
            Assert(row.Issue.Action.Contains("Restart Slay the Spire 2", StringComparison.Ordinal),
                "…and the next action is the one that actually frees an orphaned seat's port");
        }
        finally { ConnectionRegistry.Shared.Clear(); }
    }

    // The unwind has to match the launch-refused path exactly: a rejoin's claim IS that player's identity in the
    // host's run, so dropping it here would cost them their seat over a port conflict they can fix in seconds.
    private static async Task APinnedSeatFailureKeepsTheReconnectClaim()
    {
        var harness = new SeatHarness();
        var first = BeginAttempt();
        try
        {
            await harness.Manager.EnsureHeadlessAsync(first, "Ann", default);
            harness.Manager.Release(first); // keeps the claim on slot 2, kills the process

            harness.Occupied.Add(HeadlessClientManager.SlotToPort(2));
            var blocked = BeginAttempt();
            Assert(await harness.Manager.EnsureHeadlessAsync(blocked, "Ann", default) is null,
                "a returning name whose reserved slot's port is taken is refused, not moved to another netId");
            Assert(harness.Manager.HasClaimForNetId(HeadlessClientManager.SlotToNetId(2)),
                "…and keeps its claim, so the same player retries onto the same netId once the port is free");

            harness.Occupied.Clear();
            Assert(await harness.Manager.EnsureHeadlessAsync(BeginAttempt(), "Ann", default)
                    == HeadlessClientManager.SlotToPort(2),
                "freeing the port lets the same player back onto the seat they held");
        }
        finally { ConnectionRegistry.Shared.Clear(); }
    }

    // ---- 4. the seat's own no-walk guard ----------------------------------------------------------------------

    private static void ASeatMayNotWalkOffItsAssignedPort()
    {
        Assert(HeadlessSeatPortGuard.MustBindExactly(isSeat: true, preferredPort: 13357),
            "a seat must bind the port its host assigned it");
        using var blackhole = new Blackhole();
        try
        {
            using var walked = HeadlessSeatPortGuard.Bind(
                IPAddress.Loopback, blackhole.Port, isSeat: true, CancellationToken.None);
            Assert(false, "a seat whose assigned port is taken must not bind anything at all");
        }
        catch (SeatPortUnavailableException failure)
        {
            Assert(failure.PreferredPort == blackhole.Port, "the refusal carries the port that was assigned");
            var detail = HeadlessSeatPortGuard.Detail(failure.PreferredPort, failure.BindAddress, failure.SocketError);
            Assert(detail.Contains(blackhole.Port.ToString(), StringComparison.Ordinal)
                    && detail.Contains(failure.SocketError, StringComparison.Ordinal),
                "the report detail names the port and the socket error, which is what tells a conflict from a permission");
        }
    }

    // The other half of the same rule, and the one that is load-bearing for everything else on this machine:
    // several game instances run side by side, and scripts/lib/instance-port.mjs finds each one by the port it
    // walked to. Gating on the seat identity — not on a global switch — is what keeps that working.
    private static void AHostStillWalks()
    {
        Assert(!HeadlessSeatPortGuard.MustBindExactly(isSeat: false, preferredPort: 13337),
            "a host keeps its port walk");
        using var blackhole = new Blackhole();
        using var walked = HeadlessSeatPortGuard.Bind(
            IPAddress.Loopback, blackhole.Port, isSeat: false, CancellationToken.None);
        Assert(((IPEndPoint)walked.LocalEndpoint).Port > blackhole.Port,
            "a host whose preferred port is taken walks upward to a free one");
        walked.Stop();
    }

    private static void TheSeatsOwnRefusalBecomesThePortTakenIssue()
    {
        // The seat reports through the same authenticated channel the build guard uses, so the host has to map
        // its code rather than letting it fall into the generic native-rejection bucket, whose next action
        // ("check that game and mod versions match") is advice nobody can act on for a port conflict.
        var issue = SeatReadinessVerdict.IssueFor(
            SeatReadinessCause.PortConflict,
            HeadlessSeatPortGuard.Detail(13357, IPAddress.Any, "AddressAlreadyInUse"));
        Assert(issue.Code == SeatReadinessVerdict.PortTakenCode,
            "a seat that could not bind its assigned port is reported as a port conflict");
        Assert(issue.Detail!.Contains("13357", StringComparison.Ordinal), "…naming the port");
        Assert(!issue.Action.Contains("versions match", StringComparison.Ordinal),
            "…and never with the version advice the native-rejection bucket would have given it");
    }

    // ---- 5. four causes, four messages ------------------------------------------------------------------------

    private static SeatReadinessFacts Facts(
        int reportedPort = 0,
        string? portOwner = null,
        bool member = true,
        string? phase = "Connecting",
        bool fresh = true,
        bool? listenerResponding = null,
        string? probeFailure = null,
        SeatPortReachability reachability = SeatPortReachability.NotProbed,
        int browsers = 0,
        // Every scenario in THIS file models a seat nothing ever reached from the network: the two firewall
        // legs, the wedged listener, the port conflict. The seat reporting an affirmative zero is that
        // situation, so it is the default here — never the "has not said" null, which would quietly make the
        // network-path assertions below pass for the wrong reason.
        long? viewerArrivals = 0)
        => new(
            ExpectedPort: 13357,
            ReportedPort: reportedPort,
            PortOwner: portOwner,
            HostMember: member,
            NativePhase: phase,
            HeartbeatFresh: fresh,
            ListenerResponding: listenerResponding,
            ProbeFailure: probeFailure,
            TcpReachability: reachability,
            ConnectedBrowserCount: browsers,
            SeatViewerArrivals: viewerArrivals,
            ElapsedMs: 23_000,
            DeadlineMs: 75_000);

    private static void TheFourCausesReadDifferently()
    {
        // Port conflict: the seat is serving somewhere other than where the browser is being sent.
        var conflict = SeatReadinessVerdict.Describe(Facts(reportedPort: 13358, listenerResponding: true));
        Assert(conflict.Cause == SeatReadinessCause.PortConflict, "a reported port that is not the assigned one is a conflict");
        Assert(conflict.Detail.StartsWith("Another program on this computer is using port 13357.", StringComparison.Ordinal),
            "the port-conflict message names the port");
        Assert(conflict.Detail.Contains("bound port 13358", StringComparison.Ordinal),
            "…and says where the seat actually went");

        // Host-local block: the seat says it is listening where we expect, THIS computer cannot reach it over
        // HTTP, and a raw connect could not complete either.
        var blocked = SeatReadinessVerdict.Describe(Facts(
            reportedPort: 13357,
            listenerResponding: false,
            probeFailure: "TaskCanceledException after 803 ms; TCP connect did not complete within 250 ms",
            reachability: SeatPortReachability.Unreachable));
        Assert(blocked.Cause == SeatReadinessCause.HostLocalBlock,
            "a seat listening on the expected port that the host cannot reach is a local block");
        Assert(blocked.Detail.Contains("something on this computer is blocking it locally", StringComparison.Ordinal),
            "the host-local message says the block is on this computer");

        // Network path: everything on the host is fine and the device never arrived.
        var network = SeatReadinessVerdict.Describe(Facts(reportedPort: 13357, listenerResponding: true));
        Assert(network.Cause == SeatReadinessCause.NetworkPath,
            "a reachable seat with no viewer attached is a network-path problem");
        Assert(network.Detail.Contains("the device never reached it", StringComparison.Ordinal),
            "the network-path message blames the path");
        Assert(!network.Detail.Contains("listener", StringComparison.OrdinalIgnoreCase),
            "…and never accuses the seat's listener, which is the sentence this round exists to delete");

        // Still starting: honest, and not a failure.
        var starting = SeatReadinessVerdict.Describe(Facts(reportedPort: 0, phase: null, fresh: false));
        Assert(starting.Cause == SeatReadinessCause.StillStarting, "a seat that has not reported yet is simply starting");
        Assert(starting.Detail.Contains("still starting", StringComparison.Ordinal)
                && starting.Detail.Contains("waited 23 of 75 seconds", StringComparison.Ordinal),
            "the still-starting message says what it is doing and how long it has been doing it");

        // THE regression: the two causes that used to print byte-identical text.
        Assert(conflict.Detail != network.Detail, "port conflict and network path no longer share one message");
        Assert(blocked.Detail != network.Detail, "nor do a host-local block and a network path");
        var codes = new[] { conflict, blocked, network, starting }.Select(v => v.Issue.Code).ToArray();
        Assert(codes.Distinct().Count() == 4, "each cause carries its own issue code, so each gets its own localized copy");
        var summaries = new[] { conflict, blocked, network, starting }.Select(v => v.Issue.Summary).ToArray();
        Assert(summaries.Distinct().Count() == 4, "…and its own friendly summary");
    }

    /// <summary>
    /// The two iptables rules the live round runs, told apart by exactly one fact.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Both legs leave a seat bound and healthy on 13357 with a fresh heartbeat and zero viewers attached, so
    /// everything EXCEPT the host's own loopback probe is identical between them. An UNSCOPED
    /// <c>iptables -I INPUT -p tcp --dport 13347:13417 -j DROP</c> is inserted above any <c>-i lo ACCEPT</c> and
    /// therefore drops the host's own probe — which surfaces as an HttpClient timeout, no socket error, at the
    /// full 800 ms. A PHONE-SCOPED <c>-s &lt;phone&gt;</c> rule leaves that probe alone and it answers.
    /// </para>
    /// <para>
    /// The heartbeat itself survives both, which is what makes this decidable at all: it is posted to the HOST's
    /// browser port (13337), outside the blocked range, so the seat can still say it is alive and where it bound
    /// while its own port is unreachable.
    /// </para>
    /// </remarks>
    private static void TheTwoFirewallRulesAreToldApartByTheProbe()
    {
        var unscoped = SeatReadinessVerdict.Describe(Facts(
            reportedPort: 13357,
            listenerResponding: false,
            probeFailure: "TaskCanceledException after 801 ms; TCP connect did not complete within 250 ms",
            reachability: SeatPortReachability.Unreachable));
        var phoneScoped = SeatReadinessVerdict.Describe(Facts(
            reportedPort: 13357,
            listenerResponding: true));

        Assert(unscoped.Cause == SeatReadinessCause.HostLocalBlock,
            "the unscoped rule, which eats the host's own loopback probe, reads as a host-local block");
        Assert(phoneScoped.Cause == SeatReadinessCause.NetworkPath,
            "the phone-scoped rule, which leaves the host's probe alone, reads as a blocked network path");
        Assert(unscoped.Detail != phoneScoped.Detail,
            "…and the two no longer print the byte-identical text that was measured Sep-15 2026");
        Assert(unscoped.Issue.Code != phoneScoped.Issue.Code
                && unscoped.Issue.Action != phoneScoped.Issue.Action,
            "they carry different codes and different next actions, because the fixes are opposite");

        // The ONE fact that moved. Anything else differing would mean the split rests on something the live legs
        // do not actually control.
        var unscopedFacts = Facts(
            reportedPort: 13357,
            listenerResponding: false,
            probeFailure: "TaskCanceledException after 801 ms; TCP connect did not complete within 250 ms",
            reachability: SeatPortReachability.Unreachable);
        var scopedFacts = unscopedFacts with
        {
            ListenerResponding = true,
            ProbeFailure = null,
            TcpReachability = SeatPortReachability.NotProbed,
        };
        Assert(SeatReadinessVerdict.Describe(unscopedFacts).Cause == SeatReadinessCause.HostLocalBlock
                && SeatReadinessVerdict.Describe(scopedFacts).Cause == SeatReadinessCause.NetworkPath,
            "flipping only the probe result flips only the verdict — the split rests on the probe, nothing else");
    }

    /// <summary>
    /// The two states a failed HTTP probe fits, told apart by the raw connect that follows it.
    /// </summary>
    /// <remarks>
    /// Identical inputs on every other axis — a seat that reports it bound the expected port, a fresh heartbeat,
    /// and an HTTP probe that timed out at ~800 ms. A DROPPED packet never completes the handshake; a listener
    /// that is bound but WEDGED completes it out of the kernel backlog and fails only the read. Without the
    /// second probe the wedged seat told the player to go and edit a firewall that was never involved, which is
    /// the same wrong-component mistake this round exists to delete.
    /// </remarks>
    private static void AWedgedListenerIsNotAFirewall()
    {
        var dropped = SeatReadinessVerdict.Describe(Facts(
            reportedPort: 13357,
            listenerResponding: false,
            probeFailure: "TaskCanceledException after 806 ms; TCP connect did not complete within 250 ms",
            reachability: SeatPortReachability.Unreachable));
        var wedged = SeatReadinessVerdict.Describe(Facts(
            reportedPort: 13357,
            listenerResponding: false,
            probeFailure: "TaskCanceledException after 806 ms; TCP connect succeeded",
            reachability: SeatPortReachability.Accepted));

        Assert(dropped.Cause == SeatReadinessCause.HostLocalBlock,
            "a connect that could not complete is this computer blocking its own packet");
        Assert(wedged.Cause == SeatReadinessCause.StillStarting,
            "a connect that SUCCEEDED means the listener is there — the seat is not serving yet, and no firewall "
            + "is implicated");
        Assert(!wedged.Detail.Contains("firewall", StringComparison.OrdinalIgnoreCase)
                && !wedged.Detail.Contains("blocking", StringComparison.OrdinalIgnoreCase),
            "…so the wedged message must not send anyone to their firewall settings");
        Assert(dropped.Issue.Code == SeatReadinessVerdict.PortBlockedCode
                && wedged.Issue.Code == SeatReadinessVerdict.StillStartingCode,
            "and the two ride different issue codes into the deadline");

        // A refusal is the third answer and stays what it always was: nothing is listening THERE yet.
        var refused = SeatReadinessVerdict.Describe(Facts(
            reportedPort: 13357,
            listenerResponding: false,
            probeFailure: "HttpRequestException/ConnectionRefused after 2 ms; TCP connect refused",
            reachability: SeatPortReachability.ConnectionRefused));
        Assert(refused.Cause == SeatReadinessCause.StillStarting,
            "a refused connect is a seat that has not finished starting, never a block");

        // And an unmeasured reachability may not produce a block either: no verdict rests on a signal nobody took.
        Assert(SeatReadinessVerdict.Describe(Facts(
                reportedPort: 13357,
                listenerResponding: false,
                probeFailure: "TaskCanceledException after 806 ms")).Cause == SeatReadinessCause.StillStarting,
            "an HTTP failure with no reachability measurement cannot be called a host-local block");

        // The evidence tail is what lets a report be re-read, so it has to carry the distinguishing clause.
        Assert(dropped.Detail.Contains("TCP connect did not complete within 250 ms", StringComparison.Ordinal)
                && wedged.Detail.Contains("TCP connect succeeded", StringComparison.Ordinal),
            "both messages print WHICH of the two the probe found");
    }

    /// <summary>
    /// The same split, end to end, through the REAL HTTP probe — against a real listener that accepts TCP and
    /// never speaks HTTP, which is exactly the wedged shape.
    /// </summary>
    private static async Task TheRealProbeMeasuresTheWedgedCaseItself()
    {
        using var blackhole = new Blackhole();
        var wedged = await HeadlessClientManager.DefaultHttpReadinessAsync(blackhole.Port, CancellationToken.None);
        Assert(!wedged.Responding, "a listener that never answers HTTP is not responding");
        Assert(wedged.Reachability == SeatPortReachability.Accepted,
            "…but the follow-up raw connect completes, because the kernel accepted it from the backlog");
        Assert(wedged.Failure!.Contains("TCP connect succeeded", StringComparison.Ordinal),
            "and the recorded reason carries that, so the report says which state it was");

        int free;
        using (var released = new Blackhole()) free = released.Port;
        var nothing = await HeadlessClientManager.DefaultHttpReadinessAsync(free, CancellationToken.None);
        Assert(!nothing.Responding && nothing.Reachability == SeatPortReachability.ConnectionRefused,
            "a port with nothing on it is refused, not unreachable — that is a seat still starting");

        // A HEALTHY listener must not pay for any of this. The constraint is that the follow-up connect runs on
        // the failure path only, so a probe that answered reports no reachability measurement at all.
        using var healthy = new MinimalHttpResponder();
        var responding = await HeadlessClientManager.DefaultHttpReadinessAsync(healthy.Port, CancellationToken.None);
        Assert(responding.Responding && responding.Failure is null,
            "a listener that answers HTTP is responding, with nothing to explain");
        Assert(responding.Reachability == SeatPortReachability.NotProbed,
            "…and the extra TCP connect was never made, because a healthy join must not pay for it");

        // Cancellation is not delayed by the extra probe: an already-cancelled token comes straight back out.
        var cancelled = false;
        try
        {
            await HeadlessClientManager.DefaultHttpReadinessAsync(blackhole.Port, new CancellationToken(true));
        }
        catch (OperationCanceledException)
        {
            cancelled = true;
        }

        Assert(cancelled, "a cancelled attempt propagates instead of waiting out a second probe");
    }

    // A seat that has not yet said which port it bound reports 0. Reading that as a disagreement would fail every
    // join in its first seconds, and would fail every heartbeat sent before the field existed.
    private static void AnUnreportedPortIsNeverADisagreement()
    {
        foreach (var responding in new bool?[] { null, true, false })
        {
            var verdict = SeatReadinessVerdict.Describe(Facts(reportedPort: 0, listenerResponding: responding));
            Assert(verdict.Cause == SeatReadinessCause.StillStarting,
                $"an unreported port is 'still starting', not a conflict (probe: {responding?.ToString() ?? "unprobed"})");
        }

        Assert(SeatReadinessVerdict.Describe(Facts(reportedPort: 0)).Detail
                .Contains("port this player's game reports it bound: not reported", StringComparison.Ordinal),
            "the evidence line says 'not reported' rather than printing a zero");
    }

    // The currently-missing fact the live round depends on: WHY the probe failed. Without it "not responding" is
    // one unexplained signal, and no verdict may rest on one of those.
    private static void TheProbeFailureReasonSurvivesIntoTheMessage()
    {
        var detail = SeatReadinessVerdict.Describe(Facts(
            reportedPort: 13357,
            listenerResponding: false,
            probeFailure: "HttpRequestException/ConnectionRefused after 3 ms")).Detail;
        Assert(detail.Contains("HttpRequestException/ConnectionRefused after 3 ms", StringComparison.Ordinal),
            "the probe's exception type, socket error and elapsed time reach the report verbatim");

        var missing = SeatReadinessVerdict.Describe(Facts(reportedPort: 13357, listenerResponding: false)).Detail;
        Assert(missing.Contains("no failure detail was captured", StringComparison.Ordinal),
            "a probe that recorded no reason says so, rather than reading as though there were none");
    }

    // ---- 6. the copy exists in every language ------------------------------------------------------------------

    private static void EveryNewIssueCodeHasLocalizedCopyInAllFourteenCatalogs()
    {
        string[] keys =
        [
            "couchcoop_connection_error_seat_port_summary",
            "couchcoop_connection_error_seat_port_action",
            "couchcoop_connection_error_seat_port_blocked_summary",
            "couchcoop_connection_error_seat_port_blocked_action",
            "couchcoop_connection_error_seat_network_summary",
            "couchcoop_connection_error_seat_network_action",
        ];
        Assert(CouchCoopLocalization.SupportedLanguages.Count == 14, "there are still fourteen catalogs to fill");
        foreach (var language in CouchCoopLocalization.SupportedLanguages)
        {
            var catalog = CouchCoopLocalization.CatalogFor(language);
            foreach (var key in keys)
            {
                Assert(catalog.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value),
                    $"{key} is present and nonblank in {language}");
            }
        }

        // And the English twin the report carries is word-for-word the catalog's, so a copyable report and the
        // panel above it never read as two different diagnoses.
        var english = CouchCoopLocalization.CatalogFor("eng");
        foreach (var (cause, key) in new[]
        {
            (SeatReadinessCause.PortConflict, "seat_port"),
            (SeatReadinessCause.HostLocalBlock, "seat_port_blocked"),
            (SeatReadinessCause.NetworkPath, "seat_network"),
        })
        {
            var issue = SeatReadinessVerdict.IssueFor(cause, "detail");
            Assert(english[$"couchcoop_connection_error_{key}_summary"] == issue.Summary,
                $"{cause} summary matches its catalog entry");
            Assert(english[$"couchcoop_connection_error_{key}_action"] == issue.Action,
                $"{cause} action matches its catalog entry");
        }
    }

    // ---- 7. the wire field the whole backstop rests on ---------------------------------------------------------

    private static void AReportedBrowserPortIsValidatedOnTheHeartbeat()
    {
        var control = new HeadlessConnectionControl();
        control.Register(9, 1, Guid.NewGuid(), "port-token");
        Assert(control.Observe("port-token", 1, new HeadlessConnectionStatus(1, "Connecting", null, null, 0, 13357)).Accepted,
            "a seat may report the browser port it bound");
        Assert(control.Snapshot(9, 1)?.Status?.BrowserPort == 13357, "…and the host keeps it");
        Assert(control.Observe("port-token", 1, new HeadlessConnectionStatus(2, "Connecting", null, null, 0)).Accepted,
            "a heartbeat with no port is still valid — 0 means 'not bound yet'");
        Assert(!control.Observe("port-token", 1, new HeadlessConnectionStatus(3, "Connecting", null, null, 0, -1)).Accepted,
            "a negative port is refused, because the host would otherwise act on it");
        Assert(!control.Observe("port-token", 1, new HeadlessConnectionStatus(4, "Connecting", null, null, 0, 70000)).Accepted,
            "…as is one outside the port space");
    }

    // ---- harness ----------------------------------------------------------------------------------------------

    /// <summary>
    /// A listener that accepts TCP and answers one minimal HTTP response: a seat whose browser server is up.
    /// </summary>
    private sealed class MinimalHttpResponder : IDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _stop = new();

        public MinimalHttpResponder()
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _ = Task.Run(ServeAsync);
        }

        public int Port { get; }

        private async Task ServeAsync()
        {
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    using var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                    await using var stream = client.GetStream();
                    // Enough of a request to get past the client's own framing; the body is irrelevant here.
                    var scratch = new byte[1024];
                    await stream.ReadAsync(scratch, _stop.Token);
                    var response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"u8.ToArray();
                    await stream.WriteAsync(response, _stop.Token);
                }
            }
            catch
            {
                // Torn down with the test.
            }
        }

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Stop();
            _stop.Dispose();
        }
    }

    /// <summary>A listener that accepts nothing: the shape an orphaned seat leaves behind on a seat port.</summary>
    private sealed class Blackhole : IDisposable
    {
        private readonly TcpListener _listener;

        public Blackhole()
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        }

        public int Port { get; }

        public void Dispose() => _listener.Stop();
    }

    private sealed class SeatHarness
    {
        public readonly List<int> Launched = [];
        public readonly HashSet<int> Occupied;
        public readonly HeadlessClientManager Manager;

        public SeatHarness(IEnumerable<int>? occupied = null)
        {
            Occupied = [.. occupied ?? []];
            Manager = new HeadlessClientManager(
                launcher: slot => { Launched.Add(slot); return new FakeProcess(slot); },
                readinessProbe: (_, _) => Task.FromResult(true),
                maxSeatsProbe: () => 3,
                seatPortProbe: (port, _) => Task.FromResult(
                    Occupied.Contains(port) ? $"a test squatter holds 127.0.0.1:{port}" : null));
        }
    }

    private sealed class FakeProcess(int slot) : IHeadlessProcess
    {
        public int Id => 20000 + slot;
        public bool HasExited { get; private set; }
        public int ExitCode => 0;
        public bool RequestGracefulStop() => false;
        public void Kill() => HasExited = true;
        public void Dispose() { }
    }

    private static Guid BeginAttempt()
    {
        var id = Guid.NewGuid();
        ConnectionRegistry.Shared.Connected(id, null);
        ConnectionRegistry.Shared.BeginAttempt(id);
        return id;
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"SeatPortTruthTests failed: {label}.");
    }
}
