using System.Net;
using System.Net.NetworkInformation;
using CouchCoop.Mod.HostUi;

// WS-2 (redesigned): the option list the in-game QR dialog offers — the cross product of adapter ×
// method, mdns always last, first ENABLED entry the default. Everything here is pure — no Godot, no
// NICs, no lobby — because "which QR does the phone scan" is the one decision in this feature that is
// actually hard, and it must be falsifiable without launching a game.
//
// The headline invariants:
//  * Order: override → per-adapter [plain ipv4, web link, secure link] with adapters grouped
//    ethernet → wifi → other → mdns LAST. The mdns self-check no longer moves the row, it only
//    badges it.
//  * Per-adapter links: each adapter's web/secure row carries THAT adapter's address, so two adapters
//    yield two different `?h=` payloads and two different dashed hosts.
//  * Identity is SelectionKey, never Host — every web row shares the public origin's host.
//  * Unavailable methods are LISTED disabled with the blocker, and never win the default.
internal static class QrHostOptionsTests
{
    public static void Run()
    {
        OverrideTakesTheDefaultSlot();
        PlainIpv4OfTheBestAdapterIsTheDefault();
        MethodOrderWithinAnAdapterIsIpv4ThenWebThenSecure();
        MdnsIsAlwaysLastAndNeverTheDefault();
        AnUnresolvableMdnsNameStaysLastWithAWarning();
        OverrideStaysFirstWhateverTheMdnsSelfCheckSays();

        TierBeatsGatewayUnlikeRank();
        MacAdapterShapesGroupAndLabelCorrectly();
        ScoreBreaksTiesInsideATier();
        TiesKeepEnumerationOrder();
        OneGroupPerAdapterUsesItsBestScoredIpv4();
        AdapterGroupsAreCappedAtThree();
        IneligibleCandidatesAreFiltered();
        Ipv6CandidatesNeverProduceARow();
        DuplicateAdaptersCollapseByAddress();
        AnOverrideEqualToAnAdapterAddressKeepsTheLinkRows();

        TwoWebRowsSharingThePublicHostBothSurvive();
        SecureRowsUseTheAdaptersOwnAddress();
        WebRowsCarryTheAdaptersOwnAddressInH();
        SelectionKeysAreUniqueAcrossTheList();

        DisabledMethodsAreShownWithTheBlocker();
        AGarbageWebOriginProducesNoWebRows();
        ApipaAdapterKeepsItsPlainRowButLosesTheLinkRows();
        PortIsAlwaysTheListenerPort();

        RestorePrefersTheExactKey();
        RestoreDoesNotFallBackToTheMethod();
        RestoreSkipsDisabledRowsAndDefaultsToFirstEnabled();

        MdnsNameIsLowercasedAndSuffixed();
        MdnsNameLeavesAnExistingLocalSuffixAlone();
        MdnsNameSanitisesToTheLdhSet();
        MdnsNameRejectsUnusableInput();

        PayloadMatchesTheEncodedQrPayload();
        EmptyMachineAndNoNicsStillDegradesCleanly();

        Console.WriteLine("QrHostOptionsTests: ok");
    }

    // ---- builders -------------------------------------------------------------------------------------------

    private static LanAddressCandidate Nic(
        string name,
        string address,
        NetworkInterfaceType type = NetworkInterfaceType.Ethernet,
        bool gateway = true,
        OperationalStatus status = OperationalStatus.Up,
        bool loopback = false)
        => new(name, type, status, loopback, IPAddress.Parse(address), PrefixOrigin.Manual, gateway);

    private static LanAddressCandidate Wifi(string address = "192.168.0.42", bool gateway = true, string name = "Wi-Fi")
        => Nic(name, address, NetworkInterfaceType.Wireless80211, gateway);

    private static LanAddressCandidate Ethernet(string address = "192.168.0.89", bool gateway = true, string name = "Ethernet")
        => Nic(name, address, NetworkInterfaceType.Ethernet, gateway);

    private const int Port = 13337;
    private const int SecurePort = 13338;
    private const string Origin = "https://sts2-couch.pages.dev";

    private static IReadOnlyList<QrHostOption> Build(
        string? machine = "my-machine",
        string? advertised = null,
        params LanAddressCandidate[] candidates)
        => QrHostOptions.Build(machine, advertised, candidates, Port, Origin, null, SecurePort, null);

    // ---- ordering -------------------------------------------------------------------------------------------

