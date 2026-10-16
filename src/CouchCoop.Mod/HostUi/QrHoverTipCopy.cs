namespace CouchCoop.Mod.HostUi;

using CouchCoop.Mod.Localization;

/// <summary>
/// Every word the QR dialog's hover tips can say, as catalog-backed data: title keys and descriptions.
/// </summary>
/// <remarks>
/// <para>
/// Godot-free and game-free on purpose, so the copy itself is unit-testable: the tips are the one
/// place this dialog explains networking to a player, and the tests pin the register (no protocol
/// jargon a gamer would bounce off) as well as the mechanics (length that fits a 360-unit tip, no
/// <c>[</c> — the description lands in a rich-text label that would eat it as markup).
/// </para>
/// <para>
/// Each picker row shows only its method or network explanation. Closed selectors explain
/// what changing that control does. Blockers belong inside the relevant explanation.
/// </para>
/// <para>
/// Title keys are prefixed <c>couchcoop_qr_</c> and merged into an existing game table by the native
/// localization coordinator. Descriptions resolve from the same catalog at display time.
/// </para>
/// </remarks>
public static class QrHoverTipCopy
{
    /// <summary>The game loc table the title keys are merged into (it exists in every language).</summary>
    public const string LocTableName = "static_hover_tips";

    /// <summary>Namespace prefix for every merged key, so a game update can never collide with us.</summary>
    public const string TitleKeyPrefix = "couchcoop_qr_";

    public const string AdapterEthernetTitleKey = TitleKeyPrefix + "adapter_ethernet";
    public const string AdapterWifiTitleKey = TitleKeyPrefix + "adapter_wifi";
    public const string AdapterOtherTitleKey = TitleKeyPrefix + "adapter_other";
    public const string MethodIpv4TitleKey = TitleKeyPrefix + "method_ipv4";
    public const string MethodDirectHttpsTitleKey = TitleKeyPrefix + "method_direct_https";
    public const string MethodWebTitleKey = TitleKeyPrefix + "method_web";
    public const string MethodSecureTitleKey = TitleKeyPrefix + "method_secure";
    public const string MethodMdnsTitleKey = TitleKeyPrefix + "method_mdns";
    public const string MethodOverrideTitleKey = TitleKeyPrefix + "method_override";
    public const string NetworkConnectionTitleKey = TitleKeyPrefix + "network_connection";
    public const string MethodSelectorTitleKey = TitleKeyPrefix + "method_selector";
    public const string UnavailableTitleKey = TitleKeyPrefix + "unavailable";
    public const string CopyLinkTitleKey = TitleKeyPrefix + "copy_link";

    /// <summary>Key → active-locale title for consumers that require an explicit title map.</summary>
    public static IReadOnlyDictionary<string, string> TitleEntries => new Dictionary<string, string>
    {
        [AdapterEthernetTitleKey] = L("couchcoop_qr_adapter_ethernet_title"), [AdapterWifiTitleKey] = L("couchcoop_qr_adapter_wifi_title"),
        [AdapterOtherTitleKey] = L("couchcoop_qr_adapter_other_title"), [MethodIpv4TitleKey] = L("couchcoop_qr_method_ipv4_title"),
        [MethodDirectHttpsTitleKey] = L("couchcoop_qr_method_direct_https_title"),
        [MethodWebTitleKey] = L("couchcoop_qr_method_web_title"), [MethodSecureTitleKey] = L("couchcoop_qr_method_secure_title"),
        [MethodMdnsTitleKey] = L("couchcoop_qr_method_mdns_title"), [MethodOverrideTitleKey] = L("couchcoop_qr_method_override_title"),
        [NetworkConnectionTitleKey] = L("couchcoop_qr_network_connection_title"),
        [MethodSelectorTitleKey] = L("couchcoop_qr_method_selector_title"),
        [UnavailableTitleKey] = L("couchcoop_qr_unavailable_title"),
        [CopyLinkTitleKey] = L("couchcoop_qr_copy_link_title"),
    };

    public static string NetworkConnectionDescription => L("couchcoop_qr_network_connection_description");

    public static (string TitleKey, string Description) MethodSelectorTip
        => (MethodSelectorTitleKey, L("couchcoop_qr_method_selector_description"));

    public static (string TitleKey, string Description)? UnavailableTipFor(QrHostOption? option)
        => option is { Selectable: false, DisabledReason: { } reason }
            ? (UnavailableTitleKey, reason.Resolve()) : null;

    public static string CopyLinkDescription => L("couchcoop_qr_copy_link_description");

