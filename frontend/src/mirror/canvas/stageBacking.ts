/**
 * THE STAGE'S BACKING-STORE SIZING LAW — extracted from `canvasRenderer.resize()` so it can be pinned by
 * arithmetic instead of by a live browser, which is the only place the numbers below can be checked at all.
 *
 * WHAT THIS DECIDES, AND WHY IT IS WORTH A FILE. The stage is ONE <canvas> whose backing store is uploaded and
 * then composited to the screen every frame. If the backing store and the device-pixel box the compositor draws
 * it into are the same size, that composite is a 1:1 blit; if they differ AT ALL — by one pixel on a 1920-wide
 * surface is enough — it is a resample of the whole surface, every frame. On a GPU that is free. On a SOFTWARE
 * compositor it is not: a Firefox profile of this stage (Sep-03, software WebRender, no GPU process) spent
 * **7.2 ms/frame** in SWGL's scaled-bilinear paths — `linear_blit` + `linear_row_blit` 3.57 ms and
 * `blendTextureLinearFallback` 3.64 ms — because SWGL only takes `blendTextureNearestFast` when the
 * source→destination factor is exactly 1. There is no "close enough" arm. The condition is binary, so the law
 * has to be exact rather than approximately right.
 *
 * WHAT ALREADY FIXED MOST OF IT. That profile predates `a21db1a` ("Take the stage canvas out of the scaled
 * subtree"), where the canvas was laid out at the DESIGN box inside `transform: scale(fit)` — so the texture was
 * magnified into a render surface at layer space and minified back out of it, two resamples at non-unit factors,
 * unconditionally. Taking the canvas out of the scaled subtree made the composite 1:1 in most layouts as a side
 * effect of fixing the blur. This file closes the REMAINDER (see {@link stageBackingSize}).
 *
 * THIS IS A ROUNDING CHANGE, NOT A DOWNSCALE. The backing store moves by at most one device pixel and never
 * shrinks below what the old law asked for by more than that. `stagePixelRatio()` stays the raw device ratio —
 * see `render/quality.ts`, "a tier may scale an EFFECT's offscreen target … but it may NEVER scale the stage".
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE STRUCTURAL FACT WORTH KNOWING ABOUT THIS FILE: **the fitted axis can never disagree. Only the
 * letterboxed one can.**
 *
 * The stage is contain-fitted, so exactly one axis is bound and the other is letterboxed. On the BOUND axis the
 * host's dimension equals the frame's dimension exactly, and `.mirror-canvas-host`'s `margin: auto` therefore
 * centres it with an offset of EXACTLY ZERO — at which point `round(right × dpr) − round(left × dpr)` collapses
 * to `round(width × dpr)` and the two laws are algebraically the same expression. Measured over a fractional
 * frame-rect sweep at dpr 1.25: **0 disagreements in 312,828 width-bound cases and 0 in 177,172 height-bound
 * cases.** The letterboxed axis, whose offset is a sub-pixel fraction nobody controls, disagrees ~21% of the
 * time with the widescreen stretch on and ~25% with it off.
 *
 * THE OPEN QUESTION, so nobody re-derives it: `round(right × dpr) − round(left × dpr)` is a MODEL of the box
 * WebRender snaps an axis-aligned item into. Reading our own `backingStore` back — which is all a DOM probe can
 * do — can never test that model, because it only ever returns the number this file just computed. The only
 * instrument that settles it is SWGL time in a compositor profile: if `linear_blit` / `blendTextureLinearFallback`
 * are absent on an arm where the two laws disagree, the model is right. Until someone captures that, this file's
 * benefit is UNPRICED — it is known-harmless and byte-identical wherever the laws agree, which is most places.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 */

/** The host's rendered box, i.e. what `getBoundingClientRect()` answers: CSS px, fractional, viewport-relative. */
export interface StageHostRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface StageBackingInput {
  /** The DESIGN box in design px — `stage.clientWidth/Height`, integers. */
  readonly designW: number;
  readonly designH: number;
  /** The canvas host's rendered box. Under the split layout this IS the fitted box; under legacy it is the
   *  post-transform rect of the scaled stage. Either way it is the box the canvas is composited into. */
  readonly rect: StageHostRect;
  /** `stagePixelRatio()` — the raw device pixel ratio, never a tier's. */
  readonly pixelRatio: number;
}

