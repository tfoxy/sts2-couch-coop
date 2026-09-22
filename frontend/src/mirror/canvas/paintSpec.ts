// PER-NODE PAINT for the single-canvas mirror stage: one `MirrorNode` → the draw-list commands it contributes.
//
// This is the numeric twin of `nodeStyles.nodeStyle`. That function answers "what CSS makes the browser paint this
// node"; this one answers "what quads/nine-patches/polylines paint it directly", and it is deliberately built ON
// TOP of the same numeric core rather than beside it — `placementBox`, `atlasFitAffine`, `clipCornerRadius`,
// `isNinePatchAtlas`, `paintsAtlasCanvas`, `nodePaintsContent` and the clip branches all come from `nodeStyles`,
// the classification predicates from `shaderAttributes` / `spineAttributes` / `cardTrail`. Nothing here re-derives
// geometry the DOM path already owns; where it must add something (the flip normalisation, the stretch fits that
// CSS resolved from the image's own size), the addition is named and unit-tested against the CSS twin.
//
// NODE CLASSIFICATION. Every node resolves to exactly one of:
//   * `canvas`  — the draw list paints it (textures, atlas regions, nine-patches, solid fills, Range bars,
//                 Line2D strokes);
//   * `overlay` — the node is handed back as an {@link OverlayRecord} for the Wave-2 DOM overlay (text runs,
//                 WebGL-shader surfaces, particle systems, Spine clips, card trails). These are the paints whose
//                 pixels come from somewhere the flat list cannot reach: a glyph rasteriser, a gsw WebGL runtime,
//                 a CPU particle simulation, a baked clip image, a synthesized ribbon.
//                 M2 adds one thing and changes no classification: a shader/particle record
//                 ALSO gets a quad ({@link emitFxQuad}) drawn from the surface the gsw runtime painted, uploaded
//                 as a texture by `fxSurfaces`. The node stays `overlay` — the union oracle the offline gate
//                 asserts is untouched — it simply has pixels in the list as well as a host in the DOM.
//   * `skip`    — invisible or non-painting (a pure transform group, a faded-out node, a `clip_children = Only`
//                 stencil, an ancestor-hidden subtree).
// `canvas ∪ overlay` is exactly the mirror's VISIBLE PAINTING SET, which is what the offline gate asserts against
// the independent `walkResolved` oracle (scripts/verify-canvas-drawlist.mjs).
//
// SPACES. Everything emitted is in DESIGN space (the game's own 1920-based coordinates). Mapping design px to
// device px is the executor's job, exactly as the draw-list header says.
//
// NO RUNTIME DEPENDENCY ON `@godot-scene-web/canvas`. Only its TYPES are imported (erased at build time): the
// caller owns the list and the scratch views, so this module — and `buildDrawList` above it — run unchanged under
// bare Node in the offline gate, where the gsw package is not resolvable. `createPaintScratch` therefore restates
// gsw's `createQuadView` / `createNinePatchView` / `createPolylineView` defaults; `canvasDrawList.spec.ts` pins the
// two against each other field by field, so the restatement cannot drift. (`@godot-scene-web/html`'s
// `SHADER_DORMANT_ATTR` IS a runtime import — one string constant, and one this module already pulls in
// transitively through `shaderAttributes`; the gate's loader stub carries it by name.) `fxSurfaces` is imported
// for TYPES ONLY, deliberately: it is the module that DOES depend on the canvas package at runtime.

import { SHADER_DORMANT_ATTR } from "@godot-scene-web/html";
import type { GlyphsView, NinePatchView, PolylineView, QuadView } from "@godot-scene-web/canvas";

import { affineMul, nodeMatrix, type Affine } from "@/mirror/affine";
import { isCardTrailNode, isCardTrailRootNode, type TrailStrip } from "@/mirror/cardTrail";
import { isSpineSurfaceNode } from "@/mirror/creaturePlaceholder";
import {
  atlasFitAffine,
  clipCornerRadius,
  isNinePatchAtlas,
  nodePaintsContent,
  placementBox,
  rangeFillStyle,
  type RenderItem
} from "@/mirror/nodeStyles";
import { isLineEraser } from "@/mirror/renderer/sharedFlightPolicy";
import { nodeParticleAttributes } from "@/mirror/particleAttributes";
import {
  hsvFilterDefs,
  isShaderInputNode,
  isWebglShaderNode,
  nodeShaderAttributes,
  stretchModeToBackgroundSize
} from "@/mirror/shaderAttributes";
import type { MirrorColor, MirrorNode } from "@/mirror/sceneTree";
import { fxAxisScale } from "@/mirror/canvas/fxPixelRatio";
import { SPINE_KEY_PREFIX } from "@/mirror/canvas/spineSurfaces";
import { TEXT_KEY_PREFIX } from "@/mirror/canvas/textSurfaces";
import { naturalSize } from "@/mirror/textureCache";
import { renderQuality } from "@/render/quality";
import { emitTrailStripQuads } from "@/mirror/canvas/trailQuads";

import type { FxSurface } from "@/mirror/canvas/fxSurfaces";
// TYPE ONLY, AND THAT IS LOAD-BEARING — see `PPEM_FIDELITY_FLOOR`. `import type` is erased entirely, so this
// module still pulls in no glyph renderer and no wasm; only the compiler ever reads it.
import type * as GswGlyphs from "@godot-scene-web/canvas/glyphs";

/** Which of the three buckets a node falls in. See the header. */
export type NodeClass = "canvas" | "overlay" | "skip";

/** Why an `overlay` node is not drawn — i.e. which Wave-2 surface has to render it. */
export type OverlayKind = "text" | "shader" | "particles" | "spine" | "trail";

/**
 * A node the draw list refuses to paint, handed to the Wave-2 DOM overlay.
 *
 * `transform` is the node's PLACEMENT affine (its global composed with its box origin), so the overlay element's
 * `matrix(...)` is this verbatim and `w`/`h` are its CSS box — exactly the shape `nodeStyle` emits today.
 *
 * The record carries the node's COMPOSED PAINT STATE as well as its geometry. It has to: the DOM backend nests a
 * node's element inside its parent's, so `modulate.a` reaches a shader/text/spine surface through the CSS opacity
 * cascade and the composed tint reaches it through an inherited `filter` — neither of which exists for an overlay
 * element, because every overlay element is a FLAT child of one container. A record that carried geometry alone
 * therefore painted a half-faded glow at full strength (`opacity` below) and a tinted label untinted (`tintR/G/B`).
 */
export interface OverlayRecord {
  id: string;
  kind: OverlayKind;
  transform: Affine;
  w: number;
  h: number;
  /** The node's index in the paint order, so the overlay can be depth-sorted against the canvas beneath it. */
  order: number;
  /**
   * Cascaded `modulate.a` × own `self_modulate.a` — the alpha this surface's paint lands at, and the DOM twin of
   * `nodeStyle`'s `opacity` composed down the element nesting (`splitSelfStyle`: container = `modulate.a`, which
   * cascades; self-layer = `self_modulate.a`, which does not).
   */
  opacity: number;
  /** Composed own tint (`childTint × self_modulate.rgb`), linear 0..1 — `nodeStyle`'s `filter: url(#mtint-…)`. */
  tintR: number;
  tintG: number;
  tintB: number;
  /**
   * Does a canvas node painting LATER in paint order overlap this record's box?
   *
   * Filled by `buildDrawList`'s cover pass, not by `overlayRecordFor` (the answer needs the whole walk). It is the
   * single fact the overlay needs to decide whether hoisting this surface above the entire canvas — the only place
   * a DOM overlay above one canvas element CAN put it — would hide game content that belongs on top of it. See
   * `overlay.ts`'s HOIST RULE.
   */
  coveredAbove: boolean;
  /**
   * The DESIGN-space rect this surface must be cropped to (R1), or null when it needs no crop.
   *
   * A canvas command lands inside whatever clip scopes the walk had open at that node; an overlay element is a
   * FLAT child of one container and lands inside none of them, so before this a label inside a scrolled dialog
   * kept painting after it had scrolled out of its own viewport — over the top bar, over everything. This is the
   * enclosing chain's INTERSECTION, resolved once by the walk that already computed the chain, so the overlay has
   * a rect to write `clip-path` from without knowing anything about clip scopes.
   *
   * Null in three cases, and all three mean "write no clip": the lever is off, the node is under no clip scope at
   * all, or the chain's rect already CONTAINS the record's placed box (the common case — most surfaces sit well
   * inside their container). An EMPTY intersection is NOT null: `w`/`h` come back <= 0, which is the "scrolled
   * entirely out of view" answer the overlay renders as a fully-clipped element.
   */
  clip: OverlayClip | null;
}

/**
 * A design-space crop for an overlay surface. See {@link OverlayRecord.clip}.
 *
 * `cornerRadius` is carried only for a chain of exactly ONE scope, because two rounded rects do not intersect
 * into a rounded rect: with two or more scopes the radius is dropped to 0, which UNDER-clips (the corner pixels a
 * rounded clipper would have cut stay visible) rather than cropping something the game shows.
 */
export interface OverlayClip {
  x: number;
  y: number;
  w: number;
  h: number;
  cornerRadius: number;
}

/**
 * One enclosing clip scope, as {@link overlayRecordFor} needs it.
 *
 * Structurally `hitTest.ClipScope`, restated rather than imported: `hitTest` imports this module's `ClipSpec`, and
 * one direction of that dependency is enough.
 */
export interface OverlayClipScope {
  spec: ClipSpec;
}

/** An axis-aligned clip scope in DESIGN space, as `pushClipRect` wants it. */
export interface ClipSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  cornerRadius: number;
  outsetX: number;
}

/** Where `emitNodePaint` pushes. A thin seam so `buildDrawList` owns the list and this module owns the numbers. */
export interface PaintSink {
  quad(view: QuadView, texture: string | null): void;
  ninePatch(view: NinePatchView, texture: string | null): void;
  polyline(view: PolylineView): void;
  /**
   * A run of OUTLINE glyphs — untextured, because the atlas the run's slot ids name belongs to the glyph pass and
   * never to the texture bridge. Optional so that every existing builder (and the offline gate, which has no
   * shaper) satisfies this interface unchanged.
   */
  glyphs?(view: GlyphsView): void;
}

/** Reusable command payloads. One set per builder; every push COPIES, so re-filling them allocates nothing. */
export interface PaintScratch {
  quad: QuadView;
  nine: NinePatchView;
  line: PolylineView;
  /**
   * The glyph-run view. Its `slots` / `positions` are REPLACED per run rather than copied into: the shaper owns
   * those buffers and `pushGlyphs` copies out of whatever the view points at, so aliasing them is both correct
   * and one copy cheaper than the alternative.
   */
  glyphs: GlyphsView;
}

const IDENTITY_MATRIX_2D: readonly number[] = [1, 0, 0, 1, 0, 0];
const IDENTITY_COLOR_MATRIX: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * A fresh scratch set. Field-for-field gsw's `createQuadView()` / `createNinePatchView()` / `createPolylineView()`
 * — restated (not imported) so this module carries no runtime dependency on the package; the spec asserts the two
 * agree on every key and every default.
 */
