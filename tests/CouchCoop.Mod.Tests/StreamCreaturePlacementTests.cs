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
            CompanionFamiliesFollowTheField,
            CompanionReplacementUsesTheUnspreadOwner,
            LaterNativePassKeepsTheCompanionEndpoint,
            DisarmRestoresTheNewCompanionOffset,
            DisarmDuringCompanionTweenRetiresSpreadWrites,
            FirstSummonKeepsItsEndpointAcrossNestedPlacement,
            WuppyCallbacksUseNativeOwnersAndSurviveDisarm,
            RearmRetargetsAnUnfinishedCompanionTween,
            ExpiredCompanionTweenIsForgottenAcrossPlacementBoundaries,
            FinishedCompanionTweenIsRetiredBeforeItsParentExpires,
            CompanionHooksAreInertOutsideTheirScope,
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
        foreach (var binding in StreamCreaturePlacementPatch.CompanionBindings)
        {
            var method = StreamCreaturePlacementPatch.ResolveCompanion(binding);
            Assert(method is { IsPublic: true, IsStatic: false } && method.DeclaringType == typeof(NCreature)
                && method.ReturnType == typeof(void)
                && method.GetParameters().Select(p => p.ParameterType).SequenceEqual(binding.Parameters),
                $"{binding.Method} is a complete public typed companion target");
        }
        var tween = StreamCreaturePlacementPatch.ResolveMethodTween();
        Assert(tween is { IsPublic: true, IsStatic: false } && tween.ReturnType == typeof(MethodTweener),
            "callback placement uses a public engine registration target");
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

    private static void CompanionFamiliesFollowTheField()
    {
        var f = new Fixture();
        var companion = f.Companion();
        f.Arm(2340);
        f.Placement.Register([companion]);
        Equal(f.Node.Position, new(-487.5f, 200), "the owner follows the field with a companion");
        Equal(companion.Position, new(-219.375f, 200), "the companion follows its own field claim");
        f.Placement.SetWidth(1920);
        Equal(f.Node.Position, new(-400, 200), "the owner restores exactly");
        Equal(companion.Position, new(-180, 200), "the companion restores exactly");
    }

    private static void CompanionReplacementUsesTheUnspreadOwner()
    {
        var f = new Fixture();
        var companion = f.Companion();
        f.Arm(2340);
        f.Placement.Register([companion]);
        var tween = f.Replace(companion, new(280, -50));
        tween.Advance(1);
        Equal(companion.Position, new(-146.25f, 150), "endpoint is field(owner baseline + native offset)");
        Equal(f.Node.Position, new(-487.5f, 200), "owner remains spread after native computation");
    }

    private static void LaterNativePassKeepsTheCompanionEndpoint()
    {
        var f = new Fixture();
        var companion = f.Companion();
        f.Arm(2340);
        f.Placement.Register([companion]);
        var tween = f.Replace(companion, new(280, -50));
        tween.Advance(0.5f);
        f.Placement.BeginNative();
        var enemy = new Actor { Position = new(400, 220) };
        f.Placement.EndNative([enemy, companion, f.Node]);
        tween.Advance(1);
        Equal(companion.Position, new(-146.25f, 150), "a later addition cannot reinstate a pre-summon baseline");
    }

    private static void DisarmRestoresTheNewCompanionOffset()
    {
        var f = new Fixture();
        var companion = f.Companion();
        f.Arm(2340);
        f.Placement.Register([companion]);
        f.Replace(companion, new(220, 0)).Advance(1);
        f.Replace(companion, new(310, -50)).Advance(1);
        f.Placement.SetWidth(1920);
        Equal(companion.Position, new(-90, 150), "disarm restores the latest native endpoint");
    }

    private static void DisarmDuringCompanionTweenRetiresSpreadWrites()
    {
        var f = new Fixture();
        var companion = f.Companion();
        f.Arm(2340);
        f.Placement.Register([companion]);
        var tween = f.Replace(companion, new(280, -50));
        tween.Advance(0.5f);
        f.Placement.SetWidth(1920);
        Equal(companion.Position, new(-120, 150), "disarm restores the native endpoint mid-animation");
        foreach (var time in new[] { 0.6f, 0.9f, 1f })
        {
            tween.Advance(time);
            Equal(companion.Position, new(-120, 150), "no later tween step writes spread into the mirror");
        }
    }

    private static void FirstSummonKeepsItsEndpointAcrossNestedPlacement()
    {
        var f = new Fixture();
        f.Arm(2340);
        f.Placement.BeginNative(); // First addition owns the outer placement transaction.
        var companion = f.Companion();
        var tween = f.Replace(companion, new(280, -50));
        f.Placement.EndNative([f.Node, companion]);
        tween.Advance(1); // Even a zero-duration tween writes after the synchronous boundary.
        Equal(companion.Position, new(-146.25f, 150), "first summon endpoint uses the unspread owner");
        f.Placement.SetWidth(1920);
        tween.Advance(1);
        Equal(companion.Position, new(-120, 150), "the first pre-tween pose never replaces the native target");
    }

    private static void WuppyCallbacksUseNativeOwnersAndSurviveDisarm()
    {
        var f = new Fixture();
        var wuppy = f.Companion();
        f.Arm(2340);
        f.Placement.Register([wuppy]);
        foreach (var offset in new[] { 280f, 240f, 205f })
        {
            f.Placement.RunNative(wuppy, () => wuppy.Position = f.Node.Position + new Vector2(offset, 0));
            Equal(wuppy.Position, new Vector2((-400 + offset) * 2340 / 1920f, 200),
                "every native callback computes from the unspread owner before spreading the result");
        }
        f.Placement.BeginNative();
        f.Placement.EndNative([f.Node, wuppy]);
        Equal(wuppy.Position, new(-237.65625f, 200), "a later room pass keeps the current callback baseline");
        f.Placement.SetWidth(1920);
        Equal(wuppy.Position, new(-195, 200), "mid-animation disarm restores the current native callback pose");
        f.Placement.RunNative(wuppy, () => wuppy.Position = f.Node.Position + new Vector2(200, 0));
        Equal(wuppy.Position, new(-200, 200), "later callbacks continue natively in the mirror");
        Assert(!f.Placement.InNative, "inactive callbacks do not leave a native transaction open");
    }

    private static void RearmRetargetsAnUnfinishedCompanionTween()
    {
        var f = new Fixture();
        var companion = f.Companion();
        f.Arm(2340);
        f.Placement.Register([companion]);
        var old = f.Replace(companion, new(250, 0));
        var current = f.Replace(companion, new(280, -50));
        current.Advance(0.25f);
        f.Placement.SetWidth(1920);
        f.Arm(2340);
        f.Placement.Register([companion]);
        old.Advance(1);
        current.Advance(1);
        Equal(companion.Position, new(-146.25f, 150), "all unfinished position steps follow the new ownership");
        f.Placement.SetWidth(1920);
        old.Advance(1);
        current.Advance(1);
        Equal(companion.Position, new(-120, 150), "repeated swaps leave no spread endpoint behind");
    }

    private static void ExpiredCompanionTweenIsForgottenAcrossPlacementBoundaries()
    {
        var f = new Fixture();
        var companion = f.Companion();
        var baseline = f.Node.Position + new Vector2(280, -50);
        var old = new PositionTween(companion, companion.Position);
        var current = new PositionTween(companion, baseline);
        f.Placement.TrackEndpoint(companion, companion.Position, old.Hold);
        f.Placement.TrackEndpoint(companion, baseline, current.Hold);
        old.ParentExpired = true;

        f.Arm(2340);
        f.Placement.Register([companion]);
        Equal(f.Node.Position, new(-487.5f, 200), "the owner spreads despite an expired companion hold");
        Equal(companion.Position, new(-146.25f, 150), "arming uses the latest native companion target");
        Assert(old.HoldCalls == 1, "arming removes the expired hold after its first attempt");

        Assert(f.Placement.BeginNative(), "native placement still enters after the expired hold");
        Equal(f.Node.Position, new(-400, 200), "native placement reads the unspread owner");
        Equal(companion.Position, baseline, "native placement restores the companion endpoint");
        f.Placement.EndNative([f.Node, companion]);
        Equal(f.Node.Position, new(-487.5f, 200), "the owner spreads again after native placement");
        Equal(companion.Position, new(-146.25f, 150), "native placement preserves the latest companion target");
        Assert(!f.Placement.InNative, "an expired hold cannot strand a native transaction");

        f.Placement.SetWidth(1920);
        current.Advance(1);
        Equal(f.Node.Position, new(-400, 200), "disarm restores the owner");
        Equal(companion.Position, baseline, "the retained live step cannot write spread after disarm");
        Assert(old.HoldCalls == 1, "later placement and disarm never call the expired hold again");
        Assert(current.HoldCalls > 1, "the unfinished live hold remains available across boundaries");
        Assert(!f.Placement.InNative && !f.Placement.Wide, "disarm completes outside native and wide mode");
    }

    private static void CompanionHooksAreInertOutsideTheirScope()
    {
        var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
        var method = typeof(StreamCreaturePlacementPatch).GetMethod("BeforeMethodTween", flags)!;
        object?[] args = [default(Callable), default(Variant), default(Variant)];
        method.Invoke(null, args); // No Godot runtime is available; inspecting variants here would fail.
        var handler = typeof(StreamCreaturePlacementPatch).GetMethod("HandleTween", flags)!;
        object?[] propertyArgs = [null, null, default(Variant)];
        Assert(handler.Invoke(null, propertyArgs) is null, "outside companion scope the shared hook is inert");
    }

    private static void FinishedCompanionTweenIsRetiredBeforeItsParentExpires()
    {
        var f = new Fixture();
        var companion = f.Companion();
        f.Arm(2340);
        f.Placement.Register([companion]);
        var finished = f.Replace(companion, new(250, 0));
        var live = f.Replace(companion, new(280, -50));
        finished.Finish();
        var calls = finished.HoldCalls;
        Assert(f.Placement.BeginNative(), "native placement still reaches the unfinished step");
        f.Placement.EndNative([f.Node, companion]);
        f.Placement.SetWidth(1920);
        live.Advance(1);
        Equal(companion.Position, new(-120, 150), "the unfinished replacement still restores on disarm");
        Assert(finished.HoldCalls == calls, "a finished step is removed without probing its expired parent");
        live.Finish();
        var liveCalls = live.HoldCalls;
        f.Arm(2340);
        f.Placement.Register([companion]);
        Equal(companion.Position, new(-146.25f, 150), "completed tweens keep their native endpoint baseline");
        f.Placement.SetWidth(1920);
        Equal(companion.Position, new(-120, 150), "disarm needs no completed tween calls");
        Assert(live.HoldCalls == liveCalls && finished.HoldCalls == calls && !f.Placement.InNative,
            "both completed steps stay retired across rearm and disarm");
    }

    private sealed class PositionTween(Actor node, Vector2 target)
    {
        private Vector2? _from;
        private bool _held;
        internal bool ParentExpired;
        internal int HoldCalls;
        private Action? _finished;
        internal void OnFinished(Action retire) => _finished += retire;
        internal void Finish()
        {
            _finished?.Invoke();
            _finished = null;
            ParentExpired = true;
        }
        internal bool Hold(Vector2 position)
        {
            HoldCalls++;
            if (ParentExpired) return false;
            _from = position;
            _held = true;
            return true;
        }
        internal void Advance(float time)
        {
            _from ??= node.Position;
            node.Position = _held ? _from.Value : _from.Value.Lerp(target, time);
        }
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
            (n, p) => { Writes++; n.Position = p; }, n => n.Parent, n => n.LayoutParent, _ => Tracks++);
        internal Actor Companion()
        {
            var companion = new Actor { Owner = Node, Position = new(-180, 200) };
            Node.Companions.Add(companion);
            return companion;
        }
        internal PositionTween Replace(Actor companion, Vector2 offset)
        {
            Placement.BeginNative();
            var baseline = Node.Position + offset;
            var tween = new PositionTween(companion, Placement.Endpoint(companion, baseline));
            Placement.TrackEndpoint(companion, baseline, tween.Hold, tween.OnFinished);
            Placement.EndNative([companion]);
            return tween;
        }
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
