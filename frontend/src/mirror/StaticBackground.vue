<script setup lang="ts">
// STAGE-A "Static background": the host-rendered 2520x1080 image of the room's background scene — a combat
// background or an event backdrop (Neow, ancient events) — mounted in MirrorView's `underlay` slot (design space,
// BENEATH the imperatively-managed mirror nodes — via the most-negative z-index, see imgStyle; DOM order is NOT
// the mechanism, the reconciler's full-walk reorder rearranges the stage's children). On the CANVAS arm that slot
// is a design-space layer of its own, one layer below the stage canvas, because a single <canvas> cannot be
// z-ordered between two DOM siblings — the geometry and the clip are identical either way. While this image is
// CONFIRMED shown (loaded + decoded), the renderer display:none's the live bg subtree at its root
// (setStaticBackgroundShown) — the phone stops compositing the most expensive subtree it draws, and this one
// static <img> takes its place at identical pixels.
//
// Contracts (see the renderer-side twin comments):
//   * SAME-TARGET DECODE-BEFORE-SWAP: a replacement URL for the same target keeps its valid still until the new
//     bytes decode. A room change drops the old target immediately and may show a blank stage while loading.
//   * SHOWN-SIGNAL ORDERING: renderer suppression engages only AFTER the swap commits. This signal controls an
//     already-built root during setting transitions; the unconditional build hold does not depend on it.
//   * SOURCE: the session envelope's `staticBackground` descriptor (for combat, a digest-qualified URL matching
//     the mounted layer variant; for events, always digest-less). FALLBACK for a descriptor-less host: derive
//     the digest-less deterministic URL from the wire itself (the bg root's sceneFilePath — combat winning over
//     an event backdrop when both are mounted), rescanned only when the scene STRUCTURE changes.
//   * WHAT HAPPENS WHEN NO PICTURE CAN BE HAD: every family fails closed. Combat first retries its digest-less
//     deterministic URL. After that, and immediately for event/shop, keep a valid still already shown for this
//     same target or show the stage's #181818. A failure never restores live scenery or changes the host wire.
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from "vue";

import {
  isCombatBackgroundSceneRoot,
  isEventBackgroundSceneRoot,
  isRoomBackgroundSubtreeRoot,
  staticBgCoversScenePath,
  staticBgTargetPathOf,
  tryParseEventBackgroundSceneId,
  tryParseRoomBackgroundSceneId
} from "@/mirror/renderer/staticBackgroundPolicy";
import { MIRROR_RENDERER_KEY } from "@/mirror/rendererKey";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { requestedStageBackend } from "@/mirror/rendererFactory";
import { decodeStill } from "@/mirror/stillDecode";
// Image failures are deliberately silent in the UI, so the report is the evidence that a request failed.
import {
  noteStaticBgAttempt,
  noteStaticBgDecode,
  noteStaticBgFailure,
  noteStaticBgLatch
} from "@/mirror/staticBgReport";
import { hostUrl } from "@/join/hostBase";
import type { MirrorState } from "@/mirror/sceneTree";
import type { BrowserStaticBackgroundDescriptor } from "@/protocol/browserEnvelope";

const props = defineProps<{
  // The session envelope's descriptor (mirrorClient parses/normalizes it); null = unknown.
  descriptor: BrowserStaticBackgroundDescriptor | null;
  // The retained mirror state + its revision counter — only read for the descriptor-less FALLBACK scan.
  state: MirrorState;
  revision: number;
}>();

const renderer = inject(MIRROR_RENDERER_KEY, shallowRef(null));

// Start in stage mode BEFORE MirrorView installs its renderer. A hard canvas fallback flips this to false once the
// DOM renderer is installed, preserving the image recovery path.
const usesStageTexture = computed(
  () =>
    requestedStageBackend() === "canvas" &&
    (renderer.value === null || renderer.value?.setStaticBackgroundSource !== undefined)
);

// The image render geometry — FIXED policy, must mirror the server's CouchCoopStaticBackgroundProvider policy
// (2520x1080 = the widescreen max design box, sceneTree's MIRROR_MAX_DESIGN_WIDTH). The layer this mounts in is
// design.w wide (1920..2520), so `left: calc(50% - 1260px)` centers the picture on ANY stage width without knowing
// design.w: on 16:9 the outer 300px per side sit outside that box and are clipped by its `overflow: hidden`
// (`.mirror-stage`, or `.mirror-stage-underlay` on the canvas arm — the same design box, same clip), exactly like
// the game's own viewport clips the live bg layers.
const BG_WIDTH = 2520;
const BG_HEIGHT = 1080;

