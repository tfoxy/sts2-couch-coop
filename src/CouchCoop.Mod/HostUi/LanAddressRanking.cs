using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace CouchCoop.Mod.HostUi;

// WS-F: which IPv4 address does the host advertise to phones/browsers (lobby QR, URL label, availability log, and
// the LAN discovery reply — all four read the SAME value)?
//
// The old answer was "the first IPv4 on the first Up, non-loopback interface the OS happens to enumerate", i.e. no
// ranking at all. On a Windows machine with a mesh-VPN client installed that hands out the tunnel's CGNAT address
// (100.64.0.0/10), which no phone on the wifi can reach — the QR scans, then hangs. That kind of tunnel adapter
// reports NetworkInterfaceType.Ethernet on Windows, so interface type alone does NOT demote it.
//
// This file splits the decision into two halves so it is testable without real NICs:
//   * GatherFromOs()  — the impure half: walk the OS interface list into flat LanAddressCandidate descriptors.
//   * Rank()/Best()   — the PURE half: order descriptors by the rules below. Unit-tested with synthetic tunnels,
//                       docker bridges and APIPA addresses that we cannot conjure on a real host.
public sealed record LanAddressCandidate(
    string InterfaceName,
    NetworkInterfaceType InterfaceType,
    OperationalStatus Status,
    bool IsLoopbackInterface,
    IPAddress Address,
    PrefixOrigin PrefixOrigin,
    bool HasIpv4Gateway,
    VirtualAdapterSignal Virtual = VirtualAdapterSignal.None);

// Why an adapter counts as virtual (a VPN tunnel, a VM host-only network, a bridge), if it does. Windows reports
// most of these as NetworkInterfaceType.Ethernet, so without this a VPN outranks the wifi a phone is actually on.
public enum VirtualAdapterSignal
{
    None,
    // The OS says so: Windows interface flags (no hardware interface, no connector or no physical medium), or no
    // Linux device node.
    OsFlags,
    // The adapter's description names it ("ZeroTier Virtual Port", "Radmin VPN Ethernet Adapter").
    Description,
}

public static class LanAddressRanking
{
    // Safety valve: an operator can pin the advertised host outright. There was no escape hatch before, so a
    // machine our ranking gets wrong had no fix short of a code change. Wins over everything, including an
    // explicit bind address.
    public const string AdvertisedHostEnvironmentVariable = "COUCHCOOP_ADVERTISED_HOST";

    // Rule weights, most significant first. Each weight is strictly greater than the sum of every weight below it,
    // so the packed score compares exactly like the lexicographic tuple (gateway, tier, notPenalised, rfc1918, dhcp)
    // while staying a single printable integer.
    private const int GatewayWeight = 32;   // > 16 + 4 + 2 + 1
    private const int TypeTierWeight = 8;   // tier 0..2 -> 0/8/16, and 16 > 4 + 2 + 1
    private const int UnpenalisedRangeWeight = 4; // > 2 + 1
    private const int Rfc1918Weight = 2;    // > 1
    private const int DhcpWeight = 1;

    // Rank every eligible candidate best-first. Ties keep OS enumeration order (LINQ's OrderByDescending is a
    // stable sort), which preserves the old behaviour for machines where no rule discriminates.
    public static IReadOnlyList<LanAddressCandidate> Rank(IEnumerable<LanAddressCandidate> candidates)
        => [.. (candidates ?? []).Where(IsEligible).OrderByDescending(ScoreOf)];

    public static LanAddressCandidate? Best(IEnumerable<LanAddressCandidate> candidates)
        => Rank(candidates).FirstOrDefault();

    // Keeps the pre-existing filters: interface must be Up and must not be loopback. Only IPv4 is advertised — the
    // join URL, the QR and the discovery reply are all IPv4-shaped today.
    public static bool IsEligible(LanAddressCandidate candidate)
        => candidate is not null
            && candidate.Status == OperationalStatus.Up
            && !candidate.IsLoopbackInterface
            && candidate.InterfaceType != NetworkInterfaceType.Loopback
            && candidate.Address is not null
            && candidate.Address.AddressFamily == AddressFamily.InterNetwork
            && !IPAddress.IsLoopback(candidate.Address)
            && !IPAddress.Any.Equals(candidate.Address);

    public static int ScoreOf(LanAddressCandidate candidate)
        => (candidate.HasIpv4Gateway ? GatewayWeight : 0)
            + (TierOf(candidate) * TypeTierWeight)
            + (IsPenalisedRange(candidate.Address) ? 0 : UnpenalisedRangeWeight)
            + (IsRfc1918(candidate.Address) ? Rfc1918Weight : 0)
            + (candidate.PrefixOrigin == PrefixOrigin.Dhcp ? DhcpWeight : 0);

