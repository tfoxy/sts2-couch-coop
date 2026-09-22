<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from "vue";

import {
  createHtmlEffectsHost,
  type HtmlEffectsHost,
  type GodotEffectRenderInfo,
  type ParticleRuntime,
  type WebglShaderRuntime
} from "@godot-scene-web/html/runtime";
import { MAX_PINNED_BACKING_DIM } from "@godot-scene-web/html";

import { playZoneThreshold, RICH_TEXT_EFFECTS_ATTRIBUTE } from "@spirectl/presentation/render";

import { createAdaptiveController, type AdaptiveController } from "@/mirror/adaptiveQuality";
import { createEagerScroll, type EagerScroll } from "@/mirror/eagerScroll";
import { noteMirrorFrame, registerPressureSource } from "@/mirror/framePressure";
import { createGamepadCapture, type GamepadCapture } from "@/mirror/gamepadCapture";
import { createInputCapture, type InputCapture } from "@/mirror/inputCapture";
import { lastPressModality, onPressModalityChange } from "@/inputModality";
import {
  createRewardFocusCoordinator,
  type RewardFocusCoordinator
} from "@/mirror/rewardFocusCoordinator";
import { createMapNodeTapRouter, type MirrorActionMessage } from "@/mirror/mapNodeTap";
import {
  confirmTap,
  confirmedRelicTarget,
  forgetConfirmedRelic,
  hideConfirmTap,
  primeConfirmSprites,
  setConfirmBelowOverlay
} from "@/mirror/confirmTap";
// Per-element text-scale overrides — a global (unscoped) sheet, since the mirror nodes are created imperatively
// (not in this component's scoped template). R10-PERF4 WS-3 (item 4): the generated sheet is keyed on the
// `mirror-ts-*` classes the renderer resolves once per element.
import { installTextScaleSheet } from "@/mirror/textScaleClasses";
import { onAtlasRegionsReady } from "@/mirror/atlasBaker";
import { reproRecorder } from "@/mirror/reproRecorder";
import { sceneCheckpoint } from "@/lifecycleTelemetry";
import type { MirrorInputMessage, MirrorScrollAck } from "@/mirror/mirrorClient";
import type { FullWalkCause, MirrorRenderer } from "@/mirror/renderer/contracts";
import {
  setStaticStillCountersGauge,
  setStaticStillGauge,
  type MirrorStaticStillCounters
} from "@/mirror/renderer/walkStats";
// WHICH backend draws the stage (DOM today, `?stage=canvas` for the single-canvas one) is the factory's decision,
// never this component's — see rendererFactory. `requestedStageBackend` is read for ONE thing only: the canvas
// backend needs its own untransformed host element in the template, and a template is built before any renderer
// exists (see `canvasHostLayout`).
import {
  activeStageBackend,
  createMirrorRendererFor,
  requestedStageBackend
} from "@/mirror/rendererFactory";
import { MIRROR_RENDERER_KEY } from "@/mirror/rendererKey";
// WHICH SPACE the DOM boxes are laid out in (`?stageFit=design|display`) — see stageFit.ts. This component owns
// two things about it and nothing else: the backend GRANT (the canvas arm is never granted), and feeding the live
// fit measurement in so every px emission downstream can convert.
import { activateDisplayLayout, displaySpaceLayout, setLayoutScale, stageFitMode } from "@/mirror/stageFit";
import { effectiveRaiseHandCards, setHandRaiseLayer } from "@/mirror/handRaiseUi";
import { mirrorSettings, type EffectMode } from "@/mirror/mirrorSettings";
import { sceneAblation } from "@/mirror/sceneAblation";
import { isAdaptiveEligible, renderQuality } from "@/render/quality";
import {
  effectiveParticleMode,
  effectiveShaderMode,
  mirrorParticleRenderOptions,
  mirrorShaderRenderOptions,
  shaderWarmSpecs
} from "@/mirror/shaderResources";
import { installGlContextEventReporter } from "@/mirror/glContextEvents";
import { mirrorStaticPin } from "@/mirror/staticPin";
import { mirrorShopRemovalProbe } from "@/mirror/shopRemovalProbe";
import { onTextureSizesResolved } from "@/mirror/textureCache";
import { createFirstScenePresentation } from "@/mirror/firstScenePresentation";
import {
  MIRROR_DESIGN_HEIGHT,
  MIRROR_DESIGN_WIDTH,
  MIRROR_MAX_DESIGN_WIDTH,
  type MirrorState
} from "@/mirror/sceneTree";

// Put the (single) text-scale sheet in the document before the reconciler creates its first element. Idempotent,
// so the repeated call across component setups is free.
installTextScaleSheet();

// Renders the retained mirror map as absolutely-positioned DOM in design space, scaled-to-fit (letterbox) like
// Godot's "Keep" stretch aspect. The per-node DOM is built imperatively by a delta-driven reconciler
// (`mirrorRenderer.ts`) — NOT by a Vue component tree — so a ~60Hz volatile delta only touches the elements that
// actually changed instead of re-rendering + VNode-diffing every node. This shell owns the scale, the shared
// shader/particle WebGL runtimes, and the tint/HSV <defs> the node styles reference; the reconciler owns the stage.
const props = withDefaults(defineProps<{
  state: MirrorState;
  revision: number;
  // When provided, this client is a CONTROLLER: pointer/keyboard over the stage is captured and sent upstream.
  // Absent → a pure (receive-only) mirror.
  sendInput?: (message: MirrorInputMessage) => void;
  // The semantic action channel (mirrorClient.sendAction), used for map travel and the absolute scroll offset.
  sendAction?: (message: MirrorActionMessage) => void;
  // The absolute scroll channel (see eagerScroll.ts' header).
  //   sendScroll  put a `set-scroll-offset` on the wire for one scroll container; returns the requestId it went
  //               under, or null when the socket was not open.
  //   scrollAck   the host's latest answer, a FRESH object per ack so the watch below sees every one of them.
  sendScroll?: (elementId: string, offsetY: number) => string | null;
  scrollAck?: MirrorScrollAck | null;
  // Called after each rendered frame so the client can ack the host (scene-delta flow control). Absent → no ack
  // (the host's self-heal timeout still drives updates).
  onSceneRendered?: () => void;
  connectionAttemptId?: string | null;
  connected?: boolean;
  onFirstSceneFramePresented?: (attemptId: string) => void;
  onSceneRenderError?: (attemptId: string, error: unknown) => void;
}>(), {
  // Render-only mounts do not accept input. The application always supplies the current semantic sender.
  sendScroll: () => () => null
});

const frame = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const defs = ref<SVGDefsElement | null>(null);
const firstPresentation = createFirstScenePresentation({
  presented: (attemptId) => props.onFirstSceneFramePresented?.(attemptId),
  failed: (attemptId, error) => props.onSceneRenderError?.(attemptId, error),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  visible: () => document.visibilityState !== "hidden" && props.connected !== false
});
watch(() => props.connectionAttemptId, (attemptId) => {
  firstPresentation.setAttempt(attemptId ?? null);
  // A direct-view grant can arrive after this component already mounted its scene.
  if (attemptId) scheduleRender();
}, { flush: "sync" });
firstPresentation.setAttempt(props.connectionAttemptId ?? null);
document.addEventListener("visibilitychange", firstPresentation.visibilityChanged);
watch(() => props.connected, (connected) => {
  if (connected) firstPresentation.visibilityChanged();
});
/**
 * THE CANVAS STAGE'S OWN HOST — the element `?stage=canvas` lays its single <canvas> out in, a SIBLING of
 * `.mirror-stage` sized at the fitted box with NO transform on it or above it.
 *
 * WHY IT IS A SIBLING AND NOT A CHILD. Blink allocates a render surface for a `transform: scale(fit)` element that
 * has a composited descendant, at layer space (CSS × devicePixelRatio); the canvas texture is then bilinearly
 * magnified into that surface and minified back out of it — net geometry 1.0, two resamples, a blurred stage on
 * every desktop whose dpr is not 1. DOM content in that subtree only gets supersampled, so the overlays keep the
 * scaled design box and the canvas alone leaves it. Mechanism, trace and byte-crisp identity arm:
 * `.sts2/canvas-blur-sep03/FINDINGS.md` (uncommittable, per checkout), and canvasRenderer's SIZING LAW.
 *
 * DECIDED AT SETUP, from the REQUESTED backend — the template is built before `createMirrorRendererFor` runs, so
 * this cannot wait for the factory's answer. A `?stage=canvas` that hard-falls-back to the DOM backend therefore
 * leaves an empty host in the page; it is `pointer-events: none` and paints nothing, and the DOM stage above it is
 * unchanged, so the fallback stays invisible exactly as the factory promises.
 */
const canvasHostLayout = requestedStageBackend() === "canvas";
/**
 * THE DISPLAY-SPACE LAYOUT GRANT. `?stageFit=display` asks for DOM boxes in real display px and a stage with no
 * scale transform (stageFit.ts); it is granted only on the DOM backend, for the two reasons stageFit's header
 * gives — the canvas arm has no scaled DOM subtree to fix, and its runtime reads the stage's design box off
 * `stage.clientWidth`, which display-px boxes would collapse to the identity. Decided at SETUP, from the REQUESTED
 * backend, exactly like `canvasHostLayout` and for the same reason: the template is built before any renderer is.
 */
activateDisplayLayout(!canvasHostLayout);
const displayLayout = displaySpaceLayout();
if (stageFitMode() === "display" && typeof console !== "undefined") {
  console.info(
    displayLayout
      ? "[mirror] stage fit: display — DOM boxes in display px, stage carries no transform (?stageFit=display)"
      : "[mirror] stage fit: display requested but not applicable to the canvas backend — using design"
  );
}
const canvasHost = ref<HTMLElement | null>(null);
const scale = ref(1);
// Live frame size (updated by the ResizeObserver via recomputeScale) — drives the widened design width below.
const frameWidth = ref(0);
const frameHeight = ref(0);
let observer: ResizeObserver | null = null;
let renderer: MirrorRenderer | null = null;
// STAGE-A "Static background": the renderer handle, provided to the browser-only slot controls (StaticBackground
// needs setStaticBackgroundShown). A shallowRef mirror of the imperative `renderer` local above — assigned in the
// same onMounted/onBeforeUnmount sites, so the two can never disagree.
const rendererRef = shallowRef<MirrorRenderer | null>(null);
provide(MIRROR_RENDERER_KEY, rendererRef);
// A requested canvas backend can hard-fallback during construction. In that exceptional arm StaticBackground
// reverts to its DOM image, which must use the fitted design-space underlay rather than becoming a frame-relative
// bare slot. `rendererRef` is null only during the safe no-DOM mount interval.
const canvasUnderlayRequired = computed(
  () =>
    canvasHostLayout &&
    rendererRef.value !== null &&
    rendererRef.value.setStaticBackgroundSource === undefined
);
let inputCapture: InputCapture | null = null;
// The BROWSER GAMEPAD capture (gamepadCapture.ts) — created beside inputCapture and under the same gate, so a
// receive-only mirror (no `sendInput`) never polls a pad, and inert on any browser without the secure-context-only
// Gamepad API. It shares nothing with inputCapture but the send path.
let gamepadCapture: GamepadCapture | null = null;
let rewardFocusCoordinator: RewardFocusCoordinator | null = null;
let unsubscribePressModality: (() => void) | null = null;
// R10 WS-E — the eager-scroll engine. Created alongside inputCapture (it needs the renderer AND the send path),
// so it is null in the read-only/no-input mode exactly like inputCapture is.
let eagerScroll: EagerScroll | null = null;
// gsw's live WebGL shader runtime: scans for `[data-godot-shader-webgl]` nodes (stamped by the reconciler) and
// renders the real Godot shaders into per-node canvases. No-ops without WebGL2 (jsdom/tests) or under `?debug`.
let effectsHost: HtmlEffectsHost | null = null;
let shaderRuntime: WebglShaderRuntime | null = null;
// gsw's live particle runtime (shares the WebGL2 context + clock with the shader runtime): scans for
// `[data-godot-particle-runtime]` nodes and runs the real CPU particle simulation. Its reconcile keeps unchanged
// systems running and re-inits only changed/new ones. No-ops without WebGL2 / under `?debug`.
let particleRuntime: ParticleRuntime | null = null;
// In PURE auto mode (no `?quality`/`?renderScale`/… override), an adaptive controller measures the real
// frame rate after load settles and ratchets the GPU-fill knobs down (renderScale first, then the FPS caps
// to a 25 floor) until the device holds a smooth rate — self-correcting per device + thermal state where the
// static heuristic can only guess. Null when an override is pinned, on the `minimum` tier, or without WebGL.
let adaptiveController: AdaptiveController | null = null;
// `renderQuality()` is the immutable seed; adaptive quality mutates live runtimes without changing it.
// Unsubscribe for the targeted texture-size listener (see onMounted).
let unsubscribeTextureSizes: (() => void) | null = null;
// Unsubscribe for the targeted atlas-region-blob listener (R10-PERF4 WS-4; see onMounted).
let unsubscribeAtlasRegions: (() => void) | null = null;
// Unsubscribe for this view's frame-pressure supplier (see onMounted).
let unregisterRenderPressure: (() => void) | null = null;
// Detach for the REPRO RECORDER's stage listeners (see onMounted). Held per MOUNT, not per session: a renderer
// swap remounts this component, and the recorder has to follow the new stage element without the recording being
// restarted (which would throw away the run the player is trying to capture).
let detachReproStage: (() => void) | null = null;

