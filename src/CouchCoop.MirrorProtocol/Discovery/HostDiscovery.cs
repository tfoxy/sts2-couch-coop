using System.Text;
using System.Text.Json;

namespace CouchCoop.MirrorProtocol.Discovery;

// M3 WS-T host-discovery wire codec — shared by the mod's responder (System.Net UdpClient) and the native
// Godot client's PacketPeerUdp prober. The client BROADCASTS a tiny probe and the host answers with a UNICAST
// reply that carries the CONNECT-READY host:port (the "bare-IP" fix: the reply never assumes 13337, it states
// the real port the TCP listener chose, so a second host that port-walked to 13338 is still connectable).
//
// Hand-rolled JsonDocument codec, matching the style the client already uses for `session`/`pong`
// (SessionEnvelope.Parse) and the reflection-serialized mod side — no AOT/source-gen constraint on either end.
// Payloads are kept tiny (< 512 bytes) so a datagram never fragments.

// A discovered host. Host:Port is connect-ready; Url/Name are advisory (Name is the host machine name).
public sealed record HostDiscoveryReply(string Host, int Port, string? Url, string? Name, int Version);

public static class HostDiscovery
{
    public const string ProbeMagic = "couchcoop-discover";
    public const string ReplyMagic = "couchcoop-host";
    public const int ProtocolVersion = 1;

    // {"t":"couchcoop-discover","v":1}
    public static byte[] EncodeProbe()
        => Encoding.UTF8.GetBytes($"{{\"t\":\"{ProbeMagic}\",\"v\":{ProtocolVersion}}}");

    // True iff the datagram is the current, exact probe. Discovery is a bootstrap boundary: accepting a
    // missing or foreign contract here only delays a deterministic incompatibility until socket setup.
    public static bool TryDecodeProbe(ReadOnlySpan<byte> utf8)
    {
        try
        {
            using var doc = JsonDocument.Parse(utf8.ToArray());
            var root = doc.RootElement;
            return root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("t", out var t)
                && t.ValueKind == JsonValueKind.String
                && t.GetString() == ProbeMagic
                && root.TryGetProperty("v", out var v)
                && v.ValueKind == JsonValueKind.Number
                && v.TryGetInt32(out var version)
                && version == ProtocolVersion;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    // {"t":"couchcoop-host","v":1,"host":..,"port":..,"url":..,"name":..}
    public static byte[] EncodeReply(HostDiscoveryReply r)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("t", ReplyMagic);
            writer.WriteNumber("v", r.Version);
            writer.WriteString("host", r.Host);
            writer.WriteNumber("port", r.Port);
            if (r.Url is null)
            {
                writer.WriteNull("url");
            }
            else
            {
                writer.WriteString("url", r.Url);
            }

            if (r.Name is null)
            {
                writer.WriteNull("name");
            }
            else
            {
                writer.WriteString("name", r.Name);
            }

            writer.WriteEndObject();
        }

        return stream.ToArray();
    }

    // Decode a reply, or null if it is not a well-formed `couchcoop-host` reply. Rejects a missing/blank host or a
    // missing/out-of-range port (the connect-ready address is mandatory), or a missing/foreign protocol version.
    public static HostDiscoveryReply? TryDecodeReply(ReadOnlySpan<byte> utf8)
    {
        try
        {
            using var doc = JsonDocument.Parse(utf8.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (!root.TryGetProperty("t", out var t) || t.ValueKind != JsonValueKind.String || t.GetString() != ReplyMagic)
            {
                return null;
            }

            if (!root.TryGetProperty("host", out var hostEl) || hostEl.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var host = hostEl.GetString();
            if (string.IsNullOrWhiteSpace(host))
            {
                return null;
            }

            if (!root.TryGetProperty("port", out var portEl)
                || portEl.ValueKind != JsonValueKind.Number
                || !portEl.TryGetInt32(out var port)
                || port <= 0
                || port > 65535)
            {
                return null;
            }

            var url = AsStringOrNull(root, "url");
            var name = AsStringOrNull(root, "name");
            if (!root.TryGetProperty("v", out var vEl)
                || vEl.ValueKind != JsonValueKind.Number
                || !vEl.TryGetInt32(out var version)
                || version != ProtocolVersion)
            {
                return null;
            }

            return new HostDiscoveryReply(host!, port, url, name, version);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? AsStringOrNull(JsonElement root, string name)
        => root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;
}
