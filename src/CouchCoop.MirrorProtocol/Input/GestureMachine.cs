using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.MirrorProtocol.Input;

// The native, coordinate-only gesture engine — a 1:1 behavioural port of frontend/src/mirror/inputCapture.ts.
// It turns pre-mapped design-space (1920x1080) pointer/touch/wheel/key events into upstream InputMessages, held-
// card lift signals, peeks, taps, and two-finger cancels. WS-M's InputRouter builds a GestureOptions +
// GestureCallbacks and feeds this engine; WS-L (this file) owns the state machine.
//
// COORDINATE SEAM (M2). Every x/y arrives in DESIGN space (the InputRouter has already inverted the letterbox). The
// single indirection where a WIDENED (>16:9) stage re-resolves (and freezes) the coordinate is the GestureCallbacks
// resolver family — <see cref="GestureCallbacks.ResolveFresh"/> / ResolvePress / ResolveFrozen / ResolveHover /
// ClearFreeze, each named after the inputCapture.ts function it ports (resolveSent / freezeAt / frozenCoord /
// hoverCoord / clearFreeze). On 16:9 the resolvers are IDENTITY, so coordinates already sit in design == game space
// and the whole seam is a pass-through (WS-Q wires the real resolvers). `_frozen` tracks that a press has frozen the
// field affine, so the coalesced hover flush replays the frozen coord during a held gesture (inputCapture flushHover
// L412) instead of re-resolving under the finger.
//
// Other differences INHERENT to a coordinate-only native port:
//   * NO WALL CLOCK / TIMERS. `nowMs` is passed in on every event; the long-press PEEK is a DEADLINE evaluated in
//     <see cref="PumpFrame"/> (which also flushes the coalesced hover), never a timer.
//   * KEYBOARD FILTERING (event.repeat / editable-field focus) and per-message requestId sequencing live UPSTREAM
//     in WS-M (the DOM event layer / the connection), exactly as the web splits inputCapture from mirrorClient.
public sealed class GestureMachine
{
    // Placeholder id on every emitted InputMessage; WS-M's Send (ConnectionCoordinator.SendInput) stamps the real
    // per-message requestId — mirroring how mirrorClient.sendInput wraps the payload with `input:${inputSequence}`.
    // The engine deliberately owns no sequence state (inputCapture never touches requestId either).
    private const string InputRequestId = "";

    // The fixed GAME-space screen height (1920×1080). Used to build the peek-release center (Y = 540) and to clamp the
    // change-2 below-button un-hover to the last on-screen row (DesignHeight − 1 = 1079).
    private const double DesignHeight = 1080;

    private readonly GestureOptions _options;
    private readonly GestureCallbacks _cb;

    // ---- MOUSE gesture state (the touch path never enters this) ----
    private string? _heldButton; // "left" | "right" | "middle" | null
    private double _mouseX;
    private double _mouseY;

    // ---- coalesced hover ----
    private ResolvedCoord? _pending; // latest pointer position awaiting the once-per-frame flush

    // ---- widened-stage freeze (M2) ----
    // True while a press has frozen the field affine (set by every Press resolve, cleared by ClearFreeze). Selects
    // the FROZEN vs plain-HOVER resolver in the coalesced hover flush (inputCapture flushHover L412). Identity on 16:9.
    private bool _frozen;

    // ---- TOUCH gesture state (mouse never touches these) ----
    private readonly Dictionary<long, TouchPointer> _touchPointers = new();
    private string? _heldTouchCardId; // the widget a classified DRAG holds (drives onHeldCard); null = none
    // Latch ORIGIN of _heldTouchCardId: true only while it came from the FlushHover PROBE (a drag begun OFF a card
    // that crossed onto a hand card), false when it came from a press/peek GRAB (the finger went down ON the card).
    // A PROBE latch keeps RE-CLASSIFYING under the finger every active-drag frame — it switches to a DIFFERENT hand
    // card the finger crosses onto and CLEARS off every hand card; a press/peek GRAB stays STICKY until release (the
    // game's own grab parity). Only meaningful alongside a non-null _heldTouchCardId (both reset together). Web twin:
    // inputCapture.ts `heldFromProbe`.
    private bool _heldFromProbe;
    private string? _armedRootId;     // a widget focused by a prior tap (re-tap commits)
    // R16: the nowMs at which _armedRootId was last (re)armed — a re-tap of the SAME widget within
    // _options.TapArmDebounceMs of THIS timestamp is treated as an accidental double-tap (see the commit branch of
    // OnTouchUp). Only meaningful alongside a non-null _armedRootId. Web twin: inputCapture.ts `armedAtMs`.
    private double _armedAtMs;
    private string? _pressedRootId;   // a widget committed by a press (arms tap-to-unselect)
    private bool _twoFinger;
    private bool _twoFingerMoved;
    private double _twoFingerX;
    private double _twoFingerY;
    // Two-finger SCROLL-WHEEL state. Once the gesture is a recognized two-finger drag (past TwoFingerCancelDesign),
    // the vertical CENTROID drift is turned into chunky wheel ticks. `_twoFingerPrevCentroidY` is the centroid Y at
    // the previous move sample (so each move contributes an incremental delta) and `_twoFingerAccumY` is the unspent
    // delta since the last emitted tick (a full step is subtracted per tick, the remainder carried).
    private double _twoFingerAccumY;
    private double _twoFingerPrevCentroidY;

