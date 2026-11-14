using CouchCoop.Mod.Session;
using MegaCrit.Sts2.Core.Nodes.Screens.Map;
using Layout = CouchCoop.Mod.Session.StreamMapDrawingToolsPatch.Layout;

internal static class StreamMapDrawingToolsTests
{
    internal static void Run()
    {
        Action[] tests =
        [
            TargetsResolve,
            MirrorAndStandardStreamsNeverReadOrWriteTheToolbar,
            WideToolbarMovesByHalfTheExtraWidth,
            DisarmRestoresEverySavedOffsetAndSizeBeforeMirrorSizing,
            RepeatedWideArmsDoNotCompoundTheAdjustment,
            NewMapsWhileWideAreAdjustedAndRestored,
            LateReadyAfterDisarmDoesNothing,
            FreedToolbarsAreSkippedAndForgotten,
            RearmCapturesTheCurrentBaseline,
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"StreamMapDrawingToolsTests: {tests.Length} passed.");
    }

    internal static void TargetsResolve()
    {
        var target = StreamMapDrawingToolsPatch.Resolve();
        Assert(target is { IsStatic: false, IsPublic: true, IsVirtual: true }
            && target.DeclaringType == typeof(NMapScreen) && target.ReturnType == typeof(void)
            && target.GetParameters().Length == 0, "the map ready hook resolves to its own public override");
    }

    private static void MirrorAndStandardStreamsNeverReadOrWriteTheToolbar()
    {
        var f = new Fixture();
        foreach (var width in new[] { 0, 1080, 1920 })
        {
            f.Presentation.SetStreamWidth(width);
            f.Placement.Register(f.Tools);
        }
        Assert(!f.Placement.Wide && f.Tools.Reads == 0 && f.Tools.Writes == 0,
            "unarmed and 16:9 seats never touch toolbar geometry");
    }

    private static void WideToolbarMovesByHalfTheExtraWidth()
    {
        foreach (var baseline in new[]
        {
            new Layout(0, 0, 56, 264), new Layout(0.25f, 0.25f, -440, -232),
            new Layout(0.5f, 0.5f, -904, -696), new Layout(1, 1, -1864, -1656),
        })
        foreach (var width in new[] { 1921, 2340, 2520, 2600 })
        {
            var f = new Fixture(baseline);
            var originalSize = f.Tools.Size;
            f.Presentation.SetStreamWidth(width);
            var actual = f.Tools.Layout;
            Near(actual.OffsetLeft, baseline.OffsetLeft + (width - 1920) / 2f, "left offset follows half delta");
            Near(actual.OffsetRight, baseline.OffsetRight + (width - 1920) / 2f, "right offset follows half delta");
            Assert(actual.AnchorLeft == baseline.AnchorLeft && actual.AnchorRight == baseline.AnchorRight,
                "both anchors are unchanged");
            Near(f.Tools.Size, originalSize, "rigid translation keeps the toolbar size");
        }
    }

    private static void DisarmRestoresEverySavedOffsetAndSizeBeforeMirrorSizing()
    {
        var baseline = new Layout(0, 0, 56, 264);
        foreach (var width in new[] { 0, 1920 })
        {
            var f = new Fixture(baseline);
            var originalSize = f.Tools.Size;
            f.Presentation.SetStreamWidth(2340);
            f.BeforeSizing = expand =>
            {
                if (!expand)
                {
                    Assert(f.Tools.Layout == baseline && !f.Placement.Wide,
                        "anchors and offsets restore before mirror sizing and work can resume");
                    Near(f.Tools.Size, originalSize, "size restores before mirror sizing");
                }
            };
            f.Presentation.SetStreamWidth(width);
            Assert(f.Tools.Layout == baseline && f.Tools.Writes == 2, "disarm restores the exact captured layout once");
            Near(f.Tools.Size, 208, "the restored toolbar has its baseline width");
            f.Presentation.ReassertMirror();
            f.Placement.Register(f.Tools);
            Assert(f.Tools.Writes == 2, "mirror reassert and later ready callbacks cannot reapply the shift");
            Near(f.Tools.Size, originalSize, "mirror reassert preserves the restored size");
        }
    }

