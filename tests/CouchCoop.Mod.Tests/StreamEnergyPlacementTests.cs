using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Rooms;

internal static class StreamEnergyPlacementTests
{
    internal static void Run()
    {
        Action[] tests =
        [
            TargetsResolve,
            MirrorAndStandardStreamsNeverReadOrWrite,
            InactiveReadyNeverReadsGameState,
            WideOriginMatchesMirrorSpread,
            OriginClaimClampsToTheDesignField,
            DisarmRestoresBeforeMirrorSizing,
            RepeatedArmsAndWidthChangesDoNotCompound,
            NewCombatUiWhileWideIsAdjusted,
            LateReadyAfterDisarmDoesNothing,
            FreedContainersAreForgotten,
            RearmCapturesTheCurrentBaseline,
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"StreamEnergyPlacementTests: {tests.Length} passed.");
    }

    internal static void TargetsResolve()
    {
        var target = StreamEnergyPlacementPatch.Resolve();
        Assert(target is { IsStatic: false, IsPublic: true, IsVirtual: true }
            && target.DeclaringType == typeof(NCombatUi) && target.ReturnType == typeof(void)
            && target.GetParameters().Length == 0, "the hook targets the typed public combat UI ready override");
        Assert(typeof(NCombatUi).GetProperty(nameof(NCombatUi.EnergyCounterContainer)) is { PropertyType: var container }
            && container == typeof(Control), "the shared origin has typed access");
        Assert(typeof(NCombatRoom).GetProperty(nameof(NCombatRoom.Ui))?.PropertyType == typeof(NCombatUi),
            "arming an existing combat has typed UI access");
    }

    private static void MirrorAndStandardStreamsNeverReadOrWrite()
    {
        var f = new Fixture();
        foreach (var width in new[] { 0, 1080, 1920 })
        {
            f.Presentation.SetStreamWidth(width);
            f.Placement.Register(f.Container);
        }
        Assert(f.Container.Reads == 0 && f.Container.Writes == 0 && !f.Placement.Wide,
            "mirror and standard streams never touch the origin");
        var signedZero = BitConverter.Int32BitsToSingle(unchecked((int)0x80000000));
        Assert(BitConverter.SingleToInt32Bits(StreamEnergyPlacementPatch.Spread(signedZero, 1920))
            == BitConverter.SingleToInt32Bits(signedZero), "the inactive transform preserves bits");
    }

    private static void InactiveReadyNeverReadsGameState()
    {
        var ready = typeof(StreamEnergyPlacementPatch).GetMethod("AfterReady", BindingFlags.NonPublic | BindingFlags.Static)!
            .CreateDelegate<Action<NCombatUi>>();
        foreach (var width in new[] { 0, 1080, 1920 })
        {
            StreamEnergyPlacementPatch.SetWidth(width);
            ready(null!); // Any game or engine access fails in this game-free runner.
        }
    }

