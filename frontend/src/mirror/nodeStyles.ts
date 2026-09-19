// LAYOUT SPACE (see `@/mirror/stageFit.ts`). Every CSS px this file emits goes through `pxCss` / its affine twin,
// which multiply by the stage's design→display factor — 1 (a no-op, byte-identical strings) on the shipped
// `?stageFit=design` arm, the fit scale on `?stageFit=display`. The split is deliberately along the file's existing
// NUMERIC-CORE vs CSS-TWIN seam: the numeric cores (`placementBox`, `atlasFitAffine`, `atlasCanvasFit`,
// `clipCornerRadius`, `elementLocalPoint`) stay in DESIGN space, because the canvas backend consumes them
// (`canvas/paintSpec.ts`) and it has no scaled DOM subtree to undo; only the stringifiers that write into the DOM
// convert. If you add a px emission here, route it through `pxCss` — and if you add a numeric core, do NOT.
//
// Per-node rendering for the live-tree MIRROR, shared by the flat top-level list (MirrorView) and the
// recursive clip-group renderer (MirrorNodeView). A `clip_children` node renders as a container that clips
// its NESTED descendants to its texture's rounded shape (the combat health-bar `Mask` capsule); those
// descendants are placed RELATIVE to the clipper (`item.parentInv`), since the producer streams GLOBAL
// transforms and the container's own transform would otherwise double-apply.

import { richTextLayeredHtml } from "@godot-scene-web/html";
import { DEFAULT_BBCODE_TAGS } from "@spirectl/presentation/render";

import { affineCss, affineMul, affineMulInto, nodeMatrix, nodeMatrixInto, type Affine } from "@/mirror/affine";
import { isCardTrailNode, isCardTrailRootNode } from "@/mirror/cardTrail";
import { ninePatchAtlasSlices as computeNinePatchAtlasSlices } from "@/mirror/ninePatch";
import { isShaderInputNode, isWebglShaderNode, stretchModeToBackgroundSize } from "@/mirror/shaderAttributes";
import { isSpineClipNode } from "@/mirror/spineAttributes";
import { pxCss, scaleAffineTranslationInPlace } from "@/mirror/stageFit";
import { uiScalingEnabled } from "@/mirror/uiScaling";
import { renderQuality } from "@/render/quality";
import { mirrorResourceUrl, type MirrorFont, type MirrorNode, type MirrorRect } from "@/mirror/sceneTree";
import { naturalSize, textureSizeVersion } from "@/mirror/textureCache";

// A node to render: the retained node plus its own painted opacity, the composed tint filter id, and the inverse
// of its PARENT ELEMENT's matrix — the mirror DOM now nests every node inside its parent element, so a node is
// placed RELATIVE to its parent (`parentInv`), identity at the stage root. `hasChildren` marks an INTERIOR node
// (a transform group): its own paint is split onto a self-layer so the element's filter/blend don't cascade onto
// the DOM-nested children, and its element opacity carries only `modulate.a` (children multiply via CSS cascade).
export interface RenderItem {
  node: MirrorNode;
  opacity: number;
  tintId: string | null;
  parentInv: Affine | null;
  hasChildren: boolean;
  // Horizontal-stretch: render the PAINTED box wider than its 1920-space `localRect.width` (a full-screen fill
  // grown to the stage width so it covers a wider-than-16:9 stage). Only the CSS `width` uses this — the transform
  // (and thus re-basing + transform-positioned children) stays on the raw `localRect`, so nothing shifts/distorts.
  renderWidthOverride?: number;
  // Use THIS Transform2D in place of `node.transform` for the placement below (the ONLY field the walk ever
  // substituted). The caller used to clone the whole node — `{ ...node, transform: gNodeStretched }`, ~57k node
  // copies per 25s combat replay — purely to carry it; now it rides beside the untouched node. The walk only ever
  // sets it when `node.transform != null` (it IS that matrix, spread-shifted / composed to global), so "does this
  // node have a transform-based box" is unchanged either way.
  transformOverride?: readonly number[] | null;
  // R11 — the MASS-FLIGHT VFX DIET's `blend` rung (see mirrorRenderer's `?flightVfxDiet`). A `mix-blend-mode`
  // element is its own compositor render surface, and 30 flying cards drag ~180 decorative ones onto a scene whose
  // steady state is ~106. While the diet is armed the renderer sets this on the DECORATIVE branch of a
  // flight-owned trail so the node still paints, just composited normally. It is a style INPUT — the mirror
  // deciding what to emit for its own elements — never a CSS rule reaching into rendered DOM.
  suppressBlend?: boolean;
  // This node's one-axis clip exception, in design px: its `clip_contents` bounds the vertical axis at the box
  // edge and OUTSETS the horizontal one by this much (`clip-path: inset(0 -Npx)` instead of `overflow: hidden`).
  // Resolved by the walk from the node's SCENE IDENTITY — the (file, relPath) tuple `computeSceneInfo` gives — since
  // that tuple is not derivable from the node object alone; see clipAxis.ts for the table and the measurement.
  // Undefined for every node that is not in the table, which is the overwhelming majority.
  clipAxisOutsetX?: number;
}

// godot-scene-web scales outline width ×0.5 for non-MSDF fonts (cssOutlineSizeForFont, text.ts) — without
// this the stroke renders ~2× too thick. We don't capture the MSDF flag yet, so default to the non-MSDF rule.
//
// EXPORTED for the canvas text rasterizer (M4, `canvas/textLayout.ts`), which needs the same number and must not
// restate it. It applies there for the same reason it applies here and NOT for the reason the native client's
// TextBuilder gives for refusing it: `-webkit-text-stroke` and canvas2D `strokeText` are the same primitive, a
// CENTRED stroke straddling the glyph edge, so half the declared width lands outside. Godot's outline grows
// entirely OUTWARD, which is why the native port keeps the full width — a different renderer, a different rule.
export const OUTLINE_SCALE = 0.5;

// The one-axis exception applies only while readability scaling is active, because the outset exists only to
// stop a clipper cropping the enlargements that switch turns off: with them gone the game's own clip is the
// right one, and keeping the outset would be a mirror-only divergence in the very mode that exists to remove them.
/** The one-axis clip exception's effective state (both stages ask; the canvas asks in `clipAxisOutsetFor`). */
export function clipAxisOn(): boolean {
  return uiScalingEnabled();
}

// A NinePatchRect drawing an ATLAS sprite (a region of a shared page) — 9-sliced as child spans.
export function isNinePatchAtlas(node: MirrorNode): boolean {
  return Boolean(node.textureUrl && node.textureRegion && node.ninePatch && node.ninePatchMargins);
}

// True when a node is a plain (non-nine-patch) atlas-region SPRITE that the mirror paints by drawing its region
// into a per-node <canvas> (atlasBaker) rather than a CSS `background-image: url(atlas)` crop. Keeping this in
// lockstep with nodeStyle's `paintsTexture` gate + the atlas branch: nodeStyle still computes the element's
// size/transform (the keep-aspect fit) but NOT the background; mirrorRenderer mounts+draws the canvas.
export function paintsAtlasCanvas(node: MirrorNode): boolean {
  if (!node.textureUrl || !node.textureRegion) return false;
  if (node.clipChildren === 1) return false;
  if (isWebglShaderNode(node) || node.particleSpec) return false;
  if (isNinePatchAtlas(node)) return false; // 9-slice spans render those (separate path)
  return true;
}

