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

            // A seat stopped before it said anything to the host: its startup milestones are the only record of
            // how far it got (still booting, CouchCoop skipped, or CouchCoop loaded and went quiet), so the
            // player's-game excerpt keeps them. The host's excerpt does not — the same lines there are noise.
            var silent = Path.Combine(root, "silent.log");
            var hostSide = Path.Combine(root, "host-side.log");
            File.WriteAllText(silent, "previous seat\n");
            File.WriteAllText(hostSide, "previous host\n");
            var silentLogs = ConnectionAttemptLogs.CaptureStart(hostSide, silent);
            const string Startup =
                "[INFO] Steamworks initialization succeeded!\n"
                + "[INFO] some unrelated startup line\n"
                + "[INFO] Loading assembly DLL /mods/couchcoop/couchcoop.dll\n"
                + "[INFO] [couchcoop] loader-entry\n"
                + "[INFO] [couchcoop] mod-init\n";
            File.AppendAllText(silent, Startup);
            File.AppendAllText(hostSide, Startup);
            var silentRead = await silentLogs.ReadErrorsAsync();
            var silentSeat = silentRead.Single(log => log.Source == "client");
            foreach (var line in new[] { "Steamworks initialization succeeded!", "Loading assembly DLL", "[couchcoop] loader-entry", "[couchcoop] mod-init" })
                Assert(silentSeat.Text.Contains(line, StringComparison.Ordinal), $"seat startup milestone '{line}' reaches the excerpt");
            Assert(!silentSeat.Text.Contains("unrelated startup line", StringComparison.Ordinal),
                "…and an unrelated startup line does not");
            Assert(silentSeat.Status == "no-errors, startup",
                $"…and the status names the startup lines (got '{silentSeat.Status}')");
            var silentHost = silentRead.Single(log => log.Source == "host");
            Assert(silentHost.Status == "no-errors" && !silentHost.Text.Contains("loader-entry", StringComparison.Ordinal),
                $"the host's excerpt keeps none of them (got '{silentHost.Status}')");
            Assert(ConnectionAttemptLogs.IsSeatStartupLine("[INFO] Skipping loading mod couchcoop, it is disabled")
                    && ConnectionAttemptLogs.IsSeatStartupLine("[INFO]  --- RUNNING MODDED! --- Loaded 1 mods (1 total)"),
                "a skipped CouchCoop and the loaded-mod count are milestones too");
        }
        finally { Directory.Delete(root, true); }
    }

    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
}