    private static void OverrideTakesTheDefaultSlot()
    {
        var options = Build("my-machine", "10.0.0.5", Wifi());

        Expect(options[0].Host == "10.0.0.5", "a pinned COUCHCOOP_ADVERTISED_HOST is the default option");
        Expect(options[0].Kind == QrHostOptionKind.Override, "and is labelled as the override");
        Expect(options[0].Enabled, "and is selectable");
        // The rest of the mod advertises the override; a dialog that defaulted elsewhere would hand out a
        // different address than the discovery reply and the availability log for the same session.
        Expect(options.Count == 5, "the adapter triple and the mdns row still follow");
        Expect(options[^1].Kind == QrHostOptionKind.Mdns, "with mdns last");
    }

    private static void PlainIpv4OfTheBestAdapterIsTheDefault()
    {
        var options = Build("Living-Room-PC", null, Wifi("192.168.1.7"), Ethernet("192.168.1.8"));

        Expect(options[0].Kind == QrHostOptionKind.Interface, "the default is a plain address, never a link or mdns");
        Expect(options[0].Host == "192.168.1.8", "and it belongs to the ETHERNET adapter (tier first)");
        Expect(options[0].Enabled, "and it is selectable");
        Expect(QrHostOptions.RestoreSelection(options, null) == options[0], "RestoreSelection agrees");
    }

    private static void MethodOrderWithinAnAdapterIsIpv4ThenWebThenSecure()
    {
        var options = Build("box", null, Wifi("192.168.1.7"));

        Expect(options.Count == 4, "one adapter yields its triple plus the mdns row");
        Expect(options[0].Kind == QrHostOptionKind.Interface, "plain address first");
        Expect(options[1].Kind == QrHostOptionKind.Web, "web link second");
        Expect(options[2].Kind == QrHostOptionKind.Secure, "secure link third");
        Expect(options[3].Kind == QrHostOptionKind.Mdns, "mdns last");
        Expect(options.Take(3).All(option => option.Adapter?.Address.ToString() == "192.168.1.7"),
            "and all three rows belong to the same adapter");
    }

    private static void MdnsIsAlwaysLastAndNeverTheDefault()
    {
        var options = Build("Living-Room-PC", null, Ethernet(), Wifi());

        Expect(options[^1].Kind == QrHostOptionKind.Mdns, "the .local row is the LAST option");
        Expect(options[^1].Host == "living-room-pc.local", "and carries the published name");
        Expect(options[0].Kind != QrHostOptionKind.Mdns, "it is never the default — it is the least reliable method");
        Expect(options.Count(option => option.Kind == QrHostOptionKind.Mdns) == 1, "and appears exactly once");
    }

    // The self-check used to DEMOTE the row (it was the default back then). Now the row is last either
    // way; a negative observation only swaps the detail line for a warning the hover tip repeats.
    private static void AnUnresolvableMdnsNameStaysLastWithAWarning()
    {
        var options = QrHostOptions.Build("box", null, [Wifi("192.168.1.7")], Port, Origin, null, SecurePort, null,
            mdnsNameResolves: false);

        var mdns = options[^1];
        Expect(mdns.Kind == QrHostOptionKind.Mdns, "the row is still last");
        Expect(mdns.Enabled, "and still OFFERED — it may resolve for a phone on another segment");
        Expect(!mdns.MdnsTrusted, "but carries the self-check verdict");
        Expect(mdns.Detail == "didn't answer when tested", "which the detail line states");

        var trusted = Build("box", null, Wifi("192.168.1.7"))[^1];
        Expect(trusted.Detail == "this PC's network name", "a trusted name keeps the friendly detail");
    }

    private static void OverrideStaysFirstWhateverTheMdnsSelfCheckSays()
    {
        var options = QrHostOptions.Build("box", "couch.example", [Wifi("192.168.1.7")], Port, Origin, null, SecurePort, null,
            mdnsNameResolves: false);

        Expect(options[0].Host == "couch.example", "an explicit override still wins the default slot");
        Expect(options[0].Kind == QrHostOptionKind.Override, "and keeps its kind");
        Expect(options[^1].Kind == QrHostOptionKind.Mdns, "and mdns is still last");
    }

    // ---- adapter grouping -----------------------------------------------------------------------------------