// The NUMERIC core of the atlas-<canvas> placement below, and the shape a future CANVAS renderer consumes: it
// wants the fit as numbers, not a CSS string it would have to parse back out. `dx`/`dy` are the el-local translate
// in px, `sx`/`sy` the scale (negative on a flipped axis), `w`/`h` the canvas's own box — the texture REGION.
//
// `uniform` marks the keep-aspect CONTAIN fit, where `sx === sy` by construction. It rides along purely so the CSS
// twin can stay BYTE-identical: that case is emitted as the one-argument `scale(fit)`, while a FILL whose two axes
// happen to come out equal still emits both. Nothing but the stringifier should care.
export interface AtlasCanvasFit {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  uniform: boolean;
  w: number;
  h: number;
}

// Scratch result for the CSS placement call below: the twin consumes every field into a string before it returns,
// so one tuple serves every node.
const ATLAS_CANVAS_FIT_SCRATCH: AtlasCanvasFit = { dx: 0, dy: 0, sx: 1, sy: 1, uniform: false, w: 0, h: 0 };

// Fit of the atlas region into an INTERIOR node's canvas, as numbers — see `atlasCanvasPlacement` for what the fit
// IS and why an interior node carries it here rather than on its element. Null → no fit computable.
//
// `scratch` is for the CSS path, which consumes its result immediately. Numeric consumers retain the default fresh
// result, so they cannot observe a subsequent DOM placement overwrite.
export function atlasCanvasFit(node: MirrorNode, scratch = false): AtlasCanvasFit | null {
  const region = node.textureRegion;
  const lr = node.localRect;
  if (!region || !lr || !node.transform) {
    return null;
  }
  const margin = node.textureMargin;
  const mx = margin?.x ?? 0;
  const my = margin?.y ?? 0;
  const texW = region.width + (margin?.width ?? 0);
  const texH = region.height + (margin?.height ?? 0);
  if (texW <= 0 || texH <= 0) {
    return null;
  }
  const isFill =
    node.textureStretchMode == null || node.textureStretchMode === 0 || node.textureStretchMode === 1;
  let dx: number;
  let dy: number;
  let sx: number;
  let sy: number;
  let uniform: boolean;
  if (isFill) {
    const fh = node.textureFlipH;
    const fv = node.textureFlipV;
    const scaleX = lr.width > 0 ? lr.width / texW : 1;
    const scaleY = lr.height > 0 ? lr.height / texH : 1;
    dx = fh ? region.width * scaleX + mx * scaleX : mx * scaleX;
    dy = fv ? region.height * scaleY + my * scaleY : my * scaleY;
    sx = fh ? -scaleX : scaleX;
    sy = fv ? -scaleY : scaleY;
    uniform = false;
  } else {
    const fit = lr.width > 0 && lr.height > 0 ? Math.min(lr.width / texW, lr.height / texH) : 1;
    const cx = (lr.width - texW * fit) / 2;
    const cy = (lr.height - texH * fit) / 2;
    dx = cx + mx * fit;
    dy = cy + my * fit;
    sx = fit;
    sy = fit;
    uniform = true;
  }
  if (!scratch) {
    return { dx, dy, sx, sy, uniform, w: region.width, h: region.height };
  }
  ATLAS_CANVAS_FIT_SCRATCH.dx = dx;
  ATLAS_CANVAS_FIT_SCRATCH.dy = dy;
  ATLAS_CANVAS_FIT_SCRATCH.sx = sx;
  ATLAS_CANVAS_FIT_SCRATCH.sy = sy;
  ATLAS_CANVAS_FIT_SCRATCH.uniform = uniform;
  ATLAS_CANVAS_FIT_SCRATCH.w = region.width;
  ATLAS_CANVAS_FIT_SCRATCH.h = region.height;
  return ATLAS_CANVAS_FIT_SCRATCH;
}

// Placement of the atlas-region <canvas> INSIDE an interior node's container element. A LEAF atlas node bakes
// the paint fit (region-sized box + stretch/keep-aspect scale + centering/margin offset) into its element's own
// size/transform (the atlas branch of nodeStyle). An INTERIOR node cannot — its DOM-nested children would
// inherit the fit — so its container keeps the pure localRect placement and the canvas carries the fit itself.
// Coordinates are el-local: the container's origin is the localRect box origin, so the leaf branch's offsets
// reappear here with `lr.x/lr.y` cancelled out. Null → no fit computable (mirrors the leaf branch's guard); the
// canvas then falls back to its default inset:0 stretch.
//
// Pure stringifier over `atlasCanvasFit` — the math lives there once, this only formats it.
//
// LAYOUT SPACE (stageFit.ts): the canvas's own box and the el-local offset are LENGTHS and take the factor; the
// trailing `scale()` is the region→box fit, a dimensionless ratio between two boxes that BOTH scale, so it must not.
export function atlasCanvasPlacement(
  node: MirrorNode
): { width: string; height: string; transform: string } | null {
  const fit = atlasCanvasFit(node, true);
  if (!fit) {
    return null;
  }
  const scale = fit.uniform ? `scale(${fit.sx})` : `scale(${fit.sx}, ${fit.sy})`;
  return {
    width: pxCss(fit.w),
    height: pxCss(fit.h),
    transform: `translate(${pxCss(fit.dx)}, ${pxCss(fit.dy)}) ${scale}`
  };
}

// Map a point given in the node's OWN local space (Godot `Control` coordinates — e.g. an authored `pivot_offset`)
// into the coordinate space of the node's ELEMENT, i.e. the space a `transform-origin` on that element (or on a
// self-layer child filling it) is measured in. Inverse of the placement `nodeStyle` bakes above:
//   * The normal case — the element's box IS the localRect placed by `nodeMatrix(transform, lr)` — so element
//     local (0,0) is the box origin and the map is just `− lr.origin` (0 for essentially every Control).
//   * A LEAF atlas-sprite node is the exception: nodeStyle sizes its element to the texture REGION and bakes the
//     keep-aspect / stretch fit into the element transform, so element-local px are REGION px, offset by the
//     centering + texture margin. A 72×72 deck icon painting a 114×98 region has its authored pivot (36, 34) at
//     element-local (57, 45.833) — feeding the raw pivot would rotate the icon about the wrong point.
//     (An INTERIOR atlas node keeps the pure localRect placement and its canvas carries the fit — first case.)
// `hasChildren` selects between those exactly as `nodeStyle`'s `item.hasChildren` does.
//
// This is the INVERSE of `atlasCanvasFit`'s forward fit, and deliberately keeps its own arithmetic rather than
// dividing that one out: `bx / scaleX − mx` and `(bx − mx·scaleX) / scaleX` agree algebraically but not to the last
// ulp, and this number is written into a `transform-origin`, i.e. into emitted CSS. Solve it from the numbers only
// if you are prepared for the strings to move.
export function elementLocalPoint(
  node: MirrorNode,
  hasChildren: boolean,
  x: number,
  y: number
): { x: number; y: number } {
  const lr = node.localRect;
  if (!lr) {
    return { x, y };
  }
  const bx = x - lr.x;
  const by = y - lr.y;
  const region = node.textureRegion;
  if (hasChildren || !region || !paintsAtlasCanvas(node) || !node.transform) {
    return { x: bx, y: by };
  }
  const margin = node.textureMargin;
  const mx = margin?.x ?? 0;
  const my = margin?.y ?? 0;
  const texW = region.width + (margin?.width ?? 0);
  const texH = region.height + (margin?.height ?? 0);
  if (texW <= 0 || texH <= 0) {
    return { x: bx, y: by }; // no fit computable — nodeStyle left the pure placement too
  }
  const isFill =
    node.textureStretchMode == null || node.textureStretchMode === 0 || node.textureStretchMode === 1;
  if (isFill) {
    const scaleX = lr.width > 0 ? lr.width / texW : 1;
    const scaleY = lr.height > 0 ? lr.height / texH : 1;
    // A flipped axis puts the element origin at the far edge and scales negatively — invert that too.
    return {
      x: node.textureFlipH ? (region.width + mx) - bx / scaleX : bx / scaleX - mx,
      y: node.textureFlipV ? (region.height + my) - by / scaleY : by / scaleY - my
    };
  }
  const fit = lr.width > 0 && lr.height > 0 ? Math.min(lr.width / texW, lr.height / texH) : 1;
  const cx = (lr.width - texW * fit) / 2;
  const cy = (lr.height - texH * fit) / 2;
  return { x: (bx - cx) / fit - mx, y: (by - cy) / fit - my };
}

