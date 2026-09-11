<script setup lang="ts">
import { computed } from "vue";
import { translate as t } from "@/i18n";

import { trimName } from "@/join/joinModel";

// F3 — the WAITING screen a `?name=<seat>` viewer gets while the host is on a screen that has no seat to give
// (main menu, singleplayer character select, singleplayer run). MirrorApp decides when this renders instead of
// MirrorJoinPicker (`showHostWaiting`); this component only says what that state looks like.
//
// Deliberately its OWN component rather than a fourth `MirrorJoinMode`: that type is a C#/TS twin the native
// client consumes (JoinModel.MirrorJoinMode), and it describes which JOIN FORM to draw. This screen has no form
// at all, and the state it stands for — "this browser's URL names a seat" — is a browser-only `?name=` fact the
// native client has no equivalent of. Adding an arm to the shared enum would export a mode the other client can
// never be in.
//
// NO SPINNER, and that is the point of the screen. The spinner idiom (MirrorJoinPicker.mirror-spinner) means "we
// are working on something that will finish on its own" — a connect, a join, a headless spawn. Nothing here is in
// flight: we are waiting on a person to start a game on the TV, which may be a minute or an hour away. A spinner
// would read as a hang, and the one thing this screen has to be is calm.
const props = defineProps<{
  // The seat this browser's URL names, for the "you'll join as …" line. Null/blank (a viewer that reached this
  // screen with no readable name) simply drops that line — the heading still says everything necessary.
  seatName: string | null;
  // The same rejection surface the picker has, and the same testids, because the message it carries is the same
  // one: a join this viewer already tried that the host refused. A stale rejection must stay legible after the
  // host walks back to the menu — that is exactly when the player is looking for an explanation.
  message?: string | null;
  // Server-authored fault text under `message` (a host-side join exception). Never rendered without it.
  detail?: string | null;
}>();

const emit = defineEmits<{ (e: "controlHost"): void }>();

const seatLabel = computed(() => trimName(props.seatName));
</script>

<template>
  <section class="assignment-panel mirror-host-waiting" aria-live="polite" data-testid="mirror-host-waiting-view">
    <h1 data-testid="mirror-host-waiting-title">{{ t('picker.waitHost') }}</h1>
    <p v-if="seatLabel" class="mirror-host-waiting-sub" data-testid="mirror-host-waiting-sub">
      {{ t('picker.joinAs', { name: seatLabel }) }}
    </p>

    <!-- Same classes AND testids as the picker's message surface (MirrorJoinPicker) — one rejection, one place to
         read it, whichever screen the viewer is on when it arrives. -->
    <p v-if="message" class="mirror-join-message" data-testid="mirror-join-message">{{ message }}</p>
    <p v-if="message && detail" class="mirror-join-detail" data-testid="mirror-join-detail">{{ detail }}</p>

    <div class="mirror-host-waiting-actions">
      <button type="button" data-testid="control-host" @click="emit('controlHost')">{{ t('picker.controlHost') }}</button>
    </div>
  </section>
</template>

<style scoped>
/* CouchCoop's OWN join chrome — the pre-game SPA shell — not @spirectl/godot-scene-web presentation DOM.
   The panel box itself is the shared global `.assignment-panel` (styles.css), width and 720px breakpoint
   included, so this screen lines up with the picker AND with `.mirror-join-advisory` stacked above it. */
.mirror-host-waiting {
  text-align: center;
}

/* Who this browser is waiting to become. Quieter than the heading and sized like the picker's secondary lines
   (`.connection-count`), so it reads as the explanation of the heading rather than a second instruction. */
.mirror-host-waiting-sub {
  margin: clamp(0.5rem, 1.8cqw, 0.75rem) 0 0;
  color: #b6c4cf;
  font-size: clamp(0.8rem, 1.9cqw, 1rem);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.mirror-host-waiting-actions {
  display: flex;
  justify-content: center;
  margin: clamp(0.9rem, 2.8cqw, 1.35rem) 0 0;
}

/* A SECONDARY control, so deliberately not the accent-filled `.join-row button` treatment: the primary outcome of
   this screen is the host starting a game, and the player who taps this is choosing to stop being a player. Same
   metrics as the picker's rows (`.player-choice`) so the two screens feel like one app. */
.mirror-host-waiting-actions button {
  min-height: 2.35rem;
  padding: 0 1.1rem;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 6px;
  color: #f5f7fa;
  background: rgb(255 255 255 / 7%);
  font: inherit;
  font-weight: 700;
}

.mirror-host-waiting-actions button:hover {
  border-color: rgb(124 199 238 / 62%);
  background: rgb(124 199 238 / 12%);
}

.mirror-host-waiting-actions button:focus-visible {
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: 2px;
}

/* The rejection surface, copied from MirrorJoinPicker rather than shared: scoped styles do not cross components,
   and hoisting two paragraphs into global styles.css to avoid ~20 duplicated lines would put join-screen copy
   rules somewhere neither screen mentions. Keep the two in step. */
.mirror-join-message {
  margin: clamp(0.5rem, 1.8cqw, 0.75rem) 0 0;
  color: #ffcf7a;
  font-size: 0.95rem;
}

.mirror-join-detail {
  margin: 0.25rem 0 0;
  color: rgba(255, 255, 255, 0.62);
  font-size: 0.8rem;
  line-height: 1.35;
  max-width: 32rem;
  margin-inline: auto;
  overflow-wrap: anywhere;
}
</style>