    public GestureMachine(GestureOptions options, GestureCallbacks callbacks)
    {
        _options = options;
        _cb = callbacks;
    }

    // ===== edge-driven events =====

    public void PointerDown(long id, PointerKind kind, int button, double x, double y, double nowMs)
    {
        if (kind == PointerKind.Touch)
        {
            OnTouchDown(id, x, y, nowMs);
        }
        else
        {
            OnMouseDown(button, x, y);
        }
    }

    public void PointerMove(long id, PointerKind kind, double x, double y, double nowMs)
    {
        if (kind == PointerKind.Touch)
        {
            OnTouchMove(id, x, y);
        }
        else
        {
            OnMouseMove(x, y);
        }
    }

    public void PointerUp(long id, PointerKind kind, int button, double x, double y, double nowMs)
    {
        if (kind == PointerKind.Touch)
        {
            OnTouchUp(id, x, y, nowMs);
        }
        else
        {
            OnMouseUp(button, x, y);
        }
    }

    // No PointerKind on cancel (a stolen capture): route by whether the id is a tracked touch pointer; otherwise
    // it retracts a held MOUSE button. The position is stale, so both paths replay the last-known coordinate.
    public void PointerCancel(long id, double nowMs)
    {
        if (_touchPointers.ContainsKey(id))
        {
            OnTouchCancel(id);
        }
        else
        {
            OnMouseCancel();
        }
    }

    public void Wheel(bool up, double x, double y, double nowMs)
    {
        // One Godot wheel-button tick per event (full press+release, no held mask). Zero-delta filtering lives in
        // WS-M's DOM layer — a wheel that reaches here is a real tick.
        SendFullClick(up ? "wheel-up" : "wheel-down", _cb.ResolveFresh(x, y));
    }

    public void Key(string code, string modifiersCsv)
    {
        // The engine forwards the browser KeyboardEvent.code + the pre-joined modifiers csv. Empty csv ⇒ omit the
        // field (null), matching the web's `modifiers || undefined`. Repeat / editable-focus filtering is WS-M's.
        _cb.Send(new InputMessage(
            InputRequestId,
            "key",
            Key: code,
            Modifiers: string.IsNullOrEmpty(modifiersCsv) ? null : modifiersCsv));
    }

    // ===== per-frame tick: due-peek deadlines, then the coalesced hover flush =====

    public void PumpFrame(double nowMs)
    {
        if (_touchPointers.Count > 0)
        {
            foreach (var pointerId in _touchPointers.Keys.ToArray())
            {
                FirePeekIfDue(pointerId, nowMs);
            }
        }

        FlushHover();
    }

    public void Reset()
    {
        _heldButton = null;
        _mouseX = 0;
        _mouseY = 0;
        _pending = null;
        _frozen = false;
        _touchPointers.Clear();
        _heldTouchCardId = null;
        _heldFromProbe = false;
        _armedRootId = null;
        _armedAtMs = 0;
        _pressedRootId = null;
        _twoFinger = false;
        _twoFingerMoved = false;
        _twoFingerX = 0;
        _twoFingerY = 0;
        _twoFingerAccumY = 0;
        _twoFingerPrevCentroidY = 0;
    }

    // ===== MOUSE path =====

    private void OnMouseDown(int button, double x, double y)
    {
        var name = ButtonName(button);
        if (name is null)
        {
            return;
        }

        _mouseX = x;
        _mouseY = y;
        _heldButton = name;
        _pending = null; // a queued hover would land at the pre-press position; drop it
        // freezeAt: a widened stage freezes the press-time field affine here (ResolvePress; identity on 16:9).
        _frozen = true;
        SendPress(name, _cb.ResolvePress(x, y));
    }