// 1080-tall design space, scaled-to-fit + clipped (godot-scene-web's `contentScale aspect:keep` rule).
// The game always lays out + hit-tests at 1920x1080 (headless co-op instances are pinned to it by
// HeadlessViewportConfigurator), so streamed transforms stay in 1920-space. On a screen WIDER than 16:9 we widen
// the design box up to MIRROR_MAX_DESIGN_WIDTH so there's less/no letterbox, and the renderer spreads elements
// horizontally by `w/1920` to fill it (a cosmetic reposition — see mirrorRenderer's spread walk). Below the base
// or with the stretch toggled off (the settings-panel checkbox, seeded from `?stretch=off`) it stays a fixed
// 1920 — flipping the toggle cascades live through the existing design/spreadFactor watchers (scale re-fit,
// renderer.setStretch + forced structural reconcile, input designWidth). Anything a screen parks OUTSIDE the box
// is clipped by `.mirror-stage`'s overflow, exactly as the game's own viewport clips it.
const design = computed<{ w: number; h: number }>(() => {
  if (!mirrorSettings.stretchEnabled || frameWidth.value <= 0 || frameHeight.value <= 0) {
    return { w: MIRROR_DESIGN_WIDTH, h: MIRROR_DESIGN_HEIGHT };
  }
  const wanted = Math.round((frameWidth.value / frameHeight.value) * MIRROR_DESIGN_HEIGHT);
  const w = Math.min(MIRROR_MAX_DESIGN_WIDTH, Math.max(MIRROR_DESIGN_WIDTH, wanted));
  return { w, h: MIRROR_DESIGN_HEIGHT };
});

// The horizontal spread factor the renderer applies (stageWidth / game-width). 1.0 on 16:9 → a no-op.
const spreadFactor = computed<number>(() => design.value.w / MIRROR_DESIGN_WIDTH);

// Is the page REALLY fullscreen right now? Only a fullscreen landscape measurement is allowed to correct the
// pin's `screen.*` seed downward (staticPin.ts); everything else can only ratchet it up. Guarded because jsdom
// (and older WebKit) may not define the property at all.
function isDocumentFullscreen(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement != null;
}

// The last shader ratio LOGGED (not the last pushed) — the pin is a device-tuning knob dialed in from the
// phone's console, so a change is worth one line, and a re-push of the same value is worth none.
let loggedPinRatio: number | undefined;

// Push the frozen-surface backing pin to whichever runtimes exist (staticPin.ts owns the target; this is the
// only place it reaches gsw at runtime). The ratio a family gets folds in that family's STATIC-mode backing
// scale (quality.ts' staticShaderScale/staticParticleScale) because the pin REPLACES `devicePixelRatio ×
// renderScale` while frozen — `setRenderScale` keeps being called too, and still governs the live modes.
// `undefined` is gsw's un-pinned path when a usable device target is unavailable.
// The `typeof` guards are the `stats()` idiom: gsw lands first, but the two branches can be run out of order.
function pushStaticPins(): void {
  if (!shaderRuntime && !particleRuntime) {
    return; // nothing to pin yet (pre-create) or ever (effects off) — and nothing worth logging
  }
  const pin = mirrorStaticPin();
  const quality = renderQuality();
  const shaderRatio = pin.ratioFor(quality.staticShaderScale);
  if (shaderRuntime && typeof shaderRuntime.setStaticShaderPixelRatio === "function") {
    shaderRuntime.setStaticShaderPixelRatio(shaderRatio);
  }
  if (particleRuntime && typeof particleRuntime.setStaticParticlePixelRatio === "function") {
    particleRuntime.setStaticParticlePixelRatio(pin.ratioFor(quality.staticParticleScale));
  }
  if (shaderRatio !== undefined && shaderRatio !== loggedPinRatio && typeof console !== "undefined") {
    loggedPinRatio = shaderRatio;
    // Box × ratio IS the backing store here, so this is the widest frozen canvas the stage can produce and
    // whether gsw's longest-edge clamp will bite. The BOX is design px on the default arm and DISPLAY px on the
    // `?stageFit=display` arm (gsw's `clientWidth` read follows the layout — see staticPin.ts), which is exactly
    // why the ratio drops its own fit term there: the two halves must name the same space or the log lies.
    const widest = Math.round((displayLayout ? design.value.w * scale.value : design.value.w) * shaderRatio);
    const clamped = widest > MAX_PINNED_BACKING_DIM ? ` — CLAMPED to ${MAX_PINNED_BACKING_DIM}` : "";
    console.info(
      `[mirror] static backing pin: shader ${shaderRatio.toFixed(3)}, fit target ${pin
        .targetFit()
        .toFixed(3)} (${pin.isCorrected() ? "measured" : "screen seed"})` +
        ` — full-stage backing ${widest}px${clamped}`
    );
  }
}

function recomputeScale(): void {
  const element = frame.value;
  if (!element) {
    return;
  }
  const { width, height } = element.getBoundingClientRect();
  if (width <= 0 || height <= 0) {
    return;
  }
  const resized = width !== frameWidth.value || height !== frameHeight.value;
  frameWidth.value = width;
  frameHeight.value = height;
  // THE FROZEN-SURFACE BACKING PIN (staticPin.ts): this measurement is the only real evidence the client has
  // about what "fullscreen landscape on this device" is, so feed it in. It moves the target rarely and by
  // design — a portrait/windowed measurement is ignored, and once a genuine fullscreen-landscape viewport has
  // corrected the `screen.*` seed the target is sticky — so this is a plain equality check on almost every
  // resize, and only a REAL move re-pushes the ratio to the runtimes.
  if (mirrorStaticPin().observeViewport(width, height, isDocumentFullscreen())) {
    pushStaticPins();
  }
  const rescaled = scale.value !== Math.min(width / design.value.w, height / design.value.h);
  scale.value = Math.min(width / design.value.w, height / design.value.h);
  // DISPLAY-SPACE LAYOUT: the fit is no longer a transform on one element, it is baked into every node's box and
  // matrix — so a fit change invalidates every emitted style and must force the scene-wide restyle walk. `false` on
  // the default arm always (the factor is pinned at 1 there), which is what keeps this line inert by construction.
  if (setLayoutScale(scale.value)) {
    // `setStaticStillGauge`-style ordering is irrelevant here, but the eager-scroll reset is not: an offset in
    // flight was measured against boxes that have just changed size (same reasoning as the spreadFactor watch).
    eagerScroll?.reset();
    scheduleRender(true, "stageFit");
    pendingRuntimeForce = true;
  }
  if (rescaled || resized) {
    // R10 WS-F: the input path caches the stage's client rect and only dropped it on a window resize/scroll. The
    // stage can move under BOTH of those: the widescreen stretch toggle rewrites design.w + scale from a computed,
    // and this ResizeObserver fires for a FRAME-only resize (a sibling panel) that no window event reports. A stale
    // rect is a silent LINEAR error on every mapped pointer. Invalidated on the next tick, once the new
    // width/height/transform have actually been written to the element (invalidation only clears — a re-measure
    // before the DOM caught up would just cache the old rect again).
    void nextTick(() => inputCapture?.invalidateStageRect());
  }
  if (resized) {
    // WS-2: every shader/particle canvas box just moved (the stage re-fits), so both runtimes re-measure
    // unconditionally — a re-layout the dirty bits deliberately don't track (it touches no marker).
    reconcileRuntimes("change");
  }
}

// R10-PERF4 WS-2 — EFFECTS-RECONCILE GATING. Reconciling every rendered frame is a whole-stage `querySelectorAll` sweep plus
// per-binding attribute re-reads, and the shader one brackets itself in `invalidateRects()` — which defeats gsw's
// 0.12s rect-cache TTL, so every SCREEN_UV binding pays a fresh `getBoundingClientRect` on the next tick. None of
// that can find anything new unless the reconciler actually touched an effect marker, a self-layer, an element's
// existence or an occlusion suspend — which is exactly what `renderer.consumeEffectsDirty()` reports.
// The self-heal interval (ms) for a hypothetical missed dirty site: while renders keep arriving, one unconditional
// reconcile per second. Armed ONLY from the render rAF and never re-armed by itself, so an idle scene is silent.
const RUNTIME_SAFETY_MS = 1000;
let runtimeSafetyTimer = 0;

// WHY a pass runs — it decides the reconcile scope:
//   • "frame"  — a rendered frame: reconcile per the dirty bits.
//   • "change" — mount, an effect-mode change, a stage resize, a spread re-layout: the runtimes were re-created /
//     re-measured, so reconcile BOTH — canvas boxes and even runtime identity may have moved.
//   • "safety" — the 1s self-heal pass: reconcile BOTH runtimes (its whole point is a missed dirty site).
// A "frame" or "safety" pass NEVER touches the frozen-surface `<img>` swap. gsw owns it, per surface: it draws
// into a (possibly hidden) canvas — safe, its sizing reads the always-visible self-layer — reports the paint to
// its own swap state, and hands that ONE surface back before the frame paints. A reconcile that redraws nothing
// therefore un-freezes nothing, which is the property this used to need a thaw gate to get: focusing a card
// (siblings move, wrapper transforms change, zero shader pixels change) never resurrects a canvas family.
//
// A "change" pass is the exception, and it is the whole of what the deleted `thawStaticStills()` thaw-all did:
// mount, an effect-mode change, a stage resize, a spread re-layout. Every one of those either re-creates the
// runtimes or MOVES every canvas box, and a stand-in copies its box once at freeze time — so a stale `<img>`
// would sit at the old box until gsw's watchdog window (up to 3s) re-synced it. Hand them all back instead and
// let each re-earn its swap on its next quiet window. `invalidateStaticSurfaces` reverts WITHOUT blocking, so
// this costs a re-encode, never a disqualification.
type ReconcileReason = "frame" | "change" | "safety";
function reconcileRuntimes(reason: ReconcileReason = "frame"): void {
  if (!sceneAblation.effectsStartupEnabled) {
    renderer?.consumeEffectsDirty();
    return;
  }
  // A later strict-capability refusal swaps the renderer inside `reconcile`.
  // Recreate DOM producers in that same rendered turn so the whole-stage
  // fallback is complete, rather than leaving shader/particle nodes blank
  // until a settings watcher happens to fire.
  if (activeStageBackend() === "dom") {
    if (!shaderRuntime && effectiveShaderMode.value !== "off") {
      applyShaderMode(effectiveShaderMode.value);
    }
    if (!particleRuntime && effectiveParticleMode.value !== "off") {
      applyParticleMode(effectiveParticleMode.value);
    }
  }
  const dirty = renderer?.consumeEffectsDirty();
  const all = reason !== "frame" || dirty === undefined;
  if (reason === "change") {
    invalidateStaticSurfaces();
  }
  if (all || dirty.shader) {
    shaderRuntime?.reconcile();
  }
  if (all || dirty.particle) {
    particleRuntime?.reconcile();
  }
}

// Arm the one-shot safety reconcile. Called from the render rAF, so it only ever exists while frames are being
// produced: it fires once ~1s later and does NOT re-arm — the next render arms it again. With no runtime to
// reconcile (effects off / the `minimum` tier) nothing is armed at all.
function armRuntimeSafety(): void {
  if (runtimeSafetyTimer || (!shaderRuntime && !particleRuntime)) {
    return;
  }
  runtimeSafetyTimer = window.setTimeout(() => {
    runtimeSafetyTimer = 0;
    // "safety", NOT "change": both runtimes get their self-heal reconcile, but frozen surfaces stay frozen — a
    // reconcile that draws nothing must cost nothing (rc5: an unconditional thaw here dismantled the whole
    // engaged fleet every second while the scene streamed). If this pass DOES redraw a hidden canvas, gsw's own
    // per-surface report hands that one surface back on the spot, and its watchdog is the standing backstop.
    reconcileRuntimes("safety");
  }, RUNTIME_SAFETY_MS);
}

