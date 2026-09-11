using System.Net;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Localization;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Which join options the in-game QR dialog offers, and in which order.
/// </summary>
/// <remarks>
/// <para>
/// This is deliberately Godot-free and side-effect-free: the dialog is a thin renderer over
/// <see cref="Build"/>, so the whole "what does the phone scan" decision is unit-testable without a
/// game, a NIC or a running lobby.
/// </para>
/// <para>
/// <b>The list is the cross product of adapter × method, in a fixed order.</b> One entry group per
/// network adapter (ethernet first, then wifi, then everything else — Tailscale, docker, VPNs), and
/// inside each group the three ways a phone can reach that adapter's IPv4: the plain address, the
/// public web link carrying it in <c>?h=</c>, and the <c>local-ip.co</c> HTTPS name derived from it.
/// The <c>.local</c> name is always the LAST row: it is the only option that regularly fails outright
/// (many phones and routers cannot resolve mDNS), so it must never win the default, however well the
/// self-check went. The FIRST ENABLED entry is the dialog's default selection.
/// </para>
/// <para>
/// The ordering is NOT <see cref="LanAddressRanking.Rank"/>. That ranker answers a different
/// question — "which single IPv4 do we advertise unattended" — and is therefore GATEWAY-first, since
/// a machine-picked address that cannot route is worse than one that merely looks odd. Here a human
/// is reading a list and picking, so the list is grouped by the thing a human recognises: the
/// interface KIND. Gateway and range signals survive as the within-tier tiebreak via
/// <see cref="LanAddressRanking.ScoreOf"/>. <see cref="LanAddressRanking.Rank"/> itself is untouched
/// and still owns the advertised host.
/// </para>
/// <para>
/// A method that cannot work right now is still LISTED, disabled, with the blocker in its detail
/// line — the same convention the old checkboxes used. Showing it teaches that the option exists
/// (the secure listener usually lands seconds after startup); hiding it would make the list quietly
/// reshuffle between two opens.
/// </para>
/// </remarks>
public static class QrHostOptions
{
    /// <summary>Longest list the dialog will render; beyond this the select stops being scannable.</summary>
    public const int MaxOptions = 12;

    /// <summary>
    /// At most this many adapter groups (each up to three rows). Three covers the realistic couch
    /// topology (ethernet + wifi + one virtual adapter); beyond that the extra groups are ever-worse
    /// candidates by the same score that ordered them.
    /// </summary>
    public const int MaxAdapterGroups = 3;

    /// <summary>Suffix a machine is published under on the local link by mDNS.</summary>
    public const string MdnsSuffix = ".local";

    /// <summary>Blocker shown while there is no listening browser server (nothing can work yet).</summary>
    public static string ServerNotListeningReason => CouchCoopLocalization.Resolve("couchcoop_option_server_not_listening");
    internal static CouchCoopText ServerNotListeningText => new("couchcoop_option_server_not_listening");

    /// <summary>Blocker for link methods on an adapter whose address no phone could come back to.</summary>
    public static string AddressNotEligibleReason => CouchCoopLocalization.Resolve("couchcoop_option_address_not_eligible");
    internal static CouchCoopText AddressNotEligibleText => new("couchcoop_option_address_not_eligible");

    /// <summary>Blocker while the secure listener has not (yet) come up and no better reason is known.</summary>
    public static string SecurePendingReason => CouchCoopLocalization.Resolve("couchcoop_option_secure_pending");
    internal static CouchCoopText SecurePendingText => CouchCoopSecureText.Pending;

