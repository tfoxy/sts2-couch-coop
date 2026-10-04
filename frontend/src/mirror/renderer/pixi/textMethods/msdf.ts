import type { HbGpuFont, HbGpuShapedGlyph } from "@godot-scene-web/hb-gpu";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import { MsdfGenerator, type MsdfGeneration } from "@godot-scene-web/canvas/msdf-generator";
import type { RustGlyphTextCarrier } from "@godot-scene-web/canvas/rust-prototype";

/** The producer's measured run is the placement authority; these values come from its exact role face. */
export interface MsdfRunRecord extends PixiTextRecord {
  msdf?: { url: string; faceKey: string; measuredAdvance: number; baselinePx: number };
}

export interface ShapedMsdfGlyph {
  glyphId: number;
  xPx: number;
  yPx: number;
}

export interface ShapedMsdfRun {
  glyphs: readonly ShapedMsdfGlyph[];
  fontPx: number;
  baselinePx: number;
  range: 8 | 16 | 32;
  outlinePx: number;
  advancePx: number;
}

export interface MsdfPlacement {
  glyphId: number;
  pageKey: string;
  pageSize: number;
  src: readonly [number, number, number, number];
  left: number;
  top: number;
}

function rgba(value: unknown, alpha = 1): readonly [number, number, number, number] | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(source);
  if (!hex) return null;
  const digits = hex[1].length <= 4 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
  return [parseInt(digits.slice(0, 2), 16) / 255,
    parseInt(digits.slice(2, 4), 16) / 255,
    parseInt(digits.slice(4, 6), 16) / 255,
    (digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1) * alpha];
}

// Bitmap tints Canvas2D's sRGB bytes before uploading an sRGB texture. Glyph colors enter the
// shader as floats, so convert the same tinted sRGB values to linear before blending.
function tintedLinear(color: readonly [number, number, number, number], tint: number): readonly [number, number, number, number] {
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return [linear(color[0] * ((tint >> 16 & 255) / 255)),
    linear(color[1] * ((tint >> 8 & 255) / 255)),
    linear(color[2] * ((tint & 255) / 255)), color[3]];
}

/** Compose a carrier only when every visible glyph lives on one resident page. */
export function carrierForMsdfRun(record: MsdfRunRecord, run: ShapedMsdfRun,
  placements: ReadonlyMap<number, MsdfPlacement>): RustGlyphTextCarrier | null {
  const style = record.style as PixiTextRecord["style"] & Record<string, unknown>;
  const fill = rgba(style.fill ?? "#ffffff");
  if (!fill) return null;
  const tint = record.tint ?? 0xffffff;
  const tinted = tintedLinear(fill, tint);
  const stroke = style.stroke && typeof style.stroke === "object"
    ? style.stroke as { color?: string; width?: number } : null;
  const outlineColor = stroke && run.outlinePx > 0 ? rgba(stroke.color ?? "#000000") : null;
  if (stroke && run.outlinePx > 0 && !outlineColor) return null;
  const shadow = style.dropShadow && typeof style.dropShadow === "object"
    ? style.dropShadow as { color?: string; alpha?: number; angle?: number; distance?: number; blur?: number } : null;
  if (shadow && Number(shadow.blur ?? 0) !== 0) return null;
  const shadowColor = shadow ? rgba(shadow.color ?? "#000000", Number(shadow.alpha ?? 1)) : null;
  if (shadow && !shadowColor) return null;
  const glyphs: { src: readonly [number, number, number, number]; dst: readonly [number, number, number, number] }[] = [];
  let pageKey: string | null = null;
  let pageSize = 0;
  for (const glyph of run.glyphs) {
    const placement = placements.get(glyph.glyphId);
    if (!placement) return null;
    if (placement.src[2] === 0 || placement.src[3] === 0) continue; // inkless glyph retained in pen advances
    if (pageKey !== null && pageKey !== placement.pageKey) return null;
    pageKey = placement.pageKey;
    pageSize = placement.pageSize;
    const scale = run.fontPx / 48;
    glyphs.push({ src: placement.src,
      dst: [glyph.xPx + placement.left * scale, glyph.yPx + placement.top * scale,
        placement.src[2] * scale, placement.src[3] * scale] });
  }
  if (!pageKey || !glyphs.length) return null;
  return { kind: "glyphs", method: "msdf", atlas: { key: pageKey, width: pageSize, height: pageSize },
    glyphs, transform: record.localTransform ?? record.transform, fill: tinted,
    ...(outlineColor ? { outline: { color: tintedLinear(outlineColor, tint), width: run.outlinePx / 2 } } : {}),
    ...(shadowColor && shadow ? { shadow: { color: tintedLinear(shadowColor, tint),
      offset: [Math.cos(shadow.angle ?? 0) * (shadow.distance ?? 0),
        Math.sin(shadow.angle ?? 0) * (shadow.distance ?? 0)] as const } } : {}),
    pxRange: run.range, alpha: record.alpha };
}

