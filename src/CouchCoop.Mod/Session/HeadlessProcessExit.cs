using System.Runtime.InteropServices;
using Godot;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Leaves a headless seat without SceneTree.Quit: the game's exit path faults on seats with or without the
/// early FMOD release. Capture disarms before this step so its evidence is preserved. The native exit skips
/// the exit-tree pass, engine teardown and atexit handlers; the managed exit is a fallback if it fails.
/// </summary>
internal static class HeadlessProcessExit
{
    internal enum Route { PosixExit, WindowsTerminate, ManagedExit }

    internal static Route Select(Func<OSPlatform, bool> isOs) =>
        isOs(OSPlatform.Linux) || isOs(OSPlatform.OSX) || isOs(OSPlatform.FreeBSD) ? Route.PosixExit
        : isOs(OSPlatform.Windows) ? Route.WindowsTerminate : Route.ManagedExit;

    internal static void Leave(
        string reason,
        Action<string> log,
        Action<string> flushLog,
        Action<Route> platformExit,
        Action managedExit,
        Route route)
    {
        var line = $"headless disconnect-exit: leaving the process without SceneTree.Quit (reason={reason})";
        try
        {
            log(line);
        }
        catch
        {
            // Neither log sink may prevent the exit.
        }

        try
        {
            flushLog(line);
        }
        catch
        {
            // Flush is best-effort, independent of the normal log write.
        }

        try
        {
            platformExit(route);
        }
        catch
        {
            // A missing native primitive must still reach the managed exit.
        }

        managedExit();
    }

    /// <summary>Logs and flushes the reason, then leaves this seat on the caller's thread. Never returns normally.</summary>
    public static void Now(string reason) => Leave(
        reason,
        HeadlessLog.Write,
        static line => GD.PrintErr(CouchCoopLog.Line(line)),
        PlatformExit,
        static () => System.Environment.Exit(0),
        Select(RuntimeInformation.IsOSPlatform));

    private static void PlatformExit(Route route)
    {
        switch (route)
        {
            case Route.PosixExit:
                _exit(0);
                break;
            case Route.WindowsTerminate:
                TerminateProcess(GetCurrentProcess(), 0);
                break;
        }
    }

    [DllImport("libc", EntryPoint = "_exit", CallingConvention = CallingConvention.Cdecl)]
    private static extern void _exit(int status);

    [DllImport("kernel32.dll", ExactSpelling = true, CallingConvention = CallingConvention.Winapi)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", ExactSpelling = true, CallingConvention = CallingConvention.Winapi)]
    private static extern int TerminateProcess(IntPtr process, uint exitCode);
}
