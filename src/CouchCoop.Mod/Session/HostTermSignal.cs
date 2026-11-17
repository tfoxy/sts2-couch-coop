using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>Only a headless host replaces default TERM handling with a bounded direct exit.</summary>
internal static class HostTermSignal
{
    internal enum Registration { None, Seat, HostCancel, HostDefault }

    internal static Registration Select(bool isHeadlessClient, bool isHeadlessDisplay, Func<OSPlatform, bool> isOs)
    {
        var posix = isOs(OSPlatform.Linux) || isOs(OSPlatform.OSX);
        if (isHeadlessClient) return posix || isOs(OSPlatform.Windows) ? Registration.Seat : Registration.None;
        if (!posix) return Registration.None;
        return isHeadlessDisplay ? Registration.HostCancel : Registration.HostDefault;
    }

    internal static PosixSignalRegistration Register(HostTermExitSequence sequence) =>
        PosixSignalRegistration.Create(PosixSignal.SIGTERM, context => Handle(context, sequence.TryStart));

    internal static void Handle(PosixSignalContext context, Func<bool>? requestExit) =>
        context.Cancel = Decide(requestExit);

    internal static bool Decide(Func<bool>? requestExit)
    {
        try { return requestExit?.Invoke() == true; }
        catch { return false; }
    }
}
