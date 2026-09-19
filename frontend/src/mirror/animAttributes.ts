import type { PresentationAnimationBinding } from "@spirectl/presentation/render";

import { px } from "@/mirror/stageFit";

// Decorative animations the browser replays on its own clock, because the motion never reaches it: either the
// windowless headless instance froze the animator game-side (CouchCoopHeadlessVisualSuspender's decorative freeze —
// energy counter spin `NEnergyCounter`, enemy-intent bob `NIntent`) or the producer divides the motion back out of
// the transform before emitting (spirectl's `Sts2OrbSpinFold`, which covers BOTH counter families — the star
// counter is not frozen, and must not be: its per-frame path is the only thing that raises its count label).
// Either way the replay here is unconditional and composes from the same authored rest pose, so it is the one
// source of this motion in the mirror. Keyed by the node's SCENE-RELATIVE path (stable across the per-character
// energy/star-counter scene variants, which all share this subtree) — matching how the presentation catalog keys
// these bindings.
//
// The vocabulary + keyframes are OWNED by @spirectl/presentation/render (the STS2 render vocabulary shared by
// mirror hosts). We reuse its `applyAnimationBinding` per element (see mirrorRenderer), so this file only maps
// a frozen node → the animation binding to replay. Params are the per-binding options this file pins.
//
// Two decorative animations are replayed:
//   - Energy/star ORB SPIN: see `spinDurationMs` below. These are LEAF sprites, spun by a self-layer child
//     (rotate would ORBIT if applied to the baked-matrix element).
//   - Enemy INTENT BOB: the intent badge drifts up and down on the spot. The whole `IntentHolder` container moves
//     vertically — period 2000ms, amplitude 10px, baseline 8px up. A translate composes with the baked matrix (see
//     mirrorRenderer), so no self-layer is needed. The `IntentHolder...` suffix is specific to the ENEMY intent;
//     the co-op player intents live under `Intents/MultiplayerPlayerIntent/...` and don't match.
//
//     The bob rides the HOLDER, which is what moves on screen. The mirror DOM is NESTED (each node's element is
//     a DOM child of its parent's; see nodeStyle/`parentInv`, which re-bases every child transform against its
//     parent element), so ONE `translate` on the `IntentHolder` element moves its whole subtree — the icon
//     (`IntentHolder/Intent`), the damage number (`IntentHolder/Value`) and the particle emitter
//     (`IntentHolder/IntentParticle`) — so the badge travels as one piece. One animation per intent replaces three,
//     and the two that the idle-compositing gate flagged disappear: the
//     `IntentParticle` leaves are 0×0 emitters with no paint, so their bob reported
//     `compositeFailed = 0x20000 (animationHasNoVisibleChange)` — nothing to move.
const INTENT_BOB_HOLDER = "IntentHolder";

// ---- Orb spin (energy counter + star counter) -----------------------------------------------------------------
// Both counters spin the CHILDREN of their `%RotationLayers` container, each layer turning faster than the one
// before it in proportion to its child INDEX: the i-th child completes a turn in BASE/(i+1) ms, so the stack reads
// as concentric rings at staggered speeds. The two counter families NAME those children differently,
// which makes the leaf number alone ambiguous:
//   * energy counters (ironclad/silent/defect/regent/necrobinder): `Layers/RotationLayers/{Layer2[,Layer3]}`
//   * star counter (star_counter.tscn):                            `Icon/RotationLayers/{Layer1,Layer2}`
// `Layer2` is child index 0 in an energy counter but index 1 in the star counter — a plain
// `endsWith("RotationLayers/Layer2")` rule therefore spun the star counter's SECOND layer at the FIRST layer's
// rate and left its `Layer1` unanimated entirely. Key off the container that OWNS RotationLayers instead.
// NOTE: necrobinder's `Layers/Layer3` is a plain sibling of RotationLayers (not a child of it) and correctly
// matches nothing — that counter has a single spinning layer.
const SPIN_BASE_TURN_MS = 12566;
// Leaf number of the FIRST (`i == 0`) RotationLayers child, per owning container.
const SPIN_FIRST_LAYER_NUMBER: Record<string, number> = { Layers: 2, Icon: 1 };
const SPIN_PATH_RE = /(?:^|\/)([^/]+)\/RotationLayers\/Layer(\d+)$/;

