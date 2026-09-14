using System.Text.RegularExpressions;
using CouchCoop.Mod.Activity;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server;

internal static class CouchCoopLocalizationTests
{
    public static void Run()
    {
        CatalogsStayInParityAndUseSafePlaceholders();
        ShippedCatalogsDoNotTranslateThePlaceholdersThemselves();
        LocaleSelectionFallsBackToEnglish();
        StructuredActivityRerendersAfterLocaleChange();
        SemanticMappingsAndFontPredicateUseTheLocale();
        Console.WriteLine("CouchCoopLocalizationTests: ok");
    }

    private static void SemanticMappingsAndFontPredicateUseTheLocale()
    {
        foreach (var language in new[] { "zhs", "jpn", "kor", "rus", "tha" })
        {
            Assert(CouchCoopGameUiTheme.ShouldUseLocaleFont(language), $"{language} selects the substitute font");
        }
        Assert(!CouchCoopGameUiTheme.ShouldUseLocaleFont("eng") && !CouchCoopGameUiTheme.ShouldUseLocaleFont("fra"), "Latin locales keep Kreon/default fonts");
        CouchCoopLocalization.SetLanguageForTests("eng");
        Assert(CouchCoopActivityMessages.DescribeJoinRejection("no-free-instance").Resolve() == "every player slot is in use", "known rejection maps to its English catalog entry");
        Assert(CouchCoopSecureText.ProviderUnavailable.Resolve() == "No internet, or the certificate service is down.", "known secure status resolves from the English catalog");
        CouchCoopLocalization.SetLanguageForTests("zhs");
        Assert(CouchCoopActivityMessages.DescribeJoinRejection("no-free-instance").Resolve().Contains("玩家位置", StringComparison.Ordinal), "known rejection maps in Chinese");
        Assert(CouchCoopSecureText.AddressIneligible.Resolve().Contains("网络地址", StringComparison.Ordinal), "known secure status is semantic Chinese copy");
        Assert(CouchCoopSecureText.ProviderUnavailable.Resolve().Contains("证书服务", StringComparison.Ordinal), "provider failure remains structured and selects Chinese at resolution");
        var status = new SecureOriginStatus(SecureOriginState.Unavailable, CouchCoopSecureText.ProviderUnavailable, null);
        Assert(status.Text.Key == "couchcoop_secure_provider_unavailable" && status.Reason.Contains("证书服务", StringComparison.Ordinal),
            "secure status stores semantic text and resolves only at the UI boundary");
        Assert(CouchCoopSecureText.ProviderUnavailable.ResolveForLanguage(CouchCoopLocalization.EnglishLanguage)
            == "No internet, or the certificate service is down.",
            "developer diagnostics can resolve semantic status in English while the UI is Chinese");
        Assert(CouchCoopActivityMessages.SecureOriginUnavailable(null).Resolve() == "安全（https）链接不可用。",
            "the no-reason secure activity event is a complete Chinese sentence without a synthetic argument");
        var blocker = QrHostOptions.DescribeSecureFor(new QrAdapterInfo("Wi-Fi", QrAdapterKind.Wifi, System.Net.IPAddress.Parse("127.0.0.1")), null, 0, CouchCoopSecureText.Pending);
        Assert(blocker.Detail.Contains("网络地址", StringComparison.Ordinal), "localized QR blocker detail resolves late");
        var tip = QrHoverTipCopy.MethodTipFor(new QrHostOption("host", 1, QrHostOptionKind.Secure, null));
        Assert(QrHoverTipCopy.TitleEntries[tip.TitleKey].Contains("安全", StringComparison.Ordinal)
            && tip.Description.Contains("安全", StringComparison.Ordinal), "tooltip titles and descriptions follow Chinese");
        Assert(QrHoverTipCopy.MethodWebDescription.Contains("明确接受", StringComparison.Ordinal)
            && QrHoverTipCopy.MethodSecureDescription.Contains("路由器", StringComparison.Ordinal)
            && QrHoverTipCopy.MethodMdnsDescription.Contains("最不可靠", StringComparison.Ordinal),
            "Chinese hover guidance retains permission, router, and reliability details");
        CouchCoopLocalization.SetLanguageForTests("eng");
    }

    private static void CatalogsStayInParityAndUseSafePlaceholders()
    {
        var english = CouchCoopLocalization.CatalogFor("eng");
        Assert(CouchCoopLocalization.SupportedLanguages.Count == 14, "all current game languages have a CouchCoop catalog");
        foreach (var language in CouchCoopLocalization.SupportedLanguages)
        {
            var catalog = CouchCoopLocalization.CatalogFor(language);
            Assert(english.Keys.Order().SequenceEqual(catalog.Keys.Order()), $"English and {language} catalogs have identical keys");
            foreach (var key in english.Keys)
            {
                Assert(key.StartsWith("couchcoop_", StringComparison.Ordinal), $"{key} stays in the collision-safe namespace");
                Assert(!string.IsNullOrWhiteSpace(english[key]) && !string.IsNullOrWhiteSpace(catalog[key]), $"{key} is nonblank in English and {language}");
                Assert(Placeholders(english[key]).SequenceEqual(Placeholders(catalog[key])), $"{key} has matching named placeholders in {language}");
            }
        }
    }

