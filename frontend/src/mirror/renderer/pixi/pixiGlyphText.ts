import type { PixiGlyphRecord } from "@godot-scene-web/canvas/pixi";
import type { GlyphBlock, GlyphPassRegistry, GlyphPassStats } from "@/mirror/canvas/glyphPass";
import type { TextLayout, TextSpec } from "@/mirror/canvas/textLayout";
import type { MirrorFont } from "@/mirror/sceneTree";

const refusals = [
  ["refusedNotReady", "glyph-not-ready"], ["refusedNoFace", "glyph-no-face"],
  ["refusedNoMetrics", "glyph-no-metrics"], ["refusedCoverage", "glyph-coverage"],
  ["refusedOutline", "glyph-outline"], ["refusedPpem", "glyph-ppem"],
  ["refusedShape", "glyph-shape"], ["refusedColor", "glyph-color"],
] as const;

function refusalAfter(before: GlyphPassStats, after: GlyphPassStats): string {
  for (const [counter, reason] of refusals) if (after[counter] > before[counter]) return reason;
  return "glyph-empty";
}

/** Borrowed registry buffers are copied before another label can reshape them. */
export function copyPixiGlyphBlock(block: GlyphBlock): GlyphBlock {
  let glyphCount = 0;
  for (let i = 0; i < block.runCount; i++)
    glyphCount = Math.max(glyphCount, block.spans[i * 2] + block.spans[i * 2 + 1]);
  return {
    runCount: block.runCount,
    origins: block.origins.slice(0, block.runCount * 2),
    spans: block.spans.slice(0, block.runCount * 2),
    colors: block.colors.slice(0, block.runCount * 4),
    spreads: block.spreads.slice(0, block.runCount),
    slots: block.slots.slice(0, glyphCount),
    positions: block.positions.slice(0, glyphCount * 2),
    pixelsPerEm: block.pixelsPerEm,
    blockScale: block.blockScale,
  };
}

export function preparePixiGlyph(
  registry: GlyphPassRegistry | null, spec: TextSpec, layout: TextLayout, font: MirrorFont,
  transform: readonly number[], perDesignPx: number, contentKey: string, cacheEligible: boolean,
): { glyph?: PixiGlyphRecord; fallbackReason?: string } {
  if (!registry) return { fallbackReason: "glyph-provider-unavailable" };
  if (layout.lines.some((line) => line.runs?.some((run) =>
    run.color !== null && run.color.toLowerCase() !== spec.color.toLowerCase())))
    return { fallbackReason: "glyph-rich-spans" };
  const before = registry.stats();
  const deviceScale = (Math.hypot(transform[0], transform[1]) + Math.hypot(transform[2], transform[3])) / 2 * perDesignPx;
  const borrowed = registry.blockFor(spec, layout, font, deviceScale);
  if (!borrowed) return { fallbackReason: refusalAfter(before, registry.stats()) };
  const inkBounds = registry.boundsFor(borrowed);
  if (!inkBounds) return { fallbackReason: "glyph-ink-bounds" };
  return { glyph: { block: copyPixiGlyphBlock(borrowed), inkBounds,
    box: { width: spec.boxW, height: spec.boxH }, contentKey, cacheEligible } };
}
