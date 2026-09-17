using System.Net;
using System.Net.Http.Headers;
using System.Text;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// The seat's own arrival evidence, carried to the host: what turns the <c>seat-network-path</c> verdict from an
/// inference into an observation.
/// </summary>
/// <remarks>
/// <para>
/// WHAT THIS PINS. The verdict used to reach "the device never reached this seat" from host-side facts alone,
/// and its last clause was <c>ConnectedChildBrowserCount == 0</c> — which says only that no browser FINISHED
/// connecting. That is equally true of a blocked path and of a player who has not tapped the link yet, and the
/// message it produced told the second player to go and reconfigure their router. Only the seat can tell the two
/// apart: a request from a real device lands on the SEAT's listener, in another process, and the host never sees
/// it. So the seat reports its own viewer-arrival count on the authenticated heartbeat, and the verdict requires
/// an affirmative zero before it will blame the network.
/// </para>
/// <para>
/// The two properties the count must keep, both established at the source in
/// <see cref="ConnectionArrivalLog"/> and both asserted here end to end: the host's own loopback readiness probe
/// of the seat is NOT a device, and an arrival whose remote address could not be read counts AS one. The number
/// can only ever be too generous, never too accusing.
/// </para>
/// </remarks>
internal static class SeatArrivalEvidenceTests
{
    public static async Task RunAsync()
    {
        TheNetworkPathVerdictRestsOnTheSeatsOwnEvidence();
        AReachedSeatIsNotABlockedPath();
        TheEvidenceTailNamesWhatTheSeatSaw();
        await TheCountSurvivesTheAuthenticatedHeartbeat();
        TheReporterReadsTheViewerCounterNotTheTotal();
        await TheSeatsOwnReporterCarriesItToTheHost();
        await TheSeatSaysHelloBeforeItHasARuntime();
        Console.WriteLine("SeatArrivalEvidenceTests: ok");
    }

    /// <summary>
    /// A seat that is up, reachable from the host, in the lobby, with no browser attached AND nothing ever
    /// arrived from outside this machine. All four were already required; the fifth is the new one.
    /// </summary>
    private static SeatReadinessFacts Blocked(long? viewerArrivals = 0)
        => new(
            ExpectedPort: 13357,
            ReportedPort: 13357,
            PortOwner: null,
            HostMember: true,
            NativePhase: "Connecting",
            HeartbeatFresh: true,
            ListenerResponding: true,
            ProbeFailure: null,
            TcpReachability: SeatPortReachability.NotProbed,
            ConnectedBrowserCount: 0,
            SeatViewerArrivals: viewerArrivals,
            ElapsedMs: 23_000,
            DeadlineMs: 75_000);

    private static void TheNetworkPathVerdictRestsOnTheSeatsOwnEvidence()
    {
        var blocked = SeatReadinessVerdict.Describe(Blocked());
        Assert(blocked.Cause == SeatReadinessCause.NetworkPath,
            "a listening, host-reachable seat with no browser and NO arrival is a blocked network path");
        Assert(blocked.Issue.Code == SeatReadinessVerdict.NetworkPathCode, "…and rides the network-path issue code");

        // The one fact that moved. Anything else differing would mean the split rests on something other than
        // the seat's own evidence.
        var reached = Blocked() with { SeatViewerArrivals = 1 };
        Assert(SeatReadinessVerdict.Describe(reached).Cause != SeatReadinessCause.NetworkPath,
            "the same seat that HAS been reached is not a blocked path — flipping only the arrival count flips "
            + "only the verdict");

        // An accusation aimed at the player's own network may not be reachable from a field that merely
        // defaulted. `null` is "the seat has not said", and it falls through.
        Assert(SeatReadinessVerdict.Describe(Blocked(viewerArrivals: null)).Cause == SeatReadinessCause.StillStarting,
            "a seat that has not reported its arrivals is still starting, never a blocked network path");

        foreach (var arrivals in new long[] { 1, 2, 17, 4_000 })
        {
            Assert(SeatReadinessVerdict.Describe(Blocked(arrivals)).Cause != SeatReadinessCause.NetworkPath,
                $"any arrival at all defeats the network-path verdict ({arrivals})");
        }

        // The host-side clauses still all matter: the arrival count relaxes this verdict, it does not replace
        // the four facts that were already required.
        foreach (var (name, facts) in new (string, SeatReadinessFacts)[]
        {
            ("the lobby does not have it", Blocked() with { HostMember = false }),
            ("a browser is already attached", Blocked() with { ConnectedBrowserCount = 1 }),
            ("the host's own probe has not run", Blocked() with { ListenerResponding = null }),
            ("the seat has not said where it bound", Blocked() with { ReportedPort = 0 }),
        })
        {
            Assert(SeatReadinessVerdict.Describe(facts).Cause != SeatReadinessCause.NetworkPath,
                $"zero arrivals alone is not a blocked path when {name}");
        }
    }

