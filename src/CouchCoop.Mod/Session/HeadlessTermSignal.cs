using System.Runtime.InteropServices;
using CouchCoop.Mod.Patches;

namespace CouchCoop.Mod.Session;

/// <summary>Routes host stop signals through capture disarm and the bounded exit sequence.</summary>
internal static class HeadlessTermSignal
{
    private static int _started;
    private static PosixSignalRegistration? _registration;
    private static IDisposable? _windowsRegistration;

    internal static void Start()
    {
        if (OperatingSystem.IsWindows())
        {
            var name = Environment.GetEnvironmentVariable(SeatStopEvent.EnvironmentVariable);
            if (string.IsNullOrWhiteSpace(name)) return;
            if (Interlocked.Exchange(ref _started, 1) != 0) return;
            try
            {
                _windowsRegistration = SeatStopEvent.Listen(SeatStopEvent.Open(name), HeadlessDisconnectExitPatch.RequestExit);
            }
            catch (Exception exception)
            {
                HeadlessLog.Write("headless stop event unavailable: " + exception.GetType().Name);
            }
            return;
        }
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        if (Interlocked.Exchange(ref _started, 1) != 0) return;
        _registration = PosixSignalRegistration.Create(PosixSignal.SIGTERM, Handle);
    }

    internal static void Handle(PosixSignalContext context)
    {
        context.Cancel = Decide(HeadlessDisconnectExitPatch.RequestExit);
        HeadlessLog.Write("headless received SIGTERM — starting the seat's exit sequence.");
    }

    internal static bool Decide(Func<string, bool> requestExit, string reason = "sigterm")
    {
        try { return requestExit(reason); }
        catch { return false; }
    }
}