    /// <summary>
    /// Build the ordered option list. The first ENABLED entry is the dialog's default selection.
    /// </summary>
    /// <param name="machineName">Usually <see cref="Environment.MachineName"/>; may be blank.</param>
    /// <param name="advertisedOverride">
    /// A validated <c>COUCHCOOP_ADVERTISED_HOST</c> value (see
    /// <see cref="LanAddressRanking.ValidateAdvertisedHostOverride"/>). When an operator has pinned the
    /// advertised host, that pin wins the default slot here too — the dialog must not disagree with
    /// the address the rest of the mod is handing out.
    /// </param>
    /// <param name="candidates">Raw OS candidates; filtered by <see cref="LanAddressRanking.IsEligible"/>.</param>
    /// <param name="port">
    /// ALWAYS the browser server's real listening port (<c>ListenerBaseUri.Port</c>), never the
    /// preferred port: the server port-walks upward when 13337 is taken, and a QR carrying the port we
    /// WANTED rather than the one we GOT is a code that scans and then fails to connect.
    /// </param>
    /// <param name="webOrigin">
    /// The configured public origin (<see cref="CouchCoopWebOrigin.Resolve"/>). A value that cannot be
    /// normalised produces NO web rows at all — there is no domain to even name on a disabled row.
    /// </param>
    /// <param name="secureDomain">
    /// The active certificate provider's DNS suffix. Null (the provider was never constructed) falls
    /// back to <see cref="LocalIpCoCertificateProvider.DefaultDomain"/> so a disabled secure row can
    /// still show the host it WOULD encode.
    /// </param>
    /// <param name="securePort">
    /// The TLS listener's REAL bound port, or <c>0</c> while it is not running — same discipline as
    /// <paramref name="port"/>, and for the same reason: the secure listener port-walks too.
    /// </param>
    /// <param name="secureUnavailableReason">
    /// Why the secure origin is not on offer (snapshot's <c>SecureUnavailableReason</c>), rendered on
    /// the disabled secure rows; null/blank falls back to <see cref="SecurePendingReason"/>.
    /// </param>
    /// <param name="mdnsNameResolves">
    /// Whether the <c>.local</c> name is believed to actually resolve on this LAN
    /// (<see cref="MdnsHealth.NameLikelyResolves"/>). This no longer moves the row — mDNS is last
    /// either way — it only decides whether the row carries a "didn't answer" warning. Defaults to
    /// TRUE: an unrun probe must not badge a working name.
    /// </param>
    public static IReadOnlyList<QrHostOption> Build(
        string? machineName,
        string? advertisedOverride,
        IEnumerable<LanAddressCandidate>? candidates,
        int port,
        string? webOrigin,
        string? secureDomain,
        int securePort,
        CouchCoopText? secureUnavailableReason,
        bool mdnsNameResolves = true)
    {
        var options = new List<QrHostOption>();
        var seenKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Host-shaped rows (override / plain ipv4 / mdns) dedupe against each other by host string, so
        // an override that IS one of the adapters' addresses does not render twice. Link rows never
        // collide with them: their identity is the method+address pair.
        var seenHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void TryAdd(QrHostOption option)
        {
            if (options.Count < MaxOptions - 1 && seenKeys.Add(option.SelectionKey))
            {
                options.Add(option);
            }
        }

        var trimmedOverride = advertisedOverride?.Trim();
        if (!string.IsNullOrEmpty(trimmedOverride) && seenHosts.Add(trimmedOverride))
        {
            TryAdd(new QrHostOption(trimmedOverride, port, QrHostOptionKind.Override, Adapter: null));
        }

        foreach (var candidate in BestPerAdapter(candidates))
        {
            var adapter = new QrAdapterInfo(
                candidate.InterfaceName,
                AdapterKindOf(candidate),
                candidate.Address);

            if (seenHosts.Add(adapter.Address.ToString()))
            {
                TryAdd(new QrHostOption(adapter.Address.ToString(), port, QrHostOptionKind.Interface, adapter,
                    Enabled: port > 0,
                    DisabledReason: port > 0 ? (CouchCoopText?)null : ServerNotListeningText));
            }

            if (DescribeWebFor(adapter, port, webOrigin) is { } webRow)
            {
                TryAdd(webRow);
            }

            TryAdd(DescribeSecureFor(adapter, secureDomain, securePort, secureUnavailableReason));
        }

        // ALWAYS LAST, never capped away: the slot TryAdd reserves (MaxOptions - 1) is this row's. Last
        // because it is the least reliable method; still listed even when the self-check got no answer,
        // because the name may well resolve for a phone on a different segment — a player who knows
        // their setup should still be able to pick it.
        if (ToMdnsHostName(machineName) is { } mdnsHost && seenHosts.Add(mdnsHost))
        {
            options.Add(new QrHostOption(mdnsHost, port, QrHostOptionKind.Mdns, Adapter: null,
                MdnsTrusted: mdnsNameResolves));
        }

        return options;
    }

