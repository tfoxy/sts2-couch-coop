using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.Core.Entities.Creatures;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Rooms;

internal static class StreamCreaturePlacementTests
{
    internal static void Run()
    {
        Action[] tests =
        [
            TargetsResolve,
            MirrorAndStandardStreamsAreIdentity,
            OriginsMatchTheClampedSpreadField,
            FixedPivotCameraCarriesTheCenteredContainerShift,
            CenteredAncestorShiftIsIndependentOfTeamScale,
            ParentRotationAndSkewPreserveCanvasY,
            RegistrationAndWidthChangesDoNotCompound,
            NativePlacementReplacesTheBaseline,
            PartialPlacementKeepsOtherBaselines,
            NestedNativePlacementStaysUnspreadUntilComplete,
            ResizeRunsNextFrameOnRestoredBaselines,
            ResizeCoalescesAndCancelRetiresOldWork,
            DisarmRestoresBeforeMirrorSizing,
            FreedAndExitingNodesAreForgotten,
            NewNodesUseCurrentOwnership,
            CompanionFamiliesRemainNativeWhileOthersSpread,
            CompanionAnimationSurvivesNativePassAndDisarm,
            FirstCompanionRetiresTheOwnersSpreadBaseline,
            RegistrationRestoresAnOwnerThatAcquiresACompanion,
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"StreamCreaturePlacementTests: {tests.Length} passed.");
    }

    internal static void TargetsResolve()
    {
        var bindings = StreamCreaturePlacementPatch.Bindings;
        Assert(bindings.Count == 6, "all placement, readiness, addition and resize targets are gated");
        foreach (var binding in bindings)
        {
            var method = StreamCreaturePlacementPatch.Resolve(binding);
            Assert(method is not null && method.DeclaringType == typeof(NCombatRoom)
                && method.IsStatic == binding.IsStatic && method.ReturnType == typeof(void)
                && method.GetParameters().Select(p => p.ParameterType).SequenceEqual(binding.Parameters),
                $"{binding.Method} resolves with its complete typed signature");
        }
        Assert(typeof(NCombatRoom).GetProperty(nameof(NCombatRoom.CreatureNodes))?.PropertyType == typeof(IEnumerable<NCreature>),
            "room membership has typed access");
        Assert(typeof(Creature).GetProperty(nameof(Creature.PetOwner))?.PropertyType == typeof(Player)
            && typeof(Creature).GetProperty(nameof(Creature.Pets))?.PropertyType == typeof(IReadOnlyList<Creature>),
            "companion ownership and membership have typed access");
        Assert(StreamCreaturePlacementPatch.Resolve(bindings[^1])!.CreateDelegate<Action<NCombatRoom>>() is not null,
            "the resize entry point can be called through a typed open delegate");
    }

    private static void MirrorAndStandardStreamsAreIdentity()
    {
        var f = new Fixture();
        foreach (var width in new[] { 0, 1080, 1920 })
        {
            f.Placement.SetWidth(width);
            f.Placement.Register([f.Node]);
            Assert(!f.Placement.BeginNative(), "inactive native calls do not enter a transaction");
            Equal(StreamCreaturePlacementPatch.Spread(f.Node.Position, f.Node.Parent, width, f.Node.LayoutParent), f.Node.Position,
                "inactive geometry is exactly unchanged");
        }
        Assert(f.Reads == 0 && f.Writes == 0 && f.Tracks == 0, "inactive ownership never reads game geometry");
    }

    private static void OriginsMatchTheClampedSpreadField()
    {
        foreach (var width in new[] { 1921, 2340, 2520, 2600 })
        foreach (var x in new[] { -150f, 0, 317.5f, 960, 1531.25f, 1920, 2070 })
        {
            var parent = new Transform2D(0, new Vector2(width / 2f, 300));
            var actual = parent * StreamCreaturePlacementPatch.Spread(new Vector2(x - 960, 200), parent, width, Transform2D.Identity);
            Near(actual.X, x + Math.Clamp(x, 0, 1920) * (width / 1920f - 1), "origin follows the old renderer field");
            Near(actual.Y, 500, "vertical placement is unchanged");
        }
    }

