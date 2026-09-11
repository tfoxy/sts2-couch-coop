using System.Reflection;
using System.Text.Json;
using MegaCrit.Sts2.Core.Localization;

namespace CouchCoop.Mod.Localization;

/// <summary>Owns CouchCoop's embedded native catalogs and their game-localization bridge.</summary>
public static class CouchCoopLocalization
{
    public const string TableName = "static_hover_tips";
    public const string EnglishLanguage = "eng";
    public const string SimplifiedChineseLanguage = "zhs";

    private static readonly object Gate = new();
    private static readonly IReadOnlyDictionary<string, string> English = LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.en.json");
    private static readonly IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> Catalogs = new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.OrdinalIgnoreCase)
    {
        ["eng"] = English,
        ["zhs"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.zhs.json")),
        ["deu"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.deu.json")),
        ["esp"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.esp.json")),
        ["fra"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.fra.json")),
        ["ita"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.ita.json")),
        ["jpn"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.jpn.json")),
        ["kor"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.kor.json")),
        ["pol"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.pol.json")),
        ["ptb"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.ptb.json")),
        ["rus"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.rus.json")),
        ["spa"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.spa.json")),
        ["tha"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.tha.json")),
        ["tur"] = NormalizePlaceholders(LoadCatalog("CouchCoop.Mod.Localization.Catalogs.couchcoop.tur.json")),
    };
    public static IReadOnlyCollection<string> SupportedLanguages => Catalogs.Keys.ToArray();
    private static LocManager? _subscribedManager;
    private static LocManager.LocaleChangeCallback? _callback;
    private static int _revision;
    private static string _language = EnglishLanguage;

    /// <summary>Moves on each observed game-locale change, so retained UI knows to repaint.</summary>
    public static int Revision => Volatile.Read(ref _revision);
    public static string Language => Volatile.Read(ref _language);

    public static string SelectCatalogLanguage(string? gameLanguage)
        => gameLanguage is not null && Catalogs.ContainsKey(gameLanguage) ? gameLanguage.ToLowerInvariant() : EnglishLanguage;

    public static IReadOnlyDictionary<string, string> CatalogFor(string? gameLanguage)
        => Catalogs[SelectCatalogLanguage(gameLanguage)];

    /// <summary>Idempotently binds to the current game LocManager when it is available.</summary>
    public static void Initialize()
    {
        try
        {
            var manager = LocManager.Instance;
            lock (Gate)
            {
                if (ReferenceEquals(manager, _subscribedManager))
                {
                    return;
                }

                if (_subscribedManager is not null && _callback is not null)
                {
                    _subscribedManager.UnsubscribeToLocaleChange(_callback);
                }

                _subscribedManager = manager;
                _callback ??= OnLocaleChanged;
                manager?.SubscribeToLocaleChange(_callback);
                RefreshLocked(manager);
            }
        }
        catch
        {
            // A Godot-less/test process has no localization singleton. The embedded English catalog is
            // deliberately complete, so native copy remains usable without it.
        }
    }

    public static void Shutdown()
    {
        lock (Gate)
        {
            if (_subscribedManager is not null && _callback is not null)
            {
                try { _subscribedManager.UnsubscribeToLocaleChange(_callback); } catch { }
            }

            _subscribedManager = null;
        }
    }

    /// <summary>Resolve a value outside producer locks. Uses LocString when the game table is available.</summary>
    public static string Resolve(string key) => Resolve(key, EmptyArguments);

    public static string Resolve(string key, IReadOnlyDictionary<string, CouchCoopTextArgument> arguments)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        Initialize();
        var catalog = CatalogFor(Language);
        if (!catalog.TryGetValue(key, out var fallback))
        {
            return key;
        }

        var values = arguments.ToDictionary(pair => pair.Key, pair => pair.Value.Resolve(), StringComparer.Ordinal);
        try
        {
            if (_subscribedManager is not null)
            {
                var locString = new LocString(TableName, key);
                foreach (var (name, value) in values)
                {
                    locString.Add(name, value);
                }

                return locString.GetFormattedText();
            }
        }
        catch
        {
            // Table rebuild/shutdown races are harmless: use the same embedded template below.
        }

        return FormatEmbedded(fallback, values);
    }

    /// <summary>
    /// Resolves only from CouchCoop's embedded catalog for a specific language. Use for developer logs,
    /// which stay English regardless of the game UI locale and must not consult the game localization table.
    /// </summary>
    internal static string ResolveForLanguage(
        string? gameLanguage,
        string key,
        IReadOnlyDictionary<string, CouchCoopTextArgument> arguments)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        var catalog = CatalogFor(gameLanguage);
        if (!catalog.TryGetValue(key, out var fallback))
        {
            return key;
        }

        var language = SelectCatalogLanguage(gameLanguage);
        var values = arguments.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.ResolveForLanguage(language),
            StringComparer.Ordinal);
        return FormatEmbedded(fallback, values);
    }

    private static readonly IReadOnlyDictionary<string, CouchCoopTextArgument> EmptyArguments
        = new Dictionary<string, CouchCoopTextArgument>();

    private static string FormatEmbedded(string template, IReadOnlyDictionary<string, string> values)
    {
        foreach (var (name, value) in values)
        {
            template = template.Replace("{" + name + "}", value, StringComparison.Ordinal);
        }

        return template;
    }

    internal static void SetLanguageForTests(string language)
    {
        lock (Gate)
        {
            _language = SelectCatalogLanguage(language);
            Interlocked.Increment(ref _revision);
        }
    }

    private static void OnLocaleChanged()
    {
        lock (Gate)
        {
            RefreshLocked(_subscribedManager);
        }

        HostUi.CouchCoopQrHostPanelController.RefreshAll();
    }

    private static void RefreshLocked(LocManager? manager)
    {
        _language = SelectCatalogLanguage(manager?.Language);
        try
        {
            manager?.GetTable(TableName).MergeWith(new Dictionary<string, string>(CatalogFor(_language)));
        }
        catch
        {
            // The native UI has an embedded fallback; never let a missing game table break the lobby.
        }

        Interlocked.Increment(ref _revision);
    }

    private static IReadOnlyDictionary<string, string> LoadCatalog(string resourceName)
    {
        using var stream = typeof(CouchCoopLocalization).Assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Missing embedded localization catalog '{resourceName}'.");
        var catalog = JsonSerializer.Deserialize<Dictionary<string, string>>(stream)
            ?? throw new InvalidOperationException($"Localization catalog '{resourceName}' was empty.");
        return catalog;
    }

    private static IReadOnlyDictionary<string, string> NormalizePlaceholders(IReadOnlyDictionary<string, string> catalog)
    {
        var normalized = new Dictionary<string, string>(catalog, StringComparer.Ordinal);
        foreach (var (key, english) in English)
        {
            var expected = System.Text.RegularExpressions.Regex.Matches(english, "\\{([A-Za-z][A-Za-z0-9_-]*)\\}")
                .Select(match => match.Groups[1].Value).ToArray();
            var value = normalized[key];
            value = System.Text.RegularExpressions.Regex.Replace(value, "\\{([A-Za-z][A-Za-z0-9_-]*)\\}", match =>
                expected.Contains(match.Groups[1].Value, StringComparer.Ordinal) ? match.Value : string.Empty,
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            foreach (var name in expected)
            {
                if (!value.Contains("{" + name + "}", StringComparison.Ordinal)) value += " {" + name + "}";
            }
            normalized[key] = value;
        }
        return normalized;
    }
}
