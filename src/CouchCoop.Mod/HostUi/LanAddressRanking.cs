using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

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
    bool HasIpv4Gateway);

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
            + (TypeTier(candidate.InterfaceType) * TypeTierWeight)
            + (IsPenalisedRange(candidate.Address) ? 0 : UnpenalisedRangeWeight)
            + (IsRfc1918(candidate.Address) ? Rfc1918Weight : 0)
            + (candidate.PrefixOrigin == PrefixOrigin.Dhcp ? DhcpWeight : 0);

    // Rule 1 is carried by HasIpv4Gateway on the descriptor itself (dominant signal — a tunnel/bridge adapter has
    // no default gateway, a real LAN NIC does). Rule 2 is the interface-type tier.
    //
    // Public so the QR dialog's own grouping (QrHostOptions.BestPerAdapter) can order its adapter groups by the
    // same tiers without a second copy of this table. That grouping leads with the tier where Rank leads with the
    // gateway — see the remarks on QrHostOptions for why the two orderings deliberately differ.
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
            + $"score={ScoreOf(candidate)} gw={(candidate.HasIpv4Gateway ? 1 : 0)} tier={TypeTier(candidate.InterfaceType)} "
            + $"range={(IsPenalisedRange(candidate.Address) ? "penalised" : IsRfc1918(candidate.Address) ? "rfc1918" : "public")} "
            + $"origin={candidate.PrefixOrigin}";

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

        foreach (var unicast in properties.UnicastAddresses)
        {
            if (unicast.Address?.AddressFamily != AddressFamily.InterNetwork)
            {
                continue;
            }

            candidates.Add(new LanAddressCandidate(
                networkInterface.Name,
                networkInterface.NetworkInterfaceType,
                networkInterface.OperationalStatus,
                networkInterface.NetworkInterfaceType == NetworkInterfaceType.Loopback,
                unicast.Address,
                ReadPrefixOrigin(unicast),
                hasIpv4Gateway));
        }
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
