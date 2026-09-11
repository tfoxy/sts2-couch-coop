<script setup lang="ts">
import { computed, toRef } from "vue";
import { translate as t } from "@/i18n";

import { useFullscreen } from "@/composables/useFullscreen";
import {
  isNagFullscreenEnabled,
  usePortraitNag,
  type PortraitNagSeams
} from "@/composables/usePortraitNag";
import { isRunningStandalone } from "@/join/joinModel";

// WS3 — "turn your phone sideways".
//
// The game is landscape; a portrait phone letterboxes the mirror into an unreadable strip, and the reports that
// produced this said "the mod is broken", not "my rotation lock is on". Nothing exposes rotation-lock state, so
// the composable infers it from time-in-portrait and this component only draws the answer.
//
// R19 WP-2 — it also offers the ONE action that can fix it from here. Entering fullscreen is what asks for the
// landscape lock (the lock hangs off `fullscreenchange`, not off the caller — see useFullscreen), so on a device
// with the Fullscreen API this button rotates the phone even through the OS rotation lock, which is precisely the
// state the overlay exists to diagnose. It is a real user gesture, so `requestFullscreen()` is allowed. Nothing
// dismisses the nag by hand on success: the granted lock rotates the viewport, the shared portrait media query
// flips, and the composable's own auto-dismiss takes it down — the same path as the player turning the phone.
//
// Reachable-past, like every overlay here: "Got it" clears it for the session, and it disappears by itself the
// instant the phone is turned.
const props = defineProps<{
  /** The game view is up. A portrait join picker reads fine, so we say nothing there. */
  active: boolean;
  /** WS2's landscape lock was granted — the browser is holding the phone for us, so there is nothing to nag. */
  suppressed?: boolean;
  /** Injectable seams (matchMedia / userAgent) for specs; the live browser otherwise. */
  seams?: PortraitNagSeams;
  /**
   * Whether the page is already running as an installed / chromeless app. Defaults to the live display-mode
   * signals; a prop so specs can drive it without redefining `matchMedia` (FullscreenButton's own idiom).
   */
  standalone?: boolean;
}>();

const active = toRef(props, "active");
const { visible, showHint, userAgent, dismiss } = usePortraitNag(
  () => active.value,
  () => props.suppressed === true,
  props.seams
);

const { isSupported, enter } = useFullscreen();

// EXACTLY FullscreenButton's gate (isSupported && !standalone), for the same two reasons: iPhone Safari has no
// element Fullscreen API at all, and an installed PWA reports `fullscreenEnabled: true` while having no browser
// chrome left to hide. On either, the button would be a lie — and here, where the whole overlay is an
// explanation, a control that does nothing is worse than none.
const standalone = computed(() => props.standalone ?? isRunningStandalone());
const showFullscreen = computed(() => isNagFullscreenEnabled() && isSupported && !standalone.value);

// The platform line, which now depends on whether the button above it exists: with a button, lead with it and
// keep the rotation-lock gesture as the tail; without one, the gesture is all we have to offer.
const hint = computed(() => {
  if (showFullscreen.value) {
    if (/iPad|iPhone|iPod/.test(userAgent ?? "")) return t("portrait.ios");
    if (/Android/i.test(userAgent ?? "")) return t("portrait.android");
    return t("portrait.other");
  }
  if (/iPad|iPhone|iPod/.test(userAgent ?? "")) return t("portrait.iosPlain");
  if (/Android/i.test(userAgent ?? "")) return t("portrait.androidPlain");
  return t("portrait.otherPlain");
});

function goFullscreen(): void {
  void enter();
}
</script>

<template>
  <div
    v-if="visible"
    class="portrait-nag"
    data-testid="portrait-nag"
    role="status"
    aria-live="polite"
  >
    <div class="portrait-nag-card">
      <!-- A phone rotating clockwise: portrait outline plus a curved arrow. Inline SVG, like the other
           CouchCoop chrome glyphs, so it needs no icon font and stays crisp at any density. -->
      <svg
        class="portrait-nag-glyph"
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="16" y="9" width="16" height="30" rx="3" />
        <path d="M22 35h4" />
        <path d="M38 20a15 15 0 0 1-3.2 9.3" />
        <path d="M41.5 21.5 38 18l-3.5 3.5" />
        <path d="M10 28a15 15 0 0 1 3.2-9.3" />
        <path d="M6.5 26.5 10 30l3.5-3.5" />
      </svg>
      <h1 class="portrait-nag-title">{{ t('portrait.title') }}</h1>
      <p v-if="showHint" class="portrait-nag-hint" data-testid="portrait-nag-hint">{{ hint }}</p>
      <!-- PRIMARY action: fullscreen, which is also what asks for the landscape lock. Rendered first and styled
           as the accented button so the thing that fixes the problem is the thing the thumb finds. -->
      <button
        v-if="showFullscreen"
        type="button"
        class="portrait-nag-fullscreen"
        data-testid="portrait-nag-fullscreen"
        @click="goFullscreen"
      >
        {{ t('portrait.fullscreen') }}
      </button>
      <button
        type="button"
        class="portrait-nag-dismiss"
        data-testid="portrait-nag-dismiss"
        @click="dismiss"
      >
        {{ t('common.gotIt') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* CouchCoop's own chrome above the letterboxed stage. Opaque rather than translucent on purpose: what is behind
   it is the squashed portrait strip that made the player think the mod was broken. */
.portrait-nag {
  position: fixed;
  inset: 0;
  z-index: 2147483644;
  display: grid;
  padding: max(0.75rem, env(safe-area-inset-top)) 1rem max(0.75rem, env(safe-area-inset-bottom));
  place-items: center;
  background: rgb(2 5 8 / 94%);
}

.portrait-nag-card {
  display: grid;
  gap: 0.7rem;
  justify-items: center;
  width: min(22rem, 100%);
  text-align: center;
}

.portrait-nag-glyph {
  width: clamp(3.2rem, 22vw, 5rem);
  height: clamp(3.2rem, 22vw, 5rem);
  color: #7cc7ee;
}

.portrait-nag-title {
  font-size: clamp(1.05rem, 6vw, 1.5rem);
}

.portrait-nag-hint {
  margin: 0;
  color: #b6c4cf;
  font-size: clamp(0.78rem, 3.6vw, 0.92rem);
  line-height: 1.35;
}

/* The primary action. Accented (the same #7cc7ee family the claimable seat row and the focus ring use) so it
   reads as "press me", with the secondary "Got it" staying the quiet outline below it. */
.portrait-nag-fullscreen {
  min-width: 11rem;
  min-height: 2.8rem;
  margin-top: 0.35rem;
  padding: 0 1.2rem;
  border: 1px solid rgb(124 199 238 / 72%);
  border-radius: 6px;
  color: #06121a;
  background: #7cc7ee;
  font: inherit;
  font-weight: 600;
}

.portrait-nag-fullscreen:active {
  opacity: 0.72;
}

.portrait-nag-fullscreen:focus-visible {
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: 2px;
}

.portrait-nag-dismiss {
  min-height: 2.4rem;
  margin-top: 0.2rem;
  padding: 0 1rem;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 6px;
  color: #b6c4cf;
  background: rgb(255 255 255 / 7%);
  font: inherit;
}

.portrait-nag-dismiss:focus-visible {
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: 2px;
}
</style>
