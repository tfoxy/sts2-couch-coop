<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { translate as t } from "@/i18n";

import type { BrowserPlayerOption } from "@/protocol/browserEnvelope";
import {
  mirrorPickerNameLabel,
  mirrorPickerRosterHeading,
  mirrorRosterFor,
  seatCharacterIconUrl,
  seatIsClaimable,
  seatIsUnavailable,
  shouldShowConnectionCount,
  shouldShowMirrorPickerTitle,
  type MirrorJoinMode
} from "@/join/joinModel";

// The MIRROR view's pre-join screen: a player PICKER (host badged [HOST]) that is the primary control, plus —
// only in MP character-select ("picker-with-name") — a name field, shown FIRST, to add a NEW remote
// player. Purely presentational: the parent computes `mode` (joinModel.computeMirrorJoinMode) and owns the
// connection; every choice (a picker button or a name submit) just emits `join` with a name, and the SERVER
// decides watch-host vs spawn vs reject. The join chrome (classes in the global styles.css, testids) lives
// outside this component so the native JoinPanel and the e2e suite address the same shapes.
//
// ROSTER EMPHASIS (2026-08-01 user report — the visual language was inverted; native twin: JoinPanel.cs):
//   * the HOST row is plain and says only "<name> [Host]". The old "Watch host" affordance described the wrong
//     thing — picking the host HANDLES the host player (the host machine drives it), it is not a spectator mode.
//   * the highlight goes to the rows a viewer is meant to CLAIM: ready seats with no controller attached.
//   * a seat with a controller is plain and undimmed — the old dim on any disconnected/uncontrolled seat was the
//     misleading signal, since those rows are perfectly joinable.
//   * a non-ready seat (stuck / offline) is genuinely `disabled`, with the server's reason as its secondary text.
const props = defineProps<{
  mode: MirrorJoinMode;
  screenTitle: string | null;
  players: BrowserPlayerOption[];
  pendingJoinName: string | null;
  prefillName: string;
  // The kicker over the panel (mirror passes "Mirror").
  kicker?: string;
  // Title-only heading fallback when there's no screen title yet (mirror's "Waiting…"/status text).
  placeholder?: string | null;
  // TRANSIENT lifecycle state: the `placeholder` is a live progress word ("Connecting…"/"Joining…"/"Loading…"/
  // "Reconnecting…", see mirror/loadingState) rather than an idle fallback. It then OUTRANKS the screen title and
  // gets a spinner.
  //
  // Deliberately an explicit prop instead of reordering `titleText` globally: a STEADY picker/title-only screen
  // must keep showing the game's own screen name ("Run", "Character Select"). The old
  // `screenTitle || placeholder` order was only wrong for the transient states — where the screen title is a
  // memory of a session that has since been superseded, and the lifecycle word is the only truth on screen.
  transient?: boolean;
  // Rejection message shown above the picker ("that name is not from a session player.").
  message?: string | null;
  // Optional SECOND line under `message`, carrying the host's own words for a fault the friendly line can only
  // gesture at (a server-side join exception). Smaller and dimmer on purpose: the first line is what the viewer
  // acts on, this is what they quote when reporting it. Never rendered without a `message` above it.
  detail?: string | null;
}>();

// `playerId` is the picked option's state player id ("p:1003") for a roster BUTTON tap, and undefined for a typed
// name — the host uses it to resolve the seat's netId exactly instead of matching the (possibly synthesized) label.
const emit = defineEmits<{ (e: "join", name: string, playerId?: string): void }>();

const joinName = ref(props.prefillName ?? "");
const joinInput = ref<HTMLInputElement | null>(null);

const joinDisabled = computed(() => Boolean(props.pendingJoinName));
const submitLabel = computed(() => (props.pendingJoinName ? t("common.joining") : t("common.join")));
// A transient state's word IS the heading; otherwise the game's own screen name wins and the placeholder is the
// idle fallback ("Waiting for the game…").
const titleText = computed(() =>
  (props.transient ? props.placeholder || props.screenTitle : props.screenTitle || props.placeholder) || ""
);
const showNameField = computed(() => props.mode === "picker-with-name");
const showPicker = computed(() => props.mode === "picker-with-name" || props.mode === "picker");

