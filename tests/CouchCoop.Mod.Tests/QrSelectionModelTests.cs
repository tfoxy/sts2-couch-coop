using System.Net;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Localization;

internal static class QrSelectionModelTests
{
    public static void Run()
    {
        CouchCoopLocalization.SetLanguageForTests("eng");
        var adapter = new QrAdapterInfo("Ethernet", QrAdapterKind.Ethernet, IPAddress.Parse("192.168.1.5"));
        var direct = new QrHostOption("192.168.1.5", 13337, QrHostOptionKind.Interface, adapter);
        var web = QrHostOptions.DescribeWebFor(adapter, 13337, "https://example.org")!;
        var secure = QrHostOptions.DescribeSecureFor(adapter, "local-ip.co", 0, null);
        var mdns = new QrHostOption("host.local", 13337, QrHostOptionKind.Mdns, null);
        QrHostOption[] options = [direct, web, secure, mdns];
        var model = new QrSelectionModel();
        model.Refresh(options, null);
        Expect(model.Network == direct && model.Method == "ipv4", "default remains the direct interface address");
        Expect(model.PreviewUrlFor("ipv4") == direct.ToUri() && model.PreviewUrlFor("web") == web.ToUri(),
            "method subtitles use the exact direct and Website destinations, including the Website host query");
        Expect(model.PreviewUrlFor("secure")?.ToString() == "https://192-168-1-5.local-ip.co:13337/",
            "pending HTTPS preview uses the selected interface and actual shared listener port");
        Expect(model.ChooseMethod("web") && model.Url == web.ToUri(), "Website uses the selected adapter URL");
        model.ChooseNetwork("mdns");
        Expect(model.PreviewUrlFor("ipv4") == mdns.ToUri()
            && model.PreviewUrlFor("web") is null && model.PreviewUrlFor("secure") is null,
            "changing networks refreshes previews and never displays a stale or invented unsupported URL");
        Expect(model.Method == "web" && model.Url is null, "switching to PC name retains Website without a QR");
        Expect(!model.ChooseMethod("web") && !model.ChooseMethod("secure"), "unsupported methods reject activation");
        Expect(model.UnavailableMessage.Resolve().Contains("Website") && model.UnavailableMessage.Resolve().Contains("PC name"),
            "the QR explanation names both selections");
        var retained = model.Memory;
        model.Refresh(options, retained);
        Expect(model.Network == mdns && model.Method == "web" && model.Url is null, "refresh preserves an unsupported pair");
        model.ChooseNetwork(direct.SelectionKey);
        Expect(model.Url == web.ToUri(), "returning to a supported interface restores the Website QR");
        Expect(model.ChooseMethod("secure") && model.Selected is { CanSelectWhenUnavailable: true } && model.Url is null,
            "an eligible pending domain is selectable to request setup");
        Expect(model.ChooseMethod("secure"), "the selected pending domain can be reselected for retry");
        var ready = secure with { Enabled = true, Port = 13337, CanSelectWhenUnavailable = false, DisabledReason = null };
        model.Refresh([direct, web, ready, mdns], model.Memory);
        Expect(model.Url?.Scheme == "https", "a readiness event restores the selected domain without another pick");
        Expect(model.PreviewUrlFor("secure") == model.Url, "ready HTTPS preview and QR payload agree");
        model.Refresh(options, new QrSelectionMemory("web", "10.1.2.3"));
        Expect(model.Network == direct && model.Method == "web", "missing adapter falls back while retaining method");
        model.Refresh(options, new QrSelectionMemory("mdns", null));
        Expect(model.Network == mdns && model.Method == "ipv4" && model.Url == mdns.ToUri(), "legacy PC-name choice migrates");
        model.Refresh(options, new QrSelectionMemory("secure", "192.168.1.5"));
        Expect(model.Network == direct && model.Method == "secure", "legacy per-interface method migrates");
        model.Refresh([direct, mdns], new QrSelectionMemory("web", "192.168.1.5"));
        Expect(model.Selected is { Selectable: false } && model.Url is null, "unconfigured Website remains disabled and explained");
        var pin = new QrHostOption("custom.example", 13337, QrHostOptionKind.Override, null);
        model.Refresh([pin, direct, web, secure, mdns], new QrSelectionMemory("override", null));
        Expect(model.Network == pin && model.Url == pin.ToUri(), "legacy override migrates to Direct on Fixed address");
        Expect(!model.ChooseMethod("secure") && !model.ChooseMethod("web"), "fixed address supports Direct only");
        model.Refresh([direct, web, secure with { CanSelectWhenUnavailable = false }, mdns], new QrSelectionMemory("secure", "192.168.1.5"));
        Expect(!model.ChooseMethod("secure") && model.Method == "secure", "disabled setup cannot activate but retains selection");
        model.Refresh([mdns with { Port = 0 }], new QrSelectionMemory("mdns", null));
        Expect(model.Url is null && !model.ChooseMethod("ipv4"), "no listener means no copyable or selectable Direct URL");
        model.Refresh([direct with { Enabled = false }, web, ready, mdns], null);
        Expect(model.Method == "web" && model.Url == web.ToUri(), "initial default still uses the first available option");
        Expect(!model.ChooseMethod("unknown") && model.Resolve("unknown") is null, "unknown methods cannot resolve or activate");
        model.Refresh([], retained);
        Expect(model.Network is null && model.Url is null && !model.ChooseMethod("web"), "empty interfaces are safe");

        var path = Path.Combine(Path.GetTempPath(), "cc-qr-selection-" + Guid.NewGuid() + ".json");
        try
        {
            CouchCoopQrSelectionPreference.TryWrite(path, retained);
            var read = CouchCoopQrSelectionPreference.TryRead(path);
            Expect(read == retained, "unsupported pair round trips through preferences");
            model.Refresh(options, read);
            Expect(model.Network == mdns && model.Method == "web" && model.Url is null, "reopening restores the unsupported pair");
        }
        finally { File.Delete(path); }
        DirectIpSelectionAndCopy();
        Console.WriteLine("QrSelectionModelTests: ok");
    }

