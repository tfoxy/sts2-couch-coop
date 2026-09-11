<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { translate as t } from "@/i18n";

import { reproRecorder, type ReproStats } from "@/mirror/reproRecorder";

// THE REC PILL for the repro recorder (reproRecorder.ts) — CouchCoop's OWN chrome, not a game-scene element.
//
// It exists so the person recording can see that they ARE recording, and can mark the bug the instant it happens
// without going back through the settings panel. Both of those are the difference between a usable recording and
// a useless one: a player who has to open a menu to mark a bug marks it three seconds late, and the whole design
// (a rolling buffer plus a marker) rests on the mark landing on the moment.
//
// PLACED TOP-LEFT, IN BROWSER SPACE, OUTSIDE THE STAGE. All three matter:
//   * top-LEFT because the mirror's own chrome already owns the top centre (the gear, `.mirror-topbar-gear` /
//     `.mirror-chrome-gear`, both at `left: 50%`) and the top right (LatencyOverlay, `top: 8px; right: 8px`).
//   * BROWSER space (fixed, unscaled) so it stays a real-sized touch target on a letterboxed phone, where a
//     design-space button shrinks with the stage.
//   * OUTSIDE the stage element so a press on MARKER or SAVE is never seen by inputCapture (whose listeners are
//     on the stage) and never lands in the recording as a player gesture. The pill would otherwise record — and
//     replay — taps on itself.
//
// It renders only while the recorder is armed (MirrorApp's `v-if`), so it is not permanent furniture.

// The pill re-reads the recorder rather than being pushed to: the recorder is deliberately reactivity-free (it
// sits in mirrorClient's import graph and must stay a plain module), and a half-second poll is the correct cost
// for a readout whose units are seconds and percent.
const POLL_MS = 500;

const stats = ref<ReproStats>(reproRecorder.stats());
let timer: ReturnType<typeof setInterval> | null = null;

// The "marker 3 ✓" confirmation. A marker is fire-and-forget with no visible consequence anywhere else, so
// without this the player cannot tell a registered tap from a missed one — and will tap again, which costs
// nothing except that the analysis then has two marks for one event.
const flash = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const elapsed = computed(() => {
  const total = Math.max(0, Math.floor(stats.value.elapsedMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
});

// Buffer fill, as the one number that answers "how far back does this still reach". At 100% the ring is dropping
// its oldest lines, which is normal (that is what a flight recorder does) but is also the moment the hindsight
// stops growing — so it is shown rather than hidden.
const fillPct = computed(() => Math.round(stats.value.fill * 100));
const full = computed(() => stats.value.droppedLines > 0);

function poll(): void {
  stats.value = reproRecorder.stats();
}

function showFlash(text: string): void {
  flash.value = text;
  if (flashTimer !== null) {
    clearTimeout(flashTimer);
  }
  flashTimer = setTimeout(() => {
    flash.value = null;
    flashTimer = null;
  }, 1400);
}

function onMarker(): void {
  showFlash(t("repro.marker", { count: reproRecorder.marker() }));
  poll();
}

function onSave(): void {
  const saved = reproRecorder.save();
  showFlash(t("repro.saved", { size: (saved.bytes / (1024 * 1024)).toFixed(1) }));
  poll();
}

onMounted(() => {
  poll();
  timer = setInterval(poll, POLL_MS);
});

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (flashTimer !== null) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
});
</script>

<template>
  <div class="repro-badge" data-testid="mirror-repro-badge">
    <span class="repro-dot" :class="{ 'repro-dot-live': stats.recording }" aria-hidden="true"></span>
    <span class="repro-readout" data-testid="mirror-repro-readout">
      <template v-if="flash">{{ flash }}</template>
      <template v-else>{{ t('repro.rec', { time: elapsed, fill: fillPct }) }}<template v-if="full"> ↺</template></template>
    </span>
    <button type="button" class="repro-btn repro-btn-marker" data-testid="mirror-repro-marker" @click="onMarker">
      {{ t('repro.markerButton') }}
    </button>
    <button type="button" class="repro-btn" data-testid="mirror-repro-save" @click="onSave">{{ t('repro.save') }}</button>
  </div>
</template>

<style scoped>
/* Browser-space fixed chrome, top-LEFT (see the component note for why that corner). One z-index below the
   settings dropdown's layer so an open panel is never sunk behind a diagnostic pill. */
.repro-badge {
  position: fixed;
  top: 6px;
  left: 6px;
  z-index: 2147483644;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 999px;
  background: rgba(12, 12, 16, 0.82);
  border: 1px solid rgba(255, 90, 90, 0.7);
  color: #f2f2f4;
  font: 600 12px/1 system-ui, sans-serif;
  /* A recording session is a session where the player is trying to reproduce something; the pill must never
     become the thing they hit instead of the card underneath it. */
  user-select: none;
  -webkit-user-select: none;
}

.repro-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #6a2020;
  flex: none;
}

.repro-dot-live {
  background: #ff4d4d;
  animation: repro-pulse 1.6s ease-in-out infinite;
}

@keyframes repro-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

/* Fixed width so the readout swapping to a flash message (and the seconds ticking over) never re-flows the two
   buttons out from under a finger that is already on its way down. */
.repro-readout {
  min-width: 8.5rem;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* ≥28px tall on purpose — this is a phone control that gets pressed in a hurry, mid-combat, one-handed. */
.repro-btn {
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.repro-btn-marker {
  border-color: rgba(255, 120, 120, 0.8);
  background: rgba(255, 77, 77, 0.28);
}

.repro-btn:active {
  background: rgba(255, 255, 255, 0.24);
}
</style>
