using Spirectl.Sts2.Core.Logging;

namespace CouchCoop.Mod.Connections;

/// <summary>Captures only log content appended after a connection attempt began.</summary>
public sealed class ConnectionAttemptLogs
{
    private readonly LogStart _host;
    private readonly LogStart _client;

    private ConnectionAttemptLogs(LogStart host, LogStart client)
    {
        _host = host;
        _client = client;
    }

    public static ConnectionAttemptLogs CaptureStart(string? hostPath, string? clientPath)
        => new(Capture(hostPath), Capture(clientPath));

    public static ConnectionAttemptLogs CaptureAvailable(string? hostPath, string? clientPath)
        => new(new(hostPath, null), new(clientPath, null));

    public Task<IReadOnlyList<ConnectionLogExcerpt>> ReadErrorsAsync()
        => Task.Run<IReadOnlyList<ConnectionLogExcerpt>>(() => [Read("host", _host), Read("client", _client)]);

    private static LogStart Capture(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return new(null, null);
        try
        {
            var info = new FileInfo(path);
            return info.Exists ? new(info.FullName, GodotLogCheckpoint.From(info, info.Length)) : new(info.FullName, null);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return new(path, null);
        }
    }

    private static ConnectionLogExcerpt Read(string source, LogStart start)
    {
        if (start.Path is null) return new(source, "unavailable", "No log path was configured.");
        var result = new GodotLogReader().Read(new GodotLogReadRequest(start.Path, MaxBytes: GodotLogReader.HardMaximumBytes, Checkpoint: start.Checkpoint, ReadTail: true));
        if (result.Unavailable) return new(source, "unavailable", "The log could not be read.");
        var errors = result.Entries.Where(entry => entry.IsError).Select(entry => entry.Text).ToArray();
        var status = string.Join(", ", new[] { result.Rotated ? "rotated" : null, result.Truncated ? "truncated" : null, errors.Length == 0 ? "no-errors" : "errors" }.Where(value => value is not null));
        var text = errors.Length == 0
            ? result.Rotated || result.Truncated ? "No complete post-attempt error context was available." : "No post-attempt errors found."
            : string.Join(Environment.NewLine, errors);
        return new(source, status, text);
    }

    private sealed record LogStart(string? Path, GodotLogCheckpoint? Checkpoint);
}
