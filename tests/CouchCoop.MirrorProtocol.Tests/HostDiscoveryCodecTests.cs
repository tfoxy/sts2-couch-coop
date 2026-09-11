using System.Text;
using CouchCoop.MirrorProtocol.Discovery;

namespace CouchCoop.MirrorProtocol.Tests;

// M3 WS-T host-discovery wire codec (HostDiscovery). Assert-or-throw Exe suite (see TestSupport.Check).
internal static class HostDiscoveryCodecTests
{
    public static void Run()
    {
        ProbeEncodeDecode();
        ReplyRoundTrip();
        ReplyRoundTripNullOptionals();
        BadMagicRejected();
        VersionExact();
        BlankHostRejected();
        BadPortRejected();
        GarbageRejected();
    }

    private static void ProbeEncodeDecode()
    {
        var probe = HostDiscovery.EncodeProbe();
        Check.That(probe.Length < 512, "probe stays under 512 bytes (no fragmentation)");
        Check.That(HostDiscovery.TryDecodeProbe(probe), "encoded probe decodes as a probe");

        // The exact wire shape the design pins.
        Check.Equal(Encoding.UTF8.GetString(probe), "{\"t\":\"couchcoop-discover\",\"v\":1}", "probe wire shape");
    }

    private static void ReplyRoundTrip()
    {
        var reply = new HostDiscoveryReply("192.168.1.20", 13338, "http://192.168.1.20:13338/", "living-room-pc", 1);
        var encoded = HostDiscovery.EncodeReply(reply);
        Check.That(encoded.Length < 512, "reply stays under 512 bytes");

        var decoded = HostDiscovery.TryDecodeReply(encoded);
        Check.That(decoded is not null, "reply decodes");
        Check.Equal(decoded!.Host, "192.168.1.20", "reply host round-trips");
        Check.Equal(decoded.Port, 13338, "reply port round-trips (the connect-ready port, not 13337)");
        Check.Equal(decoded.Url, "http://192.168.1.20:13338/", "reply url round-trips");
        Check.Equal(decoded.Name, "living-room-pc", "reply name round-trips");
        Check.Equal(decoded.Version, 1, "reply version round-trips");
    }

    private static void ReplyRoundTripNullOptionals()
    {
        var reply = new HostDiscoveryReply("10.0.0.5", 13337, null, null, 1);
        var decoded = HostDiscovery.TryDecodeReply(HostDiscovery.EncodeReply(reply));
        Check.That(decoded is not null, "reply with null url/name decodes");
        Check.Equal(decoded!.Host, "10.0.0.5", "host round-trips with null optionals");
        Check.Equal(decoded.Port, 13337, "port round-trips with null optionals");
        Check.That(decoded.Url is null, "null url stays null");
        Check.That(decoded.Name is null, "null name stays null");
    }

    private static void BadMagicRejected()
    {
        // A probe is not a reply and a reply is not a probe (the `t` magics are distinct).
        Check.That(!HostDiscovery.TryDecodeProbe(HostDiscovery.EncodeReply(
            new HostDiscoveryReply("127.0.0.1", 13337, null, null, 1))), "a reply is not decoded as a probe");
        Check.That(HostDiscovery.TryDecodeReply(HostDiscovery.EncodeProbe()) is null, "a probe is not decoded as a reply");

        Check.That(!HostDiscovery.TryDecodeProbe(Utf8("{\"t\":\"something-else\",\"v\":1}")), "wrong probe magic rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"nope\",\"host\":\"127.0.0.1\",\"port\":13337}")) is null,
            "wrong reply magic rejected");
    }

    private static void VersionExact()
    {
        Check.That(!HostDiscovery.TryDecodeProbe(Utf8("{\"t\":\"couchcoop-discover\"}")), "probe without v rejected");
        Check.That(!HostDiscovery.TryDecodeProbe(Utf8("{\"t\":\"couchcoop-discover\",\"v\":99}")), "foreign probe version rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"host\":\"127.0.0.1\",\"port\":13337}")) is null,
            "reply without v rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"v\":99,\"host\":\"127.0.0.1\",\"port\":13337}")) is null,
            "foreign reply version rejected");
    }

    private static void BlankHostRejected()
    {
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"host\":\"\",\"port\":13337}")) is null,
            "blank host rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"host\":\"   \",\"port\":13337}")) is null,
            "whitespace host rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"port\":13337}")) is null,
            "missing host rejected");
    }

    private static void BadPortRejected()
    {
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"host\":\"127.0.0.1\"}")) is null,
            "missing port rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"host\":\"127.0.0.1\",\"port\":\"13337\"}")) is null,
            "string port rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"host\":\"127.0.0.1\",\"port\":0}")) is null,
            "zero port rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("{\"t\":\"couchcoop-host\",\"host\":\"127.0.0.1\",\"port\":70000}")) is null,
            "out-of-range port rejected");
    }

    private static void GarbageRejected()
    {
        Check.That(!HostDiscovery.TryDecodeProbe(Utf8("not json at all")), "garbage probe rejected");
        Check.That(HostDiscovery.TryDecodeReply(Utf8("not json at all")) is null, "garbage reply rejected");
        Check.That(!HostDiscovery.TryDecodeProbe([]), "empty probe rejected");
        Check.That(HostDiscovery.TryDecodeReply([]) is null, "empty reply rejected");
        Check.That(!HostDiscovery.TryDecodeProbe(Utf8("[1,2,3]")), "non-object probe rejected");
    }

    private static byte[] Utf8(string s) => Encoding.UTF8.GetBytes(s);
}
