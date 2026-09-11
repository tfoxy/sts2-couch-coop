using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// OWNER: WS-Q (widened input). Two suites:
//   (1) the stateful resolve family (Input/PointerResolver.cs) — a port of inputCapture.ts's resolveSent / designCoord
//       / fieldAffineCoord / frozenCoord / memoizedHoverCoord / hoverCoord / freezeAt / clearFreeze — incl. the F=1
//       strict-verbatim no-op (WS-Q's gate-2 unit proof), press-freeze replay during a drag, fresh release, frozen
//       cancel, the hover memo bounds (24px / 120ms / design-width invalidation), and near-miss integration; and
//   (2) machine-seam tests: fake recording resolvers wired to the frozen GestureCallbacks assert WHICH resolver kind
//       each GestureMachine send site invokes (press→Press, drag hover→Frozen, release→Fresh+ClearFreeze,
//       cancel→Frozen+ClearFreeze, peek→Hover, two-finger right-click→Fresh, wheel→Fresh, idle hover→Hover, tap→Fresh).
internal static class PointerResolverTests
{
    public static void Run()
    {
        // (1) resolve family
        FactorOneVerbatimAllFiveKinds();
        FreshRunsMapPlusNearMiss();
        PressFreezesThenFrozenReplaysAffine();
        FrozenReplaysDragSequenceWithoutNearMiss();
        HoverMemoReplaysWithinBounds();
        HoverMemoExpiresByDistance();
        HoverMemoExpiresByTime();
        HoverMemoInvalidatedByDesignWidthChange();
        ClearFreezeResetsFrozenToIdentity();

        // R19 6a: the frozen replay of an UNANCHORED press is rendered-box gated; an ANCHORED/prop press is not.
        FrozenSqueezedPressIsRenderedBoxGated();
        FrozenUnsqueezedPressIsNotGated();

        // legit-hit guard integration (r3/nearmiss): a fresh probe and a memo replay both KEEP a legit hit over a
        // stage-band bar, and the composed resolver→TouchTargetScan arm-first path now HITS an NRestSiteButton.
        FreshKeepsLegitHitOverWideBar();
        HoverMemoKeepsLegitHit();
        ArmFirstHitsRestSiteButtonThroughResolver();

        // (2) machine seam
        SeamMousePressIsPress();
        SeamMouseDragHoverIsFrozen();
        SeamMouseReleaseIsFreshThenClear();
        SeamMouseCancelIsFrozenThenClear();
        SeamWheelIsFresh();
        SeamIdleHoverIsHover();
        SeamTouchDragSequence();
        SeamTouchCancelIsFrozenThenClear();
        SeamPeekIsHover();
        SeamTwoFingerRightClickIsFresh();
        SeamTouchTapIsFreshThenClear();
    }

    // =================================================================================================
    // (1) resolve family
    // =================================================================================================

    private const double Dw2520 = 2520;

    // A configurable resolver rig: an injectable map (defaults to identity), a mutable rects list, a mutable design
    // width + clock, and a map-call counter (to distinguish a FRESH probe from a pure-math memo/frozen replay).
    private sealed class Rig
    {
        public double Dw = 1920;
        public double Now;
        public List<InteractiveRectScan.InteractiveRect> Rects = new();
        public Func<double, double, PointerField.PointerMapping> MapFn = Identity;
        public int MapCalls;
        public readonly PointerResolver R;

        public Rig()
        {
            R = new PointerResolver(
                map: (x, y) =>
                {
                    MapCalls++;
                    return MapFn(x, y);
                },
                rects: () => Rects,
                designWidth: () => Dw,
                nowMs: () => Now);
        }

        private static PointerField.PointerMapping Identity(double x, double y) =>
            new(x, y, 0, new PointerField.FieldAffine(1, 0), x);
    }

    private static InteractiveRectScan.InteractiveRect IRect(
        string id, double tx, double ty, double w, double h, double spreadDx, double renderedWidth = 0) =>
        new(id, [1, 0, 0, 1, tx, ty], new MirrorRect(0, 0, w, h), spreadDx, renderedWidth);