    private static void FixedPivotCameraCarriesTheCenteredContainerShift()
    {
        foreach (var scale in new[] { 0.65f, 0.9f, 1f, 1.4f })
        foreach (var offset in new[] { -170f, 0, 115f })
        {
            var pivot = new Vector2(960, 540);
            var camera = new Transform2D(new Vector2(scale, 0), new Vector2(0, scale),
                pivot * (1 - scale) + new Vector2(offset, 0));
            var designParent = camera * new Transform2D(0, new Vector2(960, 540));
            var wideParent = camera * new Transform2D(0, new Vector2(1170, 540));
            var baseline = new Vector2(-400, 210);
            var design = designParent * baseline;
            var actual = wideParent * StreamCreaturePlacementPatch.Spread(baseline, wideParent, 2340, camera);
            Near(actual.X, design.X + Math.Clamp(design.X, 0, 1920) * (2340 / 1920f - 1),
                "fixed-pivot camera carries the centred container's resize displacement");
            Near(actual.Y, (wideParent * baseline).Y, "camera Y and scale are preserved");
            if (scale == 0.9f && offset == 0) Near(actual.X, 731.25f, "scaled encounter control");
        }
    }

    private static void CenteredAncestorShiftIsIndependentOfTeamScale()
    {
        var f = new Fixture();
        var camera = new Transform2D(new Vector2(0.9f, 0), new Vector2(0, 0.9f), new Vector2(96, 54));
        var teamBasis = new Vector2(0.8f, 0);
        var designParent = camera * new Transform2D(teamBasis, new Vector2(0, 0.8f), new Vector2(960, 540));
        f.Node.LayoutParent = camera;
        f.Node.Parent = camera * new Transform2D(teamBasis, new Vector2(0, 0.8f), new Vector2(1170, 540));
        var design = designParent * f.Node.Position;
        var canvasY = (f.Node.Parent * f.Node.Position).Y;
        f.Arm(2340);
        var actual = f.Node.Parent * f.Node.Position;
        Near(actual.X, design.X * 2340 / 1920f, "the centring shift precedes the team's own scale");
        Near(actual.Y, canvasY, "team and camera scaling preserve canvas Y");
        f.Placement.SetWidth(1920);
        Equal(f.Node.Position, new Vector2(-400, 200), "scaled hierarchies restore the original local baseline");
    }

    private static void ParentRotationAndSkewPreserveCanvasY()
    {
        var parent = new Transform2D(new Vector2(0.8f, 0.2f), new Vector2(-0.3f, 1.1f), new Vector2(1235, 380));
        var baseline = new Vector2(380, 190);
        var before = parent * baseline;
        var after = parent * StreamCreaturePlacementPatch.Spread(baseline, parent, 2340, Transform2D.Identity);
        Near(after.X, (before.X - 210) * 2340 / 1920f, "the affine inverse converts back through both basis vectors");
        Near(after.Y, before.Y, "canvas Y stays fixed even when local Y must change");
    }

    private static void RegistrationAndWidthChangesDoNotCompound()
    {
        var f = new Fixture();
        f.Arm(2340);
        var first = f.Node.Position;
        f.Placement.Register([f.Node]);
        f.Placement.SetWidth(2340);
        Equal(f.Node.Position, first, "repeated registration never recaptures a spread position");
        f.Node.Parent = new Transform2D(0, new Vector2(1260, 300));
        f.Placement.SetWidth(2520);
        Equal(f.Node.Position, new Vector2(-525, 200), "a new width derives from the same unspread baseline");
        Assert(f.Tracks == 1, "one live node gets one lifetime subscription");
    }

