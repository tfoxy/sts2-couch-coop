using System.Net;
using System.Net.Sockets;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// What a seat SAYS when it cannot reach the host's control channel — the evidence that did not exist.
/// </summary>
/// <remarks>
/// <para>
/// THE DEFECT THESE PIN, from a support report on 2026-09-18. A player's seat started, loaded the mod, joined
/// the host's lobby, bound its browser port and was still idling healthily 74 seconds later — and the host
/// waited out its entire 75-second deadline and reported <c>startup-timeout</c>, because not one status POST
/// ever reached it. Neither process recorded why: <c>SendOnceAsync</c> ended in a bare <c>catch</c>, a non-2xx
/// answer was dropped with a bare <c>return</c>, and a missing control environment built no reporter and said
/// nothing. Three silences over one loopback request between two processes of the same game.
/// </para>
/// <para>
/// So these assert the lines exist, that they name the cause and the endpoint, that they are rate-limited (the
/// sender runs once a second for the life of the process), and that they never carry the bearer token — which
/// is the seat's authority to declare its own Steam Cloud save isolation, in text that travels into support
/// threads.
/// </para>
/// </remarks>
internal static class SeatControlChannelEvidenceTests
{
    public static async Task RunAsync()
    {
        TheFaultNamesTheVariableThatIsWrong();
        AChannelThatWorksHasNoFault();
        OnlyASpawnedSeatComplainsAboutAMissingChannel();
        await AFailedSendIsRecordedOnceWithItsCause();
        await ARefusedStatusIsRecordedAsARefusalRatherThanSilence();
        ThePortFileIsReadBackAndAStaleOneIsNotBelieved();
        TheSilentSeatDecisionRestsOnEvidenceRatherThanAssumption();
        Console.WriteLine("SeatControlChannelEvidenceTests: ok");
    }

    // ---- 1. which part of the environment is wrong -------------------------------------------------------------
    //
    // "Not configured" would be true of all four of these and useful for none: the host sets all three variables
    // together, so WHICH one is wrong is the whole diagnosis.

    private static void TheFaultNamesTheVariableThatIsWrong()
    {
        Assert(Fault(null, "token", "1") == "COUCHCOOP_HEADLESS_CONTROL_URL is not set",
            "an absent URL is named as absent");
        Assert(Fault("not-a-url", "token", "1")!.Contains("not an absolute URL", StringComparison.Ordinal),
            "a malformed URL is told apart from a missing one");
        Assert(Fault("http://192.168.1.50:13337/internal/client-status", "token", "1")
                is { } remote && remote.Contains("not a loopback http address", StringComparison.Ordinal)
                && remote.Contains("192.168.1.50", StringComparison.Ordinal),
            "a non-loopback endpoint is refused AND quoted, because a wrong address is a real failure shape");
        Assert(Fault("https://127.0.0.1:13337/internal/client-status", "token", "1")
                is { } scheme && scheme.Contains("not a loopback http address", StringComparison.Ordinal),
            "…and so is the right host on the wrong scheme");
        Assert(Fault("http://127.0.0.1:13337/internal/client-status", " ", "1")
                == "COUCHCOOP_HEADLESS_CONTROL_TOKEN is not set",
            "a blank token is named");
        Assert(Fault("http://127.0.0.1:13337/internal/client-status", new string('t', 513), "1")
                is { } long_ && long_.Contains("longer than 512", StringComparison.Ordinal),
            "…and an over-long one is told apart from a missing one");
        Assert(Fault("http://127.0.0.1:13337/internal/client-status", "token", "0")
                == "COUCHCOOP_HEADLESS_CONTROL_GENERATION is not a positive whole number"
            && Fault("http://127.0.0.1:13337/internal/client-status", "token", "one")
                == "COUCHCOOP_HEADLESS_CONTROL_GENERATION is not a positive whole number",
            "a zero and an unparseable generation are both named");

        // The token is the one value that must never appear, in any of these sentences.
        foreach (var fault in new[]
                 {
                     Fault(null, "s3cret-token", "1"),
                     Fault("not-a-url", "s3cret-token", "1"),
                     Fault("http://127.0.0.1:1/x", "s3cret-token", "nope"),
                 })
        {
            Assert(fault is not null && !fault.Contains("s3cret-token", StringComparison.Ordinal),
                "no fault sentence ever quotes the bearer token");
        }
    }

