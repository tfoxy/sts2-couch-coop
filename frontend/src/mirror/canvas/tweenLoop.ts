// THE CANVAS MIRROR'S ANIMATION EVALUATOR — every moving thing on screen, as pure state + math.
//
// The DOM mirror does not animate: it DELEGATES. A tween becomes a CSS `transition` on an element, a card flight
// becomes a WAAPI keyframe animation, a pinned loop becomes a CSS `@keyframes` rule with a negative delay. The
// browser owns the clock, the interpolation and the compositing, and `mirrorRenderer` owns only the bookkeeping
// around them (which channel is armed until when, which streamed value the pin overrode, which node is latched
// hidden). A single-canvas renderer has no element to delegate to, so it has to compute every frame itself — and
// this module is the whole of that computation, with no DOM in it at all.
//
// It is deliberately STANDALONE: the renderer that will drive it does not exist yet, so the contract is consumed
// blind. Everything the caller needs is here, and every deviation from the DOM path's behaviour is called out
// where it is made.
//
// WHAT IT OWNS
// ------------
//   * TWEEN CHANNELS. Three per node (`transform`, `opacity`, `selfOpacity`), armed independently and expiring
//     independently — a fade routinely outlives the move it started with. Godot's own easing equations
//     (`godotEaseSample`, gsw) rather than a cubic-bezier fit, because we are computing the number, not asking
//     the compositor to approximate a curve.
//   * TRANSFORM INTERPOLATION with CSS's semantics: decompose both endpoints ONCE at arm, lerp the components,
//     recompose per sample (see matrixLerp.ts, including the singular-2×2 discrete fallback).
//   * THE PIN. While a channel is armed the streamed value is IGNORED — but not forgotten: a hint is ONE-WAY (the
//     producer's cancel un-pins the PRODUCER; there is no wire field that aborts the client), so the client
//     replays to its own deadline and applies the overridden pose AT the settle. Only a value that genuinely
//     CHANGED counts: a merely-suppressed node ships no transform at all, and replaying its retained pre-tween
//     pose would teleport the card back to where the approach started.
//   * THE HIDE-LATCH. A fade that settles at ~0 is a disappear, and the producer ships one "resting alpha +
//     visible" drain before the hide — a 1-frame reappear flash. The latch holds the node at 0 through a 400 ms
//     grace, with the full cancel matrix (removal / display-gone, stage rebuild, a new arm, the producer itself
//     reaching ~0, an incoming value that is NOT the resting signature) plus the 150 ms held-restore self-heal for
//     the hint-less re-show that looks value-identical to the flash.
//   * CARD FLIGHTS, evaluated from `cardFlight.ts`'s CLOSED FORM at `t = now − start` (never the stepped Euler
//     integrator — the closed form is frame-rate independent and is what the compositor path already uses), with
//     the discard kind's sequential rotation CHASE stepped by wall-clock dt.
//   * PINNED LOOPS, as a PHASE. See `applyPinnedLoop` for why this module stops at the phase.
//
// WHAT IT DOES NOT OWN
// --------------------
//   * Time. Every entry point takes `nowMs`; nothing here reads `Date.now`/`performance.now`. That is what makes
//     the whole thing deterministic under test and lets the caller drive it from one clock read per frame.
//   * Scheduling. The caller owns the rAF/timer; this module answers "what does this node look like now" and
//     "when do you next need me" (`nextDeadline`), nothing more.
//   * Geometry. Endpoints arrive as GLOBAL 6-tuples, already lifted through their parent chain and already
//     carrying the wide-screen spread shift the endpoint's own X claims. See tweenPlan.ts.
//   * The pinned loops' VOCABULARY (what a phase of 0.25 does to a node's pixels). That is
//     `@spirectl/presentation`'s, expressed as CSS keyframes; restating it here as numbers would be a
//     CouchCoop-local copy of a reusable renderer's contract. This module supplies the phase, the deadline and the
//     de-lockstepping; the wave that wires the canvas up needs a numeric evaluator for those shapes, and it
//     belongs upstream, not here.
//
// DEMAND-DRIVEN, AND WHY THAT IS THE POINT. The Aug-26 concurrency probe (docs/agents/canvas-stage-probes-aug26.md
// §P8) replayed eight recordings: six never exceed 6 concurrent animations and are idle for more than 90% of their
// span — a combat animates for 3.3 of 30 seconds. The one sizing case is a reshuffle at 46 concurrent tweens + 30
// concurrent flights (78 combined), of which 124 of 137 hints are `modulate:a`. So: `nextDeadline()` returns
// Infinity the moment nothing is armed (the caller parks completely), every sweep is O(active) and not O(scene) —
// `noteStreamedValue` fast-outs on a node the loop has never heard of, which is what lets the caller feed it
// everything it paints — and the alpha channels never touch the matrix math.
//
// THE FRAME CONTRACT
// ------------------
//     for (const id of loop.activeIds()) {
//       const mask = loop.sampleInto(id, t6, alphas, now);   // what is animated, and to what
//       ...paint...
//     }
//     const due = loop.advance(now);                          // expire, prune, and tell me when to wake
//
// `sampleInto` and `advance` both refresh the node they touch, so the two orders give the same values at the same
// `nowMs`. Samples must be taken in NON-DECREASING `nowMs` (a discard flight's rotation is a chase over the frame
// sequence, not a function of `t`).

import {
  cardFlightGlobal6Into,
  cardFlightPoseAt,
  cardFlightTiming,
  smoothAngleStep,
  FLIGHT_MAX_STEP_SECONDS,
  FLIGHT_ROTATION_SMOOTH_RATE,
  type CardFlightTiming
} from "@/mirror/cardFlight";
import {
  createDecomposedMatrix,
  decomposeMatrixInto,
  lerpDecomposedInto,
  matrix6Equal,
  type DecomposedMatrix
} from "@/mirror/canvas/matrixLerp";
import { MIRROR_DESIGN_WIDTH, type MirrorCardFlightHint } from "@/mirror/sceneTree";
import {
  HIDE_LATCH_ALPHA_EPS,
  type OpacityChannel,
  type TweenChannel,
  type TweenLoopHint
} from "@/mirror/canvas/tweenPlan";
import { godotEaseSample } from "@godot-scene-web/effects/easing";
import type { PresentationAnimationBinding } from "@spirectl/presentation/render";
import { pinnedLoopAnchorsToDocument, pinnedLoopBinding } from "@/mirror/animAttributes";

export type { OpacityChannel, TweenChannel, TweenLoopHint } from "@/mirror/canvas/tweenPlan";

// ---- the hide-latch constants, verbatim from mirrorRenderer -----------------------------------------------------
// Copies rather than imports on purpose: mirrorRenderer does not export them, and this module must be importable
// without dragging a 17k-line DOM renderer (and a `document`) into the graph. The specs assert the observable
// behaviour these produce, which is the coupling that actually matters.

/** How long the latch clamps a settled-to-zero node's opacity while the producer's pre-hide drain passes. */
export const HIDE_LATCH_GRACE_MS = 400;
/** Tolerance on "the incoming alpha IS the pre-fade resting one" — the signature match that identifies the flash. */
export const HIDE_LATCH_RESTING_EPS = 0.02;
/**
 * The held-restore self-heal window. A latch that has been clamping a RESTING-valued write for this long with no
 * hide catching up was never a flash: it is a genuine, hint-less re-show (the rest-site refocus / first click),
 * and nothing further will arrive to un-stick it. Release, and hand the clamped value back.
 */
export const HIDE_LATCH_HELD_RESTORE_MS = 150;

export { HIDE_LATCH_ALPHA_EPS };

// ---- sample results ---------------------------------------------------------------------------------------------