function spinDurationMs(sceneRelPath: string): number | null {
  const match = SPIN_PATH_RE.exec(sceneRelPath);
  if (!match) return null;
  const firstLayerNumber = SPIN_FIRST_LAYER_NUMBER[match[1]];
  if (firstLayerNumber === undefined) return null;
  const ordinal = Number(match[2]) - firstLayerNumber + 1; // 1-based child index (i + 1)
  return ordinal >= 1 ? SPIN_BASE_TURN_MS / ordinal : null;
}

// Tezcatara candle fire: each `NRestSiteFireVfx` root (frozen game-side by the suspender's decorative freeze)
// paints three stacked Sprite2D QUAD leaves carrying the stepped-fire shader. The loop is keyed on the QUADS
// themselves: each quad's visible paint may live on its own gsw shader canvas (a DIRECT child of the quad's
// element — see mirrorRenderer's shaderSelf), so the scaleY+skew must be applied per quad, at the quad's own
// bottom-centre origin. (An older comment justified this with "the web DOM is FLAT"; it isn't — the mirror DOM has
// been NESTED since the nested-DOM round, and the intent bob now uses that. Per-quad stays because of the
// per-quad shader canvas + origin, not because of the DOM shape.)
// Matched by the leaf's LAST path segment (not a substring) so `SteppedFireAdd` never swallows `SteppedFireAdd1`.
const FLAME_QUAD_LEAVES = new Set(["SteppedFireMix", "SteppedFireAdd", "SteppedFireAdd1"]);
// The larger of the two loop periods (skew, 2600ms — see presentation flameFlicker). The per-flame phase seed
// lives in [0, this) and is applied as a NEGATIVE animation-delay to both the scaleY and skew tracks.
const FLAME_PHASE_MOD_MS = 2600;

// Stable 32-bit FNV-1a string hash → a per-flame phase seed (ms). Deterministic across reloads so a flame's phase
// never jumps, and shared by a flame's three quads (same PARENT path) so they stay mutually layered while the 79
// flames desync. Byte-for-byte twin of native CosmeticAnimator.FlamePhaseMs.
function flamePhaseMs(parentPath: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < parentPath.length; i++) {
    h ^= parentPath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % FLAME_PHASE_MOD_MS;
}

// ---- Pinned-loop replay (WS-E) --------------------------------------------------------------------------------
// A second, WIRE-DRIVEN family of replayed animations. The path-keyed table above covers animators that are
// ALWAYS frozen on a KNOWN set of nodes, so a static path match is enough. These are different: the producer pins
// them per-node and names them on the wire (`MirrorNode.pinnedLoopAnim`) because MEMBERSHIP CHANGES AT RUNTIME and
// carries meaning — no path table could know it.
//
// `mapPointPulse` — a map node's icon breathing in place: its scale sweeps 0.95..1.45 with period 1570.796ms
// (a 4 rad/s sine), about the container's own pivot. Only the map nodes you may TRAVEL to pulse; the focused one
// and the unreachable ones sit still. So this is a gameplay affordance, not garnish — a mirror that renders every
// node at rest loses information.
export const MAP_POINT_PULSE_TOKEN = "mapPointPulse";

const MAP_POINT_PULSE_PERIOD_MS = (2000 * Math.PI) / 4; // 1570.7963… — one cycle of a 4 rad/s sine
const MAP_POINT_PULSE_MIN = 1.2 - 0.25;
const MAP_POINT_PULSE_MAX = 1.2 + 0.25;