    // GATE 2 (F=1 no-op, unit level): at design width 1920 the REAL PointerField short-circuits to identity and the
    // resolver's memo/near-miss branches are gated off, so ALL FIVE resolver kinds return the incoming design point
    // VERBATIM. Uses the real PointerField over an empty scene (proving the whole chain, not just a fake map).
    private static void FactorOneVerbatimAllFiveKinds()
    {
        var state = MirrorState.Create();
        var transforms = new GlobalTransformIndex();
        transforms.Update(state);
        Func<string, SpreadRecord?> lookup = _ => null;

        var resolver = new PointerResolver(
            map: (x, y) => PointerField.MapPointerToGame(state, transforms, lookup, x, y, 1920),
            rects: () => new List<InteractiveRectScan.InteractiveRect> { IRect("b", 0, 0, 1920, 1080, 0) },
            designWidth: () => 1920,
            nowMs: () => 0);

        foreach (var (x, y) in new[] { (0.0, 0.0), (960.0, 540.0), (1500.0, 800.0), (1920.0, 1080.0) })
        {
            Verbatim(resolver.Fresh(x, y), x, y, $"Fresh verbatim @({x},{y})");
            Verbatim(resolver.Press(x, y), x, y, $"Press verbatim @({x},{y})"); // also freezes identity affine
            Verbatim(resolver.Frozen(x, y), x, y, $"Frozen verbatim @({x},{y})"); // replays {1,0}
            Verbatim(resolver.Hover(x, y), x, y, $"Hover verbatim @({x},{y})"); // dw==1920 → fresh, identity
            resolver.ClearFreeze(); // no-op, must not throw
            Verbatim(resolver.Frozen(x, y), x, y, $"Frozen after ClearFreeze verbatim @({x},{y})");
        }
    }

    private static void Verbatim(ResolvedCoord c, double x, double y, string label)
    {
        Check.Close(c.X, x, $"{label}: X verbatim");
        Check.Close(c.Y, y, $"{label}: Y verbatim");
    }

    // Fresh (designCoord/resolveSent): runs the map then the near-miss pass on a widened stage.
    private static void FreshRunsMapPlusNearMiss()
    {
        var rig = new Rig { Dw = Dw2520 };
        // Map returns game coord 1100 at designX 1150; a button [1000,1200] rendered +300 near-misses → push to 999.
        rig.MapFn = (_, _) => new PointerField.PointerMapping(1100, 150, 50, new PointerField.FieldAffine(1, -300), 1150);
        rig.Rects = new() { IRect("b", 1000, 100, 200, 100, 300) };

        var fresh = rig.R.Fresh(1150, 150);
        Check.Close(fresh.X, 999, "Fresh applies near-miss (1100 pushed to 999)");
        Check.Close(fresh.Y, 150, "Fresh coordY");
        Check.Equal(rig.MapCalls, 1, "Fresh probes the map once");

        // Press does the same resolve (freezeAt = resolveSent + freeze) — same pushed X.
        var press = rig.R.Press(1150, 150);
        Check.Close(press.X, 999, "Press resolves fresh (near-missed)");
        Check.Equal(rig.MapCalls, 2, "Press probes the map");
    }

    // Press freezes the press-time field affine; Frozen replays `a·designX + b` with pure math (no map, no near-miss).
    private static void PressFreezesThenFrozenReplaysAffine()
    {
        var rig = new Rig { Dw = Dw2520 };
        rig.MapFn = (_, _) => new PointerField.PointerMapping(777, 500, 0, new PointerField.FieldAffine(0.5, 100), 1000);

        rig.R.Press(1000, 500); // freezes affine {0.5, 100}
        var beforeFrozen = rig.MapCalls;

        var frozen = rig.R.Frozen(800, 300);
        Check.Close(frozen.X, 500, "Frozen replays 0.5·800 + 100"); // 400 + 100
        Check.Close(frozen.Y, 300, "Frozen coordY is the plain design Y");
        Check.Equal(rig.MapCalls, beforeFrozen, "Frozen never probes the map");
    }

