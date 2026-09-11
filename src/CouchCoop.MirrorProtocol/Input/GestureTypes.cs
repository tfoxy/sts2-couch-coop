// The FROZEN M1e gesture seam. Pure, zero-dependency data contract (enums + options + callbacks) that:
//   - WS-L IMPLEMENTS (a coordinate-only gesture engine — press/move/release + a per-frame PumpFrame — that turns
//     pointer/touch events into upstream InputMessages, held-card lifts, peeks, taps, and two-finger cancels), and
//   - WS-M CONSUMES (the native InputRouter constructs a GestureOptions + GestureCallbacks and feeds the engine).
//
// This file defines only the SHARED vocabulary; the engine class itself lives in WS-L's own file so it can evolve
// without touching this contract. The gate ships this frozen — the two downstream workstreams program against it.
//
// CONTRACT NOTES (the behaviour WS-L must honour and WS-M relies on):
//   * COORDINATES ARE PRE-MAPPED DESIGN SPACE. Every x/y crossing this seam (TargetsAt, OnHeldCard, and the CoordX/
//     CoordY the engine writes into an InputMessage) is in the 1920x1080 design space — the InputRouter has already
//     inverted the letterbox/anchor mapping before calling in. The engine never sees raw window pixels.
//   * PRESS-AT-START-POINT DRAG CLASSIFICATION. A gesture is classified from the point where the press STARTED: the
//     ids under the press-down decide whether this is a card (peek/drag candidate) or a plain click. Movement past
//     DragThresholdDesign from that origin promotes a held card to a Drag; a still hold past PeekMs promotes it to a
//     Peek. A second finger appearing (or the pointer travelling past TwoFingerCancelDesign as a two-finger pinch)
//     CANCELS the in-flight gesture.
//   * PUMPFRAME DRIVES DEADLINES + COALESCED HOVER. The engine is edge-driven for press/move/release but needs a
//     once-per-frame PumpFrame(nowMs) tick to (a) fire the coalesced hover for the latest pointer position — one
//     hover per frame, not one per raw move — and (b) evaluate time-based deadlines (the PeekMs promotion).
//   * LIVE TOGGLES. The GestureOptions toggle getters are read PER GESTURE (never cached), so a settings flip
//     mid-play takes effect on the next gesture without re-wiring.

using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.MirrorProtocol.Input;

/// <summary>The pointer source of a gesture. Touch enables the peek/lift/two-finger behaviours; Mouse is click-only.</summary>
public enum PointerKind
{
    Mouse,
    Touch,
}

/// <summary>How a held card is currently raised: a still-hold <see cref="Peek"/> vs a moving <see cref="Drag"/>.</summary>
public enum HeldMode
{
    Peek,
    Drag,
}

/// <summary>The classification of what a design-space point resolves to for touch targeting.</summary>
public enum TouchInfoKind
{
    /// <summary>Nothing actionable under the point.</summary>
    None,

    /// <summary>An actionable target (its id is carried).</summary>
    Target,

    /// <summary>A blocker/occluder that ends the target list (its id is carried).</summary>
    Block,
}

/// <summary>
/// The resolved meaning of a design-space point: a <see cref="Kind"/> plus the id it belongs to (null for
/// <see cref="TouchInfoKind.None"/>).
/// </summary>
public readonly record struct TouchInfo(TouchInfoKind Kind, string? Id);

/// <summary>
/// A resolved 1920×1080 GAME-space coordinate — the output of the M2 coordinate seam (see the resolver callbacks on
/// <see cref="GestureCallbacks"/>). On a 16:9 stage the resolvers are identity, so this equals the incoming design
/// point; on a widened stage WS-Q's resolvers invert the visual-anchor field / replay a frozen affine before it is
/// written into an upstream <c>InputMessage</c>. The engine only ever emits values in this resolved space.
/// </summary>
public readonly record struct ResolvedCoord(double X, double Y);

/// <summary>
/// A GAME-space (1920×1080) axis-aligned box. Carries the END-TURN button's rect for the change-2 below-button
/// un-hover (see <see cref="GestureCallbacks.EndTurnBoxAt"/>). Web twin: the <c>{minX,minY,maxX,maxY}</c> object
/// <c>touch.endTurnBoxAt</c> returns.
/// </summary>
public readonly record struct EndTurnBox(double MinX, double MinY, double MaxX, double MaxY)
{
    /// <summary>The horizontal center of the box (the un-hover parks the cursor directly below this X).</summary>
    public double CenterX => (MinX + MaxX) / 2.0;
}

/// <summary>
/// Tunable gesture thresholds. The <c>Default*</c> constants are the canonical (web-ported) design-space values and
/// the names WS-L references; each matching instance property defaults to its constant and is the URL-param-style
/// override WS-M sets. The three toggle getters are read LIVE per gesture (see the file header).
/// </summary>
public sealed class GestureOptions
{
    /// <summary>Design-space px a held card must travel from the press origin before it promotes to a Drag.</summary>
    public const double DefaultDragThresholdDesign = 8;

