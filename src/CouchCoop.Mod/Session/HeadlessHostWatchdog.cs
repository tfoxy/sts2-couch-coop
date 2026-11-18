using System.Diagnostics;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;
using CouchCoop.Mod.Patches;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Crash-proof reaper for a headless client process. The host normally kills its headless instances
/// itself (<see cref="HeadlessClientManager"/> Release / ReapDetachedSlots / Dispose), but every one of
/// those paths runs HOST code — so a host CRASH (a segfault bypasses Dispose) leaves the headless orphaned:
/// reparented to init/systemd, invisibly running with no display, with the user unaware a game instance is
/// still alive. The host stamps its own PID into <c>COUCHCOOP_HOST_PID</c> when it launches a headless;
/// this watchdog watches that PID and starts the seat's bounded exit when the host is gone; SIGKILL is the fallback.
/// <para>
/// No-op when the env var is absent (e.g. a manually launched headless for testing) or on a platform with
/// no supported watch below. The watch is wrapper-agnostic (it watches the host PID directly, not our immediate
/// parent, so a gamescope/headless wrapper in the chain doesn't matter) and checks process identity
/// while arming to guard against PID reuse.
/// </para>
/// <para>
/// Windows waits on a pinned kernel process handle, Linux on a pidfd, and macOS on a kqueue process event.
/// Linux identity is field 22 of <c>/proc/&lt;pid&gt;/stat</c> (boot-relative jiffies): .NET's
/// <see cref="Process.StartTime"/> is reconstructed from boot time there and is not stable enough to compare
/// across processes. macOS has no <c>/proc</c>; its <see cref="Process.StartTime"/> is an absolute kernel
/// wall-clock value (<c>kp_proc.p_starttime</c>) and therefore sound. The two-second poll remains only as
/// the fallback when a Unix kernel wait is unavailable or fails.
/// </para>
/// </summary>
internal static class HeadlessHostWatchdog
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
    internal static readonly TimeSpan HardKillDelay = HeadlessDisconnectExitSequence.ForceExitDelay + TimeSpan.FromSeconds(2);
    private static int _started;
    private static IDisposable? _windowsWatch;

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
        if (!onLinux && !onMacOs && !OperatingSystem.IsWindows())
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

        if (OperatingSystem.IsWindows())
        {
            _windowsWatch = ArmWindowsHostWatch(hostPid, RegisterWindowsHostWait,
                () => OnHostGone(hostPid, HeadlessDisconnectExitPatch.RequestExit,
                    ScheduleOnBackgroundThread, HeadlessForceExit.Now, HeadlessLog.Write), HeadlessLog.Write);
            if (_windowsWatch is not null)
                CouchCoopLog.Stderr($"headless host-watchdog armed for host pid={hostPid} (Windows process wait).");
            return;
        }

        var arm = HostExitWait.Arm(hostPid);
        var fired = 0;
        void Gone()
        {
            if (Interlocked.Exchange(ref fired, 1) == 0)
                OnHostGone(hostPid, HeadlessDisconnectExitPatch.RequestExit,
                    ScheduleOnBackgroundThread, HeadlessForceExit.Now, HeadlessLog.Write);
        }
        void PollFallback(string reason)
        {
            CouchCoopLog.Stderr($"headless host-watchdog armed for host pid={hostPid} (poll fallback: {reason}).");
            var thread = new Thread(() => Watch(hostPid, arm.Identity, onLinux))
            {
                IsBackground = true,
                Name = "couchcoop-host-watchdog",
            };
            thread.Start();
        }

        switch (arm.Kind)
        {
            case HostExitWait.ArmKind.Wait:
                CouchCoopLog.Stderr($"headless host-watchdog armed for host pid={hostPid} ({HostExitWait.PathName} wait).");
                HostExitWait.StartWait(arm.Handle, Gone, reason => PollFallback($"{HostExitWait.PathName} {reason}"));
                break;
            case HostExitWait.ArmKind.HostGone:
                CouchCoopLog.Stderr($"headless host-watchdog armed for host pid={hostPid} (host already gone at arm: {arm.Reason}).");
                Gone();
                break;
            case HostExitWait.ArmKind.Fallback:
                PollFallback(arm.Reason!);
                break;
        }
    }

    internal static IDisposable? ArmWindowsHostWatch(int hostPid,
        Func<int, Action, IDisposable> register, Action hostGone, Action<string> log)
    {
        var fired = 0;
        void Gone()
        {
            if (Interlocked.Exchange(ref fired, 1) == 0) hostGone();
        }
        try { return register(hostPid, Gone); }
        catch (Win32Exception exception) when (exception.NativeErrorCode == 87)
        {
            // OpenProcess reports ERROR_INVALID_PARAMETER when the host has already disappeared.
            Gone();
        }
        catch (Exception exception)
        {
            // Access denied does not establish death. The host's job still covers assigned seats.
            log("headless Windows host-watch unavailable: " + exception.Message);
        }
        return null;
    }

    private static IDisposable RegisterWindowsHostWait(int hostPid, Action hostGone)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var handle = OpenProcess(0x00100000, false, hostPid); // SYNCHRONIZE only
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        var wait = new HostProcessWait(handle);
        try
        {
            var registration = ThreadPool.RegisterWaitForSingleObject(wait, (_, _) => hostGone(), null,
                Timeout.Infinite, executeOnlyOnce: true);
            return new WindowsHostRegistration(wait, registration);
        }
        catch { wait.Dispose(); throw; }
    }

    private sealed class HostProcessWait : WaitHandle
    {
        internal HostProcessWait(SafeWaitHandle handle) => SafeWaitHandle = handle;
    }

    private sealed class WindowsHostRegistration(WaitHandle wait, RegisteredWaitHandle registration) : IDisposable
    {
        public void Dispose()
        {
            registration.Unregister(null);
            wait.Dispose();
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle OpenProcess(uint access,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);

    // Fallback-only polling, explicitly retained for unavailable or failed kernel waits.
    private static void Watch(int hostPid, string? hostStartTime, bool onLinux)
    {
        while (true)
        {
            Thread.Sleep(PollInterval);
            if (onLinux
                ? HostAlive(hostPid, hostStartTime)
                : HostAliveByIdentity(hostStartTime, () => ProcessSignalAlive(hostPid), () => HostExitWait.TryReadKernelStartTime(hostPid)))
            {
                continue;
            }

            OnHostGone(hostPid, HeadlessDisconnectExitPatch.RequestExit,
                ScheduleOnBackgroundThread, HeadlessForceExit.Now, HeadlessLog.Write);
            return;
        }
    }

    internal static void OnHostGone(int hostPid, Func<string, bool> requestExit,
        Action<TimeSpan, Action> schedule, Action forceExit, Action<string> log)
    {
        log($"headless host-watchdog: host pid={hostPid} is gone — starting the seat's exit sequence.");
        bool started;
        try { started = requestExit("host-process-gone"); }
        catch { started = false; }
        if (!started)
        {
            log("headless host-watchdog: no exit sequence to run — terminating now.");
            forceExit();
            return;
        }

        schedule(HardKillDelay, () =>
        {
            log("headless host-watchdog: exit sequence did not end the process — terminating.");
            forceExit();
        });
    }

    private static void ScheduleOnBackgroundThread(TimeSpan delay, Action action)
    {
        var thread = new Thread(() =>
        {
            Thread.Sleep(delay);
            action();
        })
        {
            IsBackground = true,
            Name = "couchcoop-host-watchdog-exit",
        };
        thread.Start();
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

        var now = HostExitWait.TryReadProcStartTime(hostPid);
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

}
