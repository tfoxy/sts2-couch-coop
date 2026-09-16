using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// The pre-WebSocket half of connection diagnostics: the visit id embedded in the SPA document, the bounded
/// arrival ring behind it, and the promotion that keeps a visit from becoming a second row.
/// </summary>
internal static class ConnectionArrivalLogTests
{
    public static async Task RunAsync()
    {
        VisitIdShapeAndInjectionRefusals();
        RingCapsCoalescesAndExpires();
        VisitPromotesIntoOneRowAndReachesTheReport();
        AnEmptyRingSaysWhichSilenceItIs();
        NoPlayerNameReachesTheRing();
        await ShellResponsesAreUniqueAndUncacheableAsync();
        await ShellWithoutHeadIsServedUnmodifiedAsync();
        await WebSocketArrivalsCarryTheirVisitAsync();
    }

    private static void VisitIdShapeAndInjectionRefusals()
    {
        var visit = ConnectionArrivalLog.MintVisitId();
        Assert(visit.Length == ConnectionArrivalLog.VisitIdLength && Regex.IsMatch(visit, "^[0-9a-f]+$"),
            "a minted visit id is 32 lower-case hex characters");
        Assert(ConnectionArrivalLog.MintVisitId() != visit, "minted visit ids differ");
        foreach (var rejected in new[] { null, "", "short", visit.ToUpperInvariant(), visit + "0", visit[..31] + "g", "<script>" })
            Assert(ConnectionArrivalLog.NormalizeVisitId(rejected) is null, $"a visit id outside the minted shape is dropped: {rejected}");
        Assert(ConnectionArrivalLog.NormalizeVisitId(visit) == visit, "a minted visit id normalises to itself");

        var document = Bytes("<!doctype html>\n<html lang=\"en\">\n  <head>\n    <title>x</title>\n  </head>\n  <body></body>\n</html>\n");
        var injected = Text(VisitIdTag.Inject(document, visit));
        Assert(injected.Contains($"<meta name=\"couchcoop-visit\" content=\"{visit}\" />", StringComparison.Ordinal),
            "the visit tag is injected with the documented shape");
        Assert(injected.IndexOf("<meta name=\"couchcoop-visit\"", StringComparison.Ordinal) > injected.IndexOf("<head>", StringComparison.Ordinal)
               && injected.IndexOf("<meta name=\"couchcoop-visit\"", StringComparison.Ordinal) < injected.IndexOf("<title>", StringComparison.Ordinal),
            "the tag is injected immediately after the opening head tag");
        Assert(injected.Replace($"\n    <meta name=\"couchcoop-visit\" content=\"{visit}\" />", "", StringComparison.Ordinal) == Text(document),
            "nothing else in the document changes");

        var uppercase = Text(VisitIdTag.Inject(Bytes("<HTML><HEAD ><TITLE>x</TITLE></HEAD></HTML>"), visit));
        Assert(uppercase.Contains("couchcoop-visit", StringComparison.Ordinal), "an upper-case head tag is recognised");

        // Every refusal returns the SAME array: a shell we cannot inject into is served untouched, never
        // half-rewritten.
        var headerOnly = Bytes("<html><body><header>no head element</header></body></html>");
        Assert(ReferenceEquals(VisitIdTag.Inject(headerOnly, visit), headerOnly), "`<header>` is not mistaken for `<head>`");
        var noHead = Bytes("<html><body>nothing here</body></html>");
        Assert(ReferenceEquals(VisitIdTag.Inject(noHead, visit), noHead), "a document with no head is served unmodified");
        var unterminated = Bytes("<html><head");
        Assert(ReferenceEquals(VisitIdTag.Inject(unterminated, visit), unterminated), "an unterminated head tag is served unmodified");
        var good = Bytes("<html><head></head></html>");
        Assert(ReferenceEquals(VisitIdTag.Inject(good, "not-a-visit-id"), good), "an untrusted visit id is never injected");
        Assert(ReferenceEquals(VisitIdTag.Inject(good, null), good), "a missing visit id is never injected");

        Assert(VisitIdTag.IsHtml("text/html; charset=utf-8"), "the SPA document is HTML");
        foreach (var other in new[] { "text/javascript; charset=utf-8", "application/wasm", "image/png", null })
            Assert(!VisitIdTag.IsHtml(other), $"a non-HTML response is never rewritten: {other ?? "<none>"}");
    }

