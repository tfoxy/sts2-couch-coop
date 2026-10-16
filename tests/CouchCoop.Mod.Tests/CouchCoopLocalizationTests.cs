using System.Text.RegularExpressions;
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
        GuidedSetupCopyPreservesTrustAndPlatformSteps();
        GuidedHelpHasLocalizedHeadingsAndNumberedRemovalSteps();
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
        Assert(CouchCoopSecureText.ProviderUnavailable.Resolve() == "No internet, or the certificate service is down.", "known secure status resolves from the English catalog");
        CouchCoopLocalization.SetLanguageForTests("zhs");
        Assert(CouchCoopSecureText.AddressIneligible.Resolve().Contains("网络地址", StringComparison.Ordinal), "known secure status is semantic Chinese copy");
        Assert(CouchCoopSecureText.ProviderUnavailable.Resolve().Contains("证书服务", StringComparison.Ordinal), "provider failure remains structured and selects Chinese at resolution");
        var status = new SecureOriginStatus(SecureOriginState.Unavailable, CouchCoopSecureText.ProviderUnavailable, null);
        Assert(status.Text.Key == "couchcoop_secure_provider_unavailable" && status.Reason.Contains("证书服务", StringComparison.Ordinal),
            "secure status stores semantic text and resolves only at the UI boundary");
        Assert(CouchCoopSecureText.ProviderUnavailable.ResolveForLanguage(CouchCoopLocalization.EnglishLanguage)
            == "No internet, or the certificate service is down.",
            "developer diagnostics can resolve semantic status in English while the UI is Chinese");
        var blocker = QrHostOptions.DescribeSecureFor(new QrAdapterInfo("Wi-Fi", QrAdapterKind.Wifi, System.Net.IPAddress.Parse("127.0.0.1")), null, 0, CouchCoopSecureText.Pending);
        Assert(blocker.Detail.Contains("网络地址", StringComparison.Ordinal), "localized QR blocker detail resolves late");
        var tip = QrHoverTipCopy.MethodTipFor(new QrHostOption("host", 1, QrHostOptionKind.Secure, null));
        Assert(QrHoverTipCopy.TitleEntries[tip.TitleKey] == "域名"
            && tip.Description.Contains("浏览器", StringComparison.Ordinal), "tooltip titles and descriptions follow Chinese");
        Assert(QrHoverTipCopy.MethodWebDescription.Contains("明确接受", StringComparison.Ordinal)
            && QrHoverTipCopy.MethodSecureDescription.Contains("路由器", StringComparison.Ordinal)
            && QrHoverTipCopy.MethodMdnsDescription.Contains("最不可靠", StringComparison.Ordinal),
            "Chinese hover guidance retains permission, router, and reliability details");
        Assert(QrSelectionModel.MethodLabel("direct-https").Resolve() == "直接地址（HTTPS）",
            "direct-IP method label follows Chinese");
        Assert(CouchCoopLocalization.Resolve("couchcoop_https_install_iphone").Contains("证书信任设置")
            && CouchCoopLocalization.Resolve("couchcoop_https_install_windows").Contains("当前用户"),
            "structured device instructions retain localized trust settings and Windows user scope");
        CouchCoopLocalization.SetLanguageForTests("eng");
    }

    private static void GuidedSetupCopyPreservesTrustAndPlatformSteps()
    {
        var english = CouchCoopLocalization.CatalogFor("eng");
        Assert(english["couchcoop_https_ca_explanation"].Contains("certificate authority (CA)")
            && english["couchcoop_https_trust_notice"].Contains("beyond this game"),
            "guide explains CA and the broader trust consequence");
        Assert(english["couchcoop_https_install_windows"].Contains("Current User")
            && english["couchcoop_https_install_windows"].Contains("Trusted Root Certification Authorities"),
            "Windows guide names the user-scoped trusted-root store");
        Assert(english["couchcoop_https_install_iphone"].Contains("enable full trust")
            && english["couchcoop_https_install_iphone"].Contains("alone is not enough"),
            "iOS installation and full trust are distinct steps");
        Assert(english["couchcoop_https_verify_iphone"].Contains("authenticated transfer")
            && english["couchcoop_https_verify_android"].Contains("filename alone"),
            "phone verification fallback preserves an authenticated transfer requirement");
        Assert(english["couchcoop_https_certificate_warning"].Contains("Do not bypass")
            && english["couchcoop_https_connect_body"].Contains("cannot check"),
            "guide never substitutes acknowledgment for trust or bypasses warnings");
        foreach (var language in CouchCoopLocalization.SupportedLanguages)
        {
            var catalog = CouchCoopLocalization.CatalogFor(language);
            Assert(catalog["couchcoop_https_ca_explanation"].Contains("CA"), $"{language} explains the CA acronym");
            foreach (var device in Enum.GetValues<DirectIpSetupDevice>())
            {
                var suffix = DirectIpSetupCopy.DeviceKey(device);
                Assert(catalog["couchcoop_https_install_" + suffix].Contains('\n'),
                    $"{language} separates {suffix} installation steps");
                Assert(!string.IsNullOrWhiteSpace(catalog["couchcoop_https_verify_" + suffix]),
                    $"{language} provides {suffix} file verification instructions");
            }
            Assert(catalog["couchcoop_https_verify_windows"].Contains("certutil -hashfile \"PATH\" SHA256")
                && catalog["couchcoop_https_verify_macos"].Contains("shasum -a 256 \"PATH\"")
                && catalog["couchcoop_https_verify_linux"].Contains("sha256sum \"PATH\""),
                $"{language} keeps verification commands intact");
            var expiry = CouchCoopText.Create("couchcoop_https_expiry",
                ("expiry", CouchCoopTextArgument.Value("2030-01-01"))).ResolveForLanguage(language);
            var path = CouchCoopText.Create("couchcoop_https_file_location",
                ("path", CouchCoopTextArgument.Value("/test/public.cer"))).ResolveForLanguage(language);
            Assert(expiry.Contains("2030-01-01") && path.Contains("/test/public.cer"),
                $"{language} preserves identity details without translating placeholders");
        }
    }

    private static void GuidedHelpHasLocalizedHeadingsAndNumberedRemovalSteps()
    {
        var english = RawCatalog("en");
        var helpKeys = english.Keys.Where(key => key.StartsWith("couchcoop_https_help_", StringComparison.Ordinal)).ToArray();
        Assert(helpKeys.Length == 20, "guided help provides separate headings, stage guidance and platform removal blocks");
        Assert(english["couchcoop_https_help_remove_intro"].Contains("CouchCoop Local Authority")
            && english["couchcoop_https_help_remove_intro"].Contains("do not remove other certificates"),
            "removal identifies this host and protects unrelated certificates");
        Assert(english["couchcoop_https_help_remove_windows"].Contains("Certificates - Current User")
            && english["couchcoop_https_help_remove_android"].Contains("Do not use Clear credentials"),
            "removal keeps Windows user scope and avoids Android's remove-all action");
        Assert(english["couchcoop_https_help_warning_body"].Contains("enable full trust")
            && english["couchcoop_https_help_warning_body"].Contains("Do not bypass"),
            "warning recovery distinguishes trust from installation without bypassing validation");
        foreach (var stem in CatalogFileStems.Prepend("en"))
        {
            var catalog = RawCatalog(stem);
            foreach (var key in helpKeys)
            {
                Assert(catalog.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value),
                    $"{stem} ships {key} without relying on fallback");
                if (stem != "en")
                    Assert(value != english[key], $"{stem} translates {key} rather than shipping an English placeholder");
                if (key.EndsWith("_title", StringComparison.Ordinal))
                    Assert(!value!.Contains('\n'), $"{stem} keeps {key} as an independent heading");
            }
            foreach (var device in Enum.GetValues<DirectIpSetupDevice>())
            {
                var suffix = DirectIpSetupCopy.DeviceKey(device);
                var steps = catalog["couchcoop_https_help_remove_" + suffix].Split('\n');
                Assert(steps.Length >= 2 && steps.Select((step, index) =>
                        step.StartsWith($"{index + 1}. ", StringComparison.Ordinal)).All(valid => valid),
                    $"{stem} provides separately numbered {suffix} removal steps");
            }
            Assert(catalog["couchcoop_https_help_remove_intro"].Contains("CouchCoop Local Authority")
                && catalog["couchcoop_https_help_remove_windows"].Contains("certmgr.msc"),
                $"{stem} preserves the certificate name and Windows command");
            Assert(catalog["couchcoop_https_help_first_prepare"].Contains(catalog["couchcoop_https_create_file"])
                && catalog["couchcoop_https_help_first_device"].Contains(catalog["couchcoop_https_show_file"])
                && catalog["couchcoop_https_help_first_connect"].Contains(catalog["couchcoop_https_another_device"]),
                $"{stem} points first-time users to the actual translated button labels");
        }
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


    private static IEnumerable<string> Placeholders(string value)
        => Regex.Matches(value, "\\{([A-Za-z][A-Za-z0-9_-]*)\\}").Select(match => match.Groups[1].Value).Order();

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
