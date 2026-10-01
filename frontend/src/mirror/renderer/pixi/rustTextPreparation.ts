// rustFast WP3 — the PURE half of semantic text preparation, plus two small caches around it.
//
// `createPixiMirrorRenderer.ts`'s `semanticText` used to do five expensive things inline for every text node on
// every producer build: walk the node's scene ancestry (`resolveSceneInfo`), resolve its text-scale declarations,
// resolve its raster spec (`resolveTextSpec`, plus a second pass for a rich label), ask `document.fonts.check`
// whether the face is ready, and `JSON.stringify` a layout key plus `node.font` per rich run. A DevTools profile of
// busy combat (see the WP3 brief) found `FontFaceSet.check` alone costing 319 leaf samples across one capture
// window, with the two `JSON.stringify` calls close behind.
//
// Everything in this module is DEPENDENCY-INJECTED rather than reaching for the DOM itself (same discipline as
// `textLayout.ts`'s `measure: MeasureText`), so none of it needs a browser to test: `resolveSemanticTextSpec` and
// `buildPreparedText` are pure functions of their arguments, and the two caches take a fake `FontFaceSet` / a plain
// `Map`-backed node graph instead of touching `document` or `window`.
//
// `createPixiMirrorRenderer.ts` still owns the IMPURE half: kicking off `loadMirrorFont`, tracking which fonts are
// pending/failed, pushing into `texts`/`textOwners`, and the `fast.textPrepCache` / `fast.fontCheckCache` on/off
// switch itself. This module only has to be right about what a node's label looks like, not about when to ask it.

import { parseSimpleRich } from "@/mirror/canvas/richSimple";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import {
  layoutText,
  resolveTextSpec,
  type MeasureText,
  type TextLayout,
  type TextLineMetrics,
  type TextSpan,
  type TextSpec
} from "@/mirror/canvas/textLayout";
import { resolveTextScaleDecls } from "@/mirror/textScaleClasses";
import { nativeTextOriginCorrection, pixiShadowColor } from "@/mirror/renderer/semanticTextLayout";
import type { MirrorFont, MirrorNode } from "@/mirror/sceneTree";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";

/** Why this label cannot be rastered — mirrors the `semanticFailures` strings `semanticText` has always used. */
export interface TextPrepRefusal {
  refusal: string;
}

export interface ResolvedTextSpec {
  spec: TextSpec;
  spans: readonly TextSpan[] | undefined;
}

function isRefusal(value: ResolvedTextSpec | TextPrepRefusal | PreparedText): value is TextPrepRefusal {
  return "refusal" in value;
}

/**
 * Plain-then-rich spec resolution — byte-identical to the inline logic `semanticText` ran before this round.
 * PURE: `nodes` only ever gets walked (never written), and `resolveTextSpec` is a pure function of a node plus its
 * resolved declarations (verified by reading it: it touches nothing but its two arguments).
 */
export function resolveSemanticTextSpec(
  node: MirrorNode,
  nodes: ReadonlyMap<string, MirrorNode>
): ResolvedTextSpec | TextPrepRefusal {
  const scene = resolveSceneInfo(node.id, nodes);
  const decls = resolveTextScaleDecls(scene?.file ?? null, scene?.relPath ?? null);
  let spec = resolveTextSpec(node, decls);
  if (!spec || !node.font) return { refusal: !spec ? "unresolved-text" : "no-font" };
  let spans: readonly TextSpan[] | undefined;
  if (spec.refusal === "rich") {
    const parsed = parseSimpleRich(spec.text, { color: (value) => value });
    if (!parsed.ok) return { refusal: `rich:${parsed.refusal}` };
    const plain = resolveTextSpec({ ...node, richText: false, text: { ...node.text!, text: parsed.value.text } }, decls);
    if (!plain || plain.refusal) return { refusal: `rich:${plain?.refusal ?? "post-parse"}` };
    spec = parsed.value.align === null ? plain : { ...plain, align: parsed.value.align };
    spans = parsed.value.spans.length ? parsed.value.spans : undefined;
  }
  if (spec.refusal) return { refusal: spec.refusal };
  return { spec, spans };
}