// The wire-derived FALLBACK target (descriptor-less host): the combat bg root's sceneFilePath → the digest-less
// deterministic /bg/ URL (`/bg/<id>?v=1` — the same grammar the server route parses; v=1 pins the key policy,
// and MUST match CouchCoopStaticBackgroundProvider.KeyVersion or this fallback asks for a namespace the host no
// longer serves). No file extension: the host picks the encoder (jpg@0.9 today) and Content-Type names it.
// Rescanned only when orderedIds changes identity (structure moved), never per volatile revision.
const COMBAT_BG_SCENE_RE = /^res:\/\/scenes\/backgrounds\/([a-z0-9_]+)\/\1_background\.tscn$/;
let lastScanOrderedIds: readonly string[] | null = null;
let lastScanResult: BrowserStaticBackgroundDescriptor | null = null;
const wireFallback = computed<BrowserStaticBackgroundDescriptor | null>(() => {
  void props.revision; // reactivity anchor — the retained map mutates in place
  const orderedIds = props.state.orderedIds;
  if (orderedIds === lastScanOrderedIds) {
    return lastScanResult;
  }
  lastScanOrderedIds = orderedIds;
  lastScanResult = null;
  // COMBAT WINS when both families are mounted (EventRoom-WRAPPED combat mounts an event backdrop AND a combat
  // background, and the combat one is what the viewer is looking at) — the same priority the tracker's probe
  // applies. So an event candidate is only remembered, never breaks the scan.
  let familyCandidate: BrowserStaticBackgroundDescriptor | null = null;
  for (const [, node] of props.state.nodes) {
    const path = node.sceneFilePath;
    if (path) {
      const match = COMBAT_BG_SCENE_RE.exec(path);
      if (match && isCombatBackgroundSceneRoot(node, props.state.nodes)) {
        // Same host-origin treatment the envelope descriptor gets in normalizeStaticBackground, so the two
        // sources of a bg URL stay directly comparable (`next.url === shownUrl.value` below).
        lastScanResult = { scenePath: path, url: hostUrl(`/bg/${match[1]}?v=1`) };
        break;
      }
      if (familyCandidate === null && isEventBackgroundSceneRoot(node)) {
        // The event grammar is fixed (no layer variants), so the wire can mint the exact digest-less URL the
        // host serves — descriptor-less resilience parity with combat. The frame-QUALIFIED descriptor swaps in
        // (decode-before-swap) the moment it lands.
        familyCandidate = {
          scenePath: path,
          url: hostUrl(`/bg/events/${tryParseEventBackgroundSceneId(path)}?v=1`)
        };
      }
      continue;
    }
    if (familyCandidate === null && isRoomBackgroundSubtreeRoot(node, props.state.nodes)) {
      // Room backdrops key on the ROOM scene path (the subtree node itself carries none).
      const roomPath = staticBgTargetPathOf(node, props.state.nodes)!;
      familyCandidate = {
        scenePath: roomPath,
        url: hostUrl(`/bg/rooms/${tryParseRoomBackgroundSceneId(roomPath)}?v=1`)
      };
    }
  }
  lastScanResult ??= familyCandidate;
  return lastScanResult;
});

// The scene path the WIRE says is mounted RIGHT NOW: null when this isn't a combat room at all, and also null in
// the Stage-B steady state (a host that is skipping the bg subtree streams no root for it).
const wireScenePath = computed<string | null>(() => wireFallback.value?.scenePath ?? null);

// What SHOULD be displayed right now.
//
// R12 — the descriptor no longer wins unconditionally. It rides the session envelope, which the host republishes
// one deferred main-thread hop AFTER the scene delta that mounted the new room, so on a room change the NEW room's
// bg root reaches the wire while `props.descriptor` still names the OLD one. Under the pre-R12 renderer that only
// cost a beat of the previous room's picture over the live scenery; under the build HOLD the live scenery is not
// there, so a stale descriptor would leave the wrong room's artwork as the only thing on screen — and no decode
// for the mounted room would even start.
//
// So: trust the descriptor when the wire AGREES with it, and when the wire has no bg root at all (the Stage-B
// steady state, where the descriptor is the only source there is). When the wire disagrees, decode the wire-derived
// deterministic URL for the room that is ACTUALLY mounted; the digest-qualified descriptor swaps in
// (decode-before-swap, no flash) the moment it lands. Accepted cost for that ~1 round trip: the digest-less URL may
// render the deterministic-first-sorted layer variant rather than the mounted one — strictly better than showing
// the previous room's artwork.
const target = computed<BrowserStaticBackgroundDescriptor | null>(() => {
  if (!mirrorSettings.staticBgEnabled) {
    return null;
  }
  // Filter descriptors through the currently supported background families: under the Stage-B steady state the
  // wire carries no bg root to disagree with, so an unfiltered descriptor could otherwise revive an unsupported
  // family.
  const d = props.descriptor && staticBgCoversScenePath(props.descriptor.scenePath) ? props.descriptor : null;
  if (d && (wireScenePath.value === null || d.scenePath === wireScenePath.value)) {
    return d;
  }
  return wireFallback.value ?? d;
});