    // Rule 2 for one candidate: a virtual adapter is "other" whatever type it reports, so a gatewayed VPN tunnel
    // can no longer beat the gatewayed wifi on the Ethernet tier.
    public static int TierOf(LanAddressCandidate candidate)
        => candidate.Virtual == VirtualAdapterSignal.None ? TypeTier(candidate.InterfaceType) : 0;

    // Rule 1 is carried by HasIpv4Gateway on the descriptor itself (dominant signal — a tunnel/bridge adapter has
    // no default gateway, a real LAN NIC does). Rule 2 is the interface-type tier, see TierOf.
    public static int TypeTier(NetworkInterfaceType type) => type switch
    {
        NetworkInterfaceType.Ethernet
            or NetworkInterfaceType.Ethernet3Megabit
            or NetworkInterfaceType.FastEthernetT
            or NetworkInterfaceType.FastEthernetFx
            or NetworkInterfaceType.GigabitEthernet => 2,
        NetworkInterfaceType.Wireless80211 => 1,
        _ => 0,
    };

    // Rule 3: ranges that are never the address a phone on the couch should be handed.
    //   100.64.0.0/10  CGNAT — the range mesh-VPN tunnels hand out.
    //   169.254.0.0/16 APIPA — a link-local self-assignment, i.e. DHCP failed.
    //   172.17.0.0/16  the default Docker bridge.
    private static bool IsPenalisedRange(IPAddress address)
    {
        Span<byte> octets = stackalloc byte[4];
        if (!address.TryWriteBytes(octets, out var written) || written != 4)
        {
            return true;
        }

        return (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127)
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && octets[1] == 17);
    }

    // Rule 4: RFC1918 private space is what a couch-co-op LAN actually looks like.
    private static bool IsRfc1918(IPAddress address)
    {
        Span<byte> octets = stackalloc byte[4];
        if (!address.TryWriteBytes(octets, out var written) || written != 4)
        {
            return false;
        }

        return octets[0] == 10
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168);
    }

    // One-line description used for the startup log of the whole ranked list. When a user reports "it shows the
    // wrong IP", this log is the evidence: it names every candidate and why it lost.
    public static string Describe(LanAddressCandidate candidate)
        => $"{candidate.Address} if={candidate.InterfaceName} type={candidate.InterfaceType} "
            + $"score={ScoreOf(candidate)} gw={(candidate.HasIpv4Gateway ? 1 : 0)} tier={TierOf(candidate)} "
            + $"range={(IsPenalisedRange(candidate.Address) ? "penalised" : IsRfc1918(candidate.Address) ? "rfc1918" : "public")} "
            + $"origin={candidate.PrefixOrigin} "
            + $"virtual={candidate.Virtual switch { VirtualAdapterSignal.OsFlags => "os", VirtualAdapterSignal.Description => "desc", _ => "0" }}";

    // Impure half. Never throws: NetworkInformationException (and a transient adapter disappearing between the
    // enumeration and the property read) used to escape all the way out of CouchCoopHostUiServices.StartAsync and
    // surface as `host-ui-startup-failed`, tearing down an ALREADY-LISTENING browser server over a networking
    // hiccup. A gather failure now degrades to "no candidates" instead.
    public static IReadOnlyList<LanAddressCandidate> GatherFromOs(Action<string>? log = null)
    {
        NetworkInterface[] interfaces;
        try
        {
            interfaces = NetworkInterface.GetAllNetworkInterfaces();
        }
        catch (NetworkInformationException exception)
        {
            log?.Invoke($"lan-address enumeration failed detail={exception.GetType().Name}:{exception.ErrorCode}");
            return [];
        }
        catch (PlatformNotSupportedException exception)
        {
            log?.Invoke($"lan-address enumeration unsupported detail={exception.GetType().Name}");
            return [];
        }

        var candidates = new List<LanAddressCandidate>();
        foreach (var networkInterface in interfaces)
        {
            try
            {
                CollectFrom(networkInterface, candidates);
            }
            catch (Exception exception) when (exception is NetworkInformationException
                or PlatformNotSupportedException
                or ObjectDisposedException
                or NotSupportedException)
            {
                // One flaky adapter (a VPN tearing down mid-enumeration is the common case) must not cost us the
                // rest of the list.
                log?.Invoke($"lan-address interface skipped detail={exception.GetType().Name}");
            }
        }

        return candidates;
    }

    private static void CollectFrom(NetworkInterface networkInterface, List<LanAddressCandidate> candidates)
    {
        var properties = networkInterface.GetIPProperties();

        // Windows reports a placeholder 0.0.0.0 gateway on some adapters that have none — treat that as "no
        // gateway" or the dominant rule would be satisfied by every such adapter.
        var hasIpv4Gateway = properties.GatewayAddresses.Any(gateway =>
            gateway.Address is { } address
            && address.AddressFamily == AddressFamily.InterNetwork
            && !IPAddress.Any.Equals(address));

        VirtualAdapterSignal? virtualSignal = null;
        foreach (var unicast in properties.UnicastAddresses)
        {
            if (unicast.Address?.AddressFamily != AddressFamily.InterNetwork)
            {
                continue;
            }

            virtualSignal ??= ClassifyVirtual(networkInterface, properties);
            candidates.Add(new LanAddressCandidate(
                networkInterface.Name,
                networkInterface.NetworkInterfaceType,
                networkInterface.OperationalStatus,
                networkInterface.NetworkInterfaceType == NetworkInterfaceType.Loopback,
                unicast.Address,
                ReadPrefixOrigin(unicast),
                hasIpv4Gateway,
                virtualSignal.Value));
        }
    }

    // The OS verdict first; the description words catch what it misses, including a VPN driver that claims to be
    // hardware. Never throws: an adapter we cannot classify is treated as real, which is the old behaviour.
    private static VirtualAdapterSignal ClassifyVirtual(NetworkInterface networkInterface, IPInterfaceProperties properties)
    {
        try
        {
            if (IsVirtualByOs(networkInterface, properties) == true)
            {
                return VirtualAdapterSignal.OsFlags;
            }

            return DescriptionNamesVirtualAdapter(networkInterface.Description)
                ? VirtualAdapterSignal.Description
                : VirtualAdapterSignal.None;
        }
        catch (Exception exception) when (exception is NetworkInformationException
            or PlatformNotSupportedException
            or IOException
            or UnauthorizedAccessException
            or DllNotFoundException
            or EntryPointNotFoundException)
        {
            return VirtualAdapterSignal.None;
        }
    }

    // null = no verdict (unsupported OS, failed call), never "virtual".
    private static bool? IsVirtualByOs(NetworkInterface networkInterface, IPInterfaceProperties properties)
    {
        if (OperatingSystem.IsWindows())
        {
            var index = properties.GetIPv4Properties()?.Index;
            return index is int value ? IsVirtualByWindowsFlags(value) : null;
        }

        if (OperatingSystem.IsLinux())
        {
            // Every NIC backed by a bus device (PCI, USB, SDIO, virtio) has a `device` link in sysfs; bridges,
            // tunnels and VPN taps do not.
            var node = Path.Combine("/sys/class/net", networkInterface.Name);
            return Directory.Exists(node) ? !Directory.Exists(Path.Combine(node, "device")) : null;
        }

        return null;
    }

    private static bool? IsVirtualByWindowsFlags(int interfaceIndex)
    {
        var row = new MibIfRow2 { InterfaceIndex = (uint)interfaceIndex };
        if (GetIfEntry2(ref row) != 0)
        {
            return null;
        }

        return !IsPhysicalByWindowsFlags(row.InterfaceAndOperStatusFlags, row.PhysicalMediumType);
    }

    // Bit 0 HardwareInterface, bit 2 ConnectorPresent (MIB_IF_ROW2.InterfaceAndOperStatusFlags), and a physical
    // medium other than NdisPhysicalMediumUnspecified (0). A real NIC has all three (802.3 is 14, native 802.11 is
    // 9). Windows' own KM-TEST loopback driver claims hardware and a connector but reports no medium, so the
    // medium is what catches it.
    public static bool IsPhysicalByWindowsFlags(byte flags, uint physicalMediumType)
        => (flags & 0b101) == 0b101 && physicalMediumType != 0;

    private static readonly string[] VirtualDescriptionWords = ["virtual", "vpn", "tunnel", "loopback", "tap"];

    // Generic words only, matched as whole words, so "TAP-Windows Adapter V9" matches and "Realtek ... Adapter"
    // does not. Product names would be a list that every new VPN outdates.
    public static bool DescriptionNamesVirtualAdapter(string? description)
    {
        if (string.IsNullOrWhiteSpace(description))
        {
            return false;
        }

        var lower = description.ToLowerInvariant();
        if (lower.Contains("host-only", StringComparison.Ordinal))
        {
            return true;
        }

        var start = -1;
        for (var index = 0; index <= lower.Length; index++)
        {
            if (index < lower.Length && char.IsAsciiLetterOrDigit(lower[index]))
            {
                if (start < 0) start = index;
                continue;
            }

            if (start >= 0 && VirtualDescriptionWords.Contains(lower[start..index]))
            {
                return true;
            }

            start = -1;
        }

        return false;
    }

    [DllImport("iphlpapi.dll", ExactSpelling = true)]
    private static extern int GetIfEntry2(ref MibIfRow2 row);

    // MIB_IF_ROW2 from netioapi.h, declared in full so the flags byte sits at its real offset (1152 of 1352 on
    // x64; pinned by LanAddressRankingTests).
    [StructLayout(LayoutKind.Sequential)]
    public unsafe struct MibIfRow2
    {
        public ulong InterfaceLuid;
        public uint InterfaceIndex;
        public Guid InterfaceGuid;
        public fixed char Alias[257];
        public fixed char Description[257];
        public uint PhysicalAddressLength;
        public fixed byte PhysicalAddress[32];
        public fixed byte PermanentPhysicalAddress[32];
        public uint Mtu;
        public uint Type;
        public uint TunnelType;
        public uint MediaType;
        public uint PhysicalMediumType;
        public uint AccessType;
        public uint DirectionType;
        public byte InterfaceAndOperStatusFlags;
        public uint OperStatus;
        public uint AdminStatus;
        public uint MediaConnectState;
        public Guid NetworkGuid;
        public uint ConnectionType;
        public ulong TransmitLinkSpeed;
        public ulong ReceiveLinkSpeed;
        public ulong InOctets;
        public ulong InUcastPkts;
        public ulong InNUcastPkts;
        public ulong InDiscards;
        public ulong InErrors;
        public ulong InUnknownProtos;
        public ulong InUcastOctets;
        public ulong InMulticastOctets;
        public ulong InBroadcastOctets;
        public ulong OutOctets;
        public ulong OutUcastPkts;
        public ulong OutNUcastPkts;
        public ulong OutDiscards;
        public ulong OutErrors;
        public ulong OutUcastOctets;
        public ulong OutMulticastOctets;
        public ulong OutBroadcastOctets;
        public ulong OutQLen;
    }

    // PrefixOrigin is a Windows-only property: on Linux/macOS the BCL throws PlatformNotSupportedException for it.
    // Reading it unguarded would be an instant crash on the dev/Steam-Deck side, so it degrades to PrefixOrigin.Other there
    // (which simply makes rule 5 inert off Windows — every candidate scores the same on it).