export function createPaintScratch(pointCapacity = 64): PaintScratch {
  const quad = (): QuadView => ({
    m: Float32Array.from(IDENTITY_MATRIX_2D),
    w: 0,
    h: 0,
    srcX: 0,
    srcY: 0,
    srcW: 0,
    srcH: 0,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    blend: 0,
    flipH: false,
    flipV: false,
    hasColorMatrix: false,
    colorMatrix: Float32Array.from(IDENTITY_COLOR_MATRIX)
  });
  return {
    quad: quad(),
    nine: { ...quad(), marginLeft: 0, marginTop: 0, marginRight: 0, marginBottom: 0 },
    line: { points: new Float32Array(Math.max(1, pointCapacity) * 2), pointCount: 0, width: 1, r: 1, g: 1, b: 1, a: 1 },
    // Field-for-field gsw's `createGlyphsView()`, restated for the reason the three above are — this module
    // carries no RUNTIME dependency on the package. The zero-length buffers are deliberate: `emitTextGlyphs`
    // points them at the shaper's own arrays, so allocating any here would be dead weight on every builder that
    // never draws a glyph (which is every one of them today).
    glyphs: {
      m: Float32Array.from(IDENTITY_MATRIX_2D),
      pixelsPerEm: 16,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
      slots: new Int32Array(0),
      positions: new Float32Array(0),
      glyphCount: 0,
      // `spreadPx` IS WHY THAT SPEC IS A GATE RATHER THAN A TIDINESS TEST. gsw added this field to `GlyphsView`
      // and this literal did not, and the omission does not fail a type check: the ambient `.d.ts` this repo
      // resolves the package through is hand-maintained, so a missing field there and a missing field here agree
      // with each other and disagree only with gsw. `pushGlyphs` then reads `undefined`, a `Float32Array` stores
      // that as NaN, and gsw normalises it back to 0 — i.e. the outline silently disappears and nothing reports
      // it. 0 is the plain fill, which is what every run that does not set one means.
      spreadPx: 0,
      // Unknown is the safe default for a caller that reuses this scratch for a
      // non-glyph command. `emitTextGlyphs` replaces all five fields before a
      // glyph command is pushed; leaving a previous run's ink box here would
      // let a later command inherit an unrelated ink box.
      localInkX: Number.NaN,
      localInkY: Number.NaN,
      localInkWidth: Number.NaN,
      localInkHeight: Number.NaN,
      localInkOutset: Number.NaN
    }
  };
}

/** One node's resolved paint inputs, as the walk composed them. */
export interface NodePaintInput {
  node: MirrorNode;
  /** The node's GLOBAL affine in design space (composed by the walk; see `buildDrawList`). */
  global: Affine;
  /** Cascaded `modulate.a` × own `self_modulate.a` — the alpha the node's OWN paint lands at. */
  ownOpacity: number;
  /** Cascaded `modulate.rgb` × own `self_modulate.rgb` — the node's own paint tint, linear 0..1. */
  tintR: number;
  tintG: number;
  tintB: number;
  /** This node or an ancestor is `visible:false` (or an orphan the renderer holds back). */
  hidden: boolean;
  /** The node's index in the paint order. */
  order: number;
  /** Wide-screen stretched paint width in design px, or 0/undefined for the streamed `localRect.width` (M1a). */
  renderWidthOverride?: number;
  /** R20 one-axis clip outset for this node's scene identity, or undefined (see `clipAxis.ts`). */
  clipAxisOutsetX?: number;
  /** The live node map, for the shader binding's ancestor probe. Optional; only the HSV path reads it. */
  nodes?: Map<string, MirrorNode>;
}

/**
 * Does this node PAINT at all — the predicate `canvas | overlay` membership is decided by.
 *
 * `nodeStyles.nodePaintsContent` plus TWO legs it does not model, both of which the DOM backend paints as
 * mirror-OWNED sub-layers rather than as the node's own background, which is why the content gate never learned
 * about them:
 *   * a `Line2D` map-quill STROKE — no `localRect`, no texture, no text and (for the quill) no shader, yet
 *     `mirrorRenderer.needsOwnEl` gives it an element on exactly the `linePoints != null` signal and paints its
 *     svg;
 *   * a `Range` BAR (`.mirror-range-fill`) — a percentage-wide div the renderer builds for any node carrying a
 *     `range`, whatever else the node draws.
 * Measured across the standard recording set, the second leg adds NOTHING (every visible `Range` node already
 * paints something else), so it costs no divergence from the probes' published counts; it is here so the builder
 * has no fidelity gap rather than because the recordings needed it.
 *
 * The offline gate applies the SAME three-leg predicate, so the builder and the oracle agree by construction.
 */
export function nodeIsPainting(node: MirrorNode, ownOpacity: number): boolean {
  if (nodePaintsContent(node, ownOpacity)) {
    return true;
  }
  return ownOpacity > 0.02 && (hasLineGeometry(node) || hasRangeBar(node));
}

function hasLineGeometry(node: MirrorNode): boolean {
  const points = node.linePoints;
  return points != null && points.length >= 4;
}

/** A `Range` whose bar has non-zero width in a non-zero box — i.e. one that would paint a visible strip. */
function hasRangeBar(node: MirrorNode): boolean {
  const range = node.range;
  const lr = node.localRect;
  return (
    range != null &&
    lr != null &&
    lr.width > 0 &&
    lr.height > 0 &&
    range.max > range.min &&
    range.value > range.min
  );
}

/**
 * Which overlay surface owns this node's pixels, or null when the draw list paints it.
 *
 * Precedence matches `nodePaintsContent`'s own branch order (and the offline probes' `paintSource`), so a node maps
 * to exactly one kind.
 */
export function overlayKindOf(node: MirrorNode): OverlayKind | null {
  if (node.text != null) {
    return "text";
  }
  // The stand-in rides the SPINE surface — the same overlay `<img>` mechanism, in the same node, so the two can
  // never both paint. See `isSpineSurfaceNode`.
  if (isSpineSurfaceNode(node)) {
    return "spine";
  }
  if (node.particleSpec != null) {
    return "particles";
  }
  if (isWebglShaderNode(node)) {
    return "shader";
  }
  if (isCardTrailNode(node) || isCardTrailRootNode(node)) {
    return "trail";
  }
  return null;
}

/** The node's bucket. See the header; `canvas ∪ overlay` is the visible painting set. */
export function classifyNode(node: MirrorNode, ownOpacity: number, hidden: boolean): NodeClass {
  if (hidden || !nodeIsPainting(node, ownOpacity)) {
    return "skip";
  }
  return overlayKindOf(node) === null ? "canvas" : "overlay";
}

/**
 * The overlay record for a node already classified `overlay`, or null when it has no placeable box.
 *
 * `opacity` and the tint are the walk's OWN composed values — the same `input.ownOpacity` / `input.tintR/G/B` that
 * `setQuadColor` premultiplies into a canvas quad. A quad and an overlay surface are the same node's paint landing
 * on two different backends, so they must land at the same alpha; `coveredAbove` starts FALSE and is answered by
 * `buildDrawList`'s cover pass, which is the only place that can see what paints after this node.
 */
export function overlayRecordFor(
  input: NodePaintInput,
  clipChain: readonly OverlayClipScope[] | null = null
): OverlayRecord | null {
  const kind = overlayKindOf(input.node);
  if (kind === null) {
    return null;
  }
  const lr = placementBox(input.node);
  if (!lr) {
    return null;
  }
  const transform = nodeMatrix(input.global, lr);
  const w = input.renderWidthOverride && input.renderWidthOverride > 0 ? input.renderWidthOverride : lr.width;
  return {
    id: input.node.id,
    kind,
    transform,
    w,
    h: lr.height,
    order: input.order,
    opacity: clamp01(input.ownOpacity),
    tintR: clampChannel(input.tintR),
    tintG: clampChannel(input.tintG),
    tintB: clampChannel(input.tintB),
    coveredAbove: false,
    clip: intersectOverlayClip(clipChain, transform, w, lr.height)
  };
}

/**
 * The ENCLOSING chain's intersection as one design-space rect, or null when this surface needs no crop.
 *
 * THE X RULE IS `hitTest.insideClipChain`'S, cited rather than re-invented: a scope's `outsetX` widens BOTH x
 * edges and leaves `y`/`h` exact (`x < s.x - s.outsetX || x > s.x + s.w + s.outsetX`). The two must agree or a tap
 * would land on a surface the paint had cropped away.
 *
 * THE CHAIN IS THE ANCESTORS', not the node's own scope — the same chain `buildHitEntry` is handed for the same
 * node. A node's own `clip_contents` would crop its own ink to its own box, which is the direction that LOSES
 * text when the box is a pixel small (a label's outline and shadow sit outside it, and R20 already had to carve
 * `RichTextLabel` out of the clip rules entirely). Under-clipping is the deliberate bias throughout this fix.
 *
 * `null` when the placed box is already INSIDE the intersection: nothing to crop, no rect to carry, and no style
 * for the overlay to write. That is the overwhelmingly common case, so the walk pays one AABB compare rather than
 * the overlay paying a `clip-path` per element per build.
 */
export function intersectOverlayClip(
  chain: readonly OverlayClipScope[] | null,
  m: Affine,
  w: number,
  h: number
): OverlayClip | null {
  if (chain === null || chain.length === 0) {
    return null;
  }
  let minX = -Infinity;
  let minY = -Infinity;
  let maxX = Infinity;
  let maxY = Infinity;
  for (const scope of chain) {
    const s = scope.spec;
    const x0 = s.x - s.outsetX;
    const x1 = s.x + s.w + s.outsetX;
    if (x0 > minX) minX = x0;
    if (x1 < maxX) maxX = x1;
    if (s.y > minY) minY = s.y;
    const y1 = s.y + s.h;
    if (y1 < maxY) maxY = y1;
  }
  const box = placedAabb(m, w, h);
  if (box.minX >= minX && box.maxX <= maxX && box.minY >= minY && box.maxY <= maxY) {
    return null;
  }
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    // See {@link OverlayClip}: a radius survives only a chain of one.
    cornerRadius: chain.length === 1 ? chain[0].spec.cornerRadius : 0
  };
}

/**
 * The AABB of a node's PLACED BOX in design space, written into `out` at `at` as `minX, minY, maxX, maxY`.
 *
 * The cover pass's geometry (see {@link OverlayRecord.coveredAbove}) and `nodeClipSpec`'s are the same computation
 * — a placement matrix applied to the box's four corners — so they share `placedAabb` rather than restating it.
 * Returns false when the node has no placeable box, which is the "no extent to compare" answer both callers want.
 */
export function placedBoxAabbInto(input: NodePaintInput, out: Float64Array, at: number): boolean {
  const lr = placementBox(input.node);
  if (!lr) {
    return false;
  }
  const w = input.renderWidthOverride && input.renderWidthOverride > 0 ? input.renderWidthOverride : lr.width;
  const box = placedAabb(nodeMatrix(input.global, lr), w, lr.height);
  out[at] = box.minX;
  out[at + 1] = box.minY;
  out[at + 2] = box.maxX;
  out[at + 3] = box.maxY;
  return true;
}

