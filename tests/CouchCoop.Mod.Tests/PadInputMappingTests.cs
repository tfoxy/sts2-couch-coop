using CouchCoop.Mod.Protocol;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Embedding;

// Pure mapping checks for the GAMEPAD half of the browser input envelope (`kind: "pad"`) → spirectl
// EmbeddableActionRequest. The twin of InputMappingTests, kept separate because the rules are the inverse of the
// pointer path's: a pad message addresses nothing on screen, so the interesting assertions are all about what the
// request must NOT carry. No live game and no engine — the token vocabulary itself is spirectl's to validate, so
// nothing here asserts which tokens exist. Assert-or-throw like the rest of this suite; invoked from the entry.
internal static class PadInputMappingTests
{
    public static void Run()
    {
        PadCarriesTokenAndEdge();
        PadSetsNoPointerFields();
        BothEdgesSurvive();
        AbsentPressedStaysATapAndNeverDefaultsToDown();
        UnknownTokensArePassedThroughForSpirectlToRefuse();
        UnknownKindIsStillRefused();
        PadKindReachesTheRuntime();
        TheWireFieldIsCalledInput();
        AbsentTokenKeepsTheWireByteIdentical();
    }

    // The client half is written against the WIRE, not against this record, so the JSON name is the contract:
    // `{ "type": "input", "kind": "pad", "input": "faceSouth", "pressed": true }`. Deserialized through the real
    // BrowserJson options the socket uses, so a rename here fails loudly instead of quietly ignoring every pad
    // message a conforming client sends.
    private static void TheWireFieldIsCalledInput()
    {
        var parsed = BrowserJson.Deserialize<BrowserInputRequestEnvelope>(
            """{"type":"input","requestId":"p9","kind":"pad","input":"faceSouth","pressed":true}""");

        Assert(parsed is not null, "the pad wire shape parses");
        Assert(parsed!.Kind == BrowserInputKinds.Pad && BrowserInputKinds.Pad == "pad", "the kind is the string 'pad'");
        Assert(parsed.Input == "faceSouth", "the token arrives on the `input` wire field");
        Assert(parsed.Pressed == true, "the edge arrives on the existing `pressed` field");

        var tap = BrowserJson.Deserialize<BrowserInputRequestEnvelope>(
            """{"type":"input","requestId":"p10","kind":"pad","input":"start"}""");
        Assert(tap!.Pressed is null, "an omitted `pressed` parses as absent, not false");
    }

    // The new field is optional, so every message an existing client already sends must serialize exactly as it
    // did before — no `input` key appears on a pointer or key message.
    private static void AbsentTokenKeepsTheWireByteIdentical()
    {
        var click = BrowserJson.Serialize(
            new BrowserInputRequestEnvelope("input", "p11", BrowserInputKinds.Click, CoordX: 10, CoordY: 20, Button: "left"));
        Assert(!click.Contains("\"input\":", StringComparison.Ordinal), "a click message carries no `input` key");

        var key = BrowserJson.Serialize(
            new BrowserInputRequestEnvelope("input", "p12", BrowserInputKinds.Key, Key: "KeyE", Pressed: true));
        Assert(!key.Contains("\"input\":", StringComparison.Ordinal), "a key message carries no `input` key");
    }

    private static void PadCarriesTokenAndEdge()
    {
        var action = BrowserInputExecutor.BuildPad(
            "p1", new BrowserInputRequestEnvelope("input", "p1", BrowserInputKinds.Pad, Input: "faceSouth", Pressed: true));

        Assert(action.Kind == SemanticActionKind.ControllerInput, "pad builds the ControllerInput kind");
        Assert(action.RequestId == "p1", "pad keeps the request id");
        Assert(action.ControllerInput == "faceSouth", "the token rides ControllerInput");
        Assert(action.KeyPressed == true, "the edge rides KeyPressed (no second 'pressed' field)");
        Assert(action.Key is null && action.KeyModifiers is null, "a pad input is not a key input");
    }

    // A pad press addresses no point on screen — the game's own focus decides what it applies to. A stray
    // coordinate would be a silently different action, so the builder must drop everything the client sent that
    // belongs to the pointer path.
    private static void PadSetsNoPointerFields()
    {
        var noisy = new BrowserInputRequestEnvelope(
            "input", "p2", BrowserInputKinds.Pad,
            Input: "dpadUp", Pressed: true,
            ElementId: "12345", OffsetX: 0.25, OffsetY: 0.75,
            CoordX: 960, CoordY: 540, Button: "right", Count: 9,
            Key: "KeyE", Modifiers: "ctrl");

        var action = BrowserInputExecutor.BuildPad("p2", noisy);

        Assert(action.MouseX is null && action.MouseY is null, "pad sets no coordinate");
        Assert(action.MouseButton is null, "pad sets no mouse button");
        Assert(action.MousePressed is null, "pad sets no mouse press state");
        Assert(action.ElementId is null, "pad sets no element id");
        Assert(action.OffsetX is null && action.OffsetY is null, "pad sets no element offset");
        Assert(action.Values is null, "pad builds no Values bag (no wheel count)");
        Assert(action.Key is null && action.KeyModifiers is null, "pad drops key fields even when present");
        Assert(action.ControllerInput == "dpadUp" && action.KeyPressed == true, "…while still carrying token + edge");
    }

