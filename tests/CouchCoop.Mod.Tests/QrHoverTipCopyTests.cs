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
        CopyLinkTipIsRegisteredAndDistinct();
        OptionTipsHaveOneContext();
        TitleKeysCarryTheNamespacePrefix();
        DescriptionsStayInTheGamerRegister();
        DescriptionsAreRichTextSafeAndTipSized();
        EnglishDescriptionsPreserveTheFullGuidance();
        MethodTipFoldsInTheLiveState();
        DisabledMethodKeepsBlockerInline();

        Console.WriteLine("QrHoverTipCopyTests: ok");
    }

    private static readonly QrAdapterKind[] AdapterKinds =
        [QrAdapterKind.Ethernet, QrAdapterKind.Wifi, QrAdapterKind.Other];

    private static QrHostOption OptionOf(QrHostOptionKind kind, bool enabled = true, string? reason = null,
        bool mdnsTrusted = true, bool canSelectWhenUnavailable = false)
        => new("host.example", 13337, kind,
            kind is QrHostOptionKind.Override or QrHostOptionKind.Mdns
                ? null
                : new QrAdapterInfo("Wi-Fi", QrAdapterKind.Wifi, IPAddress.Parse("192.168.1.5")),
            Enabled: enabled,
            DisabledReason: reason is null ? (CouchCoopText?)null : CouchCoopText.FromLiteral(reason),
            MdnsTrusted: mdnsTrusted,
            CanSelectWhenUnavailable: canSelectWhenUnavailable);

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
        yield return QrHoverTipCopy.CopyLinkDescription;
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

        // Network and method rows keep distinct identities.
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
        Expect(QrHoverTipCopy.TitleEntries.Count >= 10, "all ten tips are registered");
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

    // The copy affordance under the QR is a faint, wordless icon: this tip is the ONLY thing that tells a
    // player what pressing it does, so "has a description" is a product requirement here rather than
    // tidiness. Distinctness matters for the same reason it does for the pairs above — the game dedupes a
    // set by its title's table.key, so a shared key silently drops a tip.
    private static void CopyLinkTipIsRegisteredAndDistinct()
    {
        var (titleKey, description) = QrHoverTipCopy.CopyLinkTip;
        Expect(titleKey == QrHoverTipCopy.CopyLinkTitleKey, "the copy affordance uses its dedicated title key");
        Expect(QrHoverTipCopy.TitleEntries.TryGetValue(titleKey, out var title) && title!.Length > 0,
            "the copy affordance has a registered title");
        Expect(description.Length > 0, "the copy affordance has a description");
        Expect(titleKey != QrHoverTipCopy.NetworkConnectionTitleKey, "distinct from the selector tip");

        foreach (var kind in Enum.GetValues<QrHostOptionKind>())
        {
            Expect(titleKey != QrHoverTipCopy.MethodTipFor(OptionOf(kind)).TitleKey,
                $"the copy tip is distinct from the {kind} option tip");
        }

        var specs = CouchCoopQrHoverTips.CopyLinkTipSpecs;
        Expect(specs.Count == 1 && specs[0].TitleKey == titleKey && specs[0].Description == description,
            "the copy affordance shows exactly one tip");
    }

    private static void OptionTipsHaveOneContext()
    {
        foreach (var kind in Enum.GetValues<QrHostOptionKind>())
        {
            var option = OptionOf(kind);
            var method = CouchCoopQrHoverTips.OptionTipSpecsFor(option);
            Expect(method.Count == 1 && method[0] == QrHoverTipCopy.MethodTipFor(option),
                $"{kind} method row has only its method tip");
            var network = CouchCoopQrHoverTips.NetworkOptionTipSpecsFor(option);
            Expect(network.Count == 1, $"{kind} network row has exactly one tip");
            Expect(network[0].TitleKey == (option.Adapter is null
                ? QrHoverTipCopy.MethodTipFor(option).TitleKey : QrHoverTipCopy.AdapterWifiTitleKey),
                $"{kind} network row describes only the network");
        }
        foreach (var method in QrSelectionModel.Methods)
        {
            var absentNetwork = CouchCoopQrHoverTips.OptionTipSpecsFor(null, method);
            Expect(absentNetwork.Count == 1 && absentNetwork[0].Description.EndsWith(
                CouchCoopLocalization.Resolve("couchcoop_qr_no_address"), StringComparison.Ordinal),
                $"{method} still has one explanatory tip when no network exists");
        }
        foreach (var kind in AdapterKinds)
        {
            var option = OptionOf(QrHostOptionKind.Interface) with
            {
                Adapter = new QrAdapterInfo("adapter", kind, IPAddress.Parse("192.168.1.5")),
            };
            var network = CouchCoopQrHoverTips.NetworkOptionTipSpecsFor(option);
            Expect(network.Count == 1 && network[0] == QrHoverTipCopy.AdapterTipFor(kind),
                $"{kind} network shows its own adapter guidance without method content");
        }
        foreach (var kind in new[] { QrHostOptionKind.Mdns, QrHostOptionKind.Override })
        {
            var direct = CouchCoopQrHoverTips.OptionTipSpecsFor(OptionOf(kind), "ipv4");
            Expect(direct.Count == 1 && direct[0].TitleKey == QrHoverTipCopy.MethodIpv4TitleKey,
                "Direct method describes Direct even when its network is a PC name or override");
        }
    }

    private static void DescriptionsStayInTheGamerRegister()
    {
        // The words the guidance explicitly bans (players should hear "speed features", not API names),
        // plus the protocol jargon this feature is soaked in internally.
        string[] banned = ["WebGPU", "SharedArrayBuffer", "mDNS", "IPv4", "IPv6", "TLS", "DNS", "origin"];
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
            == "Choose the network this PC uses to reach your phone. PC name (.local) uses the computer’s name instead of an interface address.",
            "the selector tip explains what the input changes and when to change it");
        Expect(QrHoverTipCopy.AdapterOtherDescription
            == "A VPN or virtual network (a work VPN, a virtual machine, and the like). Only phones on that same network can use this address — on normal home Wi-Fi, pick one of the options above instead.",
            "the other-network tip retains its examples — kinds of network, never a named product — and its home-Wi-Fi advice");
        Expect(!QrHoverTipCopy.MethodIpv4Description.Contains("only one", StringComparison.OrdinalIgnoreCase),
            "plain direct no longer claims to be the only offline method");
        foreach (var description in new[] { QrHoverTipCopy.MethodIpv4Description,
            QrHoverTipCopy.MethodWebDescription, QrHoverTipCopy.MethodSecureDescription,
            QrHoverTipCopy.MethodSelectorTip.Description })
        {
            Expect(!description.Contains("better fps", StringComparison.OrdinalIgnoreCase)
                && !description.Contains("best fps", StringComparison.OrdinalIgnoreCase)
                && !description.Contains("better performance and battery", StringComparison.OrdinalIgnoreCase),
                "HTTPS feature availability does not promise performance or battery gains");
        }
        Expect(QrHoverTipCopy.MethodSelectorTip.Description.Contains("Direct address (HTTPS)", StringComparison.Ordinal),
            "the selector explains the new direct HTTPS method");
        Expect(QrHoverTipCopy.MethodMdnsDescription
            == "Uses this PC's name instead of numbers — easy to remember and type by hand. But many phones and routers can't find these names, so it's the least reliable option. If it won't load, use one of the addresses above.",
            "the PC-name tip retains hand-entry, reliability, and address fallback guidance");
        Expect(QrHoverTipCopy.CopyLinkDescription
            == "Copies this address to your clipboard, so you can paste it into a chat message or type it into a phone's browser.",
            "the copy tip names both things a copied address is actually for");
    }

    private static void DisabledMethodKeepsBlockerInline()
    {
        var option = OptionOf(QrHostOptionKind.Web, enabled: false, reason: "Choose a network interface.");
        var tips = CouchCoopQrHoverTips.OptionTipSpecsFor(option);
        Expect(tips.Count == 1 && tips[0].TitleKey == QrHoverTipCopy.MethodWebTitleKey,
            "a disabled method still has exactly one method tip");
        Expect(tips[0].Description.EndsWith("\nChoose a network interface.", StringComparison.Ordinal),
            "the same tip includes the blocker");
        var closed = CouchCoopQrHoverTips.MethodSelectorTipSpecsFor(option);
        Expect(closed.Count == 1 && closed[0].TitleKey == QrHoverTipCopy.MethodSelectorTitleKey
            && closed[0].Description.EndsWith("\nChoose a network interface.", StringComparison.Ordinal),
            "the closed selector folds the blocker into its one control tip");
        var network = CouchCoopQrHoverTips.NetworkOptionTipSpecsFor(option);
        Expect(network.Count == 1 && network[0].TitleKey == QrHoverTipCopy.AdapterWifiTitleKey
            && network[0].Description.EndsWith("\nChoose a network interface.", StringComparison.Ordinal),
            "network blockers are inline too");
    }

    private static void MethodTipFoldsInTheLiveState()
    {
        var disabled = QrHoverTipCopy.MethodTipFor(OptionOf(QrHostOptionKind.Secure,
            enabled: false, reason: QrHostOptions.SecurePendingReason,
            canSelectWhenUnavailable: true)).Description;
        Expect(disabled.EndsWith("\n" + QrHostOptions.SecurePendingReason, StringComparison.Ordinal),
            "the selectable idle HTTPS row explains setup without claiming it cannot be selected");

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
