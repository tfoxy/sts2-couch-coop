import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import { drawRustTextRuns } from "../rustTextRaster";
import { offsetRustTextCarrierTransform } from "@/mirror/renderer/semanticTextLayout";
import type { RustTextMethod, BitmapTextCarrier, RustTextResource } from "./RustTextMethod";
import type { TextInkRaster, CorpusRow } from "./types";

/**
 * The producer's measured baseline for this run (`rustTextPreparation.ts`'s `PreparedTextRun.msdf.baselinePx`,
 * the SAME field MSDF reads — see `msdf.ts`'s `MsdfRunRecord`). It already bakes in `strokeHalf` and the
 * line's half-leading, so a record carrying it is placed by it directly rather than re-derived here.
 */
interface BitmapRunRecord extends PixiTextRecord {
  msdf?: { baselinePx: number };
}

export interface BitmapEnvironment {
  canvas: HTMLCanvasElement;
  textResourceKey(record: PixiTextRecord): string;
  readPixels(source: CanvasImageSource, key: string, width: number, height: number,
    raster?: TextInkRaster, zeroCopy?: boolean, emitResourceEvent?: boolean): RustTextResource;
  textInkDiagnostics: boolean;
  textInkCurrentSubmission: { revision: number; sceneRevision: number | null; cacheMisses: number; rasters: TextInkRaster[] } | null;
  textInkDiagnosticEvents: TextInkRaster[];
  textInkDiagnosticEventLimit: number;
  setDiagnosticOverflow(): void;
  setLastMissSubmission(submission: { revision: number; sceneRevision: number | null; cacheMisses: number; rasters: TextInkRaster[] }): void;
  onRasterization(): void;
}

/** Current Bitmap path, with its raster loop unchanged and all former closure dependencies injected. */
export interface BitmapTextMethod extends RustTextMethod<BitmapTextCarrier> {
  hasCached(key: string): boolean;
  cachedResource(key: string): RustTextResource | undefined;
  /** rustTextEvict: every key currently resident in the cache, for the executor's eviction decision. */
  cachedKeys(): readonly string[];
  /** rustTextEvict: drop these keys from the cache and their padding. A later `prepare` for the same key
   *  re-rasterises from scratch, exactly like a first-ever request for it. */
  evict(keys: Iterable<string>): void;
}

