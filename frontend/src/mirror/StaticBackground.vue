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
//   * DECODE-BEFORE-SWAP: a room change keeps the OLD image on screen until the NEW one is decoded (decodeStill —
//     the spine-still discipline), so there is never a flash of neither-image-nor-subtree.
//   * SHOWN-SIGNAL ORDERING: renderer suppression engages only AFTER the swap commits, and is cleared the moment
//     this component cannot vouch for the image (setting off, no descriptor + no fallback, fetch/decode error,
//     unmount) — the failure mode is always the live subtree returning (fail-open).
//   * SOURCE: the session envelope's `staticBackground` descriptor (for combat, a digest-qualified URL matching
//     the mounted layer variant; for events, always digest-less). FALLBACK for a descriptor-less host: derive
//     the digest-less deterministic URL from the wire itself (the bg root's sceneFilePath — combat winning over
//     an event backdrop when both are mounted), rescanned only when the scene STRUCTURE changes.
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
// R7 W1 fix (e): the fail-open latch is deliberately silent, which is why nothing could say whether it fired.
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

// R12 WATCHDOG. The renderer holds the live bg subtree UNBUILT for as long as the setting is on and this room's
// picture is unconfirmed, so a decode that never settles (a stalled fetch) would leave the room dark. Deliberately
// SHORTER than the renderer's own belt (8s): the component must always win that race, which is
// what keeps `mirrorWalkStats.staticBgHoldExpiries` at 0 in a healthy session. On fire it takes exactly the
// decode-failure arm below — and that ONE flip does all three jobs: releases the renderer's build hold (which reads
// mirrorSettings), pushes `staticBg:false` so the host's Stage-B skip re-admits the subtree, and forces the full
// walk that rebuilds it (MirrorView's staticBg watcher).
const STATIC_BG_WAIT_MS = 6000;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

function clearWatchdog(): void {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function failOpen(viaWatchdog: boolean): void {
  noteStaticBgFailure(viaWatchdog);
  // Transition-guarded: a repeat failure re-assigns the same value, which neither wakes MirrorApp's settings watch
  // nor re-sends — exactly one push per failure transition.
  if (!mirrorSettings.staticBgFailed) {
    mirrorSettings.staticBgFailed = true;
  }
  noteStaticBgLatch(true);
  clearShown();
}

function armWatchdog(): void {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    failOpen(true);
  }, STATIC_BG_WAIT_MS);
}

function clearShown(): void {
  clearWatchdog();
  pendingToken++;
  shownUrl.value = null;
  shownScenePath.value = null;
  renderer.value?.setStaticBackgroundSource?.(null);
  renderer.value?.setStaticBackgroundShown(null);
}

function startStageSource(next: BrowserStaticBackgroundDescriptor): void {
  const r = renderer.value;
  if (!r?.setStaticBackgroundSource) {
    return; // MirrorView has not installed the requested canvas renderer yet.
  }
  const token = ++pendingToken;
  noteStaticBgAttempt(next.url);
  armWatchdog();
  r.setStaticBackgroundSource(next, (ok) => {
    if (token !== pendingToken) {
      return;
    }
    clearWatchdog();
    if (!ok) {
      failOpen(false);
      return;
    }
    noteStaticBgDecode();
    if (mirrorSettings.staticBgFailed) {
      mirrorSettings.staticBgFailed = false;
    }
    noteStaticBgLatch(false);
    shownUrl.value = next.url;
    shownScenePath.value = next.scenePath;
    renderer.value?.setStaticBackgroundShown(next.scenePath);
  });
}

watch(
  [target, usesStageTexture],
  ([next, stageTexture]) => {
    if (!next) {
      // Setting off / nothing known: fail open — the live subtree returns immediately.
      clearShown();
      return;
    }
    if (stageTexture) {
      // The canvas bridge owns decode + GL upload. It reports success only after its texture registry can supply
      // command zero; this is the canvas equivalent of the legacy decode-before-swap guarantee.
      startStageSource(next);
      return;
    }
    if (next.url === shownUrl.value) {
      // Same bytes (immutable URL); at most the scenePath label moved (it cannot, in practice — the digest
      // in the URL pins the variant, and the variant pins the scene). Keep the suppression in sync anyway.
      shownScenePath.value = next.scenePath;
      renderer.value?.setStaticBackgroundShown(next.scenePath);
      clearWatchdog();
      return;
    }
    // R12 STALE-SHOWN GUARD. The WIRE has a bg root for a room we are not showing, so the picture on screen is the
    // PREVIOUS room's — and with the build hold engaged it is the only thing on screen (the live subtree for the
    // mounted room is held unbuilt). Take it down before starting the new decode; `.mirror-stage`'s own #181818 is
    // what shows in the gap. Keyed on the wire, NOT merely on "the target changed": in the Stage-B steady state the
    // wire carries no bg root, and there the decode-before-swap contract (keep the old image until the new one
    // decodes) still holds — nothing stale is on screen, because the mounted room's picture IS the old image until
    // the new one lands. Note the ordering: clearShown() bumps pendingToken, so the decode token is taken AFTER it.
    // Note too the new split — clearShown() no longer releases the BUILD hold (that is derived from mirrorSettings);
    // it only takes the image and its display-suppression down.
    if (wireScenePath.value !== null && wireScenePath.value !== shownScenePath.value && shownUrl.value !== null) {
      clearShown();
    }
    const token = ++pendingToken;
    noteStaticBgAttempt(next.url);
    armWatchdog();
    decodeStill(next.url, (ok) => {
      if (token !== pendingToken) {
        return; // superseded by a newer target (or a clear) while decoding
      }
      clearWatchdog();
      if (!ok) {
        // Fetch/decode FAILURE: clear the suppression (live subtree returns) and show nothing — a broken-image
        // glyph over the combat room is strictly worse than the live scenery.
        // STAGE-B fail-open push: latch the failure into the store. The staticBgFailed flip folds the wire value
        // (staticBgWireValue) to false, and MirrorApp's SERVER_SETTING_KEYS watch pushes `staticBg:false` to the
        // server — so a host skipping the bg subtree from the producer walk re-admits it for this instance
        // (fail-open end to end). Transition-guarded: a repeat failure re-assigns the same value, which neither
        // wakes the watch nor re-sends (and MirrorApp's lastSettingsSent dedup backstops it) — exactly one push
        // per failure transition. (R12: the watchdog above fires this exact arm, through the same helper.)
        failOpen(false);
        return;
      }
      noteStaticBgDecode();
      // A later room's image DECODED: clear the fail-open latch (one push of `staticBg:true` re-arms the host's
      // skip), then commit the swap. Same transition guard as the failure arm.
      if (mirrorSettings.staticBgFailed) {
        mirrorSettings.staticBgFailed = false;
      }
      noteStaticBgLatch(false);
      shownUrl.value = next.url;
      shownScenePath.value = next.scenePath;
      // Confirmed shown: the <img> src swap below hits the decoded cache and paints this same frame, so the
      // live subtree may drop out now without a hole.
      renderer.value?.setStaticBackgroundShown(next.scenePath);
    });
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
      startStageSource(target.value);
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
// object-identical). Arm the watchdog on the wire edge too, so "held with nothing resolving" is always bounded.
watch(wireScenePath, (path) => {
  if (path !== null && path !== shownScenePath.value && target.value !== null) {
    armWatchdog();
  }
});

onBeforeUnmount(() => {
  clearShown(); // also disarms the watchdog — an unmounted component must not latch staticBgFailed later
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
