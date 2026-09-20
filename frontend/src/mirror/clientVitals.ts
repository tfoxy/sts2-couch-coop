// WHAT THIS BROWSER WAS HOLDING WHEN IT DIED.
//
// A phone whose web view is killed by the OS leaves NOTHING behind: no `unload`, no `error`, no close frame, no
// beacon. The process is gone between two instructions. The host sees only a socket that stopped — which is
// exactly the `browser-transport-lost` report a player sent us from an iPhone that rendered one frame of the
// character-select screen and then vanished 618ms later.
//
// So the only way a kill can ever be diagnosed is if the host ALREADY KNOWS what the page was holding before it
// happened. That is this module: a small, bounded census the client pushes on a slow cadence, which the host
// keeps as the connection's last-known vitals and prints in the report (see `RecordDiagnostic`, whose
// `ArchiveCurrent` is what makes the LAST one survive into the issue).
//
// WHY THESE FIELDS, and not the hundred counters `mirrorWalkStats` already has. Everything here answers one
// question — "how much memory was this page holding, and on which renderer" — and stays true on BOTH stage
// backends. The walk counters are DOM-renderer internals that churn every round; a field in this census is read
// by a human staring at a crash report from a device they do not own, so it has to mean the same thing next
// month. Two of them are the ones a desktop never makes you think about:
//
//   `canvasPx` — total canvas backing-store pixels. WebKit budgets canvas memory per PAGE and kills the content
//     process when it is exceeded, and each canvas costs w*h*4 bytes whatever is drawn on it. A desktop with
//     gigabytes never notices; a phone does. This is the single number most likely to name the fault.
//   `decodedBytes` — the atlas bitmaps the page OWNS right now (atlasBaker's residency). This is the field the
//     iPhone round turned on, and it is worth saying what it used to be: the prefetch chain's cumulative
//     price list, which could only ever describe the twelve pages that chain walks and could never move after
//     it finished. It now reads live residency, so it falls when the budget evicts and rises when a page is
//     promoted — a number that answers "what was this page holding" rather than "what did it once fetch".
//     Read it against `atlasCap`, which says what budget was in force.
//
// NOTHING IDENTIFYING. No URLs, no query values, no player name, no user agent, no stack. Numbers and three small
// closed enums. The host re-renders the line from parsed values rather than echoing this one (a receipt is
// client-controlled text), so adding a field here also means teaching the host to read it.

import { FX_RESIDENT_BYTES_DEFAULT } from "@/mirror/canvas/fxSurfaces";
import { TEXTURE_RESIDENT_BYTES_DEFAULT } from "@/mirror/canvas/textureBridge";
import { atlasResidencyStats, atlasResidentCapBytes } from "@/mirror/atlasBaker";
import { mirrorSettings, type EffectMode } from "@/mirror/mirrorSettings";
import { activeStageBackend, requestedStageBackend, type StageBackend } from "@/mirror/rendererFactory";
import { displaySpaceLayout, type StageFitMode } from "@/mirror/stageFit";

/** The census, as sent. Every value is a finite number or one of three closed enums. */
export interface ClientVitals {
  /** The backend this page ASKED for (`?stage=`), and the one actually serving after any hard fallback. */
  stageRequested: StageBackend;
  stageActive: StageBackend;
  /** The layout arm actually in force, after the canvas backend's display-layout refusal. */
  stageFit: StageFitMode;
  /** Device pixel ratio, rounded to 2dp — a 3x phone pays 9x the backing store of a 1x desktop for the same CSS box. */
  dpr: number;
  /** Viewport in CSS px. */
  vw: number;
  vh: number;
  /** Elements under the mirror frame — the DOM backend's per-node cost, and ~0 on the canvas backend. */
  els: number;
  /** Live `<canvas>` elements anywhere in the document, and their total backing-store pixels. */
  canvases: number;
  canvasPx: number;
  /** Atlas pixels the page OWNS at this instant (`ImageBitmap`s), and how many pages they are. */
  decodedBytes: number;
  decodedPages: number;
  /**
   * The atlas residency cap in force, in bytes (0 = no budget). Unlike the two below it this is non-zero on
   * BOTH backends, so it is what tells a reader of a pasted report whether the build in their hands bounds the
   * population that `decodedBytes` measures — the distinction the iPhone report could not make.
   */
  atlasCap: number;
  /**
   * The canvas backend's residency CAPS, in force only while it is the active backend — 0 on the DOM backend.
   * They bound the canvas texture bridge's own page population, which is a different one from `decodedBytes`.
   */
  texBytes: number;
  fxBytes: number;
  /** The two effect families' modes, so a report says whether the viewer was already running reduced. */
  shaderMode: EffectMode;
  particleMode: EffectMode;
  /**
   * `performance.memory.usedJSHeapSize` where it exists. Chromium-only and absent on WebKit — which is the
   * platform we most want it on — so it is reported as 0 rather than omitted, and a 0 means "not offered by this
   * browser", never "no heap". Present because the Android control leg CAN read it, and that leg is free.
   */
  jsHeapBytes: number;
}