export type MsdfShapeResult = { ok: true; run: ShapedMsdfRun } |
  { ok: false; reason: "font-source" | "shape" | "coverage" | "metrics" | "range" | "letter-spacing" };

/** Shape on the main thread using the same face bytes the generator receives. */
export function shapeMsdfRun(record: MsdfRunRecord, font: HbGpuFont): MsdfShapeResult {
  const meta = record.msdf;
  if (!meta?.url || !Number.isFinite(meta.measuredAdvance) || !Number.isFinite(meta.baselinePx))
    return { ok: false, reason: "font-source" };
  const style = record.style as PixiTextRecord["style"] & Record<string, unknown>;
  const fontPx = Number(style.fontSize);
  if (!Number.isFinite(fontPx) || fontPx <= 0 || font.upem <= 0)
    return { ok: false, reason: "metrics" };
  if (Number(style.letterSpacing ?? 0) !== 0)
    return { ok: false, reason: "letter-spacing" };
  const outline = style.stroke && typeof style.stroke === "object"
    ? Number((style.stroke as { width?: number }).width ?? 0) : 0;
  if (!Number.isFinite(outline) || outline < 0) return { ok: false, reason: "range" };
  // A full distance range holds half its width on each side of the contour, with one guard texel.
  const requiredHalfRange = outline * 0.5 * 48 / fontPx + 1;
  const range = ([8, 16, 32] as const).find((value) => requiredHalfRange <= value / 2);
  if (!range) return { ok: false, reason: "range" };
  let shaped: HbGpuShapedGlyph[] | null;
  try { shaped = font.shape(record.text); }
  catch { return { ok: false, reason: "shape" }; }
  if (!shaped || !shaped.length) return { ok: false, reason: "shape" };
  if (shaped.some((glyph) => !glyph.glyphId)) return { ok: false, reason: "coverage" };
  const toPx = fontPx / font.upem;
  // Bitmap's pen starts at `strokeHalf` (Canvas2D centers a stroke on the glyph path, so the near half of an
  // outline draws left of x=0) and the producer's `boxX` is pre-shifted left by that same `strokeHalf`
  // (`nativeTextOriginCorrection`) so the two carriers land on the same ink. MSDF glyphs have no Canvas2D
  // stroke to center, but they share that same `boxX`, so they need the matching `+ strokeHalf` to end up in
  // the same place rather than `outline/2` left of it.
  const strokeHalf = outline / 2;
  const glyphs: ShapedMsdfGlyph[] = [];
  let pen = 0;
  for (const glyph of shaped) {
    if (![glyph.xAdvance, glyph.yAdvance, glyph.xOffset, glyph.yOffset].every(Number.isFinite))
      return { ok: false, reason: "shape" };
    glyphs.push({ glyphId: glyph.glyphId,
      xPx: strokeHalf + (pen + glyph.xOffset) * toPx, yPx: meta.baselinePx - glyph.yOffset * toPx });
    pen += glyph.xAdvance;
  }
  const advancePx = pen * toPx;
  const tolerance = Math.min(1, Math.max(0.5, 0.005 * Math.abs(meta.measuredAdvance)));
  if (advancePx < 0 || Math.abs(advancePx - meta.measuredAdvance) > tolerance)
    return { ok: false, reason: "metrics" };
  return { ok: true, run: { glyphs, fontPx, baselinePx: meta.baselinePx,
    range, outlinePx: outline, advancePx } };
}