    private void OnMouseMove(double x, double y)
    {
        _mouseX = x;
        _mouseY = y;
        ScheduleHover(x, y);
    }

    private void OnMouseUp(int button, double x, double y)
    {
        var name = ButtonName(button) ?? _heldButton;
        _mouseX = x;
        _mouseY = y;
        if (name is not null)
        {
            // designCoord: a release resolves FRESH for exact drop targeting, then the freeze clears.
            SendRelease(name, _cb.ResolveFresh(x, y));
        }

        _heldButton = null;
        DoClearFreeze();
    }

    private void OnMouseCancel()
    {
        if (_heldButton is not { } button)
        {
            return;
        }

        // The position is stale (capture stolen), so replay the last-known point (frozenCoord in the web).
        SendRelease(button, _cb.ResolveFrozen(_mouseX, _mouseY));
        _heldButton = null;
        DoClearFreeze();
    }

    // ===== TOUCH path =====

    private void OnTouchDown(long id, double x, double y, double nowMs)
    {
        _pending = null; // drop any queued hover so a stale pre-touch position isn't sent

        // A finger arriving while a drag OR a live peek OR a fired long-press is underway (or as a 3rd+ touch) is a stray.
        var dragActive = _touchPointers.Values.Any(p => p.Moved || p.Pressed || p.Peeking || p.LongPressed);
        var pointer = new TouchPointer
        {
            StartX = x,
            StartY = y,
            LastX = x,
            LastY = y,
            Ids = _cb.TargetsAt(x, y),
            Moved = false,
            Pressed = false,
            Ignore = dragActive || _twoFinger || _touchPointers.Count >= 2,
            Peeking = false,
            PeekDeadline = null,
        };
        // Capture the HAND-card verdict of the top hit ONCE, here at press. Every card gate for this gesture reads
        // this frozen value, so a grabbed hand card that re-parents out of the hand keeps its card semantics — and
        // the reconcile-time re-classification (TargetsAt/ComputeTouchInfo re-running per frame, which would stop
        // stamping a re-parented card) is MOOT for the in-flight gesture, since Ids + HandCard were both taken at
        // press and never re-read.
        pointer.HandCard = pointer.Ids.Count > 0 && _cb.IsCard(pointer.Ids[0]) && _cb.IsHandCard(pointer.Ids[0]);
        // #13: a card that is NOT a hand card (reward / shop card / card-grid card). Frozen here alongside HandCard.
        pointer.NonHandCard = pointer.Ids.Count > 0 && _cb.IsCard(pointer.Ids[0]) && !pointer.HandCard;
        _touchPointers[id] = pointer;

        // Touch-start counts as a HOVER: on the PRIMARY finger's down edge, immediately update the game's pointer
        // state at the down point — sent DIRECTLY (SendHover, not the coalesced FlushHover; the down edge must not
        // wait a frame), resolved FRESH (ResolveFresh, the native port of the web's designCoord). It fires no
        // matter what the gesture becomes (tap, drag, or peek); everything downstream (peek deadline, drag
        // classification, tap-arm, tap-to-unselect, two-finger right-click) is unchanged — the peek/arm are simply
        // no longer the FIRST hover of the gesture. Only the sole, non-ignored finger hovers: a SECONDARY finger (a
        // two-finger latch) or a stray finger never does.
        if (!pointer.Ignore && _touchPointers.Count == 1)
        {
            SendHover(_cb.ResolveFresh(x, y));
        }

        // Exactly two clean fingers (no drag in progress) → arm a two-finger right-click, fired on lift.
        if (!dragActive && _touchPointers.Count == 2)
        {
            var starts = _touchPointers.Values.Where(p => !p.Ignore).ToList();
            _twoFinger = true;
            _twoFingerMoved = false;
            _twoFingerX = starts.Average(p => p.StartX);
            _twoFingerY = starts.Average(p => p.StartY);
            // Seed the scroll-wheel accumulator: the latch centroid is the reference for the first vertical delta.
            _twoFingerAccumY = 0;
            _twoFingerPrevCentroidY = _twoFingerY;
        }

        // Long-press deadline arm for a lone clean finger with a target under it. Two legs (the DEADLINE fires in
        // PumpFrame; FirePeekIfDue dispatches which leg):
        //   * HAND card → a PEEK (focus + cosmetic lift), gated on the live raiseHeldCard toggle and NOT the
        //     already-armed card (re-touching a focused card is a grab, not a peek). Fires at PeekMs (100ms).
        //   * NON-hand card (#13) → a right-click, decoupled from raiseHeldCard (it fires whether or not the lift is
        //     on), gated only on the LongpressRclick switch. Never for the already-armed card either (a re-tap
        //     commits). R1: fires at the LONGER LongPressMs (500ms) — its own threshold, separate from the hand-card
        //     peek — so an ordinary lingering reward/shop tap can't accidentally register as a long-press.
        if (!pointer.Ignore
            && !dragActive
            && _touchPointers.Count == 1
            && pointer.Ids.Count > 0
            && ((pointer.HandCard && pointer.Ids[0] != _armedRootId && _options.RaiseHeldCard())
                || pointer.NonHandCard))
        {
            pointer.PeekDeadline = nowMs + (pointer.NonHandCard ? _options.LongPressMs : _options.PeekMs);
        }
    }