// CLIENT-SIDE COALESCING — the load-bearing latency fix. Applying a delta to the retained state
// (mirrorClient → applySceneDelta) is cheap; the DOM reconcile is what's expensive. So rendering MUST be
// coalesced to one pass per animation frame, NOT run once per message: under load the game emits a delta
// almost every tick, and rendering each one synchronously would let messages (incl. the latency `pong`) pile
// up in the JS event loop on a slow device → unbounded growth (the ~6s lag). Here every revision bump just
// schedules a single rAF that reconciles the LATEST state (the reconciler reads `state.changedIds`, which
// accumulates across the coalesced deltas, so no change is missed). The render naturally throttles to the
// device's frame rate while always showing the newest state — bounded latency, never a backlog.
let renderRaf = 0;
// R6 P6-A: inside `runScheduledRender`. Two entry points now reach that body (the coalesced rAF and the
// renderer's pull), so a re-entrant call is possible in principle and is REFUSED rather than nested.
let renderRunning = false;
let pendingForceTextures = false;
// WS-2: a non-marker layout change (the spread re-layout) that must reach both gsw runtimes on the next rendered
// frame, whatever the dirty bits say.
let pendingRuntimeForce = false;
// Why the pending force was asked for — pure observability (mirrorWalkStats.fullWalkCauses). Last writer wins when
// two forces coalesce into one frame; they are rare and scene-wide either way.
let pendingForceReason: FullWalkCause | undefined;

// CONFIRM TAP — keep the button in step with the tree it is anchored to, once per rendered frame.
//
// Two facts, both only knowable here:
//   1. LIVENESS. `confirmTapTarget` answers null for an id that is no longer a confirm-eligible widget, which
//      covers every way a choice can stop being offered — the reward taken, the shop item bought, the event
//      resolved, the treasure vote finished, the room left. That is what takes the button down when the game (or
//      another player) ends the screen, and it is why the game's own Proceed/Leave button never has to be
//      special-cased: nothing is focused by then, so the button is already sliding out.
//   2. STACKING. Whether a modal overlay now paints over the option (see mirrorRenderer.coverAbove).
// The relic latch is swept on the same liveness answer, so "already selected" can never outlive its treasure room.
function syncConfirmTap(): void {
  const target = confirmTap.targetId;
  const latched = confirmedRelicTarget();
  renderer?.setConfirmCoverWatch(target !== null);
  if (latched !== null && renderer?.confirmTapTarget(latched) == null) {
    forgetConfirmedRelic();
  }
  if (target === null) {
    return;
  }
  if (renderer?.confirmTapTarget(target) == null) {
    hideConfirmTap();
    return;
  }
  setConfirmBelowOverlay(renderer.coverAbove(target));
}

function syncHandRaiseUi(): void {
  setHandRaiseLayer(renderer?.handRaiseUiLayer() ?? null);
}

/**
 * ONE RENDERED FRAME of the mirror pipeline — the body the coalesced rAF has always run, extracted (R6 P6-A) so
 * that the canvas backend can PULL it forward into its own animation frame instead of building a list against a
 * state this is about to replace. See `reconcileNow` below and mirrorRenderer's `ReconcilePull`.
 *
 * Re-entrancy is refused rather than queued: whoever is inside this call is already doing exactly the work a
 * second entry would ask for, and the caller that was refused still has its rAF (the pull cancels the booked
 * frame only AFTER this guard has let it through).
 */
function runScheduledRender(): void {
  if (renderRunning) {
    return;
  }
  sceneCheckpoint("render-begin");
  renderRunning = true;
  try {
    const force = pendingForceTextures;
    const reasonForWalk = pendingForceReason;
    pendingForceTextures = false;
    pendingForceReason = undefined;
    // R10 WS-E HARD RESET on a wire KEYFRAME (a reconnect, a stream re-gate, a host re-keyframe): the whole node map
    // was just re-established, so every eager offset is a claim about a tree that no longer exists — drop them and
    // adopt the streamed truth. Read BEFORE the reconcile, which is where the flag is consumed.
    if (props.state.sceneRewrite) {
      eagerScroll?.reset();
    }
    const presented = renderer?.reconcile(props.state, force ? { forceTextures: true, reason: reasonForWalk } : undefined);
    // Strict single-canvas sources may still be decoding into stage-owned
    // textures. Nothing has been presented in that state, so doing post-frame
    // composition or acknowledging the wire would falsely release a delta.
    if (presented === false) {
      return;
    }
    rewardFocusCoordinator?.afterReconcile(
      renderer?.rewardFocusSnapshot() ?? { screenId: null, rows: [] }
    );
    // R11 WS-S — SINGLE-WRITER COMPOSITION. The walk just wrote every scroll container's base `matrix()`, one host
    // lerp step further along than the frame before. Re-compose the eager translate against it NOW, before the
    // browser paints, so the composed position stays exactly where the player put it and the host's catch-up lands
    // inside the translate instead of on screen. Ordering-proof by construction: whichever of this and the engine's
    // own rAF ran first, the LAST word on a reconciled frame is this one. No-op (single `Map.size` check) unless
    // something is actually scrolled eagerly.
    eagerScroll?.afterReconcile();
    // CONFIRM TAP: the button is anchored to a widget in the tree that was just re-walked, so this is where both of
    // its tree-derived facts are refreshed (see confirmTap.ts / mirrorRenderer.coverAbove). No-op — one null check —
    // whenever no button is up, which is almost always.
    syncConfirmTap();
    // READABLE-HAND MODE: the HUD toggle button only exists while a combat hand does, and the walk that just ran is
    // what knows. Same once-per-rendered-frame slot as the confirm button's liveness above; a plain assignment that
    // only wakes a watcher on a real change.
    syncHandRaiseUi();
    const runtimeForce = pendingRuntimeForce;
    pendingRuntimeForce = false;
    reconcileRuntimes(runtimeForce ? "change" : "frame");
    // Self-heal for a dirty site this workstream might have missed (see armRuntimeSafety). Decays to silence on
    // its own: only a render can arm it, and it never re-arms itself.
    armRuntimeSafety();
    // The mirror pipeline just produced a frame — keep the adaptive-quality sampler's rAF loop armed (it goes
    // idle on its own after a few seconds of no activity, so a static/idle screen doesn't burn CPU forever).
    adaptiveController?.notifyActivity();
    // ...and tell gsw's encode pacing the same thing, so a ~30ms static-surface readback is not scheduled
    // into the middle of a burst of these (see framePressure.ts).
    noteMirrorFrame();
    // Ack AFTER the frame is rendered so the host releases the next coalesced delta (flow control): the stream
    // self-paces to however fast this device can actually render.
    sceneCheckpoint("frame-presented");
    props.onSceneRendered?.();
    if (renderer) firstPresentation.rendered();
  } catch (error) {
    firstPresentation.failed(error);
    throw error;
  } finally {
    renderRunning = false;
  }
}

function scheduleRender(forceTextures = false, reason?: FullWalkCause): void {
  if (forceTextures) {
    pendingForceTextures = true;
    pendingForceReason = reason;
  }
  if (renderRaf) {
    return;
  }
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    runScheduledRender();
  });
}

/**
 * R6 P6-A — run the pending coalesced reconcile RIGHT NOW, and drop the frame it was booked for.
 *
 * Handed to the renderer as `ReconcilePull.now`. The only caller is a backend whose own animation frame is about
 * to run in the same display frame as this one: rather than build a list from a state the reconcile is about to
 * replace (and pay for a second build and paint moments later), it spends its frame on the reconcile instead. The
 * scene ack therefore moves EARLIER inside the display frame it was already going to happen in — never into a
 * frame that did not render, because this runs the identical body.
 *
 * The guard order matters: refuse re-entry BEFORE cancelling, so a refused pull cannot swallow the booked frame.
 */
function reconcileNow(): void {
  if (renderRunning) {
    return;
  }
  if (renderRaf) {
    cancelAnimationFrame(renderRaf);
    renderRaf = 0;
  }
  runScheduledRender();
}

onMounted(() => {
  try {
    mountScene();
  } catch (error) {
    firstPresentation.failed(error);
    throw error;
  }
});

