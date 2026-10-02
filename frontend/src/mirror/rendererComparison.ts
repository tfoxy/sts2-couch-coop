import { reactive, ref } from "vue";
import { mirrorSettings } from "@/mirror/mirrorSettings";

export type ComparisonBackend = "dom" | "canvas" | "pixi" | "rust";
export type ComparisonPixels = "direct" | "dirty" | "dirty-preserved" | "dirty-copy" | "layers" | "surfaces";
export type ComparisonIdleCadence = "authored" | "display";
export type ComparisonPixiScene = "legacy" | "retained";
export type ComparisonPixiText = "native" | "slug" | "slug-cached";

export interface RendererComparisonConfig {
  backend: ComparisonBackend;
  pixiScene: ComparisonPixiScene;
  pixiText: ComparisonPixiText;
  cpuIncremental: boolean;
  gpuCommands: boolean;
  textCache: "off" | "gpu";
  pixels: ComparisonPixels;
  idleCadence: ComparisonIdleCadence;
  structureReuse: boolean;
  textPreparationReuse: boolean;
  sourceFrameReuse: boolean;
  animationReferenceReuse: boolean;
}

export type ComparisonPresetId = "dom" | "canvas" | "text" | "pixi" | "rust" | "full" | "cpu" | "gpu" | "dirty" | "layers" | "surfaces" | "display" | "preserved" | "copy" | "cpuPrep" | "sourceFrame" | "cpuBest";
const canvasPreset = (changes: Partial<RendererComparisonConfig> = {}): RendererComparisonConfig => ({
  backend: "canvas", cpuIncremental: true, gpuCommands: true, textCache: "off", pixels: "direct", idleCadence: "authored", structureReuse: false, textPreparationReuse: false, sourceFrameReuse: false, animationReferenceReuse: false, pixiScene: "retained", pixiText: "native", ...changes
});
export const RENDERER_COMPARISON_PRESETS: Record<ComparisonPresetId, RendererComparisonConfig> = {
  dom: { backend: "dom", cpuIncremental: false, gpuCommands: false, textCache: "off", pixels: "direct", idleCadence: "authored", structureReuse: false, textPreparationReuse: false, sourceFrameReuse: false, animationReferenceReuse: false, pixiScene: "retained", pixiText: "native" },
  canvas: canvasPreset(), text: canvasPreset({ textCache: "gpu" }),
  pixi: { backend: "pixi", cpuIncremental: false, gpuCommands: false, textCache: "off", pixels: "direct", idleCadence: "authored", structureReuse: false, textPreparationReuse: false, sourceFrameReuse: false, animationReferenceReuse: false, pixiScene: "retained", pixiText: "native" },
  // Exploratory adapter over the same DrawList producer; intentionally has no independent CPU/pixel switches.
  rust: { backend: "rust", cpuIncremental: false, gpuCommands: false, textCache: "off", pixels: "direct", idleCadence: "authored", structureReuse: false, textPreparationReuse: false, sourceFrameReuse: false, animationReferenceReuse: false, pixiScene: "retained", pixiText: "native" },
  full: canvasPreset({ cpuIncremental: false, gpuCommands: false }),
  cpu: canvasPreset({ gpuCommands: false }), gpu: canvasPreset({ cpuIncremental: false }),
  dirty: canvasPreset({ pixels: "dirty" }), layers: canvasPreset({ pixels: "layers" }),
  surfaces: canvasPreset({ pixels: "surfaces" }),
  display: canvasPreset({ textCache: "gpu", idleCadence: "display" }),
  preserved: canvasPreset({ textCache: "gpu", pixels: "dirty-preserved", idleCadence: "display" }),
  copy: canvasPreset({ textCache: "gpu", pixels: "dirty-copy", idleCadence: "display" }),
  cpuPrep: canvasPreset({ textCache: "gpu", idleCadence: "display", structureReuse: true, textPreparationReuse: true }),
  sourceFrame: canvasPreset({ textCache: "gpu", idleCadence: "display", structureReuse: true, textPreparationReuse: true, sourceFrameReuse: true }),
  // No campaign prototype has passed CPU acceptance yet. Retain the verified starting configuration.
  cpuBest: canvasPreset({ textCache: "gpu", idleCadence: "display", structureReuse: true, textPreparationReuse: true, sourceFrameReuse: true })
};

