<script setup lang="ts">
import { computed, ref } from "vue";
import { translate as t } from "@/i18n";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { renderQuality } from "@/render/quality";
import {
  applyRendererComparisonConfig, normalizedComparisonConfig, rendererComparisonConfig, rendererRuntimeStatus,
  RENDERER_COMPARISON_PRESETS,
  type ComparisonBackend, type ComparisonPixels, type ComparisonPresetId, type RendererComparisonConfig
} from "@/mirror/rendererComparison";
import { setComparisonStageBackend } from "@/mirror/rendererFactory";

const PRESETS = RENDERER_COMPARISON_PRESETS;
const PRESET_IDS = Object.keys(PRESETS) as ComparisonPresetId[];
const PIXELS: ComparisonPixels[] = ["direct", "dirty", "dirty-preserved", "dirty-copy", "layers", "surfaces"];
const draft = ref<RendererComparisonConfig>({ ...rendererComparisonConfig });

const rustSliceEligible = computed(() => renderQuality().tier === "very-low" &&
  mirrorSettings.shaderMode === "off" && mirrorSettings.particleMode === "off" &&
  mirrorSettings.staticBgEnabled && mirrorSettings.spineMode === "static");

function equal(a: RendererComparisonConfig, b: RendererComparisonConfig): boolean {
  return a.backend === b.backend && a.cpuIncremental === b.cpuIncremental &&
    a.gpuCommands === b.gpuCommands && a.textCache === b.textCache && a.pixels === b.pixels &&
    a.idleCadence === b.idleCadence && a.structureReuse === b.structureReuse &&
    a.textPreparationReuse === b.textPreparationReuse && a.sourceFrameReuse === b.sourceFrameReuse &&
    a.animationReferenceReuse === b.animationReferenceReuse && a.pixiScene === b.pixiScene && a.pixiText === b.pixiText;
}
const selectedPreset = ref<ComparisonPresetId | null>(null);
const preset = computed<ComparisonPresetId | "custom">(() =>
  selectedPreset.value && equal(draft.value, PRESETS[selectedPreset.value]) ? selectedPreset.value
    : PRESET_IDS.find((id) => equal(draft.value, PRESETS[id])) ?? "custom");
const changed = computed(() => !equal(draft.value, rendererComparisonConfig));
const canApply = computed(() => changed.value &&
  (draft.value.backend !== "pixi" && draft.value.backend !== "rust" || rustSliceEligible.value));
const canvasSelected = computed(() => draft.value.backend === "canvas");
const status = rendererRuntimeStatus;
const actual = computed(() => status.actualConfig ? modeLabel(status.actualConfig, status.pixiText?.actual) : null);
const textFallbacks = computed(() => status.actualBackend === "pixi" && status.pixiText
  ? Object.entries(status.pixiText.reasons).map(([reason, count]) => `${reason}: ${count}`).join(" · ") : "");

function modeLabel(config: RendererComparisonConfig, actualText?: string): string {
  if (config.backend === "pixi") return `PIXI · ${config.pixiScene} · ${actualText ?? config.pixiText} · ${t(`compare.idle.${config.idleCadence}`)}`;
  if (config.backend === "rust") return `RUST/WASM · ${t(`compare.idle.${config.idleCadence}`)}`;
  if (config.backend !== "canvas") return config.backend.toUpperCase();
  const parts = ["Canvas", t(`compare.pixels.${config.pixels}`)];
  if (config.cpuIncremental) parts.push(t("compare.cpu"));
  if (config.gpuCommands) parts.push(t("compare.gpu"));
  if (config.textCache === "gpu") parts.push(t("compare.text"));
  if (config.structureReuse) parts.push(t("compare.structureReuse"));
  if (config.textPreparationReuse) parts.push(t("compare.textPreparationReuse"));
  if (config.sourceFrameReuse) parts.push(t("compare.sourceFrameReuse"));
  if (config.animationReferenceReuse) parts.push(t("compare.animationReferenceReuse"));
  if (config.idleCadence === "display") parts.push(t("compare.idle.display"));
  return parts.join(" · ");
}

function selectPreset(event: Event): void {
  const id = (event.target as HTMLSelectElement).value as ComparisonPresetId;
  if (id in PRESETS) { selectedPreset.value = id; draft.value = { ...PRESETS[id] }; }
}

function setBackend(event: Event): void {
  const backend = (event.target as HTMLSelectElement).value as ComparisonBackend;
  draft.value = normalizedComparisonConfig({ ...draft.value, backend });
}

function setPixels(event: Event): void {
  const pixels = (event.target as HTMLSelectElement).value as ComparisonPixels;
  draft.value = { ...draft.value, pixels };
}

function setCpuIncremental(event: Event): void {
  draft.value.cpuIncremental = (event.target as HTMLInputElement).checked;
  if (!draft.value.cpuIncremental) {
    draft.value.sourceFrameReuse = false;
    draft.value.animationReferenceReuse = false;
  }
}

function navigate(config: RendererComparisonConfig): void {
  const next = normalizedComparisonConfig(config);
  setComparisonStageBackend(next.backend);
  applyRendererComparisonConfig(next);
  draft.value = { ...next };
}

function apply(): void {
  if (canApply.value) navigate(draft.value);
}
</script>

