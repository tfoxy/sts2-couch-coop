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
        CompanionCardGeometryKeepsTheQrCardCentred();
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

    private static string[] Row((ConnectionStage Stage, int Step, int Total, long StageElapsed) input)
    {
        var row = new ConnectionStatusRow(Guid.NewGuid(), input.Stage, 0, "A\nB", "Device\rName", input.Step, input.Total,
            null, input.StageElapsed, true);
        var method = typeof(CouchCoopConnectionPanel).GetMethod("RowText", BindingFlags.Static | BindingFlags.NonPublic)
            ?? throw new MissingMethodException("CouchCoopConnectionPanel.RowText");
        return ((string)method.Invoke(null, [row])!).Split('\n');
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[ConnectionUiTests] FAILED: {message}");
    }
}