function mountScene(): void {
  // R7 W1 fix (d): page-wide GL context-loss reporting, installed before anything creates a context. The stage
  // counts its OWN losses, but when the GPU process goes every context on the page goes with it — including the
  // gsw effect runtimes' canvases, which on the DOM arm are the only ones there are.
  installGlContextEventReporter();
  // ARMED-WORK PRESSURE (framePressure.ts). A scheduled-but-unrun walk is the strongest jank signal there is:
  // the delta arrived, the rAF is booked, and the frame it will produce has NOT happened yet — which is
  // precisely the state the frame-recency term misreads as quiet, because recency only ever knows about frames
  // that already ran. Cheap by construction (one number compare) and self-clearing: `scheduleRender`'s callback
  // zeroes `renderRaf` before it reconciles, so this cannot latch on.
  unregisterRenderPressure = registerPressureSource(() => renderRaf !== 0);
  recomputeScale();
  observer = new ResizeObserver(recomputeScale);
  if (frame.value) {
    observer.observe(frame.value);
  }
  if (stage.value && defs.value) {
    // REPRO RECORDER (reproRecorder.ts) — the INPUT half of a recording, attached BEFORE the renderer and
    // inputCapture exist so nothing can be dispatched at this stage without the recorder having heard it. The
    // listeners it installs are capture-phase and passive, so they run ahead of inputCapture's own bubble-phase
    // handlers (which call preventDefault) and see the player's raw gesture rather than the mirror's reaction to
    // it. Attaching is free when the recorder is not armed — it registers the element and installs nothing.
    detachReproStage = reproRecorder.attachStage(stage.value);
    // The stage is still the DESIGN box — every coordinate, overlay and hit test is expressed in it, and the repro
    // recorder above and `inputCapture` below still measure against it. `canvasHost` is only WHERE THE CANVAS IS
    // LAID OUT; it is null on the DOM arm, which is exactly the "no host" the factory documents.
    renderer = createMirrorRendererFor(stage.value, defs.value, canvasHost.value);
    rendererRef.value = renderer;
    // R6 P6-A — offer the app's scheduled walk to a backend with its own frame loop (see ReconcilePull). Wired
    // HERE, after the renderer exists, and never between `attachStage` and `createMirrorRendererFor`: the
    // recorder has to be the last thing that touched the stage before the renderer is built. Optional method —
    // the DOM backend does not implement it, and this line is then a no-op.
    renderer.setReconcilePull?.({ pending: () => renderRaf !== 0, now: reconcileNow });
    // Client chrome must collect full-stage cover candidates even when the optional occlusion pass is disabled.
    // Keep the cheap pre-filter armed for this renderer's lifetime so the first combat frame is already correct.
    renderer.setConfirmCoverWatch(true);
    // READABLE-HAND MODE: seed the fresh renderer with the viewer's current choice (saved, URL, or the device
    // default). The watch below only sees CHANGES, and a renderer built after one would otherwise start off.
    renderer.setRaiseHandCards(effectiveRaiseHandCards.value);
    // READABILITY SCALING: same rule, and it matters more here — the flag is module-level and SHARED by every
    // renderer this page builds, so a viewer who switched it off and then crossed a remount (a reconnect, a
    // backend fallback) must not get a fresh renderer that quietly re-enlarges everything. Seeding from the store
    // makes the setting, not the last renderer, the source of truth.
    renderer.setUiScaling(mirrorSettings.uiScaling);
    // Targeted texture-size re-styles. Subscribed before the first reconcile below (an image load
    // is a macrotask, so nothing can resolve in between): a resolved natural size hands the renderer exactly the
    // nodes that styled provisionally against that url and schedules a NORMAL coalesced render, instead of the
    // scene-wide texture re-touch.
    unsubscribeTextureSizes = onTextureSizesResolved((ids) => {
      renderer?.markTextureDirty(ids);
      scheduleRender();
    });
    // R10-PERF4 WS-4 — the SAME targeted seam for atlas region blobs: a sprite paints through its <canvas> until
    // its region is baked, then exactly the nodes that asked for that region are re-styled and swap to the
    // (uncomposited) background-image div. Subscribed here for the same reason as above — a bake completes on a
    // macrotask, so nothing can resolve before the first reconcile below.
    unsubscribeAtlasRegions = onAtlasRegionsReady((ids) => {
      renderer?.markTextureDirty(ids);
      scheduleRender();
    });
    // Dev/live-verification seam: lets a debugging session
    // inspect the interactive rects the input side's hit-consistency pass sees.
    (window as unknown as Record<string, unknown>).__mirrorInteractiveRects = renderer.interactiveRects;
    // Read-only shop-removal QA geometry, shared by DOM and canvas through retained scene + interactiveRects.
    (window as unknown as Record<string, unknown>).__mirrorShopRemoval = () =>
      mirrorShopRemovalProbe(props.state.nodes, renderer?.interactiveRects() ?? []);
    // Same seam for the view-scale input registry (game-space channel/scaledBox/originalBox + the widened-space
    // renderedBox the false-halo guard tests) — read-only; scripts/probe-viewscale-halo-input.mjs drives off it.
    (window as unknown as Record<string, unknown>).__mirrorViewScaleInputStamps = renderer.viewScaleInputStamps;
    // …and the three HIT-TEST seams, as one read-only probe. This is the only way to ask the two stage backends
    // the same question: the DOM backend answers `touchStackAt` out of `elementsFromPoint`, the canvas backend
    // out of its draw list's hit entries, and the input side never sees the difference. The parity gate
    // (`bench-mirror-replay.mjs --hit-grid`) samples a grid through this on each backend and diffs the two — a
    // pure query, nothing is clicked and nothing is armed. A FUNCTION per call, like __mirrorShaderStats, so a
    // renderer swap cannot strand a stale binding.
    // `gameX`/`gameY` are the same point in the GAME's own 1920-space, which is what the confirm-tap
    // classification is asked in (`confirmTapAt`), and `coverAbove` is its companion verdict — the pair
    // MirrorView itself feeds the button through `syncConfirmTap`. Sampling both across a grid is how the parity
    // gate answers "would a tap here put a confirm button up, and would it be sunk under an overlay" on each
    // backend without pressing anything.
    (window as unknown as Record<string, unknown>).__mirrorHitProbe = (
      clientX: number,
      clientY: number,
      backdropWidthPx: number,
      gameX: number,
      gameY: number
    ) => {
      const confirm = renderer?.confirmTapAt(gameX, gameY) ?? null;
      return {
        stack: renderer?.touchStackAt(clientX, clientY) ?? null,
        painter: renderer?.spreadPainterAt(clientX, clientY, backdropWidthPx) ?? null,
        mapNode: renderer?.mapNodeAt(clientX, clientY) ?? null,
        confirm,
        cover: confirm ? (renderer?.coverAbove(confirm.id) ?? null) : null
      };
    };
    // READABLE-HAND MODE: the gates + per-holder ramp behind the hand's current height (see handRaiseDebug).
    (window as unknown as Record<string, unknown>).__mirrorHandRaise = renderer.handRaiseDebug;
    // Probe seam for the gsw effect-runtime counters (idiom of `__mirrorAtlasBakeStats`, atlasBaker.ts) — the
    // static-shader regression matrix diffs these across a gesture window. A FUNCTION, not the stats object:
    // the runtimes are created/disposed live by the panel's effect modes, so each call reads the CURRENT
    // handles. Always returns an object (probe scripts JSON.stringify it) — a family is null while its runtime
    // doesn't exist (mode Off / pre-create / after unmount), or on a gsw build predating the stats() seam
    // (the typeof guard; gsw lands first, but the branches can be run out of order).
    (window as unknown as Record<string, unknown>).__mirrorShaderStats = () => ({
      shader: shaderRuntime && typeof shaderRuntime.stats === "function" ? shaderRuntime.stats() : null,
      particle: particleRuntime && typeof particleRuntime.stats === "function" ? particleRuntime.stats() : null
    });
    sceneAblation.setLiveCounts(() => {
      const shaderStats = shaderRuntime && typeof shaderRuntime.stats === "function" ? shaderRuntime.stats() : null;
      const particleStats = particleRuntime && typeof particleRuntime.stats === "function" ? particleRuntime.stats() : null;
      return {
        liveSceneElements: stage.value?.querySelectorAll(".mirror-node").length ?? 0,
        shaderMarkers: stage.value?.querySelectorAll("[data-godot-shader-webgl]").length ?? 0,
        particleMarkers: stage.value?.querySelectorAll("[data-godot-particle-runtime]").length ?? 0,
        shaderRuntime: shaderRuntime !== null,
        particleRuntime: particleRuntime !== null,
        shaderStats,
        particleStats
      };
    });
    // Surface census seam, same idiom as __mirrorShaderStats: the <canvas> elements ranked by BACKING-STORE
    // bytes (width*height*4 — the allocation the GPU process holds, which a CSS size does not tell you), each
    // named by the nearest ancestor's data-scene-file / data-node-path stamp. "How many canvases" is already
    // countable from the DOM; "which ones own the memory" is not, and the answer is never uniform. It ships
    // with the page because a phone can only be asked through a console/CDP eval — the replay bench prints the
    // same rows from the same function under --census, so a device reading and a desktop one are comparable.
    (window as unknown as Record<string, unknown>).__mirrorTopSurfaces = (limit = 10) =>
      Array.from(document.querySelectorAll("canvas"))
        .map((canvas) => {
          const box = canvas.getBoundingClientRect();
          const owner = canvas.closest("[data-node-path]");
          const scene = canvas.closest("[data-scene-file]");
          return {
            w: canvas.width,
            h: canvas.height,
            bytes: canvas.width * canvas.height * 4,
            cssW: Math.round(box.width),
            cssH: Math.round(box.height),
            cls: String(canvas.className || "").split(/\s+/)[0] || "(none)",
            sceneFile: scene ? scene.getAttribute("data-scene-file") : null,
            nodePath: owner ? owner.getAttribute("data-node-path") : null
          };
        })
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, Math.max(1, limit));
    // The live source of `mirrorWalkStats.staticStillCanvases` — "how many effect surfaces are frozen right
    // now", the acceptance metric a device harness reads. Sampled at READ time from BOTH gsw runtimes'
    // `staticImagesLive` gauges (the swap is driven by gsw's own quiet-window timer, so a value published by
    // one of our passes would be stale on exactly the idle screen being measured). Same `typeof` guard as
    // __mirrorShaderStats: a runtime may not exist (mode Off) or predate the counter.
    setStaticStillGauge(staticSurfacesLive);
    // R17: the same idiom for the retained-still block (`mirrorWalkStats.staticStill*`) — one reader, sampled at
    // read time, over BOTH runtimes' gsw counters.
    setStaticStillCountersGauge(staticStillCounters);
    renderer.setStretch(spreadFactor.value);
    // Build the initial DOM synchronously so consumers (and the mount-based tests) see it immediately. This is a
    // real scene render too: a connection whose first live keyframe arrives before MirrorView mounts still spent
    // one host flow-control credit, so the initial reconcile must participate in the same diagnostic sequence and
    // return that credit just like a revision-driven reconcile does.
    sceneCheckpoint("render-begin");
    const initialPresented = renderer.reconcile(props.state);
    syncHandRaiseUi();
    // Create + configure the live WebGL runtimes from the effective per-viewer effect mode. `off` (the low-end
    // "off" tier, or the panel's Off) creates nothing — no DOM markers are stamped/consumed, so a runtime would
    // find nothing anyway, and skipping it avoids the per-reconcile querySelectorAll scan. Non-off modes create
    // the runtime and set its frozen mode (Static) + backing-store scale (½/¼). The mode watches below re-apply
    // this live when the viewer changes a mode (create/dispose/retune, no reload).
    applyShaderMode(effectiveShaderMode.value);
    applyParticleMode(effectiveParticleMode.value);
    reconcileRuntimes("change");
    if (props.sendInput) {
      // R10 WS-E — EAGER SCROLLING. Built before inputCapture because the capture takes it as a collaborator: it
      // gets first refusal on a wheel tick over the map / a card grid, owns the one-finger pan there, and
      // compensates every resolved coordinate while the local offset runs ahead of the host's.
      const sendInput = props.sendInput;
      eagerScroll = createEagerScroll({
        targets: () => renderer?.eagerScrollTargets() ?? [],
        send: (message) => sendInput(message),
        // M0 — the local offset is WRITTEN by whatever backend painted the node, and "where is it painted" is
        // asked of the same backend. The engine keeps the arithmetic and stops touching elements.
        applyLocalOffset: (nodeId, dy) => renderer?.applyLocalOffset(nodeId, dy),
        scrollRenderedY: (nodeId) => renderer?.scrollRenderedY(nodeId) ?? null,
        // The letterbox scale's reciprocal — the trackpad's 1:1 pixel mapping is measured in DESIGN px.
        designPerClientPx: () => (scale.value > 0 ? 1 / scale.value : 1),
        // The current session contract always supports the absolute channel.
        sendScroll: props.sendScroll,
      });
      // Pass the LIVE widened design width so pointer coords map onto the actual stage width (up to 2520 on an
      // ultra-wide screen) and invert each node's anchor shift — see designCoord. The renderer's interactive-rects
      // provider is handed in for the input side's hit-consistency pass (agent B wires its consumption). The
      // onHeldCard callback feeds the renderer's cosmetic touch-drag card lift (setHeldCard) — forced to null
      // while the viewer has the setting off, so a disabled toggle never lifts anything even mid-drag.
      inputCapture = createInputCapture(
        stage.value,
        props.sendInput,
        () => design.value.w,
        renderer.interactiveRects,
        (id, x, y, mode) => renderer?.setHeldCard(mirrorSettings.raiseHeldCard ? id : null, x, y, mode),
        {
          raiseHeldCard: () => mirrorSettings.raiseHeldCard,
          unfocusOnRelease: () => mirrorSettings.unfocusOnRelease,
          tapToFocus: () => mirrorSettings.tapToFocus,
          isFocused: (id) => props.state.nodes.get(id)?.focused === true,
          noteTouchTarget: (id) => rewardFocusCoordinator?.noteTouchTarget(id),
          isCard: (id) => renderer?.isCardTouchTarget(id) ?? false,
          isHandCard: (id) => renderer?.isHandCard(id) ?? false,
          // Below-line drag-drop cancel: a HAND card dropped below its play-zone floor de-selects (right-click).
          playZoneThreshold: (d) => playZoneThreshold(MIRROR_DESIGN_HEIGHT, d),
          // End-turn below-button un-hover (R4 change 2): resolved release point → the button's game-space box.
          endTurnBoxAt: (x, y) => renderer?.endTurnBoxAt(x, y) ?? null,
          // #12: a from-hand card-choice dialog (Survivor discard / exhaust / enchant) → single-tap selection.
          handChoiceActive: () => renderer?.handChoiceActive() ?? false,
          // CONFIRM TAP (confirmTap.ts): on the widgets whose tap spends a run reward, a tap only focuses and the
          // client-side confirm button commits. Both read live, so a settings flip lands on the next tap.
          confirmTap: () => mirrorSettings.confirmTap,
          confirmTapAt: (x, y) => renderer?.confirmTapAt(x, y) ?? null
        },
        // FIX 3 (R7): the live GAME-space view-scale input registry, so a hover/tap over an enlarged view-scale item
        // (an ancient-event option, a reward/shop item) maps back onto its true hit box (viewScaleInverse). Empty off
        // a view-scale screen ⇒ the inverse is identity ⇒ input byte-identical.
        () => renderer?.viewScaleInputStamps() ?? [],
        eagerScroll,
        // R11 WS-M — map-node travel. Wired only when the action channel exists (a receive-only mirror keeps plain
        // coordinate clicks); the router itself refuses while a drawing tool is armed.
        props.sendAction
          ? createMapNodeTapRouter({
              sendAction: props.sendAction,
              drawingToolActive: () => renderer?.mapDrawingToolActive() ?? false,
              // M0 — WHICH map point is under the finger is the renderer's answer, not a DOM walk of this module's.
              mapNodeAt: (x, y) => renderer?.mapNodeAt(x, y) ?? null
            })
          : undefined,
        // READABLE-HAND MODE: the hit surfaces the renderer draws away from where the game has them, so a tap on a
        // raised card reaches the card. Empty whenever the mode is off / the hand is down ⇒ input untouched.
        () => renderer?.raiseInputStamps() ?? [],
        // M0 — the renderer's own input probes (touchStackAt / spreadPainterAt). The DOM backend answers them with
        // the same z-stack walks the input modules used to run inline, so this is byte-identical there; a canvas
        // stage answers from its draw list, where there are no elements to walk.
        renderer
      );
      // BROWSER GAMEPAD. No stage, no renderer, no coordinate — a pad token is not a place — so it takes only the
      // send path and the live setting. Construction is safe everywhere: without the Gamepad API (every plain-HTTP
      // origin) it attaches nothing and polls nothing.
      gamepadCapture = createGamepadCapture({
        send: (message) => sendInput(message),
        enabled: () => mirrorSettings.gamepad
      });
      rewardFocusCoordinator = createRewardFocusCoordinator({
        modality: lastPressModality,
        canControl: () => props.sendInput !== undefined,
        input: inputCapture
      });
      // A mouse/pen press changes modality without waiting for another scene delta. Only the coordinator's narrow
      // programmatic readiness is cleared; the user's ordinary tap-to-focus arm remains intact. Asked of the
      // coordinator, not of InputCapture directly, so that latch has exactly one owner.
      unsubscribePressModality = onPressModalityChange((modality) => {
        if (modality === "pointer") rewardFocusCoordinator?.releaseReady();
      });
      if (initialPresented !== false) {
        rewardFocusCoordinator.afterReconcile(renderer.rewardFocusSnapshot());
      }
      (window as unknown as Record<string, unknown>).__mirrorRewardFocus = () => ({
        modality: lastPressModality(),
        ...renderer?.rewardFocusSnapshot()
      });
      // CONFIRM TAP: resolve the button's three sprites now, not on the first tap — a tap that finds them missing
      // falls back to the ordinary two-step, and the whole point is that the reward screens never behave that way.
      // Only a CONTROLLING client needs them (a receive-only mirror has no gestures), and only while the setting is
      // on; flipping it on later primes then. Idempotent, so both callers can be unconditional.
      if (mirrorSettings.confirmTap) {
        void primeConfirmSprites();
      }
      watch(
        () => mirrorSettings.confirmTap,
        (on) => {
          if (on) {
            void primeConfirmSprites();
          } else {
            hideConfirmTap();
          }
        }
      );
    }
    startAdaptiveQuality();
    if (initialPresented !== false) {
      sceneCheckpoint("frame-presented");
      props.onSceneRendered?.();
      firstPresentation.rendered();
    }
  }
}