    private void OnTouchMove(long id, double x, double y)
    {
        if (!_touchPointers.TryGetValue(id, out var p) || p.Ignore)
        {
            return;
        }

        p.LastX = x;
        p.LastY = y;

        // #13: a fired long-press right-click is terminal — later movement is neither a drag nor a hover (the finger is
        // just being lifted off). Keep tracking Last for a coordinate-less cancel, but classify nothing.
        if (p.LongPressed)
        {
            return;
        }

        // Design-space finger travel from the start point (a translation cancels in the delta).
        var moveX = x - p.StartX;
        var moveY = y - p.StartY;
        var dist = Math.Sqrt((moveX * moveX) + (moveY * moveY));

        if (_twoFinger)
        {
            if (dist >= _options.TwoFingerCancelDesign)
            {
                _twoFingerMoved = true; // a real pinch/scroll — the lift will emit nothing
            }

            // Once it's a recognized two-finger drag (not a pinch/tap), turn vertical CENTROID drift into wheel ticks.
            if (_twoFingerMoved)
            {
                EmitTwoFingerWheel();
            }

            return;
        }

        if (!p.Moved)
        {
            if (dist < _options.DragThresholdDesign)
            {
                return; // still within tap slop — keep deferring
            }

            // Classify as a drag: fire the deferred press at the START point, then stream frozen-shift drag-motion.
            // A peek that starts to move routes through here — clear its deadline + flag first.
            p.PeekDeadline = null;
            p.Peeking = false;
            p.Moved = true;
            p.Pressed = true;
            _frozen = true; // freezeAt: the held drag freezes the press-time field affine (identity on 16:9)
            var pressCoord = _cb.ResolvePress(p.StartX, p.StartY);
            p.DragStartY = pressCoord.Y; // grab-point design-Y for the below-line play-zone cancel (change 1)
            // Only a press-captured HAND card lifts. Using the frozen verdict (not a live re-check) keeps the lift
            // through a mid-drag re-parent out of the hand; a non-hand target reports null (the sink lifts nothing).
            _heldTouchCardId = p.HandCard ? p.Ids[0] : null;
            _heldFromProbe = false; // a press GRAB (finger went down ON the card) — sticky, never re-classified
            _cb.OnHeldCard(_heldTouchCardId, pressCoord.X, pressCoord.Y, HeldMode.Drag);
            SendPress("left", pressCoord);
        }

        ScheduleHover(x, y);
    }

