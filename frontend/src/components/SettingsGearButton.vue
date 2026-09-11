<script setup lang="ts">
import { translate as t } from "@/i18n";

import { mirrorSettings } from "@/mirror/mirrorSettings";

// The mirror's settings TOGGLE — deliberately the FullscreenButton's twin, not its own widget: same 80x80
// design-px box, same inset, same at-rest/hover/press opacity curve, same inline-SVG glyph idiom. In game it is
// mounted inside the scaled `.mirror-stage` at the exact horizontal centre, so it lands inside the game's own
// TopBar and scales with it (the fullscreen button sits to its right); on the pre-join picker there is no game UI
// to scale with, so it is mounted `compact` as browser-space chrome at the top centre instead.
//
// It writes the button's on-screen bottom edge into the store as the panel's anchor, which is what lets the
// dropdown open UNDER whichever of the two placements was actually pressed — the in-stage one moves with the
// stage's scale + letterbox, so a hardcoded offset would overlap the button on a large display and swallow the
// click that closes it again.
const props = defineProps<{
  /** Browser-space placement (the join/picker screen): a 44px chrome button instead of the 80px design-px one. */
  compact?: boolean;
}>();

const settings = mirrorSettings;

/** Gap between the button's bottom edge and the dropdown's top edge. */
const PANEL_GAP_PX = 6;

function toggle(event: MouseEvent): void {
  const button = event.currentTarget as HTMLElement | null;
  const bottom = button?.getBoundingClientRect().bottom ?? 0;
  // A 0 rect (jsdom, or a button that isn't laid out) falls back to the store's seeded default rather than
  // pinning the panel to the very top of the viewport.
  if (bottom > 0) {
    settings.panelAnchorTop = Math.round(bottom + PANEL_GAP_PX);
  }
  settings.panelOpen = !settings.panelOpen;
}
</script>

<template>
  <button
    type="button"
    class="settings-gear-button"
    :class="{ 'settings-gear-button--compact': props.compact }"
    data-testid="mirror-settings-toggle"
    :title="t('common.settings')"
    :aria-label="t('common.settings')"
    :aria-expanded="settings.panelOpen"
    @click="toggle"
  >
    <!-- Inline SVG (same reasoning as FullscreenButton): crisp at any stage scale, font-independent, and
         `currentColor` carries the hover/press dimming into the glyph. A thick ring + eight radial teeth reads
         as a cog down to ~24px, where a finer many-toothed outline turns to mush. -->
    <svg
      class="settings-gear-button__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="6" stroke-width="4.2" />
      <g stroke-width="2.6">
        <path d="M19.6 12h2.2" />
        <path d="M17.37 6.63 18.93 5.07" />
        <path d="M12 4.4V2.2" />
        <path d="M6.63 6.63 5.07 5.07" />
        <path d="M4.4 12H2.2" />
        <path d="M6.63 17.37 5.07 18.93" />
        <path d="M12 19.6v2.2" />
        <path d="M17.37 17.37 18.93 18.93" />
      </g>
    </svg>
  </button>
</template>

<style scoped>
/* Byte-for-byte the FullscreenButton's box + interaction treatment (Map/Deck/Pause are 80x80 design px).
   Mounted inside the scaled stage, so these design px scale with the game exactly like its own buttons. */
.settings-gear-button {
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
  /* Echo the game icons' HSV value curve: at-rest 0.9, hover 1.1 (clamped to full), press 0.4. */
  opacity: 0.9;
  transition: opacity 90ms ease;
}

/* Browser-space (picker) placement: there is no game UI to match, so shrink to ordinary chrome size. */
.settings-gear-button--compact {
  width: 44px;
  height: 44px;
  padding: 9px;
}

.settings-gear-button:hover {
  opacity: 1;
}

.settings-gear-button:active {
  opacity: 0.4;
}

.settings-gear-button:focus-visible {
  border-radius: 8px;
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: -4px;
}

.settings-gear-button__icon {
  display: block;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 55%));
}
</style>