// R19 WP-2 copy rules — all three decided in joinModel, so the component stays a renderer.
//   * the kicker + <h1> are DROPPED on a steady picker (the game's own screen name told the player nothing about
//     which control to use, and on a landscape phone with the keyboard up it pushed the form off screen). Every
//     lifecycle word — "Connecting…", "Reconnecting…", "Joining…", "Loading…" — and the idle status fallbacks
//     ("Waiting for the game…", "Disconnected") still render: they are the only feedback there is.
//   * the name form says what it does ("Join as new player"), not "Add a player".
//   * the roster rows get a heading of their own, prefixed "Or " when the name form sits above them.
const showTitle = computed(() =>
  shouldShowMirrorPickerTitle({
    mode: props.mode,
    transient: props.transient === true,
    screenTitle: props.screenTitle
  })
);
const nameLabel = computed(() => mirrorPickerNameLabel() && t("picker.newPlayer"));
const rosterHeading = computed(() => {
  const legacy = mirrorPickerRosterHeading(props.mode);
  return legacy ? t(props.mode === "picker-with-name" ? "picker.orChoosePlayer" : "picker.choosePlayer") : null;
});

// Seats whose character icon FAILED to load (a host that cannot resolve the id answers the /models route with a
// 404 JSON body). Remembered per playerId so the row degrades to the plain name it had before this feature
// instead of showing the browser's broken-image glyph — which is the one outcome worse than no icon at all.
const iconFailures = reactive(new Set<string>());
const characterIcon = (player: BrowserPlayerOption): string | null =>
  iconFailures.has(player.playerId) ? null : seatCharacterIconUrl(player);
const onIconError = (player: BrowserPlayerOption): void => void iconFailures.add(player.playerId);

// Host + every MIRROR SEAT (genuine remote players are hidden — the host cannot instance a mirror for them) — the
// shared roster filter the native JoinPanel uses too. Seats show regardless of who currently holds them, which is
// what lets a returning device find the seat it must reclaim. Applied in BOTH picker modes (shared markup).
const visiblePlayers = computed(() => mirrorRosterFor(props.players));

// Emphasis + secondary-line rules live in joinModel (shared, through the C# twins in JoinModel.cs, with the
// native JoinPanel). Re-exported as local names so the template stays readable:
//   isUnavailable — a seat the host declared un-joinable (lobby zombie / mid-run offline): truly disabled, reason shown.
//   isClaimable   — a ready seat nobody is on: THE row this viewer is here to claim. Everything else stays plain and
//                   tappable, including a seat whose player merely walked away ("free to reclaim").
//   showCount     — the controller count is words only at 2+; "0 controllers" read as a fault, and 1 is the norm.
const isUnavailable = seatIsUnavailable;
const isClaimable = seatIsClaimable;
const showCount = (player: BrowserPlayerOption): boolean => shouldShowConnectionCount(player.connectionCount);
const countLabel = (player: BrowserPlayerOption): string =>
  t("picker.controllers", { count: player.connectionCount }, player.connectionCount);
const seatStatusReason = (player: BrowserPlayerOption): string => {
  if (player.seatStatus === "stuck") return t("seat.stuck");
  if (player.seatStatus === "offline") return t("seat.offline");
  return player.seatStatusReason ?? t("common.unavailable");
};

// Prefill the field from the remembered name (only while the viewer hasn't typed their own).
watch(
  () => props.prefillName,
  (name) => {
    if (!joinName.value) {
      joinName.value = name;
    }
  },
  { immediate: true }
);

// Focus the name field whenever it becomes visible (MP character-select).
watch(
  () => props.mode,
  async (mode) => {
    if (mode === "picker-with-name") {
      await nextTick();
      joinInput.value?.focus();
    }
  },
  { immediate: true }
);

function submitJoin(name: string = joinName.value, playerId?: string): void {
  emit("join", name, playerId);
}
</script>

