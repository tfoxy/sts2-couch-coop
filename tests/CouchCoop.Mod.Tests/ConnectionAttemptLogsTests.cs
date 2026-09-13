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
        }
        finally { Directory.Delete(root, true); }
    }

    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
}