// R10-B2 — the four loops the R13 producer folds out of the wire on top of the map pulse. Same contract: the
// producer names the loop it pinned, the CLIENT owns the vocabulary (period / amplitude / easing). The tokens are
// byte-exact copies of `Sts2TopBarFold.{Deck,Map,Settings}LoopAnimName` and `Sts2ProceedGlow.LoopAnimName`.
//
//   * `topBarDeckRock` — the deck button's icon rocks while the DECK screen is open: a continuous ±0.12 rad sine
//     about the icon's pivot, period 2π/4 s.
//   * `topBarMapRock` — the map button's icon rocks while the MAP screen is open: the same ±0.12 rad, eased at
//     both ends of each 0.8s leg, period 1600ms.
//   * `topBarSpin` — the settings button's icon turns steadily while the SETTINGS screen is open: 1 rad/s, one
//     full turn per 2π s.
//   * `proceedGlow` — the proceed button's glow breathes: alpha 0.75 → 0.25 → 0.75, two 0.5s LINEAR legs.
//
// All four are pinned ANALYTICALLY (rotation → 0 / alpha → 0.75), NOT to a first-seen sample, and only the pinned
// channel is folded: position, scale and the glow's RGB keep streaming live. That is what fixed the WS-D
// mispositioning bug, and it is why the client replay must never touch the node's own transform/placement.
export const TOP_BAR_DECK_ROCK_TOKEN = "topBarDeckRock";
export const TOP_BAR_MAP_ROCK_TOKEN = "topBarMapRock";
export const TOP_BAR_SPIN_TOKEN = "topBarSpin";
export const PROCEED_GLOW_TOKEN = "proceedGlow";

// WS-A (idle-wire) — the END-TURN BUTTON's glow pulse, folded by the R14 producer (`Sts2EndTurnGlowFold`). Same
// contract as the four above: the producer names the loop, the client owns the vocabulary.
//
// On screen it is the `Visuals/GlowVfx` halo swelling and fading out on a 1.5s cycle, then starting over from
// its small, bright pose: scale 0.5 → 0.7 (eased out) with alpha 0.4 → 0 (linear), both in parallel.
//
// This one matters more than its size suggests: the halo is shown exactly when it is your turn, you have no
// playable card left and you have not ended the turn — i.e. precisely while the combat is IDLE. Before the fold it
// alone kept an idle combat's wire awake at ~17 upserts/s, so no idle window ever opened.
//
// Both channels RESTART from their start values every cycle, so the producer pins them there (scale 0.5, alpha 0.4
// — the values every iteration begins AND ends at) and the client MULTIPLIES both back up: scale 1 → 0.7/0.5 =
// 1.4, opacity 1 → 0/0.4 = 0. Presentation's `pulseScaleFade` is exactly this shape and, unlike the sine loops
// here, it must NOT alternate — the halo snaps back rather than easing back.
export const END_TURN_GLOW_TOKEN = "endTurnGlow";

// Sts2TopBarFold.DeckRockAmplitudeRad == MapRockAmplitudeRad == 0.12.
const TOP_BAR_ROCK_AMPLITUDE_RAD = 0.12;
// Sts2TopBarFold.DeckRockPeriodMs = 2000π / DeckRockRateRadPerSec(4) = 1570.7963…
const TOP_BAR_DECK_ROCK_PERIOD_MS = (2000 * Math.PI) / 4;
// Sts2TopBarFold.MapRockPeriodMs = 2 × MapRockLegMs(800).
const TOP_BAR_MAP_ROCK_PERIOD_MS = 2 * 800;
// Sts2TopBarFold.SpinPeriodMs = 2000π / SpinRateRadPerSec(1) = 6283.1853… (one full turn).
const TOP_BAR_SPIN_PERIOD_MS = (2000 * Math.PI) / 1;
// Sts2ProceedGlow.LoopPeriodMs = 2 × LoopLegMs(500).
const PROCEED_GLOW_PERIOD_MS = 2 * 500;
// Sts2EndTurnGlowFold.LoopPeriodMs — both parallel legs are 1.5s, so the cycle is 1.5s.
const END_TURN_GLOW_PERIOD_MS = 1500;
// Sts2EndTurnGlowFold.ReplayScaleFrom / ReplayScaleTo — ratios against the pinned scale (0.7 / 0.5).
const END_TURN_GLOW_SCALE_FROM = 1;
const END_TURN_GLOW_SCALE_TO = 0.7 / 0.5;
// Sts2EndTurnGlowFold.ReplayAlphaFrom / ReplayAlphaTo — ratios against the pinned alpha (0 / 0.4).
const END_TURN_GLOW_ALPHA_FROM = 1;
const END_TURN_GLOW_ALPHA_TO = 0;
// The producer pins `self_modulate:a` at Sts2ProceedGlow.PinnedAlpha (= LoopMaxAlpha = 0.75) and streams the RGB
// live, so the client cannot re-animate that alpha — it MULTIPLIES it with an opacity loop on a wrapper layer:
// 1 (the pinned value, where every tween cycle starts and ends) ↔ LoopMinAlpha/LoopMaxAlpha = 0.25/0.75 = 1/3.
// Composed against the pinned alpha that is exactly the 0.75 ↔ 0.25 sweep seen on screen.
const PROCEED_GLOW_ALPHA_FROM = 1;
const PROCEED_GLOW_ALPHA_TO = 0.25 / 0.75;

