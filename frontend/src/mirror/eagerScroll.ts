// EAGER CLIENT-SIDE SCROLLING.
//
// THE PROBLEM. Scrolling is the one gesture in the mirror where the round trip is unmissable. A wheel notch is
// injected on the host, the host eases the container toward its new target over several frames, the producer
// captures the moved subtree, and only then does the browser paint it — so on a phone over Wi-Fi the map lags by
// 200-500ms and a flick reads as a stutter. Nothing else the mirror does is a *continuous* gesture whose result the
// player is staring straight at.
//
// THE FIX. Move the content LOCALLY, immediately, and let the host catch up. This is the held-card-lift idiom
// (mirrorRenderer.applyHeldLift) applied to a scroll container: a cosmetic CSS `translate` composed on top of the
// node's baked `matrix()`, never sent to the game, compare-before-write, re-asserted every frame so a re-created
// element gets it back. Both scrollables in scope move exactly ONE node:
//   * the MAP — the `TheMap` Control under the map screen. Its streamed offset eases toward wherever the drag has
//     asked for, and every path/point/quill-stroke is a DOM DESCENDANT of it, so one translate carries the whole
//     annotated map (this is the same nesting WS-D's pinned stroke locals rely on);
//   * a CARD GRID — the `ScrollContainer` Control under `card_grid.tscn`: deck / draw / discard / exhaust views.
//     Same easing, plus row RECYCLING (rows outside the window are not streamed at all), which is why the eager
//     window is CLAMPED to materialized rows — see `clampEager`.
//
// THE BLEND IS CONTINUOUS, NOT A SNAP. Per animation frame the element carries `eagerY − renderedY` — the gap
// between where the player should be looking and what the renderer has actually PAINTED (see `renderedY`; against
// the freshest node data instead, the map dips for a frame every time a delta lands). While the host catches up that
// gap shrinks on its own, so the content never jumps: the local motion happens at once and the authoritative
// geometry slides in underneath it. When the two agree (within EPS) the translate is cleared and the scrollable is
// IDLE again — byte-identical DOM to a session that never eager-scrolled.
//
// WHAT IS SENT UPSTREAM IS UNCHANGED IN KIND — UNLESS THE HOST OFFERS AN ABSOLUTE CHANNEL. Without one, a wheel
// notch is still a wheel notch and a pan is still a press + a motion stream; the only wire addition is the optional
// `count` on a wheel click (see mirrorClient.MirrorInputMessage), folding one frame's notches into ONE message
// because the host injects exactly one queued input per game-thread turn.
//
// R19 WP5 — SCROLL AUTHORITY. Replaying RELATIVE input can never land the game where the player let go, and every
// one of the four defects this round fixed is that same fact wearing a different hat:
//   * wheel travel is QUANTISED at WHEEL_NOTCH_PX, so the sub-notch remainder of a flick is unexpressible;
//   * the client's grid limit (`viewH − contentH`) is a reconstruction of the game's formula, not the formula;
//   * the client's clamp is hard where the game's is ELASTIC, so the two disagree at both ends of the window;
//   * a map pan in stretched dead space sends a press that lands on no painter, so the game performs no drag at
//     all and the client's own pan proof eventually disowns the gesture and glides the map back.
// The current session contract supports `set-scroll-offset`, so the client stops ASKING for travel and starts
// STATING a position: it leads locally exactly as before, and the offset
// it is leading AT goes upstream as an absolute action, coalesced to a bounded rate. The game clamps to its own
// limits and answers with the clamped value, which is the one fact the client cannot derive for itself.
//
// THE DISCRIMINATION, which is the whole point. The player's rule is "the GAME goes where I left the client",
// with one exception: "unless something else moved the game, in which case the client follows". The settle can
// tell those apart because the absolute channel gives it two independent statements about the surface — `authoredY`
// (what we told the game) and `ackedY` (what the game said it clamped that to) — alongside the PAINTED position it
// has always had. See the settling block in `runFrame` for the order they are consulted in.
//
// Self-contained per the mirror decoupling rule: `@/mirror/*` only.

import type { MirrorInputMessage, MirrorScrollAck } from "@/mirror/mirrorClient";

// ---------------------------------------------------------------------------------------------------------------
// Contract with the renderer
// ---------------------------------------------------------------------------------------------------------------

export interface EagerScrollBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// The scrollbar thumb of a card grid (`scrollbar.tscn` → `Handle`), when one is visible. The thumb is positioned by
// the game from the bar's `Value`, itself derived from the scroll offset — but this module never assumes either
// formula: it INFERS the (offset → thumb Y) line from two observed rest pairs (see `noteBarSample`).
export interface EagerScrollBarTarget {
  id: string;
  // Backend-local attachment; the renderer owns the write by id through EagerScrollDeps.applyLocalOffset.
  el?: HTMLElement | null;
  // The thumb's streamed local Y (design px) — the value the inference is sampled against.
  handleY: number;
}

