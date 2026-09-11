<script setup lang="ts">
import { ref } from "vue";
import { translate as t } from "@/i18n";

// The settings panel's help affordance: a small "?" disc at the end of a row's label that reveals a one-to-three
// sentence description of that setting. Built here because the frontend has NO tooltip primitive at all (the only
// prior art is a native `title=`, which a phone can never show).
//
// WHY IT EXISTS AT ALL: the panel used to explain a handful of settings with permanent note paragraphs under the
// group — which explained 7 of 15 rows, and made the dropdown tall enough to run off a phone screen. On-demand
// bubbles explain EVERY row and cost zero height until asked.
//
// CONTRACT (the parts a spec pins):
//   * ≥28px hit target — a thumb target on a phone, not a 12px glyph.
//   * CONTROLLED open state: the panel owns which tip is open, so only ONE can be (`open` + `toggle`). The panel
//     also closes it on an outside tap, on scroll, and when the panel itself closes.
//   * hover shows it too, but only for a real MOUSE (`pointerenter` with pointerType "mouse"). A touch tap also
//     synthesizes mouse events on mobile browsers, and honouring those would leave a bubble stuck open after the
//     tap that closed it.
//   * `data-settings-help` marks both the button and the bubble as "part of the help UI" — the panel's
//     outside-tap handler looks for exactly that, so pressing one tip's icon while another is open swaps them
//     instead of closing everything.
const props = defineProps<{
  /** Stable id for the testids + the aria wiring (one per row). */
  tipId: string;
  /** The row's own label, used to name the button for screen readers ("About Widescreen stretch"). */
  label: string;
  /** The description itself. */
  text: string;
  /** Whether THIS tip is the panel's currently open one. */
  open?: boolean;
  /**
   * Which way the bubble opens. The panel is a scroll container with `overflow: auto`, so a bubble hanging BELOW
   * one of the last rows would be clipped by the panel's own bottom edge — those rows pass "above". (A measured
   * flip would need layout the panel doesn't have on first paint; the row's position in the panel is static, so
   * the caller simply knows.)
   */
  placement?: "below" | "above";
}>();

const emit = defineEmits<{ (e: "toggle"): void }>();

// Mouse-only hover, tracked separately from the panel-owned `open` so a hover never steals the tap state.
const hovered = ref(false);

function onPointerEnter(event: PointerEvent): void {
  if (event.pointerType === "mouse") {
    hovered.value = true;
  }
}

function onPointerLeave(): void {
  hovered.value = false;
}
</script>

<template>
  <button
    type="button"
    class="settings-help"
    data-settings-help
    :data-testid="`mirror-help-${props.tipId}`"
    :aria-label="t('a11y.about', { label: props.label })"
    :aria-expanded="Boolean(props.open)"
    @click.stop.prevent="emit('toggle')"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
  >
    <span class="settings-help__glyph" aria-hidden="true">?</span>
  </button>
  <p
    v-if="props.open || hovered"
    class="settings-help-bubble"
    :class="{ 'settings-help-bubble--above': props.placement === 'above' }"
    data-settings-help
    role="tooltip"
    :data-testid="`mirror-help-bubble-${props.tipId}`"
  >
    {{ props.text }}
  </p>
</template>

<style scoped>
/* 28×28: the minimum comfortable touch target, and the reason the glyph inside is only 13px. */
.settings-help {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: -3px 0; /* absorb the box into the row's own 3px padding so no row grows taller */
  padding: 0;
  border: 0;
  background: transparent;
  color: #eee;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 90ms ease;
}

.settings-help:hover,
.settings-help[aria-expanded="true"] {
  opacity: 1;
}

.settings-help:focus-visible {
  border-radius: 50%;
  outline: 2px solid rgb(124 199 238 / 72%);
  outline-offset: -2px;
}

/* The visible disc is smaller than the hit box above it. */
.settings-help__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1px solid currentcolor;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

/* Hangs UNDER the row it explains, spanning the panel's content width. Absolute (against the row wrapper's
   `position: relative`) so opening one never re-flows the panel or moves the control the viewer just tapped. */
.settings-help-bubble {
  position: absolute;
  z-index: 1;
  top: calc(100% - 2px);
  right: 0;
  left: 0;
  margin: 0;
  padding: 7px 9px;
  border-radius: 8px;
  /* FULLY opaque: the bubble sits over the rows below it, and even a 1% bleed reads as a rendering fault. */
  background: #1e242e;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16), 0 6px 16px rgba(0, 0, 0, 0.55);
  color: #e8ecf2;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.35;
  text-align: left;
  white-space: normal;
  pointer-events: none; /* a tap "on" the bubble lands on the panel behind it, which closes it */
}

/* Bottom-of-panel rows open upward so the panel's own overflow can't clip the text. */
.settings-help-bubble--above {
  top: auto;
  bottom: calc(100% - 2px);
}
</style>
