using System.Net;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Localization;

// The hover-tip copy is product surface, not decoration: it is the only place the dialog explains
// networking to a player, and it is rendered by GAME widgets with their own failure modes. So the
// tests pin three things the compiler cannot: the register (no engine/protocol jargon an average
// gamer would bounce off), the rich-text safety (the description lands in a BBCode label — a '['
// would be eaten as markup), and the mechanics of the loc-table merge (prefix, coverage).
internal static class QrHoverTipCopyTests
{
    public static void Run()
    {
        EveryAdapterAndMethodHasATitleAndADescription();
        SelectorTipIsRegisteredAndDistinct();
        OptionTipsPutTheMethodFirst();
        TitleKeysCarryTheNamespacePrefix();
        DescriptionsStayInTheGamerRegister();
        DescriptionsAreRichTextSafeAndTipSized();
        EnglishDescriptionsPreserveTheFullGuidance();
        MethodTipFoldsInTheLiveState();

        Console.WriteLine("QrHoverTipCopyTests: ok");
    }

    private static readonly QrAdapterKind[] AdapterKinds =
        [QrAdapterKind.Ethernet, QrAdapterKind.Wifi, QrAdapterKind.Other];

    private static QrHostOption OptionOf(QrHostOptionKind kind, bool enabled = true, string? reason = null, bool mdnsTrusted = true)
        => new("host.example", 13337, kind,
            kind is QrHostOptionKind.Override or QrHostOptionKind.Mdns
                ? null
                : new QrAdapterInfo("Wi-Fi", QrAdapterKind.Wifi, IPAddress.Parse("192.168.1.5")),
            Enabled: enabled,
            DisabledReason: reason is null ? (CouchCoopText?)null : CouchCoopText.FromLiteral(reason),
            MdnsTrusted: mdnsTrusted);

    private static IEnumerable<string> AllDescriptions()
    {
        foreach (var kind in AdapterKinds)
        {
            yield return QrHoverTipCopy.AdapterTipFor(kind).Description;
        }

        foreach (var kind in Enum.GetValues<QrHostOptionKind>())
        {
            yield return QrHoverTipCopy.MethodTipFor(OptionOf(kind)).Description;
        }

        yield return QrHoverTipCopy.NetworkConnectionDescription;
    }

    private static void EveryAdapterAndMethodHasATitleAndADescription()
    {
        foreach (var kind in AdapterKinds)
        {
            var (titleKey, description) = QrHoverTipCopy.AdapterTipFor(kind);
            Expect(QrHoverTipCopy.TitleEntries.TryGetValue(titleKey, out var title) && title!.Length > 0,
                $"adapter {kind} has a registered title");
            Expect(description.Length > 0, $"adapter {kind} has a description");
        }

        foreach (var kind in Enum.GetValues<QrHostOptionKind>())
        {
            var (titleKey, description) = QrHoverTipCopy.MethodTipFor(OptionOf(kind));
            Expect(QrHoverTipCopy.TitleEntries.TryGetValue(titleKey, out var title) && title!.Length > 0,
                $"method {kind} has a registered title");
            Expect(description.Length > 0, $"method {kind} has a description");
        }

        // The two tips of a pair must keep distinct title keys: the game dedupes a set by an Id derived
        // from the title's table.key, so a shared key would silently drop one tip of the pair.
        foreach (var kind in AdapterKinds)
        {
            var adapterKey = QrHoverTipCopy.AdapterTipFor(kind).TitleKey;
            foreach (var method in Enum.GetValues<QrHostOptionKind>())
            {
                Expect(adapterKey != QrHoverTipCopy.MethodTipFor(OptionOf(method)).TitleKey,
                    $"adapter {kind} and method {method} keep distinct tip identities");
            }
        }
    }

    private static void TitleKeysCarryTheNamespacePrefix()
    {
        Expect(QrHoverTipCopy.TitleEntries.Count >= 9, "all nine tips are registered");
        foreach (var key in QrHoverTipCopy.TitleEntries.Keys)
        {
            Expect(key.StartsWith(QrHoverTipCopy.TitleKeyPrefix, StringComparison.Ordinal),
                $"'{key}' is namespaced — the titles are merged into a GAME loc table and must never collide with it");
        }
    }

    private static void SelectorTipIsRegisteredAndDistinct()
    {
        var (titleKey, description) = QrHoverTipCopy.NetworkConnectionTip;
        Expect(titleKey == QrHoverTipCopy.NetworkConnectionTitleKey, "the selector uses its dedicated title key");
        Expect(QrHoverTipCopy.TitleEntries.TryGetValue(titleKey, out var title) && title!.Length > 0,
            "the selector has a registered title");
        Expect(description.Length > 0, "the selector has a description");

        foreach (var kind in Enum.GetValues<QrHostOptionKind>())
        {
            Expect(titleKey != QrHoverTipCopy.MethodTipFor(OptionOf(kind)).TitleKey,
                $"the selector tip is distinct from the selected {kind} option tip");
        }

        var selectorSpecs = CouchCoopQrHoverTips.SelectorTipSpecs;
        Expect(selectorSpecs.Count == 1 && selectorSpecs[0].TitleKey == titleKey
            && selectorSpecs[0].Description == description,
            "the closed selector uses only its generic tip");
    }

