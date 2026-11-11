<script setup lang="ts">
// "Use new renderer (Beta)" — the stage that shows the game through godot-scene-web's render-stream client: the
// game's own draw calls, replayed on one canvas. Couch chrome only; the protocol loop, the wasm and its teardown
// all belong to `@godot-scene-web/render-stream-client`.
//
// What this component owns:
//   * the <canvas>: a W×1080 backing store, W being the seat's presentation width (`GRC_ROOT_SIZE=presentation:<W>x1080`,
//     the descriptor's `presentation`: 1920, or wider when the seat was launched at this viewer's aspect),
//     CSS-fitted at that aspect inside the frame (letterboxed: a box whose aspect changed since the seat started, a
//     rotated phone, keeps the seat's width until its next start), honouring the safe-area padding
//     preference exactly as MirrorView's frame does;
//   * the client's lifetime: created and connected on mount, disposed on unmount (heap, socket, GL context);
//   * the loading line until the first drawn transaction, and "Reconnecting…" while the package backs off;
//   * the hidden tab: rAF stops by itself (so no credit returns and the hub stops publishing to us); after
//     60 s hidden the client is disposed outright, and a visible tab reconnects as a fresh join ON A NEW CANVAS:
//     the package's `dispose()` loses the canvas's WebGL context for good (`WEBGL_lose_context`), and a canvas keeps
//     that lost context, so a client given the old one connects and then draws nothing;
//   * `unauthorized` (the hub refused the token: the seat restarted with a new one): ask MirrorApp ONCE for the
//     seat's current descriptor (`refresh-endpoint`); a different one arriving reconnects with it, the same one (or
//     none within `refreshTimeoutMs`) is a stop;
//   * the fallback: a `failed` or `ended` status is emitted as `failed(reason)` for MirrorApp to fall back on;
//   * the extension modules: built from the viewer's four module settings and the seat's presentation width at
//     mount, so a change to any of them mid-session remounts the client (a fresh canvas and a fresh join) with the
//     new list — the modules' `wants` ride the hello, so an attached client cannot gain or drop one in place.
//
// VIEW ONLY when `sendInput` is absent (the dev probe, a receive-only page). With `sendInput`, the stage also owns
// the input channel: pointer events over the canvas → the pointer mapping → the seat socket's `input` message
// (streamInput.ts: godot-scene-web's pointer capture behind couch's adapter); and the keyboard and gamepad
// (keyPadInput.ts: the same package's captures behind couch's adapter), on the same socket.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import {
  createRenderStreamClient,
  type RenderStreamClient,
  type RenderStreamClientOptions,
  type RenderStreamCore,
  type RenderStreamEndpoint,
  type RenderStreamStats,
  type RenderStreamStatus
} from "@godot-scene-web/render-stream-client";

import { translate as t } from "@/i18n";
import type { MirrorInputMessage } from "@/mirror/mirrorClient";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { RENDER_STREAM_HIDDEN_DISPOSE_MS } from "@/mirror/renderStreamAvailability";
import { createKeyPadInput, type KeyPadInput } from "@/mirror/keyPadInput";
import { createStreamInput, type StreamInput } from "@/mirror/streamInput";
import { buildStreamExtensions } from "@/stream-ext/extensions";
import type { ConfirmTapController } from "@/stream-ext/confirmTap";
import type { HeldCardController } from "@/stream-ext/heldCard";
import type { PointerTargetModule } from "@/stream-ext/pointerTargets";

const props = withDefaults(defineProps<{
  endpoint: RenderStreamEndpoint;
  core: RenderStreamCore;
  /** Injectable for specs; the package's factory otherwise. */
  createClient?: (options: RenderStreamClientOptions) => RenderStreamClient;
  /** The upstream input sender (the seat socket's `input` message); absent ⇒ the stage stays view-only. */
  sendInput?: (message: MirrorInputMessage) => void;
  /** A hidden stage can draw its first frame while the visible mirror still owns input. */
  inputEnabled?: boolean;
  /**
   * The host-access generation the input belongs to (MirrorApp's `hostAccess.generation`). A new one retires the
   * pointer, keyboard and gamepad captures silently and starts fresh ones that ignore a button, finger or pad
   * control still held from before.
   */
  accessGeneration?: number;
  hiddenDisposeMs?: number;
  /** How long an `unauthorized` stream waits for the seat's current descriptor before it stops. */
  refreshTimeoutMs?: number;
}>(), {
  createClient: undefined,
  sendInput: undefined,
  inputEnabled: true,
  accessGeneration: undefined,
  hiddenDisposeMs: RENDER_STREAM_HIDDEN_DISPOSE_MS,
  refreshTimeoutMs: 10_000
});