    /// <summary>Design-space px of pointer travel (or a second finger) that CANCELS the in-flight gesture.</summary>
    public const double DefaultTwoFingerCancelDesign = 24;

    /// <summary>
    /// Design-space px of vertical two-finger CENTROID travel per emitted scroll-wheel tick. Deliberately chunky:
    /// the InputCoalescer never drops clicks, so a per-pixel tick would flood the wire — one tick per 56 design px
    /// of centroid drift keeps a two-finger scroll to a handful of ticks. Web parity: WHEEL_STEP_DESIGN.
    /// </summary>
    public const double DefaultWheelStepDesign = 56;

    /// <summary>Milliseconds a still hold on a HAND card must persist before it promotes to a Peek.</summary>
    public const double DefaultPeekMs = 100;

    /// <summary>
    /// R1: milliseconds a still hold on a NON-hand card (reward / shop card / card-grid card) must persist before it
    /// promotes to the #13 long-press RIGHT-CLICK leg — a separate, longer threshold than <see cref="DefaultPeekMs"/>
    /// so an ordinary reward-screen tap (which lingers longer than a deliberate hand-card peek) can't accidentally
    /// register as a long-press right-click. R6 (user request): retuned 500→300ms for a snappier long-press; still
    /// comfortably longer than the 100ms hand-card peek. Web twin: <c>LONG_PRESS_MS</c>.
    /// </summary>
    public const double DefaultLongPressMs = 300;

    /// <summary>Design-space px a peeked card is raised (the focus lift; the reverse un-focus never plays past this).</summary>
    public const double DefaultPeekUnfocusUpPx = 560;

    /// <summary>Design-space Y below which a tap is treated as an unselect / right-click (the play-zone floor).</summary>
    public const double DefaultUnselectZoneY = 846;

    /// <summary>
    /// R16: milliseconds after a widget ARMS within which a re-tap of the SAME widget is treated as an accidental
    /// double-tap and swallowed (no click sent; the widget stays armed) rather than committing. Web twin:
    /// <c>TAP_ARM_DEBOUNCE_MS</c>.
    /// </summary>
    public const double DefaultTapArmDebounceMs = 200;

    public double DragThresholdDesign { get; set; } = DefaultDragThresholdDesign;
    public double TwoFingerCancelDesign { get; set; } = DefaultTwoFingerCancelDesign;
    public double WheelStepDesign { get; set; } = DefaultWheelStepDesign;
    public double PeekMs { get; set; } = DefaultPeekMs;
    public double LongPressMs { get; set; } = DefaultLongPressMs;
    public double PeekUnfocusUpPx { get; set; } = DefaultPeekUnfocusUpPx;
    public double UnselectZoneY { get; set; } = DefaultUnselectZoneY;
    public double TapArmDebounceMs { get; set; } = DefaultTapArmDebounceMs;

    /// <summary>Whether a held card cosmetically raises. Read live per gesture.</summary>
    public Func<bool> RaiseHeldCard { get; set; } = static () => true;

    /// <summary>Whether releasing a peeked card un-focuses it. Read live per gesture.</summary>
    public Func<bool> UnfocusOnRelease { get; set; } = static () => true;

    /// <summary>Whether a tap on a card focuses it. Read live per gesture.</summary>
    public Func<bool> TapToFocus { get; set; } = static () => true;
}

/// <summary>
/// The host hooks the gesture engine calls out through. All delegates default to safe no-ops so a partially wired
/// instance still compiles/runs; WS-M sets the live implementations. Coordinates are pre-mapped design space.
/// </summary>
public sealed class GestureCallbacks
{
    /// <summary>Send an upstream input replay message to the host (fire-and-forget; routes to ConnectionCoordinator.SendInput).</summary>
    public Action<InputMessage> Send { get; set; } = static _ => { };

    /// <summary>
    /// Held-card lift callback. <c>id == null</c> CLEARS the lift; otherwise raise card <c>id</c> in <c>mode</c> at
    /// the design-space point (x, y).
    /// </summary>
    public Action<string?, double, double, HeldMode> OnHeldCard { get; set; } = static (_, _, _, _) => { };

    /// <summary>
    /// Hit provider: the topmost-first, DISTINCT target ids under a design-space point, truncated at the first
    /// blocker (a Block occluder ends the list). Empty when nothing actionable is hit.
    /// </summary>
    public Func<double, double, IReadOnlyList<string>> TargetsAt { get; set; } = static (_, _) => Array.Empty<string>();

    /// <summary>Whether <c>id</c> is a card (NCard leaf) — with <see cref="IsHandCard"/> drives peek/drag/unselect card semantics.</summary>
    public Func<string, bool> IsCard { get; set; } = static _ => false;

