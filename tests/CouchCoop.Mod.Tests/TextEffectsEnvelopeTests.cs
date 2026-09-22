using System.Text.Json;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;

// The GAME's Settings -> Text Effects preference, on the `session` envelope.
//
// WHY IT IS ON THE WIRE AT ALL. The mirror animates the game's wavy and bouncing rich text, and it cannot work
// out whether the player wants that: the game leaves the effect markup in the label's string and skips the
// per-character transform instead, so a viewer receives identical BBCode whichever way the setting is set.
//
// WHAT THIS RUNNER CAN PROVE, and what it deliberately does not touch. Reading the preference reaches the game's
// save system, which resolves through Godot — a NATIVE call that segfaults rather than throwing in this process
// (see the note at the top of BrowserServerRouteTests.cs, and the engine latch it describes). So the assertion
// here is the DEGRADED path, which is also the one that protects every C# suite in this repo: with no engine
// behind the process the read is skipped on the latch, the field is null, and null must OMIT rather than travel
// as `false` — a `false` on the wire would tell every viewer of a Godot-less host to stop animating.
//
// The live reading is verified in a real game session, where the toggle is observable on screen.
internal static class TextEffectsEnvelopeTests
{
    public static void Run()
    {
        GodotLessHostOmitsThePreference();
        TheFieldIsNotPartOfTheClientSettingsChannel();
    }

    private static void GodotLessHostOmitsThePreference()
    {
        var envelope = CreateSessionEnvelope();

        Assert(envelope.TextEffects is null,
            "no engine ⇒ the preference is unknown, not false");

        var json = JsonSerializer.SerializeToElement(envelope, BrowserJson.Options);
        Assert(!json.TryGetProperty("textEffects", out _),
            "an unknown preference is OMITTED, so the client keeps its own default of enabled");
    }

    // One-way on purpose: this is a fact about the game, not a viewer preference, so there is no path for a
    // browser to push it back. A `textEffects` on the settings channel must land nowhere.
    private static void TheFieldIsNotPartOfTheClientSettingsChannel()
    {
        var parsed = BrowserJson.Deserialize<CouchCoop.MirrorProtocol.Envelopes.BrowserSettingsRequestEnvelope>(
            """{"type":"settings","requestId":"settings:1","textEffects":false,"freezeSpines":true}""");

        Assert(parsed is not null, "settings message still parses with an unknown field present");
        Assert(parsed!.FreezeSpines == true, "the fields that ARE the client's still round-trip");
        Assert(
            typeof(CouchCoop.MirrorProtocol.Envelopes.BrowserSettingsRequestEnvelope)
                .GetProperty("TextEffects") is null,
            "the client settings envelope has no text-effects lever to set");
    }

    private static BrowserEnvelope CreateSessionEnvelope()
    {
        var stub = new AssetCacheTokenEnvelopeTests.StubRuntime("game-1.0");
        return new BrowserStateEnvelopeFactory(
                new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
                    stub, stub, stub, stub, stub, stub, stub, stub, stub, stub)))
            .CreateSessionEnvelope("Alice", "session", null).GetAwaiter().GetResult();
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"TextEffectsEnvelopeTests: {message}");
        }
    }
}