// Map an effect mode to the runtime backing-store scale. The two DYNAMIC variants pick the resolution axis (½/¼)
// on every device — that is what makes those panel settings mean the same thing on a phone and on a desktop —
// `dynamic` is full res, and `off` disposes the runtime (scale irrelevant).
//
// STATIC is the one exception, and it is a DEVICE decision, not a panel one (quality.ts' staticShaderScale /
// staticParticleScale: 0.5 / 0.25 on a phone, 1 on a desktop). `static` briefly returned a flat 1 here; on the map
// screen of a Mali-G57 phone that made the frozen shaders re-render full-screen per scene-delta and took
// StartDrawToSwapStart p50 from 6.5ms to 126ms. The MODE still means the same thing everywhere (the real effect,
// rendered once) — only the backing store the phone can afford differs, exactly like the tier's renderScale.
// `?staticScale=` / `?staticShaderScale=` / `?staticParticleScale=` A/B it live.
function scaleForMode(mode: EffectMode, family: "shader" | "particle"): number {
  switch (mode) {
    case "dynamic-half":
      return 0.5;
    case "dynamic-quarter":
      return 0.25;
    case "static":
      return family === "shader" ? renderQuality().staticShaderScale : renderQuality().staticParticleScale;
    default:
      return 1; // dynamic
  }
}

// M2 — "a gsw runtime just painted this binding's canvas", spread into BOTH runtimes' options below.
//
// OPTIONAL METHOD, NO BACKEND DETECTION. The DOM backend does not implement `noteEffectRendered` and does not need
// to: it leaves gsw's canvas in the page, where the browser composites it, so a render notification tells it
// nothing it has to act on. The CANVAS backend does implement it, because for that stage the canvas is a texture
// SOURCE — the notification is the only signal its pixels changed, and it is the third demand source that keeps an
// animating effect's re-upload scheduled (and, when nothing is animating, lets the stage park).
//
// A plain function rather than an inline lambda per runtime, so the two are provably the same call.
function noteEffectRendered(node: HTMLElement, surface: HTMLCanvasElement, info: GodotEffectRenderInfo): void {
  renderer?.noteEffectRendered?.(node, surface, info);
}

// LINK THE COMBAT SHADERS NOW, so the frame that first needs one does not.
//
// A cold link BLOCKS on a device without `KHR_parallel_shader_compile`, and the phone this round is gated on has
// none — the Aug-28 trace carries a 90.3 ms `getProgramParameter` task mid-combat. Warming cannot make that link
// cheaper; it only moves it here, where the runtime is created (join / effect-mode change), rather than onto the
// frame a card is played. See `shaderWarmSpecs`.
//
// FIRE AND FORGET, and both halves of that are deliberate. Nothing waits on it: every one of these shaders has a
// working lazy path and a working CSS/SVG fallback, so a warm that never finishes costs exactly today's
// behaviour. And the `typeof` guard is the `invalidateStaticSurfaces` idiom — a gsw build without `warmPrograms`
// must still run.
function warmShaderPrograms(runtime: WebglShaderRuntime): void {
  if (typeof runtime.warmPrograms !== "function") return;
  const specs = shaderWarmSpecs();
  if (specs.length === 0) return;
  void runtime.warmPrograms(specs).catch(() => {
    // A warm is an optimisation; a rejection means the nodes take the path they take today.
  });
}

// One owner for DOM effect bindings; toggling a family preserves the other's state.
function syncEffectsHost(shaders: boolean, particles: boolean): HtmlEffectsHost | null {
  if (!stage.value) return null;
  effectsHost ??= createHtmlEffectsHost(stage.value);
  effectsHost.updateOptions({
    shaderOptions: {
      ...mirrorShaderRenderOptions,
      externalRuntimes: false,
      enableWebglShaders: shaders,
      onBindingRendered: noteEffectRendered
    },
    particleOptions: {
      ...mirrorParticleRenderOptions,
      externalRuntimes: false,
      enableParticles: particles,
      onBindingRendered: noteEffectRendered
    }
  });
  shaderRuntime = effectsHost.shaders;
  particleRuntime = effectsHost.particles;
  return effectsHost;
}

// Apply the effective SHADER mode to the live runtime: `off` disposes it (tears down the per-node canvases without
// a reload); any other mode creates it if needed (re-attaching to the markers the reconciler already stamped) then
// sets frozen mode (Static ⇒ setStaticShaders) + backing-store scale (½/¼ ⇒ setRenderScale). No-op in tests / the
// `minimum` tier where WebGL2 is unavailable (create returns a no-op runtime).
function applyShaderMode(mode: EffectMode): void {
  if (!stage.value || !sceneAblation.effectsStartupEnabled) return;
  // Strict canvas owns effect pixels through its stage resources. Constructing
  // gsw's DOM runtime here would create child canvases even on a scene that
  // otherwise passed admission. A capability fallback flips `activeStageBackend`
  // before this function is reached on initial mount, so the DOM path still
  // receives its normal runtime.
  if (false) {
    return;
  }
  if (mode === "off") {
    syncEffectsHost(false, particleRuntime !== null);
    return;
  }
  if (!shaderRuntime) {
    shaderRuntime = syncEffectsHost(true, particleRuntime !== null)?.shaders ?? null;
    if (!shaderRuntime) return;
    sceneAblation.noteEffectRuntimeStarted("shader");
    shaderRuntime.reconcile();
    // The construction options carry the pin's SEED (shaderResources.ts), which is right for the first
    // runtime but stale for one created after a fullscreen-landscape measurement corrected the target — so
    // re-push before freezing, and the freeze below sizes straight into the pinned store.
    pushStaticPins();
    warmShaderPrograms(shaderRuntime);
  }
  shaderRuntime.setStaticShaders(mode === "static");
  shaderRuntime.setRenderScale(scaleForMode(mode, "shader"));
  // Set the fps cap EXPLICITLY rather than leaning on the construction option: a runtime that survived an
  // adaptive-quality downgrade (or was created under a different tier field) would otherwise keep a stale cap
  // behind a mode the viewer just chose by hand. `?shaderFps=` still wins — it is part of the resolved quality.
  shaderRuntime.setFps(renderQuality().shaderFps);
}

// The PARTICLE sibling of applyShaderMode (Static ⇒ setStaticParticles — the gsw runtime's frozen-frame mode).
function applyParticleMode(mode: EffectMode): void {
  if (!stage.value || !sceneAblation.effectsStartupEnabled) return;
  if (mode === "off") {
    syncEffectsHost(shaderRuntime !== null, false);
    return;
  }
  if (!particleRuntime) {
    particleRuntime = syncEffectsHost(shaderRuntime !== null, true)?.particles ?? null;
    if (!particleRuntime) return;
    sceneAblation.noteEffectRuntimeStarted("particle");
    particleRuntime.reconcile();
    pushStaticPins(); // same seed-vs-corrected reason as the shader side
  }
  particleRuntime.setStaticParticles(mode === "static");
  particleRuntime.setRenderScale(scaleForMode(mode, "particle"));
  // Same explicit cap as the shader side. It matters more here: the tiers that used to disable particles
  // outright (`static`) carried a placeholder particleFps of 0 — i.e. UNCAPPED — so a phone that turned
  // particles on from the panel would have simulated them harder than the desktop it is meant to match.
  particleRuntime.setFps(renderQuality().particleFps);
}

// THE SCENE-WIDE THAW — the direct replacement for the old `thawStaticStills(family?)`. Called from the
// "change" reconcile pass (see reconcileRuntimes for which events those are).
//
// The couch-coop policy (shaderResources.ts) vetoes NEW frozen surfaces in any non-static effect mode, but a
// veto only ever refuses; it cannot un-freeze what is already standing. So leaving Static would otherwise leave
// a fleet of `<img>` stand-ins over canvases the runtime has just started animating again.
//
// Both runtimes, unconditionally: it is a no-op when nothing is swapped, and the alternative (invalidate only
// the family whose mode moved) has to stay in sync with two watchers for no measurable gain.
//
// These remain compatibility guards, not rollout scaffolding: source consumers can intentionally pair this app
// with a gsw revision that predates one optional capability. Missing invalidation simply leaves the runtime's
// normal swap watchdog in charge; it must never make a mode change, resize, or disposal fail.
function invalidateStaticSurfaces(): void {
  if (shaderRuntime && typeof shaderRuntime.invalidateStaticSurfaces === "function") {
    shaderRuntime.invalidateStaticSurfaces();
  }
  if (particleRuntime && typeof particleRuntime.invalidateStaticSurfaces === "function") {
    particleRuntime.invalidateStaticSurfaces();
  }
}

// "How many effect surfaces are frozen right now" — the sum of both gsw runtimes' `staticImagesLive` gauges.
// Installed as the reader behind `mirrorWalkStats.staticStillCanvases` (see onMounted) and sampled on each read.
// `?? 0` keeps a gsw build predating the counter working rather than throwing on a missing field.
function staticSurfacesLive(): number {
  const s = shaderRuntime && typeof shaderRuntime.stats === "function" ? shaderRuntime.stats() : null;
  const p = particleRuntime && typeof particleRuntime.stats === "function" ? particleRuntime.stats() : null;
  return (s?.staticImagesLive ?? 0) + (p?.staticImagesLive ?? 0);
}

// R17 — the RETAINED-STILL counters, read the same way and for the same reason (gsw's own timers, and its
// module-wide pool, move these with nothing on our side running). Installed as the reader behind the
// `mirrorWalkStats.staticStill*` block; the `typeof`/`?? 0` guards are the `staticSurfacesLive` idiom, so a gsw
// build predating any one counter reads 0 rather than throwing at a bench sample.
//
// TWO KINDS OF NUMBER, and they must not be folded the same way:
//   • the COUNTERS are per runtime, so they SUM (a claim served by either fleet is a claim);
//   • `staticStillRetained*` are gsw's MODULE-WIDE pool gauges, which every runtime reports a copy of — so they
//     take the MAX. Summing them would double-count the same pool and read as if the budget were half what it is.
// The DONOR block is particle-only by construction (only the particle runtime holds departing bindings alive to
// bake), so it is read off that runtime alone rather than defended with an `in` check.
function staticStillCounters(): MirrorStaticStillCounters {
  const s = shaderRuntime && typeof shaderRuntime.stats === "function" ? shaderRuntime.stats() : null;
  const p = particleRuntime && typeof particleRuntime.stats === "function" ? particleRuntime.stats() : null;
  return {
    cacheHits: (s?.staticStillCacheHits ?? 0) + (p?.staticStillCacheHits ?? 0),
    cacheMisses: (s?.staticStillCacheMisses ?? 0) + (p?.staticStillCacheMisses ?? 0),
    mounts: (s?.staticStillMounts ?? 0) + (p?.staticStillMounts ?? 0),
    bakes: (s?.staticStillBakes ?? 0) + (p?.staticStillBakes ?? 0),
    donors: p?.staticStillDonors ?? 0,
    donorBakes: p?.staticStillDonorBakes ?? 0,
    donorsDropped: p?.staticStillDonorsDropped ?? 0,
    retainedEntries: Math.max(s?.staticStillRetainedEntries ?? 0, p?.staticStillRetainedEntries ?? 0),
    retainedBytes: Math.max(s?.staticStillRetainedBytes ?? 0, p?.staticStillRetainedBytes ?? 0)
  };
}

