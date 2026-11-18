using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>Arms a process exit wait without depending on the game runtime.</summary>
internal static class HostExitWait
{
    internal enum ArmKind { Wait, HostGone, Fallback }

    internal readonly record struct ArmResult(ArmKind Kind, int Handle = -1, int Errno = 0,
        string? Reason = null, string? Identity = null);

    private const int ESRCH = 3;
    private const int EINTR = 4;

    internal static string PathName => OperatingSystem.IsLinux() ? "pidfd" : "kqueue";

    // The "host started after the seat" check runs on Linux only: /proc start ticks count from boot and never
    // step, while macOS start times are wall-clock, so a backward clock step between host and seat start could
    // read a live host as newer than its seat. macOS still rejects a pid reused during arm by the identity
    // re-read in Decide.
    internal static ArmResult Arm(int pid) => Arm(pid, OperatingSystem.IsLinux()
        ? TryReadProcStartTime(Environment.ProcessId) : null);

    internal static ArmResult Arm(int pid, string? selfIdentity)
    {
        Func<int, string?> readIdentity = OperatingSystem.IsLinux()
            ? TryReadProcStartTime : TryReadKernelStartTime;
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
            return new(ArmKind.Fallback, Reason: "unsupported platform");
        var result = Decide(pid, OperatingSystem.IsLinux() ? OpenLinux : OpenMacOs, Close,
            readIdentity, selfIdentity, CompareIdentity);
        return result.Kind == ArmKind.Fallback
            ? result with { Reason = $"{(OperatingSystem.IsLinux() ? "pidfd_open" : "kqueue")} errno={result.Errno}" }
            : result;
    }

    internal static ArmResult Decide(int pid, Func<int, (int Handle, int Errno)> open, Action<int> close,
        Func<int, string?> readIdentity, string? selfIdentity, Func<string, string, int> compareIdentity)
    {
        var before = readIdentity(pid);
        var (handle, errno) = open(pid);
        if (handle < 0)
        {
            return errno == ESRCH
                ? new(ArmKind.HostGone, Reason: "no such process", Identity: before)
                : new(ArmKind.Fallback, Errno: errno, Reason: $"open errno={errno}", Identity: before);
        }

        var after = readIdentity(pid);
        if (before is not null && after is not null && before != after)
        {
            close(handle);
            return new(ArmKind.HostGone, Reason: "host identity changed during arm");
        }

        var identity = after ?? before;
        if (identity is not null && selfIdentity is not null && compareIdentity(identity, selfIdentity) > 0)
        {
            close(handle);
            return new(ArmKind.HostGone, Reason: "host started after the seat");
        }

        return new(ArmKind.Wait, handle, Identity: identity);
    }

    internal static int CompareIdentity(string host, string self) =>
        ulong.TryParse(host, NumberStyles.None, CultureInfo.InvariantCulture, out var hostStart)
        && ulong.TryParse(self, NumberStyles.None, CultureInfo.InvariantCulture, out var selfStart)
            ? hostStart.CompareTo(selfStart) : 0;

    internal static void StartWait(int handle, Action hostGone, Action<string> fallback)
    {
        var thread = new Thread(() => RunWait(handle, OperatingSystem.IsLinux() ? WaitLinux : WaitMacOs,
            Close, hostGone, fallback))
        {
            IsBackground = true,
            Name = "couchcoop-host-watchdog",
        };
        thread.Start();
    }

    // Only interrupted syscalls restart. An unanswered wait must never kill a healthy seat.
    internal static void RunWait(int handle, Func<int, (bool Ready, int Errno)> wait, Action<int> close,
        Action hostGone, Action<string> fallback)
    {
        (bool Ready, int Errno) result;
        try
        {
            do { result = wait(handle); }
            while (!result.Ready && result.Errno == EINTR);
        }
        finally { close(handle); }

        if (result.Ready) hostGone();
        else fallback(result.Errno == 0 ? "wait returned no exit event" : $"wait errno={result.Errno}");
    }

