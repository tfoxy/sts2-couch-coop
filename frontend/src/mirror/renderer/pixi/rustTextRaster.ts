import type { PixiTextRun } from "@godot-scene-web/canvas/pixi";
import { rustTextShadowCssColor } from "@/mirror/renderer/semanticTextLayout";

export interface RustTextPaintStyle {
  fill: string;
  stroke?: { color: string; width: number } | null;
  shadow?: { color: string; alpha: number; blur: number; offsetX: number; offsetY: number } | null;
}

/** Draw one supported Pixi text carrier while keeping shadow opacity off its stroke and glyphs. */
export function drawRustTextRuns(
  context: CanvasRenderingContext2D,
  runs: readonly PixiTextRun[],
  style: RustTextPaintStyle,
  startX: number,
  baselineY: number,
  measure: (text: string) => number,
): boolean {
  const shadowColor = style.shadow
    ? rustTextShadowCssColor(style.shadow.color, style.shadow.alpha)
    : null;
  if (style.shadow && !shadowColor) return false;

  context.shadowColor = shadowColor ?? "transparent";
  context.shadowBlur = style.shadow?.blur ?? 0;
  context.shadowOffsetX = style.shadow?.offsetX ?? 0;
  context.shadowOffsetY = style.shadow?.offsetY ?? 0;
  context.globalAlpha = 1;

  let x = startX;
  for (const run of runs) {
    context.globalAlpha = 1;
    if (style.stroke && style.stroke.width > 0) {
      context.lineWidth = style.stroke.width;
      context.strokeStyle = style.stroke.color;
      context.strokeText(run.text, x, baselineY);
      // Pixi shadows the complete outlined glyph once. Canvas would composite two shadows if both the
      // strokeText and fillText calls had a shadow, so the outlined pass owns it and the fill only paints ink.
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
    }
    context.globalAlpha = 1;
    context.fillStyle = run.color ?? style.fill;
    context.fillText(run.text, x, baselineY);
    // Restore the shadow for the next independently positioned color run.
    context.shadowColor = shadowColor ?? "transparent";
    context.shadowBlur = style.shadow?.blur ?? 0;
    context.shadowOffsetX = style.shadow?.offsetX ?? 0;
    context.shadowOffsetY = style.shadow?.offsetY ?? 0;
    x += measure(run.text);
  }

  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.globalAlpha = 1;
  return true;
}