    private static void RingCapsCoalescesAndExpires()
    {
        var time = new FakeTime();
        var log = new ConnectionArrivalLog(time, _ => { });
        var viewer = IPAddress.Parse("192.168.0.123");

        for (var index = 0; index < ConnectionArrivalLog.MaximumRetainedArrivals + 40; index++)
        {
            log.Record(viewer, $"/asset-{index}.png", ConnectionArrivalOutcome.NotFound);
            time.Advance(1);
        }

        var rows = log.Snapshot();
        Assert(rows.Count == ConnectionArrivalLog.MaximumRetainedArrivals, "the ring caps at its retention limit");
        Assert(rows[0].Path == "/asset-40.png" && rows[^1].Path == "/asset-167.png", "the ring evicts oldest first");
        Assert(log.TotalArrivalCount == 168 && log.ViewerArrivalCount == 168,
            "lifetime counters keep counting past the ring's capacity");

        // A repeat of the newest entry folds into it: a scanner retrying one URL must not evict the ring.
        var before = log.Snapshot().Count;
        log.Record(viewer, "/asset-167.png", ConnectionArrivalOutcome.NotFound);
        Assert(log.Snapshot().Count == before && log.Snapshot()[^1].Repeats == 2, "an immediate repeat coalesces instead of adding a row");
        Assert(log.ViewerArrivalCount == 169, "…and is still counted as an arrival");

        // The host's own loopback probe is traffic, but it is not a device arriving.
        log.Record(IPAddress.Loopback, "/", ConnectionArrivalOutcome.Shell);
        Assert(log.ViewerArrivalCount == 169, "a loopback request is not counted as a viewer arrival");
        Assert(log.Snapshot()[^1].FromViewer == false, "a loopback request is recorded as not-from-a-viewer");

        var expiring = new ConnectionArrivalLog(time, _ => { });
        var visit = expiring.BeginVisit(viewer, null, "/");
        Assert(expiring.HasArrivedForVisit(visit), "a fresh visit is matched");
        time.Advance((long)ConnectionArrivalLog.VisitRetention.TotalMilliseconds + 1);
        expiring.Record(viewer, "/", ConnectionArrivalOutcome.Shell);
        Assert(!expiring.HasArrivedForVisit(visit), "an un-promoted visit expires");
        Assert(!expiring.Promote(visit, Guid.NewGuid()), "an expired visit cannot be promoted");
        Assert(expiring.Snapshot().Count == 1, "expired arrivals are dropped from the ring");
        Assert(expiring.ViewerArrivalCount == 2, "…while the lifetime viewer count still records that a device reached us");
    }