<template>
  <!-- ONE root for both shapes. The picker and the title-only fallback differ only in their panel chrome
       (class + testid) and in whether the roster/name field render — everything else (heading, spinner, message)
       is shared, and keeping two near-identical <section>s is precisely how the message surface came to be
       written twice. The rendered DOM per mode is unchanged. -->
  <section
    :class="showPicker ? 'assignment-panel picker-panel mirror-join-picker' : 'title-only-view'"
    aria-live="polite"
    :data-testid="showPicker ? 'mirror-join-picker-view' : 'screen-title-only-view'"
  >
    <p v-if="showPicker && showTitle" class="surface-kicker">{{ kicker ?? t('app.mirror') }}</p>
    <h1 v-if="showTitle" :data-testid="showPicker ? undefined : 'runtime-screen'">
      <!-- The one spinner idiom. Only ever paired with a transient word, so "something is happening" is visible
           even when the word itself doesn't change for 30s (a cold headless spawn). The surrounding section is
           already `aria-live="polite"`, which announces the heading text; `role="status"` marks the graphic
           itself as the busy indicator for assistive tech that looks for one. -->
      <span
        v-if="transient"
        class="mirror-spinner"
        role="status"
        :aria-label="t('common.working')"
        data-testid="mirror-spinner"
      />{{ titleText }}
    </h1>

    <!-- MP character-select: the name field is the PRIMARY control, shown FIRST. A real <form> so Enter submits. -->
    <form
      v-if="showNameField"
      class="join-form"
      data-testid="join-form"
      @submit.prevent="submitJoin()"
    >
      <label for="mirror-join-name">{{ nameLabel }}</label>
      <div class="join-row">
        <input
          id="mirror-join-name"
          ref="joinInput"
          v-model="joinName"
          data-testid="join-name-input"
          autocomplete="name"
          name="name"
          :disabled="joinDisabled"
        >
        <button type="submit" data-testid="join-submit" :disabled="joinDisabled">
          {{ submitLabel }}
        </button>
      </div>
    </form>

    <!-- The message surface belongs to BOTH shapes: the state that most needs an explanation — the connection
         dropped, so there is no roster to show — is title-only by definition. -->
    <p v-if="message" class="mirror-join-message" data-testid="mirror-join-message">{{ message }}</p>
    <p
      v-if="message && detail"
      class="mirror-join-detail"
      data-testid="mirror-join-detail"
    >{{ detail }}</p>

    <!-- What the rows ARE. Without it the list was three unlabelled buttons under a screen name, and the most
         common question about this screen was which of the two controls a returning player should use. -->
    <p
      v-if="showPicker && rosterHeading"
      class="picker-roster-heading"
      data-testid="player-picker-heading"
    >{{ rosterHeading }}</p>

    <div v-if="showPicker" class="player-picker" data-testid="player-picker">
      <button
        v-for="player in visiblePlayers"
        :key="player.playerId"
        type="button"
        class="player-choice"
        :class="{
          claimable: isClaimable(player),
          'is-host': player.isHost,
          'seat-unavailable': isUnavailable(player)
        }"
        :disabled="isUnavailable(player)"
        :data-disconnected="player.disconnected ? 'true' : 'false'"
        :data-connection-count="player.connectionCount"
        :data-is-host="player.isHost ? 'true' : 'false'"
        :data-seat-status="player.seatStatus"
        :data-is-mirror-seat="player.isMirrorSeat ? 'true' : 'false'"
        @click="submitJoin(player.name, player.playerId)"
      >
        <span class="player-name">
          <!-- The seat's character, straight off the roster wire. Decorative: the NAME is the label, so the img
               is aria-hidden with an empty alt — a screen reader announcing "ironclad icon" before every name
               would just be noise. No id (older host, nobody has picked yet) or a load failure renders NOTHING;
               a broken-image glyph beside a name is worse than the name alone. -->
          <img
            v-if="characterIcon(player)"
            class="player-character-icon"
            data-testid="player-character-icon"
            :src="characterIcon(player) ?? undefined"
            :data-character-id="player.characterId"
            alt=""
            aria-hidden="true"
            decoding="async"
            @error="onIconError(player)"
          >{{ player.name }}
          <span v-if="player.isHost" class="host-badge" data-testid="host-badge">{{ t('common.host') }}</span>
        </span>
        <span v-if="isUnavailable(player)" class="connection-count" data-testid="seat-status-reason">
          {{ seatStatusReason(player) }}
        </span>
        <!-- No secondary line on the HOST row: a controller count would be meaningless (the host machine drives
             that player), and the old "Watch host" copy described the wrong thing entirely. Nor on a seat with
             0 or 1 controllers — the claimable highlight already carries "nobody is here", and one controller is
             the normal state; only the unusual 2+ case earns a line (joinModel.shouldShowConnectionCount). -->
        <span v-else-if="!player.isHost && showCount(player)" class="connection-count" data-testid="connection-count">
          {{ countLabel(player) }}
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
/* The roster's own heading, quiet enough not to compete with the seat rows it introduces. Same treatment as the
   name form's label (styles.css `.join-form label`) so the two controls read as siblings. CouchCoop's OWN join
   chrome, not @spirectl/godot-scene-web presentation DOM. */
