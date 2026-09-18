using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Server;

internal static class BrowserLifecycleDiagnosticsTests
{
    public static void Run()
    {
        AcceptsOnlyTheReviewedSchemaAndRedactsTheNonce();
        RejectsUnknownFieldsAndValues();
        EnforcesRequestAndBatchBounds();
        EnforcesRateVisitAndExpiryBounds();
        EnforcesTheProcessFileCap();
        EnforcesCheckpointOrdering();
        CorrelatesServerSocketEventsByVisitOrdinal();
        DoesNotPoolJourneyStateAcrossVisits();
    }

    private static void AcceptsOnlyTheReviewedSchemaAndRedactsTheNonce()
    {
        WithDiagnostics((diagnostics, directory, _, _) =>
        {
            var nonce = Begin(diagnostics);
            var events = """
                [
                  {"t":0,"kind":"lifecycle","state":"load"},
                  {"t":1,"kind":"visibility","state":"visible"},
                  {"t":2,"kind":"viewport","width":390,"height":844},
                  {"t":3,"kind":"orientation","state":"portrait"},
                  {"t":4,"kind":"fullscreen","active":false},
                  {"t":5,"kind":"ws-open","role":"host"},
                  {"t":6,"kind":"ws-open","role":"seat"},
                  {"t":7,"kind":"ws-error","role":"seat","category":"transport"},
                  {"t":8,"kind":"ws-close","role":"host","code":1000,"clean":true},
                  {"t":9,"kind":"error","category":"runtime"},
                  {"t":10,"kind":"scene-received","ordinal":1},
                  {"t":11,"kind":"render-begin","ordinal":1},
                  {"t":12,"kind":"frame-presented","ordinal":1},
                  {"t":13,"kind":"ack-sent","ordinal":1}
                ]
                """;

            Assert(diagnostics.TryAccept(Body(nonce, events)), "the complete reviewed event schema is accepted");
            var persisted = File.ReadAllText(Path.Combine(directory, "browser-lifecycle.jsonl"));
            Assert(!persisted.Contains(nonce, StringComparison.Ordinal), "the page nonce is never persisted");
            Assert(!persisted.Contains("endpoint", StringComparison.Ordinal), "the endpoint is never persisted");
            Assert(persisted.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length == 14,
                "one JSONL record is written for each accepted event");
            Assert(persisted.Contains("\"visit\":1", StringComparison.Ordinal),
                "accepted events carry only the generated visit ordinal");
        });
    }