/** Everything the census reads from outside itself, injectable so a test never touches a real document. */
export interface ClientVitalsSources {
  requestedStage: () => StageBackend;
  activeStage: () => StageBackend;
  /** The effective layout arm, not the URL's requested arm. */
  stageFit: () => StageFitMode;
  /** The canvas backend's residency budgets, or null when it is not the active backend. */
  canvasResidency: () => { textureBytes: number; fxBytes: number } | null;
  /** Owned atlas pixels right now, and the cap bounding them — both backends. */
  atlasResidency: () => { bytes: number; pages: number; cap: number };
  effectModes: () => { shaderMode: EffectMode; particleMode: EffectMode };
  doc: () => Document | null;
  view: () => Window | null;
}

/** Finite, non-negative, integral — the shape every COUNT must satisfy before it is worth sending. */
function count(value: unknown): number {
  return Math.round(ratio(value));
}

/**
 * The same validation without the rounding, for the one genuinely fractional field. Kept separate rather than
 * folded into `count` because rounding a device pixel ratio silently destroys it: a 3.4876 phone (a real measured
 * value — see the raster-scale note in qa-recipes) reads as 3, and the difference is 20% of the backing store on
 * every surface on the page.
 */
function ratio(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The census. Never throws: a browser that refuses any one reading (a detached document, a getter that throws
 * under a torn-down page) must still produce the rest, because a partial census beats none at exactly the moment
 * this exists for — the page is already in trouble.
 */
export function collectClientVitals(sources: ClientVitalsSources): ClientVitals {
  const doc = safely(sources.doc, null);
  const view = safely(sources.view, null);
  const atlas = safely(sources.atlasResidency, { bytes: 0, pages: 0, cap: 0 });
  const residency = safely(sources.canvasResidency, null);
  const effects = safely(sources.effectModes, { shaderMode: "static" as EffectMode, particleMode: "static" as EffectMode });

  let canvases = 0;
  let canvasPx = 0;
  if (doc) {
    // getElementsByTagName is a live HTMLCollection — no array allocation, which matters on a page we already
    // suspect of being short of memory.
    const all = safely(() => doc.getElementsByTagName("canvas"), null);
    canvases = all ? all.length : 0;
    for (let i = 0; i < canvases; i += 1) {
      const canvas = all?.item(i);
      if (canvas) canvasPx += count(canvas.width) * count(canvas.height);
    }
  }

  return {
    stageRequested: safely(sources.requestedStage, "dom"),
    stageActive: safely(sources.activeStage, "dom"),
    stageFit: safely(sources.stageFit, "design"),
    // 2dp because the interesting distinction is 2 vs 3 vs 3.5, and a 17-digit float in a crash report is noise.
    dpr: Math.round(ratio(view?.devicePixelRatio) * 100) / 100,
    vw: count(view?.innerWidth),
    vh: count(view?.innerHeight),
    els: doc ? count(safely(() => doc.querySelectorAll(".mirror-frame *").length, 0)) : 0,
    canvases,
    canvasPx,
    decodedBytes: count(atlas.bytes),
    decodedPages: count(atlas.pages),
    atlasCap: count(atlas.cap),
    texBytes: count(residency?.textureBytes),
    fxBytes: count(residency?.fxBytes),
    shaderMode: effects.shaderMode,
    particleMode: effects.particleMode,
    jsHeapBytes: count((safely(() => (view as unknown as { performance?: { memory?: { usedJSHeapSize?: number } } })?.performance?.memory?.usedJSHeapSize, 0)))
  };
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    const value = read();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** The production sources. Split out so `collectClientVitals` itself stays pure for vitest. */
export function defaultClientVitalsSources(): ClientVitalsSources {
  return {
    requestedStage: requestedStageBackend,
    activeStage: activeStageBackend,
    // This must report the granted arm: `?stageFit=display&stage=canvas` still lays out in design space.
    stageFit: () => (displaySpaceLayout() ? "display" : "design"),
    // The caps are module constants rather than a live reading on purpose: the live figures sit behind the canvas
    // renderer's owner-keyed diagnostics ports, and a census that reached in there would break every time that
    // internal moved. What a crash report needs from this pair is WHICH BUDGET APPLIED, and that is a constant.
    canvasResidency: () =>
      activeStageBackend() === "canvas"
        ? { textureBytes: TEXTURE_RESIDENT_BYTES_DEFAULT, fxBytes: FX_RESIDENT_BYTES_DEFAULT }
        : null,
    // …the atlas figures, by contrast, are a LIVE reading rather than a constant: the whole question this census
    // was built to answer is how much the page was holding at the moment it died, and a cap alone cannot say.
    atlasResidency: () => ({
      bytes: atlasResidencyStats.residentBytes,
      pages: atlasResidencyStats.residentPages,
      cap: atlasResidentCapBytes()
    }),
    effectModes: () => ({ shaderMode: mirrorSettings.shaderMode, particleMode: mirrorSettings.particleMode }),
    doc: () => (typeof document === "undefined" ? null : document),
    view: () => (typeof window === "undefined" ? null : window)
  };
}