    private static void RepeatedWideArmsDoNotCompoundTheAdjustment()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        var centered = f.Tools.Layout;
        f.Presentation.SetStreamWidth(2340);
        f.Placement.Register(f.Tools);
        Assert(f.Tools.Layout == centered && f.Tools.Reads == 1 && f.Tools.Writes == 1,
            "the same width and repeated ready notifications do not rewrite the toolbar");
        f.Presentation.SetStreamWidth(2520);
        Near(f.Tools.Layout.OffsetLeft, 340, "a new width recomputes half delta from the saved baseline");
        Near(f.Tools.Size, 230, "wide resize keeps the toolbar size");
        Assert(f.Tools.Reads == 1 && f.Tools.Writes == 2, "wide resize reuses the baseline");
        f.Presentation.SetStreamWidth(2340);
        Assert(f.Tools.Layout == centered, "shrinking while wide does not compound offsets");
    }

    private static void NewMapsWhileWideAreAdjustedAndRestored()
    {
        var f = new Fixture();
        var original = f.Tools.Layout;
        f.Presentation.SetStreamWidth(2340);
        var second = new Tools(new Layout(0, 0, 57, 287));
        var secondOriginal = second.Layout;
        f.Placement.Register(second);
        Near(second.Layout.AnchorLeft * 2340 + second.Layout.OffsetLeft, 267, "a map ready during a wide arm gets half delta");
        f.Presentation.SetStreamWidth(1920);
        Assert(f.Tools.Layout == original && second.Layout == secondOriginal,
            "all still-live toolbar baselines restore across a map replacement");
    }

    private static void LateReadyAfterDisarmDoesNothing()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        var late = new Tools(new Layout(0, 0, 65, 295));
        f.Presentation.SetStreamWidth(1920);
        f.Placement.Register(late);
        Assert(late.Reads == 0 && late.Writes == 0, "a deferred map-ready callback observes the current ownership gate");
    }

    private static void FreedToolbarsAreSkippedAndForgotten()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        f.Tools.Valid = false;
        var replacement = new Tools(new Layout(0, 0, 70, 300));
        f.Placement.Register(replacement);
        f.Presentation.SetStreamWidth(1920);
        Assert(f.Tools.Writes == 1 && replacement.Writes == 2, "replacement and disarm never touch freed nodes");

        f.Tools.Valid = true;
        var baseline = new Layout(0, 0, 80, 310);
        f.Tools.Layout = baseline;
        f.Presentation.SetStreamWidth(2520);
        f.Presentation.SetStreamWidth(1920);
        Assert(f.Tools.Layout == baseline, "expired snapshots are discarded");

        f.Presentation.SetStreamWidth(2340);
        f.Tools.Valid = false;
        f.Presentation.SetStreamWidth(1920);
        Assert(!f.Placement.Wide, "disarm also skips a freed node without a replacement event");
    }

    private static void RearmCapturesTheCurrentBaseline()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        f.Presentation.SetStreamWidth(1920);
        var baseline = new Layout(0.5f, 0.5f, -700, -470);
        f.Tools.Layout = baseline;
        f.Presentation.SetStreamWidth(2520);
        Near(f.Tools.Layout.OffsetLeft, -400, "rearm uses the latest design position");
        f.Presentation.SetStreamWidth(1920);
        Assert(f.Tools.Layout == baseline && f.Tools.Reads == 2, "each arm owns a fresh snapshot");
    }

    private sealed class Tools(Layout layout)
    {
        internal Layout Layout = layout;
        internal int ViewportWidth = 1920;
        internal float Size => (Layout.AnchorRight - Layout.AnchorLeft) * ViewportWidth + Layout.OffsetRight - Layout.OffsetLeft;
        internal bool Valid = true;
        internal int Reads;
        internal int Writes;
    }

    private sealed class Fixture
    {
        internal readonly Tools Tools;
        internal readonly StreamMapDrawingToolsPatch.Placement<Tools> Placement;
        internal readonly HeadlessViewportConfigurator.Presentation Presentation;
        internal Action<bool>? BeforeSizing;

        internal Fixture(Layout? baseline = null)
        {
            Tools = new Tools(baseline ?? new Layout(0, 0, 40, 270));
            Placement = new(node => node.Valid, node =>
            {
                Assert(node.Valid, "never read an invalid node");
                node.Reads++;
                return node.Layout;
            }, (node, layout) =>
            {
                Assert(node.Valid, "never write an invalid node");
                node.Writes++;
                node.Layout = layout;
            });
            HeadlessViewportConfigurator.Presentation? presentation = null;
            presentation = new((expand, width) =>
            {
                BeforeSizing?.Invoke(expand);
                Tools.ViewportWidth = width;
                return true;
            }, wide =>
            {
                Placement.SetWidth(wide ? presentation!.StreamWidth : 1920);
                if (wide) Placement.Register(Tools);
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