    private void OnTouchUp(long id, double x, double y, double nowMs)
    {
        if (!_touchPointers.TryGetValue(id, out var p))
        {
            return;
        }

        p.PeekDeadline = null; // clearPeekTimer
        _touchPointers.Remove(id);

        if (p.Ignore)
        {
            // Stray finger — produced nothing; tidy up two-finger bookkeeping when the stage clears.
            if (_touchPointers.Count == 0)
            {
                _twoFinger = false;
                _twoFingerMoved = false;
            }

            return;
        }

        // #13: a fired long-press right-click already emitted everything it will; the lift is silent (never a click,
        // never an arm). Tidy the two-finger bookkeeping when the stage clears, like the stray-finger branch.
        if (p.LongPressed)
        {
            if (_touchPointers.Count == 0)
            {
                _twoFinger = false;
                _twoFingerMoved = false;
            }

            return;
        }

        if (p.Pressed)
        {
            // A drag was underway: release where the finger lifted, clear the lift + unselect latch.
            var releaseCoord = _cb.ResolveFresh(x, y);
            DoClearFreeze();
            _heldTouchCardId = null;
            _heldFromProbe = false;
            _cb.OnHeldCard(null, releaseCoord.X, releaseCoord.Y, HeldMode.Drag); // mode moot when id null
            _pressedRootId = null;
            SendRelease("left", releaseCoord);
            // A HAND card dragged and DROPPED below its play-zone floor is the game's cancel: after the left release,
            // fire a right-click at the drop point so the card de-selects. Gated on the PRESS-TIME HandCard verdict
            // (frozen — a grabbed card re-parents out of the hand mid-drag, so a live re-check would wrongly say
            // false) AND a wired PlayZoneThreshold (null = feature off). Arrow/targeting state is irrelevant by
            // design — a below-line release always cancels. A drag that started OFF a card (HandCard == false, even
            // if it later latched a lift via FlushHover) never right-clicks here.
            if (p.HandCard
                && _cb.PlayZoneThreshold is { } playZoneThreshold
                && releaseCoord.Y >= playZoneThreshold(p.DragStartY))
            {
                SendFullClick("right", releaseCoord);
            }

            return;
        }

        if (p.Peeking)
        {
            // A long-press peek lifting: focused + raised but NEVER pressed. Clear the lift + any arm; NO click.
            // Optionally un-focus by hovering straight up off the hand (a card-free point).
            _heldTouchCardId = null;
            _heldFromProbe = false;
            var coord = _cb.ResolveFresh(x, y);
            DoClearFreeze();
            _cb.OnHeldCard(null, coord.X, coord.Y, HeldMode.Drag); // mode moot when id null
            _armedRootId = null;
            _pressedRootId = null;
            if (_options.UnfocusOnRelease())
            {
                // Park at the RESOLVED screen center — nothing at center takes focus during combat, so the cursor
                // parks harmlessly. The RAW design center (DesignWidth/2, 540) is routed through ResolveFresh so a
                // WIDENED stage maps it correctly (and the fresh resolve seeds the hover memo).
                SendHover(_cb.ResolveFresh(_cb.DesignWidth() / 2.0, DesignHeight / 2.0));
            }

            return;
        }

        if (_twoFinger)
        {
            // Wait for BOTH fingers to lift, then a single right-click at the centroid (unless it pinched). The
            // stored centroid is a raw design point; resolve it FRESH at fire time — web fullClick → designCoord
            // (inputCapture.ts L642 + L254). Identity on 16:9.
            if (_touchPointers.Count == 0)
            {
                if (!_twoFingerMoved)
                {
                    _pressedRootId = null;
                    SendFullClick("right", _cb.ResolveFresh(_twoFingerX, _twoFingerY));
                }

                _twoFinger = false;
                _twoFingerMoved = false;
            }

            return;
        }

        // A single-finger TAP. Resolve the release coord once (drives the unselect test AND the sent event).
        var release = _cb.ResolveFresh(x, y);
        DoClearFreeze();

        // #12: is a from-hand card-CHOICE dialog active (read LIVE)? Default OFF for an unwired engine.
        var choiceActive = _cb.HandChoiceActive();

        // Tap-to-unselect: a below-the-hand tap while a pressed card is STILL SELECTED is the game's cancel (a
        // right-click) — even landing on a card. Gated on a PRESS (not a bare focus) + the pressed card still being
        // a HAND card (IsCard AND IsHandCard, read LIVE here on purpose): a no-target play prunes the card and a
        // played/discarded card leaves the hand, either of which self-disables the latch so the next below-line tap
        // is a normal tap. A selected/targeting card stays in the hand, so the cancel keeps working for it. #12
        // SUPPRESSES it while a hand-choice dialog is active (else a choose-2 dialog's second below-line selection
        // would be eaten by a spurious cancel).
        if (_pressedRootId is not null
            && _cb.IsCard(_pressedRootId)
            && _cb.IsHandCard(_pressedRootId)
            && !choiceActive
            && release.Y >= _options.UnselectZoneY)
        {
            _pressedRootId = null;
            _armedRootId = null;
            SendFullClick("right", release);
            return;
        }

        var top = p.Ids.Count > 0 ? p.Ids[0] : null;
        if (top is null)
        {
            // Empty space / a block button → immediate click, disarm + de-press. The END-TURN button is a *Button leaf,
            // which TouchTargetScan classifies as a Block (its id is dropped from TargetsAt), so a tap on it ALWAYS
            // lands here — that's why the change-2 un-hover hooks this branch (never during the hold: the click is on
            // tap end, and the un-hover follows it).
            _armedRootId = null;
            _pressedRootId = null;
            SendFullClick("left", release);
            MaybeUnhoverEndTurn(release);
            return;
        }

        if (!_options.TapToFocus())
        {
            // Two-step disabled: a single tap presses immediately, recording the press for a later unselect.
            _armedRootId = null;
            _pressedRootId = top;
            SendFullClick("left", release);
            return;
        }

        // #12: in a from-hand card-CHOICE dialog, a HAND card selects with a SINGLE tap — no arm-first double tap.
        // Only a HAND card (the frozen press verdict); reward/deck/grid cards keep arm-first (#9/#10) even in a
        // dialog. Clears any arm/press so no unselect latch lingers (the below-line cancel is suppressed above too).
        if (choiceActive && p.HandCard)
        {
            _armedRootId = null;
            _pressedRootId = null;
            SendFullClick("left", release);
            return;
        }

        if (top == _armedRootId)
        {
            // R16: a re-tap of the armed widget within TapArmDebounceMs (200ms) of the ARM is an accidental
            // double-tap (finger bounce) — swallow it: no click, stay armed (armedAtMs is NOT reset, so it keeps
            // measuring from the ORIGINAL arm, not this swallowed tap).
            if (nowMs - _armedAtMs < _options.TapArmDebounceMs)
            {
                return;
            }

            // Re-tap of the armed widget → commit; KEEP it armed so every further tap clicks.
            _pressedRootId = top;
            SendFullClick("left", release);
        }
        else
        {
            // A different widget on top → arm it; a fresh focus clears any prior press.
            _armedRootId = top;
            _armedAtMs = nowMs;
            _pressedRootId = null;
            SendHover(release);
        }
    }

