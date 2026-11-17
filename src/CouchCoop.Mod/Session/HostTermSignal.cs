using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>Hosts replace default TERM handling with a bounded direct exit or the game's quit path.</summary>
internal static class HostTermSignal
{
    internal enum Registration { None, Seat, HostCancel, HostQuit }

    internal static Registration Select(bool isHeadlessClient, bool isHeadlessDisplay, Func<OSPlatform, bool> isOs)
    {
        var posix = isOs(OSPlatform.Linux) || isOs(OSPlatform.OSX);
        if (isHeadlessClient) return posix || isOs(OSPlatform.Windows) ? Registration.Seat : Registration.None;
        if (!posix) return Registration.None;
        return isHeadlessDisplay ? Registration.HostCancel : Registration.HostQuit;
    }

    internal static PosixSignalRegistration Register(HostTermExitSequence sequence) =>
        PosixSignalRegistration.Create(PosixSignal.SIGTERM, context => Handle(context, sequence.TryStart));

    internal static PosixSignalRegistration Register(HostTermQuitSequence sequence) =>
        PosixSignalRegistration.Create(PosixSignal.SIGTERM, context => Handle(context, sequence.TryStart));

    internal static void Handle(PosixSignalContext context, Func<bool>? requestExit) =>
        context.Cancel = Decide(requestExit);

    internal static bool Decide(Func<bool>? requestExit)
    {
        try { return requestExit?.Invoke() == true; }
        catch { return false; }
    }
}