// True when a node draws VISIBLE OWN CONTENT — the property the wide-screen visual-anchor map keys off (see
// pointerMap): only a node that actually paints something can anchor the game↔stage correspondence at a point.
// It mirrors nodeStyle's own paint gates: a texture (the `paintsTexture` gate below — nine-patch / atlas region /
// plain, minus WebGL-canvas and particle-sprite nodes and a suppressed shader-input SDF), a rich/plain text run,
// a filled `fill_color` (alpha above a hair), a live SpineSprite clip, or a WebGL/HSV shader paint. It is FALSE
// for pure transform-group containers, particle-only emitters (their sprite paints via the gsw canvas, not own
// content the map should anchor to), and anything faded to nothing (effectiveOpacity ≤ ~0.02 = imperceptible).
// `effectiveOpacity` is the node's OWN painted opacity (modulate.a × self_modulate.a) — the same value nodeStyle
// puts on a leaf element.
export function nodePaintsContent(node: MirrorNode, effectiveOpacity: number): boolean {
  if (effectiveOpacity <= 0.02) {
    return false;
  }
  if (node.text != null) {
    return true;
  }
  if (isSpineClipNode(node)) {
    return true;
  }
  if (isWebglShaderNode(node) || node.shaderId != null) {
    return true; // WebGL canvas / HSV color-matrix — a real shader paint
  }
  if (node.fillColor != null && node.fillColor.a > 0.02) {
    return true;
  }
  const shadersOff = !renderQuality().shadersEnabled;
  const paintsTexture =
    node.textureUrl != null &&
    node.clipChildren !== 1 &&
    !isWebglShaderNode(node) &&
    node.particleSpec == null &&
    !(shadersOff && isShaderInputNode(node));
  return paintsTexture;
}

// R19 6c — the node's RENDERED box width: the wide-screen `renderWidthOverride` when the anchor algebra stretched
// this anchored SPAN, else its streamed 1920-space width. Every read that asks "how wide is this element on screen"
// must go through here: the element IS laid out at this width (see `style.width` in nodeStyle), so a nine-patch
// sliced from `localRect.width` puts its right cap `deltaW` px short of the element edge, a clip radius derived
// from it under-rounds a stretched capsule, and the degenerate-margin test asks about the wrong box.
function renderedWidth(lr: MirrorRect, override: number | undefined): number {
  return override != null && override > 0 ? override : lr.width;
}

