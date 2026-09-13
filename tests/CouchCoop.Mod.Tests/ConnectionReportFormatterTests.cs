using System.Text;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionReportFormatterTests
{
    public static Task Run()
    {
        IncludesReadableDetailAndLogs();
        RedactsSecretsAndHomes();
        KeepsBothLogSourcesVisible();
        CapsUtf8AtRuneBoundary();
        return Task.CompletedTask;
    }

    private static void IncludesReadableDetailAndLogs()
    {
        var report = ConnectionReportFormatter.Format(new ConnectionReportContent
        {
            Summary = "Native join failed", Action = "Retry after checking the host.", Detail = "native code 17\nsecond line",
            Facts = new Dictionary<string, string> { ["gameVersion"] = "1.0", ["transport"] = "loopback HTTP" },
            RecordedAtUtc = DateTimeOffset.UnixEpoch, Outcome = ConnectionIssueOutcome.Failed,
            StageElapsedMs = 42,
            Logs = [new ConnectionLogExcerpt("client", "error", "line one\nline two")]
        });
        Assert(report.Contains("next action: Retry", StringComparison.Ordinal), "action first");
        Assert(report.Contains("native code 17\nsecond line", StringComparison.Ordinal), "multiline cause preserved");
        Assert(report.Contains("[ client godot.log / error ]", StringComparison.Ordinal), "log label retained");
        Assert(report.Contains("[ host godot.log / unavailable ]", StringComparison.Ordinal), "missing host log explicit");
        Assert(report.Contains("concurrent host errors may be unrelated", StringComparison.Ordinal), "log caveat retained");
        Assert(report.Contains("modVersion: unknown", StringComparison.Ordinal), "missing facts are explicit");
        Assert(report.Contains("recorded: 1970-01-01T00:00:00.0000000+00:00", StringComparison.Ordinal)
            && report.Contains("stage elapsed: 42 ms", StringComparison.Ordinal) && report.Contains("outcome: failed", StringComparison.Ordinal),
            "recording time, stage duration, and outcome are reported plainly");
    }

    private static void KeepsBothLogSourcesVisible()
    {
        var report = ConnectionReportFormatter.Format(new ConnectionReportContent
        {
            Facts = new Dictionary<string, string> { ["large diagnostic"] = new string('x', 65536) },
            Logs = [new("host", "errors", new string('漢', 30000)), new("client", "errors", "ERROR: client cause")]
        });
        Assert(report.Contains("[log excerpt truncated]", StringComparison.Ordinal), "large host excerpt marked");
        Assert(report.Contains("[ client godot.log / errors ]", StringComparison.Ordinal)
            && report.Contains("ERROR: client cause", StringComparison.Ordinal), "host errors cannot hide affected-client evidence");
    }

    private static void RedactsSecretsAndHomes()
    {
        var report = ConnectionReportFormatter.Format(new ConnectionReportContent
        {
            Detail = "Authorization: Bearer abc /home/alice/.local?token=secret COUCHCOOP_CHILD_TOKEN=value"
        });
        Assert(!report.Contains("abc", StringComparison.Ordinal) && !report.Contains("secret", StringComparison.Ordinal) && !report.Contains("value", StringComparison.Ordinal), "secrets redacted");
        Assert(report.Contains("<user-home>", StringComparison.Ordinal), "home redacted");
    }

    private static void CapsUtf8AtRuneBoundary()
    {
        var report = ConnectionReportFormatter.Format(new ConnectionReportContent { Detail = string.Concat(Enumerable.Repeat("😀漢", 50000)) });
        Assert(Encoding.UTF8.GetByteCount(report) <= ConnectionReportFormatter.MaximumUtf8Bytes, "UTF-8 cap");
        Assert(report.Contains("[detail truncated]", StringComparison.Ordinal), "truncation marker");
        Assert(!report.Contains("\uFFFD", StringComparison.Ordinal), "surrogate not split");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
