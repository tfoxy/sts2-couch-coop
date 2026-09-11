using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.MirrorProtocol.Input;

namespace CouchCoop.MirrorProtocol.Tests;

// Behavioural port of frontend/src/mirror/__tests__/inputCapture.spec.ts. Coordinates here are DESIGN space
// (the web tests use a 2x-scaled 960x540 stage whose client px map to 2x design px; the engine consumes
// pre-mapped design coords, so the design values from those tests are passed directly). Time is driven by an
// explicit nowMs + PumpFrame (the web's fake-timer PEEK_MS / rAF flush).
internal static class GestureMachineTests
{
    // The web's PEEK_MS default.
    private const double Peek = GestureOptions.DefaultPeekMs;
    // R1: the web's LONG_PRESS_MS default — the NON-hand-card long-press right-click's own, longer threshold.
    private const double LongPress = GestureOptions.DefaultLongPressMs;

    public static void Run()
    {
        // ---- mouse ----
        MouseHoverSendsDesignCoord();
        MouseCoalescesMovesWithinFrame();
        MouseFollowsCursorAcrossFrames();
        MouseTapReplaysPressRelease();
        MouseDragPressHoversRelease();
        MouseRightClickViaDownUp();
        MouseCancelSynthesizesRelease();
        WheelUpDownTicks();
        KeyWithAndWithoutModifiers();

        // ---- touch down-hover contract (touch-start counts as a hover) ----
        PrimaryDownEmitsOneHoverAtDownPoint();
        SecondaryFingerDoesNotDownHover();

        // ---- touch arm / commit ----
        TouchArmThenCommitStaysArmed();
        EmptyTapAfterCommitDisarms();
        ReTapArmedOverlappingCommits();
        TapDifferentWidgetArmsIt();
        NonListedOrBlockedTapClicksImmediately();
        TouchDragPressHoversRelease();
        TwoFingerTapRightClicksAtCentroid();
        TwoFingerPinchEmitsNothing();
        StrayFingerDuringDragIgnored();

        // ---- R16: tap-to-focus debounce ----
        TapDebounceSwallowsQuickRetap();
        TapDebounceCommitsAfterWindow();

        // ---- two-finger scroll wheel ----
        TwoFingerDragEmitsWheelTicks();
        TwoFingerSubStepEmitsNoWheel();
        TwoFingerWheelDirectionMapping();

        // ---- peek ----
        PeekFiresThenUnfocusesOnRelease();
        PeekReleaseCenterMapsThroughResolver();
        PeekUnfocusOffStillClearsLift();
        PeekConvertsToDragOnMove();
        PeekSecondFingerNoRightClick();
        PeekNonCardDoesNotFire();
        PeekRaiseOffDoesNotFire();
        ArmedCardReTouchDragsNotPeeks();
        DifferentUnarmedCardStillPeeks();
        TapToFocusOffPressesImmediately();
        PointerCancelDuringPeekClearsSilently();

        // ---- tap-to-unselect ----
        UnselectBelowLineRightClicks();
        UnselectArmedOnlyDoesNotCancel();
        UnselectNothingPressedNormalTap();
        UnselectSelfDisablesWhenCardGone();
        UnselectTapToFocusOffSingleTapThenCancel();

        // ---- hand-card gating (press-captured verdict survives a mid-drag re-parent) ----
        HandCardVerdictCapturedAtPressSurvivesReparent();

        // ---- change 1: drag-release below the play line right-clicks (de-select) ----
        DragReleaseBelowLineRightClicksHandCard();
        DragReleaseAboveLineNoRightClick();
        DragReleaseBelowLineNonHandCardNoRightClick();
        PeekThenDragReleaseBelowLineRightClicks();
        PurePeekReleaseBelowLineNoRightClick();
        TwoFingerTapSingleRightClickNoDoubleFire();
        ReparentedHandCardDragBelowLineStillRightClicks();
        UnwiredPlayZoneThresholdNeverRightClicks();

        // ---- R4 change 2 / R13: end-turn tap parks the cursor at screen center ----
        EndTurnTapUnhoversBelowButton();
        EndTurnUnhoverCenterRoutesThroughResolverOnWidenedStage();
        NonEndTurnTapNoExtraHover();
        EndTurnHoldPhaseNoHoverUntilTapEnd();

        // ---- change 2: reward/deck cards are arm-first touch targets (machine level) ----
        RewardCardTapArmsThenCommits();
        RewardCardStillNoPeekNoLiftNoUnselect();

        // ---- #12: single-tap selection in a from-hand card-choice dialog ----
        ChoiceActiveSingleTapClicksHandCard();
        ChoiceActiveBelowLineTapClicksNotRightClicks();
        ChoiceActiveNonHandCardStillArmFirst();
        ChoiceInactiveArmFirstPreserved();

        // ---- #13: long-press on a NON-hand card = right click ----
        LongPressNonHandCardRightClicks();
        LongPressDoesNotFireAtPeekMsOnlyAtLongPressMs();
        LongPressReleaseEmitsNothing();
        LongPressWorksWithRaiseHeldCardOff();
        LongPressFiresOnArmedTarget();
        LongPressNoDragAfterFire();
        LongPressSecondFingerStray();
        LongPressHandCardStillPeeksNotRightClicks();
        LongPressNonCardTargetNoRightClick();

        // ---- change 3 + lift-follow: a drag begun OFF a card raises the hand card it moves onto, and a PROBE latch
        //      keeps re-classifying (switch to a new hand card / clear off every card) while the drag is active ----
        DragIntoHandCardLatchesLift();
        DragProbeLatchSwitchesToSecondCard();
        DragProbeLatchClearsOnEmpty();
        DragPressGrabDoesNotSwitchOverAnotherCard();
        DragIntoHandCardGatedByToggle();
        DragIntoHandCardAboveBandDoesNotLatch();
        DragProbeLatchAboveBandNotReclassified();
        DragStartedOffCardLatchedThenReleasedBelowLineNoRightClick();

        // ---- onHeldCard ----
        OnHeldCardStreamsThroughDragThenNull();
        OnHeldCardNeverFiresForMouse();

        // ---- lifecycle ----
        ResetClearsAllState();
    }

    // ---- harness ----

    private sealed record HeldCall(string? Id, double X, double Y, HeldMode Mode);

    private sealed class Harness
    {
        public readonly List<InputMessage> Sent = new();
        public readonly List<HeldCall> Held = new();
        public IReadOnlyList<string> Targets = Array.Empty<string>();
        public Func<string, bool> IsCardFn = _ => false;
        // Defaults true (an unwired IsHandCard is unrestricted) so the IsCard-only tests are unaffected.
        public Func<string, bool> IsHandCardFn = _ => true;
        // R4 seams. Defaults keep every pre-existing test byte-identical: DesignWidth 1920 (16:9), ResolveFresh
        // identity, EndTurnBoxAt unwired (null → no un-hover). Tests override these to exercise the new paths.
        public Func<double> DesignWidthFn = () => 1920;
        public Func<double, double, ResolvedCoord> ResolveFreshFn = (x, y) => new ResolvedCoord(x, y);
        public Func<double, double, EndTurnBox?>? EndTurnBoxAtFn = null;
        // No hand-choice dialog is the normal harness state; the choice tests set it when a dialog is present.
        public Func<bool> HandChoiceActiveFn = () => false;
        public readonly GestureOptions Options = new();
        public readonly GestureMachine M;

        // Wire PlayZoneThreshold exactly like the live InputRouter (PlayZone.Threshold(1080, dragStartY)) by default,
        // so the change-1 below-line drag-drop cancel is exercised; the seam-off test passes wirePlayZone: false to
        // prove the old (no-right-click) behaviour when the callback is null.
        public Harness(bool wirePlayZone = true)
        {
            var cb = new GestureCallbacks
            {
                Send = m => Sent.Add(m),
                OnHeldCard = (id, x, y, mode) => Held.Add(new HeldCall(id, x, y, mode)),
                TargetsAt = (_, _) => Targets,
                IsCard = id => IsCardFn(id),
                IsHandCard = id => IsHandCardFn(id),
                PlayZoneThreshold = wirePlayZone ? d => PlayZone.Threshold(1080, d) : null,
                // Forward through the mutable fields so a test can flip them after construction (identity by default).
                DesignWidth = () => DesignWidthFn(),
                ResolveFresh = (x, y) => ResolveFreshFn(x, y),
                EndTurnBoxAt = (x, y) => EndTurnBoxAtFn?.Invoke(x, y),
                HandChoiceActive = () => HandChoiceActiveFn(),
            };
            M = new GestureMachine(Options, cb);
        }