    /// <summary>
    /// Which row a (re)built list should select: an exact <see cref="QrHostOption.SelectionKey"/>
    /// match, else the default — the first ENABLED option, else the first row so the dialog still renders
    /// something explainable.
    /// </summary>
    /// <remarks>
    /// Pure and here rather than in the select so "which row lights up after a refresh" is testable
    /// without Godot. A disabled row never satisfies a preference: restoring a pick the player cannot
    /// re-make by clicking would render a QR the row itself refuses.
    /// </remarks>
    public static QrHostOption? RestoreSelection(IReadOnlyList<QrHostOption> options, string? preferredKey)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (preferredKey is { Length: > 0 })
        {
            var exact = options.FirstOrDefault(option => option.Enabled
                && string.Equals(option.SelectionKey, preferredKey, StringComparison.OrdinalIgnoreCase));
            if (exact is not null)
            {
                return exact;
            }

        }

        return options.FirstOrDefault(option => option.Enabled) ?? options.FirstOrDefault();
    }

    /// <summary>
    /// One winner per adapter: the best-scored eligible IPv4 of each interface, groups ordered
    /// ethernet → wifi → other, then score, then OS enumeration order (stable), duplicate addresses
    /// collapsed, capped at <see cref="MaxAdapterGroups"/>.
    /// </summary>
    /// <remarks>
    /// The same shape <c>MdnsResponder.GatherInterfaces</c> uses for its per-interface answers: an
    /// adapter is one thing to a player ("my wifi"), so an adapter with three addresses must not cost
    /// three groups of the dialog.
    /// </remarks>
    public static IReadOnlyList<LanAddressCandidate> BestPerAdapter(IEnumerable<LanAddressCandidate>? candidates)
    {
        var winners = new List<LanAddressCandidate>();
        var indexByInterface = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var candidate in (candidates ?? []).Where(LanAddressRanking.IsEligible))
        {
            var name = candidate.InterfaceName ?? string.Empty;
            if (indexByInterface.TryGetValue(name, out var index))
            {
                if (LanAddressRanking.ScoreOf(candidate) > LanAddressRanking.ScoreOf(winners[index]))
                {
                    winners[index] = candidate;
                }
            }
            else
            {
                indexByInterface[name] = winners.Count;
                winners.Add(candidate);
            }
        }

        var seenAddresses = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<LanAddressCandidate>();
        foreach (var winner in winners
            .OrderByDescending(candidate => LanAddressRanking.TypeTier(candidate.InterfaceType))
            .ThenByDescending(LanAddressRanking.ScoreOf))
        {
            if (result.Count >= MaxAdapterGroups)
            {
                break;
            }

            if (seenAddresses.Add(winner.Address.ToString()))
            {
                result.Add(winner);
            }
        }

        return result;
    }

    /// <summary>
    /// The "web link" row for one adapter: the public HTTPS origin carrying THAT adapter's IPv4 in
    /// <c>?h=</c>. Null when there is no usable origin configured; disabled-with-reason when the origin
    /// exists but this adapter (or the listener) cannot serve it right now.
    /// </summary>
    /// <remarks>
    /// The address in <c>?h=</c> is the row's own adapter address — each adapter's web row is a
    /// different QR. The port is the PLAIN listener's: the phone loads the client from the public
    /// origin over HTTPS and then talks to THIS server over plain HTTP by IP, so no certificate is
    /// involved on the LAN leg at all, which is precisely what makes this work where the
    /// <c>local-ip.co</c> option fails on routers with DNS-rebinding protection.
    /// </remarks>
    public static QrHostOption? DescribeWebFor(QrAdapterInfo adapter, int port, string? webOrigin)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        var origin = CouchCoopWebOrigin.Normalize(webOrigin);
        if (origin is null)
        {
            return null;
        }

        var originUri = new Uri(origin + "/");
        if (port <= 0)
        {
            return new QrHostOption(originUri.Host, originUri.Port, QrHostOptionKind.Web, adapter,
                Enabled: false, DisabledReason: ServerNotListeningText);
        }

        if (!SecureOriginHost.IsSecureOriginEligible(adapter.Address))
        {
            return new QrHostOption(originUri.Host, originUri.Port, QrHostOptionKind.Web, adapter,
                Enabled: false, DisabledReason: AddressNotEligibleText);
        }

        var authority = $"{adapter.Address}:{port.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
        var uri = new Uri(CouchCoopWebOrigin.BuildJoinUrl(origin, authority));
        return new QrHostOption(uri.Host, uri.Port, QrHostOptionKind.Web, adapter, AbsoluteUri: uri.ToString());
    }

    /// <summary>
    /// The <c>local-ip.co</c> HTTPS row for one adapter: THAT adapter's IPv4, dashed, under the
    /// provider's wildcard. Disabled-with-reason while the TLS listener is not up or the address is one
    /// no phone could come back to.
    /// </summary>
    /// <remarks>
    /// Any eligible local IPv4 is a valid secure host: the wildcard certificate covers every dashed
    /// quad and the TLS listener binds the same address the plain one does, so per-adapter rows need no
    /// per-adapter listener. The <c>.local</c> name and an operator override are structurally excluded
    /// — the wildcard covers dashed ADDRESSES only.
    /// </remarks>
    public static QrHostOption DescribeSecureFor(
        QrAdapterInfo adapter,
        string? secureDomain,
        int securePort,
        CouchCoopText? unavailableReason)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        var domain = string.IsNullOrWhiteSpace(secureDomain)
            ? LocalIpCoCertificateProvider.DefaultDomain
            : secureDomain!.Trim().Trim('.');

        // The host the row WOULD encode, shown even while disabled so the label stays honest. Built by
        // hand for the ineligible case, where ToHostName correctly refuses.
        var displayHost = SecureOriginHost.ToHostName(adapter.Address, domain)
            ?? string.Concat(adapter.Address.ToString().Replace('.', '-'), ".", domain);

        if (!SecureOriginHost.IsSecureOriginEligible(adapter.Address))
        {
            return new QrHostOption(displayHost, Math.Max(securePort, 0), QrHostOptionKind.Secure, adapter,
                Enabled: false, DisabledReason: CouchCoopSecureText.AddressIneligible);
        }

        if (securePort <= 0)
        {
            return new QrHostOption(displayHost, 0, QrHostOptionKind.Secure, adapter,
                Enabled: false,
                DisabledReason: unavailableReason ?? SecurePendingText);
        }

        return new QrHostOption(displayHost, securePort, QrHostOptionKind.Secure, adapter);
    }

    private static QrAdapterKind AdapterKindOf(LanAddressCandidate candidate)
        => LanAddressRanking.TypeTier(candidate.InterfaceType) switch
        {
            2 => QrAdapterKind.Ethernet,
            1 => QrAdapterKind.Wifi,
            _ => QrAdapterKind.Other,
        };

    /// <summary>
    /// Turn a machine name into the <c>.local</c> name it is published under, or <see langword="null"/>
    /// when nothing usable is left.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This used to only PREDICT the name an OS responder publishes (avahi on Linux, Bonjour on macOS).
    /// That prediction is unreliable on Windows — a stock install has no <c>.local</c> responder at all,
    /// and <see cref="Environment.MachineName"/> is the NetBIOS name (uppercased, truncated to 15 chars),
    /// so even a machine that DOES run Bonjour can publish a different string than this returns. The mod
    /// therefore publishes the name itself: <see cref="MdnsResponder"/> answers A queries for exactly this
    /// value, which makes the published name byte-identical to the one the QR dialog renders. Where an OS
    /// responder is also running (the avahi case) both answer with the same address, which RFC 6762
    /// treats as legal coexistence rather than a conflict.
    /// </para>
    /// <para>
    /// Labels are lowercased and reduced to the LDH set (letters/digits/hyphen) because that is what a
    /// DNS label may contain; a name that is all punctuation reduces to nothing and returns null rather
    /// than producing a bare <c>.local</c>.
    /// </para>
    /// </remarks>
    public static string? ToMdnsHostName(string? machineName)
    {
        if (string.IsNullOrWhiteSpace(machineName))
        {
            return null;
        }

        var value = machineName.Trim().ToLowerInvariant().TrimEnd('.');
        if (value.EndsWith(MdnsSuffix, StringComparison.Ordinal))
        {
            value = value[..^MdnsSuffix.Length];
        }

        var label = SanitizeLabel(value);
        return label is null ? null : label + MdnsSuffix;
    }

    // Collapses anything outside [a-z0-9-] to a single hyphen and trims hyphens off both ends, so
    // "Tom's Desktop  (work)" -> "tom-s-desktop-work".
    private static string? SanitizeLabel(string value)
    {
        var builder = new System.Text.StringBuilder(value.Length);
        foreach (var character in value)
        {
            if (char.IsAsciiLetterLower(character) || char.IsAsciiDigit(character) || character == '-')
            {
                builder.Append(character);
            }
            else if (builder.Length > 0 && builder[^1] != '-')
            {
                builder.Append('-');
            }
        }

        var label = builder.ToString().Trim('-');
        return label.Length == 0 ? null : label;
    }
}

