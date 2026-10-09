using System.Text.Json;
using System.Text.Json.Serialization;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Protocol;

// Wire-diet leaf converters for the mirror scene-delta. Registered on SceneDeltaJsonContext so they slim EVERY
// occurrence of these value types anywhere in the delta graph — top-level node fields AND nested ones (inside
// Text, ParticleSpec, ShaderParameters, IntentFrames, Shadow) — without a parallel DTO for each container. They
// are WRITE-ONLY (the browser is the only reader; nothing in-process deserializes the mirror wire), so Read throws.
//
// Registering runtime converters puts the affected types into STJ metadata mode (the source-gen fast path is
// bypassed for them) — an accepted trade for the wire reduction; serialization runs on a background drain task,
// never the game thread.

// JSON has no NaN or Infinity, and Utf8JsonWriter THROWS on one rather than writing it, so a single node whose
// transform became non-finite used to fail the whole frame it rode in. The two numeric leaf converters below write
// 0 for such a channel instead and count it here, so the caller can tell that a frame was sanitized and go find
// which node did it (SceneDeltaSafeSerializer). [ThreadStatic] because a serialize is synchronous on one thread and
// several connections' drains serialize concurrently. The finite path costs one float.IsFinite and no allocation.
internal static class SceneWireNonFinite
{
    [ThreadStatic]
    private static int t_count;

    // Non-finite channels written as 0 on this thread since the last Reset.
    internal static int Count => t_count;

    internal static void Reset() => t_count = 0;

    // A double outside float range also lands here: the `(float)` cast turns it into Infinity.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.AggressiveInlining)]
    internal static float Sanitize(float value)
    {
        if (float.IsFinite(value))
        {
            return value;
        }

        t_count++;
        return 0f;
    }
}

// Color: the client reads only #RRGGBBAA (or derives the linear channels from it — Godot's ToHtml is a direct
// round(channel*255), the exact granularity the producer change-detects colors at). So ship `{"html":...}` alone
// and drop the four full-double channels (~90 → ~20 bytes/color). Defensive fallback: if a color somehow lacks its
// hex (only transient in-watcher cache entries do — never an emitted one), ship the float channels so no color is
// ever lost; the client's channels-first precedence reads them.
public sealed class SceneWireColorConverter : JsonConverter<RuntimeSceneColorSnapshot>
{
    public override RuntimeSceneColorSnapshot Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => throw new NotSupportedException("SceneWireColorConverter is write-only (the mirror wire is browser-consumed).");

    public override void Write(Utf8JsonWriter writer, RuntimeSceneColorSnapshot value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        if (value.Html is not null)
        {
            writer.WriteString("html", value.Html);
        }
        else
        {
            writer.WriteNumber("r", SceneWireNonFinite.Sanitize((float)value.R));
            writer.WriteNumber("g", SceneWireNonFinite.Sanitize((float)value.G));
            writer.WriteNumber("b", SceneWireNonFinite.Sanitize((float)value.B));
            writer.WriteNumber("a", SceneWireNonFinite.Sanitize((float)value.A));
        }

        writer.WriteEndObject();
    }
}

// Vector2: the client parses x/y as plain numbers, so serialize them as float32 (shortest round-trip) instead of
// the full-double promotion. The producer's transforms/rects originate as Godot float32 and are change-detected at
// 2 decimals, so the extra double digits are pure noise; `(float)` recovers the shortest string that round-trips
// to the same float32. Slims transform/localRect/textureRegion/textureMargin (all Vector2-composed) ~18 → ~4-6
// chars/number — the single biggest numeric win.
public sealed class SceneWireVector2Converter : JsonConverter<RuntimeSceneVector2Snapshot>
{
    public override RuntimeSceneVector2Snapshot Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => throw new NotSupportedException("SceneWireVector2Converter is write-only (the mirror wire is browser-consumed).");

    public override void Write(Utf8JsonWriter writer, RuntimeSceneVector2Snapshot value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteNumber("x", SceneWireNonFinite.Sanitize((float)value.X));
        writer.WriteNumber("y", SceneWireNonFinite.Sanitize((float)value.Y));
        writer.WriteEndObject();
    }
}

// ResourceRef: the client reads only `resourcePath` (normalizeResourcePath); the Field / ResourceType /
// ResourceName metadata is dead weight (~0.68MB across a combat recording — texture ships every tick). Ship the
// path alone; the object shape is preserved so the client needs no change and OLD recordings (fuller refs) still
// read `.resourcePath` fine.
public sealed class SceneWireResourceRefConverter : JsonConverter<RuntimeSceneResourceRefSnapshot>
{
    public override RuntimeSceneResourceRefSnapshot Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => throw new NotSupportedException("SceneWireResourceRefConverter is write-only (the mirror wire is browser-consumed).");

    public override void Write(Utf8JsonWriter writer, RuntimeSceneResourceRefSnapshot value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("resourcePath", value.ResourcePath);
        writer.WriteEndObject();
    }
}