    // A frozen DRAG replay sequence: press freezes the affine, then every drag-motion Frozen replays pure math — and
    // NEVER runs the near-miss pass even when a rect would otherwise offend.
    private static void FrozenReplaysDragSequenceWithoutNearMiss()
    {
        var rig = new Rig { Dw = Dw2520 };
        rig.MapFn = (_, _) => new PointerField.PointerMapping(0, 0, 0, new PointerField.FieldAffine(0.6, 50), 0);
        rig.R.Press(1200, 400); // freeze {0.6, 50}

        // A rect that WOULD push 850 (game [800,1000] at y 300, rendered +400) if near-miss ran on the frozen path.
        rig.Rects = new() { IRect("blk", 800, 250, 200, 200, 400) };

        foreach (var (designX, expected) in new[] { (1000.0, 650.0), (1250.0, 800.0), (1500.0, 950.0) })
        {
            var f = rig.R.Frozen(designX, 300);
            Check.Close(f.X, expected, $"frozen drag replay 0.6·{designX} + 50"); // never near-missed
        }
    }

    // R19 6a — the MEASURED map-legend drag, through the resolver. A press the anchor map could not attribute to any
    // painter (Squeezed) freezes the squeeze field; before the gate every replayed frame landed inside the anchored
    // legend row's game rect (x[1582,1862], rendered +300 → x[1882,2162]) and dragged it for the whole gesture.
    private static void FrozenSqueezedPressIsRenderedBoxGated()
    {
        const double squeezeA = 1920.0 / 2520.0;
        var rig = new Rig { Dw = Dw2520 };
        rig.MapFn = (x, _) => new PointerField.PointerMapping(x * squeezeA, 500, 0, new PointerField.FieldAffine(squeezeA, 0), x, Squeezed: true);
        rig.Rects = new() { IRect("mapScreen", 0, 0, 1920, 1080, 0, 2520), IRect("legend", 1582, 486, 280, 48, 300) };
        rig.R.Press(2480, 500);

        foreach (var designX in new[] { 2440.0, 2340.0, 2220.0 })
        {
            var f = rig.R.Frozen(designX, 500);
            Check.Close(f.X, 1863, $"frozen drag @{designX} ejected past the legend row (1862 + 1)");
        }

        // Still in the dead band but past the row's game rect → nothing claims it, so it replays verbatim.
        Check.Close(rig.R.Frozen(2500, 500).X, 2500 * squeezeA, "clear of every claim → verbatim replay");
    }

    private static void FrozenUnsqueezedPressIsNotGated()
    {
        const double squeezeA = 1920.0 / 2520.0;
        var rig = new Rig { Dw = Dw2520 };
        // A press ON a proportional card: the map resolves it through the card's own translation (Squeezed false)
        // even though the FIELD it freezes is the whole-world squeeze — the world is meant to spread under the finger.
        rig.MapFn = (x, _) => new PointerField.PointerMapping(x - 300, 500, 300, new PointerField.FieldAffine(squeezeA, 0), x);
        rig.Rects = new() { IRect("legend", 1582, 486, 280, 48, 300) };
        rig.R.Press(2480, 500);
        Check.Close(rig.R.Frozen(2340, 500).X, 2340 * squeezeA, "a prop-press drag replays the squeeze untouched");
    }

    // Hover memo: within HOVER_REPROBE_PX (24) AND HOVER_REPROBE_MS (120) of the last fresh probe (same design width),
    // replay its affine with pure math + near-miss — NO map probe. The fresh probe's map coordX (777) differs from the
    // affine replay (605), so the returned value proves which path ran.
    private static void HoverMemoReplaysWithinBounds()
    {
        var rig = new Rig { Dw = Dw2520, Now = 0 };
        rig.MapFn = (_, _) => new PointerField.PointerMapping(777, 500, 0, new PointerField.FieldAffine(0.5, 100), 1000);

        var fresh = rig.R.Fresh(1000, 500); // sets the memo (affine {0.5,100})
        Check.Close(fresh.X, 777, "fresh returns the map coordX");
        Check.Equal(rig.MapCalls, 1, "one probe so far");

        var hover = rig.R.Hover(1010, 500); // 10px, 0ms → within bounds
        Check.Close(hover.X, 605, "hover replays the memo affine 0.5·1010 + 100 (not the map coordX 777)");
        Check.Equal(rig.MapCalls, 1, "memo replay does NOT probe the map");
    }

