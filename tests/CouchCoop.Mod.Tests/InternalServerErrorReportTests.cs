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
        BrowserLocaleFollowsTheFrontendRules();
        PageUsesTheRequestedCatalog();
        Console.WriteLine("internal server error reports: ok (15 cases)");
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
            "Time: 2026-11-23T16:24:49Z"), "copy text lists every field, one per line, without the log path");
        var html = report.ToHtml();
        Expect(html.Contains(WebUtility.HtmlEncode(report.ToText()), StringComparison.Ordinal), "the page's copy source is the copy text");
        Expect(html.Contains(WebUtility.HtmlEncode(report.LogPath!), StringComparison.Ordinal)
            && html.Contains("also upload this log file", StringComparison.Ordinal), "the page shows the real log path and asks for it");
        var bare = report with { GameVersion = null, LogPath = null };
        Expect(bare.ToText().Contains("Game version: unknown", StringComparison.Ordinal)
            && !bare.ToText().Contains("godot.log", StringComparison.Ordinal), "missing facts degrade to unknown; the copy text never names the log");
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

    private static void BrowserLocaleFollowsTheFrontendRules()
    {
        foreach (var (header, expected) in new (string?, string)[]
        {
            (null, "eng"), ("", "eng"), ("*", "eng"), ("garbage;;,", "eng"), ("en-GB", "eng"),
            ("es", "spa"), ("es-ES", "spa"), ("es-MX", "esp"), ("es-419", "esp"), ("es-US", "esp"),
            ("es-CO,en;q=0.5", "esp"), ("pt", "ptb"), ("pt-BR", "ptb"), ("pt-PT", "eng"),
            ("zh-CN", "zhs"), ("zh-Hans-CN", "eng"), ("zh-TW", "eng"), ("zh-TW,fr;q=0.8", "fra"), ("zh_cn", "zhs"),
            ("de-AT", "deu"), ("ja-JP", "jpn"), ("ko", "kor"), ("pl", "pol"), ("ru-RU", "rus"), ("th", "tha"), ("tr-TR", "tur"),
            ("fr;q=0.5,it;q=0.9", "ita"), ("de;q=0,fr", "fra"), ("fr;q=0.8,de;q=0.8", "fra"),
        })
            Expect(BrowserLocale.CatalogLanguage(header) == expected, $"Accept-Language '{header}' picks {expected}");
        Expect(BrowserLocale.HtmlLanguage("esp") == "es-419" && BrowserLocale.HtmlLanguage("spa") == "es-ES"
            && BrowserLocale.HtmlLanguage("zhs") == "zh-Hans" && BrowserLocale.HtmlLanguage("eng") == "en", "catalog codes map to BCP-47");
        foreach (var language in CouchCoop.Mod.Localization.CouchCoopLocalization.SupportedLanguages)
            Expect(BrowserLocale.HtmlLanguage(language) is { Length: > 0 } tag
                && (language == "eng" || tag != "en"), $"{language} has its own html lang");
    }

    private static void PageUsesTheRequestedCatalog()
    {
        var report = new InternalServerErrorReport("E-ABC123", "NullReferenceException in VisitIdTag.Inject", "0badc0de",
            "1.0.0+abc", "/", "2026-11-23T16:24:49Z", null, null);
        foreach (var language in CouchCoop.Mod.Localization.CouchCoopLocalization.SupportedLanguages)
        {
            var catalog = CouchCoop.Mod.Localization.CouchCoopLocalization.CatalogFor(language);
            var html = report.ToHtml(language);
            foreach (var key in new[] { "title", "intro", "incident", "fault", "fault_id", "mod_version", "game_version", "page", "time", "unknown", "copy", "open_discussion", "details_label" })
                Expect(html.Contains(WebUtility.HtmlEncode(catalog["couchcoop_error_page_" + key]), StringComparison.Ordinal), $"{language} page shows {key}");
            Expect(html.Contains("<code>godot.log</code>", StringComparison.Ordinal) && html.Contains("<code>logs</code>", StringComparison.Ordinal)
                && !html.Contains("{file}", StringComparison.Ordinal) && !html.Contains("{folder}", StringComparison.Ordinal), $"{language} fills the log placeholders");
            Expect(html.Contains(System.Text.Json.JsonSerializer.Serialize(catalog["couchcoop_error_page_copied"]), StringComparison.Ordinal)
                && html.Contains(System.Text.Json.JsonSerializer.Serialize(catalog["couchcoop_error_page_copy_manual"]), StringComparison.Ordinal),
                $"{language} script carries its status messages");
            Expect(html.Contains(WebUtility.HtmlEncode(report.ToText()), StringComparison.Ordinal), $"{language} copy block stays English");
        }
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
