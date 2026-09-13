using System.Text;
using System.Text.RegularExpressions;

namespace CouchCoop.Mod.Connections;

public sealed record ConnectionLogExcerpt(string Source, string Status, string Text);

public sealed record ConnectionReportContent
{
    public Guid ReportId { get; init; }
    public Guid ClientId { get; init; }
    public string? DeviceLabel { get; init; }
    public string? PlayerName { get; init; }
    public string? Stage { get; init; }
    public string? IssueCode { get; init; }
    public string? Summary { get; init; }
    public string? Action { get; init; }
    public string? Detail { get; init; }
    public int Step { get; init; }
    public int Total { get; init; }
    public DateTimeOffset StartedAtUtc { get; init; }
    public long ElapsedMs { get; init; }
    public long StageElapsedMs { get; init; }
    public DateTimeOffset RecordedAtUtc { get; init; }
    public ConnectionIssueOutcome? Outcome { get; init; }
    public IReadOnlyList<string> Timeline { get; init; } = [];
    public IReadOnlyDictionary<string, string> Facts { get; init; } = new Dictionary<string, string>();
    public IReadOnlyList<ConnectionLogExcerpt> Logs { get; init; } = [];
}

public static partial class ConnectionReportFormatter
{
    public const int MaximumUtf8Bytes = 64 * 1024;
    public const string TruncationMarker = "\n[report truncated at 64 KiB]\n";

    [GeneratedRegex("(?i)(?:bearer\\s+|authorization\\s*[:=]?\\s*(?:bearer\\s+)?)\\S+")]
    private static partial Regex Authorization();
    [GeneratedRegex("(?i)(COUCHCOOP_[A-Z0-9_]*TOKEN)\\s*=\\s*[^\\s,;]+")]
    private static partial Regex EnvironmentToken();
    [GeneratedRegex("(?i)([?&](?:token|access_token|auth)=)[^&#\\s]+")]
    private static partial Regex QueryToken();
    [GeneratedRegex("(?i)(?:/home/[^/\\s]+|/Users/[^/\\s]+|[A-Z]:\\\\Users\\\\[^\\\\/\\s]+)")]
    private static partial Regex UserDirectory();

    public static string Format(ConnectionReportContent content)
    {
        ArgumentNullException.ThrowIfNull(content);
        var text = new StringBuilder();
        text.AppendLine("CouchCoop connection report");
        Line(text, "summary", Value(content.Summary));
        Line(text, "device", Value(content.DeviceLabel));
        Line(text, "player", Value(content.PlayerName));
        Line(text, "stage", Value(content.Stage));
        Line(text, "issue", Value(content.IssueCode));
        Line(text, "next action", Value(content.Action));
        if (!string.IsNullOrWhiteSpace(content.Detail)) Block(text, "detail", TruncateUtf8(content.Detail, 8 * 1024, "\n[detail truncated]\n"));

        Line(text, "report id", content.ReportId == Guid.Empty ? "unknown" : content.ReportId.ToString("N"));
        Line(text, "client id", content.ClientId == Guid.Empty ? "unknown" : content.ClientId.ToString("N"));
        Line(text, "started", content.StartedAtUtc == default ? "unknown" : content.StartedAtUtc.ToUniversalTime().ToString("O"));
        Line(text, "recorded", content.RecordedAtUtc == default ? "unknown" : content.RecordedAtUtc.ToUniversalTime().ToString("O"));
        Line(text, "elapsed", content.ElapsedMs < 0 ? "unknown" : $"{content.ElapsedMs} ms");
        Line(text, "stage elapsed", content.StageElapsedMs < 0 ? "unknown" : $"{content.StageElapsedMs} ms");
        Line(text, "outcome", content.Outcome?.ToString().ToLowerInvariant() ?? "unknown");
        Line(text, "progress", content.Total > 0 ? $"{content.Step}/{content.Total}" : "unknown");

        foreach (var key in new[] { "gameVersion", "modVersion", "hostOS", "transport", "process", "cleanup" })
            Line(text, key, content.Facts.TryGetValue(key, out var value) ? Value(value) : "unknown");
        foreach (var pair in content.Facts.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            if (!new[] { "gameVersion", "modVersion", "hostOS", "transport", "process", "cleanup" }.Contains(pair.Key, StringComparer.Ordinal))
                Line(text, pair.Key, Value(pair.Value));

        if (content.Timeline.Count > 0)
        {
            text.AppendLine("timeline:");
            foreach (var item in content.Timeline) text.Append("- ").AppendLine(Sanitize(item));
        }
        // Reserve space for both log sources even when diagnostic fields are unusually large.
        text = new StringBuilder(TruncateUtf8(text.ToString(), 30 * 1024, "\n[diagnostic fields truncated]\n"));
        text.AppendLine("logs: concurrent host errors may be unrelated.");
        foreach (var source in new[] { "host", "client" })
        {
            var log = content.Logs.FirstOrDefault(log => log.Source == source)
                ?? new ConnectionLogExcerpt(source, "unavailable", "Log details have not been captured for this report.");
            text.Append("[ ").Append(source).Append(" godot.log / ").Append(Value(log.Status)).AppendLine(" ]");
            text.AppendLine(TruncateUtf8(Sanitize(log.Text), 16 * 1024, "\n[log excerpt truncated]\n"));
        }
        return TruncateUtf8(text.ToString());
    }

    private static void Line(StringBuilder text, string label, string value) => text.Append(label).Append(": ").AppendLine(Sanitize(value));
    private static void Block(StringBuilder text, string label, string value) { text.Append(label).AppendLine(":"); text.AppendLine(Sanitize(value)); }
    private static string Value(string? value) => string.IsNullOrWhiteSpace(value) ? "unknown" : value;
    public static string SanitizeDiagnostic(string? value) => Sanitize(value);

    private static string Sanitize(string? value)
    {
        var result = Value(value);
        result = Authorization().Replace(result, "[redacted authorization]");
        result = EnvironmentToken().Replace(result, "$1=[redacted]");
        result = QueryToken().Replace(result, "$1[redacted]");
        return UserDirectory().Replace(result, "<user-home>");
    }

    private static string TruncateUtf8(string value, int maximumBytes = MaximumUtf8Bytes, string marker = TruncationMarker)
    {
        if (Encoding.UTF8.GetByteCount(value) <= maximumBytes) return value;
        var markerBytes = Encoding.UTF8.GetByteCount(marker);
        var budget = maximumBytes - markerBytes;
        var builder = new StringBuilder();
        var bytes = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            var size = rune.Utf8SequenceLength;
            if (bytes + size > budget) break;
            builder.Append(rune);
            bytes += size;
        }
        return builder.Append(marker).ToString();
    }
}