// A deliberate panel selection means the viewer has taken manual control of the effect quality → stop the auto
// adaptive-quality controller so an auto-downgrade never fights the choice (its own `isPinned` guard also honors
// the flag; stopping it halts the measurement loop's per-frame cost too).
function pinEffects(): void {
  if (mirrorSettings.effectModePinned) {
    return;
  }
  mirrorSettings.effectModePinned = true;
  adaptiveController?.stop();
  adaptiveController = null;
}

// Per-viewer effect-mode changes (settings panel) drive the runtimes live (create/dispose/retune — see
// applyShaderMode/applyParticleMode), and pin the effect quality so the adaptive controller steps aside.
watch(effectiveShaderMode, (mode) => {
  applyShaderMode(mode);
  // WS-2: a create/dispose/retune must re-attach to the markers already in the DOM. The "change" pass also hands
  // any standing frozen surfaces back — leaving Static must not leave a stale `<img>` over a re-animating canvas.
  reconcileRuntimes("change");
  pinEffects();
});
watch(effectiveParticleMode, (mode) => {
  applyParticleMode(mode);
  reconcileRuntimes("change");
  pinEffects();
});

// The QUALITY row (settings panel) pins too, and not only via the two watches above. Picking a rung normally
// moves both effect modes, but it need not: choosing `Very low` while the rows already read Static changes
// nothing they watch, and that still has to count as the viewer taking manual control — otherwise the auto
// downgrade controller would keep ratcheting underneath a quality the player just chose by hand. (`auto` is
// excluded: it is the request to be auto-detected, which is the opposite of a pin. It returns the DEVICE levers
// to detection on the next load; the sampler this session is already running or already stopped.)
watch(
  () => mirrorSettings.quality,
  (choice) => {
    if (choice !== "auto") {
      pinEffects();
    }
  }
);

// Flipping the "raise held card" setting off mid-drag must clear the lift immediately, not just stop future
// reports (the touch drag itself keeps running — inputCapture doesn't know/care about the setting).
watch(
  () => mirrorSettings.raiseHeldCard,
  (on) => {
    if (!on) {
      renderer?.setHeldCard(null, 0, 0);
    }
  }
);

// READABLE-HAND MODE: push the live setting into the renderer, which re-runs its pass immediately (no reconcile —
// it writes a `translate` onto elements that are already built). `immediate` so a viewer whose saved/device default
// is ON gets the raise on the very first renderer this view creates, not on the first setting change.
watch(
  effectiveRaiseHandCards,
  (on) => renderer?.setRaiseHandCards(on)
);

// READABILITY SCALING (the view scale, the HoverTip enlargement, the text-scale table, the clip-axis outset).
// The renderer's own `setUiScaling` does the immediate half — it repairs what its backend already drew — and the
// FULL walk here is what the other direction needs: a view-scale item is registered inside `visit`, and while the
// switch was off nothing registered, so only a structural walk can bring the items back. It is also what re-runs
// the per-node style resolve for the text-scale classes on a settled screen. Same shape as the occlusion and
// static-bg watches above, and forced for the same reason: skip-clean would visit nothing at all here.
watch(
  () => mirrorSettings.uiScaling,
  (on) => {
    renderer?.setUiScaling(on);
    scheduleRender(true, "uiScale");
  }
);

// BROWSER GAMEPAD: the capture reads the setting live per poll, so turning it OFF is picked up on the next frame
// (and releases anything held). Turning it back ON needs the nudge — a parked capture has no frame in which to
// notice — which is all this watch is for.
watch(
  () => mirrorSettings.gamepad,
  () => gamepadCapture?.refresh()
);

// Start the adaptive render-quality controller when eligible (pure auto mode + effects on + a runtime exists).
// It drives the gsw runtime setters live, so a downgrade re-tunes resolution/FPS without a dispose+recreate.
function startAdaptiveQuality(): void {
  const quality = renderQuality();
  if (!isAdaptiveEligible(quality, typeof window !== "undefined" ? window.location.search : "") || (!shaderRuntime && !particleRuntime)) {
    return;
  }
  adaptiveController = createAdaptiveController({
    seed: {
      renderScale: quality.renderScale,
      shaderFps: quality.shaderFps,
      particleFps: quality.particleFps
    },
    apply: {
      renderScale: (value) => {
        shaderRuntime?.setRenderScale(value);
        particleRuntime?.setRenderScale(value);
      },
      shaderFps: (value) => shaderRuntime?.setFps(value),
      particleFps: (value) => {
        particleRuntime?.setFps(value);
      }
    },
    hasScene: () => props.state.orderedIds.length > 0,
    // Once the viewer pins an effect mode in the panel, the controller steps aside (MirrorView also stops it).
    isPinned: () => mirrorSettings.effectModePinned,
    onChange: (change) => {
      if (typeof console !== "undefined") {
        console.info(
          `[mirror] adaptive quality: ${change.reason} @ ${Math.round(change.medianFps)}fps` +
            ` — renderScale ${change.renderScale}, shaderFps ${change.shaderFps || "∞"}, particleFps ${change.particleFps}`
        );
      }
    }
  });
  adaptiveController.start();
}

// Every applied delta schedules a coalesced render (see scheduleRender). Default flush is fine — we rAF anyway,
// so several revision bumps within a frame collapse into ONE reconcile of the latest state.
watch(() => props.revision, () => scheduleRender());

// R19 WP5 — hand the host's absolute-scroll answer to the engine. The app publishes a FRESH object per ack, so an
// identity watch sees every one; the engine drops any that does not match a live send. Nothing schedules a render
// here: the ack only steers the settle, which the engine's own rAF is already running.
watch(
  () => props.scrollAck,
  (ack) => {
    if (ack) {
      eagerScroll?.noteScrollAck(ack);
    }
  }
);

// The design space is unknown until the first scene arrives (and can change with the viewport aspect), so
// rescale whenever it changes — otherwise the stage stays at the initial 1920x1080 and clips a taller viewport.
watch(design, recomputeScale);

// A change in the horizontal spread factor (viewport aspect crossed a boundary) re-places every node, so hand the
// renderer the new factor and force a STRUCTURAL reconcile (full keyframe) — skip-clean would otherwise leave
// unchanged nodes at the old spread.
watch(spreadFactor, (f) => {
  renderer?.setStretch(f);
  // R10 WS-E HARD RESET: the stretch toggle re-lays-out every node and re-fits the stage, so an eager offset (and
  // the pan/wheel run behind it) is measured against geometry that is about to be replaced.
  eagerScroll?.reset();
  scheduleRender(true, "spread");
  // WS-2: the forced FULL walk already dirties both runtimes, but a spread re-layout moves every canvas box, so
  // say it outright rather than leaning on the walk's conservative bump.
  pendingRuntimeForce = true;
});

// The manual spine mode (Auto/Dynamic/Static/Off) is read at the two gates in spineAttributes, which the renderer
// consults per node — but a spine node is only re-evaluated when it is DIRTY, so an idle scene (a map, a settled
// combat) would keep its current canvases until something else moved it. Force a FULL walk on the flip so every
// spine node re-runs updateSpineLayer immediately: Off tears the canvases down, Dynamic/Static re-request the other
// url (the still-vs-animated answer is part of the clip identity — see mirrorRenderer's spineStill). Same idiom as
// the spreadFactor/textureSizeVersion watches above (and the effect-mode watches, which retune their runtimes live).
watch(
  () => mirrorSettings.spineMode,
  () => scheduleRender(true, "spine")
);

// The overlay-backstop occlusion toggle. A full walk is REQUIRED here, not just nice: the renderer's cover
// PRE-FILTER runs inside `visit` and decides membership with the per-node alpha floor this switch moves, so a
// backstop that only qualifies under the exception is registered as a candidate on a walk that visits it — and a
// settled screen (map open over a static combat) visits nothing. Turning it OFF likewise needs the re-walk to drop
// the candidate; the occlusion pass itself then releases the gate and hands every frozen canvas back on that walk.
watch(
  () => mirrorSettings.backstopOcclusion,
  () => scheduleRender(true, "occlusion")
);

// STATIC-BG BUILD HOLD. The renderer's hold is a pure function of the setting,
// and a HELD root is skip-clean by construction — same node object, same cached ctx — so an update walk would
// swallow the release. A FULL walk is therefore mandatory in BOTH directions: `structural` bypasses `visit`'s
// skip-clean gate, and the same walk's reclaim hands back any subtree that was built while the hold was off.
// so the setting edge is the only event that may release or reclaim a covered live subtree.
watch(
  () => mirrorSettings.staticBgEnabled,
  () => scheduleRender(true, "staticBg")
);

onBeforeUnmount(() => {
  firstPresentation.dispose();
  document.removeEventListener("visibilitychange", firstPresentation.visibilityChanged);
  setHandRaiseLayer(null);
  // The gauges outlive nothing: with the runtimes gone they would keep calling into disposed handles.
  setStaticStillGauge(null);
  setStaticStillCountersGauge(null);
  sceneAblation.setLiveCounts(null);
  // Same rule for the pressure supplier: an unmounted view's `renderRaf` is a closure over a dead component.
  unregisterRenderPressure?.();
  unregisterRenderPressure = null;
  unsubscribeTextureSizes?.();
  unsubscribeTextureSizes = null;
  unsubscribeAtlasRegions?.();
  unsubscribeAtlasRegions = null;
  // The recorder keeps running across a remount (see the declaration) — what must not survive is a listener on a
  // stage element this component no longer owns.
  detachReproStage?.();
  detachReproStage = null;
  adaptiveController?.stop();
  adaptiveController = null;
  unsubscribePressModality?.();
  unsubscribePressModality = null;
  rewardFocusCoordinator?.dispose();
  rewardFocusCoordinator = null;
  delete (window as unknown as Record<string, unknown>).__mirrorRewardFocus;
  inputCapture?.dispose();
  inputCapture = null;
  // Releases anything the pad is still holding on its way out — an unmount mid-press must not leave the seat
  // holding a button.
  gamepadCapture?.dispose();
  gamepadCapture = null;
  eagerScroll?.dispose();
  eagerScroll = null;
  if (renderRaf) {
    cancelAnimationFrame(renderRaf);
    renderRaf = 0;
  }
  if (runtimeSafetyTimer) {
    clearTimeout(runtimeSafetyTimer);
    runtimeSafetyTimer = 0;
  }
  observer?.disconnect();
  observer = null;
  effectsHost?.dispose();
  effectsHost = null;
  shaderRuntime = null;
  particleRuntime = null;
  renderer?.dispose();
  renderer = null;
  rendererRef.value = null;
});

// THE STAGE BOX. On the default arm: the design box, scaled to fit with one transform — and that transform is what
// WebKit ignores when it sizes the backing store of every composited layer beneath it (stageFit.ts's header).
// On the display arm the same rendered rect is expressed as a real CSS box with NO transform, so a layer's backing
// store matches the screen area it occupies. Flex centring on `.mirror-frame` lands both on the same pixels: it
// centres the border box either way, and `transform-origin: center center` makes the scaled one concentric with it.
const stageStyle = computed(() =>
  displayLayout
    ? {
        width: `${design.value.w * scale.value}px`,
        height: `${design.value.h * scale.value}px`,
        // The live factor, published to CSS for the one consumer that cannot be given it any other way: the
        // generated text-scale sheet, which is built once at install and so carries its few absolute px as
        // `calc(Npx * var(--mirror-layout-scale))` (textScaleClasses.ts). Inherited by every mirror node.
        "--mirror-layout-scale": String(scale.value)
      }
    : {
        width: `${design.value.w}px`,
        height: `${design.value.h}px`,
        transform: `scale(${scale.value})`
        // "--godot-text-scale": String(DEFAULT_TEXT_SCALE)
      }
);