    private void OnTouchCancel(long id)
    {
        if (!_touchPointers.TryGetValue(id, out var p))
        {
            return;
        }

        p.PeekDeadline = null;
        _touchPointers.Remove(id);

        // Only a drag has a press to retract; a deferred tap / two-finger gesture sent nothing. Position is stale.
        if (p.Pressed)
        {
            var releaseCoord = _cb.ResolveFrozen(p.LastX, p.LastY);
            _heldTouchCardId = null;
            _heldFromProbe = false;
            _cb.OnHeldCard(null, releaseCoord.X, releaseCoord.Y, HeldMode.Drag);
            SendRelease("left", releaseCoord);
        }
        else if (p.Peeking)
        {
            // A peek was live but cancelled: just clear the lift — no press, no un-focus hover.
            _heldTouchCardId = null;
            _heldFromProbe = false;
            var coord = _cb.ResolveFrozen(p.LastX, p.LastY);
            _cb.OnHeldCard(null, coord.X, coord.Y, HeldMode.Drag);
        }

        DoClearFreeze();

        if (_touchPointers.Count == 0)
        {
            _twoFinger = false;
            _twoFingerMoved = false;
        }
    }

    private void FirePeekIfDue(long id, double nowMs)
    {
        if (!_touchPointers.TryGetValue(id, out var p) || p.PeekDeadline is not { } deadline || nowMs < deadline)
        {
            return;
        }

        p.PeekDeadline = null; // consume once (a setTimeout fires exactly once)

        if (p.Ignore || p.Moved || p.Pressed || p.Peeking || _twoFinger)
        {
            return;
        }

        var cardId = p.Ids.Count > 0 ? p.Ids[0] : null;
        if (cardId is null)
        {
            return;
        }

        // #13: a NON-hand card long-press is a right-click (reward / shop card / card-grid card — the touch analog of
        // the desktop right-click). It's TERMINAL: mark LongPressed (release emits nothing, later movement isn't a
        // drag, a second finger is a stray), clear any arm/press, and right-click at a FRESH-resolved start point.
        if (p.NonHandCard)
        {
            p.LongPressed = true;
            _armedRootId = null;
            _pressedRootId = null;
            SendFullClick("right", _cb.ResolveFresh(p.StartX, p.StartY));
            return;
        }

        // Peek only a press-captured HAND card. The verdict was frozen at press (IsCard AND IsHandCard); a still
        // hold never re-parents, so re-reading it live would be equivalent — but the frozen read keeps native and
        // web identical and self-documents the "captured once" contract.
        if (!p.HandCard)
        {
            return;
        }

        p.Peeking = true;
        _heldTouchCardId = cardId;
        _heldFromProbe = false; // a still-hold PEEK grab — sticky, never re-classified
        // A plain hover (NOT a freeze) — a peek keeps hover semantics; onHeldCard raises the card above the finger.
        var coord = _cb.ResolveHover(p.StartX, p.StartY);
        _cb.OnHeldCard(cardId, coord.X, coord.Y, HeldMode.Peek);
        SendHover(coord);
    }

    // ===== two-finger scroll wheel =====

