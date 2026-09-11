<script setup lang="ts">
import { computed } from "vue";
import { translate as t } from "@/i18n";

import { readDisplayEnv, readElementFullscreenSupported, shouldShowIosInstallHint } from "@/join/joinModel";
import type { IosInstallHintEnv } from "@/join/joinModel";

// The re-open pill for the guided iPhone install overlay (@/join/IosInstallOverlay.vue). Occupies EXACTLY the
// slot FullscreenButton would otherwise leave empty: iPhone Safari has no element Fullscreen API, so the two are
// mutually exclusive BY CONSTRUCTION — this shows only where `readElementFullscreenSupported()` is false, and
// FullscreenButton hides there for the same reason. Once the overlay is dismissed for this page load (or ever,
// via its "Don't show this again" checkbox), the overlay itself will not re-arm — this pill is the ONLY way
// back to the steps, so unlike the overlay it deliberately ignores BOTH dismissal signals.
const props = defineProps<{
  /** Browser-space placement (matches FullscreenButton's `compact`, the join/picker screen's 44px chrome box). */
  compact?: boolean;
  /** Decision inputs. Defaults to the live environment; a prop so specs can drive it without redefining globals. */
  env?: IosInstallHintEnv;
  /** Defaults to the live `document.fullscreenEnabled` (minus the `?iosInstall=force` lever). Spec seam. */
  fullscreenSupported?: boolean;
}>();

const emit = defineEmits<{ (e: "open"): void }>();

const env = computed<IosInstallHintEnv>(() => props.env ?? readDisplayEnv());
const fullscreenSupported = computed(() => props.fullscreenSupported ?? readElementFullscreenSupported());
const shown = computed(() => shouldShowIosInstallHint(env.value) && !fullscreenSupported.value);
</script>

<template>
  <button
    v-if="shown"
    type="button"
    class="ios-install-button"
    :class="{ 'ios-install-button--compact': props.compact }"
    data-testid="ios-install-button"
    :title="t('install.iosTitle')"
    :aria-label="t('install.iosHelp')"
    @click="emit('open')"
  >
    <!-- Same glyph as the overlay's "Add to Home Screen" step: a plus inside a rounded square. -->
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  </button>
</template>

<style scoped>
/* FullscreenButton's structural twin — same box sizes, same HSV opacity curve — so the two never cause a layout
   jump when one replaces the other in the same slot. */
.ios-install-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  padding: 18px;
  border: 0;
  background: transparent;
  color: #f5f7fa;
  pointer-events: auto;
  cursor: pointer;
  opacity: 0.9;
  transition: opacity 90ms ease;
}

.ios-install-button--compact {
  width: 44px;
  height: 44px;
  padding: 9px;
}

.ios-install-button:hover {
  opacity: 1;
}

.ios-install-button:active {
  opacity: 0.4;
}

.ios-install-button:focus-visible {
  border-radius: 8px;
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: -4px;
}

.ios-install-button svg {
  display: block;
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 55%));
}
</style>