    // THE divergence. Ethernet without a gateway vs wifi with one: Rank prefers the gatewayed wifi
    // (routability is what an unattended pick needs), the dialog prefers the ethernet (kind is what a
    // human scans a list by). Both are asserted here so neither can drift into the other.
    private static void TierBeatsGatewayUnlikeRank()
    {
        var gatewaylessEthernet = Ethernet("192.168.5.10", gateway: false);
        var gatewayedWifi = Wifi("192.168.5.20", gateway: true);
        LanAddressCandidate[] nics = [gatewayedWifi, gatewaylessEthernet];

        var dialog = QrHostOptions.BestPerAdapter(nics);
        Expect(dialog[0].Address.ToString() == "192.168.5.10", "the dialog leads with the ethernet NIC (tier first)");

        var advertised = LanAddressRanking.Rank(nics);
        Expect(advertised[0].Address.ToString() == "192.168.5.20", "while Rank still leads with the gatewayed wifi");
    }

    /// <summary>
    /// The macOS shapes, which this file did not have — it held Windows and Linux topologies only.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The descriptors come from what .NET actually reports on macOS (see the long note in
    /// <c>LanAddressRankingTests</c>): <c>en0</c> is <c>Wireless80211</c> on a laptop because the native PAL
    /// reclassifies <c>IFT_ETHER</c> via a <c>SIOCGIFMEDIA</c> ioctl, <c>utun*</c> is <c>Unknown</c>, and a
    /// virtualisation bridge keeps <c>Ethernet</c>.
    /// </para>
    /// <para>
    /// The second half of this test records a real trap rather than a passing behaviour, and deliberately does
    /// not fix it: a Mac running Internet Sharing, Parallels or Docker Desktop has a <c>bridge100</c> that the
    /// dialog LISTS FIRST and therefore DEFAULTS to, because the dialog's grouping leads with the type tier
    /// (see <see cref="TierBeatsGatewayUnlikeRank"/>). That is a deliberate, cross-platform product choice —
    /// the identical thing happens with libvirt's <c>virbr0</c> on Linux — and the advertised address the rest
    /// of the mod uses is still correct, because <c>LanAddressRanking.Rank</c> leads with the gateway instead.
    /// Changing it is a product decision about every platform at once, not a macOS fix.
    /// </para>
    /// </remarks>
    private static void MacAdapterShapesGroupAndLabelCorrectly()
    {
        var en0 = Nic("en0", "192.168.1.64", NetworkInterfaceType.Wireless80211, gateway: true);
        var utun = Nic("utun4", "10.96.0.7", NetworkInterfaceType.Unknown, gateway: true);
        var bridge = Nic("bridge100", "192.168.2.1", NetworkInterfaceType.Ethernet, gateway: false);

        var groups = QrHostOptions.BestPerAdapter([en0, utun]);
        Expect(groups[0].InterfaceName == "en0", "a MacBook's wifi leads a list whose only rival is a VPN tunnel");

        var options = Build("macbook", null, en0, utun);
        var wifiRow = options.First(option => option.Kind == QrHostOptionKind.Interface && option.Host == "192.168.1.64");
        Expect(wifiRow.Adapter?.Kind == QrAdapterKind.Wifi,
            "en0 is grouped and labelled as Wi-Fi — .NET already reclassifies it, so nothing here may 'fix' it");
        var tunnelRow = options.First(option => option.Kind == QrHostOptionKind.Interface && option.Host == "10.96.0.7");
        Expect(tunnelRow.Adapter?.Kind == QrAdapterKind.Other,
            "utun is grouped as Other, which is what its VPN-shaped hover copy is for");
        Expect(options[0].Host == "192.168.1.64", "and the dialog defaults to the wifi row");

        // The trap, pinned rather than fixed. See the remarks.
        var withBridge = Build("macbook", null, en0, bridge);
        Expect(withBridge[0].Host == "192.168.2.1",
            "a virtualisation bridge leads the DIALOG on tier (deliberate; same as virbr0 on Linux)");
        Expect(LanAddressRanking.Best([en0, bridge])?.Address.ToString() == "192.168.1.64",
            "…while the address the rest of the mod actually advertises is still the wifi one");
    }

    private static void ScoreBreaksTiesInsideATier()
    {
        // Both are tier 0 ("other"), so the existing gateway/range score decides: the CGNAT tunnel is
        // penalised and must not outrank a plain private address on an equally unknown adapter.
        var tunnel = Nic("tun0", "100.86.76.72", NetworkInterfaceType.Tunnel, gateway: false);
        var other = Nic("usb0", "192.168.9.4", NetworkInterfaceType.Unknown, gateway: true);

        var groups = QrHostOptions.BestPerAdapter([tunnel, other]);
        Expect(groups[0].Address.ToString() == "192.168.9.4", "inside one tier the gateway/range score still decides");
    }