export type RendererPhase = "initializing" | "active" | "failed";

export interface PixiTextRuntimeStatus {
  requested: ComparisonPixiText;
  actual: ComparisonPixiText | "mixed";
  native: number;
  slug: number;
  slugCached: number;
  reasons: Readonly<Record<string, number>>;
}

export interface RendererRuntimeStatus {
  requested: RendererComparisonConfig;
  actualBackend: ComparisonBackend | null;
  actualConfig: RendererComparisonConfig | null;
  phase: RendererPhase;
  reason: string | null;
  pixiText: PixiTextRuntimeStatus | null;
}

const DEFAULT_CONFIG: RendererComparisonConfig = {
  backend: "dom", cpuIncremental: false, gpuCommands: false, textCache: "off", pixels: "direct", idleCadence: "authored", structureReuse: false, textPreparationReuse: false, sourceFrameReuse: false, animationReferenceReuse: false, pixiScene: "retained", pixiText: "native"
};

export function comparisonEnabled(search = typeof window === "undefined" ? "" : window.location.search): boolean {
  return new URLSearchParams(search).get("rendererCompare") === "1";
}

/**
 * Public settings intentionally persist only DOM/Canvas. The developer-only Pixi and Rust routes are
 * honored on a comparison URL load without changing the saved public stage choice.
 */
export function rendererBackendForPageLoad(
  search: string,
  publicStage: "dom" | "canvas"
): ComparisonBackend {
  const params = new URLSearchParams(search);
  const requested = params.get("stage");
  if (comparisonEnabled(search) && (requested === "pixi" || requested === "rust")) return requested;
  return publicStage;
}

export function readRendererComparisonConfig(search = typeof window === "undefined" ? "" : window.location.search): RendererComparisonConfig {
  const params = new URLSearchParams(search);
  const backend = params.get("stage");
  const pixels = params.get("cmpPixels");
  const config: RendererComparisonConfig = {
    backend: backend === "canvas" || backend === "pixi" || (backend === "rust" && comparisonEnabled(search)) ? backend : "dom",
    pixiScene: params.get("pixiScene") === "legacy" ? "legacy" : "retained",
    pixiText: pixiTextMode(params.get("pixiText")),
    cpuIncremental: comparisonEnabled(search) ? params.get("cmpCpu") !== "off" : true,
    gpuCommands: comparisonEnabled(search) ? params.get("cmpGpu") !== "off" : true,
    textCache: params.get("canvasTextCache") === "gpu" ? "gpu" : "off",
    pixels: comparisonEnabled(search) && (pixels === "dirty" || pixels === "dirty-preserved" || pixels === "dirty-copy" || pixels === "layers" || pixels === "surfaces") ? pixels : "direct",
    idleCadence: comparisonEnabled(search) && params.get("cmpIdle") === "display" ? "display" : "authored",
    structureReuse: comparisonEnabled(search) && params.get("cmpStructure") === "reuse",
    textPreparationReuse: comparisonEnabled(search) && params.get("cmpTextCpu") === "reuse",
    sourceFrameReuse: comparisonEnabled(search) && params.get("cmpSource") === "reuse",
    animationReferenceReuse: comparisonEnabled(search) && params.get("cmpAnimation") === "reference"
  };
  return normalizedComparisonConfig(config);
}

/** The current view-mount contract shared by the Canvas and Pixi runtimes. */
const initialSearch = typeof window === "undefined" ? "" : window.location.search;
export const rendererComparisonConfig = reactive({
  ...readRendererComparisonConfig(initialSearch),
  backend: rendererBackendForPageLoad(initialSearch, mirrorSettings.stage)
});
/** Remounts only the scene view; the app and its seat-owning sockets remain alive. */
export const rendererComparisonViewRevision = ref(0);