    private static void AChannelThatWorksHasNoFault()
    {
        var fault = HeadlessConnectionReporter.TryParseChannel(
            "http://127.0.0.1:13337/internal/client-status", "token", "7", out var endpoint, out var generation);
        Assert(fault is null, "a loopback http URL, a token and a positive generation are a usable channel");
        Assert(endpoint is not null && endpoint.Port == 13337 && generation == 7,
            "…and the parsed parts come back with it, so there is one parser rather than two");

        // The generation is read culture-invariantly, because the host writes it that way. A parse that drifted
        // with the player's locale would take the whole channel down on their machine and nowhere else.
        Assert(HeadlessConnectionReporter.TryParseChannel(
                "http://127.0.0.1:13337/x", "token", "1002", out _, out var invariant) is null && invariant == 1002,
            "the generation parses as a plain invariant number");
    }

    // ---- 2. only a HOST-SPAWNED seat complains ----------------------------------------------------------------

    private static void OnlyASpawnedSeatComplainsAboutAMissingChannel()
    {
        var lines = Capture(() => HeadlessConnectionReporter.ReportNoChannel("a fault", spawnedSeat: false));
        Assert(lines.Count == 0,
            "a seat launched by hand has no control channel by design, and must not log an error about it");

        lines = Capture(() => HeadlessConnectionReporter.ReportNoChannel(
            "COUCHCOOP_HEADLESS_CONTROL_URL is not set", spawnedSeat: true));
        Assert(lines.Count == 1, "a seat the host spawned says so, once");
        Assert(lines[0].Contains("can never be admitted", StringComparison.Ordinal)
                && lines[0].Contains("COUCHCOOP_HEADLESS_CONTROL_URL is not set", StringComparison.Ordinal),
            "…naming the consequence and the fault");
    }

    // ---- 3. a send that fails ---------------------------------------------------------------------------------

    /// <summary>
    /// The exact field shape: nothing is listening where the seat was told to report. The line has to name the
    /// endpoint and the cause, and there has to be ONE of it rather than one per second.
    /// </summary>
    private static async Task AFailedSendIsRecordedOnceWithItsCause()
    {
        var endpoint = $"http://127.0.0.1:{ClosedPort()}/internal/client-status";
        var lines = await CaptureAsync(endpoint, "unreachable-token", "3", async () =>
        {
            // The hello is the EARLIEST sender in a real seat — mod init, before there is a runtime — so it is
            // the one whose failure a support report most needs. Its callers handle the throw; this asserts the
            // throw still happens AND that it is no longer silent.
            try
            {
                await HeadlessConnectionReporter.ReportSeatHelloAsync(true, CancellationToken.None);
                Assert(false, "a send to a closed port cannot report success");
            }
            catch (HttpRequestException)
            {
                // Expected: the caller's contract is unchanged.
            }

            try { await HeadlessConnectionReporter.ReportSeatHelloAsync(true, CancellationToken.None); }
            catch (HttpRequestException) { }
        });

        Assert(lines.Count == 1,
            $"a dead channel is recorded ONCE per window, not once per attempt (got {lines.Count})");
        Assert(lines[0].Contains("seat control channel", StringComparison.Ordinal)
                && lines[0].Contains(endpoint, StringComparison.Ordinal),
            "…naming the endpoint it could not reach");
        Assert(lines[0].Contains(" ms POSTing", StringComparison.Ordinal),
            "…and how long it took, which is what separates a refusal from a timeout");
        Assert(!lines[0].Contains("unreachable-token", StringComparison.Ordinal),
            "…and never the bearer token");
        Assert(lines[0].Contains("proxy", StringComparison.OrdinalIgnoreCase),
            "…and points at what actually filters one program talking to another on one computer");
    }

    // ---- 4. a send the host REFUSES --------------------------------------------------------------------------