    private static void NativePlacementReplacesTheBaseline()
    {
        var f = new Fixture();
        f.Arm(2340);
        for (var i = 0; i < 3; i++)
        {
            Assert(f.Placement.BeginNative(), "wide native writer enters a transaction");
            Equal(f.Node.Position, new Vector2(i == 0 ? -400 : -300, 200), "native reads see the previous unspread baseline");
            f.Node.Position = new Vector2(-300, 200);
            f.Placement.EndNative([f.Node]);
            Equal(f.Node.Position, new Vector2(-365.625f, 200), "repeated native layout replaces, never compounds");
        }
        f.Placement.SetWidth(1920);
        Equal(f.Node.Position, new Vector2(-300, 200), "disarm restores the latest native placement");
    }

    private static void PartialPlacementKeepsOtherBaselines()
    {
        var f = new Fixture();
        var other = new Actor { Position = new Vector2(400, 220), Parent = f.Node.Parent };
        f.Arm(2340);
        f.Placement.Register([other]);
        var expectedOther = other.Position;
        f.Placement.BeginNative();
        f.Node.Position = new Vector2(-250, 200);
        f.Placement.EndNative([f.Node]);
        Equal(other.Position, expectedOther, "a writer for one team preserves the other team's baseline");
        f.Placement.SetWidth(1920);
        Equal(other.Position, new Vector2(400, 220), "untouched actors restore exactly");
    }

    private static void NestedNativePlacementStaysUnspreadUntilComplete()
    {
        var f = new Fixture();
        f.Arm(2340);
        f.Placement.BeginNative(); // Room readiness or addition.
        f.Placement.BeginNative(); // A nested team writer.
        f.Node.Position = new Vector2(-350, 200);
        f.Placement.EndNative([f.Node]);
        Equal(f.Node.Position, new Vector2(-350, 200), "nested writer leaves design geometry for later native reads");
        f.Node.Parent = new Transform2D(new Vector2(0.8f, 0), new Vector2(0, 0.8f), new Vector2(1200, 330));
        f.Placement.EndNative([f.Node]);
        var canvas = f.Node.Parent * f.Node.Position;
        Near(canvas.X, (1200 - 280 - 210) * 2340 / 1920f, "spread uses the final encounter camera transform");
        Assert(!f.Placement.InNative, "the outer boundary releases native mode");
    }

    private static void ResizeRunsNextFrameOnRestoredBaselines()
    {
        var f = new Fixture();
        var frames = new Queue<Action>();
        var calls = 0;
        var resize = new StreamCreaturePlacementPatch.DeferredResize<Actor>(frames.Enqueue, node =>
        {
            f.Placement.BeginNative();
            Equal(node.Position, new Vector2(-400, 200), "aspect bounds are measured on native positions");
            node.Parent = new Transform2D(new Vector2(0.75f, 0), new Vector2(0, 0.75f), new Vector2(1250, 300));
            f.Placement.EndNative([node]);
            calls++;
        });
        f.Arm(2340);
        var reads = f.Reads;
        resize.Queue(f.Node);
        Assert(calls == 0 && f.Reads == reads, "the size signal only schedules, with no geometry read");
        frames.Dequeue()();
        Near((f.Node.Parent * f.Node.Position).X, (1250 - 300 - 210) * 2340 / 1920f,
            "deferred work uses the new full parent transform");
        Assert(calls == 1, "one frame runs the signalled work once");
    }

    private static void ResizeCoalescesAndCancelRetiresOldWork()
    {
        var frames = new Queue<Action>();
        var calls = 0;
        var resize = new StreamCreaturePlacementPatch.DeferredResize<object>(frames.Enqueue, _ => calls++);
        var room = new object();
        resize.Queue(room);
        resize.Queue(room);
        Assert(frames.Count == 1, "multiple size events coalesce for a room");
        resize.Cancel();
        resize.Queue(room);
        frames.Dequeue()();
        Assert(calls == 0, "a queued old arm cannot read or write after disarm/rearm");
        frames.Dequeue()();
        Assert(calls == 1, "the new arm retains its own queued work");
    }

