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

import { parseSimpleRich, type ColorValidator } from "@/mirror/canvas/richSimple";
import { resolveSceneInfo } from "@/mirror/canvas/hitTest";
import {
  layoutText,
  baselineOf,
  resolveTextSpec,
  type MeasureText,
  type TextLayout,
  type TextLineMetrics,
  type TextSpan,
  type TextSpec,
  type TextFontRole,
  type TextRoleSpan,
  type TextRun
} from "@/mirror/canvas/textLayout";
import { resolveTextScaleDecls } from "@/mirror/textScaleClasses";
import { nativeTextOriginCorrection, pixiShadowColor } from "@/mirror/renderer/semanticTextLayout";
import { mirrorResourceUrl, type MirrorFont, type MirrorNode } from "@/mirror/sceneTree";
import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";

/** Why this label cannot be rastered — mirrors the `semanticFailures` strings `semanticText` has always used. */
export interface TextPrepRefusal {
  refusal: string;
}

export interface ResolvedTextSpec {
  spec: TextSpec;
  /** Rust-only candidate; admitted after measured layout proves the whole unbreakable line fits. */
  fittingUnbreakableRefusal?: "unbreakable" | "rich:unbreakable";
  spans: readonly TextSpan[] | undefined;
  roles?: readonly TextRoleSpan[];
  roleFaces?: Partial<Record<TextFontRole, RoleFace>>;
  fallbackRoles?: readonly TextFontRole[];
  images?: readonly { start: number; url: string; valign: "top" | "middle" | "bottom" }[];
  degradations?: readonly string[];
}

export interface RoleFace { font: MirrorFont; cssFont: string; fontPx: number; spacingPx: number; pitchPx: number }

function fontRoleFace(node: MirrorNode, spec: TextSpec, role: TextFontRole, failed: ReadonlySet<string>): RoleFace {
  const face = role === "bold" ? node.richBoldFont : role === "italic" ? node.richItalicFont
    : role === "bold-italic" ? node.richBoldItalicFont : null;
  const font = face && !failed.has(face.family) ? face : node.font!;
  const roleSize = role === "bold" ? node.richBoldFontSizePx : role === "italic" ? node.richItalicFontSizePx
    : role === "bold-italic" ? node.richBoldItalicFontSizePx : null;
  const size = roleSize && node.text?.fontSizePx ? spec.fontPx * roleSize / node.text.fontSizePx : spec.fontPx;
  const spacing = role === "bold" ? node.richBoldFontSpacingPx : role === "italic" ? node.richItalicFontSpacingPx
    : role === "bold-italic" ? node.richBoldItalicFontSpacingPx : null;
  return { font, cssFont: `${font.style ?? ""} ${font.weight ?? ""} ${size}px "${font.family}"`.replace(/\s+/g, " ").trim(),
    fontPx: size, spacingPx: face && !failed.has(face.family) ? spacing ?? 0 : 0,
    pitchPx: spec.pitchPx * size / Math.max(1, spec.fontPx) };
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
  nodes: ReadonlyMap<string, MirrorNode>,
  allowFontRoles = false,
  failedRoleFamilies: ReadonlySet<string> = new Set(),
  colorValidator: ColorValidator = (value) => value,
  allowFittingUnbreakable = false
): ResolvedTextSpec | TextPrepRefusal {
  const scene = resolveSceneInfo(node.id, nodes);
  const decls = resolveTextScaleDecls(scene?.file ?? null, scene?.relPath ?? null);
  let spec = resolveTextSpec(node, decls);
  if (!spec || !node.font) return { refusal: !spec ? "unresolved-text" : "no-font" };
  let spans: readonly TextSpan[] | undefined;
  let roles: readonly TextRoleSpan[] | undefined;
  let roleFaces: ResolvedTextSpec["roleFaces"];
  let fallbackRoles: TextFontRole[] | undefined;
  let images: ResolvedTextSpec["images"];
  let degradations: string[] | undefined;
  if (spec.refusal === "rich") {
    const parsed = parseSimpleRich(spec.text, { color: colorValidator, fontRoles: allowFontRoles,
      inlineImages: allowFontRoles, ...(allowFontRoles ? { unsupported: "plain" as const } : {}) });
    if (!parsed.ok) return { refusal: `rich:${parsed.refusal}` };
    const plain = resolveTextSpec({ ...node, richText: false, text: { ...node.text!, text: parsed.value.text } }, decls);
    if (!plain || (plain.refusal && !(allowFittingUnbreakable && plain.refusal === "unbreakable")))
      return { refusal: `rich:${plain?.refusal ?? "post-parse"}` };
    spec = parsed.value.align === null ? plain : { ...plain, align: parsed.value.align };
    spans = parsed.value.spans.length ? parsed.value.spans : undefined;
    roles = parsed.value.roles.length ? parsed.value.roles : undefined;
    images = parsed.value.images.length ? parsed.value.images.map(({ start, path, valign }) =>
      ({ start, url: mirrorResourceUrl(path), valign })) : undefined;
    degradations = parsed.value.losses?.map((loss) => `rich:${loss.feature}:${loss.detail}`);
    if (roles) {
      roleFaces = {};
      fallbackRoles = [];
      for (const role of new Set(roles.map((span) => span.role))) {
        roleFaces[role] = fontRoleFace(node, spec, role, failedRoleFamilies);
        const original = role === "bold" ? node.richBoldFont : role === "italic" ? node.richItalicFont : node.richBoldItalicFont;
        if (!original || failedRoleFamilies.has(original.family)) fallbackRoles.push(role);
      }
    }
  }
  if (spec.refusal && !(allowFittingUnbreakable && spec.refusal === "unbreakable"))
    return { refusal: spec.refusal };
  return { spec, spans, roles, roleFaces, fallbackRoles, images, degradations,
    ...(spec.refusal === "unbreakable" ? {
      fittingUnbreakableRefusal: node.richText ? "rich:unbreakable" as const : "unbreakable" as const
    } : {}) };
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
  /** The exact face and measured placement used by this run, independent of CSS family lookup. */
  msdf: { url: string; faceKey: string; measuredAdvance: number; baselinePx: number };
  inlineImage?: { url: string; width: number; height: number };
}