/** One placed run, ready to be positioned by a live `record.transform` — see {@link composePreparedTextRecords}. */
export interface PreparedTextRun {
  lineIndex: number;
  runIndex: number;
  text: string;
  /** Box-space x/y — everything `semanticText` used to compute per run EXCEPT the live transform/scale. */
  boxX: number;
  boxY: number;
  /**
   * The SAME object reference every call that hits the cache — never rebuilt. That is the point: the executor's
   * own style-string cache (`createRustDrawListExecutor.ts`'s `textResourceKey`) is keyed on THIS object's
   * identity, so a fresh literal here would defeat it even with `fast.textPrepCache` on.
   */
  style: PixiTextRecord["style"];
}

export interface PreparedText {
  spec: TextSpec;
  spans: readonly TextSpan[] | undefined;
  /** `JSON.stringify([fontVersion, font, spec, spans])` — kept only as a cheap equality witness for `verify`. */
  layoutKey: string;
  layout: TextLayout;
  metrics: TextLineMetrics;
  shadow: { color: string; alpha: number } | null;
  resourceRevision: string;
  runs: readonly PreparedTextRun[];
}

/**
 * Build the full prepared record from an already-resolved spec. PURE given its callbacks: `measure` and
 * `measureLineMetrics` are the only places this touches anything canvas-shaped, both supplied by the caller
 * exactly like `layoutText`'s own `measure` always has been.
 */
export function buildPreparedText(
  resolved: ResolvedTextSpec,
  fontVersion: number,
  font: MirrorFont,
  measure: MeasureText,
  measureLineMetrics: (cssFont: string) => TextLineMetrics
): PreparedText | TextPrepRefusal {
  const { spec, spans } = resolved;
  const layoutKey = JSON.stringify([fontVersion, font, spec, spans]);
  const metrics = measureLineMetrics(spec.cssFont);
  const layout = layoutText(spec, measure, spans);
  const shadow = spec.shadow ? pixiShadowColor(spec.shadow.color) : null;
  if (spec.shadow && !shadow) return { refusal: "invalid-shadow-color" };
  const resourceRevision = `${fontVersion}:${JSON.stringify(font)}`;
  const scale = spec.blockScale;
  const originCorrection = nativeTextOriginCorrection(spec.pitchPx, spec.outlinePx, metrics);
  const runs: PreparedTextRun[] = [];
  for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
    const line = layout.lines[lineIndex];
    const y = (1 - scale) * spec.boxH / 2 + (line.y + originCorrection.y) * scale;
    const parts = line.runs?.length ? line.runs : [{ text: line.text, x: line.x, color: null }];
    for (let runIndex = 0; runIndex < parts.length; runIndex++) {
      const part = parts[runIndex];
      const x = (1 - scale) * spec.boxW / 2 + (part.x + originCorrection.x) * scale;
      runs.push({
        lineIndex, runIndex, text: part.text, boxX: x, boxY: y,
        style: {
          fontFamily: spec.family, fontSize: spec.fontPx,
          fontStyle: (font.style || "normal") as "normal" | "italic" | "oblique",
          fontWeight: (font.weight || "normal") as "normal", fill: part.color ?? spec.color,
          align: "left", wordWrap: false, lineHeight: spec.pitchPx,
          stroke: spec.outlineColor && spec.outlinePx > 0 ? { color: spec.outlineColor, width: spec.outlinePx } : undefined,
          dropShadow: spec.shadow && shadow ? { color: shadow.color, alpha: shadow.alpha,
            angle: Math.atan2(spec.shadow.dy, spec.shadow.dx), distance: Math.hypot(spec.shadow.dx, spec.shadow.dy), blur: 0 } : undefined,
        },
      });
    }
  }
  return { spec, spans, layoutKey, layout, metrics, shadow, resourceRevision, runs };
}

