using System.Reflection;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.Tests;

internal static class ConnectionUiTests
{
    public static void Run()
    {
        ClipboardReportsWriteReadAndMismatchFailures();
        RowTextIsFourLinesAndOnlyCompletesWithCheckmark();
        IssueRowsUseSavedStageAndKeepTheirFourthLineMeaningful();
        CompanionCardGeometryKeepsTheQrCardCentred();
        DetailControlsStayInsideTheCompanionCard();
        ProblemIdentitySurvivesRefinementAndArchiving();
        OutcomeWordsAndStylingSurviveRecovery();
        HostIssueCodesHaveTheirOwnLocalizedCopy();
    }

    /// <summary>
    /// The panel resolves its copy from the issue CODE, and an unmapped code falls through to the join copy —
    /// "The player game lost its connection", on a Host service row, for a problem that has no player and no
    /// connection. A new code without a mapping is therefore not a missing string but a wrong sentence.
    /// </summary>
    private static void HostIssueCodesHaveTheirOwnLocalizedCopy()
    {
        CouchCoopLocalization.SetLanguageForTests("eng");
        var joinSummary = Copy("Summary", new ConnectionIssue("something-nobody-mapped", "", "", null));
        foreach (var code in new[]
                 {
                     CouchCoopPatchHealth.IssueCode,
                     HostReachabilityWatch.IssueCode,
                     CouchCoop.Mod.Session.HeadlessClientManager.SharedUserDirCode,
                     // Both ends of the mid-run refusal report this one — the host declining to launch a seat
                     // into a running run, and a seat the host's netcode turned away. Unmapped it would render
                     // the join copy ("check that game and mod versions match"), which is wrong advice for a run
                     // the player simply is not in.
                     CouchCoop.Mod.Session.HeadlessDisconnectReason.RunInProgressCode,
                 })
        {
            var issue = new ConnectionIssue(code, "", "", null);
            Assert(Copy("Summary", issue) != joinSummary && Copy("Action", issue) != Copy("Action", new ConnectionIssue("something-nobody-mapped", "", "", null)),
                $"{code} has its own player-facing copy rather than the unmapped-code fallback");
            Assert(!string.IsNullOrWhiteSpace(Copy("Summary", issue)) && !Copy("Summary", issue).StartsWith("couchcoop_", StringComparison.Ordinal),
                $"{code} resolves to a real sentence, not its catalog key");
        }

        var degraded = new ConnectionIssue(CouchCoop.Mod.Session.HeadlessClientManager.SharedUserDirCode, "", "", null, IsWarning: true,
            Timing: new ConnectionIssueTiming(ConnectionStage.Connecting, 0, 0, DateTimeOffset.UnixEpoch),
            Outcome: ConnectionIssueOutcome.Degraded);
        var row = new ConnectionStatusRow(Guid.NewGuid(), ConnectionStage.Connecting, 0, null, "Host service", 1, 6, degraded, 0, false);
        var color = typeof(CouchCoopConnectionPanel).GetMethod("RowColor", BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert((Godot.Color)color.Invoke(null, [2, row])! == CouchCoopGameUiTheme.ConnectionWarningOrange,
            "a degraded host row is painted as a warning, never as a failure");
        var text = ((string)typeof(CouchCoopConnectionPanel).GetMethod("RowText", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [row])!).Split('\n');
        Assert(text[0] == "Host service" && text[2].StartsWith("⚠", StringComparison.Ordinal),
            "…and marked with the warning glyph");
        Assert(text[3].StartsWith(CouchCoop.Mod.Session.HeadlessClientManager.SharedUserDirCode, StringComparison.Ordinal),
            "a host row has no attempt, so its fourth line carries the code rather than a fabricated step count");
    }

    private static string Copy(string member, ConnectionIssue issue)
        => (string)typeof(CouchCoopConnectionPanel).GetMethod(member, BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [issue])!;

    private static void DetailControlsStayInsideTheCompanionCard()
    {
        Assert(CouchCoopConnectionLayout.ButtonTop + 48f <= CouchCoopConnectionLayout.Height
            && CouchCoopConnectionLayout.FeedbackTop + 30f <= CouchCoopConnectionLayout.Height,
            "detail actions and feedback remain inside the 936-unit companion card");
        Assert(CouchCoopConnectionLayout.ListWithDetailsHeight < CouchCoopConnectionLayout.DetailTop - 60f,
            "an issue selection makes room for its structured details without overlaying the list");
        foreach (var expanded in new[] { false, true })
        {
            Assert(60 + CouchCoopConnectionLayout.ListHeightFor(true, expanded) < CouchCoopConnectionLayout.SummaryTopFor(expanded),
                "list and explanation never overlap in either disclosure state");
            Assert(CouchCoopConnectionLayout.SummaryTopFor(expanded) + CouchCoopConnectionLayout.SummaryHeight
                < CouchCoopConnectionLayout.DisclosureTopFor(expanded), "scrollable explanation stays above the disclosure");
        }
        Assert(CouchCoopConnectionLayout.ListHeightFor(false, false) == CouchCoopConnectionLayout.ListHeightFor(false, true)
            && 60 + CouchCoopConnectionLayout.ListHeightFor(false, false) == CouchCoopConnectionLayout.Height - CouchCoopConnectionLayout.Padding,
            "without a selected issue the list occupies the available card height");
    }

    private static void IssueRowsUseSavedStageAndKeepTheirFourthLineMeaningful()
    {
        CouchCoopLocalization.SetLanguageForTests("eng");
        var warning = new ConnectionIssue("browser-view-slow", "", "", null, IsWarning: true,
            Timing: new ConnectionIssueTiming(ConnectionStage.LoadingView, 1_900, 3_000, DateTimeOffset.UtcNow),
            Outcome: ConnectionIssueOutcome.Waiting);
        var warningLines = Row(new(ConnectionStage.Failed, 5, 6, 0), warning);
        Assert(warningLines.Length == 4 && warningLines[2].Contains("Loading game view", StringComparison.Ordinal)
            && warningLines[2].Contains("1s", StringComparison.Ordinal) && warningLines[3] == "Completed steps: 5/6 · Waiting",
            "warning rows use their saved stage and retain completed-step progress");

        var failed = new ConnectionIssue("native-disconnected", "", "", null,
            Timing: new ConnectionIssueTiming(ConnectionStage.Joining, 2_000, 4_000, DateTimeOffset.UtcNow));
        var failedLines = Row(new(ConnectionStage.Failed, 4, 6, 0), failed);
        Assert(failedLines.Length == 4 && failedLines[3] == "native-disconnected · Failed",
            "failed rows reserve their fourth line for the error code");
    }

    private static void ProblemIdentitySurvivesRefinementAndArchiving()
    {
        var registry = ConnectionRegistry.Shared;
        registry.Clear();
        try
        {
            var id = Guid.NewGuid();
            registry.Connected(id, "Device"); registry.BeginAttempt(id);
            registry.Fail(id, "browser-transport-lost", "Transport lost", "Retry");
            var key = CouchCoopConnectionPanel.Attention().Keys.Single();
            registry.Fail(id, "native-join-rejected", "Native cause", "Retry");
            Assert(CouchCoopConnectionPanel.Attention().Keys.Single() == key, "cause refinement is the same notification");
            registry.Disconnected(id);
            Assert(CouchCoopConnectionPanel.Attention().Keys.Single() == key, "archiving is the same notification");
            registry.Dismiss(registry.Snapshot().Rows.Single().Id);
            Assert(CouchCoopConnectionPanel.Attention().Count == 0, "dismissed issues clear the badge count");
        }
        finally { registry.Clear(); }
    }

    private static void OutcomeWordsAndStylingSurviveRecovery()
    {
        CouchCoopLocalization.SetLanguageForTests("eng");
        var issue = new ConnectionIssue("browser-view-slow", "", "", null, true,
            new(ConnectionStage.LoadingView, 30_000, 30_000, DateTimeOffset.UnixEpoch), ConnectionIssueOutcome.Recovered);
        var lines = Row(new(ConnectionStage.LoadingView, 3, 4, 500_000), issue);
        Assert(lines[2].Contains("30s", StringComparison.Ordinal) && lines[3].Contains("Recovered", StringComparison.Ordinal),
            "saved recovery retains its original timer and an explicit outcome word");
        var row = new ConnectionStatusRow(Guid.NewGuid(), ConnectionStage.LoadingView, 0, "", "", 3, 4, issue, 500_000, false);
        var color = typeof(CouchCoopConnectionPanel).GetMethod("RowColor", BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert((Godot.Color)color.Invoke(null, [2, row])! == CouchCoopGameUiTheme.ConnectionCompleteGreen,
            "recovered warnings use completion styling");
        Assert((Godot.Color)color.Invoke(null, [3, row])! == CouchCoopGameUiTheme.ConnectionProgressMuted
            && CouchCoopGameUiTheme.ConnectionProgressFontSize < CouchCoopGameUiTheme.ConnectionBodyFontSize,
            "the progress line keeps its quieter role on selected or recovered rows");
    }

    private static void ClipboardReportsWriteReadAndMismatchFailures()
    {
        var value = string.Empty;
        Assert(CouchCoopClipboard.TryCopy("report", text => value = text, () => value), "clipboard success reads back exact report");
        Assert(!CouchCoopClipboard.TryCopy("report", _ => throw new InvalidOperationException(), () => "report"), "clipboard write exception is reported");
        Assert(!CouchCoopClipboard.TryCopy("report", _ => { }, () => throw new InvalidOperationException()), "clipboard read exception is reported");
        Assert(!CouchCoopClipboard.TryCopy("report", _ => { }, () => "different"), "clipboard readback mismatch is reported");
    }

    private static void RowTextIsFourLinesAndOnlyCompletesWithCheckmark()
    {
        CouchCoopLocalization.SetLanguageForTests("eng");
        var connecting = Row(new(ConnectionStage.Connecting, 1, 6, 0));
        Assert(connecting.Length == 4 && !connecting.Any(line => line.Contains('✓')) && !connecting[2].Contains('('),
            "connecting row has stage text, four lines, and no completion checkmark or timer");

        Assert(connecting[3] == "Completed steps: 1/6", "progress fraction has a readable label");
        var loading = Row(new(ConnectionStage.LoadingView, 5, 6, 1_900));
        Assert(loading.Length == 4 && loading[2].Contains("1s", StringComparison.Ordinal) && !loading.Any(line => line.Contains('✓')),
            "loading row shows its stage timer without claiming completion");

        var complete = Row(new(ConnectionStage.Complete, 6, 6, 0));
        Assert(complete.Length == 4 && complete[3] == "✓", "only complete rows show the completion checkmark");
    }

    private static void CompanionCardGeometryKeepsTheQrCardCentred()
    {
        Assert(CouchCoopConnectionLayout.Width == 420f && CouchCoopConnectionLayout.Gap == 24f,
            "companion card uses the approved 420-unit width and 24-unit gap");
        var mainLeft = CouchCoopConnectionLayout.Left + CouchCoopConnectionLayout.Width + CouchCoopConnectionLayout.Gap;
        Assert(mainLeft == (1920f - CouchCoopConnectionLayout.MainCardWidth) / 2f,
            "the QR card remains centred in the 1920-unit design space");
        var scale = 1280f / 1920f;
        Assert(CouchCoopConnectionLayout.Left * scale >= 0f
               && (CouchCoopConnectionLayout.Left + CouchCoopConnectionLayout.Width + CouchCoopConnectionLayout.Gap
                   + CouchCoopConnectionLayout.MainCardWidth) * scale <= 1280f,
            "the pair remains within the scaled 1280-wide safe area");
    }

    private static string[] Row((ConnectionStage Stage, int Step, int Total, long StageElapsed) input, ConnectionIssue? issue = null)
    {
        var row = new ConnectionStatusRow(Guid.NewGuid(), input.Stage, 0, "A\nB", "Device\rName", input.Step, input.Total,
            issue, input.StageElapsed, true);
        var method = typeof(CouchCoopConnectionPanel).GetMethod("RowText", BindingFlags.Static | BindingFlags.NonPublic)
            ?? throw new MissingMethodException("CouchCoopConnectionPanel.RowText");
        return ((string)method.Invoke(null, [row])!).Split('\n');
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[ConnectionUiTests] FAILED: {message}");
    }
}