    private static void VisitPromotesIntoOneRowAndReachesTheReport()
    {
        var time = new FakeTime();
        var arrivals = new ConnectionArrivalLog(time, _ => { });
        var registry = new ConnectionRegistry(time, null, arrivals);
        var visit = arrivals.BeginVisit(IPAddress.Parse("192.168.0.123"), MotoUserAgent, "/");
        time.Advance(2_400);
        arrivals.Record(IPAddress.Parse("192.168.0.123"), "/ws", ConnectionArrivalOutcome.WebSocket, visit, MotoUserAgent);

        var clientId = Guid.NewGuid();
        registry.Connected(clientId, "Galaxy S24 Ultra");
        registry.BeginAttempt(clientId);
        // What CouchCoopWebSocketConnection.PromoteVisit does when the browser sends its visit on `join`.
        Assert(arrivals.Promote(visit, clientId), "a visit the browser sends back is promoted");
        registry.RecordDiagnostic(clientId, "visit", visit);

        Assert(registry.Snapshot().Rows.Count == 1, "a promoted visit merges into the WebSocket row instead of adding one");
        var summary = arrivals.Summarize(visit);
        Assert(summary.Count == 2 && summary.Promoted, "the visit's arrivals are attributed to that connection");
        Assert(summary.DeviceLabel is not null && summary.DeviceLabel == "Galaxy S24 Ultra · Chrome 120",
            "the device label comes off the GET's User-Agent");

        var report = registry.BuildReport(clientId);
        Assert(report is not null, "the report is built");
        Assert(report!.Contains("arrivals: HTTP requests that reached this host", StringComparison.Ordinal),
            "the report carries an arrivals section");
        Assert(report.Contains("a device that never reached it leaves none", StringComparison.Ordinal),
            "the arrivals section states what it cannot see");
        Assert(report.Contains($"visit={visit}", StringComparison.Ordinal), "the report carries this attempt's visit id");
        Assert(report.Contains("192.168.0.123 GET / -> shell", StringComparison.Ordinal), "the report carries the shell arrival");
        Assert(report.Contains("GET /ws -> websocket", StringComparison.Ordinal), "the report carries the socket arrival");
        Assert(report.Contains($"client={clientId:N}", StringComparison.Ordinal), "a promoted arrival names the connection it belongs to");

        // An un-promoted visit is diagnostics, never a second row.
        arrivals.BeginVisit(IPAddress.Parse("192.168.0.77"), null, "/");
        Assert(registry.Snapshot().Rows.Count == 1, "an un-promoted visit never becomes a row");
        Assert(registry.BuildReport(clientId)!.Contains("192.168.0.77", StringComparison.Ordinal),
            "…but it is still visible in the report, which is the whole point");
    }

    /// <summary>
    /// Nothing recorded is two different facts, and only the layer below (HostReachabilityWatch, which counts
    /// accepted TCP connections) can separate them.
    /// </summary>
    private static void AnEmptyRingSaysWhichSilenceItIs()
    {
        var nothingConnected = new ConnectionArrivalLog(new FakeTime(), _ => { }, sawInboundConnection: () => false);
        Assert(nothingConnected.DescribeForReport(null).Single().Contains("no inbound connection", StringComparison.Ordinal),
            "an empty ring with no accepted connection says so");
        var connectedButSilent = new ConnectionArrivalLog(new FakeTime(), _ => { }, sawInboundConnection: () => true);
        Assert(connectedButSilent.DescribeForReport(null).Single().Contains("HAS accepted a connection", StringComparison.Ordinal),
            "an empty ring behind an accepted connection reads as a different failure");
        connectedButSilent.Record(IPAddress.Parse("192.168.0.123"), "/", ConnectionArrivalOutcome.Shell);
        Assert(connectedButSilent.DescribeForReport(null).Single().Contains("-> shell", StringComparison.Ordinal),
            "…and the note disappears as soon as there is anything to show");
    }

    private static void NoPlayerNameReachesTheRing()
    {
        var arrivals = new ConnectionArrivalLog(new FakeTime(), _ => { });
        arrivals.Record(IPAddress.Parse("192.168.0.123"), "/?name=Tomas&lang=en", ConnectionArrivalOutcome.Shell);
        arrivals.Record(IPAddress.Parse("192.168.0.123"), "/join#name=Tomas", ConnectionArrivalOutcome.Shell);
        var described = string.Join("\n", arrivals.Snapshot().Select(ConnectionArrivalLog.Describe));
        Assert(!described.Contains("Tomas", StringComparison.OrdinalIgnoreCase), "a player name in the URL never reaches the ring");
        Assert(!described.Contains('?'), "no query string is retained");
        Assert(arrivals.Snapshot()[0].Path == "/" && arrivals.Snapshot()[1].Path == "/join", "only the path is kept");

        arrivals.Record(IPAddress.Parse("192.168.0.123"), "/" + new string('x', 4096), ConnectionArrivalOutcome.NotFound);
        Assert(arrivals.Snapshot()[^1].Path.Length <= ConnectionArrivalLog.MaximumPathLength + 1, "a long path is truncated");
        arrivals.Record(IPAddress.Parse("192.168.0.123"), "/a\tb", "not an outcome\n");
        Assert(arrivals.Snapshot()[^1].Path == "/a b" && arrivals.Snapshot()[^1].Outcome == "not-an-outcome",
            "control characters and free-form outcomes are normalised");
    }

