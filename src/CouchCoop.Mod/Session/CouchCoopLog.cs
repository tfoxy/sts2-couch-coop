namespace CouchCoop.Mod.Session;

/// <summary>
/// Emits a CouchCoop diagnostic line through STS2's own logger, so it lands in <c>godot.log</c> carrying
/// the <c>[INFO]</c> tag every other line in that file has — rather than as a bare <c>GD.Print</c> string
/// the game's log tooling cannot classify.
/// </summary>
/// <remarks>
/// <para>
/// Guarded on purpose. Callers reach this from thread-pool threads and from very early / very late in the
/// process lifetime; <c>Log.Info</c> must never be able to take a shutdown or a background worker down.
/// (The custom <c>CouchCoop.Mod.Tests</c> runner has no engine, so nothing here is exercised by the suite —
/// the same reason <see cref="HeadlessLog"/> and <c>CouchCoopHostUiServices.LogAddressSelection</c> stay
/// off every test-reachable path.)
/// </para>
/// </remarks>
internal static class CouchCoopLog
{
    public static void Info(string message)
    {
        try
        {
            MegaCrit.Sts2.Core.Logging.Log.Info(message);
        }
        catch
        {
            // Logger not up / not callable from here. Any Console.Error line the caller wrote still stands.
        }
    }

    /// <summary>
    /// The same line, tagged <c>[ERROR]</c>. For the few conditions a reader of <c>godot.log</c> must be able
    /// to grep for after the fact — a seat that refused to run, and nothing routine.
    /// </summary>
    public static void Error(string message)
    {
        try
        {
            MegaCrit.Sts2.Core.Logging.Log.Error(message);
        }
        catch
        {
            // Same guard as Info: a diagnostic must never be the reason a shutdown or a worker dies.
        }
    }
}