/** Bit flags returned by `sampleInto`: which of the caller's out-params were written. */
export const SAMPLE_NONE = 0;
export const SAMPLE_TRANSFORM = 1;
export const SAMPLE_OPACITY = 2;
export const SAMPLE_SELF_OPACITY = 4;
/**
 * A node's PAINT SOURCE changed — its texture url, its atlas region or its margins — with its pose untouched.
 *
 * NOT written by `sampleInto`, and deliberately declared here anyway: the mask is the renderer's shared vocabulary
 * for "what did this frame move", and the one writer (`canvasRenderer.tickIntents`, whose intent glyph swaps a
 * source rect) needs a bit that says what it actually did. It had been folding into {@link SAMPLE_TRANSFORM},
 * which made every glyph frame call itself a moved transform and put a source swap in the tier that patches poses.
 * Splitting it costs one bit and buys two true counters — the transform tier can now refuse a source change BY
 * NAME rather than by borrowing a word that means something else.
 */
export const SAMPLE_SOURCE = 8;
/**
 * A LOCAL ANIM moved a pose — the browser-side idle vocabulary (`idleAnim.ts`), not a tween.
 *
 * Its own bit for the same reason {@link SAMPLE_SOURCE} has one, and here the distinction is the whole feature: a
 * local anim enters the walk at `ownDraw`/`gRaw` and never reaches `gGame`, which is exactly what makes it
 * patchable in place when a tween is not. Folded into {@link SAMPLE_TRANSFORM} the two were one number, and the
 * transform tier could neither claim the frames it can answer nor size the ones it cannot.
 */
export const SAMPLE_LOCAL_ANIM = 16;
export type SampleMask = number;

/** Index of the ELEMENT alpha in `sampleInto`'s `outAlphas`. */
export const ALPHA_OPACITY = 0;
/** Index of the node's OWN-PAINT alpha in `sampleInto`'s `outAlphas`. */
export const ALPHA_SELF_OPACITY = 1;

// ---- pinned loops -----------------------------------------------------------------------------------------------

/**
 * A declarative infinite animation the producer pinned to rest and named on the wire (`MirrorNode.pinnedLoopAnim`),
 * or one of the path-keyed folds the headless instance freezes game-side (`nodeAnimBinding`). Reduced to the two
 * things the SCHEDULER needs — a period and a phase — plus where the phase is anchored.
 */
export interface PinnedLoopSpec {
  periodMs: number;
  /** Per-node phase offset, ms, in [0, periodMs). What de-locksteps a fleet of otherwise identical loops. */
  phaseMs: number;
  /**
   * `"document"` phases the loop against the shared clock origin, so a node re-styled (or built late) lands back
   * on the SAME point of the cycle it would otherwise have been on. `"apply"` starts the cycle where it is
   * applied, which is right only when the game's own start instant is known — see `pinnedLoopAnchorsToDocument`
   * (the end-turn glow is the one such token: its cycle ENDS at opacity 0, so anchoring it would let a glow that
   * just turned on appear invisible and then pop).
   */
  anchor: "document" | "apply";
  /**
   * Whether the node is on screen. A loop is the only genuinely always-on animation source, so an invisible one
   * must not hold the whole scheduler at per-frame — see `nextDeadline`.
   */
  visible: boolean;
}

/**
 * A `PinnedLoopSpec` from a presentation animation binding. Works for BOTH families the mirror replays: the
 * wire-named pinned loops (`pinnedLoopBinding`) and the path-keyed frozen folds (`nodeAnimBinding`), because both
 * express their cycle as `durationMs` plus an optional `delayMs`.
 *
 * `phaseMsOverride` is for the ONE loop whose phase is not carried by the binding: the enemy-intent bob, whose
 * offset comes from the node's baked global X so a row of intents bobs as a WAVE (see `bobPhaseMs`).
 */
export function loopSpecFromBinding(
  binding: PresentationAnimationBinding,
  options: { visible?: boolean; anchor?: "document" | "apply"; phaseMsOverride?: number } = {}
): PinnedLoopSpec | null {
  const periodMs = binding.durationMs ?? 0;
  if (!(periodMs > 0)) {
    return null;
  }
  const phaseMs = options.phaseMsOverride ?? binding.delayMs ?? 0;
  return {
    periodMs,
    phaseMs: ((phaseMs % periodMs) + periodMs) % periodMs,
    anchor: options.anchor ?? "document",
    visible: options.visible !== false
  };
}

/**
 * The `PinnedLoopSpec` for a wire token on a given node, or null for an unknown token (forward-compatible: an
 * older client simply renders the node at the rest pose the producer pinned it to).
 *
 * The per-node phase comes from the binding's own `delayMs`, which `pinnedLoopBinding` already fills with the
 * node-id hash for every token that wants one — and deliberately LEAVES OUT for the end-turn glow, whose real
 * start instant is known. Re-deriving it here would put a phase back on the one loop that must not have one.
 */
export function pinnedLoopSpecFor(
  token: string,
  nodeId: string,
  options: { visible?: boolean } = {}
): PinnedLoopSpec | null {
  const binding = pinnedLoopBinding(token, nodeId, 0, 0);
  if (!binding) {
    return null;
  }
  return loopSpecFromBinding(binding, {
    visible: options.visible,
    anchor: pinnedLoopAnchorsToDocument(token) ? "document" : "apply"
  });
}

/**
 * The enemy-intent BOB's per-node phase, in ms — `mirrorRenderer.bobPhaseMs`, verbatim.
 *
 * The game offsets each intent's bob sine by its index (`i·0.3` rad on a 2000 ms period); intents lay out
 * left-to-right, so the node's baked global X stands in for that index. Adjacent icons ~100 px apart land ~104 ms
 * apart, close to the game. The three leaves of ONE intent share ~the same X, so they stay mutually in sync — and
 * because it is a function of the pose and not of mount time, an element built late lands in phase.
 */
export function bobPhaseMs(periodMs: number, globalTx: number, designWidth = MIRROR_DESIGN_WIDTH): number {
  const period = periodMs || 2000;
  return ((((globalTx / designWidth) * period) % period) + period) % period;
}

// ---- options ----------------------------------------------------------------------------------------------------

export interface TweenLoopOptions {
  /**
   * The wall clock the `"document"` loop timeline is anchored at. Any fixed value works (the phase is a modulo);
   * pass the same origin for the page's whole life so a loop never jumps. Default 0.
   */
  clockOriginMs?: number;
  /**
   * WHO OWNS A VISIBLE LOOP'S CADENCE (R4). `"frame"` — the default, and every pre-R4 caller — makes a visible
   * pinned loop publish `nowMs` from `nextDeadline`, i.e. "wake me next display frame", which is the only honest
   * answer for a source with no endpoint when the loop IS the animator.
   *
   * `"caller"` says the caller drives the loops itself and is publishing its OWN deadline for them, so this
   * module should stay silent about them and let the scheduler park between idle frames. That is what makes an
   * fps cap on the idle family expressible at all: routed through this source, a capped loop would still book an
   * unconditional rAF every frame (see `armAnimation`'s tween rule, which cannot sleep on a tween deadline).
   *
   * NOTHING ELSE MOVES. The loop still runs, `loopPhase` still answers, `applyPinnedLoop` still registers, and a
   * node whose ONLY liveness was its loop still stays in the map. This flag decides one branch of one function.
   */
  loopDeadline?: "frame" | "caller";
  /**
   * The node's CURRENT global transform, for an arm with no declared start. Write into `out` and return true;
   * return false when the node has no transform-based pose. Consulted only at arm time, and only when the channel
   * is not already running — a re-arm continues from the live sample, which is what stops a mid-flight re-target
   * teleporting.
   */
  currentTransform?: (nodeId: string, out: number[]) => boolean;
  /**
   * R5 T-DR4 — MAY THIS FLIGHT DRIVE ITS COMET ROOT? Answered by the renderer, per flight, at arm time.
   *
   * ABSENT MEANS NO, and that is the contract: without it this module behaves exactly as it did before the
   * drive existed, so every spec that predates it is untouched by construction.
   *
   * The renderer's answer determines whether the root actually streams a transform of its own. A root that streams
   * none carries no placement, so its
   * children compose against the frame ABOVE it; driving it would apply the flight's pose to them twice. (That
   * is the DOM path's own guard, at `mirrorRenderer.writeTrailRootTransform`.)
   */
  canDriveTrailRoot?: (rootId: string) => boolean;
  /** The node's CURRENT painted alpha on a channel, for an arm with no declared start. Null ⇒ unknown. */
  currentOpacity?: (nodeId: string, channel: OpacityChannel) => number | null;
  /**
   * Instrumentation seam: called once per node the loop actually touches in a sweep. The probe that a sweep is
   * O(active) and not O(scene) — a spec can assert the count against `activeCount()` rather than timing anything.
   */
  onNodeVisited?: (nodeId: string) => void;
}