// What IS displayed (committed post-decode). The old value survives a pending decode — no flash.
const shownUrl = ref<string | null>(null);
const shownScenePath = ref<string | null>(null);
// Monotonic token: a target that changes mid-decode orphans the older decode's commit.
let pendingToken = 0;

// The watchdog bounds one image request only. It can advance combat's retry ladder or leave a blank stage, but
// it has no route to the renderer's build hold or the host wire.
const STATIC_BG_WAIT_MS = 6000;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

// The attempt currently in flight, so the watchdog knows WHICH url it is giving up on and whether the ladder's
// retry rung has already been spent. Null between attempts — the watchdog also arms on a bare wire edge (see its
// watcher), where it falls back to the current target.
let attempt: { scenePath: string; url: string; retried: boolean } | null = null;

function clearWatchdog(): void {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function armWatchdog(): void {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    const pending = attempt ?? (target.value === null
      ? null
      : { scenePath: target.value.scenePath, url: target.value.url, retried: false });
    if (pending === null) {
      return; // nothing to give up on
    }
    attemptFailed(pending.scenePath, pending.url, pending.retried, true);
  }, STATIC_BG_WAIT_MS);
}

// The digest-less / frame-less deterministic URL for a COMBAT scene path — the ladder's second rung. Combat only,
// on purpose: this variant is always renderable host-side (the route only refuses a QUALIFIED digest that is no
// longer current) and is exactly what the prerender sweep bakes, so it is the one URL that reliably 200s. It may
// render a different layer variant than the room actually mounted — invisible at background scale, and strictly
// better than a blank stage. The event/shop counterpart is NOT offered: their frame-less reference variant is
// visibly mis-placed (the recovered placement lerp drifts from the shipped game), so those families go blank.
function deterministicUrlFor(scenePath: string): string | null {
  const match = COMBAT_BG_SCENE_RE.exec(scenePath);
  return match ? hostUrl(`/bg/${match[1]}?v=1`) : null;
}

// One attempt failed (decode error, or the watchdog gave up on it). Take the next rung of the ladder.
function attemptFailed(scenePath: string, url: string, retried: boolean, viaWatchdog: boolean): void {
  // A timed-out decoder may still call back later. Orphan that completion before retrying or giving up.
  if (viaWatchdog) pendingToken++;
  attempt = null;
  noteStaticBgFailure(viaWatchdog);
  if (!retried) {
    const deterministic = deterministicUrlFor(scenePath);
    if (deterministic !== null && deterministic !== url) {
      // RUNG 2. The digest-qualified variant is gone for good — the host renders a digest only while it is the
      // CURRENT publish and keeps no digest→layers history, so that URL is a permanent 404, not a slow one.
      beginAttempt(scenePath, deterministic, true);
      return;
    }
  }
  giveUp(scenePath);
}

// No usable request remains. Keep a still only when it belongs to this exact target; otherwise leave the stage
// blank. Root admission is renderer-owned and remains held throughout.
function giveUp(scenePath: string): void {
  clearWatchdog();
  const keptStill = shownScenePath.value === scenePath && shownUrl.value !== null;
  // The report's `latched` gauge means "this viewer has no still on screen for the current target", which is
  // false in the kept-still case even though the fetch failed. The failure itself is counted either way.
  noteStaticBgLatch(!keptStill);
  if (!keptStill) {
    clearShown();
  }
}

function clearShown(): void {
  clearWatchdog();
  pendingToken++;
  attempt = null;
  shownUrl.value = null;
  shownScenePath.value = null;
  renderer.value?.setStaticBackgroundSource?.(null);
  renderer.value?.setStaticBackgroundShown(null);
}

// ONE attempt path for both backends and both ladder rungs. The canvas bridge owns decode + GL upload and reports
// success only after its texture registry can supply command zero; that is the canvas equivalent of the DOM arm's
// decode-before-swap guarantee, so the two settle through the same callback.
function beginAttempt(scenePath: string, url: string, retried: boolean): void {
  const stageTexture = usesStageTexture.value;
  const r = renderer.value;
  if (stageTexture && !r?.setStaticBackgroundSource) {
    return; // MirrorView has not installed the requested canvas renderer yet.
  }
  const token = ++pendingToken;
  attempt = { scenePath, url, retried };
  noteStaticBgAttempt(url);
  armWatchdog();
  const settle = (ok: boolean): void => {
    if (token !== pendingToken) {
      return; // superseded by a newer target (or a clear) while decoding
    }
    clearWatchdog();
    attempt = null;
    if (!ok) {
      attemptFailed(scenePath, url, retried, false);
      return;
    }
    noteStaticBgDecode();
    noteStaticBgLatch(false);
    shownUrl.value = url;
    shownScenePath.value = scenePath;
    // Confirmed shown: on the DOM arm the <img> src swap below hits the decoded cache and paints this same
    // frame, so the live subtree may drop out now without a hole.
    renderer.value?.setStaticBackgroundShown(scenePath);
  };
  if (stageTexture) {
    r!.setStaticBackgroundSource!({ scenePath, url }, settle);
    return;
  }
  decodeStill(url, settle);
}