    private static async Task ShellResponsesAreUniqueAndUncacheableAsync()
    {
        var lines = new List<string>();
        var arrivals = new ConnectionArrivalLog(log: line => { lock (lines) lines.Add(line); });
        using var root = new TempSpaRoot(
            "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <title>STS2 Couch Co-op</title>\n  </head>\n  <body></body>\n</html>\n");
        root.Write("app/main.js", "export const bundle = 1;\n");
        await using var server = NewServer(root, arrivals);
        var baseUri = await server.StartAsync();
        using var client = NewClient(baseUri);

        var first = await client.GetAsync("/");
        var firstBody = await first.Content.ReadAsStringAsync();
        var second = await client.GetAsync("/");
        var secondBody = await second.Content.ReadAsStringAsync();

        Assert(first.StatusCode == HttpStatusCode.OK && second.StatusCode == HttpStatusCode.OK, "the shell is served");
        Assert(CacheControl(first) == "no-store" && CacheControl(second) == "no-store",
            "the SPA shell is no-store, or the HTTP cache would hand several devices one visit id");
        var firstVisit = ReadVisit(firstBody);
        var secondVisit = ReadVisit(secondBody);
        Assert(firstVisit is not null && secondVisit is not null, "each shell response carries a visit id");
        Assert(firstVisit != secondVisit, "two shell responses get different visit ids");
        Assert(ConnectionArrivalLog.NormalizeVisitId(firstVisit) == firstVisit, "the served id is in the minted shape");

        // The hashed bundle is byte-identical for every device: it must not be rewritten, and its caching is
        // left exactly as it was.
        var bundle = await client.GetAsync("/app/main.js");
        Assert(await bundle.Content.ReadAsStringAsync() == "export const bundle = 1;\n", "a non-HTML file is served unmodified");
        Assert(CacheControl(bundle) is null, "the shell's no-store does not leak onto other static files");

        var named = await client.GetAsync("/?name=Tomas");
        Assert(named.StatusCode == HttpStatusCode.OK, "a join URL with a name still serves the shell");
        var missing = await client.GetAsync("/missing-asset.png");
        Assert(missing.StatusCode == HttpStatusCode.NotFound, "a missing asset 404s");

        var recorded = arrivals.Snapshot();
        Assert(recorded.Count(entry => entry.Outcome == ConnectionArrivalOutcome.Shell) == 3, "each shell response is one arrival");
        Assert(recorded.Any(entry => entry.Outcome == ConnectionArrivalOutcome.NotFound && entry.Path == "/missing-asset.png"),
            "a refusal is recorded too");
        Assert(recorded.All(entry => !entry.Path.Contains("Tomas", StringComparison.OrdinalIgnoreCase)),
            "no player name reaches the ring through the real request path");
        Assert(recorded.Any(entry => entry.VisitId == firstVisit) && recorded.Any(entry => entry.VisitId == secondVisit),
            "the served ids are the recorded ids");
        Assert(recorded.Any(entry => entry.DeviceLabel is not null && entry.DeviceLabel == "Galaxy S24 Ultra · Chrome 120"),
            "the arrival carries a device label derived from the GET's User-Agent");
        Assert(!recorded.Any(entry => entry.Outcome == ConnectionArrivalOutcome.Shell && entry.Path == "/app/main.js"),
            "the bundle fetch is not recorded as a shell arrival");
        lock (lines)
        {
            // No prefix here, and that is the point: the injected sink sees the MESSAGE, and CouchCoopLog is
            // what prepends `[couchcoop] ` on the way out — which is why this assertion used to match
            // `[couch-coop] `, a spelling nothing else in the mod used. CouchCoopLogPrefixTests pins the prefix.
            Assert(lines.Any(line => line.StartsWith("arrival ", StringComparison.Ordinal) && line.Contains("-> shell", StringComparison.Ordinal)),
                "an arrival reaches the diagnostic log");
            Assert(lines.All(line => !line.Contains("Tomas", StringComparison.OrdinalIgnoreCase)), "and never carries a player name");
        }
    }

