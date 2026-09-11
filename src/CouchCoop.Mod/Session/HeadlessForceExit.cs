using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Terminate THIS headless process for real, right now.
/// <para>
/// STS2 traps SIGTERM (it runs its own shutdown), and a Godot process that is mid-teardown — or wedged behind a
/// modal error popup, a blocked main loop, or a native FMOD/ENet thread — can outlive every polite request. So the
/// only reliable exit is SIGKILL, which is untrappable. <see cref="Environment.Exit"/> is the managed fallback for
/// non-Linux / a failed p/invoke; it can still block on finalizers, which is exactly why it is second choice.
/// </para>
/// <para>
/// Shared by the two paths that must guarantee a headless goes away: <see cref="HeadlessHostWatchdog"/> (the host
/// process vanished) and <see cref="HeadlessDisconnectExitSequence"/> (the game connection is permanently gone and
/// a clean <c>SceneTree.Quit()</c> did not land in time).
/// </para>
/// </summary>
internal static class HeadlessForceExit
{
    private const int SIGKILL = 9;

    [DllImport("libc", SetLastError = true)]
    private static extern int kill(int pid, int sig);

    /// <summary>SIGKILL this process (falling back to <see cref="Environment.Exit"/>). Never returns normally.</summary>
    public static void Now()
    {
        try
        {
            kill(Environment.ProcessId, SIGKILL);
        }
        catch
        {
            // p/invoke unavailable (non-Linux, or libc not resolvable) — fall through to the managed exit.
        }

        Environment.Exit(0);
    }
}