#pragma warning disable CA1416 // Guarded by the catch below rather than by an OS check.
    private static PrefixOrigin ReadPrefixOrigin(UnicastIPAddressInformation unicast)
    {
        try
        {
            return unicast.PrefixOrigin;
        }
        catch (PlatformNotSupportedException)
        {
            return PrefixOrigin.Other;
        }
    }
#pragma warning restore CA1416

    // Reads and validates COUCHCOOP_ADVERTISED_HOST. Returns null when unset or garbage.
    public static string? ReadAdvertisedHostOverride(Action<string>? log = null)
        => ValidateAdvertisedHostOverride(Environment.GetEnvironmentVariable(AdvertisedHostEnvironmentVariable), log);

    // Pure validator so the override is testable without mutating process environment. Accepts an IP literal or a
    // DNS host name; anything else (a full URL, a host:port pair, 0.0.0.0) is REJECTED with a log line rather than
    // advertised — a bad override would otherwise poison the QR, the label and the discovery reply at once.
    public static string? ValidateAdvertisedHostOverride(string? raw, Action<string>? log = null)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var value = raw.Trim();
        var unbracketed = value.Length > 2 && value[0] == '[' && value[^1] == ']'
            ? value[1..^1]
            : value;

        if (IPAddress.TryParse(unbracketed, out var address))
        {
            if (IPAddress.Any.Equals(address) || IPAddress.IPv6Any.Equals(address))
            {
                log?.Invoke($"advertised-host override ignored value={value} reason=wildcard-address");
                return null;
            }

            // A literal is returned in its canonical form; UriBuilder re-brackets IPv6 itself.
            return address.ToString();
        }

        // Uri.CheckHostName says "999.999.999.999" is a valid DNS name (all-digit labels are legal DNS labels), so
        // a typo'd IP would sail through as a hostname and get advertised verbatim. Anything built only from
        // digits and dots was plainly MEANT to be an IPv4 literal, and it already failed to parse as one.
        if (unbracketed.All(character => char.IsAsciiDigit(character) || character == '.'))
        {
            log?.Invoke($"advertised-host override ignored value={value} reason=malformed-ip-literal");
            return null;
        }

        if (Uri.CheckHostName(unbracketed) == UriHostNameType.Dns)
        {
            return unbracketed;
        }

        log?.Invoke($"advertised-host override ignored value={value} reason=not-an-address-or-hostname");
        return null;
    }
}
