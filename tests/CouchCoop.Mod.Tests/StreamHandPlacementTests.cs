using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.Core.Nodes.Cards.Holders;
using MegaCrit.Sts2.Core.Nodes.Combat;

internal static class StreamHandPlacementTests
{
    internal static void Run()
    {
        Action[] tests =
        [
            TargetsResolve,
            MirrorAndStandardStreamsKeepTargets,
            InactivePrefixPreservesArgumentBitsAndCannotSkipOriginal,
            CompleteFanTargetsFollowTheSpreadField,
            TargetsBeyondTheDesignFieldClampTheClaim,
            OnlyTheActualFanParentQualifies,
            FocusAndNeighbourOffsetsSpreadTogether,
            DisarmRegeneratesBeforeMirrorSizing,
            RepeatedArmsDoNotCompoundAndUseTheCurrentHand,
            NewFanTargetsAndReturningCardsUseCurrentOwnership,
        ];
        foreach (var test in tests) test();
        Console.WriteLine($"StreamHandPlacementTests: {tests.Length} passed.");
    }

    internal static void TargetsResolve()
    {
        var target = StreamHandPlacementPatch.Resolve();
        Assert(target is { IsStatic: false, IsPublic: true } && target.ReturnType == typeof(void)
            && target.DeclaringType == typeof(NHandCardHolder)
            && target.GetParameters() is [{ ParameterType: var parameter }] && parameter == typeof(Vector2),
            "the prefix targets the typed holder position setter");
        Assert(typeof(NPlayerHand).GetMethod(nameof(NPlayerHand.ForceRefreshCardIndices), Type.EmptyTypes)
            is { IsPublic: true, IsStatic: false, ReturnType: var result } && result == typeof(void),
            "the public regeneration entry point resolves");
        Assert(typeof(NPlayerHand).GetProperty(nameof(NPlayerHand.CardHolderContainer))?.PropertyType == typeof(Control)
            && typeof(NHandCardHolder).GetProperty(nameof(NHandCardHolder.TargetPosition))?.PropertyType == typeof(Vector2),
            "the fan restriction and synchronous restore have typed access");
    }

    private static void MirrorAndStandardStreamsKeepTargets()
    {
        var calls = 0;
        var placement = new StreamHandPlacementPatch.Placement(_ => calls++);
        var fan = new object();
        foreach (var width in new[] { 0, 1080, 1920 })
        {
            placement.SetWidth(width);
            var target = new Vector2(-387.25f, -100);
            Equal(placement.ResolveTarget(target, fan, fan), target, "16:9 and mirror targets are exact");
        }
        Assert(calls == 0, "mirror and standard stream ownership never regenerates the hand");
    }

    private delegate void TargetPrefix(NHandCardHolder holder, ref Vector2 target);

    private static void InactivePrefixPreservesArgumentBitsAndCannotSkipOriginal()
    {
        var method = typeof(StreamHandPlacementPatch).GetMethod("BeforeTarget", BindingFlags.NonPublic | BindingFlags.Static)!;
        Assert(method.ReturnType == typeof(void) && method.GetParameters().All(p => p.Name != "__runOriginal"),
            "the installed void prefix cannot skip the original");
        var prefix = method.CreateDelegate<TargetPrefix>();
        var error = Console.Error;
        using var trace = new StringWriter();
        try
        {
            Console.SetError(trace);
            foreach (var width in new[] { 0, 1080, 1920 })
            {
                StreamHandPlacementPatch.SetWidth(width);
                foreach (var target in new[]
                {
                    new Vector2(-387.25f, -100),
                    new Vector2(BitConverter.Int32BitsToSingle(unchecked((int)0x80000000)), 0),
                    new Vector2(BitConverter.Int32BitsToSingle(0x7fc12345), float.NegativeInfinity),
                })
                {
                    var actual = target;
                    // Null makes any attempted game read fail; call the actual installed prefix.
                    prefix(null!, ref actual);
                    Assert(BitConverter.SingleToInt32Bits(actual.X) == BitConverter.SingleToInt32Bits(target.X)
                        && BitConverter.SingleToInt32Bits(actual.Y) == BitConverter.SingleToInt32Bits(target.Y),
                        "the argument stays bit-identical, including signed zero and NaN payloads");
                }
            }
            Assert(trace.ToString().Length == 0, "an inactive call writes nothing");
        }
        finally { Console.SetError(error); }
    }

    private static void CompleteFanTargetsFollowTheSpreadField()
    {
        var placement = new StreamHandPlacementPatch.Placement(_ => { });
        var fan = new object();
        foreach (var width in new[] { 1921, 2340, 2520, 2600 })
        foreach (var localX in new[] { -960f, -570.5f, -200f, 0f, 190.75f, 600f, 960f })
        {
            placement.SetWidth(width);
            var actual = placement.ResolveTarget(new Vector2(localX, -87), fan, fan);
            Near(actual.X + width / 2f, (960 + localX) * width / 1920f, "global fan position matches spread");
            Assert(actual.Y == -87, "vertical fan geometry is unchanged");
        }
    }

    private static void TargetsBeyondTheDesignFieldClampTheClaim()
    {
        var placement = new StreamHandPlacementPatch.Placement(_ => { });
        var fan = new object();
        placement.SetWidth(2340);
        Equal(placement.ResolveTarget(new Vector2(-1100, 42), fan, fan), new Vector2(-1310, 42),
            "left of the field receives no positional claim");
        Equal(placement.ResolveTarget(new Vector2(1100, 42), fan, fan), new Vector2(1310, 42),
            "right of the field receives only the full extra width");
    }