    /// <summary>
    /// The near miss — the seat WAS reached and no browser connection completed — and why it is not a fifth
    /// cause.
    /// </summary>
    /// <remarks>
    /// It is the normal state of every healthy join while the seat's page is loading (the first arrival is the
    /// SPA document; the browser is counted only at the WebSocket upgrade), the count is process-wide rather
    /// than per-visit so it cannot name THIS device, and no single fix sits behind it. What it must do is stop
    /// reading as a blocked path, and say what was observed.
    /// </remarks>
    private static void AReachedSeatIsNotABlockedPath()
    {
        var reached = SeatReadinessVerdict.Describe(Blocked(viewerArrivals: 3));
        Assert(reached.Cause == SeatReadinessCause.StillStarting,
            "a seat something has reached, with no browser connected, is still starting");
        Assert(reached.Issue.Code == SeatReadinessVerdict.StillStartingCode,
            "…on the pre-existing issue code, so this case needs no fifth cause and no new catalog copy");
        Assert(!reached.Detail.Contains("never reached", StringComparison.OrdinalIgnoreCase)
                && !reached.Detail.Contains("blocked", StringComparison.OrdinalIgnoreCase)
                && !reached.Detail.Contains("firewall", StringComparison.OrdinalIgnoreCase)
                && !reached.Detail.Contains("isolation", StringComparison.OrdinalIgnoreCase),
            "…and it accuses neither the path nor anybody's firewall");

        Assert(reached.Detail.Contains(
                "Something from outside this computer has already reached this player's game", StringComparison.Ordinal),
            "the still-starting message says what it saw, rather than only what it concluded");
        Assert(!reached.Detail.Contains("this device", StringComparison.OrdinalIgnoreCase)
                && !reached.Detail.Contains("the device", StringComparison.OrdinalIgnoreCase),
            "…and says SOMETHING, not 'this device': the count is process-wide and cannot name one");

        // Silent in every other still-starting state, which is most of a healthy 20-60 second spawn.
        var cold = Blocked(viewerArrivals: null) with { ReportedPort = 0, HeartbeatFresh = false, ListenerResponding = null };
        var coldDetail = SeatReadinessVerdict.Describe(cold).Detail;
        Assert(SeatReadinessVerdict.Describe(cold).Cause == SeatReadinessCause.StillStarting
                && !coldDetail.Contains("already reached", StringComparison.Ordinal),
            "a seat that is simply not up yet says nothing about arrivals it never had");
        var attached = SeatReadinessVerdict.Describe(Blocked(viewerArrivals: 3) with { ConnectedBrowserCount = 1 });
        Assert(!attached.Detail.Contains("already reached", StringComparison.Ordinal),
            "nor does a seat whose browser has finished connecting — there is nothing left to explain");
    }

