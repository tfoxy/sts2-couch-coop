namespace CouchCoop.Mod.Session;

/// <summary>
/// Writes a headless-lifecycle line where it can actually be READ.
///
/// <para>
/// Console.Error alone is not enough for anything a human (or an agent) has to diagnose after the fact: launcher
/// capture is transient and a headless instance may outlive the shell observing it. The STS2-logger write lands in
/// that instance's own
/// per-slot <c>godot.log</c> (each headless has its own <c>XDG_DATA_HOME</c>), which is the artifact that
/// survives the process — and it carries the <c>[INFO]</c> tag, unlike the bare <c>GD.Print</c> this used to do.
/// </para>
/// <para>
/// Both writes are attempted, deliberately: stderr still wins when the game IS attached to a terminal, and the
/// logger write is guarded (via <see cref="CouchCoopLog"/>) because it must never be able to break a shutdown
/// path — it can be called off the main thread, and before the engine is up.
/// </para>
/// </summary>
internal static class HeadlessLog
{
    public static void Write(string message)
    {
        Console.Error.WriteLine(message);
        CouchCoopLog.Info(message);
    }
}
