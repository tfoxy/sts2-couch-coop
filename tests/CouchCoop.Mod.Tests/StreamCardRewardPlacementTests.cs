using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;
using MegaCrit.Sts2.Core.Nodes.Screens.CardSelection;

internal static class StreamCardRewardPlacementTests
{
    internal static void Run()
    {
        Action[] tests = [TargetsResolve, ThreeAndFourCardsFollowTheField, ClampedClaimsAndScaledParents,
            InactivePrefixDoesNotTouchGodot, StandardOwnershipIsInert, DisarmRestoresExistingEndpoints,
            DisarmContinuesAfterAnExpiredParentTween,
            RerollDropsOldHolders, ScreenExitDropsRecords, ConstantInterpolationHoldsTheRestoredEndpoint,
            SharedHookRoutesScopedWriters, TweenOutsideRefreshTracksTheRewardRow,
            ArmingAnOpenScreenDiscoversMissingBaselines, FinishedTweenIsRetiredWithoutCallingFrom,
            FinishingAnOldTweenKeepsItsReplacement];
        foreach (var test in tests) test();
        Console.WriteLine($"StreamCardRewardPlacementTests: {tests.Length} passed.");
    }

    internal static void TargetsResolve()
    {
        var refresh = StreamCardRewardPlacementPatch.ResolveRefresh();
        Assert(refresh is { IsPublic: true, IsStatic: false } && refresh.ReturnType == typeof(void)
            && refresh.DeclaringType == typeof(NCardRewardSelectionScreen) && refresh.GetParameters().Length == 2,
            "public typed refresh resolves");
        var tween = StreamCardRewardPlacementPatch.ResolveTween();
        Assert(tween is { IsPublic: true, IsStatic: false } && tween.ReturnType == typeof(PropertyTweener)
            && tween.GetParameters().Select(p => p.ParameterType).SequenceEqual(
                new[] { typeof(GodotObject), typeof(NodePath), typeof(Variant), typeof(double) }),
            "public exact Godot registration resolves");
        Assert(typeof(PropertyTweener).GetMethod(nameof(PropertyTweener.From), [typeof(Variant)]) is { IsPublic: true }
            && typeof(PropertyTweener).GetMethod(nameof(PropertyTweener.SetCustomInterpolator), [typeof(Callable)])
                is { IsPublic: true }, "restore uses public native tween configuration");
        Assert(typeof(Tweener).GetEvent(nameof(Tweener.Finished)) is not null,
            "tween lifetime uses the public engine finished signal");
    }

    private static void ThreeAndFourCardsFollowTheField()
    {
        foreach (var count in new[] { 3, 4 })
        foreach (var width in new[] { 1920, 2340 })
        {
            var parent = new Transform2D(0, new Vector2(width / 2f, 600));
            var last = float.NaN;
            for (var i = 0; i < count; i++)
            {
                var x = (i - (count - 1) / 2f) * 350;
                var target = StreamCardRewardPlacementPatch.Spread(new(x, 7), parent, width);
                Near((parent * target).X, (960 + x) * width / 1920f, "each holder follows its own field claim");
                Near(target.Y, 7, "Y is unchanged");
                if (i > 0) Near(target.X - last, 350 * width / 1920f, "spacing scales with the field");
                last = target.X;
            }
        }
    }

    private static void ClampedClaimsAndScaledParents()
    {
        var parent = new Transform2D(new Vector2(1.1f, 0), new Vector2(0, 1.1f), new Vector2(1230, 500));
        foreach (var x in new[] { -1500f, -400, 0, 400, 1500 })
        {
            var point = new Vector2(x, 12);
            var before = parent * point;
            var q = before.X - 210;
            var actual = parent * StreamCardRewardPlacementPatch.Spread(point, parent, 2340);
            Near(actual.X, before.X + Math.Clamp(q, 0, 1920) * 0.21875f - 210,
                "claims use the actual parent transform, including an off-centre row");
            Near(actual.Y, before.Y, "canvas Y remains unchanged");
        }
    }

