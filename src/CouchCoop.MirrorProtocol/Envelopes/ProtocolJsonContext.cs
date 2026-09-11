using System.Text.Json;
using System.Text.Json.Serialization;

namespace CouchCoop.MirrorProtocol.Envelopes;

// STJ source-generated metadata for the client → host control messages (Web camelCase naming + omit nulls),
// matching the wire the TS client sends. Serialize-only in practice: session messages use their handwritten,
// defensive parse path rather than generated metadata.
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(JoinMessage))]
[JsonSerializable(typeof(InputMessage))]
[JsonSerializable(typeof(SceneAckMessage))]
[JsonSerializable(typeof(WatchMessage))]
[JsonSerializable(typeof(PingMessage))]
[JsonSerializable(typeof(SettingsMessage))]
public sealed partial class ProtocolJsonContext : JsonSerializerContext;

// Convenience serialization for the client control messages: produces exactly the bytes the TS mirror client
// sends. All use the source-generated, camelCase, omit-null metadata.
public static class ProtocolJson
{
    public static byte[] SerializeToUtf8Bytes(JoinMessage message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, ProtocolJsonContext.Default.JoinMessage);

    public static byte[] SerializeToUtf8Bytes(InputMessage message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, ProtocolJsonContext.Default.InputMessage);

    public static byte[] SerializeToUtf8Bytes(SceneAckMessage message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, ProtocolJsonContext.Default.SceneAckMessage);

    public static byte[] SerializeToUtf8Bytes(WatchMessage message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, ProtocolJsonContext.Default.WatchMessage);

    public static byte[] SerializeToUtf8Bytes(PingMessage message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, ProtocolJsonContext.Default.PingMessage);

    public static byte[] SerializeToUtf8Bytes(SettingsMessage message) =>
        JsonSerializer.SerializeToUtf8Bytes(message, ProtocolJsonContext.Default.SettingsMessage);

    public static string Serialize(JoinMessage message) =>
        JsonSerializer.Serialize(message, ProtocolJsonContext.Default.JoinMessage);

    public static string Serialize(InputMessage message) =>
        JsonSerializer.Serialize(message, ProtocolJsonContext.Default.InputMessage);

    public static string Serialize(SceneAckMessage message) =>
        JsonSerializer.Serialize(message, ProtocolJsonContext.Default.SceneAckMessage);

    public static string Serialize(WatchMessage message) =>
        JsonSerializer.Serialize(message, ProtocolJsonContext.Default.WatchMessage);

    public static string Serialize(PingMessage message) =>
        JsonSerializer.Serialize(message, ProtocolJsonContext.Default.PingMessage);

    public static string Serialize(SettingsMessage message) =>
        JsonSerializer.Serialize(message, ProtocolJsonContext.Default.SettingsMessage);
}