// The authored `pivot_offset` of each rocking/spinning top-bar icon (`Control/Icon`), in the node's OWN local px —
// read off `scenes/ui/top_bar/top_bar_{deck,map,settings}_button.tscn` (several nodes in those scenes carry a
// pivot; this is the one on the ANIMATED `Control/Icon`). Godot rotates a Control about this
// point, so it becomes the replay's `transform-origin`. NOT the box centre: deck 34 vs 36, map 42 vs 40,
// settings 33 vs 32 — small, but a full 1 rad/s SPIN turns a 1px pivot error into a visible wobble.
const TOP_BAR_ICON_PIVOTS: Record<string, { x: number; y: number }> = {
  [TOP_BAR_DECK_ROCK_TOKEN]: { x: 36, y: 34 },
  [TOP_BAR_MAP_ROCK_TOKEN]: { x: 42, y: 32 },
  [TOP_BAR_SPIN_TOKEN]: { x: 32, y: 33 }
};

// Classify each producer token by its visual family. Null is an unknown token from a newer producer, for which
// `pinnedLoopBinding` returns null. The two glow families remain distinct because they originate from different
// producer folds and animate different screens.
export type PinnedLoopFamily = "mapPulse" | "topBar" | "glow" | "endTurnGlow";

export function pinnedLoopFamily(token: string): PinnedLoopFamily | null {
  switch (token) {
    case MAP_POINT_PULSE_TOKEN:
      return "mapPulse";
    case TOP_BAR_DECK_ROCK_TOKEN:
    case TOP_BAR_MAP_ROCK_TOKEN:
    case TOP_BAR_SPIN_TOKEN:
      return "topBar";
    case PROCEED_GLOW_TOKEN:
      return "glow";
    case END_TURN_GLOW_TOKEN:
      return "endTurnGlow";
    default:
      return null;
  }
}

// True when the loop's phase must be anchored to the DOCUMENT timeline (the default) rather than left to start
// where CSS starts it — at apply time.
//
// The four older tokens are anchored because their game-side clocks are unknowable and permanently running: a map
// point seeds its phase randomly, the top-bar rocks start when a screen opened, so a deterministic
// hash-of-node-id offset against a shared timeline is the honest choice AND keeps a re-styled node from jumping.
//
// `endTurnGlow` is the opposite case, and must NOT be anchored: the host starts that loop at a KNOWN instant —
// the moment the button turns shiny — which is the same delta on which the producer starts naming the token, i.e.
// exactly when this replay is applied. Anchoring it to the document timeline would drop the browser into a random
// point of a cycle that ends at opacity 0, so a glow that just turned on could appear invisible and then pop.
// (Safe because the loop is applied once per start: its signature carries no pivot, so a re-layout never re-applies
// it, and `clearPinnedLoop` is what ends it.)
export function pinnedLoopAnchorsToDocument(token: string): boolean {
  return pinnedLoopFamily(token) !== "endTurnGlow";
}

// The node's OWN pivot (Godot `Control.PivotOffset`, node-local px) for a token whose loop is a ROTATION about it,
// else null. The caller maps it into the animated element's local space (see nodeStyles' elementLocalPoint — an
// atlas-sprite leaf's element box is the texture REGION, not the node's rect) and hands the result back to
// `pinnedLoopBinding` as `pivotX`/`pivotY`. `mapPointPulse` computes its own pivot (the node's box centre lifted
// through the baked matrix — a different space entirely, see mirrorRenderer), and `proceedGlow` needs none.
export function pinnedLoopNodePivot(token: string): { x: number; y: number } | null {
  return TOP_BAR_ICON_PIVOTS[token] ?? null;
}