// ---- internal state ---------------------------------------------------------------------------------------------

interface TransformChannel {
  from: DecomposedMatrix;
  to: DecomposedMatrix;
  /** The armed endpoint, retained so the settle can tell a real catch-up from a re-derivation of the endpoint. */
  endpoint: number[];
  t0: number;
  until: number;
  durationMs: number;
  ease: string | null;
  trans: string | null;
  /** The wire `group` that ties one Godot tween's channels together. Retained, like `record.tweenGroup`. */
  group: string | null;
  /**
   * PIN CATCH-UP baseline: what a streamed pose's freshness is measured against. Seeded at the arm of a VIRGIN
   * channel (the declared start, else the live pose — "the pose the client is being told to treat as current"); a
   * RE-ARM keeps whatever the pin has been tracking, because the new endpoint was recomputed from the holder's
   * live pose and anything stashed so far is already accounted for in it.
   */
  pinBaseline: number[] | null;
  /** The fresh streamed pose the pin overrode, waiting for the settle. Null = nothing to catch up on. */
  pinCatchup: number[] | null;
}

interface AlphaChannel {
  from: number;
  to: number;
  t0: number;
  until: number;
  durationMs: number;
  ease: string | null;
  trans: string | null;
  group: string | null;
}

interface FlightState {
  hint: MirrorCardFlightHint;
  timing: CardFlightTiming;
  startMs: number;
  /**
   * When the PIN is released — the end of the producer's suppression window, NOT the end of the animation.
   * Between the card landing and the window closing the node's streamed transform is still the frozen pre-flight
   * one, so releasing early would teleport a vanished card back to the pile for a frame.
   */
  pinUntil: number;
  /** The discard chase's carried angle (and the degenerate-tangent carry for a shuffle). */
  rotation: number;
  lastSampleMs: number;
}

interface LoopState extends PinnedLoopSpec {
  /** The `"apply"` anchor's origin. Unused (and meaningless) for the `"document"` anchor. */
  appliedAtMs: number;
}

interface NodeState {
  id: string;
  transform: TransformChannel | null;
  opacity: AlphaChannel | null;
  selfOpacity: AlphaChannel | null;
  flight: FlightState | null;
  /**
   * R5 T-DR4 — this node is a comet ROOT following the flight owned by the card with this id. Null for every
   * other node in the map, which is all of them but one per flight.
   */
  flightRootOf: string | null;
  /** …and whether that follow has actually produced a pose yet, so the counter counts FLIGHTS and not frames. */
  flightRootDriven: boolean;
  loop: LoopState | null;
  // --- hide-latch (element `opacity` channel only) ---
  hideLatchedUntil: number;
  hideLatchRestingSig: number | null;
  hideLatchHeldAt: number;
  hideLatchStreamedOpacity: number | null;
  // --- the last STREAMED values, while no channel owns them (the DOM path's style cache) ---
  lastStreamedTransform: number[] | null;
  lastStreamedOpacity: number | null;
  lastStreamedSelfOpacity: number | null;
  // --- values a settle produced that the caller has not been handed yet. Delivered ONCE by `sampleInto`. ---
  pendingTransform: number[] | null;
  pendingOpacity: number | null;
  pendingSelfOpacity: number | null;
  /** A pending that has already survived one `advance` — see `advance` for the bound this puts on a bad caller. */
  pendingStale: boolean;
}

function createNodeState(id: string): NodeState {
  return {
    id,
    transform: null,
    opacity: null,
    selfOpacity: null,
    flight: null,
    flightRootOf: null,
    flightRootDriven: false,
    loop: null,
    hideLatchedUntil: 0,
    hideLatchRestingSig: null,
    hideLatchHeldAt: 0,
    hideLatchStreamedOpacity: null,
    lastStreamedTransform: null,
    lastStreamedOpacity: null,
    lastStreamedSelfOpacity: null,
    pendingTransform: null,
    pendingOpacity: null,
    pendingSelfOpacity: null,
    pendingStale: false
  };
}

// ---- the public handle ------------------------------------------------------------------------------------------

export interface TweenLoop {
  /**
   * Arm every channel in `hints` at `nowMs`. PRIME AND ARM COLLAPSE HERE: the DOM path has to prime the element
   * to the declared start, let the browser commit it, and only then write the endpoint (that commit is the
   * transition's implicit "from", and getting it wrong costs a forced reflow or a 1-frame flash) — so it defers
   * its arms a whole frame and holds the channel meanwhile. A computed animation has no implicit "from" to
   * publish: the start is simply the channel's `from`, recorded now. There is therefore no prime, no reflow, no
   * deferral and no prime-pin grace, and a hint's full declared duration runs from `nowMs`.
   *
   * `from` is, in order: the hint's declared start; the channel's CURRENT sample if it is already running (what
   * makes a mid-flight re-target continue from where it had reached instead of teleporting); the caller's
   * `currentTransform`/`currentOpacity` resolver; the last value fed to `noteStreamedValue`; and finally the
   * endpoint itself — which collapses the tween to no motion, exactly as a start-less hint against an
   * already-folded near-final value collapses on the DOM path.
   *
   * Every 6-tuple handed in is COPIED; the caller may reuse its arrays freely.
   */
  applyHints(hints: readonly TweenLoopHint[], nowMs: number): void;

  /**
   * Arm one card flight per hint. The flight OWNS its target's transform channel until `pinUntil`
   * (`nowMs + hint.windowMs`) and supersedes any tween on it — it re-derives the pose from its own curve every
   * frame, so it is the authority while it runs and opts out of the pin catch-up entirely.
   */
  applyFlights(hints: readonly MirrorCardFlightHint[], nowMs: number): void;

  /** Attach (or, with `spec` null, detach) a pinned loop. Re-applying an EQUAL spec never restarts the cycle. */
  applyPinnedLoop(nodeId: string, spec: PinnedLoopSpec | null, nowMs: number): void;

  /**
   * Feed the evaluator a value the scene stream just produced.
   *
   * For `"transform"` this is pure bookkeeping: while a pin owns the channel it records what the pin is
   * overriding (only a CHANGED value counts — see `TransformChannel.pinBaseline`), and otherwise it caches the
   * pose an un-declared arm will start from.
   *
   * For the alpha channels it RETURNS THE VALUE THE CALLER SHOULD PAINT, because the hide-latch clamps a write on
   * a channel the loop does not otherwise own: a resting-alpha restore arriving inside the latch's grace comes
   * back as 0. Everything else comes back unchanged. (While a channel IS owned, `sampleInto` is the authority and
   * this return is irrelevant.)
   */
  noteStreamedValue(nodeId: string, channel: "transform", value: readonly number[], nowMs: number): void;
  noteStreamedValue(nodeId: string, channel: OpacityChannel, value: number, nowMs: number): number;