watch(
  [target, usesStageTexture],
  ([next, stageTexture]) => {
    if (!next) {
      // Setting off, or nothing known at all (no descriptor and no wire root): take the picture down. With the
      // setting OFF this is the live subtree returning; with it on there is simply no target to resolve, and
      // the renderer has no bg root to hold either.
      clearShown();
      return;
    }
    // A still may survive another request only for the same target. A scene-path change drops it immediately even
    // when the producer is already omitting held roots and the descriptor is the sole authority. On canvas,
    // clearShown also clears the active stage texture before queuing the next source.
    if (next.scenePath !== shownScenePath.value && shownUrl.value !== null) {
      clearShown();
    }
    if (next.url === shownUrl.value) {
      // Same bytes (immutable URL); at most the scenePath label moved (it cannot, in practice — the digest
      // in the URL pins the variant, and the variant pins the scene). Keep the suppression in sync anyway.
      shownScenePath.value = next.scenePath;
      renderer.value?.setStaticBackgroundShown(next.scenePath);
      clearWatchdog();
      return;
    }
    if (stageTexture) {
      beginAttempt(next.scenePath, next.url, false);
      return;
    }
    beginAttempt(next.scenePath, next.url, false);
  },
  { immediate: true }
);

// A disposed/replaced renderer (MirrorView remount) starts with no suppression — re-report the current signal so
// the fresh renderer suppresses again without waiting for a room change.
watch(
  () => renderer.value,
  (r) => {
    // The target watcher intentionally did nothing while this ref was null. Start the queued source once the
    // canvas renderer arrives; no DOM image has existed during that mount interval.
    if (r && usesStageTexture.value && shownScenePath.value === null && target.value !== null) {
      beginAttempt(target.value.scenePath, target.value.url, false);
      return;
    }
    if (r && shownScenePath.value !== null) {
      if (usesStageTexture.value && shownUrl.value !== null) {
        r.setStaticBackgroundSource?.({ scenePath: shownScenePath.value, url: shownUrl.value });
      }
      r.setStaticBackgroundShown(shownScenePath.value);
    }
  }
);

// R12: the renderer's build hold is a pure function of the wire + the settings, so a room can be HELD without this
// component having anything in flight (the target watcher may not have fired at all — e.g. a `target` that stayed
// object-identical). Arm the watchdog on the wire edge too, so "held with nothing resolving" is always bounded —
// on fire it enters the ladder against the CURRENT target (see armWatchdog), which is what turns a combat room
// that is held with a stalled qualified URL into one showing the digest-less still.
watch(wireScenePath, (path) => {
  if (path !== null && path !== shownScenePath.value && target.value !== null) {
    armWatchdog();
  }
});

onBeforeUnmount(() => {
  clearShown(); // also disarms the watchdog and orphans any late completion
});

const imgStyle = computed(() => ({
  width: `${BG_WIDTH}px`,
  height: `${BG_HEIGHT}px`,
  left: `calc(50% - ${BG_WIDTH / 2}px)`,
  // BENEATH-EVERYTHING is enforced by z-index, NOT DOM order: the reconciler's order pass (applyChildOrder)
  // forces the mirror roots into the stage's leading child slots on every full-walk reorder — a resize/
  // fullscreen toggle forces one — which pushes foreign stage children (this img included) AFTER them, i.e.
  // on top. Both layers this can mount in always carry a scale() transform (a stacking context), so the
  // most-negative z-index pins this img to the bottom of that layer's negative band wherever the reorder parks it;
  // a mirror root with a negative wire zIndex still paints above, matching the game (the bg scene is the
  // deepest layer). Inline so the spec can pin it.
  zIndex: "-2147483648"
}));
</script>

<template>
  <img
    v-if="shownUrl && !usesStageTexture"
    class="mirror-static-bg"
    data-testid="mirror-static-bg-image"
    :src="shownUrl"
    :style="imgStyle"
    alt=""
    decoding="sync"
    draggable="false"
  />
</template>

<style scoped>
.mirror-static-bg {
  position: absolute;
  top: 0;
  /* Beneath the mirror nodes via the inline z-index (see imgStyle) — DOM order is NOT stable: the
     reconciler's full-walk reorder moves the mirror roots ahead of all foreign stage children. */
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
</style>