const emit = defineEmits<{
  /** The stream stopped for good this session (`<reason>: <detail>`, or `ended`). */
  failed: [reason: string];
  status: [status: RenderStreamStatus];
  /** The stream drew its first frame: the join's "the browser displays the game" step. Once per mount. */
  "first-frame": [];
  /** The hub refused our token: send the seat's current descriptor (a new `endpoint` prop), once. */
  "refresh-endpoint": [];
}>();

type Phase = "connecting" | "loading" | "streaming" | "reconnecting" | "suspended" | "failed";

const frameEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
// Bumped whenever a client has been disposed and another may follow: the <canvas> is keyed on it, so every client gets
// a canvas whose WebGL context nobody has lost yet.
const canvasGeneration = ref(0);
const phase = ref<Phase>("connecting");
// Which carrier the open connection uses (`client.stats().carrier`, read when the session arrives): the stage's
// `data-stream-carrier`, so QA reads the carrier from the DOM instead of from CDP network events. Null while not
// streaming.
const carrier = ref<RenderStreamStats["carrier"]>(null);
let client: RenderStreamClient | null = null;
// INP2: the pointer channel, created/disposed alongside the client (the canvas is re-keyed per client generation, so a
// fresh client gets a fresh capture on the fresh canvas), and recreated on a new access generation like the pair
// below. `streamInputEpoch` retires a replaced channel's sends the same way `keyPadEpoch` does.
let streamInput: StreamInput | null = null;
let streamInputEpoch = 0;
// The mounted client's held-card and confirm-tap controllers, which a recreated pointer channel drives again.
let inputModules: {
  heldCard: HeldCardController | null;
  confirmTap: ConfirmTapController | null;
  pointerTargets: PointerTargetModule | null;
} | null = null;
// The keyboard and gamepad, created and disposed with the client like `streamInput` (unmount, the hidden dispose, an
// extension remount), and recreated on a new access generation. `keyPadEpoch` retires a replaced pair's sends: its
// releases on dispose belong to the old generation, which the host has already let go of.
let keyPadInput: KeyPadInput | null = null;
let keyPadEpoch = 0;
// CONFIRM TAP: the live module controller (recreated per client mount), whose reactive `state` drives the button.
const confirmController = shallowRef<ConfirmTapController | null>(null);
// Bumped when the canvas's CSS box moves or resizes (a resize, a rotation, the safe-area preference), so the confirm
// button's page-px anchor — the client's `presentationToCss`, which reads the live layout — is recomputed.
const layoutTick = ref(0);
let layoutObserver: ResizeObserver | null = null;
// The extension inputs the mounted client was built from (see `extensionsKey`); null while no client is mounted.
let mountedExtensionsKey: string | null = null;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
// Whether this mount has told the app it drew (`first-frame`): the join completes on the first frame, not every one.
let firstFrameReported = false;
// The `unauthorized` refresh: asked at most once per stream (re-armed by a drawn frame), and while it is pending
// the descriptor the client was refused with and the timer that gives up on a new one.
let refreshAsked = false;
let refreshPending: { refused: RenderStreamEndpoint; timer: ReturnType<typeof setTimeout> } | null = null;

const UNAUTHORIZED = "live-connect-failed: unauthorized";

// The seat's presentation (the descriptor's, 1920×1080 when it names none): the canvas's backing store before the
// client sizes it from the same value, and the aspect the canvas is letterboxed at.
const presentation = computed<[number, number]>(() => props.endpoint.presentation ?? [1920, 1080]);
const boxStyle = computed(() => ({ "--render-stream-aspect": String(presentation.value[0] / presentation.value[1]) }));

