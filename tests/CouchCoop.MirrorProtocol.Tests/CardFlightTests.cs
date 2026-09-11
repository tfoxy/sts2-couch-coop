using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-3 declarative discard→draw shuffle CARD FLIGHT — the wire contract: SceneDeltaReader.NormalizeCardFlight's
// strictness, the applier's one-shot accumulate + bounded valve, and the round trip of a producer-shaped payload.
//
// WHY THE READER IS STRICT (and this suite is mostly rejection cases). A card-flight hint is not decoration: the
// producer has STOPPED streaming the named nodes' transforms for `windowMs`, so a half-parsed flight leaves a
// shuffle's cards frozen at the discard pile instead of merely un-eased. Every geometry field must be present with
// the right arity and finite, and every integrator scalar must be usable — anything else is dropped whole.
internal static class CardFlightTests
{
    public static void Run()
    {
        ParsesAProducerShapedFlight();
        OmittedArrayMeansNoFlights();
        RejectsMissingOrMalformedGeometry();
        RejectsUnusableIntegratorScalars();
        RejectsNonFiniteNumbers();
        TrailIsOptional();
        KindNormalizesAndFailsOpen();
        Rot0IsSeededOrZero();
        FlightsAreIndependentOfTweenHints();
        ApplierAccumulatesAcrossDeltasAndBoundsTheBacklog();
        WindowArithmeticMatchesTheProducer();
    }

    // The exact shape CouchCoopBrowserServer.CollectCardFlights → WireSceneDelta serializes (camelCase, nulls
    // omitted). Built as a string rather than a DTO so a producer-side rename shows up here as a parse failure.
    private static string Envelope(string flightsJson) =>
        $$"""
        {"type":"scene-delta","full":false,"screenType":"combat","upserts":[],"removedIds":[],
         "cardFlights":[{{flightsJson}}]}
        """;

    private const string GoodFlight =
        """
        {"targetId":"41","trailId":"42","start":[300,880],"end":[1620,880],"control":[960,280],
         "basis":[1,0,0,1],"speed0":1.18,"accel":2.3,"duration":1.4,"scale0":1,"windowMs":3600}
        """;

    private static MirrorDelta Parse(string flightsJson)
    {
        var delta = SceneDeltaReader.Parse(Envelope(flightsJson));
        Check.That(delta is not null, "delta parses");
        return delta!;
    }

    private static void ParsesAProducerShapedFlight()
    {
        var flight = Parse(GoodFlight).CardFlights.Single();
        Check.Equal(flight.TargetId, "41", "targetId");
        Check.Equal(flight.TrailId, "42", "trailId");
        Check.SequenceClose(flight.Start, [300, 880], "start");
        Check.SequenceClose(flight.End, [1620, 880], "end");
        Check.SequenceClose(flight.Control, [960, 280], "control");
        Check.SequenceClose(flight.Basis, [1, 0, 0, 1], "basis");
        Check.Close(flight.Speed0, 1.18, "speed0");
        Check.Close(flight.Accel, 2.3, "accel");
        Check.Close(flight.Duration, 1.4, "duration");
        Check.Close(flight.Scale0, 1, "scale0");
        Check.Close(flight.WindowMs, 3600, "windowMs");
    }

    // The overwhelmingly common case: no shuffle this tick, so the producer omits the key entirely. Must be an
    // empty list, never null — the applier and the renderer both read `.Count` unguarded.
    private static void OmittedArrayMeansNoFlights()
    {
        var delta = SceneDeltaReader.Parse(
            """{"type":"scene-delta","full":false,"screenType":"combat","upserts":[],"removedIds":[]}""");
        Check.That(delta is not null, "delta parses");
        Check.Equal(delta!.CardFlights.Count, 0, "no cardFlights key ⇒ empty");
    }

    private static void RejectsMissingOrMalformedGeometry()
    {
        // Each of these mutates exactly ONE field of GoodFlight, so a rejection can only be about that field.
        Reject(WithField("targetId", "\"\""), "empty targetId");
        Reject(Without("targetId"), "missing targetId");
        Reject(Without("start"), "missing start");
        Reject(Without("end"), "missing end");
        Reject(Without("control"), "missing control");
        Reject(Without("basis"), "missing basis");
        Reject(WithField("start", "[300]"), "start arity 1");
        Reject(WithField("start", "[300,880,0]"), "start arity 3");
        Reject(WithField("basis", "[1,0,0]"), "basis arity 3");
        Reject(WithField("basis", "[1,0,0,1,0,0]"), "basis arity 6 (a transform, not a basis)");
        Reject(WithField("end", "\"1620,880\""), "end as a string");
        Reject(WithField("control", "[\"960\",280]"), "control with a string entry");
        Reject("42", "a bare number instead of an object");
    }

