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
/// Each option shows a PAIR of tips: first one about the join method, then one about the network adapter
/// the row's address belongs to. The two answer different questions ("is this the right kind of link" /
/// "is this the right network") and a player may need either. Rows without an adapter (the operator
/// override, the <c>.local</c> name) show only the method tip. The closed selector has its own generic
/// tip because its job is to explain what changing the input does, not to describe the current option.
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
    public const string MethodWebTitleKey = TitleKeyPrefix + "method_web";
    public const string MethodSecureTitleKey = TitleKeyPrefix + "method_secure";
    public const string MethodMdnsTitleKey = TitleKeyPrefix + "method_mdns";
    public const string MethodOverrideTitleKey = TitleKeyPrefix + "method_override";
    public const string NetworkConnectionTitleKey = TitleKeyPrefix + "network_connection";

    /// <summary>Key → active-locale title for consumers that require an explicit title map.</summary>
    public static IReadOnlyDictionary<string, string> TitleEntries => new Dictionary<string, string>
    {
        [AdapterEthernetTitleKey] = L("couchcoop_qr_adapter_ethernet_title"), [AdapterWifiTitleKey] = L("couchcoop_qr_adapter_wifi_title"),
        [AdapterOtherTitleKey] = L("couchcoop_qr_adapter_other_title"), [MethodIpv4TitleKey] = L("couchcoop_qr_method_ipv4_title"),
        [MethodWebTitleKey] = L("couchcoop_qr_method_web_title"), [MethodSecureTitleKey] = L("couchcoop_qr_method_secure_title"),
        [MethodMdnsTitleKey] = L("couchcoop_qr_method_mdns_title"), [MethodOverrideTitleKey] = L("couchcoop_qr_method_override_title"),
        [NetworkConnectionTitleKey] = L("couchcoop_qr_network_connection_title"),
    };

    public static string NetworkConnectionDescription => L("couchcoop_qr_network_connection_description");

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

    /// <summary>The adapter half of an option's tip pair.</summary>
    public static (string TitleKey, string Description) AdapterTipFor(QrAdapterKind kind) => kind switch
    {
        QrAdapterKind.Ethernet => (AdapterEthernetTitleKey, AdapterEthernetDescription),
        QrAdapterKind.Wifi => (AdapterWifiTitleKey, AdapterWifiDescription),
        _ => (AdapterOtherTitleKey, AdapterOtherDescription),
    };

    /// <summary>
    /// The method half of an option's tip pair, with the option's live state folded in: the blocker
    /// line while the row is disabled, the self-check warning on an untested-negative mDNS name.
    /// </summary>
    public static (string TitleKey, string Description) MethodTipFor(QrHostOption option)
    {
        ArgumentNullException.ThrowIfNull(option);
        var (titleKey, description) = option.Kind switch
        {
            QrHostOptionKind.Override => (MethodOverrideTitleKey, MethodOverrideDescription),
            QrHostOptionKind.Mdns => (MethodMdnsTitleKey, MethodMdnsDescription),
            QrHostOptionKind.Web => (MethodWebTitleKey, MethodWebDescription),
            QrHostOptionKind.Secure => (MethodSecureTitleKey, MethodSecureDescription),
            _ => (MethodIpv4TitleKey, MethodIpv4Description),
        };

        if (option.Kind == QrHostOptionKind.Mdns && !option.MdnsTrusted)
        {
            description += MdnsUntrustedSuffix;
        }

        if (!option.Enabled && option.DisabledReason is { } disabled)
        {
            description += DisabledReasonPrefix + disabled.Resolve();
        }

        return (titleKey, description);
    }

    private static string L(string key) => CouchCoopLocalization.Resolve(key);
}
