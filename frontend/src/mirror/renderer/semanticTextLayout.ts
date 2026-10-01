import { layoutText, resolveTextSpec, type TextSpan } from "@/mirror/canvas/textLayout";
import { parseSimpleRich } from "@/mirror/canvas/richSimple";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import { resolveTextScaleDecls } from "@/mirror/textScaleClasses";
import type { MirrorNode } from "@/mirror/sceneTree";
import { baselineOf, type TextLineMetrics } from "@/mirror/canvas/textLayout";

export function nativeTextOriginCorrection(pitchPx:number, outlinePx:number, metrics:TextLineMetrics) {
  const strokeHalf=outlinePx/2,fontBox=metrics.ascent+metrics.descent;
  const pixiBaseline=strokeHalf+metrics.ascent+Math.max(0,(pitchPx-fontBox)/2);
  return { x:-strokeHalf, y:baselineOf(0,pitchPx,metrics)-pixiBaseline };
}

/** Pixi drop shadows keep colour and alpha in separate fields. */
export function pixiShadowColor(color: string): { color: string; alpha: number } | null {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null;
  return { color: `#${hex.slice(0, 6)}`, alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 };
}

/** Canvas carriers need the Pixi shadow's color alpha in the shadow paint only, not on glyph paint. */
export function rustTextShadowCssColor(color: string, alpha: number): string | null {
  const parsed = pixiShadowColor(color);
  if (!parsed || !Number.isFinite(alpha)) return null;
  const hex = parsed.color.slice(1);
  const a = Math.max(0, Math.min(1, parsed.alpha * alpha));
  return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${a})`;
}

/** Move a padded raster carrier back by its local top-left inset, respecting rotation and scale. */
export function offsetRustTextCarrierTransform(transform: readonly number[], padX: number, padY: number): number[] {
  const [a, b, c, d, tx, ty] = transform;
  return [a, b, c, d, tx - a * padX - c * padY, ty - b * padX - d * padY];
}

/** Backend-neutral CPU text placement used only by lazy parity diagnostics. */
export function semanticTextLayout(node: MirrorNode, nodes: Map<string, MirrorNode>, ctx: CanvasRenderingContext2D | null): unknown {
  if (!node.text || !ctx) return null;
  const scene=resolveSceneInfo(node.id,nodes),decls=resolveTextScaleDecls(scene?.file??null,scene?.relPath??null);
  let spec=resolveTextSpec(node,decls);let spans:readonly TextSpan[]|undefined;
  if (!spec) return null;
  if(spec.refusal==="rich") { const parsed=parseSimpleRich(spec.text,{color:(v)=>v});if(!parsed.ok)return {refusal:`rich:${parsed.refusal}`};
    const plain=resolveTextSpec({...node,richText:false,text:{...node.text,text:parsed.value.text}},decls);if(!plain||plain.refusal)return {refusal:plain?.refusal??"rich"};
    spec=parsed.value.align===null?plain:{...plain,align:parsed.value.align};spans=parsed.value.spans.length?parsed.value.spans:undefined; }
  if(spec.refusal)return {refusal:spec.refusal};ctx.font=spec.cssFont;
  const layout=layoutText(spec,(value)=>ctx.measureText(value).width,spans);
  return { text:spec.text,font:spec.cssFont,color:spec.color,outline:[spec.outlineColor,spec.outlinePx],shadow:spec.shadow,
    box:[spec.boxW,spec.boxH],block:[layout.blockW,layout.blockH,spec.blockScale],pitch:spec.pitchPx,
    lines:layout.lines.map((line)=>({text:line.text,x:line.x,y:line.y,width:line.width,runs:line.runs??null})) };
}
