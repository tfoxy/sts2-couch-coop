using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Crash-proof reaper for a headless client process. The host normally kills its headless instances
/// itself (<see cref="HeadlessClientManager"/> Release / ReapDetachedSlots / Dispose), but every one of
/// those paths runs HOST code — so a host CRASH (a segfault bypasses Dispose) leaves the headless orphaned:
/// reparented to init/systemd, invisibly running with no display, with the user unaware a game instance is
/// still alive. The host stamps its own PID into <c>COUCHCOOP_HOST_PID</c> when it launches a headless;
/// this watchdog polls that PID and force-terminates THIS process the instant the host is gone.
/// <para>
/// No-op when the env var is absent (e.g. a manually launched headless for testing) or off Linux. The poll
/// is wrapper-agnostic (it watches the host PID directly, not our immediate parent, so a gamescope/headless
/// wrapper in the chain doesn't matter) and PID-reuse-safe (it pins the host's <c>/proc</c> start time).
/// </para>
/// </summary>
internal static class HeadlessHostWatchdog
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
    private static int _started;

    public static void Start()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return;
        }

        var raw = Environment.GetEnvironmentVariable("COUCHCOOP_HOST_PID");
        if (!int.TryParse(raw, out var hostPid) || hostPid <= 1)
        {
            return; // No host PID to watch (manual launch / not spawned by the host) → do nothing.
        }

        if (Interlocked.Exchange(ref _started, 1) != 0)
        {
            return; // Init() can run more than once; arm the watchdog exactly once.
        }

        // Pin the host's start time so a recycled PID — the host died and the kernel handed its number to an
        // unrelated new process — reads as "host gone" rather than falsely "host alive".
        var hostStartTime = TryReadProcStartTime(hostPid);

        var thread = new Thread(() => Watch(hostPid, hostStartTime))
        {
            IsBackground = true,
            Name = "couchcoop-host-watchdog",
        };
        thread.Start();
        Console.Error.WriteLine($"[couch-coop] headless host-watchdog armed for host pid={hostPid}.");
    }

    private static void Watch(int hostPid, string? hostStartTime)
    {
        while (true)
        {
            Thread.Sleep(PollInterval);
            if (HostAlive(hostPid, hostStartTime))
            {
                continue;
            }

            // stderr and godot.log: the per-slot file keeps "the instance just vanished" diagnosable after the
            // process and launcher-side stdio capture are gone (see HeadlessLog).
            HeadlessLog.Write(
                $"[couch-coop] headless host-watchdog: host pid={hostPid} is gone — terminating orphaned headless.");
            // SIGKILL ourselves: the game traps SIGTERM, but SIGKILL is untrappable so the orphan can't linger.
            HeadlessForceExit.Now();
            return;
        }
    }

    private static bool HostAlive(int hostPid, string? expectedStartTime)
    {
        if (!Directory.Exists($"/proc/{hostPid}"))
        {
            return false;
        }

        if (expectedStartTime is null)
        {
            return true; // Couldn't pin a start time at arm — fall back to bare /proc existence.
        }

        var now = TryReadProcStartTime(hostPid);
        // Unreadable now but /proc exists → treat as alive (avoid a false kill); a changed value → PID reused.
        return now is null || now == expectedStartTime;
    }

    // Field 22 (1-based) of /proc/<pid>/stat is the process start time. Field 2 (comm) is parenthesized and may
    // itself contain spaces and parentheses, so split AFTER the last ')': the remaining tokens are fields 3..N,
    // which puts start time at index 19.
    private static string? TryReadProcStartTime(int pid)
    {
        try
        {
            var stat = File.ReadAllText($"/proc/{pid}/stat");
            var close = stat.LastIndexOf(')');
            if (close < 0)
            {
                return null;
            }

            var fields = stat[(close + 1)..].Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return fields.Length > 19 ? fields[19] : null;
        }
        catch
        {
            return null;
        }
    }
}
