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
        TheStatusRecordIsOnlyBelievedWhenItIsOursAndSigned();
        await TheStatusRecordIsWrittenOnlyWhileTheChannelIsFailing();
        TheEvidenceTailNamesTheChannelThatDelivered();
        TheForcedFailureLeverIsAnExactMatch();
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
        Assert(!elsewhere.Detail.Contains("not the process this host started", StringComparison.Ordinal),
            "…and never calls a LIVE seat of ours somebody else's process: the pid matched, the port did not");
        Assert(stale.Detail!.Contains("not the process this host started", StringComparison.Ordinal),
            "…while a record from another process is described as exactly that");

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

    // ---- 7. the record that crosses the same gap without a socket --------------------------------------------

    /// <summary>
    /// The seat's status file: everything the host checks before it will let a record stand in for a report the
    /// transport never delivered. A forgeable one would be worse than no fallback at all — the status carries
    /// the seat's Steam Cloud save isolation declaration, which is the whole basis on which a seat is allowed to
    /// run beside the host's account.
    /// </summary>
    private static void TheStatusRecordIsOnlyBelievedWhenItIsOursAndSigned()
    {
        var dir = Path.Combine(Path.GetTempPath(), "couch-status-file-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, SeatStatusFile.FileNameFor(2));
        SeatStatusFile.PathOverride = () => path;
        try
        {
            Assert(SeatStatusFile.FileNameFor(2) == "status-slot-2.json"
                    && SeatStatusFile.FileNameFor(3) != SeatStatusFile.FileNameFor(2)
                    && SeatStatusFile.FileNameFor(0) == "status.json",
                "a seat's record is slot-scoped, so seats sharing the host's profile cannot overwrite each other");

            var pid = Environment.ProcessId;
            var status = new HeadlessConnectionStatus(
                7, "Connecting", null, null, 1, 13357, 4, CloudSaveIsolated: true);
            Assert(SeatStatusFile.TryWrite(status, "s3cret-token", 9), "a seat with a channel can write a record");
            Assert(SeatStatusFile.Read(path, "s3cret-token", pid, 9) == status,
                "…and the host reads back the very status the seat would have POSTed, field for field");
            Assert(!File.ReadAllText(path).Contains("s3cret-token", StringComparison.Ordinal),
                "…and the bearer token, which is what signs it, is never written into it");

            Assert(SeatStatusFile.Read(path, "another-token", pid, 9) is null,
                "a record this host did not issue the key for is not evidence about anything");
            Assert(SeatStatusFile.Read(path, "s3cret-token", pid + 1, 9) is null,
                "…nor is one written by a process this host did not start: a record outlives a killed seat");
            Assert(SeatStatusFile.Read(path, "s3cret-token", 0, 9) is null,
                "…nor any record at all when the host cannot say which process it started");
            Assert(SeatStatusFile.Read(path, "s3cret-token", pid, 10) is null,
                "…nor one from a generation this host has replaced");

            var written = File.ReadAllText(path);
            File.WriteAllText(path, written.Replace("\"Connecting\"", "\"starting\"", StringComparison.Ordinal));
            Assert(SeatStatusFile.Read(path, "s3cret-token", pid, 9) is null,
                "an edited status no longer matches the signature over it");
            File.WriteAllText(path, written.Replace("\"pid\":" + pid, "\"pid\":" + (pid + 1), StringComparison.Ordinal));
            Assert(SeatStatusFile.Read(path, "s3cret-token", pid + 1, 9) is null,
                "…and re-labelling a record as another process's breaks it too, because the pid is inside the MAC");

            File.WriteAllText(path, written[..(written.Length / 2)]);
            Assert(SeatStatusFile.Read(path, "s3cret-token", pid, 9) is null, "a half-written record reads as no answer");
            File.WriteAllText(path, "[]");
            Assert(SeatStatusFile.Read(path, "s3cret-token", pid, 9) is null, "and so does a document that is not an object");
            File.Delete(path);
            Assert(SeatStatusFile.Read(path, "s3cret-token", pid, 9) is null,
                "an absent record reads as no answer, not as a throw");
            Assert(SeatStatusFile.Read(null, "s3cret-token", pid, 9) is null
                    && SeatStatusFile.Read(path, "", pid, 9) is null,
                "a caller with no path or no key gets no answer and no exception");
        }
        finally
        {
            SeatStatusFile.PathOverride = null;
            Directory.Delete(dir, recursive: true);
        }
    }

    /// <summary>
    /// WHEN the record exists, which is the half that keeps this off healthy machines: only after a report has
    /// failed, and taken away again the moment one succeeds.
    /// </summary>
    private static async Task TheStatusRecordIsWrittenOnlyWhileTheChannelIsFailing()
    {
        var dir = Path.Combine(Path.GetTempPath(), "couch-status-write-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, SeatStatusFile.FileNameFor(2));
        SeatStatusFile.PathOverride = () => path;
        using var root = new TempSpa();
        try
        {
            // 1. A HEALTHY seat. The host's real route, a token it knows, an accepted status — and no file.
            await using var server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(root.Path), new UnusedAssets(), envelopeFactory: null,
                bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true);
            var baseUri = await server.StartAsync();
            HeadlessConnectionControl.Shared.Register(96, 11, Guid.NewGuid(), "healthy-token");
            var live = new Uri(baseUri, "/internal/client-status").ToString();
            await CaptureAsync(live, "healthy-token", "11", async () =>
                Assert(await HeadlessConnectionReporter.ReportSeatHelloAsync(true, CancellationToken.None),
                    "the host accepts a status over the loopback POST"));
            Assert(!File.Exists(path),
                "a seat whose report is getting through writes NOTHING: the fallback costs a healthy session nothing");

            // 2. The field fault. Nothing listening where this seat was told to report.
            var closed = $"http://127.0.0.1:{ClosedPort()}/internal/client-status";
            await CaptureAsync(closed, "healthy-token", "11", async () =>
            {
                try { await HeadlessConnectionReporter.ReportSeatHelloAsync(true, CancellationToken.None); }
                catch (HttpRequestException) { }
            });
            Assert(File.Exists(path), "a seat whose report cannot be delivered leaves it where the host can find it");
            var carried = SeatStatusFile.Read(path, "healthy-token", Environment.ProcessId, 11);
            Assert(carried is { NativePhase: HeadlessConnectionReporter.HelloPhase, CloudSaveIsolated: true },
                "…and what it left is the status itself, hello phase and cloud declaration intact");

            // 3. The channel comes back. The record must not outlive the fault it stood in for.
            await CaptureAsync(live, "healthy-token", "11", async () =>
                Assert(await HeadlessConnectionReporter.ReportSeatHelloAsync(true, CancellationToken.None),
                    "the host accepts the status again once the channel works"));
            Assert(!File.Exists(path), "…and the seat takes its record back down");
        }
        finally
        {
            HeadlessConnectionControl.Shared.Unregister(96, 11);
            SeatStatusFile.PathOverride = null;
            Directory.Delete(dir, recursive: true);
        }
    }

    // ---- 8. which channel carried it -------------------------------------------------------------------------

    /// <summary>
    /// The evidence tail's third question. "Nothing arrived" and "it arrived the slow way" are opposite findings
    /// about the same computer, and a report that cannot tell them apart cannot say whether the workaround the
    /// mod now performs is the thing keeping that player in the game.
    /// </summary>
    private static void TheEvidenceTailNamesTheChannelThatDelivered()
    {
        var status = new HeadlessConnectionStatus(1, "Connecting", null, null, 0, 13357, 0, CloudSaveIsolated: true);

        Assert(Tail(null).Contains("no status has reached this host by either", StringComparison.Ordinal),
            "a seat with no registration at all has been heard by neither channel");
        Assert(Tail(Snapshot(status, accepted: 0)).Contains("by either", StringComparison.Ordinal),
            "…and so has a registered seat that has never had a status accepted");

        var direct = Tail(Snapshot(status, accepted: 4));
        Assert(direct.Contains("as a direct report", StringComparison.Ordinal)
                && !direct.Contains("status file", StringComparison.Ordinal),
            "a healthy seat's tail says the ordinary channel carried it, and raises no fallback");

        var viaFile = Tail(Snapshot(status, accepted: 4, channel: HeadlessStatusChannel.File, viaFile: 4));
        Assert(viaFile.Contains("status file", StringComparison.Ordinal)
                && viaFile.Contains("blocked on this computer", StringComparison.Ordinal),
            "a rescued seat's tail says so, and names the computer rather than the player's network");

        var recovered = Tail(Snapshot(status, accepted: 9, channel: HeadlessStatusChannel.Http, viaFile: 4));
        Assert(recovered.Contains("as a direct report", StringComparison.Ordinal)
                && recovered.Contains("4 earlier", StringComparison.Ordinal),
            "a seat whose channel recovered keeps the count of what had to come the slow way");
    }

    // ---- 9. the live-QA lever --------------------------------------------------------------------------------

    /// <summary>
    /// Exactly two values arm it, for <c>SeatCloudSaveIsolationPatch.ForcedFailure</c>'s reason: a lever that
    /// armed on anything loosely truthy would break every seat on a machine that happened to set the name.
    /// </summary>
    private static void TheForcedFailureLeverIsAnExactMatch()
    {
        Assert(HeadlessConnectionReporter.ForcedFailure("1")
                == HeadlessConnectionReporter.ForcedControlFailure.Post,
            "`1` fails the report, which is the fault measured in the field");
        Assert(HeadlessConnectionReporter.ForcedFailure(" 1 ")
                == HeadlessConnectionReporter.ForcedControlFailure.Post,
            "…and surrounding whitespace is not a different setting");
        Assert(HeadlessConnectionReporter.ForcedFailure("all")
                == HeadlessConnectionReporter.ForcedControlFailure.PostAndFile,
            "`all` fails the report AND the file, which is a seat that cannot be heard at all");
        foreach (var inert in new[] { null, "", " ", "0", "true", "yes", "ALL", "2", "post" })
        {
            Assert(HeadlessConnectionReporter.ForcedFailure(inert) is null,
                $"'{inert ?? "null"}' does not arm a lever that breaks a player's join");
        }
    }

    private static string Tail(HeadlessConnectionControlSnapshot? snapshot)
        => HeadlessClientManager.DescribeControlChannel(snapshot);

    private static HeadlessConnectionControlSnapshot Snapshot(
        HeadlessConnectionStatus status,
        long accepted,
        HeadlessStatusChannel channel = HeadlessStatusChannel.Http,
        long viaFile = 0)
        => new(
            Slot: 2, Generation: 1, SourceSessionId: Guid.NewGuid(), Status: status,
            ObservedAtUtc: DateTimeOffset.UtcNow, ObservedMonotonicTick: null, ShutdownRequested: false,
            AcceptedCount: accepted, RefusedCount: 0, LastRefusal: HeadlessConnectionRejection.None,
            LastChannel: channel, FileAcceptedCount: viaFile);

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
