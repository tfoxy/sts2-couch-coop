using System.Net;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server;

// The "web link" QR option: the public-origin client that reaches this PC by literal IPv4 under the
// browser's Local Network Access permission (docs/agents/local-network-access.md).
//
// Everything here is pure — no Godot, no NICs, no sockets — for the same reason QrHostOptionsTests is:
// "what does the phone scan, and who is allowed to talk to us" is the part of this feature that is
// genuinely hard to get right, and it has to be falsifiable without a game or a phone.
internal static class WebOriginTests
{
    public static void Run()
    {
        OriginNormalises();
        OriginRejectsNonHttpSchemes();
        ResolveFallsBackToTheShippedDefault();
        JoinUrlCarriesTheHostAuthority();

        OfferNeedsARoutableAddress();
        OfferNeedsAPort();
        OfferNeedsAConfiguredOrigin();
        OfferEncodesThePublicOriginNotTheLan();
        OfferSurvivesTheQrPayloadNormaliser();

        AbsentOriginIsAllowed();
        SameOriginIsAllowed();
        ConfiguredWebOriginIsAllowed();
        ForeignOriginIsRefused();
        PortHopToAHeadlessSeatIsAllowed();
        UnparseableOriginIsRefused();
        KillSwitchAllowsEverything();

        Console.WriteLine("WebOriginTests: ok");
    }

    // ---- origin parsing --------------------------------------------------------------------------------

    private static void OriginNormalises()
    {
        Expect(CouchCoopWebOrigin.Normalize("https://sts2-couch.pages.dev/") == "https://sts2-couch.pages.dev",
            "a trailing slash is dropped");
        Expect(CouchCoopWebOrigin.Normalize("  https://a.example/some/path?q=1  ") == "https://a.example",
            "path and query are dropped, and the value is trimmed");
        Expect(CouchCoopWebOrigin.Normalize("http://127.0.0.1:4173") == "http://127.0.0.1:4173",
            "an explicit port survives");
    }

    private static void OriginRejectsNonHttpSchemes()
    {
        // This value is pasted into a QR and used as an allow-list entry; neither has any business
        // carrying another scheme.
        Expect(CouchCoopWebOrigin.Normalize("ws://a.example") is null, "ws is refused");
        Expect(CouchCoopWebOrigin.Normalize("file:///etc/passwd") is null, "file is refused");
        Expect(CouchCoopWebOrigin.Normalize("not a url") is null, "nonsense is refused");
        Expect(CouchCoopWebOrigin.Normalize("") is null, "empty is refused");
        Expect(CouchCoopWebOrigin.Normalize(null) is null, "null is refused");
    }

    private static void ResolveFallsBackToTheShippedDefault()
    {
        var previous = Environment.GetEnvironmentVariable(CouchCoopWebOrigin.EnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(CouchCoopWebOrigin.EnvironmentVariable, null);
            Expect(CouchCoopWebOrigin.Resolve() == CouchCoopWebOrigin.DefaultOrigin, "unset falls back");

            Environment.SetEnvironmentVariable(CouchCoopWebOrigin.EnvironmentVariable, "https://tunnel.example/");
            Expect(CouchCoopWebOrigin.Resolve() == "https://tunnel.example", "the override wins, normalised");

            // The override is how a tunnel rehearsal points the QR somewhere else with no rebuild, so a
            // TYPO in it must not silently break the QR — it falls back to the shipped origin instead.
            Environment.SetEnvironmentVariable(CouchCoopWebOrigin.EnvironmentVariable, "gibberish");
            Expect(CouchCoopWebOrigin.Resolve() == CouchCoopWebOrigin.DefaultOrigin, "a bad override falls back");
        }
        finally
        {
            Environment.SetEnvironmentVariable(CouchCoopWebOrigin.EnvironmentVariable, previous);
        }
    }

    private static void JoinUrlCarriesTheHostAuthority()
    {
        var url = CouchCoopWebOrigin.BuildJoinUrl("https://sts2-couch.pages.dev", "192.168.1.5:13337");
        Expect(url == "https://sts2-couch.pages.dev/?h=192.168.1.5:13337", $"join url shape, got {url}");
        // The colon stays literal: it is legal unescaped in a query value, and `%3A` would cost three
        // characters of QR payload — which is module count, which is scan time across a room.
        Expect(!url.Contains("%3A", StringComparison.Ordinal), "the colon is not percent-escaped");
    }