    private static void DisarmRestoresBeforeMirrorSizing()
    {
        var f = new Fixture();
        HeadlessViewportConfigurator.Presentation? presentation = null;
        presentation = new((wide, _) =>
        {
            if (!wide)
            {
                Assert(!f.Placement.Wide, "wide geometry is disabled before mirror resize");
                Equal(f.Node.Position, new Vector2(-400, 200), "baseline is restored before mirror resumes");
            }
            return true;
        }, wide =>
        {
            f.Placement.SetWidth(wide ? presentation!.StreamWidth : 1920);
            if (wide) f.Placement.Register([f.Node]);
        });
        presentation.SetStreamWidth(2340);
        presentation.SetStreamWidth(0);
        var writes = f.Writes;
        presentation.ReassertMirror();
        Assert(writes == f.Writes, "the existing mirror reassert does not reposition creatures");
    }

    private static void FreedAndExitingNodesAreForgotten()
    {
        var f = new Fixture();
        f.Arm(2340);
        f.Node.Valid = false;
        f.Placement.SetWidth(1920);
        Assert(f.Writes == 1, "freed nodes are never restored");
        f.Node.Valid = true;
        f.Node.Position = new Vector2(-400, 200);
        f.Arm(2340);
        f.Placement.Forget(f.Node);
        var writes = f.Writes;
        f.Placement.SetWidth(1920);
        Assert(f.Writes == writes, "tree exit releases the saved reference");
    }

    private static void NewNodesUseCurrentOwnership()
    {
        var f = new Fixture();
        f.Arm(2340);
        var added = new Actor { Position = new Vector2(300, 190), Parent = f.Node.Parent };
        f.Placement.BeginNative();
        f.Placement.EndNative([f.Node, added]);
        Equal(added.Position, new Vector2(365.625f, 190), "late additions spread their native positions");
        f.Placement.SetWidth(1920);
        Equal(added.Position, new Vector2(300, 190), "late additions restore on disarm too");
    }

    private static void CompanionFamiliesRemainNativeWhileOthersSpread()
    {
        var f = new Fixture();
        var companion = new Actor { Owner = f.Node, Position = new Vector2(-180, 200) };
        f.Node.Companions.Add(companion);
        var other = new Actor { Position = new Vector2(400, 220) };
        f.Arm(2340);
        f.Placement.Register([companion, other]);
        Equal(f.Node.Position, new Vector2(-400, 200), "a companion owner keeps its native position while wide");
        Equal(companion.Position, new Vector2(-180, 200), "companions are excluded from the spread too");
        Equal(other.Position, new Vector2(487.5f, 220), "unrelated creatures still follow the spread field");
        Assert(f.Tracks == 1 && f.Reads == 1, "only independent creatures acquire baseline ownership");
        f.Placement.SetWidth(1920);
        Equal(f.Node.Position, new Vector2(-400, 200), "disarm leaves the native owner untouched");
        Equal(companion.Position, new Vector2(-180, 200), "disarm leaves the native companion untouched");
        Equal(other.Position, new Vector2(400, 220), "other creatures still restore normally");
    }

    private static void CompanionAnimationSurvivesNativePassAndDisarm()
    {
        var f = new Fixture();
        var companion = new Actor { Owner = f.Node, Position = new Vector2(-180, 200) };
        f.Node.Companions.Add(companion);
        f.Arm(2340);
        f.Placement.Register([companion]);
        var target = f.Node.Position + new Vector2(280, -50);
        companion.Position = companion.Position.Lerp(target, 0.5f);
        var midAnimation = companion.Position;
        f.Placement.BeginNative();
        Equal(companion.Position, midAnimation, "a later native pass never restores an obsolete companion pose");
        f.Placement.EndNative([f.Node, companion]);
        Equal(companion.Position, midAnimation, "native pass completion does not spread a companion animation");
        f.Placement.SetWidth(1920);
        Equal(companion.Position, midAnimation, "disarm preserves the current native animation pose");
        companion.Position = target;
        Equal(companion.Position, new Vector2(-120, 150), "an in-flight endpoint remains native after disarm");
        Assert(f.Reads == 0 && f.Writes == 0 && f.Tracks == 0,
            "companion families never enter the baseline protocol");
    }

