// WHY THIS DIRECTORY EXISTS — read before moving this file.
//
// `Activity/` is deliberately NOT `Diagnostics/`, `Server/` or `Protocol/`. Those three are glob-linked
// into `src/CouchCoop.Mod.HotReload/CouchCoop.Mod.HotReload.csproj` (`<Compile Include="../CouchCoop.Mod/Server/*.cs" .../>`
// and friends), so every hot-reload generation COMPILES ITS OWN COPY of them. Static state in a linked file
// is therefore per-generation: a reload would silently start a second, empty ring while the panel kept
// rendering the first — or the other way round, depending on which generation's type the reader bound to.
//
// This log must be singular process-wide, so it lives in a directory no glob picks up. The linked sources
// (notably `Server/CouchCoopWebSocketConnection.cs`) still reach these types through the hot-reload
// project's `ProjectReference` to `CouchCoop.Mod`, which resolves to the ONE compiled copy in the mod
// assembly. That only works while the API surface below takes BCL types and the enums declared HERE:
// passing a type that is ALSO glob-compiled into the hot-reload assembly (`WireSceneDelta` is the standing
// example) fails with CS1503 on type identity despite the `CS0436` suppression, because the caller's copy
// and the callee's copy are different types. See the comment in the hot-reload csproj.
//
// Corollary: do NOT add `Activity/*.cs` to any `<Compile Include>` in that csproj.

using System.Globalization;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.Activity;

/// <summary>Which part of the system an activity line came from. Drives nothing but the reader's mental model.</summary>
public enum CouchCoopActivityCategory
{
    /// <summary>A player's headless game window (spawn / ready / reap / shutdown).</summary>
    Seat,

    /// <summary>A browser (phone) connecting, joining, being refused, or going away.</summary>
    Viewer,

    /// <summary>The host's own services: the browser server, the secure origin, seat status transitions.</summary>
    Server,
}

/// <summary>How a line reads on the host's TV: neutral, good news, a warning, or a failure.</summary>
public enum CouchCoopActivitySeverity
{
    Info,
    Good,
    Warn,
    Bad,
}

/// <param name="Sequence">Monotonic, 1-based. Also the panel's revision cursor (see <see cref="CouchCoopActivityLog.NewestSequence"/>).</param>
/// <param name="Timestamp">
/// LOCAL time, deliberately: this is rendered on the host's television for people sitting in the room, who
/// read it against the clock on the wall, not against UTC.
/// </param>
public readonly record struct CouchCoopActivityEntry(
    long Sequence,
    DateTimeOffset Timestamp,
    CouchCoopActivityCategory Category,
    CouchCoopActivitySeverity Severity,
    CouchCoopText Text)
{
    /// <summary>Resolved only by readers, never while the activity leaf lock is held.</summary>
    public string Message => Text.Resolve();
}

/// <summary>
/// The host connectivity log: a fixed-size ring of player-readable lines describing what the couch-coop
/// plumbing is doing, rendered natively on the host's lobby screen by
/// <c>CouchCoop.Mod.HostUi.CouchCoopActivityPanel</c>.
/// </summary>
/// <remarks>
/// <para>
/// It exists because every one of these events already goes to <see cref="Console.Error"/>, but a player should
/// not need a terminal or launcher log to understand why a phone failed to join. Those stderr lines are unchanged;
/// each <c>Append</c> sits beside its line rather than replacing it, so the developer-facing log keeps its
/// exact bytes and this ring carries the player-facing sentence.
/// </para>
/// <para>
/// <b><see cref="Gate"/> is a LEAF LOCK.</b> Producers call <c>Append</c> from inside their own locks —
/// <c>HeadlessClientManager</c> does so while holding the slot lock that the Godot main thread also takes.
/// So nothing inside this type may call out, take another lock, block, or touch Godot. Everything here is
/// array writes and struct copies for exactly that reason, and there is no <c>Console.Error</c> in this
/// file (a write to a redirected stderr can block).
/// </para>
/// <para>
/// <b>No repeat collapse.</b> An obvious-looking feature here would be to fold a repeated message into
/// "(x3)" on the newest row. It is deliberately absent: the panel renders APPEND-ONLY
/// (<c>RichTextLabel.AppendText</c>, never <c>.Text =</c>, so Godot's own tail-follow behaviour survives a
/// scrolled-up reader), and mutating an already-rendered row cannot be expressed that way.
/// <see cref="AppendDistinct"/> covers the one case that needed it — a per-tick evaluation that would
/// otherwise re-announce an unchanged fact.
/// </para>
/// </remarks>
public static class CouchCoopActivityLog
{
    /// <summary>
    /// How many lines are retained. A lobby session produces a handful of events per player, so 256 is
    /// "everything that happened tonight" while staying a fixed, allocation-free footprint.
    /// </summary>
    public const int Capacity = 256;

    private static readonly object Gate = new();
    private static readonly CouchCoopActivityEntry[] Ring = new CouchCoopActivityEntry[Capacity];

    // Total events ever appended. Also the newest entry's Sequence, and the panel's revision counter.
    private static long _appended;
    private static Func<DateTimeOffset>? _clock;

    /// <summary>
    /// The newest entry's sequence number, or <c>0</c> when nothing has been logged. Doubles as the log's
    /// REVISION: the panel compares it against what it last rendered and does nothing when they match, so
    /// the common 4Hz tick costs one lock and one comparison.
    /// </summary>
    public static long NewestSequence
    {
        get { lock (Gate) { return _appended; } }
    }

    /// <summary>How many entries are currently retained (<see cref="Capacity"/> once the ring has wrapped).</summary>
    public static int Count
    {
        get { lock (Gate) { return (int)Math.Min(_appended, Capacity); } }
    }