    private static void RejectsUnknownFieldsAndValues()
    {
        WithDiagnostics((diagnostics, _, _, _) =>
        {
            var nonce = Begin(diagnostics);
            foreach (var forbidden in new[] { "url", "query", "name", "payload", "stack", "userAgent", "token", "message" })
            {
                var events = $"[{{\"t\":0,\"kind\":\"lifecycle\",\"state\":\"load\",\"{forbidden}\":\"secret\"}}]";
                Assert(!diagnostics.TryAccept(Body(nonce, events)), $"the forbidden {forbidden} field is rejected");
            }

            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":0,\"kind\":\"lifecycle\",\"state\":\"resume\"}]")),
                "unknown lifecycle values are rejected");
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":0,\"kind\":\"ws-open\",\"role\":\"spectator\"}]")),
                "unknown socket roles are rejected");
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":0,\"kind\":\"console\",\"state\":\"error\"}]")),
                "unknown event kinds are rejected");
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":0,\"t\":1,\"kind\":\"visibility\",\"state\":\"visible\"}]")),
                "duplicate schema fields are rejected");
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":1800001,\"kind\":\"visibility\",\"state\":\"visible\"}]")),
                "out-of-range relative times are rejected");
        });
    }

    private static void EnforcesRequestAndBatchBounds()
    {
        WithDiagnostics((diagnostics, _, _, _) =>
        {
            var nonce = Begin(diagnostics);
            var baseBody = Body(nonce, "[{\"t\":0,\"kind\":\"visibility\",\"state\":\"visible\"}]");
            var exact = baseBody + new string(' ', BrowserLifecycleDiagnostics.MaximumRequestBytes - Encoding.UTF8.GetByteCount(baseBody));
            Assert(diagnostics.TryAccept(exact), "an exactly 16 KiB request is accepted");
            Assert(!diagnostics.TryAccept(exact + " "), "a request larger than 16 KiB is rejected");
        });

        WithDiagnostics((diagnostics, _, _, _) =>
        {
            var nonce = Begin(diagnostics);
            var thirtyTwo = Enumerable.Repeat("{\"t\":0,\"kind\":\"visibility\",\"state\":\"visible\"}", 32);
            Assert(diagnostics.TryAccept(Body(nonce, $"[{string.Join(',', thirtyTwo)}]")),
                "a 32-event batch is accepted");
        });

        WithDiagnostics((diagnostics, _, _, _) =>
        {
            var nonce = Begin(diagnostics);
            var thirtyThree = Enumerable.Repeat("{\"t\":0,\"kind\":\"visibility\",\"state\":\"visible\"}", 33);
            Assert(!diagnostics.TryAccept(Body(nonce, $"[{string.Join(',', thirtyThree)}]")),
                "a 33-event batch is rejected");
        });
    }

    private static void EnforcesRateVisitAndExpiryBounds()
    {
        WithDiagnostics((diagnostics, _, _, advanceMonotonic) =>
        {
            var nonce = Begin(diagnostics);
            for (var index = 0; index < 8; index++)
                Assert(diagnostics.TryAccept(Body(nonce, "[]")), $"burst batch {index + 1} is accepted");
            Assert(!diagnostics.TryAccept(Body(nonce, "[]")), "the ninth immediate batch is rate limited");
            advanceMonotonic(250);
            Assert(diagnostics.TryAccept(Body(nonce, "[]")), "one token refills after 250 ms");
            for (var index = 9; index < BrowserLifecycleDiagnostics.MaximumBatchesPerVisit; index++)
            {
                advanceMonotonic(250);
                Assert(diagnostics.TryAccept(Body(nonce, "[]")), $"batch {index + 1} is accepted within the visit cap");
            }
            advanceMonotonic(250);
            Assert(!diagnostics.TryAccept(Body(nonce, "[]")), "the seventeenth batch is rejected");
        });

        WithDiagnostics((diagnostics, _, _, _) =>
        {
            for (var index = 0; index < BrowserLifecycleDiagnostics.MaximumVisits; index++)
                Assert(diagnostics.BeginVisitMeta().Length > 0, $"live visit {index + 1} is admitted");
            Assert(diagnostics.BeginVisitMeta().Length == 0, "the 257th live visit is refused");
        });

        WithDiagnostics((diagnostics, _, advanceUtc, _) =>
        {
            var nonce = Begin(diagnostics);
            advanceUtc(TimeSpan.FromMinutes(31));
            Assert(!diagnostics.TryAccept(Body(nonce, "[]")), "an expired visit cannot submit a batch");
            Assert(diagnostics.BeginVisitMeta().Length > 0, "expired visits are pruned before admitting another visit");
        });
    }

    private static void EnforcesTheProcessFileCap()
    {
        var directory = NewDirectory();
        try
        {
            var path = Path.Combine(directory, "browser-lifecycle.jsonl");
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                stream.SetLength(BrowserLifecycleDiagnostics.MaximumFileBytes);
            var diagnostics = new BrowserLifecycleDiagnostics(directory);
            var nonce = Begin(diagnostics);
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":0,\"kind\":\"visibility\",\"state\":\"visible\"}]")),
                "a write that exceeds the 1 MiB process file cap is rejected");
            Assert(new FileInfo(path).Length == BrowserLifecycleDiagnostics.MaximumFileBytes,
                "a rejected capped write leaves the file unchanged");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void EnforcesCheckpointOrdering()
    {
        WithDiagnostics((diagnostics, _, _, _) =>
        {
            var nonce = Begin(diagnostics);
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":0,\"kind\":\"frame-presented\",\"ordinal\":1}]")),
                "a frame cannot precede scene receipt");
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":0,\"kind\":\"scene-received\",\"ordinal\":2}]")),
                "the first checkpoint ordinal must be one");
            Assert(diagnostics.TryAccept(Body(nonce, "[{\"t\":0,\"kind\":\"scene-received\",\"ordinal\":1}]")),
                "scene receipt starts ordinal one");
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":1,\"kind\":\"frame-presented\",\"ordinal\":1}]")),
                "checkpoint stages cannot be skipped");
            Assert(diagnostics.TryAccept(Body(nonce, "[{\"t\":1,\"kind\":\"render-begin\",\"ordinal\":1},{\"t\":2,\"kind\":\"frame-presented\",\"ordinal\":1},{\"t\":3,\"kind\":\"ack-sent\",\"ordinal\":1}]")),
                "the remaining ordered checkpoints are accepted");
            Assert(diagnostics.TryAccept(Body(nonce, "[{\"t\":4,\"kind\":\"scene-received\",\"ordinal\":2},{\"t\":5,\"kind\":\"render-begin\",\"ordinal\":2},{\"t\":6,\"kind\":\"frame-presented\",\"ordinal\":2},{\"t\":7,\"kind\":\"ack-sent\",\"ordinal\":2}]")),
                "the incremental scene uses the next ordinal");
            Assert(!diagnostics.TryAccept(Body(nonce, "[{\"t\":6,\"kind\":\"visibility\",\"state\":\"hidden\"}]")),
                "client-relative time cannot move backwards");

            var summary = JsonSerializer.Serialize(diagnostics.Summary(nonce));
            Assert(summary.Contains("\"sceneAcks\":2", StringComparison.Ordinal), "both acknowledgements reach the summary");
            Assert(summary.Contains("\"presentations\":2", StringComparison.Ordinal), "both presentations reach the summary");
        });
    }

    private static void CorrelatesServerSocketEventsByVisitOrdinal()
    {
        WithDiagnostics((diagnostics, directory, _, advanceMonotonic) =>
        {
            var nonce = Begin(diagnostics);
            diagnostics.RecordSocketEvent(nonce, "host", "open");
            advanceMonotonic(5);
            diagnostics.RecordSocketEvent(nonce, "seat", "open");
            var openSummary = JsonSerializer.Serialize(diagnostics.Summary(nonce));
            Assert(openSummary.Contains("\"hostSocketState\":\"open\"", StringComparison.Ordinal), "the host socket is open");
            Assert(openSummary.Contains("\"seatSocketState\":\"open\"", StringComparison.Ordinal), "the seat socket is open");

            diagnostics.RecordSocketEvent(nonce, "seat", "close", 1001, true);
            var closedSummary = JsonSerializer.Serialize(diagnostics.Summary(nonce));
            Assert(closedSummary.Contains("\"hostSocketState\":\"open\"", StringComparison.Ordinal), "closing the seat keeps the host open");
            Assert(closedSummary.Contains("\"seatSocketState\":\"closed\"", StringComparison.Ordinal), "the seat close is reflected");

            diagnostics.RecordSocketEvent("not-a-nonce", "host", "close");
            var persisted = File.ReadAllText(Path.Combine(directory, "browser-lifecycle.jsonl"));
            Assert(!persisted.Contains(nonce, StringComparison.Ordinal), "server socket records also redact the nonce");
            Assert(persisted.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length == 3,
                "only the three valid server socket transitions are persisted");
            Assert(persisted.Contains("\"visit\":1", StringComparison.Ordinal),
                "server socket transitions correlate through the visit ordinal");
        });
    }

    private static void DoesNotPoolJourneyStateAcrossVisits()
    {
        WithDiagnostics((diagnostics, _, _, _) =>
        {
            var first = Begin(diagnostics);
            var second = Begin(diagnostics);
            Assert(diagnostics.TryAccept(Body(first, "[{\"t\":0,\"kind\":\"scene-received\",\"ordinal\":1},{\"t\":1,\"kind\":\"render-begin\",\"ordinal\":1},{\"t\":2,\"kind\":\"frame-presented\",\"ordinal\":1},{\"t\":3,\"kind\":\"ack-sent\",\"ordinal\":1}]")), "first journey accepts its first frame");
            diagnostics.RecordSocketEvent(first, "host", "open");
            diagnostics.RecordSocketEvent(second, "seat", "open");
            var firstSummary = JsonSerializer.Serialize(diagnostics.Summary(first));
            var secondSummary = JsonSerializer.Serialize(diagnostics.Summary(second));
            Assert(firstSummary.Contains("\"visitOrdinal\":1", StringComparison.Ordinal) && firstSummary.Contains("\"journeyOrdinal\":1", StringComparison.Ordinal) && firstSummary.Contains("\"lastCheckpointOrdinal\":1", StringComparison.Ordinal) && firstSummary.Contains("\"lastCheckpointStage\":4", StringComparison.Ordinal) && firstSummary.Contains("\"presentations\":1", StringComparison.Ordinal) && firstSummary.Contains("\"seatSocketState\":\"unseen\"", StringComparison.Ordinal), "first journey does not inherit another visit's socket");
            Assert(secondSummary.Contains("\"presentations\":0", StringComparison.Ordinal) && secondSummary.Contains("\"hostSocketState\":\"unseen\"", StringComparison.Ordinal), "later visit does not inherit first-frame counters");
            diagnostics.RecordSocketEvent(first, "host", "close");
            Assert(JsonSerializer.Serialize(diagnostics.Summary(first)).Contains("\"journeyValid\":false", StringComparison.Ordinal), "a socket EOF after first frame invalidates the locked journey");
            Assert(JsonSerializer.Serialize(diagnostics.Summary("not-a-nonce")).Contains("\"journeyValid\":false", StringComparison.Ordinal), "an unknown summary nonce fails closed");
        });
    }

    private static void WithDiagnostics(
        Action<BrowserLifecycleDiagnostics, string, Action<TimeSpan>, Action<long>> action)
    {
        var directory = NewDirectory();
        var utc = new DateTimeOffset(2026, 9, 17, 12, 0, 0, TimeSpan.Zero);
        long monotonic = 10_000;
        try
        {
            var diagnostics = new BrowserLifecycleDiagnostics(directory, () => utc, () => monotonic);
            action(diagnostics, directory, delta => utc += delta, delta => monotonic += delta);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string Begin(BrowserLifecycleDiagnostics diagnostics)
    {
        var meta = diagnostics.BeginVisitMeta();
        Assert(meta.Length > 0, "a diagnostic visit is created");
        const string prefix = "content=\"";
        var start = meta.IndexOf(prefix, StringComparison.Ordinal) + prefix.Length;
        var end = meta.IndexOf('"', start);
        var config = Encoding.UTF8.GetString(Convert.FromBase64String(meta[start..end]));
        using var document = JsonDocument.Parse(config);
        var nonce = document.RootElement.GetProperty("nonce").GetString() ?? string.Empty;
        Assert(nonce.Length == 32 && nonce.All(character => char.IsAsciiHexDigitLower(character) || char.IsDigit(character)),
            "the visit nonce is 128-bit lowercase hexadecimal");
        return nonce;
    }

    private static string Body(string nonce, string events) =>
        $"{{\"nonce\":{JsonSerializer.Serialize(nonce)},\"events\":{events}}}";

    private static string NewDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"couchcoop-lifecycle-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"[BrowserLifecycleDiagnosticsTests] FAILED: {label}");
    }
}