    private static void OptionTipsPutTheMethodFirst()
    {
        var specs = CouchCoopQrHoverTips.OptionTipSpecsFor(OptionOf(QrHostOptionKind.Web));
        Expect(specs.Count == 2, "an adapter-backed option keeps both tips");
        Expect(specs[0].TitleKey == QrHoverTipCopy.MethodWebTitleKey,
            "the method tip is first");
        Expect(specs[1].TitleKey == QrHoverTipCopy.AdapterWifiTitleKey,
            "the network-interface tip is second");

        var methodOnly = CouchCoopQrHoverTips.OptionTipSpecsFor(OptionOf(QrHostOptionKind.Mdns));
        Expect(methodOnly.Count == 1 && methodOnly[0].TitleKey == QrHoverTipCopy.MethodMdnsTitleKey,
            "options without an interface keep only their method tip");
    }

    private static void DescriptionsStayInTheGamerRegister()
    {
        // The words the guidance explicitly bans (players should hear "speed features", not API names),
        // plus the protocol jargon this feature is soaked in internally.
        string[] banned = ["WebGPU", "SharedArrayBuffer", "mDNS", "IPv4", "IPv6", "TLS", "certificate", "DNS", "origin"];
        foreach (var description in AllDescriptions())
        {
            foreach (var word in banned)
            {
                Expect(!description.Contains(word, StringComparison.OrdinalIgnoreCase),
                    $"'{word}' does not appear in player-facing copy: {description[..Math.Min(60, description.Length)]}…");
            }
        }
    }

    private static void DescriptionsAreRichTextSafeAndTipSized()
    {
        foreach (var description in AllDescriptions())
        {
            Expect(!description.Contains('[', StringComparison.Ordinal),
                "no '[' — the description lands in a rich-text label that would eat it as markup");
            Expect(description.Length <= 360,
                $"a description fits a 360-unit tip without scrolling the screen ({description.Length} chars)");
        }
    }

    private static void EnglishDescriptionsPreserveTheFullGuidance()
    {
        CouchCoopLocalization.SetLanguageForTests("eng");
        Expect(QrHoverTipCopy.NetworkConnectionDescription
            == "Choose which network connection and link type phones use to join. Change this if a phone cannot connect, or if you want to try a faster, more reliable option.",
            "the selector tip explains what the input changes and when to change it");
        Expect(QrHoverTipCopy.AdapterOtherDescription
            == "A VPN or virtual network (Tailscale, a work VPN, and the like). Only phones on that same network can use this address — on normal home Wi-Fi, pick one of the options above instead.",
            "the other-network tip retains its concrete VPN examples and home-Wi-Fi advice");
        Expect(QrHoverTipCopy.MethodIpv4Description
            == "The simplest link, and the only one that needs no internet at all. The phone runs a bit slower on it — a secure (https) link lets the browser use extra speed features, which means better fps and battery. Can't be installed as an app (except on iPhone).",
            "the plain-address tip retains performance and install caveats");
        Expect(QrHoverTipCopy.MethodWebDescription
            == "Loads from the internet, then connects straight to this PC. The phone will ask permission for the site to reach your local network — that only lets it reach programs that explicitly accept connections from this site, like this game. Best fps and battery. Needs internet on the phone, and doesn't work on iPhone yet.",
            "the web-link tip retains the permission scope and performance guidance");
        Expect(QrHoverTipCopy.MethodSecureDescription
            == "A secure (https) link straight to this PC — better fps and battery than the plain address, and the phone can install it like a real app. Some routers or internet providers block this kind of address; if it won't load, pick another option. Needs internet.",
            "the secure-link tip retains comparison, install, router, and fallback guidance");
        Expect(QrHoverTipCopy.MethodMdnsDescription
            == "Uses this PC's name instead of numbers — easy to remember and type by hand. But many phones and routers can't find these names, so it's the least reliable option. If it won't load, use one of the addresses above.",
            "the PC-name tip retains hand-entry, reliability, and address fallback guidance");
    }

    private static void MethodTipFoldsInTheLiveState()
    {
        var disabled = QrHoverTipCopy.MethodTipFor(OptionOf(QrHostOptionKind.Secure,
            enabled: false, reason: QrHostOptions.SecurePendingReason)).Description;
        Expect(disabled.EndsWith(QrHoverTipCopy.DisabledReasonPrefix + QrHostOptions.SecurePendingReason, StringComparison.Ordinal),
            "a disabled row's tip ends with its blocker, so hovering the greyed row answers 'why'");

        var untrusted = QrHoverTipCopy.MethodTipFor(OptionOf(QrHostOptionKind.Mdns, mdnsTrusted: false)).Description;
        Expect(untrusted.Contains("didn't answer", StringComparison.Ordinal),
            "an untested-negative mdns name warns in its tip");

        var trusted = QrHoverTipCopy.MethodTipFor(OptionOf(QrHostOptionKind.Mdns)).Description;
        Expect(!trusted.Contains("didn't answer", StringComparison.Ordinal),
            "while a trusted name carries no warning");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"QrHoverTipCopyTests failed: {because}");
        }
    }
}
