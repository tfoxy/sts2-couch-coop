using CouchCoop.Mod.Protocol;
using Godot;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Embedding;

// GSW input plan row C3: the host's `retarget: "when-missed"` placement of couch pointer messages that name a target
// (docs/input.md "Pointer targets" in godot-scene-web; the reference GDScript injector's gsw_input_targets.gd). Pure:
// the nodes are fakes with a canvas transform, a Control size (or none) and liveness/visibility switches.
internal static class PointerTargetPlacementTests
{
    public const string Verb = "pointer-targets";

    private const string Scene = "res://scenes/event.tscn";

    public static void Run()
    {
        NoTargetAndNothingBoundIsTheOldPath();
        ALandedCoordinateGoesAsSent();
        AButtonMovedBeforeArrivalIsPlacedOnIt();
        ARaisedCardsMappedCoordinateLands();
        ANode2DLandsWithinTolerance();
        AmbiguousInstancesPickTheLandedOneOrNone();
        AFreedOrHiddenTargetFallsBackToTheCoordinate();
        APressBindsUntilEveryButtonIsUp();
        AStalePressStartsOver();
        AFullClickDoesNotBind();
        AFreshLookupGuardsEveryMove();
        TheExecutorPlacesHoverAndClickAndLeavesTheRestAlone();
        Console.WriteLine("pointer targets: ok");
    }

    private static void NoTargetAndNothingBoundIsTheOldPath()
    {
        var executor = new BrowserInputExecutor(new Probe(), () => throw new InvalidOperationException("no finder needed"));
        var request = Hover(100, 200);
        Assert(ReferenceEquals(executor.PlaceTarget(request), request), "a message with no target is returned as is");
        var click = Click(100, 200, pressed: true);
        Assert(ReferenceEquals(executor.PlaceTarget(click), click), "…a press with no target too (nothing builds)");
    }

    private static void ALandedCoordinateGoesAsSent()
    {
        var button = FakeNode.Control(origin: new(400, 300), size: new(200, 80));
        var placement = new PointerTargetPlacement(new Finder { [("Button")] = [button] });
        var at = placement.Place(new(450, 320), Target("Button", 50, 20), null, null);
        Assert(at == new Vector2(450, 320), $"the point lands on the button and goes as sent (got {at})");
        Assert(placement.Stats.Landed == 1 && placement.Stats.Moved == 0, "counted landed");
    }

    private static void AButtonMovedBeforeArrivalIsPlacedOnIt()
    {
        // The viewer tapped (450, 320), 50,20 into the button; by arrival the button slid 300 px right.
        var button = FakeNode.Control(origin: new(700, 300), size: new(200, 80));
        var placement = new PointerTargetPlacement(new Finder { ["Button"] = [button] });
        var at = placement.Place(new(450, 320), Target("Button", 50, 20), null, null);
        Assert(at == new Vector2(750, 320), $"the missed point moves onto the button at the same local point (got {at})");
        Assert(placement.Stats.Moved == 1, "counted moved");
    }

    private static void ARaisedCardsMappedCoordinateLands()
    {
        // A card drawn raised/enlarged on the page: the page already sends its game coordinate (the override inverse),
        // so the coordinate lands on the scaled-and-rotated holder and nothing moves.
        var holder = FakeNode.Control(new Transform2D(0.3f, new Vector2(1.2f, 1.2f), 0f, new Vector2(800, 700)), size: new(300, 420));
        var local = new Vector2(150, 210);
        var point = holder.CanvasTransform * local;
        var placement = new PointerTargetPlacement(new Finder { ["Holder"] = [holder] });
        var at = placement.Place(point, Target("Holder", local.X, local.Y), null, null);
        Assert(at == point, "a coordinate inside the rotated, scaled Control lands");
    }

    private static void ANode2DLandsWithinTolerance()
    {
        var sprite = FakeNode.CanvasItem(origin: new(100, 100));
        var placement = new PointerTargetPlacement(new Finder { ["Sprite"] = [sprite] });
        Assert(placement.Place(new(110.5f, 100), Target("Sprite", 10, 0), null, null) == new Vector2(110.5f, 100),
            "within 1 px of transform * local a CanvasItem lands");
        Assert(placement.Place(new(113, 100), Target("Sprite", 10, 0), null, null) == new Vector2(110, 100),
            "3 px off it is moved to transform * local");
    }