    // Accumulate the vertical CENTROID drift since the previous move sample and emit one chunky wheel tick per
    // WheelStepDesign of unspent delta (multiple ticks in a single frame when a fast drag covers several steps,
    // remainder carried). Direction is NATURAL touch scroll: fingers moving UP (centroid Y decreasing ⇒ accum < 0)
    // scrolls content DOWN ⇒ wheel-down; fingers moving DOWN (accum > 0) ⇒ wheel-up. Ticks fire at the STORED latch
    // centroid (resolved FRESH by Wheel, exactly like a real wheel event). Web twin: inputCapture.ts onTouchMove.
    private void EmitTwoFingerWheel()
    {
        var centroidY = CurrentTwoFingerCentroidY();
        _twoFingerAccumY += centroidY - _twoFingerPrevCentroidY;
        _twoFingerPrevCentroidY = centroidY;

        while (Math.Abs(_twoFingerAccumY) >= _options.WheelStepDesign)
        {
            var up = _twoFingerAccumY > 0; // fingers moved DOWN ⇒ wheel-up; UP ⇒ wheel-down
            _twoFingerAccumY -= (up ? 1 : -1) * _options.WheelStepDesign;
            Wheel(up, _twoFingerX, _twoFingerY, 0);
        }
    }

    // The current vertical centroid of the two (non-ignored) fingers, in design space (LastX/LastY are updated on
    // every move). Falls back to the last sample when no live finger remains (never hit in practice).
    private double CurrentTwoFingerCentroidY()
    {
        double sum = 0;
        var n = 0;
        foreach (var tp in _touchPointers.Values)
        {
            if (tp.Ignore)
            {
                continue;
            }

            sum += tp.LastY;
            n++;
        }

        return n > 0 ? sum / n : _twoFingerPrevCentroidY;
    }

    // ===== coalesced hover =====

    private void ScheduleHover(double x, double y) => _pending = new ResolvedCoord(x, y);

    private void FlushHover()
    {
        if (_pending is not { } pending)
        {
            return;
        }

        _pending = null;
        // While a held gesture is underway (its press froze the field affine), replay the FROZEN coord — the finger
        // is dragging the world, not re-hovering it (inputCapture flushHover L412). Otherwise resolve a plain HOVER.
        var coord = _frozen && (_heldButton is not null || _touchPointers.Count > 0)
            ? _cb.ResolveFrozen(pending.X, pending.Y)
            : _cb.ResolveHover(pending.X, pending.Y);

        // RAISE HELD CARD onto a card the drag MOVES onto: a drag that started OFF any card (nothing latched at
        // press) cosmetically lifts the hand card its finger crosses into — and then FOLLOWS the finger. A PROBE
        // latch (this block, `_heldFromProbe`) keeps RE-CLASSIFYING every active-drag frame: the finger crossing
        // onto a DIFFERENT hand card SWITCHES the lift (old unlifts, new lifts) and moving off every hand card
        // CLEARS it. A press/peek GRAB (the finger went down ON the card, `_heldFromProbe == false`) stays STICKY
        // until release — the game's own grab parity. Re-classification only RUNS when a lift could apply
        // (raiseHeldCard on, single-finger drag underway, below/at the un-select band, a pressed pointer present)
        // so the per-frame hit-test cost stays bounded (phone-CPU rule) — above the band it neither switches nor
        // clears. The sink captures dragStartY at the id change. A probe latch's frozen press-time HandCard verdict
        // stays false, so change 1 never right-clicks such a drag on release.
        if ((_heldTouchCardId is null || _heldFromProbe)
            && _options.RaiseHeldCard()
            && !_twoFinger
            && coord.Y >= _options.UnselectZoneY
            && _touchPointers.Values.Any(p => p.Pressed && !p.Ignore))
        {
            var hits = _cb.TargetsAt(pending.X, pending.Y);
            var hitCard = hits.Count > 0 && _cb.IsCard(hits[0]) && _cb.IsHandCard(hits[0]) ? hits[0] : null;
            if (hitCard != _heldTouchCardId)
            {
                _heldTouchCardId = hitCard;
                _heldFromProbe = hitCard is not null; // still a probe latch when it points at a card; else cleared
                if (hitCard is null)
                {
                    // The finger left every hand card → drop the probe lift (the id-report below won't fire).
                    _cb.OnHeldCard(null, coord.X, coord.Y, HeldMode.Drag);
                }
            }
        }

        if (_heldTouchCardId is not null)
        {
            // Only a classified DRAG reaches a hover flush with a held card (a still peek never schedules a hover).
            _cb.OnHeldCard(_heldTouchCardId, coord.X, coord.Y, HeldMode.Drag);
        }

        SendHover(coord);
    }

    // ===== coordinate seam (M2) =====