type Face = { url: string; bytes: Uint8Array; font: HbGpuFont };
type GenerationTask = { face: Face; range: 8 | 16 | 32; glyphIds: number[]; keys: string[] };
export type MsdfGenerationLease = GenerationTask & { result: MsdfGeneration };

export interface MsdfRuntime {
  shape(record: MsdfRunRecord): { run: ShapedMsdfRun; face: Face } |
    { reason: string };
  request(face: Face, range: 8 | 16 | 32, glyphIds: readonly number[]): void;
  takeGeneration(): MsdfGenerationLease | null;
  finishGeneration(lease: MsdfGenerationLease): void;
  failureFor(key: string): string | undefined;
  stats(): { fontBytes: number; hbHeapBytes: number; generatorHeapBytes: number;
    generationMs: number; generationBatches: number; pendingTileBytes: number;
    shapeHits: number; shapeMisses: number };
  dispose(): void;
}

export interface MsdfRuntimeDependencies {
  loadHb?: () => Promise<import("@godot-scene-web/hb-gpu").HbGpu>;
  fetchFont?: (url: string) => Promise<Uint8Array>;
  generator?: Pick<MsdfGenerator, "generate" | "dispose">;
}

export function msdfGlyphKey(url: string, range: number, glyphId: number): string {
  return `${url}\u0000${range}\u0000${glyphId}`;
}