// `renderWidthOverride` is the caller's (the walk's) wide-screen stretch for this node — see renderedWidth.
export function ninePatchAtlasSlices(node: MirrorNode, renderWidthOverride?: number): Array<Record<string, string>> {
  // The atlas PAGE size is measured asynchronously (warmImage): until it lands this returns no slices, and the
  // `naturalSize` miss below registers THIS node against the url so the load re-styles exactly it (R10-PERF3 WS-4,
  // textureCache). The version read keeps reactive consumers current after an image measurement lands.
  void textureSizeVersion.value;
  const lr = node.localRect;
  const region = node.textureRegion;
  const m = node.ninePatchMargins;
  if (!lr || !region || !m || !node.textureUrl) {
    return [];
  }
  const page = naturalSize(node.textureUrl);
  if (!page) {
    return [];
  }
  const url = `url("${node.textureUrl}")`;
  // The bands are laid out across the RENDERED box: the element is `renderWidthOverride` wide, so slicing from the
  // 1920-space `lr` would strand the right cap and stop the stretched middle short (R19 6c).
  const box = { width: renderedWidth(lr, renderWidthOverride), height: lr.height };
  // LAYOUT SPACE (stageFit.ts): every one of these is a length in the ELEMENT's box — the slice quads and the
  // blown-up atlas page they crop from — so all eight take the factor together. Scaling the page by the same factor
  // as the quads is what keeps the crop registered: `backgroundSize`/`backgroundPosition` are the page's rendered
  // size and offset, not source-texture pixels.
  return computeNinePatchAtlasSlices(region, m, box, page).map((slice) => ({
    position: "absolute",
    left: pxCss(slice.left),
    top: pxCss(slice.top),
    width: pxCss(slice.width),
    height: pxCss(slice.height),
    backgroundImage: url,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${pxCss(slice.backgroundSizeWidth)} ${pxCss(slice.backgroundSizeHeight)}`,
    backgroundPosition: `${pxCss(slice.backgroundPositionX)} ${pxCss(slice.backgroundPositionY)}`
  }));
}

// The corner radius that approximates a clip node's rounded-capsule texture (e.g. the health-bar `Mask`,
// health_bar.png). We can't mask to the texture's actual alpha with `-webkit-mask-box-image`: that texture is
// a degenerate nine-patch (12x10 with 6px margins → a 0px-wide center patch), so a nine-patch mask samples an
// empty center column and masks the whole fill away. The patch margin IS the cap radius; clamp it to half the
// box so a pill (margins ≈ half-height) rounds into fully-round ends. Returns 0 when there's no rounding.
//
// Exported as a NUMBER (px), not as the `border-radius` string: a future canvas renderer rounds the clip itself
// (a rounded-rect path it must build from the radius) and would otherwise have to parse the CSS back out.
export function clipCornerRadius(node: MirrorNode, renderWidthOverride?: number): number {
  const m = node.ninePatchMargins;
  const lr = node.localRect;
  if (!node.textureUrl || !m || !lr || lr.width <= 0 || lr.height <= 0) {
    return 0;
  }
  // R19 6c: the half-box clamps are about the box the radius is drawn on — the RENDERED one.
  return Math.min(Math.max(m.left, m.right, m.top, m.bottom), renderedWidth(lr, renderWidthOverride) / 2, lr.height / 2);
}

// The placement chain's scratch tuple. Every value written here is consumed by `affineCss`
// into a string BEFORE nodeStyle returns — the placement branch and the two atlas branches are mutually
// exclusive-then-sequential, never simultaneously live — so no caller can observe it and one tuple is enough.
// nodeStyle is not re-entrant (nothing it calls calls back into it), so there is no interleaving either.
const PLACEMENT_SCRATCH: Affine = [1, 0, 0, 1, 0, 0];
// Ditto for the atlas branches' box-origin argument: `nodeMatrix` only READS `.x`/`.y` off it, and the tuple it
// fills is stringified before this is touched again.
const ATLAS_ORIGIN_SCRATCH = { x: 0, y: 0 };
// The two numeric-fit cores (`atlasFitAffine`, `atlasCanvasFit`) carry a result scratch on the same terms — their
// CSS twins stringify every field immediately. See each `…_FIT_SCRATCH`.

// The node's LOCAL drawing box — `localRect`, or the zero box the box-less paint kinds anchor at (see the
// long note in `nodeStyle`). Shared so the placement helpers below and `nodeStyle` can never disagree about which
// nodes have a transform-based box.
//
// R14c — the card-trail ROOT (`NCardTrailVfx`) is on this list too, and it is the one entry that paints NOTHING
// itself: it is here so the comet's whole subtree hangs off ONE element whose transform is the comet's pose. That
// makes the root a transform CARRIER, so its children (the strokes, the spark/silhouette branch) are re-based
// against it by the walk and ride it — which is what lets the flight replay place the whole comet with a single
// write, rather than needing every descendant re-based per frame. On-screen geometry is unchanged either way: the
// re-basing cancels the root's own matrix exactly (see trailRootDrive.spec.ts's parity case).
//
// Exported because it is the entry point of the whole numeric placement chain: a future canvas renderer asks the
// same question first ("does this node have a transform-based box, and which one?") and must get the same answer
// as the DOM path, including the box-less kinds' synthetic zero box.
export function placementBox(node: MirrorNode): { x: number; y: number; width: number; height: number } | null {
  return (
    node.localRect ??
    (node.particleSpec ||
    node.linePoints != null ||
    isCardTrailNode(node) ||
    isCardTrailRootNode(node) ||
    isSpineClipNode(node)
      ? { x: 0, y: 0, width: 0, height: 0 }
      : null)
  );
}

// The BASE placement matrix as CSS: the global transform × the node-local box, re-based into the parent element's
// frame. The single implementation behind both `nodeStyle`'s placement branch and `nodePlacementTransform`.
function basePlacementCss(
  transform: readonly number[],
  lr: { x: number; y: number; width: number; height: number },
  parentInv: Affine | null
): string {
  let m = nodeMatrixInto(PLACEMENT_SCRATCH, transform, lr);
  if (parentInv) {
    m = affineMulInto(m, parentInv, m);
  }
  // LAYOUT SPACE (stageFit.ts): only the TRANSLATION carries px; (a,b,c,d) is the node's own scale/rotation/skew.
  return affineCss(scaleAffineTranslationInPlace(m));
}

// Does this node paint its `textureUrl` in CSS at all? (A WebGL/particle node's pixels come from a gsw canvas, a
// clip-Only node paints nothing, and on the shaders-off tier a shader INPUT texture is a meaningless blob.)
function paintsTextureInCss(node: MirrorNode): boolean {
  return Boolean(
    node.textureUrl &&
      node.clipChildren !== 1 &&
      !isWebglShaderNode(node) &&
      !node.particleSpec &&
      !(!renderQuality().shadersEnabled && isShaderInputNode(node))
  );
}

// The NUMERIC core of the ATLAS-SPRITE fit placement (a LEAF `AtlasTexture` node reproduces the Control's
// stretch/keep-aspect fit in its own element transform — see the atlas branch of `nodeStyle`), and the shape a
// future CANVAS renderer consumes: it wants the matrix and the fit scale as numbers, not a CSS string it would
// have to parse back out.
//   * `m` — the element's placement affine, INCLUDING the `item.parentInv` re-basing, exactly as the CSS emits it.
//   * `sx`/`sy` — the trailing scale the CSS appends as ` scale(sx, sy)`, negative on a flipped axis.
//   * `w`/`h` — the element's px box, which is the texture REGION (the paint is drawn into it at the fit scale).
//   * `uniform` — the keep-aspect CONTAIN fit, where `sx === sy` by construction. Same role as in
//     `AtlasCanvasFit`: it exists so the CSS twin can keep emitting that case as the one-argument `scale(fit)`
//     while a FILL whose axes happen to be equal still emits both. Nothing but the stringifier should care.
export interface AtlasFit {
  m: Affine;
  sx: number;
  sy: number;
  uniform: boolean;
  w: number;
  h: number;
}

// Scratch result for the CSS call (see PLACEMENT_SCRATCH above): its `m` IS `PLACEMENT_SCRATCH`, so both the object
// and its matrix are transient and the CSS twin consumes them into strings before returning.
const ATLAS_FIT_SCRATCH: AtlasFit = { m: PLACEMENT_SCRATCH, sx: 1, sy: 1, uniform: false, w: 0, h: 0 };

// Null when this node isn't a leaf atlas sprite — an INTERIOR node (whose fit would cascade onto its DOM-nested
// children, so its canvas carries it via `atlasCanvasFit` instead), a texture the mirror doesn't paint in CSS, a
// nine-patch-over-atlas (the 9-slice path), or a degenerate texture box. The base placement then stands.
//
// Both the returned object and its `m` are module scratch, valid only until the next call. The CSS path consumes
// them immediately.
export function atlasFitAffine(
  item: RenderItem,
  transform: readonly number[] | null,
  lr: { x: number; y: number; width: number; height: number } | null,
  scratch = false
): AtlasFit | null {
  const node = item.node;
  const region = node.textureRegion;
  if (
    item.hasChildren ||
    !region ||
    !transform ||
    !lr ||
    !paintsTextureInCss(node) ||
    isNinePatchAtlas(node)
  ) {
    return null;
  }
  const margin = node.textureMargin;
  const mx = margin?.x ?? 0;
  const my = margin?.y ?? 0;
  const texW = region.width + (margin?.width ?? 0);
  const texH = region.height + (margin?.height ?? 0);
  if (texW <= 0 || texH <= 0) {
    return null;
  }
  // Scale (0) / Tile (1) / null → fill the localRect anisotropically (stretch to fit, no letterbox).
  // Keep-Aspect family (2-5) → uniform CONTAIN fit (keep aspect, center in the box).
  const isFill =
    node.textureStretchMode == null || node.textureStretchMode === 0 || node.textureStretchMode === 1;
  let m: Affine;
  let sx: number;
  let sy: number;
  let uniform: boolean;
  if (isFill) {
    const fh = node.textureFlipH;
    const fv = node.textureFlipV;
    const scaleX = lr.width > 0 ? lr.width / texW : 1;
    const scaleY = lr.height > 0 ? lr.height / texH : 1;
    // When flipping, the CSS scale goes negative on that axis. The transform origin is "0 0" (top-left), so a
    // negative scaleY pulls content ABOVE the origin — compensate by placing the origin one content-height lower
    // (at the bottom of where the content should appear). Same logic for flipH.
    const ox = fh ? lr.x + region.width * scaleX + mx * scaleX : lr.x + mx * scaleX;
    const oy = fv ? lr.y + region.height * scaleY + my * scaleY : lr.y + my * scaleY;
    if (scratch) {
      ATLAS_ORIGIN_SCRATCH.x = ox;
      ATLAS_ORIGIN_SCRATCH.y = oy;
      m = nodeMatrixInto(PLACEMENT_SCRATCH, transform, ATLAS_ORIGIN_SCRATCH);
    } else {
      m = nodeMatrix(transform, { x: ox, y: oy });
    }
    sx = fh ? -scaleX : scaleX;
    sy = fv ? -scaleY : scaleY;
    uniform = false;
  } else {
    const fit = lr.width > 0 && lr.height > 0 ? Math.min(lr.width / texW, lr.height / texH) : 1;
    const cx = (lr.width - texW * fit) / 2;
    const cy = (lr.height - texH * fit) / 2;
    if (scratch) {
      ATLAS_ORIGIN_SCRATCH.x = lr.x + cx + mx * fit;
      ATLAS_ORIGIN_SCRATCH.y = lr.y + cy + my * fit;
      m = nodeMatrixInto(PLACEMENT_SCRATCH, transform, ATLAS_ORIGIN_SCRATCH);
    } else {
      m = nodeMatrix(transform, { x: lr.x + cx + mx * fit, y: lr.y + cy + my * fit });
    }
    sx = fit;
    sy = fit;
    uniform = true;
  }
  if (item.parentInv) {
    m = scratch ? affineMulInto(m, item.parentInv, m) : affineMul(item.parentInv, m);
  }
  if (!scratch) {
    return { m, sx, sy, uniform, w: region.width, h: region.height };
  }
  ATLAS_FIT_SCRATCH.m = m;
  ATLAS_FIT_SCRATCH.sx = sx;
  ATLAS_FIT_SCRATCH.sy = sy;
  ATLAS_FIT_SCRATCH.uniform = uniform;
  ATLAS_FIT_SCRATCH.w = region.width;
  ATLAS_FIT_SCRATCH.h = region.height;
  return ATLAS_FIT_SCRATCH;
}

// The atlas-sprite fit as CSS — a pure stringifier over `atlasFitAffine`, which owns the math. Same null cases.
function atlasFitPlacement(
  item: RenderItem,
  transform: readonly number[] | null,
  lr: { x: number; y: number; width: number; height: number } | null,
): { transform: string; width: string; height: string } | null {
  const fit = atlasFitAffine(item, transform, lr, true);
  if (!fit) {
    return null;
  }
  // LAYOUT SPACE (stageFit.ts): the element box is the texture REGION (a length) and the placement matrix carries a
  // px translation, so both take the factor; the trailing `scale()` is the region→localRect fit, a ratio between two
  // boxes that both scale, so it does not. `fit.m` is the module scratch here (`scratch = true`) — scaled in place.
  const suffix = fit.uniform ? `scale(${fit.sx})` : `scale(${fit.sx}, ${fit.sy})`;
  return {
    transform: `${affineCss(scaleAffineTranslationInPlace(fit.m))} ${suffix}`,
    width: pxCss(fit.w),
    height: pxCss(fit.h)
  };
}

// R10-PERF6 WS-P1 — the walk's ancestor-affine fast path re-derives ONLY a node's placement when an ancestor moved
// (its paint, text, attributes and sub-layers are all unchanged). This is exactly the `transform`/`transformOrigin`
// pair `nodeStyle` would emit for the same item — computed through the SAME two helpers `nodeStyle` uses, so the
// fast path can never drift from the full restyle. Null for a node with no transform-based box.
export function nodePlacementTransform(item: RenderItem): { transform: string; transformOrigin: string } | null {
  const node = item.node;
  const transform = item.transformOverride ?? node.transform;
  const lr = placementBox(node);
  if (!transform || !lr) {
    return null;
  }
  const atlas = atlasFitPlacement(item, transform, lr);
  if (atlas) {
    return { transform: atlas.transform, transformOrigin: "0 0" };
  }
  return { transform: basePlacementCss(transform, lr, item.parentInv), transformOrigin: "0 0" };
}

export function nodeStyle(item: RenderItem): Record<string, string> {
  const node = item.node;
  // The matrix the placement is baked from: the walk's substituted global when it supplied one (see
  // RenderItem.transformOverride), else the node's own streamed transform.
  const transform = item.transformOverride ?? node.transform;
  const style: Record<string, string> = { opacity: String(item.opacity) };

  // Placement: GLOBAL transform + node-LOCAL box, re-expressed relative to the enclosing clip container when
  // nested (`parentInv`). A particle node has no
  // box (GpuParticles2D), so give it a zero-size box AT its transform — the self-layer (inset:0) then sits at
  // the node origin and the gsw canvas grows around it (overflow:visible). A playing SpineSprite is the same
  // shape: no localRect, so a zero-box at its transform anchors the node origin (the skeleton root) and the
  // clip self-layer draws the canvas's node-local rect under this matrix (see mirrorRenderer/spineAttributes).
  // A map quill stroke (Line2D) is the same shape as the particle/spine case and MUST be listed here too: the
  // producer streams NO localRect for a Line2D, so this zero box anchors it at the stage origin.
  // The zero box anchors the element at the node's transform origin, which is what makes the svg's user space
  // identical to the node-local space the points are streamed in (see mirrorRenderer's `drawBox`).
  // A synthesized CARD TRAIL (`NCardTrail`) is the same shape and must be listed for the same reason: the
  // producer's stroke stream is scoped to the map quill, so a trail node has neither a localRect NOR `linePoints`,
  // and the ribbon the renderer builds from its motion is authored in node-local (= world) coordinates.
  const lr = placementBox(node);
  if (transform && lr) {
    style.left = "0px";
    style.top = "0px";
    // The PAINTED box may be widened for the horizontal stretch (full-screen fill → stage width); the transform
    // below still uses the raw `lr`, so children re-based against it are unaffected.
    style.width = pxCss(item.renderWidthOverride ?? lr.width);
    style.height = pxCss(lr.height);
    style.transform = basePlacementCss(transform, lr, item.parentInv);
    style.transformOrigin = "0 0";
  }

  // z_index, emitted VERBATIM (relative). The DOM now nests each node inside its parent element, so a raised
  // node forms a stacking context that lifts its whole (DOM-descendant) subtree above the parent's z=0 siblings
  // automatically — no need to compose z down the chain. z_as_relative in Godot maps directly to this. Equal-z
  // nodes keep DOM (DFS) order, preserving intra-card stacking and the normal hand fan overlap.
  const zIndex = node.zIndex ?? 0;
  if (zIndex !== 0) {
    style.zIndex = String(zIndex);
  }
  if (item.tintId) {
    style.filter = `url(#mtint-${item.tintId})`;
  }
  // R11: `item.suppressBlend` is the mass-flight VFX diet asking for this node's decorative blend to be dropped —
  // the element still paints, it just stops being its own compositor surface. Nothing else about the node changes,
  // and the flag clears (restoring the blend for free, through this same path) when the diet lifts.
  // R16: the flag now also carries the trail-surface diet's `noblend` rung, which covers the two `NCardTrail`
  // STROKE hosts — the elements R11 deliberately exempted. Same meaning, same restore path, different opt-in: the
  // caller decides which nodes are covered, and this stays a single "do not be a surface" instruction.
  if (!item.suppressBlend) {
    switch (node.canvasBlendMode) {
      case 1: style.mixBlendMode = "plus-lighter"; break; // ADD
      case 2: style.mixBlendMode = "difference";   break; // SUB (approx)
      case 3: style.mixBlendMode = "multiply";     break; // MUL
    }
  }
  if (node.fillColor && !node.shaderId) {
    style.backgroundColor = node.fillColor.html;
  }

  // clip_children (1 Only / 2 AndDraw): clip nested descendants to this node's shape. `overflow:hidden` bounds
  // them to the box (fixes the ±4px-overflowing fills' thickness); `border-radius` rounds the ends to match
  // the clipper texture's capsule. Only(1) paints nothing itself; AndDraw(2) also paints (below).
  const clipChildren = node.clipChildren;
  if (clipChildren > 0) {
    style.overflow = "hidden";
    const radius = clipCornerRadius(node, item.renderWidthOverride);
    if (radius > 0) {
      style.borderRadius = pxCss(radius);
    }
  } else if (node.clipContents && lr && lr.width > 0 && lr.height > 0) {
    // `Control.clip_contents` — the OTHER Godot clip, and the only one a non-painting layout container has (see
    // MirrorNode.clipContents). A plain RECTANGULAR clip to the Control's own box: no `clipCornerRadius`, because
    // there is no clipper TEXTURE whose capsule to round to, and no `clipChildren === 1` treatment either — a
    // clip_contents Control still draws itself. `else if` only because the clip_children branch above already set
    // `overflow: hidden` (a node with both wants the rounded one).
    //
    // Gated on a POSITIVE box: an element with no placement box has no size, so `overflow: hidden` there would
    // clip its whole subtree to nothing instead of to the Control's rect. Every Control the producer probes does
    // carry a localRect, so this is a guard against a future shape, not a live case.
    //
    // Two exceptions preserve the intended content visibility:
    if (node.richText) {
      // (1) RICH TEXT IS NEVER CLIPPED. Godot's `RichTextLabel.clip_contents` defaults to TRUE, and a label that
      // does not author the property inherits that default — so WP-4 began clipping every RichTextLabel the
      // producer probes, without any scene authoring anything. That collides head-on with this repo's readability
      // rule, which scales `.mirror-text` up about its own centre and states the contract literally
      // ("Overflow beyond the card bg is ACCEPTABLE (cropping is not)" — the generated text-scale declarations):
      // the enlarged glyphs are MEANT to spill past the label rect and paint over the
      // frame around them. Victims: `card.tscn :: CardContainer/DescriptionLabel` (the reported "the frame of the
      // card covers the description") and `hover_tip.tscn :: TextContainer/VBoxContainer/Description`.
      //
      // Scoped to RICH text specifically, not "all text": a plain `Label` defaults to clip_contents = false, so it
      // never reached here anyway, and a `ScrollContainer`'s clip is legitimate and must keep working — it is not a
      // rich-text node, so it takes the `overflow: hidden` fall-through below.
      //
      // The native godot-client twin does exactly this and names the same victims: `rtl.ClipContents = false` in
      // godot-client/src/Scene/TextBuilder.cs (ConfigureRich). So this re-converges the two clients rather than
      // introducing a web-only rule.
    } else if (clipAxisOn() && item.clipAxisOutsetX != null) {
      // (2) ONE-AXIS CLIP (clipAxis.ts): this scene identity's clip must bound the VERTICAL axis only, because a
      // readability transform in THIS repo makes its subtree wider than the container the game sized for it.
      // `clip-path` rather than `overflow`, because CSS cannot mix `hidden` on one axis with `visible` on the
      // other — the visible axis computes to `auto`, which would make this a scroll container. `inset()` clips the
      // vertical axis at the box edge and outsets the horizontal one. `clip-path` creates a stacking context; that
      // is a no-op here, since every mirror node already carries a baked transform and is already one.
      style.clipPath = `inset(0px -${pxCss(item.clipAxisOutsetX)})`;
    } else {
      style.overflow = "hidden";
    }
  }
  // A WebGL shader node is painted by the gsw self-layer canvas (MirrorNodeView); painting its raw texture in
  // CSS too would show a duplicate under the canvas (e.g. card_ripple's SDF as a gray rectangle). Atlas-region
  // and HSV shader nodes are NOT WebGL nodes (isWebglShaderNode is false), so they keep their CSS paint.
  // A particle node also streams its sprite `texture` at top level (ReadPrimaryTexture reads GpuParticles2D.Texture),
  // but that's the per-particle sprite — the gsw canvas paints it, so don't also paint it as a CSS background.
  // On the true `off` tier (shaders disabled) there's no canvas, but a shader-INPUT texture (an SDF) is still a
  // meaningless blob — suppress it generically (paint nothing) rather than show the gray rectangle.
  const shadersOff = !renderQuality().shadersEnabled;
  const paintsTexture =
    node.textureUrl &&
    clipChildren !== 1 &&
    !isWebglShaderNode(node) &&
    !node.particleSpec &&
    !(shadersOff && isShaderInputNode(node));
  if (paintsTexture) {
    if (isNinePatchAtlas(node)) {
      // Box already placed above; 9-slice spans paint it (rendered by the component template).
    } else if (node.textureRegion) {
      // AtlasTexture sprite: PAINT is a per-node <canvas> drawing the region from a decode-once atlas
      // (mirrorRenderer + atlasBaker) — NOT a `background-image: url(atlas)` crop, which forced re-decoding the
      // whole atlas page per paint (the combat decode storm). Here we only reproduce the Control's keep-aspect
      // fit via the element's size + transform; the canvas (inset:0, 100%) then scales with it.
      // INTERIOR atlas node: the paint-fit (region-sized box + fit scale/centering baked into the element
      // transform) would cascade onto the DOM-NESTED children — they'd inherit the fit scale and shrink (the
      // map-legend regression). The container must keep the PURE placement already set above (localRect box +
      // nodeMatrix), which is exactly the frame `visit` re-bases children against; the atlas <canvas> carries the
      // fit itself via atlasCanvasPlacement (applied in updateSubLayers). `atlasFitPlacement` declines for an
      // interior node (and for a degenerate texture box) for exactly that reason.
      const atlas = atlasFitPlacement(item, transform, lr);
      if (atlas) {
        style.width = atlas.width;
        style.height = atlas.height;
        style.transform = atlas.transform;
        style.transformOrigin = "0 0";
      }
    } else if (node.ninePatch && node.ninePatchMargins) {
      const m = node.ninePatchMargins;
      style.borderStyle = "solid";
      // LAYOUT SPACE (stageFit.ts): `border-width` is a rendered LENGTH and takes the factor. `border-image-slice`
      // is deliberately NOT scaled — it addresses the SOURCE texture in its own pixels, and the source never moves.
      style.borderWidth = `${pxCss(m.top)} ${pxCss(m.right)} ${pxCss(m.bottom)} ${pxCss(m.left)}`;
      style.borderImageSource = `url("${node.textureUrl}")`;
      style.borderImageSlice = `${m.top} ${m.right} ${m.bottom} ${m.left} fill`;
      style.borderImageRepeat = "stretch";
      // Degenerate margins: when the patch margins overlap the source texture (or meet/exceed the element
      // box) on either axis, the source center/edge slices are negative-sized; CSS border-image won't render
      // those, leaving the middle blank (the event_button option rows: a 284px-wide texture with 192+192
      // margins). Godot clamps + STRETCHES the degenerate column to a fill. Reproduce that by painting the
      // whole texture stretched UNDER the border-image: the caps draw crisp on top, the stretch fills the gap
      // (faithful for the flat-center button AND the hollow outline, since it reuses the texture's own
      // center). Gated to degenerate-only so a normal ninepatch (whose border-image `fill` already paints its
      // center) never double-paints — at the `>=` boundary the fill/edge slices are already blank.
      // Until the natural size lands (warmImage records it) neither degenerate check can fire, so the node styles
      // caps-only; the `naturalSize` miss below registers it for a TARGETED re-style once it does (R10-PERF3 WS-4,
      // textureCache). The version read keeps reactive consumers current after an image measurement lands — see
      // ninePatchAtlasSlices.
      void textureSizeVersion.value;
      const tex = node.textureUrl ? naturalSize(node.textureUrl) : null;
      const lr = node.localRect;
      const srcDegenerate = tex != null && (m.left + m.right >= tex.width || m.top + m.bottom >= tex.height);
      // R19 6c: `border-image` already scales its slices to the ELEMENT box, so only this test was width-blind —
      // it must ask whether the margins overlap the RENDERED width, which is the width the caps are drawn at.
      const dstDegenerate =
        lr != null && (m.left + m.right >= renderedWidth(lr, item.renderWidthOverride) || m.top + m.bottom >= lr.height);
      if (srcDegenerate || dstDegenerate) {
        style.backgroundImage = `url("${node.textureUrl}")`;
        // `background-origin: border-box` is REQUIRED: with these large border-widths the default padding-box
        // positioning area collapses (here to 416×0), so `100% 100%` would scale the image to zero. border-box
        // makes 100% span the full element, and the default `background-clip: border-box` paints it under the
        // (degenerate, transparent-in-the-middle) border-image.
        style.backgroundOrigin = "border-box";
        style.backgroundSize = "100% 100%";
        style.backgroundRepeat = "no-repeat";
      }
    } else {
      style.backgroundImage = `url("${node.textureUrl}")`;
      const fit = stretchModeToBackgroundSize(node.textureStretchMode);
      style.backgroundSize = fit === "fill" ? "100% 100%" : fit;
      style.backgroundRepeat = "no-repeat";
      style.backgroundPosition = "center";
    }
  }

  return style;
}

// The style keys that stay on an INTERIOR node's CONTAINER element (the transform group that DOM-nests its
// children): placement, size, stacking, the clip (only emitted for clip nodes), and — the exception —
// `mixBlendMode`. Everything else `nodeStyle` emits is the node's OWN paint, which moves to a self-layer.
//
// `mixBlendMode` stays on the OUTER element deliberately: the transformed container is already its own stacking
// context, so a blend on the self-layer would composite against an empty (transparent container) backdrop instead
// of the scene behind the node. Blend does not inherit in CSS, so keeping it outer doesn't leak onto the children.
const SELF_CONTAINER_STYLE_KEYS = new Set([
  "left",
  "top",
  "width",
  "height",
  "transform",
  "transformOrigin",
  "zIndex",
  "overflow",
  // R20: the one-axis `clip-path` is the same STRUCTURAL clip `overflow` is (it bounds the node's DESCENDANTS), so
  // it must stay on the container element — on the self-layer it would clip only the node's own paint.
  "clipPath",
  "borderRadius",
  "mixBlendMode"
]);

// Split an INTERIOR node's `nodeStyle` into the props that stay on its container element vs the node's OWN paint
// that must render on a dedicated self-layer BEHIND the DOM-nested children.
//
// Why: the mirror DOM nests every node inside its parent element. A CSS `filter` (the composed tint) or `opacity`
// (`self_modulate`) on the container would CASCADE onto the nested children — double-applying the node's own tint
// and self-fade, which in Godot affect only the node's OWN draw, never its children. So the container keeps only
// structural/placement props (+ blend) and its element `opacity = modulate.a` (which SHOULD cascade to children —
// Godot semantics — and does so via CSS). The texture paint + own tint (`filter`) + `self_modulate` alpha move to
// the self-layer, which is a leaf sibling of the children, so they never inherit it. Effective own-paint opacity =
// (cascaded container opacity) × selfAlpha, matching Godot's modulate × self_modulate.
// `full` is the node's COMPLETE style map — nodeStyle(item) composed with any shader style (the caller merges,
// e.g. mirrorRenderer.mergedNodeStyle): an HSV color-matrix shader arrives as part of `filter` and belongs to the
// node's OWN paint exactly like the tint (a Godot material never affects children), so it must ride the split.
export function splitSelfStyle(
  full: Record<string, string>,
  modAlpha: number,
  selfAlpha: number
): { container: Record<string, string>; selfPaint: Record<string, string> } {
  const container: Record<string, string> = {};
  const selfPaint: Record<string, string> = {};
  for (const key in full) {
    if (key === "opacity") {
      continue; // recomputed per-layer below (container = modulate.a → cascades; self-paint = selfAlpha → own only)
    }
    if (SELF_CONTAINER_STYLE_KEYS.has(key)) {
      container[key] = full[key];
    } else {
      selfPaint[key] = full[key];
    }
  }
  container.opacity = String(modAlpha);
  if (selfAlpha !== 1) {
    selfPaint.opacity = String(selfAlpha);
  }
  return { container, selfPaint };
}

// The PAINT keys that move to an animated node's self-layer child (so the reproduced CSS spin rotates the texture
// in place). Everything else — positioning (left/top/width/height/transform/transformOrigin), zIndex, opacity, and
// the cascading tint `filter` / `mix-blend-mode` — stays on the parent el (filter/blend cascade to the child).
const ANIM_PAINT_KEYS = new Set([
  "backgroundImage",
  "backgroundColor",
  "backgroundSize",
  "backgroundPosition",
  "backgroundRepeat",
  "backgroundOrigin",
  "borderRadius",
  "borderStyle",
  "borderWidth",
  "borderImageSource",
  "borderImageSlice",
  "borderImageRepeat",
  "maskImage",
  "WebkitMaskImage",
  "maskSize",
  "maskPosition",
  "maskRepeat"
]);

// Split an animated node's `nodeStyle` into the paint that renders on its spinning self-layer child vs the
// positioning/tint that stays on the parent element. Mirror of `splitSelfStyle` for the animation self-layer.
export function splitAnimStyle(full: Record<string, string>): {
  container: Record<string, string>;
  paint: Record<string, string>;
} {
  const container: Record<string, string> = {};
  const paint: Record<string, string> = {};
  for (const key in full) {
    if (ANIM_PAINT_KEYS.has(key)) {
      paint[key] = full[key];
    } else {
      container[key] = full[key];
    }
  }
  return { container, paint };
}

export function rangeFillStyle(node: MirrorNode): Record<string, string> {
  const range = node.range!;
  const span = range.max - range.min;
  const pct = span > 0 ? Math.min(Math.max((range.value - range.min) / span, 0), 1) * 100 : 0;
  return { width: `${pct}%` };
}

export function textStyle(node: MirrorNode): Record<string, string> {
  const text = node.text!;
  const style: Record<string, string> = {
    justifyContent: alignToFlex(text.halign),
    alignItems: alignToFlex(text.valign)
  };
  // Issue #20b — the streamed horizontal alignment ALSO has to reach the text itself, not just the flex box.
  //
  // `justify-content` only places the flex ITEM. That is enough for a plain single-line label (the item is
  // shrink-to-fit, so centring the item centres the glyphs), but it is NOT enough in two very visible cases:
  //   * RICH text — gsw wraps the content in `.godot-rich-stack { width: 100% }`, so the item fills the box and the
  //     text inside stays hard left no matter what justify-content says (the char-select "Waiting for other
  //     players...", the rest-site Smith description, event/merchant descriptions).
  //   * WRAPPED plain text — a wrapping item is stretched to the container width, so today its lines are left-packed
  //     inside a "centred" block. Godot centres EACH line.
  // `text-align` fixes both, and is the exact web analog of the native client's `HorizontalAlignment = MapHalign(...)`
  // (godot-client/src/Scene/TextBuilder.cs — applied on BOTH the Label and the RichTextLabel path, which is why this
  // is emitted unconditionally here too). Inner `[center]`/`[right]` bbcode still wins: gsw stamps its own inline
  // `text-align` on the `.godot-rich-align` paragraph it builds for an aligned region, exactly like Godot's
  // PushParagraph overrides the label's default alignment.
  //
  // LEFT (and an unstreamed alignment) deliberately emits NOTHING rather than `text-align: left`: left is already the
  // rendered default, and staying silent keeps the generated per-scene declarations that set `text-align` on
  // the node element (End Turn, reward rows) inheriting into `.mirror-text` instead of being clobbered by an inline.
  const textAlign = alignToTextAlign(text.halign);
  if (textAlign) {
    style.textAlign = textAlign;
  }
  if (text.colorHtml) {
    style.color = text.colorHtml;
  }
  if (text.fontSizePx) {
    // LAYOUT SPACE (stageFit.ts): a font size is a length like any other — without the factor the display arm would
    // render design-sized glyphs in a display-sized box. The `--godot-text-scale` multiplier is a readability RATIO
    // and stays outside it, as does every `calc(1em * r)` role ratio below.
    style.fontSize = `calc(${pxCss(text.fontSizePx)} * var(--godot-text-scale, 1))`;
    // Expose the streamed base px so a generated per-label declaration can re-derive the scaled size and CAP it
    // (WS-TEXT v4 End Turn: `font-size: min(calc(var(--godot-font-px) * var(--godot-text-scale)), <cap>px)`). The
    // font-size above is unchanged, so this is purely additive.
    style["--godot-font-px"] = pxCss(text.fontSizePx);
  }
  if (node.font) {
    style.fontFamily = `"${node.font.family}", sans-serif`;
    style.fontSynthesis = "none";
    if (node.font.weight) {
      style.fontWeight = node.font.weight;
    }
    if (node.font.style) {
      style.fontStyle = node.font.style;
    }
  }

  // Prefer the text-diagnostics outline (per-tick VOLATILE — reflects runtime recolors like the HP outline
  // turning blue while blocking) over the stale top-level `node.outline`.
  const outlineColorHtml = text.outlineColorHtml ?? node.outline?.colorHtml ?? null;
  const outlineSize =
    text.outlineColorHtml != null && text.outlineSize > 0 ? text.outlineSize : node.outline?.size ?? 0;
  const hasOutline = outlineColorHtml != null && outlineSize > 0;

  if (node.richText) {
    style["--godot-rich-text-color"] = text.colorHtml ?? "currentColor";
    richRoleFontVars(style, node, text.fontSizePx);
    if (hasOutline) {
      style["--godot-rich-outline-size"] = pxCss(outlineSize * OUTLINE_SCALE);
      style["--godot-rich-outline-color"] = outlineColorHtml;
    }
    if (node.shadow) {
      style["--godot-rich-shadow-color"] = node.shadow.colorHtml;
      style["--godot-rich-shadow-x"] = pxCss(node.shadow.offsetX);
      style["--godot-rich-shadow-y"] = pxCss(node.shadow.offsetY);
    }
  } else {
    if (node.shadow) {
      style.textShadow = `${pxCss(node.shadow.offsetX)} ${pxCss(node.shadow.offsetY)} 0 ${node.shadow.colorHtml}`;
    }
    if (hasOutline) {
      style.webkitTextStroke = `${pxCss(outlineSize * OUTLINE_SCALE)} ${outlineColorHtml}`;
      style.paintOrder = "stroke fill";
    }
  }
  return style;
}

// The three bbcode roles godot-scene-web exposes CSS variables for, paired with the wire fields the producer
// streams per role. `mono_font` is skipped by design on BOTH sides (gsw has no --godot-rich-mono-* contract).
const RICH_ROLES: {
  readonly cssRole: string;
  readonly font: (n: MirrorNode) => MirrorFont | null;
  readonly sizePx: (n: MirrorNode) => number | null;
  readonly spacingPx: (n: MirrorNode) => number | null;
}[] = [
  {
    cssRole: "bold",
    font: (n) => n.richBoldFont,
    sizePx: (n) => n.richBoldFontSizePx,
    spacingPx: (n) => n.richBoldFontSpacingPx
  },
  {
    cssRole: "italic",
    font: (n) => n.richItalicFont,
    sizePx: (n) => n.richItalicFontSizePx,
    spacingPx: (n) => n.richItalicFontSpacingPx
  },
  {
    cssRole: "bold-italic",
    font: (n) => n.richBoldItalicFont,
    sizePx: (n) => n.richBoldItalicFontSizePx,
    spacingPx: (n) => n.richBoldItalicFontSpacingPx
  }
];

// Publish the per-role rich-text variables godot-scene-web's base CSS reads on a RichTextLabel's text element
// (`.godot-rich-bold { font-family: var(--godot-rich-bold-font-family, inherit); … }`). Only writes a variable the
// producer actually streamed, so a node with no role data lays out byte-identically to before (every gsw rule
// falls back to its pre-existing value — `inherit`, `1em`, and the generic/italic-0.7 letter-spacing).
//
// Godot renders `[b]` by swapping the label to its `bold_font` theme item — a DIFFERENT font file — so without
// the family variable the `<strong>` inherited the label's single 400-weight face and `font-synthesis: none`
// correctly refused to fake bold. That is the whole bug this closes.
function richRoleFontVars(
  style: Record<string, string>,
  node: MirrorNode,
  normalFontSizePx: number | null
): void {
  for (const role of RICH_ROLES) {
    const font = role.font(node);
    if (font) {
      style[`--godot-rich-${role.cssRole}-font-family`] = `"${font.family}", sans-serif`;
    }
    // A RATIO, never absolute px: gsw substitutes this straight into `font-size`, and the element's own font-size
    // is already `calc(<streamed px> * var(--godot-text-scale, 1))` — an absolute px here would silently opt the
    // span OUT of the mirror's whole text-scale pipeline (phone bump + generated caps). `1em` is the
    // gsw fallback, so `calc(1em * r)` is exactly "r times whatever the label ended up at".
    const sizePx = role.sizePx(node);
    if (sizePx != null && sizePx > 0 && normalFontSizePx != null && normalFontSizePx > 0) {
      const ratio = sizePx / normalFontSizePx;
      style[`--godot-rich-${role.cssRole}-font-size`] = `calc(1em * ${round4(ratio)})`;
    }
    // Godot's glyph spacing is per FONT FILE, so a role face may track wider than the normal one (STS2's bold
    // variation carries spacing_glyph=1). Setting the variable overrides gsw's per-role fallback — including the
    // deliberate ×0.7 italic factor, which is correct: a streamed spacing is the game's real number.
    const spacingPx = role.spacingPx(node);
    if (spacingPx != null) {
      // A LENGTH (glyph tracking), so it takes the factor — the round4 stays OUTSIDE it, trimming the wire's own
      // float noise rather than the layout product (which `pxCss` deliberately leaves at full precision).
      style[`--godot-rich-${role.cssRole}-letter-spacing`] = pxCss(round4(spacingPx));
    }
  }
}

// Trim float noise out of a generated CSS value (a raw 21/24 would stringify to 0.875, but 1/3 to 17 digits).
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function richHtml(node: MirrorNode): string {
  return richTextLayeredHtml(node.text!.text, {
    customTags: DEFAULT_BBCODE_TAGS,
    textScale: true,
    resolveImage: (path) => (path ? { url: mirrorResourceUrl(path) } : undefined)
  });
}

// The streamed halign as a CSS `text-align`, or null for "leave it alone" (Left / unstreamed). Mirrors the native
// client's `MapHalign` value table 1:1 — including `end` as a synonym for Right and Godot's `Fill` (justified).
function alignToTextAlign(align: string | null): string | null {
  switch ((align ?? "").toLowerCase()) {
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "fill":
      return "justify";
    default:
      return null;
  }
}

function alignToFlex(align: string | null): string {
  switch ((align ?? "").toLowerCase()) {
    case "right":
    case "bottom":
    case "end":
      return "flex-end";
    case "center":
      return "center";
    default:
      return "flex-start";
  }
}