    private static void OnlyTheActualFanParentQualifies()
    {
        var placement = new StreamHandPlacementPatch.Placement(_ => { });
        var fan = new object();
        var target = new Vector2(375, -120);
        placement.SetWidth(2340);
        foreach (var parent in new object?[] { null, new object(), "CardHolderContainer" })
        {
            Assert(!StreamHandPlacementPatch.IsFanHolder(parent, fan), "dragged, selected and unrelated parents fail identity");
            Equal(placement.ResolveTarget(target, parent, fan), target, "non-fan targets pass through unchanged");
        }
        Equal(placement.ResolveTarget(target, fan, null), target, "an unavailable fan never matches");
        Assert(!StreamHandPlacementPatch.IsFanHolder(null, null), "two missing parents do not qualify");
        Assert(StreamHandPlacementPatch.IsFanHolder(fan, fan), "only direct membership qualifies");
    }

    private static void FocusAndNeighbourOffsetsSpreadTogether()
    {
        var placement = new StreamHandPlacementPatch.Placement(_ => { });
        var fan = new object();
        placement.SetWidth(2340);
        Equal(placement.ResolveTarget(new Vector2(-320 - 80, -151), fan, fan), new Vector2(-487.5f, -151),
            "neighbour separation is part of the complete target");
        Equal(placement.ResolveTarget(new Vector2(160, -200), fan, fan), new Vector2(195, -200),
            "the focused card uses the same horizontal field and keeps its focused Y");
    }

    private static void DisarmRegeneratesBeforeMirrorSizing()
    {
        foreach (var width in new[] { 0, 1920 })
        {
            var f = new Fixture();
            f.Presentation.SetStreamWidth(2340);
            f.CurrentX = 999; // An in-flight pose must not survive swap-back.
            f.BeforeSizing = expand =>
            {
                if (!expand) Assert(!f.Placement.Wide && f.Target.X == f.DesignX && f.CurrentX == f.DesignX,
                    "fresh unspread targets and current X are restored before mirror resumes");
            };
            f.Presentation.SetStreamWidth(width);
            Assert(f.Regenerations == 2 && f.Restores == 1, "arm regenerates; disarm regenerates and restores once");
            f.Presentation.ReassertMirror();
            Assert(f.Regenerations == 2, "the existing mirror reassert never refreshes the hand");
        }
    }

    private static void RepeatedArmsDoNotCompoundAndUseTheCurrentHand()
    {
        var f = new Fixture();
        f.Presentation.SetStreamWidth(2340);
        var target = f.Target;
        f.Presentation.SetStreamWidth(2340);
        Equal(f.Target, target, "repeated ownership cannot multiply an already spread target");
        Assert(f.Regenerations == 1, "same width needs no regeneration");
        f.DesignX = -400; // A different hand/focus state arrived after arming.
        f.Presentation.SetStreamWidth(2520);
        Near(f.Target.X, -525, "a width change regenerates from current design targets");
        f.Presentation.SetStreamWidth(1920);
        Near(f.CurrentX, -400, "disarm restores the current hand, not the arm-time snapshot");
        f.Presentation.SetStreamWidth(2340);
        Near(f.Target.X, -487.5f, "rearm uses the new width without compounding");
    }

    private static void NewFanTargetsAndReturningCardsUseCurrentOwnership()
    {
        var f = new Fixture();
        var elsewhere = new object();
        f.Presentation.SetStreamWidth(2340);
        var target = new Vector2(400, -70);
        Equal(f.Placement.ResolveTarget(target, elsewhere, f.Fan), target, "a dragged card is not spread");
        Equal(f.Placement.ResolveTarget(target, f.Fan, f.Fan), new Vector2(487.5f, -70),
            "a returned or newly created fan card follows current ownership");
        f.Presentation.SetStreamWidth(1920);
        Equal(f.Placement.ResolveTarget(target, f.Fan, f.Fan), target, "later targets after disarm remain unspread");
    }

    private sealed class Fixture
    {
        internal readonly object Fan = new();
        internal readonly StreamHandPlacementPatch.Placement Placement;
        internal readonly HeadlessViewportConfigurator.Presentation Presentation;
        internal float DesignX = 300;
        internal float CurrentX;
        internal Vector2 Target;
        internal int Regenerations;
        internal int Restores;
        internal Action<bool>? BeforeSizing;

        internal Fixture()
        {
            Placement = new(restore =>
            {
                Regenerations++;
                Target = Placement!.ResolveTarget(new Vector2(DesignX, -80), Fan, Fan);
                if (restore) { CurrentX = Target.X; Restores++; }
            });
            HeadlessViewportConfigurator.Presentation? presentation = null;
            presentation = new((expand, _) => { BeforeSizing?.Invoke(expand); return true; },
                wide => Placement.SetWidth(wide ? presentation!.StreamWidth : 1920));
            Presentation = presentation;
        }
    }

    private static void Equal(Vector2 actual, Vector2 expected, string message)
    {
        Near(actual.X, expected.X, message);
        Assert(actual.Y == expected.Y, $"{message}: vertical position changed");
    }

    private static void Near(float actual, float expected, string message)
        => Assert(Math.Abs(actual - expected) < 0.001f, $"{message}: expected {expected}, got {actual}");

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