/** Change the public stage without enabling the developer comparison panel or reconnecting the seat. */
export function applyViewerStage(stage: "dom" | "canvas", win = window): void {
  const url = new URL(win.location.href);
  if (url.searchParams.has("stage")) {
    url.searchParams.delete("stage");
    win.history.replaceState(win.history.state ?? null, "", url.toString());
  }
  const next = normalizedComparisonConfig({ ...rendererComparisonConfig, backend: stage });
  Object.assign(rendererComparisonConfig, next);
  setRendererRuntimeStatus({ requested: { ...next }, actualBackend: null, actualConfig: null,
    phase: "initializing", reason: null, pixiText: null });
  rendererComparisonViewRevision.value++;
}

/** Recreate only the scene view after a device-local renderer choice changes. */
export function remountViewerRenderer(): void {
  setRendererRuntimeStatus({ requested: { ...rendererComparisonConfig }, actualBackend: null, actualConfig: null,
    phase: "initializing", reason: null, pixiText: null });
  rendererComparisonViewRevision.value++;
}

/** A panel choice wins over a session URL override on this and later page loads. */
export function applyViewerTextMethod(win = window): void {
  const url = new URL(win.location.href);
  if (url.searchParams.has("textMethod")) {
    url.searchParams.delete("textMethod");
    win.history.replaceState(win.history.state ?? null, "", url.toString());
  }
  remountViewerRenderer();
}

let applyInPlace: ((next: RendererComparisonConfig) => boolean) | null = null;
/** A renderer may retain its animation owner for changes to compatible CPU policy. */
export function registerRendererComparisonApply(handler: (next: RendererComparisonConfig) => boolean): () => void {
  applyInPlace = handler;
  return () => { if (applyInPlace === handler) applyInPlace = null; };
}

/** Runtime evidence, separate from what the URL requested. Renderers publish actual admission here. */
export const rendererRuntimeStatus = reactive<RendererRuntimeStatus>({
  requested: rendererComparisonConfig, actualBackend: null, actualConfig: null,
  phase: "initializing", reason: null, pixiText: null
});

export function setRendererRuntimeStatus(next: Partial<RendererRuntimeStatus>): void {
  if (next.requested && !sameConfig(rendererRuntimeStatus.requested, next.requested)) rendererRuntimeStatus.requested = next.requested;
  if (next.actualBackend !== undefined && next.actualBackend !== rendererRuntimeStatus.actualBackend) rendererRuntimeStatus.actualBackend = next.actualBackend;
  if (next.phase !== undefined && next.phase !== rendererRuntimeStatus.phase) rendererRuntimeStatus.phase = next.phase;
  if (next.reason !== undefined && next.reason !== rendererRuntimeStatus.reason) rendererRuntimeStatus.reason = next.reason;
  if (next.actualConfig !== undefined && !sameConfig(rendererRuntimeStatus.actualConfig, next.actualConfig)) rendererRuntimeStatus.actualConfig = next.actualConfig;
  if (next.pixiText !== undefined && !samePixiTextStatus(rendererRuntimeStatus.pixiText, next.pixiText)) {
    rendererRuntimeStatus.pixiText = next.pixiText ? { ...next.pixiText, reasons: { ...next.pixiText.reasons } } : null;
  }
}

function samePixiTextStatus(a: PixiTextRuntimeStatus | null, b: PixiTextRuntimeStatus | null): boolean {
  return a === b || (a !== null && b !== null && a.requested === b.requested && a.actual === b.actual &&
    a.native === b.native && a.slug === b.slug && a.slugCached === b.slugCached &&
    Object.keys(a.reasons).length === Object.keys(b.reasons).length &&
    Object.keys(a.reasons).every((key) => a.reasons[key] === b.reasons[key]));
}

function pixiTextMode(value: unknown): ComparisonPixiText {
  return value === "slug" || value === "slug-cached" ? value : "native";
}