export interface StageBacking {
  /**
   * DESIGN px to DEVICE px. It is read by the text raster
   * (`rasterScaleFor`) and by `paintSpec`'s `snapTranslation`, so letting the snap move it would re-key every
   * label raster and shift every snapped text translation, turning a compositor-alignment change into a
   * whole-scene repaint diff. The snap adjusts the BACKING STORE by at most one device pixel; the factor the
   * scene is drawn with does not move.
   */
  readonly perDesignPx: number;
  readonly backingW: number;
  readonly backingH: number;
  /** Did compositor-aligned sizing apply? False when the rect was unusable (see the fallback). */
  readonly snapped: boolean;
}

function usableRect(rect: StageHostRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * The law computes the size the compositor is actually going to paint into.
 * WebRender snaps an axis-aligned item's rect CORNERS to device pixels independently, so the painted device
 * width is `round(right × dpr) − round(left × dpr)` — which is NOT the same as `round(width × dpr)` whenever the
 * two edges' fractional parts round in opposite directions. The host is centred by `margin: auto`, so on the
 * LETTERBOXED axis its edge sits on a fractional device pixel and the two formulas disagree ~21% of the time
 * (stretch on) / ~25% (stretch off) at dpr 1.25 — always by exactly 1 px, which is all it takes. On the FITTED
 * axis the offset is exactly zero and they cannot disagree at all; see the header for that decomposition, which
 * is the thing to read before predicting what any particular window will do. Computing the backing store with
 * the compositor's own formula is what makes the blit 1:1.
 *
 * THE FALLBACK. A rect that is zero or non-finite — jsdom, an unlaid-out host, a display:none ancestor — uses
 * the design-box scale rather than clamping a zero-width device box up to 1, which would hand back a 1×1 stage.
 *
 * NO FEEDBACK LOOP IS POSSIBLE HERE. The output is the backing store only; `CanvasStage.setStageSize` assigns
 * `canvas.width/height` and nothing else, and the canvas's CSS box is `100%` of the host. Reading the host's
 * rect and writing the canvas's backing store cannot move the host's rect, so the ResizeObserver that calls this
 * cannot re-trigger itself. (The alternative shape — writing the host's CSS size back from inside the observer
 * callback — is exactly the loop this avoids.)
 */
export function stageBackingSize(input: StageBackingInput): StageBacking {
  const { designW, designH, rect, pixelRatio } = input;
  // `stageScale()`: the rendered width over the DESIGN width. Falls back to 1 exactly as it always has.
  const stageScale = rect.width > 0 && designW > 0 ? rect.width / designW : 1;
  const perDesignPx = stageScale * pixelRatio;

  if (!usableRect(rect)) {
    return {
      perDesignPx,
      backingW: Math.max(1, Math.round(designW * perDesignPx)),
      backingH: Math.max(1, Math.round(designH * perDesignPx)),
      snapped: false
    };
  }

  const backingW = Math.round((rect.left + rect.width) * pixelRatio) - Math.round(rect.left * pixelRatio);
  const backingH = Math.round((rect.top + rect.height) * pixelRatio) - Math.round(rect.top * pixelRatio);
  return { perDesignPx, backingW: Math.max(1, backingW), backingH: Math.max(1, backingH), snapped: true };
}

/**
 * The device-pixel box the compositor will paint the host into — the ORACLE the tests assert against, and the
 * definition {@link stageBackingSize} is trying to equal. Exported so a test states the property
 * ("the backing store equals the painted box") rather than restating the implementation.
 */
export function paintedDeviceBox(rect: StageHostRect, pixelRatio: number): { w: number; h: number } {
  return {
    w: Math.round((rect.left + rect.width) * pixelRatio) - Math.round(rect.left * pixelRatio),
    h: Math.round((rect.top + rect.height) * pixelRatio) - Math.round(rect.top * pixelRatio)
  };
}