    private static void TheEvidenceTailNamesWhatTheSeatSaw()
    {
        const string label = "requests to this player's game from outside this computer: ";
        Assert(SeatReadinessVerdict.Describe(Blocked()).Detail.Contains(label + "0", StringComparison.Ordinal),
            "the evidence tail prints the observed zero the network-path verdict rests on");
        Assert(SeatReadinessVerdict.Describe(Blocked(4)).Detail.Contains(label + "4", StringComparison.Ordinal),
            "…and the count when there is one");
        Assert(SeatReadinessVerdict.Describe(Blocked(null)).Detail.Contains(label + "not reported", StringComparison.Ordinal),
            "…and 'not reported' rather than a zero the seat never claimed");

        // Uniform across every cause: a report that names the wrong one can still be re-read from its facts.
        foreach (var (cause, facts) in new (SeatReadinessCause, SeatReadinessFacts)[]
        {
            (SeatReadinessCause.NetworkPath, Blocked()),
            (SeatReadinessCause.StillStarting, Blocked(2)),
            (SeatReadinessCause.PortConflict, Blocked() with { ReportedPort = 13358 }),
            (SeatReadinessCause.HostLocalBlock, Blocked() with
            {
                ListenerResponding = false,
                ProbeFailure = "TaskCanceledException after 804 ms; TCP connect did not complete within 250 ms",
                TcpReachability = SeatPortReachability.Unreachable,
            }),
        })
        {
            var verdict = SeatReadinessVerdict.Describe(facts);
            Assert(verdict.Cause == cause, $"{cause} is classified as itself");
            Assert(verdict.Detail.Contains(label, StringComparison.Ordinal),
                $"every message carries the arrival evidence, including {cause}");
        }

        // It is read as a pair with the browser count directly above it: "requests N, browsers 0" is a device
        // that arrived and did not finish; "requests 0, browsers 0" is a device that never arrived at all.
        var detail = SeatReadinessVerdict.Describe(Blocked(5)).Detail;
        Assert(detail.IndexOf("browsers connected to this player's game: 0", StringComparison.Ordinal)
                < detail.IndexOf(label, StringComparison.Ordinal),
            "the arrival count sits beside the browser count, which is the only place it reads as evidence");
    }

    /// <summary>
    /// The wire, end to end: a seat's JSON status over the real loopback control route, into the host's control
    /// record, and out into the verdict.
    /// </summary>
    private static async Task TheCountSurvivesTheAuthenticatedHeartbeat()
    {
        using var root = new TempSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssets(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
        var baseUri = await server.StartAsync();
        HeadlessConnectionControl.Shared.Register(91, 3, Guid.NewGuid(), "arrivals-token");
        try
        {
            using var client = new HttpClient { BaseAddress = baseUri };
            var reported = await PostAsync(client, "arrivals-token", 3,
                "{\"Sequence\":1,\"NativePhase\":\"Connecting\",\"ConnectedChildBrowserCount\":0,"
                + "\"BrowserPort\":13357,\"ViewerArrivalCount\":7}");
            Assert(reported.StatusCode == HttpStatusCode.OK, "a seat may report how much has reached it");
            Assert(HeadlessConnectionControl.Shared.Snapshot(91, 3)?.Status?.ViewerArrivalCount == 7,
                "…and the host keeps the count");

            var silent = await PostAsync(client, "arrivals-token", 3,
                "{\"Sequence\":2,\"NativePhase\":\"Connecting\",\"ConnectedChildBrowserCount\":0,\"BrowserPort\":13357}");
            Assert(silent.StatusCode == HttpStatusCode.OK, "a status without the field is still valid");
            Assert(HeadlessConnectionControl.Shared.Snapshot(91, 3)?.Status?.ViewerArrivalCount is null,
                "…and reads as 'has not said', NOT as an observed zero — an absent field must never become an "
                + "accusation aimed at the player's network");
        }
        finally
        {
            HeadlessConnectionControl.Shared.Unregister(91, 3);
        }

        // Validation, at the control record itself: a count is either absent or a count.
        var control = new HeadlessConnectionControl();
        control.Register(92, 1, Guid.NewGuid(), "validation-token");
        Assert(!control.Observe("validation-token", 1,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 0, 13357, -1)).Accepted,
            "a negative arrival count is refused rather than stored");
        Assert(control.Observe("validation-token", 1,
                new HeadlessConnectionStatus(1, "Connecting", null, null, 0, 13357, 0)).Accepted,
            "an affirmative zero is a legitimate report — it is the whole point of the field");

        // And the host turns what it received into the verdict, which is the half that closes the loop.
        var observed = control.Snapshot(92, 1)?.Status?.ViewerArrivalCount;
        Assert(SeatReadinessVerdict.Describe(Blocked(observed)).Cause == SeatReadinessCause.NetworkPath,
            "a zero that arrived over the heartbeat produces the network-path verdict on the host");
    }

