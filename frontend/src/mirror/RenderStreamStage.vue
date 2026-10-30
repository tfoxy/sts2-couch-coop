<script setup lang="ts">
// "Use new renderer (Beta)" — the stage that shows the game through godot-scene-web's render-stream client: the
// game's own draw calls, replayed on one canvas. Couch chrome only; the protocol loop, the wasm and its teardown
// all belong to `@godot-scene-web/render-stream-client`.
//
// What this component owns (handoff-mirror-new-renderer.md §3 Q5):
//   * the <canvas>: a W×1080 backing store, W being the seat's presentation width (`GRC_ROOT_SIZE=presentation:<W>x1080`,
//     the descriptor's `presentation`: 1920, or wider when the seat was launched at this viewer's aspect — PRES-A),
//     CSS-fitted at that aspect inside the frame (letterboxed: a box whose aspect changed since the seat started, a
//     rotated phone, keeps the seat's width until its next start — PRES-R), honouring the safe-area padding
//     preference exactly as MirrorView's frame does;
//   * the client's lifetime: created and connected on mount, disposed on unmount (heap, socket, GL context);
//   * the loading line until the first drawn transaction, and "Reconnecting…" while the package backs off;
//   * the hidden tab: rAF stops by itself (so no credit returns and the hub stops publishing to us); after
//     60 s hidden the client is disposed outright, and a visible tab reconnects as a fresh join ON A NEW CANVAS:
//     the package's `dispose()` loses the canvas's WebGL context for good (`WEBGL_lose_context`), and a canvas keeps
//     that lost context, so a client given the old one connects and then draws nothing (MIR-4);
//   * `unauthorized` (the hub refused the token: the seat restarted with a new one): ask MirrorApp ONCE for the
//     seat's current descriptor (`refresh-endpoint`); a different one arriving reconnects with it, the same one (or
//     none within `refreshTimeoutMs`) is a stop;
//   * the fallback: a `failed` or `ended` status is emitted as `failed(reason)` for MirrorApp to fall back on.
//
// VIEW ONLY. Nothing here listens for input or sends anything to the game.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

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
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { RENDER_STREAM_HIDDEN_DISPOSE_MS } from "@/mirror/renderStreamAvailability";

const props = withDefaults(defineProps<{
  endpoint: RenderStreamEndpoint;
  core: RenderStreamCore;
  /** Injectable for specs; the package's factory otherwise. */
  createClient?: (options: RenderStreamClientOptions) => RenderStreamClient;
  hiddenDisposeMs?: number;
  /** How long an `unauthorized` stream waits for the seat's current descriptor before it stops. */
  refreshTimeoutMs?: number;
}>(), {
  createClient: undefined,
  hiddenDisposeMs: RENDER_STREAM_HIDDEN_DISPOSE_MS,
  refreshTimeoutMs: 10_000
});

const emit = defineEmits<{
  /** The stream stopped for good this session (`<reason>: <detail>`, or `ended`). */
  failed: [reason: string];
  status: [status: RenderStreamStatus];
  /** The hub refused our token: send the seat's current descriptor (a new `endpoint` prop), once. */
  "refresh-endpoint": [];
}>();

type Phase = "connecting" | "loading" | "streaming" | "reconnecting" | "suspended" | "failed";

const canvasEl = ref<HTMLCanvasElement | null>(null);
// Bumped whenever a client has been disposed and another may follow: the <canvas> is keyed on it, so every client gets
// a canvas whose WebGL context nobody has lost yet.
const canvasGeneration = ref(0);
const phase = ref<Phase>("connecting");
let client: RenderStreamClient | null = null;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
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

function onStatus(status: RenderStreamStatus): void {
  emit("status", status);
  switch (status.kind) {
    case "connecting":
      phase.value = "connecting";
      break;
    case "streaming":
      // The session arrived first (`firstFrame: false`); the loading line stays up until something has drawn.
      phase.value = status.firstFrame ? "streaming" : "loading";
      if (status.firstFrame) refreshAsked = false;
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

function mountClient(): void {
  const canvas = canvasEl.value;
  if (!canvas || client || stopped) return;
  const create = props.createClient ?? createRenderStreamClient;
  try {
    client = create({ canvas, core: props.core, endpoint: props.endpoint, extensions: [], creditWindow: 2, onStatus });
  } catch (error) {
    stop(`receiver-error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  phase.value = "connecting";
  client.connect();
}

function disposeClient(): void {
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
    try {
      client?.setEndpoint(endpoint);
      client?.connect();
    } catch (error) {
      stop(`receiver-error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  try {
    client?.setEndpoint(endpoint);
  } catch (error) {
    stop(`receiver-error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

onMounted(() => {
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (document.visibilityState === "hidden") {
    // Mounted in a background tab: wait to be seen rather than pay for a full join nobody watches.
    phase.value = "suspended";
    return;
  }
  mountClient();
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  clearHiddenTimer();
  clearRefresh();
  stopped = true;
  disposeClient();
});

defineExpose({
  /** The client's cheap counters (applies/s, credit RTT, heap); zeros while no client is mounted. */
  stats: (): Readonly<RenderStreamStats> =>
    client?.stats() ?? { applied: 0, appliesPerSec: 0, creditRttMsP50: null, heapBytes: 0 },
  phase
});
</script>

<template>
  <div
    class="render-stream-frame"
    :class="{ 'render-stream-frame-safe-area': mirrorSettings.safeAreaPaddingEnabled }"
    data-testid="render-stream-stage"
    :data-stream-phase="phase"
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
</style>