export interface PreparedText {
  spec: TextSpec;
  spans: readonly TextSpan[] | undefined;
  roleFaces?: ResolvedTextSpec["roleFaces"];
  fallbackRoles?: readonly TextFontRole[];
  images?: readonly { start: number; url: string; width: number; height: number; valign: "top" | "middle" | "bottom" }[];
  degradations?: readonly string[];
  /** Missing image resources keep the surrounding words visible; do not cache until they settle. */
  imagePending?: boolean;
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
  measureLineMetrics: (cssFont: string) => TextLineMetrics,
  roleMeasure?: (face: RoleFace, value: string) => number,
  imageSize?: (url: string) => { width: number; height: number } | null
): PreparedText | TextPrepRefusal {
  const { spec, spans, roles, roleFaces, fallbackRoles } = resolved;
  let imagePending = false;
  const degradations = [...resolved.degradations ?? []];
  const images = resolved.images?.map((image) => {
    const size = imageSize?.(image.url);
    if (!size) imagePending = true;
    else if (size.width <= 0 || size.height <= 0) degradations.push(`rich:img:image-unavailable:${image.url}`);
    return { ...image, width: size?.width ?? 0, height: size?.height ?? 0 };
  });
  const resolvedImages = images;
  const layoutKey = roles || resolvedImages
    ? JSON.stringify([fontVersion, font, spec, spans, roles, roleFaces, resolvedImages])
    : JSON.stringify([fontVersion, font, spec, spans]);
  const metrics = measureLineMetrics(spec.cssFont);
  const normalFace: RoleFace = { font, cssFont: spec.cssFont, fontPx: spec.fontPx, spacingPx: 0, pitchPx: spec.pitchPx };
  const faceOf = (role: TextFontRole): RoleFace => roleFaces?.[role] ?? normalFace;
  const layout = layoutText(spec, measure, spans, roles || resolvedImages ? {
    roles: roles ?? [], images: resolvedImages,
    measure: (role, value) => roleMeasure ? roleMeasure(faceOf(role), value) : measure(value),
    pitch: (role) => faceOf(role).pitchPx,
  } : undefined);
  if (resolved.fittingUnbreakableRefusal) {
    const line = layout.lines[0];
    if (imagePending || resolvedImages?.some((image) => image.width <= 0 || image.height <= 0) ||
        spec.text.includes("\n") || spec.text.trimEnd() !== spec.text || layout.wrapped ||
        layout.lines.length !== 1 || line?.text !== spec.text ||
        !Number.isFinite(line.width) || line.width < 0 || line.width > spec.contentW)
      return { refusal: resolved.fittingUnbreakableRefusal };
  }
  const shadow = spec.shadow ? pixiShadowColor(spec.shadow.color) : null;
  if (spec.shadow && !shadow) return { refusal: "invalid-shadow-color" };
  const resourceRevision = `${fontVersion}:${JSON.stringify(roles || resolvedImages
    ? [font, roleFaces, resolvedImages] : font)}`;
  const scale = spec.blockScale;
  const originCorrection = nativeTextOriginCorrection(spec.pitchPx, spec.outlinePx, metrics);
  const roleMetrics = new Map<TextFontRole, TextLineMetrics>();
  roleMetrics.set("normal", metrics);
  if (roleFaces) for (const role of Object.keys(roleFaces) as TextFontRole[])
    roleMetrics.set(role, measureLineMetrics(faceOf(role).cssFont));
  const runs: PreparedTextRun[] = [];
  for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
    const line = layout.lines[lineIndex];
    const parts: readonly TextRun[] = line.runs?.length ? line.runs
      : [{ text: line.text, x: line.x, width: line.width, color: null }];
    const lineMetrics = parts.reduce((acc, part) => {
      const value = roleMetrics.get(part.role ?? "normal") ?? metrics;
      return { ascent: Math.max(acc.ascent, value.ascent), descent: Math.max(acc.descent, value.descent) };
    }, { ascent: 0, descent: 0 });
    for (let runIndex = 0; runIndex < parts.length; runIndex++) {
      const part = parts[runIndex];
      const role = part.role ?? "normal";
      const face = faceOf(role);
      const runMetrics = roleMetrics.get(role) ?? metrics;
      const pitch = line.pitchPx ?? spec.pitchPx;
      const baseline = baselineOf(line.y, pitch, lineMetrics);
      const strokeHalf = spec.outlinePx / 2;
      const rasterBaseline = strokeHalf + runMetrics.ascent + Math.max(0, (pitch - runMetrics.ascent - runMetrics.descent) / 2);
      const imageTop = part.image?.valign === "top" ? baseline - lineMetrics.ascent
        : part.image?.valign === "bottom" ? baseline - part.image.height
        : baseline - (part.image?.height ?? 0) / 2 - spec.fontPx * 0.344;
      const y = (1 - scale) * spec.boxH / 2 + (part.image ? imageTop : baseline - rasterBaseline) * scale;
      const x = (1 - scale) * spec.boxW / 2 + (part.x + originCorrection.x) * scale;
      runs.push({
        lineIndex, runIndex, text: part.text, boxX: x, boxY: y,
        msdf: { url: face.font.url.startsWith("res://") ? mirrorResourceUrl(face.font.url) : face.font.url,
          faceKey: `${face.font.url}:${face.font.family}:${face.font.weight ?? ""}:${face.font.style ?? ""}`,
          measuredAdvance: part.width, baselinePx: rasterBaseline },
        ...(part.image && part.image.width > 0 && part.image.height > 0
          ? { inlineImage: { url: part.image.url, width: part.image.width, height: part.image.height } } : {}),
        style: {
          fontFamily: face.font.family, fontSize: face.fontPx,
          fontStyle: (face.font.style || "normal") as "normal" | "italic" | "oblique",
          fontWeight: (face.font.weight || "normal") as "normal", fill: part.color ?? spec.color,
          ...(face.spacingPx ? { letterSpacing: face.spacingPx } : {}),
          align: "left", wordWrap: false, lineHeight: spec.pitchPx,
          stroke: spec.outlineColor && spec.outlinePx > 0 ? { color: spec.outlineColor, width: spec.outlinePx } : undefined,
          dropShadow: spec.shadow && shadow ? { color: shadow.color, alpha: shadow.alpha,
            angle: Math.atan2(spec.shadow.dy, spec.shadow.dx), distance: Math.hypot(spec.shadow.dx, spec.shadow.dy), blur: 0 } : undefined,
        },
      });
    }
  }
  return { spec: resolved.fittingUnbreakableRefusal ? { ...spec, refusal: null } : spec,
    spans, roleFaces, fallbackRoles, images: resolvedImages, layoutKey, layout, metrics, shadow,
    resourceRevision, runs, degradations, imagePending };
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
    if (run.text === "\uFFFC" && !run.inlineImage) continue;
    const transform = [m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale,
      m[0] * run.boxX + m[2] * run.boxY + m[4], m[1] * run.boxX + m[3] * run.boxY + m[5]];
    out.push({
      key: `${nodeId}:${run.lineIndex}:${run.runIndex}`, insertionIndex, text: run.text, transform,
      labelId: nodeId, resourceRevision: prepared.resourceRevision, style: run.style,
      alpha: record.opacity, blend, tint,
      msdf: run.msdf,
      ...(run.inlineImage ? { inlineImage: run.inlineImage } : {}),
    } as PixiTextRecord);
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
 * text-scale table (a `fontVersion` bump) misses and recomputes. Pending image layouts are presented with their
 * words but not cached, so the resource-ready wake can prepare the image without a node revision.
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
            if (!("imagePending" in fresh && fresh.imagePending))
              store.set(node, { chain, fontVersion, textMode, result: fresh });
            return fresh;
          }
        }
        return cached.result;
      }
      misses++;
      const result = compute();
      if (!("imagePending" in result && result.imagePending))
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
