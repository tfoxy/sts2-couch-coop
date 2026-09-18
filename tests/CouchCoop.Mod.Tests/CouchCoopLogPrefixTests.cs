using System.Text;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// The <c>[couchcoop]</c> prefix has exactly one owner — <c>CouchCoopLogLine.Format</c>, in
/// <c>src/CouchCoop.Mod/Session/CouchCoopLogLine.cs</c> — and this suite is what keeps it that way.
/// </summary>
/// <remarks>
/// <para>
/// Two halves. The first pins the FORMAT, because probe scripts and support instructions match the emitted
/// text verbatim (<c>scripts/probe-steam-host-join.mjs</c>, <c>scripts/test-probe-five-player-run.mjs</c>,
/// <c>docs/configuration.md</c>) — the prefix is part of a contract, not decoration. The second is the DRIFT
/// GUARD: no string literal anywhere else under <c>src/CouchCoop.Mod*</c> may spell the prefix out again.
/// </para>
/// <para>
/// The guard is the point of the round. The prefix used to be a hand-written literal at ~320 call sites in
/// ~70 files, and two of them said <c>[couch-coop]</c> — invisible to every grep, every probe script and
/// every support instruction that matches on the real one, and nothing failed.
/// </para>
/// <para>
/// Registered near the TOP of the runner sequence, and behind its own <c>-- log-prefix</c> verb. The sequence
/// runs to completion again (the SIGSEGV that used to take it down inside <c>HeadlessAudioMuteTargetsTests</c>
/// was fixed on 2026-09-17), but the position and the verb are kept: this guard is cheap, it depends on
/// nothing, and a check that only exists downstream of every other suite is one abort away from not existing.
/// </para>
/// </remarks>
internal static class CouchCoopLogPrefixTests
{
    internal const string Verb = "log-prefix";

    /// <summary>The one file allowed to spell the prefix out.</summary>
    private const string OwnerFile = "CouchCoopLogLine.cs";

    public static void Run()
    {
        FormatsOneLineTheOneWay();
        StderrEmitsTheFormattedLine();
        NoOtherFileSpellsThePrefix();
        Console.WriteLine("  CouchCoopLogPrefixTests: ok");
    }

    /// <summary>
    /// A plain message is separated by one space; a message that already opens with a subsystem tag is written
    /// flush, because <c>[couchcoop][memory] rss_mb=</c> is the text a memory round greps for.
    /// </summary>
    private static void FormatsOneLineTheOneWay()
    {
        Assert(CouchCoopLog.Line("browser server listening on 13337") == "[couchcoop] browser server listening on 13337",
            "a plain message gets the prefix and one space");
        Assert(CouchCoopLog.Line("[memory] rss_mb=42") == "[couchcoop][memory] rss_mb=42",
            "a message that opens with a subsystem tag is written flush against the prefix");
        Assert(CouchCoopLog.Line("") == "[couchcoop] ", "an empty message still carries the prefix");
    }

    private static void StderrEmitsTheFormattedLine()
    {
        var captured = new StringWriter();
        var previous = Console.Error;
        try
        {
            Console.SetError(captured);
            CouchCoopLog.Stderr("host-transport probe=ok");
        }
        finally
        {
            Console.SetError(previous);
        }

        Assert(captured.ToString().TrimEnd('\r', '\n') == "[couchcoop] host-transport probe=ok",
            "the stderr sink emits exactly the formatted line");
    }

    private static void NoOtherFileSpellsThePrefix()
    {
        var root = RepoRoot();
        var offenders = new List<string>();
        var scanned = 0;
        foreach (var directory in Directory.EnumerateDirectories(Path.Combine(root, "src"), "CouchCoop.Mod*"))
        {
            foreach (var file in Directory.EnumerateFiles(directory, "*.cs", SearchOption.AllDirectories))
            {
                if (file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    || file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    || string.Equals(Path.GetFileName(file), OwnerFile, StringComparison.Ordinal))
                {
                    continue;
                }

                scanned++;
                foreach (var (line, text) in StringLiterals(File.ReadAllText(file)))
                {
                    if (text.Contains("[couchcoop", StringComparison.OrdinalIgnoreCase)
                        || text.Contains("[couch-coop", StringComparison.OrdinalIgnoreCase))
                    {
                        offenders.Add($"{Path.GetRelativePath(root, file)}:{line}");
                    }
                }
            }
        }

        Assert(scanned > 100, $"the guard actually walked the mod sources (scanned {scanned} files)");
        Assert(offenders.Count == 0,
            $"the prefix is written down only in {OwnerFile} — pass the message alone and let CouchCoopLog "
            + $"prepend it. Offending literal(s): {string.Join(", ", offenders)}");
    }

    /// <summary>
    /// Every string / interpolated / verbatim literal in <paramref name="source"/>, with its 1-based line.
    /// </summary>
    /// <remarks>
    /// Comments are skipped on purpose — including XML doc comments. A comment that quotes the emitted text
    /// (<c>"a memory round greps [couchcoop][memory]"</c>) is documentation of the contract, not a second copy
    /// of it, and the whole point of the guard is that the text exists in exactly one COMPILED place.
    /// </remarks>
    private static IEnumerable<(int Line, string Text)> StringLiterals(string source)
    {
        var line = 1;
        var i = 0;
        while (i < source.Length)
        {
            var c = source[i];
            if (c == '\n')
            {
                line++;
                i++;
                continue;
            }

            if (c == '/' && i + 1 < source.Length && source[i + 1] == '/')
            {
                while (i < source.Length && source[i] != '\n') i++;
                continue;
            }

            if (c == '/' && i + 1 < source.Length && source[i + 1] == '*')
            {
                i += 2;
                while (i + 1 < source.Length && !(source[i] == '*' && source[i + 1] == '/'))
                {
                    if (source[i] == '\n') line++;
                    i++;
                }

                i = Math.Min(i + 2, source.Length);
                continue;
            }

            if (c == '\'')
            {
                i++;
                while (i < source.Length && source[i] != '\'')
                {
                    if (source[i] == '\\') i++;
                    i++;
                }

                i++;
                continue;
            }

            // A literal may be prefixed by any mix of $ and @; only @ changes how escapes work.
            var start = i;
            var verbatim = false;
            while (i < source.Length && (source[i] == '$' || source[i] == '@'))
            {
                verbatim |= source[i] == '@';
                i++;
            }

            if (i >= source.Length || source[i] != '"')
            {
                i = start + 1;
                continue;
            }

            i++;
            var startLine = line;
            var text = new StringBuilder();
            while (i < source.Length)
            {
                if (source[i] == '\n') line++;
                if (!verbatim && source[i] == '\\')
                {
                    text.Append(source[i]);
                    i += 2;
                    continue;
                }

                if (source[i] == '"')
                {
                    if (verbatim && i + 1 < source.Length && source[i + 1] == '"')
                    {
                        text.Append('"');
                        i += 2;
                        continue;
                    }

                    i++;
                    break;
                }

                text.Append(source[i]);
                i++;
            }

            yield return (startLine, text.ToString());
        }
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CouchCoop.sln")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName
            ?? throw new Exception("[CouchCoopLogPrefixTests] could not locate the repo root (CouchCoop.sln).");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[CouchCoopLogPrefixTests] FAILED: {label}");
        }
    }
}