export function createBitmapTextMethod(env: BitmapEnvironment): BitmapTextMethod {
  const cache = new Map<string, RustTextResource>();
  const pads = new Map<string, number>();
  let rasters = 0;
  let measureContext: CanvasRenderingContext2D | null | undefined;
  function rasterTextWithMode(record: BitmapRunRecord, cache: Map<string, RustTextResource>, pads: Map<string, number>,
    inkReadFrequently: boolean, useZeroCopy: boolean, replayEvents?: TextInkRaster[], corpusRow?: CorpusRow):
    { resource: { key: string; width: number; height: number }; pixels: Uint8Array; width: number; height: number; transform: readonly number[]; alpha?: number } | null {
    const key = env.textResourceKey(record);
    let image = cache.get(key);
    let pad = pads.get(key) ?? 0;
    if (!image) {
      let raster: TextInkRaster | null = null;
      if ((env.textInkDiagnostics && env.textInkCurrentSubmission && !replayEvents) || replayEvents) {
        if (!replayEvents && env.textInkDiagnosticEvents.length >= env.textInkDiagnosticEventLimit) {
          env.setDiagnosticOverflow();
          throw new Error(`Rust text ink diagnostic event limit exceeded (${env.textInkDiagnosticEventLimit})`);
        }
        if (!replayEvents) {
          env.textInkCurrentSubmission!.cacheMisses++;
          env.setLastMissSubmission(env.textInkCurrentSubmission!);
        }
        raster = { recordKey: record.key, resourceKey: key, submissionRevision: replayEvents ? 0 : env.textInkCurrentSubmission!.revision,
          sceneRevision: null, startMs: performance.now(), endMs: null,
          width: 0, height: 0, rgbaBytes: 0, readbackMs: 0, failed: true,
          requestedInkWillReadFrequently: inkReadFrequently, inkContextAttributes: null,
          requestedScratchWillReadFrequently: true, scratchContextAttributes: null,
          inkDrawMs: null, scratchConversionMs: null, scratchDrawMs: null,
          getImageDataMs: null, pixelViewMs: null, outcome: "pending" };
        if (replayEvents) replayEvents.push(raster);
        else { env.textInkCurrentSubmission!.rasters.push(raster); env.textInkDiagnosticEvents.push(raster); }
      }
      try {
        const style = record.style as PixiTextRecord["style"] & Record<string, unknown>;
        // The accepted producer emits one positioned record per line/run. Do not silently flatten Pixi-only
        // typography that this Canvas2D carrier cannot reproduce.
        if ((style.align ?? "left") !== "left" || style.wordWrap === true ||
            Number(style.leading ?? 0) !== 0 || style.breakWords === true) {
          if (raster) raster.outcome = "refused-style";
          return null;
        }
        const size = Number(style.fontSize ?? 16);
        const family = String(style.fontFamily ?? "sans-serif");
        const font = [style.fontStyle, style.fontVariant, style.fontWeight, `${size}px`, family].filter(Boolean).join(" ");
        // One CPU-backed measuring context per method: a fresh canvas per miss paid a context creation for measureText.
        measureContext ??= env.canvas.ownerDocument.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const measure = measureContext;
        if (!measure) { if (raster) raster.outcome = "refused-measure-context"; return null; }
        measure.font = font;
        const letterSpacing = Number(style.letterSpacing ?? 0);
        if (!Number.isFinite(letterSpacing)) return null;
        if ("letterSpacing" in measure) measure.letterSpacing = `${letterSpacing}px`;
        const runs = record.runs?.length ? record.runs : [{ text: record.text }];
        const text = runs.map((run) => run.text).join("");
        const metrics = measure.measureText(text);
        if (corpusRow) corpusRow.measurements = { width: metrics.width,
          actualBoundingBoxAscent: metrics.actualBoundingBoxAscent,
          actualBoundingBoxDescent: metrics.actualBoundingBoxDescent,
          fontBoundingBoxAscent: metrics.fontBoundingBoxAscent,
          fontBoundingBoxDescent: metrics.fontBoundingBoxDescent, runAdvances: [] };
        const stroke = style.stroke && typeof style.stroke === "object" ? style.stroke as { color?: string; width?: number } : null;
        const shadow = style.dropShadow && typeof style.dropShadow === "object" ? style.dropShadow as { color?: string; alpha?: number; angle?: number; distance?: number; blur?: number } : null;
        // Matches `rustTextPreparation.ts`'s `spec.outlinePx / 2`: the record's `style.stroke.width` IS that
        // same `outlinePx` (see `buildPreparedText`'s `stroke: { ..., width: spec.outlinePx }`), so this is the
        // identical strokeHalf the producer already baked into `record.msdf.baselinePx` and `boxX`'s
        // `nativeTextOriginCorrection`. Canvas2D centers a stroke on the glyph's path, so without this inset the
        // outline's near half draws outside the ink the DOM/game place, shifting the whole glyph up-left.
        const strokeWidth = Number(stroke?.width ?? 0);
        const strokeHalf = strokeWidth / 2;
        const strokePad = Math.ceil(strokeWidth + 1);
        const shadowBlur = Math.ceil(shadow?.blur ?? 0);
        const shadowOffsetX = Math.ceil(Math.cos(shadow?.angle ?? 0) * (shadow?.distance ?? 0));
        const shadowOffsetY = Math.ceil(Math.sin(shadow?.angle ?? 0) * (shadow?.distance ?? 0));
        pad = Math.max(strokePad, shadowBlur + Math.max(Math.abs(shadowOffsetX), Math.abs(shadowOffsetY))) + 2;
        // Ink metrics (ACTUAL glyph extent, used only to size the canvas tightly around this text's own shape).
        const inkAscent = Math.max(metrics.actualBoundingBoxAscent, metrics.fontBoundingBoxAscent || size);
        const inkDescent = Math.max(metrics.actualBoundingBoxDescent, metrics.fontBoundingBoxDescent || size * 0.25);
        // `record.msdf.baselinePx` is the producer's authority on where this run's baseline sits in its line box
        // (`rustTextPreparation.ts:231-237`'s `rasterBaseline`, in Pixi's `CanvasTextGenerator` convention): the
        // pen starts at `strokeHalf` and the baseline is `strokeHalf + fontAscent + halfLeading` below it. The
        // fallback (no `msdf`, e.g. a record built outside full text preparation) recomputes the same formula
        // from THIS run's own face metrics — `fontBoundingBoxAscent || size`, the SAME ascent preparation's
        // `measureLineMetrics` falls back to.
        const fontAscent = metrics.fontBoundingBoxAscent || size;
        const fontDescent = metrics.fontBoundingBoxDescent || size * 0.25;
        const lineHeight = Number(style.lineHeight ?? 0);
        const fallbackBaseline = strokeHalf + fontAscent + Math.max(0, (lineHeight - fontAscent - fontDescent) / 2);
        const recordBaseline = record.msdf?.baselinePx;
        const baseline = Number.isFinite(recordBaseline) ? recordBaseline! : fallbackBaseline;
        const width = Math.max(1, Math.ceil(metrics.width + strokeWidth + pad * 2));
        // Tall glyphs (an ascender well above the line box) or a wide stroke can reach above `baseline` itself;
        // `inkAscent + strokeHalf` is the ink's own top edge, so the canvas must clear whichever is taller.
        const height = Math.max(1, Math.ceil(Math.max(baseline, inkAscent + strokeHalf) + inkDescent + strokeHalf + pad * 2));
        if (raster) { raster.width = width; raster.height = height; raster.rgbaBytes = width * height * 4; }
        const ink = env.canvas.ownerDocument.createElement("canvas"); ink.width = width; ink.height = height;
        const context = inkReadFrequently
          ? ink.getContext("2d", { willReadFrequently: true }) : ink.getContext("2d");
        if (!context) { if (raster) raster.outcome = "refused-ink-context"; return null; }
        if (raster) raster.inkContextAttributes = context.getContextAttributes?.() ?? null;
        context.font = font; context.textBaseline = "alphabetic"; context.textAlign = "left";
        if (letterSpacing && "letterSpacing" in context) context.letterSpacing = `${letterSpacing}px`;
        const x = pad + strokeHalf, y = pad + baseline;
        const inkDrawAt = raster ? performance.now() : 0;
        const drawn = drawRustTextRuns(context, runs, {
          fill: typeof style.fill === "string" ? style.fill : "#ffffff",
          stroke: stroke && Number(stroke.width) > 0
            ? { color: String(stroke.color ?? "#000000"), width: Number(stroke.width) }
            : null,
          shadow: shadow ? { color: String(shadow.color ?? "#000000"), alpha: Number(shadow.alpha ?? 1),
            blur: Number(shadow.blur ?? 0), offsetX: shadowOffsetX, offsetY: shadowOffsetY } : null,
        }, x, y, (value) => {
          const advance = measure.measureText(value).width;
          corpusRow?.measurements?.runAdvances.push(advance);
          return advance;
        });
        if (raster) raster.inkDrawMs = performance.now() - inkDrawAt;
        if (!drawn) { if (raster) raster.outcome = "refused-draw"; return null; }
        try { image = env.readPixels(ink, key, width, height, raster ?? undefined, useZeroCopy, !replayEvents); }
        catch (error) { if (raster) raster.outcome = "failed-readback"; throw error; }
        const tint = record.tint ?? 0xffffff;
        if (tint !== 0xffffff) {
          for (let i = 0; i < image.pixels.length; i += 4) {
            image.pixels[i] = Math.round(image.pixels[i] * ((tint >> 16 & 255) / 255));
            image.pixels[i + 1] = Math.round(image.pixels[i + 1] * ((tint >> 8 & 255) / 255));
            image.pixels[i + 2] = Math.round(image.pixels[i + 2] * ((tint & 255) / 255));
          }
        }
        cache.set(key, image); if (!replayEvents) (env.onRasterization(), rasters++);
        if (raster) { raster.failed = false; raster.outcome = "ready"; }
        pads.set(key, pad);
      } finally { if (raster) raster.endMs = performance.now(); }
    }
    return { resource: { key: image.key, width: image.width, height: image.height }, pixels: image.pixels,
      width: image.width, height: image.height,
      transform: offsetRustTextCarrierTransform(record.localTransform ?? record.transform, pad, pad), alpha: record.alpha };
  }

  return {
    id: "bitmap",
    prepare(record, options) { return rasterTextWithMode(record, options?.freshCache ? new Map() : cache, options?.freshCache ? new Map() : pads, options?.inkReadFrequently ?? false,
      options?.zeroCopyPixels ?? false, options?.replayEvents, options?.corpusRow); },
    resourceKeys: (carrier) => [carrier.resource.key],
    uploads(carrier, maxBytes) { return carrier.pixels.byteLength <= maxBytes ? [{ ...carrier.resource, pixels: carrier.pixels }] : []; },
    hasCached: (key) => cache.has(key),
    cachedResource: (key) => cache.get(key),
    cachedKeys: () => [...cache.keys()],
    evict(keys) { for (const key of keys) { cache.delete(key); pads.delete(key); } },
    stats: () => ({ rasterizations: rasters, resources: cache.size }),
    dispose() { cache.clear(); pads.clear(); measureContext = undefined; }
  };
}
