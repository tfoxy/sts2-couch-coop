using CouchCoop.Mod.Protocol;
using Spirectl.Sts2.Core.Actions;

// Pure mapping checks for the browser input envelope → spirectl EmbeddableActionRequest translation (no live
// game needed). Element id is authoritative: when present, coordinates are dropped so the HOST resolves the
// live rect; empty-space input instead carries a design-space coordinate. Mirrors the harness style of
// BrowserServerRouteTests (assert-or-throw), invoked from the test entry.
internal static class InputMappingTests
{
    public static void Run()
    {
        HoverByElementDropsCoordinatesAndKeepsOffset();
        ClickByElementCarriesButton();
        ClickOnEmptySpaceUsesRoundedCoordinate();
        KeyInputCarriesCodeModifiersAndPressed();
        ClickThreadsPressStateForDrag();
        HoverIgnoresPressState();
        // R10 WS-E — the coalesced wheel-tick count.
        WheelCountRidesTheValuesBag();
        WheelCountIsOmittedForASingleTick();
        NonWheelButtonsNeverRepeat();
        WheelEdgesNeverRepeat();
    }

    // The repeat count rides the scalar Values bag (spirectl's ReadWheelCount reads `count`), so no action-record
    // field had to change and the CLI path is untouched.
    private static void WheelCountRidesTheValuesBag()
    {
        var action = BrowserInputExecutor.BuildPointer(
            "rw1", SemanticActionKind.MouseClick,
            new BrowserInputRequestEnvelope("input", "rw1", BrowserInputKinds.Click, CoordX: 5, CoordY: 6, Button: "wheel-down", Count: 7));
        Assert(action.Values is not null && action.Values["count"] == "7", "a coalesced wheel run carries count=7");
        Assert(action.MouseButton == RawMouseButtonKind.WheelDown, "…on the wheel-down button");
    }

    // A single tick must build the EXACT request it built before the feature existed.
    private static void WheelCountIsOmittedForASingleTick()
    {
        foreach (var count in new int?[] { null, 0, 1 })
        {
            var action = BrowserInputExecutor.BuildPointer(
                "rw2", SemanticActionKind.MouseClick,
                new BrowserInputRequestEnvelope("input", "rw2", BrowserInputKinds.Click, CoordX: 5, CoordY: 6, Button: "wheel-up", Count: count));
            Assert(action.Values is null, $"count {count?.ToString() ?? "absent"} builds no Values bag");
        }
    }

    // A repeat only ever means "N wheel notches" — a malformed or hostile count must never multiply a left click.
    private static void NonWheelButtonsNeverRepeat()
    {
        var action = BrowserInputExecutor.BuildPointer(
            "rw3", SemanticActionKind.MouseClick,
            new BrowserInputRequestEnvelope("input", "rw3", BrowserInputKinds.Click, CoordX: 5, CoordY: 6, Button: "left", Count: 9));
        Assert(action.Values is null, "a left click is never repeated, whatever the count says");
    }

    // A press/release is an EDGE, not a quantity: repeating one would desync the host's held-button state.
    private static void WheelEdgesNeverRepeat()
    {
        var press = BrowserInputExecutor.BuildPointer(
            "rw4", SemanticActionKind.MouseClick,
            new BrowserInputRequestEnvelope("input", "rw4", BrowserInputKinds.Click, CoordX: 5, CoordY: 6, Button: "wheel-down", Pressed: true, Count: 4));
        Assert(press.Values is null, "a wheel press edge carries no repeat count");

        var hover = BrowserInputExecutor.BuildPointer(
            "rw5", SemanticActionKind.HoverElement,
            new BrowserInputRequestEnvelope("input", "rw5", BrowserInputKinds.Hover, CoordX: 5, CoordY: 6, Button: "wheel-down", Count: 4));
        Assert(hover.Values is null, "a hover carries no repeat count");
    }