// One scrollable, as the renderer sees it THIS instant. Structure (which nodes, which elements, which viewport) is
// epoch-cached inside the renderer; the per-frame VALUES (`streamedY`, `band`, `pinned`, the bar's `handleY`) are
// read live, because they change on every frame of a host-side scroll.
export interface EagerScrollTarget {
  id: string;
  kind: "map" | "grid";
  // Backend-local attachment. The engine addresses offsets through the renderer seam by id.
  el?: HTMLElement | null;
  // The scroll container's streamed LOCAL Y. This is the quantity the game itself scrolls, and it is what the
  // upstream COMPENSATION is measured against: it is the best available answer to "where does the game have this
  // content right now".
  streamedY: number;
  // The Y the element is currently PAINTED at — the translation the walk baked into this node's own transform (the
  // renderer reads it from its style cache; see mirrorRenderer.baseTranslateY).
  //
  // These two are NOT the same for a frame or two, and the difference is visible. Node data is applied the moment a
  // delta arrives (mirrorClient, off the socket), while the matrix is only written by the renderer's own reconcile
  // frame. Composing the cosmetic translate against `streamedY` therefore shrank it against a matrix that had not
  // moved yet, and the map DIPPED most of the way back for a frame before recovering — measured live at 233 client
  // px. The blend is against what is PAINTED, so the composed position is exactly the eager one on every frame.
  renderedY: number;
  // The GAME-space box the container scrolls inside (the map screen / the card grid's own rect). A pointer is
  // claimed by a scrollable only inside this box; it is NOT scrolled by the eager offset (the frame stays put).
  viewport: EagerScrollBox;
  // The visible SCROLLBAR's own box, when the grid is showing one (null otherwise). Carved OUT of the RELATIVE
  // claim surface: the bar is the game's own ABSOLUTE channel (a press jumps the grid's scroll target straight to
  // a fraction of its bottom limit and then drags it), which a relative eager gesture can only fight. Round 2
  // claimed the whole dialog box, so pressing the bar armed a phantom pan that ran the content one way while the
  // host's jump-to-fraction ran it the other, and the 800ms deadline ended it with a snap-back.
  //
  // R19 WP5: under scroll authority the client has an absolute channel of its OWN, so the strip stops being
  // no-man's-land and becomes a claim of its own kind — see `beginBarPan` / PanClaim "bar". It is still carved out
  // of the wheel/compensation surface (`targetAt`), because those two remain relative.
  //
  // R21: the box alone no longer decides. It says where the bar COULD be; `barOwnsPoint` decides whether it does —
  // the strip has to be what is painted there (`scrollbarRenderedBox`) and nothing may be painted on top of it
  // (BarPointFacts.occluded). Everywhere else inside the frame is CONTENT, including the pixels of this box the bar
  // turns out not to own, which is what stops a refused claim from falling through to the game's own scrollbar.
  scrollbarBox: EagerScrollBox | null;
  // R20 — the SAME strip in WIDENED-DESIGN (on-stage) space: `scrollbarBox` shifted right by the bar node's own
  // `spreadDx` (Y is never spread). Null exactly when `scrollbarBox` is. This is what `beginBarPan` tests the RAW
  // pointer against, and it exists because a game-space AABB is not a valid hit test on a widened stage: the resolve
  // maps a whole band of raw positions into one game rect, and WHICH band depends on the painter that anchored it.
  // The bar hugs the right edge of an anchored frame, so it carries the LARGEST shift on screen — leaving the error
  // one-sided (a phantom claim strictly to the bar's LEFT) and, because a "bar" claim withholds the press, deleting
  // the gesture the player actually made. Identical to `scrollbarBox` on 16:9 (dx === 0), which is what makes the
  // gate provably inert there. Same shape as the view-scale stamp's `renderedBox` (see viewScaleInverse).
  scrollbarRenderedBox: EagerScrollBox | null;
  // Where a wheel tick for this scrollable is INJECTED (game px), when the geometry offers a point that scrolls it
  // and hovers nothing — for a card grid, the middle of the left gutter between the grid's own frame and its
  // content (the grid takes wheel input across its whole frame, so a gutter point still scrolls). Null ⇒ send at the
  // pointer's own place, which is what the map does: it is one full-screen Control with nothing to aim past.
  //
  // Why (R11 WS-S §3): over a CARD the injected tick lands on a child that may consume or re-route it, and the
  // resolved coordinate has to be un-compensated first (the tick must go where the cursor PHYSICALLY is, not where
  // the eager content has moved to) — two uncertainties, both of which vanish when the tick is aimed at a fixed
  // point that belongs to nobody.
  wheelSafe: { x: number; y: number } | null;
  // Inclusive clamp on the eager offset, in the same units as `streamedY`.
  limitLo: number;
  limitHi: number;
  // VIRTUALIZATION GUARD (grids). The materialized content band in container-LOCAL Y — the extent actually covered
  // by the card-holder rows the wire has sent. Eager scrolling past it would reveal blank space the host has not
  // recycled a row into yet. Null = no restriction (the map's content is fully streamed).
  band: { lo: number; hi: number } | null;
  // A transform tween owns this container this frame ⇒ HARD RESET (the tween's endpoint is the truth, and a
  // composed cosmetic translate would fight it).
  pinned: boolean;
  // This scrollable must not scroll AT ALL right now (§7: the map while a drawing tool is armed). Distinct from
  // "not claimed": a wheel here is claimed and SWALLOWED rather than passed to the ordinary relative input path,
  // because the product
  // decision is that the mirror never scrolls the map out from under a quill stroke — while a PRESS still passes
  // through untouched, since that gesture is the player drawing.
  suppressed: boolean;
  bar: EagerScrollBarTarget | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------------------------

// The design px the game travels per wheel tick THE MIRROR SENDS. The eager offset must move by exactly this much
// per sent tick or eager and streamed could never agree — and there is a trap in it, found by live QA (the map
// first shipped moving half as far as the host, which produced a visible mid-settle jump): one tick on this wire is
// a FULL CLICK, because spirectl's `ExecuteMouseClick` injects press AND release, and the game counts BOTH edges.
// So one message is worth two notches of travel, not one. This has always been the mirror's effective wheel step
// (it is what a pre-feature single tick did too); eager scrolling is simply the first thing that had to know the
// number. Measured live at 1280x720 against a real host: `count:5` moved the map 400 design px.
export const WHEEL_NOTCH_PX = 80;
// The eager and streamed offsets are "the same" within this many design px — half a hair at any stage scale, and
// comfortably above the float noise of the host's own ease-then-snap, whose own snap threshold is well under 1px.
export const SETTLE_EPS_PX = 2;
// A settling scrollable whose streamed offset has not reached it within this long gives up and HARD-SNAPS to the
// streamed truth. This is the backstop for "the tick never arrived at all" (a dropped message, a screen change, a
// host that refused to scroll): the player must never be left looking at a position the game does not agree with.
export const SETTLE_DEADLINE_MS = 800;
// …but the ordinary end of a settle is quieter: once the streamed offset STOPS MOVING for this long with a residual
// still outstanding (the host clamped at its own limit, or the sent ticks quantized away a trackpad remainder), the
// eager offset GLIDES the rest of the way instead of snapping.
//
// R11 WS-S: the stall window alone is NOT a statement about the host — for the first round trip after a gesture the
// paint is ALWAYS still, because the answer is in flight. Round 2 armed the glide off that stillness and threw the
// whole eager offset away ~330ms into a 250ms-RTT gesture, then the delta landed and the map jumped forward again:
// the "shakes a lot after each scroll" the player reported, measured by scripts/probe-eager-scroll.mjs as a 265px
// composed-Y excursion. The window is therefore only consulted once the paint has ALREADY moved during this settle
// (see ScrollEntry.stallGlideArmed) — i.e. the host demonstrably answered and has now stopped short, which is
// the only situation a glide is the right answer to. "The answer never came at all" belongs to the deadline.
export const SETTLE_STALL_MS = 120;
// The glide's duration. Short enough to feel like a settle, long enough not to read as a jump.
export const SETTLE_GLIDE_MS = 120;
// No wheel/pan input for this long ⇒ ACTIVE becomes SETTLING. One frame would be too twitchy (wheel events arrive in
// bursts with gaps); a couple of frames is enough to tell "the gesture paused" from "the gesture ended".
export const ACTIVE_HOLD_MS = 90;

// PAN PROOF. A pan is armed on the client's own reading of "nothing under the finger consumed this press", and that
// reading is not complete: the touch-target stamps cover cards and `…Button` types, but a map POINT
// (`NNormalMapPoint`) is neither, so a drag begun on one would arm a pan the game will never perform (the point
// consumes the press first). Rather than encode an ever-growing table of what consumes a
// press, the pan VERIFIES itself: once it has moved the content this far with the streamed offset still frozen for
// this long, the claim was wrong — the pan is abandoned and the settle glides the content back. The window is
// generous on purpose (a real pan on a slow link waits a full round trip for its first streamed motion).
export const PAN_PROOF_MS = 400;
export const PAN_PROOF_PX = 12;

// How far the finger/cursor must travel before a claimed pan becomes a LIVE one (design px — about the width of a
// hairline, well under the input layer's own 8px drag threshold, so it never delays a real drag).
//
// R11 WS-S §6. A press used to activate the entry immediately, which pinned the container to the press-time paint:
// hold the button down on the map and the host's own motion (an act-change slide, someone else's pan, a settling
// flick) stopped dead on screen and then jumped when the finger lifted. A press is not a scroll — until something
// MOVES there is nothing eager to show, and the stream should simply keep painting.
export const PAN_ACTIVATE_PX = 2;

// R21 — HOW FAR A DEFERRED TRACK GESTURE MAY TRAVEL BEFORE IT STOPS BEING A TAP (design px). Deliberately the same
// number as the input layer's own DRAG_THRESHOLD_DESIGN: "did the pointer travel or not" is one question and the two
// layers must not answer it differently for the same gesture.
//
// Why a finger's press on the TRACK cannot act at once (the reported defect). The strip is ~50 design px wide at the
// right edge of the frame — about a quarter of a thumb. Scrolling a grid by swiping is a thumb PIVOT, so its contact
// patch arcs into that edge constantly, and a claim that jumps on contact turns every such swipe into a jump to
// wherever the finger happened to touch the bar. Deferring costs the deliberate gestures nothing: a track TAP is
// committed on release (the touch layer defers every tap's press anyway, so there is no added latency), and a THUMB
// grab is not deferred at all — the handle is a target a player hits on purpose.
export const BAR_TAP_SLOP_PX = 8;

// R19 WP5 — ABSOLUTE-SEND COALESCING. A leading gesture would otherwise author one action per input event (a 120Hz
// trackpad stream, a per-frame drag), and every one of those is a queued hop onto the host's game thread. These two
// gates keep the stream bounded without making it laggy: at most one send per SCROLL_SEND_MIN_MS, and only once the
// offset has moved at least SCROLL_SEND_MIN_PX since the last one. The gesture's LAST position is always sent
// regardless of both gates (see flushScroll's `final`) — that is the send that decides where the game ends up, so
// it is the one send that may never be throttled away.
export const SCROLL_SEND_MIN_MS = 33;
export const SCROLL_SEND_MIN_PX = 2;

// The map screen's own scroll limits, measured off the wire: the map container's offset is always elastically
// pulled back inside [-600, 1800]. Clamping the EAGER offset to the same window is what stops a flick from showing
// a screenful of nothing above the first floor.
export const MAP_LIMIT_LO = -600;
export const MAP_LIMIT_HI = 1800;

// ---------------------------------------------------------------------------------------------------------------
// Wheel-delta normalisation (pure — the coalescer's math)
// ---------------------------------------------------------------------------------------------------------------

// A `wheel` event reduced to GAME px of requested scroll, POSITIVE = scroll down (content moves up ⇒ the container
// offset DECREASES). Two regimes, because the browser hands us two very different things through one event:
//   * a real mouse WHEEL is a NOTCH — a discrete unit the game already has a number for (40 px). Chrome reports it
//     in pixel mode as a whole multiple of 100 (120 on some platforms), Firefox in LINE mode as 3 lines per notch;
//   * a TRACKPAD is a continuous pixel stream, and the only thing that feels right there is 1:1 — the content
//     travels exactly as far as the fingers did. `designPerClientPx` converts the event's CSS px into design px,
//     so the 1:1 holds on a letterboxed/scaled stage too.
// The notch heuristic is deliberately conservative: only a suspiciously round, large pixel delta is treated as a
// notch, so a trackpad flick that happens to report 100.0 once is the worst case (one notch instead of 100 px, a
// difference of 60 px) and never the other way round.
export function wheelEventToGamePx(
  event: { deltaY: number; deltaMode?: number },
  designPerClientPx: number
): number {
  const deltaY = event.deltaY;
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return 0;
  }
  const mode = event.deltaMode ?? 0;
  if (mode === 1) {
    // LINE mode (Firefox): the platform convention is 3 lines per notch.
    return (deltaY / 3) * WHEEL_NOTCH_PX;
  }
  if (mode === 2) {
    // PAGE mode: rare; a page is worth roughly a screen, which is ~3 notches of travel here.
    return deltaY * WHEEL_NOTCH_PX * 3;
  }
  const q = Math.abs(deltaY);
  if (q >= 100 && q % 120 === 0) {
    return (deltaY / 120) * WHEEL_NOTCH_PX;
  }
  if (q >= 100 && q % 100 === 0) {
    return (deltaY / 100) * WHEEL_NOTCH_PX;
  }
  const scale = Number.isFinite(designPerClientPx) && designPerClientPx > 0 ? designPerClientPx : 1;
  return deltaY * scale;
}

