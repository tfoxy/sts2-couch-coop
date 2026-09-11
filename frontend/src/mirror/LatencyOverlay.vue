<script setup lang="ts">
import { computed } from "vue";
import { translate as t } from "@/i18n";

import type { MirrorLatency } from "@/mirror/mirrorClient";

// A tiny, unobtrusive round-trip latency readout. Shown by the `?latency=1` harness path OR the settings panel's
// "Show overlay" checkbox (`mirrorSettings.latencyOverlay`), which keeps it up with the panel CLOSED. Green while the p95
// stays within the 50ms target, red once it slips — so the latency budget is visible while actually playing,
// not just in a script. Pure display: the RTT comes from the client's ping→pong probe.
const props = defineProps<{ latency: MirrorLatency }>();

const TARGET_MS = 50;

function fmt(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}ms`;
}

const ok = computed(() => props.latency.p95 !== null && props.latency.p95 <= TARGET_MS);
</script>

<template>
  <div class="latency-overlay" :class="{ 'latency-ok': ok, 'latency-bad': !ok }" data-testid="latency-overlay">
    <span class="latency-label">{{ t('latency.rtt') }}</span>
    <span class="latency-value">{{ fmt(latency.lastMs) }}</span>
    <span class="latency-stat">{{ t('latency.p50', { value: fmt(latency.p50) }) }}</span>
    <span class="latency-stat">{{ t('latency.p95', { value: fmt(latency.p95) }) }}</span>
    <span class="latency-stat">{{ t('latency.count', { count: latency.count }) }}</span>
  </div>
</template>

<style scoped>
.latency-overlay {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 2147483647;
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  padding: 4px 8px;
  border-radius: 6px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.2;
  color: #fff;
  background: rgba(0, 0, 0, 0.7);
  pointer-events: none;
  user-select: none;
}

.latency-ok {
  box-shadow: inset 0 0 0 1px #2ecc71;
}

.latency-bad {
  box-shadow: inset 0 0 0 1px #e74c3c;
}

.latency-label {
  font-weight: 700;
  letter-spacing: 0.05em;
  opacity: 0.7;
}

.latency-value {
  font-weight: 700;
}

.latency-ok .latency-value {
  color: #2ecc71;
}

.latency-bad .latency-value {
  color: #e74c3c;
}

.latency-stat {
  opacity: 0.7;
}
</style>