    private static void TiesKeepEnumerationOrder()
    {
        var first = Wifi("192.168.0.2", name: "Wi-Fi");
        var second = Wifi("192.168.0.3", name: "Wi-Fi 2");

        var groups = QrHostOptions.BestPerAdapter([first, second]);
        Expect(groups[0].Address.ToString() == "192.168.0.2", "indistinguishable NICs keep OS enumeration order");
        Expect(groups[1].Address.ToString() == "192.168.0.3", "...for the whole list, not just the winner");
    }

    private static void OneGroupPerAdapterUsesItsBestScoredIpv4()
    {
        // One NIC with an APIPA self-assignment AND a real DHCP address (the "cable replugged" state):
        // one group, carrying the address a phone can actually reach.
        var apipa = Nic("Ethernet", "169.254.7.9", gateway: false);
        var real = Nic("Ethernet", "192.168.0.9", gateway: true);

        var options = Build("box", null, apipa, real);
        Expect(options.Count(option => option.Kind == QrHostOptionKind.Interface) == 1,
            "one adapter yields one plain row however many addresses it holds");
        Expect(options[0].Host == "192.168.0.9", "and the row carries the best-scored one");
    }

    private static void AdapterGroupsAreCappedAtThree()
    {
        var nics = Enumerable.Range(1, 8).Select(index => Wifi($"192.168.7.{index}", name: $"wl{index}")).ToArray();
        var options = QrHostOptions.Build("box", null, nics, Port, Origin, null, SecurePort, null);

        Expect(options.Count(option => option.Kind == QrHostOptionKind.Interface) == QrHostOptions.MaxAdapterGroups,
            "the adapter groups are capped so the select stays scannable");
        Expect(options.Count <= QrHostOptions.MaxOptions, "which keeps the whole list under the hard cap");
        Expect(options[^1].Kind == QrHostOptionKind.Mdns, "and the cap never costs the mdns row");
    }

    private static void IneligibleCandidatesAreFiltered()
    {
        var down = Nic("Ethernet 2", "192.168.0.50", status: OperationalStatus.Down);
        var loopback = Nic("lo", "127.0.0.1", NetworkInterfaceType.Loopback, loopback: true);

        var options = Build("box", null, down, loopback, Wifi("192.168.0.60"));
        Expect(options.Count(option => option.Kind == QrHostOptionKind.Interface) == 1,
            "down and loopback interfaces never reach the dialog");
        Expect(options[0].Host == "192.168.0.60", "only the usable NIC is offered");
    }

    // The dialog's IPv6 guarantee, pinned: nothing IPv6-shaped may produce a row of any kind.
    private static void Ipv6CandidatesNeverProduceARow()
    {
        var v6 = new LanAddressCandidate(
            "Ethernet", NetworkInterfaceType.Ethernet, OperationalStatus.Up, false,
            IPAddress.Parse("2001:db8::7"), PrefixOrigin.RouterAdvertisement, true);
        var linkLocalV6 = new LanAddressCandidate(
            "Wi-Fi", NetworkInterfaceType.Wireless80211, OperationalStatus.Up, false,
            IPAddress.Parse("fe80::1"), PrefixOrigin.WellKnown, true);

        var options = Build("box", null, v6, linkLocalV6);
        Expect(options.Count == 1 && options[0].Kind == QrHostOptionKind.Mdns,
            "IPv6 candidates yield no adapter rows at all — only the mdns row remains");
    }

    private static void DuplicateAdaptersCollapseByAddress()
    {
        // Two NICs reporting the same address (a bridged/aliased setup) must not produce two groups that
        // scan to the identical URLs — the player would have no way to tell them apart.
        var options = Build("box", null, Ethernet("192.168.0.9"), Wifi("192.168.0.9"));
        Expect(options.Count == 4, "a repeated address collapses to a single group (3 rows) plus mdns");

        // An override that equals the mDNS name collapses too, keeping the override's label.
        var pinned = Build("box", "box.local", Wifi("192.168.0.9"));
        Expect(pinned[0].Kind == QrHostOptionKind.Override, "the first writer of a host wins the row");
        Expect(pinned.Count(option => option.Host == "box.local") == 1, "and the duplicate mDNS row is dropped");
    }