// ---------------------------------------------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------------------------------------------

// THE HARD limit: the game's own scroll window, and nothing else. Applied to every nudge AND re-applied every frame
// (the window itself can move — a grid re-lays out, the map screen resizes), because it is the one bound the host
// will enforce too, so an eager offset outside it is a position the game would never adopt.
export function clampEager(target: EagerScrollTarget, value: number): number {
  let lo = target.limitLo;
  let hi = target.limitHi;
  if (lo > hi) {
    const swap = lo;
    lo = hi;
    hi = swap;
  }
  return value < lo ? lo : value > hi ? hi : value;
}

// How far past the materialized band a gesture may still travel, in viewports. The host only ever streams roughly
// one viewport of rows around the current offset, and it re-fills the instant its own position moves, so one
// viewport is about how far the client can lead before the answer that fills it in arrives.
export const BAND_SLACK_VIEWPORTS = 1;

// THE SOFT one: the MATERIALIZED band of a virtualized grid, applied ONLY where new travel is requested (`nudge`),
// only AGAINST the direction of that travel, and never by moving the eager offset backwards.
//
// Band algebra. Content at container-local `p` is drawn at viewport-local `offset + p`, so at offset `o` the visible
// local range is `[-o, viewportHeight - o]`. Requiring that range to stay inside `[band.lo, band.hi]` gives
// `o ≤ -band.lo` and `o ≥ viewportHeight - band.hi`; both edges then get BAND_SLACK_VIEWPORTS of give.
//
// Why soft, and why only here (R11 WS-S §2). Round 2 re-applied the band as a HARD clamp on every frame, to a band
// that is itself a round trip old. Two things followed, and the player felt both: the resting offset of a deck grid
// was outside the band at all (see the renderer's header merge), so the first notch YANKED the content ~270px; and
// mid-gesture recycling could narrow the window under a live drag, which reversed the content against the finger.
// An absorbing edge can only ever slow a gesture down, never reverse it — and the settle still owns the truth.
export function absorbBand(
  target: EagerScrollTarget,
  prevY: number,
  wantedY: number,
  viewportHeight: number
): number {
  const band = target.band;
  if (!band || wantedY === prevY) {
    return wantedY;
  }
  const slack = Math.max(0, viewportHeight) * BAND_SLACK_VIEWPORTS;
  const lo = viewportHeight - band.hi - slack;
  const hi = -band.lo + slack;
  if (!(lo <= hi)) {
    return wantedY; // a nonsense band (mid-recycle frame) restricts nothing; the game's own limits still apply
  }
  // Only travel that leaves the window is absorbed, and only as far back as where the gesture already was: motion
  // BACK towards the materialized rows is always free, whichever side it starts from.
  if (wantedY > hi && wantedY > prevY) {
    return Math.max(prevY, hi);
  }
  if (wantedY < lo && wantedY < prevY) {
    return Math.min(prevY, lo);
  }
  return wantedY;
}

// ---------------------------------------------------------------------------------------------------------------
// Scrollbar mapping inference
// ---------------------------------------------------------------------------------------------------------------

// Two observed (scroll offset, thumb Y) REST pairs determine the line the game moves the thumb along, whatever the
// formula behind it is — the mapping is INFERRED from what the wire shows rather than encoded, so a change to the
// host's thumb placement re-fits itself. `null` until two pairs far enough apart to be a real slope have been
// seen — the thumb simply doesn't lead until then.
export interface BarMapping {
  slope: number;
  refOffset: number;
  refHandleY: number;
}

// The minimum offset separation between two samples for their slope to be trustworthy; below it, a smooth-damped
// thumb's own residual motion would dominate the fit.
const BAR_SAMPLE_MIN_SPAN = 8;

export function inferBarMapping(
  a: { offset: number; handleY: number },
  b: { offset: number; handleY: number }
): BarMapping | null {
  const span = b.offset - a.offset;
  if (!Number.isFinite(span) || Math.abs(span) < BAR_SAMPLE_MIN_SPAN) {
    return null;
  }
  const slope = (b.handleY - a.handleY) / span;
  if (!Number.isFinite(slope)) {
    return null;
  }
  // Re-anchor on the NEWER sample so a later resync only has to move the reference point, never re-fit the slope.
  return { slope, refOffset: b.offset, refHandleY: b.handleY };
}

export function barHandleYFor(mapping: BarMapping, offset: number): number {
  return mapping.refHandleY + (offset - mapping.refOffset) * mapping.slope;
}

// R19 WP5 — WHERE A PRESS ON THE BAR POINTS, as a fraction of the strip's own height.
//
// This is the one place the client reproduces a game formula rather than inferring it, and it can, because the
// formula is trivially simple and was read off the live bar: the pressed position is taken as `mousePosition.Y /
// Size.Y` — a fraction of the WHOLE strip, with NO compensation for the thumb's own height and no dead zone at
// either end — and the scroll target is then that fraction of the surface's bottom limit. So the client's mapping
// below is exact parity, not an approximation: press at the very top ⇒ the top of the content, press at the very
// bottom ⇒ the bottom limit, and every point between is linear. (The thumb's own POSITION is still inferred, not
// computed — see BarMapping — because that one is smooth-damped and is not worth guessing at.)
export function barFraction(box: EagerScrollBox, gameY: number): number {
  const height = box.maxY - box.minY;
  if (!(height > 0)) {
    return 0;
  }
  const fraction = (gameY - box.minY) / height;
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
}

// The container-local offset a bar press at `gameY` asks for. `limitHi` is the resting end (0 for a card grid, the
// only surface that has a bar) and `limitLo` the far one, so the lerp runs top→bottom exactly as the game's does.
export function barOffsetFor(target: EagerScrollTarget, gameY: number): number {
  const box = target.scrollbarBox;
  if (!box) {
    return target.limitHi;
  }
  return target.limitHi + (target.limitLo - target.limitHi) * barFraction(box, gameY);
}

// ---------------------------------------------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------------------------------------------

export type EagerPhase = "idle" | "active" | "settling" | "glide";

interface ScrollEntry {
  phase: EagerPhase;
  // The offset the PLAYER is looking at. Authoritative while active/settling; interpolated during a glide.
  eagerY: number;
  // Bookkeeping for the settle. "Streamed" here means the PAINTED value (EagerScrollTarget.renderedY) — the whole
  // state machine is a statement about the frame in front of the player, so `lastPaintedY` is what it compares
  // against and `paintedMovedAt` is when the paint last actually moved.
  lastPaintedY: number;
  paintedMovedAt: number;
  // May the STALL window end this settle with a glide (see SETTLE_STALL_MS)? Armed by evidence about the HOST, of
  // which there are exactly two kinds: the paint moved during this settle (it answered, then stopped short), or the
  // pan proof disowned the gesture (it is provably not performing it at all). Un-armed, still paint just means the
  // answer is in flight and only the deadline may give the eager offset up.
  stallGlideArmed: boolean;
  settleStartedAt: number;
  glideFrom: number;
  glideStartedAt: number;
  // Where the glide is heading. NULL tracks the LIVE painted value every frame, so the eager
  // offset and the paint meet wherever the host has got to. A NUMBER is an authority glide to a position the paint
  // has not reached yet (the game's own clamped answer), which is why such a glide ends back in `settling` rather
  // than in `idle` — clearing the translate onto an offset the container is still travelling to would be a jump.
  glideTo: number | null;
  lastInputAt: number;
  // ---- R19 WP5, the absolute channel's bookkeeping. All inert while the host offers no such channel. ----
  // The eager offset has moved since the last send and is OWED to the game.
  pendingSend: boolean;
  // The offset last actually SENT (null = nothing authored for this surface yet), and the requestId it went under.
  // Only an ack carrying THAT id is listened to: a gesture sends one of these every few frames, so an earlier
  // send's ack is a statement about a position the player has already scrolled past.
  authoredY: number | null;
  authoredRequestId: string | null;
  // The CLAMPED offset the game answered `authoredRequestId` with — i.e. where the game says it is going. Null
  // until the ack lands, and reset to null by every new send (which makes the previous ack stale by construction).
  ackedY: number | null;
  lastSentAt: number;
  // The deadline's one-shot re-send. An absolute send is IDEMPOTENT (unlike a wheel tick, which would double the
  // travel), so "the answer never came" is worth one repeat before the adopt-the-paint backstop gives up.
  resent: boolean;
  // What this entry has WRITTEN an offset to, so a target that vanishes (screen change, virtualization teardown)
  // can be cleaned up without needing the renderer to still know about it.
  wroteId: string | null;
  wroteBarId: string | null;
  // Scrollbar inference: the last REST sample and the fitted line.
  barSample: { offset: number; handleY: number } | null;
  barMapping: BarMapping | null;
}