// True when the loop must ride the record's animSelf self-layer CHILD rather than the node's own element. A
// rotation cannot ride the element: it carries the baked global `matrix()`, and CSS applies an individual
// `rotate:` OUTSIDE that matrix, so the node would ORBIT the origin instead of spinning about its pivot. The glow
// rides it for the multiplication described above (a child's opacity multiplies its parent's). Only the
// map-point `pivotPulse` — whose `scale:`+`translate:` pair is built precisely to compose with a baked matrix —
// stays on the element itself.
export function pinnedLoopRidesAnimSelf(token: string): boolean {
  const family = pinnedLoopFamily(token);
  // `endTurnGlow` rides it for BOTH reasons at once: its `pulseScaleFade` drives the `transform:` SHORTHAND (which
  // would clobber the element's baked matrix) and its opacity has to multiply the element's own — the producer
  // pins `modulate.a` at 0.4 into the streamed colour, so the child sweeps 1 → 0 to give back the 0.4 → 0 fade.
  // The self-layer's default `transform-origin` (50% 50% of a box that fills the element) is also the right pivot:
  // GlowVfx's authored `pivot_offset` (256, 128) is the exact centre of its 512×256 rect, so no explicit origin —
  // and therefore no pivot in the loop's signature — is needed. See `pinnedLoopNodePivot`.
  return family === "topBar" || family === "glow" || family === "endTurnGlow";
}

// Deterministic per-node phase (ms) in [0, periodMs). Every map point starts its pulse at a RANDOM phase, so the
// points on screen visibly breathe out of step; replaying them in lockstep would read as one blinking group
// instead. Hash the node id (32-bit FNV-1a, the flame loop's precedent)
// so the offset is stable for the node's whole life — a re-style must never jump its phase.
export function pinnedLoopPhaseMs(nodeId: string, periodMs: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return periodMs > 0 ? (h >>> 0) % periodMs : 0;
}

