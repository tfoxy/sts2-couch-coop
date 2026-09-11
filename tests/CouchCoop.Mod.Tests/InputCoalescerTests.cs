using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Server;

// Unit checks for the per-connection input coalescer: consecutive hovers collapse to the latest, but discrete
// events (press/release/click/key) are never dropped and keep their order relative to hovers — the logic that
// stops a continuous cursor/drag stream from backing up the game-thread injection and delaying the next click.
internal static class InputCoalescerTests
{
    public static void Run()
    {
        ConsecutiveHoversCoalesceToLatest();
        DiscreteEventBreaksCoalescing();
        DragSequenceKeepsPressAndRelease();
        NonHoverNeverDrops();
        EmptyTakeIsNull();
        // R10 WS-E — coalesced wheel runs.
        AdjacentSameDirectionWheelTicksMerge();
        OppositeWheelDirectionsNeverMerge();
        AnythingBetweenTicksBreaksTheRun();
        WheelPressReleaseEdgesNeverMerge();
        WheelRunStopsAtTheHostClamp();
    }

    private static BrowserInputRequestEnvelope Wheel(string button, int? count = null, bool? pressed = null) =>
        new("input", "r", BrowserInputKinds.Click, Button: button, Pressed: pressed, Count: count);

    private static BrowserInputRequestEnvelope Hover(double x) =>
        new("input", "r", BrowserInputKinds.Hover, CoordX: x, CoordY: 0);

    private static BrowserInputRequestEnvelope Click(bool? pressed) =>
        new("input", "r", BrowserInputKinds.Click, Button: "left", Pressed: pressed);

    private static void ConsecutiveHoversCoalesceToLatest()
    {
        var c = new InputCoalescer();
        c.Enqueue(Hover(1));
        c.Enqueue(Hover(2));
        c.Enqueue(Hover(3));
        var first = c.Take();
        Assert(first is { Kind: BrowserInputKinds.Hover, CoordX: 3 }, "three consecutive hovers coalesce to the latest position");
        Assert(c.Take() is null, "no other inputs remain after coalescing");
    }

    private static void DiscreteEventBreaksCoalescing()
    {
        var c = new InputCoalescer();
        c.Enqueue(Hover(1));
        c.Enqueue(Click(true));
        c.Enqueue(Hover(2));
        Assert(c.Take() is { Kind: BrowserInputKinds.Hover, CoordX: 1 }, "hover before a click is preserved");
        Assert(c.Take() is { Kind: BrowserInputKinds.Click }, "click is preserved in order");
        Assert(c.Take() is { Kind: BrowserInputKinds.Hover, CoordX: 2 }, "hover after a click does not coalesce into the earlier one");
        Assert(c.Take() is null, "queue drained");
    }

    private static void DragSequenceKeepsPressAndRelease()
    {
        var c = new InputCoalescer();
        c.Enqueue(Click(true));   // press
        c.Enqueue(Hover(1));      // drag-motion
        c.Enqueue(Hover(2));      // drag-motion (coalesces with the previous)
        c.Enqueue(Click(false));  // release
        Assert(c.Take() is { Kind: BrowserInputKinds.Click, Pressed: true }, "press first");
        Assert(c.Take() is { Kind: BrowserInputKinds.Hover, CoordX: 2 }, "drag motion coalesced to the latest point");
        Assert(c.Take() is { Kind: BrowserInputKinds.Click, Pressed: false }, "release after the latest drag point");
        Assert(c.Take() is null, "drag gesture fully drained");
    }

    private static void NonHoverNeverDrops()
    {
        var c = new InputCoalescer();
        c.Enqueue(Click(true));
        c.Enqueue(Click(false));
        c.Enqueue(Click(null));
        Assert(c.Take() is { Pressed: true }, "first click kept");
        Assert(c.Take() is { Pressed: false }, "second click kept");
        Assert(c.Take() is { Pressed: null }, "third click kept");
    }

    private static void EmptyTakeIsNull()
    {
        var c = new InputCoalescer();
        Assert(!c.HasPending, "empty has nothing pending");
        Assert(c.Take() is null, "take on empty is null");
    }

    // A wheel notch is a QUANTITY: N adjacent same-direction ticks are one tick repeated N times, and the host
    // injects strictly one queued message per game-thread turn — so a fast scroll used to arrive as a trickle.
    private static void AdjacentSameDirectionWheelTicksMerge()
    {
        var c = new InputCoalescer();
        c.Enqueue(Wheel("wheel-down"));
        c.Enqueue(Wheel("wheel-down"));
        c.Enqueue(Wheel("wheel-down", count: 3));
        Assert(c.Take() is { Kind: BrowserInputKinds.Click, Button: "wheel-down", Count: 5 }, "five notches merge into one message");
        Assert(c.Take() is null, "the run left nothing behind");
    }

    private static void OppositeWheelDirectionsNeverMerge()
    {
        var c = new InputCoalescer();
        c.Enqueue(Wheel("wheel-down"));
        c.Enqueue(Wheel("wheel-up"));
        Assert(c.Take() is { Button: "wheel-down", Count: null }, "the down tick stays its own message");
        Assert(c.Take() is { Button: "wheel-up", Count: null }, "the up tick stays its own message");
    }

    // ADJACENCY is the safety argument: anything else in the stream appends its own node, so a run can only form
    // out of ticks with nothing between them — which means the cursor provably did not move between them.
    private static void AnythingBetweenTicksBreaksTheRun()
    {
        var c = new InputCoalescer();
        c.Enqueue(Wheel("wheel-down"));
        c.Enqueue(Hover(7));
        c.Enqueue(Wheel("wheel-down"));
        Assert(c.Take() is { Button: "wheel-down", Count: null }, "first tick alone");
        Assert(c.Take() is { Kind: BrowserInputKinds.Hover, CoordX: 7 }, "the hover keeps its place");
        Assert(c.Take() is { Button: "wheel-down", Count: null }, "the tick after the hover is its own message");
    }

    private static void WheelPressReleaseEdgesNeverMerge()
    {
        var c = new InputCoalescer();
        c.Enqueue(Wheel("wheel-down", pressed: true));
        c.Enqueue(Wheel("wheel-down", pressed: true));
        Assert(c.Take() is { Pressed: true, Count: null }, "a wheel PRESS edge is not a quantity");
        Assert(c.Take() is { Pressed: true, Count: null }, "…and neither is the next one");
    }

    private static void WheelRunStopsAtTheHostClamp()
    {
        var c = new InputCoalescer();
        c.Enqueue(Wheel("wheel-down", count: InputCoalescer.MaxWheelCount));
        c.Enqueue(Wheel("wheel-down"));
        Assert(c.Take() is { Count: InputCoalescer.MaxWheelCount }, "a full run is not grown past the host clamp");
        Assert(c.Take() is { Count: null }, "the overflow tick starts a new run rather than being dropped");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"InputCoalescerTests failed: {label}.");
        }
    }
}
