using System.Reflection;
using System.Net;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.Tests;

internal static class InternalServerErrorReportTests
{
    public static async Task RunAsync()
    {
        await AsyncFrameIsReadableAsync();
        IteratorFrameIsReadable();
        GeneratedMethodsAreReadable();
        await AsyncLambdaIsReadableAsync();
        await AsyncLocalFunctionIsReadableAsync();
        WrappersAreUnwrapped();
        NoModFrameUsesOnlyExceptionType();
        FaultIdTracksThrowSite();
        OtherEnvelopesKeepTheirBytes();
        HtmlEncodesEveryField();
        LogPathHidesTheHomeFolder();
        CopyTextCarriesEveryField();
        ReportLinkMatchesWorkshopDiscussions();
        Console.WriteLine("internal server error reports: ok (13 cases)");
    }

    private static async Task AsyncFrameIsReadableAsync()
    {
        try { await ThrowAsync(); }
        catch (ApplicationException exception)
        {
            var report = InternalServerErrorReport.Create(null, exception);
            Expect(report.Fault == "ApplicationException in InternalServerErrorReportTests.ThrowAsync", "async frame uses the outer type and method");
            Expect(report.Route == "<unread>", "unread requests have a safe route fallback");
            Expect(DateTimeOffset.TryParse(report.Utc, out var utc) && utc.Offset == TimeSpan.Zero, "time is ISO-8601 UTC");
            Expect(Regex.IsMatch(report.Utc, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"), "time uses whole seconds and a UTC suffix");
        }
    }

    private static async Task ThrowAsync()
    {
        await Task.Yield();
        throw new ApplicationException("private test message");
    }

    private static void IteratorFrameIsReadable()
    {
        var exception = Capture(() => ThrowIterator().ToArray());
        Expect(InternalServerErrorReport.Create(null, exception).Fault
            == "ApplicationException in InternalServerErrorReportTests.ThrowIterator", "iterator frame uses the outer type and method");
    }

    private static IEnumerable<int> ThrowIterator()
    {
        yield return 1;
        throw new ApplicationException("private test message");
    }

    private static void GeneratedMethodsAreReadable()
    {
        var lambda = Capture(() => throw new ApplicationException("private test message"));
        var local = Capture(ThrowLocal);
        Expect(InternalServerErrorReport.Create(null, lambda).Fault
            == "ApplicationException in InternalServerErrorReportTests.GeneratedMethodsAreReadable", "lambda identifies its containing method");
        Expect(InternalServerErrorReport.Create(null, local).Fault
            == "ApplicationException in InternalServerErrorReportTests.GeneratedMethodsAreReadable", "local function identifies its containing method");

        static void ThrowLocal() => throw new ApplicationException("private test message");
    }

    private static async Task AsyncLambdaIsReadableAsync()
    {
        Func<Task> action = async () =>
        {
            await Task.Yield();
            throw new ApplicationException("private test message");
        };
        try { await action(); }
        catch (ApplicationException exception)
        {
            var report = InternalServerErrorReport.Create(null, exception);
            Expect(report.Fault == "ApplicationException in InternalServerErrorReportTests.AsyncLambdaIsReadableAsync", "async lambda identifies its containing method");
            Expect(!report.Fault.Contains('<') && !report.Fault.Contains('>'), "async lambda omits generated name brackets");
            return;
        }
        throw new InvalidOperationException("Expected an ApplicationException");
    }

    private static async Task AsyncLocalFunctionIsReadableAsync()
    {
        try { await ThrowLocalAsync(); }
        catch (ApplicationException exception)
        {
            var report = InternalServerErrorReport.Create(null, exception);
            Expect(report.Fault == "ApplicationException in InternalServerErrorReportTests.AsyncLocalFunctionIsReadableAsync", "async local function identifies its containing method");
            Expect(!report.Fault.Contains('<') && !report.Fault.Contains('>'), "async local function omits generated name brackets");
            return;
        }
        throw new InvalidOperationException("Expected an ApplicationException");

        static async Task ThrowLocalAsync()
        {
            await Task.Yield();
            throw new ApplicationException("private test message");
        }
    }

    private static void WrappersAreUnwrapped()
    {
        var exception = Capture(ThrowFirst);
        var direct = InternalServerErrorReport.Create(null, exception);
        var wrapped = InternalServerErrorReport.Create(null,
            new AggregateException(new TargetInvocationException(new AggregateException(exception))));
        Expect(wrapped.Fault == direct.Fault && wrapped.FaultId == direct.FaultId, "single aggregate and invocation wrappers unwrap recursively");
        var multiple = InternalServerErrorReport.Create(null, new AggregateException(exception, exception));
        Expect(multiple.Fault == "AggregateException", "multiple aggregate causes are not reduced to one");
    }

    private static void NoModFrameUsesOnlyExceptionType()
    {
        var report = InternalServerErrorReport.Create(null, new InvalidOperationException("secret"));
        Expect(report.Fault == "InvalidOperationException", "no stack falls back to exception type");
    }

    private static void FaultIdTracksThrowSite()
    {
        var reports = new List<InternalServerErrorReport>();
        for (var i = 0; i < 2; i++) reports.Add(InternalServerErrorReport.Create(null, Capture(ThrowFirst)));
        var other = InternalServerErrorReport.Create(null, Capture(ThrowSecond));
        Expect(reports[0].FaultId == reports[1].FaultId, "the same throw site has a stable fault id");
        Expect(reports[0].Incident != reports[1].Incident, "each failure gets its own incident");
        Expect(reports[0].FaultId != other.FaultId, "different throw sites have different fault ids");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ThrowFirst() => throw new ApplicationException("private test message");

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ThrowSecond() => throw new ApplicationException("another private message");

    private static Exception Capture(Action action)
    {
        try { action(); }
        catch (ApplicationException exception) { return exception; }
        throw new Exception("Expected an ApplicationException");
    }

    private static void OtherEnvelopesKeepTheirBytes()
        => Expect(BrowserJson.Serialize(new BrowserErrorEnvelope("error", "http", "bad-request", "Try again."))
            == "{\"type\":\"error\",\"requestId\":\"http\",\"code\":\"bad-request\",\"message\":\"Try again.\"}", "optional diagnostics do not change existing envelope bytes");

    private static void HtmlEncodesEveryField()
    {
        var values = new[] { "<incident>&\"'", "<fault>&\"'", "<id>&\"'", "<version>&\"'", "<route>&\"'", "<utc>&\"'", "<game>&\"'", "<log>&\"'" };
        var html = new InternalServerErrorReport(values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7]).ToHtml();
        foreach (var value in values)
            Expect(html.Contains(WebUtility.HtmlEncode(value), StringComparison.Ordinal)
                && !html.Contains(value, StringComparison.Ordinal), "HTML encodes every diagnostic field");
    }

    private static void LogPathHidesTheHomeFolder()
    {
        const string appData = @"C:\Users\Tomas\AppData\Roaming";
        const string profile = @"C:\Users\Tomas";
        Expect(InternalServerErrorReport.DisplayLogPath("C:/Users/Tomas/AppData/Roaming/SlayTheSpire2/logs/godot.log", true, appData, profile)
            == @"%APPDATA%\SlayTheSpire2\logs\godot.log", "Windows: Godot's forward-slash path under AppData uses %APPDATA% and backslashes");
        Expect(InternalServerErrorReport.DisplayLogPath(@"c:\users\tomas\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log", true, appData, profile)
            == @"%USERPROFILE%\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log", "Windows: a seat log under the profile uses %USERPROFILE%, case-insensitively");
        Expect(InternalServerErrorReport.DisplayLogPath("D:/Games/SlayTheSpire2/logs/godot.log", true, appData, profile)
            == @"D:\Games\SlayTheSpire2\logs\godot.log", "Windows: a path outside the profile is shown as-is");
        Expect(InternalServerErrorReport.DisplayLogPath("/home/tomas/.local/share/SlayTheSpire2/logs/godot.log", false, null, "/home/tomas/")
            == "~/.local/share/SlayTheSpire2/logs/godot.log", "Linux: the home folder becomes ~");
        Expect(InternalServerErrorReport.DisplayLogPath("/Users/tomas/Library/Application Support/SlayTheSpire2/logs/godot.log", false, null, "/Users/tomas")
            == "~/Library/Application Support/SlayTheSpire2/logs/godot.log", "macOS: the home folder becomes ~");
        Expect(InternalServerErrorReport.DisplayLogPath("/home/tomasx/godot.log", false, null, "/home/tomas")
            == "/home/tomasx/godot.log", "only a whole home-folder segment is replaced");
        Expect(InternalServerErrorReport.DisplayLogPath(null, false, null, "/home/tomas") is null
            && InternalServerErrorReport.DisplayLogPath(" ", true, appData, profile) is null, "no resolved log path shows none");
    }

    private static void CopyTextCarriesEveryField()
    {
        var report = new InternalServerErrorReport("E-ABC123", "NullReferenceException in VisitIdTag.Inject", "0badc0de",
            "1.0.0+abc", "/", "2026-11-23T16:24:49Z", "v0.103.2", @"%APPDATA%\SlayTheSpire2\logs\godot.log");
        Expect(report.ToText() == string.Join('\n',
            "Couch Co-op error E-ABC123",
            "Fault: NullReferenceException in VisitIdTag.Inject (0badc0de)",
            "Mod version: 1.0.0+abc",
            "Game version: v0.103.2",
            "Page: /",
            "Time: 2026-11-23T16:24:49Z",
            @"Log file: %APPDATA%\SlayTheSpire2\logs\godot.log"), "copy text lists every field, one per line");
        var html = report.ToHtml();
        Expect(html.Contains(WebUtility.HtmlEncode(report.ToText()), StringComparison.Ordinal), "the page's copy source is the copy text");
        var bare = report with { GameVersion = null, LogPath = null };
        Expect(bare.ToText().Contains("Game version: unknown", StringComparison.Ordinal)
            && !bare.ToText().Contains("Log file", StringComparison.Ordinal), "missing facts degrade to unknown / omitted");
        Expect(bare.ToHtml().Contains("godot.log", StringComparison.Ordinal), "without a resolved path the page still names godot.log");
    }

    private static void ReportLinkMatchesWorkshopDiscussions()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CouchCoop.sln"))) dir = dir.Parent;
        Expect(dir is not null, "repo root (CouchCoop.sln) is reachable from the test binary");
        using var json = System.Text.Json.JsonDocument.Parse(
            File.ReadAllText(Path.Combine(dir!.FullName, "workshop", "discussions", "discussions.json")));
        Expect(json.RootElement.GetProperty("posts").GetProperty("reporting-a-problem").GetString()
            == InternalServerErrorReport.ReportProblemUrl, "the error page links the live reporting-a-problem discussion");
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
