using System.Text;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.Activity;

/// <summary>
/// Turns <see cref="CouchCoopActivityEntry"/> values into the bbcode a <c>RichTextLabel</c> renders.
/// </summary>
/// <remarks>
/// <para>
/// Pure and Godot-free — colours are hex STRINGS, not <c>Color</c> — so the whole rendering contract
/// (row shape, escaping, severity palette, header wording) is unit-testable in a host with no engine. The
/// panel that consumes it does nothing but call these three methods and hand the result to
/// <c>AppendText</c>.
/// </para>
/// <para>
/// <b><see cref="EscapeBbcode"/> is load-bearing, not tidiness.</b> Half of what this log prints is a
/// display NAME typed into a browser by whoever is on the couch. Feeding <c>[b]Ann</c> to a bbcode-enabled
/// label unescaped lets a phone change how the host's TV renders — bold, colours, <c>[url]</c>, or an
/// unclosed tag that swallows every subsequent row. Every untrusted fragment goes through the escape.
/// </para>
/// </remarks>
public static class CouchCoopActivityRender
{
    /// <summary>Muted blue-grey for the leading clock, so the eye lands on the message.</summary>
    public const string TimestampColor = "#8a94a6";

    /// <summary>Neutral cream — the lobby's own body text colour (choice_selection_skip_button.tscn).</summary>
    public const string InfoColor = "#fdf4e3";

    public const string GoodColor = "#8fd6a0";
    public const string WarnColor = "#f0c674";
    public const string BadColor = "#e88b8b";

    /// <summary>Shown at the top when the ring has already dropped older lines.</summary>
    public static string TruncatedHeadText => CouchCoopLocalization.Resolve("couchcoop_activity_truncated");

    /// <summary>Header when the log is empty. The panel is up before anything has happened, on purpose.</summary>
    public static string EmptySummary => CouchCoopLocalization.Resolve("couchcoop_activity_empty");

    /// <summary>Suffix appended to the header while the newest line is a warning or a failure.</summary>
    public static string NeedsAttentionSuffix => CouchCoopLocalization.Resolve("couchcoop_activity_attention");

    public static string ColorFor(CouchCoopActivitySeverity severity)
        => severity switch
        {
            CouchCoopActivitySeverity.Good => GoodColor,
            CouchCoopActivitySeverity.Warn => WarnColor,
            CouchCoopActivitySeverity.Bad => BadColor,
            _ => InfoColor,
        };

    /// <summary>
    /// Neutralises bbcode in untrusted text. Godot's own escape for a literal <c>[</c> is <c>[lb]</c>;
    /// a closing <c>]</c> needs nothing once no tag can open.
    /// </summary>
    public static string EscapeBbcode(string? text)
        => string.IsNullOrEmpty(text) ? string.Empty : text.Replace("[", "[lb]", StringComparison.Ordinal);

    /// <summary>One rendered row, newline-terminated: a dim clock, two spaces, then the coloured message.</summary>
    public static string RowBbcode(CouchCoopActivityEntry entry)
        => $"[color={TimestampColor}]{CouchCoopActivityLog.FormatTimestamp(entry.Timestamp)}[/color]  "
            + $"[color={ColorFor(entry.Severity)}]{EscapeBbcode(entry.Text.Resolve())}[/color]\n";

    /// <summary>
    /// The same row with the markup removed — what the panel PUBLISHES to scene inspection.
    /// </summary>
    /// <remarks>
    /// Not a debug convenience: <c>RichTextLabel.append_text</c> deliberately does not update the node's
    /// <c>text</c> property (it pushes items straight onto the parsed stack), so a
    /// <c>dev scene node --properties</c> dump of the log reads EMPTY. The panel therefore keeps this
    /// string alongside and hands it back through <c>GetFormattedText()</c>, which is the first accessor
    /// spirectl's text diagnostics probe. Escaping is deliberately NOT applied — this string is never
    /// parsed as markup.
    /// </remarks>
    public static string RowPlainText(CouchCoopActivityEntry entry)
        => $"{CouchCoopActivityLog.FormatTimestamp(entry.Timestamp)}  {entry.Text.Resolve()}\n";

    /// <inheritdoc cref="RowPlainText"/>
    public static string ToPlainText(IReadOnlyList<CouchCoopActivityEntry> entries, bool truncatedHead)
    {
        ArgumentNullException.ThrowIfNull(entries);

        var builder = new StringBuilder();
        if (truncatedHead)
        {
            builder.Append(TruncatedHeadText).Append('\n');
        }

        foreach (var entry in entries)
        {
            builder.Append(RowPlainText(entry));
        }

        return builder.ToString();
    }

    /// <summary>
    /// The whole log as one bbcode block, oldest first. Used on a first render and whenever the panel has
    /// fallen far enough behind that it cannot append its way forward (see
    /// <see cref="CouchCoopActivityLog.SnapshotSince"/>).
    /// </summary>
    public static string ToBbcode(IReadOnlyList<CouchCoopActivityEntry> entries, bool truncatedHead)
    {
        ArgumentNullException.ThrowIfNull(entries);

        var builder = new StringBuilder();
        if (truncatedHead)
        {
            builder.Append("[i][color=").Append(TimestampColor).Append(']').Append(TruncatedHeadText)
                .Append("[/color][/i]\n");
        }

        foreach (var entry in entries)
        {
            builder.Append(RowBbcode(entry));
        }

        return builder.ToString();
    }

    /// <summary>
    /// The collapsed-state-visible header line. <paramref name="count"/> is what is RETAINED (the ring
    /// caps it), which is what the reader can actually scroll through.
    /// </summary>
    public static string HeaderSummary(int count, CouchCoopActivitySeverity? newestSeverity)
    {
        if (count <= 0)
        {
            // Never flagged: an empty log has nothing to point at, so "(needs attention)" beside "no events
            // yet" would send a host looking for a line that is not there.
            return EmptySummary;
        }

        var summary = count == 1
            ? CouchCoopLocalization.Resolve("couchcoop_activity_one")
            : CouchCoopLocalization.Resolve("couchcoop_activity_many", new Dictionary<string, CouchCoopTextArgument>
            {
                ["count"] = count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            });

        var needsAttention = newestSeverity is CouchCoopActivitySeverity.Warn or CouchCoopActivitySeverity.Bad;
        return needsAttention ? summary + NeedsAttentionSuffix : summary;
    }
}