// THE GAME'S TEXT-EFFECTS SWITCH, as one attribute on the stage.
//
// The rules it gates are @spirectl/presentation's (the wavy / bouncing rich text), and they read it off ANY
// ancestor — so one write here reaches every label on both arms: the DOM renderer's nodes and the canvas backend's
// overlay elements are both inside `.mirror-stage`. Bound as an object rather than spelled out in the template so
// the attribute NAME stays the presentation package's to choose.
const textEffectsAttribute = computed(() => ({
  [RICH_TEXT_EFFECTS_ATTRIBUTE]: mirrorSettings.textEffects ? "on" : "off"
}));

/**
 * THE CHROME'S DESIGN-SPACE LAYER (display arm only).
 *
 * The slotted content is CouchCoop's OWN browser-only chrome — the confirm button, the hand-raise button, the
 * settings gear, the repro badge, the static-background underlay — authored in design px so it rides the game
 * transform. Unlike the mirror nodes it is NOT emitted through `nodeStyles`, so nothing bakes the factor into it,
 * and on the display arm it would render at full 1920-space size over a fitted stage.
 *
 * It gets a scaled wrapper instead of a conversion, deliberately: this is a handful of elements (measured against
 * the 1,318 promoted elements of the game tree), so the ancestor-transform layer cost this whole change exists to
 * remove is negligible here — while converting the chrome would mean baking the factor into hand-written component
 * CSS, which is both a much larger edit and one no test covers. `transform-origin: 0 0` with `left/top: 0` is the
 * top-left placement the chrome already assumes; the design arm renders NO wrapper at all, so its DOM is unchanged.
 */
const chromeLayerStyle = computed(() => ({
  width: `${design.value.w}px`,
  height: `${design.value.h}px`,
  transform: `scale(${scale.value})`
}));

// THE CANVAS HOST'S BOX: the design box AFTER the letterbox fit, in real CSS px, with no transform — that is the
// whole point (see `canvasHostLayout`). Its `inset: 0; margin: auto` lands it on exactly the pixels flex centering
// puts the scaled `.mirror-stage` on: both are "centre a box of this size in the frame", and the fitted box is by
// construction never wider or taller than the frame, so the auto margins can never be asked for a negative value
// (which is the one case where they would give up and left-align instead).
const canvasHostStyle = computed(() => ({
  width: `${design.value.w * scale.value}px`,
  height: `${design.value.h * scale.value}px`
}));

// THE BELOW-THE-CANVAS DESIGN-SPACE LAYER (canvas arm only) — today that is the host-rendered static background,
// which the stage canvas composites OVER and which therefore cannot ride the stage above it. It is a second
// design box, fitted the same way, and it is positioned by `left/top: 50%` plus a `translate(-50%, -50%)` in front
// of the scale rather than by flex: the frame's flex centring is spent on `.mirror-stage`, and a second in-flow
// item would lay the two out side by side. The two placements are the same arithmetic — centre the design box in
// the frame, then scale it about its own centre — so this layer, the canvas host and the stage all land on one
// rect. A transform here is free: everything in this layer is DOM, which the scaled subtree only SUPERSAMPLES.
const underlayStyle = computed(() => ({
  width: `${design.value.w}px`,
  height: `${design.value.h}px`,
  transform: `translate(-50%, -50%) scale(${scale.value})`
}));

</script>

