namespace CouchCoop.Mod.Session;

/// <summary>
/// Every CouchCoop diagnostic line in the mod is emitted through here. Callers pass the MESSAGE; the prefix
/// each line carries belongs to <see cref="CouchCoopLogLine.Format"/> and is written down in exactly one file.
/// </summary>
/// <remarks>
/// <para>
/// THE SINKS ARE DELIBERATELY SEPARATE ENTRY POINTS, not one "log" call. A line's destination is a real
/// decision: stderr is what a launcher capturing a spawned seat reads, the STS2 logger is what survives in
/// that instance's own <c>godot.log</c>, and in the shipped Steam flow <em>only</em> the logger reaches
/// godot.log at all. A site that writes to one of them keeps writing to exactly that one; what they now share
/// is the formatting — which is why <see cref="HeadlessLog.Write"/>, the one caller that writes BOTH, can no
/// longer have its two sinks disagree about what the line says.
/// </para>
/// <para>
/// THE LOGGER ENTRY POINTS ARE LATCHED, AND THE GUARD IS THE LATCH, NOT A <c>try</c>. Outside a game process
/// an STS2 logger call does not throw — it SEGFAULTS, exit 139, with no managed exception for a <c>catch</c>
/// to see. That is not hypothetical: <c>ConnectionArrivalLog.Shared.Record(...)</c> killed a test process
/// outright, because the shared log's default sink is <see cref="Info"/>. The rule that came out of it ("never
/// record into the shared arrival log from a test; always inject your own log action") was documentation, and
/// documentation only protects the people who have read it. <c>CouchCoopMod.EngineAvailable</c> makes the
/// DEFAULT safe instead: off until a real game process says otherwise, so any host-side type is constructible,
/// callable and testable out of the engine, and the injected-log seams
/// (<c>new ConnectionArrivalLog(time, log: …)</c>, <c>HeadlessConnectionReporter.ViewerArrivals(log)</c>) stay
/// correct either way. Callers reach these from thread-pool threads and from very early / very late in the
/// process lifetime; a diagnostic must never be the reason a shutdown or a worker dies.
/// </para>
/// <para>
/// <see cref="Stderr"/> is not latched, because it never was: <c>Console.Error</c> is managed, available in
/// every process, and is what a host-side component's injected log action falls back to.
/// </para>
/// </remarks>
public static class CouchCoopLog
{
    /// <summary>
    /// The prefixed text, for the rare line that must carry the prefix somewhere other than a log sink — a
    /// refusal exception whose message is the only thing naming CouchCoop as the cause. Emits nothing itself.
    /// </summary>
    public static string Line(string message) => CouchCoopLogLine.Format(message);

    /// <summary>
    /// stderr only, for the sites that write there and nowhere else: a spawned headless seat's launcher
    /// capture, and every host-side component whose injected log action defaults to it.
    /// </summary>
    public static void Stderr(string message) => CouchCoopLogLine.Stderr(message);

    /// <summary>A routine line in <c>godot.log</c>, tagged <c>[INFO]</c>.</summary>
    public static void Info(string message)
    {
        if (!CouchCoopMod.EngineAvailable)
        {
            return;
        }

        CouchCoopLogLine.Info(message);
    }

    /// <summary>
    /// The same line, tagged <c>[WARN]</c>. For a condition that is survivable but is very likely the reason
    /// something downstream looks wrong — a stale copy being shadowed, a fallback being taken.
    /// </summary>
    public static void Warn(string message)
    {
        if (!CouchCoopMod.EngineAvailable)
        {
            return;
        }

        CouchCoopLogLine.Warn(message);
    }

    /// <summary>
    /// The same line, tagged <c>[ERROR]</c>. For the few conditions a reader of <c>godot.log</c> must be able
    /// to grep for after the fact — a seat that refused to run, and nothing routine.
    /// </summary>
    public static void Error(string message)
    {
        if (!CouchCoopMod.EngineAvailable)
        {
            return;
        }

        CouchCoopLogLine.Error(message);
    }
}
