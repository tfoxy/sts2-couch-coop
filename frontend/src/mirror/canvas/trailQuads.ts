// Allocation-free card-ribbon quad emission shared by the generic canvas stage and the DOM VFX ribbon layer.

import type { QuadView } from "@godot-scene-web/canvas";

import type { Affine } from "@/mirror/affine";
import type { TrailStrip } from "@/mirror/cardTrail";

export interface TrailStripQuadInput<TTexture> {
  strip: TrailStrip;
  global: Affine;
  tintR: number;
  tintG: number;
  tintB: number;
  opacity: number;
  blend: 0 | 1;
  texture: { key: TTexture; width: number; height: number } | null;
}

export interface TrailStripQuadSink<TTexture> {
  quad(view: QuadView, texture: TTexture | null): void;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Emit both ribbon cells and seam-fill cells as premultiplied stage-global quads. */
export function emitTrailStripQuads<TTexture>(
  input: TrailStripQuadInput<TTexture>,
  view: QuadView,
  sink: TrailStripQuadSink<TTexture>
): number {
  const { strip, global: g, texture } = input;
  if (strip.quads.length === 0 && strip.seamQuads.length === 0) return 0;
  view.w = 1;
  view.h = 1;
  view.srcX = 0;
  view.srcY = 0;
  view.srcW = texture?.width ?? 0;
  view.srcH = texture?.height ?? 0;
  view.flipH = false;
  view.flipV = false;
  view.hasColorMatrix = false;
  view.blend = input.blend;
  const tintR = clamp01(input.tintR);
  const tintG = clamp01(input.tintG);
  const tintB = clamp01(input.tintB);
  const opacity = clamp01(input.opacity);
  let pushed = 0;
  const pushCell = (cell: { m: number[]; alpha: number }): void => {
    const m = cell.m;
    view.m[0] = g[0] * m[0] + g[2] * m[1];
    view.m[1] = g[1] * m[0] + g[3] * m[1];
    view.m[2] = g[0] * m[2] + g[2] * m[3];
    view.m[3] = g[1] * m[2] + g[3] * m[3];
    view.m[4] = g[0] * m[4] + g[2] * m[5] + g[4];
    view.m[5] = g[1] * m[4] + g[3] * m[5] + g[5];
    const alpha = clamp01(opacity * cell.alpha);
    view.a = alpha;
    view.r = tintR * alpha;
    view.g = tintG * alpha;
    view.b = tintB * alpha;
    sink.quad(view, texture?.key ?? null);
    pushed++;
  };
  for (const cell of strip.quads) pushCell(cell);
  for (const cell of strip.seamQuads) pushCell(cell);
  return pushed;
}