/**
 * Turn a `PreparedText` into this build's `PixiTextRecord`s. Always called fresh, cache hit or miss: a retained
 * composition later STAMPS `parentId` directly onto these objects (`retainedComposition.ts`), so every record must
 * be its own object every build even though `run.style` inside it may be a carried-over reference.
 */
export function composePreparedTextRecords(
  prepared: PreparedText,
  nodeId: string,
  insertionIndex: number,
  record: { transform: readonly number[]; opacity: number; tintR: number; tintG: number; tintB: number },
  blend: number
): PixiTextRecord[] {
  const m = record.transform;
  const scale = prepared.spec.blockScale;
  const tint = (Math.round(Math.max(0, Math.min(1, record.tintR)) * 255) << 16) |
    (Math.round(Math.max(0, Math.min(1, record.tintG)) * 255) << 8) |
    Math.round(Math.max(0, Math.min(1, record.tintB)) * 255);
  const out: PixiTextRecord[] = [];
  for (const run of prepared.runs) {
    const transform = [m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale,
      m[0] * run.boxX + m[2] * run.boxY + m[4], m[1] * run.boxX + m[3] * run.boxY + m[5]];
    out.push({
      key: `${nodeId}:${run.lineIndex}:${run.runIndex}`, insertionIndex, text: run.text, transform,
      labelId: nodeId, resourceRevision: prepared.resourceRevision, style: run.style,
      alpha: record.opacity, blend, tint,
    });
  }
  return out;
}

// --- the text-preparation cache --------------------------------------------------------------------------------

export interface TextPrepCacheStats {
  hits: number;
  misses: number;
  verifyMismatches: number;
}

export interface TextPrepCache {
  /**
   * `compute` is the slow path (`resolveSemanticTextSpec` + `buildPreparedText`), supplied as a thunk so a cache
   * hit never has to run it. Returns whatever `compute` would have, cached or not.
   */
  resolve(
    node: MirrorNode,
    nodes: ReadonlyMap<string, MirrorNode>,
    fontVersion: number,
    textMode: string,
    verify: boolean,
    compute: () => PreparedText | TextPrepRefusal
  ): PreparedText | TextPrepRefusal;
  stats(): TextPrepCacheStats;
}