    private static void HoverMemoExpiresByDistance()
    {
        var rig = new Rig { Dw = Dw2520, Now = 0 };
        rig.MapFn = (_, _) => new PointerField.PointerMapping(777, 500, 0, new PointerField.FieldAffine(0.5, 100), 1000);
        rig.R.Fresh(1000, 500);
        var hover = rig.R.Hover(1030, 500); // 30px > 24 → re-probe fresh
        Check.Close(hover.X, 777, "out-of-range hover re-probes fresh (map coordX 777)");
        Check.Equal(rig.MapCalls, 2, "distance miss probes the map again");
    }

    private static void HoverMemoExpiresByTime()
    {
        var rig = new Rig { Dw = Dw2520, Now = 0 };
        rig.MapFn = (_, _) => new PointerField.PointerMapping(777, 500, 0, new PointerField.FieldAffine(0.5, 100), 1000);
        rig.R.Fresh(1000, 500);
        rig.Now = 200; // > 120ms since the probe
        var hover = rig.R.Hover(1010, 500);
        Check.Close(hover.X, 777, "stale (>120ms) hover re-probes fresh");
        Check.Equal(rig.MapCalls, 2, "time miss probes the map again");
    }

    private static void HoverMemoInvalidatedByDesignWidthChange()
    {
        var rig = new Rig { Dw = Dw2520, Now = 0 };
        rig.MapFn = (_, _) => new PointerField.PointerMapping(777, 500, 0, new PointerField.FieldAffine(0.5, 100), 1000);
        rig.R.Fresh(1000, 500); // memo taken at dw 2520
        rig.Dw = 2401; // a stretch-toggle / frame-only design change WITHOUT a fresh probe
        var hover = rig.R.Hover(1010, 500); // in px/ms range, but the memo's design width no longer matches
        Check.Close(hover.X, 777, "design-width change invalidates the memo → fresh re-probe");
        Check.Equal(rig.MapCalls, 2, "width mismatch probes the map again");
    }

    private static void ClearFreezeResetsFrozenToIdentity()
    {
        var rig = new Rig { Dw = Dw2520 };
        rig.MapFn = (_, _) => new PointerField.PointerMapping(0, 0, 0, new PointerField.FieldAffine(0.5, 100), 0);
        rig.R.Press(1000, 500); // freeze {0.5,100}
        Check.Close(rig.R.Frozen(800, 300).X, 500, "frozen replays the captured affine"); // 0.5·800+100
        rig.R.ClearFreeze();
        Check.Close(rig.R.Frozen(800, 300).X, 800, "after ClearFreeze, frozen replays identity {1,0}");
    }

    // The legit-hit guard applies transitively through Fresh (designCoord/resolveSent runs the near-miss pass): a
    // pointer over the +dx-shifted gear, whose game box lands on the full-width TopBar bar's band, KEEPS its resolved
    // coord instead of being pushed to the band edge (pre-fix). Proves the guard fires via the resolver's Fresh site
    // — one of the two call sites (the hover memo is the other; see below).
    private static void FreshKeepsLegitHitOverWideBar()
    {
        var rig = new Rig { Dw = Dw2520 };
        // The map resolves the anchored gear coord (2200 − 400 = 1800) at designX 2200; without the guard the bar
        // (a stage-band offender) would push it to the band edge (1920).
        rig.MapFn = (_, _) => new PointerField.PointerMapping(1800, 45, 400, new PointerField.FieldAffine(1, -400), 2200);
        rig.Rects = new() { IRect("topbar", 0, 0, 1920, 90, 0), IRect("gear", 1770, 15, 60, 60, 400) };

        var fresh = rig.R.Fresh(2200, 45);
        Check.Close(fresh.X, 1800, "Fresh keeps the legit gear hit over the TopBar bar (not pushed to 1920)");
        Check.Close(fresh.Y, 45, "Fresh coordY");
        Check.Equal(rig.MapCalls, 1, "Fresh probes the map once");
    }