function sameDescriptor(a: RenderStreamEndpoint, b: RenderStreamEndpoint): boolean {
  return a.url === b.url && a.resourceBase === b.resourceBase && a.token === b.token && a.protocol === b.protocol;
}

const overlayText = computed(() => {
  switch (phase.value) {
    case "connecting": return t("loading.connecting");
    case "loading": return t("loading.loading");
    case "reconnecting": return t("loading.reconnecting");
    default: return null;
  }
});

// CONFIRM TAP: the button's live anchor, in page px. The module holds the widget's presentation-space rect; the
// client maps it through `presentationToCss` (canvas-local, letterboxing included). Null while no widget is armed.
const confirmAnchor = computed(() => {
  void layoutTick.value;
  const c = confirmController.value;
  const rect = c?.state.rect ?? null;
  if (c === null || c.state.targetId === null || rect === null || client === null) return null;
  return client.presentationToCss(rect);
});

// The button commits only a press that STARTED on it. It appears under the finger that focused the widget, so the
// click a browser synthesizes after that touch tap lands on it; acting on that click spent the reward on the focus
// tap itself (C3's live leg: the event option was taken, never confirmed).
let confirmPressed = false;

function pressConfirm(): void {
  confirmPressed = true;
}

function commitConfirm(): void {
  const pressed = confirmPressed;
  confirmPressed = false;
  if (pressed) streamInput?.commitConfirm();
}

function onStatus(status: RenderStreamStatus): void {
  emit("status", status);
  carrier.value = status.kind === "streaming" ? client?.stats().carrier ?? null : null;
  switch (status.kind) {
    case "connecting":
      phase.value = "connecting";
      break;
    case "streaming":
      // The session arrived first (`firstFrame: false`); the loading line stays up until something has drawn.
      phase.value = status.firstFrame ? "streaming" : "loading";
      if (status.firstFrame) {
        refreshAsked = false;
        if (!firstFrameReported) {
          firstFrameReported = true;
          emit("first-frame");
        }
      }
      break;
    case "reconnecting":
      phase.value = "reconnecting";
      break;
    case "failed":
      if (status.reason === "live-connect-failed" && status.detail === "unauthorized" && !refreshAsked && client) {
        askForCurrentDescriptor();
        break;
      }
      stop(`${status.reason}: ${status.detail}`);
      break;
    case "ended":
      stop("ended");
      break;
  }
}

// The hub refused the token we were given. The seat may have restarted with a new one, so ask for its current
// descriptor once and wait for it (the `endpoint` watch below decides).
function askForCurrentDescriptor(): void {
  refreshAsked = true;
  phase.value = "connecting";
  refreshPending = {
    refused: props.endpoint,
    timer: setTimeout(() => {
      refreshPending = null;
      stop(UNAUTHORIZED);
    }, props.refreshTimeoutMs)
  };
  emit("refresh-endpoint");
}

function clearRefresh(): void {
  if (refreshPending !== null) {
    clearTimeout(refreshPending.timer);
    refreshPending = null;
  }
}

function stop(reason: string): void {
  if (stopped) return;
  clearRefresh();
  stopped = true;
  phase.value = "failed";
  // The fallback is emitted whatever the teardown does: this runs inside the client's own status callback, which
  // swallows a throw, so a dispose that threw here used to leave the stage on "failed" over a blank canvas with
  // MirrorApp never told (MIR-4's real hidden-page repro).
  try {
    disposeClient();
  } finally {
    emit("failed", reason);
  }
}

// Everything `buildStreamExtensions` reads: the four module settings and the seat's presentation width (the view-scale
// clamp's design width). A seat relaunched at a new width, or a module toggled mid-session, changes it.
function extensionsKey(): string {
  return [
    mirrorSettings.raiseHandCards,
    mirrorSettings.uiScaling,
    mirrorSettings.raiseHeldCard,
    mirrorSettings.confirmTap,
    presentation.value[0],
    props.sendInput !== undefined
  ].join("|");
}