    /// <summary>
    /// The same parity question asked of the catalogs AS SHIPPED, before
    /// <c>CouchCoopLocalization</c>'s normalizer has been near them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="CatalogsStayInParityAndUseSafePlaceholders"/> cannot see a translated placeholder, and
    /// nine catalogs had shipped with one: a translator had localized the TOKEN as well as the prose
    /// (<c>{nombre}</c>, <c>{名前}</c>, <c>{powód}</c>), which substitutes by English name and so never
    /// resolves. Both of that test's instruments hide it — it reads the catalog through
    /// <c>CatalogFor</c>, i.e. already normalized, and its placeholder pattern only matches ASCII names,
    /// so a non-ASCII token is invisible to it entirely.
    /// </para>
    /// <para>
    /// The normalizer's repair is not a defence either, which is the point of asserting on the raw text.
    /// It DELETES an unexpected ASCII token and APPENDS the missing one to the end of the string, so the
    /// line still renders — with the player's name stranded after the full stop — and a non-ASCII token
    /// it cannot match survives into the panel verbatim, beside the appended name. Silently wrong output
    /// in nine languages is exactly the failure a parity test is supposed to make loud.
    /// </para>
    /// </remarks>
    private static void ShippedCatalogsDoNotTranslateThePlaceholdersThemselves()
    {
        var english = RawCatalog("en");
        foreach (var language in CatalogFileStems)
        {
            var catalog = RawCatalog(language);
            foreach (var (key, value) in english)
            {
                Assert(
                    AnyPlaceholders(value).SequenceEqual(AnyPlaceholders(catalog[key])),
                    $"{key} in {language} uses English placeholder names, not translated ones");
            }
        }
    }

    private static IReadOnlyDictionary<string, string> RawCatalog(string stem)
    {
        var name = $"CouchCoop.Mod.Localization.Catalogs.couchcoop.{stem}.json";
        using var stream = typeof(CouchCoopLocalization).Assembly.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"Missing embedded localization catalog '{name}'.");
        return System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(stream)
            ?? throw new InvalidOperationException($"Localization catalog '{name}' was empty.");
    }

    /// <summary>File stems of every shipped catalog except English, which is the reference.</summary>
    private static readonly string[] CatalogFileStems =
        ["zhs", "deu", "esp", "fra", "ita", "jpn", "kor", "pol", "ptb", "rus", "spa", "tha", "tur"];

    /// <summary>
    /// Every <c>{…}</c> token, whatever alphabet it is written in — unlike <see cref="Placeholders"/>,
    /// whose ASCII-only pattern is what let the non-Latin cases through.
    /// </summary>
    private static IEnumerable<string> AnyPlaceholders(string value)
        => Regex.Matches(value, "\\{([^\\s{}]+)\\}").Select(match => match.Groups[1].Value).Order();

    private static void LocaleSelectionFallsBackToEnglish()
    {
        Assert(CouchCoopLocalization.SelectCatalogLanguage("zhs") == "zhs", "the game zhs locale selects Simplified Chinese");
        Assert(CouchCoopLocalization.SelectCatalogLanguage("jpn") == "jpn", "the game jpn locale selects Japanese");
        Assert(CouchCoopLocalization.SelectCatalogLanguage("unknown") == "eng", "unsupported game locales fall back to English");
        Assert(CouchCoopLocalization.SelectCatalogLanguage(null) == "eng", "missing game localization falls back to English");
        CouchCoopLocalization.SetLanguageForTests("unknown");
        Assert(CouchCoopSecureText.ProviderUnavailable.Resolve() == "No internet, or the certificate service is down.", "unsupported game locales resolve native copy in English");
        CouchCoopLocalization.SetLanguageForTests("eng");
    }

    private static void StructuredActivityRerendersAfterLocaleChange()
    {
        CouchCoopActivityLog.Reset();
        CouchCoopLocalization.SetLanguageForTests("eng");
        CouchCoopActivityLog.Append(CouchCoopActivityCategory.Viewer, CouchCoopActivitySeverity.Info,
            CouchCoopActivityMessages.ViewerConnected("Ann"));
        var retained = CouchCoopActivityLog.Snapshot().Single();
        Assert(retained.Text.Key == "couchcoop_activity_viewer_connected", "activity retains a catalog key rather than resolved copy");
        Assert(retained.Message == "Ann connected.", "English resolves at paint time");

        CouchCoopLocalization.SetLanguageForTests("zhs");
        Assert(retained.Message == "Ann 已连接。", "the retained row rerenders after a locale revision");
        CouchCoopLocalization.SetLanguageForTests("eng");
        CouchCoopActivityLog.Reset();
    }

    private static IEnumerable<string> Placeholders(string value)
        => Regex.Matches(value, "\\{([A-Za-z][A-Za-z0-9_-]*)\\}").Select(match => match.Groups[1].Value).Order();

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