    public static string AdapterEthernetDescription => L("couchcoop_qr_adapter_ethernet_description");

    public static string AdapterWifiDescription => L("couchcoop_qr_adapter_wifi_description");

    public static string AdapterOtherDescription => L("couchcoop_qr_adapter_other_description");

    public static string MethodIpv4Description => L("couchcoop_qr_method_ipv4_description");

    public static string MethodWebDescription => L("couchcoop_qr_method_web_description");

    public static string MethodSecureDescription => L("couchcoop_qr_method_secure_description");

    public static string MethodMdnsDescription => L("couchcoop_qr_method_mdns_description");

    /// <summary>Appended to the mDNS tip when the startup self-check saw the name go unanswered.</summary>
    public static string MdnsUntrustedSuffix => L("couchcoop_qr_mdns_untrusted_suffix");

    public static string MethodOverrideDescription => L("couchcoop_qr_method_override_description");

    /// <summary>Prefix for the "why is this greyed out" line appended to a disabled row's method tip.</summary>
    public static string DisabledReasonPrefix => L("couchcoop_qr_disabled_reason_prefix");

    /// <summary>The single explanatory tip for the closed network-connection selector.</summary>
    public static (string TitleKey, string Description) NetworkConnectionTip
        => (NetworkConnectionTitleKey, NetworkConnectionDescription);

    /// <summary>
    /// The tip for the copy affordance beside the printed address. It carries the whole of that button's
    /// explanation: the icon is deliberately faint and wordless, so this is the only place that says what
    /// pressing it does.
    /// </summary>
    public static (string TitleKey, string Description) CopyLinkTip => (CopyLinkTitleKey, CopyLinkDescription);

    /// <summary>The network explanation for an adapter.</summary>
    public static (string TitleKey, string Description) AdapterTipFor(QrAdapterKind kind) => kind switch
    {
        QrAdapterKind.Ethernet => (AdapterEthernetTitleKey, AdapterEthernetDescription),
        QrAdapterKind.Wifi => (AdapterWifiTitleKey, AdapterWifiDescription),
        _ => (AdapterOtherTitleKey, AdapterOtherDescription),
    };

    /// <summary>
    /// The method explanation, with setup status or the PC-name self-check warning.
    /// Unselectable methods carry their blocker in the same tip.
    /// </summary>
    public static (string TitleKey, string Description) MethodTipFor(QrHostOption? option, string? method = null)
    {
        var kind = method switch
        {
            "ipv4" => QrHostOptionKind.Interface,
            "direct-https" => QrHostOptionKind.DirectIpSecure,
            "web" => QrHostOptionKind.Web,
            "secure" => QrHostOptionKind.Secure,
            _ => option?.Kind ?? QrHostOptionKind.Interface,
        };
        var (titleKey, description) = kind switch
        {
            QrHostOptionKind.Override => (MethodOverrideTitleKey, MethodOverrideDescription),
            QrHostOptionKind.Mdns => (MethodMdnsTitleKey, MethodMdnsDescription),
            QrHostOptionKind.DirectIpSecure => (MethodDirectHttpsTitleKey, L("couchcoop_qr_method_direct_https_description")),
            QrHostOptionKind.Web => (MethodWebTitleKey, MethodWebDescription),
            QrHostOptionKind.Secure => (MethodSecureTitleKey, MethodSecureDescription),
            _ => (MethodIpv4TitleKey, MethodIpv4Description),
        };

        if (kind == QrHostOptionKind.Mdns && option is { MdnsTrusted: false })
        {
            description += MdnsUntrustedSuffix;
        }

        if (option is null)
            description += "\n" + L("couchcoop_qr_no_address");
        else if (!option.Enabled && option.DisabledReason is { } disabled)
        {
            description += "\n" + disabled.Resolve();
        }

        return (titleKey, description);
    }

    public static (string TitleKey, string Description) NetworkTipFor(QrHostOption option)
    {
        ArgumentNullException.ThrowIfNull(option);
        // Fixed addresses and PC names have their own guidance; do not mislabel them as adapters.
        return option.Adapter is { } adapter
            ? WithBlocker(AdapterTipFor(adapter.Kind), option)
            : MethodTipFor(option);
    }

    internal static (string TitleKey, string Description) WithBlocker(
        (string TitleKey, string Description) tip, QrHostOption? option)
        => option is { Enabled: false, DisabledReason: { } reason }
            ? (tip.TitleKey, tip.Description + "\n" + reason.Resolve()) : tip;

    private static string L(string key) => CouchCoopLocalization.Resolve(key);
}
