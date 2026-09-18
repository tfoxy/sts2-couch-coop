using System.Text.Json;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// The browser's resource census as the host reads it: a complete census renders, an incomplete or out-of-range
/// one is refused whole, and nothing a client sends reaches the rendered line except through a parsed value.
/// </summary>
internal static class ClientVitalsReceiptTests
{
    /// <summary>A well-formed census, as the shipping client sends it. Cases mutate one field off this.</summary>
    private const string Valid = """
    {
      "type": "client-vitals", "attemptId": "a1",
      "stageRequested": "canvas", "stageActive": "dom",
      "dpr": 3.49, "vw": 390, "vh": 844,
      "els": 1204, "canvases": 7, "canvasPx": 18432000,
      "decodedBytes": 214958080, "decodedPages": 62,
      "texBytes": 0, "fxBytes": 0,
      "shaderMode": "static", "particleMode": "off",
      "jsHeapBytes": 0
    }
    """;

    public static void Run()
    {
        var line = Render(Valid);
        Assert(line is not null, "a complete census renders");

        // Every field reaches the line, and the two stage backends arrive as a PAIR: they differ exactly when the
        // canvas backend was asked for and could not be built, which nothing else in the product reports.
        Assert(line!.Contains("stage=canvas->dom", StringComparison.Ordinal), $"stage pair (actual: {line})");
        Assert(line.Contains("dpr=3.49", StringComparison.Ordinal), $"fractional dpr survives (actual: {line})");
        Assert(line.Contains("viewport=390x844", StringComparison.Ordinal), $"viewport (actual: {line})");
        Assert(line.Contains("els=1204", StringComparison.Ordinal), $"element count (actual: {line})");
        Assert(line.Contains("canvases=7", StringComparison.Ordinal), $"canvas count (actual: {line})");
        Assert(line.Contains("canvasPx=18432000", StringComparison.Ordinal), $"canvas pixels (actual: {line})");
        Assert(line.Contains("decodedBytes=214958080", StringComparison.Ordinal), $"decoded bytes (actual: {line})");
        Assert(line.Contains("decodedPages=62", StringComparison.Ordinal), $"decoded pages (actual: {line})");
        Assert(line.Contains("texCap=0", StringComparison.Ordinal), $"texture cap (actual: {line})");
        Assert(line.Contains("fxCap=0", StringComparison.Ordinal), $"fx cap (actual: {line})");
        Assert(line.Contains("shaders=static", StringComparison.Ordinal), $"shader mode (actual: {line})");
        Assert(line.Contains("particles=off", StringComparison.Ordinal), $"particle mode (actual: {line})");
        Assert(line.Contains("jsHeap=0", StringComparison.Ordinal), $"js heap (actual: {line})");

        // A LARGE FIGURE MUST NOT BECOME EXPONENTIAL. The whole value of this line is that a human greps a pasted
        // report for a number; "2.14958E+08" is unsearchable and reads like a different quantity.
        var large = Render(Valid.Replace("214958080", "999000000000", StringComparison.Ordinal));
        Assert(large is not null && large.Contains("decodedBytes=999000000000", StringComparison.Ordinal),
            $"large byte counts stay in full decimal (actual: {large ?? "null"})");

        // REFUSED WHOLE, never partially rendered. A census missing a field or carrying one out of range is not a
        // measurement, and half of one would read like a measurement — which is the one thing this line must not
        // do, because a person who does not own the device is going to trust these numbers.
        Assert(Render(Valid.Replace("\"els\": 1204,", "", StringComparison.Ordinal)) is null, "a missing field refuses the census");
        Assert(Render(Valid.Replace("\"dpr\": 3.49", "\"dpr\": -1", StringComparison.Ordinal)) is null, "a negative number refuses the census");
        Assert(Render(Valid.Replace("\"dpr\": 3.49", "\"dpr\": 64", StringComparison.Ordinal)) is null, "a dpr past its ceiling refuses the census");
        Assert(Render(Valid.Replace("\"canvasPx\": 18432000", "\"canvasPx\": 1e30", StringComparison.Ordinal)) is null, "a pixel total past its ceiling refuses the census");
        Assert(Render(Valid.Replace("\"els\": 1204", "\"els\": \"1204\"", StringComparison.Ordinal)) is null, "a stringified number refuses the census");

        // The two textual fields are matched against closed sets rather than sanitised, so no client string can
        // ever reach the report — including one that merely names a backend we do not have.
        Assert(Render(Valid.Replace("\"stageActive\": \"dom\"", "\"stageActive\": \"webgpu\"", StringComparison.Ordinal)) is null,
            "an unknown stage backend refuses the census");
        Assert(Render(Valid.Replace("\"shaderMode\": \"static\"", "\"shaderMode\": \"https://evil.example/x\"", StringComparison.Ordinal)) is null,
            "an arbitrary string in an enum field refuses the census");

        // NaN and infinity cannot be written in JSON, so the guard that matters is the one against a literal that
        // parses as a number but is not a quantity. Covered by the ceilings above; this pins the non-object case.
        Assert(Render("[]") is null, "a non-object payload refuses the census");
        Assert(Render("{}") is null, "an empty object refuses the census");

        LastCensusBeforeTheBrowserDiedReachesTheReport();
    }

    /// <summary>
    /// The end-to-end reason this exists: a browser that is killed sends nothing as it dies, so the report has to
    /// carry the census taken while it was still alive — and the LATEST one, not the first.
    /// </summary>
    private static void LastCensusBeforeTheBrowserDiedReachesTheReport()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var id = Guid.NewGuid();
        registry.Connected(id, "iPhone iOS 18.5 · Safari 18.5");
        registry.BeginAttempt(id);

        using var early = JsonDocument.Parse(Valid);
        registry.RecordDiagnostic(id, ClientVitalsReceipt.FactKey, ClientVitalsReceipt.Render(early.RootElement));
        using var late = JsonDocument.Parse(Valid.Replace("\"canvasPx\": 18432000", "\"canvasPx\": 41287680", StringComparison.Ordinal));
        registry.RecordDiagnostic(id, ClientVitalsReceipt.FactKey, ClientVitalsReceipt.Render(late.RootElement));

        // The socket vanishing without a close frame — the shape of the reported iPhone failure.
        registry.Fail(id, "browser-transport-lost", "The browser connection ended unexpectedly.",
            "Check this device's network connection and reload the browser tab.", "ThrowEOFUnexpected");

        var report = registry.BuildReport(id)!;
        Assert(report.Contains("clientVitals:", StringComparison.Ordinal),
            $"the census is printed in the report under its own key (actual: {report})");
        Assert(report.Contains("canvasPx=41287680", StringComparison.Ordinal),
            "the LAST census before the failure is the one the report carries");
        Assert(!report.Contains("canvasPx=18432000", StringComparison.Ordinal),
            "…and it replaces the earlier one rather than accumulating");
    }

    private sealed class FakeTime : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => _timestamp;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddMilliseconds(_timestamp);
    }

    private static string? Render(string json)
    {
        using var document = JsonDocument.Parse(json);
        return ClientVitalsReceipt.Render(document.RootElement);
    }

    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
}