    /// <summary>
    /// Whether <c>id</c> is a HAND card (a card under an NHandCardHolder/NPlayerHand ancestor). The gesture engine
    /// treats a card as peek/drag-lift/unselect-eligible only when <see cref="IsCard"/> AND this are true, so a
    /// deck-dialog / reward card falls through to a plain native click. Defaults to <c>true</c> (an unwired engine
    /// is unrestricted, preserving the IsCard-only behaviour the older tests prove); WS-M wires the live predicate.
    /// </summary>
    public Func<string, bool> IsHandCard { get; set; } = static _ => true;

    // ---- M2 coordinate resolvers (the widened-stage seam; OWNER of the live impls: WS-Q) ----
    // All FOUR default to IDENTITY and <see cref="ClearFreeze"/> to a no-op, so an unwired (16:9) engine emits the
    // incoming design coord verbatim — the byte-identical no-op the existing GestureMachineTests prove. WS-Q's
    // InputRouter assigns the real resolvers (map + near-miss + press-freeze + hover-memo). Named after the web
    // inputCapture.ts functions they port (resolveSent / freezeAt / frozenCoord / hoverCoord / clearFreeze).

    /// <summary>Resolve a design point FRESH (map + near-miss + refresh hover memo). Wheel, mouse/touch releases.</summary>
    public Func<double, double, ResolvedCoord> ResolveFresh { get; set; } = static (x, y) => new ResolvedCoord(x, y);

    /// <summary>Resolve FRESH and FREEZE the press-time field affine for the held gesture (freezeAt). Press-downs.</summary>
    public Func<double, double, ResolvedCoord> ResolvePress { get; set; } = static (x, y) => new ResolvedCoord(x, y);

    /// <summary>Replay the FROZEN affine, no near-miss (frozenCoord). Cancels + the mid-gesture hover flush.</summary>
    public Func<double, double, ResolvedCoord> ResolveFrozen { get; set; } = static (x, y) => new ResolvedCoord(x, y);

    /// <summary>Resolve a plain HOVER (memo replay within bounds + near-miss, else fresh). Peek + the idle hover flush.</summary>
    public Func<double, double, ResolvedCoord> ResolveHover { get; set; } = static (x, y) => new ResolvedCoord(x, y);

    /// <summary>Clear the frozen press affine once a held gesture ends (clearFreeze).</summary>
    public Action ClearFreeze { get; set; } = static () => { };

    /// <summary>
    /// The LIVE widened design width (16:9 == 1920; up to the max on an ultra-wide stage) — the same source WS-M
    /// feeds the resolvers. The peek-release un-focus routes the RAW design center (<c>DesignWidth/2</c>, 540)
    /// through <see cref="ResolveFresh"/> so a WIDENED stage maps it correctly.
    /// Defaults to 1920 (an unwired 16:9 engine), matching the web <c>designWidth</c> param default MIRROR_DESIGN_WIDTH.
    /// </summary>
    public Func<double> DesignWidth { get; set; } = static () => 1920;

    /// <summary>
    /// End-turn hit-test (change 2): given a RESOLVED game-space point, returns the END-TURN button's game-space box
    /// when the point lands on it (matched by node-type leaf / <c>end_turn_button.tscn</c> scene file — WS-M owns the
    /// match), else null. Drives the below-button un-hover after a tap so the button's long-press HoverTip doesn't pop
    /// when the enemy turn ends. <c>null</c> (default) = the feature is unwired (an unwired engine never un-hovers), so
    /// the existing GestureMachineTests stay byte-identical; WS-M wires the live hit-test. Web twin: <c>touch.endTurnBoxAt</c>.
    /// </summary>
    public Func<double, double, EndTurnBox?>? EndTurnBoxAt { get; set; } = null;

    /// <summary>
    /// Play-zone floor for a DRAG that lifts a card: given the drag's start design-Y (the grab point), returns the
    /// design-Y threshold below which the drop is treated as a de-select (the game's cancel → a right-click). Maps
    /// to <c>PlayZone.Threshold(1080, dragStartY)</c> (web twin: <c>playZoneThreshold(MIRROR_DESIGN_HEIGHT, …)</c>).
    /// <c>null</c> = the feature is OFF (an unwired engine never right-clicks on a below-line drop, so the existing
    /// GestureMachineTests stay byte-identical); WS-M wires the live predicate.
    /// </summary>
    public Func<double, double>? PlayZoneThreshold { get; set; } = null;

    /// <summary>
    /// #12: whether a from-hand card-CHOICE dialog (Survivor "Choose a card to Discard", Exhaust/Enchant selection —
    /// <see cref="HandChoiceScan"/>) is currently active. When true, a tap on a HAND card selects it with a SINGLE
    /// tap (no arm-first double tap) and the below-line unselect right-click is suppressed. Defaults to <c>false</c>
    /// (an unwired engine never treats a dialog as active, so the existing GestureMachineTests stay byte-identical);
    /// WS-M wires <c>() =&gt; HandChoiceScan.IsActive(store.State)</c>. Read LIVE per touch-up. Web twin:
    /// <c>touch.handChoiceActive</c>.
    /// </summary>
    public Func<bool> HandChoiceActive { get; set; } = static () => false;
}
