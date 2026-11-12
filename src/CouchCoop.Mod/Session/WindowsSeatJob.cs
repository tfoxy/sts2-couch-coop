using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace CouchCoop.Mod.Session;

internal interface IWindowsSeatJob : IDisposable
{
    void Assign(IntPtr processHandle);
}

/// <summary>One host-owned job. Closing it terminates every assigned seat, including on a host crash.</summary>
internal sealed class WindowsSeatJob : IDisposable
{
    private readonly bool _isWindows;
    private readonly Func<IWindowsSeatJob> _create;
    private readonly Action<string> _log;
    private IWindowsSeatJob? _job;
    private bool _createFailed, _logged, _disposed;

    internal WindowsSeatJob() : this(OperatingSystem.IsWindows(), CreateNative, CouchCoopLog.Stderr) { }

    internal WindowsSeatJob(bool isWindows, Func<IWindowsSeatJob> create, Action<string> log)
    {
        _isWindows = isWindows;
        _create = create;
        _log = log;
    }

    internal void Assign(Func<IntPtr> processHandle)
    {
        if (!_isWindows || _disposed || _createFailed) return;
        try { (_job ??= _create()).Assign(processHandle()); }
        catch (Exception exception)
        {
            if (_job is null) _createFailed = true;
            if (_logged) return;
            _logged = true;
            try { _log("headless Windows job unavailable; seat host-watch remains active: " + exception.Message); }
            catch { /* A diagnostic failure must not fail the spawn either. */ }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _job?.Dispose();
    }

    private static IWindowsSeatJob CreateNative()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var handle = CreateJobObjectW(IntPtr.Zero, null);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        try
        {
            var limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimitInformation>()))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            return new NativeJob(handle);
        }
        catch { handle.Dispose(); throw; }
    }

    private sealed class NativeJob(SafeFileHandle handle) : IWindowsSeatJob
    {
        public void Assign(IntPtr processHandle)
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            if (!AssignProcessToJobObject(handle, processHandle))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
        }
        public void Dispose() => handle.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass,
        ref ExtendedLimitInformation information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}