/** Walk from `node` to its scene root exactly as `resolveSceneInfo` does, keeping every node visited along the way. */
function captureAncestorChain(node: MirrorNode, nodes: ReadonlyMap<string, MirrorNode>): readonly MirrorNode[] {
  const chain: MirrorNode[] = [node];
  let cur = node;
  while (!cur.sceneFilePath) {
    const parent = cur.parentId != null ? nodes.get(cur.parentId) : undefined;
    if (!parent) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

function chainsIdentical(a: readonly MirrorNode[], b: readonly MirrorNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function preparedResultsAgree(a: PreparedText | TextPrepRefusal, b: PreparedText | TextPrepRefusal): boolean {
  const aRefused = isRefusal(a), bRefused = isRefusal(b);
  if (aRefused !== bRefused) return false;
  if (aRefused && bRefused) return (a as TextPrepRefusal).refusal === (b as TextPrepRefusal).refusal;
  return (a as PreparedText).layoutKey === (b as PreparedText).layoutKey;
}

/**
 * `WeakMap<MirrorNode, …>` keyed cache — valid only while every ancestor up to (and including) the node's scene
 * root is the SAME object as last time, `fontVersion` is unchanged, and `textMode` is unchanged. A node whose
 * ancestry was rebuilt (a reconciled scene swaps in new node objects) or whose owning scene re-resolved its
 * text-scale table (a `fontVersion` bump) misses and recomputes — cache SUCCESSES only, exactly like the design
 * calls for; a miss always falls through to `compute()`.
 */
export function createTextPrepCache(): TextPrepCache {
  const store = new WeakMap<MirrorNode, { chain: readonly MirrorNode[]; fontVersion: number; textMode: string;
    result: PreparedText | TextPrepRefusal }>();
  let hits = 0, misses = 0, verifyMismatches = 0;
  return {
    resolve(node, nodes, fontVersion, textMode, verify, compute) {
      const cached = store.get(node);
      const chain = captureAncestorChain(node, nodes);
      if (cached && cached.fontVersion === fontVersion && cached.textMode === textMode && chainsIdentical(cached.chain, chain)) {
        hits++;
        if (verify) {
          const fresh = compute();
          if (!preparedResultsAgree(cached.result, fresh)) {
            verifyMismatches++;
            store.set(node, { chain, fontVersion, textMode, result: fresh });
            return fresh;
          }
        }
        return cached.result;
      }
      misses++;
      const result = compute();
      store.set(node, { chain, fontVersion, textMode, result });
      return result;
    },
    stats: () => ({ hits, misses, verifyMismatches }),
  };
}

// --- the font-check cache ----------------------------------------------------------------------------------------

export interface FontCheckCacheStats {
  hits: number;
  misses: number;
  verifyMismatches: number;
}

export interface FontCheckCache {
  /**
   * Caches only `true` results — a `false` is never stored, because a face can finish loading between two calls
   * without this cache hearing about it any other way, and caching a stale refusal would add a refused build that
   * never had to happen. `fontVersion` is an extra invalidation witness alongside the DOM events and the
   * injection counter: `loadMirrorFont`'s own per-spec promise can resolve (and bump `fontVersion`) on a
   * different tick than the FontFaceSet's aggregate `loadingdone`.
   */
  check(cssFont: string, text: string, fontVersion: number, verify: boolean): boolean;
  stats(): FontCheckCacheStats;
  dispose(): void;
}

/**
 * `fonts` and `injectionVersion` are both injected so this is testable against a fake `FontFaceSet` — see
 * `rustTextPreparation.spec.ts`. `injectionVersion` is `fontFaceInjectionVersion` from `@/mirror/fonts` in
 * production: it increments on every REAL `@font-face` injection (never on `ensureFontFace`'s dedup no-op), which
 * is the only way a cached TRUE can ever need to become suspect again outside the DOM's own events — see the
 * invariant on {@link FontCheckCache.check}.
 */
export function createFontCheckCache(fonts: FontFaceSet, injectionVersion: () => number): FontCheckCache {
  const known = new Set<string>();
  let hits = 0, misses = 0, verifyMismatches = 0;
  let lastFontVersion = -1;
  let lastInjectionVersion = -1;
  const invalidate = () => known.clear();
  fonts.addEventListener("loading", invalidate);
  fonts.addEventListener("loadingdone", invalidate);
  fonts.addEventListener("loadingerror", invalidate);
  return {
    check(cssFont, text, fontVersion, verify) {
      if (fontVersion !== lastFontVersion) { invalidate(); lastFontVersion = fontVersion; }
      const injected = injectionVersion();
      if (injected !== lastInjectionVersion) { invalidate(); lastInjectionVersion = injected; }
      const key = `${cssFont}\u0000${text}`;
      if (known.has(key)) {
        hits++;
        if (verify) {
          const real = fonts.check(cssFont, text);
          if (!real) { verifyMismatches++; known.delete(key); return real; }
        }
        return true;
      }
      misses++;
      const real = fonts.check(cssFont, text);
      if (real) known.add(key);
      return real;
    },
    stats: () => ({ hits, misses, verifyMismatches }),
    dispose() {
      fonts.removeEventListener("loading", invalidate);
      fonts.removeEventListener("loadingdone", invalidate);
      fonts.removeEventListener("loadingerror", invalidate);
    },
  };
}