    private static async Task ShellWithoutHeadIsServedUnmodifiedAsync()
    {
        const string shell = "<html><body>no head element here</body></html>\n";
        var arrivals = new ConnectionArrivalLog(log: _ => { });
        using var root = new TempSpaRoot(shell);
        await using var server = NewServer(root, arrivals);
        var baseUri = await server.StartAsync();
        using var client = NewClient(baseUri);

        var response = await client.GetAsync("/");
        Assert(await response.Content.ReadAsStringAsync() == shell, "a shell with no recognisable head is served byte-for-byte");
        Assert(CacheControl(response) == "no-store", "…and is still never cached");
        Assert(arrivals.Snapshot().Count == 1, "the arrival is recorded even when no id could be injected");
        Assert(arrivals.Snapshot()[0].VisitId is not null, "the minted id is still recorded, so the gap is visible in the report");
    }

    private static async Task WebSocketArrivalsCarryTheirVisitAsync()
    {
        var arrivals = new ConnectionArrivalLog(log: _ => { });
        using var root = new TempSpaRoot("<html><head></head><body></body></html>");
        await using var server = NewServer(root, arrivals);
        var baseUri = await server.StartAsync();
        using var client = NewClient(baseUri);
        var visit = ConnectionArrivalLog.MintVisitId();

        // A plain GET of /ws (no upgrade headers) is the cheapest way to drive the WebSocket arrival path.
        var refused = await client.GetAsync($"/ws?visit={visit}&watch=1&staticBg=0");
        Assert(refused.StatusCode == HttpStatusCode.BadRequest, "/ws without upgrade headers is refused");
        var recorded = arrivals.Snapshot()[^1];
        Assert(recorded.Path == "/ws" && recorded.Outcome == ConnectionArrivalOutcome.InvalidUpgrade,
            "the refusal is recorded against /ws");
        Assert(recorded.VisitId == visit, "the seat's ?visit= selector is carried onto the arrival");

        await client.GetAsync("/ws?visit=not-a-real-visit-id");
        Assert(arrivals.Snapshot()[^1].VisitId is null, "an untrusted visit selector is dropped rather than recorded");
    }

    private const string MotoUserAgent =
        "Mozilla/5.0 (Linux; Android 14; SM-S928W) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";

    private static CouchCoopBrowserServer NewServer(TempSpaRoot root, ConnectionArrivalLog arrivals)
        => new(new StaticSpaFileProvider(root.Path), new UnusedAssetAdapter(), envelopeFactory: null,
            bindAddress: IPAddress.Loopback, preferredPort: 0, isHeadlessClient: true, log: _ => { }, arrivals: arrivals);

    private static HttpClient NewClient(Uri baseUri)
    {
        var client = new HttpClient { BaseAddress = baseUri };
        client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", MotoUserAgent);
        return client;
    }

    private static string? CacheControl(HttpResponseMessage response)
        => response.Headers.TryGetValues("Cache-Control", out var values) ? string.Join(", ", values) : null;

    private static string? ReadVisit(string html)
    {
        var match = Regex.Match(html, "<meta name=\"couchcoop-visit\" content=\"([^\"]*)\"");
        return match.Success ? match.Groups[1].Value : null;
    }

    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);
    private static string Text(byte[] bytes) => Encoding.UTF8.GetString(bytes);

    private sealed class TempSpaRoot : IDisposable
    {
        public TempSpaRoot(string indexHtml)
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couch-arrival-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
            File.WriteAllText(System.IO.Path.Combine(Path, "index.html"), indexHtml);
        }

        public string Path { get; }

        public void Write(string relativePath, string content)
        {
            var target = System.IO.Path.Combine(Path, relativePath.Replace('/', System.IO.Path.DirectorySeparatorChar));
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target)!);
            File.WriteAllText(target, content);
        }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private sealed class UnusedAssetAdapter : ICouchCoopAssetHttpAdapter
    {
        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
            string opaqueKey, CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("The arrival tests must not request assets.");
    }

    private sealed class FakeTime : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => _timestamp;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddMilliseconds(_timestamp);
        public void Advance(long milliseconds) => _timestamp += milliseconds;
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[ConnectionArrivalLogTests] FAILED: {message}");
    }
}