// What a claimed drag gesture does. Current sessions use the semantic absolute-offset action; the caller withholds
// its press and motion stream while the engine leads locally and sends that action.
//   "motion"  — the relative map pan: the caller sends its press + motion stream, the host drag-scrolls off
//               the RELATIVE Y, and the engine only leads the paint.
//   "ticks"   — a GRID drag, or any two-finger scroll: the caller sends NOTHING (no press, no hover stream), and the
//               engine turns the gesture's own travel into coalesced count-carrying wheel ticks at a point that
//               belongs to nobody (see wheelSafe). This is what makes a drag work over CARDS — the game's own grid
//               drag needs a press no card consumed, which is precisely the press we are not sending.
//   "swallow" — claimed and deliberately inert (a map with a drawing tool armed, §7): the caller must not run its
//               ordinary input loop either.
//   "absolute"— R19 WP5, what "motion" and "ticks" BOTH become once the host offers the absolute channel: the caller
//               sends NOTHING (no press, no hover stream, no ticks) and the engine states the offset instead. For a
//               card grid that is the same withheld press "ticks" already had; for the MAP it is the fix for the
//               widescreen defect, because the press it withholds is exactly the one that used to be resolved into
//               stretched dead space where no painter sits and the game therefore never began a drag at all.
//   "bar"     — R19 WP5, a press on a card grid's SCROLLBAR STRIP. Absolute by nature (the press names a position,
//               not a distance) and claimed at the PRESS rather than at drag classification, because a tap on the
//               track is a complete gesture. Made on a `data-touch-block` widget on purpose — but only on the bar's
//               OWN stamp: that stamp says "the host owns this press", and under authority the client owns it
//               instead, whereas a BUTTON's stamp over the same pixels still belongs to the button (R21).
//   null      — not ours; the caller does exactly what it did before the feature existed.
export type PanClaim = "swallow" | "absolute" | "bar" | null;

// Does a claim mean the caller must WITHHOLD its press and its motion stream? True for every claim whose upstream
// half the engine owns outright. Exported so the input layer states the rule once instead of listing the members.
export function panClaimWithholdsPress(claim: PanClaim): boolean {
  return claim === "absolute" || claim === "bar";
}

// What the caller knows about the press point, which only IT can see (the DOM hit stack) — plus which kind of
// gesture is asking, because a two-finger scroll has no press to withhold in the first place.
export interface PanRequest extends BarPointFacts {
  // How many hover-first widget ids sat under the press (mirrorRenderer's `data-touch-id` stamps).
  ids: number;
  // A BUTTON-kind `data-touch-block` widget covered it (see the renderer's computeTouchInfo). R21: a SCROLLBAR's own
  // stamp is deliberately NOT reported here — whether the bar spoke for this press is `barOwnsPoint`'s question, and
  // answering it twice is what used to leave a refused bar claim with no claim at all.
  blocked: boolean;
  source: "press" | "gesture";
}

// R21 — what the caller knows about a point's relationship to the SCROLLBAR, which (like PanRequest.blocked) only
// the input layer can see. Both are optional and both default to the pre-R21 behaviour when absent, so a caller with
// no raw X (a two-finger centroid) or no probe (the wheel) keeps the plain game-space test.
export interface BarPointFacts {
  // The pointer's own WIDENED-DESIGN X, pre-resolve. R20's gate: on a widened stage the resolve is many-to-one, so a
  // game-space AABB is not a valid hit test — the raw pointer must be on the strip AS PAINTED too.
  rawDesignX?: number;
  // Something OTHER than this bar is painted on top of the strip here (a confirm button, a card): the topmost stamp
  // in the DOM z-stack is not the bar's own. The bar claims what the player is touching, and this says they are not
  // touching the bar.
  barOccluded?: boolean;
}

export interface EagerScrollDeps {
  // The live scrollables, in paint order (later = on top, so the LAST viewport match wins).
  targets: () => EagerScrollTarget[];
  // Upstream input send — the same fire-and-forget path inputCapture uses.
  send: (message: MirrorInputMessage) => void;
  // Design px per CSS px on the current stage (the letterbox scale's reciprocal), for the trackpad's 1:1 mapping.
  designPerClientPx: () => number;
  // The absolute channel. `sendScroll` puts a `set-scroll-offset` action on the wire for one scroll
  // container (addressed by its live node id, which IS the id the scene stream uses) and returns the requestId it
  // went under, or null when the socket is not open.
  sendScroll: (elementId: string, offsetY: number) => string | null;
  // The renderer's local-offset seam, addressed by node id. This engine decides WHAT the offset is; where it is
  // written (an inline `translate` or a draw-list entry) and what "where it is painted" means belong to whoever
  // drew the frame.
  applyLocalOffset: (nodeId: string, dy: number) => void;
  scrollRenderedY: (nodeId: string) => number | null;
  now?: () => number;
  raf?: (cb: () => void) => number;
  caf?: (handle: number) => void;
}

export interface EagerScroll {
  // A wheel notch (already normalised to GAME px, positive = scroll down) at a resolved GAME point. Returns true
  // when a scrollable claimed it — the caller must then NOT send its own tick (this module owns the send, coalesced
  // once per frame). False = nothing eager here; the caller sends its ordinary single tick.
  // `rawDesignX` (the pointer's own widened-design X) narrows what counts as the scrollbar strip here, exactly as it
  // does for a press — a notch beside the painted bar on a widened stage belongs to the CONTENT. No occlusion fact:
  // that one costs a hit-stack probe, and a trackpad streams these events (the phone-CPU rule).
  wheel(
    gameX: number,
    gameY: number,
    gamePx: number,
    coord: { coordX: number; coordY: number },
    rawDesignX?: number
  ): boolean;
  // A drag gesture begins at a resolved GAME point. The returned claim tells the caller what to send (see
  // PanClaim); a claimed gesture is also exempt from the growing Y-compensation, because the host consumes
  // RELATIVE motion and a compensation that grew with the drag would eat the very delta producing it.
  beginPan(gameX: number, gameY: number, request?: PanRequest): PanClaim;
  // R19 WP5 — a press that landed on a card grid's SCROLLBAR STRIP, offered at the PRESS on both pointer paths.
  // Returns "bar" when it was claimed (the caller then withholds its press and streams the pointer through
  // `panTo` like any other claimed gesture) or null when it was not — which is every case the host cannot answer:
  // no absolute channel, the point is not on a bar, or the surface is suppressed.
  //
  // Separate from `beginPan` because the two disagree about WHEN and about WHAT: this one claims at the press (a
  // track tap is a whole gesture, not the start of a drag) and claims a `data-touch-block` widget on purpose.
  //
  // `facts` carries what only the caller can see about the point (see BarPointFacts); omitting either fact leaves
  // that gate inert. `deferred` is the TOUCH rule (R21): claim the gesture but move nothing yet, and let `panTo` /
  // `endPan` decide from what the finger DOES whether this was a track tap or a content swipe that happened to
  // start on the strip. A mouse press — and a touch press on the THUMB — passes it false and acts at once, as before.
  beginBarPan(gameX: number, gameY: number, facts?: BarPointFacts & { deferred?: boolean }): PanClaim;
  // Absolute finger GAME Y during the pan; the delta since the last call drives the eager offset. (For a "bar"
  // gesture there is no delta: the position itself maps to a fraction of the strip and thence to an offset.)
  panTo(gameY: number): void;
  endPan(): void;
  // Is a pan currently claimed? (inputCapture asks so it can skip the compensation for that gesture.)
  panActive(): boolean;
  // …and WHAT it claimed, for the two things only the caller can do: withhold the press/hover stream of a "ticks"
  // gesture, and know that a "swallow" must not fall through to the ordinary input loop. Null when no gesture is
  // claimed.
  panMode(): Exclude<PanClaim, null> | null;
  // Y-compensation: a resolved GAME point inside a scrollable that is currently AHEAD of the host must be reported
  // in the host's coordinates, or a tap right after a scroll lands on whatever the host still has there.
  compensate(coordX: number, coordY: number): { coordX: number; coordY: number };
  // THE SINGLE-WRITER SEAM (R11 WS-S). Called by MirrorView the instant `renderer.reconcile(...)` returns, i.e.
  // while the frame the walk just wrote is still un-painted: re-compose every live translate against the base
  // transform that walk PUT THERE, so `base + translate === eagerY` on every frame the player sees, whatever order
  // the two rAFs happened to run in. Pure composition — no clock, no state machine, no sends — and a zero-cost
  // early return when nothing is eager, which is the overwhelmingly common case.
  afterReconcile(): void;
  // R19 WP5 — the host's answer to one absolute send (mirrorClient's `onScrollAck`). Matched to the surface whose
  // LATEST send carries that requestId; anything else is a stale ack and is dropped without a trace.
  noteScrollAck(ack: MirrorScrollAck): void;
  // HARD RESET — drop every eager offset and adopt the streamed truth (keyframe / reconnect / stretch toggle).
  reset(): void;
  // Test seam (never called in production): the live phase + offset of one target.
  __entryForTest(id: string): { phase: EagerPhase; eagerY: number } | null;
  // Test seam: the absolute channel's bookkeeping for one target (see ScrollEntry).
  __authorityForTest(id: string):
    | { authoredY: number | null; ackedY: number | null; requestId: string | null; resent: boolean }
    | null;
  // Test seam: run one frame of the blend loop with an explicit clock.
  __frameForTest(): void;
  dispose(): void;
}

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

