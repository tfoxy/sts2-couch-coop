using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Protocol;

// Builds the broadcast `scene-delta` message for the live-tree mirror: the raw RuntimeSceneDelta mapped to the
// slimmed couch-coop WIRE DTO (WireSceneDelta — default omission + float/color/resource-ref leaf slimming) plus a
// `type:"scene-delta"` discriminator. One message type carries both keyframe (`full:true`) and incremental deltas.
// This sits on the per-emit critical send path (once per connection per delta); it serializes in a single pass via
// the source-generated metadata below straight to UTF-8 bytes (no DOM round-trip, no intermediate string), then
// splices the discriminator. Independent of the semantic `state` message.
public static class BrowserSceneDeltaMessage
{
    // Spliced onto the END of the serialized delta (replacing its closing `}`) so the discriminator rides last,
    // keeping the flat wire shape (type + delta fields at the top level) that `frontend/src/mirror/mirrorClient.ts`
    // reads by key.
    private static readonly byte[] TypeSuffix = Encoding.UTF8.GetBytes(",\"type\":\"scene-delta\"}");

    // `orderPatch` (Stage 4), when non-null, replaces the full `orderedIds` array on the wire with the compact
    // dirty-parents/roots patch. Null → the delta's own OrderedIds (full array) is emitted, or none when unchanged.
    public static byte[] Serialize(RuntimeSceneDelta delta, SceneOrderPatch? orderPatch = null)
    {
        var wire = WireSceneDelta.FromDelta(delta, orderPatch);
        var deltaBytes = JsonSerializer.SerializeToUtf8Bytes(wire, SceneDeltaJsonContext.Default.WireSceneDelta);
        // `deltaBytes` is compact (no whitespace) and always has ≥1 member (Full is a non-nullable bool), so it
        // ends in `}` with real content before it. Drop that trailing `}` and append `,"type":"scene-delta"}`.
        var result = new byte[deltaBytes.Length - 1 + TypeSuffix.Length];
        Buffer.BlockCopy(deltaBytes, 0, result, 0, deltaBytes.Length - 1);
        Buffer.BlockCopy(TypeSuffix, 0, result, deltaBytes.Length - 1, TypeSuffix.Length);
        // S9 instrument (disarmed by default — one volatile read): per-frame wire bytes + upsert/removal counts,
        // measured on the bytes that were just produced. Never changes what is sent.
        SceneDeltaWireMetrics.RecordFrame(result.Length, wire);
        return result;
    }
}

// Source-generated JSON metadata for the couch-coop wire delta (Web camelCase naming + omit nulls). The DTO makes
// value-type fields nullable so they omit at their client fallback default; the wire-diet leaf converters (color →
// #RRGGBBAA only, Vector2 → float32 pair, resource-ref → path only) slim every occurrence of those value types
// across the whole graph — top-level and nested in Text/ParticleSpec/ShaderParameters/etc. — with no parallel DTO
// per container. Registering runtime converters moves the converted types to STJ metadata mode (fast path bypassed
// for them); an accepted trade for the wire reduction, since serialize runs on a background drain task.
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    Converters = new[]
    {
        typeof(SceneWireColorConverter),
        typeof(SceneWireVector2Converter),
        typeof(SceneWireResourceRefConverter),
    })]
[JsonSerializable(typeof(WireSceneDelta))]
internal sealed partial class SceneDeltaJsonContext : JsonSerializerContext;