    // The hover memo replay (memoizedHoverCoord) runs the SAME near-miss pass, so the guard fires there too: a plain
    // hover within the memo bounds replays the gear's field affine + near-miss and KEEPS the legit hit — with NO fresh
    // map re-probe. Covers the second of the two near-miss call sites.
    private static void HoverMemoKeepsLegitHit()
    {
        var rig = new Rig { Dw = Dw2520, Now = 0 };
        rig.MapFn = (_, _) => new PointerField.PointerMapping(1800, 45, 400, new PointerField.FieldAffine(1, -400), 2200);
        rig.Rects = new() { IRect("topbar", 0, 0, 1920, 90, 0), IRect("gear", 1770, 15, 60, 60, 400) };

        rig.R.Fresh(2200, 45); // seed the memo (affine {1,-400})
        Check.Equal(rig.MapCalls, 1, "one probe so far");

        // A 5px hover replays the affine: rawX = 1·2205 − 400 = 1805, still inside the gear → legit hit → kept.
        var hover = rig.R.Hover(2205, 45);
        Check.Close(hover.X, 1805, "hover-memo replay keeps the legit gear hit (1·2205 − 400)");
        Check.Equal(rig.MapCalls, 1, "memo replay runs near-miss without a fresh map probe");
    }

    // COMPOSED integration: the exact production arm-first path (InputRouter.TargetsAtResolved) = resolver.Fresh →
    // TouchTargetScan.TargetsAt, over a real MirrorState holding an NRestSiteButton on a full-band dialog backdrop.
    // With the guard ON the resolved coord stays inside the button, so arm-first HITS it; with the guard OFF the
    // near-miss pushes the coord off the button to the backdrop edge, so arm-first MISSES (the live "View Upgrades
    // never arms" defect). Exercises PointerField (map) + NearMiss (push) + TouchTargetScan (hit) end to end.
    private static void ArmFirstHitsRestSiteButtonThroughResolver()
    {
        const double dw = 2401;
        // Real scene: a full-band dialog backdrop (pinned) + the +400-shifted View Upgrades button over it.
        var backdrop = Ctrl("backdrop", "Game.NDialogBackdrop", 0, 400, 1920, 300);
        var button = Ctrl("restbtn", "Game.RestSite.NRestSiteButton", 1600, 500, 300, 100);
        var state = MirrorState.Create();
        foreach (var n in new[] { backdrop, button })
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
            state.ChangedIds.Add(n.Id);
        }

        state.Revision = 1;
        var transforms = new GlobalTransformIndex();
        transforms.Update(state);

        // Spread records: both paint; the button carries the right-cluster shift (+400), the backdrop is pinned.
        var records = new Dictionary<string, SpreadRecord>(StringComparer.Ordinal)
        {
            ["backdrop"] = new SpreadRecord(0, 0, false, true),
            ["restbtn"] = new SpreadRecord(400, 0, false, true),
        };
        Func<string, SpreadRecord?> lookup = id => records.TryGetValue(id, out var r) ? r : null;

        // The near-miss rects (paint order, topmost last), matching the node geometry + spread.
        var rects = new List<InteractiveRectScan.InteractiveRect>
        {
            new("backdrop", [1, 0, 0, 1, 0, 400], new MirrorRect(0, 0, 1920, 300), 0, 0),
            new("restbtn", [1, 0, 0, 1, 1600, 500], new MirrorRect(0, 0, 300, 100), 400, 0),
        };