    /// <summary>
    /// The other half, and the one that was fully invisible: the POST arrives and the host says no. That used
    /// to be <c>if (!response.IsSuccessStatusCode) return;</c> — indistinguishable, from inside the seat, from
    /// a status that was accepted.
    /// </summary>
    private static async Task ARefusedStatusIsRecordedAsARefusalRatherThanSilence()
    {
        using var root = new TempSpa();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new UnusedAssets(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
        var baseUri = await server.StartAsync();
        HeadlessConnectionControl.Shared.Register(95, 8, Guid.NewGuid(), "the-real-token");
        try
        {
            var endpoint = new Uri(baseUri, "/internal/client-status").ToString();
            var lines = await CaptureAsync(endpoint, "a-stale-token", "8", async () =>
                Assert(!await HeadlessConnectionReporter.ReportSeatHelloAsync(true, CancellationToken.None),
                    "a refused status is not reported as delivered"));
            Assert(lines.Count == 1 && lines[0].Contains("the host answered 401", StringComparison.Ordinal),
                "the host's refusal is recorded with the status it refused with");
            Assert(!lines[0].Contains("a-stale-token", StringComparison.Ordinal),
                "…and still never quotes the token");
        }
        finally
        {
            HeadlessConnectionControl.Shared.Unregister(95, 8);
        }
    }

    // ---- 5. the fact that needs no network at all ------------------------------------------------------------

    /// <summary>
    /// The port file, which is what lets the host tell "this seat is serving and cannot talk to me" from "this
    /// seat is gone" WITHOUT using the transport that is in doubt. The pid check is the point: the record
    /// outlives a killed seat by design, so a stale one must never read as a live listener.
    /// </summary>
    private static void ThePortFileIsReadBackAndAStaleOneIsNotBelieved()
    {
        var dir = Path.Combine(Path.GetTempPath(), "couch-port-file-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var path = Path.Combine(dir, BrowserPortFile.FileNameFor(2));
            Assert(path.EndsWith("browser-port-slot-2", StringComparison.Ordinal),
                "a seat's record is slot-scoped, so seats sharing the host's profile cannot overwrite each other");
            Assert(BrowserPortFile.FileNameFor(0) == BrowserPortFile.FileName,
                "…and the host's own record keeps the fixed name every QA script addresses it by");

            Assert(BrowserPortFile.Read(path) is null, "an absent record reads as no answer, not as a throw");
            File.WriteAllText(path, "{\"port\":13357,\"pid\":27212}\n");
            Assert(BrowserPortFile.Read(path) is (13357, 27212), "a written record reads back as its port and pid");

            File.WriteAllText(path, "{\"port\":13357}\n");
            Assert(BrowserPortFile.Read(path) is null,
                "a record with no pid is unusable: the pid is what makes it self-invalidating");
            File.WriteAllText(path, "{\"port\":0,\"pid\":27212}\n");
            Assert(BrowserPortFile.Read(path) is null, "port 0 is not a port anything is serving on");
            File.WriteAllText(path, "{\"port\":13357,\"pid\":");
            Assert(BrowserPortFile.Read(path) is null, "a half-written record reads as no answer");
            File.WriteAllText(path, "[]");
            Assert(BrowserPortFile.Read(path) is null, "and so does a document that is not an object");
            Assert(BrowserPortFile.Read(null) is null && BrowserPortFile.Read(" ") is null,
                "a caller with no path to read gets no answer and no exception");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // ---- 6. which of the three silences this is --------------------------------------------------------------

    /// <summary>
    /// The host's side of the same defect: ONE silence, three possible meanings, and until this round it was
    /// always reported as the same one. Each arm is asserted on the evidence that licenses it, and the evidence
    /// tail is asserted to be present in all of them — the verdict is an interpretation, and a report that
    /// names the wrong cause has to remain re-readable.
    /// </summary>
    private static void TheSilentSeatDecisionRestsOnEvidenceRatherThanAssumption()
    {
        const int expected = 13357;
        const int pid = 27212;
        var answered = new SeatListenerProbeResult(true, null, SeatPortReachability.NotProbed);
        var silent = new SeatListenerProbeResult(
            false, "HttpRequestException/ConnectionRefused after 3 ms", SeatPortReachability.ConnectionRefused);

        // 1. Nothing answers and the seat recorded nothing: the only arm entitled to say it stopped.
        var stopped = Classify(pid, null, silent, expected);
        Assert(stopped.Code == HeadlessClientManager.SeatSilentAfterJoinCode,
            "no listener and no record of one is the seat that joined and stopped");

        // 2. The host's own request is answered: it is running, so nothing may claim otherwise.
        var reachable = Classify(pid, null, answered, expected);
        Assert(reachable.Code == HeadlessClientManager.SeatControlBlockedCode,
            "a seat whose port answers this host is a blocked control channel, not a dead seat");

        // 3. …and it is answered EVEN IF the probe cannot reach it, when the seat wrote the port itself. This is
        //    the arm that needs no network at all, which is the point of reading the file: the suspicion under
        //    this whole cause is that local requests between two processes are being filtered.
        var recorded = Classify(pid, (expected, pid), silent, expected);
        Assert(recorded.Code == HeadlessClientManager.SeatControlBlockedCode,
            "a seat's own record of the port it bound proves it is serving without using the suspect transport");

        // 4. A record from a DIFFERENT process is the stale file a killed seat leaves behind, and must not
        //    rescue anything.
        var stale = Classify(pid, (expected, pid + 1), silent, expected);
        Assert(stale.Code == HeadlessClientManager.SeatSilentAfterJoinCode,
            "a record left by another process is not evidence that THIS seat is serving");
        var unknownPid = Classify(0, (expected, pid), silent, expected);
        Assert(unknownPid.Code == HeadlessClientManager.SeatSilentAfterJoinCode,
            "…and neither is any record at all when the host cannot say which process it started");

        // 5. Ours, alive, and on the WRONG port: the browser is being sent somewhere that is not this game.
        var elsewhere = Classify(pid, (13360, pid), silent, expected);
        Assert(elsewhere.Code == SeatReadinessVerdict.PortTakenCode,
            "a seat serving a port other than the one the browser is sent to is a port conflict");
        Assert(elsewhere.Detail!.Contains("13360", StringComparison.Ordinal)
                && elsewhere.Detail.Contains("13357", StringComparison.Ordinal),
            "…naming both ports, because the disagreement IS the finding");

        // The evidence tail rides on every one of them.
        foreach (var issue in new[] { stopped, reachable, recorded, stale, elsewhere })
        {
            Assert(issue.Detail!.Contains("Observed:", StringComparison.Ordinal)
                    && issue.Detail.Contains("CONTROL-EVIDENCE", StringComparison.Ordinal),
                $"{issue.Code} carries the evidence tail, including what the control channel had heard");
        }

        Assert(stopped.Detail!.Contains("ConnectionRefused after 3 ms", StringComparison.Ordinal),
            "…and the probe's own failure reason reaches the report verbatim, as it does on the readiness path");
    }

    private static ConnectionIssue Classify(
        int seatPid, (int Port, int Pid)? record, SeatListenerProbeResult probe, int expectedPort)
        => HeadlessClientManager.ClassifySilentSeat(
            slot: 2,
            expectedPort: expectedPort,
            seatProcessId: seatPid,
            portRecord: record,
            probe: probe,
            controlChannel: "CONTROL-EVIDENCE",
            deadline: TimeSpan.FromSeconds(35));

    // ---- helpers ---------------------------------------------------------------------------------------------

    private static string? Fault(string? url, string? token, string? generation)
        => HeadlessConnectionReporter.TryParseChannel(url, token, generation, out _, out _);

    /// <summary>Take the diagnostic lines one action writes, instead of the game logger they default to.</summary>
    private static List<string> Capture(Action action)
    {
        var lines = new List<string>();
        HeadlessConnectionReporter.LogSink = line => lines.Add(line);
        try { action(); }
        finally { HeadlessConnectionReporter.LogSink = null; }
        return lines;
    }

    /// <summary>The same, for an action that needs the three control-channel variables set around it.</summary>
    private static async Task<List<string>> CaptureAsync(
        string endpoint, string token, string generation, Func<Task> action)
    {
        var priorUrl = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable);
        var priorToken = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable);
        var priorGeneration = Environment.GetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable);
        var lines = new List<string>();
        HeadlessConnectionReporter.LogSink = line => lines.Add(line);
        Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable, endpoint);
        Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable, token);
        Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable, generation);
        try { await action(); }
        finally
        {
            HeadlessConnectionReporter.LogSink = null;
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlUrlEnvironmentVariable, priorUrl);
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlTokenEnvironmentVariable, priorToken);
            Environment.SetEnvironmentVariable(HeadlessConnectionReporter.ControlGenerationEnvironmentVariable, priorGeneration);
        }

        return lines;
    }

    /// <summary>A loopback port nothing is listening on — bound, read back, and released.</summary>
    private static int ClosedPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
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
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(), "couch-control-evidence-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
            File.WriteAllText(System.IO.Path.Combine(Path, "index.html"), "<html><head></head><body></body></html>");
        }

        public string Path { get; }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[SeatControlChannelEvidenceTests] FAILED: {message}");
    }
}
