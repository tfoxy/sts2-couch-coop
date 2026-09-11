<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from "vue";
import { translate as t } from "@/i18n";

import { browserInstallPromptEnv, createInstallPromptController } from "@/pwa/installPrompt";

// The Android "Install" affordance. All of the decision logic (platform gate, already-installed gate,
// declined-recently backoff, single-use event handling) lives in `installPrompt.ts` so it can be tested
// without a DOM; this file is only the pill and its placement.
//
// Placement: fixed bottom-LEFT. Top-centre is the settings gear + fullscreen pair, top-right is the
// latency overlay, bottom-centre is the player's hand once a run is live — bottom-left is the one corner
// nothing else claims, in either client.
const controller = createInstallPromptController(browserInstallPromptEnv());
onScopeDispose(() => controller.dispose());

/**
 * Self-retiring: the pill fades out on its own if it is ignored.
 *
 * `beforeinstallprompt` fires on load, i.e. while the player is on the seat picker — the right moment to
 * offer this. But the same pill would then sit in the corner for the whole run, and the App shell has no
 * business knowing whether a run is live (the shell is deliberately independent of the client). A
 * timeout is the decoupled version of "only show it while it's relevant". Nothing is persisted, so a
 * reload offers it again.
 */
const AUTO_RETIRE_MS = 20_000;
const retired = shallowRef(false);
let retireTimer: ReturnType<typeof setTimeout> | undefined;

const clearRetireTimer = (): void => {
  if (retireTimer !== undefined) clearTimeout(retireTimer);
  retireTimer = undefined;
};

watch(
  controller.visible,
  (visible) => {
    clearRetireTimer();
    if (!visible) return;
    retired.value = false;
    retireTimer = setTimeout(() => {
      retired.value = true;
    }, AUTO_RETIRE_MS);
  },
  { immediate: true }
);

onScopeDispose(clearRetireTimer);

const show = computed(() => controller.visible.value && !retired.value);

async function onClick(): Promise<void> {
  clearRetireTimer();
  await controller.promptInstall();
}
</script>

<template>
  <button
    v-if="show"
    type="button"
    class="install-button"
    data-testid="install-button"
    :title="t('install.android')"
    :aria-label="t('install.android')"
    @click="onClick"
  >
    <!-- Inline SVG for the same reason the sibling chrome buttons use one: crisp at any DPR and
         independent of whether a webfont has loaded. Arrow into a tray = the platform install idiom. -->
    <svg
      class="install-button__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4 18.5h16" />
    </svg>
    <span class="install-button__label">{{ t('common.install') }}</span>
  </button>
</template>

<style scoped>
/* CouchCoop's OWN chrome (not scene DOM): a small browser-space pill, unscaled by --godot-scale. */
.install-button {
  position: fixed;
  bottom: calc(8px + env(safe-area-inset-bottom));
  left: calc(8px + env(safe-area-inset-left));
  z-index: 2147483644; /* under the picker gear (…645) and the settings/latency layers. */
  display: inline-flex;
  gap: 7px;
  align-items: center;
  min-height: 40px;
  padding: 0 14px 0 11px;
  border: 1px solid rgb(255 255 255 / 18%);
  border-radius: 999px;
  background: rgb(16 21 26 / 82%);
  color: #f5f7fa;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 550;
  backdrop-filter: blur(6px);
  box-shadow: 0 2px 10px rgb(0 0 0 / 45%);
  cursor: pointer;
  opacity: 0.92;
  transition: opacity 90ms ease;
}

.install-button:hover {
  opacity: 1;
}

.install-button:active {
  opacity: 0.55;
}

.install-button:focus-visible {
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: 2px;
}

.install-button__icon {
  display: block;
  width: 18px;
  height: 18px;
  color: #7cc7ee;
}

.install-button__label {
  line-height: 1;
}
</style>