    /// <summary>Severity of the newest entry, or null when the log is empty. Feeds the header's "needs attention".</summary>
    public static CouchCoopActivitySeverity? NewestSeverity
    {
        get
        {
            lock (Gate)
            {
                return _appended == 0 ? null : Ring[IndexOfLocked(_appended)].Severity;
            }
        }
    }

    /// <summary>Record one line. Never throws; a null/blank message is dropped rather than rendered as a gap.</summary>
    public static void Append(
        CouchCoopActivityCategory category,
        CouchCoopActivitySeverity severity,
        string message)
        => Append(category, severity, CouchCoopText.FromLiteral(message));

    /// <summary>Record structured, locale-refreshable player copy without resolving it under the leaf lock.</summary>
    public static void Append(
        CouchCoopActivityCategory category,
        CouchCoopActivitySeverity severity,
        CouchCoopText text)
    {
        if (text.IsBlankLiteral)
        {
            return;
        }

        lock (Gate)
        {
            AppendLocked(category, severity, text);
        }
    }

    /// <summary>
    /// Record one line UNLESS it is identical (category, severity and message) to the newest entry.
    /// </summary>
    /// <remarks>
    /// For producers that re-evaluate on a tick rather than on an edge — <c>MirrorSeatDirectory</c> runs on
    /// every session-envelope build — so a state that is merely still true does not repaint the log. Note
    /// this compares only against the NEWEST entry: an event that recurs after something else happened is a
    /// genuinely new event and is kept.
    /// </remarks>
    /// <returns>True when the entry was appended.</returns>
    public static bool AppendDistinct(
        CouchCoopActivityCategory category,
        CouchCoopActivitySeverity severity,
        string message)
        => AppendDistinct(category, severity, CouchCoopText.FromLiteral(message));

    /// <summary>Structured twin of <see cref="AppendDistinct(CouchCoopActivityCategory,CouchCoopActivitySeverity,string)"/>.</summary>
    public static bool AppendDistinct(
        CouchCoopActivityCategory category,
        CouchCoopActivitySeverity severity,
        CouchCoopText text)
    {
        if (text.IsBlankLiteral)
        {
            return false;
        }

        lock (Gate)
        {
            if (_appended > 0)
            {
                var newest = Ring[IndexOfLocked(_appended)];
                if (newest.Category == category
                    && newest.Severity == severity
                    && newest.Text.StructurallyEquals(text))
                {
                    return false;
                }
            }

            AppendLocked(category, severity, text);
            return true;
        }
    }

    /// <summary>Every retained entry, oldest first.</summary>
    public static IReadOnlyList<CouchCoopActivityEntry> Snapshot() => SnapshotSince(0, out _);

    /// <summary>
    /// Every retained entry whose <see cref="CouchCoopActivityEntry.Sequence"/> is greater than
    /// <paramref name="after"/>, oldest first — the panel's incremental feed.
    /// </summary>
    /// <param name="truncated">
    /// True when entries the caller had not yet seen were EVICTED from the ring before it asked (i.e. the
    /// oldest retained entry is newer than <c>after + 1</c>). The panel treats that as "you cannot append
    /// your way forward" and re-renders from scratch with an "earlier events not shown" head.
    /// </param>
    public static IReadOnlyList<CouchCoopActivityEntry> SnapshotSince(long after, out bool truncated)
    {
        lock (Gate)
        {
            if (_appended == 0)
            {
                truncated = false;
                return [];
            }

            var oldest = Math.Max(1, _appended - Capacity + 1);
            truncated = oldest > after + 1;

            var from = Math.Max(oldest, after + 1);
            if (from > _appended)
            {
                return [];
            }

            var result = new List<CouchCoopActivityEntry>((int)(_appended - from + 1));
            for (var sequence = from; sequence <= _appended; sequence++)
            {
                result.Add(Ring[IndexOfLocked(sequence)]);
            }

            return result;
        }
    }

    /// <summary>Test seam: drop every entry and restore the real clock. Never called by product code.</summary>
    internal static void Reset()
    {
        lock (Gate)
        {
            Array.Clear(Ring);
            _appended = 0;
            _clock = null;
        }
    }

    /// <summary>
    /// Test seam: pin the timestamp source so the rendered <c>HH:mm:ss</c> is assertable. Null restores
    /// <see cref="DateTimeOffset.Now"/>.
    /// </summary>
    internal static void SetClockForTests(Func<DateTimeOffset>? clock)
    {
        lock (Gate)
        {
            _clock = clock;
        }
    }

    private static void AppendLocked(
        CouchCoopActivityCategory category,
        CouchCoopActivitySeverity severity,
        CouchCoopText text)
    {
        var timestamp = ReadClockLocked();
        _appended++;
        Ring[IndexOfLocked(_appended)] = new CouchCoopActivityEntry(
            _appended,
            timestamp,
            category,
            severity,
            text);
    }

    private static DateTimeOffset ReadClockLocked()
    {
        if (_clock is null)
        {
            return DateTimeOffset.Now;
        }

        try
        {
            return _clock();
        }
        catch
        {
            // A test clock that throws must not take the producer down with it.
            return DateTimeOffset.Now;
        }
    }

    // 1-based sequence → ring index. Kept as one expression so the wrap rule has exactly one definition.
    private static int IndexOfLocked(long sequence) => (int)((sequence - 1) % Capacity);

    /// <summary>The timestamp format every row renders with. Public so the tests can assert it literally.</summary>
    public const string TimestampFormat = "HH:mm:ss";

    /// <summary>Formats one entry's timestamp for display. Invariant so the row is stable across machines.</summary>
    public static string FormatTimestamp(DateTimeOffset timestamp)
        => timestamp.ToString(TimestampFormat, CultureInfo.InvariantCulture);
}