  /**
   * What this node's animated paint is RIGHT NOW. Writes the global transform 6-tuple into `outTransform6` and
   * the two alphas into `outAlphas` (indices `ALPHA_OPACITY` / `ALPHA_SELF_OPACITY`); the returned mask says which
   * of them were written — anything unset is not animated and the caller keeps its streamed value.
   *
   * Allocation-free, and idempotent for a given `nowMs`.
   *
   * A SETTLE PUBLISHES ITS FINAL VALUE HERE, exactly once — the pin catch-up when the producer contradicted the
   * endpoint, the endpoint itself when it did not, the end alpha of a fade, and the hide-latch's held-restore.
   * The caller MUST write that value into its own node state: the DOM path leaves the final value on the element
   * simply by never rewriting it, but a canvas repaints from the caller's state, so a settle that published
   * nothing would let the node's frozen pre-tween value paint the instant the pin lifted.
   */
  sampleInto(nodeId: string, outTransform6: number[], outAlphas: number[], nowMs: number): SampleMask;

  /** The node's loop phase in [0, 1), or -1 when it has none. */
  loopPhase(nodeId: string, nowMs: number): number;

  /** The wire `group` a node's channel was armed under, or null. Retained for the caller; never read here. */
  channelGroup(nodeId: string, channel: TweenChannel): string | null;

  /**
   * The per-frame sweep: expire every elapsed channel, arm/release the hide-latches, drop the nodes that have
   * gone inert. Returns the earliest deadline still live — which is what the caller parks on. O(active).
   */
  advance(nowMs: number): number;

  /** The earliest live deadline, WITHOUT mutating. `Infinity` = nothing armed, park completely. */
  nextDeadline(nowMs: number): number;

  /**
   * Whether a transient tween/flight/settle needs every display frame NOW.
   * Pinned loops and a future release remain deadlines, not urgent motion.
   */
  hasPerFrameDemand(nowMs: number): boolean;

  /** The nodes the loop currently drives. Iterate THIS, never the scene. Safe to `sampleInto` while iterating. */
  activeIds(): IterableIterator<string>;
  activeCount(): number;

  /**
   * Is THIS NODE'S TRANSFORM the loop's right now — a running transform tween, or a card flight?
   *
   * The question a cosmetic offset has to ask before it composes anything on top of a node (see
   * `EagerScrollTarget.pinned`): while an animation owns the channel, its own pose is the truth and a second
   * writer would fight it every frame.
   *
   * Deliberately NARROWER than "is this node in `activeIds()`", which is the tempting proxy and the wrong one:
   * the loop also holds nodes whose only live channel is an ALPHA fade (a card grid dialog fading in owns no
   * transform at all), so the broad test would refuse to lead a scrollable that nothing is moving.
   */
  ownsTransform(nodeId: string): boolean;

  /**
   * The GLOBAL transform this node is HEADED FOR — written into `out6`, `true` when there is one.
   *
   * The question a client-side POSE READER has to ask before it trusts the streamed matrix: while a transform
   * channel is armed the producer suppresses the node's transform for the tween's whole window, so the streamed
   * answer is stale or absent and the endpoint is the only thing that says where the node is going. `handRaise`'s
   * focus ramp is the caller (see its `holderLocalY`); `mirrorRenderer.handHolderLocalY` is the DOM twin this
   * folds into one call.
   *
   * "GENUINELY LIVE" IS FOLDED IN, and that is the whole contract — a STALE endpoint must be unrepresentable:
   *   * a RUNNING channel answers its endpoint. `refreshNode` deletes an expired channel before anything reads it,
   *     so `node.transform !== null` already means "armed and not past its `until`" at this `nowMs`;
   *   * an UNCOLLECTED SETTLE (`pendingTransform`) answers too — the pin-catch-up twin of the DOM path's
   *     `record.tweenPinCatchup` leg. The settle has fired but the caller has not painted it yet, so the node's
   *     own state is still the frozen pre-tween pose and reading it would release a lift one frame EARLY. Read
   *     PURELY: the value is left in place for `sampleInto` to deliver, exactly once, as it always would;
   *   * a FLIGHT answers FALSE. A flight re-derives its pose from a closed-form curve every frame and has no
   *     endpoint to be headed for — a card mid-comet is not a fan card whose resting y means anything.
   * Everything else — no node, an alpha-only node, a settled-and-collected node — is `false`, and the caller keeps
   * whatever the producer is streaming.
   *
   * Takes `nowMs` because this module owns no clock (see the header): the caller passes the frame's one clock read.
   */
  transformEndpointInto(nodeId: string, out6: number[], nowMs: number): boolean;

  /**
   * The TIMING of the transform channel this node is running, or null when it is not running one.
   *
   * The endpoint's sibling, on exactly the same "genuinely live" rule (`refreshNode` first, a flight answers
   * null), and it exists for the reason the endpoint does: a client-side decoration that has to arrive WITH a
   * tween — the readable-hand raise, whose DOM twin re-writes the element's `transition` to the tween's own
   * `duration` and easing — cannot pick its own curve without knowing the one it is riding.
   *
   * Read-only and allocation-free at the call site is not worth a scratch object here: it is asked once per
   * raised holder per re-decide, not per node per frame. An UNCOLLECTED SETTLE has no timing left to ride (its
   * motion is over), so unlike the endpoint it answers null — the caller's own fallback is a teleport, which is
   * what a settled node wants.
   */
  transformChannelTiming(nodeId: string, nowMs: number): { durationMs: number; ease: string | null; trans: string | null } | null;

  /**
   * R5 T-DR4 — how many card flights have PLACED their comet root at least once (see `canDriveTrailRoot`).
   * Cumulative for the loop's life; a census row, not a per-frame number.
   */
  trailRootDrives(): number;

  /**
   * Forget everything about one node: the cancel-matrix entry for a removal, and for a node going display-gone.
   * Drops its channels, its flight, its loop AND its hide-latch, so a node that legitimately reappears is never
   * suppressed by a stale clamp.
   */
  releaseNode(nodeId: string): void;

  /**
   * Drop ONLY the transform channel, publishing nothing — the node goes back to painting what the producer
   * streams for it, from the very next frame.
   *
   * The cancel-matrix entry for a node that MOVED HOUSE while its channel was live. A `"local"`-space endpoint is
   * parent-relative and was lifted into a global under the parent the hint was written for; once the game
   * re-parents the node, that global says nothing about where the node belongs, and the producer has resumed
   * streaming its pose (only a card FLIGHT suppresses transforms). Both backends already refuse a hint whose
   * target moved house BEFORE the arm, for exactly this reason; this is the same refusal a frame later.
   *
   * Unlike a settle it publishes NO pending value: the endpoint is the answer that has just been invalidated, and
   * the streamed pose the caller already holds is the right one. Returns true when a channel was actually dropped.
   */
  releaseTransform(nodeId: string): boolean;

  /**
   * Cancel every in-flight hide-latch, keeping the tweens. The cancel-matrix entry for a STAGE REBUILD (a wire
   * `full: true` keyframe): the scene is being re-established, so a lingering clamp must not suppress a node that
   * legitimately comes back in the new screen.
   */
  clearHideLatches(): void;

  /** Drop all state. */
  reset(): void;
}

