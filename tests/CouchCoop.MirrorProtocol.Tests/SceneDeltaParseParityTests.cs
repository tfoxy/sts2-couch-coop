using System.Text;
using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-B (parse-path copy elimination): the zero-copy Parse(byte[]) overload must produce EXACTLY the same parsed
// MirrorDelta as the pre-existing Parse(string) and Parse(ReadOnlySpan<byte>) paths, on every checked-in wire
// fixture plus the null-returning shapes (non-scene-delta / non-object / malformed). Deep equality is asserted by
// re-serializing the parsed object graph through System.Text.Json (member order is deterministic per type), so any
// field-level divergence surfaces as a string diff.
internal static class SceneDeltaParseParityTests
{
    private static readonly string[] WireFixtures =
    [
        "roundtrip-delta.json",
        "order-patch-full.json",
        "order-patch-delta.json",
        "tween-hints-delta.json",
        "card-flight-delta.json",
        "card-flight-discard-delta.json",
        "particle-node.json",
        "spine-node.json",
        "spine-vfx-bite-node.json",
        "shader-params-node.json",
        "intent-frames-node.json",
        "line2d-node.json",
        "static-fields.json",
    ];

    public static void Run()
    {
        foreach (var file in WireFixtures)
        {
            AssertParity(TestFixtures.ReadWire(file), $"fixture:{file}");
        }

        // The null-returning shapes: all three overloads must agree on null too.
        AssertParity("""{"type":"pong","t0":1}""", "non-scene-delta");
        AssertParity("[1,2,3]", "non-object");
        AssertParity("""{"type":"scene-delta",""", "malformed");
    }

    private static void AssertParity(string json, string label)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        MirrorDelta? fromBytes = SceneDeltaReader.Parse(bytes);                    // the zero-copy byte[] overload
        MirrorDelta? fromSpan = SceneDeltaReader.Parse((ReadOnlySpan<byte>)bytes); // the copying span overload
        MirrorDelta? fromString = SceneDeltaReader.Parse(json);

        Check.Equal(fromBytes is null, fromString is null, $"{label}: byte[] vs string nullness");
        Check.Equal(fromSpan is null, fromString is null, $"{label}: span vs string nullness");
        if (fromString is null)
        {
            return;
        }

        string viaBytes = JsonSerializer.Serialize(fromBytes);
        string viaSpan = JsonSerializer.Serialize(fromSpan);
        string viaString = JsonSerializer.Serialize(fromString);
        Check.Equal(viaBytes, viaString, $"{label}: byte[] parse == string parse");
        Check.Equal(viaSpan, viaString, $"{label}: span parse == string parse");
    }
}
