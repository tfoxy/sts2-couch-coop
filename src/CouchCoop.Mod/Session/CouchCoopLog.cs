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
/// </para>
/// <para>
/// AND THE GUARD IS THE LATCH, NOT THE <c>try</c>. Outside a game process the call does not throw — it
/// SEGFAULTS, exit 139, with no managed exception for the <c>catch</c> below to see. That is not
/// hypothetical: <c>ConnectionArrivalLog.Shared.Record(...)</c> killed a test process outright, because the
/// shared log's default sink is <see cref="Info"/>. The rule that came out of it ("never record into the
/// shared arrival log from a test; always inject your own log action") was documentation, and documentation
/// only protects the people who have read it. <see cref="GameRuntimeAvailable"/> makes the DEFAULT safe
/// instead: off until a real game process says otherwise, so any host-side type is constructible, callable
/// and testable out of the engine, and the injected-log seams
/// (<c>new ConnectionArrivalLog(time, log: …)</c>, <c>HeadlessConnectionReporter.ViewerArrivals(log)</c>)
/// stay correct either way.
/// </para>
/// </remarks>
internal static class CouchCoopLog
{
    /// <summary>
    /// Latched TRUE from <c>CouchCoopMod.Init()</c> — i.e. only inside a REAL game process, where STS2's
    /// logger exists to be called. Default OFF, because the failure it gates is uncatchable: the managed call
    /// binds and JITs fine with <c>sts2.dll</c> merely on the probing path, and then dies in native code.
    /// Same shape, and the same reason, as
    /// <c>CouchCoopStaticBackgroundTracker.EngineAvailable</c> beside it.
    /// </summary>
    /// <remarks>
    /// Set at the very top of <c>Init</c>, above the seat build guard, so nothing that runs during mod
    /// startup loses its <c>godot.log</c> line. A process that never calls <c>Init</c> is by definition not
    /// the game.
    /// </remarks>
    public static volatile bool GameRuntimeAvailable;

    public static void Info(string message)
    {
        if (!GameRuntimeAvailable)
        {
            return;
        }

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
        if (!GameRuntimeAvailable)
        {
            return;
        }

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