function mountClient(): void {
  const canvas = canvasEl.value;
  if (!canvas || client || stopped) return;
  mountedExtensionsKey = extensionsKey();
  const built = buildStreamExtensions({
    settings: mirrorSettings,
    presentationWidth: presentation.value[0],
    interactive: props.sendInput !== undefined
  });
  confirmController.value = built.confirmTap;
  const create = props.createClient ?? createRenderStreamClient;
  try {
    client = create({
      canvas,
      core: props.core,
      endpoint: props.endpoint,
      extensions: built.extensions,
      creditWindow: 2,
      carrier: mirrorSettings.renderStreamCarrier,
      onStatus
    });
  } catch (error) {
    stop(`receiver-error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  inputModules = { heldCard: built.heldCard, confirmTap: built.confirmTap, pointerTargets: built.pointerTargets };
  if (props.sendInput && props.inputEnabled) {
    attachStreamInput();
    attachKeyPad(false);
  }
  phase.value = "connecting";
  client.connect();
}

// C3: the node under a client point, resolved over whichever client is live (the module keeps one resolver per
// client); null before a client, on a bar, or over nothing with an identity.
function targetResolver(module: PointerTargetModule): (clientX: number, clientY: number) => ReturnType<
  NonNullable<ReturnType<PointerTargetModule["resolverFor"]>>
> {
  return (clientX, clientY) => module.resolverFor(client)?.(clientX, clientY) ?? null;
}

// Send is `props.sendInput` read live (MirrorApp's per-generation sender, which drops anything while
// `hostAccess.allowed` is false), behind this channel's epoch: handing the prop over by value pinned the first
// generation's sender, so after any access-generation change every pointer event was dropped.
function attachStreamInput(): void {
  const canvas = canvasEl.value;
  if (!props.sendInput || canvas === null || client === null) return;
  const epoch = streamInputEpoch;
  streamInput = createStreamInput({
    stage: canvas,
    getClient: () => client,
    send: (message) => {
      if (epoch === streamInputEpoch) props.sendInput?.(message);
    },
    tapToFocus: () => mirrorSettings.tapToFocus,
    heldCard: inputModules?.heldCard ?? undefined,
    raiseHeldCard: () => mirrorSettings.raiseHeldCard,
    unfocusOnRelease: () => mirrorSettings.unfocusOnRelease,
    confirmTap: inputModules?.confirmTap ?? undefined,
    confirmTapEnabled: () => mirrorSettings.confirmTap,
    ...(inputModules?.pointerTargets
      ? { resolveTarget: targetResolver(inputModules.pointerTargets) }
      : {})
  });
}

function detachStreamInput(silent: boolean): void {
  if (silent) streamInputEpoch += 1;
  streamInput?.dispose();
  streamInput = null;
}

// Send is `props.sendInput` read live (MirrorApp's per-generation sender, which drops anything while
// `hostAccess.allowed` is false), behind this pair's epoch.
function attachKeyPad(neutralizeHeldOnStart: boolean): void {
  if (!props.sendInput) return;
  const epoch = keyPadEpoch;
  keyPadInput = createKeyPadInput({
    send: (message) => {
      if (epoch === keyPadEpoch) props.sendInput?.(message);
    },
    keyboard: () => mirrorSettings.keyboard,
    gamepad: () => mirrorSettings.gamepad,
    neutralizeHeldOnStart,
    stage: canvasEl.value
  });
}

function detachKeyPad(silent: boolean): void {
  if (silent) keyPadEpoch += 1;
  keyPadInput?.dispose();
  keyPadInput = null;
}

function disposeClient(): void {
  detachStreamInput(false);
  detachKeyPad(false);
  inputModules = null;
  confirmController.value = null;
  mountedExtensionsKey = null;
  carrier.value = null;
  const current = client;
  client = null;
  if (current) {
    canvasGeneration.value += 1;
    current.dispose();
  }
}

function clearHiddenTimer(): void {
  if (hiddenTimer !== null) {
    clearTimeout(hiddenTimer);
    hiddenTimer = null;
  }
}

// A hidden tab already stops publishing to us (no rAF ⇒ no credit). Past the grace the client goes entirely, and a
// visible tab is a fresh join, which is what lets the hub drop this connection's carried set meanwhile.
function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    if (client && hiddenTimer === null) {
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        disposeClient();
        phase.value = "suspended";
      }, props.hiddenDisposeMs);
    }
    return;
  }
  clearHiddenTimer();
  // After the key bump the fresh <canvas> exists only once Vue has rendered it.
  if (!client && !stopped) void nextTick(mountClient);
}

// The mounted client runs a stale extension list: replace it with a fresh client (on a fresh canvas, since dispose
// loses the old one's context) built from the current settings and presentation. A suspended stage has no client and
// builds from the current values when it next mounts.
function remountIfStale(): void {
  if (stopped || client === null || mountedExtensionsKey === extensionsKey()) return;
  disposeClient();
  phase.value = "connecting";
  void nextTick(mountClient);
}

watch(extensionsKey, remountIfStale);

watch(() => props.inputEnabled, (enabled) => {
  if (!enabled) {
    detachStreamInput(false);
    detachKeyPad(false);
  } else if (client && !stopped) {
    attachStreamInput();
    attachKeyPad(true);
  }
});

// KEYBOARD + GAMEPAD settings: both captures read them live, so OFF already stops sending; the refresh releases what
// is held at the flip and restarts a parked pad poll when the setting comes back ON.
watch(
  () => [mirrorSettings.keyboard, mirrorSettings.gamepad] as const,
  () => keyPadInput?.refresh()
);

// A new access generation (the host lost access and got it back): the pointer channel and the pair from before are
// retired without a word, and the fresh ones ignore a mouse button, finger or pad control the player is still holding
// until it is released, so a press made before the resume never lands in the resumed game.
watch(() => props.accessGeneration, () => {
  if (streamInput !== null) {
    detachStreamInput(true);
    attachStreamInput();
  }
  if (keyPadInput !== null) {
    detachKeyPad(true);
    attachKeyPad(true);
  }
});

// A later descriptor (a seat restarted with a new port or token) reconnects in place. While an `unauthorized` refresh
// is pending, the next descriptor is its answer: a different one reconnects (the failed client starts a fresh
// session on `connect()`), the same one means the token really is refused.
watch(() => props.endpoint, (endpoint) => {
  if (refreshPending !== null) {
    const refused = refreshPending.refused;
    clearRefresh();
    if (sameDescriptor(endpoint, refused)) {
      stop(UNAUTHORIZED);
      return;
    }
    // A new presentation width needs new extensions: the remount connects the fresh client on this descriptor.
    if (client !== null && mountedExtensionsKey !== extensionsKey()) {
      remountIfStale();
      return;
    }
    try {
      client?.setEndpoint(endpoint);
      client?.connect();
    } catch (error) {
      stop(`receiver-error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (client !== null && mountedExtensionsKey !== extensionsKey()) {
    remountIfStale();
    return;
  }
  try {
    client?.setEndpoint(endpoint);
  } catch (error) {
    stop(`receiver-error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

function bumpLayout(): void {
  layoutTick.value += 1;
}

// QA seam (CAR9): `window.__renderStreamStats()` reads the mounted stage's client counters (applies/s, carrier, …) on
// a real page, where the component's own `stats()` is out of reach. Installed while mounted; removed only if it is
// still this stage's.
type StatsSeam = { __renderStreamStats?: () => Readonly<RenderStreamStats> };
const statsSeam = (): Readonly<RenderStreamStats> => readStats();

onMounted(() => {
  if (typeof window !== "undefined") (window as unknown as StatsSeam).__renderStreamStats = statsSeam;
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("resize", bumpLayout);
  window.addEventListener("orientationchange", bumpLayout);
  if (typeof ResizeObserver !== "undefined" && frameEl.value !== null) {
    layoutObserver = new ResizeObserver(bumpLayout);
    layoutObserver.observe(frameEl.value);
  }
  if (document.visibilityState === "hidden") {
    // Mounted in a background tab: wait to be seen rather than pay for a full join nobody watches.
    phase.value = "suspended";
    return;
  }
  mountClient();
});

onBeforeUnmount(() => {
  if (typeof window !== "undefined" && (window as unknown as StatsSeam).__renderStreamStats === statsSeam) {
    delete (window as unknown as StatsSeam).__renderStreamStats;
  }
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("resize", bumpLayout);
  window.removeEventListener("orientationchange", bumpLayout);
  layoutObserver?.disconnect();
  layoutObserver = null;
  clearHiddenTimer();
  clearRefresh();
  stopped = true;
  disposeClient();
});

/** The client's cheap counters (applies/s, credit RTT, heap, carrier); zeros while no client is mounted. */
function readStats(): Readonly<RenderStreamStats> {
  return client?.stats() ?? { applied: 0, appliesPerSec: 0, creditRttMsP50: null, heapBytes: 0, carrier: null };
}

defineExpose({
  stats: readStats,
  phase
});
</script>

<template>
  <div
    ref="frameEl"
    class="render-stream-frame"
    :class="{ 'render-stream-frame-safe-area': mirrorSettings.safeAreaPaddingEnabled }"
    data-testid="render-stream-stage"
    :data-stream-phase="phase"
    :data-stream-carrier="carrier ?? undefined"
  >
    <div class="render-stream-box" :style="boxStyle">
      <canvas
        :key="canvasGeneration"
        ref="canvasEl"
        class="render-stream-canvas"
        :width="presentation[0]"
        :height="presentation[1]"
        data-testid="render-stream-canvas"
      />
    </div>
    <p v-if="overlayText" class="render-stream-status" role="status" data-testid="render-stream-status">{{ overlayText }}</p>
    <button
      v-if="confirmAnchor"
      class="render-stream-confirm"
      :style="{
        left: `${confirmAnchor.x}px`,
        top: `${confirmAnchor.y}px`,
        width: `${confirmAnchor.w}px`,
        height: `${confirmAnchor.h}px`
      }"
      data-testid="render-stream-confirm-button"
      @pointerdown.stop="pressConfirm"
      @pointerup.stop
      @click.stop="commitConfirm"
    >{{ t('a11y.confirm') }}</button>
  </div>
</template>

<style scoped>
/* Couch's own chrome around the stream: the same full-bleed black frame as MirrorView's `.mirror-frame`, with the
   same safe-area inset when that preference is on. */
.render-stream-frame {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #000;
}

.render-stream-frame-safe-area {
  inset:
    var(--surface-inset-top, 0px) var(--surface-inset-right, 0px)
    var(--surface-inset-bottom, 0px) var(--surface-inset-left, 0px);
}

/* Letterboxed at the seat's presentation aspect (16:9, or wider for a seat launched at this viewer's aspect): the
   largest such box inside the frame, centred. */
.render-stream-box {
  position: absolute;
  inset: 0;
  container-type: size;
  display: flex;
  align-items: center;
  justify-content: center;
}

.render-stream-canvas {
  display: block;
  /* The canvas is a game surface driven by pointer events (INP2): no browser pan/zoom gesture may claim a touch.
     .game-surface's `touch-action: manipulation` still allows panning, so without this a phone drag past the slop
     arrives as `pointercancel`; and a long press must not start a text selection. MirrorView's stage does the same. */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  width: min(100cqw, calc(100cqh * var(--render-stream-aspect, 1.7777778)));
  height: min(100cqh, calc(100cqw / var(--render-stream-aspect, 1.7777778)));
}

.render-stream-status {
  position: absolute;
  left: 50%;
  top: 50%;
  margin: 0;
  transform: translate(-50%, -50%);
  color: rgba(255, 255, 255, 0.75);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  pointer-events: none;
}

/* CONFIRM TAP: the client confirm button, anchored over the confirm-eligible widget the tap focused. The stage maps
   the widget's presentation rect through the client, so the button tracks the widget (focus growth included). */
.render-stream-confirm {
  position: fixed;
  z-index: 10;
  box-sizing: border-box;
  min-width: 88px;
  min-height: 44px;
  padding: 6px 14px;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 8px;
  background: rgba(20, 20, 24, 0.92);
  color: #fff;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px;
  cursor: pointer;
}
</style>