    private static void AnOverrideEqualToAnAdapterAddressKeepsTheLinkRows()
    {
        var options = Build("box", "192.168.0.9", Wifi("192.168.0.9"));

        Expect(options[0].Kind == QrHostOptionKind.Override, "the override owns the plain row");
        Expect(options.Count(option => option.Host == "192.168.0.9") == 1, "so the adapter's own plain row is dropped");
        Expect(options.Any(option => option.Kind == QrHostOptionKind.Web), "but its web row survives");
        Expect(options.Any(option => option.Kind == QrHostOptionKind.Secure), "and so does its secure row");
    }

    // ---- per-adapter links ----------------------------------------------------------------------------------

    // THE regression guard for the identity change: host-keyed dedupe would collapse these two rows.
    private static void TwoWebRowsSharingThePublicHostBothSurvive()
    {
        var options = Build("box", null, Ethernet("192.168.1.8"), Wifi("192.168.1.7"));

        var webRows = options.Where(option => option.Kind == QrHostOptionKind.Web).ToList();
        Expect(webRows.Count == 2, "each adapter gets its own web row");
        Expect(webRows[0].Host == webRows[1].Host, "which share the public origin's host");
        Expect(webRows[0].SelectionKey != webRows[1].SelectionKey, "but carry distinct selection keys");
    }

    // The headline behaviour change from the checkbox era: links are derived from the ROW's adapter,
    // not from the machine-picked advertised address.
    private static void SecureRowsUseTheAdaptersOwnAddress()
    {
        var options = Build("box", null, Ethernet("192.168.1.8"), Wifi("192.168.1.7"));

        var secureHosts = options.Where(option => option.Kind == QrHostOptionKind.Secure)
            .Select(option => option.Host).ToList();
        Expect(secureHosts.SequenceEqual(["192-168-1-8.my.local-ip.co", "192-168-1-7.my.local-ip.co"]),
            $"each secure row dashes its own adapter's address (got {string.Join(", ", secureHosts)})");
    }

    private static void WebRowsCarryTheAdaptersOwnAddressInH()
    {
        var options = Build("box", null, Ethernet("192.168.1.8"), Wifi("192.168.1.7"));

        var payloads = options.Where(option => option.Kind == QrHostOptionKind.Web)
            .Select(option => option.ToUri().Query).ToList();
        Expect(payloads.SequenceEqual([$"?h=192.168.1.8:{Port}", $"?h=192.168.1.7:{Port}"]),
            $"each web row carries its own adapter's address in ?h= (got {string.Join(", ", payloads)})");
    }

    private static void SelectionKeysAreUniqueAcrossTheList()
    {
        var options = Build("box", "10.0.0.5", Ethernet("192.168.1.8"), Wifi("192.168.1.7"));
        Expect(options.Select(option => option.SelectionKey).Distinct(StringComparer.OrdinalIgnoreCase).Count() == options.Count,
            "every row has a distinct selection key — it is the dedupe, restore and persistence identity");
    }

    // ---- availability ---------------------------------------------------------------------------------------

    private static void DisabledMethodsAreShownWithTheBlocker()
    {
        // Secure listener not up yet (securePort 0): the secure rows are LISTED, disabled, explained.
        var pending = QrHostOptions.Build("box", null, [Wifi("192.168.1.7")], Port, Origin, null, 0, null);
        var secure = pending.Single(option => option.Kind == QrHostOptionKind.Secure);
        Expect(!secure.Enabled, "a secure row without a TLS listener is not selectable");
        Expect(secure.Detail == QrHostOptions.SecurePendingReason, "and its detail slot carries the blocker");
        Expect(secure.Host == "192-168-1-7.my.local-ip.co", "while the label still shows the host it WOULD encode");

        // A better reason from the snapshot (cert fetch failed, kill switch...) is passed through.
        var reasoned = QrHostOptions.Build("box", null, [Wifi("192.168.1.7")], Port, Origin, null, 0,
            "No internet, or the certificate service is down.");
        Expect(reasoned.Single(option => option.Kind == QrHostOptionKind.Secure).Detail
            == "No internet, or the certificate service is down.", "the snapshot's own reason wins when present");

        // And the default never lands on a disabled row.
        Expect(QrHostOptions.RestoreSelection(pending, null)!.Enabled, "the default skips disabled rows");
    }