    /// <summary>
    /// The seat side of the same wire: the reporter reads the count off its own arrival log, and reads the
    /// VIEWER counter rather than the total.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The distinction is load-bearing and invisible in the types. The host probes every seat's port from
    /// loopback several times a second while it waits, so a reporter that sent <c>TotalArrivalCount</c> would
    /// have every seat claiming a device had reached it within a second of starting, and the verdict this feeds
    /// would never be reachable again.
    /// </para>
    /// <para>
    /// Asserted against an INJECTED log rather than the process-wide one, because recording into
    /// <c>ConnectionArrivalLog.Shared</c> from a test process kills it: the shared log's default sink writes
    /// through the game's logger, which segfaults outside the game instead of throwing (measured — exit 139).
    /// Reading the shared log is safe, which is what the end-to-end leg below does.
    /// </para>
    /// </remarks>
    private static void TheReporterReadsTheViewerCounterNotTheTotal()
    {
        var log = new ConnectionArrivalLog(time: null, log: _ => { });
        log.Record(IPAddress.Loopback, "/", ConnectionArrivalOutcome.Shell);
        log.Record(IPAddress.IPv6Loopback, "/ws", ConnectionArrivalOutcome.WebSocket);
        Assert(HeadlessConnectionReporter.ViewerArrivals(log) == 0 && log.TotalArrivalCount == 2,
            "this machine's own requests to the seat — which is what the host's readiness probe is — are "
            + "recorded and reported as zero devices");

        log.Record(IPAddress.Parse("192.168.0.123"), "/", ConnectionArrivalOutcome.Shell);
        Assert(HeadlessConnectionReporter.ViewerArrivals(log) == 1,
            "a request from a phone is the one that counts");

        log.Record(null, "/", ConnectionArrivalOutcome.Shell);
        Assert(HeadlessConnectionReporter.ViewerArrivals(log) == 2,
            "and an arrival whose remote address could not be read counts AS a device: the verdict this feeds "
            + "accuses the player's network, so it may never be reached by guessing");
    }