    private static void DirectIpSelectionAndCopy()
    {
        Expect(QrSelectionModel.Methods.SequenceEqual(["ipv4", "direct-https", "web", "secure"]), "direct HTTPS immediately follows plain direct");
        var adapter = new QrAdapterInfo("Wi-Fi", QrAdapterKind.Wifi, IPAddress.Parse("192.168.1.7"));
        var direct = new QrHostOption("192.168.1.7", 13337, QrHostOptionKind.Interface, adapter);
        var pending = QrHostOptions.DescribeDirectIpSecureFor(adapter, 13337, null);
        var model = new QrSelectionModel();
        model.Refresh([direct, pending], new QrSelectionMemory("direct-https", "192.168.1.7"));
        Expect(model.Method == "direct-https" && model.Url is null && model.PreviewUrlFor("direct-https") is null,
            "restoring pending preference retains method without a usable or preview URL");
        Expect(model.ChooseMethod("direct-https"), "explicit re-selection can open setup");
        var ready = QrHostOptions.DescribeDirectIpSecureFor(adapter, 13337,
            new CouchCoop.Mod.Server.DirectIpHttpsState(13337, ["192.168.1.7"]));
        model.Refresh([direct, ready], model.Memory);
        Expect(model.Url?.ToString() == "https://192.168.1.7:13337/" && model.PreviewUrlFor("direct-https") == model.Url,
            "ready preference uses identical HTTPS IP URL for preview, QR and copy");
        var pinned = new QrHostOption("192.168.1.7", 13337, QrHostOptionKind.Override, null);
        model.Refresh([pinned, ready], new QrSelectionMemory("direct-https", null, "override"));
        Expect(model.Network == pinned && model.Url == ready.ToUri(), "pinned local IP resolves its retained certificate-backed row");
        model.Refresh([pinned with { Host = "other.example" }, ready], new QrSelectionMemory("direct-https", null, "override"));
        Expect(model.Url is null && !model.ChooseMethod("direct-https"), "hostname overrides cannot borrow IP certificate identity");
        model.Refresh([pinned with { Host = "192.168.1.99" }, ready], new QrSelectionMemory("direct-https", null, "override"));
        Expect(model.Url is null && !model.ChooseMethod("direct-https"), "nonlocal IP overrides cannot borrow another interface certificate");
        model.Refresh([pinned, ready], new QrSelectionMemory("direct-https", null, "override"));
        var path = Path.Combine(Path.GetTempPath(), "cc-direct-https-pref-" + Guid.NewGuid() + ".json");
        try
        {
            CouchCoopQrSelectionPreference.TryWrite(path, model.Memory);
            Expect(CouchCoopQrSelectionPreference.TryRead(path) == model.Memory, "direct-https preference round trips");
        }
        finally { File.Delete(path); }
        var state = new CouchCoop.Mod.Server.DirectIpHttpsState(CaFingerprint: new string('A', 64),
            CaExpiresAt: DateTimeOffset.Parse("2031-01-02T00:00:00Z"));
        var body = DirectIpSetupCopy.Body(state);
        Expect(body.Contains(new string('A', 64)) && body.Contains("2031-01-02"), "full fingerprint and expiry are visible");
        Expect(body.Contains("other websites") && body.Contains("authenticated") && body.Contains("Certificate Trust Settings"),
            "native setup includes trust scope, authenticated transfer and explicit iOS trust");
        Expect(DirectIpSetupCopy.Status(state with { ErrorCode = "authority-expired" }).Key == "couchcoop_direct_https_authority_expired",
            "expiry requires explicit authority replacement");
        Expect(DirectIpSetupCopy.Status(state with { ErrorCode = "unknown" }).Key == "couchcoop_direct_https_failed",
            "unrecognized errors map to safe localized copy");
    }

    private static void Expect(bool value, string reason)
    {
        if (!value) throw new InvalidOperationException("QrSelectionModelTests: " + reason);
    }
}
