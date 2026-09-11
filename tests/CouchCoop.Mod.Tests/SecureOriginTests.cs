using System.Net;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server;

// WS6 (redesigned): the secure/installable origin, now a PER-ADAPTER row of the single select rather
// than a checkbox. Everything here is pure — no sockets, no certificates, no Godot — because "what does
// the phone scan when a secure row is picked, and may the player pick it at all" is the decision this
// feature actually turns on, and it must be falsifiable without a game or a network.
//
// The invariant under test throughout is that a secure row can NEVER quietly stand in for a working
// plain row: every path that cannot produce a genuine https URL must answer "listed but disabled, and
// here is the one-line reason", so the default stays the plain-HTTP QR that works with no internet.
internal static class SecureOriginTests
{
    private const string Domain = "my.local-ip.co";
    private const int SecurePort = 13338;

    public static void Run()
    {
        DashedHostNameIsBuiltFromTheAdvertisedIpv4();
        HostNameRejectsAddressesAPhoneCouldNeverReach();
        HostNameTrimsAndRejectsUnusableDomains();

        SecureOptionCarriesHttpsAndTheRealSecurePort();
        LanOptionsStayHttp();
        SecurePayloadMatchesTheEncodedQrPayload();

        RowIsDisabledWithoutATlsListener();
        RowIsDisabledWithoutARoutableIpv4();
        MissingDomainFallsBackToTheDefaultProvider();
        SecureRowsAppearOncePerEligibleAdapter();

        PreferenceDefaultsToAbsentAndRoundTrips();
        PreferenceTreatsCorruptStoreAsAbsent();

        Console.WriteLine("SecureOriginTests: ok");
    }

    private static QrAdapterInfo Adapter(string address, string name = "Wi-Fi", QrAdapterKind kind = QrAdapterKind.Wifi)
        => new(name, kind, IPAddress.Parse(address));

    // ---- host name derivation -------------------------------------------------------------------------

    private static void DashedHostNameIsBuiltFromTheAdvertisedIpv4()
    {
        var host = SecureOriginHost.ToHostName(IPAddress.Parse("192.168.1.5"), Domain);
        Expect(host == "192-168-1-5.my.local-ip.co", $"the dashed quad is one label under the domain (got {host})");

        // The wildcard these providers publish is SINGLE-LABEL (*.my.local-ip.co), so a name with an extra
        // dot in the quad position would fail the phone's hostname check against the certificate.
        Expect(host!.Split('.').Length == 4, "the quad collapses to exactly one label");
    }

    private static void HostNameRejectsAddressesAPhoneCouldNeverReach()
    {
        Expect(SecureOriginHost.ToHostName(IPAddress.Loopback, Domain) is null, "loopback is refused");
        Expect(SecureOriginHost.ToHostName(IPAddress.Any, Domain) is null, "0.0.0.0 is refused");
        Expect(SecureOriginHost.ToHostName(IPAddress.Broadcast, Domain) is null, "the broadcast address is refused");
        Expect(SecureOriginHost.ToHostName(IPAddress.Parse("169.254.10.3"), Domain) is null, "APIPA/link-local is refused");
        Expect(SecureOriginHost.ToHostName(IPAddress.Parse("224.0.0.251"), Domain) is null, "multicast is refused");
        Expect(SecureOriginHost.ToHostName(IPAddress.IPv6Loopback, Domain) is null, "IPv6 is refused (the scheme is IPv4-shaped)");
        Expect(SecureOriginHost.ToHostName(null, Domain) is null, "a missing address is refused");

        // ...but an ordinary RFC1918 LAN address, and a routable public one, are both fine.
        Expect(SecureOriginHost.IsSecureOriginEligible(IPAddress.Parse("10.0.0.7")), "10/8 is eligible");
        Expect(SecureOriginHost.IsSecureOriginEligible(IPAddress.Parse("172.16.4.9")), "172.16/12 is eligible");
    }

    private static void HostNameTrimsAndRejectsUnusableDomains()
    {
        var address = IPAddress.Parse("192.168.0.42");
        Expect(SecureOriginHost.ToHostName(address, " my.local-ip.co. ") == "192-168-0-42.my.local-ip.co",
            "surrounding whitespace and a trailing root dot are trimmed");
        Expect(SecureOriginHost.ToHostName(address, null) is null, "a null domain is refused");
        Expect(SecureOriginHost.ToHostName(address, "   ") is null, "a blank domain is refused");
        Expect(SecureOriginHost.ToHostName(address, ".") is null, "a domain that trims to nothing is refused");
    }