    private static void InactivePrefixDoesNotTouchGodot()
    {
        var prefix = typeof(StreamCardRewardPlacementPatch).GetMethod("BeforeTween", BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert(prefix.ReturnType == typeof(void), "prefix cannot suppress native registration");
        foreach (var width in new[] { 1920, 2340 })
        {
            StreamCardRewardPlacementPatch.SetWidth(width);
            object?[] args = [null, null, default(Variant), null];
            prefix.Invoke(null, args);
            Assert(args[3] is null, "non-holder calls read neither native objects nor variants");
        }
        StreamCardRewardPlacementPatch.SetWidth(1920);
    }

    private static void StandardOwnershipIsInert()
    {
        var calls = 0;
        var placement = new StreamCardRewardPlacementPatch.Placement<object, object>((_, _, _) => calls++);
        var screen = new object();
        placement.BeginRefresh(screen);
        placement.Track(screen, new object(), new(350, 0));
        foreach (var width in new[] { 0, 1080, 1920 }) placement.SetWidth(width);
        Assert(calls == 0 && !placement.Wide, "mirror and 16:9 ownership never place a holder");
        var value = new Vector2(BitConverter.Int32BitsToSingle(unchecked((int)0x80000000)), 23);
        var actual = StreamCardRewardPlacementPatch.Spread(value, Transform2D.Identity, 1920);
        Assert(BitConverter.SingleToInt32Bits(actual.X) == BitConverter.SingleToInt32Bits(value.X)
            && actual.Y == value.Y, "standard math preserves the original bits");
    }

    private static void DisarmRestoresExistingEndpoints()
    {
        var screen = new object();
        var holder = new object();
        var design = new Vector2(-350, 0);
        var current = new Vector2(-99, 0); // Any in-flight opening pose.
        var calls = 0;
        var placement = new StreamCardRewardPlacementPatch.Placement<object, object>((node, endpoint, width) =>
        {
            Assert(ReferenceEquals(node, holder) && endpoint == design, "restore keeps instance and original endpoint");
            calls++;
            current = endpoint;
        });
        placement.SetWidth(2340);
        placement.BeginRefresh(screen);
        placement.Track(screen, holder, design);
        placement.SetWidth(1920);
        Assert(current == design && calls == 1, "disarm restores synchronously, including an unfinished motion");
        placement.SetWidth(0);
        Assert(calls == 1, "repeated disarm is inert");
        placement.SetWidth(2340);
        placement.SetWidth(2340);
        placement.SetWidth(2520);
        placement.SetWidth(1920);
        Assert(calls == 4, "rearms and width changes always use the recorded design endpoint");
    }

    private static void DisarmContinuesAfterAnExpiredParentTween()
    {
        var screen = new object();
        var holders = new[] { new object(), new object(), new object() };
        var endpoints = new[] { new Vector2(-350, 0), new Vector2(0, 0), new Vector2(350, 0) };
        var tweeners = holders.ToDictionary(holder => holder, _ => new FakeTweener());
        var expired = tweeners[holders[1]];
        expired.ParentExpired = true;
        var written = new Dictionary<object, Vector2>();
        var placement = new StreamCardRewardPlacementPatch.Placement<object, object>((holder, endpoint, _) =>
            StreamCardRewardPlacementPatch.RestorePosition(holder, endpoint, tweeners,
                static (tweener, target) => tweener.From(target),
                static tweener => tweener.Frozen = true,
                (node, target) => written.Add(node, target)));
        placement.SetWidth(2340);
        placement.BeginRefresh(screen);
        for (var i = 0; i < holders.Length; i++) placement.Track(screen, holders[i], endpoints[i]);

        placement.SetWidth(1920);

        Assert(written.Count == 3, "an expired parent does not interrupt the remaining restores");
        for (var i = 0; i < holders.Length; i++)
            Assert(written[holders[i]] == endpoints[i], "every existing holder gets its recorded design endpoint");
        Assert(!tweeners.ContainsKey(holders[1]) && tweeners.Count == 2,
            "the expired parent drops only its tweener record");
        Assert(!expired.Frozen && tweeners.Values.All(tweener => tweener.Frozen),
            "only non-null From results receive the custom interpolator");
    }

    private sealed class FakeTweener
    {
        internal bool ParentExpired;
        internal bool Frozen;
        internal int FromCalls;
        private Action? _finished;
        internal void OnFinished(Action retire) => _finished += retire;
        internal void Finish()
        {
            _finished?.Invoke();
            _finished = null;
            ParentExpired = true;
        }
        internal FakeTweener? From(Vector2 _)
        {
            FromCalls++;
            return ParentExpired ? null : this;
        }
    }

    private static void RerollDropsOldHolders()
    {
        var placed = new List<object>();
        var placement = new StreamCardRewardPlacementPatch.Placement<object, object>((holder, _, _) => placed.Add(holder));
        var screen = new object();
        var old = new object();
        var replacement = new object();
        Assert(placement.BeginRefresh(screen), "first refresh installs exit subscription");
        placement.Track(screen, old, new(-350, 0));
        placement.SetWidth(2340);
        placed.Clear();
        Assert(!placement.BeginRefresh(screen), "reroll reuses the screen subscription");
        placement.Clear(screen);
        placement.Track(screen, replacement, new(525, 0));
        placement.SetWidth(1920);
        Assert(placed.SequenceEqual(new[] { replacement }), "only current choices restore after a reroll");
    }

    private static void ScreenExitDropsRecords()
    {
        var calls = 0;
        var placement = new StreamCardRewardPlacementPatch.Placement<object, object>((_, _, _) => calls++);
        var screen = new object();
        var holder = new object();
        placement.BeginRefresh(screen);
        placement.Track(screen, holder, new(350, 0));
        Assert(placement.Remove(screen).SequenceEqual(new[] { holder }), "exit supplies tween records to release");
        placement.SetWidth(2340);
        Assert(calls == 0, "no exited holder is touched");
        Assert(placement.BeginRefresh(screen), "re-entering a screen can subscribe again");
    }

    private static void ConstantInterpolationHoldsTheRestoredEndpoint()
    {
        var method = typeof(StreamCardRewardPlacementPatch).GetMethod("HoldInitial", BindingFlags.Static | BindingFlags.NonPublic)!;
        var interpolate = method.CreateDelegate<Func<double, double>>();
        foreach (var t in new[] { 0.0, 0.25, 0.9, 1.0 })
        {
            var restored = -350.0;
            var wideFinal = -426.5625;
            Near((float)(restored + (wideFinal - restored) * interpolate(t)), (float)restored,
                "native interpolation stays at the restored endpoint through the final step");
        }
    }

    private static void SharedHookRoutesScopedWriters()
    {
        var active = -1;
        var calls = new List<int>();
        StreamPositionTweenPatch.Handler Handler(int id)
            => (GodotObject _, NodePath _, ref Variant _) => active == id ? _ => calls.Add(id) : null;
        StreamPositionTweenPatch.Handler[] handlers = [Handler(0), Handler(1)];
        var target = default(Variant);
        Assert(StreamPositionTweenPatch.Dispatch(handlers, null!, null!, ref target) is null,
            "no active scope touches native tween registration");
        foreach (var scope in new[] { 0, 1, 0 })
        {
            active = scope;
            var complete = StreamPositionTweenPatch.Dispatch(handlers, null!, null!, ref target);
            complete!(null!);
        }
        Assert(calls.SequenceEqual(new[] { 0, 1, 0 }), "reward and companion handlers retain independent scopes");
        Assert(StreamCardRewardPlacementPatch.ResolveTween() == StreamPositionTweenPatch.Resolve(),
            "reward placement resolves the shared engine hook");
    }

    private static void TweenOutsideRefreshTracksTheRewardRow()
    {
        var screen = new object();
        var holder = new object();
        var other = new object();
        var members = new Dictionary<object, object>();
        var position = new Vector2(-350, 0);
        var parent = new Transform2D(0, new Vector2(1170, 600));
        var placement = new StreamCardRewardPlacementPatch.Placement<object, object>(
            (_, design, width) => position = StreamCardRewardPlacementPatch.Spread(design, parent, width),
            node => members.GetValueOrDefault(node));
        void Refresh() { placement.BeginRefresh(screen); members[holder] = screen; }
        Refresh();
        // Registration arrives after the synchronous refresh boundary has already returned.
        Assert(placement.TryTrackEndpoint(holder, position), "row membership records a tween outside refresh");
        Assert(!placement.TryTrackEndpoint(other, new(500, 0)), "unrelated grid holders are untouched");
        placement.SetWidth(2340);
        Near(position.X, -426.5625f, "the late endpoint follows the wide field");
        placement.SetWidth(1920);
        Assert(position == new Vector2(-350, 0), "disarm restores the recorded late endpoint");
    }

    private static void ArmingAnOpenScreenDiscoversMissingBaselines()
    {
        var screen = new object();
        var holder = new object();
        var position = new Vector2(350, 0);
        var reads = 0;
        var parent = new Transform2D(0, new Vector2(1170, 600));
        var placement = new StreamCardRewardPlacementPatch.Placement<object, object>(
            (_, design, width) => position = StreamCardRewardPlacementPatch.Spread(design, parent, width));
        placement.BeginRefresh(screen);
        placement.Discover(screen, [holder], _ => { reads++; return position; });
        placement.SetWidth(2340);
        Near(position.X, 426.5625f, "arming spreads settled holders without a recorded tween");
        placement.Discover(screen, [holder], _ => { reads++; return position; });
        placement.SetWidth(1920);
        Assert(position == new Vector2(350, 0) && reads == 1,
            "discovery never replaces a native baseline with a spread position");
        Assert(placement.Screens.SequenceEqual(new[] { screen }), "discovery covers the tracked open screen");
    }

    private static void FinishedTweenIsRetiredWithoutCallingFrom()
    {
        var holder = new object();
        var tweeners = new Dictionary<object, FakeTweener>();
        var tweener = new FakeTweener();
        StreamPositionTweenPatch.Track(tweeners, holder, tweener, tweener.OnFinished);
        tweener.Finish();
        var written = Vector2.Zero;
        StreamCardRewardPlacementPatch.RestorePosition(holder, new(350, 0), tweeners,
            (tween, target) => tween.From(target), tween => tween.Frozen = true,
            (_, target) => written = target);
        Assert(tweeners.Count == 0 && tweener.FromCalls == 0 && !tweener.Frozen,
            "a finished signal removes the tweener without calling From on its expired parent");
        Assert(written == new Vector2(350, 0), "finished holders still restore their recorded endpoint");
    }

    private static void FinishingAnOldTweenKeepsItsReplacement()
    {
        var holder = new object();
        var tweeners = new Dictionary<object, FakeTweener>();
        var old = new FakeTweener();
        var replacement = new FakeTweener();
        StreamPositionTweenPatch.Track(tweeners, holder, old, old.OnFinished);
        StreamPositionTweenPatch.Track(tweeners, holder, replacement, replacement.OnFinished);
        old.Finish();
        Assert(ReferenceEquals(tweeners[holder], replacement), "an old finished signal preserves the current tween");
        replacement.Finish();
        Assert(tweeners.Count == 0, "the replacement retires on its own finished signal");
    }

    private static void Near(float actual, float expected, string message)
        => Assert(Math.Abs(actual - expected) < 0.001f, $"{message}: expected {expected}, got {actual}");
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