// --- clip scopes ---------------------------------------------------------------------------------------------

/**
 * The clip this node opens over its subtree, or null when it opens none.
 *
 * A restatement of `nodeStyle`'s clip branches in numbers instead of CSS, in the same order and with the same
 * gates: `clip_children` (Only/AndDraw) → the box, rounded to the clipper texture's capsule via
 * `clipCornerRadius`; else `Control.clip_contents` on a positive box → the box, square, with the two R20
 * exceptions (a RichTextLabel is NEVER clipped; a scene identity in the clip-axis table clips the vertical axis
 * only and outsets the horizontal one).
 *
 * APPROXIMATION, named: `ClipRectView` is an axis-aligned design-space rect, so a clipper whose global carries a
 * ROTATION cannot be expressed exactly and gets the placed box's AABB — which is strictly LARGER than the true
 * clip, i.e. it under-clips rather than cropping something the game shows. Every clipper in the recorded set is
 * rotation-free (a layout container or a health-bar mask), where the AABB is exact. `cornerRadius` is likewise
 * scaled by the placement's mean axis length, which is exact for a uniform scale.
 */
export function nodeClipSpec(input: NodePaintInput): ClipSpec | null {
  const node = input.node;
  const lr = node.localRect;
  const renderW = input.renderWidthOverride && input.renderWidthOverride > 0 ? input.renderWidthOverride : lr?.width ?? 0;
  let cornerRadius = 0;
  let outsetX = 0;
  if (node.clipChildren > 0) {
    if (!lr) {
      return null;
    }
    cornerRadius = clipCornerRadius(node, input.renderWidthOverride);
  } else if (node.clipContents && lr && lr.width > 0 && lr.height > 0) {
    if (node.richText) {
      return null; // R20 (1): rich text is never clipped — the readability transform is MEANT to spill.
    }
    if (input.clipAxisOutsetX != null) {
      outsetX = input.clipAxisOutsetX; // R20 (2): vertical axis at the box edge, horizontal outset.
    }
  } else {
    return null;
  }
  if (!lr || !(renderW > 0) || !(lr.height > 0)) {
    return null;
  }
  const m = nodeMatrix(input.global, lr);
  const aabb = placedAabb(m, renderW, lr.height);
  const scale = (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
  return {
    x: aabb.minX,
    y: aabb.minY,
    w: aabb.maxX - aabb.minX,
    h: aabb.maxY - aabb.minY,
    cornerRadius: cornerRadius * scale,
    outsetX: outsetX * scale
  };
}

function placedAabb(m: Affine, w: number, h: number): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    const lx = i === 1 || i === 3 ? w : 0;
    const ly = i >= 2 ? h : 0;
    const px = m[0] * lx + m[2] * ly + m[4];
    const py = m[1] * lx + m[3] * ly + m[5];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return { minX, minY, maxX, maxY };
}

// --- paint ---------------------------------------------------------------------------------------------------

export interface EmitOptions {
  /**
   * Page/image pixel size for a texture url, or null when it is not known yet. Defaults to `textureCache`'s
   * `naturalSize`, which is what the DOM path reads and what `markTextureDirty` re-arms when a load lands.
   */
  textureSize?: (url: string) => { width: number; height: number } | null;
}

/**
 * Push everything the node's OWN paint contributes, in the same back-to-front order the DOM backend layers it:
 * element background (`fill_color`, then the plain-texture / non-atlas nine-patch background), then the paint
 * sub-layers — atlas region, Line2D stroke, nine-patch-over-atlas bands, Range bar. Text is NOT emitted (it is an
 * overlay), and neither is anything else `overlayKindOf` claims.
 *
 * Returns the number of commands pushed.
 */
export function emitNodePaint(
  input: NodePaintInput,
  scratch: PaintScratch,
  sink: PaintSink,
  options: EmitOptions = {}
): number {
  const node = input.node;
  if (overlayKindOf(node) !== null) {
    return 0; // an overlay surface owns these pixels
  }
  const lr = placementBox(node);
  if (!lr || !node.transform) return 0;
  const sizeOf = options.textureSize ?? naturalSize;
  const boxW = input.renderWidthOverride && input.renderWidthOverride > 0 ? input.renderWidthOverride : lr.width;
  const boxM = nodeMatrix(input.global, lr);
  const blend = canvasBlend(node);
  const colorMatrix = hsvColorMatrix(node, input.nodes);
  let pushed = 0;

  // (1) `fill_color` — the element's `background-color`. Suppressed for a shader node exactly as `nodeStyle` does
  //     (its fill is the shader's BASE, painted by the shader surface, not a flat rectangle under it).
  if (node.fillColor && !node.shaderId && node.fillColor.a > 0) {
    fillQuad(scratch.quad, boxM, boxW, lr.height, node.fillColor, input, blend, colorMatrix);
    sink.quad(scratch.quad, null);
    pushed++;
  }

  // (2)-(3) the texture, through the same gate `nodeStyle` paints it behind.
  if (paintsTexture(node)) {
    if (isNinePatchAtlas(node)) {
      pushed += emitNinePatchAtlas(node, scratch.nine, boxM, boxW, lr.height, input, blend, colorMatrix, sink);
    } else if (node.textureRegion) {
      pushed += emitAtlasRegion(node, scratch.quad, input, blend, colorMatrix, sink);
    } else if (node.ninePatch && node.ninePatchMargins) {
      pushed += emitNinePatchWhole(node, scratch.nine, boxM, boxW, lr.height, input, blend, colorMatrix, sizeOf, sink);
    } else if (node.textureUrl) {
      pushed += emitPlainTexture(node, scratch.quad, boxM, boxW, lr.height, input, blend, colorMatrix, sizeOf, sink);
    }
  }

  // (4) a Line2D stroke — the map quill's own geometry, node-local points under the node's placement.
  if (hasLineGeometry(node)) {
    pushed += emitPolyline(node, scratch.line, input, sink);
  }

  // (5) the Range bar (`.mirror-range-fill`): a `pct`-wide, full-height bar at the box origin.
  if (node.range) {
    pushed += emitRangeFill(node, scratch.quad, boxM, boxW, lr.height, input, blend, colorMatrix, sink);
  }

  return pushed;
}

// --- effect surfaces as quads (M2) -------------------------------------------------------------------------------

/** The two overlay kinds an fx quad can paint. `text`/`spine`/`trail` have no gsw surface to upload. */
export const FX_QUAD_KINDS: ReadonlySet<OverlayKind> = new Set<OverlayKind>(["shader", "particles"]);

/**
 * The half of `fxSurfaces.FxSurfaceRegistry` a draw-list build needs — NAME a node and get its surface.
 *
 * ONE method: the surface record carries both halves a quad needs — where the canvas sits and how it blends, and
 * the uploaded texture's PAGE SIZE (`pageW`/`pageH`), which is the source rect. That rect cannot be left at zero:
 * the executor reads a zero-span source as "stretch ONE TEXEL", not "the whole texture", so a quad without it
 * paints a flat smear of the surface's top-left pixel over the whole box. Taking it off the same record as the
 * key is also what keeps a shared texture coherent — since the frame-key sharing, a surface's texture is not
 * always its own node's, and resolving the two through separate lookups could pair one node's key with another's
 * size.
 *
 * Structurally satisfied by the registry itself; written out here so this module depends on one method rather
 * than on that whole module (which imports gsw's canvas package at RUNTIME, and this one must not).
 */
export interface FxQuadSource {
  acquire(nodeId: string, recW: number, recH: number, axisScale?: number): FxSurface | null;
  /** A SCREEN_TEXTURE pass owns its painter index as a command, not a sampled quad. */
  emitScreen?(input: NodePaintInput, record: OverlayRecord): number | "pending";
}

/**
 * Draw an effect surface as a QUAD at the node's own paint index — the whole point of M2.
 *
 * Until this existed, a shader or particle surface rode a DOM overlay ABOVE the entire stage canvas, so anything
 * the game painted over it would have been painted UNDER it instead; `overlay.ts`'s HOIST RULE therefore withheld
 * every covered surface, which on a combat screen is 24 of 26. A quad has no such problem: "above" and "below" are
 * command indices, and this one is pushed from the walk's `overlay` branch, so it lands inside whatever clip scopes
 * are open and inside the node's own command range for free.
 *
 * CALLING `acquire` IS WHAT NAMES THE NODE, and the registry's park guards are built on that: a surface no build
 * names has its dirty bit dropped and stops asking for frames. So this is called for every non-declined fx record
 * even when it will push nothing (no pixels yet, a deferred first upload) — the naming is not conditional on the
 * quad.
 *
 * THE BOX IS THE CANVAS'S, NOT THE NODE'S. gsw places its own canvas: a shader's in PERCENT of the node's
 * self-layer, a particle emitter's in PX with a NEGATIVE travel margin (and a `GpuParticles2D`'s node box is 0x0,
 * so reading the node would produce an empty quad). `FxSurface` carries that box already resolved against the
 * record, so the matrix here is just the record's placement composed with the canvas's own origin.
 *
 * Returns 1 when a quad was pushed, else 0.
 */
export function emitFxQuad(
  input: NodePaintInput,
  record: OverlayRecord,
  scratch: PaintScratch,
  sink: PaintSink,
  fx: FxQuadSource
): number {
  if (!FX_QUAD_KINDS.has(record.kind)) {
    return 0;
  }
  if (!fxHostIsLive(input.node, record.kind, input.nodes)) {
    // The gsw runtime has DROPPED this binding (a dormant ripple, an ineligible material, a particle spec that
    // went null or a hard-off tier). It will draw no more frames, so a quad here would paint that surface's last
    // frame forever — a glow frozen on a card the game stopped glowing. Deliberately NOT acquired either: leaving
    // the node un-named is what lets the registry drop its dirty bit and, eventually, evict its texture.
    return 0;
  }
  // The MEAN-AXIS scale of the affine this quad is about to be drawn through, for the registry's resolution
  // census (`FxSurfaceStats.underResolved`). Rotation-invariant on purpose: the census asks how many device
  // pixels the surface covers along its OWN axes, and a rotated square covers no more of them than an
  // unrotated one — only a wider bounding box, which is what the census used to measure and be wrong about.
  const surface = fx.acquire(record.id, record.w, record.h, fxAxisScale(record.transform));
  if (surface === null) {
    return 0; // no pixels on the GPU yet — no quad at all, rather than a transparent one
  }
  if (!(surface.pageW > 0) || !(surface.pageH > 0)) {
    return 0;
  }
  const view = scratch.quad;
  setQuadMatrix(
    view,
    surface.offsetX === 0 && surface.offsetY === 0
      ? record.transform
      : affineMul(record.transform, [1, 0, 0, 1, surface.offsetX, surface.offsetY])
  );
  view.w = surface.cssW;
  view.h = surface.cssH;
  view.srcX = 0;
  view.srcY = 0;
  view.srcW = surface.pageW;
  view.srcH = surface.pageH;
  view.flipH = false;
  view.flipV = false;
  view.hasColorMatrix = false;
  // PARTICLES ARE ALWAYS MIX, and this is where that is enforced: an additive particle system resolves its own
  // accumulation buffer inside gsw and hands back premultiplied source-over pixels, so re-applying `add` here
  // would double the emitter's own blend. The registry cannot make that call — it does not know a surface's KIND.
  view.blend = (record.kind === "particles" ? 0 : surface.blend) as QuadView["blend"];

  const alpha = clamp01(record.opacity);
  view.a = alpha;
  if (record.kind === "particles") {
    // The DOM twin: `syncHostStyle` writes `opacity` AND the composed-tint `filter` on a particle host, so the
    // surface's pixels are tinted once and faded once. Premultiplied, that is tint x alpha.
    view.r = clampChannel(record.tintR) * alpha;
    view.g = clampChannel(record.tintG) * alpha;
    view.b = clampChannel(record.tintB) * alpha;
  } else {
    // NO TINT for a shader. `mergedNodeStyle`'s rule (and `syncHostStyle`'s): a WebGL host gets no `filter`,
    // because gsw feeds the node's modulate into the shader itself through `data-godot-shader-modulate`. A CSS
    // tint on top would double it, and so would one here.
    //
    // TODO(M3 — fidelity): this RESTATES the DOM twin rather than improving on it, and the twin DOUBLE-APPLIES
    // the node's alpha. gsw folds `modulate.a` into the shader, so the surface's pixels already carry it; the
    // overlay then writes CSS `opacity: record.opacity` over the top, i.e. the effect fades as alpha SQUARED. A
    // faded glow is therefore fainter than the game draws it on both backends. Reproducing it is a deliberate
    // PARITY choice — the canvas arm must not diverge from the DOM arm on a bug the DOM arm has — and it is
    // registered as a divergence-from-the-game rather than a divergence-between-backends. Fixing it means
    // fixing both together (drop the CSS opacity there, drop this multiply here).
    view.r = alpha;
    view.g = alpha;
    view.b = alpha;
  }
  sink.quad(view, surface.key);
  return 1;
}

