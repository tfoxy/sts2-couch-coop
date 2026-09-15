using System.Diagnostics;
using System.Globalization;
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
/// No-op when the env var is absent (e.g. a manually launched headless for testing) or on a platform with
/// neither probe below. The poll is wrapper-agnostic (it watches the host PID directly, not our immediate
/// parent, so a gamescope/headless wrapper in the chain doesn't matter) and PID-reuse-safe (it pins an
/// identity for the host process and re-checks it).
/// </para>
/// <para>
/// TWO IMPLEMENTATIONS, on purpose. <b>Linux</b> reads <c>/proc</c> for both liveness and identity and is
/// untouched — it is the path that ships and is proven, and its identity (field 22 of <c>/proc/&lt;pid&gt;/stat</c>,
/// boot-relative jiffies) is the only one that is reliable there: .NET's <see cref="Process.StartTime"/> is
/// reconstructed from boot time on Linux and is not stable enough to compare across processes.
/// <b>macOS</b> has no <c>/proc</c> at all, which is why this used to return early and leave every seat
/// unreaped — a host crash there strands N windowless game processes with no Dock icon and no window, alive
/// until the user finds them in Activity Monitor. It asks <c>kill(pid, 0)</c> for liveness and
/// <see cref="Process.StartTime"/> for identity, which on macOS is an absolute kernel wall-clock value
/// (<c>kp_proc.p_starttime</c>) and therefore sound.
/// </para>
/// </summary>
internal static class HeadlessHostWatchdog
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
    private static int _started;

    /// <summary>"No such process" — the ONLY <c>kill</c> error that means the pid is dead.</summary>
    private const int ESRCH = 3;

    /// <summary>
    /// Signal 0 delivers nothing and only asks whether the pid exists and may be signalled. Declared here
    /// rather than shared with <see cref="OsHeadlessProcess"/>'s copy so neither file's signal handling can
    /// be changed by an edit aimed at the other.
    /// </summary>
    [DllImport("libc", SetLastError = true)]
    private static extern int kill(int pid, int sig);

    public static void Start()
    {
        var onLinux = RuntimeInformation.IsOSPlatform(OSPlatform.Linux);
        var onMacOs = RuntimeInformation.IsOSPlatform(OSPlatform.OSX);
        if (!onLinux && !onMacOs)
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
        var hostStartTime = onLinux ? TryReadProcStartTime(hostPid) : TryReadKernelStartTime(hostPid);

        var thread = new Thread(() => Watch(hostPid, hostStartTime, onLinux))
        {
            IsBackground = true,
            Name = "couchcoop-host-watchdog",
        };
        thread.Start();
        Console.Error.WriteLine($"[couch-coop] headless host-watchdog armed for host pid={hostPid}.");
    }

    private static void Watch(int hostPid, string? hostStartTime, bool onLinux)
    {
        while (true)
        {
            Thread.Sleep(PollInterval);
            if (onLinux
                ? HostAlive(hostPid, hostStartTime)
                : HostAliveByIdentity(hostStartTime, () => ProcessSignalAlive(hostPid), () => TryReadKernelStartTime(hostPid)))
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

    // LINUX ONLY, and deliberately left exactly as it shipped.
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

    /// <summary>
    /// The same rule as <see cref="HostAlive"/>, over injected probes, for a platform with no <c>/proc</c>.
    /// Both probes are parameters so the decision is testable without a second process to kill: this is the
    /// code path whose only possible mistake — deciding a LIVE host is gone — SIGKILLs a healthy seat.
    /// </summary>
    /// <param name="expectedIdentity">What the host's start time read as when the watchdog was armed.</param>
    /// <param name="alive">Does a process with that pid exist at all?</param>
    /// <param name="readIdentity">Its start time now, or null when it could not be read.</param>
    internal static bool HostAliveByIdentity(string? expectedIdentity, Func<bool> alive, Func<string?> readIdentity)
    {
        if (!alive())
        {
            return false;
        }

        if (expectedIdentity is null)
        {
            return true; // Couldn't pin an identity at arm — fall back to bare existence.
        }

        var now = readIdentity();
        // Unreadable now but the pid exists → treat as alive (avoid a false kill); a changed value → PID reused.
        return now is null || string.Equals(now, expectedIdentity, StringComparison.Ordinal);
    }

    /// <summary>
    /// Does <paramref name="pid"/> name a live process? <c>kill(pid, 0)</c> delivers no signal and answers
    /// exactly that question.
    /// </summary>
    /// <remarks>
    /// Only <c>ESRCH</c> is death. <c>EPERM</c> means the pid IS taken by a live process this one may not
    /// signal, and every other errno means the question was not answered — reporting either as "gone" would
    /// make the watchdog SIGKILL a seat whose host is running.
    /// </remarks>
    private static bool ProcessSignalAlive(int pid)
    {
        try
        {
            return kill(pid, 0) == 0 || Marshal.GetLastPInvokeError() != ESRCH;
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException)
        {
            return true; // No libc to ask. An unanswered question must never be read as a dead host.
        }
    }

    /// <summary>
    /// The host process's start time as a comparable string, for the platforms where .NET reports an absolute
    /// kernel timestamp (macOS: <c>kp_proc.p_starttime</c> via sysctl).
    /// </summary>
    /// <remarks>
    /// NOT used on Linux, where <see cref="Process.StartTime"/> is reconstructed from boot time and two reads
    /// of the same process are not reliably equal — the reason the Linux path reads <c>/proc</c> directly.
    /// </remarks>
    private static string? TryReadKernelStartTime(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        }
        catch
        {
            return null;
        }
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