    // ---- the option itself ----------------------------------------------------------------------------

    private static void SecureOptionCarriesHttpsAndTheRealSecurePort()
    {
        var option = QrHostOptions.DescribeSecureFor(Adapter("192.168.1.5"), Domain, SecurePort, null);
        Expect(option.Enabled, "a routable IPv4 plus a domain plus a port yields a selectable row");
        Expect(option.Kind == QrHostOptionKind.Secure, "it is the Secure kind");
        Expect(option.Port == SecurePort, "it carries the TLS listener's port, not the HTTP one");
        Expect(option.ToUri().ToString() == $"https://192-168-1-5.my.local-ip.co:{SecurePort}/",
            $"and encodes an https URL (got {option.ToUri()})");
        Expect(option.Adapter!.Address.ToString() == "192.168.1.5", "and remembers which adapter it is for");
    }

    private static void LanOptionsStayHttp()
    {
        // The scheme is derived from Kind, so no caller can produce a Secure option over http (which would
        // defeat the certificate) or a LAN option over https (which nothing is listening for).
        var mdns = new QrHostOption("my-pc.local", 13337, QrHostOptionKind.Mdns, null);
        var iface = new QrHostOption("192.168.1.5", 13337, QrHostOptionKind.Interface, Adapter("192.168.1.5"));
        var pinned = new QrHostOption("pinned.example", 13337, QrHostOptionKind.Override, null);

        Expect(mdns.ToUri().Scheme == "http", "the .local row stays http");
        Expect(iface.ToUri().Scheme == "http", "a literal-IP row stays http");
        Expect(pinned.ToUri().Scheme == "http", "an operator-pinned row stays http");
    }

    // The scanned code and the typed URL label are both rendered from the option, exactly as for the LAN
    // rows — the secure path must not become the one place where they can disagree.
    private static void SecurePayloadMatchesTheEncodedQrPayload()
    {
        var option = QrHostOptions.DescribeSecureFor(Adapter("10.1.2.3"), Domain, SecurePort, null);
        var uri = option.ToUri();
        var encoded = OfflineQrCode.EncodeJoinUrl(uri, quietZoneModules: 0);
        Expect(encoded.Payload == uri.ToString(), "the encoded payload is exactly the secure option URL");
    }

    // ---- availability (what the disabled row renders) --------------------------------------------------

    private static void RowIsDisabledWithoutATlsListener()
    {
        var pending = QrHostOptions.DescribeSecureFor(Adapter("192.168.1.5"), Domain, securePort: 0, null);
        Expect(!pending.Enabled, "no bound TLS port means the row cannot be picked");
        Expect(pending.DisabledReason?.Resolve() == QrHostOptions.SecurePendingReason,
            "with the pending blocker when no better reason is known");
        Expect(pending.Host == "192-168-1-5.my.local-ip.co", "while the label still names the host it WOULD encode");

        var reasoned = QrHostOptions.DescribeSecureFor(Adapter("192.168.1.5"), Domain, securePort: 0,
            "No internet, or the certificate service is down.");
        Expect(reasoned.DisabledReason?.Resolve() == "No internet, or the certificate service is down.",
            "the provider's own one-line reason is passed through verbatim");
    }

    private static void RowIsDisabledWithoutARoutableIpv4()
    {
        // APIPA means "DHCP failed" — public DNS mapping the dashed name back to it buys nothing.
        var option = QrHostOptions.DescribeSecureFor(Adapter("169.254.3.4"), Domain, SecurePort, null);
        Expect(!option.Enabled, "a link-local adapter cannot carry a secure origin");
        Expect(option.DisabledReason?.Resolve() == QrHostOptions.AddressNotEligibleReason, "with the address blocker");
    }

    private static void MissingDomainFallsBackToTheDefaultProvider()
    {
        // The snapshot's SecureDomain is null until the certificate provider is constructed; the disabled
        // row shown before that must still name a real host rather than render a blank label.
        var option = QrHostOptions.DescribeSecureFor(Adapter("192.168.1.5"), secureDomain: null, securePort: 0, null);
        Expect(option.Host == "192-168-1-5." + LocalIpCoCertificateProvider.DefaultDomain,
            $"a missing domain falls back to the shipped provider (got {option.Host})");
    }

