using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

// The planner is generic over the window handle so this runner, which has no engine, never constructs a Godot
// object. Facts are listed in tree order — parents before their children — as FindChildren returns them.
internal static class RootWindowEmbeddingGuardTests
{
    private sealed record TestWindow(string Name);

    public static void Run()
    {
        TheLogWindowPatternHidesNothingAndKeepsTheNewWindowNative();
        ADisplayedNativeWindowIsHiddenMadeNativeAndShownAgain();
        NestedWindowsHideDeepestFirstAndShowParentsFirst();
        PopupsAreOnlyHidden();
        EmbeddedAndHiddenWindowsAreLeftAlone();
        AHeadlessSeatKeepsWindowsHiddenAndNeverMakesThemNative();
        OnlyAWindowHoldingTheMainIdTakesTheRootInputBack();
        TheBreakerAdmitsFiveRepairsAMinuteThenStaysTripped();
        SpacedRepairsNeverTripTheBreaker();
        Console.WriteLine("RootWindowEmbeddingGuardTests: ok");
    }

    // BaseLib: embedding off, then its window is added while still hidden. Nothing is displayed, so nothing needs
    // hiding, and the new window is made native before its owner shows it.
    private static void TheLogWindowPatternHidesNothingAndKeepsTheNewWindowNative()
    {
        var log = new TestWindow("log");
        var plan = Plan(desktop: true, Facts(log, trigger: true));

        Assert(plan.Hide.Count == 0, "a hidden new window needs no hide");
        Assert(plan.MakeNative.SequenceEqual([log]), "the new window stays a separate OS window");
        Assert(plan.Reshow.Count == 0, "the owner shows its own window; the guard does not");
        Assert(plan.KeepHidden.Count == 0 && !plan.RestoreRootInput, "no headless steps on a desktop");
    }

    private static void ADisplayedNativeWindowIsHiddenMadeNativeAndShownAgain()
    {
        var tool = new TestWindow("tool");
        var plan = Plan(desktop: true, Facts(tool, visible: true));

        Assert(plan.Hide.SequenceEqual([tool]), "a displayed native window blocks the flip, so it is hidden");
        Assert(plan.MakeNative.SequenceEqual([tool]), "and it is kept native");
        Assert(plan.Reshow.SequenceEqual([tool]), "and shown again afterwards");
    }

    private static void NestedWindowsHideDeepestFirstAndShowParentsFirst()
    {
        var parent = new TestWindow("parent");
        var child = new TestWindow("child");
        var plan = Plan(desktop: true, Facts(parent, visible: true), Facts(child, visible: true));

        Assert(plan.Hide.SequenceEqual([child, parent]), "hiding a parent does not hide its native children");
        Assert(plan.Reshow.SequenceEqual([parent, child]), "parents come back before their children");
    }

    private static void PopupsAreOnlyHidden()
    {
        var gamePopup = new TestWindow("game popup");
        var log = new TestWindow("log");
        var dropdown = new TestWindow("log dropdown");
        var popupTrigger = new TestWindow("popup trigger");
        var plan = Plan(
            desktop: true,
            Facts(gamePopup, visible: true, popup: true),
            Facts(log, visible: true),
            Facts(dropdown, visible: true, popup: true),
            Facts(popupTrigger, popup: true, trigger: true));

        Assert(plan.Hide.SequenceEqual([dropdown, log, gamePopup]), "every displayed popup is hidden");
        Assert(plan.MakeNative.SequenceEqual([log]), "no popup is pinned native, whatever its depth");
        Assert(plan.Reshow.SequenceEqual([log]), "no popup is reopened");
    }

    private static void EmbeddedAndHiddenWindowsAreLeftAlone()
    {
        var embedded = new TestWindow("embedded");
        var hidden = new TestWindow("hidden");
        var plan = Plan(desktop: true, Facts(embedded, visible: true, embedded: true), Facts(hidden));

        Assert(
            plan.Hide.Count == 0 && plan.MakeNative.Count == 0 && plan.Reshow.Count == 0,
            "an embedded window never blocks the flip, and a hidden one keeps its default of embedding when shown");
    }

    private static void AHeadlessSeatKeepsWindowsHiddenAndNeverMakesThemNative()
    {
        var shown = new TestWindow("shown");
        var log = new TestWindow("log");
        var plan = Plan(desktop: false, Facts(shown, visible: true, mainId: true), Facts(log, trigger: true));

        Assert(plan.Hide.SequenceEqual([shown]), "a displayed window is hidden on a seat too");
        Assert(plan.KeepHidden.SequenceEqual([shown, log]), "a seat can show no window, so both stay hidden");
        Assert(plan.MakeNative.Count == 0 && plan.Reshow.Count == 0, "ForceNative means nothing without native windows");
        Assert(plan.RestoreRootInput, "the window holding the main id took the root's input");
    }

    private static void OnlyAWindowHoldingTheMainIdTakesTheRootInputBack()
    {
        var log = new TestWindow("log");
        var plan = Plan(desktop: false, Facts(log, trigger: true));

        Assert(!plan.RestoreRootInput, "a window caught while still hidden never took the input slot");
    }

    private static void TheBreakerAdmitsFiveRepairsAMinuteThenStaysTripped()
    {
        var breaker = new RootWindowEmbeddingGuard.RepairBreaker(
            RootWindowEmbeddingGuard.BreakerMaxRepairs,
            RootWindowEmbeddingGuard.BreakerWindowMs);

        for (var i = 0; i < RootWindowEmbeddingGuard.BreakerMaxRepairs; i++)
        {
            Assert(breaker.TryAdmit(i * 1000L), $"repair {i + 1} within the minute is admitted");
        }

        Assert(!breaker.TryAdmit(5_000), "the sixth repair within the minute trips the breaker");
        Assert(breaker.Tripped, "the breaker reports itself tripped");
        Assert(!breaker.TryAdmit(10 * 60_000), "a tripped breaker stays tripped");
    }

    private static void SpacedRepairsNeverTripTheBreaker()
    {
        var breaker = new RootWindowEmbeddingGuard.RepairBreaker(
            RootWindowEmbeddingGuard.BreakerMaxRepairs,
            RootWindowEmbeddingGuard.BreakerWindowMs);

        for (var i = 0; i < 50; i++)
        {
            Assert(breaker.TryAdmit(i * 20_000L), $"a repair every 20s is always admitted (repair {i + 1})");
        }
    }

    private static RootWindowEmbeddingGuard.RepairPlan<TestWindow> Plan(
        bool desktop,
        params RootWindowEmbeddingGuard.WindowFacts<TestWindow>[] windows)
    {
        return RootWindowEmbeddingGuard.PlanRepair(windows, nativeSubwindowsSupported: desktop);
    }

    private static RootWindowEmbeddingGuard.WindowFacts<TestWindow> Facts(
        TestWindow window,
        bool visible = false,
        bool embedded = false,
        bool popup = false,
        bool mainId = false,
        bool trigger = false)
    {
        return new RootWindowEmbeddingGuard.WindowFacts<TestWindow>(window, visible, embedded, popup, mainId, trigger);
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[RootWindowEmbeddingGuardTests] FAILED: {label}");
        }
    }
}