    private static void AGarbageWebOriginProducesNoWebRows()
    {
        // Unreachable in production (Resolve() falls back to the shipped origin) but the decision layer
        // must not render a row it cannot even name.
        var options = QrHostOptions.Build("box", null, [Wifi("192.168.1.7")], Port, "nonsense", null, SecurePort, null);
        Expect(options.All(option => option.Kind != QrHostOptionKind.Web), "no web origin, no web rows");
        Expect(options.Any(option => option.Kind == QrHostOptionKind.Secure), "the other methods are unaffected");
    }

    private static void ApipaAdapterKeepsItsPlainRowButLosesTheLinkRows()
    {
        // 169.254/16 means "DHCP failed": the plain row may still serve a phone with a manual address on
        // the same segment, but no public DNS (web `?h=` aside, the LNA permission needs a reachable
        // address; the dashed name maps back to it) can make the link methods work.
        var options = Build("box", null, Nic("Ethernet", "169.254.7.9", gateway: false));

        var plain = options.Single(option => option.Kind == QrHostOptionKind.Interface);
        Expect(plain.Enabled, "the plain row stays selectable");

        var web = options.Single(option => option.Kind == QrHostOptionKind.Web);
        var secure = options.Single(option => option.Kind == QrHostOptionKind.Secure);
        Expect(!web.Enabled && web.Detail == QrHostOptions.AddressNotEligibleReason, "the web row is disabled with the blocker");
        Expect(!secure.Enabled && secure.Detail == QrHostOptions.AddressNotEligibleReason, "and so is the secure row");
    }

    private static void PortIsAlwaysTheListenerPort()
    {
        // The server port-walks upward when 13337 is taken. A QR carrying the port we WANTED rather than
        // the one we GOT scans fine and then fails to connect, which is the worst possible failure mode.
        var options = QrHostOptions.Build("box", "10.0.0.5", [Wifi()], 13339, Origin, null, SecurePort, null);

        Expect(options.Where(option => option.Kind is QrHostOptionKind.Override or QrHostOptionKind.Interface or QrHostOptionKind.Mdns)
            .All(option => option.Port == 13339), "every host-shaped option carries the real listening port");
        Expect(options[0].ToUri().ToString() == "http://10.0.0.5:13339/", "and the URL says so");

        var web = options.Single(option => option.Kind == QrHostOptionKind.Web);
        Expect(web.ToUri().Query == "?h=192.168.0.42:13339", "the web row's ?h= carries the PLAIN listener port");

        var secure = options.Single(option => option.Kind == QrHostOptionKind.Secure);
        Expect(secure.Port == SecurePort, "while the secure row carries the TLS listener's own port");
    }

    // ---- selection restore ----------------------------------------------------------------------------------

    private static void RestorePrefersTheExactKey()
    {
        var options = Build("box", null, Ethernet("192.168.1.8"), Wifi("192.168.1.7"));
        var wifiWeb = options.Single(option => option.Kind == QrHostOptionKind.Web
            && option.Adapter!.Address.ToString() == "192.168.1.7");

        Expect(QrHostOptions.RestoreSelection(options, wifiWeb.SelectionKey) == wifiWeb,
            "an exact selection key finds its row across a rebuild");
    }

    private static void RestoreDoesNotFallBackToTheMethod()
    {
        var options = Build("box", null, Ethernet("192.168.1.8"));

        // A stale exact key must not quietly select a different adapter or method. The current-only
        // preference is an identity, not a method preference.
        var restored = QrHostOptions.RestoreSelection(options, "secure|10.9.9.9");
        Expect(restored == options[0], "a stale key falls back to the current default");

        var unmatched = QrHostOptions.RestoreSelection(options, "web");
        Expect(unmatched == options[0], "a method-only token cannot select a row");
    }

    private static void RestoreSkipsDisabledRowsAndDefaultsToFirstEnabled()
    {
        // Secure rows disabled (no TLS listener): a remembered secure pick must not select a row the
        // player could not click, and the default must skip the disabled rows too.
        var options = QrHostOptions.Build("box", null, [Wifi("192.168.1.7")], Port, Origin, null, 0, null);

        var restored = QrHostOptions.RestoreSelection(options, "secure|192.168.1.7");
        Expect(restored!.Enabled, "a preference naming a disabled row does not restore it");
        Expect(restored.Kind == QrHostOptionKind.Interface, "the first ENABLED option wins instead");
        Expect(QrHostOptions.RestoreSelection(options, null) == restored, "which is also the no-preference default");
    }

