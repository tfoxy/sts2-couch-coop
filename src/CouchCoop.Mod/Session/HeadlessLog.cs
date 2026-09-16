namespace CouchCoop.Mod.Session;

/// <summary>
/// Writes a headless-lifecycle line where it can actually be READ.
///
/// <para>
/// Console.Error alone is not enough for anything a human (or an agent) has to diagnose after the fact: launcher
/// capture is transient and a headless instance may outlive the shell observing it. The STS2-logger write lands in
/// that instance's own
/// per-slot <c>godot.log</c> after successful user-dir preparation (via <c>XDG_DATA_HOME</c>, <c>APPDATA</c>,
/// or a fake <c>HOME</c>), which is the artifact that survives the process — and it carries the <c>[INFO]</c>
/// tag, unlike the bare <c>GD.Print</c> this used to do.
/// </para>
/// <para>
/// Both writes are attempted, deliberately: stderr still wins when the game IS attached to a terminal, and the
/// logger write is guarded (via <see cref="CouchCoopLog"/>) because it must never be able to break a shutdown
/// path — it can be called off the main thread, and before the engine is up.
/// </para>
/// <para>
/// Both go through <see cref="CouchCoopLog"/>, so neither sink can spell the line differently from the other.
/// This used to pass the caller's raw string to both, which made the prefix the caller's problem — and every
/// dual-sink helper of this shape in the mod was one typo from the two channels disagreeing, which is exactly
/// what happened at the arrival log's own copy of it: <c>[couch-coop]</c>, at two call sites, matching nothing.
/// </para>
/// </summary>
internal static class HeadlessLog
{
    public static void Write(string message)
    {
        CouchCoopLog.Stderr(message);
        CouchCoopLog.Info(message);
    }
}
