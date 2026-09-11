using System.Net;
using System.Net.NetworkInformation;
using CouchCoop.Mod.HostUi;

// WS-F: the advertised-LAN-IPv4 ranking. The reported defect is "on Windows with Tailscale installed the lobby
// shows the Tailscale IP instead of the wifi IP" — the old code took the first IPv4 on the first Up, non-loopback
// interface in OS enumeration order, so it was pure luck which adapter won.
//
// Every case below drives the PURE ranker with synthetic descriptors, because the interesting topologies (a
// Tailscale tunnel that reports NetworkInterfaceType.Ethernet on Windows, an APIPA-only NIC, an up Docker bridge)
// cannot be produced on the build host without changing host networking. The suite also prints the REAL ranked
// candidate list for this machine as informational output — no assertion, since it is machine-dependent.
internal static class LanAddressRankingTests
{
    public static void Run()
    {
        TailscaleCgnatLosesToRealWifi();
        TailscaleWithEthernetTypeStillLosesWhenItIsFirstInEnumerationOrder();
        EthernetBeatsWifi();
        DockerBridgeLosesToWifi();
        ApipaOnlyIsStillOfferedAsALastResort();
        DownAndLoopbackInterfacesAreFiltered();
        NoCandidatesAtAll();
        DhcpBreaksATieBetweenOtherwiseEqualNics();
        TiesKeepEnumerationOrder();

        OverrideAcceptsIpLiteralAndHostname();
        OverrideRejectsGarbage();

        GatherFromOsNeverThrows();
        PrintRealMachineRanking();

        Console.WriteLine("LanAddressRankingTests: ok");
    }

    // ---- descriptor builders --------------------------------------------------------------------------------

    private static LanAddressCandidate Nic(
        string name,
        string address,
        NetworkInterfaceType type = NetworkInterfaceType.Ethernet,
        bool gateway = true,
        OperationalStatus status = OperationalStatus.Up,
        PrefixOrigin prefixOrigin = PrefixOrigin.Manual,
        bool loopback = false)
        => new(name, type, status, loopback, IPAddress.Parse(address), prefixOrigin, gateway);

    // Tailscale on Windows: reports Ethernet, has NO default gateway, address in CGNAT 100.64.0.0/10.
    private static LanAddressCandidate Tailscale(string address = "100.86.76.72")
        => Nic("Tailscale", address, NetworkInterfaceType.Ethernet, gateway: false);

    private static LanAddressCandidate Wifi(string address = "192.168.0.42")
        => Nic("Wi-Fi", address, NetworkInterfaceType.Wireless80211, gateway: true, prefixOrigin: PrefixOrigin.Dhcp);

    private static LanAddressCandidate Ethernet(string address = "192.168.0.89")
        => Nic("Ethernet", address, NetworkInterfaceType.Ethernet, gateway: true, prefixOrigin: PrefixOrigin.Dhcp);

    // ---- ranking --------------------------------------------------------------------------------------------

    // THE reported bug. Tailscale is enumerated first and claims Ethernet type, so both the old first-match rule
    // and a type-only rule would pick it. It loses on the dominant rule: no IPv4 default gateway.
    private static void TailscaleCgnatLosesToRealWifi()
    {
        var best = LanAddressRanking.Best([Tailscale(), Wifi()]);
        Expect(best?.Address.ToString() == "192.168.0.42", $"wifi beats the Tailscale CGNAT address (got {best?.Address.ToString() ?? "none"})");
    }

    // Same topology, but pinned explicitly on enumeration order to prove the fix is not accidentally relying on
    // the OS listing the good NIC first (which is what made this machine-dependent in the first place).
    private static void TailscaleWithEthernetTypeStillLosesWhenItIsFirstInEnumerationOrder()
    {
        var tailscaleFirst = LanAddressRanking.Rank([Tailscale(), Wifi(), Ethernet()]);
        Expect(tailscaleFirst.Count == 3, "all three are eligible");
        Expect(tailscaleFirst[0].InterfaceName == "Ethernet", "ethernet ranks first");
        Expect(tailscaleFirst[1].InterfaceName == "Wi-Fi", "wifi ranks second");
        Expect(tailscaleFirst[2].InterfaceName == "Tailscale", "the tunnel ranks LAST despite being enumerated first");
    }

