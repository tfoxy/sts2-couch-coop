// Captures pointer + keyboard input over the mirror stage and forwards it upstream (single controller). Input is
// COORDINATE-ONLY on the wire: every event resolves to a GAME design-space coordinate (1920x1080) and the game
// hit-tests it natively — robust, because the game's own input honors `mouse_filter`, and no element addressing is
// needed since the mirror lays the tree out to match.
//
// Resolution goes through the ONE visual-anchor map (pointerMap.mapPointerToGame):
//   - 16:9 stage: design space IS game space, so the coordinate is just the pointer's fraction across the stage —
//     resolved with ZERO DOM probes (the phone-CPU rule; phones are never widened).
//   - WIDENED stage (>16:9): the renderer re-lays-out content horizontally, so the game coordinate under a pointer
//     is `fraction·designWidth` minus the shift of whatever is VISUALLY PAINTED there. mapPointerToGame asks the
//     RENDERER for the topmost painting element there (spreadPainterAt — an elementsFromPoint z-stack walk on the
//     DOM backend) and inverts its map — the same per-frame probe cost the old element-addressed hover path paid,
//     now producing a plain coordinate.
//
// M0 — WHERE THE HIT TESTS LIVE. This module asks two questions about what is DRAWN at a point ("which widget is
// under this finger", "which painter anchors this pixel") and both are answered by the renderer (touchStackAt /
// spreadPainterAt), never by reading the DOM here. On the DOM backend those ARE the walks this file used to run
// inline, so nothing about the resolved coordinate changed; a canvas stage answers them from its own draw list.
//
// GESTURE FREEZE: on a press (mouse down / a touch drag classifying) we resolve FRESH once and remember the FIELD
// AFFINE (`coordX = a·designX + b`); while the button/finger is held, drag-motion hovers replay it with PURE MATH
// (no elementsFromPoint — so a drag never re-probes the DOM, and the dragged content can't tug the cursor's own map
// out from under it). A drag begun on proportional world content (a card) replays the whole-world squeeze so the
// finger keeps the content; a drag on anchored HUD replays its fixed translation. The release resolves FRESH again
// for exact drop targeting, then clears the freeze.
//
// HOVER-PROBE MEMO: outside any gesture, a plain hover flush on a widened stage still paid a fresh elementsFromPoint
// walk on EVERY flush (up to one per rAF, ~60/s while the mouse moves) — measured at 341ms over an 18.9s live
// combat trace. A hover within HOVER_REPROBE_PX / HOVER_REPROBE_MS of the last fresh probe now replays that
// probe's field affine with pure math instead (see hoverCoord) — a milder, self-correcting version of the same
// staleness the gesture freeze already accepts for a whole held drag. Press/release/wheel/tap/peek always resolve
// fresh (see designCoord) and refresh the memo for free; the memo itself is invalidated alongside the cached
// stage rect (resize/scroll) and self-invalidates on a design-width change (the stretch toggle can resize the
// stage without a window resize event).
//
// HIT-CONSISTENCY: fresh resolves (hover / press / release) also run the near-miss pass over the renderer's current
// interactive rects so a pointer in empty space beside a +dx-shifted button doesn't resolve INTO that button's game
// rect. Held-drag motion frames stay pure frozen math (no rects consulted — the phone-CPU rule).
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.

import { MIRROR_DESIGN_HEIGHT, MIRROR_DESIGN_WIDTH } from "@/mirror/sceneTree";
import {
  panClaimWithholdsPress,
  wheelEventToGamePx,
  type EagerScroll,
  type PanClaim
} from "@/mirror/eagerScroll";
import {
  isSqueezeAffine,
  mapPointerToGame,
  nearMissApplies,
  pushOutOfNearMiss,
  pushOutOfSqueezeMiss,
  resetNearMissMemory,
  type FieldAffine
} from "@/mirror/pointerMap";
import {
  confirmTap as confirmTapState,
  confirmButtonReady,
  hideConfirmTap,
  setConfirmCommit,
  setConfirmHidden,
  showConfirmTap,
  type ConfirmTapKind
} from "@/mirror/confirmTap";
import {
  deferRaisePoint,
  pointInPlacedRect,
  settleDeferredRaisePoint,
  type RaiseInputStamp,
  type RaisedHandVisualClaim,
} from "@/mirror/raiseInverse";
import { claimViewScaleStamp, remapViewScaleInverse, type ViewScaleInputStamp } from "@/mirror/viewScaleInverse";
import type { ConfirmTapHit, InteractiveRect, MirrorRenderer, TouchStack } from "@/mirror/renderer/contracts";
import { domSpreadPainterAt, domTouchStackAt } from "@/mirror/renderer/domHitProbes";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";

export interface InputCapture {
  dispose(): void;
  /** Sends a programmatic hover and makes that exact target one-tap ready before its focus delta returns. */
  focusTarget(id: string, gameX: number, gameY: number, markReady?: boolean): void;
  /** Clears only the programmatic readiness above; the user's ordinary tap-to-focus arm is untouched. */
  clearProgrammaticFocus(): void;
  // R10 WS-F — the stage-geometry invalidation SEAM. The cached stage rect (see stageRect) used to be dropped only on
  // a window `resize`/`scroll`, but the stage can be re-sized and re-scaled with NEITHER: toggling the widescreen
  // STRETCH setting rewrites `design.w` + the letterbox `scale` from a computed, and a frame-only ResizeObserver
  // (a sibling panel opening) does the same. The stale rect then mis-maps EVERY pointer — a pure linear X error, so
  // taps land a fixed fraction off across the whole stage. MirrorView calls this whenever `design`/`scale` move.
  // Exported (not inlined into a listener) so a later feature — eager scrolling, a fullscreen re-fit — can reuse it.
  invalidateStageRect(): void;
}

// Keys that would scroll the page; suppressed unless a ctrl/meta shortcut is in play (so refresh/devtools work).
const SCROLL_KEYS = new Set([
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End"
]);

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Wall-clock ms for the hover-probe memo's time bound (HOVER_REPROBE_MS) — guarded the same way mirrorRenderer's
// spine-clip clock is, so a `performance`-less environment degrades to Date.now() rather than throwing.
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
}

function buttonName(button: number): "left" | "right" | "middle" | null {
  return button === 0 ? "left" : button === 2 ? "right" : button === 1 ? "middle" : null;
}

// Scenes (by `data-scene-file` suffix) where a TOUCH tap should first HOVER and only CLICK on a second tap on
// the same scene instance. The game routes focus/press at the scene root, so any descendant touched counts as
// the root (we track identity by `data-scene-root-id`). Misclicks here are costly (playing/buying the wrong
// thing), so they get the two-step. Everything else taps through to an immediate click. Mouse is never affected.
// Touch movement (in DESIGN px) past which a single-finger gesture becomes a DRAG (the deferred press fires and
// the move stream replays as drag-motion, so card drag-and-drop is preserved). Below it, a down→up is a TAP.
const DRAG_THRESHOLD_DESIGN = 8;
// …but a finger's accidental travel is a PHYSICAL quantity, and 8 design px is ~1.6 CSS px on a portrait phone
// (the stage paints 1920 design px across ~390 CSS px): most border taps and fast double-taps rolled past it and
// were reclassified as drags — a press+release pair at the press point, i.e. a full commit that bypassed every
// tap-side guard (confirm tap included). The TOUCH classifier therefore floors the threshold at this much REAL
// on-screen travel (≈ Android's 8dp touch slop), converted through the stage scale per gesture; on a desktop-sized
// stage the design constant still governs (10 CSS px ≈ 11 design px there). Mouse paths keep the design constant
// (a cursor has no contact patch). `?tapSlopCss=0` restores the pure design-px threshold. Native twin: none yet —
// the godot client is paused; GestureTypes.DefaultDragThresholdDesign stays 8 until it resumes.
const TOUCH_TAP_SLOP_CSS_PX = 10;
// Two-finger movement (DESIGN px) past which the gesture is a pinch/scroll, not a right-click tap → emit nothing.
const TWO_FINGER_CANCEL_DESIGN = 24;

// One hit-stack probe's verdict about a point (see touchTargetsAt). `ids` + `blocked` are the long-standing §3
// tri-state; `blockKind` and `topStamp` are R21's answer to "WHICH widget is spoken for here", which the scrollbar
// claim needs and a boolean cannot carry. M0: the SHAPE now lives with the renderer that produces it
// (mirrorRenderer.TouchStack) — this alias keeps every reference in this file (and its `TouchHits["blockKind"]`
// index reads) spelled exactly as before.
type TouchHits = TouchStack;
// Vertical two-finger CENTROID travel (DESIGN px) per emitted scroll-wheel tick. Deliberately chunky: the
// InputCoalescer never drops clicks, so a per-pixel tick would flood the wire — 56 design px per tick keeps a
// two-finger scroll to a handful of ticks. Native parity: GestureOptions.DefaultWheelStepDesign.
const WHEEL_STEP_DESIGN = 56;

// A WIDENED-stage hover flush within this many viewport px (euclidean) AND this many ms of the last FRESH
// elementsFromPoint probe replays that probe's field affine with pure math instead of re-probing — see
// hoverCoord. Measured live: 341ms of elementsFromPoint over an 18.9s combat trace, driven by hover flushes at up
// to one per rAF (~60/s) while the mouse moves on a widened (>16:9) stage — 16:9 already probes zero times
// (mapPointerToGame's own short-circuit), so this bound never engages there. A milder, self-correcting version of
// the existing gesture freeze (frozenAffine), which holds a SINGLE probe for an entire held drag; this holds one
// for at most HOVER_REPROBE_MS / HOVER_REPROBE_PX of plain mouse travel, so a hover can't drift far from what a
// fresh probe would say before the next flush (or any press/release/wheel/tap/peek, which all resolve fresh and
// refresh the memo for free — see resolveSent) corrects it.
// R10-PERF6 WS-P1 — WIDENED (24/120 → 64/250, `?hoverReprobePx=`/`?hoverReprobeMs=` restore either). A phone trace
// of a map scroll still measured 32.6ms of `elementsFromPoint` from plain hover flushes alone. The memo only ever
// covers a PLAIN MOVE: every press / release / wheel / tap / peek resolves FRESH (see resolveSent) and refreshes
// the memo, so a widened bound can never carry a stale field into a gesture — the worst case is a hover that keeps
// the previous painter's field for another 40px of drift, which is a HIGHLIGHT landing on the neighbouring rect
// for a frame, not a mis-sent click. 16:9 never probes at all (mapPointerToGame short-circuits).
const HOVER_REPROBE_PX = 64;
const HOVER_REPROBE_MS = 250;

// DRAG-PROBE THROTTLE. The drag-into-card lift latch (see flushHover) runs
// `document.elementsFromPoint` — a FORCED hit test, and on a phone the single most
// expensive thing a drag frame does — once per move event while a finger is dragging inside the hand band. What it
// answers ("which hand card is under the finger") cannot change without the finger MOVING an appreciable distance,
// so a move that stays within DRAG_REPROBE_DESIGN design px AND DRAG_REPROBE_MS of the last probe reuses that
// probe's verdict. Same idiom + the same 24px bound as the hover memo above, but measured in DESIGN px so a phone
// (which paints the 1920 design box at ~0.56x) gets the same threshold as a desktop. Both ENDPOINTS stay exact: the
// press probes fresh (onTouchDown, never throttled) and both the press and the release CLEAR the memo, so no
// verdict is ever carried across a gesture boundary.
const DRAG_REPROBE_DESIGN = 24;
const DRAG_REPROBE_MS = 90;

// Read a numeric URL query override (empty string / NaN falls back to the default) — mirrors how `?cardLift=` is
// parsed in mirrorRenderer.ts.
// A single finger held STILL on a HAND card for this long (ms) becomes a "peek": focus + raise, no play on release.
// Exported so tests can drive the fake-timer clock by the real threshold rather than a magic number.
export const PEEK_MS = 100;
// R1: a single finger held STILL on a NON-hand card (reward / shop card / card-grid card) for this long (ms) becomes
// the #13 long-press RIGHT-CLICK — its OWN, longer threshold than PEEK_MS so an ordinary lingering reward-screen tap
// can't accidentally register as a long-press. R6 (user request): retuned 500→300ms for a snappier long-press; still
// comfortably longer than the 100ms hand-card peek. Native twin: GestureOptions.DefaultLongPressMs.
export const LONG_PRESS_MS = 300;
// A peek release un-focuses by hovering this many DESIGN px straight up from the finger (reliably above the whole
// hand ⇒ a card-free point), so the game drops focus. Only sent when `unfocusOnRelease` is on.
// Once a card has been PRESSED (committed), a single tap (no drag/sustain) whose release lands at or below this
// DESIGN-Y becomes a RIGHT-click at that point — the game's cancel — so the selected card de-selects, even if the
// tap lands on a card. 846 is the top of the resting hand; a focused/selected card pops ABOVE it, so the two-step
// focus-tap and press-tap (which land on the popped-up card, above the line) are unaffected. `?unselectY=`.
const UNSELECT_ZONE_Y = 846;
// R16: milliseconds after a widget ARMS within which a re-tap of the SAME widget is treated as an accidental
// double-tap (finger bounce) and swallowed (no click; stays armed) rather than committing. Native twin:
// GestureOptions.DefaultTapArmDebounceMs.
const TAP_ARM_DEBOUNCE_MS = 200;

// The view-scale coordinate inverse is part of the accepted input mapping.
// ViewScaler.InverseRemap. When ON, every RESOLVED game point (hover/press/drag/release) is mapped back off an
// enlarged view-scale item's halo onto its true hit box (only points inside a stamp's ScaledBox change; everything
// else is untouched). Native twin: COUCHCOOP_MIRROR_VIEWSCALE_INPUTGATE.
// The FALSE-HALO guard on the view-scale inverse (default ON): a stamp may only remap a resolved point when the RAW
// pointer's widened-design position was inside the stamp's ON-STAGE rendered box. Without it, a wider-than-16:9 stage
// hovering BESIDE an enlarged ancient-event option focused/activated the option — beside it no `data-paints` painter
// anchors the map, so mapPointerToGame's uniform-squeeze fallback drops the centred content's spread shift and the
// resulting game X lands inside the stamp's ScaledBox anyway. No native twin — native's
// InverseRemap already tests the RAW design point against spread-folded boxes (see viewScaleInverse's header).
// R19 6a: the SQUEEZE RENDERED-BOX GATE (default ON) — the same guard as `?viewScaleRenderedGate`, one layer up, on
// the plain interactive rects. A point the anchor map resolved through the UNIFORM SQUEEZE has the near-miss pass
// suppressed (nearMissApplies) and is sent verbatim, which let a hover/drag over EMPTY wide-stage space right of the
// map legend resolve into a legend row's game rect. When ON, such a point is ejected from the single rect it
// resolves into if the raw widened-design pointer is not inside that rect's RENDERED box (pushOutOfSqueezeMiss).
// PointerResolver runs NearMiss on EVERY fresh resolve — it has no squeeze suppression, so it has no hole to fill.
// C5 — the CONFIRM-TAP COMMIT FIREWALL (default ON). Every touch-originated LEFT click/press that would land
// inside a confirm-eligible widget's TRUE game box (touch.confirmTapAt) is withheld and downgraded to the
// focus+button pair — one choke point instead of a guard per gesture branch, so no branch (present or future)
// can commit an irreversible choice with a bare tap or a slop-reclassified drag. Web-only: there is no native twin.
// T2 (2026-08-27) — THE MOUSE DRAG-DROP CANCEL (default ON), i.e. the touch leg's below-line right-click, on the
// mouse leg, where the same gesture had no cancel at all.
//
// THE BUG. The game's cancel for a card being targeted is a ZONE, not an event: it polls its own cursor and
// cancels once the cursor comes back down into the bottom band of the viewport (measured live: the bottom 5%,
// i.e. game y > 1026 at 1080). The mirror's cursor is whatever coordinate this client last sent — and
// readable-hand mode draws the whole hand ~119px ABOVE where the game has it. So a player who drags a card up
// into the play area and drops it back onto the DRAWN hand sends a Y about a lift short of the band, and the
// game never cancels: the card stays selected with the arrow up, the hand answers no hover-focus at all, and the
// next click is eaten by the targeting. Whether the drop reaches the band today is down to luck — the raise
// inverse only un-maps a pixel a raised card's drawn box claims, and the drag's frozen correction only survives
// inside RAISE_DRAG_FADE_PX of the grab — so dropping the card back exactly where it was picked up cancels and
// dropping it a few hundred px along the fan does not. Measured live 2026-08-27 (mouse-1920-off, H9): drop at
// design (1560,998) → sent y 1078 → cancels; the same gesture dropped at (1300,998) → sent y 998 → the arrow
// stays up, and the next two hovers go out at exactly the right coordinates and focus a card they are not on.
//
// THE FIX IS THE ONE TOUCH ALREADY MAKES. onTouchUp fires a right-click at the drop point when a HAND-card drag
// is released at or below its play-zone floor (see the p.pressed branch), which is why the touch leg passes this
// gesture on every shape tried. The mouse leg now does the same, with the same three gates — a real drag, a
// press-time hand-card verdict, and a wired playZoneThreshold — so the two pointers cancel identically.
//
// WHAT IT COSTS. `playZoneThreshold` is tightened to 100px above the grab, so this only fires when the card is
// brought back down to roughly where it was taken from. A mid-screen release still leaves the arrow up, which is
// what the game does natively.
// The gesture freeze covers the whole mapping, view-scale inverse included. See frozenViewScaleStamps.

