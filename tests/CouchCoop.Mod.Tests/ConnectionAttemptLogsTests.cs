using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionAttemptLogsTests
{
    public static async Task Run()
    {
        var root = Path.Combine(Path.GetTempPath(), "couch-attempt-logs-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            var host = Path.Combine(root, "host.log");
            var child = Path.Combine(root, "child.log");
            File.WriteAllText(host, "old error\n");
            var logs = ConnectionAttemptLogs.CaptureStart(host, child);
            File.AppendAllText(host, "[12] [ERROR] failed join\n  at join()\n");
            var result = await logs.ReadErrorsAsync();
            var hostResult = result.Single(log => log.Source == "host");
            Assert(hostResult.Status == "errors" && hostResult.Text.Contains("at join()", StringComparison.Ordinal), "post-start multiline error captured");
            Assert(result.Single(log => log.Source == "client").Status == "unavailable", "missing client status explicit");

            // The join handshake's own lines are kept although they are not errors: when the host's game refuses a
            // player's game at the handshake they are the only record of what the two sides compared. Other
            // informational lines stay out.
            var seat = Path.Combine(root, "seat.log");
            File.WriteAllText(seat, "before the attempt\n");
            var seatLogs = ConnectionAttemptLogs.CaptureStart(null, seat);
            File.AppendAllText(seat,
                "[INFO] some unrelated startup line\n"
                + "[WARN] [HandshakeManager] comparison line\n"
                + "[INFO] [HandshakeManager] outcome line\n");
            var seatResult = (await seatLogs.ReadErrorsAsync()).Single(log => log.Source == "client");
            Assert(seatResult.Text.Contains("[WARN] [HandshakeManager] comparison line", StringComparison.Ordinal)
                    && seatResult.Text.Contains("[INFO] [HandshakeManager] outcome line", StringComparison.Ordinal),
                "handshake lines reach the excerpt");
            Assert(!seatResult.Text.Contains("unrelated startup line", StringComparison.Ordinal),
                "…and nothing else that is not an error does");
            Assert(seatResult.Status == "no-errors, handshake",
                $"…and the status says the excerpt holds handshake lines and no errors (got '{seatResult.Status}')");
        }
        finally { Directory.Delete(root, true); }
    }

    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
}