    /// <summary>
    /// And the whole path in one go: the seat's real reporter, over the real authenticated route, into the
    /// host's control record.
    /// </summary>
    private static async Task TheSeatsOwnReporterCarriesItToTheHost()
    {
        using var root = new TempSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssets(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
        var baseUri = await server.StartAsync();
        HeadlessConnectionControl.Shared.Register(93, 5, Guid.NewGuid(), "reporter-token");
        var url = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable);
        var token = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable);
        var generation = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable,
                new Uri(baseUri, "/internal/client-status").ToString());
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable, "reporter-token");
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable, "5");

            // Whatever this process's own log holds — read, never written (see above). What is being pinned is
            // that the reporter puts it on the wire at all, and that the host stores what arrives.
            var reported = ConnectionArrivalLog.Shared.ViewerArrivalCount;
            Assert(await HeadlessConnectionReporter.ReportTerminalFailureAsync(
                    "seat-port-unavailable", "detail", CancellationToken.None),
                "the seat's reporter reaches the host's control endpoint");
            var status = HeadlessConnectionControl.Shared.Snapshot(93, 5)?.Status;
            Assert(status?.ViewerArrivalCount == reported,
                "the host receives the seat's own arrival count over the authenticated heartbeat");
            Assert(status?.ViewerArrivalCount is not null,
                "…as a number the seat actually stated, never as an absent field the host would have to read as "
                + "'nothing ever reached it'");
        }
        finally
        {
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable, url);
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable, token);
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable, generation);
            HeadlessConnectionControl.Shared.Unregister(93, 5);
        }
    }

    /// <summary>
    /// The seat's HELLO over the same real route: contact established from mod init, before there is a runtime,
    /// a subscription or a heartbeat — which is what makes the host's short no-contact deadline a question about
    /// whether CouchCoop is running rather than a race against how fast this computer starts a game.
    /// </summary>
    /// <remarks>
    /// Three things are asserted, and the middle one is the load-bearing one: the hello carries the cloud-save
    /// declaration, it is NOT a phase the join wait can redirect on, and a status sent AFTER it is still accepted
    /// — the sequence is process-wide, so the hello cannot consume the number the reporter's first heartbeat
    /// would have used and get it silently dropped.
    /// </remarks>
    private static async Task TheSeatSaysHelloBeforeItHasARuntime()
    {
        using var root = new TempSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssets(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
        var baseUri = await server.StartAsync();
        HeadlessConnectionControl.Shared.Register(94, 6, Guid.NewGuid(), "hello-token");
        var url = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable);
        var token = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable);
        var generation = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable,
                new Uri(baseUri, "/internal/client-status").ToString());
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable, "hello-token");
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable, "6");
            // The port asserted below is a PROCESS-WIDE static (HeadlessConnectionReporter's `_browserPort`,
            // static by design: the browser server and Initialize are not ordered). In a real seat it is 0
            // because nothing has bound yet — but this runner shares one process with tests that DO bind, and
            // HotReloadableBrowserServerHost publishes whatever port it got. So the precondition has to be
            // established rather than assumed: under `--seats` this test passed, and in the full sequence it
            // failed on a port an earlier test had already published.
            HeadlessConnectionReporter.PublishBrowserPort(0);

            Assert(await HeadlessConnectionReporter.ReportSeatHelloAsync(cloudSaveIsolated: true, CancellationToken.None),
                "the seat's hello reaches the host's control endpoint with no runtime behind it");
            var hello = HeadlessConnectionControl.Shared.Snapshot(94, 6)?.Status;
            Assert(hello?.CloudSaveIsolated == true,
                "…carrying the declaration the host's no-contact and undeclared rules both read");
            Assert(hello?.ErrorCode is null,
                "…and no error code: a hello is contact, not a complaint");
            Assert(hello?.NativePhase == HeadlessConnectionReporter.HelloPhase
                && hello.NativePhase is not ("Connecting" or "starting"),
                "…in a phase the join wait cannot redirect on, so contact can never be mistaken for readiness");
            Assert(hello!.BrowserPort == 0,
                "…and with no bound port, because at mod init there is not one — the host reads 0 as 'not yet'");

            Assert(await HeadlessConnectionReporter.ReportTerminalFailureAsync(
                    "seat-port-unavailable", "a later report", CancellationToken.None),
                "a status sent after the hello is still accepted — the sequence is process-wide, not per sender");
            Assert(HeadlessConnectionControl.Shared.Snapshot(94, 6)?.Status?.Sequence > hello.Sequence,
                "…because it carries a higher sequence than the hello did");
        }
        finally
        {
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable, url);
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable, token);
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable, generation);
            HeadlessConnectionControl.Shared.Unregister(94, 6);
        }
    }

    private static Task<HttpResponseMessage> PostAsync(HttpClient client, string token, long generation, string body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/internal/client-status")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("X-CouchCoop-Generation", generation.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return client.SendAsync(request);
    }

    private sealed class UnusedAssets : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
            string opaqueKey, CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("The status route must not request assets.");
    }

    private sealed class TempSpa : IDisposable
    {
        public TempSpa()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couch-seat-arrivals-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
            File.WriteAllText(System.IO.Path.Combine(Path, "index.html"), "<html><head></head><body></body></html>");
        }

        public string Path { get; }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[SeatArrivalEvidenceTests] FAILED: {message}");
    }
}