// Cubic ease-out for the settle glide — decelerating, so the last pixels are the slowest and the arrival is
// invisible. (A linear glide reads as a small constant-speed slide, which is exactly what a settle should not.)
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function createEagerScroll(deps: EagerScrollDeps): EagerScroll {
  const now = deps.now ?? defaultNow;
  const raf =
    deps.raf ?? (typeof requestAnimationFrame === "function" ? (cb: () => void) => requestAnimationFrame(cb) : null);
  const caf = deps.caf ?? (typeof cancelAnimationFrame === "function" ? (h: number) => cancelAnimationFrame(h) : null);

  const entries = new Map<string, ScrollEntry>();
  let frameHandle = 0;
  let panId: string | null = null;
  // §6: the claim is made at the press but only ARMED — `panPending` says "claimed, nothing eager yet", and
  // `panStartGameY` is the press point the activation threshold is measured from.
  let panPending = false;
  let panStartGameX = 0;
  let panStartGameY = 0;
  let panLastGameY = 0;
  // What this gesture claimed (see PanClaim).
  let panMode: Exclude<PanClaim, null> | null = null;
  // R21 — the last pointer Y this gesture was fed, whatever its phase. Distinct from `panLastGameY`, which is the
  // last CONSUMED position and must stay frozen at the press while a claim is pending (the hand-over applies the
  // travel since the press, so spending it early would swallow it). This one is only read to commit a deferred
  // track TAP at the place the finger actually lifted.
  let panLatestGameY = 0;
  // The eager-vs-streamed delta FROZEN at the moment the pan was armed. A pan must be compensated by a CONSTANT,
  // not by the live (growing) delta: the host turns consecutive injected positions into `Relative` motion and
  // scrolls by it, so a compensation that grows with the drag would subtract the scroll from the very deltas
  // producing it — while dropping compensation altogether would mis-place the press/release HIT TEST of a gesture
  // that turns out to be an ordinary click. A constant cancels in every difference and is exact at both endpoints.
  let disposed = false;

  function newEntry(paintedY: number, at: number): ScrollEntry {
    return {
      phase: "idle",
      eagerY: paintedY,
      lastPaintedY: paintedY,
      paintedMovedAt: at,
      stallGlideArmed: false,
      settleStartedAt: 0,
      glideFrom: paintedY,
      glideStartedAt: 0,
      glideTo: null,
      lastInputAt: at,
      pendingSend: false,
      authoredY: null,
      authoredRequestId: null,
      ackedY: null,
      lastSentAt: 0,
      resent: false,
      wroteId: null,
      wroteBarId: null,
      barSample: null,
      barMapping: null
    };
  }

  function writeOffset(id: string | null, dy: number): void {
    if (id !== null) deps.applyLocalOffset(id, dy);
  }

  // What the renderer has actually PAINTED this node's Y at (mirrorRenderer.scrollRenderedY) — the value every
  // compose/settle decision is measured against. A target can vanish between snapshots, in which case its last
  // snapshot value is the only current-frame value available while cleanup runs.
  function paintedYOf(target: EagerScrollTarget): number {
    return deps.scrollRenderedY(target.id) ?? target.renderedY;
  }

  function clearEntryWrites(entry: ScrollEntry): void {
    if (entry.wroteId !== null) {
      writeOffset(entry.wroteId, 0);
      entry.wroteId = null;
    }
    if (entry.wroteBarId !== null) {
      writeOffset(entry.wroteBarId, 0);
      entry.wroteBarId = null;
    }
  }

  function viewportHeight(target: EagerScrollTarget): number {
    return target.viewport.maxY - target.viewport.minY;
  }

  // Drop an entry outright: clear what it wrote, forget it, and release any pan riding on it. Used for every HARD
  // RESET (the scrollable is gone, a tween owns its transform) from BOTH the frame loop and the compose seam, so
  // the two can never disagree about whether a target is still ours.
  function retireEntry(id: string, entry: ScrollEntry): void {
    clearEntryWrites(entry);
    entries.delete(id);
    if (panId === id) {
      panId = null;
      panMode = null;
      panPending = false;
    }
  }

  // THE ONE PLACE A TRANSLATE IS WRITTEN. `translate = eagerY − renderedY`, i.e. the gap between where the player
  // should be looking and the base transform the renderer has actually baked — so the composed position
  // (`base + translate`, CSS applies them in that order) is the eager one by construction. Re-asserted against the
  // current renderer node every call: the renderer recreates nodes (pool recycling, adoption, a structural rebuild).
  function composeEntry(entry: ScrollEntry, target: EagerScrollTarget): void {
    const delta = entry.eagerY - paintedYOf(target);
    entry.wroteId = target.id;
    writeOffset(target.id, delta);
    syncBar(entry, target, delta);
  }

  // See EagerScroll.afterReconcile. The invariant this restores is the whole fix for the SHAKE: before it, the
  // renderer's walk and this module's rAF were two independent writers of one pixel, and in the (deterministic,
  // unlucky) order "engine first, walk second" every reconciled frame painted `eagerY + one host lerp step` — the
  // host's catch-up landed ON SCREEN instead of inside the translate. Measured by scripts/probe-eager-scroll.mjs as
  // a composed-Y overshoot of 258px at rtt 250 / 400px at rtt 400.
  function afterReconcile(): void {
    if (disposed || entries.size === 0) {
      return; // the overwhelmingly common frame: nothing is eager, so nothing to compose
    }
    const byId = new Map<string, EagerScrollTarget>();
    for (const t of deps.targets()) {
      byId.set(t.id, t);
    }
    for (const [id, entry] of entries) {
      const target = byId.get(id);
      if (!target || target.pinned) {
        retireEntry(id, entry);
        continue;
      }
      composeEntry(entry, target);
    }
  }

  function inBox(box: EagerScrollBox, x: number, y: number): boolean {
    return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
  }

  // R21 — DOES THE BAR OWN THIS POINT? The one statement of it, asked by BOTH sides of the strip's boundary: the
  // bar's own claim (`beginBarPan`) and the CONTENT claim that carves the strip out (`targetHitAt`). They used to
  // disagree by construction — the content side carved out the game-space AABB while the bar side had two extra
  // gates on top of it — and every point in the gap between them was claimed by NOBODY: the press went upstream at a
  // coordinate the game reads as its own scrollbar, so the game's bar took the gesture the client had just decided
  // was not the bar's. That is the same hijack the client-side claim exists to prevent, one layer down.
  //
  // Three conditions, in the order they became necessary:
  //   1. inside the strip's GAME box at all (R19 WP5);
  //   2. inside the strip AS PAINTED, when the caller can say where the pointer physically is (R20 — on a widened
  //      stage the resolve is many-to-one, so a band beside the bar resolves into its game rect);
  //   3. nothing else painted on top of it (R21 — a card-selection dialog's confirm button overlaps the strip, and
  //      the player is pressing the BUTTON they can see).
  function barOwnsPoint(
    target: EagerScrollTarget,
    gameX: number,
    gameY: number,
    facts: BarPointFacts
  ): boolean {
    const box = target.scrollbarBox;
    if (box === null || !inBox(box, gameX, gameY)) {
      return false;
    }
    if (facts.rawDesignX !== undefined && target.scrollbarRenderedBox !== null) {
      const rendered = target.scrollbarRenderedBox;
      if (facts.rawDesignX < rendered.minX || facts.rawDesignX > rendered.maxX) {
        return false;
      }
    }
    return facts.barOccluded !== true;
  }

  // The topmost scrollable whose viewport contains a GAME point (the array is in paint order, so the LAST match
  // wins — a card dialog opened over the map owns the pointer), and WHERE on it the point landed. Deliberately not
  // a fall-through: the map behind an open deck dialog must not inherit a tick meant for that dialog's scrollbar.
  function targetHitAt(
    list: readonly EagerScrollTarget[],
    gameX: number,
    gameY: number,
    facts: BarPointFacts = {}
  ): { target: EagerScrollTarget; zone: "content" | "bar" } | null {
    let found: EagerScrollTarget | null = null;
    for (const t of list) {
      if (inBox(t.viewport, gameX, gameY)) {
        found = t;
      }
    }
    if (!found) {
      return null;
    }
    return { target: found, zone: barOwnsPoint(found, gameX, gameY, facts) ? "bar" : "content" };
  }

  // The RELATIVE claim surface: the same thing minus the scrollbar strip, which a wheel tick or a compensated tap
  // still has no business on (both remain relative channels, whatever the host offers). The BAR is reached through
  // `beginBarPan` instead — see EagerScrollTarget.scrollbarBox. `facts` narrows what "the strip" means for this
  // caller; without them it is the plain game box, exactly as before.
  function targetAt(
    list: readonly EagerScrollTarget[],
    gameX: number,
    gameY: number,
    facts: BarPointFacts = {}
  ): EagerScrollTarget | null {
    const hit = targetHitAt(list, gameX, gameY, facts);
    return hit !== null && hit.zone === "content" ? hit.target : null;
  }

  function ensureFrame(): void {
    if (frameHandle || disposed || raf === null) {
      return;
    }
    frameHandle = raf(runFrame);
  }

  function anyLive(): boolean {
    for (const entry of entries.values()) {
      if (entry.phase !== "idle") {
        return true;
      }
    }
    return false;
  }

  // Move a target's eager offset by `dy` game px and mark it ACTIVE.
  function nudge(target: EagerScrollTarget, dy: number, at: number): void {
    let entry = entries.get(target.id);
    if (!entry) {
      entry = newEntry(paintedYOf(target), at);
      entries.set(target.id, entry);
    }
    if (entry.phase === "idle" || entry.phase === "glide") {
      // A fresh gesture (or one that interrupts a glide) starts from what is ON SCREEN right now, so it can never
      // teleport: during a glide the visible offset is the interpolated one, which `eagerY` already holds.
      entry.eagerY = entry.phase === "idle" ? paintedYOf(target) : entry.eagerY;
    }
    entry.phase = "active";
    entry.lastInputAt = at;
    entry.glideTo = null;
    // NEW travel is the only place the materialized band is consulted, and it can only absorb (see absorbBand); the
    // game's own window is hard at every step.
    const wanted = clampEager(target, entry.eagerY + dy);
    entry.eagerY = absorbBand(target, entry.eagerY, wanted, viewportHeight(target));
    entry.pendingSend = true; // the frame loop decides WHEN — see flushScroll
    ensureFrame();
  }

  // R19 WP5 — put the eager offset at an ABSOLUTE value (the scrollbar's press-to-fraction; nothing else uses it).
  //
  // Deliberately NOT band-absorbed, unlike `nudge`: an absolute jump is where the player POINTED and therefore
  // where the game is about to be, so stopping the client short of it would put the two in different places —
  // precisely the disagreement this channel exists to remove. The recycled rows arrive with the stream, exactly as
  // they do for the game's own bar.
  function setAbsolute(target: EagerScrollTarget, wantedY: number, at: number): void {
    let entry = entries.get(target.id);
    if (!entry) {
      entry = newEntry(paintedYOf(target), at);
      entries.set(target.id, entry);
    }
    entry.phase = "active";
    entry.lastInputAt = at;
    entry.glideTo = null;
    entry.eagerY = clampEager(target, wantedY);
    entry.pendingSend = true;
    ensureFrame();
  }

  // R19 WP5 — put the entry's current offset on the wire, subject to the coalescing gates (see SCROLL_SEND_MIN_MS
  // / _PX). `final` is the end of a gesture: it ignores both gates, because that send is the one that decides where
  // the game comes to rest. A send that could not go out (a closing socket) leaves the entry OWING one, rate-limited
  // by the same clock, so a momentary hiccup self-heals instead of stranding the surface mid-gesture.
  function flushScroll(id: string, entry: ScrollEntry, at: number, final: boolean): void {
    if (!entry.pendingSend) {
      return;
    }
    const moved = entry.authoredY === null || Math.abs(entry.eagerY - entry.authoredY) >= SCROLL_SEND_MIN_PX;
    if (!final && (!moved || at - entry.lastSentAt < SCROLL_SEND_MIN_MS)) {
      return;
    }
    if (final && entry.authoredY !== null && Math.abs(entry.eagerY - entry.authoredY) < 0.01) {
      entry.pendingSend = false; // the last send already said exactly this
      return;
    }
    const requestId = deps.sendScroll(id, entry.eagerY);
    entry.lastSentAt = at;
    if (requestId === null) {
      return; // still owed; the gate above keeps the retry bounded
    }
    entry.pendingSend = false;
    entry.authoredY = entry.eagerY;
    entry.authoredRequestId = requestId;
    // Every send makes the previous answer stale by construction — it was about a position we have moved past.
    entry.ackedY = null;
    entry.resent = false;
  }

  function noteScrollAck(ack: MirrorScrollAck): void {
    for (const entry of entries.values()) {
      if (entry.authoredRequestId !== null && entry.authoredRequestId === ack.requestId) {
        entry.ackedY = ack.offsetY;
        ensureFrame(); // the settle may be waiting on exactly this
        return;
      }
    }
  }

  // ---- the wheel -----------------------------------------------------------------------------------------------

  function wheel(
    gameX: number,
    gameY: number,
    gamePx: number,
    _coord: { coordX: number; coordY: number },
    rawDesignX?: number
  ): boolean {
    if (gamePx === 0) {
      return false;
    }
    const target = targetAt(deps.targets(), gameX, gameY, rawDesignX === undefined ? {} : { rawDesignX });
    if (!target) {
      return false;
    }
    if (target.suppressed) {
      // §7 — CLAIMED AND SWALLOWED. The native game does scroll its map with a quill armed; the mirror deliberately
      // does not (product decision), because a phone's scroll and its draw are the same finger and a stroke that
      // travels with the map underneath it is unreadable. Returning true is the point: the caller must not fall
      // back to its own tick either, so NOTHING goes upstream.
      return true;
    }
    const at = now();
    // Resolved BEFORE the nudge: the un-compensating branch adds back the lead this scrollable ALREADY had, and
    // this tick's own local motion is not part of it.
    // Positive gamePx = scroll DOWN = the container offset decreases.
    nudge(target, -gamePx, at);
    return true;
  }

  // ---- the pan -------------------------------------------------------------------------------------------------

  // The claim decision, in one place (see PanClaim). Everything it needs about the press point comes in via
  // `request`; everything it needs about the scrollable comes off the target.
  function claimFor(target: EagerScrollTarget, request: PanRequest): PanClaim {
    if (target.suppressed) {
      // §7: a map with a drawing tool armed. A PRESS must pass through untouched — that gesture is the player
      // DRAWING — while a two-finger scroll (which has no press to pass through) is swallowed outright.
      return request.source === "gesture" ? "swallow" : null;
    }
    if (request.blocked) {
      return null; // a button / a scrollbar owns this press (§3 tri-state)
    }
    if (request.source === "press" && target.kind !== "grid" && request.ids !== 0) {
      return null;
    }
    return "absolute";
  }

  const DEFAULT_PAN_REQUEST: PanRequest = { ids: 0, blocked: false, source: "press" };

  // Arm a claimed CONTENT gesture on one scrollable, from the point it began at. Shared by `beginPan` and by the
  // hand-over a deferred track gesture takes when it turns out to be a swipe (see panTo) — the two must arm
  // identically, or the hand-over would be a second, subtly different kind of pan.
  function armContentPan(target: EagerScrollTarget, gameX: number, gameY: number, claim: PanClaim): void {
    // §6: the claim is recorded, nothing is activated. No entry is created, no translate is written, and the
    // container keeps painting the stream until the gesture actually MOVES (see panTo / PAN_ACTIVATE_PX).
    //
    // The compensation constant is frozen HERE, though, from the lead this scrollable already had — the press that
    // is about to be sent is compensated by it, and every later coordinate of the gesture must use the SAME number
    // or the host's relative-motion chain (consecutive injected positions) gains a step nobody asked for. Read with
    // `panId` CLEARED, so `deltaFor` answers with the live lead rather than with the constant it is computing (or,
    // on a hand-over, with the exemption the claim being replaced was carrying).
    panId = null;
    panMode = null;
    panId = target.id;
    panMode = claim;
    panPending = true;
    panStartGameX = gameX;
    panStartGameY = gameY;
    panLastGameY = gameY;
    panLatestGameY = gameY;
  }

  function beginPan(gameX: number, gameY: number, request: PanRequest = DEFAULT_PAN_REQUEST): PanClaim {
    // R21: the strip is carved out of the content surface only where the bar actually OWNS the point — the request
    // carries the two facts that decide it (see barOwnsPoint). A point the bar refuses is ordinary content.
    const target = targetAt(deps.targets(), gameX, gameY, request);
    if (!target) {
      return null;
    }
    const claim = claimFor(target, request);
    if (claim === null || claim === "swallow") {
      return claim;
    }
    armContentPan(target, gameX, gameY, claim);
    return claim;
  }

  // R19 WP5 — the SCROLLBAR strip, claimed at the press. See EagerScroll.beginBarPan.
  function beginBarPan(gameX: number, gameY: number, facts: BarPointFacts & { deferred?: boolean } = {}): PanClaim {
    // The zone test carries BOTH gates (painted-strip, unoccluded) — see barOwnsPoint, which the content claim asks
    // the same question of, so the two can never leave a point claimed by nobody.
    const hit = targetHitAt(deps.targets(), gameX, gameY, facts);
    if (hit === null || hit.zone !== "bar" || hit.target.suppressed) {
      return null;
    }
    const target = hit.target;
    panId = target.id;
    panMode = "bar";
    panStartGameX = gameX;
    panStartGameY = gameY;
    panLastGameY = gameY;
    panLatestGameY = gameY;
    // A bar gesture sends no press, no hover and no tick, so neither the frozen compensation nor the tick point has
    // anything to be right about. Zeroed rather than left stale.
    // R19 WP5 shipped this claim NOT pending, unlike every other one: a press on the track is the whole gesture, and
    // the defect it fixed was that such a press did nothing at all. R21 keeps that for the MOUSE and for a touch on
    // the THUMB, and defers it for a FINGER on the TRACK, where "the press is the gesture" is
    // exactly the assumption that broke — see BAR_TAP_SLOP_PX. A deferred claim moves nothing and sends nothing; it
    // is resolved by what the finger does next (panTo hands a swipe to the content, endPan commits a tap).
    panPending = facts.deferred === true;
    if (!panPending) {
      setAbsolute(target, barOffsetFor(target, gameY), now());
    }
    return "bar";
  }

  // R21 — a deferred TRACK gesture that travelled: it was never a track gesture at all, so the strip gives it up and
  // the grid's CONTENT takes it, armed at the PRESS so this frame's nudge carries every pixel the finger has moved
  // since (no jump, and nothing was sent upstream to retract — a "bar" claim withholds the press exactly like the
  // "absolute"/"ticks" claim replacing it). Returns false when nothing can take it, which ends the claim.
  function handOverBarPan(target: EagerScrollTarget): boolean {
    const claim = claimFor(target, { ids: 0, blocked: false, source: "press" });
    if (claim === null || claim === "swallow") {
      return false;
    }
    armContentPan(target, panStartGameX, panStartGameY, claim);
    panPending = false; // the travel that decided this already happened
    return true;
  }

  function panTo(gameY: number): void {
    if (panId === null) {
      return;
    }
    const target = deps.targets().find((t) => t.id === panId);
    if (!target) {
      // The scrollable went away mid-gesture — stop panning rather than steering a stale entry.
      panId = null;
      panMode = null;
      panPending = false;
      return;
    }
    panLatestGameY = gameY;
    if (panPending) {
      // A deferred TRACK gesture is deciding what it is, and its threshold is the TAP slop rather than the
      // activation hair: under it the gesture may still turn out to be a tap (committed by endPan), over it it is a
      // swipe and the strip gives it up. Everything else keeps §6's "a press is not a scroll until it moves".
      if (panMode === "bar") {
        if (Math.abs(gameY - panStartGameY) < BAR_TAP_SLOP_PX) {
          return; // still tap-sized — the grid must not move, and nothing has been sent
        }
        if (!handOverBarPan(target)) {
          panId = null;
          panMode = null;
          panPending = false;
          return;
        }
      } else {
        if (Math.abs(gameY - panStartGameY) < PAN_ACTIVATE_PX) {
          return; // still a hold, not a scroll — leave the stream alone
        }
        // First real motion: the entry is created (or re-seeded) by the nudge below from what is ON SCREEN right
        // now, which is what makes a hold-then-drag start from where the host has got to rather than from the press.
        panPending = false;
      }
    }
    const dy = gameY - panLastGameY;
    panLastGameY = gameY;
    if (dy === 0) {
      return;
    }
    const at = now();
    if (panMode === "bar") {
      // A bar drag is ABSOLUTE all the way through: the finger's position on the strip is a fraction, and the
      // fraction is an offset. There is no delta to accumulate and no 1:1 to preserve — dragging the thumb to the
      // middle means the middle of the collection however fast the finger got there.
      setAbsolute(target, barOffsetFor(target, gameY), at);
      return;
    }
    // Either way the content follows the finger 1:1 on THIS frame.
    nudge(target, dy, at);
    // `nudge` marked the absolute position owed; the frame loop sends it.
  }

  function endPan(): void {
    if (panId === null) {
      return;
    }
    const id = panId;
    if (panMode === "bar" && panPending) {
      // R21 — THE TRACK TAP, committed at the end instead of at the press. It never travelled past the tap slop, so
      // this is the gesture R19 WP5 introduced the claim for, and it lands at the position the finger LIFTED at
      // (within the slop of where it went down). A gesture that travelled is not here: it became a content pan the
      // moment it did (see handOverBarPan).
      const target = deps.targets().find((t) => t.id === id);
      if (target) {
        setAbsolute(target, barOffsetFor(target, panLatestGameY), now());
      }
      panPending = false;
    }
    const entry = entries.get(id);
    if (entry && entry.phase === "active") {
      // Hand straight to the settle: the release is the end of the gesture, there is nothing to wait ACTIVE_HOLD for.
      entry.lastInputAt = 0;
    }
    if ((panMode === "absolute" || panMode === "bar") && entry) {
      // R19 WP5 — THE SEND THAT DECIDES WHERE THE GAME ENDS UP. The release is the gesture's last position, so it
      // goes out regardless of the coalescing gates: a throttled-away final send would leave the game a few px from
      // where the player let go, which is the whole class of defect this channel exists to close.
      flushScroll(panId, entry, now(), true);
    }
    panId = null;
    panMode = null;
    panPending = false;
    ensureFrame();
  }

  function panActive(): boolean {
    return panId !== null;
  }

  // ---- compensation --------------------------------------------------------------------------------------------

  // How far a target's content is currently drawn AHEAD of the host's own, for a coordinate crossing it. Zero
  // (⇒ identity) when the feature or the compensation is off, when nothing is eager, or below the epsilon.
  function deltaFor(target: EagerScrollTarget): number {
    const entry = entries.get(target.id);
    if (!entry || entry.phase === "idle") {
      return 0;
    }
    // A claimed absolute gesture sends no coordinates upstream, so it is exempt from compensation. The live lead
    // returns as soon as the gesture ends.
    const delta = panId === target.id ? 0 : entry.eagerY - target.streamedY;
    return Math.abs(delta) < SETTLE_EPS_PX ? 0 : delta;
  }

  function compensate(coordX: number, coordY: number): { coordX: number; coordY: number } {
    if (entries.size === 0) {
      return { coordX, coordY };
    }
    const target = targetAt(deps.targets(), coordX, coordY);
    if (!target) {
      return { coordX, coordY };
    }
    // The content the player sees at screen Y `coordY` is the content the game has at `coordY − delta`.
    return { coordX, coordY: coordY - deltaFor(target) };
  }

  // ---- the per-frame blend -------------------------------------------------------------------------------------

  function runFrame(): void {
    frameHandle = 0;
    if (disposed) {
      return;
    }
    const at = now();
    const list = deps.targets();
    const byId = new Map<string, EagerScrollTarget>();
    for (const t of list) {
      byId.set(t.id, t);
    }

    for (const [id, entry] of entries) {
      const target = byId.get(id);
      // HARD RESET — the scrollable is gone (screen change / teardown) or a tween owns its transform.
      if (!target || target.pinned) {
        retireEntry(id, entry);
        continue;
      }

      // The state machine follows what is PAINTED (see renderedY): "the host caught up" is a statement about the
      // frame the player is looking at, and composing/settling against anything else re-introduces the dip.
      const painted = paintedYOf(target);
      if (Math.abs(painted - entry.lastPaintedY) > 0.01) {
        entry.paintedMovedAt = at;
        if (entry.phase === "settling") {
          entry.stallGlideArmed = true; // the host is demonstrably answering this gesture
        }
      }
      entry.lastPaintedY = painted;

      let justSettled = false;
      if (entry.phase === "active" && at - entry.lastInputAt >= ACTIVE_HOLD_MS) {
        entry.phase = "settling";
        entry.settleStartedAt = at;
        entry.paintedMovedAt = at;
        entry.stallGlideArmed = false;
        justSettled = true;
      }

      if (entry.phase === "settling") {
        // R19 WP5 — THE DISCRIMINATION. Without the absolute channel there is exactly one statement about this
        // surface (the PAINT) and therefore exactly one possible answer to a disagreement: adopt it. With the
        // channel there are three, and their disagreements name their causes:
        //
        //   eagerY  where the player left the client;
        //   ackedY  what the game said it CLAMPED our request to — a statement about where it is GOING;
        //   painted where the container actually is on screen right now.
        //
        // So the order below reads: agreed ⇒ done. The game refused the travel (acked ≠ what we asked for) ⇒ the
        // game wins, because its limits are the real ones. The paint has stalled somewhere that is NOT what the
        // game acked ⇒ something other than us moved this surface, and THAT is the player's stated exception, so
        // the client follows the paint. Nothing at all came back ⇒ re-send once (an absolute send is idempotent,
        // unlike a wheel tick, which is why this repeat is safe here and was never safe before), then the ancient
        // adopt-the-paint backstop, which must survive because a dropped message must never strand the player
        // looking at a position the game does not agree with.
        if (Math.abs(entry.eagerY - painted) <= SETTLE_EPS_PX) {
          entry.phase = "idle";
        } else if (entry.ackedY !== null && Math.abs(entry.ackedY - entry.eagerY) > SETTLE_EPS_PX) {
          beginGlide(entry, at, entry.ackedY);
        } else if (
          entry.stallGlideArmed &&
          at - entry.paintedMovedAt >= SETTLE_STALL_MS &&
          entry.ackedY !== null &&
          Math.abs(painted - entry.ackedY) > SETTLE_EPS_PX
        ) {
          // THE PLAYER'S EXCEPTION. The game answered our send, and the paint has since come to rest somewhere
          // else entirely — an act-change slide, another seat's input, a grid re-layout. Follow it (glideTo null =
          // track the live paint), which is the same motion the pre-authority client made for every settle.
          //
          // The `ackedY !== null` leg is what makes this a discrimination rather than a guess, and it is why the
          // relative path's version of this branch could never be right about the cause: WITHOUT an answer, still
          // paint means only that the answer is in flight (the SETTLE_STALL_MS note), and the ack arrives ahead of
          // the delta it explains, since the handler answers inline while the moved container waits for the
          // producer's next walk. An answer that never comes at all is the deadline's business below — slower to
          // recover than a glide, and deliberately so: 800ms of the player's own position beats 120ms of gliding
          // to a place chosen for a reason we could not establish.
          beginGlide(entry, at, null);
        } else if (at - entry.settleStartedAt >= SETTLE_DEADLINE_MS) {
          if (!entry.resent && entry.authoredY !== null) {
            const requestId = deps.sendScroll(id, entry.authoredY);
            entry.resent = true;
            entry.lastSentAt = at;
            entry.settleStartedAt = at; // one more full window for the repeat to be answered
            if (requestId !== null) {
              entry.authoredRequestId = requestId;
              entry.ackedY = null;
            }
          } else {
            // The streamed geometry never arrived. The player's local position is a promise we can no longer keep
            // — adopt the host's truth outright rather than keep showing a fiction.
            entry.eagerY = painted;
            entry.phase = "idle";
          }
        }
      }

      if (entry.phase === "glide") {
        const to = entry.glideTo ?? painted;
        const k = SETTLE_GLIDE_MS <= 0 ? 1 : Math.min(1, Math.max(0, (at - entry.glideStartedAt) / SETTLE_GLIDE_MS));
        entry.eagerY = entry.glideFrom + (to - entry.glideFrom) * easeOutCubic(k);
        if (k >= 1) {
          entry.eagerY = to;
          if (entry.glideTo !== null && Math.abs(to - painted) > SETTLE_EPS_PX) {
            // An authority glide landed on the game's own answer, but the container has not travelled there yet.
            // Going IDLE here would clear the translate onto a position the paint has not reached — a jump of
            // exactly the remaining catch-up. Hand back to SETTLING instead: its agreement test ends this the
            // quiet way once the paint arrives, and its deadline is still the backstop if it never does.
            entry.phase = "settling";
            entry.settleStartedAt = at;
            entry.paintedMovedAt = at;
            entry.stallGlideArmed = false;
            entry.glideTo = null;
          } else {
            entry.phase = "idle";
          }
        }
      }

      if (entry.phase === "idle") {
        clearEntryWrites(entry);
        // A scrollable at rest is where the scrollbar inference gets its samples: the thumb has settled (the game
        // smooth-damps it), so an (offset, thumb Y) pair taken here is on the real line.
        noteBarSample(entry, target);
        entries.delete(id);
        continue;
      }

      // Keep the eager offset inside the GAME's own window every frame (it can move under a live gesture: a grid
      // re-lays out, a screen resizes). The materialized band is deliberately NOT re-applied here — see absorbBand.
      entry.eagerY = clampEager(target, entry.eagerY);

      // R19 WP5: state the (now clamped) offset upstream. Only while the gesture is LIVE, plus the one final send
      // on the frame it ends — a glide is the client FOLLOWING the game, and authoring it would be the client
      // arguing with the answer it just agreed to.
      if (entry.phase === "active" || justSettled) {
        flushScroll(id, entry, at, justSettled);
      }

      composeEntry(entry, target);
    }

    if (anyLive()) {
      ensureFrame();
    }
  }

  // Start a settle glide. `to` is null for the paint-following mode (track the LIVE painted value each frame, so the two meet
  // wherever the host has got to) and a number for an authority glide to the game's own answer — see the glide
  // block in runFrame for why the latter ends back in `settling` rather than in `idle`.
  function beginGlide(entry: ScrollEntry, at: number, to: number | null): void {
    entry.phase = "glide";
    entry.glideFrom = entry.eagerY;
    entry.glideStartedAt = at;
    entry.glideTo = to;
  }

  // Record a REST (offset, thumb Y) pair and, once two are far enough apart, fit the line the thumb rides.
  function noteBarSample(entry: ScrollEntry, target: EagerScrollTarget): void {
    if (!target.bar) {
      return;
    }
    const sample = { offset: target.streamedY, handleY: target.bar.handleY };
    if (entry.barSample) {
      const mapping = inferBarMapping(entry.barSample, sample);
      if (mapping) {
        entry.barMapping = mapping;
      } else if (entry.barMapping) {
        // Same position, new thumb reading: RESYNC the reference point, keep the fitted slope.
        entry.barMapping = { ...entry.barMapping, refOffset: sample.offset, refHandleY: sample.handleY };
      }
    }
    entry.barSample = sample;
  }

  // Lead the scrollbar thumb by the same delta the content is leading by, so the bar never reads a position the
  // player has already scrolled past. Inert until the mapping is known (no guessed formula, no wrong thumb).
  function syncBar(entry: ScrollEntry, target: EagerScrollTarget, contentDelta: number): void {
    const bar = target.bar;
    if (!bar) {
      if (entry.wroteBarId !== null) {
        writeOffset(entry.wroteBarId, 0);
        entry.wroteBarId = null;
      }
      return;
    }
    if (!entry.barMapping) {
      // Still learning. Refresh the reference sample while the content is at rest relative to the bar so the FIRST
      // settle after a scroll can fit the line.
      if (Math.abs(contentDelta) < SETTLE_EPS_PX) {
        noteBarSample(entry, target);
      }
      return;
    }
    const wantY = barHandleYFor(entry.barMapping, entry.eagerY);
    entry.wroteBarId = bar.id;
    writeOffset(bar.id, wantY - bar.handleY);
  }

  function reset(): void {
    for (const entry of entries.values()) {
      clearEntryWrites(entry);
    }
    entries.clear();
    panId = null;
    panMode = null;
    panPending = false;
  }

  function dispose(): void {
    disposed = true;
    if (frameHandle && caf) {
      caf(frameHandle);
    }
    frameHandle = 0;
    reset();
  }

  return {
    wheel,
    beginPan,
    beginBarPan,
    panTo,
    endPan,
    panActive,
    panMode: () => panMode,
    compensate,
    afterReconcile,
    noteScrollAck,
    reset,
    __entryForTest: (id: string) => {
      const entry = entries.get(id);
      return entry ? { phase: entry.phase, eagerY: entry.eagerY } : null;
    },
    __authorityForTest: (id: string) => {
      const entry = entries.get(id);
      return entry
        ? {
            authoredY: entry.authoredY,
            ackedY: entry.ackedY,
            requestId: entry.authoredRequestId,
            resent: entry.resent
          }
        : null;
    },
    __frameForTest: runFrame,
    dispose
  };
}