        public void ClearSent() => Sent.Clear();

        public void MouseDown(int button, double x, double y) => M.PointerDown(0, PointerKind.Mouse, button, x, y, 0);
        public void MouseMove(double x, double y) => M.PointerMove(0, PointerKind.Mouse, x, y, 0);
        public void MouseUp(int button, double x, double y) => M.PointerUp(0, PointerKind.Mouse, button, x, y, 0);

        public void TouchDown(long id, double x, double y, double t = 0) => M.PointerDown(id, PointerKind.Touch, 0, x, y, t);
        public void TouchMove(long id, double x, double y) => M.PointerMove(id, PointerKind.Touch, x, y, 0);
        public void TouchUp(long id, double x, double y, double t = 0) => M.PointerUp(id, PointerKind.Touch, 0, x, y, t);

        public void Pump(double t) => M.PumpFrame(t);

        public List<string> Sigs() => Sent.ConvertAll(Sig);
        public InputMessage Last => Sent[^1];
    }

    private static string Sig(InputMessage m) =>
        $"{m.Kind}:{m.Button ?? ""}:{(m.Pressed.HasValue ? (m.Pressed.Value ? "true" : "false") : "")}";

    private static void AssertCoord(InputMessage m, double x, double y, string label)
    {
        Check.Close(m.CoordX ?? double.NaN, x, $"{label}.coordX");
        Check.Close(m.CoordY ?? double.NaN, y, $"{label}.coordY");
    }

    // ================= MOUSE =================

    private static void MouseHoverSendsDesignCoord()
    {
        var h = new Harness();
        h.MouseMove(960, 540);
        h.Pump(16);
        Check.Equal(h.Sent.Count, 1, "one hover after flush");
        Check.Equal(h.Last.Kind, "hover", "hover kind");
        AssertCoord(h.Last, 960, 540, "hover");
    }

    private static void MouseCoalescesMovesWithinFrame()
    {
        var h = new Harness();
        h.MouseMove(20, 20);
        h.MouseMove(960, 540);
        Check.Equal(h.Sent.Count, 0, "nothing sent until the frame flushes");
        h.Pump(16);
        Check.Equal(h.Sent.Count, 1, "one hover (coalesced)");
        AssertCoord(h.Last, 960, 540, "latest move wins");
    }

    private static void MouseFollowsCursorAcrossFrames()
    {
        var h = new Harness();
        h.MouseMove(200, 200);
        h.Pump(1);
        h.MouseMove(600, 400);
        h.Pump(2);
        h.MouseMove(1400, 1000);
        h.Pump(3);
        Check.Equal(h.Sent.FindAll(m => m.Kind == "hover").Count, 3, "three hovers across three frames");
        AssertCoord(h.Last, 1400, 1000, "last hover follows cursor");
    }

    private static void MouseTapReplaysPressRelease()
    {
        var h = new Harness();
        h.MouseDown(0, 960, 540);
        Check.Equal(Sig(h.Last), "click:left:true", "press on down");
        AssertCoord(h.Last, 960, 540, "press");
        h.MouseUp(0, 960, 540);
        Check.Equal(Sig(h.Last), "click:left:false", "release on up");
        AssertCoord(h.Last, 960, 540, "release");
    }

    private static void MouseDragPressHoversRelease()
    {
        var h = new Harness();
        h.MouseDown(0, 0, 0);
        h.MouseMove(960, 540);
        h.Pump(1);
        h.MouseMove(1400, 1000);
        h.Pump(2);
        h.MouseUp(0, 1400, 1000);
        Check.SequenceEqual(h.Sigs(), new[] { "click:left:true", "hover::", "hover::", "click:left:false" }, "drag = press → hovers → release");
        Check.That(h.Sent.FindAll(m => m.Kind == "hover").TrueForAll(m => m.Pressed is null), "drag hovers stay plain (no pressed)");
        AssertCoord(h.Last, 1400, 1000, "release at lift point");
    }

    private static void MouseRightClickViaDownUp()
    {
        var h = new Harness();
        h.MouseDown(2, 0, 0);
        h.MouseUp(2, 0, 0);
        Check.SequenceEqual(h.Sigs(), new[] { "click:right:true", "click:right:false" }, "right-click via button 2 down/up");
    }

    private static void MouseCancelSynthesizesRelease()
    {
        var h = new Harness();
        h.MouseDown(0, 960, 540);
        h.ClearSent();
        h.M.PointerCancel(0, 0); // id 0 is not a touch pointer → mouse cancel
        Check.Equal(Sig(h.Last), "click:left:false", "cancel synthesizes a left release");
    }

    private static void WheelUpDownTicks()
    {
        var h = new Harness();
        h.M.Wheel(true, 960, 540, 0);
        Check.Equal(Sig(h.Last), "click:wheel-up:", "wheel up tick (no pressed)");
        AssertCoord(h.Last, 960, 540, "wheel-up coord");
        Check.Equal(h.Last.Pressed, (bool?)null, "wheel carries no pressed");
        h.M.Wheel(false, 960, 540, 0);
        Check.Equal(Sig(h.Last), "click:wheel-down:", "wheel down tick");
    }

    private static void KeyWithAndWithoutModifiers()
    {
        // NOTE: event.repeat / editable-field filtering lives in WS-M's DOM event layer (the engine has no
        // KeyboardEvent); the engine forwards whatever code + pre-joined csv it is handed.
        var h = new Harness();
        h.M.Key("KeyE", "shift");
        Check.Equal(h.Last.Kind, "key", "key kind");
        Check.Equal(h.Last.Key, "KeyE", "key code");
        Check.Equal(h.Last.Modifiers, "shift", "modifiers csv carried");

        h.M.Key("KeyA", "");
        Check.Equal(h.Last.Key, "KeyA", "second key code");
        Check.Equal(h.Last.Modifiers, null, "empty csv → modifiers omitted (null)");
    }

    // ================= TOUCH arm / commit =================

    private static void TouchArmThenCommitStaysArmed()
    {
        var h = new Harness { Targets = new[] { "card-1" } };
        // Tap 1 → the down edge hovers (touch-start counts as a hover), then the arm hovers again on lift; no press.
        h.TouchDown(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "the immediate down-hover; press still deferred");
        h.TouchUp(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "tap 1: down-hover then arm-hover");

        // Tap 2, past TapArmDebounceMs (200ms) since the tap-1 arm → down-hover then full click.
        h.ClearSent();
        h.TouchDown(1, 960, 540, 300);
        h.TouchUp(1, 960, 540, 300);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "tap 2 commits (down-hover + full click)");