export function createTweenLoop(options: TweenLoopOptions = {}): TweenLoop {
  const clockOriginMs = options.clockOriginMs ?? 0;
  const loopDeadlineIsFrame = options.loopDeadline !== "caller";
  const readTransform = options.currentTransform;
  const readOpacity = options.currentOpacity;
  const onNodeVisited = options.onNodeVisited;
  const canDriveTrailRoot = options.canDriveTrailRoot;

  const nodes = new Map<string, NodeState>();

  /**
   * R5 T-DR4 — comet roots this loop has actually PLACED, counted once per flight rather than once per frame.
   *
   * The census needs it because every other trail number can read zero for a healthy screen: a flight is over
   * in a second and a half, and "the drive never ran" and "nothing has flown recently" would otherwise produce
   * the same row. It is also the T8 flip's evidence that the capability the client votes for is honoured.
   */
  let trailRootDrives = 0;

  // Scratch, never retained. The evaluator is sized for ~78 concurrent channels at display rate, which is exactly
  // where a fresh 6-tuple per sample turns into garbage.
  const scratch6: number[] = [0, 0, 0, 0, 0, 0];

  // ---- helpers --------------------------------------------------------------------------------------------------

  function nodeFor(id: string): NodeState {
    let node = nodes.get(id);
    if (!node) {
      node = createNodeState(id);
      nodes.set(id, node);
    }
    return node;
  }

  function copy6(src: readonly number[], out: number[]): number[] {
    out[0] = src[0];
    out[1] = src[1];
    out[2] = src[2];
    out[3] = src[3];
    out[4] = src[4];
    out[5] = src[5];
    return out;
  }

  function eased(
    ch: { t0: number; durationMs: number; ease: string | null; trans: string | null },
    now: number
  ): number {
    const raw = ch.durationMs > 0 ? (now - ch.t0) / ch.durationMs : 1;
    return godotEaseSample(ch.ease ?? undefined, ch.trans ?? undefined, raw);
  }

  function sampleTransformChannel(ch: TransformChannel, now: number, out: number[]): number[] {
    return lerpDecomposedInto(out, ch.from, ch.to, eased(ch, now));
  }

  function sampleAlphaChannel(ch: AlphaChannel, now: number): number {
    return ch.from + (ch.to - ch.from) * eased(ch, now);
  }

  function flightLanded(f: FlightState, now: number): boolean {
    return (now - f.startMs) / 1000 >= f.timing.totalSeconds;
  }

  /**
   * The LIVE flight this comet root is following, or null — which is also how a follower learns it is finished.
   *
   * The `pinUntil` test is not redundant with `flight !== null`: `advance` refreshes nodes in map order, so a
   * follower can be visited before the card whose flight has already expired. Reading the window directly makes
   * the answer independent of that order, which is the whole reason this is a function and not a field.
   */
  function liveFlightFor(node: NodeState, now: number): FlightState | null {
    if (node.flightRootOf === null) {
      return null;
    }
    const owner = nodes.get(node.flightRootOf);
    const flight = owner?.flight ?? null;
    return flight !== null && now < flight.pinUntil ? flight : null;
  }

  /**
   * `scaleOverride` is R5 T-DR4's one difference from the card's own sample: the comet root takes the flight's
   * POSITION and FACING at scale 1, never the card's pop/shrink. The ribbons carry their own authored widths,
   * so folding the card's scale in here would breathe the whole comet in and out with the card. (The DOM path
   * writes the same thing, at `mirrorRenderer.writeTrailRootTransform`.)
   */
  function sampleFlight(f: FlightState, now: number, out: number[], scaleOverride?: number): number[] {
    const t = Math.max(0, (now - f.startMs) / 1000);
    const pose = cardFlightPoseAt(f.hint, f.timing, t, f.rotation);
    if (f.hint.kind === "discard") {
      // SEQUENTIAL, not memoryless. `cardFlightPoseAt` returns the facing a discard is CHASING, never the angle it
      // has reached — the chase depends on the whole sequence of frames before it, so the angle is stepped here by
      // this frame's own wall-clock gap. The dt is CLAMPED for the same reason the stepped integrator clamps it: a
      // backgrounded tab's first frame back would otherwise close the entire angle gap in one step, which is
      // precisely the first-frame snap this kind exists to avoid.
      const dt = Math.min(Math.max(0, (now - f.lastSampleMs) / 1000), FLIGHT_MAX_STEP_SECONDS);
      f.rotation = smoothAngleStep(f.rotation, pose.rotation, FLIGHT_ROTATION_SMOOTH_RATE, dt);
      pose.rotation = f.rotation;
    } else {
      f.rotation = pose.rotation;
    }
    f.lastSampleMs = now;
    return cardFlightGlobal6Into(out, f.hint.basis, pose, scaleOverride ?? pose.scale);
  }

  function isInert(node: NodeState): boolean {
    return (
      node.transform === null &&
      node.opacity === null &&
      node.selfOpacity === null &&
      node.flight === null &&
      node.flightRootOf === null &&
      node.loop === null &&
      node.hideLatchedUntil === 0 &&
      node.pendingTransform === null &&
      node.pendingOpacity === null &&
      node.pendingSelfOpacity === null
    );
  }

  /**
   * Expire whatever `now` has passed on ONE node. Idempotent — every entry point calls it before reading, so the
   * caller cannot observe a stale channel by asking in an unlucky order.
   *
   * This is `tickTweens`' loop body, minus the DOM writes and plus the two "pending" hand-offs that replace them.
   */
  function refreshNode(node: NodeState, now: number): void {
    onNodeVisited?.(node.id);

    const tf = node.transform;
    if (tf !== null && now >= tf.until) {
      node.transform = null;
      // PIN CATCH-UP: hand back the fresh pose the pin overrode instead of dropping it. The channel is released
      // above, so this lands INSTANTLY — the same reason the DOM path recomposes the transition BEFORE writing the
      // catch-up (writing it under a still-live `transform 884ms …` would start a whole new 884 ms transition).
      //
      // And with nothing to catch up on, the ENDPOINT is the final value — which still has to be published. The
      // DOM path leaves it on the element (and in the style cache) simply by never rewriting it, whereas a canvas
      // repaints from the caller's own node state, so a settle that published nothing would let the frozen
      // pre-tween pose paint the instant the pin lifted: the very teleport the catch-up exists to prevent.
      const catchup = tf.pinCatchup;
      node.pendingTransform = catchup !== null && !matrix6Equal(catchup, tf.endpoint) ? catchup : tf.endpoint;
      node.pendingStale = false;
    }

    const op = node.opacity;
    if (op !== null && now >= op.until) {
      // HIDE-LATCH ARM: a fade that SETTLES at ~0 with a captured resting signature is a disappear.
      if (node.hideLatchRestingSig !== null && op.to <= HIDE_LATCH_ALPHA_EPS) {
        node.hideLatchedUntil = now + HIDE_LATCH_GRACE_MS;
      }
      node.opacity = null;
      node.pendingOpacity = op.to; // the final alpha, for the reason above
      node.pendingStale = false;
    }

    const self = node.selfOpacity;
    if (self !== null && now >= self.until) {
      node.selfOpacity = null;
      node.pendingSelfOpacity = self.to;
      node.pendingStale = false;
    }

    // HELD-RESTORE SELF-HEAL: the latch has been clamping a resting-valued re-show for HIDE_LATCH_HELD_RESTORE_MS
    // with no hide catching up, and NO further delta is coming to un-stick it (that is the whole defect). Release
    // and hand the clamped value back.
    if (
      node.hideLatchedUntil !== 0 &&
      node.hideLatchHeldAt !== 0 &&
      now - node.hideLatchHeldAt >= HIDE_LATCH_HELD_RESTORE_MS
    ) {
      node.hideLatchedUntil = 0;
      node.hideLatchHeldAt = 0;
      node.hideLatchRestingSig = null;
      const streamed = node.hideLatchStreamedOpacity;
      node.hideLatchStreamedOpacity = null;
      if (streamed !== null) {
        node.pendingOpacity = streamed;
        node.pendingStale = false;
      }
    }

    // The 400 ms grace, expired. The DOM path clears this lazily on the next write that finds it stale; clearing
    // it here too is observationally identical (a write past the grace writes through either way) and is what lets
    // an otherwise-inert node be pruned instead of held forever. Skipped while a HELD-RESTORE clock is running, so
    // a re-show held past the grace still self-heals rather than being silently dropped.
    if (node.hideLatchedUntil !== 0 && node.hideLatchHeldAt === 0 && now >= node.hideLatchedUntil) {
      node.hideLatchedUntil = 0;
      node.hideLatchStreamedOpacity = null;
    }

    // The flight's pin release publishes NOTHING, unlike a tween settle: the producer has re-emitted the node's
    // settled transform by now (the window is sized so the pin lifts one frame after that re-emit), and the DOM
    // path likewise writes nothing here — it simply stops overriding. Publishing the landed pose would be a card
    // that has already vanished insisting on one more frame.
    if (node.flight !== null && now >= node.flight.pinUntil) {
      node.flight = null;
    }

    // …and the COMET ROOT following it lets go at the same instant, publishing nothing for the same reason: the
    // producer has resumed placing the root by now (the window is sized so the pin lifts one frame after that),
    // and a landed comet insisting on one more frame would be a flight that has already vanished re-asserting
    // itself. The renderer drops the override when the sample stops reporting one.
    if (node.flightRootOf !== null && liveFlightFor(node, now) === null) {
      node.flightRootOf = null;
      node.flightRootDriven = false;
    }
  }

  // ---- arming ---------------------------------------------------------------------------------------------------

  /** Resolve the `from` a transform arm starts at. See `applyHints`' doc for the order and why. */
  function resolveTransformFrom(
    node: NodeState,
    hint: TweenLoopHint,
    now: number,
    out: number[]
  ): readonly number[] {
    if (hint.startTransform && hint.startTransform.length === 6) {
      return hint.startTransform;
    }
    if (node.transform !== null) {
      return sampleTransformChannel(node.transform, now, out);
    }
    if (node.flight !== null) {
      return sampleFlight(node.flight, now, out);
    }
    if (readTransform && readTransform(node.id, out)) {
      return out;
    }
    if (node.lastStreamedTransform !== null) {
      return node.lastStreamedTransform;
    }
    return hint.endTransform as readonly number[];
  }

  function resolveAlphaFrom(
    node: NodeState,
    hint: TweenLoopHint,
    channel: OpacityChannel,
    now: number
  ): number {
    if (hint.startOpacity !== null) {
      return hint.startOpacity;
    }
    const live = channel === "opacity" ? node.opacity : node.selfOpacity;
    if (live !== null) {
      return sampleAlphaChannel(live, now);
    }
    const resolved = readOpacity?.(node.id, channel);
    if (resolved !== null && resolved !== undefined) {
      return resolved;
    }
    const cached = channel === "opacity" ? node.lastStreamedOpacity : node.lastStreamedSelfOpacity;
    if (cached !== null) {
      return cached;
    }
    return hint.endOpacity as number;
  }

  function armTransform(node: NodeState, hint: TweenLoopHint, now: number): void {
    const end = hint.endTransform;
    if (!end || end.length !== 6) {
      return;
    }
    if (node.flight !== null) {
      // A live flight IS this channel: the DOM path's per-frame `writeCardFlightTransform` overwrites the pin (and
      // its deadline) again on the very next frame, so a tween armed underneath one is erased rather than queued.
      // Dropping it here says the same thing without letting an invisible channel pop in when the pin lifts.
      return;
    }
    const virgin = node.transform === null;
    const from = resolveTransformFrom(node, hint, now, scratch6);
    let ch = node.transform;
    if (ch === null) {
      ch = {
        from: createDecomposedMatrix(),
        to: createDecomposedMatrix(),
        endpoint: [0, 0, 0, 0, 0, 0],
        t0: now,
        until: now,
        durationMs: hint.durationMs,
        ease: hint.ease,
        trans: hint.trans,
        group: hint.group,
        pinBaseline: null,
        pinCatchup: null
      };
      node.transform = ch;
    }
    // Decompose ONCE per endpoint, here. Both are constants for the tween's life, and the per-sample cost is then
    // six lerps and a recompose rather than two square roots and two atan2s.
    decomposeMatrixInto(ch.from, from);
    decomposeMatrixInto(ch.to, end);
    copy6(end, ch.endpoint);
    ch.t0 = now;
    ch.until = now + hint.durationMs;
    ch.durationMs = hint.durationMs;
    ch.ease = hint.ease;
    ch.trans = hint.trans;
    ch.group = hint.group;
    if (virgin) {
      // The declared start IS the pose the client is being told to treat as current; with no declared start it is
      // whatever the node was last painted at. Either way, that is the baseline a later streamed pose is judged
      // "fresh" against.
      ch.pinBaseline = copy6(from, [0, 0, 0, 0, 0, 0]);
    }
    // A RE-ARM clears the pending catch-up: the new endpoint was recomputed from the holder's LIVE pose, so
    // replaying the stash on top of it would undo exactly the travel the producer just accounted for.
    ch.pinCatchup = null;
    node.pendingTransform = null;
  }

  function armAlpha(node: NodeState, hint: TweenLoopHint, channel: OpacityChannel, now: number): void {
    if (hint.endOpacity === null) {
      return;
    }
    const from = resolveAlphaFrom(node, hint, channel, now);
    const existing = channel === "opacity" ? node.opacity : node.selfOpacity;
    const ch: AlphaChannel = existing ?? {
      from,
      to: hint.endOpacity,
      t0: now,
      until: now,
      durationMs: hint.durationMs,
      ease: hint.ease,
      trans: hint.trans,
      group: hint.group
    };
    ch.from = from;
    ch.to = hint.endOpacity;
    ch.t0 = now;
    ch.until = now + hint.durationMs;
    ch.durationMs = hint.durationMs;
    ch.ease = hint.ease;
    ch.trans = hint.trans;
    ch.group = hint.group;
    if (channel === "opacity") {
      node.opacity = ch;
      // CANCEL MATRIX — a new opacity tween on the node supersedes any pending latch, and re-arms the signature
      // the NEXT settle will match the producer's restore against.
      node.hideLatchedUntil = 0;
      node.hideLatchRestingSig = hint.restingAlpha;
      node.hideLatchHeldAt = 0;
      node.hideLatchStreamedOpacity = null;
      node.pendingOpacity = null;
    } else {
      node.selfOpacity = ch;
    }
  }

  // ---- `noteStreamedValue`, as an overloaded declaration so the union never leaks to callers ---------------------

  function noteStreamedValue(
    nodeId: string,
    channel: "transform",
    value: readonly number[],
    nowMs: number
  ): void;
  function noteStreamedValue(
    nodeId: string,
    channel: OpacityChannel,
    value: number,
    nowMs: number
  ): number;
  function noteStreamedValue(
    nodeId: string,
    channel: TweenChannel,
    value: readonly number[] | number,
    nowMs: number
  ): number {
    // FAST OUT for the overwhelmingly common un-pinned, un-latched node: nothing to pin, nothing to clamp, no
    // allocation. This is `pinTween`'s own fast out, and it is what lets a caller feed the loop every node it
    // paints without the cost scaling with the scene.
    const node = nodes.get(nodeId);
    if (!node) {
      return channel === "transform" ? 0 : (value as number);
    }
    refreshNode(node, nowMs);

    if (channel === "transform") {
      const streamed = value as readonly number[];
      const tf = node.transform;
      // A FLIGHT opts out of the catch-up entirely: it re-derives the pose from its own closed-form curve every
      // frame, so it IS the authority for as long as it runs and there is nothing to "catch up" to.
      if (tf !== null && node.flight === null) {
        if (tf.pinBaseline === null) {
          // No baseline (never painted a matrix before the arm) — seed, don't replay.
          tf.pinBaseline = copy6(streamed, [0, 0, 0, 0, 0, 0]);
        } else if (!matrix6Equal(streamed, tf.pinBaseline)) {
          copy6(streamed, tf.pinBaseline);
          tf.pinCatchup = copy6(streamed, tf.pinCatchup ?? [0, 0, 0, 0, 0, 0]);
        }
        return 0;
      }
      node.lastStreamedTransform = copy6(streamed, node.lastStreamedTransform ?? [0, 0, 0, 0, 0, 0]);
      return 0;
    }

    const alpha = value as number;
    if (channel === "selfOpacity") {
      if (node.selfOpacity === null) {
        node.lastStreamedSelfOpacity = alpha;
      }
      return alpha;
    }

    if (node.opacity !== null) {
      return alpha; // owned: `sampleInto` is the authority, and no latch can be live under a running fade
    }
    node.lastStreamedOpacity = alpha;

    // HIDE-LATCH. The fade already settled this node to ~0; hold it there while the producer's one-drain
    // "resting alpha + Visible=true" pre-hide flash passes, instead of letting it paint for a frame.
    if (node.hideLatchedUntil === 0) {
      return alpha;
    }
    const sig = node.hideLatchRestingSig;
    if (alpha <= HIDE_LATCH_ALPHA_EPS) {
      node.hideLatchedUntil = 0; // cancel: the producer itself now ships ~0 — the hide caught up
      node.hideLatchHeldAt = 0;
      node.hideLatchStreamedOpacity = null;
      return alpha;
    }
    if (sig !== null && Math.abs(alpha - sig) <= HIDE_LATCH_RESTING_EPS) {
      // Stash the value the clamp overwrites and START the held-restore clock on the FIRST held resting write
      // (a ≈0 write never starts it).
      node.hideLatchStreamedOpacity = alpha;
      if (node.hideLatchHeldAt === 0) {
        node.hideLatchHeldAt = nowMs;
      }
      return 0;
    }
    // cancel: incoming ≠ resting signature → a genuine reveal ramp, write through
    node.hideLatchedUntil = 0;
    node.hideLatchHeldAt = 0;
    node.hideLatchStreamedOpacity = null;
    return alpha;
  }

  // ---- the handle -----------------------------------------------------------------------------------------------

  const loop: TweenLoop = {
    applyHints(hints, nowMs) {
      for (const hint of hints) {
        if (!(hint.durationMs > 0)) {
          continue; // a non-positive duration is not an animation; the DOM path drops it too
        }
        const node = nodeFor(hint.nodeId);
        refreshNode(node, nowMs);
        if (hint.channel === "transform") {
          armTransform(node, hint, nowMs);
        } else {
          armAlpha(node, hint, hint.channel, nowMs);
        }
      }
    },

    applyFlights(hints, nowMs) {
      for (const hint of hints) {
        const timing = cardFlightTiming(hint);
        if (!(timing.totalSeconds > 0) || !Number.isFinite(timing.totalSeconds)) {
          continue; // a degenerate hint animates nothing; the DOM path leaves it on the streamed pose too
        }
        const node = nodeFor(hint.targetId);
        refreshNode(node, nowMs);
        node.flight = {
          hint,
          timing,
          startMs: nowMs,
          pinUntil: nowMs + hint.windowMs,
          // A discard starts from the angle the card was resting at in the hand, so its first frame is a small
          // step off that pose. A shuffle's flier is spawned for the sweep and takes the tangent outright.
          rotation: hint.kind === "discard" ? hint.rot0 : 0,
          lastSampleMs: nowMs
        };
        // The flight REPLACES the transform channel rather than sitting on top of it — the DOM path's
        // `writeCardFlightTransform` overwrites the very same pin, every frame, so there is no tween left
        // underneath. Dropping it here is what stops an interrupted tween's endpoint (or its stashed catch-up)
        // surviving to the flight's release and yanking the card somewhere the curve never went.
        node.transform = null;
        node.pendingTransform = null;
        // R5 T-DR4 — ARM THE COMET ROOT AS A FOLLOWER of this same flight.
        //
        // WHY THE ROOT NEEDS DRIVING AT ALL. A client that declares `trailDrive` tells the host it will place
        // the comet root itself, and the producer then STOPS streaming that root's transform — which is the
        // right trade (it was ~30 writes per card) but leaves the whole comet frozen at its last streamed pose
        // on any client that does not actually drive it. On this backend that was visible as a small bright
        // square sitting still on the discard pile: the root's decorative sprites, painting where the root was
        // left. So the drive is a CORRECTNESS fix for a capability already voted, independent of how the canvas
        // renders the ribbon.
        //
        // A FOLLOWER, not a copy: it holds no curve and no clock of its own, and evaluates the CARD's flight.
        // `sampleFlight` is idempotent for a repeated `now` (the discard chase steps by wall-clock dt, which is
        // zero the second time), so it does not matter whether the card or the root is sampled first in a
        // frame — both see the same pose, and the rotation is stepped exactly once.
        if (hint.trailId != null && canDriveTrailRoot?.(hint.trailId) === true) {
          const root = nodeFor(hint.trailId);
          refreshNode(root, nowMs);
          root.flightRootOf = hint.targetId;
          root.flightRootDriven = false;
        }
      }
    },

    applyPinnedLoop(nodeId, spec, nowMs) {
      if (spec === null || !(spec.periodMs > 0)) {
        const node = nodes.get(nodeId);
        if (node) {
          node.loop = null;
          refreshNode(node, nowMs);
          if (isInert(node)) {
            nodes.delete(nodeId);
          }
        }
        return;
      }
      const node = nodeFor(nodeId);
      const live = node.loop;
      if (
        live !== null &&
        live.periodMs === spec.periodMs &&
        live.phaseMs === spec.phaseMs &&
        live.anchor === spec.anchor
      ) {
        live.visible = spec.visible; // a visibility flip must never restart the cycle
        return;
      }
      node.loop = {
        periodMs: spec.periodMs,
        phaseMs: spec.phaseMs,
        anchor: spec.anchor,
        visible: spec.visible,
        appliedAtMs: nowMs
      };
    },

    noteStreamedValue,

    sampleInto(nodeId, outTransform6, outAlphas, nowMs) {
      const node = nodes.get(nodeId);
      if (!node) {
        return SAMPLE_NONE;
      }
      refreshNode(node, nowMs);
      let mask = SAMPLE_NONE;

      // THE COMET ROOT FIRST (R5 T-DR4). A follower has no channels of its own — the branches below would all
      // decline — but the precedence is stated rather than relied on: while a flight is placing this root,
      // nothing else may.
      const following = liveFlightFor(node, nowMs);
      if (following !== null) {
        sampleFlight(following, nowMs, outTransform6, 1);
        if (!node.flightRootDriven) {
          node.flightRootDriven = true;
          trailRootDrives++;
        }
        mask |= SAMPLE_TRANSFORM;
      } else if (node.flight !== null) {
        sampleFlight(node.flight, nowMs, outTransform6);
        mask |= SAMPLE_TRANSFORM;
      } else if (node.transform !== null) {
        sampleTransformChannel(node.transform, nowMs, outTransform6);
        mask |= SAMPLE_TRANSFORM;
      } else if (node.pendingTransform !== null) {
        copy6(node.pendingTransform, outTransform6);
        node.lastStreamedTransform = node.pendingTransform;
        node.pendingTransform = null;
        mask |= SAMPLE_TRANSFORM;
      }

      if (node.opacity !== null) {
        outAlphas[ALPHA_OPACITY] = sampleAlphaChannel(node.opacity, nowMs);
        mask |= SAMPLE_OPACITY;
      } else if (node.pendingOpacity !== null) {
        outAlphas[ALPHA_OPACITY] = node.pendingOpacity;
        node.lastStreamedOpacity = node.pendingOpacity;
        node.pendingOpacity = null;
        mask |= SAMPLE_OPACITY;
      } else if (node.hideLatchedUntil !== 0 && node.hideLatchHeldAt !== 0) {
        // Latched and HOLDING: the caller is repainting a node whose streamed alpha we clamped to 0, so keep
        // reporting 0 rather than letting the retained streamed value creep back in between two drains.
        outAlphas[ALPHA_OPACITY] = 0;
        mask |= SAMPLE_OPACITY;
      }

      if (node.selfOpacity !== null) {
        outAlphas[ALPHA_SELF_OPACITY] = sampleAlphaChannel(node.selfOpacity, nowMs);
        mask |= SAMPLE_SELF_OPACITY;
      } else if (node.pendingSelfOpacity !== null) {
        outAlphas[ALPHA_SELF_OPACITY] = node.pendingSelfOpacity;
        node.lastStreamedSelfOpacity = node.pendingSelfOpacity;
        node.pendingSelfOpacity = null;
        mask |= SAMPLE_SELF_OPACITY;
      }

      return mask;
    },

    loopPhase(nodeId, nowMs) {
      const live = nodes.get(nodeId)?.loop;
      if (!live) {
        return -1;
      }
      const origin = live.anchor === "document" ? clockOriginMs : live.appliedAtMs;
      const raw = (nowMs - origin + live.phaseMs) / live.periodMs;
      return ((raw % 1) + 1) % 1;
    },

    channelGroup(nodeId, channel) {
      const node = nodes.get(nodeId);
      if (!node) {
        return null;
      }
      const ch = channel === "transform" ? node.transform : channel === "opacity" ? node.opacity : node.selfOpacity;
      return ch?.group ?? null;
    },

    advance(nowMs) {
      // Deleting the CURRENT entry mid-iteration is well-defined for a Map, which is the only delete here — the
      // same discipline `tickTweens` relies on for its Set.
      for (const node of nodes.values()) {
        refreshNode(node, nowMs);
        if (node.pendingTransform !== null || node.pendingOpacity !== null || node.pendingSelfOpacity !== null) {
          // A settle value the caller has not collected. It is delivered by `sampleInto`, so with the documented
          // frame contract this never survives a single `advance` — but a caller that stops sampling a node must
          // not be able to hold the scheduler awake forever, so one sweep is the bound.
          if (node.pendingStale) {
            node.pendingTransform = null;
            node.pendingOpacity = null;
            node.pendingSelfOpacity = null;
            node.pendingStale = false;
          } else {
            node.pendingStale = true;
          }
        }
        if (isInert(node)) {
          nodes.delete(node.id);
        }
      }
      return loop.nextDeadline(nowMs);
    },

    nextDeadline(nowMs) {
      let next = Infinity;
      for (const node of nodes.values()) {
        // A VISIBLE loop is the one genuinely always-on source: it has no endpoint, so the only honest deadline is
        // "the next frame". An invisible one is inert and must not hold the scheduler awake. Under
        // `loopDeadline: "caller"` the caller publishes its own (capped) deadline for the loop family instead —
        // see the option.
        if (loopDeadlineIsFrame && node.loop !== null && node.loop.visible) {
          return nowMs;
        }
        if (node.flight !== null) {
          if (flightLanded(node.flight, nowMs)) {
            // Landed but still pinned: the pose is constant from here, so ONE wakeup at the pin's release.
            if (node.flight.pinUntil < next) {
              next = node.flight.pinUntil;
            }
          } else {
            return nowMs; // mid-flight: a per-frame animator
          }
        }
        if (
          node.pendingTransform !== null ||
          node.pendingOpacity !== null ||
          node.pendingSelfOpacity !== null
        ) {
          return nowMs; // an undelivered settle value — the caller owes one more paint
        }
        if (node.transform !== null && node.transform.until < next) {
          next = node.transform.until;
        }
        if (node.opacity !== null && node.opacity.until < next) {
          next = node.opacity.until;
        }
        if (node.selfOpacity !== null && node.selfOpacity.until < next) {
          next = node.selfOpacity.until;
        }
        // The held-restore clock only counts while the self-heal could actually fire on a live latch.
        // A node left holding a stale `hideLatchHeldAt` with no latch is inert; publishing its deadline would wake
        // the scheduler forever for a branch that can never run.
        if (
          node.hideLatchedUntil !== 0 &&
          node.hideLatchHeldAt !== 0 &&
          node.hideLatchHeldAt + HIDE_LATCH_HELD_RESTORE_MS < next
        ) {
          next = node.hideLatchHeldAt + HIDE_LATCH_HELD_RESTORE_MS;
        }
      }
      return next;
    },

    hasPerFrameDemand(nowMs) {
      for (const node of nodes.values()) {
        // The normal DOM-style contract keeps a visible loop display-driven.
        // Canvas opts into `loopDeadline: "caller"`, so its local idle clock
        // samples the same phase without making it urgent.
        if (loopDeadlineIsFrame && node.loop !== null && node.loop.visible) {
          return true;
        }
        if (node.flight !== null && !flightLanded(node.flight, nowMs)) {
          return true;
        }
        if (
          node.transform !== null ||
          node.opacity !== null ||
          node.selfOpacity !== null ||
          node.pendingTransform !== null ||
          node.pendingOpacity !== null ||
          node.pendingSelfOpacity !== null
        ) {
          return true;
        }
      }
      return false;
    },

    activeIds() {
      return nodes.keys();
    },

    activeCount() {
      return nodes.size;
    },

    ownsTransform(nodeId) {
      const node = nodes.get(nodeId);
      // A comet root being FOLLOWED is owned too: the loop is writing its pose every frame, and anything that
      // asks this question is asking whether it may write there as well. (`flightRootOf` alone would be too
      // broad — it is cleared lazily; the live test is the one the sampler uses.)
      return (
        node != null &&
        (node.transform !== null || node.flight !== null || node.flightRootOf !== null)
      );
    },

    trailRootDrives() {
      return trailRootDrives;
    },

    transformEndpointInto(nodeId, out6, nowMs) {
      const node = nodes.get(nodeId);
      if (node === undefined) {
        return false;
      }
      // The refresh is what makes a stale endpoint UNREPRESENTABLE rather than merely unlikely: an expired channel
      // is deleted here, before either leg below can read it. Idempotent at a given `nowMs`, so a caller that asks
      // this before its own sweep (which is the required order — the raise pass runs before `sampleInto`) gets the
      // same values the sweep will.
      refreshNode(node, nowMs);
      if (node.flight !== null) {
        return false; // a comet has no endpoint — see the interface note
      }
      if (node.transform !== null) {
        copy6(node.transform.endpoint, out6);
        return true;
      }
      if (node.pendingTransform !== null) {
        // PURE READ. `sampleInto` is what delivers a settle value, exactly once; consuming it here would hand the
        // caller a pose and then leave the paint path with nothing to write.
        copy6(node.pendingTransform, out6);
        return true;
      }
      return false;
    },

    transformChannelTiming(nodeId, nowMs) {
      const node = nodes.get(nodeId);
      if (node === undefined) {
        return null;
      }
      refreshNode(node, nowMs);
      if (node.flight !== null || node.transform === null) {
        return null;
      }
      const ch = node.transform;
      return { durationMs: ch.durationMs, ease: ch.ease, trans: ch.trans };
    },

    releaseNode(nodeId) {
      nodes.delete(nodeId);
    },

    releaseTransform(nodeId) {
      const node = nodes.get(nodeId);
      if (!node || node.transform === null) {
        return false;
      }
      node.transform = null;
      // Publish nothing (see the interface note): the endpoint has just been invalidated, and the caller's own
      // streamed pose — under the node's NEW parent — is the answer.
      node.pendingTransform = null;
      return true;
    },

    clearHideLatches() {
      for (const node of nodes.values()) {
        node.hideLatchedUntil = 0;
        node.hideLatchRestingSig = null;
        node.hideLatchHeldAt = 0;
        node.hideLatchStreamedOpacity = null;
      }
    },

    reset() {
      nodes.clear();
    }
  };

  return loop;
}
