using System.Runtime.InteropServices;
using CouchCoop.Mod.Patches;

namespace CouchCoop.Mod.Session;

/// <summary>Routes seat SIGTERM through capture disarm and the bounded exit sequence.</summary>
internal static class HeadlessTermSignal
{
    private static int _started;
    private static PosixSignalRegistration? _registration;

    internal static void Start()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        if (Interlocked.Exchange(ref _started, 1) != 0) return;
        _registration = PosixSignalRegistration.Create(PosixSignal.SIGTERM, Handle);
    }

    internal static void Handle(PosixSignalContext context)
    {
        context.Cancel = Decide(HeadlessDisconnectExitPatch.RequestExit);
        HeadlessLog.Write("headless received SIGTERM — starting the seat's exit sequence.");
    }

    internal static bool Decide(Func<string, bool> requestExit)
    {
        try { return requestExit("sigterm"); }
        catch { return false; }
    }
}