        // Tap 3 → still down-hover then click (stays armed after commit).
        h.ClearSent();
        h.TouchDown(1, 960, 540, 600);
        h.TouchUp(1, 960, 540, 600);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "tap 3 still clicks (stays armed)");
    }

    // ================= R16: tap-to-focus debounce =================

    private static void TapDebounceSwallowsQuickRetap()
    {
        var h = new Harness { Targets = new[] { "card-1" } };
        // Tap 1 arms card-1 at t=0.
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        h.ClearSent();

        // A re-tap 150ms later (< TapArmDebounceMs 200) is an accidental double-tap: down-hover only, NO click, and
        // the widget stays armed.
        h.TouchDown(1, 960, 540, 150);
        h.TouchUp(1, 960, 540, 150);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "a re-tap within 150ms of the arm is swallowed (no click)");

        // A THIRD tap past the debounce window (measured from the ORIGINAL arm at t=0, not the swallowed tap) commits.
        h.ClearSent();
        h.TouchDown(1, 960, 540, 250);
        h.TouchUp(1, 960, 540, 250);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "a tap at 250ms (past the debounce) commits");
    }

    private static void TapDebounceCommitsAfterWindow()
    {
        var h = new Harness { Targets = new[] { "card-1" } };
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540); // arm at t=0
        h.ClearSent();

        h.TouchDown(1, 960, 540, 250);
        h.TouchUp(1, 960, 540, 250);
        Check.SequenceEqual(
            h.Sigs(),
            new[] { "hover::", "click:left:" },
            "a re-tap once TapArmDebounceMs has elapsed since the arm commits normally");
    }

    private static void EmptyTapAfterCommitDisarms()
    {
        var h = new Harness { Targets = new[] { "card-1" } };
        // Arm + commit card-1 (past TapArmDebounceMs so the re-tap isn't swallowed).
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        h.TouchDown(1, 960, 540, 300);
        h.TouchUp(1, 960, 540, 300);

        // Tap empty space (no targets) → the down-hover, then an immediate click + disarm.
        h.ClearSent();
        h.Targets = Array.Empty<string>();
        h.TouchDown(1, 200, 200);
        h.TouchUp(1, 200, 200);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "empty tap → down-hover + immediate click");
        AssertCoord(h.Last, 200, 200, "empty-tap click coord");

        // card-1 again → down-hover then the arm HOVER (disarmed).
        h.ClearSent();
        h.Targets = new[] { "card-1" };
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "after disarm, card hovers first again");
    }

    private static void ReTapArmedOverlappingCommits()
    {
        // Overlapping options: the stack has more than one id, opt-1 topmost. Re-tap commits opt-1 (the armed top).
        var h = new Harness { Targets = new[] { "opt-1", "opt-2" } };
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "first tap: down-hover then arms opt-1");
        h.ClearSent();
        h.TouchDown(1, 960, 540, 300);
        h.TouchUp(1, 960, 540, 300);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "re-tap: down-hover then commits opt-1");
    }

    private static void TapDifferentWidgetArmsIt()
    {
        var h = new Harness { Targets = new[] { "card-A" } };
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "down-hover then arm card-A");
        h.ClearSent();
        // Tap a different card → down-hover then arm it (hover), never commit A.
        h.Targets = new[] { "card-B" };
        h.TouchDown(1, 100, 1000);
        h.TouchUp(1, 100, 1000);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "different card → down-hover + arm B (no click)");
        AssertCoord(h.Last, 100, 1000, "arm-B hover coord");
    }

    private static void NonListedOrBlockedTapClicksImmediately()
    {
        // TargetsAt returns [] both for empty space and for a blocking button on top (TouchTargetScan truncates a
        // block to []). Either way the tap is an immediate click.
        var h = new Harness { Targets = Array.Empty<string>() };
        h.TouchDown(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "the down-hover; press still deferred until up");
        h.TouchUp(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "non-listed / blocked tap → down-hover + immediate click");
    }

    private static void TouchDragPressHoversRelease()
    {
        var h = new Harness { Targets = Array.Empty<string>() };
        h.TouchDown(1, 0, 0);
        h.TouchMove(1, 960, 540);
        h.Pump(1);
        h.TouchMove(1, 1400, 1000);
        h.Pump(2);
        h.TouchUp(1, 1400, 1000);
        // A leading down-hover (the touch-start), then the deferred press → plain drag hovers → release.
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:true", "hover::", "hover::", "click:left:false" }, "touch drag = down-hover → press → hovers → release");
        Check.Equal(h.Sent[0].Kind, "hover", "the primary down-hover leads the drag");
        Check.Equal(h.Sent[0].CoordX, (double?)0, "down-hover at the down point");
        Check.Equal(h.Sent[1].CoordX, (double?)0, "press fires at the START point");
        AssertCoord(h.Last, 1400, 1000, "release where the finger lifted");
    }

    private static void TwoFingerTapRightClicksAtCentroid()
    {
        var h = new Harness();
        // The first (primary) finger's down counts as a hover; the SECOND finger does NOT hover.
        h.TouchDown(1, 800, 600);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "primary finger down-hovers");
        AssertCoord(h.Last, 800, 600, "down-hover at the first finger");
        h.TouchDown(2, 880, 600);
        Check.Equal(h.Sent.Count, 1, "secondary finger adds nothing — the gesture is latching");
        h.TouchUp(1, 800, 600);
        Check.Equal(h.Sent.Count, 1, "wait for the second finger");
        h.TouchUp(2, 880, 600);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:right:" }, "two-finger lift → the down-hover then one right-click");
        AssertCoord(h.Last, 840, 600, "right-click at the centroid");
    }

    private static void TwoFingerPinchEmitsNothing()
    {
        var h = new Harness();
        h.TouchDown(1, 800, 600);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "primary down-hover");
        h.TouchDown(2, 880, 600); // secondary: no hover
        h.ClearSent(); // isolate the pinch itself
        h.TouchMove(1, 100, 600); // >= 24px design travel → a pinch
        h.Pump(1);
        h.TouchUp(1, 100, 600);
        h.TouchUp(2, 880, 600);
        Check.Equal(h.Sent.Count, 0, "the two-finger pinch itself emits nothing");
    }

    private static void StrayFingerDuringDragIgnored()
    {
        var h = new Harness { Targets = Array.Empty<string>() };
        h.TouchDown(1, 0, 0); // primary → a leading down-hover
        h.TouchMove(1, 500, 500); // classify drag (press)
        h.Pump(1);
        // A stray second finger arrives mid-drag → ignored, no down-hover, its lift emits nothing.
        h.TouchDown(2, 100, 100);
        h.TouchUp(2, 100, 100);
        h.TouchMove(1, 600, 600);
        h.Pump(2);
        h.TouchUp(1, 600, 600);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:true", "hover::", "hover::", "click:left:false" }, "down-hover then the drag; the stray finger contributes nothing");
    }

    // ================= two-finger scroll wheel =================
    // WheelStepDesign is 56 design px of vertical CENTROID drift per tick. Direction is NATURAL touch scroll:
    // fingers moving UP (centroid Y decreasing) ⇒ wheel-down; DOWN ⇒ wheel-up. Ticks fire at the STORED latch
    // centroid. Both fingers start at design y=500, x=800/880 ⇒ centroid (840, 500).

    private static void TwoFingerDragEmitsWheelTicks()
    {
        const double step = GestureOptions.DefaultWheelStepDesign; // 56
        var h = new Harness();
        h.TouchDown(1, 800, 500);
        h.TouchDown(2, 880, 500); // latch, centroid (840, 500)
        h.ClearSent();            // drop the primary down-hover

        // Drag BOTH fingers straight up by 2 steps → centroid drifts −2·step → exactly 2 wheel-down ticks.
        h.TouchMove(1, 800, 500 - (2 * step));
        h.TouchMove(2, 880, 500 - (2 * step));
        Check.SequenceEqual(h.Sigs(), new[] { "click:wheel-down:", "click:wheel-down:" }, "2-step upward drag → exactly 2 wheel-down ticks");
        foreach (var m in h.Sent)
        {
            AssertCoord(m, 840, 500, "wheel tick at the stored latch centroid");
        }
    }

    private static void TwoFingerSubStepEmitsNoWheel()
    {
        var h = new Harness();
        h.TouchDown(1, 800, 500);
        h.TouchDown(2, 880, 500);
        h.ClearSent();

        // A recognized two-finger drag (each finger travels 40 ≥ TwoFingerCancelDesign 24) whose total centroid
        // drift (40 < WheelStepDesign 56) never reaches one step → no wheel ticks.
        h.TouchMove(1, 800, 460);
        h.TouchMove(2, 880, 460);
        Check.Equal(h.Sent.Count, 0, "a sub-step two-finger drag emits no wheel ticks");
    }

    private static void TwoFingerWheelDirectionMapping()
    {
        const double step = GestureOptions.DefaultWheelStepDesign;

        // Fingers moving UP (centroid Y decreasing) ⇒ content scrolls DOWN ⇒ wheel-down.
        var up = new Harness();
        up.TouchDown(1, 800, 500);
        up.TouchDown(2, 880, 500);
        up.ClearSent();
        up.TouchMove(1, 800, 500 - step);
        up.TouchMove(2, 880, 500 - step);
        Check.SequenceEqual(up.Sigs(), new[] { "click:wheel-down:" }, "fingers UP (centroid decreasing) → one wheel-down");

        // Fingers moving DOWN (centroid Y increasing) ⇒ content scrolls UP ⇒ wheel-up.
        var down = new Harness();
        down.TouchDown(1, 800, 500);
        down.TouchDown(2, 880, 500);
        down.ClearSent();
        down.TouchMove(1, 800, 500 + step);
        down.TouchMove(2, 880, 500 + step);
        Check.SequenceEqual(down.Sigs(), new[] { "click:wheel-up:" }, "fingers DOWN (centroid increasing) → one wheel-up");
    }

    // ================= PEEK =================

    private static void PeekFiresThenUnfocusesOnRelease()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.TouchDown(1, 960, 800);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "the down-hover; press deferred + peek deadline pending");
        AssertCoord(h.Last, 960, 800, "down-hover at the finger");
        h.Pump(Peek);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "peek fires a SECOND plain hover (no click)");
        AssertCoord(h.Last, 960, 800, "peek hover at the finger");
        Check.Equal(h.Held.Count, 1, "one held-card lift");
        Check.Equal(h.Held[^1], new HeldCall("card-1", 960, 800, HeldMode.Peek), "peek raises the card");

        h.ClearSent();
        h.Held.Clear();
        h.TouchUp(1, 960, 800);
        Check.Equal(h.Held[^1], new HeldCall(null, 960, 800, HeldMode.Drag), "release clears the lift (id null)");
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "release un-focuses via a hover (no click)");
        // The release parks at the RESOLVED screen center (1920/2, 540),
        // NOT the old up-shift (800 − 560 = 240). 16:9 → the identity resolver → (960, 540).
        AssertCoord(h.Last, 960, 540, "peek-release parks at the resolved screen center");
        Check.That(!h.Sent.Exists(m => m.Kind == "click"), "a peek release never clicks");
    }

    private static void PeekReleaseCenterMapsThroughResolver()
    {
        // On a WIDENED stage the peek-release center must route through ResolveFresh, not be emitted raw. DesignWidth
        // 2520 → raw design center 1260; the resolver inverts a +300 paint shift → game X 960 (≠ the raw 1260).
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.DesignWidthFn = () => 2520;
        h.ResolveFreshFn = (x, y) => new ResolvedCoord(x - 300, y);
        h.TouchDown(1, 400, 800);
        h.Pump(Peek);
        h.ClearSent();
        h.Held.Clear();
        h.TouchUp(1, 400, 800);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "release un-focuses via a single center hover (no click)");
        AssertCoord(h.Last, 960, 540, "center routed through the resolver: 2520/2 − 300 = 960, Y 540");
    }

    private static void PeekUnfocusOffStillClearsLift()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.Options.UnfocusOnRelease = () => false;
        h.TouchDown(1, 960, 800);
        h.Pump(Peek);
        h.ClearSent();
        h.Held.Clear();
        h.TouchUp(1, 960, 800);
        Check.Equal(h.Held[^1], new HeldCall(null, 960, 800, HeldMode.Drag), "lift still cleared");
        Check.Equal(h.Sent.FindAll(m => m.Kind == "hover").Count, 0, "no up-shift hover when unfocusOnRelease off");
        Check.That(!h.Sent.Exists(m => m.Kind == "click"), "still no click");
    }

    private static void PeekConvertsToDragOnMove()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.TouchDown(1, 100, 100);
        h.Pump(Peek); // peek fires
        h.ClearSent();
        // Move past the drag threshold → the deferred-press drag path fires a real press.
        h.TouchMove(1, 500, 400);
        h.Pump(Peek + 1);
        Check.That(h.Sent.Exists(m => m.Kind == "click" && m.Pressed == true), "peek→drag: a real press fires");
        h.TouchUp(1, 500, 400);
        Check.That(h.Sent.Exists(m => m.Kind == "click" && m.Pressed == false), "peek→drag: a release fires (card drops)");
    }

    private static void PeekSecondFingerNoRightClick()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.TouchDown(1, 400, 300);
        h.Pump(Peek); // peek fires on finger 1
        h.ClearSent();
        h.TouchDown(2, 440, 300); // stray (folds into dragActive)
        h.TouchUp(1, 400, 300);
        h.TouchUp(2, 440, 300);
        Check.That(!h.Sent.Exists(m => m.Kind == "click" && m.Button == "right"), "no right-click when a second finger lands during a live peek");
    }

    private static void PeekNonCardDoesNotFire()
    {
        var h = new Harness { Targets = new[] { "not-a-card" }, IsCardFn = _ => false };
        h.TouchDown(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "primary down counts as a hover");
        h.Pump(Peek);
        Check.Equal(h.Sent.Count, 1, "no SECOND (peek) hover for a non-card");
        Check.Equal(h.Held.Count, 0, "no lift for a non-card");
    }

    private static void PeekRaiseOffDoesNotFire()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.Options.RaiseHeldCard = () => false;
        h.TouchDown(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "primary down-hover");
        h.Pump(Peek);
        Check.Equal(h.Sent.Count, 1, "no peek even armed when raiseHeldCard is off");
        Check.Equal(h.Held.Count, 0, "no lift when raiseHeldCard is off");
    }

    private static void ArmedCardReTouchDragsNotPeeks()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        // First tap arms card-1 (down-hover then arm-hover).
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "first tap: down-hover then arms card-1");
        h.ClearSent();
        h.Held.Clear();
        // Re-touch the armed card and hold past PEEK — the down-hover fires but NO peek (grab, not peek).
        h.TouchDown(1, 960, 540);
        h.Pump(Peek * 2);
        Check.Equal(h.Held.Count, 0, "no peek on an already-armed card");
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "only the primary down-hover, no peek focus hover");
        // Then drag it → a real press + release.
        h.TouchMove(1, 1200, 700);
        h.Pump(Peek * 2 + 1);
        h.TouchUp(1, 1200, 700);
        Check.That(h.Sent.Exists(m => m.Kind == "click" && m.Pressed == true), "re-touch drag presses");
        Check.That(h.Sent.Exists(m => m.Kind == "click" && m.Pressed == false), "re-touch drag releases");
    }

    private static void DifferentUnarmedCardStillPeeks()
    {
        var h = new Harness { IsCardFn = _ => true };
        // Arm card-1.
        h.Targets = new[] { "card-1" };
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        h.ClearSent();
        h.Held.Clear();
        // Hold on a DIFFERENT, unarmed card → the peek still fires.
        h.Targets = new[] { "card-2" };
        h.TouchDown(1, 200, 600);
        h.Pump(Peek);
        Check.Equal(h.Held[^1], new HeldCall("card-2", 200, 600, HeldMode.Peek), "a different unarmed card still peeks");
    }

    private static void TapToFocusOffPressesImmediately()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.Options.TapToFocus = () => false;
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540); // quick tap, before any peek
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "tapToFocus off → down-hover then a single tap presses immediately");
    }

    private static void PointerCancelDuringPeekClearsSilently()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.TouchDown(1, 960, 540);
        h.Pump(Peek); // peek live
        h.ClearSent();
        h.Held.Clear();
        h.M.PointerCancel(1, Peek + 1);
        Check.Equal(h.Held[^1], new HeldCall(null, 960, 540, HeldMode.Drag), "cancel clears the lift");
        Check.Equal(h.Sent.Count, 0, "cancel during a peek sends nothing (no click, no hover)");
    }

    // ================= tap-to-unselect =================
    // UNSELECT_ZONE_Y is 846 (design). A tap at design y=400 is ABOVE the line; y=1000 is BELOW it.

    private static void UnselectBelowLineRightClicks()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true };
        // Arm (above line), then commit (above line).
        h.TouchDown(1, 960, 400);
        h.TouchUp(1, 960, 400);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "down-hover then arm card-1 above the line");
        h.ClearSent();
        h.TouchDown(1, 960, 400, 300);
        h.TouchUp(1, 960, 400, 300);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "down-hover then commit/press card-1 above the line");

        // Tap BELOW the line — even landing on a different card → down-hover then a right-click cancel at that point.
        h.ClearSent();
        h.Targets = new[] { "card-2" };
        h.TouchDown(1, 600, 1000);
        h.TouchUp(1, 600, 1000);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:right:" }, "below-line tap after a press → down-hover + right-click cancel");
        AssertCoord(h.Last, 600, 1000, "cancel at the tap point");

        // State cleared: tapping card-2 above the line now ARMS it (down-hover + arm-hover).
        h.ClearSent();
        h.TouchDown(1, 600, 400);
        h.TouchUp(1, 600, 400);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "after cancel, a fresh tap arms again");
    }

    private static void UnselectArmedOnlyDoesNotCancel()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true };
        // A single tap only FOCUSES (arms), no press (down-hover + arm-hover).
        h.TouchDown(1, 960, 400);
        h.TouchUp(1, 960, 400);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "single tap arms only (down-hover + arm-hover)");
        // Tap below the line on another card → normal arm (no press happened), never a cancel.
        h.ClearSent();
        h.Targets = new[] { "card-2" };
        h.TouchDown(1, 600, 1000);
        h.TouchUp(1, 600, 1000);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "below-line tap after a bare focus → arm, not cancel");
    }

    private static void UnselectNothingPressedNormalTap()
    {
        var h = new Harness { Targets = Array.Empty<string>(), IsCardFn = _ => true };
        // Empty space, no prior interaction → the down-hover then a plain left click below the line.
        h.TouchDown(1, 600, 1000);
        h.TouchUp(1, 600, 1000);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "below-line tap with nothing pressed → down-hover + normal left click");
    }

    private static void UnselectSelfDisablesWhenCardGone()
    {
        var present = true;
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" ? present : true };
        // Two-step press card-1 (above the line).
        h.TouchDown(1, 960, 400);
        h.TouchUp(1, 960, 400); // arm
        h.TouchDown(1, 960, 400, 300); // past TapArmDebounceMs so this re-tap isn't swallowed
        h.TouchUp(1, 960, 400, 300); // press
        // The card plays and leaves the hand → isCard(card-1) flips false.
        present = false;
        h.ClearSent();
        h.Targets = Array.Empty<string>();
        h.TouchDown(1, 600, 1000);
        h.TouchUp(1, 600, 1000);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "pruned pressed card self-disables the latch → down-hover + normal click");
    }

    private static void UnselectTapToFocusOffSingleTapThenCancel()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true };
        h.Options.TapToFocus = () => false;
        // After the down-hover, a single tap presses immediately AND records the press.
        h.TouchDown(1, 960, 400);
        h.TouchUp(1, 960, 400);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "tapToFocus off: down-hover then a single tap presses");
        // A following below-line tap cancels it (down-hover then the right-click).
        h.ClearSent();
        h.Targets = new[] { "card-2" };
        h.TouchDown(1, 600, 1000);
        h.TouchUp(1, 600, 1000);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:right:" }, "below-line tap after the single-tap press → down-hover + right-click cancel");
    }

    // ================= hand-card gating =================

    private static void HandCardVerdictCapturedAtPressSurvivesReparent()
    {
        // A grabbed HAND card re-parents out of the hand mid-drag: the LIVE isHandCard flips false, but the drag was
        // captured at PRESS (true), so the lift keeps firing (card semantics survive the re-parent).
        var hand = true;
        var h = new Harness
        {
            Targets = new[] { "card-1" },
            IsCardFn = _ => true,
            IsHandCardFn = _ => hand,
        };
        h.TouchDown(1, 0, 0);     // captures HandCard = IsCard && IsHandCard = true
        hand = false;             // the grabbed card re-parents OUT of the hand (live verdict now false)
        h.TouchMove(1, 500, 500); // classify drag → heldTouchCardId uses the CAPTURED verdict, not a live re-check
        h.Pump(1);
        Check.That(
            h.Held.Exists(c => c.Id == "card-1" && c.Mode == HeldMode.Drag),
            "drag lift uses the press-captured hand verdict, so a re-parented card keeps lifting");

        // Contrast: a card that is NOT a hand card at press never lifts, even if isHandCard flips true live.
        var hand2 = false;
        var d = new Harness
        {
            Targets = new[] { "card-2" },
            IsCardFn = _ => true,
            IsHandCardFn = _ => hand2,
        };
        d.TouchDown(1, 0, 0);     // captures HandCard = false (a deck-dialog / reward card)
        hand2 = true;             // becomes a hand card live (irrelevant — the verdict is frozen at press)
        d.TouchMove(1, 500, 500); // classify drag
        d.Pump(1);
        Check.That(
            !d.Held.Exists(c => c.Id == "card-2"),
            "a non-hand card at press never lifts, even if the live verdict flips true");
    }

    // ================= onHeldCard =================

    private static void OnHeldCardStreamsThroughDragThenNull()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        h.TouchDown(1, 0, 0);
        Check.Equal(h.Held.Count, 0, "no lift until a gesture classifies");
        h.TouchMove(1, 960, 540); // classify drag → press at the START point
        h.Pump(1);
        h.TouchMove(1, 1400, 1000);
        h.Pump(2);
        h.TouchUp(1, 1400, 1000);
        var expected = new[]
        {
            new HeldCall("card-1", 0, 0, HeldMode.Drag),        // press, at the drag's START point
            new HeldCall("card-1", 960, 540, HeldMode.Drag),    // first drag-motion frame
            new HeldCall("card-1", 1400, 1000, HeldMode.Drag),  // second drag-motion frame
            new HeldCall(null, 1400, 1000, HeldMode.Drag),      // release (id null, mode moot)
        };
        Check.Equal(h.Held.Count, expected.Length, "four held-card calls");
        for (var i = 0; i < expected.Length; i++)
        {
            Check.Equal(h.Held[i], expected[i], $"held call {i}");
        }
    }

    private static void OnHeldCardNeverFiresForMouse()
    {
        var h = new Harness();
        h.MouseDown(0, 0, 0);
        h.MouseMove(960, 540);
        h.Pump(1);
        h.MouseMove(1400, 1000);
        h.Pump(2);
        h.MouseUp(0, 1400, 1000);
        Check.Equal(h.Held.Count, 0, "onHeldCard never fires for a mouse drag");
    }

    // ================= lifecycle =================

    private static void ResetClearsAllState()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = id => id == "card-1" };
        // Get into a live drag + a mid-flight peek arm on a fresh pointer, then Reset.
        h.MouseDown(0, 100, 100); // held mouse button
        h.TouchDown(2, 400, 400); // touch pointer tracked
        h.M.Reset();
        h.ClearSent();
        // After Reset: a mouse cancel finds no held button (nothing sent); a fresh tap two-steps from scratch.
        h.M.PointerCancel(0, 0);
        Check.Equal(h.Sent.Count, 0, "Reset cleared the held mouse button (cancel is a no-op)");
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "after Reset, a tap arms fresh: down-hover then arm-hover");
    }

    // ================= down-hover contract (touch-start counts as a hover) =================

    private static void PrimaryDownEmitsOneHoverAtDownPoint()
    {
        // The PRIMARY finger's down edge emits exactly ONE hover at the down point, sent DIRECTLY (no PumpFrame /
        // coalescer needed), whatever the gesture becomes.
        var h = new Harness { Targets = new[] { "card-1" } };
        h.TouchDown(1, 640, 360);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "primary down emits one hover, no frame pump needed");
        AssertCoord(h.Last, 640, 360, "down-hover at the down point");
        // A PumpFrame flush adds nothing (the pending slot was dropped on down — no duplicate at the same point).
        h.Pump(16);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "no duplicate hover on the next frame");
    }

    private static void SecondaryFingerDoesNotDownHover()
    {
        // Only the sole, non-ignored finger hovers: a SECOND (two-finger) finger and a stray finger never do.
        var h = new Harness { Targets = new[] { "card-1" } };
        h.TouchDown(1, 640, 360);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "primary hovers");
        h.TouchDown(2, 680, 360); // two-finger latch: secondary finger, no hover
        Check.Equal(h.Sent.Count, 1, "the second finger of a two-finger latch does not hover");

        // A stray finger arriving mid-drag also never hovers.
        var d = new Harness { Targets = Array.Empty<string>() };
        d.TouchDown(1, 0, 0);
        d.TouchMove(1, 500, 500); // classify drag (press)
        d.Pump(1);
        d.ClearSent();
        d.TouchDown(2, 700, 500); // stray finger during the drag
        Check.Equal(d.Sent.Count, 0, "a stray finger during a drag does not hover");
    }

    // ================= change 1: drag-release below the play line right-clicks (de-select) =================
    // PlayZone.Threshold(1080, dragStartY): baseLine 810. A grab at design-Y 800 (in the hand) → Min(810, 750) = 750,
    // so a drop at/below design-Y 750 cancels. The default Harness wires PlayZoneThreshold like the live InputRouter.

    private static void DragReleaseBelowLineRightClicksHandCard()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 960, 800);   // grab a HAND card
        h.TouchMove(1, 960, 900);   // classify drag (press at the start point 960,800; dragStartY = 800)
        h.Pump(1);
        h.TouchUp(1, 960, 900);     // drop BELOW the play line (900 >= threshold 750)
        Check.SequenceEqual(
            h.Sigs(),
            new[] { "hover::", "click:left:true", "hover::", "click:left:false", "click:right:" },
            "below-line drag-drop of a hand card: the left release is followed by a right-click cancel");
        AssertCoord(h.Last, 960, 900, "the right-click cancel lands at the drop point");
    }

    private static void DragReleaseAboveLineNoRightClick()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 960, 800);
        h.TouchMove(1, 960, 700);   // drag UP; dragStartY 800 → threshold 750
        h.Pump(1);
        h.TouchUp(1, 960, 700);     // release ABOVE the line (700 < 750)
        Check.Equal(Sig(h.Last), "click:left:false", "an above-line drop ends with the plain left release");
        Check.That(!h.Sent.Exists(m => m.Kind == "click" && m.Button == "right"), "no right-click above the line");
    }

    private static void DragReleaseBelowLineNonHandCardNoRightClick()
    {
        // A card by leaf that is NOT a hand card (a reward/deck card): the press-time verdict is false, so a below-
        // line drop never cancels (the below-line right-click is a HAND-card de-select only).
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.TouchDown(1, 960, 800);
        h.TouchMove(1, 960, 900);
        h.Pump(1);
        h.TouchUp(1, 960, 900);
        Check.Equal(Sig(h.Last), "click:left:false", "a non-hand card drop ends with the plain left release");
        Check.That(!h.Sent.Exists(m => m.Kind == "click" && m.Button == "right"), "no right-click for a non-hand card");
    }

    private static void PeekThenDragReleaseBelowLineRightClicks()
    {
        // A peek that converts to a drag still carries the press-time HAND-card verdict, so a below-line drop cancels.
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 960, 800);
        h.Pump(Peek);               // peek fires (focus + raise)
        h.TouchMove(1, 960, 900);   // convert to a drag (press at start; dragStartY 800 → threshold 750)
        h.Pump(Peek + 1);
        h.TouchUp(1, 960, 900);     // drop below the line
        Check.Equal(Sig(h.Last), "click:right:", "peek→drag→below-line drop ends with a right-click cancel");
        var clicks = h.Sent.FindAll(m => m.Kind == "click");
        Check.Equal(Sig(clicks[^2]), "click:left:false", "the right-click follows the left release");
    }

    private static void PurePeekReleaseBelowLineNoRightClick()
    {
        // A PURE peek (never a drag) releasing below the line takes the peek branch (no press), so it never right-clicks.
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 960, 900);   // hold still below the line
        h.Pump(Peek);               // peek fires
        h.TouchUp(1, 960, 900);     // release — a peek un-focus hover, never a click
        Check.That(!h.Sent.Exists(m => m.Kind == "click"), "a pure peek release below the line never clicks (no right-click)");
    }

    private static void TwoFingerTapSingleRightClickNoDoubleFire()
    {
        // A two-finger tap emits EXACTLY one right-click (the two-finger branch), never a second from the change-1
        // drag-release path — neither finger is ever `Pressed`, so the pressed branch is not reached.
        var h = new Harness();
        h.TouchDown(1, 800, 900);
        h.TouchDown(2, 880, 900);
        h.TouchUp(1, 800, 900);
        h.TouchUp(2, 880, 900);
        Check.Equal(h.Sent.FindAll(m => m.Kind == "click" && m.Button == "right").Count, 1, "exactly one right-click, no double-fire");
    }

    private static void ReparentedHandCardDragBelowLineStillRightClicks()
    {
        // The card re-parents OUT of the hand mid-drag (live IsHandCard flips false), but the below-line cancel uses
        // the PRESS-captured verdict (true), so the drop still right-clicks — matching the frozen-lift behaviour.
        var hand = true;
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => hand };
        h.TouchDown(1, 960, 800);   // captures HandCard = true
        hand = false;               // re-parents out of the hand (live verdict now false)
        h.TouchMove(1, 960, 900);   // classify drag
        h.Pump(1);
        h.TouchUp(1, 960, 900);     // drop below the line
        Check.Equal(Sig(h.Last), "click:right:", "a re-parented hand card still right-clicks below the line (frozen verdict)");
    }

    private static void UnwiredPlayZoneThresholdNeverRightClicks()
    {
        // Seam off (the callback null): the below-line drag-drop cancel is disabled — old behaviour (left release only).
        var h = new Harness(wirePlayZone: false) { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 960, 800);
        h.TouchMove(1, 960, 900);
        h.Pump(1);
        h.TouchUp(1, 960, 900);
        Check.Equal(Sig(h.Last), "click:left:false", "an unwired PlayZoneThreshold ends with the plain left release");
        Check.That(!h.Sent.Exists(m => m.Kind == "click" && m.Button == "right"), "no right-click when the seam is off");
    }

    // ================= R4 change 2 / R13: end-turn tap parks the cursor at screen CENTER =================
    // The END-TURN button is a *Button leaf → TouchTargetScan Block (id dropped), so a tap on it has empty p.Ids
    // (Targets = []) and lands in the top==null tap branch. EndTurnBoxAt returns its game-space box on that tap —
    // used ONLY to decide whether the tap landed on the button; R13 replaced the box-derived (centerX, MaxY+24)
    // parked point with the RESOLVED screen center (a below-button park still sat close enough to re-arm the
    // button's own long-press HoverTip after the turn ends).

    private static void EndTurnTapUnhoversBelowButton()
    {
        var h = new Harness { Targets = Array.Empty<string>() };
        h.EndTurnBoxAtFn = (_, _) => new EndTurnBox(1600, 980, 1880, 1060);
        h.TouchDown(1, 1740, 950);
        h.TouchUp(1, 1740, 950);
        Check.SequenceEqual(
            h.Sigs(),
            new[] { "hover::", "click:left:", "hover::" },
            "end-turn tap: down-hover, the click, THEN the un-hover in that order");
        // R13: screen center (DesignWidth/2, 540) — NOT the button's box-derived (centerX, MaxY+24) = (1740, 1079).
        AssertCoord(h.Last, 960, 540, "un-hover parks at the RESOLVED screen center");
    }

    private static void EndTurnUnhoverCenterRoutesThroughResolverOnWidenedStage()
    {
        // On a WIDENED stage the parked center must route through ResolveFresh, not be emitted raw — mirroring
        // PeekReleaseCenterMapsThroughResolver. DesignWidth 2520 → raw design center 1260; the resolver inverts a
        // +300 paint shift → game X 960 (≠ the raw 1260).
        var h = new Harness { Targets = Array.Empty<string>() };
        h.DesignWidthFn = () => 2520;
        h.ResolveFreshFn = (x, y) => new ResolvedCoord(x - 300, y);
        h.EndTurnBoxAtFn = (_, _) => new EndTurnBox(1600, 980, 1880, 1060);
        h.TouchDown(1, 1740, 950);
        h.TouchUp(1, 1740, 950);
        AssertCoord(h.Last, 960, 540, "center routed through the resolver: 2520/2 − 300 = 960, Y 540");
    }

    private static void NonEndTurnTapNoExtraHover()
    {
        // The tap didn't land on the end-turn button (hit-test returns null) → no extra hover, just the click.
        var h = new Harness { Targets = Array.Empty<string>() };
        h.EndTurnBoxAtFn = (_, _) => null;
        h.TouchDown(1, 300, 300);
        h.TouchUp(1, 300, 300);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "a non-end-turn tap sends no extra hover");
    }

    private static void EndTurnHoldPhaseNoHoverUntilTapEnd()
    {
        // The user CONSTRAINT: never move the cursor during the hold (long-press confirms on release). A still hold on
        // the end-turn button (a block button → no ids → no peek) sends only the down-hover; the un-hover fires only
        // AFTER the click on tap end.
        var h = new Harness { Targets = Array.Empty<string>() };
        h.EndTurnBoxAtFn = (_, _) => new EndTurnBox(1600, 980, 1880, 1060);
        h.TouchDown(1, 1740, 950);
        h.Pump(1000); // a long hold — no move, no peek deadline (empty ids)
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "during the hold only the down-hover — no cursor move");
        h.TouchUp(1, 1740, 950);
        Check.SequenceEqual(
            h.Sigs(),
            new[] { "hover::", "click:left:", "hover::" },
            "the un-hover fires only AFTER the click on tap end");
    }

    // ================= change 2: reward/deck cards arm-first at the machine level =================

    private static void RewardCardTapArmsThenCommits()
    {
        // A reward/deck card is now a touch target (change 2). At the machine level the arm→commit tap flow is not
        // gated on hand-card-ness, so tap 1 arms (a hover) and tap 2 commits (a click), exactly like any target.
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.TouchDown(1, 960, 540);
        h.TouchUp(1, 960, 540);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "tap 1 arms the reward card (down-hover + arm-hover, no click)");
        h.ClearSent();
        h.TouchDown(1, 960, 540, 300); // past TapArmDebounceMs so this re-tap isn't swallowed
        h.TouchUp(1, 960, 540, 300);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "tap 2 commits the reward card (down-hover + click)");
    }

    private static void RewardCardStillNoPeekNoLiftNoUnselect()
    {
        // A reward/deck card (IsCard true, IsHandCard false) never peeks, never drag-lifts, and never tap-unselects —
        // those card semantics stay HAND-card only (the machine's IsHandCard gates are untouched by change 2).
        // No peek:
        var peek = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        peek.TouchDown(1, 960, 540);
        peek.Pump(Peek);
        Check.Equal(peek.Held.Count, 0, "a reward card never peeks (no lift)");

        // No drag-lift (heldTouchCardId stays null → only a null OnHeldCard, never the reward id):
        var drag = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        drag.TouchDown(1, 100, 100);
        drag.TouchMove(1, 600, 900);
        drag.Pump(1);
        drag.TouchUp(1, 600, 900);
        Check.That(!drag.Held.Exists(c => c.Id == "reward-1"), "a reward card never drag-lifts");

        // No tap-unselect: press the reward card, then a below-line tap is a NORMAL tap (the unselect gate needs a
        // hand card).
        var uns = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        uns.Options.TapToFocus = () => false; // single tap presses immediately, recording the press
        uns.TouchDown(1, 960, 400);
        uns.TouchUp(1, 960, 400); // press recorded
        uns.ClearSent();
        uns.TouchDown(1, 600, 1000);
        uns.TouchUp(1, 600, 1000);
        Check.SequenceEqual(uns.Sigs(), new[] { "hover::", "click:left:" }, "a reward card below-line tap is a normal left click, never an unselect right-click");
    }

    // ================= #12: single-tap selection in a from-hand card-choice dialog =================
    // HandChoiceActive true = a discard/exhaust/enchant-from-hand dialog is up. A HAND card then selects with ONE tap
    // (no arm-first), and the below-line unselect right-click is suppressed. Reward/deck cards + choice-inactive keep
    // arm-first.

    private static void ChoiceActiveSingleTapClicksHandCard()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.HandChoiceActiveFn = () => true;
        h.TouchDown(1, 960, 400);
        h.TouchUp(1, 960, 400);
        // A SINGLE tap commits immediately (down-hover + click), not arm-first (down-hover + arm-hover).
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "choice dialog: a hand-card single tap clicks");
        AssertCoord(h.Last, 960, 400, "click at the tap point");
    }

    private static void ChoiceActiveBelowLineTapClicksNotRightClicks()
    {
        // A choose-2 dialog: after selecting one card, a SECOND selection tapped BELOW the unselect line must be a
        // normal left-click (select), NOT a right-click cancel — the below-line unselect is suppressed while active.
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.HandChoiceActiveFn = () => true;
        h.TouchDown(1, 960, 400);
        h.TouchUp(1, 960, 400); // first selection (single tap → click, records nothing to latch)
        h.ClearSent();
        h.Targets = new[] { "card-2" };
        h.TouchDown(1, 600, 1000); // second selection, BELOW the line
        h.TouchUp(1, 600, 1000);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:left:" }, "below-line 2nd selection clicks, not a right-click cancel");
        Check.That(!h.Sent.Exists(m => m.Kind == "click" && m.Button == "right"), "no unselect right-click while a choice dialog is active");
    }

    private static void ChoiceActiveNonHandCardStillArmFirst()
    {
        // A NON-hand card (reward/deck) tapped WHILE a choice dialog is up still arms first — the single-tap bypass is
        // HAND-card only (the frozen press verdict gates it).
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.HandChoiceActiveFn = () => true;
        h.TouchDown(1, 960, 400);
        h.TouchUp(1, 960, 400);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "a non-hand card still arms first in a choice dialog");
    }

    private static void ChoiceInactiveArmFirstPreserved()
    {
        // No dialog → a hand card arms first.
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 960, 400);
        h.TouchUp(1, 960, 400);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "no dialog → hand card arms first (arm-first preserved)");
    }

    // ================= #13: long-press on a NON-hand card = right click =================
    // A non-hand card is IsCard true + IsHandCard false (reward / shop card / card-grid card). A still hold past
    // PeekMs right-clicks it at the FRESH-resolved start point; the release is silent.

    private static void LongPressNonHandCardRightClicks()
    {
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.TouchDown(1, 500, 300);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "the down-hover; the right-click deadline is pending");
        h.Pump(LongPress);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:right:" }, "long-press → the down-hover then a right-click");
        AssertCoord(h.Last, 500, 300, "the right-click lands at the fresh-resolved start point");
        Check.Equal(h.Held.Count, 0, "a non-hand card long-press never lifts");
    }

    private static void LongPressDoesNotFireAtPeekMsOnlyAtLongPressMs()
    {
        // R1: the NON-hand-card leg has its OWN, longer threshold — a still hold at PeekMs (100ms, the hand-card
        // peek's threshold) must NOT yet fire; only once LongPressMs (300ms) elapses does it right-click.
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.TouchDown(1, 500, 300);
        h.ClearSent();
        h.Pump(Peek);
        Check.Equal(h.Sent.Count, 0, "still too early at PeekMs — the non-hand-card leg hasn't fired yet");
        h.Pump(LongPress);
        Check.SequenceEqual(h.Sigs(), new[] { "click:right:" }, "past LongPressMs the right-click fires");
    }

    private static void LongPressReleaseEmitsNothing()
    {
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.TouchDown(1, 500, 300);
        h.Pump(LongPress); // fires the right-click
        h.ClearSent();
        h.TouchUp(1, 500, 300);
        Check.Equal(h.Sent.Count, 0, "the release after a fired long-press emits nothing (no click, no arm hover)");
    }

    private static void LongPressWorksWithRaiseHeldCardOff()
    {
        // #13 is decoupled from the cosmetic-lift toggle: it right-clicks even when RaiseHeldCard is OFF.
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.Options.RaiseHeldCard = () => false;
        h.TouchDown(1, 500, 300);
        h.Pump(LongPress);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:right:" }, "long-press right-clicks with RaiseHeldCard off");
    }

    private static void LongPressFiresOnArmedTarget()
    {
        // The NON-hand-card right-click leg is NOT gated on the armed card (unlike the hand-card peek): a long-press on
        // an ALREADY-armed reward card still right-clicks.
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.TouchDown(1, 500, 300);
        h.TouchUp(1, 500, 300); // arm reward-1
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "hover::" }, "tap 1 arms the reward card");
        h.ClearSent();
        h.TouchDown(1, 500, 300);
        h.Pump(LongPress);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::", "click:right:" }, "a long-press on the armed reward card still right-clicks");
    }

    private static void LongPressNoDragAfterFire()
    {
        // Once the long-press right-click fires, later movement is neither a drag nor a hover (LongPressed is terminal).
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.TouchDown(1, 500, 300);
        h.Pump(LongPress);
        h.ClearSent();
        h.TouchMove(1, 900, 700); // large move
        h.Pump(LongPress + 16);
        Check.Equal(h.Sent.Count, 0, "no press / drag / hover after a fired long-press");
        h.TouchUp(1, 900, 700);
        Check.Equal(h.Sent.Count, 0, "the release is still silent after moving");
    }

    private static void LongPressSecondFingerStray()
    {
        // A second finger arriving after a fired long-press is a stray (dragActive folds in LongPressed): no down-hover,
        // no two-finger right-click.
        var h = new Harness { Targets = new[] { "reward-1" }, IsCardFn = _ => true, IsHandCardFn = _ => false };
        h.TouchDown(1, 500, 300);
        h.Pump(LongPress); // fires the right-click on finger 1
        h.ClearSent();
        h.TouchDown(2, 560, 300); // stray
        h.TouchUp(1, 500, 300);
        h.TouchUp(2, 560, 300);
        Check.That(!h.Sent.Exists(m => m.Kind == "click" && m.Button == "right"), "no extra right-click from a stray second finger");
        Check.That(!h.Sent.Exists(m => m.Kind == "hover"), "the stray second finger never down-hovers");
    }

    private static void LongPressHandCardStillPeeksNotRightClicks()
    {
        // Regression: a HAND card long-press still PEEKS (focus + lift), never right-clicks (the NonHandCard leg is
        // exclusive to non-hand cards).
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 960, 800);
        h.Pump(Peek);
        Check.Equal(h.Held.Count, 1, "a hand card still peeks (a lift)");
        Check.Equal(h.Held[^1].Mode, HeldMode.Peek, "peek mode");
        Check.That(!h.Sent.Exists(m => m.Kind == "click"), "a hand-card long-press never clicks (peek, not right-click)");
    }

    private static void LongPressNonCardTargetNoRightClick()
    {
        // A non-card target (an event option / relic — IsCard false) is neither a hand card nor a non-hand card, so a
        // long-press does nothing (only the down-hover).
        var h = new Harness { Targets = new[] { "opt-1" }, IsCardFn = _ => false, IsHandCardFn = _ => false };
        h.TouchDown(1, 500, 300);
        h.Pump(Peek);
        Check.SequenceEqual(h.Sigs(), new[] { "hover::" }, "a non-card target long-press does nothing (no right-click)");
        Check.Equal(h.Held.Count, 0, "no lift");
    }

    // ================= change 3: a drag begun OFF a card raises the hand card it moves onto =================
    // The latch is band-gated on design-Y >= UnselectZoneY (846) to bound the per-frame hit-test cost.

    private static void DragIntoHandCardLatchesLift()
    {
        var h = new Harness { Targets = Array.Empty<string>(), IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 100, 900);   // press on EMPTY space (no card under it → HandCard false, nothing latched)
        h.Targets = new[] { "card-1" }; // the drag now moves over a hand card
        h.TouchMove(1, 200, 900);   // classify drag (heldTouchCardId still null — press had no card)
        h.Pump(1);                  // FlushHover: Y 900 >= 846, a card under the finger → latch the lift
        Check.That(h.Held.Exists(c => c.Id == "card-1" && c.Mode == HeldMode.Drag), "the drag latches the hand card it moved onto");
    }

    // (a) A PROBE latch FOLLOWS the finger: crossing onto a DIFFERENT hand card switches the lift (old unlifts).
    private static void DragProbeLatchSwitchesToSecondCard()
    {
        var h = new Harness { Targets = Array.Empty<string>(), IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 100, 900);   // press on EMPTY space
        h.Targets = new[] { "card-1" };
        h.TouchMove(1, 200, 900);   // classify drag (nothing latched at press)
        h.Pump(1);                  // probe-latch card-1
        Check.Equal(h.Held[^1].Id, "card-1", "the probe latches the first hand card");
        h.Held.Clear();
        h.Targets = new[] { "card-2" }; // the finger crosses onto a DIFFERENT hand card
        h.TouchMove(1, 300, 900);
        h.Pump(2);
        Check.Equal(h.Held[^1].Id, "card-2", "the probe lift SWITCHES to the second hand card the finger crosses onto");
    }

    // (b) A PROBE latch CLEARS when the finger leaves every hand card (within the band).
    private static void DragProbeLatchClearsOnEmpty()
    {
        var h = new Harness { Targets = Array.Empty<string>(), IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 100, 900);
        h.Targets = new[] { "card-1" };
        h.TouchMove(1, 200, 900);
        h.Pump(1);                  // probe-latch card-1
        h.Held.Clear();
        h.Targets = Array.Empty<string>(); // the finger moves off every hand card (still below the band)
        h.TouchMove(1, 300, 900);
        h.Pump(2);
        Check.Equal(h.Held[^1].Id, null, "the probe lift CLEARS when the finger leaves every hand card");
    }

    // (c) A press GRAB stays STICKY: dragging over another hand card does NOT switch the lift (game parity).
    private static void DragPressGrabDoesNotSwitchOverAnotherCard()
    {
        var h = new Harness { Targets = new[] { "card-1" }, IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 200, 900);   // press ON card-1 (HandCard verdict true → a press GRAB)
        h.TouchMove(1, 260, 900);   // classify drag → press-grab card-1
        h.Pump(1);
        Check.Equal(h.Held[^1].Id, "card-1", "the press grab lifts card-1");
        h.Held.Clear();
        h.Targets = new[] { "card-2" }; // the finger crosses onto a different hand card
        h.TouchMove(1, 320, 900);
        h.Pump(2);
        Check.Equal(h.Held[^1].Id, "card-1", "a PRESS grab stays sticky — it does NOT switch to card-2");
    }

    private static void DragIntoHandCardGatedByToggle()
    {
        var h = new Harness { Targets = Array.Empty<string>(), IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.Options.RaiseHeldCard = () => false; // the raise toggle is OFF
        h.TouchDown(1, 100, 900);
        h.Targets = new[] { "card-1" };
        h.TouchMove(1, 200, 900);
        h.Pump(1);
        Check.That(!h.Held.Exists(c => c.Id == "card-1"), "no latch when raiseHeldCard is off");
    }

    private static void DragIntoHandCardAboveBandDoesNotLatch()
    {
        var h = new Harness { Targets = Array.Empty<string>(), IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 100, 400);
        h.Targets = new[] { "card-1" };
        h.TouchMove(1, 200, 400);   // the whole drag stays ABOVE the un-select band (Y 400 < 846)
        h.Pump(1);
        Check.That(!h.Held.Exists(c => c.Id == "card-1"), "no latch above the band-gate (the per-frame probe is skipped)");
    }

    // (d) Re-classification is band-gated too: once a probe lift is active, rising ABOVE the band skips the
    // per-frame hit-test, so the lift neither switches nor clears there (the phone-CPU cost stays bounded).
    private static void DragProbeLatchAboveBandNotReclassified()
    {
        var h = new Harness { Targets = Array.Empty<string>(), IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 100, 900);
        h.Targets = new[] { "card-1" };
        h.TouchMove(1, 200, 900);
        h.Pump(1);                  // probe-latch card-1 (below the band)
        h.Held.Clear();
        h.Targets = Array.Empty<string>(); // the finger leaves the card AND rises above the band
        h.TouchMove(1, 300, 400);   // design Y 400 < 846 → re-classification skipped
        h.Pump(2);
        Check.Equal(h.Held[^1].Id, "card-1", "above the band the probe lift is NOT re-classified → it stays lifted");
    }

    private static void DragStartedOffCardLatchedThenReleasedBelowLineNoRightClick()
    {
        // A drag that STARTED off a card latched a lift via change 3; its press-time HandCard verdict is false, so a
        // below-line release never right-clicks (change 1's gate is the frozen press verdict, not the latched lift).
        var h = new Harness { Targets = Array.Empty<string>(), IsCardFn = _ => true, IsHandCardFn = _ => true };
        h.TouchDown(1, 100, 900);   // press off any card
        h.Targets = new[] { "card-1" };
        h.TouchMove(1, 200, 900);   // classify drag (HandCard false)
        h.Pump(1);                  // latch card-1
        h.TouchMove(1, 250, 950);
        h.Pump(2);
        h.TouchUp(1, 250, 950);     // drop below the line
        Check.Equal(Sig(h.Last), "click:left:false", "a drag begun off a card ends with the plain left release");
        Check.That(!h.Sent.Exists(m => m.Kind == "click" && m.Button == "right"), "no right-click (press-time HandCard was false)");
    }
}