// --- spine stills as quads (M3 A2) -------------------------------------------------------------------------------

/**
 * A node-local spine still, as the draw list needs it — `overlay.SpineQuadSource` minus the pixel source, which
 * only the registry cares about.
 *
 * Written out here rather than imported so this module keeps depending on nothing that touches the DOM: the box a
 * quad needs is four numbers, and the `<img>` behind them is the overlay's business.
 */
export interface SpineQuadBox {
  clipUrl: string;
  frameW: number;
  frameH: number;
  tx: number;
  ty: number;
  scale: number;
}

/**
 * Draw a spine still as a QUAD at the node's own paint index.
 *
 * WHY, in one measurement. A spine paints EARLY — ranks 41 to 630 on the gated recordings — and 40 to 576 later
 * canvas commands overlap it: HP bars, block outlines, the shop's slot plates and portrait frames. The overlay
 * hoists every spine unconditionally, so an `<img>` above the whole canvas paints all of that UNDER the creature.
 * A quad has no such problem, because "above" and "below" are command indices.
 *
 * THE GEOMETRY MUST EQUAL THE `<img>` EXACTLY, and it does so by construction rather than by re-derivation: the
 * element is `width/height = frame px` with `transform: translate(tx,ty) scale(s)` inside a host carrying
 * `record.transform`, so the quad is that same composition with the same four numbers. The source rect is the
 * WHOLE still — a zero-span source would make the executor stretch one texel over the box.
 *
 * COLOUR is the particles branch of `emitFxQuad`: premultiplied `tint x alpha`, no colour matrix. A spine `<img>`
 * gets the composed tint as a CSS filter and `opacity` on its host, so the two arms fade and tint alike. The blend
 * is the node's own `CanvasItemMaterial` mode, which the hoisted element could not express at all.
 *
 * Returns 1 when a quad was pushed, else 0.
 */
export function emitSpineQuad(
  record: OverlayRecord,
  box: SpineQuadBox,
  node: MirrorNode | undefined,
  scratch: PaintScratch,
  sink: PaintSink
): number {
  if (record.kind !== "spine" || !(box.frameW > 0) || !(box.frameH > 0)) {
    return 0;
  }
  const s = box.scale;
  const view = scratch.quad;
  setQuadMatrix(view, affineMul(record.transform, [s, 0, 0, s, box.tx, box.ty]));
  view.w = box.frameW;
  view.h = box.frameH;
  view.srcX = 0;
  view.srcY = 0;
  view.srcW = box.frameW;
  view.srcH = box.frameH;
  view.flipH = false;
  view.flipV = false;
  view.hasColorMatrix = false;
  view.blend = node ? canvasBlend(node) : (0 as QuadView["blend"]);
  const alpha = clamp01(record.opacity);
  view.a = alpha;
  view.r = clampChannel(record.tintR) * alpha;
  view.g = clampChannel(record.tintG) * alpha;
  view.b = clampChannel(record.tintB) * alpha;
  sink.quad(view, SPINE_KEY_PREFIX + box.clipUrl);
  return 1;
}

// --- text as quads (M4) ------------------------------------------------------------------------------------------

/**
 * One label's rastered texture, as the draw list needs it — `textSurfaces.TextRasterBox` plus the key and the
 * block scale.
 *
 * Written out here rather than imported for the reason {@link SpineQuadBox} is: the box a quad needs is six
 * numbers and a string, and the 2D context that produced them is the registry's business.
 */
export interface TextQuadBox {
  /** The raster digest — the `text://` key's suffix, and the thing that makes two identical labels one upload. */
  digest: string;
  /** The raster's origin and size in the label's own BOX space. */
  dx: number;
  dy: number;
  w: number;
  h: number;
  /** The raster's own device pixels, and WHERE they sit in the texture — the source rect. `(0, 0)` for a label on
   *  a texture of its own; a packed origin for one sharing an atlas page (R6 P6-D2). */
  texW: number;
  texH: number;
  texX: number;
  texY: number;
  /** The `> .mirror-text { transform: scale(N) }` the card rules apply, about the box CENTRE. */
  blockScale: number;
  /** Lines the label broke into. Carried for the parity gate only; no geometry reads it. */
  lines: number;
}

/**
 * The half of the text path a draw-list build needs: NAME a node, get its raster or null.
 *
 * ONE method, and it does the resolving, the laying out and the rastering behind it — unlike the fx and spine
 * seams, which split "is it there" from "how big is it". That asymmetry is deliberate: a label's texture does not
 * exist until this build asks for it, and the digest that would answer "is it there" is only computable from the
 * spec this call already has to build. Splitting it would mean resolving the spec twice.
 *
 * It takes the whole RECORD rather than an id because the raster's SCALE is a function of the record's matrix:
 * a label drawn at 2x on a view-scaled stage needs a 2x raster, and that is the only place the on-screen scale
 * is known.
 */
export interface TextQuadSource {
  boxFor(record: OverlayRecord): TextQuadBox | null;
}

/**
 * THE DEVICE-PIXEL SNAP for label quads — the grid, plus the per-label "is it standing still" question.
 *
 * WHY A LABEL WANTS IT. Getting the raster scale right (see `rasterScaleFor`) makes the blit 1:1 in SIZE; it says
 * nothing about PHASE. A texture landing at x = 401.265 device px samples every texel between two screen pixels,
 * and the executor's `LINEAR` filter spreads each glyph stem across two — the classic "text at a half-pixel
 * offset looks blurry", measured on the live combat frame as 44 of 56 text quads at fractional translations.
 * Rounding the origin to a whole device pixel costs at most half a pixel of placement error, which on a glyph
 * nobody can see, and buys back sharpness, which everybody can.
 *
 * WHY IT NEEDS A REST TEST AT ALL. Snapping is a quantizer, so a label drifting across the grid would step in
 * whole device pixels instead of gliding — judder, in exchange for sharpness nobody can read off a moving card.
 *
 * WHY THE REST TEST IS PER LABEL AND NOT PER FRAME, which is the part that had to be measured rather than
 * assumed. The first attempt gated the whole build on "the tween loop and the idle loops are both idle", on the
 * reasoning that a settled screen is the common case. It is not, in the one place that matters: a live COMBAT
 * always has idle loops running (the energy orb, the enemy intents), so the
 * gate was shut on essentially every frame the reporter would ever read text on. Re-measuring said so: the
 * fractional-translation count barely moved, 44/56 to 38/47.
 *
 * SO REST IS ASKED OF THE LABEL, by the only question that needs no motion plumbing at all: did this node's
 * composed translation come out the same as it did last build? That is ancestor-agnostic by construction — a
 * label moves when anything above it moves, and comparing the composition catches all of it without walking a
 * chain, knowing which loop owns which node, or getting reparenting right. It costs one build of lag at a settle
 * and one at a start, which is the correct direction on both: the frame a label starts moving is unsnapped.
 */
export interface TextSnap {
  /** Design px to DEVICE px — the grid. The same factor the backing store is sized by. */
  perDesignPx: number;
  /**
   * Was this label at exactly this translation on the previous build? MUST be called once per label per build
   * even when the answer is unused, because the implementation records the translation as a side effect.
   */
  atRest(nodeId: string, tx: number, ty: number): boolean;
}

/**
 * Move an affine's TRANSLATION onto the device-pixel grid, leaving its four scale/skew cells untouched.
 *
 * Applied whatever the matrix's rotation. A rotated label's glyph grid does not line up with the screen's at any
 * offset, so the snap neither helps nor harms there, and a rotation test would be a branch that buys nothing.
 */
function snapTranslation(m: Affine, perDesignPx: number): Affine {
  return [
    m[0],
    m[1],
    m[2],
    m[3],
    Math.round(m[4] * perDesignPx) / perDesignPx,
    Math.round(m[5] * perDesignPx) / perDesignPx
  ];
}

/** A matrix cell this far from square, relative to its own axis, is a rotation or a skew rather than rounding. */
const AXIS_ALIGNED_EPS = 1e-4;

/**
 * The quad size that makes the blit EXACTLY 1:1 — one texel per device pixel — or null when it cannot.
 *
 * THE DEFECT THIS EXISTS FOR, which round 9 diagnosed wrongly and had to retract. A label's texture is a whole
 * number of texels (`texW = ceil(ink.w * rasterScale)`) while the quad it is stretched over is the ink's
 * FRACTIONAL design width; the whole texture maps onto the whole quad, so the sampler is permanently squeezing
 * one or two extra texels into the label's width. On the live combat frame that was 31x40 texels drawn into
 * 30.2x39.1 device px, and ZERO of 39 fully-visible labels landed at 1:1.
 *
 * Round 9 called a ~3% mismatch invisible and shipped. It is not, because the executor samples `LINEAR` for both
 * min and mag with no mipmaps: at any ratio other than 1 the sampling PHASE drifts across the label, so most
 * output pixels are a blend of two texels — a uniform softening with no fringe to give it away. Measured through
 * gsw's own sampler settings, the fully-bright share of ink falls 0.398 -> 0.213 between ratio 1.000 and 1.005.
 * Half a percent off already halves it. "Close to 1" is not 1, and the reporter could see the difference the
 * measurement said was not there.
 *
 * So the quad is sized from the TEXTURE instead: at `texW / (axis * perDesignPx)` design units the drawn device
 * width is exactly `texW`, and texel k lands on device pixel k. Note this does NOT stretch the glyphs by the
 * `ceil` remainder — those spare sub-texel columns are transparent padding beyond the ink, so the ink is drawn at
 * exactly the size it was rastered at. What remains is the gap between the raster scale and the true on-screen
 * scale, which is the raster STEP's business (see `rasterScaleFor`), not the blit's.
 *
 * REFUSED CASES, each of which keeps today's geometry rather than branching on a fiction:
 * - rotated or skewed: the glyph grid does not line up with the screen's at any size, so there is nothing to land
 *   on and the whole idea is void;
 * - non-uniformly scaled: the raster scale is ONE scalar, so a texture sized at the mean would be drawn at the
 *   mean on both axes — that would distort the label to buy sharpness, which is a bad trade;
 * - a degenerate axis or no grid: nothing to divide by.
 */