    // The game's UI reads both edges (a held d-pad repeat, a charge-up), so a client streaming real button state
    // sends down and up and both have to survive intact.
    private static void BothEdgesSurvive()
    {
        var down = BrowserInputExecutor.BuildPad(
            "p3", new BrowserInputRequestEnvelope("input", "p3", BrowserInputKinds.Pad, Input: "leftBumper", Pressed: true));
        Assert(down.KeyPressed == true, "a press edge threads KeyPressed=true");

        var up = BrowserInputExecutor.BuildPad(
            "p4", new BrowserInputRequestEnvelope("input", "p4", BrowserInputKinds.Pad, Input: "leftBumper", Pressed: false));
        Assert(up.KeyPressed == false, "a release edge threads KeyPressed=false — not dropped, not coerced to true");
    }

    // Absent must stay ABSENT. spirectl reads null as "inject press+release in one turn"; defaulting it to true
    // here would latch a button down with no release ever coming, and the seat would eat every later input.
    private static void AbsentPressedStaysATapAndNeverDefaultsToDown()
    {
        var tap = BrowserInputExecutor.BuildPad(
            "p5", new BrowserInputRequestEnvelope("input", "p5", BrowserInputKinds.Pad, Input: "start"));
        Assert(tap.KeyPressed is null, "absent pressed stays null (a tap), never true");
    }

    // Validation is spirectl's job: it answers a token against the running build's registered actions and refuses
    // an unknown token and an unmapped build with distinct messages. couch must therefore forward whatever came in
    // rather than second-guess it with a table it cannot keep in sync.
    private static void UnknownTokensArePassedThroughForSpirectlToRefuse()
    {
        foreach (var token in new string?[] { "notAToken", "", null })
        {
            var action = BrowserInputExecutor.BuildPad(
                "p6", new BrowserInputRequestEnvelope("input", "p6", BrowserInputKinds.Pad, Input: token, Pressed: true));
            Assert(action.Kind == SemanticActionKind.ControllerInput, $"token '{token ?? "null"}' still builds a pad request");
            Assert(action.ControllerInput == token, $"token '{token ?? "null"}' is forwarded verbatim for the host to judge");
        }
    }

    // The new kind must not have widened the refusal: anything that is not a known kind is still an
    // invalid-action-message, and nothing reaches the runtime.
    private static void UnknownKindIsStillRefused()
    {
        var runtime = new ProbeActionSource();
        var result = new BrowserInputExecutor(runtime).Execute(
            new BrowserInputRequestEnvelope("input", "p7", "gamepad", Input: "faceSouth", Pressed: true));

        Assert(result?.Code == BrowserActionErrorCodes.InvalidMessage, "an unknown input kind is refused as before");
        Assert(result?.Message == "Unsupported input kind 'gamepad'.", "…and the refusal names the kind it rejected");
        Assert(runtime.Last is null, "a refused kind never reaches the runtime");
    }

    // And the wired-in kind goes the whole way through Execute (not just the builder), returning null on success
    // like every other input — a pad edge is fire-and-forget, not echoed.
    private static void PadKindReachesTheRuntime()
    {
        var runtime = new ProbeActionSource();
        var result = new BrowserInputExecutor(runtime).Execute(
            new BrowserInputRequestEnvelope("input", "p8", BrowserInputKinds.Pad, Input: "faceEast", Pressed: false));

        Assert(result is null, "a successful pad injection is not echoed back to the client");
        Assert(runtime.Last?.Kind == SemanticActionKind.ControllerInput, "the pad kind reaches the runtime as ControllerInput");
        Assert(runtime.Last?.ControllerInput == "faceEast", "…carrying the token");
        Assert(runtime.Last?.KeyPressed == false, "…and the release edge");
    }

    private sealed class ProbeActionSource : ISemanticActionSource
    {
        public EmbeddableActionRequest? Last { get; private set; }

        public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request)
        {
            Last = request;
            return new EmbeddableActionResult(true, null, null);
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"PadInputMappingTests failed: {label}.");
        }
    }
}
