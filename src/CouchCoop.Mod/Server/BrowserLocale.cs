namespace CouchCoop.Mod.Server;

/// <summary>
/// Picks the native catalog for a page the SERVER renders for a browser, from the request's
/// <c>Accept-Language</c>. The rules mirror <c>frontend/src/i18n/locale.ts</c> (<c>supportedLocaleFor</c>) so a
/// server page and the SPA agree on one phone's language; change both together.
/// </summary>
internal static class BrowserLocale
{
    /// <summary>The native catalog code (the game's language id) for the first supported tag, else English.</summary>
    public static string CatalogLanguage(string? acceptLanguage)
    {
        foreach (var tag in TagsInPreferenceOrder(acceptLanguage))
        {
            if (CatalogFor(tag) is { } language) return language;
        }
        return "eng";
    }

    /// <summary>The BCP-47 tag a page in that catalog's language declares in <c>&lt;html lang&gt;</c>.</summary>
    public static string HtmlLanguage(string catalogLanguage) => catalogLanguage switch
    {
        "zhs" => "zh-Hans",
        "deu" => "de",
        "esp" => "es-419", // the game's `esp` is Latin-American Spanish
        "spa" => "es-ES",  // and `spa` is Spain's
        "fra" => "fr",
        "ita" => "it",
        "jpn" => "ja",
        "kor" => "ko",
        "pol" => "pl",
        "ptb" => "pt-BR",
        "rus" => "ru",
        "tha" => "th",
        "tur" => "tr",
        _ => "en",
    };

    internal static string? CatalogFor(string rawTag)
    {
        var tag = rawTag.Trim().Replace('_', '-').ToLowerInvariant();
        if (tag.Length == 0) return null;
        static bool Is(string tag, string language) => tag == language || tag.StartsWith(language + "-", StringComparison.Ordinal);
        if (Is(tag, "en")) return "eng";
        // Traditional Chinese is deliberately NOT folded into Simplified.
        if (tag is "zh" or "zh-cn" or "zh-sg" or "zh-hans") return "zhs";
        if (Is(tag, "de")) return "deu";
        if (Is(tag, "fr")) return "fra";
        if (Is(tag, "it")) return "ita";
        if (Is(tag, "ja")) return "jpn";
        if (Is(tag, "ko")) return "kor";
        if (Is(tag, "pl")) return "pol";
        if (Is(tag, "ru")) return "rus";
        if (Is(tag, "th")) return "tha";
        if (Is(tag, "tr")) return "tur";
        if (tag is "pt" or "pt-br") return "ptb";
        if (tag is "es" or "es-es") return "spa";
        if (tag is "es-419" or "es-us" or "es-ar" or "es-bo" or "es-cl" or "es-co" or "es-cr" or "es-cu" or "es-do"
            or "es-ec" or "es-gt" or "es-hn" or "es-mx" or "es-ni" or "es-pa" or "es-pe" or "es-pr" or "es-py"
            or "es-sv" or "es-uy" or "es-ve")
            return "esp";
        return null;
    }

    // q-ordered, stable for equal weights; q=0 means "not this one". Malformed weights count as q=1, as browsers
    // only ever send well-formed ones and a hand-written header should still get its first choice.
    private static IEnumerable<string> TagsInPreferenceOrder(string? header)
    {
        if (string.IsNullOrWhiteSpace(header)) return [];
        return header.Split(',')
            .Select((part, index) =>
            {
                var pieces = part.Split(';');
                var weight = 1.0;
                foreach (var parameter in pieces.Skip(1))
                {
                    var kv = parameter.Trim();
                    if (kv.StartsWith("q=", StringComparison.OrdinalIgnoreCase)
                        && double.TryParse(kv[2..], System.Globalization.NumberStyles.Float,
                            System.Globalization.CultureInfo.InvariantCulture, out var q))
                        weight = q;
                }
                return (Tag: pieces[0].Trim(), Weight: weight, Index: index);
            })
            .Where(entry => entry.Tag.Length > 0 && entry.Tag != "*" && entry.Weight > 0)
            .OrderByDescending(entry => entry.Weight)
            .ThenBy(entry => entry.Index)
            .Select(entry => entry.Tag)
            .ToArray();
    }
}