/** One hb-gpu HarfBuzz on the main thread and one event-driven generator worker. */
export function createMsdfRuntime(onInvalidate: () => void, wasmModuleUrl: string,
  dependencies: MsdfRuntimeDependencies = {}): MsdfRuntime {
  const faces = new Map<string, Face>();
  const loading = new Set<string>();
  const failures = new Map<string, string>();
  const shapes = new Map<string, MsdfShapeResult>();
  const queued = new Set<string>();
  const queue: GenerationTask[] = [];
  const generator = dependencies.generator ?? new MsdfGenerator({ wasmModuleUrl });
  let hb: import("@godot-scene-web/hb-gpu").HbGpu | null = null;
  let hbPromise: Promise<import("@godot-scene-web/hb-gpu").HbGpu> | null = null;
  let active: MsdfGenerationLease | null = null;
  let taken = false;
  let generating = false;
  let disposed = false;
  let generationMs = 0;
  let generationBatches = 0;
  let generatorHeapBytes = 0;
  let shapeHits = 0, shapeMisses = 0;

  function initializeHb(): Promise<import("@godot-scene-web/hb-gpu").HbGpu> {
    if (!hbPromise) hbPromise = (async () => {
      if (dependencies.loadHb) {
        const module = await dependencies.loadHb();
        if (disposed) { module.destroy(); throw new Error("MSDF runtime disposed"); }
        hb = module;
        return module;
      }
      const [{ createHbGpu }, { default: createModule }, { default: wasmUrl }] = await Promise.all([
        import("@godot-scene-web/hb-gpu"),
        import("@godot-scene-web/hb-gpu/vendor/hb-gpu.mjs"),
        import("@godot-scene-web/hb-gpu/vendor/hb-gpu.wasm?url"),
      ]);
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`hb-gpu WASM HTTP ${response.status}`);
      const module = await createHbGpu(createModule as Parameters<typeof createHbGpu>[0], await response.arrayBuffer());
      if (disposed) { module.destroy(); throw new Error("MSDF runtime disposed"); }
      hb = module;
      return module;
    })();
    return hbPromise;
  }

  function ensureFace(url: string): void {
    if (faces.has(url) || loading.has(url) || failures.has(url) || disposed) return;
    try {
      const resolved = new URL(url, window.location.href);
      if (resolved.origin !== window.location.origin) throw new Error("font URL is not same-origin");
    } catch (error) {
      failures.set(url, String(error));
      return;
    }
    loading.add(url);
    void (async () => {
      try {
        const module = await initializeHb();
        const bytes = dependencies.fetchFont ? await dependencies.fetchFont(url) : await (async () => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`font HTTP ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        })();
        if (disposed) return;
        const font = module.createFont(bytes);
        if (!font) throw new Error("font face rejected by HarfBuzz");
        faces.set(url, { url, bytes, font });
      } catch (error) { failures.set(url, String(error)); }
      finally { loading.delete(url); if (!disposed) onInvalidate(); }
    })();
  }

  function pump(): void {
    if (disposed || generating || active || !queue.length) return;
    const task = queue.shift()!;
    generating = true;
    void generator.generate(task.face.bytes.slice().buffer, task.glyphIds, task.range)
      .then((result) => {
        if (disposed) { result.release(); return; }
        generationMs += result.generationMs;
        generationBatches++;
        generatorHeapBytes = result.wasmMemoryBytes;
        active = { ...task, result };
        onInvalidate();
      })
      .catch((error) => {
        for (const key of task.keys) { queued.delete(key); failures.set(key, String(error)); }
        if (!disposed) onInvalidate();
      })
      .finally(() => { generating = false; pump(); });
  }

  return {
    shape(record) {
      const url = record.msdf?.url;
      if (!url) return { reason: "font-source" };
      const face = faces.get(url);
      if (!face) {
        ensureFace(url);
        return { reason: failures.has(url) ? "font-load" : "font-pending" };
      }
      // Records are ordered rich runs; carry their run index and full style, including colour,
      // so a role or BBCode change cannot borrow another run's shaped placement.
      const identity = JSON.stringify([record.key, record.insertionIndex, record.text,
        record.msdf?.url, record.msdf?.faceKey, record.msdf?.measuredAdvance,
        record.msdf?.baselinePx, record.style, record.tint]);
      let shaped = shapes.get(identity);
      if (shaped) shapeHits++;
      else {
        shapeMisses++;
        shaped = shapeMsdfRun(record, face.font);
        shapes.set(identity, shaped);
        if (shapes.size > 2048) shapes.delete(shapes.keys().next().value!);
      }
      return shaped.ok ? { run: shaped.run, face } : { reason: shaped.reason };
    },
    request(face, range, glyphIds) {
      for (let index = 0; index < glyphIds.length; index += 4) {
        const ids = glyphIds.slice(index, index + 4).filter((id) => {
          const key = msdfGlyphKey(face.url, range, id);
          if (queued.has(key) || failures.has(key)) return false;
          queued.add(key);
          return true;
        });
        if (ids.length) queue.push({ face, range, glyphIds: ids,
          keys: ids.map((id) => msdfGlyphKey(face.url, range, id)) });
      }
      pump();
    },
    takeGeneration() {
      if (!active || taken) return null;
      taken = true;
      return active;
    },
    finishGeneration(lease) {
      if (active !== lease) throw new Error("unknown MSDF generation lease");
      lease.result.release();
      for (const key of lease.keys) queued.delete(key);
      active = null;
      taken = false;
      pump();
    },
    failureFor: (key) => failures.get(key),
    stats: () => ({ fontBytes: [...faces.values()].reduce((sum, face) => sum + face.bytes.byteLength, 0),
      hbHeapBytes: hb?.heapBytes ?? 0, generatorHeapBytes, generationMs, generationBatches,
      pendingTileBytes: active?.result.tiles.reduce((sum, tile) => sum + tile.pixels.byteLength, 0) ?? 0,
      shapeHits, shapeMisses }),
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.result.release();
      generator.dispose();
      for (const face of faces.values()) face.font.destroy();
      hb?.destroy();
      faces.clear(); shapes.clear(); queue.length = 0; queued.clear(); failures.clear();
    }
  };
}
