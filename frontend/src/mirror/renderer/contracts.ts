// Public renderer contracts shared by the DOM and canvas backends.

import type { FxRenderInfo } from "@/mirror/canvas/fxSurfaces";
import type { ConfirmTapKind } from "@/mirror/confirmTap";
import type { EagerScrollTarget } from "@/mirror/eagerScroll";
import type { HandPoseReport } from "@/mirror/handPoseProbe";
import type { LandingLogReport } from "@/mirror/landingLog";
import type { RaisedHandVisualClaim, RaiseInputStamp } from "@/mirror/raiseInverse";
import type { Affine } from "@/mirror/affine";
import type { MirrorRect, MirrorState } from "@/mirror/sceneTree";
import type { ViewScaleInputStamp } from "@/mirror/viewScaleInverse";

// One visible, MOUSE-VISIBLE (mouse_filter Stop or Pass — anything the game's hover system reacts to, buttons
// AND tooltip-only elements like relics/gold) Control's box, for the input side's hit-consistency pass
// (pointerMap): `transform` is the node's TRUE game-space (1920-space) global Transform2D — lifted
// through the parent chain — and `localRect` its node-local box, so the GAME rect is
// `nodeMatrix(transform, localRect)`; the RENDERED (on-stage) rect is that game rect shifted right by `spreadDx`
// and — for a width-STRETCHED anchored span (a full-canvas 0/1 blocker like `Game`/`CombatRoom`) — widened to
// `renderedWidth` local px (0 = not widened). Without the width the pass would judge a stretched full-screen Stop
// container "not under the pointer" past x=1920 and push every legit hover off the stage edge.
export interface InteractiveRect {
  id: string;
  transform: Affine;
  localRect: MirrorRect;
  spreadDx: number;
  renderedWidth: number;
  // READABLE-HAND MODE: the cosmetic vertical offset this rect is DRAWN at relative to the game placement above
  // (negative = raised). 0 for every rect the mode doesn't move — i.e. all of them while it is off. The near-miss
  // pass uses it for its RENDERED containment test, and the input inverse is built from the non-zero ones.
  raiseDy: number;
  // READABLE-HAND MODE: this rect is a HAND HITBOX while the mode has surfaces up — i.e. its input is owned
  // wholesale by the raise claim machinery, offset or not. The near-miss pass must never treat one as an offender:
  // a correction would turn a pixel on the raised card into a coordinate outside the card's game box. Optional — absent/false for every
  // rect while the mode is off, so the pass is byte-identical then.
  raiseGoverned?: boolean;
}

/** Internal coordinate-classifier result; never part of the browser-to-game wire protocol. */
export interface ConfirmTapHit {
  id: string;
  kind: ConfirmTapKind;
  // The active remove-a-card service is the sole guarded target whose armed re-tap activates it directly.
  retapActivates?: boolean;
}

// Why a reconcile took the FULL (scene-wide restyle) path — pure observability, see mirrorWalkStats.fullWalkCauses.
// `forceTextures` is the unattributed forced re-touch; the callers that know better name themselves (`spread`,
// `spine`, `texture`). `keyframe` / `bail` / `fixup` are decided inside the walk; `firstBuild` is the initial build.
export type FullWalkCause =
  | "firstBuild"
  | "forceTextures"
  | "spread"
  | "spine"
  | "texture"
  | "keyframe"
  | "bail"
  | "fixup"
  | "occlusion"
  | "staticBg"
  | "uiScale";

/**
 * R6 P6-A — the RECONCILE PULL, the app's scheduled walk offered to a backend that has its own frame loop.
 *
 * The mirror runs TWO independent rAF loops on the canvas backend: the app's coalesced `scheduleRender` (booked
 * when a delta bumped `state.revision`) and the renderer's own animation frame (booked by a tween, a spine clip,
 * an effect surface, a comet). Both fire in the SAME display frame, in booking order, and when the animation one
 * runs first it builds and paints a list from a state the pending reconcile is about to replace — a whole wasted
 * build and paint per animated delta frame. It is the largest `staleState` tier-3 patch bail bucket there is.
 *
 * A backend that implements this is handed the two facts it needs to collapse the pair: whether a scheduled
 * reconcile is still PENDING, and a way to run it NOW (which cancels the pending rAF). The DOM backend does not
 * implement it — it has no second loop to collapse — so that arm is untouched by construction.
 */