// The presentation binding for a producer-pinned loop, or null for an unknown token (forward-compatible: an older
// client simply renders the node at the rest pose the producer pinned it to). `pivotX`/`pivotY` are the node's
// pivot in the space its baked matrix maps into — see mirrorRenderer's syncPinnedLoop and presentation's
// PIVOT_PULSE for why the scale needs it.
export function pinnedLoopBinding(
  token: string,
  nodeId: string,
  pivotX: number,
  pivotY: number,
): PresentationAnimationBinding | null {
  switch (token) {
    case MAP_POINT_PULSE_TOKEN:
      return {
        path: "",
        kind: "pivotPulse",
        durationMs: MAP_POINT_PULSE_PERIOD_MS,
        scaleFrom: MAP_POINT_PULSE_MIN,
        scaleTo: MAP_POINT_PULSE_MAX,
        pivotX,
        pivotY,
        delayMs: pinnedLoopPhaseMs(nodeId, MAP_POINT_PULSE_PERIOD_MS),
      };
    // The two icon ROCKS: presentation's `rock` takes the FULL period and runs the half-period `alternate` with
    // easeInOutSine, so the two legs join into the true sine both icons rock through (one continuous sine for the
    // deck icon, two eased half-legs for the map icon — the same curve either way).
    case TOP_BAR_DECK_ROCK_TOKEN:
      return {
        path: "",
        kind: "rock",
        durationMs: TOP_BAR_DECK_ROCK_PERIOD_MS,
        amplitudeRad: TOP_BAR_ROCK_AMPLITUDE_RAD,
        pivotX,
        pivotY,
        delayMs: pinnedLoopPhaseMs(nodeId, TOP_BAR_DECK_ROCK_PERIOD_MS),
      };
    case TOP_BAR_MAP_ROCK_TOKEN:
      return {
        path: "",
        kind: "rock",
        durationMs: TOP_BAR_MAP_ROCK_PERIOD_MS,
        amplitudeRad: TOP_BAR_ROCK_AMPLITUDE_RAD,
        pivotX,
        pivotY,
        delayMs: pinnedLoopPhaseMs(nodeId, TOP_BAR_MAP_ROCK_PERIOD_MS),
      };
    // The settings SPIN: a constant-speed turn, so `rotate` (durationMs = ONE full turn). It carries no CSS delay
    // of its own — the caller's document-timeline anchoring is what phases it (see mirrorRenderer.syncPinnedLoop).
    case TOP_BAR_SPIN_TOKEN:
      return {
        path: "",
        kind: "rotate",
        durationMs: TOP_BAR_SPIN_PERIOD_MS,
        pivotX,
        pivotY,
        delayMs: pinnedLoopPhaseMs(nodeId, TOP_BAR_SPIN_PERIOD_MS),
      };
    // The proceed glow: an OPACITY loop on a wrapper layer (no pivot — nothing moves). `alphaFrom`/`alphaTo` are
    // passed explicitly rather than defaulted so a drift in presentation's defaults fails our own test.
    case PROCEED_GLOW_TOKEN:
      return {
        path: "",
        kind: "glowPulse",
        durationMs: PROCEED_GLOW_PERIOD_MS,
        alphaFrom: PROCEED_GLOW_ALPHA_FROM,
        alphaTo: PROCEED_GLOW_ALPHA_TO,
        delayMs: pinnedLoopPhaseMs(nodeId, PROCEED_GLOW_PERIOD_MS),
      };
    // The end-turn glow: a scale-up + fade-out that RESTARTS from its start values every cycle rather than
    // easing back, so `pulseScaleFade` — which does not alternate — is the shape, and the endpoints are the
    // RATIOS against the producer's two pins. `delayMs` is deliberately absent: this loop's real start instant is
    // known (see `pinnedLoopAnchorsToDocument`), so it is left to start where CSS starts it rather than being
    // offset into an arbitrary point of a cycle that ends invisible.
    case END_TURN_GLOW_TOKEN:
      return {
        path: "",
        kind: "pulseScaleFade",
        durationMs: END_TURN_GLOW_PERIOD_MS,
        scaleFrom: END_TURN_GLOW_SCALE_FROM,
        scaleTo: END_TURN_GLOW_SCALE_TO,
        alphaFrom: END_TURN_GLOW_ALPHA_FROM,
        alphaTo: END_TURN_GLOW_ALPHA_TO,
      };
    default:
      return null;
  }
}

export function nodeAnimBinding(
  sceneRelPath: string | null,
  _nodeType: string | null,
): PresentationAnimationBinding | null {
  if (!sceneRelPath) return null;
  // Energy + star counters both spin `%RotationLayers` children; the ordinal (and so the period) depends on the
  // owning container, not just the leaf number — see spinDurationMs. Suffix-matched, so every character variant
  // of the energy counter is covered.
  const spin = spinDurationMs(sceneRelPath);
  if (spin !== null) {
    return { path: sceneRelPath, kind: "rotate", durationMs: spin };
  }
  // Intent bob runs on the holder so its nested badge travels as one unit.
  if (sceneRelPath === INTENT_BOB_HOLDER || sceneRelPath.endsWith(`/${INTENT_BOB_HOLDER}`)) {
    // LAYOUT SPACE (stageFit.ts): presentation turns these two into a `translate:` keyframe on the holder element,
    // so they are rendered lengths on a layout-space box — 10 and 8 design px, byte-identical on the default arm.
    return { path: sceneRelPath, kind: "bob", durationMs: 2000, amplitudePx: px(10), baselineUpPx: px(8) };
  }
  const lastSlash = sceneRelPath.lastIndexOf("/");
  const leaf = lastSlash >= 0 ? sceneRelPath.slice(lastSlash + 1) : sceneRelPath;
  if (FLAME_QUAD_LEAVES.has(leaf)) {
    const parentPath = lastSlash >= 0 ? sceneRelPath.slice(0, lastSlash) : "";
    return { path: sceneRelPath, kind: "flameFlicker", delayMs: flamePhaseMs(parentPath) };
  }
  return null;
}