function exactBlitSize(m: Affine, box: TextQuadBox, perDesignPx: number): { w: number; h: number } | null {
  const axisX = Math.hypot(m[0], m[1]);
  const axisY = Math.hypot(m[2], m[3]);
  if (!(axisX > 0) || !(axisY > 0)) {
    return null;
  }
  if (Math.abs(m[1]) > AXIS_ALIGNED_EPS * axisX || Math.abs(m[2]) > AXIS_ALIGNED_EPS * axisY) {
    return null;
  }
  if (Math.abs(axisX - axisY) > AXIS_ALIGNED_EPS * axisX) {
    return null;
  }
  return { w: box.texW / (axisX * perDesignPx), h: box.texH / (axisY * perDesignPx) };
}

/**
 * Draw a rastered label as a QUAD at the node's own paint index — M4's whole point.
 *
 * WHY, in one measurement. Probe P6 counted, per recording, the visible nodes painting LATER than a text node
 * whose box they cover: 7% on the map, 32-46% on combat/shop/reward, and 70-73% on deck view and reshuffle, where
 * it is almost entirely cards — `NCardHighlight`'s glow and the card's own plates, which the game paints OVER the
 * card's text and the DOM overlay paints UNDER it. A quad has no such problem, because "above" and "below" are
 * command indices. It also ends the 17 batch breaks a combat screen pays for text→atlas→text churn.
 *
 * THE GEOMETRY IS THE DOM'S, COMPOSED RATHER THAN RE-DERIVED. The element is a `.mirror-text` box carrying the
 * scale rules' `transform: scale(N)` with `transform-origin: 50% 50%`, inside a host carrying `record.transform`,
 * with the ink laid out at `(dx, dy)` inside it. So the quad's matrix is exactly that composition:
 *
 *     record.transform  ·  scale(N) about the box centre  ·  translate(dx, dy)
 *
 * and the box centre is the RECORD's own `w`/`h` — the placement box, `renderWidthOverride` included — because
 * that is the box CSS resolves `50%` against. Nothing here re-derives a placement.
 *
 * COLOUR is `emitSpineQuad`'s: premultiplied `tint × alpha`, no colour matrix. The raster bakes the label's own
 * fill, outline and shadow COLOURS but never its node tint or opacity, so a fading label reuses one texture and
 * fades through the quad — which is what keeps a fade from minting a texture per frame.
 *
 * Returns 1 when a quad was pushed, else 0.
 */
export function emitTextQuad(
  record: OverlayRecord,
  box: TextQuadBox,
  node: MirrorNode | undefined,
  scratch: PaintScratch,
  sink: PaintSink,
  snap: TextSnap | null = null
): number {
  if (record.kind !== "text" || !(box.w > 0) || !(box.h > 0) || !(box.texW > 0) || !(box.texH > 0)) {
    return 0;
  }
  const s = box.blockScale;
  // `transform-origin: 50% 50%` as an affine: translate to the centre, scale, translate back — which collapses to
  // a uniform scale with a `c(1 - s)` offset on each axis. At `s === 1` that offset is 0 and this is identity,
  // so an unscaled label composes exactly `record.transform · translate(dx, dy)`.
  const cx = record.w / 2;
  const cy = record.h / 2;
  const inner = affineMul([s, 0, 0, s, cx * (1 - s), cy * (1 - s)], [1, 0, 0, 1, box.dx, box.dy]);
  const composed = affineMul(record.transform, inner);
  // The rest test runs FIRST and unconditionally, so its recording side effect happens even on a frame that can
  // do nothing with the answer. Skipping it when the grid is off would make the next build think a label that had
  // been standing still had just moved.
  const rest = snap !== null && snap.atRest(record.id, composed[4], composed[5]);
  // ONE gate for both halves of the 1:1 blit, because they are one thing: the snap puts the texture's origin on a
  // whole device pixel and the size puts its far edge on one. Either alone still lands texels between pixels.
  const grid = rest && snap !== null && snap.perDesignPx > 0 ? snap.perDesignPx : 0;
  const view = scratch.quad;
  setQuadMatrix(view, grid > 0 ? snapTranslation(composed, grid) : composed);
  const exact = grid > 0 ? exactBlitSize(composed, box, grid) : null;
  view.w = exact ? exact.w : box.w;
  view.h = exact ? exact.h : box.h;
  // The raster's own rect within whatever texture answers for it — its whole extent when it owns the texture, and
  // its packed sub-rect when it shares an atlas page. A zero-SPAN source rect would make the executor stretch one
  // texel over the box rather than sample the texture (the trap `emitSpineQuad` names), which the guard above
  // refuses; a zero ORIGIN is just the top-left corner and is the ordinary unpacked case.
  view.srcX = box.texX;
  view.srcY = box.texY;
  view.srcW = box.texW;
  view.srcH = box.texH;
  view.flipH = false;
  view.flipV = false;
  view.hasColorMatrix = false;
  view.blend = node ? canvasBlend(node) : (0 as QuadView["blend"]);
  const alpha = clamp01(record.opacity);
  view.a = alpha;
  view.r = clampChannel(record.tintR) * alpha;
  view.g = clampChannel(record.tintG) * alpha;
  view.b = clampChannel(record.tintB) * alpha;
  sink.quad(view, TEXT_KEY_PREFIX + box.digest);
  return 1;
}

// --- text as GLYPH RUNS ------------------------------------------------------------------------------------------

/**
 * ONE LABEL'S SHAPED RUNS, in flat buffers the SHAPER owns — the glyph twin of {@link TextQuadBox}.
 *
 * Written out here rather than imported for the same reason that one is: what a command needs is numbers, and the
 * wasm that produced them is the registry's business. Structurally identical to `glyphPass.GlyphBlock`, which is
 * what lets this module keep having no runtime dependency on a shaper, a font or a GL context.
 *
 * VALID FOR THE DURATION OF THE CALL ONLY — the registry pools it and refills it for the next label.
 */
export interface TextGlyphBlock {
  runCount: number;
  /** Per run: the pen origin in the label's BOX space — a line's left edge, on its baseline. */
  origins: Float32Array;
  /** Per run: `[start, count]` into `slots` / `positions`. A shadow run and its fill run SHARE a span. */
  spans: Int32Array;
  /** Per run: STRAIGHT `r, g, b, a` in 0..1. Premultiplied HERE and nowhere else — see below. */
  colors: Float32Array;
  /**
   * Per run: how far to dilate the glyphs outward, in the run's own units. `0` is a plain fill.
   *
   * PER RUN AND NOT PER LABEL, because that IS the outline: an outlined label is the same glyphs and the same
   * pens recorded twice, once in the outline colour with a spread and once in the fill colour without. One
   * number per label could not say which of the two a given run is.
   */
  spreads: Float32Array;
  slots: Int32Array;
  positions: Float32Array;
  pixelsPerEm: number;
  /** The `> .mirror-text { transform: scale(N) }` the card rules apply, about the box CENTRE. */
  blockScale: number;
}

/** The half of the glyph path a draw-list build needs: NAME a node, get its shaped runs or null. */
export interface TextGlyphSource {
  blockFor(record: OverlayRecord): TextGlyphBlock | "pending" | null;
  /**
   * Rich labels need an ordered mixture of glyph runs and image quads.  The
   * builder owns the painter position and supplies its live sink, while the
   * renderer-owned source owns font/image readiness.  `pending` deliberately
   * paints nothing: strict canvas admission will defer the entire frame rather
   * than mounting a DOM label for one cold resource.
   */
  emitRich?(
    input: NodePaintInput,
    record: OverlayRecord,
    scratch: PaintScratch,
    sink: PaintSink
  ): number | "pending";
}

/** Translate every pass of a shaped rich fragment without collapsing a shadow's relative offset. */
export function translateTextGlyphBlock(block: TextGlyphBlock, dx: number, dy: number): void {
  for (let i = 0; i < block.runCount; i++) {
    block.origins[i * 2] += dx;
    block.origins[i * 2 + 1] += dy;
  }
}

/**
 * The ppem below which HarfBuzz's coverage shader takes its five-tap branch.
 *
 * RESTATED, NOT IMPORTED, and the import is the tempting wrong answer. gsw's own `PPEM_FIDELITY_FLOOR` lives in
 * `@godot-scene-web/canvas/glyphs`, which gsw keeps OFF its barrel on purpose so that a scene with no text does
 * not pull a glyph renderer and a multi-MiB wasm into the bundle — and this module is imported by everything,
 * including `scripts/verify-canvas-drawlist.mjs`, which has no GL and no wasm and must keep having none. So the
 * number is written here — and pinned to gsw's by {@link PPEM_FLOOR_MATCHES_GSW}, a TYPE-ONLY check that is
 * erased before a byte of it can be imported.
 */
export const PPEM_FIDELITY_FLOOR = 16;

/**
 * The pin: gsw declares `PPEM_FIDELITY_FLOOR` with the LITERAL type `16`, so this assignment stops compiling the
 * day the two diverge. A restated constant that nothing checks is a constant that silently goes stale, and this
 * one decides whether a census reports a screen's text as crisp.
 */
const PPEM_FLOOR_MATCHES_GSW: typeof GswGlyphs.PPEM_FIDELITY_FLOOR = PPEM_FIDELITY_FLOOR;
void PPEM_FLOOR_MATCHES_GSW;

/**
 * THE HONESTY PROBE for the fidelity floor: asked about every run this module actually emits.
 *
 * WHY IT IS HERE AND NOT IN THE GLYPH PASS. `glyphPass.blockFor` already computes a `devicePpem`, but the current
 * renderer deliberately keeps a label on one path through its animation. This census makes the resulting
 * low-ppem coverage visible: it answers how much of the screen uses a blurrier approximation than the raster
 * path would.
 *
 * THE ARITHMETIC IS THE COMPOSED MATRIX'S, and that is the whole content of the measurement. `m` is
 * `record.transform · scale(blockScale)`, so its mean axis carries the entire ancestor chain and the card rules'
 * block scale together; times the stage's design-to-device factor that is the ppem the fragment shader is really
 * asked for.
 * (`spec.fontPx * spec.blockScale * deviceScale`), and the same one gsw's `HbGpuGlyphPass` reads back out of
 * `run.m` for its `runsBelowPpemFloor`. The two counts are still not the same number: gsw's ticks per run per
 * DRAW and this one per run per BUILD, so only this one is comparable to `DrawListStats.textGlyphRuns`.
 */