    // The checkbox-era invariant ("secure is never a row") is deliberately INVERTED by the redesign:
    // the secure origin is now exactly one row per eligible adapter, derived from that adapter.
    private static void SecureRowsAppearOncePerEligibleAdapter()
    {
        var options = QrHostOptions.Build(
            "Living-Room-PC",
            advertisedOverride: null,
            candidates:
            [
                new LanAddressCandidate(
                    "Wi-Fi",
                    System.Net.NetworkInformation.NetworkInterfaceType.Wireless80211,
                    System.Net.NetworkInformation.OperationalStatus.Up,
                    false,
                    IPAddress.Parse("192.168.1.5"),
                    System.Net.NetworkInformation.PrefixOrigin.Dhcp,
                    true),
                new LanAddressCandidate(
                    "Ethernet",
                    System.Net.NetworkInformation.NetworkInterfaceType.Ethernet,
                    System.Net.NetworkInformation.OperationalStatus.Up,
                    false,
                    IPAddress.Parse("192.168.1.6"),
                    System.Net.NetworkInformation.PrefixOrigin.Dhcp,
                    true),
            ],
            port: 13337,
            webOrigin: "https://sts2-couch.pages.dev",
            secureDomain: Domain,
            securePort: SecurePort,
            secureUnavailableReason: null);

        var secureRows = options.Where(option => option.Kind == QrHostOptionKind.Secure).ToList();
        Expect(secureRows.Count == 2, "one secure row per adapter");
        Expect(secureRows.All(option => option.ToUri().Scheme == "https"), "each over https");
        Expect(secureRows.Select(option => option.Host).Distinct().Count() == 2,
            "each dashing its own adapter's address");
    }

    // ---- persistence -----------------------------------------------------------------------------------

    private static void PreferenceDefaultsToAbsentAndRoundTrips()
    {
        var path = Path.Combine(Path.GetTempPath(), "couchcoop-qr-prefs-" + Guid.NewGuid().ToString("N"), "qr-prefs.json");

        // The polarity that matters: an absent store restores nothing, so a player who has never picked —
        // or whose profile is fresh — gets the dialog's own default (the plain QR that needs no internet).
        Expect(CouchCoopQrSelectionPreference.TryRead(path) is null, "an absent store reads as no memory");

        CouchCoopQrSelectionPreference.TryWrite(path, new QrSelectionMemory("secure", "192.168.1.5"));
        var memory = CouchCoopQrSelectionPreference.TryRead(path);
        Expect(memory == new QrSelectionMemory("secure", "192.168.1.5"), "a written pick round-trips");
        Expect(memory!.PreferredSelectionKey == "secure|192.168.1.5", "and names the selection key it wants back");

        CouchCoopQrSelectionPreference.TryWrite(path, new QrSelectionMemory("mdns", null));
        Expect(CouchCoopQrSelectionPreference.TryRead(path) == new QrSelectionMemory("mdns", null),
            "a hostless method round-trips too");
        Expect(CouchCoopQrSelectionPreference.TryRead(path)!.PreferredSelectionKey == "mdns",
            "as a bare method token");

        CouchCoopQrSelectionPreference.TryWrite(path, new QrSelectionMemory("secure", "192.168.1.5"));
        var raw = File.ReadAllText(path);
        Expect(!raw.Contains("\"mode\"", StringComparison.Ordinal), "the retired mode key is not written");
        Expect(!raw.Contains("\"preferSecure\"", StringComparison.Ordinal), "the retired preferSecure key is not written");

        try
        {
            Directory.Delete(Path.GetDirectoryName(path)!, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private static void PreferenceTreatsCorruptStoreAsAbsent()
    {
        var directory = Path.Combine(Path.GetTempPath(), "couchcoop-qr-prefs-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "qr-prefs.json");

        File.WriteAllText(path, "{ this is not json");
        Expect(CouchCoopQrSelectionPreference.TryRead(path) is null, "a malformed store reads as absent, not as a throw");

        File.WriteAllText(path, "[]");
        Expect(CouchCoopQrSelectionPreference.TryRead(path) is null, "a non-object store reads as absent");

        // A method a NEWER build invented must fall back to the offline-safe default rather than be guessed at.
        File.WriteAllText(path, """{"selection":{"method":"teleport","host":"192.168.1.5"}}""");
        Expect(CouchCoopQrSelectionPreference.TryRead(path) is null, "an unknown method reads as absent");

        File.WriteAllText(path, """{"selection":{"method":42}}""");
        Expect(CouchCoopQrSelectionPreference.TryRead(path) is null, "a wrongly-typed method reads as absent");

        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"SecureOriginTests failed: {because}");
        }
    }
}
