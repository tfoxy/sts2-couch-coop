using System;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Return glibc's free-but-retained heap to the kernel. All entry points run on the game main thread.
/// Idle maintenance is gated to avoid faulting pages back in under load; capture teardown trims once immediately.
/// Missing libc symbols latch trimming off on unsupported platforms.
/// </summary>
internal static class HeadlessMallocTrim
{
    private const long IdleThresholdMs = 5_000;
    private const long MinIntervalMs = 30_000;

    [DllImport("libc", SetLastError = true)]
    private static extern int malloc_trim(nuint pad);

    private static readonly Gate TrimGate = new(() => malloc_trim(0));

    /// <summary>Total number of trims that actually ran, for the profiler line.</summary>
    public static int TrimCount => TrimGate.TrimCount;

    /// <summary>Idle maintenance; preserves the idle window and minimum interval between trims.</summary>
    public static void MaybeTrim() => TrimGate.MaybeTrim(HeadlessIdleActivity.MsSinceActivity(), Environment.TickCount64);

    /// <summary>Trim once after capture teardown, without waiting for idle or the maintenance interval.</summary>
    public static void Trim() => TrimGate.Trim(Environment.TickCount64);

    internal sealed class Gate(Action trim)
    {
        private bool _unavailable;
        private long _lastTrimMs;
        internal int TrimCount { get; private set; }

        internal void MaybeTrim(long idleMs, long nowMs)
        {
            if (idleMs < IdleThresholdMs || (_lastTrimMs != 0 && nowMs - _lastTrimMs < MinIntervalMs)) return;
            Trim(nowMs);
        }

        internal void Trim(long nowMs)
        {
            if (_unavailable) return;
            _lastTrimMs = nowMs;
            try
            {
                trim();
                TrimCount++;
            }
            catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException)
            {
                _unavailable = true;
            }
        }
    }
}