    // Release the frozen press affine once a held gesture ends (inputCapture clearFreeze). Clears the machine's own
    // `_frozen` selector AND calls the host resolver's ClearFreeze (a no-op on 16:9). Safe to call when nothing froze.
    private void DoClearFreeze()
    {
        _frozen = false;
        _cb.ClearFreeze();
    }

    // change 2: after a TAP clicks the END-TURN button, park the cursor away from it so its long-press HoverTip
    // doesn't pop when the enemy turn ends. Called AFTER the click on the tap-end path (never during the hold).
    // Ordering is safe WITHOUT deferral: the machine emits click then hover as two ordered direct Sends, and the
    // downstream InputCoalescer only coalesces a hover into a PRECEDING trailing hover — it never drops or reorders a
    // click, so a hover enqueued after a click keeps click→hover order and cannot suppress the click.
    //
    // R13: park at the RESOLVED screen CENTER, not directly below the button (the old (CenterX, MaxY + 24) point) —
    // a below-button park still sat close enough to the button's box that its long-press HoverTip could re-arm and
    // linger after the turn ends. Screen center reuses the SAME pattern as the peek-release un-focus (:486
    // precedent): the RAW design center (DesignWidth/2, 540) routed through ResolveFresh so a
    // WIDENED stage maps it correctly — nothing at center takes focus during combat, so the cursor parks harmlessly.
    // The button's box is still used ONLY to decide whether the tap landed on it (hitTest); its coordinates no
    // longer feed the parked point. Web twin: inputCapture.ts maybeUnhoverEndTurn.
    private void MaybeUnhoverEndTurn(ResolvedCoord release)
    {
        if (_cb.EndTurnBoxAt is not { } hitTest)
        {
            return;
        }

        if (hitTest(release.X, release.Y) is null)
        {
            return; // the tap didn't land on the end-turn button
        }

        SendHover(_cb.ResolveFresh(_cb.DesignWidth() / 2.0, DesignHeight / 2.0));
    }

    // ===== send helpers =====

    private void SendHover(ResolvedCoord c) => _cb.Send(new InputMessage(InputRequestId, "hover", CoordX: c.X, CoordY: c.Y));

    private void SendPress(string button, ResolvedCoord c) =>
        _cb.Send(new InputMessage(InputRequestId, "click", Button: button, CoordX: c.X, CoordY: c.Y, Pressed: true));

    private void SendRelease(string button, ResolvedCoord c) =>
        _cb.Send(new InputMessage(InputRequestId, "click", Button: button, CoordX: c.X, CoordY: c.Y, Pressed: false));

    // A full click (press+release in-game): the host runs press→release when `pressed` is absent.
    private void SendFullClick(string button, ResolvedCoord c) =>
        _cb.Send(new InputMessage(InputRequestId, "click", Button: button, CoordX: c.X, CoordY: c.Y));

    private static string? ButtonName(int button) => button switch
    {
        0 => "left",
        2 => "right",
        1 => "middle",
        _ => null,
    };

    // Per-pointer deferred-gesture state (mirrors inputCapture's TouchPointer; peekDeadline replaces the setTimeout
    // handle). LastX/LastY track the finger for the coordinate-less PointerCancel.
    private sealed class TouchPointer
    {
        public double StartX;
        public double StartY;
        public double LastX;
        public double LastY;
        public IReadOnlyList<string> Ids = Array.Empty<string>();
        // The card-semantics verdict captured at PRESS: IsCard(top) AND IsHandCard(top) of the top hit id. Frozen
        // for the whole gesture so a grabbed HAND card keeps its peek/drag-lift semantics after it RE-PARENTS out of
        // the hand mid-drag (observed under PlayContainer/CombatUi) — the live IsHandCard would flip false there.
        public bool HandCard;
        // The design-Y of the press point, frozen at DRAG classification (the resolved press coord's Y). Feeds the
        // PlayZoneThreshold callback so a card dragged and dropped BELOW its play-zone floor cancels (a right-click).
        public double DragStartY;
        // #13: the top hit at PRESS is a card that is NOT a hand card (IsCard && !HandCard) — a reward / shop card /
        // card-grid card. Frozen at down like HandCard; drives the long-press right-click leg of FirePeekIfDue.
        public bool NonHandCard;
        public bool Moved;
        public bool Pressed;
        public bool Ignore;
        public bool Peeking;
        // #13: a long-press right-click has fired. Terminal: the release emits nothing, later movement is neither a
        // drag nor a hover, and a second finger is a stray (folded into dragActive).
        public bool LongPressed;
        public double? PeekDeadline;
    }
}