    private static void AmbiguousInstancesPickTheLandedOneOrNone()
    {
        var left = FakeNode.Control(origin: new(100, 500), size: new(200, 80));
        var right = FakeNode.Control(origin: new(400, 500), size: new(200, 80));
        var placement = new PointerTargetPlacement(new Finder { ["Option"] = [left, right] });
        Assert(placement.Place(new(450, 520), Target("Option", 50, 20), null, null) == new Vector2(450, 520)
               && placement.Stats.Landed == 1, "the instance the coordinate lands on wins");
        // Lands on neither (both moved): missing, never a guess.
        Assert(placement.Place(new(900, 900), Target("Option", 50, 20), null, null) == new Vector2(900, 900)
               && placement.Stats.Ambiguous == 1, "no landed instance: the coordinate, counted ambiguous");
        // Lands on both (overlapping instances): also refused.
        var over = FakeNode.Control(origin: new(420, 500), size: new(200, 80));
        var both = new PointerTargetPlacement(new Finder { ["Option"] = [right, over] });
        Assert(both.Place(new(450, 520), Target("Option", 50, 20), null, null) == new Vector2(450, 520)
               && both.Stats.Ambiguous == 1, "two landed instances: ambiguous, the coordinate");
    }

    private static void AFreedOrHiddenTargetFallsBackToTheCoordinate()
    {
        var button = FakeNode.Control(origin: new(700, 300), size: new(200, 80));
        var placement = new PointerTargetPlacement(new Finder { ["Button"] = [button] });
        button.Alive = false;
        Assert(placement.Place(new(450, 320), Target("Button", 50, 20), null, null) == new Vector2(450, 320),
            "a freed target: the coordinate");
        button.Alive = true;
        button.Visible = false;
        Assert(placement.Place(new(450, 320), Target("Button", 50, 20), null, null) == new Vector2(450, 320),
            "a hidden target: the coordinate");
        Assert(placement.Place(new(450, 320), Target("Nowhere", 50, 20), null, null) == new Vector2(450, 320),
            "an unresolved target: the coordinate");
        Assert(placement.Stats.Missing == 3, "each counted missing");
    }

    private static void APressBindsUntilEveryButtonIsUp()
    {
        // A slider handle moved 300 px right before the press arrived: the press moves +300, and every event of the
        // drag (hovers naming other nodes, a second button, the releases) moves by the same offset.
        var handle = FakeNode.Control(origin: new(700, 300), size: new(40, 40));
        var other = FakeNode.Control(origin: new(0, 0), size: new(2000, 2000));
        var placement = new PointerTargetPlacement(new Finder { ["Handle"] = [handle], ["Backdrop"] = [other] });
        Assert(placement.Place(new(410, 310), Target("Handle", 10, 10), true, "left") == new Vector2(710, 310), "the press moves");
        Assert(placement.Place(new(450, 330), Target("Backdrop", 450, 330), null, null) == new Vector2(750, 330),
            "a drag hover keeps the press's offset, whatever it names");
        Assert(placement.Place(new(460, 330), null, true, "right") == new Vector2(760, 330), "a chord's second press too");
        Assert(placement.Place(new(470, 330), null, false, "left") == new Vector2(770, 330), "the first release too");
        Assert(placement.Place(new(480, 330), null, null, "wheel-up") == new Vector2(780, 330), "a wheel tick mid-drag too");
        Assert(placement.Place(new(480, 330), null, false, "right") == new Vector2(780, 330), "the last release too");
        Assert(placement.Place(new(480, 330), Target("Backdrop", 480, 330), null, null) == new Vector2(480, 330),
            "after every button is up the binding is gone");
        // A press whose target is missing binds a zero offset: its drag stays where the finger is.
        Assert(placement.Place(new(10, 10), Target("Nowhere", 0, 0), true, "left") == new Vector2(10, 10), "unbound press");
        Assert(placement.Place(new(20, 20), Target("Handle", 10, 10), null, null) == new Vector2(20, 20),
            "its drag is not placed on another target");
        placement.Place(new(20, 20), null, false, "left");
    }

    private static void AStalePressStartsOver()
    {
        var handle = FakeNode.Control(origin: new(700, 300), size: new(40, 40));
        var placement = new PointerTargetPlacement(new Finder { ["Handle"] = [handle] });
        placement.Place(new(410, 310), Target("Handle", 10, 10), true, "left"); // its release never arrives
        handle.Origin = new Vector2(400, 300);
        Assert(placement.Place(new(410, 310), Target("Handle", 10, 10), true, "left") == new Vector2(410, 310),
            "a second press of a held button drops the stale binding and places afresh");
    }

    private static void AFullClickDoesNotBind()
    {
        var button = FakeNode.Control(origin: new(700, 300), size: new(200, 80));
        var placement = new PointerTargetPlacement(new Finder { ["Button"] = [button] });
        Assert(placement.Place(new(450, 320), Target("Button", 50, 20), null, "left") == new Vector2(750, 320), "a full click is placed");
        Assert(placement.Place(new(10, 10), null, null, null) == new Vector2(10, 10), "and binds nothing");
    }

