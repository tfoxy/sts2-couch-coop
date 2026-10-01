// Public stage selection: DOM is the fresh-viewer default; canvas means Rust WebGL.
// A failed Rust request remounts only MirrorView as DOM, preserving the seat and its connection.
// The legacy canvas constructor below is reachable only through the unit-test override.

import { createMirrorRenderer } from "@/mirror/mirrorRenderer";
import { createCanvasMirrorRenderer } from "@/mirror/canvas/canvasRenderer";
import { createPixiMirrorRenderer } from "@/mirror/renderer/pixi/createPixiMirrorRenderer";
import { createRustMirrorRenderer } from "@/mirror/renderer/pixi/createRustMirrorRenderer";
import type { MirrorRenderer } from "@/mirror/renderer/contracts";
import { isGeoclipPlaybackEnabled } from "@/mirror/spineAttributes";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { normalizedComparisonConfig, rendererBackendForPageLoad, rendererComparisonConfig, rendererComparisonViewRevision, setRendererRuntimeStatus } from "@/mirror/rendererComparison";

export type StageBackend = "dom" | "canvas" | "pixi" | "rust";

// Public settings resolve DOM/Canvas. Explicit developer comparison URLs may select Pixi/Rust for this page load.
function readStageBackend(): StageBackend {
  const search = typeof window === "undefined" ? "" : window.location.search;
  return rendererBackendForPageLoad(search, mirrorSettings.runtimeStage);
}

let stageBackend: StageBackend = readStageBackend();
let activeBackend: StageBackend = stageBackend;
let fallbackReason: string | null = null;
let legacyCanvasTestOverride = false;

/** The backend this page asked for (before any fallback) — for diagnostics and the bench harness. */
export function requestedStageBackend(): StageBackend {
  return stageBackend;
}

/** The renderer currently serving the stage after any whole-stage fallback. */
export function activeStageBackend(): StageBackend {
  return activeBackend;
}

/** Prepare the next scene-view mount after an in-document comparison change. */
export function setComparisonStageBackend(backend: StageBackend): void {
  stageBackend = backend;
  legacyCanvasTestOverride = false;
  if (backend === "dom" || backend === "canvas") {
    mirrorSettings.runtimeStage = backend;
    fallbackReason = null;
  }
}

/** TEST ONLY: override the requested backend (never called in production). */
export function __setStageBackendForTest(backend: StageBackend): void {
  stageBackend = backend;
  // Existing legacy-canvas unit tests use this seam. The public URL and settings path always select Rust.
  legacyCanvasTestOverride = backend === "canvas";
  activeBackend = backend;
}

/**
 * Name the active geoclip backend beside the backend line only for an explicit opt-in. Ordinary viewers are
 * raster-only, so claiming an active geometry path there would conceal the product default from diagnostics.
 */
function noteGeoclipBackend(backend: StageBackend): void {
  if (typeof console === "undefined") {
    return;
  }
  if (!isGeoclipPlaybackEnabled()) {
    console.info("[mirror] geoclips: disabled");
    return;
  }
  console.info(
    backend === "canvas"
      ? "[mirror] geoclips: active — the canvas overlay path (mirror/canvas/overlay.ts); each geoclip mounts in its node's overlay div, above the stage canvas"
      : "[mirror] geoclips: active — the DOM renderer path (mirror/mirrorRenderer.ts)"
  );
}

/**
 * Build the current view's renderer. `canvasHost` is the untransformed host for Rust's canvas.
 */