    private static void RejectsUnusableIntegratorScalars()
    {
        Reject(WithField("duration", "0"), "duration 0 (divide by zero on every step)");
        Reject(WithField("duration", "-1.4"), "negative duration");
        Reject(Without("duration"), "missing duration");
        Reject(WithField("speed0", "0"), "speed0 0 (`time` never advances ⇒ the flight never ends)");
        Reject(WithField("speed0", "-1"), "negative speed0");
        Reject(WithField("scale0", "0"), "scale0 0 (divide by zero in the phase-2 pop)");
        Reject(Without("accel"), "missing accel");
        Reject(WithField("windowMs", "0"), "windowMs 0 (no pin ⇒ nothing to hold the pose)");
        Reject(Without("windowMs"), "missing windowMs");
        // accel MAY be 0 or negative — a real hint carries 2..2.5, but a decelerating flight still integrates fine.
        Check.Equal(Parse(WithField("accel", "0")).CardFlights.Count, 1, "accel 0 is integrable");
    }

    private static void RejectsNonFiniteNumbers()
    {
        // JSON has no NaN/Infinity literal, but a huge exponent parses to Infinity in .NET and JS alike — which
        // would silently produce NaN poses. Rejected on the geometry AND the scalars.
        Reject(WithField("duration", "1e400"), "duration overflowing to Infinity");
        Reject(WithField("start", "[1e400,880]"), "start overflowing to Infinity");
        Reject(WithField("basis", "[1e400,0,0,1]"), "basis overflowing to Infinity");
    }

    private static void TrailIsOptional()
    {
        // There is no trail in test mode / outside a combat room; the flight itself still replays.
        var flight = Parse(Without("trailId")).CardFlights.Single();
        Check.That(flight.TrailId is null, "absent trailId ⇒ null");
        var empty = Parse(WithField("trailId", "\"\"")).CardFlights.Single();
        Check.That(empty.TrailId is null, "empty trailId ⇒ null (not an id that joins to nothing)");
    }

    // R13 — `kind` is the ONE field this strict parser is lenient about, and deliberately in the other direction:
    // it is normalized, never rejected. Unusable geometry is dropped because there is nothing to integrate; a kind
    // the client does not know still comes with a complete, integrable flight, so failing open to the shuffle motion
    // costs the wrong flavour of animation while a drop would leave the (suppressed) card frozen on the pile.
    private static void KindNormalizesAndFailsOpen()
    {
        Check.Equal(Parse(GoodFlight).CardFlights.Single().Kind, "shuffle", "absent kind ⇒ shuffle");
        Check.Equal(Parse(WithField("kind", "\"discard\"")).CardFlights.Single().Kind, "discard", "discard round-trips");
        Check.Equal(Parse(WithField("kind", "\"shuffle\"")).CardFlights.Single().Kind, "shuffle", "explicit shuffle");

        // Anything that is not exactly the literal "discard" reads as the shuffle sweep — a future kind, a casing
        // slip, an empty string, or a value that is not a string at all. None of them may drop the entry.
        foreach (var raw in new[] { "\"supernova\"", "\"Discard\"", "\"DISCARD\"", "\"\"", "null", "7", "true", "[\"discard\"]" })
        {
            var flights = Parse(WithField("kind", raw)).CardFlights;
            Check.Equal(flights.Count, 1, $"kind {raw} is still a flight");
            Check.Equal(flights[0].Kind, "shuffle", $"kind {raw} ⇒ shuffle");
        }
    }

    // `rot0` seeds the discard replay's turn, so an unusable value degrades to 0 (start the turn from square) rather
    // than dropping the flight — same reasoning as `kind`, and the same reason it is not part of the strict block.
    private static void Rot0IsSeededOrZero()
    {
        Check.Close(Parse(GoodFlight).CardFlights.Single().Rot0, 0, "absent rot0 ⇒ 0");
        Check.Close(Parse(WithField("rot0", "-0.35")).CardFlights.Single().Rot0, -0.35, "finite rot0 preserved");
        Check.Close(Parse(WithField("rot0", "0")).CardFlights.Single().Rot0, 0, "explicit 0 preserved");

        foreach (var raw in new[] { "1e400", "-1e400", "null", "\"-0.35\"", "[0.5]" })
        {
            var flights = Parse(WithField("rot0", raw)).CardFlights;
            Check.Equal(flights.Count, 1, $"rot0 {raw} is still a flight");
            Check.Close(flights[0].Rot0, 0, $"rot0 {raw} ⇒ 0");
        }

        // The two travel together on the wire but are independent in the reader: a discard with an unusable seed is
        // still a discard.
        var flight = Parse(ReplaceField(WithField("kind", "\"discard\""), "rot0", "1e400")).CardFlights.Single();
        Check.Equal(flight.Kind, "discard", "kind survives an unusable rot0");
        Check.Close(flight.Rot0, 0, "unusable rot0 on a discard ⇒ 0");
    }