<template>
  <div ref="frame" class="mirror-frame" data-testid="mirror-frame">
    <svg class="mirror-defs" aria-hidden="true" focusable="false">
      <defs ref="defs"></defs>
    </svg>
    <!-- THE CANVAS ARM'S TWO EXTRA LAYERS, in paint order and only when `?stage=canvas` asked for them. The stage
         canvas cannot live inside a scaled ancestor without being resampled twice (see `canvasHostLayout`), so the
         one thing that has to paint UNDERNEATH it — the static background, in design space — gets its own fitted
         design box here, and the canvas gets an untransformed host of its own. Everything that paints ABOVE the
         canvas (the renderer's DOM overlays, the slotted chrome) stays in `.mirror-stage`, which follows both. -->
    <template v-if="canvasHostLayout">
      <div v-if="canvasUnderlayRequired" class="mirror-stage-underlay" :style="underlayStyle">
        <slot name="underlay" />
      </div>
      <!-- Stage mode still mounts the slot component so it can feed the canvas texture bridge; it renders no DOM
           element there. Keeping this separate from the `behind` layer prevents a mount-cycle blind spot. -->
      <template v-if="!canvasUnderlayRequired"><slot name="underlay" /></template>
      <div ref="canvasHost" class="mirror-canvas-host" :style="canvasHostStyle"></div>
    </template>
    <div
      ref="stage"
      class="mirror-stage"
      :class="{ 'mirror-stage-over-canvas': canvasHostLayout }"
      :style="stageStyle"
      v-bind="textEffectsAttribute"
    >
      <!-- On the DOM arm the underlay slot renders here, exactly where its content has always been: a foreign
           stage child whose own most-negative z-index (not DOM order) puts it beneath the mirror nodes.
           DISPLAY ARM: it is design-space content like the chrome, so it rides the same kind of scaled layer — but
           the layer must CARRY the most-negative z-index itself, because a transform makes it a stacking context
           and would otherwise trap StaticBackground's own z-index inside it. Same value, same effect: beneath every
           mirror node whatever the reconciler's order pass does. -->
      <template v-if="!canvasHostLayout">
        <div
          v-if="displayLayout"
          class="mirror-chrome-layer mirror-underlay-layer"
          :style="chromeLayerStyle"
        >
          <slot name="underlay" />
        </div>
        <slot v-else name="underlay" />
      </template>
      <!-- Browser-only controls rendered in design space so they scale with the game transform.
           The slot content is a sibling to the imperatively-managed mirror nodes and is never
           touched by the reconciler.
           DISPLAY ARM: the stage itself is no longer scaled, so the chrome gets its own design-space layer to ride
           (see `chromeLayerStyle`). The wrapper is out of flow and zero-size-agnostic — `position: absolute` at the
           stage origin — so it cannot disturb the imperatively-appended mirror nodes around it. The DEFAULT arm
           renders the bare slot exactly as before: no wrapper element, no stacking context, no DOM change. -->
      <div v-if="displayLayout" class="mirror-chrome-layer" :style="chromeLayerStyle">
        <slot />
      </div>
      <slot v-else />
    </div>
  </div>
</template>

<style scoped>
.mirror-frame {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mirror-defs {
  position: absolute;
  width: 0;
  height: 0;
  pointer-events: none;
}

.mirror-stage {
  position: relative;
  transform-origin: center center;
  flex: 0 0 auto;
  /* THE STAGE MUST BE A STACKING CONTEXT, and it has to say so itself. StaticBackground's underlay sits at the
     most-negative z-index there is, which only stays UNDER the stage's own background and OVER `.mirror-frame`'s
     letterbox black while it is resolved inside this element's stacking context. `position: relative` with
     `z-index: auto` does not create one — on the design arm the stage's `transform: scale()` was quietly doing it,
     so removing the transform for `?stageFit=display` sent the underlay behind the frame's #000 and the combat
     background vanished entirely while every other node still painted. `isolation: isolate` states the invariant
     without a transform, and is a no-op on the design arm, where the transform already establishes one. */
  isolation: isolate;
  /* CouchCoop's OWN chrome (never a gsw/@spirectl presentation element): what shows through while the host-rendered
     static background is still decoding, in the ultra-wide strip the 2520-wide picture does not cover, and wherever
     the live bg subtree is held unbuilt (R12). `.mirror-frame` stays #000 — that is the LETTERBOX; the stage is the
     game's own box, and a near-black grey reads as "this room hasn't painted yet" rather than as a hole punched in
     the app. Safe under StaticBackground's most-negative z-index: CSS paints an element's own background below ALL
     its descendants, negative-z-index ones included.
     ON THE CANVAS ARM this moves down to `.mirror-stage-underlay` (see `.mirror-stage-over-canvas` below), because
     there the stage paints ABOVE the game surface instead of around it. */
  background-color: #181818;
  /* Clip the fixed 16:9 design box: nodes a screen parks outside the 1920x1080 viewport (e.g. another player's
     off-screen controls) are hidden here, matching the game's own viewport clip — see the `design` comment. It
     also clips StaticBackground's 2520-wide picture down to the stage (StaticBackground.vue:37-41). */
  /* This `overflow: hidden` makes the stage a SCROLL CONTAINER, and Chrome then promotes it — its compositing
     reasons really are "Is the document.rootScroller.; Is a scrollable overflow element using accelerated
     scrolling." That looks alarming next to an 8374x3767 layer on a 2712x1220 phone screen, and it is NOT a
     raster-scale bug: `Layer.width/height` is the layer's BOUNDS, which a device reports in PHYSICAL px
     (2401 design px x 3.4876 dsf = 8374) because Chrome uses zoom-for-dsf. Measured with cc's own snapshots
     (scripts/probe-stage-raster-scale.mjs, Aug-18-2026, Chromium 147, design 2399x1080 @dpr 3.4876): the stage
     layer rasters at contents_scale 0.3260 == its ideal_contents_scale, tiling 2729x1229 == the presented
     screen. Replacing the clip with `clip-path: inset(0)` or `contain: paint`, or moving it to `.mirror-frame`,
     was A/B'd and moved NOTHING (179 tiles / 9.93 Mpx in every arm; the frame variant was slightly worse at
     183 / 10.08 and loosens the clip). Don't re-litigate this without a cc-snapshot number — the page's real
     raster surplus is `Overlap`-promoted near-full-screen node layers, not the stage. */
  overflow: hidden;
  /* A controlling client drags cards by holding the pointer; without this the browser starts a text selection
     (or a touch scroll/zoom on phones) instead of letting inputCapture replay the drag gesture. */
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

/* DISPLAY ARM ONLY (`?stageFit=display`). CouchCoop's own chrome keeps its design-space box and rides a scale
   transform of its own, because the stage above it no longer carries one — see `chromeLayerStyle`. Out of flow at
   the stage's top-left so it overlays the mirror nodes rather than displacing them, scaled about that same corner
   (`transform-origin: 0 0`) so design (0,0) stays the stage's (0,0). Pointer events pass through the wrapper itself
   (it is a full-design-box rectangle and would otherwise swallow every tap meant for the game) while its CHILDREN —
   the real buttons — take their own back. */
.mirror-chrome-layer {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  pointer-events: none;
}

.mirror-chrome-layer > * {
  pointer-events: auto;
}

/* The underlay's own design-space layer carries the most-negative z-index that StaticBackground's `<img>` would
   otherwise carry alone — the transform above makes this element a stacking context, which would contain that
   z-index instead of letting it reach the stage's own stacking order. Same number, so the outcome is the same:
   beneath every mirror node, DOM order irrelevant. */
.mirror-underlay-layer {
  z-index: -2147483648;
}

/* CANVAS ARM ONLY. The stage no longer paints the "this room hasn't painted yet" fill, because it now sits ABOVE
   the stage canvas: an opaque background here would hide the game entirely. The fill moves down to
   `.mirror-stage-underlay`, which is the same box in the same place, one layer below the canvas — so what a viewer
   sees is unchanged. Written as a two-class selector, not as an override that depends on rule order. */
.mirror-stage.mirror-stage-over-canvas {
  background-color: transparent;
}

/* THE CANVAS HOST: the fitted design box, laid out in real CSS px with NO transform (see the ref's comment). Sized
   inline from `design × scale`; `inset: 0` + auto margins centre it on the same rect flex centring gives the
   scaled stage. Out of flow deliberately — `.mirror-frame` is a flex container and a second in-flow item would be
   laid out BESIDE the stage rather than over it. Takes no pointer: the stage covers the same rect and owns input,
   and the canvas inside is `pointer-events: none` for the same reason. */
.mirror-canvas-host {
  position: absolute;
  inset: 0;
  margin: auto;
  pointer-events: none;
}

/* THE BELOW-THE-CANVAS DESIGN-SPACE LAYER (canvas arm only): the static background's design box, fitted by the
   same scale as the stage and clipped by the same overflow, carrying the stage's own #181818 (see above). Its
   `transform` is written inline — `translate(-50%, -50%) scale(fit)` against `left/top: 50%` — because the frame's
   flex centring is already spent on the stage; the result is the same centred, scaled box. */
.mirror-stage-underlay {
  position: absolute;
  left: 50%;
  top: 50%;
  transform-origin: center center;
  overflow: hidden;
  background-color: #181818;
  pointer-events: none;
}
</style>

<!-- Unscoped: these classes are applied to elements the reconciler creates imperatively (outside any component
     template), so scoped `data-v-*` attributes wouldn't match. Ported verbatim from the old MirrorNodeView. -->
<style>
.mirror-node {
  position: absolute;
  transform-origin: top left;
  /* `auto` (not `none`) so a controlling client can hit-test rendered nodes for hover/click. The self-layers
     (shader/particle canvases) keep `pointer-events: none` so events fall through them to the node behind. */
  pointer-events: auto;
  /* Never let a held-pointer drag over a node turn into a text selection (cards are dragged to play). */
  user-select: none;
  -webkit-user-select: none;
}

/* The complete pair of ribbon strokes for an accepted combat-card comet is shared-canvas-owned. Particles and
   silhouettes retain their existing DOM/gsw surfaces above this layer; none of these nodes accepts input. */
.mirror-node.mirror-dom-vfx-owned {
  display: none !important;
}

.mirror-dom-vfx-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* CouchCoop's own mirror chrome: a client-only cosmetic lift of a touch-dragged card above the fingertip
   (mirrorRenderer's setHeldCard sets `translate` directly, composing with the game-driven baked `matrix()` on
   this same element — see the enemy-intent "bob" precedent). Transition ONLY `translate`, never `transform`, so
   this can't smear the game's own transform-follow while the card streams a fresh position every frame. */
/* Transition removed because it makes the tooltip feel delayed */
/* .mirror-card-liftable {
  transition: translate 140ms ease-out;
} */

/* The held-card lift's ease, CARDS ONLY (tooltips share .mirror-card-liftable and stay instant — the transition
   there is what made the tip feel delayed). The lift is a constant offset (the card's position itself follows the
   game's streamed transform), so easing its on/off edges costs no finger-tracking lag; what it buys is that the
   play-zone flip — a 300px jump with no transition — reads as a quick slide instead of a card blinking in and out. */
.mirror-held-card {
  transition: translate 120ms ease-out;
}

/* READABLE-HAND MODE (mirrorSettings.raiseHandCards): the hand holders and the creature health-bar / intent groups
   the renderer cosmetically moves. Transition ONLY `translate` — `transform` is the game's own streamed placement
   and must never smear — so the mode's toggle, and the hand dropping for a drag and coming back, read as a slide.
   A holder mid-hand-tween overrides the duration inline with the tween's own (applyHandRaisePass), so the lift and
   the game's motion land together; this rule is the default for everything else. */
.mirror-hand-raisable {
  transition: translate 160ms ease-out;
}

/* A clip container's OWN paint (texture + own tint/blend/opacity), split off the container element so its
   filter/opacity/blend don't cascade onto the nested clip children. Fills the container box (inset:0); the
   container's overflow:hidden + border-radius clip it to the capsule. Backmost — nested children paint over it. */
.mirror-clip-self {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* Overlay the gsw WebGL shader runtime attaches its canvas into (base texture via
   data-godot-shader-texture-url). Fills the node, behind the node's own children/text in paint order. */
.mirror-shader-self {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* Atlas-sprite paint: a per-node canvas the renderer draws the atlas region into (decode-once, no full-atlas
   re-decode). Fills the region-sized node box; the node's transform scales it (keep-aspect fit). */
.mirror-atlas-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* Atlas-sprite paint, DEFAULT mechanism (R10-PERF4 WS-4): the same box as .mirror-atlas-canvas, but painting the
   region's BAKED BLOB as a background image instead of a <canvas>. Identical geometry (the renderer applies the
   same inset/size/placement styles to either element) — the difference is that this one is not a forced
   composited layer. `background-size: 100% 100%` reproduces the canvas's stretch-to-box exactly. */
.mirror-atlas-region {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background-repeat: no-repeat;
  background-size: 100% 100%;
  pointer-events: none;
}

/* Atlas-sprite PAGE placeholder (Stage C item 1): the same box as the
   two mechanisms above, but page-cropping the atlas PAGE itself while the region blob is unbaked/undecoded or
   the baker is suspended. The renderer writes background-image/-position/-size inline (gsw regionBackgroundStyle
   crop math), so NO background-size default here — the class only supplies the box + repeat contract. Painted,
   not composited: this is what removes the placeholder canvas fleet (941 on the degraded phone map). */
.mirror-atlas-page {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background-repeat: no-repeat;
  pointer-events: none;
}

/* R10-PERF6 WS-B: the still <img> standing in for a canvas that is de-promoted while a translucent overlay
   backstop covers it. It CARRIES THE CANVAS'S OWN CLASS as well (so `.mirror-atlas-canvas` /
   `.mirror-spine-canvas` supply the placement contract verbatim, and an <img>'s default `object-fit: fill`
   reproduces a canvas's stretch-to-box); this class only blockifies it and keeps it out of hit-testing. */
.mirror-frozen-canvas {
  display: block;
  pointer-events: none;
}

/* Enemy-intent glyph, COMPOSITOR path (R10-B1, see mirror/intentStrip.ts). The VIEWPORT stands exactly where the
   single-frame atlas canvas would (same box, same placement semantics) and clips to one cell; the STRIP canvas
   inside it holds every frame side by side and is stepped by a `translate` + `steps()` animation, so the glyph
   cycles without the renderer ever asking for a main-thread frame. */
.mirror-intent-view {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
}

.mirror-intent-strip {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}

/* Enemy-intent glyph IMG path (Stage C item 3): the SAME N-cell strip as
   above, stepped by the SAME `translate` animation — only the pixels come from a worker-baked <img> instead of a
   <canvas>, so nothing here is a promoted compositor texture layer. Placement is therefore the strip canvas's
   (absolute at the viewport origin; the renderer writes the N-cell width/height inline), plus `display: block` an
   <img> needs and would otherwise get an inline box's baseline gap. The default `object-fit: fill` stretches the
   strip into that box exactly as a canvas's backing store stretches into its CSS box. */
.mirror-intent-img {
  position: absolute;
  left: 0;
  top: 0;
  display: block;
  pointer-events: none;
}

/* Line2D stroke (the map quill annotations). A ZERO-BOX wrapper anchored at the node's local origin: the node's
   element bakes its matrix at local (0,0), so the <svg> inside draws in the node's own local space and the
   producer's node-local points land verbatim. `overflow: visible` on both wrapper and svg because the stroke
   necessarily extends far outside this 0x0 box — the box must NEVER be sized/positioned from the points' bounding
   box, or every appended point would shift the origin and slide the whole stroke. */
.mirror-line {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  overflow: visible;
  pointer-events: none;
}

/* Synthesized card trail (the comet behind a flying card) — the SAME zero-box wrapper contract as .mirror-line,
   and for the same reason: an `NCardTrail` streams an identity transform at the world origin, so the node-local
   space its element bakes IS design space and the ribbon's coordinates land unchanged. Sizing this from the
   ribbon's bounds would slide the whole trail every time a point is appended or aged out. */
.mirror-trail {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  overflow: visible;
  pointer-events: none;
}

/* Overlay the gsw particle runtime mounts its canvas into. `overflow: visible` so the runtime can grow the
   canvas beyond the (often point-emitter, tiny) node box by its sprite/emission pad without clipping. */
.mirror-particle-self {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}

/* SpineSprite clip canvas (mirror-managed; the clip's sole visual). Internal resolution = the clip's shared
   canvas (px); the reconciler sets its `transform` (translate localX,localY + scale) so this maps canvas-pixel
   space into the node-local space the parent .mirror-node's matrix then projects to screen, and blits each
   frame with ctx.drawImage. transform-origin 0 0 so that mapping starts at the node origin (the skeleton root). */
.mirror-spine-canvas {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  pointer-events: none;
}

/* Geoclip canvas (see mirror/geoclipPlayer.ts): the same placement contract as
   .mirror-spine-canvas — internal resolution = the baked clip's shared canvas, transform maps that canvas-pixel
   space into node-local — because it stands in exactly the box the baked clip occupied. Declared separately
   rather than reusing the class so the two can never be confused by the still/canvas mechanism swap, the
   paint-cull promotion probe, or the freeze/thaw selectors, all of which key off `.mirror-spine-canvas`. */
.mirror-geoclip-canvas {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  pointer-events: none;
}

/* …and the "in place of" half. A node with a live geoclip hides its baked spine layer WHEREVER it is and
   WHATEVER it currently is: the renderer swaps that element between a <canvas> and an <img> asynchronously
   (setSpineMechanism), so a descendant rule on the node is the only placement that keeps holding after a swap.
   Both mirror-managed elements — CouchCoop's own chrome, not @spirectl/presentation DOM.

   "Wherever it is" is TWO places, not one. A painted node with no children carries its own paint directly; a
   painted node WITH children gets a backmost `.mirror-clip-self` wrapper and its paint moves in there (see
   mirrorRenderer's selfLayer). A live creature is the second shape — it has bone children — so a child-only
   rule matched nothing and the node drew BOTH layers at once. Spelled as two explicit levels rather than a
   bare descendant selector on purpose: a nested `.mirror-node` keeps its own paint under its OWN
   `.mirror-clip-self`, so this stays scoped to the geoclip node and cannot blank a child node's spine. */
.mirror-geoclip-live > .mirror-spine-canvas,
.mirror-geoclip-live > .mirror-spine-img,
.mirror-geoclip-live > .mirror-spine-placeholder,
.mirror-geoclip-live > .mirror-clip-self > .mirror-spine-canvas,
.mirror-geoclip-live > .mirror-clip-self > .mirror-spine-img,
.mirror-geoclip-live > .mirror-clip-self > .mirror-spine-placeholder {
  display: none;
}

/* SpineSprite still frame: the same placement contract as .mirror-spine-canvas, but the element
   IS the tight-cropped frame — the reconciler folds the frame's offset within the shared canvas into the
   transform — so a single-frame clip costs no composited layer. */
.mirror-spine-img {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  pointer-events: none;
}

/* CREATURE PLACEHOLDER (mirror/creaturePlaceholder.ts) — the stand-in a creature or the shop merchant shows
   while its baked art is late, after it has failed, or permanently on the hard-off tier where none is fetched.
   The same placement contract as the two layers above, and no `scale()` in its transform: the renderer writes
   the box in the spine node's OWN local units, so the node element's matrix already supplies the rig scale.

   An <img>'s default `object-fit: fill` is doing real work here — the source is one fixed 200x200 image and
   every creature's box is a different size and aspect, so it is STRETCHED on both axes to fill the box exactly
   (which is what was asked for) rather than letter-boxed inside it. Both backends mount this same class, so this
   one rule serves the DOM stage and the canvas stage's overlay alike. CouchCoop's own mirror chrome, not
   @spirectl/presentation DOM. */
.mirror-spine-placeholder {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  pointer-events: none;
  object-fit: fill;
}

/* Aug-25 SPINE SUBTREE PAINT CULL. On a high-DPR phone (measured: Moto G86 / Chrome 151 / dpr 3.4876) Blink stops
   recording paint partway across a large `.mirror-spine-img`, and the stage background shows through the rest of
   it — a black rectangle over the shop. (Spine drives whole ROOM BACKGROUNDS here, not just creatures, which is
   why the symptom is scenery-sized.) The cull is SUBTREE-LOCAL (a ruler in stage space paints edge
   to edge; the same ruler inside the spine node's subtree truncates at exactly the same boundary), it is not a
   texture- or layer-SIZE clamp, and it is triggered by the composited effect surfaces the game hangs off the
   skeleton — three of them in the shop, and removing any ONE of them still leaves the image cut.

   Giving the spine node its own composited layer paints it in full. This is the ONLY placement that worked on the
   device: `will-change`/`contain: paint` on the <img>, `will-change` on the intermediate bone node, and
   `contain: layout` here were all still cut, and `contain: paint` on `.mirror-clip-self` clips the subtree away
   (that element is a 0×0 box). The class is applied by mirrorRenderer's applySpinePromotionPass — deliberately
   NOT a `:has()` rule — only to a node that is BOTH painting a still and has an effect surface in its subtree, so
   the layer is paid for once rather than per spine node. */
.mirror-spine-promoted {
  will-change: transform;
}

.mirror-range-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: currentColor;
  opacity: 0.55;
}

.mirror-text {
  width: 100%;
  height: 100%;
  display: flex;
  white-space: pre-wrap;
  line-height: 1.1;
}

/* Carries the godot rich-text classes without generating its own box. */
.mirror-rich {
  display: contents;
}
</style>