    private static void FirstCompanionRetiresTheOwnersSpreadBaseline()
    {
        var f = new Fixture();
        f.Arm(2340);
        Equal(f.Node.Position, new Vector2(-487.5f, 200), "an independent player initially spreads");
        f.Placement.BeginNative();
        var companion = new Actor { Owner = f.Node, Position = new Vector2(-180, 200) };
        f.Node.Companions.Add(companion);
        var target = f.Node.Position + new Vector2(280, -50);
        var other = new Actor { Position = new Vector2(400, 220) };
        f.Placement.EndNative([f.Node, companion, other]);
        Equal(f.Node.Position, new Vector2(-400, 200), "first companion leaves its owner native before a tween runs");
        Equal(other.Position, new Vector2(487.5f, 220), "late independent additions still spread");
        companion.Position = target;
        f.Placement.BeginNative();
        f.Placement.EndNative([f.Node, companion, other]);
        Equal(companion.Position, new Vector2(-120, 150), "later native placement preserves the new companion offset");
        f.Placement.SetWidth(1920);
        Equal(companion.Position, new Vector2(-120, 150), "disarm cannot restore a pre-summon companion baseline");
        Equal(f.Node.Position, new Vector2(-400, 200), "disarm cannot reinstate owner spread");
    }

    private static void RegistrationRestoresAnOwnerThatAcquiresACompanion()
    {
        var f = new Fixture();
        f.Arm(2340);
        var companion = new Actor { Owner = f.Node, Position = new Vector2(-180, 200) };
        f.Node.Companions.Add(companion);
        f.Placement.Register([f.Node, companion]);
        Equal(f.Node.Position, new Vector2(-400, 200), "registration restores a previously tracked owner's native baseline");
        var writes = f.Writes;
        companion.Position = new Vector2(-120, 150);
        f.Placement.SetWidth(2520);
        f.Placement.SetWidth(1920);
        Assert(f.Writes == writes, "excluded families remain outside subsequent width and disarm writes");
        Equal(companion.Position, new Vector2(-120, 150), "native companion updates are never recaptured");
    }

    private sealed class Actor
    {
        internal bool Valid = true;
        internal Actor? Owner;
        internal readonly List<Actor> Companions = [];
        internal Vector2 Position = new(-400, 200);
        internal Transform2D LayoutParent = Transform2D.Identity;
        internal Transform2D Parent = new(0, new Vector2(1170, 300));
    }

    private sealed class Fixture
    {
        internal readonly Actor Node = new();
        internal readonly StreamCreaturePlacementPatch.Placement<Actor> Placement;
        internal int Reads, Writes, Tracks;
        internal Fixture() => Placement = new(n => n.Valid, n => { Reads++; return n.Position; },
            (n, p) => { Writes++; n.Position = p; }, n => n.Parent, n => n.LayoutParent, _ => Tracks++,
            n => n.Owner is null && n.Companions.Count == 0);
        internal void Arm(int width) { Placement.SetWidth(width); Placement.Register([Node]); }
    }

    private static void Equal(Vector2 actual, Vector2 expected, string message)
    {
        Near(actual.X, expected.X, message);
        Near(actual.Y, expected.Y, message);
    }
    private static void Near(float actual, float expected, string message)
        => Assert(Math.Abs(actual - expected) < 0.001f, $"{message}: expected {expected}, got {actual}");
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