export function createMirrorRendererFor(
  stage: HTMLElement,
  defs: SVGElement,
  canvasHost?: HTMLElement | null
): MirrorRenderer {
  if (import.meta.env.MODE === "test" && legacyCanvasTestOverride && stageBackend === "canvas") {
    try {
      const renderer = createCanvasMirrorRenderer(stage, defs, canvasHost);
      activeBackend = "canvas";
      console.info("[mirror] stage backend: canvas (unit-test seam)");
      noteGeoclipBackend("canvas");
      return renderer;
    } catch (error) {
      activeBackend = "dom";
      console.info(`[mirror] stage backend: canvas requested but unavailable (${error instanceof Error ? error.message : String(error)}) — using dom`);
      noteGeoclipBackend("dom");
      return createMirrorRenderer(stage, defs);
    }
  }
  setRendererRuntimeStatus({ requested: { ...rendererComparisonConfig, backend: stageBackend },
    actualBackend: null, actualConfig: null, phase: "initializing", reason: fallbackReason, pixiText: null });
  if (stageBackend !== "canvas") {
    if (stageBackend === "pixi") {
      activeBackend = "pixi";
      console.info("[mirror] stage backend: pixi (?stage=pixi)");
      try {
        const renderer = createPixiMirrorRenderer(stage, defs, canvasHost, (phase, reason) => {
          setRendererRuntimeStatus({ actualBackend: "pixi", phase: phase === "ready" ? "active" : phase,
            actualConfig: phase === "ready" ? normalizedComparisonConfig({ ...rendererComparisonConfig, backend: "pixi" }) : null,
            reason: reason ?? null });
        });
        return renderer;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.info(`[mirror] stage backend: pixi unavailable (${reason}) — using dom`);
        activeBackend = "dom";
        setRendererRuntimeStatus({ actualBackend: "dom", phase: "active", reason,
          actualConfig: normalizedComparisonConfig({ ...rendererComparisonConfig, backend: "dom" }) });
        return createMirrorRenderer(stage, defs);
      }
    }
    if (stageBackend === "rust") {
      activeBackend = "rust";
      console.info("[mirror] stage backend: Rust/WASM prototype (?rendererCompare=1&stage=rust)");
      try {
        return createRustMirrorRenderer(stage, defs, canvasHost, (phase, reason) => {
          setRendererRuntimeStatus({ actualBackend: "rust", phase: phase === "ready" ? "active" : phase,
            actualConfig: phase === "ready" ? normalizedComparisonConfig({ ...rendererComparisonConfig, backend: "rust" }) : null,
            reason: reason ?? null });
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.info(`[mirror] stage backend: Rust/WASM unavailable (${reason}) — using dom`);
        activeBackend = "dom";
        setRendererRuntimeStatus({ actualBackend: "dom", phase: "active", reason,
          actualConfig: normalizedComparisonConfig({ ...rendererComparisonConfig, backend: "dom" }) });
        return createMirrorRenderer(stage, defs);
      }
    }
    activeBackend = "dom";
    noteGeoclipBackend("dom");
    setRendererRuntimeStatus({ actualBackend: "dom", phase: "active", reason: fallbackReason,
      actualConfig: normalizedComparisonConfig({ ...rendererComparisonConfig, backend: "dom" }) });
    return createMirrorRenderer(stage, defs);
  }
  try {
    let live = true;
    const recover = (reason: string): void => {
      if (!live || stageBackend !== "canvas") return;
      live = false;
      fallbackReason = reason;
      stageBackend = "dom";
      activeBackend = "dom";
      mirrorSettings.runtimeStage = "dom";
      console.info(`[mirror] Rust canvas unavailable (${reason}) — using dom`);
      // Replace only MirrorView; the seat-owning app and its connection stay mounted.
      queueMicrotask(() => { rendererComparisonViewRevision.value++; });
    };
    const renderer = createRustMirrorRenderer(stage, defs, canvasHost, (phase, reason) => {
      if (!live) return;
      setRendererRuntimeStatus({ actualBackend: "rust", phase: phase === "ready" ? "active" : phase,
        actualConfig: phase === "ready" ? normalizedComparisonConfig({ ...rendererComparisonConfig, backend: "rust" }) : null,
        reason: reason ?? null });
      if (phase === "failed") recover(reason ?? "renderer initialization failed");
    });
    activeBackend = "rust";
    const rustCanvas = (canvasHost ?? stage).querySelector<HTMLCanvasElement>("canvas.mirror-rust-stage");
    const contextLost = (event: Event): void => { event.preventDefault(); recover("WebGL context lost"); };
    rustCanvas?.addEventListener("webglcontextlost", contextLost);
    console.info("[mirror] stage backend: Rust canvas (?stage=canvas)");
    return { ...renderer, dispose() {
      live = false;
      rustCanvas?.removeEventListener("webglcontextlost", contextLost);
      renderer.dispose();
    } };
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
    console.info(`[mirror] Rust canvas unavailable (${fallbackReason}) — using dom`);
    stageBackend = "dom";
    activeBackend = "dom";
    mirrorSettings.runtimeStage = "dom";
    setRendererRuntimeStatus({ actualBackend: "dom", phase: "active",
      reason: fallbackReason,
      actualConfig: normalizedComparisonConfig({ ...rendererComparisonConfig, backend: "dom" }) });
    return createMirrorRenderer(stage, defs);
  }
}