export interface GlyphFloorProbe {
  /**
   * Design px -> DEVICE px for the stage: the fit-to-screen scale times the device pixel ratio.
   *
   * A getter rather than a number because a build may straddle a resize, exactly as `TextSnap.perDesignPx` is.
   */
  readonly perDesignPx: number;
  /** One call per emitted run whose device ppem lands under {@link PPEM_FIDELITY_FLOOR}. */
  below(nodeId: string, devicePpem: number): void;
}

/** What {@link createGlyphFloorCensus} needs from a renderer, and the whole of what it needs. */
export interface GlyphFloorCensusOptions {
  /** The stage's live design-to-device factor. Read per run, so a resize mid-session is followed. */
  perDesignPx: () => number;
  /**
   * A human place for the FIRST offender — a scene file and node path, ideally. Called at most ONCE per session,
   * so it may do the ancestor walk a scene resolve costs.
   */
  describe: (nodeId: string) => string;
  /** Overridable for the spec. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/** A census's live count, and the probe that feeds it. */
export interface GlyphFloorCensus {
  readonly probe: GlyphFloorProbe;
  /** Runs counted since the page loaded — CUMULATIVE, for the reason `GlyphPassStats.labels` is. */
  readonly runs: number;
}

/**
 * COUNT the runs under the floor, and say so ONCE.
 *
 * ONE WARNING PER SESSION, NAMING A NODE. "Some of this screen's text is small" is not actionable and a warning
 * per run would be one per label per build — a console nobody can read, on precisely the screen that needs
 * reading. One line naming the first offender's scene path and its measured ppem is a thing an agent can go and
 * look at; the tally is what the census is for.
 *
 * Lives here rather than in the renderer because it is pure — a counter, a latch and a string — and because the
 * warning's WORDING is part of the deliverable: it has to say what the number means and what to do about it, and
 * that is a claim a spec should be able to hold.
 */
export function createGlyphFloorCensus(options: GlyphFloorCensusOptions): GlyphFloorCensus {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let runs = 0;
  let warned = false;
  const probe: GlyphFloorProbe = {
    get perDesignPx() {
      return options.perDesignPx();
    },
    below(nodeId, devicePpem) {
      runs++;
      if (warned) {
        return;
      }
      warned = true;
      warn(
        `[mirror] glyph run under the ppem-${PPEM_FIDELITY_FLOOR} fidelity floor: ${options.describe(nodeId)} ` +
          `(id ${nodeId}) at ppem ${devicePpem.toFixed(2)} — hb-gpu's coverage shader approximates below the ` +
          `floor, so this label uses the lower-fidelity glyph approximation. Counted in ` +
          `__mirrorCanvasStats().textGlyphs.belowFloorTrue; printed once per session.`
      );
    }
  };
  return {
    probe,
    get runs() {
      return runs;
    }
  };
}

/**
 * Draw a label as OUTLINE GLYPH RUNS at the node's own paint index — the glyph twin of {@link emitTextQuad}, and
 * the same geometry argument term for term.
 *
 * THE MATRIX IS THE RASTER PATH'S, with one substitution. A raster is one quad at the ink box's origin:
 *
 *     record.transform · scale(N) about the box centre · translate(inkDx, inkDy)
 *
 * A glyph run is the same composition with the LINE's pen origin in place of the ink box's, because pen positions
 * are measured from the baseline the shaper laid the line on. Everything else — the `transform-origin: 50% 50%`
 * collapse, the record's own placement box — is identical, which is what makes the two paths land in the same
 * place rather than merely near each other.
 *
 * NO DEVICE-PIXEL SNAP, and its absence is a FEATURE rather than an omission. `TextSnap` exists because a raster
 * is a texture: landing it off the grid samples every texel between two screen pixels and the executor's LINEAR
 * filter smears each stem across both. An outline has no texels — coverage is evaluated per fragment at whatever
 * sub-pixel phase the frame asks for — so there is nothing to quantise, and quantising anyway would only add the
 * judder the snap's rest test was written to avoid.
 *
 * COLOUR IS PREMULTIPLIED HERE, ONCE. The run carries the LABEL's own fill (which the raster path bakes into its
 * texture instead) times the node's tint and opacity (which the raster path puts on the quad). gsw's fragment
 * multiplies coverage by this colour exactly once and the stage's context is `premultipliedAlpha: true`, so a
 * second multiplication anywhere would show up not as a fringe but as text that is merely darker.
 *
 * NO `node` PARAMETER, unlike every other emitter here, and the omission is the contract: the glyph command
 * carries no blend mode at all (gsw's `GlyphsView` has no such field), so a label under a non-MIX material is not
 * expressible on this path and would draw as MIX. Nothing in the corpus puts one there; taking the node in order
 * to ignore it would only make that look decided rather than absent.
 *
 * `floor` IS DIAGNOSTIC ONLY and changes not one pixel: it is asked about each run AFTER the run is composed and
 * never decides whether one is pushed. See {@link GlyphFloorProbe} for why the question can only be answered from
 * inside this loop.
 *
 * Returns the number of runs pushed.
 */
export function emitTextGlyphs(
  record: OverlayRecord,
  block: TextGlyphBlock,
  scratch: PaintScratch,
  sink: PaintSink,
  floor: GlyphFloorProbe | null = null
): number {
  if (record.kind !== "text" || block.runCount <= 0 || sink.glyphs === undefined) {
    return 0;
  }
  const s = block.blockScale;
  const cx = record.w / 2;
  const cy = record.h / 2;
  const view = scratch.glyphs;
  view.pixelsPerEm = block.pixelsPerEm;
  // ALIASED, NOT COPIED. `pushGlyphs` copies `slots[0..count)` and `positions[0..2*count)` out of the view into
  // the list's arenas, so pointing the view at the shaper's buffers is exactly as safe as copying into a private
  // pair first — and a copy per run of what is already a per-run copy is the kind of cost this walk exists to
  // avoid. The OFFSET is folded in with `subarray`, whose view shares the same storage.
  const alpha = clamp01(record.opacity);
  const tintR = clampChannel(record.tintR);
  const tintG = clampChannel(record.tintG);
  const tintB = clampChannel(record.tintB);
  let pushed = 0;
  for (let i = 0; i < block.runCount; i++) {
    const count = block.spans[i * 2 + 1];
    if (count <= 0) {
      continue;
    }
    const start = block.spans[i * 2];
    const inner = affineMul([s, 0, 0, s, cx * (1 - s), cy * (1 - s)], [1, 0, 0, 1, block.origins[i * 2], block.origins[i * 2 + 1]]);
    const composed = affineMul(record.transform, inner);
    view.m[0] = composed[0];
    view.m[1] = composed[1];
    view.m[2] = composed[2];
    view.m[3] = composed[3];
    view.m[4] = composed[4];
    view.m[5] = composed[5];
    view.slots = block.slots.subarray(start, start + count);
    view.positions = block.positions.subarray(start * 2, (start + count) * 2);
    view.glyphCount = count;
    // The shaper intentionally owns only slots and pen positions. It does not
    // expose every glyph outline's local extrema, so the label box is the
    // conservative bound available at this integration boundary. It is still
    // substantially safer than the former implicit `undefined` (serialized as
    // NaN), which forced every retained patch containing text down the unknown
    // path. The run's spread and the one-pixel replay raster outset cover the
    // stroke/AA reach; a shadow remains inside this full label box by design.
    view.localInkX = 0;
    view.localInkY = 0;
    view.localInkWidth = record.w;
    view.localInkHeight = record.h;
    // GSW adds `spreadPx` itself when deriving command damage. This field is
    // only the remaining AA/filter reach; repeating spread here would make
    // damage planning twice as broad as the actual command.
    view.localInkOutset = 1;
    // WRITTEN EVERY RUN, INCLUDING THE 0, and for the same reason gsw's pass re-states it every draw: this is a
    // POOLED view, so a run recorded without a spread after one recorded with a spread would inherit it and draw
    // fat. An outline run and its fill run differ in exactly these two fields (this and the colour), so leaving
    // either stale is a label drawn in the wrong weight rather than an error.
    view.spreadPx = block.spreads[i];
    const runAlpha = alpha * clamp01(block.colors[i * 4 + 3]);
    view.a = runAlpha;
    view.r = clampChannel(block.colors[i * 4]) * tintR * runAlpha;
    view.g = clampChannel(block.colors[i * 4 + 1]) * tintG * runAlpha;
    view.b = clampChannel(block.colors[i * 4 + 2]) * tintB * runAlpha;
    sink.glyphs(view);
    pushed++;
    if (floor !== null) {
      // THE MEAN AXIS OF THE COMPOSED MATRIX, not of `record.transform`: `composed` already carries the whole
      // ancestor chain AND `blockScale`, which is exactly what gsw's own counter is missing. Mean of the two
      // column lengths rather than a determinant, because a run under a NON-uniform scale is drawn at neither
      // axis alone and the shader's coverage cost follows the average — the same mean `glyphSource` takes when it
      // hands `blockFor` its `deviceScale`.
      const axis = (Math.hypot(composed[0], composed[1]) + Math.hypot(composed[2], composed[3])) / 2;
      const devicePpem = view.pixelsPerEm * axis * floor.perDesignPx;
      // `!(x >= floor)` rather than `x < floor`, so a NaN axis (a degenerate matrix) reports as below rather than
      // silently as fine. A run nobody can measure is not a run anybody should call crisp.
      if (!(devicePpem >= PPEM_FIDELITY_FLOOR)) {
        floor.below(record.id, devicePpem);
      }
    }
  }
  return pushed;
}

// --- card trails as quad strips (M3 A4) --------------------------------------------------------------------------

/**
 * The half of `cardTrailState.CardTrailState` a draw-list build needs: the strip for one stroke, and the blend it
 * is drawn with.
 *
 * Written out here rather than imported for the reason `FxQuadSource` is: this module must stay free of anything
 * that touches the DOM or the scene, and a strip is a list of six-number matrices.
 */
export interface TrailQuadSource {
  stripFor(nodeId: string): TrailStrip | null;
  /**
   * Strict-only proof that this semantic stroke has no current ribbon pixels.
   * The answer must describe the exact same cached strip `stripFor` will
   * return during this synchronous build; it is never a loading fallback.
   */
  isProvablySilent?(nodeId: string): boolean;
  /** The page a TEXTURED strip samples — asked after `stripFor`, which is what resolves it. Null = banded. */
  textureFor(nodeId: string): { url: string; width: number; height: number } | null;
  blendFor(nodeId: string): 0 | 1;
}

/**
 * Draw a card trail's ribbon as a run of QUADS at the trail node's own paint index.
 *
 * WHY THERE IS ANYTHING TO DO HERE AT ALL. A trail carries no wire geometry — the producer deliberately drops the
 * two strokes' points (see `cardTrail.ts`) — so the ribbon is integrated client-side and reaches the walk as a
 * {@link TrailStrip} rather than as anything on the node. Until this existed the canvas backend classified the
 * node `overlay` and the overlay dropped it, so a played card flew with no comet behind it.
 *
 * THE STRIP IS IN THE STROKE'S OWN LOCAL SPACE, and `input.global` is what puts it on the stage — the same
 * composition `emitPolyline` uses for a map stroke's node-local points. That is what makes the wide-screen spread
 * and the view scale free: whatever moves the node moves its ribbon, because the ribbon is drawn THROUGH the
 * node's placement rather than beside it. (`input.global`, not `record.transform`: the record's matrix folds the
 * placement box's origin in, and a trail's points are measured against the node's global, not against its box.)
 *
 * COLOUR is the same premultiplied `tint × alpha` every other quad here uses, with the strip's own per-cell alpha
 * as the fourth factor — Godot's `gradient × texture × default_color` with the ramp already folded in by
 * `buildTrailStrip`.
 *
 * THE TEXTURE (R5 T-DR1). The authored page is pure white with a soft falloff ACROSS the ribbon and nothing
 * along it, and the executor's `texel × premultiplied colour` is exactly the missing factor of Godot's
 * `texture × gradient × default_color × modulate`. So a textured strip's cell takes the WHOLE PAGE as its source
 * rect: `v` already runs edge to edge across the ribbon, and `u` samples a constant column whatever the cell's
 * length. The source span is EXPLICIT and must be — a zero span does NOT mean "the whole texture" here, it means
 * "stretch one texel", which is what an untextured fill wants and what would flatten a comet into a bar.
 *
 * `strip.textured` and `textureFor` come from the same decision and cannot disagree: a strip is only built
 * full-width once its page is READY, because an unready url pushes an INVISIBLE quad and a hopeful strip would
 * blank the comet for the length of the load. The banded fallback is not a degraded mode, it is the pre-R5 shape.
 *
 * Returns the number of quads pushed.
 */
export function emitTrailQuads(
  input: NodePaintInput,
  record: OverlayRecord,
  scratch: PaintScratch,
  sink: PaintSink,
  trail: TrailQuadSource
): number {
  if (record.kind !== "trail") {
    return 0;
  }
  const strip = trail.stripFor(record.id);
  if (strip === null || strip.quads.length === 0) {
    return 0;
  }
  // AFTER `stripFor`, which is what resolves it. A strip that says `textured` always has one.
  const texture = strip.textured ? trail.textureFor(record.id) : null;
  return emitTrailStripQuads(
    {
      strip,
      global: input.global,
      tintR: input.tintR,
      tintG: input.tintG,
      tintB: input.tintB,
      opacity: input.ownOpacity,
      blend: trail.blendFor(record.id),
      texture: texture === null ? null : { key: texture.url, width: texture.width, height: texture.height }
    },
    scratch.quad,
    sink
  );
}

/**
 * Is there still a LIVE gsw binding behind this node — i.e. will a runtime keep repainting the surface?
 *
 * The same two builders `overlay.ts` stamps its host from, asked the same way. Both are memoized per node/spec, so
 * this second call inside a build is a map hit rather than a rebuild.
 *
 * `SHADER_DORMANT_ATTR` is gsw's OWN park contract (a resting low-HP flash, a ripple below its epsilon, a settled
 * transition), which the mirror drives on both backends; a parked host draws nothing new, so the fx path treats it
 * exactly like a dropped binding.
 */
export function fxHostIsLive(node: MirrorNode, kind: OverlayKind, nodes?: Map<string, MirrorNode>): boolean {
  if (kind === "particles") {
    return nodeParticleAttributes(node) !== null;
  }
  const binding = nodeShaderAttributes(node, nodes);
  return binding !== null && binding.attributes[SHADER_DORMANT_ATTR] === undefined;
}

/**
 * A strict stage may claim a shader record without a command only when gsw's
 * own dormant binding proves it produces no pixels. This deliberately does
 * not generalize a declined/unsupported host into a no-op.
 */
export function fxHostIsProvablySilent(node: MirrorNode, kind: OverlayKind, nodes?: Map<string, MirrorNode>): boolean {
  if (kind !== "shader") return false;
  const binding = nodeShaderAttributes(node, nodes);
  return binding !== null && binding.attributes[SHADER_DORMANT_ATTR] !== undefined;
}

/**
 * `nodeStyle`'s `paintsTexture` gate, restated over the same predicates.
 *
 * THE SHADERS-OFF LEG IS LOAD-BEARING and was missing here until it was caught on screen. `isWebglShaderNode`
 * answers FALSE on the shaders-disabled tier (that is its documented behaviour: "the node's raw paint is
 * suppressed instead"), so without the second test a shader node stops being an overlay AND starts painting its
 * own texture as a plain quad. That texture is shader INPUT — an SDF field, not a picture — and the result was
 * every card's `NCardHighlight` glow rendering as an opaque cyan rectangle behind the hand, exactly the "gray
 * blob" `isShaderInputNode` exists to prevent. `nodeStyles.nodePaintsContent` has carried this leg all along;
 * this is the same rule, not a new one.
 */
function paintsTexture(node: MirrorNode): boolean {
  if (!node.textureUrl || node.clipChildren === 1 || isWebglShaderNode(node) || node.particleSpec != null) {
    return false;
  }
  return renderQuality().shadersEnabled || !isShaderInputNode(node);
}

/** Godot `CanvasItem.BlendMode` IS the draw list's `BlendMode` (0 Mix / 1 Add / 2 Sub / 3 Mul) — no mapping. */
function canvasBlend(node: MirrorNode): QuadView["blend"] {
  const mode = node.canvasBlendMode;
  return (mode === 1 || mode === 2 || mode === 3 ? mode : 0) as QuadView["blend"];
}

/**
 * The node's own HSV color transform as a row-major 3x3, or null.
 *
 * Resolved THROUGH `shaderAttributes` rather than beside it: `nodeShaderAttributes` is what decides an HSV node
 * renders as a colour transform at all (and refuses when the matrix is identity, near-black, or the node sits under
 * an energy counter whose particle VFX compensate), and it registers the matrix in the `mhsv-N` filter table on the
 * way past. Reading it back out of that table is what keeps the canvas stage and the DOM stage on ONE decision —
 * the alternative is a second copy of those three vetoes, which is exactly the drift this repo keeps paying for.
 *
 * The registry's value string is gsw's `colorMatrixFeValues`: 20 numbers, row-major over 4 rows of 5, so the linear
 * RGB part is at 0,1,2 / 5,6,7 / 10,11,12.
 */
export function hsvColorMatrix(node: MirrorNode, nodes?: Map<string, MirrorNode>): Float32Array | null {
  if (node.shaderId == null) {
    return null;
  }
  const binding = nodeShaderAttributes(node, nodes);
  const filter = binding?.style?.filter;
  if (!filter) {
    return null;
  }
  const match = /url\(#(mhsv-\d+)\)/.exec(filter);
  if (!match) {
    return null;
  }
  for (const def of hsvFilterDefs()) {
    if (def.id !== match[1]) {
      continue;
    }
    const v = def.values.trim().split(/\s+/).map(Number);
    if (v.length < 13 || v.some((n) => !Number.isFinite(n))) {
      return null;
    }
    return Float32Array.from([v[0], v[1], v[2], v[5], v[6], v[7], v[10], v[11], v[12]]);
  }
  return null;
}

/** Fill a quad's colour: the composed tint × a paint colour, PREMULTIPLIED by the composed alpha. */
function setQuadColor(
  view: QuadView,
  input: NodePaintInput,
  r: number,
  g: number,
  b: number,
  a: number,
  blend: QuadView["blend"],
  colorMatrix: Float32Array | null
): void {
  const alpha = clamp01(input.ownOpacity * a);
  view.r = clampChannel(input.tintR * r) * alpha;
  view.g = clampChannel(input.tintG * g) * alpha;
  view.b = clampChannel(input.tintB * b) * alpha;
  view.a = alpha;
  view.blend = blend;
  view.flipH = false;
  view.flipV = false;
  if (colorMatrix) {
    view.colorMatrix.set(colorMatrix);
    view.hasColorMatrix = true;
  } else {
    view.hasColorMatrix = false;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A modulate may exceed 1 (Godot over-brightens); clamp only the negative side, as the SVG tint filter does. */
function clampChannel(v: number): number {
  return v < 0 ? 0 : v;
}

function setQuadMatrix(view: QuadView, m: Affine): void {
  view.m[0] = m[0];
  view.m[1] = m[1];
  view.m[2] = m[2];
  view.m[3] = m[3];
  view.m[4] = m[4];
  view.m[5] = m[5];
}

function fillQuad(
  view: QuadView,
  boxM: Affine,
  w: number,
  h: number,
  color: MirrorColor,
  input: NodePaintInput,
  blend: QuadView["blend"],
  colorMatrix: Float32Array | null
): void {
  setQuadMatrix(view, boxM);
  view.w = w;
  view.h = h;
  view.srcX = 0;
  view.srcY = 0;
  view.srcW = 0;
  view.srcH = 0;
  setQuadColor(view, input, color.r, color.g, color.b, color.a, blend, colorMatrix);
}

/**
 * A LEAF `AtlasTexture` sprite: the Control's stretch / keep-aspect fit of an atlas REGION into its box.
 *
 * The geometry comes from `nodeStyles.atlasFitAffine` verbatim — the numeric core the CSS twin stringifies — with
 * `hasChildren: false` because a draw-list quad is standalone: the DOM path only has an "interior" variant
 * (`atlasCanvasFit`) because a leaf's baked fit would otherwise cascade onto DOM-nested children, and a quad has no
 * children to cascade onto. `atlasCanvasFit` produces the same numbers in element-local space; the spec pins that.
 */
function emitAtlasRegion(
  node: MirrorNode,
  view: QuadView,
  input: NodePaintInput,
  blend: QuadView["blend"],
  colorMatrix: Float32Array | null,
  sink: PaintSink
): number {
  const item: RenderItem = { node, opacity: input.ownOpacity, tintId: null, parentInv: null, hasChildren: false };
  const fit = atlasFitAffine(item, input.global, node.localRect, false);
  const region = node.textureRegion;
  if (!fit || !region || !node.textureUrl) {
    return 0;
  }
  // `fit.m` places the region's ORIGIN and `fit.sx/sy` scale it; fold the scale in so the quad's local box is the
  // plain [0,w]x[0,h] the draw list expects. A flipped axis arrives as a NEGATIVE scale (with the origin already
  // moved to the far edge) — normalise that into the command's flip bit, which is the same picture (see
  // `normalizeFlip`) and keeps the matrix's determinant positive for the executor.
  //
  // The flip is read off the FIT, not off `node.textureFlipH/V`, on purpose: `atlasFitAffine` honours the flips in
  // its FILL branch and ignores them in the keep-aspect one, so taking the sign of `sx`/`sy` reproduces the CSS
  // twin exactly — including that omission — instead of quietly diverging from it.
  const m: Affine = [fit.m[0] * fit.sx, fit.m[1] * fit.sx, fit.m[2] * fit.sy, fit.m[3] * fit.sy, fit.m[4], fit.m[5]];
  const flip = normalizeFlip(m, fit.w, fit.h, fit.sx < 0, fit.sy < 0);
  setQuadMatrix(view, m);
  view.w = fit.w;
  view.h = fit.h;
  view.srcX = region.x;
  view.srcY = region.y;
  view.srcW = region.width;
  view.srcH = region.height;
  setQuadColor(view, input, 1, 1, 1, 1, blend, colorMatrix);
  view.flipH = flip.h;
  view.flipV = flip.v;
  sink.quad(view, node.textureUrl);
  return 1;
}

/**
 * Turn a negative-scale (mirrored) quad matrix into a positive-scale one plus a source flip.
 *
 * For a quad whose local box is [0,w]x[0,h], `M'·(x, y) = M·(w - x, y)` holds exactly when `M'.col0 = -M.col0` and
 * `M'.origin = M.origin + M.col0·w` — i.e. reversing an axis of the DESTINATION is the same picture as mirroring
 * the SOURCE along it. Mutates `m` and returns which bits to set.
 */
export function normalizeFlip(
  m: Affine | Float32Array,
  w: number,
  h: number,
  flipH: boolean,
  flipV: boolean
): { h: boolean; v: boolean } {
  if (flipH) {
    m[4] += m[0] * w;
    m[5] += m[1] * w;
    m[0] = -m[0];
    m[1] = -m[1];
  }
  if (flipV) {
    m[4] += m[2] * h;
    m[5] += m[3] * h;
    m[2] = -m[2];
    m[3] = -m[3];
  }
  return { h: flipH, v: flipV };
}

/**
 * A `NinePatchRect` over an atlas REGION. Emitted as ONE `DRAW_NINE_PATCH` carrying the region and the four patch
 * margins; the executor expands it into up to nine quads. `ninePatch.ninePatchAtlasQuads` is the reference
 * decomposition that expansion must reproduce (the DOM path's 9 spans come from it, and the spec cross-checks a
 * command against it), so no band algebra is duplicated here.
 */
function emitNinePatchAtlas(
  node: MirrorNode,
  view: NinePatchView,
  boxM: Affine,
  w: number,
  h: number,
  input: NodePaintInput,
  blend: QuadView["blend"],
  colorMatrix: Float32Array | null,
  sink: PaintSink
): number {
  const region = node.textureRegion;
  const margins = node.ninePatchMargins;
  if (!region || !margins || !node.textureUrl) {
    return 0;
  }
  setQuadMatrix(view, boxM);
  view.w = w;
  view.h = h;
  view.srcX = region.x;
  view.srcY = region.y;
  view.srcW = region.width;
  view.srcH = region.height;
  view.marginLeft = margins.left;
  view.marginTop = margins.top;
  view.marginRight = margins.right;
  view.marginBottom = margins.bottom;
  setQuadColor(view, input, 1, 1, 1, 1, blend, colorMatrix);
  sink.ninePatch(view, node.textureUrl);
  return 1;
}

/**
 * A `NinePatchRect` over a WHOLE image (the CSS `border-image` branch). The region is the whole page, which is only
 * knowable once the image has loaded: until then `srcW`/`srcH` are 0, the draw list's "the whole texture" spelling,
 * and the builder re-emits when `markTextureDirty` reports the size.
 */
function emitNinePatchWhole(
  node: MirrorNode,
  view: NinePatchView,
  boxM: Affine,
  w: number,
  h: number,
  input: NodePaintInput,
  blend: QuadView["blend"],
  colorMatrix: Float32Array | null,
  sizeOf: (url: string) => { width: number; height: number } | null,
  sink: PaintSink
): number {
  const margins = node.ninePatchMargins;
  if (!margins || !node.textureUrl) {
    return 0;
  }
  const page = sizeOf(node.textureUrl);
  setQuadMatrix(view, boxM);
  view.w = w;
  view.h = h;
  view.srcX = 0;
  view.srcY = 0;
  view.srcW = page ? page.width : 0;
  view.srcH = page ? page.height : 0;
  view.marginLeft = margins.left;
  view.marginTop = margins.top;
  view.marginRight = margins.right;
  view.marginBottom = margins.bottom;
  setQuadColor(view, input, 1, 1, 1, 1, blend, colorMatrix);
  sink.ninePatch(view, node.textureUrl);
  return 1;
}

/**
 * A plain (non-atlas, non-nine-patch) texture: the CSS `background-image` + `background-size` branch.
 *
 * The three fits `stretchModeToBackgroundSize` maps a Godot `StretchMode` to are resolved HERE rather than by the
 * executor, because CSS resolved them from the image's intrinsic size and the draw list has no such notion:
 *   * `fill`    — the box, source = the whole image (the overwhelming majority);
 *   * `contain` — the box shrunk to the image's aspect and CENTRED (`background-position: center`);
 *   * `cover`   — the box filled, with the SOURCE rect cropped to the box's aspect and centred.
 * Without a measured image size neither aspect fit is computable, so the box is filled and the builder re-emits
 * when the size lands — the same "style now, re-style on load" contract `nodeStyle` has for its degenerate
 * nine-patch test.
 */
function emitPlainTexture(
  node: MirrorNode,
  view: QuadView,
  boxM: Affine,
  w: number,
  h: number,
  input: NodePaintInput,
  blend: QuadView["blend"],
  colorMatrix: Float32Array | null,
  sizeOf: (url: string) => { width: number; height: number } | null,
  sink: PaintSink
): number {
  const url = node.textureUrl;
  if (!url) {
    return 0;
  }
  const size = sizeOf(url);
  const fit = stretchModeToBackgroundSize(node.textureStretchMode);
  let dx = 0;
  let dy = 0;
  let dw = w;
  let dh = h;
  let srcX = 0;
  let srcY = 0;
  let srcW = size ? size.width : 0;
  let srcH = size ? size.height : 0;
  if (size && size.width > 0 && size.height > 0 && w > 0 && h > 0) {
    if (fit === "contain") {
      const s = Math.min(w / size.width, h / size.height);
      dw = size.width * s;
      dh = size.height * s;
      dx = (w - dw) / 2;
      dy = (h - dh) / 2;
    } else if (fit === "cover") {
      const s = Math.max(w / size.width, h / size.height);
      srcW = w / s;
      srcH = h / s;
      srcX = (size.width - srcW) / 2;
      srcY = (size.height - srcH) / 2;
    }
  }
  const m: Affine = dx === 0 && dy === 0 ? boxM : affineMul(boxM, [1, 0, 0, 1, dx, dy]);
  setQuadMatrix(view, m);
  view.w = dw;
  view.h = dh;
  view.srcX = srcX;
  view.srcY = srcY;
  view.srcW = srcW;
  view.srcH = srcH;
  setQuadColor(view, input, 1, 1, 1, 1, blend, colorMatrix);
  const flip = normalizeFlip(view.m, dw, dh, node.textureFlipH, node.textureFlipV);
  view.flipH = flip.h;
  view.flipV = flip.v;
  sink.quad(view, url);
  return 1;
}

/**
 * A `Line2D` map-quill stroke: node-LOCAL flat `[x0,y0,x1,y1,…]` placed by the node's own global.
 *
 * The DOM path authors the stroke's svg in node-local space under the baked matrix, so the browser scales the pen
 * width with the matrix. A `PolylineView` carries ONE design-space width, so it is scaled by the placement's mean
 * axis length — exact for the uniform scale every map stroke rides, and named here because it is not exact for a
 * non-uniform one.
 */
function emitPolyline(
  node: MirrorNode,
  view: PolylineView,
  input: NodePaintInput,
  sink: PaintSink
): number {
  // R9 — AN ERASER IS NOT A PEN. The game's eraser stroke carries `line_erase.gdshader`, which is `blend_sub`
  // INSIDE the isolated `DrawViewport` that holds the annotations: it removes ink the player laid down and
  // touches nothing else. A flat draw list has no isolated group to subtract inside, and the alternatives are
  // both wrong — `BLEND_SUB` against the stage would darken the parchment, and a `dst-out` would punch a hole
  // through the map itself. So the honest step is to lay down NOTHING: the erased ink stays visible, which is
  // strictly less wrong than the pre-R9 behaviour of painting the eraser as a solid stroke ON TOP of the map.
  // The DOM backend composites a real SVG mask here; the isolated-surface fix that would let this arm do the
  // same is filed (`mapInkSurface`) and is not two lines.
  //
  // Emission never changes classification: the node stays a painting `canvas` node, so the offline union oracle
  // remains stable.
  if (isLineEraser(node)) {
    return 0;
  }
  const points = node.linePoints;
  if (!points || points.length < 4) {
    return 0;
  }
  const count = points.length >> 1;
  if (view.points.length < count * 2) {
    view.points = new Float32Array(count * 2);
  }
  const m = input.global;
  for (let i = 0; i < count; i++) {
    const lx = points[i * 2];
    const ly = points[i * 2 + 1];
    view.points[i * 2] = m[0] * lx + m[2] * ly + m[4];
    view.points[i * 2 + 1] = m[1] * lx + m[3] * ly + m[5];
  }
  view.pointCount = count;
  const scale = (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
  view.width = (node.lineWidth ?? DEFAULT_LINE_WIDTH) * scale;
  const color = node.lineColor;
  const alpha = clamp01(input.ownOpacity * (color ? color.a : 1));
  view.r = clampChannel(input.tintR * (color ? color.r : 1)) * alpha;
  view.g = clampChannel(input.tintG * (color ? color.g : 1)) * alpha;
  view.b = clampChannel(input.tintB * (color ? color.b : 1)) * alpha;
  view.a = alpha;
  sink.polyline(view);
  return 1;
}

/** `mirrorRenderer`'s own Line2D fallback width (the game's 4px quill), restated for the same reason it exists. */
const DEFAULT_LINE_WIDTH = 4;

/**
 * The `Range` bar (`.mirror-range-fill`): `rangeFillStyle`'s percentage as a full-height quad at the box origin.
 *
 * The DOM layer paints `background: currentColor` at `opacity: .55`; `currentColor` on a mirror node resolves to
 * the inherited text colour, which the mirror never sets on a Range node — so it is the document default, i.e.
 * white. The quad therefore paints the node's composed tint at 0.55, which is what the DOM shows.
 */
function emitRangeFill(
  node: MirrorNode,
  view: QuadView,
  boxM: Affine,
  w: number,
  h: number,
  input: NodePaintInput,
  blend: QuadView["blend"],
  colorMatrix: Float32Array | null,
  sink: PaintSink
): number {
  const pct = parseFloat(rangeFillStyle(node).width);
  if (!Number.isFinite(pct) || pct <= 0) {
    return 0;
  }
  setQuadMatrix(view, boxM);
  view.w = (w * pct) / 100;
  view.h = h;
  view.srcX = 0;
  view.srcY = 0;
  view.srcW = 0;
  view.srcH = 0;
  setQuadColor(view, input, 1, 1, 1, RANGE_FILL_ALPHA, blend, colorMatrix);
  sink.quad(view, null);
  return 1;
}

/** `.mirror-range-fill { opacity: .55 }` in MirrorView.vue — the one number this quad adds to `rangeFillStyle`. */
const RANGE_FILL_ALPHA = 0.55;
