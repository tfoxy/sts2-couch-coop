using System;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Hand glibc's free-but-retained heap back to the kernel, on an idle headless seat only.
///
/// <para><b>Why.</b> glibc never returns a freed chunk to the OS on its own unless it happens to sit at the very
/// top of a heap; everything else stays mapped and RESIDENT, waiting for a future allocation of a similar size.
/// A measured live seat was holding ~62MB of free chunks inside its thread arenas plus ~60MB of resident
/// all-zero pages — memory that counts fully against RSS while being, by definition, unused. The seat's
/// allocation profile is spiky (loading a room allocates a lot and then frees most of it), which is exactly the
/// shape that leaves this slack behind. <c>malloc_trim</c> walks the arenas and <c>MADV_DONTNEED</c>s the free
/// runs, dropping them from RSS.</para>
///
/// <para><b>Why idle-gated.</b> A trim is O(number of free chunks) and the pages it releases fault back in on
/// the next allocation, so running it under load would trade a real frame cost for memory we are about to
/// re-use. <see cref="HeadlessIdleActivity"/> already tracks when the seat last did anything meaningful (a
/// browser input, a scene delta), and <see cref="CouchCoopHeadlessVisualSuspender"/> uses the same clock to
/// freeze simulation. Trimming on the same signal means a trim only ever lands on a seat that is doing nothing
/// — never mid-combat.</para>
///
/// <para>Linux-only by construction (a couch seat is a Linux process); a failed p/invoke on any other platform
/// is latched off after the first attempt so the tick never pays for it twice.</para>
/// </summary>
internal static class HeadlessMallocTrim
{
    /// <summary>Seat must have been idle at least this long before a trim is allowed.</summary>
    private const long IdleThresholdMs = 5_000;

    /// <summary>Never trim more often than this, however long the seat stays idle.</summary>
    private const long MinIntervalMs = 30_000;

    [DllImport("libc", SetLastError = true)]
    private static extern int malloc_trim(nuint pad);

    private static bool _unavailable;
    private static long _lastTrimMs;

    /// <summary>Total number of trims that actually ran, for the profiler line.</summary>
    public static int TrimCount { get; private set; }

    /// <summary>
    /// Trim if the seat is idle and enough time has passed since the last one. Cheap no-op otherwise, so it is
    /// safe to call from every tick. Must be called on the game main thread (it is driven from the same timer as
    /// <see cref="HeadlessTextureImageEvictor"/>), which also makes the un-synchronised statics here safe.
    /// </summary>
    public static void MaybeTrim()
    {
        if (_unavailable)
        {
            return;
        }

        if (HeadlessIdleActivity.MsSinceActivity() < IdleThresholdMs)
        {
            return;
        }

        var now = Environment.TickCount64;
        if (_lastTrimMs != 0 && now - _lastTrimMs < MinIntervalMs)
        {
            return;
        }

        _lastTrimMs = now;
        try
        {
            malloc_trim(0);
            TrimCount++;
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException)
        {
            // Not glibc (musl exposes no malloc_trim) or not Linux. Latch off; this is an optimisation only.
            _unavailable = true;
        }
    }
}
