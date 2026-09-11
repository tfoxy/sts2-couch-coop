<script setup lang="ts">
import { computed } from "vue";
import { translate as t } from "@/i18n";

import { useFullscreen } from "@/composables/useFullscreen";
import { isIosInstallForced, isRunningStandalone } from "@/join/joinModel";

// Browser-client-only top-bar control: toggles the page in/out of fullscreen. The
// host game (already fullscreen on the TV) is untouched. Mounted by App.vue into the
// rendered TopBar's RightAlignedStuff node, so it scales with the scene like the
// sibling game buttons — and, in `compact` form, as browser-space chrome beside the
// settings gear on the mirror's pre-join picker (SettingsGearButton's twin, same 44px
// box: there is no game UI to scale with there).
//
// `isSupported` (document.fullscreenEnabled) is what keeps this off browsers where
// the button would be a lie — an iOS iPhone Safari, a sandboxed frame — which matters
// most on the picker, where nothing else on screen explains why tapping it does nothing.
const props = defineProps<{
  /** Browser-space placement (the join/picker screen): a 44px chrome button instead of the 80px design-px one. */
  compact?: boolean;
  /**
   * Whether the page is already running as an installed / chromeless app. Defaults to the live display-mode
   * signals; a prop so specs can drive it without redefining `matchMedia`.
   */
  standalone?: boolean;
}>();

const { isFullscreen, isSupported, toggle } = useFullscreen();

// WS1: a home-screen / installed app has no browser chrome LEFT to hide, so the toggle is an 80×80 hole in an
// already-chromeless UI that does nothing a player can see. `isSupported` does not catch this on its own — an
// installed Android PWA still reports `fullscreenEnabled: true` — which is why the display-mode signals are
// checked separately. (On iPhone the point is moot: there is no element Fullscreen API, installed or not.)
const standalone = computed(() => props.standalone ?? isRunningStandalone());
// `?iosInstall=force` imitates iPhone Safari, where this button never exists — without this, a forced desktop
// repro would show BOTH this button and the re-open pill stacked in the same slot.
const shown = computed(() => isSupported && !standalone.value && !isIosInstallForced());

const label = computed(() => t(isFullscreen.value ? "fullscreen.exit" : "fullscreen.enter"));
</script>

<template>
  <button
    v-if="shown"
    type="button"
    class="fullscreen-button"
    :class="{ 'fullscreen-button--compact': props.compact }"
    data-testid="fullscreen-button"
    :title="label"
    :aria-label="label"
    :aria-pressed="isFullscreen"
    @click="toggle"
  >
    <!-- Inline SVG: crisp at any scene scale and font-independent (gsw can't run
         Godot's _Draw). Expand = four corner brackets hugging the outer corners;
         compress = the same brackets pulled inward. `currentColor` follows the
         button's color so hover/press dimming carries to the glyph. -->
    <svg
      class="fullscreen-button__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <template v-if="!isFullscreen">
        <path d="M4 9V4h5" />
        <path d="M20 9V4h-5" />
        <path d="M4 15v5h5" />
        <path d="M20 15v5h-5" />
      </template>
      <template v-else>
        <path d="M9 4v5H4" />
        <path d="M15 4v5h5" />
        <path d="M9 20v-5H4" />
        <path d="M15 20v-5h5" />
      </template>
    </svg>
  </button>
</template>

<style scoped>
/* Match the sibling top-bar buttons (Map/Deck/Pause are 80×80 design px). Mounted
   inside the scaled scene, so these design px scale with --godot-scale exactly like
   the game buttons. */
.fullscreen-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  padding: 18px; /* ~game icon inset; leaves a ~44px glyph box */
  border: 0;
  background: transparent;
  /* Scene container nodes default to pointer-events:none; re-enable for our control. */
  color: #f5f7fa;
  pointer-events: auto;
  cursor: pointer;
  /* Echo the game icons' HSV value curve: at-rest 0.9, hover 1.1 (clamped to full),
     press 0.4. */
  opacity: 0.9;
  transition: opacity 90ms ease;
}

/* Browser-space (picker) placement: there is no game UI to match, so shrink to ordinary chrome size — the exact
   box SettingsGearButton's own `--compact` uses, since the two sit side by side there. */
.fullscreen-button--compact {
  width: 44px;
  height: 44px;
  padding: 9px;
}

.fullscreen-button:hover {
  opacity: 1;
}

.fullscreen-button:active {
  opacity: 0.4;
}

.fullscreen-button:focus-visible {
  border-radius: 8px;
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: -4px;
}

.fullscreen-button__icon {
  display: block;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 55%));
}
</style>