    private static void EthernetBeatsWifi()
    {
        var best = LanAddressRanking.Best([Wifi("192.168.0.42"), Ethernet("192.168.0.89")]);
        Expect(best?.Address.ToString() == "192.168.0.89", "ethernet outranks wifi when both have a gateway");

        // ...and it still wins when wifi is enumerated first AND wifi is DHCP while ethernet is static: the type
        // tier is more significant than the DHCP tie-break.
        var staticEthernet = Nic("Ethernet", "192.168.0.89", NetworkInterfaceType.GigabitEthernet, gateway: true, prefixOrigin: PrefixOrigin.Manual);
        var bestAgain = LanAddressRanking.Best([Wifi("192.168.0.42"), staticEthernet]);
        Expect(bestAgain?.Address.ToString() == "192.168.0.89", "gigabit ethernet outranks DHCP wifi");
    }

    private static void DockerBridgeLosesToWifi()
    {
        // An UP docker0 (the build host's is down, so this can only be tested synthetically). It is RFC1918 and
        // claims Ethernet, but it has no gateway and sits in the penalised 172.17/16.
        var docker = Nic("docker0", "172.17.0.1", NetworkInterfaceType.Ethernet, gateway: false);
        var best = LanAddressRanking.Best([docker, Wifi()]);
        Expect(best?.InterfaceName == "Wi-Fi", $"wifi beats an up docker bridge (got {best?.InterfaceName ?? "none"})");

        // A libvirt-style bridge that DOES advertise itself as a gateway must still lose to a real wifi NIC on
        // nothing but the range rules... except it cannot, because rule 1 ties and rule 2 (Ethernet) wins. Assert
        // the honest behaviour: a gateway-bearing 192.168.122.1 bridge DOES outrank wifi. This is intentional —
        // "has a default gateway + ethernet" is genuinely indistinguishable from a real LAN NIC.
        var virbr = Nic("virbr0", "192.168.122.1", NetworkInterfaceType.Ethernet, gateway: true);
        Expect(LanAddressRanking.Best([virbr, Wifi()])?.InterfaceName == "virbr0",
            "a gateway-bearing ethernet bridge is indistinguishable from a real LAN NIC (documented limitation)");
    }

    private static void ApipaOnlyIsStillOfferedAsALastResort()
    {
        // 169.254/16 means DHCP failed. It is a bad answer, but it is better than advertising nothing at all —
        // two machines that both self-assigned on the same link CAN actually talk.
        var apipa = Nic("Ethernet", "169.254.11.9", NetworkInterfaceType.Ethernet, gateway: false);
        var best = LanAddressRanking.Best([apipa]);
        Expect(best?.Address.ToString() == "169.254.11.9", "an APIPA-only host still advertises something");

        // ...but anything routable outranks it.
        Expect(LanAddressRanking.Best([apipa, Wifi()])?.InterfaceName == "Wi-Fi", "APIPA loses to a real wifi address");
        // ...including a Tailscale address, since neither has a gateway and CGNAT vs APIPA are both penalised, so
        // the Ethernet tier decides. Pin it so the behaviour is at least deliberate.
        var apipaWireless = Nic("Wi-Fi", "169.254.11.9", NetworkInterfaceType.Wireless80211, gateway: false);
        Expect(LanAddressRanking.Best([apipaWireless, Tailscale()])?.InterfaceName == "Tailscale",
            "with no gateway anywhere, the ethernet-typed tunnel outranks an APIPA wifi (documented limitation)");
    }

    private static void DownAndLoopbackInterfacesAreFiltered()
    {
        var down = Nic("virbr0", "192.168.122.1", gateway: true, status: OperationalStatus.Down);
        var loopbackType = Nic("lo", "127.0.0.1", NetworkInterfaceType.Loopback, gateway: false, loopback: true);
        var loopbackAddress = Nic("weird", "127.0.0.2", NetworkInterfaceType.Ethernet, gateway: true);
        var wildcard = Nic("wildcard", "0.0.0.0", NetworkInterfaceType.Ethernet, gateway: true);

        var ranked = LanAddressRanking.Rank([down, loopbackType, loopbackAddress, wildcard, Wifi()]);
        Expect(ranked.Count == 1, $"only the wifi NIC survives the filters (got {ranked.Count})");
        Expect(ranked[0].InterfaceName == "Wi-Fi", "the surviving candidate is the wifi NIC");
    }