    private static void ClickThreadsPressStateForDrag()
    {
        var press = BrowserInputExecutor.BuildPointer(
            "r5", SemanticActionKind.MouseClick,
            new BrowserInputRequestEnvelope("input", "r5", BrowserInputKinds.Click, CoordX: 10, CoordY: 20, Button: "left", Pressed: true));
        Assert(press.MousePressed == true, "press threads MousePressed=true (drag hold)");

        var release = BrowserInputExecutor.BuildPointer(
            "r6", SemanticActionKind.MouseClick,
            new BrowserInputRequestEnvelope("input", "r6", BrowserInputKinds.Click, CoordX: 10, CoordY: 20, Button: "left", Pressed: false));
        Assert(release.MousePressed == false, "release threads MousePressed=false");

        var fullClick = BrowserInputExecutor.BuildPointer(
            "r7", SemanticActionKind.MouseClick,
            new BrowserInputRequestEnvelope("input", "r7", BrowserInputKinds.Click, CoordX: 10, CoordY: 20, Button: "left"));
        Assert(fullClick.MousePressed is null, "absent pressed → a full click (MousePressed null)");
    }

    private static void HoverIgnoresPressState()
    {
        // `pressed` is only meaningful for clicks; a hover must never carry it (the producer drives drag-motion
        // from its own held-button state, not the hover message).
        var hover = BrowserInputExecutor.BuildPointer(
            "r8", SemanticActionKind.HoverElement,
            new BrowserInputRequestEnvelope("input", "r8", BrowserInputKinds.Hover, CoordX: 1, CoordY: 2, Pressed: true));
        Assert(hover.MousePressed is null, "hover drops pressed");
    }

    private static void HoverByElementDropsCoordinatesAndKeepsOffset()
    {
        var request = new BrowserInputRequestEnvelope(
            "input", "r1", BrowserInputKinds.Hover,
            ElementId: "12345", OffsetX: 0.25, OffsetY: 0.75,
            CoordX: 999, CoordY: 999);

        var action = BrowserInputExecutor.BuildPointer("r1", SemanticActionKind.HoverElement, request);

        Assert(action.Kind == SemanticActionKind.HoverElement, "hover kind");
        Assert(action.ElementId == "12345", "hover element id");
        Assert(action.OffsetX == 0.25 && action.OffsetY == 0.75, "hover offset passthrough");
        // Element id wins: coordinates must be dropped so spirectl resolves the live rect.
        Assert(action.MouseX is null && action.MouseY is null, "hover drops coordinates when element present");
    }

    private static void ClickByElementCarriesButton()
    {
        var request = new BrowserInputRequestEnvelope(
            "input", "r2", BrowserInputKinds.Click, ElementId: "999", Button: "right");

        var action = BrowserInputExecutor.BuildPointer("r2", SemanticActionKind.MouseClick, request);

        Assert(action.Kind == SemanticActionKind.MouseClick, "click kind");
        Assert(action.ElementId == "999", "click element id");
        Assert(action.MouseButton == RawMouseButtonKind.Right, "click right button");
    }

    private static void ClickOnEmptySpaceUsesRoundedCoordinate()
    {
        var request = new BrowserInputRequestEnvelope(
            "input", "r3", BrowserInputKinds.Click, CoordX: 960.4, CoordY: 540.6, Button: "left");

        var action = BrowserInputExecutor.BuildPointer("r3", SemanticActionKind.MouseClick, request);

        Assert(action.ElementId is null, "empty-space has no element id");
        Assert(action.MouseX == 960 && action.MouseY == 541, "empty-space rounds the design coordinate");
        Assert(action.MouseButton == RawMouseButtonKind.Left, "empty-space left button");
    }

    private static void KeyInputCarriesCodeModifiersAndPressed()
    {
        var request = new BrowserInputRequestEnvelope(
            "input", "r4", BrowserInputKinds.Key, Key: "KeyE", Modifiers: "ctrl,shift", Pressed: true);

        var action = BrowserInputExecutor.BuildKey("r4", request);

        Assert(action.Kind == SemanticActionKind.KeyInput, "key kind");
        Assert(action.Key == "KeyE", "key code");
        Assert(action.KeyModifiers == "ctrl,shift", "key modifiers");
        Assert(action.KeyPressed == true, "key pressed");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"InputMappingTests failed: {label}.");
        }
    }
}
