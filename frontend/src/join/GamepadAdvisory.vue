<script setup lang="ts">
import { computed, ref } from "vue";
import { translate as t } from "@/i18n";

import {
  GAMEPAD_ADVISORY_DISMISSED_STORAGE_KEY,
  readGamepadAdvisoryEnv,
  shouldShowGamepadAdvisory,
  writeDismissedFlag,
  type GamepadAdvisoryEnv
} from "@/join/joinModel";

// The GAMEPAD advisory: one dismissible line telling a player holding a controller why their pad does nothing on
// this join, and what to do about it (rejoin from the host's secure / web-link QR row). The Gamepad API is
// secure-context only, so on the default plain-HTTP LAN origin the browser cannot even see the pad — see
// joinModel's `shouldShowGamepadAdvisory` for the decision and mirror/gamepadCapture.ts for what it unlocks.
//
// ADVISORY, NEVER A GATE — the sibling rule from BrowserAdvisory.vue, for the same reason: the "is a pad plausibly
// present" signal cannot be a feature test on an origin that hides the feature, so it is partly a UA sniff, and the
// cost of a false positive must never be more than one line of text. Nothing here touches joining or playing.
const props = defineProps<{
  /** Decision inputs; defaults to the live browser environment. Specs pass an explicit env. */
  env?: GamepadAdvisoryEnv;
  /** The dismissal jar. Defaults to `localStorage`; null disables persistence (used by specs). */
  storage?: Pick<Storage, "setItem"> | null;
}>();

const dismissed = ref(false);
const env = computed<GamepadAdvisoryEnv>(() => props.env ?? readGamepadAdvisoryEnv());
const visible = computed(() => !dismissed.value && shouldShowGamepadAdvisory(env.value));

function dismiss(): void {
  dismissed.value = true;
  const storage = props.storage !== undefined ? props.storage : safeLocalStorage();
  writeDismissedFlag(storage, GAMEPAD_ADVISORY_DISMISSED_STORAGE_KEY);
}

function safeLocalStorage(): Pick<Storage, "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
</script>

<template>
  <p v-if="visible" class="gamepad-advisory" data-testid="gamepad-advisory" role="status">
    <span class="gamepad-advisory-text">{{ t('advisory.gamepad') }}</span>
    <button
      type="button"
      class="gamepad-advisory-dismiss"
      data-testid="gamepad-advisory-dismiss"
      :aria-label="t('a11y.dismissGamepadAdvice')"
      @click="dismiss"
    >
      ×
    </button>
  </p>
</template>

<style scoped>
/* CouchCoop's own join chrome, deliberately the SAME amber notice as BrowserAdvisory.vue — the two stack in one
   slot and must read as one voice. The rules are duplicated rather than shared because a scoped block cannot be
   inherited across components and hoisting them into the global sheet would be a visual change to a screen this
   round has no way to re-verify. If a third advisory ever appears, extract the three into one presentational
   component instead of copying this a second time.
   No width of its own: a child component's root carries BOTH its own scope and its parent's at identical
   specificity, so a width here would be in a stylesheet-order coin toss with whatever the mount point sets. */
.gamepad-advisory {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  /* Owns its own top spacing, so a browser that has nothing to advise costs NOTHING — no element, no spacer. */
  margin: clamp(0.6rem, 2cqw, 0.9rem) 0 0;
  padding: 0.5rem 0.55rem 0.5rem 0.7rem;
  border: 1px solid rgb(255 209 102 / 32%);
  border-radius: 6px;
  color: #f0dba0;
  background: rgb(255 209 102 / 8%);
  font-size: clamp(0.72rem, 1.6cqw, 0.86rem);
  line-height: 1.3;
}

.gamepad-advisory-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.gamepad-advisory-dismiss {
  flex: 0 0 auto;
  width: 1.75rem;
  height: 1.75rem;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: 4px;
  color: #f0dba0;
  background: transparent;
  font: inherit;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}

.gamepad-advisory-dismiss:hover {
  background: rgb(255 209 102 / 14%);
}

.gamepad-advisory-dismiss:focus-visible {
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: 2px;
}
</style>
