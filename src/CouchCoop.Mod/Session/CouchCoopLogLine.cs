namespace CouchCoop.Mod.Session;

/// <summary>
/// The <c>[couchcoop]</c> prefix, written down once, and the raw sink calls that carry it. This is the only
/// file under <c>src/CouchCoop.Mod*</c> allowed to spell the prefix out — <c>CouchCoopLogPrefixTests</c> fails
/// the suite if a second copy appears in any string literal anywhere else.
/// </summary>
/// <remarks>
/// <para>
/// It had drifted before the prefix had an owner: ~320 hand-written copies of the literal across ~70 files,
/// two of which said <c>[couch-coop]</c> instead and so fell out of every grep, probe script and support
/// instruction that matches on the real one — with nothing failing. Callers now pass the message only.
/// </para>
/// <para>
/// THIS FILE IS LINK-COMPILED INTO <c>CouchCoop.Mod.Loader</c> (see that csproj), which is why it may not name
/// <c>CouchCoopMod</c>, <see cref="CouchCoopLog"/>, or anything else outside itself. The bootstrap loader has
/// to be able to log BEFORE it has installed the assembly resolver that can find <c>CouchCoop.Mod.dll</c> at
/// all — a lane payload keeps the implementation under <c>lanes/&lt;version&gt;/</c>, off every default
/// probing path — so a call from there into the mod assembly would fail to bind on exactly the paths (lane
/// refusal, bootstrap failure) whose only job is to say why the mod did not load.
/// </para>
/// <para>
/// TWO CONSEQUENCES OF BEING COMPILED TWICE. It carries NO accessibility modifier, so it is <c>internal</c> in
/// both assemblies: <c>CouchCoop.Mod.Tests</c> has <c>InternalsVisibleTo</c> from both, so naming this type
/// from a test would be ambiguous (CS0433) — name <see cref="CouchCoopLog"/> instead, which exists once. And
/// it must hold no mutable static state, because a static here is two fields, not one (the trap that moved
/// the engine latch onto <c>CouchCoopMod</c> in the first place).
/// </para>
/// <para>
/// The sink methods here are UNLATCHED. Everything in the mod itself goes through <see cref="CouchCoopLog"/>,
/// which gates them on <c>CouchCoopMod.EngineAvailable</c> because an STS2 logger call with no engine behind
/// it SEGFAULTS rather than throwing. The loader is the one caller that may skip the latch, and must: it is
/// the game's <c>[ModInitializer]</c>, so it only ever runs inside a real game process, and it runs before
/// <c>CouchCoopMod.Init</c> has set the latch — gating it would silently drop the entire bootstrap diagnostic.
/// </para>
/// </remarks>
static class CouchCoopLogLine
{
    /// <summary>
    /// The prefix. Probe scripts and support instructions match on it verbatim
    /// (<c>scripts/probe-steam-host-join.mjs</c>, <c>scripts/test-probe-five-player-run.mjs</c>,
    /// <c>docs/configuration.md</c>), so it is a contract, not decoration.
    /// </summary>
    private const string Prefix = "[couchcoop]";

    /// <summary>
    /// The one function that prepends the prefix. Every entry point, here and on
    /// <see cref="CouchCoopLog"/>, builds its line through it.
    /// </summary>
    /// <remarks>
    /// Subsystem tags stay in the caller's message (<c>"[fmod] …"</c>, <c>"[suspend] …"</c>,
    /// <c>"[memory] rss_mb=…"</c>) and are written flush, with no separating space, because
    /// <c>[couchcoop][memory] rss_mb=</c> is the text a memory round greps for. A message whose first
    /// character is a <c>[</c> supplied at RUNTIME would be treated the same way and lose its space — no
    /// caller does that today, and a message that opens with a value rather than a word reads badly anyway.
    /// </remarks>
    internal static string Format(string message)
        => message.StartsWith('[') ? Prefix + message : Prefix + " " + message;

    /// <summary>stderr, for the sites that write there and nowhere else.</summary>
    internal static void Stderr(string message) => Console.Error.WriteLine(Format(message));

    /// <summary>STS2's logger, tagged <c>[INFO]</c>.</summary>
    internal static void Info(string message) => Write(Sink.Info, message);

    /// <summary>STS2's logger, tagged <c>[WARN]</c>.</summary>
    internal static void Warn(string message) => Write(Sink.Warn, message);

    /// <summary>STS2's logger, tagged <c>[ERROR]</c>.</summary>
    internal static void Error(string message) => Write(Sink.Error, message);

    private enum Sink
    {
        Info,
        Warn,
        Error,
    }

    private static void Write(Sink sink, string message)
    {
        var line = Format(message);
        try
        {
            switch (sink)
            {
                case Sink.Warn:
                    MegaCrit.Sts2.Core.Logging.Log.Warn(line);
                    break;
                case Sink.Error:
                    MegaCrit.Sts2.Core.Logging.Log.Error(line);
                    break;
                default:
                    MegaCrit.Sts2.Core.Logging.Log.Info(line);
                    break;
            }
        }
        catch
        {
            // Logger not up / not callable from here. Any stderr line the caller wrote still stands. This
            // catch is NOT what makes the call safe outside a game process — see CouchCoopLog for the latch
            // that is.
        }
    }
}