function sameConfig(a: RendererComparisonConfig | null, b: RendererComparisonConfig | null): boolean {
  return a === b || (a !== null && b !== null && a.backend === b.backend &&
    a.cpuIncremental === b.cpuIncremental && a.gpuCommands === b.gpuCommands &&
    a.textCache === b.textCache && a.pixels === b.pixels && a.idleCadence === b.idleCadence &&
    a.structureReuse === b.structureReuse && a.textPreparationReuse === b.textPreparationReuse &&
    a.sourceFrameReuse === b.sourceFrameReuse && a.animationReferenceReuse === b.animationReferenceReuse && a.pixiScene === b.pixiScene && a.pixiText === b.pixiText);
}

export function normalizedComparisonConfig(config: RendererComparisonConfig): RendererComparisonConfig {
  if (config.backend === "pixi") {
    return { ...DEFAULT_CONFIG, backend: "pixi", idleCadence: config.idleCadence,
      pixiScene: config.pixiScene === "legacy" ? "legacy" : "retained", pixiText: pixiTextMode(config.pixiText) };
  }
  if (config.backend === "rust") {
    return { ...DEFAULT_CONFIG, backend: "rust", idleCadence: config.idleCadence };
  }
  if (config.backend === "dom") return { ...DEFAULT_CONFIG };
  return { ...config, pixiScene: "retained", pixiText: "native", sourceFrameReuse: config.cpuIncremental && config.sourceFrameReuse,
    animationReferenceReuse: config.cpuIncremental && config.animationReferenceReuse };
}

/** Only comparison-owned params are rewritten; seat identity and other viewer settings survive. */
export function comparisonUrl(href: string, config: RendererComparisonConfig): string {
  const url = new URL(href);
  const value = normalizedComparisonConfig(config);
  url.searchParams.set("rendererCompare", "1");
  url.searchParams.set("stage", value.backend);
  if (value.backend === "pixi") {
    url.searchParams.set("pixiScene", value.pixiScene);
    url.searchParams.set("pixiText", value.pixiText);
  } else {
    url.searchParams.delete("pixiScene");
    url.searchParams.delete("pixiText");
  }
  url.searchParams.set("cmpCpu", value.cpuIncremental ? "on" : "off");
  url.searchParams.set("cmpGpu", value.gpuCommands ? "on" : "off");
  url.searchParams.set("cmpPixels", value.pixels);
  if (value.idleCadence === "display") url.searchParams.set("cmpIdle", "display");
  else url.searchParams.delete("cmpIdle");
  if (value.textCache === "gpu") url.searchParams.set("canvasTextCache", "gpu");
  else url.searchParams.delete("canvasTextCache");
  if (value.structureReuse) url.searchParams.set("cmpStructure", "reuse");
  else url.searchParams.delete("cmpStructure");
  if (value.textPreparationReuse) url.searchParams.set("cmpTextCpu", "reuse");
  else url.searchParams.delete("cmpTextCpu");
  if (value.sourceFrameReuse) url.searchParams.set("cmpSource", "reuse");
  else url.searchParams.delete("cmpSource");
  if (value.animationReferenceReuse) url.searchParams.set("cmpAnimation", "reference");
  else url.searchParams.delete("cmpAnimation");
  return url.toString();
}

/** Apply a manual comparison mode within this document. A page navigation
 * closes the host socket and destroys a lobby seat, even when `name` survives. */
export function applyRendererComparisonConfig(config: RendererComparisonConfig,
  env: { location: Pick<Location, "href">; history: Pick<History, "replaceState" | "state"> } = window): void {
  const next = normalizedComparisonConfig(config);
  env.history.replaceState(env.history.state ?? null, "", comparisonUrl(env.location.href, next));
  Object.assign(rendererComparisonConfig, next);
  setRendererRuntimeStatus({ requested: { ...next }, actualBackend: null, actualConfig: null,
    phase: "initializing", reason: null, pixiText: null });
  if (!applyInPlace?.(next)) rendererComparisonViewRevision.value++;
}