    private static void NoCandidatesAtAll()
    {
        Expect(LanAddressRanking.Best([]) is null, "no candidates yields no address");
        Expect(LanAddressRanking.Rank([]).Count == 0, "ranking an empty list is empty");
        var onlyIneligible = Nic("lo", "127.0.0.1", NetworkInterfaceType.Loopback, gateway: false, loopback: true);
        Expect(LanAddressRanking.Best([onlyIneligible]) is null, "a loopback-only machine yields no address");
    }

    private static void DhcpBreaksATieBetweenOtherwiseEqualNics()
    {
        var manual = Nic("eth-static", "192.168.0.10", NetworkInterfaceType.Ethernet, gateway: true, prefixOrigin: PrefixOrigin.Manual);
        var dhcp = Nic("eth-dhcp", "192.168.0.11", NetworkInterfaceType.Ethernet, gateway: true, prefixOrigin: PrefixOrigin.Dhcp);
        Expect(LanAddressRanking.Best([manual, dhcp])?.InterfaceName == "eth-dhcp", "DHCP breaks a tie between equal NICs");
    }

    private static void TiesKeepEnumerationOrder()
    {
        // Two indistinguishable NICs must resolve to the FIRST one the OS listed — the pre-existing behaviour for
        // machines where no rule discriminates.
        var first = Nic("eth0", "192.168.0.10", NetworkInterfaceType.Ethernet, gateway: true, prefixOrigin: PrefixOrigin.Dhcp);
        var second = Nic("eth1", "192.168.0.11", NetworkInterfaceType.Ethernet, gateway: true, prefixOrigin: PrefixOrigin.Dhcp);
        Expect(LanAddressRanking.Best([first, second])?.InterfaceName == "eth0", "a full tie keeps OS enumeration order");
        Expect(LanAddressRanking.Best([second, first])?.InterfaceName == "eth1", "the tie-break is genuinely order-stable");
    }

    // ---- COUCHCOOP_ADVERTISED_HOST override -----------------------------------------------------------------

    private static void OverrideAcceptsIpLiteralAndHostname()
    {
        Expect(LanAddressRanking.ValidateAdvertisedHostOverride("192.168.1.50") == "192.168.1.50", "an IPv4 literal is accepted");
        Expect(LanAddressRanking.ValidateAdvertisedHostOverride("  192.168.1.50  ") == "192.168.1.50", "surrounding whitespace is trimmed");
        Expect(LanAddressRanking.ValidateAdvertisedHostOverride("couch.local") == "couch.local", "a DNS hostname is accepted");
        Expect(LanAddressRanking.ValidateAdvertisedHostOverride("[fd7a:115c:a1e0::1]") == "fd7a:115c:a1e0::1", "a bracketed IPv6 literal is unwrapped");
        // Deliberately allowed: an operator who WANTS the Tailscale address should be able to pin it.
        Expect(LanAddressRanking.ValidateAdvertisedHostOverride("100.86.76.72") == "100.86.76.72", "the override can pin an address the ranker would demote");

        // The override wins over the ranking — verified through the real env var, restored afterwards.
        var previous = Environment.GetEnvironmentVariable(LanAddressRanking.AdvertisedHostEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(LanAddressRanking.AdvertisedHostEnvironmentVariable, "10.9.9.9");
            Expect(LanAddressRanking.ReadAdvertisedHostOverride() == "10.9.9.9", "the env override is read back");
            Environment.SetEnvironmentVariable(LanAddressRanking.AdvertisedHostEnvironmentVariable, "   ");
            Expect(LanAddressRanking.ReadAdvertisedHostOverride() is null, "a blank env override is treated as unset");
        }
        finally
        {
            Environment.SetEnvironmentVariable(LanAddressRanking.AdvertisedHostEnvironmentVariable, previous);
        }
    }

    private static void OverrideRejectsGarbage()
    {
        foreach (var garbage in new[] { "0.0.0.0", "::", "http://192.168.1.50:13337/", "192.168.1.50:13337", "not a host", "999.999.999.999", "-leading-dash" })
        {
            var logs = new List<string>();
            var resolved = LanAddressRanking.ValidateAdvertisedHostOverride(garbage, logs.Add);
            Expect(resolved is null, $"garbage override '{garbage}' is rejected (got {resolved ?? "null"})");
            Expect(logs.Count == 1, $"garbage override '{garbage}' logs exactly one line (got {logs.Count})");
        }

        var quietLogs = new List<string>();
        Expect(LanAddressRanking.ValidateAdvertisedHostOverride(null, quietLogs.Add) is null, "an unset override yields null");
        Expect(quietLogs.Count == 0, "an unset override is silent — it is not an error");
    }