/// <summary>What KIND of network adapter a row's address belongs to, for grouping and for the hover tip.</summary>
public enum QrAdapterKind
{
    Ethernet,
    Wifi,

    /// <summary>Anything that is neither: VPNs, tunnels, bridges, virtual adapters.</summary>
    Other,
}

/// <summary>The adapter a row's address came from. Null on rows that are not address-shaped (override, mdns).</summary>
public sealed record QrAdapterInfo(string InterfaceName, QrAdapterKind Kind, IPAddress Address)
{
    /// <summary>
    /// The interface name bounded for a right-aligned detail cell — Windows names run long ("Local
    /// Area Connection* 12") and the detail column shares its row with the label.
    /// </summary>
    public string ShortName => InterfaceName is { Length: > 16 } ? InterfaceName[..15] + "…" : InterfaceName ?? string.Empty;
}

public enum QrHostOptionKind
{
    /// <summary>Pinned by <c>COUCHCOOP_ADVERTISED_HOST</c>.</summary>
    Override,

    /// <summary>This machine's <c>.local</c> name, published by <see cref="MdnsResponder"/>. Always the last row.</summary>
    Mdns,

    /// <summary>A literal IPv4 on one of this machine's network interfaces.</summary>
    Interface,

    /// <summary>
    /// The HTTPS origin <c>&lt;ip-with-dashes&gt;.&lt;provider&gt;</c> on the TLS listener's port — one row
    /// per adapter, derived from that adapter's address. See <see cref="QrHostOptions.DescribeSecureFor"/>.
    /// </summary>
    Secure,

