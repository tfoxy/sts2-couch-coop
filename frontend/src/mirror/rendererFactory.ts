// WHICH BACKEND DRAWS THE STAGE.
//
// The mirror has two renderers behind one interface (MirrorRenderer): the shipping DOM backend, which builds an
// element per scene node, and the single-canvas backend, which answers the same reconcile with one <canvas> and a
// draw list. This module is the ONE place that picks between them — MirrorView calls this instead of
// `createMirrorRenderer` directly, and nothing else in the app knows there is a choice.
//
// THE LEVER. `?stage=dom` (the default) or `?stage=canvas`. Read ONCE at module load like every other lever in this codebase — the choice of
// renderer is a page-load decision by construction (a live swap means re-mounting the whole stage), and a
// `__setStageBackendForTest` seam lets vitest flip it without touching `window.location`.
//
// THE HARD FALLBACK. `?stage=canvas` is a REQUEST, not a promise. If the canvas backend cannot be built at all —
// today that means WebGL2 context creation failing, which is a real outcome on old/blocklisted mobile GPUs and
// inside a headless CI browser — the viewer gets the DOM backend rather than a blank screen, plus one console line
// naming the reason (the phone's console is the only diagnostic channel a live-QA session has). Nothing else in the
// app is told: both objects satisfy the same interface, so the fallback is invisible above this line.

import { createCanvasMirrorRenderer } from "@/mirror/canvas/canvasRenderer";
import { createMirrorRenderer } from "@/mirror/mirrorRenderer";
import type { MirrorRenderer } from "@/mirror/renderer/contracts";
import { isGeoclipPlaybackEnabled } from "@/mirror/spineAttributes";

export type StageBackend = "dom" | "canvas";

// `?stage=dom|canvas`. Anything else (absent, misspelled, `?stage=svg`)
// resolves to "dom": an unrecognised value must never cost a viewer their game screen.
function readStageBackend(): StageBackend {
  if (typeof window === "undefined") {
    return "dom";
  }
  const params = new URLSearchParams(window.location.search);
  const stage = params.get("stage");
  if (stage === "canvas") {
    return "canvas";
  }
  if (stage === "dom") {
    return "dom";
  }
  return "dom";
}

let stageBackend: StageBackend = readStageBackend();
let activeBackend: StageBackend = stageBackend;

/** The backend this page asked for (before any fallback) — for diagnostics and the bench harness. */
export function requestedStageBackend(): StageBackend {
  return stageBackend;
}

/** The renderer currently serving the stage after any whole-stage fallback. */
export function activeStageBackend(): StageBackend {
  return activeBackend;
}

/** TEST ONLY: override the requested backend (never called in production). */
export function __setStageBackendForTest(backend: StageBackend): void {
  stageBackend = backend;
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
 * Build the mirror renderer this page asked for. `dom` returns exactly what MirrorView used to construct inline;
 * `canvas` returns the single-canvas backend, falling back to `dom` (with a reason on the console) if it cannot be
 * built. The first two parameters ARE `createMirrorRenderer`'s, so the call site reads the same.
 *
 * `canvasHost` is the CANVAS BACKEND'S ONLY EXTRA: the untransformed element the stage canvas is laid out in
 * (MirrorView's `.mirror-canvas-host`, a sibling of the scaled stage — see canvasRenderer's SIZING LAW for the
 * compositor reason it exists). The DOM backend has no canvas and is not told about it; omitted, the canvas
 * backend puts its canvas in the scaled stage exactly as it did before the split.
 */
export function createMirrorRendererFor(
  stage: HTMLElement,
  defs: SVGElement,
  canvasHost?: HTMLElement | null
): MirrorRenderer {
  if (stageBackend !== "canvas") {
    activeBackend = "dom";
    noteGeoclipBackend("dom");
    return createMirrorRenderer(stage, defs);
  }
  try {
    const renderer = createCanvasMirrorRenderer(stage, defs, canvasHost);
    activeBackend = "canvas";
    if (typeof console !== "undefined") {
      console.info("[mirror] stage backend: canvas (?stage=canvas)");
    }
    noteGeoclipBackend("canvas");
    return renderer;
  } catch (error) {
    // Any construction failure falls back, not just a missing context: whatever went wrong, a DOM stage is a
    // playable game and a half-built canvas stage is not.
    if (typeof console !== "undefined") {
      console.info(
        `[mirror] stage backend: canvas requested but unavailable (${(error as Error)?.message ?? String(error)}) — using dom`
      );
    }
    // …and the geoclip line names the path the viewer ACTUALLY got, not the one they asked for: a fallback lands
    // on the DOM renderer, so this is the DOM path however the url was spelled.
    activeBackend = "dom";
    noteGeoclipBackend("dom");
    return createMirrorRenderer(stage, defs);
  }
}