    // Flights ride their OWN array: the producer never mixes them into `hints`, because they are integrated rather
    // than eased and their synthetic property name is not a Godot property the client could map to a CSS channel.
    private static void FlightsAreIndependentOfTweenHints()
    {
        var json =
            $$"""
            {"type":"scene-delta","full":false,"screenType":"combat","upserts":[],"removedIds":[],
             "hints":[{"targetId":"7","property":"modulate:a","durationMs":800,"endOpacity":0}],
             "cardFlights":[{{GoodFlight}}]}
            """;
        var delta = SceneDeltaReader.Parse(json);
        Check.That(delta is not null, "delta parses");
        Check.Equal(delta!.Hints.Count, 1, "the tween hint survives");
        Check.Equal(delta.CardFlights.Count, 1, "the flight survives");
        Check.Equal(delta.Hints[0].TargetId, "7", "hint target");
        Check.Equal(delta.CardFlights[0].TargetId, "41", "flight target");
    }

    private static void ApplierAccumulatesAcrossDeltasAndBoundsTheBacklog()
    {
        var state = MirrorState.Create();
        SceneTreeApplier.ApplySceneDelta(state, Parse(GoodFlight));
        SceneTreeApplier.ApplySceneDelta(state, Parse(WithField("targetId", "\"99\"")));
        Check.Equal(state.PendingCardFlights.Count, 2, "flights accumulate across coalesced deltas");
        Check.Equal(state.PendingCardFlights[1].TargetId, "99", "in arrival order");

        // The valve: a consumer that never drains must not grow without bound. Freshest kept, stalest dropped —
        // a stale flight is the one whose suppression window has most likely already closed.
        for (var i = 0; i < 100; i++)
        {
            SceneTreeApplier.ApplySceneDelta(state, Parse(WithField("targetId", $"\"{i}\"")));
        }

        Check.Equal(state.PendingCardFlights.Count, 64, "backlog bounded at 64");
        Check.Equal(state.PendingCardFlights[^1].TargetId, "99", "the newest flight is kept");
    }

    // The producer's window is `2*duration + 0.8s` (Sts2CardFlightMath.SuppressWindowMs), an analytic upper bound
    // on the animation's wall-clock life. The client must hold its pin for exactly the window it was TOLD, not for
    // its own re-derivation — that is what guarantees the pin outlives the freeze by a frame instead of racing it.
    private static void WindowArithmeticMatchesTheProducer()
    {
        foreach (var (duration, expected) in new[] { (1.0, 2800.0), (1.4, 3600.0), (1.75, 4300.0) })
        {
            var json = WithField("duration", duration.ToString(System.Globalization.CultureInfo.InvariantCulture));
            json = ReplaceField(json, "windowMs", expected.ToString(System.Globalization.CultureInfo.InvariantCulture));
            var flight = Parse(json).CardFlights.Single();
            Check.Close(flight.WindowMs, expected, $"windowMs for duration {duration}");
            // The relationship the producer promises, restated here so a drift on either side is visible.
            Check.Close(flight.WindowMs, (2 * flight.Duration + 0.8) * 1000, $"2*duration+0.8 for {duration}");
        }
    }

    // ---- mutation helpers ---------------------------------------------------------------------------------

    private static void Reject(string flightJson, string label)
    {
        var delta = SceneDeltaReader.Parse(Envelope(flightJson));
        Check.That(delta is not null, $"{label}: envelope still parses");
        Check.Equal(delta!.CardFlights.Count, 0, $"{label}: flight rejected");
    }

    // Rebuild GoodFlight with one property replaced (raw JSON text) or removed. Goes through JsonNode so the
    // helpers can't produce malformed JSON and accidentally "prove" a rejection that was really a syntax error.
    private static string WithField(string name, string rawJson) => ReplaceField(GoodFlight, name, rawJson);

    private static string ReplaceField(string flightJson, string name, string rawJson)
    {
        using var doc = JsonDocument.Parse(flightJson);
        var parts = doc.RootElement.EnumerateObject()
            .Select(p => p.NameEquals(name)
                ? $"\"{p.Name}\":{rawJson}"
                : $"\"{p.Name}\":{p.Value.GetRawText()}")
            .ToList();
        if (!parts.Any(p => p.StartsWith($"\"{name}\":", StringComparison.Ordinal)))
        {
            parts.Add($"\"{name}\":{rawJson}");
        }

        return "{" + string.Join(",", parts) + "}";
    }

    private static string Without(string name)
    {
        using var doc = JsonDocument.Parse(GoodFlight);
        var parts = doc.RootElement.EnumerateObject()
            .Where(p => !p.NameEquals(name))
            .Select(p => $"\"{p.Name}\":{p.Value.GetRawText()}");
        return "{" + string.Join(",", parts) + "}";
    }
}