export function createInputCapture(
  stage: HTMLElement,
  send: (message: MirrorInputMessage) => void,
  // The LIVE widened design width (`MirrorView.design.w`, up to MIRROR_MAX_DESIGN_WIDTH on an ultra-wide stage;
  // === MIRROR_DESIGN_WIDTH on 16:9). The visual-anchor map spreads the pointer fraction across this, then
  // inverts each painting node's anchor-driven shift, recovering the native 1920-space coordinate the game
  // hit-tests.
  designWidth: () => number = () => MIRROR_DESIGN_WIDTH,
  // The renderer's provider of the current frame's visible interactive (Stop) Control boxes (game rect + spreadDx),
  // for the hit-consistency / near-miss pass. Read on FRESH resolves (hover/press/release) only — reading it walks
  // retained records (cheap, no DOM layout), but held-drag motion frames never touch it (they stay frozen math).
  interactiveRects?: () => InteractiveRect[],
  // Reports the card a TOUCH drag currently holds (id + its live GAME-space coordinate), so the renderer can
  // cosmetically raise it above the fingertip — see mirrorRenderer.setHeldCard. Purely a rendering hint: the id is
  // whatever hover-first widget was under the finger at press (may not be a card at all; the renderer itself gates
  // on node type), and the coordinate is exactly what was/would be sent, so it never diverges from the wire value.
  // Fired on the touch press/drag-motion/release path only — mouse gestures never call this. `mode` is the gesture
  // that's holding the card: "drag" (follow the finger, hysteresis lift) or "peek" (long-press → lift
  // unconditionally). Omitted (undefined) on the release/cancel calls, where `heldId` is null and mode is moot.
  onHeldCard?: (heldId: string | null, gameX: number, gameY: number, mode?: "drag" | "peek") => void,
  // GESTURE feature getters (each read live per gesture so a settings flip takes effect immediately). Every
  // getter is treated as enabled unless it returns exactly `false`; `isCard` / `isHandCard` default to true when
  // absent. Named `touch` because that is the only path that used them; as of T2 the MOUSE path consults exactly
  // three — `isCard`, `isHandCard` and `playZoneThreshold` — for the drop-cancel, and nothing else here.
  // A card is peek/drag-lift/unselect-eligible only when it is
  // BOTH a card (`isCard`) AND a HAND card (`isHandCard`) — a deck-dialog / reward card falls through to a native
  // click. `isHandCard` re-checks the retained node parent chain (mirrorRenderer.isHandCard).
  touch: {
    raiseHeldCard?: () => boolean;
    unfocusOnRelease?: () => boolean;
    tapToFocus?: () => boolean;
    // Authoritative clickable focus from the streamed scene. Read once on touch-down, before the down-hover can
    // change it, so a previously-unfocused target keeps the ordinary arm-first behavior for that whole press.
    isFocused?: (id: string) => boolean;
    // A real primary touch supersedes a still-settling programmatic reward focus when it lands elsewhere.
    noteTouchTarget?: (id: string | null) => void;
    isCard?: (id: string) => boolean;
    isHandCard?: (id: string) => boolean;
    // Play-zone floor for the below-line drag-drop cancel: given the drag's start design-Y, returns the design-Y
    // threshold below which dropping a HAND card de-selects it (a right-click — the game's cancel). Maps to
    // playZoneThreshold(MIRROR_DESIGN_HEIGHT, dragStartY). Absent = the feature is OFF (no below-line right-click),
    // so the pre-existing tests that don't pass it stay byte-identical. Native twin: GestureCallbacks.PlayZoneThreshold.
    playZoneThreshold?: (dragStartY: number) => number;
    // End-turn hit-test (change 2): given the release's RESOLVED game point, returns the END-TURN button's game-space
    // box when the tap landed on it (scene-file end_turn_button.tscn match — mirrorRenderer.endTurnBoxAt owns the
    // lookup), else null. Drives the below-button un-hover so the end-turn HoverTip doesn't pop when the enemy turn
    // ends. Absent = the feature is unwired (no un-hover), so pre-existing tests stay byte-identical. Native twin:
    // GestureCallbacks.EndTurnBoxAt — the SAME resolved-game-point → game-box contract, so the twins stay 1:1.
    endTurnBoxAt?: (gameX: number, gameY: number) => { minX: number; minY: number; maxX: number; maxY: number } | null;
    // #12: whether a from-hand card-CHOICE dialog (Survivor "Choose a card to Discard", Exhaust/Enchant selection —
    // mirrorRenderer.handChoiceActive / HandChoiceScan) is active. When true, a tap on a HAND card selects it with a
    // SINGLE tap (no arm-first) and the below-line unselect right-click is suppressed. Absent = false (an unwired
    // engine never treats a dialog as active, so pre-existing tests stay byte-identical). Native twin: GestureCallbacks.HandChoiceActive.
    handChoiceActive?: () => boolean;
    // CONFIRM TAP (see confirmTap.ts): the setting. When on, a tap that lands in a confirm-eligible widget's true
    // game box only FOCUSES and the client-side confirm button commits — so a bare tap can never spend a reward.
    // Absent = the feature is unwired, so pre-existing specs stay byte-identical. Web-only: there is no native twin.
    confirmTap?: () => boolean;
    // CONFIRM TAP: the COORDINATE classifier (mirrorRenderer.confirmTapAt) — the RESOLVED game point → the
    // confirm-eligible widget whose TRUE game box contains it (id + kind, plus the removal-service-only retap
    // activation flag), or null. Deliberately not the DOM
    // stack: the stamps measure rendered descendant unions (a rest-site option's Label box hangs a full
    // widget-height below the drawn button), while this asks with the same number the game will hit-test — which
    // is what makes "the button is up" and "a commit would land" agree by construction. Absent ⇒ nothing is ever
    // eligible, i.e. the feature is off.
    confirmTapAt?: (gameX: number, gameY: number) => ConfirmTapHit | null;
  } = {},
  // FIX 3 (R7): the renderer's live GAME-space view-scale input registry (mirrorRenderer.viewScaleInputStamps). Read
  // FRESH on every resolved point (a live read of the per-drain cache — never snapshotted, so it tracks the latest
  // drain) so a hover/tap over an enlarged view-scale item (an ancient-event option, a reward/shop item) maps back
  // onto its true hit box. Absent / empty = no view-scale screen ⇒ the inverse is identity ⇒ input byte-identical.
  viewScaleInputStamps?: () => ViewScaleInputStamp[],
  // R10 WS-E — the EAGER SCROLL engine (eagerScroll.ts). Absent ⇒ every scroll goes straight upstream and every
  // resolved coordinate is untouched. Present, it gets first refusal on a wheel tick (it owns the coalesced send
  // when a scrollable claims the point), owns one-finger PAN over a scrollable, and compensates every resolved
  // point for the local-vs-streamed offset.
  eagerScroll?: EagerScroll,
  // R11 WS-M — MAP-NODE TRAVEL. Offered every TAP (touch tap end / a click-like mouse release) BEFORE the click is
  // sent: it answers true when the point is a map point and the tap was routed as the `select-map-node` semantic
  // action instead (see mapNodeTap.ts, which owns the whole decision — kill-switch, armed drawing tool, resolution).
  // A coordinate click on a map point is a documented no-op in the game, which is exactly why the tap has to leave
  // by another door. Absent (or answering false) ⇒ the input path is byte-identical to before the feature.
  mapNodeTap?: (clientX: number, clientY: number) => boolean,
  // READABLE-HAND MODE — the renderer's live list of hit surfaces it has cosmetically MOVED (raised hand cards, a
  // creature's shifted health bar / powers / ally intent). Read FRESH on every resolved point, like the view-scale
  // registry above, and applied straight after it: without this a tap on a raised card resolves to the empty space
  // the card USED to occupy, because the mirror's Y is otherwise a strict 1:1. Absent / empty (mode off, hand
  // lowered for a drag, not in combat) ⇒ identity ⇒ input byte-identical. See raiseInverse.ts.
  raiseInputStamps?: () => RaiseInputStamp[],
  // M0 — THE RENDERER'S INPUT PROBES. "Which widget is under this finger" and "which painter anchors this pixel"
  // are questions about what was DRAWN, so they are asked of whatever backend drew it (mirrorRenderer's
  // touchStackAt / spreadPainterAt); MirrorView passes the live renderer. The default is the DOM backend's own
  // implementation of the same two walks — the exact code this file used to run inline — so an unwired caller (a
  // spec, a harness, a receive-only page) behaves byte-identically to before this seam existed.
  probes: Pick<MirrorRenderer, "touchStackAt" | "spreadPainterAt" | "raisedHandVisualClaimAt" | "raisedHandTouchTargetClaim"> &
    Partial<Pick<MirrorRenderer, "isUnderNode">> = {
    touchStackAt: domTouchStackAt,
    spreadPainterAt: domSpreadPainterAt,
    raisedHandVisualClaimAt: () => null,
    raisedHandTouchTargetClaim: () => null,
  }
): InputCapture {
  // Hover is CONTINUOUS (the game's targeting/tooltips follow the live cursor position) but coalesced to one
  // send per animation frame so a fast drag doesn't flood the socket.
  let pending: { x: number; y: number } | null = null;
  let rafId = 0;
  // Raw pointer-GESTURE replay so cards can be dragged: pointerdown → press, the coalesced move stream → drag,
  // pointerup → release. The producer tracks the held button and turns the move stream into drag-motion, so only
  // press/release carry `pressed` (the hover stream stays plain). A tap (down+up, no move) replays as a click, so
  // click-to-play/target still works. We track the held button + pointer id only to release a captured pointer
  // and to synthesize a release on pointercancel (so a button can never get stuck down in the game).
  let heldButton: "left" | "right" | "middle" | null = null;
  let heldPointerId: number | null = null;
  // R11 WS-M — the LEFT mouse press's client point (null when no left button is down). The release compares against
  // it so only a CLICK (not a map pan / a card drag) can route a map-node tap.
  let mouseDownClient: { x: number; y: number } | null = null;
  // T2 — the three press-time facts the mouse DROP-CANCEL needs at the release, frozen at the press for the same
  // reason the touch path freezes its own (`TouchPointer.handCard` / `dragStartDesignY`): a grabbed card re-parents
  // out of the hand mid-drag, so a live re-check at the release would wrongly answer "not a hand card".
  //   `mouseDragStartDesignY` — the SENT press coordinate's Y, which is what the game's play-zone floor is measured
  //                             against (`playZoneThreshold`), not the raw pointer Y.
  //   `mouseHandCardPress`    — the press landed on a hand card (isCard && isHandCard on the topmost stamp).
  //   `mouseDragged`          — the gesture ever travelled past the tap slop. NOT the same question as "is the
  //                             release far from the press": a drag up and back down ends where it started, and
  //                             without this latch that gesture would read as a plain CLICK — which on a card is
  //                             the game's own select, and firing a cancel after it would break click-to-select.
  let mouseDragStartDesignY = 0;
  let mouseHandCardPress = false;
  let mouseDragged = false;
  // R11 WS-S §5: the LEFT press of this mouse gesture was deliberately not sent (an eager grid scroll owns it), so
  // the release must not send a `pressed:false` either — see onPointerDown/onPointerUp.
  let pressWithheld = false;
  // While a gesture (a held mouse button / a classified touch drag) is underway, the field AFFINE is FROZEN to the
  // value resolved at the press: drag-motion hovers then replay `a·designX + b` with pure math so a drag never
  // re-probes the DOM and the dragged content can't drag the cursor's own map away. Null = no gesture.
  let frozenAffine: FieldAffine | null = null;
  // R19 6a — was the press point SQUEEZE-resolved? Frozen alongside the affine because the affine alone cannot say:
  // a drag begun on a proportional CARD deliberately freezes the whole-world squeeze field too (so the world spreads
  // under the finger), and there the squeeze IS the right answer — the pointer is on real content. Only a press the
  // map could not anchor to a specific painter (dead stage space, or the oversized parallax backdrop) is
  // "unanchored", and only that one needs the rendered-box gate on its replayed frames.
  let frozenSqueezed = false;
  // R10 WS-F — the OTHER half of the same freeze. The field affine alone did NOT freeze the whole mapping: every
  // drag-motion frame still re-tested the LIVE view-scale registry (applyViewScaleInverse), so a stamp whose
  // ScaledBox the drag crossed took over mid-gesture and stepped the sent X by (1−1/k)·(distance from the stamp's
  // pivot) in ONE frame — measured 67.6 design px at 2520x1080 and 66.7 at 1920x1080 while dragging across a combat
  // board (scripts/probe-targeting-drag-jump.mjs). The claim is now decided ONCE, at the press, and replayed:
  //   null            no gesture is frozen (fresh resolves consult the live registry, as always)
  //   []              the press was claimed by NO stamp ⇒ this gesture never remaps — the case that covers every
  //                   targeting drag (a hand card is never view-scaled), and the one that kills the jump
  //   [stamp]         the press landed on ONE enlarged item ⇒ that stamp alone may claim points for the rest of the
  //                   gesture. It is a normal stamp, so remapViewScaleInverse still applies its OWN renderedBox
  //                   guard + neighbour exemption: dragging OFF the item leaves the map as identity rather than
  //                   dragging the item's contraction across the whole stage (a map-point press → quill stroke).
  // The RELEASE resolves FRESH (designCoord), so a drop still hits an enlarged item's true box exactly.
  let frozenViewScaleStamps: readonly ViewScaleInputStamp[] | null = null;
  const NO_VIEW_SCALE_STAMPS: readonly ViewScaleInputStamp[] = [];
  // The SAME freeze for readable-hand mode, but as a CONSTANT OFFSET, not a frozen stamp. A press on a raised
  // card measures how far the raise inverse moved its point (the lift, plus any clamp slide) and every drag-motion
  // frame applies exactly that. The earlier design froze the claimed STAMP and re-tested its drawn box per frame
  // (claimRaiseStamp → identity the moment the finger left the box) — which stepped the sent Y by the whole lift
  // mid-drag, and that step flipped the play-zone card lift at frame rate: the reported "grabbed card flickers /
  // disappears". A constant offset keeps the sent point an affine function of the finger for the entire gesture —
  // continuous by construction. Null = the press was not on a raised surface (identity; the common case).
  let frozenRaiseOffset: { x: number; y: number } | null = null;
  // Where the finger was when that offset was frozen, in the same (post-field, post-eager) space every drag-motion
  // frame measures. Null whenever `frozenRaiseOffset` is.
  let frozenRaisePress: { x: number; y: number } | null = null;
  // The deepest Y the offset path may send — the same floor the fresh inverse clamps to (raiseInverse's MAX_GAME_Y):
  // the game's hit test reads the viewport's last rows as nothing, and a drag deep into the revealed band would
  // otherwise carry the +lift offset past them.
  const RAISE_DRAG_MAX_Y = MIRROR_DESIGN_HEIGHT - 2;

  // RAISE-FADE (F-arrow). How far the finger may travel from the press before the frozen raise correction has
  // faded to nothing, in design px.
  //
  // THE BUG IT FIXES. The correction above is a CONSTANT for the whole gesture, and that was deliberate — a
  // per-frame containment re-test stepped the sent Y by a whole lift mid-drag and flickered the held card. But a
  // constant is only right where it was measured. Press an UNFOCUSED (therefore raised) hand card and drag it up to
  // target: the game reparents the card and lowers the hand, so after the first few frames there is no raise
  // anywhere on screen — yet every frame keeps going out 119px BELOW the finger, for the length of the drag. The
  // game draws the targeting arrow at the coordinate it is sent, so the arrow trails the finger by a constant
  // 119px. That is the reported "the arrow doesn't follow my finger".
  //
  // Measured live (2026-08-25, own instance, 1920x1080), pressing the middle card with no prior
  // hover: stamps [-119 x 9], pointer design y 361, sent y 480 — err +119 held flat over ten drag samples out to
  // 700px of travel. The SAME gesture after a 700ms hover (which focuses the card, so the game has already pulled
  // it up and its stamp dy is 0) sent y 361 — err 0. A mouse user usually hovers before pressing, which is why this
  // hid for three rounds; a finger never does.
  //
  // WHY A TRAVEL RAMP AND NOT "zero it when the hand lowers". Zeroing on the lift is the more direct truth, but the
  // lift is a LOGICAL flag that flips in one frame while the cards slide down over ~140ms — so keying on it
  // reintroduces exactly the one-frame step the constant offset was introduced to remove. Travel is continuous by
  // construction, needs nothing from the renderer, and is correct in both directions: at the press point the
  // correction is still exact (so a tap, which travels ~0, is byte-identical to before this existed), and once the
  // finger is clearly off the hand there is no raised surface under it to correct for anyway.
  //
  // 200px is about two thirds of a raised card's height: a real drag leaves the hand well before then, and a jitter
  // or a short reposition inside the fan keeps essentially the full correction.
  const RAISE_DRAG_FADE_PX = 200;

  /**
   * How much of the frozen raise correction still applies, given how far the finger has travelled from the press.
   * 1 at the press, 0 at RAISE_DRAG_FADE_PX and beyond, linear in between — continuous everywhere, which is the
   * property that matters (see RAISE_DRAG_FADE_PX).
   */
  function raiseFadeWeight(x: number, y: number): number {
    if (frozenRaisePress === null) {
      return 1;
    }
    const travel = Math.hypot(x - frozenRaisePress.x, y - frozenRaisePress.y);
    const w = 1 - travel / RAISE_DRAG_FADE_PX;
    return w < 0 ? 0 : w > 1 ? 1 : w;
  }

  // The last FRESH widened-stage probe (see HOVER_REPROBE_PX/MS): a later PLAIN hover within bounds of it replays
  // its field affine with pure math (memoizedHoverCoord) instead of re-probing. `designWidth` is the design width
  // the probe was taken under — re-checked live so a design-box change WITHOUT a window resize event (the
  // stretch-toggle / frame-only ResizeObserver — see MirrorView's `design` computed) can't apply a stale-width
  // affine. Cleared alongside the cached stage rect (see invalidateRect) and updated by every FRESH resolve
  // (hover, press, release, wheel, tap, peek — see resolveSent), not just a hover's own. Null = no probe yet, or
  // invalidated. Distinct from frozenAffine: that one is exact/unbounded for an entire held gesture; this is an
  // opportunistic, short staleness bound for plain (non-gesture) hover only.
  let hoverProbe: { clientX: number; clientY: number; at: number; affine: FieldAffine; designWidth: number } | null =
    null;

  // WS-2 drag-probe memo (see DRAG_REPROBE_DESIGN/MS): where + when the drag-into-card latch last ran its
  // elementsFromPoint hit test. Null = no probe held (a fresh gesture, or an endpoint cleared it).
  let dragProbe: { clientX: number; clientY: number; at: number } | null = null;

  // May the latch reuse the last probe's verdict for a move to (clientX, clientY)? False (⇒ probe fresh) whenever
  // the finger has travelled DRAG_REPROBE_DESIGN design px or DRAG_REPROBE_MS has passed since that probe.
  function dragProbeFresh(clientX: number, clientY: number): boolean {
    if (dragProbe === null) {
      return false;
    }
    if (nowMs() - dragProbe.at > DRAG_REPROBE_MS) {
      return false;
    }
    const rect = stageRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const dx = ((clientX - dragProbe.clientX) / rect.width) * designWidth();
    const dy = ((clientY - dragProbe.clientY) / rect.height) * MIRROR_DESIGN_HEIGHT;
    return Math.hypot(dx, dy) < DRAG_REPROBE_DESIGN;
  }

  // TOUCH gesture state (mouse never enters this path — gated on pointerType === "touch"). We defer the left
  // PRESS until a gesture is classified: a move past DRAG_THRESHOLD makes it a drag (press fires then), a second
  // finger makes it a two-finger right-click, and a plain lift makes it a tap. Because a tap's click commits on
  // release anyway, deferring the press adds NO perceptible latency to single taps. The down edge is NOT silent,
  // though: the PRIMARY finger's touchdown emits one immediate HOVER (a touch-start counts as a hover — see
  // onTouchDown), so the game's pointer state updates at once instead of waiting for the peek/arm/drag.
  interface TouchPointer {
    startX: number;
    startY: number;
    lastX: number; // latest client X (updated every move) — the live finger for the two-finger scroll centroid
    lastY: number; // latest client Y
    ids: string[]; // hover-first widget ids under the finger at touchdown, topmost first (empty = none)
    blocked: boolean; // a data-touch-block widget covered the press point (see touchTargetsAt's tri-state)
    // R21: the same probe's two scrollbar facts, frozen with `ids`/`blocked` (same walk, same instant) — the eager
    // offer at drag classification is made a gesture later and must not re-probe (the phone-CPU rule) nor answer
    // from a stack the finger has since moved across.
    blockKind: TouchHits["blockKind"];
    topStamp: TouchHits["topStamp"];
    // The HAND-card verdict of the top hit captured at PRESS (isCard && isHandCard). Frozen for the gesture so a
    // grabbed hand card keeps its peek/drag-lift semantics after it RE-PARENTS out of the hand mid-drag (the live
    // isHandCard would flip false there). Makes the reconcile-time re-classification moot for the in-flight gesture.
    handCard: boolean;
    // The design-Y of the press point, frozen at DRAG classification (the resolved press coord's Y). Feeds
    // playZoneThreshold so a HAND card dragged and dropped BELOW its play-zone floor cancels (a right-click).
    dragStartDesignY: number;
    // #13: the top hit at PRESS is a card that is NOT a hand card (isCard && !isHandCard) — a reward / shop card /
    // card-grid card. Frozen at press like handCard; drives the long-press right-click leg. Native twin: NonHandCard.
    nonHandCard: boolean;
    // Renderer-proven bridge from this exact press-time top touch target to its in-fan raised holder. This survives
    // the down-edge hover/focus re-pose and is used only for this gesture's immediate hover and deferred press.
    raisedHandTouchClaim: RaisedHandVisualClaim | null;
    // Latched before the touch-down hover. Programmatic reward focus counts until its authoritative delta arrives.
    focusedAtDown: boolean;
    // Exact ready target at that coordinate. DOM wrappers can overlap sibling rows, so it need not be ids[0].
    focusedRootIdAtDown: string | null;
    moved: boolean; // crossed the drag threshold → a drag
    pressed: boolean; // a drag is underway (the deferred left press has fired — unless scrollGesture withheld it)
    // C5: the drag's press landed in a confirm-eligible widget's true box, so the FIREWALL withheld it — no
    // `pressed:true` went out, no release/cancel may send `pressed:false`, and the release ends the gesture as a
    // focus (hover, plus the button if the finger is still on an eligible widget) instead of a commit.
    confirmPressWithheld: boolean;
    // This drag is an eager scroll: the press and release stay withheld while the engine sends its semantic action.
    scrollGesture: boolean;
    ignore: boolean; // a stray finger arriving mid-drag/3rd finger — never produces its own action
    peeking: boolean; // a long-press peek fired (focus + raise sent, no press) — release un-focuses, never clicks
    // #13: a long-press right-click has fired. Terminal — release emits nothing, later movement is neither a drag nor
    // a hover, and a second finger is a stray (folded into dragActive). Native twin: LongPressed.
    longPressed: boolean;
    peekTimer: ReturnType<typeof setTimeout> | null; // pending long-press timer (cleared on move/2nd-finger/up/cancel)
  }
  const touchPointers = new Map<number, TouchPointer>();
  // The hover-first widget id a classified touch DRAG is holding (null = no drag underway, or the finger isn't
  // over a hover-first widget at all — e.g. a drag started on empty space). Reported to `onHeldCard` at press,
  // every drag-motion frame, and cleared (null) on release/cancel. The renderer decides whether it's actually a
  // card worth lifting; this is just "whatever was under the finger when the drag started".
  let heldTouchCardId: string | null = null;
  // Latch ORIGIN of heldTouchCardId: true only while it came from the flushHover PROBE (a drag begun OFF a card
  // that crossed onto a hand card), false when it came from a press/peek GRAB (the finger went down ON the card).
  // A PROBE latch keeps RE-CLASSIFYING under the finger every active-drag frame — it SWITCHES to a different hand
  // card the finger crosses onto and CLEARS off every hand card; a press/peek GRAB stays STICKY until release (the
  // game's own grab parity). Only meaningful alongside a non-null heldTouchCardId (both reset together). Native
  // twin: GestureMachine._heldFromProbe.
  let heldFromProbe = false;
  // The widget currently "armed" (hovered) by a prior tap. A tap whose TOPMOST hit is the armed widget commits
  // it (and stays armed, so every further tap on it clicks); a tap whose topmost hit is a DIFFERENT widget arms
  // that one instead; a tap on empty space / a block button disarms. Topmost identity is reliable because the
  // renderer refuses to stamp `data-touch-id` on a widget's decorative overlays / hover-preview echoes
  // (see DECORATIVE_OVERLAY / PREVIEW_CONTAINER in mirrorRenderer), so they can't occlude a neighbour's tap.
  let armedRootId: string | null = null;
  // Reward auto-focus sends a hover and then waits on a network round trip for authoritative focus. This narrow
  // local readiness closes that gap without changing the user's normal arm or its debounce clock. Its LIFETIME is
  // not this module's to decide: `focusTarget(…, true)` arms it and rewardFocusCoordinator — the only caller —
  // drops it (releaseReady) the moment the streamed `focused` flag carries the readiness itself, the row or screen
  // goes, the player touches elsewhere, or the settle flow gives up. Kept armed past its focus, it would make a
  // row that merely needs re-focusing take itself on the next tap.
  let programmaticFocusedRootId: string | null = null;
  // R16: the nowMs at which armedRootId was last (re)armed — a re-tap of the SAME widget within
  // TAP_ARM_DEBOUNCE_MS of THIS timestamp is treated as an accidental double-tap (see onTouchUp's commit branch).
  // Only meaningful alongside a non-null armedRootId. Native twin: GestureMachine._armedAtMs.
  let armedAtMs = 0;
  // The widget most recently PRESSED (committed) by a touch tap — the two-step re-tap commit, or a single tap when
  // `tapToFocus` is off. Distinct from `armedRootId` (merely focused): only a PRESS arms the tap-to-unselect gesture
  // (a below-the-hand tap becomes a right-click cancel — see UNSELECT_ZONE_Y). Cleared whenever the selection
  // context resets: arming a DIFFERENT widget, a tap on empty space / a block button, a peek release, or the
  // unselect itself.
  let pressedRootId: string | null = null;
  // CONFIRM TAP — the GAME coordinate the arming hover went to, replayed verbatim by the commit. Deliberately the
  // RESOLVED coordinate, not the client point: a reward / shop / ancient-event option is VIEW-SCALED UP while it is
  // focused, so re-resolving the original client point after it grew would map somewhere else entirely. Re-sending
  // the coordinate the cursor is already parked on is what makes "if it's focused, the click presses it" true.
  let confirmCoord: { coordX: number; coordY: number } | null = null;
  // The removal-service coin has one deliberate exception to the usual "only the confirm button commits" rule:
  // with Tap to focus ON, its second, non-bounce tap opens the picker. Keep that arm separate from `armedRootId` and
  // from confirmTap's UI liveness. The coin remains a real, coordinate-classified service while it is armed even if
  // its decorative DOM stack changes during the focus animation; conversely, hiding the confirm UI must not turn a
  // still-valid focus arm into an ordinary generic re-tap.
  let removalServiceArm: { id: string; armedAtMs: number } | null = null;
  // A clean two-finger gesture (both fingers down before any drag) → a right-click on lift, unless it pinches.
  let twoFinger = false;
  let twoFingerMoved = false;
  let twoFingerX = 0;
  let twoFingerY = 0;
  // Two-finger SCROLL-WHEEL state (see WHEEL_STEP_DESIGN). Once the gesture is a recognized two-finger drag, the
  // vertical CENTROID drift (in DESIGN px) is accumulated and turned into chunky wheel ticks. `twoFingerPrevCentroidY`
  // is the design-space centroid Y at the previous move sample; `twoFingerAccumY` is the unspent delta since the last
  // tick (a full step subtracted per tick, remainder carried).
  let twoFingerAccumY = 0;
  let twoFingerPrevCentroidY = 0;
  // §8: what the eager engine made of this two-finger gesture (see PanClaim). Null ⇒ the ordinary stepper drives it.
  let twoFingerClaim: PanClaim = null;

  // The hover-first widgets under a touch point, TOPMOST first — ASKED OF THE RENDERER (probes.touchStackAt).
  // Which widget owns a pixel is a fact about what was drawn there, and only the backend that drew it can answer:
  // the DOM backend walks its own `data-touch-id` / `data-touch-block` z-stack (the walk this function used to run
  // inline, moved verbatim to mirrorRenderer.domTouchStackAt), a canvas backend answers from its scene. Everything
  // downstream — the tri-state, the arm/commit logic, the scrollbar claim — is unchanged and backend-agnostic.
  function touchTargetsAt(clientX: number, clientY: number): TouchHits {
    return probes.touchStackAt(clientX, clientY);
  }

  /**
   * Which press-time touch target was already ready to activate at this native coordinate?
   *
   * The usual answer is the top rendered id. Some DOM scene wrappers cover their sibling reward rows, however,
   * so the focused row can be lower in that visual stack. In that case accept it only when one of its native
   * interactive descendants owns the resolved point. Merely appearing somewhere in the overlapping stack is not
   * enough: touching a different row must retain the ordinary focus-only first tap.
   */
  function focusedTouchTargetAt(ids: readonly string[], gameX: number, gameY: number): string | null {
    const ready = (id: string): boolean =>
      touch.isFocused?.(id) === true || id === programmaticFocusedRootId;
    const top = ids[0];
    if (top !== undefined && ready(top)) return top;
    if (!interactiveRects || !probes.isUnderNode) return null;

    const rects = interactiveRects();
    for (let i = 1; i < ids.length; i++) {
      const candidate = ids[i];
      if (!ready(candidate)) continue;
      for (const rect of rects) {
        if (
          probes.isUnderNode(rect.id, candidate) &&
          pointInPlacedRect(rect.transform, rect.localRect, gameX, gameY)
        ) {
          return candidate;
        }
      }
    }
    return null;
  }

  // R21 — what the two eager-scroll offers need out of the ONE hit-stack probe a press pays for:
  //   `blocked`   — for the §3 tri-state, and `blockKind` for the one caller that must tell a BUTTON's "this press
  //                 is spoken for" from a SCROLLBAR's (a bar that refuses a press must not also veto the content
  //                 claim, or the press falls through to the game's own scrollbar);
  //   `topStamp`  — the kind of the TOPMOST stamped element, i.e. what the player is actually touching. "other" is
  //                 a plain button or any hover-first widget; "bar"/"thumb" mean the strip itself is on top.
  const NO_TOUCH_HITS: TouchHits = { ids: [], blocked: false, blockKind: null, topStamp: null };

  // The eager engine's two facts about a press point, derived from one probe (see BarPointFacts). `designX` is the
  // RAW widened-design X the resolve started from; both are local quantities and neither may ride onto the wire.
  function barFactsFor(hits: TouchHits, designX?: number): { rawDesignX?: number; barOccluded: boolean } {
    return {
      ...(designX === undefined ? {} : { rawDesignX: designX }),
      // Anything painted over the strip means the player is touching THAT, not the bar — the card-selection
      // dialog's confirm button overlaps the strip, and its presses were being eaten by the bar's claim.
      barOccluded: hits.topStamp !== null && hits.topStamp !== "bar" && hits.topStamp !== "thumb"
    };
  }

  /**
   * T2 — was this press on a hand card that READABLE-HAND MODE IS RAISING? Answered from the retained interactive
   * rects, which the resolve already reads, so it costs no DOM probe: `raiseGoverned` is set on exactly the hand's
   * hitboxes and only while the mode is up, and the box is tested where it is DRAWN (shifted by the rect's own
   * cosmetic `raiseDy`), which is where the pointer is.
   *
   * TWO REASONS IT IS THIS AND NOT A HIT-STACK PROBE. One: a `touchTargetsAt` per left press is a DOM probe per
   * press on a path that has never paid for one (two existing tests count exactly that, and the phone-CPU rule is
   * the reason they do). Two: the scope is right by construction — the drop-cancel exists to compensate for the
   * raise, so it must fire exactly where the raise applies. With the mode off the hand is drawn where the game has
   * it, the drop reaches the game's cancel band on its own, and this returns false everywhere.
   *
   * Note the FOCUSED card is governed at `raiseDy` 0 and still matches, which the frozen raise OFFSET could not
   * answer (it is 0,0 there) — and a mouse user hovers before pressing, so that is the common case.
   */
  function pressedRaisedHandCard(x: number, y: number): boolean {
    if (!interactiveRects) {
      return false;
    }
    for (const r of interactiveRects()) {
      if (r.raiseGoverned && pointInPlacedRect(r.transform, r.localRect, x, y - r.raiseDy)) {
        return true;
      }
    }
    return false;
  }

  // R11 WS-M: has the mouse travelled past the TAP slop since its press? Measured in DESIGN px against the same
  // DRAG_THRESHOLD_DESIGN the touch path classifies a drag with, so the same physical travel means the same thing on
  // a phone and on a desktop. A degenerate stage rect reads as "no travel" (there is nothing to scale by).
  function movedPastTapSlop(from: { x: number; y: number }, clientX: number, clientY: number): boolean {
    const rect = stageRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const dx = ((clientX - from.x) / rect.width) * designWidth();
    const dy = ((clientY - from.y) / rect.height) * MIRROR_DESIGN_HEIGHT;
    return Math.hypot(dx, dy) >= DRAG_THRESHOLD_DESIGN;
  }

  // The TOUCH drag threshold for the current stage scale (see TOUCH_TAP_SLOP_CSS_PX): the design constant, floored
  // at the CSS-px slop converted through the stage's uniform letterbox scale. Cheap (the cached rect), re-read per
  // move so a stretch/resize mid-gesture can't wedge a stale scale.
  function dragThresholdDesign(): number {
    return Math.max(DRAG_THRESHOLD_DESIGN, TOUCH_TAP_SLOP_CSS_PX * designPerClientPx());
  }

  // Cancel a pointer's pending long-press peek timer (a move/2nd-finger/up/cancel stops the peek from firing).
  function clearPeekTimer(p: TouchPointer): void {
    if (p.peekTimer !== null) {
      clearTimeout(p.peekTimer);
      p.peekTimer = null;
    }
  }

  // CONFIRM TAP — take the button down and forget the coordinate it would have clicked. Called from every path that
  // un-focuses the widget it belongs to: a tap that arms something else or lands on empty space / a block button, a
  // peek release, a two-finger right-click, the below-line unselect, a routed map tap, a cancelled gesture — plus
  // the MOUSE moving off it (see flushHover) and the target leaving the tree (MirrorView). Cheap and idempotent, so
  // it can be called unconditionally next to the existing `armedRootId = null` disarms.
  function clearConfirm(): void {
    confirmCoord = null;
    if (confirmTapState.targetId !== null) {
      hideConfirmTap();
    }
  }

  // CONFIRM TAP — the commit the button calls: press the option the cursor is already focused on. Registered with
  // the shared module so the button never has to know about coordinates or the wire.
  const releaseConfirmCommit = setConfirmCommit(() => {
    const coord = confirmCoord;
    if (!coord) {
      return;
    }
    pressedRootId = confirmTapState.targetId;
    confirmCoord = null;
    removalServiceArm = null;
    send({ kind: "click", button: "left", ...coord });
  });

  // CONFIRM TAP — the hide-side teardown (see confirmTap.setConfirmHidden): WHOEVER takes the button down —
  // this capture's own clearConfirm, MirrorView's liveness/setting hides, a refused re-show, the commit itself —
  // the stored coordinate dies with it, and so does the ARM the confirm branch put on that target. Without the
  // disarm, a button hidden by liveness left `armedRootId` pointing at the widget, and the next tap on it fell
  // through to the armed-commit branch (an unguarded click on a widget the feature exists to guard). Per-target:
  // an arm belonging to a DIFFERENT widget (the ordinary two-step tap's) is never touched.
  const releaseConfirmHidden = setConfirmHidden((targetId) => {
    confirmCoord = null;
    if (armedRootId === targetId) {
      armedRootId = null;
    }
  });

  // A full click (press+release in-game): the host runs press→release when `pressed` is absent.
  function fullClick(button: "left" | "right", clientX: number, clientY: number): void {
    send({ kind: "click", button, ...designCoord(clientX, clientY) });
  }

  // C2 — the single "is this resolved point an irreversible choice" question. Null when the feature is off, the
  // button can't be drawn (sprites unresolved — the widget then falls back to the ordinary two-step, matching the
  // pre-feature behaviour rather than becoming uncommittable), the classifier is unwired, or the point is outside
  // every eligible widget's true game box.
  function confirmHitAt(coordX: number, coordY: number): ConfirmTapHit | null {
    if (touch.confirmTap?.() !== true || !confirmButtonReady() || !touch.confirmTapAt) {
      return null;
    }
    return touch.confirmTapAt(coordX, coordY);
  }

  // The remove-a-card service is a focus gesture first even when Confirm tap is OFF or its sprites have not loaded.
  // Its renderer classifier is already authoritative game-space geometry; do not route this through confirmHitAt,
  // which quite correctly refuses to answer when the confirm setting/button is unavailable.
  function removalServiceHitAt(coordX: number, coordY: number): ConfirmTapHit | null {
    const hit = touch.confirmTapAt?.(coordX, coordY) ?? null;
    return hit?.retapActivates === true ? hit : null;
  }

  function clearRemovalServiceArm(): void {
    removalServiceArm = null;
  }

  // CONFIRM TAP — the arm + button pair every guarded path shares: park the game cursor on the point (hover),
  // remember it as the commit coordinate, and raise the button. The arm keeps re-tap semantics whole (armedAtMs
  // feeds the accidental-double-tap debounce, and a later ineligible tap on the same widget still two-steps).
  function armConfirmAt(id: string, kind: ConfirmTapKind, coord: { coordX: number; coordY: number }): void {
    armedRootId = id;
    armedAtMs = nowMs();
    pressedRootId = null;
    confirmCoord = coord;
    send({ kind: "hover", ...coord });
    showConfirmTap(id, kind);
  }

  // C5 — the firewalled LEFT-click sender for the touch TAP branches: the click flows unless the point lands in an
  // eligible box (then the tap becomes the focus+button pair instead). The top-of-tap classification usually makes
  // this a provable no-op — it already returned for any eligible point — so this is defence in depth for branches
  // added later. Always sends at the already-resolved release coordinate, so
  // classification and effect are the same number by construction.
  function touchLeftClick(
    coord: { coordX: number; coordY: number },
    allowArmedRemovalRetap = false
  ): void {
    const hit = confirmHitAt(coord.coordX, coord.coordY);
    if (hit !== null && !allowArmedRemovalRetap) {
      armConfirmAt(hit.id, hit.kind, coord);
      return;
    }
    send({ kind: "click", button: "left", ...coord });
  }

  // change 2: after a TAP clicks the END-TURN button, park the cursor away from it so its long-press HoverTip
  // doesn't pop when the enemy turn ends. Called AFTER the click on the tap-end path (never during the hold), with
  // the tap's already-RESOLVED game point (releaseCoord — the same value the click sent, so hit-test and click can
  // never disagree, and no second resolve is paid). Ordering is safe WITHOUT deferral: the click and this hover are
  // two ordered `send` calls, and the server-side InputCoalescer only coalesces a hover into a PRECEDING trailing
  // hover — it never drops or reorders a click, so a hover enqueued after a click keeps click→hover order and
  // cannot suppress the click.
  //
  // R13: park at the RESOLVED screen CENTER, not directly below the button (the old (centerX, maxY + 24) point) —
  // a below-button park still sat close enough to the button's box that its long-press HoverTip could re-arm and
  // linger after the turn ends. Screen center reuses the SAME pattern as the peek-release un-focus (unfocusCenter):
  // the stage-center CLIENT point routes through designCoord (the resolver), whose fraction 0.5 reconstructs the
  // RAW design center (0.5·designWidth, 540) and inverts a WIDENED stage's paint shift. The button's box is still
  // used ONLY to decide whether the tap landed on it (endTurnBoxAt); its coordinates no longer feed the parked
  // point. Native twin: MaybeUnhoverEndTurn (ResolveFresh(DesignWidth/2, 540)).
  function maybeUnhoverEndTurn(gameX: number, gameY: number): void {
    const box = touch.endTurnBoxAt?.(gameX, gameY);
    if (!box) return;
    const r = stageRect();
    send({ kind: "hover", ...designCoord(r.left + r.width / 2, r.top + r.height / 2) });
  }

  function releasePointer(id: number): void {
    try {
      stage.releasePointerCapture(id);
    } catch {
      // Already released / never captured — ignore.
    }
  }

  // The stage's rendered (scaled) rect, CACHED. getBoundingClientRect forces a synchronous layout; during a
  // drag/scroll the reconciler dirties layout every frame, so reading it per hover frame caused a forced
  // re-layout each frame. The rect only changes on window resize / page scroll / fullscreen (all of which the
  // ResizeObserver-driven scale also follows), so we cache it and invalidate on those events instead.
  let cachedRect: DOMRect | null = null;
  // R10 WS-F: the design width the cached rect was measured under. A stretch toggle changes the design box AND the
  // letterbox scale with no window event at all, so the cache SELF-HEALS on that change even if a caller forgets the
  // explicit seam below (the same self-invalidation the hover-probe memo already carries).
  let cachedRectDesignWidth = 0;
  const stageRect = (): DOMRect => {
    const dw = designWidth();
    if (cachedRect === null || cachedRectDesignWidth !== dw) {
      cachedRect = stage.getBoundingClientRect();
      cachedRectDesignWidth = dw;
    }
    return cachedRect;
  };
  const invalidateRect = (): void => {
    cachedRect = null;
    hoverProbe = null; // the rect it was taken against is gone — the next hover must re-probe
    dragProbe = null; // WS-2: same reasoning — its travel bound is measured against that rect
    resetNearMissMemory(); // a new stage geometry ⇒ new bands; a remembered push direction is meaningless
  };

  // FIX 3 (R7): un-map a RESOLVED game point off an enlarged view-scale item's halo onto its true hit box — the web
  // twin of native's InputRouter.ToDesign → ViewScaler.InverseRemap, applied ONCE per resolved point (hover/press/
  // drag/release) so every downstream stage (the send + the gesture state) sees the corrected point. Only points
  // inside a stamp's ScaledBox change; outside every ScaledBox (or with the feature off / no view-scale screen up)
  // it is identity — byte-identical to before. The registry is read FRESH each call (a live read of the renderer's
  // per-drain cache), so it always reflects the latest drain.
  //
  // `rawDesignX` is the pointer's WIDENED-DESIGN x (pre-map, pre-near-miss). Handed to the false-halo guard so a
  // stamp can only claim the point when the pointer really was over its ON-STAGE box (see viewScaleInverse). The raw
  // Y is simply the incoming `coordY`: Y is never spread (design Y === game Y at every stage width) and the near-miss
  // pass only ever moves X, so the pre-inverse coordY IS the raw design Y. Omitted (or the gate off) ⇒ no guard ⇒
  // byte-identical to the pre-guard path.
  // `frozen` (WS-F) replaces the LIVE registry with the gesture's frozen claim (see frozenViewScaleStamps): a held
  // drag never re-tests stamps it did not press on.
  function applyViewScaleInverse(
    coordX: number,
    coordY: number,
    rawDesignX?: number,
    frozen?: readonly ViewScaleInputStamp[] | null
  ): { coordX: number; coordY: number } {
    if (!viewScaleInputStamps) {
      return { coordX, coordY };
    }
    const stamps = frozen ?? viewScaleInputStamps();
    if (stamps.length === 0) {
      return { coordX, coordY };
    }
    const raw = rawDesignX !== undefined ? { x: rawDesignX, y: coordY } : undefined;
    const r = remapViewScaleInverse(coordX, coordY, stamps, true, raw);
    return { coordX: r.x, coordY: r.y };
  }

  // READABLE-HAND MODE inverse: map a point that landed on a cosmetically RAISED surface back down to the
  // coordinate the game actually has there. Applied AFTER the view-scale inverse (the two never overlap — one is a
  // combat hand / creature-HUD shift, the other a reward/shop enlargement — but this stays the last word on Y,
  // matching where the visual offset itself is applied). `frozen` replaces the live list with the gesture's claim.
  function applyRaiseInverse(
    coordX: number,
    coordY: number,
    rawDesignX?: number,
    frozen?: readonly RaiseInputStamp[] | null,
    visualClaim?: RaisedHandVisualClaim | null,
  ): {
    coordX: number;
    coordY: number;
    deferred: ReturnType<typeof deferRaisePoint> | null;
    stamps: readonly RaiseInputStamp[];
  } {
    if (!raiseInputStamps) {
      return { coordX, coordY, deferred: null, stamps: [] };
    }
    const stamps = frozen ?? raiseInputStamps();
    if (stamps.length === 0) {
      return { coordX, coordY, deferred: null, stamps };
    }
    // Y is never spread, so the pre-inverse coordY IS the raw design Y (same argument as applyViewScaleInverse).
    // The per-pixel inverse maps the drawn surface back to its game-space placement; the same path serves hand
    // cards and creature HUDs.
    const raw = rawDesignX !== undefined ? { x: rawDesignX, y: coordY } : undefined;
    const r = deferRaisePoint(coordX, coordY, stamps, raw, visualClaim);
    return {
      coordX: r.x,
      coordY: r.y,
      deferred: r,
      stamps,
    };
  }

  function settleRaiseAfterCanonicalX(
    coordX: number,
    raised: ReturnType<typeof applyRaiseInverse>,
    visualClaim?: RaisedHandVisualClaim | null,
  ): { coordX: number; coordY: number } {
    if (raised.deferred === null) return { coordX, coordY: raised.coordY };
    const settled = settleDeferredRaisePoint(coordX, raised.coordY, raised.deferred, raised.stamps, visualClaim);
    return { coordX: settled.x, coordY: settled.y };
  }

  // WS-F: which stamp (if any) owns a freshly-resolved point — the claim a press FREEZES for its whole gesture.
  // Same registry, same false-halo guard the remap itself applies, so freezing the claim can never select a stamp the
  // live path would have refused. Returns null when the feature/registry is off ⇒ the frozen list is empty ⇒ identity.
  function claimViewScaleAt(coordX: number, coordY: number, rawDesignX: number): ViewScaleInputStamp | null {
    if (!viewScaleInputStamps) {
      return null;
    }
    const stamps = viewScaleInputStamps();
    if (stamps.length === 0) {
      return null;
    }
    const raw = { x: rawDesignX, y: coordY };
    return claimViewScaleStamp(coordX, coordY, stamps, raw);
  }

  // R10 WS-E — EAGER-SCROLL Y COMPENSATION, applied to a freshly mapped point BEFORE the near-miss and the
  // view-scale inverse. The visual-anchor map answers "what is painted here", and while a scrollable is running
  // AHEAD of the host what is painted here is not what the GAME has here: the container carries a cosmetic
  // `translate` of (eager − streamed), so a point inside it must be reported `delta` px back up the content to reach
  // the game's own coordinate. Doing it FIRST is what keeps every downstream stage honest — the near-miss pass and
  // the view-scale registry both test GAME-space rects, so handing them an un-compensated (screen) Y would have them
  // vetting a point against boxes it isn't really over. Identity when nothing is scrolled eagerly or the engine is
  // absent.
  function eagerCompensate(coordX: number, coordY: number): { coordX: number; coordY: number } {
    return eagerScroll ? eagerScroll.compensate(coordX, coordY) : { coordX, coordY };
  }

  // R19 6a — the squeeze rendered-box gate, applied to a resolved coordinate the near-miss pass DID NOT vet. It runs
  // in exactly the complement of `nearMissApplies(squeezed)`: a squeezed coordinate under the default switches, and
  // never twice (with `?nearmissSqueezeGate=off` the full pass runs there instead and this is inert). Same rect
  // provider, same read-only cached array, no DOM probe — so a held drag can afford it per motion frame too.
  function squeezeGate(
    coordX: number,
    coordY: number,
    designX: number,
    squeezed: boolean,
    designY: number = coordY
  ): number {
    if (!interactiveRects || nearMissApplies(squeezed)) {
      return coordX;
    }
    const rects = interactiveRects();
    return rects.length > 0 ? pushOutOfSqueezeMiss(coordX, coordY, designX, rects, designY) : coordX;
  }

  // Resolve a viewport pixel to a GAME coordinate through the visual-anchor map for a SENT event (hover/press/
  // release), applying the hit-consistency near-miss pass. On a widened stage this probes the DOM once
  // (elementsFromPoint) to find the painting element, then walks the retained interactive rects (no DOM layout) to
  // push the point out of any button it near-missed; on 16:9 it's pure fraction math (no probe, no rects).
  function resolveSent(
    clientX: number,
    clientY: number,
    touchClaim?: RaisedHandVisualClaim | null,
  ): {
    coordX: number;
    coordY: number;
    affine: FieldAffine;
    preCoordX: number;
    preRaiseX: number;
    preRaiseY: number;
    preCoordY: number;
    raiseOffsetX: number;
    raiseOffsetY: number;
    designX: number;
    squeezed: boolean;
  } {
    const dw = designWidth();
    // The anchor map's one DOM-shaped question — "which painter anchors this pixel" — goes through the renderer
    // seam (M0). On 16:9 it is never asked at all (mapPointerToGame short-circuits before probing).
    const m = mapPointerToGame(clientX, clientY, stageRect(), dw, probes.spreadPainterAt);
    const compensated = eagerCompensate(m.coordX, m.coordY);
    // READABLE-HAND MODE: un-map the cosmetic raise HERE, before the hit-consistency pass — the same reasoning (and
    // the same place in the pipeline) as eagerCompensate above. The pass tests GAME-space rects, so a Y still
    // carrying the raise has it vetting the point against boxes it is not really over: measured live on a widened
    // stage, a hover in the revealed band of a raised hand card made THAT CARD'S OWN hitbox read as a near-miss
    // offender (its game box contains the design Y, its rendered box does not) and pushed the sent X clear across
    // the hand — design (1091, 1010) went out as game (280, 1010), so the game focused nothing. `compensated.coordY`
    // stays the pointer's own design Y and is handed to the pass separately for its RENDERED test.
    const visualClaim = touchClaim ?? probes.raisedHandVisualClaimAt?.(clientX, clientY) ?? null;
    const raised = applyRaiseInverse(compensated.coordX, compensated.coordY, m.designX, null, visualClaim);
    const designY = compensated.coordY;
    let coordX = raised.coordX;
    // The near-miss pass vets EVERY fresh resolve — exact painter hits included. That's safe for the painter's own
    // frame: with `coordX = designX − painterDx`, any rect sharing the painter's dx contains the coord iff its
    // rendered rect contains the pointer (the SAME point is tested), so same-frame overlaps (the deck under its
    // icon, a hitbox under its spine, card parts) are self-exempt. What it catches is a coord landing in a
    // DIFFERENT-frame rect — a big painter's box extending transparently over other-dx content (the map parchment's
    // torn-edge box covers the whole TopBar band: its exact inverse hovered Floor/Deck/Back from empty space).
    // It only matters on a widened stage (no shift ⇒ rendered rect === game rect), so 16:9 stays strictly zero-cost.
    // SQUEEZE GATE (?nearmissSqueezeGate=off): a point the anchor map resolved through the UNIFORM SQUEEZE (no
    // specific painter, or the oversized parallax backdrop) carries no per-painter dx for the pass to undo — see
    // nearMissApplies. Skipping it is what makes a wide-stage hover sweep single-valued.
    if (dw > MIRROR_DESIGN_WIDTH) {
      if (interactiveRects && nearMissApplies(m.squeezed)) {
        const rects = interactiveRects();
        if (rects.length > 0) {
          coordX = pushOutOfNearMiss(raised.coordX, raised.coordY, m.designX, rects, designY);
        }
      } else {
        // R19 6a: the pass was suppressed for a squeezed coordinate — the rendered-box gate still holds it to the
        // ONE invariant the suppression threw away (see squeezeGate / pushOutOfSqueezeMiss).
        coordX = squeezeGate(raised.coordX, raised.coordY, m.designX, m.squeezed, designY);
      }
    }
    if (dw > MIRROR_DESIGN_WIDTH) {
      // This IS the DOM probe (mapPointerToGame's elementsFromPoint walk) — memoize its field affine so the next
      // PLAIN hover flush within HOVER_REPROBE_PX/MS can replay it with pure math instead of paying another one
      // (see hoverCoord). Every fresh resolve reaches here — hover, press, release, wheel, tap, peek — so any of
      // them refreshes the memo, not just a hover's own.
      hoverProbe = { clientX, clientY, at: nowMs(), affine: m.affine, designWidth: dw };
    }
    // FIX 3: apply the view-scale inverse LAST (after the near-miss), leaving the field affine untouched — the affine
    // drives the spread-field freeze/replay, which the view-scale inverse composes ON TOP of (never replaces).
    // A hand card's visual owner may differ from its retained hitbox's single spreadDx while the 5→4 fan is
    // reflowing.  The renderer proved the raw pixel first; only then may the shared resolver settle the already
    // canonicalized X back onto that same card.  Empty/dead pixels carry no proof and retain the normal raw guard.
    const settledRaise = settleRaiseAfterCanonicalX(coordX, raised, visualClaim);
    const scaled = applyViewScaleInverse(settledRaise.coordX, settledRaise.coordY, m.designX);
    // `preCoordX`/`designX` are the inputs the view-scale claim is decided from; `raiseOffset*` is what the raise
    // inverse DID to this resolve's point (raised − pre-raise, i.e. lift plus any clamp slide; 0,0 off the hand).
    // Returned (not re-derived) so freezeAt can freeze the SAME decisions this resolve made without paying a
    // second registry scan.
    return {
      coordX: scaled.coordX,
      coordY: scaled.coordY,
      affine: m.affine,
      preCoordX: coordX,
      preCoordY: settledRaise.coordY,
      // The point BEFORE the raise inverse touched it — i.e. where the finger itself is, in the same space every
      // drag-motion frame measures (post-field, post-eager-compensation). The raise-fade ramp needs a press anchor
      // in exactly that space; deriving it from preCoord − raiseOffset would be right for Y and only accidentally
      // right for X (the near-miss pass sits in between, and never fires on a raised hand rect).
      preRaiseX: compensated.coordX,
      preRaiseY: compensated.coordY,
      raiseOffsetX: settledRaise.coordX - compensated.coordX,
      raiseOffsetY: settledRaise.coordY - compensated.coordY,
      designX: m.designX,
      squeezed: m.squeezed,
    };
  }

  // The upstream `{coordX, coordY}` payload for a plain (non-frozen) resolve — a fresh anchor-map probe + near-miss.
  // Used by every EXACT caller (press/release/wheel/tap/peek) and by hoverCoord's own fresh-probe fallback.
  function designCoord(clientX: number, clientY: number, touchClaim?: RaisedHandVisualClaim | null): { coordX: number; coordY: number } {
    const { coordX, coordY } = resolveSent(clientX, clientY, touchClaim);
    return { coordX, coordY };
  }

  // The same fresh resolve, plus the RAW widened-design X it was resolved FROM (`resolveSent` already computes it).
  // Only the scrollbar claim needs it — see eagerScroll.beginBarPan's rendered-box gate — and it must never leak into
  // a `send` payload, which is why `designCoord` above still returns the two-field upstream shape verbatim.
  function designCoordRaw(clientX: number, clientY: number, touchClaim?: RaisedHandVisualClaim | null): { coordX: number; coordY: number; designX: number } {
    const { coordX, coordY, designX } = resolveSent(clientX, clientY, touchClaim);
    return { coordX, coordY, designX };
  }

  // The shared PURE-MATH resolve behind both the gesture freeze and the hover-probe memo: replay a given field
  // affine — coordX = a·designX + b — against the current pointer, with NO DOM probe. Y is always plain
  // 1920-space. Also returns designX (1920-widened-space, pre-affine) so a caller can run the near-miss pass
  // without re-deriving it.
  function fieldAffineCoord(
    clientX: number,
    clientY: number,
    affine: FieldAffine
  ): { coordX: number; coordY: number; designX: number } {
    const rect = stageRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { coordX: 0, coordY: 0, designX: 0 };
    }
    const coordY = clamp01((clientY - rect.top) / rect.height) * MIRROR_DESIGN_HEIGHT;
    const designX = clamp01((clientX - rect.left) / rect.width) * designWidth();
    const coordX = Math.min(Math.max(affine.a * designX + affine.b, 0), MIRROR_DESIGN_WIDTH);
    return { coordX, coordY, designX };
  }

  // A FROZEN resolve (during a held gesture): replay the press-time field affine so drag-motion never re-probes
  // the DOM or the interactive rects.
  function frozenCoord(clientX: number, clientY: number): { coordX: number; coordY: number } {
    const raw = fieldAffineCoord(clientX, clientY, frozenAffine ?? { a: 1, b: 0 });
    // R10 WS-E: a held drag inside an eagerly-scrolled container still reports GAME coordinates (see
    // eagerCompensate). The engine exempts the scrollable the drag is PANNING — that gesture's whole point is that
    // the host consumes relative motion, and compensating by an offset that grows with the drag would subtract the
    // scroll from the very deltas producing it.
    const { coordX: compX, coordY: designY } = eagerCompensate(raw.coordX, raw.coordY);
    // Same pipeline position as the fresh resolve: the raise is un-mapped BEFORE the rendered-box gate, so the gate
    // vets a genuine game-space point (see resolveSent). Through the gesture's frozen CONSTANT offset — a drag that
    // pressed on a raised card keeps translating by exactly what the press was translated by, for its whole length
    // (see frozenRaiseOffset for why this must never be a containment re-test). With `?dragFreezeMapping=off` the
    // LIVE registry is re-tested per frame instead, as before the freeze existed.
    let raisedX: number;
    let coordY: number;
    if (frozenRaiseOffset === null) {
      raisedX = compX;
      coordY = designY;
    } else {
      const w = raiseFadeWeight(compX, designY);
      raisedX = Math.min(Math.max(compX + frozenRaiseOffset.x * w, 0), MIRROR_DESIGN_WIDTH);
      coordY = Math.min(Math.max(designY + frozenRaiseOffset.y * w, 0), RAISE_DRAG_MAX_Y);
    }
    // R19 6a: the frozen replay never ran ANY hit-consistency pass, so a drag whose press the map could not anchor
    // (dead wide-stage space) replayed straight into a differently-shifted widget's game rect for its whole length
    // — the reported bug (dragging right of the map legend dragged the legend). The gate holds the replay to the
    // same invariant a fresh resolve now gets. Keyed on the press's FROZEN squeezed flag, not on the affine: a drag
    // begun on a CARD freezes the same squeeze affine on purpose and must keep replaying it untouched (and pay no
    // rect read per motion frame). Costs one read of the cached rect array, no DOM probe.
    let coordX = squeezeGate(raisedX, coordY, raw.designX, frozenSqueezed, designY);
    // FIX 3: drag-motion also un-maps off a view-scale halo (native applies InverseRemap on every event, drags too).
    // WS-F: through the gesture's FROZEN claim, not the live registry (see frozenViewScaleStamps) — so a stamp the
    // drag merely crosses cannot take the coordinate over mid-gesture.
    return applyViewScaleInverse(coordX, coordY, raw.designX, frozenViewScaleStamps);
  }

  // A MEMOIZED hover resolve (see hoverCoord): replay the last probe's field affine with pure math, then push it
  // out of any near-miss over the CURRENT retained interactive rects — no DOM probe either way (the rects are
  // read fresh each call; only the elementsFromPoint z-stack walk is skipped), matching what resolveSent would do
  // on a fresh probe at this same point.
  function memoizedHoverCoord(clientX: number, clientY: number, affine: FieldAffine): { coordX: number; coordY: number } {
    const replayed = fieldAffineCoord(clientX, clientY, affine);
    const designX = replayed.designX;
    // R10 WS-E: same eager-scroll compensation, at the same place in the pipeline as the fresh resolve — a memoized
    // hover must report the same GAME point a fresh probe at that pixel would.
    const { coordX: rawX, coordY: designY } = eagerCompensate(replayed.coordX, replayed.coordY);
    // …and the raise inverse in the same place as the fresh resolve, for the same reason it has to be BOTH: the memo
    // replays within 24px/120ms of a fresh probe, so a wide-stage hover sweep interleaves the two and any ordering
    // difference between them shows up as a bistable sent coordinate.
    const raised = applyRaiseInverse(rawX, designY, designX);
    let coordX = raised.coordX;
    // Same SQUEEZE GATE as the fresh resolve, asked of the replayed FIELD: replaying the squeeze affine yields a
    // squeeze coordinate whatever painter the memo was taken over, so the pass has nothing to undo here either.
    if (interactiveRects && nearMissApplies(isSqueezeAffine(affine))) {
      const rects = interactiveRects();
      if (rects.length > 0) {
        coordX = pushOutOfNearMiss(raised.coordX, raised.coordY, designX, rects, designY);
      }
    } else {
      // R19 6a: and the same rendered-box gate in the suppressed case, for the same reason it is in resolveSent.
      coordX = squeezeGate(raised.coordX, raised.coordY, designX, isSqueezeAffine(affine), designY);
    }
    const settledRaise = settleRaiseAfterCanonicalX(coordX, raised);
    // FIX 3: apply the view-scale inverse LAST (after the near-miss), matching resolveSent's fresh-probe ordering.
    return applyViewScaleInverse(settledRaise.coordX, settledRaise.coordY, designX);
  }

  // The upstream `{coordX, coordY}` for a PLAIN (non-frozen) HOVER flush specifically — see designCoord for the
  // always-fresh resolve every OTHER kind (press/release/wheel/tap/peek) uses. On a widened stage within
  // HOVER_REPROBE_PX/MS of the last fresh probe (and taken under the SAME design width — see hoverProbe), replays
  // its field affine (memoizedHoverCoord) instead of paying another elementsFromPoint walk; otherwise resolves
  // FRESH via designCoord, which refreshes the memo for the next flush (see resolveSent). On 16:9 this always
  // takes the fresh branch, but that's already zero-probe (mapPointerToGame's short-circuit) — byte-identical to
  // before this memo existed.
  function hoverCoord(clientX: number, clientY: number): { coordX: number; coordY: number } {
    const dw = designWidth();
    if (dw > MIRROR_DESIGN_WIDTH && hoverProbe && hoverProbe.designWidth === dw) {
      const dx = clientX - hoverProbe.clientX;
      const dy = clientY - hoverProbe.clientY;
      if (Math.hypot(dx, dy) <= HOVER_REPROBE_PX && nowMs() - hoverProbe.at <= HOVER_REPROBE_MS) {
        return memoizedHoverCoord(clientX, clientY, hoverProbe.affine);
      }
    }
    return designCoord(clientX, clientY);
  }

  // The stage's top edge in viewport px (its cached rect origin) — the clamp ceiling for a peek's un-focus hover.
  // Begin a gesture freeze: resolve FRESH at the press point (the returned coord is sent as the press) and remember
  // its field affine so drag-motion replays it with pure math.
  // `designX` (the RAW widened-design X this resolve started from) rides along for the scrollbar claim's rendered-box
  // gate — see eagerScroll.beginBarPan. Callers that only send the coordinate ignore it.
  function freezeAt(
    clientX: number,
    clientY: number,
    touchClaim?: RaisedHandVisualClaim | null,
  ): { coordX: number; coordY: number; designX: number; preRaiseX: number; preRaiseY: number } {
    const {
      coordX,
      coordY,
      affine,
      preCoordX,
      preCoordY,
      preRaiseX,
      preRaiseY,
      raiseOffsetX,
      raiseOffsetY,
      designX,
      squeezed
    } = resolveSent(clientX, clientY, touchClaim);
    frozenAffine = affine;
    frozenSqueezed = squeezed; // R19 6a: the press decided "unanchored", and every replayed frame inherits it
    resetNearMissMemory(); // a press starts a fresh band walk (the hover that preceded it doesn't govern it)
    // WS-F: freeze the view-scale question too — the claim (or its absence) decided HERE governs every drag-motion
    // frame of this gesture. Decided from the same pre-inverse point the resolve above used, so the freeze and the
    // press event can never disagree.
    const claim = claimViewScaleAt(preCoordX, preCoordY, designX);
    frozenViewScaleStamps = claim === null ? NO_VIEW_SCALE_STAMPS : [claim];
    // …and the raise as the CONSTANT offset this very resolve applied (0,0 off the hand ⇒ null ⇒ identity replay).
    // The freeze and the press event can never disagree: the offset IS what the press was moved by.
    frozenRaiseOffset = raiseOffsetX === 0 && raiseOffsetY === 0 ? null : { x: raiseOffsetX, y: raiseOffsetY };
    // …and WHERE it was measured, so the fade ramp has an anchor. Frozen together with the offset and cleared
    // together with it, so the two can never describe different presses.
    frozenRaisePress = frozenRaiseOffset === null ? null : { x: preRaiseX, y: preRaiseY };
    // `preRaise*` is the press point BEFORE the raise inverse touched it — the space the drawn boxes are tested in
    // (see pressedRaisedHandCard). Returned rather than re-resolved, for the same reason resolveSent returns it.
    return { coordX, coordY, designX, preRaiseX, preRaiseY };
  }

  // End a gesture freeze (a release resolves FRESH via designCoord for exact drop targeting, so this only clears).
  function clearFreeze(): void {
    frozenAffine = null;
    frozenSqueezed = false;
    frozenViewScaleStamps = null;
    frozenRaiseOffset = null;
    frozenRaisePress = null;
    resetNearMissMemory(); // ditto on release — the post-gesture hover decides its own direction
    // R10 WS-E: a gesture freeze and an eager PAN are armed and cleared together — both are "this held gesture owns
    // the mapping", and a pan outliving its gesture would keep exempting taps from compensation.
    eagerScroll?.endPan();
  }

  // R11 WS-S (live-found): the RELEASE is the gesture's last position, and the host gets it — its own relative
  // chain (press → motions → release) ends there. So the eager offset must be taken there too. Without this the
  // tail of a gesture (every pointermove queued but not yet flushed when the pointer went up, which on a slow
  // frame is most of a fast flick) went UPSTREAM but never locally, and the content jumped by that tail the moment
  // the host's answer landed: measured at 114 design px on a live map flick at 1280x720.
  function feedPanRelease(coordY: number): void {
    if (eagerScroll?.panActive()) {
      eagerScroll.panTo(coordY);
    }
  }

  // R10 WS-E / R11 WS-S §5: offer the gesture just classified to the eager engine, with what only WE can see about
  // the press point (the DOM hit stack). The engine owns the decision — which scrollable, which kind, what the
  // player is doing — and answers whether the semantic scroll action owns the gesture.
  function maybeBeginPan(
    hits: TouchHits,
    pressCoord: { coordX: number; coordY: number; designX?: number },
    source: "press" | "gesture" = "press"
  ): PanClaim {
    if (!eagerScroll) {
      return null;
    }
    return eagerScroll.beginPan(pressCoord.coordX, pressCoord.coordY, {
      ids: hits.ids.length,
      // R21: a SCROLLBAR's own block stamp no longer vetoes the CONTENT claim. It used to, and between it and the
      // bar claim's own (narrower) gates sat points claimed by nobody: the press went upstream at a coordinate the
      // game reads as its scrollbar, so the game's bar took a gesture the client had just decided was not the bar's.
      // A press the bar genuinely owns is refused by the zone test instead (see eagerScroll.barOwnsPoint).
      blocked: hits.blockKind === "button",
      source,
      ...barFactsFor(hits, pressCoord.designX)
    });
  }

  function flushHover(): void {
    rafId = 0;
    if (!pending) {
      return;
    }
    const { x, y } = pending;
    pending = null;
    // A drag-motion frame — a mouse button held, or a touch gesture in progress — replays the FROZEN affine with
    // pure math (no DOM probe); a plain hover re-probes the anchor map so it follows what's painted under the cursor.
    const frozen = frozenAffine !== null && (heldButton !== null || touchPointers.size > 0);
    const coord = frozen ? frozenCoord(x, y) : hoverCoord(x, y);

    // CONFIRM TAP — the MOUSE half of "hide the button when the option stops being focused". A confirm button is
    // only ever raised by a TOUCH tap, but this client is the sole author of its own game cursor, so a mouse that
    // wanders off the option un-focuses it in the game and the button must follow. Three gates keep it free on a
    // phone and on every other frame: a button has to be up at all, and this has to be a PLAIN HOVER — no finger
    // down (a touch move always has one, so touch never reaches the probe) and no held button.
    if (confirmTapState.targetId !== null && touchPointers.size === 0 && heldButton === null) {
      if (touchTargetsAt(x, y).ids[0] !== confirmTapState.targetId) {
        clearConfirm();
      }
    }

    // R10 WS-E: feed an armed PAN the finger's live position, so the container follows it on THIS frame rather than
    // on the frame the host's motion comes back. The coordinate is the one about to be SENT — for a pan, the engine
    // suppresses its own compensation (the host consumes relative motion), so the two can never disagree.
    if (eagerScroll?.panActive()) {
      eagerScroll.panTo(coord.coordY);
      if (panClaimWithholdsPress(eagerScroll.panMode())) {
        // The scroll action owns this gesture. Sending this hover too would
        // drag the game's own focus across the cards the finger is sweeping over (and, on the mouse path, feed the
        // game's drag state a motion stream for a press it never received).
        return;
      }
    }

    // RAISE HELD CARD onto a card the drag MOVES onto: a drag that started OFF any card (nothing latched at press)
    // cosmetically lifts the hand card its finger crosses into — and then FOLLOWS the finger. A PROBE latch (this
    // block, `heldFromProbe`) keeps RE-CLASSIFYING every active-drag frame: the finger crossing onto a DIFFERENT
    // hand card SWITCHES the lift (old unlifts, new lifts) and moving off every hand card CLEARS it. A press/peek
    // GRAB (the finger went down ON the card, `heldFromProbe === false`) stays STICKY until release — the game's
    // own grab parity. Re-classification only RUNS when a lift could apply (raiseHeldCard on, single-finger drag
    // underway, below/at the un-select band, a pressed pointer present) so the per-frame elementsFromPoint cost
    // stays bounded (the phone-CPU rule) — above the band it neither switches nor clears. The renderer captures
    // dragStartY at the id change (setHeldCard). A probe latch's frozen press-time handCard verdict stays false, so
    // a below-line release of such a drag never right-clicks (change 1).
    if (
      (heldTouchCardId === null || heldFromProbe) &&
      touch.raiseHeldCard?.() !== false &&
      !twoFinger &&
      coord.coordY >= UNSELECT_ZONE_Y &&
      [...touchPointers.values()].some((p) => p.pressed && !p.ignore) &&
      // WS-2: skip the forced hit test for a move too small/too recent to have changed which card is under the
      // finger — the latch simply keeps its current verdict for those frames (see DRAG_REPROBE_DESIGN/MS).
      !dragProbeFresh(x, y)
    ) {
      dragProbe = { clientX: x, clientY: y, at: nowMs() };
      const top = touchTargetsAt(x, y).ids[0];
      const hitCard = top && touch.isCard?.(top) !== false && touch.isHandCard?.(top) !== false ? top : null;
      if (hitCard !== heldTouchCardId) {
        heldTouchCardId = hitCard;
        heldFromProbe = hitCard !== null; // still a probe latch when it points at a card; else cleared
        if (hitCard === null) {
          // The finger left every hand card → drop the probe lift (the id-report below won't fire).
          onHeldCard?.(null, coord.coordX, coord.coordY);
        }
      }
    }

    if (heldTouchCardId !== null) {
      // A touch DRAG is holding a card (heldTouchCardId is set ONLY on the touch press path, cleared on release):
      // report its live game coordinate so the renderer can keep the cosmetic lift positioned. Guarding on the id
      // — not `touchPointers.size > 0` — means a mouse-driven hover flush (even with a stray resting finger on a
      // dual-input device) can never reach this, keeping the mouse path exactly as before. Only a classified DRAG
      // reaches flushHover with a held card (a still peek never schedules a hover), so the mode is always "drag".
      onHeldCard?.(heldTouchCardId, coord.coordX, coord.coordY, "drag");
    }
    send({ kind: "hover", ...coord });
  }

  function scheduleHover(clientX: number, clientY: number): void {
    pending = { x: clientX, y: clientY };
    if (!rafId) {
      rafId = requestAnimationFrame(flushHover);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      onTouchMove(event);
      return;
    }
    // T2 — latch "this gesture is a DRAG" the first time the cursor leaves the tap slop while a button is held.
    // A latch and not an endpoint test, because the gesture the drop-cancel exists for comes BACK to its press
    // point (see mouseDragged).
    if (!mouseDragged && mouseDownClient !== null && movedPastTapSlop(mouseDownClient, event.clientX, event.clientY)) {
      mouseDragged = true;
    }
    scheduleHover(event.clientX, event.clientY);
  }

  // The vertical centroid of the two (non-ignored) fingers, in DESIGN space (lastX/lastY are the live client px of
  // each finger, updated every move). The per-finger client→design conversion is affine, so averaging design Ys
  // equals converting the client centroid — matching the native LastY average.
  function twoFingerCentroidDesignY(): number {
    const rect = stageRect();
    if (rect.height <= 0) return twoFingerPrevCentroidY;
    let sum = 0;
    let n = 0;
    for (const tp of touchPointers.values()) {
      if (tp.ignore) continue;
      sum += ((tp.lastY - rect.top) / rect.height) * MIRROR_DESIGN_HEIGHT;
      n++;
    }
    return n > 0 ? sum / n : twoFingerPrevCentroidY;
  }

  // The same centroid in DESIGN x, for the one question the engine asks of a two-finger gesture: which scrollable is
  // under it. Deliberately the plain stage fraction rather than a resolved point — this needs no anchor-map probe,
  // no near-miss pass and no compensation, and both scrollables in scope span essentially the whole width anyway.
  function twoFingerCentroidDesignX(): number {
    const rect = stageRect();
    if (rect.width <= 0) return 0;
    let sum = 0;
    let n = 0;
    for (const tp of touchPointers.values()) {
      if (tp.ignore) continue;
      sum += ((tp.lastX - rect.left) / rect.width) * designWidth();
      n++;
    }
    return n > 0 ? sum / n : 0;
  }

  function onTouchMove(event: PointerEvent): void {
    const p = touchPointers.get(event.pointerId);
    if (!p || p.ignore) {
      return;
    }
    p.lastX = event.clientX;
    p.lastY = event.clientY;
    // #13: a fired long-press right-click is terminal — later movement is neither a drag nor a hover (the finger is
    // just being lifted off). Keep tracking last for a coordinate-less cancel, but classify nothing. Native twin: OnTouchMove.
    if (p.longPressed) {
      return;
    }
    // Finger MOVEMENT distance in design px (a screen-space delta for the drag threshold) — computed straight from
    // the stage fraction, NOT via designCoord, so it needs no per-node shift inversion (a translation cancels in a
    // delta) and no elementFromPoint probe per drag frame (the phone-CPU lesson).
    const rect = stageRect();
    const moveX = rect.width > 0 ? ((event.clientX - p.startX) / rect.width) * designWidth() : 0;
    const moveY = rect.height > 0 ? ((event.clientY - p.startY) / rect.height) * MIRROR_DESIGN_HEIGHT : 0;
    const dist = Math.hypot(moveX, moveY);
    if (twoFinger) {
      // A real two-finger drag (pinch/scroll) is not a right-click tap — remember it so the lift emits nothing.
      if (dist >= TWO_FINGER_CANCEL_DESIGN) {
        twoFingerMoved = true;
      }
      // Once it's a recognized two-finger drag, turn vertical CENTROID drift into chunky scroll-wheel ticks. Each
      // WHEEL_STEP_DESIGN of unspent delta emits ONE tick (multiple in a frame when a fast drag covers several
      // steps, remainder carried) at the STORED latch centroid. NATURAL touch scroll: fingers UP (centroid Y
      // decreasing ⇒ accum < 0) ⇒ wheel-down; fingers DOWN (accum > 0) ⇒ wheel-up. Native twin: EmitTwoFingerWheel.
      if (twoFingerMoved) {
        const centroidY = twoFingerCentroidDesignY();
        // R11 WS-S §8: over a scrollable the ENGINE owns the gesture — the content follows the fingers 1:1 on this
        // very frame and the semantic action carries its offset. "swallow" is a map with a drawing tool armed:
        // claimed, and deliberately nothing happens.
        if (panClaimWithholdsPress(twoFingerClaim)) {
          eagerScroll?.panTo(centroidY);
          twoFingerPrevCentroidY = centroidY;
          return;
        }
        if (twoFingerClaim === "swallow") {
          twoFingerPrevCentroidY = centroidY;
          return;
        }
        twoFingerAccumY += centroidY - twoFingerPrevCentroidY;
        twoFingerPrevCentroidY = centroidY;
        while (Math.abs(twoFingerAccumY) >= WHEEL_STEP_DESIGN) {
          const up = twoFingerAccumY > 0;
          twoFingerAccumY -= (up ? 1 : -1) * WHEEL_STEP_DESIGN;
          send({ kind: "click", button: up ? "wheel-up" : "wheel-down", ...designCoord(twoFingerX, twoFingerY) });
        }
      }
      return;
    }
    if (!p.moved) {
      if (dist < dragThresholdDesign()) {
        return; // still within tap slop — keep deferring
      }
      // Classify as a drag: fire the deferred press at the START point (a FRESH resolve that freezes the shift),
      // then let moves stream as frozen-shift drag-motion. A peek that starts to move routes through this normal
      // pressed drag path (press fires, lift follows, release plays/drops) — cancel its timer + peek flag first so
      // it can't also fire a peek or take the peek-release branch.
      clearPeekTimer(p);
      p.peeking = false;
      p.moved = true;
      p.pressed = true;
      clearRemovalServiceArm();
      clearConfirm(); // a drag presses in its own right — whatever the button was offering is no longer focused
      const pressCoord = freezeAt(p.startX, p.startY, p.raisedHandTouchClaim);
      p.dragStartDesignY = pressCoord.coordY; // grab-point design-Y for the below-line play-zone cancel (change 1)
      // Only a press-captured HAND card lifts. Using the frozen verdict (not a live re-check) keeps the lift through
      // a mid-drag re-parent out of the hand; a non-hand target reports null (the renderer lifts nothing).
      heldTouchCardId = p.handCard ? (p.ids[0] ?? null) : null;
      heldFromProbe = false; // a press GRAB (finger went down ON the card) — sticky, never re-classified
      onHeldCard?.(heldTouchCardId, pressCoord.coordX, pressCoord.coordY, "drag");
      // R10 WS-E: a one-finger drag that began on NO touch widget, inside a scrollable, is a PAN — the same gesture
      // the game reads as a scroll drag, since nothing above the container consumed the press. `p.ids` is the
      // press-time hit stack, so this costs no extra probe. The engine also self-verifies: a pan whose streamed
      // offset never moves is abandoned (see eagerScroll's pan proof), which covers the widgets this hit stack
      // cannot see (a map POINT is neither a touch target nor a "…Button", so it lands here).
      p.scrollGesture = panClaimWithholdsPress(
        maybeBeginPan({ ids: p.ids, blocked: p.blocked, blockKind: p.blockKind, topStamp: p.topStamp }, pressCoord)
      );
      if (!p.scrollGesture) {
        // C5 FIREWALL: a drag whose press lands in a confirm-eligible widget's true box must not PRESS it — the
        // press+release pair IS a commit, and the slop reclassification (a border tap's finger roll) was the main
        // door mis-taps committed through. The gesture still runs (freeze + hover stream); the RELEASE decides
        // whether it ends as focus+button or a plain hover (see onTouchUp). Vetoed when the finger is ON a plain
        // blocking button (topmost block, nothing stamped above it): that button is painted over the point and the
        // game's own hit test gives it the press.
        if (
          !(p.blocked && p.ids.length === 0) &&
          confirmHitAt(pressCoord.coordX, pressCoord.coordY) !== null
        ) {
          p.confirmPressWithheld = true;
        } else {
          // Field-by-field, not `...pressCoord`: freezeAt also carries the raw `designX` (a LOCAL quantity for the
          // scrollbar gate), and nothing that is not part of the upstream contract may ride a spread onto the wire.
          send({ kind: "click", button: "left", pressed: true, coordX: pressCoord.coordX, coordY: pressCoord.coordY });
        }
      }
    }
    scheduleHover(event.clientX, event.clientY);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      onTouchDown(event);
      return;
    }
    const button = buttonName(event.button);
    if (!button) {
      return;
    }
    // Stop the browser from starting a text selection / native drag on a held pointer.
    event.preventDefault();
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort (e.g. a synthetic event in tests); the gesture still replays.
    }
    heldButton = button;
    heldPointerId = event.pointerId;
    // R11 WS-M: remember where a LEFT press started, so the release can tell a click from a drag (a left-drag on the
    // map is a pan) before routing a map-node tap. Cleared on release/cancel.
    mouseDownClient = button === "left" ? { x: event.clientX, y: event.clientY } : null;
    // A queued hover would land at the pre-press position; drop it so the press is the first event at this point.
    pending = null;
    // Resolve FRESH at the press point and freeze the shift for the held gesture (drag-motion then rides it).
    const pressCoord = freezeAt(event.clientX, event.clientY);
    // T2 — the press-time facts the drop-cancel reads at the release. No DOM probe: see pressedRaisedHandCard.
    mouseDragged = false;
    mouseDragStartDesignY = pressCoord.coordY;
    mouseHandCardPress =
      button === "left" && pressedRaisedHandCard(pressCoord.preRaiseX, pressCoord.preRaiseY);
    // R10 WS-E: a LEFT press over a scrollable with nothing under it is the desktop twin of the touch pan — the map
    // and the card grids both drag-scroll on left-drag. One `elementsFromPoint` per press (never per frame), and
    // only when the engine is wired at all.
    if (eagerScroll && button === "left") {
      // R19 WP5 — THE SCROLLBAR STRIP, offered FIRST and on its own terms. A press on the track is a whole gesture
      // (jump to that fraction), not the start of a drag, and the strip is stamped `data-touch-block`, so the
      // ordinary offer below would refuse it on the §3 rule.
      // §3 tri-state: a press on a BLOCKING widget (a dialog's sort/back button) is not empty space, whatever the
      // id list says — it must never arm a pan. §5: cards do not disqualify a GRID drag, so the whole hit stack
      // goes to the engine rather than a boolean.
      //
      // R21: ONE probe now serves BOTH offers (it used to sit behind the `||`'s short-circuit, so a bar claim paid
      // for none). It has to: the bar claim's own gate is "is the bar what the player is TOUCHING", and only the
      // z-stack can answer that — a card-selection dialog's confirm button is painted over the strip, and every
      // press of it that landed on the strip was being claimed by the bar and thrown away.
      const hits = touchTargetsAt(event.clientX, event.clientY);
      pressWithheld =
        // R20: the RAW widened-design X goes with the resolved point. On a widened stage the resolve is many-to-one,
        // so the game-space AABB alone claimed a band beside the bar that nothing paints — and a "bar" claim
        // withholds the press, so that false claim DELETED the gesture instead of merely misplacing it. The claim now
        // also needs the pointer to be on the strip as painted (eagerScroll.barOwnsPoint's rendered-box gate). No
        // extra DOM probe: `designX` is a by-product of the resolve this press already paid for.
        //
        // NOT deferred: a cursor press on the track is deliberate (a mouse has no contact patch to catch the strip
        // by accident), so it acts at once exactly as it always has. The deferral is the touch path's — see onTouchDown.
        eagerScroll.beginBarPan(pressCoord.coordX, pressCoord.coordY, barFactsFor(hits, pressCoord.designX)) !== null ||
        panClaimWithholdsPress(maybeBeginPan(hits, pressCoord));
    }
    if (pressWithheld) {
      // §5 — THE TOUCH-TAP IDIOM ON THE MOUSE. A grid drag must not send a press: the game would start its own
      // drag-scroll (or press a card) with it. So the press is deferred exactly like a touch tap's, and the
      // RELEASE decides: a sub-threshold release is a full click (choose-a-card dialogs keep working), a real drag
      // sends nothing at all. Deliberately NOT "press now, release later" — there is no such thing as retracting a
      // press the game has already acted on.
      return;
    }
    // Field-by-field for the same reason as the touch path above: freezeAt's `designX` is local, never upstream.
    send({ kind: "click", button, pressed: true, coordX: pressCoord.coordX, coordY: pressCoord.coordY });
  }

  function onTouchDown(event: PointerEvent): void {
    event.preventDefault();
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort (e.g. a synthetic event in tests); the gesture still replays.
    }
    pending = null; // drop any queued hover so a stale pre-touch position isn't sent
    dragProbe = null; // WS-2: the press probes fresh below, and this gesture's first latch probe must too

    // A finger arriving while a drag OR a live peek is already underway (or as a 3rd+ touch) is a stray — never let
    // it produce its own tap/click/right-click. Folding `peeking` in means a second finger during a peek is a stray,
    // never a spurious two-finger right-click.
    const dragActive = [...touchPointers.values()].some((p) => p.moved || p.pressed || p.peeking || p.longPressed);
    const hits = touchTargetsAt(event.clientX, event.clientY);
    const ids = hits.ids;
    const top = ids[0];
    // This is deliberately narrower than the renderer's coordinate probe: `touchStackAt` just proved that this
    // exact top target owns the finger, and only a hand-card target may bridge to a raised-holder claim. Empty
    // space, a card glow (unstamped), and an overlapping neighbour never reach this path.
    const handTouchTarget = top !== undefined && touch.isCard?.(top) !== false && touch.isHandCard?.(top) !== false
      ? top
      : null;
    const raisedHandTouchClaim = handTouchTarget === null
      ? null
      : probes.raisedHandTouchTargetClaim?.(handTouchTarget) ?? null;
    const pointer: TouchPointer = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      ids,
      // §3: whether a data-touch-block widget covered the press point — frozen with `ids` (same probe, same
      // instant), and read at drag classification to decide whether an eager pan may be armed at all.
      blocked: hits.blocked,
      blockKind: hits.blockKind,
      topStamp: hits.topStamp,
      // Capture the HAND-card verdict ONCE, here at press: the top hit is BOTH a card and a hand card. Every card
      // gate for this gesture reads this frozen value, so a grabbed hand card that re-parents out of the hand keeps
      // its card semantics — and the reconcile-time re-classification (computeTouchInfo re-stamping per frame) is
      // moot for the in-flight gesture, since `ids` + `handCard` were both taken at press and never re-read.
      handCard: handTouchTarget !== null,
      // #13: a card that is NOT a hand card (reward / shop card / card-grid card). Web default conventions: isCard
      // absent = card (unwired engine unrestricted), isHandCard absent = hand card — so an UNWIRED engine reports
      // nonHandCard = false (isHandCard === false is what selects it), matching the native default-false NonHandCard.
      nonHandCard: top !== undefined && touch.isCard?.(top) !== false && touch.isHandCard?.(top) === false,
      raisedHandTouchClaim,
      focusedAtDown: false,
      focusedRootIdAtDown: null,
      dragStartDesignY: 0, // set at drag classification (below), from the frozen press coord's Y
      moved: false,
      pressed: false,
      confirmPressWithheld: false,
      scrollGesture: false,
      ignore: dragActive || twoFinger || touchPointers.size >= 2,
      peeking: false,
      longPressed: false,
      peekTimer: null
    };
    touchPointers.set(event.pointerId, pointer);

    // Touch-start counts as a HOVER: on the PRIMARY finger's down edge, immediately update the game's pointer
    // state at the down point — sent DIRECTLY (not through scheduleHover; the down edge must not wait a frame),
    // via the same `send` path flushHover/peek/tap-arm use, resolved FRESH (designCoord, matching every other
    // discrete-edge hover). It fires no matter what the gesture becomes (tap, drag, or peek); everything
    // downstream (peek timer, 8px drag classification, tap-arm, tap-to-unselect, two-finger right-click) is
    // unchanged — the peek/arm are simply no longer the FIRST hover of the gesture. Only the sole, non-ignored
    // finger hovers: a SECONDARY finger (a two-finger latch) or a stray finger never does.
    if (!pointer.ignore && touchPointers.size === 1) {
      const press = designCoordRaw(event.clientX, event.clientY, pointer.raisedHandTouchClaim);
      // PRESS-TIME latch, deliberately before the immediate hover below. A first tap on an unfocused target cannot
      // turn itself into a commit merely because its own down edge focused the game before release.
      pointer.focusedRootIdAtDown = focusedTouchTargetAt(ids, press.coordX, press.coordY);
      pointer.focusedAtDown = pointer.focusedRootIdAtDown !== null;
      touch.noteTouchTarget?.(pointer.focusedRootIdAtDown ?? top ?? null);
      // R19 WP5 — THE SCROLLBAR STRIP, AT THE PRESS. Touch only offers a gesture to the engine at DRAG
      // CLASSIFICATION (8px of travel), which is the wrong moment for a bar: tapping the track is a complete
      // gesture and must move the grid without any travel at all. So the strip — and only the strip, decided by
      // the engine's own geometry, not by anything this layer can see — gets a press-time offer. A claim turns
      // this finger into a scroll gesture outright: no down-edge hover, no peek arm, no press, and the release
      // path's existing `pressed && scrollGesture` branch already knows to emit nothing.
      // R20: with the RAW widened-design X, so a finger BESIDE the strip on a stretched stage cannot take the claim
      // (see eagerScroll.barOwnsPoint) — which on touch is the difference between tapping a card and losing the tap.
      //
      // R21 — AND THE CLAIM IS DEFERRED, unless the finger came down on the THUMB. The track is ~50 design px at the
      // very edge of the frame, which is where a thumb's contact patch lands when it arcs through a swipe: acting on
      // contact turned those swipes into jumps to wherever the finger clipped the bar. Deferred, the gesture decides
      // for itself — a tap commits on release, a swipe hands over to the grid's content (see eagerScroll's
      // handOverBarPan). The HANDLE is not deferred: a finger there is a deliberate grab.
      if (
        eagerScroll?.beginBarPan(press.coordX, press.coordY, {
          ...barFactsFor(hits, press.designX),
          deferred: hits.topStamp !== "thumb"
        }) != null
      ) {
        pointer.scrollGesture = true;
        pointer.pressed = true;
        pointer.moved = true; // every later move streams straight to the engine, past the tap/peek machine
        freezeAt(event.clientX, event.clientY);
        return;
      }
      // Field-by-field (not a spread): `press.designX` is a local resolve by-product, never part of the wire payload.
      send({ kind: "hover", coordX: press.coordX, coordY: press.coordY });
    }

    // Exactly two clean fingers (no drag in progress) → arm a two-finger right-click, fired on lift. No press was
    // ever sent for either finger, so there's nothing to retract.
    if (!dragActive && touchPointers.size === 2) {
      const starts = [...touchPointers.values()].filter((p) => !p.ignore);
      twoFinger = true;
      twoFingerMoved = false;
      twoFingerX = starts.reduce((sum, p) => sum + p.startX, 0) / starts.length;
      twoFingerY = starts.reduce((sum, p) => sum + p.startY, 0) / starts.length;
      // Seed the scroll-wheel accumulator: the latch centroid is the reference for the first vertical delta.
      twoFingerAccumY = 0;
      twoFingerPrevCentroidY = twoFingerCentroidDesignY();
      // §8: offer the whole gesture to the eager engine at the latch centroid, in the SAME design coordinates the
      // loop above measures its drift in (source "gesture" — there is no press to withhold, so no hit stack to
      // consult). A refusal leaves the ordinary stepper in charge.
      twoFingerClaim = maybeBeginPan(
        NO_TOUCH_HITS,
        { coordX: twoFingerCentroidDesignX(), coordY: twoFingerPrevCentroidY },
        "gesture"
      );
    }

    // Long-press "peek": a lone finger held still on a CARD for PEEK_MS focuses + raises it (reusing the drag
    // lift) without a press, so the player can see a card hidden under their finger. Gated by the raiseHeldCard
    // master switch; the renderer-backed isCard predicate keeps it to cards only. NOT armed when the finger lands
    // on the card that's ALREADY focused/armed: re-touching a focused card means "grab it to drag", not "peek it"
    // (it's already enlarged) — and letting a peek fire there makes a short drag stay a peek, whose release sends
    // only an un-focus hover (no `pressed:false`), so a popped-up card never drops. Skipping the peek routes the
    // gesture straight to a normal drag/tap, exactly like an unfocused card.
    if (
      !pointer.ignore &&
      !dragActive &&
      touchPointers.size === 1 &&
      pointer.ids[0] &&
      !pointer.focusedAtDown &&
      // Two legs (the timer callback dispatches which): a HAND card → a PEEK (gated on raiseHeldCard + NOT the
      // already-armed card); a NON-hand card (#13) → a right-click (gated only on the longpressRclick switch,
      // decoupled from raiseHeldCard). Native twin: the GestureMachine OnTouchDown deadline-arm OR-condition.
      ((pointer.handCard && pointer.ids[0] !== armedRootId && touch.raiseHeldCard?.() !== false) ||
        pointer.nonHandCard)
    ) {
      const pointerId = event.pointerId;
      pointer.peekTimer = setTimeout(() => {
        const p = touchPointers.get(pointerId);
        if (!p || p.ignore || p.moved || p.pressed || p.peeking || twoFinger) return;
        const cardId = p.ids[0];
        if (!cardId) return;
        // #13: a NON-hand card long-press is a right-click (reward / shop card / card-grid card — the touch analog of
        // the desktop right-click). TERMINAL: mark longPressed (release emits nothing, later movement isn't a drag, a
        // second finger is a stray), clear any arm/press, right-click FRESH at the start point. Native twin: FirePeekIfDue.
        if (p.nonHandCard) {
          p.longPressed = true;
          p.peekTimer = null;
          armedRootId = null;
          pressedRootId = null;
          clearRemovalServiceArm();
          fullClick("right", p.startX, p.startY);
          return;
        }
        // Peek only a press-captured HAND card (isCard && isHandCard, frozen at press). A still hold never
        // re-parents, so a live re-check would be equivalent — the frozen read keeps native + web identical.
        if (!p.handCard) return;
        p.peeking = true;
        p.peekTimer = null;
        heldTouchCardId = cardId;
        heldFromProbe = false; // a still-hold PEEK grab — sticky, never re-classified
        // A plain hover (NOT freezeAt) — a peek keeps hover semantics; the game enlarges/focuses the card, and
        // onHeldCard raises it above the finger. No freeze means no stale-affine cleanup on release.
        const coord = designCoord(p.startX, p.startY, p.raisedHandTouchClaim);
        onHeldCard?.(cardId, coord.coordX, coord.coordY, "peek");
        send({ kind: "hover", ...coord });
        // R1: the delay itself (below) already picked which leg this timer serves — a hand card's peek always fires
        // at PEEK_MS, a non-hand card's long-press right-click (the branch above) at the longer LONG_PRESS_MS —
        // using the SAME frozen `pointer.nonHandCard` verdict the branch dispatch reads. Native twin: GestureMachine's
        // FirePeekIfDue split (PeekDeadline armed at nowMs + (NonHandCard ? LongPressMs : PeekMs)).
      }, pointer.nonHandCard ? LONG_PRESS_MS : PEEK_MS);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      onTouchUp(event);
      return;
    }
    const button = buttonName(event.button) ?? heldButton;
    releaseCapture();
    if (button && pressWithheld) {
      // §5: no press went out for this gesture, so there is nothing to release. Under the tap slop it was a click
      // after all — send it whole (press+release in one message, the game runs both).
      //
      // R19 WP5 EXCEPT a "bar" gesture, which is the one withheld press that was NOT a deferred click: it already
      // did its whole job at the press (the engine stated the offset the track point names). Sending a click on
      // top would hand the game's own scrollbar a press that jumps it somewhere else again.
      if (
        eagerScroll?.panMode() !== "bar" &&
        mouseDownClient !== null &&
        !movedPastTapSlop(mouseDownClient, event.clientX, event.clientY)
      ) {
        fullClick("left", event.clientX, event.clientY);
      } else {
        feedPanRelease(designCoord(event.clientX, event.clientY).coordY);
      }
    } else if (button) {
      // Release resolves FRESH (exact drop targeting), then the freeze clears.
      const releaseCoord = designCoord(event.clientX, event.clientY);
      feedPanRelease(releaseCoord.coordY);
      send({ kind: "click", button, pressed: false, ...releaseCoord });
      // T2 — a HAND card DRAGGED and dropped at or below its play-zone floor is the game's cancel, and on this
      // pointer the coordinate cannot express it (see readDropCancelClick). Same shape, same gates and same order
      // as the touch leg's: after the left release, a right-click at the drop point de-selects the card. Gated on
      // the PRESS-time hand-card verdict (frozen — the grabbed holder has re-parented out of the hand by now), on
      // the gesture having actually been a drag, and on a wired playZoneThreshold (absent = feature off, so every
      // caller that does not pass one stays byte-identical).
      if (
        button === "left" &&
        mouseDragged &&
        mouseHandCardPress &&
        touch.playZoneThreshold &&
        releaseCoord.coordY >= touch.playZoneThreshold(mouseDragStartDesignY)
      ) {
        send({ kind: "click", button: "right", ...releaseCoord });
      }
    }
    pressWithheld = false;
    // R11 WS-M: a click-like LEFT release (the pointer never travelled far enough to be a map pan) over a map point
    // ALSO sends the travel action. Unlike the touch tap this does NOT replace the press/release pair: the press has
    // already gone out by the time we know the gesture was a click, and swallowing the release would leave a button
    // stuck down in the game. The pair is the same no-op it has always been on a map point, so the action is the
    // only thing that moves the party.
    if (button === "left" && mouseDownClient !== null && !movedPastTapSlop(mouseDownClient, event.clientX, event.clientY)) {
      mapNodeTap?.(event.clientX, event.clientY);
    }
    mouseDownClient = null;
    mouseDragged = false;
    mouseHandCardPress = false;
    heldButton = null;
    heldPointerId = null;
    clearFreeze();
  }

  function onTouchUp(event: PointerEvent): void {
    const p = touchPointers.get(event.pointerId);
    if (!p) {
      return;
    }
    clearPeekTimer(p);
    touchPointers.delete(event.pointerId);
    releasePointer(event.pointerId);
    dragProbe = null; // WS-2: a release resolves fresh — never let a mid-drag verdict outlive the gesture

    if (p.ignore) {
      // Stray finger — produced nothing; just tidy up two-finger bookkeeping when the stage clears.
      if (touchPointers.size === 0) {
        endTwoFingerClaim();
        twoFinger = false;
        twoFingerMoved = false;
      }
      return;
    }

    // #13: a fired long-press right-click already emitted everything it will; the lift is silent (never a click, never
    // an arm). Tidy the two-finger bookkeeping when the stage clears, like the stray-finger branch. Native twin: OnTouchUp.
    if (p.longPressed) {
      if (touchPointers.size === 0) {
        endTwoFingerClaim();
        twoFinger = false;
        twoFingerMoved = false;
      }
      return;
    }

    if (p.pressed && p.scrollGesture) {
      // §5: an eager grid scroll sent no press, so it sends no release (and none of the drop semantics below apply
      // — nothing was ever picked up). The engine's endPan sends the final semantic offset.
      feedPanRelease(designCoord(event.clientX, event.clientY).coordY);
      pressedRootId = null;
      clearFreeze();
      return;
    }

    if (p.pressed) {
      // A drag was underway: release where the finger lifted (FRESH resolve — exact drop), then clear the freeze.
      // A drag plays/drops a card, resolving any prior tap-selection, so drop the unselect latch too.
      const releaseCoord = designCoord(event.clientX, event.clientY);
      feedPanRelease(releaseCoord.coordY);
      heldTouchCardId = null;
      heldFromProbe = false;
      onHeldCard?.(null, releaseCoord.coordX, releaseCoord.coordY);
      pressedRootId = null;
      clearRemovalServiceArm();
      // C5: the firewall withheld this drag's press, so there is nothing to release. The gesture ends as a FOCUS:
      // still on an eligible widget → the button comes up for it (the rolled border tap's happy ending); rolled
      // off → just the hover. Never a click — a roll-off must not press whatever the finger stopped on.
      if (p.confirmPressWithheld) {
        const hit = confirmHitAt(releaseCoord.coordX, releaseCoord.coordY);
        if (hit !== null) {
          armConfirmAt(hit.id, hit.kind, releaseCoord);
        } else {
          send({ kind: "hover", ...releaseCoord });
        }
        clearFreeze();
        return;
      }
      send({ kind: "click", button: "left", pressed: false, ...releaseCoord });
      // A HAND card dragged and DROPPED below its play-zone floor is the game's cancel: after the left release, fire
      // a right-click at the drop point so the card de-selects. Gated on the PRESS-TIME handCard verdict (frozen — a
      // grabbed card re-parents out of the hand mid-drag, so a live re-check would wrongly say false) AND a wired
      // playZoneThreshold (absent = feature off). Arrow/targeting state is irrelevant by design — a below-line
      // release always cancels. A drag that started OFF a card (handCard === false, even if it later latched a lift
      // via flushHover) never right-clicks here.
      if (
        p.handCard &&
        touch.playZoneThreshold &&
        releaseCoord.coordY >= touch.playZoneThreshold(p.dragStartDesignY)
      ) {
        send({ kind: "click", button: "right", ...releaseCoord });
      }
      clearFreeze();
      return;
    }

    if (p.peeking) {
      // A long-press peek is lifting: the card was focused + raised but NEVER pressed. Clear the lift and reset
      // any arm so this can't count as a re-tap commit. Do NOT send a click. Optionally un-focus by hovering
      // straight up off the hand (a card-free point) so the game drops the focus and the card returns to the hand.
      heldTouchCardId = null;
      heldFromProbe = false;
      const coord = designCoord(event.clientX, event.clientY);
      onHeldCard?.(null, coord.coordX, coord.coordY);
      armedRootId = null;
      pressedRootId = null;
      clearRemovalServiceArm();
      clearConfirm();
      if (touch.unfocusOnRelease?.() !== false) {
          // Park at the RESOLVED screen center — nothing at center takes focus during combat, so the cursor parks
          // harmlessly. The stage-center CLIENT point routes through designCoord (the resolver): its fraction 0.5
          // reconstructs the RAW design center (0.5·designWidth, 540) and inverts a WIDENED stage's paint shift (and
          // the fresh resolve seeds the hover memo). Native twin: ResolveFresh(DesignWidth/2, 540).
          const r = stageRect();
          send({ kind: "hover", ...designCoord(r.left + r.width / 2, r.top + r.height / 2) });
      }
      return;
    }

    if (twoFinger) {
      // Wait for BOTH fingers to lift, then emit a single right-click at the gesture centroid (unless it pinched).
      // A two-finger right-click IS a cancel, so it resolves any prior tap-selection — drop the unselect latch.
      if (touchPointers.size === 0) {
        if (!twoFingerMoved) {
          pressedRootId = null;
          clearRemovalServiceArm();
          clearConfirm();
          fullClick("right", twoFingerX, twoFingerY);
        }
        // The gesture is over; the engine sends its final semantic offset and settles.
        endTwoFingerClaim();
        twoFinger = false;
        twoFingerMoved = false;
      }
      return;
    }

    // R11 WS-M: a TAP on a map point travels through the `select-map-node` action instead of a coordinate click
    // (which the game's map input ignores). Checked before anything is resolved/sent, so the routed tap emits no
    // click at all — the down-edge hover already told the game which point is under the finger. Any other tap (and
    // every tap with the feature off / a drawing tool armed) falls through to the unchanged path below.
    if (mapNodeTap?.(event.clientX, event.clientY)) {
      armedRootId = null;
      pressedRootId = null;
      clearRemovalServiceArm();
      clearConfirm();
      return;
    }

    // A single-finger TAP. Resolve the release design coord once (drives the unselect-zone test AND the sent event).
    const release = resolveSent(event.clientX, event.clientY);
    const releaseCoord = { coordX: release.coordX, coordY: release.coordY };

    // #12: is a from-hand card-CHOICE dialog active (read LIVE)? Gated on the choiceTap switch so switch-OFF stays
    // byte-identical (choiceActive false → the unselect gate + single-tap branch below are both inert). Native twin:
    // GestureMachine's `choiceActive`.
    const choiceActive = touch.handChoiceActive?.() === true;

    // Tap-to-unselect: while a pressed card is STILL SELECTED, a tap at/below the resting-hand line is the game's
    // cancel — a right-click at that point to de-select — EVEN IF it lands on a card. Gated on `pressedRootId`
    // (a press happened), NOT on `armedRootId` (a bare focus): the two-step focus-tap and press-tap land ABOVE the
    // line on the popped-up card, so they're unaffected; only a post-press below-line tap cancels. ALSO gated on the
    // pressed card still being a HAND card (`isCard && isHandCard`, read LIVE here): a no-target card plays and a
    // played/discarded card leaves the hand, either of which self-disables the latch so the next below-line tap
    // (another card / the End Turn button) is a normal tap, not a wasted right-click. A selected/targeting card
    // stays in the hand, so the cancel keeps working for it. Clears the pressed + armed state on fire. #12 SUPPRESSES
    // it while a hand-choice dialog is active (a choose-2 dialog's second below-line selection must not be eaten).
    if (
      pressedRootId !== null &&
      touch.isCard?.(pressedRootId) !== false &&
      touch.isHandCard?.(pressedRootId) !== false &&
      !choiceActive &&
      releaseCoord.coordY >= UNSELECT_ZONE_Y
    ) {
      pressedRootId = null;
      armedRootId = null;
      clearRemovalServiceArm();
      clearConfirm();
      fullClick("right", event.clientX, event.clientY);
      return;
    }

    const top = p.ids[0];
    const canClaimChoice = !(p.blocked && p.ids.length === 0);
    // The removal coin is the one focus-first target whose delayed re-tap opens the picker. This question is
    // independent of Confirm tap and its sprites: a focus-only installation still needs the stable game-space
    // service identity, and the DOM/canvas touch stack may be temporarily covered by the focused visual.
    const removalHit = canClaimChoice ? removalServiceHitAt(releaseCoord.coordX, releaseCoord.coordY) : null;
    const staleRemovalArm = removalServiceArm;
    if (staleRemovalArm !== null && removalHit?.id !== staleRemovalArm.id) {
      clearRemovalServiceArm();
      if (armedRootId === staleRemovalArm.id) armedRootId = null;
      if (confirmTapState.targetId === staleRemovalArm.id) clearConfirm();
      // A service that has been spent can retain its old visual stack for a drain. It is no longer an activation
      // target, so consume this stale-coin tap as a harmless hover rather than letting generic arm state click it.
      if (removalHit === null && top === staleRemovalArm.id) {
        pressedRootId = null;
        send({ kind: "hover", ...releaseCoord });
        return;
      }
    }
    if (removalHit !== null && touch.tapToFocus?.() === true) {
      if (removalServiceArm?.id === removalHit.id) {
        if (nowMs() - removalServiceArm.armedAtMs < TAP_ARM_DEBOUNCE_MS) {
          return;
        }
        // The classifier's id, not the current top touch stamp, proves this is the same still-active coin.
        clearRemovalServiceArm();
        armedRootId = removalHit.id;
        pressedRootId = removalHit.id;
        clearConfirm();
        touchLeftClick(releaseCoord, true);
        return;
      }
      removalServiceArm = { id: removalHit.id, armedAtMs: nowMs() };
      pressedRootId = null;
      // Keep the normal confirm UI when it is available, but do not make its liveness own this separate arm.
      const confirmRemoval = confirmHitAt(releaseCoord.coordX, releaseCoord.coordY);
      if (confirmRemoval?.id === removalHit.id) {
        armConfirmAt(removalHit.id, confirmRemoval.kind, releaseCoord);
      } else {
        armedRootId = null;
        clearConfirm();
        send({ kind: "hover", ...releaseCoord });
      }
      return;
    }
    // The focus setting changed, or this is no longer the armed coin. Generic tap semantics own the rest of this
    // gesture, so no removal-specific arm may leak into it.
    clearRemovalServiceArm();

    // CONFIRM TAP (C2) — the COORDINATE decides, deliberately AHEAD of every click branch below (the `!top`
    // immediate click included — an unstamped pixel inside a widget's real box used to click straight through).
    // On a point inside a confirm-eligible widget's TRUE game box, a tap NEVER clicks: it focuses (or, on a
    // re-tap, just moves the cursor to where the finger landed) and puts the client-side confirm button up; that
    // button is the only thing that commits. The DOM stack no longer classifies this — its stamps measure
    // rendered descendant unions (a rest-site option's Label hangs a full widget-height below the button), so it
    // both missed real box pixels and claimed pixels the game never focuses (the phantom button). One veto: the
    // finger ON a plain blocking button (topmost block, nothing stamped above it) — Skip / End Turn / Proceed are
    // painted over the point, and the game's own hit test gives them the press.
    const confirmHit = canClaimChoice ? confirmHitAt(releaseCoord.coordX, releaseCoord.coordY) : null;
    if (confirmHit !== null) {
      armConfirmAt(confirmHit.id, confirmHit.kind, releaseCoord);
      return;
    }
    // `p.ids[0]` is the TOPMOST hover-first widget under the finger (the one the game would target). Note the
    // z-stack is NOT filtered by CSS: `.mirror-node` is `pointer-events: auto` and nothing maps Godot's
    // MouseFilter onto pointer-events. Attribution honesty comes from the renderer REFUSING to stamp a
    // `data-touch-id` on things that must not own a tap (decorative overlays, echo containers) — see
    // mirrorRenderer.isDecorativeOverlay — so an unstamped element simply contributes no id here.
    if (!top) {
      // Nothing hover-first here (empty space / a data-touch-block button) → immediate click, disarm + de-press. The
      // END-TURN button is a *Button leaf → data-touch-block → no touch-id, so a tap on it ALWAYS lands here; that's
      // why the change-2 un-hover hooks this branch (after the click on tap end, never during the hold). Sent PLAIN
      // (not through the firewall) at the already-resolved release coordinate: in the un-blocked case the
      // classification above proved the point outside every eligible box, and in the blocked case the veto is the
      // point — the button painted over the pixel gets the press even where an eligible box lies underneath.
      armedRootId = null;
      pressedRootId = null;
      clearConfirm();
      // …UNLESS the ANCHOR DOOR claimed this pixel for a hand card (see anchorTapFocus). Then "nothing hover-first
      // is here" is false — the client itself just decided the pixel belongs to a card and moved the coordinate to
      // that card's centre — and clicking through would commit a card the player only touched the edge of. Focus it
      // instead; the follow-up tap lands on the card's own stamped art and takes the ordinary two-step. Two vetoes,
      // both the confirm branch's: the finger on a plain BLOCKING button (End Turn / Skip / Proceed is painted over
      // the point and the game's own hit test gives it the press), and `tapToFocus` off (that setting asks for
      // immediate commits everywhere).
      send({ kind: "click", button: "left", ...releaseCoord });
      maybeUnhoverEndTurn(releaseCoord.coordX, releaseCoord.coordY);
      return;
    }
    if (p.focusedAtDown) {
      // The target was already ready when the finger landed: activate on this release. This bypasses both the
      // arm-only tap and its 200ms debounce, while the confirm firewall above retains first refusal.
      armedRootId = p.focusedRootIdAtDown;
      pressedRootId = p.focusedRootIdAtDown;
      clearConfirm();
      touchLeftClick(releaseCoord);
      return;
    }
    if (touch.tapToFocus?.() === false) {
      // Two-step tap disabled: a single tap on a hover-first widget presses immediately (no arm step). Record the
      // press so a following below-line tap can unselect it.
      armedRootId = null;
      pressedRootId = top;
      clearConfirm();
      touchLeftClick(releaseCoord);
      return;
    }
    // #12: in a from-hand card-CHOICE dialog, a HAND card selects with a SINGLE tap — no arm-first double tap. Only a
    // HAND card (the frozen press verdict); reward/deck/grid cards keep arm-first (#9/#10) even in a dialog. Clears any
    // arm/press so no unselect latch lingers. Native twin: GestureMachine's choiceActive single-tap branch.
    if (choiceActive && p.handCard) {
      armedRootId = null;
      pressedRootId = null;
      clearConfirm();
      touchLeftClick(releaseCoord);
      return;
    }
    if (top === armedRootId) {
      // R16: a re-tap of the armed widget within TAP_ARM_DEBOUNCE_MS of the ARM is an accidental double-tap (finger
      // bounce) — swallow it: no click, stay armed (armedAtMs is NOT reset, so it keeps measuring from the
      // ORIGINAL arm, not this swallowed tap). Native twin: GestureMachine's commit-branch debounce check.
      if (nowMs() - armedAtMs < TAP_ARM_DEBOUNCE_MS) {
        return;
      }
      // Re-tap of the armed widget → commit (a press). KEEP it armed (don't clear) so a once-hovered widget always
      // clicks on every subsequent tap — tapping away (empty space / a block button) is what disarms it.
      pressedRootId = top;
      clearConfirm();
      touchLeftClick(releaseCoord);
    } else {
      // A different widget on top → arm it (first tap, or switching to another card/option). A fresh focus clears
      // any prior press (that selection context is gone).
      armedRootId = top;
      armedAtMs = nowMs();
      pressedRootId = null;
      clearConfirm(); // focus moved to a widget the button does not belong to
      send({ kind: "hover", ...releaseCoord });
    }
  }

  // Pointer capture lost / cancelled (e.g. the OS stole it): synthesize a release so the held button doesn't
  // stay down in the game.
  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerType === "touch") {
      onTouchCancel(event);
      return;
    }
    // A cancelled gesture is never a tap — drop the press point so the next release can't route a map-node tap
    // against a stale one. (Done before the early-out: a cancel with no held button still ends the gesture.)
    // T2's latches go with it: a stolen capture is not a player's deliberate drop, so no drop-cancel is fired here
    // (the touch leg's onTouchCancel does not fire its right-click either) and nothing may survive into the next
    // gesture.
    mouseDownClient = null;
    mouseDragged = false;
    mouseHandCardPress = false;
    if (!heldButton) {
      return;
    }
    const button = heldButton;
    releaseCapture();
    if (pressWithheld) {
      // §5: nothing was pressed, so nothing is retracted — a cancelled grid scroll is simply over.
      pressWithheld = false;
      heldButton = null;
      heldPointerId = null;
      clearFreeze();
      return;
    }
    // The position is stale (capture was stolen), so use the FROZEN shift rather than a fresh probe, then clear.
    send({ kind: "click", button, pressed: false, ...frozenCoord(event.clientX, event.clientY) });
    heldButton = null;
    heldPointerId = null;
    clearFreeze();
  }

  function onTouchCancel(event: PointerEvent): void {
    const p = touchPointers.get(event.pointerId);
    if (!p) {
      return;
    }
    clearRemovalServiceArm();
    clearConfirm();
    clearPeekTimer(p);
    touchPointers.delete(event.pointerId);
    releasePointer(event.pointerId);
    dragProbe = null; // WS-2: same endpoint rule as onTouchUp
    // Only a drag has a press to retract; a deferred tap / two-finger gesture sent nothing, so emit nothing. The
    // position is stale (capture cancelled), so retract with the FROZEN shift, then clear the freeze.
    if (p.pressed && p.scrollGesture) {
      clearFreeze(); // §5: nothing was pressed, so nothing is retracted
    } else if (p.pressed) {
      const releaseCoord = frozenCoord(event.clientX, event.clientY);
      heldTouchCardId = null;
      heldFromProbe = false;
      onHeldCard?.(null, releaseCoord.coordX, releaseCoord.coordY);
      // C5: a firewall-withheld press sent no `pressed:true`, so a cancel has nothing to retract either.
      if (!p.confirmPressWithheld) {
        send({ kind: "click", button: "left", pressed: false, ...releaseCoord });
      }
      clearFreeze();
    } else if (p.peeking) {
      // A peek was live but cancelled (OS stole capture): just clear the lift, no press, no un-focus hover.
      heldTouchCardId = null;
      heldFromProbe = false;
      const coord = frozenCoord(event.clientX, event.clientY);
      onHeldCard?.(null, coord.coordX, coord.coordY);
    }
    if (touchPointers.size === 0) {
      endTwoFingerClaim();
      twoFinger = false;
      twoFingerMoved = false;
    }
  }

  // §8: release a claimed two-finger gesture (its lift, a stray-finger teardown, a cancel). Idempotent.
  function endTwoFingerClaim(): void {
    if (twoFingerClaim !== null) {
      eagerScroll?.endPan();
      twoFingerClaim = null;
    }
  }

  // Mouse wheel → a Godot wheel button tick (full press+release, no held mask). One tick per event; large/precise
  // deltas (trackpads) still map to a single tick per event so a flick doesn't flood the socket.
  //
  // R10 WS-E: over a scrollable (the map, a card grid) the EAGER engine takes the tick instead — it moves the
  // container locally on this very frame and owns the (coalesced, `count`-carrying) upstream send. It refuses
  // anywhere else, where the ordinary single-tick input below remains the only wheel path.
  function onWheel(event: WheelEvent): void {
    if (event.deltaY === 0) {
      return;
    }
    event.preventDefault();
    // R21: the RAW widened-design X rides along (a free by-product of the same resolve — see designCoordRaw) so the
    // engine judges "is this on the scrollbar" by where the strip is PAINTED, the same rule a press gets.
    const { coordX, coordY, designX } = designCoordRaw(event.clientX, event.clientY);
    const coord = { coordX, coordY };
    if (eagerScroll) {
      const gamePx = wheelEventToGamePx(event, designPerClientPx());
      if (eagerScroll.wheel(coord.coordX, coord.coordY, gamePx, coord, designX)) {
        return;
      }
    }
    const button = event.deltaY < 0 ? "wheel-up" : "wheel-down";
    send({ kind: "click", button, ...coord });
  }

  // Design px per CSS px on the current stage — the trackpad's 1:1 conversion (see wheelEventToGamePx). Derived from
  // the CACHED stage rect, so it costs no layout; falls back to 1 on a degenerate rect.
  function designPerClientPx(): number {
    const rect = stageRect();
    return rect.height > 0 ? MIRROR_DESIGN_HEIGHT / rect.height : 1;
  }

  function releaseCapture(): void {
    if (heldPointerId !== null) {
      try {
        stage.releasePointerCapture(heldPointerId);
      } catch {
        // Already released / never captured — ignore.
      }
    }
  }

  function onContextMenu(event: MouseEvent): void {
    // Suppress the browser menu; the right-click itself rides the pointerdown/up (button 2) path.
    event.preventDefault();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat || isEditable(document.activeElement)) {
      return;
    }
    const modifiers = [
      event.ctrlKey ? "ctrl" : "",
      event.shiftKey ? "shift" : "",
      event.altKey ? "alt" : "",
      event.metaKey ? "meta" : ""
    ]
      .filter(Boolean)
      .join(",");
    send({ kind: "key", key: event.code, modifiers: modifiers || undefined });
    if (!event.ctrlKey && !event.metaKey && SCROLL_KEYS.has(event.code)) {
      event.preventDefault();
    }
  }

  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerCancel);
  stage.addEventListener("contextmenu", onContextMenu);
  // passive:false so preventDefault stops the page from scrolling/zooming — we forward the tick to the game.
  stage.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  // The cached stage rect goes stale on resize/scroll/zoom (the letterbox refits, the page pans) — drop it so
  // the next hover re-measures once. Passive + capture so it never blocks scrolling and catches nested scrolls.
  window.addEventListener("resize", invalidateRect);
  window.addEventListener("scroll", invalidateRect, { capture: true, passive: true });

  return {
    // WS-F: the exported stage-geometry seam (see InputCapture.invalidateStageRect). Identical to the resize/scroll
    // listener's own invalidation — the rect, the hover memo and the drag memo are all measured against that rect.
    invalidateStageRect: invalidateRect,
    focusTarget(id: string, gameX: number, gameY: number, markReady = true): void {
      programmaticFocusedRootId = markReady ? id : null;
      send({ kind: "hover", coordX: gameX, coordY: gameY });
    },
    clearProgrammaticFocus(): void {
      programmaticFocusedRootId = null;
    },
    dispose(): void {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      for (const p of touchPointers.values()) {
        if (p.peekTimer !== null) {
          clearTimeout(p.peekTimer);
          p.peekTimer = null;
        }
      }
      releaseCapture();
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerCancel);
      stage.removeEventListener("contextmenu", onContextMenu);
      stage.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", invalidateRect);
      window.removeEventListener("scroll", invalidateRect, { capture: true } as EventListenerOptions);
      // CONFIRM TAP: a torn-down capture must not stay reachable through the shared module, and a button left up
      // by the teardown would have nothing to commit through. The hidden hook goes AFTER the final clearConfirm so
      // that clear still runs its own teardown through it.
      releaseConfirmCommit();
      clearConfirm();
      releaseConfirmHidden();
    }
  };
}