    private static (int Handle, int Errno) OpenLinux(int pid)
    {
        var handle = syscall(434, pid, 0u); // pidfd_open on x86_64 and arm64
        return handle < 0 ? (-1, Marshal.GetLastPInvokeError()) : ((int)handle, 0);
    }

    private static (bool Ready, int Errno) WaitLinux(int handle)
    {
        var descriptor = new PollFd { Fd = handle, Events = 1 }; // POLLIN
        var count = poll(ref descriptor, 1, -1);
        return count < 0 ? (false, Marshal.GetLastPInvokeError())
            : (count > 0 && (descriptor.ReturnedEvents & 1) != 0, 0);
    }

    private static (int Handle, int Errno) OpenMacOs(int pid)
    {
        var handle = kqueue();
        if (handle < 0) return (-1, Marshal.GetLastPInvokeError());
        var change = new KEvent
        {
            Ident = (nuint)pid,
            Filter = -5, // EVFILT_PROC
            Flags = 0x1 | 0x10, // EV_ADD | EV_ONESHOT
            FilterFlags = 0x80000000, // NOTE_EXIT
        };
        if (RegisterKEvent(handle, ref change, 1, IntPtr.Zero, 0, IntPtr.Zero) < 0)
        {
            var errno = Marshal.GetLastPInvokeError();
            Close(handle);
            return (-1, errno);
        }
        return (handle, 0);
    }

    private static (bool Ready, int Errno) WaitMacOs(int handle)
    {
        var count = WaitKEvent(handle, IntPtr.Zero, 0, out var ev, 1, IntPtr.Zero);
        if (count < 0) return (false, Marshal.GetLastPInvokeError());
        if (count > 0 && (ev.Flags & 0x4000) != 0) return (false, (int)ev.Data); // EV_ERROR
        return (count > 0 && ev.Filter == -5 && (ev.FilterFlags & 0x80000000) != 0, 0);
    }

    // 64-bit Darwin's struct kevent, shared with the game-free ABI layout check.
    [StructLayout(LayoutKind.Sequential)]
    internal struct KEvent
    {
        internal nuint Ident;
        internal short Filter;
        internal ushort Flags;
        internal uint FilterFlags;
        internal nint Data;
        internal nint UserData;
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int kqueue();

    [DllImport("libc", EntryPoint = "kevent", SetLastError = true)]
    private static extern int RegisterKEvent(int queue, ref KEvent changes, int changeCount,
        IntPtr events, int eventCount, IntPtr timeout);

    [DllImport("libc", EntryPoint = "kevent", SetLastError = true)]
    private static extern int WaitKEvent(int queue, IntPtr changes, int changeCount,
        out KEvent ev, int eventCount, IntPtr timeout);

    [StructLayout(LayoutKind.Sequential)]
    private struct PollFd
    {
        internal int Fd;
        internal short Events;
        internal short ReturnedEvents;
    }

    private static void Close(int handle) => close(handle);

    [DllImport("libc", SetLastError = true)]
    private static extern nint syscall(nint number, int pid, uint flags);

    [DllImport("libc", SetLastError = true)]
    private static extern int poll(ref PollFd descriptor, nuint count, int timeout);

    [DllImport("libc", SetLastError = true)]
    private static extern int close(int handle);

    /// <summary>
    /// The host process's start time as a comparable string, for the platforms where .NET reports an absolute
    /// kernel timestamp (macOS: <c>kp_proc.p_starttime</c> via sysctl).
    /// </summary>
    /// <remarks>
    /// NOT used on Linux, where <see cref="Process.StartTime"/> is reconstructed from boot time and two reads
    /// of the same process are not reliably equal — the reason the Linux path reads <c>/proc</c> directly.
    /// </remarks>
    internal static string? TryReadKernelStartTime(int pid)
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
    internal static string? TryReadProcStartTime(int pid)
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