    /// <summary>
    /// The "web link": a PUBLIC HTTPS origin that carries one adapter's LAN address in <c>?h=</c>, and
    /// reaches it by literal IPv4 under the browser's Local Network Access permission — one row per
    /// adapter. See <see cref="QrHostOptions.DescribeWebFor"/>.
    /// </summary>
    Web,
}

/// <summary>One row of the QR dialog's single select.</summary>
/// <param name="Adapter">The adapter the row is derived from; null for the override and mdns rows.</param>
/// <param name="AbsoluteUri">
/// An explicit payload, for the one kind whose URL is not derivable from host+port:
/// <see cref="QrHostOptionKind.Web"/> carries a LAN address in a <c>?h=</c> QUERY, which the
/// scheme+host+port construction below cannot express. Null everywhere else, where deriving the URL is
/// the safety property (see <see cref="ToUri"/>).
/// </param>
/// <param name="Enabled">
/// Whether the row may be selected. A disabled row still renders — greyed, with
/// <paramref name="DisabledReason"/> in its detail slot — and is skipped when the dialog picks its
/// default ("first AVAILABLE option").
/// </param>
/// <param name="MdnsTrusted">
/// Mdns rows only: whether the startup self-check saw the name answer. False swaps the detail line for
/// a warning; it never moves or disables the row.
/// </param>
public sealed record QrHostOption(
    string Host,
    int Port,
    QrHostOptionKind Kind,
    QrAdapterInfo? Adapter,
    string? AbsoluteUri = null,
    bool Enabled = true,
    CouchCoopText? DisabledReason = null,
    bool MdnsTrusted = true)
{
    /// <summary>
    /// The exact payload the QR encodes and the URL label prints. Built the same way
    /// <see cref="OfflineQrCode"/> normalises a payload, so the scanned code and the typed fallback can
    /// never disagree.
    /// </summary>
    /// <remarks>
    /// The scheme is derived from <see cref="Kind"/> rather than passed in, so a caller cannot construct a
    /// <see cref="QrHostOptionKind.Secure"/> option that advertises <c>http://</c> (which would fail the
    /// certificate's whole purpose) or a LAN option that advertises <c>https://</c> (which nothing is
    /// listening for). <see cref="AbsoluteUri"/> is the single sanctioned exception, and only
    /// <see cref="QrHostOptions.DescribeWebFor"/> sets it.
    /// </remarks>
    public Uri ToUri() => AbsoluteUri is { Length: > 0 } explicitUri
        ? new Uri(explicitUri)
        : new UriBuilder(
            Kind == QrHostOptionKind.Secure ? Uri.UriSchemeHttps : Uri.UriSchemeHttp,
            Host,
            Port) { Path = "/" }.Uri;

    /// <summary>
    /// The stable identity used for dedupe, re-selection across a refresh, and the persisted
    /// preference. NOT the host: every adapter's web row shares the public origin's host, so host-keyed
    /// identity would silently collapse them.
    /// </summary>
    public string SelectionKey => Adapter is null ? MethodToken : $"{MethodToken}|{Adapter.Address}";

    /// <summary>The method half of <see cref="SelectionKey"/>; also the persisted preference token.</summary>
    public string MethodToken => Kind switch
    {
        QrHostOptionKind.Override => "override",
        QrHostOptionKind.Mdns => "mdns",
        QrHostOptionKind.Web => "web",
        QrHostOptionKind.Secure => "secure",
        _ => "ipv4",
    };

    /// <summary>
    /// Primary row text. Link rows show the name a phone would see in its browser bar (the pages.dev
    /// host, the dashed secure host); address rows show <c>host:port</c> because the port is part of
    /// what a player would have to type.
    /// </summary>
    public string Label => Kind is QrHostOptionKind.Web or QrHostOptionKind.Secure
        ? Host
        : $"{Host}:{Port.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    /// <summary>
    /// Secondary row text: the blocker when disabled, otherwise where the address came from — and for
    /// link rows, which adapter's address the link carries (the web rows all share one visible host, so
    /// the detail is what tells them apart).
    /// </summary>
    public string Detail
    {
        get
        {
            if (!Enabled && DisabledReason is { } disabled)
            {
                return disabled.Resolve();
            }

            return Kind switch
            {
                QrHostOptionKind.Override => CouchCoopLocalization.Resolve("couchcoop_option_pinned"),
                QrHostOptionKind.Mdns => MdnsTrusted
                    ? CouchCoopLocalization.Resolve("couchcoop_option_pc_name")
                    : CouchCoopLocalization.Resolve("couchcoop_option_mdns_untrusted"),
                QrHostOptionKind.Web => $"{Adapter?.Address} · {AdapterDetail}",
                QrHostOptionKind.Secure => $"https · {AdapterDetail}",
                _ => AdapterDetail,
            };
        }
    }

    private string AdapterDetail => Adapter is { ShortName.Length: > 0 } adapter
        ? adapter.ShortName
        : CouchCoopLocalization.Resolve("couchcoop_option_network_address");
}
