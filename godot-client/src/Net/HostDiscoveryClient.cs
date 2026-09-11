// OWNER: WS-T (M3 host discovery). The client half of LAN host discovery.
//
// A PacketPeerUdp bound to an ephemeral port with broadcast enabled. Every ~2s it fires tiny discovery probes at
// a spread of destinations (limited broadcast, /24 subnet-directed broadcast, and unicast fallbacks to loopback +
// the persisted lastHost) across the TCP port-walk range, then drains any UNICAST replies the host sent back.
//
// Design note: wifi-only phones SEND broadcasts fine; the flaky direction is RECEIVING broadcasts on phones. This
// client only ever receives UNICAST replies (the host answers the prober's source address directly), sidestepping
// the phone broadcast-receive problem entirely. No multicast group is ever joined, so no CHANGE_WIFI_MULTICAST_STATE
// permission is required.
//
// Owned by ConnectScreen: it lives exactly as long as the Connect screen and is torn down with it.

using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.Discovery;
using Godot;

namespace CouchCoop.GodotClient.Net;

public sealed partial class HostDiscoveryClient : Node
{
    private const double ReprobeSec = 2.0;

    // Cover the TCP listener's port-walk range (CouchCoopBrowserServer walks up from 13337 when a port is taken).
    private const int PortLow = 13337;
    private const int PortHigh = 13341;

    // Same file + section ConnectScreen / the coordinator use; lastHost is stored as "address[:port]".
    private const string SettingsPath = "user://settings.cfg";
    private const string CfgSection = "mirror";
    private const string LastHostKey = "lastHost";

    // Raised once per newly-seen host (deduped by host:port). What the UI does with it is ConnectScreen's call: it
    // lists every host, connects on tap, and (WS-C) auto-connects the FIRST one while its host field is untouched.
    public event Action<HostDiscoveryReply>? Found;

    private readonly PacketPeerUdp _udp = new();
    private readonly HashSet<string> _seen = new();
    private double _since = ReprobeSec; // probe on the very first frame
    private bool _bound;

    public override void _Ready()
    {
        Error err = _udp.Bind(0, "0.0.0.0");
        if (err != Error.Ok)
        {
            GD.PrintErr($"HostDiscoveryClient: UDP bind failed ({err}); LAN discovery disabled (manual/QR entry still works).");
            return;
        }

        _udp.SetBroadcastEnabled(true);
        _bound = true;
    }

    public override void _Process(double delta)
    {
        if (!_bound)
        {
            return;
        }

        _since += delta;
        if (_since >= ReprobeSec)
        {
            _since = 0;
            SendProbes();
        }

        DrainReplies();
    }

    public override void _ExitTree()
    {
        if (_bound)
        {
            _udp.Close();
            _bound = false;
        }
    }

    private void SendProbes()
    {
        byte[] probe = HostDiscovery.EncodeProbe();
        foreach (var destination in ProbeDestinations())
        {
            for (int port = PortLow; port <= PortHigh; port++)
            {
                if (_udp.SetDestAddress(destination, port) == Error.Ok)
                {
                    _udp.PutPacket(probe);
                }
            }
        }
    }

    // Broadcast-hostile networks + desktop loopback are all covered:
    //   1. limited broadcast 255.255.255.255
    //   2. /24 subnet-directed broadcast for each local IPv4 (Godot doesn't expose the netmask — /24 heuristic)
    //   3. unicast fallbacks: 127.0.0.1 (desktop loopback) and the persisted lastHost address
    private IEnumerable<string> ProbeDestinations()
    {
        yield return "255.255.255.255";
        yield return "127.0.0.1";

        foreach (var local in IP.GetLocalAddresses())
        {
            if (ToSubnetBroadcast(local) is { } subnet)
            {
                yield return subnet;
            }
        }

        if (StripPort(ReadLastHost()) is { Length: > 0 } lastHost)
        {
            yield return lastHost;
        }
    }

    private void DrainReplies()
    {
        while (_udp.GetAvailablePacketCount() > 0)
        {
            byte[] packet = _udp.GetPacket();
            HostDiscoveryReply? reply = HostDiscovery.TryDecodeReply(packet);
            if (reply is null)
            {
                continue;
            }

            string key = $"{reply.Host}:{reply.Port}";
            if (!_seen.Add(key))
            {
                continue;
            }

            GD.Print($"M3_DISCOVER: found host={reply.Host}:{reply.Port} name={reply.Name} (n={_seen.Count})");
            Found?.Invoke(reply);
        }
    }

    // "a.b.c.d" -> "a.b.c.255"; null for IPv6 / malformed / anything not four numeric octets.
    private static string? ToSubnetBroadcast(string address)
    {
        if (string.IsNullOrEmpty(address) || address.Contains(':'))
        {
            return null; // IPv6
        }

        string[] octets = address.Split('.');
        if (octets.Length != 4)
        {
            return null;
        }

        foreach (var octet in octets)
        {
            if (octet.Length == 0 || !byte.TryParse(octet, out _))
            {
                return null;
            }
        }

        return $"{octets[0]}.{octets[1]}.{octets[2]}.255";
    }

    // lastHost is stored "address[:port]"; probing needs the bare address (the port comes from the walk range).
    private static string? StripPort(string? hostSpec)
    {
        if (string.IsNullOrEmpty(hostSpec))
        {
            return null;
        }

        int colon = hostSpec.LastIndexOf(':');
        if (colon > 0 && colon < hostSpec.Length - 1 && IsAllDigits(hostSpec.AsSpan(colon + 1)))
        {
            return hostSpec[..colon];
        }

        return hostSpec;
    }

    private static bool IsAllDigits(ReadOnlySpan<char> value)
    {
        foreach (char c in value)
        {
            if (c is < '0' or > '9')
            {
                return false;
            }
        }

        return true;
    }

    private static string ReadLastHost()
    {
        var cfg = new ConfigFile();
        return cfg.Load(SettingsPath) == Error.Ok
            ? cfg.GetValue(CfgSection, LastHostKey, "").AsString()
            : "";
    }
}