    // ---- the row (per adapter, since the single-select redesign) ---------------------------------------

    private static QrAdapterInfo Adapter(string address)
        => new("Wi-Fi", QrAdapterKind.Wifi, IPAddress.Parse(address));

    private static void OfferNeedsARoutableAddress()
    {
        foreach (var address in new[] { "127.0.0.1", "169.254.3.4", "0.0.0.0" })
        {
            var row = QrHostOptions.DescribeWebFor(Adapter(address), 13337, "https://a.example");
            Expect(row is { Enabled: false }, $"{address} cannot carry a web link — the row is listed disabled");
            Expect(row!.DisabledReason is { Length: > 0 }, "and still explains itself");
        }
    }

    private static void OfferNeedsAPort()
    {
        var row = QrHostOptions.DescribeWebFor(Adapter("192.168.1.5"), 0, "https://a.example");
        Expect(row is { Enabled: false }, "port 0 means the server is not listening yet");
        Expect(row!.DisabledReason?.Resolve() == QrHostOptions.ServerNotListeningReason, "which the blocker states");
    }

    private static void OfferNeedsAConfiguredOrigin()
    {
        // No origin means there is no domain to even name on a disabled row: the row is OMITTED, which
        // Build's list-shape tests pin too.
        var row = QrHostOptions.DescribeWebFor(Adapter("192.168.1.5"), 13337, "nonsense");
        Expect(row is null, "an unusable origin yields no web row at all");
    }

    private static void OfferEncodesThePublicOriginNotTheLan()
    {
        var row = QrHostOptions.DescribeWebFor(Adapter("192.168.1.5"), 13337, "https://sts2-couch.pages.dev");
        Expect(row is { Enabled: true }, "a routable address + origin + port is offerable");

        var uri = row!.ToUri();
        // THE contract: the scanned URL points at the PUBLIC origin over https, and the LAN address rides
        // in ?h= as data. Encoding the LAN address as the host would be the plain QR with extra steps.
        Expect(uri.Scheme == "https", $"the web link is https, got {uri.Scheme}");
        Expect(uri.Host == "sts2-couch.pages.dev", $"the host is the public origin, got {uri.Host}");
        Expect(uri.Query == "?h=192.168.1.5:13337", $"the LAN address rides in ?h=, got {uri.Query}");
        Expect(row.Kind == QrHostOptionKind.Web, "kind is Web");
        Expect(row.Adapter!.Address.ToString() == "192.168.1.5", "and the row remembers its adapter");
    }

    // The QR encoder strips query parameters by default (so a stray ?name= can never be broadcast to a
    // room). `h` is the documented exception, and this is the test that stops a future tightening of that
    // strip from producing a code that scans, opens the right site, and cannot find the game.
    private static void OfferSurvivesTheQrPayloadNormaliser()
    {
        var row = QrHostOptions.DescribeWebFor(Adapter("192.168.1.5"), 13337, "https://sts2-couch.pages.dev");
        var payload = OfflineQrCode.EncodeJoinUrl(row!.ToUri()).Payload;
        Expect(payload.Contains("h=192.168.1.5:13337", StringComparison.Ordinal),
            $"?h= survives QR payload normalisation, got {payload}");

        // …while everything else is still stripped.
        var withName = new Uri("https://sts2-couch.pages.dev/?h=192.168.1.5:13337&name=Ann");
        var stripped = OfflineQrCode.EncodeJoinUrl(withName).Payload;
        Expect(!stripped.Contains("name=", StringComparison.Ordinal),
            $"a seat name is still stripped from a scanned payload, got {stripped}");
        Expect(stripped.Contains("h=192.168.1.5:13337", StringComparison.Ordinal), "…without taking ?h= with it");
    }

    // ---- the WebSocket origin check --------------------------------------------------------------------

    private const string Web = "https://sts2-couch.pages.dev";

