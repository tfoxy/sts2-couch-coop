using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Server;

namespace CouchCoop.Mod.HostUi;

/// <summary>Independent network and method choices, including a retained unsupported pair.</summary>
public sealed class QrSelectionModel
{
    public static IReadOnlyList<string> Methods { get; } = ["ipv4", "web", "secure", "direct-https"];
    private IReadOnlyList<QrHostOption> _options = [];
    public IReadOnlyList<QrHostOption> Networks { get; private set; } = [];
    public QrHostOption? Network { get; private set; }
    public string Method { get; private set; } = "ipv4";
    public QrHostOption? Selected => Resolve(Method);
    public Uri? Url => Selected is { Enabled: true, Port: > 0 } option ? option.ToUri() : null;
    public QrSelectionMemory Memory => new(Method, Network?.Adapter?.Address.ToString(), Network?.SelectionKey);

    /// <summary>The method row's destination; a pending HTTPS preview is not yet a usable QR URL.</summary>
    public Uri? PreviewUrlFor(string method)
    {
        var option = Resolve(method);
        if (option is { Enabled: true, Port: > 0 }) return option.ToUri();

        // HTTPS shares the browser listener's actual port, even before certificate setup completes.
        // Only preview a real per-interface option, never the synthetic unsupported pair.
        if (option is { Kind: QrHostOptionKind.Secure, Adapter: { } adapter }
            && Network is { Port: > 0 } && _options.Contains(option)
            && SecureOriginHost.IsSecureOriginEligible(adapter.Address))
            return (option with { Port = Network.Port }).ToUri();

        return null;
    }

    public void Refresh(IReadOnlyList<QrHostOption> options, QrSelectionMemory? preference)
    {
        _options = options;
        Networks = options.Where(o => o.Kind is QrHostOptionKind.Interface or QrHostOptionKind.Mdns or QrHostOptionKind.Override).ToArray();
        var initial = QrHostOptions.RestoreSelection(options, null);
        var preferredMethod = preference?.Method ?? initial?.MethodToken;
        Method = preferredMethod is "direct-https" or "web" or "secure" ? preferredMethod : "ipv4";
        var networkKey = preference?.NetworkKey;
        Network = Networks.FirstOrDefault(o => string.Equals(o.SelectionKey, networkKey, StringComparison.OrdinalIgnoreCase));
        if (Network is null)
        {
            Network = Networks.FirstOrDefault(o => o.SelectionKey == NetworkKeyFor(initial)) ?? Networks.FirstOrDefault();
        }
    }

    public bool ChooseNetwork(string key)
    {
        var network = Networks.FirstOrDefault(o => o.SelectionKey == key);
        if (network is null) return false;
        Network = network;
        return true;
    }

    public bool ChooseMethod(string method)
    {
        if (!Methods.Contains(method) || Resolve(method) is not { Selectable: true }) return false;
        Method = method;
        return true;
    }

    public QrHostOption? Resolve(string method)
    {
        if (Network is null || !Methods.Contains(method)) return null;
        if (method == "ipv4")
            return Network.Port > 0 ? Network : Network with { Enabled = false, DisabledReason = QrHostOptions.ServerNotListeningText };
        var kind = method switch { "web" => QrHostOptionKind.Web, "direct-https" => QrHostOptionKind.DirectIpSecure, _ => QrHostOptionKind.Secure };
        if (Network.Adapter is { } adapter)
        {
            var option = _options.FirstOrDefault(o => o.Kind == kind && o.Adapter == adapter);
            if (option is not null) return option;
        }
        // A pinned local IP replaces its plain interface row, but still has a certificate-backed
        // direct-HTTPS row. Do not turn arbitrary overrides or names into certificate identities.
        if (method == "direct-https" && Network.Kind == QrHostOptionKind.Override
            && System.Net.IPAddress.TryParse(Network.Host, out var pinnedAddress))
        {
            var coveredInterface = _options.FirstOrDefault(o => o.Kind == QrHostOptionKind.DirectIpSecure
                && o.Adapter?.Address.Equals(pinnedAddress) == true);
            if (coveredInterface is not null) return coveredInterface;
        }
        return new QrHostOption(Network.Host, 0, kind, Network.Adapter, Enabled: false,
            DisabledReason: new CouchCoopText(Network.Adapter is null
                ? "couchcoop_qr_method_requires_interface" : "couchcoop_qr_website_unconfigured"));
    }

    public static string? NetworkKeyFor(QrHostOption? option) => option?.Adapter is { } adapter
        ? $"ipv4|{adapter.Address}" : option?.SelectionKey;

    public static CouchCoopText MethodLabel(string method) => new(method switch
    {
        "direct-https" => "couchcoop_qr_method_direct_https_title",
        "web" => "couchcoop_qr_method_web_title",
        "secure" => "couchcoop_qr_method_secure_title",
        _ => "couchcoop_qr_method_ipv4_title",
    });

    public static CouchCoopText NetworkLabel(QrHostOption network) => network.Adapter is { } adapter
        ? CouchCoopText.FromLiteral(adapter.InterfaceName)
        : new(network.Kind == QrHostOptionKind.Mdns ? "couchcoop_qr_method_mdns_title" : "couchcoop_qr_method_override_title");

    public CouchCoopText UnavailableMessage => Network is null
        ? new("couchcoop_qr_no_address")
        : new("couchcoop_qr_pair_unavailable", new Dictionary<string, CouchCoopTextArgument>
        {
            ["method"] = CouchCoopTextArgument.LocalizedValue(MethodLabel(Method)),
            ["network"] = CouchCoopTextArgument.LocalizedValue(NetworkLabel(Network)),
            ["reason"] = CouchCoopTextArgument.LocalizedValue(Selected?.DisabledReason ?? QrHostOptions.ServerNotListeningText),
        });
}

/// <summary>Display data for either half of the picker; activation is independent of focusability.</summary>
internal sealed record QrSelectEntry(string Key, CouchCoopText Label, CouchCoopText Detail, QrHostOption? Option, bool Selectable = true);
