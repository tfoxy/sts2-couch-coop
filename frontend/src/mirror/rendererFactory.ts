// Public stage selection: WebKit starts on canvas, other fresh viewers on DOM; canvas means Rust WebGL.
// GPU failures leave the selected stage in place. The viewer may retry or select DOM explicitly.
// The legacy canvas constructor is reachable only through the unit-test override.

import { createMirrorRenderer } from "@/mirror/mirrorRenderer";
import { createCanvasMirrorRenderer } from "@/mirror/canvas/canvasRenderer";
import { createPixiMirrorRenderer } from "@/mirror/renderer/pixi/createPixiMirrorRenderer";
import { createRustMirrorRenderer } from "@/mirror/renderer/pixi/createRustMirrorRenderer";
import type { MirrorRenderer } from "@/mirror/renderer/contracts";
import { isGeoclipPlaybackEnabled } from "@/mirror/spineAttributes";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { normalizedComparisonConfig, rendererBackendForPageLoad, rendererComparisonConfig, setRendererRuntimeStatus } from "@/mirror/rendererComparison";

export type StageBackend = "dom" | "canvas" | "pixi" | "rust";

function readStageBackend(): StageBackend {
  const search = typeof window === "undefined" ? "" : window.location.search;
  return rendererBackendForPageLoad(search, mirrorSettings.runtimeStage);
}

let stageBackend: StageBackend = readStageBackend();
let activeBackend: StageBackend = stageBackend;
let legacyCanvasTestOverride = false;

/** The backend requested by this page. A failed GPU backend remains selected. */
export function requestedStageBackend(): StageBackend { return stageBackend; }

/** The backend serving the stage, or selected to serve it when initialization failed. */
export function activeStageBackend(): StageBackend { return activeBackend; }

export function setComparisonStageBackend(backend: StageBackend): void {
  stageBackend = backend;
  activeBackend = backend;
  legacyCanvasTestOverride = false;
  if (backend === "dom" || backend === "canvas") mirrorSettings.runtimeStage = backend;
}

/** TEST ONLY: override the requested backend (never called in production). */
export function __setStageBackendForTest(backend: StageBackend): void {
  stageBackend = backend;
  legacyCanvasTestOverride = backend === "canvas";
  activeBackend = backend;
}

function noteGeoclipBackend(backend: StageBackend): void {
  if (typeof console === "undefined") return;
  if (!isGeoclipPlaybackEnabled()) { console.info("[mirror] geoclips: disabled"); return; }
  console.info(
    backend === "canvas"
      ? "[mirror] geoclips: active — the canvas overlay path (mirror/canvas/overlay.ts); each geoclip mounts in its node's overlay div, above the stage canvas"
      : "[mirror] geoclips: active — the DOM renderer path (mirror/mirrorRenderer.ts)"
  );
}

/** A null result means construction failed; MirrorView must leave the scene blank and input disabled. */
export function createMirrorRendererFor(
  stage: HTMLElement,
  defs: SVGElement,
  canvasHost?: HTMLElement | null
): MirrorRenderer | null {
  const backend = stageBackend;
  activeBackend = backend === "canvas" && !legacyCanvasTestOverride ? "rust" : backend;
  setRendererRuntimeStatus({ requested: { ...rendererComparisonConfig, backend },
    actualBackend: null, actualConfig: null, phase: "initializing", reason: null, pixiText: null });

  if (backend === "dom") {
    noteGeoclipBackend("dom");
    setRendererRuntimeStatus({ actualBackend: "dom", phase: "active",
      actualConfig: normalizedComparisonConfig({ ...rendererComparisonConfig, backend: "dom" }) });
    return createMirrorRenderer(stage, defs);
  }

  const actual = activeBackend;
  let live = true;
  let failed = false;
  const fail = (reason: string): void => {
    if (!live || failed) return;
    failed = true;
    console.info(`[mirror] ${actual} stage failed (${reason})`);
    setRendererRuntimeStatus({ actualBackend: actual, actualConfig: null, phase: "failed", reason });
  };
  const status = (phase: "initializing" | "ready" | "failed", reason?: string): void => {
    if (!live || failed) return;
    if (phase === "failed") { fail(reason ?? "renderer initialization failed"); return; }
    setRendererRuntimeStatus({ actualBackend: actual, phase: phase === "ready" ? "active" : phase,
      actualConfig: phase === "ready" ? normalizedComparisonConfig({ ...rendererComparisonConfig, backend: actual }) : null,
      reason: reason ?? null });
  };
  try {
    const renderer = import.meta.env.MODE === "test" && legacyCanvasTestOverride && backend === "canvas"
      ? createCanvasMirrorRenderer(stage, defs, canvasHost)
      : actual === "pixi"
        ? createPixiMirrorRenderer(stage, defs, canvasHost, status)
        : createRustMirrorRenderer(stage, defs, canvasHost, status);
    if (legacyCanvasTestOverride && backend === "canvas") noteGeoclipBackend("canvas");
    const canvas = (canvasHost ?? stage).querySelector<HTMLCanvasElement>(`canvas.mirror-${actual}-stage`);
    const contextLost = (event: Event): void => { event.preventDefault(); fail("WebGL context lost"); };
    canvas?.addEventListener("webglcontextlost", contextLost);
    console.info(`[mirror] stage backend: ${actual}${backend === "canvas" ? " canvas" : ""}`);
    return { ...renderer, dispose() {
      live = false;
      canvas?.removeEventListener("webglcontextlost", contextLost);
      renderer.dispose();
    } };
  } catch (error) {
    (canvasHost ?? stage).querySelector(`canvas.mirror-${actual}-stage`)?.remove();
    fail(error instanceof Error ? error.message : String(error));
    live = false;
    return null;
  }
}