    // ---- real machine ---------------------------------------------------------------------------------------

    private static void GatherFromOsNeverThrows()
    {
        var logs = new List<string>();
        // PrefixOrigin is Windows-only; on Linux the BCL throws PlatformNotSupportedException for it. If that
        // guard regressed, this call alone would throw out of the suite.
        var gathered = LanAddressRanking.GatherFromOs(logs.Add);
        Expect(gathered.Count >= 0, "GatherFromOs returns a list rather than throwing");
        foreach (var candidate in gathered)
        {
            Expect(candidate.Address is not null, "each gathered candidate carries an address");
        }
    }

    // Informational: prints this machine's REAL ranked list so the fix can be checked against actual NICs.
    private static void PrintRealMachineRanking()
    {
        var gathered = LanAddressRanking.GatherFromOs();
        Console.WriteLine($"  [real-machine] gathered {gathered.Count} IPv4 candidate(s):");
        foreach (var candidate in gathered)
        {
            Console.WriteLine($"    raw  {candidate.Address} if={candidate.InterfaceName} type={candidate.InterfaceType} status={candidate.Status} gw={candidate.HasIpv4Gateway}");
        }

        var ranked = LanAddressRanking.Rank(gathered);
        Console.WriteLine($"  [real-machine] ranked {ranked.Count} eligible candidate(s):");
        for (var index = 0; index < ranked.Count; index++)
        {
            Console.WriteLine($"    #{index} {LanAddressRanking.Describe(ranked[index])}");
        }

        Console.WriteLine($"  [real-machine] winner = {(ranked.Count == 0 ? "<none>" : ranked[0].Address.ToString())}");

        // Reverse the gathered order to emulate an OS that enumerates the tunnel/bridge adapters FIRST — which is
        // exactly the accident that makes this fail on the reporter's Windows box. The ranked winner must not move.
        var reversedGather = gathered.Reverse().ToList();
        var reversed = LanAddressRanking.Rank(reversedGather);
        Console.WriteLine($"  [real-machine] winner with REVERSED enumeration order = {(reversed.Count == 0 ? "<none>" : reversed[0].Address.ToString())}");
        Expect(
            (ranked.Count == 0 && reversed.Count == 0)
                || (ranked.Count > 0 && reversed.Count > 0 && ranked[0].Address.Equals(reversed[0].Address)),
            "the real-machine winner is independent of OS enumeration order");

        // What the code we replaced would have returned, for both orders. On a build host that actually has a
        // tunnel NIC this is a REAL reproduction of the reported defect rather than a synthetic one: same real
        // descriptors, and the only thing that changed is enumeration order.
        Console.WriteLine($"  [real-machine] legacy first-match (OS order)       = {LegacyFirstMatch(gathered) ?? "<none>"}");
        Console.WriteLine($"  [real-machine] legacy first-match (REVERSED order) = {LegacyFirstMatch(reversedGather) ?? "<none>"}");

        // If a CGNAT (Tailscale-range) address is present on this machine, prove the demotion end to end: the old
        // rule hands it out under the reversed order, the new ranker never does.
        var cgnat = ranked.FirstOrDefault(candidate => candidate.Address.GetAddressBytes() is [100, >= 64 and <= 127, _, _]);
        if (cgnat is not null && ranked.Count > 1)
        {
            Console.WriteLine($"  [real-machine] CGNAT NIC present ({cgnat.Address} on {cgnat.InterfaceName}) — checking demotion");
            Expect(!ranked[0].Address.Equals(cgnat.Address), "the ranker never advertises the real CGNAT/Tailscale address");
            Expect(!reversed[0].Address.Equals(cgnat.Address), "...not even when it is enumerated first");
            Expect(LegacyFirstMatch(reversedGather) == cgnat.Address.ToString(),
                "the REPLACED first-match rule really would have advertised it under a reversed enumeration order");
        }
    }

    // The rule this workstream deleted: first IPv4 on the first Up, non-loopback interface, in enumeration order.
    private static string? LegacyFirstMatch(IEnumerable<LanAddressCandidate> candidates)
        => candidates.FirstOrDefault(candidate =>
            candidate.Status == OperationalStatus.Up
            && candidate.InterfaceType != NetworkInterfaceType.Loopback
            && !IPAddress.IsLoopback(candidate.Address))?.Address.ToString();

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"LanAddressRankingTests failed: {because}");
        }
    }
}