    private static void AbsentOriginIsAllowed()
    {
        // Browsers ALWAYS send Origin on a WS handshake; the native Godot client, the QA probe and curl do
        // not. Refusing them would break every non-browser consumer to defend against an attacker who can
        // simply omit the header — the check defends against other PAGES, and only a browser is bound by it.
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(null, "192.168.1.5:13337", Web), "null origin allowed");
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin("", "192.168.1.5:13337", Web), "empty origin allowed");
    }

    private static void SameOriginIsAllowed()
    {
        // Every pre-existing topology: the literal IP, the .local name, and the local-ip.co secure origin.
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://192.168.1.5:13337", "192.168.1.5:13337", Web), "IP literal same-origin");
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://worky.local:13337", "worky.local:13337", Web), ".local same-origin");
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "https://192-168-1-5.my.local-ip.co:8443", "192-168-1-5.my.local-ip.co:8443", Web),
            "local-ip.co same-origin");
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://WORKY.local:13337", "worky.local:13337", Web), "host comparison is case-insensitive");
    }

    private static void ConfiguredWebOriginIsAllowed()
    {
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(Web, "192.168.1.5:13337", Web),
            "the configured public origin is allowed cross-origin");
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "https://tunnel.example", "192.168.1.5:13337", "https://tunnel.example/"),
            "…including an overridden one, normalised");
    }

    private static void ForeignOriginIsRefused()
    {
        Expect(!CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "https://evil.example", "192.168.1.5:13337", Web), "an unrelated site cannot open the socket");
        Expect(!CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://192.168.1.6:13337", "192.168.1.5:13337", Web), "a different LAN host is not same-origin");
        Expect(!CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://evil.example:13337", "192.168.1.5:13337", Web),
            "…and matching only the PORT proves nothing");
    }

    // THE REGRESSION THIS FILE NOW EXISTS TO PREVENT.
    //
    // A joined seat is redirected to its own headless instance — a separate process on a different port
    // (base + 10×slot) — while the PAGE stays on the port it was loaded from. So the browser sends
    // `Origin: http://worky.local:13337` to an instance whose `Host` is `worky.local:13357`, and a
    // port-sensitive check refuses every headless seat on every topology, including the plain LAN one
    // that has always worked. The first version of this test asserted the port-sensitive behaviour and so
    // certified the bug; only a real join caught it.
    private static void PortHopToAHeadlessSeatIsAllowed()
    {
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://worky.local:13337", "worky.local:13357", Web),
            "the page's port may differ from the headless instance's — this IS the redirect");
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://192.168.1.5:13337", "192.168.1.5:13387", Web), "…for an IP literal too");
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "https://192-168-1-5.my.local-ip.co:8443", "192-168-1-5.my.local-ip.co:8453", Web),
            "…and over the secure origin, whose seats also port-walk");
        Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://192.168.1.5:13337", "192.168.1.5", Web), "a portless Host still matches the same machine");

        // What the check still refuses is a DIFFERENT machine, which is the threat it exists for.
        Expect(!CouchCoopWebOrigin.IsAllowedWebSocketOrigin(
            "http://192.168.1.6:13337", "192.168.1.5:13337", Web), "a different host is still refused");
    }

    private static void UnparseableOriginIsRefused()
    {
        // Present-but-broken is not the same as absent: something is claiming to be a browser and failing.
        Expect(!CouchCoopWebOrigin.IsAllowedWebSocketOrigin("null", "192.168.1.5:13337", Web),
            "the literal string \"null\" (a sandboxed iframe) is refused");
        Expect(!CouchCoopWebOrigin.IsAllowedWebSocketOrigin("http://", "192.168.1.5:13337", Web),
            "a malformed origin is refused");
    }

    private static void KillSwitchAllowsEverything()
    {
        var previous = Environment.GetEnvironmentVariable(CouchCoopWebOrigin.OriginCheckEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(CouchCoopWebOrigin.OriginCheckEnvironmentVariable, "0");
            Expect(CouchCoopWebOrigin.IsAllowedWebSocketOrigin("https://evil.example", "192.168.1.5:13337", Web),
                "the kill switch disables the check entirely");
        }
        finally
        {
            Environment.SetEnvironmentVariable(CouchCoopWebOrigin.OriginCheckEnvironmentVariable, previous);
        }
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"WebOriginTests: {because}");
        }
    }
}
