<script setup lang="ts">
import { computed, ref } from "vue";
import { translate as t } from "@/i18n";

import {
  BROWSER_ADVISORY_DISMISSED_STORAGE_KEY,
  readBrowserAdvisoryEnv,
  shouldShowBrowserAdvisory,
  writeDismissedFlag,
  type BrowserAdvisoryEnv
} from "@/join/joinModel";

// WS4 — a dismissible line of advice above the seat list, shown only on browsers we have a concrete report
// against (today: Samsung Internet, which mis-renders some in-game text).
//
// ADVISORY, NEVER A GATE. It sits beside the picker rather than in front of it, has no "continue" step, and
// joining is completely unaffected — a player who ignores it plays exactly as before. That is deliberate: the
// UA sniff behind it can misfire, and the cost of a false positive must never be more than one line of text.
const props = defineProps<{
  /** Decision inputs; defaults to the live browser environment. Specs pass an explicit env. */
  env?: BrowserAdvisoryEnv;
  /** The dismissal jar. Defaults to `localStorage`; null disables persistence (used by specs). */
  storage?: Pick<Storage, "setItem"> | null;
}>();

const dismissed = ref(false);
const env = computed<BrowserAdvisoryEnv>(() => props.env ?? readBrowserAdvisoryEnv());
const visible = computed(() => !dismissed.value && shouldShowBrowserAdvisory(env.value));

function dismiss(): void {
  dismissed.value = true;
  const storage = props.storage !== undefined ? props.storage : safeLocalStorage();
  writeDismissedFlag(storage, BROWSER_ADVISORY_DISMISSED_STORAGE_KEY);
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
  <p v-if="visible" class="browser-advisory" data-testid="browser-advisory" role="status">
    <span class="browser-advisory-text">{{ t('advisory.browser') }}</span>
    <button
      type="button"
      class="browser-advisory-dismiss"
      data-testid="browser-advisory-dismiss"
      :aria-label="t('a11y.dismissBrowserAdvice')"
      @click="dismiss"
    >
      ×
    </button>
  </p>
</template>

<style scoped>
/* CouchCoop's own join chrome. Amber like the existing `.notice-list` advisories in styles.css, so "worth
   reading, not an error" already has a visual language on this screen.
   Deliberately NO width of its own: a child component's root carries BOTH its own scope and its parent's, at
   identical specificity, so a width here would be in a stylesheet-order coin toss with whatever the mount point
   sets. It fills its container instead, and the two mount points size that container. */
.browser-advisory {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  /* The component owns its own top spacing so a browser we have no report against costs NOTHING — no element,
     no spacer div, no margin. Mount points render `<BrowserAdvisory />` bare. */
  margin: clamp(0.6rem, 2cqw, 0.9rem) 0 0;
  padding: 0.5rem 0.55rem 0.5rem 0.7rem;
  border: 1px solid rgb(255 209 102 / 32%);
  border-radius: 6px;
  color: #f0dba0;
  background: rgb(255 209 102 / 8%);
  font-size: clamp(0.72rem, 1.6cqw, 0.86rem);
  line-height: 1.3;
}

.browser-advisory-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.browser-advisory-dismiss {
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

.browser-advisory-dismiss:hover {
  background: rgb(255 209 102 / 14%);
}

.browser-advisory-dismiss:focus-visible {
  outline: 3px solid rgb(124 199 238 / 72%);
  outline-offset: 2px;
}
</style>
