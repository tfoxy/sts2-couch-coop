using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.Core.Nodes.Combat;

internal static class StreamDesignPlacementTests
{
    internal static void Run()
    {
        Action[] tests =
        [
            TargetsResolve,
            WideTargetsUseDesignSizeAndAnchorSpread,
            HiddenRightTargetsStayOutsideThePresentation,
            MirrorAndStandardStreamsKeepTheirTargets,
            DisarmRestoresUnmodifiedTargets,
            RepeatedArmsUseTheCurrentWidth,
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"StreamDesignPlacementTests: {tests.Length} passed.");
    }

    internal static void TargetsResolve()
    {
        var bindings = StreamDesignPlacementPatch.Bindings;
        Assert(bindings.Count == 4 && bindings.Select(binding => binding.Type).Distinct()
            .ToHashSet().SetEquals([typeof(NEndTurnButton), typeof(NPingButton)]),
            "only the two viewport-normalized buttons are patched");
        foreach (var binding in bindings)
        {
            var target = StreamDesignPlacementPatch.Resolve(binding);
            Assert(target is { IsStatic: false, IsPrivate: true, IsSpecialName: true }
                && target.DeclaringType == binding.Type && target.ReturnType == typeof(Vector2)
                && target.GetParameters().Length == 0,
                $"{binding.Type.Name}.{binding.Property} resolves to its own position getter");
        }
    }

    private static void WideTargetsUseDesignSizeAndAnchorSpread()
    {
        var presentation = new HeadlessViewportConfigurator.Presentation((_, _) => true);
        foreach (var width in new[] { 2340, 2520, 2600 })
        foreach (var anchor in new[] { 0f, 0.5f, 1f })
        {
            presentation.SetStreamWidth(width);
            var target = new Vector2(0.8f * width, 830);
            var expected = new Vector2(0.8f * 1920 + anchor * (width - 1920), 830);
            Equal(presentation.ResolvePlacement(target, anchor), expected,
                "wide placement uses the design size and carries it by the control's anchor");
            Assert(presentation.ReassertMirror(), "wide presentation suppresses mirror re-assertion");
            Equal(presentation.ResolvePlacement(target, anchor), expected, "re-assert cannot change placement ownership");
        }
    }

    private static void HiddenRightTargetsStayOutsideThePresentation()
    {
        var presentation = new HeadlessViewportConfigurator.Presentation((_, _) => true);
        presentation.SetStreamWidth(2340);
        Equal(presentation.ResolvePlacement(new Vector2(1.1f * 2340, 830), 1), new Vector2(1.1f * 1920 + 420, 830),
            "a hidden target beyond the design edge stays beyond the wide right edge");
    }

    private static void MirrorAndStandardStreamsKeepTheirTargets()
    {
        var presentation = new HeadlessViewportConfigurator.Presentation((_, _) => true);
        var target = new Vector2(1989, 873);
        foreach (var width in new[] { 0, 1920 })
        {
            presentation.SetStreamWidth(width);
            Equal(presentation.ResolvePlacement(target, 1), target, "mirror and 16:9 targets pass through exactly");
        }
    }

    private static void DisarmRestoresUnmodifiedTargets()
    {
        var presentation = new HeadlessViewportConfigurator.Presentation((_, _) => true);
        presentation.SetStreamWidth(2340);
        presentation.SetStreamWidth(1920);
        var target = new Vector2(1638, 873);
        Equal(presentation.ResolvePlacement(target, 1), target, "disarm stops substituting the presentation size");
    }

    private static void RepeatedArmsUseTheCurrentWidth()
    {
        var presentation = new HeadlessViewportConfigurator.Presentation((_, _) => true);
        presentation.SetStreamWidth(2340);
        presentation.SetStreamWidth(1920);
        presentation.SetStreamWidth(2520);
        Equal(presentation.ResolvePlacement(new Vector2(0.8f * 2520, 830), 1), new Vector2(0.8f * 1920 + 600, 830),
            "a new arm replaces the previous presentation width");
    }

    private static void Equal(Vector2 actual, Vector2 expected, string message)
        => Assert(Math.Abs(actual.X - expected.X) < 0.001f && actual.Y == expected.Y,
            $"{message}: expected {expected}, got {actual}");

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