<template>
  <details class="renderer-comparison" data-testid="renderer-comparison">
    <summary>{{ t('compare.title') }}</summary>
    <p class="comparison-status" aria-live="polite">
      {{ t('compare.requested') }}: {{ modeLabel(status.requested) }}<br />
      {{ t('compare.actual') }}:
      <template v-if="status.phase === 'failed'">{{ t('compare.unavailable') }}</template>
      <template v-else-if="status.phase === 'initializing'">{{ t('compare.initializing') }}</template>
      <template v-else>{{ actual ?? `${status.actualBackend?.toUpperCase() ?? '—'} (${t('compare.unconfirmed')})` }}</template>
      <span v-if="status.reason" class="comparison-reason">{{ status.reason }}</span>
      <span v-if="textFallbacks" class="comparison-reason" data-testid="pixi-text-fallbacks">{{ textFallbacks }}</span>
    </p>
    <label class="comparison-row">{{ t('compare.preset') }}
      <select :value="preset" data-testid="renderer-preset" @change="selectPreset">
        <option v-if="preset === 'custom'" value="custom">{{ t('compare.custom') }}</option>
        <option v-for="id in PRESET_IDS" :key="id" :value="id" :disabled="(id === 'pixi' || id === 'rust') && !rustSliceEligible">
          {{ t(`compare.preset.${id}`) }}
        </option>
      </select>
    </label>
    <label class="comparison-row">{{ t('compare.renderer') }}
      <select :value="draft.backend" data-testid="renderer-backend" @change="setBackend">
        <option value="dom">DOM</option><option value="canvas">Canvas</option>
        <option value="pixi" :disabled="!rustSliceEligible">Pixi</option>
        <option value="rust" :disabled="!rustSliceEligible">Rust/WASM</option>
      </select>
    </label>
    <p v-if="!rustSliceEligible" class="comparison-hint">{{ t('compare.pixiNeeds') }}</p>
    <label class="comparison-row"><input :checked="draft.cpuIncremental" type="checkbox" :disabled="!canvasSelected" @change="setCpuIncremental" />{{ t('compare.cpu') }}</label>
    <label class="comparison-row"><input v-model="draft.gpuCommands" type="checkbox" :disabled="!canvasSelected" />{{ t('compare.gpu') }}</label>
    <label class="comparison-row"><input v-model="draft.textCache" type="checkbox" true-value="gpu" false-value="off" :disabled="!canvasSelected" />{{ t('compare.text') }}</label>
    <label class="comparison-row"><input v-model="draft.structureReuse" type="checkbox" data-testid="renderer-structure-reuse" :disabled="!canvasSelected" />{{ t('compare.structureReuse') }}</label>
    <label class="comparison-row"><input v-model="draft.textPreparationReuse" type="checkbox" data-testid="renderer-text-preparation-reuse" :disabled="!canvasSelected" />{{ t('compare.textPreparationReuse') }}</label>
    <label class="comparison-row"><input v-model="draft.sourceFrameReuse" type="checkbox" data-testid="renderer-source-frame-reuse" :disabled="!canvasSelected || !draft.cpuIncremental" />{{ t('compare.sourceFrameReuse') }}</label>
    <label class="comparison-row"><input v-model="draft.animationReferenceReuse" type="checkbox" data-testid="renderer-animation-reference-reuse" :disabled="!canvasSelected || !draft.cpuIncremental" />{{ t('compare.animationReferenceReuse') }}</label>
    <label class="comparison-row">{{ t('compare.pixels') }}
      <select :value="draft.pixels" :disabled="!canvasSelected" data-testid="renderer-pixels" @change="setPixels">
        <option v-for="mode in PIXELS" :key="mode" :value="mode">{{ t(`compare.pixels.${mode}`) }}</option>
      </select>
    </label>
    <p class="comparison-hint">{{ t('compare.pixelExclusive') }}</p>
    <label class="comparison-row">{{ t('compare.idle') }}
      <select v-model="draft.idleCadence" :disabled="draft.backend === 'dom'" data-testid="renderer-idle-cadence">
        <option value="authored">{{ t('compare.idle.authored') }}</option>
        <option value="display">{{ t('compare.idle.display') }}</option>
      </select>
    </label>
    <p class="comparison-hint">{{ t('compare.idleHint') }}</p>
    <button type="button" :disabled="!canApply" data-testid="renderer-apply" @click="apply">{{ t('compare.apply') }}</button>
    <p class="comparison-hint">{{ t('compare.applyHint') }}</p>
    <button v-if="status.phase === 'failed'" type="button" data-testid="renderer-recover" @click="navigate(status.requested)">{{ t('boot.tryAgain') }}</button>
  </details>
</template>

<style scoped>
.renderer-comparison { margin: 0.45rem 0; padding: 0.55rem; border: 1px solid #7777; border-radius: 0.4rem; }
.renderer-comparison summary { cursor: pointer; font-weight: 650; }
.comparison-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin: 0.55rem 0; }
.comparison-row select { max-width: 54%; }
.comparison-status, .comparison-hint { margin: 0.5rem 0; font-size: 0.82rem; }
.comparison-reason { display: block; color: #f6b78b; overflow-wrap: anywhere; }
.renderer-comparison button { margin: 0.2rem 0.3rem 0 0; }
</style>