.picker-roster-heading {
  margin: clamp(0.8rem, 2.8cqw, 1.25rem) 0 0;
  color: #8b98a8;
  font-size: clamp(0.68rem, 1.35cqw, 0.78rem);
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

/* R20 — the same "nothing above me" rule the name form gets (styles.css `.join-form:first-child`). On a picker with
   no title, no name form and no message, THIS paragraph leads the panel and its top margin was dead space over the
   panel's own padding. It keeps the gap whenever something really does precede it — a message paragraph, or the name
   form on a `picker-with-name` — because then it is not the first child. `margin: 0` on all four sides deliberately:
   this is a <p>, so the UA's own default margin is in play and zeroing only the top would leave the bottom one. */
.picker-roster-heading:first-child {
  margin: 0;
}

/* …and the roster grid directly under it keeps its own top margin from doubling the gap. */
.picker-roster-heading + .player-picker {
  margin-top: clamp(0.35rem, 1.2cqw, 0.5rem);
}

/* Sized in `em` so it tracks `.player-name`'s fluid clamp() font size — the icon grows and shrinks with the row
   instead of needing its own breakpoints. `vertical-align` centres it on the name's line box; the source PNG is
   square (88x88 from /models/characters/<id>/icon), so `object-fit` only guards a future non-square one. */
.player-character-icon {
  display: inline-block;
  width: 1.5em;
  height: 1.5em;
  margin-right: 0.3rem;
  vertical-align: -0.42em;
  object-fit: contain;
}

.host-badge {
  margin-left: 0.5rem;
  padding: 0.05rem 0.4rem;
  border-radius: 0.35rem;
  font-size: 0.7em;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: rgba(120, 200, 255, 0.22);
  color: #bfe6ff;
}

/* THE row to claim: a ready seat with no controller on it. This is the emphasis the host row used to steal — the
   host is never highlighted, because the host machine already drives that player. Accent (not the amber
   `.disconnected` treatment) so it reads as "pick me", not "something is wrong". This
   is CouchCoop's OWN join chrome, not @spirectl/godot-scene-web presentation, so styling it here is by design. */
.player-choice.claimable {
  border-color: rgb(124 199 238 / 72%);
  background: rgb(124 199 238 / 16%);
  box-shadow: inset 0 0 0 1px rgb(124 199 238 / 22%);
}

/* An un-joinable seat (stuck zombie / mid-run offline): greyed AND `disabled` on the element itself, so the tap is
   refused rather than merely discouraged — the server refuses this seat too, so an enabled row could only produce
   a rejection banner. Deliberately the ONLY dimmed state in the picker: a seat that is simply unoccupied is a
   perfectly good join, and dimming it was exactly the signal that misled viewers. */
.player-choice.seat-unavailable {
  opacity: 0.42;
  cursor: not-allowed;
}

/* The one spinner idiom for the whole pre-game screen (CouchCoop's OWN join chrome, not @spirectl presentation).
   Sized in `em` so it tracks the heading's fluid clamp() font size in both the panel and the centered title-only
   view, and inline-block so it sits on the heading's baseline without a layout wrapper. */
.mirror-spinner {
  display: inline-block;
  width: 0.62em;
  height: 0.62em;
  margin-right: 0.42em;
  border: 0.11em solid rgb(124 199 238 / 30%);
  border-top-color: #7cc7ee;
  border-radius: 50%;
  animation: mirror-spin 0.9s linear infinite;
}

@keyframes mirror-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Reduced motion still needs the "we're working" signal — slow it right down rather than freezing it into a
   partial ring that reads as a broken glyph. */
@media (prefers-reduced-motion: reduce) {
  .mirror-spinner {
    animation-duration: 3.2s;
  }
}

.mirror-join-message {
  margin: 0 0 0.25rem;
  color: #ffcf7a;
  font-size: 0.95rem;
  text-align: center;
}

/* Server-authored fault text under the friendly line. Dimmer + smaller so it reads as evidence rather than
   instruction, and wrapped/broken so a long exception message (they are never short) cannot widen the panel. */
.mirror-join-detail {
  margin: 0 0 0.25rem;
  color: rgba(255, 255, 255, 0.62);
  font-size: 0.8rem;
  line-height: 1.35;
  text-align: center;
  max-width: 32rem;
  margin-inline: auto;
  overflow-wrap: anywhere;
}
</style>