export interface ReconcilePull {
  /** Is a coalesced `scheduleRender` rAF booked and not yet run? */
  pending(): boolean;
  /** Run it now, synchronously, and drop the booked rAF. Refused (no-op) while one is already running. */
  now(): void;
}

export interface HandRaiseUiLayer {
  present: boolean;
  anchorId: string | null;
  domTarget: HTMLElement | null;
  covered: boolean;
  backend: "dom" | "canvas";
}

export interface CanvasHandRaiseChrome {
  source: HTMLCanvasElement;
  width: number;
  height: number;
  right: number;
  bottom: number;
  scale: number;
  revision: number;
}

export interface RewardFocusRow {
  id: string;
  focused: boolean;
  covered: boolean;
  gameCenter: { x: number; y: number } | null;
}

export interface RewardFocusSnapshot {
  screenId: string | null;
  rows: RewardFocusRow[];
}

export interface MirrorRenderer {
  /** `false` means a strict stage-owned source is still loading: no frame or wire ack happened. */
  reconcile(state: MirrorState, options?: { forceTextures?: boolean; reason?: FullWalkCause }): void | false;
  // R6 P6-A — OPTIONAL, and absent on the DOM backend by design (see ReconcilePull). MirrorView hands this to the
  // renderer right after constructing it; a backend that keeps its own animation loop uses it to run the app's
  // pending reconcile in place of a build it would only have to throw away.
  setReconcilePull?(pull: ReconcilePull): void;
  // R10-PERF3 WS-4: nodes whose provisional style depended on a texture natural size that has NOW arrived (see
  // textureCache). They are injected into the next walk's dirty set exactly like wire-changed ids — an O(depth)
  // descent plus those nodes' own restyle — instead of the scene-wide `forceTextures` re-touch this replaced.
  // Ids accumulate until a walk consumes them (same lifecycle as `state.changedIds`); unknown ids are dropped.
  markTextureDirty(ids: Iterable<string>): void;
  // Horizontal spread factor (stageWidth / 1920). 1 = no spread. MirrorView forces a structural reconcile after
  // changing it (skip-clean would otherwise leave unchanged nodes at the old spread).
  setStretch(factor: number): void;
  // The card a touch drag currently holds (null = none) + its live GAME-space (1920-space) coordinate — the exact
  // value sent upstream, never the rendered/spread one. Purely cosmetic: `visit` gates a CSS `translate` lift on
  // this per-frame while the id's node re-renders; it never affects hit-testing or what's sent to the game.
  setHeldCard(id: string | null, gameX: number, gameY: number, mode?: "drag" | "peek"): void;
  // READABLE-HAND MODE (mirrorSettings.raiseHandCards): raise the resting hand so a whole hand is readable, and
  // move each creature's health bar + powers above its reticle. Purely cosmetic `translate`s — see
  // applyHandRaisePass. A flip applies immediately; no reconcile is needed.
  setRaiseHandCards(enabled: boolean): void;
  // READABILITY SCALING (mirrorSettings.uiScaling): the master switch over the view scale, the HoverTip
  // enlargement, the per-label text-scale table and the clip-axis outset — everywhere the mirror draws the game
  // bigger than the game does. See uiScaling.ts. Off is the parity mode (and the escape hatch); the flip moves
  // the shared flag and then repairs whatever THIS backend has already drawn with it. MirrorView additionally
  // forces a structural walk, which is what re-registers the enlarged items on the way back ON.
  setUiScaling(enabled: boolean): void;
  // The input inverse for whatever the mode last moved (empty ⇒ input is byte-identical). inputCapture maps every
  // resolved pointer through these so a tap on a raised card reaches the card, not the space above it.
  raiseInputStamps(): RaiseInputStamp[];
  /**
   * Which raised hand holder's CURRENTLY PAINTED descendant and same current hitbox/art-overhang footprint contain
   * this raw stage pixel. This is a renderer provenance fact, not a hit-test replacement: input keeps the ordinary
   * raw halo guard unless this exact owner proves a reflowed card footprint.
   */
  raisedHandVisualClaimAt?(clientX: number, clientY: number): RaisedHandVisualClaim | null;
  /**
   * Convert the renderer's already-proven top touch target into its live raised-hand holder. This deliberately
   * accepts no loose coordinate: callers may use it only after this backend's `touchStackAt` selected that target.
   */
  raisedHandTouchTargetClaim?(touchTargetId: string): RaisedHandVisualClaim | null;
  // Is a combat hand on screen? Drives the client-side raise toggle button's visibility.
  handPresent(): boolean;
  /** Scene-layer placement for the client-only hold-to-raise control. */
  handRaiseUiLayer(): HandRaiseUiLayer;
  /** Canvas-only visible pixels. DOM renderers leave the Vue control in the scene element. */
  setHandRaiseChrome?(chrome: CanvasHandRaiseChrome | null): void;
  // WHERE THIS BACKEND IS DRAWING THE HAND — the shared instrument both stages answer (handPoseProbe.ts), and the
  // only way to ask the canvas stage that question at all (it emits no per-node DOM for a harness to measure).
  // Per holder: the game's own pose, the pose actually drawn, and the two client-side terms between them (the
  // wide-screen shift and the readable-hand lift). Also installed on `window.__mirrorHandPoses`.
  handPoses(): HandPoseReport;
  // WHERE THIS BACKEND DECIDED TO SEND EACH HAND CARD, scored against where it ended up (landingLog.ts). The seam
  // above measures the hand at rest, which a client that eased to the wrong place and was then rescued by the
  // producer's settle re-emit passes trivially; this one measures the PREDICTION and is the gate for it.
  // Also installed on `window.__mirrorLandingLog` — but a spec driving two arms must call this, since both
  // backends install the same window name and the second one wins.
  landingLog(): LandingLogReport;
  // Dev seam (window.__mirrorHandRaise): every gate + per-holder ramp behind the current hand height.
  handRaiseDebug(): Record<string, unknown>;
  // Whether the widget id (a `data-touch-id` root reported by the input side) is a combat CARD — for the touch
  // long-press "peek" gate, so only cards trigger it. Reads the retained records; valid between reconciles.
  isCardTouchTarget(id: string): boolean;
  // Whether the widget id lives under a HAND container (NHandCardHolder/NPlayerHand). With isCardTouchTarget this
  // keeps peek / drag-lift / unselect card semantics to HAND cards; a deck-dialog / reward card is a plain node.
  // Walks the retained node parent chain; valid between reconciles.
  isHandCard(id: string): boolean;
  // CONFIRM TAP: which irreversible-choice kind the widget id is (a card-reward pick, an event option, a shop
  // purchase, a MULTIPLAYER treasure relic, a rest-site choice) — null when its tap is not one, which leaves it to
  // the ordinary two-step tap. See confirmTapEligible for the table and the two gated cases. Reads the retained
  // nodes; valid between reconciles.
  confirmTapTarget(id: string): ConfirmTapKind | null;
  // CONFIRM TAP, coordinate half: which confirm-eligible widget's TRUE game-space hit box contains this RESOLVED
  // game point (topmost by paint order when two overlap), or null. This — not the DOM stamp stack — is what
  // classifies a tap: the stack measures RENDERED descendant unions (a rest-site option's Label box hangs a full
  // widget-height below the drawn button), while this asks with the same number the game will hit-test, so the
  // button can only appear where a commit would actually land. Touch-time only; one bounded retained-map scan.
  confirmTapAt(gameX: number, gameY: number): ConfirmTapHit | null;
  // CONFIRM TAP, stacking half: is a full-stage cover currently painting ABOVE this widget (a modal overlay — map,
  // deck / card-grid capstone, card or relic dialog, pause)? Decides whether the confirm button paints above the
  // whole mirror tree or below it. A screen's OWN backstop paints UNDER its content, so it never answers true for
  // an option on that screen. Independent of the occlusion setting; memoised per walk.
  coverAbove(id: string): boolean;
  /** Active rewards list in display order, using native game-space hit geometry on either backend. */
  rewardFocusSnapshot(): RewardFocusSnapshot;
  // CONFIRM TAP: arm the cover pre-filter while a confirm button is shown, so `coverAbove` still has a candidate
  // set under `?occlude=off`. No-op cost when false.
  setConfirmCoverWatch(on: boolean): void;
  // #12: whether a from-hand card-CHOICE screen (NChooseACardSelectionScreen: Survivor discard / exhaust / enchant)
  // is effectively visible — a hand-card tap then single-taps (no arm-first) and the below-line unselect is
  // suppressed. Bounded scan over the retained nodes; valid between reconciles. Native twin: HandChoiceScan.IsActive.
  handChoiceActive(): boolean;
  // R11 WS-M: is one of the MAP screen's drawing tools (quill / eraser) currently ARMED? While a tool is armed the
  // game routes map input to the drawing surface and map points are not selectable, so a map-node tap must not be
  // routed as a travel action. The signal is the tool button's Icon TEXTURE swapping to its `*_glow.png` variant —
  // exact, unlike selfModulate (which also brightens on plain hover). Bounded scan over the retained nodes, read
  // once per tap. (A later round's eager-scroll rework wants the same fact — keep this the ONE accessor for it.)
  mapDrawingToolActive(): boolean;
  // The visible mouse-visible (Stop/Pass) Control boxes of the CURRENT frame (game rect + spreadDx), topmost paint order LAST — for the
  // input side's near-miss / hit-consistency pass. Reads the retained records, so it's valid between reconciles.
  interactiveRects(): InteractiveRect[];
  // FIX 3 (R7): the GAME-space view-scale input registry of the LATEST drain (twin of native ViewScaler's published
  // InputRegistry) — each enlarged item's inverse channel + ScaledBox + neighbour overlays, so inputCapture can map a
  // hover/tap over an enlarged option back onto its true hit box (viewScaleInverse.remapViewScaleInverse). Empty when
  // no view-scale screen is up (byte-identical input). Live read of the per-drain cache (rebuilt by applyViewScalePass).
  viewScaleInputStamps(): ViewScaleInputStamp[];
  // R4 change 2 (touch.endTurnBoxAt): the END-TURN button's game-space AABB when the RESOLVED game point lands on
  // it, else null. Scene-file identity (end_turn_button.tscn) over the interactive-rect surface; read-only lookup,
  // only called on the tap-end of a block/empty tap. Native twin: EndTurnScan.BoxAt.
  endTurnBoxAt(gameX: number, gameY: number): { minX: number; minY: number; maxX: number; maxY: number } | null;
  // R10 WS-E: the scroll containers the eager-scroll module may drive locally (the map's `TheMap`, a card grid's
  // `ScrollContainer`), in paint order — each with its live streamed offset, game-space viewport, scroll limits, the
  // materialized-row band a virtualized grid must not be scrolled past, whether a tween owns it, and its scrollbar
  // thumb. Structure is epoch-cached; the values are read live (a scroll moves them every frame). Empty off a
  // scrollable screen ⇒ the whole feature is inert.
  eagerScrollTargets(): EagerScrollTarget[];
  // `id` IS `ancestorId` or descends from it, over the retained node tree — so the input side can ask whether a
  // touch target lives inside a given scroll container without walking the chain itself.
  isUnderNode(id: string, ancestorId: string): boolean;
  // R10-PERF4 WS-2: has anything happened since the last call that gsw's shader / particle runtime reconcile could
  // possibly SEE? Reads AND clears, so each answer covers exactly one caller's window. MirrorView gates each
  // runtime's `reconcile()` on its bit instead of running both (two whole-stage querySelectorAll sweeps, plus the
  // shader pass's invalidateRects×2, which defeats gsw's rect TTL) after every rendered frame. Conservative: any
  // structural walk, element teardown/adoption and every occlusion suspend/resume set BOTH bits.
  consumeEffectsDirty(): { shader: boolean; particle: boolean };
  // M2 (the canvas stage's in-stage effects) — OPTIONAL, and absent on this backend by design. A gsw runtime has just
  // finished a REAL draw for `node`, into `surface`; `info` is what the runtime knows about that frame (its
  // `render_mode` blend, and whether it read SCREEN_TEXTURE / SCREEN_UV). MirrorView spreads it into BOTH runtimes'
  // options as `onBindingRendered` and calls it OPTIONALLY, so there is no backend detection anywhere: the DOM
  // backend simply does not implement it, because it has nothing to do with the news — the canvas gsw painted is
  // already in the page, where this backend leaves it. The CANVAS backend implements it, because for that stage the
  // notification is the only signal that a surface it uploads as a texture has new pixels.
  noteEffectRendered?(node: HTMLElement, surface: HTMLCanvasElement, info?: FxRenderInfo): void;
  // STAGE-A "Static background": StaticBackground.vue's confirmed-shown signal. `scenePath` = the combat bg
  // scene whose host-rendered image IS currently displayed (load + decode complete — never before), null = none
  // (setting off / no descriptor / fetch or decode error / component unmount). Null clears every suppression, so
  // the live bg subtree is the fail-open. The matching root (isCombatBackgroundSceneRoot) goes display:none at
  // the ROOT only; applied immediately via direct display flips (a settled combat walks nothing).
  //
  // R12 SPLIT OF DUTIES — this signal is no longer what keeps the subtree off the phone:
  //   * the RENDERER owns the BUILD hold, derived from the WIRE plus `mirrorSettings` alone, so
  //     the very first walk that sees a new room's bg root already knows to hold it — no dependence on Vue flush
  //     ordering, on the session envelope's arrival, or on a decode;
  //   * the COMPONENT owns this SHOWN signal, which drives `display` + the gsw effect-suspend stamp for a subtree
  //     that exists anyway after a hold release, belt expiry, or a background decode failure.
  // A non-null signal also re-arms this room's belt-and-braces clock (the component just proved it is alive).
  setStaticBackgroundShown(scenePath: string | null): void;
  // Canvas-only Stage-C arm. The DOM renderer deliberately does not implement this: StaticBackground.vue then
  // retains its legacy decoded <img>. A canvas renderer calls `ready` only once the source is decoded AND uploaded
  // into the stage texture registry, so suppressing the live subtree can never reveal a transparent first quad.
  setStaticBackgroundSource?(
    source: { scenePath: string; url: string } | null,
    ready?: (ready: boolean) => void
  ): void;
  // R10-PERF5 WS-3 TEST SEAM (never called in production): run ONE idle-hatchery slice synchronously with an explicit
  // budget — `0` degenerates to exactly one marker per call, which is how a spec drives the resumable DFS — and
  // report whether anything is still queued. Deliberately does NOT re-arm the timer, so a spec steps the hatchery
  // deterministically without fake timers (the real scheduling is exercised separately, with them).
  __drainDormantHatchForTest(budgetMs?: number): boolean;
  // R10-PERF6 WS-P2 TEST SEAM (never called in production): run ONE staggered-reveal release slice synchronously
  // with an explicit node budget, and report how many hold roots are STILL held — so a spec can step the drain
  // (and assert the completeness contract: keep slicing and every node ends up shown).
  __drainRevealStaggerForTest(budgetNodes?: number): number;
  // --- INPUT SEAMS (M0) -------------------------------------------------------------------------------------
  // The four questions the input side used to answer by reading the DOM itself. They are RENDERER questions: each
  // one asks "what did you draw at this viewport point / where did you put this node", and only the backend that
  // drew it can say. The DOM backend answers them with the same `elementsFromPoint` walks the input modules used
  // to run inline (moved here verbatim); a canvas backend answers them from its own scene, where there are no
  // elements to hit-test at all. Keeping them on this interface is what lets the input path stay backend-agnostic.
  //
  // The hover-first widgets under a touch point, TOPMOST first, plus what (if anything) BLOCKED the scan.
  // See TouchStack. (inputCapture.touchTargetsAt)
  touchStackAt(clientX: number, clientY: number): TouchStack;
  // The topmost SPREAD PAINTER under a viewport point, for the wide-screen visual-anchor map (pointerMap).
  // `backdropWidthPx` is the caller's backdrop-demotion threshold in client px: a painter at least that wide (or
  // one marked `data-spread-w`) is a full-frame band that cannot speak for a specific widget, so the walk skips it
  // and keeps looking. Returns the first painter that survives, `null` when the walk found none — and `undefined`
  // when this backend cannot hit-test AT ALL (the DOM backend in an environment with no `elementsFromPoint`), which
  // the caller maps as the identity, exactly as it did before this seam existed. Null and undefined are different
  // answers on purpose; see mapPointerToGame.
  spreadPainterAt(clientX: number, clientY: number, backdropWidthPx: number): SpreadPainter | null | undefined;
  // The MAP POINT under a viewport point as its scene-root node id (= the live Godot instance id the
  // `select-map-node` action carries), or null when the point isn't over one. (mapNodeTap.mapPointElementIdAt)
  mapNodeAt(clientX: number, clientY: number): string | null;
  // EAGER SCROLL, write half: park node `nodeId` `dy` design px away from where the walk baked it — the cosmetic
  // local offset the eager-scroll engine composes on top of the streamed position. The renderer owns the write, so
  // the engine never has to hold an element (and a canvas backend has one to hold). Unknown id ⇒ no-op.
  applyLocalOffset(nodeId: string, dy: number): void;
  // EAGER SCROLL, read half: the Y translation the walk last BAKED into `nodeId` (baseTranslateY) — what is
  // PAINTED, which is what the eager offset must compose against. Null when the renderer cannot say (no record, or
  // nothing styled yet), so the caller keeps its own streamed fallback.
  scrollRenderedY(nodeId: string): number | null;
  dispose(): void;
}

// One hit-stack probe's verdict about a viewport point (mirrorRenderer.touchStackAt). `ids` + `blocked` are the
// long-standing tri-state ("no ids here" and "a BLOCKING widget is here" are different facts); `blockKind` and
// `topStamp` say WHICH widget is spoken for there, which the scrollbar claim needs and a boolean cannot carry.
// Lives here (not in inputCapture) because the RENDERER is what stamps these attributes and now what reads them.
export interface TouchStack {
  ids: string[];
  blocked: boolean;
  blockKind: "button" | "bar" | "thumb" | null;
  topStamp: "bar" | "thumb" | "other" | null;
}

// The topmost painter the wide-screen anchor map may anchor to at a point (mirrorRenderer.spreadPainterAt).
// `dx` is the painter's (or its nearest spread holder's) cumulative absolute horizontal shift, `prop` marks
// PROPORTIONAL world content (a card, a creature, an arrow segment) as opposed to anchored HUD, and `widthPx` is
// its rendered client width — which pointerMap still needs for the oversized-parallax exception. All three are
// facts about what was DRAWN; the arithmetic that turns them into a game coordinate stays in pointerMap.
export interface SpreadPainter {
  dx: number;
  prop: boolean;
  widthPx: number;
}