        var resolver = new PointerResolver(
            map: (x, y) => PointerField.MapPointerToGame(state, transforms, lookup, x, y, dw),
            rects: () => rects,
            designWidth: () => dw,
            nowMs: () => 0);

        // The production seam: resolve the design point (2100,550 — over the button's rendered box) then hit-test.
        IReadOnlyList<string> TargetsAtResolved()
        {
            var resolved = resolver.Fresh(2100, 550);
            return TouchTargetScan.TargetsAt(state, transforms, resolved.X, resolved.Y);
        }

        Check.SequenceEqual(TargetsAtResolved(), new[] { "restbtn" }, "arm-first HITS the NRestSiteButton");
    }

    // A minimal painted, mouse-visible Control node with a parent-relative transform (the button paints so TouchTargetScan
    // treats it as a hittable touch target; NRestSiteButton is a TOUCH_TARGET leaf → arm-first).
    private static MirrorNode Ctrl(string id, string type, double gx, double gy, double w, double h) =>
        new()
        {
            Id = id,
            NodeType = type,
            Name = id,
            Visible = true,
            MouseFilter = 0,
            Transform = [1, 0, 0, 1, gx, gy],
            LocalRect = new MirrorRect(0, 0, w, h),
            TextureUrl = "res://t.png",
        };

    // =================================================================================================
    // (2) machine seam — which resolver kind each gesture path invokes
    // =================================================================================================

    private sealed class Seam
    {
        public readonly List<string> Calls = new();
        public readonly List<InputMessage> Sent = new();
        public IReadOnlyList<string> Targets = Array.Empty<string>();
        public Func<string, bool> IsCardFn = _ => false;
        public readonly GestureOptions Options = new();
        public readonly GestureMachine M;

        public Seam()
        {
            var cb = new GestureCallbacks
            {
                Send = m => Sent.Add(m),
                OnHeldCard = (_, _, _, _) => { },
                TargetsAt = (_, _) => Targets,
                IsCard = id => IsCardFn(id),
                ResolveFresh = (x, y) => Record("fresh", x, y),
                ResolvePress = (x, y) => Record("press", x, y),
                ResolveFrozen = (x, y) => Record("frozen", x, y),
                ResolveHover = (x, y) => Record("hover", x, y),
                ClearFreeze = () => Calls.Add("clear"),
            };
            M = new GestureMachine(Options, cb);
        }

        private ResolvedCoord Record(string kind, double x, double y)
        {
            Calls.Add(kind);
            return new ResolvedCoord(x, y);
        }

        public void ClearCalls() => Calls.Clear();
        public void MouseDown(int b, double x, double y) => M.PointerDown(0, PointerKind.Mouse, b, x, y, 0);
        public void MouseMove(double x, double y) => M.PointerMove(0, PointerKind.Mouse, x, y, 0);
        public void MouseUp(int b, double x, double y) => M.PointerUp(0, PointerKind.Mouse, b, x, y, 0);
        public void TouchDown(long id, double x, double y, double t = 0) => M.PointerDown(id, PointerKind.Touch, 0, x, y, t);
        public void TouchMove(long id, double x, double y) => M.PointerMove(id, PointerKind.Touch, x, y, 0);
        public void TouchUp(long id, double x, double y) => M.PointerUp(id, PointerKind.Touch, 0, x, y, 0);
        public void Pump(double t) => M.PumpFrame(t);
    }

    private static void SeamMousePressIsPress()
    {
        var s = new Seam();
        s.MouseDown(0, 100, 100);
        Check.SequenceEqual(s.Calls, new[] { "press" }, "mouse press → ResolvePress");
    }

    private static void SeamMouseDragHoverIsFrozen()
    {
        var s = new Seam();
        s.MouseDown(0, 100, 100); // press (freezes)
        s.ClearCalls();
        s.MouseMove(200, 200);
        s.Pump(1); // coalesced hover flush during a held button
        Check.SequenceEqual(s.Calls, new[] { "frozen" }, "mouse drag-motion hover → ResolveFrozen");
    }

    private static void SeamMouseReleaseIsFreshThenClear()
    {
        var s = new Seam();
        s.MouseDown(0, 100, 100);
        s.ClearCalls();
        s.MouseUp(0, 120, 120);
        Check.SequenceEqual(s.Calls, new[] { "fresh", "clear" }, "mouse release → ResolveFresh then ClearFreeze");
    }

    private static void SeamMouseCancelIsFrozenThenClear()
    {
        var s = new Seam();
        s.MouseDown(0, 100, 100);
        s.ClearCalls();
        s.M.PointerCancel(0, 0); // id 0 is not a tracked touch → mouse cancel (stale point, frozen replay)
        Check.SequenceEqual(s.Calls, new[] { "frozen", "clear" }, "mouse cancel → ResolveFrozen then ClearFreeze");
    }

    private static void SeamWheelIsFresh()
    {
        var s = new Seam();
        s.M.Wheel(true, 300, 300, 0);
        Check.SequenceEqual(s.Calls, new[] { "fresh" }, "wheel → ResolveFresh");
    }

    private static void SeamIdleHoverIsHover()
    {
        var s = new Seam();
        s.MouseMove(300, 300); // no button held
        s.Pump(1);
        Check.SequenceEqual(s.Calls, new[] { "hover" }, "idle hover flush → ResolveHover");
    }

    private static void SeamTouchDragSequence()
    {
        var s = new Seam { Targets = Array.Empty<string>() };
        s.TouchDown(1, 0, 0); // TargetsAt + the primary down-hover → ResolveFresh
        Check.SequenceEqual(s.Calls, new[] { "fresh" }, "touch down → the primary down-hover resolves fresh");
        s.TouchMove(1, 500, 500); // classify drag → press
        s.Pump(1); // drag-motion hover → frozen
        s.TouchUp(1, 500, 500); // release → fresh + clear
        Check.SequenceEqual(s.Calls, new[] { "fresh", "press", "frozen", "fresh", "clear" }, "touch drag: down-hover fresh→press→frozen→fresh→clear");
    }

    private static void SeamTouchCancelIsFrozenThenClear()
    {
        var s = new Seam { Targets = Array.Empty<string>() };
        s.TouchDown(1, 0, 0);
        s.TouchMove(1, 500, 500); // press (drag)
        s.ClearCalls();
        s.M.PointerCancel(1, 0); // tracked touch → touch cancel (stale point, frozen replay)
        Check.SequenceEqual(s.Calls, new[] { "frozen", "clear" }, "touch drag cancel → ResolveFrozen then ClearFreeze");
    }

    private static void SeamPeekIsHover()
    {
        var s = new Seam { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        s.TouchDown(1, 960, 800); // primary down-hover → ResolveFresh
        s.Pump(GestureOptions.DefaultPeekMs); // peek deadline fires → ResolveHover
        Check.SequenceEqual(s.Calls, new[] { "fresh", "hover" }, "down-hover fresh, then peek → ResolveHover (plain hover, no freeze)");
    }

    private static void SeamTwoFingerRightClickIsFresh()
    {
        var s = new Seam();
        s.TouchDown(1, 800, 600); // primary down-hover → ResolveFresh
        s.TouchDown(2, 880, 600); // arms two-finger — the SECONDARY finger does NOT down-hover
        s.TouchUp(1, 800, 600); // waits for the second finger
        s.TouchUp(2, 880, 600); // fires the right-click at the centroid
        Check.SequenceEqual(s.Calls, new[] { "fresh", "fresh" }, "primary down-hover, then two-finger right-click → both ResolveFresh");
    }

    private static void SeamTouchTapIsFreshThenClear()
    {
        var s = new Seam { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        s.TouchDown(1, 960, 540); // primary down-hover → ResolveFresh
        s.TouchUp(1, 960, 540); // single tap (arms) — resolves the release once (fresh) then clears
        Check.SequenceEqual(s.Calls, new[] { "fresh", "fresh", "clear" }, "down-hover fresh, then touch tap → ResolveFresh then ClearFreeze");
    }
}