    private static void WideOriginMatchesMirrorSpread()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        Near(f.Container.Position.X, 121.875f, "the origin takes the mirror's positional claim");
        Near(f.Container.Position.X + 64, 185.875f, "the orb centre rides the origin without its own claim");
        Assert(f.Container.Position.Y == 828, "vertical placement stays exact");
        foreach (var width in new[] { 1921, 2520, 2600 })
        {
            f.Presentation.SetStreamWidth(width);
            Near(f.Container.Position.X, 100 * width / 1920f, "every wide width uses the same field");
        }
    }

    private static void OriginClaimClampsToTheDesignField()
    {
        Near(StreamEnergyPlacementPatch.Spread(-20, 2340), -20, "left of the field claims no extra width");
        Near(StreamEnergyPlacementPatch.Spread(0, 2340), 0, "left edge stays fixed");
        Near(StreamEnergyPlacementPatch.Spread(1920, 2340), 2340, "right edge claims the full width");
        Near(StreamEnergyPlacementPatch.Spread(2000, 2340), 2420, "beyond right claims no more than the extra width");
    }

    private static void DisarmRestoresBeforeMirrorSizing()
    {
        foreach (var width in new[] { 0, 1920 })
        {
            var f = new Fixture();
            var baseline = f.Container.Position;
            f.Presentation.SetStreamWidth(2340);
            f.BeforeSizing = expand =>
            {
                if (!expand) Assert(f.Container.Position == baseline && !f.Placement.Wide,
                    "the exact origin is restored before mirror sizing resumes");
            };
            f.Presentation.SetStreamWidth(width);
            f.Presentation.ReassertMirror();
            Assert(f.Container.Writes == 2, "disarm restores once and mirror reassert never rewrites it");
        }
    }

    private static void RepeatedArmsAndWidthChangesDoNotCompound()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        f.Presentation.SetStreamWidth(2340);
        f.Placement.Register(f.Container);
        Assert(f.Container.Reads == 1 && f.Container.Writes == 1, "repeat arm and ready do not capture a spread baseline");
        f.Presentation.SetStreamWidth(2520);
        Near(f.Container.Position.X, 131.25f, "a width change uses the original baseline");
        f.Presentation.SetStreamWidth(2340);
        Near(f.Container.Position.X, 121.875f, "shrinking while wide never compounds");
        Assert(f.Container.Reads == 1, "width changes do not recapture");
    }

    private static void NewCombatUiWhileWideIsAdjusted()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        var next = new Container(120);
        f.Placement.Register(next);
        Near(next.Position.X, 146.25f, "a new combat UI uses current ownership");
        next.Position = new Vector2(next.Position.X, 700);
        f.Presentation.SetStreamWidth(1920);
        Assert(next.Position == new Vector2(120, 700) && f.Container.Position.X == 100,
            "all live origins restore without overwriting vertical changes");
    }

    private static void LateReadyAfterDisarmDoesNothing()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        f.Presentation.SetStreamWidth(1920);
        var late = new Container(100);
        f.Placement.Register(late);
        Assert(late.Reads == 0 && late.Writes == 0, "a deferred ready callback obeys current ownership");
    }

    private static void FreedContainersAreForgotten()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        f.Container.Valid = false;
        var next = new Container(100);
        f.Placement.Register(next);
        f.Presentation.SetStreamWidth(2520);
        f.Presentation.SetStreamWidth(1920);
        Assert(f.Container.Writes == 1 && next.Writes == 3, "replacement, resizing and disarm skip freed origins");
        f.Container.Valid = true;
        f.Container.Position = new Vector2(150, 828);
        f.Presentation.SetStreamWidth(2340);
        f.Container.Valid = false;
        f.Presentation.SetStreamWidth(1920);
        Assert(!f.Placement.Wide, "disarm also skips invalid nodes without a replacement event");
    }

    private static void RearmCapturesTheCurrentBaseline()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        f.Presentation.SetStreamWidth(1920);
        f.Container.Position = new Vector2(150, 810);
        f.Presentation.SetStreamWidth(2520);
        Near(f.Container.Position.X, 196.875f, "rearm uses the latest baseline");
        f.Presentation.SetStreamWidth(1920);
        Assert(f.Container.Position == new Vector2(150, 810) && f.Container.Reads == 2,
            "each arm restores its own exact baseline");
    }

    private sealed class Container(float x)
    {
        internal Vector2 Position = new(x, 828);
        internal bool Valid = true;
        internal int Reads;
        internal int Writes;
    }

    private sealed class Fixture
    {
        internal readonly Container Container = new(100);
        internal readonly StreamEnergyPlacementPatch.Placement<Container> Placement;
        internal readonly HeadlessViewportConfigurator.Presentation Presentation;
        internal Action<bool>? BeforeSizing;

        internal Fixture()
        {
            Placement = new(node => node.Valid, node =>
            {
                Assert(node.Valid, "never read an invalid node");
                node.Reads++;
                return node.Position.X;
            }, (node, x) =>
            {
                Assert(node.Valid, "never write an invalid node");
                node.Writes++;
                node.Position = new Vector2(x, node.Position.Y);
            });
            HeadlessViewportConfigurator.Presentation? presentation = null;
            presentation = new((expand, _) => { BeforeSizing?.Invoke(expand); return true; }, wide =>
            {
                Placement.SetWidth(wide ? presentation!.StreamWidth : 1920);
                if (wide) Placement.Register(Container);
            });
            Presentation = presentation;
        }
    }

    private static void Near(float actual, float expected, string message)
        => Assert(Math.Abs(actual - expected) < 0.001f, $"{message}: expected {expected}, got {actual}");

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