    private static void AFreshLookupGuardsEveryMove()
    {
        // The cache knew one instance; a second one, under the point, appeared since. The would-be move asks again
        // and the fresh answer lands, so nothing moves onto the stale instance.
        var stale = FakeNode.Control(origin: new(100, 500), size: new(200, 80));
        var appeared = FakeNode.Control(origin: new(400, 500), size: new(200, 80));
        var finder = new Finder { ["Option"] = [stale] };
        finder.FreshAnswers["Option"] = [stale, appeared];
        var placement = new PointerTargetPlacement(finder);
        Assert(placement.Place(new(450, 520), Target("Option", 50, 20), null, null) == new Vector2(450, 520),
            "the fresh lookup finds the instance the point lands on");
        Assert(finder.FreshCalls == 1, "one fresh lookup");
        // A landed event never asks for a fresh lookup.
        placement.Place(new(150, 520), Target("Option", 50, 20), null, null);
        Assert(finder.FreshCalls == 1, "a landing needs no fresh lookup");
    }

    private static void TheExecutorPlacesHoverAndClickAndLeavesTheRestAlone()
    {
        var button = FakeNode.Control(origin: new(700, 300), size: new(200, 80));
        var probe = new Probe();
        var executor = new BrowserInputExecutor(probe, () => new Finder { ["Button"] = [button] });
        Assert(executor.Execute(Hover(450, 320) with { TargetScene = Scene, TargetPath = "Button", LocalX = 50, LocalY = 20 }) is null,
            "the hover runs");
        Assert(probe.Last is { Kind: SemanticActionKind.HoverElement, MouseX: 750, MouseY: 320 },
            $"the hover lands on the moved button (got {probe.Last?.MouseX},{probe.Last?.MouseY})");
        executor.Execute(Click(450, 320, true) with { TargetScene = Scene, TargetPath = "Button", LocalX = 50, LocalY = 20 });
        Assert(probe.Last is { Kind: SemanticActionKind.MouseClick, MouseX: 750, MousePressed: true }, "the press too");
        executor.Execute(Hover(460, 330));
        Assert(probe.Last is { MouseX: 760, MouseY: 330 }, "an untargeted drag hover keeps the binding");
        executor.Execute(Click(460, 330, false));
        Assert(probe.Last is { MouseX: 760, MousePressed: false }, "the release too");
        executor.Execute(Hover(10, 10));
        Assert(probe.Last is { MouseX: 10, MouseY: 10 }, "after the release an untargeted hover goes as sent");
        // A malformed target (no local) is no target.
        executor.Execute(Hover(450, 320) with { TargetScene = Scene, TargetPath = "Button" });
        Assert(probe.Last is { MouseX: 450 }, "half a target is ignored");
    }

    private static PointerTargetRef Target(string path, float x, float y) => new(Scene, path, new Vector2(x, y));

    private static BrowserInputRequestEnvelope Hover(double x, double y)
        => new("input", "h", BrowserInputKinds.Hover, CoordX: x, CoordY: y);

    private static BrowserInputRequestEnvelope Click(double x, double y, bool? pressed)
        => new("input", "c", BrowserInputKinds.Click, Button: "left", CoordX: x, CoordY: y, Pressed: pressed);

    private sealed class FakeNode : IPointerTargetNode
    {
        private Transform2D _xf;

        private FakeNode(Transform2D xf, Vector2? size)
        {
            _xf = xf;
            ControlSize = size;
        }

        public static FakeNode Control(Vector2 origin, Vector2 size) => new(new Transform2D(0f, origin), size);

        public static FakeNode Control(Transform2D xf, Vector2 size) => new(xf, size);

        public static FakeNode CanvasItem(Vector2 origin) => new(new Transform2D(0f, origin), null);

        public bool Alive { get; set; } = true;
        public bool Visible { get; set; } = true;

        public Vector2 Origin
        {
            set => _xf.Origin = value;
        }

        public bool IsAlive => Alive;
        public bool IsVisibleCanvasItem => Visible;
        public Transform2D CanvasTransform => _xf;
        public Vector2? ControlSize { get; }
    }

    private sealed class Finder : Dictionary<string, IPointerTargetNode[]>, IPointerTargetFinder
    {
        public Dictionary<string, IPointerTargetNode[]> FreshAnswers { get; } = new();
        public int FreshCalls { get; private set; }

        public IReadOnlyList<IPointerTargetNode> Find(string scene, string path, bool fresh)
        {
            if (scene != Scene) return [];
            if (fresh)
            {
                FreshCalls++;
                if (FreshAnswers.TryGetValue(path, out var answer)) return answer;
            }

            return TryGetValue(path, out var nodes) ? nodes : [];
        }
    }

    private sealed class Probe : ISemanticActionSource
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
            throw new Exception($"PointerTargetPlacementTests failed: {label}.");
        }
    }
}