    // ---- mDNS name derivation -------------------------------------------------------------------------------

    private static void MdnsNameIsLowercasedAndSuffixed()
    {
        Expect(QrHostOptions.ToMdnsHostName("Living-Room-PC") == "living-room-pc.local", "names lowercase to .local");
        Expect(QrHostOptions.ToMdnsHostName("  steamdeck  ") == "steamdeck.local", "surrounding whitespace is trimmed");
    }

    private static void MdnsNameLeavesAnExistingLocalSuffixAlone()
    {
        Expect(QrHostOptions.ToMdnsHostName("box.local") == "box.local", "an existing .local suffix is not doubled");
        Expect(QrHostOptions.ToMdnsHostName("Box.LOCAL.") == "box.local", "a trailing root dot is stripped first");
    }

    private static void MdnsNameSanitisesToTheLdhSet()
    {
        // Windows and macOS both allow machine names a DNS label may not contain.
        Expect(QrHostOptions.ToMdnsHostName("Tom's Desktop") == "tom-s-desktop.local", "punctuation collapses to a hyphen");
        Expect(QrHostOptions.ToMdnsHostName("box   two") == "box-two.local", "runs collapse to a single hyphen");
        Expect(QrHostOptions.ToMdnsHostName("--box--") == "box.local", "leading/trailing hyphens are trimmed");
        Expect(QrHostOptions.ToMdnsHostName("my.machine") == "my-machine.local", "interior dots are not extra labels");
    }

    private static void MdnsNameRejectsUnusableInput()
    {
        Expect(QrHostOptions.ToMdnsHostName(null) is null, "a null machine name yields no option");
        Expect(QrHostOptions.ToMdnsHostName("   ") is null, "a blank machine name yields no option");
        // Must not degenerate into a bare ".local", which resolves to nothing and looks like a bug.
        Expect(QrHostOptions.ToMdnsHostName("!!!") is null, "an all-punctuation name yields no option");
        Expect(QrHostOptions.ToMdnsHostName(".local") is null, "a bare suffix yields no option");
    }

    // ---- payload parity -------------------------------------------------------------------------------------

    // The QR and the typeable URL label are rendered from the same option; if ToUri and the encoder's
    // normalisation ever disagree, the label would tell the player something the code does not say.
    private static void PayloadMatchesTheEncodedQrPayload()
    {
        foreach (var option in Build("Living-Room-PC", null, Wifi("192.168.0.42")).Where(option => option.Enabled))
        {
            var uri = option.ToUri();
            var encoded = OfflineQrCode.EncodeJoinUrl(uri, quietZoneModules: 0);
            Expect(encoded.Payload == uri.ToString(), $"the encoded payload is exactly the option URL ({option.SelectionKey})");
        }

        var all = Build("Living-Room-PC", null, Wifi("192.168.0.42"));
        Expect(all.Single(option => option.Kind == QrHostOptionKind.Interface).ToUri().ToString()
            == $"http://192.168.0.42:{Port}/", "the plain row is the classic LAN URL");
        Expect(all.Single(option => option.Kind == QrHostOptionKind.Web).ToUri().ToString()
            == $"https://sts2-couch.pages.dev/?h=192.168.0.42:{Port}", "the web row is the public origin plus ?h=");
        Expect(all.Single(option => option.Kind == QrHostOptionKind.Secure).ToUri().ToString()
            == $"https://192-168-0-42.my.local-ip.co:{SecurePort}/", "the secure row is the dashed https URL");
        Expect(all.Single(option => option.Kind == QrHostOptionKind.Mdns).ToUri().ToString()
            == $"http://living-room-pc.local:{Port}/", "the mdns row is the published name");
    }

    private static void EmptyMachineAndNoNicsStillDegradesCleanly()
    {
        // The no-LAN-address machine: this is precisely the case the old overlay hid behind an
        // "unavailable" diagnostic. An empty list is a legitimate outcome and must not throw.
        var options = QrHostOptions.Build(null, null, null, Port, Origin, null, SecurePort, null);
        Expect(options.Count == 0, "no machine name and no NICs yields an empty list, not an exception");
        Expect(QrHostOptions.RestoreSelection(options, "ipv4|192.168.0.1") is null, "and restore has nothing to answer");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"QrHostOptionsTests failed: {because}");
        }
    }
}
